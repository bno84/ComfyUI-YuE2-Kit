import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readValues, setValues, applicable, rangeSelection, previewValues } from "./score_state.js";
import { referenceExecutionId, buildTranscriptionPrompt, queueTranscription, transcriptionError } from "./reference_transcribe.js";
import { referenceFileKind } from "./reference_input.js";

import {fillStrip, barAxis, selectionOverlay, releaseStrip, STAGE_PALETTE, keyWords, sourceSummary} from "./score_strip.js";

const OPEN = "Open ABC or audio…";
const element = (tag, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
function insertBefore(node, widget, before) {
  node.widgets.splice(node.widgets.indexOf(widget), 1);
  node.widgets.splice(node.widgets.findIndex(w => w.name === before), 0, widget);
}
function separator(node, before) {
  const widget = node.addCustomWidget({name: `__separator_${before}`, type: "custom", serialize: false,
    options: {serialize: false}, computeSize: () => [0, 12], draw(ctx, node, width, y) {
      ctx.save(); ctx.strokeStyle = "#888"; ctx.globalAlpha = .4; ctx.beginPath();
      ctx.moveTo(12, y + 6); ctx.lineTo(node.size[0] - 12, y + 6); ctx.stroke(); ctx.restore();
    }});
  insertBefore(node, widget, before);
}
export function updateWidgets(node) {
  const v = readValues(node);
  // Only native disabled support. Never install a custom disabled draw override.
  for (const [name, enabled] of Object.entries(applicable(v))) {
    const w = node.widgets?.find(w => w.name === name);
    if (w && "disabled" in w) w.disabled = !enabled;
  }
  const cont = node.widgets?.find(w => w.name === "continue_generate");
  if (!v.anchor_use && cont && cont.value !== true) cont.value = true;
}

export class ScorePanel {
  constructor(node) {
    this.node = node; this.request = 0;
    this.root = element("div"); this.root.className = "yue2-score-timeline";
    this.root.style.cssText = "width:100%;font:12px sans-serif;color:#ccd6e0;box-sizing:border-box;overflow:hidden";
    this.track = element("div"); this.track.className="yue2-score-stages"; this.track.style.cssText="display:flex;gap:10px;background:#202730;padding:6px;box-sizing:border-box;width:100%";
    this.status = element("div"); this.status.style.cssText = "white-space:pre-wrap;padding:4px 0";
    this.root.append(this.track, this.status);
    const timeline = node.addDOMWidget("score_timeline", "score_timeline", this.root,
      {serialize: false, getMinHeight: () => 112, getMaxHeight: () => 112, hideOnZoom:false});
    timeline.serialize = false; insertBefore(node, timeline, "header_mode");
    separator(node, "header_mode");
    for (const before of ["opening_generate", "anchor_use", "continue_generate", "mode"]) separator(node, before);
    this.range = element("div"); this.range.className = "yue2-score-range";
    this.range.style.cssText = "width:100%;box-sizing:border-box;color:#ccd6e0;font:11px/18px sans-serif";
    this.rangeSummary = element("div"); this.rangeSummary.className="yue2-source-summary";
    this.rangeTrack = element("div"); this.rangeTrack.className="yue2-source-track";
    this.range.append(this.rangeSummary,this.rangeTrack);
    const rangeWidget = node.addDOMWidget("anchor_range", "anchor_range", this.range,
      {serialize: false, getMinHeight: () => 84, getMaxHeight: () => 84, hideOnZoom:false});
    rangeWidget.serialize = false; insertBefore(node, rangeWidget, "anchor_abc");
    // These two native scalar widgets are the strip's backing values. Numeric
    // fields are intentionally replaced by the strip; all other controls stay visible.
    for (const name of ["anchor_start", "anchor_end"]) {
      const w = node.widgets.find(w => w.name === name);
      // Retain native number type so Convert to input remains available.
      w.draw = () => {}; w.computeSize = () => [0, -4];
    }
    // Dropping an .abc file or audio on the node does the same as this button.
    this.chooser = Object.assign(document.createElement("input"), {type: "file", hidden: true,
      accept: ".abc,audio/*,video/*,.wav,.mp3,.flac,.ogg,.opus,.m4a,.aac,.aif,.aiff"});
    this.chooser.onchange = () => { const file = this.chooser.files[0]; this.chooser.value = ""; if (file) void this.load(file); };
    document.body.append(this.chooser);
    this.open = node.addWidget("button", OPEN, null, () => this.job ? void this.job.cancel() : this.chooser.click(), {serialize: false});
    this.open.serialize = false; insertBefore(node, this.open, "__separator_continue_generate");
    this.refresh();
  }
  // Preview messages are replaced on every refresh; a note about the last loaded file stays.
  message(text) { this.preview = text; this.status.textContent = [this.noteText, text].filter(Boolean).join("\n"); }
  note(text) { this.noteText = text; this.message(this.preview); }
  refresh() {
    if (this.destroyed || this.dragging) return;
    updateWidgets(this.node); clearTimeout(this.timer);
    const serial = ++this.request;
    this.timer = setTimeout(async () => {
      let values = readValues(this.node);
      try {
        if (this.node.inputs?.some(i => i.link != null && !["clip","sheetsage2","lyrics","style","seed"].includes(i.name))) {
          const graph = this.node.graph?.rootGraph ?? this.node.graph;
          const compiled = await app.graphToPrompt(graph);
          if (this.destroyed || serial !== this.request) return;
          const id = referenceExecutionId(graph,this.node);
          values = previewValues(this.node,compiled.output,id);
          if (!values) { this.data = null; this.render(); this.message("Linked settings resolve when run; stored widget values are kept for disconnect."); return; }
        }
        const response = await api.fetchApi("/yue2-kit/score/preview", {method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify(values)});
        if (!response.ok) throw Error(`Score preview failed (${response.status}).`);
        const data = await response.json();
        if (this.destroyed || serial !== this.request) return;
        this.data = data; this.render();
        this.message(data.errors?.length ? data.errors.join("\n") : (data.diagnostics ?? []).map(d => d.message).join("\n"));
      } catch (error) { if (!this.destroyed && serial === this.request) { this.data = null; this.render(); this.message(error.message); } }
    }, 160);
  }
  render() {
    const data = this.data, v = readValues(this.node);
    releaseStrip(this.track); this.track.replaceChildren();
    const header=element("div"); header.className="yue2-score-header";
    header.style.cssText="flex:0 0 140px;font:11px/18px sans-serif;border-right:1px solid #78889a55;padding-right:8px";
    const fixed=data?.header?.fixed ?? {}, policies=data?.header?.policies ?? {};
    for (const [label,field,name] of [["Tempo","Q","tempo"],["Meter","M","meter"],["Key","K","key"]]) {
      const policy=policies[name]?.policy ?? (v.header_mode==="fixed" ? "set" : v.header_mode==="from anchor" ? "anchor" : "free");
      const mode={set:"fixed",anchor:"anchor",free:"model"}[policy];
      const raw=fixed[field] ?? (policy==="set" ? {Q:v.header_tempo,M:v.header_meter,K:v.header_key}[field] : null);
      const value=label==="Key" ? (raw ? keyWords(String(raw)) : "model") : label==="Tempo" ? (data?.timing?.bpm ?? raw ?? "model") : (raw ?? "model");
      header.append(element("div",`${label} ${value} · ${mode}`));
    }
    const body=element("div"); body.style.cssText="flex:1;min-width:0";
    const track=element("div");
    const spans=(data?.spans ?? []).filter(s=>s.end!==s.start);
    const total=Math.max(1,...spans.map(s=>s.end ?? s.start+8));
    const segments=spans.flatMap(span=> {
      const bars=(span.end ?? span.start+8)-span.start;
      if(span.stage==="anchor" && data.anchor?.sections?.length) return data.anchor.sections.map(section=>({
        ...section,bar:span.start+section.bar}));
      const label={fresh:"Song",opening:v.opening_hint || "Opening",continuation:"Continuation",anchor:"Anchor"}[span.stage];
      const seconds=span.stage==="opening" ? bars*(data.source?.bar_seconds ?? 0)*(data.source?.bpm ?? 120)/(data.timing?.bpm ?? 120) : null;
      return [{bar:span.start,bars,label,unknown:span.end==null,color:STAGE_PALETTE[span.stage],seconds:seconds || null}];
    });
    fillStrip(track,segments,total); body.append(track,barAxis(total)); this.track.append(header,body);
    this.renderRange({...v,...(data?.anchor ? {anchor_start:data.anchor.start+1,anchor_end:data.anchor.end} : {})}, data?.source);
  }
  renderRange(v, source) {
    releaseStrip(this.rangeTrack); this.rangeTrack.replaceChildren();
    const oldAxis=this.range.querySelector(".yue2-bar-axis"); releaseStrip(oldAxis); oldAxis?.remove();
    const total = source?.bars;
    const start=Math.min(total || 1,Math.max(1,v.anchor_start)), end=Math.max(start,Math.min(total || 1,v.anchor_end || total || 1));
    this.rangeSummary.textContent=sourceSummary(source,start,end);
    this.range.style.opacity=v.anchor_use ? "1" : ".5";
    if (!total) { this.rangeTrack.textContent=""; return; }
    fillStrip(this.rangeTrack,source.sections ?? [],total);
    this.range.append(barAxis(total));
    const {outline:selected,handles}=selectionOverlay(this.rangeTrack);
    selected.style.left=`${100*(start-1)/total}%`; selected.style.width=`${100*(end-start+1)/total}%`;
    const begin = (event, side) => {
      if (!v.anchor_use || event.button !== 0 || this.linkedRange()) return;
      event.preventDefault(); event.stopPropagation();
      const target = event.currentTarget;
      const box = this.rangeTrack.getBoundingClientRect(), from = (event.clientX-box.left)/box.width*total;
      target.setPointerCapture(event.pointerId);
      this.node.graph?.beforeChange?.();
      const move = e => {
        const [a,b] = rangeSelection(total, start, end, side, from, (e.clientX-box.left)/box.width*total);
        setValues(this.node, {anchor_start:a, anchor_end:b});
        // Keep the drag target alive until pointerup.
        selected.style.left = `${100*(a-1)/total}%`; selected.style.width = `${100*(b-a+1)/total}%`;
        this.rangeSummary.textContent=sourceSummary(source,a,b);
      };
      target.onpointermove = move;
      target.onpointerup = target.onpointercancel = () => { target.onpointermove = null; target.onpointerup = null; target.onpointercancel = null; this.dragging = false; this.node.graph?.afterChange?.(); this.refresh(); };
      this.dragging = true; move(event);
    };
    handles.forEach((handle,side)=>{handle.onpointerdown=e=>begin(e,side);});
    this.rangeTrack.onpointerdown = e => begin(e, null);
  }
  linkedRange() { return this.node.inputs?.some(i => ["anchor_start","anchor_end"].includes(i.name) && i.link != null); }
  // An .abc file becomes the anchor; audio is uploaded, then transcribed into the anchor.
  async load(file) {
    const kind = referenceFileKind(file);
    if (!kind) return false;
    if (this.job || this.node.isUploading) { this.note("Wait for the current file to finish."); return true; }
    try {
      this.note("");
      if (kind === "ABC") this.useAnchor(await file.text());
      else await this.transcribe(file);
    } catch (error) {
      // Cancelling was the user's own action; only failures need a word.
      if (!this.destroyed && error?.message !== "Transcription cancelled.") this.note(`${file.name}: ${transcriptionError(error)}`);
    }
    return true;
  }
  useAnchor(abc) {
    this.node.graph?.beforeChange?.();
    setValues(this.node, {anchor_abc: abc, anchor_use: true, anchor_start: 1, anchor_end: 0});
    this.node.graph?.afterChange?.();
  }
  async transcribe(file) {
    const root = this.node.graph?.rootGraph ?? this.node.graph;
    const id = referenceExecutionId(root, this.node);
    const {output} = await app.graphToPrompt(root);
    const encoder = output[id]?.inputs?.sheetsage2;
    if (!encoder) throw Error("connect the SheetSage2 file from Models to transcribe audio.");
    this.node.isUploading = true;
    let path;
    try {
      const data = new FormData(); data.append("image", file); data.append("type", "input");
      const response = await api.fetchApi("/upload/image", {method: "POST", body: data});
      if (!response.ok) throw Error(`upload failed (${response.status}).`);
      const uploaded = await response.json();
      path = [uploaded.subfolder, uploaded.name].filter(Boolean).join("/");
    } finally { this.node.isUploading = false; }
    const definitions = await api.fetchApi("/object_info");
    if (!definitions.ok) throw Error(`cannot read node types (${definitions.status}).`);
    const mode = readValues(this.node).mode;
    const job = buildTranscriptionPrompt(output, id, await definitions.json(), {audio: path, encoder, mode});
    const before = readValues(this.node).anchor_abc;
    // The transcriber runs under this node's ID, so ComfyUI's own progress bar shows it.
    this.job = queueTranscription(api, job);
    this.open.label = this.open.name = "Cancel transcription"; this.node.setDirtyCanvas?.(true, true);
    try {
      const abc = await this.job.promise;
      if (this.destroyed) return;
      if (readValues(this.node).anchor_abc !== before) { this.note(`${file.name}: transcribed, but the anchor was edited meanwhile; kept your edits.`); return; }
      this.useAnchor(abc);
    } finally {
      this.job = null;
      if (!this.destroyed) { this.open.label = this.open.name = OPEN; this.node.setDirtyCanvas?.(true, true); }
    }
  }
  destroy() { this.destroyed = true; void this.job?.cancel(); this.chooser.remove(); clearTimeout(this.timer); this.request++; releaseStrip(this.root); releaseStrip(this.range); this.root.remove(); this.range.remove(); }
}
app.registerExtension({
  name: "bno84.Score",
  nodeCreated(node) {
    if (node.comfyClass !== "bno84.YuE2Score") return;
    const panel = node.yue2ScorePanel = new ScorePanel(node);
    for (const hook of ["onConfigure", "onGraphConfigured", "onWidgetChanged", "onConnectionsChange"]) {
      const previous = node[hook]; node[hook] = function (...args) {
        const value = previous?.apply(this,args); if (!panel.dragging) panel.refresh(); return value;
      };
    }
    for (const widget of node.widgets ?? []) {
      const previous = widget.callback;
      widget.callback = function (...args) { const result = previous?.apply(this,args); if (!panel.dragging) panel.refresh(); return result; };
    }
    const abc=node.widgets.find(w=>w.name==="anchor_abc");
    const changed=()=>panel.refresh();
    abc?.element?.addEventListener("input",changed);
    const syncWidth=()=>{
      for(const w of node.widgets ?? []) {
        if(w.name.startsWith("__separator_") || ["score_timeline","anchor_range"].includes(w.name) || w === panel.open) w.width=node.size[0];
      }
    };
    const resize=node.onResize;
    node.onResize=function(...args){const value=resize?.apply(this,args);syncWidth();return value;};
    const configured=node.onConfigure;
    node.onConfigure=function(...args){const value=configured?.apply(this,args);syncWidth();return value;};
    syncWidth();
    const removed = node.onRemoved;
    node.onRemoved = function (...args) { abc?.element?.removeEventListener("input",changed); panel.destroy(); return removed?.apply(this,args); };
    const over = node.onDragOver, drop = node.onDragDrop;
    node.onDragOver = function (event) { return Array.from(event.dataTransfer?.types ?? []).includes("Files") || over?.call(this, event); };
    node.onDragDrop = async function (event) {
      const file = event.dataTransfer?.files?.[0];
      return (file && await panel.load(file)) || await drop?.call(this, event) || false;
    };
    const compute = node.computeSize;
    node.computeSize = function (...args) { const size = compute.apply(this,args); return [Math.max(520,size[0]),size[1]]; };
    node.setSize(node.computeSize());
  },
});
