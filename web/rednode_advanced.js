import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// RedNode Studio Detailer — the post-render passes as a list you can read.
//
// Start, the passes in order, End. Each pass is a card: the top line says what it
// is, whose rig runs it and what it aims at; the bottom line is the full sampler
// vocabulary, steps, CFG, sampler, scheduler, a start/end step window and the
// denoise. Anything left at "rig" inherits the rig's own settings, so the Models
// tab stays the one place a model's numbers live. An empty prompt uses the rig's
// own Prompts-tab row, the same text the main render used.
//
// Widget lifecycle follows the house pattern: the native config widget is HIDDEN,
// never removed, and stays the value holder; the panel reads and writes it.

const NODE_NAMES = ["RedNodeStudioDetailer", "RedNodeStudioAdvanced"];
const TARGETS = ["face", "hair", "hands", "eyes", "clothes", "background"];

// the Control Panel's row palette, verbatim: one set of colours across the pack
const COLORS = [
  { n: "none", v: null }, { n: "red", v: "#7f2230" }, { n: "orange", v: "#7a4416" },
  { n: "green", v: "#1e5233" }, { n: "teal", v: "#14514f" }, { n: "blue", v: "#1d3f6e" },
  { n: "purple", v: "#492a6b" }, { n: "pink", v: "#6b2450" }, { n: "grey", v: "#3a3f47" },
];

// shipped layouts. The face identity chain is the user's own proven recipe
// (2026-08-14, verified against a real reference; DOC_NOTES.md tells the story):
// grow the frame, redraw the face with the Subject refs, then one gentle
// whole-frame pass. Rigs stay unset because rig names are per-workspace: the
// LAST TWO passes belong on the official Krea 2 Turbo rig, where identity
// LoRAs actually fire - merged models will not answer them.
const PREMADES = {
  "Face identity chain": [
    { type: "sampler", on: true, rig: "", steps: 4, denoise: 0.09, scale: 1.5,
      use_subject: true, prompt: "" },
    { type: "detailer", on: true, rig: "", target: "face", steps: 8,
      denoise: 0.5, sampler: "euler_ancestral", scheduler: "simple",
      threshold: 0.5, feather: 8, padding: 0.35, use_subject: true, prompt: "" },
    { type: "sampler", on: true, rig: "", steps: 4, denoise: 0.15,
      sampler: "euler", scheduler: "simple", use_subject: true, prompt: "" },
  ],
  "Shrink and regrow": [
    { type: "sampler", on: true, rig: "", denoise: 0.35, scale: 0.5, prompt: "" },
    { type: "sampler", on: true, rig: "", denoise: 0.2, scale: 2.0, prompt: "" },
  ],
  "Upscale polish": [
    { type: "sampler", on: true, rig: "", denoise: 0.12, scale: 1.5, prompt: "" },
  ],
};

const css = document.createElement("style");
css.id = "rn-adv-style";
css.textContent = `
.rn-adv{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:13px 'Segoe UI',system-ui,sans-serif;color:#d6d9de;background:rgba(0,0,0,0.16);
  border:1px solid rgba(255,255,255,0.13);border-radius:6px;overflow:auto}
.rn-adv .cap{font-size:11px;font-weight:700;letter-spacing:.08em;color:#7f8792;
  text-align:center;border:1px dashed #33373d;border-radius:5px;padding:3px}
.rn-adv .card{display:flex;flex-direction:column;gap:5px;background:#1a1d22;
  border:1px solid #2a2e34;border-radius:6px;padding:6px}
.rn-adv .card.off{opacity:.45}
.rn-adv .line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rn-adv .chip{font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 7px;
  border-radius:4px;flex:none}
.rn-adv .chip.sampler{background:#233a5c;color:#9cc4ff}
.rn-adv .chip.detailer{background:#4a2d57;color:#e2b0ff}
.rn-adv select,.rn-adv input{background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:12px;padding:3px 6px}
.rn-adv input[type=number]{width:58px}
.rn-adv input[type=text]{flex:1;min-width:120px}
.rn-adv .k{font-size:10px;color:#7f8792;flex:none}
.rn-adv button{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#c8ccd2;cursor:pointer;font-size:12px;padding:3px 8px}
.rn-adv button:hover{border-color:#b8283c;color:#fff}
.rn-adv .eye{flex:none;width:26px}
.rn-adv .grow{flex:1}
.rn-adv .add{display:flex;gap:6px}
.rn-adv .add button{flex:1;font-weight:600}
.rn-adv .hint{font-size:11px;color:#7f8792}
.rn-adv .card.run{border-color:#b8283c;box-shadow:inset 0 0 0 1px #b8283c}
.rn-adv .tog{flex:none}
.rn-adv .tog.on{background:#b8283c;border-color:#b8283c;color:#fff;font-weight:600}
.rn-adv .card.run .chip{background:#b8283c;color:#fff}
.rn-adv .card.grp{margin-left:22px}
.rn-adv .rep{width:42px}
.rn-adv .rep.on{border-color:#b8283c;background:#1d1418;color:#fff}
.rn-adv .tcard{display:flex;align-items:center;gap:6px;background:#212429;
  border:1px solid #2a2e34;border-radius:6px;padding:5px 6px}
.rn-adv .tcard input.name{flex:1;font-weight:700;letter-spacing:.04em;
  background:transparent;border:none;min-width:60px}
.rn-adv .tcard.off input.name{text-decoration:line-through;color:#f87171}
.rn-adv .tcard.off{background:#17191d}
`;

