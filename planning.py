"""Continue an ABC prefix using ComfyUI's native YuE2 planner interface."""


def extend_abc(clip, abc, style, lyrics, seed, mode, max_abc_tokens,
               temperature=0.7, top_p=0.9, top_k=30,
               repetition_penalty=1.005, penalty_window=100):
    if not abc.strip():
        raise ValueError("ABC extension requires a nonempty source score.")
    # Keep both voices and rests intact.
    opening = abc.rstrip() + "\n"
    tokens = clip.tokenize(
        style, lyrics=lyrics, cot=mode, abc=opening, seed=seed,
        max_tokens=max_abc_tokens, penalty_window=penalty_window,
    )
    partial = tokens["abc_ids"]
    tokens["prefix"] = tokens["prefix"] + partial
    # The score is now in prefix; avoid counting it twice in memory estimation.
    tokens["abc_ids"] = []
    continuation = clip.generate(
        tokens, max_length=max_abc_tokens, temperature=temperature,
        top_p=top_p, top_k=top_k, repetition_penalty=repetition_penalty,
        seed=seed,
    )
    return clip.decode(partial + continuation)
