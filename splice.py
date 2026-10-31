"""Bar-exact score surgery: cut, join and check YuE2 ABC scores.

A YuE2 score is a header, then groups of one to four bars. Each group repeats
a ``V:`` block for every voice, and a ``% label`` line before a group starts a
section. The native writer starts a group early at a section, meter or key
change, and repeats changed ``M:``/``K:`` fields in every voice block.

This module parses a score into bars per voice, so it can cut at any bar and
write the result back in that layout, and joins a generated opening before a
reused fragment. YuE2 only continues a score from its start, so a fragment can
sit at bar 13 only if bars 1 to 12 exist first.

Kept free of ComfyUI imports so it can be tested on its own.
"""

import re
from dataclasses import dataclass, field
from fractions import Fraction

FIELD = re.compile(r"^([A-Za-z]):\s?(.*)$")
# The planner sometimes runs a voice line into the bar before it: "Z|V: Vocal".
GLUED_FIELD = re.compile(r"\|(?=[A-Za-z]:)")
UNSUPPORTED = re.compile(r"\|:|:\||::|\|\||\|\]|\[\||\[[A-Za-z]:|\(\d|[{}\[\]]|![^!]*!")
NOTE = re.compile(r"""
    (?P<chord>"[^"]*")
  | (?P<bars>Z(?P<count>\d*))
  | (?P<note>[_^=]*[A-Ga-gzx][,']*)(?P<num>\d*)(?P<slashes>/*)(?P<den>\d*)
  | (?P<tie>-)
  | (?P<space>\s+)
""", re.VERBOSE)
CHORD_ROOT = re.compile(r"^([A-G])([#b]?)")
PITCH = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
STATE_FIELDS = ("M", "K", "Q")


class ScoreError(ValueError):
    """A score this module cannot cut or join without guessing."""


@dataclass
class Bar:
    text: str  # Without its bar line. A whole-bar rest is "Z".
    state: dict  # M, K and Q in effect for this bar in this voice.

    @property
    def ties_out(self):
        return self.text.rstrip().endswith("-")


@dataclass
class Score:
    header: list  # Raw header lines, through K:.
    voices: list  # Voice ids in header order.
    bars: dict  # Voice id -> list of Bar.
    labels: dict = field(default_factory=dict)  # Bar index -> section labels starting there.
    notes: list = field(default_factory=list)  # Things the parser tolerated or noticed.

    @property
    def length(self):
        return len(self.bars[self.voices[0]]) if self.voices else 0

    def field(self, name):
        for line in self.header:
            match = FIELD.match(line)
            if match and match[1] == name:
                return match[2].strip()
        return None

    def section_at(self, index):
        """The section label in effect at bar ``index``, or ""."""
        for start in sorted(self.labels, reverse=True):
            if start <= index and self.labels[start]:
                return self.labels[start][-1]
        return ""


def _fraction(value, default):
    value = (value or "").strip()
    if value in ("C", "C|"):
        return Fraction(1)
    try:
        top, bottom = value.split("/")
        return Fraction(int(top), int(bottom))
    except ValueError:
        return default


def bar_units(text, unit):
    """Length of one bar in whole notes, or None for notation this module does not count."""
    total, position = Fraction(0), 0
    text = text.split("%")[0]
    while position < len(text):
        match = NOTE.match(text, position)
        if not match:
            return None
        position = match.end()
        if match["note"]:
            length = Fraction(int(match["num"] or 1))
            if match["slashes"]:
                length /= int(match["den"]) if match["den"] else 2 ** len(match["slashes"])
            total += length * unit
        elif match["bars"]:
            return None  # A whole-bar rest fills whatever the meter is.
    return total


