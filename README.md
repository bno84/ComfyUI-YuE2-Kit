# ComfyUI-YuE2-Kit

Small additions around ComfyUI's native YuE2 and SheetSage2 nodes, plus an
example song workflow.

- **Save YuE2 FLAC + ABC:** saves the song as FLAC with the exact ABC score
  beside it, under one incrementing filename.
- **YuE2 Extend ABC:** continues a score with the native YuE2 planner,
  keeping the original as an unchanged prefix.
- **Load Audio (Optional):** the native audio loader plus a `(none)` choice,
  for a transcription branch that may be off.

## Install

- **ComfyUI-Manager:** search for _YuE2-Kit_ and install it.
- **comfy-cli:** `comfy node install comfyui-yue2-kit`.
- **Manually:** `git clone https://github.com/bno84/ComfyUI-YuE2-Kit` into
  `ComfyUI/custom_nodes/`.

Then restart ComfyUI. Requires ComfyUI 0.38.0 or newer (native YuE2); no extra
Python packages.

## Example workflow

The example workflow turns lyrics and a style prompt into a song, saved as FLAC
with its ABC score. It can also use pasted ABC or transcribe reference audio with SheetSage2,
and optionally extend either score before synthesis.

Open `yue2-kit-song` from ComfyUI's template browser under
_ComfyUI-YuE2-Kit_, or load `example_workflows/yue2-kit-song.json`.
`api/yue2-kit-song.api.json` is the default, text-only path in API format.

It also needs:

- [ABC Preview](https://github.com/bno84/ComfyUI-ABCPreview) (Registry ID
  `comfyui-abcpreview`) for the sheet-music display. Playback there needs
  your own General MIDI `.sf2`.
- [`yue2_3b_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_bf16.safetensors)
  in `models/checkpoints/`.
- [`sheetsage2_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors)
  in `models/audio_encoders/`, only for transcription. The transcription block
  is bypassed by default, so text-only songs do not need this file.

The main canvas keeps reference inputs above Planning:

- **Reference audio:** drop a recording onto the native loader or use Upload.
- **Reference ABC:** paste a YuE2-compatible ABC score into the multiline editor.
- **Reference controls:** choose **Source** (`No reference`, `Transcribe audio`,
  or `ABC`) and whether to **Extend reference**.

These controls provide five paths:

1. No reference: plan a fresh score from lyrics and style; extension is ignored.
2. Transcribe audio, as-is: use the SheetSage2 score without planning changes.
3. Transcribe audio, extend: continue that score with the planner.
4. ABC, as-is: use the pasted score unchanged.
5. ABC, extend: continue the pasted score with the planner.

Choose the transcription model with **SheetSage2** in the main **Models** panel.
Only `Transcribe audio` requires reference audio or SheetSage2 files. Both are
excluded from validation and execution for the other sources. The extension
stage is shared by audio and ABC references and uses Planning's controls.
Lyrics and style are still supplied separately; choose the matching full/melody
score mode for your reference. Leave ABC blank when using another source; paste a nonempty compatible score
before selecting `ABC`.

The template uses native Load Audio, Load Audio Encoder, Custom Combo, math,
and switch nodes. The dropdown's index feeds two native comparisons that derive
wired reference/audio flags. The kit's frontend binding synchronizes native
bypass from those flags before prompt compilation, including API export. It
recognizes simple comparisons, without evaluating arbitrary expression code.
Disconnected routing flags report an error before compilation.

API examples in `api/` cover each path: `yue2-kit-song.api.json` (no reference),
`yue2-kit-audio-reference.api.json`, `yue2-kit-audio-extend.api.json`,
`yue2-kit-abc-reference.api.json`, and `yue2-kit-abc-extend.api.json`.
Set the audio filename in node `35`, or paste ABC into node `38`, as appropriate.
These are compiled snapshots; choose the corresponding file rather than
changing its source dropdown alone, since bypass rewiring happens in the UI.

`max_duration` is an upper limit on audio length, not a target.

## Tests

```bash
node --test tests/*.mjs                  # widgets and branch controls
python3 -m unittest discover -s tests      # score-prefix continuation
```
