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
`;

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
    cap("START · the workspace's image arrives");
    const rigs = rigNames();
    d.stages.forEach((s, i) => {
      const card = document.createElement("div");
      card.className = "card" + (s.on === false ? " off" : "");
      const top = document.createElement("div");
      top.className = "line";
      const eye = document.createElement("button");
      eye.className = "eye";
      eye.textContent = s.on === false ? "—" : "👁";
      eye.title = "Skip this pass without losing its settings.";
      eye.onclick = () => { s.on = s.on === false; writeCfg(node, d); render(); };
      const chip = document.createElement("span");
      chip.className = "chip " + s.type;
      chip.textContent = s.type === "sampler" ? "SAMPLER" : "DETAILER";
      top.append(eye, chip, lab("Rig"),
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
      }
      const spacer = document.createElement("span");
      spacer.className = "grow";
      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "Run this pass earlier.";
      up.disabled = i === 0;
      up.onclick = () => {
        d.stages.splice(i - 1, 0, d.stages.splice(i, 1)[0]);
        writeCfg(node, d); render();
      };
      const down = document.createElement("button");
      down.textContent = "↓";
      down.title = "Run this pass later.";
      down.disabled = i === d.stages.length - 1;
      down.onclick = () => {
        d.stages.splice(i + 1, 0, d.stages.splice(i, 1)[0]);
        writeCfg(node, d); render();
      };
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove this pass.";
      del.onclick = () => { d.stages.splice(i, 1); writeCfg(node, d); render(); };
      top.append(spacer, up, down, del);
      card.appendChild(top);

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
        num(s.denoise ?? (s.type === "detailer" ? 0.15 : 0.3), 0.05,
            "Denoise for this pass.",
            (v) => { s.denoise = Math.max(0, Math.min(1, v)); writeCfg(node, d); }));
      card.appendChild(mid);

      const bottom = document.createElement("div");
      bottom.className = "line";
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
