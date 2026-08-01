// RedNode Group Control — every workflow group as a big readable row.
//
// Same approach as RedNode LoRA Stack: a DOM widget over a hidden JSON widget, so the
// text is real HTML (crisp and sizeable) instead of canvas-drawn litegraph text you have
// to zoom into. Rows toggle bypass, jump the canvas to the group, recolour it and fold it
// away; the ⚙ saves named on/off scenes.
//
// Group membership and node modes are pure frontend state, so everything here is frontend
// too — the Python node only stores the panel's config with the workflow.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodes } from "./rednode_graph.js";

const NODE_NAME = "RedNodeGroupControl";
const CUSTOM_SENTINEL = "custom (live)";      // must match group_control.py
const ROW_H = 34;
const HEAD_H = 32;
const PAD = 8;
const NODE_MIN_W = 420;
// The list scrolls, so the node is free to be shorter than its contents — this is the
// floor the panel asks for, NOT the height of every row added up.
const MIN_PANEL_H = 120;
const MODE_ON = 0;                            // LiteGraph ALWAYS
const MODE_BYPASS = 4;                        // ComfyUI bypass (purple)

const TEXT_COLORS = [
  { n: "default (white)", v: null }, { n: "black", v: "#111316" }, { n: "grey", v: "#9aa0a8" },
  { n: "red", v: "#f87171" }, { n: "orange", v: "#fb923c" }, { n: "yellow", v: "#facc15" },
  { n: "green", v: "#4ade80" }, { n: "blue", v: "#60a5fa" }, { n: "purple", v: "#c084fc" },
];
const COLORS = [
  { n: "none", v: null }, { n: "red", v: "#7f2230" }, { n: "orange", v: "#7a4416" },
  { n: "green", v: "#1e5233" }, { n: "teal", v: "#14514f" }, { n: "blue", v: "#1d3f6e" },
  { n: "purple", v: "#492a6b" }, { n: "pink", v: "#6b2450" }, { n: "grey", v: "#3a3f47" },
];

const css = document.createElement("style");
css.textContent = `
.rn-gc-wrap{display:flex;flex-direction:column;gap:6px;padding:${PAD}px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-gc-row{display:flex;align-items:center;gap:7px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none}
/* bypassed: dark slab + red name, not just a faded row — at a glance you could not
   tell a dimmed row from a coloured one, which is the whole point of this panel */
.rn-gc-row.off{opacity:.72;background:#141619}
.rn-gc-row.off .rn-gc-name{color:#ff7b86;text-decoration:line-through;text-decoration-color:#ff7b8666;
  text-decoration-thickness:1px;font-weight:500}
.rn-gc-row.off .rn-gc-eye{border-color:#6b1d26;color:#ff7b86}
.rn-gc-row.off .rn-gc-count{color:#ff7b86;opacity:.6}
.rn-gc-eye{background:#111316;border:1px solid #33373d;border-radius:4px;cursor:pointer;font-size:14px;
  width:34px;height:26px;line-height:1;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;}
.rn-gc-eye:hover{border-color:#b8283c}
.rn-gc-name{flex:1 1 auto;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13.5px;font-weight:600;letter-spacing:.2px}
.rn-gc-count{font-size:10.5px;opacity:.5;flex:none}
.rn-gc-btn{background:#111316;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:15px;line-height:1;width:34px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;}
.rn-gc-btn:hover{color:#fff;border-color:#b8283c}
/* an expanded group's arrow is lit, a collapsed one is not — you can read the state
   without counting rows */
.rn-gc-btn.open{color:#8fb4ff;border-color:#3c4a63;background:#161d29}
.rn-gc-btn.go{font-size:18px;font-weight:700;padding:2px 0}
.rn-gc-chk{width:17px;height:17px;border-radius:4px;border:2px solid #5a616b;background:#111316;cursor:pointer;
  flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;line-height:1}
.rn-gc-chk.on{background:#b8283c;border-color:#b8283c}
.rn-gc-box.sel{outline:2px solid #b8283c}
.rn-gc-selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#2e333b;border:1px solid #b8283c;
  border-radius:5px;padding:6px 8px;flex:none;position:sticky;top:0;z-index:3}
.rn-gc-selbar span.cnt{font-size:11.5px;font-weight:700;color:#e58a97;margin-right:2px}
.rn-gc-selbar button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:4px;padding:4px 9px;
  cursor:pointer;font-size:11px;height:26px;box-sizing:border-box;line-height:16px}
.rn-gc-selbar button:hover{border-color:#b8283c;color:#fff}
.rn-gc-head{display:flex;gap:8px;align-items:center;flex:none;position:sticky;bottom:0;
  padding-top:6px;margin-top:auto;background:#16181c}
.rn-gc-all{background:#1f9d55;border:0;color:#fff;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px}
.rn-gc-none{background:#7f1d1d;border:0;color:#fff;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px}
.rn-gc-cog{background:#111316;border:1px solid #33373d;border-radius:5px;color:#c2c7cd;cursor:pointer;
  font-size:14px;width:34px;height:30px;flex:none;margin-left:auto}
.rn-gc-cog:hover{color:#fff;border-color:#b8283c}
.rn-gc-panel{position:fixed;z-index:10002;width:280px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;padding:10px;font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;
  display:flex;flex-direction:column;gap:8px}
.rn-gc-panel h5{margin:0;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.4px}
.rn-gc-panel button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:4px;padding:6px;
  cursor:pointer;font-size:11.5px}
.rn-gc-panel button:hover{border-color:#b8283c;color:#fff}
.rn-gc-panel input{background:#15171b;color:#ddd;border:1px solid #33373d;border-radius:4px;padding:6px;font-size:12px}
.rn-gc-sw{display:flex;flex-wrap:wrap;gap:5px}
.rn-gc-sw div{width:22px;height:22px;border-radius:4px;cursor:pointer;border:2px solid transparent}
.rn-gc-sw div:hover{border-color:#fff}
.rn-gc-find{display:flex;gap:6px;align-items:center;flex:none}
.rn-gc-find input{flex:1;background:#111316;color:#ddd;border:1px solid #33373d;border-radius:5px;
  padding:6px 9px;font-size:12px}
.rn-gc-find input:focus{outline:none;border-color:#b8283c}
.rn-gc-find button{background:#111316;border:1px solid #33373d;border-radius:5px;color:#9aa0a8;
  cursor:pointer;font-size:12px;width:30px;height:30px;flex:none}
.rn-gc-find button:hover{color:#fff;border-color:#b8283c}
.rn-gc-hit{color:#f0c58a}
.rn-gc-empty{opacity:.5;font-size:12px;padding:6px 2px}
.rn-gc-box{display:flex;flex-direction:column;background:#212429;border-radius:5px;flex:none;overflow:hidden}
.rn-gc-box.active{outline:2px solid #22c55e;box-shadow:0 0 12px #22c55e55}
.rn-gc-box.active .rn-gc-row{background:#14251a}
.rn-gc-grip{cursor:grab;opacity:.4;user-select:none;font-size:11px;letter-spacing:-1px;flex:none}
.rn-gc-kids{display:flex;flex-direction:column;gap:3px;padding:5px 7px 7px;background:#2e333b;
  border-top:1px solid #3d434c}
.rn-gc-kid{display:flex;align-items:center;gap:6px;background:#15171b;border-radius:4px;padding:0 6px;height:26px}
.rn-gc-kid.off{opacity:.72;background:#0e1013}
.rn-gc-kid.off .t{color:#ff7b86;text-decoration:line-through;text-decoration-color:#ff7b8666;
  text-decoration-thickness:1px}
.rn-gc-kid.running{outline:1px solid #22c55e}
.rn-gc-kid.ishidden{opacity:.45;border:1px dashed #4a5058}
.rn-gc-kid button{background:none;border:0;cursor:pointer;font-size:12px;width:22px;flex:none;padding:0}
.rn-gc-kid .t{flex:1;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.rn-gc-kid .ty{font-size:9.5px;opacity:.4;flex:none}
.rn-gc-title.active{outline:2px solid #22c55e;box-shadow:0 0 12px #22c55e55;
  border-left-color:#22c55e}
.rn-gc-title{display:flex;align-items:center;gap:7px;background:#2a2f37;border-left:4px solid #6b7280;
  border-radius:5px;padding:0 8px;height:30px;flex:none}
.rn-gc-title input{flex:1;background:transparent;border:0;color:#e8ecf1;font-size:12px;font-weight:700;
  letter-spacing:.3px;padding:0}
.rn-gc-title input:focus{outline:none}
.rn-gc-hid{background:#111316;border:1px solid #33373d;border-radius:5px;color:#c2c7cd;cursor:pointer;
  font-size:11.5px;padding:5px 10px;flex:none}
.rn-gc-hid:hover{color:#fff;border-color:#b8283c}
.rn-gc-hid.on{background:#3a3f47;color:#fff}
.rn-gc-row.ishidden{opacity:.4;border:1px dashed #4a5058}
.rn-gc-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;flex:none;box-shadow:0 0 6px #22c55e}
/* a section is a real box with its groups indented inside it — a bare title row above a
   flat list gave no clue where the section ended */
.rn-gc-section{display:flex;flex-direction:column;gap:5px;background:#1b1e23;border:1px solid #3d434c;
  border-left:3px solid #6b7280;border-radius:7px;padding:5px;flex:none}
.rn-gc-section > .rn-gc-box{margin-left:12px}
.rn-gc-section > .rn-gc-title{background:transparent;border-left:0;padding-left:2px}
.rn-gc-section.active{border-color:#22c55e;border-left-color:#22c55e}
`;
document.head.appendChild(css);

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

