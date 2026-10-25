# ComfyUI-YuE2-Kit

Small additions around ComfyUI's native YuE2 and SheetSage2 nodes, plus an
example song workflow.

- **Save YuE2 FLAC + ABC:** saves the song as FLAC with the exact ABC score
  beside it, under one incrementing filename.
- **YuE2 Extend ABC:** continues a score with the native YuE2 planner,
  keeping the original as an unchanged prefix.
- **Reference input:** one tabbed panel for no reference, editable/droppable ABC,
  or uploaded/dropped audio, with recording playback and optional extension.
- **Load Audio (Optional):** the original audio helper, retained for older workflows.

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

**Instrumental** in Lyrics + style enables the optional
[Mothersuperior instrumental AR LoRA](https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras).
Download `ar_lora_inst_v3abc_comfyui.safetensors` yourself, put it in
`ComfyUI/models/loras/`, refresh the model list, and select it in **Models →
Instrumental LoRA**. These weights are **CC BY-NC 4.0 (non-commercial)**; they
are not bundled or downloaded automatically. A note beside Models links to
the download. With Instrumental off (the default), the LoRA is bypassed and
the file is not needed for validation or execution.

With Instrumental on, the LoRA is applied to the YuE2 language model at
strength 1.0 for planning, extension, and music generation. The acoustic model
and VAE stay unchanged. Use score mode **full**. The toggle sends
`[instrumental]` as the section plan instead of vocal lyrics, preserving your
lyrics for when you switch it off. To supply a structure, double-click Lyrics +
style and edit **Instrumental section plan** using lowercase section tags
such as `[intro]`, `[verse]`, `[chorus]`, and `[outro]`, with no sung text.
Choose the desired instruments in Style. Existing reference ABC is retained;
the toggle does not remove vocal notes or words from a supplied score.

**Reference input** combines the reference inputs and controls in one node:

- **None:** the rest of the panel is blank. Plan a fresh score from lyrics/style.
- **ABC:** paste a score, use Open ABC, or drop an `.abc` file.
- **Transcribe:** select, upload, or drop audio. The built-in player previews
  the recording. Choose the SheetSage2 model in the main Models panel.
  **Transcribe now** queues only the connected transcription path, using that
  same model and the current score mode. On success it fills the ABC editor and
  switches to ABC, keeping Extend reference. It does not run extension or song
  generation. **Cancel** affects only this transcription job. Existing ABC edits
  are retained if you change them while transcription is running.

**Extend reference** appears for ABC and Transcribe. Off uses the chosen score
unchanged; on continues it through the shared planner. Switching tabs retains
both ABC text and the selected audio file. The node keeps its height across tabs;
the ABC textbox fills extra height when the node is resized. A file drop selects
its matching tab.
ABC files are read locally; audio uploads use ComfyUI's standard input endpoint.

The node validates and reads only the selected input. Unused audio files and
ABC text do not cause errors while None is selected. Native bypass keeps the
SheetSage2 encoder outside validation and execution for None and ABC. Explicit
score, audio, source-flag, and extension outputs are wired into Planning; the
frontend rechecks their bypass states before compiling or exporting a prompt.
No reference ignores extension. All five reference paths remain available.

Reference input handles input only. Connect its **ABC** output to a separate
**ABC Preview** node for notation or score playback. The template's existing
ABC Preview shows the final selected score after any transcription or extension.
Lyrics and style remain separate. Choose the matching full/melody mode.

API examples in `api/` cover each path: `yue2-kit-song.api.json` (None),
`yue2-kit-audio-reference.api.json`, `yue2-kit-audio-extend.api.json`,
`yue2-kit-abc-reference.api.json`, and `yue2-kit-abc-extend.api.json`.
Reference values live in node `33`: `source`, `abc`, `audio`, and `extend`.
Instrumental variants are named `yue2-kit-instrumental-*.api.json`. Their
control is `32:41.inputs.value`; the CLIP branch must also be rewired, so use
the matching instrumental snapshot rather than changing only that Boolean.
These are compiled snapshots; use the corresponding file, since bypass
rewiring happens in the UI before export.

`max_duration` is an upper limit on audio length, not a target.

## Tests

```bash
node --test tests/*.mjs                  # widgets and branch controls
python3 -m unittest discover -s tests      # score-prefix continuation
```
