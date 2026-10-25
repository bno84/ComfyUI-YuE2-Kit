# ComfyUI-YuE2-Kit

Small additions around ComfyUI's native YuE2 and SheetSage2 nodes, plus an
example song workflow.

- **Save YuE2 FLAC + ABC:** saves the song as FLAC with the exact ABC score
  beside it, under one incrementing filename.
- **YuE2 Extend ABC:** continues a score with the native YuE2 planner,
  keeping the original as an unchanged prefix.
- **Lyrics + style:** instrumental switch and editable prompt fields, with advisory
  instrumental-format warnings linked to the LoRA prompt guide.
- **Reference input:** one tabbed panel for no reference, editable/droppable ABC,
  or uploaded/dropped audio, with recording playback and optional extension.
- **Checkpoint file, Audio encoder file (optional), LoRA file (optional):** file
  choices for the native loaders. They find a file by name in any subfolder,
  and an optional file is only checked when the workflow uses it.
- **Model files:** shows which known model files are installed, with download
  details for missing ones.
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
`api/yue2-kit-song.api.json` is the same workflow in API format.

It also needs:

- [ABC Preview](https://github.com/bno84/ComfyUI-ABCPreview) (Registry ID
  `comfyui-abcpreview`) for the sheet-music display. Playback there needs
  your own General MIDI `.sf2`.
- [`yue2_3b_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_bf16.safetensors)
  in `models/checkpoints/`.
- Optional: [`sheetsage2_bf16.safetensors`](https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors)
  in `models/audio_encoders/`, only for Transcribe.

YuE2, SheetSage2 and the instrumental LoRA are all **CC BY-NC 4.0
(non-commercial)**, per their Hugging Face model cards (`Comfy-Org/YuE2`
repackages `m-a-p/YuE2-3B` and `m-a-p/SheetSage2`). This pack's MIT license
covers its code only.

**Instrumental** in Lyrics + style enables the optional
[Mothersuperior instrumental AR LoRA](https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras).
Download `ar_lora_inst_v3abc_comfyui.safetensors` yourself and put it in
`ComfyUI/models/loras/` or a subfolder. These weights are **CC BY-NC 4.0
(non-commercial)**; they are not bundled or downloaded automatically. With
Instrumental off (the default), the LoRA is never loaded and the file is not
needed.

With Instrumental on, the LoRA is applied to the YuE2 language model at
strength 1.0 for planning, extension, and music generation. The acoustic model
and VAE stay unchanged. Use score mode **full**. The **Lyrics + style** custom
node passes both text fields through unchanged; Instrumental selects the LoRA
without replacing your lyrics. When enabled, an amber outline and an advisory
message flag lyrics outside the model card's three supported caption forms:

- `[instrumental]` alone.
- Lowercase section tags, one per line: `intro`, `verse`, `pre-chorus`, `chorus`,
  `bridge`, or `outro`, each in brackets.
- Those same tags with time ranges, for example `[intro 0:00-0:15]`, with every
  section timed using `m:ss-m:ss`.

Use real line breaks. Sung text, production notes inside brackets, mixed timed
and untimed tags, and malformed time ranges trigger a warning. Warnings do not
block queueing or modify text. With Instrumental off, ordinary vocal lyrics
have no instrumental-format warning. Style stays a normal YuE2 tag string;
choose the genre, instruments, mood, and BPM there. Existing reference ABC is
retained; the toggle does not remove vocal notes or words from a supplied score.

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
ABC text do not cause errors while None is selected. Explicit score, audio,
source-flag, and extension outputs are wired into Planning, where ordinary
If/Else switches pick the path. A switch only evaluates the side it selects, so
SheetSage2 loads for Transcribe alone. No reference ignores extension. All
five reference paths remain available.

Reference input handles input only. Connect its **ABC** output to a separate
**ABC Preview** node for notation or score playback. The template's existing
ABC Preview shows the final selected score after any transcription or extension.
Lyrics and style remain separate. Choose the matching full/melody mode.

`max_duration` is an upper limit on audio length, not a target.

### Model files

**Models** holds every model choice: YuE2, SheetSage2, and the instrumental
LoRA. Each choice finds its file by name anywhere under the matching
`models/` folder, so `loras/ar_lora_inst_v3abc_comfyui.safetensors` also
matches the template's `ar_lora_inst_v3abc_comfyui.safetensors`. With the
default files installed, nothing needs selecting. Choose another file only to
use a different version, such as another quantization or LoRA release.

YuE2 is required. Without it, ComfyUI reports a missing model on load and
offers the download; queueing stops with download details. SheetSage2 and
the LoRA are optional: without them, the workflow still runs every path that
does not use them. Turning Instrumental on or choosing Transcribe without the
file stops at that step with download details. Their default files stay
listed in the dropdowns even when not installed, so ComfyUI does not report
them as missing required models.

**Model files**, beside Models, lists the file each choice in Models selects
and where it was found. For the template's default files it adds the source,
license, and folder when missing. For any other file it only says whether it
was found and where it looked. The details live in the template's file
nodes: ComfyUI's standard `models` entry and a `bno84.model` property. They
travel with the Models block when it is copied into another workflow. Use
**Check again** after downloading; ComfyUI finds new files without a restart.

Workflows saved from the 0.3.0 template or earlier load with their bypassed
branches re-enabled, so Reference input and Instrumental keep routing
correctly. They still use the native loaders directly, so their optional
model files are required again; load the current template to make them
optional.

### API

`api/yue2-kit-song.api.json` covers every path; change its values rather than
its wiring. Reference values live in node `33`: `source` (`None`, `ABC`, or
`Transcribe`), `abc`, `audio`, and `extend`. Instrumental is
`32.inputs.instrumental`; also set `32.inputs.lyrics` to an instrumental
section plan. Model files are `34:51` (YuE2), `34:52` (SheetSage2), and
`34:53` (instrumental LoRA), each with a `name` input.

## Tests

```bash
node --test tests/*.mjs                  # widgets and branch controls
python3 -m unittest discover -s tests      # score-prefix continuation
```
