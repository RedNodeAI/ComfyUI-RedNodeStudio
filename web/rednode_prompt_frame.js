import { app } from "../../scripts/app.js";
import { pinWidgetValues } from "./rednode_widget_values.js";

// RedNode Prompt Frame — panel UI for RedNodePromptFrame.
//
// Widget lifecycle follows rednode_promptbox.js: the native widgets are HIDDEN, never
// removed (removal leaves a ghost in ComfyUI's DOM-widget store that draws a stray label
// strip). They stay as the value holders and keep owning serialization; the panel reads
// and writes them.
//
// Owning serialization means the panel must NOT take a slot in the positional
// widgets_values array, and here it did: it is unshifted to the front of the widget list,
// and it is built from inside a requestAnimationFrame, so every load configured the node
// while the panel was not in that list yet. Each value arrived one place to the right of
// where it was saved — Subject came back holding the panel's own empty string, and what
// was typed into Subject came back in Surroundings. pinWidgetValues is the fix;
// rednode_widget_values.js has the full account of the mechanism.
//
// The live prompt and its warnings come from POST /rednode/prompt_frame_preview rather
// than being recomputed here. Duplicating the assembly rules in JS would guarantee the
// panel and the node disagree the first time either changes.

const PANEL_MIN_H = 560;
const DEBOUNCE_MS = 250;

// Same palette the Prompt Box uses, so a graph with both does not look like two products.
const COLORS = {
  default: "", white: "#e8e8e8", green: "#9fe38b", amber: "#ffcf6b",
  cyan: "#7fd7e6", pink: "#f0a0d0", red: "#ff8a8a", blue: "#8ab4ff",
};

// Widgets the panel reads for its own look but leaves visible, exactly as the Prompt Box
// leaves seed and the wildcard toggle on the node rather than swallowing them.
const LOOK_FIELDS = ["font_size", "text_color"];

// Every native widget the panel takes over, in panel order.
const FIELDS = [
  "style", "style_extra", "subject", "surroundings", "framing",
  "placement_where", "placement_what", "placement",
  "lighting", "brightness", "light_and_colour",
];

