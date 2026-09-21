import { api } from "../../scripts/api.js";
import { writeCfg, render } from "./rednode_workspace.js";

// FOLDER BATCH, shared by every tab that works on one picture at a time.
//
// The folder is read BY THE BROWSER and its pictures are uploaded into ComfyUI's
// own input folder. No path you typed ever reaches the server, so there is no
// arbitrary-file-read for the Registry scanner to flag, and none for anyone who
// can reach an unauthenticated /prompt to abuse either. That is not a way around
// the rule; it is the reason the rule stops applying.
//
// ONE RUN PER PICTURE, on purpose, not as a workaround. Krea 2's VAE is the Wan
// video VAE: N images encoded in one call are read as one clip of N frames and
// squeezed to (N-1)//4+1 latent frames, which is why refine_pipeline has
// _each_frame at all. Auto prompting also wants its own caption per picture.
//
// A FAILURE DOES NOT STOP THE RUN. Image 12 of 200 failing must not lose the
// other 188: it is marked and the loop moves on, and the strip keeps the marks so
// you can see afterwards which ones need another look.

export const IMAGE_RE = /\.(png|jpe?g|webp|bmp)$/i;

export function batchState(node, key) {
  const all = node._rnBatch ||= {};
  return all[key] ||= { files: [], at: -1, done: [], failed: [], why: {},
                        sel: new Set(), peek: -1, thumb: 58,
                        running: false, stop: false, note: "" };
}

/** Wait for one queued prompt to finish, whether it worked or not.
 *
 *  Its own listeners rather than the paint run waiters: a batch must not depend
 *  on, or interfere with, the Paint tab's progress machinery.
 */
function waitForRun(promptId) {
  const id = String(promptId || "");
  if (!id) return Promise.resolve({ ok: false, why: "no prompt id came back" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      for (const [name, fn] of listeners) api.removeEventListener?.(name, fn);
      resolve({ ok, why: String(why || "") });
    };
    const match = (e) => String(e?.detail?.prompt_id || "") === id;
    const listeners = [
      ["execution_success", (e) => { if (match(e)) done(true, ""); }],
      ["execution_error", (e) => {
        if (match(e)) done(false, e?.detail?.exception_message || "the run failed");
      }],
      ["execution_interrupted", (e) => { if (match(e)) done(false, "interrupted"); }],
    ];
    for (const [name, fn] of listeners) api.addEventListener?.(name, fn);
  });
}

async function uploadOne(file, subfolder) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "input");
  body.append("subfolder", subfolder);
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  const d = await res.json();
  if (!d.name) throw new Error("the upload returned no name");
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

/** Take a list of File objects into the batch, uploading each one. */
export async function takeFiles(node, key, files, onProgress) {
  const wanted = [...files].filter((f) => f && IMAGE_RE.test(f.name || ""));
  if (!wanted.length) {
    alert("No pictures in that folder. PNG, JPG, WEBP and BMP are read; anything "
        + "else is skipped.");
    return 0;
  }
  const st = batchState(node, key);
  const sub = `rednode/batch/${key}_${Date.now().toString(36)}`;
  st.files = [];
  st.at = -1;
  st.done = [];
  st.failed = [];
  st.note = `Taking ${wanted.length} pictures in…`;
  render(node);
  let taken = 0;
  for (const f of wanted) {
    try {
      st.files.push(await uploadOne(f, sub));
      taken += 1;
    } catch (err) {
      console.error("[RedNode Workspace] could not take a batch picture:", err);
    }
    st.note = `Taking pictures in… ${taken} of ${wanted.length}`;
    onProgress?.(taken, wanted.length);
    render(node);
  }
  st.note = taken === wanted.length ? `${taken} pictures ready`
                                    : `${taken} of ${wanted.length} pictures ready`;
  writeCfg(node);
  render(node);
  return taken;
}

