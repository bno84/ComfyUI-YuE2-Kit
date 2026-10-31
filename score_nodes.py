"""Public Score planner and independently cached execution stages."""

import json

from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder

from . import planning, score, splice
from .history import parse_score, summary

Data = io.Custom("YUE2_SCORE_DATA")
Context = io.Custom("YUE2_SCORE_CONTEXT")
def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def model_inputs():
    return [io.Clip.Input("clip"), io.String.Input("style"), io.String.Input("lyrics"),
            io.Combo.Input("mode", options=["full", "melody"]), io.Int.Input("seed", min=0, max=score.UINT64)]


def generated_outputs():
    return [io.String.Output("abc"), Data.Output("data"), Context.Output("context")]


def capacity(tokenizer, abc, style, lyrics, mode):
    tokens = tokenizer.tokenize_with_weights(style, lyrics=lyrics, cot=mode, abc=abc)
    used, available = planning.check_music_context(tokens, score.analyze(abc)["seconds"])
    return dict(used=used, context=planning.CONTEXT, audio_seconds=available / 25,
                checks=["structure", "header", "prompt tokens", "audio capacity"])


def generate(clip, settings, style, lyrics, mode, seed):
    prefix, lines = planning.complete_header(clip, style, lyrics, seed, mode,
                                             settings["spec"], score.validate_header_line,
                                             label=settings.get("label", ""), **settings["sampling"])
    abc, ended, metadata = planning.generate_abc(clip, style, lyrics, seed, mode, settings["budget"],
                                                 prefix=prefix, **settings["sampling"])
    if not settings["spec"]:
        lines = [dict(field=line[0], given=False, line=line, attempts=[]) for line in splice.parse(abc).header]
    return abc, dict(seed=str(seed), header=lines, ended=ended, generation=metadata)


def finish_tail(text, ended, start=0):
    """Keep aligned complete bars, dropping only unfinished budget output.

    The native model emits voice blocks, so a budget can stop several bars
    ahead in one voice. Never validate or serialize that unmatched suffix.
    """
    if ended:
        score.validate_score(splice.parse(text))
        return text, dict(diagnostics=[])
    # Supply a missing final barline only when its fragment fills the active
    # meter. Do not repair earlier lines or retain unfinished notation.
    lines = text.rstrip().split("\n")
    if lines and not ended:
        last = lines[-1].strip()
        if last and not last.startswith("%") and not splice.FIELD.match(last):
            if not last.endswith("|"):
                closed = lines[:-1] + [last + "|"]
                complete = False
                try:
                    candidate = splice.parse("\n".join(closed) + "\n")
                    # The fragment may belong to any declared voice, not only
                    # the final one. All voices are aligned below before cutting.
                    voice = candidate.voices[0]
                    body = False
                    for line in lines[:-1]:
                        match = splice.FIELD.match(line.strip())
                        if match and match[1] == "K":
                            body = True
                        if body and match and match[1] == "V":
                            voice = match[2].strip().split()[0]
                    bar = candidate.bars[voice][-1]
                    complete = bar.text == "Z" or splice.bar_units(bar.text, score.note_unit(candidate)) == score.normalize_field("M", bar.state["M"])
                except (ValueError, splice.ScoreError, IndexError):
                    pass
                lines[-1] = last + "|" if complete else last[:last.rfind("|") + 1] if "|" in last else ""
        elif last and not last.startswith("%"):
            # A budget can stop in the middle of the next V/M/K/Q line.
            lines.pop()
    parsed = splice.parse("\n".join(lines) + "\n")
    common = min(len(items) for items in parsed.bars.values())
    # The final parsed bar may still have an incomplete duration in a voice.
    # Only discard suffix bars, never scan past an interior structural error.
    while common > start:
        valid = True
        for voice in parsed.voices:
            bar = parsed.bars[voice][common - 1]
            units = splice.bar_units(bar.text, score.note_unit(parsed))
            if bar.text != "Z" and units != score.normalize_field("M", bar.state["M"]):
                valid = False
        if valid:
            break
        common -= 1
    end = common
    if not ended:
        grouped = end - (end - start) % 4
        end = grouped if grouped > start else end
    if end <= start:
        if start:
            end = start  # A tiny budget may add no complete group; keep source.
        else:
            raise ValueError("Planner produced no complete aligned bars within the token budget.")
    # Keep header/declaration diagnostics. Count mismatch and the final open
    # line describe discarded material; cut will check the retained bars anew.
    problems = [note for note in parsed.notes if "different bar counts" not in note]
    for voice in parsed.voices:
        parsed.bars[voice] = parsed.bars[voice][:end]
    kept, _ = splice.cut(parsed, 0, end)
    kept.notes = problems
    score.validate_score(kept)
    diagnostics = []
    if not ended:
        diagnostics.append(score.diagnostic("continuation", "tail_trimmed",
            f"continuation did not end; trimmed at bar {end}", end - 1))
    return splice.write(kept), dict(bars=end - start,
                                   trimmed=bool(diagnostics), diagnostics=diagnostics)


