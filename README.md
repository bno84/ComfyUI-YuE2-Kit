# ComfyUI-YuE2-Kit

_An intuitive workflow for YuE2 power users._

Turn lyrics and a style prompt into music, with an ABC score. Plan a new song,
reuse a reference, and save matching FLAC + ABC files. The custom nodes also
work in your own workflows.

## Install

Requires **ComfyUI 0.38.0+**. Install these packs through ComfyUI-Manager or
comfy-cli, then restart ComfyUI:

- [YuE2-Kit](https://registry.comfy.org/publishers/bno84/nodes/comfyui-yue2-kit)
  (`comfyui-yue2-kit`).
- [ABC Preview](https://registry.comfy.org/publishers/bno84/nodes/comfyui-abcpreview)
  **0.3.5+** for notation, playback, and the score timeline.
- [Audio Visualizer](https://registry.comfy.org/publishers/bno84/nodes/comfyui-audiovisualizer)
  **0.4.1+** for optional video export.

## Getting started

![YuE2 Kit Song workflow](docs/workflow-screenshot.png)

Open **YuE2 Kit - Song workflow** in the template browser under **ComfyUI-YuE2-Kit**.

1. Set **Lyrics + style** and the **Seed**.
2. In **YuE2 Advanced Score**, leave **Use reference** off for a fresh song,
   or supply a reference and choose whether to add an opening or continuation.
3. Check **Model files**, then run.

**ABC Preview** displays the score; **Score report** shows warnings.
**Acoustic** renders the music, and **Final outputs** saves matching FLAC + ABC
files. Keep the style's BPM equal to the score tempo.

## Features

**Score planning:** paste or drop an ABC reference, or open audio/video to
transcribe it with SheetSage2. Select the bars you want to keep, then optionally
**Generate opening** before them or **Generate continuation** after them.
Choose **full** for melody and harmony, or **melody** for freer accompaniment.

**Score properties:** **generated** lets the model choose; **locked** lets you
set tempo, meter, key, and unit note length; **reference** keeps the reference's
properties. When using a reference, locked mode keeps its meter, key, and unit
note length while allowing tempo changes. Generated properties with a reference
require an opening.

**Song history:** browse saved songs and **Use as reference** to reuse selected
bars. **Use saved score** reuses the finished score as-is. Restore lyrics and
style, the seed, or **Restore all** to recover the saved Score settings too.
Older songs may lack those settings.

**Base / Instrumental:** each tab keeps its own lyrics and style. Instrumental
also selects the instrumental AR LoRA. Use **full** score mode and
`[instrumental]` or lowercase section tags such as `[intro]`, `[verse]`, and
`[chorus]` on separate lines, without sung words.

**NAR LoRA:** an optional acoustic adapter. Start at strength **1.0**; select
**(none)** or strength **0** to disable it. Use the ComfyUI export.

**Score playback:** add [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS)
or another General MIDI `.sf2` to `models/soundfonts/`. Notation works without a
soundfont.

**Visualizer video:** enable it and choose a still, or use the supplied artwork.
The image sets the video resolution.

## API and tests

Use [the Song API prompt](api/yue2-kit-song.api.json).

```bash
node --test tests/*.mjs
python3 -m unittest discover -s tests
```