/** A folder picker. webkitdirectory is what makes it choose a folder, not a file. */
export function pickFolder(node, key) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.webkitdirectory = true;
  inp.setAttribute("webkitdirectory", "");
  inp.setAttribute("directory", "");
  inp.onchange = () => {
    takeFiles(node, key, inp.files || []).catch((err) => {
      alert(`Could not take that folder: ${err.message}`);
    });
  };
  inp.click();
}

/** Walk a dropped directory entry, depth first, collecting its files. */
async function filesFromEntry(entry, out = [], depth = 0) {
  if (!entry || depth > 4) return out;
  if (entry.isFile) {
    await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
    return out;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries hands back a page at a time and an empty page means the end
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await filesFromEntry(e, out, depth + 1);
    }
  }
  return out;
}

/** Let an element take a dropped FOLDER, not just a file. */
export function folderDropZone(node, el, key) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.outline = "2px dashed #4a8fe0";
  });
  el.addEventListener("dragleave", () => { el.style.outline = ""; });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.outline = "";
    try {
      const items = [...(e.dataTransfer?.items || [])];
      const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
      let files = [];
      for (const en of entries) await filesFromEntry(en, files);
      // a plain multi-file drop, from a browser that gives no entries
      if (!files.length) files = [...(e.dataTransfer?.files || [])];
      await takeFiles(node, key, files);
    } catch (err) {
      console.error("[RedNode Workspace] could not take that folder:", err);
      alert(`Could not take that folder: ${err.message}`);
    }
  });
}

/** Run the batch: queueOne(file) queues that picture and returns its prompt id.
 *
 *  `precheck` returns a sentence when the run cannot work AT ALL. Anything that
 *  would fail for every picture has to be caught here, before the loop: marking
 *  two hundred pictures failed one at a time, each with only a console line, is
 *  not an error message. It is what this did when the tab was switched off.
 */
export async function runBatch(node, key, opts = {}, only) {
  const { onRun: queueOne, precheck, afterEach, confirmRun } = opts;
  const st = batchState(node, key);
  if (st.running || !st.files.length) return;
  // a partial run works the same way, just over fewer of them
  const order = (only && only.length) ? only.slice() : st.files.map((_, i) => i);
  const stopper = precheck?.();
  if (stopper) {
    st.note = stopper;
    render(node);
    alert(stopper);
    return;
  }
  // A WARNING YOU CAN OVERRULE, unlike the precheck above. The run would work;
  // it is the outcome that is not what anyone wants, and one picture is a fair
  // reason to do it anyway.
  const doubt = confirmRun?.(order.length);
  if (doubt && !confirm(doubt)) return;
  st.running = true;
  st.stop = false;
  st.done = [];
  st.failed = [];
  st.why = {};
  render(node);
  try {
    for (let n = 0; n < order.length; n++) {
      const i = order[n];
      if (st.stop) { st.note = `Stopped after ${n} of ${order.length}`; break; }
      st.at = i;
      st.note = `Picture ${n + 1} of ${order.length}`;
      render(node);
      let promptId = null;
      let queueWhy = "";
      try {
        promptId = await queueOne(st.files[i], i);
      } catch (err) {
        queueWhy = err?.message || String(err);
        console.error("[RedNode Workspace] batch queue failed:", err);
      }
      if (!promptId) {
        // A FAILURE MOVES ON. One unreadable picture must not cost the other 199.
        st.failed.push(i);
        st.why[i] = queueWhy || "it would not queue";
        continue;
      }
      const { ok, why } = await waitForRun(promptId);
      if (ok) {
        st.done.push(i);
        // WHAT HAPPENS TO EACH PICTURE once it is made. The point of a batch is not
        // to sit and press the same three buttons two hundred times, so the
        // follow-ups run here, in turn, before the next picture starts.
        try {
          await afterEach?.(i);
        } catch (err) {
          st.why[i] = `made, but ${err?.message || err}`;
          console.error("[RedNode Workspace] batch follow-up failed:", err);
        }
      } else {
        st.failed.push(i);
        st.why[i] = why || "the run failed";
        console.warn(`[RedNode Workspace] batch picture ${i + 1} failed: ${why}`);
      }
    }
    if (!st.stop) {
      const firstWhy = st.failed.length ? st.why[st.failed[0]] : "";
      st.note = st.failed.length
        ? `Finished. ${st.done.length} done, ${st.failed.length} would not run`
          + (firstWhy ? `: ${firstWhy}` : "")
        : `Finished all ${st.done.length}`;
    }
  } finally {
    st.at = -1;
    st.running = false;
    st.stop = false;
    render(node);
  }
}