def opening_candidates(clip, anchor_abc, settings, style, lyrics, mode, seed):
    anchor = score.validate_score(splice.parse(anchor_abc))
    options = settings["opening"]
    settings = {**settings, "budget": options["max_tokens"]}
    candidates, records = [], []
    first_fit = None
    for index in range(options["attempts"]):
        candidate_seed = score.derive_seed(seed, "opening", index)
        candidate = splice.Candidate(seed=candidate_seed)
        record = dict(seed=str(candidate_seed), header=[], error="")
        candidates.append(candidate)
        records.append(record)
        try:
            text, detail = generate(clip, settings, style, lyrics, mode, candidate_seed)
            record.update(detail)
            candidate.text, candidate.ended = text, detail["ended"]
            written = splice.parse(text)
            problems = [note for note in written.notes if "header field" in note or "declaration" in note]
            if problems:
                raise ValueError("; ".join(problems))
            # A token-budget tail may have a partial last bar. Only the requested
            # complete prefix matters, but malformed headers must still fail.
            for voice in written.voices:
                if len(written.bars[voice]) < options["bars"]:
                    raise ValueError(f"Planner {'ended' if candidate.ended else 'ran out of tokens'} before {options['bars']} bars ({voice}).")
                del written.bars[voice][options["bars"]:]
            lead, warnings = splice.cut(written, 0, options["bars"])
            score.validate_header_changes(lead, settings["fixed"], anchor=anchor)
            if lead.field("L") != anchor.field("L"):
                raise ValueError("Opening and anchor require identical L: declarations.")
            if len(lead.labels.get(0, [])) > 1:
                lead.labels[0] = [lead.labels[0][-1]]
            if options["label"] and not lead.labels.get(0):
                lead.labels[0] = [options["label"]]
            adapted, _ = score.adapt_anchor_tempo(anchor, lead)
            joined, join_warnings = splice.join(lead, adapted)
            capacity(clip.tokenizer, splice.write(joined), style, lyrics, mode)
            candidate.lead, candidate.score = lead, joined
            candidate.warnings = warnings + join_warnings
            keys = {bar.state["K"] for bar in lead.bars[lead.voices[0]]}
            target = anchor.bars[anchor.voices[0]][0].state["K"]
            if keys != {target}:
                candidate.warnings.append(f"Opening keys {', '.join(sorted(keys))}; anchor K:{target}.")
            a, b = splice.chords(lead), splice.chords(anchor)
            unscored = mode == "melody" or not a or not b
            candidate.cadence = 0 if unscored else splice.cadence(a[-1][1], b[0][1])
            candidate.abc = splice.write(lead)
            record.update(cadence=None if unscored else candidate.cadence, unscored=unscored,
                          warnings=candidate.warnings)
            if unscored or (not candidate.warnings and candidate.cadence >= 1):
                first_fit = candidate
                break
        except (ValueError, splice.ScoreError) as error:
            candidate.error = record["error"] = str(error)
    usable = sorted((item for item in candidates if item.usable), key=splice.Candidate.rank)
    if not usable:
        raise ValueError("No usable opening.\n" + "\n".join(f"Seed {r['seed']}: {r['error']}" for r in records))
    chosen = first_fit or usable[0]
    selected = next(item for item in records if item["seed"] == str(chosen.seed))
    reason = ("chord join unscored; first valid candidate wins" if selected["unscored"] else
              "first good fit (warning-free, favorable cadence)" if first_fit else
              f"no candidate met first good fit (warning-free, favorable cadence); picked the best of {len(records)}")
    return chosen.abc, dict(candidates=records, selected=selected, selection_reason=reason,
                            opening_bars=options["bars"], diagnostics=[])


