// Song history: saved FLAC + ABC pairs, newest first. Rows show each score's
// sections in bars; FLAC progress is drawn separately, because score time and
// audio time can differ by seconds. Opening a song selects whole groups of
// bars to reuse, and restores the seed, lyrics and style from the prompt the
// FLAC embeds.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { SCORE_DEFAULTS, readValues, setValues, normalizeValues } from "./score_state.js";

import {fillStrip, barAxis, selectionOverlay, releaseStrip, sectionColor} from "./score_strip.js";

const NODE = "bno84.SongHistory";
const PAGE = 20;
const PREROLL = 2;
const SCORE = "bno84.YuE2AdvancedScore";
const SCORE_SAMPLING = { temperature: 0.7, top_p: 0.9, top_k: 30, repetition_penalty: 1.005, penalty_window: 100 };
const SAMPLERS = [SCORE, "YuE2GenerateMusic", "YuE2GenerateABC", "bno84.YuE2ExtendABC"];

export function clock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function ago(seconds, now = Date.now() / 1000) {
  const age = Math.max(0, now - seconds);
  if (age < 60) return "just now";
  if (age < 3600) return `${Math.floor(age / 60)} min ago`;
  if (age < 86400) return `${Math.floor(age / 3600)} h ago`;
  if (age < 172800) return "yesterday";
  return new Date(seconds * 1000).toLocaleDateString();
}

export function sectionColors() { return sectionColor; }

// A node's executed output that saved a FLAC to the output folder, as Final outputs does.
export function savesSong(output) {
  return (output?.audio ?? []).some((file) => file?.type === "output" && /\.flac$/i.test(file?.filename ?? ""));
}

const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

// Where a compiled input's value comes from: follow links to the node that
// holds it, as long as that node has an input of the same name or a "value".
const LYRICS_STYLE = "bno84.LyricsStyle";

// Lyrics + style keeps a Base and an Instrumental pair; its flag picks the output (see lyrics_style.js).
const lyricsVariant = (name, instrumental) => instrumental ? `instrumental_${name}` : name;

// The input behind a Lyrics + style output; older nodes without variants use the Base names.
export function lyricsStyleInput(node, name) {
  if (node?.class_type !== LYRICS_STYLE || !["lyrics", "style"].includes(name)) return name;
  const variant = lyricsVariant(name, node.inputs?.instrumental === true);
  return variant in (node.inputs ?? {}) ? variant : name;
}

export function resolveInput(prompt, id, name) {
  let node = prompt?.[id], value = node?.inputs?.[name];
  for (let depth = 0; node && isLink(value) && depth < 16; depth++) {
    const source = prompt[value[0]];
    const linked = lyricsStyleInput(source, name);
    const input = source && (linked in (source.inputs ?? {}) ? linked : "value" in (source.inputs ?? {}) ? "value" : null);
    if (!input) return null;
    [id, node, name, value] = [value[0], source, input, source.inputs[input]];
  }
  return node && scalar(value) && value !== undefined ? { id, input: name, value, title: node._meta?.title ?? "", classType: node.class_type } : null;
}

const RESTORED = ["seed", "lyrics", "style"];

// What a run used, and where, from a compiled prompt: the embedded one or the current graph's.
// Seed, lyrics and style list one source per sampler, so separate sources are all restored.
export function runSettings(prompt) {
  const nodes = Object.entries(prompt ?? {});
  const settings = { values: { seed: [], lyrics: [], style: [], instrumental: [] }, reference: null, sampling: [], planners: [] };
  const samplers = nodes.filter(([, node]) => SAMPLERS.includes(node.class_type))
    .sort(([, a], [, b]) => SAMPLERS.indexOf(a.class_type) - SAMPLERS.indexOf(b.class_type));
  const sources = samplers.length ? samplers : nodes.filter(([, node]) => !node.class_type?.startsWith("bno84.Score") && "seed" in (node.inputs ?? {})).slice(0, 1);
  for (const name of RESTORED) {
    for (const [id, node] of sources) {
      const found = resolveInput(prompt, id, name);
      if (found) settings.values[name].push({ sampler: node.class_type, samplerId: id, ...found });
    }
  }
  for (const [id, node] of nodes) {
    const inputs = node.inputs ?? {};
    if (node.class_type === LYRICS_STYLE && !settings.values.instrumental.length && typeof inputs.instrumental === "boolean") {
      settings.values.instrumental.push({ sampler: "", id, input: "instrumental", value: inputs.instrumental, title: node._meta?.title ?? "" });
    } else if (node.class_type === "bno84.ReferenceInput" && !settings.reference) {
      settings.reference = { id, source: inputs.source, extend: !!inputs.extend };
    } else if (node.class_type === SCORE) {
      const values = Object.fromEntries(Object.entries(SCORE_DEFAULTS).map(([name, fallback]) => [name, resolveInput(prompt,id,name)?.value ?? fallback]));
      // The plan comes from the Python planner: see resolvePlans.
      settings.planners.push({id, plan: null, planError: "", values, mode: values.mode});
      settings.sampling.push({id, class_type:SCORE, values:Object.fromEntries(Object.keys(SCORE_SAMPLING).map(name => [name, values[name]]))});
    } else if (SAMPLERS.includes(node.class_type)) {
      const values = Object.fromEntries(Object.entries(inputs).filter(([name, value]) => !RESTORED.includes(name) && scalar(value)));
      settings.sampling.push({ id, class_type: node.class_type, values });
    }
  }
  settings.sampling.sort((a, b) => SAMPLERS.indexOf(a.class_type) - SAMPLERS.indexOf(b.class_type));
  return settings;
}

// The plan each recorded Score node resolves to, from the Python planner,
// which owns these rules. Restore applies normalizeValues, so resolve those values.
export async function resolvePlans(settings, fetchApi = (...args) => api.fetchApi(...args)) {
  await Promise.all(settings.planners.map(async entry => {
    try {
      const response = await fetchApi("/yue2-kit/score/preview", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(normalizeValues(entry.values))});
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? `Score preview failed (${response.status}).`);
      entry.plan = data.plan ?? null;
      entry.planError = data.plan ? "" : (data.errors ?? []).join(" ") || "The planner rejected these settings.";
    } catch (error) {
      entry.plan = null;
      entry.planError = `Cannot read the saved plan: ${error.message ?? error}`;
    }
  }));
  return settings;
}

// The value shown for a setting: the first sampler's, music before planning.
export const shown = (settings, name) => settings.values[name][0] ?? null;

