import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// The player for RedNode Video Review.
//
// ComfyUI's preview channel carries images, so a video cannot ride it: the node sends
// its own payload and this turns it into a real video element, with the browser's own
// controls rather than a scrubber of our own. Reimplementing play, pause and seek is a
// week of work to arrive back where the browser already was.
//
// It REMEMBERS, which is the whole point of the name. The last few runs sit in a strip
// under the player, newest first, so a change is judged against the take before it
// instead of a memory of it. Session state only: these clips live in ComfyUI's temp
// folder, which it clears on its own, so a strip restored tomorrow would be a row of
// dead links.

const NODE_NAME = "RedNodeVideoReview";
const KEEP = 6;
// what goes in a <video> element. gif and animated webp are images to a browser: they
// play themselves and have no transport, so they get an <img> and no dead controls.
const PLAYABLE = new Set(["mp4", "webm"]);

const CSS = `
.rn-vr{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:12px system-ui,sans-serif;color:#e8ecf1;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:hidden}
.rn-vr-stage{flex:1 1 auto;min-height:0;position:relative;background:#0d0f12;
  border:1px solid #2a2e35;border-radius:6px;display:flex;align-items:center;
  justify-content:center;overflow:hidden}
.rn-vr-stage video,.rn-vr-stage img{max-width:100%;max-height:100%;display:block}
.rn-vr-empty{font-size:12px;opacity:.45;text-align:center;padding:0 14px;line-height:1.5}
.rn-vr-bar{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap}
.rn-vr-btn{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  cursor:pointer;font-size:11.5px;padding:5px 10px}
.rn-vr-btn:hover{border-color:#b8283c;color:#fff}
.rn-vr-btn.on{background:#2a1116;border-color:#b8283c;color:#fff;font-weight:600}
.rn-vr-note{font-size:11px;opacity:.5;margin-left:auto;font-variant-numeric:tabular-nums}
.rn-vr-strip{display:flex;gap:4px;flex:none;overflow-x:auto;padding-bottom:2px}
.rn-vr-strip button{flex:none;width:58px;height:36px;border-radius:4px;
  border:1px solid #2b3038;background:#20242b;color:#8b929c;cursor:pointer;
  font-size:10px;font-variant-numeric:tabular-nums}
.rn-vr-strip button:hover{border-color:#4a5060;color:#ddd}
.rn-vr-strip button.on{border-color:#b8283c;color:#fff}
`;

let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.appendChild(el);
  styled = true;
}

const viewUrl = (v) => api.apiURL(
  `/view?filename=${encodeURIComponent(v.filename)}`
  + `&type=${v.type || "temp"}&subfolder=${encodeURIComponent(v.subfolder || "")}`
  + `&rand=${v.rand || 0}`);

