import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { setting } from "./rednode_settings.js";
import { arrowKeys } from "./rednode_keys.js";

// RedNode Image Review — the panel over review.py.
//
// The server side is a stock PreviewImage; everything interesting is here. Each
// `executed` event for this node carries the fresh images AND the prompt_id that made
// them, so a history entry is (files, prompt_id, time). That prompt_id unlocks Rerun:
// ComfyUI keeps the full API prompt of every queued run in /history, so re-queueing it
// verbatim reruns with the SAME seed, and rewriting its seed inputs first reruns fresh.
//
// History rides in node.properties (no widget slot taken, survives reload). Temp files
// die with a ComfyUI restart — those slots show "gone" rather than a broken image.

const NODE_NAME = "RedNodeImageReview";
const NODE_MIN_W = 340;
const MIN_PANEL_H = 220;
const MAX_KEEP = 24;                     // rolling window, overridable in settings
const THUMB_H = 64;

const css = document.createElement("style");
css.textContent = `
.rn-rv-wrap{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:hidden}
.rn-rv-main{flex:1;min-height:100px;display:flex;align-items:center;justify-content:center;
  background:#111316;border-radius:6px;overflow:hidden;position:relative;cursor:context-menu}
.rn-rv-main img{max-width:100%;max-height:100%;object-fit:contain}
/* One stacked corner. The tag and the size line were both pinned to the same top-left
   spot, so the tag painted over the resolution and hid it. Stacking keeps both readable
   whatever either one says, unlike a fixed offset that a longer tag breaks. */
.rn-rv-corner{position:absolute;top:5px;left:5px;display:flex;flex-direction:column;
  align-items:flex-start;gap:4px;pointer-events:none}
.rn-rv-stats{padding:2px 8px;border-radius:9px;
  background:#000a;color:#cfd4da;font-size:10.5px;letter-spacing:.02em;
  font-variant-numeric:tabular-nums}
.rn-rv-tag{background:#000c;color:#d4ffe4;font-size:10.5px;
  padding:2px 7px;border-radius:4px}
.rn-rv-tag.old{color:#f0c58a}
.rn-rv-cnt{position:absolute;top:5px;right:5px;background:#000c;color:#9aa0a8;font-size:10.5px;
  padding:2px 7px;border-radius:4px}
.rn-rv-strip{display:flex;gap:5px;overflow-x:auto;overflow-y:hidden;flex:none;height:${THUMB_H + 12}px;
  padding:3px 1px;scrollbar-width:thin}
/* uniform squares: every thumb centre-crops to the same tile, whatever its aspect.
   The big preview still shows the full frame. */
.rn-rv-th{position:relative;width:${THUMB_H}px;height:${THUMB_H}px;border-radius:4px;overflow:hidden;
  flex:none;border:2px solid #2a2e35;cursor:pointer;background:#111316}
.rn-rv-th img{width:100%;height:100%;object-fit:cover;display:block}
.rn-rv-th.cur{border-color:#b8283c;box-shadow:0 0 7px #b8283c66}
.rn-rv-th.newest{border-color:#22c55e}
.rn-rv-th.newest.cur{border-color:#b8283c}
.rn-rv-th .gone{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:9px;color:#ff7b86;background:#0009}
.rn-rv-empty{opacity:.45;font-size:11.5px;text-align:center;line-height:1.5;padding:10px}
.rn-rv-menu{position:fixed;z-index:10003;min-width:230px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;padding:6px;font:12.5px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;
  display:flex;flex-direction:column;gap:3px}
.rn-rv-menu button{background:none;border:0;color:#ddd;border-radius:5px;padding:7px 9px;cursor:pointer;
  font-size:12.5px;text-align:left}
.rn-rv-menu button:hover:not(:disabled){background:#b8283c;color:#fff}
.rn-rv-menu button:disabled{opacity:.4;cursor:not-allowed}
.rn-rv-menu .sep{height:1px;background:#33373d;margin:2px 4px}
.rn-rv-menu .note{font-size:10px;opacity:.5;padding:2px 9px 4px}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

// ---- history ---------------------------------------------------------------
// entry: { files: [{filename, subfolder, type}], prompt: "<prompt_id>", ts: <ms> }
const hist = (node) => {
  node.properties = node.properties || {};
  if (!Array.isArray(node.properties.rn_review)) node.properties.rn_review = [];
  return node.properties.rn_review;
};

const fileUrl = (f) =>
  api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&type=${f.type || "temp"}` +
             `&subfolder=${encodeURIComponent(f.subfolder || "")}`);

