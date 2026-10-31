import { app } from "../../scripts/app.js";

const NODE = "bno84.LyricsStyle";
const GUIDE = "https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras#prompting-three-caption-styles";
const FORMAT = "Use [instrumental], lowercase section tags, or timed tags like [intro 0:00-0:15], one per line.";
const VARIANTS = ["Base", "Instrumental"];

// Each variant keeps its own lyrics and style; the instrumental flag picks the output pair.
export function variantInput(name, instrumental) {
  return instrumental ? `instrumental_${name}` : name;
}

// The model card defines three caption forms. Style remains ordinary YuE2 tags;
// it has no formal grammar, so do not invent restrictions for that field.
// The card lists six tags; the model also writes [interlude] itself, so allow it.
export function instrumentalPromptWarning(instrumental, lyrics) {
  if (!instrumental) return "";
  const text = (lyrics ?? "").trim();
  if (text === "[instrumental]") return "";
  if (!text) return `Instrumental section plan is empty. ${FORMAT}`;
  if (text.includes("\\n")) return `Use real line breaks, not literal \\n characters. ${FORMAT}`;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const sections = lines.map((line) => /^\[(intro|verse|pre-chorus|chorus|interlude|bridge|outro)(?: (\d+):([0-5]\d)-(\d+):([0-5]\d))?\]$/.exec(line.trim()));
  if (sections.some((section) => !section)) return `Instrumental lyrics should contain only section tags, without sung words or production notes. ${FORMAT}`;
  const timed = sections.filter((section) => section[2] !== undefined);
  if (timed.length && timed.length !== sections.length) return "Use one caption form: all section tags untimed, or all with m:ss-m:ss ranges.";
  for (const section of timed) {
    const start = Number(section[2]) * 60 + Number(section[3]);
    const end = Number(section[4]) * 60 + Number(section[5]);
    if (end <= start) return "Each section's end time should be later than its start time.";
  }
  return "";
}

const valueOf = (node, name) => node.widgets?.find((widget) => widget.name === name)?.value;

// Nodes saved before the variants held one pair. If it was instrumental, it becomes the Instrumental pair.
export function migrateSavedPair(node, info) {
  const named = info?.widgets_values_named;
  const legacy = named ? !("instrumental_lyrics" in named) : (info?.widgets_values?.length ?? 0) <= 3;
  if (!legacy || !valueOf(node, "instrumental")) return false;
  for (const name of ["lyrics", "style"]) {
    const widget = node.widgets?.find((candidate) => candidate.name === variantInput(name, true));
    if (widget) widget.value = valueOf(node, name);
  }
  return true;
}

export function nodeWarning(node) {
  return instrumentalPromptWarning(valueOf(node, "instrumental"), valueOf(node, "instrumental_lyrics"));
}

function styles() {
  if (document.getElementById("yue2-lyrics-style")) return;
  const style = document.createElement("style");
  style.id = "yue2-lyrics-style";
  style.textContent = `
.yue2-lyrics {box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;min-height:0;min-width:0;color:var(--input-text,#ddd);font:13px sans-serif;padding:5px;}
.yue2-lyrics .ls-tabs {display:flex;flex:none;border:1px solid var(--border-color,#555);border-radius:6px;overflow:hidden;}
.yue2-lyrics .ls-tabs button {flex:1;font:inherit;color:inherit;background:var(--comfy-input-bg,#252525);border:0;padding:6px;cursor:pointer;}
.yue2-lyrics .ls-tabs button[aria-selected=true] {background:var(--p-button-primary-background,#405c83);color:var(--p-button-primary-color,#fff);}
/* Lyrics, style and warnings share the height 2:1:1; captions overlay the boxes so they take no share. */
.yue2-lyrics .ls-field {position:relative;display:flex;min-height:0;}
.yue2-lyrics .ls-field span {position:absolute;top:3px;right:8px;font-size:10px;opacity:.55;pointer-events:none;}
.yue2-lyrics .ls-lyrics {flex:2 1 0;}
.yue2-lyrics .ls-style, .yue2-lyrics .ls-note {flex:1 1 0;}
.yue2-lyrics textarea {box-sizing:border-box;width:100%;height:100%;flex:1 1 0;min-height:0;resize:none;background:var(--comfy-input-bg,#1b1b1b);color:inherit;border:1px solid var(--border-color,#555);border-radius:4px;padding:6px;font:12px/1.45 monospace;}
.yue2-lyrics textarea[aria-invalid=true] {outline:2px solid #ffb74d;outline-offset:-2px;}
.yue2-lyrics .ls-warnings {width:100%;height:100%;min-height:0;overflow:auto;font-size:12px;line-height:1.4;overflow-wrap:anywhere;border:1px solid var(--border-color,#555);border-radius:4px;padding:6px;box-sizing:border-box;}
.yue2-lyrics .ls-warnings[data-warning=true] {color:#ffb74d;border-color:#ffb74d;}
.yue2-lyrics .ls-warnings:not([data-warning=true]) {opacity:.6;}
.yue2-lyrics .ls-warnings a {color:inherit;}
`;
  document.head.append(style);
}

