import { overrideEntryFor } from "./rednode_shelf.js";
import { render, tabLit, setupProblems, i2iIssues, identityIssues, i2iSkipped, skippedBy,
         convActive, socketWired, packInstalled, modelListsNow, fetchModelListsOnce,
         autoStatusNow, AUTO_TAB_IDS, TEXT_TAB_IDS,
         workspacePresetCard, writeCfg, setPaintOn } from "./rednode_workspace.js";
import { jumpForStage, goTo, autoPageOf, CAPTION_TABS } from "./rednode_ws_run.js";
import { POST_FX, EXTRA_PACKS, packLink } from "./rednode_ws_tables.js";
import { postStatusNow, refreshPostStatus } from "./rednode_ws_post.js";
import { TAB_ICONS, SUB_ICON } from "./rednode_ws_icons.js";

const CAPTION_NAME = Object.fromEntries(CAPTION_TABS.map(([label, id]) => [id, label]));
// an Image to text gallery (Style, Subject, Scene words) is always "on": its page
// sits there whether or not it is used. Its emptiness only matters once its words
// are actually wired into a prompt row; otherwise it is just an unused page, not
// a stage feeding the render
const captionInUse = (id, t) => !!(t?.on && t.auto?.on
  && (!TEXT_TAB_IDS.includes(id) || t.auto.inject_row));

// THE OVERVIEW TAB: the run as it is set up right now, in the order it happens,
// as one box per stage. Green is on, grey is off, amber is on but stood aside
// (the reason on hover), red wants fixing. A click opens the page that decides
// the box. The boxes are a second view of the Run tab's plan (plannedStages)
// and the tab lights (tabLit), never a second set of rules: every state here is
// read from the same config keys those read.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
const capFirst = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);

// the Img2Img pass runs: on, not prompt only, with a picture or a wired canvas
const i2iRuns = (I) => !!(I.on && !I.prompt_only
  && ((I.images?.length || 0) > 0 || I.canvas !== "gallery"));

const PAGE_NAME = {
  models: "Models", prompts: "Prompts", camera: "Camera", loras: "LoRAs",
  latent: "Latent", i2i: "Img2Img", paint: "Paint", moodboard: "Krea 2 Moodboard", rerender: "Re-render",
  identity: "Krea 2 Identity", detailer: "Detailer", post: "Post", run: "Run",
};
const SUB_NAME = {
  source: "Source", passes: "Passes", auto: "Auto prompt", reangle: "Re-angle",
  swap: "Swap", converter: "Converter", canvas: "Canvas", save: "Save",
  gallery: "Gallery", subject: "Subject",
};
// A box's icon. Most keys are a tab or a sub-tab already, so they reuse that
// drawing; the few that are neither borrow the nearest one. TAB_ICONS wins,
// then SUB_ICON, which picks the PNG when icons/<id>.png exists.
const BOX_ICON = {
  models: "models", prompts: "prompts", camera: "camera", loras: "loras",
  moodboard: "moodboard", identity: "identity", paint: "paint", captions: "auto",
  canvas: "canvas", source: "source",
  // both spellings: the plain keys are the run's own stages, the _polish ones the
  // Detailer's second pass, and Pass 1 is "pass1" here and "sampler" there
  reangle: "reangle", reangle_polish: "reangle", swap: "swap", swap_polish: "swap",
  encode: "encode", pass1: "generate", sampler: "generate", decode: "decode", detailer: "detailer",
  post: "post", save: "save",
};
const boxIcon = (key) => {
  const id = BOX_ICON[String(key || "")];
  return id ? (TAB_ICONS[id] || SUB_ICON(id)) : "";
};

const pageOf = (to) => !to ? "" : PAGE_NAME[to.tab] + (to.sub ? " · " + (SUB_NAME[to.sub] || capFirst(to.sub)) : "");

