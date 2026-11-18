"""The templates record the pack versions they ship with."""

import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def expected_versions():
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    pin = lambda name: re.search(rf"^\s*{name}: v(\S+)$", ci, re.M).group(1)
    return {"comfyui-yue2-kit": version,
            "comfyui-audiovisualizer": pin("AUDIOVISUALIZER_REF"),
            "comfyui-abcpreview": pin("ABCPREVIEW_REF")}


def recorded_versions(workflow):
    graphs = [workflow, *workflow.get("definitions", {}).get("subgraphs", [])]
    for graph in graphs:
        for node in graph["nodes"]:
            properties = node.get("properties") or {}
            if "cnr_id" in properties:
                yield node.get("type"), properties["cnr_id"], properties.get("ver")


class TemplateVersionTests(unittest.TestCase):
    def test_templates_name_the_released_pack_versions(self):
        expected = expected_versions()
        templates = sorted((ROOT / "example_workflows").glob("*.json"))
        self.assertTrue(templates)
        for template in templates:
            workflow = json.loads(template.read_text(encoding="utf-8"))
            for node_type, pack, version in recorded_versions(workflow):
                if pack in expected:
                    with self.subTest(template=template.name, node=node_type):
                        self.assertEqual(version, expected[pack])


if __name__ == "__main__":
    unittest.main()
