"""Check vocal and instrumental versions of the five reference routes in real ComfyUI on CPU, with model calls mocked."""
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
installed = False
lora_installed = False
base_model, base_clip, base_vae, instrumental_clip = (object() for _ in range(4))


def filenames(kind):
    if kind == "audio_encoders":
        return ["sheetsage2_bf16.safetensors"] if installed else []
    if kind == "loras":
        return ["ar_lora_inst_v3abc_comfyui.safetensors"] if lora_installed else []
    if kind == "checkpoints":
        return ["yue2_3b_bf16.safetensors"]
    return original_names(kind)


calls = []


def recorded(name, result):
    def execute(cls, **kwargs):
        calls.append(name)
        return io.NodeOutput(result(kwargs))
    return classmethod(execute)


def load_lora(self, model, clip, lora_name, strength_model, strength_clip):
    assert model is base_model and clip is base_clip
    assert lora_name == "ar_lora_inst_v3abc_comfyui.safetensors"
    assert strength_model == 0 and strength_clip == 1
    calls.append("instrumental")
    return model, instrumental_clip


pasted = "X:1\nK:C\n[V:Vocal] C4 z4 |\n[V:Ins] z8 |\n"
transcribed = "TRANSCRIBED\n"
fresh = "FRESH\n"
with patch.object(folder_paths, "get_filename_list", side_effect=filenames), \
     patch.object(folder_paths, "exists_annotated_filepath", side_effect=lambda name: installed and name == "reference.wav"), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["CheckpointLoaderSimple"], "load_checkpoint", return_value=(base_model, base_clip, base_vae)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoraLoader"], "load_lora", new=load_lora), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoadAudio"], "fingerprint_inputs", new=classmethod(lambda cls, **kwargs: 0)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["LoadAudio"], "execute", new=recorded("audio", lambda _: {"waveform": "fixture", "sample_rate": 44100})), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["AudioEncoderLoader"], "execute", new=recorded("encoder", lambda _: object())), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["SheetSage2AudioToABC"], "execute", new=recorded("transcribe", lambda _: [transcribed])), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["YuE2GenerateABC"], "execute", new=recorded("fresh", lambda _: fresh)), \
     patch.object(nodes.NODE_CLASS_MAPPINGS["bno84.YuE2ExtendABC"], "execute", new=recorded("extend", lambda args: args["abc"] + "EXTENDED\n")):
    reference = nodes.NODE_CLASS_MAPPINGS["bno84.ReferenceInput"]
    assert reference.validate_inputs("None", "stale ABC", "missing.wav") is True
    assert reference.fingerprint_inputs("None", "missing.wav") is None
    assert reference.fingerprint_inputs("ABC", "missing.wav") is None
    assert reference.execute("None", "stale ABC", "missing.wav", True).result == ("", None, False, False, False)
    assert reference.execute("ABC", pasted, "missing.wav", True).result == (pasted, None, True, False, True)
    assert "empty" in reference.validate_inputs("ABC", " \n", "missing.wav")
    assert reference.validate_inputs("Transcribe", pasted, "missing.wav") is not True
    cases = [
        ("song", False, False),
        ("audio-reference", True, False),
        ("audio-extend", True, True),
        ("abc-reference", False, False),
        ("abc-extend", False, True),
    ]
    for suffix, audio, extend in [(prefix + route, audio, extend) for prefix in ("", "instrumental-") for route, audio, extend in cases]:
        instrumental = suffix.startswith("instrumental-")
        route = suffix.removeprefix("instrumental-")
        data = json.loads((pack / "api" / f"yue2-kit-{suffix}.api.json").read_text())
        abc_link = data["11"]["inputs"]["abc"]
        prompt = {key: value for key, value in data.items() if key not in ("11", "22")}
        music_inputs = data["31:6"]["inputs"]
        prompt["capture"] = {"class_type": "TestCapture", "inputs": {
            "value": abc_link, "clip": music_inputs["clip"], "lyrics": music_inputs["lyrics"],
        }}
        # Both fresh planning and extension use the same CLIP and lyrics as music.
        for node in prompt.values():
            if node["class_type"] in ("YuE2GenerateABC", "bno84.YuE2ExtendABC"):
                assert node["inputs"]["clip"] == music_inputs["clip"]
                assert node["inputs"]["lyrics"] == music_inputs["lyrics"]
        assert data["31:9"]["inputs"]["model"] == ["34:4", 0]
        if "33" in prompt:
            prompt["33"]["inputs"]["abc"] = pasted
        installed = False
        lora_installed = False
        valid = asyncio.run(execution.validate_prompt(suffix, copy.deepcopy(prompt), None))
        assert valid[0] == (not audio and not instrumental), (suffix, valid)
        if instrumental:
            assert "lora_name" in str(valid), valid
            lora_installed = True
            valid = asyncio.run(execution.validate_prompt(suffix, copy.deepcopy(prompt), None))
            assert valid[0] == (not audio), (suffix, valid)
        else:
            assert not any(node["class_type"] == "LoraLoader" for node in prompt.values())
        if audio:
            assert "audio_encoder_name" in str(valid), valid
            installed = True
            prompt["33"]["inputs"]["audio"] = "reference.wav"
            valid = asyncio.run(execution.validate_prompt(suffix, prompt, None))
            assert valid[0], valid
        calls.clear()
        executor = execution.PromptExecutor(Mock(client_id=None), cache_args={"ram": 0, "ram_inactive": 0})
        executor.execute(prompt, suffix, execute_outputs=valid[2])
        assert executor.success, executor.status_messages
        expected = fresh if route == "song" else transcribed if audio else pasted
        score, clip, lyrics = Capture.values[-1]
        assert score == expected + ("EXTENDED\n" if extend else ""), (suffix, Capture.values)
        assert clip is (instrumental_clip if instrumental else base_clip), suffix
        expected_lyrics = "[instrumental]" if instrumental else data["32:2"]["inputs"]["value"]
        assert lyrics == expected_lyrics, (suffix, lyrics)
        assert calls.count("instrumental") == int(instrumental), (suffix, calls)
        assert calls.count("extend") == int(extend), (suffix, calls)
        assert calls.count("encoder") == int(audio), (suffix, calls)
        assert calls.count("audio") == int(audio), (suffix, calls)
        assert calls.count("transcribe") == int(audio), (suffix, calls)
        assert calls.count("fresh") == int(route == "song"), (suffix, calls)
        print(f"PASS {suffix}: {calls}")
print("All ten vocal/instrumental reference routes passed with native routing and mocked model execution.")
