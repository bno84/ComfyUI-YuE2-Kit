"""Check all ten reference routes of the one API prompt in real ComfyUI on CPU, with model calls mocked.

Every route is the same compiled prompt with different control values. Each
runs against three model layouts: optional models missing, everything
installed in subfolders, and the required checkpoint missing. The disabled
Audio Visualizer from comfyui/custom_nodes stays in every prompt: neither it
nor its still may block a route or run.
"""
import asyncio
import copy
import importlib
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import Mock, patch

comfyui, pack = (Path(arg).resolve() for arg in sys.argv[1:])
sys.path.insert(0, str(comfyui))
sys.argv = [sys.argv[0], "--cpu"]
# ComfyUI ignores sys.argv on library imports unless parsing is enabled first.
import comfy.options
comfy.options.enable_args_parsing()
import execution
import folder_paths
import nodes
from comfy_api.latest import io
from server import PromptServer


async def register():
    for name in ["nodes_audio", "nodes_audio_encoder", "nodes_yue2", "nodes_logic", "nodes_primitive", "nodes_math"]:
        extension = await importlib.import_module("comfy_extras." + name).comfy_entrypoint()
        for cls in await extension.get_node_list():
            nodes.NODE_CLASS_MAPPINGS[cls.GET_SCHEMA().node_id] = cls
    spec = importlib.util.spec_from_file_location("kit_routes", pack / "__init__.py", submodule_search_locations=[str(pack)])
    kit = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = kit
    spec.loader.exec_module(kit)
    for cls in await (await kit.comfy_entrypoint()).get_node_list():
        nodes.NODE_CLASS_MAPPINGS[cls.GET_SCHEMA().node_id] = cls
    visualizer = comfyui / "custom_nodes" / "ComfyUI-AudioVisualizer"
    spec = importlib.util.spec_from_file_location("visualizer", visualizer / "__init__.py",
                                                  submodule_search_locations=[str(visualizer)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    nodes.NODE_CLASS_MAPPINGS.update(module.NODE_CLASS_MAPPINGS)
    # ABC Preview's timeline feeds Acoustic's score estimate. Its routes need a server.
    preview = comfyui / "custom_nodes" / "ComfyUI-ABCPreview"
    spec = importlib.util.spec_from_file_location("abc_preview", preview / "__init__.py",
                                                  submodule_search_locations=[str(preview)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    with patch.object(PromptServer, "instance", Mock(), create=True):
        spec.loader.exec_module(module)
    for cls in await (await module.comfy_entrypoint()).get_node_list():
        nodes.NODE_CLASS_MAPPINGS[cls.GET_SCHEMA().node_id] = cls


class Capture:
    INPUT_TYPES = classmethod(lambda cls: {"required": {
        "value": ("STRING",), "clip": ("CLIP",), "lyrics": ("STRING",), "max_duration": ("FLOAT",),
        "model": ("MODEL",),
    }})
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "capture"
    values = []

    def capture(self, value, clip, lyrics, max_duration, model):
        self.values.append((value, clip, lyrics, max_duration, model))
        return ()


asyncio.run(register())
nodes.NODE_CLASS_MAPPINGS["TestCapture"] = Capture
original_names = folder_paths.get_filename_list
file_exists = folder_paths.exists_annotated_filepath
# Loading the kit copied its default still into the input folder.
assert file_exists("yue2-kit-still.png")
CHECKPOINT = "yue2/yue2_3b_bf16.safetensors"
ENCODER = "yue2/sheetsage2_bf16.safetensors"
LORA = "loras/ar_lora_inst_v3abc_comfyui.safetensors"
LAYOUTS = {
    # Template defaults are bare file names; every installed copy sits in a subfolder.
    "optional models missing": {"checkpoints": [CHECKPOINT], "audio_encoders": [], "loras": []},
    "all installed in subfolders": {"checkpoints": [CHECKPOINT], "audio_encoders": [ENCODER], "loras": [LORA]},
    "required checkpoint missing": {"checkpoints": [], "audio_encoders": [ENCODER], "loras": [LORA]},
}
listing = {}


def filenames(kind):
    return listing[kind] if kind in listing else original_names(kind)


calls = []
base_model, base_clip, base_vae, instrumental_clip = (object() for _ in range(4))


def recorded(name, result):
    def execute(cls, **kwargs):
        calls.append(name)
        return io.NodeOutput(result(kwargs))
    return classmethod(execute)


def load_checkpoint(self, ckpt_name, *args, **kwargs):
    assert ckpt_name == CHECKPOINT, ckpt_name
    return base_model, base_clip, base_vae


def load_encoder(cls, audio_encoder_name):
    assert audio_encoder_name == ENCODER, audio_encoder_name
    calls.append("encoder")
    return io.NodeOutput(object())


def load_lora(self, model, clip, lora_name, strength_model, strength_clip):
    assert model is base_model and clip is base_clip
    assert lora_name == LORA, lora_name
    assert strength_model == 0 and strength_clip == 1
    calls.append("instrumental")
    return model, instrumental_clip


pasted = "X:1\nK:C\n[V:Vocal] C4 z4 |\n[V:Ins] z8 |\n"
transcribed = "TRANSCRIBED\n"
fresh = "FRESH\n"
data = json.loads((pack / "api" / "yue2-kit-song.api.json").read_text())
assert data["33"]["inputs"]["source"] == "None" and data["32"]["inputs"]["instrumental"] is False
music_inputs = data["31:6"]["inputs"]
acoustic_model = data["31:9"]["inputs"]["model"]
assert acoustic_model == ["59", 0]
assert data["59"]["class_type"] == "bno84.OptionalModelLora"
assert data["59"]["inputs"] == {"model": ["34:4", 0], "lora_name": "(none)", "strength_model": 1.0}
assert not any(node["class_type"] == "bno84.ModelStatus" for node in data.values())
visualizer = next(node for node in data.values() if node["class_type"] == "AudioVisualizer")
assert visualizer["inputs"]["enabled"] is False and visualizer["inputs"]["audio"] == data["11"]["inputs"]["audio"]
assert data[visualizer["inputs"]["image"][0]]["inputs"]["image"] == "yue2-kit-still.png"
# Generation length: the timeline's estimate plus a margin, unless Maximum duration is on.
limit = data[music_inputs["max_duration"][0]]["inputs"]
assert limit["switch"] is False and data[limit["on_true"][0]]["inputs"]["value"] == 120
estimate = data[limit["on_false"][0]]["inputs"]
assert estimate["expression"] == "a + b" and data[estimate["values.a"][0]]["class_type"] == "bno84.ABCTimeline"
assert data[estimate["values.b"][0]]["inputs"]["value"] == 10


def route_prompt(source, extend, instrumental):
    prompt = {key: copy.deepcopy(value) for key, value in data.items() if key not in ("11", "22")}
    prompt["capture"] = {"class_type": "TestCapture", "inputs": {
        "value": data["11"]["inputs"]["abc"], "clip": music_inputs["clip"], "lyrics": music_inputs["lyrics"],
        "max_duration": music_inputs["max_duration"], "model": acoustic_model,
    }}
    prompt["33"]["inputs"].update(source=source, abc=pasted, extend=extend,
                                  audio="reference.wav" if source == "Transcribe" else "")
    prompt["32"]["inputs"]["instrumental"] = instrumental
    if instrumental:
        prompt["32"]["inputs"]["lyrics"] = "[instrumental]"
    return prompt


with patch.object(folder_paths, "get_filename_list", side_effect=filenames), \
     patch.object(folder_paths, "exists_annotated_filepath", side_effect=lambda name: name == "reference.wav" or file_exists(name)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoadImage"], "load_image", new=lambda self, image: calls.append("still")), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["CheckpointLoaderSimple"], "load_checkpoint", new=load_checkpoint), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoraLoader"], "load_lora", new=load_lora), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoadAudio"], "fingerprint_inputs", new=classmethod(lambda cls, **kwargs: 0)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoadAudio"], "execute", new=recorded("audio", lambda _: {"waveform": "fixture", "sample_rate": 44100})), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["AudioEncoderLoader"], "execute", new=classmethod(load_encoder)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["SheetSage2AudioToABC"], "execute", new=recorded("transcribe", lambda _: [transcribed])), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["YuE2GenerateABC"], "execute", new=recorded("fresh", lambda _: fresh)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["bno84.YuE2ExtendABC"], "execute", new=recorded("extend", lambda args: args["abc"] + "EXTENDED\n")):
    lyrics_style = nodes.NODE_CLASS_MAPPINGS["bno84.LyricsStyle"]
    # Warnings belong to the frontend; even nonstandard text must pass through.
    for instrumental in (False, True):
        assert lyrics_style.execute(instrumental, "[Intro]\nSung words", "piano, 88 BPM").result == (
            "[Intro]\nSung words", "piano, 88 BPM", instrumental,
        )
    reference = nodes.NODE_CLASS_MAPPINGS["bno84.ReferenceInput"]
    assert reference.validate_inputs("None", "stale ABC", "missing.wav") is True
    assert reference.fingerprint_inputs("None", "missing.wav") is None
    assert reference.fingerprint_inputs("ABC", "missing.wav") is None
    model_input = next(item for item in reference.define_schema().inputs if item.id == "transcription_model")
    assert model_input.optional and model_input.lazy
    assert reference.check_lazy_status(source="ABC", transcription_model=None) == []
    assert reference.execute("None", "stale ABC", "missing.wav", True).result == ("", None, False, False, False)
    assert reference.execute("ABC", pasted, "missing.wav", True).result == (pasted, None, True, False, True)
    assert "empty" in reference.validate_inputs("ABC", " \n", "missing.wav")
    assert reference.validate_inputs("Transcribe", pasted, "missing.wav") is not True
    cases = [
        ("song", "None", False),
        ("audio-reference", "Transcribe", False),
        ("audio-extend", "Transcribe", True),
        ("abc-reference", "ABC", False),
        ("abc-extend", "ABC", True),
    ]
    for layout, files in LAYOUTS.items():
        listing = files
        for instrumental in (False, True):
            for route, source, extend in cases:
                name = f"{layout}: {'instrumental-' if instrumental else ''}{route}"
                audio = source == "Transcribe"
                prompt = route_prompt(source, extend, instrumental)
                valid = asyncio.run(execution.validate_prompt(name, copy.deepcopy(prompt), None))
                if not files["checkpoints"]:
                    # A missing required model stops queueing, with its download hint.
                    assert not valid[0] and "YuE2 3B is not installed" in str(valid), (name, valid)
                    print(f"PASS {name}: blocked before queueing")
                    continue
                # Optional models never block validation, installed or not.
                assert valid[0], (name, valid)
                calls.clear()
                executor = execution.PromptExecutor(Mock(client_id=None), cache_args={"ram": 0, "ram_inactive": 0})
                executor.execute(prompt, name, execute_outputs=valid[2])
                missing = [label for label, used, folder in (
                    ("SheetSage2", audio, "audio_encoders"), ("Instrumental LoRA", instrumental, "loras"),
                ) if used and not files[folder]]
                if missing:
                    errors = [data["exception_message"] for event, data in executor.status_messages if event == "execution_error"]
                    assert not executor.success and len(errors) == 1, (name, executor.status_messages)
                    assert any(errors[0].startswith(f"{label} is not installed") for label in missing), (name, errors)
                    print(f"PASS {name}: stopped with {errors[0].split(':')[0]!r}")
                    continue
                assert executor.success, executor.status_messages
                expected = fresh if route == "song" else transcribed if audio else pasted
                score, clip, lyrics, max_duration, model = Capture.values[-1]
                assert model is base_model, (name, model)
                assert score == expected + ("EXTENDED\n" if extend else ""), (name, Capture.values)
                assert clip is (instrumental_clip if instrumental else base_clip), name
                expected_lyrics = "[instrumental]" if instrumental else data["32"]["inputs"]["lyrics"]
                assert lyrics == expected_lyrics, (name, lyrics)
                # The timeline's estimate of the score used, plus the template's 10 s margin.
                estimate = sys.modules["abc_preview.timeline"].parse(score)["seconds"]
                assert estimate > 0 and max_duration == estimate + 10, (name, estimate, max_duration)
                assert calls.count("instrumental") == int(instrumental), (name, calls)
                assert calls.count("extend") == int(extend), (name, calls)
                assert calls.count("encoder") == int(audio), (name, calls)
                assert calls.count("audio") == int(audio), (name, calls)
                assert calls.count("transcribe") == int(audio), (name, calls)
                assert calls.count("fresh") == int(route == "song"), (name, calls)
                assert "still" not in calls, (name, calls)
                print(f"PASS {name}: {calls}")
print("All ten reference routes passed in three model layouts with native routing and mocked model execution.")
