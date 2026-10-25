import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/model_status.js", import.meta.url), "utf8");
let extension;
const { describeModel, selectedFiles, sourcePage } = new Function("app", "api",
  source.replace(/^import .*;$/gm, "").replaceAll("export function", "function") + "\nreturn { describeModel, selectedFiles, sourcePage };",
)({ registerExtension(value) { extension = value; } }, {});

const LORA = "ar_lora_inst_v3abc_comfyui.safetensors";
const URL_ = `https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras/resolve/main/${LORA}`;
const properties = {
  models: [{ name: LORA, url: URL_, directory: "loras" }],
  "bno84.model": { label: "Instrumental LoRA", use: "Turn it off to continue without it.", license: "CC BY-NC 4.0 (non-commercial)" },
};
const entry = (selected, installed) => ({ title: "Instrumental LoRA file", properties, selected, folder: "loras", installed });

test("the described default, installed in a subfolder, shows its path and license", () => {
  assert.deepEqual(describeModel(entry(LORA, `loras/${LORA}`)), {
    label: "Instrumental LoRA", use: properties["bno84.model"].use,
    installed: true, file: `loras/${LORA}`, license: "CC BY-NC 4.0 (non-commercial)",
  });
});

test("the described default, missing, shows its source page, license, file and folder", () => {
  assert.deepEqual(describeModel(entry(`old/${LORA}`, null)), {
    label: "Instrumental LoRA", use: properties["bno84.model"].use, installed: false,
    file: LORA, folder: "ComfyUI/models/loras/", described: true, license: "CC BY-NC 4.0 (non-commercial)",
    link: { href: "https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras", text: "Mothersuperior/YuE2-instrumental-cot-full-loras" },
  });
});

test("another selected file gets only its name, state and folder", () => {
  for (const [installed, file] of [["v4/lora_v4.safetensors", "v4/lora_v4.safetensors"], [null, "lora_v4.safetensors"]]) {
    assert.deepEqual(describeModel(entry("lora_v4.safetensors", installed)), {
      label: "Instrumental LoRA", use: properties["bno84.model"].use,
      installed: !!installed, file, folder: "ComfyUI/models/loras/",
    });
  }
  assert.deepEqual(describeModel({ title: "My LoRA", properties: {}, selected: "x.safetensors", folder: "loras", installed: null }), {
    label: "My LoRA", use: "", installed: false, file: "x.safetensors", folder: "ComfyUI/models/loras/",
  });
});

test("other hosts link to the URL by host name", () => {
  assert.deepEqual(sourcePage("https://example.org/files/x.safetensors"), { href: "https://example.org/files/x.safetensors", text: "example.org" });
});

test("selections come from the compiled prompt, including inside subgraphs", () => {
  const file = { id: 53, title: "Instrumental LoRA file", properties };
  const root = { _nodes: [{ id: 46, title: "Model files" }, { id: 34, subgraph: { _nodes: [{ id: 4 }, file] } }] };
  const output = {
    "34:4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ["34:51", 0] } },
    "34:53": { class_type: "bno84.OptionalLoraFile", inputs: { name: `loras/${LORA}` } },
  };
  assert.deepEqual(selectedFiles(root, output), [
    { id: "34:53", type: "bno84.OptionalLoraFile", title: "Instrumental LoRA file", properties, selected: `loras/${LORA}` },
  ]);
});

test("the display node stays out of compiled prompts", () => {
  const nodeType = function () {};
  extension.beforeRegisterNodeDef(nodeType, { name: "bno84.ModelStatus" });
  assert.equal(nodeType.prototype.isVirtualNode, true);
  const other = function () {};
  extension.beforeRegisterNodeDef(other, { name: "bno84.OptionalLoraFile" });
  assert.equal(other.prototype.isVirtualNode, undefined);
});
