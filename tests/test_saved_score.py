"""Check that the save node records its score in the saved workflow, without ComfyUI."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "yue2_saved_score", Path(__file__).resolve().parents[1] / "saved_score.py"
)
saved_score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(saved_score)

BUNDLE = saved_score.BUNDLE
PROPERTY = saved_score.PROPERTY
SUBGRAPH = "5c7e-subgraph"


def workflow():
    """A root bundle (11) and one inside subgraph node 31 (its node 6)."""
    return {
        "nodes": [
            {"id": 11, "type": BUNDLE, "properties": {"Node name for S&R": BUNDLE, PROPERTY: "old root"}},
            {"id": 31, "type": SUBGRAPH, "properties": {}},
        ],
        "definitions": {"subgraphs": [{"id": SUBGRAPH, "nodes": [
            {"id": 6, "type": BUNDLE},
            {"id": 7, "type": "PrimitiveInt", "properties": {PROPERTY: "not a bundle"}},
        ]}]},
    }


class EmbedTest(unittest.TestCase):
    def test_embeds_on_the_root_node(self):
        extra = {"workflow": workflow()}
        self.assertTrue(saved_score.embed_abc(extra, "11", "X:1\nK:C\n"))
        node = extra["workflow"]["nodes"][0]
        self.assertEqual(node["properties"][PROPERTY], "X:1\nK:C\n")
        self.assertEqual(node["properties"]["Node name for S&R"], BUNDLE)

    def test_embeds_inside_a_subgraph_definition(self):
        extra = {"workflow": workflow()}
        self.assertTrue(saved_score.embed_abc(extra, "31:6", "X:1\n"))
        inner = extra["workflow"]["definitions"]["subgraphs"][0]["nodes"][0]
        self.assertEqual(inner["properties"], {PROPERTY: "X:1\n"})

    def test_without_a_workflow_nothing_is_embedded(self):
        for extra in (None, {}, {"workflow": None}, {"workflow": workflow()}):
            with self.subTest(extra=extra):
                unique_id = "99" if extra and extra.get("workflow") else "11"
                self.assertFalse(saved_score.embed_abc(extra, unique_id, "X:1\n"))
        self.assertFalse(saved_score.embed_abc({"workflow": workflow()}, "11:6", "X:1\n"))


class StripTest(unittest.TestCase):
    def test_strips_only_bundle_scores(self):
        graph = workflow()
        graph["definitions"]["subgraphs"][0]["nodes"][0]["properties"] = {PROPERTY: "old inner"}
        self.assertEqual(saved_score.strip_abc(graph), 2)
        self.assertNotIn(PROPERTY, graph["nodes"][0]["properties"])
        self.assertEqual(graph["definitions"]["subgraphs"][0]["nodes"][1]["properties"], {PROPERTY: "not a bundle"})

    def test_queued_prompt_handler(self):
        queued = {"prompt": {}, "extra_data": {"extra_pnginfo": {"workflow": workflow()}}}
        self.assertIs(saved_score.strip_queued(queued), queued)
        self.assertNotIn(PROPERTY, queued["extra_data"]["extra_pnginfo"]["workflow"]["nodes"][0]["properties"])
        for other in ({"prompt": {}}, {"extra_data": {}}, {"extra_data": {"extra_pnginfo": None}}):
            with self.subTest(other=other):
                self.assertIs(saved_score.strip_queued(other), other)


if __name__ == "__main__":
    unittest.main()
