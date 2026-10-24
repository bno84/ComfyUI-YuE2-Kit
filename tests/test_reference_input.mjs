import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/reference_input.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
let extension;
const { referenceFileKind, audioViewPath } = new Function("app", "api", source + "\nreturn {referenceFileKind,audioViewPath};")(
  { registerExtension(value) { extension = value; } }, {},
);

test("reference drops identify ABC and audio even without a browser MIME type", () => {
  assert.equal(referenceFileKind({ name: "score.ABC", type: "" }), "ABC");
  assert.equal(referenceFileKind({ name: "reference.flac", type: "" }), "Transcribe");
  assert.equal(referenceFileKind({ name: "recording", type: "audio/wav" }), "Transcribe");
  assert.equal(referenceFileKind({ name: "clip.mp4", type: "video/mp4" }), "Transcribe");
  assert.equal(referenceFileKind({ name: "workflow.json", type: "application/json" }), null);
  assert.equal(referenceFileKind(undefined), null);
});

test("audio preview preserves subfolders and safely encodes file names", () => {
  const url = new URL(audioViewPath("songs/a #1.wav"), "http://localhost");
  assert.equal(url.searchParams.get("filename"), "a #1.wav");
  assert.equal(url.searchParams.get("subfolder"), "songs");
  assert.equal(url.searchParams.get("type"), "input");
});

test("the reference panel does not modify unrelated native audio nodes", () => {
  const node = { comfyClass: "LoadAudio" };
  extension.nodeCreated(node);
  assert.deepEqual(node, { comfyClass: "LoadAudio" });
});
