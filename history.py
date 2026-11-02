"""Saved songs: FLAC files, their embedded run settings and scores, and score slices.

ComfyUI embeds the executed prompt and the workflow in the FLAC's Vorbis
comments, so a song can restore the seed, lyrics and style that made it.
Save YuE2 FLAC + ABC records the score in that workflow and also writes it
next to the audio under the same name. The embedded score comes first; the
.abc file is the fallback for songs saved before scores were embedded.

The score is split into groups, the blocks YuE2 writes: each starts at the
first voice's ``V:`` line and holds up to four bars of every voice. A slice
keeps whole groups, so both voices stay aligned.

Kept free of ComfyUI imports so it can be tested on its own.
"""

import json
import math
import os
import re
import struct
from fractions import Fraction
from pathlib import Path

from .saved_score import workflow_abc

FIELD = re.compile(r"^([A-Za-z]):(.*)$")
INLINE_FIELD = re.compile(r"\[([A-Za-z]):([^\]]*)\]")
TEMPO = re.compile(r"(?:(\d+)/(\d+)\s*=\s*)?(\d+(?:\.\d+)?)")
BAR_LINE = re.compile(r"::|:?\|+\]?:?|\[\|")
REST_BARS = re.compile(r"^Z(\d*)$")
# A tie on the last note of a line continues into the next group.
TIE_OUT = re.compile(r"-\s*(?:[:|\]]+\s*)?$")
STATE_FIELDS = ("M", "L", "Q", "K")
DEFAULT_TEMPO = 120
# Audio drifts from the score by seconds; across 158 saved songs, by at most
# 4.8. A larger shortfall means the render stopped early, at its maximum
# duration. The smallest such cut seen was 7.7 seconds short.
CUT_MARGIN = 6.0


def flac_info(path):
    """Duration in seconds and Vorbis comments (lowercase keys) of a FLAC file."""
    seconds, tags = None, {}
    with open(path, "rb") as handle:
        if handle.read(4) != b"fLaC":
            raise ValueError(f"{path} is not a FLAC file.")
        last = False
        while not last:
            header = handle.read(4)
            if len(header) < 4:
                break
            last, kind = header[0] & 0x80, header[0] & 0x7F
            size = int.from_bytes(header[1:], "big")
            if kind == 0:
                info = handle.read(size)
                rate = int.from_bytes(info[10:13], "big") >> 4
                samples = int.from_bytes(info[13:18], "big") & 0xFFFFFFFFF
                seconds = samples / rate if rate and samples else None
            elif kind == 4:
                tags = vorbis_comments(handle.read(size))
            else:
                handle.seek(size, os.SEEK_CUR)
    return seconds, tags


def vorbis_comments(data):
    (vendor,) = struct.unpack_from("<I", data, 0)
    offset = 4 + vendor
    (count,) = struct.unpack_from("<I", data, offset)
    offset += 4
    tags = {}
    for _ in range(count):
        (length,) = struct.unpack_from("<I", data, offset)
        offset += 4
        key, _, value = data[offset:offset + length].decode("utf-8", "replace").partition("=")
        tags[key.lower()] = value
        offset += length
    return tags


