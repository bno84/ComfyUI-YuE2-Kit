"""Score plan validation and exact source selection."""
import copy
import importlib
import sys
import types
import unittest
from pathlib import Path

package = types.ModuleType("score_test_pack")
package.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules[package.__name__] = package
s = importlib.import_module(package.__name__ + ".score")
ABC = "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nV: Vocal\nV: Ins\nK:C\n% verse\nV: Vocal\nC8-|C8|\nV: Ins\nZ2|\n"


class PlanTests(unittest.TestCase):
    def test_bad_plans(self):
        for value in ("{", "[]", {"version": 2}, {"version": True}):
            with self.assertRaises(ValueError):
                s.plan_from(value)
        for section, key, value in (("opening", "bars", -1), ("opening", "attempts", True), ("anchor", "end", 0), ("continuation", "enabled", 1), ("source", "provenance", {"x": float("nan")})):
            plan = s.default_plan()
            plan[section][key] = value
            with self.assertRaises(ValueError):
                s.plan_from(plan)

    def test_contextual_policies(self):
        for source in (False, True):
            plan = s.default_plan(source)
            plan["source"].update(kind="abc" if source else "none", abc=ABC if source else "")
            s.plan_from(plan)
            for name, policy in (("meter", "generated" if source else "reference"), ("key", "locked" if source else "reference")):
                bad = copy.deepcopy(plan)
                bad["header"][name]["policy"] = policy
                with self.assertRaises(ValueError):
                    s.plan_from(bad)
        plan = s.default_plan()
        plan["continuation"]["enabled"] = False
        with self.assertRaises(ValueError):
            s.plan_from(plan)

    def test_seed_contract(self):
        self.assertEqual(s.derive_seed(0, "fresh"), 14939696644927414195)
        seeds = [s.derive_seed(s.UINT64, "opening", i) for i in range(16)]
        self.assertEqual(seeds[:4], [s.derive_seed(s.UINT64, "opening", i) for i in range(4)])
        self.assertEqual(len(set(seeds + [s.derive_seed(s.UINT64, "continuation")])), 17)
        # The shared Int primitive randomizes over signed values; stage seeds stay unsigned.
        negative = s.derive_seed(-944726594670549, "fresh")
        self.assertEqual(negative, s.derive_seed(-944726594670549, "fresh"))
        self.assertNotEqual(negative, s.derive_seed(944726594670549, "fresh"))
        self.assertTrue(0 <= negative <= s.UINT64)
        self.assertTrue(0 <= s.derive_seed(s.SEED_MIN, "opening") <= s.UINT64)
        for bad in (s.SEED_MIN - 1, 1 << 64, True, float("inf")):
            with self.assertRaises(ValueError):
                s.derive_seed(bad, "fresh")


