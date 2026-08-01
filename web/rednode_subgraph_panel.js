import { app } from "../../scripts/app.js";
import { membersOf, memberView, deriveLabel, nextAutoName, socketOrder,
         shortLabel, autoGroups, uniqueChannelName,
         labelPublishers } from "./rednode_channels.js";

// The panel for both ends of the pair, in the same shape as every other panel in this
// pack: a plus button, a row per value, and the raw sockets kept out of the way.
//
// SEND: you add rows. Each row has a name, a type, and optionally a conversion. A socket
// appears for each, so the node grows with what you put in it rather than showing eight
// empty ones.
//
// RECEIVE: you name a channel and it LISTS what is on it, from anywhere in the workflow,
// with the type and where each value was wired from. Each row lines up with the socket
// beside it. That list is the whole point of a channel being a group: being able to see
// what is in one.
//
// Colour is ComfyUI's own wire colour for the type, so a row reads like the wire it
// stands for.

const SEND = "RedNodeSubgraphSend";
const RECEIVE = "RedNodeSubgraphReceive";
const MAX = 64;                                 // must match MAX_SLOTS in the Python

export const TYPES = ["any", "LATENT", "IMAGE", "MASK", "MODEL", "CLIP", "VAE",
                      "CONDITIONING", "STRING", "INT", "FLOAT", "BOOLEAN"];
export const CONVERSIONS = ["", "STRING", "INT", "FLOAT", "BOOLEAN"];

// Read off the live canvas when it is there, since a user theme changes them. This is
// the stock set as the fallback.
const FALLBACK = {
  MODEL: "#B39DDB", CLIP: "#FFD500", VAE: "#FF6E6E", CONDITIONING: "#FFA931",
  LATENT: "#FF9CF9", IMAGE: "#64B5F6", MASK: "#81C784", CONTROL_NET: "#00d78d",
  STRING: "#b0b0b0", INT: "#29699c", FLOAT: "#77aa77", BOOLEAN: "#aa5555",
  COMBO: "#9ab7d3",
};

// The SOCKETS are painted by litegraph from its own type-colour map, and the stock
// map has no entries for the primitive types at all: INT, FLOAT, STRING, BOOLEAN and
// COMBO dots all fall back to grey while the panel chips show real colours. The
// missing entries are added ONCE, and only where the map has nothing, so a theme
// that defines its own colours always wins. After this the chips and the dots read
// from the same table and cannot disagree.
function applyTypeColours() {
  const maps = [
    globalThis.LGraphCanvas?.link_type_colors,
    window.LGraphCanvas?.link_type_colors,
    globalThis.LiteGraph?.LGraphCanvas?.link_type_colors,
    app.canvas?.default_connection_color_byType,
  ];
  let touched = false;
  for (const map of maps) {
    if (!map) continue;
    for (const [type, colour] of Object.entries(FALLBACK)) {
      if (!map[type]) { map[type] = colour; touched = true; }
    }
  }
  if (touched) app.graph?.setDirtyCanvas?.(true, true);
  return touched;
}

app.registerExtension({
  name: "RedNode.TypeColours",
  async setup() {
    // Writing once at setup was too early: the canvas and its palette arrive AFTER
    // extension setup, and a theme apply can replace the per-canvas map wholesale, so
    // the entries were lost before anything drew. The write is idempotent and only
    // ever fills gaps, so it simply re-applies until the world stops moving, and the
    // channel nodes' own refresh tick keeps it healed after any later theme switch.
    applyTypeColours();
    for (const delay of [250, 1000, 3000, 8000]) {
      setTimeout(applyTypeColours, delay);
    }
  },
});
export function colourFor(type) {
  if (!type || type === "any" || type === "*") return "#6b7280";
  try {
    const live = app.canvas?.default_connection_color_byType
              || window.LGraphCanvas?.link_type_colors;
    if (live && live[type]) return live[type];
  } catch (e) { /* fall through */ }
  return FALLBACK[type] || "#8a8f98";
}

const CSS = `
.rn-ch{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:15px system-ui,sans-serif;color:#e8ecf1;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-ch-head{display:flex;gap:6px;align-items:center;flex:none}
.rn-ch-head .lab{font-size:13px;opacity:.6;flex:none;font-weight:600}
.rn-ch input,.rn-ch select{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#e8ecf1;font-size:14px;padding:7px 9px;min-width:0}
.rn-ch input:focus,.rn-ch select:focus{outline:none;border-color:#b8283c}
.rn-ch-head input{flex:1}
.rn-ch-btn{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  cursor:pointer;font-size:13.5px;padding:7px 12px;flex:none}
.rn-ch-btn:hover{border-color:#b8283c;color:#fff}
.rn-ch-btn.on{background:#2a1116;border-color:#b8283c;color:#fff;font-weight:600}
.rn-ch-list{display:flex;flex-direction:column;gap:4px}
.rn-ch-row{display:flex;gap:8px;align-items:center;background:#212429;
  border:1px solid #2a2e35;border-radius:6px;padding:8px 10px}
.rn-ch-box{display:flex;flex-direction:column;gap:4px;background:#1b1e23;
  border:1px solid #33373d;border-radius:7px;padding:6px 8px 8px 8px;flex:none}
.rn-ch-box .rn-ch-row{margin-left:14px}
.rn-ch-box .rn-ch-title{margin-left:0}
.rn-ch-sub{font-size:11px;opacity:.45;flex:none;max-width:30%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.rn-ch-row.off{opacity:.72;background:#141619}
.rn-ch-row.off .ro{color:#ff7b86;text-decoration:line-through;
  text-decoration-color:#ff7b8666}
.rn-ch-row.off .rn-ch-eye{border-color:#6b1d26;color:#ff7b86}
.rn-ch-row.off .chip{opacity:.6}
.rn-ch-fold{background:#111316;border:1px solid #33373d;border-radius:4px;
  color:#9aa0a8;cursor:pointer;font-size:11px;flex:none;width:32px;height:26px;
  display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1}
.rn-ch-fold:hover{color:#fff;border-color:#b8283c}
.rn-ch-row .bar{width:5px;align-self:stretch;border-radius:3px;flex:none;min-height:26px}
.rn-ch-row .nm{flex:1;min-width:0}
.rn-ch-row .ro{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-weight:600;font-size:14.5px}
.rn-ch-row select.ty{flex:none;width:124px}
.rn-ch-row select.cv{flex:none;width:92px}
.rn-ch-row .chip{font-size:12px;font-weight:700;letter-spacing:.4px;flex:none;
  padding:3px 8px;border-radius:4px}
.rn-ch-row .src{font-size:12.5px;opacity:.5;flex:none;max-width:36%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.rn-ch-row .pin{font-size:12.5px;opacity:.45;flex:none;min-width:16px;text-align:right}
.rn-ch-row .x{background:none;border:0;color:#ff9aa4;cursor:pointer;font-size:15px;
  padding:2px 6px;flex:none}
.rn-ch-row .x:hover{color:#fff}
.rn-ch-row.rn-drop{outline:2px solid #b8283c}
.rn-ch-row.sel{border-color:#b8283c;box-shadow:0 0 6px #b8283c44}
.rn-ch-grip{cursor:grab;opacity:.4;flex:none;font-size:13px;letter-spacing:-2px;
  padding:0 2px;user-select:none}
.rn-ch-grip:hover{opacity:.9}
.rn-ch-eye{background:#111316;border:1px solid #33373d;border-radius:4px;
  cursor:pointer;font-size:14px;flex:none;color:#8fb4ff;width:32px;height:26px;
  display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1}
.rn-ch-eye:hover{border-color:#b8283c}
.rn-ch-menu{position:fixed;z-index:10001;background:#111316;border:1px solid #3a3d44;
  border-radius:6px;padding:9px;display:flex;flex-direction:column;gap:7px;
  font:13px system-ui,sans-serif;color:#ddd;min-width:210px;
  box-shadow:0 6px 22px #000a}
.rn-ch-menu h5{margin:0;font-size:10.5px;font-weight:700;letter-spacing:.6px;
  opacity:.5;text-transform:uppercase}
.rn-ch-menu .sw{display:flex;gap:5px;flex-wrap:wrap}
.rn-ch-menu .sw div{width:22px;height:22px;border-radius:5px;cursor:pointer;
  border:2px solid transparent}
.rn-ch-menu .sw div:hover{border-color:#fff}
.rn-ch-menu button{background:#15171b;border:1px solid #33373d;border-radius:5px;
  color:#ddd;cursor:pointer;font-size:12.5px;padding:6px 10px;text-align:left}
.rn-ch-menu button:hover{border-color:#b8283c;color:#fff}
.rn-ch-menu input{background:#15171b;border:1px solid #33373d;border-radius:4px;
  color:#e8ecf1;font-size:12.5px;padding:6px 8px}
.rn-ch-title{background:#20242b;font-weight:700}
.rn-ch-auto{border-style:dashed;opacity:.85;padding:4px 10px}
.rn-ch-title .ro{opacity:.85}
.rn-ch-empty{font-size:13px;opacity:.5;line-height:1.55;padding:8px 2px}
.rn-ch-foot{display:flex;gap:8px;align-items:center;flex:none;font-size:12.5px;
  opacity:.55}
`;
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

const cfgWidget = (node) => (node.widgets || []).find((w) => w?.name === "config");

// ---- socket tuck: the same 🔌 as RedNode Studio Workspace -----------------------
// Tucked, every UNWIRED socket parks as a bare dot on the node's bottom edge (inputs
// left, outputs right); wired slots keep their rows. A second click tucks those too.
// Dropping a wire on a parked dot still works, and the slot pops back when it connects.
const SLOT_H = () => globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;

function untuckSlot(s) {
  if (!s._rnTucked) return;
  delete s.pos;
  if (s._rnLbl === undefined || s._rnLbl === " ") delete s.label;
  else s.label = s._rnLbl;
  delete s._rnTucked;
  delete s._rnLbl;
}

// 0 = full rows, 1 = unwired sockets tucked, 2 = everything tucked
function tuckMode(node) {
  const v = node.properties?.rn_tucked;
  return v === true ? 1 : Number(v) || 0;
}

