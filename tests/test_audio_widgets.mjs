import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let extension;
const source = readFileSync(new URL("../web/audio_widgets.js", import.meta.url), "utf8");
new Function("app", source.replace(/^import .*;$/m, ""))({
  registerExtension(value) { extension = value; },
});

function createAudioWidgets(definition) {
  const widgets = [];
  for (const [name, [type]] of Object.entries(definition.input.required)) {
    if (type === "COMBO") widgets.push({ name, value: "(none)" });
    if (type === "AUDIO_UI") widgets.push({ name });
    if (type === "AUDIOUPLOAD") {
      assert.ok(widgets.some((widget) => widget.name === "audioUI"), "Native upload needs the player first");
      widgets.push({ name });
    }
  }
  return widgets;
}

test("optional loader creates the native player before the upload widget", () => {
  const definition = {
    name: "bno84.OptionalLoadAudio",
    input: { required: { audio: ["COMBO", { audio_upload: true }], upload: ["AUDIOUPLOAD", {}] } },
  };
  assert.throws(() => createAudioWidgets(definition), /Native upload needs the player first/);
  extension.beforeRegisterNodeDef({}, definition);
  assert.deepEqual(createAudioWidgets(definition).map((widget) => widget.name), ["audio", "audioUI", "upload"]);
});

test("exporter also gets the native playback widget", () => {
  const definition = { name: "bno84.SaveYuE2Bundle", input: { required: { audio: ["AUDIO", {}] } } };
  extension.beforeRegisterNodeDef({}, definition);
  assert.deepEqual(definition.input.required.audioUI, ["AUDIO_UI", {}]);
});

test("empty audio has no media URL and chosen files retain native behavior", () => {
  let removed = 0, fileUpdates = 0, configured = 0;
  const audio = { name: "audio", value: "(none)", callback() { fileUpdates++; } };
  const preview = { name: "audioUI", value: "old-url", element: {
    removeAttribute(name) { assert.equal(name, "src"); removed++; },
    classList: { add() {} },
  } };
  const node = { comfyClass: "bno84.OptionalLoadAudio", widgets: [audio, preview], onGraphConfigured() { configured++; } };
  extension.nodeCreated(node);
  assert.equal(preview.value, "");
  audio.callback("(none)");
  assert.equal(fileUpdates, 0);
  audio.value = "reference.flac";
  audio.callback(audio.value);
  assert.equal(fileUpdates, 1);
  node.onGraphConfigured();
  assert.equal(configured, 1);
  assert.equal(removed, 2);
});
