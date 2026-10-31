// Pure frontend logic, loaded without a browser: Score widgets, the shared strip, Song history and transcription jobs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const load = (sources, names, app = { registerExtension() {} }) =>
  new Function("app", "api", sources.map(read).join("\n") + `\nreturn {${names}};`)(app, {});

const state = load(["score_state.js"], "SCORE_DEFAULTS,readValues,setValues,rangeSelection,normalizeValues,applicable");
const strip = load(["score_strip.js"], "shortLabel,sectionColor,sourceSummary");
const history = load(["score_strip.js", "score_state.js", "song_history.js"], "runSettings,resolvePlans,samplingText,dragRange,rangeInfo,useInPlanner,useReference,referenceGaps,restoreReference,referenceTargets,scoreViews,showScore,SongHistoryPanel,planningText,setInput");
const transcribe = load(["reference_transcribe.js"], "buildTranscriptionPrompt");
const lyricsStyle = load(["lyrics_style.js"], "variantInput,instrumentalPromptWarning,migrateSavedPair");
const textbox = load(["reference_input.js", "score.js"], "bindReferenceTextbox");
const node = (values) => ({ widgets: Object.entries(values).map(([name, value]) => ({ name, value })), inputs: [], graph: { setDirtyCanvas() {} } });
const value = (n, name) => n.widgets.find((w) => w.name === name).value;
// The shape of a plan from the Python planner (see test_score.py).
const plan = ({ source = "abc", opening = 0, continuation = true, start = 0, end = null, tempo = "reference" } = {}) => ({
  source: { kind: source, abc: source === "none" ? "" : "SOURCE" }, anchor: { start, end }, opening: { bars: opening },
  continuation: { enabled: continuation }, header: { tempo: { policy: tempo } } });
const planned = (entry) => ({ planners: [{ id: "1", planError: "", ...entry }], reference: null });

// What resolvePlans attaches to a recorded Score node once the planner answers.
const withPlan = (settings, value) => { settings.planners[0].plan = value; return settings; };

test("Score widgets: range drag, applicability and plan view", () => {
  assert.deepEqual(state.rangeSelection(16, 1, 16, null, 5.8, 2.1), [3, 6]);
  assert.deepEqual(state.rangeSelection(16, 3, 8, 0, 0, 15), [8, 8]);
  const fresh = state.applicable({ ...state.SCORE_DEFAULTS });
  assert.equal(fresh.header_tempo, false);
  assert.equal(fresh.opening_generate, false);
  const n = node(state.SCORE_DEFAULTS);
  state.setValues(n, { anchor_use: true, anchor_abc: "ABC", anchor_start: 3, anchor_end: 7 });
  assert.deepEqual([value(n, "anchor_start"), value(n, "anchor_end")], [3, 7]);
});

test("strip labels shorten on word boundaries and the summary stays in words", () => {
  assert.equal(strip.shortLabel("Continuation", 75), "Continue");
  assert.equal(strip.shortLabel("Opening", 20), "");
  assert.equal(strip.sectionColor("Verse 2"), strip.sectionColor("verse"));
  assert.equal(strip.sourceSummary({ bars: 16, fields: { M: "4/4", K: "G" }, anchor_bpm: 100, voices: 2 }, 6, 13),
    "16 bars · 4/4 · 100 BPM · G major · 2 voices · bars 6–13 of 16");
});

