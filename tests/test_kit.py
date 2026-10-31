"""Planning, saved songs, model files and the optional LoRA, without ComfyUI or weights."""

import importlib
import importlib.util
import json
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(f"yue2_{name}", ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


planning, history, model_files = load("planning"), load("history"), load("model_files")
HEADER = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble\nV: Ins clef=treble\nK:Em\n'
SCORE = HEADER + """% intro
V: Vocal
z16|z16|z16|z16|
V: Ins
e16|e16|e16|e16|
% verse
V: Vocal
e16|e16|e16|e16-|
V: Ins
b16|b16|b16|b16|
V: Vocal
e16|e16|e16|e16|
V: Ins
b16|b16|b16|b16|
% chorus
V: Vocal
M:3/4
Q:1/4=90
g12|g12|
V: Ins
M:3/4
d12|d12|
"""


def flac_bytes(seconds=2.5, rate=44100, tags=None):
    info = bytearray(34)
    samples = int(seconds * rate)
    # Sample rate (20 bits), channels-1 (3), bits-1 (5), total samples (36).
    packed = (rate << 44) | (1 << 41) | (15 << 36) | samples
    info[10:18] = packed.to_bytes(8, "big")
    vendor = b"test"
    comments = [f"{key}={value}".encode() for key, value in (tags or {}).items()]
    block = struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", len(comments))
    for comment in comments:
        block += struct.pack("<I", len(comment)) + comment
    return (b"fLaC" + bytes([0]) + len(info).to_bytes(3, "big") + bytes(info)
            + bytes([0x84]) + len(block).to_bytes(3, "big") + block)



class Clip:
    def __init__(self, lines=("[V:Vocal] D8 |\n",)):
        self.lines, self.requests = iter(lines), []

    def tokenize(self, style, **kwargs):
        self.request = {"style": style, **kwargs}
        return {"prefix": [999], "abc_ids": list(kwargs.get("abc", "").encode()), "cot": kwargs["cot"]}

    def generate(self, tokens, **kwargs):
        self.tokens = tokens
        self.requests.append(kwargs)
        return list(next(self.lines).encode())

    def decode(self, ids):
        return bytes(ids).decode()


class PlanningTests(unittest.TestCase):
    def test_continuation_keeps_the_prefix_and_checks_context_first(self):
        source = "X:1\nT:\nM:4/4\nL:1/8\nQ:1/4=88\nK:C\n[V:Vocal] C4 z4 |\n"
        clip = Clip()
        self.assertEqual(planning.extend_abc(clip, source, "pop", "words", 42, "full", 512),
                         source + "[V:Vocal] D8 |\n")
        self.assertEqual(clip.tokens["prefix"], [999] + list(source.encode()))
        with self.assertRaisesRegex(ValueError, "prompt.*new tokens"):
            planning.extend_abc(Clip(), "X" * 24570, "style", "lyrics", 1, "full", 512)
        with self.assertRaisesRegex(ValueError, "score needs about 4.8"):
            planning.check_music_context({"prefix": [0] * 10, "negative": [0] * 30, "abc_ids": [0] * 20}, 4.8, 10, context=100)

    def test_header_completion_keeps_one_valid_line_per_free_field(self):
        def validate(field, value):
            if value == "BAD":
                raise ValueError("invalid field syntax")
        clip = Clip(["BAD\n", "1/4=145\nK:wrong\n"])
        spec = [("X", "1"), ("M", "4/4"), ("L", "1/32"), ("Q", None), ("K", "D#m")]
        prefix, records = planning.complete_header(clip, "style", "lyrics", 42, "full", spec, validate, label="intro")
        self.assertEqual(prefix, "X:1\nM:4/4\nL:1/32\nQ:1/4=145\nK:D#m\n% intro\n")
        self.assertEqual(len(records[3]["attempts"]), 2)
        self.assertNotEqual(clip.requests[0]["seed"], clip.requests[1]["seed"])


class HistoryTests(unittest.TestCase):
    def test_sections_and_slices(self):
        summary = history.summary(history.parse_score(SCORE))
        self.assertEqual([(s["label"], s["bar"], s["bars"]) for s in summary["sections"]],
                         [("intro", 0, 4), ("verse", 4, 8), ("chorus", 12, 2)])
        self.assertAlmostEqual(summary["seconds"], 12 * 2 + 2 * 2)
        abc, warnings = history.slice_score(SCORE, 2, 3)
        self.assertEqual(abc, HEADER + "% verse\nV: Vocal\ne16|e16|e16|e16|\nV: Ins\nb16|b16|b16|b16|\n")
        self.assertEqual(warnings, ["A note is tied into bar 9 from before the selection."])
        self.assertIn("M:3/4\nL:1/16\nQ:1/4=90\n", history.slice_score(SCORE + "V: Vocal\ng12|\nV: Ins\nd12|\n", 4, 5)[0])

    def test_planner_spans_accepts_both_score_ids(self):
        for kind in ("bno84.YuE2Score", "bno84.YuE2AdvancedScore"):
            with self.subTest(kind=kind):
                prompt = {"score": dict(class_type=kind, inputs=dict(header_mode="locked",
                    anchor_use=True, anchor_abc=SCORE, anchor_start=1, anchor_end=0,
                    opening_generate=True, opening_bars=8))}
                spans = history.planner_spans(prompt, 26)
                self.assertEqual([(s["stage"], s["start"], s["end"]) for s in spans],
                                 [("Opening", 0, 8), ("Reference", 8, 22), ("Continuation", 22, 26)])

    def test_lists_saved_pairs_and_refuses_outside_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            songs = root / "audio" / "yue2"
            songs.mkdir(parents=True)
            prompt = {"32": {"class_type": "bno84.LyricsStyle", "inputs": {"lyrics": "[chorus]", "style": "dark rave"}},
                      "9": {"class_type": "Other", "inputs": {}, "is_changed": [float("nan")]}}
            (songs / "song_00001.flac").write_bytes(flac_bytes(tags={"prompt": json.dumps(prompt)}))
            (songs / "song_00001.abc").write_text(SCORE, encoding="utf-8")
            (songs / "lonely.flac").write_bytes(flac_bytes())
            found = history.SongIndex().list(root, "DARK")
            self.assertEqual([(s["name"], s["score"]["bars"]) for s in found["songs"]], [("song_00001", 14)])
            json.dumps(history.song_detail(root, "audio/yue2/song_00001.flac"), allow_nan=False)
            for path in ["../secret.flac", "/etc/passwd", "audio/yue2/lonely.flac"]:
                with self.assertRaises(ValueError):
                    history.resolve_song(root, path)


class ModelFileTests(unittest.TestCase):
    def test_lookup_and_template_models(self):
        lora = "ar_lora_inst_v3abc_comfyui.safetensors"
        self.assertEqual(model_files.resolve(lora, [f"loras/{lora}", lora]), lora)
        self.assertEqual(model_files.resolve(lora, ["other", f"loras/{lora}"]), f"loras/{lora}")
        self.assertIsNone(model_files.resolve(lora, []))
        template = json.loads((ROOT / "example_workflows" / "YuE2 Kit - Song workflow.json").read_text(encoding="utf-8"))
        self.assertEqual({m["label"] for m in model_files.workflow_models(template)}, {"YuE2 3B", "SheetSage2", "Instrumental LoRA"})

    def test_optional_lora_bypass_and_native_load(self):
        folders = types.SimpleNamespace(get_filename_list=Mock(return_value=["sub/test.safetensors"]),
                                        get_full_path_or_raise=Mock(return_value="/models/sub/test.safetensors"))
        native = types.SimpleNamespace(LoraLoaderModelOnly=Mock())
        safe = types.SimpleNamespace(safe_open=MagicMock())
        safe.safe_open.return_value.__enter__ = Mock(return_value=types.SimpleNamespace(keys=lambda: ["diffusion_model.x.lora_up.weight"]))
        safe.safe_open.return_value.__exit__ = Mock(return_value=False)
        package = types.ModuleType("lora_test_pack")
        package.__path__ = [str(ROOT)]
        with patch.dict(sys.modules, {"folder_paths": folders, "nodes": native, "safetensors": safe, package.__name__: package}):
            lora = importlib.import_module(package.__name__ + ".optional_lora")
            model, loaded = object(), object()
            self.assertIs(lora.load_optional_lora(model, "(none)", 1), model)
            native.LoraLoaderModelOnly.return_value.load_lora_model_only.return_value = (loaded,)
            self.assertIs(lora.load_optional_lora(model, "test.safetensors", -0.35), loaded)
            with self.assertRaisesRegex(ValueError, "not found"):
                lora.load_optional_lora(model, "missing.safetensors", 1)


if __name__ == "__main__":
    unittest.main()
