import { app } from "../../scripts/app.js";
import { findNodes } from "./rednode_graph.js";
import { MIN_INPUTS, isWired, slotCount } from "./rednode_slots.js";
import { paletteState, setActiveColors } from "./rednode_palette.js";

// Router Control is the fourth piece of the colour system:
// Palette defines the variables, Router consumes combinations, Pass changes variables,
// and this node presents every unique Router combination as one global switch.

const NODE_NAME = "RedNodeRouterControl";
const ROUTER_NAME = "RedNodeRouter";
const NODE_MIN_W = 370;
const MIN_PANEL_H = 110;

const css = document.createElement("style");
css.textContent = `
.rn-rc-wrap{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-rc-head{display:flex;align-items:center;gap:7px;background:#20242a;border-radius:6px;padding:7px 9px;flex:none}
.rn-rc-count{font-size:18px;font-weight:800;color:#fff;line-height:1}
.rn-rc-head .label{font-size:11px;opacity:.7}
.rn-rc-head .summary{margin-left:auto;font-size:10.5px;opacity:.55}
.rn-rc-off{background:#15171b;border:1px solid #3a3e45;color:#9aa0a8;border-radius:5px;
  cursor:pointer;font-size:10px;padding:4px 7px}
.rn-rc-off:hover{border-color:#b8283c;color:#fff}
.rn-rc-row{display:flex;align-items:center;gap:7px;background:#212429;border:1px solid transparent;
  border-radius:6px;padding:7px 8px;cursor:pointer;flex:none;color:#ddd;text-align:left;width:100%}
.rn-rc-row:hover{background:#292d34}
.rn-rc-row.live{background:#1e5233;border-color:#2f7a4d}
.rn-rc-mode{font-size:9px;font-weight:800;letter-spacing:.4px;color:#9aa0a8;background:#15171b;
  border:1px solid #343840;border-radius:4px;padding:3px 5px;flex:none}
.rn-rc-mode.any{border-color:#6b4a1d;color:#f0c58a;background:#241d12}
.rn-rc-colors{display:flex;align-items:center;gap:4px;min-width:0;flex:1}
.rn-rc-dot{width:13px;height:13px;border-radius:4px;border:2px solid #0005;flex:none}
.rn-rc-name{font-size:11.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rn-rc-use{font-size:9.5px;opacity:.52;white-space:nowrap;flex:none}
.rn-rc-note{font-size:10.5px;opacity:.5;line-height:1.45;padding:3px 2px}
.rn-rc-warn{font-size:10.5px;color:#f0c58a;line-height:1.45;padding:3px 2px}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (node, name) => (node.widgets || []).find((w) => w.name === name);

// the parameter is a ROUTER, never this node: Router Control has no widgets of its own.
// Naming it `node` made tests/test_widget_contract.py read this as a lookup on
// RedNodeRouterControl and fail a widget that lives on RedNodeRouter.
function readRules(router) {
  try {
    const raw = JSON.parse(findWidget(router, "rules")?.value || "{}");
    const rules = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw.rules || raw) : {};
    return rules && typeof rules === "object" ? rules : {};
  } catch (e) {
    return {};
  }
}

function routerTitle(node) {
  const title = String(node.title || "").trim();
  return title && title !== "RedNode Router (advanced switch)" ? title : `Router #${node.id}`;
}

export function collectRouterCombinations(routers) {
  const combinations = new Map();
  let otherwise = 0;
  for (const router of routers || []) {
    const rules = readRules(router);
    const count = Math.max(MIN_INPUTS, slotCount(router));
    for (let branch = 1; branch <= count; branch++) {
      const raw = rules[branch] || rules[String(branch)] || {};
      const colors = [...new Set(
        (Array.isArray(raw.colors) ? raw.colors : [])
          .map((name) => String(name).trim())
          .filter(Boolean),
      )].sort((a, b) => a.localeCompare(b));
      if (!colors.length) {
        otherwise++;
        continue;
      }
      const mode = raw.mode === "any" ? "any" : "all";
      const key = `${mode}:${JSON.stringify(colors)}`;
      let combo = combinations.get(key);
      if (!combo) {
        combo = { key, mode, colors, uses: [], routerObjects: new Set() };
        combinations.set(key, combo);
      }
      combo.routerObjects.add(router);
      combo.uses.push({
        router: routerTitle(router),
        branch,
        label: String(raw.label || "").trim(),
        wired: isWired(router, branch),
      });
    }
  }
  return {
    routers: (routers || []).length,
    otherwise,
    combinations: [...combinations.values()].map((combo) => ({
      key: combo.key,
      mode: combo.mode,
      colors: combo.colors,
      uses: combo.uses,
      routerCount: combo.routerObjects.size,
    })),
  };
}

const sameSet = (left, right) => {
  if (left.size !== right.length) return false;
  return right.every((value) => left.has(value));
};

