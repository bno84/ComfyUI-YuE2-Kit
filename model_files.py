"""Model file lookup across subfolders, with details read from a workflow.

A file node in the template describes its default file in two properties:
ComfyUI's standard ``models`` entry (name, url, directory), which also drives
ComfyUI's own download offer, and ``bno84.model`` (label, use, license).
That template is the only place these details are written.

Kept free of ComfyUI imports so it can be tested on its own.
"""

from pathlib import PurePosixPath

DETAILS = "bno84.model"


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


def workflow_models(workflow):
    """The default model each described file node names, including inside subgraphs."""
    graphs = [workflow, *workflow.get("definitions", {}).get("subgraphs", [])]
    models = []
    for graph in graphs:
        for node in graph["nodes"]:
            properties = node.get("properties") or {}
            if DETAILS in properties and properties.get("models"):
                model = properties["models"][0]
                models.append({
                    "type": node["type"], "folder": model["directory"], "filename": model["name"],
                    "url": model["url"], **properties[DETAILS],
                })
    return models


def file_choices(node_type, available, required, models):
    """Installed files plus the default files ComfyUI should accept for this node type.

    ComfyUI's frontend reports any model value that is not an exact dropdown
    entry as a missing required model on load. So a default found only in a
    subfolder is listed under its bare name, since it resolves when used. An
    optional default is listed even when absent: not having it is fine. A
    required default that is truly absent stays unlisted, so ComfyUI warns
    about it on load and can offer the template's download link.
    """
    defaults = [
        model["filename"] for model in models
        if model["type"] == node_type and (not required or resolve(model["filename"], available))
    ]
    return sorted({*available, *defaults})


def missing_message(folder, name, models):
    where = f"ComfyUI/models/{folder}/"
    model = next((m for m in models if m["folder"] == folder and m["filename"] == filename(name)), None)
    if model is None:
        return f"{name} was not found in {where} or its subfolders. Install it there or choose another file."
    license = f" Its license is {model['license']}." if model.get("license") else ""
    return (
        f"{model['label']} is not installed: {model['filename']} was not found in {where} or its subfolders. "
        f"Download it from {model['url']}, save it in {where}, and queue again.{license} {model.get('use', '')}"
    ).strip()