test("Song history follows sampler links and selects whole groups", () => {
  const prompt = {
    3: { class_type: "PrimitiveInt", inputs: { value: 7 } },
    32: { class_type: "bno84.LyricsStyle", inputs: { instrumental: false, lyrics: "[verse]", style: "pop" } },
    "31:6": { class_type: "YuE2GenerateMusic", inputs: { seed: ["3", 0], lyrics: ["32", 0], style: ["32", 1], temperature: 1, cfg_scale: 2.5 } },
  };
  const settings = history.runSettings(prompt);
  assert.equal(settings.values.seed[0].value, 7);
  assert.equal(settings.values.style[0].value, "pop");
  assert.equal(history.samplingText(settings.sampling), "Music temp 1 · CFG 2.5");
  const groups = [{ label: "intro", starts_section: true, bar: 0, bars: 4, seconds: 8 },
    { label: "verse", starts_section: true, bar: 4, bars: 4, seconds: 8 }, { label: "chorus", starts_section: true, bar: 8, bars: 2, seconds: 3 }];
  assert.deepEqual(history.dragRange(groups, 9, 2), [0, 3]);
  assert.deepEqual(history.rangeInfo(groups, [1, 3]).labels, ["verse", "chorus"]);
});

test("Use as reference fills Score and keeps header and sampling", () => {
  const n = node({ ...state.SCORE_DEFAULTS, header_mode: "locked", temperature: 0.8 });
  history.useInPlanner(n, "NEW");
  assert.equal(value(n, "anchor_abc"), "NEW");
  assert.equal(value(n, "header_mode"), "locked");
  history.useInPlanner(n, "FINAL", true);
  assert.equal(value(n, "header_mode"), "locked");
});

test("transcription runs as its own job from the reference settings", () => {
  const prompt = {
    file: { class_type: "bno84.OptionalAudioEncoderFile", inputs: { name: "model.safetensors" } },
    33: { class_type: "bno84.ReferenceInput", inputs: { source: "Transcribe", audio: "take.wav", abc: "", extend: true,
      transcription_model: ["file", 0], transcription_mode: "melody" } },
    music: { class_type: "YuE2GenerateMusic", inputs: { abc: ["33", 0] } },
  };
  const { output, sinkId } = transcribe.buildTranscriptionPrompt(prompt, "33");
  assert.equal(output.music, undefined);
  assert.equal(output["33"].class_type, "SheetSage2AudioToABC");
  assert.equal(output["33"].inputs.mode, "melody");
  assert.deepEqual(output[sinkId].inputs.source, ["33", 0]);
});


test("reference destinations include both node types with distinct subgraph paths", () => {
  const score = { ...node(state.SCORE_DEFAULTS), id: 1, comfyClass: "bno84.YuE2AdvancedScore" };
  const reference = { ...node({ source: "None", abc: "OLD", extend: true }), id: 1, comfyClass: "bno84.ReferenceInput" };
  const graph = { _nodes: [score, { id: 2, subgraph: { _nodes: [reference] } }] };
  const targets = history.referenceTargets(graph);
  assert.deepEqual(targets.map(t => t.id), ["1", "2:1"]);
  history.useReference(targets[1].node, "SELECTED");
  assert.equal(value(reference, "source"), "ABC");
  assert.equal(value(reference, "abc"), "SELECTED");
  assert.equal(value(reference, "extend"), true);
  assert.equal(value(score, "anchor_abc"), "");
  history.useReference(reference, "FINAL", true);
  assert.equal(value(reference, "extend"), false);
  history.useReference(score, "SCORE");
  assert.equal(value(score, "anchor_abc"), "SCORE");
  assert.equal(value(reference, "abc"), "FINAL");
});