// ---- the boxes ------------------------------------------------------------------
// { key, label, state: on | off | skip | warn, note, why, to }
export function overviewBoxes(node, cfg) {
  const tabs = cfg.tabs || {};
  const I = tabs.i2i || {};
  const M = cfg.models || {};
  const rig = M.rigs?.[M.active];
  const internal = M.sampler_mode === "internal";
  const i2iRun = i2iRuns(I);
  const probs = setupProblems(node, cfg);
  const i2iProbs = i2iIssues(cfg, node);
  // the wire the canvas names, when it is not there: the same sentence the Img2Img
  // page uses, so the box's hover and the attention line never disagree
  const wireWhy = i2iProbs.find((x) => x.sub === "source" && /wired into/.test(x.text))?.text;
  const rigProbs = probs.filter((p) => !p.startsWith("No prompt"));
  const promptProbs = probs.filter((p) => p.startsWith("No prompt"));
  const rows = (cfg.prompts?.rows || []).filter((r) => String(r.text || "").trim());
  const feeds = [];
  const run = [];

  // WHAT FEEDS THE RENDER, in tab order
  feeds.push({
    key: "models", label: "Models",
    state: rigProbs.length ? "warn" : (!internal || rig) ? "on" : "off",
    note: !internal ? "External sampler" : rig ? String(rig.name || rig.checkpoint || rig.unet || "Rig") : "No rig",
    why: rigProbs.join("\n"), to: { tab: "models" },
  });
  feeds.push({
    key: "prompts", label: "Prompts",
    state: promptProbs.length ? "warn" : rows.length ? "on" : "off",
    note: rows.length ? plural(rows.length, "prompt") : "Empty",
    why: promptProbs.join("\n"), to: { tab: "prompts" },
  });
  feeds.push({
    key: "camera", label: "Camera",
    state: tabLit(cfg, "camera") ? "on" : "off",
    note: tabLit(cfg, "camera") ? "Studio camera live" : "Off",
    to: { tab: "camera" },
  });
  const slots = (cfg.loras?.slots || []).filter((s) => s.enabled !== false && s.name && s.name !== "None");
  feeds.push({
    key: "loras", label: "LoRAs",
    state: cfg.loras?.on && slots.length ? "on" : "off",
    note: cfg.loras?.on && slots.length ? plural(slots.length, "LoRA") : cfg.loras?.on ? "None picked" : "Off",
    to: { tab: "loras" },
  });
  const mb = tabs.moodboard || {};
  feeds.push({
    key: "moodboard", label: "Krea 2 Moodboard",
    state: mb.on && mb.sel?.length ? "on" : mb.on ? "skip" : "off",
    note: mb.on && mb.sel?.length ? plural(mb.sel.length, "picture") + " picked" : mb.on ? "On, nothing picked" : "Off",
    why: mb.on && !mb.sel?.length ? "The Moodboard sends only what is picked in its gallery, and nothing is." : "",
    to: { tab: "moodboard", sub: "gallery" },
  });
  const idParts = [];
  if (tabs.subject?.on && tabs.subject.images?.length) idParts.push("Subject " + tabs.subject.images.length);
  if (tabs.scene?.on && tabs.scene.images?.length) idParts.push("Scene " + tabs.scene.images.length);
  // the mask boosts the Subject's references, so it counts only while they are in
  if (tabs.boost_mask?.on && tabs.subject?.on && tabs.subject.images?.length) idParts.push("Masks");
  const idProbs = identityIssues(cfg);
  feeds.push({
    key: "identity", label: "Krea 2 Identity",
    state: !idParts.length ? "off" : idProbs.length ? "skip" : "on",
    note: idParts.length ? idParts.join(" · ") : "Off",
    why: idProbs.map((p) => p.text + ".").join("\n"),
    to: { tab: "identity", sub: "subject" },
  });
  feeds.push({
    key: "paint", label: "Paint",
    state: cfg.paint?.on ? "on" : "off",
    note: cfg.paint?.on ? "Paint pass" : "Off",
    to: { tab: "paint" },
  });
  const capOn = AUTO_TAB_IDS.map((id) => [id, tabs[id]]).filter(([id, t]) => captionInUse(id, t));
  const capPics = capOn.filter(([, t]) => (t.images?.length || 0) > 0);
  const capEmpty = capOn.filter(([, t]) => !(t.images?.length));
  const capNames = (list) => list.map(([id]) => CAPTION_NAME[id] || id).join(", ");
  feeds.push({
    key: "captions", label: "Auto prompt",
    state: capPics.length ? "on" : capOn.length ? "skip" : "off",
    note: capPics.length ? plural(capPics.length, "gallery", "galleries") + " described"
      : capOn.length ? `On for ${capNames(capOn)}, no pictures` : "Off",
    why: capEmpty.length ? `Auto prompt is on for ${capNames(capEmpty)}, and the gallery is `
                          + `empty, so there is nothing to describe.` : "",
    to: capEmpty.length ? autoPageOf(capEmpty[0][0]) : jumpForStage("captions", cfg),
  });

  // THE RUN, IN ORDER
  const L = cfg.latent || {};
  if (i2iRun) {
    run.push({
      key: "source", label: "Source",
      state: wireWhy ? "warn" : "on",
      note: I.canvas === "image" ? (wireWhy ? "Wired image, no wire" : "Wired image")
        : I.canvas === "latent" ? (wireWhy ? "Wired latent, no wire" : "Wired latent")
        : plural(I.images.length, "picture"),
      why: wireWhy || "",
      to: { tab: "i2i", sub: "source" },
    });
  } else if (L.on) {
    const eff = (v) => Math.floor(Number(v) * (L.scale || 1) / 8) * 8;
    // the Latent tab names a wire of its own, and it can be just as absent
    const latWhy = L.source === "input" && !socketWired(node, "latent")
      ? "The Latent tab is set to the wired input, but nothing is wired into the latent "
        + "socket, so the canvas is built here instead." : "";
    run.push({
      key: "canvas", label: "Canvas",
      state: latWhy ? "warn" : "on",
      note: L.source === "input" ? (latWhy ? "Wired latent, no wire" : "Wired latent")
        : L.random ? "Random size" : `${eff(L.w)} × ${eff(L.h)}`
        + (I.on && I.prompt_only ? ", prompt from Img2Img" : ""),
      why: latWhy,
      to: { tab: "latent", sub: "canvas" },
    });
  } else {
    run.push({
      key: "canvas", label: "Canvas",
      state: internal ? "warn" : "off",
      note: "No canvas",
      why: internal ? "Switch the Latent tab on, or give Img2Img a picture: the sampler has nothing to start from." : "",
      to: { tab: "latent", sub: "canvas" },
    });
  }
  const R = I.reangle || {};
  const S = I.swap || {};
  // the Editor's source stages edit the Editor's own picture
  const E = tabs.editor_src || {};
  const offWhy = "The Editor has no source picture.";
  const refName = (r) => r === "subject" ? "Main subject" : r === "own" ? "Own picture"
    : "Person " + String(r || "").replace("subject", "");
  const ownEmpty = S.reference === "own" && !(tabs.swap_ref?.images?.length);
  // ONE SHAPE FOR BOTH EDIT STAGES: on the source before its pass, or on the render
  const editBox = (key, label, X, onRender, blockedExtra, note) => {
    const blocked = blockedExtra || ((!onRender && !E.images?.length
                                       && !overrideEntryFor(cfg, "editor_src")) ? offWhy : "");
    return {
      key: onRender ? key + "_render" : key,
      label: onRender ? label + " on the render" : label,
      state: !X.on ? "off" : blocked ? "skip" : "on",
      note: !X.on ? "Off" : blocked ? "Skipped" : note + (!onRender ? ", is the output" : ""),
      why: X.on ? blocked : "",
      to: { tab: "i2i", sub: key },
    };
  };
  const raTarget = R.target || "source";
  const raNote = R.camera === "studio" ? "Camera from the Camera tab" : "From the bands";
  const swapTarget = S.target || "source";
  const swNote = capFirst(S.mode || "face") + " from " + refName(S.reference || "subject");
  const swBlocked = ownEmpty ? "Own picture is picked and the Swap gallery is empty." : "";
  if (!R.on || raTarget !== "render") run.push(editBox("reangle", "Re-angle", R, false, "", raNote));
  if (I.realism?.on) run.push(editBox("realism", "Re-render", I.realism, false, "",
                                          I.realism.photo ? "Photo finish" : "Anime to photo"));
  if (!S.on || swapTarget !== "render") run.push(editBox("swap", "Swap", S, false, swBlocked, swNote));
  if (internal) {
    run.push({ key: "encode", label: "Encode", state: "on",
               note: rows.length ? plural(rows.length, "prompt") : "No prompt", to: { tab: "prompts" } });
    const n = Math.max(1, Math.round(Number(i2iRun ? I.passes : L.passes) || 1));
    const skipped = i2iRun && i2iSkipped(I, E);
    const who = skippedBy(I, E);
    for (let i = 1; i <= n; i++) {
      run.push({
        key: `pass${i}`, label: `Pass ${i}`,
        state: skipped ? "skip" : "on",
        note: skipped ? "Skipped" : i > 1 ? "Refine" : i2iRun ? "Img2Img" : "Generate",
        why: skipped ? `The Editor's ${who} picture is the image output, so the pass is skipped.` : "",
        to: jumpForStage(`pass${i}`, cfg),
      });
    }
    run.push({ key: "decode", label: "Decode", state: "on", note: "On the rig's VAE", to: { tab: "models" } });
  } else {
    run.push({
      key: "sampler", label: "Sampler", state: "off", note: "External sampler",
      why: "The Workspace renders nothing itself: your own sampler nodes do, from its outputs.",
      to: { tab: "models" },
    });
  }
  if (R.on && raTarget === "render") {
    const box = editBox("reangle", "Re-angle", R, true, "", raNote);
    run.push(box);
    if (box.state === "on" && R.polish !== false && internal) {
      run.push({ key: "reangle_polish", label: "Re-angle polish", state: "on", note: "Low denoise on the rig",
                 to: { tab: "i2i", sub: "reangle" } });
    }
  }
  if (S.on && swapTarget === "render") {
    const box = editBox("swap", "Swap", S, true, swBlocked, swNote);
    run.push(box);
    if (box.state === "on" && S.polish !== false && internal) {
      run.push({ key: "swap_polish", label: "Swap polish", state: "on", note: "Low denoise on the rig",
                 to: { tab: "i2i", sub: "swap" } });
    }
  }
  const stages = (cfg.detailer?.stages || []).filter((s) => s.on && s.type !== "title");
  const detOn = !!(cfg.detailer_on && stages.length);
  run.push({
    key: "detailer", label: "Detailer",
    state: !detOn ? "off" : cfg.draft ? "skip" : "on",
    note: !detOn ? (cfg.detailer_on ? "No pass on" : "Off") : cfg.draft ? "Draft run" : plural(stages.length, "pass", "passes"),
    why: detOn && cfg.draft ? "Draft is on: the Detailer passes the picture through." : "",
    to: { tab: "detailer" },
  });
  const fx = POST_FX.filter((f) => cfg.post?.[f.id]?.on);
  const postOn = cfg.post_on !== false && fx.length > 0;
  run.push({
    key: "post", label: "Post FX",
    state: !postOn ? "off" : cfg.draft ? "skip" : "on",
    note: !postOn ? (cfg.post_on === false ? "Off" : "No effect on") : cfg.draft ? "Draft run" : plural(fx.length, "effect"),
    why: postOn && cfg.draft ? "Draft is on: Post FX passes the picture through." : "",
    to: { tab: "post" },
  });
  run.push({
    key: "save", label: "Save",
    state: cfg.save_on ? "on" : "off",
    note: cfg.save_on ? "Filed by the Workspace" : "Not filed here",
    to: { tab: "run", sub: "save" },
  });

  // WHAT NEEDS ATTENTION: the setup problems, the Img2Img issues and every box
  // that is stood aside, one line each, each pointing at its page
  const attention = [];
  const seen = new Set();
  const add = (text, to) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    attention.push({ text, to });
  };
  for (const p of rigProbs) add(p, { tab: "models" });
  for (const p of promptProbs) add(p, { tab: "prompts" });
  for (const it of i2iProbs) add(it.text, { tab: "i2i", sub: it.sub });
  for (const it of idProbs) add(it.text, { tab: it.tab, sub: it.tab === "identity" ? it.sub : undefined });
  for (const b of [...feeds, ...run]) {
    if ((b.state === "skip" || b.state === "warn") && b.why
        && !attention.some((a) => a.text.includes(b.why))) {
      add(b.label + ": " + b.why, b.to);
    }
  }
  if (I.on && convActive(I.conv) && !I.auto?.on) {
    add("The Img2Img converter is on with its auto prompt off, so it has nothing to rework", { tab: "i2i", sub: "converter" });
  }
  return { feeds, run, attention };
}