// Progress. `runningNodeId` is the node executing right now; `activeGroup` is stickier —
// it stays on a group until execution actually moves into a DIFFERENT one, so the
// highlight doesn't strobe off between the nodes inside one group (or while an ungrouped
// node runs in between).
let runningNodeId = null;
let activeGroup = null;
// a panel can live inside a subgraph as easily as the groups it drives
const panels = () => findNodes(NODE_NAME);
function onExecChange() { for (const p of panels()) render(p); }

function groupTitleOf(nodeId) {
  if (nodeId == null) return null;
  for (const g of graphGroups()) {
    if (groupNodes(g).some((n) => String(n.id) === String(nodeId))) return groupKey(g);
  }
  return null;
}

api.addEventListener("executing", (e) => {
  const d = e.detail;
  runningNodeId = d && typeof d === "object" ? (d.node ?? null) : (d ?? null);
  if (runningNodeId == null) {
    activeGroup = null;                       // queue finished
  } else {
    const t = groupTitleOf(runningNodeId);
    if (t) activeGroup = t;                   // moved into a group: it owns the highlight
    // an ungrouped node leaves the previous group lit rather than flickering to nothing
  }
  onExecChange();
});
const clearRun = () => { runningNodeId = null; activeGroup = null; onExecChange(); };
api.addEventListener("execution_start", clearRun);
api.addEventListener("execution_success", clearRun);
api.addEventListener("execution_error", clearRun);
api.addEventListener("execution_interrupted", clearRun);
const isRunning = (n) => runningNodeId != null && String(n.id) === String(runningNodeId);

// A section title lights up while the running group sits under it — so a collapsed
// section still tells you execution is in there, without expanding it. Walks forward
// through the FULL item list from the title until the next title starts.
function sectionActive(items, index) {
  if (activeGroup == null) return false;
  for (let i = index + 1; i < items.length; i++) {
    if (items[i].type === "title") return false;
    if (groupKey(items[i].g) === activeGroup) return true;
  }
  return false;
}

// ---- graph helpers (LiteGraph shapes differ across frontend versions) --------
//
// Groups can live inside subgraphs, and app.graph only exposes the top level, so walk
// nested subgraphs too. Where a group came from is kept beside it (not on it) so we
// never mutate litegraph's objects.
const groupMeta = new WeakMap();      // group -> { graph, path }

function graphGroups() {
  const out = [];
  const seenGraphs = new Set();
  const walk = (graph, path) => {
    if (!graph || seenGraphs.has(graph)) return;
    seenGraphs.add(graph);
    for (const grp of (graph._groups || graph.groups || [])) {
      groupMeta.set(grp, { graph, path });
      out.push(grp);
    }
    for (const n of (graph._nodes || graph.nodes || [])) {
      // only descend into a real subgraph — n.graph points back at the PARENT
      const sub = n.subgraph;
      if (sub) walk(sub, [...path, n.title || n.type || "subgraph"]);
    }
  };
  walk(app.graph, []);
  return out;
}

const groupPath = (g) => groupMeta.get(g)?.path || [];
// can the canvas actually scroll to it? only if we are looking at its graph
const groupIsHere = (g) => {
  const owner = groupMeta.get(g)?.graph;
  const shown = app.canvas?.graph || app.graph;
  return !owner || owner === shown;
};
function groupNodes(g) {
  try { g.recomputeInsideNodes?.(); } catch (e) { /* older/newer API */ }
  return g._nodes || g.nodes || [];
}
const groupTitle = (g) => g.title ?? g._title ?? "(untitled group)";
// two subgraphs can both contain a group called "upscale", so config/scene keys are
// qualified by the subgraph path
const groupKey = (g) => {
  const p = groupPath(g);
  return p.length ? `${p.join(" ▸ ")} ▸ ${groupTitle(g)}` : groupTitle(g);
};
const groupBounds = (g) => g._bounding || g.bounding || [0, 0, 0, 0];

