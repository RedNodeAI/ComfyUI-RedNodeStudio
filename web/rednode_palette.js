import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodes } from "./rednode_graph.js";

// RedNode Palette — the colours that drive every RedNode Router.
//
// Switch a colour on here and every router in the workflow re-routes. There are no
// wires: the palette writes the active set into each router's `active` widget, which is
// what reaches the server at queue time. That is the same wireless trick RedNode Control
// Panel uses to drive dropdowns.

const NODE_NAME = "RedNodePalette";
const ROUTER_NAME = "RedNodeRouter";
const CUSTOM_SENTINEL = "custom (live)";      // must match palette.py
const NODE_MIN_W = 320;
const MIN_PANEL_H = 110;
const ROW_H = 30;
const MAX_COLORS = 16;

// deliberately distinct hues: these get read at a glance on a busy canvas
const SWATCHES = [
  "#e05263", "#e08a3c", "#e8c547", "#5bbf6a", "#3fb1a8",
  "#4a8fe0", "#8b6fe0", "#d264b6", "#9aa0a8", "#b8283c",
];

const css = document.createElement("style");
css.textContent = `
.rn-pl-wrap{display:flex;flex-direction:column;gap:5px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-pl-row{display:flex;align-items:center;gap:7px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none}
.rn-pl-row.on{background:#1d2a20;outline:1px solid #2f7a4d}
.rn-pl-dot{width:16px;height:16px;border-radius:5px;flex:none;cursor:pointer;border:2px solid #00000055}
.rn-pl-name{flex:1;background:transparent;border:0;color:#e8ecf1;font-size:12.5px;font-weight:600;
  padding:2px 0;min-width:40px}
.rn-pl-name:focus{outline:none;border-bottom:1px solid #b8283c}
.rn-pl-row.off .rn-pl-name{opacity:.55}
.rn-pl-sw{background:#15171b;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:10px;font-weight:700;letter-spacing:.5px;height:24px;width:52px;flex:none}
.rn-pl-sw.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4}
.rn-pl-x{background:none;border:0;color:#6b7280;cursor:pointer;font-size:13px;width:20px;flex:none}
.rn-pl-x:hover{color:#ff7b86}
.rn-pl-head{display:flex;gap:6px;align-items:center;flex:none;padding-top:2px}
.rn-pl-head button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  cursor:pointer;font-size:11.5px;padding:0 10px;height:26px}
.rn-pl-head button:hover:not(:disabled){border-color:#b8283c;color:#fff}
.rn-pl-head button:disabled{opacity:.35;cursor:not-allowed}
.rn-pl-head .cnt{font-size:10.5px;opacity:.45;margin-left:auto}
.rn-pl-note{font-size:10.5px;opacity:.45;line-height:1.45;padding:2px 2px 0}
.rn-pl-menu{position:fixed;z-index:10002;background:#1b1e23;border:1px solid #3a3d44;border-radius:7px;
  padding:9px;display:flex;flex-wrap:wrap;gap:5px;width:196px;box-shadow:0 10px 30px #000c}
.rn-pl-menu div{width:24px;height:24px;border-radius:5px;cursor:pointer;border:2px solid #2b2f36}
.rn-pl-menu div:hover{border-color:#fff}
.rn-pl-panel{position:fixed;z-index:10002;width:280px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;padding:10px;font:12px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;
  display:flex;flex-direction:column;gap:8px}
.rn-pl-panel h5{margin:0;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.4px}
.rn-pl-panel button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  padding:6px 8px;cursor:pointer;font-size:11.5px;text-align:left}
.rn-pl-panel button:hover{border-color:#b8283c;color:#fff}
.rn-pl-panel input{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  padding:6px 8px;font-size:11.5px}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);
// findNodes walks subgraphs, so a palette tidied into one still drives its routers
const palettes = () => findNodes(NODE_NAME);

function readCfg(node) {
  const w = findWidget(node, "config");
  try {
    const c = JSON.parse(w?.value || "{}");
    if (!c || typeof c !== "object" || Array.isArray(c)) return { colors: [] };
    c.colors = Array.isArray(c.colors) ? c.colors : [];
    return c;
  } catch (e) {
    return { colors: [] };
  }
}
function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnCfg || { colors: [] });
  node.graph?.change?.();
}

const activeNames = (node) =>
  (node._rnCfg?.colors || []).filter((c) => c.on).map((c) => c.name).filter(Boolean);

// ---- the wireless part -----------------------------------------------------
// Walk every graph (subgraphs too) and drop the active set into each router. Routers
// serialize their own copy, so this is what the server ends up seeing.
function pushToRouters(node) {
  const active = JSON.stringify(activeNames(node));
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === ROUTER_NAME) {
        const w = findWidget(n, "active");
        if (w && w.value !== active) {
          w.value = active;
          n._rnActive = null;                 // let the router recompute what is live
          n.setDirtyCanvas?.(true, true);
        }
        n._rnPaletteColors = (node._rnCfg?.colors || []).map((c) => ({ ...c }));
        n._rnRefresh?.();
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
}

// ---- what RedNode Control Panel drives ------------------------------------
// The colours are rows in a DOM panel, not widgets, so the Control Panel cannot find
// them by looking at node.widgets like it does for every other dropdown. It asks here
// instead, and sets them through setColor() rather than by writing a widget value.
export function colorTargets() {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === NODE_NAME) {
        for (const c of (n._rnCfg?.colors || readCfg(n).colors || [])) {
          if (c.name) out.push({ node: n, name: c.name, on: !!c.on, color: c.color });
        }
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return out;
}

export function setColor(node, name, on) {
  const c = (node._rnCfg?.colors || []).find((x) => x.name === name);
  if (!c) return false;
  if (on) c.on = true; else delete c.on;
  writeCfg(node);
  pushToRouters(node);
  render(node);
  const pw = findWidget(node, "preset");
  if (pw) pw.value = CUSTOM_SENTINEL;
  return true;
}

// a router that appears later asks for this itself
export function paletteState() {
  const p = palettes()[0];
  if (!p) return { colors: [], active: [] };
  const cfg = p._rnCfg || readCfg(p);
  return { colors: cfg.colors || [], active: (cfg.colors || []).filter((c) => c.on).map((c) => c.name) };
}

// Used by Router Control: selecting one discovered combination replaces the active
// set in one transaction, so old combinations cannot remain stacked underneath it.
export function setActiveColors(names) {
  const p = palettes()[0];
  if (!p) return false;
  const want = new Set((names || []).map(String));
  p._rnCfg = p._rnCfg || readCfg(p);
  for (const color of p._rnCfg.colors || []) {
    if (want.has(color.name)) color.on = true;
    else delete color.on;
  }
  writeCfg(p);
  pushToRouters(p);
  render(p);
  const preset = findWidget(p, "preset");
  if (preset) preset.value = CUSTOM_SENTINEL;
  return true;
}

// ---- UI --------------------------------------------------------------------
function openSwatchMenu(node, colour, ev, done) {
  document.querySelector(".rn-pl-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-pl-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) m.addEventListener(t, (e) => e.stopPropagation());
  for (const hex of SWATCHES) {
    const d = document.createElement("div");
    d.style.background = hex;
    d.title = hex;
    if (colour.color === hex) d.style.borderColor = "#fff";
    d.onclick = () => { colour.color = hex; writeCfg(node); m.remove(); done(); };
    m.appendChild(d);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(ev.clientX, (window.innerWidth || 1920) - (r.width || 200) - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY, (window.innerHeight || 1080) - (r.height || 120) - 6)) + "px";
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
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
  const colors = node._rnCfg.colors || [];
  list.replaceChildren();

  if (!colors.length) {
    const empty = document.createElement("div");
    empty.className = "rn-pl-note";
    empty.textContent = "no colours yet, “+ colour” adds one. Click a swatch to recolour it, "
                      + "type over the name, then tick that colour on the routers' branches.";
    list.appendChild(empty);
  }

  colors.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "rn-pl-row " + (c.on ? "on" : "off");

    const dot = document.createElement("span");
    dot.className = "rn-pl-dot";
    dot.style.background = c.color || SWATCHES[i % SWATCHES.length];
    dot.title = "change this colour";
    dot.onclick = (e) => { e.stopPropagation(); openSwatchMenu(node, c, e, () => render(node)); };

    const name = document.createElement("input");
    name.className = "rn-pl-name";
    name.value = c.name || "";
    name.placeholder = `colour ${i + 1}`;
    name.title = "name this colour, routers match on the name, so renaming it renames it everywhere";
    name.addEventListener("pointerdown", (e) => e.stopPropagation());
    name.addEventListener("change", () => {
      const was = c.name;
      const next = name.value.trim();
      c.name = next;
      // keep every router's rules pointing at the same colour after a rename
      if (was && next && was !== next) renameEverywhere(was, next);
      writeCfg(node); pushToRouters(node); render(node);
    });

    const sw = document.createElement("button");
    sw.className = "rn-pl-sw" + (c.on ? " on" : "");
    sw.textContent = c.on ? "ON" : "OFF";
    sw.title = c.on ? "switch this colour off" : "switch this colour on";
    sw.onclick = () => {
      c.on = !c.on || undefined;
      if (!c.on) delete c.on;
      writeCfg(node); pushToRouters(node); render(node);
      const pw = findWidget(node, "preset");
      if (pw) pw.value = CUSTOM_SENTINEL;         // hand edits leave the preset behind
    };

    const x = document.createElement("button");
    x.className = "rn-pl-x";
    x.textContent = "✕";
    x.title = "remove this colour";
    x.onclick = () => {
      node._rnCfg.colors.splice(i, 1);
      writeCfg(node); pushToRouters(node); render(node);
    };

    row.append(dot, name, sw, x);
    list.appendChild(row);
  });

  const note = document.createElement("div");
  note.className = "rn-pl-note";
  const on = activeNames(node);
  note.textContent = on.length
    ? `live: ${on.join(", ")}`
    : "nothing is on, routers fall back to their “otherwise” branch";
  note.title = "click a swatch to recolour, type over a name to rename (routers follow), "
             + "ON/OFF switches a colour";
  list.appendChild(note);

  const bar = document.createElement("div");
  bar.className = "rn-pl-head";
  const add = document.createElement("button");
  add.textContent = "+ colour";
  add.disabled = colors.length >= MAX_COLORS;
  add.title = add.disabled ? `${MAX_COLORS} colours is the maximum` : "add a colour";
  add.onclick = () => {
    const i = colors.length;
    colors.push({ name: `colour ${i + 1}`, color: SWATCHES[i % SWATCHES.length] });
    writeCfg(node); pushToRouters(node); render(node);
  };
  const allOff = document.createElement("button");
  allOff.textContent = "All off";
  allOff.onclick = () => {
    for (const c of colors) delete c.on;
    writeCfg(node); pushToRouters(node); render(node);
  };
  const cog = document.createElement("button");
  cog.textContent = "⚙";
  cog.title = "presets";
  cog.onclick = () => openCog(node, cog);
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = `${on.length}/${colors.length} on`;
  bar.append(add, allOff, cog, cnt);
  list.appendChild(bar);

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    const want = 40 + Math.max(1, colors.length) * (ROW_H + 5) + 60;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], Math.min(want, 460))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

// a colour rename has to follow into every router's rules, or branches quietly stop matching
function renameEverywhere(was, next) {
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === ROUTER_NAME && n._rnRename) n._rnRename(was, next);
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
}

function openCog(node, anchor) {
  document.querySelector(".rn-pl-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-pl-panel";
  for (const t of ["pointerdown", "pointerup", "click", "dblclick", "keydown", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const h = document.createElement("h5");
  h.textContent = "Presets";
  const inp = document.createElement("input");
  inp.placeholder = "preset name (e.g. hires portrait)";
  const note = document.createElement("div");
  note.style.cssText = "font-size:10.5px;opacity:.5;line-height:1.4";
  note.textContent = "a preset stores which colours are on";

  const save = document.createElement("button");
  save.textContent = "Save the live colours as a preset";
  save.onclick = async () => {
    const name = inp.value.trim();
    if (!name) { note.textContent = "give the preset a name first"; return; }
    try {
      const res = await api.fetchApi("/rednode/palette_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, colors: activeNames(node) }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      refreshPresetList(node, d.presets || []);
      note.textContent = `saved "${name}"`;
    } catch (e) { note.textContent = `could not save: ${e.message}`; }
  };

  const del = document.createElement("button");
  del.textContent = "Delete the selected preset";
  del.onclick = async () => {
    const pw = findWidget(node, "preset");
    const name = pw?.value;
    if (!name || name === CUSTOM_SENTINEL) { note.textContent = "pick a preset on the node first"; return; }
    try {
      const res = await api.fetchApi("/rednode/palette_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }),
      });
      const d = await res.json();
      refreshPresetList(node, d.presets || []);
      if (pw) pw.value = CUSTOM_SENTINEL;
      note.textContent = `deleted "${name}"`;
    } catch (e) { note.textContent = `could not delete: ${e.message}`; }
  };

  m.append(h, inp, save, del, note);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(r.left, (window.innerWidth || 1920) - 290)) + "px";
  m.style.top = Math.max(6, r.bottom + 4) + "px";
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function refreshPresetList(node, names) {
  const w = findWidget(node, "preset");
  if (!w) return;
  w.options = w.options || {};
  w.options.values = [CUSTOM_SENTINEL, ...names];
  if (!w.options.values.includes(w.value)) w.value = CUSTOM_SENTINEL;
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
  wrap.className = "rn-pl-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  wrap.appendChild(list);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_palette_ui", "rednode_palette_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnCfg = readCfg(node); render(node); pushToRouters(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 50];
  node._rnWidget = w;

  const pw = findWidget(node, "preset");
  if (pw && !pw._rnHooked) {
    pw._rnHooked = true;
    const prior = pw.callback;
    pw.callback = async function (value) {
      prior?.apply(this, arguments);
      if (!value || value === CUSTOM_SENTINEL) return;
      try {
        const res = await api.fetchApi(`/rednode/palette_presets?name=${encodeURIComponent(value)}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        const want = new Set(d.colors || []);
        for (const c of node._rnCfg.colors || []) {
          if (want.has(c.name)) c.on = true; else delete c.on;
        }
        writeCfg(node); pushToRouters(node); render(node);
      } catch (e) {
        console.error("[RedNode Palette] could not apply preset:", e);
      }
    };
  }

  node._rnPush = () => pushToRouters(node);
  render(node);
  pushToRouters(node);
}

app.registerExtension({
  name: "RedNode.Palette",
  async setup() {
    injectStyle();
    try {
      const res = await api.fetchApi("/rednode/palette_presets");
      const d = await res.json();
      for (const p of palettes()) refreshPresetList(p, d.presets || []);
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
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      this._rnCfg = readCfg(this);
      requestAnimationFrame(() => { render(this); pushToRouters(this); });
    };
  },
});
