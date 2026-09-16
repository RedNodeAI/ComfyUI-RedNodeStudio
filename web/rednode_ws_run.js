import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { writeCfg, render, setupProblems } from "./rednode_workspace.js";

// The Run tab: queue the workflow and watch it go.
//
// The server tells the story through `rednode.run_stage` events (run_events.py):
// a run starting, each stage starting and ending, memory samples, and lines for the
// log. The picture forming and the step count come from the Live Preview stream and
// ComfyUI's own progress events. The page holds ONE run at a time, the way ComfyUI
// executes one prompt at a time, and every open Run tab reads it. The tab is built
// once per render and then patched in place, so a frame thirty times a run never
// rebuilds the panel.

const RUN = {
  count: 0,            // runs watched on this page
  status: "idle",      // idle, running, done, error, stopped
  t0: 0,               // when this run began (ms)
  t1: 0,               // when it ended
  node: null,          // the Workspace node the server says it belongs to
  seed: null,
  rig: "",
  stages: new Map(),   // key -> {label, state, secs, info, step, total, why}
  running: "",         // the stage steps belong to
  log: [],             // {t, level, text}
  vram: [],            // {t, used, total}
  marks: [],           // {t, level}
  models: [],          // on the card now
  total: 0,            // the card's size, MB
  frame: null,         // {src, label, step, total}
  cached: false,       // the Workspace node was not run: its stages are last run's
};
const LOG_MAX = 200;
const VRAM_MAX = 900;
const views = new Set();

const secs = () => (RUN.t0 ? (((RUN.t1 || Date.now()) - RUN.t0) / 1000) : 0);
const clock = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function logLine(text, level = "info", t = secs()) {
  RUN.log.push({ t, level, text });
  if (RUN.log.length > LOG_MAX) RUN.log.splice(0, RUN.log.length - LOG_MAX);
  if (level === "load" || level === "unload") RUN.marks.push({ t, level });
}

function resetRun() {
  RUN.count += 1;
  RUN.status = "running";
  RUN.t0 = Date.now();
  RUN.t1 = 0;
  RUN.node = null;
  RUN.seed = null;
  RUN.rig = "";
  RUN.stages = new Map();
  RUN.running = "";
  RUN.log = [];
  RUN.vram = [];
  RUN.marks = [];
  RUN.frame = null;
  RUN.cached = false;
  logLine("Run started");
}

function finishRun(status, why = "") {
  if (RUN.status !== "running") return;
  RUN.status = status;
  RUN.t1 = Date.now();
  for (const [, s] of RUN.stages) {
    if (s.state === "start" || s.state === "progress") {
      s.state = status === "done" ? "done" : "error";
    }
  }
  RUN.running = "";
  logLine(status === "done" ? `Finished in ${clock(secs())}`
          : status === "stopped" ? "Stopped" : `Failed${why ? `: ${why}` : ""}`,
          status === "done" ? "done" : "warn");
}

// ---- the feed ----------------------------------------------------------------
let _refreshQueued = false;
function refreshAll() {
  if (_refreshQueued) return;
  _refreshQueued = true;
  const go = () => {
    _refreshQueued = false;
    for (const v of [...views]) {
      // a tab switched away from, or rebuilt since, is not fed any more
      if (v.node._rnTab !== "run" || v.gen !== v.node._rnRunGen) { views.delete(v); continue; }
      try { refresh(v); } catch (e) { console.warn("[RedNode Run] refresh failed:", e); }
    }
  };
  (globalThis.requestAnimationFrame || ((f) => setTimeout(f, 16)))(go);
}

