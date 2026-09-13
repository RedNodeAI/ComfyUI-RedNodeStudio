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
.rn-vr-rate{display:flex;align-items:center;gap:8px;flex:none}
.rn-vr-rate .k{flex:none;font-size:12px;opacity:.62}
.rn-vr-rate input[type=range]{flex:1;min-width:70px;accent-color:#b8283c;height:24px}
.rn-vr-rate .v{flex:none;min-width:46px;text-align:right;font-size:12.5px;
  font-weight:700;font-variant-numeric:tabular-nums}
.rn-vr-pre{display:flex;background:#15171b;border:1px solid #33373d;border-radius:5px;
  padding:2px;gap:2px;flex:none}
.rn-vr-pre button{background:none;border:0;border-radius:3px;color:#9aa0a8;
  cursor:pointer;font-size:12px;padding:5px 9px;font-variant-numeric:tabular-nums}
.rn-vr-pre button.on{background:#b8283c;color:#fff;font-weight:600}
.rn-vr-wired{font-size:11px;opacity:.5;line-height:1.45;flex:none}
`;

// The same dial as RedNode Save Video's Frame rate, down to the preset list, because
// the two nodes sit beside each other and a rate set on one should read the same way
// on the other.
const FPS_PRESETS = [8, 12, 16, 24, 30];
const DEFAULTS = { fps: 16.0 };

const findWidget = (n, name) => (n.widgets || []).find((w) => w?.name === name);
const clampFps = (v) => Math.max(0.1, Math.min(240, parseFloat(v) || 16));

function readCfg(node) {
  let d;
  try { d = JSON.parse(findWidget(node, "config")?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  return { ...DEFAULTS, ...d, fps: clampFps(d.fps ?? DEFAULTS.fps) };
}

function writeCfg(node, cfg) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(cfg);
  node.graph?.setDirtyCanvas?.(true, false);
}

// A workflow saved before this panel existed holds [fps, loop] in its widget values,
// and the widgets are [loop, config] now, so both land one slot to the left: a loop
// widget holding a frame rate is the tell. Carry them across rather than losing a rate
// somebody set and leaving loop reading 16.
function carryLegacy(node) {
  const loopW = findWidget(node, "loop");
  const cfgW = findWidget(node, "config");
  if (!loopW || !cfgW || typeof loopW.value !== "number") return;
  const fps = clampFps(loopW.value);
  loopW.value = cfgW.value !== false && String(cfgW.value) !== "false";
  cfgW.value = JSON.stringify({ ...DEFAULTS, fps });
}

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

// The Frame rate row, the same control RedNode Save Video carries: a dial, the value,
// and the presets that cover nearly every clip. Built above the empty state as well,
// because the rate is chosen before the first run, not after it.
function rateRow(node) {
  const cfg = readCfg(node);
  const row = document.createElement("div");
  row.className = "rn-vr-rate";
  // the canvas reads drag and wheel globally, so a slider inside a node has to keep
  // its own gestures or setting the rate pans the graph instead
  for (const t of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    row.addEventListener(t, (e) => e.stopPropagation());
  }

  const k = document.createElement("span");
  k.className = "k";
  k.textContent = "Frame rate";
  row.appendChild(k);

  // fps is a forceInput, so it is an INPUT and never a widget: guarding on a widget
  // that cannot exist is what made this note never appear on Save Video
  if ((node.inputs || []).some((i) => i?.name === "fps" && i.link != null)) {
    const n = document.createElement("span");
    n.className = "rn-vr-wired";
    n.textContent = "An fps input is wired, and it wins over this dial, so the preview "
                  + "always matches whatever made the frames.";
    row.appendChild(n);
    return row;
  }

  const rng = document.createElement("input");
  rng.type = "range";
  rng.min = 1; rng.max = 60; rng.step = 1;
  rng.value = Math.round(cfg.fps);
  const val = document.createElement("span");
  val.className = "v";
  val.textContent = `${cfg.fps % 1 ? cfg.fps.toFixed(2) : cfg.fps} fps`;
  rng.addEventListener("input", () => { val.textContent = `${rng.value} fps`; });
  rng.addEventListener("change", () => {
    writeCfg(node, { ...cfg, fps: parseFloat(rng.value) });
    render(node);
  });
  row.append(rng, val);

  const pre = document.createElement("div");
  pre.className = "rn-vr-pre";
  for (const v of FPS_PRESETS) {
    const b = document.createElement("button");
    b.textContent = String(v);
    b.title = `${v} frames per second`;
    if (Math.abs(cfg.fps - v) < 0.01) b.classList.add("on");
    b.onclick = () => { writeCfg(node, { ...cfg, fps: v }); render(node); };
    pre.appendChild(b);
  }
  row.appendChild(pre);
  return row;
}

function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden config widget's tooltip. Strip those
  // dots on every render; the widget itself, and its serialisation, is untouched. The
  // real fps socket has no .widget and is left exactly where it is.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "config") node.inputs.splice(i, 1);
  }
  const root = node._rnVrEl;
  if (!root) return;
  const list = node._rnVrRuns || [];
  const shown = list[node._rnVrPick || 0];
  root.replaceChildren();

  const stage = document.createElement("div");
  stage.className = "rn-vr-stage";
  root.appendChild(stage);
  root.appendChild(rateRow(node));

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
    // The BUTTON owns this, not the clip. Reading it off shown.audio meant a rebuilt
    // player came back at whatever the track implied and threw the choice away, which
    // is why Sound looked dead: the label flipped, the element did not. It also left a
    // clip WITH audio unmuted under autoplay, which browsers block outright.
    v.muted = node._rnVrMuted !== false;
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
    // Both of these flip a property on the player that is ALREADY on screen, so
    // neither re-renders: a rebuild reloads the src and drops you back at 0:00,
    // which on a loop toggle reads as the button having done something violent and
    // on a sound toggle as it having done nothing at all.
    const relabel = (b, text, on) => {
      b.textContent = text;
      b.classList[on ? "add" : "remove"]("on");
    };
    const loop = mk(shown.loop === false ? "Loop off" : "Loop",
       "whether the player repeats. A short clip is easier to judge looping.",
       () => {
         shown.loop = shown.loop === false;   // stays on the clip, so the strip agrees
         if (node._rnVrVideo) node._rnVrVideo.loop = shown.loop;
         relabel(loop, shown.loop === false ? "Loop off" : "Loop", shown.loop !== false);
       }, shown.loop !== false);
    if (shown.audio) {
      const sound = mk(node._rnVrMuted !== false ? "Muted" : "Sound",
         "browsers block autoplay with sound, so a clip starts muted and this "
         + "turns it on.",
         () => {
           node._rnVrMuted = node._rnVrMuted === false;
           if (node._rnVrVideo) node._rnVrVideo.muted = node._rnVrMuted;
           relabel(sound, node._rnVrMuted ? "Muted" : "Sound", !node._rnVrMuted);
         }, node._rnVrMuted === false);
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
  carryLegacy(node);
  // the panel's own record, edited through the dial and never by hand
  const cw = findWidget(node, "config");
  if (cw) {
    cw.type = "hidden";
    cw.hidden = true;
    cw.computeSize = () => [0, -4];
    if (cw.element) cw.element.style.display = "none";
    if (cw.inputEl) cw.inputEl.style.display = "none";
  }
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
      // saved widget values land after onNodeCreated, so the legacy carry only has
      // something to look at here
      setTimeout(() => {
        if (!this._rnVrEl) build(this);
        carryLegacy(this);
        render(this);
      }, 0);
      return r;
    };
    // a wired fps changes what the row should say, and connections are not renders
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      if (this._rnVrEl) render(this);
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
