# API controls

[`api/yue2-kit-song.api.json`](../api/yue2-kit-song.api.json) covers every
reference path. Change input values rather than the graph wiring.

| Control | Input |
| --- | --- |
| Reference source | `33.inputs.source`: `None`, `ABC`, or `Transcribe` |
| Reference score, recording, extension | `33.inputs.abc`, `audio`, `extend` |
| Instrumental | `32.inputs.instrumental`; also supply an instrumental section plan in `lyrics` |
| Lyrics and style | `32.inputs.lyrics`, `style` |
| Shared seed | `3.inputs.value` |
| YuE2 checkpoint | `34:51.inputs.name` |
| SheetSage2 file | `34:52.inputs.name` |
| Instrumental AR LoRA file | `34:53.inputs.name` |
| NAR LoRA file and strength | `59.inputs.lora_name`, `strength_model`; `(none)` or zero disables it |
| Preview soundfont | `22.inputs.soundfont`; `(none)` disables playback |
| Visualizer video | `55.inputs.enabled` |
| Visualizer still | `54.inputs.image` |
| Maximum duration switch | `31:14.inputs.switch` |
| Maximum seconds | `31:57.inputs.value` |
| Duration margin | `31:58.inputs.value` |

## Reusing Reference input

Connect either an optional SheetSage2 file or a loaded `AUDIO_ENCODER` to
**transcription_model**. The **Transcribe now** button queues a dedicated
transcription job using that input and the selected Full/Melody mode.
It does not need downstream transcription nodes or generate a song.

On success, the result fills the ABC editor and selects ABC. **Cancel** affects
only this transcription job. If the reference changes while it runs, newer
ABC edits are kept. Only the selected reference input is validated; inactive
text, recordings, and model files do not block other paths.

For notation or playback in your own graph, connect the reference's **ABC**
output to an ABC Preview node. In the template, ABC Preview shows the final
score after any extension.

## Older workflows

Workflows saved from the 0.3.0 template or earlier load with bypassed branches
re-enabled so Reference input and Instrumental route correctly. Their direct
native loaders still require optional files. Use the current template for
optional model-file handling.
