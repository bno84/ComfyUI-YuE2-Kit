"""YuE2-Kit: score continuation, optional audio input, optional model files, and paired song/score export."""

import asyncio
import json
import logging
import shutil
from pathlib import Path

import folder_paths
from aiohttp import web
from comfy_api.latest import ComfyExtension, io, ui
from comfy_extras.nodes_audio import LoadAudio
from comfy_extras.nodes_yue2 import YuE2GenerateABC
from server import PromptServer

from .history import SongIndex, parse_score, resolve_song, slice_score, song_detail, summary
from .model_files import file_choices, missing_message, resolve, workflow_models
from .planning import check_music_context, extend_abc
from .optional_lora import load_optional_lora
from .score import preview as score_preview
from .score_nodes import SCORE_NODES

WEB_DIRECTORY = "./web"

# The template's file nodes describe the default model files; nothing else does.
TEMPLATE_MODELS = workflow_models(json.loads(
    (Path(__file__).parent / "example_workflows" / "YuE2 Kit - Song workflow.json").read_text(encoding="utf-8")))
FILE_FOLDERS = {}


def model_file_node(folder, node_id, display_name, loader, required):
    """A file choice for a native loader, found by name in any subfolder.

    Naming ``name`` in validate_inputs replaces ComfyUI's "value in list" check.
    A required file is still checked before queueing. An optional file is only
    checked when a lazy switch actually asks for its loader, so a missing one
    does not block the paths that do not use it.
    """

    class ModelFile(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            when = "before queueing" if required else "only when the workflow uses it"
            return io.Schema(
                node_id=node_id,
                display_name=display_name,
                category="audio/YuE2",
                description=(
                    f"Chooses a file in models/{folder} for {loader}. The same file name in another "
                    f"subfolder is also found. The file is checked {when}."
                ),
                inputs=[
                    io.Combo.Input("name", options=file_choices(
                        node_id, folder_paths.get_filename_list(folder), required, TEMPLATE_MODELS),
                        tooltip="The template's optional files are listed even when not installed; Model files shows which are."),
                ],
                # Native legacy loaders declare their file list as the input type,
                # which only an Any output can connect to.
                outputs=[io.AnyType.Output("file", display_name="file")],
            )

        @classmethod
        def validate_inputs(cls, name):
            if not required or resolve(name, folder_paths.get_filename_list(folder)):
                return True
            return missing_message(folder, name, TEMPLATE_MODELS)

        @classmethod
        def fingerprint_inputs(cls, name):
            return resolve(name, folder_paths.get_filename_list(folder))

        @classmethod
        def execute(cls, name):
            found = resolve(name, folder_paths.get_filename_list(folder))
            if found is None:
                raise ValueError(missing_message(folder, name, TEMPLATE_MODELS))
            return io.NodeOutput(found)

    ModelFile.__name__ = ModelFile.__qualname__ = node_id.removeprefix("bno84.")
    FILE_FOLDERS[node_id] = folder
    return ModelFile


CheckpointFile = model_file_node(
    "checkpoints", "bno84.CheckpointFile", "Checkpoint file", "Load Checkpoint", required=True)
OptionalAudioEncoderFile = model_file_node(
    "audio_encoders", "bno84.OptionalAudioEncoderFile", "Audio encoder file (optional)", "Audio Encoder Loader", required=False)
OptionalLoraFile = model_file_node(
    "loras", "bno84.OptionalLoraFile", "LoRA file (optional)", "Load LoRA", required=False)


class OptionalModelLora(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.OptionalModelLora",
            display_name="Load LoRA (Model Only, Optional)",
            category="audio/YuE2",
            description="Apply a ComfyUI-format LoRA to the acoustic model. (none) or strength zero passes the model through unchanged.",
            inputs=[
                io.Model.Input("model"),
                io.Combo.Input("lora_name", options=["(none)", *folder_paths.get_filename_list("loras")]),
                io.Float.Input("strength_model", default=1.0, min=-100.0, max=100.0, step=0.01),
            ],
            outputs=[io.Model.Output()],
        )

    @classmethod
    def validate_inputs(cls, lora_name, strength_model):
        if lora_name == "(none)" or strength_model == 0:
            return True
        if resolve(lora_name, folder_paths.get_filename_list("loras")):
            return True
        return missing_message("loras", lora_name, TEMPLATE_MODELS)

    @classmethod
    def execute(cls, model, lora_name, strength_model):
        return io.NodeOutput(load_optional_lora(model, lora_name, strength_model))


class ModelStatus(io.ComfyNode):
    """Display only: the frontend lists the known model files and whether they are installed."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.ModelStatus",
            display_name="Model files",
            category="audio/YuE2",
            description="Shows the model files the workflow's file nodes select, whether each is installed, and where to get described ones. Not part of the prompt.",
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls):
        return io.NodeOutput()


if getattr(PromptServer, "instance", None) is not None:
    @PromptServer.instance.routes.post("/yue2-kit/resolve")
    async def resolve_model_files(request):
        """For each {type, name}: its models folder and the installed entry, or null for other node types."""
        found = []
        for item in await request.json():
            folder = FILE_FOLDERS.get(item.get("type"))
            found.append(folder and {
                "folder": folder, "installed": resolve(str(item.get("name", "")), folder_paths.get_filename_list(folder)),
            })
        return web.json_response(found)


class SongHistory(io.ComfyNode):
    """Display only: the frontend lists saved songs and restores their settings into the graph."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.SongHistory",
            display_name="Song history",
            category="audio/YuE2",
            description=(
                "Lists songs saved as FLAC + ABC pairs, newest first. Play them, select bars to reuse as a "
                "reference, and restore the seed, lyrics and style they were made with. Not part of the prompt."
            ),
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls):
        return io.NodeOutput()


