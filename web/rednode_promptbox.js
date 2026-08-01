import { app } from "../../scripts/app.js";

// RedNode Prompt Box — custom editor widget for the RedNodePromptBox node.
// A transparent <textarea> sits over a colored backdrop <div>; the backdrop renders the
// same text with highlighted __wildcards__ and @keywords. Per-node font size + text color.
//
// Widget lifecycle (pattern from ComfyUI-PromptChain): we do NOT remove the native "text"
// widget — removal leaves a ghost element in ComfyUI's DOM-widget store that renders as a
// stray label strip. Instead we HIDE the native widget (it still serializes the value to
// Python) and add our own DOM widget under a different name ("prompt_ui"), proxying the
// value to the hidden widget. Height comes from getMinHeight (type-agnostic layout).

const COLORS = {
  default: "", white: "#e8e8e8", green: "#9fe38b", amber: "#ffcf6b",
  cyan: "#7fd7e6", pink: "#f0a0d0", red: "#ff8a8a", blue: "#8ab4ff",
};

// __wildcard__  (letters/digits/_ . - / *, e.g. __hair/color__, __color*__)
const WILDCARD_RE = /__[A-Za-z0-9_.\-\/*]+__/g;
// @keyword sigil, only at a word start (skips emails)
const KEYWORD_RE = /(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/g;

let KNOWN = new Set();       // saved @keyword names, for highlight validation
const BOXES = new Set();     // live render callbacks, re-colored on library change
const KWCOMBOS = new Set();  // "insert keyword" combo refreshers

async function refreshKnown() {
  try {
    const r = await fetch("/rednode/prompts");
    const j = await r.json();
    KNOWN = new Set(Object.keys(j.keywords || {}));
  } catch (e) { /* library API not up yet */ }
  for (const render of BOXES) { try { render(); } catch (e) {} }
  for (const upd of KWCOMBOS) { try { upd(); } catch (e) {} }
}
window.addEventListener("rednode-prompts-dirty", refreshKnown);

const STYLE = `
.rn-pb-wrap {
  --comfy-widget-min-height: 160px;
  position: relative; box-sizing: border-box; overflow: hidden;
  border-radius: 6px;
  background: rgba(0,0,0,0.24);
  border: 1px solid rgba(255,255,255,0.13);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.35);
}
.rn-pb-back, .rn-pb-area {
  position: absolute; inset: 0; margin: 0;
  padding: 6px 8px; border: none; box-sizing: border-box;
  /* The caret and selection live in the (transparent) textarea while the text you SEE
     is painted by the div behind it. Every metric below must match on both layers or
     clicks land on the wrong character — a textarea does not inherit font-size, so it
     has to be stated explicitly. */
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 13px; font-weight: 400; font-style: normal;
  line-height: 1.35; letter-spacing: 0; word-spacing: 0; tab-size: 4;
  font-variant-ligatures: none; font-kerning: none;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word;
  overflow: auto;
  /* Both layers must have the SAME content width or they wrap at different points and
     the drift grows the further you read — which is what made clicks near the end of the
     box land on the wrong character. The textarea styles a 9px scrollbar while the div
     was using the browser default (~15px), and only when it happened to overflow.
     Reserving an identical gutter on both keeps the two in lockstep in every state. */
  scrollbar-gutter: stable;
}
.rn-pb-back, .rn-pb-area { scrollbar-width: thin; }
.rn-pb-back::-webkit-scrollbar { width: 9px; height: 9px; }
.rn-pb-back::-webkit-scrollbar-thumb { background: transparent; }
.rn-pb-back { pointer-events: none; z-index: 0; }
.rn-pb-area {
  z-index: 1; resize: none; background: transparent; color: transparent;
  caret-color: #ddd; outline: none;
}
.rn-pb-area::selection { background: rgba(120,160,255,0.35); }
.rn-pb-area::-webkit-scrollbar { width: 9px; height: 9px; }
.rn-pb-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 5px; }
.rn-pb-area::placeholder { color: rgba(200,200,200,0.35); }
.rn-pb-fold {
  position: absolute; top: 3px; right: 12px; z-index: 3;
  background: rgba(20,22,26,0.85); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 4px; color: #9aa0a8; cursor: pointer;
  font: 10px system-ui, sans-serif; line-height: 1; padding: 3px 6px;
}
.rn-pb-fold:hover { color: #fff; border-color: #b8283c; }
.rn-pb-wc { color: #8ab4ff; }
.rn-pb-kw { color: #9fe38b; }   /* no font-weight: it would change glyph widths */
.rn-pb-kw-unknown { color: #e0a35a; text-decoration: underline dotted; }
`;

