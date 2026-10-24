// Follow Boolean wires through subgraph inputs to synchronize native bypass.
// The same wire also drives the branch's ordinary If/Else switch.
import { app } from "../../scripts/app.js";

function* subgraphHosts(root, subgraph) {
  const pending = [root];
  const visited = new Set();
  while (pending.length) {
    const graph = pending.pop();
    if (visited.has(graph)) continue;
    visited.add(graph);
    for (const node of graph._nodes ?? []) {
      if (node.subgraph === subgraph) yield node;
      if (node.subgraph) pending.push(node.subgraph);
    }
  }
}

function effectiveWidgetValue(node, name) {
  let value = node.widgets?.find((widget) => widget.name === name)?.value;
  const root = node.graph?.rootGraph ?? node.graph;
  const input = node.inputs?.find((input) => input.name === name);
  const upstream = input?.link != null ? node.graph.getLink(input.link) : null;
  if (upstream && String(upstream.origin_id) === "-10") {
    const slot = node.graph.inputNode.slots[upstream.origin_slot];
    for (const host of subgraphHosts(root, node.graph)) {
      const promoted = host.widgets?.find((widget) => widget.name === slot?.name);
      if (promoted) value = promoted.value;
    }
  }
  return value;
}

function knownBoolean(node) {
  if (node.comfyClass === "PrimitiveBoolean") return effectiveWidgetValue(node, "value");
  if (node.comfyClass !== "ComfyMathExpression") return undefined;
  // These native comparisons derive Boolean flags from a native Custom Combo's
  // index. Deliberately support only simple comparisons; never evaluate code.
  const expression = effectiveWidgetValue(node, "expression");
  const match = /^a\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(expression ?? "");
  const input = node.inputs?.find((input) => input.name === "values.a");
  const link = input?.link != null ? node.graph.getLink(input.link) : null;
  const source = link && node.graph.getNodeById(link.origin_id);
  if (!match || source?.comfyClass !== "CustomCombo" || link.origin_slot !== 1) return undefined;
  const options = source.widgets?.filter((widget) => /^option\d+$/.test(widget.name)).map((widget) => widget.value) ?? [];
  const index = options.indexOf(effectiveWidgetValue(source, "choice"));
  if (index < 0) return undefined;
  const right = Number(match[2]);
  return {
    "==": index === right, "!=": index !== right,
    ">=": index >= right, "<=": index <= right,
    ">": index > right, "<": index < right,
  }[match[1]];
}

function syncBranch(node, synced) {
  const root = node.graph?.rootGraph ?? node.graph;
  const value = knownBoolean(node);
  if (typeof value !== "boolean" || !root) return;
  const mode = value ? 0 : 4; // Always / Bypass.
  const pending = (node.outputs ?? [])
    .filter((output) => output.type === "BOOLEAN")
    .flatMap((output) => (output.links ?? []).map((id) => [node.graph, id]));
  const visited = new Map();
  while (pending.length) {
    const [graph, id] = pending.pop();
    if (!visited.has(graph)) visited.set(graph, new Set());
    if (visited.get(graph).has(id)) continue;
    visited.get(graph).add(id);
    const link = graph.getLink(id);
    if (link && String(link.target_id) === "-20") {
      // A Boolean inside a control subgraph leaves through its output boundary.
      for (const host of subgraphHosts(root, graph)) {
        for (const next of host.outputs?.[link.target_slot]?.links ?? []) {
          pending.push([host.graph, next]);
        }
      }
      continue;
    }
    const target = link && graph.getNodeById(link.target_id);
    const input = target?.inputs?.[link.target_slot];
    if (!input) continue;
    if (target.properties?.["bno84.enabledInput"] === input.name) {
      synced?.add(target);
      if (target.mode !== mode) {
        root.beforeChange?.();
        target.mode = mode;
        root.afterChange?.();
        root.setDirtyCanvas?.(true, true);
      }
    }
    if (target.subgraph) {
      const slot = target.subgraph.inputNode.slots[link.target_slot];
      for (const next of slot?.linkIds ?? []) pending.push([target.subgraph, next]);
    }
  }
}

function syncSubgraph(node, synced, required) {
  const pending = [node.subgraph];
  const visited = new Set();
  while (pending.length) {
    const graph = pending.pop();
    if (!graph || visited.has(graph)) continue;
    visited.add(graph);
    for (const child of graph._nodes ?? []) {
      if (child.properties?.["bno84.enabledInput"]) required?.push(child);
      if (["PrimitiveBoolean", "ComfyMathExpression"].includes(child.comfyClass)) syncBranch(child, synced);
      if (child.subgraph) pending.push(child.subgraph);
    }
  }
}

const boundWidgets = new WeakSet();
function bindPromotedControls(node) {
  for (const widget of node.widgets ?? []) {
    const input = node.inputs?.find((input) => input.name === widget.name);
    if (!["BOOLEAN", "COMBO"].includes(input?.type) || boundWidgets.has(widget)) continue;
    const callback = widget.callback;
    widget.callback = function (...args) {
      const result = callback?.apply(this, args);
      syncSubgraph(node);
      return result;
    };
    boundWidgets.add(widget);
  }
}

const precompileHook = Symbol.for("bno84.WiredBranchToggle.precompile");

function preparePrompt(graph) {
  const synced = new Set();
  const required = [];
  syncSubgraph({ subgraph: graph?.rootGraph ?? graph }, synced, required);
  for (const branch of required) {
    if (!synced.has(branch)) {
      throw new Error(
        `${branch.title ?? branch.id}: no connected Boolean reaches '${branch.properties["bno84.enabledInput"]}'. ` +
        "Reconnect the branch control before queueing or exporting the API prompt."
      );
    }
  }
}

app.registerExtension({
  name: "bno84.WiredBranchToggle",
  setup() {
    if (app[precompileHook]) return;
    const graphToPrompt = app.graphToPrompt;
    app.graphToPrompt = function (...args) {
      // ComfyUI also accepts an explicit graph when exporting/compiling a prompt.
      const graph = args[0]?._nodes ? args[0] : this.rootGraph ?? this.graph;
      preparePrompt(graph);
      return graphToPrompt.apply(this, args);
    };
    app[precompileHook] = true;
  },
  nodeCreated(node) {
    if (node.subgraph) {
      const configured = node.onGraphConfigured;
      node.onGraphConfigured = function (...args) {
        const result = configured?.apply(this, args);
        bindPromotedControls(this);
        syncSubgraph(this);
        return result;
      };
      bindPromotedControls(node);
      return;
    }
    const widgetName = { PrimitiveBoolean: "value", CustomCombo: "choice", ComfyMathExpression: "expression" }[node.comfyClass];
    if (!widgetName) return;
    const control = node.widgets?.find((widget) => widget.name === widgetName);
    if (!control) return;
    const callback = control.callback;
    control.callback = function (...args) {
      const result = callback?.apply(this, args);
      syncSubgraph({ subgraph: node.graph?.rootGraph ?? node.graph });
      return result;
    };
    const configured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) {
      const result = configured?.apply(this, args);
      syncSubgraph({ subgraph: this.graph?.rootGraph ?? this.graph });
      return result;
    };
  },
});