function applyTuck(node) {
  const ins = node.inputs || [];
  const outs = node.outputs || [];
  const mode = tuckMode(node);
  if (!mode) {
    let dirty = false;
    for (const s of [...ins, ...outs]) {
      if (s._rnTucked || s.label === " " || s.pos) {     // also heals reloaded debris
        s._rnTucked = true;
        untuckSlot(s);
        dirty = true;
      }
    }
    if (node.widgets_start_y != null) { node.widgets_start_y = null; dirty = true; }
    if (dirty) node.setDirtyCanvas?.(true, true);
    return;
  }
  const W = node.size?.[0] || 460;
  const H = node.size?.[1] || 210;
  let ki = 0, ko = 0, wiredIn = 0, wiredOut = 0;
  for (const s of ins) {
    if (mode === 1 && s.link != null) { untuckSlot(s); wiredIn++; continue; }
    if (!s._rnTucked) {
      s._rnTucked = true;
      s._rnLbl = s.label === " " ? undefined : s.label;
      s.label = " ";
    }
    s.pos = [16 + ki * 13, H - 7];
    ki++;
  }
  for (const s of outs) {
    if (mode === 1 && (s.links || []).length) { untuckSlot(s); wiredOut++; continue; }
    if (!s._rnTucked) {
      s._rnTucked = true;
      s._rnLbl = s.label === " " ? undefined : s.label;
      s.label = " ";
    }
    s.pos = [W - 16 - ko * 13, H - 7];
    ko++;
  }
  node.widgets_start_y = Math.max(wiredIn, wiredOut) * SLOT_H() + 8;
  node.setDirtyCanvas?.(true, true);
}

// ---- simple mode -----------------------------------------------------------------
// The panel is for the person BUILDING the workflow. The person a workflow is shared
// with often just wants a clean little node that receives, so the whole interface can
// fold down to a thin strip. Stored in node.properties, so a workflow shipped in
// simple mode opens in simple mode.
const simpleMode = (node) => !!node.properties?.rn_simple;

function setSimple(node, on) {
  const props = (node.properties ||= {});
  if (on) {
    // remember the size the panel had, so leaving simple mode puts the node BACK
    // rather than dumping it at a default. In properties, so it survives a save:
    // a workflow shipped in simple mode unfolds to the size its builder left it.
    props.rn_prev_size = [node.size?.[0] || 0, node.size?.[1] || 0];
    props.rn_simple = true;
    sync(node, true);
    const min = node.computeSize?.();
    if (min) node.setSize?.([node.size?.[0] || min[0], min[1]]);
    return;
  }
  props.rn_simple = false;
  sync(node, true);
  const min = node.computeSize?.();
  const prev = props.rn_prev_size;
  delete props.rn_prev_size;
  if (Array.isArray(prev) && prev[0] > 0 && prev[1] > 0) {
    // never smaller than the content now needs: sockets may have joined meanwhile
    node.setSize?.([prev[0], Math.max(prev[1], min ? min[1] : 0)]);
  } else if (min) {
    node.setSize?.([node.size?.[0] || min[0], min[1]]);
  }
}

function simpleButton(node) {
  const b = document.createElement("button");
  b.className = "rn-ch-btn";
  b.textContent = "🗕";
  b.title = "Fold the panel away and leave a plain, compact node: the sockets, the "
          + "channel, nothing else. Everything set here keeps working; this only "
          + "changes what is shown.";
  b.onclick = () => setSimple(node, true);
  return b;
}

/** The thin strip shown instead of the panel. Says what the node is doing and offers
 *  the way back, because a mode with no exit is a trap. */
function renderSimple(node, root) {
  root.replaceChildren();
  const d = node._rnCh;
  const bar = document.createElement("div");
  bar.className = "rn-ch-head";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.style.flex = "1";
  const isSend = node.type === SEND;
  const chs = isSend ? (d.channel.trim() || "(no channel)")
                     : readerChannels(d).join(", ") || "(no channel)";
  const count = isSend ? d.slots.length
                       : memberView(allSends(), readerChannels(d), d.order).length;
  lab.textContent = `${chs} · ${count} value(s)`;
  const open = document.createElement("button");
  open.className = "rn-ch-btn";
  open.textContent = "Panel";
  open.title = "open the full panel again";
  open.onclick = () => setSimple(node, false);
  bar.append(lab, tuckButton(node), open);
  root.appendChild(bar);
}

/** The 🔌 for the panel head. Same wording as the Workspace's, because it is the same
 *  feature and should read as one. */
function tuckButton(node) {
  const tmode = tuckMode(node);
  const tuck = document.createElement("button");
  tuck.className = "rn-ch-btn" + (tmode ? " on" : "");
  tuck.textContent = "🔌";
  tuck.title = tmode === 0
    ? "Tuck every unwired socket down to the node's bottom edge as a bare dot, so the "
      + "sockets stop eating the node's height. Wired sockets keep their rows. A second "
      + "click tucks those too."
    : tmode === 1
      ? "Unwired sockets sit as bare dots on the bottom edge; hover a dot for its name, "
        + "drop a wire on it to bring it back. Click to tuck the wired rows down too."
      : "Everything is tucked; the wires ride down to their dots. Click to restore the "
        + "full rows.";
  tuck.onclick = () => {
    (node.properties ||= {}).rn_tucked = (tuckMode(node) + 1) % 3;
    sync(node, true);
  };
  return tuck;
}

/** Every channel name anything in the workflow is already using. */
function knownChannels() {
  const names = new Set();
  for (const m of allSends()) if (m.channel) names.add(m.channel);
  const walk = (graph, seen = new Set()) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of graph._nodes || []) {
      if (n?.type === RECEIVE) {
        const c = readCfg(n).channel.trim();
        if (c) names.add(c);
      }
      if (n?.subgraph) walk(n.subgraph, seen);
    }
  };
  walk(app.graph);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The channel field: a dropdown of what already exists, and still typeable for a new
 * one. A plain text box meant retyping the same name at both ends and getting it subtly
 * wrong, which is the exact Get/Set failure this pair is supposed to remove.
 */
function channelField(node, d, onChange) {
  // A native select, NOT LiteGraph.ContextMenu. That one draws at canvas scale, so at
  // any sensible zoom it comes out as an unreadable four-pixel menu floating off the
  // side of the node. Anything inside a DOM panel has to be DOM.
  const wrap = document.createElement("span");
  wrap.style.cssText = "display:flex;gap:5px;flex:1;min-width:0";
  const names = knownChannels();
  const sel = document.createElement("select");
  sel.style.cssText = "flex:1;min-width:0";
  sel.title = "Channels that already exist in this workflow.";
  const cur = d.channel.trim();
  const opts = [...new Set([...(cur ? [cur] : []), ...names])];
  if (!opts.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "no channels yet";
    sel.appendChild(o);
  }
  for (const name of opts) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    o.selected = name === cur;
    sel.appendChild(o);
  }
  const NEW = "… type a new name";
  const other = document.createElement("option");
  other.value = "__new__";
  other.textContent = NEW;
  sel.appendChild(other);

  const box = document.createElement("input");
  box.type = "text";
  box.value = cur;
  box.placeholder = "channel name";
  box.style.cssText = "flex:1;min-width:0;display:none";
  const commit = () => onChange(box.value);
  box.onchange = commit;
  box.onblur = commit;

  sel.onchange = () => {
    if (sel.value === "__new__") {
      sel.style.display = "none";
      box.style.display = "";
      box.value = "";
      box.focus();
      return;
    }
    onChange(sel.value);
  };
  if (!opts.length) { sel.style.display = "none"; box.style.display = ""; }
  wrap.append(sel, box);
  return wrap;
}

function readCfg(node) {
  let d = {};
  try { d = JSON.parse(cfgWidget(node)?.value || "{}"); } catch (e) { d = {}; }
  if (Array.isArray(d)) d = { slots: d };
  if (!d || typeof d !== "object") d = {};
  d.channel = String(d.channel ?? "");
  d.publish = !!d.publish;
  d.slots = Array.isArray(d.slots) ? d.slots : [];
  // the reader's extras: more channels beyond the primary, rows switched off, and the
  // display order. Keyed "channel/label" so two channels can share a label.
  d.channels = (Array.isArray(d.channels) ? d.channels : [])
    .map((c) => String(c ?? "").trim()).filter(Boolean);
  d.muted = d.muted && typeof d.muted === "object" ? d.muted : {};
  d.order = Array.isArray(d.order) ? d.order.map(String) : [];
  // cosmetic per-row overrides, keyed like mute and order: row colour, text colour,
  // and a display name for THIS panel. The real label stays the matching key, so a
  // pretty name never breaks the pairing.
  d.style = d.style && typeof d.style === "object" ? d.style : {};
  // rows tucked out of sight entirely, and whether the panel is showing them anyway
  d.hidden = d.hidden && typeof d.hidden === "object" ? d.hidden : {};
  d.showHidden = !!d.showHidden;
  // the automatic headers' own colour, text colour and collapse, keyed by the source
  // node's name, so they carry the SAME dressing the manual titles do
  d.autoStyle = d.autoStyle && typeof d.autoStyle === "object" ? d.autoStyle : {};
  // group titles: rows that divide the list, stored as "t:<id>" entries in d.order.
  // The splice and the socket maths never see them, since only member keys match.
  d.titles = d.titles && typeof d.titles === "object" ? d.titles : {};
  return d;
}

/** The display sequence: title tokens and member keys interleaved, driven by d.order,
 *  with members the order does not mention appended so nothing ever vanishes. */
function channelTokens(d, memberKeys) {
  const tokens = [];
  const seen = new Set();
  for (const t of d.order || []) {
    const str = String(t);
    if (str.startsWith("t:")) {
      if (d.titles[str.slice(2)] && !seen.has(str)) { tokens.push(str); seen.add(str); }
    } else if (memberKeys.includes(str) && !seen.has(str)) {
      tokens.push(str);
      seen.add(str);
    }
  }
  for (const k of memberKeys) if (!seen.has(k)) { tokens.push(k); seen.add(k); }
  return tokens;
}

