// Save YuE2 FLAC + ABC shows the score it saved. The score is kept in the node's
// properties, so it is part of the workflow embedded in the FLAC; opening that
// workflow shows it again. Preview it, or reuse it as-is as the reference.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { pickTarget, scoreViews, showScore, useReference } from "./song_history.js";

const NODE = "bno84.SaveYuE2Bundle";
export const SAVED_ABC = "yue2_abc";

// A one-line summary such as "12 bars · 158 BPM · 4/4 · Bm", from the kit's
// score parser on the server. Cached per score; "" when it cannot be read.
const labels = new Map();
export function scoreLabel(abc, fetchApi = (...args) => api.fetchApi(...args)) {
  if (!abc) return Promise.resolve("");
  if (!labels.has(abc)) {
    const request = fetchApi("/yue2-kit/score/label", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ abc: [abc] }),
    }).then((response) => response.ok ? response.json() : null)
      .then((data) => data?.labels?.[0] ?? "")
      .catch(() => { labels.delete(abc); return ""; });
    labels.set(abc, request);
  }
  return labels.get(abc);
}

// The last score in an executed output; a list run reports one per item.
export function executedScore(output) {
  const scores = output?.[SAVED_ABC];
  const abc = Array.isArray(scores) ? scores.at(-1) : null;
  return typeof abc === "string" ? abc : null;
}

const rootGraph = () => app.rootGraph ?? app.graph;