const STYLE = `
.rn-pf {
  --rn-line: rgba(255,255,255,0.13);
  --rn-bg: rgba(0,0,0,0.24);
  /* Opaque, because the native <select> popup is drawn by the browser OUTSIDE this
     panel: a translucent colour there composites against the page, not against us, and
     the list came out light grey text on light grey. */
  --rn-solid: #1b1e23;
  --rn-solid-hi: #2b313a;
  color-scheme: dark;            /* makes the browser draw native controls dark */
  box-sizing: border-box; overflow: auto; padding: 8px;
  display: flex; flex-direction: column; gap: 8px;
  font: 13px 'Segoe UI', system-ui, -apple-system, sans-serif; color: #d6d9de;
  background: rgba(0,0,0,0.16);
  border: 1px solid var(--rn-line); border-radius: 6px;
}
.rn-pf ::-webkit-scrollbar { width: 9px; height: 9px; }
.rn-pf ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 5px; }

.rn-pf-head { display: flex; align-items: center; gap: 6px; }
.rn-pf-head .ttl { flex: 1; font-size: 12px; letter-spacing: .04em;
  text-transform: uppercase; color: #8f97a3; }

.rn-pf-row { display: flex; align-items: center; gap: 6px; }
.rn-pf-row > label { width: 84px; flex: none; font-size: 12px; color: #9aa2ad; }
.rn-pf-row > .grow { flex: 1; min-width: 0; }

.rn-pf input[type=text] {
  box-sizing: border-box; width: 100%; padding: 4px 6px;
  background: var(--rn-bg); color: #e2e5ea;
  border: 1px solid var(--rn-line); border-radius: 4px; font: inherit; font-size: 13px;
  outline: none;
}
.rn-pf select {
  box-sizing: border-box; width: 100%; padding: 4px 6px;
  background-color: var(--rn-solid); color: #e2e5ea;
  border: 1px solid var(--rn-line); border-radius: 4px; font: inherit; font-size: 13px;
  outline: none;
}
/* the popup list is a separate surface, so it needs its own opaque colours */
.rn-pf select option {
  background-color: var(--rn-solid); color: #e2e5ea;
}
.rn-pf select option:checked,
.rn-pf select option:hover { background-color: var(--rn-solid-hi); color: #fff; }
.rn-pf select:focus, .rn-pf input:focus, .rn-pf textarea:focus { border-color: #8ab4ff; }

.rn-pf textarea {
  box-sizing: border-box; width: 100%; min-height: 46px;
  padding: 6px 8px; background: var(--rn-bg); color: #e2e5ea;
  border: 1px solid var(--rn-line); border-radius: 5px;
  font: inherit; font-size: 13px; line-height: 1.35;
  resize: vertical;               /* adjustable, inside the frame */
  outline: none; white-space: pre-wrap; overflow-wrap: break-word;
}
.rn-pf textarea::placeholder, .rn-pf input::placeholder { color: rgba(200,200,200,0.32); }

.rn-pf-lbl { display: flex; justify-content: space-between; align-items: baseline;
  font-size: 12px; color: #9aa2ad; }
.rn-pf-lbl b { color: #c9ced6; font-weight: 600; font-size: 12px; }

.rn-pf-slider { display: flex; align-items: center; gap: 8px; }
.rn-pf-slider input[type=range] { flex: 1; min-width: 0; accent-color: #b8283c; height: 18px; }
.rn-pf-val { width: 88px; flex: none; text-align: right; color: #c9ced6; font-size: 12px; }

.rn-pf-btn {
  background: rgba(20,22,26,0.85); border: 1px solid var(--rn-line);
  border-radius: 4px; color: #9aa0a8; cursor: pointer;
  font: 11px system-ui, sans-serif; line-height: 1; padding: 4px 8px;
}
.rn-pf-btn:hover { color: #fff; border-color: #b8283c; }

.rn-pf-note {
  min-height: 16px; font-size: 12px; line-height: 1.35; color: #e0a35a;
  border-left: 2px solid transparent; padding-left: 6px;
}
.rn-pf-note.on { border-left-color: #e0a35a; }
.rn-pf-note.ok { color: #7f8792; }
.rn-pf-out {
  min-height: 90px; max-height: 260px; overflow: auto;
  font-size: 12px; line-height: 1.45; color: #9fa7b2;
  background: rgba(0,0,0,0.2); border: 1px solid var(--rn-line);
  border-radius: 5px; padding: 7px 9px; white-space: pre-wrap;
  resize: vertical;              /* drag it taller when a prompt gets long */
}
/* highlighting for the pipeline the Prompt Box also speaks */
.rn-pf-wc { color: #8ab4ff; }
.rn-pf-kw { color: #9fe38b; }
`;

function injectStyle() {
  if (document.getElementById("rn-pf-style")) return;
  const s = document.createElement("style");
  s.id = "rn-pf-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function labelledRow(labelText, control) {
  const row = el("div", "rn-pf-row");
  row.appendChild(el("label", null, labelText));
  const grow = el("div", "grow");
  grow.appendChild(control);
  row.appendChild(grow);
  return row;
}

function fillSelect(sel, values, current) {
  sel.replaceChildren();
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  if (current != null) sel.value = current;
}

// ---- box heights ------------------------------------------------------------------
// Dragging a box taller is a decision about this node, so it has to survive with the
// node. node.properties serialises with the workflow and costs no widget slot, which is
// where the Prompt Box already keeps its fold state and, since widgets_values is
// positional, the only place a panel can store anything without moving what is saved
// after it. A runtime node._rn field would come back undefined on the next open, which
// is exactly the reset being complained about.
const SIZES = "rn_pf_sizes";

