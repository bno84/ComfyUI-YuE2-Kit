"""Check saved-song listing, FLAC metadata and score slicing without ComfyUI."""

import importlib.util
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "yue2_history", Path(__file__).resolve().parents[1] / "history.py"
)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)

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


class ScoreTests(unittest.TestCase):
    def test_groups_follow_the_first_voice_and_section_labels(self):
        score = history.parse_score(SCORE)
        self.assertEqual([(g["label"], g["label_line"], g["bar"], g["first_bars"]) for g in score["groups"]], [
            ("intro", True, 0, 4), ("verse", True, 4, 4), ("verse", False, 8, 4), ("chorus", True, 12, 2),
        ])
        self.assertEqual(score["bars"], 14)
        self.assertTrue(score["groups"][1]["tie_out"])

    def test_summary_merges_groups_into_sections_with_nominal_seconds(self):
        summary = history.summary(history.parse_score(SCORE))
        self.assertEqual([(s["label"], s["bar"], s["bars"]) for s in summary["sections"]],
                         [("intro", 0, 4), ("verse", 4, 8), ("chorus", 12, 2)])
        # 12 bars of 4/4 at 120, then 2 bars of 3/4 at 90.
        self.assertAlmostEqual(summary["seconds"], 12 * 2 + 2 * 2)
        self.assertEqual(summary["fields"], {"M": "4/4", "L": "1/16", "Q": "1/4=120", "K": "Em"})

    def test_a_slice_repeats_the_section_label_and_keeps_both_voices(self):
        abc, warnings = history.slice_score(SCORE, 2, 3)
        self.assertEqual(abc, HEADER + "% verse\nV: Vocal\ne16|e16|e16|e16|\nV: Ins\nb16|b16|b16|b16|\n")
        self.assertEqual(warnings, ["A note is tied into bar 9 from before the selection."])

    def test_a_slice_carries_the_meter_and_tempo_in_effect(self):
        changed = SCORE + "V: Vocal\ng12|\nV: Ins\nd12|\n"
        abc, _ = history.slice_score(changed, 4, 5)
        self.assertIn("M:3/4\nL:1/16\nQ:1/4=90\n", abc)
        self.assertIn("% chorus\nV: Vocal\ng12|\n", abc)

    def test_warns_about_ties_leaving_and_voices_disagreeing(self):
        _, warnings = history.slice_score(SCORE, 1, 2)
        self.assertEqual(warnings, ["A note in bar 8 is tied past the selection."])
        uneven = HEADER + "% verse\nV: Vocal\ne16|e16|\nV: Ins\nb16|\n"
        self.assertEqual(history.slice_score(uneven, 0, 1)[1],
                         ["Voices cover different numbers of bars: Vocal 2, Ins 1."])

    def test_compressed_rests_count_as_bars(self):
        score = history.parse_score(HEADER + "V: Vocal\nZ4|z16|\nV: Ins\nZ5|\n")
        self.assertEqual(score["groups"][0]["bars"], {"Vocal": 5, "Ins": 5})

    def test_rejects_ranges_outside_the_score(self):
        for start, end in [(-1, 1), (2, 2), (0, 9)]:
            with self.assertRaises(ValueError):
                history.slice_score(SCORE, start, end)


class SongTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        songs = self.root / "audio" / "yue2"
        songs.mkdir(parents=True)
        prompt = {
            "3": {"class_type": "PrimitiveInt", "inputs": {"value": 42}},
            "32": {"class_type": "bno84.LyricsStyle",
                   "inputs": {"instrumental": True, "lyrics": "[intro]\n[chorus]", "style": "dark rave"}},
            "9": {"class_type": "Other", "inputs": {}, "is_changed": [float("nan")]},
        }
        for index, name in enumerate(["song_00001", "song_00002"]):
            (songs / f"{name}.flac").write_bytes(flac_bytes(tags={"prompt": json.dumps(prompt)}))
            (songs / f"{name}.abc").write_text(SCORE, encoding="utf-8")
            os.utime(songs / f"{name}.flac", (1000 + index, 1000 + index))
        (songs / "lonely.flac").write_bytes(flac_bytes())
        (self.root / "notes.abc").write_text(SCORE, encoding="utf-8")

    def tearDown(self):
        self.folder.cleanup()

    def test_reads_duration_and_comments(self):
        seconds, tags = history.flac_info(self.root / "audio/yue2/song_00001.flac")
        self.assertAlmostEqual(seconds, 2.5)
        self.assertIn("prompt", tags)

    def test_lists_only_pairs_newest_first_with_their_style(self):
        found = history.SongIndex().list(self.root)
        self.assertEqual(found["total"], 2)
        self.assertEqual([s["path"] for s in found["songs"]], ["audio/yue2/song_00002.flac", "audio/yue2/song_00001.flac"])
        self.assertEqual(found["songs"][0]["style"], "dark rave")
        self.assertEqual(found["songs"][0]["score"]["bars"], 14)

    def test_filters_by_name_style_or_lyrics_and_pages(self):
        index = history.SongIndex()
        self.assertEqual(index.list(self.root, "00001")["total"], 1)
        self.assertEqual(index.list(self.root, "DARK")["total"], 2)
        self.assertEqual(index.list(self.root, "[chorus]")["total"], 2)
        self.assertEqual(index.list(self.root, "polka")["total"], 0)
        page = index.list(self.root, offset=1, limit=1)
        self.assertEqual((page["total"], [s["name"] for s in page["songs"]]), (2, ["song_00001"]))

    def test_detail_replaces_nan_so_browsers_can_parse_it(self):
        detail = history.song_detail(self.root, "audio/yue2/song_00001.flac")
        self.assertEqual(detail["prompt"]["9"]["is_changed"], [None])
        json.loads(json.dumps(detail, allow_nan=False))
        self.assertEqual(detail["abc"], SCORE)

    def test_refuses_paths_outside_the_output_folder_or_without_a_score(self):
        for path in ["../secret.flac", "/etc/passwd", "audio/yue2/song_00001.abc", "audio/yue2/lonely.flac"]:
            with self.assertRaises(ValueError):
                history.resolve_song(self.root, path)


if __name__ == "__main__":
    unittest.main()