export function onRunEvent(d) {
  if (!d || typeof d !== "object") return;
  if (d.kind === "start") {
    if (RUN.status !== "running") resetRun();
    RUN.node = d.node;
    if (d.info?.draft) logLine("Draft is on: the Detailer and Post FX pass the picture through");
  } else if (d.kind === "info") {
    if (d.info?.seed != null) RUN.seed = d.info.seed;
    if (d.info?.rig) RUN.rig = d.info.rig;
  } else if (d.kind === "stage") {
    const s = RUN.stages.get(d.key) || { label: d.label };
    if (d.label && d.label !== d.key) s.label = d.label;
    s.info = { ...(s.info || {}), ...(d.info || {}) };
    if (d.state === "progress") {
      s.state = "progress";
      RUN.running = d.key;
    } else {
      s.state = d.state;
      if (d.state === "start") {
        s.step = 0;
        s.total = Number(d.info?.steps) || 0;
        RUN.running = d.key;
        const i = d.info || {};
        const bits = [
          i.size ? `${i.size[0]} x ${i.size[1]}` : "",
          i.steps ? `${i.steps} steps` : "",
          i.denoise != null && d.key.startsWith("pass") ? `denoise ${Number(i.denoise).toFixed(2)}` : "",
          i.rig ? `on ${i.rig}` : "",
        ].filter(Boolean);
        logLine(`${s.label || d.key} started${bits.length ? ` · ${bits.join(", ")}` : ""}`,
                "info", d.t ?? secs());
      } else {
        if (d.secs != null) s.secs = d.secs;
        if (RUN.running === d.key) RUN.running = "";
        if (d.state === "done") {
          logLine(`${s.label || d.key} done in ${Number(d.secs || 0).toFixed(1)} s`, "done", d.t ?? secs());
        } else if (d.state === "skip") {
          s.why = d.info?.why || "";
          logLine(`${s.label || d.key} skipped${s.why ? `: ${s.why}` : ""}`, "skip", d.t ?? secs());
        } else if (d.state === "error") {
          logLine(`${s.label || d.key} failed${d.info?.error ? `: ${d.info.error}` : ""}`,
                  "warn", d.t ?? secs());
        }
      }
    }
    RUN.stages.set(d.key, s);
  } else if (d.kind === "note") {
    logLine(d.text, d.level || "info", d.t ?? secs());
  } else if (d.kind === "vram") {
    const v = d.vram || {};
    if (v.total) {
      RUN.total = v.total;
      if (RUN.status === "running") {
        RUN.vram.push({ t: d.t ?? secs(), used: v.used });
        if (RUN.vram.length > VRAM_MAX) RUN.vram.splice(0, RUN.vram.length - VRAM_MAX);
      }
    }
    if (Array.isArray(d.models)) RUN.models = d.models;
  }
  refreshAll();
}

function onFrame(d) {
  if (!d?.data || RUN.status !== "running") return;
  RUN.frame = { src: d.data, label: d.label || "", step: Number(d.step) || 0,
                total: Number(d.total) || 0 };
  const s = RUN.stages.get(RUN.running);
  if (s) { s.step = RUN.frame.step; s.total = RUN.frame.total || s.total; }
  refreshAll();
}

function onProgress(d) {
  if (RUN.status !== "running" || !d) return;
  const s = RUN.stages.get(RUN.running);
  if (!s) return;
  s.step = Number(d.value) || 0;
  s.total = Number(d.max) || s.total;
  refreshAll();
}

let _listening = false;
export function listenRun() {
  if (_listening || !api?.addEventListener) return;
  _listening = true;
  api.addEventListener("rednode.run_stage", (e) => onRunEvent(e?.detail));
  api.addEventListener("rednode-live-frame", (e) => onFrame(e?.detail));
  api.addEventListener("progress", (e) => onProgress(e?.detail));
  api.addEventListener("execution_start", () => { resetRun(); refreshAll(); });
  api.addEventListener("execution_cached", (e) => {
    const ids = (e?.detail?.nodes || []).map(String);
    const ws = (app.graph?._nodes || []).filter((n) => n.type === "RedNodeStudioWorkspace")
      .map((n) => String(n.id));
    if (ws.some((id) => ids.includes(id))) {
      RUN.cached = true;
      logLine("The Workspace is unchanged, so its render is reused from the last run");
      refreshAll();
    }
  });
  api.addEventListener("execution_success", () => { finishRun("done"); refreshAll(); });
  api.addEventListener("execution_error", (e) => {
    finishRun("error", String(e?.detail?.exception_message || "").slice(0, 160));
    refreshAll();
  });
  api.addEventListener("execution_interrupted", () => { finishRun("stopped"); refreshAll(); });
  setInterval(() => { if (RUN.status === "running" && views.size) refreshAll(); }, 1000);
}

// ---- what this workflow will run -------------------------------------------------
const PASS_LABEL = (i, latent) => `Pass ${i} · ${i > 1 ? "Refine" : latent ? "Generate" : "Img2Img"}`;