test("Restore all refuses saved Score features for Reference input before changing anything", async () => {
  const reference = { ...node({ source: "None", abc: "OLD", extend: true }), id: 1, comfyClass: "bno84.ReferenceInput" };
  const graph = { _nodes: [reference] };
  let changes = 0;
  graph.beforeChange = () => changes++;
  const testApp = { registerExtension() {}, rootGraph: graph, graphToPrompt: async () => ({ output: {} }) };
  const mod = load(["score_strip.js", "score_state.js", "song_history.js"], "SongHistoryPanel,runSettings", testApp);
  const panel = Object.create(mod.SongHistoryPanel.prototype);
  panel.open = "song";
  const prompt = { score: { class_type: "bno84.YuE2AdvancedScore", inputs: { ...state.SCORE_DEFAULTS,
    header_mode: "reference", anchor_use: true, anchor_abc: "SOURCE", opening_generate: true } } };
  panel.details = new Map([["song", { abc: "FINAL", settings: withPlan(mod.runSettings(prompt), plan({ opening: 8 })) }]]);
  let message;
  panel.message = (text, error) => { message = { text, error }; };
  panel.compare = () => {};
  await panel.restoreAll({});
  assert.equal(message.error, true);
  assert.match(message.text, /^Reference input · 1 can't hold an opening\. Restore to a YuE2 Advanced Score/);
  assert.equal(changes, 0);
  assert.equal(value(reference, "abc"), "OLD");
  // An older run can restore its final ABC into the same Reference input.
  panel.details.set("song", { abc: "FINAL", settings: mod.runSettings({}) });
  await panel.restoreAll({});
  assert.equal(value(reference, "abc"), "FINAL");
  assert.equal(value(reference, "extend"), false);
});


test("unit note length is locked-only and history reads it", () => {
  const values = { ...state.SCORE_DEFAULTS, header_mode: "locked", header_key: "D minor", header_tempo: 88, opening_bars: 12 };
  assert.equal(state.applicable(values).header_unit, true);
  assert.equal(state.applicable({ ...values, header_mode: "reference" }).header_unit, false);
  const settings = history.runSettings({ score: { class_type: "bno84.YuE2AdvancedScore", inputs: { ...values, header_unit: "1/32" } } });
  assert.equal(settings.planners[0].values.header_unit, "1/32");
});


test("locked headers with a reference disable meter, key and unit but retain tempo", () => {
  const settings = { ...state.SCORE_DEFAULTS, header_mode: "locked", anchor_use: true };
  const enabled = state.applicable(settings);
  assert.equal(enabled.header_tempo, true);
  for (const name of ["header_meter", "header_key", "header_unit"]) {
    assert.equal(enabled[name], false);
    assert.equal(state.applicable({ ...settings, anchor_use: false })[name], true);
  }
});


test("Score properties are generated, locked or reference", () => {
  assert.equal(state.applicable({ ...state.SCORE_DEFAULTS, header_mode: "reference" }).header_tempo, false);
  assert.equal(state.applicable({ ...state.SCORE_DEFAULTS, header_mode: "locked" }).header_tempo, true);
});


test("opening defaults to 768 tokens and enables the configured candidate count", () => {
  assert.equal(state.SCORE_DEFAULTS.opening_tokens, 768);
  const v = { ...state.SCORE_DEFAULTS, anchor_use: true, opening_generate: true, opening_candidates: 1 };
  assert.equal(state.applicable(v).opening_candidates, true);
  assert.equal(state.applicable({ ...v, opening_generate: false }).opening_candidates, false);
  assert.equal(state.SCORE_DEFAULTS.opening_candidates, 4);
  assert.equal(state.applicable(v).opening_tokens, true);
});


test("reference textbox imports ABC and routes audio to the shared loader once", () => {
  const input = new EventTarget();
  input.placeholder = "anchor_abc";
  const loaded = [];
  const unbind = textbox.bindReferenceTextbox(input, { load: file => loaded.push(file) });
  assert.match(input.placeholder, /reference ABC/);
  assert.doesNotMatch(input.placeholder, /anchor_abc/);
  const dispatch = (type, file, types = ["Files"]) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: file ? [file] : [], types } });
    input.dispatchEvent(event);
    return event;
  };
  assert.equal(dispatch("dragover").defaultPrevented, true);
  assert.equal(dispatch("dragover", null, ["text/plain"]).defaultPrevented, false);
  const abc = { name: "reference.abc", type: "text/plain" };
  const audio = { name: "reference.wav", type: "audio/wav" };
  let bubbled = 0;
  input.addEventListener("drop", () => bubbled++);
  for (const file of [abc, audio]) assert.equal(dispatch("drop", file).defaultPrevented, true);
  assert.deepEqual(loaded, [abc, audio]);
  assert.equal(bubbled, 0);
  assert.equal(dispatch("drop", { name: "workflow.json", type: "application/json" }).defaultPrevented, false);
  unbind();
  assert.equal(dispatch("drop", abc).defaultPrevented, false);
  assert.deepEqual(loaded, [abc, audio]);
});


