import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { arrowKeys } from "./rednode_keys.js";
import { findNodes } from "./rednode_graph.js";

// RedNode Stage View — the strip of everything the workflow did last run.
//
// Every RedNode Stage Tap in the graph photographs its moment; this panel reads
// them straight from the server. Click a stage to look at it, click a second to
// compare, then drag the handle across to wipe between the two. Nothing is wired
// to this node, which is the whole point: add or move a tap and the strip
// follows, with no Set/Get pairs to maintain.

const NODE_MIN_W = 420;
const MIN_PANEL_H = 300;

const css = document.createElement("style");
css.textContent = `
.rn-sg-wrap{display:flex;flex-direction:column;gap:7px;padding:9px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-sg-bar{display:flex;gap:6px;align-items:center;flex:none}
.rn-sg-note{font-size:11.5px;opacity:.5;line-height:1.45}
.rn-sg-btn{background:#1b1e23;border:1px solid #2a2e35;border-radius:5px;color:#9aa0a8;
  cursor:pointer;font-size:11.5px;padding:5px 9px;flex:none}
.rn-sg-btn:hover{border-color:#b8283c;color:#fff}
.rn-sg-btn.on{background:#1e3a52;border-color:#4a8fe0;color:#9dc0ff}
.rn-sg-strip{display:flex;gap:6px;overflow-x:auto;flex:none;padding-bottom:3px}
.rn-sg-th{position:relative;width:72px;height:72px;border-radius:5px;overflow:hidden;
  border:2px solid #2a2e35;background:#111316;cursor:pointer;flex:none}
.rn-sg-th img{width:100%;height:100%;object-fit:cover;display:block}
.rn-sg-th:hover{border-color:#4a8fe0}
.rn-sg-th.a{border-color:#22c55e}
.rn-sg-th.b{border-color:#e08a3c}
.rn-sg-th .n{position:absolute;left:0;right:0;bottom:0;background:#000c;color:#e8ecf1;
  font-size:9px;padding:2px 3px;text-align:center;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rn-sg-th .k{position:absolute;top:2px;left:2px;background:#000c;border-radius:3px;
  font-size:9px;padding:1px 4px;font-weight:700}
.rn-sg-th.a .k{color:#22c55e}
.rn-sg-th.b .k{color:#e08a3c}
.rn-sg-view{position:relative;flex:1;min-height:160px;background:#111316;border-radius:6px;
  border:1px solid #2a2e35;overflow:hidden;display:flex;align-items:center;
  justify-content:center}
.rn-sg-view img{max-width:100%;max-height:100%;display:block}
.rn-sg-cmp{position:relative;width:100%;height:100%;overflow:hidden;cursor:ew-resize}
.rn-sg-cmp .base,.rn-sg-cmp .top{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center}
/* The top layer stays the FULL size of the frame and is clipped, rather than being
   narrowed. Narrowing it re-centres the image inside the smaller box, so instead of
   one picture revealing another you get two half-size pictures side by side. */
.rn-sg-cmp .top{overflow:hidden;clip-path:inset(0 50% 0 0)}
.rn-sg-cmp img{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  max-width:100%;max-height:100%}
.rn-sg-cmp .handle{position:absolute;top:0;bottom:0;width:2px;background:#fff;
  box-shadow:0 0 6px #000a;pointer-events:none}
.rn-sg-cmp .handle::after{content:"";position:absolute;top:50%;left:50%;width:22px;
  height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#fff;
  box-shadow:0 0 6px #000a}
.rn-sg-tag{position:absolute;top:6px;background:#000b;color:#fff;font-size:10px;
  padding:2px 6px;border-radius:4px;pointer-events:none}
.rn-sg-empty{font-size:12px;opacity:.45;text-align:center;padding:0 16px;line-height:1.5}
`;
let styled = false;
const injectStyle = () => {
  if (!styled && document.head) { document.head.appendChild(css); styled = true; }
};

let stages = [];
let reachedServer = true;
async function refreshStages() {
  try {
    const res = await api.fetchApi("/rednode/stages");
    const d = await res.json();
    stages = Array.isArray(d.stages) ? d.stages : [];
    reachedServer = true;
  } catch (e) {
    stages = [];
    reachedServer = false;                           // said out loud in the panel
    console.error("[RedNode Stages] could not read the stages:", e);
  }
}

