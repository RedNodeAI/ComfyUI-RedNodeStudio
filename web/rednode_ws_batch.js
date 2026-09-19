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
  return all[key] ||= { files: [], at: -1, done: [], failed: [],
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

/** Run the batch: queueOne(file) queues that picture and returns its prompt id. */
export async function runBatch(node, key, queueOne) {
  const st = batchState(node, key);
  if (st.running || !st.files.length) return;
  st.running = true;
  st.stop = false;
  st.done = [];
  st.failed = [];
  render(node);
  try {
    for (let i = 0; i < st.files.length; i++) {
      if (st.stop) { st.note = `Stopped at ${i} of ${st.files.length}`; break; }
      st.at = i;
      st.note = `Picture ${i + 1} of ${st.files.length}`;
      render(node);
      let promptId = null;
      try {
        promptId = await queueOne(st.files[i], i);
      } catch (err) {
        console.error("[RedNode Workspace] batch queue failed:", err);
      }
      if (!promptId) {
        // A FAILURE MOVES ON. One unreadable picture must not cost the other 199.
        st.failed.push(i);
        continue;
      }
      const { ok, why } = await waitForRun(promptId);
      if (ok) st.done.push(i);
      else {
        st.failed.push(i);
        console.warn(`[RedNode Workspace] batch picture ${i + 1} failed: ${why}`);
      }
    }
    if (!st.stop) {
      st.note = st.failed.length
        ? `Finished. ${st.done.length} done, ${st.failed.length} would not run`
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
 *  counter, the stop, the marks, belongs here so both tabs behave the same.
 */
export function batchStrip(node, key, host, opts = {}) {
  const st = batchState(node, key);
  const box = document.createElement("div");
  box.className = "rn-ws-card";
  const head = document.createElement("div");
  head.className = "rn-ws-row";
  const ttl = document.createElement("div");
  ttl.className = "ch";
  ttl.textContent = "BATCH FOLDER";
  head.appendChild(ttl);

  const btn = (label, title, fn, disabled) => {
    const b = document.createElement("button");
    b.className = "rn-ws-btn";
    b.style.cssText = "width:auto;padding:3px 12px;flex:none";
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.onclick = fn;
    head.appendChild(b);
    return b;
  };
  btn("Pick a folder", "Choose a folder. Its pictures are copied into ComfyUI's own "
    + "input folder, so nothing on your drive is read by the server.",
    () => pickFolder(node, key), st.running);
  if (st.files.length && !st.running) {
    btn(opts.runLabel || "Run the batch",
        "Run every picture in turn, one per queue. A picture that fails is marked "
        + "and the rest carry on.",
        () => runBatch(node, key, opts.onRun));
    btn("Clear", "Forget this folder. The copies stay in the input folder.", () => {
      st.files = []; st.at = -1; st.done = []; st.failed = []; st.note = "";
      writeCfg(node);
      render(node);
    });
  }
  if (st.running) {
    const stop = btn(st.stop ? "Stopping…" : "Stop",
                     "Finish the picture that is running, then stop.",
                     () => { st.stop = true; render(node); }, st.stop);
    stop.className = "rn-ws-btn primary";
  }
  const note = document.createElement("span");
  note.className = "hint";
  note.style.cssText = "font-size:11px;margin-left:auto";
  note.textContent = st.note || (st.files.length ? `${st.files.length} pictures`
                                                 : "No folder yet");
  head.appendChild(note);
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

  const strip = document.createElement("div");
  strip.className = "rn-ws-batchstrip";
  strip.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  folderDropZone(node, strip, key);
  st.files.forEach((f, i) => {
    const t = document.createElement("div");
    const failed = st.failed.includes(i);
    const done = st.done.includes(i);
    const here = st.at === i;
    t.className = "rn-ws-batchthumb"
                + (here ? " here" : "") + (failed ? " failed" : "") + (done ? " done" : "");
    t.style.cssText = "width:58px;height:58px;border-radius:5px;flex:none;position:relative;"
                    + "background:#15171b center/cover no-repeat;"
                    + `background-image:url(${viewUrl(f)});`
                    + "border:2px solid " + (here ? "#4a8fe0" : failed ? "#b8283c"
                                             : done ? "#2f6b46" : "#2a2e35");
    t.title = `${i + 1}. ${f}`
            + (failed ? " — would not run" : done ? " — done" : "");
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
  box.appendChild(strip);
  host.appendChild(box);
  return box;
}
