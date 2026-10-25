"""Check all ten reference routes of the one API prompt in real ComfyUI on CPU, with model calls mocked.

Every route is the same compiled prompt with different control values. Each
runs against three model layouts: optional models missing, everything
installed in subfolders, and the required checkpoint missing.
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


class Capture:
    INPUT_TYPES = classmethod(lambda cls: {"required": {"value": ("STRING",), "clip": ("CLIP",), "lyrics": ("STRING",)}})
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "capture"
    values = []

    def capture(self, value, clip, lyrics):
        self.values.append((value, clip, lyrics))
        return ()


asyncio.run(register())
nodes.NODE_CLASS_MAPPINGS["TestCapture"] = Capture
original_names = folder_paths.get_filename_list
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
assert data["31:9"]["inputs"]["model"] == ["34:4", 0]
assert not any(node["class_type"] == "bno84.ModelStatus" for node in data.values())


def route_prompt(source, extend, instrumental):
    prompt = {key: copy.deepcopy(value) for key, value in data.items() if key not in ("11", "22")}
    prompt["capture"] = {"class_type": "TestCapture", "inputs": {
        "value": data["11"]["inputs"]["abc"], "clip": music_inputs["clip"], "lyrics": music_inputs["lyrics"],
    }}
    prompt["33"]["inputs"].update(source=source, abc=pasted, extend=extend,
                                  audio="reference.wav" if source == "Transcribe" else "")
    prompt["32"]["inputs"]["instrumental"] = instrumental
    if instrumental:
        prompt["32"]["inputs"]["lyrics"] = "[instrumental]"
    return prompt


with patch.object(folder_paths, "get_filename_list", side_effect=filenames), \
     patch.object(folder_paths, "exists_annotated_filepath", side_effect=lambda name: name == "reference.wav"), \
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
                score, clip, lyrics = Capture.values[-1]
                assert score == expected + ("EXTENDED\n" if extend else ""), (name, Capture.values)
                assert clip is (instrumental_clip if instrumental else base_clip), name
                expected_lyrics = "[instrumental]" if instrumental else data["32"]["inputs"]["lyrics"]
                assert lyrics == expected_lyrics, (name, lyrics)
                assert calls.count("instrumental") == int(instrumental), (name, calls)
                assert calls.count("extend") == int(extend), (name, calls)
                assert calls.count("encoder") == int(audio), (name, calls)
                assert calls.count("audio") == int(audio), (name, calls)
                assert calls.count("transcribe") == int(audio), (name, calls)
                assert calls.count("fresh") == int(route == "song"), (name, calls)
                print(f"PASS {name}: {calls}")
print("All ten reference routes passed in three model layouts with native routing and mocked model execution.")