// Row colours have to survive being bypassed: fading a coloured row just made it look
// like a different colour. Darkening the SAME hue keeps "which group is this" readable
// while "is it on" is obvious. f < 1 darkens.
function shade(hex, f) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(c * f))));
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// Default is canvas position (top-to-bottom, then left-to-right) because that matches
// how the workflow reads; "graph" is creation order, which is what litegraph gives us.
function sortedGroups(node) {
  const groups = graphGroups().slice();
  const mode = node._rnCfg?.sort || "position";
  if (mode === "alpha") {
    groups.sort((a, b) => groupTitle(a).localeCompare(groupTitle(b)));
  } else if (mode === "position") {
    groups.sort((a, b) => {
      const A = groupBounds(a), B = groupBounds(b);
      return (A[1] - B[1]) || (A[0] - B[0]);
    });
  } else if (mode === "manual") {
    const ord = node._rnCfg?.order || [];
    const rank = (g) => { const i = ord.indexOf(groupTitle(g)); return i < 0 ? 1e9 : i; };
    groups.sort((a, b) => rank(a) - rank(b));
  }
  return groups;
}

// The rows on screen: section titles (from config) interleaved with the live groups.
// Titles only make sense once the order is manual, so adding one switches to it.
function displayItems(node) {
  const groups = sortedGroups(node);
  const byTitle = new Map(groups.map((g) => [groupTitle(g), g]));
  const items = [];
  const seen = new Set();
  if ((node._rnCfg?.sort || "position") === "manual") {
    for (const it of node._rnCfg.order || []) {
      if (typeof it === "string") {                       // legacy: a bare group title
        if (byTitle.has(it)) { items.push({ type: "group", g: byTitle.get(it) }); seen.add(it); }
      } else if (it && it.title !== undefined) {
        items.push({ type: "title", ref: it });
      } else if (it && it.g && byTitle.has(it.g)) {
        items.push({ type: "group", g: byTitle.get(it.g) }); seen.add(it.g);
      }
    }
  }
  for (const g of groups) {                               // anything new lands at the end
    if (!seen.has(groupTitle(g))) items.push({ type: "group", g });
  }
  return items;
}

const itemToEntry = (it) => (it.type === "title" ? it.ref : { g: groupTitle(it.g) });

function ensureManual(node) {
  if ((node._rnCfg.sort || "position") !== "manual") {
    node._rnCfg.order = displayItems(node).map(itemToEntry);
    node._rnCfg.sort = "manual";
  }
  node._rnCfg.order ||= displayItems(node).map(itemToEntry);
}

function groupIsOn(g) {
  const nodes = groupNodes(g);
  if (!nodes.length) return true;
  return nodes.some((n) => n.mode === MODE_ON);
}
function setGroup(g, on) {
  for (const n of groupNodes(g)) n.mode = on ? MODE_ON : MODE_BYPASS;
  app.graph?.setDirtyCanvas(true, true);
}

// centre the canvas on a group without changing zoom
function goToGroup(g) {
  const c = app.canvas;
  const b = groupBounds(g);
  if (!c || !b) return;
  const rect = c.canvas?.getBoundingClientRect?.() || { width: 1200, height: 800 };
  const scale = c.ds?.scale || 1;
  if (c.ds?.offset) {
    c.ds.offset[0] = -(b[0] + b[2] / 2) + rect.width / (2 * scale);
    c.ds.offset[1] = -(b[1] + b[3] / 2) + rect.height / (2 * scale);
  }
  c.setDirty?.(true, true);
}

