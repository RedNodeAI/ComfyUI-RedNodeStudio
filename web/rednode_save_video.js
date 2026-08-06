import { app } from "../../scripts/app.js";

// The panel for RedNode Save Video.
//
// The node shares its filing settings with RedNode Save, so this panel speaks the same
// language: base folder, subfolder, name, numbering, drafts against keepers, and a live
// preview of the path those settings produce. What it adds is the handful of things
// that only mean something to a moving picture, and it puts those FIRST, because the
// folder rules are set once and the frame rate is set every clip.
//
// A separate file rather than a branch inside the image panel: that one is a thousand
// lines of gallery, presets and list actions this node has no use for, and hosting it
// would mean guarding every one of them. The shared part here is the vocabulary, not
// the code, and the vocabulary is small enough to be worth repeating honestly.

const NODE_NAME = "RedNodeSaveVideo";

const CONTAINERS = [
  ["mp4", "mp4", "plays everywhere, h264"],
  ["webm", "webm", "smaller at the same quality, vp9, for the web"],
  ["gif", "gif", "pasteable anywhere, 256 colours"],
  ["webp", "webp", "animation without gif's colour limit, no encoder needed"],
];
const NUMBERING = [
  ["counter", "counter", "0001, 0002, counting up in the folder"],
  ["time", "time", "the clock time, so two runs a second apart differ"],
  ["seed", "seed", "the seed, so a file names the run that made it"],
  ["none", "none", "no suffix; a clash gets one anyway rather than overwriting"],
];
const FPS_PRESETS = [8, 12, 16, 24, 30];
// what to do when the sound runs out before the picture does
const AUDIO_FILL = [
  ["once", "Play once", "the sound plays through and the rest of the clip is silent"],
  ["loop", "Repeat", "the sound repeats until the frames run out"],
];

const DEFAULTS = {
  root: "", subfolder: "%date%/%preset%", name: "%date%_%time%",
  numbering: "counter", pad: 4, split_drafts: true, keep: false,
  write_text: true, write_json: false, embed_png: true, prompts_folder: "",
  format: "png", quality: 85, compress: 4,
  container: "mp4", fps: 16.0, loop: true, pingpong: false, audio_fill: "once",
};

const SAMPLES = {
  "%date%": "2026-07-31", "%time%": "143211", "%year%": "2026", "%month%": "07",
  "%day%": "31", "%preset%": "cinematic", "%seed%": "1024", "%model%": "krea2",
  "%w%": "1024", "%h%": "576", "%size%": "1024x576",
};

const CSS = `
.rn-svv{display:flex;flex-direction:column;gap:9px;padding:10px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#e8ecf1;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-svv-box{background:#1b1e23;border:1px solid #2f333a;border-radius:6px;
  padding:9px 11px;display:flex;flex-direction:column;gap:8px}
.rn-svv-row{display:flex;align-items:center;gap:9px}
.rn-svv-row .k{flex:none;width:96px;font-size:12px;opacity:.62}
.rn-svv-row input[type=text],.rn-svv-row select{flex:1;min-width:0;background:#15171b;
  border:1px solid #33373d;border-radius:5px;color:#e8ecf1;font-size:12.5px;
  padding:6px 8px}
.rn-svv-row input[type=range]{flex:1;min-width:70px;accent-color:#b8283c;height:24px}
.rn-svv-row .v{flex:none;min-width:46px;text-align:right;font-size:12.5px;
  font-weight:700;font-variant-numeric:tabular-nums}
.rn-svv-seg{display:flex;background:#15171b;border:1px solid #33373d;border-radius:6px;
  padding:3px;gap:3px;flex:1;min-width:0}
.rn-svv-seg button{flex:1 1 auto;min-width:0;background:none;border:0;border-radius:4px;
  color:#9aa0a8;cursor:pointer;font-size:12px;padding:6px 8px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.rn-svv-seg button:hover{color:#fff}
.rn-svv-seg button.on{background:#b8283c;color:#fff;font-weight:600}
.rn-svv-pre{display:flex;background:#15171b;border:1px solid #33373d;border-radius:5px;
  padding:2px;gap:2px;flex:none}
.rn-svv-pre button{background:none;border:0;border-radius:3px;color:#9aa0a8;
  cursor:pointer;font-size:12px;padding:5px 9px;font-variant-numeric:tabular-nums}
.rn-svv-pre button.on{background:#b8283c;color:#fff;font-weight:600}
.rn-svv-tog{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#9aa0a8;
  cursor:pointer;font-size:12px;padding:6px 11px;flex:none}
.rn-svv-tog.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4;font-weight:600}
.rn-svv-path{background:#111316;border:1px solid #2a2e35;border-radius:5px;
  padding:7px 9px;font:11.5px ui-monospace,Consolas,monospace;color:#8fb4ff;
  overflow-wrap:anywhere;line-height:1.5}
.rn-svv-path .dim{opacity:.5}
.rn-svv-note{font-size:11px;opacity:.5;line-height:1.45}
`;

