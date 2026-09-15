import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { POST_FX, snapStep } from "./rednode_ws_tables.js";
import { postWrite, postRender, readCfg, writeCfg, render } from "./rednode_workspace.js";

// The Post tab: the grading chain's whole panel.
//
// It lives apart from rednode_workspace.js because the Workspace was carrying
// eleven tabs in one file, and because the standalone RedNode Post FX node hosts
// this exact panel: one implementation, two homes. postWrite / postRender are the
// two hooks that let it not care which node it is living on.

// the saved looks and the last graded frame, both fetched from the server
let postPresets = [];
// the .cube files in models/luts, fetched once per page for the LUT card's picker;
// Refresh on the card asks again after files are dropped in
let postLuts = null;
async function fetchLuts(node) {
  try {
    const res = await api.fetchApi("/rednode/luts");
    const d = await res.json();
    postLuts = Array.isArray(d.files) ? d.files : [];
  } catch (e) {
    postLuts = [];
  }
  if (node) postRender(node);
}
let postLastThumb = "";
let postLastRolls = {};

export async function refreshPostPresets() {
  try {
    const res = await api.fetchApi("/rednode/post_presets");
    const d = await res.json();
    postPresets = Array.isArray(d.presets) ? d.presets : [];
    postLastThumb = d.last_thumb || "";
    postLastRolls = d.last_rolls && typeof d.last_rolls === "object" ? d.last_rolls : {};
  } catch (e) { /* the panel simply shows no looks */ }
}

