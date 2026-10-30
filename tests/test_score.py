"""Score planning without ComfyUI or a model: score surgery, public widget rules and stage routing."""
import importlib
import json
import sys
import types
import unittest
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
for name in ("String", "Int", "Combo", "Float", "Boolean", "Clip", "Audio", "AudioEncoder"):
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
        for values, error in ((dict(header_mode="from anchor"), "requires Anchor use"),
                              (dict(anchored, header_mode="fixed", header_meter="3/4"), "meter"),
                              (dict(anchored, header_mode="fixed", header_key="D major"), "key"),
                              (dict(anchored, header_mode="generated"), "needs an opening"),
                              (dict(anchored, header_mode="from anchor", opening_generate=True, opening_tokens=0), "at least 256")):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, error):
                score.widgets_to_plan(values)
        # Disabled groups are ignored, and without an anchor the whole song is generated.
        plan = score.widgets_to_plan(dict(opening_generate=True, opening_bars=-3, continue_generate=False))
        self.assertEqual((plan["opening"]["bars"], plan["continuation"]["enabled"]), (0, True))
        # A fixed header leaves only the note length to the model; the voices are native.
        spec = score.header_spec(score.widgets_to_plan(dict(header_mode="fixed")))
        self.assertEqual([field for field, value in spec if value is None], ["L"])
        self.assertIn(("V", ' Vocal clef=treble name="Vocal Melody" snm="Vocal"'), spec)
        # A fixed tempo may differ from the anchor's: that retimes it.
        plan = score.widgets_to_plan(dict(anchored, header_mode="fixed", header_tempo=90))
        self.assertEqual(plan["header"]["tempo"], dict(policy="set", value=90))

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
