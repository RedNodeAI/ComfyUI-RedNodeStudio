import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;
import { api } from "../../scripts/api.js";
import { writeCfg, render, adoptPaintSource, adoptResult, paintDropZone,
         pruneToNode, advanceSeeds, lastResultNow, promptKeyFor,
         runPaintFinal, copyResultToInput, resultUrl, openResultMenu,
         openPaintViewer, registerUpscaleRun } from "./rednode_workspace.js";
import { batchStrip, batchState, runBatch, pickFolder } from "./rednode_ws_batch.js";

// The Upscale tab: one upscale pass on one picture, nothing else.
//
// It holds a SINGLE Detailer stage rather than a settings block of its own, so
// SeedVR2, VOSR 2.0 and the tiled upscale mean exactly what they mean on the
// Detailer and there is no second copy of that schema to drift
// (docs/ai_memory/KNOWN_TRAPS.md 13). upscale_render.py runs the stage through
// RedNodeStudioDetailer for the same reason.
//
// The result needs no pane of its own: the node writes a temp preview, and the
// Workspace's existing executed-event handler puts it in the result pane, where
// Post and Save already know what to do with it.

export const UPSCALE_METHODS = [
  ["vosr2", "VOSR 2.0",
   "Enlarges what is there instead of inventing detail. The one to reach for on "
   + "anime and lineart, and the cheapest of the three: about a quarter of the "
   + "VRAM a SeedVR2 pass wants at x4."],
  ["upscale", "SeedVR2",
   "Invents detail as it enlarges. The one to reach for on photographic work, "
   + "where made-up skin and hair texture is a bonus rather than damage."],
  ["usdu", "Tiled",
   "Ultimate SD Upscale: your own rig re-renders the picture a tile at a time. "
   + "The only one that needs a model and a prompt, and the only one that can "
   + "follow the prompt while it grows."],
  ["none", "None",
   "No upscaler at all. The picture goes through as it is, or at the size Fit "
   + "first gives it, so this tab can put a folder through the Detailer, Post and "
   + "Save without going near Img2Img."],
];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const lab = (t) => {
  const s = el("span", "hint", t);
  s.style.cssText = "flex:none;font-size:11px";
  return s;
};

function sel(options, value, title, onpick, blank) {
  const s = document.createElement("select");
  s.className = "rn-ws-res";
  s.style.cssText = "flex:none;max-width:190px";
  // built with createElement rather than new Option(): the Option constructor is
  // a browser global the panel harness does not carry, and this is the same thing
  const opt = (v, t) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = String(t);
    s.appendChild(o);
  };
  if (blank) opt("", blank);
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    opt(v, t);
  }
  s.value = String(value ?? "");
  s.title = title || "";
  s.onchange = () => onpick(s.value);
  return s;
}

function num(value, step, title, onpick) {
  const i = document.createElement("input");
  i.type = "number";
  i.className = "rn-ws-res";
  i.style.cssText = "width:78px;flex:none";
  i.step = String(step);
  i.value = String(value);
  i.title = title || "";
  i.onchange = () => {
    const v = parseFloat(i.value);
    if (Number.isFinite(v)) onpick(v);
  };
  return i;
}

function card(body, title) {
  const c = el("div", "rn-ws-card");
  const h = el("div", "ch", title);
  c.appendChild(h);
  const line = el("div", "rn-ws-row");
  line.style.cssText = "flex-wrap:wrap;gap:6px";
  c.appendChild(line);
  body.appendChild(c);
  return { card: c, line };
}

/** The one node that runs this tab, if the graph has one. */
export function upscaleNodeKey(prompt) {
  return Object.keys(prompt || {}).find(
    (k) => prompt[k]?.class_type === "RedNodeUpscaleRender") || null;
}

async function upscaleGenerate(node, statusEl) {
  const U = node._rnCfg?.upscale;
  const say = (t) => { if (statusEl) statusEl.textContent = t; };
  if (!U?.on) {
    alert("The Upscale tab is switched off, so Generate would do nothing. Switch it "
        + "on with the switch at the top of this tab.");
    return;
  }
  if (!U.source) {
    alert("Nothing to upscale. Press Use last result, drop a picture on the box, or "
        + "pick one from disk.");
    return;
  }
  say("Upscaling…");
  if (await queueUpscale(node, say, {})) {
    say("Queued. The picture appears below when it is done.");
  }
}

