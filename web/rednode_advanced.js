import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { makePicker } from "./rednode_picker.js";

// RedNode Studio Detailer — the post-render passes as a list you can read.
//
// Start, the passes in order, End. Each pass is a card: the top line says what it
// is, whose rig runs it and what it aims at; under it three boxes, Sampling (steps,
// CFG, sampler, scheduler, the step window), Strength (scale and denoise as bars,
// the repeat and its per-round lists) and Prompt (the stack, references, a LoRA of
// its own, the words). Anything left at "rig" inherits the rig's own settings, so
// the Models tab stays the one place a model's numbers live. An empty prompt uses
// the rig's own Prompts-tab row, the same text the main render used.
//
// Widget lifecycle follows the house pattern: the native config widget is HIDDEN,
// never removed, and stays the value holder; the panel reads and writes it.

const NODE_NAMES = ["RedNodeStudioDetailer", "RedNodeStudioAdvanced"];
const TARGETS = ["face", "hair", "hands", "eyes", "clothes", "background"];
// the upscale sizes, in the order they grow; refine_pipeline.py holds the pixel
// budget behind each name and works the short edge out from the frame's aspect
const SIZES = ["720p", "1080p", "2K", "1440p", "4K"];

// the Control Panel's row palette, verbatim: one set of colours across the pack
const COLORS = [
  { n: "none", v: null }, { n: "red", v: "#7f2230" }, { n: "orange", v: "#7a4416" },
  { n: "green", v: "#1e5233" }, { n: "teal", v: "#14514f" }, { n: "blue", v: "#1d3f6e" },
  { n: "purple", v: "#492a6b" }, { n: "pink", v: "#6b2450" }, { n: "grey", v: "#3a3f47" },
];

