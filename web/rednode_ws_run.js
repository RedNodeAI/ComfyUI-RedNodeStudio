import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { writeCfg, render, setupProblems, packInstalled,
         i2iBatchOpts } from "./rednode_workspace.js";
import { batchState, runBatch, sourceView } from "./rednode_ws_batch.js";
import { EXTRA_PACKS, packLink, EDITOR_SUB_IDS } from "./rednode_ws_tables.js";
import { mountReviewPanel, pushReviewEntry, openMenu as reviewMenu,
         openFullscreen as reviewFullscreen } from "./rednode_review.js";
import { mountStagePanel } from "./rednode_stages.js";
import { mountSavePanel } from "./rednode_save.js";
import { allNodes } from "./rednode_graph.js";

// the Detailer, under its name and the one older workflows still carry
const DETAILER_TYPES = new Set(["RedNodeStudioDetailer", "RedNodeStudioAdvanced"]);
// every node, subgraphs included, that is not muted or bypassed
const liveNodes = () => allNodes(app.graph).filter((n) => n.mode !== 2 && n.mode !== 4);

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
  outputs: [],         // {rank, images} the run's picture outputs, as they arrive
  final: null,         // the finished picture's /view URL (the frame in view)
  finals: [],          // every frame of the finished picture, a batch's worth
  finalFiles: [],      // the same as file records, for the thumbnail strip
  finalIdx: 0,
  batch: 1,            // the largest batch a pass sampled
  paint: false,        // a Paint tab run: the paint pass, not the render plan
  promptId: null,
};
const LOG_MAX = 200;
const VRAM_MAX = 900;
const views = new Set();

// THIS SESSION'S RUNS: a copy of each finished run's sheet, newest first, kept in
// the page only (a reload empties it). A sheet is text, numbers and picture links,
// a few KB, and it is only drawn when opened.
const HISTORY = [];
const HISTORY_MAX = 20;

const sheetSecs = (S) => (S.t0 ? (((S.t1 || Date.now()) - S.t0) / 1000) : 0);
const secs = () => sheetSecs(RUN);
// the sheet a node's Run page shows: a past run picked from History, or the live one
const shownSheet = (node) => node._rnRunSheet || RUN;
const timeOfDay = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function keepSheet() {
  const ws = workspaceNodes();
  const wsn = ws.find((n) => String(n.id) === String(RUN.node)) || ws[0];
  HISTORY.unshift({
    past: true,
    count: RUN.count, status: RUN.status, t0: RUN.t0, t1: RUN.t1,
    seed: RUN.seed, rig: RUN.rig, batch: RUN.batch, cached: RUN.cached, paint: RUN.paint,
    stages: new Map([...RUN.stages].map(([k, s]) => [k, { ...s, info: { ...(s.info || {}) } }])),
    running: "", frame: null,
    log: RUN.log.map((l) => ({ ...l })),
    vram: RUN.vram.slice(), marks: RUN.marks.slice(),
    models: RUN.models.map((m) => ({ ...m })), total: RUN.total,
    final: RUN.final, finals: RUN.finals.slice(),
    finalFiles: RUN.finalFiles.map((f) => ({ ...f })), finalIdx: RUN.finalIdx,
    promptId: RUN.promptId, limitGb: wsn?._rnCfg?.vram_gb || 0,
  });
  if (HISTORY.length > HISTORY_MAX) HISTORY.length = HISTORY_MAX;
}
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
  RUN.outputs = [];
  RUN.final = null;
  RUN.finals = [];
  RUN.finalFiles = [];
  RUN.finalIdx = 0;
  RUN.batch = 1;
  RUN.paint = false;
  for (const v of views) v.node._rnRunSheet = null;
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
  keepSheet();
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
      if (v.node._rnTab !== "run" || (v.node._rnRunSub || "run") !== "run"
          || v.gen !== v.node._rnRunGen) { views.delete(v); continue; }
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
    if (d.info?.paint) RUN.paint = true;
    if (d.info?.prompt != null) {
      // the words as queued: kept on the node for the Prompts tab's box
      RUN.prompt = String(d.info.prompt || "");
      const ws = workspaceNodes();
      const wsn = ws.find((n) => String(n.id) === String(d.node ?? RUN.node)) || ws[0];
      if (wsn) {
        (wsn.properties ||= {}).rn_last_prompt = {
          text: RUN.prompt, negative: String(d.info.negative || ""),
          row: String(d.info.prompt_row || ""), index: Number(d.info.prompt_index ?? -1),
          // what the Editor's Converter was handed, when it changed anything
          before: String(d.info.final_before || ""),
          seed: RUN.seed, at: Date.now(), promptId: RUN.promptId || null,
        };
        wsn._rnLastPromptChanged?.();
        wsn._rnFinalChanged?.();
      }
    }
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
        if (Number(i.batch) > RUN.batch) RUN.batch = Number(i.batch);
        const bits = [
          i.size ? `${i.size[0]} x ${i.size[1]}` : "",
          Number(i.batch) > 1 ? `batch of ${i.batch}` : "",
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
  api.addEventListener("execution_start", (e) => {
    resetRun();
    RUN.promptId = e?.detail?.prompt_id ?? null;
    refreshAll();
  });
  api.addEventListener("executed", (e) => onExecuted(e?.detail));
  api.addEventListener("execution_cached", (e) => {
    const ids = (e?.detail?.nodes || []).map(String);
    const ws = workspaceNodes().map((n) => String(n.id));
    if (ws.some((id) => ids.includes(id))) {
      RUN.cached = true;
      logLine("The Workspace is unchanged, so its render is reused from the last run");
      refreshAll();
    }
  });
  api.addEventListener("execution_success", () => {
    const best = bestOutput();
    if (best) {
      RUN.finals = best.map(viewUrl);
      RUN.finalFiles = best.map((f) => ({ ...f }));
      RUN.finalIdx = 0;
      RUN.final = RUN.finals[0];
      for (const ws of workspaceNodes()) pushReviewEntry(reviewHost(ws), best, RUN.promptId);
    }
    finishRun("done");
    refreshAll();
  });
  api.addEventListener("execution_error", (e) => {
    finishRun("error", String(e?.detail?.exception_message || "").slice(0, 160));
    refreshAll();
  });
  api.addEventListener("execution_interrupted", () => { finishRun("stopped"); refreshAll(); });
  setInterval(() => { if (RUN.status === "running" && views.size) refreshAll(); }, 1000);
}

// ---- what the run should need ---------------------------------------------------
const VRAM_TIER_FOR = { 8: "low", 12: "low", 16: "low", 24: "medium", 32: "high" };
const HEADROOM_GB = 0.5;
const _estCache = { key: "", data: null };

// THE SERVER DECIDES (vram_hold.decide) and says why; this only words it. An
// answer from before 1.4.2 carries neither, and falls back to peak against limit.
// spared: over the limit with everything resident, but the sampler's own need
// fits and the limit is the card, so ComfyUI drops the rest by itself.
function holdVerdict(cfg, d, lim) {
  const e = d.estimate;
  const mode = cfg.vram_hold_mode || "auto";
  const over = lim ? e.peak > lim : false;
  const held = typeof d.hold === "boolean" ? d.hold : (over && mode !== "off");
  const spared = over && !held && d.why === "droppable";
  return { mode, over, held, spared, need: Number(e.need ?? e.peak) };
}