const menuCss = document.createElement("style");
menuCss.id = "rn-adv-menu-style";
menuCss.textContent = `
.rn-adv-menu{position:fixed;z-index:10000;display:flex;flex-direction:column;
  gap:5px;background:#1a1d22;border:1px solid #3a3f47;border-radius:6px;
  padding:8px;min-width:170px;font:12px 'Segoe UI',system-ui,sans-serif;
  color:#d6d9de;box-shadow:0 6px 20px rgba(0,0,0,.5)}
.rn-adv-menu h5{margin:2px 0 0;font-size:10px;color:#7f8792;font-weight:700;
  letter-spacing:.05em}
.rn-adv-menu .swrow{display:flex;gap:4px}
.rn-adv-menu .swrow div{width:18px;height:18px;border-radius:4px;
  border:1px solid #3a3f47;cursor:pointer}
.rn-adv-menu button{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#c8ccd2;cursor:pointer;font-size:12px;padding:4px 8px;text-align:left}
.rn-adv-menu button:hover{border-color:#b8283c;color:#fff}
`;

// the live light: the node says which card is running, the panel lights it. One
// listener for every Detailer on the graph, matched by node id.
let wiredProgress = false;
function wireProgress() {
  if (wiredProgress) return;
  wiredProgress = true;
  api.addEventListener?.("rednode-detailer-step", (e) => {
    const d = e?.detail || {};
    const want = String(d.node ?? "");
    const walk = (graph) => {
      for (const n of graph?._nodes || []) {
        if (NODE_NAMES.includes(n?.type) && String(n.id) === want) {
          n._rnAdvActive = d.state === "run" ? d.stage : null;
          n._rnAdvRender?.();
        }
        if (n?.subgraph) walk(n.subgraph);
      }
    };
    walk(app.graph);
  });
}