SONGS = SongIndex()


def _bad_request(error):
    return web.json_response({"error": str(error)}, status=400)


if getattr(PromptServer, "instance", None) is not None:
    @PromptServer.instance.routes.post("/yue2-kit/score/preview")
    async def preview_score(request):
        try:
            body = await request.json()
            return web.json_response(score_preview(**body))
        except (ValueError, TypeError, KeyError, ZeroDivisionError) as error:
            return _bad_request(error)

    @PromptServer.instance.routes.get("/yue2-kit/history")
    async def list_songs(request):
        try:
            offset = max(0, int(request.query.get("offset", 0)))
            limit = min(100, max(1, int(request.query.get("limit", 20))))
        except ValueError as error:
            return _bad_request(error)
        found = await asyncio.to_thread(
            SONGS.list, folder_paths.get_output_directory(), request.query.get("q", ""), offset, limit)
        return web.json_response(found)

    @PromptServer.instance.routes.get("/yue2-kit/history/song")
    async def get_song(request):
        try:
            return web.json_response(await asyncio.to_thread(
                song_detail, folder_paths.get_output_directory(), request.query.get("path", "")))
        except (OSError, ValueError) as error:
            return _bad_request(error)

    @PromptServer.instance.routes.post("/yue2-kit/history/slice")
    async def slice_song(request):
        try:
            body = await request.json()
            _, score = resolve_song(folder_paths.get_output_directory(), str(body.get("path", "")))
            abc, warnings = slice_score(score.read_text(encoding="utf-8"), int(body["start"]), int(body["end"]))
        except (OSError, ValueError, KeyError, TypeError) as error:
            return _bad_request(error)
        return web.json_response({"abc": abc, "warnings": warnings})


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
                io.Combo.Input("transcription_mode", options=["full", "melody"], default="full",
                               tooltip="Match YuE2 score mode: full includes chords; melody transcribes melody only."),
                io.AnyType.Input("transcription_model", optional=True, lazy=True,
                                 tooltip="Connect Audio encoder file (optional) or a loaded AUDIO_ENCODER. Used only by Transcribe now."),
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
    def check_lazy_status(cls, **kwargs):
        # The button queues its own job; ordinary execution never needs the model file.
        return []

    @classmethod
    def execute(cls, source, abc, audio, extend, transcription_mode="full", transcription_model=None):
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
        abc = extend_abc(**kwargs)
        tokens = kwargs["clip"].tokenize(kwargs["style"], lyrics=kwargs["lyrics"], cot=kwargs["mode"], abc=abc)
        check_music_context(tokens, summary(parse_score(abc))["seconds"])
        return io.NodeOutput(abc)


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
            outputs=[
                io.String.Output("files"),
                io.Audio.Output("audio"),
                io.String.Output("abc"),
            ],
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
        return io.NodeOutput("\n".join(files), audio, abc, ui=ui.SavedAudios(saved))


class YuE2KitExtension(ComfyExtension):
    async def get_node_list(self):
        return [
            SaveYuE2Bundle, OptionalLoadAudio, ReferenceInput, YuE2ExtendABC, LyricsStyle,
            CheckpointFile, OptionalAudioEncoderFile, OptionalLoraFile, OptionalModelLora, ModelStatus,
            SongHistory, *SCORE_NODES,
        ]


# The template's visualizer starts from this still, but LoadImage only lists
# ComfyUI's input folder. Copy it there once; a user's file of that name stays.
DEFAULT_STILL = Path(__file__).parent / "example_inputs" / "yue2-kit-still.png"


def copy_default_still():
    target = Path(folder_paths.get_input_directory()) / DEFAULT_STILL.name
    try:
        if not target.exists():
            shutil.copyfile(DEFAULT_STILL, target)
    except OSError as error:
        logging.warning("YuE2-Kit could not copy %s to the input folder: %s", DEFAULT_STILL.name, error)


async def comfy_entrypoint():
    copy_default_still()
    return YuE2KitExtension()
