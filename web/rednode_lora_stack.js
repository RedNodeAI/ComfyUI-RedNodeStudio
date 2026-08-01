// RedNode LoRA Stack — slot list UI over the node's stack_json widget.
//
// The native stack_json widget stays the value holder (hidden, still serializes); this
// panel reads it on load and writes it back on every edit. If this file fails to load,
// the node still works by editing that JSON directly.
//
// Row layout (drag handle, enable toggle, searchable picker, slider, expand arrow with an
// inline options row) is inspired by the MIT-licensed NO8D-controls LoRA stack
// (github.com/no8d/ComfyUI-NO8D-controls) — independent implementation.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { nodeById, allNodes } from "./rednode_graph.js";
import { bindSliderWheel } from "./rednode_wheel.js";

const NODE_NAME = "RedNodeLoraStack";
const NO_LORA = "None";
export const CUSTOM_SENTINEL = "custom (use stack)";   // must match lora_stack.py
const ROW_H = 34;          // row height (taller = easier to hit)
const EXP_H = 42;          // expanded options row (border-box: padding included)
const HEAD_H = 32;
const PAD = 8;
const NODE_MIN_W = 540;
// The panel scrolls, so the node is free to be shorter than its contents — this is the
// floor it asks for, NOT the height of every row added up.
const MIN_PANEL_H = 140;
const SCALE_MIN = -2, SCALE_MAX = 2;   // the bar's full extent (typed values may exceed it)

let namesCache = null;
let namesPending = null;
let typesCache = null;          // { "lora name": "Krea 2", ... }
let kindsCache = [];            // distinct base-model labels present locally
let timesCache = {};            // { "lora name": epoch seconds } for newest-first sorting
let serverNow = 0;              // the backend's clock, so "new" is not skewed by the browser
const NEW_FOR = 24 * 3600;      // a LoRA counts as new for 24 h after it lands

async function loraNames() {
  if (namesCache) return namesCache;
  namesPending = namesPending || (async () => {
    for (const [ep, pick] of [
      ["LoraLoaderModelOnly", (i) => i?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0]],
      ["LoraLoader", (i) => i?.LoraLoader?.input?.required?.lora_name?.[0]],
    ]) {
      try {
        const r = await api.fetchApi(`/object_info/${ep}`);
        const opts = pick(await r.json());
        if (Array.isArray(opts) && opts.length) return [NO_LORA, ...opts];
      } catch (e) { /* try next */ }
    }
    return [NO_LORA];
  })().then((v) => { namesCache = v; namesPending = null; return v; });
  return namesPending;
}

async function loraTypes(refresh = false) {
  if (typesCache && !refresh) return typesCache;
  try {
    const r = await api.fetchApi(`/rednode/lora_types${refresh ? "?refresh=1" : ""}`);
    const d = await r.json();
    typesCache = d.types || {};
    kindsCache = d.kinds || [];
    timesCache = d.times || {};
    serverNow = d.now || Date.now() / 1000;
  } catch (e) { typesCache = {}; kindsCache = []; }
  return typesCache;
}

const css = document.createElement("style");
css.textContent = `
.rn-ls-wrap{display:flex;flex-direction:column;gap:6px;padding:${PAD}px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-ls-head{display:flex;gap:8px;align-items:center;flex:none;position:sticky;bottom:0;
  padding-top:6px;margin-top:auto;background:#16181c}
.rn-ls-add{background:#1f9d55;border:0;color:#fff;border-radius:5px;padding:2px 0;width:54px;cursor:pointer;font-size:17px;font-weight:600;line-height:1.2}
.rn-ls-add:hover{background:#25b863}
.rn-ls-slot{display:flex;flex-direction:column;background:#212429;border-radius:5px;flex:none;overflow:hidden}
.rn-ls-row{display:flex;align-items:center;gap:7px;padding:0 7px;height:${ROW_H}px}
.rn-ls-slot.rn-drop{outline:2px solid #b8283c}
.rn-ls-grip{cursor:grab;opacity:.4;user-select:none;font-size:11px;letter-spacing:-1px}
/* every control sits in its own bordered box (NO8D-style "board" look) */
.rn-ls-eye{background:#111316;border:1px solid #33373d;border-radius:4px;cursor:pointer;font-size:14px;
  padding:3px 0;width:34px;line-height:1.2;flex:none}
.rn-ls-eye:hover{border-color:#b8283c}
/* name and slider share the extra width when the node is resized (slider grows faster) */
.rn-ls-pick{flex:1 1 130px;min-width:70px;background:#111316;color:#ddd;border:1px solid #33373d;border-radius:4px;padding:5px 8px;font-size:12px}
.rn-ls-pick:focus{outline:none;border-color:#b8283c}
.rn-ls-pick.nick{font-style:italic}
.rn-ls-pick.missing{border-color:#a83232;color:#f0a0a0;background:#201416}
.rn-ls-info.missing{border-color:#a83232;color:#f0a0a0}
/* slider shell: track + fill behind a transparent range input (single or dual thumb) */
.rn-ls-sld{position:relative;flex:2 1 210px;min-width:130px;height:20px}
.rn-ls-sld .trk{position:absolute;top:6px;left:0;right:0;height:7px;border-radius:4px;background:#111316;border:1px solid #33373d}
.rn-ls-sld .fil{position:absolute;top:7px;height:5px;border-radius:3px;background:#8a9099;transition:background .1s}
.rn-ls-sld .zero{position:absolute;top:4px;width:1px;height:11px;background:#4a5058}
.rn-ls-sld input[type=range]{position:absolute;top:0;left:0;width:100%;height:20px;margin:0;background:none;pointer-events:none;
  -webkit-appearance:none;appearance:none}
.rn-ls-sld input[type=range]::-webkit-slider-runnable-track{background:transparent;border:0;height:7px}
.rn-ls-sld input[type=range]::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;appearance:none;width:16px;height:16px;
  border-radius:50%;background:#8a9099;border:2px solid #eef2fa;margin-top:-5px;box-shadow:0 1px 3px #0009;cursor:grab}
.rn-ls-sld input[type=range]:active::-webkit-slider-thumb{cursor:grabbing}
.rn-ls-sld.pos input[type=range]::-webkit-slider-thumb{background:#22c55e}
.rn-ls-sld.neg input[type=range]::-webkit-slider-thumb{background:#ef4444}
.rn-ls-sld.rnd input[type=range]::-webkit-slider-thumb{background:#a855f7;border-color:#f3e8ff}
.rn-ls-sld.rnd input.rn-pp::-webkit-slider-thumb{background:#c084fc;border-color:#f5ecff}
.rn-ls-sld.rnd input.rn-np::-webkit-slider-thumb{background:#6d28d9;border-color:#ded5fb}
.rn-ls-num{width:104px;background:#111316;color:#eee;border:1px solid #33373d;border-radius:4px;padding:5px 4px;font-size:13px;
  font-weight:600;text-align:center;flex:none}
.rn-ls-num.rng{font-size:11.5px;letter-spacing:-.2px}
.rn-ls-num.rolled{color:#e9d5ff;border-color:#7c3aed;background:#1d1330}
.rn-ls-tick{position:absolute;top:2px;width:2px;height:15px;background:#f5ecff;border-radius:1px;
  box-shadow:0 0 3px #000a;pointer-events:none}
.rn-ls-arrow{background:#111316;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;font-size:11px;
  padding:4px 0;width:30px;flex:none}
.rn-ls-arrow:hover{color:#fff;border-color:#b8283c}
/* expanded options: LIGHTER than the slot row so the band is obvious; side padding
   matches the row above so every box lines up on the same left edge */
/* border-box so the band's on-screen height is exactly EXP_H (the panel reserves that) */
.rn-ls-exp{display:flex;align-items:center;gap:6px;padding:0 7px;height:${EXP_H}px;box-sizing:border-box;
  background:#2e333b;border-top:1px solid #3d434c}
.rn-ls-lbl{opacity:.75;font-size:11px;flex:none}
/* one height + one line-height for inputs AND buttons, so text sits identically in both */
.rn-ls-mini,.rn-ls-trig,.rn-ls-rnd,.rn-ls-apply,.rn-ls-del,.rn-ls-note{height:26px;box-sizing:border-box;line-height:24px;
  font-size:11.5px;font-family:inherit;border-radius:4px;border:1px solid #33373d;background:#15171b;color:#ddd;padding:0}
.rn-ls-mini{width:54px;text-align:center;flex:none}
.rn-ls-mini::-webkit-inner-spin-button,.rn-ls-mini::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.rn-ls-apply{border-color:#b8283c;color:#e58a97;padding:0 11px;cursor:pointer;font-weight:600;flex:none}
.rn-ls-apply:hover{background:#b8283c;color:#fff}
.rn-ls-trig{flex:1 1 auto;min-width:70px;padding:0 7px;line-height:normal}
.rn-ls-rnd{padding:0 10px;cursor:pointer;color:#c2c7cd;flex:none}
.rn-ls-rnd.on{background:#a855f7;border-color:#a855f7;color:#fff}
.rn-ls-note{width:30px;cursor:pointer;font-size:12px;flex:none;color:#9aa0a8}
.rn-ls-note:hover{color:#fff;border-color:#b8283c}
.rn-ls-note.has{color:#f0c58a;border-color:#7a5a22;background:#241d10}
.rn-ls-del{width:28px;color:#d06a6a;cursor:pointer;font-size:12px;flex:none}
.rn-ls-del:hover{color:#fff;background:#7f1d1d;border-color:#a83232}
.rn-ls-info{background:#111316;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;font-size:11px;
  padding:4px 0;width:26px;flex:none}
.rn-ls-info:hover{color:#fff;border-color:#b8283c}
.rn-ls-card{position:fixed;z-index:10002;width:330px;max-height:70vh;overflow:auto;background:#16181c;border:1px solid #3a3d44;
  border-radius:7px;padding:11px;font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c}
.rn-ls-card h4{margin:0 0 2px;font-size:13.5px;color:#fff}
.rn-ls-card .sub{opacity:.6;font-size:11px;margin-bottom:8px}
.rn-ls-card img{width:100%;border-radius:5px;margin-bottom:8px;display:block}
.rn-ls-card .kv{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid #23262b}
.rn-ls-card .kv span:first-child{opacity:.55}
.rn-ls-card .upd{background:#3a2410;border:1px solid #a86b28;border-radius:4px;padding:6px 8px;margin-bottom:8px;font-size:11.5px;color:#f0c58a}
.rn-ls-card .ok{background:#14251a;border:1px solid #2f6b41;border-radius:4px;padding:5px 8px;margin-bottom:8px;font-size:11.5px;color:#86d3a1}
.rn-ls-card .words{margin-top:8px;background:#111316;border:1px solid #2a2e35;border-radius:4px;padding:6px;font-size:11px;word-break:break-word}
.rn-ls-card .acts{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.rn-ls-card .dl{margin-top:8px;background:#111316;border:1px solid #2a2e35;border-radius:4px;padding:7px;font-size:11px}
.rn-ls-card .dlbar{height:7px;border-radius:4px;background:#23262b;overflow:hidden;margin-top:5px}
.rn-ls-card .dlbar i{display:block;height:100%;background:#1f9d55;width:0;transition:width .2s}
.rn-ls-card button{flex:1;background:#111316;border:1px solid #b8283c;color:#e58a97;border-radius:4px;padding:5px;cursor:pointer;font-size:11px}
.rn-ls-card button:hover{background:#b8283c;color:#fff}
.rn-ls-card a{color:#e58a97;text-decoration:none}
.rn-ls-cog{background:#111316;border:1px solid #33373d;border-radius:5px;color:#c2c7cd;cursor:pointer;font-size:14px;
  padding:0;width:34px;height:30px;flex:none;margin-left:auto}
.rn-ls-cog:hover{color:#fff;border-color:#b8283c}
.rn-ls-panel{position:fixed;z-index:10002;width:270px;background:#1b1e23;border:1px solid #3a3d44;border-radius:7px;padding:10px;
  font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;display:flex;flex-direction:column;gap:8px}
.rn-ls-panel h5{margin:0;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.4px}
.rn-ls-panel button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:4px;padding:6px;cursor:pointer;font-size:11.5px}
.rn-ls-panel button:hover{border-color:#b8283c;color:#fff}
.rn-ls-steps{display:flex;gap:4px}
.rn-ls-steps button{flex:1}
.rn-ls-steps button.on{background:#b8283c;border-color:#b8283c;color:#fff;font-weight:600}
.rn-ls-title{display:flex;align-items:center;gap:7px;padding:0 8px;height:30px;border-radius:5px;background:#2a2f37;
  border-left:4px solid #6b7280;flex:none}
.rn-ls-title input{flex:1;background:transparent;border:0;color:#e8ecf1;font-size:12px;font-weight:700;letter-spacing:.3px;padding:0}
.rn-ls-title input:focus{outline:none}
/* a title and its LoRAs read as one block: bordered box, contents indented. Matches
   the section boxes in RedNode Group Control. */
.rn-ls-section{display:flex;flex-direction:column;gap:5px;background:#1b1e23;border:1px solid #3d434c;
  border-left:3px solid #6b7280;border-radius:7px;padding:5px;flex:none}
.rn-ls-section > .rn-ls-slot{margin-left:12px}
.rn-ls-section > .rn-ls-title{background:transparent;border-left:0;padding-left:2px}
.rn-ls-sw{display:flex;flex-wrap:wrap;gap:5px}
.rn-ls-sw div{width:22px;height:22px;border-radius:4px;cursor:pointer;border:2px solid transparent}
.rn-ls-sw div:hover{border-color:#fff}
.rn-ls-rep{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:5px}
.rn-ls-rep .r{background:#15171b;border:1px solid #2a2e35;border-radius:4px;padding:5px 7px;font-size:11px}
.rn-ls-rep .r b{color:#f0c58a}
.rn-ls-rep .r a{color:#e58a97;text-decoration:none}
.rn-ls-chk{width:17px;height:17px;border-radius:4px;border:2px solid #5a616b;background:#111316;cursor:pointer;flex:none;
  display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;line-height:1}
.rn-ls-chk.on{background:#b8283c;border-color:#b8283c}
.rn-ls-slot.sel,.rn-ls-title.sel{outline:2px solid #b8283c}
.rn-ls-selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#2e333b;border:1px solid #b8283c;
  border-radius:5px;padding:6px 8px;flex:none}
.rn-ls-selbar span.cnt{font-size:11.5px;font-weight:700;color:#e58a97;margin-right:2px}
.rn-ls-selbar button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:4px;padding:4px 9px;
  cursor:pointer;font-size:11px;height:26px;box-sizing:border-box;line-height:16px}
.rn-ls-selbar button:hover{border-color:#b8283c;color:#fff}
.rn-ls-selbar button.danger{border-color:#7f1d1d;color:#e58a97}
.rn-ls-selbar button.danger:hover{background:#7f1d1d;color:#fff}
.rn-ls-drop{position:fixed;z-index:10001;background:#111316;border:1px solid #3a3d44;border-radius:5px;max-height:280px;overflow:auto;
  font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 8px 24px #000b}
.rn-ls-drop div{padding:5px 10px;cursor:pointer;white-space:nowrap}
.rn-ls-drop div:hover,.rn-ls-drop div.sel{background:#b8283c}
`;
document.head.appendChild(css);

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);
const shortName = (n) => (!n || n === NO_LORA ? "(none)" : n.split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt)$/i, ""));