let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.appendChild(el);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w?.name === name);

function readCfg(node) {
  const w = findWidget(node, "config");
  let d;
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  const out = { ...DEFAULTS, ...d };
  out.fps = Math.max(0.1, Math.min(240, parseFloat(out.fps) || 16));
  out.quality = Math.max(1, Math.min(100, parseInt(out.quality) || 85));
  out.pad = Math.max(1, Math.min(8, parseInt(out.pad) || 4));
  if (!CONTAINERS.some(([id]) => id === out.container)) out.container = "mp4";
  if (!NUMBERING.some(([id]) => id === out.numbering)) out.numbering = "counter";
  return out;
}

function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnSvvCfg);
  node.graph?.change?.();
}

/** What these settings would write, right now. The tokens are the reason: nobody can
 *  read "%date%/%preset%" and picture the folder, and nobody should have to run a
 *  render to find out where it went. */
function previewPath(cfg) {
  const fill = (s) => String(s || "").replace(/%[a-z]+%/g,
    (t) => (SAMPLES[t] !== undefined ? SAMPLES[t] : t));
  const parts = [];
  if (String(cfg.root).trim()) parts.push(fill(cfg.root).replace(/^\/+|\/+$/g, ""));
  if (cfg.split_drafts) parts.push(cfg.keep ? "keepers" : "drafts");
  if (String(cfg.subfolder).trim()) {
    parts.push(fill(cfg.subfolder).replace(/^\/+|\/+$/g, ""));
  }
  let stem = fill(cfg.name) || "video";
  if (cfg.numbering === "counter") stem += "_" + "1".padStart(cfg.pad, "0");
  else if (cfg.numbering === "time") stem += "_143211";
  else if (cfg.numbering === "seed") stem += "_" + SAMPLES["%seed%"];
  return { folder: parts.filter(Boolean).join("/"), name: stem + "." + cfg.container };
}