class HeaderTests(unittest.TestCase):
    def source(self):
        return s.splice.parse(ABC)

    def plan(self):
        plan = s.default_plan(True)
        plan["source"].update(kind="abc", abc=ABC)
        return plan

    def test_semantic_fields_and_defaults(self):
        self.assertEqual(s.normalize_field("Q", "1/8=240"), s.normalize_field("Q", "120"))
        self.assertEqual(s.normalize_field("M", "C"), s.normalize_field("M", "4/4"))
        self.assertEqual(s.normalize_field("K", "Cmajor"), "C")
        for field, value in (("M", "4/0"), ("K", "H"), ("K", "C dorian"), ("Q", "1/0=90")):
            with self.assertRaises(ValueError):
                s.normalize_field(field, value)
        info = s.analyze(ABC.replace("Q:1/4=120\n", ""))
        self.assertEqual(info["seconds"], 4)
        self.assertEqual(info["diagnostics"][0]["code"], "tempo_assumed")

    def test_header_line_syntax_and_legacy_vocal_choices(self):
        for field, value in (("Q", "120"), ("M", "C"), ("L", "1/32"), ("K", "D#m"), ("V", 'Vocal clef=treble name="Vocal Melody"'), ("T", "")):
            s.validate_header_line(field, value)
        for field, value in (("V", ""), ("Q", ""), ("L", "bad"), ("K", "H"), ("K", "C\nV:evil")):
            with self.assertRaises(ValueError):
                s.validate_header_line(field, value)
        for vocal in ("keep", "require rests", "replace with rests"):
            plan = s.default_plan()
            plan["opening"]["vocal"] = vocal
            s.plan_from(plan)

    def test_cross_voice_state_and_join_structure(self):
        score = self.source()
        score.bars["Ins"][1].state["K"] = "G"
        with self.assertRaisesRegex(ValueError, "Voices disagree"):
            s.validate_score(score)
        with self.assertRaises(s.splice.ScoreError):
            s.splice.write(score)
        for changed in (ABC.replace("L:1/8", "L:1/16").replace("C8", "C16"), ABC.replace("Ins", "Piano")):
            with self.assertRaises(ValueError):
                s.validate_header_changes(s.splice.parse(changed), {}, anchor=self.source())

    def test_tempo_adoption_is_uniform_immutable_and_key_is_preserved(self):
        anchor = self.source()
        for bars in anchor.bars.values():
            bars[1].state.update(Q="90", K="G", M="2/2")
        before = copy.deepcopy(anchor)
        opening = self.source()
        for bars in opening.bars.values():
            bars[0].state["Q"] = "100"
        adapted, diagnostics = s.adapt_anchor_tempo(anchor, opening)
        self.assertEqual(anchor, before)
        self.assertEqual({bar.state["Q"] for bars in adapted.bars.values() for bar in bars}, {"100"})
        self.assertEqual(adapted.bars["Vocal"][1].state["K"], "G")
        self.assertEqual(diagnostics[0]["code"], "tempo_adopted")
        self.assertIn("not followed by the audio", s.format_report(diagnostics))
        encoded = s.splice.write(adapted)
        self.assertIn("\nK:G\n", encoded)
        self.assertEqual(s.splice.parse(encoded).bars, adapted.bars)
        retained, diagnostics = s.adapt_anchor_tempo(anchor)
        self.assertEqual(retained, anchor)
        self.assertIn("No opening", diagnostics[0]["message"])

    def test_equal_opening_tempo_has_no_adoption_edit(self):
        anchor, opening = self.source(), self.source()
        _, diagnostics = s.adapt_anchor_tempo(anchor, opening)
        self.assertFalse(any(d["code"] == "tempo_adopted" for d in diagnostics))
        for bars in anchor.bars.values():
            bars[1].state["Q"] = "90"
        _, diagnostics = s.adapt_anchor_tempo(anchor, opening)
        self.assertFalse(any(d["code"] == "tempo_adopted" for d in diagnostics))
        self.assertTrue(any(d["code"] == "tempo_ignored" for d in diagnostics))

    def test_analysis_is_lossless_and_reports_acoustic_tempo(self):
        source = self.source()
        for bars in source.bars.values():
            bars[1].state["Q"] = "60"
        abc = s.splice.write(source)
        info = s.analyze(abc, "pop 140 BPM")
        self.assertEqual(info["abc"], abc)
        self.assertEqual(info["seconds"], 4)
        self.assertEqual(info["written_seconds"], 6)
        self.assertIn("not followed by the audio", s.format_report(info["diagnostics"]))
        self.assertEqual({item["code"] for item in info["diagnostics"]}, {"tempo_ignored", "style_tempo"})


class UniformTempoTests(unittest.TestCase):
    def plan(self):
        plan = s.default_plan(True)
        plan["source"].update(kind="abc", abc=ABC)
        return plan

    def test_normalizes_each_tempo_region_and_preserves_uniform_text(self):
        self.assertEqual(s.normalize_tempo(ABC), (ABC, []))
        parsed = s.splice.parse(ABC)
        for bars in parsed.bars.values():
            bars[1].state["Q"] = "60"
        text = s.splice.write(parsed)
        normalized, diagnostics = s.normalize_tempo(text)
        self.assertEqual(len(diagnostics), 1)
        self.assertIn("Q:60 at bar 2 normalized to 1/4=120", diagnostics[0]["message"])
        self.assertEqual(s.analyze(normalized)["seconds"], s.analyze(normalized)["written_seconds"])
        self.assertNotIn("Q:60", normalized)
        retimed, diagnostics = s.normalize_tempo(ABC, "1/4=90")
        self.assertEqual(s.analyze(retimed)["seconds"], 16/3)
        self.assertEqual(diagnostics, [])
        self.assertIn("Q:1/4=90", retimed)