// Place a popup relative to what was clicked. Size is only knowable once it is in the
// DOM, so this runs after appendChild. `anchorBottomRight` puts the popup ABOVE-LEFT of
// the point (its bottom-right corner lands on the click) and flips down only if it would
// run off the top of the window.
function placePopup(el, x, y, anchorBottomRight = false) {
  const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
  let left = anchorBottomRight ? x - w : x;
  let top = anchorBottomRight ? y - h : y;
  if (top < pad) top = y + 6;                                  // no room above -> below
  if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// Keep graph interactions (box-select, node drag) out of the panel — but NOT the wheel,
// or hovering the node would block canvas zoom. Popups that scroll internally opt back in.
function stopEvents(el, { wheel = false } = {}) {
  const evs = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup",
               "click", "dblclick", "contextmenu", "keydown"];
  if (wheel) evs.push("wheel");
  for (const ev of evs) el.addEventListener(ev, (e) => e.stopPropagation());
}

// The Workspace hosts this same panel on its LoRAs tab. It keeps the stack in its
// own config rather than a stack_json widget, so both ends of the read/write go
// through hooks the host can supply. Nothing else in here needs to know.
export function readSlots(node) {
  if (node._rnStackRead) {
    const v = node._rnStackRead(node) || {};
    node._rnUI = v.ui || {};
    return Array.isArray(v.slots) ? v.slots : [];
  }
  const w = findWidget(node, "stack_json");
  try {
    const v = JSON.parse(w?.value || "[]");
    if (Array.isArray(v)) { node._rnUI = {}; return v; }          // legacy bare list
    node._rnUI = v?.ui || {};
    return Array.isArray(v?.slots) ? v.slots : [];
  } catch (e) { node._rnUI = {}; return []; }
}

export function writeSlots(node) {
  node._rnRolled = null;          // the stack changed: last run's rolls no longer apply
  if (node._rnStackWrite) {
    node._rnStackWrite(node, { ui: node._rnUI || {}, slots: node._rnSlots || [] });
    return;
  }
  const w = findWidget(node, "stack_json");
  if (!w) return;
  w.value = JSON.stringify({ ui: node._rnUI || {}, slots: node._rnSlots || [] });
  w.callback?.(w.value);
  node.graph?.setDirtyCanvas(true, true);
}

const stepOf = (node) => Number(node._rnUI?.step) || 0.01;

const COLORS = [
  { n: "none", v: null }, { n: "red", v: "#7f2230" }, { n: "orange", v: "#7a4416" },
  { n: "green", v: "#1e5233" }, { n: "teal", v: "#14514f" }, { n: "blue", v: "#1d3f6e" },
  { n: "purple", v: "#492a6b" }, { n: "pink", v: "#6b2450" }, { n: "grey", v: "#3a3f47" },
];
const TEXT_COLORS = [   // "default" already IS white, so there is no separate white swatch
  { n: "default (white)", v: null }, { n: "black", v: "#111316" }, { n: "grey", v: "#9aa0a8" },
  { n: "red", v: "#f87171" }, { n: "orange", v: "#fb923c" }, { n: "yellow", v: "#facc15" },
  { n: "green", v: "#4ade80" }, { n: "blue", v: "#60a5fa" }, { n: "purple", v: "#c084fc" },
  { n: "pink", v: "#f472b6" },
];
const newTitle = () => ({ type: "title", text: "Group", color: "#3a3f47" });
// the rows a title owns: everything after it until the next title
function groupMembers(node, titleIndex) {
  const out = [];
  for (let i = titleIndex + 1; i < (node._rnSlots || []).length; i++) {
    if (isTitle(node._rnSlots[i])) break;
    out.push(i);
  }
  return out;
}

const selSet = (node) => (node._rnSel = node._rnSel || new Set());
const inSelMode = (node) => !!node._rnSelMode;
function toggleSel(node, index) {
  const sel = selSet(node);
  sel.has(index) ? sel.delete(index) : sel.add(index);
  render(node);
}
function exitSel(node) { node._rnSelMode = false; node._rnSel = new Set(); render(node); }
const isTitle = (s) => s && s.type === "title";
export const newSlot = () => ({
  name: NO_LORA, enabled: true, strength: 1.0, trigger: "",
  random: false, rand_min: 0.0, rand_max: 2.0,          // the random band
  scale_min: SCALE_MIN, scale_max: SCALE_MAX,           // this slot's slider end stops
});
const slotMin = (s) => (typeof s.rand_min === "number" ? s.rand_min : 0);
const slotMax = (s) => (typeof s.rand_max === "number" ? s.rand_max : 2);
const scaleMin = (s) => (typeof s.scale_min === "number" ? s.scale_min : SCALE_MIN);
const scaleMax = (s) => {
  const lo = scaleMin(s);
  const hi = typeof s.scale_max === "number" ? s.scale_max : SCALE_MAX;
  return hi > lo ? hi : lo + 0.01;                      // never a zero-width scale
};

