import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/reference_transcribe.js", import.meta.url), "utf8").replace(/^export /gm, "");
const { referenceExecutionId, buildTranscriptionPrompt, queueTranscription } = new Function(source + "\nreturn {referenceExecutionId,buildTranscriptionPrompt,queueTranscription};")();

function fixture() {
  return {
    file: { class_type: "bno84.OptionalAudioEncoderFile", inputs: { name: "selected-model.safetensors" } },
    "33": { class_type: "bno84.ReferenceInput", inputs: { source: "Transcribe", audio: "chosen.wav",
      abc: "old ABC", extend: true, transcription_model: ["file", 0], transcription_mode: "melody" } },
    unrelated: { class_type: "SheetSage2AudioToABC", inputs: { audio: ["33", 1] } },
    another: { class_type: "SheetSage2AudioToABC", inputs: { audio: ["33", 1] } },
    music: { class_type: "YuE2GenerateMusic", inputs: { abc: ["33", 0] } },
  };
}

test("builds a dedicated job from explicit settings, without downstream discovery", () => {
  const original = fixture(), snapshot = structuredClone(original);
  const { output, sinkId } = buildTranscriptionPrompt(original, "33");
  const find = (type) => Object.entries(output).find(([, node]) => node.class_type === type);
  const [audioId, audio] = find("LoadAudio"), [modelId, model] = find("AudioEncoderLoader");
  const [scoreId, score] = find("SheetSage2AudioToABC");
  assert.equal(scoreId, "33", "native progress targets the reference node");
  assert.deepEqual(audio.inputs, { audio: "chosen.wav" });
  assert.deepEqual(model.inputs, { audio_encoder_name: ["file", 0] });
  assert.deepEqual(score.inputs, { audio: [audioId, 0], audio_encoder: [modelId, 0], mode: "melody" });
  assert.deepEqual(output[sinkId].inputs.source, [scoreId, 0]);
  assert.deepEqual(output.file, original.file);
  assert.equal(Object.keys(output).length, 5);
  assert.deepEqual(original, snapshot);
});

test("works disconnected and uses changed model selections", () => {
  const prompt = fixture();
  delete prompt.unrelated; delete prompt.another; delete prompt.music;
  prompt.file.inputs.name = "new-model.safetensors";
  assert.equal(buildTranscriptionPrompt(prompt, "33").output.file.inputs.name, "new-model.safetensors");
});

test("supports linked modes and copies only their upstream dependencies", () => {
  const prompt = fixture();
  prompt.mode = { class_type: "PrimitiveString", inputs: { value: "full" } };
  prompt["33"].inputs.transcription_mode = ["mode", 0];
  const { output } = buildTranscriptionPrompt(prompt, "33");
  assert.deepEqual(output.mode, prompt.mode);
  assert.deepEqual(Object.values(output).find((n) => n.class_type === "SheetSage2AudioToABC").inputs.mode, ["mode", 0]);
});

test("uses a connected loaded encoder directly, including nested execution IDs", () => {
  const prompt = fixture();
  prompt["models:encoder"] = { class_type: "CustomEncoderLoader", inputs: { filename: ["file", 0] } };
  prompt["33"].inputs.transcription_model = ["models:encoder", 0];
  const snapshot = structuredClone(prompt);
  const { output } = buildTranscriptionPrompt(prompt, "33", { CustomEncoderLoader: { output: ["AUDIO_ENCODER"] } });
  assert.deepEqual(output["models:encoder"], prompt["models:encoder"]);
  assert.deepEqual(output.file, prompt.file);
  assert.ok(!Object.values(output).some((n) => n.class_type === "AudioEncoderLoader"));
  const score = Object.values(output).find((n) => n.class_type === "SheetSage2AudioToABC");
  assert.deepEqual(score.inputs.audio_encoder, ["models:encoder", 0]);
  assert.deepEqual(prompt, snapshot);
});

test("rejects incompatible model types before queueing", () => {
  const prompt = fixture();
  assert.throws(() => buildTranscriptionPrompt(prompt, "33", {
    "bno84.OptionalAudioEncoderFile": { output: ["MODEL"] },
  }), /audio encoder file or a loaded AUDIO_ENCODER/);
});

test("native progress also targets nested reference execution IDs", () => {
  const prompt = fixture();
  prompt["group:33"] = prompt["33"];
  delete prompt["33"];
  const { output, sinkId } = buildTranscriptionPrompt(prompt, "group:33");
  assert.equal(output["group:33"].class_type, "SheetSage2AudioToABC");
  assert.deepEqual(output[sinkId].inputs.source, ["group:33", 0]);
});

test("reports missing settings, missing ancestors, and cycles", () => {
  const prompt = fixture();
  delete prompt["33"].inputs.transcription_model;
  assert.throws(() => buildTranscriptionPrompt(prompt, "33"), /Connect an optional/);
  prompt["33"].inputs.transcription_model = ["missing", 0];
  assert.throws(() => buildTranscriptionPrompt(prompt, "33"), /Missing transcription input/);
  prompt["33"].inputs.transcription_model = ["file", 0];
  prompt.file.inputs.name = ["33", 0];
  assert.throws(() => buildTranscriptionPrompt(prompt, "33"), /cycle/);
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