class ScoreGenerate(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreGenerate", is_dev_only=True,
                         inputs=[*model_inputs(), io.String.Input("settings")], outputs=generated_outputs())

    @classmethod
    def execute(cls, clip, style, lyrics, mode, seed, settings):
        settings = json.loads(settings)
        abc, detail = generate(clip, settings, style, lyrics, mode, seed)
        abc, trimmed = finish_tail(abc, detail["ended"])
        detail.update(trimmed)
        diagnostics = score.validate_header_changes(splice.parse(abc), settings["fixed"], stage="fresh")
        return io.NodeOutput(abc, dict(fresh=detail, opening_bars=0, anchor_bars=0,
                                     diagnostics=trimmed["diagnostics"] + diagnostics), clip.tokenizer)


class ScoreOpening(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreOpening", is_dev_only=True,
                         inputs=[*model_inputs(), io.String.Input("anchor"), io.String.Input("settings")],
                         outputs=generated_outputs())

    @classmethod
    def execute(cls, clip, style, lyrics, mode, seed, anchor, settings):
        abc, data = opening_candidates(clip, anchor, json.loads(settings), style, lyrics, mode, seed)
        return io.NodeOutput(abc, data, clip.tokenizer)


class ScoreJoin(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreJoin", is_dev_only=True,
                         inputs=[io.String.Input("anchor"), io.String.Input("opening"), Data.Input("data"),
                                 io.String.Input("tempo")],
                         outputs=[io.String.Output("abc"), Data.Output("data")])

    @classmethod
    def execute(cls, anchor, opening, data, tempo=""):
        part = score.validate_score(splice.parse(anchor))
        original_bpm = score.normalize_field("Q", part.bars[part.voices[0]][0].state["Q"])
        retiming = []
        if not opening and tempo:
            anchor, retiming = score.normalize_tempo(anchor, tempo)
            part = splice.parse(anchor)
        lead = splice.parse(opening) if opening else None
        adapted, diagnostics = score.adapt_anchor_tempo(part, lead)
        if not opening and tempo and original_bpm != score.normalize_field("Q", tempo):
            diagnostics = [{**score.diagnostic("join", "tempo_set", f"No opening; set tempo retimes the whole anchor to Q:{tempo}.", severity="info"),
                            "from_bpm": original_bpm, "to_bpm": score.normalize_field("Q", tempo), "bars": part.length}]
        diagnostics += retiming
        if lead is not None:
            joined, warnings = splice.join(lead, adapted)
            abc = splice.write(joined)
            diagnostics += [score.diagnostic("join", "join_warning", text) for text in warnings]
        else:
            abc = anchor
        data = {**data, "anchor_bars": part.length, "prefix_bars": part.length + data["opening_bars"],
                "diagnostics": data["diagnostics"] + diagnostics}
        return io.NodeOutput(abc, data)


class ScoreContinue(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreContinue", is_dev_only=True,
                         inputs=[*model_inputs(), io.String.Input("abc"), Data.Input("data"), io.String.Input("settings")],
                         outputs=generated_outputs())

    @classmethod
    def execute(cls, clip, style, lyrics, mode, seed, abc, data, settings):
        settings = json.loads(settings)
        prefix = abc.rstrip() + "\n"
        final, ended, metadata = planning.generate_abc(clip, style, lyrics, seed, mode, settings["budget"],
                                                      prefix=prefix, **settings["sampling"])
        if not final.startswith(prefix):
            raise ValueError("Continuation did not preserve the supplied score prefix.")
        source = splice.parse(abc)
        final, trimmed = finish_tail(final, ended, source.length)
        parsed = splice.parse(final)
        if parsed.voices != source.voices or parsed.field("L") != source.field("L"):
            raise ValueError("Continuation changed voices or L: declarations.")
        diagnostics = score.validate_header_changes(parsed, settings["fixed"], "continuation", source.length)
        data = {**data, "continuation": dict(seed=str(seed), ended=ended, generation=metadata, **trimmed),
                "diagnostics": data["diagnostics"] + diagnostics + trimmed["diagnostics"]}
        return io.NodeOutput(final, data, clip.tokenizer)


