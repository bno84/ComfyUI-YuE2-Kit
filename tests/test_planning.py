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

    def test_empty_source_does_not_fall_back_to_fresh_planning(self):
        with self.assertRaisesRegex(ValueError, "nonempty source score"):
            planning.extend_abc(object(), " \n", "style", "lyrics", 1, "full", 512)


if __name__ == "__main__":
    unittest.main()
