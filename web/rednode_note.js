import { app } from "../../scripts/app.js";

// RedNode Note — a canvas label drawn as a sign rather than a text box.
//
// ONE BOX, AND IT IS COMFYUI'S OWN. Two earlier goes at this both added a second styled
// element and then tried to hide the native multiline field behind it. That fight cannot
// be won: a DOM widget's visibility comes from ComfyUI's reactive store, which is
// re-rendered every frame and paints over anything set from here, so the plain box kept
// reappearing above the sign saying the same words twice. Styling the native textarea
// instead means there is nothing to hide, typing is the browser's own, and the value
// that gets saved is the one being edited.
//
// UNSELECTED it is only the sign: no title bar, no settings rows, no caret. Click it and
// the ordinary node comes back. A workflow full of these reads as labelled sections
// rather than as more nodes.

const NODE_NAME = "RedNodeNote";

// each entry is [text, glow]. The glow sits brighter than the fill so the bloom reads as
// light coming off the letters rather than as a blurred copy of them.
const COLORS = {
  red: ["#ff8a99", "#b8283c"],        // the pack's own red
  violet: ["#c4a0ff", "#a855f7"],
  cyan: ["#a5f3fc", "#22d3ee"],
  amber: ["#fde68a", "#f59e0b"],
  lime: ["#d9f99d", "#84cc16"],
  rose: ["#fecdd3", "#f43f5e"],
  blue: ["#bfdbfe", "#3b82f6"],
  white: ["#ffffff", "#cbd5e1"],
};

