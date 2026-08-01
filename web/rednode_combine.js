import { app } from "../../scripts/app.js";
import { makePicker } from "./rednode_picker.js";
import { deriveLabel, nextAutoName, membersOf,
         labelPublishers } from "./rednode_channels.js";

// The panel for RedNode Prompt Combine and RedNode Text Combine. One list, three kinds
// of piece, mixed freely and dragged into whatever order the prompt should read in:
//
//   TEXT      typed into the row, the plain string-joiner case
//   WIRE      a socket on the node, for something built elsewhere
//   CHANNEL   named once at the top; every string on that channel becomes a row, with
//             no wires at all
//
// The channel rows are the point. A Grabber feeding a combiner would be two
// nodes, a wire per prompt and two panels listing the same values; naming the channel
// here is one node.
//
// Same row language as every other panel in the pack: grip drags, eye at the front,
// right click for colours.

const PROMPT = "RedNodePromptCombine";
const TEXT = "RedNodeTextCombine";
const MAX = 32;                                 // must match MAX_PARTS in the Python

const ROW_COLOURS = [null, "#7f2230", "#7a4416", "#1e5233", "#14514f", "#1d3f6e",
                     "#492a6b", "#6b2450", "#3a3f47"];
const TEXT_COLOURS = [null, "#111316", "#9aa0a8", "#f87171", "#fb923c", "#facc15",
                      "#4ade80", "#60a5fa", "#c084fc", "#f472b6"];

const CSS = `
.rn-cb{display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;
  font:15px system-ui,sans-serif;color:#e8ecf1;background:#16181c;border-radius:6px;
  width:100%;height:100%;overflow:auto}
.rn-cb-head{display:flex;gap:6px;align-items:center;flex:none}
.rn-cb-head .lab{font-size:13px;opacity:.6;flex:none;font-weight:600}
.rn-cb-warn { margin: 4px 6px 0; padding: 5px 7px; border-radius: 4px;
  background: #4a1d1d; border: 1px solid #7a2b2b; color: #ffb4b4;
  font-size: 11px; line-height: 1.35; }
.rn-cb input,.rn-cb select,.rn-cb textarea{background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:14px;padding:7px 9px;min-width:0;
  font-family:inherit}
.rn-cb input:focus,.rn-cb textarea:focus{outline:none;border-color:#b8283c}
.rn-cb-list{display:flex;flex-direction:column;gap:4px}
.rn-cb-row{display:flex;gap:8px;align-items:flex-start;background:#212429;
  border:1px solid #2a2e35;border-radius:6px;padding:8px 10px}
.rn-cb-row.rn-drop{outline:2px solid #b8283c}
.rn-cb-row.off{opacity:.72;background:#141619}
.rn-cb-row.off .nm{color:#ff7b86;text-decoration:line-through;
  text-decoration-color:#ff7b8666}
.rn-cb-row.off .rn-cb-eye{border-color:#6b1d26;color:#ff7b86}
.rn-cb-grip{cursor:grab;opacity:.4;flex:none;font-size:13px;letter-spacing:-2px;
  padding:4px 2px;user-select:none}
.rn-cb-grip:hover{opacity:.9}
.rn-cb-eye{background:#111316;border:1px solid #33373d;border-radius:4px;
  cursor:pointer;font-size:14px;flex:none;color:#8fb4ff;width:32px;height:26px;
  display:inline-flex;align-items:center;justify-content:center;line-height:1}
.rn-cb-eye:hover{border-color:#b8283c}
.rn-cb-btn{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  cursor:pointer;font-size:13.5px;padding:7px 12px;flex:none}
.rn-cb-btn:hover{border-color:#b8283c;color:#fff}
.rn-cb-btn.on{background:#2a1116;border-color:#b8283c;color:#fff;font-weight:600}
.rn-cb-col{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.rn-cb-col .nm{font-weight:600;font-size:14px;background:none;border:0;padding:2px 0;
  color:#e8ecf1}
.rn-cb-col textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:46px;
  font-size:13.5px;line-height:1.45}
.rn-cb-src{font-size:12px;opacity:.45;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rn-cb-chip{font-size:11px;font-weight:700;letter-spacing:.4px;flex:none;
  padding:3px 7px;border-radius:4px;background:#1d3f6e33;color:#8fb4ff}
.rn-cb-num{font-size:12.5px;opacity:.45;flex:none;min-width:16px;text-align:right;
  padding-top:5px}
.rn-cb-x{background:none;border:0;color:#ff9aa4;cursor:pointer;font-size:15px;
  padding:2px 6px;flex:none}
.rn-cb-x:hover{color:#fff}
.rn-cb-foot{display:flex;gap:8px;align-items:center;flex:none;font-size:12.5px;
  opacity:.55}
.rn-cb-empty{font-size:13px;opacity:.5;line-height:1.55;padding:8px 2px}
.rn-cb-preview{background:#1b1e23;border:1px solid #2a2e35;border-radius:6px;
  padding:8px 10px;font-size:12.5px;line-height:1.5;opacity:.8;max-height:80px;
  overflow:auto;white-space:pre-wrap}
.rn-cb-menu{position:fixed;z-index:10001;background:#111316;border:1px solid #3a3d44;
  border-radius:6px;padding:9px;display:flex;flex-direction:column;gap:7px;
  font:13px system-ui,sans-serif;color:#ddd;min-width:200px;box-shadow:0 6px 22px #000a}
.rn-cb-menu h5{margin:0;font-size:10.5px;font-weight:700;letter-spacing:.6px;
  opacity:.5;text-transform:uppercase}
.rn-cb-menu .sw{display:flex;gap:5px;flex-wrap:wrap}
.rn-cb-menu .sw div{width:22px;height:22px;border-radius:5px;cursor:pointer;
  border:2px solid transparent}
.rn-cb-menu .sw div:hover{border-color:#fff}
.rn-cb-menu button{background:#15171b;border:1px solid #33373d;border-radius:5px;
  color:#ddd;cursor:pointer;font-size:12.5px;padding:6px 10px;text-align:left}
.rn-cb-menu button:hover{border-color:#b8283c;color:#fff}
`;
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

