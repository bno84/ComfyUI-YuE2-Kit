"""Optional model-only loading through ComfyUI's native LoRA implementation."""

import folder_paths
from safetensors import safe_open
from nodes import LoraLoaderModelOnly

from .model_files import resolve


def load_optional_lora(model, name, strength):
    # Return before resolving a path or constructing a loader. No file is needed.
    if name == "(none)" or strength == 0:
        return model
    found = resolve(name, folder_paths.get_filename_list("loras"))
    if found is None:
        raise ValueError(f"LoRA {name} was not found in models/loras or its subfolders.")
    if found.endswith(".safetensors"):
        path = folder_paths.get_full_path_or_raise("loras", found)
        with safe_open(path, framework="pt", device="cpu") as handle:
            if any(".nar_self_attn." in key or ".nar_mlp." in key for key in handle.keys()):
                raise ValueError(
                    "This adapter uses the original YuE2 NAR layout. Choose the "
                    "_comfyui.safetensors export, which contains fused projections "
                    "and base-relative deltas for the full replacement weights."
                )
    return LoraLoaderModelOnly().load_lora_model_only(model, found, strength)[0]