// samplers, schedulers and the SAM checkpoints, off the live definitions so the
// lists can never drift from what the install can actually run
let LISTS = null;
async function fetchLists() {
  if (LISTS) return LISTS;
  const pull = async (nodeName, field) => {
    try {
      const r = await api.fetchApi(`/object_info/${encodeURIComponent(nodeName)}`);
      const d = await r.json();
      const v = d?.[nodeName]?.input?.required?.[field]?.[0];
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  };
  const samLoader = "easy sam3ModelLoader";
  let samModels = [];
  try {
    const r = await api.fetchApi(`/object_info/${encodeURIComponent(samLoader)}`);
    const d = await r.json();
    const req = d?.[samLoader]?.input?.required || {};
    for (const spec of Object.values(req)) {
      if (Array.isArray(spec?.[0]) && spec[0].some((x) => /sam/i.test(String(x)))) {
        samModels = spec[0];
        break;
      }
    }
  } catch (e) { /* Easy-Sam3 absent: the picker says so */ }
  LISTS = {
    samplers: await pull("KSampler", "sampler_name"),
    schedulers: await pull("KSampler", "scheduler"),
    samModels,
  };
  return LISTS;
}

function rigNames() {
  const names = [];
  const seen = new Set();
  const walk = (graph) => {
    for (const n of graph?._nodes || []) {
      if (n?.type === "RedNodeStudioWorkspace") {
        try {
          const cfgW = n.widgets?.find((w) => w.name === "config");
          const rigs = JSON.parse(cfgW?.value || "{}").models?.rigs || [];
          rigs.forEach((r, i) => {
            const nm = String(r?.name || "") || `Rig ${i + 1}`;
            if (!seen.has(nm)) { seen.add(nm); names.push(nm); }
          });
        } catch (e) { /* half-typed config */ }
      }
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return names;
}

// the user's own saved layouts, server-side like sampler profiles
let SAVED = null;
async function fetchPresets() {
  try {
    const r = await api.fetchApi("/rednode/detailer_presets");
    SAVED = (await r.json())?.presets || {};
  } catch (e) { SAVED = {}; }
  return SAVED;
}
async function postPreset(body) {
  try {
    const r = await api.fetchApi("/rednode/detailer_presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d?.presets) SAVED = d.presets;
    return d?.error || null;
  } catch (e) { return String(e); }
}

// fold flags are keyed by index; every insert or delete shifts the tail
function shiftFolds(node, from, delta) {
  const folds = node.properties?.rn_adv_folds;
  if (!folds) return;
  const next = {};
  Object.keys(folds).forEach((k) => {
    const n = parseInt(k, 10);
    if (!folds[k]) return;
    if (delta < 0 && n >= from && n < from - delta) return;   // deleted rows
    next[n >= from ? n + delta : n] = true;
  });
  node.properties.rn_adv_folds = next;
}

// the house right-click menu: DOM at the cursor, closed by any outside press,
// never LiteGraph.ContextMenu (it draws at canvas scale inside a panel)
function openCardMenu(node, d, i, ev, writeAndRender) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector(".rn-adv-menu")?.remove();
  if (!document.getElementById("rn-adv-menu-style")) {
    document.head.appendChild(menuCss);
  }
  const s = d.stages[i];
  const m = document.createElement("div");
  m.className = "rn-adv-menu";
  m.style.left = ev.clientX + "px";
  m.style.top = ev.clientY + "px";
  const h = document.createElement("h5");
  h.textContent = "Row colour";
  const sw = document.createElement("div");
  sw.className = "swrow";
  COLORS.forEach((c) => {
    const dot = document.createElement("div");
    dot.title = c.n;
    dot.style.background = c.v || "transparent";
    if (!c.v) dot.style.border = "2px dashed #555";
    if ((s.color || null) === c.v) dot.style.borderColor = "#fff";
    dot.onclick = () => { s.color = c.v || undefined; writeAndRender(); m.remove(); };
    sw.appendChild(dot);
  });
  m.append(h, sw);
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { m.remove(); fn(); };
    m.appendChild(b);
  };
  if (s.type === "title") {
    // the whole group travels: title plus members down to the next title
    let end = i + 1;
    while (end < d.stages.length && d.stages[end].type !== "title") end++;
    mk("Duplicate group", () => {
      const copy = d.stages.slice(i, end).map((x) => JSON.parse(JSON.stringify(x)));
      d.stages.splice(end, 0, ...copy);
      shiftFolds(node, end, copy.length);
      writeAndRender();
    });
    mk("Delete group and passes", () => {
      d.stages.splice(i, end - i);
      shiftFolds(node, i, -(end - i));
      writeAndRender();
    });
  } else {
    mk("Duplicate pass", () => {
      d.stages.splice(i + 1, 0, JSON.parse(JSON.stringify(s)));
      shiftFolds(node, i + 1, 1);
      writeAndRender();
    });
    mk("Add group title above", () => {
      d.stages.splice(i, 0, { type: "title", name: "GROUP", on: true });
      shiftFolds(node, i, 1);
      writeAndRender();
    });
    mk(s.on === false ? "Turn on" : "Turn off", () => {
      s.on = s.on === false;
      writeAndRender();
    });
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 8) + "px";
  if (r.right > innerWidth) m.style.left = Math.max(4, innerWidth - r.width - 8) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

function readCfg(node) {
  const w = node.widgets?.find((x) => x.name === "config");
  let d = {};
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!Array.isArray(d.stages)) d.stages = [];
  if (typeof d.seed !== "number") d.seed = 0;
  if (typeof d.seed_random !== "boolean") d.seed_random = true;
  return d;
}

function writeCfg(node, d) {
  const w = node.widgets?.find((x) => x.name === "config");
  if (w) w.value = JSON.stringify(d);
  node.graph?.setDirtyCanvas(true, false);
}

function buildPanel(node) {
  if (node._rnAdvPanel) return;
  const cw = node.widgets?.find((x) => x.name === "config");
  if (!cw) { requestAnimationFrame(() => buildPanel(node)); return; }
  cw.type = "hidden";
  cw.hidden = true;
  cw.computeSize = () => [0, -4];
  if (!document.getElementById("rn-adv-style")) document.head.appendChild(css);
  if (!LISTS) fetchLists().then(() => node._rnAdvRender?.());
  if (SAVED === null) fetchPresets().then(() => node._rnAdvRender?.());
  wireProgress();

  const wrap = document.createElement("div");
  wrap.className = "rn-adv";

  const sel = (values, current, title, onpick, emptyLabel) => {
    const el = document.createElement("select");
    for (const v of [...(emptyLabel !== undefined ? [""] : []), ...values]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v || emptyLabel;
      o.selected = v === (current || "");
      el.appendChild(o);
    }
    el.title = title;
    el.onchange = () => onpick(el.value);
    return el;
  };
  const num = (value, step, title, onpick, width) => {
    const el = document.createElement("input");
    el.type = "number";
    el.step = String(step);
    el.value = value;
    el.title = title;
    if (width) el.style.width = width;
    el.onchange = () => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) onpick(v);
    };
    return el;
  };
  const lab = (t) => {
    const el = document.createElement("span");
    el.className = "k";
    el.textContent = t;
    return el;
  };

  const render = () => {
    const d = readCfg(node);
    const L = LISTS || { samplers: [], schedulers: [], samModels: [] };
    wrap.replaceChildren();
    const cap = (t) => {
      const c = document.createElement("div");
      c.className = "cap";
      c.textContent = t;
      wrap.appendChild(c);
    };
    // THE PRESET ROW: premade layouts (starred) and the user's saved ones.
    // Picking replaces the whole list; Save stores the list under a name,
    // server-side like sampler profiles, so it survives browsers.
    {
      const prow = document.createElement("div");
      prow.className = "line";
      const psel = document.createElement("select");
      const names = [...Object.keys(PREMADES).map((n) => "★ " + n),
                     ...Object.keys(SAVED || {})];
      for (const v of ["", ...names]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v || "(preset: pick a layout)";
        o.selected = v === (node._rnAdvPreset || "");
        psel.appendChild(o);
      }
      psel.title = "Premade layouts (★) and your saved ones. Picking one "
                 + "REPLACES the passes below. Premades leave rigs unset; for "
                 + "the face identity chain, put the last two passes on your "
                 + "official Krea 2 Turbo rig - identity LoRAs fire there, "
                 + "merged models will not answer them.";
      psel.onchange = () => {
        const v = psel.value;
        node._rnAdvPreset = v;
        if (!v) return;
        const src = v.startsWith("★ ") ? PREMADES[v.slice(2)]
                                            : (SAVED || {})[v];
        if (!src) return;
        d.stages = src.map((x) => JSON.parse(JSON.stringify(x)));
        node.properties = node.properties || {};
        node.properties.rn_adv_folds = {};
        writeCfg(node, d);
        render();
      };
      const nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.placeholder = "save as…";
      nameInp.style.maxWidth = "130px";
      nameInp.value = node._rnAdvPresetName || "";
      nameInp.oninput = () => { node._rnAdvPresetName = nameInp.value; };
      const saveB = document.createElement("button");
      saveB.textContent = "Save";
      saveB.title = "Save the passes below under this name. Same name overwrites.";
      saveB.onclick = async () => {
        const nm = (nameInp.value || "").trim();
        if (!nm || !d.stages.length) return;
        const err = await postPreset({ name: nm, stages: d.stages });
        if (!err) { node._rnAdvPreset = nm; node._rnAdvPresetName = ""; }
        render();
      };
      prow.append(lab("Preset"), psel, nameInp, saveB);
      const cur = node._rnAdvPreset || "";
      if (cur && !cur.startsWith("★ ") && (SAVED || {})[cur]) {
        const delB = document.createElement("button");
        delB.textContent = "Delete";
        delB.title = "Delete the saved preset “" + cur + "”. The "
                   + "passes below stay as they are.";
        delB.onclick = async () => {
          await postPreset({ name: cur, delete: true });
          node._rnAdvPreset = "";
          render();
        };
        prow.append(delB);
      }
      wrap.appendChild(prow);
    }
    cap("START · the workspace's image arrives");
    const rigs = rigNames();
    // THE DROP TARGET: a dragged card lands on whichever card you let go over.
    // Fold flags ride along by being remapped with the same move, or a folded
    // card would unfold its neighbour every time it travelled past one.
    const wireDrop = (el, i) => {
      el.addEventListener("dragover", (e) => e.preventDefault());
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer?.getData("text/plain"), 10);
        if (!Number.isFinite(from) || from === i || !d.stages[from]) return;
        const folds = node.properties?.rn_adv_folds || {};
        const arr = d.stages.map((st, k) => ({ st, fold: !!folds[k] }));
        arr.splice(i, 0, arr.splice(from, 1)[0]);
        d.stages = arr.map((x) => x.st);
        node.properties = node.properties || {};
        node.properties.rn_adv_folds = {};
        arr.forEach((x, k) => { if (x.fold) node.properties.rn_adv_folds[k] = true; });
        writeCfg(node, d);
        render();
      });
    };
    const mkGrip = (i, dragEl) => {
      const grip = document.createElement("span");
      grip.textContent = "⋮⋮";
      grip.title = "Drag to reorder. Only the grip drags, so the controls stay "
                 + "controls.";
      grip.style.cssText = "cursor:grab;color:#7f8792;flex:none;padding:0 2px;"
                         + "user-select:none;letter-spacing:-2px";
      grip.draggable = true;
      grip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setDragImage?.(dragEl, 24, 12);
      });
      return grip;
    };
    let inGroup = false;
    let groupFolded = false;
    d.stages.forEach((s, i) => {
      const isFolded = !!node.properties?.rn_adv_folds?.[i];
      const writeAndRender = () => { writeCfg(node, d); render(); };
      if (s.type === "title") {
        // a group header, the Group Control look: caret boxed at the front,
        // its own eye flipping every member down to the next title, the name,
        // OFF as strikethrough. Members indent beneath it.
        inGroup = true;
        groupFolded = isFolded;
        const t = document.createElement("div");
        t.className = "tcard" + (s.on === false ? " off" : "");
        if (s.color) t.style.background = s.color;
        wireDrop(t, i);
        t.addEventListener("contextmenu", (e) =>
          openCardMenu(node, d, i, e, writeAndRender));
        const caret = document.createElement("button");
        caret.className = "eye";
        caret.textContent = isFolded ? "▸" : "▾";
        caret.title = "Fold this group's passes away.";
        caret.onclick = () => {
          node.properties = node.properties || {};
          (node.properties.rn_adv_folds ||= {})[i] = !isFolded;
          render();
        };
        const members = () => {
          const out = [];
          for (let k = i + 1; k < d.stages.length
               && d.stages[k].type !== "title"; k++) out.push(d.stages[k]);
          return out;
        };
        const eyeT = document.createElement("button");
        eyeT.className = "eye";
        eyeT.textContent = s.on === false ? "—" : "👁";
        eyeT.title = "Turn every pass in this group off or on in one click.";
        eyeT.onclick = () => {
          const anyOn = members().some((m) => m.on !== false);
          members().forEach((m) => { m.on = !anyOn; });
          s.on = !anyOn;
          writeAndRender();
        };
        const nameI = document.createElement("input");
        nameI.className = "name";
        nameI.value = s.name || "GROUP";
        nameI.title = "Name this group. Right-click for colour, duplicate and "
                    + "delete.";
        nameI.onchange = () => { s.name = nameI.value.trim(); writeCfg(node, d); };
        const delT = document.createElement("button");
        delT.textContent = "✕";
        delT.title = "Remove this title; its passes stay.";
        delT.onclick = () => {
          d.stages.splice(i, 1);
          shiftFolds(node, i, -1);
          writeAndRender();
        };
        t.append(caret, mkGrip(i, t), eyeT, nameI, delT);
        wrap.appendChild(t);
        return;
      }
      if (inGroup && groupFolded) return;
      const card = document.createElement("div");
      card.className = "card" + (s.on === false ? " off" : "")
                     + (node._rnAdvActive === i ? " run" : "")
                     + (inGroup ? " grp" : "");
      if (s.color) card.style.background = s.color;
      wireDrop(card, i);
      card.addEventListener("contextmenu", (e) =>
        openCardMenu(node, d, i, e, writeAndRender));

      const top = document.createElement("div");
      top.className = "line";
      const caret = document.createElement("button");
      caret.className = "eye";
      caret.textContent = isFolded ? "\u25b8" : "\u25be";
      caret.title = "Fold this pass down to one line.";
      caret.onclick = () => {
        node.properties = node.properties || {};
        (node.properties.rn_adv_folds ||= {})[i] = !isFolded;
        render();
      };
      const grip = mkGrip(i, card);
      const eye = document.createElement("button");
      eye.className = "eye";
      eye.textContent = s.on === false ? "\u2014" : "\ud83d\udc41";
      eye.title = "Skip this pass without losing its settings.";
      eye.onclick = () => { s.on = s.on === false; writeCfg(node, d); render(); };
      const chip = document.createElement("span");
      chip.className = "chip " + s.type;
      chip.textContent = s.type === "sampler" ? "SAMPLER" : "DETAILER";
      top.append(caret, grip, eye, chip);
      if (isFolded) {
        // folded, the header still says what would run
        const sum = document.createElement("span");
        sum.className = "k";
        sum.style.fontSize = "12px";
        sum.textContent = (s.rig || "(active rig)")
          + (s.type === "detailer" ? " \u00b7 " + (s.target || "face") : "")
          + " \u00b7 denoise " + (s.denoise ?? (s.type === "detailer" ? 0.15 : 0.3))
          + ((s.scale ?? 1) !== 1 ? " \u00b7 scale " + s.scale : "")
          + (s.loras === false ? " \u00b7 raw" : "")
          + ((s.use_subject || s.use_scene || s.use_moodboard) ? " \u00b7 refs" : "")
          + ((s.repeat || 1) > 1 ? " \u00b7 \u00d7" + s.repeat : "")
          + (s.crop_res ? " \u00b7 " + s.crop_res + "px" : "");
        top.appendChild(sum);
      } else {
        top.append(lab("Rig"),
                   sel(rigs, s.rig, "Which Models-tab rig runs this pass.",
                       (v) => { s.rig = v; writeCfg(node, d); }, "(active rig)"));
        if (s.type === "detailer") {
          top.append(lab("Target"),
                     sel(TARGETS.includes(s.target) ? TARGETS
                                                    : [s.target, ...TARGETS],
                         s.target, "What SAM3 segments and this pass redraws.",
                         (v) => { s.target = v; writeCfg(node, d); }));
          top.append(lab("SAM"),
                     sel(L.samModels, s.sam_model,
                         L.samModels.length
                           ? "Which SAM checkpoint segments. Loader default when "
                             + "unset."
                           : "ComfyUI-Easy-Sam3 is not installed, so there is "
                             + "nothing to pick; this pass will say so and pass "
                             + "the image through.",
                         (v) => { s.sam_model = v; writeCfg(node, d); },
                         "(loader default)"));
          top.append(lab("Res"),
                     sel(["512", "768", "1024", "1280", "1536", "2048"],
                         s.crop_res ? String(s.crop_res) : "",
                         "The working resolution for the crop: its long edge "
                         + "is resized to this before rendering, and the result "
                         + "goes back at the crop's own size. (crop) renders at "
                         + "whatever size the box happens to be, times Scale. "
                         + "1024 is the classic detailer sweet spot; higher "
                         + "costs more VRAM for finer faces.",
                         (v) => {
                           s.crop_res = v ? parseInt(v, 10) : 0;
                           writeCfg(node, d);
                         }, "(crop)"));
        }
      }
      const spacer = document.createElement("span");
      spacer.className = "grow";
      if (!isFolded) {
        // iteration on one pass, the Paint tab's Passes: N rounds over its own
        // result inside one queue, so "run it twice" stops meaning two cards
        const rep = document.createElement("input");
        rep.type = "number";
        rep.min = 1; rep.max = 10; rep.step = 1;
        rep.className = "rep" + ((s.repeat || 1) > 1 ? " on" : "");
        rep.value = String(s.repeat || 1);
        rep.title = "Run this pass over its own result this many times, a fresh "
                  + "seed each round; only the last picture moves on. A sampler "
                  + "pass's scale applies on the first round only, so the size "
                  + "does not compound. 1 is a single run, as always.";
        rep.onchange = () => {
          s.repeat = Math.max(1, Math.min(10, Math.round(Number(rep.value) || 1)));
          writeCfg(node, d);
          render();
        };
        rep.addEventListener("wheel", () => rep.blur(), { passive: true });
        top.append(lab("Repeat"), rep);
      }
      const del = document.createElement("button");
      del.textContent = "\u2715";
      del.title = "Remove this pass.";
      del.onclick = () => {
        d.stages.splice(i, 1);
        const folds = node.properties?.rn_adv_folds;
        if (folds) {
          const next = {};
          Object.keys(folds).forEach((k) => {
            const n2 = parseInt(k, 10);
            if (folds[k] && n2 !== i) next[n2 > i ? n2 - 1 : n2] = true;
          });
          node.properties.rn_adv_folds = next;
        }
        writeCfg(node, d);
        render();
      };
      top.append(spacer, del);
      card.appendChild(top);

      if (!isFolded) {
        const mid = document.createElement("div");
        mid.className = "line";
        mid.append(
          lab("Steps"),
          num(s.steps || "", 1, "Steps for this pass. 0 or empty inherits the "
              + "rig's: detailer passes take its Detailer steps, sampler passes "
              + "its Steps.", (v) => { s.steps = Math.max(0, Math.round(v)); writeCfg(node, d); }),
          lab("Start"),
          num(s.start_step || 0, 1, "Start at this step instead of 0, the detailer "
              + "trick that keeps composition and only reworks detail.",
              (v) => { s.start_step = Math.max(0, Math.round(v)); writeCfg(node, d); }),
          lab("End"),
          num(s.end_step || 0, 1, "Stop at this step. 0 runs to the end.",
              (v) => { s.end_step = Math.max(0, Math.round(v)); writeCfg(node, d); }),
          lab("CFG"),
          num(s.cfg || "", 0.1, "CFG for this pass. 0 or empty inherits the rig's.",
              (v) => { s.cfg = Math.max(0, v); writeCfg(node, d); }),
          lab("Sampler"),
          sel(L.samplers, s.sampler, "Sampler for this pass; (rig) inherits.",
              (v) => { s.sampler = v; writeCfg(node, d); }, "(rig)"),
          lab("Sched"),
          sel(L.schedulers, s.scheduler, "Scheduler for this pass; (rig) inherits.",
              (v) => { s.scheduler = v; writeCfg(node, d); }, "(rig)"),
          lab("Scale"),
          num(s.scale ?? 1.0, 0.05, "Resize ratio for this pass. 1 is the picture "
              + "as it arrives. On a sampler pass the new size STICKS, so 0.5 then "
              + "2.0 across two passes is the shrink-and-regrow chain that invents "
              + "detail. On a detailer it renders the crop bigger and puts it back "
              + "at its own size.",
              (v) => { s.scale = Math.max(0.25, Math.min(4, v)); writeCfg(node, d); }),
          lab("Denoise"),
          (() => {
            // a drag bar, the user's call: denoise is the dial you ride while
            // tuning a pass, and a slider reads at a glance where a box does not
            const box = document.createElement("span");
            box.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
                              + "flex:1;min-width:110px";
            const r = document.createElement("input");
            r.type = "range";
            r.min = "0";
            r.max = "1";
            r.step = "0.01";
            r.style.cssText = "flex:1;min-width:70px";
            const dv = s.denoise ?? (s.type === "detailer" ? 0.15 : 0.3);
            r.value = String(dv);
            r.title = "Denoise for this pass.";
            const val = document.createElement("span");
            val.className = "k";
            val.style.width = "30px";
            val.textContent = Number(dv).toFixed(2);
            r.addEventListener("input", () => {
              val.textContent = Number(r.value).toFixed(2);
            });
            r.addEventListener("change", () => {
              s.denoise = Math.max(0, Math.min(1, parseFloat(r.value) || 0));
              writeCfg(node, d);
            });
            box.append(r, val);
            return box;
          })());
        card.appendChild(mid);

        const bottom = document.createElement("div");
        bottom.className = "line";
        const tog = (label, key, dv, tip) => {
          const cur = s[key] === undefined ? dv : !!s[key];
          const b = document.createElement("button");
          b.className = "tog" + (cur ? " on" : "");
          b.textContent = label;
          b.title = tip;
          b.onclick = () => { s[key] = !cur; writeCfg(node, d); render(); };
          return b;
        };
        bottom.append(
          tog("LoRAs", "loras", true,
              "Apply the main LoRAs tab's stack to this pass's model and clip. "
              + "Off runs the rig raw."),
          tog("Subject", "use_subject", false,
              "Krea 2 rigs only: this pass encodes with the Subject tab's image "
              + "as the identity reference."),
          tog("Scene", "use_scene", false,
              "Krea 2 rigs only: the Scene tab's image rides this pass's "
              + "conditioning."),
          tog("Mood", "use_moodboard", false,
              "Krea 2 rigs only: the Moodboard batch styles this pass."));
        const pr = document.createElement("input");
        pr.type = "text";
        pr.placeholder = "Prompt: empty uses this rig's Prompts-tab row";
        pr.title = "Empty means the rig's own prompt from the workspace, the same "
                 + "text the main render used, wildcards rolled on this run's seed. "
                 + "Typed text wins.";
        pr.value = s.prompt || "";
        pr.onchange = () => { s.prompt = pr.value; writeCfg(node, d); };
        bottom.appendChild(pr);
        card.appendChild(bottom);
      }
      wrap.appendChild(card);
    });
    cap("END · onward to the post process");
    const add = document.createElement("div");
    add.className = "add";
    const mk = (label, stage) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => { d.stages.push(stage()); writeCfg(node, d); render(); };
      add.appendChild(b);
    };
    mk("＋ Sampler pass", () => ({ on: true, type: "sampler", rig: "",
                                  denoise: 0.3, steps: 0, prompt: "" }));
    mk("＋ Face detailer", () => ({ on: true, type: "detailer", rig: "",
                                   target: "face", denoise: 0.15, steps: 0,
                                   threshold: 0.5, feather: 8, padding: 0.35,
                                   sam_model: "", prompt: "" }));
    mk("＋ Group title", () => ({ type: "title", name: "GROUP", on: true }));
    wrap.appendChild(add);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = d.stages.length
      ? "Top to bottom is the run order. Steps, CFG, sampler and scheduler left "
        + "empty inherit the rig's own settings from the Models tab."
      : "No passes yet: the image goes straight through. Add a sampler refine or a "
        + "face detailer, as many as you want, in any order.";
    wrap.appendChild(hint);
  };
  render();

  const widget = node.addDOMWidget("advanced_ui", "advanced_ui", wrap, {
    getValue: () => "",
    setValue: () => {},
    getMinHeight: () => 300,
    serialize: false,
  });
  widget.serialize = false;
  widget.element = wrap;
  node._rnAdvPanel = widget;
  node._rnAdvRender = render;
  const sz = node.computeSize();
  if (node.size[0] < 640) node.size[0] = 640;
  if (node.size[1] < sz[1]) node.size[1] = sz[1];
}

app.registerExtension({
  name: "RedNode.StudioDetailer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(nodeData?.name)) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      requestAnimationFrame(() => buildPanel(this));
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => { buildPanel(this); this._rnAdvRender?.(); });
    };
  },
});