/** Queue THIS Workspace with an Upscale-tab token in the queued copy only.
 *
 *  Nothing is wired and no second node exists: the Workspace runs the tab itself,
 *  the same way the Paint tab's built-in pass does. An ordinary Queue carries no
 *  token, so it can never upscale or chain by accident.
 */
async function queueUpscale(node, say, over, quiet, top) {
  const { output } = await app.graphToPrompt();
  const wsKey = promptKeyFor(output, node);
  if (!wsKey) { alert("The Workspace is not in the queued graph."); return null; }
  const pruned = pruneToNode(output, wsKey);
  try {
    const c = JSON.parse(pruned[wsKey].inputs.config || "{}");
    c.upscale = { ...(c.upscale || {}), ...over };
    c.upscale.run_token = `upscale-${Date.now()}`;
    // the follow-up chain says which of the three steps it wants, in the queued
    // copy only, so the tab's own switches are left where you set them
    if (top) Object.assign(c, top);
    pruned[wsKey].inputs.config = JSON.stringify(c);
  } catch (e) {
    alert("Could not stamp the run: " + e.message);
    return null;
  }
  advanceSeeds(pruned, Object.keys(pruned));
  try {
    const res = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: pruned,
                             client_id: api.clientId ?? api.socket?.clientId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) {
      throw new Error(d.error?.message || d.error || `queue refused it (${res.status})`);
    }
    // claim the run, or the finished picture updates lastResult and never reaches
    // this tab: only the tab that asked for a result is allowed to show it
    registerUpscaleRun(String(d.prompt_id || ""), node);
    return String(d.prompt_id || "");
  } catch (err) {
    console.error("[RedNode Workspace] upscale queue failed:", err);
    say(`Could not queue it: ${err.message}`);
    if (!quiet) alert(`Could not queue it: ${err.message}`);
    return null;
  }
}

/** Wait for one prompt to finish, so a follow-up does not overlap the next picture. */
function waitForPrompt(promptId) {
  const id = String(promptId || "");
  if (!id) return Promise.resolve();
  return new Promise((resolve) => {
    const off = () => {
      for (const [n, f] of hooks) api.removeEventListener?.(n, f);
      resolve();
    };
    const hit = (e) => { if (String(e?.detail?.prompt_id || "") === id) off(); };
    const hooks = [["execution_success", hit], ["execution_error", hit],
                   ["execution_interrupted", hit]];
    for (const [n, f] of hooks) api.addEventListener?.(n, f);
  });
}

