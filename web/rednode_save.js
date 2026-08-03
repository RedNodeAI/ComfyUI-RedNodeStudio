import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { findNodes } from "./rednode_graph.js";
import { arrowKeys } from "./rednode_keys.js";
import { bindSliderWheel } from "./rednode_wheel.js";
import { wsPref } from "./rednode_settings.js";

// RedNode Save — the filing panel.
//
// The settings used to be one %token% string, which is a fine data format and a
// terrible interface: you cannot see what it will produce, and getting it wrong is
// silent. Here every part is its own field, tokens are chips you click rather than
// syntax you memorise, and the resulting path is shown live above the controls.
//
// Below that, what the recent runs wrote, with a Keep button on every draft. Judging
// happens after looking at the picture, which is the whole reason drafts and keepers
// are separate.

const NODE_NAME = "RedNodeSave";
const MIN_PANEL_H = 430;

const DEFAULTS = {
  root: "", subfolder: "%date%/%preset%", name: "%date%_%time%",
  numbering: "counter", pad: 4, split_drafts: true, keep: false,
  write_text: true, write_json: false, embed_png: true, prompts_folder: "",
  format: "png", quality: 90, compress: 4,
};

const FORMATS = [
  ["png", "PNG", ".png", "Lossless, keeps alpha, and the only format that can carry "
   + "the workflow for drag-back into ComfyUI."],
  ["jpeg", "JPEG", ".jpg", "Small and universal. No alpha, and no embedded workflow: "
   + "nothing reads a ComfyUI graph back out of a jpeg."],
  ["webp", "WebP", ".webp", "Much smaller than PNG at high quality. Quality 100 saves "
   + "lossless."],
];
const EXT = Object.fromEntries(FORMATS.map(([id, , ext]) => [id, ext]));

// label, token, what it becomes. The button says what it means; the field shows the
// token, which is the part worth being literal about.
const TOKENS = [
  ["Date", "%date%", "2026-07-29"],
  ["Time", "%time%", "143211"],
  ["Preset", "%preset%", "max identity"],
  ["Seed", "%seed%", "884213"],
  ["Model", "%model%", "krea2"],
  ["Size", "%size%", "832x1216"],
  ["Width", "%w%", "832"],
  ["Height", "%h%", "1216"],
  ["Year", "%year%", "2026"],
  ["Month", "%month%", "07"],
  ["Day", "%day%", "29"],
];
const SAMPLES = Object.fromEntries(TOKENS.map(([, t, v]) => [t, v]));

const NUMBERING = [
  ["counter", "Counter", "0001, 0002, 0003. Continues from what is already in the folder."],
  ["time", "Time", "The time of the save, so names sort by when you made them."],
  ["seed", "Seed", "The seed, so the name says which one it was."],
  ["none", "None", "Just the name. A clash still gets a suffix rather than overwriting."],
];