function keepSize(node, key, box) {
  const saved = node.properties?.[SIZES]?.[key];
  if (typeof saved === "number" && saved > 0) box.style.height = saved + "px";
  if (!window.ResizeObserver) return;

  // A textarea in this panel is full width and wraps rather than growing, so the only
  // thing that changes its height is somebody dragging the corner. The first callback
  // is the initial layout, not a drag, and writing on it would dirty every workflow
  // merely for opening it.
  let first = true, last = 0;
  const ro = new ResizeObserver(() => {
    const h = Math.round(box.offsetHeight);
    if (!h) return;                       // mid-rebuild or hidden, not a size anyone chose
    if (first) { first = false; last = h; return; }
    if (h === last) return;
    last = h;
    node.properties = node.properties || {};
    (node.properties[SIZES] ||= {})[key] = h;
  });
  ro.observe(box);
  (node._rnPfSizeObs ||= []).push(ro);    // held so it is not garbage collected
}

function buildPanel(node) {
  if (!node.addDOMWidget || node._rnPfPanel) return;

  const W = {};
  for (const name of FIELDS) W[name] = node.widgets?.find((w) => w.name === name);
  // widgets arrive over a couple of frames on a fresh graph
  if (FIELDS.some((n) => !W[n])) { requestAnimationFrame(() => buildPanel(node)); return; }

  for (const name of FIELDS) {
    const w = W[name];
    w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4];
  }

  const wrap = el("div", "rn-pf");

  // ---- head: presets ------------------------------------------------------------
  const head = el("div", "rn-pf-head");
  head.appendChild(el("span", "ttl", "Prompt Frame"));
  const presetSel = document.createElement("select");
  presetSel.style.maxWidth = "180px";
  fillSelect(presetSel, ["Load an example..."], "Load an example...");
  const presetBtn = el("button", "rn-pf-btn", "Load");
  head.appendChild(presetSel);
  head.appendChild(presetBtn);
  wrap.appendChild(head);

  // ---- style --------------------------------------------------------------------
  const styleSel = document.createElement("select");
  fillSelect(styleSel, W.style.options?.values || [], W.style.value);
  wrap.appendChild(labelledRow("Style", styleSel));

  const styleExtra = document.createElement("textarea");
  styleExtra.rows = 2;
  styleExtra.placeholder = "your own style wording (optional)";
  styleExtra.value = W.style_extra.value || "";
  wrap.appendChild(styleExtra);

  // ---- subject / surroundings -----------------------------------------------------
  const subjLbl = el("div", "rn-pf-lbl");
  subjLbl.appendChild(el("b", null, "Subject"));
  subjLbl.appendChild(el("span", null, "who or what, and how it looks"));
  const subject = document.createElement("textarea");
  subject.rows = 3;
  subject.placeholder = "a woman in her thirties, red waterproof jacket, rucksack";
  subject.value = W.subject.value || "";
  wrap.appendChild(subjLbl); wrap.appendChild(subject);

  const surrLbl = el("div", "rn-pf-lbl");
  surrLbl.appendChild(el("b", null, "Surroundings"));
  surrLbl.appendChild(el("span", null, "where it is"));
  const surroundings = document.createElement("textarea");
  surroundings.rows = 3;
  surroundings.placeholder = "a mountain ridge under heavy cloud, wet black rock, a thin path";
  surroundings.value = W.surroundings.value || "";
  wrap.appendChild(surrLbl); wrap.appendChild(surroundings);

  // ---- framing slider --------------------------------------------------------------
  const framings = W.framing.options?.values || [];
  const frameWrap = el("div", "rn-pf-slider");
  const frameRange = document.createElement("input");
  frameRange.type = "range";
  frameRange.min = "0"; frameRange.max = String(Math.max(0, framings.length - 1));
  frameRange.step = "1";
  frameRange.value = String(Math.max(0, framings.indexOf(W.framing.value)));
  const frameVal = el("div", "rn-pf-val", W.framing.value);
  frameWrap.appendChild(frameRange); frameWrap.appendChild(frameVal);
  const frameLbl = el("div", "rn-pf-lbl");
  frameLbl.appendChild(el("b", null, "Framing"));
  frameLbl.appendChild(el("span", null, "tight to wide"));
  wrap.appendChild(frameLbl); wrap.appendChild(frameWrap);

  // ---- placement --------------------------------------------------------------------
  const placeRow = el("div", "rn-pf-row");
  placeRow.appendChild(el("label", null, "Placement"));
  const whereSel = document.createElement("select");
  const whatSel = document.createElement("select");
  fillSelect(whereSel, W.placement_where.options?.values || [], W.placement_where.value);
  fillSelect(whatSel, W.placement_what.options?.values || [], W.placement_what.value);
  const pgrow = el("div", "grow");
  pgrow.style.display = "flex"; pgrow.style.gap = "6px";
  whereSel.style.flex = "1"; whatSel.style.flex = "1.4";
  pgrow.appendChild(whereSel); pgrow.appendChild(whatSel);
  placeRow.appendChild(pgrow);
  wrap.appendChild(placeRow);

  const placement = document.createElement("input");
  placement.type = "text";
  placement.placeholder = "or type it: standing at the water's edge";
  placement.value = W.placement.value || "";
  wrap.appendChild(labelledRow("", placement));

  // ---- lighting + brightness ----------------------------------------------------------
  const lightSel = document.createElement("select");
  fillSelect(lightSel, W.lighting.options?.values || [], W.lighting.value);
  wrap.appendChild(labelledRow("Lighting", lightSel));

  const brightWrap = el("div", "rn-pf-slider");
  const brightRange = document.createElement("input");
  brightRange.type = "range";
  brightRange.min = String(W.brightness.options?.min ?? -3);
  brightRange.max = String(W.brightness.options?.max ?? 3);
  brightRange.step = "1";
  brightRange.value = String(W.brightness.value ?? 0);
  const brightVal = el("div", "rn-pf-val", "");
  brightWrap.appendChild(brightRange); brightWrap.appendChild(brightVal);
  wrap.appendChild(labelledRow("Brightness", brightWrap));

  const lac = document.createElement("textarea");
  lac.rows = 2;
  lac.placeholder = "palette and mood: muted slate and rust, quiet and still";
  lac.value = W.light_and_colour.value || "";
  wrap.appendChild(lac);

  // ---- notice + preview ----------------------------------------------------------------
  const note = el("div", "rn-pf-note ok", "");
  const out = el("div", "rn-pf-out", "");
  wrap.appendChild(note);
  wrap.appendChild(out);

  // ---- wiring ---------------------------------------------------------------------------
  const brightLabel = (v) => (v === 0 ? "neutral" : (v > 0 ? "+" : "") + v);

  function pushToWidgets() {
    W.style.value = styleSel.value;
    W.style_extra.value = styleExtra.value;
    W.subject.value = subject.value;
    W.surroundings.value = surroundings.value;
    W.framing.value = framings[Number(frameRange.value)] ?? W.framing.value;
    W.placement_where.value = whereSel.value;
    W.placement_what.value = whatSel.value;
    W.placement.value = placement.value;
    W.lighting.value = lightSel.value;
    W.brightness.value = Number(brightRange.value);
    W.light_and_colour.value = lac.value;
    frameVal.textContent = W.framing.value;
    brightVal.textContent = brightLabel(W.brightness.value);
  }

  function pullFromWidgets() {
    styleSel.value = W.style.value;
    styleExtra.value = W.style_extra.value || "";
    subject.value = W.subject.value || "";
    surroundings.value = W.surroundings.value || "";
    const fi = framings.indexOf(W.framing.value);
    if (fi >= 0) frameRange.value = String(fi);
    whereSel.value = W.placement_where.value;
    whatSel.value = W.placement_what.value;
    placement.value = W.placement.value || "";
    lightSel.value = W.lighting.value;
    brightRange.value = String(W.brightness.value ?? 0);
    lac.value = W.light_and_colour.value || "";
    frameVal.textContent = W.framing.value;
    brightVal.textContent = brightLabel(Number(brightRange.value));
  }

  // font size and colour follow the node's own widgets, which stay visible
  const LOOK = {};
  for (const n of LOOK_FIELDS) LOOK[n] = node.widgets?.find((w) => w.name === n);
  const textish = [styleExtra, subject, surroundings, placement, lac];
  function applyLook() {
    const px = Number(LOOK.font_size?.value) || 13;
    const col = COLORS[LOOK.text_color?.value] || "";
    for (const t of textish) {
      t.style.fontSize = px + "px";
      t.style.color = col || "";
    }
    out.style.fontSize = Math.max(10, px - 1) + "px";
  }
  for (const n of LOOK_FIELDS) {
    const w = LOOK[n];
    if (!w) continue;
    const prev = w.callback;
    w.callback = function () { prev?.apply(this, arguments); applyLook(); };
  }
  applyLook();

  let timer = null;
  async function preview() {
    try {
      const body = {};
      for (const name of FIELDS) body[name] = W[name].value;
      const r = await fetch("/rednode/prompt_frame_preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.error) return;
      // any __wildcard__ or @keyword still standing did not resolve: show which
      out.innerHTML = (j.prompt || "")
        .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
        .replace(/__[A-Za-z0-9_.\-\/*]+__/g, (m) => `<span class="rn-pf-wc">${m}</span>`)
        .replace(/(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/g, (m) => `<span class="rn-pf-kw">${m}</span>`);
      if (j.notice) { note.textContent = j.notice; note.className = "rn-pf-note on"; }
      else { note.textContent = `${j.words} words`; note.className = "rn-pf-note ok"; }
    } catch (e) { /* server not up */ }
  }

  function changed() {
    pushToWidgets();
    node.graph?.setDirtyCanvas(true, false);
    clearTimeout(timer);
    timer = setTimeout(preview, DEBOUNCE_MS);
  }

  for (const c of [styleSel, whereSel, whatSel, lightSel]) c.addEventListener("change", changed);
  for (const c of [styleExtra, subject, surroundings, placement, lac]) c.addEventListener("input", changed);
  for (const c of [frameRange, brightRange]) c.addEventListener("input", changed);
  // middle-click still pans the canvas
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button === 1) app.canvas?.processMouseDown?.(e);
  });

  // presets
  (async () => {
    try {
      const r = await fetch("/rednode/prompt_frame_presets");
      const j = await r.json();
      const names = Object.keys(j.presets || {});
      if (!names.length) return;
      fillSelect(presetSel, ["Load an example..."].concat(names), "Load an example...");
      presetBtn.addEventListener("click", () => {
        const p = (j.presets || {})[presetSel.value];
        if (!p) return;
        subject.value = p.subject || "";
        surroundings.value = p.surroundings || "";
        placement.value = p.placement || "";
        lac.value = p.light_and_colour || "";
        const fi = framings.indexOf(p.framing);
        if (fi >= 0) frameRange.value = String(fi);
        changed();
        if (p.note) { note.textContent = p.note; note.className = "rn-pf-note on"; }
      });
    } catch (e) { /* API not up */ }
  })();

  // every box you can drag, restored to the height you left it at
  for (const [key, box] of [["style_extra", styleExtra], ["subject", subject],
                            ["surroundings", surroundings], ["light_and_colour", lac],
                            ["preview", out]]) {
    keepSize(node, key, box);
  }

  const widget = node.addDOMWidget("prompt_frame_ui", "prompt_frame_ui", wrap, {
    getValue: () => "", setValue: () => {},
    getMinHeight: () => PANEL_MIN_H,
    serialize: false,           // keeps the panel out of the API prompt
  });
  widget.serialize = false;     // and out of widgets_values — the native widgets own that
  widget.element = wrap;
  widget.options.getMinHeight = () => PANEL_MIN_H;
  widget.options.minNodeSize = [360, PANEL_MIN_H + 40];
  node._rnPfPanel = widget;
  node._rnPfSync = pullFromWidgets;

  // move the panel to the front so the hidden widgets never draw above it
  const i = node.widgets.indexOf(widget);
  if (i > 0) { node.widgets.splice(i, 1); node.widgets.unshift(widget); }

  pushToWidgets();
  preview();

  const sz = node.computeSize();
  if (node.size[0] < 360) node.size[0] = 360;
  if (node.size[1] < sz[1]) node.size[1] = sz[1];
}

app.registerExtension({
  name: "RedNode.PromptFrame",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "RedNodePromptFrame") return;
    injectStyle();

    pinWidgetValues(nodeType, nodeData, (node) => node._rnPfSync?.());

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      requestAnimationFrame(() => buildPanel(this));
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => { buildPanel(this); this._rnPfSync?.(); });
    };
  },
});
