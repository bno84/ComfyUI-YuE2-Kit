"""Trimming of token-budget tails, without ComfyUI or a model."""
import unittest

from test_score import HEADER, nodes, score


def voices(vocal, ins):
    return HEADER + "V: Vocal\n" + vocal + "\nV: Ins\n" + ins


class TailTests(unittest.TestCase):
    def test_trims_to_whole_groups_and_ends_on_a_barline(self):
        text, detail = nodes.finish_tail(voices("c16|" * 11, "C16|" * 10 + "C8"), False)
        self.assertEqual(score.analyze(text)["bars"], 8)
        self.assertTrue(text.rstrip().endswith("|"))
        self.assertEqual((detail["bars"], detail["trimmed"]), (8, True))

    def test_groups_count_from_the_supplied_prefix(self):
        text, detail = nodes.finish_tail(voices("c16|" * 11, "C16|" * 10 + "C8"), False, start=2)
        self.assertEqual(score.analyze(text)["bars"], 10)
        self.assertEqual(detail["bars"], 8)

    def test_keeps_a_smaller_aligned_fallback_without_a_whole_group(self):
        text, _ = nodes.finish_tail(voices("c16|c16|c16|", "C16|C16|C8"), False)
        self.assertEqual(score.analyze(text)["bars"], 2)

    def test_a_tiny_budget_keeps_the_prefix(self):
        cut = voices("c16|" * 4, "C16|" * 4) + "\nV: Vocal\nc16|c16|c8"
        text, detail = nodes.finish_tail(cut, False, start=4)
        self.assertEqual(score.analyze(text)["bars"], 4)
        self.assertEqual(detail["bars"], 0)

    def test_no_complete_bars_fails(self):
        with self.assertRaisesRegex(ValueError, "no complete aligned bars"):
            nodes.finish_tail(voices("c8", "C8"), False)

    def test_supplies_only_a_missing_final_barline(self):
        for unit, meter, note in (("1/16", "4/4", "16"), ("1/8", "3/4", "6")):
            with self.subTest(unit=unit):
                head = HEADER.replace("L:1/16", "L:" + unit).replace("M:4/4", "M:" + meter)
                text = head + "V: Vocal\n" + ("c" + note + "|") * 8 + "\nV: Ins\n" + ("C" + note + "|") * 7 + "C" + note
                recovered, detail = nodes.finish_tail(text, False)
                closed, _ = nodes.finish_tail(text + "|", False)
                self.assertEqual(recovered, closed)
                self.assertEqual(detail["bars"], 8)

    def test_discards_unfinished_notation_in_the_last_bar(self):
        for fragment in ("C8", "C[", "C/"):
            with self.subTest(fragment=fragment):
                text, _ = nodes.finish_tail(voices("c16|" * 8, "C16|" * 7 + fragment), False)
                self.assertEqual(score.analyze(text)["bars"], 4)

    def test_drops_a_header_line_cut_by_the_budget(self):
        text, _ = nodes.finish_tail(voices("c16|" * 4, "C16|" * 4) + "\nV: Voc", False)
        self.assertEqual(score.analyze(text)["bars"], 4)

    def test_never_repairs_a_finished_or_interior_error(self):
        broken = voices("c16|" * 11, "C16|" * 10 + "C8")
        with self.assertRaises(ValueError):
            nodes.finish_tail(broken, True)
        with self.assertRaisesRegex(ValueError, "meter"):
            nodes.finish_tail(broken.replace("c16|", "c8|", 1), False)


if __name__ == "__main__":
    unittest.main()
