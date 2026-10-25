"""YuE2-Kit: score continuation, optional audio input, SheetSage2 loading, and paired song/score export."""

from pathlib import Path

import folder_paths
from comfy_api.latest import ComfyExtension, io, ui
from comfy_extras.nodes_audio import LoadAudio
from comfy_extras.nodes_yue2 import YuE2GenerateABC

from .planning import extend_abc

WEB_DIRECTORY = "./web"


class LyricsStyle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.LyricsStyle",
            display_name="Lyrics + style",
            category="audio/YuE2",
            description="Lyrics or an instrumental section plan, style, and the optional instrumental LoRA control. Instrumental format warnings are advisory; text is passed through unchanged.",
            inputs=[
                io.Boolean.Input("instrumental", default=False),
                io.String.Input("lyrics", multiline=True, default="", dynamic_prompts=False,
                                tooltip="Instrumental: [instrumental], lowercase section tags, or timed tags such as [intro 0:00-0:15]. One tag per line; no sung words or production notes."),
                io.String.Input("style", multiline=True, default="", dynamic_prompts=False,
                                tooltip="YuE2 style tags: genre, instruments, mood, and BPM."),
            ],
            outputs=[
                io.String.Output("lyrics", display_name="Lyrics"),
                io.String.Output("style", display_name="Style"),
                io.Boolean.Output("instrumental", display_name="Instrumental"),
            ],
        )

    @classmethod
    def execute(cls, instrumental, lyrics, style):
        return io.NodeOutput(lyrics, style, instrumental)


class OptionalLoadAudio(LoadAudio):
    @classmethod
    def define_schema(cls):
        source = LoadAudio.define_schema()
        source.inputs[0].options.insert(0, "(none)")
        source.inputs[0].default = "(none)"
        return io.Schema(
            node_id="bno84.OptionalLoadAudio",
            display_name="Load Audio (Optional)",
            category="audio/YuE2",
            description="Native audio loader with a (none) choice for an inactive transcription branch.",
            inputs=source.inputs,
            outputs=[io.Audio.Output()],
        )

    @classmethod
    def validate_inputs(cls, audio):
        return True if audio == "(none)" else LoadAudio.validate_inputs(audio)

    @classmethod
    def fingerprint_inputs(cls, audio):
        return None if audio == "(none)" else LoadAudio.fingerprint_inputs(audio)

    @classmethod
    def execute(cls, audio):
        if audio == "(none)":
            raise ValueError("Choose a source audio file before enabling SheetSage2 transcription.")
        return LoadAudio.execute(audio)


class ReferenceInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        files = LoadAudio.define_schema().inputs[0].options
        return io.Schema(
            node_id="bno84.ReferenceInput",
            display_name="Reference input",
            category="audio/YuE2",
            inputs=[
                io.Combo.Input("source", options=["None", "ABC", "Transcribe"], default="None"),
                io.String.Input("abc", multiline=True, default="", dynamic_prompts=False),
                io.Combo.Input("audio", options=["", *files], default=""),
                io.Boolean.Input("extend", default=False),
            ],
            outputs=[
                io.String.Output("abc", display_name="ABC"),
                io.Audio.Output("audio", display_name="Audio"),
                io.Boolean.Output("use_reference", display_name="Use reference"),
                io.Boolean.Output("transcribe", display_name="Transcribe"),
                io.Boolean.Output("extend", display_name="Extend"),
            ],
        )

    @classmethod
    def validate_inputs(cls, source, abc, audio):
        if source not in ("None", "ABC", "Transcribe"):
            return "Choose None, ABC, or Transcribe as the reference source."
        if source == "ABC" and not abc.strip():
            return "Reference ABC is empty. Paste a score or drop an .abc file."
        if source == "Transcribe":
            return LoadAudio.validate_inputs(audio)
        return True

    @classmethod
    def fingerprint_inputs(cls, source, audio, **kwargs):
        return LoadAudio.fingerprint_inputs(audio=audio) if source == "Transcribe" else None

    @classmethod
    def execute(cls, source, abc, audio, extend):
        valid = cls.validate_inputs(source, abc, audio)
        if valid is not True:
            raise ValueError(valid)
        payload = LoadAudio.execute(audio=audio)[0] if source == "Transcribe" else None
        return io.NodeOutput(
            abc if source == "ABC" else "", payload,
            source != "None", source == "Transcribe", source != "None" and extend,
        )


class YuE2ExtendABC(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.YuE2ExtendABC",
            display_name="YuE2 Extend ABC",
            category="model/conditioning/yue2",
            description="Continue the supplied score with the native YuE2 planner, preserving it as an unchanged prefix. max_abc_tokens budgets new tokens, not the total score length.",
            inputs=[io.String.Input("abc", force_input=True), *YuE2GenerateABC.define_schema().inputs],
            outputs=[io.String.Output(display_name="abc")],
        )

    @classmethod
    def execute(cls, **kwargs):
        return io.NodeOutput(extend_abc(**kwargs))


class SaveYuE2Bundle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.SaveYuE2Bundle",
            display_name="Save YuE2 FLAC + ABC",
            category="audio/YuE2",
            inputs=[
                io.Audio.Input("audio"),
                io.String.Input("abc", force_input=True),
                io.String.Input("filename_prefix", default="audio/yue2/song"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[io.String.Output("files")],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Export again even when a fixed seed lets all generation nodes be cached.
        return float("nan")

    @classmethod
    def execute(cls, audio, abc, filename_prefix):
        if not abc.strip():
            raise ValueError("An ABC score is required; connect YuE2 Generate ABC.")
        saved = ui.AudioSaveHelper.save_audio(
            audio, filename_prefix, io.FolderType.output, cls, format="flac"
        )
        files = []
        for result in saved:
            path = Path(folder_paths.get_output_directory()) / result.subfolder / result.filename
            score = path.with_suffix(".abc")
            # Never infer the filename by scanning for the newest audio file.
            with score.open("x", encoding="utf-8") as handle:
                handle.write(abc)
            files.extend([str(path), str(score)])
        return io.NodeOutput("\n".join(files), ui=ui.SavedAudios(saved))


class YuE2KitExtension(ComfyExtension):
    async def get_node_list(self):
        return [SaveYuE2Bundle, OptionalLoadAudio, ReferenceInput, YuE2ExtendABC, LyricsStyle]


async def comfy_entrypoint():
    return YuE2KitExtension()