export function plannedStages(node, cfg) {
  const out = [];
  const tabs = cfg.tabs || {};
  const captions = Object.values(tabs).some((t) => t?.on && t.auto?.on
    && (t.images?.length || 0) > 0);
  if (captions) out.push(["captions", "Captions"]);
  const internal = cfg.models?.sampler_mode === "internal";
  if (internal) {
    out.push(["encode", "Encode"]);
    const I = tabs.i2i || {};
    const i2iRun = I.on && !I.prompt_only && ((I.images?.length || 0) > 0 || I.canvas !== "gallery");
    const n = Math.max(1, Math.round(Number(i2iRun ? I.passes : cfg.latent?.passes) || 1));
    for (let i = 1; i <= n; i++) out.push([`pass${i}`, PASS_LABEL(i, !i2iRun)]);
    out.push(["decode", "Decode"]);
  }
  const types = new Set((node.graph?._nodes || app.graph?._nodes || [])
    .filter((n) => n.mode !== 2 && n.mode !== 4).map((n) => n.type));
  if (types.has("RedNodeStudioDetailer")) out.push(["detailer", "Detailer"]);
  if (types.has("RedNodePostProcess")) out.push(["post", "Post FX"]);
  if (types.has("RedNodeSave")) out.push(["save", "Save"]);
  return out;
}