def finite(value):
    """JSON for browsers: NaN and infinities, which Python writes, become null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: finite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [finite(item) for item in value]
    return value


def embedded_prompt(tags):
    try:
        prompt = json.loads(tags.get("prompt") or "null")
    except json.JSONDecodeError:
        return None
    return finite(prompt) if isinstance(prompt, dict) else None


def embedded_workflow(tags):
    try:
        workflow = json.loads(tags.get("workflow") or "null")
    except json.JSONDecodeError:
        return None
    return workflow if isinstance(workflow, dict) else None


def read_song(flac):
    """Duration, comments and score of a saved song; ValueError when it has no score.

    ``score_source`` is "embedded" or "file". ``score_differs`` flags a .abc
    file that no longer matches the embedded score, such as after an edit.
    """
    seconds, tags = flac_info(flac)
    sidecar = flac.with_suffix(".abc")
    file_abc = sidecar.read_text(encoding="utf-8", errors="replace") if sidecar.is_file() else None
    embedded = workflow_abc(embedded_workflow(tags))
    if embedded is not None:
        abc, source = embedded, "embedded"
    elif file_abc is not None:
        abc, source = file_abc, "file"
    else:
        raise ValueError(f"{flac.name} has no saved score.")
    return {"seconds": seconds, "tags": tags, "abc": abc, "score_source": source,
            "score_differs": embedded is not None and file_abc is not None and file_abc != embedded}


def lyrics_style(prompt):
    """The run's lyrics, style and instrumental flag, from Lyrics + style or the first node with them.

    Lyrics + style keeps a Base and an Instrumental pair; the flag picks the one the run used.
    """
    nodes = sorted((prompt or {}).values(), key=lambda node: node.get("class_type") != "bno84.LyricsStyle")
    for node in nodes:
        inputs = node.get("inputs", {})
        instrumental = inputs.get("instrumental") if isinstance(inputs.get("instrumental"), bool) else None
        prefix = "instrumental_" if instrumental and node.get("class_type") == "bno84.LyricsStyle" and "instrumental_lyrics" in inputs else ""
        lyrics, style = inputs.get(prefix + "lyrics"), inputs.get(prefix + "style")
        if isinstance(lyrics, str) or isinstance(style, str):
            return {
                "lyrics": lyrics if isinstance(lyrics, str) else "",
                "style": style if isinstance(style, str) else "",
                "instrumental": instrumental,
            }
    return {"lyrics": "", "style": "", "instrumental": None}


SEED_INPUTS = ("seed", "noise_seed")
# Score planning runs first, so its seed is where a song starts.
SEED_ORDER = ("bno84.YuE2AdvancedScore", "YuE2GenerateABC", "bno84.YuE2ExtendABC", "YuE2GenerateMusic")


def first_seed(prompt):
    """The seed a song started from: the value typed in at the root of the first sampler's seed link.

    Links are followed through primitives and through nodes that pass a seed
    on, such as YuE2 Advanced Score. A seed computed by any other node is not
    a value someone typed in, so it is not used. None when there is none.
    """
    prompt = prompt or {}

    def root(value, depth=0):
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if not (isinstance(value, list) and len(value) == 2) or depth > 32:
            return None
        inputs = (prompt.get(str(value[0])) or {}).get("inputs", {})
        for name in ("value", *SEED_INPUTS):
            if name in inputs:
                return root(inputs[name], depth + 1)
        return None

    def order(item):
        kind = item[1].get("class_type")
        return SEED_ORDER.index(kind) if kind in SEED_ORDER else len(SEED_ORDER)

    for _, node in sorted(prompt.items(), key=order):
        for name in SEED_INPUTS:
            if name in node.get("inputs", {}):
                seed = root(node["inputs"][name])
                if seed is not None:
                    return seed
    return None


def player_info(prompt):
    """FLAC title and artist typed into Save YuE2 FLAC + ABC; empty when not set or linked."""
    for node in (prompt or {}).values():
        if node.get("class_type") == "bno84.SaveYuE2Bundle":
            inputs = node.get("inputs", {})
            text = lambda name: inputs[name].strip() if isinstance(inputs.get(name), str) else ""
            return {"title": text("flac_title"), "artist": text("flac_artist")}
    return {"title": "", "artist": ""}


def meter(value, current):
    value = value.strip()
    if value in ("C", "C|"):
        return Fraction(1)
    try:
        top, bottom = value.split("/")
        return Fraction(int(top), int(bottom))
    except ValueError:
        return current


def tempo(value):
    """Quarter notes per minute, or None. ``Q:3/8=60`` is 90."""
    match = TEMPO.search(value)
    if not match:
        return None
    beat = Fraction(int(match[1]), int(match[2])) if match[1] else Fraction(1, 4)
    return float(match[3]) * float(beat) * 4


def count_bars(music):
    music = re.sub(r'"[^"]*"|![^!]*!', "", music.split("%")[0])
    music = INLINE_FIELD.sub("", music)
    bars = 0
    for part in BAR_LINE.split(music):
        part = part.strip()
        if part:
            rest = REST_BARS.match(part)
            bars += int(rest[1] or 1) if rest else 1
    return bars


def parse_score(abc):
    """Split a score into its header and groups.

    Each group records its section label (set only where a ``% label`` line
    starts a section), its bars per voice, nominal seconds, whether its last
    note ties onward, and the header fields in effect before it.
    """
    lines = (abc or "").splitlines()
    header, body = [], []
    for index, line in enumerate(lines):
        header.append(line)
        if line.startswith("K:"):
            body = lines[index + 1:]
            break
    else:
        header, body = [], lines

    state = {"M": "4/4", "L": "1/8", "Q": "", "K": ""}
    voices = []
    for line in header:
        field = FIELD.match(line)
        if not field:
            continue
        name, value = field[1], field[2].strip()
        if name == "V":
            voices.append(value.split()[0] if value.split() else "")
        elif name in STATE_FIELDS:
            state[name] = value
    first = voices[0] if voices else None

    groups, voice, section = [], first, ""

    def start_group(label_line):
        groups.append({
            "label": section, "label_line": label_line, "lines": [], "bars": {}, "tie_out": False,
            "state": dict(state), "seconds": 0.0,
        })

    pending = None
    for raw in body:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("%") and not line.startswith("%%"):
            pending = line.lstrip("%").strip()
            continue
        field = FIELD.match(line)
        if field and field[1] == "V":
            voice = field[2].split()[0] if field[2].split() else ""
            if first is None:
                first = voice
            if voice == first or not groups:
                if pending is not None:
                    section, pending = pending, None
                    start_group(True)
                else:
                    start_group(False)
            groups[-1]["lines"].append(raw)
            continue
        if not groups:
            labelled = pending is not None
            if labelled:
                section, pending = pending, None
            start_group(labelled)
        group = groups[-1]
        group["lines"].append(raw)
        if field:
            if voice in (None, first) and field[1] in STATE_FIELDS:
                state[field[1]] = field[2].strip()
            continue
        if line.startswith("%%"):
            continue
        if voice in (None, first):
            for inline in INLINE_FIELD.finditer(line):
                if inline[1] in STATE_FIELDS:
                    state[inline[1]] = inline[2].strip()
        bars = count_bars(line)
        group["bars"][voice or ""] = group["bars"].get(voice or "", 0) + bars
        if TIE_OUT.search(line.split("%")[0]):
            group["tie_out"] = True
        if voice in (None, first):
            beats = (tempo(state["Q"]) or DEFAULT_TEMPO)
            group["seconds"] += bars * float(meter(state["M"], Fraction(1))) * 4 * 60 / beats

    start_bar = 0
    for group in groups:
        group["bar"] = start_bar
        group["first_bars"] = group["bars"].get(first or "", max(group["bars"].values(), default=0))
        start_bar += group["first_bars"]
    return {"header": header, "voices": voices, "groups": groups, "bars": start_bar}


def audio_end_bar(groups, audio_seconds):
    """The nominal bar where audio stops, when it stops well before the score; else None."""
    total = sum(group["seconds"] for group in groups)
    if audio_seconds is None or total - audio_seconds <= CUT_MARGIN:
        return None
    elapsed = 0.0
    for group in groups:
        if group["seconds"] and elapsed + group["seconds"] >= audio_seconds:
            return round(group["bar"] + group["first_bars"] * (audio_seconds - elapsed) / group["seconds"], 2)
        elapsed += group["seconds"]
    return None


def summary(score, audio_seconds=None):
    """Groups and sections without the raw lines, for the browser.

    ``audio_end_bar`` marks where the audio stops when the render was cut short.
    ``audio_extra_seconds`` flags audio substantially longer than the score.
    """
    groups = [{
        "label": g["label"], "starts_section": g["label_line"], "bar": g["bar"], "bars": g["first_bars"],
        "seconds": round(g["seconds"], 3),
    } for g in score["groups"]]
    sections = []
    for group in groups:
        if group["starts_section"] or not sections:
            sections.append({"label": group["label"], "bar": group["bar"], "bars": 0})
        sections[-1]["bars"] += group["bars"]
    score_seconds = sum(g["seconds"] for g in score["groups"])
    extra_seconds = None if audio_seconds is None else audio_seconds - score_seconds
    fields = {}
    for line in score["header"]:
        field = FIELD.match(line)
        if field and field[1] in ("M", "Q", "K", "L"):
            fields[field[1]] = field[2].strip()
    return {
        "bars": score["bars"], "seconds": round(score_seconds, 3),
        "groups": groups, "sections": [s for s in sections if s["bars"]], "fields": fields,
        "audio_end_bar": audio_end_bar(score["groups"], audio_seconds),
        "audio_extra_seconds": round(extra_seconds, 3) if extra_seconds is not None and extra_seconds > CUT_MARGIN else None,
    }


def score_label(abc):
    """A one-line summary in ABC Timeline's style, such as "12 bars · 158 BPM · 4/4 · Bm"."""
    found = summary(parse_score(abc))
    fields, bars = found["fields"], found["bars"]
    bpm = tempo(fields.get("Q", ""))
    key = fields.get("K", "").split()
    return " · ".join(part for part in (
        f"{bars} bar{'' if bars == 1 else 's'}",
        f"{bpm:g} BPM" if bpm else f"{DEFAULT_TEMPO} BPM (assumed)",
        fields.get("M", ""), key[0] if key else "",
    ) if part)