// searchable picker (type to filter, arrows + enter, esc to cancel)
function openPicker(node, slot, input) {
  document.querySelector(".rn-ls-drop")?.remove();
  const drop = document.createElement("div");
  drop.className = "rn-ls-drop";
  const r = input.getBoundingClientRect();
  drop.style.left = `${r.left}px`;
  drop.style.top = `${r.bottom + 3}px`;
  drop.style.minWidth = `${Math.max(r.width, 300)}px`;
  stopEvents(drop, { wheel: true });
  let items = [], sel = 0;

  const fill = () => {
    const q = input.value.trim().toLowerCase();
    const want = node._rnUI?.filter || "";        // "" = every base model
    const cur = slot.name && slot.name !== NO_LORA ? slot.name : null;
    let all = node._rnNames || [NO_LORA];
    if (want) all = all.filter((n) => n === NO_LORA || (typesCache?.[n] || "Unknown") === want);
    let list = q ? all.filter((n) => n.toLowerCase().includes(q)) : all.slice();
    if ((node._rnUI?.sort || "recent") === "recent") {
      // newest first; the backend list is alphabetical, so ties keep A-Z order
      list.sort((a, b) => (timesCache[b] || 0) - (timesCache[a] || 0));
    }
    if (!q && cur) {
      // the current pick leads the list (even if the base-model filter would hide it),
      // so you can always see what the slot is set to
      list = [cur, ...list.filter((n) => n !== cur)];
    }
    items = list.slice(0, 400);
    drop.replaceChildren();
    if (!items.length) {
      const d = document.createElement("div");
      d.textContent = "no match"; d.style.opacity = ".5";
      drop.appendChild(d);
      return;
    }
    items.forEach((n, i) => {
      const d = document.createElement("div");
      const kind = n === NO_LORA ? "" : (typesCache?.[n] || "");
      const isCur = cur && n === cur;
      const age = serverNow && timesCache[n] ? serverNow - timesCache[n] : Infinity;
      const isNew = age >= 0 && age < NEW_FOR;
      d.textContent = n === NO_LORA ? "(none)" : n;
      if (isNew) {
        d.style.background = "#14251a";
        const tag = document.createElement("span");
        const hrs = Math.max(0, Math.round(age / 3600));
        tag.textContent = hrs < 1 ? "NEW" : `NEW ${hrs}h`;
        tag.style.cssText = "float:right;margin-left:10px;font-size:9.5px;font-weight:700;" +
          "color:#86d3a1;border:1px solid #2f6b41;border-radius:3px;padding:0 4px";
        d.appendChild(tag);
      }
      if (isCur) {
        d.style.color = "#f0c58a";
        const now = document.createElement("span");
        now.textContent = "current";
        now.style.cssText = "float:right;margin-left:14px;font-size:10px;color:#f0c58a;opacity:.85";
        d.appendChild(now);
      } else if (kind) {
        const tag = document.createElement("span");
        tag.textContent = kind;
        tag.style.cssText = "float:right;opacity:.45;margin-left:14px;font-size:10px";
        d.appendChild(tag);
      }
      if (i === sel) { d.classList.add("sel"); }
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); choose(n); });
      drop.appendChild(d);
    });
    drop.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (n) => { slot.name = n; input.value = shortName(n); input.title = n; writeSlots(node); close(); render(node); };
  const close = () => { drop.remove(); document.removeEventListener("pointerdown", outside, true); input.removeEventListener("keydown", keys); };
  const outside = (e) => { if (!drop.contains(e.target) && e.target !== input) close(); };
  const keys = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); fill(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); fill(); e.preventDefault(); }
    else if (e.key === "Enter") { if (items[sel]) choose(items[sel]); e.preventDefault(); }
    else if (e.key === "Escape") { close(); input.blur(); }
    else setTimeout(() => { sel = 0; fill(); }, 0);
  };
  input.addEventListener("keydown", keys);
  document.addEventListener("pointerdown", outside, true);
  document.body.appendChild(drop);
  fill();
}

// ⓘ — Civitai lookup by file hash (nothing leaves the machine but the hash, on click only)
async function openInfo(node, slot, anchor, refresh = false) {
  document.querySelector(".rn-ls-card")?.remove();
  if (!slot.name || slot.name === NO_LORA) return;
  const card = document.createElement("div");
  card.className = "rn-ls-card";
  const r = anchor.getBoundingClientRect();
  card.innerHTML = `<div class="sub">${refresh ? "Refreshing" : "Hashing file and asking Civitai"}…<br>
    <span style="opacity:.6">First lookup of a big LoRA can take a few seconds</span></div>`;
  stopEvents(card, { wheel: true });
  document.body.appendChild(card);
  placePopup(card, r.right, r.top - 4, true);        // above-left of the ⓘ button
  const close = () => { card.remove(); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!card.contains(e.target) && e.target !== anchor) close(); };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);

  let d;
  try {
    const vid = slot.civitai?.version_id ? `&version_id=${slot.civitai.version_id}` : "";
    const res = await api.fetchApi(
      `/rednode/lora_info?name=${encodeURIComponent(slot.name)}${refresh ? "&refresh=1" : ""}${vid}`);
    d = await res.json();
    if (d.found && d.version_id && slot.civitai?.version_id !== d.version_id) {
      // stamp what this LoRA actually is, so sharing the workflow carries its identity
      slot.civitai = { model_id: d.model_id, version_id: d.version_id, hash: d.hash, name: d.name };
      writeSlots(node);
    }
  } catch (e) {
    d = { error: "could not reach the ComfyUI backend" };
  }
  if (!card.isConnected) return;
  const reflow = () => placePopup(card, r.right, r.top - 4, true);

  const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  if (d.error) {
    card.innerHTML = `<h4>${esc(shortName(slot.name))}</h4><div class="sub">${esc(d.error)}</div>`;
    reflow();
  } else if (d.missing && !d.found) {
    // the workflow references a LoRA this machine does not have, and we have no id for it
    card.innerHTML = `<h4>${esc(shortName(slot.name))}</h4>
      <div class="upd">This LoRA is <b>not installed</b> on this machine.<br>
        <span style="opacity:.75">The workflow references <code>${esc(slot.name)}</code>.</span></div>
      <div class="acts">${d.search_url ? `<button data-a="find">Search Civitai for it</button>` : ""}</div>`;
    card.querySelector('[data-a="find"]')?.addEventListener("click", () => window.open(d.search_url, "_blank"));
    reflow();
  } else if (!d.found) {
    card.innerHTML = `<h4>${esc(shortName(slot.name))}</h4>
      <div class="sub">Not found on Civitai — a private, renamed or locally trained LoRA</div>
      <div class="kv"><span>SHA-256</span><span>${esc((d.hash || "").slice(0, 16))}…</span></div>`;
    reflow();
  } else {
    const kv = (k, v) => (v === null || v === undefined || v === "" ? "" : `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`);
    card.innerHTML = `
      <h4>${esc(d.name)}</h4>
      <div class="sub">${esc(d.version || "")}${d.base_model ? " · " + esc(d.base_model) : ""}</div>
      ${d.preview ? `<img src="${esc(d.preview)}" loading="lazy">` : ""}
      ${d.missing ? `<div class="upd">This LoRA is <b>not installed</b> here — the workflow saved which
             version it needs, so it can be fetched directly.</div>` : ""}
      ${d.update?.available
        ? `<div class="upd">⬆ Update available: <b>${esc(d.update.latest)}</b>${d.update.published ? ` · ${esc(d.update.published)}` : ""}
             <br><span style="opacity:.7">Installed: ${esc(d.version || "?")}${d.update.behind ? ` (${d.update.behind} version${d.update.behind > 1 ? "s" : ""} behind)` : ""}</span>
             ${d.update.installed_as ? `<br><span style="color:#86d3a1">✓ Already downloaded — switch below</span>` : ""}</div>`
        : (d.update ? `<div class="ok">✓ Up to date</div>` : "")}
      ${kv("Type", d.type)}
      ${kv("Downloads", d.downloads?.toLocaleString?.() ?? d.downloads)}
      ${kv("Thumbs up", d.thumbs_up?.toLocaleString?.() ?? d.thumbs_up)}
      ${kv("Published", d.published)}
      ${d.trained_words?.length ? `<div class="words"><b>Trigger words</b><br>${esc(d.trained_words.join(", "))}</div>` : ""}
      <div class="acts">
        ${d.update?.installed_as ? `<button data-a="switch">Switch to ${esc(shortName(d.update.installed_as))}</button>` : ""}
        ${d.update?.available && !d.update.installed_as && d.update.latest_id
          ? `<button data-a="dl">⬇ Download ${esc(d.update.latest)}</button>` : ""}
      ${d.missing && d.version_id
          ? `<button data-a="dlthis">⬇ Download this LoRA</button>` : ""}
        ${d.trained_words?.length ? `<button data-a="use">Use as Keywords</button>` : ""}
        ${d.url ? `<button data-a="open">Open on Civitai</button>` : ""}
        <button data-a="refresh" title="re-query Civitai">↻</button>
      </div>`;
    reflow();                                        // content arrived: re-measure and settle
    const startDownload = async (ev, versionId) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = "Starting…";
      const box = document.createElement("div");
      box.className = "dl";
      box.innerHTML = `<div class="msg">Contacting Civitai…</div><div class="dlbar"><i></i></div>`;
      card.appendChild(box);
      reflow();
      const msg = box.querySelector(".msg"), bar = box.querySelector("i");
      let job;
      try {
        const r = await api.fetchApi("/rednode/lora_download", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version_id: versionId }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        job = j.job;
      } catch (e) {
        msg.textContent = `Could not start: ${e.message}`; btn.disabled = false;
        btn.textContent = "⬇ Retry"; return;
      }
      const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
      const poll = setInterval(async () => {
        let st;
        try {
          st = await (await api.fetchApi(`/rednode/lora_download_status?job=${job}`)).json();
        } catch (e) { return; }
        if (st.state === "downloading" || st.state === "starting") {
          const pct = st.total ? (st.got / st.total) * 100 : 0;
          bar.style.width = `${pct}%`;
          msg.textContent = `${st.name || "Downloading"} — ${mb(st.got)}${st.total ? ` / ${mb(st.total)}` : ""}`;
          return;
        }
        clearInterval(poll);
        if (st.state === "done") {
          bar.style.width = "100%";
          msg.innerHTML = `✓ Downloaded <b>${esc(st.lora_name)}</b>${st.verified ? " (SHA-256 verified)" : ""}`;
          const sw = document.createElement("button");
          sw.textContent = `Switch this slot to it`;
          sw.style.marginTop = "7px";
          sw.onclick = () => { slot.name = st.lora_name; writeSlots(node); render(node); close(); };
          box.appendChild(sw);
          namesCache = null; typesCache = null;      // the folder changed — refresh caches
          loraNames().then((n) => { node._rnNames = n; });
          loraTypes(true);
          btn.remove();
        } else {
          msg.textContent = `Download failed: ${st.error || "unknown error"}`;
          btn.disabled = false; btn.textContent = "⬇ Retry";
        }
      }, 700);
    };
    card.querySelector('[data-a="dl"]')?.addEventListener("click",
      (ev) => startDownload(ev, d.update.latest_id));
    card.querySelector('[data-a="dlthis"]')?.addEventListener("click",
      (ev) => startDownload(ev, d.version_id));
    card.querySelector('[data-a="switch"]')?.addEventListener("click", () => {
      slot.name = d.update.installed_as;          // the newer file is already on disk
      writeSlots(node); render(node); close();
    });
    card.querySelector('[data-a="use"]')?.addEventListener("click", () => {
      slot.trigger = d.trained_words.join(", ");
      writeSlots(node); render(node); close();
    });
    card.querySelector('[data-a="open"]')?.addEventListener("click", () => window.open(d.url, "_blank"));
    card.querySelector('[data-a="refresh"]')?.addEventListener("click", () => { close(); openInfo(node, slot, anchor, true); });
  }
}