// ---- config (row colours / folds) lives in the hidden JSON widget -----------
function readCfg(node) {
  const w = findWidget(node, "config");
  try {
    const v = JSON.parse(w?.value || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (e) { return {}; }
}
function writeCfg(node) {
  const w = findWidget(node, "config");
  if (!w) return;
  w.value = JSON.stringify(node._rnCfg || {});
  w.callback?.(w.value);
  node.graph?.setDirtyCanvas(true, true);
}

function placePopup(el, x, y, anchorBottomRight = false) {
  const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
  let left = anchorBottomRight ? x - w : x;
  let top = anchorBottomRight ? y - h : y;
  if (top < pad) top = y + 6;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function stopEvents(el, { wheel = false } = {}) {
  const evs = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup",
               "click", "dblclick", "contextmenu", "keydown"];
  if (wheel) evs.push("wheel");
  for (const ev of evs) el.addEventListener(ev, (e) => e.stopPropagation());
}

// ---- rows -------------------------------------------------------------------
// ---- batch select — same idea as the LoRA Stack's select mode ---------------
// Keyed by groupKey, NOT by row index: the list can be searched, re-sorted or
// dragged between two clicks, and an index would then point at another group.
const selSet = (node) => (node._rnSel = node._rnSel || new Set());
const inSelMode = (node) => !!node._rnSelMode;
function toggleSel(node, key) {
  const sel = selSet(node);
  sel.has(key) ? sel.delete(key) : sel.add(key);
  render(node);
}
function enterSel(node, key) {
  node._rnSelMode = true;
  if (key) selSet(node).add(key);
  render(node);
}
function exitSel(node) {
  node._rnSelMode = false;
  node._rnSel = new Set();
  render(node);
}
const selGroups = (node) => graphGroups().filter((g) => selSet(node).has(groupKey(g)));

function buildRow(node, g, index, order) {
  const title = groupTitle(g);
  const cfg = (node._rnCfg.groups ||= {});
  const gc = (cfg[groupKey(g)] ||= {});
  const on = groupIsOn(g);
  const kids = groupNodes(g);
  const activeHere = activeGroup != null && activeGroup === groupKey(g);
  // declared up front: the name highlight and the fold arrow below both read these
  const hit = matchInfo(node, g);
  const showKids = gc.open || !!hit.nodes;      // a node match opens its group for you

  const key = groupKey(g);
  const selected = inSelMode(node) && selSet(node).has(key);

  const box = document.createElement("div");
  box.className = "rn-gc-box" + (activeHere ? " active" : "") + (selected ? " sel" : "");

  // in select mode the checkbox REPLACES the grip as a direct flex child, so the
  // painted box and its hit area agree (a wrapping span put them a few pixels apart)
  let lead = null;
  if (inSelMode(node)) {
    lead = document.createElement("span");
    lead.className = "rn-gc-chk" + (selected ? " on" : "");
    lead.textContent = selected ? "✓" : "";
    lead.title = "select this group";
    lead.onclick = (e) => { e.stopPropagation(); toggleSel(node, key); };
    box.addEventListener("click", (e) => {          // clicking the row also toggles…
      // …but the eye/arrows and the expanded node rows still do their own thing
      if (e.target.closest("button,input,.rn-gc-kid")) return;
      toggleSel(node, key);
    });
  }

  const row = document.createElement("div");
  row.className = "rn-gc-row" + (on ? "" : " off");
  // the row paints its own background, so the colour has to go HERE — setting it on the
  // container behind was invisible, which is why colours looked like they did nothing
  if (gc.color) {
    const paint = on ? gc.color : shade(gc.color, 0.42);
    row.style.background = paint; box.style.background = paint;
  }
  if (gc.hidden) row.classList.add("ishidden");

  // manual ordering: drag the grip, the list order is stored in the config
  const manual = (node._rnCfg?.sort || "position") === "manual";
  const grip = document.createElement("span");
  grip.className = "rn-gc-grip";
  grip.textContent = "⋮⋮";
  grip.title = manual ? "drag to reorder" : "switch the list to Manual order (⚙) to drag rows";
  grip.style.opacity = manual ? ".55" : ".18";
  if (manual) {
    grip.draggable = true;
    grip.addEventListener("dragstart", (e) => { node._rnFrom = index; e.dataTransfer.effectAllowed = "move"; });
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.style.outline = "2px solid #b8283c"; });
    box.addEventListener("dragleave", () => { box.style.outline = ""; });
    box.addEventListener("drop", (e) => {
      e.preventDefault(); box.style.outline = "";
      dropAt(node, index, order);            // `order` is the full item list
    });
  }

  const eye = document.createElement("button");
  eye.className = "rn-gc-eye";
  eye.textContent = on ? "👁" : "—";
  eye.style.color = on ? "#8fb4ff" : "#666";
  eye.title = on ? "bypass this group" : "enable this group";
  eye.onclick = () => { setGroup(g, !on); render(node); };

  const name = document.createElement("span");
  name.className = "rn-gc-name";
  name.textContent = title;
  name.title = `${title} — click to jump the canvas here`;
  name.style.cursor = "pointer";
  // a bypassed row goes red whatever the chosen text colour — "off" outranks styling
  if (!on) name.style.color = "#ff7b86";
  else if (gc.text_color) name.style.color = gc.text_color;
  if (hit.byName) name.classList.add("rn-gc-hit");
  // in select mode the row click owns the name — jumping away mid-selection is jarring
  name.onclick = () => { if (!inSelMode(node) && groupIsHere(g)) goToGroup(g); };

  let dot = null;
  if (activeHere) {
    dot = document.createElement("span");
    dot.className = "rn-gc-dot";
    dot.title = "running now";
  }

  const path = groupPath(g);
  let badge = null;
  if (path.length) {
    badge = document.createElement("span");
    badge.className = "rn-gc-count";
    badge.textContent = `↳ ${path[path.length - 1]}`;
    badge.title = `inside subgraph: ${path.join(" ▸ ")}`;
    badge.style.color = "#9dc0ff";
  }

  const count = document.createElement("span");
  count.className = "rn-gc-count";
  const nHid = kids.filter((n) => hiddenNodeSet(gc).has(String(n.id))).length;
  count.textContent = `${kids.length} node${kids.length === 1 ? "" : "s"}` +
                      (nHid ? ` · ${nHid} hidden` : "");

  // ▸ expands the group's nodes so any one of them can be bypassed from here
  const fold = document.createElement("button");
  fold.className = "rn-gc-btn" + (showKids ? " open" : "");
  fold.textContent = showKids ? "▾" : "▸";
  fold.title = gc.open ? "hide this group's nodes" : "show this group's nodes";
  fold.onclick = () => { gc.open = !gc.open || undefined; writeCfg(node); render(node); };

  const here = groupIsHere(g);
  const go = document.createElement("button");
  go.className = "rn-gc-btn go";
  go.textContent = "⌖";
  go.disabled = !here;
  go.style.opacity = here ? "1" : ".35";
  go.title = here ? "jump the canvas to this group"
                  : `this group lives inside ${groupPath(g).join(" ▸ ")} — open that subgraph first`;
  go.onclick = () => { if (here) goToGroup(g); };

  // right-click anywhere on the row opens the options (colour, hide, jump) — one arrow
  // on the row instead of two, and it matches the LoRA Stack's right-click behaviour
  box.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openRowMenu(node, g, title, gc, e);
  });
  row.title = `${title} — right-click for colours and options`;

  // The grip and the eye lead EVERY row. They used to be pushed inward on subgraph rows
  // because the badge was appended first, so the one control you aim for moved around.
  row.append(...[lead || grip, eye, dot, name, badge, count, fold, go].filter(Boolean));
  box.appendChild(row);

  if (showKids) {
    const kidsEl = document.createElement("div");
    kidsEl.className = "rn-gc-kids";
    if (!kids.length) {
      const none = document.createElement("div");
      none.className = "rn-gc-empty";
      none.textContent = "this group is empty";
      kidsEl.appendChild(none);
    } else if (!node._rnCfg?.show_hidden &&
               kids.every((n) => hiddenNodeSet(gc).has(String(n.id)))) {
      const none = document.createElement("div");
      none.className = "rn-gc-empty";
      none.textContent = `all ${kids.length} node(s) hidden — use the Hidden button`;
      kidsEl.appendChild(none);
    }
    const hiddenNodes = hiddenNodeSet(gc);
    const showHidden = !!node._rnCfg?.show_hidden;
    for (const n of (hit.nodes || kids)) {
      const nHidden = hiddenNodes.has(String(n.id));
      if (nHidden && !showHidden) continue;            // hidden from view, still runs
      const k = document.createElement("div");
      const kOn = n.mode === MODE_ON;
      k.className = "rn-gc-kid" + (kOn ? "" : " off") + (isRunning(n) ? " running" : "")
                    + (nHidden ? " ishidden" : "");
      k.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        openNodeMenu(node, gc, n, e);
      });
      const kEye = document.createElement("button");
      kEye.textContent = kOn ? "👁" : "—";
      kEye.style.color = kOn ? "#8fb4ff" : "#666";
      kEye.title = kOn ? "bypass this node" : "enable this node";
      kEye.onclick = () => {
        n.mode = kOn ? MODE_BYPASS : MODE_ON;
        app.graph?.setDirtyCanvas(true, true);
        render(node);
      };
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = n.title || n.type || `node ${n.id}`;
      t.title = `${n.type} (#${n.id}) — click to jump here`;
      t.onclick = () => { app.canvas?.centerOnNode?.(n); app.canvas?.setDirty?.(true, true); };
      const ty = document.createElement("span");
      ty.className = "ty";
      ty.textContent = isRunning(n) ? "running" : (n.title && n.type !== n.title ? n.type : "");
      if (isRunning(n)) ty.style.color = "#86d3a1";
      k.append(kEye, t, ty);
      kidsEl.appendChild(k);
    }
    box.appendChild(kidsEl);
  }
  return box;
}