const css = document.createElement("style");
css.textContent = `
.rn-sv-wrap{display:flex;flex-direction:column;gap:9px;padding:10px;box-sizing:border-box;
  font:12.5px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;
  border:1px solid #2a2e35;overflow:auto}
.rn-sv-preview{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8fd08f;
  background:#12140f;border:1px solid #2c3a2c;border-radius:5px;padding:7px 9px;
  word-break:break-all;line-height:1.5}
.rn-sv-preview b{color:#d4b25f;font-weight:600}
.rn-sv-sect{display:flex;flex-direction:column;gap:5px}
.rn-sv-lab{font-size:10.5px;font-weight:700;letter-spacing:.4px;opacity:.55;
  text-transform:uppercase}
.rn-sv-row{display:flex;align-items:center;gap:7px}
.rn-sv-row input[type=text]{flex:1;min-width:0;background:#1a1d22;border:1px solid #33373d;
  border-radius:5px;color:#ddd;padding:5px 8px;font-size:11.5px;
  font-family:ui-monospace,Consolas,monospace}
.rn-sv-row input:focus{outline:none;border-color:#b8283c}
.rn-sv-btn{background:#1d2026;border:1px solid #33373d;border-radius:5px;color:#ddd;
  padding:4px 10px;cursor:pointer;font-size:11.5px;white-space:nowrap}
.rn-sv-btn:hover{border-color:#b8283c;color:#fff}
.rn-sv-btn.on{border-color:#b8283c;background:#2a1116;color:#fff}
.rn-sv-chips{display:flex;flex-wrap:wrap;gap:4px}
.rn-sv-chip{font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:2px 6px;
  border-radius:4px;border:1px solid #33373d;background:#1a1d22;color:#9aa2ad;
  cursor:pointer}
.rn-sv-chip:hover{border-color:#b8283c;color:#fff}
.rn-sv-toggles{display:flex;flex-wrap:wrap;gap:6px}
.rn-sv-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
  gap:8px;max-height:420px;overflow:auto;align-content:start}
.rn-sv-item{display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:6px;
  background:#1a1d22;border:1px solid #24272d;min-width:0}
.rn-sv-item.kept{border-color:#3d5a3d}
.rn-sv-item.gone{opacity:.5}
/* Both of these rings draw INSIDE the card. They used to sit outside it (outline-offset
   1px, and a non-inset box-shadow), and .rn-sv-list is a scroll box with no padding, so
   on any card at the grid's edge the ring was clipped away by the container. Cards in
   the first column lost their whole left edge. An inside ring cannot be clipped by an
   ancestor at any scroll position, which is why the thumb ring below already does it. */
.rn-sv-item.picked{border-color:#b8283c;box-shadow:inset 0 0 0 1px #b8283c66}
.rn-sv-item.at{outline:2px solid #d4b25f;outline-offset:-2px}
.rn-sv-item.pending{min-height:92px;align-items:center;justify-content:center;
  border-color:#8f2031;background:linear-gradient(145deg,#23171b,#1a1d22);
  text-align:center}
.rn-sv-pending-spin{width:23px;height:23px;border:2px solid #4a3036;
  border-top-color:#e05268;border-radius:50%;animation:rn-sv-spin .8s linear infinite}
@keyframes rn-sv-spin{to{transform:rotate(360deg)}}
.rn-sv-keptmark{position:absolute;top:8px;right:8px;padding:2px 9px;border-radius:9px;
  font-size:11px;font-weight:600;background:#12240f;border:1px solid #4a7a4a;
  color:#8fd08f}
.rn-sv-keptmark.draft{background:#241f12;border-color:#6b5a2a;color:#d4b25f}
.rn-sv-big{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px}
.rn-sv-big img{max-width:100%;max-height:300px;border-radius:6px;border:1px solid #2a2e35;
  object-fit:contain}
.rn-sv-item.picked .rn-sv-thumb{outline:2px solid #b8283c;outline-offset:-2px}
.rn-sv-selbar{background:#221216;border:1px solid #5a2530;border-radius:5px;padding:5px 7px}
.rn-sv-menu{display:flex;flex-direction:column;gap:1px;min-width:210px}
.rn-sv-menu div{font-family:system-ui,sans-serif;font-size:11.5px}
.rn-sv-thumb{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px;
  background:#111;display:block;cursor:pointer}
.rn-sv-acts{display:flex;gap:4px}
.rn-sv-acts .rn-sv-btn{flex:1;padding:3px 4px;font-size:10.5px;text-align:center}
.rn-sv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Consolas,monospace;font-size:10px;opacity:.75}
.rn-sv-tag{font-size:9.5px;padding:1px 6px;border-radius:9px;border:1px solid #33373d;
  color:#9aa2ad}
.rn-sv-tag.kept{border-color:#4a7a4a;color:#8fd08f}
.rn-sv-note{color:#7c848f;font-size:10.5px;line-height:1.45}
.rn-sv-sel{flex:1;min-width:0;background:#1a1d22;border:1px solid #33373d;border-radius:5px;
  color:#ddd;padding:5px 8px;font-size:11.5px}
.rn-sv-sel:focus{outline:none;border-color:#b8283c}
.rn-sv-pop{position:fixed;z-index:9999;background:#16181c;border:1px solid #33373d;
  border-radius:6px;padding:6px;max-height:280px;overflow:auto;min-width:240px;
  box-shadow:0 10px 30px #000a}
.rn-sv-pop div{padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11.5px;
  font-family:ui-monospace,Consolas,monospace}
.rn-sv-pop div:hover{background:#2a1116;color:#fff}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

function readCfg(node) {
  const w = findWidget(node, "config");
  let d;
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (d[k] === undefined) continue;
    out[k] = typeof DEFAULTS[k] === "boolean" ? !!d[k]
           : typeof DEFAULTS[k] === "number"
             ? (k === "quality" ? Math.max(1, Math.min(100, parseInt(d[k]) || 90))
                                : Math.max(0, Math.min(9, parseInt(d[k]) || 0)))
           : String(d[k] ?? "");
  }
  if (!NUMBERING.some(([id]) => id === out.numbering)) out.numbering = "counter";
  if (!EXT[out.format]) out.format = "png";
  out.quality = Math.max(1, Math.min(100, parseInt(out.quality) || 90));
  return out;
}

function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnSaveCfg);
  node.graph?.change?.();
}

// what the settings would produce right now, with the sample values above
function previewPath(cfg) {
  const sample = SAMPLES;
  const fill = (s) => String(s || "").replace(/%[a-z]+%/g,
    (t) => (sample[t] !== undefined ? sample[t] : t));
  const parts = [];
  if (cfg.root.trim()) parts.push(fill(cfg.root).replace(/^\/+|\/+$/g, ""));
  if (cfg.split_drafts) parts.push(cfg.keep ? "keepers" : "drafts");
  if (cfg.subfolder.trim()) parts.push(fill(cfg.subfolder).replace(/^\/+|\/+$/g, ""));
  let stem = fill(cfg.name) || "image";
  if (cfg.numbering === "counter") stem += "_" + "1".padStart(cfg.pad, "0");
  else if (cfg.numbering === "time") stem += "_143211";
  else if (cfg.numbering === "seed") stem += "_" + sample["%seed%"];
  return { folder: parts.filter(Boolean).join("/"), stem };
}

let saved = [];
let folders = [];
// Jobs announced by other RedNode panels before a finished file exists. They are
// display-only placeholders; the server remains the source of truth for saved rows.
const pendingSaves = new Map();
// What the last list action did, shown under the header until the next one. A popup
// for "rebuilt 412 images" would have to be dismissed before you could look at them.
let listNote = "";
// Clearing takes two clicks rather than a confirm(), matching Image Review.
let clearArmed = false;
// Chosen cards, by path. Kept out of the node so it survives a re-render, and
// cleared whenever the list is refreshed from the server.
const selected = new Set();

// Which card the keyboard is on. Culling a batch of three hundred is the case this
// panel exists for, and doing that with a mouse is the slow way: arrows to move, one
// key to keep, one to delete, eyes on the picture rather than on the buttons.
let cursor = 0;

// HOW MANY CARDS ARE BUILT AT ONCE.
//
// Every card carries an <img>. `loading="lazy"` only defers the fetch until the image is
// near the viewport, and zoomed out on a big canvas EVERYTHING is near the viewport, so
// a list of three hundred saves decoded three hundred bitmaps at once. That is hundreds
// of megabytes of decoded pixels and a paint cost to match, which is why the lag showed
// up when zoomed out and went away zoomed in.
//
// The list itself is untouched: this bounds what is DRAWN, not what is remembered.
// Nothing is hidden quietly either — the header says how many of how many are shown and
// offers to draw the lot.
let showAll = false;

function shownLimit() {
  if (showAll) return 0;
  const n = Number(wsPref("SaveRecentShown", 25));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 25;
}

/** Newest first, capped. */
function visible() {
  const all = [...saved].reverse();
  const lim = shownLimit();
  return lim > 0 ? all.slice(0, lim) : all;
}

/** How many the cap is holding back, for the header to own up to. */
function hiddenCount() {
  const lim = shownLimit();
  return lim > 0 ? Math.max(0, saved.length - lim) : 0;
}

function rowCount() {
  return visible().length;
}

function atCursor() {
  const rows = visible();
  return rows[Math.max(0, Math.min(rows.length - 1, cursor))] || null;
}

function selectedEntries() {
  return saved.filter((e) => selected.has(e.path) && !e.missing);
}

function downloadImage(entry) {
  const q = new URLSearchParams({ filename: entry.name, type: "output",
                                  subfolder: entry.subfolder || "" });
  const a = document.createElement("a");
  a.href = api.apiURL(`/view?${q}`);
  a.download = entry.name;                  // the browser's own save dialog
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyImage(entry) {
  const q = new URLSearchParams({ filename: entry.name, type: "output",
                                  subfolder: entry.subfolder || "" });
  const blob = await (await fetch(api.apiURL(`/view?${q}`))).blob();
  if (blob.type === "image/png" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return;
  }
  // the clipboard only takes PNG, so anything else goes through a canvas
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  const png = await new Promise((r) => c.toBlob(r, "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

// one request per file rather than a batch route: a failure then names the file it
// happened to, and a partial run still leaves everything else done
async function actOnMany(node, entries, body, verb) {
  const failed = [];
  for (const entry of entries) {
    try {
      const res = await api.fetchApi("/rednode/promote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path, root: node._rnSaveCfg.root, ...body }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
    } catch (e) {
      failed.push(`${entry.name}: ${e.message}`);
    }
  }
  if (failed.length) {
    const nl = String.fromCharCode(10);
    alert(`Could not ${verb} ${failed.length} of ${entries.length}:` + nl + nl
          + failed.slice(0, 6).join(nl));
  }
  selected.clear();
  await refresh();
  // a cull is a walk: after keeping or deleting, stay put rather than being thrown
  // back to the newest image
  const n = rowCount();
  if (n) cursor = Math.max(0, Math.min(n - 1, cursor));
  for (const nd of findNodes(NODE_NAME)) render(nd);
}

function cardMenu(node, entry, ev) {
  document.querySelector(".rn-sv-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "rn-sv-pop rn-sv-menu";
  pop.style.left = `${ev.clientX}px`;
  pop.style.top = `${ev.clientY}px`;
  const add = (label, fn, danger) => {
    const b = document.createElement("div");
    b.textContent = label;
    if (danger) b.style.color = "#e58a97";
    b.onclick = async () => {
      pop.remove();
      try { await fn(); } catch (e) { alert(`${label} failed: ${e.message}`); }
    };
    pop.appendChild(b);
    return b;
  };
  const sep = () => {
    const d = document.createElement("div");
    d.style.cssText = "height:1px;background:#33373d;margin:4px 2px;padding:0";
    pop.appendChild(d);
  };

  const chosen = selectedEntries();
  const many = chosen.length > 1 || (chosen.length === 1 && !selected.has(entry.path));
  const targets = chosen.length ? chosen : [entry];
  const label = targets.length > 1 ? `${targets.length} selected` : entry.name;

  add("Open it full size in a new tab", () => {
    const q = new URLSearchParams({ filename: entry.name, type: "output",
                                    subfolder: entry.subfolder || "" });
    window.open(api.apiURL(`/view?${q}`), "_blank");
  });
  add("Save the image to disk...", () => downloadImage(entry));
  add("Copy the image", () => copyImage(entry));
  sep();
  add(selected.has(entry.path) ? "Deselect this one" : "Select this one", () => {
    if (selected.has(entry.path)) selected.delete(entry.path);
    else selected.add(entry.path);
    render(node);
  });
  add("Select all", () => {
    for (const e of saved) if (!e.missing) selected.add(e.path);
    render(node);
  });
  if (selected.size) {
    add("Clear the selection", () => { selected.clear(); render(node); });
  }
  sep();
  add(`Keep ${label}`, () => actOnMany(node, targets, { keep: true }, "keep"));
  add(`Unkeep ${label}`, () => actOnMany(node, targets, { keep: false }, "unkeep"));
  add(`Delete ${label}`, () => {
    if (confirm(`Delete ${label} and the records beside `
              + `${targets.length > 1 ? "them" : "it"}? This cannot be undone.`)) {
      return actOnMany(node, targets, { action: "delete" }, "delete");
    }
  }, true);
  // The list, not the picture. This is where the clear was looked for, so it is here
  // as well as on the header, and the wording separates it from Delete right above:
  // one forgets rows, the other destroys files.
  sep();
  add("Rebuild the list from the folder", async () => {
    const res = await api.fetchApi("/rednode/rebuild_index", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    listNote = `Rebuilt from the folder: ${d.rebuilt} images, ${d.linked} still `
             + "linked to the run that made them. Nothing was written.";
    selected.clear();
    cursor = 0;
    return refresh();
  });
  add(clearArmed ? "Click again to forget the whole list"
                 : `Forget the whole list (${saved.length}), deleting nothing`,
      () => clearList(node));

  document.body.appendChild(pop);
  const away = (e) => {
    if (!pop.contains(e.target)) {
      pop.remove();
      window.removeEventListener("pointerdown", away, true);
    }
  };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
}
let builtinPresets = {};
let userPresets = {};

// only the naming half travels in a preset. Where files go and what is written
// beside them are separate decisions and should not move when you pick a name style.
const PRESET_KEYS = ["subfolder", "name", "numbering", "pad"];

async function loadPresets() {
  try {
    const res = await api.fetchApi("/rednode/save_presets");
    const d = await res.json();
    builtinPresets = d.builtin || {};
    userPresets = d.presets || {};
  } catch (e) {
    builtinPresets = {}; userPresets = {};
  }
}

async function presetAction(node, body) {
  try {
    const res = await api.fetchApi("/rednode/save_presets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    builtinPresets = d.builtin || {};
    userPresets = d.presets || {};
  } catch (e) {
    alert(e.message);
  }
  render(node);
}

// which preset the current settings match, if any
function currentPreset(cfg) {
  const all = { ...builtinPresets, ...userPresets };
  for (const [name, p] of Object.entries(all)) {
    if (PRESET_KEYS.every((k) => String(p[k] ?? DEFAULTS[k]) === String(cfg[k]))) {
      return name;
    }
  }
  return "";
}

// The browser cannot open a folder, but the machine running ComfyUI can, so the
// server does it. Only useful when that is the same machine you are sitting at.
async function openFolder(path) {
  try {
    const res = await api.fetchApi("/rednode/open_folder", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path || "" }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
  } catch (e) {
    alert(`Could not open it: ${e.message}`);
  }
}

// where the current settings put things, without the filename on the end
function folderFor(cfg, keep) {
  const sample = SAMPLES;
  const fill = (t) => String(t || "").replace(/%[a-z]+%/g,
    (k) => (sample[k] !== undefined ? sample[k] : k));
  const parts = [];
  if (cfg.root.trim()) parts.push(fill(cfg.root));
  if (cfg.split_drafts) parts.push(keep ? "keepers" : "drafts");
  if (cfg.subfolder.trim()) parts.push(fill(cfg.subfolder));
  return parts.join("/").replace(/^\/+|\/+$/g, "");
}

async function refresh() {
  try {
    const res = await api.fetchApi("/rednode/saved");
    saved = (await res.json()).saved || [];
    const alive = new Set(saved.map((e) => e.path));
    for (const p of [...selected]) if (!alive.has(p)) selected.delete(p);
  } catch (e) { saved = []; }
  for (const n of findNodes(NODE_NAME)) render(n);
}

async function loadFolders() {
  try {
    const res = await api.fetchApi("/rednode/save_folders");
    folders = (await res.json()).folders || [];
  } catch (e) { folders = []; }
}

function popup(anchor, options, onPick) {
  document.querySelector(".rn-sv-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "rn-sv-pop";
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  if (!options.length) {
    const none = document.createElement("div");
    none.textContent = "no folders under output yet";
    pop.appendChild(none);
  }
  for (const opt of options) {
    const row = document.createElement("div");
    row.textContent = opt;
    row.onclick = () => { pop.remove(); onPick(opt); };
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  const away = (e) => {
    if (!pop.contains(e.target)) { pop.remove(); window.removeEventListener("pointerdown", away, true); }
  };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
}

function textRow(node, cfg, key, placeholder, withPicker) {
  const row = document.createElement("div");
  row.className = "rn-sv-row";
  const input = document.createElement("input");
  input.type = "text";
  input.value = cfg[key];
  input.placeholder = placeholder;
  input.oninput = () => { cfg[key] = input.value; writeCfg(node); paint(node); };
  row.appendChild(input);
  if (withPicker) {
    const pick = document.createElement("button");
    pick.className = "rn-sv-btn";
    pick.textContent = "Browse";
    pick.title = "Folders that already exist under ComfyUI's output directory. "
               + "You can also just type one; it is made if it is not there.";
    pick.onclick = async () => {
      if (!folders.length) await loadFolders();
      popup(pick, folders, (v) => {
        cfg[key] = v; writeCfg(node); render(node);
      });
    };
    row.appendChild(pick);
  }
  return { row, input };
}

function chips(node, cfg, key, target) {
  const wrap = document.createElement("div");
  wrap.className = "rn-sv-chips";
  for (const [label, token, sample] of TOKENS) {
    const chip = document.createElement("span");
    chip.className = "rn-sv-chip";
    chip.textContent = label;
    chip.title = `inserts ${token}, which becomes ${sample}`;
    chip.onclick = () => {
      cfg[key] = (cfg[key] || "") + token;
      target.value = cfg[key];
      writeCfg(node); paint(node);
    };
    wrap.appendChild(chip);
  }
  return wrap;
}

function toggle(node, cfg, key, label, tip) {
  const b = document.createElement("button");
  b.className = "rn-sv-btn" + (cfg[key] ? " on" : "");
  b.textContent = label;
  b.title = tip;
  b.onclick = () => { cfg[key] = !cfg[key]; writeCfg(node); render(node); };
  return b;
}

// only the preview needs redrawing while typing; rebuilding the panel would steal focus
function paint(node) {
  const el = node._rnSavePreview;
  if (!el) return;
  const cfg0 = node._rnSaveCfg;
  const { folder, stem } = previewPath(cfg0);
  el.textContent = "";
  el.append(document.createTextNode("output/" + (folder ? folder + "/" : "")));
  const b = document.createElement("b");
  b.textContent = stem + (EXT[cfg0.format] || ".png");
  el.appendChild(b);
  const cfg = node._rnSaveCfg;
  const extras = [cfg.write_text ? stem + ".txt" : null,
                  cfg.write_json ? stem + ".rn.json" : null].filter(Boolean);
  if (extras.length) {
    el.append(document.createElement("br"));
    const note = document.createElement("span");
    note.style.opacity = ".65";
    note.textContent = "beside it: " + extras.join(", ");
    el.appendChild(note);
  }
}

// Forgetting the list, from wherever it is asked for: the header button and the row
// menu are the same act and must not drift into two behaviours. Two clicks within
// four seconds, the same as Image Review's Clear ALL history, because a confirm()
// steals focus mid-cull and a one-click wipe of a session's list is too easy.
async function clearList(node) {
  if (!clearArmed) {
    clearArmed = true;
    setTimeout(() => {
      clearArmed = false;
      for (const n of findNodes(NODE_NAME)) render(n);
    }, 4000);
    render(node);
    return;
  }
  clearArmed = false;
  try {
    const res = await api.fetchApi("/rednode/clear_saved", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const d = await res.json();
    listNote = `Forgot ${d.cleared ?? 0} rows. No file was deleted; Rebuild from `
             + "folder lists them again.";
  } catch (e) {
    listNote = `Could not clear it: ${e.message}`;
  }
  selected.clear();
  cursor = 0;
  refresh();
}

function section(title) {
  const s = document.createElement("div");
  s.className = "rn-sv-sect";
  const l = document.createElement("div");
  l.className = "rn-sv-lab";
  l.textContent = title;
  s.appendChild(l);
  return s;
}

function render(node) {
  const wrap = node._rnSaveEl;
  if (!wrap) return;
  const cfg = node._rnSaveCfg;
  // the list is rebuilt every render, so clicking a row deep in it would jump the
  // scroll back to the top. Remember where it was and put it back afterwards.
  const keepScroll = wrap.querySelector(".rn-sv-list")?.scrollTop || 0;
  const keepPanel = wrap.scrollTop || 0;
  wrap.textContent = "";

  // ---- naming presets ---------------------------------------------------
  const pres = document.createElement("div");
  pres.className = "rn-sv-row";
  const sel = document.createElement("select");
  sel.className = "rn-sv-sel";
  const here = currentPreset(cfg);
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = here ? here : "custom";
  sel.appendChild(blank);
  for (const [group, set] of [["Built in", builtinPresets], ["Saved", userPresets]]) {
    const names = Object.keys(set);
    if (!names.length) continue;
    const g = document.createElement("optgroup");
    g.label = group;
    for (const name of names.sort()) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  sel.value = "";
  sel.title = "A naming convention: the subfolder, the filename and the numbering. "
            + "Where files go and what is written beside them do not change.";
  sel.onchange = () => {
    const p = { ...builtinPresets, ...userPresets }[sel.value];
    if (!p) return;
    for (const k of PRESET_KEYS) if (p[k] !== undefined) cfg[k] = p[k];
    writeCfg(node); render(node);
  };
  pres.appendChild(sel);

  const saveBtn = document.createElement("button");
  saveBtn.className = "rn-sv-btn";
  saveBtn.textContent = "Save";
  saveBtn.title = "Save the subfolder, name and numbering above as a named convention.";
  saveBtn.onclick = () => {
    const name = prompt("Name this naming convention:", here || "");
    if (!name) return;
    presetAction(node, { action: "save", name, config: cfg });
  };
  pres.appendChild(saveBtn);

  if (here && userPresets[here]) {
    const del = document.createElement("button");
    del.className = "rn-sv-btn";
    del.textContent = "Delete";
    del.title = `Delete the saved convention "${here}".`;
    del.onclick = () => {
      if (confirm(`Delete the naming convention "${here}"?`)) {
        presetAction(node, { action: "delete", name: here });
      }
    };
    pres.appendChild(del);
  }
  wrap.appendChild(pres);

  const preview = document.createElement("div");
  preview.className = "rn-sv-preview";
  node._rnSavePreview = preview;
  wrap.appendChild(preview);
  paint(node);

  const where = section("Where");
  const root = textRow(node, cfg, "root", "output root (blank = straight into output)", true);
  const openBtn = document.createElement("button");
  openBtn.className = "rn-sv-btn";
  openBtn.textContent = "Open";
  openBtn.title = "Open this folder in the file browser, on the machine running "
                + "ComfyUI. Right-clicking the node has the same options.";
  openBtn.onclick = () => openFolder(folderFor(cfg, cfg.keep));
  root.row.appendChild(openBtn);
  where.appendChild(root.row);
  const sub = textRow(node, cfg, "subfolder", "subfolder, slashes make levels", false);
  where.appendChild(sub.row);
  where.appendChild(chips(node, cfg, "subfolder", sub.input));
  const split = document.createElement("div");
  split.className = "rn-sv-toggles";
  split.append(
    toggle(node, cfg, "split_drafts", "Drafts and keepers",
           "Adds a drafts or keepers level to the path. Off puts everything together."),
    toggle(node, cfg, "keep", cfg.keep ? "Saving as: keeper" : "Saving as: draft",
           "Which side this run lands on. Drafts can be promoted later from the list "
           + "below, so leaving this on draft costs nothing."));
  where.appendChild(split);
  wrap.appendChild(where);

  const naming = section("Name");
  const name = textRow(node, cfg, "name", "filename, before the number", false);
  naming.appendChild(name.row);
  naming.appendChild(chips(node, cfg, "name", name.input));
  const numRow = document.createElement("div");
  numRow.className = "rn-sv-row";
  for (const [id, label, tip] of NUMBERING) {
    const b = document.createElement("button");
    b.className = "rn-sv-btn" + (cfg.numbering === id ? " on" : "");
    b.textContent = label;
    b.title = tip;
    b.onclick = () => { cfg.numbering = id; writeCfg(node); render(node); };
    numRow.appendChild(b);
  }
  if (cfg.numbering === "counter") {
    const pad = document.createElement("button");
    pad.className = "rn-sv-btn";
    pad.textContent = `${cfg.pad} digits`;
    pad.title = "How many digits the counter is padded to. Click to cycle.";
    pad.onclick = () => {
      cfg.pad = cfg.pad >= 6 ? 1 : cfg.pad + 1;
      writeCfg(node); render(node);
    };
    numRow.appendChild(pad);
  }
  naming.appendChild(numRow);
  wrap.appendChild(naming);

  const fileSect = section("File");
  const fmtRow = document.createElement("div");
  fmtRow.className = "rn-sv-row";
  for (const [id, label, , tip] of FORMATS) {
    const b = document.createElement("button");
    b.className = "rn-sv-btn" + (cfg.format === id ? " on" : "");
    b.textContent = label;
    b.title = tip;
    b.onclick = () => { cfg.format = id; writeCfg(node); render(node); };
    fmtRow.appendChild(b);
  }
  fileSect.appendChild(fmtRow);
  {
    // PNG is lossless, so it gets a compression level instead of a quality: same
    // pixels either way, only the file size and the save time move.
    const png = cfg.format === "png";
    const key = png ? "compress" : "quality";
    const qRow = document.createElement("div");
    qRow.className = "rn-sv-row";
    const lab = document.createElement("span");
    lab.className = "rn-sv-note";
    lab.style.flex = "none";
    lab.textContent = png ? "Compression" : "Quality";
    lab.title = png
      ? "0 is fastest and biggest, 9 is slowest and smallest. The image is identical "
      + "at every level, because PNG is lossless. There is no quality to trade."
      : "Higher keeps more detail and makes a bigger file.";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = png ? "0" : "1";
    slider.max = png ? "9" : "100";
    slider.step = "1";
    slider.value = String(cfg[key]);
    slider.style.flex = "1";
    const val = document.createElement("span");
    val.className = "rn-sv-note";
    val.style.flex = "none";
    const showQ = () => {
      val.textContent = png
        ? `${cfg.compress}${cfg.compress === 0 ? " (fastest)"
                            : cfg.compress >= 9 ? " (smallest)" : ""}`
        : (cfg.format === "webp" && cfg.quality >= 100 ? "100 (lossless)"
                                                       : String(cfg.quality));
    };
    showQ();
    slider.oninput = () => {
      cfg[key] = parseInt(slider.value) || (png ? 0 : 90);
      showQ();
    };
    slider.onchange = () => { writeCfg(node); render(node); };
    qRow.append(lab, slider, val);
    fileSect.appendChild(qRow);
  }
  wrap.appendChild(fileSect);

  const record = section("What gets written beside it");
  const recRow = document.createElement("div");
  recRow.className = "rn-sv-toggles";
  recRow.append(
    toggle(node, cfg, "write_text", "Text record",
           "A plain .txt with the prompts and settings laid out for reading. This is the "
           + "portable one: unlike PNG metadata it can be read by eye, by a script, or by "
           + "another front end."),
    toggle(node, cfg, "write_json", "JSON",
           "The same information as machine-readable JSON."),
    cfg.format === "png"
      ? toggle(node, cfg, "embed_png", "Embedded workflow",
               "The usual ComfyUI blob inside the PNG, so dragging the image back in "
               + "rebuilds the graph. Only ComfyUI reads this.")
      : (() => {
          const b = document.createElement("button");
          b.className = "rn-sv-btn";
          b.textContent = "Embedded workflow";
          b.style.opacity = ".45";
          b.style.cursor = "not-allowed";
          b.title = `A ${cfg.format} cannot carry a ComfyUI workflow that anything `
                  + "reads back. Switch to PNG for that, or keep the text record, "
                  + "which is more portable anyway.";
          b.onclick = () => {};
          return b;
        })());
  record.appendChild(recRow);
  if (!cfg.write_text && !cfg.write_json
      && (cfg.format !== "png" || !cfg.embed_png)) {
    const clean = document.createElement("div");
    clean.className = "rn-sv-note";
    clean.textContent = "Nothing is recorded: the image is saved clean, with no "
                      + "metadata and no files beside it.";
    record.appendChild(clean);
  }
  const pf = textRow(node, cfg, "prompts_folder",
                     "optional: also copy every text record into this folder", true);
  record.appendChild(pf.row);
  if (!cfg.write_text && cfg.prompts_folder.trim()) {
    const warn = document.createElement("div");
    warn.className = "rn-sv-note";
    warn.textContent = "The prompts folder only gets copies while the text record is on.";
    record.appendChild(warn);
  }
  wrap.appendChild(record);

  const recent = section("Recent saves");
  // The actions for the LIST ITSELF live here. The clear existed for weeks on the
  // NODE's right-click menu, which is the one place nobody looks for a control that
  // belongs to a panel, so it read as missing entirely.
  {
    const bar = document.createElement("div");
    bar.className = "rn-sv-row";
    const count = document.createElement("span");
    count.className = "rn-sv-note";
    count.style.flex = "1";
    const dead = saved.filter((e) => e.missing).length;
    const held = hiddenCount();
    count.textContent = saved.length
      ? `${held ? `${visible().length} of ${saved.length} shown` : `${saved.length} listed`}`
        + `${dead ? `, ${dead} whose file is gone` : ""}`
        + (pendingSaves.size ? ` · ${pendingSaves.size} processing` : "")
      : (pendingSaves.size ? `${pendingSaves.size} processing` : "nothing listed");
    bar.appendChild(count);

    // never a silent cap: say what is held back and offer to draw it
    if (held) {
      const more = document.createElement("button");
      more.className = "rn-sv-btn";
      more.textContent = `Show all ${saved.length}`;
      more.title = `${held} more are listed but not drawn. Every card decodes its own `
                 + "image, so drawing hundreds at once costs hundreds of megabytes and "
                 + "makes the canvas crawl when zoomed out. This lasts until reload.";
      more.onclick = () => { showAll = true; render(node); };
      bar.appendChild(more);
    } else if (showAll && saved.length > 25) {
      const less = document.createElement("button");
      less.className = "rn-sv-btn";
      less.textContent = "Show fewer";
      less.title = "Go back to drawing only the newest few.";
      less.onclick = () => { showAll = false; render(node); };
      bar.appendChild(less);
    }

    const rebuild = document.createElement("button");
    rebuild.className = "rn-sv-btn";
    rebuild.textContent = "Rebuild from folder";
    rebuild.title = "Read the output folder and list what is really in it, newest "
                  + "first. Writes nothing, deletes nothing. This is the way back "
                  + "from a list that has drifted from the folder or been cleared. "
                  + "Images saved before the run id was written beside them come "
                  + "back listed but unlinked, so Image Review cannot recover their "
                  + "previews.";
    rebuild.onclick = async () => {
      // This lists EVERYTHING in the output folder, which after a long session is
      // thousands of files. The drawing cap keeps that from being felt straight away,
      // but the list itself still grows, and someone who then lifts the cap gets every
      // one of them decoded at once. Say so before it happens rather than after.
      if (!confirm("Rebuild the list from the output folder?\n\n"
                 + "This lists every image the folder holds, which can be thousands "
                 + "after a long session. Nothing is written or deleted.\n\n"
                 + `Only the newest ${shownLimit() || "few"} are drawn, so the canvas `
                 + "stays quick, but a very long list still costs memory. Use Clear list "
                 + "afterwards if you only wanted a few back.")) {
        return;
      }
      rebuild.disabled = true;
      rebuild.textContent = "Rebuilding...";
      try {
        const res = await api.fetchApi("/rednode/rebuild_index", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        listNote = `Rebuilt from the folder: ${d.rebuilt} images, ${d.linked} still `
                 + "linked to the run that made them. Nothing was written.";
      } catch (e) {
        listNote = `Could not rebuild it: ${e.message}`;
      }
      selected.clear();
      cursor = 0;
      refresh();
    };
    bar.appendChild(rebuild);

    if (saved.length) {
      const wipe = document.createElement("button");
      wipe.className = "rn-sv-btn";
      wipe.textContent = clearArmed ? "Click again to clear" : "Clear list";
      if (clearArmed) wipe.style.borderColor = "#7f1d1d";
      wipe.title = "Forget every row. Nothing is deleted: every image and every "
                 + "record stays exactly where it is. They stop being listed, and "
                 + "Image Review can no longer recover their previews. Rebuild from "
                 + "folder is the way back.";
      wipe.onclick = () => clearList(node);
      bar.appendChild(wipe);
    }
    recent.appendChild(bar);
    if (listNote) {
      const n = document.createElement("div");
      n.className = "rn-sv-note";
      n.textContent = listNote;
      recent.appendChild(n);
    }
  }
  if (selected.size) {
    const bar = document.createElement("div");
    bar.className = "rn-sv-row rn-sv-selbar";
    const count = document.createElement("span");
    count.className = "rn-sv-note";
    count.style.flex = "1";
    count.textContent = `${selected.size} selected`;
    bar.appendChild(count);
    const chosen = () => selectedEntries();
    for (const [label, body, verb, danger] of [
      ["Keep", { keep: true }, "keep", false],
      ["Unkeep", { keep: false }, "unkeep", false],
      ["Delete", { action: "delete" }, "delete", true],
    ]) {
      const b = document.createElement("button");
      b.className = "rn-sv-btn";
      if (danger) b.style.borderColor = "#7f1d1d";
      b.textContent = label;
      b.onclick = () => {
        const targets = chosen();
        if (!targets.length) return;
        if (danger && !confirm(`Delete ${targets.length} images and their records? `
                             + "This cannot be undone.")) return;
        actOnMany(node, targets, body, verb);
      };
      bar.appendChild(b);
    }
    const clr = document.createElement("button");
    clr.className = "rn-sv-btn";
    // "Clear selection", not "Clear": there is a Clear list in the header now, and
    // one of them forgets a few ticks while the other forgets the whole session
    clr.textContent = "Clear selection";
    clr.title = "Unpick these cards. Nothing else changes.";
    clr.onclick = () => { selected.clear(); render(node); };
    bar.appendChild(clr);
    recent.appendChild(bar);
  }

  const at = atCursor();
  if (at && !at.missing) {
    const big = document.createElement("div");
    big.className = "rn-sv-big";
    const bimg = document.createElement("img");
    const bq = new URLSearchParams({ filename: at.name, type: "output",
                                     subfolder: at.subfolder || "" });
    bimg.src = api.apiURL(`/view?${bq}&rand=${at.when || 0}`);
    bimg.onerror = () => { big.style.display = "none"; };
    big.appendChild(bimg);
    // the state on the picture itself, because during a cull your eyes are here and
    // not on the little tag under a card forty rows down
    const mark = document.createElement("div");
    mark.className = "rn-sv-keptmark" + (at.kept ? "" : " draft");
    mark.textContent = at.kept ? "KEEPER" : "draft";
    big.appendChild(mark);
    const cap = document.createElement("div");
    cap.className = "rn-sv-note";
    cap.textContent = `${cursor + 1} of ${rowCount()}  ·  ${at.name}`;
    big.appendChild(cap);
    recent.appendChild(big);
  }

  const list = document.createElement("div");
  list.className = "rn-sv-list";
  if (!saved.length && !pendingSaves.size) {
    const empty = document.createElement("div");
    empty.className = "rn-sv-note";
    empty.textContent = "Nothing saved yet this session.";
    list.appendChild(empty);
  }
  for (const pending of pendingSaves.values()) {
    const row = document.createElement("div");
    row.className = "rn-sv-item pending";
    const spin = document.createElement("div");
    spin.className = "rn-sv-pending-spin";
    const name = document.createElement("div");
    name.className = "rn-sv-name";
    name.textContent = "FINAL PROCESSING";
    const note = document.createElement("div");
    note.className = "rn-sv-note";
    note.textContent = pending.message || "Preparing the saved result…";
    row.append(spin, name, note);
    list.appendChild(row);
  }
  const rows = visible();
  cursor = Math.max(0, Math.min(rows.length - 1, cursor));
  rows.forEach((entry, idx) => {
    const row = document.createElement("div");
    row.className = "rn-sv-item" + (entry.kept ? " kept" : "")
                  + (entry.missing ? " gone" : "")
                  + (selected.has(entry.path) ? " picked" : "");
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cardMenu(node, entry, e);
    };

    if (!entry.missing) {
      const th = document.createElement("img");
      th.className = "rn-sv-thumb";
      th.loading = "lazy";              // hundreds of cards, fetched as you reach them
      th.decoding = "async";
      const q = new URLSearchParams({ filename: entry.name, type: "output",
                                      subfolder: entry.subfolder || "" });
      // Resized SERVER side. A browser decodes an image at its natural size however
      // small it is drawn, so a grid of cards pointed at full originals holds a bitmap
      // each, and this grid runs to hundreds. The big picture above still uses /view.
      th.src = api.apiURL(`/rednode/thumb?${q}&px=320&rand=${entry.when || 0}`);
      th.title = `${entry.path}

