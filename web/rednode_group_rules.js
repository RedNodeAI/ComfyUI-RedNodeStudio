import { app } from "../../scripts/app.js";
import { allGroups, allNodes } from "./rednode_graph.js";
import { evaluate, RULE_KINDS, makeRule } from "./rednode_rules.js";

// The Group Rules panel. PROTOTYPE.
//
// Two halves. The top is the rule list. The bottom is the part that matters: a live
// answer to "what will this queue actually run", with the reason next to every group.
//
// That preview is the feature. The reason people toggle groups by hand before every run
// is not that toggling is hard, it is that they cannot see what is about to happen. A
// rule engine without a preview would make that worse, so the preview is not a nicety
// bolted on afterwards, it is the thing being built.
//
// The engine is rednode_rules.js and is pure. Nothing here does any deciding.

const CSS = `
.rn-gr{display:flex;flex-direction:column;gap:8px;padding:9px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-gr h4{margin:0;font-size:12px;font-weight:600;opacity:.6;letter-spacing:.4px}
.rn-gr .rule{display:flex;gap:6px;align-items:center}
.rn-gr select,.rn-gr input[type=text]{background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:12px;padding:5px 6px;min-width:0}
.rn-gr select.kind{flex:none;width:96px}
.rn-gr .grow{flex:1}
.rn-gr button{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  cursor:pointer;font-size:12px;padding:6px 12px;flex:none}
.rn-gr button:hover{border-color:#b8283c;color:#fff}
.rn-gr button.on{background:#2a1116;border-color:#b8283c;color:#fff}
.rn-gr .x{padding:6px 9px;color:#ff9aa4}
.rn-gr .preview{background:#1b1e23;border:1px solid #2a2e35;border-radius:6px;padding:8px;
  display:flex;flex-direction:column;gap:3px}
.rn-gr .line{display:flex;gap:8px;align-items:baseline;font-size:12px}
.rn-gr .line .dot{width:8px;height:8px;border-radius:50%;flex:none}
.rn-gr .line.run .dot{background:#22c55e;box-shadow:0 0 5px #22c55e}
.rn-gr .line.skip .dot{background:#4a5058}
.rn-gr .line .nm{min-width:120px;font-weight:600}
.rn-gr .line.skip .nm{opacity:.5}
.rn-gr .line .why{opacity:.5;font-size:11.5px}
.rn-gr .clash{color:#f0c58a;font-size:11.5px;line-height:1.45}
.rn-gr .none{opacity:.45;font-size:11.5px}
`;
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

const readCfg = (node) => {
  const w = (node.widgets || []).find((x) => x.name === "config");
  let d = {};
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object") d = {};
  d.rules = Array.isArray(d.rules) ? d.rules : [];
  d.manual = d.manual && typeof d.manual === "object" ? d.manual : {};
  d.enabled = d.enabled !== false;
  return d;
};
const writeCfg = (node) => {
  const w = (node.widgets || []).find((x) => x.name === "config");
  if (w) w.value = JSON.stringify(node._rnGR);
  app.graph?.setDirtyCanvas?.(true, true);
};

/** Group names, subgraphs included, because a rule about a group you cannot see is
 *  worse than no rule at all. */
function groupNames() {
  const names = [];
  for (const g of allGroups()) {
    const t = String(g?.title || "").trim();
    if (t && !names.includes(t)) names.push(t);
  }
  return names;
}

/** Facts an "only if" rule can read. This is the bit nothing else in the ecosystem can
 *  do, because nothing else has the Workspace. */
export function workspaceState() {
  const state = {};
  for (const n of allNodes()) {
    if (n?.type !== "RedNodeStudioWorkspace") continue;
    const w = (n.widgets || []).find((x) => x.name === "config");
    let cfg = {};
    try { cfg = JSON.parse(w?.value || "{}"); } catch (e) { continue; }
    for (const [tab, t] of Object.entries(cfg.tabs || {})) {
      if (t && typeof t === "object") state[`${tab} tab`] = !!t.on;
    }
    if (cfg.paint) state["paint tab"] = !!cfg.paint.on;
    if (cfg.loras) state["loras tab"] = !!cfg.loras.on;
  }
  return state;
}