function render(node) {
  const root = node._rnSvvEl;
  if (!root) return;
  const cfg = node._rnSvvCfg;
  root.replaceChildren();

  const box = () => {
    const b = document.createElement("div");
    b.className = "rn-svv-box";
    root.appendChild(b);
    return b;
  };
  const row = (parent, label) => {
    const r = document.createElement("div");
    r.className = "rn-svv-row";
    if (label !== null) {
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;
      r.appendChild(k);
    }
    parent.appendChild(r);
    return r;
  };
  const set = (k, v) => { cfg[k] = v; writeCfg(node); render(node); };

  // ---- the video box first: what changes every clip -------------------------
  const vid = box();
  const cRow = row(vid, "Format");
  const seg = document.createElement("div");
  seg.className = "rn-svv-seg";
  for (const [id, label, tip] of CONTAINERS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    if (cfg.container === id) b.classList.add("on");
    b.onclick = () => set("container", id);
    seg.appendChild(b);
  }
  cRow.appendChild(seg);

  const fRow = row(vid, "Frame rate");
  const fRng = document.createElement("input");
  fRng.type = "range";
  fRng.min = 1; fRng.max = 60; fRng.step = 1;
  fRng.value = Math.round(cfg.fps);
  const fVal = document.createElement("span");
  fVal.className = "v";
  fVal.textContent = `${cfg.fps % 1 ? cfg.fps.toFixed(2) : cfg.fps} fps`;
  fRng.addEventListener("input", () => {
    fVal.textContent = `${fRng.value} fps`;
  });
  fRng.addEventListener("change", () => set("fps", parseFloat(fRng.value)));
  fRow.append(fRng, fVal);
  const fPre = document.createElement("div");
  fPre.className = "rn-svv-pre";
  for (const v of FPS_PRESETS) {
    const b = document.createElement("button");
    b.textContent = String(v);
    b.title = `${v} frames per second`;
    if (Math.abs(cfg.fps - v) < 0.01) b.classList.add("on");
    b.onclick = () => set("fps", v);
    fPre.appendChild(b);
  }
  fRow.appendChild(fPre);
  // fps is a forceInput, so it is an INPUT and never a widget: guarding on a widget
  // that cannot exist meant this note never appeared, which is the whole point of it
  if (node.inputs?.some((i) => i?.name === "fps" && i.link != null)) {
    const n = document.createElement("div");
    n.className = "rn-svv-note";
    n.textContent = "An fps input is wired, and it wins over this dial, so the frame "
                  + "rate always matches whatever made the frames.";
    vid.appendChild(n);
  }

  const qRow = row(vid, "Quality");
  const qRng = document.createElement("input");
  qRng.type = "range";
  qRng.min = 1; qRng.max = 100; qRng.step = 1;
  qRng.value = cfg.quality;
  const qVal = document.createElement("span");
  qVal.className = "v";
  qVal.textContent = String(cfg.quality);
  qRng.addEventListener("input", () => { qVal.textContent = qRng.value; });
  qRng.addEventListener("change", () => set("quality", parseInt(qRng.value)));
  qRow.append(qRng, qVal);

  const oRow = row(vid, "Playback");
  const tog = (label, key, tipOn, tipOff) => {
    const b = document.createElement("button");
    b.className = "rn-svv-tog" + (cfg[key] ? " on" : "");
    b.textContent = label;
    b.title = cfg[key] ? tipOn : tipOff;
    b.onclick = () => set(key, !cfg[key]);
    oRow.appendChild(b);
    return b;
  };
  tog("Loop", "loop",
      "gif and webp loop forever. Click to play once.",
      "gif and webp play once. Click to loop forever.");
  tog("Ping pong", "pingpong",
      "the clip plays forward then back, ends not repeated, so a short loop is "
      + "seamless. Click to play forward only.",
      "the clip plays forward only. Click to play forward then back, which makes a "
      + "short loop seamless.");

  // Only when sound is actually wired, because this row answers a question nobody
  // has otherwise. Ping pong is when it stops being theoretical: it doubles the
  // picture and leaves the trip home silent.
  if (node.inputs?.some((i) => i?.name === "audio" && i.link != null)) {
    const aRow = row(vid, "Short sound");
    const aSeg = document.createElement("div");
    aSeg.className = "rn-svv-seg";
    for (const [id, label, tip] of AUDIO_FILL) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = tip;
      if ((cfg.audio_fill || "once") === id) b.classList.add("on");
      b.onclick = () => set("audio_fill", id);
      aSeg.appendChild(b);
    }
    aRow.appendChild(aSeg);
    if (cfg.pingpong && (cfg.audio_fill || "once") === "once") {
      const n = document.createElement("div");
      n.className = "rn-svv-note";
      n.textContent = "Ping pong makes the clip twice as long as the frames, so the "
                    + "sound plays through the way out and the way back is silent. "
                    + "Repeat fills it.";
      vid.appendChild(n);
    }
  }

  // ---- the filing box: the same vocabulary RedNode Save uses ----------------
  const file = box();
  const textRow = (label, key, tip) => {
    const r = row(file, label);
    const i = document.createElement("input");
    i.type = "text";
    i.value = cfg[key] ?? "";
    i.title = tip;
    i.onchange = () => set(key, i.value);
    r.appendChild(i);
    return i;
  };
  textRow("Base folder", "root",
          "under ComfyUI's output folder. Empty means the output folder itself.");
  textRow("Subfolder", "subfolder",
          "tokens allowed: %date% %time% %preset% %seed% %model% %size%. "
          + "Slashes make nested folders.");
  textRow("Name", "name", "the file name before the numbering. Same tokens.");

  const nRow = row(file, "Numbering");
  const nSeg = document.createElement("div");
  nSeg.className = "rn-svv-seg";
  for (const [id, label, tip] of NUMBERING) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    if (cfg.numbering === id) b.classList.add("on");
    b.onclick = () => set("numbering", id);
    nSeg.appendChild(b);
  }
  nRow.appendChild(nSeg);

  const kRow = row(file, "Filing");
  const kb = document.createElement("button");
  kb.className = "rn-svv-tog" + (cfg.keep ? " on" : "");
  kb.textContent = cfg.keep ? "Keeper" : "Draft";
  kb.title = cfg.keep
    ? "Files into the keepers tree. Click to file as a draft."
    : "Files into the drafts tree, which is where work in progress belongs. "
      + "Click to file as a keeper.";
  kb.onclick = () => set("keep", !cfg.keep);
  const sb = document.createElement("button");
  sb.className = "rn-svv-tog" + (cfg.split_drafts ? " on" : "");
  sb.textContent = "Split drafts";
  sb.title = cfg.split_drafts
    ? "Drafts and keepers go in separate folders. Click to put them together."
    : "Everything goes in one folder. Click to keep drafts apart from keepers.";
  sb.onclick = () => set("split_drafts", !cfg.split_drafts);
  const tb = document.createElement("button");
  tb.className = "rn-svv-tog" + (cfg.write_text ? " on" : "");
  tb.textContent = "Text record";
  tb.title = cfg.write_text
    ? "A readable .txt of the prompts and settings is written beside the video. "
      + "Click to stop writing it."
    : "No text record is written. Click to write one beside each video, which is "
      + "the only copy a video file can carry.";
  tb.onclick = () => set("write_text", !cfg.write_text);
  kRow.append(kb, sb, tb);

  // ---- where it lands, spelled out -----------------------------------------
  const p = previewPath(cfg);
  const path = document.createElement("div");
  path.className = "rn-svv-path";
  const dim = document.createElement("span");
  dim.className = "dim";
  dim.textContent = "output/";
  path.append(dim, document.createTextNode(
    (p.folder ? p.folder + "/" : "") + p.name));
  file.appendChild(path);
}

function build(node) {
  if (!node.addDOMWidget || node._rnSvvEl) return;
  injectStyle();
  const w = findWidget(node, "config");
  if (w) {
    // the raw JSON stays as the source of truth and stops being something to look at
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
  }
  const wrap = document.createElement("div");
  wrap.className = "rn-svv";
  node._rnSvvEl = wrap;
  node._rnSvvCfg = readCfg(node);
  node.addDOMWidget("rednode_save_video_ui", "rednode_save_video_ui", wrap, {
    serialize: false, getValue: () => "", setValue: () => {},
    getMinHeight: () => 300,
  });
  node.size = [Math.max(node.size?.[0] || 0, 420),
               Math.max(node.size?.[1] || 0, 420)];
  render(node);
}

app.registerExtension({
  name: "RedNode.SaveVideo",
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
      // the saved config arrives AFTER creation, so the panel is rebuilt from it
      setTimeout(() => {
        if (!this._rnSvvEl) build(this);
        else { this._rnSvvCfg = readCfg(this); render(this); }
      }, 0);
      return r;
    };
    // a wired fps changes what the panel should say, and connections are not renders
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      if (this._rnSvvEl) render(this);
      return r;
    };
  },
});