/** Reorder the sockets to a new member sequence, links riding with their value. */
function applyMemberPermutation(node, oldSeq, newSeq) {
  const n = newSeq.length;
  if (oldSeq.length === n && oldSeq.every((k, i) => k === newSeq[i])) return;
  const perm = newSeq.map((k) => oldSeq.indexOf(k));
  if (perm.includes(-1)) return;               // sequences disagree, do nothing
  const graph = node.graph || app.graph;
  const outs = node.outputs || [];
  const moved = perm.map((oldI) => outs[oldI]);
  perm.forEach((oldI, newI) => {
    for (const lid of outs[oldI]?.links || []) {
      const l = graph?.links?.get?.(lid) ?? graph?.links?.[lid];
      if (l) l.origin_slot = newI;
    }
  });
  for (let i = 0; i < n; i++) outs[i] = moved[i];
}

// the LoRA stack's EXACT palette, not an approximation of it: a near-miss palette
// reads as a different pack, which is the opposite of the point
const ROW_COLOURS = [null, "#7f2230", "#7a4416", "#1e5233", "#14514f", "#1d3f6e",
                     "#492a6b", "#6b2450", "#3a3f47"];
const TEXT_COLOURS = [null, "#111316", "#9aa0a8", "#f87171", "#fb923c", "#facc15",
                      "#4ade80", "#60a5fa", "#c084fc", "#f472b6"];

/** Every channel this reader takes: the widget one first, then the panel's extras. */
const readerChannels = (d) =>
  [...new Set([...(d.channel.trim() ? [d.channel.trim()] : []), ...d.channels])];
function writeCfg(node) {
  const w = cfgWidget(node);
  if (w) w.value = JSON.stringify(node._rnCh);
  // channel and publish also exist as real widgets, so the Control Panel and the rest of
  // the wireless system can reach them. Whichever one you touch, the other follows.
  for (const name of ["channel", "publish"]) {
    const wid = (node.widgets || []).find((x) => x?.name === name);
    if (!wid) continue;
    const v = name === "channel" ? node._rnCh.channel : !!node._rnCh.publish;
    if (wid.value !== v) wid.value = v;
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

/** The widgets changed from somewhere else, so bring the panel into line. */
function pullWidgets(node) {
  let moved = false;
  for (const name of ["channel", "publish"]) {
    const wid = (node.widgets || []).find((x) => x?.name === name);
    if (!wid) continue;
    if (name === "channel" && String(wid.value ?? "") !== node._rnCh.channel) {
      node._rnCh.channel = String(wid.value ?? "");
      moved = true;
    } else if (name === "publish" && !!wid.value !== !!node._rnCh.publish) {
      node._rnCh.publish = !!wid.value;
      moved = true;
    }
  }
  if (moved) { const w = cfgWidget(node); if (w) w.value = JSON.stringify(node._rnCh); }
  return moved;
}

/** The channel a node puts its OWN result on, or "" for the nodes that do not. */
export function publishesTo(n) {
  const w = (n?.widgets || []).find((x) => x?.name === "channel_out");
  return String(w?.value || "").trim();
}

/**
 * Every value on every channel, subgraphs included: one row per named Send slot, plus
 * one row per node publishing its own output.
 *
 * Both kinds are members here on purpose. A Receive builds its sockets from this list,
 * so a publisher that were missing would resolve fine at queue time and still have no
 * socket to arrive on.
 */
function allSends(root, out = [], seen = new Set(), path = "", pubs = null) {
  const graph = root || app.graph;
  const top = !pubs;
  if (top) pubs = [];
  if (!graph || seen.has(graph)) return out;
  seen.add(graph);
  for (const n of graph._nodes || []) {
    const ch = publishesTo(n);
    if (ch) {
      pubs.push({ id: `${n.id}`, channel: ch, title: n.title,
                  classType: n.type, node: n, sub: path });
    }
    if (n?.type === SEND) {
      const cfg = readCfg(n);
      cfg.slots.forEach((s, i) => {
        const name = String(s?.name || "").trim();
        if (!name) return;
        out.push({ id: `${n.id}:${i}`, node: n, index: i, channel: cfg.channel.trim(),
                   label: name, type: s?.type || "any", convert: s?.convert || "",
                   sub: path });
      });
    }
    if (n?.subgraph) {
      const title = String(n.title || "subgraph").trim();
      allSends(n.subgraph, out, seen, path ? `${path} / ${title}` : title, pubs);
    }
  }
  // named only once the whole graph has been walked, so the suffix a duplicate title
  // takes does not depend on which subgraph happened to be visited first
  if (top) {
    for (const p of labelPublishers(pubs)) {
      out.push({ id: `${p.id}:out`, node: p.node, index: -1, channel: p.channel,
                 label: p.label, type: p.node?.outputs?.[0]?.type || "*", convert: "",
                 sub: p.sub, publisher: true });
    }
  }
  return out;
}

/** The subgraph a node sits inside, as "outer / inner", or "" at the top level.
 *  This is the ↳ badge: with several subgraphs feeding one channel, which box a
 *  value comes OUT of matters as much as which node made it. */
function subgraphPath(n) {
  const parts = [];
  let g = n?.graph;
  let guard = 0;
  while (g && guard++ < 8) {
    const owner = g._subgraph_node || g.subgraphNode;
    if (!owner) break;
    parts.unshift(String(owner.title || "subgraph").trim());
    g = owner.graph;
  }
  return parts.join(" / ");
}

/** What is really wired into a Send row, and where it came from. */
export function describe(member) {
  // A PUBLISHER has no row and no wire: it puts its own output on the channel, so the
  // node itself is the source and its first output is the type. Looking for a
  // value_0 socket finds nothing and reports the value as unwired, which is wrong in
  // the one place the list is meant to tell you where something came from.
  if (member?.publisher) {
    const n = member.node;
    const out = n?.outputs?.[0];
    return { type: out?.type || null,
             from: String(n?.title || n?.type || "").trim(), src: n, out };
  }
  const slot = (member?.node?.inputs || []).find(
    (i) => i?.name === `value_${member.index + 1}`);
  // "from" is DATA: the name of the node that fed this row, or nothing. It used to
  // carry the phrase "nothing wired in" as a placeholder, and the auto-grouper duly
  // read that as a source node and grouped every empty row under a header called
  // "nothing wired in". A display string never belongs in a field something else
  // reasons about.
  if (!slot?.link) return { type: null, from: "" };
  const graph = member.node.graph || app.graph;
  const link = graph?.links?.get?.(slot.link) ?? graph?.links?.[slot.link];
  if (!link) return { type: null, from: "" };
  const src = graph?.getNodeById?.(link.origin_id);
  const out = src?.outputs?.[link.origin_slot];
  const type = (link.type && link.type !== "*" ? link.type : out?.type) || null;
  return { type, from: String(src?.title || src?.type || "").trim(), src, out };
}

// --------------------------------------------------------------------------- SEND
function renderSend(node) {
  const root = node._rnChRoot;
  if (!root) return;
  const d = node._rnCh;
  if (simpleMode(node)) { renderSimple(node, root); return; }
  root.replaceChildren();

  const head = document.createElement("div");
  head.className = "rn-ch-head";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.textContent = "Channel";
  // A plain box on the Send: this node is where a channel is NAMED, so offering it a
  // list of channels that already exist would be back to front.
  const box = document.createElement("input");
  box.type = "text";
  box.value = d.channel;
  box.placeholder = "name this channel";
  box.title = "The channel these values go on. A channel is a group: several Sends can "
            + "share one and a single Receive picks up all of them.";
  box.style.cssText = "flex:1;min-width:0";
  const commitCh = () => { d.channel = box.value; writeCfg(node); sync(node); };
  box.onchange = commitCh;
  box.onblur = commitCh;
  const pub = document.createElement("button");
  pub.className = "rn-ch-btn" + (d.publish ? " on" : "");
  pub.textContent = d.publish ? "Published" : "Local";
  pub.title = d.publish
    ? "Offered to graphs further out than the one just outside this subgraph."
    : "Belongs to the subgraph it sits in. Two instances of one subgraph cannot then "
    + "fight over the same name. Click to publish it further out.";
  pub.onclick = () => { d.publish = !d.publish; writeCfg(node); sync(node, true); };
  head.append(lab, box, pub, tuckButton(node), simpleButton(node));
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "rn-ch-list";
  if (!d.slots.length) {
    const e = document.createElement("div");
    e.className = "rn-ch-empty";
    e.textContent = "No values yet. Press + below, name it, and a socket appears for it.";
    list.appendChild(e);
  }
  const visSlots = d.slots
    .map((sl, i) => ({ sl, i }))
    .filter((x) => !(x.sl.hidden && !d.showHidden));
  const emitSlot = ({ sl: s, i }, groupFrom) => {
    const wired = describe({ node, index: i });
    const off = s.on === false;
    const shown = s.type && s.type !== "any" ? s.type : wired.type;
    const colour = off ? "#6b7280" : colourFor(shown);
    const row = document.createElement("div");
    row.className = "rn-ch-row";
    if (off || s.hidden) row.style.opacity = ".45";
    if (s.color) row.style.background = s.color;

    // same anatomy as the reader: grip, eye at the front, bar, then the content
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("rn-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("rn-drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("rn-drop");
      const from = node._rnChFrom;
      node._rnChFrom = null;
      if (typeof from === "number" && from !== i) moveSlot(node, d, from, i);
    });
    const grip = document.createElement("span");
    grip.className = "rn-ch-grip";
    grip.textContent = "⋮⋮";
    grip.title = "drag to reorder. The wire follows its row.";
    grip.draggable = true;
    grip.addEventListener("dragstart", (e) => {
      node._rnChFrom = i;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(row, 10, 10);
    });
    const eye = document.createElement("button");
    eye.className = "rn-ch-eye";
    eye.textContent = off ? "—" : "👁";
    eye.style.color = off ? "#666" : "#8fb4ff";
    eye.title = off
      ? "off for EVERY reader: this value is simply not on the channel. Click to "
        + "switch it back on."
      : "on. Click to take this value off the channel for every reader; whatever was "
        + "reading it is skipped at queue time, silently.";
    eye.onclick = (e) => {
      e.stopPropagation();
      s.on = off;
      writeCfg(node);
      sync(node, true);
    };
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.background = colour;

    const nm = document.createElement("input");
    nm.className = "nm";
    nm.type = "text";
    nm.value = s.name || "";
    nm.placeholder = "what is it";
    nm.title = "The name the reader shows. Leave it empty and it fills itself in from "
             + "whatever you wire in."
             + (groupFrom ? ` Grouped under ${groupFrom}.` : "");
    if (s.textColor) nm.style.color = s.textColor;
    nm.onchange = () => { s.name = nm.value; writeCfg(node); sync(node); };

    const ty = document.createElement("select");
    ty.className = "ty";
    for (const t of TYPES) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      o.selected = (s.type || "any") === t;
      ty.appendChild(o);
    }
    ty.title = "any connects to anything and is the safe default. Naming a type makes "
             + "the socket refuse the wrong wire instead of failing at run time.";
    ty.onchange = () => { s.type = ty.value; writeCfg(node); sync(node); };

    const cv = document.createElement("select");
    cv.className = "cv";
    for (const c of CONVERSIONS) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c || "as is";
      o.selected = (s.convert || "") === c;
      cv.appendChild(o);
    }
    cv.title = "Convert on the way through: a string into an int, an int into a float. "
             + "Only the simple types convert; an image into an int still cannot work "
             + "and says so.";
    cv.onchange = () => { s.convert = cv.value; writeCfg(node); sync(node); };

    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = `${i + 1}`;
    pin.title = `socket ${i + 1} on the left`;

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "remove this value";
    x.onclick = () => { d.slots.splice(i, 1); writeCfg(node); sync(node, true); };

    row.append(grip, eye, bar, nm, ty, cv, pin, x);
    row.title = "Right click for colours and off/on.";
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSendRowMenu(node, s, e);
    };
    list.appendChild(row);
  };
  for (const grp of autoGroups(visSlots,
      (x) => describe({ node, index: x.i }).from)) {
    if (grp.header) {
      const h = document.createElement("div");
      h.className = "rn-ch-row rn-ch-title rn-ch-auto";
      const t = document.createElement("span");
      t.className = "ro";
      t.textContent = `${grp.header}  (${grp.rows.length})`;
      t.title = "grouped automatically because these all come from this node";
      h.appendChild(t);
      list.appendChild(h);
    }
    for (const x of grp.rows) emitSlot(x, grp.header);
  }
  root.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "rn-ch-foot";
  const add = document.createElement("button");
  add.className = "rn-ch-btn";
  add.textContent = "+";
  add.title = "add a value to this channel";
  add.disabled = d.slots.length >= MAX;
  if (add.disabled) add.title = `${MAX} is the ceiling; ComfyUI builds sockets from a `
                             + `static declaration, so there has to be one somewhere.`;
  add.onclick = () => {
    if (d.slots.length >= MAX) return;
    d.slots.push({ name: "", type: "any", convert: "" });
    writeCfg(node);
    sync(node);
  };
  const note = document.createElement("span");
  note.style.flex = "1";
  const offCount = d.slots.filter((x) => x.on === false).length;
  const hiddenTotal = d.slots.filter((x) => x.hidden).length;
  note.textContent = d.slots.length
    ? `${d.slots.length} on "${d.channel || "(name the channel)"}"`
      + (offCount ? `, ${offCount} off` : "")
      + (hiddenTotal ? `, ${hiddenTotal} hidden` : "")
    : "";
  foot.append(add, note);
  if (hiddenTotal) {
    const show = document.createElement("button");
    show.className = "rn-ch-btn" + (d.showHidden ? " on" : "");
    show.textContent = d.showHidden ? "Hide hidden" : `Show hidden (${hiddenTotal})`;
    show.title = d.showHidden
      ? "tuck the hidden rows back out of sight"
      : "show the hidden rows so they can be changed or unhidden. List only: their "
      + "sockets and wires work either way.";
    show.onclick = () => {
      d.showHidden = !d.showHidden;
      writeCfg(node);
      sync(node, true);
    };
    foot.appendChild(show);
  }
  root.appendChild(foot);
}