test("history shows the same selection in both ABC views and reports failures", async () => {
  const seen = [];
  const graph = { _nodes: [
    { comfyClass: "bno84.ABCPreview", abcPreview: { setAbc: abc => seen.push(["preview", abc]) } },
    { comfyClass: "bno84.ABCTimeline", setAbcTimeline: async abc => seen.push(["timeline", abc]) },
  ] };
  const views = history.scoreViews(graph);
  assert.equal(views.length, 2);
  await history.showScore(views, "SELECTED");
  assert.deepEqual(seen, [["preview", "SELECTED"], ["timeline", "SELECTED"]]);
  await assert.rejects(history.showScore([{ setAbcTimeline() { throw new Error("Cannot load timeline"); } }], "ABC"), /Cannot load timeline/);
  const panel = { statusElement: { textContent: "", dataset: {} } };
  history.SongHistoryPanel.prototype.message.call(panel, "Error", true);
  assert.equal(panel.statusElement.textContent, "Error");
  history.SongHistoryPanel.prototype.message.call(panel, "Copied");
  assert.equal(panel.statusElement.textContent, "");
  assert.equal(panel.status, null);
});


test("Planning describes generated and reference stages", () => {
  for (const opening of [0, 8]) for (const continuation of [false, true]) {
    assert.equal(history.planningText(planned({ plan: plan({ source: "none", opening, continuation }) })), "Generated");
    const expected = (opening ? "Opening + reference" : "Reference") + (continuation ? " + continuation" : "");
    assert.equal(history.planningText(planned({ plan: plan({ opening, continuation }) })), expected);
  }
  assert.equal(history.planningText(planned({ plan: null, planError: "Generated tempo needs an opening." })), "-");
  for (const source of ["None", "ABC", "Transcribe"]) for (const extend of [false, true]) {
    assert.equal(history.planningText({ planners: [], reference: { source, extend } }),
      source === "None" ? "Generated" : source + (extend ? " + continuation" : ""));
  }
  assert.equal(history.planningText({ planners: [], reference: null }), "-");
});


test("history reference actions change score properties only when required", () => {
  for (const saved of [false, true]) for (const mode of ["generated", "locked", "reference"]) {
    for (const opening_generate of [false, true]) {
      const n = { ...node({ ...state.SCORE_DEFAULTS, header_mode: mode, opening_generate, temperature: 0.83 }), comfyClass: "bno84.YuE2AdvancedScore" };
      history.useReference(n, "NEW", saved);
      assert.equal(value(n, "header_mode"), mode === "generated" && (saved || !opening_generate) ? "reference" : mode);
      assert.equal(value(n, "opening_generate"), saved ? false : opening_generate);
      assert.equal(value(n, "continue_generate"), !saved);
      assert.equal(value(n, "temperature"), 0.83);
      assert.equal(value(n, "anchor_use"), true);
      assert.equal(value(n, "anchor_abc"), "NEW");
    }
  }
});

