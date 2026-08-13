import { app } from "../../scripts/app.js";

// RedNode Studio Advanced — the post-render passes as a list you can read.
//
// Start, the passes in order, End. Each row names its rig (read live off the
// workspace's Models tab, the same walk Paint Out's dropdown does), carries its own
// denoise, and the detailer rows pick their SAM3 target. Order is the pipeline:
// what you see top to bottom is what runs first to last.
//
// Widget lifecycle follows the house pattern: the native config widget is HIDDEN,
// never removed, and stays the value holder; the panel reads and writes it.

const NODE_NAME = "RedNodeStudioAdvanced";
const TARGETS = ["face", "hair", "hands", "eyes", "clothes", "background"];

const css = document.createElement("style");
css.id = "rn-adv-style";
css.textContent = `
.rn-adv{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:13px 'Segoe UI',system-ui,sans-serif;color:#d6d9de;background:rgba(0,0,0,0.16);
  border:1px solid rgba(255,255,255,0.13);border-radius:6px;overflow:auto}
.rn-adv .cap{font-size:11px;font-weight:700;letter-spacing:.08em;color:#7f8792;
  text-align:center;border:1px dashed #33373d;border-radius:5px;padding:3px}
.rn-adv .row{display:flex;align-items:center;gap:6px;background:#1a1d22;
  border:1px solid #2a2e34;border-radius:6px;padding:6px}
.rn-adv .row.off{opacity:.45}
.rn-adv .chip{font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 7px;
  border-radius:4px;flex:none}
.rn-adv .chip.sampler{background:#233a5c;color:#9cc4ff}
.rn-adv .chip.detailer{background:#4a2d57;color:#e2b0ff}
.rn-adv select,.rn-adv input{background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:12px;padding:3px 6px}
.rn-adv input[type=number]{width:64px}
.rn-adv input[type=text]{flex:1;min-width:0}
.rn-adv button{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#c8ccd2;cursor:pointer;font-size:12px;padding:3px 8px}
.rn-adv button:hover{border-color:#b8283c;color:#fff}
.rn-adv .eye{flex:none;width:26px}
.rn-adv .add{display:flex;gap:6px}
.rn-adv .add button{flex:1;font-weight:600}
.rn-adv .hint{font-size:11px;color:#7f8792}
`;

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

  const wrap = document.createElement("div");
  wrap.className = "rn-adv";
  const render = () => {
    const d = readCfg(node);
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
      const row = document.createElement("div");
      row.className = "row" + (s.on === false ? " off" : "");
      const eye = document.createElement("button");
      eye.className = "eye";
      eye.textContent = s.on === false ? "—" : "👁";
      eye.title = "Skip this pass without losing its settings.";
      eye.onclick = () => { s.on = s.on === false; writeCfg(node, d); render(); };
      const chip = document.createElement("span");
      chip.className = "chip " + s.type;
      chip.textContent = s.type === "sampler" ? "SAMPLER" : "DETAILER";
      const rig = document.createElement("select");
      for (const n of ["", ...rigs]) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n || "(active rig)";
        o.selected = n === (s.rig || "");
        rig.appendChild(o);
      }
      rig.title = "Which Models-tab rig runs this pass.";
      rig.onchange = () => { s.rig = rig.value; writeCfg(node, d); };
      row.append(eye, chip, rig);
      if (s.type === "detailer") {
        const tgt = document.createElement("select");
        for (const t of TARGETS.includes(s.target) ? TARGETS
                                                   : [s.target, ...TARGETS]) {
          const o = document.createElement("option");
          o.value = t;
          o.textContent = t;
          o.selected = t === s.target;
          tgt.appendChild(o);
        }
        tgt.title = "What SAM3 segments and this pass redraws.";
        tgt.onchange = () => { s.target = tgt.value; writeCfg(node, d); };
        row.appendChild(tgt);
      }
      const dn = document.createElement("input");
      dn.type = "number";
      dn.step = "0.05";
      dn.min = "0";
      dn.max = "1";
      dn.value = s.denoise ?? (s.type === "detailer" ? 0.15 : 0.3);
      dn.title = "Denoise for this pass.";
      dn.onchange = () => {
        const v = parseFloat(dn.value);
        if (Number.isFinite(v)) { s.denoise = Math.max(0, Math.min(1, v)); writeCfg(node, d); }
      };
      const pr = document.createElement("input");
      pr.type = "text";
      pr.placeholder = "Prompt (optional)";
      pr.value = s.prompt || "";
      pr.onchange = () => { s.prompt = pr.value; writeCfg(node, d); };
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
      row.append(dn, pr, up, down, del);
      wrap.appendChild(row);
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
                                  denoise: 0.3, steps: 8, prompt: "" }));
    mk("＋ Face detailer", () => ({ on: true, type: "detailer", rig: "",
                                   target: "face", denoise: 0.15, steps: 8,
                                   threshold: 0.5, feather: 8, padding: 0.35,
                                   prompt: "" }));
    wrap.appendChild(add);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = d.stages.length
      ? "Top to bottom is the run order. The detailers need ComfyUI-Easy-Sam3 "
        + "installed; without it they pass the image through and say so."
      : "No passes yet: the image goes straight through. Add a sampler refine or a "
        + "face detailer, as many as you want, in any order.";
    wrap.appendChild(hint);
  };
  render();

  const widget = node.addDOMWidget("advanced_ui", "advanced_ui", wrap, {
    getValue: () => "",
    setValue: () => {},
    getMinHeight: () => 260,
    serialize: false,
  });
  widget.serialize = false;
  widget.element = wrap;
  node._rnAdvPanel = widget;
  node._rnAdvRender = render;
  const sz = node.computeSize();
  if (node.size[0] < 460) node.size[0] = 460;
  if (node.size[1] < sz[1]) node.size[1] = sz[1];
}

app.registerExtension({
  name: "RedNode.StudioAdvanced",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
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