// ---- the switches behind a box ----------------------------------------------------
// RIGHT-CLICK TURNS A STAGE ON OR OFF from here. Each entry is the SAME config key
// the stage's own page flips, never a second rule: [{ name, on, set(on) }]. A box
// with no single switch (Models, Prompts, Encode, a Pass, Decode) has none, and
// its menu only opens the page.
export function boxSwitches(node, cfg, key) {
  const tabs = cfg.tabs || {};
  const I = tabs.i2i || {};
  const flag = (name, obj, k, dflt = false) => !obj ? [] : [{
    name, on: obj[k] === undefined ? dflt : !!obj[k], set: (v) => { obj[k] = !!v; } }];
  const base = String(key).replace(/_render$/, "");
  if (base === "camera") return flag("Camera", cfg.camera, "on", true);
  if (base === "loras") return flag("LoRAs", cfg.loras, "on");
  if (base === "moodboard") return flag("Krea 2 Moodboard", tabs.moodboard, "on");
  if (base === "identity") {
    return [...flag("Subject", tabs.subject, "on"), ...flag("Scene", tabs.scene, "on"),
            ...flag("Masks", tabs.boost_mask, "on")];
  }
  if (base === "paint") {
    return [{ name: "Paint", on: !!cfg.paint?.on, set: (v) => setPaintOn(node, v), self: true }];
  }
  if (base === "captions") {
    // only the galleries whose auto prompt is on: this menu switches things off and
    // back, it does not pick which gallery to describe
    return AUTO_TAB_IDS.filter((id) => tabs[id]?.auto?.on).flatMap((id) =>
      flag("Auto prompt for " + (CAPTION_NAME[id] || capFirst(id)), tabs[id].auto, "on"));
  }
  if (base === "source") return flag("Img2Img", I, "on");
  // Img2Img too: turning it off on the Source box leaves this box in its place,
  // and the way back has to be here
  if (base === "canvas") return [...flag("Latent", cfg.latent, "on"), ...flag("Img2Img", I, "on")];
  if (base === "reangle") return flag("Re-angle", I.reangle, "on");
  if (base === "swap") return flag("Swap", I.swap, "on");
  if (base === "reangle_polish") return flag("Re-angle polish", I.reangle, "polish", true);
  if (base === "swap_polish") return flag("Swap polish", I.swap, "polish", true);
  if (base === "detailer") return flag("Detailer", cfg, "detailer_on");
  if (base === "post") return flag("Post FX", cfg, "post_on", true);
  if (base === "save") return flag("Save", cfg, "save_on");
  return [];
}