// The past value for one of the current graph's sources: same sampler, else the first.
export function pastValueFor(past, name, entry) {
  const sources = past.values[name];
  const exact = sources.find(source => source.sampler === entry.sampler && source.id === entry.id && source.input === entry.input);
  if (exact) return exact.value;
  return (sources.find((source) => source.sampler === entry.sampler) ?? sources[0])?.value;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// "same", "differs", or "" when either side lacks the setting.
export function compareSettings(past, current) {
  const compare = (name) => {
    if (!past.values[name].length || !current.values[name].length) return "";
    return current.values[name].every((entry) => same(pastValueFor(past, name, entry), entry.value)) ? "same" : "differs";
  };
  const sampling = past.sampling.map((entry) => {
    const now = current.sampling.find((other) => other.id === entry.id && other.class_type === entry.class_type)
      ?? current.sampling.find((other) => other.class_type === entry.class_type);
    if (!now) return "";
    return Object.entries(entry.values).every(([name, value]) => !(name in now.values) || same(value, now.values[name])) ? "same" : "differs";
  }).filter(Boolean);
  return {
    seed: compare("seed"), style: compare("style"), lyrics: compare("lyrics"), instrumental: compare("instrumental"),
    sampling: sampling.length ? (sampling.includes("differs") ? "differs" : "same") : "",
  };
}

export function samplingText(sampling) {
  const music = sampling.find((entry) => entry.class_type === "YuE2GenerateMusic")?.values;
  const plan = sampling.find((entry) => entry.class_type !== "YuE2GenerateMusic")?.values;
  return [
    plan && `Score temp ${plan.temperature}`,
    music && `Music temp ${music.temperature}`,
    music && music.cfg_scale !== undefined && `CFG ${music.cfg_scale}`,
  ].filter(Boolean).join(" · ");
}

export function planningText(settings) {
  if (settings.planners.length) return settings.planners.map(entry => {
    if (!entry.plan) return "-";
    const plan = entry.plan;
    if (plan.source.kind === "none") return "Generated";
    return [plan.opening.bars > 0 && "Opening", "reference", plan.continuation.enabled && "continuation"]
      .filter(Boolean).join(" + ").replace(/^reference/, "Reference");
  }).join(" / ");
  const reference = settings.reference;
  if (!reference) return "-";
  if (reference.source === "None") return "Generated";
  if (!["ABC", "Transcribe"].includes(reference.source)) return "-";
  return reference.source + (reference.extend ? " + continuation" : "");
}

// Selections are half-open ranges of group indexes [start, end).
export function sectionRange(groups, index) {
  let start = index, end = index + 1;
  while (start > 0 && !groups[start].starts_section) start--;
  while (end < groups.length && !groups[end].starts_section) end++;
  return [start, end];
}

export function extendRange([start, end], [otherStart, otherEnd]) {
  return [Math.min(start, otherStart), Math.max(end, otherEnd)];
}

// The group boundary closest to a bar position, as a group index 0..groups.length.
export function nearestBoundary(groups, bar) {
  let best = 0, distance = Infinity;
  groups.forEach((group, index) => {
    if (Math.abs(group.bar - bar) < distance) { best = index; distance = Math.abs(group.bar - bar); }
  });
  const total = groups.length ? groups.at(-1).bar + groups.at(-1).bars : 0;
  return Math.abs(total - bar) < distance ? groups.length : best;
}

// The group a bar position falls in, clamped to the score.
export function groupAt(groups, bar) {
  let found = 0;
  groups.forEach((group, index) => { if (group.bar <= bar) found = index; });
  return found;
}

// Dragging across the strip selects every group between press and release.
export function dragRange(groups, fromBar, toBar) {
  const [a, b] = [groupAt(groups, fromBar), groupAt(groups, toBar)].sort((x, y) => x - y);
  return [a, b + 1];
}

export function rangeInfo(groups, [start, end]) {
  const first = groups[start], last = groups[end - 1];
  const labels = [];
  for (const group of groups.slice(start, end)) if (group.label && labels.at(-1) !== group.label) labels.push(group.label);
  return {
    firstBar: first.bar + 1, lastBar: last.bar + last.bars, bars: last.bar + last.bars - first.bar, labels,
    seconds: groups.slice(0, start).reduce((total, group) => total + group.seconds, 0),
    duration: groups.slice(start, end).reduce((total, group) => total + group.seconds, 0),
  };
}

// Graph nodes by compiled execution ID ("31:6" is node 6 inside subgraph node 31).
export function findNode(root, id) {
  let graph = root, node = null;
  for (const part of String(id).split(":")) {
    node = (graph?._nodes ?? []).find((candidate) => String(candidate.id) === part);
    if (!node) return null;
    graph = node.subgraph;
  }
  return node;
}

export function nodesOfClass(root, type) {
  const found = [];
  (function visit(graph, seen) {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
      if (node.comfyClass === type || node.type === type) found.push(node);
      if (node.subgraph) visit(node.subgraph, seen);
    }
  })(root, new Set());
  return found;
}

// Paths are option values: local IDs alone collide across subgraphs.
export function referenceTargets(root) {
  const found = [];
  function visit(graph, path, ancestors) {
    if (!graph || ancestors.has(graph)) return;
    const seen = new Set(ancestors).add(graph);
    for (const node of graph._nodes ?? []) {
      const id = [...path, String(node.id)].join(":");
      if ([SCORE, "bno84.ReferenceInput"].includes(node.comfyClass ?? node.type)) found.push({ id, node });
      if (node.subgraph) visit(node.subgraph, [...path, String(node.id)], seen);
    }
  }
  visit(root, [], new Set());
  return found;
}


function showPlan(node) {
  const panel = node.yue2ScorePanel;
  panel?.refresh();
}

export function flashPlanner(node) {
  const root = node.yue2ScorePanel?.root;
  root?.animate?.([{ outline: "3px solid #ffd890" }, { outline: "3px solid transparent" }], { duration: 1400 });
  node.graph?.setDirtyCanvas?.(true, true);
}

export function useInPlanner(node, abc, saved = false) {
  const values = {anchor_use:true,anchor_abc:abc,anchor_start:1,anchor_end:0,
    ...(saved ? {opening_generate:false,continue_generate:false} : {})};
  node.graph?.beforeChange?.();
  setValues(node, values);
  node.graph?.afterChange?.();
  showPlan(node); flashPlanner(node);
}

function setReference(node, values) {
  node.graph?.beforeChange?.();
  try {
    for (const [name, value] of Object.entries(values)) setWidget(node, name, value);
    node.yue2ReferencePanel?.render();
  } finally {
    node.graph?.afterChange?.();
    node.graph?.setDirtyCanvas?.(true, true);
  }
}

export function useReference(node, abc, saved = false) {
  if (isScore(node)) return useInPlanner(node, abc, saved);
  setReference(node, {source: "ABC", abc, ...(saved ? {extend: false} : {})});
}

