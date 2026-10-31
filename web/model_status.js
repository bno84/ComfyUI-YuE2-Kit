// List the files the workflow's file nodes select, styled like a workflow
// note. A node's own metadata (ComfyUI's "models" entry plus bno84.model)
// describes its default file; other selections get only name and folder.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "bno84.ModelStatus";
const DETAILS = "bno84.model";

const baseName = (name) => String(name).split(/[\\/]/).pop();

// A Hugging Face file URL links to its model page, named after the repository.
export function sourcePage(url) {
  const parsed = new URL(url);
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === "huggingface.co" && owner && repo) {
    return { href: `https://huggingface.co/${owner}/${repo}`, text: `${owner}/${repo}` };
  }
  return { href: url, text: parsed.hostname };
}

// Plain data, so the wording can be tested without a DOM. entry: the file
// node's title, properties and selected name, plus the server's lookup.
export function describeModel({ title, properties, selected, folder, installed }) {
  const details = properties?.[DETAILS] ?? {};
  const model = properties?.models?.[0];
  const base = { label: details.label ?? title, use: details.use ?? "" };
  if (!model || baseName(selected) !== model.name) {
    // Not the described default: do not attach its source or license.
    return { ...base, installed: !!installed, file: installed ?? selected, folder: `ComfyUI/models/${folder}/` };
  }
  if (installed) return { ...base, installed: true, file: installed, license: details.license };
  return {
    ...base, installed: false, file: model.name, folder: `ComfyUI/models/${model.directory}/`,
    link: sourcePage(model.url), license: details.license, described: true,
  };
}

// File nodes in compiled prompt order, with execution IDs such as "34:53".
export function selectedFiles(root, output) {
  const found = [];
  (function visit(graph, prefix, seen) {
    if (!graph || seen.has(graph)) return;
    const next = new Set(seen).add(graph);
    for (const node of graph._nodes ?? []) {
      const id = prefix + node.id;
      const compiled = output[id];
      if (compiled?.class_type?.startsWith("bno84.") && typeof compiled.inputs?.name === "string") {
        found.push({ id, type: compiled.class_type, title: node.title, properties: node.properties, selected: compiled.inputs.name });
      }
      if (node.subgraph) visit(node.subgraph, id + ":", next);
    }
  })(root, "", new Set());
  return found;
}

function styles() {
  if (document.getElementById("yue2-model-status-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-model-status-style";
  style.textContent = `
.yue2-models {box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:4px 10px;color:var(--input-text,#ddd);font:13px/1.45 sans-serif;}
.yue2-models ul {margin:0;padding-left:18px;}
.yue2-models li {margin:0 0 8px;}
.yue2-models code {font:12px monospace;overflow-wrap:anywhere;}
.yue2-models a {color:#e6b6ff;}
.yue2-models .state-ok {color:#a5d6a7;}
.yue2-models .state-missing {color:#ffb74d;}
.yue2-models .use {opacity:.8;}
.yue2-models button {font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:3px 8px;cursor:pointer;}
.yue2-models .note {opacity:.8;margin-left:6px;}
`;
  document.head.append(style);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function item(entry) {
  const info = describeModel(entry);
  const li = element("li");
  li.append(element("strong", `${info.label}: `));
  if (info.installed) {
    li.append(element("span", "✓ installed as ", "state-ok"), element("code", info.file));
    if (info.license) li.append(element("br"), element("em", info.license));
  } else if (!info.described) {
    li.append(element("span", "✗ not found", "state-missing"), element("br"), element("code", info.file));
    li.append(element("br"), "Looked in ", element("code", info.folder), " and its subfolders");
  } else {
    li.append(element("span", "✗ not installed", "state-missing"), element("br"));
    const link = element("a", info.link.text);
    link.href = info.link.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    li.append(link);
    if (info.license) li.append(element("br"), element("em", info.license));
    li.append(element("br"), "Download ", element("code", info.file));
    li.append(element("br"), "Save in ", element("code", info.folder));
  }
  if (info.use) li.append(element("br"), element("span", info.use, "use"));
  return li;
}

class ModelStatusPanel {
  constructor(node) {
    this.node = node;
    styles();
    this.root = element("div", undefined, "yue2-models");
    this.list = element("ul");
    this.button = element("button", "Check again");
    this.button.type = "button";
    this.button.onclick = () => this.refresh();
    this.note = element("span", "", "note");
    this.note.setAttribute("role", "status");
    const row = element("div");
    row.append(this.button, this.note);
    this.root.append(this.list, row);
    this.widget = node.addDOMWidget("model_status", "model_status", this.root, {
      serialize: false, hideInPanel: true, hideOnZoom: false,
      getMinHeight: () => 140,
    });
    this.widget.serialize = false;
    // Follow selection changes; graphChanged also fires for unrelated edits.
    this.onGraphChanged = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(false), 500);
    };
    api.addEventListener("graphChanged", this.onGraphChanged);
    this.onGraphChanged();
  }

  async refresh(force = true) {
    const root = this.node.graph?.rootGraph ?? this.node.graph;
    let files;
    try {
      files = selectedFiles(root, (await app.graphToPrompt(root)).output);
    } catch {
      return; // e.g. while a reference upload blocks compilation; try again on the next change.
    }
    const key = JSON.stringify(files.map((file) => [file.id, file.selected]));
    if (this.destroyed || (!force && key === this.key)) return;
    this.key = key;
    this.note.textContent = "Checking…";
    try {
      const response = await api.fetchApi("/yue2-kit/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(files.map(({ type, selected }) => ({ type, name: selected }))),
      });
      if (!response.ok) throw new Error(String(response.status));
      const lookups = await response.json();
      if (this.destroyed) return;
      const entries = files.flatMap((file, index) => lookups[index] ? [{ ...file, ...lookups[index] }] : []);
      this.list.replaceChildren(...entries.map(item));
      this.note.textContent = entries.length ? "" : "No model file nodes in this workflow.";
      requestAnimationFrame(() => this.fit());
    } catch {
      if (this.destroyed) return;
      this.key = undefined;
      this.note.textContent = "Cannot read model status. Restart ComfyUI after updating YuE2-Kit.";
    }
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  // Grow to show every entry; never shrink a size the user chose.
  fit() {
    const extra = this.root.scrollHeight - this.root.clientHeight;
    if (this.destroyed || extra <= 0 || !this.root.clientHeight) return;
    this.node.setSize([this.node.size[0], this.node.size[1] + extra]);
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    api.removeEventListener("graphChanged", this.onGraphChanged);
    this.root.remove();
  }
}

app.registerExtension({
  name: "bno84.ModelStatus",
  beforeRegisterNodeDef(nodeType, nodeData) {
    // Display only: keep it out of compiled and exported prompts.
    if (nodeData.name === NODE) nodeType.prototype.isVirtualNode = true;
  },
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const panel = new ModelStatusPanel(node);
    const removed = node.onRemoved;
    node.onRemoved = function (...args) { panel.destroy(); return removed?.apply(this, args); };
  },
});