const widget = (node, name) => (node.widgets || []).find((w) => w?.name === name);

function readCfg(node) {
  let d = {};
  try { d = JSON.parse(widget(node, "config")?.value || "{}"); } catch (e) { d = {}; }
  if (Array.isArray(d)) d = { parts: d };
  if (!d || typeof d !== "object") d = {};
  // Fall back to the WIDGET when the panel record has no opinion. Both are real widgets
  // so the Control Panel and the wireless system can drive them, and a value set that
  // way, or typed straight into the widget, has to appear here too. Otherwise the panel
  // shows an empty field while the splice is happily using the value, and the node
  // contradicts itself on screen.
  d.channel = String(d.channel ?? widget(node, "channel")?.value ?? "");
  d.channel_out = String(d.channel_out ?? widget(node, "channel_out")?.value ?? "");
  d.parts = Array.isArray(d.parts) ? d.parts : [];
  for (const p of d.parts) {
    p.kind = p.kind === "text" ? "text" : "slot";
    p.on = p.on !== false;
    p.text = String(p.text ?? "");
    p.name = String(p.name ?? "");
    p.key = String(p.key ?? "");
  }
  return d;
}

function writeCfg(node) {
  const w = widget(node, "config");
  if (w) w.value = JSON.stringify(node._rnCB);
  // channel is a REAL widget too, so the Control Panel and the wireless system can
  // drive it; whichever one is touched, the other follows
  const cw = widget(node, "channel");
  if (cw && cw.value !== node._rnCB.channel) cw.value = node._rnCB.channel;
  const ow = widget(node, "channel_out");
  if (ow && ow.value !== node._rnCB.channel_out) ow.value = node._rnCB.channel_out;
  app.graph?.setDirtyCanvas?.(true, true);
}

/**
 * Every value on every channel, subgraphs included: Send rows, plus every node that
 * publishes its own output. Both are subscribable, so both are listed, and a channel
 * that exists only because something publishes to it still shows up in the dropdown.
 */
