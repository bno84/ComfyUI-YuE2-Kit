"""Score planning without ComfyUI or a model: score surgery, public widget rules and stage routing."""
import importlib
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADER = """X:1
T:
M:4/4
L:1/16
Q:1/4=120
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
"""
ANCHOR = HEADER + '% verse\nV: Vocal\n"C"c16|"G"g16|\nV: Ins\nC16|G16|\n% chorus\nV: Vocal\nc16|g16|\nV: Ins\nC16|G16|\n'


def schema(**kwargs):
    return types.SimpleNamespace(**kwargs)


def kind(name):
    return types.SimpleNamespace(Input=lambda id, *a, **k: types.SimpleNamespace(id=id, kind=name, **k),
                                 Output=lambda *a, **k: (a, k))


io = types.SimpleNamespace(ComfyNode=object, Schema=schema, Custom=kind,
                           NodeOutput=lambda *values, **kwargs: types.SimpleNamespace(result=values, **kwargs),
                           Hidden=types.SimpleNamespace(dynprompt="dynprompt", unique_id="unique_id"))
for name in ("String", "Int", "Combo", "Float", "Boolean", "Clip", "Audio", "AudioEncoder", "AnyType"):
    setattr(io, name, kind(name))


class Graph:
    def __init__(self):
        self.nodes = {}

    def node(self, kind, id, **inputs):
        self.nodes[id] = dict(class_type=kind, inputs=inputs)
        return types.SimpleNamespace(out=lambda index: [id, index], set_override_display_id=lambda parent: None)

    def finalize(self):
        return self.nodes


package = types.ModuleType("score_test_pack")
package.__path__ = [str(ROOT)]
sys.modules.update({"comfy_api": types.ModuleType("comfy_api"), "comfy_api.latest": types.SimpleNamespace(io=io),
                    "comfy_execution": types.ModuleType("comfy_execution"),
                    "comfy_execution.graph_utils": types.SimpleNamespace(GraphBuilder=Graph),
                    package.__name__: package})
nodes = importlib.import_module(package.__name__ + ".score_nodes")
score, splice = nodes.score, nodes.splice


