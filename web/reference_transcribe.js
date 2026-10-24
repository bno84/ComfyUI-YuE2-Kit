// Submit just the connected SheetSage2 path through ComfyUI's normal queue.
const REFERENCE = "bno84.ReferenceInput";

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
}

export function referenceExecutionId(root, node) {
  const matches = [];
  function visit(graph, prefix, seen) {
    if (seen.has(graph)) return;
    const next = new Set(seen).add(graph);
    for (const candidate of graph._nodes ?? []) {
      const id = prefix + candidate.id;
      if (candidate === node) matches.push(id);
      if (candidate.subgraph) visit(candidate.subgraph, id + ":", next);
    }
  }
  visit(root, "", new Set());
  if (matches.length !== 1) throw new Error("Cannot identify this reference input in the workflow.");
  return matches[0];
}

export function buildTranscriptionPrompt(prompt, referenceId) {
  const reference = prompt[referenceId];
  if (reference?.class_type !== REFERENCE || reference.inputs.source !== "Transcribe") {
    throw new Error("Select the Transcribe tab first.");
  }
  if (!reference.inputs.audio) throw new Error("Select or drop an audio file first.");
  function usesAudio(value, seen = new Set()) {
    if (!isLink(value)) return false;
    const [id, slot] = value;
    if (id === referenceId) return slot === 1;
    if (seen.has(id)) return false;
    const next = new Set(seen).add(id);
    return Object.values(prompt[id]?.inputs ?? {}).some((input) => usesAudio(input, next));
  }
  const matches = Object.entries(prompt).filter(([, node]) =>
    node.class_type === "SheetSage2AudioToABC" && usesAudio(node.inputs.audio));
  if (!matches.length) throw new Error("Connect this reference's Audio output to a SheetSage2 transcription path first.");
  if (matches.length !== 1) throw new Error("More than one SheetSage2 path uses this reference. Connect one transcription path for Transcribe now.");
  const [transcriber] = matches[0];
  function ancestors(input) {
    const output = {}, visiting = new Set();
    function add(id) {
      if (output[id]) return;
      if (visiting.has(id)) throw new Error("The transcription path contains a cycle.");
      if (!input[id]) throw new Error(`Missing transcription input: ${id}.`);
      visiting.add(id);
      for (const value of Object.values(input[id].inputs)) if (isLink(value)) add(value[0]);
      output[id] = structuredClone(input[id]);
      visiting.delete(id);
    }
    add(transcriber);
    return output;
  }
  let output = ancestors(prompt);
  // With ordinary audio-only dependencies, use the native loader. This avoids
  // invalidating transcription caching when unrelated ABC/extension values change.
  const references = Object.values(output).flatMap((node) => Object.values(node.inputs))
    .filter((value) => isLink(value) && value[0] === referenceId);
  if (references.every((value) => value[1] === 1)) {
    output[referenceId] = { class_type: "LoadAudio", inputs: { audio: structuredClone(reference.inputs.audio) } };
    for (const node of Object.values(output)) for (const value of Object.values(node.inputs)) {
      if (isLink(value) && value[0] === referenceId) value[1] = 0;
    }
    output = ancestors(output);
  }
  const sinkId = `bno84_transcription_${referenceId.replaceAll(":", "_")}`;
  if (output[sinkId]) throw new Error("The transcription output ID is already in use.");
  output[sinkId] = { class_type: "PreviewAny", inputs: { source: [transcriber, 0] } };
  return { output, sinkId };
}

export function transcriptionError(error) {
  const response = error?.response ?? error;
  const details = Object.values(response?.node_errors ?? {}).flatMap((node) =>
    (node.errors ?? []).map((item) => item.details || item.message)).filter(Boolean);
  return details.join("; ") || response?.exception_message || response?.error?.message || error?.message || "Transcription failed.";
}

function scoreFrom(output) {
  const text = typeof output?.text === "string" ? output.text : output?.text?.length === 1 ? output.text[0] : undefined;
  if (typeof text !== "string" || !text.trim()) throw new Error("SheetSage2 returned no ABC score.");
  return text;
}

