"""Versioned Score plans and deterministic stage inputs, without ComfyUI imports."""

import copy
import hashlib
import json
import math
import re
from fractions import Fraction

from .history import meter, tempo

from . import splice

VERSION = 1
UINT64 = (1 << 64) - 1


def default_plan(source=False):
    return dict(version=VERSION, source=dict(kind="none", abc=""),
                anchor=dict(start=0, end=None),
                opening=dict(bars=0, label="intro", attempts=4, max_tokens=0),
                continuation=dict(enabled=True, max_tokens=8192),
                header={name: dict(policy="anchor" if source else "free", value=value)
                        for name, value in (("tempo", 120), ("meter", "4/4"), ("key", "C"))})


# Public widget contract; plans below are private stage configuration.
KEYS = {f"{note} {kind}": note + suffix
        for kind, suffix in (("major", ""), ("minor", "m"))
        for note in ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B")}
OPENING_TOKENS_MIN = 256
WIDGET_DEFAULTS = dict(header_mode="generated", header_tempo=120, header_meter="4/4", header_key="C major", header_unit="1/16",
    opening_generate=False, opening_bars=8, opening_hint="intro", opening_candidates=4,
    anchor_use=False, anchor_abc="", anchor_start=1, anchor_end=0,
    continue_generate=True, mode="full", temperature=0.7, top_p=0.9,
    top_k=30, repetition_penalty=1.005, penalty_window=100, opening_tokens=1024, continuation_tokens=8192)


def widgets_to_plan(values):
    """Validate public scalar values before requesting any lazy model input.

    Range storage is one-based inclusive; end=0 means through the source end.
    Disabled groups retain values, but have no effect on execution.
    """
    v = {**WIDGET_DEFAULTS, **values}
    for name in ("anchor_use", "opening_generate", "continue_generate"):
        if type(v[name]) is not bool:
            raise ValueError(f"{name} must be boolean.")
    enabled = v["anchor_use"]
    plan = default_plan(enabled)
    if enabled:
        plan["source"].update(kind="abc", abc=v["anchor_abc"])
        plan["anchor"].update(start=integer(v["anchor_start"], 1, 1000000, "Reference start") - 1,
            end=integer(v["anchor_end"], 0, 1000000, "Reference end") or None)
    plan["opening"].update(bars=v["opening_bars"] if enabled and v["opening_generate"] else 0,
        label=v["opening_hint"] if enabled and v["opening_generate"] else "",
        attempts=v["opening_candidates"] if enabled and v["opening_generate"] else 1,
        max_tokens=v["opening_tokens"] if enabled and v["opening_generate"] else 0)
    plan["continuation"].update(enabled=v["continue_generate"] if enabled else True,
        max_tokens=v["continuation_tokens"] if plan["continuation"]["enabled"] else 0)
    mode = {"locked": "fixed", "reference": "from anchor", "from reference": "from anchor"}.get(v["header_mode"], v["header_mode"])
    if mode not in ("generated", "fixed", "from anchor"):
        raise ValueError("Unknown Score properties mode.")
    if mode == "from anchor" and not enabled:
        raise ValueError("Reference score properties require Reference use.")
    source = resolve_source(plan)
    anchor = cut_anchor(source, plan["anchor"])[0] if source is not None else None
    if mode == "fixed":
        plan["header"]["tempo"] = dict(policy="set", value=v["header_tempo"])
        if anchor is not None:
            state = anchor.bars[anchor.voices[0]][0].state
            for name, value in (("meter", state["M"]), ("key", state["K"]),
                                ("unit", anchor.field("L") or str(note_unit(anchor)))):
                plan["header"][name] = dict(policy="anchor", value=value)
        else:
            key = KEYS.get(v["header_key"])
            if key is None:
                raise ValueError("Key must be a named major or minor key.")
            unit = single_line(v["header_unit"], "Unit note length", False)
            normalize_field("L", unit)
            for name, value in (("meter", v["header_meter"]), ("key", key), ("unit", unit)):
                plan["header"][name] = dict(policy="set", value=value)
    elif mode == "generated":
        for name in ("tempo", "key"):
            plan["header"][name]["policy"] = "free"
        # Meter and voice/unit declarations remain joinable with fixed material.
    plan["sampling"] = sampling_from({name: v[name] for name in
        ("temperature", "top_p", "top_k", "repetition_penalty", "penalty_window")})
    return plan_from(plan)


def integer(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}.")
    return int(value)


def single_line(value, name, empty=True):
    if not isinstance(value, str) or any(c in value for c in "\r\n") or (not empty and not value.strip()):
        raise ValueError(f"{name} must be single-line text.")
    return value.strip()


def plan_from(value):
    """Validate a complete v1 plan; return a canonical independent copy."""
    try:
        plan = json.loads(value) if isinstance(value, str) else copy.deepcopy(value)
        # Also rejects nonfinite numbers anywhere.
        json.dumps(plan, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid Score plan JSON.") from error
    if not isinstance(plan, dict) or type(plan.get("version")) is not int or plan["version"] != VERSION:
        raise ValueError("Unsupported Score plan version.")
    try:
        source, anchor, opening, continuation, header = (plan[k] for k in ("source", "anchor", "opening", "continuation", "header"))
        if not all(isinstance(item, dict) for item in (source, anchor, opening, continuation, header)):
            raise ValueError("Plan sections must be objects.")
        if source["kind"] not in ("none", "abc") or not isinstance(source["abc"], str):
            raise ValueError("Invalid source.")
        has_source = source["kind"] != "none"
        anchor["start"] = integer(anchor["start"], 0, 1000000, "Reference start")
        if anchor["end"] is not None:
            anchor["end"] = integer(anchor["end"], anchor["start"] + 1, 1000000, "Reference end")
        for key, low, high in (("bars", 0, 256), ("attempts", 1, 16), ("max_tokens", 0, 20000)):
            opening[key] = integer(opening[key], low, high, "Opening " + key)
        if opening["bars"] and opening["max_tokens"] < OPENING_TOKENS_MIN:
            raise ValueError(f"Opening token budget must be at least {OPENING_TOKENS_MIN}.")
        opening["label"] = single_line(opening["label"], "Opening label")
        if type(continuation["enabled"]) is not bool:
            raise ValueError("Continuation enabled must be boolean.")
        continuation["max_tokens"] = integer(continuation["max_tokens"], 0, 20000, "Continuation budget")
        if not has_source and not continuation["enabled"]:
            raise ValueError("Source none requires whole-score generation.")
        header.setdefault("unit", dict(policy="anchor" if has_source else
            "set" if header["meter"]["policy"] == "set" else "free", value="1/16"))
        for name in ("tempo", "meter", "key", "unit"):
            field = header[name]
            allowed = (("anchor", "set") if name == "unit" else ("anchor", "set", "free") if name == "tempo" else ("anchor", "free") if name == "key" else ("anchor",)) if has_source else ("set", "free")
            if not isinstance(field, dict) or field["policy"] not in allowed:
                raise ValueError(f"Invalid {name} policy for this source.")
            value = field["value"]
            if name == "tempo":
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 1000:
                    raise ValueError("Tempo must be finite and between 0 and 1000.")
                field["value"] = int(value) if int(value) == value else value
            else:
                field["value"] = single_line(value, name, False)
                normalize_field({"meter": "M", "key": "K", "unit": "L"}[name], field["value"])
    except (KeyError, TypeError) as error:
        raise ValueError("Incomplete Score plan.") from error
    if has_source and opening["bars"] == 0:
        for name in ("tempo", "key"):
            if header[name]["policy"] == "free":
                raise ValueError(f"Free {name} needs an opening.")
    return plan


def derive_seed(base, stage, candidate=0):
    base = integer(base, 0, UINT64, "Seed")
    candidate = integer(candidate, 0, UINT64, "Candidate index")
    if stage not in ("fresh", "opening", "continuation"):
        raise ValueError("Unknown Score seed stage.")
    text = f"yue2-score/v1:{base}:{stage}:{candidate}"
    return int.from_bytes(hashlib.blake2b(text.encode("ascii"), digest_size=8).digest(), "big")


def resolve_source(plan):
    source = plan["source"]
    result = source["abc"] if source["kind"] != "none" else None
    if result is not None and (not isinstance(result, str) or not result.strip()):
        raise ValueError("Reference ABC is empty; paste or drop a score, or drop audio to transcribe.")
    return result


def cut_anchor(abc, anchor):
    source = splice.parse(abc)
    validate_score(source)
    return splice.cut(source, anchor["start"], source.length if anchor["end"] is None else anchor["end"])


def normalize_field(name, value):
    """Compare musical values while keeping their spelling in the score."""
    if name == "Q":
        if not value:
            return 120.0
        try:
            bpm = tempo(value)
        except (ValueError, ZeroDivisionError):
            bpm = None
        if bpm is None or not math.isfinite(bpm) or bpm <= 0:
            raise ValueError(f"Unsupported tempo Q:{value}.")
        return bpm
    if name in ("M", "L"):
        if name == "M" and value in ("C", "C|"):
            return Fraction(1)
        try:
            if not re.fullmatch(r"[1-9][0-9]*/[1-9][0-9]*", value):
                raise ValueError()
            return Fraction(value)
        except (ValueError, ZeroDivisionError):
            raise ValueError(f"Unsupported {name}:{value}.") from None
    match = re.fullmatch(r"([A-G])([#b]?)(m|min|minor|maj|major)?", value.strip())
    if not match:
        raise ValueError(f"Unsupported key K:{value}.")
    return match[1] + match[2] + ("m" if match[3] in ("m", "min", "minor") else "")


def note_unit(score):
    value = score.field("L")
    return normalize_field("L", value) if value else splice.note_unit(score)


def validate_score(score):
    splice.aligned(score)
    if not score.length:
        raise ValueError("The score has no bars.")
    note_unit(score)
    for index in range(score.length):
        states = [{name: normalize_field(name, score.bars[voice][index].state[name]) for name in splice.STATE_FIELDS}
                  for voice in score.voices]
        if any(state != states[0] for state in states[1:]):
            raise ValueError(f"Voices disagree on M/K/Q at bar {index + 1}; writing would lose state.")
    problems = splice.check(score)
    if problems:
        raise ValueError("; ".join(problems))
    return score


def resolve_header(plan, anchor=None):
    """Fixed candidate values, with None for a model-selected field."""
    state = anchor.bars[anchor.voices[0]][0].state if anchor is not None else {}
    result = {}
    for field, name in (("M", "meter"), ("Q", "tempo"), ("K", "key"), ("L", "unit")):
        policy = plan["header"][name]
        if policy["policy"] == "anchor":
            if anchor is None:
                raise ValueError("A reference policy requires a reference score.")
            result[field] = (anchor.field("L") or str(note_unit(anchor))) if field == "L" else state[field] or ("1/4=120" if field == "Q" else state[field])
        elif policy["policy"] == "set":
            result[field] = f"1/4={policy['value']:g}" if field == "Q" else policy["value"]
        else:
            result[field] = None
    return result


# Every native YuE2 score declares these two voices, so the model is never asked for them.
NATIVE_VOICES = [("V", ' Vocal clef=treble name="Vocal Melody" snm="Vocal"'), ("V", ' Ins clef=treble name="Ins Melody" snm="Inst."')]


def header_spec(plan, anchor=None):
    """Native-order header lines: None values are model-completed one line at a time."""
    fixed = resolve_header(plan, anchor)
    if anchor is None and all(value is None for value in fixed.values()):
        return []  # Exactly native free/fresh generation.
    # Voice lines are kept byte for byte: the native dialect writes "V: Vocal ...".
    voices = [("V", line.split(":", 1)[1]) for line in anchor.header if line.startswith("V:")] if anchor is not None else NATIVE_VOICES
    unit = fixed["L"]
    return [("X", "1"), ("T", ""), ("M", fixed["M"]), ("L", unit), ("Q", fixed["Q"]), *voices, ("K", fixed["K"])]


def validate_header_line(field, value):
    if not isinstance(value, str) or any(c in value for c in "\r\n"):
        raise ValueError("Header fields must be single-line text.")
    if field in ("M", "L", "Q", "K"):
        if not value.strip():
            raise ValueError(f"Empty {field}: line.")
        normalize_field(field, value.strip())
    elif field == "X":
        if not re.fullmatch(r"[1-9][0-9]*", value):
            raise ValueError("Invalid X: index.")
    elif field == "V":
        if not re.fullmatch(r" ?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^\r\n]+)?", value):
            raise ValueError("Invalid V: declaration.")
    elif field != "T":
        raise ValueError(f"Unsupported header field {field}:.")



def header_diagnostics(plan, anchor=None):
    if anchor is not None and plan["header"]["key"]["policy"] == "free":
        return [diagnostic("opening", "key_experimental", "Key free is experimental: the audio may not follow the key change.")]
    return []


def diagnostic(stage, code, message, bar=None, voice=None, severity="warning"):
    return dict(stage=stage, code=code, severity=severity, bar=bar, voice=voice, message=message)


def validate_header_changes(score, fixed, stage="opening", start=0, anchor=None):
    """Opening locks reject; whole songs lock only their initial header."""
    validate_score(score)
    if anchor is not None:
        if score.voices != anchor.voices:
            raise ValueError("Voices differ from the reference.")
        if note_unit(score) != note_unit(anchor):
            raise ValueError("Note units differ from the reference.")
    if stage == "fresh":
        for field, value in fixed.items():
            if value is not None and normalize_field(field, score.field(field) or (str(note_unit(score)) if field == "L" else "")) != normalize_field(field, value):
                raise ValueError(f"{field}: initial header does not match the requested lock.")
    diagnostics = []
    for voice in score.voices:
        previous = None
        for index, bar in enumerate(score.bars[voice]):
            if index < start:
                continue
            for field, value in fixed.items():
                if field == "L":
                    continue  # The parser rejects mid-score L changes.
                if value is None or normalize_field(field, bar.state[field]) == normalize_field(field, value):
                    continue
                # Report the start of each drift region, rather than every repeated bar.
                if previous is not None and normalize_field(field, previous[field]) == normalize_field(field, bar.state[field]):
                    continue
                message = f"{field}: lock requested, drift observed at bar {index + 1} ({bar.state[field]} vs {value})."
                if stage not in ("continuation", "fresh"):
                    raise ValueError(message)
                diagnostics.append(diagnostic(stage, "header_drift", message, index, voice))
            previous = bar.state
    return diagnostics


def adapt_anchor_tempo(anchor, opening=None):
    """Adopt the opening's initial tempo across all reference bars; never mutate source."""
    result = copy.deepcopy(anchor)
    if opening is None:
        return result, [diagnostic("join", "tempo_retained", "No opening; retained reference tempo.", severity="info")]
    target = opening.bars[opening.voices[0]][0].state["Q"] or "1/4=120"
    diagnostics = []
    original = anchor.bars[anchor.voices[0]]
    for index, bar in enumerate(original[1:], start=1):
        if normalize_field("Q", bar.state["Q"]) != normalize_field("Q", original[index - 1].state["Q"]):
            diagnostics.append(diagnostic("join", "tempo_ignored", "Source internal Q change is not followed by the audio; replaced during tempo adoption.", index))
    changed = any(normalize_field("Q", bar.state["Q"]) != normalize_field("Q", target)
                  for bars in result.bars.values() for bar in bars)
    for bars in result.bars.values():
        for bar in bars:
            bar.state["Q"] = target
    result.header = splice.header_lines(result, result.bars[result.voices[0]][0].state)
    if changed and normalize_field("Q", original[0].state["Q"]) != normalize_field("Q", target):
        diagnostics.insert(0, {**diagnostic("join", "tempo_adopted", f"Score edit: all reference bars adopt Q:{target}.", severity="info"),
                              "from_bpm": normalize_field("Q", original[0].state["Q"]),
                              "to_bpm": normalize_field("Q", target), "bars": anchor.length})
    return result, diagnostics


def analyze(abc, style=""):
    """Inspect without rewriting; distinguish written timing from acoustic timing."""
    score = validate_score(splice.parse(abc))
    bars = score.bars[score.voices[0]]
    initial = normalize_field("Q", bars[0].state["Q"])
    diagnostics = []
    if not bars[0].state["Q"]:
        diagnostics.append(diagnostic("result", "tempo_assumed", "Q absent; assumed 120 BPM.", severity="info"))
    events = []
    for index, bar in enumerate(bars):
        for name in splice.STATE_FIELDS:
            if index and normalize_field(name, bar.state[name]) != normalize_field(name, bars[index - 1].state[name]):
                events.append(dict(bar=index, field=name, value=bar.state[name]))
                if name == "Q":
                    diagnostics.append(diagnostic("result", "tempo_ignored", "Internal Q change is not followed by the audio.", index))
    for match in re.finditer(r"(?i)\b([0-9]+(?:\.[0-9]+)?)\s*bpm\b", style):
        if float(match[1]) != initial:
            diagnostics.append(diagnostic("result", "style_tempo", f"Style requests {match[1]} BPM; score header is {initial:g} BPM."))
    units = [float(normalize_field("M", bar.state["M"])) * 4 * 60 for bar in bars]
    return dict(abc=abc, bars=score.length, voices=list(score.voices), events=events,
                seconds=sum(units) / initial,
                written_seconds=sum(unit / normalize_field("Q", bar.state["Q"]) for unit, bar in zip(units, bars)),
                diagnostics=diagnostics)


def format_report(diagnostics):
    return "\n".join(item["message"] for item in diagnostics)


def sampling_from(value):
    if not isinstance(value, dict):
        raise ValueError("Sampling must be an object.")
    result = dict(temperature=0.7, top_p=0.9, top_k=30, repetition_penalty=1.005, penalty_window=100)
    if set(value) - result.keys():
        raise ValueError("Unknown Score sampling setting.")
    result.update(value)
    for name, low, high in (("temperature", 0, 100), ("top_p", 0, 1), ("repetition_penalty", 0, 100)):
        item = result[name]
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or not low < item <= high:
            raise ValueError(f"Invalid sampling {name}.")
    for name in ("top_k", "penalty_window"):
        result[name] = integer(result[name], 1, 1000000, name)
    return result


def bar_seconds(state):
    return float(meter(state.get("M", "4/4"), Fraction(1))) * 4 * 60 / (tempo(state.get("Q", "")) or 120)


def source_facts(score):
    """Bars and labelled sections of a parsed score, for the editor strips."""
    validate_score(score)
    first = score.bars[score.voices[0]]
    starts = sorted({0, *(index for index in score.labels if index < score.length)})
    sections = [dict(index=index, bar=start, bars=end - start, label=score.section_at(start),
                     seconds=sum(bar_seconds(bar.state) for bar in first[start:end]))
                for index, (start, end) in enumerate(zip(starts, [*starts[1:], score.length]))]
    bpm = tempo(first[0].state.get("Q", "")) or 120
    return dict(bars=score.length, sections=sections, seconds=sum(s["seconds"] for s in sections),
                bpm=bpm, anchor_bpm=bpm, bar_seconds=bar_seconds(first[0].state))


def preview(plan=None, **widgets):
    """CPU-only editor facts. Unknown generated lengths/fields stay null."""
    result = dict(version=1, source=None, anchor=None, header=None, spans=[], diagnostics=[], errors=[])
    # The source strip describes the pasted score independently of plan validity.
    # Header/range conflicts must not erase the very source needed to fix them.
    try:
        if plan is None:
            source_text = widgets.get("anchor_abc", "")
        else:
            recorded = json.loads(plan) if isinstance(plan, str) else plan
            source_text = resolve_source(recorded)
        if source_text:
            try:
                parsed = splice.parse(source_text)
                result["source"] = dict(kind="abc",
                    **source_facts(parsed),
                    fields={name: parsed.field(name) for name in ("Q", "M", "L", "K")},
                    voices=len(parsed.voices))
            except (ValueError, TypeError, KeyError, ZeroDivisionError):
                if plan is not None or widgets.get("anchor_use", False):
                    raise
                # A disabled, incomplete paste must not invalidate a fresh song.
        if plan is None:
            plan = widgets_to_plan(widgets)
        plan = plan_from(plan)
        sampling_from(plan.get("sampling", {}))
        source = resolve_source(plan)
        anchor = None
        if source is not None:
            anchor, warnings = cut_anchor(source, plan["anchor"])
            if plan["opening"]["bars"] and not anchor.field("L"):
                raise ValueError("Opening requires an explicit reference L: declaration; units must be identical.")
            facts = source_facts(anchor)
            facts["fields"] = dict(anchor.bars[anchor.voices[0]][0].state)
            result["anchor"] = dict(start=plan["anchor"]["start"], end=plan["anchor"]["start"] + anchor.length, **facts)
            result["diagnostics"] += [diagnostic("source", "cut_warning", text) for text in warnings]
            opening = plan["opening"]["bars"]
            result["spans"] = [dict(stage="opening", start=0, end=opening),
                               dict(stage="anchor", start=opening, end=opening + anchor.length)]
            if plan["continuation"]["enabled"]:
                result["spans"].append(dict(stage="continuation", start=opening + anchor.length, end=None))
        else:
            result["spans"] = [dict(stage="fresh", start=0, end=None)]
        result["header"] = dict(policies=plan["header"], fixed=resolve_header(plan, anchor), lines=header_spec(plan, anchor))
        result["diagnostics"] += header_diagnostics(plan, anchor)
        if anchor is not None:
            anchor_tempo = normalize_field("Q", anchor.bars[anchor.voices[0]][0].state["Q"])
            chosen = resolve_header(plan, anchor)["Q"]
            bpm = normalize_field("Q", chosen) if chosen else anchor_tempo
            units = sum(float(normalize_field("M", bar.state["M"])) * 4 for bar in anchor.bars[anchor.voices[0]])
            units += plan["opening"]["bars"] * float(normalize_field("M", anchor.bars[anchor.voices[0]][0].state["M"])) * 4
            # Display sections at the same uniform tempo as the planned score.
            for section in result["anchor"]["sections"]:
                kept = anchor.bars[anchor.voices[0]][section["bar"]:section["bar"] + section["bars"]]
                section["seconds"] = sum(float(normalize_field("M", bar.state["M"])) * 4 * 60 / bpm for bar in kept)
            # A continuation's length is unknown until the model ends or the budget runs out.
            result["timing"] = dict(seconds=units * 60 / bpm, bpm=bpm, final_tempo_model_chosen=chosen is None)
        else:
            fixed = resolve_header(plan)
            bpm = normalize_field("Q", fixed["Q"]) if fixed["Q"] else None
            result["timing"] = dict(seconds=None, bpm=bpm, final_tempo_model_chosen=bpm is None)
    except (ValueError, TypeError, KeyError, ZeroDivisionError) as error:
        result["errors"].append(str(error))
    return result


def normalize_tempo(abc, target=None):
    """One tempo per final score; preserve the exact text when no edit is needed."""
    parsed = validate_score(splice.parse(abc))
    bars = parsed.bars[parsed.voices[0]]
    explicit_target = target is not None
    target = target or bars[0].state["Q"] or "1/4=120"
    normalize_field("Q", target)
    diagnostics = []
    previous = None
    changed = False
    for index, bar in enumerate(bars):
        original = bar.state["Q"]
        if (original or "1/4=120") != target:
            changed = True
            if original != previous and (not explicit_target or index > 0):
                diagnostics.append(diagnostic("result", "tempo_normalized",
                    f"Q:{original or '1/4=120'} at bar {index + 1} normalized to {target} — the audio ignores mid-score tempo changes.", index))
        previous = original
    if not changed:
        return abc, diagnostics
    for voice_bars in parsed.bars.values():
        for bar in voice_bars:
            bar.state["Q"] = target
    parsed.header = splice.header_lines(parsed, parsed.bars[parsed.voices[0]][0].state)
    return splice.write(parsed), diagnostics
