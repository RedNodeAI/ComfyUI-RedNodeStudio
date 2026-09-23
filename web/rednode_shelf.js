// RedNode Shelf - pictures you are carrying between tabs.
//
// Drop them on, drag them off. The gesture is the same at both ends as the rest of
// the pack: a drag carries the pack's own record (application/x-rednode-result) plus
// the picture's real URL, so a gallery, the Paint pane, another shelf and a folder on
// the desktop all take it. The DRAG SOURCE is the cell, never the <img>: a dragged
// image carries the browser's own payload for its src, and in a thumbnail strip that
// src is the small copy (2026-09-23).
//
// Dragging out COPIES. Removing is a right-click, so a misfired drag never loses a
// picture, and nothing here is written to disk: the shelf stores the same
// "name.png [output]" entries the galleries use.
import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import * as _apimod from "../../scripts/api.js";
const { api } = _apimod;

const NODE = "RedNodeShelf";
const MIN_H = 150;

const parseEntry = (entry) => {
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(entry));
  const full = (m?.[1] || "").trim();
  const slash = full.lastIndexOf("/");
  return { filename: slash < 0 ? full : full.slice(slash + 1),
           subfolder: slash < 0 ? "" : full.slice(0, slash),
           type: m?.[2] || "input" };
};
const viewUrl = (entry) => {
  const p = parseEntry(entry);
  return api.apiURL(`/view?filename=${encodeURIComponent(p.filename)}`
    + `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}`);
};
const thumbUrl = (entry, px = 260) => {
  const p = parseEntry(entry);
  return api.apiURL(`/rednode/thumb?filename=${encodeURIComponent(p.filename)}`
    + `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}&px=${px}`);
};
const entryOf = (rec) => {
  if (!rec || !rec.filename) return "";
  const name = rec.subfolder ? `${rec.subfolder}/${rec.filename}` : rec.filename;
  return rec.type && rec.type !== "input" ? `${name} [${rec.type}]` : name;
};

/** Put an entry on the shelf, newest first. Returns whether it was new. */
function addEntry(node, entry) {
  const cfg = node._rnShelf;
  if (!entry) return false;
  const at = cfg.items.indexOf(entry);
  if (at >= 0) cfg.items.splice(at, 1);        // already here: it comes back to the top
  cfg.items.unshift(entry);
  cfg.sel = 0;
  return at < 0;
}

/** A ComfyUI picture URL as a gallery entry, or "".
 *
 *  A picture dragged from somewhere that draws it small - ComfyUI's own queue strip,
 *  the assets panel, a thumbnail anywhere - hands over the SMALL file, and uploading
 *  that would put a 260px copy on the shelf (you, 2026-09-23). Both our thumbnail
 *  route and core's /view name the real file in their query, so the entry is read
 *  from the URL and the full picture is what the shelf holds.
 */
function entryFromUrl(text) {
  const raw = String(text || "").split("\n")[0].split("\r")[0].trim();
  if (!raw || !/(\/view|\/rednode\/thumb)\?/.test(raw)) return "";
  let q;
  try { q = new URL(raw, window.location?.href || "http://localhost").searchParams; }
  catch (e) { return ""; }
  const filename = q.get("filename") || "";
  if (!filename) return "";
  return entryOf({ filename, subfolder: q.get("subfolder") || "",
                   type: q.get("type") || "input" });
}

function readCfg(node) {
  const w = (node.widgets || []).find((x) => x.name === "config");
  let d;
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object") d = {};
  d.items = Array.isArray(d.items) ? d.items.filter((x) => String(x).trim()) : [];
  d.sel = typeof d.sel === "number" ? d.sel : 0;
  if (d.sel < 0 || d.sel >= d.items.length) d.sel = 0;
  // the override, mirrored in shelf.py's parse(): the switch, where the picture
  // goes, and when it was switched on, which is how two shelves are told apart
  d.override = !!d.override;
  d.override_tabs = Array.isArray(d.override_tabs)
    ? SEND_TO.map(([id]) => id).filter((id) => d.override_tabs.includes(id))
    : [...OVERRIDE_DEFAULT];
  d.override_at = typeof d.override_at === "number" ? d.override_at : 0;
  return d;
}

function writeCfg(node) {
  const w = (node.widgets || []).find((x) => x.name === "config");
  if (w) w.value = JSON.stringify(node._rnShelf);
  node.graph?.change?.();
}