def parse(abc):
    """Parse a YuE2 score. Raises ScoreError on notation it cannot cut safely."""
    text = GLUED_FIELD.sub("|\n", (abc or "").replace("\r\n", "\n"))
    lines = text.split("\n")
    header, body = [], []
    for index, line in enumerate(lines):
        header.append(line.rstrip())
        if line.startswith("K:"):
            body = lines[index + 1:]
            break
    else:
        raise ScoreError("The score has no K: line, so its header cannot be found.")

    voices, state = [], {"M": "4/4", "K": "", "Q": ""}
    for line in header:
        match = FIELD.match(line)
        if not match:
            continue
        name, value = match[1], match[2].strip()
        if name == "V" and value.split():
            voices.append(value.split()[0])
        elif name in STATE_FIELDS:
            state[name] = value
    if not voices:
        raise ScoreError("The header declares no voices.")
    first = voices[0]

    score = Score(header=[line for line in header if line.strip()], voices=voices,
                  bars={voice: [] for voice in voices})
    states = {voice: dict(state) for voice in voices}
    voice, pending = first, []
    for number, raw in enumerate(body, start=len(header) + 1):
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        if line.startswith("%"):
            label = line.lstrip("%").strip()
            if label:
                pending.append(label)
            continue
        match = FIELD.match(line)
        if match:
            name, value = match[1], match[2].strip()
            if name == "V":
                voice = value.split()[0] if value.split() else ""
                if voice not in score.bars:
                    raise ScoreError(f"Line {number}: voice {voice!r} is not declared in the header.")
                if len(value.split()) > 1:
                    score.notes.append(f"Line {number}: a second voice declaration inside the music.")
                if voice == first and pending:
                    at = len(score.bars[first])
                    score.labels.setdefault(at, []).extend(pending)
                    pending = []
            elif name in STATE_FIELDS:
                states[voice][name] = value
            elif name in ("X", "T", "L"):
                score.notes.append(f"Line {number}: a second {name}: header field inside the music.")
                if name == "L":
                    raise ScoreError(f"Line {number}: the note unit changes mid-score.")
            else:
                raise ScoreError(f"Line {number}: unsupported field {name}:.")
            continue
        music = line.split("%")[0]
        if UNSUPPORTED.search(music):
            raise ScoreError(f"Line {number}: repeats, tuplets, inline fields or chords in brackets are not supported.")
        if pending and voice == first:
            score.labels.setdefault(len(score.bars[first]), []).extend(pending)
            pending = []
        for part in music.split("|"):
            part = part.strip()
            if not part:
                continue
            rest = re.fullmatch(r"Z(\d*)", part)
            for _ in range(int(rest[1] or 1) if rest else 1):
                score.bars[voice].append(Bar("Z" if rest else part, dict(states[voice])))
        if not music.rstrip().endswith("|"):
            score.notes.append(f"Line {number}: the last bar has no closing bar line.")
    if pending:
        score.labels.setdefault(score.length, []).extend(pending)
    counts = {voice: len(bars) for voice, bars in score.bars.items()}
    if len(set(counts.values())) > 1:
        score.notes.append("Voices have different bar counts: "
                           + ", ".join(f"{voice} {count}" for voice, count in counts.items()) + ".")
    return score


def aligned(score):
    """Raise unless every voice has the same number of bars."""
    counts = {voice: len(bars) for voice, bars in score.bars.items()}
    if len(set(counts.values())) > 1:
        raise ScoreError("Voices have different bar counts: "
                         + ", ".join(f"{voice} {count}" for voice, count in counts.items()) + ".")


def _header(score, state):
    """The score's header with M, K and Q set to ``state``."""
    lines = []
    for line in score.header:
        match = FIELD.match(line)
        if match and match[1] in STATE_FIELDS and state.get(match[1]):
            line = f"{match[1]}:{state[match[1]]}"
        lines.append(line)
    if state.get("Q") and not any(FIELD.match(line) and line.startswith("Q:") for line in lines):
        lines.insert(next(i for i, line in enumerate(lines) if line.startswith("K:")), f"Q:{state['Q']}")
    return lines


def header_lines(score, state):
    """Return an independent header with the requested effective state."""
    return _header(score, state)


def matching_states(score):
    """Reject per-voice state changes the native grouped writer cannot preserve."""
    aligned(score)
    for index in range(score.length):
        first = score.bars[score.voices[0]][index].state
        if any(score.bars[voice][index].state != first for voice in score.voices[1:]):
            raise ScoreError(f"Voices have different M/K/Q state at bar {index + 1}.")


def write(score):
    """Write a score in the native layout, regrouping bars."""
    matching_states(score)
    first = score.voices[0]
    lines = _header(score, score.bars[first][0].state if score.length else {})
    index = 0
    while index < score.length:
        start = score.bars[first][index].state
        previous = score.bars[first][index - 1].state if index else start
        meter_changed = index and start["M"] != previous["M"]
        key_changed = index and start["K"] != previous["K"]
        tempo_changed = index and start["Q"] != previous["Q"]
        end = index + 1
        while (end < score.length and end - index < 4 and not score.labels.get(end)
               and score.bars[first][end].state == score.bars[first][end - 1].state):
            end += 1
        lines.extend(f"% {label}" for label in score.labels.get(index, []))
        for voice in score.voices:
            lines.append(f"V: {voice}")
            state = score.bars[voice][index].state
            if meter_changed:
                lines.append(f"M:{state['M']}")
            if key_changed:
                lines.append(f"K:{state['K']}")
            if tempo_changed:
                lines.append(f"Q:{state['Q']}")
            lines.append(_render(score.bars[voice][index:end]))
        index = end
    return "\n".join(lines) + "\n"


def _render(bars):
    parts, index = [], 0
    while index < len(bars):
        if bars[index].text != "Z":
            parts.append(bars[index].text + "|")
            index += 1
            continue
        end = index
        while end < len(bars) and bars[end].text == "Z":
            end += 1
        count = end - index
        parts.append("Z" + (str(count) if count > 1 else "") + "|")
        index = end
    return "".join(parts)


