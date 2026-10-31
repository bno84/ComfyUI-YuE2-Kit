// Shared bar geometry, palette and labels for Score and Song history.
export const SECTION_PALETTE = {intro:"#7f77dd",verse:"#d4552b",interlude:"#1d9e75",chorus:"#d4537e",bridge:"#ba7517",outro:"#378add",hook:"#d4537e",melody:"#409494"};
export const sectionColor = label => SECTION_PALETTE[label?.toLowerCase().replace(/[\s\d]+$/, "")] ?? (label ? "#639922" : "#666");
const el = (tag, cls, text) => { const e=document.createElement(tag); e.className=cls; if (text != null) e.textContent=text; return e; };
export function shortLabel(label, width) {
  const variants = {Opening:["Opening","Open"],Continuation:["Continuation","Continue","Next"],
    chorus:["chorus","Ch."],verse:["verse","V."],interlude:["interlude","Inter.","I."],bridge:["bridge","Br."],intro:["intro","In."],outro:["outro","Out."]};
  return (variants[label] ?? [label, label?.split(/\s+/)[0]]).find(s => s && s.length*6.5 <= width-16) ?? "";
}
export function durationLabel(seconds) {
  if (seconds == null) return "";
  const n=Math.round(seconds); return `≈${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;
}
export function barAxis(total) {
  const axis=el("div","yue2-bar-axis");
  axis.style.cssText="position:relative;height:17px;font:10px/16px sans-serif;color:#aab7c5;flex-shrink:0";
  const render=()=>{
    axis.replaceChildren();
    const width=axis.clientWidth || 500;
    const step=[1,2,4,8,16,32,64,128,256].find(s=>total/s<=width/35) ?? 512;
    for(let bar=0;bar<total;bar+=step){
      const tick=el("span","",String(bar+1));
      tick.style.cssText=`position:absolute;left:${100*bar/total}%;border-left:1px solid #aab7c566;padding-left:3px`;
      axis.append(tick);
    }
  };
  render(); observeSize(axis,render); return axis;
}
// Observers are tied to the element, and disconnected on replacement by callers.
export function observeSize(element, callback) {
  if (typeof ResizeObserver === "undefined") return;
  const observer=new ResizeObserver(callback); observer.observe(element);
  element.yue2Observer=observer;
}
export function releaseStrip(root) {
  root?.yue2Observer?.disconnect();
  for(const child of root?.querySelectorAll?.("*") ?? []) child.yue2Observer?.disconnect();
}
export function fillStrip(track, segments, total, {color=sectionColor, compact=false, details=true, grid=true}={}) {
  track.style.position="relative";
  track.style.height=compact ? "16px" : "38px";
  track.style.background="#202730"; track.style.borderRadius="3px";
  track.style.userSelect="none"; track.style.touchAction="none";
  for(const segment of segments){
    const block=el("div","yue2-bar-segment");
    const base = segment.color ?? color(segment.label);
    const background = segment.fade ? `linear-gradient(to right,${base} 0%,transparent 65%)` : base;
    block.style.cssText=`position:absolute;left:${100*segment.bar/total}%;width:${100*segment.bars/total}%;height:100%;box-sizing:border-box;background:${background};border-right:${segment.fade ? "none" : "1px solid #ffffff55"};padding:${compact ? "0" : "2px"} 8px;overflow:hidden;color:#fff;font:11px/16px sans-serif;white-space:nowrap`;
    if (segment.generated) block.style.border = "1px dotted #d6dce4";
    const label=el("div","yue2-bar-label"), detail=el("div","yue2-bar-count");
    label.style.fontWeight="600"; detail.style.cssText="font:10px/14px sans-serif;color:#f0f0f0";
    block.append(label); if(!compact && details) block.append(detail);
    const fit=()=>{
      const width=block.clientWidth || (track.clientWidth || 500)*segment.bars/total;
      const padding=width<70 ? 4 : 8;
      block.style.padding=`${compact ? 0 : 2}px ${padding}px`;
      label.textContent=shortLabel(segment.label || "Unnamed",width+(8-padding)*2);
      const full=segment.unknown ? "model decides" : `${segment.bars} bars${segment.seconds==null ? "" : ` · ${durationLabel(segment.seconds)}`}`;
      detail.textContent=full.length*5.3<=width-16 ? full : (segment.unknown ? "? bars" : `${segment.bars} ${width>=55 ? "bars" : "b"}`);
      if(width<30) detail.textContent="";
    };
    fit(); observeSize(block,fit);
    block.title=`${segment.label || "Unnamed"} · ${segment.unknown ? "model decides" : `${segment.bars} bars`}${segment.seconds==null ? "" : ` · ${durationLabel(segment.seconds)}`}`;
    track.append(block);
  }
  // Compact strips are overviews; bar lines there are only noise.
  if(compact || !grid) return;
  const lines=el("div","yue2-bar-grid");
  lines.style.cssText=`position:absolute;inset:0;background:repeating-linear-gradient(to right,transparent 0 calc(${100/total}% - 1px),#0002 calc(${100/total}% - 1px) ${100/total}%);pointer-events:none`;
  track.append(lines);
}
export function selectionOverlay(track) {
  const outline=el("div","yue2-bar-selection");
  outline.style.cssText="position:absolute;top:0;bottom:0;box-sizing:border-box;border:2px solid #edf5ff;border-radius:2px;box-shadow:0 0 0 2000px #0008;pointer-events:none";
  const handles=[0,1].map(side=>{
    const handle=el("span","yue2-bar-handle");
    handle.title=side ? "Drag last bar" : "Drag first bar";
    handle.style.cssText=`position:absolute;${side ? "right" : "left"}:-2px;top:0;width:4px;height:100%;border-radius:2px;background:#edf5ff;cursor:ew-resize;pointer-events:auto`;
    outline.append(handle); return handle;
  });
  // The parent clips the dimming shadow at its own edges.
  track.style.overflow="hidden"; track.append(outline); return {outline,handles};
}
export function keyWords(key) {
  if(!key) return "model";
  const match=key.match(/^([A-G][#b]?)(.*)$/);
  if(!match) return key;
  const suffix=match[2].trim();
  return `${match[1]} ${/^m(in(or)?)?$/i.test(suffix) ? "minor" : !suffix || /^maj(or)?$/i.test(suffix) ? "major" : suffix}`;
}
export function sourceSummary(source, start, end) {
  if(!source?.bars) return "Paste ABC or Transcribe now";
  const fields=source.fields ?? {};
  return `${source.bars} bars · ${fields.M || "4/4"} · ${source.anchor_bpm ?? source.bpm} BPM · ${keyWords(fields.K)} · ${source.voices} ${source.voices===1 ? "voice" : "voices"} · bars ${start}–${end} of ${source.bars}`;
}