// An empty strip has three quite different causes and they need different fixes,
// so the panel says which one it is instead of showing the same blank box.
function emptyReason() {
  if (!reachedServer) {
    return "Could not reach the server. The pack may not have finished loading, or "
         + "ComfyUI needs a restart to pick up the Stage nodes.";
  }
  const taps = findNodes("RedNodeStageTap").length;
  if (!taps) {
    return "No Stage Taps in this workflow yet. Add a RedNode Stage Tap wherever you "
         + "want to see what is happening and wire an image or latent into it. It "
         + "does not need its outputs connected.";
  }
  return `${taps} Stage Tap${taps === 1 ? "" : "s"} found, but nothing recorded yet. `
       + "Queue a run and each one appears here in order.";
}

function render(node) {
  const root = node._rnRootEl;
  if (!root) return;
  root.replaceChildren();

  const bar = document.createElement("div");
  bar.className = "rn-sg-bar";
  const count = document.createElement("span");
  count.className = "rn-sg-note";
  count.textContent = stages.length
    ? `${stages.length} stage${stages.length === 1 ? "" : "s"} from the last run`
    : "No stages yet";
  const refresh = document.createElement("button");
  refresh.className = "rn-sg-btn";
  refresh.textContent = "Refresh";
  refresh.title = "Re-read the taps. The strip also refreshes itself when a run ends.";
  refresh.onclick = async () => { await refreshStages(); render(node); };
  const cmp = document.createElement("button");
  cmp.className = "rn-sg-btn" + (node._rnCmp ? " on" : "");
  cmp.textContent = "Compare";
  cmp.title = node._rnCmp
    ? "Comparing two stages. Click a thumbnail to set the left side, then another "
      + "for the right, and drag across the picture to wipe between them."
    : "Turn on comparing: pick two stages and drag a wipe between them.";
  cmp.onclick = () => {
    node._rnCmp = !node._rnCmp;
    if (node._rnCmp && node._rnB === undefined) {
      node._rnB = Math.min(stages.length - 1, (node._rnA ?? 0) + 1);
    }
    render(node);
  };
  bar.append(count, refresh, cmp);
  root.appendChild(bar);

  if (!stages.length) {
    const empty = document.createElement("div");
    empty.className = "rn-sg-view";
    const msg = document.createElement("div");
    msg.className = "rn-sg-empty";
    msg.textContent = emptyReason();
    empty.appendChild(msg);
    root.appendChild(empty);
    return;
  }

  const a = Math.min(node._rnA ?? 0, stages.length - 1);
  const b = Math.min(node._rnB ?? Math.min(1, stages.length - 1), stages.length - 1);

  const view = document.createElement("div");
  view.className = "rn-sg-view";
  if (node._rnCmp && stages.length > 1 && a !== b) {
    const box = document.createElement("div");
    box.className = "rn-sg-cmp";
    const base = document.createElement("div");
    base.className = "base";
    const bimg = document.createElement("img");
    bimg.src = stages[b].thumb;
    base.appendChild(bimg);
    const top = document.createElement("div");
    top.className = "top";
    const aimg = document.createElement("img");
    aimg.src = stages[a].thumb;
    top.appendChild(aimg);
    const handle = document.createElement("div");
    handle.className = "handle";
    const tagA = document.createElement("span");
    tagA.className = "rn-sg-tag";
    tagA.style.left = "6px";
    tagA.textContent = stages[a].label;
    const tagB = document.createElement("span");
    tagB.className = "rn-sg-tag";
    tagB.style.right = "6px";
    tagB.textContent = stages[b].label;
    const setWipe = (pct) => {
      const p = Math.max(0, Math.min(100, pct));
      node._rnWipe = p;
      // clip, do not resize: both layers stay the same size and in the same place,
      // so the line reveals one picture over the other instead of moving them
      top.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
      handle.style.left = p + "%";
    };
    box.append(base, top, handle, tagA, tagB);
    box.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const move = (ev) => {
        const r = box.getBoundingClientRect();
        setWipe(((ev.clientX - r.left) / Math.max(1, r.width)) * 100);
      };
      move(e);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    view.appendChild(box);
    setWipe(node._rnWipe ?? 50);
  } else {
    const img = document.createElement("img");
    img.src = stages[a].thumb;
    img.title = `${stages[a].label} (${stages[a].w} x ${stages[a].h}, from the `
              + `${stages[a].source})`;
    view.appendChild(img);
    const tag = document.createElement("span");
    tag.className = "rn-sg-tag";
    tag.style.left = "6px";
    tag.textContent = stages[a].label;
    view.appendChild(tag);
  }
  root.appendChild(view);

  const strip = document.createElement("div");
  strip.className = "rn-sg-strip";
  stages.forEach((st, i) => {
    const th = document.createElement("div");
    th.className = "rn-sg-th" + (i === a ? " a" : "") + (node._rnCmp && i === b ? " b" : "");
    const img = document.createElement("img");
    img.src = st.thumb;
    th.appendChild(img);
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = st.label;
    th.appendChild(n);
    if (i === a || (node._rnCmp && i === b)) {
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = i === a ? "A" : "B";
      th.appendChild(k);
    }
    th.title = node._rnCmp
      ? `${st.label}. Click to set the left side, shift-click for the right.`
      : `${st.label} (${st.w} x ${st.h}). Click to view.`;
    th.onclick = (e) => {
      if (node._rnCmp && e?.shiftKey) node._rnB = i;
      else node._rnA = i;
      render(node);
    };
    strip.appendChild(th);
  });
  root.appendChild(strip);

  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], 420)]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  injectStyle();
  const wrap = document.createElement("div");
  wrap.className = "rn-sg-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                   "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  wrap.addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;                         // plain wheel scrolls the panel
    e.preventDefault();
    e.stopPropagation();
    app.canvas?.processMouseWheel?.(e);
  }, { passive: false });
  node._rnRootEl = wrap;

  const w = node.addDOMWidget("rednode_stages_ui", "rednode_stages_ui", wrap, {
    serialize: false,
    getValue: () => "",
    setValue: () => {},
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;

  // arrows step through the stages. With compare on, holding shift moves the second
  // one, so the same keys drive both sides of the wipe.
  arrowKeys(wrap, (dir) => {
    const n = stages.length;
    if (!n) return;
    const key = node._rnCmp && node._rnShift ? "_rnB" : "_rnA";
    const at = node[key] ?? 0;
    node[key] = dir === "first" ? 0
              : dir === "last" ? n - 1
              : Math.max(0, Math.min(n - 1, at + dir));
    render(node);
  });
  wrap.addEventListener("pointermove", (e) => { node._rnShift = e.shiftKey; });
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;
  render(node);
}

const viewers = new Set();

app.registerExtension({
  name: "RedNode.Stages",
  async setup() {
    injectStyle();
    // a run ending is the moment the strip is worth re-reading
    api.addEventListener?.("execution_success", async () => {
      await refreshStages();
      for (const n of viewers) render(n);
    });
    api.addEventListener?.("executed", async () => {
      await refreshStages();
      for (const n of viewers) render(n);
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    // A DANGLING TAP SAYS SO, on the node, where you are already looking.
    //
    // The tap used to be an OUTPUT node so that one hung off a wire still ran. That
    // made it drag unchosen RedNode Switch branches into the run, which is a worse
    // fault than the one it prevented, so it is an ordinary node now: it runs when
    // wired inline and not otherwise. This warning is what replaces the old
    // guarantee. Without it a dangling tap is silent dead code, which is exactly
    // the confusion OUTPUT_NODE was set to avoid in the first place.
    if (nodeData?.name === "RedNodeStageTap") {
      const onDraw = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function (ctx) {
        onDraw?.apply(this, arguments);
        if (this.flags?.collapsed) return;
        // EITHER output counts: passing the latent onward is as valid as the image
        const live = (this.outputs || []).some((o) => (o?.links || []).length);
        if (live) return;
        ctx.save();
        ctx.fillStyle = "#e0aa35";
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("wire my output onward, or I will not run",
                     this.size[0] / 2, this.size[1] + 15);
        ctx.restore();
      };
      return;
    }
    if (nodeData?.name !== "RedNodeStageView") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
      viewers.add(this);
      refreshStages().then(() => render(this));
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      build(this);
      viewers.add(this);
      refreshStages().then(() => render(this));
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      onRemoved?.apply(this, arguments);
      viewers.delete(this);
    };
  },
});
