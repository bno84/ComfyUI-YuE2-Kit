import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/legacy_bypass.js", import.meta.url), "utf8");
let extension;
const { migrateLegacyBranch } = new Function("app", source.replace(/^import .*;$/m, "").replaceAll("export function", "function") + "\nreturn { migrateLegacyBranch };")(
  { registerExtension(value) { extension = value; } },
);

function nodesOf(path) {
  const workflow = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  return [workflow, ...workflow.definitions.subgraphs].flatMap((graph) => graph.nodes);
}

// Simulate the frontend: create each node, then configure it from saved data.
function load(saved) {
  return saved.map((data) => {
    const node = {};
    extension.nodeCreated(node);
    node.onConfigure(Object.assign(node, structuredClone(data)));
    return node;
  });
}

test("the 0.3.0 template's bypassed branches load enabled and unmarked", () => {
  const saved = nodesOf("./fixtures/yue2-kit-song-0.3.0.json");
  const legacy = saved.filter((node) => node.properties?.["bno84.enabledInput"]);
  assert.deepEqual(legacy.map((node) => [node.title, node.mode]), [
    ["Instrumental LoRA", 4], ["Reference score", 4], ["Audio transcription", 4],
  ]);
  for (const node of load(saved)) {
    assert.equal(node.mode, 0, node.title);
    assert.equal(node.properties?.["bno84.enabledInput"], undefined, node.title);
  }
});

test("the current template has nothing to migrate", () => {
  for (const data of nodesOf("../example_workflows/yue2-kit-song.json")) {
    const node = structuredClone(data);
    assert.equal(migrateLegacyBranch(node), false, node.title);
    assert.equal(node.mode, 0, node.title);
  }
});

test("unmarked bypass and a deliberate mute are left alone", () => {
  const plain = { mode: 4, properties: {} };
  assert.equal(migrateLegacyBranch(plain), false);
  assert.equal(plain.mode, 4);
  const muted = { mode: 2, properties: { "bno84.enabledInput": "enabled" } };
  assert.equal(migrateLegacyBranch(muted), true);
  assert.equal(muted.mode, 2);
  assert.deepEqual(muted.properties, {});
});

test("an existing onConfigure still runs", () => {
  let called = 0;
  const node = { onConfigure() { called++; return "kept"; } };
  extension.nodeCreated(node);
  assert.equal(node.onConfigure.call(Object.assign(node, { mode: 4, properties: { "bno84.enabledInput": "enabled" } })), "kept");
  assert.equal(called, 1);
  assert.equal(node.mode, 0);
});
