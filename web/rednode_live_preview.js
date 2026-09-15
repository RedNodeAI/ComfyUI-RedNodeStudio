import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// RedNode Live Preview — the picture forming, big, on a node of its own.
//
// ComfyUI already streams an in-progress preview of whichever node is sampling,
// tagged with that node's id, and paints it small on that node. The Studio
// Workspace samples inside itself, so its preview lands under a panel nobody can
// see it through. This node follows its own image input back to the node it is
// wired to and shows THAT node's stream here, with a step bar, then the finished
// frame when the run lands. Nothing is rendered twice and nothing else is wired.
//
// Unwired, it shows whatever is rendering, which is the right default for a node
// dropped on the canvas to watch a run.

const NODE_NAME = "RedNodeLivePreview";
const NODE_MIN_W = 300;
const MIN_PANEL_H = 220;

const css = document.createElement("style");
css.textContent = `
.rn-lp-wrap{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:hidden;
  contain:layout paint style;will-change:transform}
/* A layer of its own, layout and paint contained: ComfyUI moves every DOM widget
   by its position on each frame of a pan, and without this the browser repainted the
   panel and re-scaled its picture every frame, which read as the whole canvas lagging.
   With it the drawn panel is shifted as it is. */
.rn-lp-main{flex:1;min-height:100px;display:flex;align-items:center;justify-content:center;
  background:#111316;border-radius:6px;overflow:hidden;position:relative}
/* The frame FILLS the pane, aspect kept: a streamed frame is 512px on its long
   edge and a node is often bigger, so capping at natural size left a small
   picture in a large box. contain scales it up as far as the pane allows. */
.rn-lp-main img{width:100%;height:100%;object-fit:contain}
/* the finished frame is saved at 512 px (live_preview.py), so the pane never holds a
   full-size picture to re-scale on every pan */
.rn-lp-tag{position:absolute;top:5px;left:5px;background:#000c;color:#d4ffe4;font-size:10.5px;
  padding:2px 7px;border-radius:4px;pointer-events:none;font-variant-numeric:tabular-nums}
.rn-lp-tag.live{color:#ffd58a}
.rn-lp-tag.wait{color:#9aa0a8}
.rn-lp-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:#0008}
.rn-lp-bar i{display:block;height:100%;width:0;background:#b8283c;transition:width .15s}
.rn-lp-empty{opacity:.45;font-size:11.5px;text-align:center;line-height:1.5;padding:10px}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const fileUrl = (f) => api.apiURL(
  `/view?filename=${encodeURIComponent(f.filename)}&type=${f.type || "temp"}`
  + `&subfolder=${encodeURIComponent(f.subfolder || "")}`);

// every Live Preview node on the graph, subgraphs included
function liveNodes() {
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
}

// the node this one is wired to, by following its image input's link back.
// null means unwired: watch everything.
function sourceId(node) {
  const link = node.inputs?.[0]?.link;
  if (link == null) return null;
  // litegraph's own lookup first; the link table is a Map on current frontends
  // and a plain object on older ones, so the fallbacks try both shapes
  try {
    const src = node.getInputNode?.(0);
    if (src?.id != null) return String(src.id);
  } catch (e) { /* no graph yet */ }
  const g = node.graph || app.graph;
  const l = g?.links?.get?.(link) ?? g?.links?.[link] ?? g?._links?.get?.(link)
         ?? app.graph?.links?.get?.(link) ?? app.graph?.links?.[link];
  if (!l) return null;
  const id = l.origin_id ?? l[1];
  return id == null ? null : String(id);
}

// does this node want the stream tagged with these ids? A preview from inside a
// subgraph carries the subgraph node's id as display id, which is the one the
// wire points at from outside.
function watches(node, ...ids) {
  const want = sourceId(node);
  if (want === null) return true;
  return ids.some((x) => x != null && String(x) === want);
}

function state(node) {
  return (node._rnLp ||= { kind: "idle", src: "", step: 0, total: 0, blobUrl: "" });
}

function showBlob(node, blob, fromId) {
  const s = state(node);
  // once per run, so a wrong wire shows up in the console instead of as silence
  if (s.kind !== "live") {
    console.log(`[RedNode Live Preview] node ${node.id} showing frames from node ${fromId ?? "?"}`
                + (sourceId(node) === null ? " (unwired: any node)" : ""));
  }
  if (s.blobUrl) { try { URL.revokeObjectURL(s.blobUrl); } catch (e) { /* gone */ } }
  s.blobUrl = URL.createObjectURL(blob);
  s.src = s.blobUrl;
  s.kind = "live";
  render(node);
}

function render(node) {
  const root = node._rnRootEl;
  if (!root) return;
  const s = state(node);
  root.replaceChildren();
  const main = document.createElement("div");
  main.className = "rn-lp-main";
  if (!s.src) {
    const empty = document.createElement("div");
    empty.className = "rn-lp-empty";
    empty.textContent = sourceId(node) === null
      ? "Shows whatever is rendering, step by step. Wire an image output in to watch "
        + "one node only."
      : "Watching the node wired in. The picture forms here as it renders.";
    main.appendChild(empty);
  } else {
    const img = document.createElement("img");
    img.decoding = "async";
    img.src = s.src;
    main.appendChild(img);
  }
  const tag = document.createElement("span");
  tag.className = "rn-lp-tag " + (s.kind === "live" ? "live" : s.kind === "wait" ? "wait" : "");
  tag.textContent = s.kind === "live"
    ? (s.label ? `${s.label} · ` : "")
      + (s.total ? `rendering ${s.step} / ${s.total}` : "rendering")
      + (s.decoder ? ` · ${String(s.decoder).replace(/\.safetensors$/i, "")}` : "")
    : s.kind === "done" ? "done"
    : s.kind === "wait" ? "waiting for the run" : "";
  if (tag.textContent) main.appendChild(tag);
  if (s.kind === "live" && s.total) {
    const bar = document.createElement("div");
    bar.className = "rn-lp-bar";
    const fill = document.createElement("i");
    fill.style.width = Math.max(0, Math.min(100, (100 * s.step) / s.total)) + "%";
    bar.appendChild(fill);
    main.appendChild(bar);
  }
  root.appendChild(main);
  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], 300)]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const wrap = document.createElement("div");
  wrap.className = "rn-lp-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  // the wheel over the panel zooms the canvas, exactly as over empty canvas
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    app.canvas?.processMouseWheel?.(e);
  }, { passive: false });
  node._rnRootEl = wrap;
  const w = node.addDOMWidget("rednode_live_preview_ui", "rednode_live_preview_ui", wrap, {
    serialize: false,
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;
  // the stock PreviewImage draw would paint the finished frame under the panel
  try {
    Object.defineProperty(node, "imgs", {
      get() { return undefined; },
      set(v) { /* the panel is the display */ },
      configurable: true,
    });
  } catch (e) { /* already defined */ }
  render(node);
}

// ---- the stream ----------------------------------------------------------------
// THE PACK'S OWN FRAMES: live_preview.py decodes every step with the tiny decoder
// and sends it here as a data URI, tagged with the node, the step and the total.
// This is the stream that matters; it works whatever ComfyUI's preview setting is.
api.addEventListener("rednode-live-frame", (e) => {
  const d = e?.detail || {};
  if (!d.data || d.node == null) return;
  for (const n of liveNodes()) {
    if (!watches(n, d.node)) continue;
    const s = state(n);
    if (s.kind !== "live") {
      console.log(`[RedNode Live Preview] node ${n.id} showing frames from node ${d.node}`
                  + (d.decoder ? ` (${d.decoder})` : "")
                  + (sourceId(n) === null ? " (unwired: any node)" : ""));
    }
    if (s.blobUrl) { try { URL.revokeObjectURL(s.blobUrl); } catch (err) { /* gone */ } s.blobUrl = ""; }
    s.src = d.data;
    s.step = Number(d.step) || 0;
    s.total = Number(d.total) || 0;
    s.decoder = d.decoder || "";
    s.label = d.label || "";
    s.kind = "live";
    render(n);
  }
});
// ComfyUI's own preview frame, tagged, as a fallback for samplers the pack does not
// wrap. Current frontends send the blob with the ids of the node that made it; an
// older one sends the bare blob, and the executing node is the frontend's own
// runningNodeId.
api.addEventListener("b_preview_with_metadata", (e) => {
  const d = e?.detail || {};
  if (!d.blob) return;
  for (const n of liveNodes()) {
    if (watches(n, d.nodeId, d.displayNodeId, d.realNodeId)) showBlob(n, d.blob, d.displayNodeId ?? d.nodeId);
  }
});
api.addEventListener("b_preview", (e) => {
  const blob = e?.detail;
  if (!blob || typeof blob !== "object" || blob.blob) return;   // the tagged form handled above
  const running = app.runningNodeId;
  for (const n of liveNodes()) {
    if (watches(n, running)) showBlob(n, blob, running);
  }
});
// the step count rides the progress event, tagged the same way
api.addEventListener("progress", (e) => {
  const d = e?.detail || {};
  if (d.node == null) return;
  for (const n of liveNodes()) {
    if (!watches(n, d.node)) continue;
    const s = state(n);
    s.step = Number(d.value) || 0;
    s.total = Number(d.max) || 0;
    if (s.kind !== "live") { s.kind = "live"; }
    render(n);
  }
});
// a run starting: say so, keep the last frame up until a new one arrives
api.addEventListener("execution_start", () => {
  for (const n of liveNodes()) {
    const s = state(n);
    s.kind = "wait";
    s.step = 0;
    s.total = 0;
    render(n);
  }
});
// the finished frame, for THIS node, through the standard preview channel
api.addEventListener("executed", (e) => {
  const d = e?.detail || {};
  const images = d.output?.images;
  if (!Array.isArray(images) || !images.length) return;
  const target = String(d.display_node ?? d.node);
  for (const n of liveNodes()) {
    if (String(n.id) !== target) continue;
    const s = state(n);
    if (s.blobUrl) { try { URL.revokeObjectURL(s.blobUrl); } catch (err) { /* gone */ } s.blobUrl = ""; }
    s.src = fileUrl(images[0]);
    s.kind = "done";
    render(n);
  }
});

app.registerExtension({
  name: "RedNode.LivePreview",
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
      requestAnimationFrame(() => render(this));
    };
    // rewiring the input changes which node is watched; redraw the hint
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      onConn?.apply(this, arguments);
      render(this);
    };
    nodeType.prototype.onExecuted = function () {};
  },
});
