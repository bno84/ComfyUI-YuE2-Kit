"""Check score-prefix preservation without loading model weights."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "yue2_planning", Path(__file__).resolve().parents[1] / "planning.py"
)
planning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planning)


class RecordingClip:
    def tokenize(self, style, **kwargs):
        self.request = {"style": style, **kwargs}
        return {"prefix": [999], "abc_ids": list(kwargs["abc"].encode()), "cot": kwargs["cot"]}

    def generate(self, tokens, **kwargs):
        self.tokens = tokens
        self.sampling = kwargs
        return list(b"[V:Vocal] D8 |\n[V:Ins] z8 |\n")

    def decode(self, ids):
        return bytes(ids).decode()


class ExtendAbcTests(unittest.TestCase):
    def test_keeps_both_voices_and_rests_before_continuation(self):
        source = 'X:1\nT:\nM:4/4\nL:1/8\nQ:1/4=88\nK:C\n[V:Vocal] C4 z4 |\n[V:Ins] z8 |\n\n'
        clip = RecordingClip()
        result = planning.extend_abc(
            clip, source, "piano pop", "[Verse]\nNew words", 42, "full", 512,
            temperature=0.8, top_p=0.85, top_k=25,
            repetition_penalty=1.01, penalty_window=80,
        )
        opening = source.rstrip() + "\n"
        self.assertEqual(result, opening + "[V:Vocal] D8 |\n[V:Ins] z8 |\n")
        self.assertEqual(clip.tokens["prefix"], [999] + list(opening.encode()))
        self.assertEqual(clip.tokens["abc_ids"], [])
        self.assertEqual(clip.request["style"], "piano pop")
        self.assertEqual(clip.request["lyrics"], "[Verse]\nNew words")
        self.assertEqual(clip.request["cot"], "full")
        self.assertEqual(clip.request["penalty_window"], 80)
        self.assertEqual(clip.sampling, {
            "max_length": 512, "temperature": 0.8, "top_p": 0.85,
            "top_k": 25, "repetition_penalty": 1.01, "seed": 42,
        })

    def test_over_budget_request_fails_before_sampling(self):
        clip = RecordingClip()
        with self.assertRaisesRegex(ValueError, "prompt.*new tokens"):
            planning.extend_abc(clip, "X" * 24570, "style", "lyrics", 1, "full", 512)
        self.assertFalse(hasattr(clip, "sampling"))

    def test_planning_budget_includes_the_abc_and_accepts_exact_fit(self):
        tokens = {"prefix": [0] * 10, "abc_ids": [0] * 20}
        planning.check_planning_context(tokens, 70, context=100)
        with self.assertRaises(ValueError):
            planning.check_planning_context(tokens, 71, context=100)

    def test_audio_capacity_counts_guidance_and_score_duration(self):
        tokens = {"prefix": [0] * 10, "negative": [0] * 30, "abc_ids": [0] * 20}
        self.assertEqual(planning.check_music_context(tokens, 4.7, 10, context=100), (53, 47))
        with self.assertRaisesRegex(ValueError, "score needs about 4.8"):
            planning.check_music_context(tokens, 4.8, 10, context=100)

    def test_audio_requires_room_for_an_acoustic_frame(self):
        tokens = {"prefix": [0] * 94, "abc_ids": []}
        with self.assertRaises(ValueError):
            planning.check_music_context(tokens, context=100)

    def test_empty_source_does_not_fall_back_to_fresh_planning(self):
        with self.assertRaisesRegex(ValueError, "nonempty source score"):
            planning.extend_abc(object(), " \n", "style", "lyrics", 1, "full", 512)


class GenerateAbcTests(unittest.TestCase):
    def test_free_prefix_and_metadata(self):
        class FreeClip(RecordingClip):
            def tokenize(self, style, **kwargs):
                self.request = kwargs
                self.original = dict(prefix=[999], abc_ids=[], cot=kwargs["cot"])
                return self.original
        clip = FreeClip()
        abc, ended, metadata = planning.generate_abc(clip, "pop", "all words", 5, "melody", 100)
        self.assertNotIn("abc", clip.request)
        self.assertEqual(clip.tokens["prefix"], [999])
        self.assertEqual(clip.original, dict(prefix=[999], abc_ids=[], cot="melody"))
        self.assertTrue(ended)
        self.assertEqual(metadata["stop_reason"], "end")
        self.assertEqual(metadata["generated_tokens"], len(abc.encode()))

    def test_arbitrary_partial_header_and_budget_stop(self):
        clip = RecordingClip()
        prefix = "X:1\nT:\nM:4/4\nL:1/32\n"
        abc, ended, metadata = planning.generate_abc(clip, "pop", "all words", 5, "full", 26, prefix=prefix)
        self.assertEqual(clip.tokens["prefix"], [999] + list(prefix.encode()))
        self.assertTrue(abc.startswith(prefix))
        self.assertFalse(ended)
        self.assertEqual(metadata["stop_reason"], "budget")
        self.assertEqual(metadata["prefix_tokens"], len(prefix))

    def test_zero_token_end_and_context_before_model(self):
        class EmptyClip(RecordingClip):
            def generate(self, tokens, **kwargs):
                return []
        abc, ended, metadata = planning.generate_abc(EmptyClip(), "", "", 0, "full", 100, prefix="X:")
        self.assertEqual(abc, "X:")
        self.assertTrue(ended)
        self.assertEqual(metadata["generated_tokens"], 0)
        clip = RecordingClip()
        with self.assertRaises(ValueError):
            planning.generate_abc(clip, "", "", 0, "full", 24576, prefix="X:")
        self.assertFalse(hasattr(clip, "sampling"))


class HeaderCompletionTests(unittest.TestCase):
    def validator(self, field, value):
        # A recording dialect validator: invalid fixture must be rejected/retried.
        self.validated.append((field, value))
        if value == "BAD":
            raise ValueError("invalid field syntax")

    def setUp(self):
        self.validated = []

    def clip(self, lines):
        class LineClip(RecordingClip):
            def __init__(self):
                self.lines = iter(lines)
                self.requests = []

            def generate(self, tokens, **kwargs):
                self.requests.append((tokens, kwargs))
                return list(next(self.lines).encode())
        return LineClip()

    def test_free_line_then_later_fixed_field_and_body(self):
        clip = self.clip(["BAD\n", "1/4=145\nV:wrong\nK:wrong\n", "body\n"])
        spec = [("X", "1"), ("T", ""), ("M", "4/4"), ("L", "1/32"), ("Q", None), ("V", "Vocal"), ("V", "Ins"), ("K", "D#m")]
        prefix, records = planning.complete_header(clip, "whole style", "whole lyrics", 42, "full", spec, self.validator, label="intro")
        self.assertTrue(prefix.endswith("Q:1/4=145\nV:Vocal\nV:Ins\nK:D#m\n% intro\n"))
        self.assertNotIn("wrong", prefix)
        self.assertEqual(len(records[4]["attempts"]), 2)
        self.assertIn("error", records[4]["attempts"][0])
        self.assertFalse(records[4]["given"])
        self.assertTrue(records[-1]["given"])
        first, retry = (request[1]["seed"] for request in clip.requests)
        self.assertNotEqual(first, retry)
        self.assertEqual(clip.request["style"], "whole style")
        self.assertEqual(clip.request["lyrics"], "whole lyrics")
        abc, ended = planning.continue_abc(clip, prefix, "whole style", "whole lyrics", 42, "full", 100)
        self.assertEqual(abc, prefix + "body\n")

    def test_native_free_and_fully_fixed_headers_skip_line_sampling(self):
        self.assertEqual(planning.complete_header(object(), "", "", 0, "full", [], self.validator), ("", []))
        prefix, records = planning.complete_header(object(), "", "", 0, "full", [("X", "1"), ("K", "C")], self.validator)
        self.assertEqual(prefix, "X:1\nK:C\n")
        self.assertTrue(all(record["given"] for record in records))

    def test_unfinished_invalid_and_duplicate_voice_lines_fail_boundedly(self):
        for lines in (["unfinished"] * 3, ["BAD\n"] * 3):
            clip = self.clip(lines)
            with self.assertRaisesRegex(ValueError, "after 3 attempts"):
                planning.complete_header(clip, "", "", 0, "full", [("K", None)], self.validator)
            self.assertEqual(len(clip.requests), 3)
        clip = self.clip(["Vocal\n"] * 3)
        with self.assertRaisesRegex(ValueError, "Duplicate V"):
            planning.complete_header(clip, "", "", 0, "full", [("V", "Vocal"), ("V", None), ("K", "C")], self.validator)

    def test_line_seeds_are_stable_when_retry_limit_grows(self):
        seeds = []
        for attempts in (1, 4):
            clip = self.clip(["C\n"])
            _, records = planning.complete_header(clip, "", "", 2**64-1, "melody", [("K", None)], self.validator, attempts=attempts)
            seeds.append(records[0]["attempts"][0]["seed"])
        self.assertEqual(seeds[0], seeds[1])


if __name__ == "__main__":
    unittest.main()
