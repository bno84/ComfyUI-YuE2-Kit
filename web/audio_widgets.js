// Reuse ComfyUI's native audio player for our loader and exporter. The native
// upload hook recognizes audio_upload on any node, but creates audioUI only for
// built-in node names. Its AUDIOUPLOAD widget requires audioUI to exist first.
import { app } from "../../scripts/app.js";

const audioNodes = new Set(["bno84.OptionalLoadAudio", "bno84.SaveYuE2Bundle", "bno84.EmbedYuE2KitSong"]);

function clearEmptyPreview(node) {
  const source = node.widgets?.find((widget) => widget.name === "audio");
  const preview = node.widgets?.find((widget) => widget.name === "audioUI");
  if (source?.value !== "(none)" || !preview?.element) return;
  preview.element.removeAttribute("src");
  preview.element.classList.add("empty-audio-widget");
  preview.value = "";
  preview.callback?.("");
}

app.registerExtension({
  name: "bno84.YuE2AudioWidgets",
  beforeRegisterNodeDef(_nodeType, nodeData) {
    if (!audioNodes.has(nodeData.name)) return;
    const required = { ...nodeData.input.required };
    // Native Comfy.UploadAudio may already have appended upload. Reinsert it
    // after audioUI so widget creation follows its required dependency order.
    const upload = required.upload;
    delete required.upload;
    // Show the save node's optional FLAC player info with its other settings, above the player.
    for (const name of ["flac_player_info", "flac_artist", "flac_title", "flac_instrumental_lyrics"]) {
      const input = nodeData.input.optional?.[name];
      if (!input) continue;
      delete nodeData.input.optional[name];
      required[name] = input;
    }
    required.audioUI = ["AUDIO_UI", {}];
    if (upload) required.upload = upload;
    // Embed YuE2 Kit song keeps its player and upload with the audio choice, above its stored song data.
    // The frontend follows input_order when the definition has one.
    if (nodeData.name === "bno84.EmbedYuE2KitSong") {
      const first = ["audio", "audioUI", "upload"].filter((name) => name in required);
      const order = [...first, ...Object.keys(required).filter((name) => !first.includes(name))];
      nodeData.input.required = Object.fromEntries(order.map((name) => [name, required[name]]));
      if (nodeData.input_order) nodeData.input_order = { ...nodeData.input_order, required: order };
      return;
    }
    nodeData.input.required = required;
  },
  nodeCreated(node) {
    if (node.comfyClass !== "bno84.OptionalLoadAudio") return;
    const source = node.widgets?.find((widget) => widget.name === "audio");
    if (source) {
      const callback = source.callback;
      source.callback = function (value, ...args) {
        if (source.value === "(none)") clearEmptyPreview(node);
        else return callback?.call(this, value, ...args);
      };
    }
    const onGraphConfigured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) {
      const result = onGraphConfigured?.apply(this, args);
      clearEmptyPreview(this);
      return result;
    };
    clearEmptyPreview(node);
  },
});
