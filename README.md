# ComfyUI-YuE2-Kit

Small additions around ComfyUI's native YuE2 and SheetSage2 nodes, plus an
example song workflow (`example_workflows/yue2-song.json`).

- **Save YuE2 FLAC + ABC** (`bno84.SaveYuE2Bundle`): saves the song as FLAC and the
  exact ABC score beside it under one incrementing filename. Runs again even
  when generation is cached, and has a native audio player.
- **YuE2 Extend ABC** (`bno84.YuE2ExtendABC`): continues a supplied score with the
  native YuE2 planner, keeping it as an unchanged prefix. `max_abc_tokens`
  budgets new tokens only.
- **Load Audio (Optional)** (`bno84.OptionalLoadAudio`): the native audio loader
  plus a `(none)` choice, for a transcription branch that may be inactive.
- **Load SheetSage2 (Shared Output Weights)** (`bno84.SheetSage2Loader`): the
  native audio-encoder loader for combined SheetSage2/MERT2 checkpoints,
  restoring its tied `output_projection.weight` in memory. No file is rewritten.

`web/audio_widgets.js` gives the optional loader and the exporter ComfyUI's
native audio player; keep it with the Python files.

## Requirements

ComfyUI with native YuE2 support (tested: 0.38.0, commit `6b747c0`, frontend
1.53.6). No Python packages beyond ComfyUI's own. Copy this directory to
`ComfyUI/custom_nodes/` and restart.

## Example workflow

`example_workflows/yue2-song.json` turns lyrics and a style prompt into a
song, saved as FLAC with its ABC score. Optionally it transcribes reference
audio to ABC with SheetSage2, and can extend that score with the YuE2 planner
before synthesis. Stages: Lyrics + style → Planning → ABC → Acoustic → outputs.
`yue2-song.api.json` is the same graph in API format.

It also needs:

- [ComfyUI-ABCPreview](https://github.com/bno84/ComfyUI-ABCPreview) for the
  sheet-music ABC display. Preview playback needs your own General MIDI `.sf2`
  in `models/soundfonts/`; none is included.
- `yue2_3b_bf16.safetensors` (model, language model, and VAE) in
  `models/checkpoints/`:
  <https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_bf16.safetensors>
- `SheetSage2_MERT2_bf16.safetensors` in `models/audio_encoders/`, for
  transcription. Its loader is part of the graph, so ComfyUI may reject the
  workflow without it even when transcription is off:
  <https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors>

`max_duration` is an upper limit on audio length, not a target.

## License

MIT, © 2026 bno84; see `LICENSE`.

## Tests

```bash
node --test tests/test_audio_widgets.mjs   # frontend widget order
python3 -m unittest discover -s tests       # score-prefix continuation
```