function buildTitle(node, slot, index) {
  const box = document.createElement("div");
  box.className = "rn-ls-title";
  box.style.display = "flex";
  box.style.flexDirection = "column";
  // the class sets align-items:center for its old single-row layout; in a COLUMN that
  // centres the row horizontally instead of filling the bar
  box.style.alignItems = "stretch";
  box.style.height = "auto";
  box.style.padding = "0";
  box.style.overflow = "hidden";
  if (slot.color) { box.style.background = slot.color; box.style.borderLeftColor = "#ffffff44"; }
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.style.outline = "2px solid #b8283c"; });
  box.addEventListener("dragleave", () => { box.style.outline = "none"; });
  box.addEventListener("drop", (e) => { e.preventDefault(); box.style.outline = "none"; dropOn(node, index); });
  box.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(node, slot, index, e); });

  const grip = document.createElement("span");
  grip.className = "rn-ls-grip"; grip.textContent = "⋮⋮"; grip.title = "drag to reorder";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e) => { node._rnFrom = index; e.dataTransfer.effectAllowed = "move"; });
  let lead = grip;
  if (inSelMode(node)) {
    const chk = document.createElement("span");
    chk.className = "rn-ls-chk" + (selSet(node).has(index) ? " on" : "");
    chk.textContent = selSet(node).has(index) ? "✓" : "";
    chk.onclick = (e) => { e.stopPropagation(); toggleSel(node, index); };
    lead = chk;
    if (selSet(node).has(index)) box.classList.add("sel");
  }

  const txt = document.createElement("input");
  txt.value = slot.text || "";
  txt.placeholder = "group title";
  if (slot.text_color) txt.style.color = slot.text_color;
  txt.addEventListener("change", () => { slot.text = txt.value; writeSlots(node); });

  const members = groupMembers(node, index);
  const loras = members.filter((i) => !isTitle(node._rnSlots[i]));
  const anyOn = loras.some((i) => node._rnSlots[i].enabled !== false);

  const eye = document.createElement("button");
  eye.className = "rn-ls-eye";
  eye.textContent = anyOn ? "👁" : "—";
  eye.style.color = anyOn ? "#8fb4ff" : "#666";
  eye.title = loras.length
    ? (anyOn ? `bypass all ${loras.length} LoRA(s) in this group` : `enable all ${loras.length} LoRA(s) in this group`)
    : "no LoRAs in this group yet";
  eye.onclick = () => {
    loras.forEach((i) => { node._rnSlots[i].enabled = !anyOn; });
    writeSlots(node); render(node);
  };

  const fold = document.createElement("button");
  fold.className = "rn-ls-arrow";
  fold.textContent = slot.folded ? "▸" : "▾";
  fold.title = slot.folded ? "show this group" : "collapse this group out of the way";
  fold.onclick = () => { slot.folded = !slot.folded || undefined; writeSlots(node); render(node); };

  const arrow = document.createElement("button");
  arrow.className = "rn-ls-arrow";
  arrow.textContent = slot._open ? "▲" : "▼";
  arrow.title = "title options: text colour, bar colour, remove";
  arrow.onclick = () => { slot._open = !slot._open; render(node); };

  const row = document.createElement("div");
  row.className = "rn-ls-row";
  row.style.height = "30px";
  row.style.padding = "0 8px";
  row.append(lead, eye, fold, txt, arrow);
  if (slot.folded && loras.length) {
    const badge = document.createElement("span");
    badge.textContent = `${loras.length} hidden`;
    badge.style.cssText = "font-size:10px;opacity:.6;flex:none;margin-right:4px";
    row.insertBefore(badge, arrow);
  }
  box.appendChild(row);

  if (slot._open) {
    const exp = document.createElement("div");
    exp.className = "rn-ls-exp";
    const swatches = (list, get, set) => {
      const wrap = document.createElement("div");
      wrap.className = "rn-ls-sw";
      wrap.style.flexWrap = "nowrap";
      list.forEach((c) => {
        const d = document.createElement("div");
        d.title = c.n;
        d.style.width = d.style.height = "18px";
        d.style.background = c.v || "#e8ecf1";
        if (!c.v) d.style.outline = "1px dashed #6b7280";
        if ((get() || null) === c.v) d.style.borderColor = "#fff";
        d.onclick = () => { set(c.v); writeSlots(node); render(node); };
        wrap.appendChild(d);
      });
      return wrap;
    };
    const lt = document.createElement("span"); lt.className = "rn-ls-lbl"; lt.textContent = "Text";
    const lb = document.createElement("span"); lb.className = "rn-ls-lbl"; lb.textContent = "Bar";
    const del = document.createElement("button");
    del.className = "rn-ls-del";
    del.textContent = "🗑";
    del.title = "remove this title";
    del.style.marginLeft = "auto";
    del.onclick = () => { node._rnSlots.splice(index, 1); writeSlots(node); render(node); };
    exp.append(
      lt, swatches(TEXT_COLORS, () => slot.text_color, (v) => { slot.text_color = v || undefined; }),
      lb, swatches(COLORS, () => slot.color, (v) => { slot.color = v || undefined; }),
      del,
    );
    box.appendChild(exp);
  }
  return box;
}

function dropOn(node, index) {
  const from = node._rnFrom;
  if (from == null || from === index) return;
  const [m] = node._rnSlots.splice(from, 1);
  node._rnSlots.splice(index, 0, m);
  writeSlots(node); render(node);
}