function injectStyle() {
  if (document.getElementById("rn-pb-style")) return;
  const s = document.createElement("style");
  s.id = "rn-pb-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(text) {
  let out = escapeHtml(text);
  out = out.replace(WILDCARD_RE, (m) => `<span class="rn-pb-wc">${m}</span>`);
  out = out.replace(KEYWORD_RE, (m) => {
    const cls = KNOWN.has(m.slice(1)) ? "rn-pb-kw" : "rn-pb-kw-unknown";
    return `<span class="${cls}">${m}</span>`;
  });
  return out + "\n";
}

function reorder(node) {
  const w = node._rnBoxWidget;
  if (!w) return;
  const i = node.widgets.indexOf(w);
  if (i > 0) { node.widgets.splice(i, 1); node.widgets.unshift(w); }
}

function buildBox(node) {
  if (!node.addDOMWidget) return;
  if (node._rnBoxWidget) return; // already built

  // native "text" widget = the value holder. HIDE it (do not remove).
  const promptWidget = node.widgets?.find((w) => w.name === "text");
  if (!promptWidget) { requestAnimationFrame(() => buildBox(node)); return; }
  promptWidget.type = "hidden";
  promptWidget.hidden = true;
  promptWidget.computeSize = () => [0, -4];

  const wrap = document.createElement("div");
  wrap.className = "rn-pb-wrap";
  const back = document.createElement("div");
  back.className = "rn-pb-back";
  const area = document.createElement("textarea");
  area.className = "rn-pb-area";
  area.spellcheck = false;
  area.placeholder = "prompt...  __wildcard__  @keyword";
  area.value = promptWidget.value ?? "";
  wrap.appendChild(back);
  wrap.appendChild(area);

  const syncScroll = () => { back.scrollTop = area.scrollTop; back.scrollLeft = area.scrollLeft; };
  const render = () => { back.innerHTML = highlight(area.value); syncScroll(); };
  const syncFromWidget = () => { area.value = promptWidget.value ?? ""; render(); };

  const widget = node.addDOMWidget("prompt_ui", "prompt_ui", wrap, {
    getValue: () => promptWidget.value,
    setValue: (v) => { promptWidget.value = v ?? ""; syncFromWidget(); },
    getMinHeight: () => 160,
    serialize: false, // the hidden "text" widget owns serialization
  });
  widget._rnBox = true;
  widget.element = wrap;
  widget.options.getMinHeight = () => 160;
  widget.options.minNodeSize = [320, 240];
  node._rnBoxWidget = widget;

  area.addEventListener("input", () => { promptWidget.value = area.value; render(); promptWidget.callback?.(area.value); });
  area.addEventListener("scroll", syncScroll);
  area.addEventListener("pointerdown", (e) => { if (e.button === 1) app.canvas?.processMouseDown?.(e); });

  // The visible text (back layer) and the caret/selection (textarea) only line up while
  // both are laid out identically. Anything that changes geometry after creation — the
  // node being resized, a font finishing loading, the widget being built before the node
  // had its real size — leaves the two stale until something forces a reflow, which is
  // why a resize or a workflow switch "fixed" it. Re-sync on those events instead.
  const resync = () => { render(); syncScroll(); };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => resync());
    ro.observe(wrap);
    widget._rnObserver = ro;                    // kept so it is not garbage collected
  }
  document.fonts?.ready?.then(resync).catch(() => {});
  requestAnimationFrame(resync);                // first layout pass after the node exists
  area.addEventListener("focus", resync);

  // insert a token at the caret (used by the wildcard / keyword dropdowns)
  const insertAtCursor = (snippet) => {
    const s = area.selectionStart ?? area.value.length;
    const e = area.selectionEnd ?? s;
    area.value = area.value.slice(0, s) + snippet + area.value.slice(e);
    const pos = s + snippet.length;
    area.selectionStart = area.selectionEnd = pos;
    promptWidget.value = area.value;
    render();
    area.focus();
  };

  // "insert wildcard" dropdown — lists your wildcard files, drops __name__ at the caret
  const wcW = node.addWidget("combo", "＋ wildcard", "", (v) => {
    if (v) { insertAtCursor(`__${v}__`); wcW.value = ""; }
  }, { values: [""] });
  wcW.serialize = false;
  fetch("/rednode/wildcards").then((r) => r.json()).then((j) => {
    wcW.options.values = [""].concat(j.names || []);
    node.setDirtyCanvas(true, true);
  }).catch(() => {});

  // "insert keyword" dropdown — lists saved @keywords, drops @name at the caret
  const kwW = node.addWidget("combo", "＋ keyword", "", (v) => {
    if (v) { insertAtCursor(`@${v}`); kwW.value = ""; }
  }, { values: [""] });
  kwW.serialize = false;
  const refreshKw = () => { kwW.options.values = [""].concat([...KNOWN].sort()); };
  refreshKw();
  KWCOMBOS.add(refreshKw);
  // fetch the list fresh on build (like the wildcard dropdown) so it's always fully
  // populated and searchable, not dependent on the shared cache being ready yet
  fetch("/rednode/prompts").then((r) => r.json()).then((j) => {
    KNOWN = new Set(Object.keys(j.keywords || {}));
    refreshKw();
    node.setDirtyCanvas(true, true);
  }).catch(() => {});

  // Collapse the tool widgets (wildcard/keyword dropdowns, font size, colour) so the node
  // is just the text box. State rides in node.properties, which serialises with the
  // workflow WITHOUT taking a widget slot — adding a widget here would shift the saved
  // widget order of every existing Prompt Box.
  const toolsHidden = () => !!node.properties?.rn_tools_hidden;
  const applyFold = () => {
    const hide = toolsHidden();
    for (const w of node.widgets || []) {
      if (w === widget || w === promptWidget) continue;      // the box and its value holder
      if (hide) {
        if (w._rnFoldOrig === undefined) {
          w._rnFoldOrig = { type: w.type, computeSize: w.computeSize, hidden: w.hidden };
        }
        w.type = "hidden";
        w.hidden = true;
        w.computeSize = () => [0, -4];
        if (w.element) w.element.style.display = "none";
      } else if (w._rnFoldOrig) {
        w.type = w._rnFoldOrig.type;
        w.hidden = w._rnFoldOrig.hidden;
        w.computeSize = w._rnFoldOrig.computeSize;
        if (w.element) w.element.style.display = "";
        delete w._rnFoldOrig;
      }
    }
    fold.textContent = hide ? "▸ tools" : "▾ tools";
    fold.title = hide ? "show the wildcard / keyword / style controls"
                      : "hide the controls — just the prompt box";
    // Folding must NOT resize the node — the box simply grows into the space the
    // tools gave up, and gives it back on unfold. Only exception: unfolding into a
    // node too short to hold the tools at all, where they would otherwise overlap.
    if (!hide) {
      const min = node.computeSize()[1];
      if (node.size[1] < min) node.setSize([node.size[0], min]);
    }
    node.setDirtyCanvas(true, true);
  };
  const fold = document.createElement("button");
  fold.className = "rn-pb-fold";
  fold.onclick = (e) => {
    e.stopPropagation();
    node.properties = node.properties || {};
    node.properties.rn_tools_hidden = !toolsHidden() || undefined;
    applyFold();
  };
  wrap.appendChild(fold);
  node._rnApplyFold = applyFold;

  const applyStyle = () => {
    const fs = node.widgets.find((w) => w.name === "font_size")?.value ?? 16;
    const col = node.widgets.find((w) => w.name === "text_color")?.value ?? "default";
    const hex = COLORS[col] || "var(--input-text, #dddddd)";
    for (const el of [back, area]) el.style.fontSize = fs + "px";
    back.style.color = hex;
    area.style.caretColor = hex;
  };
  for (const name of ["font_size", "text_color"]) {
    const w = node.widgets.find((x) => x.name === name);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function () { prev?.apply(this, arguments); applyStyle(); render(); };
  }

  reorder(node);

  node._rnPromptBox = { applyStyle, render, syncFromWidget };
  BOXES.add(render);
  const onRemoved = node.onRemoved;
  node.onRemoved = function () { BOXES.delete(render); KWCOMBOS.delete(refreshKw); onRemoved?.apply(this, arguments); };

  applyStyle();
  applyFold();                       // honour the saved collapsed state
  render();
  requestAnimationFrame(() => { syncFromWidget(); applyStyle(); applyFold(); });
}

app.registerExtension({
  name: "rednode.promptbox",
  async setup() { refreshKnown(); },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "RedNodePromptBox") return;
    injectStyle();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      injectStyle();
      buildBox(this);
      const w = Math.max(this.size?.[0] || 0, 340);
      const h = Math.max(this.size?.[1] || 0, 280);
      this.setSize([w, h]);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => {
        this._rnPromptBox?.syncFromWidget();
        this._rnPromptBox?.applyStyle();
        this._rnApplyFold?.();       // a loaded workflow keeps its tools folded
      });
    };
  },
});