test("Restore all repairs invalid saved reference properties and preserves valid modes", async () => {
  const n = { ...node(state.SCORE_DEFAULTS), id: 1, comfyClass: "bno84.YuE2AdvancedScore" };
  const graph = { _nodes: [n], beforeChange() {}, afterChange() {} };
  const mod = load(["score_strip.js", "score_state.js", "song_history.js"], "SongHistoryPanel,runSettings",
    { registerExtension() {}, rootGraph: graph, graphToPrompt: async () => ({ output: {} }) });
  const panel = Object.create(mod.SongHistoryPanel.prototype);
  panel.open = "song"; panel.message = () => {}; panel.compare = () => {};
  for (const header_mode of ["generated", "locked", "reference"]) for (const opening_generate of [false, true]) {
    const values = { ...state.SCORE_DEFAULTS, anchor_use: true, anchor_abc: "ORIGINAL", header_mode, opening_generate };
    panel.details = new Map([["song", { abc: "FINAL", settings: mod.runSettings({ 1: { class_type: "bno84.YuE2AdvancedScore", inputs: values } }) }]]);
    await panel.restore({ plan: true }, { id: "1", node: n });
    assert.equal(value(n, "header_mode"), header_mode === "generated" && !opening_generate ? "reference" : header_mode);
    assert.equal(value(n, "anchor_abc"), "ORIGINAL");
    assert.equal(value(n, "opening_generate"), opening_generate);
  }
});


test("Score state normalizes reference updates before widget callbacks", () => {
  const n = node(state.SCORE_DEFAULTS);
  const observed = [];
  n.widgets.find(w => w.name === "anchor_use").callback = () => observed.push(value(n, "header_mode"));
  state.setValues(n, { anchor_use: true, anchor_abc: "ABC" });
  assert.equal(value(n, "header_mode"), "reference");
  assert.deepEqual(observed, ["reference"]);
  state.setValues(n, { header_mode: "generated" });
  assert.equal(value(n, "header_mode"), "reference");
  state.setValues(n, { opening_generate: true, header_mode: "generated" });
  assert.equal(value(n, "header_mode"), "generated");
  state.setValues(n, { opening_generate: false });
  assert.equal(value(n, "header_mode"), "reference");
  state.setValues(n, { header_mode: "locked" });
  assert.equal(value(n, "header_mode"), "locked");
  state.setValues(n, { anchor_use: false, header_mode: "generated" });
  assert.equal(value(n, "header_mode"), "generated");
});


test("Restore all maps plans Reference input can hold and names what it cannot", async () => {
  assert.deepEqual(history.referenceGaps(plan()), []);
  assert.deepEqual(history.referenceGaps(plan({ opening: 8, start: 2, end: 8, tempo: "locked" })),
    ["an opening", "bars 3–8 of the reference", "locked properties"]);
  assert.deepEqual(history.referenceGaps(plan({ source: "none", start: 2 })), []);

  const reference = { ...node({ source: "None", abc: "OLD", extend: false }), id: 1, comfyClass: "bno84.ReferenceInput" };
  history.restoreReference(reference, plan({ continuation: true }));
  assert.deepEqual(["source", "abc", "extend"].map(name => value(reference, name)), ["ABC", "SOURCE", true]);
  history.restoreReference(reference, plan({ source: "none" }));
  assert.equal(value(reference, "source"), "None");
  assert.equal(value(reference, "abc"), "SOURCE");
});

