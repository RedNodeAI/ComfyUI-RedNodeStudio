import { app } from "../../scripts/app.js";
import { allNodes, nodeById } from "./rednode_graph.js";

// RedNode Combo Control (Stage 1) — drive one target node's dropdown/toggle from here,
// wireless. Proves the mechanism: set the target widget's value directly in the frontend,
// so at queue time the target serializes the value we chose. No wires, no COMBO edges.

const TYPE = "RedNodeComboControl";

const isControllable = (w) =>
  w && (w.type === "combo" || w.type === "toggle" || typeof w.value === "boolean" ||
        (w.options && Array.isArray(w.options.values)));

const nodeLabel = (n) => `${n.title || n.type} #${n.id}`;

function listTargets(selfNode) {
  const values = [""];
  const map = {};
  for (const n of allNodes()) {
    if (!n || n === selfNode || n.type === TYPE) continue;
    if ((n.widgets || []).some(isControllable)) {
      const label = nodeLabel(n);
      values.push(label);
      map[label] = n.id;
    }
  }
  return { values, map };
}

// a driven node can sit inside a subgraph, so never scan the top level alone
const findNode = (id) => nodeById(id);

const widgetNames = (node) =>
  ["", ...(node?.widgets || []).filter(isControllable).map((w) => w.name)];

function choicesFor(node, wname) {
  const w = (node?.widgets || []).find((x) => x.name === wname);
  if (!w) return [""];
  if (w.type === "toggle" || typeof w.value === "boolean") return ["true", "false"];
  const vals = w.options?.values;
  return Array.isArray(vals) && vals.length ? vals.map(String) : [""];
}

function makeCombo(node, name) {
  let prev = "";
  const i = node.widgets?.findIndex((w) => w.name === name);
  if (i > -1) {
    prev = node.widgets[i].value ?? "";
    const w = node.widgets[i];
    if (typeof node.ensureWidgetRemoved === "function") node.ensureWidgetRemoved(w);
    else if (typeof node.removeWidget === "function") node.removeWidget(w);
    else node.widgets.splice(i, 1);
  }
  const combo = node.addWidget("combo", name, prev, () => {}, { values: [prev || ""] });
  combo.serialize = true;
  return combo;
}

app.registerExtension({
  name: "rednode.combocontrol",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const node = this;

      const targetW = makeCombo(node, "target");
      const widgetW = makeCombo(node, "widget");
      const valueW = makeCombo(node, "value");
      let targetMap = {};

      const refreshTargets = () => {
        const t = listTargets(node);
        targetMap = t.map;
        targetW.options.values = t.values;
      };
      const refreshWidgets = () => {
        const tn = findNode(targetMap[targetW.value]);
        widgetW.options.values = widgetNames(tn);
        if (!widgetW.options.values.includes(widgetW.value)) widgetW.value = widgetW.options.values[0] ?? "";
      };
      const refreshValues = () => {
        const tn = findNode(targetMap[targetW.value]);
        valueW.options.values = choicesFor(tn, widgetW.value);
        if (!valueW.options.values.includes(valueW.value)) valueW.value = valueW.options.values[0] ?? "";
      };
      const apply = () => {
        const tn = findNode(targetMap[targetW.value]);
        if (!tn) return;
        const w = (tn.widgets || []).find((x) => x.name === widgetW.value);
        if (!w) return;
        let v = valueW.value;
        if (w.type === "toggle" || typeof w.value === "boolean") v = v === "true";
        else if (typeof w.value === "number") v = Number(v);
        w.value = v;
        try { w.callback?.(w.value, app.canvas, tn); } catch (e) {}
        tn.setDirtyCanvas?.(true, true);
      };

      targetW.callback = () => { refreshWidgets(); refreshValues(); node.setDirtyCanvas(true, true); };
      widgetW.callback = () => { refreshValues(); node.setDirtyCanvas(true, true); };
      valueW.callback = () => { apply(); };

      node._rnCC = { refreshTargets, refreshWidgets, refreshValues, apply };
      // keep the target list fresh right before you open a dropdown
      const omd = node.onMouseDown;
      node.onMouseDown = function () { refreshTargets(); return omd?.apply(this, arguments); };

      refreshTargets(); refreshWidgets(); refreshValues();
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => {
        this._rnCC?.refreshTargets();
        this._rnCC?.refreshWidgets();
        this._rnCC?.refreshValues();
        this._rnCC?.apply(); // re-assert the saved selection on load
      });
    };

    // auto-rescan the graph on a throttle so newly added nodes appear without a manual refresh
    const onDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      const now = Date.now();
      if (this._rnCC && (!this._lastScan || now - this._lastScan > 400)) {
        this._lastScan = now;
        this._rnCC.refreshTargets();
        this._rnCC.refreshWidgets();
        this._rnCC.refreshValues();
      }
      return onDraw?.apply(this, arguments);
    };
  },
});