class ScoreTests(unittest.TestCase):
    def test_cut_and_join_keep_bars_sections_and_header(self):
        source = splice.parse(ANCHOR)
        self.assertEqual(splice.write(source), ANCHOR)
        part, _ = splice.cut(source, 1, 3)
        self.assertEqual((part.length, part.section_at(1)), (2, "chorus"))
        lead, _ = splice.cut(source, 0, 1)
        joined, _ = splice.join(lead, part)
        self.assertEqual(joined.length, 3)
        self.assertTrue(splice.check(splice.parse(ANCHOR.replace("c16|g16|", "c8|g16|"))))

    def test_public_header_rules_fail_before_model_work(self):
        anchored = dict(anchor_use=True, anchor_abc=ANCHOR)
        for values, error in ((dict(header_mode="from anchor"), "requires Reference use"),
                              (dict(anchored, header_mode="generated"), "needs an opening"),
                              (dict(anchored, header_mode="from anchor", opening_generate=True, opening_tokens=0), "at least 256")):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, error):
                score.widgets_to_plan(values)
        # Disabled groups are ignored, and without an anchor the whole song is generated.
        plan = score.widgets_to_plan(dict(opening_generate=True, opening_bars=-3, continue_generate=False))
        self.assertEqual((plan["opening"]["bars"], plan["continuation"]["enabled"]), (0, True))
        # A fixed header supplies every line, including the unit note length.
        spec = score.header_spec(score.widgets_to_plan(dict(header_mode="fixed")))
        self.assertEqual([field for field, value in spec if value is None], [])
        self.assertIn(("L", "1/16"), spec)
        self.assertIn(("V", ' Vocal clef=treble name="Vocal Melody" snm="Vocal"'), spec)
        # A fixed tempo may differ from the anchor's: that retimes it.
        plan = score.widgets_to_plan(dict(anchored, header_mode="fixed", header_tempo=90))
        self.assertEqual(plan["header"]["tempo"], dict(policy="set", value=90))

    def test_fixed_and_reference_units_do_not_generate_header_lines(self):
        for values, unit in ((dict(header_mode="fixed", header_unit="1/32"), "1/32"),
                             (dict(header_mode="from reference", anchor_use=True, anchor_abc=ANCHOR), "1/16")):
            with self.subTest(values=values):
                plan = score.widgets_to_plan(values)
                anchor = score.cut_anchor(ANCHOR, plan["anchor"])[0] if values.get("anchor_use") else None
                spec = score.header_spec(plan, anchor)
                self.assertIn(("L", unit), spec)
                self.assertFalse(any(value is None for field, value in spec))
                def complete(*args, prefix="", **kwargs):
                    return prefix + "V: Vocal\nc32|\nV: Ins\nC32|\n", True, {}
                with patch.object(nodes.planning, "generate_abc", side_effect=complete) as generate:
                    abc, detail = nodes.generate(object(), dict(spec=spec, budget=1024, sampling={}), "style", "lyrics", "full", 1)
                self.assertEqual(generate.call_count, 1)
                self.assertIn("L:" + unit + "\n", abc)
                self.assertTrue(all(line["given"] for line in detail["header"]))
        with self.assertRaises(ValueError):
            score.widgets_to_plan(dict(header_mode="fixed", header_unit="invalid"))

    def test_fixed_header_inherits_locked_reference_fields_and_keeps_tempo(self):
        # Stale or linked values in disabled controls do not affect the score.
        values = dict(header_mode="fixed", anchor_use=True, anchor_abc=ANCHOR,
                      header_meter="3/4", header_key="D minor", header_unit="1/32", header_tempo=110)
        for ignored in ({}, dict(header_meter="invalid", header_key="invalid", header_unit="invalid")):
            with self.subTest(ignored=ignored):
                preview = score.preview(**dict(values, **ignored))
                self.assertEqual(preview["errors"], [])
                self.assertEqual(preview["header"]["fixed"], dict(M="4/4", K="C", L="1/16", Q="1/4=110"))
                self.assertEqual(preview["header"]["policies"]["unit"]["policy"], "anchor")
        # Disabling reference restores the independent fixed controls.
        values["anchor_use"] = False
        preview = score.preview(**values)
        self.assertEqual(preview["errors"], [])
        self.assertEqual(preview["header"]["fixed"], dict(M="3/4", K="Dm", L="1/32", Q="1/4=110"))

    def test_reference_labels_keep_legacy_workflows_compatible(self):
        values = dict(anchor_use=True, anchor_abc=ANCHOR)
        self.assertEqual(score.widgets_to_plan(dict(values, header_mode="from reference")),
                         score.widgets_to_plan(dict(values, header_mode="from anchor")))
        inputs = {item.id: item for item in nodes.score_inputs()}
        self.assertEqual(inputs["anchor_use"].display_name, "Reference use")
        self.assertEqual(inputs["anchor_abc"].display_name, "Reference ABC")
        self.assertIn("from reference", inputs["header_mode"].options)
        self.assertIn("from anchor", inputs["header_mode"].options)

    def test_stage_routing(self):
        nodes.YuE2Score.hidden = types.SimpleNamespace(
            unique_id="score", dynprompt=types.SimpleNamespace(get_node=lambda id: dict(inputs={})))
        for values, stages in ((dict(), {"fresh", "result"}),
                               (dict(anchor_use=True, header_mode="from anchor", continue_generate=False),
                                {"join", "context", "result"}),
                               (dict(anchor_use=True, opening_generate=True), {"opening", "join", "continue", "result"})):
            with self.subTest(values=values):
                plan = score.widgets_to_plan(dict(values, anchor_abc=ANCHOR))
                out = nodes.YuE2Score.expand_plan(lyrics="l", style="s", seed=1, mode="full", plan=plan)
                self.assertEqual(set(out.expand), stages)
        settings = json.loads(out.expand["opening"]["inputs"]["settings"])
        self.assertEqual(settings["opening"]["bars"], 8)

    def test_sampling_ranges_reject_zero_before_model_work(self):
        inputs = {item.id: item for item in nodes.score_inputs()}
        for name in ("top_k", "penalty_window"):
            with self.subTest(name=name):
                self.assertEqual(inputs[name].min, 1)
                with self.assertRaisesRegex(ValueError, name):
                    score.widgets_to_plan({name: 0})
                self.assertEqual(score.widgets_to_plan({name: 1})["sampling"][name], 1)

    def test_implicit_note_length_follows_initial_meter(self):
        for meter, note_length in (("2/4", 8), ("3/8", 6), ("3/4", 6), ("4/4", 8), ("C|", 8)):
            with self.subTest(meter=meter):
                header = HEADER.replace("M:4/4", "M:" + meter).replace("L:1/16\n", "")
                abc = header + f"V: Vocal\nc{note_length}|\nV: Ins\nC{note_length}|\n"
                parsed = splice.parse(abc)
                self.assertEqual(splice.check(parsed), [])
                self.assertEqual(score.note_unit(parsed), splice.note_unit(parsed))
                preview = score.preview(anchor_use=True, anchor_abc=abc, header_mode="from anchor")
                self.assertEqual(preview["errors"], [])
                self.assertEqual(preview["anchor"]["bars"], 1)
        # An explicit unit takes precedence over the meter-derived default.
        abc = HEADER.replace("M:4/4", "M:2/4") + "V: Vocal\nc8|\nV: Ins\nC8|\n"
        self.assertEqual(splice.check(splice.parse(abc)), [])

    def test_uniform_tempo(self):
        head, chorus = ANCHOR.split("% chorus\n")
        text = head + "% chorus\n" + chorus.replace("V: Vocal\n", "V: Vocal\nQ:1/4=90\n").replace("V: Ins\n", "V: Ins\nQ:1/4=90\n")
        uniform, edits = score.normalize_tempo(text, "1/4=100")
        self.assertEqual({bar.state["Q"] for bar in splice.parse(uniform).bars["Vocal"]}, {"1/4=100"})
        self.assertTrue(edits)

    def test_unfinished_tail_is_trimmed_to_whole_groups(self):
        body = "V: Vocal\n" + "c16|" * 11 + "\nV: Ins\n" + "C16|" * 10 + "C8"
        text, detail = nodes.finish_tail(HEADER + body, False)
        self.assertEqual(score.analyze(text)["bars"], 8)
        self.assertIn("trimmed at bar 8", detail["diagnostics"][0]["message"])
        with self.assertRaises(ValueError):
            nodes.finish_tail(HEADER + body, True)

    def test_preview_draws_the_source_despite_a_header_conflict(self):
        result = score.preview(anchor_use=True, anchor_abc=ANCHOR, header_mode="generated")
        self.assertEqual([s["label"] for s in result["source"]["sections"]], ["verse", "chorus"])
        self.assertTrue(result["errors"])
        self.assertEqual(score.derive_seed(1, "opening", 0), score.derive_seed(1, "opening", 0))
        self.assertNotEqual(score.derive_seed(1, "opening", 0), score.derive_seed(1, "opening", 1))


if __name__ == "__main__":
    unittest.main()