// shipped layouts. The face identity chain is your own proven recipe
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
  // BFS head / body swap on Krea 2 (Alissonerdx's bfs_*_krea2 files, 2026-08-18):
  // one whole-frame pass, the picture as the base reference and the Subject as
  // the head, the swap file as the pass's own LoRA (pick it on the card - names
  // are per machine), the author's trigger as the prompt, denoise 1 like his
  // workflow, the rig RAW (his graph is base + BFS, nothing else - the main
  // stack's identity LoRA fights it), working at 1280 on the long edge (his
  // frame is 848 x 1280). Best on the official Turbo rig, where edit LoRAs fire.
  "Head swap (BFS Krea 2)": [
    { type: "sampler", on: true, rig: "", steps: 8, denoise: 1.0, loras: false,
      crop_res: 1280, sampler: "euler", scheduler: "simple",
      use_subject: true, use_picture: true, lora: "", lora_strength: 1.0,
      prompt: "head_swap: replace the head with the reference head." },
  ],
  "Body swap (BFS Krea 2)": [
    { type: "sampler", on: true, rig: "", steps: 8, denoise: 1.0, loras: false,
      crop_res: 1280, sampler: "euler", scheduler: "simple",
      use_subject: true, use_picture: true, lora: "", lora_strength: 1.0,
      prompt: "body_swap: replace the person with the reference person." },
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
.rn-adv .chip.upscale{background:#1f4d3a;color:#9be7c0}
.rn-adv .chip.usdu{background:#4d3a1f;color:#f0c98a}
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
/* The three groups of a pass card. A darker ground and a small caption at the
   front, so the eye lands on "Sampling" before it lands on six number boxes. */
.rn-adv .grp{display:flex;flex-direction:column;gap:4px;background:#15171b;
  border:1px solid #262a30;border-radius:5px;padding:4px 6px}
.rn-adv .gt{font-size:10px;font-weight:700;letter-spacing:.08em;color:#9aa3ae;
  min-width:58px;flex:none;text-transform:uppercase}
.rn-adv .bar{display:inline-flex;align-items:center;gap:4px;flex:1;min-width:120px}
.rn-adv .bar input[type=range]{flex:1;min-width:70px;height:18px;margin:0;padding:0}
.rn-adv .bar .v{width:42px;text-align:right;font-variant-numeric:tabular-nums;
  color:#c8ccd2;font-size:11px}
.rn-adv .rounds{gap:8px}
.rn-adv .round{display:inline-flex;align-items:center;gap:4px;flex:1;min-width:150px}
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
    // the Workspace's own Detailer tab: its passes run under the Workspace's id
    for (const h of advHosts) {
      if (String(h.id) !== want) continue;
      h._rnAdvActive = d.state === "run" ? d.stage : null;
      h._rnAdvRender?.();
    }
  });
}

// samplers, schedulers and the SAM checkpoints, off the live definitions so the
// lists can never drift from what the install can actually run
//
// A combo's choices come in two shapes. A V1 node lists them in place; a comfy_api
// V3 node (Easy-Sam3 is one) says "COMBO" and keeps the list under options. Reading
// only the first shape is why the SAM picker showed nothing but its placeholder.
const optionsOf = (spec) => {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
  return [];
};
let LISTS = null;
async function fetchLists() {
  if (LISTS) return LISTS;
  const inputs = async (nodeName) => {
    try {
      const r = await api.fetchApi(`/object_info/${encodeURIComponent(nodeName)}`);
      const d = await r.json();
      const it = d?.[nodeName]?.input || {};
      return { ...(it.optional || {}), ...(it.required || {}) };
    } catch (e) { return {}; }
  };
  const pull = async (nodeName, field) => optionsOf((await inputs(nodeName))[field]);
  const sam = await inputs("easy sam3ModelLoader");   // absent: the picker says so
  let samModels = optionsOf(sam.model);
  if (!samModels.length) {
    for (const spec of Object.values(sam)) {
      const opts = optionsOf(spec);
      if (opts.some((x) => /sam/i.test(String(x)))) { samModels = opts; break; }
    }
  }
  // the SeedVR2 pack's three nodes, for the upscale card; absent, the card says so
  const dit = await inputs("SeedVR2LoadDiTModel");
  const svae = await inputs("SeedVR2LoadVAEModel");
  const up = await inputs("SeedVR2VideoUpscaler");
  // Ultimate SD Upscale for the tiled pass, and core's upscale model list
  const usdu = await inputs("UltimateSDUpscale");
  LISTS = {
    usdu: !!Object.keys(usdu).length,
    usduModes: optionsOf(usdu.mode_type),
    seamModes: optionsOf(usdu.seam_fix_mode),
    upscaleModels: await pull("UpscaleModelLoader", "model_name"),
    samplers: await pull("KSampler", "sampler_name"),
    schedulers: await pull("KSampler", "scheduler"),
    loras: await pull("LoraLoaderModelOnly", "lora_name"),
    samModels,
    samPrecisions: optionsOf(sam.precision),
    seedvr: !!Object.keys(dit).length,
    ditModels: optionsOf(dit.model),
    vaeModels: optionsOf(svae.model),
    attention: optionsOf(dit.attention_mode),
    offloads: optionsOf(dit.offload_device),
    colorFixes: optionsOf(up.color_correction),
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

// the LoRA sets of the workspace in the graph: Main plus its named sets, the
// tabs of its LoRAs tab
function loraSetNames() {
  const names = ["Main"];
  const walk = (graph) => {
    for (const n of graph?._nodes || []) {
      if (n?.type === "RedNodeStudioWorkspace") {
        try {
          const cfgW = n.widgets?.find((w) => w.name === "config");
          for (const st of JSON.parse(cfgW?.value || "{}").lora_sets || []) {
            const nm = String(st?.name || "").trim();
            if (nm && !names.includes(nm)) names.push(nm);
          }
        } catch (e) { /* half-typed config */ }
      }
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return names;
}

// the Prompts-tab rows of the workspace in the graph, as a pass can name them:
// by name, or "#N" for the Nth row when it has none, the key the server resolves
function promptRows() {
  const out = [];
  const walk = (graph) => {
    for (const n of graph?._nodes || []) {
      if (n?.type === "RedNodeStudioWorkspace") {
        try {
          const cfgW = n.widgets?.find((w) => w.name === "config");
          const rows = JSON.parse(cfgW?.value || "{}").prompts?.rows || [];
          rows.forEach((r, j) => {
            const rigs = Array.isArray(r?.rigs) ? r.rigs : (r?.rig ? [r.rig] : []);
            const name = String(r?.name || "").trim();
            out.push({ key: name || `#${j + 1}`,
                       label: (name || `Prompt ${j + 1}`)
                            + (rigs.length ? `  [${rigs.join(", ")}]` : "") });
          });
        } catch (e) { /* half-typed config */ }
      }
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return out;
}

// your own saved layouts, server-side like sampler profiles
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
  if (typeof d.taps !== "boolean") d.taps = false;
  if (![320, 512, 768, 1024, 1536, 0].includes(d.tap_px)) d.tap_px = 768;
  if (typeof d.sam_model !== "string") d.sam_model = "";
  if (typeof d.sam_precision !== "string") d.sam_precision = "";
  return d;
}

function writeCfg(node, d) {
  const w = node.widgets?.find((x) => x.name === "config");
  if (w) w.value = JSON.stringify(d);
  node.graph?.setDirtyCanvas(true, false);
}

// THE SAME PANEL, HOSTED: the Workspace's Detailer tab. A host carries a config
// widget of its own (backed by the Workspace's settings) and gets no DOM widget.
const advHosts = new Set();
export function mountDetailerPanel(host, el) {
  advHosts.add(host);
  buildPanel(host, el);
}

function buildPanel(node, hostEl = null) {
  if (node._rnAdvPanel && !hostEl) return;
  const cw = node.widgets?.find((x) => x.name === "config");
  if (!cw) { requestAnimationFrame(() => buildPanel(node)); return; }
  cw.type = "hidden";
  cw.hidden = true;
  cw.computeSize = () => [0, -4];
  if (!document.getElementById("rn-adv-style")) document.head.appendChild(css);
  if (!LISTS) fetchLists().then(() => node._rnAdvRender?.());
  if (SAVED === null) fetchPresets().then(() => node._rnAdvRender?.());
  wireProgress();

  const wrap = hostEl || document.createElement("div");
  wrap.classList.add("rn-adv");

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
    const L = LISTS || { samplers: [], schedulers: [], loras: [], samModels: [],
                         samPrecisions: [], ditModels: [], vaeModels: [],
                         attention: [], offloads: [], colorFixes: [],
                         usdu: false, usduModes: [], seamModes: [], upscaleModels: [] };
    wrap.replaceChildren();
    const cap = (t) => {
      const c = document.createElement("div");
      c.className = "cap";
      c.textContent = t;
      wrap.appendChild(c);
    };
    // THE PRESET ROW: premade layouts (starred) and your saved ones.
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
    // THE DETAILER'S OWN SAM: which checkpoint segments, and at what precision,
    // for every detailer pass left at (node's). Here rather than on the Models
    // tab because SAM is a detailer concern, not a rig's: the rig paints, SAM
    // only says where.
    {
      const srow = document.createElement("div");
      srow.className = "line";
      srow.append(
        lab("SAM file"),
        sel(L.samModels, d.sam_model,
            L.samModels.length
              ? "Which SAM3 checkpoint segments the targets, for every detailer "
                + "pass left at (node's). The files in models/sam3. (first file) "
                + "takes whichever the loader lists first."
              : "ComfyUI-Easy-Sam3 is not installed, or models/sam3 holds no "
                + "checkpoint, so there is nothing to pick yet.",
            (v) => { d.sam_model = v; writeCfg(node, d); }, "(first file)"),
        lab("Precision"),
        sel(L.samPrecisions, d.sam_precision,
            "The precision SAM3 loads at. fp16 or bf16 halves its memory on the "
            + "card; (loader default) is the pack's own choice, fp32 today.",
            (v) => { d.sam_precision = v; writeCfg(node, d); }, "(loader default)"));
      // TAPS: record the input, every pass and the output into the RedNode
      // Stage View strip - a chain read step by step, no tap nodes wired.
      // Off by default (the house rule); the strip is the Stage View node.
      const tapB = document.createElement("button");
      tapB.className = "tog" + (d.taps ? " on" : "");
      tapB.style.marginLeft = "auto";
      tapB.textContent = "◉ Taps";
      tapB.title = "Record this run into RedNode Stage View: the input as it "
                 + "arrives, a frame after every pass (every repeat round too) "
                 + "and the output. Drop a Stage View node anywhere to watch "
                 + "the strip; nothing to wire.";
      tapB.onclick = () => { d.taps = !d.taps; writeCfg(node, d); render(); };
      srow.append(tapB);
      if (d.taps) {
        // the size the strip keeps each frame at, the Stage Tap's own choice
        const tapSz = document.createElement("select");
        tapSz.className = "rn-adv-tappx";
        for (const [v, l] of [[320, "320 px"], [512, "512 px"], [768, "768 px"],
                              [1024, "1024 px"], [1536, "1536 px"], [0, "full size"]]) {
          const o = document.createElement("option");
          o.value = String(v);
          o.textContent = l;
          o.selected = (d.tap_px ?? 768) === v;
          tapSz.appendChild(o);
        }
        tapSz.title = "How big the Stage View keeps each frame. Bigger is sharper on "
                    + "the node and in its full screen; full size is the frame as it is.";
        tapSz.onchange = () => { d.tap_px = parseInt(tapSz.value, 10); writeCfg(node, d); };
        srow.append(tapSz);
      }
      wrap.appendChild(srow);
    }
    cap("START · the workspace's image arrives");
    const rigs = rigNames();
    const fmt2 = (v) => Number(v).toFixed(2);
    const fmtX = (v) => Number(v).toFixed(2) + "\u00d7";
    const snap = (v, min, max, step) => {
      const n = Math.max(min, Math.min(max, Math.round(v / step) * step));
      return Number(n.toFixed(4));
    };
    // a titled box inside the card: the caption leads its first line
    const group = (title) => {
      const box = document.createElement("div");
      box.className = "grp";
      const line = document.createElement("div");
      line.className = "line";
      const t = document.createElement("span");
      t.className = "gt";
      t.textContent = title;
      line.appendChild(t);
      box.appendChild(line);
      return { box, line };
    };
    // a drag bar with its number beside it: the dials you ride while tuning
    // read at a glance where a box does not
    const bar = (value, min, max, step, fmt, title, accent, onpick) => {
      const box = document.createElement("span");
      box.className = "bar";
      const r = document.createElement("input");
      r.type = "range";
      r.min = String(min); r.max = String(max); r.step = String(step);
      r.value = String(value);
      r.title = title;
      r.style.accentColor = accent;
      const val = document.createElement("span");
      val.className = "k v";
      val.textContent = fmt(value);
      r.addEventListener("input", () => { val.textContent = fmt(parseFloat(r.value)); });
      r.addEventListener("change", () => {
        const v = parseFloat(r.value);
        if (Number.isFinite(v)) onpick(snap(v, min, max, step));
      });
      box.append(r, val);
      return box;
    };
    // One value per repeat round, the Img2Img PASS rule. With nothing stored
    // the list opens on the dial; a stored list repeats its last value when the
    // count is raised, so a number already chosen never moves. Same two rules as
    // _pass_list in workspace.py, which is what the server reads.
    const roundList = (s, key, dv, min, max) => {
      const n = Math.max(1, Math.min(10, Math.round(Number(s.repeat) || 1)));
      const raw = Array.isArray(s[key]) ? s[key] : [];
      const fit = (v) => Math.max(min, Math.min(max, v));
      const out = [];
      for (let i = 0; i < n; i++) {
        if (!raw.length) { out.push(fit(dv)); continue; }
        const v = Number(i < raw.length ? raw[i] : raw[raw.length - 1]);
        out.push(Number.isFinite(v) ? fit(v) : fit(dv));
      }
      return out;
    };
    // the switch for the Repeat line, and the bar rows it opens: one per round,
    // with a Ramp that spaces them evenly between the first and the last
    const perRound = (s, o, writeAndRender) => {
      const on = !!s[o.flag];
      const sw = document.createElement("button");
      sw.className = "tog" + (on ? " on" : "");
      sw.textContent = o.label;
      sw.title = on ? o.onTitle : o.offTitle;
      sw.onclick = () => {
        s[o.flag] = !on;
        if (!on) s[o.key] = roundList(s, o.key, o.dv, o.min, o.max);
        writeAndRender();
      };
      const rows = [];
      if (on) {
        const list = roundList(s, o.key, o.dv, o.min, o.max);
        s[o.key] = list.slice();           // the stored list is always count-long
        const line = document.createElement("div");
        line.className = "line rounds";
        list.forEach((v, i) => {
          const cell = document.createElement("span");
          cell.className = "round";
          cell.append(lab(`${o.short} ${i + 1}`),
                      bar(v, o.min, o.max, o.step, o.fmt, o.barTitle, o.accent,
                          (nv) => { s[o.key][i] = nv; writeCfg(node, d); }));
          line.appendChild(cell);
        });
        const ramp = document.createElement("button");
        ramp.textContent = "Ramp";
        ramp.title = o.rampTitle;
        ramp.onclick = () => {
          // read the stored list, not the one this row was built from: the bars
          // above have been writing into it since
          const cur = roundList(s, o.key, o.dv, o.min, o.max);
          const a = cur[0], z = cur[cur.length - 1];
          s[o.key] = cur.map((_, i) =>
            snap(a + (z - a) * (i / Math.max(1, cur.length - 1)), o.min, o.max, o.step));
          writeAndRender();
        };
        line.appendChild(ramp);
        rows.push(line);
      }
      return { sw, rows };
    };
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
      const tog = (label, key, dv2, tip) => {
        const cur = s[key] === undefined ? dv2 : !!s[key];
        const b = document.createElement("button");
        b.className = "tog" + (cur ? " on" : "");
        b.textContent = label;
        b.title = tip;
        b.onclick = () => { s[key] = !cur; writeCfg(node, d); render(); };
        return b;
      };
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
        const dupT = document.createElement("button");
        dupT.textContent = "\u29c9";
        dupT.title = "Duplicate this group, title and passes, right after it.";
        dupT.onclick = () => {
          let end = i + 1;
          while (end < d.stages.length && d.stages[end].type !== "title") end++;
          const copy = d.stages.slice(i, end).map((x) => JSON.parse(JSON.stringify(x)));
          d.stages.splice(end, 0, ...copy);
          shiftFolds(node, end, copy.length);
          writeAndRender();
        };
        const delT = document.createElement("button");
        delT.textContent = "✕";
        delT.title = "Remove this title; its passes stay.";
        delT.onclick = () => {
          d.stages.splice(i, 1);
          shiftFolds(node, i, -1);
          writeAndRender();
        };
        t.append(caret, mkGrip(i, t), eyeT, nameI, dupT, delT);
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
      chip.textContent = s.type === "sampler" ? "SAMPLER"
                       : s.type === "upscale" ? "UPSCALE"
                       : s.type === "usdu" ? "USDU" : "DETAILER";
      top.append(caret, grip, eye, chip);
      if (isFolded) {
        // folded, the header still says what would run
        const sum = document.createElement("span");
        sum.className = "k";
        sum.style.fontSize = "12px";
        sum.textContent = s.type === "upscale"
          ? "SeedVR2 \u00b7 " + (s.size || "1080p")
            + (s.region ? " \u00b7 " + s.region : "")
            + (s.dit_model ? " \u00b7 " + s.dit_model.replace(/\.safetensors$/i, "") : "")
          : (s.rig || "(active rig)")
          + (s.type === "detailer" ? " \u00b7 " + (s.target || "face") : "")
          + (s.type === "usdu" ? " \u00b7 x" + (s.upscale_by ?? 2) + " \u00b7 "
             + (s.usdu_model ? s.usdu_model.replace(/\.(safetensors|pth)$/i, "") : "resize") : "")
          + " \u00b7 denoise " + (s.denoise ?? (s.type === "detailer" ? 0.15 : 0.3))
          + ((s.scale ?? 1) !== 1 ? " \u00b7 scale " + s.scale : "")
          + (s.loras === false ? " \u00b7 raw" : (s.lora_set ? " \u00b7 " + s.lora_set : ""))
          + ((s.use_subject || s.use_scene || s.use_moodboard || s.use_picture) ? " \u00b7 refs" : "")
          + (s.lora && s.lora !== "None" ? " \u00b7 " + s.lora.replace(/\.safetensors$/i, "") : "")
          + ((s.repeat || 1) > 1 ? " \u00b7 \u00d7" + s.repeat
             + ((s.pass_custom || s.scale_custom) ? " per round" : "") : "")
          + (s.crop_res ? " \u00b7 " + s.crop_res + "px" : "");
        sum.textContent += (s.free_vram ? " \u00b7 free VRAM" : "")
                         + (s.tone_lock ? " \u00b7 tone lock" : "");
        top.appendChild(sum);
      } else if (s.type === "upscale") {
        // no rig: the SeedVR2 loaders do the loading. The size is the whole
        // header, the workflow's combo of pixel budgets plus a 2K step.
        top.append(lab("Size"),
                   sel(SIZES, SIZES.includes(s.size) ? s.size : "1080p",
                       "The size SeedVR2 works to, as a pixel budget: 1080p is "
                       + "1920 x 1080's pixels whatever the frame's shape, and the "
                       + "short edge is worked out from its aspect. 720p 1280x720, "
                       + "1080p 1920x1080, 2K 2048x1080, 1440p 2560x1440, 4K "
                       + "3840x2160. A frame already past the size is brought DOWN "
                       + "to it, the same as the workflow.",
                       (v) => { s.size = v; writeCfg(node, d); }));
        // a REGION: SAM3's target, the crop through the upscaler and back at
        // its own size, so the face gains the detail and the frame keeps its size
        top.append(lab("Region"),
                   sel(TARGETS, s.region || "",
                       "Upscale only this target: SAM3 finds it, the crop goes "
                       + "through SeedVR2 at the size and comes back at its own "
                       + "size under a feathered matte. The frame keeps its size; "
                       + "the region gains the detail. (whole frame) upscales "
                       + "everything and grows the frame.",
                       (v) => { s.region = v; writeCfg(node, d); }, "(whole frame)"));
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
                           ? "A SAM checkpoint for this pass only. (node's) "
                             + "follows the SAM file chosen at the top."
                           : "ComfyUI-Easy-Sam3 is not installed, so there is "
                             + "nothing to pick; this pass will say so and pass "
                             + "the image through.",
                         (v) => { s.sam_model = v; writeCfg(node, d); },
                         "(node's)"));
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
        } else if (s.type === "sampler") {
          top.append(lab("Res"),
                     sel(["768", "1024", "1280", "1536", "2048"],
                         s.crop_res ? String(s.crop_res) : "",
                         "A working size for the whole frame: its long edge is "
                         + "resized to this before rendering, and the result comes "
                         + "back at the frame's own size (Scale still sticks). "
                         + "(frame) renders at the size it arrives. A big frame at a "
                         + "high denoise wants this: Krea 2 past ~1.5 MP goes fuzzy.",
                         (v) => {
                           s.crop_res = v ? parseInt(v, 10) : 0;
                           writeCfg(node, d);
                         }, "(frame)"));
        }
      }
      const spacer = document.createElement("span");
      spacer.className = "grow";
      // DUPLICATE, in the open: the fastest way to build a chain is to copy the
      // pass just tuned and nudge one number. The right-click menu has it too,
      // but a button is found and a menu has to be remembered.
      const dup = document.createElement("button");
      dup.textContent = "\u29c9";
      dup.title = "Duplicate this pass, placed right after it with every setting "
                + "copied. A chain of near-identical passes is one click each.";
      dup.onclick = () => {
        d.stages.splice(i + 1, 0, JSON.parse(JSON.stringify(s)));
        shiftFolds(node, i + 1, 1);
        writeAndRender();
      };
      const del = document.createElement("button");
      del.textContent = "\u2715";
      del.title = "Remove this pass.";
      del.onclick = () => {
        d.stages.splice(i, 1);
        shiftFolds(node, i, -1);
        writeAndRender();
      };
      // FREE VRAM before this pass: the models ComfyUI holds are unloaded
      // while nothing is mid-allocation, so a 7B upscaler never overlaps the rig
      const freeT = tog("Free VRAM", "free_vram", false,
        "Unload every model ComfyUI is holding before this pass runs, so its "
        + "model never overlaps the one before it. They reload on demand: the "
        + "cost is one load, not the run. Runs on every queue.");
      top.append(spacer, freeT, dup, del);
      card.appendChild(top);

      if (!isFolded && s.type === "upscale") {
        // MODEL: the two loaders' dials, as the workflow sets them by hand
        const mdl = group("Model");
        mdl.line.append(
          lab("DiT"),
          sel(L.ditModels, s.dit_model,
              "The SeedVR2 DiT checkpoint. (loader default) is the pack's 3B; the "
              + "workflow runs the 7B fp8 mixed file.",
              (v) => { s.dit_model = v; writeCfg(node, d); }, "(loader default)"),
          lab("VAE"),
          sel(L.vaeModels, s.vae_model, "The SeedVR2 VAE. (loader default) is ema_vae_fp16.",
              (v) => { s.vae_model = v; writeCfg(node, d); }, "(loader default)"),
          lab("Attention"),
          sel(L.attention, s.attention,
              "The attention backend. (loader default) is sdpa, which always works; "
              + "sageattn_2 is faster where the sageattention package is installed.",
              (v) => { s.attention = v; writeCfg(node, d); }, "(loader default)"),
          lab("Blocks to swap"),
          num(s.blocks_to_swap ?? 36, 1,
              "Transformer blocks swapped to the offload device to fit the card: 36 "
              + "is all of the 7B's, the workflow's setting. 0 keeps everything on "
              + "the GPU, fastest, biggest.",
              (v) => { s.blocks_to_swap = Math.max(0, Math.min(36, Math.round(v))); writeCfg(node, d); }),
          lab("Offload"),
          sel(L.offloads.length ? L.offloads : ["none", "cpu"], s.offload || "cpu",
              "Where the models rest when not working. cpu is system RAM, the "
              + "workflow's choice; none keeps them on the GPU.",
              (v) => { s.offload = v; writeCfg(node, d); }),
          tog("Cache model", "cache_model", false,
              "Keep the SeedVR2 models loaded between queues on the offload device. "
              + "Faster runs, RAM held between them."));
        card.appendChild(mdl.box);

        // OUTPUT: what comes back and how the VAE is tiled to fit
        const outg = group("Output");
        outg.line.append(
          lab("Colour fix"),
          sel(L.colorFixes.length ? L.colorFixes
                                  : ["lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none"],
              s.color_fix || "lab",
              "Matches the upscale's colours back to the input. lab is the pack's "
              + "recommendation and the workflow's.",
              (v) => { s.color_fix = v; writeCfg(node, d); }),
          lab("Max edge"),
          num(s.max_edge || 0, 2, "Cap on either edge in pixels, 0 for none. Guards an "
              + "extreme aspect from an enormous long edge.",
              (v) => { s.max_edge = Math.max(0, Math.round(v)); writeCfg(node, d); }),
          tog("Tiled VAE", "tiled", true,
              "Encode and decode in tiles so a big frame fits the card. On in the "
              + "workflow; off is faster when memory allows."),
          lab("Tile"),
          num(s.tile ?? 1024, 32, "Tile size in pixels, both axes.",
              (v) => { s.tile = Math.max(64, Math.round(v)); writeCfg(node, d); }),
          lab("Overlap"),
          num(s.tile_overlap ?? 128, 32, "Pixels of overlap between tiles, blended to hide seams.",
              (v) => { s.tile_overlap = Math.max(0, Math.round(v)); writeCfg(node, d); }),
          lab("Input noise"),
          num(s.input_noise ?? 0, 0.01, "Noise added to the input before encoding, 0 to 1. "
              + "0 off; a touch can help some artefacts.",
              (v) => { s.input_noise = Math.max(0, Math.min(1, v)); writeCfg(node, d); }),
          lab("Latent noise"),
          num(s.latent_noise ?? 0, 0.01, "Noise added in the latent during diffusion, 0 to 1. "
              + "0 off; softens detail if input noise did not help.",
              (v) => { s.latent_noise = Math.max(0, Math.min(1, v)); writeCfg(node, d); }));
        card.appendChild(outg.box);
        if (LISTS && !L.seedvr) {
          const warn = document.createElement("div");
          warn.className = "hint";
          warn.textContent = "ComfyUI-SeedVR2_VideoUpscaler is not installed, so this pass "
                           + "will say so and pass the picture through.";
          card.appendChild(warn);
        }
      } else if (!isFolded) {
        const isDet = s.type === "detailer";
        // SAMPLING: the numbers a KSampler wants plus the step window. Empty
        // inherits the rig's, so the Models tab stays where a model's numbers live.
        const smp = group("Sampling");
        smp.line.append(
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
              (v) => { s.scheduler = v; writeCfg(node, d); }, "(rig)"));
        card.appendChild(smp.box);

        // STRENGTH: the two dials ridden while tuning, both bars so the card
        // reads at a glance, then the repeat and what each round of it does.
        const str = group("Strength");
        const isUsdu = s.type === "usdu";
        const dv = s.denoise ?? (isDet ? 0.15 : isUsdu ? 0.25 : 0.3);
        const sv = s.scale ?? 1.0;
        const scaleMin = isDet ? 1 : 0.25;
        if (isUsdu) {
          // a tiled pass grows the frame by a factor and its denoise is the
          // whole game: above 0.4 the tiles start inventing subjects
          str.line.append(
            lab("Upscale by"),
            bar(s.upscale_by ?? 2, 0.25, 4, 0.05, fmtX,
                "How much bigger the frame comes out. The upscale model (or a plain "
                + "resize) grows it first, then every tile is redrawn at the denoise.",
                "#4a8fe0", (v) => { s.upscale_by = v; writeCfg(node, d); }));
        } else {
          str.line.append(
            lab("Scale"),
            bar(sv, scaleMin, 4, 0.05, fmtX,
                isDet ? "Render the crop this much bigger, then put it back at its own "
                        + "size: more pixels spent on the face, no change to the frame."
                      : "Resize ratio for this pass. 1 is the picture as it arrives. The "
                        + "new size STICKS, so 0.5 then 2.0 across two passes is the "
                        + "shrink-and-regrow chain that invents detail.",
                "#4a8fe0", (v) => { s.scale = v; writeCfg(node, d); }));
        }
        str.line.append(
          lab("Denoise"),
          bar(dv, 0, 1, 0.01, fmt2,
              isUsdu ? "Denoise per tile. 0.20 to 0.35 sharpens and keeps the picture; "
                       + "above 0.40 tiles start inventing their own subjects."
                     : "Denoise for this pass.", "#b8283c",
              (v) => { s.denoise = v; writeCfg(node, d); }));
        if (isDet) {
          // BLEND against denoise: how much of the rendered crop goes back.
          // 1 is the render under the mask; lower keeps some of the crop as
          // it was, so a stronger denoise can be softened at the paste rather
          // than at the sampler. Feather beside it, the mask's edge in pixels.
          str.line.append(
            lab("Blend"),
            bar(s.blend ?? 1.0, 0, 1, 0.05, fmt2,
                "How much of the rendered crop goes back into the frame. 1.00 is "
                + "the render under the mask; 0.50 keeps half of the crop as it "
                + "was. Tune it against Denoise: 0.3 to 0.5 denoise with a blend "
                + "under 1 repaints harder and still keeps the face's own skin.",
                "#c9a24a", (v) => { s.blend = v; writeCfg(node, d); }),
            lab("Feather"),
            num(s.feather ?? 8, 1,
                "The mask's soft edge in pixels, 0 to 64. 8 to 12 hides the seam "
                + "on a face; more for hair against a busy background.",
                (v) => { s.feather = Math.max(0, Math.min(64, Math.round(v)));
                         writeCfg(node, d); }, "46px"));
        }
        const rrow = document.createElement("div");
        rrow.className = "line";
        // iteration on one pass, the Paint tab's Passes: N rounds over its own
        // result inside one queue, so "run it twice" stops meaning two cards
        const rep = document.createElement("input");
        rep.type = "number";
        rep.min = 1; rep.max = 10; rep.step = 1;
        rep.className = "rep" + ((s.repeat || 1) > 1 ? " on" : "");
        rep.value = String(s.repeat || 1);
        rep.title = "Run this pass over its own result this many times, a fresh "
                  + "seed each round; only the last picture moves on. Above 1, the "
                  + "switches beside it give every round its own denoise or scale. "
                  + "1 is a single run, as always.";
        rep.onchange = () => {
          s.repeat = Math.max(1, Math.min(10, Math.round(Number(rep.value) || 1)));
          writeAndRender();
        };
        rep.addEventListener("wheel", () => rep.blur(), { passive: true });
        rrow.append(lab("Repeat"), rep);
        // TONE LOCK: the result keeps its detail and takes this pass's input
        // tone, so colour and exposure stop wandering down a long chain
        rrow.append(tog("Tone lock", "tone_lock", false,
          "Keep this pass's new detail but take the tone, colour and exposure at "
          + "a radius, from the picture as it arrived, skin hue held. Off, the "
          + "pass keeps whatever tone the model gave it. The drift fix for a long "
          + "chain of passes."));
        if (s.tone_lock) {
          rrow.append(
            lab("Radius"),
            num(s.tone_radius ?? 32, 4,
                "How coarse the tone is, in pixels. 32 locks exposure and colour "
                + "casts and leaves everything finer to the pass; smaller pulls "
                + "more of the input back.",
                (v) => { s.tone_radius = Math.max(4, Math.min(256, Math.round(v)));
                         writeCfg(node, d); }, "46px"),
            lab("Strength"),
            bar(s.tone_strength ?? 1, 0, 1, 0.05, fmt2,
                "How far the tone is pulled back to the input's. 1.00 is all the way.",
                "#3fa7a0", (v) => { s.tone_strength = v; writeCfg(node, d); }));
        }
        const reps = Math.max(1, Math.round(Number(s.repeat) || 1));
        const extra = [];
        if (reps > 1) {
          const den = perRound(s, {
            key: "pass_denoise", flag: "pass_custom", dv, min: 0, max: 1, step: 0.01,
            accent: "#b8283c", fmt: fmt2, label: "Denoise per round", short: "Denoise",
            barTitle: "What this round repaints. Each round starts from the picture "
                    + "the one before it made, so a strong first round changes it and "
                    + "weaker ones settle it.",
            onTitle: "On: every round runs its own denoise, in order. Click to put "
                   + "them all back on the single bar.",
            offTitle: "Off: every round runs the one denoise above. Click to set a "
                    + "denoise per round, which is what a strong first round followed "
                    + "by weaker ones needs.",
            rampTitle: "Space the rounds evenly between the first bar and the last, "
                     + "so a run can fall away from 0.6 to 0.2 without setting each "
                     + "one by hand.",
          }, writeAndRender);
          const scl = perRound(s, {
            key: "pass_scale", flag: "scale_custom", dv: sv, min: scaleMin, max: 4,
            step: 0.05, accent: "#4a8fe0", fmt: fmtX, label: "Scale per round",
            short: "Scale",
            barTitle: isDet
              ? "How much bigger this round renders the crop."
              : "This round's size against the picture as it arrived. 1.0 then 1.5 "
                + "then 2.0 drafts small and rebuilds larger each round, a hi-res "
                + "chain inside one pass.",
            onTitle: "On: every round has its own scale. Click to put them all back "
                   + "on the single bar.",
            offTitle: isDet
              ? "Off: every round renders the crop at the one scale above. Click "
                + "to set a scale per round."
              : "Off: the first round scales and the rest refine at the size it "
                + "landed on. Click to set a size per round, which is how one pass "
                + "drafts small and regrows.",
            rampTitle: "Space the rounds evenly between the first bar and the last.",
          }, writeAndRender);
          rrow.append(den.sw, scl.sw);
          extra.push(...den.rows, ...scl.rows);
        }
        str.box.append(rrow, ...extra);
        card.appendChild(str.box);

        if (isUsdu) {
          // TILES: what Ultimate SD Upscale is handed. The defaults are the Pro
          // Grade notes: padding 128 up, seam fix None or Band Pass, a 1x skin
          // model as the upscaler when there is one.
          const tl = group("Tiles");
          tl.line.append(
            lab("Upscale model"),
            sel(L.upscaleModels, s.usdu_model || "",
                "The upscale model that grows the frame before the tiles are redrawn: "
                + "a 4x ESRGAN file, or a 1x skin model at Upscale by 1.00 for a skin "
                + "pass. (resize only) grows it by plain resampling.",
                (v) => { s.usdu_model = v; writeCfg(node, d); }, "(resize only)"),
            lab("Tile"),
            num(s.usdu_tile ?? 1024, 64, "Tile size in pixels, both axes. 1024 is a "
                + "Krea 2 sized tile; smaller fits a small card and costs more tiles.",
                (v) => { s.usdu_tile = Math.max(256, Math.min(2048, Math.round(v))); writeCfg(node, d); }, "56px"),
            lab("Padding"),
            num(s.usdu_padding ?? 128, 32, "Pixels of context around each tile. 128 to "
                + "512; more hides seams and costs time.",
                (v) => { s.usdu_padding = Math.max(0, Math.min(512, Math.round(v))); writeCfg(node, d); }, "50px"),
            lab("Blur"),
            num(s.usdu_blur ?? 8, 1, "Mask blur at the tile edges, in pixels.",
                (v) => { s.usdu_blur = Math.max(0, Math.min(64, Math.round(v))); writeCfg(node, d); }, "40px"),
            lab("Order"),
            sel(L.usduModes.length ? L.usduModes : ["Linear", "Chess", "None"],
                s.usdu_mode || "Linear",
                "The tiling order. Linear row by row; Chess alternates so neighbours "
                + "are never redrawn together; None skips the redraw and only seam fixes.",
                (v) => { s.usdu_mode = v; writeCfg(node, d); }),
            lab("Seam fix"),
            sel(L.seamModes.length ? L.seamModes
                                   : ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"],
                s.seam_mode || "None",
                "A second pass over the seams. None or Band Pass; Half Tile and the "
                + "intersections double the chance of a tile inventing something.",
                (v) => { s.seam_mode = v; writeAndRender(); }));
          if ((s.seam_mode || "None") !== "None") {
            tl.line.append(
              lab("Seam denoise"),
              num(s.seam_denoise ?? 0.35, 0.05, "Denoise for the seam pass.",
                  (v) => { s.seam_denoise = Math.max(0, Math.min(1, v)); writeCfg(node, d); }, "46px"));
          }
          tl.line.append(tog("Tiled decode", "tiled_decode", false,
            "Decode each tile through the VAE in tiles too, for a small card. Off is "
            + "faster when memory allows."));
          card.appendChild(tl.box);
          if (LISTS && !L.usdu) {
            const warn = document.createElement("div");
            warn.className = "hint";
            warn.textContent = "ComfyUI_UltimateSDUpscale is not installed, so this pass "
                             + "will say so and pass the picture through.";
            card.appendChild(warn);
          }
        }

        // PROMPT: what the pass is told. The stack and its set, the Krea 2
        // references, a LoRA of its own, and the words.
        const prm = group("Prompt");
        const bottom = prm.line;
        bottom.append(
          tog("LoRAs", "loras", true,
              "Apply the main LoRAs tab's stack to this pass's model and clip. "
              + "Off runs the rig raw. With it on, the Set box next to it says WHICH "
              + "LoRAs-tab set: (rig's) = the rig's own choice from the Models tab."));
        if (s.loras !== false) {
          // LORA SET for this pass: (rig's), Main, or a named set of the
          // workspace's LoRAs tab. A picked name that no longer exists shows
          // as missing rather than silently turning into Main.
          const names = loraSetNames();
          const cur = String(s.lora_set || "");
          const opts = [["", "(rig's set)"], ...names.map((n) => [n, n])];
          if (cur && !names.includes(cur)) opts.push([cur, cur + " (missing)"]);
          const ssel = document.createElement("select");
          for (const [v, l] of opts) {
            const o = document.createElement("option");
            o.value = v; o.textContent = l; o.selected = v === cur;
            ssel.appendChild(o);
          }
          ssel.title = "Which LoRAs-tab set this pass runs with. (rig's set) follows the "
                     + "Models tab; Main is the first tab there.";
          ssel.onchange = () => { s.lora_set = ssel.value; writeCfg(node, d); render(); };
          bottom.append(lab("Set"), ssel);
        }
        bottom.append(
          tog("Subject", "use_subject", false,
              "Krea 2 rigs only: this pass encodes with the Subject tab's image "
              + "as the identity reference."),
          tog("Scene", "use_scene", false,
              "Krea 2 rigs only: the Scene tab's image rides this pass's "
              + "conditioning."),
          tog("Mood", "use_moodboard", false,
              "Krea 2 rigs only: the Moodboard batch styles this pass."),
          tog("Picture", "use_picture", false,
              "Krea 2 rigs only: the picture as it arrives (a detailer's crop) "
              + "rides this pass as the FIRST reference, the base image of a "
              + "two-reference edit LoRA. With Subject on, that is the BFS "
              + "head/body swap order: base first, the Subject second. Wins over "
              + "Scene when both are on."));
        // the pass LoRA: a searchable picker, the pack's own (a native select is
        // unusable at a few hundred files - the LoRA Stack learned that first)
        const lp = document.createElement("input");
        lp.type = "text";
        lp.value = s.lora && s.lora !== "None" ? s.lora : "";
        lp.placeholder = "LoRA for this pass: click and type to search";
        lp.style.cssText = "flex:1;min-width:140px";
        lp.title = "A LoRA only this pass loads, model side, on top of the stack (or "
                 + "of the raw rig): the swap file goes here, so the main render "
                 + "never sees it. Click and type to search; recently used come first.";
        makePicker(lp, () => L.loras || [], (v) => {
          s.lora = v; writeCfg(node, d); render();
        }, { current: () => (s.lora && s.lora !== "None" ? s.lora : ""),
             emptyLabel: "(none)", recent: "detailer-lora" });
        bottom.append(lab("LoRA"), lp);
        if (s.lora && s.lora !== "None") {
          bottom.append(num(s.lora_strength ?? 1.0, 0.05, "Strength of the pass LoRA.",
                            (v) => { s.lora_strength = Math.max(0, Math.min(2, v)); writeCfg(node, d); },
                            "52px"));
        }
        // WHICH PROMPT: a Prompts-tab row for this pass. (rig's prompt) is the
        // row linked to the pass's rig, the same text the main render used, so
        // a chain no longer has to say the same thing on every pass.
        const rowsAvail = promptRows();
        const curRow = String(s.prompt_row || "");
        const ropts = [["", "(rig's prompt)"], ...rowsAvail.map((r) => [r.key, r.label])];
        if (curRow && !rowsAvail.some((r) => r.key === curRow)) {
          ropts.push([curRow, curRow + " (missing)"]);
        }
        const rsel = document.createElement("select");
        for (const [v, l] of ropts) {
          const o = document.createElement("option");
          o.value = v; o.textContent = l; o.selected = v === curRow;
          rsel.appendChild(o);
        }
        rsel.title = "Which Prompts-tab row this pass reads when the box beside it is "
                   + "empty. (rig's prompt) is the row linked to the pass's rig, the "
                   + "text the main render used. Typed text still wins.";
        rsel.onchange = () => { s.prompt_row = rsel.value; writeCfg(node, d); };
        bottom.append(lab("Prompt"), rsel);
        const pr = document.createElement("input");
        pr.type = "text";
        pr.placeholder = "Prompt: empty uses the row picked";
        pr.title = "Empty means the picked Prompts-tab row, wildcards rolled on this "
                 + "run's seed. Typed text wins.";
        pr.value = s.prompt || "";
        pr.onchange = () => { s.prompt = pr.value; writeCfg(node, d); };
        bottom.appendChild(pr);
        card.appendChild(prm.box);
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
    // the workflow's SeedVR2 group as one card, opened on its own settings:
    // 7B-sized swap, cpu offload, tiled VAE at 1024/128, lab colour fix, 1080p
    mk("＋ SeedVR2 upscale", () => ({ on: true, type: "upscale", size: "1080p",
                                     dit_model: "", vae_model: "", attention: "",
                                     blocks_to_swap: 36, offload: "cpu",
                                     cache_model: false, tiled: true, tile: 1024,
                                     tile_overlap: 128, color_fix: "lab", max_edge: 0,
                                     input_noise: 0, latent_noise: 0 }));
    // Ultimate SD Upscale as a pass, opened on the Pro Grade notes: 6 steps of
    // deis/simple at 0.25, x2, 1024 tiles padded 128, no seam fix
    mk("＋ Tiled upscale", () => ({ on: true, type: "usdu", rig: "", steps: 6,
                                   sampler: "deis", scheduler: "simple", denoise: 0.25,
                                   upscale_by: 2, usdu_model: "", usdu_tile: 1024,
                                   usdu_padding: 128, usdu_blur: 8, usdu_mode: "Linear",
                                   seam_mode: "None", seam_denoise: 0.35,
                                   tiled_decode: false, prompt: "" }));
    mk("＋ Group title", () => ({ type: "title", name: "GROUP", on: true }));
    wrap.appendChild(add);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = d.stages.length
      ? "Top to bottom is the run order. Sampling boxes left empty inherit the "
        + "rig's own settings from the Models tab. \u29c9 copies a pass; right-click "
        + "a card for colours and groups."
      : "No passes yet: the image goes straight through. Add a sampler refine or a "
        + "face detailer, as many as you want, in any order.";
    wrap.appendChild(hint);
  };
  render();
  if (hostEl) {
    node._rnAdvRender = render;
    return;
  }

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

// Rig Out / Rig In: the typed rig box becomes a DROPDOWN of the workspace's
// actual rig names, refreshed every time it opens, because a typo here fell
// silently to the active rig and rendered with the wrong prompt.
app.registerExtension({
  name: "RedNode.RigBridge",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!["RedNodeRigOut", "RedNodeRigIn"].includes(nodeData?.name)) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const w = this.widgets?.find((x) => x.name === "rig");
      if (!w) return;
      w.type = "combo";
      w.options = w.options || {};
      // a function, so the list is live: rigs added on the Models tab appear
      // the next time the dropdown opens, no reload
      w.options.values = () => ["(active rig)", ...rigNames()];
    };
  },
});
