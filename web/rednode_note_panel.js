import { app } from "../../scripts/app.js";
import { findNodes } from "./rednode_graph.js";

// RedNode Note Panel — every RedNode Note in the workflow, styled from one place.
//
// A label wants to carry nothing but its words. Keeping the size, font, colour and glow
// on the note meant a settings box sitting over the sign, and no way to make thirty
// labels agree without visiting all thirty. The settings live here instead.
//
// Same wireless mechanism as RedNode Control Panel: the row writes the target widget's
// value and calls its callback, so the note repaints itself and serialises the value at
// queue time. No wires, and nothing to keep in sync.

const NODE_NAME = "RedNodeNotePanel";
const NOTE_NAME = "RedNodeNote";
const NODE_MIN_W = 430;
const MIN_PANEL_H = 130;

// mirrors note.py; the panel offers what the note accepts and nothing else
const FONTS = ["Consolas", "Courier New", "Lucida Console", "Impact", "Arial Black",
               "Trebuchet MS", "Verdana", "Georgia", "Segoe UI", "system-ui", "custom"];
const COLORS = ["red", "violet", "cyan", "amber", "lime", "rose", "blue", "white", "custom"];
const BACKDROPS = ["painted", "outline", "transparent"];
// what a row shows, in the order it shows them
const FIELDS = [
  { key: "font_size", label: "Size", kind: "num", min: 8, max: 200, step: 1 },
  { key: "color", label: "Colour", kind: "pick", options: COLORS },
  { key: "glow", label: "Glow", kind: "num", min: 0, max: 100, step: 1 },
  { key: "font", label: "Font", kind: "pick", options: FONTS },
  { key: "backdrop", label: "Backdrop", kind: "pick", options: BACKDROPS },
];
// copied by "Apply to all": the look, never the words
const STYLE_KEYS = FIELDS.map((f) => f.key).concat(["custom_font", "custom_color"]);

