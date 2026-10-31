"""Check model file lookup and install hints without ComfyUI."""

import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "yue2_model_files", Path(__file__).resolve().parents[1] / "model_files.py"
)
model_files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model_files)

LORA = "ar_lora_inst_v3abc_comfyui.safetensors"
CKPT = "yue2_3b_bf16.safetensors"
CKPT_SUB = f"yue2/{CKPT}"


def described(node_type, name, directory, **details):
    return {"type": node_type, "properties": {
        "models": [{"name": name, "url": f"https://example.org/{name}", "directory": directory}],
        "bno84.model": details,
    }}


WORKFLOW = {
    "nodes": [{"type": "Note", "properties": {}}],
    "definitions": {"subgraphs": [{"nodes": [
        described("bno84.CheckpointFile", CKPT, "checkpoints", label="YuE2 3B", use="Needed for every song."),
        described("bno84.OptionalLoraFile", LORA, "loras", label="Instrumental LoRA",
                  use="Turn it off to continue without it.", license="CC BY-NC 4.0 (non-commercial)"),
        {"type": "bno84.OptionalLoraFile", "properties": {"models": [{"name": "x", "url": "u", "directory": "loras"}]}},
    ]}]},
}
MODELS = model_files.workflow_models(WORKFLOW)


class ResolveTests(unittest.TestCase):
    def test_exact_match_wins_over_same_name_in_subfolder(self):
        self.assertEqual(model_files.resolve(LORA, [f"loras/{LORA}", LORA]), LORA)

    def test_finds_the_same_file_name_in_a_subfolder(self):
        self.assertEqual(model_files.resolve(LORA, ["other.safetensors", f"loras/{LORA}"]), f"loras/{LORA}")
        self.assertEqual(model_files.resolve(f"old/{LORA}", [f"new/{LORA}"]), f"new/{LORA}")
        self.assertEqual(model_files.resolve(LORA, [f"loras\\{LORA}"]), f"loras\\{LORA}")

    def test_missing(self):
        self.assertIsNone(model_files.resolve(LORA, []))
        self.assertIsNone(model_files.resolve(LORA, ["ar_lora_inst_v2.safetensors"]))


class WorkflowTests(unittest.TestCase):
    def test_reads_only_described_file_nodes_inside_subgraphs(self):
        self.assertEqual([(m["type"], m["folder"], m["filename"], m["label"]) for m in MODELS], [
            ("bno84.CheckpointFile", "checkpoints", CKPT, "YuE2 3B"),
            ("bno84.OptionalLoraFile", "loras", LORA, "Instrumental LoRA"),
        ])

    def test_bundled_template_describes_its_three_files(self):
        template = Path(__file__).resolve().parents[1] / "example_workflows" / "YuE2 Kit - Song workflow.json"
        models = model_files.workflow_models(json.loads(template.read_text(encoding="utf-8")))
        self.assertEqual({m["label"] for m in models}, {"YuE2 3B", "SheetSage2", "Instrumental LoRA"})


class ChoiceTests(unittest.TestCase):
    def choices(self, node_type, available, required):
        return model_files.file_choices(node_type, available, required, MODELS)

    def test_optional_default_is_listed_even_when_absent(self):
        self.assertEqual(self.choices("bno84.OptionalLoraFile", ["mine.safetensors"], False), [LORA, "mine.safetensors"])

    def test_bare_default_listed_when_only_a_subfolder_copy_exists(self):
        self.assertEqual(self.choices("bno84.OptionalLoraFile", [f"loras/{LORA}"], False), [LORA, f"loras/{LORA}"])
        self.assertEqual(self.choices("bno84.CheckpointFile", [CKPT_SUB], True), [CKPT_SUB, CKPT])

    def test_absent_required_default_stays_unlisted_so_comfyui_warns(self):
        self.assertEqual(self.choices("bno84.CheckpointFile", ["other.safetensors"], True), ["other.safetensors"])

    def test_defaults_of_other_node_types_are_not_listed(self):
        self.assertEqual(self.choices("bno84.OptionalAudioEncoderFile", [], False), [])


class MessageTests(unittest.TestCase):
    def test_described_file_names_source_license_folder_and_how_to_skip(self):
        self.assertEqual(model_files.missing_message("loras", f"loras/{LORA}", MODELS), (
            f"Instrumental LoRA is not installed: {LORA} was not found in ComfyUI/models/loras/ or its subfolders. "
            f"Download it from https://example.org/{LORA}, save it in ComfyUI/models/loras/, and queue again. "
            "Its license is CC BY-NC 4.0 (non-commercial). Turn it off to continue without it."
        ))

    def test_other_files_get_only_the_folder(self):
        self.assertEqual(model_files.missing_message("loras", "mine.safetensors", MODELS),
                         "mine.safetensors was not found in ComfyUI/models/loras/ or its subfolders. "
                         "Install it there or choose another file.")
        self.assertNotIn("Instrumental", model_files.missing_message("checkpoints", LORA, MODELS))


if __name__ == "__main__":
    unittest.main()