class LyricsStylePanel {
  constructor(node) {
    this.node = node;
    styles();
    this.root = document.createElement("div");
    this.root.className = "yue2-lyrics";
    this.root.innerHTML = `
      <div class="ls-tabs" role="tablist" aria-label="Lyrics and style variant">
        <button type="button" role="tab" data-variant="Base">Base</button>
        <button type="button" role="tab" data-variant="Instrumental">Instrumental</button>
      </div>
      <label class="ls-field ls-lyrics"><span>Lyrics</span><textarea aria-label="Lyrics"></textarea></label>
      <label class="ls-field ls-style"><span>Style</span><textarea aria-label="Style" placeholder="genre, instruments, mood, BPM"></textarea></label>
      <div class="ls-field ls-note"><div class="ls-warnings" role="status"></div></div>`;
    [this.lyrics, this.style] = this.root.querySelectorAll("textarea");
    this.warnings = this.root.querySelector(".ls-warnings");
    for (const button of this.root.querySelectorAll("[data-variant]")) {
      button.onclick = () => this.set("instrumental", button.dataset.variant === "Instrumental");
    }
    this.root.querySelector(".ls-tabs").onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const instrumental = event.key === "Home" ? false : event.key === "End" ? true : !this.instrumental();
      this.set("instrumental", instrumental);
      this.root.querySelector(`[data-variant="${VARIANTS[Number(instrumental)]}"]`).focus();
    };
    // Typing edits the active variant only; the other keeps its values.
    this.lyrics.oninput = () => this.set(variantInput("lyrics", this.instrumental()), this.lyrics.value, false);
    this.style.oninput = () => this.set(variantInput("style", this.instrumental()), this.style.value, false);
    for (const event of ["pointerdown", "mousedown", "keydown", "wheel"]) this.root.addEventListener(event, (e) => e.stopPropagation());
    this.widget = node.addDOMWidget("lyrics_style_panel", "lyrics_style_panel", this.root, {
      serialize: false, canvasOnly: true, hideOnZoom: false,
      getMinHeight: () => 320,
    });
    this.widget.serialize = false;
    this.widget.options.serialize = false;
    this.render();
  }

  instrumental() { return !!valueOf(this.node, "instrumental"); }
  set(name, value, render = true) {
    const widget = this.node.widgets.find((widget) => widget.name === name);
    if (!widget) return;
    this.node.graph?.beforeChange?.();
    widget.value = value;
    widget.callback?.(value);
    this.node.graph?.afterChange?.();
    this.node.graph?.setDirtyCanvas(true, true);
    if (render) this.render(); else this.renderWarning();
  }
  // True when widgets changed without the panel, e.g. undo or Song history restore.
  stale() {
    const instrumental = this.instrumental();
    return this.shown !== instrumental || this.warning !== nodeWarning(this.node)
      || this.lyrics.value !== (valueOf(this.node, variantInput("lyrics", instrumental)) ?? "")
      || this.style.value !== (valueOf(this.node, variantInput("style", instrumental)) ?? "");
  }
  render() {
    const instrumental = this.instrumental();
    this.shown = instrumental;
    for (const button of this.root.querySelectorAll("[data-variant]")) {
      const selected = button.dataset.variant === VARIANTS[Number(instrumental)];
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const lyrics = valueOf(this.node, variantInput("lyrics", instrumental)) ?? "";
    const style = valueOf(this.node, variantInput("style", instrumental)) ?? "";
    if (this.lyrics.value !== lyrics) this.lyrics.value = lyrics;
    if (this.style.value !== style) this.style.value = style;
    this.lyrics.placeholder = instrumental ? "[intro]\n[verse]\n[chorus]" : "[verse]\nLyrics…";
    this.renderWarning();
  }
  renderWarning() {
    const warning = nodeWarning(this.node);
    this.warning = this.node.instrumentalPromptWarning = warning;
    this.warnings.dataset.warning = String(!!warning);
    if (warning) this.lyrics.setAttribute("aria-invalid", "true");
    else this.lyrics.removeAttribute("aria-invalid");
    const items = [document.createTextNode(warning ? `⚠ ${warning} ` : "No warnings. ")];
    if (this.instrumental()) {
      const guide = document.createElement("a");
      guide.href = GUIDE; guide.target = "_blank"; guide.rel = "noopener noreferrer"; guide.textContent = "Prompt guide";
      items.push(guide);
    }
    this.warnings.replaceChildren(...items);
    this.node.graph?.setDirtyCanvas?.(true, true);
  }
  destroy() { this.root.remove(); }
}

app.registerExtension({
  name: "bno84.LyricsStyle",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    // The panel edits these widgets; they still serialize and can be converted to inputs.
    for (const widget of node.widgets ?? []) {
      widget.type = "hidden"; widget.hidden = true; widget.computeSize = () => [0, -4];
      widget.options ??= {}; widget.options.hidden = true;
      if (widget.element) widget.element.style.display = "none";
      if (widget.options.getMinHeight) widget.options.getMinHeight = () => 0;
      if (widget.options.getHeight) widget.options.getHeight = () => 0;
    }
    const panel = new LyricsStylePanel(node);
    node.yue2LyricsStylePanel = panel;
    const configure = node.onConfigure;
    node.onConfigure = function (info) { const result = configure?.apply(this, arguments); migrateSavedPair(this, info); panel.render(); return result; };
    const configured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) { const result = configured?.apply(this, args); panel.render(); return result; };
    const draw = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
      const result = draw?.call(this, ctx, ...args);
      if (panel.stale()) panel.render();
      if (this.instrumentalPromptWarning && !this.flags?.collapsed) {
        ctx.save();
        ctx.strokeStyle = "#ffb74d";
        ctx.lineWidth = 2;
        ctx.strokeRect(-2, -32, this.size[0] + 4, this.size[1] + 34);
        ctx.restore();
      }
      return result;
    };
    const removed = node.onRemoved;
    node.onRemoved = function (...args) { panel.destroy(); return removed?.apply(this, args); };
  },
});