function allSends(root, out = [], seen = new Set(), path = "", pubs = null) {
  const graph = root || app.graph;
  const top = !pubs;
  if (top) pubs = [];
  if (!graph || seen.has(graph)) return out;
  seen.add(graph);
  for (const n of graph._nodes || []) {
    const och = String((n?.widgets || [])
      .find((w) => w?.name === "channel_out")?.value || "").trim();
    if (och) {
      pubs.push({ id: `${n.id}`, channel: och, title: n.title, classType: n.type,
                  node: n, sub: path });
    }
    if (n?.type === "RedNodeSubgraphSend") {
      let cfg = {};
      try { cfg = JSON.parse(widget(n, "config")?.value || "{}"); } catch (e) { cfg = {}; }
      const ch = String(cfg.channel ?? widget(n, "channel")?.value ?? "").trim();
      for (const [i, s] of (Array.isArray(cfg.slots) ? cfg.slots : []).entries()) {
        const name = String(s?.name || "").trim();
        if (!name || s?.on === false) continue;
        out.push({ id: `${n.id}:${i}`, node: n, index: i, channel: ch, label: name,
                   sub: path });
      }
    }
    if (n?.subgraph) {
      const t = String(n.title || "subgraph").trim();
      allSends(n.subgraph, out, seen, path ? `${path} / ${t}` : t, pubs);
    }
  }
  if (top) {
    for (const p of labelPublishers(pubs)) {
      out.push({ id: `${p.id}:out`, node: p.node, index: -1, channel: p.channel,
                 label: p.label, sub: p.sub, publisher: true });
    }
  }
  return out;
}

/** What is wired into a row's socket, and any text the canvas can already read. */
function describe(node, i) {
  const slot = (node.inputs || []).find((x) => x?.name === `part_${i + 1}`);
  if (!slot?.link) return { from: "", text: "" };
  const graph = node.graph || app.graph;
  const link = graph?.links?.get?.(slot.link) ?? graph?.links?.[slot.link];
  if (!link) return { from: "", text: "" };
  const src = graph?.getNodeById?.(link.origin_id);
  if (!src) return { from: "", text: "" };
  const out = src.outputs?.[link.origin_slot];
  let text = "";
  for (const w of src.widgets || []) {
    if (typeof w?.value === "string" && w.value.trim()
        && !["config", "separator", "channel"].includes(w.name)) {
      text = w.value.trim();
      break;
    }
  }
  return {
    from: String(src.title || src.type || "").trim(),
    slot: String(out?.label || out?.name || "").trim(),
    src, text,
  };
}

/** The channel's members, as rows to be merged into the list. */
function channelRows(node) {
  const ch = String(node._rnCB.channel || "").trim();
  if (!ch) return [];
  return membersOf(allSends(), ch)
    .filter((m) => m.node !== node)
    .map((m) => ({
      key: `${m.channel}/${m.label}`, label: m.label, sub: m.sub,
    }));
}

function rowMenu(node, part, ev) {
  document.querySelector(".rn-cb-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "rn-cb-menu";
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
      if ((part[key] || null) === c) dot.style.borderColor = "#fff";
      dot.onclick = () => {
        if (c) part[key] = c; else delete part[key];
        writeCfg(node);
        sync(node);
        menu.remove();
      };
      sw.appendChild(dot);
    }
    return [h, sw];
  };
  menu.append(...swatches("Row colour", ROW_COLOURS, "color"));
  menu.append(...swatches("Text colour", TEXT_COLOURS, "textColor"));
  const off = part.on === false;
  const t = document.createElement("button");
  t.textContent = off ? "Switch on" : "Switch off";
  t.title = "A switched-off piece is left out of the text entirely.";
  t.onclick = () => { part.on = off; writeCfg(node); sync(node); menu.remove(); };
  menu.appendChild(t);
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

