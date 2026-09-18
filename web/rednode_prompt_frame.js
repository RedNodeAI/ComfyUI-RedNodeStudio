import { app } from "../../scripts/app.js";
import { buildStudio, cameraFromFrame } from "./rednode_camera_studio.js";
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
  "lighting", "brightness", "light_and_colour", "framing_push", "camera_height",
  "camera", "camera_off", "extra",
];

const STYLE = `
.rn-pf .rn-pf-off{opacity:.35;pointer-events:none}
.rn-pf .rn-pf-headgrp{display:flex;align-items:center;gap:8px;padding:6px 12px;
  border:1px solid rgba(255,255,255,0.12);border-radius:6px;background:rgba(0,0,0,0.18)}
.rn-pf .rn-pf-headgrp .rn-pf-btn{white-space:nowrap;padding:6px 10px}
.rn-pf .rn-pf-headgrp select{min-width:150px}
.rn-pf .rn-pf-headcap{font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  color:#8a919b;margin-right:2px;white-space:nowrap}
.rn-pf .rn-pf-snip{display:flex;align-items:center;gap:6px;margin-top:4px}
.rn-pf .rn-pf-snip select{flex:1;min-width:0}
.rn-pf .rn-pf-snip .rn-pf-btn{flex:none}
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
.rn-pf-toolsbar { justify-content: flex-end; }

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
  box-sizing: border-box; width: 100%; min-height: 72px;
  padding: 6px 8px; background: var(--rn-bg); color: #e2e5ea;
  border: 1px solid var(--rn-line); border-radius: 5px;
  font: inherit; font-size: var(--rn-pf-font, 13px); line-height: 1.35;
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
/* collapsible groups: caret first, title, hint trailing, per the house convention */
/* the 2026-08-16 skin, from the user's mock: each section a dark card with
   an accent icon, the title, and its hint inline; the caret is quiet */
.rn-pf-box { border: 1px solid #2a2e34; border-radius: 8px;
  background: #16181c; }
.rn-pf-box > .head { display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; cursor: pointer; user-select: none; }
.rn-pf-box > .head .car { width: 12px; color: #4a5058; font-size: 11px; order: 9;
  margin-left: auto; }
.rn-pf-box > .head .ico { font-size: 14px; color: #b8283c; flex: none; width: 18px;
  text-align: center; }
.rn-pf-box > .head .rn-pf-presets { margin-left: auto; }
.rn-pf-box > .head .rn-pf-presets + .car { margin-left: 6px; }
.rn-pf-box > .head b { font-size: 13.5px; color: #e8ecf1; }
.rn-pf-box > .head .hint2 { font-size: 12px; color: #7f8792; }
.rn-pf-box > .head:hover .car { color: #fff; }
.rn-pf-box > .body { display: flex; flex-direction: column; gap: 8px;
  padding: 2px 12px 12px; }
.rn-pf-sublabel { font-size: 11px; font-weight: 700; letter-spacing: .05em;
  color: #8f97a3; text-transform: uppercase; margin-top: 4px; }
.rn-pf-studio { grid-column: 1 / -1; width: 100%; }
.rn-pf-btn.on { background: #b8283c; border-color: #b8283c; color: #fff; }
.rn-pf-seg { display: inline-flex; background: #15171b; border: 1px solid #33373d; border-radius: 6px; padding: 2px; gap: 2px; }
.rn-pf-segb { background: none; border: 0; border-radius: 4px; color: #9aa0a8; cursor: pointer; font-size: 12px; padding: 4px 12px; }
.rn-pf-segb.on { background: #b8283c; color: #fff; }
.rn-pf { container-type: inline-size; }
.rn-pf-cols { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,1fr) minmax(0,.95fr);
  gap: 10px; align-items: start; }
/* the writing column spans two rows, so the tools and the Anything else box fill
   the space under the camera and the preview instead of sitting under everything */
.rn-pf-cols > .rn-pf-col:first-child { grid-row: 1 / span 2; }
.rn-pf-under { grid-column: 2 / -1; display: flex; flex-direction: column; gap: 8px;
  min-width: 0; }
@container (max-width: 980px) {
  .rn-pf-cols { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
  .rn-pf-cols > .rn-pf-col:first-child { grid-row: auto; }
  .rn-pf-under { grid-column: 1 / -1; }
}
.rn-pf-live { margin-left: auto; font-size: 11.5px; color: #9fe0b4; display: inline-flex;
  align-items: center; gap: 6px; }
.rn-pf-live::before { content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: #22c55e; box-shadow: 0 0 6px #22c55e; }
/* THE PREVIEW IS OUTPUT, NOT A BOX TO TYPE IN. Under the Anything else box it
   read as one more textarea, so it is lifted instead of sunk: a lighter card
   than the inputs, the pack's red down its left edge like the notice above it,
   and the text at full brightness. The drag corner stays, since a long prompt
   still wants pulling taller. */
.rn-pf-pvbox { background: #1a1d22; border-color: #343a44; }
.rn-pf-pvbox .rn-pf-out { height: 240px; min-height: 120px; max-height: none;
  font-size: var(--rn-pf-font, 13px);
  line-height: 1.55; color: #e6e9ee;
  background: #21262e; border: 1px solid #3c4450; border-left: 3px solid #b8283c;
  border-radius: 6px; padding: 10px 12px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
.rn-pf-pvbox .rn-pf-note.on { border: 1px solid #b8283c; border-left-width: 3px;
  background: #26161a; border-radius: 6px; padding: 8px 10px; color: #f3b0ba;
  font-weight: 600; }
.rn-pf-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rn-pf-expand { position: absolute; top: 4px; right: 6px; z-index: 2;
  background: #15171bcc; border: 1px solid #33373d; border-radius: 4px;
  color: #9aa0a8; cursor: pointer; font-size: 11px; padding: 1px 5px; }
.rn-pf-expand:hover { border-color: #b8283c; color: #fff; }
/* the character counter under a text field, right-aligned and dim */
.rn-pf-count { text-align: right; font-size: 10.5px; color: #6b7280; margin-top: -4px; }
/* the framing chips, the mock's Portrait / Landscape / Square row */
.rn-pf-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.rn-pf-chip { flex: 1 1 90px; display: flex; flex-direction: column; align-items: center;
  gap: 1px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
  background: #101216; border: 1px solid #2a2e34; color: #c8ccd2; font-size: 12px; }
.rn-pf-chip small { font-size: 10.5px; color: #7f8792; }
.rn-pf-chip.on { border-color: #b8283c; background: #b8283c; color: #fff; }
/* the preview panel: the mock's right column */
.rn-pf-out { min-height: 120px; }
.rn-pf-outwrap { display: flex; flex-direction: column; gap: 6px; }
.rn-pf-outbar { display: flex; gap: 6px; justify-content: flex-end; }
.rn-pf-outbar button { background: #15171b; border: 1px solid #33373d; color: #c8ccd2;
  border-radius: 5px; padding: 4px 9px; cursor: pointer; font-size: 12px; }
.rn-pf-outbar button:hover { border-color: #b8283c; color: #fff; }

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

export function keepSize(node, key, box) {
  const saved = node.properties?.[SIZES]?.[key];
  if (typeof saved === "number" && saved > 0) box.style.height = saved + "px";
  if (typeof ResizeObserver !== "function") return;

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

// THE WHOLE FRAME EDITOR, host-agnostic: the node's panel and the Workspace's
// Prompts tab both call this, so there is exactly one implementation of the thing
// you keep asking for by name. F is the value store: get/set by field name,
// opts for the dropdown lists, dirty() when something changed, onPreview(prompt,
// notice) when the server has assembled the live prompt.
export function buildFrameEditor(wrap, F) {
  injectStyle();
  wrap.classList.add("rn-pf");

  // ---- head: presets ------------------------------------------------------------
  const head = el("div", "rn-pf-head");
  head.appendChild(el("span", "ttl", "Prompt Frame"));
  // THE HEAD LINE carries the title and the saved prompts (whole frames, load
  // and save) and sits at the top of the editor. The tools (Auto sort, the
  // rewrite, Clear) get a bar of their own right above the preview: they act
  // on the text and their result shows there.
  const grpSaved = el("div", "rn-pf-headgrp");
  grpSaved.appendChild(el("span", "rn-pf-headcap", "Saved prompts"));
  const grpTools = el("div", "rn-pf-headgrp");
  grpTools.appendChild(el("span", "rn-pf-headcap", "Tools"));
  head.appendChild(grpSaved);
  const toolsBar = el("div", "rn-pf-head rn-pf-toolsbar");
  toolsBar.appendChild(grpTools);
  const presetSel = document.createElement("select");
  presetSel.style.maxWidth = "180px";
  fillSelect(presetSel, ["Load prompts..."], "Load prompts...");
  presetSel.title = "A saved prompt: every field of the frame at once. Yours and the "
                  + "shipped examples.";
  const presetBtn = el("button", "rn-pf-btn", "Load");
  presetBtn.title = "Load the chosen saved prompt into every box.";
  grpSaved.appendChild(presetSel);
  grpSaved.appendChild(presetBtn);
  // AUTO SORT: the same Ollama the auto prompt leans on reads
  // every box and puts each phrase where it belongs - a lumped prompt tidied
  // into Style, Subject, Surroundings, Light and placement in one press.
  // The host names the model (F.sortModel); without one the button says so.
  const sortBtn = el("button", "rn-pf-btn", "✨ Auto sort");
  sortBtn.title = "Reorganise what is written across the boxes into the right "
                + "boxes, keeping every phrase (moves and light tidying only, "
                + "nothing invented, nothing dropped). Uses the Ollama model "
                + "chosen on the Auto Prompt section.";
  sortBtn.addEventListener("click", async () => {
    const model = F.sortModel?.() || "";
    if (!model) {
      sortBtn.textContent = "pick an Auto Prompt model first";
      setTimeout(() => { sortBtn.textContent = "✨ Auto sort"; }, 2200);
      return;
    }
    sortBtn.disabled = true;
    sortBtn.textContent = "sorting…";
    try {
      const fields = {
        subject: subject.value, surroundings: surroundings.value,
        style_extra: styleExtra.value, light_and_colour: lac.value,
        placement: placement.value, extra: extra.value,
      };
      const r = await fetch("/rednode/prompt_sort", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, url: F.sortUrl?.() || "", fields }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      const f = j.fields || {};
      subject.value = f.subject ?? subject.value;
      surroundings.value = f.surroundings ?? surroundings.value;
      styleExtra.value = f.style_extra ?? styleExtra.value;
      lac.value = f.light_and_colour ?? lac.value;
      placement.value = f.placement ?? placement.value;
      extra.value = "";                      // every phrase of it was filed into a box
      extra._rnCount?.();
      if (f.style && [...styleSel.options].some((o) => o.value === f.style)) {
        styleSel.value = f.style;
      }
      if (f.lighting && [...lightSel.options].some((o) => o.value === f.lighting)) {
        lightSel.value = f.lighting;
      }
      changed();
      pullFromWidgets();
      sortBtn.textContent = "sorted";
    } catch (e) {
      sortBtn.textContent = "sort failed";
      console.warn("[RedNode Prompt Frame] auto sort:", e);
    } finally {
      sortBtn.disabled = false;
      setTimeout(() => { sortBtn.textContent = "✨ Auto sort"; }, 1800);
    }
  });
  grpTools.appendChild(sortBtn);
  // REWRITE: the same model as a writer. Every fact stays, the wording gets
  // concrete, and the style tag beside it says what kind of picture it is for.
  // The result lands back in the boxes for editing, never straight to the queue.
  const rwStyle = document.createElement("select");
  rwStyle.style.maxWidth = "190px";
  for (const [v, t] of [["keep", "Keep the style as written"], ["photoreal", "As a photograph"],
                        ["cinematic", "As a film still"], ["illustration", "As an illustration"]]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    rwStyle.appendChild(o);
  }
  rwStyle.value = "keep";
  rwStyle.title = "What the rewrite writes for. Keep leaves the medium and style as you "
                + "wrote them and only tightens the wording; the others add the words "
                + "of that kind of picture.";
  const rwBtn = el("button", "rn-pf-btn", "✍ Rewrite");
  rwBtn.title = "Rewrite what is in the boxes so it reads well for the model: every "
              + "fact kept, the wording made concrete, in the style picked beside "
              + "it. Uses the Ollama model chosen on the Auto Prompt section. The "
              + "result comes back into the boxes for you to edit.";
  rwBtn.addEventListener("click", async () => {
    const model = F.sortModel?.() || "";
    if (!model) {
      rwBtn.textContent = "pick an Auto Prompt model first";
      setTimeout(() => { rwBtn.textContent = "✍ Rewrite"; }, 2200);
      return;
    }
    rwBtn.disabled = true;
    rwBtn.textContent = "rewriting…";
    try {
      const fields = {
        subject: subject.value, surroundings: surroundings.value,
        style_extra: styleExtra.value, light_and_colour: lac.value,
        placement: placement.value, extra: extra.value,
      };
      const r = await fetch("/rednode/prompt_rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, url: F.sortUrl?.() || "", fields,
                               style: rwStyle.value }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      const f = j.fields || {};
      subject.value = f.subject ?? subject.value;
      surroundings.value = f.surroundings ?? surroundings.value;
      styleExtra.value = f.style_extra ?? styleExtra.value;
      lac.value = f.light_and_colour ?? lac.value;
      placement.value = f.placement ?? placement.value;
      extra.value = "";                      // its facts were folded into the boxes
      extra._rnCount?.();
      changed();
      pullFromWidgets();
      rwBtn.textContent = "rewritten";
    } catch (e) {
      rwBtn.textContent = "rewrite failed";
      console.warn("[RedNode Prompt Frame] rewrite:", e);
    } finally {
      rwBtn.disabled = false;
      setTimeout(() => { rwBtn.textContent = "✍ Rewrite"; }, 1800);
    }
  });
  grpTools.appendChild(el("span", "rn-pf-headcap", "Rewrite as"));
  grpTools.appendChild(rwStyle);
  grpTools.appendChild(rwBtn);
  // CLEAR: every box empty and the two presets back to None in one press, with
  // one question first, because there is no undo for a cleared prompt
  const clearBtn = el("button", "rn-pf-btn", "Clear");
  clearBtn.title = "Empty every box of this frame (style wording, subject, surroundings, "
                 + "placement, light and colour) and set Style and Lighting back to None. "
                 + "The camera, framing and brightness stay as they are.";
  clearBtn.addEventListener("click", () => {
    if (!window.confirm("Clear every box of this prompt?")) return;
    styleSel.value = (F.opts.style || [])[0] ?? "None";
    styleExtra.value = "";
    subject.value = "";
    surroundings.value = "";
    placement.value = "";
    extra.value = "";
    lightSel.value = (F.opts.lighting || [])[0] ?? "None";
    lac.value = "";
    for (const ta of [styleExtra, subject, surroundings, placement, lac]) ta._rnCount?.();
    pushToWidgets();
    changed();
  });
  grpTools.appendChild(clearBtn);

  // ---- style --------------------------------------------------------------------
  const styleSel = document.createElement("select");
  fillSelect(styleSel, F.opts.style || [], F.get("style"));
  const styleRow = labelledRow("Style", styleSel);

  const styleExtra = document.createElement("textarea");
  styleExtra.rows = 3;
  styleExtra.placeholder = "your own style wording (optional)";
  styleExtra.value = F.get("style_extra") || "";

  // ---- subject / surroundings -----------------------------------------------------
  const subject = document.createElement("textarea");
  subject.rows = 6;
  subject.placeholder = "a woman in her thirties, red waterproof jacket, rucksack";
  subject.value = F.get("subject") || "";

  const surroundings = document.createElement("textarea");
  surroundings.rows = 5;
  surroundings.placeholder = "a mountain ridge under heavy cloud, wet black rock, a thin path";
  surroundings.value = F.get("surroundings") || "";

  // ---- framing slider --------------------------------------------------------------
  const framings = F.opts.framing || [];
  const frameWrap = el("div", "rn-pf-slider");
  const frameRange = document.createElement("input");
  frameRange.type = "range";
  frameRange.min = "0"; frameRange.max = String(Math.max(0, framings.length - 1));
  frameRange.step = "1";
  frameRange.value = String(Math.max(0, framings.indexOf(F.get("framing"))));
  const frameVal = el("div", "rn-pf-val", F.get("framing"));
  frameWrap.appendChild(frameRange); frameWrap.appendChild(frameVal);
  // the chips are the control; the range stays underneath, unseen, because the
  // chips write through it and the studio listens to it
  frameWrap.style.display = "none";
  const frameChips = el("div", "rn-pf-chips");
  const drawChips = () => {
    frameChips.replaceChildren();
    const curF = framings[Number(frameRange.value)] ?? F.get("framing");
    framings.forEach((f, i) => {
      const c = el("div", "rn-pf-chip" + (curF === f ? " on" : ""));
      c.appendChild(el("span", null, f));
      c.title = "Set the framing to " + f + ".";
      c.addEventListener("click", () => {
        frameRange.value = String(i);
        frameRange.dispatchEvent(new Event("input", { bubbles: true }));
      });
      frameChips.appendChild(c);
    });
  };
  drawChips();
  frameRange.addEventListener("input", drawChips);


  // ---- camera height: the same chips + slider as the framing, right beneath it.
  // Framing is zoom; this is where the camera stands, ground to overhead.
  const heights = (F.opts.camera_height && F.opts.camera_height.length)
    ? F.opts.camera_height
    : ["Worm's eye", "Low angle", "Slight low", "Eye level", "Slight high",
       "High angle", "Bird's eye"];
  const camChips = el("div", "rn-pf-chips");
  const camWrap = el("div", "rn-pf-slider");
  const camRange = document.createElement("input");
  camRange.type = "range";
  camRange.min = "0"; camRange.max = String(Math.max(0, heights.length - 1));
  camRange.step = "1";
  camRange.value = String(Math.max(0, heights.indexOf(F.get("camera_height") || "Eye level")));
  const camVal = el("div", "rn-pf-val", F.get("camera_height") || "Eye level");
  camWrap.appendChild(camRange); camWrap.appendChild(camVal);
  camWrap.style.display = "none";
  const shotLabel = el("div", "rn-pf-sublabel", "Shot size");
  shotLabel.title = "How much of the subject fills the frame, tight to wide - the "
                  + "camera's distance and lens. Portrait is close, Roomscale is far.";
  const camLabel = el("div", "rn-pf-sublabel", "Camera height");
  const drawCamChips = () => {
    camChips.replaceChildren();
    const cur = heights[Number(camRange.value)] ?? (F.get("camera_height") || "Eye level");
    heights.forEach((h, i) => {
      const c = el("div", "rn-pf-chip" + (cur === h ? " on" : ""));
      c.appendChild(el("span", null, h));
      c.title = "Camera at " + h.toLowerCase() + ".";
      c.addEventListener("click", () => {
        camRange.value = String(i);
        camRange.dispatchEvent(new Event("input", { bubbles: true }));
      });
      camChips.appendChild(c);
    });
  };
  drawCamChips();
  camRange.addEventListener("input", drawCamChips);

  // Directly under the slider, because it does nothing except make that slider louder.
  const pushRow = el("div", "rn-pf-row");
  pushRow.appendChild(el("label", null, "Push"));
  const pushSel = document.createElement("select");
  fillSelect(pushSel, F.opts.framing_push || [], F.get("framing_push"));
  pushSel.title = F.opts.push_tooltip || "";
  pushSel.className = "grow";
  pushRow.appendChild(pushSel);

  // ---- placement --------------------------------------------------------------------
  const placeRow = el("div", "rn-pf-row");
  placeRow.appendChild(el("label", null, "Placement"));
  const whereSel = document.createElement("select");
  const whatSel = document.createElement("select");
  fillSelect(whereSel, F.opts.placement_where || [], F.get("placement_where"));
  fillSelect(whatSel, F.opts.placement_what || [], F.get("placement_what"));
  const pgrow = el("div", "grow");
  pgrow.style.display = "flex"; pgrow.style.gap = "6px";
  whereSel.style.flex = "1"; whatSel.style.flex = "1.4";
  pgrow.appendChild(whereSel); pgrow.appendChild(whatSel);
  placeRow.appendChild(pgrow);

  const placement = document.createElement("textarea");
  placement.rows = 2;
  placement.placeholder = "where the subject stands in the scene: standing at the water's edge";
  placement.value = F.get("placement") || "";

  // ---- lighting + brightness ----------------------------------------------------------
  const lightSel = document.createElement("select");
  fillSelect(lightSel, F.opts.lighting || [], F.get("lighting"));
  const lightRow = labelledRow("Lighting", lightSel);

  const brightWrap = el("div", "rn-pf-slider");
  const brightRange = document.createElement("input");
  brightRange.type = "range";
  brightRange.min = String(F.opts.brightness_min ?? -3);
  brightRange.max = String(F.opts.brightness_max ?? 3);
  brightRange.step = "1";
  brightRange.value = String(F.get("brightness") ?? 0);
  const brightVal = el("div", "rn-pf-val", "");
  brightWrap.appendChild(brightRange); brightWrap.appendChild(brightVal);
  const brightRow = labelledRow("Brightness", brightWrap);

  const lac = document.createElement("textarea");
  lac.rows = 3;
  lac.placeholder = "palette and mood: muted slate and rust, quiet and still";
  lac.value = F.get("light_and_colour") || "";
  // ANYTHING ELSE: a lump of text, typed freely. Auto sort files it into the boxes;
  // what stays here rides at the end of the prompt as written.
  const extra = document.createElement("textarea");
  extra.rows = 4;
  extra.placeholder = "Type anything here, a whole prompt if you like, then press Auto sort "
                    + "to file it into the boxes above. What stays here is added at the "
                    + "end of the prompt as written.";
  extra.value = F.get("extra") || "";
  extra.addEventListener("input", () => changed());

  // ---- the groups: every section folds, so a row can be as small as its writing.
  // State goes through F.folds when the host remembers it (node.properties, so a
  // fold never dirties what a render produces); a host without one gets the session.
  const localFolds = {};
  const foldGet = (k) => (F.folds?.get ? F.folds.get(k) : localFolds[k]);
  const foldSet = (k, v) => { if (F.folds?.set) F.folds.set(k, v); else localFolds[k] = v; };
  const ICONS = { style: "✨", subject: "👤", surroundings: "⛰",
                  framing: "\u2316", placement: "\u25ce", light: "\u2600" };
  // THREE COLUMNS when the host is wide (the Workspace's Prompts tab): the
  // writing sections stack on the left, the camera in the middle, the placement
  // on the right, and under the camera and placement the Anything else box, the
  // tools and the preview - the arrangement you drew. A narrow host keeps one
  // column.
  let colL = null, colR = null, colP = null;
  if (F.twoColumn) {
    const cols = el("div", "rn-pf-cols");
    colL = el("div", "rn-pf-col");
    colR = el("div", "rn-pf-col");
    colP = el("div", "rn-pf-col");
    cols.appendChild(colL); cols.appendChild(colR); cols.appendChild(colP);
    wrap.appendChild(cols);
  }
  // writing on the left (style, subject, surroundings, light & colour); the
  // camera and the prompt preview on the right - your arrangement
  const RIGHT = new Set(["framing"]);
  const group = (key, title, hint, els, extra, target) => {
    const gbox = el("div", "rn-pf-box");
    const gh = el("div", "head");
    const car = el("span", "car", "\u25be");
    gh.appendChild(el("span", "ico", ICONS[key] || "\u25a0"));
    gh.appendChild(el("b", null, title));
    if (hint) gh.appendChild(el("span", "hint2", hint));
    if (extra) {
      // a control on the head line that must not fold the section
      extra.addEventListener("click", (e) => e.stopPropagation());
      gh.appendChild(extra);
    }
    gh.appendChild(car);
    const bd = el("div", "body");
    for (const e of els) bd.appendChild(e);
    const isOpen = () => foldGet(key) !== false;
    const apply = () => {
      bd.style.display = isOpen() ? "" : "none";
      car.textContent = isOpen() ? "\u25be" : "\u25b8";
    };
    gh.addEventListener("click", () => { foldSet(key, !isOpen()); apply(); });
    apply();
    gbox.appendChild(gh); gbox.appendChild(bd);
    (target || (colL ? (RIGHT.has(key) ? colR : colL) : wrap)).appendChild(gbox);
  };
  const bigEdit = (title, ta) => {
    document.querySelector(".rn-pf-bigedit")?.remove();
    const ov = el("div", "rn-pf-bigedit");
    ov.style.cssText = "position:fixed;inset:0;z-index:10050;background:#0c0d10ee;"
      + "display:flex;align-items:center;justify-content:center";
    const panel = el("div", null);
    panel.style.cssText = "display:flex;flex-direction:column;gap:10px;"
      + "width:min(920px,94vw);height:min(72vh,760px);background:#16181c;"
      + "border:1px solid #3a3f47;border-radius:8px;padding:14px;"
      + "box-shadow:0 10px 40px rgba(0,0,0,.6)";
    const h = el("div", null, title);
    h.style.cssText = "font:600 14px system-ui,sans-serif;color:#e8ecf1";
    const big = document.createElement("textarea");
    big.value = ta.value || "";
    big.style.cssText = "flex:1;min-height:0;background:#101216;border:1px solid "
      + "#2a2e34;border-radius:6px;color:#e2e5ea;font-size:14px;line-height:1.5;"
      + "padding:10px 12px;resize:none";
    const foot = el("div", null);
    foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const mk = (label, primary, fn) => {
      const b = el("button", null, label);
      b.style.cssText = "padding:7px 18px;border-radius:5px;font-size:13px;"
        + "cursor:pointer;border:1px solid " + (primary
          ? "#2e7d4f;background:#2e7d4f;color:#fff"
          : "#33373d;background:#15171b;color:#c8ccd2");
      b.addEventListener("click", fn);
      return b;
    };
    const closeIt = () => ov.remove();
    const saveIt = () => {
      ta.value = big.value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      closeIt();
    };
    foot.appendChild(mk("Cancel", false, closeIt));
    foot.appendChild(mk("Save", true, saveIt));
    big.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeIt(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveIt();
    });
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeIt(); });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(h); panel.appendChild(big); panel.appendChild(foot);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    big.focus();
    big.setSelectionRange(big.value.length, big.value.length);
  };
  const counted = (ta, max, title) => {
    const wrapC = el("div", null);
    wrapC.style.cssText = "display:flex;flex-direction:column;position:relative";
    const cnt = el("div", "rn-pf-count", "");
    const upd = () => { cnt.textContent = (ta.value || "").length + " / " + max; };
    ta.addEventListener("input", upd);
    upd();
    // the expand glyph, same gesture as every prompt box in the pack:
    // click it or double-click the field to write full size
    const ex = el("button", "rn-pf-expand", "⛶");
    ex.title = "Open the fullscreen editor. Double-clicking the box does the "
             + "same; Esc cancels, Ctrl+Enter saves.";
    const open = () => bigEdit(title || "Prompt", ta);
    ex.addEventListener("click", open);
    ta.addEventListener("dblclick", open);
    wrapC.appendChild(ta); wrapC.appendChild(ex); wrapC.appendChild(cnt);
    ta._rnCount = upd;
    return wrapC;
  };
  // SAVED SNIPPETS, per section: a style, a subject, a place or a light you keep
  // coming back to, saved and loaded on its own without touching the other boxes
  let SNIPS = { style: {}, subject: {}, surroundings: {}, light: {} };
  const snipRows = [];
  const refreshSnips = async () => {
    try {
      const r = await fetch("/rednode/frame_snippets");
      const j = await r.json();
      SNIPS = j.snippets || SNIPS;
    } catch (e) { /* API not up */ }
    for (const fill of snipRows) fill();
  };
  const snipRow = (section, keys, what) => {
    const row = el("div", "rn-pf-snip");
    const sel = document.createElement("select");
    sel.title = "Your saved " + what + ". Pick one and press Load; Save keeps what is "
              + "in this section now under a name; the cross deletes the picked one.";
    const load = el("button", "rn-pf-btn", "Load");
    load.title = "Put the picked saved " + what + " into this section only.";
    const save = el("button", "rn-pf-btn", "Save");
    save.title = "Save this section as a named " + what + ", for any prompt later.";
    const del = el("button", "rn-pf-btn", "\u2715");
    del.title = "Delete the picked saved " + what + ".";
    const fill = () => {
      const names = Object.keys(SNIPS[section] || {});
      fillSelect(sel, ["Saved " + what + "..."].concat(names),
                 names.includes(sel.value) ? sel.value : "Saved " + what + "...");
    };
    fill();
    snipRows.push(fill);
    load.addEventListener("click", () => {
      const v = (SNIPS[section] || {})[sel.value];
      if (!v) return;
      for (const k of keys) if (v[k] !== undefined) F.set(k, v[k]);
      pullFromWidgets();
      changed();
    });
    save.addEventListener("click", async () => {
      const cur = Object.keys(SNIPS[section] || {}).includes(sel.value) ? sel.value : "";
      const name = window.prompt("Save this " + what + " as", cur);
      if (!name) return;
      pushToWidgets();
      const value = {};
      for (const k of keys) value[k] = F.get(k);
      try {
        const r = await fetch("/rednode/frame_snippet_save", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, name, value }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        await refreshSnips();
        sel.value = name;
      } catch (e) { alert("Could not save: " + e.message); }
    });
    del.addEventListener("click", async () => {
      const name = sel.value;
      if (!(SNIPS[section] || {})[name]) return;
      if (!window.confirm("Delete the saved " + what + " \"" + name + "\"?")) return;
      try {
        await fetch("/rednode/frame_snippet_save", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, name, action: "delete" }),
        });
        await refreshSnips();
      } catch (e) { /* the list simply keeps it */ }
    });
    row.appendChild(sel); row.appendChild(load); row.appendChild(save); row.appendChild(del);
    return row;
  };
  // the saved versions of a box sit behind one button on its head, so a box is
  // the writing and nothing else until they are asked for
  const presetsBtn = (row) => {
    row.style.display = "none";
    const b = el("button", "rn-pf-btn rn-pf-presets", "\uD83D\uDCC1 Presets");
    b.title = "Saved versions of this box: load one, save this one, delete one.";
    b.addEventListener("click", () => {
      const open = row.style.display === "none";
      row.style.display = open ? "" : "none";
      b.classList.toggle("on", open);
    });
    return b;
  };
  const styleSnip = snipRow("style", ["style", "style_extra"], "styles");
  group("style", "Style", "The overall look and feel.",
        [styleRow, counted(styleExtra, 200, "Style wording"), styleSnip],
        presetsBtn(styleSnip));
  const subjectSnip = snipRow("subject", ["subject"], "subjects");
  group("subject", "Subject", "Who or what, and how it looks.",
        [counted(subject, 600, "Subject"), subjectSnip], presetsBtn(subjectSnip));
  const placeSnip = snipRow("surroundings", ["surroundings"], "places");
  group("surroundings", "Surroundings", "Where it is.",
        [counted(surroundings, 300, "Surroundings"), placeSnip], presetsBtn(placeSnip));
  // CAMERA: the simple chips (framing = distance and lens, height = height and
  // pitch) drive a Camera Studio state underneath; the studio, opened from the
  // disclosure, is the advanced view and mounts FULL WIDTH below the columns.
  // Push is retired (camera-first ordering IS the push); the placement
  // dropdowns fold into the studio's relations, the typed placement stays.
  // SIMPLE / ADVANCED. Simple:
  // the chips write the camera words. Advanced: the Camera Studio drives
  // them - in the workspace it lives on the Camera tab (Advanced opens it),
  // in the standalone node it unfolds below.
  const studioBar = el("div", "rn-pf-row");
  const modeSeg = el("div", "rn-pf-seg");
  // OFF: no camera words at all. Simple: the chips write them. Advanced: the
  // studio does. One segment, three states, the camera settings kept throughout.
  const offBtn = el("button", "rn-pf-segb", "Off");
  offBtn.title = "No camera words at all: no shot size wording, no camera height stop, "
               + "no Camera Studio paragraph. The subject and the place stand on their "
               + "own. Your camera settings are kept for when Simple or Advanced is "
               + "picked again.";
  modeSeg.appendChild(offBtn);
  const simpleBtn = el("button", "rn-pf-segb", "Simple");
  simpleBtn.title = "The Shot size and Camera height chips write the camera words.";
  const studioBtn = el("button", "rn-pf-segb", "Advanced");
  studioBtn.title = "The Camera Studio drives the camera: place people and objects on a "
                  + "top view, aim the camera, set the lens. The chips become presets "
                  + "that reset it.";
  modeSeg.appendChild(simpleBtn);
  modeSeg.appendChild(studioBtn);
  const studioState = el("span", "hint2", "");
  studioBar.appendChild(modeSeg);
  studioBar.appendChild(studioState);
  // CAMERA WORDS OFF: the Off state of the segment. The chips and their
  // sliders grey out; the segment itself stays live so Simple or Advanced can
  // bring the camera back with every setting as it was.
  const camBody = el("div", "rn-pf-cambody");
  for (const e of [shotLabel, frameChips, frameWrap, camLabel, camChips, camWrap]) {
    camBody.appendChild(e);
  }
  // Off is the row's own switch, or the host's cameras switched off altogether
  const camsOff = () => !!F.get("camera_off") || !!F.camerasOff?.();
  const applyCamSw = () => {
    const off = camsOff();
    offBtn.classList.toggle("on", off);
    if (off) { simpleBtn.classList.remove("on"); studioBtn.classList.remove("on"); }
    camBody.classList.toggle("rn-pf-off", off);
  };
  const setCameraOff = (off) => {
    F.set("camera_off", !!off);
    applyCamSw();
    if (!off) syncSimpleRef?.();
    F.dirty?.();
    changed();
  };
  offBtn.addEventListener("click", () => setCameraOff(true));
  const placementLabel = el("div", "rn-pf-sublabel", "Placement");
  placementLabel.title = "Where the subject stands in the scene, in your words. Optional; "
                       + "it rides the prompt whether the camera words are on or off.";
  const placementBox = el("div", null);
  if (!colP) placementBox.appendChild(placementLabel);   // its own box has a title
  placementBox.appendChild(counted(placement, 200, "Placement"));
  if (colP) {
    group("framing", "Camera", "Where the camera is.", [camBody, studioBar]);
    group("placement", "Placement",
          "Where the subject stands, in your words. Optional; it rides the prompt "
          + "whether the camera words are on or off.",
          [placementBox], null, colP);
  } else {
    group("framing", "Camera and placement",
          "Where the camera is and where the subject stands.",
          [camBody, studioBar, placementBox]);
  }
  const studioHost = el("div", "rn-pf-studio");
  studioHost.style.display = "none";
  wrap.appendChild(studioHost);            // full width, under the columns
  let studio = null;
  const studioGet = () => {
    const raw = F.get("camera");
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string" && raw.trim()) {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return null;
  };
  let syncSimpleRef = () => {};
  const studioSet = (state) => {
    F.set("camera", state ? JSON.stringify(state) : "");
    F.dirty?.();
    syncSimpleRef();
  };
  const seedStudioFromChips = () => {
    // the simple chips REGENERATE the studio camera; the scene (people,
    // objects) is kept if there is one, only the camera moves
    const cur = studioGet();
    const framing = framings[Number(frameRange.value)] ?? F.get("framing");
    const height = heights[Number(camRange.value)] ?? (F.get("camera_height") || "Eye level");
    const subj = (cur && Array.isArray(cur.subjects) && cur.subjects.length)
      ? cur.subjects : [{ name: "the subject", pos: [0, 0, 0], height: 1.7,
                          facing_deg: 0, kind: "person", size: [0.6, 0.6], rel: null }];
    const target = (cur && cur.camera && typeof cur.camera.target === "number") ? cur.camera.target : 0;
    const prime = subj[target] || subj[0];
    const camPrev = cur && cur.camera ? cur.camera : null;
    // keep the bearing you chose in the studio (which side the camera is on)
    let bearing = 0;
    if (camPrev && Array.isArray(camPrev.pos)) {
      bearing = Math.atan2(camPrev.pos[0] - prime.pos[0], camPrev.pos[2] - prime.pos[2]) * 180 / Math.PI;
    }
    const cam = cameraFromFrame(framing, height, prime.height, prime.pos, bearing);
    cam.target = target;
    const state = { ...(cur || {}), camera: cam, subjects: subj };
    studioSet(state);
    if (studio) studio.refresh();
  };
  // A TOGGLE THAT SURVIVES A RE-RENDER (switching tabs
  // hid the studio every time). Shown-ness is a fold key in the host's fold
  // store, exactly like the section folds, so it comes back on the next
  // render; and it follows the rule: studio active -> shown by default,
  // no studio -> hidden. Turning it OFF also clears the studio state, so
  // "shown" and "active" mean the same thing.
  const ARROW_OPEN = "\u25BE", ARROW_SHUT = "\u25B8";
  const mountStudio = () => {
    if (studio) return;
    if (!studioGet()) seedStudioFromChips();
    // A HOST WITH A CAMERA TAB (the workspace): the studio lives there, not
    // under the frame. Advanced here means "the studio drives the camera";
    // editing it is one click away.
    if (F.openCameraTab) { F.openCameraTab(); return; }
    studio = buildStudio(studioHost, {
      get: () => studioGet() || {},
      set: (state) => studioSet(state),
      onChange: () => { changed(); },
      preview: F.studioPreview || (async () => ""),
    });
  };
  const showStudio = (on) => {
    const remote = !!F.openCameraTab;
    studioHost.style.display = on && !remote ? "" : "none";
    studioBtn.classList.toggle("on", !!on);
    simpleBtn.classList.toggle("on", !on);
    foldSet("studio_open", !!on);
    if (on && !remote) mountStudio();
  };
  const openStudio = () => {
    // Advanced: seed the studio from the chips if it is not live yet, then
    // show it (standalone) or jump to the Camera tab (workspace)
    if (!studioGet()) { seedStudioFromChips(); }
    showStudio(true);
    changed();
    if (F.openCameraTab) F.openCameraTab();
  };
  const goSimple = () => {
    // Simple: the studio stops driving the camera; the chips write it again
    studioSet(null);
    showStudio(false);
    changed();
  };
  // picking Simple or Advanced turns the camera words back on, here and, when the
  // host has them off altogether, there too
  const camsBackOn = () => {
    if (F.get("camera_off")) setCameraOff(false);
    if (F.camerasOff?.()) F.camerasOn?.();
  };
  studioBtn.addEventListener("click", () => { camsBackOn(); openStudio(); });
  simpleBtn.addEventListener("click", () => { camsBackOn(); goSimple(); });
  // on (re)build: restore the remembered state, or follow the rule
  {
    const remembered = foldGet("studio_open");
    const on = (remembered === undefined || remembered === null) ? !!studioGet() : !!remembered;
    if (on && studioGet()) showStudio(true);
    else showStudio(false);
  }
  // WHICH ONE IS IN CHARGE, made visible: with the studio live its paragraph
  // REPLACES the simple stops entirely (one engine, never both), so the
  // simple rows dim and say so; clear the studio to get them back. The chips
  // stay clickable as presets that regenerate the studio.
  const simpleRows = [shotLabel, frameChips, frameWrap, camLabel, camChips, camWrap];
  const syncSimple = () => {
    const live = !!studioGet();
    const off = camsOff();
    for (const elx of simpleRows) elx.style.opacity = live && !off ? ".45" : "";
    studioState.textContent = F.camerasOff?.()
      ? "cameras are off on the Camera tab; pick Simple or Advanced to turn them back on"
      : F.get("camera_off") ? "no camera words for this prompt"
      : live
        ? (F.openCameraTab ? "the Camera tab drives the camera; the chips are presets that reset it"
                           : "the studio drives the camera; the chips are presets that reset it")
        : "";
    studioBtn.classList.toggle("on", live && !off);
    simpleBtn.classList.toggle("on", !live && !off);
    applyCamSw();
  };
  syncSimpleRef = syncSimple;
  syncSimple();
  // the chips regenerate the studio camera whenever the studio is live
  frameRange.addEventListener("change", () => { if (studioGet()) seedStudioFromChips(); });
  camRange.addEventListener("change", () => { if (studioGet()) seedStudioFromChips(); });
  const lightSnip = snipRow("light", ["lighting", "brightness", "light_and_colour"], "lights");
  group("light", "Light and colour", "Lighting mood and colours.",
        [lightRow, brightRow, counted(lac, 200, "Light and colour"), lightSnip],
        presetsBtn(lightSnip));
  refreshSnips();
  // Under the camera and the placement (the writing column is the tall one):
  // the Anything else box, then the tools bar, then the preview, so the text
  // you type, the buttons that rework it and the result read top to bottom.
  // Without columns the same order runs under everything. The head line with
  // the title and the saved prompts goes to the top either way.
  const under = colP ? el("div", "rn-pf-under") : wrap;
  if (colP) wrap.querySelector(".rn-pf-cols").appendChild(under);
  wrap.insertBefore(head, wrap.firstChild);
  const xbox = el("div", "rn-pf-box rn-pf-extrabox");
  {
    const xh = el("div", "head");
    xh.style.cursor = "default";
    xh.appendChild(el("span", "ico", "\u270E"));
    xh.appendChild(el("b", null, "Anything else"));
    xh.appendChild(el("span", "hint2", "Type freely, then Auto sort files it into the boxes "
                                       + "above. What stays here is added at the end of the prompt."));
    const xb = el("div", "body");
    xb.appendChild(counted(extra, 1000, "Anything else"));
    xbox.appendChild(xh);
    xbox.appendChild(xb);
    under.appendChild(xbox);
  }
  // the tools: right above the preview when the preview is here, else right
  // above the Anything else box they act on
  if (F.previewHost) under.insertBefore(toolsBar, xbox);
  else under.appendChild(toolsBar);

  // ---- notice + preview ----------------------------------------------------------------
  const note = el("div", "rn-pf-note ok", "");
  const out = el("div", "rn-pf-out", "");
  const outWrap = el("div", "rn-pf-outwrap");
  const outBar = el("div", "rn-pf-outbar");
  const copyB = el("button", null, "\u29C9 Copy");
  copyB.title = "Copy the assembled prompt.";
  copyB.addEventListener("click", () => {
    navigator.clipboard?.writeText(out.textContent || "");
  });
  const bigB = el("button", null, "\u26F6 Expand");
  bigB.title = "Read the assembled prompt full size.";
  bigB.addEventListener("click", () => {
    const ov = el("div", null);
    ov.style.cssText = "position:fixed;inset:0;z-index:10050;background:#0c0d10ee;"
      + "display:flex;align-items:center;justify-content:center";
    const panel = el("div", null);
    panel.style.cssText = "width:min(920px,94vw);max-height:80vh;overflow:auto;"
      + "background:#16181c;border:1px solid #3a3f47;border-radius:8px;"
      + "padding:18px 22px;color:#e2e5ea;font-size:15px;line-height:1.6;"
      + "white-space:pre-wrap";
    panel.textContent = out.textContent || "";
    ov.appendChild(panel);
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  });
  outBar.appendChild(copyB); outBar.appendChild(bigB);
  outWrap.appendChild(note); outWrap.appendChild(out); outWrap.appendChild(outBar);
  if (F.previewHost) F.previewHost.appendChild(outWrap);
  else if (colP) {
    const pvBox = el("div", "rn-pf-box rn-pf-pvbox");
    const pvHead = el("div", "head");
    pvHead.style.cursor = "default";
    pvHead.appendChild(el("span", "ico", "✎"));
    pvHead.appendChild(el("b", null, "Prompt preview"));
    const live = el("span", "rn-pf-live", "Live preview");
    pvHead.appendChild(live);
    pvBox.appendChild(pvHead);
    const pvBody = el("div", "body");
    pvBody.appendChild(outWrap);
    pvBox.appendChild(pvBody);
    under.appendChild(pvBox);
  } else wrap.appendChild(outWrap);

  // ---- wiring ---------------------------------------------------------------------------
  const brightLabel = (v) => (v === 0 ? "neutral" : (v > 0 ? "+" : "") + v);

  function pushToWidgets() {
    F.set("style", styleSel.value);
    F.set("style_extra", styleExtra.value);
    F.set("subject", subject.value);
    F.set("surroundings", surroundings.value);
    F.set("framing", framings[Number(frameRange.value)] ?? F.get("framing"));
    F.set("framing_push", pushSel.value);
    F.set("camera_height", heights[Number(camRange.value)] ?? F.get("camera_height"));
    F.set("placement_where", whereSel.value);
    F.set("placement_what", whatSel.value);
    F.set("placement", placement.value);
    F.set("lighting", lightSel.value);
    F.set("brightness", Number(brightRange.value));
    F.set("light_and_colour", lac.value);
    F.set("extra", extra.value);
    frameVal.textContent = F.get("framing");
    camVal.textContent = F.get("camera_height") || "Eye level";
    brightVal.textContent = brightLabel(Number(brightRange.value));
  }

  function pullFromWidgets() {
    styleSel.value = F.get("style");
    styleExtra.value = F.get("style_extra") || "";
    subject.value = F.get("subject") || "";
    surroundings.value = F.get("surroundings") || "";
    const fi = framings.indexOf(F.get("framing"));
    if (fi >= 0) frameRange.value = String(fi);
    pushSel.value = F.get("framing_push");
    const ci = heights.indexOf(F.get("camera_height") || "Eye level");
    if (ci >= 0) camRange.value = String(ci);
    camVal.textContent = F.get("camera_height") || "Eye level";
    drawCamChips();
    whereSel.value = F.get("placement_where");
    whatSel.value = F.get("placement_what");
    placement.value = F.get("placement") || "";
    lightSel.value = F.get("lighting");
    applyCamSw();
    brightRange.value = String(F.get("brightness") ?? 0);
    lac.value = F.get("light_and_colour") || "";
    extra.value = F.get("extra") || "";
    frameVal.textContent = F.get("framing");
    brightVal.textContent = brightLabel(Number(brightRange.value));
    for (const t of [styleExtra, subject, surroundings, lac]) t._rnCount?.();
    drawChips();
  }

  let timer = null;
  async function preview() {
    try {
      const body = {};
      // a host may assemble richer values than its boxes show (the Prompts
      // tab joins its caption layer after the typed text here)
      for (const name of FIELDS) body[name] = (F.getPreview || F.get)(name);
      if (body.camera && typeof body.camera === "object") body.camera = JSON.stringify(body.camera);
      // a host may keep wildcards unresolved (the Prompts tab does: the queue
      // rolls them with the run seed, so the stored text must keep the tokens)
      if (F.resolveWildcards === false) body.resolve_wildcards = false;
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
      F.onPreview?.(j.prompt || "", j.notice || "");
    } catch (e) { /* server not up */ }
  }

  function changed() {
    pushToWidgets();
    F.dirty?.();
    clearTimeout(timer);
    timer = setTimeout(preview, DEBOUNCE_MS);
  }

  for (const c of [styleSel, whereSel, whatSel, lightSel, pushSel]) c.addEventListener("change", changed);
  for (const c of [styleExtra, subject, surroundings, placement, lac]) c.addEventListener("input", changed);
  for (const c of [frameRange, brightRange, camRange]) c.addEventListener("input", changed);
  // middle-click still pans the canvas
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button === 1) app.canvas?.processMouseDown?.(e);
  });

  // THE PROMPT LIBRARY: the shipped examples plus your own saved prompts,
  // one store on disk shared by the node and the Prompts tab. Save writes every
  // frame field; Load applies every field a prompt carries, so a saved look comes
  // back whole: style, lighting, framing, push, all of it.
  let LIB = { presets: {}, user: [] };
  const refreshLib = async () => {
    try {
      const r = await fetch("/rednode/prompt_frame_presets");
      LIB = await r.json();
      const names = Object.keys(LIB.presets || {});
      fillSelect(presetSel, ["Load prompts..."].concat(names),
                 presetSel.value || "Load prompts...");
    } catch (e) { /* API not up */ }
  };
  const saveBtn = el("button", "rn-pf-btn", "Save");
  saveBtn.title = "Save every field of this frame as a named prompt, next to the "
                + "examples. Yours can be overwritten and deleted; the examples "
                + "cannot.";
  grpSaved.appendChild(saveBtn);
  saveBtn.addEventListener("click", async () => {
    const cur = presetSel.value !== "Load prompts..." ? presetSel.value : "";
    const name = window.prompt("Save this prompt as",
                               (LIB.user || []).includes(cur) ? cur : "");
    if (!name) return;
    pushToWidgets();
    const preset = {};
    for (const k of ["subject", "surroundings", "placement", "light_and_colour",
                     "framing", "style", "style_extra", "lighting", "brightness",
                     "framing_push", "placement_where", "placement_what"]) {
      preset[k] = F.get(k);
    }
    try {
      const r = await fetch("/rednode/frame_prompt_save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, preset }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      await refreshLib();
      presetSel.value = name;
      note.textContent = "Saved \"" + name + "\".";
      note.className = "rn-pf-note ok";
    } catch (e) { alert("Could not save: " + e.message); }
  });
  presetBtn.addEventListener("click", () => {
    const p = (LIB.presets || {})[presetSel.value];
    if (!p) return;
    for (const [k, v] of Object.entries(p)) {
      if (k !== "note" && v !== undefined) F.set(k, v);
    }
    pullFromWidgets();
    changed();
    if (p.note) { note.textContent = p.note; note.className = "rn-pf-note on"; }
  });
  refreshLib();

  return { head, refresh: pullFromWidgets, collect: pushToWidgets,
           previewNow: preview, changed,
           boxes: { styleExtra, subject, surroundings, placement, lac, extra, out } };
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
  const F = {
    opts: {
      style: W.style.options?.values || [],
      framing: W.framing.options?.values || [],
      framing_push: W.framing_push.options?.values || [],
      placement_where: W.placement_where.options?.values || [],
      placement_what: W.placement_what.options?.values || [],
      lighting: W.lighting.options?.values || [],
      brightness_min: W.brightness.options?.min ?? -3,
      brightness_max: W.brightness.options?.max ?? 3,
      push_tooltip: W.framing_push.tooltip || "",
    },
    get: (n) => W[n].value,
    set: (n, v) => { W[n].value = v; },
    dirty: () => node.graph?.setDirtyCanvas(true, false),
    folds: {
      get: (k) => node.properties?.rn_pf_groups?.[k],
      set: (k, v) => {
        node.properties = node.properties || {};
        (node.properties.rn_pf_groups ||= {})[k] = v;
      },
    },
  };
  const editor = buildFrameEditor(wrap, F);
  const fold = el("button", "rn-pf-btn", "▾ tools");
  editor.head.appendChild(fold);
  const { styleExtra, subject, surroundings, placement, lac, out } = editor.boxes;
  const pullFromWidgets = editor.refresh;

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

  // ---- tools fold: the rows under the panel (seed, wildcards toggle, font, colour) ----
  // Same button and the same properties key as the Prompt Box, so folding one node
  // teaches the other. The panel's own FIELDS are hidden for good and are SKIPPED here:
  // treating them like the rest would resurrect the raw rows this panel exists to
  // replace the first time somebody unfolds.
  const toolsHidden = () => !!node.properties?.rn_tools_hidden;
  const applyFold = () => {
    const hide = toolsHidden();
    for (const w of node.widgets || []) {
      if (w === widget || FIELDS.includes(w.name)) continue;
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
    fold.title = hide ? "show the seed, wildcard, font and colour rows"
                      : "hide the rows under the panel";
    // folding never resizes the node; unfolding into a node too short to hold the rows
    // grows it just enough that they do not overlap the panel
    if (!hide) {
      const min = node.computeSize()[1];
      if (node.size[1] < min) node.setSize([node.size[0], min]);
    }
    node.setDirtyCanvas(true, true);
  };
  fold.onclick = (e) => {
    e.stopPropagation();
    node.properties = node.properties || {};
    node.properties.rn_tools_hidden = !toolsHidden() || undefined;
    applyFold();
  };
  node._rnPfApplyFold = applyFold;
  applyFold();                       // honour the state the workflow was saved with

  editor.collect();
  editor.previewNow();

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
      requestAnimationFrame(() => { buildPanel(this); this._rnPfSync?.(); this._rnPfApplyFold?.(); });
    };
  },
});