/** The row menu, in the same language as the LoRA stack and the Control Panel: row
 *  colour, text colour, a name for this panel, and off/on. One menu to learn, not
 *  three. Applies to the whole selection when the clicked row is part of one. */
function openChannelRowMenu(node, m, ev) {
  document.querySelector(".rn-ch-menu")?.remove();
  const d = node._rnCh;
  const selection = node._rnChSel || new Set();
  const keys = selection.has(m.key) && selection.size > 1 ? [...selection] : [m.key];
  const menu = document.createElement("div");
  menu.className = "rn-ch-menu";
  for (const t of ["pointerdown", "pointerup", "click", "contextmenu", "keydown"]) {
    menu.addEventListener(t, (e) => e.stopPropagation());
  }
  const apply = (fn) => {
    for (const k of keys) fn(k);
    writeCfg(node);
    sync(node, true);
  };
  const swatches = (title, colours, pick) => {
    const h = document.createElement("h5");
    h.textContent = title + (keys.length > 1 ? ` (${keys.length} rows)` : "");
    const sw = document.createElement("div");
    sw.className = "sw";
    for (const c of colours) {
      const dot = document.createElement("div");
      dot.style.background = c || "transparent";
      if (!c) { dot.style.border = "2px dashed #555"; dot.title = "none"; }
      dot.onclick = () => { apply((k) => pick(k, c)); menu.remove(); };
      sw.appendChild(dot);
    }
    return [h, sw];
  };
  const styleOf = (k) => (d.style[k] ||= {});
  const tidy = (k) => { if (!Object.keys(d.style[k] || {}).length) delete d.style[k]; };
  menu.append(...swatches("Row colour", ROW_COLOURS, (k, c) => {
    if (c) styleOf(k).row = c; else { delete styleOf(k).row; tidy(k); }
  }));
  menu.append(...swatches("Text colour", TEXT_COLOURS, (k, c) => {
    if (c) styleOf(k).text = c; else { delete styleOf(k).text; tidy(k); }
  }));

  const h = document.createElement("h5");
  h.textContent = "Name on this panel";
  const box = document.createElement("input");
  box.type = "text";
  box.value = (d.style[m.key] || {}).name || "";
  box.placeholder = m.label;
  box.title = "Shown here instead of the label. The label itself stays as it is, so "
            + "the pairing with the Send never breaks.";
  box.onchange = () => {
    const v = box.value.trim();
    if (v) styleOf(m.key).name = v;
    else { delete styleOf(m.key).name; tidy(m.key); }
    writeCfg(node);
    sync(node, true);
  };
  menu.append(h, box);

  const addTitle = (after) => {
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    d.titles[id] = { name: "Group" };
    const memberKeys = memberView(allSends(), readerChannels(d), d.order)
      .map((x) => x.key);
    const tokens = channelTokens(d, memberKeys);
    const at = tokens.indexOf(m.key);
    tokens.splice(at < 0 ? tokens.length : at + (after ? 1 : 0), 0, `t:${id}`);
    d.order = tokens;
    writeCfg(node);
    sync(node, true);
  };
  const t1 = document.createElement("button");
  t1.textContent = "Add group title above";
  t1.onclick = () => { addTitle(false); menu.remove(); };
  const t2 = document.createElement("button");
  t2.textContent = "Add group title below";
  t2.onclick = () => { addTitle(true); menu.remove(); };
  menu.append(t1, t2);

  const off = !!d.muted[m.key];
  const toggle = document.createElement("button");
  toggle.textContent = (off ? "Switch on" : "Switch off")
                     + (keys.length > 1 ? ` (${keys.length} rows)` : "");
  toggle.onclick = () => {
    apply((k) => { if (off) delete d.muted[k]; else d.muted[k] = true; });
    menu.remove();
  };
  menu.appendChild(toggle);

  // hiding a reader row removes its SOCKET too, wire and all: hiding means you do
  // not want a line there. Unhide and the socket returns for reattaching.
  const isHidden = !!d.hidden[m.key];
  const hide = document.createElement("button");
  hide.textContent = (isHidden ? "Unhide" : "Hide")
                   + (keys.length > 1 ? ` (${keys.length} rows)` : "");
  hide.title = isHidden
    ? "bring this row back, and its socket with it, ready to rewire"
    : "hide this row AND its socket. Any wire on it is disconnected, deliberately: "
    + "hiding means you do not want a line there. The Show hidden button at the "
    + "bottom brings it back.";
  hide.onclick = () => {
    apply((k) => { if (isHidden) delete d.hidden[k]; else d.hidden[k] = true; });
    menu.remove();
  };
  menu.appendChild(hide);

  // selection lives HERE, not as a mode button crowding the head
  const selHead = document.createElement("h5");
  selHead.textContent = "Selection";
  menu.appendChild(selHead);
  const selBtn = document.createElement("button");
  const inSel = selection.has(m.key);
  selBtn.textContent = inSel ? "Deselect this row" : "Select this row";
  selBtn.title = "Selected rows change together: colours, names, off, hide. Ctrl "
               + "click on rows does the same without the menu.";
  selBtn.onclick = () => {
    if (inSel) selection.delete(m.key);
    else selection.add(m.key);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(selBtn);
  if (selection.size) {
    const clear = document.createElement("button");
    clear.textContent = `Clear selection (${selection.size})`;
    clear.onclick = () => { selection.clear(); sync(node, true); menu.remove(); };
    menu.appendChild(clear);
  }

  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 8)}px`;
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

/** The automatic header's menu: the same dressing a manual title gets, plus the way
 *  to GRADUATE into one. An auto header's position is derived from its rows, so
 *  moving it means making it real first, and the menu says exactly that. */
function openAutoMenu(node, from, ev, convert) {
  document.querySelector(".rn-ch-menu")?.remove();
  const d = node._rnCh;
  const st = (d.autoStyle[from] ||= {});
  const menu = document.createElement("div");
  menu.className = "rn-ch-menu";
  for (const t of ["pointerdown", "pointerup", "click", "contextmenu", "keydown"]) {
    menu.addEventListener(t, (e) => e.stopPropagation());
  }
  const swatches = (title, colours, key) => {
    const h = document.createElement("h5");
    h.textContent = title;
    const sw = document.createElement("div");
    sw.className = "sw";
    for (const c of colours) {
      const dot = document.createElement("div");
      dot.style.background = c || "transparent";
      if (!c) { dot.style.border = "2px dashed #555"; dot.title = "none"; }
      if ((st[key] || null) === c) dot.style.borderColor = "#fff";
      dot.onclick = () => {
        if (c) st[key] = c; else delete st[key];
        writeCfg(node);
        sync(node, true);
        menu.remove();
      };
      sw.appendChild(dot);
    }
    return [h, sw];
  };
  menu.append(...swatches("Row colour", ROW_COLOURS, "color"));
  menu.append(...swatches("Text colour", TEXT_COLOURS, "text"));
  const fold = document.createElement("button");
  fold.textContent = st.collapsed ? "Expand" : "Collapse";
  fold.title = "fold this group to its header. Clicking the header does the same.";
  fold.onclick = () => {
    st.collapsed = !st.collapsed;
    writeCfg(node);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(fold);
  if (convert) {
    const mk = document.createElement("button");
    mk.textContent = "Make this a real title";
    mk.title = "An automatic header follows its rows around, so it cannot be moved or "
             + "renamed. This turns it into a title of your own, which can.";
    mk.onclick = () => { convert(); menu.remove(); };
    menu.appendChild(mk);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 8)}px`;
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

