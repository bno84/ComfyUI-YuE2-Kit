"""Check model file lookup and install hints without ComfyUI."""

import importlib.util
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


class ResolveTests(unittest.TestCase):
    def test_exact_match_wins_over_same_name_in_subfolder(self):
        self.assertEqual(model_files.resolve(LORA, [f"loras/{LORA}", LORA]), LORA)

    def test_finds_the_same_file_name_in_a_subfolder(self):
        self.assertEqual(model_files.resolve(LORA, ["other.safetensors", f"loras/{LORA}"]), f"loras/{LORA}")

    def test_subfolder_choice_falls_back_to_another_folder(self):
        self.assertEqual(model_files.resolve(f"old/{LORA}", [f"new/{LORA}"]), f"new/{LORA}")

    def test_windows_separators(self):
        self.assertEqual(model_files.resolve(LORA, [f"loras\\{LORA}"]), f"loras\\{LORA}")

    def test_first_of_several_matches(self):
        self.assertEqual(model_files.resolve(LORA, [f"a/{LORA}", f"b/{LORA}"]), f"a/{LORA}")

    def test_missing(self):
        self.assertIsNone(model_files.resolve(LORA, []))
        self.assertIsNone(model_files.resolve(LORA, ["ar_lora_inst_v2.safetensors"]))


class ChoiceTests(unittest.TestCase):
    def test_optional_defaults_are_listed_even_when_absent(self):
        self.assertEqual(model_files.file_choices("loras", ["mine.safetensors"], False), [LORA, "mine.safetensors"])

    def test_bare_default_listed_when_only_a_subfolder_copy_exists(self):
        for required in (False, True):
            self.assertEqual(model_files.file_choices("loras", [f"loras/{LORA}"], required), [LORA, f"loras/{LORA}"])

    def test_absent_required_default_stays_unlisted_so_comfyui_warns(self):
        self.assertEqual(model_files.file_choices("checkpoints", ["other.safetensors"], True), ["other.safetensors"])
        self.assertEqual(model_files.file_choices("checkpoints", [CKPT_SUB], True), [CKPT_SUB, CKPT])

    def test_no_duplicates_and_no_defaults_from_other_folders(self):
        self.assertEqual(model_files.file_choices("loras", [LORA], True), [LORA])
        self.assertEqual(model_files.file_choices("vae", [], False), [])


class MessageTests(unittest.TestCase):
    def test_known_model_names_source_license_folder_and_how_to_skip(self):
        message = model_files.missing_message("loras", f"loras/{LORA}")
        self.assertIn("Instrumental LoRA is not installed", message)
        self.assertIn("https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras", message)
        self.assertIn("CC BY-NC 4.0", message)
        self.assertIn("ComfyUI/models/loras/", message)
        self.assertIn("Turn it off", message)

    def test_known_file_in_another_folder_is_not_that_model(self):
        self.assertNotIn("Instrumental", model_files.missing_message("checkpoints", LORA))

    def test_unknown_file(self):
        message = model_files.missing_message("loras", "mine.safetensors")
        self.assertIn("mine.safetensors was not found in ComfyUI/models/loras/", message)


class StatusTests(unittest.TestCase):
    def test_reports_resolved_entries(self):
        listing = {
            "checkpoints": ["yue2/yue2_3b_bf16.safetensors"],
            "audio_encoders": [],
            "loras": [f"loras/{LORA}"],
        }
        status = {entry["label"]: entry for entry in model_files.model_status(listing.__getitem__)}
        self.assertEqual(status["YuE2 3B"]["installed"], "yue2/yue2_3b_bf16.safetensors")
        self.assertIsNone(status["SheetSage2"]["installed"])
        self.assertEqual(status["Instrumental LoRA"]["installed"], f"loras/{LORA}")
        for label in ("YuE2 3B", "SheetSage2", "Instrumental LoRA"):
            self.assertEqual(status[label]["license"], "CC BY-NC 4.0 (non-commercial)")


if __name__ == "__main__":
    unittest.main()