function render(node) {
  const root = node._rnCBRoot;
  if (!root) return;
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    if (node.inputs[i]?.widget?.name === "config") node.inputs.splice(i, 1);
  }
  const d = node._rnCB;
  root.replaceChildren();

  // ---- CHANNEL IN: values arrive from a channel
  // In and out, rather than receive and send. One node reads a channel and writes to
  // one, so the two fields have to read as a pair, and in/out is the pair everyone
  // already knows from get and set.
  const chans = [...new Set(allSends().map((m) => m.channel).filter(Boolean))].sort();
  const counts = new Map();
  for (const m of allSends()) {
    if (m.channel) counts.set(m.channel, (counts.get(m.channel) || 0) + 1);
  }
  const options = () => chans.map((c) => ({
    value: c, hint: `${counts.get(c) || 0} value(s)`,
  }));

  const head = document.createElement("div");
  head.className = "rn-cb-head";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.textContent = "Channel in";
  const sel = document.createElement("input");
  sel.type = "text";
  sel.style.flex = "1";
  sel.value = d.channel;
  sel.placeholder = "none, use the rows below only";
  sel.title = "Read a channel and every string on it becomes a row here, with no wires. "
            + "Rows you add by hand keep working alongside them. Click and type to "
            + "search.";
  makePicker(sel, options, (v) => { d.channel = v; writeCfg(node); sync(node, true); }, {
    current: () => d.channel,
    emptyLabel: "none, use the rows below only",
  });
  head.append(lab, sel);
  root.appendChild(head);

  // ---- CHANNEL OUT: this node's own result goes onto a channel
  const pub = document.createElement("div");
  pub.className = "rn-cb-head";
  const plab = document.createElement("span");
  plab.className = "lab";
  plab.textContent = "Channel out";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.style.flex = "1";
  inp.value = d.channel_out;
  inp.placeholder = "none, the result leaves by wire only";
  inp.title = "Put this node's result onto a channel. Anything reading that name picks "
            + "it up with no wire, and the row is labelled with this node's title, so "
            + "title the node what you want to see in the list. Type a new name to "
            + "create a channel.";
  // allowNew here and not on the field above: naming a channel is how one comes into
  // existence, and you can only do that at the end that puts something on it. Reading a
  // name nothing sends to is a typo, and offering to create it would hide that.
  makePicker(inp, options,
    (v) => { d.channel_out = v; writeCfg(node); sync(node, true); },
    { current: () => d.channel_out, allowNew: true,
      emptyLabel: "none, the result leaves by wire only" });
  pub.append(plab, inp);
  root.appendChild(pub);

  // Caught here as well as at queue time, because the canvas can say it the moment it
  // is typed rather than the next time you queue and wonder where a part went.
  if (d.channel_out && d.channel_out === d.channel) {
    const warn = document.createElement("div");
    warn.className = "rn-cb-warn";
    warn.textContent = `Channel in and channel out are both '${d.channel}', so this `
                     + `node would be waiting on its own result. Rename one of them.`;
    root.appendChild(warn);
  }

  const move = (from, to) => {
    if (from === to || from < 0 || to < 0
        || from >= d.parts.length || to >= d.parts.length) return;
    // the wires follow by RENAMING: the prompt reads inputs by name, so the input that
    // fed old row N becomes part_{newN+1} and no wire physically moves. Two phases, or
    // the renames collide with each other.
    const perm = [...Array(d.parts.length).keys()];
    const [x] = perm.splice(from, 1);
    perm.splice(to, 0, x);
    const ins = node.inputs || [];
    perm.forEach((oldI, newI) => {
      const obj = ins.find((s) => s?.name === `part_${oldI + 1}`);
      if (obj) obj._rnNew = `part_${newI + 1}`;
    });
    for (const obj of ins) {
      if (obj?._rnNew) { obj.name = obj._rnNew; delete obj._rnNew; }
    }
    const [p] = d.parts.splice(from, 1);
    d.parts.splice(to, 0, p);
    writeCfg(node);
    sync(node, true);
  };

  const list = document.createElement("div");
  list.className = "rn-cb-list";
  if (!d.parts.length) {
    const e = document.createElement("div");
    e.className = "rn-cb-empty";
    e.textContent = "Nothing yet. Press + for a text box, or pick a channel above and "
                  + "every string on it appears here with no wires.";
    list.appendChild(e);
  }

  d.parts.forEach((p, i) => {
    const w = describe(node, i);
    const off = p.on === false;
    const row = document.createElement("div");
    row.className = "rn-cb-row" + (off ? " off" : "");
    if (p.color) row.style.background = p.color;
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("rn-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("rn-drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("rn-drop");
      const from = node._rnCBFrom;
      node._rnCBFrom = null;
      if (typeof from === "number") move(from, i);
    });
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      rowMenu(node, p, e);
    };

    const grip = document.createElement("span");
    grip.className = "rn-cb-grip";
    grip.textContent = "⋮⋮";
    grip.title = "drag to reorder. This changes the text; the wires follow.";
    grip.draggable = true;
    grip.addEventListener("dragstart", (e) => {
      node._rnCBFrom = i;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(row, 10, 10);
    });

    const eye = document.createElement("button");
    eye.className = "rn-cb-eye";
    eye.textContent = off ? "—" : "👁";
    eye.title = off
      ? "off: this piece is left out. Click to put it back."
      : "on. Click to leave this piece out without deleting it.";
    eye.onclick = () => { p.on = off; writeCfg(node); sync(node); };

    const col = document.createElement("div");
    col.className = "rn-cb-col";
    const top = document.createElement("div");
    top.style.cssText = "display:flex;gap:6px;align-items:center";
    const nm = document.createElement("input");
    nm.className = "nm";
    nm.type = "text";
    nm.value = p.name || "";
    nm.placeholder = p.key ? p.key.split("/").pop() : (w.from || "what is this piece");
    nm.title = "A label for this row. Channel and wired rows name themselves.";
    if (p.textColor) nm.style.color = p.textColor;
    nm.onchange = () => { p.name = nm.value; writeCfg(node); sync(node); };
    top.appendChild(nm);
    if (p.key) {
      const chip = document.createElement("span");
      chip.className = "rn-cb-chip";
      chip.textContent = "channel";
      chip.title = `from the channel: ${p.key}`;
      top.appendChild(chip);
    }
    col.appendChild(top);

    if (p.kind === "text" && !p.key && !w.from) {
      const ta = document.createElement("textarea");
      ta.value = p.text || "";
      ta.placeholder = "type this piece";
      ta.rows = 2;
      ta.onchange = () => { p.text = ta.value; writeCfg(node); sync(node); };
      ta.oninput = () => { p.text = ta.value; };
      col.appendChild(ta);
    } else {
      const src = document.createElement("span");
      src.className = "rn-cb-src";
      src.textContent = p.key
        ? [p.sub ? `↳ ${p.sub}` : "", w.text || "from the channel"]
            .filter(Boolean).join(" · ")
        : (w.text || w.from || "nothing wired in");
      src.title = w.text || "";
      col.appendChild(src);
    }

    const num = document.createElement("span");
    num.className = "rn-cb-num";
    num.textContent = `${i + 1}`;

    const x = document.createElement("button");
    x.className = "rn-cb-x";
    x.textContent = "✕";
    x.title = p.key
      ? "drop this channel value from the list. It comes back if the channel still "
        + "carries it and you have not switched the channel off."
      : "remove this piece";
    x.onclick = () => { d.parts.splice(i, 1); writeCfg(node); sync(node, true); };

    row.append(grip, eye, col, num, x);
    list.appendChild(row);
  });
  root.appendChild(list);

  // ---- what the text reads as, from the pieces the canvas can see
  const known = d.parts
    .map((p, i) => {
      if (p.on === false) return "";
      const w = describe(node, i);
      return (w.text || (p.kind === "text" ? p.text : "")).trim();
    })
    .filter(Boolean);
  if (known.length) {
    const sepW = widget(node, "separator");
    const sep = String(sepW?.value ?? ", ").replace(/\\n/g, "\n");
    const pv = document.createElement("div");
    pv.className = "rn-cb-preview";
    pv.textContent = known.join(sep);
    pv.title = "What this reads as, from the pieces the canvas can already see. "
             + "Anything computed at run time is not shown.";
    root.appendChild(pv);
  }

  const foot = document.createElement("div");
  foot.className = "rn-cb-foot";
  const add = document.createElement("button");
  add.className = "rn-cb-btn";
  add.textContent = "+ text";
  add.title = "add a piece you type here";
  add.disabled = d.parts.length >= MAX;
  add.onclick = () => {
    d.parts.push({ kind: "text", name: "", on: true, text: "" });
    writeCfg(node);
    sync(node, true);
  };
  const addWire = document.createElement("button");
  addWire.className = "rn-cb-btn";
  addWire.textContent = "+ input";
  addWire.title = "add a piece fed by a wire";
  addWire.disabled = d.parts.length >= MAX;
  addWire.onclick = () => {
    d.parts.push({ kind: "slot", name: "", on: true });
    writeCfg(node);
    sync(node, true);
  };
  // the order field, explained in place: it overrides the drag order at run time, and
  // it is usually driven by a Selector rather than typed
  const ordW = widget(node, "order");
  const ordVal = String(ordW?.value ?? "").trim();
  if (ordW) {
    const ord = document.createElement("div");
    ord.className = "rn-cb-src";
    ord.style.cssText = "padding:2px 2px 0;opacity:.55";
    ord.textContent = ordVal
      ? `order "${ordVal}" is running, so it decides, not the drag order above`
      : "order is empty, so the list above is the order. Wire a RedNode Selector of "
        + "saved orderings into it to switch between them.";
    ord.title = "The order field takes 1-based positions like 3,1,2. Pieces it does "
              + "not name follow in the order shown above.";
    root.appendChild(ord);
  }
  const copy = document.createElement("button");
  copy.className = "rn-cb-btn";
  copy.textContent = "Copy order";
  copy.title = "Copy this arrangement as \"1, 2, 3\", ready to paste into a RedNode "
             + "Selector line as a named ordering.";
  copy.onclick = () => {
    const seq = d.parts.map((_, i) => i + 1).join(", ");
    navigator.clipboard?.writeText?.(seq);
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = "Copy order"; }, 1500);
  };
  const note = document.createElement("span");
  const offCount = d.parts.filter((p) => p.on === false).length;
  const fromCh = d.parts.filter((p) => p.key).length;
  note.textContent = d.parts.length
    ? `${d.parts.length} piece(s)` + (fromCh ? `, ${fromCh} from the channel` : "")
      + (offCount ? `, ${offCount} off` : "")
    : "";
  foot.append(add, addWire, copy, note);
  root.appendChild(foot);
}