def cut(score, start, end):
    """Bars ``start`` up to ``end`` (0-based, end exclusive) as a new score.

    The new header carries the meter, key and tempo in effect at ``start``, and
    the section in effect there is repeated as its opening label. Returns the
    score and warnings about ties crossing either cut.
    """
    aligned(score)
    if not 0 <= start < end <= score.length:
        raise ScoreError(f"Choose bars between 1 and {score.length}.")
    labels = {i - start: list(names) for i, names in score.labels.items() if start < i < end}
    opening = score.labels.get(start) or ([score.section_at(start)] if score.section_at(start) else [])
    if opening:
        labels[0] = list(opening)
    part = Score(header=_header(score, score.bars[score.voices[0]][start].state), voices=list(score.voices),
                 bars={voice: [Bar(bar.text, dict(bar.state)) for bar in bars[start:end]]
                       for voice, bars in score.bars.items()},
                 labels=labels)
    warnings = []
    for voice, bars in score.bars.items():
        if start and bars[start - 1].ties_out:
            warnings.append(f"{voice}: a note from bar {start} is tied into bar {start + 1}, where the cut begins.")
        if end < score.length and bars[end - 1].ties_out:
            warnings.append(f"{voice}: a note in bar {end} is tied past the cut.")
    return part, warnings


def join(lead, fragment):
    """``lead`` followed by ``fragment``, preserving the fragment's state at the join.

    The fragment keeps its meter and key; a change at the join is written in
    every voice block, as the native writer does. Returns the score and warnings.
    """
    aligned(lead)
    aligned(fragment)
    if lead.voices != fragment.voices:
        raise ScoreError(f"Voices differ: {', '.join(lead.voices)} and {', '.join(fragment.voices)}.")
    if lead.field("L") != fragment.field("L"):
        raise ScoreError(f"Note units differ (L:{lead.field('L')} and L:{fragment.field('L')}); "
                         "cut both from scores with the same unit.")
    warnings = []
    for voice in lead.voices:
        if lead.length and lead.bars[voice][-1].ties_out:
            warnings.append(f"{voice}: the lead-in's last note is tied into the fragment.")
    bars = {}
    for voice in lead.voices:
        bars[voice] = [Bar(bar.text, dict(bar.state)) for bar in lead.bars[voice]]
        bars[voice] += [Bar(bar.text, {**bar.state, "Q": bar.state["Q"] or "1/4=120"})
                        for bar in fragment.bars[voice]]
    labels = {**{i: list(names) for i, names in lead.labels.items()},
              **{lead.length + i: list(names) for i, names in fragment.labels.items()}}
    return Score(header=list(lead.header), voices=list(lead.voices), bars=bars, labels=labels), warnings


def note_unit(score):
    """Resolve L:, using the initial meter for ABC's implicit note length."""
    default = Fraction(1, 8) if _fraction(score.field("M"), Fraction(1)) >= Fraction(3, 4) else Fraction(1, 16)
    return _fraction(score.field("L"), default)


def check(score):
    """Problems worth knowing before a score is used: notes from parsing, and bars of the wrong length."""
    problems = list(score.notes)
    unit = note_unit(score)
    for voice, bars in score.bars.items():
        unknown = [index + 1 for index, bar in enumerate(bars)
                   if bar.text != "Z" and bar_units(bar.text, unit) is None]
        if unknown:
            problems.append(f"{voice}: cannot validate notation in bars {', '.join(map(str, unknown[:8]))}.")
        wrong = [index + 1 for index, bar in enumerate(bars)
                 if (units := bar_units(bar.text, unit)) is not None
                 and units != _fraction(bar.state["M"], Fraction(1))]
        if wrong:
            shown = ", ".join(map(str, wrong[:8])) + ("…" if len(wrong) > 8 else "")
            problems.append(f"{voice}: bar{'s' if len(wrong) > 1 else ''} {shown} "
                            f"{'do' if len(wrong) > 1 else 'does'} not match the meter.")
    return problems


def chords(score):
    """Chord symbols in order, from every voice's bars, by bar."""
    found = []
    for index in range(score.length):
        for voice in score.voices:
            found.extend((index, name.strip('"')) for name in re.findall(r'"[^"]*"', score.bars[voice][index].text))
    return found


def _root(name):
    match = CHORD_ROOT.match(name)
    if not match:
        return None
    return (PITCH[match[1]] + {"#": 1, "b": -1, "": 0}[match[2]]) % 12


def cadence(last, first):
    """How strongly chord ``last`` leads into ``first``: 2 dominant, 1 subdominant or same root, 0 otherwise."""
    a, b = _root(last or ""), _root(first or "")
    if a is None or b is None:
        return 0
    return {5: 2, 7: 1, 0: 1}.get((b - a) % 12, 0)


@dataclass
class Candidate:
    seed: int
    text: str = ""  # The planner's whole output, before cutting.
    ended: bool = False
    lead: Score = None
    score: Score = None
    abc: str = ""
    problems: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    cadence: int = 0
    error: str = ""

    @property
    def usable(self):
        return not self.error

    def rank(self):
        return (not self.usable, len(self.problems), len(self.warnings), -self.cadence)


def fragment_problems(fragment):
    """Problems of a fragment that every lead-in shares: bar lengths, and notes tied past its end."""
    problems = check(fragment)
    for voice, bars in fragment.bars.items():
        if bars and bars[-1].ties_out:
            problems.append(f"{voice}: the fragment ends on a tied note; what follows must continue it.")
    return problems
