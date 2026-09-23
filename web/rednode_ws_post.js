import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { POST_FX, LENS_PRESETS, snapStep } from "./rednode_ws_tables.js";
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
// what this install can drive: {depth: {ready, estimators, ...}, mask: {...}};
// null until asked, {} when the server did not answer (then nothing is claimed)
let postStatus = null;
export async function refreshPostStatus(node) {
  try {
    const res = await api.fetchApi("/rednode/post_status");
    const d = await res.json();
    postStatus = d && typeof d === "object" && !d.error ? d : {};
  } catch (e) { postStatus = {}; }
  if (node) postRender(node);
}
// what the install check reads, so it and the cards never disagree
export const postStatusNow = () => postStatus;
const depthMissing = () => postStatus?.depth && postStatus.depth.ready === false;
const maskMissing = () => postStatus?.mask && postStatus.mask.ready === false;

// the status block on the Depth and Mask cards: what is here, where it lives,
// and what to install when it is not
function modelStatusBox(kind) {
  const st = postStatus?.[kind];
  const box = document.createElement("div");
  box.className = "rn-ws-modelstat" + (st ? (st.ready ? " ok" : " missing") : "");
  const line = (text, cls) => {
    const l = document.createElement("div");
    if (cls) l.className = cls;
    l.textContent = text;
    box.appendChild(l);
  };
  if (!st) {
    line(postStatus === undefined ? "Checking what is installed..."
                                  : "The server did not say what is installed.", "dim");
    return box;
  }
  if (kind === "depth") {
    line(st.ready
      ? "Depth estimator installed: " + st.estimators.map((k) => st.labels?.[k] || k).join(", ")
      : "No depth estimator is installed, so Depth of field, Atmospheric haze and Relight "
        + "do nothing.", "head");
    if (st.ready) {
      line(st.weights?.length ? "Weights downloaded: " + st.weights.join(", ")
                              : "No weights downloaded yet: the first run fetches them, "
                                + "which takes a minute.", "dim");
    }
  } else {
    line(st.ready
      ? "Segmenter installed: " + st.segmenters.join(", ")
      : "No segmenter is installed, so Subject only and Background only run on the whole "
        + "frame.", "head");
    if (st.ready) {
      line(st.models?.length ? "Models on disk: " + st.models.join(", ")
                             : "No models downloaded yet: the first run fetches them.", "dim");
    }
  }
  line("Where the weights live: " + st.where, "dim");
  if (!st.ready) line(st.install, "install");
  return box;
}

function checkAgainButton(node) {
  const b = document.createElement("button");
  b.className = "rn-ws-btn";
  b.style.cssText = "width:auto;padding:0 12px;align-self:flex-start";
  b.textContent = "Check again";
  b.title = "Ask the server again what is installed. A pack added in the Manager needs a "
          + "ComfyUI restart before it shows here.";
  b.onclick = () => refreshPostStatus(node);
  return b;
}

// a chip on an effect's editor saying the model it needs is (or is not) there,
// with a link to the settings card that picks it
function modelChip(node, kind, label) {
  const wrap = document.createElement("span");
  wrap.className = "rn-ws-modelchip";
  const missing = kind === "depth" ? depthMissing() : maskMissing();
  const chip = document.createElement("span");
  chip.className = "rn-ws-vram " + (missing ? "high" : "med");
  chip.textContent = missing ? (kind === "depth" ? "No depth model" : "No mask model") : label;
  const st = postStatus?.[kind];
  chip.title = missing
    ? st.install
    : kind === "depth"
      ? "This effect works out what is near and what is far. The node does that for you "
        + "with the estimator set on the Depth card, so there is nothing to wire. The depth "
        + "input is only there if you would rather supply your own map."
      : "Subject only and Background only use the pack's auto-mask, set up on the Mask card.";
  const link = document.createElement("button");
  link.className = "rn-ws-modellink";
  link.textContent = (kind === "depth" ? "Depth" : "Mask") + " settings \u203a";
  link.title = "Open the " + (kind === "depth" ? "Depth" : "Mask") + " card: what is installed "
             + "and which model it uses.";
  link.onclick = (e) => { e.stopPropagation(); node._rnFxSel = kind; postRender(node); };
  wrap.append(chip, link);
  return wrap;
}