// Per-node hiding: purely visual, stored per group as a list of node ids. Bypass state
// is untouched — a hidden node still runs exactly as before.
const hiddenNodeSet = (gc) => new Set((gc.hidden_nodes || []).map(String));

function toggleNodeHidden(node, gc, id) {
  const set = hiddenNodeSet(gc);
  const key = String(id);
  set.has(key) ? set.delete(key) : set.add(key);
  gc.hidden_nodes = set.size ? [...set] : undefined;
  writeCfg(node); render(node);
}

function openNodeMenu(node, gc, n, ev) {
  document.querySelector(".rn-gc-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-gc-panel";
  m.style.width = "230px";
  stopEvents(m);
  const hidden = hiddenNodeSet(gc).has(String(n.id));
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { fn(); m.remove(); };
    return b;
  };
  const h = document.createElement("h5");
  h.textContent = n.title || n.type || `node ${n.id}`;
  m.append(h,
    mk(hidden ? "Unhide from this list" : "Hide from this list",
       () => toggleNodeHidden(node, gc, n.id)),
    mk(n.mode === MODE_ON ? "Bypass this node" : "Enable this node", () => {
      n.mode = n.mode === MODE_ON ? MODE_BYPASS : MODE_ON;
      app.graph?.setDirtyCanvas(true, true);
      render(node);
    }),
    mk("Jump to node", () => { app.canvas?.centerOnNode?.(n); app.canvas?.setDirty?.(true, true); }),
  );
  document.body.appendChild(m);
  placePopup(m, ev.clientX, ev.clientY);
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function buildTitleRow(node, ref, index, items) {
  const live = sectionActive(items, index);
  const box = document.createElement("div");
  box.className = "rn-gc-title" + (live ? " active" : "");
  if (ref.color) { box.style.background = ref.color; box.style.borderLeftColor = "#ffffff44"; }

  const grip = document.createElement("span");
  grip.className = "rn-gc-grip";
  grip.textContent = "⋮⋮";
  grip.title = "drag to reorder";
  grip.draggable = true;
  grip.style.opacity = ".55";
  grip.addEventListener("dragstart", (e) => { node._rnFrom = index; e.dataTransfer.effectAllowed = "move"; });
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.style.outline = "2px solid #b8283c"; });
  box.addEventListener("dragleave", () => { box.style.outline = ""; });
  box.addEventListener("drop", (e) => { e.preventDefault(); box.style.outline = ""; dropAt(node, index, items); });

  const fold = document.createElement("button");
  fold.className = "rn-gc-btn" + (ref.folded ? "" : " open");
  fold.textContent = ref.folded ? "▸" : "▾";
  fold.title = ref.folded ? "show this section" : "collapse this section";
  fold.onclick = () => { ref.folded = !ref.folded || undefined; writeCfg(node); render(node); };

  const txt = document.createElement("input");
  txt.value = ref.title || "";
  txt.placeholder = "section name";
  if (ref.text_color) txt.style.color = ref.text_color;
  txt.addEventListener("change", () => { ref.title = txt.value; writeCfg(node); });

  box.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openTitleMenu(node, ref, index, e);
  });

  box.append(grip, fold, txt);
  if (live) {
    const dot = document.createElement("span");
    dot.className = "rn-gc-dot";
    dot.title = ref.folded ? "a group in this collapsed section is running" : "a group in this section is running";
    box.appendChild(dot);
  }
  return box;
}

function dropAt(node, index, items) {
  const from = node._rnFrom;
  if (from == null || from === index) return;
  ensureManual(node);
  const next = items.map(itemToEntry);
  const [m] = next.splice(from, 1);
  next.splice(index, 0, m);
  node._rnCfg.order = next;
  writeCfg(node); render(node);
}