// the menu itself: DOM at the cursor, closed by any outside press (UI_CONVENTIONS)
function openBoxMenu(node, b, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector(".rn-ws-menu")?.remove();
  const m = el("div", "rn-ws-menu rn-ov-menu");
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  m.appendChild(el("div", "note", b.label));
  const item = (label, fn) => {
    const bt = el("button", "", label);
    bt.onclick = () => { m.remove(); fn(); };
    m.appendChild(bt);
  };
  const sws = boxSwitches(node, node._rnCfg, b.key);
  for (const s of sws) {
    item((s.on ? "Turn off " : "Turn on ") + s.name, () => {
      s.set(!s.on);
      if (!s.self) { writeCfg(node); render(node); }
    });
  }
  if (!sws.length) m.appendChild(el("div", "note", "No single switch. It is set on its page."));
  m.appendChild(el("div", "sep"));
  item("Open " + pageOf(b.to), () => goTo(node, b.to));
  document.body.appendChild(m);
  const mw = 230, mh = m.getBoundingClientRect?.().height || 120;
  m.style.left = Math.max(6, Math.min(ev.clientX || 0, (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY || 0, (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

// ---- WHAT THIS RUN NEEDS ---------------------------------------------------------
// Only what the settings actually call for, so it is a short list rather than
// every optional pack the Workspace can use. Nothing here installs or downloads
// anything: it reads the node types ComfyUI already loaded and the model file
// lists ComfyUI already hands the panel, and then says where to get what is
// missing. Installing stays with ComfyUI Manager, where you can see what it does.
const CAPTION_ENGINES = [["wd14", "WD14 tags"], ["florence", "Florence"],
                         ["joy", "JoyCaption"], ["qwen", "QwenVL"]];
const packBy = (id) => EXTRA_PACKS.find((p) => p.id === id);

// {ok, label, what, how, url, to} for everything this setup leans on
export function runNeeds(node, cfg) {
  const out = [];
  const tabs = cfg.tabs || {};
  const I = tabs.i2i || {};
  const seen = new Set();
  const wantPack = (id, why, to) => {
    const p = packBy(id);
    if (!p || seen.has(id)) return;
    seen.add(id);
    out.push({ kind: "pack", ok: packInstalled(p), label: p.name, what: why || p.what,
               how: `Install it in ComfyUI Manager: search for ${p.name}.`,
               url: packLink(p), to });
  };
  // the Detailer's passes, each by what it runs through
  const stages = (cfg.detailer?.stages || []).filter((s) => s.on && s.type !== "title");
  if (cfg.detailer_on) {
    if (stages.some((s) => s.type === "upscale")) wantPack("seedvr2", null, { tab: "detailer" });
    if (stages.some((s) => s.type === "vosr2")) wantPack("vosr2", null, { tab: "detailer" });
    if (stages.some((s) => s.type === "usdu")) wantPack("usdu", null, { tab: "detailer" });
    if (stages.some((s) => s.type === "detailer")) {
      wantPack("sam3", "finding what a Detailer pass works on", { tab: "detailer" });
      // the pack installs without its checkpoints, and the pass then fails on the
      // file rather than the pack, which read as the pack being fine
      if (packInstalled(packBy("sam3")) === true) {
        out.push({ kind: "file", ok: (modelListsNow()?.sam3 || []).length > 0,
                   label: "A SAM3 checkpoint", what: "what ComfyUI-Easy-Sam3 segments with",
                   how: "Put one in models/sam3, then pick it as the SAM file on a Detailer "
                      + "pass. The pack installs without it, and a pass then says the file "
                      + "is not found. This one is Meta's SAM3 packed for the node:",
                   url: "https://huggingface.co/yolain/sam3-safetensors",
                   to: { tab: "detailer" } });
      }
    }
  }
  if (cfg.paint?.on) wantPack("sam3", "the Paint tab's auto mask", { tab: "paint" });
  // THE POST CARDS, on the same terms the cards themselves use: an effect that
  // reads depth, and a Limit row that needs the subject picked out. The server's
  // own report answers whether each is here, since it knows every estimator and
  // segmenter name rather than the one node type this table carries.
  const ps = postStatusNow() || {};
  const ready = (kind, id) => (typeof ps?.[kind]?.ready === "boolean"
    ? ps[kind].ready : packInstalled(packBy(id)) === true);
  if (cfg.post_on !== false) {
    const live = (cfg.post?.chain || []).filter((b) => b && b.on);
    const fxOf = (b) => POST_FX.find((f) => f.id === (b.fx || b.id));
    const depthers = live.filter((b) => fxOf(b)?.depth).map((b) => fxOf(b).label);
    if (depthers.length) {
      const p = packBy("depthaux");
      out.push({ kind: "pack", ok: ready("depth", "depthaux"), label: p.name,
                 what: `the depth ${depthers.join(", ")} read`,
                 how: `Install it in ComfyUI Manager: search for ${p.name}. Its estimators `
                    + "fetch their own weights the first time they run.",
                 url: packLink(p), to: { tab: "post" } });
    }
    const limited = live.filter((b) => b.limit === "subject" || b.limit === "background");
    if (limited.length) {
      const p = packBy("rmbg");
      out.push({ kind: "pack", ok: ready("mask", "rmbg"), label: p.name,
                 what: `the subject mask ${limited.length} Limit row`
                     + `${limited.length === 1 ? "" : "s"} need`,
                 how: `Install it in ComfyUI Manager: search for ${p.name}. RMBG-2.0 is the `
                    + "one to have for this.",
                 url: packLink(p), to: { tab: "post" } });
    }
  }
  // the rig's loader, when it names one that is not core's
  const rig = cfg.models?.rigs?.[cfg.models?.active];
  if (cfg.models?.sampler_mode === "internal" && rig) {
    const byName = /\.gguf$/i.test(String(rig.unet || ""));
    if (rig.unet_loader === "gguf" || (!rig.unet_loader && byName)) {
      wantPack("gguf", "loading this rig's .gguf model", { tab: "models" });
    }
    if (rig.unet_loader === "int8") wantPack("int8", "loading this rig's INT8 model", { tab: "models" });
  }
  // the caption engines that are switched on somewhere
  const status = autoStatusNow() || {};
  // an engine is only wanted where a gallery that is genuinely in use has pictures
  // for it: an Image to text page sits there switched on whether or not it is used,
  // and an empty gallery loads no engine at all
  const engineOn = (key) => AUTO_TAB_IDS.some((id) => captionInUse(id, tabs[id])
    && (tabs[id].images?.length || 0) > 0 && tabs[id].auto[key]);
  for (const [key, label] of CAPTION_ENGINES) {
    const p = packBy(key);
    if (!p || !engineOn(key)) continue;
    out.push({ kind: "pack", ok: !!status[key], label: p.name,
               what: `the ${label} caption engine`,
               how: `Install it in ComfyUI Manager: search for ${p.name}.`,
               url: packLink(p), to: { tab: "i2i", sub: "auto" } });
  }
  if (engineOn("ollama")) {
    out.push({ kind: "service", ok: !!status.ollama, label: "Ollama",
               what: "the Ollama caption engine",
               how: "Ollama is a program of its own, not a node pack. Start it, then pull a "
                  + "vision model such as llava or qwen2.5vl.",
               url: "https://ollama.com", to: { tab: "i2i", sub: "auto" } });
  }
  // THE MODEL FILES the edit stages load, when those stages will run
  const L = modelListsNow();
  const fileRow = (label, name, list, where, to) => {
    if (!name || !L) return;
    out.push({ kind: "file", ok: (list || []).includes(name), label: name,
               what: label, how: `Put it in ${where}.`, to });
  };
  const editFiles = (X, what, to) => {
    fileRow(`${what}: the edit model`, X.unet, L.unets, "models/diffusion_models", to);
    fileRow(`${what}: the text encoder`, X.clip, L.clips, "models/text_encoders", to);
    fileRow(`${what}: the VAE`, X.vae, L.vaes, "models/vae", to);
    for (const k of ["lora_angles", "lora_swap", "lora_light"]) {
      if (X[k] && X[k] !== "None") fileRow(`${what}: a LoRA`, X[k], L.loras, "models/loras", to);
    }
  };
  const R = I.reangle || {};
  const S = I.swap || {};
  const i2iRun = i2iRuns(I);
  if (R.on && (R.target === "render" || i2iRun)) {
    editFiles(R, "Re-angle", { tab: "i2i", sub: "reangle" });
  }
  if (S.on && (S.target === "render" || i2iRun)) {
    editFiles(S, "Swap", { tab: "i2i", sub: "swap" });
  }
  return out;
}

// ---- the page -------------------------------------------------------------------
export function overviewBody(node, body) {
  const cfg = node._rnCfg;
  const { feeds, run, attention } = overviewBoxes(node, cfg);
  const wrap = el("div", "rn-ov");
  wrap.appendChild(el("div", "rn-ws-card rn-ws-note rn-ov-intro",
    "The run as it is set up right now, in the order it happens. Green is on, grey is off, "
    + "amber is on but stood aside, red wants fixing; hover a box for the reason. Click a box "
    + "to open the page that decides it, right-click to turn it on or off."));

  const rowCard = (title, boxes, arrows) => {
    const card = el("div", "rn-ws-card rn-ov-card");
    card.appendChild(el("div", "ch", title));
    const row = el("div", "rn-ov-row");
    boxes.forEach((b, i) => {
      if (i && arrows) row.appendChild(el("span", "rn-ov-arrow", "→"));
      const bx = el("button", "rn-ov-box " + b.state);
      bx.dataset.key = b.key;
      bx.dataset.state = b.state;
      // the icon, the label and the note are all DIRECT children: the box is read
      // by its text elsewhere, so the label must not be nested inside a wrapper
      const mark = boxIcon(b.key);
      if (mark) {
        const ic = el("span", "ic");
        ic.innerHTML = mark;
        bx.appendChild(ic);
        bx.classList.add("hasic");
      }
      bx.append(el("span", "t", b.label), el("span", "st", b.note));
      bx.title = (b.why ? b.why + "\n" : "") + "Opens " + pageOf(b.to) + "."
               + (boxSwitches(node, cfg, b.key).length ? " Right-click to turn it on or off." : "");
      bx.onclick = () => goTo(node, b.to);
      bx.addEventListener("contextmenu", (e) => openBoxMenu(node, b, e));
      row.appendChild(bx);
    });
    card.appendChild(row);
    wrap.appendChild(card);
  };
  // the whole setup is loaded and saved on the page that shows the whole setup
  wrap.appendChild(workspacePresetCard(node));
  rowCard("WHAT FEEDS THE RENDER", feeds, false);
  rowCard("THE RUN, IN ORDER", run, true);

  const att = el("div", "rn-ws-card rn-ov-card rn-ov-attention");
  att.appendChild(el("div", "ch", "NEEDS ATTENTION"));
  if (!attention.length) {
    att.appendChild(el("div", "rn-ws-note rn-ov-clear", "Nothing stands in the way of a run."));
  } else {
    for (const a of attention) {
      const line = el("button", "rn-ov-issue", a.text);
      line.title = "Opens " + pageOf(a.to) + ".";
      line.onclick = () => goTo(node, a.to);
      att.appendChild(line);
    }
  }
  wrap.appendChild(att);

  // WHAT THIS RUN NEEDS, behind a button: the packs, engines and model files the
  // settings call for, each said to be here or not, with where to get it
  const needs = el("div", "rn-ws-card rn-ov-card rn-ov-needs");
  const nhead = el("div", "rn-ov-needhead");
  nhead.appendChild(el("div", "ch", "WHAT THIS RUN NEEDS"));
  const btn = el("button", "rn-ws-btn rn-ov-check", node._rnNeeds ? "Check again" : "Check installs");
  btn.title = "Look at what this setup calls for and say what is already installed here. "
            + "It reads what ComfyUI has loaded; it never downloads or installs anything.";
  btn.onclick = async () => {
    btn.disabled = true;
    try { await fetchModelListsOnce(); } catch (e) { /* the file rows simply sit out */ }
    try { await refreshPostStatus(); } catch (e) { /* the Post rows fall back to node types */ }
    node._rnNeeds = true;
    render(node);
  };
  nhead.appendChild(btn);
  needs.appendChild(nhead);
  if (!node._rnNeeds) {
    needs.appendChild(el("div", "rn-ws-note", "Press Check installs to see the node packs, "
      + "caption engines and model files these settings call for, and which of them are "
      + "already here."));
  } else {
    const rows = runNeeds(node, cfg);
    if (!rows.length) {
      needs.appendChild(el("div", "rn-ws-note rn-ov-clear",
        "These settings need nothing beyond the pack itself."));
    }
    for (const r of rows) {
      const line = el("div", "rn-ov-need" + (r.ok ? " ok" : " missing"));
      const top = el("div", "t");
      top.appendChild(el("span", "mark", r.ok ? "\u2713" : "\u2717"));
      const nm = el("button", "nm", r.label);
      nm.title = r.to ? "Open where this is set." : "";
      if (r.to) nm.onclick = () => goTo(node, r.to);
      else nm.disabled = true;
      top.append(nm, el("span", "for", r.what));
      line.appendChild(top);
      if (!r.ok) {
        const how = el("div", "how");
        how.appendChild(el("span", "", r.how + " "));
        if (r.url) {
          const a = document.createElement("a");
          a.href = r.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = r.url;
          a.className = "lnk";
          how.appendChild(a);
        }
        line.appendChild(how);
      }
      needs.appendChild(line);
    }
    const foot = el("div", "rn-ws-note rn-ov-needfoot",
      "Nothing is downloaded or installed from here. The links only show you where a pack "
      + "lives; ComfyUI Manager does the installing, where you can see what it is doing.");
    needs.appendChild(foot);
  }
  wrap.appendChild(needs);
  body.appendChild(wrap);
}

export const OVERVIEW_CSS = `
.rn-ws-tab.g-view{--rn-g:#c9d1d9}
.rn-ov{display:flex;flex-direction:column;gap:10px}
.rn-ov-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.rn-ov-arrow{color:#4a5058;font-size:15px;flex:none;line-height:1}
.rn-ov-box{flex:0 1 auto;min-width:104px;background:#15171b;border:1px solid #33373d;
  border-radius:8px;padding:7px 10px;display:flex;flex-direction:column;gap:3px;cursor:pointer;
  text-align:left;color:inherit;font:inherit;position:relative}
.rn-ov-box.hasic{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:center}
.rn-ov-box.hasic .ic{grid-row:1 / span 2;display:block;width:14px;height:14px;color:#c6ccd4}
.rn-ov-box.hasic .t,.rn-ov-box.hasic .st{grid-column:2}
.rn-ov-box .ic svg,.rn-ov-box .ic .rn-ws-icimg{width:14px;height:14px}
.rn-ov-box.on .ic{color:#9fe0b4}
.rn-ov-box .t{font-weight:700;font-size:12.5px;color:#e8ecf1;white-space:nowrap}
.rn-ov-box .st{font-size:11px;color:#9aa0a8;white-space:nowrap}
.rn-ov-box.on{border-color:#2e7d4f}
.rn-ov-box.on .st{color:#9fe0b4}
.rn-ov-box.off{opacity:.5}
.rn-ov-box.skip{border-color:#e0a84a;background:#26200f}
.rn-ov-box.skip .st{color:#f3d9a4}
.rn-ov-box.warn{border-color:#b8283c;background:#26161a}
.rn-ov-box.warn .st{color:#f3b0ba}
.rn-ov-box:hover{border-color:#8fa8c8;opacity:1}
.rn-ov-issue{background:none;border:1px solid #6b5326;border-radius:6px;color:#f3d9a4;
  font-size:12px;padding:5px 10px;cursor:pointer;text-align:left;font-family:inherit}
.rn-ov-issue:hover{border-color:#e0a84a;color:#fff}
.rn-ov-clear{color:#9fe0b4}
.rn-ov-needhead{display:flex;align-items:center;gap:10px}
.rn-ov-needhead .ch{flex:1}
.rn-ov-check{width:auto;padding:0 12px;flex:none}
.rn-ov-need{display:flex;flex-direction:column;gap:2px;padding:5px 0;
  border-top:1px solid #23262c}
.rn-ov-need .t{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.rn-ov-need .mark{flex:none;font-weight:700}
.rn-ov-need.ok .mark{color:#4ade80}
.rn-ov-need.missing .mark{color:#f3b0ba}
.rn-ov-need .nm{background:none;border:0;padding:0;font:inherit;font-weight:600;
  font-size:12.5px;color:#e8ecf1;cursor:pointer;text-align:left}
.rn-ov-need .nm:disabled{cursor:default}
.rn-ov-need .nm:hover:not(:disabled){text-decoration:underline}
.rn-ov-need .for{font-size:11.5px;color:#8a919b}
.rn-ov-need .how{font-size:11.5px;color:#f3d9a4;padding-left:18px}
.rn-ov-need .lnk{color:#8fc0ff}
.rn-ov-needfoot{padding-top:6px}
`;

export const _OVERVIEW_FOR_TESTS = { i2iRuns, render };