// What a saved Score plan uses that Reference input cannot hold; empty when it fits.
export function referenceGaps(plan) {
  const {anchor} = plan;
  return [plan.opening.bars > 0 && "an opening",
    plan.source.kind !== "none" && (anchor.start > 0 || anchor.end) && `bars ${anchor.start + 1}–${anchor.end ?? "end"} of the reference`,
    plan.header.tempo.policy === "locked" && "locked properties"].filter(Boolean);
}

export function restoreReference(node, plan) {
  setReference(node, plan.source.kind === "none" ? {source: "None"}
    : {source: "ABC", abc: plan.source.abc, extend: plan.continuation.enabled});
}

const isScore = node => (node.comfyClass ?? node.type) === SCORE;
const RESTORE_HINT = "Restore to a YuE2 Advanced Score, or use saved score to load only the final ABC.";
const referenceLabel = node => node.title || (isScore(node) ? "YuE2 Advanced Score" : "Reference input");

const rootGraph = () => app.rootGraph ?? app.graph;

function setWidget(node, name, value) {
  const widget = node?.widgets?.find((candidate) => candidate.name === name);
  if (!widget) return false;
  widget.value = value;
  widget.callback?.(value);
  return true;
}

const SUBGRAPH_INPUT = -10;

function linkOf(graph, id) {
  return graph?.getLink?.(id) ?? graph?.links?.[id] ?? graph?._links?.get?.(id) ?? null;
}

// Nodes whose "value" widget is what they output.
const PRIMITIVES = new Set(["PrimitiveNode", "PrimitiveInt", "PrimitiveFloat", "PrimitiveString",
  "PrimitiveStringMultiline", "PrimitiveBoolean"]);

// Set what a compiled input will be: {node, name} of the widget written.
// An input fed from its subgraph's own input takes the value of the subgraph
// node's widget, one level up; one fed by a primitive (through reroutes)
// takes the primitive's value. Any other upstream node computes the input,
// so nothing is written and {linked} names that node.
export function setInput(root, id, name, value) {
  const path = String(id).split(":");
  let node = findNode(root, path.join(":"));
  while (node) {
    const input = node.inputs?.find((candidate) => candidate.name === name);
    const link = input?.link != null ? linkOf(node.graph, input.link) : null;
    if (!link) return setWidget(node, name, value) ? { node, name } : null;
    if (Number(link.origin_id) === SUBGRAPH_INPUT && path.length > 1) {
      const slot = node.graph.inputs?.[link.origin_slot];
      path.pop();
      node = findNode(root, path.join(":"));
      name = slot?.name;
      continue;
    }
    const origin = node.graph?.getNodeById?.(link.origin_id)
      ?? node.graph?._nodes?.find((candidate) => String(candidate.id) === String(link.origin_id));
    const type = origin?.comfyClass ?? origin?.type;
    if (!origin || !(PRIMITIVES.has(type) || type === "Reroute")) return { linked: origin ?? null };
    path[path.length - 1] = String(origin.id);
    node = origin;
    name = type === "Reroute" ? origin.inputs?.[0]?.name : "value";
  }
  return null;
}

// The control_after_generate combo belongs to its value widget.
function fixControl(node, name) {
  const value = node.widgets?.find((widget) => widget.name === name);
  const control = value?.linkedWidgets?.find((widget) => widget.options?.values?.includes?.("fixed"))
    ?? node.widgets?.find((widget) => widget.name === "control_after_generate");
  if (!control) return;
  control.value = "fixed";
  control.callback?.("fixed");
}

function changeGraph(change) {
  const graph = rootGraph();
  graph?.beforeChange?.();
  try { return change(); } finally {
    graph?.afterChange?.();
    graph?.setDirtyCanvas?.(true, true);
  }
}

async function currentSettings() {
  const { output } = await app.graphToPrompt(rootGraph());
  return runSettings(output);
}