// When each queued run started. ComfyUI's executed event carries no duration, but
// execution_start carries the prompt id, which is all that is needed to time it.
const runStarted = new Map();

function statsLine(entry) {
  const bits = [];
  if (entry.title) bits.push(`“${entry.title}”`);
  if (entry.dims) bits.push(entry.dims);
  if (entry.secs != null) bits.push(`${entry.secs.toFixed(2)}s`);
  if (entry.files.length > 1) bits.push(`batch of ${entry.files.length}`);
  if (entry.recovered) bits.push("from the saved file");
  return bits.join("  ·  ");
}

// WHY it could not be recovered, not just that it could not. Three different things
// used to come out as one sentence blaming the absence of a Save node, and when the
// saved index was lost that sentence was simply false: a Save node had filed the run,
// the index had stopped knowing about it. A wrong explanation costs more than none,
// because it sends you looking in the wrong place. Callers get {file} on success and
// {file: null, why, path} otherwise.
async function recover(entry) {
  if (!entry?.prompt) return { file: null, why: "norun" };
  try {
    const q = new URLSearchParams({ prompt_id: entry.prompt, index: "0" });
    const res = await api.fetchApi(`/rednode/saved_for?${q}`);
    const d = await res.json();
    if (!d.found) return { file: null, why: "unlisted" };
    if (d.missing) return { file: null, why: "deleted", path: String(d.path || "") };
    const rel = String(d.path).replace(/\\/g, "/");     // windows paths come back \-ed
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    return { file: { filename: name, subfolder: d.subfolder || "", type: "output" } };
  } catch (e) {
    return { file: null, why: "unreachable" };
  }
}

// One sentence per real situation. Only "deleted" means a file actually went.
function goneText(r) {
  if (r.why === "deleted") {
    return "The preview is gone and the file this run saved is no longer at "
         + `${r.path || "the path it was filed under"}, so it has been moved or `
         + "deleted since.";
  }
  if (r.why === "unlisted") {
    return "The preview is gone, and nothing in the save index matches this run. If "
         + "the list was cleared or rebuilt, that link goes even though the picture "
         + "itself may still be in the output folder.";
  }
  if (r.why === "unreachable") {
    return "The preview is gone and the server did not answer when asked what this "
         + "run saved.";
  }
  return "This image's temp file is gone, and no RedNode Save node filed this run, "
       + "so there is nothing left to show.";
}

function pushEntry(node, images, promptId) {
  const h = hist(node);
  const began = runStarted.get(promptId);
  h.unshift({ files: images, prompt: promptId || null, ts: Date.now(),
              secs: began ? (Date.now() - began) / 1000 : null });
  // this history rides in the workflow file, so its length is the user's call
  const keep = Math.max(1, parseInt(setting("RedNode.Review.HistoryLength", MAX_KEEP))
                          || MAX_KEEP);
  while (h.length > keep) h.pop();
  node._rnView = 0;                      // a new arrival always takes the top spot
  node._rnJumpHome = true;               // ...and the strip scrolls back to show it
  node.graph?.change?.();
  render(node);
}

// ---- rerun -----------------------------------------------------------------
async function fetchPrompt(promptId) {
  const res = await api.fetchApi(`/history/${promptId}`);
  const d = await res.json();
  const entry = d?.[promptId];
  // history rows are [number, id, prompt, extra, outputs] or {prompt: [...]}-shaped
  const row = entry?.prompt;
  const graph = Array.isArray(row) ? row[2] : row;
  if (!graph || typeof graph !== "object") throw new Error("that run is no longer in ComfyUI's history");
  return graph;
}

function reseed(graph) {
  // every concrete seed in the API prompt gets a fresh value; control_after_generate
  // is a widget-only concept and never appears here
  const out = JSON.parse(JSON.stringify(graph));
  let touched = 0;
  for (const nid of Object.keys(out)) {
    const inputs = out[nid]?.inputs;
    if (!inputs) continue;
    for (const key of ["seed", "noise_seed"]) {
      if (typeof inputs[key] === "number") {
        inputs[key] = Math.floor(Math.random() * 0xffffffffff);
        touched++;
      }
    }
  }
  if (!touched) console.warn("[RedNode Review] no seed inputs found to change");
  return out;
}

