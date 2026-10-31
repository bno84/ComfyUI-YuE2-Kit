// Pure frontend logic, loaded without a browser: Score widgets, the shared strip, Song history and transcription jobs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const load = (sources, names, app = { registerExtension() {} }) =>
  new Function("app", "api", sources.map(read).join("\n") + `\nreturn {${names}};`)(app, {});

const state = load(["score_state.js"], "SCORE_DEFAULTS,readValues,setValues,rangeSelection,valuesPlan,applicable,restoreLegacyWidgets,propertyMode,migrateScoreWorkflow");
const strip = load(["score_strip.js"], "shortLabel,sectionColor,sourceSummary");
const history = load(["score_strip.js", "score_state.js", "song_history.js"], "runSettings,samplingText,dragRange,rangeInfo,useInPlanner,useReference,referenceTargets,scoreViews,showScore,SongHistoryPanel");
const transcribe = load(["reference_transcribe.js"], "buildTranscriptionPrompt");
const textbox = load(["reference_input.js", "score.js"], "bindReferenceTextbox");
const node = (values) => ({ widgets: Object.entries(values).map(([name, value]) => ({ name, value })), inputs: [], graph: { setDirtyCanvas() {} } });
const value = (n, name) => n.widgets.find((w) => w.name === name).value;

test("Score widgets: range drag, applicability and plan view", () => {
  assert.deepEqual(state.rangeSelection(16, 1, 16, null, 5.8, 2.1), [3, 6]);
  assert.deepEqual(state.rangeSelection(16, 3, 8, 0, 0, 15), [8, 8]);
  const fresh = state.applicable({ ...state.SCORE_DEFAULTS });
  assert.equal(fresh.header_tempo, false);
  assert.equal(fresh.opening_generate, false);
  const n = node(state.SCORE_DEFAULTS);
  state.setValues(n, { anchor_use: true, anchor_abc: "ABC", anchor_start: 3, anchor_end: 7 });
  assert.deepEqual(state.valuesPlan(state.readValues(n)).anchor, { start: 2, end: 7 });
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
  const n = node({ ...state.SCORE_DEFAULTS, header_mode: "fixed", temperature: 0.8 });
  history.useInPlanner(n, "NEW");
  assert.equal(value(n, "anchor_abc"), "NEW");
  assert.equal(value(n, "header_mode"), "fixed");
  history.useInPlanner(n, "FINAL", true);
  assert.equal(value(n, "header_mode"), "reference");
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
    header_mode: "from reference", anchor_use: true, anchor_abc: "SOURCE", opening_generate: true } } };
  panel.details = new Map([["song", { abc: "FINAL", settings: mod.runSettings(prompt) }]]);
  let message;
  panel.message = (text, error) => { message = { text, error }; };
  panel.compare = () => {};
  await panel.restore({ plan: true, seed: true, lyricsStyle: true, sampling: true });
  assert.equal(message.error, true);
  assert.match(message.text, /requires a YuE2 Advanced Score destination/);
  assert.equal(changes, 0);
  assert.equal(value(reference, "abc"), "OLD");
  // An older run can restore its final ABC into the same Reference input.
  panel.details.set("song", { abc: "FINAL", settings: mod.runSettings({}) });
  await panel.restore({ plan: true });
  assert.equal(value(reference, "abc"), "FINAL");
  assert.equal(value(reference, "extend"), false);
});


test("unit note length is fixed-only and older Score widgets retain their values", () => {
  const values = { ...state.SCORE_DEFAULTS, header_mode: "fixed", header_key: "D minor", header_tempo: 88, opening_bars: 12 };
  const names = Object.keys(state.SCORE_DEFAULTS).filter(name => name !== "header_unit");
  const n = node(state.SCORE_DEFAULTS);
  state.restoreLegacyWidgets(n, { widgets_values: names.map(name => values[name]) });
  assert.equal(value(n, "header_key"), "D minor");
  assert.equal(value(n, "opening_bars"), 12);
  assert.equal(value(n, "header_unit"), "1/16");
  assert.equal(state.applicable(values).header_unit, true);
  assert.equal(state.applicable({ ...values, header_mode: "from reference" }).header_unit, false);
  // Current workflows retain their chosen unit instead of being migrated again.
  state.setValues(n, { header_unit: "1/32" });
  state.restoreLegacyWidgets(n, { widgets_values: Array(22).fill(null) });
  assert.equal(value(n, "header_unit"), "1/32");
  const settings = history.runSettings({ score: { class_type: "bno84.YuE2AdvancedScore", inputs: { ...values, header_unit: "1/32" } } });
  assert.equal(settings.planners[0].values.header_unit, "1/32");
});


test("fixed headers with a reference disable meter, key and unit but retain tempo", () => {
  const settings = { ...state.SCORE_DEFAULTS, header_mode: "fixed", anchor_use: true };
  const enabled = state.applicable(settings);
  assert.equal(enabled.header_tempo, true);
  for (const name of ["header_meter", "header_key", "header_unit"]) {
    assert.equal(enabled[name], false);
    assert.equal(state.applicable({ ...settings, anchor_use: false })[name], true);
  }
});


test("Score properties use generated, locked and reference with legacy aliases", () => {
  assert.equal(state.propertyMode("fixed"), "locked");
  for (const mode of ["reference", "from reference", "from anchor"]) {
    assert.equal(state.propertyMode(mode), "reference");
    assert.equal(state.applicable({ ...state.SCORE_DEFAULTS, header_mode: mode }).header_tempo, false);
  }
  assert.equal(state.applicable({ ...state.SCORE_DEFAULTS, header_mode: "locked" }).header_tempo, true);
});


test("opening defaults to 768 tokens and the fixed four-candidate count is disabled", () => {
  assert.equal(state.SCORE_DEFAULTS.opening_tokens, 768);
  const v = { ...state.SCORE_DEFAULTS, anchor_use: true, opening_generate: true, opening_candidates: 1 };
  assert.equal(state.applicable(v).opening_candidates, false);
  assert.equal(state.applicable(v).opening_tokens, true);
  assert.equal(state.valuesPlan(v).opening.attempts, 4);
});


test("old Score node IDs migrate in root and nested workflows without changing custom titles", () => {
  const old = (title) => ({ type: "bno84.YuE2Score", title, properties: { "Node name for S&R": "bno84.YuE2Score" }, widgets_values: ["fixed", 88] });
  const root = old("YuE2 Score"), nested = old("My custom score");
  const workflow = { nodes: [root], definitions: { subgraphs: [{ nodes: [nested] }] } };
  state.migrateScoreWorkflow(workflow);
  assert.equal(root.type, "bno84.YuE2AdvancedScore");
  assert.equal(root.title, "YuE2 Advanced Score");
  assert.equal(nested.type, "bno84.YuE2AdvancedScore");
  assert.equal(nested.title, "My custom score");
  assert.equal(nested.properties["Node name for S&R"], "bno84.YuE2AdvancedScore");
  assert.deepEqual(root.widgets_values, ["fixed", 88]);
  state.migrateScoreWorkflow(workflow);
  const settings = history.runSettings({ score: { class_type: "bno84.YuE2Score", inputs: { ...state.SCORE_DEFAULTS, header_mode: "fixed" } } });
  assert.equal(settings.planners.length, 1);
  assert.equal(settings.planners[0].values.header_mode, "fixed");
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
