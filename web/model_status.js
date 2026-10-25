// List the pack's known model files, styled like a workflow note: installed
// files by their found path, missing ones with where to get and save them.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "bno84.ModelStatus";

// Plain data, so the wording can be tested without a DOM.
export function describeModel(model) {
  const base = { label: model.label, use: model.use, license: model.license };
  if (model.installed) return { ...base, installed: true, file: model.installed };
  return {
    ...base, installed: false, file: model.filename, folder: `ComfyUI/models/${model.folder}/`,
    link: { href: model.url, text: model.link_text },
  };
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

function item(model) {
  const info = describeModel(model);
  const li = element("li");
  li.append(element("strong", `${info.label}: `));
  if (info.installed) {
    li.append(element("span", "✓ installed as ", "state-ok"), element("code", info.file));
    if (info.license) li.append(element("br"), element("em", info.license));
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
  li.append(element("br"), element("span", info.use, "use"));
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
      serialize: false, canvasOnly: true, hideOnZoom: false,
      getMinHeight: () => 140,
    });
    this.widget.serialize = false;
    void this.refresh();
  }

  async refresh() {
    this.note.textContent = "Checking…";
    try {
      const response = await api.fetchApi("/yue2-kit/models");
      if (!response.ok) throw new Error(String(response.status));
      const models = await response.json();
      if (this.destroyed) return;
      this.list.replaceChildren(...models.map(item));
      this.note.textContent = "";
      requestAnimationFrame(() => this.fit());
    } catch {
      if (this.destroyed) return;
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

  destroy() { this.destroyed = true; this.root.remove(); }
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