function render(node) {
  const root = node._rnGRRoot;
  if (!root) return;
  const d = node._rnGR;

  // Newer frontends draw an input dot for EVERY widget, hidden ones included, so the
  // hidden config widget leaks an unlabelled socket at the top of the node that cannot
  // be seen or used. Same fix as rednode_workspace.js; the widget is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "config") node.inputs.splice(i, 1);
  }
  root.replaceChildren();
  const groups = groupNames();

  const head = document.createElement("div");
  head.className = "rule";
  const onBtn = document.createElement("button");
  onBtn.className = d.enabled ? "on" : "";
  onBtn.textContent = d.enabled ? "Rules on" : "Rules off";
  onBtn.title = "Off, nothing here touches the graph and the preview below still shows "
              + "what would happen. That is the safe way to try a rule out.";
  onBtn.onclick = () => { d.enabled = !d.enabled; writeCfg(node); render(node); };
  const add = document.createElement("button");
  add.textContent = "Add rule";
  add.onclick = () => {
    d.rules.push(makeRule("requires", groups[0] || "", groups[1] || ""));
    writeCfg(node);
    render(node);
  };
  head.append(onBtn, add);
  root.appendChild(head);

  if (!groups.length) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = "No groups in this workflow yet. Make some groups and they "
                     + "appear here by name.";
    root.appendChild(none);
  }

  const state = workspaceState();
  const stateKeys = Object.keys(state).sort();

  d.rules.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "rule";
    const pick = (value, options, onChange, cls) => {
      const s = document.createElement("select");
      if (cls) s.className = cls;
      for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        opt.selected = String(value) === String(o);
        s.appendChild(opt);
      }
      if (!options.includes(String(value))) {
        const opt = document.createElement("option");
        opt.value = String(value);
        opt.textContent = `${value} (missing)`;
        opt.selected = true;
        s.appendChild(opt);
      }
      s.onchange = () => { onChange(s.value); writeCfg(node); render(node); };
      return s;
    };
    const use = document.createElement("button");
    use.className = r.on === false ? "" : "on";
    use.textContent = r.on === false ? "off" : "on";
    use.title = "Switch this one rule off without deleting it.";
    use.onclick = () => { r.on = r.on === false; writeCfg(node); render(node); };
    row.appendChild(use);
    row.appendChild(pick(r.a, groups, (v) => { r.a = v; }, "grow"));
    row.appendChild(pick(r.kind, RULE_KINDS, (v) => { r.kind = v; }, "kind"));
    // "only if" reads Workspace state; every other kind names a second group
    row.appendChild(pick(r.b, r.kind === "only if" ? stateKeys : groups,
                         (v) => { r.b = v; }, "grow"));
    const del = document.createElement("button");
    del.className = "x";
    del.textContent = "✕";
    del.title = "Delete this rule.";
    del.onclick = () => { d.rules.splice(i, 1); writeCfg(node); render(node); };
    row.appendChild(del);
    root.appendChild(row);
  });

  // ---- the preview, which is the whole point
  const h = document.createElement("h4");
  h.textContent = "This queue would run";
  root.appendChild(h);

  const box = document.createElement("div");
  box.className = "preview";
  const result = evaluate(groups, d.rules, { manual: d.manual, state });
  if (!groups.length) {
    const n = document.createElement("div");
    n.className = "none";
    n.textContent = "nothing to show yet";
    box.appendChild(n);
  }
  for (const g of result.order) {
    const line = document.createElement("div");
    line.className = "line " + (result.on[g] ? "run" : "skip");
    const dot = document.createElement("span");
    dot.className = "dot";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = g;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = result.why[g] || "";
    line.append(dot, nm, why);
    // clicking a name is the manual override the rules start from
    line.style.cursor = "pointer";
    line.title = "Click to set this group by hand. Rules move from what you set here.";
    line.onclick = () => {
      d.manual[g] = d.manual[g] === false;
      writeCfg(node);
      render(node);
    };
    box.appendChild(line);
  }
  for (const c of result.conflicts) {
    const w = document.createElement("div");
    w.className = "clash";
    w.textContent = c.text;
    box.appendChild(w);
  }
  root.appendChild(box);
}

app.registerExtension({
  name: "RedNode.GroupRules",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "RedNodeGroupRules") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      const node = this;
      const cfgW = (node.widgets || []).find((w) => w.name === "config");
      if (cfgW) {
        cfgW.type = "hidden";
        cfgW.hidden = true;
        cfgW.computeSize = () => [0, -4];
      }
      node._rnGR = readCfg(node);
      const wrap = document.createElement("div");
      wrap.className = "rn-gr";
      for (const t of ["pointerdown", "pointerup", "click", "keydown", "contextmenu"]) {
        wrap.addEventListener(t, (e) => e.stopPropagation());
      }
      node._rnGRRoot = wrap;
      node.addDOMWidget?.("rednode_group_rules_ui", "rednode_group_rules_ui", wrap, {
        serialize: false,
        getMinHeight: () => 260,
      });
      node.size = [Math.max(node.size?.[0] || 0, 460), Math.max(node.size?.[1] || 0, 320)];
      render(node);
    };
    // the preview has to be current when you look at it, and groups change on the
    // canvas without telling this node anything
    const drawn = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      drawn?.apply(this, arguments);
      const now = performance.now();
      if (!this._rnGRNext || now > this._rnGRNext) {
        this._rnGRNext = now + 700;
        if (this._rnGRRoot) render(this);
      }
    };
  },
});
