"""Continue an ABC prefix using ComfyUI's native YuE2 planner interface."""


import math
import hashlib

# YuE2-3B's context. Kept here so budget checks also run without ComfyUI imports.
CONTEXT = 24576


def check_planning_context(tokens, budget, context=CONTEXT):
    used = len(tokens["prefix"]) + len(tokens["abc_ids"])
    if budget < 1 or used + budget > context:
        raise ValueError(f"ABC planning needs {used} prompt + {budget} new tokens, exceeding the {context}-token context. "
                         "Shorten the prompt or reduce the token budget.")


def check_music_context(tokens, seconds=0, frames_per_second=25, context=CONTEXT):
    """Check semantic capacity and room for one acoustic frame, matching native YuE2."""
    abc = len(tokens["abc_ids"])
    positive = len(tokens["prefix"]) + abc + 2  # ABC_END, MUSIC_START
    negative = len(tokens.get("negative", [])) + abc + 3  # ABC_START, ABC_END, MUSIC_START
    used = max(positive, negative)
    available = context - used
    needed = max(1, math.ceil(seconds * frames_per_second))
    if positive + 5 > context or available < needed:
        raise ValueError(f"Score and prompts leave {max(0, available) / frames_per_second:.1f} s of audio context, "
                         f"but the score needs about {seconds:.1f} s. Shorten the score, style or lyrics.")
    return used, available


def generate_abc(clip, style, lyrics, seed, mode, max_abc_tokens, prefix="",
                 temperature=0.7, top_p=0.9, top_k=30,
                 repetition_penalty=1.005, penalty_window=100):
    """Generate a fresh score or finish an arbitrary (possibly partial) ABC prefix.

    Native generation omits ABC_END from its returned ids. Returning fewer ids
    than the requested budget therefore means it reached ABC_END.
    """
    options = dict(lyrics=lyrics, cot=mode, seed=seed, max_tokens=max_abc_tokens,
                   penalty_window=penalty_window)
    if prefix:
        options["abc"] = prefix
    tokens = clip.tokenize(style, **options)
    check_planning_context(tokens, max_abc_tokens)
    partial = list(tokens["abc_ids"])
    # Leave tokenizer-owned data intact; abc_ids must not be counted twice.
    request = {**tokens, "prefix": tokens["prefix"] + partial, "abc_ids": []}
    generated = clip.generate(
        request, max_length=max_abc_tokens, temperature=temperature,
        top_p=top_p, top_k=top_k, repetition_penalty=repetition_penalty,
        seed=seed,
    )
    ended = len(generated) < max_abc_tokens
    metadata = dict(prompt_tokens=len(request["prefix"]), prefix_tokens=len(partial),
                    generated_tokens=len(generated), budget=max_abc_tokens,
                    ended=ended, stop_reason="end" if ended else "budget")
    return clip.decode(partial + generated), ended, metadata


def continue_abc(clip, opening, style, lyrics, seed, mode, max_abc_tokens,
                 temperature=0.7, top_p=0.9, top_k=30,
                 repetition_penalty=1.005, penalty_window=100):
    """Keep the legacy continuation return contract."""
    abc, ended, _ = generate_abc(
        clip, style, lyrics, seed, mode, max_abc_tokens, prefix=opening,
        temperature=temperature, top_p=top_p, top_k=top_k,
        repetition_penalty=repetition_penalty, penalty_window=penalty_window,
    )
    return abc, ended


def extend_abc(clip, abc, style, lyrics, seed, mode, max_abc_tokens, **sampling):
    if not abc.strip():
        raise ValueError("ABC extension requires a nonempty source score.")
    # Keep both voices and rests intact.
    return continue_abc(clip, abc.rstrip() + "\n", style, lyrics, seed, mode, max_abc_tokens, **sampling)[0]


def complete_header(clip, style, lyrics, seed, mode, lines_spec, validate_line,
                    label="", line_tokens=64, attempts=3, **sampling):
    """Complete free header lines, retaining only the first newline-terminated line.

    ``lines_spec`` is native-order (field, value) pairs; None means model-owned.
    The caller supplies the score dialect's field validator. Returned records
    distinguish given/generated lines and retain retry failures and token use.
    An empty spec requests native fresh generation and returns an empty prefix.
    """
    if not lines_spec:
        return "", []
    if line_tokens < 1 or attempts < 1:
        raise ValueError("Header line budget and attempts must be positive.")
    if any(c in label for c in "\r\n"):
        raise ValueError("Header label must be single-line text.")
    prefix, records = "", []
    voices = set()
    for index, (field, value) in enumerate(lines_spec):
        record = dict(field=field, given=value is not None, attempts=[])
        if value is not None:
            validate_line(field, value)
        else:
            request_prefix = prefix + field + ":"
            for attempt in range(attempts):
                text = f"yue2-score/header/v1:{seed}:{index}:{attempt}"
                line_seed = int.from_bytes(hashlib.blake2b(text.encode("ascii"), digest_size=8).digest(), "big")
                abc, _, metadata = generate_abc(clip, style, lyrics, line_seed, mode, line_tokens,
                                                 prefix=request_prefix, **sampling)
                receipt = dict(seed=str(line_seed), generated_tokens=metadata["generated_tokens"])
                record["attempts"].append(receipt)
                try:
                    if not abc.startswith(request_prefix):
                        raise ValueError("Tokenizer did not preserve the header prefix.")
                    suffix = abc[len(request_prefix):]
                    if "\n" not in suffix:
                        raise ValueError("Header line did not finish within its token budget.")
                    value = suffix.split("\n", 1)[0].strip()
                    validate_line(field, value)
                    if field == "V" and value.split()[0] in voices:
                        raise ValueError("Duplicate V: declaration.")
                    break
                except ValueError as error:
                    receipt["error"] = str(error)
            else:
                raise ValueError(f"Could not complete {field}: after {attempts} attempts: {receipt['error']}")
        if field == "V":
            voice = value.split()[0]
            if voice in voices:
                raise ValueError("Duplicate V: declaration.")
            voices.add(voice)
        line = field + ":" + value
        prefix += line + "\n"
        records.append({**record, "line": line})
    if lines_spec[-1][0] != "K":
        raise ValueError("Header completion must end with K:.")
    if label.strip():
        prefix += "% " + label.strip() + "\n"
    return prefix, records