function styles() {
  if (document.getElementById("yue2-saved-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-saved-style";
  style.textContent = `
.yue2-saved {box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;min-height:0;color:var(--input-text,#ddd);font:12px/1.45 sans-serif;padding:4px;}
.yue2-saved [hidden] {display:none!important;}
.yue2-saved button {font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:4px 8px;cursor:pointer;white-space:nowrap;}
.yue2-saved button:disabled {opacity:.45;cursor:default;}
.yue2-saved button.primary {background:var(--p-button-primary-background,#405c83);border-color:transparent;color:var(--p-button-primary-color,#fff);}
.yue2-saved > :not(textarea) {flex:none;}
.yue2-saved .s-summary {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.yue2-saved .s-summary b {font-weight:600;}
.yue2-saved .muted {opacity:.65;}
.yue2-saved .s-actions {display:flex;gap:6px;flex-wrap:wrap;}
.yue2-saved button.s-disclosure {display:flex;align-items:center;gap:4px;width:100%;padding:2px 0;border:none;border-top:1px solid var(--border-color,#444);border-radius:0;background:none;text-align:left;}
.yue2-saved .s-disclosure svg {width:12px;height:12px;flex:none;transition:transform .15s;}
.yue2-saved .s-disclosure[aria-expanded=true] svg {transform:rotate(90deg);}
.yue2-saved textarea {flex:1;min-height:0;resize:none;box-sizing:border-box;width:100%;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:inherit;background:var(--comfy-input-bg,#252525);border:1px solid var(--border-color,#555);border-radius:4px;padding:4px;}
.yue2-saved .s-status {overflow-wrap:anywhere;}
.yue2-saved .s-status:empty {display:none;}
.yue2-saved .s-status[data-error=true] {color:#ff9d9d;}
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

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "M9 6 15 12 9 18");
  for (const [name, value] of Object.entries({fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round"})) {
    path.setAttribute(name, value);
  }
  svg.append(path);
  return svg;
}

export class SavedScorePanel {
  constructor(node) {
    this.node = node;
    this.expanded = false;
    styles();
    this.root = element("div", "yue2-saved");
    this.root.dataset.captureWheel = "true";
    this.summary = element("div", "s-summary");
    this.preview = button("Show in ABC Preview", () => this.show());
    this.preview.title = "Show the saved score in ABC Preview and ABC Timeline.";
    this.use = button("Use as reference", (event) => this.useAsReference(event), "primary");
    this.use.title = "Load the saved score as-is as the reference, with opening and continuation off (Extend off for Reference input).";
    this.toggle = button("", () => this.setExpanded(!this.expanded), "s-disclosure");
    this.toggle.append(chevron(), "Embedded ABC");
    this.toggle.title = "Show the raw ABC text, read-only.";
    const actions = element("div", "s-actions");
    actions.append(this.preview, this.use);
    this.text = element("textarea");
    this.text.readOnly = true;
    this.text.spellcheck = false;
    this.text.setAttribute("aria-label", "Saved ABC score");
    this.status = element("div", "s-status");
    this.root.append(actions, this.summary, this.toggle, this.text, this.status);
    for (const event of ["pointerdown", "mousedown", "keydown", "wheel"]) this.root.addEventListener(event, (e) => e.stopPropagation());
    this.widget = node.addDOMWidget("saved_score", "saved_score", this.root, {
      serialize: false, hideInPanel: true, hideOnZoom: false,
      getMinHeight: () => this.expanded ? 300 : 110,
    });
    this.widget.serialize = false;
    this.widget.options.serialize = false;
    this.render();
  }

  get abc() {
    const abc = this.node.properties?.[SAVED_ABC];
    return typeof abc === "string" ? abc : "";
  }

  set(abc) {
    this.node.properties ??= {};
    this.node.properties[SAVED_ABC] = abc;
    this.message("");
    this.render();
  }

  render() {
    const abc = this.abc;
    if (abc) {
      this.summary.replaceChildren(element("b", "", "Saved score"));
      this.summary.title = "The score this node last saved. It is embedded in the saved FLAC's workflow.";
      scoreLabel(abc).then((label) => { if (label && this.abc === abc) this.summary.append(` · ${label}`); });
    } else {
      this.summary.replaceChildren(element("span", "muted", "No saved score. Run the workflow, or open a FLAC this node saved."));
      this.summary.title = "";
    }
    this.text.value = abc;
    this.text.hidden = !this.expanded;
    this.toggle.setAttribute("aria-expanded", String(this.expanded));
    for (const control of [this.preview, this.use, this.toggle]) control.disabled = !abc;
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  setExpanded(expanded) {
    this.expanded = expanded;
    this.render();
    this.fit();
  }

  // Extra height would be split between the DOM widgets as blank space, so the
  // collapsed node fits its contents; the open ABC keeps any larger size.
  fit() {
    const height = this.node.computeSize?.()[1];
    if (!height) return;
    this.node.setSize([this.node.size[0], this.expanded ? Math.max(this.node.size[1], height) : height]);
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  message(text, error = false) {
    this.status.textContent = text;
    this.status.dataset.error = String(error);
  }

  async show() {
    const views = scoreViews(rootGraph());
    if (!views.length) return this.message("Add an ABC Preview or ABC Timeline node to the workflow.", true);
    try {
      await showScore(views, this.abc);
      this.message("");
    } catch (error) { this.message(error.message ?? String(error), true); }
  }

  useAsReference(event) {
    const abc = this.abc;
    return pickTarget(event, target => {
      try {
        useReference(target.node, abc, true);
        this.message("");
      } catch (error) { this.message(error.message ?? String(error), true); }
    }, (text, error) => this.message(text, error));
  }
}

app.registerExtension({
  name: "bno84.SavedScore",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const panel = new SavedScorePanel(node);
    node.yue2SavedScore = panel;
    const configure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = configure?.apply(this, args);
      panel.render();
      requestAnimationFrame(() => panel.fit());
      return result;
    };
    // Once the whole workflow is loaded, show the saved score in its previews.
    const graphConfigured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) {
      const result = graphConfigured?.apply(this, args);
      if (panel.abc) showScore(scoreViews(rootGraph()), panel.abc).catch(error => panel.message(error.message ?? String(error), true));
      return result;
    };
    const executed = node.onExecuted;
    node.onExecuted = function (output, ...args) {
      const result = executed?.call(this, output, ...args);
      const abc = executedScore(output);
      if (abc !== null) panel.set(abc);
      return result;
    };
  },
});
