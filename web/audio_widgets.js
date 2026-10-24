// Reuse ComfyUI's native audio player for our loader and exporter. The native
// upload hook recognizes audio_upload on any node, but creates audioUI only for
// built-in node names. Its AUDIOUPLOAD widget requires audioUI to exist first.
import { app } from "../../scripts/app.js";

const audioNodes = new Set(["bno84.OptionalLoadAudio", "bno84.SaveYuE2Bundle"]);

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
    required.audioUI = ["AUDIO_UI", {}];
    if (upload) required.upload = upload;
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
