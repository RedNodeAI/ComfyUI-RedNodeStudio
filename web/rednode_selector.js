import { app } from "../../scripts/app.js";

// RedNode Selector — turns the `selected` field into a dropdown populated live from the
// `choices` multiline. Pick a line (or its Label) and the node outputs its value.

function parseLabels(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    out.push(s.includes(":") ? s.split(":")[0].trim() : s);
  }
  return out.length ? out : [""];
}

function buildSelector(node) {
  const choicesW = node.widgets?.find((w) => w.name === "choices");

  // replace the auto STRING widget for `selected` with a real combo dropdown
  let prev = "";
  const si = node.widgets?.findIndex((w) => w.name === "selected");
  if (si > -1) {
    const w = node.widgets[si];
    prev = w.value ?? "";
    if (typeof node.ensureWidgetRemoved === "function") node.ensureWidgetRemoved(w);
    else if (typeof node.removeWidget === "function") node.removeWidget(w);
    else node.widgets.splice(si, 1);
  }

  const selW = node.addWidget("combo", "selected", prev, () => {}, { values: parseLabels(choicesW?.value) });

  const refresh = () => {
    const vals = parseLabels(choicesW?.value);
    selW.options.values = vals;
    if (!vals.includes(selW.value)) selW.value = vals[0];
    node.setDirtyCanvas(true, true);
  };

  // repopulate as the choices text changes
  if (choicesW) {
    const cb = choicesW.callback;
    choicesW.callback = function () { cb?.apply(this, arguments); refresh(); };
  }

  node._rnSelectorRefresh = refresh;
  refresh();
  if (prev && parseLabels(choicesW?.value).includes(prev)) selW.value = prev;
}

app.registerExtension({
  name: "rednode.selector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "RedNodeSelector") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      buildSelector(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      // choices/selected values are restored just after onNodeCreated; repopulate next frame
      requestAnimationFrame(() => this._rnSelectorRefresh?.());
    };
  },
});