const viewUrl = (name) => {
  const at = String(name).lastIndexOf("/");
  const q = new URLSearchParams({
    filename: at < 0 ? name : name.slice(at + 1),
    subfolder: at < 0 ? "" : name.slice(0, at),
    type: "input",
  });
  return api.apiURL(`/view?${q}`);
};

/** The batch strip: the folder's pictures, which one is running, which failed.
 *
 *  `onRun` queues one picture and returns its prompt id. Everything else, the
 *  counter, the stop, the marks, the selection, belongs here so every tab that
 *  uses a folder behaves the same way.
 */
export function batchStrip(node, key, host, opts = {}) {
  const st = batchState(node, key);
  const box = document.createElement("div");
  box.className = "rn-ws-card";
  // the title on its own line, the way every other card on the page does it. It
  // sat inline with the buttons and read as a different kind of box (the user,
  // 2026-09-20).
  const ttl = document.createElement("div");
  ttl.className = "ch";
  ttl.textContent = opts.title || "BATCH FOLDER";
  box.appendChild(ttl);
  const head = document.createElement("div");
  head.className = "rn-ws-row";

  const btn = (into, label, title, fn, disabled) => {
    const b = document.createElement("button");
    b.className = "rn-ws-btn";
    b.style.cssText = "width:auto;padding:3px 12px;flex:none";
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.onclick = fn;
    into.appendChild(b);
    return b;
  };
  const chosen = () => [...(st.sel || [])].sort((a, b) => a - b);
  btn(head, "Pick a folder", "Choose a folder. Its pictures are copied into ComfyUI's "
    + "own input folder, so nothing on your drive is read by the server.",
    () => pickFolder(node, key), st.running);

  // SAVED FOLDERS: the same idea as the gallery's collections. A saved batch is a
  // list of pictures already copied into the input folder, not a path, so it
  // survives the folder on your drive being moved or renamed.
  const saved = () => {
    const all = (node._rnCfg.batch_folders ||= {});
    return (all[key] ||= {});
  };
  const names = Object.keys(saved()).sort();
  if (names.length) {
    const sel = document.createElement("select");
    sel.className = "rn-ws-res";
    sel.style.cssText = "flex:none;max-width:170px";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = `Saved (${names.length})`;
    sel.appendChild(blank);
    for (const nm of names) {
      const o = document.createElement("option");
      o.value = nm;
      o.textContent = `${nm} (${saved()[nm].length})`;
      sel.appendChild(o);
    }
    sel.title = "Load a folder you saved before. The pictures are already in the "
              + "input folder, so nothing is copied again.";
    sel.disabled = st.running;
    sel.onchange = () => {
      const files = saved()[sel.value];
      if (!files) return;
      st.files = files.slice();
      st.at = -1; st.done = []; st.failed = []; st.why = {};
      st.sel = new Set(); st.peek = -1;
      st.note = `${files.length} pictures from ${sel.value}`;
      writeCfg(node);
      render(node);
    };
    head.appendChild(sel);
  }
  if (st.files.length && !st.running) {
    btn(head, "Save folder",
        "Remember this set of pictures under a name, so it can be picked again "
        + "without dropping the folder in.",
        () => {
          const nm = String(prompt("Name for this folder batch:", "") || "").trim();
          if (!nm) return;
          saved()[nm.slice(0, 48)] = st.files.slice();
          st.note = `Saved as ${nm}`;
          writeCfg(node);
          render(node);
        });
  }
  if (names.length && !st.running) {
    btn(head, "Forget saved",
        "Remove one of the saved folder batches. The pictures stay in the input "
        + "folder.",
        () => {
          const nm = String(prompt("Which saved folder should go?\n\n"
                                   + names.join(", "), names[0]) || "").trim();
          if (!nm || !saved()[nm]) return;
          delete saved()[nm];
          writeCfg(node);
          render(node);
        });
  }
  if (st.files.length && !st.running) {
    btn(head, "Clear", "Forget this folder. The copies stay in the input folder.", () => {
      st.files = []; st.at = -1; st.done = []; st.failed = []; st.why = {};
      st.sel = new Set(); st.peek = -1; st.note = "";
      writeCfg(node);
      render(node);
    });
  }
  if (st.running) {
    btn(head, st.stop ? "Stopping…" : "Stop",
        "Finish the picture that is running, then stop.",
        () => { st.stop = true; render(node); }, st.stop);
  }
  const note = document.createElement("span");
  note.className = "hint";
  note.style.cssText = "font-size:11px";
  note.textContent = st.note || (st.files.length ? `${st.files.length} pictures`
                                                 : "No folder yet");
  head.appendChild(note);
  // THE RUNS LIVE AT THE RIGHT END OF THIS ROW, the way the single picture's own
  // run sits with the picture it runs. Run Selected is the rightmost and only
  // appears with a selection, so an empty selection cannot be confusing; Run All
  // sits to its left and keeps its place whether or not one is showing.
  const blue = ";background:#2b3a4d;color:#cfe6ff;border-color:#3d5570";
  if (st.files.length && !st.running) {
    const all = btn(head, opts.runLabel || "Run All Batch",
      "Run every picture in turn, one per queue. A picture that fails is marked "
      + "and the rest carry on.",
      () => runBatch(node, key, opts));
    all.style.cssText += ";margin-left:auto" + blue;
    if (chosen().length) {
      const only = btn(head, `Run Selected (${chosen().length})`,
        "Run only the pictures you have ticked, in order.",
        () => runBatch(node, key, opts, chosen()));
      only.style.cssText += blue;
    }
  }
  box.appendChild(head);

  if (!st.files.length) {
    const drop = document.createElement("div");
    drop.className = "hint";
    drop.style.cssText = "font-size:11px;border:1px dashed #33373d;border-radius:6px;"
                       + "padding:14px;text-align:center";
    drop.textContent = "Drop a folder here, or press Pick a folder. Every picture in "
                     + "it runs in turn, one at a time.";
    folderDropZone(node, drop, key);
    box.appendChild(drop);
    host.appendChild(box);
    return box;
  }

  // A CLOSER LOOK, beside the strip. Deliberately not the full screen viewer: this
  // is for checking which picture a thumbnail is while you tick your way through a
  // folder, not for inspecting a finished result.
  // A TAB THAT IS NOT RUNNING LOADS NO PICTURES. Every thumbnail is a request and
  // a decoded picture held for something nobody is doing; the folder is still
  // named, so nothing is lost but the bandwidth (the user, 2026-09-20).
  if (opts.loadImages === false) {
    const quiet = document.createElement("div");
    quiet.className = "hint";
    quiet.style.cssText = "font-size:11px";
    quiet.textContent = `${st.files.length} pictures in this folder. The tab is off, `
                      + "so they are not loaded here; switch it on to see them.";
    box.appendChild(quiet);
    host.appendChild(box);
    return box;
  }
  const cols = document.createElement("div");
  cols.style.cssText = "display:flex;gap:10px;align-items:flex-start";
  const peek = document.createElement("div");
  peek.style.cssText = "width:168px;flex:none;display:flex;flex-direction:column;gap:4px";
  const at = Number.isInteger(st.peek) && st.peek >= 0 && st.peek < st.files.length
    ? st.peek : -1;
  const pimg = document.createElement("div");
  pimg.style.cssText = "width:168px;height:168px;border-radius:6px;background:#15171b "
                     + "center/contain no-repeat;border:1px solid #2a2e35";
  if (at >= 0) pimg.style.backgroundImage = `url(${viewUrl(st.files[at])})`;
  else {
    pimg.textContent = "Click a picture";
    pimg.style.cssText += ";display:flex;align-items:center;justify-content:center;"
                        + "font-size:11px;color:#7f8792";
  }
  const pstate = document.createElement("div");
  pstate.className = "hint";
  pstate.style.cssText = "font-size:11px;line-height:1.35";
  if (at >= 0) {
    const bits = [`${at + 1} of ${st.files.length}`];
    if (st.at === at) bits.push("running now");
    else if (st.failed.includes(at)) bits.push(`failed: ${st.why[at] || "would not run"}`);
    else if (st.done.includes(at)) bits.push("done");
    else bits.push("not run yet");
    if (st.sel?.has(at)) bits.push("selected");
    pstate.textContent = bits.join(" · ");
  } else {
    pstate.textContent = "The thumbnails tick as they finish.";
  }
  peek.append(pimg, pstate);
  cols.appendChild(peek);

  const right = document.createElement("div");
  right.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:6px";
  const size = Math.max(40, Math.min(140, Number(st.thumb) || 58));
  const strip = document.createElement("div");
  strip.className = "rn-ws-batchstrip";
  // PADDING, because the selection ring is an outline and an outline is drawn
  // OUTSIDE the element's box. With the strip scrolling and starting flush
  // against the first thumbnail, the ring was clipped at the top, the bottom and
  // the left edge (the user, 2026-09-20).
  strip.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;max-height:340px;"
                      + "overflow:auto;padding:5px";
  folderDropZone(node, strip, key);
  st.sel ||= new Set();
  st.files.forEach((f, i) => {
    const t = document.createElement("div");
    const failed = st.failed.includes(i);
    const done = st.done.includes(i);
    const here = st.at === i;
    const picked = st.sel.has(i);
    t.className = "rn-ws-batchthumb"
                + (here ? " here" : "") + (failed ? " failed" : "") + (done ? " done" : "")
                + (picked ? " picked" : "");
    t.style.cssText = `width:${size}px;height:${size}px;border-radius:5px;flex:none;`
                    + "position:relative;background:#15171b center/cover no-repeat;"
                    + `background-image:url(${viewUrl(f)});cursor:pointer;`
                    + "border:2px solid " + (here ? "#4a8fe0" : failed ? "#b8283c"
                                             : done ? "#2f6b46" : "#2a2e35")
                    + (picked ? ";outline:2px solid #4a8fe0;outline-offset:2px" : "");
    t.title = `${i + 1}. ${f}`
            + (failed ? ` — ${st.why[i] || "would not run"}`
               : done ? " — done" : "")
            + "\nClick to look at it, Ctrl-click to select it for a partial run.";
    const toggle = () => {
      if (st.sel.has(i)) st.sel.delete(i);
      else st.sel.add(i);
      st.peek = i;
      render(node);
    };
    t.onclick = (ev) => {
      // ctrl-click still selects, for anyone who learned it that way
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { toggle(); return; }
      st.peek = i;
      render(node);
    };
    t.oncontextmenu = (ev) => { ev.preventDefault?.(); toggle(); };
    if (failed || done) {
      const mark = document.createElement("span");
      mark.textContent = failed ? "✕" : "✓";
      mark.style.cssText = "position:absolute;right:2px;bottom:1px;font-size:11px;"
                         + "line-height:1;color:" + (failed ? "#fca5a5" : "#86efac")
                         + ";text-shadow:0 0 3px #000";
      t.appendChild(mark);
    }
    strip.appendChild(t);
  });
  right.appendChild(strip);

  // SIZE, and the selection controls beside it
  const tools = document.createElement("div");
  tools.className = "rn-ws-row";
  tools.style.cssText = "gap:8px;flex-wrap:wrap";
  const slab = document.createElement("span");
  slab.className = "hint";
  slab.style.cssText = "font-size:11px;flex:none";
  slab.textContent = "Thumbnail size";
  const sl = document.createElement("input");
  sl.type = "range";
  sl.min = "40";
  sl.max = "140";
  sl.step = "2";
  sl.value = String(size);
  sl.style.cssText = "width:130px;flex:none";
  sl.title = "How big the pictures show here. This is the panel only.";
  sl.addEventListener("change", () => {
    st.thumb = Math.max(40, Math.min(140, parseInt(sl.value, 10) || 58));
    render(node);
  });
  tools.append(slab, sl);
  const how = document.createElement("span");
  how.className = "hint";
  how.style.cssText = "font-size:11px;flex:none";
  how.textContent = "Right-click a picture to select it";
  tools.appendChild(how);
  btn(tools, st.sel.size ? `Unselect ${st.sel.size}` : "Select all",
      "Right-click a picture to select it one at a time. This does all of them at once.",
      () => {
        if (st.sel.size) st.sel = new Set();
        else st.sel = new Set(st.files.map((_, i) => i));
        render(node);
      });
  if (st.failed.length) {
    btn(tools, `Select the ${st.failed.length} that failed`,
        "Tick the pictures that would not run, so you can try just those again.",
        () => { st.sel = new Set(st.failed); render(node); });
  }
  right.appendChild(tools);
  cols.appendChild(right);
  box.appendChild(cols);

  host.appendChild(box);
  return box;
}