test("several destinations open a menu that disables those that cannot take the plan", async () => {
  const score = { ...node(state.SCORE_DEFAULTS), id: 1, comfyClass: "bno84.YuE2AdvancedScore" };
  const reference = { ...node({ source: "None", abc: "OLD", extend: false }), id: 2, comfyClass: "bno84.ReferenceInput", title: "Ref" };
  const graph = { _nodes: [score, reference], beforeChange() {}, afterChange() {} };
  const menus = [];
  globalThis.LiteGraph = { ContextMenu: class { constructor(items, options) { menus.push({ items, options }); } } };
  try {
    const mod = load(["score_strip.js", "score_state.js", "song_history.js"], "SongHistoryPanel,runSettings",
      { registerExtension() {}, rootGraph: graph, graphToPrompt: async () => ({ output: {} }) });
    const panel = Object.create(mod.SongHistoryPanel.prototype);
    let message;
    panel.open = "song"; panel.message = (text, error) => { message = { text, error }; }; panel.compare = () => {};
    const inputs = { ...state.SCORE_DEFAULTS, header_mode: "reference", anchor_use: true, anchor_abc: "SOURCE", opening_generate: true };
    const settings = withPlan(mod.runSettings({ 9: { class_type: "bno84.YuE2AdvancedScore", inputs } }), plan({ opening: 8 }));
    panel.details = new Map([["song", { abc: "FINAL", settings }]]);
    const event = { type: "click" };
    panel.restoreAll(event);
    assert.equal(menus.length, 1);
    assert.equal(menus[0].options.event, event);
    assert.deepEqual(menus[0].items.map(item => [item.content, item.disabled]),
      [["YuE2 Advanced Score · 1", false], ["Ref · 2 — can't hold an opening", true]]);
    assert.equal(value(reference, "abc"), "OLD");
    menus[0].items[0].callback();
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(value(score, "anchor_abc"), "SOURCE");
    assert.equal(value(score, "opening_generate"), true);

    // Reference actions accept either node type.
    panel.useAsReference(event, "SLICE");
    assert.deepEqual(menus[1].items.map(item => item.disabled), [false, false]);
    menus[1].items[1].callback();
    assert.equal(value(reference, "abc"), "SLICE");
    assert.match(message.text, /^Reference sent to Ref · 2\./);
  } finally {
    delete globalThis.LiteGraph;
  }
});

test("saved plans come from the Python planner, with the UI action's mode repair", async () => {
  const settings = history.runSettings({
    1: { class_type: "bno84.YuE2AdvancedScore", inputs: { ...state.SCORE_DEFAULTS, anchor_use: true, anchor_abc: "ABC" } },
    2: { class_type: "bno84.YuE2AdvancedScore", inputs: { ...state.SCORE_DEFAULTS } } });
  assert.deepEqual(settings.planners.map(entry => entry.plan), [null, null]);
  const sent = [];
  await history.resolvePlans(settings, async (url, request) => {
    const values = JSON.parse(request.body);
    sent.push([url, values.header_mode]);
    const ok = values.anchor_use;
    return { ok: true, json: async () => ok ? { plan: plan(), errors: [] } : { plan: null, errors: ["Bad settings."] } };
  });
  assert.deepEqual(sent, [["/yue2-kit/score/preview", "reference"], ["/yue2-kit/score/preview", "generated"]]);
  assert.deepEqual(settings.planners[0].plan, plan());
  assert.equal(settings.planners[1].plan, null);
  assert.equal(settings.planners[1].planError, "Bad settings.");
  await history.resolvePlans(settings, async () => { throw Error("offline"); });
  assert.match(settings.planners[0].planError, /offline/);
});

test("only a reference without an opening repairs generated properties", () => {
  const repaired = values => state.normalizeValues({ ...state.SCORE_DEFAULTS, ...values }).header_mode;
  assert.equal(repaired({ anchor_use: true }), "reference");
  assert.equal(repaired({ anchor_use: true, opening_generate: true }), "generated");
  assert.equal(repaired({ anchor_use: false }), "generated");
  assert.equal(repaired({ anchor_use: true, header_mode: "locked" }), "locked");
});

