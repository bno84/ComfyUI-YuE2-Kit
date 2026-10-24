import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { referenceExecutionId, buildTranscriptionPrompt, queueTranscription, transcriptionError } from "./reference_transcribe.js";

const NODE = "bno84.ReferenceInput";
const SOURCES = ["None", "ABC", "Transcribe"];

export function referenceFileKind(file) {
  if (/\.abc$/i.test(file?.name ?? "")) return "ABC";
  if ((file?.type?.startsWith("audio/") || file?.type?.startsWith("video/")) || /\.(wav|mp3|flac|ogg|opus|m4a|aac|aiff?|weba|mp4|webm|mov|mkv)$/i.test(file?.name ?? "")) return "Transcribe";
  return null;
}

export function audioViewPath(path) {
  const parts = path.split("/");
  const filename = parts.pop();
  return `/view?${new URLSearchParams({ filename, subfolder: parts.join("/"), type: "input" })}`;
}

function styles() {
  if (document.getElementById("yue2-reference-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-reference-style";
  style.textContent = `
.yue2-reference {box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:100%;height:100%;min-height:0;color:var(--input-text,#ddd);font:13px sans-serif;padding:5px;}
.yue2-reference [hidden] {display:none!important;}
.yue2-reference .ref-tabs {display:flex;flex:none;border:1px solid var(--border-color,#555);border-radius:6px;overflow:hidden;}
.yue2-reference button,.yue2-reference select {font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:6px;}
.yue2-reference .ref-tabs button {flex:1;border:0;border-radius:0;cursor:pointer;}
.yue2-reference .ref-tabs button[aria-selected=true] {background:var(--p-button-primary-background,#405c83);color:var(--p-button-primary-color,#fff);}
.yue2-reference .ref-body {display:flex;flex:1;flex-direction:column;gap:8px;min-height:0;}
.yue2-reference textarea {box-sizing:border-box;width:100%;flex:1 1 0;min-height:120px;resize:none;background:var(--comfy-input-bg,#1b1b1b);color:inherit;border:1px solid var(--border-color,#555);border-radius:4px;padding:8px;font:12px/1.45 monospace;}
.yue2-reference .ref-audio {flex:0 0 auto;min-height:92px;}
.yue2-reference .ref-row {flex:none;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.yue2-reference select {min-width:0;flex:1;}
.yue2-reference audio {display:block;flex:none;width:100%;height:44px;min-height:44px;}
.yue2-reference .ref-extend {flex:none;display:flex;gap:6px;align-items:center;}
.yue2-reference .ref-status {flex:none;font-size:12px;opacity:.8;overflow-wrap:anywhere;}
.yue2-reference .ref-status:empty {display:none;}
.yue2-reference .ref-status[data-error=true] {color:#ff9d9d;}
.yue2-reference.ref-drag {outline:2px solid #76a5eb;outline-offset:-2px;}
`;
  document.head.append(style);
}

class ReferencePanel {
  constructor(node) {
    this.node = node;
    styles();
    this.root = document.createElement("div");
    this.root.className = "yue2-reference";
    this.root.innerHTML = `
      <div class="ref-tabs" role="tablist" aria-label="Reference source">
        <button type="button" role="tab" data-source="None">None</button>
        <button type="button" role="tab" data-source="ABC">ABC</button>
        <button type="button" role="tab" data-source="Transcribe">Transcribe</button>
      </div>
      <div class="ref-body ref-abc" role="tabpanel" aria-label="ABC reference">
        <textarea aria-label="ABC score" placeholder="Paste ABC or drop an .abc file"></textarea>
        <div class="ref-row"><button type="button" class="ref-open-abc">Open ABC…</button></div>
      </div>
      <div class="ref-body ref-audio" role="tabpanel" aria-label="Audio reference">
        <div class="ref-row"><select class="ref-files" aria-label="Reference audio file"></select><button type="button" class="ref-upload">Upload audio…</button></div>
        <audio controls aria-label="Reference audio preview"></audio>
        <div class="ref-row"><button type="button" class="ref-transcribe">Transcribe now</button><button type="button" class="ref-cancel" hidden>Cancel</button></div>
      </div>
      <label class="ref-extend"><input type="checkbox"> Extend reference</label>
      <div class="ref-status" role="status"></div>`;
    this.abc = this.root.querySelector("textarea");
    this.audio = this.root.querySelector("audio");
    this.files = this.root.querySelector(".ref-files");
    this.extend = this.root.querySelector(".ref-extend input");
    this.status = this.root.querySelector(".ref-status");
    this.transcribeButton = this.root.querySelector(".ref-transcribe");
    this.cancelButton = this.root.querySelector(".ref-cancel");
    this.transcribeButton.onclick = () => this.transcribeNow();
    this.cancelButton.onclick = () => this.transcriptionJob?.cancel();
    for (const button of this.root.querySelectorAll("[data-source]")) button.onclick = () => this.set("source", button.dataset.source);
    this.abc.oninput = () => {
      this.message(); this.set("abc", this.abc.value, false);
    };
    this.extend.onchange = () => this.set("extend", this.extend.checked);
    this.files.onchange = () => this.set("audio", this.files.value);
    this.root.querySelector(".ref-tabs").onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = SOURCES.indexOf(this.get("source"));
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
      this.set("source", SOURCES[next]);
      this.root.querySelector(`[data-source="${SOURCES[next]}"]`).focus();
    };
    this.abcChooser = this.chooser(".abc", (file) => this.drop(file));
    this.audioChooser = this.chooser("audio/*,video/*,.wav,.mp3,.flac,.ogg,.opus,.m4a,.aac,.aif,.aiff", (file) => this.drop(file));
    this.root.querySelector(".ref-open-abc").onclick = () => this.abcChooser.click();
    this.root.querySelector(".ref-upload").onclick = () => this.audioChooser.click();
    for (const event of ["pointerdown", "mousedown", "keydown", "wheel"]) this.root.addEventListener(event, (e) => e.stopPropagation());
    this.root.ondragover = (event) => { if (this.canDrag(event)) { event.preventDefault(); event.stopPropagation(); this.root.classList.add("ref-drag"); } };
    this.root.ondragleave = () => this.root.classList.remove("ref-drag");
    this.root.ondrop = (event) => {
      this.root.classList.remove("ref-drag");
      const file = event.dataTransfer?.files?.[0];
      if (!referenceFileKind(file)) return;
      event.preventDefault(); event.stopPropagation(); this.drop(file);
    };
    this.widget = node.addDOMWidget("reference_panel", "reference_panel", this.root, {
      serialize: false, canvasOnly: true, hideOnZoom: false,
      getMinHeight: () => 260,
    });
    this.widget.serialize = false;
    this.widget.options.serialize = false;
    this.render();
    this.ensureMinimumSize();
  }

  get(name) { return this.node.widgets.find((widget) => widget.name === name)?.value; }
  set(name, value, render = true) {
    const widget = this.node.widgets.find((widget) => widget.name === name);
    this.node.graph?.beforeChange?.();
    widget.value = value;
    widget.callback?.(value);
    this.node.graph?.afterChange?.();
    this.node.graph?.setDirtyCanvas(true, true);
    if (render) this.render();
  }
  ensureMinimumSize() {
    const minimum = this.node.computeSize();
    if (this.node.size[0] < 440 || this.node.size[1] < minimum[1]) {
      this.node.setSize([Math.max(this.node.size[0], 440), Math.max(this.node.size[1], minimum[1])]);
    }
  }
  message(text = "", error = false) {
    this.status.textContent = text;
    this.status.dataset.error = String(error);
  }
  chooser(accept, choose) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept; input.hidden = true;
    input.onchange = () => { if (input.files[0]) choose(input.files[0]); input.value = ""; };
    this.root.append(input); return input;
  }
  canDrag(event) { return Array.from(event.dataTransfer?.types ?? []).includes("Files"); }
  async drop(file) {
    const kind = referenceFileKind(file);
    if (!kind) return false;
    if (this.uploading) { this.message("An upload is already running.", true); return true; }
    if (this.transcribing) { this.message("Finish or cancel transcription before loading another reference.", true); return true; }
    try {
      this.uploading = true; this.node.isUploading = true;
      this.pauseAudio(); this.set("source", kind); this.message();
      if (kind === "ABC") {
        const text = await file.text();
        if (!this.destroyed) this.set("abc", text);
      } else {
        this.message("Uploading audio…");
        const data = new FormData(); data.append("image", file); data.append("type", "input");
        const response = await api.fetchApi("/upload/image", { method: "POST", body: data });
        if (!response.ok) throw new Error(`Audio upload failed (${response.status}).`);
        const uploaded = await response.json();
        if (this.destroyed) return true;
        const path = [uploaded.subfolder, uploaded.name].filter(Boolean).join("/");
        const widget = this.node.widgets.find((widget) => widget.name === "audio");
        if (Array.isArray(widget.options?.values) && !widget.options.values.includes(path)) widget.options.values.push(path);
        this.set("audio", path); this.message();
      }
    } catch (error) { this.message(error.message, true); }
    finally { this.uploading = false; this.node.isUploading = false; this.updateActionState(); }
    return true;
  }
  render() {
    const source = SOURCES.includes(this.get("source")) ? this.get("source") : "None";
    if (source !== this.lastSource) { this.pauseAudio(); this.message(); this.lastSource = source; }
    for (const button of this.root.querySelectorAll("[data-source]")) {
      button.setAttribute("aria-selected", String(button.dataset.source === source));
      button.tabIndex = button.dataset.source === source ? 0 : -1;
    }
    this.root.querySelector(".ref-abc").hidden = source !== "ABC";
    this.root.querySelector(".ref-audio").hidden = source !== "Transcribe";
    this.root.querySelector(".ref-extend").hidden = source === "None";
    this.status.hidden = source === "None";
    if (this.abc.value !== this.get("abc")) this.abc.value = this.get("abc") ?? "";
    this.extend.checked = !!this.get("extend");
    const selected = this.get("audio") ?? "";
    const widget = this.node.widgets.find((widget) => widget.name === "audio");
    const values = typeof widget.options?.values === "function" ? widget.options.values() : Array.from(widget.options?.values ?? []);
    this.files.replaceChildren(...[...new Set(["", ...values, selected])].map((value) => new Option(value || "Choose audio…", value)));
    this.files.value = selected;
    const url = source === "Transcribe" && selected ? api.apiURL(audioViewPath(selected)) : "";
    if (this.audio.getAttribute("src") !== url) {
      this.audio.pause();
      if (url) this.audio.src = url;
      else this.audio.removeAttribute("src");
    }
    this.updateActionState();
    this.node.graph?.setDirtyCanvas(true, true);
  }
  updateActionState() {
    this.transcribeButton.disabled = !this.get("audio") || this.uploading || this.transcribing;
    this.transcribeButton.textContent = this.transcribing ? "Transcribing…" : "Transcribe now";
    this.cancelButton.hidden = !this.transcribing;
    this.cancelButton.disabled = !this.transcriptionJob;
    this.files.disabled = !!this.transcribing;
    this.root.querySelector(".ref-upload").disabled = !!this.transcribing;
    this.root.querySelector(".ref-open-abc").disabled = !!this.transcribing;
  }
  async transcribeNow() {
    if (this.transcribing || this.uploading || this.get("source") !== "Transcribe" || !this.get("audio")) return;
    this.transcribing = true; this.updateActionState();
    const previousABC = this.get("abc"), previousAudio = this.get("audio");
    try {
      this.message("Preparing transcription…");
      const root = this.node.graph?.rootGraph ?? this.node.graph;
      const id = referenceExecutionId(root, this.node);
      const compiled = await app.graphToPrompt(root);
      if (this.destroyed) return;
      const prompt = buildTranscriptionPrompt(compiled.output, id);
      this.transcriptionJob = queueTranscription(api, prompt, (status) => { if (!this.destroyed) this.message(status); });
      this.updateActionState();
      const abc = await this.transcriptionJob.promise;
      if (this.destroyed) return;
      if (this.get("abc") !== previousABC || this.get("audio") !== previousAudio) {
        this.message("Transcription finished, but the reference changed; your edits were kept."); return;
      }
      this.set("abc", abc, false); this.set("source", "ABC");
      this.message();
    } catch (error) { if (!this.destroyed) this.message(transcriptionError(error), true); }
    finally { this.transcriptionJob = null; this.transcribing = false; this.updateActionState(); }
  }
  pauseAudio() { this.audio?.pause(); }
  destroy() { this.destroyed = true; void this.transcriptionJob?.cancel(); this.pauseAudio(); this.root.remove(); }
}

app.registerExtension({
  name: "bno84.ReferenceInput",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    for (const widget of node.widgets ?? []) {
      widget.type = "hidden"; widget.hidden = true; widget.computeSize = () => [0, -4];
      widget.options ??= {}; widget.options.hidden = true;
      if (widget.element) widget.element.style.display = "none";
      if (widget.options.getMinHeight) widget.options.getMinHeight = () => 0;
      if (widget.options.getHeight) widget.options.getHeight = () => 0;
    }
    const panel = new ReferencePanel(node);
    const configured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) { const result = configured?.apply(this, args); panel.render(); panel.ensureMinimumSize(); return result; };
    const removed = node.onRemoved;
    node.onRemoved = function (...args) { panel.destroy(); return removed?.apply(this, args); };
    const over = node.onDragOver, drop = node.onDragDrop;
    node.onDragOver = function (event) { return panel.canDrag(event) || over?.call(this, event); };
    node.onDragDrop = async function (event) { return await panel.drop(event.dataTransfer?.files?.[0]) || await drop?.call(this, event) || false; };
  },
});