/** Rows follow the channel, sockets follow the rows, names follow their sources. */
function sync(node, structural = false) {
  const d = node._rnCB;

  // the channel widget can be driven from outside, so read it back first
  const cw = widget(node, "channel");
  if (cw && String(cw.value ?? "") !== d.channel) {
    d.channel = String(cw.value ?? "");
    structural = true;
  }

  // channel members become rows. New ones APPEND rather than reshuffling what was
  // arranged, and a member that leaves takes its row with it.
  const rows = channelRows(node);
  const live = new Set(rows.map((r) => r.key));
  const before = d.parts.length;
  d.parts = d.parts.filter((p) => !p.key || live.has(p.key));
  const have = new Set(d.parts.filter((p) => p.key).map((p) => p.key));
  for (const r of rows) {
    if (have.has(r.key)) continue;
    d.parts.push({ kind: "slot", key: r.key, name: r.label, on: true, sub: r.sub });
  }
  if (d.parts.length !== before) structural = true;
  for (const p of d.parts) {
    const r = rows.find((x) => x.key === p.key);
    if (r) p.sub = r.sub;
  }

  // a wired row names itself from its source, the same rule as everywhere else
  let renamed = false;
  d.parts.forEach((p, i) => {
    if (p.key) return;                          // channel rows carry their own name
    const w = describe(node, i);
    if (!w.src) return;
    const auto = deriveLabel({ title: w.from, slot: w.slot });
    const next = nextAutoName(p.name, p.auto, auto);
    if (next) { p.name = next; p.auto = next; renamed = true; }
  });
  if (renamed || d.parts.length !== before) writeCfg(node);

  // sockets: one per row, only unwired ones are ever removed
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const m = /^part_(\d+)$/.exec(node.inputs[i]?.name || "");
    if (!m) continue;
    if (parseInt(m[1], 10) - 1 < d.parts.length) continue;
    if (node.inputs[i].link != null) continue;
    node.removeInput?.(i);
    structural = true;
  }
  for (let i = 0; i < d.parts.length; i++) {
    const p = d.parts[i];
    const want = `part_${i + 1}`;
    let slot = (node.inputs || []).find((x) => x?.name === want);
    // a text row needs no socket, and a channel row is filled by the splice rather
    // than by a wire, so neither shows one unless something is already plugged in
    const wants = p.kind !== "text" && !p.key;
    if (!wants) {
      if (slot && slot.link == null) {
        node.removeInput?.(node.inputs.indexOf(slot));
        structural = true;
      }
      continue;
    }
    if (!slot) {
      node.addInput?.(want, "STRING");
      slot = (node.inputs || []).find((x) => x?.name === want);
      structural = true;
    }
    if (slot) slot.label = p.name || `piece ${i + 1}`;
  }

  if (structural) {
    const min = node.computeSize?.();
    if (min && !node._rnCBSized) node.setSize?.([node.size?.[0] || min[0], min[1]]);
    else if (min && (node.size?.[1] || 0) < min[1]) node.setSize?.([node.size[0], min[1]]);
  }
  node._rnCBSized = true;
  render(node);
  node.setDirtyCanvas?.(true, true);
}