const css = document.createElement("style");
css.textContent = `
/* contain:paint bounds what a glow can dirty, and keeps the text inside the box */
.rn-note-sign{text-align:center;font-weight:600;letter-spacing:.5px;line-height:1.18;
  border-radius:8px;resize:none;contain:paint}
/* unselected the sign is a picture, not a field: no caret, no scrollbar, and clicks
   reach the node underneath so it still selects and drags like any other node */
.rn-note-idle{pointer-events:none;overflow:hidden!important;caret-color:transparent}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const widget = (node, name) => (node.widgets || []).find((w) => w.name === name);

// THE LOOK LIVES IN PROPERTIES, NOT WIDGETS. Widgets cannot be reliably hidden from a
// plugin: ComfyUI renders them through its own layer, and display, `hidden`, `type` and
// `computeSize` are all advisory, which three separate attempts to fold them away each
// discovered. A property is never rendered as a row, so there is nothing to hide, and
// the settings live on RedNode Note Panel where they belong.
export const NOTE_LOOK = {
  font_size: 40, font: "Consolas", color: "red", glow: 55,
  backdrop: "painted", custom_font: "", custom_color: "#b8283c",
};
// the order these were in when they were widgets, so a note saved back then keeps its
// look: widgets_values[0] is the text and the rest follow in INPUT_TYPES order
const LEGACY_ORDER = ["font_size", "font", "color", "glow", "backdrop",
                      "custom_font", "custom_color"];

export function look(node, name) {
  const v = node.properties?.[name];
  return v === undefined || v === "" ? NOTE_LOOK[name] : v;
}
const valOf = (node, name, fallback) => {
  const v = look(node, name);
  return v === undefined ? fallback : v;
};

/** Carry a note styled when these were widgets over to properties, once. */
function migrate(node) {
  node.properties = node.properties || {};
  if (node.properties.rn_note_migrated) return;
  node.properties.rn_note_migrated = true;
  const saved = node.widgets_values;
  if (!Array.isArray(saved) || saved.length < 2) return;
  LEGACY_ORDER.forEach((key, i) => {
    const v = saved[i + 1];
    if (v !== undefined && v !== null && v !== "" && node.properties[key] === undefined) {
      node.properties[key] = v;
    }
  });
}

const alwaysShows = (node) => !!node.properties?.rn_note_controls;
// A page of instructions is a document, not a sign. Explicit, because which one a note
// is meant to be cannot be read off its contents.
const isPlain = (node) => !!node.properties?.rn_note_plain;

function isSelected(node) {
  // LiteGraph marks the node itself AND keeps a map on the canvas, and which one is
  // authoritative has moved between frontend versions, so read both.
  if (node.selected || node.is_selected) return true;
  const sel = app.canvas?.selected_nodes;
  return !!(sel && sel[node.id]);
}

/** ComfyUI's own textarea for the `note` widget, whatever it is wrapped in. */
function areaOf(node) {
  if (node._rnNoteArea?.isConnected) return node._rnNoteArea;
  const w = widget(node, "note");
  let el = w?.element || w?.inputEl;
  if (el && el.tagName !== "TEXTAREA") el = el.querySelector?.("textarea") || el;
  node._rnNoteArea = el || null;
  return node._rnNoteArea;
}

function coloursFor(node) {
  const pick = String(valOf(node, "color", "red"));
  if (pick === "custom") {
    const hex = String(valOf(node, "custom_color", "")).trim();
    // a half-typed hex must not blank the sign out mid-keystroke
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return [hex, hex];
    return COLORS.red;
  }
  return COLORS[pick] || COLORS.red;
}

function fontFor(node) {
  const pick = String(valOf(node, "font", "Consolas"));
  const family = pick === "custom"
    ? (String(valOf(node, "custom_font", "")).trim() || "Consolas")
    : pick;
  return `"${family}", Consolas, monospace`;
}

/** Push every setting onto ComfyUI's textarea. Cheap enough to run on any change. */
function paint(node) {
  const area = areaOf(node);
  if (!area) return;
  const plain = isPlain(node);
  area.classList.add("rn-note-sign");
  if (plain) {
    // hand it back: an ordinary field, styled by ComfyUI as it always was
    for (const k of ["fontSize", "fontFamily", "color", "textAlign", "textShadow",
                     "background", "border"]) area.style[k] = "";
    area.classList.remove("rn-note-sign");
    return;
  }
  const [fill, glowCol] = coloursFor(node);
  const glow = Math.max(0, Math.min(100, Number(valOf(node, "glow", 55)) || 0));
  const backdrop = String(valOf(node, "backdrop", "painted"));

  area.style.fontSize = `${Math.max(8, Number(valOf(node, "font_size", 40)) || 40)}px`;
  area.style.fontFamily = fontFor(node);
  area.style.color = fill;
  area.style.textAlign = "center";
  // Radii are CAPPED. A blur is re-rasterised on every pan and zoom and costs more the
  // wider it is, and 40px is past the point where wider reads as anything but dimmer.
  const r = (mult, cap) => Math.min(glow * mult, cap).toFixed(1);
  area.style.textShadow = glow
    ? `0 0 ${r(0.10, 10)}px ${glowCol}, 0 0 ${r(0.26, 26)}px ${glowCol}, `
      + `0 0 ${r(0.55, 40)}px ${glowCol}`
    : "none";
  area.style.background = backdrop === "painted" ? "#0b0c0e" : "transparent";
  area.style.border = backdrop === "transparent" ? "0"
                    : `1px solid ${fill}${backdrop === "outline" ? "66" : "33"}`;
}

function setChrome(node, shown) {
  if (node._rnNoteChrome === shown) return;
  node._rnNoteChrome = shown;
  node.title_mode = shown ? 0 : 2;              // LiteGraph NORMAL_TITLE / NO_TITLE
  areaOf(node)?.classList.toggle("rn-note-idle", !shown && !isPlain(node));
}

/** Re-read the widgets whenever one of them changes. */
function hookWidgets(node) {
  for (const w of node.widgets || []) {
    if (w._rnNoteHooked) continue;
    w._rnNoteHooked = true;
    const cb = w.callback;
    w.callback = function () {
      const out = cb?.apply(this, arguments);
      paint(node);
      return out;
    };
  }
}

app.registerExtension({
  name: "rednode.note",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const start = (node) => {
      injectStyle();
      migrate(node);
      hookWidgets(node);
      // the panel edits properties, so it needs a way to make the sign follow
      node._rnNotePaint = () => paint(node);
      node._rnNoteChrome = undefined;
      // the textarea is not in the DOM on the frame the node is created
      requestAnimationFrame(() => { paint(node); node.setDirtyCanvas?.(true, true); });
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      // signs are read at a distance, so the default is a size worth reading
      if (this.size[0] < 320) this.size[0] = 320;
      if (this.size[1] < 190) this.size[1] = 190;
      start(this);
    };

    // nothing is drawn here; this is only where the selection is noticed
    const onDrawFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDrawFg?.apply(this, arguments);
      if (this.flags?.collapsed) return;
      setChrome(this, isPlain(this) || isSelected(this) || alwaysShows(this));
    };

    const onMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      onMenu?.apply(this, arguments);
      const node = this;
      const flip = (key, after) => () => {
        node.properties = node.properties || {};
        node.properties[key] = node.properties[key] ? undefined : true;
        node._rnNoteChrome = undefined;          // force the next draw to re-apply
        after?.();
        node.setDirtyCanvas?.(true, true);
      };
      options.push({
        content: isPlain(node) ? "Show it as a sign" : "Show it as a plain text box",
        callback: flip("rn_note_plain", () => paint(node)),
      });
      options.push({
        content: alwaysShows(node) ? "Hide the controls unless selected"
                                   : "Always show the controls",
        callback: flip("rn_note_controls"),
      });
      return options;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      start(this);
    };
  },
});