def slice_score(abc, start, end):
    """The score's groups ``start`` up to ``end`` (exclusive) as a complete ABC.

    The header carries the meter, unit, tempo and key in effect at the cut.
    The opening group repeats its section label. Returns the ABC and warnings.
    """
    score = parse_score(abc)
    groups = score["groups"]
    if not 0 <= start < end <= len(groups):
        raise ValueError(f"Choose groups between 0 and {len(groups)}.")
    state = groups[start]["state"]
    header = []
    for line in score["header"]:
        field = FIELD.match(line)
        if field and field[1] in STATE_FIELDS and state.get(field[1]):
            line = f"{field[1]}:{state[field[1]]}"
        header.append(line)
    for name in ("Q",):
        if state.get(name) and not any(line.startswith(f"{name}:") for line in header):
            header.insert(len(header) - 1 if header and header[-1].startswith("K:") else len(header), f"{name}:{state[name]}")

    body = []
    for index in range(start, end):
        group = groups[index]
        if group["label"] and (index == start or group["label_line"]):
            body.append(f"% {group['label']}")
        body.extend(group["lines"])

    warnings = []
    first_bar, last_bar = groups[start]["bar"] + 1, groups[end - 1]["bar"] + groups[end - 1]["first_bars"]
    if start > 0 and groups[start - 1]["tie_out"]:
        warnings.append(f"A note is tied into bar {first_bar} from before the selection.")
    if end < len(groups) and groups[end - 1]["tie_out"]:
        warnings.append(f"A note in bar {last_bar} is tied past the selection.")
    totals = {}
    for group in groups[start:end]:
        for voice, bars in group["bars"].items():
            totals[voice] = totals.get(voice, 0) + bars
    if len(set(totals.values())) > 1:
        warnings.append("Voices cover different numbers of bars: "
                        + ", ".join(f"{voice or 'unnamed'} {bars}" for voice, bars in totals.items()) + ".")
    return "\n".join(header + body) + "\n", warnings