/** Rename, colour or remove a group title. Same shape as the row menu. */
function openTitleMenu(node, tok, ev) {
  document.querySelector(".rn-ch-menu")?.remove();
  const d = node._rnCh;
  const id = tok.slice(2);
  const t = d.titles[id] || (d.titles[id] = { name: "Group" });
  const menu = document.createElement("div");
  menu.className = "rn-ch-menu";
  for (const evt of ["pointerdown", "pointerup", "click", "contextmenu", "keydown"]) {
    menu.addEventListener(evt, (e) => e.stopPropagation());
  }
  const h = document.createElement("h5");
  h.textContent = "Group title";
  const box = document.createElement("input");
  box.type = "text";
  box.value = t.name || "";
  box.placeholder = "name this group";
  box.onchange = () => {
    t.name = box.value.trim() || "Group";
    writeCfg(node);
    sync(node, true);
  };
  menu.append(h, box);
  const hc = document.createElement("h5");
  hc.textContent = "Colour";
  const sw = document.createElement("div");
  sw.className = "sw";
  for (const c of ROW_COLOURS) {
    const dot = document.createElement("div");
    dot.style.background = c || "transparent";
    if (!c) { dot.style.border = "2px dashed #555"; dot.title = "none"; }
    dot.onclick = () => {
      if (c) t.color = c; else delete t.color;
      writeCfg(node);
      sync(node, true);
      menu.remove();
    };
    sw.appendChild(dot);
  }
  menu.append(hc, sw);
  const ht = document.createElement("h5");
  ht.textContent = "Text colour";
  const swt = document.createElement("div");
  swt.className = "sw";
  for (const c of TEXT_COLOURS) {
    const dot = document.createElement("div");
    dot.style.background = c || "transparent";
    if (!c) { dot.style.border = "2px dashed #555"; dot.title = "none"; }
    if ((t.textColor || null) === c) dot.style.borderColor = "#fff";
    dot.onclick = () => {
      if (c) t.textColor = c; else delete t.textColor;
      writeCfg(node);
      sync(node, true);
      menu.remove();
    };
    swt.appendChild(dot);
  }
  menu.append(ht, swt);
  const fold = document.createElement("button");
  fold.textContent = t.collapsed ? "Expand" : "Collapse";
  fold.title = "fold this group to one line. Clicking the title does the same.";
  fold.onclick = () => {
    t.collapsed = !t.collapsed;
    writeCfg(node);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(fold);
  const del = document.createElement("button");
  del.textContent = "Remove this title";
  del.title = "removes only the title line; the values under it stay";
  del.onclick = () => {
    d.order = (d.order || []).filter((x) => String(x) !== tok);
    delete d.titles[id];
    writeCfg(node);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(del);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 8)}px`;
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

/** Reorder the Send's rows. The wires follow by RENAMING: the prompt reads inputs by
 *  name, so the input that fed old row N is renamed value_{newN+1} and its wire never
 *  moves at all. Two-phase, or the renames collide with each other. */
function moveSlot(node, d, from, to) {
  const perm = [...Array(d.slots.length).keys()];
  const [x] = perm.splice(from, 1);
  perm.splice(to, 0, x);                        // perm[newI] = oldI
  const ins = node.inputs || [];
  perm.forEach((oldI, newI) => {
    const obj = ins.find((inp) => inp?.name === `value_${oldI + 1}`);
    if (obj) obj._rnNewName = `value_${newI + 1}`;
  });
  for (const obj of ins) {
    if (obj?._rnNewName) { obj.name = obj._rnNewName; delete obj._rnNewName; }
  }
  const [sl] = d.slots.splice(from, 1);
  d.slots.splice(to, 0, sl);
  writeCfg(node);
  sync(node, true);
}

/** The Send row's menu: the same shape as the reader's, minus what has no meaning
 *  here (group titles come from the auto grouping, selection has no mass ops yet). */
function openSendRowMenu(node, s, ev) {
  document.querySelector(".rn-ch-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "rn-ch-menu";
  for (const t of ["pointerdown", "pointerup", "click", "contextmenu", "keydown"]) {
    menu.addEventListener(t, (e) => e.stopPropagation());
  }
  const swatches = (title, colours, get, set) => {
    const h = document.createElement("h5");
    h.textContent = title;
    const sw = document.createElement("div");
    sw.className = "sw";
    for (const c of colours) {
      const dot = document.createElement("div");
      dot.style.background = c || "transparent";
      if (!c) { dot.style.border = "2px dashed #555"; dot.title = "none"; }
      if ((get() || null) === c) dot.style.borderColor = "#fff";
      dot.onclick = () => {
        set(c || undefined);
        writeCfg(node);
        sync(node, true);
        menu.remove();
      };
      sw.appendChild(dot);
    }
    return [h, sw];
  };
  menu.append(...swatches("Row colour", ROW_COLOURS,
    () => s.color, (v) => { s.color = v; }));
  menu.append(...swatches("Text colour", TEXT_COLOURS,
    () => s.textColor, (v) => { s.textColor = v; }));
  const off = s.on === false;
  const toggle = document.createElement("button");
  toggle.textContent = off ? "Switch on" : "Switch off";
  toggle.title = "Off takes this value off the channel for EVERY reader; whatever was "
               + "reading it is skipped at queue time, silently.";
  toggle.onclick = () => {
    s.on = off;
    writeCfg(node);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(toggle);
  const hide = document.createElement("button");
  hide.textContent = s.hidden ? "Unhide" : "Hide";
  hide.title = s.hidden
    ? "bring this row back into the list"
    : "hide this row from the LIST only. The socket and its wire are untouched and "
    + "keep working; this is for keeping a long panel readable. The Show hidden "
    + "button at the bottom brings it back.";
  hide.onclick = () => {
    s.hidden = !s.hidden;
    writeCfg(node);
    sync(node, true);
    menu.remove();
  };
  menu.appendChild(hide);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 8)}px`;
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ------------------------------------------------------------------------ RECEIVE
function renderReceive(node) {
  const root = node._rnChRoot;
  if (!root) return;
  const d = node._rnCh;
  if (simpleMode(node)) { renderSimple(node, root); return; }
  root.replaceChildren();

  const head = document.createElement("div");
  head.className = "rn-ch-head";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.textContent = "Channels";
  const box = channelField(node, d, (v) => {
    // the first channel lives in the real widget, so the Control Panel can drive it;
    // any further ones go in the panel's own list
    const name = String(v || "").trim();
    if (!name) return;
    if (!d.channel.trim()) d.channel = name;
    else if (!readerChannels(d).includes(name)) d.channels.push(name);
    writeCfg(node);
    sync(node, true);
  });
  head.append(lab, box, tuckButton(node), simpleButton(node));
  root.appendChild(head);

  // One reader, several channels: pick them all up here and build your own output set
  // from the lot, rather than one Receive per channel.
  const taken = readerChannels(d);
  if (taken.length) {
    const chipsRow = document.createElement("div");
    chipsRow.className = "rn-ch-head";
    chipsRow.style.flexWrap = "wrap";
    for (const ch of taken) {
      const chip = document.createElement("button");
      chip.className = "rn-ch-btn on";
      chip.textContent = `${ch} ✕`;
      chip.title = `reading "${ch}". Click to stop.`;
      chip.onclick = () => {
        if (d.channel.trim() === ch) d.channel = "";
        d.channels = d.channels.filter((c) => c !== ch);
        // promote the next extra into the widget so the Control Panel still sees one
        if (!d.channel.trim() && d.channels.length) d.channel = d.channels.shift();
        writeCfg(node);
        sync(node, true);
      };
      chipsRow.appendChild(chip);
    }
    root.appendChild(chipsRow);
  }

  const view = memberView(allSends(), taken, d.order);
  const list = document.createElement("div");
  list.className = "rn-ch-list";
  if (!taken.length) {
    const e = document.createElement("div");
    e.className = "rn-ch-empty";
    e.textContent = "Pick a channel above, or several. Everything any RedNode Channel "
                  + "Send puts on them is listed here, from anywhere in the workflow, "
                  + "and the sockets on the right are your own output set: right click "
                  + "a row to switch it off, use the arrows to arrange them.";
    list.appendChild(e);
  } else if (!view.length) {
    const e = document.createElement("div");
    e.className = "rn-ch-empty";
    e.textContent = `Nothing is sending to "${taken.join('", "')}" yet. Put a RedNode `
                  + `Sender on one of those names, anywhere, and it appears here.`;
    list.appendChild(e);
  }
  // The same four actions the node's right click offers. They live here so the panel
  // has them too: a cog in the corner is closer than a right click on the title bar,
  // and this is a list you work in rather than glance at.
  const listActions = () => {
    const chans = readerChannels(d);
    const sends = allSends();
    const arrange = (mode) => {
      let seq;
      if (mode === "input") {
        seq = [];
        for (const ch of chans) {
          for (const m of sends) {
            if (String(m.channel || "").trim() === ch) seq.push(`${ch}/${m.label}`);
          }
        }
        seq = [...new Set(seq)];
      } else {
        seq = memberView(sends, chans, null)
          .slice()
          .sort((a, b) => String(a.label).localeCompare(String(b.label))
                       || String(a.id).localeCompare(String(b.id)))
          .map((m) => m.key);
      }
      const cur = channelTokens(d, memberView(sends, chans, d.order).map((m) => m.key));
      let mi = 0;
      d.order = cur.map((t) => (t.startsWith("t:") ? t : (seq[mi++] ?? t)));
      writeCfg(node);
      sync(node, true);
    };
    const sweep = (on) => {
      if (!on) { d.hidden = {}; d.showHidden = false; writeCfg(node); sync(node, true); return; }
      const keys = socketOrder(memberView(sends, chans, d.order), d.hidden)
        .map((m) => m.key);
      for (let i = 0; i < keys.length; i++) {
        if (!(((node.outputs || [])[i]?.links || []).length)) d.hidden[keys[i]] = true;
      }
      d.showHidden = false;
      writeCfg(node);
      sync(node, true);
    };
    return [
      ["Hide every value with no wire", () => sweep(true)],
      ["Show all hidden values", () => sweep(false)],
      ["Arrange values in Send order", () => arrange("input")],
      ["Arrange values alphabetically", () => arrange("alpha")],
    ];
  };

  const memberKeys = view.map((m) => m.key);
  const tokens = channelTokens(d, memberKeys);
  // Everything moves as TOKENS, so a dragged row can land between a title and its
  // group, and a dragged title carries its position without touching any socket. The
  // wires move with their value: the member sequence before and after decides the
  // permutation, and every link on every shifted socket is re-pointed. Without that,
  // reordering silently hands every consumer a different value, which is the mess
  // that makes people afraid to touch a working graph.
  const moveToken = (fromTok, toTok) => {
    if (fromTok === toTok) return;
    const arr = tokens.slice();
    const fi = arr.indexOf(fromTok);
    if (fi < 0) return;
    arr.splice(fi, 1);
    const ti = arr.indexOf(toTok);
    if (ti < 0) return;
    arr.splice(ti, 0, fromTok);                // take the target's place
    applyMemberPermutation(node,
      tokens.filter((t) => !t.startsWith("t:")),
      arr.filter((t) => !t.startsWith("t:")));
    d.order = arr;
    writeCfg(node);
    sync(node, true);
  };
  const dragTarget = (row, tok) => {
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("rn-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("rn-drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("rn-drop");
      const from = node._rnChFrom;
      node._rnChFrom = null;
      if (from && from !== tok) moveToken(from, tok);
    });
  };
  const makeGrip = (row, tok) => {
    const grip = document.createElement("span");
    grip.className = "rn-ch-grip";
    grip.textContent = "⋮⋮";
    grip.title = "drag to reorder. The wires move with their value.";
    grip.draggable = true;
    grip.addEventListener("dragstart", (e) => {
      node._rnChFrom = tok;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(row, 10, 10);
    });
    return grip;
  };
  const selection = (node._rnChSel ||= new Set());
  // members between a title and the next title are its GROUP; the title's eye flips
  // them all in one click, which is the reason titles exist
  const groupKeysOf = (titleTok) => {
    const at = tokens.indexOf(titleTok);
    const keys = [];
    for (let t = at + 1; t < tokens.length; t++) {
      if (tokens[t].startsWith("t:")) break;
      keys.push(tokens[t]);
    }
    return keys;
  };
  const emitTitle = (tok, into) => {
    const t = d.titles[tok.slice(2)] || {};
    const row = document.createElement("div");
    row.className = "rn-ch-row rn-ch-title";
    if (t.color) row.style.background = t.color;
    dragTarget(row, tok);
    const grip = makeGrip(row, tok);
    const keys = groupKeysOf(tok);
    const anyOn = keys.some((k) => !d.muted[k]);
    const eye = document.createElement("button");
    eye.className = "rn-ch-eye";
    eye.textContent = anyOn ? "👁" : "—";
    eye.style.color = anyOn ? "#8fb4ff" : "#666";
    eye.title = anyOn
      ? `switch off every value in this group (${keys.length})`
      : `switch this group's ${keys.length} value(s) back on`;
    eye.onclick = (e) => {
      e.stopPropagation();
      for (const k of keys) {
        if (anyOn) d.muted[k] = true;
        else delete d.muted[k];
      }
      writeCfg(node);
      sync(node, true);
    };
    const fold = document.createElement("button");
    fold.className = "rn-ch-fold";
    fold.textContent = t.collapsed ? "\u25b8" : "\u25be";
    fold.title = t.collapsed ? "unfold this group" : "fold this group to one line";
    fold.onclick = (e) => {
      e.stopPropagation();
      t.collapsed = !t.collapsed;
      writeCfg(node);
      sync(node, true);
    };
    const nm = document.createElement("span");
    nm.className = "ro";
    nm.textContent = (t.name || "Group") + (t.collapsed ? `  (${keys.length})` : "");
    if (t.textColor) nm.style.color = t.textColor;
    row.append(grip, fold, eye, nm);
    row.title = "A group title. Click to fold or unfold its group; the eye flips every "
              + "value beneath it, down to the next title. Right click to rename, "
              + "colour or remove it.";
    row.onclick = (e) => {
      if (e.target.closest("button,input")) return;
      t.collapsed = !t.collapsed;
      writeCfg(node);
      sync(node, true);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTitleMenu(node, tok, e);
    };
    (into || list).appendChild(row);
  };
  const sockKeys = socketOrder(view, d.hidden).map((x) => x.key);
  const emitMember = (m, sockIdx, groupFrom, into) => {
    const w = describe(m);
    const off = !!d.muted[m.key];
    const style = d.style[m.key] || {};
    const shown = m.type && m.type !== "any" ? m.type : w.type;
    const colour = off ? "#6b7280" : colourFor(shown);
    const row = document.createElement("div");
    row.className = "rn-ch-row" + (selection.has(m.key) ? " sel" : "")
                  + (off ? " off" : "");
    if (style.row) row.style.background = style.row;
    dragTarget(row, m.key);

    // the row anatomy is the pack's one spec: grip, EYE AT THE FRONT, then the type
    // bar and the content, same order on every node. Selection lives on ctrl click
    // and in the right click menu, not in a mode.
    const grip = makeGrip(row, m.key);
    const eye = document.createElement("button");
    eye.className = "rn-ch-eye";
    eye.textContent = off ? "—" : "👁";
    eye.title = off
      ? "off: whatever reads this socket is skipped at queue time, silently. Click to "
        + "switch it back on."
      : "on. Click to switch this value off; whatever reads its socket then simply "
        + "does not run: no value, no error.";
    eye.onclick = (e) => {
      e.stopPropagation();
      const keys = selection.has(m.key) && selection.size > 1
        ? [...selection] : [m.key];
      for (const k of keys) {
        if (off) delete d.muted[k];
        else d.muted[k] = true;
      }
      writeCfg(node);
      sync(node, true);
    };
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.background = colour;
    const nm = document.createElement("span");
    nm.className = "ro";
    const base = style.name
      || (groupFrom ? shortLabel(m.label, groupFrom) : m.label);
    nm.textContent = (d.hidden[m.key] ? "(hidden) " : "") + base;
    if (style.text) nm.style.color = style.text;
    if (style.name) nm.title = `really "${m.label}"`;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = (shown || "any") + (m.convert ? ` → ${m.convert}` : "");
    chip.style.color = colour;
    chip.style.background = `${colour}22`;
    const inSub = m.sub || subgraphPath(m.node);
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = [inSub ? `\u21b3 ${inSub}` : "",
                       taken.length > 1 ? m.channel : "", w.from]
      .filter(Boolean).join(" \u00b7 ");
    src.title = (w.from ? `wired from ${w.from} on "${m.channel}"` : "")
              + (inSub ? `, inside the subgraph ${inSub}` : "");
    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = sockIdx >= 0 && sockIdx < (node.outputs || []).length
      ? `${sockIdx + 1}` : "–";
    pin.title = pin.textContent === "–"
      ? "hidden and unwired, so its socket is gone until it is unhidden"
      : `comes out of socket ${pin.textContent} on the right`;
    row.append(grip, eye, bar, nm, chip, src, pin);
    row.title = "Right click for colours, a custom name, group titles, hide and "
              + "off/on. Ctrl click to select several rows and change them together.";
    row.addEventListener("click", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.target.closest("button,input,select")) return;
      if (selection.has(m.key)) selection.delete(m.key);
      else selection.add(m.key);
      sync(node, true);
    });
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openChannelRowMenu(node, m, e);
    };
    (into || list).appendChild(row);
  };
  // manual titles first; inside every stretch between them, runs from one source
  // node group themselves under that node's name, and their rows drop the shared
  // prefix. Nobody typed any of it: the graph already knew where everything came from.
  const entries = [];
  let memberIdx = 0;
  for (const tok of tokens) {
    if (tok.startsWith("t:")) { entries.push({ title: tok }); continue; }
    const m = view[memberIdx];
    memberIdx++;
    // a hidden row has no socket; Show hidden lists it so it can be unhidden
    if (d.hidden[m.key] && !d.showHidden) continue;
    entries.push({ m });
  }
  // a group is a PHYSICAL box: the header row at its top, the member rows framed
  // inside it, exactly the shape Group Control draws. emitTitle and the emitters
  // append to whatever container is current.
  let container = list;
  const openBox = () => {
    const box = document.createElement("div");
    box.className = "rn-ch-box";
    list.appendChild(box);
    return box;
  };
  let at = 0;
  while (at < entries.length) {
    if (entries[at].title) {
      const tok = entries[at].title;
      container = openBox();
      emitTitle(tok, container);
      at++;
      if (d.titles[tok.slice(2)]?.collapsed) {
        // a folded title swallows its whole group, down to the next title
        while (at < entries.length && !entries[at].title) at++;
        container = list;
      }
      continue;
    }
    let runEnd = at;
    while (runEnd < entries.length && !entries[runEnd].title) runEnd++;
    const run = entries.slice(at, runEnd);
    for (const grp of autoGroups(run, (x) =>
        d.autoStyle[describe(x.m).from]?.manual ? "" : describe(x.m).from)) {
      if (grp.header) {
        const st = d.autoStyle[grp.header] || {};
        const h = document.createElement("div");
        h.className = "rn-ch-row rn-ch-title rn-ch-auto";
        if (st.color) h.style.background = st.color;
        const keys = grp.rows.map((x) => x.m.key);
        const anyOn = keys.some((k) => !d.muted[k]);
        const fold = document.createElement("button");
        fold.className = "rn-ch-fold";
        fold.textContent = st.collapsed ? "\u25b8" : "\u25be";
        fold.title = st.collapsed ? "unfold this group" : "fold this group to one line";
        fold.onclick = (e) => {
          e.stopPropagation();
          st.collapsed = !st.collapsed;
          d.autoStyle[grp.header] = st;
          writeCfg(node);
          sync(node, true);
        };
        const eye = document.createElement("button");
        eye.className = "rn-ch-eye";
        eye.textContent = anyOn ? "👁" : "—";
        if (!anyOn) eye.style.color = "#ff7b86";
        eye.title = anyOn
          ? `switch off everything from ${grp.header} (${keys.length})`
          : `switch ${grp.header}'s ${keys.length} value(s) back on`;
        eye.onclick = (e) => {
          e.stopPropagation();
          for (const k of keys) {
            if (anyOn) d.muted[k] = true;
            else delete d.muted[k];
          }
          writeCfg(node);
          sync(node, true);
        };
        const t = document.createElement("span");
        t.className = "ro";
        t.textContent = `${grp.header}  (${keys.length})`;
        if (st.text) t.style.color = st.text;
        t.title = "grouped automatically because these all come from this node. Click "
                + "to fold; right click for colours or to make it a real title.";
        h.append(fold, eye, t);
        h.onclick = (e) => {
          if (e.target.closest("button")) return;
          st.collapsed = !st.collapsed;
          d.autoStyle[grp.header] = st;
          writeCfg(node);
          sync(node, true);
        };
        h.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openAutoMenu(node, grp.header, e, () => {
            // graduate: a manual title lands above the run carrying the dressing,
            // and this source stops auto-grouping so its rows sit under it loose
            const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
            d.titles[id] = { name: grp.header,
                             ...(st.color ? { color: st.color } : {}),
                             ...(st.text ? { textColor: st.text } : {}) };
            const toks = channelTokens(d, view.map((x) => x.key));
            const first = toks.indexOf(keys[0]);
            toks.splice(first < 0 ? toks.length : first, 0, `t:${id}`);
            d.order = toks;
            d.autoStyle[grp.header] = { manual: true };
            writeCfg(node);
            sync(node, true);
          });
        };
        // an auto group OUTSIDE a title gets its own box; inside one it stays a
        // header line, because a box in a box is noise
        const target = container === list ? openBox() : container;
        target.appendChild(h);
        if (st.collapsed) continue;
        for (const x of grp.rows) {
          emitMember(x.m, sockKeys.indexOf(x.m.key), grp.header, target);
        }
        continue;
      }
      for (const x of grp.rows) {
        emitMember(x.m, sockKeys.indexOf(x.m.key), grp.header, container);
      }
    }
    at = runEnd;
  }
  root.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "rn-ch-foot";
  const offCount = view.filter((m) => d.muted[m.key]).length;
  const hiddenTotal = view.filter((m) => d.hidden[m.key]).length;
  const cog = document.createElement("button");
  cog.className = "rn-ch-btn";
  cog.textContent = "⚙";
  cog.title = "list actions: hide the unwired, show everything, rearrange";
  cog.onclick = (e) => {
    e.stopPropagation();
    document.querySelector(".rn-ch-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "rn-ch-menu";
    for (const t of ["pointerdown", "pointerup", "click", "contextmenu", "keydown"]) {
      menu.addEventListener(t, (ev) => ev.stopPropagation());
    }
    for (const [label, run] of listActions()) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => { run(); menu.remove(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 8)}px`;
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  };
  const note = document.createElement("span");
  note.style.flex = "1";
  note.textContent = view.length
    ? `${view.length} value(s) from ${taken.length} channel(s)`
      + (offCount ? `, ${offCount} off` : "")
      + (hiddenTotal ? `, ${hiddenTotal} hidden` : "") + ", in socket order"
    : "";
  foot.appendChild(note);
  foot.appendChild(cog);
  if (hiddenTotal) {
    const show = document.createElement("button");
    show.className = "rn-ch-btn" + (d.showHidden ? " on" : "");
    show.textContent = d.showHidden ? "Hide hidden" : `Show hidden (${hiddenTotal})`;
    show.title = d.showHidden
      ? "tuck the hidden rows back out of sight"
      : "show the hidden rows so they can be unhidden. A hidden row has no socket "
      + "until it comes back.";
    show.onclick = () => {
      d.showHidden = !d.showHidden;
      writeCfg(node);
      sync(node, true);
    };
    foot.appendChild(show);
  }
  root.appendChild(foot);
}

// ------------------------------------------------------------------------- sockets
function sync(node, force = false) {
  const isSend = node.type === SEND;
  const d = node._rnCh;

  // Newer frontends draw an input dot for EVERY widget, hidden ones included, so the
  // hidden config widget leaks an unlabelled socket that sits at the top of the node and
  // cannot be seen or used. The same fix as rednode_workspace.js: strip those dots on
  // every sync. The widget itself, and its serialisation, are untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "config") node.inputs.splice(i, 1);
  }
  let structural = false;                      // sockets came or went this pass
  if (isSend) {
    // Fill in a name from whatever got wired in, so nobody types one unless they want
    // to. Each row remembers what the panel last wrote (s.auto), which is what lets a
    // REWIRE rename the row: a name the panel wrote is the panel's to keep current, a
    // name the user typed is theirs forever, and without the memory those are just two
    // indistinguishable strings.
    let renamed = false;
    d.slots.forEach((s, i) => {
      const w = describe({ node, index: i });
      if (!w.src) return;
      const auto = deriveLabel({
        title: w.src.title, type: w.src.type,
        // The LABEL first, then the name. A socket's name is its internal handle,
        // "value_21" on a Receive; its label is what the node put there for a human
        // to read. Reading the name gave "RedNode Channel In value_21" when the
        // socket was plainly saying "style_strength" right next to it.
        slot: (() => {
          const lbl = String(w.out?.label || "").trim();
          if (lbl && lbl !== " ") return lbl;
          return w.out?.name && w.out.name !== "*" ? w.out.name : (w.out?.type || "");
        })(),
      });
      const next = nextAutoName(s.name, s.auto, auto);
      if (next) { s.name = next; s.auto = next; renamed = true; }
      else if (auto && String(s.name || "").trim() === auto && s.auto !== auto) {
        s.auto = auto;                         // adopt a pre-memory auto name
        renamed = true;
      }
    });
    if (renamed) writeCfg(node);

    // An unnamed channel cannot be subscribed to, and forgetting to name one is the
    // easiest mistake here, so the first value wired in names the channel after the
    // node it came from. ONLY while the name is still empty: renaming a live channel
    // later would orphan every reader already subscribed to it, so once there is a
    // name, auto or typed, it is left alone. Clear it and it derives again.
    if (!d.channel.trim()) {
      for (let i = 0; i < d.slots.length; i++) {
        const w = describe({ node, index: i });
        const from = String(w.from || "").trim();
        if (!w.src || !from) continue;
        const taken = knownChannels().filter((c) => c !== d.channel);
        d.channel = uniqueChannelName(from, taken);
        writeCfg(node);
        break;
      }
    }
    // Sockets are REMOVED, not hidden. A Send you just dropped should have no value
    // sockets at all: the declaration allows up to MAX of them, but only the rows you
    // added with the plus button get one. Hiding left all of them on the node looking
    // exactly as they did, which is the thing that made this unusable.
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
      const nm = node.inputs[i]?.name || "";
      const m = /^value_(\d+)$/.exec(nm);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      if (idx < d.slots.length) continue;          // a row asked for it
      if (node.inputs[i].link != null) continue;   // never orphan a wire
      node.removeInput?.(i);
      structural = true;
    }
    for (let i = 0; i < d.slots.length; i++) {
      const want = `value_${i + 1}`;
      let slot = (node.inputs || []).find((x) => x?.name === want);
      if (!slot) {
        node.addInput?.(want, "*");
        slot = (node.inputs || []).find((x) => x?.name === want);
        structural = true;
      }
      if (!slot) continue;
      const s = d.slots[i];
      // a tucked slot's visible label is " "; its real name lives in _rnLbl so the
      // untuck can restore it. Writing label directly would pop the tuck open again.
      if (slot._rnTucked) slot._rnLbl = s.name || `value ${i + 1}`;
      else slot.label = s.name || `value ${i + 1}`;
      // a named type makes the socket refuse the wrong wire, which is the point of
      // choosing one; "any" leaves it open
      slot.type = s.type && s.type !== "any" ? s.type : "*";
    }
    // Rebuild the DOM only when what it shows has CHANGED. The refresh tick used to
    // rebuild every 700ms regardless, which destroyed whatever was open at the time:
    // click a dropdown, the tick fires, the dropdown's element is replaced under it and
    // it snaps shut. Second click landed inside the next window, which is why it
    // "worked the second time".
    const sig = JSON.stringify([d, d.slots.map((s, i) => {
      const w = describe({ node, index: i });
      return [w.type, w.from];
    }), tuckMode(node), simpleMode(node)]);
    if (force || sig !== node._rnChSig) {
      node._rnChSig = sig;
      renderSend(node);
    }
  } else {
    // Persist the order the moment there is one. The panel walks the GRAPH and the
    // splice walks the PROMPT, and those two walks need not agree once subgraphs are
    // flattened, so leaving the default implicit would risk the two sides numbering
    // sockets differently. Writing it down means both simply follow the same list.
    const natural = memberView(allSends(), readerChannels(d), d.order);
    const known = new Set(d.order || []);
    const missing = natural.map((m) => m.key).filter((k) => !known.has(k));
    if (missing.length) {
      d.order = [...(d.order || []), ...missing];
      writeCfg(node);
    }
    const view = memberView(allSends(), readerChannels(d), d.order);
    // A hidden row gets NO socket. Hiding means "I do not want a wire here", so a
    // hidden row's socket is removed, wire and all, deliberately; unhide and it comes
    // back for reattaching. The splice derives the same list from the same config, so
    // slot N always means the same value on both sides of the queue.
    const sock = socketOrder(view, d.hidden);
    const targetKeys = sock.map((m) => m.key);
    const outs = node.outputs || [];
    // which value each physical socket carries. Adopted from position when unknown,
    // which is exactly right for a freshly loaded workflow: its sockets were built in
    // this same order by the session that saved it.
    let cur = Array.isArray(node._rnChSockKeys)
      && node._rnChSockKeys.length === outs.length
        ? node._rnChSockKeys.slice()
        : targetKeys.slice(0, outs.length);
    while (cur.length < outs.length) cur.push(`__extra_${cur.length}`);

    // 1) drop sockets whose value is gone from the target. A HIDDEN key is the user's
    // deliberate act recorded in the config, so its socket goes even when wired. A key
    // that merely left the channel (a Send renamed, a load still settling) only loses
    // its socket when unwired: cutting a wire is only ever done on instruction.
    for (let i = cur.length - 1; i >= 0; i--) {
      if (targetKeys.includes(cur[i])) continue;
      const wired = (outs[i]?.links || []).length > 0;
      const hiddenByUser = !!d.hidden[cur[i]];
      if (wired && !hiddenByUser) continue;          // a ghost, kept until unwired
      node.removeOutput?.(i);
      cur.splice(i, 1);
      structural = true;
    }
    // 2) add sockets for values that have none yet
    for (const k of targetKeys) {
      if (cur.includes(k)) continue;
      node.addOutput?.(`value_${cur.length + 1}`, "*");
      cur.push(k);
      structural = true;
    }
    // 3) put them in target order, wires riding the permutation; ghosts sit after
    const ghosts = cur.filter((k) => !targetKeys.includes(k));
    const final = [...targetKeys, ...ghosts];
    if (cur.length === final.length && cur.some((k, i) => k !== final[i])) {
      applyMemberPermutation(node, cur, final);
      structural = true;
    }
    node._rnChSockKeys = final;

    const byKey = new Map(sock.map((m) => [m.key, m]));
    for (let i = 0; i < (node.outputs || []).length; i++) {
      const slot = node.outputs[i];
      const m = byKey.get(final[i]);
      const w = m ? describe(m) : null;
      // a muted row KEEPS its socket and its wires; the splice is what silences it.
      // Removing the socket would rip the wires out, and the whole point of a mute is
      // that switching back on restores everything exactly as it was.
      const nick = m ? (d.style[m.key] || {}).name : "";
      const short = m ? (nick || shortLabel(m.label, w?.from)) : "(gone)";
      const text = m ? (d.muted[m.key] ? `(off) ${short}` : short) : "(gone)";
      if (slot._rnTucked) slot._rnLbl = text;
      else slot.label = text;
      slot.type = m ? (m.convert || (m.type !== "any" ? m.type : w?.type) || "*") : "*";
    }
    // same change-only rebuild as the Send, and the members and the channel list are
    // part of the signature so a Send appearing anywhere still refreshes this list
    const sig = JSON.stringify([d, view.map((m) => {
      const w = describe(m);
      return [m.key, m.type, m.convert, w.type, w.from];
    }), knownChannels(), tuckMode(node), simpleMode(node),
      [...(node._rnChSel || [])]]);
    if (force || sig !== node._rnChSig) {
      node._rnChSig = sig;
      renderReceive(node);
    }
  }
  // A node fresh from the menu is born with EVERY declared socket, all 64 of them,
  // because litegraph builds it from the static definition before this panel gets a
  // say, so the FIRST sync snaps the height back to what the content needs.
  //
  // Only the first. Re-fitting on every socket change meant the node resized itself
  // every time a channel was added or removed, throwing away whatever size the user
  // had just dragged it to. After birth the node's size belongs to the user: it only
  // ever GROWS here, and only when new sockets would otherwise draw past the bottom.
  if (structural) {
    const min = node.computeSize?.();
    if (min) {
      if (!node._rnChSized) {
        node.setSize?.([node.size?.[0] || min[0], min[1]]);
      } else if ((node.size?.[1] || 0) < min[1]) {
        node.setSize?.([node.size[0], min[1]]);
      }
    }
  }
  node._rnChSized = true;
  applyTuck(node);
  node.setDirtyCanvas?.(true, true);
}

for (const which of [SEND, RECEIVE]) {
  app.registerExtension({
    name: `RedNode.SubgraphPanel.${which}`,
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData?.name !== which) return;
      const created = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        created?.apply(this, arguments);
        const node = this;
        const w = cfgWidget(node);
        if (w) {                       // the panel owns it
          w.type = "hidden";
          w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        node._rnCh = readCfg(node);
        node._rnChSized = false;                 // first sync may heal the height
        // A fresh Send starts with two blank rows rather than an empty list, because
        // the first thing anyone does with one is wire a couple of values in. A saved
        // workflow is unaffected: onConfigure re-reads whatever was saved, including a
        // deliberately emptied list.
        if (which === SEND && !node._rnCh.slots.length) {
          node._rnCh.slots.push({ name: "", type: "any", convert: "" },
                                { name: "", type: "any", convert: "" });
          writeCfg(node);
        }
        const wrap = document.createElement("div");
        wrap.className = "rn-ch";
        for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                         "keydown", "contextmenu"]) {
          wrap.addEventListener(t, (e) => e.stopPropagation());
        }
        node._rnChRoot = wrap;
        node.addDOMWidget?.("rednode_channel_ui", "rednode_channel_ui", wrap, {
          serialize: false,
          getMinHeight: () => (simpleMode(node) ? 38 : 150),
        });
        node.size = [Math.max(node.size?.[0] || 0, which === SEND ? 520 : 460),
                     Math.max(node.size?.[1] || 0, 210)];
        setTimeout(() => sync(node), 0);
      };
      const configured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        configured?.apply(this, arguments);
        this._rnCh = readCfg(this);
        this._rnChSized = false;
        setTimeout(() => {
          sync(this);
          // a workflow saved while the node was ballooned reloads ballooned even
          // though nothing needs the height any more, so it is healed here once
          const min = this.computeSize?.();
          if (min && (this.size?.[1] || 0) > min[1] + 200) {
            this.setSize?.([this.size[0], min[1]]);
          }
        }, 0);
      };
      // tuck state is per-canvas cosmetics: strip the blank labels and parked positions
      // from the SAVED file, exactly as the Workspace does, so a workflow opened
      // somewhere without this pack shows normal sockets rather than nameless dots
      const serialized = nodeType.prototype.onSerialize;
      nodeType.prototype.onSerialize = function (o) {
        serialized?.apply(this, arguments);
        for (const arr of [o?.inputs, o?.outputs]) {
          for (const slot of arr || []) {
            if (slot.label === " ") { delete slot.label; delete slot.pos; }
          }
        }
      };
      if (which === RECEIVE) {
        // Right click on the node: arrange the whole list at once. The default order
        // is alphabetical because the panel and the queue-time splice must derive the
        // SAME socket order independently, and the label is the one thing both sides
        // share. Arranging writes the chosen sequence into the stored order, which
        // both sides already follow, so input order is one click rather than a drag
        // per row. Manual titles keep their positions; the values re-flow through.
        const extra = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvasArg, options) {
          extra?.apply(this, arguments);
          const node2 = this;
          const arrange = (mode) => {
            const d2 = node2._rnCh;
            if (!d2) return;
            const chans = readerChannels(d2);
            const sends = allSends();
            let seq;
            if (mode === "input") {
              // channel chips in their order, then each Send's rows in ITS row order,
              // which is the wiring order the user actually built
              seq = [];
              for (const ch of chans) {
                for (const m of sends) {
                  if (String(m.channel || "").trim() === ch) seq.push(`${ch}/${m.label}`);
                }
              }
              seq = [...new Set(seq)];
            } else {
              seq = memberView(sends, chans, null)
                .slice()
                .sort((a, b) => String(a.label).localeCompare(String(b.label))
                             || String(a.id).localeCompare(String(b.id)))
                .map((m) => m.key);
            }
            const viewKeys = memberView(sends, chans, d2.order).map((m) => m.key);
            const cur = channelTokens(d2, viewKeys);
            let mi = 0;
            d2.order = cur.map((t) => (t.startsWith("t:") ? t : (seq[mi++] ?? t)));
            writeCfg(node2);
            sync(node2, true);
          };
          // The practical way this node gets used: subscribe to everything, wire
          // the few values you actually want, then clear the rest out of sight. A
          // row with no wire has nothing to lose by going, which is why this is safe
          // to do in bulk.
          const sweep = (on) => {
            const d2 = node2._rnCh;
            if (!d2) return;
            if (!on) { d2.hidden = {}; d2.showHidden = false; writeCfg(node2); sync(node2, true); return; }
            const view = memberView(allSends(), readerChannels(d2), d2.order);
            const keys = socketOrder(view, d2.hidden).map((m) => m.key);
            for (let i = 0; i < keys.length; i++) {
              const out = (node2.outputs || [])[i];
              if (!((out?.links || []).length)) d2.hidden[keys[i]] = true;
            }
            d2.showHidden = false;
            writeCfg(node2);
            sync(node2, true);
          };
          options.push(
            {
              content: "Hide every value with no wire",
              callback: () => sweep(true),
            },
            {
              content: "Show all hidden values",
              callback: () => sweep(false),
            },
            {
              content: "Arrange values in Send order",
              callback: () => arrange("input"),
            },
            {
              content: "Arrange values alphabetically",
              callback: () => arrange("alpha"),
            },
          );
          return options;
        };
      }

      // wires and Sends elsewhere change what belongs here without telling this node
      const drawn = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function (ctx) {
        drawn?.apply(this, arguments);
        const now = performance.now();
        if (!this._rnChNext || now > this._rnChNext) {
          this._rnChNext = now + 700;
          applyTypeColours();          // idempotent: refills after a theme switch
          pullWidgets(this);
          sync(this);
        }
      };
    },
  });
}