test("restoring an input writes the primitive or subgraph widget that feeds it", () => {
  const primitive = { id: 2, type: "PrimitiveNode", widgets: [{ name: "value", value: 0.9 }] };
  const target = { id: 1, inputs: [{ name: "temperature", link: 42 }], widgets: [{ name: "temperature", value: 0.7 }] };
  const graph = { _nodes: [target, primitive], links: { 42: { origin_id: 2, origin_slot: 0 } } };
  target.graph = primitive.graph = graph;
  assert.deepEqual(history.setInput(graph, "1", "temperature", 0.5), { node: primitive, name: "value" });
  assert.deepEqual([value(primitive, "value"), value(target, "temperature")], [0.5, 0.7]);

  // Through a reroute to a core primitive whose value is itself fed from the subgraph input.
  const outer = { id: 5, inputs: [{ name: "heat", link: null }], widgets: [{ name: "heat", value: 1 }] };
  const core = { id: 4, comfyClass: "PrimitiveFloat", inputs: [{ name: "value", link: 8 }], widgets: [{ name: "value", value: 2 }] };
  const reroute = { id: 3, type: "Reroute", inputs: [{ name: "", link: 7 }], widgets: [] };
  const inner = { id: 1, inputs: [{ name: "temperature", link: 6 }], widgets: [{ name: "temperature", value: 3 }] };
  const sub = { _nodes: [inner, reroute, core], inputs: [{ name: "heat" }],
    links: { 6: { origin_id: 3, origin_slot: 0 }, 7: { origin_id: 4, origin_slot: 0 }, 8: { origin_id: -10, origin_slot: 0 } } };
  outer.subgraph = sub;
  const root = { _nodes: [outer], links: {} };
  outer.graph = root; inner.graph = reroute.graph = core.graph = sub;
  assert.deepEqual(history.setInput(root, "5:1", "temperature", 0.4), { node: outer, name: "heat" });
  assert.deepEqual([value(outer, "heat"), value(core, "value"), value(inner, "temperature")], [0.4, 2, 3]);

  // A node that computes the value is reported, not overwritten behind it.
  const math = { id: 2, type: "FloatMath", widgets: [{ name: "value", value: 0.9 }] };
  graph._nodes[1] = math;
  assert.deepEqual(history.setInput(graph, "1", "temperature", 0.1), { linked: math });
  assert.deepEqual([value(math, "value"), value(target, "temperature")], [0.9, 0.7]);
  assert.equal(history.setInput(graph, "1", "top_p", 0.1), null);
});

test("Restore all names Score settings a linked node controls", async () => {
  const n = { ...node(state.SCORE_DEFAULTS), id: 1, comfyClass: "bno84.YuE2AdvancedScore" };
  const math = { id: 2, type: "FloatMath", widgets: [] };
  n.inputs = [{ name: "temperature", link: 42 }];
  const graph = { _nodes: [n, math], links: { 42: { origin_id: 2, origin_slot: 0 } }, beforeChange() {}, afterChange() {} };
  n.graph = math.graph = graph;
  const mod = load(["score_strip.js", "score_state.js", "song_history.js"], "SongHistoryPanel,runSettings",
    { registerExtension() {}, rootGraph: graph, graphToPrompt: async () => ({ output: {} }) });
  const panel = Object.create(mod.SongHistoryPanel.prototype);
  let message;
  panel.open = "song"; panel.message = (text, error) => { message = { text, error }; }; panel.compare = () => {};
  const values = { ...state.SCORE_DEFAULTS, temperature: 0.5, top_p: 0.8 };
  panel.details = new Map([["song", { abc: "FINAL", settings: mod.runSettings({ 1: { class_type: "bno84.YuE2AdvancedScore", inputs: values } }) }]]);
  await panel.restore({ plan: true }, { id: "1", node: n });
  assert.deepEqual([value(n, "temperature"), value(n, "top_p")], [0.7, 0.8]);
  assert.deepEqual(message, { text: "Not restored, set by a linked node: temperature.", error: true });
});