// saved orders, fetched once and after every change: [{name, ids}]
let postOrders = null;
export async function refreshPostOrders(node) {
  try {
    const res = await api.fetchApi("/rednode/post_orders");
    const d = await res.json();
    postOrders = Array.isArray(d.orders) ? d.orders : [];
  } catch (e) { postOrders = []; }
  if (node) postRender(node);
}
async function postOrderAction(node, body) {
  const res = await api.fetchApi("/rednode/post_orders", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  postOrders = Array.isArray(d.orders) ? d.orders : [];
  postRender(node);
}

// Lay a saved order over the chain. The effects the order names move into the
// order it saved, taking the places those same effects hold now; everything it
// does not name stays exactly where it is, and a name it holds that the chain
// does not have is skipped.
export function applyOrder(d, ids) {
  const chain = d?.post?.chain || [];
  const want = (ids || []).filter((id, i, a) => a.indexOf(id) === i
                                               && chain.some((b) => b.id === id));
  const named = new Set(want);
  const picked = want.map((id) => chain.find((b) => b.id === id));
  let k = 0;
  d.post.chain = chain.map((b) => (named.has(b.id) ? picked[k++] : b));
}

// Move an effect to a position counted among the effects that are ON, which is
// how the Order view numbers them. 1 is first; past the end is last.
export function moveToPosition(chain, id, pos) {
  const from = chain.findIndex((b) => b.id === id);
  if (from < 0) return;
  const [it] = chain.splice(from, 1);
  const others = chain.filter((b) => b.on);
  const p = Math.max(1, Math.min(others.length + 1, Math.round(Number(pos) || 1)));
  let at;
  if (p <= others.length) at = chain.indexOf(others[p - 1]);
  else at = others.length ? chain.indexOf(others[others.length - 1]) + 1 : chain.length;
  chain.splice(at, 0, it);
}

// the right-click menu on a card or a map square: type the number it should be
function openOrderMenu(node, cfg, chain, b, label, pos, count, ev) {
  ev.preventDefault?.();
  ev.stopPropagation?.();
  document.querySelector(".rn-ws-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-menu rn-ws-ordermenu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = `${label}: ${pos} of ${count}`;
  const done = () => { m.remove(); postWrite(node); postRender(node); };
  const row = document.createElement("div");
  row.className = "posrow";
  const lab = document.createElement("span");
  lab.textContent = "Move to";
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = 1; inp.max = count; inp.step = 1;
  inp.value = String(pos);
  inp.title = `A number from 1 to ${count}: the place in the run order this effect takes.`;
  const go = document.createElement("button");
  go.textContent = "Move";
  go.onclick = () => { moveToPosition(chain, b.id, inp.value); node._rnOrderFocus = b.id; done(); };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go.onclick(); });
  row.append(lab, inp, go);
  const mk = (text, fn) => {
    const x = document.createElement("button");
    x.textContent = text;
    x.onclick = fn;
    return x;
  };
  const sep = document.createElement("div");
  sep.className = "sep";
  m.append(note, row,
    mk("Move to first", () => { moveToPosition(chain, b.id, 1); node._rnOrderFocus = b.id; done(); }),
    mk("Move to last", () => { moveToPosition(chain, b.id, count); node._rnOrderFocus = b.id; done(); }),
    sep,
    mk("Open in Effects", () => {
      m.remove();
      node._rnFxSel = b.id;
      node._rnPostSub = "effects";
      postRender(node);
    }));
  document.body.appendChild(m);
  const mw = 230, mh = m.getBoundingClientRect().height || 180;
  m.style.left = Math.max(6, Math.min(ev.clientX || 0, (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY || 0, (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  setTimeout(() => inp.focus?.(), 0);
}
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
  if (preset.builtin) {
    // shipped with the pack: apply it, or keep an editable copy under your own name
    m.append(
      note,
      mk("Apply these effects", () => applyLook()),
      mk("Save a copy…", async () => {
        const name = prompt("Name your copy", `${preset.name} copy`);
        if (!name) return;
        const cfg = (await (await api.fetchApi(
          `/rednode/post_presets?name=${encodeURIComponent(preset.name)}`)).json()).config;
        await postPresetAction(node, { action: "save", name, config: cfg });
      }),
    );
    document.body.appendChild(m);
  } else {
  m.append(
    note,
    mk("Apply these effects", () => applyLook()),
    mk("Overwrite with the settings on this tab", () =>
      postPresetAction(node, { action: "save", name: preset.name,
                               config: node._rnCfg.post })),
    mk("Rename…", async () => {
      const name = prompt("Rename these saved effects", preset.name);
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
  }
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
    // THE FULL RANGE IS ALWAYS THERE: every effect keeps one BASE instance, its
    // id the effect's own name, which switches on and off but is never removed.
    // A chain missing an effect gets its base back, off, at its camera position.
    const rank = Object.fromEntries(POST_FX.map((fx, i) => [fx.id, i]));
    for (const fx of effects) {
      if (chain.some((b) => b.id === fx.id)) continue;
      const mine = chain.find((b) => b.fx === fx.id);
      if (mine) { mine.id = fx.id; continue; }
      const nb = normItem({ ...(d.post[fx.id] || {}) }, fx);
      nb.on = false;
      nb.id = fx.id;
      const at = chain.findIndex((b) => rank[b.fx] > rank[fx.id]);
      chain.splice(at < 0 ? chain.length : at, 0, nb);
    }
  }
  d.post.chain = chain;
  mirrorChain(d);
  return chain;
}

// an EXTRA instance, added on top of the full range: the only kind that can be
// deleted. The base instance of an effect carries the effect's own name as id.
export const isExtra = (b) => !!b && b.id !== b.fx;

// the per-effect blocks mirror the FIRST instance of each effect, for every
// reader that asks "is bloom on" without walking the chain (the Looks strip,
// the server's older readers); an effect with no instance reads as off
export function mirrorChain(d) {
  if (!d || !d.post || !Array.isArray(d.post.chain)) return;
  const first = {};
  for (const b of d.post.chain) if (b.id === b.fx) first[b.fx] = b;
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

// one applyable cell: a saved look shows its own thumbnail, a shipped one a
// two-colour swatch and a SHIPPED tag; both apply on click, right-click opens
// the menu appropriate to that kind (see openLookMenu)
function lookCell(node, cfg, preset) {
  const cell = document.createElement("div");
  cell.className = "rn-ws-look" + (preset.builtin ? " shipped" : "");
  cell.style.width = cell.style.height = cfg.look_thumb + "px";
  cell.title = preset.builtin
    ? `${preset.name}. ${preset.blurb || ""} Ships with the pack: apply it, or save a `
      + "copy of your own to change it."
    : `Apply the "${preset.name}" look. Right-click for rename, overwrite and delete.`;
  if (preset.builtin) {
    if (preset.thumb) {
      const im = document.createElement("img");
      im.src = preset.thumb;
      cell.appendChild(im);
    } else {
      const sw = document.createElement("span");
      sw.className = "sw";
      const [c1, c2] = preset.swatch && preset.swatch.length === 2
        ? preset.swatch : ["#2a2e35", "#4a5058"];
      sw.style.background = `linear-gradient(135deg, ${c1} 55%, ${c2} 100%)`;
      cell.appendChild(sw);
    }
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "SHIPPED";
    cell.appendChild(tag);
  } else if (preset.thumb) {
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
    node._rnCfg = readCfg(node);                    // re-normalise the applied look
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
  return cell;
}

export function looksSection(node, body) {
  const cfg = node._rnCfg;
  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-looks";
  const head = document.createElement("div");
  head.className = "head";
  // folds away like any section; whether it is open is where the panel was left
  // standing, so it lives in node.properties and survives a reload
  const folded = !!node.properties?.rn_saved_fx_folded;
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = folded ? "▸" : "▾";
  const savedOnly = postPresets.filter((p) => !p.builtin);
  const shipped = postPresets.filter((p) => p.builtin);
  const tab = node.properties?.rn_saved_fx_tab === "shipped" ? "shipped" : "mine";
  const ttl = document.createElement("span");
  ttl.className = "ttl rn-ws-savedttl";
  ttl.textContent = "Saved effects";
  head.append(arr, ttl);
  head.title = folded ? "Show the saved effects." : "Fold the saved effects away.";
  head.onclick = () => {
    (node.properties ||= {}).rn_saved_fx_folded = !folded;
    postRender(node);
  };
  sect.appendChild(head);
  if (folded) {
    body.appendChild(sect);
    return;
  }

  // two tabs, so the looks that ship with the pack never bury your own
  const tabs = document.createElement("div");
  tabs.className = "rn-ws-row rn-ws-looktabs";
  const seg = document.createElement("div");
  seg.className = "rn-ws-seg";
  for (const [v, l, tip] of [
    ["mine", `Mine (${savedOnly.length})`, "The effects you saved, and the last graded frame."],
    ["shipped", `Shipped (${shipped.length})`,
     "Looks that ship with the pack. Apply one, or right-click to save a copy you can change."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (tab === v ? " on" : "");
    b.textContent = l;
    b.title = tip;
    b.onclick = () => { (node.properties ||= {}).rn_saved_fx_tab = v; postRender(node); };
    seg.appendChild(b);
  }
  tabs.appendChild(seg);
  sect.appendChild(tabs);

  const grid = document.createElement("div");
  grid.className = "rn-ws-lookgrid";
  if (tab === "shipped") {
    for (const preset of shipped) grid.appendChild(lookCell(node, cfg, preset));
    sect.appendChild(grid);
    body.appendChild(sect);
    return;
  }

  // the last graded frame, so you can see what the dials are actually doing
  const live = document.createElement("div");
  live.className = "rn-ws-look live";
  live.style.width = live.style.height = cfg.look_thumb + "px";
  live.title = postLastThumb
    ? "The last image this chain graded. Save effects keeps these settings with that "
      + "picture."
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

  for (const preset of savedOnly) {
    grid.appendChild(lookCell(node, cfg, preset));
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
  tr.title = "How big the saved effects thumbnails are drawn.";
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
  save.textContent = "Save effects";
  save.title = "Stores every setting on this tab under a name, the effects, their dials "
             + "and their order, with the last graded frame as its thumbnail, so you can "
             + "recognise it by eye later.";
  save.onclick = async () => {
    const name = prompt("Name these saved effects");
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
      alert(`Could not save these effects: ${e.message}`);
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
  ["GRADE", ["denoise", "color", "match", "lut", "skin", "clarity", "sharpen"]],
  ["LIGHT", ["relight"]],
  ["AIR", ["haze"]],
  ["LENS", ["distortion", "dof", "aberration", "bloom", "light_wrap", "diffusion", "vignette"]],
  ["FILM", ["halation", "film", "rolloff", "grain"]],
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
// A lens pick fills the distortion instance it was made on and the base Chromatic
// aberration instance, switches both on and sizes them to the frame. Any later dial
// edit on either card puts the name back to Custom, so it never claims a stale pick.
function applyLens(cfg, b, name) {
  const p = LENS_PRESETS[name];
  if (!p) return;
  b.amount = p.amount;
  b.edge_softness = p.edge_softness;
  b.scale_by_size = 1;
  b.on = true;
  const a = (cfg.post.chain || []).find((x) => x.id === "aberration");
  if (!a) return;
  a.amount = p.ca_amount;
  a.red_shift = p.red_shift;
  a.green_shift = p.green_shift;
  a.blue_shift = p.blue_shift;
  a.direction = p.direction;
  a.scale_by_size = 1;
  a.on = true;
}

function clearLens(cfg, fx, b) {
  const c = fx.clears;
  if (!c) return;
  const target = fx.id === c.card ? b : (cfg.post.chain || []).find((x) => x.id === c.card);
  if (target && target[c.key] !== undefined && target[c.key] !== c.to) target[c.key] = c.to;
}

// a button on a card: Measure on the Colour card fetches the white balance of the
// last source frame and writes it into the dials, which stay the user's
function actionControl(node, cfg, fx, b, c) {
  const cell = document.createElement("div");
  cell.className = "rn-ws-fxc rn-ws-fxact";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.textContent = c.label;
  lab.title = c.hint;
  const line = document.createElement("div");
  line.className = "line";
  const btn = document.createElement("button");
  btn.className = "rn-ws-btn";
  btn.style.cssText = "width:auto;padding:0 12px";
  btn.textContent = c.text;
  btn.title = c.hint;
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  note.textContent = node._rnAwbSaid || "";
  btn.onclick = async () => {
    note.textContent = "Measuring...";
    try {
      const res = await api.fetchApi(`/rednode/post_awb?method=${encodeURIComponent(b.awb || "shades_of_grey")}`);
      const got = await res.json();
      if (got.error) throw new Error(got.error);
      b.temperature = got.temperature;
      b.tint = got.tint;
      b.on = true;
      node._rnAwbSaid = `Measured temperature ${got.temperature}, tint ${got.tint}.`
        + (got.clipped ? " The cast was stronger than the dials reach." : "");
    } catch (e) {
      node._rnAwbSaid = e.message;
    }
    postWrite(node);
    postRender(node);
  };
  line.append(btn, note);
  cell.append(lab, line);
  return cell;
}

function renderControl(node, cfg, fx, b, c) {
  if (c.head) {
    const h = document.createElement("div");
    h.className = "rn-ws-fxhead";
    h.textContent = c.head;
    return h;
  }
  if (c.button) return actionControl(node, cfg, fx, b, c);
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
    sel.onchange = () => {
      b[c.key] = sel.value;
      if (c.fills === "lens") applyLens(cfg, b, sel.value);
      else clearLens(cfg, fx, b);
      postWrite(node);
      postRender(node);
    };
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
      clearLens(cfg, fx, b);
      postWrite(node);
    };
    range.addEventListener("input", () => apply(range.value));
    val.addEventListener("change", () => apply(val.value));
    line.append(range, val);
  }
  cell.appendChild(line);
  return cell;
}

// THE ORDER VIEW: the chain as tiles, top to bottom in run order, each with
// its number, its band, its state and its Limit. Drag a tile onto another to
// put it there. The two small buttons double the effect in place or take it
// out; Camera order puts everything back in the shipped order.
const BAND_COLOUR = { GRADE: "#b8283c", LIGHT: "#e0a84a", AIR: "#6fb1c9", LENS: "#4a8fe0",
                      FILM: "#9b6bd6", MORE: "#888" };

function orderBody(node, body, cfg, chain, byId, labels, ops) {
  const bar = document.createElement("div");
  bar.className = "rn-ws-row";
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  note.textContent = "Left to right is the order the chain runs. Only the effects that are on "
                   + "are here; drag a card onto another to move it there.";
  const reset = document.createElement("button");
  reset.className = "rn-ws-btn";
  reset.style.cssText = "width:auto;padding:0 12px;margin-left:auto";
  reset.textContent = "Camera order";
  reset.title = "Put every effect back in the order light meets a camera: repair, grade, "
              + "light, air, lens, film. Doubled effects stay; only the order moves.";
  reset.onclick = () => { cameraOrder(cfg); postWrite(node); postRender(node); };
  bar.append(note, reset);
  body.appendChild(bar);
  const live = chain.filter((b) => b.on);

  // SAVED ORDERS: the run order alone, separate from a look (which saves the
  // dials and the switches as well). An order holds the effects that were on
  // when it was saved; applying it moves those into that order and skips any
  // the chain does not have or has switched off.
  if (postOrders === null) refreshPostOrders(node);
  const obar = document.createElement("div");
  obar.className = "rn-ws-row rn-ws-orderbar";
  const olab = document.createElement("span");
  olab.className = "rn-ws-note";
  olab.textContent = "Saved orders";
  const osel = document.createElement("select");
  osel.className = "rn-ws-res";
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = (postOrders || []).length ? "Pick an order..." : "No saved orders yet";
  osel.appendChild(o0);
  for (const o of postOrders || []) {
    const opt = document.createElement("option");
    opt.value = o.name;
    opt.textContent = `${o.name} (${o.ids.length})`;
    opt.selected = node._rnOrderPick === o.name;
    osel.appendChild(opt);
  }
  osel.title = "A saved run order. Apply moves the effects it names into that order and "
             + "leaves the rest where they are.";
  osel.onchange = () => { node._rnOrderPick = osel.value; };
  const oapply = document.createElement("button");
  oapply.className = "rn-ws-btn";
  oapply.style.cssText = "width:auto;padding:0 12px";
  oapply.textContent = "Apply";
  oapply.title = "Put the effects this order names into its order. Effects it does not name, "
               + "or that are not in the chain, are skipped.";
  oapply.onclick = () => {
    const o = (postOrders || []).find((x) => x.name === osel.value);
    if (!o) return;
    applyOrder(cfg, o.ids);
    postWrite(node);
    postRender(node);
  };
  const osave = document.createElement("button");
  osave.className = "rn-ws-btn";
  osave.style.cssText = "width:auto;padding:0 12px";
  osave.textContent = "Save order";
  osave.title = "Save the order of the effects that are on now, under a name. It saves the "
              + "order only; Save effects above saves the dials and the switches too.";
  osave.onclick = async () => {
    const ids = chain.filter((b) => b.on).map((b) => b.id);
    if (!ids.length) { alert("Switch some effects on first: an order is the order of the effects that are on."); return; }
    const name = prompt("Save this order as", node._rnOrderPick || "");
    if (!name) return;
    try {
      node._rnOrderPick = name;
      await postOrderAction(node, { action: "save", name, ids });
    } catch (e) { alert("Could not save the order: " + e.message); }
  };
  const odel = document.createElement("button");
  odel.className = "rn-ws-btn";
  odel.style.cssText = "width:auto;padding:0 10px";
  odel.textContent = "\u2715";
  odel.title = "Delete the picked saved order.";
  odel.onclick = async () => {
    if (!osel.value) return;
    if (!confirm(`Delete the saved order "${osel.value}"?`)) return;
    try {
      node._rnOrderPick = "";
      await postOrderAction(node, { action: "delete", name: osel.value });
    } catch (e) { alert("Could not delete the order: " + e.message); }
  };
  obar.append(olab, osel, oapply, osave, odel);
  body.appendChild(obar);
  const wrap = document.createElement("div");
  wrap.className = "rn-ws-fxboard";
  const left = document.createElement("button");
  left.className = "rn-ws-fxscroll";
  left.textContent = "\u2039";
  const cards = document.createElement("div");
  cards.className = "rn-ws-fxcards";
  const right = document.createElement("button");
  right.className = "rn-ws-fxscroll";
  right.textContent = "\u203a";
  left.onclick = () => { cards.scrollLeft -= 360; };
  right.onclick = () => { cards.scrollLeft += 360; };
  if (!live.length) {
    const empty = document.createElement("div");
    empty.className = "rn-ws-note";
    empty.style.padding = "18px 8px";
    empty.textContent = "Nothing is on yet. Switch effects on in the Effects view and they line "
                      + "up here in the order they run.";
    cards.appendChild(empty);
  }
  live.forEach((b, i) => {
    const fx = byId[b.fx];
    const band = chainBand(b.fx);
    const colour = BAND_COLOUR[band] || "#888";
    const card = document.createElement("div");
    card.className = "rn-ws-fxcard";
    const big = document.createElement("span");
    big.className = "big";
    big.textContent = String(i + 1);
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(i + 1);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = labels[b.id];
    const st = document.createElement("span");
    st.className = "st on";
    const lim = document.createElement("span");
    lim.className = "lim";
    lim.textContent = b.limit && b.limit !== "off" ? b.limit : "frame";
    lim.title = b.limit && b.limit !== "off"
      ? "Limited to the " + b.limit + "."
      : "The whole frame.";
    const foot = document.createElement("span");
    foot.className = "foot";
    foot.textContent = band;
    foot.style.background = colour;
    const acts = document.createElement("span");
    acts.className = "acts";
    const dup = document.createElement("button");
    dup.textContent = "\u29c9";
    dup.title = "Another " + fx.label + " right after this one, with the same dials: one "
              + "can work the subject and the next the whole frame.";
    dup.onclick = (e) => {
      e.stopPropagation();
      const nb = newChainItem(cfg, fx.id, b);
      if (!nb) return;
      const at = chain.findIndex((x) => x.id === b.id);
      chain.splice(at + 1, 0, nb);
      node._rnFxSel = nb.id;
      postWrite(node);
      postRender(node);
    };
    const rm = document.createElement("button");
    rm.textContent = "\u2715";
    rm.title = "Delete this extra " + fx.label + ". The first " + fx.label + " always stays "
             + "in the chain; switch it off in the Effects view instead.";
    rm.onclick = (e) => {
      e.stopPropagation();
      const at = chain.findIndex((x) => x.id === b.id);
      if (at < 0) return;
      chain.splice(at, 1);
      if (node._rnFxSel === b.id) node._rnFxSel = (chain[Math.max(0, at - 1)] || POST_FX[0]).id;
      postWrite(node);
      postRender(node);
    };
    acts.append(dup);
    if (isExtra(b)) acts.append(rm);
    card.append(big, n, nm, st, lim, foot, acts);
    card.title = fx.blurb + "\n\nDouble-click to open it in Effects; right-click to type "
               + "the place it should take.";
    card.ondblclick = () => { node._rnFxSel = b.id; node._rnPostSub = "effects"; postRender(node); };
    card.addEventListener("contextmenu", (e) =>
      openOrderMenu(node, cfg, chain, b, labels[b.id], i + 1, live.length, e));
    if (node._rnOrderFocus === b.id) {
      card.classList.add("focus");
      setTimeout(() => card.scrollIntoView?.({ behavior: "smooth", inline: "center", block: "nearest" }), 0);
    }
    ops.dragHandlers(card, b.id);
    cards.appendChild(card);
  });
  wrap.append(left, cards, right);
  body.appendChild(wrap);
  cards.addEventListener("scroll", () => { node._rnCardScroll = cards.scrollLeft; });
  node._rnAfterMount = () => {
    if (node._rnOrderFocus) return;              // the focused card scrolls itself into view
    if (node._rnCardScroll) {
      cards.style.scrollBehavior = "auto";
      cards.scrollLeft = node._rnCardScroll;
      cards.style.scrollBehavior = "";
    }
  };

  // THE MAP: the same run order as small coloured squares, number and name,
  // wrapping into rows so the whole chain reads at a glance. Click a square to
  // jump the cards above to it; right-click to type the place it should take.
  if (live.length) {
    const mcap = document.createElement("div");
    mcap.className = "rn-ws-fxmapcap";
    mcap.textContent = "ORDER AT A GLANCE";
    body.appendChild(mcap);
    const map = document.createElement("div");
    map.className = "rn-ws-fxmap2";
    live.forEach((b, i) => {
      const band = chainBand(b.fx);
      const sq = document.createElement("button");
      sq.className = "rn-ws-fxsq" + (node._rnOrderFocus === b.id ? " focus" : "");
      sq.style.background = BAND_COLOUR[band] || "#888";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = labels[b.id];
      sq.append(num, nm);
      sq.title = `${i + 1}. ${labels[b.id]} (${band}${b.limit && b.limit !== "off" ? ", " + b.limit + " only" : ""}). `
               + "Click to jump to its card; right-click to type the place it should take.";
      sq.onclick = () => { node._rnOrderFocus = b.id; postRender(node); };
      sq.addEventListener("contextmenu", (e) =>
        openOrderMenu(node, cfg, chain, b, labels[b.id], i + 1, live.length, e));
      map.appendChild(sq);
    });
    body.appendChild(map);
  }
}

// THE MATCH CARD'S OWN PICTURE: drop an image on the box (or choose one) and it
// is uploaded to the input folder and used as this Match's reference, on the
// Workspace and on the standalone node alike, no tab or wire needed.
async function uploadReference(node, b, file) {
  if (!file || !String(file.type || "").startsWith("image/")) return;
  const body = new FormData();
  body.append("image", file, file.name || "reference.png");
  body.append("type", "input");
  body.append("subfolder", "rednode/post_refs");
  try {
    const res = await api.fetchApi("/upload/image", { method: "POST", body });
    const d = await res.json();
    if (!d.name) throw new Error("the upload returned no name");
    b.ref_file = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
    b.source = "file";
    postWrite(node);
    postRender(node);
  } catch (e) {
    console.error("[RedNode Workspace] the reference upload failed:", e);
    alert("Could not upload that picture: " + e.message);
  }
}

function matchRefBox(node, b) {
  const box = document.createElement("div");
  box.className = "rn-ws-refdrop" + (b.source === "file" ? " live" : "");
  const pic = document.createElement("div");
  pic.className = "pic";
  if (b.ref_file) {
    const parts = String(b.ref_file).split("/");
    const filename = parts.pop();
    const img = document.createElement("img");
    img.draggable = false;
    img.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`
                         + `&subfolder=${encodeURIComponent(parts.join("/"))}`);
    pic.appendChild(img);
  } else {
    pic.textContent = "No picture";
  }
  const side = document.createElement("div");
  side.className = "side";
  const say = document.createElement("div");
  say.className = "rn-ws-note";
  say.textContent = b.ref_file
    ? (b.source === "file" ? "This picture is the reference." : "Dropped picture kept; pick "
       + "\"A picture dropped here\" above to use it.")
    : "Drop a picture here to match the frame's colour to it.";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*";
  file.style.display = "none";
  file.onchange = () => uploadReference(node, b, file.files?.[0]);
  const choose = document.createElement("button");
  choose.className = "rn-ws-btn";
  choose.style.cssText = "width:auto;padding:0 12px";
  choose.textContent = b.ref_file ? "Replace" : "Choose a picture";
  choose.title = "Pick an image file to use as this Match's reference.";
  choose.onclick = () => file.click();
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  row.append(choose);
  if (b.ref_file) {
    const clear = document.createElement("button");
    clear.className = "rn-ws-btn";
    clear.style.cssText = "width:auto;padding:0 10px";
    clear.textContent = "\u2715";
    clear.title = "Forget the dropped picture. The file stays in the input folder.";
    clear.onclick = () => {
      b.ref_file = "";
      if (b.source === "file") b.source = "moodboard";
      postWrite(node);
      postRender(node);
    };
    row.appendChild(clear);
  }
  side.append(say, row, file);
  box.append(pic, side);
  box.title = "Drop an image here to use it as the reference.";
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
  box.addEventListener("dragleave", () => box.classList.remove("over"));
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadReference(node, b, f);
  });
  return box;
}

export function postBody(node, body, opts = {}) {
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
    el.addEventListener("dragstart", (e) => { dragId = id; el.classList.add("dragging"); e.dataTransfer?.setData?.("text/plain", id); });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", () => { el.classList.remove("drop"); });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      if (!dragId || dragId === id) return;
      const to = chain.findIndex((b) => b.id === id);
      const from = chain.findIndex((b) => b.id === dragId);
      moveItem(dragId, from < to ? to : to);
      dragId = null;
    });
  };
  const cog = document.createElement("button");
  cog.className = "rn-ws-cog";
  cog.textContent = "⚙";
  cog.title = "Settings for this tab: slider precision and the explanations.";
  cog.onclick = () => openPostCog(node, cog);
  if (opts.cogHost) {
    // INSIDE THE WORKSPACE the cog sits at the right end of the Post FX switch
    // bar. A row of its own under that bar read as a stray box; the hint it
    // carried lives in the Effects tip below instead.
    opts.cogHost.appendChild(cog);
  } else {
    const bar = document.createElement("div");
    bar.className = "rn-ws-row";
    bar.appendChild(cog);
    const note = document.createElement("span");
    note.className = "rn-ws-note";
    note.textContent = "The eye switches an effect on; click its name to edit it. The list "
                     + "is the order the chain runs in.";
    bar.appendChild(note);
    body.appendChild(bar);
  }
  looksSection(node, body);

  // TWO VIEWS on one chain. Effects: the list of what is on, beside one editor,
  // clean. Order: the same chain as numbered tiles you drag about, where an
  // effect is doubled or taken out. The list never rearranges itself.
  const countOf = {};
  for (const b of chain) countOf[b.fx] = (countOf[b.fx] || 0) + 1;
  const nthOf = {};
  const labels = {};
  // the base instance keeps the plain name; the extras are numbered from 2 in
  // the order they sit in the chain, so "Sharpen 2" is always a deletable copy
  for (const b of chain) {
    if (b.id === b.fx) { labels[b.id] = byId[b.fx].label; continue; }
    nthOf[b.fx] = (nthOf[b.fx] || 1) + 1;
    labels[b.id] = byId[b.fx].label + " " + nthOf[b.fx];
  }
  const sub = node._rnPostSub === "order" ? "order" : "effects";
  {
    const sbar = document.createElement("div");
    sbar.className = "rn-ws-row";
    const seg = document.createElement("div");
    seg.className = "rn-ws-seg";
    seg.dataset.rnbar = "1";
    seg.classList.add("rn-barstrip");
    for (const [v, l, tip] of [["effects", "Effects", "Switch effects on, pick one and set its dials. The eye switches "
                                           + "an effect on; click its name to edit it. The list is "
                                           + "the order the chain runs in."],
                               ["order", "Order", "The chain as tiles in the order it runs. Drag to rearrange; double or remove an effect."]]) {
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (sub === v ? " on" : "");
      b.textContent = l; b.title = tip;
      b.onclick = () => { node._rnPostSub = v; postRender(node); };
      seg.appendChild(b);
    }
    sbar.appendChild(seg);
    body.appendChild(sbar);
  }
  if (sub === "order") {
    orderBody(node, body, cfg, chain, byId, labels, { moveItem, dragHandlers });
    return;
  }

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
    if (!fx.settings && b.on && ((fx.depth && depthMissing())
        || ((b.limit === "subject" || b.limit === "background") && maskMissing()))) {
      const warn = document.createElement("span");
      warn.className = "rn-ws-fxwarn";
      warn.textContent = "!";
      warn.title = fx.depth && depthMissing()
        ? "This effect needs a depth model and none is installed, so it does nothing. "
          + "Open the Depth card for what to install."
        : "This effect is limited to the " + b.limit + " but no segmenter is installed, "
          + "so it runs on the whole frame. Open the Mask card for what to install.";
      row.appendChild(warn);
    }
    if (!fx.settings && b.limit && b.limit !== "off") {
      const pill = document.createElement("span");
      pill.className = "rn-ws-fxlimitpill";
      pill.textContent = b.limit;
      pill.title = "Limited to the " + b.limit + ".";
      row.appendChild(pill);
    }
    if (!fx.settings && isExtra(b)) {
      // only an EXTRA instance can be deleted; the full range always stays
      const del = document.createElement("button");
      del.className = "rn-ws-fxdel";
      del.textContent = "\u2715";
      del.title = "Delete this extra " + fx.label + ". The first " + fx.label
                + " always stays in the chain.";
      del.onclick = (e) => {
        e.stopPropagation();
        const at = chain.findIndex((x) => x.id === b.id);
        if (at < 0) return;
        chain.splice(at, 1);
        if (node._rnFxSel === b.id) node._rnFxSel = b.fx;
        postWrite(node);
        postRender(node);
      };
      row.appendChild(del);
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
  // ADDITIONAL: any effect, as another instance at the end of the chain. The
  // Order view is where it is moved, doubled in place or taken out again.
  const aband = document.createElement("div");
  aband.className = "rn-ws-fxband";
  aband.textContent = "ADDITIONAL";
  list.appendChild(aband);
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
  addBtn.title = "Add that effect to the end of the chain, switched on. An effect can "
               + "be in the chain more than once, each with its own dials and Limit; "
               + "the Order view is where it is moved, doubled in place or removed.";
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
  }
  // an effect that costs real time says so here, because this is where somebody
  // asks "why did that take twenty seconds"; the chips sit after the switch
  if (postStatus === null) { postStatus = undefined; refreshPostStatus(node); }
  if (fx.depth && !fx.settings) h.appendChild(modelChip(node, "depth", "Uses depth"));
  if (!fx.settings && (b.limit === "subject" || b.limit === "background")) {
    h.appendChild(modelChip(node, "mask", "Uses the mask"));
  }
  if (fx.cost) {
    const cost = document.createElement("span");
    cost.className = "rn-ws-cost";
    cost.textContent = fx.cost;
    cost.title = fx.costHint ? fx.costHint : fx.cost === "depth model"
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
  if (fx.id === "match") edit.appendChild(matchRefBox(node, b));
  if (fx.id === "depth" || fx.id === "mask") {
    edit.appendChild(modelStatusBox(fx.id));
    edit.appendChild(checkAgainButton(node));
  }
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
  // the list comes back where it was, with no jump. The panel builds its body off
  // the page and attaches it afterwards, and a list that is not in the page cannot
  // hold a scroll offset, so the restore runs from the panel's after-mount hook,
  // which fires right after the body is attached and before anything is painted.
  const restore = () => { if (node._rnFxListScroll) list.scrollTop = node._rnFxListScroll; };
  node._rnAfterMount = restore;
  restore();
}
