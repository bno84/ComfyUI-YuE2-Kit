"""Parse, cut, join and chord helpers in splice.py, without ComfyUI."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("yue2_splice", Path(__file__).resolve().parents[1] / "splice.py")
splice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(splice)

HEADER = """X:1
T:
M:4/4
L:1/16
Q:1/4=145
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:Em
"""

# Native layout: a section label starts a group, groups hold up to four bars,
# and a key change is repeated in every voice block.
NATIVE = HEADER + """% intro
V: Vocal
"Em"z16|"Em"z16|"B"z16|"B"z16|
V: Ins
e4e4b8-|b8b2c'2b2g2|f4f4f4z4|Z|
V: Vocal
"Em"z16|"Am"z16|
V: Ins
Z2|
% verse
V: Vocal
"Em"e4g4b8|"Am"a8g8|"B"f16|"Em"e8z8|
V: Ins
e16|a16|f16|e8z8|
V: Vocal
K:Am
"Am"a16|
V: Ins
K:Am
A16|
"""


def bars(score, voice="Vocal"):
    return [bar.text for bar in score.bars[voice]]


class ParseWriteTests(unittest.TestCase):
    def test_native_score_round_trips_exactly(self):
        self.assertEqual(splice.write(splice.parse(NATIVE)), NATIVE)

    def test_reads_bars_states_and_labels(self):
        score = splice.parse(NATIVE)
        self.assertEqual(score.length, 11)
        self.assertEqual(bars(score, "Ins")[3:6], ["Z", "Z", "Z"])
        self.assertEqual(score.labels, {0: ["intro"], 6: ["verse"]})
        self.assertEqual(score.bars["Ins"][10].state["K"], "Am")
        self.assertEqual(score.section_at(8), "verse")
        self.assertEqual(splice.check(score), [])

    def test_tolerates_a_voice_line_run_into_the_bar_before(self):
        glued = HEADER + 'V: Vocal\n"Em"z16|\nV: Ins\nZ|V: Vocal\n"Am"z16|\nV: Ins\nA16|\n'
        score = splice.parse(glued)
        self.assertEqual(bars(score), ['"Em"z16', '"Am"z16'])
        self.assertEqual(bars(score, "Ins"), ["Z", "A16"])

    def test_rejects_notation_it_cannot_cut_safely(self):
        for music in ("|:e16:|", "(3efg e12|", "[ceg]16|", "[K:D]e16|"):
            with self.subTest(music=music), self.assertRaises(splice.ScoreError):
                splice.parse(HEADER + f"V: Vocal\n{music}\nV: Ins\nZ|\n")

    def test_reports_unequal_voices_and_bars_of_the_wrong_length(self):
        score = splice.parse(HEADER + "V: Vocal\ne16|e8|\nV: Ins\nZ|\n")
        self.assertTrue(any("different bar counts" in note for note in score.notes))
        with self.assertRaises(splice.ScoreError):
            splice.write(score)
        self.assertEqual(splice.check(score)[-1], "Vocal: bar 2 does not match the meter.")


class CutJoinTests(unittest.TestCase):
    def test_cuts_inside_a_group_and_carries_the_section_and_state(self):
        part, warnings = splice.cut(splice.parse(NATIVE), 8, 11)
        self.assertEqual(warnings, [])
        self.assertEqual(part.length, 3)
        self.assertEqual(part.labels, {0: ["verse"]})
        text = splice.write(part)
        self.assertIn("K:Em\n% verse\nV: Vocal\n\"B\"f16|\"Em\"e8z8|\nV: Ins\nf16|e8z8|\n", text)
        self.assertIn("V: Vocal\nK:Am\n\"Am\"a16|\nV: Ins\nK:Am\nA16|\n", text)

    def test_cut_across_sections_keeps_the_section_inside_it(self):
        score = splice.parse(NATIVE)
        part, _ = splice.cut(score, 4, 8)
        self.assertEqual(part.labels, {0: ["intro"], 2: ["verse"]})
        self.assertIn('% intro\nV: Vocal\n"Em"z16|"Am"z16|\nV: Ins\nZ2|\n% verse\nV: Vocal\n', splice.write(part))
        # A section starting right after the cut has no bars in it.
        self.assertEqual(splice.cut(score, 4, 6)[0].labels, {0: ["intro"]})
        joined, _ = splice.join(splice.cut(score, 0, 2)[0], part)
        self.assertEqual(joined.labels, {0: ["intro"], 2: ["intro"], 4: ["verse"]})

    def test_cut_after_a_key_change_moves_it_into_the_header(self):
        part, _ = splice.cut(splice.parse(NATIVE), 10, 11)
        self.assertIn("K:Am", part.header)
        self.assertNotIn("V: Vocal\nK:Am", splice.write(part))

    def test_warns_about_ties_across_either_cut(self):
        _, warnings = splice.cut(splice.parse(NATIVE), 1, 3)
        self.assertEqual(warnings, ["Ins: a note from bar 1 is tied into bar 2, where the cut begins."])
        _, warnings = splice.cut(splice.parse(NATIVE), 0, 1)
        self.assertEqual(warnings, ["Ins: a note in bar 1 is tied past the cut."])

    def test_join_warns_about_a_tie_into_the_fragment(self):
        score = splice.parse(NATIVE)
        lead, _ = splice.cut(score, 0, 1)
        _, warnings = splice.join(lead, splice.cut(score, 6, 7)[0])
        self.assertEqual(warnings, ["Ins: the lead-in's last note is tied into the fragment."])

    def test_join_preserves_the_anchor_tempo_and_emits_it_in_both_voices(self):
        score = splice.parse(NATIVE)
        lead, _ = splice.cut(score, 0, 2)
        fragment, _ = splice.cut(score, 10, 11)
        fragment.bars["Vocal"][0].state["Q"] = fragment.bars["Ins"][0].state["Q"] = "1/4=152"
        joined, warnings = splice.join(lead, fragment)
        self.assertEqual(warnings, [])
        self.assertEqual(splice.write(joined), HEADER + """% intro
V: Vocal
"Em"z16|"Em"z16|
V: Ins
e4e4b8-|b8b2c'2b2g2|
% verse
V: Vocal
K:Am
Q:1/4=152
"Am"a16|
V: Ins
K:Am
Q:1/4=152
A16|
""")

    def test_join_refuses_different_note_units(self):
        other = splice.parse(NATIVE.replace("L:1/16", "L:1/8", 1))
        with self.assertRaisesRegex(splice.ScoreError, "Note units differ"):
            splice.join(splice.parse(NATIVE), other)


class HelperTests(unittest.TestCase):
    def test_cadence_prefers_dominant_then_subdominant_or_same(self):
        self.assertEqual(splice.cadence("B7", "Em"), 2)
        self.assertEqual(splice.cadence("Am", "Em"), 1)
        self.assertEqual(splice.cadence("E", "Em"), 1)
        self.assertEqual(splice.cadence("F#m", "Em"), 0)
        self.assertEqual(splice.cadence(None, "Em"), 0)

    def test_fragment_problems_include_a_tie_past_its_end(self):
        fragment, _ = splice.cut(splice.parse(NATIVE), 0, 1)
        self.assertEqual(splice.fragment_problems(fragment),
                         ["Ins: the fragment ends on a tied note; what follows must continue it."])


if __name__ == "__main__":
    unittest.main()