/** Where a picture can be sent from the shelf, and the tab it lands on. */
const SEND_TO = [
  ["i2i", "Img2Img"],
  ["editor_src", "the Editor"],
  ["subject", "Subject"],
  ["scene", "Scene"],
  ["moodboard", "Moodboard"],
];
// The chips an override offers, and the one it starts with. Img2Img alone,
// because that is the picture a run works on: ticking Subject or Moodboard
// switches those tabs on for the run, and one switch should not rewrite a render.
const OVERRIDE_LABEL = { i2i: "Img2Img", editor_src: "Editor", subject: "Subject",
                         scene: "Scene", moodboard: "Moodboard" };
const OVERRIDE_DEFAULT = ["i2i"];

function workspaces() {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n?.type === "RedNodeStudioWorkspace") out.push(n);
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return out;
}

/** Every shelf on the canvas, this one included. */
function shelves() {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n?.type === NODE) out.push(n);
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return out;
}

/** Switch this shelf's override on or off, and off on every other shelf.
 *
 *  ONE OVERRIDE AT A TIME, decided here rather than at the run: two shelves both
 *  claiming to be the picture is a question with no good answer, and the moment
 *  to settle it is the click, while you can see both of them. The run keeps its
 *  own guard for a workflow that arrives with two switched on already.
 */
function setOverride(node, on) {
  node._rnShelf.override = !!on;
  node._rnShelf.override_at = on ? Date.now() : 0;
  writeCfg(node);
  if (!on) return;
  for (const other of shelves()) {
    if (other === node) continue;
    const w = (other.widgets || []).find((x) => x.name === "config");
    let d;
    try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
    if (!d || typeof d !== "object" || !d.override) continue;
    d.override = false;
    d.override_at = 0;
    if (w) w.value = JSON.stringify(d);
    if (other._rnShelf) { other._rnShelf.override = false; other._rnShelf.override_at = 0; }
    if (other._rnShelfEl) render(other);
    other.setDirtyCanvas?.(true, true);
  }
}

/** Put an entry on a Workspace tab's gallery, the way a drop on that tab would. */
function sendTo(entry, tab) {
  const ws = workspaces()[0];
  if (!ws) {
    alert("No RedNode Studio Workspace on the canvas to send it to.");
    return;
  }
  const cfgW = (ws.widgets || []).find((x) => x.name === "config");
  let cfg;
  try { cfg = JSON.parse(cfgW?.value || "{}"); } catch (e) { cfg = {}; }
  cfg.tabs = cfg.tabs && typeof cfg.tabs === "object" ? cfg.tabs : {};
  const t = (cfg.tabs[tab] = cfg.tabs[tab] && typeof cfg.tabs[tab] === "object"
    ? cfg.tabs[tab] : {});
  t.images = Array.isArray(t.images) ? t.images : [];
  if (!t.images.includes(entry)) t.images.push(entry);
  // the picture is the one in use on that tab, which is what "send" means
  const at = t.images.indexOf(entry);
  t.sel = Array.isArray(t.sel) ? [at] : at;
  if (t.on === false) t.on = true;
  if (cfgW) cfgW.value = JSON.stringify(cfg);
  ws._rnCfg = null;
  ws.onConfigure?.({});
  ws.setDirtyCanvas?.(true, true);
}

