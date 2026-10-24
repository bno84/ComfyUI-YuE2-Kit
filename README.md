# ComfyUI-YuE2-Kit

Small additions around ComfyUI's native YuE2 and SheetSage2 nodes, plus an
example song workflow.

- **Save YuE2 FLAC + ABC:** saves the song as FLAC with the exact ABC score
  beside it, under one incrementing filename. Runs again even when
  generation is cached, and has an audio player.
- **YuE2 Extend ABC:** continues a score with the native YuE2 planner,
  keeping the original as an unchanged prefix. `max_abc_tokens` budgets new
  tokens only.
- **Load Audio (Optional):** the native audio loader plus a `(none)` choice,
  for a transcription branch that may be off.
- **Load SheetSage2 (Shared Output Weights):** loads a combined
  SheetSage2/MERT2 checkpoint, restoring its tied output weights in memory.

## Install

- **ComfyUI-Manager:** search for _YuE2-Kit_ (Registry ID `comfyui-yue2-kit`)
  and install it.
- **comfy-cli:** `comfy node install comfyui-yue2-kit`.
- **Manually:** `git clone https://github.com/bno84/ComfyUI-YuE2-Kit` into
  `ComfyUI/custom_nodes/`.

Then restart ComfyUI. Requires ComfyUI 0.38.0 or newer (native YuE2); no extra
Python packages.

## Example workflow

The example workflow turns lyrics and a style prompt into a song, saved as FLAC
with its ABC score. It can also transcribe reference audio to ABC with
SheetSage2, and extend that score before synthesis.

Open `yue2-kit-song` from ComfyUI's template browser under
_ComfyUI-YuE2-Kit_, or load `example_workflows/yue2-kit-song.json`.
`api/yue2-kit-song.api.json` is the same graph in API format.

It also needs:

- [ABC Preview](https://github.com/bno84/ComfyUI-ABCPreview) (Registry ID
  `comfyui-abcpreview`) for the sheet-music display. Playback there needs
  your own General MIDI `.sf2`.
- [`yue2_3b_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_bf16.safetensors)
  in `models/checkpoints/`.
- [`SheetSage2_MERT2_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors)
  in `models/audio_encoders/`, for transcription. Its loader is part of the
  graph, so ComfyUI may reject the workflow without it even when
  transcription is off.

`max_duration` is an upper limit on audio length, not a target.

## Tests

```bash
node --test tests/test_audio_widgets.mjs   # frontend widget order
python3 -m unittest discover -s tests      # score-prefix continuation
```