test("Lyrics + style keeps Base and Instrumental pairs and history follows the active one", () => {
  assert.equal(lyricsStyle.variantInput("lyrics", false), "lyrics");
  assert.equal(lyricsStyle.variantInput("style", true), "instrumental_style");
  assert.equal(lyricsStyle.instrumentalPromptWarning(true, "[intro]\n[interlude]\n[outro]"), "");
  assert.match(lyricsStyle.instrumentalPromptWarning(true, "[intro]\nla la"), /only section tags/);
  assert.equal(lyricsStyle.instrumentalPromptWarning(false, "la la"), "");
  const prompt = (instrumental) => ({
    32: { class_type: "bno84.LyricsStyle", inputs: { instrumental, lyrics: "[verse]\nsung", style: "pop",
      instrumental_lyrics: "[intro]\n[outro]", instrumental_style: "ambient" } },
    6: { class_type: "YuE2GenerateMusic", inputs: { seed: 1, lyrics: ["32", 0], style: ["32", 1] } } });
  for (const instrumental of [false, true]) {
    const found = history.runSettings(prompt(instrumental)).values;
    assert.equal(found.lyrics[0].value, instrumental ? "[intro]\n[outro]" : "[verse]\nsung");
    assert.equal(found.style[0].input, instrumental ? "instrumental_style" : "style");
  }
  // Older Lyrics + style nodes without variants keep reading the Base pair.
  const old = { 32: { class_type: "bno84.LyricsStyle", inputs: { instrumental: true, lyrics: "[intro]", style: "rave" } },
    6: { class_type: "YuE2GenerateMusic", inputs: { seed: 1, lyrics: ["32", 0], style: ["32", 1] } } };
  assert.equal(history.runSettings(old).values.lyrics[0].input, "lyrics");
});

test("restoring an instrumental run writes the Instrumental pair and keeps Base", async () => {
  const values = { instrumental: false, lyrics: "[verse]\nmine", style: "pop", instrumental_lyrics: "[intro]", instrumental_style: "old" };
  const n = { ...node(values), id: 32, comfyClass: "bno84.LyricsStyle", type: "bno84.LyricsStyle" };
  const graph = { _nodes: [n], beforeChange() {}, afterChange() {}, getNodeById: id => String(id) === "32" ? n : null };
  const current = { 32: { class_type: "bno84.LyricsStyle", inputs: { ...values } },
    6: { class_type: "YuE2GenerateMusic", inputs: { seed: 1, lyrics: ["32", 0], style: ["32", 1] } } };
  const mod = load(["score_strip.js", "score_state.js", "song_history.js"], "SongHistoryPanel,runSettings",
    { registerExtension() {}, rootGraph: graph, graphToPrompt: async () => ({ output: current }) });
  const past = { ...current, 32: { class_type: "bno84.LyricsStyle", inputs: { ...values, instrumental: true,
    instrumental_lyrics: "[intro]\n[outro]", instrumental_style: "ambient" } } };
  const panel = Object.create(mod.SongHistoryPanel.prototype);
  panel.open = "song"; panel.message = () => {}; panel.compare = () => {};
  panel.details = new Map([["song", { abc: "FINAL", settings: mod.runSettings(past) }]]);
  await panel.restore({ lyricsStyle: true });
  assert.deepEqual(["instrumental", "lyrics", "style", "instrumental_lyrics", "instrumental_style"].map(name => value(n, name)),
    [true, "[verse]\nmine", "pop", "[intro]\n[outro]", "ambient"]);
});

test("an instrumental node saved before the variants keeps its prompt as the Instrumental pair", () => {
  const saved = { instrumental: true, lyrics: "[intro]\n[outro]", style: "trance", instrumental_lyrics: "DEFAULT", instrumental_style: "DEFAULT" };
  for (const info of [{ widgets_values: [true, "[intro]\n[outro]", "trance"] },
    { widgets_values_named: { instrumental: true, lyrics: "[intro]\n[outro]", style: "trance" } }]) {
    const n = node(saved);
    assert.equal(lyricsStyle.migrateSavedPair(n, info), true);
    assert.deepEqual([value(n, "instrumental_lyrics"), value(n, "instrumental_style"), value(n, "lyrics")], ["[intro]\n[outro]", "trance", "[intro]\n[outro]"]);
  }
  const base = node({ ...saved, instrumental: false });
  assert.equal(lyricsStyle.migrateSavedPair(base, { widgets_values: [false, "sung", "pop"] }), false);
  assert.equal(value(base, "instrumental_lyrics"), "DEFAULT");
  const current = node(saved);
  assert.equal(lyricsStyle.migrateSavedPair(current, { widgets_values: [true, "a", "b", "c", "d"] }), false);
  assert.equal(value(current, "instrumental_lyrics"), "DEFAULT");
});
