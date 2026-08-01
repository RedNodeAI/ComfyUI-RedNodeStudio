import { app } from "../../scripts/app.js";
import {
  MAX_INPUTS, MIN_INPUTS, slotName, slotCount, isWired,
  applyTypes, syncSlots, buildSlotBar, addTypeMenuOption,
} from "./rednode_slots.js";

// RedNode Router — the advanced switch.
//
// Each branch says which colours it needs and whether it needs ALL or ANY of them. The
// colours come from RedNode Palette, wirelessly. The first branch whose condition is met
// passes; a branch with no colours is the "otherwise" branch.
//
// That is the whole point: four variables used to mean eight boolean gates. Here it is
// four colours and one panel, and you can see at a glance which branch is live.

const NODE_NAME = "RedNodeRouter";
const PALETTE_NAME = "RedNodePalette";
const NODE_MIN_W = 360;
const MIN_PANEL_H = 110;
const ROW_H = 34;
const MAX_BRANCH_COLORS = 4;

const css = document.createElement("style");
css.textContent = `
.rn-rt-wrap{display:flex;flex-direction:column;gap:5px;padding:8px;box-sizing:border-box;
  font:13px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:auto}
.rn-rt-row{display:flex;align-items:center;gap:6px;background:#212429;border-radius:5px;padding:0 7px;
  height:${ROW_H}px;flex:none}
.rn-rt-row.live{background:#1e5233;outline:1px solid #2f7a4d}
.rn-rt-row.empty{opacity:.5}
.rn-rt-n{font-size:10px;opacity:.45;width:12px;flex:none;text-align:right}
.rn-rt-name{flex:1 1 auto;min-width:40px;background:transparent;border:0;color:#e8ecf1;font-size:12.5px;
  font-weight:600;padding:2px 0}
.rn-rt-name:focus{outline:none;border-bottom:1px solid #b8283c}
.rn-rt-chips{display:flex;gap:3px;flex:none;align-items:center}
.rn-rt-chip{width:15px;height:15px;border-radius:4px;cursor:pointer;border:2px solid transparent;
  opacity:.28;box-sizing:border-box}
.rn-rt-chip.on{opacity:1;border-color:#ffffff88}
.rn-rt-chip.on.live{box-shadow:0 0 6px #ffffff66}
.rn-rt-more{font-size:9px;color:#f0c58a;opacity:.8;min-width:16px;text-align:center}
.rn-rt-mode{background:#15171b;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:9.5px;font-weight:700;letter-spacing:.4px;height:22px;width:34px;flex:none}
.rn-rt-mode.any{border-color:#6b4a1d;color:#f0c58a}
.rn-rt-tag{font-size:9.5px;opacity:.5;flex:none;letter-spacing:.3px;min-width:52px;text-align:right}
.rn-rt-note{font-size:10.5px;opacity:.45;line-height:1.45;padding:2px 2px 0}
.rn-rt-warn{font-size:10.5px;color:#f0c58a;line-height:1.45;padding:2px 2px 0}
.rn-sw-head{display:flex;gap:6px;align-items:center;flex:none;padding-top:2px}
.rn-sw-head button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  cursor:pointer;font-size:13px;font-weight:700;height:26px;width:34px;line-height:1}
.rn-sw-head button:hover:not(:disabled){border-color:#b8283c;color:#fff}
.rn-sw-head button:disabled{opacity:.35;cursor:not-allowed}
.rn-sw-head .cnt{font-size:10.5px;opacity:.45;margin-left:auto}
.rn-sw-head button.rn-sw-type{width:auto;padding:0 9px;font-size:10.5px;font-weight:600;
  letter-spacing:.3px;color:#9aa0a8}
.rn-sw-head button.rn-sw-type.any{border-color:#6b4a1d;color:#f0c58a;background:#241d12}
.rn-rt-menu{position:fixed;z-index:10004;min-width:250px;max-width:340px;max-height:440px;overflow:auto;
  background:#1b1e23;border:1px solid #3a3d44;border-radius:7px;padding:6px;box-shadow:0 8px 28px #000a;
  font:12px system-ui,sans-serif;color:#ddd}
.rn-rt-menu .note{font-size:10.5px;opacity:.6;line-height:1.4;padding:4px 7px 7px}
.rn-rt-menu button{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;color:#ddd;
  border-radius:5px;padding:6px 7px;cursor:pointer;text-align:left}
.rn-rt-menu button:hover:not(:disabled){background:#2a2e35}
.rn-rt-menu button.on{background:#26303d;color:#fff}
.rn-rt-menu button:disabled{opacity:.55;cursor:not-allowed}
.rn-rt-menu .dot{width:14px;height:14px;border-radius:4px;border:2px solid #0005;flex:none}
.rn-rt-menu .tick{margin-left:auto;font-size:10px;opacity:.75}
.rn-rt-menu .reset{margin-top:5px;border-top:1px solid #33373d;border-radius:0;padding-top:8px;color:#9aa0a8}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

// ---- state -----------------------------------------------------------------
function readRules(node) {
  const w = findWidget(node, "rules");
  try {
    const d = JSON.parse(w?.value || "{}");
    const r = d && typeof d === "object" && !Array.isArray(d) ? (d.rules || d) : {};
    return r && typeof r === "object" ? r : {};
  } catch (e) {
    return {};
  }
}
function writeRules(node, rules) {
  const w = findWidget(node, "rules");
  if (w) w.value = JSON.stringify({ rules });
  node.graph?.change?.();
}
const ruleFor = (rules, i) => {
  const r = rules[i] || rules[String(i)] || {};
  const out = {
    colors: Array.isArray(r.colors) ? [...new Set(r.colors.map(String))] : [],
    mode: r.mode === "any" ? "any" : "all",
    label: r.label || "",
  };
  if (Array.isArray(r.shown)) out.shown = [...new Set(r.shown.map(String))].slice(0, MAX_BRANCH_COLORS);
  return out;
};

// The palette is read wirelessly. It pushes on every edit, and we pull here too so a
// router dropped into an existing workflow is right immediately.
function palette() {
  const seen = new Set();
  let found = null;
  const walk = (graph) => {
    if (!graph || seen.has(graph) || found) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === PALETTE_NAME) { found = n; return; }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
  return found;
}

function paletteColors(node) {
  const p = palette();
  if (p?._rnCfg?.colors) return p._rnCfg.colors;
  if (node._rnPaletteColors) return node._rnPaletteColors;   // pushed to us earlier
  return [];
}

// `active` is a real widget because only widget values reach the server at queue time.
function activeSet(node) {
  const p = palette();
  if (p?._rnCfg?.colors) {
    const live = p._rnCfg.colors.filter((c) => c.on).map((c) => c.name);
    const json = JSON.stringify(live);
    const w = findWidget(node, "active");
    if (w && w.value !== json) w.value = json;               // keep what we queue honest
    return new Set(live);
  }
  try {
    const v = JSON.parse(findWidget(node, "active")?.value || "[]");
    return new Set(Array.isArray(v) ? v : (v.active || []));
  } catch (e) {
    return new Set();
  }
}

// mirrors router.py: all/any over the branch's colours, no colours means "otherwise"
function matches(rule, active) {
  if (!rule.colors.length) return false;
  return rule.mode === "any" ? rule.colors.some((c) => active.has(c))
                             : rule.colors.every((c) => active.has(c));
}

function liveBranch(node) {
  const rules = readRules(node);
  const active = activeSet(node);
  const n = Math.max(MIN_INPUTS, slotCount(node));
  const wired = [];
  for (let i = 1; i <= n; i++) if (isWired(node, i)) wired.push(i);
  const pool = wired.length ? wired : Array.from({ length: n }, (_, k) => k + 1);

  for (const i of pool) if (matches(ruleFor(rules, i), active)) return i;
  for (const i of pool) if (!ruleFor(rules, i).colors.length) return i;   // "otherwise"
  return pool[0];
}

function displayedColors(rule, colors) {
  const byName = new Map(colors.map((c) => [c.name, c]));
  const names = [];
  const add = (name) => {
    if (byName.has(name) && !names.includes(name) && names.length < MAX_BRANCH_COLORS) {
      names.push(name);
    }
  };
  // Never hide a condition that is currently part of the branch rule. Custom display
  // choices fill whatever room remains.
  for (const name of rule.colors) add(name);
  const chosen = Array.isArray(rule.shown) ? rule.shown : colors.map((c) => c.name);
  for (const name of chosen) add(name);
  return names.map((name) => byName.get(name));
}

function openColorMenu(node, branch, ev) {
  ev.preventDefault();
  document.querySelector(".rn-rt-menu")?.remove();
  const colors = paletteColors(node);
  const rules = readRules(node);
  const rule = ruleFor(rules, branch);
  const visible = new Set(displayedColors(rule, colors).map((c) => c.name));
  const required = new Set(rule.colors);

  const menu = document.createElement("div");
  menu.className = "rn-rt-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    menu.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = `Branch ${branch}: choose up to ${MAX_BRANCH_COLORS} colour controls. `
                   + "Colours already required by the branch stay visible.";
  menu.appendChild(note);

  for (const color of colors) {
    const on = visible.has(color.name);
    const locked = required.has(color.name);
    const button = document.createElement("button");
    button.className = on ? "on" : "";
    button.disabled = locked || (!on && visible.size >= MAX_BRANCH_COLORS);
    button.title = locked
      ? "This colour is required by the branch. Turn its chip off before hiding it."
      : !on && visible.size >= MAX_BRANCH_COLORS
        ? `Four are already shown. Hide one before choosing ${color.name}.`
        : on ? "Hide this colour control" : "Show this colour control";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = color.color || "#9aa0a8";
    const label = document.createElement("span");
    label.textContent = color.name;
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = locked ? "required" : on ? "shown" : "";
    button.append(dot, label, tick);
    button.onclick = () => {
      const next = readRules(node);
      const current = ruleFor(next, branch);
      const shown = displayedColors(current, paletteColors(node)).map((c) => c.name);
      current.shown = on ? shown.filter((name) => name !== color.name)
                         : [...shown, color.name].slice(0, MAX_BRANCH_COLORS);
      next[branch] = current;
      writeRules(node, next);
      render(node);
      openColorMenu(node, branch, ev);
    };
    menu.appendChild(button);
  }

  const reset = document.createElement("button");
  reset.className = "reset";
  reset.textContent = "Reset to automatic first four";
  reset.onclick = () => {
    const next = readRules(node);
    const current = ruleFor(next, branch);
    delete current.shown;
    next[branch] = current;
    writeRules(node, next);
    render(node);
    menu.remove();
  };
  menu.appendChild(reset);

  document.body.appendChild(menu);
  const mw = 270;
  const mh = menu.getBoundingClientRect().height || 240;
  menu.style.left = Math.max(6, Math.min(ev.clientX, (window.innerWidth || 1920) - mw - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(ev.clientY, (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- UI --------------------------------------------------------------------
function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["rules", "active"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const list = node._rnListEl;
  if (!list) return;
  const rules = readRules(node);
  const active = activeSet(node);
  const colors = paletteColors(node);
  const live = liveBranch(node);
  const n = Math.max(MIN_INPUTS, slotCount(node));
  list.replaceChildren();

  for (let i = 1; i <= n; i++) {
    const rule = ruleFor(rules, i);
    const wired = isWired(node, i);
    const isLive = i === live;

    const row = document.createElement("div");
    row.className = "rn-rt-row" + (isLive ? " live" : "") + (wired ? "" : " empty");
    row.title = `Right-click to choose the ${MAX_BRANCH_COLORS} colour controls shown on this branch`;
    row.oncontextmenu = (ev) => openColorMenu(node, i, ev);

    const num = document.createElement("span");
    num.className = "rn-rt-n";
    num.textContent = i;

    const name = document.createElement("input");
    name.className = "rn-rt-name";
    name.value = rule.label;
    name.placeholder = `branch ${i}`;
    name.title = "name this branch, for reading, not for matching";
    name.addEventListener("pointerdown", (e) => e.stopPropagation());
    name.addEventListener("change", () => {
      const next = readRules(node);
      next[i] = { ...ruleFor(next, i), label: name.value.trim() };
      writeRules(node, next); render(node);
    });

    // Four branch-specific controls stay readable even when the Palette holds sixteen
    // colours. Right-click the branch to choose which four are present.
    const chips = document.createElement("span");
    chips.className = "rn-rt-chips";
    if (!colors.length) {
      const hint = document.createElement("span");
      hint.className = "rn-rt-tag";
      hint.textContent = "no palette";
      hint.title = "add a RedNode Palette node and give it some colours";
      chips.appendChild(hint);
    }
    const shown = displayedColors(rule, colors);
    for (const c of shown) {
      const on = rule.colors.includes(c.name);
      const chip = document.createElement("span");
      chip.className = "rn-rt-chip" + (on ? " on" : "") + (on && active.has(c.name) ? " live" : "");
      chip.style.background = c.color || "#9aa0a8";
      chip.title = `${c.name}${active.has(c.name) ? " (on)" : " (off)"}, click to ${on ? "stop" : "start"} `
                 + "requiring it for this branch";
      chip.onclick = () => {
        const next = readRules(node);
        const r = ruleFor(next, i);
        r.colors = on ? r.colors.filter((x) => x !== c.name) : [...r.colors, c.name];
        next[i] = r;
        writeRules(node, next); render(node);
      };
      chips.appendChild(chip);
    }
    const hiddenRequired = rule.colors.filter((name0) => !shown.some((c) => c.name === name0));
    if (hiddenRequired.length) {
      const more = document.createElement("span");
      more.className = "rn-rt-more";
      more.textContent = `+${hiddenRequired.length}`;
      more.title = `Additional required colours: ${hiddenRequired.join(", ")}`;
      chips.appendChild(more);
    }

    const mode = document.createElement("button");
    mode.className = "rn-rt-mode" + (rule.mode === "any" ? " any" : "");
    mode.textContent = rule.mode === "any" ? "ANY" : "ALL";
    mode.title = rule.mode === "any"
      ? "passes when ANY of its colours is on, click for ALL"
      : "passes only when ALL of its colours are on, click for ANY";
    mode.onclick = () => {
      const next = readRules(node);
      next[i] = { ...ruleFor(next, i), mode: rule.mode === "any" ? "all" : "any" };
      writeRules(node, next); render(node);
    };

    const tag = document.createElement("span");
    tag.className = "rn-rt-tag";
    tag.textContent = !wired ? "empty"
                    : isLive ? (rule.colors.length ? "LIVE" : "OTHERWISE")
                    : "";
    if (isLive) tag.style.color = "#86d3a1";

    row.append(num, name, chips, mode, tag);
    list.appendChild(row);
  }

  const note = document.createElement("div");
  note.className = "rn-rt-note";
  const liveRule = ruleFor(rules, live);
  note.textContent = liveRule.colors.length
    ? `branch ${live} passes: ${liveRule.mode === "any" ? "any of" : "all of"} ${liveRule.colors.join(", ")}`
    : `branch ${live} passes as the “otherwise” branch`;
  list.appendChild(note);

  if (!isWired(node, live)) {
    const warn = document.createElement("div");
    warn.className = "rn-rt-warn";
    warn.textContent = `nothing is wired into branch ${live}, the first wired branch runs instead`;
    list.appendChild(warn);
  }

  list.appendChild(buildSlotBar(node, () => render(node)));

  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    const want = 40 + n * (ROW_H + 5) + 60;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], Math.min(want, 460))]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  if (!findWidget(node, "rules") || !findWidget(node, "active")) {
    requestAnimationFrame(() => build(node));
    return;
  }
  for (const nm of ["rules", "active"]) {
    const w = findWidget(node, nm);
    w.type = "hidden";
    w.hidden = true;
    w.computeSize = () => [0, -4];
    if (w.element) w.element.style.display = "none";
    if (w.inputEl) w.inputEl.style.display = "none";
  }

  const wrap = document.createElement("div");
  wrap.className = "rn-rt-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  wrap.appendChild(list);
  node._rnListEl = list;

  const w = node.addDOMWidget("rednode_router_ui", "rednode_router_ui", wrap, {
    serialize: false,
    getValue: () => findWidget(node, "rules")?.value,
    setValue: (v) => { const rw = findWidget(node, "rules"); if (rw) rw.value = v ?? "{}"; render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 50];
  node._rnWidget = w;

  // the palette calls these when it changes or a colour is renamed
  node._rnRefresh = () => render(node);
  node._rnRename = (was, next) => {
    const rules = readRules(node);
    let touched = false;
    for (const k of Object.keys(rules)) {
      const r = ruleFor(rules, k);
      if (r.colors.includes(was)) {
        r.colors = r.colors.map((c) => (c === was ? next : c));
        touched = true;
      }
      if (Array.isArray(r.shown) && r.shown.includes(was)) {
        r.shown = r.shown.map((c) => (c === was ? next : c));
        touched = true;
      }
      rules[k] = r;
    }
    if (touched) writeRules(node, rules);
    render(node);
  };

  syncSlots(node);
  applyTypes(node);
  render(node);
}

app.registerExtension({
  name: "RedNode.Router",
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
      requestAnimationFrame(() => {
        syncSlots(this);
        applyTypes(this);
        render(this);
      });
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      if (this._rnWidget) { applyTypes(this); render(this); }
      return r;
    };

    addTypeMenuOption(nodeType, (node) => render(node));
  },
});