export function queueTranscription(api, { output, sinkId }, onStatus = () => {}, { pollInterval = 2000 } = {}) {
  let promptId, done = false, cancelled = false, timer, checking = false, missing = 0, result;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const listeners = new Map(), buffered = [];
  function finish(error, text) {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const [name, listener] of listeners) api.removeEventListener(name, listener);
    if (error) reject(error);
    else resolve(text);
  }
  async function history() {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`Cannot read transcription status (${response.status}).`);
    return (await response.json())[promptId];
  }
  function readHistory(entry) {
    if (!entry) return false;
    if (entry.status?.status_str === "error") {
      const failure = entry.status.messages?.find(([name]) => name === "execution_error" || name === "execution_interrupted");
      finish(new Error(failure ? transcriptionError(failure[1]) : "Transcription was interrupted."));
    } else if (entry.outputs?.[sinkId]) {
      try { finish(null, scoreFrom(entry.outputs[sinkId])); }
      catch (error) { finish(error); }
    } else if (entry.status?.completed) finish(new Error("Transcription finished without an ABC score."));
    else return false;
    return true;
  }
  async function refresh() {
    if (done || !promptId || checking || cancelled) return;
    checking = true;
    try {
      if (readHistory(await history()) || done) return;
      const response = await api.fetchApi("/queue");
      if (!response.ok) return;
      const queue = await response.json();
      if ((queue.queue_running ?? []).some((entry) => entry[1] === promptId)) {
        missing = 0; onStatus("Transcribing audio…");
      } else if ((queue.queue_pending ?? []).some((entry) => entry[1] === promptId)) {
        missing = 0; onStatus("Transcription queued…");
      } else if (++missing >= 2 && !readHistory(await history())) {
        finish(new Error("Transcription is no longer in the queue."));
      }
    } catch { if (!done) onStatus("Waiting for ComfyUI…"); }
    finally { checking = false; }
  }
  function event(name, data) {
    if (done) return;
    if (!promptId) { buffered.push([name, data]); return; }
    if (data.prompt_id !== promptId) return;
    if (name === "execution_error" || name === "execution_interrupted") {
      finish(new Error(name === "execution_interrupted" ? "Transcription was interrupted." : transcriptionError(data)));
    } else if (name === "execution_start") onStatus("Transcribing audio…");
    else if (name === "executed" && data.node === sinkId) result = data.output;
    else if (name === "execution_success") {
      if (result) {
        try { finish(null, scoreFrom(result)); }
        catch (error) { finish(error); }
      } else void refresh();
    }
  }
  for (const name of ["execution_start", "executed", "execution_success", "execution_error", "execution_interrupted"]) {
    const listener = (e) => event(name, e.detail ?? {});
    listeners.set(name, listener); api.addEventListener(name, listener);
  }
  const submitted = (async () => {
    onStatus("Queueing transcription…");
    try {
      const response = await api.queuePrompt(0, { output });
      if (!response?.prompt_id) throw new Error("ComfyUI did not return a transcription job ID.");
      promptId = response.prompt_id;
      if (cancelled || done) return;
      onStatus("Transcription queued…");
      for (const [name, data] of buffered.splice(0)) event(name, data);
      if (!done) { timer = setInterval(refresh, pollInterval); void refresh(); }
    } catch (error) { finish(new Error(transcriptionError(error))); }
  })();
  async function cancel() {
    if (done) return;
    cancelled = true;
    onStatus("Cancelling transcription…");
    await submitted;
    if (done) return;
    try {
      for (const [path, body] of [["/queue", { delete: [promptId] }], ["/interrupt", { prompt_id: promptId }]]) {
        const response = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Could not cancel transcription (${response.status}).`);
      }
      finish(new Error("Transcription cancelled."));
    } catch (error) { finish(new Error(transcriptionError(error))); }
  }
  return { promise, cancel };
}