Click to bring it up above, or to pick it once something is selected. `
               + "Right-click to open it full size, and for everything else.";
      th.onclick = () => {
        // once anything is chosen, clicking picks rather than moves: that is what a
        // selection is for
        if (selected.size) {
          if (selected.has(entry.path)) selected.delete(entry.path);
          else selected.add(entry.path);
          render(node);
          return;
        }
        // A CLICK MOVES THE CURSOR, it does not launch a browser tab. Everywhere else
        // in the pack a click on a picture selects it and shows it larger in place;
        // this one card grid used to throw you into a new tab instead, which is both a
        // different rule to learn and a hard thing to undo mid-cull. Full size is on
        // the right-click menu, where the rest of the per-image actions already live.
        cursor = idx;
        render(node);
      };
      th.onerror = () => {
        // the resize route first: an older install, a Pillow without webp or any 500
        // should cost sharpness and memory, never the picture. Only hide once the
        // original has failed too.
        if (!th.dataset.rnFullTried) {
          th.dataset.rnFullTried = "1";
          th.src = api.apiURL(`/view?${q}&rand=${entry.when || 0}`);
          return;
        }
        th.style.display = "none";
      };
      row.appendChild(th);
    }

    const head = document.createElement("div");
    head.className = "rn-sv-row";
    const tag = document.createElement("span");
    tag.className = "rn-sv-tag" + (entry.kept ? " kept" : "");
    tag.textContent = entry.missing ? "gone" : (entry.kept ? "keeper" : "draft");
    head.appendChild(tag);
    const nm = document.createElement("div");
    nm.className = "rn-sv-name";
    nm.style.flex = "1";
    nm.textContent = entry.name;
    nm.title = entry.path;
    head.appendChild(nm);
    row.appendChild(head);
    const act = async (body, failed) => {
      try {
        const res = await api.fetchApi("/rednode/promote", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: entry.path, root: cfg.root, ...body }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
      } catch (e) {
        alert(`${failed}: ${e.message}`);
      }
      refresh();
    };
    const acts = document.createElement("div");
    acts.className = "rn-sv-acts";
    if (!entry.missing) {
      const k = document.createElement("button");
      k.className = "rn-sv-btn" + (entry.kept ? " on" : "");
      k.textContent = entry.kept ? "Unkeep" : "Keep";
      k.title = entry.kept
        ? "Move it back to drafts. Keeping is only a move, so it undoes cleanly."
        : "Move this draft, and the files written beside it, into the keepers folder.";
      k.onclick = () => act({ keep: !entry.kept }, "Could not move it");
      acts.appendChild(k);

      const del = document.createElement("button");
      del.className = "rn-sv-btn";
      del.textContent = "Delete";
      del.title = "Delete this image and anything written beside it. Not recoverable.";
      del.onclick = () => {
        if (confirm(`Delete ${entry.name} and its records? This cannot be undone.`)) {
          act({ action: "delete" }, "Could not delete it");
        }
      };
      acts.appendChild(del);
      row.appendChild(acts);
    }
    if (idx === cursor) {
      row.classList.add("at");
      // keep the cursor on screen while the arrows walk past the fold
      requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
    }
    list.appendChild(row);
  });
  recent.appendChild(list);
  // restore after this frame, once the rebuilt rows actually have a height
  requestAnimationFrame(() => {
    if (keepScroll) list.scrollTop = keepScroll;
    if (keepPanel) wrap.scrollTop = keepPanel;
  });

  wrap.appendChild(recent);
}

function build(node) {
  if (!node.addDOMWidget || node._rnSaveEl) return;
  injectStyle();
  const w = findWidget(node, "config");
  if (w) {                       // the JSON is the storage, the panel is the interface
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
  }
  node._rnSaveCfg = readCfg(node);
  const wrap = document.createElement("div");
  wrap.className = "rn-sv-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                   "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  bindSliderWheel(wrap);      // wheel over the quality slider adjusts it
  node._rnSaveEl = wrap;

  // The culling loop. Arrows walk, K keeps or unkeeps, Delete removes. This is the
  // case the whole panel is for: three hundred images made, and the job is deciding
  // which six matter. Doing that through a mouse is the slow way round.
  arrowKeys(wrap, (dir) => {
    const n = rowCount();
    if (!n) return;
    cursor = dir === "first" ? 0
           : dir === "last" ? n - 1
           : Math.max(0, Math.min(n - 1, cursor + dir));
    render(node);
  });
  wrap.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const entry = atCursor();
    if (!entry || entry.missing) return;
    const key = e.key.toLowerCase();
    if (key === "k" || key === " ") {
      e.preventDefault();
      e.stopPropagation();
      actOnMany(node, [entry], { keep: !entry.kept }, "keep");
    } else if (key === "delete" || key === "backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`Delete ${entry.name} and its records? This cannot be undone.`)) {
        actOnMany(node, [entry], { action: "delete" }, "delete");
      }
    }
  });
  wrap.tabIndex = 0;                  // so the panel can receive the key at all
  const dom = node.addDOMWidget("rednode_save_ui", "rednode_save_ui", wrap, {
    serialize: false, getValue: () => "", setValue: () => {},
    getMinHeight: () => MIN_PANEL_H,
  });
  dom.element = wrap;
  dom.options.getMinHeight = () => MIN_PANEL_H;

  // The frontend assigns node.imgs from every executed event and draws them under the
  // widgets, which would show every saved image a second time below the panel. The
  // panel owns display here, so the assignment is swallowed at the property level;
  // overriding onExecuted alone does not stop it on current frontends. Same fix as
  // RedNode Image Review.
  try {
    Object.defineProperty(node, "imgs", {
      get() { return undefined; },
      set(v) { /* the panel's own preview is the display */ },
      configurable: true,
    });
  } catch (e) { /* already defined elsewhere; the panel still shows the picture */ }
  if (node.size?.[0] < 380) node.size[0] = 380;
  render(node);
  refresh();
  loadFolders();
  loadPresets().then(() => render(node));
}

app.registerExtension({
  name: "RedNode.Save",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    // right-click the node itself: straight to the folders it writes to
    const onMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      onMenu?.apply(this, arguments);
      const cfg = this._rnSaveCfg || DEFAULTS;
      const last = [...saved].reverse().find((e) => !e.missing);
      options.push(
        { content: `Clear the recent saves list (${saved.length})`,
          callback: async () => {
            if (!confirm(`Forget the ${saved.length} images in this list?