class ScoreContext(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreContext", is_dev_only=True,
                         inputs=[io.Clip.Input("clip")], outputs=[Context.Output("context")])

    @classmethod
    def execute(cls, clip):
        return io.NodeOutput(clip.tokenizer)


def result_payload(abc, data, context, facts, lyrics, style, mode, seed):
    facts = json.loads(facts)
    analysis = score.analyze(abc, style)
    analysis.pop("written_seconds")
    checked = capacity(context, abc, style, lyrics, mode)
    diagnostics = facts["diagnostics"] + data["diagnostics"] + analysis.pop("diagnostics")
    diagnostics += [score.diagnostic("result", "field_change", f"{event['field']}:{event['value']} change at bar {event['bar'] + 1}.", event["bar"])
                    for event in analysis["events"] if event["field"] in ("M", "K")]
    diagnostics += [score.diagnostic("result", "tie_warning", text) for text in splice.fragment_problems(splice.parse(abc))]
    if mode == "melody" and splice.chords(splice.parse(abc)):
        diagnostics.append(score.diagnostic("result", "melody_chords", "Melody mode does not strip chord symbols; this score still contains chords."))
    bars = analysis["bars"]
    opening, anchor = data["opening_bars"], data.get("anchor_bars", 0)
    spans = ([dict(stage="fresh", start=0, end=bars)] if "fresh" in data else
             [dict(stage="opening", start=0, end=opening), dict(stage="anchor", start=opening, end=opening + anchor),
              dict(stage="continuation", start=opening + anchor, end=bars)])
    cut = facts["cut"]
    cut_text = f"bars {cut['start'] + 1}–{cut['end']}" if cut else "none"
    lines = [f"Mode: {mode}. Source: {facts['source']}. Cut: {cut_text}.",
             "Stages: " + ", ".join(f"{s['stage']} {s['end'] - s['start']} bars" for s in spans) + ".",
             "Header policies: " + ", ".join(f"{name} {field['policy']}" for name, field in facts["header"].items()) + ".",
             "Effective header: " + ", ".join(f"{name}:{value}" for name, value in splice.parse(abc).bars[analysis["voices"][0]][0].state.items()) + "."]
    details = data.get("candidates", []) or ([data["fresh"]] if "fresh" in data else [])
    for detail in details:
        if "fresh" in data:
            given = ", ".join(item["line"] for item in detail["header"] if item["given"]) or "none"
            generated = ", ".join(item["line"] for item in detail["header"] if not item["given"]) or "none"
            lines.append(f"Song: one generation (seed {detail['seed']}) · header: {given} given; {generated} generated")
            continue
        lines.append(f"Seed {detail['seed']}: " + ("rejected. " + detail["error"] if detail.get("error") else "accepted."))
        lines += [f"  {'given' if item['given'] else 'generated'} {item['line']}" for item in detail["header"]]
        lines += ["  " + text for text in detail.get("warnings", [])]
    if "selected" in data:
        selected = data["selected"]
        lines.append(f"Selected seed {selected['seed']}; " + ("chord join unscored; first valid candidate wins." if selected["unscored"] else f"cadence {selected['cadence']}/2."))
    if data.get("selection_reason"):
        lines.append("Opening: " + data["selection_reason"] + ".")
    lines += [item["message"] for item in diagnostics]
    for stage in ("fresh", "continuation"):
        if stage in data:
            detail = data[stage]
            span = next(s for s in spans if s["stage"] == stage)
            actual = detail.get("bars", span["end"] - span["start"])
            stop = "trimmed" if detail.get("trimmed") else "ended naturally"
            lines.append(f"{stage.capitalize()}: {actual} bars · {stop}.")
            lines.append(f"{stage.capitalize()} seed {data[stage]['seed']}: " + ("ended at ABC_END." if data[stage]["ended"] else "token budget reached."))
    lines.append(f"Checks: {', '.join(checked['checks'])}. {checked['used']} of {checked['context']} tokens; {checked['audio_seconds']:.1f} s audio capacity.")
    report = "\n".join(lines)
    return dict(version=1, abc=abc, seconds=analysis["seconds"], seed=str(seed), mode=mode,
                source=facts["source"], cut=facts["cut"], header=facts["header"], analysis=analysis,
                summary=summary(parse_score(abc)), spans=spans, diagnostics=diagnostics, generation=data,
                capacity=checked, report=report)