function openTitleMenu(node, ref, index, ev) {
  document.querySelector(".rn-gc-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-gc-panel";
  stopEvents(m);
  const swatches = (label, list, get, set) => {
    const h = document.createElement("h5"); h.textContent = label;
    const sw = document.createElement("div"); sw.className = "rn-gc-sw";
    list.forEach((c) => {
      const d = document.createElement("div");
      d.title = c.n;
      d.style.background = c.v || "#e8ecf1";
      if (!c.v) d.style.outline = "1px dashed #6b7280";
      if ((get() || null) === c.v) d.style.borderColor = "#fff";
      d.onclick = () => { set(c.v); writeCfg(node); render(node); m.remove(); };
      sw.appendChild(d);
    });
    return [h, sw];
  };
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { fn(); m.remove(); };
    return b;
  };
  m.append(
    ...swatches("Bar colour", COLORS, () => ref.color, (v) => { ref.color = v || undefined; }),
    ...swatches("Text colour", TEXT_COLORS, () => ref.text_color, (v) => { ref.text_color = v || undefined; }),
    mk("Remove section title", () => {
      ensureManual(node);
      const next = (node._rnCfg.order || []).slice();
      const at = next.findIndex((e) => e === ref);
      if (at >= 0) next.splice(at, 1);
      node._rnCfg.order = next;
      writeCfg(node); render(node);
    }),
  );
  document.body.appendChild(m);
  placePopup(m, ev.clientX, ev.clientY);
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function openRowMenu(node, g, title, gc, ev) {
  document.querySelector(".rn-gc-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-gc-panel";
  stopEvents(m);

  const mkSwatches = (label, get, set, list = COLORS) => {
    const h = document.createElement("h5"); h.textContent = label;
    const sw = document.createElement("div"); sw.className = "rn-gc-sw";
    list.forEach((c) => {
      const d = document.createElement("div");
      d.title = c.n;
      d.style.background = c.v || (list === TEXT_COLORS ? "#e8ecf1" : "transparent");
      if (!c.v && list !== TEXT_COLORS) d.style.border = "2px dashed #555";
      if ((get() || null) === c.v) d.style.borderColor = "#fff";
      d.onclick = () => { set(c.v); writeCfg(node); render(node); m.remove(); };
      sw.appendChild(d);
    });
    return [h, sw];
  };

  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { fn(); m.remove(); };
    return b;
  };

  m.append(
    ...mkSwatches("Row colour", () => gc.color, (v) => { gc.color = v || undefined; }),
    ...mkSwatches("Group colour on canvas", () => g.color, (v) => {
      g.color = v || undefined;                     // recolours the actual group
      app.graph?.setDirtyCanvas(true, true);
      app.graph?.change?.();                        // mark dirty so the colour is saved
    }),
    ...mkSwatches("Text colour", () => gc.text_color, (v) => { gc.text_color = v || undefined; },
                  TEXT_COLORS),
    mk(gc.open ? "Hide this group's nodes" : "Show this group's nodes",
       () => { gc.open = !gc.open || undefined; writeCfg(node); render(node); }),
    mk(groupIsOn(g) ? "Bypass this group" : "Enable this group",
       () => { setGroup(g, !groupIsOn(g)); render(node); }),
    mk("Jump to group", () => goToGroup(g)),
    mk("Select multiple groups…", () => enterSel(node, groupKey(g))),
    mk(gc.hidden ? "Unhide from this list" : "Hide from this list",
       () => { gc.hidden = gc.hidden ? undefined : true; writeCfg(node); render(node); }),
    mk("Add section title above", () => {
      ensureManual(node);
      const items = displayItems(node);
      const at = items.findIndex((i) => i.type === "group" && i.g === g);
      const next = items.map(itemToEntry);
      next.splice(Math.max(0, at), 0, { title: "Section", color: "#3a3f47" });
      node._rnCfg.order = next;
      writeCfg(node); render(node);
    }),
  );
  document.body.appendChild(m);
  placePopup(m, ev.clientX, ev.clientY);
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- ⚙ : scenes + list options ---------------------------------------------
function openCog(node, anchor) {
  document.querySelector(".rn-gc-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-gc-panel";
  m.style.width = "300px";
  stopEvents(m);
  const r = anchor.getBoundingClientRect();

  const currentStates = () => {
    const out = {};
    for (const g of graphGroups()) out[groupTitle(g)] = groupIsOn(g);
    return out;
  };
  const setSceneWidget = (names) => {
    const w = findWidget(node, "scene");
    if (w) w.options.values = [CUSTOM_SENTINEL, ...names];
  };

  const hS = document.createElement("h5");
  hS.textContent = "Scenes (saved on/off sets)";
  const save = document.createElement("button");
  save.textContent = "Save current on/off as a scene…";
  save.onclick = (e) => {
    m.remove();
    const pm = document.createElement("div");
    pm.className = "rn-gc-panel";
    stopEvents(pm);
    const h = document.createElement("h5"); h.textContent = "Save scene";
    const inp = document.createElement("input");
    const cur = findWidget(node, "scene")?.value;
    inp.value = cur && cur !== CUSTOM_SENTINEL ? cur : "";
    inp.placeholder = "e.g. fast draft";
    const note = document.createElement("div");
    note.style.cssText = "font-size:10.5px;opacity:.6";
    note.textContent = `${Object.keys(currentStates()).length} group(s) will be recorded`;
    const go = document.createElement("button");
    go.textContent = "Save";
    go.onclick = async () => {
      const name = inp.value.trim();
      if (!name) return;
      go.disabled = true; go.textContent = "Saving…";
      try {
        const res = await api.fetchApi("/rednode/group_scenes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", name, states: currentStates() }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        setSceneWidget(d.scenes || []);
        const w = findWidget(node, "scene");
        if (w) w.value = name;
        pm.remove();
      } catch (err) {
        note.textContent = `could not save: ${err.message}`;
        go.disabled = false; go.textContent = "Save";
      }
    };
    inp.addEventListener("keydown", (ev2) => { if (ev2.key === "Enter") go.click(); if (ev2.key === "Escape") pm.remove(); });
    pm.append(h, inp, note, go);
    document.body.appendChild(pm);
    placePopup(pm, e.clientX, e.clientY);
    inp.focus(); inp.select();
    const close = (ev2) => { if (!pm.contains(ev2.target)) { pm.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  };

  const del = document.createElement("button");
  del.textContent = "Delete the selected scene";
  del.onclick = async () => {
    const w = findWidget(node, "scene");
    if (!w?.value || w.value === CUSTOM_SENTINEL) { del.textContent = "Pick a scene first"; return; }
    const res = await api.fetchApi("/rednode/group_scenes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: w.value }),
    });
    const d = await res.json();
    setSceneWidget(d.scenes || []);
    w.value = CUSTOM_SENTINEL;
    m.remove();
  };

  const hO = document.createElement("h5");
  hO.textContent = "Order";
  const ordRow = document.createElement("div");
  ordRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
  [["Canvas position", "position"], ["A–Z", "alpha"], ["Graph order", "graph"], ["Manual", "manual"]]
    .forEach(([label, v]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.flex = "1 0 auto";
      if ((node._rnCfg?.sort || "position") === v) {
        b.style.background = "#b8283c"; b.style.borderColor = "#b8283c"; b.style.color = "#fff";
      }
      b.onclick = () => {
        node._rnCfg.sort = v;
        // seed Manual from whatever is on screen now, so dragging starts from the current view
        if (v === "manual" && !node._rnCfg.order) {
          node._rnCfg.order = sortedGroups(node).map(groupTitle);
        }
        writeCfg(node); render(node); m.remove();
      };
      ordRow.appendChild(b);
    });

  const hL = document.createElement("h5");
  hL.textContent = "List";
  const addSection = document.createElement("button");
  addSection.textContent = "Add a section title at the end";
  addSection.onclick = () => {
    ensureManual(node);
    node._rnCfg.order = [...displayItems(node).map(itemToEntry), { title: "Section", color: "#3a3f47" }];
    writeCfg(node); render(node); m.remove();
  };

  const expandAll = document.createElement("button");
  const anyOpen = Object.values(node._rnCfg.groups || {}).some((x) => x.open);
  expandAll.textContent = anyOpen ? "Collapse all node lists" : "Expand all node lists";
  expandAll.onclick = () => {
    for (const g of graphGroups()) {
      const gc = (node._rnCfg.groups ||= {})[groupTitle(g)] ||= {};
      gc.open = anyOpen ? undefined : true;
    }
    writeCfg(node); render(node); m.remove();
  };
  const unhide = document.createElement("button");
  const gcAll = Object.values(node._rnCfg.groups || {});
  const hidden = gcAll.filter((x) => x.hidden).length +
                 gcAll.reduce((a, x) => a + (x.hidden_nodes?.length || 0), 0);
  unhide.textContent = hidden ? `Unhide all (${hidden})` : "Nothing is hidden";
  unhide.onclick = () => {
    for (const gc of Object.values(node._rnCfg.groups || {})) {
      delete gc.hidden;
      delete gc.hidden_nodes;
    }
    writeCfg(node); render(node); m.remove();
  };
  const clearCols = document.createElement("button");
  clearCols.textContent = "Clear row colours";
  clearCols.onclick = () => {
    for (const gc of Object.values(node._rnCfg.groups || {})) delete gc.color;
    writeCfg(node); render(node); m.remove();
  };

  m.append(hS, save, del, hO, ordRow, hL, addSection, expandAll, unhide, clearCols);
  document.body.appendChild(m);
  placePopup(m, r.right, r.top - 4, true);
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- render -----------------------------------------------------------------
// Filters an ALREADY-BUILT item list. It must not rebuild the list itself: render needs
// the visible rows to be the same objects as the full list so indexOf() gives a real
// index for drag-reorder (rebuilding produced fresh objects and every index came back -1).
const nodeLabel = (n) => `${n.title || ""} ${n.type || ""}`.toLowerCase();

// A group matches if its own name matches, or if any node inside it does. Node-level
// matches auto-expand that group and narrow it to the matching nodes.
function matchInfo(node, g) {
  const q = (node._rnQuery || "").trim().toLowerCase();
  if (!q) return { show: true, byName: false, nodes: null };
  if (groupTitle(g).toLowerCase().includes(q)) return { show: true, byName: true, nodes: null };
  const hits = groupNodes(g).filter((n) => nodeLabel(n).includes(q));
  return { show: hits.length > 0, byName: false, nodes: hits.length ? hits : null };
}

function visibleItems(node, items) {
  const showHidden = !!node._rnCfg?.show_hidden;
  const out = [];
  let folded = false;
  const searching = !!(node._rnQuery || "").trim();
  for (const it of items) {
    if (it.type === "title") {
      folded = !!it.ref.folded;
      if (!searching) out.push(it);                          // titles are noise in results
      continue;
    }
    if (folded && !searching) continue;                      // inside a collapsed section
    const gc = node._rnCfg?.groups?.[groupKey(it.g)];
    if (gc?.hidden && !showHidden) continue;
    if (searching && !matchInfo(node, it.g).show) continue;
    out.push(it);
  }
  return out;
}

function panelHeight(node) {
  let h = 0;
  for (const it of visibleItems(node, displayItems(node))) {
    if (it.type === "title") { h += 35 + 12; continue; }   // + the section box padding
    h += ROW_H + 5;
    const gc = node._rnCfg?.groups?.[groupKey(it.g)];
    const hit = matchInfo(node, it.g);
    if (gc?.open || hit.nodes) {
      h += 12 + Math.max(1, (hit.nodes || groupNodes(it.g)).length) * 29;
    }
  }
  return HEAD_H + PAD * 2 + Math.max(ROW_H, h) + 4 + (inSelMode(node) ? 46 : 0);
}

function buildSelBar(node) {
  const bar = document.createElement("div");
  bar.className = "rn-gc-selbar";
  const sel = selSet(node);
  const picked = () => selGroups(node);
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = `${sel.size} selected`;

  const mk = (label, fn, always) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !sel.size && !always;
    if (b.disabled) b.style.opacity = ".4";
    b.onclick = fn;
    return b;
  };

  // "Select all" means everything currently listed, so a search narrows what it grabs
  const shown = visibleItems(node, displayItems(node)).filter((i) => i.type === "group");
  const allPicked = shown.length > 0 && shown.every((i) => sel.has(groupKey(i.g)));
  const all = mk(allPicked ? "Select none" : "Select all", () => {
    if (allPicked) sel.clear();
    else shown.forEach((i) => sel.add(groupKey(i.g)));
    render(node);
  }, true);

  const colour = mk("Colour…", (e) => {
    document.querySelector(".rn-gc-panel")?.remove();
    const m = document.createElement("div");
    m.className = "rn-gc-panel";
    stopEvents(m);
    const r = e.target.getBoundingClientRect();
    const swatches = (label, apply, list = COLORS) => {
      const h = document.createElement("h5"); h.textContent = label;
      const sw = document.createElement("div"); sw.className = "rn-gc-sw";
      list.forEach((c) => {
        const d = document.createElement("div");
        d.title = c.n;
        d.style.background = c.v || (list === TEXT_COLORS ? "#e8ecf1" : "transparent");
        if (!c.v && list !== TEXT_COLORS) d.style.border = "2px dashed #555";
        d.onclick = () => { picked().forEach((g) => apply(g, c.v)); writeCfg(node); render(node); m.remove(); };
        sw.appendChild(d);
      });
      return [h, sw];
    };
    const head = document.createElement("h5");
    head.textContent = `${sel.size} group(s)`;
    m.append(
      head,
      ...swatches("Row colour", (g, v) => {
        ((node._rnCfg.groups ||= {})[groupKey(g)] ||= {}).color = v || undefined;
      }),
      ...swatches("Group colour on canvas", (g, v) => {
        g.color = v || undefined;
        app.graph?.setDirtyCanvas(true, true);
        app.graph?.change?.();
      }),
      ...swatches("Text colour", (g, v) => {
        ((node._rnCfg.groups ||= {})[groupKey(g)] ||= {}).text_color = v || undefined;
      }, TEXT_COLORS),
    );
    document.body.appendChild(m);
    placePopup(m, r.right, r.top - 4, true);
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  });

  const on = mk("Enable", () => { picked().forEach((g) => setGroup(g, true)); render(node); });
  const off = mk("Bypass", () => { picked().forEach((g) => setGroup(g, false)); render(node); });
  const hide = mk("Hide", () => {
    picked().forEach((g) => { ((node._rnCfg.groups ||= {})[groupKey(g)] ||= {}).hidden = true; });
    writeCfg(node); render(node);
  });
  const show = mk("Unhide", () => {
    picked().forEach((g) => { ((node._rnCfg.groups ||= {})[groupKey(g)] ||= {}).hidden = undefined; });
    writeCfg(node); render(node);
  });
  const done = mk("Done", () => exitSel(node), true);

  bar.append(cnt, all, colour, on, off, hide, show, done);
  return bar;
}

function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["config"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const list = node._rnListEl;
  if (!list) return;
  list.replaceChildren();
  const all = displayItems(node);
  const shown = visibleItems(node, all);          // same objects, so indexOf() is valid
  const groupsExist = all.some((i) => i.type === "group");
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "rn-gc-empty";
    empty.textContent = (node._rnQuery || "").trim()
      ? `nothing matches "${node._rnQuery}"`
      : (groupsExist ? "everything is hidden or collapsed — use the Hidden button or ⚙"
                     : "no groups in this workflow yet");
    list.appendChild(empty);
  } else {
    // indices are into the FULL item list so drag-reorder stays correct while filtered.
    // A title opens a section box; the groups after it are appended INSIDE that box.
    let bucket = list;
    shown.forEach((it) => {
      const idx = all.indexOf(it);
      if (it.type === "title") {
        const sec = document.createElement("div");
        sec.className = "rn-gc-section" + (sectionActive(all, idx) ? " active" : "");
        if (it.ref.color) sec.style.borderLeftColor = it.ref.color;
        sec.appendChild(buildTitleRow(node, it.ref, idx, all));
        list.appendChild(sec);
        bucket = sec;
        return;
      }
      bucket.appendChild(buildRow(node, it.g, idx, all));
    });
  }
  if (node._rnHidBtn) {
    const gcs = Object.values(node._rnCfg?.groups || {});
    const hidden = gcs.filter((x) => x.hidden).length +
                   gcs.reduce((a, x) => a + (x.hidden_nodes?.length || 0), 0);
    node._rnHidBtn.textContent = node._rnCfg?.show_hidden
      ? `Hiding off (${hidden})` : `Hidden: ${hidden}`;
    node._rnHidBtn.classList.toggle("on", !!node._rnCfg?.show_hidden);
    node._rnHidBtn.style.display = hidden || node._rnCfg?.show_hidden ? "" : "none";
    node._rnHidBtn.title = node._rnCfg?.show_hidden
      ? "hidden groups and nodes are being shown (dashed) — click to conceal them again"
      : `${hidden} group(s)/node(s) hidden from this list — click to show them`;
  }
  const wrap = node._rnWidget?.element;
  wrap?.querySelector(".rn-gc-selbar")?.remove();
  if (inSelMode(node) && wrap) wrap.insertBefore(buildSelBar(node), wrap.firstChild);
  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  // Size the node ONCE, when it is first created, then leave it alone: pinning the height
  // to the row count meant a big workflow could not be shrunk, and dragging the canvas
  // around beat scrolling a list that already scrolls.
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W),
                  Math.max(node.size[1], Math.min(panelHeight(node), 520))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const cfgW = findWidget(node, "config");
  if (!cfgW) { requestAnimationFrame(() => build(node)); return; }
  cfgW.type = "hidden";
  cfgW.hidden = true;
  cfgW.computeSize = () => [0, -4];
  if (cfgW.element) cfgW.element.style.display = "none";
  if (cfgW.inputEl) cfgW.inputEl.style.display = "none";

  node._rnCfg = readCfg(node);

  const wrap = document.createElement("div");
  wrap.className = "rn-gc-wrap";
  stopEvents(wrap);
  const find = document.createElement("div");
  find.className = "rn-gc-find";
  const q = document.createElement("input");
  q.placeholder = "search groups and nodes…";
  q.value = node._rnQuery || "";
  const clearQ = document.createElement("button");
  clearQ.textContent = "✕";
  clearQ.title = "clear the search";
  const applyQuery = (v) => {
    node._rnQuery = v;                       // transient: never saved into the workflow
    render(node);
    const el = node._rnWidget?.element?.querySelector(".rn-gc-find input");
    if (el && document.activeElement !== el) el.value = v;
  };
  q.addEventListener("input", () => applyQuery(q.value));
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; applyQuery(""); q.blur(); } });
  clearQ.onclick = () => { q.value = ""; applyQuery(""); };
  find.append(q, clearQ);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  const head = document.createElement("div");
  head.className = "rn-gc-head";
  const all = document.createElement("button");
  all.className = "rn-gc-all";
  all.textContent = "All on";
  all.onclick = () => { for (const g of graphGroups()) setGroup(g, true); render(node); };
  const none = document.createElement("button");
  none.className = "rn-gc-none";
  none.textContent = "All off";
  none.onclick = () => { for (const g of graphGroups()) setGroup(g, false); render(node); };
  const hid = document.createElement("button");
  hid.className = "rn-gc-hid";
  hid.onclick = () => {
    node._rnCfg.show_hidden = !node._rnCfg.show_hidden || undefined;
    writeCfg(node); render(node);
  };
  node._rnHidBtn = hid;

  const cog = document.createElement("button");
  cog.className = "rn-gc-cog";
  cog.textContent = "⚙";
  cog.title = "scenes and list options";
  cog.onclick = () => openCog(node, cog);
  head.append(all, none, hid, cog);
  wrap.append(find, list, head);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_group_ui", "rednode_group_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnCfg = readCfg(node); render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  // picking a scene applies it, then drops back to "custom (live)" — the groups are
  // the truth, and you are free to flip individual ones afterwards
  const sw = findWidget(node, "scene");
  if (sw && !sw._rnHooked) {
    sw._rnHooked = true;
    const prior = sw.callback;
    sw.callback = async function (value) {
      prior?.apply(this, arguments);
      if (!value || value === CUSTOM_SENTINEL) return;
      try {
        const res = await api.fetchApi(`/rednode/group_scenes?name=${encodeURIComponent(value)}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        const states = d.states || {};
        for (const g of graphGroups()) {
          const t = groupTitle(g);
          if (t in states) setGroup(g, states[t]);     // groups not in the scene are left alone
        }
      } catch (e) {
        console.error("[RedNode Group Control] could not apply scene:", e);
      }
      sw.value = CUSTOM_SENTINEL;
      render(node);
    };
  }

  render(node);
  // groups are edited on the canvas, not here — poll lightly so the list stays honest
  node._rnPoll = setInterval(() => {
    if (!node.graph) { clearInterval(node._rnPoll); return; }
    const sig = graphGroups().map((g) => {
      const kids = groupNodes(g);
      return `${groupTitle(g)}:${kids.length}:${kids.map((n) => n.mode).join(",")}`;
    }).join("|");
    if (sig !== node._rnSig) { node._rnSig = sig; render(node); }
  }, 700);
}

app.registerExtension({
  name: "RedNode.GroupControl",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._rnPoll) clearInterval(this._rnPoll);
      onRemoved?.apply(this, arguments);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      const node = this;
      requestAnimationFrame(() => { node._rnCfg = readCfg(node); render(node); });
    };
  },
});
