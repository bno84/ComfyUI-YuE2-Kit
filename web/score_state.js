// Public Score state is ordinary widgets, serialized by ComfyUI.
export const SCORE_DEFAULTS = {
  header_mode: "generated", header_tempo: 120, header_meter: "4/4", header_key: "C major",
  opening_generate: false, opening_bars: 8, opening_hint: "intro", opening_candidates: 4,
  anchor_use: false, anchor_abc: "", anchor_start: 1, anchor_end: 0,
  continue_generate: true, mode: "full", temperature: 0.7, top_p: 0.9,
  top_k: 30, repetition_penalty: 1.005, penalty_window: 100, opening_tokens: 1024, continuation_tokens: 8192,
};
export function readValues(node) {
  return Object.fromEntries(Object.keys(SCORE_DEFAULTS).map(name =>
    [name, node.widgets?.find(w => w.name === name)?.value ?? SCORE_DEFAULTS[name]]));
}
export function setValues(node, values) {
  for (const [name, value] of Object.entries(values)) {
    const widget = node.widgets?.find(w => w.name === name);
    if (widget) { widget.value = value; widget.callback?.(value); }
  }
  node.yue2ScorePanel?.refresh(); node.graph?.setDirtyCanvas(true, true);
}
// Internal representation for history descriptions, never a serialized widget.
export function valuesPlan(v) {
  const policy = v.header_mode === "fixed" ? "set" : ["from reference", "from anchor"].includes(v.header_mode) ? "anchor" : "free";
  const key = v.header_key.replace(" major", "").replace(" minor", "m");
  return {version: 1, source: {kind: v.anchor_use ? "abc" : "none", abc: v.anchor_abc},
    anchor: {start: v.anchor_start - 1, end: v.anchor_end || null},
    opening: {bars: v.anchor_use && v.opening_generate ? v.opening_bars : 0, label: v.opening_hint, attempts: v.opening_candidates},
    continuation: {enabled: !v.anchor_use || v.continue_generate},
    header: Object.fromEntries([["tempo", v.header_tempo], ["meter", v.header_meter], ["key", key]].map(([name,value]) => [name,{policy,value}]))};
}
export function rangeSelection(total, start, end, side, from, to) {
  const clamp = n => Math.max(0, Math.min(total - 1, Math.floor(n)));
  if (side === 0) return [Math.min(Math.max(1, Math.round(to) + 1), end), end];
  if (side === 1) return [start, Math.max(start, Math.min(total, Math.round(to)))];
  return [Math.min(clamp(from), clamp(to)) + 1, Math.max(clamp(from), clamp(to)) + 1];
}
export function applicable(v) {
  return {
    ...Object.fromEntries(["header_tempo", "header_meter", "header_key"].map(n => [n, v.header_mode === "fixed"])),
    opening_generate: v.anchor_use,
    ...Object.fromEntries(["opening_bars", "opening_hint", "opening_candidates", "opening_tokens"].map(n => [n, v.anchor_use && v.opening_generate])),
    anchor_abc: v.anchor_use, anchor_start: v.anchor_use, anchor_end: v.anchor_use,
    continue_generate: v.anchor_use,
  };
}

// Resolve only plain passthrough inputs for a model-free preview. Unknown outputs
// remain unknown; a saved widget value must never impersonate a linked result.
export function previewValues(node, output, id) {
  const values = readValues(node), inputs = output[id]?.inputs ?? {};
  function resolve(value, name, seen = new Set()) {
    if (!Array.isArray(value)) return value;
    const key = value[0]; if (seen.has(key)) return undefined; seen.add(key);
    const source = output[key]?.inputs;
    return source ? resolve(source[name] ?? source.value, name, seen) : undefined;
  }
  const links = (node.inputs ?? []).filter(i => i.link != null && !["clip","sheetsage2","lyrics","style","seed"].includes(i.name));
  for (const name of ["anchor_use","header_mode","opening_generate","continue_generate"]) {
    if (!links.some(i => i.name === name)) continue;
    const value = resolve(inputs[name],name); if (value === undefined) return null;
    values[name] = value;
  }
  const used = applicable(values);
  for (const input of links) {
    if (used[input.name] === false) continue;
    const value = resolve(inputs[input.name],input.name);
    if (value === undefined) return null;
    values[input.name] = value;
  }
  return values;
}
