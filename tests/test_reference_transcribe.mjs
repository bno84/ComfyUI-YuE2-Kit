import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/reference_transcribe.js", import.meta.url), "utf8").replace(/^export /gm, "");
const { referenceExecutionId, buildTranscriptionPrompt, queueTranscription } = new Function(source + "\nreturn {referenceExecutionId,buildTranscriptionPrompt,queueTranscription};")();

function fixture() {
  return {
    unrelated: { class_type: "SheetSage2AudioToABC", inputs: { audio: ["other", 1], audio_encoder: ["otherModel", 0], mode: "full" } },
    other: { class_type: "bno84.ReferenceInput", inputs: { source: "Transcribe", audio: "other.wav", abc: "", extend: false } },
    otherModel: { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: "wrong-model.safetensors" } },
    "33": { class_type: "bno84.ReferenceInput", inputs: { source: "Transcribe", audio: "chosen.wav", abc: "old ABC", extend: true } },
    "34:15": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: "selected-model.safetensors" } },
    "30:36:40:16": { class_type: "SheetSage2AudioToABC", inputs: { audio: ["33", 1], audio_encoder: ["34:15", 0], mode: "melody" } },
    music: { class_type: "YuE2GenerateMusic", inputs: { abc: ["30:36:40:16", 0] } },
    extend: { class_type: "bno84.YuE2ExtendABC", inputs: { abc: ["30:36:40:16", 0] } },
  };
}

test("uses the connected model and mode, excluding unrelated transcription and all generation", () => {
  const original = fixture(), snapshot = structuredClone(original);
  const { output, sinkId } = buildTranscriptionPrompt(original, "33");
  assert.deepEqual(output["34:15"], snapshot["34:15"]);
  assert.equal(output["30:36:40:16"].inputs.mode, "melody");
  assert.deepEqual(output["30:36:40:16"].inputs.audio_encoder, ["34:15", 0]);
  assert.deepEqual(output["33"], { class_type: "LoadAudio", inputs: { audio: "chosen.wav" } });
  assert.deepEqual(output["30:36:40:16"].inputs.audio, ["33", 0]);
  assert.deepEqual(output[sinkId].inputs.source, ["30:36:40:16", 0]);
  assert.equal(Object.keys(output).length, 4);
  assert.deepEqual(original, snapshot);
});

test("model changes in the main group are reflected in the next submission", () => {
  const prompt = fixture();
  prompt["34:15"].inputs.audio_encoder_name = "new-selection.safetensors";
  const built = buildTranscriptionPrompt(prompt, "33");
  assert.equal(built.output["34:15"].inputs.audio_encoder_name, "new-selection.safetensors");
});

test("disconnected and ambiguous transcription paths report errors", () => {
  const prompt = fixture();
  delete prompt["30:36:40:16"];
  assert.throws(() => buildTranscriptionPrompt(prompt, "33"), /Connect this reference/);
  prompt.one = structuredClone(prompt.unrelated); prompt.one.inputs.audio = ["33", 1];
  prompt.two = structuredClone(prompt.one);
  assert.throws(() => buildTranscriptionPrompt(prompt, "33"), /More than one/);
});

test("nested reference execution IDs follow the actual node instance", () => {
  const node = { id: 8 }, root = { _nodes: [{ id: 7, subgraph: { _nodes: [node] } }] };
  assert.equal(referenceExecutionId(root, node), "7:8");
});

class FakeApi extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener) { super.addEventListener(name, listener); this.listeners.set(listener, name); }
  removeEventListener(name, listener) { super.removeEventListener(name, listener); this.listeners.delete(listener); }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
const jobPrompt = { output: { result: { class_type: "PreviewAny", inputs: { source: "abc" } } }, sinkId: "result" };
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test("captures fast execution events arriving before the queue response", async () => {
  const api = new FakeApi(), statuses = [];
  api.queuePrompt = async (number, prompt) => {
    assert.equal(number, 0); assert.deepEqual(prompt, { output: jobPrompt.output });
    api.emit("execution_start", { prompt_id: "own" });
    api.emit("executed", { prompt_id: "own", node: "result", output: { text: ["ABC\n"] } });
    api.emit("execution_success", { prompt_id: "own" });
    return { prompt_id: "own" };
  };
  const job = queueTranscription(api, jobPrompt, (status) => statuses.push(status));
  assert.equal(await job.promise, "ABC\n");
  assert.ok(statuses.includes("Transcribing audio…"));
  assert.equal(api.listeners.size, 0);
});

test("recovers cached results from history without execution events", { timeout: 1000 }, async () => {
  const api = new FakeApi();
  api.queuePrompt = async () => ({ prompt_id: "cached" });
  api.fetchApi = async (path) => {
    assert.equal(path, "/history/cached");
    return json({ cached: { outputs: { result: { text: ["cached ABC"] } }, status: { completed: true, status_str: "success" } } });
  };
  const job = queueTranscription(api, jobPrompt);
  assert.equal(await job.promise, "cached ABC");
  assert.equal(api.listeners.size, 0);
});

test("queue validation errors surface the selected model error", async () => {
  const api = new FakeApi();
  api.queuePrompt = async () => { throw { response: { error: { message: "validation failed" }, node_errors: { model: { errors: [{ details: "selected-model.safetensors is missing" }] } } } }; };
  const job = queueTranscription(api, jobPrompt);
  await assert.rejects(job.promise, /selected-model.safetensors is missing/);
  assert.equal(api.listeners.size, 0);
});

test("ignores unrelated failures and handles the matching execution error", async () => {
  const api = new FakeApi();
  api.queuePrompt = async () => {
    api.emit("execution_error", { prompt_id: "other", exception_message: "unrelated" });
    api.emit("execution_error", { prompt_id: "own", exception_message: "model failed" });
    return { prompt_id: "own" };
  };
  const job = queueTranscription(api, jobPrompt);
  await assert.rejects(job.promise, /model failed/);
  assert.equal(api.listeners.size, 0);
});

test("cancel while submitting deletes and interrupts only that prompt ID", async () => {
  const api = new FakeApi(), requests = [];
  let response;
  api.queuePrompt = () => new Promise((resolve) => { response = resolve; });
  api.fetchApi = async (path, options) => { requests.push([path, JSON.parse(options.body)]); return new Response(null, { status: 200 }); };
  const job = queueTranscription(api, jobPrompt);
  const rejected = assert.rejects(job.promise, /cancelled/);
  const cancelled = job.cancel();
  response({ prompt_id: "only-this-job" });
  await cancelled; await rejected;
  assert.deepEqual(requests, [["/queue", { delete: ["only-this-job"] }], ["/interrupt", { prompt_id: "only-this-job" }]]);
  assert.equal(api.listeners.size, 0);
});

test("detects a job removed from the queue", { timeout: 1000 }, async () => {
  const api = new FakeApi();
  api.queuePrompt = async () => ({ prompt_id: "removed" });
  api.fetchApi = async (path) => json(path === "/queue" ? { queue_running: [], queue_pending: [] } : {});
  const job = queueTranscription(api, jobPrompt, () => {}, { pollInterval: 5 });
  await assert.rejects(job.promise, /no longer in the queue/);
  assert.equal(api.listeners.size, 0);
});
