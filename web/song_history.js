// Song history: saved FLAC + ABC pairs, newest first. Rows show each score's
// sections in bars; FLAC progress is drawn separately, because score time and
// audio time can differ by seconds. Opening a song selects whole groups of
// bars to reuse, and restores the seed, lyrics and style from the prompt the
// FLAC embeds.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "bno84.SongHistory";
const PAGE = 20;
const PREROLL = 2;
const COLORS = ["#7f77dd", "#1d9e75", "#d85a30", "#d4537e", "#378add", "#ba7517", "#639922"];
const UNNAMED = "#666";
const SAMPLERS = ["YuE2GenerateMusic", "YuE2GenerateABC", "bno84.YuE2ExtendABC"];

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

// Section names compare without case or trailing numbers: "Verse 2" matches "verse".
const kind = (label) => (label ?? "").toLowerCase().replace(/[\s\d]+$/, "");

export function sectionColors() {
  const colors = new Map();
  return (label) => {
    const name = kind(label);
    if (!name) return UNNAMED;
    if (!colors.has(name)) colors.set(name, COLORS[colors.size % COLORS.length]);
    return colors.get(name);
  };
}

// A node's executed output that saved a FLAC to the output folder, as Final outputs does.
export function savesSong(output) {
  return (output?.audio ?? []).some((file) => file?.type === "output" && /\.flac$/i.test(file?.filename ?? ""));
}

const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

// Where a compiled input's value comes from: follow links to the node that
// holds it, as long as that node has an input of the same name or a "value".
export function resolveInput(prompt, id, name) {
  let node = prompt?.[id], value = node?.inputs?.[name];
  for (let depth = 0; node && isLink(value) && depth < 16; depth++) {
    const source = prompt[value[0]];
    const input = source && (name in (source.inputs ?? {}) ? name : "value" in (source.inputs ?? {}) ? "value" : null);
    if (!input) return null;
    [id, node, name, value] = [value[0], source, input, source.inputs[input]];
  }
  return node && scalar(value) && value !== undefined ? { id, input: name, value, title: node._meta?.title ?? "" } : null;
}

const RESTORED = ["seed", "lyrics", "style"];

// What a run used, and where, from a compiled prompt: the embedded one or the current graph's.
// Seed, lyrics and style list one source per sampler, so separate sources are all restored.
export function runSettings(prompt) {
  const nodes = Object.entries(prompt ?? {});
  const settings = { values: { seed: [], lyrics: [], style: [], instrumental: [] }, reference: null, sampling: [] };
  const samplers = nodes.filter(([, node]) => SAMPLERS.includes(node.class_type))
    .sort(([, a], [, b]) => SAMPLERS.indexOf(a.class_type) - SAMPLERS.indexOf(b.class_type));
  const sources = samplers.length ? samplers : nodes.filter(([, node]) => "seed" in (node.inputs ?? {})).slice(0, 1);
  for (const name of RESTORED) {
    for (const [id, node] of sources) {
      const found = resolveInput(prompt, id, name);
      if (found) settings.values[name].push({ sampler: node.class_type, ...found });
    }
  }
  for (const [id, node] of nodes) {
    const inputs = node.inputs ?? {};
    if (node.class_type === "bno84.LyricsStyle" && !settings.values.instrumental.length && typeof inputs.instrumental === "boolean") {
      settings.values.instrumental.push({ sampler: "", id, input: "instrumental", value: inputs.instrumental, title: node._meta?.title ?? "" });
    } else if (node.class_type === "bno84.ReferenceInput" && !settings.reference) {
      settings.reference = { id, source: inputs.source, extend: !!inputs.extend };
    } else if (SAMPLERS.includes(node.class_type)) {
      const values = Object.fromEntries(Object.entries(inputs).filter(([name, value]) => !RESTORED.includes(name) && scalar(value)));
      settings.sampling.push({ id, class_type: node.class_type, values });
    }
  }
  settings.sampling.sort((a, b) => SAMPLERS.indexOf(a.class_type) - SAMPLERS.indexOf(b.class_type));
  return settings;
}

// The value shown for a setting: the first sampler's, music before planning.
export const shown = (settings, name) => settings.values[name][0] ?? null;

// The past value for one of the current graph's sources: same sampler, else the first.
export function pastValueFor(past, name, entry) {
  const sources = past.values[name];
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
    plan && `ABC t ${plan.temperature}`,
    music && `audio t ${music.temperature}`,
    music && music.cfg_scale !== undefined && `cfg ${music.cfg_scale}`,
  ].filter(Boolean).join(" · ");
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