// per-slot scratch notes ("this one needs 0.4 with the detailer", trigger quirks, …)
function openNote(node, slot, x, y) {
  document.querySelector(".rn-ls-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ls-panel";
  m.style.width = "300px";
  stopEvents(m);
  const h = document.createElement("h5");
  h.textContent = "Notes";
  const sub = document.createElement("div");
  sub.style.cssText = "font-size:10.5px;opacity:.6;word-break:break-all";
  sub.textContent = slot.label ? `${slot.label} — ${shortName(slot.name)}` : shortName(slot.name);
  const ta = document.createElement("textarea");
  ta.value = slot.note || "";
  ta.placeholder = "what this LoRA is for, good strengths, what it clashes with…";
  ta.style.cssText = "width:100%;height:110px;box-sizing:border-box;background:#15171b;color:#ddd;" +
    "border:1px solid #33373d;border-radius:4px;padding:6px;font:11.5px system-ui;resize:vertical";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:5px";
  const save = document.createElement("button");
  save.textContent = "Save"; save.style.flex = "1";
  save.onclick = () => { slot.note = ta.value.trim() || undefined; writeSlots(node); render(node); m.remove(); };
  const clear = document.createElement("button");
  clear.textContent = "Clear"; clear.style.flex = "1";
  clear.onclick = () => { slot.note = undefined; writeSlots(node); render(node); m.remove(); };
  row.append(save, clear);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") m.remove();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.click();
  });
  m.append(h, sub, ta, row);
  document.body.appendChild(m);
  placePopup(m, x, y);
  ta.focus();
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// give a slot a nickname (display only — the file it loads never changes)
function openRename(node, slot, x, y) {
  document.querySelector(".rn-ls-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ls-panel";
  m.style.width = "260px";
  stopEvents(m);
  const h = document.createElement("h5");
  h.textContent = "Custom name";
  const sub = document.createElement("div");
  sub.style.cssText = "font-size:10.5px;opacity:.6;word-break:break-all";
  sub.textContent = `file: ${shortName(slot.name)}`;
  const inp = document.createElement("input");
  inp.value = slot.label || "";
  inp.placeholder = "leave empty to show the filename";
  inp.style.cssText = "background:#15171b;color:" + (slot.label_color || "#e8ecf1") + ";border:1px solid #33373d;border-radius:4px;padding:6px;font-size:12px";
  const hCol = document.createElement("h5");
  hCol.textContent = "Text colour";
  const sw = document.createElement("div");
  sw.className = "rn-ls-sw";
  let chosen = slot.label_color || null;
  const paintSw = () => [...sw.children].forEach((d, i) => {
    d.style.borderColor = (TEXT_COLORS[i].v || null) === chosen ? "#fff" : "transparent";
  });
  TEXT_COLORS.forEach((c) => {
    const d = document.createElement("div");
    d.title = c.n;
    d.style.background = c.v || "#e8ecf1";        // "default" = normal white text
    if (!c.v) d.style.outline = "1px dashed #6b7280";
    d.onclick = () => { chosen = c.v; inp.style.color = c.v || "#e8ecf1"; paintSw(); };
    sw.appendChild(d);
  });
  paintSw();

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:5px";
  const save = document.createElement("button");
  save.textContent = "Save";
  save.style.flex = "1";
  save.onclick = () => {
    slot.label = inp.value.trim() || undefined;
    slot.label_color = slot.label ? (chosen || undefined) : undefined;
    writeSlots(node); render(node); m.remove();
  };
  const clear = document.createElement("button");
  clear.textContent = "Clear";
  clear.style.flex = "1";
  clear.onclick = () => {
    slot.label = undefined; slot.label_color = undefined;
    writeSlots(node); render(node); m.remove();
  };
  row.append(save, clear);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); if (e.key === "Escape") m.remove(); });
  m.append(h, sub, inp, hCol, sw, row);
  document.body.appendChild(m);
  placePopup(m, x, y);
  inp.focus(); inp.select();
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// right-click a row: colour it, add a group title, duplicate or remove
function openRowMenu(node, slot, index, ev) {
  document.querySelector(".rn-ls-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ls-panel";
  stopEvents(m);

  const h = document.createElement("h5"); h.textContent = "Colour";
  const sw = document.createElement("div"); sw.className = "rn-ls-sw";
  COLORS.forEach((c) => {
    const d = document.createElement("div");
    d.title = c.n;
    d.style.background = c.v || "transparent";
    if (!c.v) { d.style.border = "2px dashed #555"; }
    if ((slot.color || null) === c.v) d.style.borderColor = "#fff";
    d.onclick = () => { slot.color = c.v; writeSlots(node); render(node); m.remove(); };
    sw.appendChild(d);
  });

  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { fn(); m.remove(); };
    return b;
  };
  const h2 = document.createElement("h5"); h2.textContent = "Row";
  m.append(h, sw, h2,
    mk("Add group title above", () => { node._rnSlots.splice(index, 0, newTitle()); writeSlots(node); render(node); }),
    mk("Add group title below", () => { node._rnSlots.splice(index + 1, 0, newTitle()); writeSlots(node); render(node); }),
  );
  if (!isTitle(slot)) {
    m.append(mk(slot.label ? "Edit custom name…" : "Add custom name…",
      () => openRename(node, slot, ev.clientX, ev.clientY)));
    if (slot.label) m.append(mk("Clear custom name", () => {
      slot.label = undefined; writeSlots(node); render(node);
    }));
    m.append(mk("Duplicate slot", () => {
      node._rnSlots.splice(index + 1, 0, JSON.parse(JSON.stringify(slot))); writeSlots(node); render(node);
    }));
    m.append(mk("Colour this group", () => {
      // paint every slot from the title above this row down to the next title
      let start = index;
      while (start > 0 && !isTitle(node._rnSlots[start - 1])) start--;
      let end = index;
      while (end + 1 < node._rnSlots.length && !isTitle(node._rnSlots[end + 1])) end++;
      const c = slot.color || null;
      for (let i = start; i <= end; i++) node._rnSlots[i].color = c;
      writeSlots(node); render(node);
    }));
  }
  m.append(mk("Select multiple rows…", () => {
    node._rnSelMode = true;
    selSet(node).add(index);
    render(node);
  }));
  m.append(mk(isTitle(slot) ? "Remove title" : "Remove slot", () => {
    node._rnSlots.splice(index, 1); writeSlots(node); render(node);
  }));

  document.body.appendChild(m);
  placePopup(m, ev.clientX, ev.clientY);        // opens from the cursor, flips at edges
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

export function buildSlot(node, slot, index) {
  const box = document.createElement("div");
  box.className = "rn-ls-slot";
  box.style.opacity = slot.enabled ? "1" : "0.5";
  if (slot.color) { box.style.background = slot.color; }
  box.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(node, slot, index, e); });
  // NOTE: only the grip is draggable. Making the whole row draggable hijacked
  // pointer drags on the sliders (they started an HTML5 row-drag instead).
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("rn-drop"); });
  box.addEventListener("dragleave", () => box.classList.remove("rn-drop"));
  box.addEventListener("drop", (e) => {
    e.preventDefault(); box.classList.remove("rn-drop");
    const from = node._rnFrom;
    if (from == null || from === index) return;
    const [m] = node._rnSlots.splice(from, 1);
    node._rnSlots.splice(index, 0, m);
    writeSlots(node); render(node);
  });

  const row = document.createElement("div");
  row.className = "rn-ls-row";

  // in select mode the checkbox REPLACES the grip as a direct flex child — wrapping it
  // in a span made the painted box and its hit area disagree by a few pixels
  let lead = null;
  if (inSelMode(node)) {
    lead = document.createElement("span");
    lead.className = "rn-ls-chk" + (selSet(node).has(index) ? " on" : "");
    lead.textContent = selSet(node).has(index) ? "✓" : "";
    lead.title = "select this row";
    lead.onclick = (e) => { e.stopPropagation(); toggleSel(node, index); };
    if (selSet(node).has(index)) box.classList.add("sel");
    box.addEventListener("click", (e) => {           // clicking empty row area also toggles
      if (e.target.closest("input,button,.rn-ls-sld")) return;
      toggleSel(node, index);
    });
  }
  const grip = document.createElement("span");
  grip.className = "rn-ls-grip";
  grip.textContent = "⋮⋮";
  grip.title = "drag to reorder";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e) => {
    node._rnFrom = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(box, 10, 10);
  });

  const eye = document.createElement("button");
  eye.className = "rn-ls-eye";
  eye.textContent = slot.enabled ? "👁" : "—";
  eye.style.color = slot.enabled ? "#8fb4ff" : "#666";
  eye.title = slot.enabled ? "enabled — click to bypass this slot" : "bypassed — click to enable";
  eye.onclick = () => { slot.enabled = !slot.enabled; writeSlots(node); render(node); };

  const useNick = node._rnUI?.nicknames !== false;      // on unless turned off
  const shown = () => (useNick && slot.label) || shortName(slot.name);
  const pick = document.createElement("input");
  pick.className = "rn-ls-pick" + (useNick && slot.label ? " nick" : "");
  pick.value = shown();
  // a shared workflow can reference LoRAs this machine does not have
  const missing = slot.name && slot.name !== NO_LORA && node._rnNames &&
                  node._rnNames.length > 1 && !node._rnNames.includes(slot.name);
  if (missing) {
    pick.classList.add("missing");
    pick.title = `NOT INSTALLED — ${slot.name}
Click ⓘ to find it on Civitai`;
  }
  if (useNick && slot.label && slot.label_color) pick.style.color = slot.label_color;
  pick.title = slot.label ? `${slot.label}  —  file: ${slot.name}` : slot.name;
  // (the tooltip always shows the real file, whichever display mode is on)
  pick.placeholder = "click and type to search LoRAs";
  pick.addEventListener("focus", () => { pick.value = ""; openPicker(node, slot, pick); });
  pick.addEventListener("blur", () => setTimeout(() => { pick.value = shown(); }, 150));

  // LAND ON THE NEW SLOT. + appends, so on a long stack the new row arrives below the
  // fold, and the search only opens on focus: adding a LoRA meant scrolling to find
  // the empty row, then clicking its name field, before a single letter could be
  // typed. The + names the index it is about to create and the row that turns out to
  // be that index claims it here, once, then puts itself on screen and opens its own
  // picker. A flag consumed at build time rather than a lookup after render(), because
  // render() rebuilds every row and any element found beforehand is already stale.
  if (node._rnFocusSlot === index) {
    node._rnFocusSlot = -1;
    // after layout, not now: openPicker measures the input to place its dropdown, and
    // a row appended a microsecond ago has no rectangle yet
    requestAnimationFrame(() => {
      // scroll first, then focus WITHOUT scrolling, or the browser's own focus scroll
      // fights this one and the row settles half out of view
      row.scrollIntoView({ block: "nearest" });
      pick.focus({ preventScroll: true });
    });
  }

  // strength control: one thumb normally, TWO thumbs (a variance band) when randomized.
  // Fill runs from the zero mark: green to the right, red to the left; purple for a band.
  const num = document.createElement("input");
  num.className = "rn-ls-num";
  // a randomized slot shows "min ~ max", which a number input refuses and blanks out,
  // so the type must be decided BEFORE any value is written
  num.type = slot.random ? "text" : "number";
  num.step = String(stepOf(node));
  const sMin = scaleMin(slot), sMax = scaleMax(slot);
  const sld = document.createElement("div");
  sld.className = "rn-ls-sld";
  const trk = document.createElement("div"); trk.className = "trk";
  const fil = document.createElement("div"); fil.className = "fil";
  const pos = (v) => ((clamp(v, sMin, sMax) - sMin) / (sMax - sMin)) * 100;
  const mkRange = (val) => {
    const r = document.createElement("input");
    r.type = "range"; r.min = String(sMin); r.max = String(sMax); r.step = String(stepOf(node));
    r.value = String(clamp(val, sMin, sMax));
    return r;
  };
  sld.append(trk, fil);
  if (sMin < 0 && sMax > 0) {                 // zero mark only when the scale crosses zero
    const zero = document.createElement("div");
    zero.className = "zero";
    zero.style.left = `${pos(0)}%`;
    sld.appendChild(zero);
  }

  if (slot.random) {
    sld.classList.add("rnd");
    sld.title = "drag the two handles to set the random range";
    const rMin = mkRange(slotMin(slot));
    const rMax = mkRange(Math.max(slotMax(slot), slotMin(slot)));
    const PURPLE_NEG = "#6d28d9", PURPLE_POS = "#c084fc";
    const paint = () => {
      const a = parseFloat(rMin.value), b = parseFloat(rMax.value);
      fil.style.left = `${pos(a)}%`;
      fil.style.width = `${Math.max(0.5, pos(b) - pos(a))}%`;
      // split the band at zero: deep purple on the negative side, light on the positive
      if (b <= 0) fil.style.background = PURPLE_NEG;
      else if (a >= 0) fil.style.background = PURPLE_POS;
      else {
        const cut = ((0 - a) / (b - a)) * 100;      // zero, as a % of the band itself
        fil.style.background =
          `linear-gradient(to right, ${PURPLE_NEG} 0 ${cut}%, ${PURPLE_POS} ${cut}% 100%)`;
      }
      rMin.classList.toggle("rn-np", a < 0); rMin.classList.toggle("rn-pp", a >= 0);
      rMax.classList.toggle("rn-np", b < 0); rMax.classList.toggle("rn-pp", b >= 0);
      num.value = `${fmt(a)} ~ ${fmt(b)}`;
    };
    rMin.addEventListener("input", () => {          // thumbs can't cross
      if (parseFloat(rMin.value) > parseFloat(rMax.value)) rMin.value = rMax.value;
      slot.rand_min = parseFloat(rMin.value); paint();
    });
    rMax.addEventListener("input", () => {
      if (parseFloat(rMax.value) < parseFloat(rMin.value)) rMax.value = rMin.value;
      slot.rand_max = parseFloat(rMax.value); paint();
    });
    for (const r of [rMin, rMax]) r.addEventListener("change", () => writeSlots(node));
    sld.append(rMin, rMax);
    paint();
    const rolled = node._rnRolled?.[String(index)];
    if (rolled !== undefined) {
      // the run told us what this slot actually drew — show that, range in the tooltip
      num.value = fmt(rolled);
      num.classList.add("rolled");
      num.title = `rolled ${fmt(rolled)} last run (range ${fmt(slotMin(slot))} ~ ${fmt(slotMax(slot))})`;
      const tick = document.createElement("div");
      tick.className = "rn-ls-tick";
      tick.style.left = `${pos(rolled)}%`;
      tick.title = `last roll: ${fmt(rolled)}`;
      sld.appendChild(tick);
    } else {
      num.classList.add("rng");
    }
    num.readOnly = true;
    num.title = "random range — drag the handles, or type exact values in Min/Max below";
  } else {
    const range = mkRange(slot.strength);
    range.title = "drag to set strength";
    const paint = () => {
      const v = clamp(slot.strength, sMin, sMax);
      const z = pos(0), p = pos(v);
      fil.style.left = `${Math.min(z, p)}%`;
      fil.style.width = `${Math.abs(p - z)}%`;
      fil.style.background = v < 0 ? "#ef4444" : "#22c55e";
      sld.classList.toggle("neg", v < 0);
      sld.classList.toggle("pos", v >= 0);
      num.value = fmt(slot.strength);
    };
    range.addEventListener("input", () => { slot.strength = parseFloat(range.value); paint(); });
    range.addEventListener("change", () => writeSlots(node));
    num.addEventListener("change", () => {
      const v = parseFloat(num.value);
      if (!isNaN(v)) { slot.strength = v; range.value = String(clamp(v, sMin, sMax)); writeSlots(node); }
      paint();
    });
    sld.append(range);
    paint();
  }
  const control = sld;

  const arrow = document.createElement("button");
  arrow.className = "rn-ls-arrow";
  arrow.textContent = slot._open ? "▲" : "▼";
  arrow.title = "slot options: min/max range, randomize, keywords, remove";
  arrow.onclick = () => { slot._open = !slot._open; render(node); };

  const info = document.createElement("button");
  info.className = "rn-ls-info";
  info.textContent = "ⓘ";
  info.title = "Civitai info for this LoRA (identified by file hash)";
  if (missing) info.className += " missing";
  info.disabled = !slot.name || slot.name === NO_LORA;
  info.style.opacity = info.disabled ? ".35" : "1";
  info.onclick = () => openInfo(node, slot, info);

  row.append(inSelMode(node) ? lead : grip, eye, pick, control, num, info, arrow);
  box.appendChild(row);

  if (slot._open) {
    const exp = document.createElement("div");
    exp.className = "rn-ls-exp";

    // Min/Max set THIS slot's slider end stops; Apply commits them (NO8D-style)
    const mkMini = (label, value) => {
      const l = document.createElement("span"); l.className = "rn-ls-lbl"; l.textContent = label;
      const i = document.createElement("input");
      i.className = "rn-ls-mini"; i.type = "number"; i.step = String(stepOf(node)); i.value = value;
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") apply.click(); });
      return [l, i];
    };
    const [lMin, iMin] = mkMini("Min", fmt(sMin));
    const [lMax, iMax] = mkMini("Max", fmt(sMax));
    const apply = document.createElement("button");
    apply.className = "rn-ls-apply";
    apply.textContent = "Apply";
    apply.title = "apply this Min/Max as the slider's range for this slot";
    apply.onclick = () => {
      const a = parseFloat(iMin.value), b = parseFloat(iMax.value);
      if (isNaN(a) || isNaN(b) || b <= a) { iMin.value = fmt(sMin); iMax.value = fmt(sMax); return; }
      slot.scale_min = a; slot.scale_max = b;
      slot.strength = clamp(slot.strength, a, b);
      slot.rand_min = clamp(slotMin(slot), a, b);
      slot.rand_max = clamp(Math.max(slotMax(slot), slotMin(slot)), a, b);
      writeSlots(node); render(node);
    };

    const rnd = document.createElement("button");
    rnd.className = "rn-ls-rnd" + (slot.random ? " on" : "");
    rnd.textContent = "🎲 Random";
    rnd.title = "roll a strength between min and max on every run (uses the node's seed)";
    rnd.onclick = () => { slot.random = !slot.random; writeSlots(node); render(node); };

    const trig = document.createElement("input");
    trig.className = "rn-ls-trig";
    trig.value = slot.trigger || "";
    trig.placeholder = "keywords (comma separated)";
    trig.title = "added to the keywords output when this slot is active";
    trig.addEventListener("change", () => { slot.trigger = trig.value; writeSlots(node); });

    const note = document.createElement("button");
    note.className = "rn-ls-note" + (slot.note ? " has" : "");
    note.textContent = "📝";
    note.title = slot.note ? `Notes:
${slot.note}` : "add notes about this LoRA";
    note.onclick = (e) => openNote(node, slot, e.clientX, e.clientY);

    const del = document.createElement("button");
    del.className = "rn-ls-del";
    del.textContent = "🗑";
    del.title = "remove this slot";
    del.onclick = () => { node._rnSlots.splice(index, 1); writeSlots(node); render(node); };

    exp.append(lMin, iMin, lMax, iMax, apply, rnd, trig, note, del);
    box.appendChild(exp);
  }
  return box;
}

