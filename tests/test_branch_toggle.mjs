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

function fixture() {
  const workflow = JSON.parse(readFileSync(new URL("../example_workflows/yue2-kit-song.json", import.meta.url), "utf8"));
  const controls = workflow.nodes.find((node) => node.id === 33);
  assert.equal(controls.type, "bno84.ReferenceInput");
  assert.equal(controls.outputs.length, 5);
  assert.ok(controls.outputs.every((output) => output.links.length));
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
      node.comfyClass = node.type;
      if (definitions.has(node.type)) {
        node.subgraph = graphFrom(definitions.get(node.type), graph.rootGraph);
        node.widgets = Object.entries(node.widgets_values_named ?? {}).map(([name, value]) => ({ name, value }));
      }
      else if (node.type === "bno84.LyricsStyle") {
        node.widgets = ["instrumental", "lyrics", "style"].map((name, index) => ({ name, value: node.widgets_values[index] }));
      } else if (node.type === "CustomCombo") {
        node.widgets = Object.entries(node.widgets_values_named).map(([name, value]) => ({ name, value }));
      } else if (node.type === "ComfyMathExpression") node.widgets = [{ name: "expression", value: node.widgets_values[0] }];
      else if (node.type === "PrimitiveBoolean") node.widgets = [{ name: "value", value: node.widgets_values[0] }];
    }
    return graph;
  }
  const root = graphFrom(workflow);
  const host = root.getNodeById(controls.id);
  host.widgets = [{ name: "source", value: "None" }, { name: "abc", value: "" }, { name: "audio", value: "" }, { name: "extend", value: false }];
  const reference = root.getNodeById(30).subgraph.getNodeById(36);
  const transcription = reference.subgraph.getNodeById(40);
  const unrelated = { mode: 4, properties: {} };
  root._nodes.push(unrelated);
  const app = { rootGraph: root, graphToPrompt() { return [reference.mode, transcription.mode]; } };
  const extension = loadExtension(app);
  extension.nodeCreated(host);
  host.onGraphConfigured();
  extension.setup();
  return { root, host, reference, transcription, unrelated, app, extension };
}

for (const [choice, extend, expected] of [
  ["None", false, [4, 4]],
  ["None", true, [4, 4]],
  ["Transcribe", false, [0, 0]],
  ["Transcribe", true, [0, 0]],
  ["ABC", false, [0, 4]],
  ["ABC", true, [0, 4]],
]) {
  test(`${choice}, extend=${extend}: compilation repairs modes without widget callbacks`, () => {
    const { host, reference, transcription, unrelated, app } = fixture();
    host.widgets[0].value = choice;
    host.widgets[3].value = extend;
    reference.mode = 2;
    transcription.mode = 2;
    assert.deepEqual(app.graphToPrompt(), expected);
    assert.equal(unrelated.mode, 4);
  });
}

test("the unified source field updates both bypass blocks live", () => {
  const { host, app } = fixture();
  host.widgets[0].value = "Transcribe";
  host.widgets[0].callback();
  assert.deepEqual(app.graphToPrompt(), [0, 0]);
  host.widgets[0].value = "ABC";
  host.widgets[0].callback();
  assert.deepEqual(app.graphToPrompt(), [0, 4]);
});

test("setup is idempotent and compilation respects an explicit graph, arguments and return value", () => {
  const { root, host } = fixture();
  host.widgets[0].value = "ABC";
  const token = {}, result = {};
  const app = { rootGraph: { _nodes: [] }, graphToPrompt(graph, argument) {
    assert.equal(this, app); assert.equal(graph, root); assert.equal(argument, token);
    assert.equal(root.getNodeById(30).subgraph.getNodeById(36).mode, 0);
    return result;
  } };
  const extension = loadExtension(app);
  extension.setup(); const hook = app.graphToPrompt;
  extension.setup(); assert.equal(app.graphToPrompt, hook);
  assert.equal(app.graphToPrompt(root, token), result);
});

test("disconnecting a routing flag blocks compilation; reconnecting repairs it", () => {
  const { host, app } = fixture();
  const links = host.outputs[2].links;
  host.outputs[2].links = [];
  assert.throws(() => app.graphToPrompt(), /Reference score: no connected Boolean.*Reconnect/);
  host.outputs[2].links = links;
  assert.deepEqual(app.graphToPrompt(), [4, 4]);
});

test("invalid reference modes cannot silently set bypass", () => {
  const { host, app } = fixture();
  host.widgets[0].value = "invalid";
  assert.throws(() => app.graphToPrompt(), /no connected Boolean/);
});


test("compilation waits for reference file loading to finish", () => {
  const { host, app } = fixture();
  host.isUploading = true;
  assert.throws(() => app.graphToPrompt(), /wait for the file to finish loading/);
  host.isUploading = false;
  assert.deepEqual(app.graphToPrompt(), [4, 4]);
});

for (const enabled of [false, true]) {
  test(`instrumental=${enabled}: compilation repairs LoRA bypass from the prompt control`, () => {
    const { root, app } = fixture();
    const song = root.getNodeById(32);
    const models = root.getNodeById(34);
    const lora = models.subgraph.getNodeById(47);
    song.widgets.find((widget) => widget.name === "instrumental").value = enabled;
    lora.mode = 2;
    app.graphToPrompt();
    assert.equal(lora.mode, enabled ? 0 : 4);
  });
}

test("instrumental prompt control updates LoRA bypass live and preserves lyrics", () => {
  const { root, extension } = fixture();
  const song = root.getNodeById(32);
  const lora = root.getNodeById(34).subgraph.getNodeById(47);
  const lyrics = song.widgets.find((widget) => widget.name === "lyrics").value;
  extension.nodeCreated(song);
  song.onGraphConfigured();
  const toggle = song.widgets.find((widget) => widget.name === "instrumental");
  for (const enabled of [true, false]) {
    toggle.value = enabled;
    toggle.callback();
    assert.equal(lora.mode, enabled ? 0 : 4);
    assert.equal(song.widgets.find((widget) => widget.name === "lyrics").value, lyrics);
  }
});

test("disconnecting the instrumental flag blocks compilation", () => {
  const { root, app } = fixture();
  root.getNodeById(32).outputs[2].links = [];
  assert.throws(() => app.graphToPrompt(), /Instrumental LoRA: no connected Boolean/);
});
