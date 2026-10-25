import { app } from "../../scripts/app.js";

const NODE = "bno84.LyricsStyle";
const GUIDE = "https://huggingface.co/Mothersuperior/YuE2-instrumental-cot-full-loras#prompting-three-caption-styles";
const FORMAT = "Use [instrumental], lowercase section tags, or timed tags like [intro 0:00-0:15], one per line.";

// The model card defines three caption forms. Style remains ordinary YuE2 tags;
// it has no formal grammar, so do not invent restrictions for that field.
export function instrumentalPromptWarning(instrumental, lyrics) {
  if (!instrumental) return "";
  const text = (lyrics ?? "").trim();
  if (text === "[instrumental]") return "";
  if (!text) return `Instrumental section plan is empty. ${FORMAT}`;
  if (text.includes("\\n")) return `Use real line breaks, not literal \\n characters. ${FORMAT}`;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const sections = lines.map((line) => /^\[(intro|verse|pre-chorus|chorus|bridge|outro)(?: (\d+):([0-5]\d)-(\d+):([0-5]\d))?\]$/.exec(line.trim()));
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

export function refreshPromptWarning(node) {
  const value = (name) => node.widgets?.find((widget) => widget.name === name)?.value;
  const warning = instrumentalPromptWarning(value("instrumental"), value("lyrics"));
  node.instrumentalPromptWarning = warning;
  const lyrics = node.widgets?.find((widget) => widget.name === "lyrics");
  const element = lyrics?.element;
  if (element) {
    element.style.outline = warning ? "2px solid #ffb74d" : "";
    element.style.outlineOffset = warning ? "-2px" : "";
    if (warning) element.setAttribute("aria-invalid", "true");
    else element.removeAttribute("aria-invalid");
  }
  if (node.instrumentalWarningElement) {
    node.instrumentalWarningElement.hidden = !warning;
    node.instrumentalWarningElement.firstChild.textContent = warning ? `⚠ ${warning} ` : "";
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return warning;
}

app.registerExtension({
  name: "bno84.LyricsStyle",
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const status = document.createElement("div");
    status.style.cssText = "box-sizing:border-box;width:100%;padding:4px 8px;color:#ffb74d;font:12px/1.4 sans-serif;overflow-wrap:anywhere;";
    status.setAttribute("role", "status");
    status.append(document.createTextNode(""));
    const guide = document.createElement("a");
    guide.href = GUIDE;
    guide.target = "_blank";
    guide.rel = "noopener noreferrer";
    guide.textContent = "Prompt guide";
    guide.style.color = "inherit";
    status.append(guide);
    node.instrumentalWarningElement = status;
    const warningWidget = node.addDOMWidget("instrumental_warning", "instrumental_warning", status, {
      serialize: false, canvasOnly: true, hideOnZoom: false,
      getMinHeight: () => node.instrumentalPromptWarning ? 70 : 0,
    });
    warningWidget.serialize = false;
    for (const widget of node.widgets ?? []) {
      if (!["instrumental", "lyrics", "style"].includes(widget.name)) continue;
      const callback = widget.callback;
      widget.callback = function (...args) {
        const result = callback?.apply(this, args);
        refreshPromptWarning(node);
        return result;
      };
      // Native multiline widgets update their value before the input event bubbles.
      widget.element?.addEventListener("input", () => refreshPromptWarning(node));
    }
    const configured = node.onGraphConfigured;
    node.onGraphConfigured = function (...args) {
      const result = configured?.apply(this, args);
      refreshPromptWarning(this);
      return result;
    };
    const draw = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
      const result = draw?.call(this, ctx, ...args);
      // Also refresh after programmatic widget edits that omit callbacks.
      const current = instrumentalPromptWarning(
        this.widgets.find((widget) => widget.name === "instrumental")?.value,
        this.widgets.find((widget) => widget.name === "lyrics")?.value,
      );
      if (current !== this.instrumentalPromptWarning) refreshPromptWarning(this);
      if (current && !this.flags?.collapsed) {
        ctx.save();
        ctx.strokeStyle = "#ffb74d";
        ctx.lineWidth = 2;
        ctx.strokeRect(-2, -32, this.size[0] + 4, this.size[1] + 34);
        ctx.restore();
      }
      return result;
    };
    const removed = node.onRemoved;
    node.onRemoved = function (...args) {
      status.remove();
      return removed?.apply(this, args);
    };
    refreshPromptWarning(node);
  },
});
