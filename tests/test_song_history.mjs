import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/song_history.js", import.meta.url), "utf8");
const NAMES = ["clock", "ago", "resolveInput", "runSettings", "pastValueFor", "compareSettings", "samplingText", "sectionRange",
  "extendRange", "nearestBoundary", "groupAt", "dragRange", "rangeInfo", "findNode", "setInput"];
const lib = new Function("app", "api",
  source.replace(/^import .*;$/gm, "").replaceAll("export function", "function").replaceAll("export const", "const")
    + `\nreturn { ${NAMES.join(", ")} };`,
)({ registerExtension() {} }, {});

const PROMPT = {
  "3": { class_type: "PrimitiveInt", inputs: { value: -96369643988299 }, _meta: { title: "Seed — shared" } },
  "32": { class_type: "bno84.LyricsStyle", inputs: { instrumental: true, lyrics: "[intro]\n[chorus]", style: "dark rave" } },
  "33": { class_type: "bno84.ReferenceInput", inputs: { source: "None", abc: "", extend: true, transcription_model: ["34:52", 0] } },
  "30:5": { class_type: "YuE2GenerateABC", inputs: { seed: ["3", 0], lyrics: ["32", 0], style: ["32", 1], clip: ["30:1", 0], temperature: 1.2, mode: "full" } },
  "31:6": { class_type: "YuE2GenerateMusic", inputs: { seed: ["3", 0], lyrics: ["32", 0], style: ["32", 1], temperature: 1, cfg_scale: 2.5 } },
};
const where = (entries) => entries.map(({ sampler, id, input, value }) => [sampler, id, input, value]);

test("run settings follow each sampler's links to the nodes holding seed, lyrics and style", () => {
  const settings = lib.runSettings(PROMPT);
  assert.deepEqual(where(settings.values.seed), [
    ["YuE2GenerateMusic", "3", "value", -96369643988299], ["YuE2GenerateABC", "3", "value", -96369643988299],
  ]);
  assert.deepEqual(where(settings.values.lyrics)[0], ["YuE2GenerateMusic", "32", "lyrics", "[intro]\n[chorus]"]);
  assert.deepEqual(where(settings.values.style)[1], ["YuE2GenerateABC", "32", "style", "dark rave"]);
  assert.deepEqual(where(settings.values.instrumental), [["", "32", "instrumental", true]]);
  assert.deepEqual(settings.reference, { id: "33", source: "None", extend: true });
  assert.deepEqual(settings.sampling.map((entry) => [entry.id, entry.values]), [
    ["31:6", { temperature: 1, cfg_scale: 2.5 }],
    ["30:5", { temperature: 1.2, mode: "full" }],
  ]);
  assert.equal(lib.samplingText(settings.sampling), "ABC t 1.2 · audio t 1 · cfg 2.5");
});

test("a native workflow without kit nodes still has its seed, lyrics and style", () => {
  const settings = lib.runSettings({
    "4": { class_type: "PrimitiveStringMultiline", inputs: { value: "[verse]\nla" } },
    "7": { class_type: "YuE2GenerateMusic", inputs: { seed: 5, lyrics: ["4", 0], style: "pop" } },
  });
  assert.deepEqual(where(settings.values.seed), [["YuE2GenerateMusic", "7", "seed", 5]]);
  assert.deepEqual(where(settings.values.lyrics), [["YuE2GenerateMusic", "4", "value", "[verse]\nla"]]);
  assert.deepEqual(where(settings.values.style), [["YuE2GenerateMusic", "7", "style", "pop"]]);
  assert.deepEqual(settings.values.instrumental, []);
  assert.deepEqual(lib.runSettings(null).values.seed, []);
});

test("a link to a node without a matching input is not a restorable source", () => {
  const prompt = { "9": { class_type: "Switch", inputs: { on_true: "a" } }, "7": { class_type: "YuE2GenerateMusic", inputs: { lyrics: ["9", 0] } } };
  assert.equal(lib.resolveInput(prompt, "7", "lyrics"), null);
});

