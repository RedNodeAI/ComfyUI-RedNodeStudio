import { app } from "../../scripts/app.js";
import {
  MAX_INPUTS, MIN_INPUTS, slotName, slotCount, isWired,
  applyTypes, syncSlots, buildSlotBar, addTypeMenuOption, makeCombo,
} from "./rednode_slots.js";

// RedNode Switch — one branch passes, by name.
//
// Two jobs here. First, the panel: one row per input slot, each with an editable name
// and a radio to choose it, so picking a branch is one click and the names are yours.
// Second, `selected` is a STRING widget that we turn into a real dropdown of those
// names — a genuine COMBO would be validated server-side against a fixed list, and it
// also means RedNode Control Panel sees an ordinary dropdown it can drive.
//
// Branches are added and removed explicitly with + / −, so the node has exactly the
// number of sockets you asked for and no blank one waiting at the bottom.
//
// The output starts as "*" and takes the type of the first branch you wire (LATENT,
// IMAGE, MODEL…). Downstream nodes refuse to connect to a wildcard, so without this the
// switch is a dead end. The other branches take the same type, which also stops you
// mixing a LATENT and an IMAGE into one switch by accident.

const NODE_NAME = "RedNodeSwitch";
const NODE_MIN_W = 300;
const MIN_PANEL_H = 90;
const ROW_H = 30;