def find_songs(root):
    """FLAC files under the output folder; SongIndex skips those without a score."""
    return [Path(folder) / name for folder, _, files in os.walk(root) for name in files if name.endswith(".flac")]


def planner_spans(prompt, total):
    """Saved stage boundaries from public widgets, with no generation/model work."""
    def value(node, name, default=None):
        result = node.get("inputs", {}).get(name, default)
        seen = set()
        while isinstance(result, list) and len(result) == 2:
            key = str(result[0])
            if key in seen:
                return default
            seen.add(key)
            upstream = (prompt or {}).get(key, {})
            inputs = upstream.get("inputs", {})
            result = inputs.get(name, inputs.get("value"))
        return result
    for node in (prompt or {}).values():
        if node.get("class_type") != "bno84.YuE2AdvancedScore":
            continue
        if not value(node, "anchor_use", False):
            return [dict(stage="Song", start=0, end=total, color="#456185")]
        source = value(node, "anchor_abc", "")
        if not isinstance(source, str) or not source.strip():
            return []
        try:
            count = parse_score(source)["bars"]
            if not count:
                return []
            start = int(value(node, "anchor_start", 1))
            end = int(value(node, "anchor_end", 0)) or count
            opening = min(total, int(value(node, "opening_bars", 0))) if value(node, "opening_generate", False) else 0
            anchor = max(0, min(total-opening, end-start+1))
        except (ValueError, TypeError):
            return []  # An unresolved source cannot justify a made-up boundary.
        return [dict(stage=stage, start=a, end=b, color=color) for stage,a,b,color in (
            ("Opening",0,opening,"#7165ac"),("Reference",opening,opening+anchor,"#287d66"),
            ("Continuation",opening+anchor,total,"#456185")) if b>a]
    return []


