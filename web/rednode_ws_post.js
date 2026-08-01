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

  const sep = document.createElement("div");
  sep.className = "sep";
  m.appendChild(sep);
  const reset = document.createElement("button");
  reset.textContent = "Reset the card layout";
  reset.title = "Put the cards back in the order the chain actually runs in.";
  reset.onclick = () => {
    cfg.post_ui.order = [];
    postWrite(node);
    m.remove();
    postRender(node);
  };
  m.appendChild(reset);
  const foot = document.createElement("div");
  foot.className = "note";
  foot.style.whiteSpace = "normal";
  foot.textContent = "Card order is layout only. The chain always runs in grading "
                   + "order, so rearranging cannot change your result.";
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

export function postBody(node, body) {
  const cfg = node._rnCfg;
  if (!node._rnFxOpen) {
    node._rnFxOpen = {};
    for (const fx of POST_FX) node._rnFxOpen[fx.id] = true;   // laid out to be read
  }
  const open = node._rnFxOpen;

  const bar = document.createElement("div");
  bar.className = "rn-ws-row";
  const allOpen = POST_FX.every((fx) => open[fx.id]);
  const fold = document.createElement("button");
  fold.className = "rn-ws-btn";
  fold.style.width = "auto";
  fold.style.padding = "0 10px";
  fold.textContent = allOpen ? "Collapse all" : "Expand all";
  fold.title = allOpen
    ? "Shrink every card to its name and switch, so the whole chain fits in a glance."
    : "Open every card again.";
  fold.onclick = () => {
    for (const fx of POST_FX) open[fx.id] = !allOpen;
    postRender(node);
  };
  bar.appendChild(fold);

  const cog = document.createElement("button");
  cog.className = "rn-ws-cog";
  cog.textContent = "⚙";
  cog.title = "Settings for this tab: slider precision, explanations, card layout.";
  cog.onclick = () => openPostCog(node, cog);
  bar.appendChild(cog);
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  note.textContent = "Drag a card's title to rearrange the layout.";
  bar.appendChild(note);
  body.appendChild(bar);
  looksSection(node, body);

  const head = document.createElement("div");
  head.className = "rn-ws-row";
  const hint = document.createElement("span");
  hint.className = "hint";
  const live = POST_FX.filter((fx) => cfg.post[fx.id].on).map((fx) => fx.label);
  hint.textContent = (live.length
    ? `Runs in this order: ${live.join(", ")}. `
    : "Nothing is on yet. ")
    + "To use it: add a RedNode Post Process node (Add Node, image, krea2), wire "
    + "your VAE Decode's IMAGE into its image input, and its image output into "
    + "Save Image. It finds this tab by itself, so no other wire is needed.";
  head.append(hint);
  body.appendChild(head);

  const cards = document.createElement("div");
  cards.className = "rn-ws-fxwrap";
  const byId = Object.fromEntries(POST_FX.map((fx) => [fx.id, fx]));
  for (const fx of cardOrder(cfg).map((id) => byId[id])) {
    const b = cfg.post[fx.id];
    const sect = document.createElement("div");
    sect.className = "rn-ws-sect rn-ws-fx";
    const h = document.createElement("div");
    h.className = "head";
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = open[fx.id] ? "▾" : "▸";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = fx.label.toUpperCase() + (b.on ? "" : ": off");
    h.append(arr, ttl);
    // an effect that costs real time says so on its own card, because the place
    // somebody asks "why did that take twenty seconds" is right here
    if (fx.cost) {
      const cost = document.createElement("span");
      cost.className = "rn-ws-cost";
      cost.textContent = fx.cost;
      cost.title = fx.cost === "depth model"
        ? "This one needs a depth map, so switching it on loads a depth model. That "
        + "is seconds, not milliseconds, and it is usually the reason a grade feels "
        + "slow. Wire a depth image into the node to reuse one you already have."
        : "Cost climbs steeply with the sliders. At the shipped values it is about a "
        + "tenth of a second; with sigma and the radius multiplier at maximum it is "
        + "several seconds on a 1 MP frame.";
      h.appendChild(cost);
    }
    h.onclick = () => { open[fx.id] = !open[fx.id]; postRender(node); };
    // drag a card by its title to rearrange the LAYOUT. The chain always runs in
    // grading order server-side, so this cannot break the result.
    h.draggable = true;
    h.title = "Click to fold. Drag to move this card; the layout only, the "
            + "processing order never changes.";
    h.addEventListener("dragstart", (e) => {
      dragFx = fx.id;
      e.dataTransfer?.setData?.("text/plain", fx.id);
    });
    h.addEventListener("dragover", (e) => e.preventDefault());
    h.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragFx || dragFx === fx.id) return;
      const ids = cardOrder(cfg);
      ids.splice(ids.indexOf(dragFx), 1);
      ids.splice(ids.indexOf(fx.id), 0, dragFx);
      cfg.post_ui.order = ids;
      dragFx = null;
      postWrite(node);
      postRender(node);
    });
    sect.appendChild(h);

    const onRow = document.createElement("div");
    onRow.className = "rn-ws-row";
    const onB = document.createElement("button");
    onB.className = "rn-ws-on" + (b.on ? " on" : "");
    onB.textContent = b.on ? "ON" : "OFF";
    onB.title = fx.blurb;
    onB.onclick = () => { b.on = !b.on; postWrite(node); postRender(node); };
    onRow.appendChild(onB);
    if (fx.depth) {
      const chip = document.createElement("span");
      chip.className = "rn-ws-vram med";
      chip.textContent = "Uses depth";
      chip.title = "This effect works out what is near and what is far. The Post "
                 + "Process node does that for you using whichever depth estimator "
                 + "you have installed, so there is nothing to wire. The depth input "
                 + "is only there if you would rather supply your own map.";
      onRow.appendChild(chip);
    }
    sect.appendChild(onRow);
    // the explanation only takes space while the card is open, and stays whole in
    // the tooltip either way, so a shut card is just a name and a switch
    if (open[fx.id] && cfg.post_ui.hints) {
      const blurb = document.createElement("div");
      blurb.className = "blurb";
      blurb.textContent = fx.blurb;
      blurb.title = fx.blurb;
      sect.appendChild(blurb);
    }

    if (open[fx.id]) {
      const grid = document.createElement("div");
      grid.className = "rn-ws-fxgrid";
      for (const c of fx.controls) {
        const cell = document.createElement("div");
        cell.className = "rn-ws-fxc";
        const isRand = !c.choice && Array.isArray(b.rand[c.key]);
        const step = c.choice ? c.step : fxStep(cfg, c);
        const lab = document.createElement("span");
        lab.className = "lab" + (isRand ? " rnd" : "");
        lab.textContent = c.label;
        // right-click flips a control between one value and a random range; a
        // dice button on every row would be clutter
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
          for (const opt of c.choice) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
            o.selected = b[c.key] === opt;
            sel.appendChild(o);
          }
          sel.title = c.hint;
          sel.onchange = () => { b[c.key] = sel.value; postWrite(node); postRender(node); };
          line.appendChild(sel);
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
          const rolled = postLastRolls?.[fx.id]?.[c.key];
          const paint = () => {
            const a = parseFloat(rLo.value), z = parseFloat(rHi.value);
            fil.style.left = pos(a) + "%";
            fil.style.width = Math.max(0.5, pos(z) - pos(a)) + "%";
            val.value = a + " ~ " + z;
            val.title = "Random range " + a + " to " + z
                      + ". A value is drawn every queue.";
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
        grid.appendChild(cell);
      }
      sect.appendChild(grid);
    }
    cards.appendChild(sect);
  }
  body.appendChild(cards);
}