async function queuePrompt(graph) {
  const res = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: api.clientId ?? api.socket?.clientId }),
  });
  const d = await res.json().catch(() => ({}));
  if (d.error) throw new Error(d.error?.message || JSON.stringify(d.error));
  return d;
}

async function copyImage(f) {
  const blob = await (await fetch(fileUrl(f))).blob();
  // the clipboard wants PNG; transcode through a canvas when the source is not
  if (blob.type === "image/png" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return;
  }
  const img = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

// ---- menu ------------------------------------------------------------------
// What RedNode Save wrote for the run that produced a given picture.
//
// Neither node knows the other exists. Both know the prompt id: Review stores it
// against every image so Rerun works, and Save records it against every file it
// writes. That shared key is the whole of the link, so "keep the one I am looking
// at" needs no wire and no matching of pixels.
async function savedFor(entry, slot = 0) {
  if (!entry?.prompt) return null;
  try {
    const q = new URLSearchParams({ prompt_id: entry.prompt, index: String(slot) });
    const res = await api.fetchApi(`/rednode/saved_for?${q}`);
    const d = await res.json();
    return d.found ? d : null;
  } catch (e) {
    return null;                       // no Save node in the graph, or an older run
  }
}

async function promptFor(entry, slot = 0, nodeId = "") {
  if (!entry?.prompt) throw new Error("this entry predates prompt tracking");
  const q = new URLSearchParams({ prompt_id: entry.prompt, index: String(slot) });
  if (nodeId) q.set("node_id", nodeId);
  const res = await api.fetchApi(`/rednode/prompt_for?${q}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("the positive prompt could not be retrieved");
  return d;
}

async function writePromptClipboard(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("the positive prompt is no longer available");
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(box);
    box.focus();
    box.select();
    const copied = document.execCommand("copy");
    box.remove();
    if (!copied) throw new Error("the browser refused clipboard access");
  }
  console.log("[RedNode Review] positive prompt copied");
}

function openPromptChoices(entry, slot, choices, ev) {
  document.querySelector(".rn-rv-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-rv-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = "Choose the Prompt Combine to copy";
  m.appendChild(note);

  let close;
  const dispose = () => {
    m.remove();
    if (close) document.removeEventListener("pointerdown", close, true);
  };
  for (const choice of choices) {
    if (!choice || typeof choice.id !== "string") continue;
    const b = document.createElement("button");
    b.textContent = String(choice.label || `Prompt Combine #${choice.id}`);
    b.onclick = async () => {
      dispose();
      try {
        const selected = await promptFor(entry, slot, choice.id);
        await writePromptClipboard(selected.prompt);
      } catch (e) {
        console.error("[RedNode Review] Copy prompt failed:", e);
        alert(`Copy prompt failed: ${e.message}`);
      }
    };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const mw = 280;
  const mh = m.getBoundingClientRect().height || 160;
  const x = Number.isFinite(ev?.clientX) ? ev.clientX : (window.innerWidth || 1920) / 2;
  const y = Number.isFinite(ev?.clientY) ? ev.clientY : (window.innerHeight || 1080) / 2;
  m.style.left = Math.max(6, Math.min(x, (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(y, (window.innerHeight || 1080) - mh - 6)) + "px";
  close = (e) => { if (!m.contains(e.target)) dispose(); };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

async function copyPrompt(entry, slot = 0, ev = null) {
  const d = await promptFor(entry, slot);
  if (Array.isArray(d.choices) && d.choices.length) {
    openPromptChoices(entry, slot, d.choices, ev);
    return;
  }
  if (!d.found || typeof d.prompt !== "string" || !d.prompt.trim()) {
    throw new Error("the positive prompt is no longer available");
  }
  await writePromptClipboard(d.prompt);
}

async function setKept(found, kept) {
  const res = await api.fetchApi("/rednode/promote", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: found.path, keep: kept }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
}

function openMenu(node, entry, index, ev) {
  document.querySelector(".rn-rv-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-rv-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) m.addEventListener(t, (e) => e.stopPropagation());

  const note = document.createElement("div");
  note.className = "note";
  const age = Math.round((Date.now() - (entry.ts || Date.now())) / 60000);
  note.textContent = (index === 0 ? "newest" : `${index + 1} back`) +
                     (age > 0 ? ` · ${age} min ago` : " · just now") +
                     (entry.secs != null ? ` · ${entry.secs.toFixed(2)}s` : "") +
                     (entry.dims ? ` · ${entry.dims}` : "") +
                     (entry.files.length > 1 ? ` · batch of ${entry.files.length}` : "");

  const mk = (label, fn, { disabled = false, why = "" } = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = disabled;
    b.title = why;
    b.onclick = async () => {
      m.remove();
      try {
        await fn();
      } catch (e) {
        console.error(`[RedNode Review] ${label} failed:`, e);
        alert(`${label} failed: ${e.message}`);
      }
    };
    return b;
  };
  const sep = () => {
    const d = document.createElement("div");
    d.className = "sep";
    return d;
  };

  const f = entry.files[0];
  const noPrompt = !entry.prompt;
  m.append(
    note,
    mk("Copy image", () => copyImage(f)),
    mk("Copy prompt", () => copyPrompt(entry, 0, ev), {
      disabled: noPrompt,
      why: noPrompt ? "this entry predates prompt tracking"
                    : "copies the positive prompt that produced this image",
    }),
    mk("Open in a new tab", () => { window.open(fileUrl(f), "_blank"); }),
    sep(),
    mk("Rerun (same seed, same everything)", async () => {
      await queuePrompt(await fetchPrompt(entry.prompt));
    }, { disabled: noPrompt, why: noPrompt ? "this entry predates prompt tracking" : "re-queues the exact prompt that made this image" }),
    mk("Rerun with new seeds", async () => {
      await queuePrompt(reseed(await fetchPrompt(entry.prompt)));
    }, { disabled: noPrompt, why: noPrompt ? "this entry predates prompt tracking" : "same prompt, every seed re-rolled" }),
    sep(),
    mk("Remove from history", () => {
      hist(node).splice(index, 1);
      node._rnView = Math.min(node._rnView || 0, Math.max(0, hist(node).length - 1));
      node.graph?.change?.();
      render(node);
    }),
    mk(`Clear ALL history (${hist(node).length})`, () => {
      // two clicks on purpose: this wipes every remembered run in one go
      if (!node._rnClearArmed) {
        node._rnClearArmed = true;
        setTimeout(() => { node._rnClearArmed = false; }, 4000);
        openMenu(node, entry, index, ev);            // reopen showing the armed label
        return;
      }
      node._rnClearArmed = false;
      node.properties.rn_review = [];
      node._rnView = 0;
      node.graph?.change?.();
      render(node);
    }, { why: "wipes the whole strip; the temp files themselves stay until ComfyUI restarts" }),
  );
  // The Save entry has to be asked for, so the item arrives a moment after the menu.
  // It is only inserted when this picture really was filed by a Save node.
  savedFor(entry, 0).then((found) => {
    if (!found || !m.isConnected || found.missing) return;
    // Naming is on demand only: it loads a vision model and takes a few seconds, so
    // it never taxes a normal run. Ollama rather than the workflow's CLIP, because a
    // CLIP object only exists while a run is executing and this is a right-click.
    const namer = mk(found.title ? `Rename it (now "${found.title}")` : "Name this image",
      async () => {
        const res = await api.fetchApi("/rednode/title", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: found.path }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        entry.title = d.title;
        node.graph?.change?.();
        render(node);
      }, { why: "Asks your Ollama vision model for a title of four words or fewer, and "
              + "writes it into the text record beside the image. Experimental and "
              + "model-dependent." });
    m.insertBefore(namer, m.children[3] || null);
    const item = mk(found.kept ? `Unkeep "${found.name}"` : `Keep "${found.name}"`,
      async () => {
        await setKept(found, !found.kept);
        // the Save panel is listening on its own; nudge it so the list agrees
        api.dispatchEvent?.(new CustomEvent("rednode.saved_changed"));
      }, { why: found.kept
             ? "Move it back to the drafts folder."
             : "Move this image, and the records written beside it, into the keepers "
             + "folder. RedNode Save did the filing; this is the same button it has." });
    item.style.color = found.kept ? "#8fd08f" : "";
    m.insertBefore(item, m.children[3] || null);   // just under Open in a new tab
    m.insertBefore(sep(), m.children[4] || null);
  });

  if (node._rnClearArmed) {
    const armed = [...m.children].find((c) => (c.textContent || "").startsWith("Clear ALL"));
    if (armed) {
      armed.textContent = "Click again to really clear everything";
      armed.style.color = "#ff9aa4";
    }
  }
  document.body.appendChild(m);
  const mw = 240, mh = m.getBoundingClientRect().height || 220;
  m.style.left = Math.max(6, Math.min(ev.clientX, (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY, (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- render ----------------------------------------------------------------
function render(node) {
  const root = node._rnRootEl;
  if (!root) return;
  const h = hist(node);
  const view = Math.min(node._rnView || 0, Math.max(0, h.length - 1));
  node._rnView = view;
  // render() rebuilds the strip, which resets its scroll to the start. Clicking a
  // thumbnail you had scrolled to therefore snapped the strip back to the newest
  // image and looked like the click had landed on the wrong one. Carry the scroll
  // across the rebuild; only a NEW arrival deserves the jump home (length is the
  // wrong signal for that: at the history cap an arrival does not grow the list).
  const keepScroll = root.querySelector(".rn-rv-strip")?.scrollLeft || 0;
  const grew = !!node._rnJumpHome || !root.querySelector(".rn-rv-strip");
  node._rnJumpHome = false;
  root.replaceChildren();

  const main = document.createElement("div");
  main.className = "rn-rv-main";
  if (!h.length) {
    const empty = document.createElement("div");
    empty.className = "rn-rv-empty";
    empty.textContent = "Images land here as they are generated, newest on top; the strip "
                      + "remembers earlier runs. Right-click any of them for Copy or Rerun.";
    main.appendChild(empty);
  } else {
    const entry = h[view];
    const img = document.createElement("img");
    img.src = fileUrl(entry.files[0]);
    img.onerror = () => {
      const gone = document.createElement("div");
      gone.className = "rn-rv-empty";
      // A preview lives in temp and does not survive a restart. If a RedNode Save
      // node filed that same run the real output is still on disk, and the prompt id
      // both nodes already share is enough to find it.
      recover(entry).then((r) => {
        if (r.file) {
          entry.files[0] = r.file;
          entry.recovered = true;
          node.graph?.change?.();
          render(node);
          return;
        }
        gone.textContent = goneText(r);
        main.replaceChildren(gone);
      });
    };
    img.onload = () => {
      const dims = `${img.naturalWidth} × ${img.naturalHeight}`;
      if (entry.dims === dims) return;
      entry.dims = dims;                      // the picture knows its own size
      node.graph?.change?.();
      if (node._rnStatsEl) node._rnStatsEl.textContent = statsLine(entry);
    };
    main.appendChild(img);
    const corner = document.createElement("div");
    corner.className = "rn-rv-corner";
    const tag = document.createElement("span");
    tag.className = "rn-rv-tag" + (view === 0 ? "" : " old");
    tag.textContent = view === 0 ? "latest" : `${view + 1} back`;
    const stats = document.createElement("div");
    stats.className = "rn-rv-stats";
    stats.textContent = statsLine(entry);
    node._rnStatsEl = stats;
    corner.append(tag, stats);          // tag first: the size reads under the label
    main.appendChild(corner);
    if (entry.files.length > 1) {
      const cnt = document.createElement("span");
      cnt.className = "rn-rv-cnt";
      cnt.textContent = `batch of ${entry.files.length}`;
      main.appendChild(cnt);
    }
    main.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openMenu(node, entry, view, e);
    });
  }
  root.appendChild(main);

  const strip = document.createElement("div");
  strip.className = "rn-rv-strip";
  h.forEach((entry, i) => {
    const th = document.createElement("div");
    th.className = "rn-rv-th" + (i === view ? " cur" : "") + (i === 0 ? " newest" : "");
    const img = document.createElement("img");
    // Fetched as the strip reaches them, and decoded off the main thread. This used to
    // pull and decode every entry in the history the moment the node drew, which across
    // two review nodes with a long history is a lot of bitmaps held in memory for
    // pictures nobody has scrolled to yet.
    img.loading = "lazy";
    img.decoding = "async";
    img.src = fileUrl(entry.files[0]);
    img.onerror = () => {
      // Recover here too, not just on the big picture. Only the viewed entry ever
      // triggered the main image's error, so every OTHER slot in the strip stayed
      // "gone" even when RedNode Save still had the real file on disk.
      if (entry.recovered) {                       // already tried and failed
        th.appendChild(Object.assign(document.createElement("div"),
                                     { className: "gone", textContent: "gone" }));
        return;
      }
      recover(entry).then((r) => {
        if (!r.file) {
          // the strip has room for one word; the reason rides on the tooltip so the
          // thumbnail can still say WHY without becoming a paragraph
          th.appendChild(Object.assign(document.createElement("div"),
                                       { className: "gone", textContent: "gone",
                                         title: goneText(r) }));
          return;
        }
        entry.files[0] = r.file;
        entry.recovered = true;
        node.graph?.change?.();
        render(node);
      });
    };
    th.title = i === 0 ? "The newest image." : `${i + 1} runs back. Click to view.`;
    th.appendChild(img);
    th.onclick = () => { node._rnView = i; render(node); };
    th.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openMenu(node, entry, i, e);
    });
    strip.appendChild(th);
  });
  if (h.length) {
    root.appendChild(strip);
    strip.scrollLeft = grew ? 0 : keepScroll;
    // and keep the selected thumbnail visible when the view moved on its own
    // (rerun, remove, keyboard), without fighting a scroll the user just made
    const cur = strip.children[view];
    const vis = Number(strip.clientWidth);
    if (cur && !grew && Number.isFinite(vis) && vis > 0) {
      const left = Number(cur.offsetLeft);
      const wide = Number(cur.offsetWidth) || THUMB_H;
      if (Number.isFinite(left)) {
        if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 4);
        else if (left + wide > strip.scrollLeft + vis) {
          strip.scrollLeft = left + wide - vis + 4;
        }
      }
    }
  }

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], 380)]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

// ---- build -----------------------------------------------------------------
function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const wrap = document.createElement("div");
  wrap.className = "rn-rv-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  // The plain wheel over the WHOLE node is handed straight to the canvas, so zooming
  // works exactly as over empty canvas. Shift+wheel is the one exception: it scrolls
  // the thumbnail strip sideways for long histories.
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      const strip = wrap.querySelector(".rn-rv-strip");
      if (strip) strip.scrollLeft = (strip.scrollLeft || 0) + e.deltaY;
      return;
    }
    app.canvas?.processMouseWheel?.(e);
  }, { passive: false });
  node._rnRootEl = wrap;

  const w = node.addDOMWidget("rednode_review_ui", "rednode_review_ui", wrap, {
    serialize: false,
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  // arrows walk the history while the pointer is over the panel, the way any photo
  // viewer behaves. 0 is the newest, so right goes back in time.
  arrowKeys(wrap, (dir) => {
    const h = hist(node);
    if (!h.length) return;
    const at = node._rnView || 0;
    node._rnView = dir === "first" ? 0
                 : dir === "last" ? h.length - 1
                 : Math.max(0, Math.min(h.length - 1, at + dir));
    render(node);
  });

  // The frontend assigns node.imgs from every executed event and draws them under the
  // widgets. That is the stock PreviewImage picture, which would show every image twice.
  // The panel owns display here, so the assignment is swallowed at the property level;
  // overriding onExecuted alone does not stop it on current frontends.
  try {
    Object.defineProperty(node, "imgs", {
      get() { return undefined; },
      set(v) { /* the history strip is the display */ },
      configurable: true,
    });
  } catch (e) { /* already defined: the noop onExecuted still catches most of it */ }

  render(node);
}

// every execution of one of our nodes appends to that node's history, paired with the
// prompt_id that made it — the key that unlocks Rerun later
// the clock starts when the run does; the id ties it to the arrival later
api.addEventListener("execution_start", (e) => {
  const id = e?.detail?.prompt_id;
  if (!id) return;
  runStarted.set(id, Date.now());
  if (runStarted.size > 40) runStarted.delete(runStarted.keys().next().value);
});

api.addEventListener("executed", (e) => {
  const d = e.detail || {};
  const images = d.output?.images;
  if (!Array.isArray(images) || !images.length) return;
  const targetId = d.display_node ?? d.node;
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === NODE_NAME && String(n.id) === String(targetId)) {
        pushEntry(n, images.map((f) => ({ ...f })), d.prompt_id ?? null);
        return;
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
});

app.registerExtension({
  name: "RedNode.Review",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      injectStyle();
      build(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => render(this));
    };

    // PreviewImage's own onExecuted would draw the stock image widget under our panel
    nodeType.prototype.onExecuted = function () {};
  },
});
