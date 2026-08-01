import { app } from "../../scripts/app.js";

// Shared branch plumbing for RedNode Switch and RedNode Router.
//
// Both nodes have the same wiring problem: numbered input slots you add and remove by
// hand, and an output that has to take the type of the first wired branch or downstream
// nodes refuse to connect to it. The typing rules are fiddly enough that two copies
// would drift, so they live here.
//
// This module registers nothing; it is imported by the two panel files.

export const MAX_INPUTS = 8;              // must match switch.py / router.py
export const MIN_INPUTS = 2;

export const slotName = (i) => `input_${i}`;
export const slotCount = (node) =>
  (node.inputs || []).filter((s) => /^input_\d+$/.test(s.name)).length;
export const isWired = (node, i) =>
  !!(node.inputs || []).find((s) => s.name === slotName(i))?.link;

// LiteGraph stores links on the graph, keyed by id — an object on most builds, a Map on
// newer ones, so read it both ways. The link usually knows its own type; fall back to
// asking the source node's output slot.
export function linkType(node, i) {
  const slot = (node.inputs || []).find((sl) => sl.name === slotName(i));
  if (!slot?.link) return null;
  const graph = node.graph || app.graph;
  const links = graph?.links;
  const link = links?.get?.(slot.link) ?? links?.[slot.link];
  if (!link) return null;
  if (link.type && link.type !== "*") return String(link.type);
  const src = graph?.getNodeById?.(link.origin_id);
  const t = src?.outputs?.[link.origin_slot]?.type;
  return t && t !== "*" ? String(t) : null;
}

// the lowest-numbered wired branch decides; unwire it and the next one takes over
export function branchType(node) {
  for (let i = 1; i <= slotCount(node); i++) {
    const t = linkType(node, i);
    if (t) return t;
  }
  return null;
}

export const mixedAllowed = (node) => !!node.properties?.rn_allow_mixed;

export function applyTypes(node) {
  const t = branchType(node) || "*";
  const any = mixedAllowed(node);
  // "any" is the escape hatch for logic-ish wiring: everything stays a wildcard, and it
  // is on you to make sure what comes out suits what it goes into.
  const out = (node.outputs || [])[0];
  if (out) {
    out.type = any ? "*" : t;
    // `name` stays "selected" for serialisation; the label is what you read on the canvas
    out.label = any ? "any" : (t === "*" ? "selected" : t);
  }
  // Locked (the default): the EMPTY sockets take the first branch's type, so a stray
  // IMAGE cannot land in a LATENT switch. A socket that already has a link keeps its own
  // type — retyping it under a live wire made the frontend mark that link invalid, which
  // is a worse problem than the one the lock is there to prevent.
  for (const sl of node.inputs || []) {
    if (!/^input_\d+$/.test(sl.name)) continue;
    if (sl.link) { sl.type = "*"; continue; }
    sl.type = any ? "*" : t;
  }
  node._rnType = t;
  return t;
}

// How many branches you asked for. Kept in node.properties, which serialise with the
// workflow WITHOUT taking a widget slot (adding a widget would shift the saved widget
// order of every existing node).
export function branchCount(node) {
  const want = Number(node.properties?.rn_branches);
  return Number.isFinite(want) && want >= MIN_INPUTS ? Math.min(MAX_INPUTS, Math.round(want)) : null;
}
function setBranchCount(node, n) {
  node.properties = node.properties || {};
  node.properties.rn_branches = Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, n));
}

// ComfyUI builds a slot for EVERY optional input the Python declares, so a fresh node
// arrives with all 8 whether you want them or not. Trim to the number actually asked
// for — and never below what is already wired, which would drop a link.
export function syncSlots(node) {
  if (!node.inputs) return;
  let highestWired = 0;
  for (let i = 1; i <= MAX_INPUTS; i++) if (isWired(node, i)) highestWired = i;
  const want = Math.max(MIN_INPUTS, highestWired, branchCount(node) ?? MIN_INPUTS);

  let n = slotCount(node);
  while (n < want) { node.addInput(slotName(n + 1), "*"); n++; }
  while (n > want) {
    const idx = (node.inputs || []).findIndex((s) => s.name === slotName(n));
    if (idx < 0 || node.inputs[idx].link) break;
    node.removeInput(idx);
    n--;
  }
}

