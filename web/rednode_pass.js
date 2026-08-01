import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { colorTargets, setColor } from "./rednode_palette.js";

// RedNode Pass — flips palette colours as the chain reaches it.
//
// One row per palette colour, each cycling through ignore / ON / OFF / FLIP. When the
// node executes, the server sends us the list and RedNode Palette applies it.
//
// Two ways to drive it:
//
//   LIVE (the default) — the colours follow this node's own enabled/bypassed state, so
//     dropping it in a group turns that group into a switch: enable the group and its
//     colours come on, bypass it and they go off. Nothing has to run, so it is instant
//     and the next queue is already routed correctly.
//
//   ON EXECUTE — the colours change when the chain actually reaches the node. Useful for
//     "first pass finished, switch to hires", but the prompt was frozen when you pressed
//     Queue, so it lands on the NEXT run, not the one in flight. The panel says so.

const NODE_NAME = "RedNodePass";
const NODE_MIN_W = 300;
const MIN_PANEL_H = 90;
const ROW_H = 28;
const CYCLE = ["", "on", "off", "flip"];
const LABEL = { "": "—", on: "ON", off: "OFF", flip: "FLIP" };

const css = document.createElement("style");
css.textContent = `
.rn-ps-wrap{display:flex;flex-direction:column;gap:5px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-ps-row{display:flex;align-items:center;gap:7px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none}
.rn-ps-row.set{background:#1d2430}
.rn-ps-dot{width:14px;height:14px;border-radius:4px;flex:none;border:2px solid #00000055}
.rn-ps-name{flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rn-ps-act{background:#15171b;border:1px solid #33373d;border-radius:4px;color:#6b7280;cursor:pointer;
  font-size:9.5px;font-weight:700;letter-spacing:.4px;height:22px;width:46px;flex:none}
.rn-ps-act.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4}
.rn-ps-act.off{background:#4a1f26;border-color:#7f2230;color:#ff9aa4}
.rn-ps-act.flip{background:#241d12;border-color:#6b4a1d;color:#f0c58a}
.rn-ps-note{font-size:10.5px;opacity:.45;line-height:1.45;padding:2px 2px 0}
.rn-ps-warn{font-size:10.5px;color:#f0c58a;opacity:.85;line-height:1.45;padding:2px 2px 0}
.rn-ps-bar{display:flex;gap:6px;align-items:center;flex:none;padding-top:2px}
.rn-ps-mode{background:#15171b;border:1px solid #33373d;color:#9aa0a8;border-radius:5px;
  cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.4px;height:24px;padding:0 9px;flex:1}
.rn-ps-mode.live{border-color:#2f7a4d;color:#d4ffe4;background:#16241c}
.rn-ps-bar .cnt{font-size:10px;opacity:.7;flex:none}
.rn-ps-fired{outline:2px solid #22c55e !important}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

function readActions(node) {
  const w = findWidget(node, "colors");
  try {
    const d = JSON.parse(w?.value || "[]");
    const list = Array.isArray(d) ? d : (d.colors || []);
    return Array.isArray(list) ? list.filter((x) => x && x.name) : [];
  } catch (e) {
    return [];
  }
}
function writeActions(node, list) {
  const w = findWidget(node, "colors");
  if (w) w.value = JSON.stringify(list.filter((x) => x.do));
  node.graph?.change?.();
}
const actionFor = (list, name) => list.find((x) => x.name === name)?.do || "";

// Live is the default: it is the mode that makes a group behave like a switch. Kept in
// node.properties, which serialise without taking a widget slot.
const isLive = (node) => node.properties?.rn_pass_live !== false;
const MODE_ON = 0;                                  // LiteGraph ALWAYS
const isEnabled = (node) => (node.mode ?? MODE_ON) === MODE_ON;

// Edge-triggered on purpose: applying every poll would fight you the moment you switched
// a colour by hand in the palette. Only a change of this node's own state drives it.
function applyLive(node, { force = false } = {}) {
  if (!isLive(node)) return;
  const on = isEnabled(node);
  if (!force && node._rnLastEnabled === on) return;
  node._rnLastEnabled = on;
  for (const a of readActions(node)) {
    if (a.do === "flip") continue;                  // a trigger, not a state: live cannot use it
    const want = a.do === "on" ? on : !on;
    for (const t of colorTargets()) {
      if (t.name === a.name && t.on !== want) setColor(t.node, t.name, want);
    }
  }
  render(node);
}

// the value passes straight through, so the output wears the input's type
function applyType(node) {
  const slot = (node.inputs || []).find((s) => s.name === "value");
  const out = (node.outputs || [])[0];
  if (!out) return;
  let t = "*";
  if (slot?.link) {
    const graph = node.graph || app.graph;
    const links = graph?.links;
    const link = links?.get?.(slot.link) ?? links?.[slot.link];
    if (link) {
      t = link.type && link.type !== "*" ? String(link.type)
        : String(graph?.getNodeById?.(link.origin_id)?.outputs?.[link.origin_slot]?.type || "*");
    }
  }
  out.type = t;
  out.label = t === "*" ? "value" : t;
}

function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["colors"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const list = node._rnListEl;
  if (!list) return;
  const actions = readActions(node);
  const colors = colorTargets();
  list.replaceChildren();

  if (!colors.length) {
    const empty = document.createElement("div");
    empty.className = "rn-ps-note";
    empty.textContent = "no RedNode Palette in this workflow yet, add one and its colours appear here";
    list.appendChild(empty);
  }

  const seen = new Set();
  for (const c of colors) {
    if (seen.has(c.name)) continue;                 // one row per name, not per palette
    seen.add(c.name);
    const act = actionFor(actions, c.name);
    const row = document.createElement("div");
    row.className = "rn-ps-row" + (act ? " set" : "");

    const dot = document.createElement("span");
    dot.className = "rn-ps-dot";
    dot.style.background = c.color || "#9aa0a8";

    const name = document.createElement("span");
    name.className = "rn-ps-name";
    name.textContent = c.name;
    name.title = c.on ? "this colour is on right now" : "this colour is off right now";
    if (c.on) name.style.color = "#86d3a1";

    const btn = document.createElement("button");
    btn.className = "rn-ps-act" + (act ? ` ${act}` : "");
    btn.textContent = LABEL[act];
    btn.title = { "": "leave this colour alone", on: "switch it on when the chain reaches here",
                  off: "switch it off when the chain reaches here",
                  flip: "flip it when the chain reaches here" }[act];
    btn.onclick = () => {
      const next = readActions(node).filter((x) => x.name !== c.name);
      const step = CYCLE[(CYCLE.indexOf(act) + 1) % CYCLE.length];
      if (step) next.push({ name: c.name, do: step });
      writeActions(node, next);
      render(node);
    };

    row.append(dot, name, btn);
    list.appendChild(row);
  }

  const set = readActions(node).filter((x) => x.do);
  const live = isLive(node);
  const on = isEnabled(node);

  const note = document.createElement("div");
  note.className = "rn-ps-note";
  note.textContent = !set.length
    ? "nothing set, the value still passes through untouched"
    : live
      ? `${on ? "enabled" : "bypassed"} → ` + set.map((x) =>
          `${x.do === "flip" ? "(flip needs on-execute)" : ((x.do === "on") === on ? "on" : "off")} ${x.name}`
        ).join(", ")
      : `on execution: ${set.map((x) => `${x.do} ${x.name}`).join(", ")}`;
  list.appendChild(note);

  if (set.length && !live) {
    const warn = document.createElement("div");
    warn.className = "rn-ps-warn";
    warn.textContent = "applies to the NEXT run, the queued prompt already decided this one";
    list.appendChild(warn);
  }

  const bar = document.createElement("div");
  bar.className = "rn-ps-bar";
  const modeBtn = document.createElement("button");
  modeBtn.className = "rn-ps-mode" + (live ? " live" : "");
  modeBtn.textContent = live ? "LIVE · follows enable/bypass" : "ON EXECUTE";
  modeBtn.title = live
    ? "the colours follow this node's own state, so a group containing it acts as a switch. "
      + "Click for on-execute instead."
    : "the colours change when the chain reaches this node, which lands on the next run. "
      + "Click for live instead.";
  modeBtn.onclick = () => {
    node.properties = node.properties || {};
    node.properties.rn_pass_live = live ? false : undefined;
    if (node.properties.rn_pass_live === undefined) delete node.properties.rn_pass_live;
    node._rnLastEnabled = null;
    applyLive(node, { force: true });
    render(node);
  };
  const state = document.createElement("span");
  state.className = "cnt";
  state.textContent = on ? "enabled" : "bypassed";
  state.style.color = on ? "#86d3a1" : "#ff7b86";
  bar.append(modeBtn, state);
  list.appendChild(bar);

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    const want = 40 + Math.max(1, seen.size) * (ROW_H + 5) + 50;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], Math.min(want, 400))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const cw = findWidget(node, "colors");
  if (!cw) { requestAnimationFrame(() => build(node)); return; }
  cw.type = "hidden";
  cw.hidden = true;
  cw.computeSize = () => [0, -4];
  if (cw.element) cw.element.style.display = "none";
  if (cw.inputEl) cw.inputEl.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "rn-ps-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  wrap.appendChild(list);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_pass_ui", "rednode_pass_ui", wrap, {
    serialize: false,
    getValue: () => cw.value,
    setValue: (v) => { cw.value = v ?? "[]"; render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 40];
  node._rnWidget = w;

  node._rnRefresh = () => render(node);
  applyType(node);
  render(node);
  applyLive(node, { force: true });        // load the graph already in the right state

  // Bypassing a node does not fire any event we can listen for, so watch the mode. This
  // is the only poll in here and it does nothing unless the state actually changed.
  node._rnPoll = setInterval(() => {
    if (!node.graph) { clearInterval(node._rnPoll); return; }
    applyLive(node);
  }, 500);
}

const passNodes = () => {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === NODE_NAME) out.push(n);
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return out;
};

// the server tells us the chain got here
export function applyPassActions(detail) {
  const node0 = passNodes().find((n) => String(n.id) === String(detail?.node));
  // a live node already set its colours from its own state; running does not re-decide
  if (node0 && isLive(node0)) return;
  const actions = detail?.actions || [];
  for (const a of actions) {
    for (const t of colorTargets()) {
      if (t.name !== a.name) continue;
      const want = a.do === "flip" ? !t.on : a.do === "on";
      if (t.on !== want) setColor(t.node, t.name, want);
    }
  }
  const node = passNodes().find((n) => String(n.id) === String(detail?.node));
  if (node?._rnWidget?.element) {                 // a quick flash so you can see it fire
    const el = node._rnWidget.element;
    el.classList.add("rn-ps-fired");
    setTimeout(() => el.classList.remove("rn-ps-fired"), 900);
    node._rnRefresh?.();
  }
  for (const n of passNodes()) n._rnRefresh?.();
}

api.addEventListener("rednode.pass_colors", (e) => {
  try { applyPassActions(e.detail); } catch (err) {
    console.error("[RedNode Pass] could not apply colours:", err);
  }
});

app.registerExtension({
  name: "RedNode.Pass",
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
      requestAnimationFrame(() => { applyType(this); render(this); applyLive(this, { force: true }); });
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._rnPoll) clearInterval(this._rnPoll);
      onRemoved?.apply(this, arguments);
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      if (this._rnWidget) { applyType(this); render(this); }
      return r;
    };
  },
});
