"""Check opt-in FLAC player info: which comments a run states, and rewriting them safely."""

import importlib
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path

# flac_tags imports history as a sibling, so load both as one package.
package = types.ModuleType("flac_tags_test_pack")
package.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules[package.__name__] = package
flac_tags = importlib.import_module(package.__name__ + ".flac_tags")
history = importlib.import_module(package.__name__ + ".history")

ABC = "X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=158\nV: Vocal clef=treble\nK:Bm clef=treble\nV: Vocal\n[K:D] B4 d4 f4 b4|\n"
AUDIO = bytes(range(256)) * 4


def comment_block(comments, vendor=b"Lavf"):
    entries = [c.encode() for c in comments]
    return (struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", len(entries))
            + b"".join(struct.pack("<I", len(e)) + e for e in entries))


def flac(comments=None, padding=8):
    info = bytearray(34)
    # Sample rate 44100, mono, 16 bits, 44100 samples: one second.
    info[10:18] = ((44100 << 44) | (15 << 36) | 44100).to_bytes(8, "big")
    blocks = [(0, bytes(info))]
    if comments is not None:
        blocks.append((4, comment_block(comments)))
    blocks.append((1, bytes(padding)))
    out = bytearray(b"fLaC")
    for index, (kind, body) in enumerate(blocks):
        out.append(kind | (0x80 if index == len(blocks) - 1 else 0))
        out += len(body).to_bytes(3, "big") + body
    return bytes(out + AUDIO)


class MusicTagsTest(unittest.TestCase):
    def test_states_title_artist_style_lyrics_tempo_and_key(self):
        self.assertEqual(flac_tags.music_tags(ABC, title="Neon", artist=" bno84 ", style="warm piano pop, 158 BPM",
                                              lyrics="[verse]\nNeon fades"), {
            "TITLE": "Neon", "ARTIST": "bno84", "COMMENT": "warm piano pop, 158 BPM",
            "LYRICS": "[verse]\nNeon fades", "BPM": "158", "KEY": "Bm"})

    def test_an_instrumental_writes_its_section_tags_unless_turned_off(self):
        tags = dict(style="dark ambient", lyrics="[intro]\n[outro]", instrumental=True)
        self.assertEqual(flac_tags.music_tags(ABC, **tags)["LYRICS"], "[intro]\n[outro]")
        self.assertNotIn("LYRICS", flac_tags.music_tags(ABC, **tags, instrumental_lyrics=False))
        self.assertIn("LYRICS", flac_tags.music_tags(ABC, lyrics="[verse]\nsung", instrumental_lyrics=False))

    def test_unconnected_or_empty_inputs_are_left_out(self):
        self.assertEqual(flac_tags.music_tags("X:1\nQ:3/8=60\nK:none\n", title=" ", style=None, lyrics=""), {"BPM": "90"})
        self.assertEqual(flac_tags.music_tags("X:1\nK:C\nQ:1/4=99\n"), {"KEY": "C"})


class WriteTagsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "song.flac"

    def tearDown(self):
        self.folder.cleanup()

    def test_adds_and_replaces_comments_and_keeps_the_rest(self):
        self.path.write_bytes(flac(["prompt={}", "workflow={\"nodes\": []}", "bpm=1"]))
        flac_tags.write_tags(self.path, {"BPM": "158", "LYRICS": "Neon fades\nalong the lane"})
        seconds, tags = history.flac_info(self.path)
        self.assertEqual(seconds, 1.0)
        self.assertEqual(tags, {"prompt": "{}", "workflow": "{\"nodes\": []}", "bpm": "158", "lyrics": "Neon fades\nalong the lane"})
        data = self.path.read_bytes()
        self.assertTrue(data.endswith(AUDIO))
        self.assertEqual(list(Path(self.folder.name).iterdir()), [self.path])

    def test_keeps_the_file_permissions(self):
        self.path.write_bytes(flac([]))
        self.path.chmod(0o644)
        flac_tags.write_tags(self.path, {"KEY": "Bm"})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o644)

    def test_adds_a_comment_block_when_there_is_none(self):
        self.path.write_bytes(flac(None))
        flac_tags.write_tags(self.path, {"KEY": "Bm"})
        self.assertEqual(history.flac_info(self.path), (1.0, {"key": "Bm"}))
        self.assertTrue(self.path.read_bytes().endswith(AUDIO))

    def test_refuses_other_files_and_leaves_them_alone(self):
        self.path.write_bytes(b"RIFF" + AUDIO)
        with self.assertRaises(ValueError):
            flac_tags.write_tags(self.path, {"KEY": "Bm"})
        self.assertEqual(self.path.read_bytes(), b"RIFF" + AUDIO)


if __name__ == "__main__":
    unittest.main()