export function estimateText(cfg, d) {
  if (!d || d.error) return "";
  const lim = cfg.vram_gb ? cfg.vram_gb - HEADROOM_GB : null;
  const e = d.estimate;
  if (!e) {
    return lim ? `Limit ${lim} GB. No estimate: the Workspace is not rendering with its `
                 + "own sampler." : "";
  }
  const parts = e.parts.map(([n, g]) => `${n} ${Number(g).toFixed(1)}`).join(", ");
  let verdict = "";
  const hv = holdVerdict(cfg, d, lim);
  if (lim) {
    const { over, mode } = hv;
    verdict = hv.spared
      ? ` Over the ${lim} GB limit with everything resident, but the sampler needs about `
        + `${hv.need.toFixed(1)} GB: ComfyUI drops the text encoder and SAM3 by itself when `
        + "the card fills, so it runs at full speed."
      : over
      ? (mode === "off" ? ` Over the ${lim} GB limit, and Hold is Off, so it may run out.`
         : ` Over the ${lim} GB limit, so it will hold: slower, and it stays near the line.`)
      : (mode === "on" ? ` Under the ${lim} GB limit; Hold is On, so it holds anyway.`
         : ` Under the ${lim} GB limit, so it runs at full speed.`);
  }
  // a run with an edit stage peaks at the larger stage, not the sum of the parts
  const st = Array.isArray(e.stages) && e.stages.length > 1
    ? ` at its largest stage (${e.stages.map(([n, g]) => `${n} ${Number(g).toFixed(1)}`).join(", ")})`
    : "";
  // NOT "estimated peak": this is what the run would need with nothing held, which
  // is the number Hold reads to decide whether to hold at all. Once it holds, the
  // peak you actually see is far below it. Calling both a peak, with the measured
  // one on the chart beside it, read as the estimate having been wrong by tens of GB.
  const held = !!lim && hv.held && hv.over;
  return `Needs about ${e.peak.toFixed(1)} GB unheld${st} (${parts}).${verdict} `
         + (held ? "Holding keeps the peak well under that, so the measured peak on the "
                 + "chart is the one to read. " : "")
         + "Captioners are not counted.";
}

// "Your own nodes" rigs name their files in the loaders wired into a RedNode Rig
// Model node, not on the Models tab; the estimate reads them from the canvas
// (matching workspace.graph_rig_files, which reads the queued workflow)
const RIG_FILE_KEYS = {
  model: ["unet_name", "ckpt_name"],
  clip: ["clip_name", "clip_name1", "clip_name2", "clip_name3", "ckpt_name"],
  vae: ["vae_name", "ckpt_name"],
};
function upstreamOf(n, input) {
  const g = n?.graph;
  if (!g || input?.link == null) return null;
  const l = g.links?.get?.(input.link) ?? g.links?.[input.link];
  return l ? (g.getNodeById?.(l.origin_id) ?? null) : null;
}
export function graphRigFiles() {
  const out = {};
  for (const n of liveNodes()) {
    if (n.type !== "RedNodeRigModel") continue;
    const rig = String(n.widgets?.find((w) => w.name === "rig")?.value || "").trim() || "My rig";
    const rec = (out[rig] ||= {});
    for (const [sock, keys] of Object.entries(RIG_FILE_KEYS)) {
      const queue = [upstreamOf(n, (n.inputs || []).find((i) => i.name === sock))];
      const seen = new Set();
      while (queue.length && seen.size < 40) {
        const u = queue.shift();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const hits = (u.widgets || []).filter((w) => keys.includes(w.name)
          && typeof w.value === "string" && w.value);
        if (hits.length) {
          for (const w of hits) {
            if (w.name === "ckpt_name") rec.checkpoint = w.value;
            else if (w.name === "unet_name") rec.unet ||= w.value;
            else if (w.name === "vae_name") rec.vae ||= w.value;
            else if (!(rec.clips ||= []).includes(w.value)) rec.clips.push(w.value);
          }
          continue;
        }
        for (const inp of u.inputs || []) queue.push(upstreamOf(u, inp));
      }
    }
  }
  return out;
}

let _estTimer = null;
function fetchEstimate(node, line) {
  let files = {};
  try { files = graphRigFiles(); } catch (e) { files = {}; }
  const cfgStr = JSON.stringify(node._rnCfg || {});
  const key = cfgStr + JSON.stringify(files);
  if (_estCache.key === key && _estCache.data) {
    renderEstimate(node._rnCfg, _estCache.data, line);
    return;
  }
  clearTimeout(_estTimer);
  _estTimer = setTimeout(async () => {
    try {
      const res = await api.fetchApi("/rednode/vram_estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfgStr, rig_files: files }),
      });
      const d = await res.json();
      _estCache.key = key;
      _estCache.data = d;
      renderEstimate(node._rnCfg, d, line);
    } catch (e) { /* the card stays empty: an estimate is a nicety */ }
  }, 150);
}

// THE ESTIMATE AS A CARD under the pipeline: one big number, what the run needs
// with nothing held; a bar against the card with the limit marked on it; a
// verdict chip; the parts as chips; and the stage line and the caveat as a
// note. The sentence estimateText builds stays as the card's title, so a
// hover reads the whole story in one line.
export function renderEstimate(cfg, d, host) {
  if (!host) return;
  host.replaceChildren();
  host.title = estimateText(cfg, d);
  if (!d || d.error) return;
  const e = d.estimate;
  const lim = cfg.vram_gb ? cfg.vram_gb - HEADROOM_GB : null;
  const card = Number(d.card) || 0;
  if (!e) {
    host.appendChild(el("div", "rn-ws-note", lim
      ? `Limit ${lim} GB. No estimate: the Workspace is not rendering with its own sampler.`
      : "No estimate: the Workspace is not rendering with its own sampler."));
    return;
  }
  const hv = holdVerdict(cfg, d, lim);
  const { mode, over } = hv;
  const tone = !lim ? "plain" : hv.spared ? "green"
    : over ? (mode === "off" ? "red" : "amber") : "green";
  const verdict = !lim ? ""
    : hv.spared ? `The sampler needs ${hv.need.toFixed(1)} GB, under the ${lim} GB limit: full speed`
    : over ? (mode === "off" ? `Over the ${lim} GB limit, Hold is Off: it may run out`
                              : `Over the ${lim} GB limit: it will hold, slower, near the line`)
    : (mode === "on" ? `Under the ${lim} GB limit; Hold is On, so it holds anyway`
                     : `Under the ${lim} GB limit: full speed`);
  // FOLDED: one line, the number and the verdict, and a Show. Open: the bar,
  // the parts and the note under it, and a Hide. The choice rides the config.
  const folded = !!cfg.vram_est_folded;
  const big = el("div", "rn-run-estbig");
  big.appendChild(el("span", "num", `${e.peak.toFixed(1)} GB`));
  big.appendChild(el("span", "lbl", "needed, nothing held"));
  if (verdict) big.appendChild(el("span", `rn-run-estchip ${tone}`, verdict));
  const fold = el("button", "rn-run-estfold", folded ? "Show" : "Hide");
  fold.title = folded ? "Show the bar, the parts and the note." : "Fold the estimate to this one line.";
  fold.onclick = (ev) => {
    ev.stopPropagation();
    cfg.vram_est_folded = !folded;
    host._rnWrite?.();
    renderEstimate(cfg, d, host);
  };
  big.appendChild(fold);
  host.appendChild(big);
  if (folded) return;
  // the bar: the card is the width, the limit a mark on it, the need the fill
  const scale = Math.max(card || 0, e.peak, lim || 0) || 1;
  const bar = el("div", `rn-run-estbar ${tone}`);
  const fill = el("i", "fill");
  fill.style.width = `${Math.min(100, (e.peak / scale) * 100).toFixed(1)}%`;
  bar.appendChild(fill);
  if (lim) {
    const mark = el("i", "mark");
    mark.style.left = `${Math.min(100, (lim / scale) * 100).toFixed(1)}%`;
    mark.title = `Limit ${lim} GB`;
    bar.appendChild(mark);
  }
  host.appendChild(bar);
  const sc = el("div", "rn-run-estscale");
  sc.appendChild(el("span", null, "0"));
  sc.appendChild(el("span", null, lim ? `Limit ${lim} GB` : ""));
  sc.appendChild(el("span", null, card ? `Card ${card.toFixed(1)} GB` : ""));
  host.appendChild(sc);
  const parts = el("div", "rn-run-estparts");
  for (const [n, g] of (e.parts || [])) parts.appendChild(el("span", "rn-ws-chip", `${n} ${Number(g).toFixed(1)} GB`));
  host.appendChild(parts);
  const notes = [];
  if (Array.isArray(e.stages) && e.stages.length > 1) {
    notes.push("Peaks at its largest stage: " + e.stages.map(([n, g]) => `${n} ${Number(g).toFixed(1)}`).join(", ") + ".");
  }
  if (hv.spared) {
    notes.push("The big number is everything resident at once. The text encoder and SAM3 are not "
      + "needed while the sampler runs, and ComfyUI drops them by itself when the card fills, so "
      + "this run is not held.");
  } else if (over && hv.held) {
    notes.push("Holding keeps the peak well under that, so the measured peak on the chart is the one to read.");
  }
  notes.push("Captioners are not counted.");
  host.appendChild(el("div", "rn-ws-note", notes.join(" ")));
}