`
                       + "Nothing is deleted. Every file and record stays where it "
                       + "is; they simply stop being listed here, and Image Review "
                       + "can no longer recover their previews.")) {
              return;
            }
            try {
              await fetch(api.apiURL("/rednode/clear_saved"),
                          { method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: "{}" });
            } catch (e) {
              alert(`Could not clear it: ${e.message}`);
            }
            selected.clear();
            cursor = 0;
            refresh();
          } },
        { content: "Open the drafts folder",
          callback: () => openFolder(folderFor(cfg, false)) },
        { content: "Open the keepers folder",
          callback: () => openFolder(folderFor(cfg, true)) },
        { content: last ? "Open the folder of the last save"
                        : "Open the output folder",
          callback: () => openFolder(last ? last.path : "") },
      );
      return options;
    };
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      // a loaded workflow brings its own saved settings
      this._rnSaveCfg = readCfg(this);
      render(this);
    };
  },
  setup() {
    api.addEventListener?.("executed", (e) => {
      if (e?.detail?.output?.images) refresh();
    });
    // another node kept or unkept something: the list here is now stale
    api.addEventListener?.("rednode.saved_changed", () => refresh());
    api.addEventListener?.("rednode.save_pending", (e) => {
      const d = e?.detail || {};
      const id = String(d.id || "");
      if (!id) return;
      if (d.state === "start") {
        pendingSaves.set(id, { message: String(d.message || "") });
        for (const n of findNodes(NODE_NAME)) render(n);
        return;
      }
      pendingSaves.delete(id);
      if (d.state === "done") {
        refresh(); // the keeper route has completed; replace the placeholder now
      } else {
        listNote = d.message ? `Final save failed: ${d.message}` : "Final save failed.";
        for (const n of findNodes(NODE_NAME)) render(n);
      }
    });
  },
});
