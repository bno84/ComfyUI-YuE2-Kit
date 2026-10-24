"""YuE2 score continuation, optional audio input, and paired song/score export."""

from pathlib import Path

import folder_paths
from comfy_api.latest import ComfyExtension, io, ui
from comfy_extras.nodes_audio import LoadAudio
from comfy_extras.nodes_audio_encoder import AudioEncoderLoader
from comfy_extras.nodes_yue2 import YuE2GenerateABC

from .planning import extend_abc

WEB_DIRECTORY = "./web"


class OptionalLoadAudio(LoadAudio):
    @classmethod
    def define_schema(cls):
        source = LoadAudio.define_schema()
        source.inputs[0].options.insert(0, "(none)")
        source.inputs[0].default = "(none)"
        return io.Schema(
            node_id="bno84.YuE2OptionalLoadAudio",
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


class YuE2SheetSage2Loader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.YuE2SheetSage2Loader",
            display_name="Load SheetSage2 (Shared Output Weights)",
            category="model/loaders",
            description="Native audio-encoder loader with support for combined SheetSage2/MERT2 checkpoints that omit the tied output projection.",
            inputs=AudioEncoderLoader.define_schema().inputs,
            outputs=[io.AudioEncoder.Output()],
        )

    @classmethod
    def execute(cls, audio_encoder_name):
        import comfy.audio_encoders.audio_encoders
        import comfy.utils

        path = folder_paths.get_full_path_or_raise("audio_encoders", audio_encoder_name)
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        if "layer_weight" not in sd or "token_embedding.weight" not in sd:
            raise ValueError("Select a combined SheetSage2/MERT2 checkpoint.")
        # These checkpoints tie the two parameters and store only one.
        if "output_projection.weight" not in sd:
            sd["output_projection.weight"] = sd["token_embedding.weight"]
        return io.NodeOutput(comfy.audio_encoders.audio_encoders.load_audio_encoder_from_sd(sd))


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


class YuE2ExportExtension(ComfyExtension):
    async def get_node_list(self):
        return [SaveYuE2Bundle, OptionalLoadAudio, YuE2ExtendABC, YuE2SheetSage2Loader]


async def comfy_entrypoint():
    return YuE2ExportExtension()
