import { render, tabLit, setupProblems, i2iIssues, i2iSkipped, skippedBy, convActive,
         AUTO_TAB_IDS, TEXT_TAB_IDS } from "./rednode_workspace.js";
import { jumpForStage, goTo, autoPageOf, CAPTION_TABS } from "./rednode_ws_run.js";
import { POST_FX } from "./rednode_ws_tables.js";

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
  latent: "Latent", i2i: "Img2Img", paint: "Paint", moodboard: "Moodboard",
  identity: "Krea 2 Identity", detailer: "Detailer", post: "Post", run: "Run",
};
const SUB_NAME = {
  source: "Source", passes: "Passes", auto: "Auto prompt", reangle: "Re-angle",
  swap: "Swap", converter: "Converter", canvas: "Canvas", save: "Save",
  gallery: "Gallery", subject: "Subject",
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
    key: "moodboard", label: "Moodboard",
    state: mb.on && mb.sel?.length ? "on" : mb.on ? "skip" : "off",
    note: mb.on && mb.sel?.length ? plural(mb.sel.length, "picture") + " picked" : mb.on ? "On, nothing picked" : "Off",
    why: mb.on && !mb.sel?.length ? "The Moodboard sends only what is picked in its gallery, and nothing is." : "",
    to: { tab: "moodboard", sub: "gallery" },
  });
  const idParts = [];
  if (tabs.subject?.on && tabs.subject.images?.length) idParts.push("Subject " + tabs.subject.images.length);
  if (tabs.scene?.on && tabs.scene.images?.length) idParts.push("Scene " + tabs.scene.images.length);
  if (tabs.boost_mask?.on) idParts.push("Masks");
  feeds.push({
    key: "identity", label: "Krea 2 Identity",
    state: idParts.length ? "on" : "off",
    note: idParts.length ? idParts.join(" · ") : "Off",
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
      state: "on",
      note: I.canvas === "image" ? "Wired image" : I.canvas === "latent" ? "Wired latent"
        : plural(I.images.length, "picture"),
      to: { tab: "i2i", sub: "source" },
    });
  } else if (L.on) {
    const eff = (v) => Math.floor(Number(v) * (L.scale || 1) / 8) * 8;
    run.push({
      key: "canvas", label: "Canvas",
      state: "on",
      note: L.source === "input" ? "Wired latent" : L.random ? "Random size" : `${eff(L.w)} × ${eff(L.h)}`
        + (I.on && I.prompt_only ? ", prompt from Img2Img" : ""),
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
  const offWhy = !I.on ? "Img2Img is off." : I.prompt_only ? "Prompt only is on, so the source only donates its prompt."
    : "Img2Img has no picture.";
  const refName = (r) => r === "subject" ? "Main subject" : r === "own" ? "Own picture"
    : "Person " + String(r || "").replace("subject", "");
  const ownEmpty = S.reference === "own" && !(tabs.swap_ref?.images?.length);
  // ONE SHAPE FOR BOTH EDIT STAGES: on the source before its pass, or on the render
  const editBox = (key, label, X, onRender, blockedExtra, note) => {
    const blocked = blockedExtra || ((!onRender && !i2iRun) ? offWhy : "");
    return {
      key: onRender ? key + "_render" : key,
      label: onRender ? label + " on the render" : label,
      state: !X.on ? "off" : blocked ? "skip" : "on",
      note: !X.on ? "Off" : blocked ? "Skipped" : note + (!onRender && X.skip_pass ? ", skips the pass" : ""),
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
  if (!S.on || swapTarget !== "render") run.push(editBox("swap", "Swap", S, false, swBlocked, swNote));
  if (internal) {
    run.push({ key: "encode", label: "Encode", state: "on",
               note: rows.length ? plural(rows.length, "prompt") : "No prompt", to: { tab: "prompts" } });
    const n = Math.max(1, Math.round(Number(i2iRun ? I.passes : L.passes) || 1));
    const skipped = i2iRun && i2iSkipped(I);
    const who = skippedBy(I);
    for (let i = 1; i <= n; i++) {
      run.push({
        key: `pass${i}`, label: `Pass ${i}`,
        state: skipped ? "skip" : "on",
        note: skipped ? "Skipped" : i > 1 ? "Refine" : i2iRun ? "Img2Img" : "Generate",
        why: skipped ? `${who} skips the pass: the edited picture is the image output.` : "",
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
  for (const it of i2iIssues(cfg)) add(it.text, { tab: "i2i", sub: it.sub });
  for (const b of [...feeds, ...run]) {
    if ((b.state === "skip" || b.state === "warn") && b.why) add(b.label + ": " + b.why, b.to);
  }
  if (I.on && convActive(I.conv) && !I.auto?.on) {
    add("The Img2Img converter is on with its auto prompt off, so it has nothing to rework", { tab: "i2i", sub: "converter" });
  }
  return { feeds, run, attention };
}

// ---- the page -------------------------------------------------------------------
export function overviewBody(node, body) {
  const cfg = node._rnCfg;
  const { feeds, run, attention } = overviewBoxes(node, cfg);
  const wrap = el("div", "rn-ov");
  wrap.appendChild(el("div", "rn-ws-card rn-ws-note rn-ov-intro",
    "The run as it is set up right now, in the order it happens. Green is on, grey is off, "
    + "amber is on but stood aside, red wants fixing; hover a box for the reason. Click a box "
    + "to open the page that decides it."));

  const rowCard = (title, boxes, arrows) => {
    const card = el("div", "rn-ws-card rn-ov-card");
    card.appendChild(el("div", "ch", title));
    const row = el("div", "rn-ov-row");
    boxes.forEach((b, i) => {
      if (i && arrows) row.appendChild(el("span", "rn-ov-arrow", "→"));
      const bx = el("button", "rn-ov-box " + b.state);
      bx.dataset.key = b.key;
      bx.dataset.state = b.state;
      bx.append(el("span", "t", b.label), el("span", "st", b.note));
      bx.title = (b.why ? b.why + "\n" : "") + "Opens " + pageOf(b.to) + ".";
      bx.onclick = () => goTo(node, b.to);
      row.appendChild(bx);
    });
    card.appendChild(row);
    wrap.appendChild(card);
  };
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
`;

export const _OVERVIEW_FOR_TESTS = { i2iRuns, render };