export function upscaleBody(node, body) {
  const cfg = node._rnCfg;
  const U = cfg.upscale;
  const S = U.stage;
  const w = () => writeCfg(node);
  const wr = () => { writeCfg(node); render(node); };

  // ON, and what the tab is for
  const row = el("div", "rn-ws-row");
  const on = el("button", "rn-ws-sw" + (U.on ? " on" : ""));
  on.title = U.on ? "On: Generate upscales the picture below."
                  : "Off: this tab does nothing.";
  on.onclick = () => { U.on = !U.on; wr(); };
  const hint = el("span", "hint",
    "One picture, one upscale, straight to the result pane. Nothing here touches the "
    + "main render: the Detailer is where an upscale belongs in a run.");
  row.append(on, hint);
  row.style.cssText += ";padding-bottom:8px;border-bottom:1px solid #2a2e35";
  body.appendChild(row);

  // named, because the button beside the picture and the batch card's own
  // button have to start exactly the same run
  const batchOpts = {
    runLabel: "Run All Batch",
    // checked ONCE, before the first picture: a switched-off tab fails every
    // picture in the folder, and two hundred ticks of nothing is not an answer
    precheck: () => (node._rnCfg?.upscale?.on
      ? "" : "The Upscale tab is switched off, so nothing would be upscaled. "
           + "Switch it on with the switch at the top of this tab, then run the "
           + "batch again."),
    onRun: async (file) => queueUpscale(node, () => {}, { source: file }, true),
    flags: () => node._rnCfg.upscale.after,
    saveKey: "save",
    after: [
      ["detailer", "Detailer",
       "Run the Detailer tab's passes on each upscaled picture, a face detailer "
       + "for instance, before the next one starts."],
      ["post", "Post",
       "Apply the Post tab's grading to each picture."],
      ["save", "Save",
       "File each picture through the Save tab, named and filed the usual way."],
    ],
    afterEach: async () => {
      const A = node._rnCfg.upscale.after || {};
      if (!A.detailer && !A.post && !A.save) return;
      const r = lastResultNow();
      if (!r) throw new Error("no picture came back to pass on");
      const name = await copyResultToInput(r);
      if (!name) throw new Error("the picture could not be taken across");
      // the Workspace's builtin chain IS Detailer then Post then Save, each on its
      // own switch, so the three buttons are those switches for this run only
      const pid = await queueUpscale(node, () => {},
                                     { source: name, run_mode: "chain" }, true,
                                     { detailer_on: !!A.detailer,
                                       post_on: !!A.post,
                                       save_on: !!A.save });
      if (!pid) throw new Error("the follow-up would not queue");
      await waitForPrompt(pid);
    },
  };

  // THE PICTURE
  const { card: srcCard, line: srcLine } = card(body, "PICTURE");
  const thumb = document.createElement(U.source ? "img" : "div");
  thumb.style.cssText = "width:120px;height:120px;border:1px solid #2a2e35;border-radius:6px;"
                      + "background:#15171b;flex:none;object-fit:contain";
  // AN IMG, not a background: the panel has to be able to read the picture's real
  // size, which is the first thing you want to know before upscaling it
  const sizeLine = el("span", "hint", "");
  sizeLine.style.cssText = "font-size:11px";
  if (U.source) {
    const q = new URLSearchParams({ filename: U.source.split("/").pop(),
                                    subfolder: U.source.includes("/")
                                      ? U.source.slice(0, U.source.lastIndexOf("/")) : "",
                                    type: "input" });
    thumb.src = api.apiURL(`/view?${q}`);
    const sayFrom = () => {
      const w0 = Number(thumb.naturalWidth) || 0;
      const h0 = Number(thumb.naturalHeight) || 0;
      if (!w0 || !h0) return;
      // what it is, what it is taken to, and what comes out: the three numbers
      // you would otherwise work out on paper before pressing anything
      const fit = Number(U.pre_size) || 0;
      let w = w0, h = h0;
      let line = `${w0} × ${h0}`;
      if (fit) {
        const k = fit / Math.max(w0, h0);
        const r8 = (x) => Math.max(64, Math.round(x * k / 8) * 8);
        w = r8(w0); h = r8(h0);
        line += ` → fit ${w} × ${h}`;
      }
      if (S.type === "vosr2") {
        const mul = Math.max(1, Number(S.vosr2_scale) || 2);
        line += ` → out ${w * mul} × ${h * mul}`;
      } else if (S.type === "usdu") {
        const by = Number(S.upscale_by) || 2;
        line += ` → out about ${Math.round(w * by)} × ${Math.round(h * by)}`;
      }
      sizeLine.textContent = line;
    };
    thumb.addEventListener("load", sayFrom);
    if (thumb.complete) sayFrom();
  } else {
    thumb.textContent = "Drop a picture";
    thumb.style.cssText += ";display:flex;align-items:center;justify-content:center;"
                         + "font-size:11px;color:#7f8792;text-align:center;padding:6px";
  }
  paintDropZone(node, thumb, "upscale");
  const srcBtns = el("div");
  srcBtns.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:none";
  const useLast = el("button", "rn-ws-btn", "Use last result");
  useLast.style.cssText = "width:auto;padding:3px 12px";
  useLast.title = "Take the picture the last run produced.";
  useLast.onclick = () => {
    const r = lastResultNow();
    if (!r) { alert("No result yet. Render something first, or drop a picture here."); return; }
    adoptResult(node, r, "Use last result on the Upscale tab", "upscale");
  };
  const pick = el("button", "rn-ws-btn", "Pick a picture");
  pick.style.cssText = "width:auto;padding:3px 12px";
  pick.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = async () => {
      try { await adoptPaintSource(node, (inp.files || [])[0], "upscale"); }
      catch (err) { alert(`Could not use that image: ${err.message}`); }
    };
    inp.click();
  };
  srcBtns.append(useLast, pick);
  const srcCol = el("div");
  srcCol.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;"
                       + "align-self:center";
  const srcName = el("span", "hint", U.source || "nothing chosen yet");
  srcName.style.cssText = "font-size:11px;overflow:hidden;text-overflow:ellipsis";
  srcCol.append(sizeLine, srcName);
  srcLine.append(thumb, srcBtns, srcCol);

  // THE RUN, beside the picture it works on. It used to sit in a card of its own
  // at the bottom called RUN, under the batch and the method, which read as if it
  // ran whatever was above it (the user, 2026-09-20). Next to the one picture it
  // is plainly about the one picture, and the folder's own button is beside it so
  // the difference is visible rather than remembered.
  const runBox = el("div");
  runBox.style.cssText = "margin-left:auto;display:flex;flex-direction:column;gap:6px;"
                       + "align-items:flex-end;flex:none";
  const go = el("button", "rn-ws-btn", "Run this Image");
  go.style.cssText = "width:auto;padding:6px 18px;font-weight:600;"
                   + "background:#2b3a4d;color:#cfe6ff;border-color:#3d5570";
  go.title = "Run the one picture on the left. The result appears at the bottom of "
           + "this tab, ready for Post, the Detailer or Save.";
  const status = el("span", "hint", "");
  status.style.cssText = "font-size:11px;text-align:right";
  go.onclick = () => upscaleGenerate(node, status);
  runBox.appendChild(go);

  // the folder's run, here as well as on the batch card: one of these is the
  // picture on the left, the other is every picture in the folder, and having
  // them apart is what made that unclear
  const bst = batchState(node, "upscale");
  const bgo = el("button", "rn-ws-btn",
                 bst.files.length ? `Run All Batch (${bst.files.length})`
                                  : "Pick a batch folder");
  bgo.style.cssText = "width:auto;padding:5px 16px";
  bgo.disabled = bst.running;
  bgo.title = bst.files.length
    ? "Run every picture in the batch folder below, one at a time."
    : "No folder yet. Drop one on the batch below, or press Pick a folder there.";
  bgo.onclick = () => {
    if (!bst.files.length) { pickFolder(node, "upscale"); return; }
    runBatch(node, "upscale", batchOpts.onRun, batchOpts.precheck, batchOpts.afterEach);
  };
  runBox.appendChild(bgo);

  runBox.appendChild(status);
  srcLine.appendChild(runBox);

  // THE BATCH, under the one picture: the same tab, a folder instead of a file.
  // Each picture runs on its own queue with the settings below, so the whole tab
  // means the same thing whether it is doing one or two hundred.
  batchStrip(node, "upscale", body, batchOpts);

  // THE METHOD
  const { line: mLine } = card(body, "METHOD");
  const seg = el("div");
  seg.style.cssText = "display:inline-flex;border:1px solid #3a3d44;border-radius:6px;"
                    + "overflow:hidden;flex:none";
  for (const [id, label, why] of UPSCALE_METHODS) {
    const b = el("button", "rn-ws-btn", label);
    const live = (S.type || "vosr2") === id;
    b.style.cssText = "width:auto;padding:4px 14px;border:0;border-radius:0;"
                    + (live ? "background:#2b3a4d;color:#cfe6ff" : "");
    b.title = why;
    b.onclick = () => { S.type = id; wr(); };
    seg.appendChild(b);
  }
  mLine.appendChild(seg);
  // the seed belongs with the method: it is the method that uses it, and None
  // does not use it at all, which is worth being able to see
  const seedRand = el("button", "rn-ws-sw" + (U.seed_random !== false ? " on" : ""));
  seedRand.title = "A fresh seed each run. Off pins the seed beside it.";
  seedRand.onclick = () => { U.seed_random = U.seed_random === false; wr(); };
  const seedNum = num(U.seed || 0, 1,
                      "The seed this runs on when Random seed is off.",
                      (v) => { U.seed = Math.max(0, Math.round(v)); w(); });
  if (S.type === "none") {
    seedRand.disabled = true;
    seedNum.disabled = true;
  }
  const seedWrap = el("span");
  seedWrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto";
  seedWrap.append(lab("Random seed"), seedRand, seedNum);
  seedWrap.title = S.type === "none"
    ? "None runs no sampler, so there is no seed to set."
    : "";
  mLine.appendChild(seedWrap);
  const why = el("div", "hint",
    (UPSCALE_METHODS.find((m) => m[0] === (S.type || "vosr2")) || UPSCALE_METHODS[0])[2]);
  why.style.cssText = "font-size:11px;width:100%;padding-top:4px";
  mLine.appendChild(why);

  // THE METHOD'S OWN DIALS. Field names are the Detailer stage's, on purpose.
  const { line: dLine } = card(body, "SETTINGS");
  // FIT FIRST, above the method's own dials because it happens before them. A
  // folder of mixed sizes comes out at one size this way, and the same resize the
  // Paint tab works to is used, so a picture is the same size in either tab.
  dLine.append(
    lab("Fit first"),
    sel([["512", "512 long edge"], ["768", "768"], ["1024", "1024"], ["1280", "1280"],
         ["1536", "1536"], ["2048", "2048"]],
        U.pre_size ? String(U.pre_size) : "",
        "Take the picture to this long edge BEFORE upscaling it, so a folder of "
        + "mixed sizes all comes out the same. (as it is) upscales whatever arrives, "
        + "which on a mixed folder means mixed results.",
        (v) => { U.pre_size = v ? parseInt(v, 10) : 0; wr(); }, "(as it is)"));
  const sep = el("span");
  sep.style.cssText = "width:1px;align-self:stretch;background:#2e333a;margin:0 2px";
  dLine.appendChild(sep);
  if ((S.type || "vosr2") === "vosr2") {
    dLine.append(
      lab("Scale"),
      sel([["1", "x1"], ["2", "x2"], ["3", "x3"], ["4", "x4"], ["6", "x6"], ["8", "x8"]],
          String(S.vosr2_scale ?? 2),
          "Exact output multiplier. x2 and x4 are the tested ones.",
          (v) => { S.vosr2_scale = parseInt(v, 10) || 2; w(); }),
      lab("Colour"),
      sel(["wavelet", "adain", "none"], S.vosr2_color || "wavelet",
          "Matches the result's colour back to the picture that went in.",
          (v) => { S.vosr2_color = v; w(); }),
      lab("Tile"),
      num(S.vosr2_tile ?? 512, 64,
          "The DiT tile. This one is about QUALITY: the model was trained at 512, so "
          + "output past 512 wants tiling. 0 turns tiling off.",
          (v) => { S.vosr2_tile = Math.max(0, Math.round(v)); w(); }),
      lab("VAE tile"),
      num(S.vosr2_vae_tile ?? 1024, 64,
          "The VAE tile. This one IS about memory: 0 decodes the whole picture at "
          + "once, which is the usual way to run out past about 1024px.",
          (v) => { S.vosr2_vae_tile = Math.max(0, Math.round(v)); w(); }));
  } else if (S.type === "upscale") {
    dLine.append(
      lab("Size"),
      sel(["720p", "1080p", "2K", "1440p", "4K"], S.size || "1080p",
          "The size SeedVR2 works to, as a pixel budget: the short edge is worked "
          + "out from the picture's own shape.",
          (v) => { S.size = v; w(); }),
      lab("Colour fix"),
      sel(["lab", "wavelet", "adain", "none"], S.color_fix || "lab",
          "Matches the upscale's colours back to the input.",
          (v) => { S.color_fix = v; w(); }),
      lab("Tile"),
      num(S.tile ?? 1024, 64, "VAE tile size, so a big frame fits the card.",
          (v) => { S.tile = Math.max(64, Math.round(v)); w(); }),
      lab("Blocks to swap"),
      num(S.blocks_to_swap ?? 36, 1,
          "Transformer blocks moved off the card to fit it. 36 is all of the 7B's; "
          + "0 keeps everything on the GPU, fastest and biggest.",
          (v) => { S.blocks_to_swap = Math.max(0, Math.min(36, Math.round(v))); w(); }));
  } else if (S.type === "none") {
    const note = el("div", "hint",
      "Nothing else to set: the picture goes through as it is, or at the size Fit "
      + "first gives it. What happens to it after that is the batch's follow-ups "
      + "below, or the buttons on the result.");
    note.style.cssText = "font-size:11px;flex:1 1 260px;line-height:1.35";
    dLine.appendChild(note);
  } else {
    const rigs = (cfg.models?.rigs || []).map((r, i) => r.name || `Rig ${i + 1}`);
    dLine.append(
      lab("Rig"),
      sel(rigs, S.rig || "", "Which Models-tab rig re-renders the tiles.",
          (v) => { S.rig = v; w(); }, "(active rig)"),
      lab("Upscale by"),
      num(S.upscale_by ?? 2, 0.25, "How much bigger, as a multiplier.",
          (v) => { S.upscale_by = Math.max(0.25, Math.min(4, v)); w(); }),
      lab("Denoise"),
      num(S.denoise ?? 0.25, 0.05,
          "How far each tile is re-rendered. Above about 0.4 tiles start inventing "
          + "subjects of their own.",
          (v) => { S.denoise = Math.max(0, Math.min(1, v)); w(); }),
      lab("Steps"),
      num(S.steps ?? 0, 1, "0 takes the rig's own step count.",
          (v) => { S.steps = Math.max(0, Math.round(v)); w(); }),
      lab("Tile"),
      num(S.usdu_tile ?? 1024, 64, "Tile size in pixels.",
          (v) => { S.usdu_tile = Math.max(256, Math.round(v)); w(); }));
    const note = el("div", "hint",
      "A tiled upscale renders with your rig, so it uses the rig's prompt and its "
      + "model. The other two methods load nothing of yours.");
    note.style.cssText = "font-size:11px;width:100%;padding-top:4px";
    dLine.appendChild(note);
  }

  // GO
  // THE RESULT, on this tab. The upscale runs through the Workspace's own door,
  // so the finished picture comes back on the executed event like any other run
  // and there is nowhere else to go looking for it.
  const r = lastResultNow();
  const { line: rLine } = card(body, "RESULT");
  if (!r) {
    const none = el("span", "hint",
      "Nothing yet. Press Generate and the upscaled picture appears here.");
    none.style.cssText = "font-size:11px";
    rLine.appendChild(none);
    return;
  }
  // THE SAME PREVIEW EVERY OTHER RESULT USES: resultUrl for the address,
  // openPaintViewer for full screen, openResultMenu for the right-click actions.
  // A picture drawn some other way here would be a second result system to keep
  // in step, and would quietly lose Copy, Copy prompt, Rerun and the history.
  const shot = document.createElement("img");
  shot.src = resultUrl(r);
  shot.style.cssText = "max-width:190px;max-height:190px;border:1px solid #2a2e35;"
                     + "border-radius:6px;background:#15171b;flex:none;cursor:zoom-in;"
                     + "object-fit:contain";
  shot.title = "The last picture a run produced. Click for full size, right-click "
             + "for Copy, Copy prompt and the rest.";
  shot.onclick = () => openPaintViewer(node, r);
  shot.oncontextmenu = (ev) => { ev.preventDefault(); openResultMenu(node, r, ev); };
  const acts = el("div");
  acts.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:none";
  const act = (label, title, fn) => {
    const b = el("button", "rn-ws-btn", label);
    b.style.cssText = "width:auto;padding:4px 14px";
    b.title = title;
    b.disabled = !!node._rnFinalBusy;
    b.onclick = fn;
    acts.appendChild(b);
    return b;
  };
  act("Send to Post", "Apply the Post tab to this picture and file the finished copy "
                    + "in Save.", async () => {
    try { await runPaintFinal(node, r, true); }
    catch (err) { alert(`Post and Save failed: ${err.message}`); }
  });
  // SEND TO DETAILER: the Detailer tab's passes on this picture, then Post if the
  // Post tab is on, then Save if Save is on. The builtin chain does all three, so
  // a face detailer set up on the Detailer tab just runs, with nothing rewired.
  act("Send to Detailer",
      "Run the Detailer tab's passes on this picture. Post and Save follow if "
      + "those are switched on, the same as they would on an ordinary render.",
      async () => {
    const cfgNow = node._rnCfg || {};
    if (!cfgNow.detailer_on || !((cfgNow.detailer?.stages || []).some((x) => x?.on))) {
      alert("The Detailer has no passes switched on, so this would change nothing. "
          + "Add a pass on the Detailer tab first.");
      return;
    }
    node._rnFinalStatus = "Sending to the Detailer…";
    render(node);
    // the picture is a temp preview; the server reads the input folder, so it has
    // to be copied there before the run can load it by name
    const name = await copyResultToInput(r);
    if (!name) {
      node._rnFinalStatus = "Could not take that picture across";
      node._rnFinalFailed = true;
      render(node);
      return;
    }
      const ok = await queueUpscale(node, (t) => { node._rnFinalStatus = t; },
                                  { source: name, run_mode: "chain" });
    node._rnFinalStatus = ok
      ? "Queued: Detailer" + (cfgNow.post_on !== false ? ", Post" : "")
        + (cfgNow.save_on ? ", Save" : "")
      : node._rnFinalStatus;
    node._rnFinalFailed = !ok;
    render(node);
  });
  act("Send to Paint", "Put this picture on the Paint tab, ready to paint on.", () => {
    adoptResult(node, r, "sent from the Upscale tab", "paint");
    node._rnTab = "paint";
    render(node);
  });
  act("Save", "File this picture in Save exactly as it is, with no Post.", async () => {
    try { await runPaintFinal(node, r, false); }
    catch (err) { alert(`Save failed: ${err.message}`); }
  });
  const rname = el("span", "hint", node._rnFinalStatus || "");
  rname.style.cssText = "font-size:11px;align-self:center";
  if (node._rnFinalFailed) rname.style.color = "#fca5a5";
  rLine.append(shot, acts, rname);
}
