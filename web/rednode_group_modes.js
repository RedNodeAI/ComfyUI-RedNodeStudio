import { app } from "../../scripts/app.js";
import { allNodes, allGroups } from "./rednode_graph.js";

// RedNode Group Modes — named presets that enable/bypass whole groups at once.
// Bypass = mode 4, active = mode 0 (same as rgthree's Fast Groups Bypasser).
//
// The interface follows UI_CONVENTIONS.md: the active-mode combo is a REAL widget at
// the top, so the Control Panel and the rest of the wireless system can drive it; the
// raw "modes" text stays the serialized source of truth but is hidden behind a panel
// of rows, one per mode, each with a name box and a groups box. Editing a row rewrites
// the text, and the text keeps old workflows loading unchanged.

const TYPE = "RedNodeGroupModes";
const MODE_ON = 0;
const MODE_BYPASS = 4;

export function parseModes(text) {
  const modes = {}; // {name: [groupTitle,...]} in file order
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const c = s.indexOf(":");
    if (c === -1) continue;
    const name = s.slice(0, c).trim();
    if (!name) continue;
    modes[name] = s.slice(c + 1).split(",").map((g) => g.trim()).filter(Boolean);
  }
  return modes;
}

export function serializeModes(modes) {
  return Object.entries(modes)
    .map(([name, groups]) => `${name}: ${groups.join(", ")}`)
    .join("\n");
}

// allNodes / allGroups come from rednode_graph.js and walk subgraphs, so a
// bypasser or a group tucked inside one still counts.
const BYPASSER_TYPE = "Fast Groups Bypasser (rgthree)";

const findBypassers = () =>
  allNodes().filter((n) => n && (n.type === BYPASSER_TYPE || n.comfyClass === BYPASSER_TYPE));

function groupNodes(group) {
  try { group.recomputeInsideNodes?.(); } catch (e) {}
  return group._nodes || group.nodes || [];
}

function applyMode(modes, modeName) {
  const enabled = new Set((modes[modeName] || []).map((g) => g.toLowerCase()));
  const managed = new Set();
  for (const gs of Object.values(modes)) for (const g of gs) managed.add(g.toLowerCase());

  const bypassers = findBypassers();
  if (bypassers.length) {
    // Preferred path: flip the Fast Groups Bypasser's own toggles, so it stays the owner
    // and there's no fight. Toggle rows are rgthree widgets with a doModeChange() method,
    // labelled with the group name.
    for (const bp of bypassers) {
      for (const w of bp.widgets || []) {
        if (typeof w.doModeChange !== "function") continue;
        const name = String(w.label ?? w.name ?? "").toLowerCase();
        const on = enabled.has(name);
        if (!on && !managed.has(name)) continue; // group not in any mode -> leave it
        if (typeof w.toggle === "function") w.toggle(on);
        else w.doModeChange(on, true);
      }
    }
  } else {
    // Fallback (no Bypasser present): set the group nodes directly.
    for (const group of allGroups()) {
      const title = (group.title || "").toLowerCase();
      let mode = null;
      if (enabled.has(title)) mode = MODE_ON;
      else if (managed.has(title)) mode = MODE_BYPASS;
      if (mode === null) continue;
      for (const n of groupNodes(group)) if (n) n.mode = mode;
    }
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

// ---- the panel -------------------------------------------------------------------
// Reuses the channel panel's CSS classes on purpose: one look, defined once.

function stripPhantomDot(node) {
  // newer frontends draw an input dot for every widget, hidden ones included
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "modes") node.inputs.splice(i, 1);
  }
}