// ---- the tab ---------------------------------------------------------------------
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function queueWorkflow(btn) {
  btn.disabled = true;
  try {
    const cmd = app.extensionManager?.command;
    if (cmd?.execute) await cmd.execute("Comfy.QueuePrompt");
    else if (typeof app.queuePrompt === "function") await app.queuePrompt(0, 1);
    else throw new Error("this ComfyUI has no queue command the tab can use");
  } catch (e) {
    alert(`Could not queue: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

export function runTabBody(node, body) {
  listenRun();
  const cfg = node._rnCfg;
  const root = el("div", "rn-run");
  node._rnRunGen = (node._rnRunGen || 0) + 1;
  const view = { node, root, refs: {}, gen: node._rnRunGen };

  // TOP ROW: Generate, Full or Draft, the VRAM limit; the run's facts on the right
  const top = el("div", "rn-ws-card rn-run-top");
  const gen = el("button", "rn-run-go", "Generate");
  gen.title = "Queue the whole workflow, the same as ComfyUI's Queue button.";
  gen.onclick = () => queueWorkflow(gen);
  const mode = el("div", "rn-ws-seg rn-ws-switch rn-run-mode");
  mode.dataset.choice = "draft";
  for (const [v, label, tip] of [
    [false, "Full", "The whole chain: the render, the Detailer passes and Post FX."],
    [true, "Draft", "The base render alone: the Detailer and Post FX pass the picture "
                    + "through, so a seed is cheap to judge."],
  ]) {
    const b = el("button", "rn-ws-segb" + (!!cfg.draft === v ? " on" : ""), label);
    b.title = tip;
    b.onclick = () => { if (!!cfg.draft !== v) { cfg.draft = v; writeCfg(node); render(node); } };
    mode.appendChild(b);
  }
  const tierWrap = el("label", "rn-run-tier");
  tierWrap.appendChild(el("span", "rn-ws-note", "VRAM limit"));
  const tier = el("select", "rn-ws-res");
  tier.dataset.choice = "vram_tier";
  for (const [v, label] of [["high", "Free range"], ["medium", "Medium"], ["low", "Low"]]) {
    const o = el("option", "", label);
    o.value = v;
    o.selected = (cfg.vram_tier || "high") === v;
    tier.appendChild(o);
  }
  tier.title = "How much VRAM this workspace may spend. Medium and Low hold the "
             + "expensive dials to what that card can take; Free range lifts every "
             + "ceiling. Anything held back is named in the log and the console.";
  tier.onchange = () => { cfg.vram_tier = tier.value; writeCfg(node); render(node); };
  tierWrap.appendChild(tier);
  const facts = el("div", "rn-run-facts");
  view.refs.facts = facts;
  top.append(gen, mode, tierWrap, facts);
  root.appendChild(top);
  const probs = setupProblems(node, cfg) || [];
  if (probs.length) {
    const pc = el("div", "rn-ws-card rn-ws-note rn-ws-peoplewarn rn-run-probs");
    pc.textContent = probs.join(" ");
    root.appendChild(pc);
  }

  // PIPELINE
  const pipe = el("div", "rn-ws-card rn-run-pipe");
  pipe.appendChild(el("div", "ch", "PIPELINE"));
  const boxes = el("div", "rn-run-boxes");
  pipe.appendChild(boxes);
  view.refs.boxes = boxes;
  root.appendChild(pipe);

  // PICTURE and MEMORY side by side
  const cols = el("div", "rn-run-cols");
  const pic = el("div", "rn-ws-card rn-run-pic");
  pic.appendChild(el("div", "ch", "LIVE PICTURE"));
  const img = el("img", "rn-run-img");
  img.alt = "";
  const picEmpty = el("div", "rn-ws-note rn-run-picempty", "The picture appears here while it renders.");
  const picLabel = el("div", "rn-run-piclabel");
  pic.append(img, picEmpty, picLabel);
  view.refs.img = img;
  view.refs.picEmpty = picEmpty;
  view.refs.picLabel = picLabel;
  const mem = el("div", "rn-ws-card rn-run-mem");
  mem.appendChild(el("div", "ch", "VRAM"));
  const chart = el("canvas", "rn-run-chart");
  chart.height = 180;
  const memLine = el("div", "rn-ws-note rn-run-memline");
  const legend = el("div", "rn-run-legend");
  for (const [cls, text] of [["use", "In use"], ["load", "Model loaded"],
                             ["unload", "Model unloaded"], ["cap", "Card size"],
                             ["tgt", "VRAM limit"]]) {
    const k = el("span", "k " + cls);
    k.appendChild(el("i"));
    k.appendChild(document.createTextNode(text));
    legend.appendChild(k);
  }
  const onCard = el("div", "rn-run-oncard");
  mem.append(chart, memLine, legend, el("div", "rn-run-sub", "ON THE CARD NOW"), onCard);
  view.refs.chart = chart;
  view.refs.memLine = memLine;
  view.refs.onCard = onCard;
  cols.append(pic, mem);
  root.appendChild(cols);

  // WHAT'S HAPPENING
  const logCard = el("div", "rn-ws-card rn-run-logcard");
  logCard.appendChild(el("div", "ch", "WHAT'S HAPPENING"));
  const log = el("div", "rn-run-log");
  logCard.appendChild(log);
  view.refs.log = log;
  root.appendChild(logCard);

  body.appendChild(root);
  // one view per node: a re-render replaces the last one
  for (const v of [...views]) if (v.node === node) views.delete(v);
  views.add(view);
  refresh(view);
}

const STATE_TEXT = { waiting: "Waiting", start: "Running", progress: "Running", done: "Done",
                     skip: "Skipped", error: "Failed", notrun: "Not run", cached: "Reused" };

function stageRows(node) {
  const cfg = node._rnCfg;
  const plan = plannedStages(node, cfg);
  const rows = plan.map(([key, label]) => ({ key, label }));
  // stages the server reported that the plan did not foresee
  for (const [key, s] of RUN.stages) {
    if (!rows.some((r) => r.key === key)) {
      const at = key.startsWith("pass") ? rows.findIndex((r) => r.key === "decode") : -1;
      const row = { key, label: s.label || key };
      if (at >= 0) rows.splice(at, 0, row); else rows.push(row);
    }
  }
  const wsKeys = new Set(["captions", "encode", "decode"]);
  return rows.map((r) => {
    const s = RUN.stages.get(r.key);
    let state = s?.state || "waiting";
    if (!s && RUN.cached && (wsKeys.has(r.key) || r.key.startsWith("pass"))) state = "cached";
    else if (!s && RUN.status !== "running" && RUN.status !== "idle") state = "notrun";
    else if (!s && cfg.draft && (r.key === "detailer" || r.key === "post")) state = "skip";
    return { ...r, s, state };
  });
}

function refresh(view) {
  const { node, refs } = view;
  // facts
  const f = refs.facts;
  f.replaceChildren();
  const chip = (text, cls = "") => f.appendChild(el("span", "rn-ws-chip " + cls, text));
  chip(RUN.count ? `Run ${RUN.count}` : "No run yet");
  if (RUN.seed != null) chip(`Seed ${RUN.seed}`);
  chip(RUN.status === "running" ? `Running ${clock(secs())}`
       : RUN.status === "done" ? `Done in ${clock(secs())}`
       : RUN.status === "error" ? "Failed" : RUN.status === "stopped" ? "Stopped" : "Idle",
       "rn-run-status " + RUN.status);

  // pipeline
  refs.boxes.replaceChildren();
  for (const r of stageRows(node)) {
    const b = el("div", `rn-run-box ${r.state}`);
    b.dataset.stage = r.key;
    b.appendChild(el("div", "t", r.s?.label || r.label));
    const st = el("div", "st");
    let text = STATE_TEXT[r.state] || r.state;
    if (r.state === "done" && r.s?.secs != null) text = `Done · ${Number(r.s.secs).toFixed(1)} s`;
    if (r.state === "skip" && (r.s?.why || (!r.s && node._rnCfg.draft))) {
      text = `Skipped · ${r.s?.why || "Draft is on"}`;
    }
    if (r.state === "start" || r.state === "progress") {
      const i = r.s?.info || {};
      if (r.s?.total) text = `Step ${r.s.step || 0} of ${r.s.total}`;
      else if (i.of) text = `Pass ${i.current} of ${i.of}${i.what ? ` · ${i.what}` : ""}`;
      const bar = el("div", "bar");
      const fill = el("i");
      const frac = r.s?.total ? (r.s.step || 0) / r.s.total : (i.of ? (i.current - 1) / i.of : 0);
      fill.style.width = `${Math.round(Math.max(0.03, Math.min(1, frac)) * 100)}%`;
      bar.appendChild(fill);
      b.appendChild(bar);
    }
    st.textContent = text;
    b.appendChild(st);
    refs.boxes.appendChild(b);
  }

  // picture
  const fr = RUN.frame;
  if (fr?.src) {
    if (refs.img.src !== fr.src) refs.img.src = fr.src;
    refs.img.style.display = "";
    refs.picEmpty.style.display = "none";
    const s = RUN.stages.get(RUN.running);
    const step = fr.total ? `Step ${fr.step} of ${fr.total}` : "";
    refs.picLabel.textContent = [s?.label || fr.label, step].filter(Boolean).join(" · ");
  } else {
    refs.img.style.display = "none";
    refs.picEmpty.style.display = "";
    refs.picLabel.textContent = "";
  }

  // memory
  drawChart(refs.chart, node._rnCfg.vram_tier || "high");
  const last = RUN.vram[RUN.vram.length - 1];
  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  const peak = RUN.vram.reduce((m, v) => Math.max(m, v.used), 0);
  const tgt = TIER_TARGET_GB[node._rnCfg.vram_tier];
  refs.memLine.textContent = RUN.total
    ? `${last ? gb(last.used) : "-"} of ${gb(RUN.total)} in use${peak ? ` · peak ${gb(peak)}` : ""}`
      + (tgt ? ` · limit ${tgt} GB${peak > tgt * 1024 ? `, went over by ${gb(peak - tgt * 1024)}` : ""}` : "")
    : "Memory figures arrive with the first run.";
  refs.onCard.replaceChildren();
  if (!RUN.models.length) {
    refs.onCard.appendChild(el("div", "rn-ws-note", "Nothing ComfyUI tracks is loaded."));
  }
  for (const m of RUN.models) {
    const row = el("div", "rn-run-model");
    row.appendChild(el("span", "n", m.name));
    const bar = el("span", "bar");
    const fill = el("i");
    fill.style.width = `${RUN.total ? Math.round(Math.min(1, m.mb / RUN.total) * 100) : 0}%`;
    bar.appendChild(fill);
    row.append(bar, el("span", "mb", gb(m.mb)));
    refs.onCard.appendChild(row);
  }

  // log
  const atBottom = refs.log.scrollHeight - refs.log.scrollTop - refs.log.clientHeight < 30;
  refs.log.replaceChildren();
  if (!RUN.log.length) refs.log.appendChild(el("div", "rn-ws-note", "Press Generate to start a run."));
  for (const l of RUN.log) {
    const row = el("div", `rn-run-line ${l.level}`);
    row.append(el("span", "tm", clock(l.t)), el("i", "dot"), el("span", "tx", l.text));
    refs.log.appendChild(row);
  }
  if (atBottom) refs.log.scrollTop = refs.log.scrollHeight;
}

// What each VRAM limit is sized for. The limit itself only holds the expensive dials
// down; these are the cards it suits, drawn so a run that goes past one shows it.
export const TIER_TARGET_GB = { low: 16, medium: 24 };
const TIER_NAME = { low: "Low", medium: "Medium" };

function niceStep(maxGb) {
  for (const s of [1, 2, 4, 8, 16, 32]) if (maxGb / s <= 5) return s;
  return 64;
}

function drawChart(cv, tier) {
  const ctx = cv.getContext?.("2d");
  if (!ctx) return;
  const w = Math.max(240, Math.round(cv.clientWidth || cv.parentNode?.clientWidth || 360));
  const h = cv.height;
  if (cv.width !== w) cv.width = w;
  ctx.clearRect(0, 0, w, h);
  const total = RUN.total || 1;
  const pts = RUN.vram;
  const tMax = Math.max(10, secs(), pts.length ? pts[pts.length - 1].t : 0);
  const L = 38, Rm = 8, T = 10, B = 20;             // room for the axis labels
  const x = (t) => L + (t / tMax) * (w - L - Rm);
  const y = (mb) => h - B - (mb / total) * (h - B - T);
  const gb = (mb) => mb / 1024;
  const txt = (s, px, py, align = "left", color = "#8a919b") => {
    if (!ctx.fillText) return;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, px, py);
  };
  ctx.font = "10px sans-serif";
  ctx.lineWidth = 1;
  // the GB scale, with faint grid lines
  const step = niceStep(gb(total));
  for (let g = 0; g <= gb(total) + 0.01; g += step) {
    const yy = y(g * 1024);
    ctx.strokeStyle = "#1f2329";
    ctx.beginPath();
    ctx.moveTo(L, yy);
    ctx.lineTo(w - Rm, yy);
    ctx.stroke();
    txt(`${g} GB`, L - 5, yy + 3, "right");
  }
  // the time along the bottom
  for (const f of [0, 0.5, 1]) txt(clock(tMax * f), x(tMax * f), h - 5,
                                     f === 0 ? "left" : f === 1 ? "right" : "center");
  // the card's size
  ctx.strokeStyle = "#6b7280";
  ctx.setLineDash?.([4, 4]);
  ctx.beginPath();
  ctx.moveTo(L, y(total));
  ctx.lineTo(w - Rm, y(total));
  ctx.stroke();
  txt(`Card ${gb(total).toFixed(1)} GB`, w - Rm - 2, y(total) - 3, "right");
  // the VRAM limit's target card, when one is set
  const target = TIER_TARGET_GB[tier];
  if (target && target * 1024 < total) {
    const ty = y(target * 1024);
    ctx.strokeStyle = "#e0a84a";
    ctx.beginPath();
    ctx.moveTo(L, ty);
    ctx.lineTo(w - Rm, ty);
    ctx.stroke();
    txt(`${TIER_NAME[tier]} limit ${target} GB`, w - Rm - 2, ty - 3, "right", "#e0a84a");
  }
  ctx.setLineDash?.([]);
  // loads and unloads
  for (const m of RUN.marks) {
    ctx.strokeStyle = m.level === "load" ? "#22c55e" : "#e0a84a";
    ctx.beginPath();
    ctx.moveTo(x(m.t), T);
    ctx.lineTo(x(m.t), h - B);
    ctx.stroke();
  }
  // in use, its peak and where it is now
  if (pts.length) {
    ctx.strokeStyle = "#e0435a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.used)) : ctx.moveTo(x(p.t), y(p.used))));
    ctx.stroke();
    ctx.lineWidth = 1;
    const peak = pts.reduce((m, p) => (p.used > m.used ? p : m), pts[0]);
    ctx.fillStyle = "#e0435a";
    ctx.beginPath?.();
    ctx.arc?.(x(peak.t), y(peak.used), 3, 0, Math.PI * 2);
    ctx.fill?.();
    const px = x(peak.t);
    txt(`Peak ${gb(peak.used).toFixed(1)}`, px, y(peak.used) - 6,
        px < L + 40 ? "left" : px > w - 60 ? "right" : "center", "#f3b0ba");
    const last = pts[pts.length - 1];
    if (last !== peak) {
      txt(`${gb(last.used).toFixed(1)}`, Math.min(x(last.t) + 4, w - Rm), y(last.used) + 12,
          x(last.t) > w - 40 ? "right" : "left", "#f3b0ba");
    }
  }
}

export const RUN_CSS = `
.rn-run{display:flex;flex-direction:column;gap:10px}
.rn-run-top{flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap}
.rn-run-go{background:#b8283c;border:1px solid #d0344a;color:#fff;font-weight:800;
  font-size:14px;letter-spacing:.04em;border-radius:8px;padding:9px 22px;cursor:pointer}
.rn-run-go:hover{background:#cf2f45}
.rn-run-go:disabled{opacity:.6;cursor:wait}
.rn-run-tier{display:flex;align-items:center;gap:6px}
.rn-run-facts{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.rn-run-status.running{border-color:#4a8fe0;color:#cfe0f5}
.rn-run-status.done{border-color:#2e7d4f;color:#9fe0b4}
.rn-run-status.error,.rn-run-status.stopped{border-color:#b8283c;color:#f3b0ba}
.rn-run-boxes{display:flex;gap:8px;flex-wrap:wrap}
.rn-run-box{flex:1 1 120px;min-width:110px;background:#15171b;border:1px solid #33373d;
  border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.rn-run-box .t{font-weight:700;font-size:12.5px;color:#e8ecf1}
.rn-run-box .st{font-size:11.5px;color:#9aa0a8}
.rn-run-box.done{border-color:#2e7d4f}
.rn-run-box.done .st{color:#9fe0b4}
.rn-run-box.start,.rn-run-box.progress{border-color:#4a8fe0;background:#16202c}
.rn-run-box.start .st,.rn-run-box.progress .st{color:#cfe0f5}
.rn-run-box.skip,.rn-run-box.notrun,.rn-run-box.cached{opacity:.6}
.rn-run-box.error{border-color:#b8283c;background:#26161a}
.rn-run-box.error .st{color:#f3b0ba}
.rn-run-box .bar,.rn-run-model .bar{height:5px;border-radius:3px;background:#262a30;overflow:hidden}
.rn-run-box .bar i,.rn-run-model .bar i{display:block;height:100%;background:#4a8fe0}
.rn-run-cols{display:flex;gap:10px;flex-wrap:wrap}
.rn-run-pic{flex:1 1 300px;min-width:0}
.rn-run-mem{flex:1 1 300px;min-width:0}
.rn-run-img{width:100%;max-height:420px;object-fit:contain;border-radius:6px;background:#0f1114}
.rn-run-picempty{padding:40px 0;text-align:center}
.rn-run-piclabel{font-size:12px;color:#cfe0f5;text-align:center}
.rn-run-chart{width:100%;height:180px;background:#0f1114;border-radius:6px;display:block}
.rn-run-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#9aa0a8}
.rn-run-legend .k{display:inline-flex;align-items:center;gap:5px}
.rn-run-legend i{display:inline-block;width:14px;height:0;border-top:2px solid}
.rn-run-legend .use i{border-color:#e0435a}
.rn-run-legend .load i{border-color:#22c55e}
.rn-run-legend .unload i{border-color:#e0a84a}
.rn-run-legend .cap i{border-top:2px dashed #6b7280}
.rn-run-legend .tgt i{border-top:2px dashed #e0a84a}
.rn-run-sub{font-size:10.5px;font-weight:700;letter-spacing:.08em;color:#8a919b;margin-top:4px}
.rn-run-oncard{display:flex;flex-direction:column;gap:5px}
.rn-run-model{display:grid;grid-template-columns:minmax(80px,1fr) 2fr auto;gap:8px;
  align-items:center;font-size:12px;color:#c8ccd2}
.rn-run-model .bar i{background:#a855f7}
.rn-run-model .mb{color:#9aa0a8;font-variant-numeric:tabular-nums}
.rn-run-log{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:3px}
.rn-run-line{display:grid;grid-template-columns:44px 10px 1fr;gap:8px;align-items:center;
  font-size:12.5px;color:#c8ccd2}
.rn-run-line .tm{color:#7b828c;font-variant-numeric:tabular-nums}
.rn-run-line .dot{width:8px;height:8px;border-radius:50%;background:#4a8fe0}
.rn-run-line.done .dot{background:#22c55e}
.rn-run-line.load .dot{background:#a855f7}
.rn-run-line.unload .dot{background:#e0a84a}
.rn-run-line.skip .dot{background:#6b7280}
.rn-run-line.warn .dot{background:#e0435a}
.rn-ws-tab.g-run{--rn-g:#e0435a}
.rn-ws-tab.cur.g-run{border-color:#e0435a;background:#e0435a1a}
@media (max-width:560px){.rn-run-facts{margin-left:0}}
`;

export const runLit = () => RUN.status === "running";
export const _RUN_FOR_TESTS = RUN;