/** The "after a run" row: what happens to a picture once it has been made.
 *
 *  Its own function because it governs the single run AND the batch. Rendered
 *  twice it would be two switches for one setting, and rendered only on the batch
 *  card it would look as though a single run could not do it (the user,
 *  2026-09-20).
 */
export function afterRow(node, host, opts = {}) {
  if (!(opts.after || []).length) return null;
  const arow = document.createElement("div");
  arow.className = "rn-ws-row";
  arow.style.cssText = "gap:6px;flex-wrap:wrap;padding-top:2px;align-items:center;width:100%";
  const cap = document.createElement("span");
  cap.className = "hint";
  cap.style.cssText = "font-size:11px;flex:none";
  cap.textContent = opts.caption || "After a run:";
  arow.appendChild(cap);
  const seg = document.createElement("div");
  seg.style.cssText = "display:inline-flex;border:1px solid #3a3d44;border-radius:6px;"
                    + "overflow:hidden;flex:none";
  const flags = opts.flags?.() || {};
  for (const [fkey, label, title] of opts.after) {
    const b = document.createElement("button");
    b.className = "rn-ws-btn";
    b.textContent = label;
    b.title = title;
    b.disabled = !!opts.busy;
    b.style.cssText = "width:auto;padding:4px 14px;border:0;border-radius:0;flex:none;"
                    + (flags[fkey] ? "background:#2b3a4d;color:#cfe6ff" : "");
    b.onclick = () => {
      const f = opts.flags?.() || {};
      if (fkey === opts.manualKey) {
        // MANUAL IS EXCLUSIVE: it means nothing runs by itself, so it cannot sit
        // on at the same time as a step that does
        const turningOn = !f[fkey];
        for (const [k] of opts.after) f[k] = false;
        f[fkey] = turningOn;
      } else {
        f[fkey] = !f[fkey];
        if (f[fkey] && opts.manualKey) f[opts.manualKey] = false;
      }
      writeCfg(node);
      render(node);
    };
    seg.appendChild(b);
  }
  arow.appendChild(seg);
  const why = document.createElement("span");
  why.className = "hint";
  why.style.cssText = "font-size:11px;flex:1 1 240px;min-width:150px;line-height:1.35";
  const manual = !!(opts.manualKey && flags[opts.manualKey]);
  const on = opts.after.filter(([k]) => k !== opts.manualKey && flags[k])
    .map(([, l]) => l);
  why.textContent = manual
    ? "Nothing runs by itself. Each picture is made and left for you, and the "
      + "buttons on the result send it on."
    : on.length
    ? `${on.join(" then ")} runs on every picture this tab makes, one or a folder.`
    : "Nothing is chosen yet: pick Manual, or the steps each picture should go "
      + "through once it is made.";
  arow.appendChild(why);
  host.appendChild(arow);

  // NOTHING IS BEING KEPT. A finished picture is written to ComfyUI's temp folder
  // and the result history holds the last five, so a folder of two hundred with
  // Save off leaves a hundred and ninety-five to be cleared out.
  // MANUAL stands the warning down: it says the pictures are being dealt with by
  // hand, so being told they are not filed is telling somebody what they just said
  if (opts.saveKey && !flags[opts.saveKey] && !manual) {
    const st = batchState(node, opts.key || "upscale");
    const warn = document.createElement("div");
    warn.className = "rn-ws-batchwarn";
    warn.style.cssText = "font-size:12px;color:#f0c98a;background:#2e2413;"
                       + "border:1px solid #6b5220;border-left:3px solid #d99a2b;"
                       + "border-radius:4px;padding:6px 8px;line-height:1.45;width:100%";
    warn.textContent = st.files.length > 5
      ? `Save is off, so none of these ${st.files.length} pictures is kept. They go `
        + "to the temp folder and only the last five stay in the result history. "
        + "Switch Save on unless you are trying settings out."
      : "Save is off, so nothing is filed. A picture goes to the temp folder and is "
        + "cleared out later; the result history keeps the last five.";
    host.appendChild(warn);
  }
  return arow;
}

