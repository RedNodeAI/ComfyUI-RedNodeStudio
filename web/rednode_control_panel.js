import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { colorTargets, setColor } from "./rednode_palette.js";
import { findNodes } from "./rednode_graph.js";
import { newBadge, newestFirst } from "./rednode_recent.js";
import { bindSliderWheel } from "./rednode_wheel.js";

// RedNode Control Panel (Stage 3) — every dropdown you actually change, in one list.
//
// Each row points at another node's combo/toggle and sets it directly in the frontend,
// so the target serializes the value we chose (no wires, no COMBO edges). Same panel
// language as RedNode LoRA Stack and RedNode Group Control: searchable picker, drag
// order, section titles, colours, batch select and saved scenes.
//
// `config` (hidden JSON widget) is the source of truth. Rows are stored in display order,
// so there is no separate order list to keep in sync.

const NODE_NAME = "RedNodeControlPanel";
const CUSTOM_SENTINEL = "custom (live)";      // must match control_panel.py
const ROW_H = 34;
const HEAD_H = 32;
const PAD = 8;
const NODE_MIN_W = 460;
// The list scrolls, so the node is free to be shorter than its contents.
const MIN_PANEL_H = 120;

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
.rn-cp-wrap{display:flex;flex-direction:column;gap:6px;padding:${PAD}px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-cp-row{display:flex;align-items:center;gap:7px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none}
/* parked rows read as off at a glance, the same way a bypassed group does */
.rn-cp-row.off{opacity:.72;background:#141619}
.rn-cp-row.off .rn-cp-name{color:#ff7b86;text-decoration:line-through;text-decoration-color:#ff7b8666;
  text-decoration-thickness:1px}
.rn-cp-row.off .rn-cp-eye{border-color:#6b1d26;color:#ff7b86}
.rn-cp-row.missing{outline:1px dashed #7f1d1d}
.rn-cp-eye{background:#111316;border:1px solid #33373d;border-radius:4px;cursor:pointer;font-size:13px;
  width:30px;height:24px;line-height:1;flex:none;color:#8fb4ff;display:inline-flex;align-items:center;justify-content:center;padding:0;}
.rn-cp-eye:hover{border-color:#b8283c}
.rn-cp-name{flex:1 1 auto;min-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;letter-spacing:.2px;cursor:pointer}
.rn-cp-sub{font-size:10px;opacity:.45;font-weight:400;margin-left:5px}
.rn-cp-val{flex:0 1 190px;min-width:90px;background:#15171b;color:#e8ecf1;border:1px solid #33373d;
  border-radius:4px;padding:5px 6px;font-size:11.5px;height:26px;box-sizing:border-box}
.rn-cp-val:hover{border-color:#b8283c}
.rn-cp-val:disabled{opacity:.5;cursor:not-allowed}
/* numeric rows: the bar and its value share the space a dropdown would have taken, so
   a mixed panel keeps one column edge whatever kind of control each row carries */
.rn-cp-numwrap{flex:0 1 190px;min-width:90px;display:flex;align-items:center;gap:5px}
.rn-cp-numbar{flex:1 1 auto;min-width:40px;height:18px;accent-color:#b8283c;margin:0}
.rn-cp-numval{flex:0 0 62px;width:62px;background:#15171b;color:#e8ecf1;border:1px solid #33373d;
  border-radius:4px;padding:5px 4px;font-size:11.5px;height:26px;box-sizing:border-box}
.rn-cp-numval:hover{border-color:#b8283c}
/* the range boxes read as unfilled on purpose: they are a question, not a setting */
.rn-cp-numend{flex:0 0 52px;width:52px;background:#111316;color:#c2c7cd;border:1px dashed #444a52;
  border-radius:4px;padding:5px 4px;font-size:11px;height:26px;box-sizing:border-box}
.rn-cp-numend:hover{border-color:#b8283c}
.rn-cp-numend::placeholder{color:#6d747c}
.rn-cp-sw{background:#15171b;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:11px;font-weight:700;letter-spacing:.5px;height:26px;width:74px;flex:none}
.rn-cp-sw.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4}
.rn-cp-btn{background:#111316;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:11px;padding:4px 0;width:30px;flex:none}
.rn-cp-btn:hover{color:#fff;border-color:#b8283c}
.rn-cp-new{margin-left:8px;font-size:9.5px;font-weight:700;letter-spacing:.3px;
  color:#86d3a1;border:1px solid #2f6b41;border-radius:3px;padding:0 4px;
  flex:none;vertical-align:middle}
.rn-cp-pick .grp .new{float:right;font-size:9.5px;font-weight:700;color:#86d3a1;
  border:1px solid #2f6b41;border-radius:3px;padding:0 4px;margin-left:10px}
.rn-cp-grip{cursor:grab;opacity:.4;user-select:none;font-size:11px;letter-spacing:-1px;flex:none}
.rn-cp-title{display:flex;align-items:center;gap:7px;background:#2a2f37;border-left:4px solid #6b7280;
  border-radius:5px;padding:0 8px;height:30px;flex:none}
.rn-cp-title input{flex:1;background:transparent;border:0;color:#e8ecf1;font-size:12px;font-weight:700;
  letter-spacing:.3px;padding:0}
.rn-cp-title input:focus{outline:none}
/* a section is a real box with its controls indented inside it, same as the LoRA Stack
   and Group Control — a bare title above a flat list gave no clue where it ended */
.rn-cp-section{display:flex;flex-direction:column;gap:5px;background:#1b1e23;border:1px solid #3d434c;
  border-left:3px solid #6b7280;border-radius:7px;padding:5px;flex:none}
.rn-cp-section > .rn-cp-row{margin-left:12px}
.rn-cp-section > .rn-cp-title{background:transparent;border-left:0;padding-left:2px}
.rn-cp-head{display:flex;gap:8px;align-items:center;flex:none;position:sticky;bottom:0;
  padding-top:6px;margin-top:auto;background:#16181c}
.rn-cp-add{background:#b8283c;border:0;color:#fff;border-radius:5px;padding:6px 12px;cursor:pointer;
  font-size:12px;font-weight:600}
.rn-cp-apply{background:#1f9d55;border:0;color:#fff;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px}
.rn-cp-cog{background:#111316;border:1px solid #33373d;border-radius:5px;color:#c2c7cd;cursor:pointer;
  font-size:14px;width:34px;height:30px;flex:none;margin-left:auto}
.rn-cp-cog:hover{color:#fff;border-color:#b8283c}
.rn-cp-find{display:flex;gap:6px;align-items:center;flex:none}
.rn-cp-find input{flex:1;background:#15171b;border:1px solid #2a2e35;border-radius:5px;color:#ddd;
  font-size:11.5px;padding:5px 8px}
.rn-cp-find button{background:#15171b;border:1px solid #2a2e35;border-radius:5px;color:#9aa0a8;
  cursor:pointer;font-size:11px;width:26px;height:26px}
.rn-cp-empty{opacity:.45;font-size:11.5px;text-align:center;padding:10px 4px;line-height:1.5}
.rn-cp-panel{position:fixed;z-index:10002;width:300px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;padding:10px;font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;
  display:flex;flex-direction:column;gap:8px}
.rn-cp-panel h5{margin:0;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.4px}
.rn-cp-panel button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  padding:6px 8px;cursor:pointer;font-size:11.5px;text-align:left}
.rn-cp-panel button:hover{border-color:#b8283c;color:#fff}
.rn-cp-panel input{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  padding:6px 8px;font-size:11.5px}
.rn-cp-swrow{display:flex;flex-wrap:wrap;gap:5px}
.rn-cp-swrow div{width:24px;height:24px;border-radius:5px;cursor:pointer;border:2px solid #2b2f36}
.rn-cp-swrow div:hover{border-color:#fff}
.rn-cp-pick{position:fixed;z-index:10003;width:430px;max-height:420px;background:#111316;
  border:1px solid #3a3d44;border-radius:7px;font:12px system-ui,sans-serif;color:#ddd;
  box-shadow:0 12px 34px #000d;display:flex;flex-direction:column;overflow:hidden}
.rn-cp-pick input{background:#15171b;border:0;border-bottom:1px solid #2a2e35;color:#ddd;
  padding:9px 10px;font-size:12px;flex:none}
.rn-cp-pick input:focus{outline:none}
.rn-cp-pick .list{overflow:auto;flex:1}
.rn-cp-pick .grp{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.45;
  padding:7px 10px 3px;position:sticky;top:0;background:#111316}
.rn-cp-pick .it{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer}
.rn-cp-pick .it:hover,.rn-cp-pick .it.sel{background:#b8283c}
.rn-cp-pick .it .w{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rn-cp-pick .it .v{font-size:10.5px;opacity:.55;max-width:150px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.rn-cp-pick .it.used{opacity:.4}
.rn-cp-chk{width:17px;height:17px;border-radius:4px;border:2px solid #5a616b;background:#111316;cursor:pointer;
  flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;line-height:1}
.rn-cp-chk.on{background:#b8283c;border-color:#b8283c}
.rn-cp-row.sel,.rn-cp-title.sel{outline:2px solid #b8283c}
.rn-cp-selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#2e333b;border:1px solid #b8283c;
  border-radius:5px;padding:6px 8px;flex:none;position:sticky;top:0;z-index:3}
.rn-cp-selbar span.cnt{font-size:11.5px;font-weight:700;color:#e58a97;margin-right:2px}
.rn-cp-selbar button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:4px;padding:4px 9px;
  cursor:pointer;font-size:11px;height:26px;box-sizing:border-box}
.rn-cp-selbar button:hover{border-color:#b8283c;color:#fff}
.rn-cp-selbar button.danger{border-color:#7f1d1d;color:#e58a97}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

// ---- graph helpers ---------------------------------------------------------
const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);
// findNodes walks subgraphs, so a Control Panel tidied into one keeps working
const panels = () => findNodes(NODE_NAME);

// A widget worth controlling: a dropdown, a true/false, or a NUMBER. Text boxes stay
// out — they belong on the node, not behind a menu. Numbers came later than the rest:
// driving a sampler's dropdown from here but having to fly to the node for its CFG was
// half a panel, and premade combos wired into numbers is not an answer when the thing
// you want is a bar.
const hasChoices = (w) => !!(w.options && Array.isArray(w.options.values)
                             && w.options.values.length > 0);
const isNum = (w) =>
  !!w && (w.type === "number" || w.type === "slider"
          || (typeof w.value === "number" && !hasChoices(w)));
const isCtrl = (w) =>
  !!w && !w.hidden && w.type !== "hidden" && w.type !== "converted-widget" &&
  (w.type === "combo" || w.type === "toggle" || typeof w.value === "boolean" ||
   hasChoices(w) || isNum(w));

const nodeTitle = (n) => n.title || n.type || `node ${n.id}`;

// RedNode Palette's colours are panel rows, not widgets, so they cannot be found by
// walking node.widgets. They are offered as pseudo-widgets named "colour: hires" and
// applied through the palette instead of by writing a widget value.
const COLOUR_PREFIX = "colour: ";
const isColourRow = (row) => typeof row?.widget === "string" && row.widget.startsWith(COLOUR_PREFIX);
const colourName = (row) => row.widget.slice(COLOUR_PREFIX.length);

function findColour(row) {
  const name = colourName(row);
  const all = colorTargets();
  return all.find((c) => c.name === name && String(c.node.id) === String(row.node))
      || all.find((c) => c.name === name);
}

// Walk the main graph and every subgraph, the same way Group Control does — a target
// inside a subgraph is still just a widget we can set.
// One walk per task, not per row. findTarget() calls this, buildRow() calls findTarget,
// and the poll below calls it for every row, so a panel of 27 rows over a graph with 16
// subgraphs was walking 224 nodes 27 times over — 6,000 visits and 27 throwaway arrays,
// twice a second, before a single pixel was drawn. The graph cannot change in the middle
// of a synchronous render, so one result serves the whole pass; it is dropped on the next
// microtask so an edit on the canvas is still picked up immediately afterwards.
let targetCache = null;
function allTargets() {
  if (targetCache) return targetCache;
  const out = [];
  const seen = new Set();
  // `hosts` is the chain of SUBGRAPH NODES you would have to open to reach this one,
  // which is what the jump button needs. `path` is the same chain as titles, for labels.
  const walk = (graph, path, hosts) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (!n || n.type === NODE_NAME) continue;
      out.push({ n, path, hosts });
      if (n.subgraph) walk(n.subgraph, [...path, nodeTitle(n)], [...hosts, n]);
    }
  };
  walk(app.graph, [], []);
  targetCache = out;
  Promise.resolve().then(() => { targetCache = null; });
  return out;
}

const isTitle = (r) => !!r && r.title !== undefined && r.widget === undefined;
// Scene keys have to survive a re-paste (new node ids), so they are named, not numbered.
const rowKey = (r) => `${r.node_label || ""} · ${r.widget || ""}`;

// id first (exact), then title+widget (survives copy/paste and re-import)
function findTarget(row) {
  if (isTitle(row)) return null;
  if (isColourRow(row)) {
    const c = findColour(row);
    // a fake boolean widget, so every "is it a toggle" path downstream just works
    return c ? { node: c.node, path: [], w: { name: row.widget, type: "toggle", value: c.on },
                 colour: c } : null;
  }
  const all = allTargets();
  let hit = all.find((t) => String(t.n.id) === String(row.node) &&
                            (t.n.widgets || []).some((w) => w.name === row.widget && isCtrl(w)));
  if (!hit && row.node_label) {
    hit = all.find((t) => nodeTitle(t.n) === row.node_label &&
                          (t.n.widgets || []).some((w) => w.name === row.widget && isCtrl(w)));
  }
  if (!hit) return null;
  return { node: hit.n, path: hit.path, hosts: hit.hosts || [],
           w: (hit.n.widgets || []).find((w) => w.name === row.widget) };
}

/**
 * Go to a target, opening the subgraphs it lives inside on the way.
 *
 * A node's position only means anything in the graph that holds it, so centring the
 * ROOT canvas on a node nested two subgraphs down moved the view to coordinates that
 * meant nothing there, which is why the jump landed somewhere arbitrary. Walk the chain
 * of subgraph nodes from the outside in, opening each, and only then centre.
 *
 * Each open re-renders, so the next step waits a frame; without that the canvas is
 * still showing the previous graph when the next call arrives. A frontend without
 * openSubgraph degrades to the old behaviour rather than throwing.
 */
function jumpTo(t) {
  if (!t?.node) return;
  const canvas = app.canvas;
  if (!canvas) return;
  const land = () => {
    canvas.centerOnNode?.(t.node);
    canvas.setDirty?.(true, true);
  };
  const hosts = (t.hosts || []).filter((h) => h?.subgraph);
  if (!hosts.length || typeof canvas.openSubgraph !== "function") { land(); return; }
  let i = 0;
  const step = () => {
    if (i >= hosts.length) { land(); return; }
    const host = hosts[i++];
    try {
      canvas.openSubgraph(host.subgraph, host);
    } catch (e) {
      // stop descending and land where we are, which is still nearer than not moving
      console.warn("[RedNode Control Panel] could not open a subgraph:", e);
      land();
      return;
    }
    requestAnimationFrame(step);
  };
  step();
}

const isBool = (w) => w.type === "toggle" || typeof w.value === "boolean";

const num = (v) => (v === undefined || v === null || v === "" ? undefined
                    : (Number.isFinite(Number(v)) ? Number(v) : undefined));

/**
 * What one numeric row can actually do: its bounds, its step, and whether a bar is
 * honest to draw. The TARGET's own declared bounds always win, because they are what
 * it will really accept; the row's saved range only fills in what the widget never
 * declared. Plenty of numeric widgets (seeds above all) declare nothing at all, and a
 * bar with invented ends would be a dial that lies about its own range.
 */
function numSpec(row, w) {
  const o = (w && w.options) || {};
  // LiteGraph's `step` is historically TEN TIMES the real increment; ComfyUI carries
  // the true one as `step2` on newer frontends. Reading `step` raw is the classic way
  // to get a control that moves in 10s when the node moves in 1s.
  let step = num(o.step2);
  if (step === undefined && num(o.step) !== undefined) step = num(o.step) / 10;
  // A RANGE YOU SET WINS, including over one the widget declares. Reading a widget's
  // bounds is guesswork on custom nodes: plenty declare nonsense, or a range so wide
  // the bar is useless to drag. Narrowing a 1-100 steps widget to the 20-40 you
  // actually use is the whole point, and being overruled by metadata that was wrong
  // in the first place is not a service. Set it in the row's right-click menu.
  const min = num(row.min) ?? num(o.min);
  const max = num(row.max) ?? num(o.max);
  const value = num(row.value) ?? num(w?.value) ?? 0;
  if (step === undefined || step <= 0) {
    const whole = Number.isInteger(value) && (min === undefined || Number.isInteger(min))
                  && (max === undefined || Number.isInteger(max));
    step = whole ? 1 : 0.01;
  }
  let dp = (String(step).split(".")[1] || "").length;
  // DECIMALS YOU SET drive the step as well as the display, because on a dial those are
  // the same statement: two decimal places means it moves in hundredths. Showing 8.10
  // on a control that can only land on tenths would be a readout pretending to a
  // precision it does not have. Same reason the range is yours: the step read off a
  // custom node is guesswork too.
  const ownDp = num(row.dp);
  if (ownDp !== undefined && ownDp >= 0 && ownDp <= 6) {
    dp = Math.trunc(ownDp);
    step = Number(Math.pow(10, -dp).toFixed(dp));
  }
  return {
    min, max, step, value, dp,
    // both ends, and a range with room in it: anything less cannot honestly be a bar
    bar: min !== undefined && max !== undefined && max > min,
    // whether these ends are yours or the widget's, so the menu can say which
    own: num(row.min) !== undefined || num(row.max) !== undefined,
    declared: num(o.min) !== undefined && num(o.max) !== undefined,
    ownDp: ownDp !== undefined,
  };
}

const roundTo = (v, dp) => Number(Number(v).toFixed(dp));
function choicesFor(w) {
  if (!w) return [];
  if (isBool(w)) return ["true", "false"];
  const v = w.options?.values;
  return Array.isArray(v) ? v.map(String) : [];
}

// The panel stores every value as a string; the target decides what it really is.
function applyRow(row) {
  if (isTitle(row) || row.on === false) return false;
  const t = findTarget(row);
  if (!t?.w) return false;
  if (t.colour) {
    const want = row.value === true || row.value === "true";
    if (t.colour.on !== want) setColor(t.node, t.colour.name, want);
    return true;
  }
  let v = row.value;
  if (isBool(t.w)) v = v === true || v === "true";
  else if (isNum(t.w) || typeof t.w.value === "number") {
    const s = numSpec(row, t.w);
    v = num(v);
    if (v === undefined) return false;              // a blank box must not write a 0
    // clamp to whichever range is IN FORCE, which is the row's when you set one. The
    // widget's own bounds are only a fallback, because on custom nodes they are often
    // wrong, and a hand-set range being silently overruled by bad metadata is exactly
    // the failure this menu exists to escape.
    if (s.min !== undefined) v = Math.max(s.min, v);
    if (s.max !== undefined) v = Math.min(s.max, v);
    v = roundTo(v, s.dp);
  } else v = String(v ?? "");
  if (t.w.value === v) return true;                    // already there: don't churn callbacks
  t.w.value = v;
  try { t.w.callback?.(t.w.value, app.canvas, t.node); } catch (e) { /* target's own handler */ }
  t.node.setDirtyCanvas?.(true, true);
  return true;
}

const applyAll = (node) => (node._rnCfg?.rows || []).forEach(applyRow);

// ---- config ----------------------------------------------------------------
function readCfg(node) {
  const w = findWidget(node, "config");
  try {
    const c = JSON.parse(w?.value || "{}");
    if (!c || typeof c !== "object" || Array.isArray(c)) return { rows: [] };
    c.rows = Array.isArray(c.rows) ? c.rows : [];
    return c;
  } catch (e) {
    return { rows: [] };
  }
}
function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnCfg || { rows: [] });
  node.graph?.change?.();
}

// Stage 2 stored rows as pairs of canvas combos: ["Node #7 · sampler_name", "euler", …].
// Those workflows must keep working, so import the pairs the first time we see them.
function legacyRows(info) {
  const vals = info?.widgets_values;
  if (!Array.isArray(vals) || vals.length < 2) return null;
  if (typeof vals[1] === "string" && vals[1].trim().startsWith("{")) return null;   // already new
  const rows = [];
  for (let i = 0; i + 1 < vals.length; i += 2) {
    const m = /^(.*) #(\d+) · (.+)$/.exec(String(vals[i] ?? ""));
    if (m) rows.push({ node: Number(m[2]), node_label: m[1], widget: m[3], value: vals[i + 1], on: true });
  }
  return rows.length ? rows : null;
}

// ---- popup plumbing (shared with the other RedNode panels) -----------------
function placePopup(el, x, y, anchorBottomRight = false) {
  const r = el.getBoundingClientRect();
  const w = r.width || 300, h = r.height || 200;
  let left = anchorBottomRight ? x - w : x;
  let top = y;
  left = Math.max(6, Math.min(left, (window.innerWidth || 1920) - w - 6));
  top = Math.max(6, Math.min(top, (window.innerHeight || 1080) - h - 6));
  el.style.left = left + "px";
  el.style.top = top + "px";
}
function stopEvents(el, { wheel = false } = {}) {
  const names = ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove",
                 "click", "dblclick", "contextmenu", "keydown"];
  if (wheel) names.push("wheel");
  for (const t of names) el.addEventListener(t, (e) => e.stopPropagation());
}
const closeOnOutside = (m) => {
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
};

// ---- batch select ----------------------------------------------------------
const selSet = (node) => (node._rnSel = node._rnSel || new Set());
const inSelMode = (node) => !!node._rnSelMode;
function toggleSel(node, index) {
  const sel = selSet(node);
  sel.has(index) ? sel.delete(index) : sel.add(index);
  render(node);
}
function enterSel(node, index) {
  node._rnSelMode = true;
  if (index != null) selSet(node).add(index);
  render(node);
}
function exitSel(node) { node._rnSelMode = false; node._rnSel = new Set(); render(node); }

// ---- the "+ add control" picker -------------------------------------------
function openPicker(node, anchor) {
  document.querySelector(".rn-cp-pick")?.remove();
  const box = document.createElement("div");
  box.className = "rn-cp-pick";
  stopEvents(box, { wheel: false });
  const search = document.createElement("input");
  search.placeholder = "search nodes and settings…";
  const list = document.createElement("div");
  list.className = "list";
  box.append(search, list);

  // everything already on the panel, so it can be greyed instead of added twice
  const used = new Set((node._rnCfg.rows || []).filter((r) => !isTitle(r)).map((r) => `${r.node}\u0000${r.widget}`));

  let flat = [];
  for (const c of colorTargets()) {
    flat.push({
      n: c.node, path: [],
      w: { name: `${COLOUR_PREFIX}${c.name}`, type: "toggle", value: c.on },
      label: `${nodeTitle(c.node)} #${c.node.id}`,
      hay: `${nodeTitle(c.node)} colour ${c.name}`.toLowerCase(),
    });
  }
  for (const { n, path } of allTargets()) {
    for (const w of n.widgets || []) {
      if (!isCtrl(w)) continue;
      flat.push({
        n, w, path,
        label: `${nodeTitle(n)} #${n.id}${path.length ? ` (${path.join(" ▸ ")})` : ""}`,
        hay: `${nodeTitle(n)} ${n.type} ${w.name}`.toLowerCase(),
      });
    }
  }

  // Nodes you just dropped in lead the list. This is the moment it matters: you added a
  // node in order to drive one of its settings, and it is one of two hundred entries
  // sorted by nothing you remember. Entries for one node are built together and the
  // sort is stable, so each node's block moves as a block and everything already here
  // keeps the order it had.
  flat = newestFirst(flat, (f) => f.n);

  let cursor = 0;
  const add = (item) => {
    node._rnCfg.rows.push({
      node: item.n.id, node_label: nodeTitle(item.n), widget: item.w.name,
      value: isBool(item.w) ? String(!!item.w.value) : String(item.w.value ?? ""),
      on: true,
    });
    writeCfg(node); render(node);
  };

  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const hits = q ? flat.filter((f) => f.hay.includes(q)) : flat;
    list.replaceChildren();
    if (!hits.length) {
      const e = document.createElement("div");
      e.className = "rn-cp-empty";
      e.textContent = flat.length ? `nothing matches "${search.value}"`
                                  : "no dropdowns, toggles or numbers found in this workflow";
      list.appendChild(e);
      return;
    }
    let group = null;
    hits.forEach((f, i) => {
      if (f.label !== group) {
        group = f.label;
        const g = document.createElement("div");
        g.className = "grp";
        g.textContent = group;
        const badge = newBadge(f.n);
        if (badge) {
          const s = document.createElement("span");
          s.className = "new";
          s.textContent = badge;
          s.title = "you added this node in this session";
          g.appendChild(s);
        }
        list.appendChild(g);
      }
      const it = document.createElement("div");
      const dup = used.has(`${f.n.id}\u0000${f.w.name}`);
      it.className = "it" + (i === cursor ? " sel" : "") + (dup ? " used" : "");
      const w = document.createElement("span");
      w.className = "w";
      w.textContent = f.w.name;
      const v = document.createElement("span");
      v.className = "v";
      // numbers say their range here, so you can see before adding it whether the row
      // will draw a bar or ask you for the ends
      const lo = num(f.w.options?.min);
      const hi = num(f.w.options?.max);
      const ranged = isNum(f.w) && !isBool(f.w) && lo !== undefined && hi !== undefined;
      v.textContent = dup ? "already on the panel"
                    : ranged ? `${f.w.value ?? ""}   ${lo} to ${hi}`
                             : String(f.w.value ?? "");
      it.append(w, v);
      it.onclick = () => { add(f); box.remove(); };
      list.appendChild(it);
    });
  };
  search.addEventListener("input", () => { cursor = 0; fill(); });
  search.addEventListener("keydown", (e) => {
    const q = search.value.trim().toLowerCase();
    const hits = q ? flat.filter((f) => f.hay.includes(q)) : flat;
    if (e.key === "ArrowDown") { cursor = Math.min(cursor + 1, hits.length - 1); fill(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cursor = Math.max(cursor - 1, 0); fill(); e.preventDefault(); }
    else if (e.key === "Enter") { if (hits[cursor]) { add(hits[cursor]); box.remove(); } e.preventDefault(); }
    else if (e.key === "Escape") { box.remove(); }
  });

  fill();
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  placePopup(box, r.left, r.bottom + 4);
  search.focus();
  closeOnOutside(box);
}

// ---- rows ------------------------------------------------------------------
/**
 * A numeric row's control. Two shapes, on one line either way:
 *   range known  →  [====bar====] [ 7.5 ]
 *   range unknown →  [ 963133434 ]  min[    ] max[    ]
 * The second is not a failure state, it is the row asking for the one thing it cannot
 * know. Fill the pair in and it becomes a bar; the range is saved on the row, so it is
 * asked for once. Widgets that declare their own bounds never show the boxes, because
 * that range is not yours to override and the node would only clamp it back.
 */
function numericControl(node, row, t) {
  const s = numSpec(row, t.w);
  const box = document.createElement("div");
  box.className = "rn-cp-numwrap";

  const val = document.createElement("input");
  val.type = "number";
  val.className = "rn-cp-numval";
  // toFixed so the decimals you asked for are actually shown, trailing zeros and all
  const show = (v) => Number(v).toFixed(s.dp);
  val.value = show(s.value);
  val.step = String(s.step);
  if (s.min !== undefined) val.min = String(s.min);
  if (s.max !== undefined) val.max = String(s.max);
  val.title = `set ${row.widget}`
            + (s.bar ? ` (${s.min} to ${s.max})` : " (no range declared)");
  const commit = (v, redraw) => {
    const next = num(v);
    if (next === undefined) return;
    row.value = roundTo(next, s.dp);
    writeCfg(node);
    applyRow(row);
    if (redraw) render(node); else val.value = show(row.value);
  };
  val.addEventListener("change", () => commit(val.value, true));

  if (s.bar) {
    const bar = document.createElement("input");
    bar.type = "range";
    bar.className = "rn-cp-numbar";
    bar.min = String(s.min);
    bar.max = String(s.max);
    bar.step = String(s.step);
    bar.value = String(Math.max(s.min, Math.min(s.max, s.value)));
    bar.title = val.title;
    // dragging writes through live so the canvas follows the thumb, but the panel is
    // NOT rebuilt mid-drag: that would tear the element out from under the pointer
    bar.addEventListener("input", () => {
      row.value = roundTo(Number(bar.value), s.dp);
      val.value = show(row.value);
      writeCfg(node);
      applyRow(row);
    });
    box.append(bar, val);
  } else {
    // the range this row does not have. Two boxes, asked for once, saved on the row.
    const mk = (key, label) => {
      const i = document.createElement("input");
      i.type = "number";
      i.className = "rn-cp-numend";
      i.value = row[key] === undefined ? "" : String(row[key]);
      i.placeholder = label;
      i.title = `${label} of the bar for this row. Set both and the row becomes a bar. `
              + `${row.widget} declares no range of its own, so this is the only way to `
              + `know where its ends are.`;
      i.addEventListener("change", () => {
        const v = num(i.value);
        if (v === undefined) delete row[key]; else row[key] = v;
        writeCfg(node);
        render(node);
      });
      return i;
    };
    box.append(val, mk("min", "min"), mk("max", "max"));
  }
  return box;
}

function buildRow(node, row, index) {
  const t = findTarget(row);
  const on = row.on !== false;
  const missing = !t;
  const selected = inSelMode(node) && selSet(node).has(index);

  const el = document.createElement("div");
  el.className = "rn-cp-row" + (on ? "" : " off") + (missing ? " missing" : "") + (selected ? " sel" : "");
  if (row.color) el.style.background = on ? row.color : shade(row.color, 0.42);

  let lead = null;
  if (inSelMode(node)) {
    lead = document.createElement("span");
    lead.className = "rn-cp-chk" + (selected ? " on" : "");
    lead.textContent = selected ? "✓" : "";
    lead.title = "select this control";
    lead.onclick = (e) => { e.stopPropagation(); toggleSel(node, index); };
    el.addEventListener("click", (e) => {
      if (e.target.closest("button,input,select")) return;
      toggleSel(node, index);
    });
  }
  const grip = document.createElement("span");
  grip.className = "rn-cp-grip";
  grip.textContent = "⋮⋮";
  grip.title = "drag to reorder";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e) => { node._rnFrom = index; e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.style.outline = "2px solid #b8283c"; });
  el.addEventListener("dragleave", () => { el.style.outline = ""; });
  el.addEventListener("drop", (e) => { e.preventDefault(); el.style.outline = ""; dropAt(node, index); });

  // parking a row leaves it on the panel but stops it asserting its value, so you can
  // hand a workflow over without it stomping on someone's settings
  const eye = document.createElement("button");
  eye.className = "rn-cp-eye";
  eye.textContent = on ? "👁" : "—";
  eye.title = on ? "parked rows stop driving their target — click to park this one"
                 : "this control is parked and is not driving anything — click to arm it";
  eye.onclick = () => {
    row.on = on ? false : undefined;
    if (row.on === undefined) delete row.on;
    writeCfg(node); if (!on) applyRow(row); render(node);
  };

  const name = document.createElement("span");
  name.className = "rn-cp-name";
  name.textContent = row.label || row.node_label || "(control)";
  const sub = document.createElement("span");
  sub.className = "rn-cp-sub";
  sub.textContent = missing ? "· target missing" : `· ${row.widget}`;
  if (missing) sub.style.color = "#ff7b86";
  name.appendChild(sub);
  // A badge, and deliberately NOT a re-sort. These rows sit in the order you dragged
  // them into, and rearranging that to be helpful would be the opposite of helpful.
  // The picker is where new nodes float to the top, because that list has no order you
  // chose. Here the badge just tells you which row you came for.
  const fresh = t?.node ? newBadge(t.node) : null;
  if (fresh) {
    const b = document.createElement("span");
    b.className = "rn-cp-new";
    b.textContent = fresh;
    b.title = "you added this node in this session";
    name.appendChild(b);
  }
  name.title = missing
    ? `nothing in this workflow has a "${row.widget}" setting on a node called "${row.node_label}"`
    : `${row.node_label} · ${row.widget} — click to jump to the node`;
  if (!on) name.style.color = "#ff7b86";
  else if (row.text_color) name.style.color = row.text_color;
  name.onclick = () => {
    if (inSelMode(node)) return;
    jumpTo(t);
  };

  // the value control: a switch for true/false, a bar for numbers, a dropdown otherwise
  let valEl;
  if (t && isNum(t.w) && !isBool(t.w)) {
    valEl = numericControl(node, row, t);
  } else if (t && isBool(t.w)) {
    const cur = row.value === true || row.value === "true";
    valEl = document.createElement("button");
    valEl.className = "rn-cp-sw" + (cur ? " on" : "");
    valEl.textContent = cur ? "TRUE" : "FALSE";
    valEl.onclick = () => { row.value = String(!cur); writeCfg(node); applyRow(row); render(node); };
  } else {
    valEl = document.createElement("select");
    valEl.className = "rn-cp-val";
    const choices = choicesFor(t?.w);
    // a saved value whose option has gone (model deleted, list changed) still shows,
    // flagged, instead of silently snapping to the first entry
    const cur = String(row.value ?? "");
    const opts = choices.includes(cur) || !cur ? choices : [cur, ...choices];
    for (const c of opts) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c === cur && !choices.includes(cur) ? `${c}  (not available)` : c;
      o.selected = c === cur;
      valEl.appendChild(o);
    }
    valEl.disabled = missing || !choices.length;
    valEl.title = missing ? "the target node is not in this workflow" : `set ${row.widget}`;
    valEl.onchange = () => { row.value = valEl.value; writeCfg(node); applyRow(row); render(node); };
  }

  const go = document.createElement("button");
  go.className = "rn-cp-btn";
  go.textContent = "⌖";
  go.disabled = missing;
  go.style.opacity = missing ? ".35" : "1";
  go.title = missing ? "the target node is not in this workflow" : "jump the canvas to this node";
  go.onclick = () => jumpTo(t);

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openRowMenu(node, row, index, e);
  });

  el.append(...[lead || grip, eye, name, valEl, go].filter(Boolean));
  return el;
}

function buildTitleRow(node, row, index) {
  const selected = inSelMode(node) && selSet(node).has(index);
  const el = document.createElement("div");
  el.className = "rn-cp-title" + (selected ? " sel" : "");
  if (row.color) { el.style.background = row.color; el.style.borderLeftColor = "#ffffff44"; }

  let lead = null;
  if (inSelMode(node)) {
    lead = document.createElement("span");
    lead.className = "rn-cp-chk" + (selected ? " on" : "");
    lead.textContent = selected ? "✓" : "";
    lead.onclick = (e) => { e.stopPropagation(); toggleSel(node, index); };
  }
  const grip = document.createElement("span");
  grip.className = "rn-cp-grip";
  grip.textContent = "⋮⋮";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e) => { node._rnFrom = index; e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.style.outline = "2px solid #b8283c"; });
  el.addEventListener("dragleave", () => { el.style.outline = ""; });
  el.addEventListener("drop", (e) => { e.preventDefault(); el.style.outline = ""; dropAt(node, index); });

  const fold = document.createElement("button");
  fold.className = "rn-cp-btn";
  fold.textContent = row.folded ? "▸" : "▾";
  fold.title = row.folded ? "show this section" : "collapse this section";
  fold.onclick = () => { row.folded = !row.folded || undefined; writeCfg(node); render(node); };

  const txt = document.createElement("input");
  txt.value = row.title || "";
  txt.placeholder = "section name";
  if (row.text_color) txt.style.color = row.text_color;
  txt.addEventListener("change", () => { row.title = txt.value; writeCfg(node); });

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openRowMenu(node, row, index, e);
  });
  el.append(...[lead || grip, fold, txt].filter(Boolean));
  return el;
}

function dropAt(node, index) {
  const from = node._rnFrom;
  if (from == null || from === index) return;
  const rows = node._rnCfg.rows;
  const [m] = rows.splice(from, 1);
  rows.splice(index, 0, m);
  node._rnFrom = null;
  writeCfg(node); render(node);
}

// bypassed/parked colours are darkened rather than faded, so the colour still reads
function shade(hex, f) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return "#" + [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(c * f))).toString(16).padStart(2, "0")).join("");
}

function openRowMenu(node, row, index, ev) {
  document.querySelector(".rn-cp-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-cp-panel";
  stopEvents(m);
  const swatches = (label, list, get, set) => {
    const h = document.createElement("h5"); h.textContent = label;
    const sw = document.createElement("div"); sw.className = "rn-cp-swrow";
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

  const parts = [
    ...swatches("Row colour", COLORS, () => row.color, (v) => { row.color = v || undefined; }),
    ...swatches("Text colour", TEXT_COLORS, () => row.text_color, (v) => { row.text_color = v || undefined; }),
  ];
  if (!isTitle(row)) {
    const h = document.createElement("h5"); h.textContent = "Name on this panel";
    const inp = document.createElement("input");
    inp.value = row.label || "";
    inp.placeholder = row.node_label || "";
    inp.title = "rename this row — the target node keeps its own title";
    inp.addEventListener("change", () => { row.label = inp.value.trim() || undefined; writeCfg(node); render(node); });
    parts.push(h, inp);
    parts.push(mk(row.on === false ? "Arm this control" : "Park this control (stop driving)", () => {
      row.on = row.on === false ? undefined : false;
      if (row.on === undefined) { delete row.on; applyRow(row); }
      writeCfg(node); render(node);
    }));
    parts.push(mk("Read the target's current value", () => {
      const t = findTarget(row);
      if (t?.w) { row.value = isBool(t.w) ? String(!!t.w.value) : String(t.w.value ?? ""); writeCfg(node); render(node); }
    }));
    // THE BAR'S ENDS, for any numeric row. Two jobs: give a bar to a widget that
    // declares no range, and take one away from a widget whose declared range is
    // useless or plain wrong. Reading bounds off a custom node is guesswork, so the
    // hand-set pair wins over whatever was read.
    const tNum = findTarget(row);
    if (tNum?.w && isNum(tNum.w) && !isBool(tNum.w)) {
      const s = numSpec(row, tNum.w);
      const h = document.createElement("h5");
      h.textContent = "Bar range"
                    + (s.own ? " (yours)" : s.declared ? " (read from the node)" : "");
      const pair = document.createElement("div");
      pair.className = "rn-cp-swrow";
      pair.style.cssText = "display:flex;gap:5px";
      const end = (key, label) => {
        const i = document.createElement("input");
        i.type = "number";
        i.className = "rn-cp-numend";
        i.style.cssText = "flex:1 1 0;min-width:0";
        i.value = row[key] === undefined ? "" : String(row[key]);
        i.placeholder = s[key] === undefined ? label : String(s[key]);
        i.title = `${label} end of this row's bar. Leave both empty to go back to `
                + `whatever the node declares.`;
        i.addEventListener("change", () => {
          const v = num(i.value);
          if (v === undefined) delete row[key]; else row[key] = v;
          writeCfg(node);
          render(node);
        });
        return i;
      };
      pair.append(end("min", "min"), end("max", "max"));
      parts.push(h, pair);
      if (s.own) {
        parts.push(mk("Clear this row's bar range", () => {
          delete row.min;
          delete row.max;
          writeCfg(node); render(node);
        }));
      }

      const dh = document.createElement("h5");
      dh.textContent = "Decimal places" + (s.ownDp ? " (yours)" : " (from the node's step)");
      const dp = document.createElement("input");
      dp.type = "number";
      dp.className = "rn-cp-numdp";
      dp.min = "0";
      dp.max = "6";
      dp.step = "1";
      dp.value = row.dp === undefined ? "" : String(row.dp);
      dp.placeholder = String(s.dp);
      dp.title = "How many decimals this row shows AND moves in: 2 means hundredths, 0 "
               + "means whole numbers only. Leave empty to follow the node's own step, "
               + "which is worth overriding when the node declares a step it does not "
               + "really use.";
      dp.addEventListener("change", () => {
        const v = num(dp.value);
        if (v === undefined) delete row.dp;
        else row.dp = Math.max(0, Math.min(6, Math.trunc(v)));
        // the value itself has to land on the new grid, or the row shows a precision
        // it can no longer reach
        const t2 = findTarget(row);
        if (t2?.w) {
          const s2 = numSpec(row, t2.w);
          row.value = roundTo(num(row.value) ?? s2.value, s2.dp);
        }
        writeCfg(node); applyRow(row); render(node);
      });
      parts.push(dh, dp);
    }
  }
  parts.push(mk("Add section title above", () => {
    node._rnCfg.rows.splice(index, 0, { title: "Section", color: "#3a3f47" });
    writeCfg(node); render(node);
  }));
  parts.push(mk("Select multiple rows…", () => enterSel(node, index)));
  parts.push(mk(isTitle(row) ? "Remove section title" : "Remove this control", () => {
    node._rnCfg.rows.splice(index, 1);
    writeCfg(node); render(node);
  }));

  m.append(...parts);
  document.body.appendChild(m);
  placePopup(m, ev.clientX, ev.clientY);
  closeOnOutside(m);
}

// ---- ⚙ : scenes ------------------------------------------------------------
function currentValues(node) {
  const out = {};
  for (const r of node._rnCfg.rows || []) {
    if (!isTitle(r)) out[rowKey(r)] = r.value;
  }
  return out;
}

function openCog(node, anchor) {
  document.querySelector(".rn-cp-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-cp-panel";
  stopEvents(m);
  const r = anchor.getBoundingClientRect();

  const h1 = document.createElement("h5");
  h1.textContent = "Scenes";
  const nameInp = document.createElement("input");
  nameInp.placeholder = "scene name (e.g. fast draft)";

  const note = document.createElement("div");
  note.className = "rn-cp-empty";
  note.style.textAlign = "left";
  note.textContent = "a scene stores every row's value; applying one sets them all at once";

  const save = document.createElement("button");
  save.textContent = "Save these values as a scene";
  save.onclick = async () => {
    const name = nameInp.value.trim();
    if (!name) { note.textContent = "give the scene a name first"; return; }
    try {
      const res = await api.fetchApi("/rednode/control_scenes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, values: currentValues(node) }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      refreshSceneList(node, d.scenes || []);
      note.textContent = `saved "${name}"`;
    } catch (e) {
      note.textContent = `could not save: ${e.message}`;
    }
  };

  const del = document.createElement("button");
  del.textContent = "Delete the selected scene";
  del.onclick = async () => {
    const sw = findWidget(node, "scene");
    const name = sw?.value;
    if (!name || name === CUSTOM_SENTINEL) { note.textContent = "pick a scene on the node first"; return; }
    try {
      const res = await api.fetchApi("/rednode/control_scenes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }),
      });
      const d = await res.json();
      refreshSceneList(node, d.scenes || []);
      if (sw) sw.value = CUSTOM_SENTINEL;
      note.textContent = `deleted "${name}"`;
    } catch (e) {
      note.textContent = `could not delete: ${e.message}`;
    }
  };

  const h2 = document.createElement("h5");
  h2.textContent = "This panel";
  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply every row now";
  applyBtn.onclick = () => { applyAll(node); m.remove(); };

  const onLoad = document.createElement("button");
  const loadState = () => (node._rnCfg.apply_on_load === false ? "off" : "on");
  onLoad.textContent = `Re-apply values when the workflow loads: ${loadState()}`;
  onLoad.title = "off means the panel shows the values but leaves the targets alone until you change one";
  onLoad.onclick = () => {
    node._rnCfg.apply_on_load = node._rnCfg.apply_on_load === false ? undefined : false;
    writeCfg(node);
    onLoad.textContent = `Re-apply values when the workflow loads: ${loadState()}`;
  };

  const readAll = document.createElement("button");
  readAll.textContent = "Read all current values from the targets";
  readAll.title = "pull whatever the nodes are set to right now into this panel";
  readAll.onclick = () => {
    for (const row of node._rnCfg.rows || []) {
      if (isTitle(row)) continue;
      const t = findTarget(row);
      if (t?.w) row.value = isBool(t.w) ? String(!!t.w.value) : String(t.w.value ?? "");
    }
    writeCfg(node); render(node); m.remove();
  };

  m.append(h1, nameInp, save, del, note, h2, applyBtn, readAll, onLoad);
  document.body.appendChild(m);
  placePopup(m, r.right, r.bottom + 4, true);
  closeOnOutside(m);
}

function refreshSceneList(node, names) {
  const w = findWidget(node, "scene");
  if (!w) return;
  w.options = w.options || {};
  w.options.values = [CUSTOM_SENTINEL, ...names];
  if (!w.options.values.includes(w.value)) w.value = CUSTOM_SENTINEL;
}

// ---- select bar ------------------------------------------------------------
function buildSelBar(node) {
  const bar = document.createElement("div");
  bar.className = "rn-cp-selbar";
  const sel = selSet(node);
  const idx = () => [...sel].sort((a, b) => a - b);
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = `${sel.size} selected`;

  const mk = (label, fn, opts = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (opts.danger) b.className = "danger";
    b.disabled = !sel.size && !opts.always;
    if (b.disabled) b.style.opacity = ".4";
    b.onclick = fn;
    return b;
  };

  const rows = node._rnCfg.rows || [];
  const allPicked = rows.length > 0 && rows.every((_, i) => sel.has(i));
  const all = mk(allPicked ? "Select none" : "Select all", () => {
    if (allPicked) sel.clear(); else rows.forEach((_, i) => sel.add(i));
    render(node);
  }, { always: true });

  const colour = mk("Colour…", (e) => {
    document.querySelector(".rn-cp-panel")?.remove();
    const m = document.createElement("div");
    m.className = "rn-cp-panel";
    stopEvents(m);
    const r = e.target.getBoundingClientRect();
    const swatches = (label, list, apply) => {
      const h = document.createElement("h5"); h.textContent = label;
      const sw = document.createElement("div"); sw.className = "rn-cp-swrow";
      list.forEach((c) => {
        const d = document.createElement("div");
        d.title = c.n;
        d.style.background = c.v || (list === TEXT_COLORS ? "#e8ecf1" : "transparent");
        if (!c.v && list !== TEXT_COLORS) d.style.border = "2px dashed #555";
        d.onclick = () => { idx().forEach((i) => rows[i] && apply(rows[i], c.v)); writeCfg(node); render(node); m.remove(); };
        sw.appendChild(d);
      });
      return [h, sw];
    };
    m.append(
      ...swatches("Row colour", COLORS, (row, v) => { row.color = v || undefined; }),
      ...swatches("Text colour", TEXT_COLORS, (row, v) => { row.text_color = v || undefined; }),
    );
    document.body.appendChild(m);
    placePopup(m, r.right, r.top - 4, true);
    closeOnOutside(m);
  });

  const arm = mk("Arm", () => {
    idx().forEach((i) => { const r = rows[i]; if (r && !isTitle(r)) { delete r.on; applyRow(r); } });
    writeCfg(node); render(node);
  });
  const park = mk("Park", () => {
    idx().forEach((i) => { const r = rows[i]; if (r && !isTitle(r)) r.on = false; });
    writeCfg(node); render(node);
  });
  const read = mk("Read values", () => {
    idx().forEach((i) => {
      const r = rows[i];
      if (!r || isTitle(r)) return;
      const t = findTarget(r);
      if (t?.w) r.value = isBool(t.w) ? String(!!t.w.value) : String(t.w.value ?? "");
    });
    writeCfg(node); render(node);
  });
  const del = mk("Remove", () => {
    idx().reverse().forEach((i) => rows.splice(i, 1));
    node._rnSel = new Set();
    writeCfg(node); render(node);
  }, { danger: true });
  const done = mk("Done", () => exitSel(node), { always: true });

  bar.append(cnt, all, colour, arm, park, read, del, done);
  return bar;
}

// ---- render ----------------------------------------------------------------
function visibleRows(node) {
  const q = (node._rnQuery || "").trim().toLowerCase();
  const out = [];
  let folded = false;
  (node._rnCfg.rows || []).forEach((row, i) => {
    if (isTitle(row)) {
      folded = !!row.folded;
      if (!q) out.push({ row, i });                    // titles are noise in results
      return;
    }
    if (folded && !q) return;
    if (q && !`${row.label || ""} ${row.node_label || ""} ${row.widget || ""} ${row.value || ""}`
              .toLowerCase().includes(q)) return;
    out.push({ row, i });
  });
  return out;
}

function panelHeight(node) {
  let h = 0;
  for (const { row } of visibleRows(node)) h += (isTitle(row) ? 30 + 12 : ROW_H) + 5;
  return HEAD_H + PAD * 2 + Math.max(ROW_H, h) + 34 + (inSelMode(node) ? 46 : 0);
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
  const shown = visibleRows(node);
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "rn-cp-empty";
    empty.textContent = (node._rnQuery || "").trim()
      ? `nothing matches "${node._rnQuery}"`
      : "no controls yet — “+ add control” picks any dropdown or toggle in the workflow";
    list.appendChild(empty);
  } else {
    // a title opens a section box and the controls after it go INSIDE it
    let bucket = list;
    for (const { row, i } of shown) {
      if (isTitle(row)) {
        const sec = document.createElement("div");
        sec.className = "rn-cp-section";
        if (row.color) sec.style.borderLeftColor = row.color;
        sec.appendChild(buildTitleRow(node, row, i));
        list.appendChild(sec);
        bucket = sec;
        continue;
      }
      bucket.appendChild(buildRow(node, row, i));
    }
  }

  const wrap = node._rnWidget?.element;
  wrap?.querySelector(".rn-cp-selbar")?.remove();
  if (inSelMode(node) && wrap) wrap.insertBefore(buildSelBar(node), wrap.firstChild);

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  // Size once on creation, then never fight the user: the list scrolls.
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W),
                  Math.max(node.size[1], Math.min(panelHeight(node), 520))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

// ---- build -----------------------------------------------------------------
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
  wrap.className = "rn-cp-wrap";
  stopEvents(wrap);
  // hovering a numeric row's bar and rolling adjusts it, the same gesture as every
  // other slider in the pack, which is most of the point of driving numbers remotely
  bindSliderWheel(wrap);

  const find = document.createElement("div");
  find.className = "rn-cp-find";
  const q = document.createElement("input");
  q.placeholder = "search controls…";
  q.value = node._rnQuery || "";
  const clearQ = document.createElement("button");
  clearQ.textContent = "✕";
  clearQ.title = "clear the search";
  const applyQuery = (v) => { node._rnQuery = v; render(node); };
  q.addEventListener("input", () => applyQuery(q.value));
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; applyQuery(""); q.blur(); } });
  clearQ.onclick = () => { q.value = ""; applyQuery(""); };
  find.append(q, clearQ);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";

  const head = document.createElement("div");
  head.className = "rn-cp-head";
  const add = document.createElement("button");
  add.className = "rn-cp-add";
  add.textContent = "+ add control";
  add.title = "pick any dropdown or toggle in this workflow";
  add.onclick = () => openPicker(node, add);
  const applyBtn = document.createElement("button");
  applyBtn.className = "rn-cp-apply";
  applyBtn.textContent = "Apply all";
  applyBtn.title = "push every armed row's value to its target";
  applyBtn.onclick = () => { applyAll(node); render(node); };
  const cog = document.createElement("button");
  cog.className = "rn-cp-cog";
  cog.textContent = "⚙";
  cog.title = "scenes and panel options";
  cog.onclick = () => openCog(node, cog);
  head.append(add, applyBtn, cog);

  wrap.append(find, list, head);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_control_ui", "rednode_control_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnCfg = readCfg(node); render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  // picking a scene applies it and drops back to "custom (live)" — the rows are the
  // truth, and you stay free to change one afterwards
  const sw = findWidget(node, "scene");
  if (sw && !sw._rnHooked) {
    sw._rnHooked = true;
    const prior = sw.callback;
    sw.callback = async function (value) {
      prior?.apply(this, arguments);
      if (!value || value === CUSTOM_SENTINEL) return;
      try {
        const res = await api.fetchApi(`/rednode/control_scenes?name=${encodeURIComponent(value)}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        const values = d.values || {};
        for (const row of node._rnCfg.rows || []) {
          if (isTitle(row)) continue;
          const k = rowKey(row);
          if (k in values) { row.value = values[k]; applyRow(row); }   // rows not in the scene are left alone
        }
        writeCfg(node);
      } catch (e) {
        console.error("[RedNode Control Panel] could not apply scene:", e);
      }
      sw.value = CUSTOM_SENTINEL;
      render(node);
    };
  }

  render(node);
  // targets can be edited on the canvas, so keep the shown values honest — but never
  // while someone is inside the panel, or an open dropdown gets yanked away
  node._rnPoll = setInterval(() => {
    if (!node.graph) { clearInterval(node._rnPoll); return; }
    const el = document.activeElement;
    if (el && wrap.contains?.(el)) return;
    let changed = false;
    for (const row of node._rnCfg.rows || []) {
      if (isTitle(row) || row.on === false) continue;
      const t = findTarget(row);
      if (t?.w) {                                   // someone changed it on the canvas
        const live = isBool(t.w) ? String(!!t.w.value) : String(t.w.value ?? "");
        if (live !== String(row.value ?? "")) { row.value = live; changed = true; }
      }
    }
    // Only rebuild when something actually moved. This used to re-render unconditionally,
    // so a panel threw away and rebuilt every one of its rows twice a second forever,
    // whether or not a single value had changed. Nothing to show is the common case.
    if (changed) render(node);
  }, 700);
}

app.registerExtension({
  name: "RedNode.ControlPanel",
  async setup() {
    injectStyle();
    try {
      const res = await api.fetchApi("/rednode/control_scenes");
      const d = await res.json();
      for (const p of panels()) refreshSceneList(p, d.scenes || []);
    } catch (e) { /* offline: the node's own list still works */ }
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      injectStyle();
      build(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      onConfigure?.apply(this, arguments);
      const legacy = legacyRows(info);
      if (legacy) {
        // a Stage-2 workflow: the old path/value pairs landed in the wrong widgets
        this._rnCfg = { rows: legacy };
        const sw = findWidget(this, "scene");
        if (sw) sw.value = CUSTOM_SENTINEL;
        writeCfg(this);
      } else {
        this._rnCfg = readCfg(this);
      }
      requestAnimationFrame(() => {
        if (this._rnCfg?.apply_on_load !== false) applyAll(this);
        render(this);
      });
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._rnPoll) clearInterval(this._rnPoll);
      onRemoved?.apply(this, arguments);
    };
  },
});