function styles() {
  if (document.getElementById("yue2-history-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-history-style";
  style.textContent = `
.yue2-history {container:yue2-history / inline-size;contain:size;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;min-height:0;color:var(--input-text,#ddd);font:12px/1.45 sans-serif;padding:4px;}
.yue2-history [hidden] {display:none!important;}
.yue2-history button,.yue2-history input,.yue2-history select {font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:4px 8px;}
.yue2-history button {cursor:pointer;white-space:nowrap;}
.yue2-history button:disabled {opacity:.45;cursor:default;}
.yue2-history button.primary {background:var(--p-button-primary-background,#405c83);border-color:transparent;color:var(--p-button-primary-color,#fff);}
.yue2-history .h-bar {flex:none;display:flex;gap:6px;}
.yue2-history .h-bar input {flex:1;min-width:0;}
.yue2-history .h-list {position:relative;flex:1;min-height:0;overflow:auto;}
.yue2-history .h-row {display:grid;grid-template-columns:22px 96px minmax(0,1fr) 38px;gap:8px;align-items:center;padding:4px;border-bottom:1px solid var(--border-color,#444);cursor:pointer;}
.yue2-history .h-row:hover {background:#ffffff0a;}
.yue2-history .h-row.open {background:#3d4a5c;border-radius:4px 4px 0 0;border-bottom-color:transparent;}
.yue2-history button.h-icon {display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;line-height:1;flex:none;}
.yue2-history .h-icon svg {display:block;width:12px;height:12px;flex:none;}
.yue2-history .h-play {width:22px;height:22px;border-radius:50%;}
.yue2-history .h-refresh {width:28px;align-self:stretch;}
.yue2-history .h-refresh svg {width:14px;height:14px;}
.yue2-history .h-play.on {background:var(--p-button-primary-background,#405c83);border-color:transparent;}
.yue2-history .h-name {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.yue2-history .h-name b {font-weight:600;}
.yue2-history .muted {opacity:.65;}
.yue2-history .h-track {display:flex;flex-direction:column;gap:3px;min-width:0;}
.yue2-history .h-mini {position:relative;height:12px;border-radius:2px;overflow:hidden;background:#252525;}
.yue2-history .h-mini i {position:absolute;top:0;bottom:0;border-left:1px solid #0006;}
.yue2-history .h-progress {position:relative;height:3px;border-radius:2px;background:#252525;}
.yue2-history .h-progress b {position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:#76a5eb;}
.yue2-history .h-zoom {background:#2c3644;border-radius:0 0 4px 4px;padding:8px 8px 10px;margin-bottom:6px;cursor:default;}
.yue2-history .h-strip {position:relative;height:38px;border-radius:4px;overflow:hidden;background:#252525;user-select:none;touch-action:none;}
.yue2-history .h-score {position:relative;height:38px;}
.yue2-history .h-block {position:absolute;top:0;bottom:0;box-sizing:border-box;border-left:1px solid #0006;padding:0 4px;color:#fff;line-height:34px;white-space:nowrap;overflow:hidden;cursor:pointer;}
.yue2-history .h-cut {position:absolute;top:0;bottom:0;right:0;box-sizing:border-box;border-left:2px solid #ffcf7a;background:repeating-linear-gradient(135deg,#000b 0 4px,#0007 4px 8px);pointer-events:none;}
.yue2-history .h-extra {border-left-color:#edece5;background:#edece538 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='12' viewBox='0 0 48 12'%3E%3Cpath d='M0 6h3l2-2 2 4 3-6 3 8 3-7 2 5 2-2h5l2-2 2 4 3-6 3 8 3-7 2 5 2-2h6' fill='none' stroke='%23edece5' stroke-opacity='.45' stroke-width='1'/%3E%3C/svg%3E") repeat-x center;}
.yue2-history .h-mini .h-cut {border-left-width:1px;}
.yue2-history .h-strip .h-cut span {position:absolute;left:4px;top:0;color:#ffcf7a;font-size:11px;line-height:34px;white-space:nowrap;}
.yue2-history .h-strip .h-extra span {color:#f1f0ea;top:8px;line-height:14px;padding:2px 4px;border-radius:2px;background:#414449cc;}
.yue2-history .cut {color:#ffcf7a;opacity:1;}
.yue2-history .h-grid {position:absolute;top:0;bottom:0;width:1px;background:#0004;pointer-events:none;}
.yue2-history .h-sel {position:absolute;top:0;bottom:0;box-sizing:border-box;border:2px solid #fff;border-radius:3px;box-shadow:0 0 0 999px #0008;pointer-events:none;}
.yue2-history .h-handle {position:absolute;top:50%;width:8px;height:20px;margin-top:-10px;background:#fff;border-radius:2px;pointer-events:auto;cursor:ew-resize;}
.yue2-history .h-bars {position:relative;height:14px;font-size:10px;opacity:.55;margin-bottom:6px;}
.yue2-history .h-bars span {position:absolute;transform:translateX(-50%);}
.yue2-history .h-bars span:first-child {transform:none;}
.yue2-history .h-selbar {display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:#222a35;border-radius:4px;padding:6px 8px;margin-bottom:8px;}
.yue2-history .h-selbar .info {flex-basis:100%;}
.yue2-history .h-selbar .primary {margin-left:auto;}
.yue2-history .h-warn {color:#ffcf7a;flex-basis:100%;}
.yue2-history .h-cols {display:grid;grid-template-columns:minmax(0,1fr);gap:8px;}
@container yue2-history (min-width:668px) {
  .yue2-history .h-cols {grid-template-columns:minmax(0,2fr) minmax(0,1fr);}
}
.yue2-history .h-box {background:#262f3b;border-radius:4px;padding:8px;min-width:0;}
.yue2-history .h-box h4 {margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.6;font-weight:600;}
.yue2-history .h-kv {display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:4px 8px;align-items:center;}
.yue2-history .h-kv .v {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.yue2-history .mono {font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;}
.yue2-history .h-diff {font-size:10px;border-radius:3px;padding:0 5px;white-space:nowrap;}
.yue2-history .h-diff.same {background:#1d9e7533;color:#9fd8a8;}
.yue2-history .h-diff.differs {background:#e0b05033;color:#ffd890;}
.yue2-history .h-actions {display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center;}
.yue2-history .h-actions .spacer {margin-left:auto;}
.yue2-history .h-status {margin-top:6px;overflow-wrap:anywhere;}
.yue2-history .h-status:empty {display:none;}
.yue2-history .h-status[data-error=true] {color:#ff9d9d;}
.yue2-history .h-more {flex:none;align-self:center;}
.yue2-history .h-note {padding:8px;opacity:.7;}
`;
  document.head.append(style);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, className = "") {
  const node = element("button", className, text);
  node.type = "button";
  node.onclick = (event) => { event.stopPropagation(); onClick(event); };
  return node;
}

// SVG geometry avoids font-dependent baselines and uneven symbol spacing.
function setIcon(button, kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", {
    play: "M8 5 19 12 8 19Z",
    pause: "M6 5H10V19H6Z M14 5H18V19H14Z",
    refresh: "M20 7V3 M20 7H16 M20 7A9 9 0 1 0 21 14",
  }[kind]);
  path.setAttribute("fill", kind === "refresh" ? "none" : "currentColor");
  if (kind === "refresh") {
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.append(path);
  button.replaceChildren(svg);
}

// Hatching over the bars after the audio stops, when the render was cut short.
function cutOverlay(audioEnd, total, label = "") {
  const overlay = element("div", "h-cut");
  overlay.style.left = `${(100 * audioEnd) / total}%`;
  overlay.title = `Not in the FLAC: the render stopped at about bar ${Math.floor(audioEnd) + 1} of ${total}.`;
  if (label) overlay.append(element("span", "", label));
  return overlay;
}

export function cutText(score, seconds) {
  if (score.audio_extra_seconds != null) {
    return `The score runs ≈${clock(score.seconds)}, but the FLAC runs ${clock(seconds)} (≈${clock(score.audio_extra_seconds)} longer). The ABC does not cover the full audio.`;
  }
  if (score.audio_end_bar == null) return "";
  return `The score runs ≈${clock(score.seconds)}, but the render stopped at ${clock(seconds)}, about bar ${Math.floor(score.audio_end_bar) + 1} of ${score.bars}.`;
}

// Preserve bar spacing within the score, leaving a proportional gap for extra audio.
export function scoreShare(score) {
  return score.audio_extra_seconds != null
    ? score.seconds / (score.seconds + score.audio_extra_seconds) : 1;
}

// The repeating waveform is a decorative audio motif, not sampled FLAC data.
function scoreGap(score, label = "") {
  const overlay = element("div", "h-cut h-extra");
  overlay.style.left = `${100 * scoreShare(score)}%`;
  overlay.title = `Not in the ABC: the score ends at ≈${clock(score.seconds)}; the FLAC continues for ≈${clock(score.audio_extra_seconds)}.`;
  if (label) overlay.append(element("span", "", label));
  return overlay;
}

function miniStrip(score, color) {
  const strip = element("div", "h-mini");
  strip.style.height="16px";
  const lane=element("div", "h-mini-score");
  lane.style.width=`${100*scoreShare(score)}%`;
  fillStrip(lane,score.sections,score.bars,{color,compact:true});
  strip.append(lane);
  if (score.audio_end_bar != null) lane.append(cutOverlay(score.audio_end_bar, score.bars));
  if (score.audio_extra_seconds != null) strip.append(scoreGap(score));
  return strip;
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
}

export function scoreViews(graph) {
  return [
    ...nodesOfClass(graph, "bno84.ABCPreview").filter(node => node.abcPreview),
    ...nodesOfClass(graph, "bno84.ABCTimeline").filter(node => node.setAbcTimeline),
  ];
}

export async function showScore(views, abc) {
  const results = await Promise.allSettled(views.map(async node => {
    if (node.abcPreview) node.abcPreview.setAbc(abc);
    if (node.setAbcTimeline) await node.setAbcTimeline(abc);
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}

class SongHistoryPanel {
  constructor(node) {
    this.node = node;
    this.songs = [];
    this.total = 0;
    this.details = new Map();
    this.request = 0;
    this.sliceRequest = 0;
    this.color = sectionColors();
    styles();
    this.root = element("div", "yue2-history");
    // Nodes 2.0 forwards wheel events before our bubbling listener runs.
    // Its wheel-capture marker is honored while this panel or a child has focus.
    this.root.dataset.captureWheel = "true";
    this.root.tabIndex = 0;

    const bar = element("div", "h-bar");
    this.filter = element("input");
    this.filter.type = "search";
    this.filter.placeholder = "Filter by name, style or lyrics…";
    this.filter.setAttribute("aria-label", "Filter songs");
    this.filter.oninput = () => { clearTimeout(this.filterTimer); this.filterTimer = setTimeout(() => this.load(), 250); };
    const refresh = button("", () => this.load("refresh"), "h-icon h-refresh");
    setIcon(refresh, "refresh");
    refresh.setAttribute("aria-label", "Refresh the list");
    refresh.title = "Refresh the list";
    bar.append(this.filter, refresh);
    this.list = element("div", "h-list");
    this.more = button(`Show ${PAGE} more`, () => this.load("more"), "h-more");
    this.root.append(bar, this.list, this.more);
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.ontimeupdate = () => this.updateProgress();
    this.audio.onpause = this.audio.onended = () => this.renderPlayState();
    this.audio.onplay = () => this.renderPlayState();
    for (const event of ["pointerdown", "mousedown", "keydown", "wheel"]) this.root.addEventListener(event, (e) => e.stopPropagation());
    this.widget = node.addDOMWidget("song_history", "song_history", this.root, {
      serialize: false, hideInPanel: true, hideOnZoom: false, getMinHeight: () => 300,
    });
    this.widget.serialize = false;
    if (node.size[0] < 620 || node.size[1] < 560) node.setSize([Math.max(node.size[0], 620), Math.max(node.size[1], 560)]);
    // A finished run that saved a song refreshes the list, keeping what is shown.
    this.onExecuted = ({ detail }) => {
      if (!savesSong(detail?.output)) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.load("refresh"), 300);
    };
    api.addEventListener("executed", this.onExecuted);
    this.load();
  }

  // "first" page, "more" songs after those shown, or "refresh" as many as are shown.
  async load(mode = "first") {
    const append = mode === "more";
    const offset = append ? this.songs.length : 0;
    const limit = mode === "refresh" ? Math.min(100, Math.max(PAGE, this.songs.length)) : PAGE;
    const query = new URLSearchParams({ q: this.filter.value, offset, limit });
    const request = ++this.request;
    try {
      const response = await api.fetchApi(`/yue2-kit/history?${query}`);
      if (!response.ok) throw new Error(`Cannot list songs (${response.status}).`);
      const found = await response.json();
      if (request !== this.request || this.destroyed) return;
      this.songs = append ? [...this.songs, ...found.songs] : found.songs;
      this.total = found.total;
      this.error = "";
    } catch (error) {
      this.error = error.message ?? String(error);
    }
    this.render();
  }

  render() {
    this.rows = new Map();
    const items = [];
    if (this.error) items.push(element("div", "h-note", this.error));
    else if (!this.songs.length) items.push(element("div", "h-note", this.filter.value ? "No songs match." : "No saved FLAC + ABC songs yet."));
    for (const song of this.songs) {
      const row = element("div", "h-row");
      const play = button("", () => this.togglePlay(song), "h-icon h-play");
      setIcon(play, "play");
      play.setAttribute("aria-label", `Play ${song.name}`);
      const name = element("div", "h-name");
      name.title = song.path;
      name.append(element("b", "", song.name), element("br"), element("span", "muted", ago(song.mtime)));
      const track = element("div", "h-track");
      const progress = element("div", "h-progress");
      progress.append(element("b"));
      track.append(miniStrip(song.score, this.color));
      track.append(progress);
      const warning = cutText(song.score, song.seconds);
      const length = element("span", warning ? "cut" : "muted", song.seconds ? clock(song.seconds) : "–");
      length.title = warning || "Length of the FLAC";
      row.append(play, name, track, length);
      row.onclick = () => this.toggleOpen(song);
      items.push(row);
      const zoom = element("div", "h-zoom");
      zoom.onclick = (event) => event.stopPropagation();
      items.push(zoom);
      this.rows.set(song.path, { row, play, progress, zoom });
    }
    const scroll = this.list.scrollTop;
    releaseStrip(this.list);
    this.list.replaceChildren(...items);
    this.more.hidden = this.songs.length >= this.total;
    this.more.textContent = `Show ${Math.min(PAGE, this.total - this.songs.length)} more`;
    this.renderPlayState();
    this.renderOpen();
    this.list.scrollTop = scroll;
  }

  songUrl(path) {
    const parts = path.split("/");
    const filename = parts.pop();
    return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: parts.join("/"), type: "output" })}`);
  }

  play(song, from = null) {
    if (this.playing !== song.path) {
      this.audio.src = this.songUrl(song.path);
      this.playing = song.path;
    }
    if (from !== null) this.audio.currentTime = from;
    this.audio.play().catch((error) => this.message(`Cannot play ${song.name}: ${error.message ?? error}`, true));
  }

  togglePlay(song) {
    if (this.playing === song.path && !this.audio.paused) this.audio.pause();
    else this.play(song);
  }

  renderPlayState() {
    for (const [path, parts] of this.rows ?? []) {
      const on = path === this.playing && !this.audio.paused;
      parts.play.classList.toggle("on", on);
      setIcon(parts.play, on ? "pause" : "play");
      parts.play.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${this.songs.find(song => song.path === path)?.name ?? "song"}`);
      parts.progress.hidden = path !== this.playing;
    }
    this.updateProgress();
  }

  updateProgress() {
    const parts = this.rows?.get(this.playing);
    if (!parts) return;
    const share = this.audio.duration ? this.audio.currentTime / this.audio.duration : 0;
    parts.progress.firstChild.style.width = `${100 * share}%`;
  }

  async toggleOpen(song) {
    this.open = this.open === song.path ? null : song.path;
    this.status = null;
    if (this.open && !this.details.has(song.path)) {
      try {
        const response = await api.fetchApi(`/yue2-kit/history/song?${new URLSearchParams({ path: song.path })}`);
        const detail = await response.json();
        if (!response.ok) throw new Error(detail.error ?? `Cannot open ${song.name} (${response.status}).`);
        detail.settings = await resolvePlans(runSettings(detail.prompt));
        this.details.set(song.path, detail);
      } catch (error) {
        this.details.delete(song.path);
        this.status = { text: error.message ?? String(error), error: true };
      }
    }
    if (this.open) {
      const detail = this.details.get(this.open);
      const groups = detail?.score.groups ?? [];
      this.selection = groups.length ? [0, groups.length] : null;
      this.slice = null;
      this.compare();
      this.updateSlice();
    }
    this.renderOpen();
    const row = this.rows?.get(this.open)?.row;
    if (row) this.list.scrollTop = row.offsetTop;
  }

  async compare() {
    const detail = this.details.get(this.open);
    if (!detail) return;
    try {
      this.current = await currentSettings();
      this.diff = compareSettings(detail.settings, this.current);
    } catch (error) {
      this.current = null;
      this.diff = null;
    }
    this.renderOpen();
  }

  async updateSlice() {
    const detail = this.details.get(this.open);
    if (!detail || !this.selection) return;
    const [start, end] = this.selection;
    const request = ++this.sliceRequest;
    try {
      const response = await api.fetchApi("/yue2-kit/history/slice", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: detail.path, start, end }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Cannot slice the score (${response.status}).`);
      if (request === this.sliceRequest) this.slice = { range: [start, end], ...result };
    } catch (error) {
      if (request === this.sliceRequest) this.slice = { range: [start, end], error: error.message ?? String(error) };
    }
    if (request === this.sliceRequest) this.renderSelection();
  }

  select(range) {
    if (!range || range[0] >= range[1]) return;
    this.selection = range;
    this.slice = null;
    this.renderSelection();
    clearTimeout(this.sliceTimer);
    this.sliceTimer = setTimeout(() => this.updateSlice(), 120);
  }

  message(text, error = false) {
    this.status = error ? { text, error } : null;
    if (this.statusElement) {
      this.statusElement.textContent = error ? text : "";
      this.statusElement.dataset.error = String(error);
    }
  }

  renderOpen() {
    for (const [path, parts] of this.rows ?? []) {
      const open = path === this.open;
      parts.row.classList.toggle("open", open);
      parts.zoom.hidden = !open;
      if (!open) { releaseStrip(parts.zoom); parts.zoom.replaceChildren(); }
    }
    const parts = this.rows?.get(this.open);
    if (!parts) return;
    const detail = this.details.get(this.open);
    if (!detail) {
      parts.zoom.replaceChildren(element("div", "h-note", this.status?.text ?? "Loading…"));
      return;
    }
    const groups = detail.score.groups;
    const total = detail.score.bars || 1;
    const timeline = element("div", "h-strip");
    const strip = element("div", "h-score");
    strip.style.width = `${100 * scoreShare(detail.score)}%`;
    timeline.append(strip);
    const sections = [];
    groups.forEach((group, index) => {
      if (group.starts_section || !sections.length) sections.push({ label: group.label, start: index, bar: group.bar, bars: 0, seconds:0 });
      sections.at(-1).bars += group.bars; sections.at(-1).seconds += group.seconds;
    });
    fillStrip(strip,sections,total,{color:this.color});
    for (const group of groups.slice(1)) {
      const line = element("div", "h-grid");
      line.style.left = `${(100 * group.bar) / total}%`;
      strip.append(line);
    }
    if (detail.score.audio_end_bar != null) strip.append(cutOverlay(detail.score.audio_end_bar, total, "not in FLAC"));
    releaseStrip(parts.zoom);
    const {outline,handles}=selectionOverlay(strip);
    this.selectionElement=outline;
    handles.forEach((handle, side) => {
      handle.title = "Drag to change the selection";
      handle.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        handle.onpointermove = (move) => {
          const box = strip.getBoundingClientRect();
          const bar = ((move.clientX - box.left) / box.width) * total;
          const boundary = nearestBoundary(groups, bar);
          const range = [...this.selection];
          range[side] = side ? Math.max(boundary, range[0] + 1) : Math.min(boundary, range[1] - 1);
          if (range[0] !== this.selection[0] || range[1] !== this.selection[1]) this.select(range);
        };
        handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
      };
    });
    // Press and drag to select groups; a click without dragging picks a section.
    const barAt = (event) => {
      const box = strip.getBoundingClientRect();
      return Math.min(Math.max(((event.clientX - box.left) / box.width) * total, 0), total - 0.001);
    };
    strip.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      strip.setPointerCapture(event.pointerId);
      const startX = event.clientX, from = barAt(event);
      let dragging = false;
      strip.onpointermove = (move) => {
        if (!dragging && Math.abs(move.clientX - startX) < 4) return;
        dragging = true;
        const range = dragRange(groups, from, barAt(move));
        if (range[0] !== this.selection?.[0] || range[1] !== this.selection?.[1]) this.select(range);
      };
      strip.onpointerup = (up) => {
        strip.onpointermove = strip.onpointerup = strip.onpointercancel = null;
        if (dragging) return;
        const range = sectionRange(groups, groupAt(groups, from));
        this.select(up.shiftKey && this.selection ? extendRange(this.selection, range) : range);
      };
      strip.onpointercancel = () => { strip.onpointermove = strip.onpointerup = strip.onpointercancel = null; };
    };

    if (detail.score.audio_extra_seconds != null) timeline.append(scoreGap(detail.score, "not in ABC"));
    const axis = barAxis(total);
    axis.style.width = `${100 * scoreShare(detail.score)}%`;

    this.selectionBar = element("div", "h-selbar");
    const settings = this.renderSettings(detail);
    this.statusElement = element("div", "h-status");
    if (this.status) {
      this.statusElement.textContent = this.status.text;
      this.statusElement.dataset.error = String(this.status.error);
    }
    parts.zoom.replaceChildren(timeline, axis, this.selectionBar, settings, this.statusElement);
    this.renderSelection();
  }

  // The destination is chosen per action: a lone target is used directly,
  // several open a menu. `reason(node)` names why a target cannot take it.
  pickTarget(event, act, reason = () => "", hint = "") {
    const targets = referenceTargets(rootGraph()).map(entry => ({...entry, reason: reason(entry.node)}));
    const name = entry => `${referenceLabel(entry.node)} · ${entry.id}`;
    if (!targets.length) return this.message("Add a YuE2 Advanced Score or Reference input node to the workflow.", true);
    if (targets.length === 1) {
      const [only] = targets;
      return only.reason ? this.message(`${name(only)} ${only.reason}.${hint ? ` ${hint}` : ""}`, true) : act(only);
    }
    new globalThis.LiteGraph.ContextMenu(targets.map(entry => ({
      content: entry.reason ? `${name(entry)} — ${entry.reason}` : name(entry),
      disabled: !!entry.reason, callback: () => { act(entry); },
    })), {event, title: "Send to"});
  }

  useAsReference(event, abc, saved = false) {
    return this.pickTarget(event, target => {
      try {
        useReference(target.node, abc, saved);
        this.message(`Reference sent to ${referenceLabel(target.node)} · ${target.id}.`);
        this.compare();
      } catch (error) { this.message(error.message, true); }
    });
  }

  // The recorded Score node whose settings Restore all applies.
  recorded(detail) {
    const planners = detail.settings.planners;
    return planners.find(entry => entry.id === this.recordedId) ?? (planners.length === 1 ? planners[0] : null);
  }

  // Score holds any saved plan; Reference input only a whole-reference plan without an opening or locked properties.
  planBlock(node, recorded) {
    if (isScore(node) || !recorded) return "";
    if (!recorded.plan) return `can't hold a plan the planner cannot read (${recorded.planError})`;
    const gaps = referenceGaps(recorded.plan);
    return gaps.length ? `can't hold ${gaps.join(", ")}` : "";
  }

  restoreAll(event) {
    const detail = this.details.get(this.open);
    if (!detail) return;
    const planners = detail.settings.planners, recorded = this.recorded(detail);
    if (planners.length && !recorded) {
      return this.message("Choose a recorded Score node; multiple saved scores cannot be mapped automatically.", true);
    }
    return this.pickTarget(event, target => this.restore({ seed: true, lyricsStyle: true, plan: true, sampling: true }, target),
      node => this.planBlock(node, recorded), RESTORE_HINT);
  }

  renderSelection() {
    const detail = this.details.get(this.open);
    if (!detail || !this.selectionBar || !this.selection) return;
    const groups = detail.score.groups;
    const total = detail.score.bars || 1;
    const info = rangeInfo(groups, this.selection);
    Object.assign(this.selectionElement.style, {
      left: `${(100 * (info.firstBar - 1)) / total}%`, width: `${(100 * info.bars) / total}%`,
    });
    const whole = this.selection[0] === 0 && this.selection[1] === groups.length;
    const text = element("span", "info");
    text.append(element("b", "", `Bars ${info.firstBar}–${info.lastBar}`),
      ` · ${info.labels.join(", ") || "no sections"} · ${info.bars} bars · ≈${clock(info.duration)}`);
    text.title = "The duration follows the score's tempo and meter. The rendered audio can differ by seconds.";
    const ready = this.slice && !this.slice.error && this.slice.range[0] === this.selection[0] && this.slice.range[1] === this.selection[1];
    const views = scoreViews(rootGraph());
    const preview = button("Show in ABC Preview", async () => {
      try {
        await showScore(views, this.slice.abc);
        this.message("");
      } catch (error) { this.message(error.message ?? String(error), true); }
    });
    preview.disabled = !ready || !views.length;
    preview.title = views.length ? "Show this selection in ABC Preview and ABC Timeline"
      : "Add an ABC Preview or ABC Timeline node to the workflow";
    const song = this.songs.find((entry) => entry.path === detail.path);
    const from = Math.max(0, info.seconds - PREROLL);
    const audioEnd = detail.score.audio_end_bar;
    const afterAudio = audioEnd != null && info.firstBar - 1 >= audioEnd;
    const flac = button(afterAudio ? "Not in the FLAC" : `▶ FLAC from ≈${clock(from)}`, () => this.play(song, from));
    flac.disabled = afterAudio;
    flac.title = afterAudio ? cutText(detail.score, detail.seconds)
      : "Score time and audio time can differ, so playback starts a little early.";
    const copy = button("Copy ABC", async () => {
      try {
        await navigator.clipboard.writeText(this.slice.abc);
        this.message("Copied the selected score.");
      } catch (error) {
        this.message(`Cannot copy: ${error.message ?? error}`, true);
      }
    });
    copy.disabled = !ready;
    const targets = referenceTargets(rootGraph());
    const items = whole ? [preview, flac, copy] : [text, preview, flac, copy];
    const use = button(targets.length > 1 ? "Use as reference…" : "Use as reference", (event) => this.useAsReference(event, this.slice.abc), "primary");
    use.disabled = !ready || !targets.length;
    use.title = targets.length ? "Load the selected ABC as the reference; keep generation settings."
      : "Add a YuE2 Advanced Score or Reference input node to the workflow.";
    items.push(use);
    if (this.slice?.error) items.push(element("div", "h-warn", `⚠ ${this.slice.error}`));
    for (const warning of ready ? this.slice.warnings : []) items.push(element("div", "h-warn", `⚠ ${warning}`));
    this.selectionBar.replaceChildren(...items);
  }

  renderSettings(detail) {
    const settings = detail.settings;
    const diff = this.diff ?? {};
    const container = element("div");
    const columns = element("div", "h-cols");
    const runBox = element("div", "h-box");
    runBox.append(element("h4", "", this.current ? "Run settings · vs current graph" : "Run settings"));
    const kv = element("div", "h-kv");
    const row = (label, value, state = "", mono = false) => {
      const shown = element("span", `v${mono ? " mono" : ""}`, value);
      shown.title = value;
      const badge = element("span", state ? `h-diff ${state}` : "", state);
      kv.append(element("span", "muted", label), shown, badge);
    };
    if (!detail.prompt) {
      kv.append(element("span", "muted", "–"), element("span", "v", "This FLAC has no embedded prompt."), element("span"));
    } else {
      const seeds = [...new Set(settings.values.seed.map((entry) => entry.value))];
      row("Seed", seeds.length ? seeds.join(" / ") : "–", diff.seed, true);
      row("Style", shown(settings, "style")?.value || "–", diff.style);
      row("Lyrics", firstLine(shown(settings, "lyrics")?.value) || "–", diff.lyrics);
      const instrumental = shown(settings, "instrumental");
      row("Instr.", instrumental ? (instrumental.value ? "on" : "off") : "–", diff.instrumental);
      row("Sampling", samplingText(settings.sampling) || "–", diff.sampling);
    }
    runBox.append(kv);
    const scoreBox = element("div", "h-box");
    scoreBox.append(element("h4", "", "Score"));
    const scoreKv = element("div", "h-kv");
    const fact = (label, value, mono = false, warning = "") => {
      const shown = element("span", `v${mono ? " mono" : ""}${warning ? " cut" : ""}`, value);
      shown.title = warning || value;
      scoreKv.append(element("span", "muted", label), shown, element("span"));
    };
    fact("Planning", planningText(settings));
    const fields = detail.score.fields;
    const tempo = /(\d+(?:\.\d+)?)\s*$/.exec(fields.Q ?? "")?.[1];
    fact("Score", `${detail.score.bars} bars · ≈${clock(detail.score.seconds)}${tempo ? ` at ${tempo} BPM` : ""}`);
    fact("Audio", !detail.seconds ? "–" : detail.score.audio_end_bar == null ? `FLAC ${clock(detail.seconds)}`
      : `FLAC ${clock(detail.seconds)} · stops ≈ bar ${Math.floor(detail.score.audio_end_bar) + 1}`, false,
      cutText(detail.score, detail.seconds));
    fact("Meter", fields.M || "–");
    fact("Key", fields.K || "–");
    scoreBox.append(scoreKv);
    columns.append(runBox, scoreBox);

    const actions = element("div", "h-actions");
    const seed = button("Restore seed (fixed)", () => this.restore({ seed: true }), "primary");
    seed.disabled = !settings.values.seed.length;
    const planners = referenceTargets(rootGraph());
    const more = planners.length > 1 ? "…" : "";
    const saved = button(`Use saved score${more}`, (event) => this.useAsReference(event, detail.abc, true));
    saved.disabled = !planners.length;
    saved.title = "Load final ABC as the reference, with opening and continuation off (Extend off for Reference input).";
    const lyrics = button("Restore lyrics + style", () => this.restore({ lyricsStyle: true }));
    lyrics.disabled = !settings.values.lyrics.length && !settings.values.style.length;
    const all = button(`Restore all${more}`, (event) => this.restoreAll(event));
    all.title = settings.planners.length || !planners.length ? "Restore plan, mode, fixed seed, lyrics, style, instrumental and sampling."
      : "Older run without Score settings: restores the saved final ABC as-is, plus seed, lyrics, style, instrumental and sampling.";
    all.disabled = !detail.prompt;
    if (settings.planners.length > 1) {
      const select = element("select"); select.setAttribute("aria-label", "Recorded Score node");
      for (const entry of settings.planners) {
        const option = element("option", "", `Saved Score · ${entry.id}`); option.value = entry.id; select.append(option);
      }
      const match = settings.planners.find(entry => planners.some(target => target.id === entry.id));
      if (!settings.planners.some(entry => entry.id === this.recordedId)) this.recordedId = match?.id ?? settings.planners[0].id;
      select.value = this.recordedId;
      select.onchange = () => { this.recordedId = select.value; };
      actions.append(select);
    }
    actions.append(seed, saved, lyrics, element("span", "spacer"), all);
    for (const entry of settings.planners.filter(entry => entry.planError)) container.append(element("div", "h-warn", entry.planError));
    container.append(columns, actions);
    return container;
  }

  // `target` is the destination for the plan; seed, lyrics, style and sampling go to their own sources.
  async restore(what, target = null) {
    const detail = this.details.get(this.open);
    if (!detail) return;
    let current;
    try {
      current = await currentSettings();
    } catch (error) {
      return this.message(`Cannot read the current graph: ${error.message ?? error}`, true);
    }
    const root = rootGraph();
    const planners = detail.settings.planners;
    const recorded = this.recorded(detail);
    if (what.plan && !target) return this.message("Add a YuE2 Advanced Score or Reference input node to restore the score.", true);
    const blocked = what.plan && this.planBlock(target.node, recorded);
    if (blocked) return this.message(`${referenceLabel(target.node)} · ${target.id} ${blocked}. ${RESTORE_HINT}`, true);
    if (what.plan && planners.length && !recorded) {
      return this.message("Choose a matching recorded Score node; multiple saved scores cannot be mapped automatically.", true);
    }
    const done = [], missing = [], linked = new Set();
    changeGraph(() => {
      const past = detail.settings;
      // Every source the current graph uses, set to the past value for its sampler.
      const restore = (name, label, after) => {
        if (!past.values[name].length) return;
        const targets = current.values[name].filter((entry, index, all) =>
          all.findIndex((other) => other.id === entry.id && other.input === entry.input) === index);
        let set = 0;
        for (const entry of targets) {
          const publicValue = recorded && past.values[name].find(source => source.samplerId === recorded.id);
          // Into Lyrics + style, write the variant the run used; the instrumental flag is restored with it.
          const input = entry.classType === LYRICS_STYLE ? lyricsVariant(name, shown(past, "instrumental")?.value === true) : entry.input;
          const result = setInput(root, entry.id, input, publicValue ? publicValue.value : pastValueFor(past, name, entry));
          if (result?.node) { set++; after?.(result.node, result.name); }
          else if (result) linked.add(name);
        }
        if (set) done.push(label(set));
        else if (!linked.has(name)) missing.push(name);
      };
      if (what.plan && recorded && !isScore(target.node)) {
        restoreReference(target.node, recorded.plan);
        done.push("reference settings");
      } else if (what.plan && recorded) {
        const values = normalizeValues(recorded.values);
        for (const [name,value] of Object.entries(values)) {
          const result = setInput(root, target.id, name, value);
          if (!result) missing.push(name);
          else if (!result.node) linked.add(name);
        }
        showPlan(target.node); flashPlanner(target.node); done.push("Score widgets");
      }
      if (what.plan && !planners.length && target) {
        useReference(target.node, detail.abc, true);
        done.push("saved final ABC as-is (original settings unavailable)");
      }
      if (what.seed) {
        restore("seed", (count) => `seed ${[...new Set(past.values.seed.map((entry) => entry.value))].join(" / ")} (fixed${count > 1 ? `, ${count} sources` : ""})`,
          (node, name) => fixControl(node, name));
      }
      if (what.lyricsStyle) {
        restore("lyrics", () => "lyrics");
        restore("style", () => "style");
        restore("instrumental", () => "instrumental");
      }
      if (what.sampling) {
        let changed = 0;
        for (const entry of past.sampling.filter(entry => entry.class_type !== SCORE)) {
          const target = current.sampling.find((other) => other.id === entry.id && other.class_type === entry.class_type)
            ?? current.sampling.find((other) => other.class_type === entry.class_type);
          if (!target) continue;
          for (const [name, value] of Object.entries(entry.values)) {
            if (!(name in target.values) || same(value, target.values[name])) continue;
            const result = setInput(root, target.id, name, value);
            if (result?.node) changed++;
            else if (result) linked.add(name);
          }
        }
        done.push(changed ? `${changed} sampling setting${changed === 1 ? "" : "s"}` : "sampling (already the same)");
      }
    });
    const text = done.length ? `Restored ${done.join(", ")}.` : "Nothing restored.";
    const problems = [missing.length && `Not found in this workflow: ${missing.join(", ")}.`,
      linked.size && `Not restored, set by a linked node: ${[...linked].join(", ")}.`].filter(Boolean);
    this.message(problems.length ? problems.join(" ") : done.length ? "" : text, problems.length > 0 || !done.length);
    this.compare();
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.refreshTimer);
    api.removeEventListener("executed", this.onExecuted);
    this.audio.pause();
    this.audio.removeAttribute("src");
    releaseStrip(this.root); this.root.remove();
  }
}

app.registerExtension({
  name: "bno84.SongHistory",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const panel = new SongHistoryPanel(node);
    node.yue2SongHistory = panel;
    const removed = node.onRemoved;
    node.onRemoved = function (...args) { panel.destroy(); return removed?.apply(this, args); };
  },
});