// ---- the finished picture ------------------------------------------------------
// Which node's pictures count as the run's result, best first: what Save filed,
// then what Review or Live Preview showed, then any stock preview.
const OUTPUT_RANK = { RedNodeSave: 4, RedNodeImageReview: 3, RedNodeLivePreview: 2 };

function nodeById(id) {
  const seen = new Set();
  const find = (g) => {
    if (!g || seen.has(g)) return null;
    seen.add(g);
    for (const n of (g._nodes || g.nodes || [])) {
      if (String(n.id) === String(id)) return n;
      const sub = n.subgraph && find(n.subgraph);
      if (sub) return sub;
    }
    return null;
  };
  return find(app.graph);
}

function onExecuted(d) {
  const filed = d?.output?.rn_run_images;
  if (Array.isArray(filed) && filed.length && RUN.status === "running") {
    RUN.outputs.push({ rank: 5, images: filed.map((f) => ({ ...f })) });
  }
  // no Save this run: the result the built-in chain would have saved, kept so the
  // Live picture and the Review are never empty just because nothing was written
  // to disk. Lowest rank: a real save, a wired Save node, the Review or Live
  // Preview on the canvas all outrank it.
  const kept = d?.output?.rn_final_images;
  if (Array.isArray(kept) && kept.length && RUN.status === "running") {
    RUN.outputs.push({ rank: 0, images: kept.map((f) => ({ ...f })) });
  }
  const images = d?.output?.images;
  if (!Array.isArray(images) || !images.length || RUN.status !== "running") return;
  const n = nodeById(d.display_node ?? d.node);
  RUN.outputs.push({ rank: OUTPUT_RANK[n?.type] ?? 1, images: images.map((f) => ({ ...f })) });
}

function bestOutput() {
  let best = null;
  for (const o of RUN.outputs) if (!best || o.rank >= best.rank) best = o;
  return best ? best.images : null;
}

const fileQuery = (f) => new URLSearchParams({
  filename: f.filename || "", subfolder: f.subfolder || "", type: f.type || "output",
});
const viewUrl = (f) => api.apiURL(`/view?${fileQuery(f)}`);
// the strip's copies come resized from the server, so a batch of eight does not
// decode eight full pictures for eight small squares
const thumbUrl = (f) => api.apiURL(`/rednode/thumb?${fileQuery(f)}&px=160`);

const workspaceNodes = () => allNodes(app.graph)
  .filter((n) => n.type === "RedNodeStudioWorkspace");

// The Review and Stages sub-tabs keep their panel state on a host of their own, so it
// never meets the Workspace's own fields; the history rides the node's properties.
function reviewHost(node) {
  node.properties ||= {};
  node.properties.rn_run_review ||= {};
  node._rnReviewHost ||= { id: `${node.id}:run`, type: "RedNodeImageReview" };
  node._rnReviewHost.properties = node.properties.rn_run_review;
  node._rnReviewHost.graph = node.graph;
  node._rnReviewHost._rnOwner = node;   // the Workspace behind it, for its run records
  // hosted from the start: full screen from the picture can render it before the
  // Review sub-tab ever mounted it
  node._rnReviewHost.size ||= [0, 0];
  node._rnReviewHost.setSize ||= () => {};
  node._rnReviewHost._rnSized = true;
  return node._rnReviewHost;
}

function stageHost(node) {
  node._rnStageHost ||= { id: `${node.id}:stages`, type: "RedNodeStageView" };
  node._rnStageHost.graph = node.graph;
  return node._rnStageHost;
}

// ---- the taps ------------------------------------------------------------------
const TAP_POINTS = [
  ["refs", "References", "The Subject and Scene pictures as the model gets them."],
  ["source", "Img2Img source", "The source picture before Re-angle and Swap."],
  ["reangle", "Re-angle", "The re-shot picture."],
  ["swap", "Swap", "The picture after the face or person swap."],
  ["passes", "Each pass", "Every pass's result, drawn by the small preview decoder."],
  ["final", "Final picture", "The Workspace's finished picture."],
];
const TAP_SIZES = [[320, "320 px"], [512, "512 px"], [768, "768 px"], [1024, "1024 px"],
                   [1536, "1536 px"], [0, "Full size"]];

function tapsCard(node) {
  const cfg = node._rnCfg;
  const T = (cfg.taps && typeof cfg.taps === "object") ? cfg.taps : (cfg.taps = {});
  if (typeof T.on !== "boolean") T.on = false;
  if (!TAP_SIZES.some(([v]) => v === T.px)) T.px = 768;
  if (!Array.isArray(T.points)) T.points = TAP_POINTS.map(([v]) => v);
  const card = el("div", "rn-ws-card rn-run-taps");
  card.appendChild(el("div", "ch", "TAPS"));
  // the Workspace's own
  const row = el("div", "rn-ws-row");
  row.style.flexWrap = "wrap";
  const sw = el("button", "rn-ws-sw" + (T.on ? " on" : ""));
  sw.dataset.choice = "ws_taps";
  sw.title = "Photograph moments of the Workspace's run for the strip below.";
  sw.onclick = () => { T.on = !T.on; writeCfg(node); render(node); };
  const size = el("select", "rn-ws-res");
  for (const [v, label] of TAP_SIZES) {
    const o = el("option", "", label);
    o.value = String(v);
    o.selected = T.px === v;
    size.appendChild(o);
  }
  size.title = "The size each tap is kept at for the big view. The strip stays small.";
  size.onchange = () => { T.px = parseInt(size.value, 10); writeCfg(node); };
  row.append(sw, el("span", "rn-ws-swlabel rn-run-tapname", "Workspace"), size);
  const chips = el("div", "rn-ws-seg rn-ws-switch rn-run-tappoints");
  chips.dataset.choice = "tap_points";
  for (const [v, label, tip] of TAP_POINTS) {
    const on = T.points.includes(v);
    const b = el("button", "rn-ws-segb" + (on ? " on" : ""), label);
    b.title = tip + (on ? " Click to leave it out." : " Click to tap it.");
    b.disabled = !T.on;
    b.onclick = () => {
      const next = on ? T.points.filter((x) => x !== v) : [...T.points, v];
      T.points = TAP_POINTS.map(([x]) => x).filter((x) => next.includes(x));
      writeCfg(node);
      render(node);
    };
    chips.appendChild(b);
  }
  row.appendChild(chips);
  card.appendChild(row);
  // each Detailer's own switch, written into that node's settings
  const dets = allNodes(app.graph).filter((n) => DETAILER_TYPES.has(n.type));
  for (const d of dets) {
    const w = d.widgets?.find((x) => x.name === "config");
    let dc = {};
    try { dc = JSON.parse(w?.value || "{}"); } catch (e) { dc = {}; }
    const drow = el("div", "rn-ws-row");
    const dsw = el("button", "rn-ws-sw" + (dc.taps ? " on" : ""));
    dsw.dataset.detailer = String(d.id);
    dsw.title = "The Detailer's own taps: its input, a frame after every pass, its output.";
    dsw.onclick = () => {
      dc.taps = !dc.taps;
      if (w) w.value = JSON.stringify(dc);
      d.graph?.setDirtyCanvas?.(true, false);
      d._rnAdvRender?.();
      render(node);
    };
    drow.append(dsw, el("span", "rn-ws-swlabel rn-run-tapname",
                        d.title && d.title !== "RedNode Studio Detailer" ? d.title : `Detailer ${d.id}`),
                el("span", "rn-ws-note", "Its input, every pass and its output"));
    card.appendChild(drow);
  }
  const nTaps = liveNodes().filter((n) => n.type === "RedNodeStageTap").length;
  card.appendChild(el("div", "rn-ws-note",
    (nTaps ? `${nTaps} Stage Tap node${nTaps === 1 ? "" : "s"} in the workflow also record. ` : "")
    + "Taps show after the next run. A RedNode Stage Tap node can photograph any other "
    + "point of the graph. Each pass is decoded through the rig's VAE so it looks like "
    + "the finished picture, which costs a fraction of a second per pass."));
  return card;
}

