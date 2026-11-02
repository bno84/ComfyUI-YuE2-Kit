"""Opt-in standard Vorbis comments for saved songs, which music players show.

ComfyUI's own comments (prompt, workflow) stay as they are; these are added
beside them. Writing them rewrites the file's metadata, not its audio.

Kept free of ComfyUI imports so it can be tested on its own.
"""

import os
import stat
import struct
import tempfile
from pathlib import Path

from .history import FIELD, lyrics_style, tempo

MAX_BLOCK = (1 << 24) - 1
VORBIS_COMMENT = 4


def score_fields(abc):
    """The first Q: and K: in the header; K: ends an ABC header."""
    fields = {}
    for line in abc.splitlines():
        field = FIELD.match(line.strip())
        if not field:
            continue
        if field[1] in "QK":
            fields.setdefault(field[1], field[2].strip())
        if field[1] == "K":
            break
    return fields


def music_tags(prompt, abc, artist="", title="", instrumental_lyrics=True):
    """TITLE, ARTIST, COMMENT (the style), LYRICS, BPM and KEY that this run can state; others are left out.

    COMMENT rather than DESCRIPTION: KDE's file metadata, and so Elisa, reads
    only COMMENT, while VLC and TagLib read either. An instrumental's lyrics
    are its section tags; ``instrumental_lyrics`` writes them too.
    BPM counts quarter notes, as YuE2 styles do.
    """
    found = lyrics_style(prompt)
    tags = {}
    for name, value in (("TITLE", title), ("ARTIST", artist)):
        if value.strip():
            tags[name] = value.strip()
    if found["style"].strip():
        tags["COMMENT"] = found["style"].strip()
    if found["lyrics"].strip() and (instrumental_lyrics or not found["instrumental"]):
        tags["LYRICS"] = found["lyrics"].strip()
    fields = score_fields(abc)
    bpm = tempo(fields.get("Q", ""))
    if bpm:
        tags["BPM"] = str(round(bpm))
    key = fields.get("K", "").split()
    if key and key[0].lower() != "none":
        tags["KEY"] = key[0]
    return tags


def _blocks(data):
    if data[:4] != b"fLaC":
        raise ValueError("Not a FLAC file.")
    offset, blocks = 4, []
    while True:
        if offset + 4 > len(data):
            raise ValueError("The FLAC metadata is truncated.")
        header = data[offset]
        size = int.from_bytes(data[offset + 1:offset + 4], "big")
        blocks.append([header & 0x7F, data[offset + 4:offset + 4 + size]])
        offset += 4 + size
        if header & 0x80:
            return blocks, data[offset:]


def _comments(block):
    (length,) = struct.unpack_from("<I", block, 0)
    vendor = block[4:4 + length]
    offset = 4 + length
    (count,) = struct.unpack_from("<I", block, offset)
    offset += 4
    comments = []
    for _ in range(count):
        (length,) = struct.unpack_from("<I", block, offset)
        comments.append(block[offset + 4:offset + 4 + length])
        offset += 4 + length
    return vendor, comments


def write_tags(path, tags):
    """Set ``tags`` as Vorbis comments, replacing comments with the same names and keeping the rest."""
    path = Path(path)
    mode = stat.S_IMODE(path.stat().st_mode)
    blocks, audio = _blocks(path.read_bytes())
    found = next((block for block in blocks if block[0] == VORBIS_COMMENT), None)
    if found is None:
        found = [VORBIS_COMMENT, struct.pack("<II", 0, 0)]
        blocks.insert(1, found)
    vendor, comments = _comments(found[1])
    names = {name.upper() for name in tags}
    kept = [c for c in comments if c.partition(b"=")[0].decode("utf-8", "replace").upper() not in names]
    added = [f"{name}={value}".encode("utf-8") for name, value in tags.items()]
    entries = kept + added
    found[1] = (struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", len(entries))
                + b"".join(struct.pack("<I", len(entry)) + entry for entry in entries))
    if len(found[1]) > MAX_BLOCK:
        raise ValueError("The FLAC comments would exceed a metadata block.")
    out = bytearray(b"fLaC")
    for index, (kind, body) in enumerate(blocks):
        out.append(kind | (0x80 if index == len(blocks) - 1 else 0))
        out += len(body).to_bytes(3, "big") + body
    out += audio
    # Replace the file in one step, so an interrupted write leaves the original.
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(out)
        # mkstemp creates the file owner-only; keep the original's permissions.
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
