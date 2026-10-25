"""Verify optional bypasses never touch files, and enabled adapters use native loading."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]


class OptionalLoraTests(unittest.TestCase):
    def setUp(self):
        self.folders = types.ModuleType('folder_paths')
        self.folders.get_filename_list = Mock(return_value=['sub/test.safetensors'])
        self.folders.get_full_path_or_raise = Mock(return_value='/models/sub/test.safetensors')
        self.native = types.ModuleType('nodes')
        self.native.LoraLoaderModelOnly = Mock()
        self.safe = types.ModuleType('safetensors')
        self.safe.safe_open = MagicMock()
        self.safe.safe_open.return_value.__enter__ = Mock(return_value=types.SimpleNamespace(keys=lambda: ['diffusion_model.x.lora_up.weight']))
        self.safe.safe_open.return_value.__exit__ = Mock(return_value=False)
        package = types.ModuleType('optional_lora_test_pack')
        package.__path__ = [str(ROOT)]
        self.modules = patch.dict(sys.modules, {'folder_paths': self.folders, 'nodes': self.native,
                                               'safetensors': self.safe, 'optional_lora_test_pack': package})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        spec = importlib.util.spec_from_file_location('optional_lora_test_pack.optional_lora', ROOT / 'optional_lora.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.model = object()

    def test_none_and_zero_return_exact_model_without_file_access(self):
        for name, strength in [('(none)', 1), ('missing.safetensors', 0)]:
            self.assertIs(self.module.load_optional_lora(self.model, name, strength), self.model)
        self.folders.get_filename_list.assert_not_called()
        self.native.LoraLoaderModelOnly.assert_not_called()
        self.safe.safe_open.assert_not_called()

    def test_resolves_subfolder_and_preserves_multiplier(self):
        expected = object()
        loader = self.native.LoraLoaderModelOnly.return_value
        loader.load_lora_model_only.return_value = (expected,)
        self.assertIs(self.module.load_optional_lora(self.model, 'test.safetensors', -0.35), expected)
        loader.load_lora_model_only.assert_called_once_with(self.model, 'sub/test.safetensors', -0.35)

    def test_missing_enabled_file_fails(self):
        with self.assertRaisesRegex(ValueError, 'not found'):
            self.module.load_optional_lora(self.model, 'missing.safetensors', 1)
        self.native.LoraLoaderModelOnly.assert_not_called()

    def test_original_nar_layout_fails_with_conversion_hint(self):
        self.safe.safe_open.return_value.__enter__.return_value.keys = lambda: ['layers.0.nar_self_attn.q_proj.lora_A']
        with self.assertRaisesRegex(ValueError, '_comfyui.safetensors'):
            self.module.load_optional_lora(self.model, 'test.safetensors', 1)
        self.native.LoraLoaderModelOnly.assert_not_called()