function snapshot() {
  const routers = findNodes(ROUTER_NAME);
  const summary = collectRouterCombinations(routers);
  const palette = paletteState();
  const signature = JSON.stringify({
    summary: summary.combinations.map((combo) => ({
      key: combo.key,
      uses: combo.uses,
      routerCount: combo.routerCount,
    })),
    routers: summary.routers,
    otherwise: summary.otherwise,
    palette: (palette.colors || []).map((color) => [color.name, color.color, !!color.on]),
  });
  return { summary, palette, signature };
}

function render(node, force = false) {
  const list = node._rnListEl;
  if (!list) return;
  const state = snapshot();
  if (!force && state.signature === node._rnSignature) return;
  node._rnSignature = state.signature;
  list.replaceChildren();

  const head = document.createElement("div");
  head.className = "rn-rc-head";
  const count = document.createElement("span");
  count.className = "rn-rc-count";
  count.textContent = state.summary.routers;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = state.summary.routers === 1 ? "router" : "routers";
  const total = document.createElement("span");
  total.className = "summary";
  total.textContent = `${state.summary.combinations.length} unique combinations`;
  const off = document.createElement("button");
  off.className = "rn-rc-off";
  off.textContent = "All off";
  off.title = "Clear the Palette so every Router uses its otherwise branch";
  off.onclick = () => {
    setActiveColors([]);
    node._rnSignature = "";
    render(node, true);
  };
  head.append(count, label, total, off);
  list.appendChild(head);

  if (!state.summary.routers) {
    const empty = document.createElement("div");
    empty.className = "rn-rc-note";
    empty.textContent = "No RedNode Routers yet. Add one anywhere in the workflow or a subgraph.";
    list.appendChild(empty);
  } else if (!state.summary.combinations.length) {
    const empty = document.createElement("div");
    empty.className = "rn-rc-note";
    empty.textContent = "The Routers have no colour rules yet. Set branch colours on a Router first.";
    list.appendChild(empty);
  }

  const paletteByName = new Map((state.palette.colors || []).map((color) => [color.name, color]));
  const active = new Set(state.palette.active || []);
  for (const combo of state.summary.combinations) {
    const row = document.createElement("button");
    row.className = "rn-rc-row" + (sameSet(active, combo.colors) ? " live" : "");
    const usage = combo.uses.map((use) =>
      `${use.router}, branch ${use.branch}${use.label ? ` (${use.label})` : ""}${use.wired ? "" : " [empty]"}`,
    );
    row.title = "Set this as the exact active Palette combination.\n" + usage.join("\n");
    row.onclick = () => {
      if (!setActiveColors(combo.colors)) return;
      node._rnSignature = "";
      render(node, true);
    };

    const mode = document.createElement("span");
    mode.className = "rn-rc-mode" + (combo.mode === "any" ? " any" : "");
    mode.textContent = combo.mode.toUpperCase();
    const colors = document.createElement("span");
    colors.className = "rn-rc-colors";
    for (const name of combo.colors) {
      const dot = document.createElement("span");
      dot.className = "rn-rc-dot";
      dot.style.background = paletteByName.get(name)?.color || "#6b7280";
      colors.appendChild(dot);
    }
    const name = document.createElement("span");
    name.className = "rn-rc-name";
    name.textContent = combo.colors.join(combo.mode === "any" ? " / " : " + ");
    colors.appendChild(name);
    const use = document.createElement("span");
    use.className = "rn-rc-use";
    use.textContent = `${combo.routerCount}R · ${combo.uses.length}B`;
    row.append(mode, colors, use);
    list.appendChild(row);
  }

  if (!state.palette.colors?.length) {
    const warning = document.createElement("div");
    warning.className = "rn-rc-warn";
    warning.textContent = "Add a RedNode Palette before using these switches.";
    list.appendChild(warning);
  } else {
    const note = document.createElement("div");
    note.className = "rn-rc-note";
    note.textContent = "Each row is one unique rule across all Routers. Selecting it replaces "
                     + "the active colours instead of stacking another combination."
                     + (state.summary.otherwise ? ` ${state.summary.otherwise} otherwise branches are omitted.` : "");
    list.appendChild(note);
  }

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    const want = 95 + Math.max(1, state.summary.combinations.length) * 39;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], Math.min(want, 460))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const wrap = document.createElement("div");
  wrap.className = "rn-rc-wrap";
  for (const type of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(type, (event) => event.stopPropagation());
  }
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px";
  wrap.appendChild(list);
  node._rnListEl = list;

  const widget = node.addDOMWidget("rednode_router_control_ui", "rednode_router_control_ui", wrap, {
    serialize: false,
    getValue: () => "",
    setValue: () => render(node, true),
    getMinHeight: () => MIN_PANEL_H,
  });
  widget.element = wrap;
  widget.options.getMinHeight = () => MIN_PANEL_H;
  widget.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 45];
  node._rnWidget = widget;
  node._rnRefresh = () => render(node, true);
  node._rnPoll = setInterval(() => render(node), 500);
  render(node, true);
}

app.registerExtension({
  name: "RedNode.RouterControl",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      injectStyle();
      build(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => render(this, true));
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._rnPoll) clearInterval(this._rnPoll);
      onRemoved?.apply(this, arguments);
    };
  },
});