class ScoreResult(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.ScoreResult", is_dev_only=True,
                         inputs=[io.String.Input("abc"), Data.Input("data"), Context.Input("context"),
                                 io.String.Input("facts"), io.String.Input("lyrics"), io.String.Input("style"),
                                 io.Combo.Input("mode", options=["full", "melody"]), io.Int.Input("seed", min=0, max=score.UINT64)], outputs=score_outputs())

    @classmethod
    def execute(cls, abc, data, context, facts, lyrics, style, mode, seed):
        abc, normalized = score.normalize_tempo(abc)
        data = {**data, "diagnostics": data["diagnostics"] + normalized}
        payload = result_payload(abc, data, context, facts, lyrics, style, mode, seed)
        return io.NodeOutput(abc, mode, payload["seconds"], lyrics, style, seed, payload["report"])


def score_outputs():
    return [io.String.Output("abc"), io.Combo.Output("mode", options=["full", "melody"]),
            io.Float.Output("seconds"), io.String.Output("lyrics"), io.String.Output("style"),
            io.Int.Output("seed"), io.String.Output("report")]


def score_inputs():
    return [io.Clip.Input("clip", lazy=True),
        io.String.Input("lyrics", force_input=True),
        io.String.Input("style", force_input=True),
        io.Int.Input("seed", min=0, max=score.UINT64, force_input=True),
        io.Combo.Input("header_mode", options=["generated", "fixed", "from anchor"], default="generated", display_name="Header mode"),
        io.Int.Input("header_tempo", default=120, min=1, max=1000, display_name="Header tempo (BPM)"),
        io.Combo.Input("header_meter", options=["4/4", "3/4", "6/8", "2/4", "12/8", "2/2", "5/4", "7/8"], display_name="Header meter"),
        io.Combo.Input("header_key", options=list(score.KEYS), default="C major", display_name="Header key"),
        io.Boolean.Input("opening_generate", default=False, display_name="Opening generate"),
        io.Int.Input("opening_bars", default=8, min=1, max=256, display_name="Opening bars"),
        io.String.Input("opening_hint", default="intro", display_name="Opening hint (opening only)", dynamic_prompts=False),
        io.Int.Input("opening_candidates", default=4, min=1, max=16, display_name="Opening candidates"),
        io.Boolean.Input("anchor_use", default=False, display_name="Anchor use"),
        io.String.Input("anchor_abc", default="", multiline=True, dynamic_prompts=False, display_name="Anchor ABC"),
        io.Int.Input("anchor_start", default=1, min=1, max=1000000),
        io.Int.Input("anchor_end", default=0, min=0, max=1000000),
        io.Boolean.Input("continue_generate", default=True, display_name="Continue generate"),
        io.Combo.Input("mode", options=["full", "melody"], default="full", display_name="Mode"),
        io.Float.Input("temperature", default=0.7, min=0.01, max=100, step=0.01, display_name="Temperature"),
        io.Float.Input("top_p", default=0.9, min=0.01, max=1, step=0.01, display_name="Top p"),
        io.Int.Input("top_k", default=30, min=1, max=1000000, display_name="Top k"),
        io.Float.Input("repetition_penalty", default=1.005, min=0.001, max=100, step=0.001, display_name="Repetition penalty"),
        io.Int.Input("penalty_window", default=100, min=1, max=1000000, display_name="Penalty window"),
        io.Int.Input("opening_tokens", default=1024, min=score.OPENING_TOKENS_MIN, max=20000, display_name="Opening token budget"),
        io.Int.Input("continuation_tokens", default=8192, min=0, max=20000, display_name="Continuation token budget"),
        # The encoder file, never a loaded model: only the browser's transcription job loads it.
        io.AnyType.Input("sheetsage2", optional=True, lazy=True,
                         tooltip="SheetSage2 file from Models. Used when audio is dropped on the node.")]