const css = document.createElement("style");
css.textContent = `
.rn-np-wrap{display:flex;flex-direction:column;gap:6px;padding:9px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-np-head{display:flex;align-items:center;gap:7px;flex:none}
.rn-np-count{font-size:11px;opacity:.6;flex:1}
.rn-np-btn{background:#1d2026;border:1px solid #33373d;border-radius:5px;color:#ddd;
  padding:4px 10px;cursor:pointer;font-size:11.5px;white-space:nowrap}
.rn-np-btn:hover{border-color:#b8283c;color:#fff}
.rn-np-row{display:flex;flex-direction:column;gap:5px;background:#1a1d22;
  border:1px solid #24272d;border-radius:6px;padding:7px 8px;flex:none}
.rn-np-top{display:flex;align-items:center;gap:7px;min-width:0}
.rn-np-swatch{width:13px;height:13px;border-radius:4px;flex:none;border:1px solid #0006}
.rn-np-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;font-weight:650;cursor:pointer}
.rn-np-name:hover{color:#fff}
.rn-np-sub{font-size:10px;opacity:.45;margin-left:6px;font-weight:400}
.rn-np-fields{display:flex;flex-wrap:wrap;gap:6px}
.rn-np-f{display:flex;align-items:center;gap:4px;font-size:10.5px;opacity:.9}
.rn-np-f span{opacity:.55}
.rn-np-f input,.rn-np-f select{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#e8ecf1;font-size:11px;padding:3px 5px;height:23px;box-sizing:border-box}
.rn-np-f input{width:54px}
.rn-np-f select{max-width:118px}
.rn-np-f input:hover,.rn-np-f select:hover{border-color:#b8283c}
.rn-np-empty{opacity:.45;font-size:11.5px;text-align:center;padding:12px 4px;line-height:1.5}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

// One walk per task, for the same reason the Control Panel needed it: this runs on a
// poll and per row, and walking a graph with a dozen subgraphs once per note is how a
// panel quietly eats a frame.
let noteCache = null;
function allNotes() {
  if (noteCache) return noteCache;
  const out = [];
  const seen = new Set();
  const walk = (graph, path) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of graph._nodes || graph.nodes || []) {
      if (!n) continue;
      if (n.type === NOTE_NAME) out.push({ node: n, path });
      if (n.subgraph) walk(n.subgraph, [...path, n.title || n.type || "subgraph"]);
    }
  };
  walk(app.graph, []);
  noteCache = out;
  Promise.resolve().then(() => { noteCache = null; });
  return out;
}

/** The first line of a note's text, which is what it is actually called. */
function labelFor(note) {
  const raw = String(findWidget(note, "note")?.value || "").trim();
  const first = raw.split("\n").find((l) => l.trim()) || "";
  return first.trim().slice(0, 42) || `Note ${note.id}`;
}

const SWATCH = {
  red: "#b8283c",
  violet: "#a855f7", cyan: "#22d3ee", amber: "#f59e0b", lime: "#84cc16",
  rose: "#f43f5e", blue: "#3b82f6", white: "#e8ecf1",
};
function swatchFor(note) {
  const pick = String(lookOf(note, "color"));
  if (pick === "custom") {
    const hex = String(lookOf(note, "custom_color") || "").trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex : "#b8283c";
  }
  return SWATCH[pick] || "#b8283c";
}

// The note's look lives in PROPERTIES, not widgets, so that a sign carries its words
// and nothing else. See the note's own file: widgets cannot be reliably hidden from a
// plugin, and a property is never rendered as a row in the first place.
const LOOK = {
  font_size: 40, font: "Consolas", color: "red", glow: 55,
  backdrop: "painted", custom_font: "", custom_color: "#b8283c",
};
function lookOf(note, key) {
  const v = note.properties?.[key];
  return v === undefined || v === "" ? LOOK[key] : v;
}

/** Write one setting onto a note and make its sign follow. */
function drive(note, key, value) {
  note.properties = note.properties || {};
  if (note.properties[key] === value) return true;   // already there, do not churn
  note.properties[key] = value;
  note._rnNotePaint?.();                             // the note restyles itself
  note.setDirtyCanvas?.(true, true);
  note.graph?.change?.();
  return true;
}

function readCfg(node) {
  const w = findWidget(node, "config");
  try {
    const d = JSON.parse(w?.value || "{}");
    return d && typeof d === "object" ? d : {};
  } catch (e) { return {}; }
}

function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnNpCfg || {});
  node.graph?.change?.();
}

function jumpTo(note, hosts) {
  const canvas = app.canvas;
  if (!canvas) return;
  const land = () => { canvas.centerOnNode?.(note); canvas.setDirty?.(true, true); };
  const chain = (hosts || []).filter((h) => h?.subgraph);
  if (!chain.length || typeof canvas.openSubgraph !== "function") { land(); return; }
  let i = 0;
  const step = () => {
    if (i >= chain.length) { land(); return; }
    const host = chain[i++];
    try { canvas.openSubgraph(host.subgraph, host); }
    catch (e) { land(); return; }
    requestAnimationFrame(step);
  };
  step();
}

function field(note, f, after) {
  const wrap = document.createElement("label");
  wrap.className = "rn-np-f";
  const lab = document.createElement("span");
  lab.textContent = f.label;
  wrap.appendChild(lab);
  const cur = lookOf(note, f.key);
  if (f.kind === "num") {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(f.min); i.max = String(f.max); i.step = String(f.step);
    i.value = String(cur ?? f.min);
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) return;
      drive(note, f.key, Math.max(f.min, Math.min(f.max, v)));
      after?.();
    });
    wrap.appendChild(i);
  } else {
    const s = document.createElement("select");
    for (const o of f.options) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      opt.selected = String(cur) === o;
      s.appendChild(opt);
    }
    s.addEventListener("change", () => { drive(note, f.key, s.value); after?.(); });
    wrap.appendChild(s);
  }
  return wrap;
}

function render(node) {
  const root = node._rnNpRoot;
  if (!root) return;
  const notes = allNotes();
  root.replaceChildren();

  const head = document.createElement("div");
  head.className = "rn-np-head";
  const count = document.createElement("span");
  count.className = "rn-np-count";
  count.textContent = notes.length
    ? `${notes.length} note${notes.length > 1 ? "s" : ""} in this workflow`
    : "";
  head.appendChild(count);

  if (notes.length > 1) {
    const all = document.createElement("button");
    all.className = "rn-np-btn";
    all.textContent = "Apply the first note's look to all";
    all.title = "Copy size, colour, glow, font and backdrop from the first note onto "
              + "every other one. Their words are never touched.";
    all.onclick = () => {
      const src = notes[0].node;
      for (const { node: n } of notes.slice(1)) {
        for (const k of STYLE_KEYS) drive(n, k, lookOf(src, k));
      }
      render(node);
    };
    head.appendChild(all);
  }
  root.appendChild(head);

  if (!notes.length) {
    const e = document.createElement("div");
    e.className = "rn-np-empty";
    e.textContent = "No RedNode Notes in this workflow yet.\n"
                  + "Add one and it appears here, with its settings.";
    root.appendChild(e);
    return;
  }

  for (const { node: note, path } of notes) {
    const row = document.createElement("div");
    row.className = "rn-np-row";

    const top = document.createElement("div");
    top.className = "rn-np-top";
    const sw = document.createElement("span");
    sw.className = "rn-np-swatch";
    sw.style.background = swatchFor(note);
    const name = document.createElement("span");
    name.className = "rn-np-name";
    name.textContent = labelFor(note);
    if (path.length) {
      const sub = document.createElement("span");
      sub.className = "rn-np-sub";
      sub.textContent = `in ${path.join(" > ")}`;
      name.appendChild(sub);
    }
    name.title = "Jump the canvas to this note";
    // the hosts chain is the path's nodes, rebuilt here so the jump can open them
    name.onclick = () => {
      const hosts = [];
      let g = app.graph;
      for (const title of path) {
        const host = (g?._nodes || []).find((n) => (n.title || n.type) === title && n.subgraph);
        if (!host) break;
        hosts.push(host);
        g = host.subgraph;
      }
      jumpTo(note, hosts);
    };
    top.append(sw, name);
    row.appendChild(top);

    const fields = document.createElement("div");
    fields.className = "rn-np-fields";
    for (const f of FIELDS) fields.appendChild(field(note, f, () => render(node)));
    row.appendChild(fields);
    root.appendChild(row);
  }
}

/** What the list looks like right now, so a poll only redraws on a real change. */
function signature() {
  return allNotes().map(({ node: n }) => {
    const text = String(findWidget(n, "note")?.value ?? "").slice(0, 40);
    return `${n.id}:${text}:${STYLE_KEYS.map((k) => String(lookOf(n, k))).join(",")}`;
  }).join("|");
}

function build(node) {
  if (!node.addDOMWidget || node._rnNpRoot) return;
  const cfgW = findWidget(node, "config");
  if (!cfgW) { requestAnimationFrame(() => build(node)); return; }
  cfgW.type = "hidden";
  cfgW.hidden = true;
  cfgW.computeSize = () => [0, -4];
  if (cfgW.element) cfgW.element.style.display = "none";

  injectStyle();
  node._rnNpCfg = readCfg(node);
  const wrap = document.createElement("div");
  wrap.className = "rn-np-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                   "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  node._rnNpRoot = wrap;

  const w = node.addDOMWidget("rednode_note_panel_ui", "rednode_note_panel_ui", wrap, {
    serialize: false,
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 40];
  node._rnNpWidget = w;
  if (node.size[0] < NODE_MIN_W) node.size[0] = NODE_MIN_W;

  render(node);
  // Notes are added, retitled and restyled on the canvas, so the list has to follow.
  // Signature-guarded, so a quiet workflow costs one string compare and nothing else.
  node._rnNpPoll = setInterval(() => {
    if (!node.graph) { clearInterval(node._rnNpPoll); return; }
    const el = document.activeElement;
    if (el && wrap.contains?.(el)) return;          // never yank a control mid-edit
    const sig = signature();
    if (sig !== node._rnNpSig) { node._rnNpSig = sig; render(node); }
  }, 700);
}

app.registerExtension({
  name: "RedNode.NotePanel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      build(this);
      this._rnNpCfg = readCfg(this);
      requestAnimationFrame(() => render(this));
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      clearInterval(this._rnNpPoll);
      onRemoved?.apply(this, arguments);
    };
  },
});

export { allNotes, labelFor, signature };