export function addBranch(node, after) {
  const n = slotCount(node);
  if (n >= MAX_INPUTS) return;
  node.addInput(slotName(n + 1), node._rnType && !mixedAllowed(node) ? node._rnType : "*");
  setBranchCount(node, n + 1);            // remembered across a reload
  applyTypes(node);
  node.graph?.change?.();
  after?.();
}

// Only ever the last one, and only when nothing is plugged into it: removing a wired slot
// would silently drop a link you cannot see from here.
export function removeBranch(node, after) {
  const n = slotCount(node);
  if (n <= MIN_INPUTS || isWired(node, n)) return;
  const idx = (node.inputs || []).findIndex((s) => s.name === slotName(n));
  if (idx < 0) return;
  node.removeInput(idx);
  setBranchCount(node, n - 1);
  applyTypes(node);
  node.graph?.change?.();
  after?.(n);
}

// STRING widget -> real dropdown, in the frontend only, so our own names are never
// validated against a server-side list. Setting .type = "combo" on the existing widget
// is not enough on current frontends: replace it, but put the replacement back at the
// SAME index — ComfyUI restores widget values by position, and appending would swap it
// with whatever follows on the next load.
export function makeCombo(node, name, values) {
  const i = (node.widgets || []).findIndex((w) => w.name === name);
  let prev = "";
  if (i > -1) {
    const w = node.widgets[i];
    prev = w.value ?? "";
    if (typeof node.ensureWidgetRemoved === "function") node.ensureWidgetRemoved(w);
    else if (typeof node.removeWidget === "function") node.removeWidget(w);
    else node.widgets.splice(i, 1);
  }
  const combo = node.addWidget("combo", name, prev, () => {}, { values: values.slice() });
  combo.serialize = true;
  const at = node.widgets.indexOf(combo);
  if (i > -1 && at !== i) { node.widgets.splice(at, 1); node.widgets.splice(i, 0, combo); }
  return combo;
}

// A ＋ / − / type bar, shared so both nodes read the same. `after` re-renders the caller.
export function buildSlotBar(node, after) {
  const n = Math.max(MIN_INPUTS, slotCount(node));
  const bar = document.createElement("div");
  bar.className = "rn-sw-head";

  const plus = document.createElement("button");
  plus.textContent = "＋";
  plus.disabled = n >= MAX_INPUTS;
  plus.title = plus.disabled ? `${MAX_INPUTS} branches is the maximum` : "add a branch";
  plus.onclick = () => addBranch(node, after);

  const minus = document.createElement("button");
  minus.textContent = "－";
  const lastWired = isWired(node, n);
  minus.disabled = n <= MIN_INPUTS || lastWired;
  minus.title = n <= MIN_INPUTS ? `${MIN_INPUTS} branches is the minimum`
              : lastWired ? `unplug branch ${n} first`
              : `remove branch ${n}`;
  minus.onclick = () => removeBranch(node, after);

  const t = node._rnType || "*";
  const any = mixedAllowed(node);
  const typeBtn = document.createElement("button");
  typeBtn.className = "rn-sw-type" + (any ? " any" : "");
  typeBtn.textContent = any ? "any type" : (t === "*" ? "type: auto" : `type: ${t}`);
  typeBtn.title = any
    ? "anything may pass: inputs and output stay wildcards. Click to lock to one type again."
    : t === "*"
      ? "the output takes the type of the first branch you wire. Click to allow any type "
        + "through instead (for logic wiring)."
      : `locked to ${t}, taken from branch 1, other branches must match. Click to allow `
        + "any type through instead.";
  typeBtn.onclick = () => {
    node.properties = node.properties || {};
    node.properties.rn_allow_mixed = !mixedAllowed(node) || undefined;
    applyTypes(node);
    after?.();
  };

  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = `${n} branches`;

  bar.append(plus, minus, typeBtn, cnt);
  return bar;
}

// an escape hatch for the rare mixed-type node, mirrored in the canvas menu
export function addTypeMenuOption(nodeType, after) {
  const onMenu = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
    onMenu?.apply(this, arguments);
    const node = this;
    options.push({
      content: mixedAllowed(node) ? "Lock branches to the first branch's type"
                                  : "Allow any type through (logic wiring)",
      callback: () => {
        node.properties = node.properties || {};
        node.properties.rn_allow_mixed = !mixedAllowed(node) || undefined;
        applyTypes(node);
        after?.(node);
      },
    });
    return options;
  };
}
