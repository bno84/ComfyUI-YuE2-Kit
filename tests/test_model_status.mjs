import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/model_status.js", import.meta.url), "utf8");
let extension;
const { describeModel } = new Function("app", "api", source.replace(/^import .*;$/gm, "").replaceAll("export function", "function") + "\nreturn { describeModel };")(
  { registerExtension(value) { extension = value; } }, {},
);

const lora = {
  label: "Instrumental LoRA", folder: "loras", filename: "ar_lora_inst_v3abc_comfyui.safetensors",
  url: "https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras",
  link_text: "Mothersuperior/YuE2-instrumental-cot-full-loras",
  use: "Needed only when Instrumental is on. Turn it off to continue without it.",
  license: "CC BY-NC 4.0 (non-commercial)", installed: null,
};

test("an installed model shows the path it was found at and its license", () => {
  assert.deepEqual(describeModel({ ...lora, installed: "loras/ar_lora_inst_v3abc_comfyui.safetensors" }), {
    label: "Instrumental LoRA", use: lora.use, license: lora.license,
    installed: true, file: "loras/ar_lora_inst_v3abc_comfyui.safetensors",
  });
});

test("a missing model shows its source, license, file and folder", () => {
  assert.deepEqual(describeModel(lora), {
    label: "Instrumental LoRA", use: lora.use, installed: false,
    file: "ar_lora_inst_v3abc_comfyui.safetensors", folder: "ComfyUI/models/loras/",
    link: { href: lora.url, text: lora.link_text }, license: "CC BY-NC 4.0 (non-commercial)",
  });
});

test("the display node stays out of compiled prompts", () => {
  const nodeType = function () {};
  extension.beforeRegisterNodeDef(nodeType, { name: "bno84.ModelStatus" });
  assert.equal(nodeType.prototype.isVirtualNode, true);
  const other = function () {};
  extension.beforeRegisterNodeDef(other, { name: "bno84.OptionalLoraFile" });
  assert.equal(other.prototype.isVirtualNode, undefined);
});