// Set what a compiled input will be. An input fed from its subgraph's own
// input takes the value of the subgraph node's widget, one level up.
export function setInput(root, id, name, value) {
  const path = String(id).split(":");
  let node = findNode(root, path.join(":"));
  while (node) {
    const input = node.inputs?.find((candidate) => candidate.name === name);
    const link = input?.link != null ? linkOf(node.graph, input.link) : null;
    if (link && Number(link.origin_id) === SUBGRAPH_INPUT && path.length > 1) {
      const slot = node.graph.inputs?.[link.origin_slot];
      path.pop();
      node = findNode(root, path.join(":"));
      name = slot?.name;
      continue;
    }
    return setWidget(node, name, value) ? node : null;
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
.yue2-history {box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;min-height:0;color:var(--input-text,#ddd);font:12px/1.45 sans-serif;padding:4px;}
.yue2-history [hidden] {display:none!important;}
.yue2-history button,.yue2-history input {font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:4px 8px;}
.yue2-history button {cursor:pointer;white-space:nowrap;}
.yue2-history button:disabled {opacity:.45;cursor:default;}
.yue2-history button.primary {background:var(--p-button-primary-background,#405c83);border-color:transparent;color:var(--p-button-primary-color,#fff);}
.yue2-history .h-bar {flex:none;display:flex;gap:6px;}
.yue2-history .h-bar input {flex:1;min-width:0;}
.yue2-history .h-list {position:relative;flex:1;min-height:0;overflow:auto;}
.yue2-history .h-row {display:grid;grid-template-columns:22px 96px minmax(0,1fr) 38px;gap:8px;align-items:center;padding:4px;border-bottom:1px solid var(--border-color,#444);cursor:pointer;}
.yue2-history .h-row:hover {background:#ffffff0a;}
.yue2-history .h-row.open {background:#3d4a5c;border-radius:4px 4px 0 0;border-bottom-color:transparent;}
.yue2-history .h-play {width:22px;height:22px;padding:0;border-radius:50%;font-size:9px;line-height:20px;text-align:center;}
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
.yue2-history .h-strip {position:relative;height:34px;border-radius:4px;overflow:hidden;background:#252525;user-select:none;touch-action:none;}
.yue2-history .h-block {position:absolute;top:0;bottom:0;box-sizing:border-box;border-left:1px solid #0006;padding:0 4px;color:#fff;line-height:34px;white-space:nowrap;overflow:hidden;cursor:pointer;}
.yue2-history .h-cut {position:absolute;top:0;bottom:0;right:0;box-sizing:border-box;border-left:2px solid #ffcf7a;background:repeating-linear-gradient(135deg,#000b 0 4px,#0007 4px 8px);pointer-events:none;}
.yue2-history .h-mini .h-cut {border-left-width:1px;}
.yue2-history .h-strip .h-cut span {position:absolute;left:4px;top:0;color:#ffcf7a;font-size:11px;line-height:34px;white-space:nowrap;}
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
.yue2-history .h-cols {display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;}
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
.yue2-history .h-status {min-height:1.45em;margin-top:6px;color:#9fd8a8;overflow-wrap:anywhere;}
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

function miniStrip(sections, color, audioEnd = null) {
  const strip = element("div", "h-mini");
  const total = sections.reduce((sum, section) => sum + section.bars, 0) || 1;
  for (const section of sections) {
    const block = element("i");
    Object.assign(block.style, {
      left: `${(100 * section.bar) / total}%`, width: `${(100 * section.bars) / total}%`, background: color(section.label),
    });
    block.title = `${section.label || "(unnamed)"} · ${section.bars} bars`;
    strip.append(block);
  }
  if (audioEnd != null) strip.append(cutOverlay(audioEnd, total));
  return strip;
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
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
    const bar = element("div", "h-bar");
    this.filter = element("input");
    this.filter.type = "search";
    this.filter.placeholder = "Filter by name, style or lyrics…";
    this.filter.setAttribute("aria-label", "Filter songs");
    this.filter.oninput = () => { clearTimeout(this.filterTimer); this.filterTimer = setTimeout(() => this.load(), 250); };
    const refresh = button("↻", () => this.load("refresh"));
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
      serialize: false, canvasOnly: true, hideOnZoom: false, getMinHeight: () => 300,
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
      const play = button("▶", () => this.togglePlay(song), "h-play");
      play.setAttribute("aria-label", `Play ${song.name}`);
      const name = element("div", "h-name");
      name.title = song.path;
      name.append(element("b", "", song.name), element("br"), element("span", "muted", ago(song.mtime)));
      const track = element("div", "h-track");
      const progress = element("div", "h-progress");
      progress.append(element("b"));
      track.append(miniStrip(song.score.sections, this.color, song.score.audio_end_bar), progress);
      const warning = cutText(song.score, song.seconds);
      const length = element("span", warning ? "cut" : "muted", song.seconds ? `${clock(song.seconds)}${song.score.audio_extra_seconds != null ? " · ABC shorter" : ""}` : "–");
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
      parts.play.textContent = on ? "❚❚" : "▶";
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
        detail.settings = runSettings(detail.prompt);
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
    this.status = { text, error };
    if (this.statusElement) {
      this.statusElement.textContent = text;
      this.statusElement.dataset.error = String(error);
    }
  }

  renderOpen() {
    for (const [path, parts] of this.rows ?? []) {
      const open = path === this.open;
      parts.row.classList.toggle("open", open);
      parts.zoom.hidden = !open;
      if (!open) parts.zoom.replaceChildren();
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
    const strip = element("div", "h-strip");
    const sections = [];
    groups.forEach((group, index) => {
      if (group.starts_section || !sections.length) sections.push({ label: group.label, start: index, bar: group.bar, bars: 0 });
      sections.at(-1).bars += group.bars;
    });
    for (const section of sections) {
      const block = element("div", "h-block", section.label || "");
      Object.assign(block.style, {
        left: `${(100 * section.bar) / total}%`, width: `${(100 * section.bars) / total}%`, background: this.color(section.label),
      });
      block.title = `${section.label || "(unnamed)"} · bars ${section.bar + 1}–${section.bar + section.bars}`;
      strip.append(block);
    }
    for (const group of groups.slice(1)) {
      const line = element("div", "h-grid");
      line.style.left = `${(100 * group.bar) / total}%`;
      strip.append(line);
    }
    if (detail.score.audio_end_bar != null) strip.append(cutOverlay(detail.score.audio_end_bar, total, "not in FLAC"));
    this.selectionElement = element("div", "h-sel");
    const handles = [element("div", "h-handle"), element("div", "h-handle")];
    handles[0].style.left = "-5px";
    handles[1].style.right = "-5px";
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
    this.selectionElement.append(...handles);
    strip.append(this.selectionElement);
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

    const axis = element("div", "h-bars");
    const step = [4, 8, 16, 32, 64].find((value) => total / value <= 12) ?? 128;
    for (let barNumber = 0; barNumber < total; barNumber += step) {
      const label = element("span", "", String(barNumber + 1));
      label.style.left = `${(100 * barNumber) / total}%`;
      axis.append(label);
    }

    this.selectionBar = element("div", "h-selbar");
    const settings = this.renderSettings(detail);
    this.statusElement = element("div", "h-status");
    if (this.status) {
      this.statusElement.textContent = this.status.text;
      this.statusElement.dataset.error = String(this.status.error);
    }
    const notes = detail.score.audio_extra_seconds != null
      ? [element("div", "h-note cut", cutText(detail.score, detail.seconds))] : [];
    parts.zoom.replaceChildren(strip, axis, ...notes, this.selectionBar, settings, this.statusElement);
    this.renderSelection();
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
    text.append(element("b", "", whole ? "Whole score" : `Bars ${info.firstBar}–${info.lastBar}`),
      ` · ${info.labels.join(", ") || "no sections"} · ${info.bars} bars · ≈${clock(info.duration)}`);
    text.title = "The duration follows the score's tempo and meter. The rendered audio can differ by seconds.";
    const ready = this.slice && !this.slice.error && this.slice.range[0] === this.selection[0] && this.slice.range[1] === this.selection[1];
    const previews = nodesOfClass(rootGraph(), "bno84.ABCPreview").filter((node) => node.abcPreview);
    const preview = button("Show in ABC Preview", () => {
      for (const node of previews) node.abcPreview.setAbc(this.slice.abc);
      this.message("Shown in ABC Preview. Press play there to hear the notes; it returns to the workflow's score on the next run.");
    });
    preview.disabled = !ready || !previews.length;
    preview.title = previews.length ? "Show this selection's score in the workflow's ABC Preview" : "Add an ABC Preview node to the workflow";
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
    const use = button("Use as reference", () => this.useAsReference(this.slice.abc, null), "primary");
    use.disabled = !ready;
    use.title = "Put this score in Reference input as ABC. The Extend reference setting is kept.";
    const items = [text, preview, flac, copy, use];
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
    const reference = settings.reference;
    fact("Source", !reference ? "–" : reference.source === "None" ? "Planned from lyrics + style"
      : `${reference.source} reference · extend ${reference.extend ? "on" : "off"}`);
    const fields = detail.score.fields;
    const tempo = /(\d+(?:\.\d+)?)\s*$/.exec(fields.Q ?? "")?.[1];
    fact("Score", `${detail.score.bars} bars · ≈${clock(detail.score.seconds)}${tempo ? ` at Q:${tempo}` : ""}`);
    fact("Audio", !detail.seconds ? "–" : detail.score.audio_end_bar == null ? `FLAC ${clock(detail.seconds)}`
      : `FLAC ${clock(detail.seconds)} · stops ≈ bar ${Math.floor(detail.score.audio_end_bar) + 1}`, false,
      cutText(detail.score, detail.seconds));
    fact("Header", ["M", "K"].filter((name) => fields[name]).map((name) => `${name}:${fields[name]}`).join(" · ") || "–", true);
    scoreBox.append(scoreKv);
    columns.append(runBox, scoreBox);

    const actions = element("div", "h-actions");
    const seed = button("Restore seed (fixed)", () => this.restore({ seed: true }), "primary");
    seed.disabled = !settings.values.seed.length;
    const score = button("Score → Reference input", () => this.useAsReference(detail.abc, false));
    score.title = "Use the whole saved score as ABC, with Extend reference off.";
    const lyrics = button("Restore lyrics + style", () => this.restore({ lyricsStyle: true }));
    lyrics.disabled = !settings.values.lyrics.length && !settings.values.style.length;
    const all = button("Restore all", () => this.restore({ seed: true, lyricsStyle: true, score: true, sampling: true }));
    all.title = "Seed, lyrics, style, sampling settings, and the whole score as the reference with Extend off.";
    all.disabled = !detail.prompt;
    actions.append(seed, score, lyrics, element("span", "spacer"), all);
    container.append(columns, actions);
    return container;
  }

  useAsReference(abc, extend) {
    const nodes = nodesOfClass(rootGraph(), "bno84.ReferenceInput");
    if (!nodes.length) return this.message("Add a Reference input node to the workflow first.", true);
    changeGraph(() => {
      for (const node of nodes) {
        setWidget(node, "source", "ABC");
        setWidget(node, "abc", abc);
        if (extend !== null) setWidget(node, "extend", extend);
        node.yue2ReferencePanel?.render();
      }
    });
    const mode = extend === null ? "Extend reference is unchanged" : `Extend reference is ${extend ? "on" : "off"}`;
    this.message(`Reference input now uses this score. ${mode}.`);
    this.compare();
  }

  async restore(what) {
    const detail = this.details.get(this.open);
    if (!detail) return;
    let current;
    try {
      current = await currentSettings();
    } catch (error) {
      return this.message(`Cannot read the current graph: ${error.message ?? error}`, true);
    }
    const root = rootGraph();
    const done = [], missing = [];
    changeGraph(() => {
      const past = detail.settings;
      // Every source the current graph uses, set to the past value for its sampler.
      const restore = (name, label, after) => {
        if (!past.values[name].length) return;
        const targets = current.values[name].filter((entry, index, all) =>
          all.findIndex((other) => other.id === entry.id && other.input === entry.input) === index);
        let set = 0;
        for (const entry of targets) {
          const node = setInput(root, entry.id, entry.input, pastValueFor(past, name, entry));
          if (node) { set++; after?.(node, entry); }
        }
        if (set) done.push(label(set));
        else missing.push(name);
      };
      if (what.seed) {
        restore("seed", (count) => `seed ${[...new Set(past.values.seed.map((entry) => entry.value))].join(" / ")} (fixed${count > 1 ? `, ${count} sources` : ""})`,
          (node, entry) => fixControl(node, entry.input));
      }
      if (what.lyricsStyle) {
        restore("lyrics", () => "lyrics");
        restore("style", () => "style");
        restore("instrumental", () => "instrumental");
      }
      if (what.sampling) {
        let changed = 0;
        for (const entry of past.sampling) {
          const target = current.sampling.find((other) => other.id === entry.id && other.class_type === entry.class_type)
            ?? current.sampling.find((other) => other.class_type === entry.class_type);
          if (!target) continue;
          for (const [name, value] of Object.entries(entry.values)) {
            if (name in target.values && !same(value, target.values[name]) && setInput(root, target.id, name, value)) changed++;
          }
        }
        done.push(changed ? `${changed} sampling setting${changed === 1 ? "" : "s"}` : "sampling (already the same)");
      }
    });
    if (what.score) {
      this.useAsReference(detail.abc, false);
      done.push("the score as reference, extend off");
    }
    const text = done.length ? `Restored ${done.join(", ")}.` : "Nothing restored.";
    this.message(missing.length ? `${text} Not found in this workflow: ${missing.join(", ")}.` : text, !done.length);
    this.compare();
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.refreshTimer);
    api.removeEventListener("executed", this.onExecuted);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.root.remove();
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