function render(node) {
  const root = node._rnGMRoot;
  if (!root) return;
  stripPhantomDot(node);
  const modesW = (node.widgets || []).find((w) => w.name === "modes");
  const modeW = node._rnGMModeW;
  const modes = parseModes(modesW?.value);
  const names = Object.keys(modes);
  const active = String(modeW?.value ?? "");
  root.replaceChildren();

  const write = (next, apply = true) => {
    if (modesW) modesW.value = serializeModes(next);
    node._rnGM?.refresh();
    if (apply) node._rnGM?.apply();
    render(node);
  };

  const list = document.createElement("div");
  list.className = "rn-ch-list";
  if (!names.length) {
    const e = document.createElement("div");
    e.className = "rn-ch-empty";
    const have = allGroups().map((g) => String(g?.title || "").trim()).filter(Boolean);
    e.textContent = "No modes yet. Press + and name one. A mode lists the groups that "
                  + "run; groups named in any other mode are bypassed; groups named "
                  + "nowhere are left alone."
                  + (have.length ? ` Groups here: ${have.join(", ")}.` : "");
    list.appendChild(e);
  }
  for (const name of names) {
    const isActive = name === active;
    const row = document.createElement("div");
    row.className = "rn-ch-row" + (isActive ? " sel" : "");

    // the anatomy, adapted: a mode is APPLIED rather than bypassed, so the front
    // control is a radio dot instead of an eye
    const dot = document.createElement("button");
    dot.className = "rn-ch-eye";
    dot.textContent = isActive ? "◉" : "○";
    dot.style.color = isActive ? "#8fb4ff" : "#666";
    dot.title = isActive ? "this mode is active"
                         : "apply this mode: its groups run, groups in other modes "
                         + "are bypassed";
    dot.onclick = (e) => {
      e.stopPropagation();
      if (modeW) modeW.value = name;
      node._rnGM?.apply();
      render(node);
    };

    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.background = isActive ? "#8fb4ff" : "#3a3f47";

    const nm = document.createElement("input");
    nm.className = "nm";
    nm.type = "text";
    nm.value = name;
    nm.placeholder = "mode name";
    nm.title = "the name shown in the dropdown above";
    nm.style.maxWidth = "160px";
    nm.onchange = () => {
      const fresh = nm.value.trim();
      if (!fresh || fresh === name || names.includes(fresh)) { nm.value = name; return; }
      const next = {};
      for (const [k, v] of Object.entries(modes)) next[k === name ? fresh : k] = v;
      if (modeW && modeW.value === name) modeW.value = fresh;
      write(next);
    };

    const gs = document.createElement("input");
    gs.className = "nm";
    gs.type = "text";
    gs.value = modes[name].join(", ");
    gs.placeholder = "groups that run, comma separated";
    gs.title = "Group TITLES, comma separated. These run in this mode; groups named "
             + "in any other mode are bypassed; groups named in no mode are left "
             + "alone. Groups here: "
             + (allGroups().map((g) => String(g?.title || "").trim()).filter(Boolean)
                .join(", ") || "none yet");
    gs.onchange = () => {
      const next = { ...modes };
      next[name] = gs.value.split(",").map((x) => x.trim()).filter(Boolean);
      write(next);
    };

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "remove this mode";
    x.onclick = (e) => {
      e.stopPropagation();
      const next = { ...modes };
      delete next[name];
      if (modeW && modeW.value === name) modeW.value = Object.keys(next)[0] ?? "";
      write(next, false);
    };

    row.append(dot, bar, nm, gs, x);
    row.onclick = (e) => {
      if (e.target.closest("input,button")) return;
      if (modeW) modeW.value = name;
      node._rnGM?.apply();
      render(node);
    };
    list.appendChild(row);
  }
  root.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "rn-ch-foot";
  const add = document.createElement("button");
  add.className = "rn-ch-btn";
  add.textContent = "+";
  add.title = "add a mode";
  add.onclick = () => {
    let n = 1;
    while (modes[`mode ${n}`]) n++;
    write({ ...modes, [`mode ${n}`]: [] }, false);
  };
  const note = document.createElement("span");
  note.textContent = names.length
    ? `${names.length} mode(s). Click a row to apply it.`
    : "";
  foot.append(add, note);
  root.appendChild(foot);
}

app.registerExtension({
  name: "rednode.groupmodes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const node = this;
      const modesW = node.widgets?.find((w) => w.name === "modes");

      // The raw text is the panel's to manage now. Still the source of truth in the
      // file, so an old workflow loads and an edited one saves the same shape.
      if (modesW) {
        modesW.type = "hidden";
        modesW.hidden = true;
        modesW.computeSize = () => [0, -4];
        if (modesW.element) modesW.element.style.display = "none";
        if (modesW.inputEl) modesW.inputEl.style.display = "none";
      }

      // the "mode" STRING widget becomes the dropdown at the top, and stays a REAL
      // widget so it is drivable wirelessly
      let prev = "";
      const si = node.widgets?.findIndex((w) => w.name === "mode");
      if (si > -1) {
        const w = node.widgets[si];
        prev = w.value ?? "";
        if (typeof node.ensureWidgetRemoved === "function") node.ensureWidgetRemoved(w);
        else if (typeof node.removeWidget === "function") node.removeWidget(w);
        else node.widgets.splice(si, 1);
      }
      const modeNames = () => {
        const keys = Object.keys(parseModes(modesW?.value));
        return keys.length ? keys : [""];
      };
      const modeW = node.addWidget("combo", "mode", prev, () => {
        applyMode(parseModes(modesW?.value), modeW.value);
        render(node);
      }, { values: modeNames() });
      node._rnGMModeW = modeW;

      const refresh = () => {
        modeW.options.values = modeNames();
        if (!modeW.options.values.includes(modeW.value)) modeW.value = modeW.options.values[0] ?? "";
        node.setDirtyCanvas(true, true);
      };
      if (modesW) {
        const cb = modesW.callback;
        modesW.callback = function () { cb?.apply(this, arguments); refresh(); render(node); };
      }
      node._rnGM = { refresh, apply: () => applyMode(parseModes(modesW?.value), modeW.value) };
      refresh();

      const wrap = document.createElement("div");
      wrap.className = "rn-ch";
      for (const t of ["pointerdown", "pointerup", "click", "dblclick", "keydown",
                       "contextmenu"]) {
        wrap.addEventListener(t, (e) => e.stopPropagation());
      }
      node._rnGMRoot = wrap;
      node.addDOMWidget?.("rednode_group_modes_ui", "rednode_group_modes_ui", wrap, {
        serialize: false,
        getMinHeight: () => 110,
      });
      node.size = [Math.max(node.size?.[0] || 0, 460),
                   Math.max(node.size?.[1] || 0, 190)];
      stripPhantomDot(node);
      render(node);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      // re-assert the saved mode once the graph (and its groups) are loaded
      requestAnimationFrame(() => {
        this._rnGM?.refresh();
        this._rnGM?.apply();
        stripPhantomDot(this);
        render(this);
      });
    };
  },
});
