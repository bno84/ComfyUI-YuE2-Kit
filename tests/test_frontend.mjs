// Pure frontend logic, loaded without a browser: Score widgets, the shared strip, Song history and transcription jobs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const load = (sources, names, app = { registerExtension() {} }) =>
  new Function("app", "api", sources.map(read).join("\n") + `\nreturn {${names}};`)(app, {});

const state = load(["score_state.js"], "SCORE_DEFAULTS,readValues,setValues,rangeSelection,valuesPlan,applicable");
const strip = load(["score_strip.js"], "shortLabel,sectionColor,sourceSummary");
const history = load(["score_strip.js", "score_state.js", "song_history.js"], "runSettings,samplingText,dragRange,rangeInfo,useInPlanner");
const transcribe = load(["reference_transcribe.js"], "buildTranscriptionPrompt");
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
  assert.equal(history.samplingText(settings.sampling), "audio t 1 · cfg 2.5");
  const groups = [{ label: "intro", starts_section: true, bar: 0, bars: 4, seconds: 8 },
    { label: "verse", starts_section: true, bar: 4, bars: 4, seconds: 8 }, { label: "chorus", starts_section: true, bar: 8, bars: 2, seconds: 3 }];
  assert.deepEqual(history.dragRange(groups, 9, 2), [0, 3]);
  assert.deepEqual(history.rangeInfo(groups, [1, 3]).labels, ["verse", "chorus"]);
});

test("Use in planner fills the anchor and keeps header and sampling", () => {
  const n = node({ ...state.SCORE_DEFAULTS, header_mode: "fixed", temperature: 0.8 });
  history.useInPlanner(n, "NEW");
  assert.equal(value(n, "anchor_abc"), "NEW");
  assert.equal(value(n, "header_mode"), "fixed");
  history.useInPlanner(n, "FINAL", true);
  assert.equal(value(n, "header_mode"), "from anchor");
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