function cellMenu(node, entry, index, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector(".rn-shelf-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "rn-shelf-menu";
  menu.style.cssText = "position:fixed;z-index:10060;background:#15171b;border:1px solid "
    + "#33373d;border-radius:8px;padding:5px;display:flex;flex-direction:column;gap:2px;"
    + "min-width:190px;box-shadow:0 10px 30px #000a";
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 260)}px`;
  const item = (label, run) => {
    const b = document.createElement("button");
    b.className = "rn-shelf-mi";
    b.textContent = label;
    b.style.cssText = "background:transparent;border:0;color:#d6d9de;text-align:left;"
      + "padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12.5px";
    b.onmouseenter = () => { b.style.background = "#23262c"; };
    b.onmouseleave = () => { b.style.background = "transparent"; };
    b.onclick = () => { menu.remove(); run(); };
    menu.appendChild(b);
  };
  for (const [tab, label] of SEND_TO) item(`Send to ${label}`, () => sendTo(entry, tab));
  item("Open the picture", () => window.open(viewUrl(entry), "_blank", "noopener"));
  item("Copy its name", () => navigator.clipboard?.writeText?.(entry));
  item("Take it off the shelf", () => {
    node._rnShelf.items.splice(index, 1);
    if (node._rnShelf.sel >= node._rnShelf.items.length) {
      node._rnShelf.sel = Math.max(0, node._rnShelf.items.length - 1);
    }
    writeCfg(node);
    render(node);
  });
  document.body.appendChild(menu);
  const away = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    window.removeEventListener("pointerdown", away, true);
  };
  window.addEventListener("pointerdown", away, true);
}

/** A picture leaves the shelf as a copy, in every payload a target might read. */
function dragOut(cell, entry) {
  cell.draggable = true;
  cell.addEventListener("dragstart", (ev) => {
    const rec = { ...parseEntry(entry), rand: (Math.random() * 1e9) | 0 };
    ev.dataTransfer?.setData?.("application/x-rednode-result", JSON.stringify(rec));
    const base = window.location?.href;
    const abs = base ? new URL(viewUrl(entry), base).href : viewUrl(entry);
    ev.dataTransfer?.setData?.("text/uri-list", abs);
    ev.dataTransfer?.setData?.("text/plain", abs);
    ev.dataTransfer?.setData?.("text/html", `<img src="${abs}">`);
    if (base && ev.dataTransfer?.setData) {
      const name = String(rec.filename || "picture.png").split("/").pop();
      const mime = /\.webp$/i.test(name) ? "image/webp"
                 : /\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png";
      ev.dataTransfer.setData("DownloadURL", `${mime}:${name}:${abs}`);
    }
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
  });
}

async function addFiles(node, files) {
  // dropped together: the last one added ends up on top, so they are taken in
  // reverse and the pile reads in the order they were dropped
  for (const file of [...files].reverse()) {
    if (!/^image\//.test(file.type || "")) continue;
    try {
      const body = new FormData();
      body.append("image", file, file.name);
      body.append("overwrite", "false");
      const res = await api.fetchApi("/upload/image", { method: "POST", body });
      const d = await res.json();
      addEntry(node, entryOf({ filename: d.name, subfolder: d.subfolder, type: d.type }));
    } catch (e) {
      console.error("[RedNode Shelf] could not take that file:", e);
    }
  }
  writeCfg(node);
  render(node);
}

function render(node) {
  const root = node._rnShelfEl;
  if (!root) return;
  const cfg = node._rnShelf;
  root.replaceChildren();

  const head = document.createElement("div");
  head.className = "rn-shelf-head";
  const title = document.createElement("span");
  title.className = "rn-shelf-title";
  title.textContent = "Shelf";
  const count = document.createElement("span");
  count.className = "rn-shelf-note";
  count.textContent = cfg.items.length
    ? `${cfg.items.length} picture${cfg.items.length === 1 ? "" : "s"}`
    : "empty";
  const clear = document.createElement("button");
  clear.className = "rn-shelf-btn";
  clear.textContent = "Clear";
  clear.disabled = !cfg.items.length;
  clear.title = "Take every picture off the shelf. The files themselves are untouched.";
  clear.onclick = () => { cfg.items = []; cfg.sel = 0; writeCfg(node); render(node); };
  head.append(title, count, clear);
  root.appendChild(head);

  // THE OVERRIDE: the picked picture stands in for whatever the ticked tabs hold,
  // for the length of a run. Nothing is written into the Workspace, so switching
  // it off hands every tab its own picture back.
  const ov = document.createElement("div");
  ov.className = "rn-shelf-ov" + (cfg.override ? " on" : "");
  const sw = document.createElement("button");
  sw.className = "rn-shelf-sw" + (cfg.override ? " on" : "");
  sw.dataset.shelfOverride = cfg.override ? "on" : "off";
  sw.title = cfg.override
    ? "On: the picture picked here is what the ticked tabs render from. Click to "
      + "give them their own pictures back."
    : "Off: every tab uses its own gallery. Click to make the picture picked here "
      + "the one they render from.";
  sw.onclick = () => { setOverride(node, !cfg.override); render(node); };
  const ol = document.createElement("span");
  ol.className = "rn-shelf-ovlab";
  ol.textContent = "Override";
  ov.append(sw, ol);
  if (cfg.override) {
    const chips = document.createElement("div");
    chips.className = "rn-shelf-chips";
    for (const [id, name] of SEND_TO) {
      const b = document.createElement("button");
      const ticked = cfg.override_tabs.includes(id);
      b.className = "rn-shelf-chip" + (ticked ? " on" : "");
      b.dataset.shelfTab = id;
      b.textContent = OVERRIDE_LABEL[id] || name;
      b.title = ticked
        ? `${OVERRIDE_LABEL[id] || name} renders from this picture, and is switched `
          + "on for the run."
        : `Click to hand ${OVERRIDE_LABEL[id] || name} this picture too.`;
      b.onclick = () => {
        cfg.override_tabs = ticked ? cfg.override_tabs.filter((x) => x !== id)
                                   : [...cfg.override_tabs, id];
        writeCfg(node);
        render(node);
      };
      chips.appendChild(b);
    }
    ov.appendChild(chips);
  }
  root.appendChild(ov);
  if (cfg.override && !cfg.items.length) {
    const warn = document.createElement("div");
    warn.className = "rn-shelf-note rn-shelf-ovwarn";
    warn.textContent = "Override is on with nothing on the shelf, so the tabs keep "
      + "their own pictures.";
    root.appendChild(warn);
  }

  const list = document.createElement("div");
  list.className = "rn-shelf-list";
  root.appendChild(list);

  if (!cfg.items.length) {
    const empty = document.createElement("div");
    empty.className = "rn-shelf-empty";
    empty.textContent = "Drop pictures here. Drag them off onto a gallery, the Paint "
      + "pane or a folder; right-click one to send it to a tab.";
    list.appendChild(empty);
  }
  cfg.items.forEach((entry, i) => {
    const cell = document.createElement("div");
    cell.className = "rn-shelf-cell" + (i === cfg.sel ? " cur" : "");
    cell.dataset.shelf = String(i);
    cell.title = `${entry}\nDrag it off, or right-click for where to send it.`;
    const img = document.createElement("img");
    img.className = "rn-shelf-img";
    img.src = thumbUrl(entry);
    img.alt = "";
    img.draggable = false;
    // a picture deleted since it was put here says so rather than showing a broken
    // tile, and the cell still drags and still names the file
    img.addEventListener("error", () => {
      if (img.dataset.tried === "full") { cell.classList.add("gone"); return; }
      img.dataset.tried = "full";
      img.src = viewUrl(entry);
    });
    const name = document.createElement("div");
    name.className = "rn-shelf-name";
    name.textContent = parseEntry(entry).filename;
    cell.append(img, name);
    dragOut(cell, entry);
    cell.onclick = () => { cfg.sel = i; writeCfg(node); render(node); };
    cell.addEventListener("contextmenu", (ev) => cellMenu(node, entry, i, ev));
    list.appendChild(cell);
  });
}

function build(node) {
  if (!node.addDOMWidget || node._rnShelfWidget) return;
  const cfgW = (node.widgets || []).find((x) => x.name === "config");
  if (!cfgW) { requestAnimationFrame(() => build(node)); return; }
  cfgW.type = "hidden";
  cfgW.hidden = true;
  cfgW.computeSize = () => [0, -4];
  if (cfgW.element) cfgW.element.style.display = "none";
  if (cfgW.inputEl) cfgW.inputEl.style.display = "none";
  node._rnShelf = readCfg(node);

  const wrap = document.createElement("div");
  wrap.className = "rn-shelf-wrap";
  for (const t of ["pointerdown", "pointerup", "click", "dblclick", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  wrap.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.add("over");
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("over"));
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove("over");
    // a picture from anywhere in the pack arrives as a record, not as a file
    const inApp = e.dataTransfer?.getData?.("application/x-rednode-result");
    if (inApp) {
      try {
        addEntry(node, entryOf(JSON.parse(inApp)));
        writeCfg(node);
        render(node);
        return;
      } catch (err) { /* fall through to the files below */ }
    }
    // a picture from ComfyUI's own panels arrives as a URL and, alongside it, the
    // small file it was drawn from: the URL wins, because it names the real one
    const fromUrl = entryFromUrl(e.dataTransfer?.getData?.("text/uri-list")
      || e.dataTransfer?.getData?.("text/plain"));
    if (fromUrl) {
      addEntry(node, fromUrl);
      writeCfg(node);
      render(node);
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) await addFiles(node, files);
  });
  node._rnShelfEl = wrap;

  const w = node.addDOMWidget("rednode_shelf_ui", "rednode_shelf_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnShelf = readCfg(node); render(node); },
    getMinHeight: () => MIN_H,
  });
  w.element = wrap;
  node._rnShelfWidget = w;
  node.size = [Math.max(node.size?.[0] || 0, 260), Math.max(node.size?.[1] || 0, 420)];
  render(node);
}

const style = document.createElement("style");
style.textContent = `
.rn-shelf-wrap{display:flex;flex-direction:column;gap:7px;height:100%;box-sizing:border-box;
  padding:8px;background:#101216;border:1px solid #262a31;border-radius:10px;
  font:12px system-ui,sans-serif;color:#d6d9de;overflow:hidden}
.rn-shelf-wrap.over{border-color:#4a8fe0;box-shadow:inset 0 0 0 1px #4a8fe0}
.rn-shelf-head{display:flex;align-items:center;gap:8px;flex:none}
.rn-shelf-title{font-weight:700;font-size:13px;color:#a9c6ff}
.rn-shelf-note{flex:1;color:#8a919b}
.rn-shelf-btn{background:#15171b;border:1px solid #33373d;border-radius:6px;color:#d6d9de;
  cursor:pointer;font-size:11.5px;padding:4px 10px}
.rn-shelf-btn:disabled{opacity:.5;cursor:default}
.rn-shelf-ov{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:6px 7px;border:1px solid #2a2e35;border-radius:8px;background:#15171b}
.rn-shelf-ov.on{border-color:#b8283c;background:#1d1418}
.rn-shelf-sw{flex:none;width:34px;height:18px;border-radius:9px;border:1px solid #3a3f47;
  background:#23262c;position:relative;cursor:pointer;padding:0}
.rn-shelf-sw::after{content:"";position:absolute;top:1px;left:1px;width:14px;height:14px;
  border-radius:50%;background:#6b7280;transition:left .12s,background .12s}
.rn-shelf-sw.on{border-color:#b8283c;background:#3a1620}
.rn-shelf-sw.on::after{left:17px;background:#e0435a}
.rn-shelf-ovlab{font-size:12px;color:#d6d9de;font-weight:600}
.rn-shelf-chips{display:flex;flex-wrap:wrap;gap:4px;width:100%}
.rn-shelf-chip{background:#15171b;border:1px solid #33373d;border-radius:6px;color:#8a919b;
  font-size:11px;padding:2px 8px;cursor:pointer}
.rn-shelf-chip.on{border-color:#b8283c;color:#f3b0ba;background:#241419}
.rn-shelf-ovwarn{flex:none;color:#e0a84a;line-height:1.45;padding:2px 4px}
.rn-shelf-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
.rn-shelf-empty{color:#8a919b;line-height:1.5;padding:10px 4px}
.rn-shelf-cell{flex:none;display:flex;flex-direction:column;gap:4px;padding:5px;cursor:grab;
  background:#15171b;border:1px solid #2a2e35;border-radius:8px}
.rn-shelf-cell:hover{border-color:#3d434c}
.rn-shelf-cell.cur{border-color:#b8283c;background:#1d1418}
.rn-shelf-img{width:100%;height:110px;object-fit:contain;border-radius:5px;background:#0f1114;
  pointer-events:none}
.rn-shelf-name{font-size:11px;color:#8a919b;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rn-shelf-cell.gone{border-color:#7d2233;background:#1a1216}
.rn-shelf-cell.gone .rn-shelf-img{opacity:.25}
.rn-shelf-cell.gone .rn-shelf-name::after{content:" - gone";color:#e0405a}
`;
document.head.appendChild(style);

app.registerExtension({
  name: "RedNode.Shelf",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      build(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      if (!this._rnShelfWidget) build(this);
      requestAnimationFrame(() => {
        this._rnShelf = readCfg(this);
        render(this);
      });
    };
  },
});

export { readCfg, entryOf, parseEntry, sendTo, render, addEntry, entryFromUrl, SEND_TO,
         setOverride, shelves, OVERRIDE_DEFAULT };