async function postPresetAction(node, body) {
  const res = await api.fetchApi("/rednode/post_presets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  postPresets = d.presets || [];
  postLastThumb = d.last_thumb || postLastThumb;
  postRender(node);
}

function openLookMenu(node, preset, applyLook, ev) {
  document.querySelector(".rn-ws-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = preset.name;
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      m.remove();
      try {
        await fn();
      } catch (e) {
        console.error(`[RedNode Workspace] ${label} failed:`, e);
        alert(`${label} failed: ${e.message}`);
      }
    };
    return b;
  };
  const sep = document.createElement("div");
  sep.className = "sep";
  m.append(
    note,
    mk("Apply this look", () => applyLook()),
    mk("Overwrite with the settings on this tab", () =>
      postPresetAction(node, { action: "save", name: preset.name,
                               config: node._rnCfg.post })),
    mk("Rename…", async () => {
      const name = prompt("Rename this look", preset.name);
      if (!name || name === preset.name) return;
      // save under the new name carrying the old thumbnail, then drop the old one
      await postPresetAction(node, { action: "save", name,
                                     config: (await (await api.fetchApi(
                                       `/rednode/post_presets?name=${encodeURIComponent(preset.name)}`
                                     )).json()).config,
                                     thumb: preset.thumb });
      await postPresetAction(node, { action: "delete", name: preset.name });
    }),
    sep,
    mk(`Delete "${preset.name}"`, () =>
      postPresetAction(node, { action: "delete", name: preset.name })),
  );
  document.body.appendChild(m);
  const mw = 230, mh = m.getBoundingClientRect().height || 180;
  m.style.left = Math.max(6, Math.min(ev.clientX || 0,
    (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY || 0,
    (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// the card being dragged, kept here because the DOM stub in the tests has no
// dataTransfer and a real browser drop event may not carry it either
let dragFx = null;

export function cardOrder(cfg) {
  const known = POST_FX.map((fx) => fx.id);
  const saved = (cfg.post_ui?.order || []).filter((id) => known.includes(id));
  return [...saved, ...known.filter((id) => !saved.includes(id))];
}

// THE CHAIN: the effects as an ordered list of INSTANCES. One entry per run of
// an effect, in run order, each with its own dials, switch and Limit, so the
// same effect can run twice (a sharpen on the subject early, another on the
// whole frame at the end) and the order is yours. A config saved before the
// chain existed gets the camera order with one instance of each effect,
// carrying the block it had, so nothing renders differently.
export function chainBand(fxId) {
  for (const [label, ids] of FX_GROUPS) if (ids.includes(fxId)) return label;
  return "MORE";
}

function normItem(item, fx) {
  const b = item && typeof item === "object" ? item : {};
  b.fx = fx.id;
  b.on = !!b.on;
  b.rand = b.rand && typeof b.rand === "object" ? b.rand : {};
  if (!["off", "subject", "background"].includes(b.limit)) b.limit = "off";
  for (const c of fx.controls) {
    if (c.head || c.button) continue;
    if (c.choice) { if (typeof b[c.key] !== "string") b[c.key] = c.def; }
    else if (typeof b[c.key] !== "number") b[c.key] = c.def;
  }
  return b;
}

export function normalisePostChain(d) {
  if (!d || !d.post || typeof d.post !== "object") return [];
  const byId = Object.fromEntries(POST_FX.map((fx) => [fx.id, fx]));
  const effects = POST_FX.filter((fx) => !fx.settings);
  let chain = Array.isArray(d.post.chain) ? d.post.chain : null;
  if (!chain || !chain.length) {
    chain = effects.map((fx) => normItem({ ...(d.post[fx.id] || {}) }, fx));
    for (const b of chain) b.id = b.fx;
  } else {
    chain = chain.filter((it) => it && typeof it === "object" && byId[it.fx] && !byId[it.fx].settings)
                 .map((it) => normItem(it, byId[it.fx]));
    const seen = new Set();
    for (const b of chain) {
      const base = String(b.id || b.fx);
      let id = base, n = 2;
      while (seen.has(id)) id = `${base}#${n++}`;
      seen.add(id);
      b.id = id;
    }
    if (!chain.length) {
      chain = effects.map((fx) => normItem({ ...(d.post[fx.id] || {}) }, fx));
      for (const b of chain) b.id = b.fx;
    }
  }
  d.post.chain = chain;
  mirrorChain(d);
  return chain;
}

// the per-effect blocks mirror the FIRST instance of each effect, for every
// reader that asks "is bloom on" without walking the chain (the Looks strip,
// the server's older readers); an effect with no instance reads as off
export function mirrorChain(d) {
  if (!d || !d.post || !Array.isArray(d.post.chain)) return;
  const first = {};
  for (const b of d.post.chain) if (!first[b.fx]) first[b.fx] = b;
  for (const fx of POST_FX) {
    if (fx.settings) continue;
    const src = first[fx.id];
    if (src) {
      const copy = { ...src };
      delete copy.fx; delete copy.id;
      d.post[fx.id] = copy;
    } else if (d.post[fx.id]) {
      d.post[fx.id].on = false;
    }
  }
}

// a fresh instance of an effect: a copy of `from` when given (Another), else the
// card's defaults; its id is unique in the chain
export function newChainItem(d, fxId, from) {
  const fx = POST_FX.find((x) => x.id === fxId);
  if (!fx || fx.settings) return null;
  const b = normItem(from ? JSON.parse(JSON.stringify(from)) : {}, fx);
  const seen = new Set((d.post.chain || []).map((x) => x.id));
  let id = fxId, n = 2;
  while (seen.has(id)) id = `${fxId}#${n++}`;
  b.id = id;
  return b;
}

// the camera order: every instance sorted by its effect's place in the shipped
// chain, instances of one effect keeping their relative order
export function cameraOrder(d) {
  const rank = Object.fromEntries(POST_FX.map((fx, i) => [fx.id, i]));
  d.post.chain = (d.post.chain || []).map((b, i) => [b, i])
    .sort((x, y) => (rank[x[0].fx] - rank[y[0].fx]) || (x[1] - y[1]))
    .map(([b]) => b);
}

export function fxStep(cfg, c) {
  const p = cfg.post_ui?.precision;
  if (p === undefined || p === "default" || c.step >= 1) return c.step;
  return Math.pow(10, -parseInt(p, 10));
}

export function openPostCog(node, anchor) {
  document.querySelector(".rn-ws-menu")?.remove();
  const cfg = node._rnCfg;
  const m = document.createElement("div");
  m.className = "rn-ws-menu";
  m.style.minWidth = "260px";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = "Post tab settings";
  m.appendChild(note);

  const prow = document.createElement("div");
  prow.className = "rn-ws-row";
  prow.style.padding = "4px 9px";
  const plab = document.createElement("span");
  plab.className = "rn-ws-note";
  plab.textContent = "Slider steps";
  const psel = document.createElement("select");
  psel.className = "rn-ws-res";
  for (const [v, label] of [["default", "Each control's own"], ["0", "Whole numbers"],
                            ["1", "0.1 steps"], ["2", "0.01 steps"],
                            ["3", "0.001 steps"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = String(cfg.post_ui.precision) === v;
    psel.appendChild(o);
  }
  psel.title = "How far one nudge of a slider moves, and how many decimals the "
             + "value keeps. Controls that already step in whole numbers (seed, "
             + "blend if, radius) keep their own step whatever this says.";
  psel.onchange = () => {
    cfg.post_ui.precision = psel.value;
    postWrite(node);
    postRender(node);
  };
  prow.append(plab, psel);
  m.appendChild(prow);

  const hrow = document.createElement("div");
  hrow.className = "rn-ws-row";
  hrow.style.padding = "4px 9px";
  const hlab = document.createElement("span");
  hlab.className = "rn-ws-note";
  hlab.textContent = "Explanations";
  const hb = document.createElement("button");
  hb.className = "rn-ws-on" + (cfg.post_ui.hints ? " on" : "");
  hb.textContent = cfg.post_ui.hints ? "ON" : "OFF";
  hb.title = "The paragraph under each card's switch. Off keeps the cards tight "
           + "once you know what they do; every tooltip stays either way.";
  hb.onclick = () => {
    cfg.post_ui.hints = !cfg.post_ui.hints;
    postWrite(node);
    postRender(node);
  };
  hrow.append(hlab, hb);
  m.appendChild(hrow);

  const foot = document.createElement("div");
  foot.className = "note";
  foot.style.whiteSpace = "normal";
  foot.textContent = "The list runs top to bottom in grading order: repair, the air, the "
                   + "lens, the film.";
  m.appendChild(foot);

  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect?.() || { left: 40, bottom: 40 };
  m.style.left = Math.max(6, Math.min(r.left, (window.innerWidth || 1920) - 280)) + "px";
  m.style.top = Math.max(6, r.bottom + 4) + "px";
  const close = (e) => {
    if (!m.contains(e.target) && e.target !== anchor) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

export function looksSection(node, body) {
  const cfg = node._rnCfg;
  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-looks";
  const head = document.createElement("div");
  head.className = "head";
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = "▾";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = "LOOKS" + (postPresets.length ? `: ${postPresets.length} saved` : "");
  head.append(arr, ttl);
  sect.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "rn-ws-lookgrid";

  // the last graded frame, so you can see what the dials are actually doing
  const live = document.createElement("div");
  live.className = "rn-ws-look live";
  live.style.width = live.style.height = cfg.look_thumb + "px";
  live.title = postLastThumb
    ? "The last image this chain graded. Save it as a look to keep these settings "
      + "with that picture."
    : "Queue a run with a RedNode Post Process node wired up and the result appears "
      + "here.";
  if (postLastThumb) {
    const im = document.createElement("img");
    im.src = postLastThumb;
    live.appendChild(im);
  } else {
    const ph = document.createElement("span");
    ph.className = "ph";
    ph.textContent = "No run yet";
    live.appendChild(ph);
  }
  const cap = document.createElement("span");
  cap.className = "cap";
  cap.textContent = "Current";
  live.appendChild(cap);
  grid.appendChild(live);

  for (const preset of postPresets) {
    const cell = document.createElement("div");
    cell.className = "rn-ws-look";
    cell.style.width = cell.style.height = cfg.look_thumb + "px";
    cell.title = `Apply the "${preset.name}" look. Right-click for rename, `
               + "overwrite and delete.";
    if (preset.thumb) {
      const im = document.createElement("img");
      im.src = preset.thumb;
      cell.appendChild(im);
    } else {
      const ph = document.createElement("span");
      ph.className = "ph";
      ph.textContent = "No shot";
      cell.appendChild(ph);
    }
    const nm = document.createElement("span");
    nm.className = "cap";
    nm.textContent = preset.name;
    cell.appendChild(nm);
    const applyLook = async () => {
      const res = await api.fetchApi(
        `/rednode/post_presets?name=${encodeURIComponent(preset.name)}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      cfg.post = d.config || {};
      postWrite(node);
      node._rnCfg = readCfg(node);                  // re-normalise the applied look
      postRender(node);
    };
    cell.onclick = () => applyLook().catch((e) => {
      console.error("[RedNode Workspace] could not apply the look:", e);
      alert(`Could not apply that look: ${e.message}`);
    });
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLookMenu(node, preset, applyLook, e);
    });
    grid.appendChild(cell);
  }
  sect.appendChild(grid);

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const tl = document.createElement("span");
  tl.className = "rn-ws-note";
  tl.textContent = "Size";
  const tr = document.createElement("input");
  tr.type = "range";
  tr.min = 48; tr.max = 180; tr.step = 4;
  tr.value = cfg.look_thumb;
  tr.style.cssText = "width:90px;accent-color:#22a39f";
  tr.title = "How big the look thumbnails are drawn.";
  tr.addEventListener("input", () => {
    cfg.look_thumb = parseInt(tr.value, 10);
    for (const el of grid.children) {
      el.style.width = el.style.height = cfg.look_thumb + "px";
    }
  });
  tr.addEventListener("change", () => postWrite(node));
  const save = document.createElement("button");
  save.className = "rn-ws-btn";
  save.style.width = "auto";
  save.style.padding = "0 10px";
  save.textContent = "Save this look";
  save.title = "Stores every setting on this tab under a name, with the last graded "
             + "frame as its thumbnail, so you can recognise the look by eye later.";
  save.onclick = async () => {
    const name = prompt("Name this look");
    if (!name) return;
    try {
      const res = await api.fetchApi("/rednode/post_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, config: cfg.post }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      postPresets = d.presets || [];
      postLastThumb = d.last_thumb || postLastThumb;
      postRender(node);
    } catch (e) {
      console.error("[RedNode Workspace] save failed:", e);
      alert(`Could not save that look: ${e.message}`);
    }
  };
  row.append(tl, tr, save);
  sect.appendChild(row);
  body.appendChild(sect);
}

// The chain list on the left, one editor on the right. The list shows every
// effect in the order the chain runs, under the four stages, with an eye per row
// to switch it on; the editor shows the selected effect's controls, big enough to
// read. One effect open at a time is the point: the old grid of every card at
// once was a wall of sliders. The two settings cards sit at the foot of the list.
const FX_GROUPS = [
  ["GRADE", ["denoise", "color", "match", "lut", "clarity", "sharpen"]],
  ["LIGHT", ["relight"]],
  ["AIR", ["haze"]],
  ["LENS", ["distortion", "dof", "aberration", "bloom", "light_wrap", "diffusion", "vignette"]],
  ["FILM", ["halation", "rolloff", "grain"]],
  ["SETTINGS", ["depth", "mask"]],
];

function fxGroups() {
  const known = new Set(FX_GROUPS.flatMap(([, ids]) => ids));
  const extra = POST_FX.map((fx) => fx.id).filter((id) => !known.has(id));
  const groups = FX_GROUPS.map(([label, ids]) => [label, ids.filter((id) => POST_FX.some((fx) => fx.id === id))]);
  if (extra.length) groups.splice(groups.length - 1, 0, ["MORE", extra]);
  return groups;
}

// one control of the selected effect: a choice, a random range, or a slider;
// right-click on a slider flips it to a range and back
function renderControl(node, cfg, fx, b, c) {
  const cell = document.createElement("div");
  cell.className = "rn-ws-fxc";
  const isRand = !c.choice && Array.isArray(b.rand[c.key]);
  const step = c.choice ? c.step : fxStep(cfg, c);
  const lab = document.createElement("span");
  lab.className = "lab" + (isRand ? " rnd" : "");
  lab.textContent = c.label;
  lab.title = c.hint + (c.choice ? "" : isRand
    ? "\n\nRandom range is ON: a value is drawn between the handles every "
      + "queue. Right-click to go back to one fixed value."
    : "\n\nRight-click to make this a random range.");
  cell.appendChild(lab);
  if (!c.choice) {
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isRand) delete b.rand[c.key];
      else {
        const span = (c.max - c.min) * 0.15;
        b.rand[c.key] = [
          snapStep(b[c.key] - span, c.min, c.max, step),
          snapStep(b[c.key] + span, c.min, c.max, step),
        ];
      }
      postWrite(node);
      postRender(node);
    });
  }
  const line = document.createElement("div");
  line.className = "line";
  if (c.choice) {
    const sel = document.createElement("select");
    sel.className = "rn-ws-res";
    // a dynamic choice lists a model folder: the LUT card's .cube files
    let opts = c.choice;
    if (c.dynamic === "luts") {
      if (postLuts === null) { postLuts = []; fetchLuts(node); }
      opts = ["", ...postLuts];
      if (b[c.key] && !opts.includes(b[c.key])) opts.push(b[c.key]);
    }
    for (const opt of opts) {
      const o = document.createElement("option");
      o.value = opt;
      // a stored key can read as words when the table says how
      o.textContent = c.dynamic ? (opt || "(none)")
        : (c.labels?.[opt] ?? (opt.charAt(0).toUpperCase() + opt.slice(1)));
      o.selected = b[c.key] === opt;
      sel.appendChild(o);
    }
    sel.title = c.hint;
    sel.onchange = () => { b[c.key] = sel.value; postWrite(node); postRender(node); };
    line.appendChild(sel);
    if (c.dynamic === "luts") {
      const rf = document.createElement("button");
      rf.className = "rn-ws-btn";
      rf.textContent = "Refresh";
      rf.title = "Re-read models/luts.";
      rf.onclick = () => { postLuts = null; fetchLuts(node); };
      line.appendChild(rf);
    }
  } else if (isRand) {
    // two handles over one band, the same idea as the LoRA stack's random
    // strength: the run draws between them, the tick shows what it drew
    const box = document.createElement("div");
    box.className = "rn-ws-rng";
    const track = document.createElement("div");
    track.className = "track";
    const fil = document.createElement("div");
    fil.className = "fil";
    box.append(track, fil);
    const mk = (v) => {
      const r = document.createElement("input");
      r.type = "range";
      r.min = c.min; r.max = c.max; r.step = step;
      r.value = v;
      return r;
    };
    const rLo = mk(b.rand[c.key][0]);
    const rHi = mk(b.rand[c.key][1]);
    const val = document.createElement("input");
    val.className = "val rng";
    val.readOnly = true;
    const pos = (v) => ((v - c.min) / Math.max(1e-9, c.max - c.min)) * 100;
    const rolled = postLastRolls?.[b.id || fx.id]?.[c.key];
    const paint = () => {
      const a = parseFloat(rLo.value), z = parseFloat(rHi.value);
      fil.style.left = pos(a) + "%";
      fil.style.width = Math.max(0.5, pos(z) - pos(a)) + "%";
      val.value = a + " ~ " + z;
      val.title = "Random range " + a + " to " + z + ". A value is drawn every queue.";
    };
    rLo.addEventListener("input", () => {
      if (parseFloat(rLo.value) > parseFloat(rHi.value)) rLo.value = rHi.value;
      b.rand[c.key][0] = snapStep(rLo.value, c.min, c.max, step);
      paint();
    });
    rHi.addEventListener("input", () => {
      if (parseFloat(rHi.value) < parseFloat(rLo.value)) rHi.value = rLo.value;
      b.rand[c.key][1] = snapStep(rHi.value, c.min, c.max, step);
      paint();
    });
    for (const r of [rLo, rHi]) r.addEventListener("change", () => postWrite(node));
    box.append(rLo, rHi);
    paint();
    if (rolled !== undefined) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = pos(rolled) + "%";
      tick.title = "Last roll: " + rolled;
      box.appendChild(tick);
      val.value = String(rolled);
      val.className = "val rolled";
      val.title = "Rolled " + rolled + " last run (range "
                + b.rand[c.key][0] + " to " + b.rand[c.key][1] + ").";
    }
    line.append(box, val);
  } else {
    const range = document.createElement("input");
    range.type = "range";
    range.min = c.min; range.max = c.max; range.step = step;
    range.value = b[c.key];
    range.title = c.hint;
    const val = document.createElement("input");
    val.className = "val";
    val.value = String(b[c.key]);
    val.title = c.hint;
    const apply = (v) => {
      const num = snapStep(v, c.min, c.max, step);
      if (num === null) return;
      b[c.key] = num;
      range.value = num; val.value = String(num);
      postWrite(node);
    };
    range.addEventListener("input", () => apply(range.value));
    val.addEventListener("change", () => apply(val.value));
    line.append(range, val);
  }
  cell.appendChild(line);
  return cell;
}

export function postBody(node, body) {
  const cfg = node._rnCfg;
  const byId = Object.fromEntries(POST_FX.map((fx) => [fx.id, fx]));
  const chain = normalisePostChain(cfg);
  const itemById = Object.fromEntries(chain.map((b) => [b.id, b]));
  // the selection is an INSTANCE id (or a settings card's id); open on the first
  // instance that is on, else the first instance
  const selOk = (id) => !!itemById[id] || (byId[id] && byId[id].settings);
  if (!node._rnFxSel || !selOk(node._rnFxSel)) {
    const on = chain.find((b) => b.on);
    node._rnFxSel = (on || chain[0] || POST_FX[0]).id;
  }
  const moveItem = (id, to) => {
    const from = chain.findIndex((b) => b.id === id);
    if (from < 0) return;
    const [b] = chain.splice(from, 1);
    chain.splice(Math.max(0, Math.min(chain.length, to)), 0, b);
    postWrite(node);
    postRender(node);
  };
  let dragId = null;
  const dragHandlers = (el, id) => {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => { dragId = id; e.dataTransfer?.setData?.("text/plain", id); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragId || dragId === id) return;
      const to = chain.findIndex((b) => b.id === id);
      const from = chain.findIndex((b) => b.id === dragId);
      moveItem(dragId, from < to ? to : to);
      dragId = null;
    });
  };
  const bar = document.createElement("div");
  bar.className = "rn-ws-row";
  const cog = document.createElement("button");
  cog.className = "rn-ws-cog";
  cog.textContent = "⚙";
  cog.title = "Settings for this tab: slider precision and the explanations.";
  cog.onclick = () => openPostCog(node, cog);
  bar.appendChild(cog);
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  note.textContent = "The eye switches an effect on; click its name to edit it. The list "
                   + "is the order the chain runs in.";
  bar.appendChild(note);
  body.appendChild(bar);
  looksSection(node, body);

  // THE ORDER MAP: the chain as numbered chips, left to right in run order.
  // Drag a chip onto another to move it there; click one to edit it. The list
  // below is the same order with the dials; this is the order at a glance.
  const mapBar = document.createElement("div");
  mapBar.className = "rn-ws-fxmapbar";
  const mapLab = document.createElement("span");
  mapLab.className = "rn-ws-note";
  mapLab.textContent = "Run order";
  mapLab.title = "The chain runs left to right. Drag a chip onto another to move it; "
               + "the arrows on a row do the same one step at a time.";
  const reset = document.createElement("button");
  reset.className = "rn-ws-btn";
  reset.style.cssText = "width:auto;padding:0 10px;font-size:11px";
  reset.textContent = "Camera order";
  reset.title = "Put every effect back in the order light meets a camera: repair, "
              + "grade, light, air, lens, film. Instances stay; only the order moves.";
  reset.onclick = () => { cameraOrder(cfg); postWrite(node); postRender(node); };
  mapBar.append(mapLab, reset);
  body.appendChild(mapBar);
  const map = document.createElement("div");
  map.className = "rn-ws-fxmap";
  const countOf = {};
  for (const b of chain) countOf[b.fx] = (countOf[b.fx] || 0) + 1;
  const nthOf = {};
  const instanceLabel = (b) => {
    nthOf[b.fx] = (nthOf[b.fx] || 0) + 1;
    return byId[b.fx].label + (countOf[b.fx] > 1 ? " " + nthOf[b.fx] : "");
  };
  const labels = {};
  for (const b of chain) labels[b.id] = instanceLabel(b);
  chain.forEach((b, i) => {
    const chip = document.createElement("button");
    chip.className = "rn-ws-fxchip" + (b.on ? " on" : "") + (node._rnFxSel === b.id ? " sel" : "");
    chip.textContent = (i + 1) + " " + labels[b.id];
    chip.title = labels[b.id] + (b.on ? ", on" : ", off") + ". Click to edit; drag onto "
               + "another chip to move it there.";
    chip.onclick = () => { node._rnFxSel = b.id; postRender(node); };
    dragHandlers(chip, b.id);
    map.appendChild(chip);
  });
  body.appendChild(map);

  const split = document.createElement("div");
  split.className = "rn-ws-fxsplit";
  const list = document.createElement("div");
  list.className = "rn-ws-fxlist";
  let lastBand = null;
  const addRow = (b, fx, i) => {
    const row = document.createElement("div");
    row.className = "rn-ws-fxrow" + (node._rnFxSel === b.id ? " sel" : "")
                  + (b.on && !fx.settings ? " on" : "");
    if (fx.settings) {
      const gear = document.createElement("span");
      gear.className = "rn-ws-eye gear";
      gear.textContent = "⚙";
      gear.title = "Settings, not an effect: it never runs on its own.";
      row.appendChild(gear);
    } else {
      const num = document.createElement("span");
      num.className = "rn-ws-fxnum";
      num.textContent = String(i + 1);
      row.appendChild(num);
      const eye = document.createElement("button");
      eye.className = "rn-ws-eye" + (b.on ? " on" : "");
      eye.textContent = b.on ? "●" : "○";
      eye.title = (b.on ? "On. Click to switch off." : "Off. Click to switch on.")
                + "\n\n" + fx.blurb;
      eye.onclick = (e) => {
        e.stopPropagation();
        b.on = !b.on;
        postWrite(node);
        postRender(node);
      };
      row.appendChild(eye);
    }
    const nm = document.createElement("span");
    nm.className = "rn-ws-fxname";
    nm.textContent = fx.settings ? fx.label : labels[b.id];
    row.appendChild(nm);
    if (!fx.settings && b.limit && b.limit !== "off") {
      const pill = document.createElement("span");
      pill.className = "rn-ws-fxlimitpill";
      pill.textContent = b.limit;
      pill.title = "Limited to the " + b.limit + ".";
      row.appendChild(pill);
    }
    if (!fx.settings) {
      const mv = document.createElement("span");
      mv.className = "rn-ws-fxmove";
      for (const [txt, delta, tip] of [["▲", -1, "Run this one step earlier."],
                                       ["▼", 1, "Run this one step later."]]) {
        const mb = document.createElement("button");
        mb.textContent = txt;
        mb.title = tip;
        mb.disabled = (delta < 0 && i === 0) || (delta > 0 && i === chain.length - 1);
        mb.onclick = (e) => { e.stopPropagation(); moveItem(b.id, i + delta); };
        mv.appendChild(mb);
      }
      row.appendChild(mv);
      dragHandlers(row, b.id);
    }
    row.title = fx.blurb;
    row.onclick = () => { node._rnFxSel = b.id; postRender(node); };
    list.appendChild(row);
  };
  chain.forEach((b, i) => {
    const fx = byId[b.fx];
    const band = chainBand(b.fx);
    if (band !== lastBand) {
      const bandEl = document.createElement("div");
      bandEl.className = "rn-ws-fxband";
      bandEl.textContent = band;
      list.appendChild(bandEl);
      lastBand = band;
    }
    addRow(b, fx, i);
  });
  // ADD AN EFFECT: any effect, another instance at the end of the chain (the
  // editor's Another button copies the one on screen right after itself)
  const addRowEl = document.createElement("div");
  addRowEl.className = "rn-ws-fxadd";
  const addSel = document.createElement("select");
  addSel.className = "rn-ws-res";
  for (const fx of POST_FX) {
    if (fx.settings) continue;
    const o = document.createElement("option");
    o.value = fx.id;
    o.textContent = fx.label;
    addSel.appendChild(o);
  }
  addSel.title = "Which effect to add at the end of the chain. An effect can be in "
               + "the chain more than once, each with its own dials and Limit.";
  const addBtn = document.createElement("button");
  addBtn.className = "rn-ws-btn";
  addBtn.style.cssText = "width:auto;padding:0 10px";
  addBtn.textContent = "＋ Add";
  addBtn.title = "Add that effect to the end of the chain, switched on.";
  addBtn.onclick = () => {
    const b = newChainItem(cfg, addSel.value);
    if (!b) return;
    b.on = true;
    chain.push(b);
    node._rnFxSel = b.id;
    postWrite(node);
    postRender(node);
  };
  addRowEl.append(addSel, addBtn);
  list.appendChild(addRowEl);
  const sband = document.createElement("div");
  sband.className = "rn-ws-fxband";
  sband.textContent = "SETTINGS";
  list.appendChild(sband);
  for (const fx of POST_FX.filter((x) => x.settings)) {
    addRow({ id: fx.id, fx: fx.id, on: false }, fx, -1);
  }
  // the panel re-renders on every click, which rebuilt the list at the top and
  // threw a scrolled reader back up; the position is kept on the node instead
  list.addEventListener("scroll", () => { node._rnFxListScroll = list.scrollTop; });
  split.appendChild(list);

  // the editor: the selected INSTANCE, its switch, its controls, its limit
  const item = itemById[node._rnFxSel];
  const fx = item ? byId[item.fx] : byId[node._rnFxSel];
  const b = item || cfg.post[fx.id];
  const edit = document.createElement("div");
  edit.className = "rn-ws-fxedit";
  const h = document.createElement("div");
  h.className = "head";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = fx.settings ? fx.label.toUpperCase()
    : (labels[b.id] || fx.label).toUpperCase()
      + (countOf[b.fx] > 1 ? "  (" + (chain.findIndex((x) => x.id === b.id) + 1) + " in the chain)" : "");
  h.appendChild(ttl);
  if (!fx.settings) {
    const onB = document.createElement("button");
    onB.className = "rn-ws-on" + (b.on ? " on" : "");
    onB.textContent = b.on ? "ON" : "OFF";
    onB.title = fx.blurb;
    onB.onclick = () => { b.on = !b.on; postWrite(node); postRender(node); };
    h.appendChild(onB);
    // ANOTHER: a second instance of this effect right after this one, with the
    // same dials, so a sharpen on the subject can be followed by one on the
    // whole frame. REMOVE takes this instance out of the chain; the add row at
    // the foot of the list brings an effect back.
    const dup = document.createElement("button");
    dup.className = "rn-ws-btn";
    dup.style.cssText = "width:auto;padding:0 9px;font-size:11px";
    dup.textContent = "＋ Another";
    dup.title = "Add another " + fx.label + " right after this one, with the same dials. "
              + "Each instance has its own switch, dials and Limit, so one can work "
              + "the subject and the next the whole frame.";
    dup.onclick = () => {
      const nb = newChainItem(cfg, fx.id, b);
      if (!nb) return;
      const at = chain.findIndex((x) => x.id === b.id);
      chain.splice(at + 1, 0, nb);
      node._rnFxSel = nb.id;
      postWrite(node);
      postRender(node);
    };
    const rm = document.createElement("button");
    rm.className = "rn-ws-btn";
    rm.style.cssText = "width:auto;padding:0 9px;font-size:11px";
    rm.textContent = "✕ Remove";
    rm.title = "Take this instance out of the chain. The add row at the foot of the "
             + "list puts an effect back.";
    rm.onclick = () => {
      const at = chain.findIndex((x) => x.id === b.id);
      if (at < 0) return;
      chain.splice(at, 1);
      node._rnFxSel = (chain[Math.max(0, at - 1)] || POST_FX.find((x) => x.settings)).id;
      postWrite(node);
      postRender(node);
    };
    h.append(dup, rm);
  }
  // an effect that costs real time says so here, because this is where somebody
  // asks "why did that take twenty seconds"; the chips sit after the switch
  if (fx.depth) {
    const chip = document.createElement("span");
    chip.className = "rn-ws-vram med";
    chip.textContent = "Uses depth";
    chip.title = "This effect works out what is near and what is far. The node does "
               + "that for you with the estimator set on the Depth card, so there is "
               + "nothing to wire. The depth input is only there if you would rather "
               + "supply your own map.";
    h.appendChild(chip);
  }
  if (fx.cost) {
    const cost = document.createElement("span");
    cost.className = "rn-ws-cost";
    cost.textContent = fx.cost;
    cost.title = fx.cost === "depth model"
      ? "This one needs a depth map, so switching it on loads a depth model. That "
      + "is seconds, not milliseconds, and it is usually the reason a grade feels "
      + "slow. The Depth card picks the estimator and its resolution; wire a depth "
      + "image into the node to reuse one you already have."
      : "Cost climbs steeply with the sliders. At the shipped values it is about a "
      + "tenth of a second; with sigma and the radius multiplier at maximum it is "
      + "several seconds on a 1 MP frame.";
    h.appendChild(cost);
  }
  edit.appendChild(h);
  if (cfg.post_ui.hints) {
    const blurb = document.createElement("div");
    blurb.className = "blurb";
    blurb.textContent = fx.blurb;
    blurb.title = fx.blurb;
    edit.appendChild(blurb);
  }
  const grid = document.createElement("div");
  grid.className = "rn-ws-fxgrid";
  for (const c of fx.controls) grid.appendChild(renderControl(node, cfg, fx, b, c));
  edit.appendChild(grid);
  // LIMIT: the effect's result only on the subject or the background, through the
  // mask the Mask card describes, with that card's feather beside it
  if (!fx.settings) {
    const lrow = document.createElement("div");
    lrow.className = "rn-ws-row rn-ws-fxlimit";
    const llab = document.createElement("span");
    llab.className = "lab";
    llab.textContent = "Limit";
    const lsel = document.createElement("select");
    lsel.className = "rn-ws-res";
    for (const [v, txt] of [["off", "Whole frame"], ["subject", "Subject only"],
                            ["background", "Background only"]]) {
      const o = document.createElement("option");
      o.value = v; o.textContent = txt; o.selected = (b.limit || "off") === v;
      lsel.appendChild(o);
    }
    lsel.title = "Where this effect applies. Subject and background come from the mask "
               + "the Mask card describes, softened by its feather; the rest of the frame "
               + "is left exactly as it was before this effect.";
    lsel.onchange = () => { b.limit = lsel.value; postWrite(node); postRender(node); };
    lrow.append(llab, lsel);
    if ((b.limit || "off") !== "off" && cfg.post.mask) {
      const flab = document.createElement("span");
      flab.className = "lab";
      flab.textContent = "Feather";
      const finp = document.createElement("input");
      finp.type = "number";
      finp.className = "val";
      finp.min = 0; finp.max = 64; finp.step = 1;
      finp.value = String(cfg.post.mask.feather ?? 12);
      finp.title = "The mask's edge softness in pixels, shared by every limited effect "
                 + "(the Mask card's feather).";
      finp.addEventListener("change", () => {
        const v = Math.max(0, Math.min(64, Math.round(Number(finp.value) || 0)));
        cfg.post.mask.feather = v;
        finp.value = String(v);
        postWrite(node);
      });
      lrow.append(flab, finp);
    }
    edit.appendChild(lrow);
  }
  split.appendChild(edit);
  body.appendChild(split);
  if (node._rnFxListScroll) {
    list.scrollTop = node._rnFxListScroll;
    // a list that is not yet laid out cannot scroll: try again once it is
    setTimeout(() => { list.scrollTop = node._rnFxListScroll || 0; }, 0);
  }
}
