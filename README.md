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
with its ABC score. It can also transcribe reference audio to ABC with
SheetSage2, and extend that score before synthesis.

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

Drop reference audio onto the **Reference audio** node at the top left,
or use its upload button. Both switches are grouped in **Reference controls**
directly below it:

- **Use transcription:** use the reference recording instead of fresh planning.
- **Extend transcribed ABC:** continue the transcription through the planner.

Choose the transcription model with **SheetSage2** in the main **Models** panel.

With **Use transcription** off, the branch is bypassed automatically. Missing
encoder and reference-audio files are not validated, and SheetSage2 is not loaded.
The template uses ComfyUI's standard Load Audio, Load Audio Encoder, and Boolean
nodes. The checkbox is wired through Planning into the transcription branch.
A small frontend binding follows that wire and synchronizes native bypass mode;
no custom loader is needed. The state is rechecked before prompt
compilation, including API export. A disconnected branch control reports an
error before the prompt is compiled.

`max_duration` is an upper limit on audio length, not a target.

## Tests

```bash
node --test tests/*.mjs                  # widgets and branch controls
python3 -m unittest discover -s tests      # score-prefix continuation
```