/** Which source box is showing: the gallery/single picture, or the batch folder.
 *
 *  A VIEW switch, not a routing one. Queue is ComfyUI's button and always renders
 *  from the gallery; the folder only ever runs from its own buttons. So this shows
 *  one box and folds the other, which is what makes the page readable, and each
 *  box still says plainly what runs it. A switch that claimed to redirect the
 *  Queue would be a lie told in a nice colour.
 */
// `extras` are further views a page offers between its own and the folder, as
// [id, label, why]; a stored view the page does not offer reads as its own
export function sourceView(node, key, extras = []) {
  const all = ((node.properties ||= {}).rn_src_view ||= {});
  if (all[key] === "batch") return "batch";
  return extras.some(([id]) => id === all[key]) ? all[key] : "own";
}

export function sourceSwitch(node, host, key, ownLabel, onPick, extras = []) {
  const cur = sourceView(node, key, extras);
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  row.style.cssText = "gap:6px;align-items:center";
  const seg = document.createElement("div");
  seg.style.cssText = "display:inline-flex;border:1px solid #3a3d44;border-radius:6px;"
                    + "overflow:hidden;flex:none;margin-left:auto";
  for (const [id, label, why] of [
    ["own", ownLabel, `Show ${ownLabel.toLowerCase()}. An ordinary Queue always `
      + "renders from this one."],
    ...extras,
    ["batch", "Batch folder", "Show the folder batch. It runs from its own buttons, "
      + "one picture per queue."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-btn";
    b.textContent = label;
    b.title = why;
    b.style.cssText = "width:auto;padding:4px 14px;border:0;border-radius:0;flex:none;"
                    + (cur === id ? "background:#2b3a4d;color:#cfe6ff" : "");
    b.onclick = () => {
      ((node.properties ||= {}).rn_src_view ||= {})[key] = id;
      onPick?.(id);
      render(node);
    };
    seg.appendChild(b);
  }
  row.appendChild(seg);
  host.appendChild(row);
  return cur;
}