def _stat_key(path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_mtime_ns, stat.st_size


class SongIndex:
    """Song summaries, cached until the FLAC or ABC file changes.

    A FLAC without a score is cached as None, so other audio is read only once.
    """

    def __init__(self):
        self.cache = {}

    def entry(self, root, flac):
        key = _stat_key(flac), _stat_key(flac.with_suffix(".abc"))
        cached = self.cache.get(flac)
        if cached and cached[0] == key:
            return cached[1]
        try:
            song = read_song(flac)
        except ValueError:
            self.cache[flac] = (key, None)
            return None
        prompt = embedded_prompt(song["tags"])
        score = summary(parse_score(song["abc"]), song["seconds"])
        score["planner_spans"] = planner_spans(prompt, score["bars"])
        relative = flac.relative_to(root).as_posix()
        entry = {
            "path": relative, "name": flac.stem, "mtime": flac.stat().st_mtime, "seconds": song["seconds"],
            "has_prompt": prompt is not None, **lyrics_style(prompt),
            "score_source": song["score_source"], "score_differs": song["score_differs"],
            "score": {k: score[k] for k in ("bars", "seconds", "sections", "fields", "audio_end_bar", "audio_extra_seconds", "planner_spans")},
        }
        self.cache[flac] = (key, entry)
        return entry

    def list(self, root, query="", offset=0, limit=20):
        root = Path(root)
        songs = find_songs(root)
        entries = []
        for flac in songs:
            try:
                entry = self.entry(root, flac)
            except (OSError, ValueError):
                continue
            if entry is not None:
                entries.append(entry)
        live = set(songs)
        for stale in [path for path in self.cache if path not in live]:
            del self.cache[stale]
        query = query.strip().lower()
        if query:
            entries = [e for e in entries if query in f"{e['path']}\n{e['style']}\n{e['lyrics']}".lower()]
        entries.sort(key=lambda e: (e["mtime"], e["path"]), reverse=True)
        return {"total": len(entries), "songs": entries[offset:offset + limit]}


def resolve_song(root, relative):
    """The FLAC and its read song for a path relative to the output folder."""
    root = Path(root).resolve()
    flac = (root / relative).resolve()
    if root not in flac.parents or flac.suffix != ".flac":
        raise ValueError("Unknown song.")
    if not flac.is_file():
        raise ValueError("This song's FLAC file is missing.")
    return flac, read_song(flac)


def embedded_song(path):
    """A FLAC's comments and the score its workflow embeds; ValueError without one.

    Only what the file carries counts, wherever it came from: no .abc file beside it is read.
    """
    name = Path(path).name
    try:
        _, tags = flac_info(path)
    except ValueError:
        raise ValueError(f"{name} is not a FLAC file.") from None
    abc = workflow_abc(embedded_workflow(tags))
    if abc is None:
        raise ValueError(f"{name} has no embedded YuE2-Kit score.")
    return tags, abc


def song_detail(root, relative):
    flac, song = resolve_song(root, relative)
    facts = summary(parse_score(song["abc"]), song["seconds"])
    prompt = embedded_prompt(song["tags"])
    facts["planner_spans"] = planner_spans(prompt, facts["bars"])
    return {
        "path": flac.relative_to(Path(root).resolve()).as_posix(), "name": flac.stem, "seconds": song["seconds"],
        "abc": song["abc"], "score_source": song["score_source"], "score_differs": song["score_differs"],
        "score": facts, "prompt": prompt,
    }
