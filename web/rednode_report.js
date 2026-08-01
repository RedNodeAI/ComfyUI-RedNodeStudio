import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// RedNode Report — a sign whose words come from the run.
//
// The Note is typed and never executes. This is the other half: the backend pushes what
// went past it and the node shows it, in the same styling, so a workflow can label its
// own state instead of you opening three nodes to find out.
//
// The reading lives on the node object, never in the workflow: a report should be from
// the run you just did, not from whenever the file was saved.

const NODE_NAME = "RedNodeReport";
const NOTE_COLORS = {
  red: ["#ff8a99", "#b8283c"],
  violet: ["#c4a0ff", "#a855f7"],
  cyan: ["#a5f3fc", "#22d3ee"],
  amber: ["#fde68a", "#f59e0b"],
  lime: ["#d9f99d", "#84cc16"],
  rose: ["#fecdd3", "#f43f5e"],
  blue: ["#bfdbfe", "#3b82f6"],
  white: ["#ffffff", "#cbd5e1"],
};

const css = document.createElement("style");
css.textContent = `
.rn-rp-box{display:flex;flex-direction:column;gap:4px;align-items:center;justify-content:center;
  box-sizing:border-box;width:100%;height:100%;padding:8px;border-radius:8px;
  overflow:auto;contain:paint;background:#0b0c0e;border:1px solid #b8283c33}
.rn-rp-label{font:11px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;
  opacity:.5;flex:none}
.rn-rp-text{text-align:center;font-weight:600;letter-spacing:.5px;line-height:1.2;
  word-break:break-word;white-space:pre-wrap}
.rn-rp-waiting{opacity:.35;font-style:italic}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);
const valOf = (node, name, fallback) => {
  const w = findWidget(node, name);
  return w === undefined || w.value === undefined || w.value === "" ? fallback : w.value;
};

function paint(node) {
  const box = node._rnRpBox;
  if (!box) return;
  const pick = String(valOf(node, "color", "red"));
  let [fill, glowCol] = NOTE_COLORS[pick] || NOTE_COLORS.red;
  if (pick === "custom") {
    const hex = String(valOf(node, "custom_color", "")).trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) { fill = hex; glowCol = hex; }
  }
  const size = Math.max(8, Number(valOf(node, "font_size", 28)) || 28);
  const glow = Math.max(0, Math.min(100, Number(valOf(node, "glow", 40)) || 0));
  const text = node._rnRpText;

  node._rnRpLabelEl.textContent = String(valOf(node, "label", ""));
  node._rnRpLabelEl.style.display = node._rnRpLabelEl.textContent ? "" : "none";
  node._rnRpLabelEl.style.color = fill;

  const el = node._rnRpTextEl;
  el.classList.toggle("rn-rp-waiting", !text);
  el.textContent = text || "waiting for a run";
  el.style.fontSize = `${size}px`;
  el.style.color = fill;
  // capped radii, same reason as the note: a wide blur is re-rasterised on every pan
  const r = (mult, cap) => Math.min(glow * mult, cap).toFixed(1);
  el.style.textShadow = (glow && text)
    ? `0 0 ${r(0.10, 10)}px ${glowCol}, 0 0 ${r(0.26, 26)}px ${glowCol}, `
      + `0 0 ${r(0.55, 40)}px ${glowCol}`
    : "none";
  box.style.borderColor = `${fill}33`;
}

function build(node) {
  if (node._rnRpBox) return;
  injectStyle();
  const box = document.createElement("div");
  box.className = "rn-rp-box";
  const label = document.createElement("div");
  label.className = "rn-rp-label";
  const text = document.createElement("div");
  text.className = "rn-rp-text";
  box.append(label, text);
  node._rnRpBox = box;
  node._rnRpLabelEl = label;
  node._rnRpTextEl = text;
  node._rnRpText = node._rnRpText || "";
  const w = node.addDOMWidget("rednode_report_ui", "rednode_report_ui", box, {
    serialize: false,                     // a reading is never saved into the workflow
    getMinHeight: () => 60,
  });
  w.element = box;
  if (node.size[0] < 260) node.size[0] = 260;
  if (node.size[1] < 140) node.size[1] = 140;
  paint(node);
}

/** Re-read the settings whenever one of them changes. */
function hookWidgets(node) {
  for (const w of node.widgets || []) {
    if (w._rnRpHooked) continue;
    w._rnRpHooked = true;
    const cb = w.callback;
    w.callback = function () {
      const out = cb?.apply(this, arguments);
      paint(node);
      return out;
    };
  }
}

/**
 * Find the node a reading belongs to, WHEN THE READING ARRIVES.
 *
 * A map filled at onNodeCreated does not work: the node has no final id yet at that
 * point, so every report registered itself under the same placeholder and no message
 * ever matched. Looking it up at message time also handles the id ComfyUI gives a node
 * inside a subgraph, which is namespaced ("12:8375"), by falling back to the last
 * segment.
 */
function findReport(rawId) {
  const want = String(rawId ?? "");
  if (!want) return null;
  const tail = want.includes(":") ? want.slice(want.lastIndexOf(":") + 1) : want;
  let hit = null;
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph) || hit) return;
    seen.add(graph);
    for (const n of graph._nodes || graph.nodes || []) {
      if (!n) continue;
      if (n.type === NODE_NAME && (String(n.id) === want || String(n.id) === tail)) {
        hit = n;
        return;
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return hit;
}

function onReport(detail) {
  const node = findReport(detail?.node);
  if (!node) return;
  if (!node._rnRpBox) build(node);
  node._rnRpText = String(detail.text ?? "");
  const lw = findWidget(node, "label");
  if (lw && detail.label !== undefined && lw.value !== detail.label) lw.value = detail.label;
  paint(node);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "rednode.report",
  async setup() {
    api.addEventListener("rednode.report", (e) => onReport(e.detail));
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const start = (node) => {
      build(node);
      hookWidgets(node);
      requestAnimationFrame(() => paint(node));
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      start(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      start(this);
    };

    // A report that nothing reads never runs, exactly like RedNode Stage Tap. Saying so
    // on the node is the honest answer; making it an output node would drag its whole
    // upstream into every run and force unchosen switch branches.
    const onDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDraw?.apply(this, arguments);
      if (this.flags?.collapsed) return;
      const wired = (this.outputs || []).some((o) => (o.links || []).length);
      if (wired) return;
      ctx.save();
      ctx.fillStyle = "#f0c58a";
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("wire my output onward, or I will not run",
                   this.size[0] / 2, this.size[1] + 13);
      ctx.restore();
    };

  },
});

export { paint, onReport };