// ---- what this workflow will run -------------------------------------------------
const PASS_LABEL = (i, latent) => `Pass ${i} · ${i > 1 ? "Refine" : latent ? "Generate" : "Img2Img"}`;

export function plannedStages(node, cfg) {
  const out = [];
  const tabs = cfg.tabs || {};
  // AN UPSCALE RUN HAS ITS OWN SHAPE. It renders nothing, so the ordinary plan
  // sat there with Encode, the passes and Decode all at waiting for stages that
  // never fire (the user, 2026-09-20). The tab says when one of its runs is in
  // flight and the plan follows it.
  if (node?._rnRunKind === "upscale") {
    const U = cfg.upscale || {};
    const A = U.after || {};
    if (U.pre_size) out.push(["resize", "Resize"]);
    if (U.stage?.type !== "none") {
      out.push(["upscale", "Upscale"]);
    } else if (!U.pre_size) {
      out.push(["upscale", "Pass through"]);
    }
    if (!A.manual) {
      if (A.detailer) out.push(["detailer", "Detailer"]);
      if (A.post) out.push(["post", "Post FX"]);
      if (A.save) out.push(["save", "Save"]);
    }
    return out;
  }
  const captions = Object.values(tabs).some((t) => t?.on && t.auto?.on
    && (t.images?.length || 0) > 0);
  if (captions) out.push(["captions", "Captions"]);
  const internal = cfg.models?.sampler_mode === "internal";
  const I = tabs.i2i || {};
  const i2iRun = I.on && !I.prompt_only && ((I.images?.length || 0) > 0 || I.canvas !== "gallery");
  // the edit stages on the source run before the encode
  const RA = I.reangle || {};
  if (i2iRun && RA.on && (RA.target || "source") === "source") out.push(["reangle", "Re-angle"]);
  if (i2iRun && I.swap?.on && I.swap.target !== "render") out.push(["swap", "Swap"]);
  if (internal) {
    out.push(["encode", "Encode"]);
    const n = Math.max(1, Math.round(Number(i2iRun ? I.passes : cfg.latent?.passes) || 1));
    for (let i = 1; i <= n; i++) out.push([`pass${i}`, PASS_LABEL(i, !i2iRun)]);
    out.push(["decode", "Decode"]);
  } else {
    // the Workspace itself renders nothing on External sampler; without this the
    // pipeline was just empty, with no reason
    out.push(["external", "Render"]);
  }
  // a swap on the render runs whatever the pass mode (workspace.py swaps the
  // finished render), so Prompt only does not stand it down
  if (RA.on && RA.target === "render") {
    out.push(["reangle", "Re-angle"]);
    if (RA.polish !== false && internal) out.push(["reangle_polish", "Re-angle polish"]);
  }
  const SW = tabs.i2i?.swap || {};
  if (SW.on && SW.target === "render") {
    out.push(["swap", "Swap"]);
    if (SW.polish !== false && internal) out.push(["swap_polish", "Swap polish"]);
  }
  const types = new Set(liveNodes().map((n) => n.type));
  const detOn = !!(cfg.detailer_on && (cfg.detailer?.stages || []).some((s) => s.on && s.type !== "title"));
  const postOn = cfg.post_on !== false && Object.values(cfg.post || {}).some((f) => f?.on);
  if (detOn || [...DETAILER_TYPES].some((t) => types.has(t))) out.push(["detailer", "Detailer"]);
  if (postOn || types.has("RedNodePostProcess")) out.push(["post", "Post FX"]);
  if (cfg.save_on || types.has("RedNodeSave")) out.push(["save", "Save"]);
  return out;
}

// ---- jumping to where a thing is set ----------------------------------------------
// A pipeline box or a log line opens the page of the workspace that decides it:
// the encode is the Prompts tab, a pass is the Passes page, a caption is that
// tab's Auto prompt, a rig is the Models tab.
export function goTo(node, t) {
  if (!t) return;
  // the editing stages and Upscale moved to the Editor tab; a link written for
  // their old home still lands on the right page
  if (t.tab === "i2i" && EDITOR_SUB_IDS.includes(t.sub)) t = { ...t, tab: "editor" };
  if (t.tab === "upscale") t = { tab: "editor", sub: "upscale" };
  const p = (node.properties ||= {});
  node._rnTab = t.tab;
  p.rn_tab = t.tab;
  if (t.tab === "i2i") {
    node._rnI2iSub = t.sub || "source"; p.rn_i2i_sub = node._rnI2iSub;
    if (t.auto) { node._rnI2iAuto = t.auto; p.rn_i2i_auto = t.auto; }
    if (t.side) { node._rnTextSide = t.side; p.rn_text_side = t.side; }
  } else if (t.tab === "editor") {
    node._rnEdSub = t.sub || "reangle"; p.rn_editor_sub = node._rnEdSub;
  } else if (t.tab === "latent") {
    node._rnLatSub = t.sub || "canvas"; p.rn_latent_sub = node._rnLatSub;
  } else if (t.tab === "identity") {
    node._rnIdSub = t.sub || "subject"; p.rn_identity_sub = node._rnIdSub;
    if (t.inner) { (node._rnIdInner ||= {})[node._rnIdSub] = t.inner; p["rn_identity_" + node._rnIdSub] = t.inner; }
  } else if (t.tab === "moodboard") {
    node._rnMbSub = t.sub || "gallery"; p.rn_moodboard_sub = node._rnMbSub;
  } else if (t.tab === "run") {
    node._rnRunSub = t.sub || "run"; p.rn_run_sub = node._rnRunSub;
  }
  render(node);
}

export const autoPageOf = (tabName) => (
  tabName === "subject" || tabName === "scene" ? { tab: "identity", sub: tabName, inner: "auto" }
  : tabName === "moodboard" ? { tab: "moodboard", sub: "auto" }
  : tabName === "i2i" ? { tab: "i2i", sub: "auto", auto: "i2i" }
  : tabName.startsWith("text_") ? { tab: "i2i", sub: "auto", auto: "text", side: tabName }
  : null);

function passesPage(cfg) {
  const I = cfg.tabs?.i2i || {};
  const i2iRun = I.on && !I.prompt_only && ((I.images?.length || 0) > 0 || I.canvas !== "gallery");
  return i2iRun ? { tab: "i2i", sub: "passes" } : { tab: "latent", sub: "passes" };
}

export function jumpForStage(key, cfg) {
  if (key === "captions") {
    const first = ["subject", "scene", "moodboard", "i2i", "text_style", "text_subject", "text_scene"]
      .find((n) => cfg.tabs?.[n]?.on && cfg.tabs[n].auto?.on && (cfg.tabs[n].images?.length || 0) > 0);
    return autoPageOf(first || "i2i");
  }
  if (key === "encode") return { tab: "prompts" };
  if (/^pass\d+$/.test(key)) return passesPage(cfg);
  if (key === "decode" || key === "external" || key.startsWith("rig:")) return { tab: "models" };
  if (key === "swap" || key === "swap_polish") return { tab: "i2i", sub: "swap" };
  if (key === "reangle" || key === "reangle_polish") return { tab: "i2i", sub: "reangle" };
  if (key === "paint") return { tab: "paint" };
  if (key === "detailer") return { tab: "detailer" };
  if (key === "post") return { tab: "post" };
  if (key === "save") return { tab: "run", sub: "save" };
  return null;
}

export const CAPTION_TABS = [["Subject", "subject"], ["Scene", "scene"], ["Moodboard", "moodboard"],
                      ["Img2Img", "i2i"], ["Image to text Style", "text_style"],
                      ["Image to text Subject", "text_subject"], ["Image to text Scene", "text_scene"]];