// ⚙ — stack-wide settings: step size, reset, batch update check
export function openCog(node, anchor) {
  document.querySelector(".rn-ls-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ls-panel";
  m.style.width = "300px";
  const r = anchor.getBoundingClientRect();
  stopEvents(m);

  const hStep = document.createElement("h5");
  hStep.textContent = "Step size (sliders, arrows, scroll)";
  const steps = document.createElement("div");
  steps.className = "rn-ls-steps";
  [0.01, 0.05, 0.1, 0.25].forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v.toFixed(2);
    if (stepOf(node) === v) b.classList.add("on");
    b.onclick = () => {
      node._rnUI = { ...(node._rnUI || {}), step: v };
      writeSlots(node); render(node); m.remove();
    };
    steps.appendChild(b);
  });

  // how coarse the random rolls are — "Smooth" is anywhere in the range
  const hRnd = document.createElement("h5");
  hRnd.textContent = "Random step (how many values per range)";
  const rndRow = document.createElement("div");
  rndRow.className = "rn-ls-steps";
  rndRow.style.flexWrap = "wrap";
  const rndNote = document.createElement("div");
  rndNote.style.cssText = "font-size:10.5px;opacity:.6";
  const curStep = Number(node._rnUI?.rand_step) || 0;
  const describe = () => {
    if (!curStep) { rndNote.textContent = "Smooth: any value in the range."; return; }
    const spans = (node._rnSlots || []).filter((sl) => !isTitle(sl) && sl.random)
      .map((sl) => Math.round((slotMax(sl) - slotMin(sl)) / curStep) + 1);
    rndNote.textContent = spans.length
      ? `${Math.min(...spans)}–${Math.max(...spans)} possible values per randomized slot.`
      : "applies to slots with Random on.";
  };
  [["Smooth", 0], ["0.05", 0.05], ["0.1", 0.1], ["0.25", 0.25], ["0.5", 0.5], ["1.0", 1]]
    .forEach(([label, v]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.flex = "0 0 auto";
      if (curStep === v) b.classList.add("on");
      b.onclick = () => {
        node._rnUI = { ...(node._rnUI || {}), rand_step: v || undefined };
        writeSlots(node); render(node); m.remove();
      };
      rndRow.appendChild(b);
    });
  describe();

  const hSort = document.createElement("h5");
  hSort.textContent = "LoRA list order";
  const sortRow = document.createElement("div");
  sortRow.className = "rn-ls-steps";
  [["Recently added", "recent"], ["A–Z", "alpha"]].forEach(([label, v]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if ((node._rnUI?.sort || "recent") === v) b.classList.add("on");
    b.onclick = () => {
      node._rnUI = { ...(node._rnUI || {}), sort: v };
      writeSlots(node); render(node); m.remove();
    };
    sortRow.appendChild(b);
  });

  const hFil = document.createElement("h5");
  hFil.textContent = "Show only LoRAs for";
  const fil = document.createElement("div");
  fil.className = "rn-ls-steps";
  fil.style.flexWrap = "wrap";
  const mkFilter = (label, value) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.flex = "0 0 auto";
    if ((node._rnUI?.filter || "") === value) b.classList.add("on");
    b.onclick = () => {
      node._rnUI = { ...(node._rnUI || {}), filter: value };
      writeSlots(node); render(node); m.remove();
    };
    return b;
  };
  fil.appendChild(mkFilter("All", ""));
  (kindsCache || []).forEach((k) => fil.appendChild(mkFilter(k, k)));
  const rescan = document.createElement("button");
  rescan.textContent = "Rescan base models";
  rescan.title = "re-read every LoRA's header (do this after adding files)";
  rescan.textContent = "Rescan LoRA folder";
  rescan.onclick = async () => {
    rescan.textContent = "Scanning…";
    namesCache = null; namesPending = null;      // pick up files added since startup
    node._rnNames = await loraNames();
    await loraTypes(true);
    rescan.textContent = "Rescan base models";
    m.remove(); openCog(node, anchor);
  };

  const hDl = document.createElement("h5");
  hDl.textContent = "Download folder (for LoRA updates)";
  const dlWrap = document.createElement("div");
  dlWrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
  const dlNote = document.createElement("div");
  dlNote.style.cssText = "font-size:10.5px;opacity:.6;word-break:break-all";
  dlNote.textContent = "loading…";
  dlWrap.appendChild(dlNote);
  api.fetchApi("/rednode/lora_folders").then((r) => r.json()).then((d) => {
    dlNote.textContent = d.current || "(no loras folder found)";
    if ((d.folders || []).length > 1) {
      const sel = document.createElement("select");
      sel.style.cssText = "background:#15171b;color:#ddd;border:1px solid #33373d;border-radius:4px;padding:5px;font-size:11px";
      d.folders.forEach((f) => {
        const o = document.createElement("option");
        o.value = f; o.textContent = f; o.selected = f === d.current;
        sel.appendChild(o);
      });
      sel.onchange = async () => {
        await api.fetchApi("/rednode/lora_folders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sel.value }),
        });
        dlNote.textContent = sel.value;
      };
      dlWrap.appendChild(sel);
    }
  }).catch(() => { dlNote.textContent = "(unavailable)"; });

  const hAct = document.createElement("h5");
  hAct.textContent = "Actions";
  const reset = document.createElement("button");
  reset.textContent = "Reset all slots to 1.00 (random off)";
  reset.onclick = () => {
    for (const sl of node._rnSlots || []) {
      if (isTitle(sl)) continue;
      sl.strength = 1.0; sl.random = false; sl.enabled = true;
    }
    writeSlots(node); render(node); m.remove();
  };

  const collapse = document.createElement("div");
  collapse.style.cssText = "display:flex;gap:4px";
  const mkFold = (label, open) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.flex = "1";
    b.onclick = () => {
      for (const sl of node._rnSlots || []) { if (!isTitle(sl)) sl._open = open; }
      writeSlots(node); render(node); m.remove();
    };
    return b;
  };
  collapse.append(mkFold("Close all ▲", false), mkFold("Open all ▼", true));

  // ---- presets: save the current stack, or delete one, straight from here -------
  const hPre = document.createElement("h5");
  hPre.textContent = "Presets";
  const refreshPresetWidget = (names) => {
    const w = findWidget(node, "preset");
    if (w) w.options.values = [CUSTOM_SENTINEL, ...names];   // no node refresh needed
  };
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save this stack as a preset…";
  saveBtn.onclick = (e) => {
    m.remove();
    const pm = document.createElement("div");
    pm.className = "rn-ls-panel";
    pm.style.width = "270px";
    stopEvents(pm);
    const ph = document.createElement("h5"); ph.textContent = "Save preset";
    const inp = document.createElement("input");
    const cur = findWidget(node, "preset")?.value;
    inp.value = cur && cur !== CUSTOM_SENTINEL ? cur : "";
    inp.placeholder = "preset name";
    inp.style.cssText = "background:#15171b;color:#ddd;border:1px solid #33373d;border-radius:4px;padding:6px;font-size:12px";
    const note = document.createElement("div");
    note.style.cssText = "font-size:10.5px;opacity:.6";
    note.textContent = "an existing name is overwritten";
    const go = document.createElement("button");
    go.textContent = "Save";
    go.onclick = async () => {
      const name = inp.value.trim();
      if (!name) return;
      go.disabled = true; go.textContent = "Saving…";
      try {
        const r = await api.fetchApi("/rednode/lora_presets", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", name, slots: node._rnSlots || [] }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        refreshPresetWidget(d.presets || []);
        const w = findWidget(node, "preset");
        if (w) w.value = name;                    // the node now IS that preset
        note.textContent = `saved "${name}"`;
        pm.remove(); render(node);
      } catch (err) {
        note.textContent = `could not save: ${err.message}`;
        go.disabled = false; go.textContent = "Save";
      }
    };
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go.click(); if (ev.key === "Escape") pm.remove(); });
    pm.append(ph, inp, note, go);
    document.body.appendChild(pm);
    placePopup(pm, e.clientX, e.clientY);
    inp.focus(); inp.select();
    const close = (ev) => { if (!pm.contains(ev.target)) { pm.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  };
  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete the selected preset";
  delBtn.onclick = async () => {
    const w = findWidget(node, "preset");
    const name = w?.value;
    if (!name || name === CUSTOM_SENTINEL) { delBtn.textContent = "Pick a preset first"; return; }
    delBtn.textContent = "Deleting…";
    try {
      const r = await api.fetchApi("/rednode/lora_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }),
      });
      const d = await r.json();
      refreshPresetWidget(d.presets || []);
      w.value = CUSTOM_SENTINEL;
      m.remove(); render(node);
    } catch (e) { delBtn.textContent = "Delete failed"; }
  };

  const nickBtn = document.createElement("button");
  const nickOn = () => node._rnUI?.nicknames !== false;
  nickBtn.textContent = nickOn() ? "Showing custom names ✓" : "Showing file names";
  nickBtn.title = "switch between each slot's custom name and its real LoRA filename";
  nickBtn.onclick = () => {
    node._rnUI = { ...(node._rnUI || {}), nicknames: !nickOn() };
    writeSlots(node); render(node); m.remove();
  };

  const addTitle = document.createElement("button");
  addTitle.textContent = "Add a group title at the end";
  addTitle.onclick = () => { node._rnSlots.push(newTitle()); writeSlots(node); render(node); m.remove(); };

  const check = document.createElement("button");
  check.textContent = "Check every LoRA for updates";
  const report = document.createElement("div");
  report.className = "rn-ls-rep";
  check.onclick = async () => {
    const names = (node._rnSlots || []).filter((x) => !isTitle(x) && x.name && x.name !== NO_LORA)
      .map((x) => x.name);
    if (!names.length) { report.innerHTML = `<div class="r">No LoRAs in the stack.</div>`; return; }
    check.disabled = true;
    report.innerHTML = `<div class="r">Hashing and checking ${names.length} LoRA(s)… this can take a while the first time.</div>`;
    let results = [];
    try {
      const res = await api.fetchApi("/rednode/lora_check_all", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      results = (await res.json()).results || [];
    } catch (e) {
      report.innerHTML = `<div class="r">Could not reach the ComfyUI backend.</div>`;
      check.disabled = false; return;
    }
    check.disabled = false;
    const esc = (t) => String(t ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const outdated = results.filter((x) => x.update?.available);
    const unknown = results.filter((x) => !x.found);
    let html = "";
    if (outdated.length) {
      html += outdated.map((x) => `<div class="r"><b>⬆ ${esc(shortName(x.name))}</b><br>
        ${esc(x.version || "")} → <b>${esc(x.update.latest)}</b>
        ${x.update.installed_as ? `<br><span style="color:#86d3a1">✓ already downloaded: ${esc(shortName(x.update.installed_as))}</span>` : ""}
        ${x.url ? `<br><a href="${esc(x.url)}" target="_blank">Open on Civitai</a>` : ""}</div>`).join("");
    } else {
      html += `<div class="r" style="color:#86d3a1">✓ Everything found on Civitai is up to date.</div>`;
    }
    if (unknown.length) {
      html += `<div class="r" style="opacity:.7">${unknown.length} not on Civitai (private or locally trained): ${
        unknown.map((x) => esc(shortName(x.name))).join(", ")}</div>`;
    }
    report.innerHTML = html;
  };

  m.append(hStep, steps, hRnd, rndRow, rndNote, hSort, sortRow, hFil, fil, rescan, hDl, dlWrap, hPre, saveBtn, delBtn, hAct, collapse, nickBtn, reset, addTitle, check, report);
  document.body.appendChild(m);
  placePopup(m, r.right, r.top - 4, true);       // sits above-left of the cog
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function panelHeight(node) {
  const slots = node._rnSlots || [];
  let folded = false;
  const rows = slots.reduce((h, s) => {
    // + 12 for the section box's own padding and border
    if (isTitle(s)) { folded = !!s.folded; return h + 30 + 12 + (s._open ? EXP_H : 0) + 5; }
    if (folded) return h;                              // hidden rows take no space
    return h + ROW_H + (s._open ? EXP_H : 0) + 5;
  }, 0);
  return HEAD_H + PAD * 2 + Math.max(ROW_H, rows) + 4 + (inSelMode(node) ? 44 : 0);
}

function buildSelBar(node) {
  const bar = document.createElement("div");
  bar.className = "rn-ls-selbar";
  const sel = selSet(node);
  const idx = () => [...sel].sort((a, b) => a - b);
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = `${sel.size} selected`;

  const mk = (label, fn, danger) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.disabled = !sel.size && label !== "Select all" && label !== "Done";
    if (b.disabled) b.style.opacity = ".4";
    b.onclick = fn;
    return b;
  };

  const all = mk("Select all", () => {
    (node._rnSlots || []).forEach((_, i) => sel.add(i));
    render(node);
  });

  const colour = mk("Colour…", (e) => {
    document.querySelector(".rn-ls-panel")?.remove();
    const m = document.createElement("div");
    m.className = "rn-ls-panel";
    const r = e.target.getBoundingClientRect();
    m.style.width = "240px";
    stopEvents(m);
    const sw = document.createElement("div");
    sw.className = "rn-ls-sw";
    COLORS.forEach((c) => {
      const d = document.createElement("div");
      d.title = c.n;
      d.style.background = c.v || "transparent";
      if (!c.v) d.style.border = "2px dashed #555";
      d.onclick = () => {
        idx().forEach((i) => { if (node._rnSlots[i]) node._rnSlots[i].color = c.v; });
        writeSlots(node); render(node); m.remove();
      };
      sw.appendChild(d);
    });
    const h = document.createElement("h5"); h.textContent = `Colour ${sel.size} row(s)`;
    m.append(h, sw);
    document.body.appendChild(m);
    placePopup(m, r.right, r.top - 4, true);
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  });

  const reset = mk("Reset to 1.00", () => {
    idx().forEach((i) => {
      const sl = node._rnSlots[i];
      if (sl && !isTitle(sl)) { sl.strength = 1.0; sl.random = false; }
    });
    writeSlots(node); render(node);
  });
  const on = mk("Enable", () => {
    idx().forEach((i) => { const sl = node._rnSlots[i]; if (sl && !isTitle(sl)) sl.enabled = true; });
    writeSlots(node); render(node);
  });
  const off = mk("Bypass", () => {
    idx().forEach((i) => { const sl = node._rnSlots[i]; if (sl && !isTitle(sl)) sl.enabled = false; });
    writeSlots(node); render(node);
  });
  const del = mk(`Delete`, () => {
    // splice from the end so earlier indices stay valid
    idx().reverse().forEach((i) => node._rnSlots.splice(i, 1));
    node._rnSel = new Set();
    writeSlots(node); render(node);
  }, true);
  const done = mk("Done", () => exitSel(node));

  bar.append(cnt, all, colour, reset, on, off, del, done);
  return bar;
}

export function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["stack_json"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const list = node._rnListEl;
  if (!list) return;
  if (node._rnFromEl) {
    const f = node._rnUI?.loaded_from;
    node._rnFromEl.textContent = f ? `from preset: ${f}` : "";
    node._rnFromEl.title = f ? `these slots were loaded from "${f}" — edits are not saved back until you save again` : "";
  }
  list.replaceChildren();
  let hideUntilTitle = false;
  // a title opens a section box and the LoRAs under it are appended INSIDE it, so where
  // one group ends and the next begins is visible rather than inferred
  let bucket = list;
  (node._rnSlots || []).forEach((slot, i) => {
    if (isTitle(slot)) {
      hideUntilTitle = !!slot.folded;                  // a folded title swallows its group
      const sec = document.createElement("div");
      sec.className = "rn-ls-section";
      if (slot.color) sec.style.borderLeftColor = slot.color;
      sec.appendChild(buildTitle(node, slot, i));
      list.appendChild(sec);
      bucket = sec;
      return;
    }
    if (hideUntilTitle) return;
    bucket.appendChild(buildSlot(node, slot, i));
  });
  const wrap = node._rnWidget?.element;
  wrap?.querySelector(".rn-ls-selbar")?.remove();
  if (inSelMode(node) && wrap) wrap.insertBefore(buildSelBar(node), wrap.querySelector(".rn-ls-head"));
  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  // Size the node ONCE, when it is first created, then leave it alone. Pinning the height
  // to the slot count meant a long stack could not be shrunk, and scrolling the list beats
  // dragging the canvas around. Width still has a real floor: the sliders need it.
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W),
                  Math.max(node.size[1], Math.min(panelHeight(node), 560))]);
  } else if (node.size[0] < NODE_MIN_W) {
    node.setSize([NODE_MIN_W, node.size[1]]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

// preset at the top, panel in the middle, seed controls at the bottom
function orderWidgets(node) {
  const rank = (w) => {
    if (w.name === "preset") return 0;
    if (w.name === "rednode_lora_ui") return 1;
    if (w.name === "seed") return 2;
    if (/control_after_generate|control_filter/i.test(w.name || "")) return 3;
    return 4;
  };
  node.widgets?.sort((a, b) => rank(a) - rank(b));
}

// Build the panel's guts into any container: the list, and the add / cog row under
// it. The node-specific plumbing (which widget holds the JSON, what "redraw" means)
// stays with the caller.
export function buildLoraPanel(node, container) {
  const head = document.createElement("div");
  head.className = "rn-ls-head";
  const add = document.createElement("button");
  add.className = "rn-ls-add";
  add.textContent = "+";
  add.title = "Add a LoRA slot. It lands on screen with its search already open, so "
            + "you can type or scroll the list straight away.";
  add.onclick = () => {
    node._rnFocusSlot = node._rnSlots.length;      // the index it is about to take
    node._rnSlots.push(newSlot());
    writeSlots(node); render(node);
  };
  const from = document.createElement("span");
  from.className = "rn-ls-from";
  from.style.cssText = "font-size:10.5px;opacity:.55;flex:1;overflow:hidden;"
                     + "text-overflow:ellipsis;white-space:nowrap";
  const cog = document.createElement("button");
  cog.className = "rn-ls-cog";
  cog.textContent = "\u2699";
  cog.title = "stack settings: step size, reset all, check every LoRA for updates";
  cog.onclick = () => openCog(node, cog);
  head.append(add, from, cog);
  node._rnFromEl = from;

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  container.append(list, head);
  node._rnListEl = list;
  loraNames().then((names) => { node._rnNames = names; render(node); });
  loraTypes();
  render(node);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const jsonW = findWidget(node, "stack_json");
  if (!jsonW) { requestAnimationFrame(() => build(node)); return; }

  jsonW.type = "hidden";
  jsonW.hidden = true;
  jsonW.computeSize = () => [0, -4];
  if (jsonW.element) jsonW.element.style.display = "none";
  if (jsonW.inputEl) jsonW.inputEl.style.display = "none";

  node._rnSlots = readSlots(node);

  const wrap = document.createElement("div");
  wrap.className = "rn-ls-wrap";
  stopEvents(wrap);
  bindSliderWheel(wrap);      // wheel over a strength slider adjusts it

  const head = document.createElement("div");
  head.className = "rn-ls-head";
  const add = document.createElement("button");
  add.className = "rn-ls-add";
  add.textContent = "+";
  add.title = "Add a LoRA slot. It lands on screen with its search already open, so "
            + "you can type or scroll the list straight away.";
  add.onclick = () => {
    node._rnFocusSlot = node._rnSlots.length;      // the index it is about to take
    node._rnSlots.push(newSlot());
    writeSlots(node); render(node);
  };
  const from = document.createElement("span");
  from.className = "rn-ls-from";
  from.style.cssText = "font-size:10.5px;opacity:.55;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const cog = document.createElement("button");
  cog.className = "rn-ls-cog";
  cog.textContent = "⚙";
  cog.title = "stack settings: step size, reset all, check every LoRA for updates";
  cog.onclick = () => openCog(node, cog);
  head.append(add, from, cog);
  node._rnFromEl = from;

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  wrap.append(list, head);      // + / cog sit BELOW the slots
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_lora_ui", "rednode_lora_ui", wrap, {
    serialize: false,          // the hidden stack_json widget owns serialization
    getValue: () => jsonW.value,
    setValue: (v) => { jsonW.value = v ?? "[]"; node._rnSlots = readSlots(node); render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  orderWidgets(node);
  // Selecting a preset LOADS it into the slots and drops back to "custom (use stack)",
  // so the panel is always showing exactly what will run. (Leaving the name selected
  // would let you edit slots while the backend quietly used the saved copy instead.)
  const pw = findWidget(node, "preset");
  if (pw && !pw._rnHooked) {
    pw._rnHooked = true;
    const prior = pw.callback;
    pw.callback = async function (value) {
      prior?.apply(this, arguments);
      if (!value || value === CUSTOM_SENTINEL) return;
      try {
        const r = await api.fetchApi(`/rednode/lora_presets?name=${encodeURIComponent(value)}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        node._rnSlots = d.slots || [];
        node._rnUI = { ...(node._rnUI || {}), loaded_from: value };
        writeSlots(node);
      } catch (e) {
        console.error("[RedNode LoRA Stack] could not load preset:", e);
      }
      pw.value = CUSTOM_SENTINEL;            // the slots ARE the preset now
      render(node);
    };
  }

  loraNames().then((names) => { node._rnNames = names; render(node); });
  loraTypes();
  render(node);
}

// the node pushes what each randomized slot drew after every run
api.addEventListener("rednode.lora_rolled", (e) => {
  const d = e.detail || {};
  // nodeById walks subgraphs; getNodeById only sees the top level. And the
  // Workspace's LoRAs tab hosts this same list, so the highlight belongs to any
  // node holding the panel, not just this node type.
  const node = nodeById(d.node);
  if (!node || (node.type !== NODE_NAME && !node._rnStackRead)) return;
  node._rnRolled = d.rolled || {};
  if (node._rnListEl) render(node);
});

// ComfyUI's refresh (R) reloads node definitions but has no idea about the caches in
// this file, so newly-added LoRA files never appeared. Piggyback on it.
if (app.refreshComboInNodes && !app._rnLoraRefreshHooked) {
  app._rnLoraRefreshHooked = true;
  const origRefresh = app.refreshComboInNodes.bind(app);
  app.refreshComboInNodes = async function (...args) {
    namesCache = null; namesPending = null; typesCache = null;
    const out = await origRefresh(...args);
    await Promise.all([loraNames(), loraTypes(true)]);
    // allNodes walks subgraphs, and the Workspace's LoRAs tab hosts this same
    // list, so the refresh reaches every holder of the panel, wherever it sits
    for (const n of allNodes()) {
      if (n.type !== NODE_NAME && !n._rnStackRead) continue;
      n._rnNames = namesCache;
      if (n.type === NODE_NAME || n._rnListEl) render(n);
    }
    return out;
  };
}

app.registerExtension({
  name: "RedNode.LoraStack",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      const node = this;
      requestAnimationFrame(() => { node._rnSlots = readSlots(node); orderWidgets(node); render(node); });
    };
  },
});