const css = document.createElement("style");
css.textContent = `
.rn-sw-wrap{display:flex;flex-direction:column;gap:5px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-sw-row{display:flex;align-items:center;gap:7px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none;cursor:pointer}
.rn-sw-row.on{background:#1e5233;outline:1px solid #2f7a4d}
.rn-sw-row.empty{opacity:.5}
.rn-sw-row.on.empty{background:#4a2020;outline:1px solid #7f2230}
.rn-sw-dot{width:14px;height:14px;border-radius:50%;border:2px solid #5a616b;flex:none;box-sizing:border-box}
.rn-sw-row.on .rn-sw-dot{border-color:#86d3a1;background:#22c55e;box-shadow:0 0 6px #22c55e}
.rn-sw-row.on.empty .rn-sw-dot{border-color:#ff7b86;background:#7f2230;box-shadow:none}
.rn-sw-n{font-size:10px;opacity:.45;width:12px;flex:none;text-align:right}
.rn-sw-name{flex:1;background:transparent;border:0;color:#e8ecf1;font-size:12.5px;font-weight:600;
  padding:2px 0;min-width:40px}
.rn-sw-name:focus{outline:none;border-bottom:1px solid #b8283c}
.rn-sw-tag{font-size:9.5px;opacity:.5;flex:none;letter-spacing:.3px}
.rn-sw-note{font-size:10.5px;opacity:.45;line-height:1.45;padding:2px 2px 0}
.rn-sw-head{display:flex;gap:6px;align-items:center;flex:none;padding-top:2px}
.rn-sw-head button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  cursor:pointer;font-size:13px;font-weight:700;height:26px;width:34px;line-height:1}
.rn-sw-head button:hover:not(:disabled){border-color:#b8283c;color:#fff}
.rn-sw-head button:disabled{opacity:.35;cursor:not-allowed}
.rn-sw-head .cnt{font-size:10.5px;opacity:.45;margin-left:auto}
.rn-sw-head button.rn-sw-type{width:auto;padding:0 9px;font-size:10.5px;font-weight:600;
  letter-spacing:.3px;color:#9aa0a8}
.rn-sw-head button.rn-sw-type.any{border-color:#6b4a1d;color:#f0c58a;background:#241d12}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);
function readLabels(node) {
  const w = findWidget(node, "labels");
  try {
    const d = JSON.parse(w?.value || "{}");
    return d && typeof d === "object" && !Array.isArray(d) ? (d.labels || d) : {};
  } catch (e) {
    return {};
  }
}
function writeLabels(node, labels) {
  const w = findWidget(node, "labels");
  if (w) w.value = JSON.stringify({ labels });
  node.graph?.change?.();
}
const labelOf = (labels, i) => (labels[i] || labels[String(i)] || "").trim() || `branch ${i}`;

// The dropdown carries "3 · img2img": the number keeps it unambiguous when two branches
// share a name, and switch.py parses either half.
const choiceFor = (labels, i) => `${i} · ${labelOf(labels, i)}`;

function chosenIndex(node) {
  const sel = String(findWidget(node, "selected")?.value ?? "1");
  const labels = readLabels(node);
  const head = sel.split(" · ")[0].trim();
  if (/^\d+$/.test(head)) return Math.min(MAX_INPUTS, Math.max(1, parseInt(head, 10)));
  for (let i = 1; i <= MAX_INPUTS; i++) if (labelOf(labels, i) === sel.trim()) return i;
  return 1;
}

function setChosen(node, i) {
  const w = findWidget(node, "selected");
  if (!w) return;
  w.value = choiceFor(readLabels(node), i);
  try { w.callback?.(w.value); } catch (e) { /* the widget's own hook */ }
  node.setDirtyCanvas?.(true, true);
}

// keep the dropdown's options in step with the labels and the number of slots
function syncChoices(node) {
  const w = findWidget(node, "selected");
  if (!w) return;
  const labels = readLabels(node);
  const n = Math.max(MIN_INPUTS, slotCount(node));
  w.options = w.options || {};
  w.options.values = Array.from({ length: n }, (_, k) => choiceFor(labels, k + 1));
  const want = choiceFor(labels, chosenIndex(node));
  if (w.value !== want) w.value = want;                 // a rename must not orphan the value
}

function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["labels"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const list = node._rnListEl;
  if (!list) return;
  const labels = readLabels(node);
  const chosen = chosenIndex(node);
  const n = Math.max(MIN_INPUTS, slotCount(node));
  list.replaceChildren();

  for (let i = 1; i <= n; i++) {
    const wired = isWired(node, i);
    const row = document.createElement("div");
    row.className = "rn-sw-row" + (i === chosen ? " on" : "") + (wired ? "" : " empty");
    row.title = wired ? "click to send this branch to the output"
                      : "nothing is wired into this branch yet";

    const dot = document.createElement("span");
    dot.className = "rn-sw-dot";
    const num = document.createElement("span");
    num.className = "rn-sw-n";
    num.textContent = i;

    const name = document.createElement("input");
    name.className = "rn-sw-name";
    name.value = labels[i] || labels[String(i)] || "";
    name.placeholder = `branch ${i}`;
    name.title = "name this branch, the dropdown and any saved scene use this name";
    name.addEventListener("change", () => {
      const next = readLabels(node);
      const v = name.value.trim();
      if (v) next[i] = v; else delete next[i];
      writeLabels(node, next);
      syncChoices(node);
      render(node);
    });
    // clicks in the name box must not also flip the selection
    name.addEventListener("pointerdown", (e) => e.stopPropagation());

    const tag = document.createElement("span");
    tag.className = "rn-sw-tag";
    tag.textContent = i === chosen ? (wired ? "LIVE" : "NOT WIRED") : (wired ? "" : "empty");
    if (i === chosen && !wired) tag.style.color = "#ff7b86";

    row.append(dot, num, name, tag);
    row.addEventListener("click", (e) => {
      if (e.target === name) return;
      setChosen(node, i);
      render(node);
    });
    list.appendChild(row);
  }

  const note = document.createElement("div");
  note.className = "rn-sw-note";
  note.textContent = "only the chosen branch runs, the others are skipped, like bypassing their group";
  list.appendChild(note);

  // adding or removing a slot changes the dropdown, and dropping the slot you had
  // selected has to move the selection somewhere real
  const afterSlots = (removed) => {
    if (removed && chosenIndex(node) >= removed) setChosen(node, removed - 1);
    syncChoices(node);
    render(node);
  };
  list.appendChild(buildSlotBar(node, afterSlots));

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    const want = 34 + n * (ROW_H + 5) + 40;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], Math.min(want, 420))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  if (!findWidget(node, "selected") || !findWidget(node, "labels")) {
    requestAnimationFrame(() => build(node));   // widgets not built yet
    return;
  }

  const sel = makeCombo(node, "selected", [findWidget(node, "selected").value || "1"]);
  sel.callback = function () { render(node); };

  const labelsW = findWidget(node, "labels");
  labelsW.type = "hidden";
  labelsW.hidden = true;
  labelsW.computeSize = () => [0, -4];
  if (labelsW.element) labelsW.element.style.display = "none";
  if (labelsW.inputEl) labelsW.inputEl.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "rn-sw-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  wrap.appendChild(list);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_switch_ui", "rednode_switch_ui", wrap, {
    serialize: false,
    getValue: () => findWidget(node, "labels")?.value,
    setValue: (v) => { const lw = findWidget(node, "labels"); if (lw) lw.value = v ?? "{}"; render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 50];
  node._rnWidget = w;

  syncSlots(node);
  syncChoices(node);
  applyTypes(node);
  render(node);
}

app.registerExtension({
  name: "RedNode.Switch",
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
      requestAnimationFrame(() => {
        syncSlots(this);
        syncChoices(this);
        applyTypes(this);
        render(this);
      });
    };

    // wiring does not add or remove slots any more — it only changes how a row reads
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      if (this._rnWidget) { applyTypes(this); render(this); }
      return r;
    };

    addTypeMenuOption(nodeType, (node) => render(node));
  },
});