test("separate seeds are kept per sampler and matched by sampler when restoring", () => {
  const prompt = {
    ...PROMPT,
    "40": { class_type: "PrimitiveInt", inputs: { value: 7 } },
    "30:5": { ...PROMPT["30:5"], inputs: { ...PROMPT["30:5"].inputs, seed: ["40", 0] } },
  };
  const past = lib.runSettings(prompt);
  assert.deepEqual(where(past.values.seed).map(([sampler, id, , value]) => [sampler, id, value]), [
    ["YuE2GenerateMusic", "3", -96369643988299], ["YuE2GenerateABC", "40", 7],
  ]);
  const shared = lib.runSettings(PROMPT);
  assert.equal(lib.pastValueFor(past, "seed", shared.values.seed[1]), 7);
  assert.equal(lib.pastValueFor(past, "seed", shared.values.seed[0]), -96369643988299);
  assert.equal(lib.compareSettings(past, shared).seed, "differs");
});

test("comparison marks each setting and ignores what either side lacks", () => {
  const past = lib.runSettings(PROMPT);
  const current = lib.runSettings({
    ...PROMPT,
    "3": { class_type: "PrimitiveInt", inputs: { value: 1 } },
    "31:6": { ...PROMPT["31:6"], inputs: { ...PROMPT["31:6"].inputs, cfg_scale: 3 } },
  });
  assert.deepEqual(lib.compareSettings(past, current), {
    seed: "differs", style: "same", lyrics: "same", instrumental: "same", sampling: "differs",
  });
  assert.deepEqual(lib.compareSettings(past, lib.runSettings({})), {
    seed: "", style: "", lyrics: "", instrumental: "", sampling: "",
  });
});

const GROUPS = [
  { label: "intro", starts_section: true, bar: 0, bars: 4, seconds: 8 },
  { label: "verse", starts_section: true, bar: 4, bars: 4, seconds: 8 },
  { label: "verse", starts_section: false, bar: 8, bars: 4, seconds: 8 },
  { label: "chorus", starts_section: true, bar: 12, bars: 2, seconds: 3 },
];

test("selections cover whole sections and snap to group boundaries", () => {
  assert.deepEqual(lib.sectionRange(GROUPS, 2), [1, 3]);
  assert.deepEqual(lib.extendRange([1, 3], [3, 4]), [1, 4]);
  assert.equal(lib.nearestBoundary(GROUPS, 5.9), 1);
  assert.equal(lib.nearestBoundary(GROUPS, 6.1), 2);
  assert.equal(lib.nearestBoundary(GROUPS, 13.5), 4);
  assert.deepEqual(lib.rangeInfo(GROUPS, [1, 4]), { firstBar: 5, lastBar: 14, bars: 10, labels: ["verse", "chorus"], seconds: 8 });
});

test("dragging selects every group between press and release, in either direction", () => {
  assert.equal(lib.groupAt(GROUPS, 0), 0);
  assert.equal(lib.groupAt(GROUPS, 7.9), 1);
  assert.equal(lib.groupAt(GROUPS, 13.9), 3);
  assert.deepEqual(lib.dragRange(GROUPS, 5, 9), [1, 3]);
  assert.deepEqual(lib.dragRange(GROUPS, 13, 2), [0, 4]);
  assert.deepEqual(lib.dragRange(GROUPS, 6, 6.5), [1, 2]);
});

test("clock and age read naturally", () => {
  assert.equal(lib.clock(89.6), "1:30");
  assert.equal(lib.ago(1000, 1000 + 150), "2 min ago");
  assert.equal(lib.ago(1000, 1000 + 100000), "yesterday");
});

function widgetNode(id, names, extra = {}) {
  const node = { id, title: `node ${id}`, widgets: names.map((name) => ({ name, value: null })), inputs: [], ...extra };
  return node;
}

test("setInput writes the subgraph node's widget when the input comes from the subgraph", () => {
  const inner = widgetNode(6, ["temperature", "cfg_scale"], { inputs: [{ name: "cfg_scale", link: 9 }, { name: "temperature", link: null }] });
  const subgraph = { _nodes: [inner], inputs: [{ name: "audio_cfg" }], getLink: (id) => (id === 9 ? { origin_id: "-10", origin_slot: 0 } : null) };
  inner.graph = subgraph;
  const outer = widgetNode(31, ["audio_cfg"], { subgraph });
  const root = { _nodes: [outer] };
  outer.graph = root;
  assert.equal(lib.findNode(root, "31:6"), inner);
  assert.equal(lib.setInput(root, "31:6", "cfg_scale", 2.5), outer);
  assert.equal(outer.widgets[0].value, 2.5);
  assert.equal(lib.setInput(root, "31:6", "temperature", 1), inner);
  assert.equal(inner.widgets[0].value, 1);
  assert.equal(lib.setInput(root, "31:7", "temperature", 1), null);
});
