"""API prompt required-input checks used by the ComfyUI smoke test."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).resolve().parents[1] / ".github/scripts/comfyui_smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ApiSchemaTests(unittest.TestCase):
    def test_missing_required_input_fails_even_if_the_schema_has_a_default(self):
        info = {"AudioVisualizer": {"input": {"required": {"container": ["STRING", {"default": "mp4"}]}}}}
        prompt = {"55": {"class_type": "AudioVisualizer", "inputs": {}}}
        self.assertIn("container", smoke.api_input_errors(prompt, info, ["AudioVisualizer"])[0])
        prompt["55"]["inputs"]["container"] = "mp4"
        self.assertEqual(smoke.api_input_errors(prompt, info, ["AudioVisualizer"]), [])

    def test_reports_missing_selected_types_and_ignores_unselected_types(self):
        prompt = {"55": {"class_type": "AudioVisualizer", "inputs": {}},
                  "1": {"class_type": "OtherPackNode", "inputs": {}}}
        errors = smoke.api_input_errors(prompt, {}, ["AudioVisualizer"])
        self.assertEqual(errors, ["API node 55: type not registered: AudioVisualizer"])
