import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
// the panel itself now lives in its own module; the workspace only supplies the
// write/redraw hooks that let it not care which node is hosting it
import { postBody, refreshPostPresets } from "./rednode_ws_post.js";
import { POST_FX } from "./rednode_ws_tables.js";
import { postWrite, postRender } from "./rednode_workspace.js";

// RedNode Post FX — the same grading panel the Studio Workspace's Post tab
// carries, on a node of its own. Sibling to RedNode Post Process, not a
// replacement: that one reads the workspace, this one carries its own settings. Feed it any image and the effects apply, with no
// workspace in the graph at all: a folder of pictures through a Load Image is as
// valid a use as the tail of a generation workflow.
//
// The cards, the looks, the random ranges and the cog all come from
// rednode_workspace.js so there is exactly ONE implementation of the chain's UI.
// This file only supplies the plumbing: which widget holds the config, and what
// "redraw" means when there are no tabs around it.

const NODE_MIN_W = 460;
const MIN_PANEL_H = 260;

const findWidget = (node, name) => (node.widgets || []).find((w) => w.name === name);

function readCfg(node) {
  const w = findWidget(node, "config");
  let d = {};
  try {
    d = JSON.parse(w?.value || "{}") || {};
  } catch (e) {
    d = {};
  }
  if (typeof d !== "object" || Array.isArray(d)) d = {};
  d.post = d.post && typeof d.post === "object" ? d.post : {};
  // The same normalisation the Workspace does, and it is NOT optional: the panel reads
  // cfg.post[fx.id].on for every effect, so a FRESH node, whose config is just "{}",
  // threw during onNodeCreated. The frontend aborts the whole insertion when that
  // happens, silently, which is why picking this node from the search dialog did
  // nothing at all. A node from a saved workflow carried an already-normalised config,
  // which is how the bug hid for so long.
  for (const fx of POST_FX) {
    const b = d.post[fx.id] = d.post[fx.id] && typeof d.post[fx.id] === "object"
      ? d.post[fx.id] : {};
    b.on = !!b.on;
    b.rand = b.rand && typeof b.rand === "object" ? b.rand : {};
    for (const c of fx.controls) {
      if (c.choice) { if (typeof b[c.key] !== "string") b[c.key] = c.def; }
      else if (typeof b[c.key] !== "number") b[c.key] = c.def;
    }
  }
  if (typeof d.look_thumb !== "number") d.look_thumb = 76;
  d.look_thumb = Math.max(48, Math.min(180, d.look_thumb));
  d.post_ui = d.post_ui && typeof d.post_ui === "object" ? d.post_ui : {};
  if (!["default", "0", "1", "2", "3"].includes(String(d.post_ui.precision))) {
    d.post_ui.precision = "default";
  }
  d.post_ui.hints = d.post_ui.hints === undefined ? true : !!d.post_ui.hints;
  d.post_ui.order = Array.isArray(d.post_ui.order) ? d.post_ui.order : [];
  return d;
}

function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnCfg ?? {});
  node.graph?.change?.();
}

function render(node) {
  // the frontend draws an input dot for the hidden JSON widget; strip it, exactly
  // as every other RedNode panel does
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "config") node.inputs.splice(i, 1);
  }
  const root = node._rnRootEl;
  if (!root) return;
  root.replaceChildren();
  const body = document.createElement("div");
  body.className = "rn-ws-body";
  body.style.borderRadius = "7px";
  postBody(node, body);
  root.appendChild(body);
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], 520)]);
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
  // the shared panel writes and redraws through these, so it does not need to know
  // whether it is living in the workspace's tab strip or on this node
  node._rnPostWrite = writeCfg;
  node._rnPostRender = render;

  const wrap = document.createElement("div");
  wrap.className = "rn-ws-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                   "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  // plain wheel scrolls the panel, shift+wheel zooms the canvas: the same deal as
  // the workspace, because this panel is just as tall
  wrap.addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    app.canvas?.processMouseWheel?.(e);
  }, { passive: false });
  node._rnRootEl = wrap;

  const w = node.addDOMWidget("rednode_post_ui", "rednode_post_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnCfg = readCfg(node); render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  render(node);
}

app.registerExtension({
  name: "RedNode.PostFX",
  async setup() {
    await refreshPostPresets();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "RedNodePostFX") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      build(this);
      this._rnCfg = readCfg(this);
      render(this);
    };
  },
});
