"""Model files this pack knows: lookup across model subfolders and install hints.

Kept free of ComfyUI imports so it can be tested on its own.
"""

from dataclasses import asdict, dataclass
from pathlib import PurePosixPath


@dataclass(frozen=True)
class KnownModel:
    label: str
    folder: str
    filename: str
    url: str
    link_text: str
    use: str
    license: str = ""


# Checked on the Hugging Face model cards: Comfy-Org/YuE2 and its sources
# m-a-p/YuE2-3B and m-a-p/SheetSage2, and the instrumental LoRA.
NON_COMMERCIAL = "CC BY-NC 4.0 (non-commercial)"

KNOWN_MODELS = (
    KnownModel(
        "YuE2 3B", "checkpoints", "yue2_3b_bf16.safetensors",
        "https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_bf16.safetensors",
        "Comfy-Org/YuE2", "Needed for every song.", NON_COMMERCIAL,
    ),
    KnownModel(
        "SheetSage2", "audio_encoders", "sheetsage2_bf16.safetensors",
        "https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors",
        "Comfy-Org/YuE2", "Needed for Transcribe only. Choose None or ABC in Reference input to continue without it.",
        NON_COMMERCIAL,
    ),
    KnownModel(
        "Instrumental LoRA", "loras", "ar_lora_inst_v3abc_comfyui.safetensors",
        "https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras",
        "Mothersuperior/YuE2-instrumental-cot-full-loras",
        "Needed only when Instrumental is on. Turn it off to continue without it.",
        NON_COMMERCIAL,
    ),
)


def filename(name):
    """The file name without its subfolder, for either path separator."""
    return PurePosixPath(name.replace("\\", "/")).name


def resolve(name, available):
    """Return the installed entry for name, or None.

    An exact match wins. Otherwise the first entry with the same file name in
    another subfolder is used, so a template's default file is found wherever
    it was saved, e.g. ``loras/x.safetensors`` for ``x.safetensors``.
    """
    if name in available:
        return name
    wanted = filename(name)
    return next((entry for entry in available if filename(entry) == wanted), None)


def file_choices(folder, available, required):
    """Installed files plus the known default files ComfyUI should accept.

    ComfyUI's frontend reports any model value that is not an exact dropdown
    entry as a missing required model on load. So a default found only in a
    subfolder is listed under its bare name, since it resolves when used. An
    optional default is listed even when absent: not having it is fine. A
    required default that is truly absent stays unlisted, so ComfyUI warns
    about it on load and can offer the template's download link.
    """
    defaults = [
        model.filename for model in KNOWN_MODELS
        if model.folder == folder and (not required or resolve(model.filename, available))
    ]
    return sorted({*available, *defaults})


def known_model(folder, name):
    return next((model for model in KNOWN_MODELS if model.folder == folder and model.filename == filename(name)), None)


def missing_message(folder, name):
    where = f"ComfyUI/models/{folder}/"
    model = known_model(folder, name)
    if model is None:
        return f"{name} was not found in {where} or its subfolders. Install it there or choose another file."
    license = f" Its license is {model.license}." if model.license else ""
    return (
        f"{model.label} is not installed: {model.filename} was not found in {where} or its subfolders. "
        f"Download it from {model.url}, save it in {where}, and queue again.{license} {model.use}"
    )


def model_status(available_by_folder):
    """Known models with the installed entry each resolves to, or None."""
    return [
        {**asdict(model), "installed": resolve(model.filename, available_by_folder(model.folder))}
        for model in KNOWN_MODELS
    ]