class YuE2Score(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="bno84.YuE2Score", display_name="YuE2 Score", category="audio/YuE2",
                         description="Plan a fresh, continued or anchored score. Opening must match; continuation is checked and reported.",
                         enable_expand=True,
                         inputs=score_inputs(), outputs=score_outputs(),
                         hidden=[io.Hidden.dynprompt, io.Hidden.unique_id])

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, lyrics, style, seed, clip=None, sheetsage2=None, **widgets):
        mode = widgets.get("mode", "full")
        if mode not in ("full", "melody"):
            raise ValueError("Score mode must be full or melody.")
        score.integer(seed, 0, score.UINT64, "Seed")
        plan = score.widgets_to_plan(widgets)
        return cls.expand_plan(lyrics, style, seed, mode, plan, clip)

    @classmethod
    def expand_plan(cls, lyrics, style, seed, mode, plan, clip=None):
        """Private expansion boundary. Public inputs are validated before here."""
        plan = score.plan_from(plan)
        source = score.resolve_source(plan)
        anchor = None
        diagnostics = []
        if source is not None:
            anchor, warnings = score.cut_anchor(source, plan["anchor"])
            diagnostics += [score.diagnostic("source", "cut_warning", text) for text in warnings]
            unchanged = plan["anchor"]["start"] == 0 and plan["anchor"]["end"] in (None, splice.parse(source).length)
            anchor_abc = source if unchanged else splice.write(anchor)
        diagnostics += score.header_diagnostics(plan, anchor)
        hidden = cls.hidden
        raw = hidden.dynprompt.get_node(hidden.unique_id)["inputs"]
        graph = GraphBuilder()
        shared = dict(clip=raw.get("clip", clip), style=raw.get("style", style), lyrics=raw.get("lyrics", lyrics), mode=mode)
        sampling = score.sampling_from(plan.get("sampling", {}))
        fixed = score.resolve_header(plan, anchor)
        settings = dict(spec=score.header_spec(plan, anchor), fixed=fixed, sampling=sampling,
                        budget=plan["continuation"]["max_tokens"] or 8192)
        if anchor is None:
            if settings["spec"]:
                settings["label"] = plan["opening"]["label"]
            node = graph.node("bno84.ScoreGenerate", "fresh", **shared, seed=score.derive_seed(seed, "fresh"), settings=canonical(settings))
            final, data, context = node.out(0), node.out(1), node.out(2)
        else:
            if plan["opening"]["bars"]:
                if not anchor.field("L"):
                    raise ValueError("Opening requires an explicit anchor L: declaration; units must be identical.")
                settings.update(opening=plan["opening"], label=plan["opening"]["label"],
                                budget=plan["opening"]["max_tokens"])
                node = graph.node("bno84.ScoreOpening", "opening", **shared, seed=seed, anchor=anchor_abc, settings=canonical(settings))
                opening, data, context = node.out(0), node.out(1), node.out(2)
            else:
                opening, data, context = "", dict(opening_bars=0, diagnostics=[]), None
            joined = graph.node("bno84.ScoreJoin", "join", anchor=anchor_abc, opening=opening, data=data,
                                tempo=fixed["Q"] if not plan["opening"]["bars"] and plan["header"]["tempo"]["policy"] == "set" else "")
            final, data = joined.out(0), joined.out(1)
            if plan["continuation"]["enabled"]:
                settings = dict(budget=plan["continuation"]["max_tokens"] or 8192, sampling=sampling, fixed=fixed)
                node = graph.node("bno84.ScoreContinue", "continue", **shared, seed=score.derive_seed(seed, "continuation"),
                                  abc=final, data=data, settings=canonical(settings))
                final, data, context = node.out(0), node.out(1), node.out(2)
            elif context is None:
                context = graph.node("bno84.ScoreContext", "context", clip=shared["clip"]).out(0)
        facts = dict(source=plan["source"]["kind"],
                     cut=None if anchor is None else dict(start=plan["anchor"]["start"], end=plan["anchor"]["start"] + anchor.length),
                     header=plan["header"], diagnostics=diagnostics)
        result = graph.node("bno84.ScoreResult", "result", abc=final, data=data, context=context, facts=canonical(facts),
                            lyrics=shared["lyrics"], style=shared["style"], mode=mode, seed=seed)
        return io.NodeOutput(*(result.out(index) for index in range(7)), expand=graph.finalize())


SCORE_NODES = [YuE2Score, ScoreGenerate, ScoreOpening, ScoreJoin, ScoreContinue, ScoreContext, ScoreResult]
