# ComfyUI-YuE2-Kit

_An intuitive workflow for YuE2 power users._

Turn lyrics and a style prompt into music, with an ABC score. The kit brings
the Score planner, source anchoring, instrumental controls, and paired
FLAC + ABC export into one workflow. Its custom nodes also work in your own
workflows; some are still evolving.

## Install

Requires **ComfyUI 0.38.0+**. Install these packs through ComfyUI-Manager or
comfy-cli, then restart ComfyUI:

- [YuE2-Kit](https://registry.comfy.org/publishers/bno84/nodes/comfyui-yue2-kit)
  (`comfyui-yue2-kit`).
- [ABC Preview](https://registry.comfy.org/publishers/bno84/nodes/comfyui-abcpreview)
  0.3.0+ for notation, playback, and the score timeline.
- [Audio Visualizer](https://registry.comfy.org/publishers/bno84/nodes/comfyui-audiovisualizer)
  0.4.0+ for optional video export.

## Example workflow

The template flows from inputs through Score, Acoustic and Final outputs to optional video.
Lyrics + style, Seed and Models form the left column; Song history sits above Score,
and ABC Preview branches up from Score. Score's six outputs feed Acoustic, then
Final outputs and the optional visualizer on the right.

Open **YuE2 Kit - Song workflow** in the template browser under **ComfyUI-YuE2-Kit**, or
load [the workflow JSON](<example_workflows/YuE2 Kit - Song workflow.json>).

## Basic usage

1. Set **Lyrics + style** and the shared **Seed**.
2. Connect **lyrics**, **style** and **seed** to **YuE2 Score**; these are socket-only
   inputs. Use the ordinary ComfyUI widgets in score order: timeline, Header,
   Opening, Anchor, Continue and Sampling. The Song template
   starts with a **32-bar cap**, fixed **4/4**, **C major** and **88 BPM**.
3. Check **Model files**, then run. **ABC Preview** displays Score's ABC;
   **Score report** shows generation details and warnings. **Acoustic** renders it;
   **Final outputs** saves matching FLAC + ABC files.

The timeline is a read-only plan. All settings stay visible on the node face and
use standard widget serialization, input conversion and undo. The pinned frontend
supports native disabled widgets for inapplicable settings; older frontends leave
them visible and normal. Backend validation applies in either case.

Choose **Mode: full** for melody and harmony or **melody** for melody with
freer accompaniment. Melody mode does not remove existing chord symbols automatically.
**Keep the style's BPM equal to the score tempo.** Audio ignores mid-score tempo
changes, so Score normalizes them to one tempo and reports the edits.

**Acoustic** exposes maximum duration, music temperature/top p/top k/repetition
penalty, **Music guidance**, **Acoustic steps**, **Acoustic CFG**, sampler, scheduler
and denoise. Duration defaults to Score seconds + 10 seconds; Maximum duration
enables an explicit hard cap. Music guidance controls the music generator; Acoustic
CFG controls acoustic diffusion.

## Optional features

**Header mode** selects one policy for the whole header:

- **generated**: model chooses the header. With an anchor, an opening is required;
  meter and voice/unit declarations remain compatible, the opening's tempo is
  adopted across the anchor, and key changes remain experimental for audio.
- **fixed**: the visible tempo, meter and named key values apply. With an anchor,
  meter and key must match it; a differing tempo retimes it. Conflicts fail before
  model work.
- **from anchor**: requires Anchor use and keeps its header.

**Opening generate** adds the requested bars before the anchor. Its hint labels
only that opening. Candidates use first good fit, then the best available join;
this is a chord-root/structural heuristic, so audition the join in ABC Preview.
Opening controls have no effect with Anchor use off.

**Anchor use** enables the **Anchor ABC** source. Its section strip updates as you
paste or edit, even if the current header conflicts. It shows the whole source with
numbered bars; the selected range appears in the summary above it. Paste ABC, send it
from Song history, or drop an `.abc` file on the node. Drop an audio or video file to
transcribe it with SheetSage2 in the current **Mode**; **Open ABC or audio…** does the
same from a file dialog. Either one replaces the anchor and turns Anchor use on.
Transcription needs the **sheetsage2** input connected to the Models SheetSage2
file, as in the template. Only that transcription job loads SheetSage2; ordinary
Score runs use the stored ABC and never transcribe. Drag either range handle or drag
across the strip to select single bars; the stored source stays intact.

**Continue generate** adds a tail after the anchor. With Anchor use off it is
forced on and generates the whole song. It runs until the model ends the song or
**Continuation tokens** runs out; an exhausted budget trims to complete aligned
bars and reports it. Sampling controls and both token budgets are always visible.

**Song history** sits above Score. Browse saved pairs, select sections or drag bar
handles, then **Use in planner**. The selected ABC becomes the whole stored source
with a reset range; header and sampling widgets retain their values. A fixed
header that conflicts with the new source produces a visible validation error.
**Use saved score** loads final ABC as-is, turns Opening/Continue off and explicitly
selects from anchor. **Restore lyrics + style** and **Restore seed (fixed)** restore
those settings. **Restore all** also restores the Score widgets, including the
original source and mode. Saved songs outline their Opening / Anchor / Continuation
bars from their embedded Score widgets.
**Show in ABC Preview** auditions a selection until the next run. Old files may
lack public Score settings. Timing estimates can drift from audio, so
**FLAC from ≈** starts playback a little early.

**Instrumental LoRA:** enable **instrumental** in Lyrics + style and choose Score
**Full** mode. The flag selects the instrumental AR LoRA in Models for both Score
and Acoustic. Use `[instrumental]` or lowercase section tags such as `[intro]`,
`[verse]`, `[chorus]` on separate lines, without sung words. Timed tags are guidance,
not exact timing. The node warns without rewriting the input.

**NAR LoRA:** use the root node between Models and Acoustic to choose the adapter, which pairs well with
Instrumental. Start at strength **1.0**; select **(none)** or strength **0** to
turn it off. Use the ComfyUI export; no extra tokenizer is needed.

**Preview playback:** supply `GeneralUser-GS.sf2` or another General MIDI `.sf2`
in `models/soundfonts/` (subfolders work). [Get GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS).
Missing fonts leave notation available; **(none)** disables playback.

**Visualizer video:** enable it and choose a still, or use the supplied artwork.
The image sets video resolution. Saved audio from Final outputs feeds the
visualizer, so FLAC + ABC finish saving first. Disabled video does not load the
still. H.265/Opus, a smaller image or 30 FPS reduce size. FFmpeg needs `showcqt`
and the selected codecs.

## Template migration

The Song template and its API example now use **YuE2 Score**. In a custom
template, replace Reference input, the Planning/Reference score/Audio
transcription nodes, Extend ABC and ABC Timeline with Score. Store source ABC
and planning options in its named widgets; wire its ABC to Preview, its six
parallel outputs to Acoustic, and Acoustic's ABC pass-through to Final outputs.
NAR LoRA is on the root MODEL wire before Acoustic. Transcribe source audio
explicitly before running; the template never transcribes at run time.

## API and tests

Use [the Song API prompt](api/yue2-kit-song.api.json). Score inputs are plain
named values.
`anchor_start` is one-based inclusive, `anchor_end` is inclusive and 0 means
through the end. The range strip edits these two values instead of showing
number fields. For an external ABC source, connect `abc`, enable `anchor_use`,
and select a compatible `header_mode`.

```bash
node --test tests/*.mjs
python3 -m unittest discover -s tests
```
