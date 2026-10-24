import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/branch_toggle.js", import.meta.url), "utf8");
function loadExtension(app = {}) {
  let extension;
  app.registerExtension = (value) => { extension = value; };
  new Function("app", source.replace(/^import .*;$/m, ""))(app);
  return extension;
}
const extension = loadExtension();

function fixture() {
  const workflow = JSON.parse(readFileSync(new URL("../example_workflows/yue2-kit-song.json", import.meta.url), "utf8"));
  const controls = workflow.nodes.find((node) => node.title === "Reference controls");
  assert.deepEqual(controls.inputs.map((input) => input.name), ["use_transcription", "extend"]);
  assert.equal(controls.outputs.length, 2);
  assert.ok(controls.outputs.every((output) => output.links.length));
  const group = workflow.definitions.subgraphs.find((graph) => graph.id === controls.type);
  const definition = group.nodes.find((node) => node.id === 13);
  assert.equal(definition.type, "PrimitiveBoolean");
  assert.ok(group.nodes.some((node) => node.title === "Extend transcribed ABC"));
  const definitions = new Map(workflow.definitions.subgraphs.map((graph) => [graph.id, graph]));
  function graphFrom(definition, root) {
    const graph = {
      _nodes: structuredClone(definition.nodes),
      inputNode: { slots: definition.inputs ?? [] },
      getNodeById(id) { return this._nodes.find((node) => String(node.id) === String(id)); },
      getLink(id) {
        const link = definition.links.find((link) => (Array.isArray(link) ? link[0] : link.id) === id);
        return Array.isArray(link) ? { origin_id: link[1], origin_slot: link[2], target_id: link[3], target_slot: link[4] } : link;
      },
    };
    graph.rootGraph = root ?? graph;
    for (const node of graph._nodes) {
      node.graph = graph;
      if (definitions.has(node.type)) node.subgraph = graphFrom(definitions.get(node.type), graph.rootGraph);
    }
    return graph;
  }
  const root = graphFrom(workflow);
  const planning = root.getNodeById(30).subgraph;
  const branch = planning.getNodeById(36);
  const unrelated = { mode: 4, properties: {} };
  planning._nodes.push(unrelated);
  const node = root.getNodeById(controls.id).subgraph.getNodeById(definition.id);
  assert.ok(node.outputs[0].links.length, "The main-canvas checkbox must be wired");
  let calls = 0;
  const control = { name: "value", value: definition.widgets_values[0], callback() { calls++; return "native"; } };
  node.comfyClass = "PrimitiveBoolean";
  node.widgets = [control];
  extension.nodeCreated(node);
  const host = root.getNodeById(controls.id);
  const promoted = {
    name: "use_transcription",
    value: control.value,
    callback() { return "promoted"; },
  };
  host.widgets = [promoted];
  extension.nodeCreated(host);
  host.onGraphConfigured();
  // Source-callback tests can set the exposed value as well; the backend uses it.
  return { root, node, control, promoted, branch, unrelated, calls: () => calls };
}

test("main-canvas transcription checkbox enables and bypasses its native branch", () => {
  const { control, promoted, branch, unrelated, calls } = fixture();
  assert.equal(control.value, false);
  assert.equal(branch.mode, 4);
  control.value = true;
  promoted.value = true;
  assert.equal(control.callback(true), "native");
  assert.equal(branch.mode, 0);
  control.value = false;
  promoted.value = false;
  control.callback(false);
  assert.equal(branch.mode, 4);
  assert.equal(unrelated.mode, 4);
  assert.equal(calls(), 2);
});

test("restoring a saved checkbox synchronizes the branch after graph configuration", () => {
  const { node, control, promoted, branch } = fixture();
  control.value = true;
  promoted.value = true;
  node.onGraphConfigured();
  assert.equal(branch.mode, 0);
  control.value = false;
  promoted.value = false;
  node.onGraphConfigured();
  assert.equal(branch.mode, 4);
});


test("disconnecting the Boolean wire stops it controlling the branch", () => {
  const { node, control, promoted, branch } = fixture();
  node.outputs[0].links = [];
  control.value = true;
  promoted.value = true;
  control.callback(true);
  assert.equal(branch.mode, 4);
});


test("the grouped face checkbox controls bypass without invoking the inner callback", () => {
  const { node, control, promoted, branch, calls } = fixture();
  promoted.value = true;
  assert.equal(promoted.callback(true), "promoted");
  assert.equal(branch.mode, 0);
  assert.equal(control.value, false);
  node.onGraphConfigured();
  assert.equal(branch.mode, 0);
  promoted.value = false;
  promoted.callback(false);
  assert.equal(branch.mode, 4);
  assert.equal(calls(), 0);
});


test("prompt compilation synchronizes a changed checkbox even when its callback never runs", async () => {
  const { root, promoted, branch, unrelated, calls } = fixture();
  const app = {
    rootGraph: root,
    graphToPrompt() {
      assert.equal(this, app);
      return Promise.resolve({ mode: branch.mode });
    },
  };
  loadExtension(app).setup();
  promoted.value = true;
  assert.equal(branch.mode, 4);
  assert.deepEqual(await app.graphToPrompt(), { mode: 0 });
  promoted.value = false;
  assert.deepEqual(await app.graphToPrompt(), { mode: 4 });
  assert.equal(unrelated.mode, 4);
  assert.equal(calls(), 0);
});

test("prompt compilation uses its explicit graph and installs the hook only once", () => {
  const { root, promoted, branch } = fixture();
  const token = {};
  const result = {};
  const app = {
    rootGraph: { _nodes: [] },
    graphToPrompt(graph, option) {
      assert.equal(this, app);
      assert.equal(graph, root);
      assert.equal(option, token);
      assert.equal(branch.mode, 0);
      return result;
    },
  };
  const extension = loadExtension(app);
  extension.setup();
  const hook = app.graphToPrompt;
  extension.setup();
  assert.equal(app.graphToPrompt, hook);
  promoted.value = true;
  assert.equal(app.graphToPrompt(root, token), result);
});

test("a disconnected branch control blocks compilation with an actionable error; reconnecting repairs it", () => {
  const { root, node, promoted, branch } = fixture();
  let compiled = 0;
  const app = { graph: root, graphToPrompt() { compiled++; } };
  loadExtension(app).setup();
  const links = node.outputs[0].links;
  node.outputs[0].links = [];
  promoted.value = true;
  assert.throws(() => app.graphToPrompt(), /Reference transcription: no connected Boolean.*Reconnect/);
  assert.equal(compiled, 0);
  node.outputs[0].links = links;
  app.graphToPrompt();
  assert.equal(compiled, 1);
  assert.equal(branch.mode, 0);
});