function render(node) {
  const root = node._rnVrEl;
  if (!root) return;
  const list = node._rnVrRuns || [];
  const shown = list[node._rnVrPick || 0];
  root.replaceChildren();

  const stage = document.createElement("div");
  stage.className = "rn-vr-stage";
  root.appendChild(stage);

  if (!shown) {
    const e = document.createElement("div");
    e.className = "rn-vr-empty";
    e.textContent = "Queue a run and the clip plays here.";
    stage.appendChild(e);
    return;
  }

  if (PLAYABLE.has(shown.format)) {
    const v = document.createElement("video");
    v.src = viewUrl(shown);
    v.controls = true;
    v.autoplay = true;
    v.loop = shown.loop !== false;
    v.muted = !shown.audio;          // browsers block autoplay WITH sound
    v.playsInline = true;
    // the canvas reads wheel and drag globally, so a player inside a node has to
    // keep its own gestures or scrubbing pans the graph instead
    for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick"]) {
      v.addEventListener(t, (e) => e.stopPropagation());
    }
    node._rnVrVideo = v;
    stage.appendChild(v);
  } else {
    // an animated webp is an image to the browser: it plays itself and has no
    // controls, which is honest for a fallback rather than fake ones that do nothing
    const im = document.createElement("img");
    im.src = viewUrl(shown);
    stage.appendChild(im);
  }

  const bar = document.createElement("div");
  bar.className = "rn-vr-bar";
  root.appendChild(bar);

  const mk = (label, title, fn, on) => {
    const b = document.createElement("button");
    b.className = "rn-vr-btn" + (on ? " on" : "");
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };
  if (PLAYABLE.has(shown.format)) {
    mk(shown.loop === false ? "Loop off" : "Loop",
       "whether the player repeats. A short clip is easier to judge looping.",
       () => {
         shown.loop = shown.loop === false;
         if (node._rnVrVideo) node._rnVrVideo.loop = shown.loop;
         render(node);
       }, shown.loop !== false);
    if (shown.audio) {
      mk(node._rnVrMuted ? "Muted" : "Sound",
         "browsers block autoplay with sound, so a clip starts muted and this "
         + "turns it on.",
         () => {
           node._rnVrMuted = !node._rnVrMuted;
           if (node._rnVrVideo) node._rnVrVideo.muted = node._rnVrMuted;
           render(node);
         }, !node._rnVrMuted);
    }
  }
  mk("Open", "open the clip in a new tab, at full size",
     () => window.open(viewUrl(shown), "_blank"));

  const note = document.createElement("span");
  note.className = "rn-vr-note";
  // A clip encoded from frames knows its own count and rate. One played from a filed
  // path knows neither without a full decode, so the node sends the duration instead
  // and the note says what it actually has rather than "? frames ? fps".
  const secs = shown.frames && shown.fps ? shown.frames / shown.fps : (shown.seconds || 0);
  note.textContent = (shown.frames && shown.fps
      ? `${shown.frames} frames  ${shown.fps} fps  ` : "")
    + (secs ? `${secs.toFixed(2)}s` : "")
    + (shown.type === "output" ? "  filed" : "");
  bar.appendChild(note);

  if (list.length > 1) {
    const strip = document.createElement("div");
    strip.className = "rn-vr-strip";
    list.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = i === (node._rnVrPick || 0) ? "on" : "";
      b.textContent = i === 0 ? "now" : `-${i}`;
      b.title = i === 0 ? "the newest run" : `${i} run(s) ago`;
      b.onclick = () => { node._rnVrPick = i; render(node); };
      strip.appendChild(b);
    });
    root.appendChild(strip);
  }
}

function build(node) {
  if (!node.addDOMWidget || node._rnVrEl) return;
  injectStyle();
  const wrap = document.createElement("div");
  wrap.className = "rn-vr";
  node._rnVrEl = wrap;
  node._rnVrRuns = node._rnVrRuns || [];
  node._rnVrPick = 0;
  node._rnVrMuted = true;
  node.addDOMWidget("rednode_video_review_ui", "rednode_video_review_ui", wrap, {
    serialize: false, getValue: () => "", setValue: () => {},
    getMinHeight: () => 240,
  });
  node.size = [Math.max(node.size?.[0] || 0, 360),
               Math.max(node.size?.[1] || 0, 320)];
  render(node);
}

app.registerExtension({
  name: "RedNode.VideoReview",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      build(this);
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => { if (!this._rnVrEl) build(this); }, 0);
      return r;
    };
  },
  async setup() {
    api.addEventListener?.("executed", (e) => {
      const vids = e?.detail?.output?.rn_videos;
      if (!Array.isArray(vids) || !vids.length) return;
      const id = String(e.detail.node ?? "");
      const node = app.graph?.getNodeById?.(id)
                || (app.graph?._nodes || []).find((n) => String(n.id) === id);
      if (!node || node.type !== NODE_NAME) return;
      // rand busts the browser cache: temp names repeat within a session and a
      // cached first clip playing forever is the bug this line exists to prevent
      const v = { ...vids[vids.length - 1], rand: (Math.random() * 1e9) | 0 };
      node._rnVrRuns = [v, ...(node._rnVrRuns || [])].slice(0, KEEP);
      node._rnVrPick = 0;                      // a new run always takes the stage
      if (!node._rnVrEl) build(node);
      render(node);
    });
  },
});
