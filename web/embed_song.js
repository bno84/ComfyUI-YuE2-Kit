// Embed YuE2 Kit song: choosing a FLAC copies the prompt, workflow and score it
// embeds into the node's stored widgets. They stay hidden under a disclosure, so
// the node shows what is stored without three large text boxes. Opening a saved
// workflow keeps the stored copy, even when the FLAC is not on this machine.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { scoreLabel } from "./saved_score.js";
import { scoreViews, showScore } from "./song_history.js";

const NODE = "bno84.EmbedYuE2KitSong";
const STORED = ["song_prompt", "song_workflow", "song_abc"];
export const SOURCE = "yue2_song_source";

// Load Audio's choices can carry a folder annotation, such as "song.flac [output]".
export function songName(path) {
  return (path ?? "").replace(/\s*\[\w+\]$/, "").split("/").pop().replace(/\.flac$/i, "");
}

// What the stored data shows, and a warning when it is from another FLAC than the one chosen.
export function songSummary({ song, source, abc, label = "" }) {
  if (!abc) return { text: "No song data stored. Choose a YuE2-Kit FLAC.", warning: "" };
  const text = `${songName(source) || "Stored song"}${label ? ` · ${label}` : ""}`;
  const warning = source && song && source !== song
    ? `Stored data is from ${songName(source)}, not ${songName(song)}. Choose the FLAC again to store its data.` : "";
  return { text, warning };
}

const rootGraph = () => app.rootGraph ?? app.graph;

function styles() {
  if (document.getElementById("yue2-embed-song-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-embed-song-style";
  style.textContent = `
.yue2-embed-song {box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;color:var(--input-text,#ddd);font:12px/1.45 sans-serif;padding:4px;}
.yue2-embed-song button {font:inherit;color:inherit;cursor:pointer;}
.yue2-embed-song button:disabled {opacity:.45;cursor:default;}
.yue2-embed-song .e-summary {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.yue2-embed-song .e-warning {color:#ffcf7a;}
.yue2-embed-song .e-warning:empty, .yue2-embed-song .e-status:empty {display:none;}
.yue2-embed-song .e-status[data-error=true] {color:#ff9d9d;}
.yue2-embed-song button.e-disclosure {display:flex;align-items:center;gap:4px;width:100%;padding:2px 0;border:none;border-top:1px solid var(--border-color,#444);border-radius:0;background:none;text-align:left;}
.yue2-embed-song .e-disclosure svg {width:12px;height:12px;flex:none;transition:transform .15s;}
.yue2-embed-song .e-disclosure[aria-expanded=true] svg {transform:rotate(90deg);}
`;
  document.head.append(style);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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

export class EmbedSongPanel {
  constructor(node) {
    this.node = node;
    this.expanded = false;
    this.request = 0;
    styles();
    this.root = element("div", "yue2-embed-song");
    this.summary = element("div", "e-summary");
    this.warning = element("div", "e-warning");
    this.toggle = element("button", "e-disclosure");
    this.toggle.type = "button";
    this.toggle.append(chevron(), "Stored song data");
    this.toggle.title = "Show the stored prompt, workflow and score.";
    this.toggle.onclick = (event) => { event.stopPropagation(); this.setExpanded(!this.expanded); };
    this.status = element("div", "e-status");
    this.root.append(this.summary, this.warning, this.toggle, this.status);
    for (const event of ["pointerdown", "mousedown", "keydown"]) this.root.addEventListener(event, (e) => e.stopPropagation());
    this.widget = node.addDOMWidget("song_panel", "song_panel", this.root, {
      serialize: false, hideInPanel: true, hideOnZoom: false, getMinHeight: () => 76,
    });
    this.widget.serialize = false;
    this.widget.options.serialize = false;
    // Show the panel under the audio choice, player and upload, above the stored widgets.
    const widgets = node.widgets;
    widgets.splice(widgets.indexOf(this.widget), 1);
    widgets.splice(widgets.findIndex((w) => STORED.includes(w.name)), 0, this.widget);
    this.setExpanded(false);
  }

  value(name) {
    return this.node.widgets?.find((w) => w.name === name)?.value ?? "";
  }

  render() {
    const abc = this.value("song_abc");
    const show = (label) => {
      const found = songSummary({ song: this.value("audio"), source: this.node.properties?.[SOURCE], abc, label });
      this.summary.textContent = found.text;
      this.summary.title = found.text;
      this.warning.textContent = found.warning;
    };
    show();
    scoreLabel(abc).then((label) => { if (label && this.value("song_abc") === abc) show(label); });
    this.toggle.setAttribute("aria-expanded", String(this.expanded));
    this.toggle.disabled = !this.value("song_abc");
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  // The stored widgets keep their values while hidden; they serialize either way.
  setExpanded(expanded) {
    this.expanded = expanded;
    for (const widget of this.node.widgets ?? []) {
      if (!STORED.includes(widget.name)) continue;
      widget.hidden = !expanded;
      if (widget.element) widget.element.hidden = !expanded;
    }
    this.render();
    const height = this.node.computeSize?.()[1];
    if (height) this.node.setSize([this.node.size[0], expanded ? Math.max(this.node.size[1], height) : height]);
  }

  message(text, error = false) {
    this.status.textContent = text;
    this.status.dataset.error = String(error);
  }

  // Show the stored score in the workflow's ABC Preview and ABC Timeline nodes.
  async showScore() {
    const abc = this.value("song_abc");
    if (abc) await showScore(scoreViews(rootGraph()), abc);
  }

  // Store what the chosen FLAC embeds. A later choice wins over a slower earlier one.
  async store() {
    const song = this.value("audio");
    if (!song) return;
    const request = ++this.request;
    this.message("");
    try {
      const response = await api.fetchApi(`/yue2-kit/song-data?${new URLSearchParams({ audio: song })}`);
      const data = await response.json();
      if (request !== this.request) return;
      if (!response.ok) throw new Error(data.error ?? `Cannot read ${song} (${response.status}).`);
      this.node.graph?.beforeChange?.();
      for (const [name, value] of [["song_prompt", data.prompt], ["song_workflow", data.workflow], ["song_abc", data.abc]]) {
        const widget = this.node.widgets?.find((w) => w.name === name);
        if (!widget) continue;
        widget.value = value;
        widget.callback?.(value);
      }
      this.node.properties ??= {};
      this.node.properties[SOURCE] = song;
      this.node.graph?.afterChange?.();
      await this.showScore();
    } catch (error) {
      if (request === this.request) this.message(error.message ?? String(error), true);
    } finally {
      if (request === this.request) this.render();
    }
  }
}

app.registerExtension({
  name: "bno84.EmbedYuE2KitSong",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const panel = new EmbedSongPanel(node);
    node.yue2EmbedSong = panel;
    // Choosing or uploading a FLAC sets this widget; a saved workflow's configure does not call it.
    const audio = node.widgets?.find((w) => w.name === "audio");
    if (audio) {
      const callback = audio.callback;
      audio.callback = function (...args) {
        const result = callback?.apply(this, args);
        panel.render();
        panel.store();
        return result;
      };
    }
    const configure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = configure?.apply(this, args);
      requestAnimationFrame(() => panel.setExpanded(panel.expanded));
      return result;
    };
    // Once the whole workflow is loaded, show the stored score in its previews.
    const graphConfigured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) {
      const result = graphConfigured?.apply(this, args);
      panel.showScore().catch((error) => panel.message(error.message ?? String(error), true));
      return result;
    };
  },
});