export function jumpForLine(text, cfg) {
  const t = String(text || "");
  const cap = CAPTION_TABS.find(([label]) => t.startsWith(label + " caption"));
  if (cap) return autoPageOf(cap[1]);
  if (/^Captions /.test(t)) return jumpForStage("captions", cfg);
  if (/^Encode /.test(t)) return { tab: "prompts" };
  if (/^Pass \d+/.test(t)) return passesPage(cfg);
  if (/^Decode /.test(t)) return { tab: "models" };
  if (/^Swap /.test(t)) return { tab: "i2i", sub: "swap" };
  if (/^Re-angle /.test(t)) return { tab: "i2i", sub: "reangle" };
  if (/^Paint[ :]/.test(t)) return { tab: "paint" };
  if (/^Detailer/.test(t)) return { tab: "detailer" };
  if (/^Post FX/.test(t)) return { tab: "post" };
  if (/^Save /.test(t)) return { tab: "run", sub: "save" };
  if (/^Load Rig|loaded from disk|already in RAM|dropped from RAM|^Rig /.test(t)) return { tab: "models" };
  if (/Text encoder|^VAE|^Krea 2|loaded \(|unloaded \(/.test(t)) return { tab: "models" };
  if (/^Draft is on/.test(t)) return { tab: "detailer" };
  return null;
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

const RUN_SUBS = [
  ["run", "RUN", "Queue the workflow and watch the stages, the picture and the memory."],
  ["review", "REVIEW", "Every finished picture from this Workspace's runs, newest first. "
                       + "Right-click one to copy it, open its folder, or run it again."],
  ["stages", "STAGES", "What each Stage Tap and the Detailer's taps photographed in the "
                       + "last run, with a wipe to compare two."],
  ["save", "SAVE", "Where and how the Workspace files each finished picture."],
];

// A stand-in node for a panel hosted on the Workspace: its config widget reads and
// writes one key of the Workspace's settings, so the panel's own code saves there.
export function configHost(node, key, type) {
  node._rnHosts ||= {};
  const h = (node._rnHosts[key] ||= { id: node.id, type });
  node.properties ||= {};
  const pk = `rn_${key}_panel`;
  node.properties[pk] ||= {};
  h.properties = node.properties[pk];
  h.graph = node.graph;
  h.size ||= [640, 480];
  h.computeSize ||= () => h.size;
  h.setSize ||= () => {};
  h.widgets = [{
    name: "config",
    get value() { return JSON.stringify(node._rnCfg?.[key] || {}); },
    set value(v) {
      try { node._rnCfg[key] = JSON.parse(v || "{}"); } catch (e) { return; }
      writeCfg(node);
    },
  }];
  return h;
}

export function runTabBody(node, body) {
  listenRun();
  const props = (node.properties ||= {});
  let sub = node._rnRunSub || props.rn_run_sub || "run";
  if (!RUN_SUBS.some(([id]) => id === sub)) sub = "run";
  node._rnRunSub = sub;
  const strip = el("div", "rn-ws-sub");
  for (const [id, label, tip] of RUN_SUBS) {
    const b = el("button", "rn-ws-subt" + (id === sub ? " cur" : ""));
    b.dataset.sub = id;
    b.title = tip;
    // each light says its page is doing something: a run going, taps on, filing on
    const cfg0 = node._rnCfg || {};
    const lit = id === "run" ? RUN.status === "running"
      : id === "save" ? !!cfg0.save_on
      : id === "stages" ? !!(cfg0.taps?.on && (cfg0.taps.points || []).length)
      : false;
    const lt = el("span", "lt" + (lit ? " on" : ""));
    b.append(lt, el("span", "", label));
    b.onclick = () => { node._rnRunSub = id; props.rn_run_sub = id; render(node); };
    strip.appendChild(b);
  }
  body.appendChild(strip);
  if (sub === "review") {
    const host = el("div");
    body.appendChild(host);
    mountReviewPanel(reviewHost(node), host);
    return;
  }
  if (sub === "save") {
    const cfg = node._rnCfg;
    const bar = el("div", "rn-ws-status");
    const on = el("button", "rn-ws-sw" + (cfg.save_on ? " on" : ""));
    on.dataset.choice = "save_on";
    on.title = cfg.save_on
      ? "The Workspace files every finished picture with these settings. Click to stop."
      : "Off: nothing is filed by the Workspace. A RedNode Save node on the canvas still files.";
    on.onclick = () => { cfg.save_on = !cfg.save_on; writeCfg(node); render(node); };
    bar.append(on, el("span", "nm", "Save"),
               el("span", "rn-ws-chip", cfg.save_on ? "Files each finished picture" : "Off"));
    body.appendChild(bar);
    const host = el("div");
    body.appendChild(host);
    mountSavePanel(configHost(node, "save", "RedNodeSave"), host);
    return;
  }
  if (sub === "stages") {
    body.appendChild(tapsCard(node));
    const host = el("div");
    body.appendChild(host);
    mountStagePanel(stageHost(node), host);
    return;
  }
  runPage(node, body);
}

function runPage(node, body) {
  const cfg = node._rnCfg;
  const root = el("div", "rn-run");
  node._rnRunGen = (node._rnRunGen || 0) + 1;
  const view = { node, root, refs: {}, gen: node._rnRunGen };

  // TOP ROW: Generate, Full or Draft, the VRAM limit; the run's facts on the right
  const top = el("div", "rn-ws-card rn-run-top");
  const gen = el("button", "rn-run-go", "Generate");
  gen.title = "Queue the whole workflow, the same as ComfyUI's Queue button.";
  gen.onclick = () => queueWorkflow(gen);
  // THE FOLDER BATCH, here too, when Img2Img is on and its source is the folder.
  // Generate above queues the workflow ONCE, which is one picture however many
  // are in the folder, so without this the Run page cannot start the thing the
  // Img2Img tab is set up to do (the user, 2026-09-20).
  const i2iOn = !!cfg.tabs?.i2i?.on;
  const bst = batchState(node, "i2i");
  const batchGo = (i2iOn && sourceView(node, "i2i") === "batch" && bst.files.length)
    ? el("button", "rn-run-go rn-run-go-batch",
         bst.running ? "Running the batch…"
                     : `Run All Batch (${bst.sel?.size || bst.files.length})`)
    : null;
  if (batchGo) {
    batchGo.title = "Run the Img2Img folder, one picture per queue. Generate beside "
                  + "it renders once, from the gallery.";
    batchGo.disabled = bst.running;
    batchGo.onclick = () => runBatch(node, "i2i", i2iBatchOpts(node),
                                     bst.sel?.size ? [...bst.sel].sort((a, b) => a - b)
                                                   : undefined);
  }
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
  tier.dataset.choice = "vram_gb";
  for (const [v, label] of [[0, "Free range"], [32, "32 GB+ card"], [24, "24 GB card"],
                            [16, "16 GB card"],
                            [12, "12 GB card"], [8, "8 GB card"]]) {
    const o = el("option", "", label);
    o.value = String(v);
    o.selected = (cfg.vram_gb || 0) === v;
    tier.appendChild(o);
  }
  tier.title = "Your card's VRAM. The run is kept half a GB under it, the expensive "
             + "dials are held to what that card can take, and Hold decides whether "
             + "ComfyUI keeps the rest of the card free. Free range lifts it all.";
  tier.onchange = () => {
    cfg.vram_gb = parseInt(tier.value, 10) || 0;
    cfg.vram_tier = VRAM_TIER_FOR[cfg.vram_gb] || "high";
    writeCfg(node);
    render(node);
  };
  tierWrap.appendChild(tier);
  if (cfg.vram_gb) {
    const lim = cfg.vram_gb - HEADROOM_GB;
    const hold = el("div", "rn-ws-seg rn-ws-switch rn-run-hold");
    hold.dataset.choice = "vram_hold_mode";
    for (const [v, label, tip] of [
      ["auto", "Auto", `Holds only when the estimated peak is over ${lim} GB, so a run that `
                       + "fits keeps its speed."],
      ["on", "On", `Always holds under ${lim} GB: ComfyUI keeps the rest of the card free, `
                   + "a model that does not fit loads in part, and the text encoder leaves "
                   + "the card before sampling. Slower."],
      ["off", "Off", "Never holds: the limit only holds the dials down, and the models load "
                     + "whole."],
    ]) {
      const b = el("button", "rn-ws-segb" + ((cfg.vram_hold_mode || "auto") === v ? " on" : ""),
                   label);
      b.title = tip;
      b.onclick = () => { cfg.vram_hold_mode = v; writeCfg(node); render(node); };
      hold.appendChild(b);
    }
    tierWrap.append(el("span", "rn-ws-note", "Hold"), hold);
  }
  const facts = el("div", "rn-run-facts");
  view.refs.facts = facts;
  top.append(gen);
  if (batchGo) top.append(batchGo);
  top.append(mode, tierWrap, facts);
  root.appendChild(top);
  const banner = el("div", "rn-ws-card rn-run-past");
  const bannerText = el("span", "tx");
  const liveBtn = el("button", "rn-ws-btn rn-run-live", "Back to live");
  liveBtn.title = "Show the run happening now.";
  liveBtn.onclick = () => { node._rnRunSheet = null; refreshAll(); };
  banner.append(bannerText, liveBtn);
  root.appendChild(banner);
  view.refs.banner = banner;
  view.refs.bannerText = bannerText;
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
  // VRAM, under the stages it belongs to: what the run needs, against the card
  const estCard = el("div", "rn-run-estcard");
  estCard.dataset.est = "1";
  estCard._rnWrite = () => writeCfg(node);   // the fold choice is saved with the config
  pipe.appendChild(estCard);
  view.refs.est = estCard;
  fetchEstimate(node, estCard);
  // the measured peak beside the estimate, so the two can be compared
  const estMeasured = el("div", "rn-ws-note rn-run-estmeasured");
  pipe.appendChild(estMeasured);
  view.refs.estMeasured = estMeasured;
  view.refs.boxes = boxes;
  root.appendChild(pipe);

  // PICTURE and MEMORY side by side
  const cols = el("div", "rn-run-cols");
  const pic = el("div", "rn-ws-card rn-run-pic");
  const picHead = el("div", "rn-run-pichead");
  picHead.appendChild(el("div", "ch", "LIVE PICTURE"));
  const fsBtn = el("button", "rn-ws-btn rn-run-fs", "\u26F6 Full screen");
  fsBtn.title = "See the picture full size. Clicking the picture does the same; "
              + "right-click it for Copy, Copy prompt, Rerun and the rest.";
  picHead.appendChild(fsBtn);
  pic.appendChild(picHead);
  const img = el("img", "rn-run-img");
  img.alt = "";
  // the Review entry of the run on show: the newest for the live run, the one
  // with its prompt id for a past one (gone once the Review has dropped it)
  const entryAt = () => {
    const hist = node.properties?.rn_run_review?.rn_review || [];
    const S = shownSheet(node);
    if (!S.past) return hist.length ? 0 : -1;
    return S.promptId ? hist.findIndex((e) => e.prompt === S.promptId) : -1;
  };
  const showBig = () => {
    const S = shownSheet(node);
    const at = entryAt();
    if (S.final && at >= 0) {
      const host = reviewHost(node);
      host._rnView = at;
      host._rnSlot = S.finalIdx;             // the frame in view here is the one shown big
      host._rnSlotFor = at;
      reviewFullscreen(host);
      return;
    }
    const src = S.final || S.frame?.src;
    if (!src) return;
    // a frame still forming: a plain full screen of it
    const ov = el("div", "rn-run-fsov");
    ov.style.cssText = "position:fixed;inset:0;z-index:10050;background:#0c0d10ee;"
      + "display:flex;align-items:center;justify-content:center;cursor:zoom-out";
    const big = el("img");
    big.src = src;
    big.style.cssText = "max-width:96vw;max-height:96vh;object-fit:contain";
    ov.appendChild(big);
    ov.addEventListener("pointerdown", () => ov.remove());
    document.body.appendChild(ov);
  };
  fsBtn.onclick = showBig;
  img.style.cursor = "zoom-in";
  img.addEventListener("click", showBig);
  img.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const S = shownSheet(node);
    const at = entryAt();
    const entry = at >= 0 ? node.properties.rn_run_review.rn_review[at] : null;
    if (!S.final || !entry) return;
    reviewMenu(reviewHost(node), entry, at, e, S.finalIdx);
  });
  const picEmpty = el("div", "rn-ws-note rn-run-picempty", "The picture appears here while it renders.");
  const picLabel = el("div", "rn-run-piclabel");
  // a batch: every finished frame as a thumbnail under the picture; click one to
  // put it up, the Review's strip in miniature
  const strip = el("div", "rn-run-strip");
  pic.append(img, picEmpty, picLabel, strip);
  view.refs.strip = strip;
  view.refs.img = img;
  view.refs.picEmpty = picEmpty;
  view.refs.picLabel = picLabel;
  const mem = el("div", "rn-ws-card rn-run-mem");
  mem.appendChild(el("div", "ch", "VRAM"));
  const chart = el("canvas", "rn-run-chart");
  chart.height = 260;
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
  const onCardHead = el("div", "rn-run-sub", "ON THE CARD NOW");
  mem.append(chart, memLine, legend, onCardHead, onCard);
  view.refs.onCardHead = onCardHead;
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
  // HISTORY: this session's finished runs, opened on the same page
  const histRow = el("div", "rn-run-histrow");
  const histBtn = el("button", "rn-ws-btn rn-run-histbtn");
  histBtn.title = "This session's finished runs. Pick one to see its sheet again.";
  histBtn.onclick = () => { node._rnRunHistOpen = !node._rnRunHistOpen; refreshAll(); };
  histRow.appendChild(histBtn);
  const histList = el("div", "rn-run-hist");
  logCard.append(histRow, histList);
  view.refs.histBtn = histBtn;
  view.refs.histList = histList;
  root.appendChild(logCard);

  body.appendChild(root);
  // one view per node: a re-render replaces the last one
  for (const v of [...views]) if (v.node === node) views.delete(v);
  views.add(view);
  refresh(view);
}

const STATE_TEXT = { waiting: "Waiting", start: "Running", progress: "Running", done: "Done",
                     skip: "Skipped", error: "Failed", notrun: "Not run", cached: "Reused" };

/** The pipeline as rows, for anywhere that wants to show it.
 *
 *  Exported so the Upscale tab can carry the same strip: two readings of the same
 *  run, computed twice, would disagree the moment one of them was forgotten.
 */
export function runStageRows(node, forceKind) {
  if (!forceKind) return stageRows(node);
  // the Upscale tab's own strip is always about an upscale, running or not: an
  // idle one was showing Encode, the passes and Decode, which that tab never does
  const was = node._rnRunKind;
  node._rnRunKind = forceKind;
  try { return stageRows(node); } finally { node._rnRunKind = was; }
}

function stageRows(node) {
  const cfg = node._rnCfg;
  const S = shownSheet(node);
  // a past run: what it reported, in order; today's settings are not its plan.
  // A paint run too: it is the paint pass, not the render the plan describes
  if (S.past || S.paint) {
    return [...S.stages].map(([key, s]) => ({ key, label: s.label || key, s, state: s.state }));
  }
  const plan = plannedStages(node, cfg);
  const rows = plan.map(([key, label]) => ({ key, label }));
  // stages the server reported that the plan did not foresee
  for (const [key, s] of RUN.stages) {
    if (!rows.some((r) => r.key === key)) {
      const at = key.startsWith("pass") ? rows.findIndex((r) => r.key === "decode")
        : key.startsWith("rig:") ? rows.findIndex((r) => r.key === "encode" || r.key.startsWith("pass"))
        : -1;
      const row = { key, label: s.label || key };
      if (at >= 0) rows.splice(at, 0, row); else rows.push(row);
    }
  }
  const wsKeys = new Set(["captions", "encode", "decode"]);
  const EXTERNAL_WHY = "External sampler renders nothing here. Choose Built-in sampler "
                      + "on the Models tab, or take the picture from your own KSampler.";
  return rows.map((r) => {
    // never reported by the server: it names why the plan itself is empty, always
    if (r.key === "external") return { ...r, s: { why: EXTERNAL_WHY }, state: "skip" };
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
  const S = shownSheet(node);
  const took = sheetSecs(S);
  // which run this is
  refs.banner.style.display = S.past ? "" : "none";
  if (S.past) {
    refs.bannerText.textContent = `Showing Run ${S.count} from ${timeOfDay(S.t0)}, `
      + `a past run. ${RUN.status === "running" ? "A run is going now." : ""}`.trim();
  }
  // facts
  const f = refs.facts;
  f.replaceChildren();
  const chip = (text, cls = "") => f.appendChild(el("span", "rn-ws-chip " + cls, text));
  chip(S.count ? `Run ${S.count}` : "No run yet");
  if (S.seed != null) chip(`Seed ${S.seed}`);
  if (S.batch > 1) chip(`Batch of ${S.batch}`);
  if (S.paint) chip("Paint run", "rn-run-paint");
  chip(S.status === "running" ? `Running ${clock(took)}`
       : S.status === "done" ? `Done in ${clock(took)}`
       : S.status === "error" ? "Failed" : S.status === "stopped" ? "Stopped" : "Idle",
       "rn-run-status " + S.status);

  // pipeline
  refs.boxes.replaceChildren();
  for (const r of stageRows(node)) {
    const b = el("div", `rn-run-box ${r.state}`);
    b.dataset.stage = r.key;
    const target = jumpForStage(r.key, node._rnCfg);
    if (target) {
      b.classList.add("link");
      b.title = "Open where this is set.";
      b.onclick = () => goTo(node, target);
    }
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
  const fr = S.frame;
  if (S.final && S.status === "done") {
    if (refs.img.src !== S.final) refs.img.src = S.final;
    refs.img.style.display = "";
    refs.picEmpty.style.display = "none";
    const n = S.finals.length;
    refs.picLabel.textContent = n > 1 ? `Finished picture ${S.finalIdx + 1} of ${n}` : "Finished picture";
    refs.strip.replaceChildren();
    refs.strip.style.display = n > 1 ? "" : "none";
    if (n > 1) {
      S.finalFiles.forEach((f, i) => {
        const t = el("img", "rn-run-thumb" + (i === S.finalIdx ? " cur" : ""));
        t.src = thumbUrl(f);
        t.alt = "";
        t.title = `Frame ${i + 1} of ${n}`;
        t.onclick = () => { S.finalIdx = i; S.final = S.finals[i]; refreshAll(); };
        refs.strip.appendChild(t);
      });
    }
  } else if (S.past) {
    refs.img.style.display = "none";
    refs.picEmpty.style.display = "";
    refs.picEmpty.textContent = "This run left no finished picture.";
    refs.picLabel.textContent = "";
    refs.strip.style.display = "none";
  } else if (fr?.src) {
    refs.strip.style.display = "none";
    if (refs.img.src !== fr.src) refs.img.src = fr.src;
    refs.img.style.display = "";
    refs.picEmpty.style.display = "none";
    const s = RUN.stages.get(RUN.running);
    const step = fr.total ? `Step ${fr.step} of ${fr.total}` : "";
    refs.picLabel.textContent = [s?.label || fr.label, step].filter(Boolean).join(" · ");
  } else {
    refs.img.style.display = "none";
    refs.picEmpty.style.display = "";
    refs.picEmpty.textContent = "The picture appears here while it renders.";
    refs.picLabel.textContent = "";
    refs.strip.style.display = "none";
  }

  // memory
  const limitGb = S.past ? S.limitGb : (node._rnCfg.vram_gb || 0);
  drawChart(refs.chart, limitGb, S);
  const last = S.vram[S.vram.length - 1];
  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  // THE RUN'S PEAK, not the card's state before it: what the last run left
  // on the card is there at the first sample and goes at the first unload, so
  // the peak is read from that unload on. With no unload it is the whole run.
  const firstUnload = (S.marks || []).find((m) => m.level === "unload");
  const from = firstUnload ? firstUnload.t : -1;
  const peak = S.vram.reduce((m, v) => (v.t >= from ? Math.max(m, v.used) : m), 0)
            || S.vram.reduce((m, v) => Math.max(m, v.used), 0);
  const tgt = limitGb ? limitGb - HEADROOM_GB : 0;
  if (refs.estMeasured) {
    refs.estMeasured.textContent = peak
      ? `Measured peak ${S.past ? "of that run" : "this run"}: ${gb(peak)}.`
        + (firstUnload ? " Read from the first unload on, so what the run before left on the card is not counted." : "")
      : "";
  }
  refs.onCardHead.textContent = S.past ? "ON THE CARD AT THE END" : "ON THE CARD NOW";
  refs.memLine.textContent = S.total
    ? `${last ? gb(last.used) : "-"} of ${gb(S.total)} in use${peak ? ` · peak ${gb(peak)}` : ""}`
      + (tgt ? ` · limit ${tgt} GB${peak > tgt * 1024 ? `, went over by ${gb(peak - tgt * 1024)}` : ""}` : "")
    : "Memory figures arrive with the first run.";
  refs.onCard.replaceChildren();
  if (!S.models.length) {
    refs.onCard.appendChild(el("div", "rn-ws-note", "Nothing ComfyUI tracks is loaded."));
  }
  for (const m of S.models) {
    const row = el("div", "rn-run-model");
    row.appendChild(el("span", "n", m.name));
    const bar = el("span", "bar");
    const fill = el("i");
    fill.style.width = `${S.total ? Math.round(Math.min(1, m.mb / S.total) * 100) : 0}%`;
    bar.appendChild(fill);
    row.append(bar, el("span", "mb", gb(m.mb)));
    refs.onCard.appendChild(row);
  }

  // log
  const atBottom = refs.log.scrollHeight - refs.log.scrollTop - refs.log.clientHeight < 30;
  refs.log.replaceChildren();
  if (!S.log.length) refs.log.appendChild(el("div", "rn-ws-note", "Press Generate to start a run."));
  for (const l of S.log) {
    const row = el("div", `rn-run-line ${l.level}`);
    const tx = el("span", "tx", l.text);
    // A LINE NAMING A PACK THAT IS NOT HERE says where to find it. The link only
    // opens the page; installing stays with ComfyUI Manager.
    const miss = EXTRA_PACKS.find((p) => l.text.includes(p.name)
      && (/not installed/.test(l.text) || packInstalled(p) === false));
    if (miss) {
      const a = document.createElement("a");
      a.href = packLink(miss);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "rn-run-getlink";
      a.textContent = "Where to get it";
      a.title = `${miss.name}: ${packLink(miss)}`;
      a.onclick = (e) => e.stopPropagation();   // the row's own jump stays put
      tx.append(el("span", "", " "), a);
    }
    row.append(el("span", "tm", clock(l.t)), el("i", "dot"), tx);
    const target = jumpForLine(l.text, node._rnCfg);
    if (target) {
      row.classList.add("link");
      row.title = "Open where this is set.";
      row.onclick = () => goTo(node, target);
    }
    refs.log.appendChild(row);
  }
  if (atBottom) refs.log.scrollTop = refs.log.scrollHeight;

  // history
  const open = !!node._rnRunHistOpen && HISTORY.length > 0;
  refs.histBtn.textContent = HISTORY.length
    ? `${open ? "\u25BE" : "\u25B8"} History (${HISTORY.length})` : "History: no finished runs yet";
  refs.histBtn.disabled = !HISTORY.length;
  refs.histList.replaceChildren();
  refs.histList.style.display = open ? "" : "none";
  if (open) {
    const item = (label, meta, cur, onPick, cls = "") => {
      const b = el("button", "rn-run-histitem" + (cur ? " cur" : "") + (cls ? " " + cls : ""));
      b.append(el("span", "n", label), el("span", "m", meta));
      b.onclick = onPick;
      refs.histList.appendChild(b);
    };
    item("Live", RUN.status === "running" ? `Running ${clock(secs())}` : "The run now",
         !S.past, () => { node._rnRunSheet = null; refreshAll(); });
    for (const H of HISTORY) {
      const how = H.status === "done" ? `Done in ${clock(sheetSecs(H))}`
        : H.status === "stopped" ? "Stopped" : "Failed";
      const bits = [timeOfDay(H.t0), how, H.paint ? "paint" : "",
                    H.batch > 1 ? `batch of ${H.batch}` : "",
                    H.seed != null ? `seed ${H.seed}` : ""].filter(Boolean);
      item(`Run ${H.count}`, bits.join(" · "), S === H,
           () => { node._rnRunSheet = H; refreshAll(); }, H.status);
    }
  }
}

// What each VRAM limit is sized for. The limit itself only holds the expensive dials
// down; these are the cards it suits, drawn so a run that goes past one shows it.


function niceStep(maxGb) {
  for (const s of [1, 2, 4, 8, 16, 32]) if (maxGb / s <= 5) return s;
  return 64;
}

function drawChart(cv, cardGb, S = RUN) {
  const ctx = cv.getContext?.("2d");
  if (!ctx) return;
  const w = Math.max(240, Math.round(cv.clientWidth || cv.parentNode?.clientWidth || 360));
  const h = cv.height;
  if (cv.width !== w) cv.width = w;
  ctx.clearRect(0, 0, w, h);
  const total = S.total || 1;
  const pts = S.vram;
  const tMax = Math.max(10, sheetSecs(S), pts.length ? pts[pts.length - 1].t : 0);
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
  txt(`Card ${gb(total).toFixed(1)} GB`, L + 4, y(total) + 11, "left");
  // the VRAM limit's target card, when one is set
  const target = cardGb ? cardGb - HEADROOM_GB : 0;
  if (target && target * 1024 < total) {
    const ty = y(target * 1024);
    ctx.strokeStyle = "#e0a84a";
    ctx.beginPath();
    ctx.moveTo(L, ty);
    ctx.lineTo(w - Rm, ty);
    ctx.stroke();
    txt(`${cardGb} GB card: limit ${target} GB`, L + 4, ty + 11, "left", "#e0a84a");
  }
  ctx.setLineDash?.([]);
  // loads and unloads
  for (const m of S.marks) {
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
    const py = y(peak.used);
    // above the dot unless that would sit on the card's line, then below it
    const labelY = py - 6 < y(total) + 4 ? py + 14 : py - 6;
    txt(`Peak ${gb(peak.used).toFixed(1)}`, px, labelY,
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
/* the folder batch is the blue the batch buttons use everywhere else, so the red
   Generate beside it stays the one that renders once */
.rn-run-go-batch{background:#2b3a4d;border-color:#3d5570;color:#cfe6ff}
.rn-run-go-batch:hover{background:#365072}
.rn-run-tier{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rn-run-estcard{margin-top:8px;padding-top:8px;border-top:1px solid #2a2e34;display:flex;flex-direction:column;gap:4px}
.rn-run-estbig{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rn-run-estbig .num{font-size:15px;font-weight:700;color:#e8ecf1}
.rn-run-estbig .lbl{font-size:11px;color:#8f97a3}
.rn-run-estchip{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:9px;border:1px solid}
.rn-run-estfold{background:#111316;border:1px solid #33373d;border-radius:5px;color:#9aa0a8;cursor:pointer;font-size:10.5px;padding:2px 8px}
.rn-run-estfold:hover{border-color:#b8283c;color:#fff}
.rn-run-estchip.green{background:#15301f;border-color:#2b6b41;color:#a7f3c0}
.rn-run-estchip.amber{background:#3a2a10;border-color:#8a6a1e;color:#ffd48a}
.rn-run-estchip.red{background:#3a1418;border-color:#b8283c;color:#ffb3bd}
.rn-run-estbar{position:relative;height:7px;border-radius:4px;background:#111316;border:1px solid #2a2e34;overflow:visible}
.rn-run-estbar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:#3c9a5f}
.rn-run-estbar.amber .fill{background:#c9922e}
.rn-run-estbar.red .fill{background:#b8283c}
.rn-run-estbar .mark{position:absolute;top:-4px;bottom:-4px;width:2px;background:#e8ecf1;border-radius:1px}
.rn-run-estscale{display:flex;justify-content:space-between;font-size:10px;color:#7f8792}
.rn-run-estparts{display:flex;gap:5px;flex-wrap:wrap}
.rn-run-estparts .rn-ws-chip{font-size:10.5px;padding:1px 7px}
.rn-run-estcard .rn-ws-note{font-size:10.5px}
.rn-run-estmeasured{font-size:10.5px;margin-top:2px}
.rn-run-facts{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.rn-run-status.running{border-color:#4a8fe0;color:#cfe0f5}
.rn-run-status.done{border-color:#2e7d4f;color:#9fe0b4}
.rn-run-status.error,.rn-run-status.stopped{border-color:#b8283c;color:#f3b0ba}
.rn-run-boxes{display:flex;gap:8px;flex-wrap:wrap}
.rn-run-box{flex:1 1 100px;min-width:96px;background:#15171b;border:1px solid #33373d;
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
.rn-run-pichead{display:flex;align-items:center;gap:8px}
.rn-run-pichead .ch{flex:1}
.rn-run-fs{width:auto;padding:0 10px;font-size:11.5px}
.rn-run-strip{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.rn-run-thumb{width:72px;height:72px;object-fit:cover;border-radius:5px;cursor:pointer;
  border:2px solid #2a2e35;background:#0f1114}
.rn-run-thumb:hover{border-color:#8fa8c8}
.rn-run-thumb.cur{border-color:#b8283c}
.rn-run-box.link,.rn-run-line.link{cursor:pointer}
.rn-run-box.link:hover{border-color:#8fa8c8}
.rn-run-line.link:hover .tx{color:#fff;text-decoration:underline}
.rn-run-getlink{color:#8fc0ff;white-space:nowrap}
.rn-run-piclabel{font-size:12px;color:#cfe0f5;text-align:center}
.rn-run-chart{width:100%;height:260px;background:#0f1114;border-radius:6px;display:block}
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
.rn-run-taps .rn-ws-row{gap:8px;align-items:center}
.rn-run-tapname{min-width:90px;font-weight:600;color:#c8ccd2}
.rn-run-tappoints .rn-ws-segb:disabled{opacity:.45;cursor:default}
.rn-run-model .mb{color:#9aa0a8;font-variant-numeric:tabular-nums}
.rn-run-log{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:3px}
.rn-run-line{display:grid;grid-template-columns:44px 10px 1fr;gap:8px;align-items:center;
  font-size:12.5px;color:#c8ccd2}
.rn-run-line .tm{color:#7b828c;font-variant-numeric:tabular-nums}
.rn-ws-chip.rn-run-paint{border-color:#b8283c;color:#f3b0ba}
.rn-run-past{flex-direction:row;align-items:center;gap:10px;border-color:#8fa8c8;
  background:#1a2230}
.rn-run-past .tx{flex:1;color:#cdd9ea}
.rn-run-live{width:auto;padding:0 12px}
.rn-run-histrow{display:flex;margin-top:8px}
.rn-run-histbtn{width:auto;padding:0 12px}
.rn-run-hist{display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:220px;
  overflow-y:auto}
.rn-run-histitem{display:flex;gap:12px;align-items:center;text-align:left;cursor:pointer;
  background:#15171b;border:1px solid #2a2e35;border-radius:6px;padding:5px 10px;color:#d6d9de}
.rn-run-histitem:hover{border-color:#8fa8c8}
.rn-run-histitem.cur{border-color:#b8283c;background:#221519}
.rn-run-histitem .n{font-weight:600;min-width:64px}
.rn-run-histitem .m{color:#8a919b;font-variant-numeric:tabular-nums}
.rn-run-histitem.error .m,.rn-run-histitem.stopped .m{color:#e0a84a}
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
