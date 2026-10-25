import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let extension;
const source = readFileSync(new URL("../web/lyrics_style.js", import.meta.url), "utf8");
const { instrumentalPromptWarning, refreshPromptWarning } = new Function("app", source.replace(/^import .*;$/m, "").replaceAll("export function", "function") + "\nreturn { instrumentalPromptWarning, refreshPromptWarning };")({registerExtension(value) { extension = value; }});

for (const lyrics of [
  "[instrumental]", " \n[instrumental]\n", "[intro]\n[verse]\n[pre-chorus]\n[chorus]\n[bridge]\n[outro]",
  "[intro 0:00-0:15]\n[verse 0:15-0:45]\n[chorus 0:45-1:10]\n[bridge 1:10-1:40]\n[chorus 1:40-2:05]\n[outro 2:05-2:30]",
  "[intro]\r\n[chorus]",
]) test(`accepts official instrumental form: ${JSON.stringify(lyrics)}`, () => assert.equal(instrumentalPromptWarning(true, lyrics), ""));

for (const lyrics of [
  "", "[Intro]\n[Verse]", "[verse]\nSung words", "[guitar solo, distorted]", "[intro] [verse]",
  "[intro]\\n[verse]", "[instrumental]\n[chorus]", "[intro 0:00-0:15]\n[verse]",
  "[intro 0:60-1:10]", "[intro 0:15-0:10]", "[intro 0:15-0:15]", "[intro 0:0-0:15]",
]) test(`warns without blocking: ${JSON.stringify(lyrics)}`, () => {
  assert.ok(instrumentalPromptWarning(true, lyrics));
  assert.equal(instrumentalPromptWarning(false, lyrics), "");
});

test("warning outline clears after a correction or turning instrumental off, without modifying prompts", () => {
  const attributes = new Map();
  const element = {style:{},setAttribute(k,v){attributes.set(k,v);},removeAttribute(k){attributes.delete(k);}};
  const node = {widgets:[{name:"instrumental",value:true},{name:"lyrics",value:"[Verse]",element},{name:"style",value:"piano, 88 BPM"}]};
  assert.ok(refreshPromptWarning(node));
  assert.equal(element.style.outline, "2px solid #ffb74d");
  assert.equal(attributes.get("aria-invalid"), "true");
  assert.equal(node.widgets[1].value, "[Verse]");
  assert.equal(node.widgets[2].value, "piano, 88 BPM");
  node.widgets[1].value = "[verse]";
  assert.equal(refreshPromptWarning(node), "");
  assert.equal(element.style.outline, "");
  assert.equal(attributes.has("aria-invalid"), false);
  node.widgets[1].value = "arbitrary vocal lyrics";
  node.widgets[0].value = false;
  assert.equal(refreshPromptWarning(node), "");
});

test("other nodes are untouched", () => {
  const node = {comfyClass:"OtherNode"};
  extension.nodeCreated(node);
  assert.deepEqual(node, {comfyClass:"OtherNode"});
});