for (const which of [PROMPT, TEXT]) {
  app.registerExtension({
    name: `RedNode.Combine.${which}`,
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData?.name !== which) return;
      const created = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        created?.apply(this, arguments);
        const node = this;
        // config is the panel's own record and stays hidden. `order` does NOT: it is
        // how an order is CHOSEN rather than built, and a RedNode Selector full of
        // named orderings wires straight into it. Hiding it hid the feature.
        {
          const w = widget(node, "config");
          if (w) {
            w.type = "hidden";
            w.hidden = true;
            w.computeSize = () => [0, -4];
            if (w.element) w.element.style.display = "none";
            if (w.inputEl) w.inputEl.style.display = "none";
          }
        }
        // the legacy text boxes are rows in the panel now
        for (const name of ["text_1", "text_2"]) {
          const w = widget(node, name);
          if (!w) continue;
          w.type = "hidden";
          w.hidden = true;
          w.computeSize = () => [0, -4];
          if (w.element) w.element.style.display = "none";
          if (w.inputEl) w.inputEl.style.display = "none";
        }
        node._rnCB = readCfg(node);
        node._rnCBSized = false;
        if (!node._rnCB.parts.length) {
          // carry the legacy boxes' text in as the first two rows, so a workflow saved
          // before the panel opens with its prompt intact rather than empty
          const t1 = String(widget(node, "text_1")?.value ?? "");
          const t2 = String(widget(node, "text_2")?.value ?? "");
          node._rnCB.parts.push({ kind: "text", name: "", on: true, text: t1 },
                                { kind: "text", name: "", on: true, text: t2 });
          writeCfg(node);
        }
        const wrap = document.createElement("div");
        wrap.className = "rn-cb";
        for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick",
                         "keydown", "contextmenu"]) {
          wrap.addEventListener(t, (e) => e.stopPropagation());
        }
        node._rnCBRoot = wrap;
        node.addDOMWidget?.("rednode_combine_ui", "rednode_combine_ui", wrap, {
          serialize: false,
          getMinHeight: () => 140,
        });
        node.size = [Math.max(node.size?.[0] || 0, 430),
                     Math.max(node.size?.[1] || 0, 260)];
        setTimeout(() => sync(node, true), 0);
      };
      const configured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        configured?.apply(this, arguments);
        this._rnCB = readCfg(this);
        this._rnCBSized = false;
        setTimeout(() => sync(this, true), 0);
      };
      // a Send joining the channel elsewhere does not tell this node anything
      const drawn = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function (ctx) {
        drawn?.apply(this, arguments);
        const now = performance.now();
        if (!this._rnCBNext || now > this._rnCBNext) {
          this._rnCBNext = now + 700;
          sync(this);
        }
      };
    },
  });
}
