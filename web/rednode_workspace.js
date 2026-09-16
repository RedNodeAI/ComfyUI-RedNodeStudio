import * as _appmod from "../../scripts/app.js";
import { makePicker } from "./rednode_picker.js";
import { newSlot as LS_newSlot, writeSlots as LS_writeSlots } from "./rednode_lora_stack.js";
import { makeHighlightEditor } from "./rednode_promptbox.js";
import { buildFrameEditor } from "./rednode_prompt_frame.js";
const { app } = _appmod;
// ComfyApp is exported by every real frontend, but read it defensively: the mask-editor
// round-trip degrades to the wired-mask fallback rather than breaking the whole panel
const ComfyApp = _appmod.ComfyApp || {};
import { api } from "../../scripts/api.js";
import { postBody, looksSection, openPostCog, refreshPostPresets,
         fxStep, cardOrder, normalisePostChain, mirrorChain } from "./rednode_ws_post.js";
import { buildStudio } from "./rednode_camera_studio.js";
import { TAB_ORDER, IDENTITY_SUBS, IMAGE_TABS, DIALS, LATENT_PRESETS, POST_FX,
         VRAM_CAPS, snapStep, MASK_POS_MAX, MASK_ZONE_FR, maskPosOf,
         maskValueOf, resampleTarget, autoShapeLabel, WHOLE_FRAME_CAPS,
         wholeFrameLimit } from "./rednode_ws_tables.js";
import { allNodes, findNode, findNodes, nodeById } from "./rednode_graph.js";
import { customRigNodes, RIG_NODES } from "./rednode_custom_rig.js";
import { setting, wsPref, setWsPref, onWsPrefChange } from "./rednode_settings.js";
import { bindSliderWheel } from "./rednode_wheel.js";
import { buildLoraPanel, render as loraRender, writeSlots as loraWrite,
         CUSTOM_SENTINEL as LORA_CUSTOM } from "./rednode_lora_stack.js";
import { panelHotkey, forgetHotkeys, panelPaste, forgetPaste } from "./rednode_keys.js";

// RedNode Studio Workspace — the tabbed panel over workspace.py.
//
// Tabs: Subject / People / Scene / Moodboard / Masks / Dials. Image tabs are galleries
// of remembered files (names in ComfyUI/input, like LoadImage): click to select, the
// moodboard multi-selects into a batch. Masks are painted in ComfyUI's own editor over
// the tab's chosen image. Dials are the studio sliders that used to float around the
// canvas as separate bars.
//
// Everything lives in the hidden `config` JSON widget; this file is only hands.

const NODE_NAME = "RedNodeStudioWorkspace";
const CUSTOM_SENTINEL = "custom (live)";      // must match workspace.py
const NODE_MIN_W = 460;
const MIN_PANEL_H = 200;
// Bigger than it was (74): the galleries are looked at, and a thumbnail you have to
// lean in to read is doing half a job. The step is 8, so a nudge is a visible reflow
// rather than a shuffle.
const THUMB = 96;
const THUMB_MIN = 64;
const THUMB_MAX = 240;
const THUMB_STEP = 8;

// The paint size dial's range, and it MUST match the clamp in workspace.py's
// parse_config. While they disagreed the slider offered values the server refused and
// hid values it accepted: everything under 512 was clamped up, so the bottom third of
// the travel did nothing, and 4K could not be asked for at all even on a card holding
// it. The VRAM tier is the real ceiling and clamps this further at render time.
const MASK_MIN = 512;
const MASK_MAX = 4096;

// The pass count's ceiling, and it MUST match PAINT_PASS_MAX in workspace.py for the
// same reason the two above must match: a box that offers a number the server clamps
// away is a box that lies about what just ran.
const PASS_MAX = 10;



// Every dial lives on the tab it belongs to — one big Dials tab read as a wall of
// sliders with no context, so the subject dials sit under Subject, and so on.


// Panel scale. The complaint this answers: on a large display the panel reads small,
// and the node is a square full of 11px text with room going spare.
//
// zoom rather than transform: scale(). A transform paints bigger without relayout, so
// the content would spill out of the node and every hit target would sit somewhere
// other than where it looks. zoom scales the layout itself, so rows re-wrap and the
// panel still ends where the node ends.
//
// The width compensation is the whole trick: a child at 100% of the node zoomed by 1.4
// renders at 140% and overflows. At 100/1.4 percent it renders at exactly 100%.
// It must go on an element WE own, never on the widget element itself. ComfyUI writes
// an explicit pixel width and height onto that element every frame, so the percentage
// compensation was wiped a frame after it was set and the zoom simply pushed the panel
// out past the edges of the node. Inside our own child the percentage survives, and
// 100/scale percent zoomed by scale lands at exactly the node's width.
export function applyScale(host, raw) {
  if (!host) return;
  const scale = Math.max(0.7, Math.min(4, parseFloat(raw) || 1));
  // zoom ONLY, and the frame never moves. The width/height compensation that used to
  // sit here is the pattern for transform: scale(), which does not take part in
  // layout. zoom DOES: the content already lays out at parentWidth/scale of its own
  // pixels, and shrinking the host to 100/scale% on top of that squeezed everything
  // twice, which is why turning the slider up visibly CRAMPED the panel instead of
  // enlarging it.
  host.style.width = "";
  host.style.height = "";
  host.style.zoom = Math.abs(scale - 1) < 0.001 ? "" : String(scale);
  // Dropdowns opt out of zoom in this browser: everything else grew and the text
  // inside every <select> stayed small (reported from the field). So the scale rides
  // a CSS variable as well, and one rule below sizes select and option text from it
  // directly, bypassing zoom for exactly those elements and no others.
  host.style.setProperty?.("--rnws-scale", String(scale));
}

const css = document.createElement("style");
css.textContent = `
.rn-ws-wrap{display:flex;flex-direction:column;padding:9px;box-sizing:border-box;
  font:14px system-ui,sans-serif;color:#ddd;background:#16181c;border-radius:6px;width:100%;height:100%;overflow:hidden}
/* THE SELECT BOX SCALES. THE OPEN POPUP DOES NOT. Read the whole story before touching
   this, because it has been got wrong in both directions.

   First pass sized SELECT and OPTION from the scale variable, on a report that
   dropdowns were not scaling. That came out at roughly scale SQUARED and was removed,
   correctly: the browser does zoom the select's own rendering, so the rule was stacking
   on top of a zoom that already worked.

   What was actually broken is narrower. zoom scales the element the page draws, but a
   native dropdown POPUP is painted by the browser's own widget layer, which reads the
   unzoomed computed font size. So the closed box is right and the list that drops out of
   it is tiny, which is what the field screenshots show, both times.

   Hence OPTION ONLY, never SELECT. The closed box keeps the zoom it already had; the
   popup gets a size the widget layer will honour. Putting select back in this selector
   is what produced scale squared, so it stays out.
   NOTE: no backticks in here. This whole stylesheet is a template literal, so one
   backtick ends the string and takes the entire panel down with it. */
.rn-ws-host option{font-size:calc(11px * var(--rnws-scale,1))}
.rn-ws-host .rn-ws-foot option{font-size:11px}
.rn-ws-host{display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-height:0;
  box-sizing:border-box}
/* The socket tuck rides its own thin row ABOVE the strip. It used to be the last
   item of the wrapping strip, so once the tabs filled the width it wrapped onto a
   stray line between the tabs and the box, the one place it must never be. */
.rn-ws-toprow{display:flex;justify-content:flex-end;flex:none;padding-bottom:6px}
.rn-ws-tabs{display:flex;gap:6px;flex:none;flex-wrap:wrap;padding-bottom:7px}
.rn-ws-tab{background:#15171b;border:1px solid #2a2e35;border-radius:7px;
  color:#9aa0a8;cursor:pointer;font-size:12.5px;font-weight:600;padding:8px 15px;display:flex;
  align-items:center;justify-content:center;gap:7px;position:relative;overflow:hidden}
/* the GROUP UNDERLINE: every tab, active or not, carries its group colour as
   a thin bar along its bottom edge, so the strip's grouping reads at a
   glance; the active tab lights the whole border on top of that */
.rn-ws-tab::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;
  border-radius:2px 2px 0 0;background:var(--rn-g,#4a5058);opacity:.7}
.rn-ws-tab.cur::after{opacity:1}
.rn-ws-tab.g-canvas{--rn-g:#4a8fe0}
.rn-ws-tab.g-model{--rn-g:#a855f7}
.rn-ws-tab.g-mood{--rn-g:#e08a3c}
.rn-ws-tab.g-edit{--rn-g:#b8283c}
.rn-ws-tab.g-post{--rn-g:#22a39f}
.rn-ws-tab.g-cfg{--rn-g:#8a919b}
.rn-ws-tab:hover{border-color:#3d434c;color:#c8ccd2}
.rn-ws-tab.cur{background:#242830;color:#fff}
/* the PILL CONTROL, the Sick Ollie primitive the user asked to adopt: one
   dark rounded box per setting, dim label left, bold value right, uniform
   height, laid in a responsive grid. Unity comes from repetition. */
.rn-ws-pillgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
  gap:8px}
.rn-ws-pill{display:flex;align-items:center;gap:10px;min-height:40px;
  background:#101216;border:1px solid #2f333a;border-radius:8px;
  padding:6px 12px;box-sizing:border-box}
.rn-ws-pill>.k{font-size:12px;color:#8a919b;flex:none}
.rn-ws-pill input,.rn-ws-pill select{flex:1;min-width:0;background:transparent;
  border:none;outline:none;color:#e8ecf1;font-size:13px;font-weight:600;
  text-align:right;padding:0}
.rn-ws-pill select{appearance:auto;cursor:pointer;color-scheme:dark}
/* the OPEN list of a select is painted by the browser from the option
   colours: pin them dark, or a light host theme paints white on white */
.rn-ws-pill select option,.rn-ws-res option,.rn-ws-wrap select option{
  background:#1b1e23;color:#e8ecf1}
.rn-ws-wrap select{color-scheme:dark}
.rn-ws-pill .v{margin-left:auto;font-size:12px;color:#7f8792;flex:none}

/* the ON/OFF switch: a sliding pill, the Sick Ollie affordance the user
   picked - state reads at a glance, green is on. Labelled choice buttons
   keep the rn-ws-on look; this class is only for pure on/off. */
.rn-ws-sw{position:relative;flex:none;width:40px;height:22px;border-radius:11px;
  background:#3a3f47;border:1px solid #2a2e34;cursor:pointer;padding:0;
  transition:background .15s}
.rn-ws-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;
  height:16px;border-radius:50%;background:#c8ccd2;transition:left .15s}
.rn-ws-card-folded > *:not(:first-child){display:none}
.rn-ws-sw.on{background:#2e7d4f;border-color:#2e7d4f}
.rn-ws-sw.on::after{left:20px;background:#fff}
/* group colours: canvas blue, mood amber, edit-node red, settings grey */
/* the ACTIVE tab lights in its own group colour, the mock's treatment:
   full accent border, a whisper of the same colour underneath */
.rn-ws-tab.cur.g-canvas{border-color:#4a8fe0;background:#4a8fe01a}
.rn-ws-tab.cur.g-model{border-color:#a855f7;background:#a855f71a}
.rn-ws-tab.cur.g-mood{border-color:#e08a3c;background:#e08a3c1a}
.rn-ws-tab.cur.g-edit{border-color:#b8283c;background:#b8283c1a}
.rn-ws-tab.cur.g-post{border-color:#22a39f;background:#22a39f1a}
.rn-ws-tier.high{border-color:#3d434c;color:#9aa0a8}
.rn-ws-tier.medium{border-color:#e08a3c;color:#f0c58a}
.rn-ws-tier.low{border-color:#22c55e;color:#a7f3c0}
/* flex:1 1 0 with min-height:0, so the stage is sized by the PANEL and never by what
   is inside it. With a content basis, the moment a result landed the stage grew and
   pushed every control below it down the panel. */
.rn-ws-paint{display:flex;gap:8px;flex:1 1 0;min-height:240px}
.rn-ws-pcanvas,.rn-ws-presult{position:relative;flex:1;min-width:0;background:#111316;
  border:1px solid #2a2e35;border-radius:6px;overflow:hidden;display:flex;
  align-items:center;justify-content:center}
.rn-ws-pcanvas canvas{position:absolute;max-width:100%;max-height:100%;
  image-rendering:auto}
/* crosshair is the FALLBACK, for before the ring exists or if it ever fails to
   build; _rnSyncZbar sets cursor:none once the ring is following the pointer */
.rn-ws-pcanvas .paintlayer{cursor:crosshair;touch-action:none}
/* The brush ring: what the brush will cover, at the size it will cover it. White with
   a dark halo so it reads on any picture, and dashed while erasing. Size, position and
   dash are set live; everything static lives here. */
.rn-ws-ring{position:absolute;left:0;top:0;display:none;z-index:3;border-radius:50%;
  pointer-events:none;border:1px solid #fff;box-shadow:0 0 0 1px #000a}
/* colour paint: the mode pair, the palette chips and the picker swatch */
.rn-ws-cclu{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.rn-ws-cchip{width:16px;height:16px;border:1px solid #444a52;border-radius:3px;
  cursor:pointer;flex:none;padding:0}
.rn-ws-cchip.on{outline:2px solid #e8ecf1;outline-offset:1px}
.rn-ws-fsov{position:fixed;inset:0;z-index:9990;background:#0c0d10ee;display:flex;
  flex-direction:column;padding:14px}
.rn-ws-fsbar{display:flex;align-items:center;gap:10px;flex:none;padding:0 2px 10px}
.rn-ws-fsbar .ttl{font:600 14px system-ui,sans-serif;color:#e8ecf1;letter-spacing:.02em}
.rn-ws-fsbar .hint{font-size:11.5px;opacity:.5;color:#ddd}
.rn-ws-fsx{margin-left:auto;background:#15171b;border:1px solid #33373d;
  border-radius:5px;color:#ddd;cursor:pointer;font-size:13px;padding:7px 14px}
.rn-ws-fsx:hover{border-color:#b8283c;color:#fff}
.rn-ws-fshost{flex:1;min-height:0;display:flex;flex-direction:column;
  background:#16181c;border:1px solid #2f333a;border-radius:8px;padding:10px;
  overflow:auto}
.rn-ws-draft.on{background:#3a2a10;border-color:#e0a84a;color:#ffd27a;font-weight:700}
.rn-ws-topbar{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;flex:none;
  margin:2px 0;background:#16181c;border:1px solid #2f333a;border-radius:6px;
  padding:8px 10px;width:100%;box-sizing:border-box}
/* Two columns at EVERY size, no stacked fallback. The columns are pure ratio,
   2:1, with minimums small enough to survive high UI scale: zoomed content lays
   out in width/scale of the node, so a 280px minimum meant "needs a 770px node
   at 275%%", and below that the side column wrapped under the canvases and the
   tab collapsed back into the tall pile the columns exist to replace. The zoom
   multiplies everything on screen anyway, so small CSS minimums render at a
   perfectly usable size. */
.rn-ws-pcols{display:flex;gap:12px;flex:1 1 auto;min-height:0;align-items:stretch}
.rn-ws-pmain{display:flex;flex-direction:column;gap:7px;flex:2 1 0;min-width:160px;
  min-height:0}
/* The settings live in their OWN BOX, visually apart from the canvases, in the
   same family as every other section box in the pack. Its content is emphasised
   with real font sizes rather than a nested zoom: zoom on a flex item is the
   bug that floated the footer and broke the stretch, twice today, and px sizes
   multiply under the global UI scale exactly the same without the geometry
   lottery. */
.rn-ws-pside{display:flex;flex-direction:column;gap:6px;flex:1 1 0;
  min-width:150px;align-self:flex-start;background:#1b1e23;
  border:1px solid #3d434c;border-radius:7px;padding:9px 11px}
.rn-ws-pside .rn-ws-row .hint{font-size:11.5px;opacity:.62}
.rn-ws-pside .rn-ws-btn{font-size:12px;padding:5px 10px}
.rn-ws-pside textarea{font-size:12.5px}
.rn-ws-pside .rn-ws-note{font-size:12px}
.rn-ws-pside select{font-size:12px}
.rn-ws-pside input[type=text]{font-size:13px}
/* Sub-boxes inside the settings panel: one per job. Their shared section head is what
   makes a folded control look deliberately closed instead of mysteriously absent. */
.rn-ws-sbox{background:#16181c;border:1px solid #2f333a;border-radius:6px;
  padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.rn-ws-sbody{display:flex;flex-direction:column;gap:6px;min-width:0}
.rn-ws-srow{display:flex;align-items:center;gap:10px}
.rn-ws-srow .k{flex:none;width:70px;font-size:12px;opacity:.62}
.rn-ws-srow .v{flex:none;min-width:42px;text-align:right;font-size:13px;
  font-weight:700;font-variant-numeric:tabular-nums}
.rn-ws-seedline{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
.rn-ws-seedline .seedlab{width:34px}
.rn-ws-seedline .masklab{width:auto;margin-left:3px}
.rn-ws-seedline .rn-ws-seg{flex:0 0 auto}
.rn-ws-num{height:30px;box-sizing:border-box;background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#ddd;padding:4px 7px;font-variant-numeric:tabular-nums}
.rn-ws-shapeb{min-width:20px;padding:3px 4px;font-size:13px;line-height:1}
.rn-ws-compact{min-height:30px;padding:5px 10px !important}
.rn-ws-filebar{display:flex;flex-direction:column;gap:6px;background:#15171b;
  border:1px solid #2f333a;border-radius:5px;padding:7px 8px}
.rn-ws-filebar .title{font-size:11.5px;font-weight:650;opacity:.68;letter-spacing:.02em}
.rn-ws-filebar .rn-ws-row{flex-wrap:wrap}
.rn-ws-file-state{margin-left:auto}
/* The pane height is FIXED by the layout, never by the image. A pane that grew
   to the picture's height made the panel taller than its scroll view, and the
   browser then auto-scrolled while painting near an edge: the view lurched up
   and down mid-stroke and the result pane flashed as it reflowed. Letterbox
   bars beside a stable canvas beat a full-bleed canvas that moves. */
.rn-ws-pside .rn-ws-row{row-gap:6px}
.rn-ws-pcol{flex-direction:column}
/* The AUTOMATIC layout choice: the stage itself asks whether there is room, via a
   container query rather than any script, so deciding costs nothing and can never
   re-enter render(). The breakpoint is in post-zoom layout pixels; two ~270px panes
   plus the gap is the narrowest side-by-side worth having. */
.rn-ws-pmain{container-type:inline-size}
.rn-ws-pauto{flex-direction:column}
@container (min-width:560px){.rn-ws-pauto{flex-direction:row}}
/* Narrow-node overflow: a flex item's min-width is auto, so a row of controls
   refused to shrink below its content and spilled past the panel border. The rows
   wrap instead, and the browser's intrinsic widths on selects and inputs stop at
   the box that holds them. */
.rn-ws-pside .rn-ws-row{flex-wrap:wrap}
.rn-ws-swatch{width:18px;height:18px;border-radius:4px;border:2px solid #33373d;
  cursor:pointer;flex:none;padding:0}
.rn-ws-swatch.on{border-color:#fff;box-shadow:0 0 5px #fff8}
/* the tab checklist wears the strip's own dot, so a hidden tab that is still doing
   something says so in the place you would go to unhide it */
.rn-ws-tabvis{display:inline-flex;align-items:center;gap:5px}
.rn-ws-tabvis .dot{width:7px;height:7px;border-radius:50%;background:#4a5058;flex:none}
.rn-ws-tabvis .dot.on{background:#22c55e;box-shadow:0 0 5px #22c55e}
.rn-ws-tabvis:not(.on){opacity:.55}
.rn-ws-pside select,.rn-ws-pside input[type=text],.rn-ws-pside textarea{max-width:100%}
.rn-ws-sbox{min-width:0}
.rn-ws-srow{min-width:0;flex-wrap:wrap}
.rn-ws-seg{display:flex;background:#15171b;border:1px solid #33373d;border-radius:6px;
  padding:3px;gap:3px;flex:none;min-width:0}
.rn-ws-segb{background:none;border:0;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:12.5px;padding:7px 10px;white-space:nowrap;flex:1 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis}
.rn-ws-segb:hover{color:#fff}
.rn-ws-segb.on{background:#b8283c;color:#fff;font-weight:600}
.rn-ws-switch .rn-ws-segb{padding:4px 10px;font-size:12px}
.rn-ws-gen{flex:1 1 auto;min-width:120px;min-height:38px;padding:0 18px;border-radius:6px;
  border:1px solid #2f7a4d;background:#1f9d55;color:#fff;font-weight:700;
  font-size:14.5px;cursor:pointer;letter-spacing:.01em}
.rn-ws-gen:hover{background:#24b463}
.rn-ws-gen:disabled{opacity:.6;cursor:default}
.rn-ws-zbar{display:flex;gap:4px;align-items:center;flex:none;padding:1px 0;
  flex-wrap:wrap}
.rn-ws-zrail{flex-direction:column;align-items:stretch;align-self:stretch;
  background:#16181c;border:1px solid #2f333a;border-radius:6px;padding:8px 7px;
  gap:7px;flex-wrap:nowrap;width:140px;box-sizing:border-box;flex:none}
/* the colour swatches wrap to four a row inside the rail, so the widest child
   stops deciding the rail's width; everywhere else they stay one strip */
.rn-ws-zrail .rn-ws-swrow{flex-wrap:wrap;justify-content:center;
  max-width:96px;margin:0 auto}
.rn-ws-zrail .rn-ws-zb{width:100%;min-width:50px;min-height:38px;font-size:15px}
.rn-ws-zrail .rn-ws-zpct{min-width:0;text-align:center}
.rn-ws-zrail .sp{flex:1}
/* a primary-bar CARD: one control per box, the slider long on top, its preset pills
   underneath, which is the user's arrangement and what stops the bar reading as one
   undifferentiated strip of widgets */
.rn-ws-pcard{display:flex;flex-direction:column;gap:5px;background:#15171b;
  border:1px solid #2f333a;border-radius:6px;padding:7px 10px;flex:1 1 200px;
  min-width:140px}
/* the user's card anatomy: title and preset pills on the HEAD row, the long bar on
   the bottom row, because the bar is the biggest thing a hand clicks and so the bar
   is what gets the width */
.rn-ws-pcard .head{display:flex;align-items:center;gap:10px;overflow:hidden}
.rn-ws-pcard .head .ttl{font-size:13px;font-weight:650;opacity:.8;flex:none}
.rn-ws-pcard .top{display:flex;align-items:center;gap:9px}
.rn-ws-pcard .top input[type=range]{flex:1 1 auto;min-width:70px;height:26px}
.rn-ws-pcard.rowline{flex-direction:row;align-items:center;gap:8px;flex:1 1 auto;
  padding:6px 11px}
.rn-ws-dpre{display:flex;background:#15171b;border:1px solid #33373d;border-radius:5px;
  padding:2px;gap:2px;flex:0 1 auto;min-width:0;overflow:hidden}
.rn-ws-dpb{background:none;border:0;border-radius:3px;color:#9aa0a8;cursor:pointer;
  font-size:12px;padding:5px 9px;font-variant-numeric:tabular-nums;flex:none;
  white-space:nowrap}
.rn-ws-dpb:hover{color:#fff}
.rn-ws-dpb.on{background:#b8283c;color:#fff;font-weight:600}
.rn-ws-denoise-track{position:relative;display:flex;flex-direction:column;
  flex:1 1 auto;min-width:150px;gap:1px}
.rn-ws-denoise-track input[type=range]{width:100%;margin:0}
.rn-ws-denoise-zones{position:relative;display:grid;grid-template-columns:40fr 20fr 40fr;
  height:5px;margin:0 7px;border-radius:3px;overflow:visible;background:#111316}
.rn-ws-denoise-zones::before,.rn-ws-denoise-zones::after{content:"";position:absolute;
  top:-4px;height:13px;border-left:1px solid #e5e7ebcc;z-index:2;pointer-events:none}
.rn-ws-denoise-zones::before{left:40%}
.rn-ws-denoise-zones::after{left:60%}
.rn-ws-denoise-zone{height:5px;opacity:.42;transition:opacity .12s,box-shadow .12s}
.rn-ws-denoise-zone:first-child{border-radius:3px 0 0 3px;background:#45c46b}
.rn-ws-denoise-zone:nth-child(2){background:#e0aa35}
.rn-ws-denoise-zone:last-child{border-radius:0 3px 3px 0;background:#e05268}
.rn-ws-denoise-zone.active{opacity:1;box-shadow:0 0 6px currentColor}
.rn-ws-denoise-labels{display:grid;grid-template-columns:40fr 20fr 40fr;margin:0 3px;
  color:#808791;font-size:8px;line-height:10px;text-transform:uppercase;
  letter-spacing:.025em;pointer-events:none}
.rn-ws-denoise-labels span:nth-child(1){text-align:left}
.rn-ws-denoise-labels span:nth-child(2){text-align:center}
.rn-ws-denoise-labels span:nth-child(3){text-align:right}
.rn-ws-denoise-labels span.active{color:#e8ecf1;font-weight:700}
/* Passes rides the denoise row: it multiplies THAT number and means nothing away from
   it. Lit red above 1, because a 4 left behind from yesterday is four times the wait
   with no other sign that anything changed */
.rn-ws-passes{display:flex;align-items:center;gap:5px;flex:none;background:#15171b;
  border:1px solid #33373d;border-radius:5px;padding:3px 7px}
.rn-ws-passes .k{font-size:11px;color:#9aa0a8;font-weight:600}
.rn-ws-passes input{width:48px;height:24px;box-sizing:border-box;background:#0f1114;
  border:1px solid #2a2e34;border-radius:4px;color:#e8ecf1;font-size:13px;
  font-weight:700;text-align:center;font-variant-numeric:tabular-nums;padding:0 0 0 4px}
.rn-ws-passes.on{border-color:#b8283c;background:#1d1418}
.rn-ws-passes.on .k{color:#e8a3ad}
.rn-ws-passes.on input{color:#fff;border-color:#b8283c}
.rn-ws-mask-track{position:relative;display:flex;flex-direction:column;
  flex:1 1 auto;min-width:150px;gap:1px}
.rn-ws-mask-track input[type=range]{width:100%;margin:0}
/* The columns are the SLIDER'S position shares, not the value ranges: the input runs
   through maskPosOf/maskValueOf, so the bar under it has to divide the same way or
   the handle sits over one colour while the bar claims another. */
.rn-ws-mask-zones{position:relative;display:grid;grid-template-columns:${MASK_ZONE_FR};
  height:5px;margin:0 7px;border-radius:3px;background:#111316}
.rn-ws-mask-zone{position:relative;height:5px;opacity:.4;
  transition:opacity .12s,box-shadow .12s}
.rn-ws-mask-zone:not(:first-child)::before{content:"";position:absolute;left:0;top:-4px;
  height:13px;border-left:1px solid #e5e7ebcc;z-index:2;pointer-events:none}
.rn-ws-mask-zone:first-child{border-radius:3px 0 0 3px;background:#45c46b}
.rn-ws-mask-zone:nth-child(2){background:#e0aa35}
.rn-ws-mask-zone:nth-child(3){background:#e05268}
.rn-ws-mask-zone:last-child{border-radius:0 3px 3px 0;background:#ff334f}
.rn-ws-mask-zone.active{opacity:1;box-shadow:0 0 7px currentColor}
.rn-ws-mask-risk{height:10px;color:#808791;font-size:8px;line-height:10px;
  text-align:right;text-transform:uppercase;letter-spacing:.035em;font-weight:700}
.rn-ws-dpb.risk-low{color:#83d49c}
.rn-ws-dpb.risk-medium{color:#e5bc59}
.rn-ws-dpb.risk-high{color:#ed8292}
.rn-ws-dpb.risk-low.on{background:#174427;color:#b9f6ca}
.rn-ws-dpb.risk-medium.on{background:#4b3912;color:#ffe39b}
.rn-ws-dpb.risk-high.on{background:#5a1823;color:#ffc0c9}
.rn-ws-zbar .sp{flex:1}
.rn-ws-zb{width:auto;min-width:30px;padding:3px 9px;font-size:12px}
.rn-ws-zb:disabled{opacity:.35;cursor:default}
.rn-ws-zpct{font-size:11px;opacity:.65;min-width:40px;text-align:center;
  font-variant-numeric:tabular-nums}
/* absolute, exactly like the paint canvas next to it. In normal flow the result
   image's own height drove the pane, so the whole tab jumped the first time you
   generated and then sat somewhere different from where you left it. */
.rn-ws-presult img{position:absolute;max-width:100%;max-height:100%;display:block}
/* THE LIVE FRAME over the result pane while a paint run samples: the picture
   forming where the result will land, swapped for the result the moment it does.
   Under the progress bar, over the last result. */
.rn-ws-presult img.rn-ws-plive{position:absolute;inset:0;width:100%;height:100%;
  max-width:none;max-height:none;object-fit:contain;z-index:6;background:#111316}
.rn-ws-plive-tag{position:absolute;top:8px;right:6px;z-index:7;background:#000c;
  color:#ffd58a;font-size:10.5px;padding:2px 7px;border-radius:4px;pointer-events:none;
  font-variant-numeric:tabular-nums}
.rn-ws-pgen-progress{position:absolute;left:0;right:0;top:0;height:4px;z-index:8;
  overflow:hidden;background:#35151bcc;opacity:0;pointer-events:none;
  transition:opacity .15s}
.rn-ws-pgen-progress.active{opacity:1}
.rn-ws-pgen-progress .fill{height:100%;width:0;background:linear-gradient(90deg,
  #b8283c,#ff6b7d);box-shadow:0 0 8px #ff5a70;transition:width .16s linear}
.rn-ws-pgen-progress.indeterminate .fill{width:34%;animation:rn-ws-pgen-sweep 1.05s
  ease-in-out infinite}
@keyframes rn-ws-pgen-sweep{
  from{transform:translateX(-105%)}
  to{transform:translateX(300%)}
}
.rn-ws-pactions{position:absolute;top:5px;right:6px;z-index:5;display:flex;gap:5px;
  align-items:center}
.rn-ws-pactions button{height:24px;border:1px solid #4a5058;border-radius:5px;
  background:#20242b;color:#e5e7eb;padding:0 8px;font-size:10px;font-weight:650;
  cursor:pointer;box-shadow:0 1px 4px #0008}
.rn-ws-pactions button.primary{border-color:#b8283c;background:#8f2031;color:#fff}
.rn-ws-pactions button:hover:not(:disabled){filter:brightness(1.14)}
.rn-ws-pactions button:disabled{opacity:.45;cursor:default}
.rn-ws-pstatus{position:absolute;top:34px;right:6px;z-index:5;max-width:70%;
  border-radius:4px;background:#000c;color:#e5e7eb;padding:3px 6px;font-size:9.5px;
  pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rn-ws-rstrip{position:absolute;left:6px;bottom:6px;right:6px;display:flex;gap:4px;
  z-index:3;justify-content:center;pointer-events:none}
.rn-ws-rstrip .t{position:static;width:auto;height:38px;max-width:64px;object-fit:cover;
  border-radius:3px;border:1px solid #2a2e35;opacity:.75;cursor:pointer;
  pointer-events:auto;background:#0d0f12}
.rn-ws-rstrip .t:hover{opacity:1}
.rn-ws-rstrip .t.cur{border-color:#b8283c;opacity:1}
.rn-ws-plabel{position:absolute;top:5px;left:6px;background:#000b;color:#fff;
  font-size:10px;padding:2px 6px;border-radius:4px;pointer-events:none;z-index:3}
.rn-ws-presolution{position:absolute;top:25px;left:6px;background:#000a;color:#cfd4dc;
  font-size:8.5px;line-height:1;padding:3px 5px;border-radius:4px;pointer-events:none;
  z-index:3;font-variant-numeric:tabular-nums;letter-spacing:.015em}
.rn-ws-pempty{font-size:11.5px;opacity:.45;text-align:center;padding:0 14px;
  line-height:1.5}
.rn-ws-tab.g-cfg{border-top-color:#6b7280}
.rn-ws-tab.gstart{margin-left:16px}
.rn-ws-tab.gstart::before{content:"";position:absolute;left:-11px;top:6px;bottom:6px;
  width:1px;background:#3a3f47}
.rn-ws-tab .dot{width:7px;height:7px;border-radius:50%;background:#4a5058;flex:none}
.rn-ws-tab .dot.on{background:#22c55e;box-shadow:0 0 5px #22c55e}
.rn-ws-tab .dot.warn{background:#ef4444;box-shadow:0 0 5px #ef4444}
.rn-ws-setupwarn{border:1px solid #7f1d1d;background:#2a1215;border-radius:7px;padding:8px 11px;
  display:flex;flex-direction:column;gap:3px;font-size:12px;color:#fecaca;line-height:1.45}
.rn-ws-setupwarn .ttl{font-weight:700;color:#fca5a5}
.rn-ws-body{background:#242830;border:1px solid #3d434c;border-radius:7px;padding:8px;
  display:flex;flex-direction:column;gap:7px;flex:1 1 auto;min-height:0;overflow:auto}
/* a stretched node must not stretch the reading: every tab's content stays a
   centred column at a comfortable width, so rows stop running the full span
   of a wide node. The Paint tab opts out - its canvas earns the width. */
.rn-ws-body:not(.full)>*{max-width:940px;width:100%;box-sizing:border-box;
  margin-left:auto;margin-right:auto}
.rn-ws-row{display:flex;gap:7px;align-items:center;flex:none}
.rn-ws-row .hint{font-size:11.5px;opacity:.5;line-height:1.4;flex:1}
.rn-ws-on{background:#15171b;border:1px solid #33373d;border-radius:4px;color:#9aa0a8;cursor:pointer;
  font-size:11.5px;font-weight:700;letter-spacing:.5px;height:30px;width:66px;flex:none}
.rn-ws-on.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4}
/* A toggle ON a section head is sized to the head's one line of text, not to the
   full 30px control. The AUTO PROMPT box wore the full-size button and sat taller
   than every other box in the settings column, which read as unevenness rather
   than importance. The heads share a min-height with the shrunk button so all of
   them land at exactly one height, with or without a toggle. */
.rn-ws-sect > .head .rn-ws-on{height:20px;width:auto;min-width:46px;padding:0 9px;
  font-size:10.5px;letter-spacing:.4px}
.rn-ws-sect > .head{min-height:20px}
.rn-ws-grid{display:flex;flex-wrap:wrap;gap:6px;overflow:auto}
.rn-ws-cell{position:relative;border-radius:5px;overflow:hidden;
  border:2px solid #2a2e35;cursor:pointer;flex:none;background:#111316}
.rn-ws-cell img{width:100%;height:100%;object-fit:cover;display:block}
.rn-ws-cell.sel{border-color:#b8283c;box-shadow:0 0 8px #b8283c66}
.rn-ws-cell.missing{border-style:dashed;border-color:#7f1d1d}
.rn-ws-cell.missing::after{content:"missing";position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;font-size:9px;color:#ff7b86;background:#0009}
.rn-ws-cell .rn-ws-x{position:absolute !important;top:2px;right:2px;left:auto;bottom:auto;
  width:18px;height:18px;border:0;border-radius:4px;margin:0;padding:0;transform:none;
  background:#000c;color:#ff9aa4;font-size:11px;line-height:1;cursor:pointer;display:none;z-index:2}
.rn-ws-cell:hover .rn-ws-x{display:block}
.rn-ws-x:hover{background:#7f1d1d;color:#fff}
.rn-ws-cell .rn-ws-n{position:absolute;bottom:2px;left:2px;background:#000c;color:#d4ffe4;font-size:9px;
  padding:0 4px;border-radius:3px;z-index:2}
.rn-ws-add{border-radius:5px;border:2px dashed #3d434c;background:none;
  color:#6b7280;font-size:24px;cursor:pointer;flex:none}
.rn-ws-add:hover{border-color:#b8283c;color:#fff}
.rn-ws-grid.drag{outline:2px dashed #b8283c;outline-offset:-2px}
.rn-ws-btn{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;cursor:pointer;
  font-size:13px;padding:8px 16px;flex:none;line-height:1.25}
.rn-ws-btn:hover:not(:disabled){border-color:#b8283c;color:#fff}
.rn-ws-btn:disabled{opacity:.35;cursor:not-allowed}
/* Every rn-ws-btn used as a TOGGLE sets .on, and until now nothing styled it: the
   reference toggles, the LoRA toggle and the fit toggle all looked identical whether
   they were on or off. A toggle you cannot read is worse than no toggle. */
.rn-ws-btn.on{background:#2a1116;border-color:#b8283c;color:#fff;font-weight:600;
  box-shadow:inset 0 0 0 1px rgba(184,40,60,.45)}
.rn-ws-btn.on:hover:not(:disabled){background:#38151c}
.rn-ws-dial{display:flex;align-items:center;gap:8px;flex:none}
.rn-ws-dial .lab{width:165px;font-size:12.5px;font-weight:600;flex:none}
.rn-ws-dial input[type=range]{flex:1;accent-color:#b8283c}
.rn-ws-dial .val{width:60px;background:#15171b;border:1px solid #33373d;border-radius:4px;color:#e8ecf1;
  font-size:12px;padding:4px 6px;text-align:right;flex:none}
.rn-ws-note{font-size:11.5px;opacity:.5;line-height:1.45}
/* a switch's label row: note-coloured words, but the switch stays at full strength */
.rn-ws-bpresets{display:flex;gap:6px;flex-wrap:wrap}
.rn-ws-bpreset{background:#15171b;border:1px solid #33373d;border-radius:6px;color:#c8ccd2;
  cursor:pointer;font-size:12.5px;font-weight:600;padding:7px 12px}
.rn-ws-bpreset:hover{border-color:#b8283c;color:#fff}
.rn-ws-bpreset.cur{background:#b8283c;border-color:#b8283c;color:#fff}
.rn-ws-swlabel{font-size:12px;color:#8a919b;display:flex;align-items:center;gap:6px}
.rn-ws-bigbtn{height:30px!important;padding:0 14px!important;font-size:13px!important;
  width:auto!important}
.rn-ws-warn{font-size:10.5px;color:#f0c58a;line-height:1.45}
.rn-ws-foot{display:flex;gap:7px;align-items:center;flex:none;padding-top:2px}
.rn-ws-res{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;font-size:11px;
  padding:4px 6px}
.rn-ws-mprev{max-width:100%;max-height:220px;border-radius:6px;border:1px solid #3d434c;align-self:flex-start}
/* The Masks tab's painter: a bounded canvas, not the Paint tab's full-height stage.
   A mask is drawn in a minute and the tab has two of them, so the pane earns a fixed
   slice of the panel rather than the whole fold. */
.rn-ws-mpane{height:300px;min-height:180px;flex:none}
.rn-ws-mpane canvas{position:absolute;max-width:100%;max-height:100%}
.rn-ws-mpane .paintlayer{cursor:crosshair;touch-action:none}
/* Canvas-only full screen: the picture and the marks, nothing else. The rail is the
   same tool bar the Paint tab stands upright in its own full screen, so the two
   rooms are learned once. */
.rn-ws-conly-room{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}
.rn-ws-conly-pane{flex:1 1 auto;min-width:0;min-height:0;display:flex;align-items:center;
  justify-content:center;background:#111316;border:1px solid #2f333a;border-radius:8px;
  overflow:hidden;position:relative}
.rn-ws-conly-pane > *{width:100%;height:100%;max-height:100%}
.rn-ws-conly-open{position:absolute;top:5px;right:5px;z-index:4;width:auto;
  padding:2px 8px;font-size:13px;line-height:1;background:#000c}
/* The tool bar is a WIDE STRIP UNDER THE PICTURE, not a cramped column of bare
   glyphs down the side: a vertical rail had no room for a word next to any icon,
   which is why it read as unlabelled buttons nobody could identify at a glance. */
.rn-ws-conly-rail{flex:0 0 auto;width:100%;display:flex;flex-wrap:wrap;
  align-items:center;gap:8px;padding:9px 11px;background:#1b1e23;
  border:1px solid #2f333a;border-radius:8px;box-sizing:border-box}
.rn-ws-conly-rail .rn-ws-zb{height:32px;padding:0 12px;font-size:12.5px;flex:none}
.rn-ws-conly-rail .sp{flex:1 1 16px}
/* Each cluster of related buttons (view, brush, mask actions) gets its own boxed
   group, the same way the Mask size row separates its controls, instead of one
   undifferentiated row of squeezed buttons. */
.rn-ws-conly-group{display:flex;align-items:center;gap:7px;padding:4px 9px 4px 4px;
  background:#16181c;border:1px solid #2a2e35;border-radius:7px;flex:none}
.rn-ws-conly-group .lab{font-size:11px;opacity:.6;flex:none;padding-left:4px}
.rn-ws-sect{border:1px solid #3d434c;border-left:3px solid #6b7280;border-radius:7px;background:#1b1e23;
  padding:6px;display:flex;flex-direction:column;gap:6px;flex:none;margin-top:3px}
.rn-ws-sect > .head{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.rn-ws-sect > .head .arr{font-size:13px;color:#9aa0a8;width:16px}
.rn-ws-sect > .head .ttl{font-size:11.5px;font-weight:700;letter-spacing:.4px;opacity:.7;flex:1}
.rn-ws-sect > .head .ttl.rn-ws-savedttl{font-size:13px;letter-spacing:0;opacity:.9}
.rn-ws-sect .rn-ws-dial{margin-left:12px}
/* The Post tab: the chain list beside one editor. */
.rn-ws-fxsplit{display:flex;gap:10px;align-items:stretch;min-height:220px}
.rn-ws-fxlist{flex:none;width:280px;display:flex;flex-direction:column;border:1px solid #2a2e35;
  border-radius:6px;background:#16181c;padding:0 0 6px;max-height:760px;overflow-y:auto}
.rn-ws-fxband{font-size:11.5px;letter-spacing:.12em;font-weight:700;color:#e0e4ea;
  background:#252a32;border-left:2px solid #b8283c;padding:7px 10px;margin:6px 0 2px}
.rn-ws-fxband:first-child{margin-top:0}
.rn-ws-fxrow{display:flex;align-items:center;gap:9px;padding:6px 10px 6px 8px;cursor:pointer;
  border-left:2px solid transparent;font-size:13.5px;color:#8d939b;white-space:nowrap}
.rn-ws-fxrow.on{color:#e0e4ea}
.rn-ws-fxrow:hover{background:#1b1f25}
.rn-ws-fxrow.sel{background:#20242b;border-left-color:#b8283c;color:#fff}
.rn-ws-fxname{overflow:hidden;text-overflow:ellipsis}
.rn-ws-fxadd{display:flex;gap:6px;align-items:center;padding:6px 8px 10px}
.rn-ws-fxdel{margin-left:auto;flex:none;background:none;border:1px solid transparent;color:#6b7480;
  font-size:11px;padding:1px 5px;border-radius:4px;cursor:pointer}
.rn-ws-fxdel:hover{color:#fff;border-color:#b8283c}
.rn-ws-fxrow .rn-ws-fxlimitpill + .rn-ws-fxdel{margin-left:6px}
.rn-ws-fxadd select{flex:1;min-width:0}
.rn-ws-fxboard{display:flex;align-items:stretch;gap:6px;margin-top:6px}
.rn-ws-fxscroll{flex:none;width:26px;background:none;border:0;color:#6b7480;font-size:22px;cursor:pointer;
  border-radius:6px}
.rn-ws-fxscroll:hover{color:#fff;background:#1b1f25}
.rn-ws-fxcards{flex:1;min-width:0;display:flex;gap:10px;overflow-x:auto;padding:10px 4px 14px;
  scroll-behavior:smooth}
.rn-ws-fxcard{position:relative;flex:none;width:120px;height:260px;display:flex;flex-direction:column;
  align-items:center;background:#1b1e24;border:1px solid #2d323a;border-radius:8px;cursor:grab;
  overflow:hidden;user-select:none}
.rn-ws-fxcard .big{position:absolute;top:2px;left:0;right:0;text-align:center;font-size:66px;
  font-weight:800;color:#fff;opacity:.08;pointer-events:none;font-variant-numeric:tabular-nums}
.rn-ws-fxcard .n{margin-top:66px;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:#fff;color:#111;font-weight:700;font-size:14px;
  font-variant-numeric:tabular-nums}
.rn-ws-fxcard .nm{margin-top:14px;padding:0 8px;text-align:center;font-size:13px;font-weight:600;
  color:#e8ecf1;line-height:1.25;min-height:34px}
.rn-ws-fxcard .st{margin-top:auto;width:9px;height:9px;border-radius:50%;background:#3a3f47}
.rn-ws-fxcard .st.on{background:#22c55e;box-shadow:0 0 6px #22c55e}
.rn-ws-fxcard .lim{margin:8px 0 12px;font-size:11.5px;color:#c7ccd3}
.rn-ws-fxcard .foot{width:100%;text-align:center;font-size:10px;letter-spacing:.14em;font-weight:800;
  color:#fff;padding:9px 0 10px;text-transform:uppercase}
.rn-ws-fxcard .acts{position:absolute;top:6px;right:6px;display:flex;gap:2px;opacity:0;transition:opacity .12s}
.rn-ws-fxcard:hover .acts{opacity:1}
.rn-ws-fxcard .acts button{background:#000a;border:1px solid #33373d;color:#c7ccd3;font-size:11px;
  padding:1px 5px;border-radius:4px;cursor:pointer}
.rn-ws-fxcard .acts button:hover{color:#fff;border-color:#b8283c}
.rn-ws-fxcard.drop{box-shadow:-4px 0 0 0 #b8283c}
.rn-ws-fxcard.focus{border-color:#fff;box-shadow:0 0 0 2px #ffffff55}
.rn-ws-modelchip{display:inline-flex;align-items:center;gap:6px}
.rn-ws-modellink{background:none;border:0;color:#8fb7ff;font-size:11.5px;cursor:pointer;padding:0 2px}
.rn-ws-modellink:hover{color:#fff;text-decoration:underline}
.rn-ws-fxwarn{flex:none;width:16px;height:16px;border-radius:50%;background:#b8283c;color:#fff;
  font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-left:auto}
.rn-ws-fxwarn + .rn-ws-fxlimitpill{margin-left:6px}
.rn-ws-modelstat{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:8px;
  border:1px solid #2a2e35;background:#121418;font-size:12px}
.rn-ws-modelstat.ok{border-color:#1f6b45}
.rn-ws-modelstat.missing{border-color:#b8283c}
.rn-ws-modelstat .head{font-weight:600;color:#e8ecf1}
.rn-ws-modelstat.ok .head{color:#7fe0a8}
.rn-ws-modelstat.missing .head{color:#ff9aa6}
.rn-ws-modelstat .dim{color:#8a919b;word-break:break-all}
.rn-ws-modelstat .install{color:#f0c58a}
.rn-ws-refdrop{display:flex;gap:14px;align-items:center;padding:10px;border:1px dashed #3a3f47;
  border-radius:8px;background:#121418}
.rn-ws-refdrop.live{border-color:#b8283c;border-style:solid}
.rn-ws-refdrop.over{border-color:#fff;background:#1b1f25}
.rn-ws-refdrop .pic{flex:none;width:120px;height:90px;border-radius:6px;background:#0c0d10;
  display:flex;align-items:center;justify-content:center;font-size:11px;color:#6b7480;overflow:hidden}
.rn-ws-refdrop .pic img{width:100%;height:100%;object-fit:cover}
.rn-ws-refdrop .side{display:flex;flex-direction:column;gap:8px;min-width:0}
.rn-ws-orderbar{gap:8px;flex-wrap:wrap}
.rn-ws-orderbar select{min-width:180px}
.rn-ws-fxmapcap{font-size:10.5px;letter-spacing:.12em;font-weight:700;color:#8a919b;margin:14px 0 6px 32px}
.rn-ws-fxmap2{display:flex;flex-wrap:wrap;gap:6px;margin:0 32px 8px}
.rn-ws-fxsq{display:flex;align-items:center;gap:7px;width:132px;height:34px;padding:0 8px;border:0;
  border-radius:5px;cursor:pointer;color:#fff;text-align:left;box-shadow:inset 0 0 0 1px #0003}
.rn-ws-fxsq .num{flex:none;width:20px;height:20px;border-radius:50%;background:#000c;color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;
  font-variant-numeric:tabular-nums}
.rn-ws-fxsq .nm{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  text-shadow:0 1px 1px #0006}
.rn-ws-fxsq:hover{filter:brightness(1.15)}
.rn-ws-fxsq.focus{box-shadow:0 0 0 2px #fff}
.rn-ws-ordermenu .posrow{display:flex;align-items:center;gap:6px;padding:4px 9px}
.rn-ws-ordermenu .posrow span{font-size:12px;color:#ddd}
.rn-ws-ordermenu .posrow input{width:56px;background:#15171b;border:1px solid #3a3d44;color:#eee;
  border-radius:4px;padding:3px 5px}
.rn-ws-ordermenu .posrow button{padding:4px 10px;border:1px solid #3a3d44}
.rn-ws-fxcard.dragging{opacity:.5;transform:rotate(-2deg)}
.rn-ws-eye{width:16px;height:16px;flex:none;border:none;background:none;color:#474b52;
  padding:0;cursor:pointer;font-size:11px;line-height:16px;text-align:center}
.rn-ws-eye.on{color:#22c55e;text-shadow:0 0 5px #22c55e88}
.rn-ws-eye.gear{color:#474b52;font-size:12px;cursor:default}
.rn-ws-fxlimitpill{margin-left:auto;font-size:9px;border:1px solid #6b5a2a;color:#d4b25f;
  border-radius:8px;padding:0 5px;line-height:14px}
.rn-ws-fxedit{flex:1;min-width:0;border:1px solid #2a2e35;border-radius:6px;background:#16181c;
  padding:14px 20px 14px 20px;display:flex;flex-direction:column;gap:10px}
.rn-ws-fxedit > .head{display:flex;align-items:center;gap:10px}
.rn-ws-fxedit > .head .ttl{font-size:13px;font-weight:700;letter-spacing:.4px;opacity:.9}
.rn-ws-fxedit .blurb{font-size:12px;opacity:.6;line-height:1.45;margin:0;max-width:900px}
/* the controls fill the width: two columns on a wide panel, one when narrow */
.rn-ws-fxedit .rn-ws-fxgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));
  gap:10px 32px;margin:6px 0 4px}
.rn-ws-fxedit .rn-ws-fxc{flex-direction:row;align-items:center;gap:12px}
.rn-ws-fxedit .rn-ws-fxc .lab{width:132px;flex:none;font-size:12.5px}
.rn-ws-fxedit .rn-ws-fxc .val{font-size:12.5px;width:64px}
.rn-ws-fxedit .rn-ws-fxc input[type=range]{height:22px}
.rn-ws-fxedit .rn-ws-fxc .line{flex:1}
.rn-ws-fxedit .rn-ws-fxc select{width:auto;flex:1}
.rn-ws-fxlimit{border-top:1px solid #2a2e35;padding-top:8px;margin-top:2px;gap:8px}
.rn-ws-fxlimit .lab{font-size:11px;font-weight:600;opacity:.8}
.rn-ws-fxlimit input.val{width:58px}
.rn-ws-cost{font-size:9.5px;letter-spacing:.02em;padding:1px 6px;border-radius:9px;
  border:1px solid #6b5a2a;color:#d4b25f;background:#241f12;white-space:nowrap;flex:none}
.rn-ws-fxgrid{display:flex;flex-direction:column;gap:6px;margin:5px 0 2px}
.rn-ws-fxc{display:flex;flex-direction:column;gap:2px;min-width:0}
.rn-ws-fxhead{font-size:12px;font-weight:700;opacity:.55;margin:8px 0 0;border-top:1px solid #2a2e35;
  padding-top:7px;grid-column:1/-1}
.rn-ws-fxgrid > .rn-ws-fxhead:first-child{margin-top:0;border-top:0;padding-top:0}
.rn-ws-fxact .line{gap:9px;align-items:center}
.rn-ws-fxact .rn-ws-note{font-size:11px;opacity:.65;white-space:normal}
.rn-ws-fxc .lab{font-size:11px;font-weight:600;opacity:.8;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.rn-ws-fxc .line{display:flex;align-items:center;gap:6px;min-width:0}
.rn-ws-fxc input[type=range]{flex:1;min-width:0;accent-color:#b8283c}
.rn-ws-fxc .val{width:58px;flex:none;background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:11px;padding:3px 4px;text-align:center}
.rn-ws-fxc select{width:100%;min-width:0}
.rn-ws-fxc .lab.rnd{color:#c084fc;opacity:1}
.rn-ws-rng{position:relative;flex:1;height:18px;min-width:0}
.rn-ws-rng input[type=range]{position:absolute;left:0;top:0;width:100%;margin:0;
  background:none;pointer-events:none;-webkit-appearance:none;appearance:none;height:18px}
.rn-ws-rng input[type=range]::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;
  width:11px;height:11px;border-radius:50%;background:#c084fc;border:0;cursor:grab}
.rn-ws-rng input[type=range]::-moz-range-thumb{pointer-events:auto;width:11px;height:11px;
  border-radius:50%;background:#c084fc;border:0;cursor:grab}
.rn-ws-rng .track{position:absolute;left:0;right:0;top:7px;height:4px;background:#33373d;
  border-radius:2px}
.rn-ws-rng .fil{position:absolute;top:7px;height:4px;background:#c084fc;border-radius:2px}
.rn-ws-rng .tick{position:absolute;top:2px;width:2px;height:14px;background:#f0c58a;
  border-radius:1px}
.rn-ws-fxc .val.rng{color:#c084fc;font-size:9.5px;width:82px;letter-spacing:-.2px}
.rn-ws-fxc .val.rolled{color:#f0c58a}
.rn-ws-thumbs{display:flex;align-items:center;gap:6px;margin-left:auto}
.rn-ws-thumbs input{width:90px;accent-color:#b8283c}
.rn-ws-coll{display:flex;gap:5px;align-items:center;flex:none}
.rn-ws-coll select{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#e8ecf1;
  font-size:12px;padding:5px 6px;max-width:190px}
.rn-ws-coll button{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#9aa0a8;
  cursor:pointer;font-size:12px;width:27px;height:27px;padding:0;line-height:1;
  display:inline-flex;align-items:center;justify-content:center}
/* the emoji has its own baseline ideas; pin it dead centre */
.rn-ws-coll .rn-ws-dice{font-size:13px;padding:0;text-indent:0}
.rn-ws-coll button:hover:not(:disabled){border-color:#b8283c;color:#fff}
.rn-ws-coll button:disabled{opacity:.35;cursor:not-allowed}
.rn-ws-coll .rn-ws-dice.on{border-color:#6b4a1d;color:#f0c58a;background:#241d12}
.rn-ws-cell.rolled{border-color:#f0c58a;box-shadow:0 0 8px #f0c58a66}
.rn-ws-cell .rn-ws-roll{position:absolute;top:2px;left:2px;background:#000c;color:#f0c58a;
  font-size:10px;padding:0 3px;border-radius:3px;z-index:2}
.rn-ws-thumbs .t{font-size:10.5px;opacity:.5}
.rn-ws-vsp{flex:1;background:#15171b;border:1px solid #33373d;border-radius:5px;color:#e8ecf1;
  font:12px system-ui,sans-serif;padding:6px 8px;resize:vertical;min-height:52px}
.rn-ws-vsp:focus{outline:none;border-color:#b8283c}
.rn-ws-advgrid{display:flex;flex-wrap:wrap;gap:6px;background:#1b1e23;border:1px solid #33373d;
  border-radius:6px;padding:7px}
.rn-ws-advgrid .advh{width:100%;font-size:10px;font-weight:700;letter-spacing:.5px;opacity:.55}
.rn-ws-advgrid .cellc{display:flex;align-items:center;gap:5px;font-size:11px;color:#9aa0a8}
.rn-ws-advgrid .cellc.wide{width:100%}
/* IMG2IMG AS SUB-TABS: a strip with a light per section, a status bar, cards */
.rn-ws-sub{display:flex;gap:6px;flex-wrap:wrap}
.rn-ws-subt{flex:1 1 110px;display:flex;align-items:center;justify-content:center;gap:8px;
  background:#15171b;border:1px solid #2a2e35;border-radius:7px;color:#9aa0a8;cursor:pointer;
  font-size:12px;font-weight:700;letter-spacing:.06em;padding:8px 10px;white-space:nowrap}
.rn-ws-subt:hover{border-color:#3d434c;color:#c8ccd2}
.rn-ws-subt.cur{background:#b8283c;border-color:#b8283c;color:#fff}
.rn-ws-subt .lt{width:9px;height:9px;border-radius:50%;background:#4a5058;flex:none}
.rn-ws-subt .lt.on{background:#22c55e;box-shadow:0 0 6px #22c55e}
.rn-ws-subt .lt.skip{background:#e0a84a;box-shadow:0 0 6px #e0a84a}
.rn-ws-sub.inner .rn-ws-subt{padding:5px 10px;font-size:11px;background:#1b1e23}
.rn-ws-sub.inner .rn-ws-subt.cur{background:#233247;border-color:#4a8fe0;color:#fff}
.rn-ws-peoplewarn{color:#f0c58a}
/* a small flow diagram: what goes in, how it is joined, what comes out */
.rn-ws-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;
  background:#15171b;border:1px solid #2e333a;border-radius:6px}
.rn-ws-flow .fc{font-size:12px;color:#e8ecf1;background:#22262c;border:1px solid #3a3f47;
  border-radius:12px;padding:2px 9px;white-space:nowrap}
.rn-ws-flow .fc.none{color:#7f8792;font-style:italic}
.rn-ws-flow .op{font-size:12px;font-weight:700;color:#fff;background:#233247;
  border:1px solid #4a8fe0;border-radius:4px;padding:2px 8px;white-space:nowrap}
.rn-ws-flow .op.llm{background:#3a2a10;border-color:#e0a84a}
.rn-ws-flow .out{font-size:12px;font-weight:650;color:#9fe0b4;white-space:nowrap}
.rn-ws-flow .sym{color:#6b7280;font-size:13px}
.rn-ws-person{display:flex;gap:10px;align-items:flex-start;background:#15171b;
  border:1px solid #2e333a;border-radius:6px;padding:6px 8px}
.rn-ws-person.off{opacity:.6}
.rn-ws-person img{width:52px;height:52px;object-fit:cover;border-radius:4px;flex:none}
.rn-ws-person .pb{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0}
.rn-ws-person .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rn-ws-person .tag{font-size:11px;font-weight:700;color:#9aa0a8;min-width:52px}
.rn-ws-person input[type=text]{flex:1 1 120px;min-width:0;background:#0f1114;
  border:1px solid #33373d;border-radius:5px;color:#e8ecf1;padding:4px 8px}
.rn-ws-person .cap{font-size:12px;color:#aab0b8;white-space:pre-wrap;line-height:1.4}
.rn-ws-skipnote{border-color:#e0a84a88;color:#f0c58a}
.rn-ws-badge{align-self:flex-start;font-size:10.5px;font-weight:700;letter-spacing:.06em;
  padding:2px 8px;border-radius:5px;background:#2a2e35;color:#c8ccd2}
.rn-ws-badge.gen{background:#1e5233;color:#d4ffe4}
.rn-ws-latsq{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  border:1px dashed #5b6470;pointer-events:none;box-sizing:border-box}
.rn-ws-latsq span{position:absolute;left:0;right:0;top:-18px;text-align:center;
  font-size:10.5px;color:#7f8792}
.rn-ws-latrect{position:relative;z-index:1}
.rn-ws-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#1b1e23;
  border:1px solid #2e333a;border-radius:7px;padding:7px 10px}
.rn-ws-status .nm{font-size:13px;color:#e8ecf1;margin-right:4px}
.rn-ws-chip{font-size:11.5px;color:#aab0b8;background:#15171b;border:1px solid #2e333a;
  border-radius:5px;padding:3px 8px;white-space:nowrap}
.rn-ws-card{display:flex;flex-direction:column;gap:8px;background:#1b1e23;
  border:1px solid #2e333a;border-radius:7px;padding:10px;min-width:0;box-sizing:border-box}
.rn-ws-card > .ch{font-size:11px;font-weight:700;letter-spacing:.08em;color:#8a919b}
.rn-ws-card hr{border:0;border-top:1px solid #2e333a;margin:2px 0;width:100%}
.rn-ws-cols{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}
.rn-ws-cols > .l{flex:1 1 260px;box-sizing:border-box}
.rn-ws-cols > .r{flex:3 1 380px}
.rn-ws-card .rn-ws-advgrid{background:none;border:0;padding:0}
.rn-ws-sect.flat{border-left-width:1px}
.rn-ws-chosen{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rn-ws-chosen img{width:56px;height:56px;object-fit:cover;border-radius:5px;
  border:1px solid #2e333a;flex:none}
.rn-ws-chosen .meta{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.rn-ws-chosen .fn{font-size:13px;color:#e8ecf1;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rn-ws-chosen .dim{font-size:11.5px;color:#8a919b}
.rn-ws-chosen button{height:30px;padding:0 14px}
.rn-ws-passcard{display:flex;gap:10px;align-items:stretch;background:#1b1e23;
  border:1px solid #2e333a;border-radius:7px;padding:9px 12px}
.rn-ws-passcard .pn{flex:none;width:22px;font-size:17px;color:#6b7280;align-self:center;
  text-align:center}
.rn-ws-passcard .pb{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
.rn-ws-pline{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch}
/* each setting its own little box: a coloured edge, its name in that colour, and the
   value in a pill right beside its own bar, so the three never read as one */
.rn-ws-pdial{flex:1 1 170px;display:flex;flex-direction:column;gap:4px;min-width:0;
  background:#15171b;border:1px solid #2e333a;border-left:3px solid #6b7280;
  border-radius:6px;padding:6px 10px}
.rn-ws-pdial .k{font-size:13px;font-weight:650;color:#9aa0a8}
.rn-ws-pdial .bar{display:flex;align-items:center;gap:8px}
.rn-ws-pdial input[type=range]{flex:1;min-width:0;height:22px}
.rn-ws-pdial .v{font-size:12.5px;font-weight:650;color:#e8ecf1;background:#0f1114;
  border:1px solid #33373d;border-radius:4px;padding:1px 7px;white-space:nowrap;flex:none}
.rn-ws-pline2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rn-ws-pline2 .dim{font-size:11.5px;color:#7f8792;margin-right:auto}
.rn-ws-pline2 select{min-width:150px}
.rn-ws-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.rn-ws-tile{display:flex;align-items:center;gap:8px;background:#15171b;
  border:1px solid #2e333a;border-radius:6px;padding:6px 8px;font-size:12px;color:#c8ccd2;
  cursor:pointer}
.rn-ws-tile.dis{opacity:.5}
.rn-ws-stepper{display:flex;align-items:center}
.rn-ws-stepper button{width:30px;height:28px;background:#15171b;border:1px solid #33373d;
  color:#ddd;cursor:pointer;font-size:15px}
.rn-ws-stepper input{width:48px;height:28px;box-sizing:border-box;text-align:center;
  background:#0f1114;border:1px solid #33373d;border-left:0;border-right:0;color:#fff}
.rn-ws-stepper.on input,.rn-ws-stepper.on button{border-color:#b8283c}
/* the number sits dead centre: no padding, and no native spin arrows reserving room
   on the right (the minus and plus buttons already do that job) */
.rn-ws-stepper input{text-align:center!important;padding:0!important;
  -moz-appearance:textfield;appearance:textfield}
.rn-ws-stepper input::-webkit-outer-spin-button,
.rn-ws-stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.rn-ws-shdial{display:flex;align-items:center;gap:8px}
.rn-ws-shdial .k{font-size:12px;color:#9aa0a8;min-width:52px}
.rn-ws-shdial input[type=range]{flex:1;min-width:0;height:20px}
.rn-ws-shdial .v{font-size:12px;color:#e8ecf1;min-width:44px;text-align:right}
.rn-ws-elist{display:flex;flex-direction:column;border:1px solid #2e333a;border-radius:7px;
  overflow:hidden;background:#1b1e23}
.rn-ws-erow{display:flex;align-items:center;gap:10px;padding:7px 10px;
  border-bottom:1px solid #262a30;cursor:pointer;font-size:13px;color:#c8ccd2}
.rn-ws-erow:last-child{border-bottom:0}
.rn-ws-erow:hover{background:#20242a}
.rn-ws-erow.cur{background:#3a1c22;box-shadow:inset 3px 0 0 #b8283c;color:#fff}
.rn-ws-erow .st{margin-left:auto;font-size:11px;color:#6b7280}
.rn-ws-erow.dis{color:#6b7280}
.rn-ws-result{white-space:pre-wrap;line-height:1.45;color:#c8ccd2;background:#15171b;
  border:1px solid #2e333a;border-radius:6px;padding:8px 10px}
.rn-ws-advgrid .cellc input[type=number]{width:74px;background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:11.5px;padding:4px 5px}
.rn-ws-advgrid .cellc input[type=text]{flex:1;background:#15171b;border:1px solid #33373d;
  border-radius:4px;color:#e8ecf1;font-size:11.5px;padding:4px 6px}
.rn-ws-vram{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:3px;
  font-size:8.5px;font-weight:700;letter-spacing:.5px;vertical-align:middle}
.rn-ws-vram.high{background:#4a1f26;color:#ff9aa4;border:1px solid #7f2230}
.rn-ws-vram.med{background:#241d12;color:#f0c58a;border:1px solid #6b4a1d}
.rn-ws-vram.low{background:#16241c;color:#86d3a1;border:1px solid #2f7a4d}
.rn-ws-vram.off{background:#1b1e23;color:#6b7280;border:1px solid #33373d}
.rn-ws-latstage{position:relative;width:100%;height:420px;background:#0f1114;
  border:1px solid #2a2e34;border-radius:8px;display:flex;align-items:center;
  justify-content:center;flex:none;
  background-image:linear-gradient(#1a1d22 1px,transparent 1px),
    linear-gradient(90deg,#1a1d22 1px,transparent 1px);background-size:24px 24px}
.rn-ws-latrect{background:#1d2a3a;border:2px solid #4a8fe0;border-radius:3px;display:flex;
  align-items:center;justify-content:center;color:#9dc0ff;font-size:11px;font-weight:700;
  cursor:move;user-select:none;box-shadow:0 0 10px #4a8fe044}
.rn-ws-latrect.rolling{border-color:#f0c58a;color:#f0c58a;border-style:dashed;box-shadow:0 0 10px #f0c58a44}
.rn-ws-latchips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;flex:none}
.rn-ws-latchip{min-width:76px;height:66px;background:#15171b;border:1px solid #2a2e34;
  border-radius:8px;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:5px;cursor:pointer;flex:none;padding:0 10px;
  color:#c8ccd2;font-size:13px;font-weight:600}
.rn-ws-latchip:hover{border-color:#4a8fe0}
.rn-ws-latchip.cur{border-color:#4a8fe0;background:#4a8fe01a;color:#fff}
.rn-ws-latchip i{display:block;background:transparent;border:2px solid #9dc0ff;border-radius:2px}
.rn-ws-lookgrid{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}
.rn-ws-look{position:relative;border-radius:5px;overflow:hidden;
  border:2px solid #2a2e35;background:#111316;cursor:pointer;flex:none;display:flex;
  align-items:center;justify-content:center}
.rn-ws-look:hover{border-color:#22a39f}
.rn-ws-look.live{border-color:#3d434c;cursor:default}
.rn-ws-look img{width:100%;height:100%;object-fit:cover;display:block}
.rn-ws-look .ph{font-size:9.5px;opacity:.45;text-align:center;padding:0 4px}
.rn-ws-look .cap{position:absolute;left:0;right:0;bottom:0;background:#000c;color:#e8ecf1;
  font-size:9px;padding:2px 3px;text-align:center;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rn-ws-look.shipped{border-color:#2c4a48}
.rn-ws-look .sw{position:absolute;inset:0}
.rn-ws-look .tag{position:absolute;left:3px;top:3px;font-size:8px;font-weight:700;
  letter-spacing:.06em;background:#22a39fcc;color:#06211f;border-radius:3px;
  padding:0 3px;line-height:12px}
.rn-ws-menu{position:fixed;z-index:10003;min-width:210px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;box-shadow:0 8px 24px #000a;padding:4px;display:flex;flex-direction:column}
.rn-ws-menu button{background:none;border:0;color:#ddd;border-radius:5px;padding:7px 9px;cursor:pointer;
  font-size:12px;text-align:left}
.rn-ws-menu button:hover{background:#b8283c;color:#fff}
.rn-ws-menu .sep{height:1px;background:#33373d;margin:2px 4px}
.rn-ws-menu .note{font-size:10px;opacity:.5;padding:2px 9px 4px;max-width:240px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.rn-ws-batchrow{display:flex;align-items:center;gap:6px;padding:4px 8px}
.rn-ws-batchrow label{font-size:11px;color:#aeb4bd;flex:1}
.rn-ws-batchrow input[type=number]{width:62px;background:#111316;border:1px solid #3a3d44;
  border-radius:4px;color:#fff;padding:5px 6px;font-size:12px;text-align:center}
.rn-ws-batchrow input[type=checkbox]{accent-color:#b8283c}
.rn-ws-pqueue{flex:none;border:1px solid #3a3d44;border-radius:9px;background:#15171b;
  color:#9aa0a8;padding:2px 7px;font-size:9.5px;font-weight:650;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.rn-ws-pqueue.active{border-color:#b8283c;color:#fff;background:#3a151c}
.rn-ws-tuck{background:#1b1e23;border:1px solid #2a2e35;border-radius:6px;color:#9aa0a8;cursor:pointer;
  font-size:12px;padding:6px 9px;flex:none;margin-left:auto}
.rn-ws-tuck.on{background:#1e3a52;border-color:#4a8fe0;color:#9dc0ff}
.rn-ws-tuck.all{background:#3a1e26;border-color:#b8283c;color:#ff9aa4}
.rn-ws-panel{position:fixed;z-index:10002;width:300px;background:#1b1e23;border:1px solid #3a3d44;
  border-radius:7px;padding:10px;font:12.5px system-ui,sans-serif;color:#ddd;box-shadow:0 10px 30px #000c;
  display:flex;flex-direction:column;gap:8px}
.rn-ws-panel h5{margin:0;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.4px}
.rn-ws-panel button{background:#15171b;border:1px solid #33373d;color:#ddd;border-radius:5px;
  padding:7px 9px;cursor:pointer;font-size:12px;text-align:left}
.rn-ws-panel button:hover{border-color:#b8283c;color:#fff}
.rn-ws-panel input{background:#15171b;border:1px solid #33373d;border-radius:5px;color:#ddd;
  padding:7px 9px;font-size:12px}
.rn-ws-cog{background:#111316;border:1px solid #33373d;border-radius:5px;color:#c2c7cd;cursor:pointer;
  font-size:15px;width:34px;height:30px;flex:none;margin-left:auto}
.rn-ws-cog:hover{color:#fff;border-color:#b8283c}
/* open settings read as ON, the same green the toggles use, so a panel full of rows
   is never a mystery about which cog opened it */
.rn-ws-cog.on{background:#1e5233;border-color:#2f7a4d;color:#d4ffe4}
.rn-ws-cog.on:hover{border-color:#b8283c}
`;
let styled = false;
function injectStyle() {
  if (styled || !document.head) return;
  document.head.appendChild(css);
  styled = true;
}

const findWidget = (n, name) => (n.widgets || []).find((w) => w.name === name);

// The overlay colours, as "r,g,b" for rgba() composition. Red is the pack's brand
// colour and the default. Blue, magenta and yellow are Okabe-Ito values, the standard
// colour-blind-safe set, taken rather than invented: red and green collapse together
// for the commonest deficiency, so green is deliberately NOT offered as the only
// alternative. White and black separate by brightness alone, which works for every
// form of colour vision including none.
const OVERLAY_COLORS = {
  red: "184,40,60", blue: "0,114,178", magenta: "204,121,167",
  yellow: "240,228,66", white: "255,255,255", black: "0,0,0",
};

// Preference edits made in ComfyUI's OWN settings dialog have to reach the panels
// too: without this, changing the overlay colour there looked like it did nothing
// until an unrelated repaint came along.
//
// Through the settings API's `onChange`, which is the contract the frontend
// actually honours. A first attempt listened for `setting.<id>` events on the api
// object and was completely inert, because nothing dispatches those; the hook is
// declared on the setting itself and rednode_settings.js calls back here.
//
// Overlay edits REPAINT ONLY, never render: onChange also fires for the panel's own
// setWsPref writes, and rendering from the slider's own change handler would rebuild
// the slider mid-drag. The structural ones re-render, which their panel buttons
// already do anyway, so a double render is merely redundant rather than wrong.
// Every live mask overlay on one node, in place: the Paint pane publishes
// _rnShowAll, but each Masks-tab painter keeps its own showAll on its slot, and a
// repaint that only called the former left open Masks canvases on the old colour.
function repaintOverlays(n) {
  n._rnShowAll?.();
  for (const s of Object.values(n._rnMaskSlots || {})) s.showAll?.();
}

onWsPrefChange((key) => {
  const structural = key === "PaintLayout" || key === "HiddenTabs";
  for (const n of allNodes()) {
    if (n.type !== NODE_NAME) continue;
    if (structural) render(n);
    else repaintOverlays(n);
  }
});

// The hidden-tab preference, normalised on every read: only real tab ids count, and
// ADVANCED CAN NEVER BE HIDDEN because it is the way back to the control that
// unhides things. A stored list that somehow names it is corrected here rather
// than honoured.
function hiddenTabSet() {
  const raw = wsPref("HiddenTabs", []);
  const known = new Set(TAB_ORDER.map((t) => t.id));
  return new Set((Array.isArray(raw) ? raw : [])
    .map(String).filter((id) => known.has(id) && id !== "advanced"));
}

// ---- config ----------------------------------------------------------------
const TAB_DEFAULT_ON = new Set(["subject", "scene", "moodboard"]);
// Galleries are grouped into named COLLECTIONS ("red dress", "castle set"…). The legacy
// flat fields t.images / t.sel stay mirrored from the ACTIVE collection, so workspace.py
// and old workflows read exactly what they always did.
const GALLERY_TABS = ["i2i", "subject", "subject2", "subject3", "scene", "moodboard"];
// tabs that carry a built-in Prompt Converter, matching workspace.py
const CONVERTER_TABS = ["i2i", "subject", "scene"];
const AUTO_MODES = new Set(["subject", "scene_view", "scene_action", "scene_style",
                            "i2i", "style", "people"]);
// what Ollama is asked when the Question box is empty, matching autoprompt.py
const DEFAULT_QUESTION = "Describe this image.";
function normaliseAutoUi(value, defaultMode) {
  const a = value && typeof value === "object" ? value : {};
  a.on = !!a.on;
  a.ollama = a.ollama === undefined ? true : !!a.ollama;
  a.wd14 = a.wd14 === undefined ? true : !!a.wd14;
  a.mode = AUTO_MODES.has(a.mode) ? a.mode : defaultMode;
  a.combine = a.combine === "blend" ? "blend" : "append";
  a.length = typeof a.length === "number"
    ? Math.max(0, Math.min(300, Math.trunc(a.length))) : 0;
  a.fixed = a.fixed === undefined ? true : !!a.fixed;
  a.joy = !!a.joy;
  a.qwen = !!a.qwen;
  a.clipgen = !!a.clipgen;
  a.florence = !!a.florence;
  a.rewrite = !!a.rewrite;
  return a;
}
function normSel(name, sel, imagesLen) {
  if (name === "moodboard") {
    const list = Array.isArray(sel) ? sel : (typeof sel === "number" ? [sel] : []);
    return list.filter((i) => Number.isInteger(i) && i >= 0 && i < imagesLen);
  }
  const n = typeof sel === "number" ? sel : 0;
  return n >= 0 && n < imagesLen ? n : 0;
}
function activeGroup(t, name) {
  const g = t.groups[t.group];
  return g || t.groups[Object.keys(t.groups)[0]];
}
// The Subject gallery's other people, in pick order: valid, unique, never the main one
function normExtra(list, main, imagesLen) {
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    if (Number.isInteger(i) && i >= 0 && i < imagesLen && i !== main && !out.includes(i)) out.push(i);
  }
  return out;
}
function mirrorActive(t, name) {
  const g = activeGroup(t, name);
  t.images = g.images;
  t.sel = normSel(name, g.sel, g.images.length);
  g.sel = t.sel;
  if (name === "subject") {
    g.extra_sel = normExtra(g.extra_sel, g.sel, g.images.length);
    t.extra_sel = g.extra_sel;
  }
}

export function readCfg(node) {
  const w = findWidget(node, "config");
  let d;
  try { d = JSON.parse(w?.value || "{}"); } catch (e) { d = {}; }
  if (!d || typeof d !== "object") d = {};
  d.tabs = d.tabs && typeof d.tabs === "object" ? d.tabs : {};
  for (const name of ["i2i", "subject", "subject2", "subject3", "scene", "moodboard", "boost_mask", "edit_mask"]) {
    const t = (d.tabs[name] = d.tabs[name] && typeof d.tabs[name] === "object" ? d.tabs[name] : {});
    t.images = Array.isArray(t.images) ? t.images : [];
    if (name === "moodboard") t.sel = Array.isArray(t.sel) ? t.sel : (typeof t.sel === "number" ? [t.sel] : []);
    else t.sel = typeof t.sel === "number" ? t.sel : 0;
    if (t.on === undefined) t.on = TAB_DEFAULT_ON.has(name);
    const autoMode = name === "scene" ? "scene_view"
                   : name === "moodboard" ? "style"
                   : name === "i2i" ? "i2i" : "subject";
    t.auto = normaliseAutoUi(t.auto, autoMode);
    if (name === "subject" && (!t.people_meta || typeof t.people_meta !== "object"
                               || Array.isArray(t.people_meta))) {
      t.people_meta = {};
    }
    if (name === "boost_mask" || name === "edit_mask") {
      // the mask painter's own fields: the flattened mask FILE, and an OWN uploaded
      // source pinned by path so it survives a reload. "" means follow the gallery
      // tabs, which is what every workspace saved before this field loads as.
      if (typeof t.mask !== "string") t.mask = "";
      if (typeof t.src !== "string") t.src = "";
    }
    if (name === "i2i") {
      t.prompt_only = !!t.prompt_only;
      if (typeof t.denoise !== "number") t.denoise = 0.7;
      // RE-ANGLE, the viewpoint stage before the i2i pass (server: reangle.py)
      if (!t.reangle || typeof t.reangle !== "object") t.reangle = {};
      const R = t.reangle;
      if (typeof R.on !== "boolean") R.on = false;
      if (R.camera !== "bands" && R.camera !== "studio") R.camera = "bands";
      if (typeof R.azimuth !== "string") R.azimuth = "front-right quarter view";
      if (typeof R.elevation !== "string") R.elevation = "eye-level shot";
      if (typeof R.distance !== "string") R.distance = "medium shot";
      if (typeof R.nudge !== "boolean") R.nudge = false;
      if (typeof R.collapse !== "boolean") R.collapse = true;
      if (typeof R.extra !== "string") R.extra = "";
      if (typeof R.unet !== "string") R.unet = "";
      if (typeof R.clip !== "string") R.clip = "";
      if (typeof R.vae !== "string") R.vae = "";
      if (typeof R.lora_angles !== "string") R.lora_angles = "";
      if (typeof R.lora_light !== "string") R.lora_light = "";
      if (typeof R.lora_angles_strength !== "number") R.lora_angles_strength = 1;
      if (typeof R.lora_light_strength !== "number") R.lora_light_strength = 1;
      if (typeof R.steps !== "number") R.steps = 4;
      if (typeof R.cfg !== "number") R.cfg = 1;
      if (typeof R.sampler !== "string") R.sampler = "euler";
      if (typeof R.scheduler !== "string") R.scheduler = "simple";
      if (typeof R.shift !== "number") R.shift = 3.1;
      if (typeof R.cfg_norm !== "boolean") R.cfg_norm = true;
      if (typeof R.seed !== "number") R.seed = 0;
      if (typeof R.seed_random !== "boolean") R.seed_random = true;
      // SWAP, the character stage after re-angle, before the i2i pass (server: swap.py)
      if (!t.swap || typeof t.swap !== "object") t.swap = {};
      const S = t.swap;
      if (typeof S.on !== "boolean") S.on = false;
      if (!SW_MODES.includes(S.mode)) S.mode = "head";
      if (!SW_REFS.includes(S.reference)) S.reference = "subject";
      if (!["auto", "body_first", "face_first"].includes(S.order)) S.order = "auto";
      if (typeof S.prompt !== "string") S.prompt = "";
      if (typeof S.keep_size !== "boolean") S.keep_size = false;
      if (typeof S.unet !== "string") S.unet = "";
      if (typeof S.clip !== "string") S.clip = "";
      if (typeof S.vae !== "string") S.vae = "";
      if (typeof S.lora_swap !== "string") S.lora_swap = "";
      if (typeof S.lora_light !== "string") S.lora_light = "None";
      if (typeof S.lora_swap_strength !== "number") S.lora_swap_strength = 1;
      if (typeof S.lora_light_strength !== "number") S.lora_light_strength = 1;
      if (typeof S.steps !== "number") S.steps = 16;
      if (typeof S.cfg !== "number") S.cfg = 2;
      if (typeof S.sampler !== "string") S.sampler = "er_sde";
      if (typeof S.scheduler !== "string") S.scheduler = "beta";
      if (typeof S.shift !== "number") S.shift = 3;
      if (typeof S.cfg_norm !== "boolean") S.cfg_norm = false;
      if (typeof S.seed !== "number") S.seed = 0;
      if (typeof S.seed_random !== "boolean") S.seed_random = true;
      if (typeof t.scale !== "number") t.scale = 1;
      t.scale = Math.max(0.25, Math.min(3, t.scale));
      if (typeof t.passes !== "number") t.passes = 1;
      t.passes = Math.max(1, Math.min(PASS_MAX, Math.round(t.passes)));
      // a denoise and a scale per pass, both off by default: each list is kept
      // even while its switch is off, so switching back on returns the numbers
      // that were chosen before
      t.pass_custom = !!t.pass_custom;
      t.pass_denoise = Array.isArray(t.pass_denoise)
        ? t.pass_denoise.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [];
      t.rig_custom = !!t.rig_custom;
      t.handoff_continue = !!t.handoff_continue;
      t.pass_rig = Array.isArray(t.pass_rig) ? t.pass_rig.map((v) => String(v || "")) : [];
      t.steps_custom = !!t.steps_custom;
      t.pass_steps = Array.isArray(t.pass_steps)
        ? t.pass_steps.map((v) => Math.max(0, Math.min(200, Math.round(Number(v) || 0)))) : [];
      t.scale_custom = !!t.scale_custom;
      t.pass_scale = Array.isArray(t.pass_scale)
        ? t.pass_scale.map((v) => Math.max(0.25, Math.min(3, Number(v) || 1)))
        : [];
    }
    if (CONVERTER_TABS.includes(name)) {
      t.conv = t.conv && typeof t.conv === "object" ? t.conv : {};
      for (const [k, dv] of [["gender", "off"], ["style", "off"], ["act", "off"]]) {
        if (typeof t.conv[k] !== "string") t.conv[k] = dv;
      }
      t.conv.on = t.conv.on === undefined ? true : !!t.conv.on;   // on for older configs
      t.conv.remove_cum = !!t.conv.remove_cum;
      t.conv.shave = !!t.conv.shave;
      if (typeof t.conv.rules !== "string") t.conv.rules = "";
      if (t.conv.lock === undefined) t.conv.lock = name === "i2i";
      t.conv.lock_lighting = !!t.conv.lock_lighting;
    }
    if (GALLERY_TABS.includes(name)) {
      // migrate a flat gallery into its first collection
      if (!t.groups || typeof t.groups !== "object" || !Object.keys(t.groups).length) {
        t.groups = { all: { images: t.images, sel: t.sel } };
        if (name === "subject") t.groups.all.extra_sel = t.extra_sel;
        t.group = "all";
      }
      for (const g of Object.values(t.groups)) {
        g.images = Array.isArray(g.images) ? g.images : [];
        g.sel = normSel(name, g.sel, g.images.length);
      }
      if (!t.groups[t.group]) t.group = Object.keys(t.groups)[0];
      mirrorActive(t, name);
    }
  }
  // PEOPLE MERGED INTO SUBJECT: a workflow saved with Person 2 or 3 on their own
  // galleries gets each one's chosen picture added to the Subject gallery as the next
  // person, and the old gallery switched off (its pictures stay where they were)
  for (const nm of "subject2 subject3".split(" ")) {
    const o = d.tabs[nm];
    if (!o?.on || !o.images?.length) continue;
    const entry = o.images[typeof o.sel === "number" ? o.sel : 0];
    const S = d.tabs.subject;
    const g = activeGroup(S, "subject");
    if (!g || !entry) continue;
    let i = g.images.indexOf(entry);
    if (i < 0) { g.images.push(entry); i = g.images.length - 1; }
    g.extra_sel = normExtra([...(g.extra_sel || []), i], g.sel, g.images.length);
    o.on = false;
    mirrorActive(S, "subject");
  }
  d.dials = d.dials && typeof d.dials === "object" ? d.dials : {};
  if (![0, 1024, 1536].includes(d.resize)) d.resize = 1024;
  d.studio_preset = typeof d.studio_preset === "string" ? d.studio_preset : "";
  d.latent = d.latent && typeof d.latent === "object" ? d.latent : {};
  if (typeof d.latent.w !== "number") d.latent.w = 1024;
  if (typeof d.latent.h !== "number") d.latent.h = 1024;
  if (typeof d.latent.batch !== "number") d.latent.batch = 1;
  d.vram_tier = ["low", "medium", "high"].includes(d.vram_tier) ? d.vram_tier : "high";
  d.loras = d.loras && typeof d.loras === "object" ? d.loras : {};
  d.loras.on = d.loras.on === undefined ? true : !!d.loras.on;
  if (!Array.isArray(d.loras.slots)) d.loras.slots = [];
  if (typeof d.loras.ui !== "object" || !d.loras.ui) d.loras.ui = {};
  if (typeof d.loras.seed !== "number") d.loras.seed = 0;
  // ONE paint stack, flat, after a per-model-choice version lasted a
  // single local day: it put three LoRA controls on screen and explained itself in
  // riddles. Swapping sets is what the Stack preset row is for, and tying stacks to
  // the model choice returns WITH the Models tab, where it can actually render. A
  // config saved during that day (a "stacks" object) collapses to the stack the
  // active choice was using, or the first one with anything in it.
  d.paint_loras = d.paint_loras && typeof d.paint_loras === "object" ? d.paint_loras : {};
  if (d.paint_loras.stacks && typeof d.paint_loras.stacks === "object") {
    const P0 = (d.paint && typeof d.paint === "object") ? d.paint : {};
    const key = String(P0.renderer_name || P0.renderer_kind || P0.renderer || "");
    const s = d.paint_loras.stacks[key]
      || Object.values(d.paint_loras.stacks)
          .find((v) => Array.isArray(v?.slots) && v.slots.length)
      || {};
    d.paint_loras = { slots: s.slots, ui: s.ui, seed: s.seed };
  }
  if (!Array.isArray(d.paint_loras.slots)) d.paint_loras.slots = [];
  if (typeof d.paint_loras.ui !== "object" || !d.paint_loras.ui) d.paint_loras.ui = {};
  if (typeof d.paint_loras.seed !== "number") d.paint_loras.seed = 0;
  // the Camera tab's master switch: on unless a saved config says otherwise
  d.camera = d.camera && typeof d.camera === "object" ? d.camera : {};
  d.camera.on = d.camera.on === undefined ? true : !!d.camera.on;
  // LORA SETS: Main (d.loras) plus named sets, each a whole stack, each its
  // own tab on the LoRAs tab. Names unique, never "Main".
  if (!Array.isArray(d.lora_sets)) d.lora_sets = [];
  {
    const seen = new Set();
    d.lora_sets = d.lora_sets.filter((st) => st && typeof st === "object").map((st) => {
      const name = String(st.name || "").trim().slice(0, 48);
      return { name, slots: Array.isArray(st.slots) ? st.slots : [],
               ui: st.ui && typeof st.ui === "object" ? st.ui : {},
               seed: typeof st.seed === "number" ? Math.max(0, st.seed) : 0 };
    }).filter((st) => {
      if (!st.name || st.name === MAIN_SET || seen.has(st.name)) return false;
      seen.add(st.name);
      return true;
    });
  }
  // the Models tab: named rigs loaded inside the workspace. The active one fills
  // whatever input is not wired; a wired input always wins.
  d.models = d.models && typeof d.models === "object" ? d.models : {};
  if (!Array.isArray(d.models.rigs)) d.models.rigs = [];
  d.models.rigs = d.models.rigs.filter((r) => r && typeof r === "object");
  for (const r of d.models.rigs) {
    for (const k of ["name", "checkpoint", "unet", "clip", "clip_type", "vae"]) {
      if (typeof r[k] !== "string") r[k] = "";
    }
    if (typeof r.steps !== "number") r.steps = 8;
    if (typeof r.cfg !== "number") r.cfg = 1.0;
    // sampler dials, all off until switched on (sampler_dials.py parses them)
    if (typeof r.shift !== "number") r.shift = 0;
    for (const k of ["dd", "variance", "densify"]) {
      if (!r[k] || typeof r[k] !== "object") r[k] = {};
    }
    if (typeof r.sampler !== "string") r.sampler = "euler";
    if (typeof r.scheduler !== "string") r.scheduler = "simple";
    if (typeof r.detailer_steps !== "number") r.detailer_steps = 8;
    // the i2i pair: "" means the pair above, which is every rig saved before it
    if (typeof r.i2i_sampler !== "string") r.i2i_sampler = "";
    if (typeof r.i2i_scheduler !== "string") r.i2i_scheduler = "";
    if (r.kind !== "external" && r.kind !== "node") r.kind = "";
    if (typeof r.node !== "string") r.node = "";          // a "node" rig's rig-node name
    if (typeof r.denoise !== "number") r.denoise = 1.0;
    // the LoRAs-tab SET this rig renders with; "" = Main
    if (typeof r.lora_set !== "string") r.lora_set = "";
    delete r.lora_groups;
  }
  // an unnamed rig is "Rig N": the label a prompt row links by, and the name the
  // server matches, so a first rig and a first prompt work without renaming anything
  d.models.rigs.forEach((r, i) => { if (!r.name.trim()) r.name = "Rig " + (i + 1); });
  if (d.models.sampler_mode !== "internal") d.models.sampler_mode = "external";
  if (typeof d.models.hold_two !== "boolean") d.models.hold_two = false;
  if (typeof d.models.seed !== "number") d.models.seed = 0;
  if (typeof d.models.seed_random !== "boolean") d.models.seed_random = true;
  d.models.active = Math.max(0, Math.min(
    typeof d.models.active === "number" ? Math.round(d.models.active) : 0,
    Math.max(0, d.models.rigs.length - 1)));
  // the Prompts tab: named prompts, each linked to a rig by the rig's name
  d.prompts = d.prompts && typeof d.prompts === "object" ? d.prompts : {};
  if (!Array.isArray(d.prompts.rows)) d.prompts.rows = [];
  d.prompts.rows = d.prompts.rows.filter((x) => x && typeof x === "object");
  for (const x of d.prompts.rows) {
    for (const k of ["name", "rig", "text", "negative"]) {
      if (typeof x[k] !== "string") x[k] = "";
    }
    x.kind = x.kind === "plain" ? "plain" : "krea2";
  }
  d.paint = d.paint && typeof d.paint === "object" ? d.paint : {};
  d.paint.on = !!d.paint.on;
  if (typeof d.paint.source !== "string") d.paint.source = "";
  if (typeof d.paint.mask !== "string") d.paint.mask = "";
  if (typeof d.paint.auto_mask !== "string") d.paint.auto_mask = "";
  d.paint.keep_mask = !!d.paint.keep_mask;
  // must match workspace.py's list, or the panel offers a shape the server refuses
  if (!["auto", "square", "landscape", "portrait"].includes(d.paint.region_shape)) {
    d.paint.region_shape = "auto";
  }
  d.paint.region_floor = !!d.paint.region_floor;
  // ONE CFG/STEPS PER RENDERER, keyed by the same display name the picker already
  // shows: models genuinely disagree about what CFG and Steps mean, and switching
  // between an SDXL bridge and Krea 2 used to leave whichever number was last on the
  // dial applied to both. Sanitised here so a foreign or malformed value cannot ride
  // in on a shared or hand-edited workflow file.
  {
    const raw = d.paint.renderer_profiles;
    const clean = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.cfg === "number" && typeof v.steps === "number") {
          clean[String(k)] = { cfg: v.cfg, steps: v.steps };
        }
      }
    }
    d.paint.renderer_profiles = clean;
  }
  if (typeof d.paint.denoise !== "number") d.paint.denoise = 0.6;
  // one pass is what every workflow saved before this existed did, and it is the
  // value that changes nothing: the chain only starts at two
  d.paint.passes = Math.max(1, Math.min(PASS_MAX,
    typeof d.paint.passes === "number" ? Math.round(d.paint.passes) : 1));
  // the live frame's long edge while a paint run samples: 0 = the default 512
  if (![0, 512, 768, 1024, 1536, -1].includes(d.paint.live_px)) d.paint.live_px = 0;
  // two options: the main tab's LoRAs or this renderer's paint stack.
  // "none" existed for a day and folds into "main"; wire the raw model for bare.
  if (d.paint.lora_mode !== "main" && d.paint.lora_mode !== "paint") {
    d.paint.lora_mode = "main";
  }
  // main mode may name a LoRAs-tab set; "" = the rig's own set
  if (typeof d.paint.lora_set !== "string") d.paint.lora_set = "";
  delete d.paint.lora_groups;
  if (typeof d.paint.brush !== "number") d.paint.brush = 48;
  if (typeof d.paint.feather !== "number") d.paint.feather = 4;
  // clamped to the same range workspace.py clamps to, or a config holding an old 256
  // would show 256 on the slider while the server quietly rendered at 512
  d.paint.mask_size = Math.max(MASK_MIN, Math.min(MASK_MAX,
    typeof d.paint.mask_size === "number" ? d.paint.mask_size : 1024));
  if (typeof d.paint.prompt !== "string") d.paint.prompt = "";
  if (typeof d.paint.auto_prompt !== "string") d.paint.auto_prompt = "";
  for (const k of ["use_subject", "use_scene", "use_moodboard"]) {
    d.paint[k] = !!d.paint[k];
  }
  if (typeof d.paint.fit_whole !== "boolean") d.paint.fit_whole = true;
  if (typeof d.paint.adv_open !== "boolean") d.paint.adv_open = false;
  const uiS = parseFloat(d.ui_scale);
  d.ui_scale = Number.isFinite(uiS) ? Math.max(0.7, Math.min(4, uiS)) : 1;
  if (typeof d.paint.renderer !== "string") d.paint.renderer = "";
  d.paint.invert = !!d.paint.invert;
  d.paint.use_loras = !!d.paint.use_loras;
  // three states now; the old boolean still decides when the key is absent
  d.paint.loras_mode = ["tab", "wired", "none"].includes(d.paint.loras_mode)
    ? d.paint.loras_mode : (d.paint.use_loras ? "tab" : "wired");
  if (typeof d.paint.negative !== "string") d.paint.negative = "";
  d.paint.mask_only = d.paint.mask_only === undefined ? true : !!d.paint.mask_only;
  // A result caption describes a whole image, so Paint starts from the same mode as
  // Img2Img. Keeping one normaliser prevents the result menu and galleries accepting
  // different engine settings from the same saved workflow.
  d.paint.auto = normaliseAutoUi(d.paint.auto, "i2i");
  d.post = d.post && typeof d.post === "object" ? d.post : {};
  if (typeof d.look_thumb !== "number") d.look_thumb = 76;
  d.look_thumb = Math.max(48, Math.min(180, d.look_thumb));
  d.post_ui = d.post_ui && typeof d.post_ui === "object" ? d.post_ui : {};
  if (!["default", "0", "1", "2", "3"].includes(String(d.post_ui.precision))) {
    d.post_ui.precision = "default";
  }
  d.post_ui.hints = d.post_ui.hints === undefined ? true : !!d.post_ui.hints;
  d.post_ui.order = Array.isArray(d.post_ui.order) ? d.post_ui.order : [];
  for (const fx of POST_FX) {
    const b = d.post[fx.id] = d.post[fx.id] && typeof d.post[fx.id] === "object"
      ? d.post[fx.id] : {};
    b.on = !!b.on;
    b.rand = b.rand && typeof b.rand === "object" ? b.rand : {};
    // any effect can be limited to the subject or the background; off by default
    if (!fx.settings && !["off", "subject", "background"].includes(b.limit)) b.limit = "off";
    for (const c of fx.controls) {
      if (c.head || c.button) continue;   // a heading or a button holds no value
      if (c.choice) { if (typeof b[c.key] !== "string") b[c.key] = c.def; }
      else if (typeof b[c.key] !== "number") b[c.key] = c.def;
    }
  }
  normalisePostChain(d);                              // the chain of instances, in run order
  d.latent.on = !!d.latent.on;
  d.latent.random = !!d.latent.random;
  d.latent.source = d.latent.source === "input" ? "input" : "tab";
  if (typeof d.latent.scale !== "number") d.latent.scale = 1;
  d.latent.scale = Math.max(1, Math.min(2, d.latent.scale));
  // refine passes: one pass and the same defaults workspace.py normalises to, so the
  // bars the panel draws are the numbers the sampler will actually run
  if (typeof d.latent.passes !== "number") d.latent.passes = 1;
  d.latent.passes = Math.max(1, Math.min(PASS_MAX, Math.round(d.latent.passes)));
  if (typeof d.latent.refine !== "number") d.latent.refine = 0.45;
  d.latent.refine = Math.max(0, Math.min(1, d.latent.refine));
  d.latent.pass_custom = !!d.latent.pass_custom;
  d.latent.scale_custom = !!d.latent.scale_custom;
  d.latent.rig_custom = !!d.latent.rig_custom;
  d.latent.handoff_continue = !!d.latent.handoff_continue;
  d.latent.pass_rig = Array.isArray(d.latent.pass_rig) ? d.latent.pass_rig.map((v) => String(v || "")) : [];
  d.latent.steps_custom = !!d.latent.steps_custom;
  d.latent.pass_steps = Array.isArray(d.latent.pass_steps)
    ? d.latent.pass_steps.map((v) => Math.max(0, Math.min(200, Math.round(Number(v) || 0)))) : [];
  d.auto = d.auto && typeof d.auto === "object" ? d.auto : {};
  if (typeof d.auto.model !== "string") d.auto.model = "";
  if (typeof d.auto.url !== "string") d.auto.url = "";
  for (const [k, dv] of [["threshold", 0.35], ["character_threshold", 0.85],
                         ["temperature", 0.2], ["seed", 0], ["num_ctx", 0],
                         ["num_predict", 0], ["top_k", 0], ["top_p", 0],
                         ["keep_alive", 0]]) {
    if (typeof d.auto[k] !== "number") d.auto[k] = dv;
  }
  if (typeof d.auto.wd14_model !== "string") d.auto.wd14_model = "";
  if (typeof d.auto.exclude_tags !== "string") d.auto.exclude_tags = "";
  d.auto.replace_underscore = !!d.auto.replace_underscore;
  d.auto.think = !!d.auto.think;
  if (d.auto.wd14_unload === undefined) d.auto.wd14_unload = true;
  d.auto.low_vram = !!d.auto.low_vram;
  d.auto.frank = !!d.auto.frank;
  for (const k of ["joy_quant", "joy_style", "joy_length"]) {
    if (typeof d.auto[k] !== "string") d.auto[k] = "";
  }
  if (typeof d.auto.joy_memory !== "string") d.auto.joy_memory = "auto";
  if (typeof d.auto.florence_model !== "string") d.auto.florence_model = "";
  if (typeof d.auto.florence_task !== "string") d.auto.florence_task = "more_detailed_caption";
  if (!["off", "scrub", "rewrite"].includes(d.auto.style_lock)) d.auto.style_lock = "off";
  if (d.auto.joy_mode_prompts === undefined) d.auto.joy_mode_prompts = true;
  if (d.use_dials === undefined) d.use_dials = true;
  d.draft = !!d.draft;                               // the footer's Draft switch
  // PER GALLERY, not one number for all of them. One shared size meant the slider on
  // Img2Img resized the moodboard, and only three of the six galleries had a slider at
  // all, so the other three could only be changed from a tab they had nothing to do
  // with. The old scalar seeds every tab once, so an existing workflow opens looking
  // exactly as it did.
  d.thumbs = d.thumbs && typeof d.thumbs === "object" ? d.thumbs : {};
  for (const k of GALLERY_TABS) {
    const v = Number(d.thumbs[k] ?? d.thumb ?? THUMB);
    d.thumbs[k] = Math.max(THUMB_MIN, Math.min(THUMB_MAX, v || THUMB));
  }
  // kept normalised and mirrored from Img2Img for one release, so a workflow saved by
  // an older build still round-trips through this and back
  d.thumb = d.thumbs.i2i;
  return d;
}
// the first free "Rig N", counting from the number of rigs there will be
function nextRigName(rigs) {
  const taken = new Set((rigs || []).map((r) => r.name));
  let n = (rigs || []).length + 1;
  while (taken.has("Rig " + n)) n++;
  return "Rig " + n;
}

// what stops the Workspace rendering, in plain words, before a queue finds out.
// A wired input counts as chosen. The server says the same things when a run comes
// out empty (nothing_rendered in workspace.py).
export function setupProblems(node, cfg) {
  const out = [];
  const M = cfg?.models;
  if (!M) return out;
  const wired = (name) => (node?.inputs || []).some((s) => s?.name === name && s.link != null);
  const imageUsed = (node?.outputs || []).some((o) => o?.name === "image" && (o.links || []).length);
  if (M.sampler_mode !== "internal") {
    if (imageUsed) {
      out.push("The image output is wired, but External sampler renders nothing here. Choose "
             + "Built-in sampler, or take the picture from your own KSampler.");
    }
    return out;
  }
  const rig = M.rigs[M.active];
  if (!rig) {
    if (!wired("model")) out.push("There is no rig. Press New Rig and choose its model, CLIP and VAE.");
    return out;
  }
  if (rig.kind === "node") {
    const want = rig.node || rig.name;
    if (!customRigNodes().some((c) => c.name === want)) {
      out.push(`No RedNode Rig Model for the rig "${want}" is on the canvas.`);
    }
  } else if (rig.kind) {
    return out;                                // an engine rig loads nothing on purpose
  }
  const ckpt = !!rig.checkpoint;
  if (!rig.kind) {
    if (!ckpt && !rig.unet && !wired("model")) out.push("No diffusion model or checkpoint chosen.");
    if (!ckpt && !rig.clip && !wired("clip")) out.push("No text encoder (CLIP) chosen.");
    if (rig.clip && !rig.clip_type) {
      out.push("The CLIP type is empty, so it loads as Stable Diffusion. Set it to match the "
             + "model, krea2 for Krea 2.");
    }
    if (!ckpt && !rig.vae && !wired("vae")) out.push("No VAE chosen, so the picture cannot be decoded.");
  }
  const rows = cfg.prompts?.rows || [];
  const rigsOf = (row) => (Array.isArray(row.rigs) ? row.rigs : (row.rig ? [row.rig] : []));
  // a row an auto prompt feeds has words by queue time, even with its box empty
  const fed = new Set();
  for (const name of ["subject", "scene", "moodboard", "i2i"]) {
    const t = cfg.tabs?.[name];
    if (t?.on && t.auto?.on && t.auto.inject_row) fed.add(t.auto.inject_row);
  }
  const hasText = (row) => String(row.text || "").trim()
    || fed.has(row.name || `Prompt ${rows.indexOf(row) + 1}`);
  const serves = rows.some((row) => hasText(row) && (rigsOf(row).includes(rig.name) || !rigsOf(row).length));
  if (!serves) {
    out.push(rows.some(hasText)
      ? `No prompt serves ${rig.name}: every prompt with words is linked to another rig.`
      : "No prompt yet. Write one on the Prompts tab.");
  }
  return out;
}

export function writeCfg(node) {
  const w = findWidget(node, "config");
  if (w) w.value = JSON.stringify(node._rnCfg);
  node.graph?.change?.();
}

// ---- files -----------------------------------------------------------------
// gallery entries are "name.png" or "sub/name.png", optionally with " [input]" behind
function parseName(entry) {
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(entry));
  const full = (m?.[1] || "").trim();
  const slash = full.lastIndexOf("/");
  return {
    filename: slash < 0 ? full : full.slice(slash + 1),
    subfolder: slash < 0 ? "" : full.slice(0, slash),
    type: m?.[2] || "input",
  };
}
const viewUrl = (entry) => {
  const p = parseName(entry);
  return api.apiURL(`/view?filename=${encodeURIComponent(p.filename)}` +
                    `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}` +
                    `&rand=${node_rand(entry)}`);
};
// The gallery cells' version, resized SERVER side. A browser decodes an image at its
// natural size however small it is drawn, so a row of thumbnails pointed at full
// originals holds a bitmap each. Panes and the paint canvas keep using viewUrl: those
// are looked at, and the mask work needs the real pixels.
const thumbUrl = (entry, px = 320) => {
  const p = parseName(entry);
  return api.apiURL(`/rednode/thumb?filename=${encodeURIComponent(p.filename)}` +
                    `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}` +
                    `&px=${px}&rand=${node_rand(entry)}`);
};
// cache-buster keyed per entry, bumped when a mask is repainted over it
const _rands = new Map();
const node_rand = (entry) => _rands.get(entry) || 0;
const bumpRand = (entry) => _rands.set(entry, (Math.random() * 1e9) | 0);

// Everything the panel stores is normalised on the way in: a PNG, no bigger than
// this. A 4000px webp helps nobody here, and it hurts twice over, because a vision
// model then has to chew through the whole thing and the file sits on the drive at
// full size for the rest of its life. 2048 leaves headroom above the 1536 resize
// setting while killing the pathological cases.
const STORE_MAX_EDGE = 2048;

async function normalisedUpload(file) {
  // returns a PNG Blob at STORE_MAX_EDGE or smaller, and the name to store it under
  const stem = String(file.name || "image").replace(/[.][^.]+$/, "") || "image";
  try {
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height);
    const scale = long > STORE_MAX_EDGE ? STORE_MAX_EDGE / long : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("the canvas produced nothing");
    if (scale < 1) {
      console.log(`[RedNode Workspace] stored ${stem} at ${w}x${h} instead of `
                + `${bmp.width}x${bmp.height}`);
    }
    return { blob, name: `${stem}.png` };
  } catch (e) {
    // an exotic format the browser cannot decode: keep the original rather than
    // refusing the upload
    console.warn("[RedNode Workspace] could not re-encode on upload, storing as-is:", e);
    return { blob: file, name: file.name || "image.png" };
  }
}

async function uploadFiles(node, tabName, files) {
  const cfg = node._rnCfg;
  for (const file of files) {
    if (!file.type?.startsWith("image/")) continue;
    const { blob, name } = await normalisedUpload(file);
    const body = new FormData();
    body.append("image", blob, name);
    body.append("type", "input");
    // uploads land in an organized per-tab folder instead of the input root, so caption
    // sidecars can live next to their image and the root stays clean
    body.append("subfolder", `rednode/${tabName}`);
    try {
      const res = await api.fetchApi("/upload/image", { method: "POST", body });
      const d = await res.json();
      if (!d.name) throw new Error("upload returned no name");
      const entry = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
      const t = cfg.tabs[tabName];
      if (!t.images.includes(entry)) {
        t.images.push(entry);                                // t.images IS the active collection
        // a first moodboard upload joins the batch by itself; an empty batch outputs
        // nothing, and "I added images" reading as "it works" hides that
        if (tabName === "moodboard" && Array.isArray(t.sel) && !t.sel.length) {
          t.sel.push(t.images.length - 1);
          activeGroup(t, tabName).sel = t.sel;
        }
      }
    } catch (e) {
      console.error("[RedNode Workspace] upload failed:", e);
    }
  }
  writeCfg(node);
  render(node);
}

// ComfyUI's own mask editor USED TO BE REACHED FROM HERE. The Masks tab paints in
// place now, so the clipspace round trip is gone entirely, and with it the class of
// bug that only that round trip could have: the injected canvas-preview widget that
// squashed the panel, the temporary `image` widget, and the live paste callback left
// behind by closing the editor without saving. Nothing replaced it because nothing
// needs to: maskPainter draws the same masks without leaving the node.

// ---- gallery right-click ---------------------------------------------------
const SEND_TARGETS = [
  ["i2i", "Img2Img"],
  ["moodboard", "Moodboard"],
  ["subject", "Subject (main)"],
  ["subject_person", "Subject (add a person)"],
  ["scene", "Scene"],
];

async function copyGalleryImage(entry) {
  const blob = await (await fetch(viewUrl(entry))).blob();
  // the clipboard wants PNG; transcode through a canvas when the source is not
  if (blob.type === "image/png" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return;
  }
  const img = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function sendToTab(node, target, entry) {
  if (target === "subject_person") {
    const S = node._rnCfg.tabs.subject;
    let i = S.images.indexOf(entry);
    if (i < 0) { S.images.push(entry); i = S.images.length - 1; }
    if (!S.images.length || (S.images.length === 1 && i === 0)) S.sel = 0;
    else if (i !== S.sel && !(S.extra_sel || []).includes(i)) S.extra_sel = [...(S.extra_sel || []), i];
    const g = activeGroup(S, "subject");
    g.sel = S.sel;
    g.extra_sel = S.extra_sel;
    writeCfg(node); render(node);
    return;
  }
  const t = node._rnCfg.tabs[target];
  const multi = target === "moodboard";
  let idx = t.images.indexOf(entry);
  if (idx < 0) { t.images.push(entry); idx = t.images.length - 1; }
  if (multi) { if (!t.sel.includes(idx)) t.sel = [...t.sel, idx]; }
  else t.sel = idx;
  activeGroup(t, target).sel = t.sel;               // the collection owns the selection
  writeCfg(node); render(node);
}

/** The Sizes menu: one dial per REGION of the paint tab, behind one button, because
 *  three sliders on the header row would be the clutter the header just lost. Top bar,
 *  right side, and in the big room the left rail. Every key is stripped by the server
 *  before the cache hash, so moving a dial can never re-render the paint branch.
 *  Release-applies, the same lesson every scale slider here has already paid for. */
function openSizesMenu(node, anchor, fs) {
  document.querySelector(".rn-ws-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-menu";
  for (const t of ["pointerdown", "click", "contextmenu", "wheel"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const P = node._rnCfg.paint;
  const rowFor = (label, key) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;gap:8px";
    const lab = document.createElement("span");
    lab.style.cssText = "flex:none;width:70px;font-size:12px;opacity:.7";
    lab.textContent = label;
    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = 0.7; rng.max = 2.5; rng.step = 0.05;
    rng.value = parseFloat(P[key]) || 1;
    rng.style.cssText = "flex:1;min-width:130px;accent-color:#b8283c";
    const val = document.createElement("span");
    val.style.cssText = "flex:none;min-width:40px;text-align:right;font-size:12px";
    val.textContent = `${Math.round((parseFloat(P[key]) || 1) * 100)}%`;
    rng.addEventListener("input", () => {
      val.textContent = `${Math.round(parseFloat(rng.value) * 100)}%`;
    });
    rng.addEventListener("change", () => {
      P[key] = Math.round(parseFloat(rng.value) * 20) / 20;
      writeCfg(node);
      render(node);            // the menu stays open; the panel re-fits behind it
    });
    r.append(lab, rng, val);
    return r;
  };
  const h = document.createElement("h5");
  h.textContent = "Paint tab sizes";
  m.appendChild(h);
  m.appendChild(rowFor("Top bar", "scale_top"));
  m.appendChild(rowFor("Right side", "scale"));
  if (fs) m.appendChild(rowFor("Left rail", "scale_rail"));
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = fs
    ? "Applies when you let go. The pictures never scale; they own their space."
    : "Applies when you let go. The left rail dial appears in full screen.";
  m.appendChild(note);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect?.() || { left: 0, bottom: 0 };
  m.style.left = Math.max(6, Math.min(r.left, (window.innerWidth || 1920) - 300)) + "px";
  m.style.top = (r.bottom + 4) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

/** The Workspace, over the whole window.
 *
 *  Not a second implementation: render() draws into node._rnRootEl, so pointing that
 *  at an overlay host makes every existing render, every handler's re-render, and
 *  every finished run land in the big room, and closing points it home and renders
 *  once. One panel, two rooms, zero forked code, which is the only version of full
 *  screen that stays maintainable. The node's own element keeps its size; ComfyUI
 *  keeps writing to it; nothing on the canvas moves.
 */
function openFullscreen(node) {
  if (node._rnFsPrev) return;                       // already open
  const ov = document.createElement("div");
  ov.className = "rn-ws-fsov";
  for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu",
                   "dblclick"]) {
    ov.addEventListener(t, (e) => e.stopPropagation());
  }
  const bar = document.createElement("div");
  bar.className = "rn-ws-fsbar";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = "RedNode Workspace";
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "Esc closes. Everything here is the node itself, not a copy.";
  const x = document.createElement("button");
  x.className = "rn-ws-fsx";
  x.textContent = "Close  (Esc)";
  bar.append(ttl, hint, x);
  const fshost = document.createElement("div");
  fshost.className = "rn-ws-fshost";
  ov.append(bar, fshost);
  document.body.appendChild(ov);
  // THE ROOM SCALES ITSELF FROM THE SCREEN. The same CSS pixels read small on an
  // ultrawide and right on 1080p, so the big room measures the window and zooms its
  // content to hold the design's proportions: 1600 wide is the reference, an
  // ultrawide grows towards 1.8x, nothing ever shrinks below 1x, and your UI
  // slider still multiplies on top for taste. Zoom on fshost is the safe shape, a
  // flex item with nothing after it.
  const fit = () => {
    const z = Math.max(1, Math.min(1.45, (window.innerWidth || 1750) / 1750));
    fshost.style.zoom = Math.abs(z - 1) < 0.01 ? "" : String(z);
  };
  // the room and the node share one philosophy now: measure, fit, stop asking
  fit();
  window.addEventListener?.("resize", fit);

  node._rnFsPrev = node._rnRootEl;
  node._rnRootEl = fshost;
  const close = () => {
    if (!node._rnFsPrev) return;
    node._rnRootEl = node._rnFsPrev;
    node._rnFsPrev = null;
    ov.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener?.("resize", fit);
    render(node);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  x.onclick = close;
  document.addEventListener("keydown", onKey, true);
  node._rnFsClose = close;
  render(node);
}

/** Copy a result into the input tree and return its durable entry, or null.
 *
 *  A result is usually a TEMP preview, and ComfyUI wipes temp on every restart: a
 *  paint source holding a temp address dies with the session, reported from the
 *  field as "the image is not in the input folder any more" the run after a
 *  restart. The copy gets the same home dropped files get. */
async function copyResultToInput(r) {
  try {
    const res = await fetch(resultUrl(r));
    if (!res.ok) return null;
    const blob = await res.blob();
    const body = new FormData();
    body.append("image", blob, `paint_src_${Date.now()}.png`);
    body.append("type", "input");
    body.append("subfolder", "rednode/paint");
    const up = await api.fetchApi("/upload/image", { method: "POST", body });
    const d = await up.json();
    if (!d.name) return null;
    return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
  } catch (e) {
    return null;
  }
}

/** The durable upgrade, after the fact: same picture, new address, so the strokes
 *  key follows it and nothing painted meanwhile is lost. Skipped silently if the
 * user already moved to another picture while the copy was in flight. */
function upgradeSourceDurability(node, r) {
  const wanted = resultEntry(r);
  (async () => {
    const up = await copyResultToInput(r);
    if (!up) return;                       // temp already gone, or upload refused
    const P = node._rnCfg?.paint;
    if (!P || P.source !== wanted) return; // they moved on, nothing to upgrade
    P.source = up;
    if (node._rnStrokesFor === wanted) node._rnStrokesFor = up;
    // The durable address names the same pixels. Carry the decoded image across the
    // rename so the background upload cannot introduce an empty-canvas frame.
    if (node._rnPaintImageCache?.source === wanted) {
      node._rnPaintImageCache.source = up;
    }
    writeCfg(node);
    render(node);
  })();
}

/** Make this result the paint source. One place, because three doors lead here:
 *  the drop, the menu, and the strip-then-menu path. Adoption is instant with the
 *  result's own address, then upgraded in the background to a durable copy. */
/** Upload the mask so an ordinary queue uses what is on screen. Debounced.
 *
 *  P.mask feeds the SAME edit_mask and output_latent sockets the rest of the node
 *  drives, so it is what an ordinary queue paints through. Saving it was a button, and
 *  being a button is why it felt broken: paint, then queue normally without pressing
 *  it, and the run silently used the PREVIOUS mask. Its own tooltip warned about that,
 * which is a tell that the job was never your to remember.
 *
 *  Debounced because a stroke is many segments and a gesture is many strokes: without
 *  it a minute of painting is a minute of uploads. The delay is longer than the gap
 *  between strokes in one gesture and shorter than the gap before reaching for Queue.
 */
async function saveMaskNow(node) {
  const P = node._rnCfg?.paint;
  const canvas = node._rnMaskCanvas;
  if (!P || !canvas || !P.source) return;
  node._rnMaskDirty = false;
  try {
    const name = await uploadMask(node, maskCanvas(canvas, P.feather));
    // through the LIVE config: a render between the request and the upload finishing
    // can replace it, and writing to the old object saves nothing anybody reads
    const live = node._rnCfg?.paint || P;
    live.mask = name;
    writeCfg(node);
    // NO render() here. Rebuilding the panel is what made the canvas flash while
    // painting: the picture, the mask and the hatch are all torn down and drawn again
    // for a note that says two words. The note catches up on the next natural redraw.
    if (node._rnMaskNote) node._rnMaskNote.textContent = "Mask saved";
    node._rnSyncShapeNote?.();     // the brush is down: what would Automatic pick now
  } catch (e) {
    node._rnMaskDirty = true;               // still owed, so the next chance retries
    console.error("[RedNode Workspace] could not save the paint mask:", e);
  }
  // The colour sheet saves at the same moments, into its own file. The canvas
  // already holds base coat plus strokes, so it uploads as-is (RGBA, transparent
  // where unpainted); the server composites it over the source at load time.
  if (node._rnColourDirty && node._rnColourCanvas) {
    node._rnColourDirty = false;
    try {
      const cname = await uploadMask(node, node._rnColourCanvas);
      const live2 = node._rnCfg?.paint || P;
      live2.colour = cname;
      writeCfg(node);
      if (node._rnMaskNote) node._rnMaskNote.textContent = "Paint saved";
    } catch (e) {
      node._rnColourDirty = true;
      console.error("[RedNode Workspace] could not save the colour paint:", e);
    }
  }
}

/** Mark the mask as needing a save. It happens when the brush is put down, not during.
 *
 *  The first version uploaded on a timer after every stroke, which flashed the canvas
 *  mid-painting and did work nobody had asked for yet. The only moments the mask has to
 *  be current are when a run is about to read it, and when you have stopped painting:
 *  so it saves when the pointer LEAVES the canvas, and again immediately before
 *  Generate. Painting itself stays silent.
 */
function markMaskDirty(node) {
  node._rnMaskDirty = true;
  if (node._rnMaskNote) node._rnMaskNote.textContent = "Unsaved paint";
}

/** Put a result on the pane and the strip. The ONE way anything gets there.
 *
 *  Every call is something that was asked for: this tab's own Generate finishing, or
 *  Use last result being pressed. An ordinary workflow queue never calls it, which is
 *  the whole point: the Paint tab stopped announcing runs that were nothing to do
 *  with it and redrawing itself underneath the brush while you worked.
 */
function showResult(r, autoNode = null) {
  if (!r) return;
  shownResult = { ...r };
  // the strip keeps the last five, newest first, without repeats of the same file
  if (resultHistory[0]?.filename !== r.filename
      || resultHistory[0]?.subfolder !== r.subfolder) {
    resultHistory.unshift({ ...r });
    resultHistory = resultHistory.slice(0, 5);
  }
  // allNodes walks subgraphs, so a Workspace tidied into one still hears it
  for (const n of allNodes()) {
    if (n.type === NODE_NAME) n._rnResultView = null;   // a new result wins the pane
    if (n.type === NODE_NAME && n._rnTab === "paint") render(n);
  }
  if (autoNode) schedulePaintAutoPrompt(autoNode, r);
}

function adoptResult(node, r, why = "unknown") {
  const P = node._rnCfg?.paint;
  if (!P || !r) return;
  // SAYS WHO CHANGED THE PICTURE, every time. Reported as results still landing on the
  // canvas by themselves, and every call site here is a deliberate press, so either
  // something else writes the source or one of these is firing when it should not.
  // Guessing between those two cost a round trip; one line settles it.
  console.log(`[RedNode Workspace] paint source <- ${resultEntry(r)} (${why}; `
            + `run ${r.prompt_id || "none"})`);
  P.source = resultEntry(r);
  node._rnStrokes = [];
  writeCfg(node);
  render(node);
  upgradeSourceDurability(node, r);
}

/** File a result through the same keeper path used by the result-pane menu.
 *
 *  If the queue already filed this prompt, promote that file. Otherwise the result
 *  is a TEMP preview and the server copies it into the organised keepers tree. */
async function saveResultAsKeeper(r) {
  const q = new URLSearchParams({ prompt_id: r.prompt_id || "", index: "0" });
  const res = await api.fetchApi(`/rednode/saved_for?${q}`);
  const found = await res.json();
  if (found?.found) {
    const pr = await api.fetchApi("/rednode/promote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: found.path, keep: true }),
    });
    const d = await pr.json();
    if (d.error) throw new Error(d.error);
    console.log(`[RedNode Workspace] kept: ${found.path}`);
    return d;
  }

  const fr = await api.fetchApi("/rednode/keep_result", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: r.filename, subfolder: r.subfolder || "",
                           type: r.type || "temp", prompt_id: r.prompt_id || "" }),
  });
  const fd = await fr.json();
  if (fd.error) throw new Error(fd.error);
  console.log(`[RedNode Workspace] kept: ${fd.rel}`);
  return fd;
}

function settlePaintFinal(node, message, failed = false) {
  if (!node) return;
  node._rnFinalBusy = false;
  node._rnFinalStatus = message;
  node._rnFinalFailed = failed;
  render(node);
}

function notifySavePending(id, state, message = "") {
  if (!id) return;
  api.dispatchEvent?.(new CustomEvent("rednode.save_pending", {
    detail: { id, state, message },
  }));
}

/** Queue one isolated finalisation pass.
 *
 *  The current result is first made durable in input, then a three-node prompt runs:
 *  Load Image -> RedNode Post FX -> Preview Image. The Preview's executed event is
 *  intercepted below and filed through saveResultAsKeeper. It never becomes
 *  lastResult, so finishing a picture cannot silently bake Post into the next paint
 *  pass. */
async function queuePostProcessedKeeper(node, r, saveNoticeId) {
  const input = await copyResultToInput(r);
  if (!input) throw new Error("the result could not be copied into ComfyUI input");

  const nonce = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const loadId = `rn_final_load_${nonce}`;
  const postId = `rn_final_post_${nonce}`;
  const previewId = `rn_final_preview_${nonce}`;
  const prompt = {
    [loadId]: {
      class_type: "LoadImage",
      inputs: { image: input },
    },
    [postId]: {
      class_type: "RedNodePostFX",
      inputs: {
        image: [loadId, 0],
        config: JSON.stringify({ post: node._rnCfg?.post || {} }),
      },
    },
    [previewId]: {
      class_type: "PreviewImage",
      inputs: { images: [postId, 0] },
    },
  };

  const pending = { node, previewId, promptId: "", saveNoticeId };
  pendingPaintFinals.set(previewId, pending);
  const res = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: api.clientId ?? api.socket?.clientId }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) {
    pendingPaintFinals.delete(previewId);
    throw new Error(d.error?.message || d.error || `queue refused the final (${res.status})`);
  }
  pending.promptId = String(d.prompt_id || "");
  node._rnFinalStatus = "Post processing queued…";
  render(node);
}

async function runPaintFinal(node, r, withPost) {
  if (!node || !r || node._rnFinalBusy) return;
  const saveNoticeId = withPost
    ? `paint_final_${Date.now()}_${Math.floor(Math.random() * 1000000)}`
    : "";
  node._rnFinalBusy = true;
  node._rnFinalFailed = false;
  node._rnFinalStatus = withPost ? "Preparing Post + Save…" : "Saving painted result…";
  render(node);
  if (withPost) {
    notifySavePending(saveNoticeId, "start", "Post-processing painted result…");
  }
  try {
    if (withPost) {
      await queuePostProcessedKeeper(node, r, saveNoticeId);
      return; // the executed event completes the save and clears busy
    }
    await saveResultAsKeeper(r);
    settlePaintFinal(node, "Saved without Post");
  } catch (e) {
    if (withPost) notifySavePending(saveNoticeId, "error", e.message);
    settlePaintFinal(node, `Save failed: ${e.message}`, true);
    throw e;
  }
}

/** Run one image through the standalone caption route. Gallery thumbnails and Paint
 *  results share this path so the server's 409 and the panel's busy state cannot drift. */
async function runStandaloneAutoPrompt(node, tabName, entry, { keepTab = false } = {}) {
  if (node._rnAutoBusy && !keepTab) {
    throw new Error("An auto prompt is already running.");
  }
  if (!keepTab) node._rnAutoBusy = tabName;
  render(node);
  try {
    const cfgW = findWidget(node, "config");
    const res = await api.fetchApi("/rednode/autoprompt_run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tab: tabName, entry, config: cfgW?.value ?? "{}" }),
    });
    const d = await res.json();
    if (res.status === 409 || res.ok === false || d.error) {
      throw new Error(d.error || (res.status === 409
        ? "An auto prompt is already running."
        : `Auto prompt request failed (${res.status}).`));
    }
    const prompt = d.prompt || "";
    if (!keepTab) (node._rnPrompts ||= {})[tabName] = prompt;
    if (d.skipped?.length) {
      console.log("[RedNode Workspace] standalone auto prompt skipped:",
                  d.skipped.join("; "));
    }
    return prompt;
  } finally {
    if (!keepTab) {
      node._rnAutoBusy = null;
      render(node);
    }
  }
}

/** Caption the newest visible Paint result without replacing either prompt source.
 *
 *  The generated text has its own config key so OFF can remove only that layer, and
 *  an empty Paint box can still combine with main conditioning whose source text is
 *  not available to the browser. Newer results replace pending older ones rather than
 *  stacking captions from several passes into one prompt. */
function schedulePaintAutoPrompt(node, r) {
  const P = node?._rnCfg?.paint;
  if (!node || !r || !P?.auto?.on) return;
  node._rnPaintAutoPending = { ...r };
  if (node._rnPaintAutoCombining) return;
  if (node._rnAutoBusy) {
    if (node._rnPaintAutoWaiting) return;
    node._rnPaintAutoWaiting = true;
    setTimeout(() => {
      node._rnPaintAutoWaiting = false;
      const next = node._rnPaintAutoPending;
      node._rnPaintAutoPending = null;
      if (next) schedulePaintAutoPrompt(node, next);
    }, 250);
    return;
  }

  const current = node._rnPaintAutoPending;
  node._rnPaintAutoPending = null;
  node._rnPaintAutoCombining = true;
  (async () => {
    try {
      const prompt = await runStandaloneAutoPrompt(
        node, "paint", resultEntry(current));
      // A newer result arrived while this caption was running. Let that one win
      // without briefly applying words that describe the previous picture.
      if (node._rnPaintAutoPending) return;
      const live = node._rnCfg?.paint;
      if (!live?.auto?.on) return;
      live.auto_prompt = prompt;
      if (node._rnAutoErrors) delete node._rnAutoErrors.paint;
      writeCfg(node);
      render(node);
    } catch (e) {
      console.error("[RedNode Workspace] automatic Paint prompt failed:", e);
      (node._rnAutoErrors ||= {}).paint = e.message;
      render(node);
    } finally {
      node._rnPaintAutoCombining = false;
      const next = node._rnPaintAutoPending;
      node._rnPaintAutoPending = null;
      if (next) schedulePaintAutoPrompt(node, next);
    }
  })();
}

async function autoPromptPaintResult(node, r) {
  const starting = node._rnCfg?.paint;
  if (!starting) return;
  let beforePrompt = String(starting.prompt || "");
  let beforeAuto = String(starting.auto_prompt || "");
  if ((beforePrompt || beforeAuto) && typeof globalThis.confirm === "function"
      && !globalThis.confirm("Auto prompt result will replace the current Paint "
                           + "prompt combination. Continue?")) {
    return;
  }
  const prompt = await runStandaloneAutoPrompt(node, "paint", resultEntry(r));
  const live = node._rnCfg?.paint;
  if (!live) return;
  const currentPrompt = String(live.prompt || "");
  const currentAuto = String(live.auto_prompt || "");
  // Captioning can take long enough for you to keep typing. A second notice
  // protects text written after the first confirmation from a late response.
  if (currentPrompt !== beforePrompt || currentAuto !== beforeAuto) {
    if (typeof globalThis.confirm === "function"
        && !globalThis.confirm("The Paint prompt changed while the auto prompt was "
                             + "running. Replace the newer combination?")) {
      return;
    }
    beforePrompt = currentPrompt;
    beforeAuto = currentAuto;
  }
  live.prompt = prompt;
  live.auto_prompt = "";
  node._rnPaintPromptUndo = {
    beforePrompt, beforeAuto, afterPrompt: prompt, afterAuto: "",
  };
  writeCfg(node);
  render(node);
}

function undoPaintAutoPrompt(node) {
  const undo = node._rnPaintPromptUndo;
  const live = node._rnCfg?.paint;
  if (!undo || !live) return;
  if (String(live.prompt || "") !== undo.afterPrompt
      || String(live.auto_prompt || "") !== undo.afterAuto) {
    alert("The Paint prompt changed after auto prompt. Undo did not replace your "
        + "newer combination.");
    return;
  }
  live.prompt = undo.beforePrompt;
  live.auto_prompt = undo.beforeAuto;
  node._rnPaintPromptUndo = null;
  writeCfg(node);
  render(node);
}

/** Right-click on the result pane: what to DO with the picture being shown. The old
 *  behaviour, click adopts it for painting, spent the whole surface on one action;
 *  a menu holds as many as the pane earns, and drag-to-paint keeps the fast path. */
function openResultMenu(node, r, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector(".rn-ws-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = r.filename;
  const mk = (label, fn, disabled = false, title = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = disabled;
    b.title = title;
    b.onclick = async () => {
      if (b.disabled) return;
      m.remove();
      try {
        await fn();
      } catch (e) {
        console.error(`[RedNode Workspace] ${label} failed:`, e);
        alert(`${label} failed: ${e.message}`);
      }
    };
    return b;
  };
  const sep1 = document.createElement("div");
  sep1.className = "sep";
  const sep2 = document.createElement("div");
  sep2.className = "sep";
  const autoBusy = !!node._rnAutoBusy;
  const canUndo = !!node._rnPaintPromptUndo;
  m.append(
    note,
    mk("Paint on this image", () => adoptResult(node, r, "right-click menu")),
    mk("Open full size", () => { window.open(resultUrl(r), "_blank"); }),
    sep1,
    mk("Auto prompt result", () => autoPromptPaintResult(node, r), autoBusy,
       autoBusy ? "Another auto prompt is already running." : ""),
    mk("Undo auto prompt", () => undoPaintAutoPrompt(node), !canUndo,
       canUndo ? "Restore the Positive prompt that Auto prompt result replaced."
               : "No Paint auto prompt to undo in this session."),
    sep2,
    mk("Save without Post", () => runPaintFinal(node, r, false)),
    mk("Post-process + Save", () => runPaintFinal(node, r, true)),
  );
  document.body.appendChild(m);
  const mw = 230, mh = m.getBoundingClientRect().height || 180;
  m.style.left = Math.max(6, Math.min(ev.clientX || 0,
    (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY || 0,
    (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

function openGalleryMenu(node, tabName, entry, ev) {
  document.querySelector(".rn-ws-menu")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) m.addEventListener(t, (e) => e.stopPropagation());
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = entry;
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      m.remove();
      try {
        await fn();
      } catch (e) {
        console.error(`[RedNode Workspace] ${label} failed:`, e);
        alert(`${label} failed: ${e.message}`);
      }
    };
    return b;
  };
  const sep = document.createElement("div");
  sep.className = "sep";
  m.append(
    note,
    mk("Copy image", () => copyGalleryImage(entry)),
    mk("Open full size", () => { window.open(viewUrl(entry), "_blank"); }),
    sep,
  );
  if (tabName === "subject") {
    const S = node._rnCfg.tabs.subject;
    const idx = S.images.indexOf(entry);
    if (idx >= 0 && idx !== S.sel) {
      m.append(mk("Make this the main subject", () => {
        const order = [S.sel, ...(S.extra_sel || [])];
        const at = order.indexOf(idx);
        const next = at >= 0 ? order.slice() : [...order, idx];
        const pos = next.indexOf(idx);
        [next[0], next[pos]] = [next[pos], next[0]];
        S.sel = next[0];
        S.extra_sel = next.slice(1);
        const g = activeGroup(S, "subject");
        g.sel = S.sel;
        g.extra_sel = S.extra_sel;
        writeCfg(node); render(node);
      }));
    }
  }
  for (const [target, label] of SEND_TARGETS) {
    if (target === tabName) continue;
    const dup = node._rnCfg.tabs[target === "subject_person" ? "subject" : target]
      ?.images.includes(entry);
    m.append(mk(`Send to ${label}` + (dup ? " (already there)" : ""),
                () => sendToTab(node, target, entry)));
  }
  // the standalone auto prompt: bake this image's caption right now, no queue.
  // Same cache keys as a real run, so the next queue's REUSE hits instantly.
  if (["subject", "scene", "moodboard", "i2i"].includes(tabName)) {
    const sep2 = document.createElement("div");
    sep2.className = "sep";
    const busy = !!node._rnAutoBusy;
    m.append(sep2, mk(busy ? "An auto prompt is already running" : "Generate auto prompt now",
                      async () => {
      if (node._rnAutoBusy) return;
      await runStandaloneAutoPrompt(node, tabName, entry);
    }));
  }
  document.body.appendChild(m);
  const mw = 230, mh = m.getBoundingClientRect().height || 250;
  m.style.left = Math.max(6, Math.min(ev.clientX || 0, (window.innerWidth || 1920) - mw - 6)) + "px";
  m.style.top = Math.max(6, Math.min(ev.clientY || 0, (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- tab bodies ------------------------------------------------------------
// This gallery's thumbnail size, with the old shared number as the fallback so a
// config written before the split still opens at the size it was left at.
function thumbOf(cfg, tabName) {
  const v = Number(cfg.thumbs?.[tabName] ?? cfg.thumb ?? THUMB);
  return Math.max(THUMB_MIN, Math.min(THUMB_MAX, v || THUMB));
}

function galleryBody(node, body, tabName, meta, { multi = false, layout = "" } = {}) {
  const cfg = node._rnCfg;
  const t = cfg.tabs[tabName];
  // "tabs": the Img2Img Source sub-tab. The on switch lives on the status bar, and
  // the canvas, collection and thumb size share one toolbar over the grid.
  const tabsLayout = layout === "tabs";
  const thumbHolder = document.createElement("span");
  thumbHolder.style.marginLeft = "auto";

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (t.on ? " on" : "");
  on.title = t.on ? "This tab feeds the studio. Click to disable it."
                  : "Disabled: this tab outputs nothing.";
  on.onclick = () => { t.on = !t.on; writeCfg(node); render(node); };
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = meta.hint || "";
  row.append(on, hint);
  if (!tabsLayout) body.appendChild(row);

  // EVERY gallery gets one, and each remembers its own size. It used to appear on
  // Img2Img, Subject and Subject 2 only, so Scene, Moodboard and Subject 3 had no
  // control at all, and the number behind it was shared, so moving it on one tab
  // resized the others. A control that exists on some tabs and not others is two
  // interfaces to learn.
  let grid = null;                       // filled in below, closed over by the slider
  {
    const th = document.createElement("span");
    th.className = "rn-ws-thumbs";
    const tl = document.createElement("span");
    tl.className = "t";
    tl.textContent = "Thumbs";
    const tr = document.createElement("input");
    tr.type = "range";
    tr.min = THUMB_MIN; tr.max = THUMB_MAX; tr.step = THUMB_STEP;
    tr.value = thumbOf(cfg, tabName);
    tr.title = `Thumbnail size for this gallery. ${meta.label || tabName} remembers `
             + "its own, so the galleries you scan and the ones you pick from can be "
             + "different sizes.";
    tr.addEventListener("input", () => {
      cfg.thumbs[tabName] = parseInt(tr.value, 10);
      if (tabName === "i2i") cfg.thumb = cfg.thumbs.i2i;    // the legacy mirror
      writeCfg(node);
      // THIS gallery's cells, not every cell in the panel. The People page used to draw three
      // galleries at once, so a panel-wide sweep would drag Subject 3's thumbnails
      // along with Subject 2's slider.
      const scope = grid || node._rnRootEl;
      for (const cell of scope.querySelectorAll(".rn-ws-cell, .rn-ws-add")) {
        cell.style.width = cell.style.height = cfg.thumbs[tabName] + "px";
      }
    });
    th.append(tl, tr);
    (tabsLayout ? thumbHolder : row).appendChild(th);
  }

  // collections: subfolders for the gallery, one active at a time
  const coll = document.createElement("div");
  coll.className = "rn-ws-coll";
  const sel2 = document.createElement("select");
  for (const gname of Object.keys(t.groups)) {
    const o = document.createElement("option");
    o.value = gname;
    o.textContent = `${gname} (${t.groups[gname].images.length})`;
    o.selected = gname === t.group;
    sel2.appendChild(o);
  }
  sel2.title = "Collections: separate sets of images inside this gallery.";
  sel2.onchange = () => {
    t.group = sel2.value;
    mirrorActive(t, tabName);
    writeCfg(node); render(node);
  };
  const namePrompt = (title, initial, done) => {
    document.querySelector(".rn-ws-panel")?.remove();
    const m = document.createElement("div");
    m.className = "rn-ws-panel";
    for (const ev of ["pointerdown", "click", "keydown", "contextmenu"]) {
      m.addEventListener(ev, (e) => e.stopPropagation());
    }
    const h = document.createElement("h5");
    h.textContent = title;
    const inp = document.createElement("input");
    inp.value = initial || "";
    inp.placeholder = "Collection name";
    const ok = document.createElement("button");
    ok.textContent = "OK";
    const go = () => { const v = inp.value.trim(); if (v) done(v); m.remove(); };
    ok.onclick = go;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") m.remove(); });
    m.append(h, inp, ok);
    document.body.appendChild(m);
    const r = sel2.getBoundingClientRect();
    const mh = m.getBoundingClientRect().height || 130;
    m.style.left = Math.max(6, r.left) + "px";
    m.style.top = Math.max(6, r.top - mh - 6) + "px";
    inp.focus();
    const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  };
  const mkBtn = (txt, title, fn, disabled = false) => {
    const b = document.createElement("button");
    b.textContent = txt;
    b.title = title;
    b.disabled = disabled;
    b.onclick = fn;
    return b;
  };
  coll.append(
    sel2,
    mkBtn("＋", "New collection.", () => namePrompt("New collection", "", (v) => {
      if (!t.groups[v]) t.groups[v] = { images: [], sel: tabName === "moodboard" ? [] : 0 };
      t.group = v;
      mirrorActive(t, tabName);
      writeCfg(node); render(node);
    })),
    mkBtn("✎", "Rename this collection.", () => namePrompt("Rename collection", t.group, (v) => {
      if (v === t.group || t.groups[v]) return;
      t.groups[v] = t.groups[t.group];
      delete t.groups[t.group];
      t.group = v;
      writeCfg(node); render(node);
    })),
    (() => {
      const dice = mkBtn("🎲", t.random
        ? "Random is on: each run picks a random image from this collection. Click to go back to manual."
        : "Pick a random image from this collection on every run.", () => {
        t.random = !t.random || undefined;
        if (!t.random) delete t.random;
        writeCfg(node); render(node);
      });
      dice.className += " rn-ws-dice" + (t.random ? " on" : "");
      return dice;
    })(),
    mkBtn("✕", Object.keys(t.groups).length <= 1
      ? "The last collection cannot be deleted."
      : "Delete this collection. Its files stay in ComfyUI/input.", () => {
      delete t.groups[t.group];
      t.group = Object.keys(t.groups)[0];
      mirrorActive(t, tabName);
      writeCfg(node); render(node);
    }, Object.keys(t.groups).length <= 1),
  );
  const gAccents = { i2i: "#4a8fe0", subject: "#3f9e63", scene: "#b8493c",
                     moodboard: "#c98a2d", subject2: "#3f9e63",
                     subject3: "#3f9e63" };
  const gcard = sectionCard(tabsLayout ? "GALLERY" : tabName === "i2i" ? "SOURCE" : "IMAGES",
    gAccents[tabName] || "#8fa8c8",
    (t.images?.length || 0) + " image(s)",
    tabName === "i2i" && !tabsLayout ? { node, key: "i2i_source", open: true } : null);
  body.appendChild(gcard);
  const tbar = document.createElement("div");
  tbar.className = "rn-ws-row rn-ws-gtools";
  tbar.style.flexWrap = "wrap";
  if (tabsLayout) {
    tbar.appendChild(coll);
    gcard.appendChild(tbar);
  } else {
    gcard.appendChild(coll);
  }

  grid = document.createElement("div");        // the slider above closes over this
  grid.className = "rn-ws-grid";
  const cellPx = thumbOf(cfg, tabName);
  // PEOPLE: the Subject gallery picks several people in order, the first the main one
  const peopleMode = tabName === "subject";
  const order = peopleMode && t.images.length ? [t.sel, ...(t.extra_sel || [])] : [];
  t.images.forEach((entry, i) => {
    const cell = document.createElement("div");
    const selected = peopleMode ? order.includes(i) : multi ? t.sel.includes(i) : t.sel === i;
    const rolled = t.random && node._rnPicks?.[tabName] === entry;
    cell.className = "rn-ws-cell" + (selected && !t.random ? " sel" : "") + (rolled ? " rolled" : "");
    cell.style.width = cell.style.height = cellPx + "px";
    if (rolled) {
      const rb = document.createElement("span");
      rb.className = "rn-ws-roll";
      rb.textContent = "🎲";
      rb.title = "The last run rolled this one.";
      cell.appendChild(rb);
    }
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = thumbUrl(entry);
    img.onerror = () => {                  // resize route unavailable: fall back, then fail
      if (img.dataset.rnFullTried) { cell.classList.add("missing"); return; }
      img.dataset.rnFullTried = "1";
      img.src = viewUrl(entry);
    };
    img.title = entry;
    cell.appendChild(img);
    if (multi && selected) {
      const n = document.createElement("span");
      n.className = "rn-ws-n";
      n.textContent = `#${t.sel.indexOf(i) + 1}`;
      n.title = "Position in the moodboard batch.";
      cell.appendChild(n);
    }
    if (peopleMode && selected && !t.random) {
      const k = order.indexOf(i);
      const n = document.createElement("span");
      n.className = "rn-ws-n";
      n.textContent = k ? `#${k + 1}` : "#1 Main";
      n.title = k ? `Person ${k + 1}.` : "The main subject: the Subject dials and the boost mask aim at this one.";
      cell.appendChild(n);
    }
    const x = document.createElement("button");
    x.className = "rn-ws-x";
    x.textContent = "✕";
    x.title = "Remove from this gallery. The file itself stays in ComfyUI/input.";
    x.onclick = (e) => {
      e.stopPropagation();
      t.images.splice(i, 1);                          // t.images IS the group's array
      if (multi) t.sel = t.sel.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k));
      else if (peopleMode) {
        const left = order.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k));
        t.sel = left.length ? left[0] : 0;
        t.extra_sel = left.slice(1);
        activeGroup(t, tabName).extra_sel = t.extra_sel;
      } else if (t.sel >= t.images.length) t.sel = Math.max(0, t.images.length - 1);
      activeGroup(t, tabName).sel = t.sel;
      writeCfg(node); render(node);
    };
    cell.appendChild(x);
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGalleryMenu(node, tabName, entry, e);
    });
    cell.onclick = () => {
      if (multi) {
        t.sel = t.sel.includes(i) ? t.sel.filter((k) => k !== i) : [...t.sel, i];
      } else if (peopleMode) {
        // click adds the next person or takes one out; the main one can only go when
        // someone else is picked, and the next in line becomes the main one
        if (!order.includes(i)) t.extra_sel = [...(t.extra_sel || []), i];
        else if (order.length > 1) {
          const left = order.filter((k) => k !== i);
          t.sel = left[0];
          t.extra_sel = left.slice(1);
        }
        activeGroup(t, tabName).extra_sel = t.extra_sel;
      } else {
        t.sel = i;
      }
      activeGroup(t, tabName).sel = t.sel;           // the collection owns the selection
      writeCfg(node); render(node);
    };
    grid.appendChild(cell);
  });

  if (tabName === "i2i") {
    // the chain switch: whose picture is the canvas. Gallery is everything as it
    // always was; the wired choices are how one workspace feeds the next.
    if (!["gallery", "image", "latent"].includes(t.canvas)) t.canvas = "gallery";
    const crow = document.createElement("div");
    crow.className = "rn-ws-row";
    const clab = document.createElement("span");
    clab.className = "rn-ws-note";
    clab.textContent = "Canvas";
    const cseg = document.createElement("div");
    cseg.className = "rn-ws-seg";
    for (const [value, label, tip] of [
      ["gallery", "Gallery", "The selected image below, as always."],
      ["image", "Wired image", "The image_in input is the canvas: chain another "
                               + "workspace's image output here. Pixels fit every "
                               + "model, so the rigs can differ."],
      ["latent", "Wired latent", "The latent input is the canvas at this tab's "
                                 + "denoise: chain another workspace's result_latent "
                                 + "here. Same model family only, no VAE round trip."],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = tip;
      b.className = "rn-ws-segb" + (t.canvas === value ? " on" : "");
      b.onclick = () => { t.canvas = value; writeCfg(node); render(node); };
      cseg.appendChild(b);
    }
    if (tabsLayout) {
      tbar.insertBefore(cseg, tbar.firstChild);
    } else {
      crow.append(clab, cseg);
      gcard.appendChild(crow);
    }
  }
  if (tabsLayout) tbar.appendChild(thumbHolder);
  const add = document.createElement("button");
  add.className = "rn-ws-add";
  add.style.width = add.style.height = cellPx + "px";
  add.textContent = "+";
  add.title = "Add images: click to browse, drop files anywhere on this grid, or hover "
            + "it and press Ctrl+V to paste a copied image.";
  add.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.multiple = true;
    inp.onchange = () => uploadFiles(node, tabName, [...(inp.files || [])]);
    inp.click();
  };
  grid.appendChild(add);

  grid.addEventListener("dragover", (e) => { e.preventDefault(); grid.classList.add("drag"); });
  grid.addEventListener("dragleave", () => grid.classList.remove("drag"));
  grid.addEventListener("drop", (e) => {
    e.preventDefault();
    grid.classList.remove("drag");
    uploadFiles(node, tabName, [...(e.dataTransfer?.files || [])]);
  });
  // Ctrl+V while the pointer is over this grid, the road the Paint canvas already
  // takes: copy an image anywhere, hover the box it belongs in, paste. Registered on
  // the grid, and the paste matcher walks UP from the pointer, so over a gallery this
  // wins and everywhere else the Paint handler still gets its turn. A text clipboard
  // is declined and reaches ComfyUI untouched, including pasting copied nodes. The
  // WeakMap forgets replaced grids by itself, so a re-render leaks nothing.
  panelPaste(grid, (e) => {
    const file = clipboardImage(e);
    if (!file) return false;
    grid.classList.add("drag");            // the drop look, so the paste visibly lands
    uploadFiles(node, tabName, [file]);    // ends in render(), which replaces the grid
  });
  gcard.appendChild(grid);

  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = !t.images.length
    ? "No images yet. Use +, drop files here, or hover and Ctrl+V a copied image; "
      + "the gallery remembers them."
    : multi && !t.sel.length && !t.random
      ? `NOTHING in the batch: ${t.images.length} image(s) here, none selected, so this tab `
        + `outputs nothing. Click the ones to use.`
      : t.random
      ? `🎲 random: one of these ${t.images.length} is picked fresh each run`
        + (multi ? " (a single ref, ignoring the batch selection)" : "")
        + (node._rnPicks?.[tabName] ? `. Last run rolled the amber one` : "")
      : multi
        ? `${t.sel.length} of ${t.images.length} in the batch. Click to add or remove; numbers show batch order.`
        : peopleMode
          ? `${order.length} ${order.length === 1 ? "person" : "people"} picked from ${t.images.length}. `
            + "Click a picture to add the next person or take one out; #1 is the main subject."
          : `${t.images.length} remembered. The highlighted one is used.`;
  gcard.appendChild(note);
  if (peopleMode && order.length > 3 && !t.random) {
    const warn = document.createElement("div");
    warn.className = "rn-ws-note rn-ws-peoplewarn";
    warn.textContent = `${order.length} people: the identity edit was trained on up to three `
                     + "references, so faces may blend. It still runs.";
    gcard.appendChild(warn);
  }
  if (tabsLayout && !multi) chosenStrip(node, body, t, tabName);
}

// ---------------------------------------------------------------- Camera tab
// THE CAMERA TAB: the studio has its own tab, with
// two sub-tabs. PROMPT is the studio that drives the words and the camera
// LoRAs of a Prompts-tab row (the same state the Prompt Frame's chips seed;
// the frame's Advanced button lands here). IMG2IMG is a SEPARATE studio whose
// camera drives the Img2Img tab's re-angle, so the words and the re-shoot can
// point their cameras differently. Both are the same Camera Studio panel.
const CAMERA_PREVIEW = async (state) => {
  const r = await fetch("/rednode/camera_studio_preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  const j = await r.json();
  return j.prompt || "";
};
function cameraBody(node, body) {
  const cfg = node._rnCfg;
  const sub = node._rnCameraSub === "i2i" ? "i2i" : "prompt";
  // THE MASTER SWITCH, first thing on the tab, the same shape the image tabs
  // carry: off, nothing here reaches a render - no camera paragraph, no camera
  // slider LoRAs, no camera path, and the re-angle uses its bands. The studios
  // keep their state, so switching it back on restores every camera as it was.
  {
    if (!cfg.camera || typeof cfg.camera !== "object") cfg.camera = { on: true };
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    const sw = document.createElement("button");
    sw.className = "rn-ws-sw" + (cfg.camera.on ? " on" : "");
    sw.title = cfg.camera.on
      ? "On: the studio below writes the camera paragraph, drives the camera LoRAs "
        + "and renders a camera path. Switch off to take the cameras out of every "
        + "render without losing them."
      : "Off: nothing on this tab reaches a render - the prompt falls back to its "
        + "Shot size / Camera height chips, no camera LoRAs, no path, and the "
        + "Img2Img re-angle uses its bands. The cameras are kept as they are.";
    sw.onclick = () => { cfg.camera.on = !cfg.camera.on; writeCfg(node); render(node); };
    const lab = document.createElement("span");
    lab.className = "rn-ws-note";
    lab.textContent = cfg.camera.on
      ? "Cameras on: the studio drives the prompt, the camera LoRAs and the path."
      : "Cameras OFF: prompts use their simple chips, no camera LoRAs, no path. "
        + "Everything below is kept for when you switch it back on.";
    row.append(sw, lab);
    body.appendChild(row);
  }
  const bar = document.createElement("div");
  bar.className = "rn-ws-row";
  const seg = document.createElement("div");
  seg.className = "rn-ws-seg";
  for (const [v, l, tip] of [["prompt", "Prompt", "The studio behind a prompt: its camera writes the paragraph and drives the camera LoRAs."],
                             ["i2i", "Img2Img", "A separate studio whose camera drives the Img2Img tab's RE-ANGLE (re-shooting the source from another viewpoint)."]]) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (sub === v ? " on" : "");
    b.textContent = l; b.title = tip;
    b.onclick = () => { node._rnCameraSub = v; render(node); };
    seg.appendChild(b);
  }
  bar.appendChild(seg);
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  bar.appendChild(note);
  body.appendChild(bar);

  let getState, setState, afterChange;
  if (sub === "prompt") {
    const rows = cfg.prompts?.rows || [];
    if (!rows.length) {
      note.textContent = "No prompts yet. Add one on the Prompts tab; its camera lives here.";
      return;
    }
    if (typeof node._rnPromptSel !== "number" || node._rnPromptSel >= rows.length) node._rnPromptSel = 0;
    // which prompt's studio: chips, the same as the Prompts tab
    const chips = document.createElement("div");
    chips.className = "rn-ws-seg";
    rows.forEach((row, i) => {
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (node._rnPromptSel === i ? " on" : "");
      b.textContent = row.name || ("Prompt " + (i + 1));
      b.onclick = () => { node._rnPromptSel = i; render(node); };
      chips.appendChild(b);
    });
    bar.insertBefore(chips, note);
    const row = rows[node._rnPromptSel];
    row.frame = row.frame && typeof row.frame === "object" ? row.frame : {};
    note.textContent = row.frame.camera && String(row.frame.camera).trim()
      ? "This studio writes the camera paragraph for \"" + (row.name || "Prompt " + (node._rnPromptSel + 1)) + "\" (Advanced). Clear it on the Prompts tab to go back to the simple chips."
      : "Simple mode: this prompt uses the Shot size / Camera height chips. Move the camera here to switch it to Advanced.";
    getState = () => {
      const raw = row.frame.camera;
      if (typeof raw === "string" && raw.trim()) { try { return JSON.parse(raw); } catch (e) { return {}; } }
      return raw && typeof raw === "object" ? raw : {};
    };
    setState = (st) => { row.frame.camera = st ? JSON.stringify(st) : ""; };
    afterChange = () => { writeCfg(node); };
  } else {
    const t = cfg.tabs.i2i;
    if (!t.reangle || typeof t.reangle !== "object") t.reangle = {};
    const R = t.reangle;
    note.textContent = R.on && R.camera === "studio"
      ? "This camera drives the Img2Img tab's RE-ANGLE. A camera path gives one re-shot view per shot."
      : "The Img2Img tab's RE-ANGLE uses this camera when it is on and set to Studio.";
    const goI2i = document.createElement("button");
    goI2i.className = "rn-ws-btn";
    goI2i.style.cssText = "width:auto;padding:0 10px;margin-left:auto";
    goI2i.textContent = "Img2Img tab ▸";
    goI2i.onclick = () => { node._rnTab = "i2i"; (node.properties ||= {}).rn_tab = "i2i"; render(node); };
    bar.appendChild(goI2i);
    getState = () => {
      const raw = R.studio;
      if (typeof raw === "string" && raw.trim()) { try { return JSON.parse(raw); } catch (e) { return {}; } }
      return {};
    };
    setState = (st) => { R.studio = st ? JSON.stringify(st) : ""; };
    afterChange = () => { writeCfg(node); };
  }
  // A PATH NEEDS THE BUILT-IN SAMPLER: its shots are rendered inside this
  // node, one each. On the external sampler the node hands out one conditioning,
  // so only shot 1 renders, and that reads as a broken path unless it is said
  // right here, where the path is set.
  if (sub === "prompt" && cfg.models?.sampler_mode !== "internal") {
    const p = (getState() || {}).path || {};
    const n = Math.max(1, Math.round(Number(p.shots) || 1));
    if (p.mode && p.mode !== "off" && n > 1) {
      const warn = document.createElement("div");
      warn.className = "rn-ws-note rn-ws-pathwarn";
      warn.style.cssText = "color:#f0c58a";
      warn.textContent = "This path has " + n + " shots, but the Models tab is on the "
        + "external sampler, which gets one conditioning: only shot 1 renders. Switch "
        + "to the built-in sampler there to render every shot as a batch.";
      body.appendChild(warn);
    }
  }
  const host = document.createElement("div");
  host.className = "rn-pf-studio";
  host.style.width = "100%";
  body.appendChild(host);
  buildStudio(host, {
    get: getState,
    set: (st) => { setState(st); },
    onChange: afterChange,
    preview: CAMERA_PREVIEW,
  });
}

function masksBody(node, body) {
  const cfg = node._rnCfg;
  const defs = [
    { tab: "boost_mask", label: "Subject boost mask", base: "subject",
      // WHERE IT GOES, said out loud. Two masks on one tab with no statement of what
      // consumes them reads as two settings for the same thing.
      goes: "Rides the boost_mask output into Krea 2 Identity Edit, the identity "
          + "LoRA's node, and is sized against the SUBJECT tab's picture.",
      hint: "Confines the identity boost to a region, usually the face: likeness "
          + "without dragging the reference's clothes and background along with it. "
          + "Paint the part that must look like the person." },
    { tab: "edit_mask", label: "Edit mask", base: "scene",
      goes: "Rides the edit_mask output, and emits a matching output_latent sized to "
          + "the SCENE tab's picture. Feed that latent to your sampler as well, or the "
          + "painted region lands offset.",
      hint: "Painted means the model may change it; everything else is held "
          + "pixel-faithful to the source. This is the in-place edit mask, nothing to "
          + "do with the identity boost above." },
  ];
  const open = node._rnMaskBoxes ||= {};
  for (const d of defs) {
    const t = cfg.tabs[d.tab];
    // ONE FOLD PER MASK, because each one now carries a painter rather than a button:
    // two canvases stacked open would own the whole tab. The open state lives on the
    // node, never in the config, so folding a box cannot dirty the workflow.
    const isOpen = Object.prototype.hasOwnProperty.call(open, d.tab)
      ? !!open[d.tab] : false;
    const box = document.createElement("div");
    box.className = "rn-ws-sbox rn-ws-sect";
    const head = document.createElement("div");
    head.className = "head";
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = isOpen ? "▾" : "▸";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = d.label;
    const dot = document.createElement("span");
    dot.className = "dot" + (t.on ? " on" : "");
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;flex:none;"
                      + "background:" + (t.on ? "#22c55e" : "#4a5058");
    const on = document.createElement("button");
    on.className = "rn-ws-sw" + (t.on ? " on" : "");
    on.onclick = (e) => {
      e.stopPropagation();                 // the head folds; the toggle does not
      t.on = !t.on;
      writeCfg(node);
      render(node);
    };
    // Deliberately NOT named `state` here. check_panels.mjs slices the Generate
    // handler out of this file between two source anchors, and its closing anchor is
    // the first declaration of a span by that name. A second, earlier one silently
    // emptied the slice and took two real guards down with it. Keep this name unique.
    const stateChip = document.createElement("span");
    stateChip.className = "hint";
    stateChip.style.cssText = "flex:none;font-size:10.5px";
    stateChip.textContent = t.mask ? "Mask painted" : "No mask";
    // Toggle BEFORE the title: the title flexes, so anything after it is thrown to the
    // far edge and the thing you press most sits furthest from the thing you read.
    // The status chips stay trailing, where reading them last is right.
    head.append(arr, on, ttl, dot, stateChip);
    head.onclick = (e) => {
      if (e.target === on) return;
      open[d.tab] = !isOpen;
      render(node);
    };
    box.appendChild(head);

    if (isOpen) {
      const inner = document.createElement("div");
      inner.className = "rn-ws-sbody";
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = d.hint;
      inner.appendChild(hint);
      const goes = document.createElement("span");
      goes.className = "rn-ws-note";
      goes.style.cssText = "font-size:10.5px;opacity:.55";
      goes.textContent = d.goes;
      inner.appendChild(goes);
      maskPainter(node, inner, d);
      box.appendChild(inner);
    }
    body.appendChild(box);
  }
  const warn = document.createElement("div");
  warn.className = "rn-ws-note";
  warn.textContent = "A MASK wired into boost_mask_in or edit_mask_in always wins over the painted one.";
  body.appendChild(warn);
}

// ---- canvas only, over the whole window ------------------------------------
// Just the picture and the tools that mark it. The Paint tab's existing full screen
// takes the WHOLE panel over, prompts, dials, result pane and all, which is the right
// thing when you are running passes and the wrong thing when you are drawing a mask
// and want the room for it.
//
// It MOVES the pane element rather than building another one. The canvas holds the
// pixels, the strokes and the listeners, so re-parenting keeps every one of them and
// closing puts the same object back. Building a second canvas would mean two truths
// for one mask, which is the bug this pack has already had three shapes of.
//
// `tools` are plain descriptors so the two callers can offer different ones: the Paint
// tab has undo and shapes, the Masks tab does not need denoise or Generate.
function openCanvasOnly(node, opts) {
  if (node._rnCanvasOnly) return;
  const pane = opts.pane;
  const home = pane?._parent || pane?.parentElement;
  if (!pane || !home) return;
  const ov = document.createElement("div");
  ov.className = "rn-ws-fsov rn-ws-conly";
  // the panel wrapper swallows these so the node does not drag while you paint; the
  // overlay is outside it, so it has to swallow them itself
  for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu",
                   "click", "dblclick"]) {
    ov.addEventListener(t, (e) => e.stopPropagation());
  }
  const bar = document.createElement("div");
  bar.className = "rn-ws-fsbar";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = opts.title || "Paint";
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "Esc closes. Everything you draw here is already in the node.";
  const x = document.createElement("button");
  x.className = "rn-ws-fsx";
  x.textContent = "✕ Close";
  bar.append(ttl, hint, x);

  const room = document.createElement("div");
  room.className = "rn-ws-conly-room";
  // NOT .rn-ws-zrail: that class forces a vertical column, which is the layout
  // being retired here. The bar sits under the picture now, wide enough that every
  // button carries its own word rather than a bare glyph nobody could place.
  const rail = document.createElement("div");
  rail.className = "rn-ws-zbar rn-ws-conly-rail";
  const holder = document.createElement("div");
  holder.className = "rn-ws-conly-pane";
  // PICTURE FIRST, BAR BELOW: the room reads top-to-bottom the way the panel's own
  // canvas-then-controls layout already does everywhere else.
  room.append(holder, rail);
  ov.append(bar, room);

  // built buttons are tracked directly rather than re-walked from the DOM on
  // refresh: a tool can live inside a group wrapper now, one level deeper than a
  // plain `rail.children` scan would reach.
  const built = [];
  const buildTool = (parent, t) => {
    if (t.gap) {
      const sp = document.createElement("span");
      sp.className = "sp";
      parent.appendChild(sp);
      return;
    }
    if (t.el) { parent.appendChild(t.el); return; }
    const b = document.createElement("button");
    b.className = "rn-ws-btn rn-ws-zb" + (t.on ? " on" : "");
    b.textContent = t.label;
    b.title = t.title || "";
    b.disabled = !!t.disabled;
    if (t.name) b.dataset.tool = t.name;
    b.onclick = () => t.run?.(refresh);
    parent.appendChild(b);
    if (t.name) built.push([b, t]);
  };
  for (const t of opts.tools || []) {
    if (t.group) {
      const g = document.createElement("div");
      g.className = "rn-ws-conly-group";
      if (t.groupLabel) {
        const gl = document.createElement("span");
        gl.className = "lab";
        gl.textContent = t.groupLabel;
        g.appendChild(gl);
      }
      for (const gt of t.group) buildTool(g, gt);
      rail.appendChild(g);
      continue;
    }
    buildTool(rail, t);
  }

  // the pane moves in; the panel keeps a note where it was so nothing looks lost
  const marker = document.createElement("div");
  marker.className = "rn-ws-pempty";
  marker.textContent = "Painting full screen. Close it to bring the canvas back here.";
  home.insertBefore?.(marker, pane);
  holder.appendChild(pane);
  node._rnCanvasOnly = { pane, home, marker, close: null };

  const refresh = () => {
    // repaint IN PLACE. A render() here would rebuild the panel underneath and either
    // yank this pane back out of the overlay or orphan it.
    opts.rebuild?.();
    for (const [b, t] of built) {
      if (typeof t.label === "string") b.textContent = t.labelOf?.() || t.label;
      b.className = "rn-ws-btn rn-ws-zb" + (t.isOn?.() ? " on" : "");
      b.disabled = !!t.isOff?.();
    }
  };

  const close = () => {
    if (!node._rnCanvasOnly) return;
    node._rnCanvasOnly = null;
    // put the SAME element back where it came from, before the marker that stood in
    // for it, then let the panel render normally around it
    if (marker._parent || marker.parentElement) {
      home.insertBefore?.(pane, marker);
      marker.remove();
    } else {
      home.appendChild(pane);
    }
    ov.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
    render(node);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  x.onclick = close;
  node._rnCanvasOnly.close = close;
  document.body.appendChild(ov);
  opts.rebuild?.();
}

// The Paint tab's canvas, over the whole window. Same pane, same strokes, same
// handlers: the view tools and the mask tools come with it, the prompts and dials do
// not, which is the difference from the panel's own Full screen.
function openPaintCanvasOnly(node) {
  const pane = node._rnPaintPane;
  if (!pane?.left) return;
  const P = () => node._rnCfg?.paint || {};
  const busy = { on: false };
  const autoMask = async (want) => {
    const live = P();
    const res = await api.fetchApi("/rednode/auto_mask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: live.source, want }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    live.auto_mask = d.mask;
    // only the MASK strokes yield to the segmenter; colour paint is not coverage
    // and survives the press
    node._rnStrokes = (node._rnStrokes || []).filter((st) => st[8]);
    node._rnRedo = [];
    writeCfg(node);
    node._rnSeedBase?.(d.mask);        // in place: a render would empty this room
    saveMaskNow(node);
  };
  // THE BRUSH GROUP: a word ("Brush"), a horizontal slider and the value, in one
  // boxed cluster. The vertical writing-mode slider from the old rail is gone with
  // the column layout it was built for.
  const bLab = document.createElement("span");
  bLab.className = "lab";
  bLab.textContent = "Brush";
  const brush = document.createElement("input");
  brush.type = "range";
  brush.min = 2; brush.max = 400; brush.step = 1;
  brush.value = P().brush ?? 48;
  brush.title = "Brush width, in pixels of the source image. Scroll over this "
              + "control to nudge it without reaching for the slider.";
  brush.style.cssText = "width:150px;height:22px;cursor:pointer;accent-color:#b8283c";
  const bVal = document.createElement("span");
  bVal.className = "rn-ws-zpct";
  bVal.style.minWidth = "34px";
  bVal.textContent = String(P().brush ?? 48);
  const applyBrush = (raw) => {
    const v = snapStep(raw, 2, 400, 1);
    P().brush = v;
    brush.value = v;
    bVal.textContent = String(v);
    writeCfg(node);
    node._rnSyncRing?.();
  };
  brush.addEventListener("input", () => applyBrush(brush.value));
  const brushGroup = document.createElement("span");
  brushGroup.style.cssText = "display:flex;align-items:center;gap:7px";
  brushGroup.append(bLab, brush, bVal);
  // SCROLL TO RESIZE THE BRUSH while the pointer sits over this control, the way a
  // paint tool binds [ and ] to brush size: the picture already claims the wheel for
  // zoom, so the size control is where the same gesture reaches the brush instead.
  brushGroup.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyBrush((Number(brush.value) || P().brush || 48) + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });

  openCanvasOnly(node, {
    pane: pane.left,
    title: "Paint",
    rebuild: () => node._rnShowAll?.(),
    tools: [
      { group: [
        { label: "✋ Pan", name: "hand",
          title: "Drag moves the view instead of painting.",
          run: (refresh) => { node._rnPanMode = !node._rnPanMode;
                              node._rnSyncZbar?.(); refresh(); },
          isOn: () => !!node._rnPanMode },
        { label: "− Zoom out", title: "zoom out",
          run: () => pane.zoomAt?.(0, 0, (node._rnView?.z || 1) / 1.25) },
        { label: "+ Zoom in",
          title: "zoom in. The wheel zooms at the pointer too.",
          run: () => pane.zoomAt?.(0, 0, (node._rnView?.z || 1) * 1.25) },
        { label: "Fit", title: "the whole picture in the pane again",
          run: () => pane.zoomAt?.(0, 0, 1) },
        { label: "↶ Undo", title: "undo the last stroke", run: () => pane.undo?.() },
        { label: "↷ Redo", title: "redo", run: () => pane.redo?.() },
      ] },
      { group: [{ el: brushGroup }] },
      { group: [{ el: buildColourCluster(node).el }] },
      { group: [
        { name: "shape-round", label: "⚪ Round", title: "round brush: soft, even strokes",
          run: (refresh) => {
            P().brush_shape = "round"; writeCfg(node); node._rnSyncRing?.(); refresh();
          },
          isOn: () => (P().brush_shape || "round") === "round" },
        { name: "shape-square", label: "⬛ Square",
          title: "square brush: hard corners, straight-edged masks along "
               + "architecture and frames",
          run: (refresh) => {
            P().brush_shape = "square"; writeCfg(node); node._rnSyncRing?.(); refresh();
          },
          isOn: () => P().brush_shape === "square" },
      ] },
      { gap: true },
      { group: [
        { name: "bg", label: "Mask background",
          title: "Mask everything except the subject. Needs a segmenter installed.",
          run: async (refresh) => {
            if (busy.on) return;
            busy.on = true;
            try { await autoMask("background"); }
            catch (e) { alert(`Could not make that mask: ${e.message}`); }
            finally { busy.on = false; refresh(); }
          } },
        { name: "subj", label: "Mask subject",
          title: "Mask the subject instead. The same mask the other way up.",
          run: async (refresh) => {
            if (busy.on) return;
            busy.on = true;
            try { await autoMask("subject"); }
            catch (e) { alert(`Could not make that mask: ${e.message}`); }
            finally { busy.on = false; refresh(); }
          } },
        { name: "clear", label: "Clear paint",
          title: "Wipe everything painted: strokes, masks and colour paint.",
          run: (refresh) => {
            const live = P();
            node._rnStrokes = [];
            live.mask = "";
            live.auto_mask = "";
            live.colour = "";
            node._rnMaskDirty = false;
            node._rnColourDirty = false;
            writeCfg(node);
            node._rnResetPaint?.();
            node._rnResetColour?.();
            refresh();
          } },
      ] },
    ],
  });
}

/** The little expand button both tabs put in a pane's top right. */
function canvasOnlyButton(title, run) {
  const b = document.createElement("button");
  b.className = "rn-ws-btn rn-ws-conly-open";
  b.textContent = "⛶";
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); run(); };
  return b;
}

// ---- the Masks tab's own painter ------------------------------------------
// The Paint tab's canvas, cut down to what a mask needs: a brush, the auto masker,
// and a clear. No denoise, no sampler, no result pane, because nothing here renders.
//
// It is a SEPARATE component rather than the Paint pane parameterised, deliberately.
// The Paint pane carries a zoom rail, a result pane, batch state and a Generate path,
// all keyed to one node-level slot; bending that into a second and third instance
// would put three canvases through machinery built for one. What it DOES share is
// every primitive that decides what a mask IS: maskSegment, replayStrokes,
// maskCanvas and uploadMask, so a mask painted here is byte-identical in kind to one
// painted there, and the painted-means-transparent convention lives in one place.
//
// State is per SLOT, on the node, so both masks can be open at once without sharing
// a stroke list or a canvas.
function maskPainter(node, host, def) {
  const cfg = node._rnCfg;
  const t = cfg.tabs[def.tab];
  const slots = node._rnMaskSlots ||= {};
  const S = slots[def.tab] ||= { strokes: [], brush: 48, source: "", view: { z: 1, x: 0, y: 0 } };
  S.view ||= { z: 1, x: 0, y: 0 };
  S.redoStack ||= [];
  S.brush_shape ||= "round";

  // WHICH PICTURE. The base tab's selection is the default and the common case; the
  // dropdown exists because a boost mask is sometimes drawn against a different
  // reference than the one the tab happens to have selected, and an uploaded picture
  // of your own has to be reachable without going through a gallery.
  const choices = [];
  for (const [id, meta] of Object.entries(IMAGE_TABS)) {
    const tab = cfg.tabs[id];
    const sel = tab.images[Array.isArray(tab.sel) ? tab.sel[0] : tab.sel];
    if (sel) choices.push([sel, `${meta.label}: ${String(sel).split("/").pop()}`]);
  }
  // an OWN upload rides in cfg (t.src), not just the runtime slot: this list is
  // rebuilt from gallery selections on every render, so an unpinned upload fell out
  // of it and the render the upload itself fired snapped back to a gallery image
  if (t.src) choices.push([t.src, `Own: ${String(t.src).split("/").pop()}`]);
  const chosen = S.source && choices.some(([v]) => v === S.source) ? S.source
    : t.src
    || (choices.find(([, l]) => l.toLowerCase()
        .startsWith(def.base.toLowerCase()))?.[0] || choices[0]?.[0] || "");
  S.source = chosen;

  const pick = document.createElement("div");
  pick.className = "rn-ws-row";
  const pLab = document.createElement("span");
  pLab.className = "hint";
  pLab.style.cssText = "flex:none;width:64px";
  pLab.textContent = "Paint on";
  const sel = document.createElement("select");
  sel.className = "rn-ws-res";
  sel.style.cssText = "flex:1 1 auto;min-width:0";
  for (const [value, label] of choices) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (value === chosen) o.selected = true;
    sel.appendChild(o);
  }
  if (!choices.length) {
    const o = document.createElement("option");
    o.textContent = "No image on any gallery tab yet";
    sel.appendChild(o);
    sel.disabled = true;
  }
  sel.title = "Which picture to draw this mask on. Any gallery tab's current "
            + "selection, or one of your own through Open image.";
  sel.onchange = () => {
    const live = node._rnCfg?.tabs?.[def.tab] || t;
    S.source = sel.value;
    // picking a gallery entry unpins an own upload, or the pin would put the upload
    // back on top after a reload however often a gallery image was chosen since
    if (sel.value !== live.src) live.src = "";
    S.strokes = [];                      // strokes belong to the picture they were on
    S.redoStack = [];
    S.baseSrc = "";
    live.mask = "";      // and so does the SAVED mask: left in place, the rebuild
                         // drew the old picture's mask over the new one as a base coat
    writeCfg(node);
    render(node);
  };
  const openB = document.createElement("button");
  openB.className = "rn-ws-btn rn-ws-compact";
  openB.style.cssText = "width:auto;padding:0 10px";
  openB.textContent = "Open image";
  openB.title = "Use a picture of your own for this mask. It is stored with the "
              + "workspace's other managed files.";
  openB.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = async () => {
      const file = (inp.files || [])[0];
      if (!file) return;
      try {
        // the same normalise-then-upload road every other picture takes, so a mask
        // source is a managed file like any other. The PATH is pinned in cfg (t.src)
        // because the runtime slot does not survive a reload, and the dropdown is
        // rebuilt from gallery selections, which this file is never among.
        const { blob, name } = await normalisedUpload(file);
        const fd = new FormData();
        fd.append("image", blob, name);
        fd.append("type", "input");
        fd.append("subfolder", "rednode/paint");
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        const d = await res.json();
        if (!d.name) throw new Error("the upload returned no name");
        const live = node._rnCfg?.tabs?.[def.tab] || t;
        S.source = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
        live.src = S.source;
        live.mask = "";                    // a new picture, so the old mask goes too
        S.strokes = [];
        S.redoStack = [];
        S.baseSrc = "";
        writeCfg(node);
        render(node);
      } catch (e) {
        console.error("[RedNode Workspace] could not take that picture:", e);
        alert(`Could not use that image: ${e.message}`);
      }
    };
    inp.click();
  };
  pick.append(pLab, sel, openB);
  host.appendChild(pick);

  if (!S.source) {
    const empty = document.createElement("div");
    empty.className = "rn-ws-note";
    empty.textContent = "Select an image on a gallery tab, or press Open image, and "
                      + "the canvas appears here.";
    host.appendChild(empty);
    return;
  }

  const pane = document.createElement("div");
  pane.className = "rn-ws-pcanvas rn-ws-mpane";
  const base = document.createElement("canvas");
  const layer = document.createElement("canvas");
  layer.className = "paintlayer";
  pane.append(base, layer);
  host.appendChild(pane);
  // a mask is fiddly work and this box is 300px tall, so the same canvas is one
  // press away from the whole window, with its tools beside it
  pane.appendChild(canvasOnlyButton(
    `Paint this ${def.label.toLowerCase()} over the whole window.`,
    () => openMaskPainterFullscreen(node, def)));

  const mask = document.createElement("canvas");
  S.maskCanvas = mask;
  const lctx = () => layer.getContext("2d");
  const mctx = () => mask.getContext("2d");
  let ready = false;

  // the same see-through look the Paint tab uses, through the same preference, so a
  // colour chosen for readability applies everywhere a mask is drawn
  const showAll = () => {
    if (!ready || !layer.width) return;
    const r = layer.getBoundingClientRect();
    const scale = r.width > 0 ? layer.width / r.width : 0;
    if (!scale) return;
    const c = lctx();
    const mode = String(wsPref("OverlayMode", "hatch"));
    const o = Math.max(0.1, Math.min(1, (Number(wsPref("OverlayOpacity", 55)) || 55) / 100));
    const rgb = OVERLAY_COLORS[String(wsPref("OverlayColor", "red"))] || OVERLAY_COLORS.red;
    c.save();
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, layer.width, layer.height);
    c.fillStyle = mode === "flat" ? `rgba(${rgb},${o})`
      : `rgba(${rgb},${+(o * 0.16 / 0.55).toFixed(4)})`;
    c.fillRect(0, 0, layer.width, layer.height);
    if (mode !== "flat") {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 8;
      const tc = tile.getContext("2d");
      tc.lineWidth = 2;
      tc.strokeStyle = `rgba(255,255,255,${o})`;
      tc.beginPath(); tc.moveTo(-2, 6); tc.lineTo(6, -2); tc.stroke();
      tc.strokeStyle = `rgba(0,0,0,${o})`;
      tc.beginPath(); tc.moveTo(2, 10); tc.lineTo(10, 2); tc.stroke();
      const p = c.createPattern(tile, "repeat");
      if (p?.setTransform && typeof DOMMatrix === "function") {
        p.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
      }
      if (p) { c.fillStyle = p; c.fillRect(0, 0, layer.width, layer.height); }
    }
    c.globalCompositeOperation = "destination-in";
    c.drawImage(mask, 0, 0);
    c.restore();
  };
  // published so a preference change repaints an open painter in place, the way the
  // Paint pane's _rnShowAll already does; the full-screen room shares this closure
  S.showAll = showAll;

  // The saved mask is the base coat, inverted on the way in exactly as the Paint tab
  // does it: the FILE says painted-means-transparent, the canvas says painted-means-
  // opaque, so drawing the PNG straight in would mask everything you did not want.
  let baseImg = null;
  const drawBase = () => {
    if (!baseImg?.naturalWidth || !mask.width) return;
    const scratch = document.createElement("canvas");
    scratch.width = mask.width;
    scratch.height = mask.height;
    const s = scratch.getContext("2d");
    s.fillStyle = "#fff";
    s.fillRect(0, 0, scratch.width, scratch.height);
    s.globalCompositeOperation = "destination-out";
    s.drawImage(baseImg, 0, 0, scratch.width, scratch.height);
    mctx().globalCompositeOperation = "source-over";
    mctx().drawImage(scratch, 0, 0);
  };
  const rebuild = () => {
    mctx().clearRect(0, 0, mask.width, mask.height);
    drawBase();
    replayStrokes(node, mask, S.strokes);
    showAll();
  };
  S.rebuild = rebuild;

  // ZOOM. The same CSS-transform technique the Paint tab uses: base and layer scale
  // together so they stay registered, and the brush's pointer mapping in `at()` below
  // reads getBoundingClientRect(), which already reflects the transform, so painting
  // while zoomed needs no separate handling. This is what the compact painter had
  // NONE of before: no view state, no wheel handler, nothing for a zoom button to
  // drive, which is why the first version's full-screen room had no zoom or undo at
  // all, only the brush and the three mask actions.
  const applyView = () => {
    const v = S.view;
    const tf = v.z === 1 && !v.x && !v.y ? "" : `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    base.style.transform = tf;
    layer.style.transform = tf;
    showAll();
  };
  const zoomAt = (mx, my, z1) => {
    z1 = Math.max(1, Math.min(8, z1));
    const v = S.view;
    if (z1 === v.z) return;
    v.x = mx - (z1 / v.z) * (mx - v.x);
    v.y = my - (z1 / v.z) * (my - v.y);
    v.z = z1;
    if (z1 === 1) { v.x = 0; v.y = 0; }
    applyView();
  };
  S.zoomAt = zoomAt;
  // wheel-zoom over the picture, at the pointer: works in the small inline pane and
  // in the full-screen room alike, since both share this same `pane` element
  pane.addEventListener("wheel", (e) => {
    if (!ready) return;
    e.preventDefault();
    e.stopPropagation();
    const r = pane.getBoundingClientRect();
    // 1.2 per notch, not 1.15: reported as feeling slow at the old rate
    zoomAt(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2,
           S.view.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  }, { passive: false });

  // UNDO / REDO, grouped by gesture the same way the Paint tab groups a drag: one
  // stroke() call per pointer sample, one undo step per DRAG, or the button takes
  // back one dot of a line at a time.
  //
  // Both SAVE. Strokes and the saved mask FILE are one state: an undo without a save
  // left the file a step ahead of the canvas, and the queue rendered the mask from
  // before the undo. The buttons are kept as refs and flipped in place instead of
  // calling render(node), which tore the painter down under the save it had queued.
  let undoB = null, redoB = null;
  const syncUndoRedo = () => {
    if (undoB) undoB.disabled = !S.strokes.length;
    if (redoB) redoB.disabled = !S.redoStack.length;
  };
  const undo = () => {
    const st = S.strokes;
    if (!st.length) return;
    const id = st[st.length - 1][6];
    const grp = [];
    do { grp.unshift(st.pop()); }
    while (st.length && id !== undefined && st[st.length - 1][6] === id);
    S.redoStack.push(grp);
    rebuild();
    syncUndoRedo();
    save();
  };
  const redo = () => {
    const grp = S.redoStack.pop();
    if (!grp) return;
    S.strokes.push(...grp);
    rebuild();
    syncUndoRedo();
    save();
  };
  S.undo = undo;
  S.redo = redo;

  const img = new Image();
  img.onload = () => {
    base.width = layer.width = mask.width = img.naturalWidth;
    base.height = layer.height = mask.height = img.naturalHeight;
    base.getContext("2d").drawImage(img, 0, 0);
    ready = true;
    applyView();          // carries a remembered zoom over from a previous open
    rebuild();
  };
  img.onerror = () => {
    pane.replaceChildren();
    const bad = document.createElement("div");
    bad.className = "rn-ws-pempty";
    bad.textContent = "That image is gone. Pick another one.";
    pane.appendChild(bad);
  };
  img.src = viewUrl(S.source);

  // The base coat is OWNED, not inferred: S.baseSrc names the file the canvas was
  // seeded from (a resumed mask, or an auto-mask), set when one lands and cleared by
  // Clear, a source change and an upload. It used to be inferred as "t.mask and no
  // strokes waiting", which broke the moment strokes were painted OVER an auto-mask:
  // the next rebuild skipped the base, and the save after that flattened strokes
  // only, silently destroying the auto-mask underneath. A fresh slot resuming a
  // saved mask still seeds from t.mask, and only stroke-free, because that file
  // already contains the strokes and drawing both would double every one.
  if (!S.baseSrc && t.mask && !S.strokes.length) S.baseSrc = t.mask;
  if (S.baseSrc) {
    baseImg = new Image();
    baseImg.onload = () => { if (ready) rebuild(); };
    // a base that cannot load is no base: keeping the name would leave an empty
    // canvas claiming a coat nothing can draw
    baseImg.onerror = () => { baseImg = null; S.baseSrc = ""; };
    baseImg.src = viewUrl(S.baseSrc);
  }

  const persist = async () => {
    if (!ready) return;
    if (!S.strokes.length && !S.baseSrc) {
      // an empty canvas: the backend treats ANY mask filename as a real mask, so
      // the filename is dropped rather than uploading a file that covers nothing
      const live = node._rnCfg?.tabs?.[def.tab] || t;
      live.mask = "";
      writeCfg(node);
      if (S.note) S.note.textContent = "Nothing painted yet";
      return;
    }
    try {
      const name = await uploadMask(node, maskCanvas(mask, 0));
      const live = node._rnCfg?.tabs?.[def.tab] || t;
      live.mask = name;
      writeCfg(node);
      if (S.note) S.note.textContent = "Mask saved";
    } catch (e) {
      console.error("[RedNode Workspace] could not save the mask:", e);
      if (S.note) S.note.textContent = "Could not save";
    }
  };
  // ONE save at a time, in order: rapid undo clicks each queue one, and two uploads
  // racing could land out of order, leaving the file a state behind the canvas. The
  // chain lives on the slot so a save queued by a previous build still lands first.
  const save = () => (S.saveChain = (S.saveChain || Promise.resolve()).then(persist));

  const at = (e) => {
    const r = layer.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1, r.width)) * layer.width,
            ((e.clientY - r.top) / Math.max(1, r.height)) * layer.height];
  };
  let drawing = false;
  let dirty = false;
  layer.addEventListener("contextmenu", (e) => e.preventDefault());
  layer.addEventListener("pointerdown", (e) => {
    if (!ready) return;
    e.stopPropagation();
    e.preventDefault();
    drawing = true;
    // a new stroke is a new undo unit, and it makes any redone future moot
    S.dragSeq = (S.dragSeq || 0) + 1;
    S.redoStack = [];
    const erase = e.button === 2 || e.ctrlKey;
    let [px, py] = at(e);
    const stroke = (x0, y0, x1, y1) => {
      const shape = S.brush_shape || "round";
      maskSegment(mask, x0, y0, x1, y1, S.brush, erase, shape);
      // the 7th field names the DRAG this segment belongs to, matching the Paint
      // tab's own stroke record, so undo takes back a whole gesture, not one dot;
      // the 8th is the SHAPE, per segment, so switching mid-mask and then undoing
      // replays each stroke the way it was actually drawn
      S.strokes.push([x0, y0, x1, y1, S.brush, erase ? 1 : 0, S.dragSeq, shape]);
      showAll();
      dirty = true;
      if (S.note) S.note.textContent = "Unsaved";
    };
    stroke(px, py, px, py);
    syncUndoRedo();               // undo is live now, and the cleared redo is not
    layer.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      if (!drawing) return;
      ev.stopPropagation();
      const [x, y] = at(ev);
      stroke(px, py, x, y);
      px = x; py = y;
    };
    const up = (ev) => {
      drawing = false;
      layer.releasePointerCapture?.(ev?.pointerId ?? e.pointerId);
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", up);
      layer.removeEventListener("pointercancel", up);
    };
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", up);
    layer.addEventListener("pointercancel", up);
  });
  // saved when the brush leaves, the same moment the Paint tab uses: never mid-stroke
  layer.addEventListener("pointerleave", () => {
    if (dirty && !drawing) { dirty = false; save(); }
  });

  const tools = document.createElement("div");
  tools.className = "rn-ws-row";
  tools.style.flexWrap = "wrap";
  const bLab = document.createElement("span");
  bLab.className = "hint";
  bLab.style.cssText = "flex:none;width:64px";
  bLab.textContent = "Brush";
  const bRng = document.createElement("input");
  bRng.type = "range";
  bRng.min = 2; bRng.max = 400; bRng.step = 1;
  bRng.value = S.brush;
  bRng.style.cssText = "flex:1 1 90px;min-width:70px;height:22px;cursor:pointer;"
                     + "accent-color:#b8283c";
  const bVal = document.createElement("span");
  bVal.className = "rn-ws-zpct";
  bVal.style.minWidth = "34px";
  bVal.textContent = String(S.brush);
  const applyBrush = (raw) => {
    S.brush = snapStep(raw, 2, 400, 1);
    bRng.value = S.brush;
    bVal.textContent = String(S.brush);
  };
  bRng.addEventListener("input", () => applyBrush(bRng.value));
  const brushWrap = document.createElement("span");
  brushWrap.style.cssText = "display:flex;align-items:center;gap:6px;flex:1 1 90px;"
                          + "min-width:0";
  brushWrap.append(bLab, bRng, bVal);
  // scroll over the brush control to nudge it, the way this pack's other brush
  // sliders do, without needing to grab the thin track exactly
  brushWrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyBrush((Number(bRng.value) || S.brush) + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });
  tools.append(brushWrap);

  // ROUND / SQUARE, the same two shapes and the same glyphs the Paint tab uses.
  // Reported missing after the redesign: this painter recorded every stroke as
  // "round" with no way to choose otherwise, so a straight-edged mask along an
  // architectural line or a frame had no tool for it here, unlike on Paint.
  const shapeSeg = document.createElement("span");
  shapeSeg.className = "rn-ws-seg";
  shapeSeg.style.flex = "0 0 auto";
  const shapeBtns = [];
  const syncShape = () => {
    for (const [b, val] of shapeBtns) {
      b.className = "rn-ws-btn rn-ws-zb" + ((S.brush_shape || "round") === val ? " on" : "");
    }
  };
  for (const [val, glyph, tip] of [
    ["round", "⚪", "round brush: soft, even strokes"],
    ["square", "⬛", "square brush: hard corners, straight-edged masks along "
                        + "architecture and frames"],
  ]) {
    const b = document.createElement("button");
    b.textContent = glyph;
    b.title = tip;
    b.onclick = () => { S.brush_shape = val; syncShape(); };
    shapeSeg.appendChild(b);
    shapeBtns.push([b, val]);
  }
  syncShape();
  tools.appendChild(shapeSeg);

  // no render(node) on these: undo/redo save, and a rebuild here tore the painter
  // down before the save landed, so the queue rendered the pre-undo mask
  undoB = document.createElement("button");
  undoB.className = "rn-ws-btn rn-ws-compact";
  undoB.style.cssText = "width:auto;padding:0 10px";
  undoB.textContent = "↶";
  undoB.title = "undo the last stroke";
  undoB.disabled = !S.strokes.length;
  undoB.onclick = () => S.undo?.();
  redoB = document.createElement("button");
  redoB.className = "rn-ws-btn rn-ws-compact";
  redoB.style.cssText = "width:auto;padding:0 10px";
  redoB.textContent = "↷";
  redoB.title = "redo";
  redoB.disabled = !S.redoStack.length;
  redoB.onclick = () => S.redo?.();
  tools.append(undoB, redoB);

  // the SAME auto masker the Paint tab drives, against this slot's picture
  for (const [label, want] of [["Mask background", "background"],
                               ["Mask subject", "subject"]]) {
    const b = document.createElement("button");
    b.className = "rn-ws-btn rn-ws-compact";
    b.style.cssText = "width:auto;padding:0 10px";
    b.dataset.maskAuto = want;
    b.textContent = S.busy === want ? "Working..." : label;
    b.disabled = !!S.busy;
    b.title = want === "background"
      ? "Mask everything except the subject. Adds to the canvas like paint, so the "
        + "brush can tidy it afterwards. Needs a segmenter installed."
      : "Mask the subject instead. The same mask the other way up.";
    b.onclick = async () => {
      if (S.busy) return;
      S.busy = want;
      render(node);
      try {
        const res = await api.fetchApi("/rednode/auto_mask", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: S.source, want }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        const live = node._rnCfg?.tabs?.[def.tab] || t;
        live.mask = d.mask;                // it IS the mask now, strokes go with it
        const liveSlot = node._rnMaskSlots[def.tab] || S;
        liveSlot.strokes = [];
        liveSlot.redoStack = [];        // a new base coat makes any pending redo moot
        liveSlot.baseSrc = d.mask;      // and the rebuild loads the coat from HERE
        writeCfg(node);
      } catch (e) {
        console.error("[RedNode Workspace] auto mask failed:", e);
        alert(`Could not make that mask: ${e.message}`);
      } finally {
        S.busy = "";
        render(node);
      }
    };
    tools.appendChild(b);
  }

  const clear = document.createElement("button");
  clear.className = "rn-ws-btn rn-ws-compact";
  clear.style.cssText = "width:auto;padding:0 10px";
  clear.textContent = "Clear";
  clear.disabled = !t.mask && !S.strokes.length;
  clear.title = "Wipe this mask. The picture underneath is untouched.";
  clear.onclick = () => {
    const live = node._rnCfg?.tabs?.[def.tab] || t;
    live.mask = "";
    S.strokes = [];
    S.redoStack = [];
    S.baseSrc = "";
    writeCfg(node);
    render(node);
  };
  tools.appendChild(clear);

  const note = document.createElement("span");
  note.className = "hint";
  note.style.cssText = "margin-left:auto;flex:none;font-size:10.5px";
  note.textContent = t.mask ? "Mask saved" : "Nothing painted yet";
  S.note = note;
  tools.appendChild(note);
  host.appendChild(tools);

  // what the full-screen room drives: the same pane, the same handlers, the same
  // save. Held on the slot so the opener can find them without rebuilding anything.
  S.pane = pane;
  S.save = save;
  S.autoMask = async (want) => {
    const res = await api.fetchApi("/rednode/auto_mask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: S.source, want }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    const live = node._rnCfg?.tabs?.[def.tab] || t;
    live.mask = d.mask;
    S.strokes = [];
    S.redoStack = [];               // a new base coat makes any pending redo moot
    S.baseSrc = d.mask;             // a later rebuild loads the coat from here
    writeCfg(node);
    syncUndoRedo();
    // reseed the canvas from the file the segmenter just made, in place
    baseImg = new Image();
    baseImg.onload = () => rebuild();
    baseImg.onerror = () => { baseImg = null; S.baseSrc = ""; };
    baseImg.src = viewUrl(d.mask);
  };
  S.clear = () => {
    const live = node._rnCfg?.tabs?.[def.tab] || t;
    live.mask = "";
    S.strokes = [];
    S.redoStack = [];
    S.baseSrc = "";
    baseImg = null;
    writeCfg(node);
    rebuild();
    syncUndoRedo();
  };
}

// The Masks tab's canvas, over the whole window, with its tools on the left.
function openMaskPainterFullscreen(node, def) {
  const S = node._rnMaskSlots?.[def.tab];
  if (!S?.pane) return;
  const bLab = document.createElement("span");
  bLab.className = "lab";
  bLab.textContent = "Brush";
  const brush = document.createElement("input");
  brush.type = "range";
  brush.min = 2; brush.max = 400; brush.step = 1;
  brush.value = S.brush;
  brush.title = "Brush width, in pixels of the source image. Scroll over this "
              + "control to nudge it without reaching for the slider.";
  brush.style.cssText = "width:150px;height:22px;cursor:pointer;accent-color:#b8283c";
  const bVal = document.createElement("span");
  bVal.className = "rn-ws-zpct";
  bVal.style.minWidth = "34px";
  bVal.textContent = String(S.brush);
  const applyBrush = (raw) => {
    const v = snapStep(raw, 2, 400, 1);
    S.brush = v;
    brush.value = v;
    bVal.textContent = String(v);
  };
  brush.addEventListener("input", () => applyBrush(brush.value));
  const brushGroup = document.createElement("span");
  brushGroup.style.cssText = "display:flex;align-items:center;gap:7px";
  brushGroup.append(bLab, brush, bVal);
  brushGroup.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyBrush((Number(brush.value) || S.brush) + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });

  const busy = { on: false };
  openCanvasOnly(node, {
    pane: S.pane,
    title: def.label,
    rebuild: () => S.rebuild?.(),
    tools: [
      { group: [
        { label: "− Zoom out", title: "zoom out",
          run: () => S.zoomAt?.(0, 0, (S.view?.z || 1) / 1.25) },
        { label: "+ Zoom in",
          title: "zoom in. The wheel zooms at the pointer too.",
          run: () => S.zoomAt?.(0, 0, (S.view?.z || 1) * 1.25) },
        { label: "Fit", title: "the whole picture in the pane again",
          run: () => S.zoomAt?.(0, 0, 1) },
        { label: "↶ Undo", title: "undo the last stroke", run: () => S.undo?.() },
        { label: "↷ Redo", title: "redo", run: () => S.redo?.() },
      ] },
      { group: [
        { name: "shape-round", label: "⚪ Round", title: "round brush: soft, even strokes",
          run: (refresh) => { S.brush_shape = "round"; refresh(); },
          isOn: () => (S.brush_shape || "round") === "round" },
        { name: "shape-square", label: "⬛ Square",
          title: "square brush: hard corners, straight-edged masks along "
               + "architecture and frames",
          run: (refresh) => { S.brush_shape = "square"; refresh(); },
          isOn: () => S.brush_shape === "square" },
      ] },
      { group: [{ el: brushGroup }] },
      { gap: true },
      { group: [
        { name: "bg", label: "Mask background",
          title: "Mask everything except the subject. Needs a segmenter installed.",
          run: async (refresh) => {
            if (busy.on) return;
            busy.on = true;
            try { await S.autoMask("background"); }
            catch (e) { alert(`Could not make that mask: ${e.message}`); }
            finally { busy.on = false; refresh(); }
          } },
        { name: "subj", label: "Mask subject",
          title: "Mask the subject instead. The same mask the other way up.",
          run: async (refresh) => {
            if (busy.on) return;
            busy.on = true;
            try { await S.autoMask("subject"); }
            catch (e) { alert(`Could not make that mask: ${e.message}`); }
            finally { busy.on = false; refresh(); }
          } },
        { name: "clear", label: "Clear",
          title: "Wipe this mask. The picture underneath is untouched.",
          run: (refresh) => { S.clear?.(); refresh(); } },
      ] },
    ],
  });
}

// The per-tab AUTO PROMPT box: engine toggles, mode, combine, and the last result.
// The injection picker on a tab's Auto prompt section: name a Prompts-tab row and
// the slot its caption lands in, and the caption arrives there automatically at
// queue time, joined after the typed text. Empty means what it always meant: the
// caption only rides this tab's own output socket.
function injectRowUI(node, sect, tabName) {
  const cfg = node._rnCfg;
  const a = cfg.tabs[tabName]?.auto;
  if (!a) return;
  if (typeof a.inject_row !== "string") a.inject_row = "";
  const defSlot = { subject: "subject", scene: "surroundings",
                    moodboard: "light_and_colour", i2i: "subject" };
  if (!["subject", "surroundings", "light_and_colour", "prompt"]
      .includes(a.inject_slot)) {
    a.inject_slot = defSlot[tabName] || "subject";
  }
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = "Inject into";
  const rowSel = document.createElement("select");
  rowSel.className = "rn-ws-res";
  const names = (cfg.prompts?.rows || []).map((r, i) => r.name || `Prompt ${i + 1}`);
  for (const n of ["", ...names]) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n || "nothing (just the output)";
    o.selected = n === a.inject_row;
    rowSel.appendChild(o);
  }
  rowSel.title = "This tab's caption lands in the named prompt automatically when "
               + "the queue runs, joined after whatever is typed there. Leave it "
               + "empty and the caption only rides this tab's own output, as before.";
  rowSel.onchange = () => { a.inject_row = rowSel.value; writeCfg(node); };
  const slotSel = document.createElement("select");
  slotSel.className = "rn-ws-res";
  for (const [v, l] of [["subject", "As Subject"], ["surroundings", "As Surroundings"],
                        ["light_and_colour", "As Light and colour"],
                        ["prompt", "At the end"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    o.selected = v === a.inject_slot;
    slotSel.appendChild(o);
  }
  slotSel.title = "Which Frame slot the caption joins on a Krea 2 prompt. On a "
                + "plain prompt every choice appends to the text.";
  slotSel.onchange = () => { a.inject_slot = slotSel.value; writeCfg(node); };
  if (a.inject_pos !== "before") a.inject_pos = "after";
  const posSeg = segSwitch([
    ["before", "Before my words", "The caption goes ahead of what you typed in that slot."],
    ["after", "After my words", "The caption follows what you typed in that slot, as it "
                                + "always has."],
  ], a.inject_pos, (v) => { a.inject_pos = v; writeCfg(node); render(node); });
  posSeg.classList.add("rn-ws-injpos");
  row.style.flexWrap = "wrap";
  row.append(lab, rowSel, slotSel, posSeg);
  sect.appendChild(row);
}

// The engines an Auto prompt box can run, in list order.
// A one-line flow: chips joined by "+", an arrow, the join, an arrow, the result.
function flowRow(inputs, op, opIsLlm, out, emptyText) {
  const row = document.createElement("div");
  row.className = "rn-ws-flow";
  const add = (cls, text) => {
    const e = document.createElement("span");
    e.className = cls;
    e.textContent = text;
    row.appendChild(e);
  };
  if (!inputs.length) add("fc none", emptyText);
  inputs.forEach((t, i) => {
    if (i) add("sym", "+");
    add("fc", t);
  });
  add("sym", "→");
  add("op" + (opIsLlm ? " llm" : ""), op);
  add("sym", "→");
  add("out", out);
  return row;
}

// The engines an Auto prompt box can run, lightest first.
const AUTO_ENGINES = [["clipgen", "CLIP gen"], ["wd14", "WD14 tags"], ["florence", "Florence"],
                      ["ollama", "Ollama"], ["qwen", "QwenVL"], ["joy", "JoyCaption"]];

// A ROUGH VRAM figure per engine, for the list: what its model needs on the card while
// it captions. Weights plus a margin, from the model's size where one is known.
function engineVram(key, cfg) {
  const A = cfg.auto || {};
  const D = autoStatus.engine_defaults || {};
  const quantGb = (billions, quant) => (/4/.test(quant) ? billions * 0.7 + 1.5
    : /8/.test(quant) ? billions * 1.2 + 1.2 : billions * 2.1 + 1);
  if (key === "clipgen") return { gb: 0, text: "No extra" };
  if (key === "wd14") return { gb: 0.5, text: "~0.5 GB" };
  if (key === "florence") {
    const m = String(A.florence_model || (autoStatus.florence_models || [])[0] || "");
    const gb = /large/i.test(m) ? 1.6 : 0.6;
    return { gb, text: `~${gb} GB` };
  }
  if (key === "ollama") {
    const bytes = Number((autoStatus.ollama_sizes || {})[A.model] || 0);
    if (!bytes) return { gb: null, text: "Its own" };
    const gb = Math.round((bytes / 1e9 * 1.15 + 0.5) * 10) / 10;
    return { gb, text: `~${gb} GB` };
  }
  if (key === "qwen") {
    const b = Number((String(D.qwen_model || "").match(/(\d+(?:\.\d+)?)\s*B/i) || [])[1]);
    if (!b) return { gb: null, text: "Several GB" };
    const gb = Math.round(quantGb(b, String(D.qwen_quant || "")) * 10) / 10;
    return { gb, text: `~${gb} GB` };
  }
  if (key === "joy") {
    const gb = Math.round(quantGb(8, String(A.joy_quant || D.joy_quant || "")) * 10) / 10;
    return { gb, text: `~${gb} GB` };
  }
  return { gb: null, text: "" };
}

// THE AUTO PROMPT BOX: the engines as a list on the left, the picked engine's own
// settings beside it, the settings every engine shares under those, and the result
// at the bottom. It used to show every engine's settings at once, most of them for
// engines that were not even on. `flat` is the Img2Img sub-tab, where the tab itself
// is the fold.
function autoEntry(cfg, tabName) {
  const t = cfg.tabs[tabName];
  if (!t) return "";
  const idx = Array.isArray(t.sel) ? (t.sel[0] ?? 0) : t.sel;
  return (t.images || [])[idx] || "";
}

// A person's last caption: this session's, else the one saved beside the picture
const _personFetched = new Set();
function personCaption(node, entry) {
  const cached = node._rnPersonCaps?.[entry];
  if (cached !== undefined) return cached;
  if (!_personFetched.has(entry)) {
    _personFetched.add(entry);
    api.fetchApi(`/rednode/image_prompts?entry=${encodeURIComponent(entry)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const parts = Object.values(d?.parts || {});
        const text = parts.length ? String(parts[0]?.text || "") : "";
        if (text) {
          (node._rnPersonCaps ||= {})[entry] = text;
          render(node);
        }
      })
      .catch(() => {});
  }
  return "";
}

function autoSection(node, body, tabName, { flat = false } = {}) {
  if (!["subject", "scene", "moodboard", "i2i", "paint"].includes(tabName)) return;
  const cfg = node._rnCfg;
  const isPaint = tabName === "paint";
  const a = isPaint ? cfg.paint.auto : cfg.tabs[tabName].auto;
  const open = flat || !!(node._rnAutoOpen ||= {})[tabName];

  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-auto" + (flat ? " flat" : "");
  const head = document.createElement("div");
  head.className = "head";
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = open ? "▾" : "▸";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = isPaint
    ? "AUTO PROMPT"
    : "AUTO PROMPT" + (a.on ? ` (${a.mode.replace("_", " ")})` : "");
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (a.on ? " on" : "");
  on.title = isPaint
    ? a.on
      ? "On: caption the visible result and combine it before your Paint prompt, or "
        + "before the main prompt when the Paint box is empty."
      : "Off: results are not captioned automatically. Right-click still offers the "
        + "deliberate overwrite action."
    : a.on
      ? "This tab's selected image is captioned at queue time and rides the prompt outputs."
      : "Off: this tab's prompt output stays empty.";
  on.onclick = (e) => {
    e.stopPropagation();
    a.on = !a.on;
    if (isPaint && !a.on) {
      cfg.paint.auto_prompt = "";
      node._rnPaintAutoPending = null;
      if (node._rnAutoErrors) delete node._rnAutoErrors.paint;
    }
    writeCfg(node);
    render(node);
    // Turning it on should visibly do something now, not wait for another render.
    // The displayed history pick wins because that is the picture under the pointer.
    if (isPaint && a.on) {
      const visible = node._rnResultView || shownResult;
      if (visible) schedulePaintAutoPrompt(node, visible);
    }
  };
  if (flat) {
    arr.style.display = "none";
    head.style.cursor = "default";
    head.append(arr, on, ttl);
  } else {
    head.append(arr, on, ttl);        // toggle in front of the title, see the masks head
    head.onclick = (e) => {
      if (e.target === on) return;
      node._rnAutoOpen[tabName] = !open;
      render(node);
    };
  }
  sect.appendChild(head);

  // the Ollama model is the one every tab's captions use; a fresh config takes the first
  if (!cfg.auto.model && autoStatus.models?.length) cfg.auto.model = autoStatus.models[0];

  if (open) {
    const num = (label, key, min, max, step, hint) => {
      const w = document.createElement("label");
      w.className = "cellc";
      const t = document.createElement("span");
      t.textContent = label;
      t.title = hint;
      const i = document.createElement("input");
      i.type = "number";
      i.min = min; i.max = max; i.step = step;
      i.value = cfg.auto[key];
      i.title = hint;
      i.addEventListener("change", () => {
        const v = parseFloat(i.value);
        if (Number.isFinite(v)) { cfg.auto[key] = Math.max(min, Math.min(max, v)); writeCfg(node); }
      });
      w.append(t, i);
      return w;
    };
    const boolBtn = (label, key, hint) => {
      const w = document.createElement("label");
      w.className = "cellc";
      const t = document.createElement("span");
      t.textContent = label;
      t.title = hint;
      const b = document.createElement("button");
      b.className = "rn-ws-sw" + (cfg.auto[key] ? " on" : "");
      b.title = hint;
      b.onclick = () => { cfg.auto[key] = !cfg.auto[key]; writeCfg(node); render(node); };
      w.append(t, b);
      return w;
    };
    const pickSel = (label, key, options, hint, wide = false) => {
      const w = document.createElement("label");
      w.className = "cellc" + (wide ? " wide" : "");
      const t = document.createElement("span");
      t.textContent = label;
      t.title = hint;
      const sel = document.createElement("select");
      sel.className = "rn-ws-res";
      for (const [v, lab2] of options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = lab2;
        o.selected = (cfg.auto[key] ?? "") === v;
        sel.appendChild(o);
      }
      sel.title = hint;
      sel.onchange = () => { cfg.auto[key] = sel.value; writeCfg(node); };
      w.append(t, sel);
      return w;
    };
    const noteLine = (text) => {
      const n = document.createElement("div");
      n.className = "rn-ws-note";
      n.textContent = text;
      return n;
    };

    const avail = {
      ollama: [autoStatus.ollama, "Ollama is not reachable. Start it and reopen the workflow."],
      wd14: [autoStatus.wd14, "comfyui-wd14-tagger is not installed."],
      joy: [autoStatus.joy, "ComfyUI-JoyCaption is not installed."],
      qwen: [autoStatus.qwen, "ComfyUI-QwenVL is not installed."],
      florence: [autoStatus.florence, "comfyui-florence2 is not installed."],
      clipgen: [true, ""],
    };
    const props = (node.properties ||= {});
    let pick = node._rnAutoEngine || props.rn_auto_engine;
    if (!AUTO_ENGINES.some(([k]) => k === pick)) {
      pick = (AUTO_ENGINES.find(([k]) => a[k] && avail[k][0]) || AUTO_ENGINES[0])[0];
    }

    // each engine's own settings; the values are shared by every tab (cfg.auto)
    const engineSettings = (key) => {
      const g = document.createElement("div");
      g.className = "rn-ws-advgrid";
      if (!avail[key][0]) {
        g.appendChild(noteLine(avail[key][1]));
        return g;
      }
      if (key === "ollama") {
        const models = autoStatus.models || [];
        g.appendChild(pickSel("Model", "model", models.map((m) => [m, m]),
                              "The Ollama model used for every tab's captions.", true));
        g.append(
          num("Temperature", "temperature", 0, 2, 0.05, "Higher = looser wording. 0.2 is factual."),
          num("Seed", "seed", 0, 2147483647, 1, "0 = unseeded. A fixed seed pins the wording."),
          num("Context (num_ctx)", "num_ctx", 0, 131072, 256, "Context window. 0 = the model's default."),
          num("Max length (num_predict)", "num_predict", 0, 8192, 16, "Response length cap. 0 = default."),
          num("Top k", "top_k", 0, 200, 1, "0 = default."),
          num("Top p", "top_p", 0, 1, 0.01, "0 = default."),
          boolBtn("Think", "think", "Reasoning models think before answering: better reads, slower."),
          num("Keep alive s", "keep_alive", 0, 3600, 5,
              "How long Ollama keeps the model in RAM after a response. 0 unloads immediately (saves RAM, reloads next call); 300 keeps it warm."),
        );
        // THE INSTRUCTION: what Ollama is actually TOLD to write. Ollama alone reads
        // it; the local captioners answer worse when handed wording they were not
        // trained on, so they keep the mode's own. Wrapped because a panel that cannot
        // draw one settings row must still hand the prompt over.
      try {
        const cur = String(cfg.auto.instruction || "");
        const curQ = String(cfg.auto.question || "");
        const saved = instructionPrompts || {};
        const shipped = instructionBuiltin || [];
        const names = Object.keys(saved);
        // a preset is {system, question}; the first build of this saved a plain string,
        // and those still load, so a pick has to compare both halves either way
        const pair = (v) => (v && typeof v === "object")
          ? { system: String(v.system || ""), question: String(v.question || "") }
          : { system: String(v || ""), question: "" };
        const matched = names.find((n) => {
          const p = pair(saved[n]);
          return p.system.trim() === cur.trim() && p.question.trim() === curQ.trim();
        });

        const pick = document.createElement("label");
        pick.className = "cellc wide";
        const plab = document.createElement("span");
        plab.textContent = "Instruction";
        plab.title = "What Ollama is told to write about the image. Ollama only.";
        const isel = document.createElement("select");
        isel.className = "rn-ws-res";
        for (const [v, label] of [["", (cur || curQ) ? "custom (typed below)"
                                                    : "the mode's own wording"],
                                  ...names.map((n) => [n, shipped.includes(n) ? `${n} (pack)` : n])]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = label;
          o.selected = v === (matched || "");
          isel.appendChild(o);
        }
        isel.title = "Pick a saved instruction, or type your own below. The mode's own "
                   + "wording is what ships and what every existing workflow uses.";
        isel.onchange = () => {
          // "" hands both halves back to the defaults, the honest way to undo a pick
          const p = isel.value ? pair(saved[isel.value]) : { system: "", question: "" };
          cfg.auto.instruction = p.system;
          cfg.auto.question = p.question;
          writeCfg(node);
          render(node);
        };
        pick.append(plab, isel);

        const wrap = document.createElement("label");
        wrap.className = "cellc wide";
        const wlab = document.createElement("span");
        wlab.textContent = "System";
        const ibox = document.createElement("textarea");
        ibox.className = "rn-ws-vsp";
        ibox.style.cssText = "min-height:56px";
        ibox.value = cur;
        ibox.placeholder = "Leave empty to use the mode's own wording";
        ibox.title = "The system prompt: what Ollama is told to BE. Replaces the mode's "
                   + "wording, for Ollama only. The mode still decides the cache key and "
                   + "whether the frank clause is added, so switching modes with your "
                   + "own wording set is never silent.";
        ibox.oninput = () => {
          cfg.auto.instruction = ibox.value.slice(0, 4000);
          writeCfg(node);
        };
        wrap.append(wlab, ibox);

        // the OTHER half of the same call. A system prompt on its own only half works:
        // plenty of vision models take their orders from the question and skim the
        // system prompt, so both have to be reachable or the setting lies on some models.
        const qwrap = document.createElement("label");
        qwrap.className = "cellc wide";
        const qlab = document.createElement("span");
        qlab.textContent = "Question";
        const qbox = document.createElement("textarea");
        qbox.className = "rn-ws-vsp";
        qbox.style.cssText = "min-height:38px";
        qbox.value = curQ;
        qbox.placeholder = DEFAULT_QUESTION;
        qbox.title = "The user message: what Ollama is ASKED, alongside the image. "
                   + `Empty sends "${DEFAULT_QUESTION}", which is what every existing `
                   + "workflow has been sending.";
        qbox.oninput = () => {
          cfg.auto.question = qbox.value.slice(0, 1000);
          writeCfg(node);
        };
        qwrap.append(qlab, qbox);

        const brow = document.createElement("label");
        brow.className = "cellc wide";
        const blab = document.createElement("span");
        blab.textContent = "Saved";
        const bwrap = document.createElement("div");
        bwrap.style.cssText = "display:flex;gap:5px";

        const post = async (body, fail) => {
          try {
            const res = await api.fetchApi("/rednode/caption_instructions", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
            instructionPrompts = d.prompts || {};
            instructionBuiltin = d.builtin || [];
            render(node);
          } catch (e) {
            alert(`${fail}: ${e.message}`);
          }
        };

        const save = document.createElement("button");
        save.className = "rn-ws-btn rn-ws-compact";
        save.style.cssText = "flex:1 1 0;padding:0 10px";
        save.textContent = "Save as...";
        // either half alone is a usable preset: some models only need the question changed
        save.disabled = !cur.trim() && !curQ.trim();
        save.title = (cur.trim() || curQ.trim())
          ? "Keep this wording and question under a name, for every workflow."
          : "Type an instruction or a question first.";
        save.onclick = () => {
          const name = window.prompt("Name this instruction");
          if (name) {
            post({ action: "save", name, text: ibox.value, question: qbox.value },
                 "Could not save it");
          }
        };

        const del = document.createElement("button");
        del.className = "rn-ws-btn rn-ws-compact";
        del.style.cssText = "flex:1 1 0;padding:0 10px";
        del.textContent = "Delete";
        del.disabled = !matched || shipped.includes(matched);
        del.title = !matched ? "Pick a saved instruction to delete."
                  : shipped.includes(matched)
                    ? "Instructions that ship with the pack cannot be deleted."
                    : `Delete "${matched}".`;
        del.onclick = () => post({ action: "delete", name: matched }, "Could not delete it");

        bwrap.append(save, del);
        brow.append(blab, bwrap);
        g.append(pick, wrap, qwrap, brow);
      } catch (e) {
        console.error("[RedNode] the instruction row could not be drawn", e);
      }

      } else if (key === "wd14") {
        if (autoStatus.wd14_models?.length) {
          g.appendChild(pickSel("Model", "wd14_model",
                                autoStatus.wd14_models.map((m) => [m, m]),
                                "Which WD14 tagger model runs.", true));
          const sel = g.lastChild.querySelector("select");
          if (sel && !cfg.auto.wd14_model) sel.value = autoStatus.wd14_model || sel.value;
        }
        g.append(
          num("Threshold", "threshold", 0, 1, 0.01, "General tag confidence floor."),
          num("Character thr", "character_threshold", 0, 1, 0.01, "Character tag confidence floor."),
          boolBtn("Underscores → spaces", "replace_underscore", "Replace underscores with spaces in tags."),
          boolBtn("Unload after run", "wd14_unload",
                  "Drop the tagger's model from RAM after each run. Off keeps it loaded for speed."),
        );
        const ex = document.createElement("label");
        ex.className = "cellc wide";
        const ext = document.createElement("span");
        ext.textContent = "Exclude tags";
        const exi = document.createElement("input");
        exi.type = "text";
        exi.value = cfg.auto.exclude_tags;
        exi.placeholder = "Comma separated";
        exi.title = "Tags the tagger must never emit, on top of the mode filters.";
        exi.addEventListener("change", () => { cfg.auto.exclude_tags = exi.value; writeCfg(node); });
        ex.append(ext, exi);
        g.appendChild(ex);
      } else if (key === "joy") {
        const packOpts = autoStatus.joy_options || {};
        const withDefault = (list) => [["", "pack default"], ...(list || []).map((x) => [x, x])];
        g.append(
          pickSel("Quantization", "joy_quant", withDefault(packOpts.quantization),
                  "Speed against quality; 8-bit suits most cards."),
          pickSel("Caption length", "joy_length", withDefault(packOpts.caption_length),
                  "How long JoyCaption's paragraph runs."),
          pickSel("Memory", "joy_memory",
                  [["auto", "Auto (RAM setting)"], ["Keep in Memory", "Keep in Memory"],
                   ["Clear After Run", "Clear After Run"], ["Global Cache", "Global Cache"]],
                  "Auto follows the unload-after-run setting. Global Cache is fastest and "
                  + "hungriest."),
          pickSel("Prompt style", "joy_style", withDefault(packOpts.prompt_style),
                  "Only used when mode prompts are OFF."),
          boolBtn("Mode prompts", "joy_mode_prompts",
                  "On: this panel's per-tab prompts steer JoyCaption (scene stays "
                  + "anonymous, style stays subject-free). Off: the pack's own prompt "
                  + "style takes over."),
        );
      } else if (key === "florence") {
        // one model folder and one task, shared by every tab that switches it on
        g.append(
          pickSel("Model", "florence_model",
                  [["", "First folder found"], ...(autoStatus.florence_models || []).map((x) => [x, x])],
                  "Which Florence-2 folder in models/LLM captions. The PromptGen builds "
                  + "write prompt-shaped captions; base and large write plain descriptions."),
          pickSel("Task", "florence_task",
                  (autoStatus.florence_tasks || ["more_detailed_caption"]).map((x) => [x, x]),
                  "The pack's caption task. more_detailed_caption for a paragraph; the "
                  + "prompt_gen tasks want a PromptGen model."),
        );
      } else if (key === "qwen") {
        g.appendChild(noteLine("QwenVL runs its own model with the pack's settings; there "
                               + "is nothing to set here. It is heavy, and unloads per the "
                               + "RAM setting."));
      } else if (key === "clipgen") {
        g.appendChild(noteLine("Captions with the workflow's already-loaded text encoder, "
                               + "no extra model. Wire the studio's CLIP into the "
                               + "Workspace's clip input."));
      }
      return g;
    };

    // THE PEOPLE, on Subject: a row per picked person with a name, its own switch, a
    // Generate button and its caption; then the rewrite that merges them into the row
    if (tabName === "subject") {
      const S = cfg.tabs.subject;
      const meta = (S.people_meta ||= {});
      const order = S.images.length ? [S.sel, ...(S.extra_sel || [])] : [];
      const dc = document.createElement("div");
      dc.className = "rn-ws-card rn-ws-describe";
      const dh = document.createElement("div");
      dh.className = "ch";
      dh.textContent = "PEOPLE";
      dc.appendChild(dh);
      if (!order.length) {
        const n0 = document.createElement("div");
        n0.className = "rn-ws-note";
        n0.textContent = "No people picked yet. Pick them in the Gallery.";
        dc.appendChild(n0);
      }
      order.forEach((imgIdx, k) => {
        const entry = S.images[imgIdx];
        const m = (meta[entry] ||= {});
        const on = m.auto === undefined ? k === 0 : !!m.auto;
        const row = document.createElement("div");
        row.className = "rn-ws-person" + (on ? "" : " off");
        row.dataset.person = String(k);
        const im = document.createElement("img");
        im.src = thumbUrl(entry, 120);
        im.alt = "";
        im.title = entry;
        const pb = document.createElement("div");
        pb.className = "pb";
        const top = document.createElement("div");
        top.className = "top";
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = k ? `#${k + 1}` : "#1 Main";
        const nameIn = document.createElement("input");
        nameIn.type = "text";
        nameIn.value = m.name || "";
        nameIn.placeholder = `Person ${k + 1}`;
        nameIn.title = "A name for this person, used in the caption and by the rewrite, "
                     + "e.g. a character's name. Empty reads as Person " + (k + 1) + ".";
        nameIn.addEventListener("change", () => {
          m.name = nameIn.value.trim().slice(0, 40);
          writeCfg(node);
        });
        const sw = document.createElement("button");
        sw.className = "rn-ws-sw" + (on ? " on" : "");
        sw.title = on ? "This person is captioned at queue time. Click to leave them out."
                      : "Not captioned. Click to caption this person at queue time too.";
        sw.onclick = () => { m.auto = !on; writeCfg(node); render(node); };
        const capBtn = document.createElement("button");
        capBtn.className = "rn-ws-btn rn-ws-compact";
        capBtn.style.padding = "0 10px";
        const busy = node._rnAutoBusy === "subject:" + entry;
        capBtn.textContent = busy ? "Generating…" : "Generate";
        capBtn.disabled = !!node._rnAutoBusy;
        capBtn.title = "Caption this person now with the engines below, without a queue. The "
                  + "caption is saved beside the picture and reused by the next queue.";
        capBtn.onclick = async () => {
          try {
            node._rnAutoBusy = "subject:" + entry;
            render(node);
            const text = await runStandaloneAutoPrompt(node, "subject", entry, { keepTab: true });
            (node._rnPersonCaps ||= {})[entry] = text || "";
          } catch (e) {
            (node._rnPersonCaps ||= {})[entry] = `Could not caption: ${e.message}`;
          } finally {
            node._rnAutoBusy = null;
            render(node);
          }
        };
        top.append(tag, nameIn, sw, capBtn);
        const cap = document.createElement("div");
        cap.className = "cap";
        const text = personCaption(node, entry);
        cap.textContent = text || "No caption yet. Generate one, or queue a run.";
        if (text) {
          cap.style.cursor = "pointer";
          cap.title = "Click to copy.";
          cap.onclick = () => navigator.clipboard?.writeText?.(text);
        }
        pb.append(top, cap);
        row.append(im, pb);
        dc.appendChild(row);
      });
      sect.appendChild(dc);
    }

    // THE PICTURE, on the other gallery tabs: the one being captioned, with its own
    // Generate and its latest caption, the People card's row for a single picture
    if (tabName !== "subject" && !isPaint) {
      const entry = autoEntry(cfg, tabName);
      const pc = document.createElement("div");
      pc.className = "rn-ws-card rn-ws-picturecard";
      const ph = document.createElement("div");
      ph.className = "ch";
      ph.textContent = "PICTURE";
      pc.appendChild(ph);
      if (!entry) {
        const n0 = document.createElement("div");
        n0.className = "rn-ws-note";
        n0.textContent = "No picture picked yet. Pick one in the Gallery.";
        pc.appendChild(n0);
      } else {
        const row = document.createElement("div");
        row.className = "rn-ws-person";
        const im = document.createElement("img");
        im.src = thumbUrl(entry, 120);
        im.alt = "";
        im.title = entry;
        const pb = document.createElement("div");
        pb.className = "pb";
        const top = document.createElement("div");
        top.className = "top";
        const nm = document.createElement("span");
        nm.className = "tag";
        nm.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;"
                         + "white-space:nowrap;color:#e8ecf1";
        nm.textContent = parseName(entry).filename;
        const capBtn = document.createElement("button");
        capBtn.className = "rn-ws-btn rn-ws-compact rn-ws-piccap";
        capBtn.style.padding = "0 10px";
        const busy = node._rnAutoBusy === tabName + ":" + entry;
        capBtn.textContent = busy ? "Generating…" : "Generate";
        capBtn.disabled = !!node._rnAutoBusy;
        capBtn.title = "Caption this picture now with the engines below, without a queue. "
                     + "The caption is saved beside the picture and reused by the next queue.";
        capBtn.onclick = async () => {
          try {
            node._rnAutoBusy = tabName + ":" + entry;
            render(node);
            const text = await runStandaloneAutoPrompt(node, tabName, entry, { keepTab: true });
            (node._rnPersonCaps ||= {})[entry] = text || "";
          } catch (e) {
            (node._rnPersonCaps ||= {})[entry] = `Could not caption: ${e.message}`;
          } finally {
            node._rnAutoBusy = null;
            render(node);
          }
        };
        top.append(nm, capBtn);
        const cap = document.createElement("div");
        cap.className = "cap";
        const text = personCaption(node, entry);
        cap.textContent = text || "No caption yet. Generate one, or queue a run.";
        if (text) {
          cap.style.cursor = "pointer";
          cap.title = "Click to copy.";
          cap.onclick = () => navigator.clipboard?.writeText?.(text);
        }
        pb.append(top, cap);
        row.append(im, pb);
        pc.appendChild(row);
      }
      if (tabName === "scene") {
        // WHAT THE SCENE GIVES: the place, what is going on, or only the look
        const SCENE_READS = [
          ["scene_view", "Background", "The place: location, layout, light and camera. "
                                       + "People are left out, only 'a person'."],
          ["scene_action", "Situation", "What is happening: the activity, where the people "
                                        + "are and what they do. Nobody's looks are described."],
          ["scene_style", "Style", "Only the look: palette, lighting, texture and rendering."],
        ];
        const srow = document.createElement("div");
        srow.className = "rn-ws-row rn-ws-sceneread";
        srow.style.flexWrap = "wrap";
        const sl = document.createElement("span");
        sl.className = "rn-ws-swlabel";
        sl.textContent = "Take from the scene";
        const seg = segSwitch(SCENE_READS.map(([v, l, tip]) => [v, l, tip]),
          SCENE_READS.some(([v]) => v === a.mode) ? a.mode : "scene_view",
          (v) => { a.mode = v; writeCfg(node); render(node); });
        const sn = document.createElement("span");
        sn.className = "rn-ws-note";
        sn.style.flex = "1 1 200px";
        sn.textContent = (SCENE_READS.find(([v]) => v === a.mode) || SCENE_READS[0])[2];
        srow.append(sl, seg, sn);
        pc.appendChild(srow);
      }
      sect.appendChild(pc);
    }

    const cols = document.createElement("div");
    cols.className = "rn-ws-cols";
    const list = document.createElement("div");
    list.className = "rn-ws-elist l";
    for (const [key, label] of AUTO_ENGINES) {
      const ok = !!avail[key][0];
      const erow = document.createElement("div");
      erow.className = "rn-ws-erow" + (pick === key ? " cur" : "") + (ok ? "" : " dis");
      erow.dataset.engine = key;
      erow.title = `Show ${label}'s settings.`;
      const sw = document.createElement("button");
      sw.className = "rn-ws-sw" + (a[key] && ok ? " on" : "");
      sw.disabled = !ok;
      sw.title = !ok ? avail[key][1]
        : key === "clipgen"
          ? "Captions with the workflow's ALREADY-LOADED text encoder (zero extra "
            + "models). Wire the studio's CLIP into the workspace clip input."
          : `Use ${label} for this tab.`;
      sw.onclick = (e) => {
        e.stopPropagation();
        a[key] = !a[key];
        writeCfg(node);
        render(node);
      };
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = label;
      const st = document.createElement("span");
      st.className = "st";
      const est = engineVram(key, cfg);
      st.textContent = !ok ? (key === "ollama" ? "Not reachable" : "Not installed") : est.text;
      if (ok && est.text) {
        st.title = key === "ollama"
          ? "Roughly what the picked Ollama model needs, loaded in Ollama's own process."
          : "Roughly what this engine's model needs on the card while it captions.";
      }
      erow.append(sw, nm, st);
      erow.onclick = () => {
        node._rnAutoEngine = key;
        props.rn_auto_engine = key;
        render(node);
      };
      list.appendChild(erow);
    }
    // what the engines that are on need together
    {
      const on = AUTO_ENGINES.filter(([k]) => a[k] && avail[k][0]);
      const parts = on.map(([k]) => engineVram(k, cfg));
      const known = parts.filter((p) => p.gb !== null).reduce((s2, p) => s2 + p.gb, 0);
      const tot = document.createElement("div");
      tot.className = "rn-ws-erow rn-ws-etotal";
      tot.style.cursor = "default";
      const tl = document.createElement("span");
      tl.className = "nm";
      tl.textContent = on.length ? "On together" : "Nothing on";
      const tv = document.createElement("span");
      tv.className = "st";
      tv.textContent = !on.length ? ""
        : `~${Math.round(known * 10) / 10} GB` + (parts.some((p) => p.gb === null) ? " +" : "");
      tot.title = "A rough total for the engines switched on, on top of the main model "
                + "unless Low VRAM captioning is on. Engines run one after another, but "
                + "each stays loaded unless it is set to unload.";
      tot.append(tl, tv);
      list.appendChild(tot);
    }

    const right = document.createElement("div");
    right.className = "r";
    right.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";
    const ecard = document.createElement("div");
    ecard.className = "rn-ws-card rn-ws-engine";
    const eh = document.createElement("div");
    eh.className = "ch";
    const pickLabel = AUTO_ENGINES.find(([k]) => k === pick)[1];
    eh.textContent = (pick === "florence" ? "Florence-2" : pickLabel).toUpperCase();
    ecard.append(eh, engineSettings(pick));
    right.appendChild(ecard);

    // what every engine shares on this tab
    const shared = document.createElement("div");
    shared.className = "rn-ws-card rn-ws-shared";
    const sh = document.createElement("div");
    sh.className = "ch";
    sh.textContent = tabName === "subject" ? "STEP 1 · EACH PERSON'S CAPTION" : "EVERY ENGINE";
    shared.appendChild(sh);
    {
      const onNames = AUTO_ENGINES.filter(([k]) => a[k] && avail[k][0]).map(([, l]) => l);
      const blendOk = a.combine === "blend" && a.ollama && autoStatus.ollama;
      shared.appendChild(flowRow(
        onNames,
        blendOk ? "Blend with Ollama" : "Append",
        blendOk,
        tabName === "subject" ? "One caption per person" : "This tab's caption",
        "No engine on"));
      const sn = document.createElement("div");
      sn.className = "rn-ws-note";
      sn.textContent = (tabName === "subject"
        ? "Generate, or a queue, runs every engine that is on over one person's picture. "
        : "A queue runs every engine that is on over this tab's picture. ")
        + (blendOk
          ? "Blend then has Ollama rewrite their words into one caption."
          : "Append keeps their words in order: the paragraphs, then the tag line.");
      shared.appendChild(sn);
    }
    const srow = document.createElement("div");
    srow.className = "rn-ws-row";
    srow.style.flexWrap = "wrap";
    const fixedBtn = segSwitch([
      ["reuse", "REUSE", "The same image keeps its prompt; the LLM does not re-run."],
      ["fresh", "FRESH", "The LLM re-runs on EVERY queue for fresh wording, and the whole "
                         + "graph downstream recomputes."],
    ], a.fixed ? "reuse" : "fresh",
    (v) => { a.fixed = v === "reuse"; writeCfg(node); render(node); });
    const frank = boolBtn("Frank wording", "frank",
                          "Appends a clause telling every engine to describe nudity and sexual "
                          + "content plainly, without euphemism. Off ships the neutral prompts.");
    frank.className = "rn-ws-swlabel";
    frank.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto";
    srow.append(fixedBtn, frank);
    shared.appendChild(srow);
    const lowRow = boolBtn("Low VRAM captioning", "low_vram",
                           "On: the main model is unloaded before the engines caption, and "
                           + "every engine is unloaded before the sampler loads the model "
                           + "again. Slower, since the model reloads each run, but the "
                           + "captioners and the model never share the card. For smaller "
                           + "cards. Shared by every tab.");
    lowRow.className = "rn-ws-swlabel";
    lowRow.style.cssText = "display:flex;align-items:center;gap:6px";
    shared.appendChild(lowRow);

    if (tabName === "i2i" || isPaint) {
      const mrow = document.createElement("div");
      mrow.className = "rn-ws-row";
      const mlab = document.createElement("span");
      mlab.className = "rn-ws-note";
      mlab.textContent = "Transfer";
      const msel = document.createElement("select");
      msel.className = "rn-ws-res";
      for (const [v, label] of [["i2i", "Everything: people, place, framing"],
                                ["subject", "Subject only: the people, no scenery"],
                                ["scene_view", "Scene only: the place, people anonymous"]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        o.selected = a.mode === v;
        msel.appendChild(o);
      }
      msel.title = "What the source image donates to the prompt. Subject only drops the "
                 + "location and lighting story; scene only keeps the place and turns "
                 + "people into 'a person'.";
      msel.onchange = () => { a.mode = msel.value; writeCfg(node); render(node); };
      mrow.append(mlab, msel);
      shared.appendChild(mrow);
    }

    if (tabName === "moodboard") {
      const lrow = document.createElement("div");
      lrow.className = "rn-ws-row";
      const llab = document.createElement("span");
      llab.className = "rn-ws-note";
      llab.textContent = "Style lock";
      const lsel = document.createElement("select");
      lsel.className = "rn-ws-res";
      for (const [v, label] of [["off", "Off"],
                                ["scrub", "Scrub: strip conflicting style words"],
                                ["rewrite", "Rewrite: the loaded CLIP reworks them"]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        o.selected = cfg.auto.style_lock === v;
        lsel.appendChild(o);
      }
      lsel.title = "Makes THIS tab's prompt the style authority: style vocabulary in the "
                 + "subject and scene prompts that the mood prompt does not itself use is "
                 + "removed (scrub) or reworded (rewrite). Rewrite uses the loaded CLIP "
                 + "first (free, wire the clip input), Ollama as backup, the scrub as the "
                 + "floor. A photo source can no longer drag photorealistic wording into "
                 + "an anime moodboard.";
      lsel.onchange = () => { cfg.auto.style_lock = lsel.value; writeCfg(node); };
      lrow.append(llab, lsel);
      shared.appendChild(lrow);
    }

    const crow = document.createElement("div");
    crow.className = "rn-ws-row";
    crow.style.flexWrap = "wrap";
    const clab = document.createElement("span");
    clab.className = "rn-ws-note";
    clab.textContent = "Combine";
    const csel = document.createElement("select");
    csel.className = "rn-ws-res";
    for (const [v, label] of [["append", "Append: paragraph, then tag line"],
                              ["blend", "Blend: Ollama rewrites them into one"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      o.selected = a.combine === v;
      csel.appendChild(o);
    }
    csel.title = "Append keeps every engine's words as they came. Blend costs one more "
               + "Ollama pass and rewords everything into one prompt; only Ollama can do "
               + "that, so its engine has to be on for this tab.";
    csel.onchange = () => { a.combine = csel.value; writeCfg(node); render(node); };
    const llab = document.createElement("span");
    llab.className = "rn-ws-note";
    llab.textContent = "Length";
    const lsel = document.createElement("select");
    lsel.className = "rn-ws-res";
    for (const [v, label] of [[0, "Free"], [40, "Tight (about 40 words)"],
                              [75, "Medium (about 75 words)"],
                              [120, "Long (about 120 words)"]]) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = label;
      o.selected = (a.length || 0) === v;
      lsel.appendChild(o);
    }
    lsel.title = "A word budget for the finished prompt. Blend gets the budget written "
               + "into its rewrite instruction; append trims at a sentence break. Long "
               + "prompts overpower the mood, so tight keeps the mood in charge.";
    lsel.onchange = () => { a.length = parseInt(lsel.value, 10) || 0; writeCfg(node); };
    crow.append(clab, csel, llab, lsel);
    shared.appendChild(crow);
    if (a.combine === "blend" && !(a.ollama && autoStatus.ollama)) {
      const bw = document.createElement("div");
      bw.className = "rn-ws-note rn-ws-peoplewarn";
      bw.textContent = "Blend is a rewrite by Ollama: switch the Ollama engine on for this "
                     + "tab, or the captions are appended as they are.";
      shared.appendChild(bw);
    }

    // where the result goes is a choice too, so it lives with the others
    if (!isPaint) injectRowUI(node, shared, tabName);

    cols.append(list, right);
    sect.appendChild(cols);
    // its own box under the list, so picking an engine never moves it
    sect.appendChild(shared);

    // THE RESULT: what came back, what was saved before, and where it lands
    const res = document.createElement("div");
    res.className = "rn-ws-card rn-ws-resultcard";
    const rh = document.createElement("div");
    rh.className = "ch";
    rh.textContent = tabName === "subject" ? "STEP 2 · ALL PEOPLE TOGETHER" : "RESULT";
    res.appendChild(rh);
    if (tabName === "subject") {
      const S2 = cfg.tabs.subject;
      const meta2 = S2.people_meta || {};
      const order2 = S2.images.length ? [S2.sel, ...(S2.extra_sel || [])] : [];
      const onPeople = order2.map((idx, k) => {
        const m = meta2[S2.images[idx]] || {};
        const on = m.auto === undefined ? k === 0 : !!m.auto;
        return on ? (m.name || `Person ${k + 1}`) : null;
      }).filter(Boolean);
      const target = a.inject_row ? `Into ${a.inject_row}` : "The subject prompt";
      res.appendChild(flowRow(
        onPeople,
        a.rewrite ? "Rewrite with Ollama" : "Joined by name",
        !!a.rewrite,
        target,
        "No one switched on"));
      const rn = document.createElement("div");
      rn.className = "rn-ws-note";
      rn.textContent = a.rewrite
        ? "Ollama merges the prompt row with every person's caption, using the names, "
          + "once, and the queue reuses it. Preview rewrite shows it now."
        : "Each person's caption goes in under their name, one line each. Turn Rewrite "
          + "on to have Ollama weave them into the prompt row instead.";
      res.appendChild(rn);
      const rw = boolBtn("Rewrite into the prompt with these names", "rewrite", "");
      // a per-tab switch, not a shared one: bind it to this tab's auto settings
      const rwSw = rw.querySelector ? rw.querySelector(".rn-ws-sw") : rw.children[1];
      rwSw.className = "rn-ws-sw" + (a.rewrite ? " on" : "");
      rwSw.title = "On: at queue time Ollama merges the prompt row named in Inject into "
                 + "with these people's captions, using their names. It runs once and is "
                 + "reused; Fresh runs it every queue. Off: the captions are joined into "
                 + "the row as they are.";
      rwSw.onclick = () => { a.rewrite = !a.rewrite; writeCfg(node); render(node); };
      rw.className = "rn-ws-swlabel";
      rw.style.cssText = "display:flex;align-items:center;gap:6px";
      res.appendChild(rw);
      if (a.rewrite && !a.inject_row) {
        const wn = document.createElement("div");
        wn.className = "rn-ws-note rn-ws-peoplewarn";
        wn.textContent = "Pick a prompt row under Inject into, in step 1, for the "
                       + "rewrite to work on.";
        res.appendChild(wn);
      }
    }
    const last = node._rnPrompts?.[tabName];
    const autoError = node._rnAutoErrors?.[tabName];
    // ON SUBJECT, A PREVIEW BEFORE ANY QUEUE: the switched-on people's captions joined
    // the way the queue joins them, and the rewrite when one has been asked for
    let people = [];
    let joined = "";
    if (tabName === "subject") {
      const S = cfg.tabs.subject;
      const meta = S.people_meta || {};
      const order = S.images.length ? [S.sel, ...(S.extra_sel || [])] : [];
      people = order.map((idx, k) => {
        const e = S.images[idx];
        const m = meta[e] || {};
        const on = m.auto === undefined ? k === 0 : !!m.auto;
        return { k, named: !!m.name, name: m.name || `Person ${k + 1}`, on,
                 cap: node._rnPersonCaps?.[e] || "" };
      }).filter((p) => p.on && p.cap);
      joined = people.length === 1 && people[0].k === 0 && !people[0].named
        ? people[0].cap
        : people.map((p) => `${p.name}: ${p.cap}`).join("\n");
    }
    const rwPrev = tabName === "subject" ? node._rnRewritePreview : null;
    const shown = rwPrev || last || joined;
    const prev = document.createElement("div");
    prev.className = "rn-ws-note rn-ws-result";
    prev.textContent = node._rnAutoBusy === tabName || node._rnAutoBusy === "rewrite"
      ? (node._rnAutoBusy === "rewrite" ? "asking Ollama for the rewrite..."
                                        : "generating the auto prompt...")
      : autoError ? `automatic prompt failed: ${autoError}`
      : rwPrev ? rwPrev
      : last ? last
      : joined ? joined
      : isPaint
        ? "no prompt generated yet; right-click a result"
        : "no prompt generated yet; queue a run, or right-click a thumbnail";
    if (!node._rnAutoBusy && (rwPrev || (!last && joined))) {
      const lab = document.createElement("div");
      lab.className = "rn-ws-note";
      lab.style.fontWeight = "600";
      lab.textContent = rwPrev
        ? `Rewrite preview${a.inject_row ? ` for ${a.inject_row}` : ""}: the next queue uses this`
        : "Preview from the captions above: the next queue sends this";
      res.appendChild(lab);
    }
    prev.title = shown ? "Click to copy." : "";
    if (shown) {
      prev.style.cursor = "pointer";
      prev.onclick = () => navigator.clipboard?.writeText?.(shown);
    }
    res.appendChild(prev);
    // What this picture has been called before. A session that has just opened
     // knows nothing, but the captions were written beside the image at the time,
     // so they can simply be read back. Nothing is regenerated and nothing is
     // overwritten by looking.
    const recall = document.createElement("button");
    recall.className = "rn-ws-btn rn-ws-bigbtn";
    recall.style.width = "auto";
    recall.style.padding = "0 10px";
    recall.textContent = "Saved prompts";
    recall.title = "Show what this image has already been described as. Reads the "
                 + "caption saved beside the file; it runs nothing and changes nothing.";
    if (isPaint) {
      // Output and temp results are intentionally captioned in place. They have no
      // managed sidecar to read after a restart, so a recall button would promise
      // persistence the result does not have.
      recall.disabled = true;
      recall.title = "Paint result prompts are kept in this panel session. The last "
                   + "one is shown below.";
    } else {
      recall.onclick = async () => {
        const entry = autoEntry(cfg, tabName);
        if (!entry) { alert("Pick an image on this tab first."); return; }
        try {
          const res = await api.fetchApi(
            `/rednode/image_prompts?entry=${encodeURIComponent(entry)}`);
          const d = await res.json();
          if (d.error) throw new Error(d.error);
          const parts = Object.entries(d.parts || {});
          if (!parts.length) {
            node._rnSaved = d.managed === false
              ? "That image lives outside the managed folder, so nothing was saved "
                + "beside it. Images added through this panel keep their captions."
              : "Nothing saved for this image yet.";
          } else {
            node._rnSaved = parts
              .map(([eng, v]) => `${eng}${v.mode ? ` (${v.mode})` : ""}: ${v.text}`)
              .join("\n\n") + (d.updated ? `\n\nsaved ${d.updated}` : "");
          }
        } catch (e) {
          console.error("[RedNode Workspace] could not read the saved prompts:", e);
          node._rnSaved = `Could not read them: ${e.message}`;
        }
        render(node);
      };
    }
    const rrow = document.createElement("div");
    rrow.className = "rn-ws-row";
    rrow.style.flexWrap = "wrap";
    rrow.appendChild(recall);
    if (tabName === "subject" && a.rewrite) {
      // the rewrite, asked now: same merge, same cache, so the queue reuses the answer
      const rowText = (cfg.prompts?.rows || []).find((r, i) =>
        (r.name || `Prompt ${i + 1}`) === a.inject_row)?.text || "";
      const pv = document.createElement("button");
      pv.className = "rn-ws-btn rn-ws-rwprev rn-ws-bigbtn";
      pv.style.cssText = "width:auto;padding:0 10px";
      pv.textContent = rwPrev ? "Rewrite again" : "Preview rewrite";
      pv.disabled = !!node._rnAutoBusy || !a.inject_row || !people.length;
      pv.title = !a.inject_row ? "Pick a prompt row under Inject into first."
        : !people.length ? "Caption at least one switched-on person first (Generate)."
        : "Ask Ollama now to merge " + (a.inject_row) + " with these people, and show it "
          + "here. The queue reuses this answer while the text and people stay the same.";
      pv.onclick = async () => {
        node._rnAutoBusy = "rewrite";
        render(node);
        try {
          const r = await api.fetchApi("/rednode/people_rewrite", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: rowText, people: people.map((p) => [p.name, p.cap]),
              config: findWidget(node, "config")?.value ?? "{}",
              fresh: !!rwPrev || !a.fixed,
            }),
          });
          const d = await r.json();
          node._rnRewritePreview = d.text || `Could not rewrite: ${d.error || r.status}`;
        } catch (e) {
          node._rnRewritePreview = `Could not rewrite: ${e.message}`;
        } finally {
          node._rnAutoBusy = null;
          render(node);
        }
      };
      rrow.appendChild(pv);
    }
    if (tabName === "subject" && rwPrev) {
      const cl = document.createElement("button");
      cl.className = "rn-ws-btn";
      cl.style.cssText = "width:auto;padding:0 10px";
      cl.className = "rn-ws-btn rn-ws-bigbtn";
      cl.textContent = "Clear preview";
      cl.onclick = () => { node._rnRewritePreview = null; render(node); };
      rrow.appendChild(cl);
    }
    if (!isPaint && node._rnSaved) {
      const clr = document.createElement("button");
      clr.className = "rn-ws-btn";
      clr.style.width = "auto";
      clr.style.padding = "0 10px";
      clr.textContent = "Hide";
      clr.onclick = () => { node._rnSaved = null; render(node); };
      rrow.appendChild(clr);
    }
    res.appendChild(rrow);
    if (!isPaint && node._rnSaved) {
      const box = document.createElement("div");
      box.className = "rn-ws-note";
      box.style.whiteSpace = "pre-wrap";
      box.textContent = node._rnSaved;
      box.title = "Click to copy.";
      box.style.cursor = "pointer";
      box.onclick = () => navigator.clipboard?.writeText?.(node._rnSaved);
      res.appendChild(box);
    }

    sect.appendChild(res);
  }
  body.appendChild(sect);
}

// VRAM feedback that follows the VALUE, because the dials cost memory differently:
// the fidelity dials are a THRESHOLD (exactly 1.0 builds nothing; anything else builds
// the full matrix, whose size comes from resolution, not from how far the dial goes),
// while the px dials scale continuously with the square of their value.
function vramState(d, v) {
  const MATRIX_TIP = "Exactly 1.0 builds no bias matrix at all. ANY other value builds "
    + "the full matrix; its size comes from the resolution, not from how far this goes. "
    + "On 8 to 12 GB cards, use Boosts off or keep resize at 1024.";
  if (d.key === "reference_fidelity" || d.key === "scene_fidelity") {
    return Number(v) === 1.0
      ? { cls: "off", label: "VRAM off", tip: "At exactly 1.0 this is free: " + MATRIX_TIP }
      : { cls: "high", label: "VRAM high", tip: "The matrix is being built: " + MATRIX_TIP };
  }
  if (d.key === "isolate_refs") {
    return v
      ? { cls: "high", label: "VRAM high", tip: "Isolation builds the same full-size bias matrix." }
      : { cls: "off", label: "VRAM off", tip: "Off costs nothing. On builds the full-size bias matrix." };
  }
  const tiers = (val, low, med) => (val <= low
    ? { cls: "low", label: "VRAM low" } : val <= med
    ? { cls: "med", label: "VRAM med" } : { cls: "high", label: "VRAM high" });
  const PX_TIP = "Vision tokens grow with the SQUARE of this: doubling it costs about "
    + "four times the memory and encode time.";
  if (d.key === "likeness_vs_obedience") return { ...tiers(v, 640, 1024), tip: PX_TIP };
  if (d.key === "subject_likeness_px") {
    return Number(v) === 0
      ? { cls: "off", label: "VRAM off", tip: "0 follows Likeness vs obedience; no separate cost." }
      : { ...tiers(v, 640, 1024), tip: PX_TIP };
  }
  if (d.key === "style_detail_px") return { ...tiers(v, 384, 768), tip: PX_TIP + " Applies per moodboard ref." };
  return { cls: d.vram, label: "VRAM", tip: "" };
}

// The Post tab. The chain runs in grading order on RedNode Post Process at the end
// of the graph, not here: post processing happens after the sampler. Every effect is
// an independent implementation of a standard image operation (see postprocess.py).


// The post panel is shared with the standalone RedNode Post Process node, which
// owns a different config widget and redraws only itself. Both hooks default to
// the workspace's own.
export const postWrite = (node) => {
  mirrorChain(node._rnCfg);                           // the per-effect blocks follow the chain
  return (node._rnPostWrite || writeCfg)(node);
};
export const postRender = (node) => (node._rnPostRender || render)(node);















// The LoRAs tab hosts the LoRA Stack's own panel, so there is one implementation of
// slots, groups, random ranges and presets. The stack lives in this node's config
// instead of a stack_json widget, which is all the two hooks below are for.
// The stack presets the LoRA Stack node saves. On its own node the preset WIDGET
// loads them; the tab has no such widget, so it needs its own picker or saved
// stacks are write-only from here.
let loraPresetNames = [];
async function refreshLoraPresets() {
  try {
    const res = await api.fetchApi("/rednode/lora_presets");
    const d = await res.json();
    loraPresetNames = Array.isArray(d.presets) ? d.presets : [];
  } catch (e) { loraPresetNames = []; }
}

async function loraPresetAction(node, body) {
  const res = await api.fetchApi("/rednode/lora_presets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  loraPresetNames = d.presets || [];
  render(node);
}


// ---- LoRA SETS. The LoRAs tab is Main plus any number of named sets, each a
// whole stack of its own, each its own tab up there ( 
// "each set of the LoRAs in its own tab"). Rigs (Models tab), Detailer passes
// and the paint pass name the set they run with, so image-to-image,
// from-scratch, camera work and different models keep their own LoRAs. The
// server mirrors this in workspace.py (lora_set_cfg / rig_lora_set).
const MAIN_SET = "Main";
function loraSetNames(cfg) {
  return [MAIN_SET, ...((cfg?.lora_sets || []).map((st) => st.name).filter(Boolean))];
}
// a <select> of the sets. emptyLabel: what "" means for this picker (Main for
// a rig, the rig's own set for a pass).
function loraSetSelect(node, cfg, get, set, emptyLabel, tip) {
  const sel = document.createElement("select");
  sel.className = "rn-ws-select";
  const cur = String(get() || "");
  const names = loraSetNames(cfg);
  const opts = [["", emptyLabel], ...names.filter((n) => n !== MAIN_SET || emptyLabel !== MAIN_SET)
                                          .map((n) => [n, n])];
  if (cur && !names.includes(cur)) opts.push([cur, cur + " (missing)"]);
  for (const [v, l] of opts) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l; o.selected = v === cur;
    sel.appendChild(o);
  }
  sel.title = tip;
  sel.onchange = () => { set(sel.value); writeCfg(node); render(node); };
  return sel;
}

function loraPresetRow(node, body, stack = null) {
  // One shared store on disk, whichever stack this row serves: a stack saved from
  // the main tab, the paint tab or the LoRA Stack node appears in all three lists.
  // Pass the stack OBJECT for anything that is not the main tab's; the paint stacks
  // are per renderer, so a config key could not name one.
  const L = stack || node._rnCfg.loras;
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = "Stack preset";

  const sel = document.createElement("select");
  sel.className = "rn-ws-res";
  for (const name of [LORA_CUSTOM, ...loraPresetNames]) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    o.selected = name === LORA_CUSTOM;
    sel.appendChild(o);
  }
  sel.title = loraPresetNames.length
    ? "Load a stack saved from the LoRA Stack node or from here. Picking one REPLACES "
      + "the slots below, then drops back to custom, so what you see is always what "
      + "will run."
    : "No saved stacks yet. Build one below and save it.";
  sel.onchange = async () => {
    const name = sel.value;
    if (!name || name === LORA_CUSTOM) return;
    try {
      const r = await api.fetchApi(
        `/rednode/lora_presets?name=${encodeURIComponent(name)}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      L.slots = d.slots || [];
      L.ui = { ...(L.ui || {}), loaded_from: name, dirty: false };
      writeCfg(node);
      render(node);
    } catch (e) {
      console.error("[RedNode Workspace] could not load that stack:", e);
      alert(`Could not load "${name}": ${e.message}`);
    }
  };

  const save = document.createElement("button");
  save.className = "rn-ws-btn";
  save.style.width = "auto";
  save.style.padding = "0 10px";
  save.textContent = "Save stack";
  save.title = "Save the slots below under a name. It appears in this list and on the "
             + "LoRA Stack node too, since they share one store.";
  save.onclick = async () => {
    const name = prompt("Name this stack", L.ui?.loaded_from || "");
    if (!name) return;
    try {
      await loraPresetAction(node, { action: "save", name,
                                     slots: L.slots || [] });
      L.ui = { ...(L.ui || {}), loaded_from: name, dirty: false };
      writeCfg(node);
      render(node);
    } catch (e) {
      console.error("[RedNode Workspace] could not save that stack:", e);
      alert(`Could not save: ${e.message}`);
    }
  };

  const del = document.createElement("button");
  del.className = "rn-ws-btn";
  del.style.width = "auto";
  del.style.padding = "0 10px";
  del.textContent = "Delete";
  del.disabled = !loraPresetNames.length;
  del.title = loraPresetNames.length
    ? "Delete a saved stack. Pick it in the dropdown first."
    : "Nothing saved to delete.";
  del.onclick = async () => {
    const name = sel.value;
    if (!name || name === LORA_CUSTOM) {
      alert("Pick the stack you want to delete in the dropdown first.");
      return;
    }
    if (!confirm(`Delete the saved stack "${name}"?`)) return;
    try {
      await loraPresetAction(node, { action: "delete", name });
    } catch (e) {
      console.error("[RedNode Workspace] could not delete that stack:", e);
      alert(`Could not delete: ${e.message}`);
    }
  };

  row.append(lab, sel, save, del);
  body.appendChild(row);
  loraPresetRow._row = row;                 // callers may add to this line

  const from = L.ui?.loaded_from;
  if (from) {
    // the note says WHERE the slots came from and whether they were edited
    // since; it used to claim "edits are not saved back" right after a save,
    // which read as broken. The x forgets the link.
    const note = document.createElement("div");
    note.className = "rn-ws-row";
    note.style.cssText = "align-items:center;gap:8px";
    const txt = document.createElement("span");
    txt.className = "rn-ws-note";
    txt.textContent = L.ui?.dirty
      ? `Loaded from "${from}", edited since. Save stack writes it back under that name.`
      : `Loaded from "${from}".`;
    const x = document.createElement("button");
    x.className = "rn-ws-btn";
    x.style.cssText = "width:auto;padding:0 8px";
    x.textContent = "\u00d7";
    x.title = "Forget where these slots came from (the slots stay).";
    x.onclick = () => {
      L.ui = { ...(L.ui || {}) };
      delete L.ui.loaded_from; delete L.ui.dirty;
      writeCfg(node); render(node);
    };
    note.append(txt, x);
    body.appendChild(note);
  }
}

function lorasBody(node, body) {
  const cfg = node._rnCfg;
  // THE SET TABS: Main first, then every named set, then +. Which one is open
  // lives in node.properties (a workflow switch rebuilds the node). The picked
  // set is what the seed row, the preset row and the panel below edit.
  if (!Array.isArray(cfg.lora_sets)) cfg.lora_sets = [];
  if (node._rnLoraSet === undefined) node._rnLoraSet = String(node.properties?.rn_lora_set || "");
  let curName = node._rnLoraSet;
  if (curName && !cfg.lora_sets.some((st) => st.name === curName)) curName = "";
  const curSet = curName ? cfg.lora_sets.find((st) => st.name === curName) : null;
  const L = curSet || cfg.loras;
  {
    const tabs = document.createElement("div");
    tabs.className = "rn-ws-tabs";
    const mk = (name, label) => {
      const t = document.createElement("div");
      t.className = "rn-ws-tab g-model" + (name === curName ? " cur" : "");
      t.textContent = label;
      t.title = name ? "The set \"" + name + "\": its own stack. Double-click to rename."
                     : "Main: the first set. Rigs run with it unless they pick another.";
      t.onclick = () => {
        node._rnLoraSet = name; (node.properties ||= {}).rn_lora_set = name; render(node);
      };
      if (name) {
        t.ondblclick = () => {
          const nn = (prompt("Rename this set", name) || "").trim().slice(0, 48);
          if (!nn || nn === name) return;
          if (nn === MAIN_SET || cfg.lora_sets.some((st) => st.name === nn)) {
            alert("There is already a set called \"" + nn + "\"."); return;
          }
          const st = cfg.lora_sets.find((x) => x.name === name);
          if (st) st.name = nn;
          // every place that named the old set follows the rename
          for (const r of cfg.models?.rigs || []) if (r.lora_set === name) r.lora_set = nn;
          if (cfg.paint?.lora_set === name) cfg.paint.lora_set = nn;
          node._rnLoraSet = nn; (node.properties ||= {}).rn_lora_set = nn;
          writeCfg(node); render(node);
        };
      }
      tabs.appendChild(t);
      return t;
    };
    mk("", MAIN_SET);
    for (const st of cfg.lora_sets) mk(st.name, st.name);
    const add = document.createElement("div");
    add.className = "rn-ws-tab g-model";
    add.textContent = "+";
    add.title = "Add a set: another whole stack, on its own tab. Name it for what it is "
              + "for (Img2Img, Camera, Turbo...), then pick it on a rig, a Detailer pass "
              + "or the paint pass.";
    add.onclick = () => {
      let n = cfg.lora_sets.length + 2, name = "Set " + n;
      while (cfg.lora_sets.some((st) => st.name === name)) name = "Set " + (++n);
      const typed = (prompt("Name the new set", name) || "").trim().slice(0, 48);
      if (!typed) return;
      if (typed === MAIN_SET || cfg.lora_sets.some((st) => st.name === typed)) {
        alert("There is already a set called \"" + typed + "\"."); return;
      }
      cfg.lora_sets.push({ name: typed, slots: [], ui: {}, seed: 0 });
      node._rnLoraSet = typed; (node.properties ||= {}).rn_lora_set = typed;
      writeCfg(node); render(node);
    };
    tabs.appendChild(add);
    body.appendChild(tabs);
  }

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  if (!curSet) {
    const on = document.createElement("button");
    on.className = "rn-ws-sw" + (L.on ? " on" : "");
    on.title = L.on
      ? "The stack is applied to the model input and handed back on the model output."
      : "Off: the model passes through untouched.";
    on.onclick = () => { L.on = !L.on; writeCfg(node); render(node); };
    row.appendChild(on);
  }
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = curSet
    ? "The set \"" + curSet.name + "\". A rig picks it on the Models tab (LoRA set), a "
      + "Detailer pass on its card, the paint pass on its Paint LoRAs tab."
    : "Wire the model in and take it from the model output. Trigger words "
      + "come out on lora_keywords. Rigs render with Main unless they pick a set.";
  row.appendChild(hint);
  if (curSet) {
    const del = document.createElement("button");
    del.className = "rn-ws-btn";
    del.style.cssText = "width:auto;padding:0 10px;margin-left:auto";
    del.textContent = "Delete set";
    del.title = "Delete this set and its stack. Anything that picked it falls back to Main.";
    del.onclick = () => {
      if (!confirm("Delete the set \"" + curSet.name + "\" and its stack?")) return;
      cfg.lora_sets = cfg.lora_sets.filter((st) => st !== curSet);
      for (const r of cfg.models?.rigs || []) if (r.lora_set === curSet.name) r.lora_set = "";
      if (cfg.paint?.lora_set === curSet.name) cfg.paint.lora_set = "";
      node._rnLoraSet = ""; (node.properties ||= {}).rn_lora_set = "";
      writeCfg(node); render(node);
    };
    row.appendChild(del);
  }
  body.appendChild(row);

  loraPresetRow(node, body, L);
  {
    // SEED AND ADD RIDE THE PRESET LINE. The seed is
    // the Models tab's control in miniature: the number, and a dice that rolls
    // a new one. It stays a fixed number on purpose - a stack that re-rolls
    // its strengths behind you are not a stack you can compare against.
    const line = loraPresetRow._row;
    const slab = document.createElement("span");
    slab.className = "rn-ws-note";
    slab.style.marginLeft = "6px";
    slab.textContent = "Seed";
    const seed = document.createElement("input");
    seed.type = "number";
    seed.min = 0;
    seed.value = L.seed;
    seed.style.cssText = "width:104px;background:#101216;border:1px solid #2f333a;"
      + "border-radius:6px;color:#e8ecf1;font-size:13px;font-weight:600;padding:4px 8px";
    seed.title = "Drives any slot set to a random strength range. The same seed and "
               + "the same stack give the same strengths.";
    seed.addEventListener("change", () => {
      L.seed = Math.max(0, parseInt(seed.value, 10) || 0);
      writeCfg(node);
    });
    const dice = document.createElement("button");
    dice.className = "rn-ws-btn";
    dice.style.cssText = "width:auto;padding:0 9px";
    dice.textContent = "\uD83C\uDFB2";
    dice.title = "Roll a new seed for the random-strength slots.";
    dice.onclick = () => {
      L.seed = Math.floor(Math.random() * 2 ** 32);
      writeCfg(node); render(node);
    };
    const addTop = document.createElement("button");
    addTop.className = "rn-ws-btn";
    addTop.style.cssText = "width:auto;padding:0 10px;background:#1f9d55;color:#fff";
    addTop.textContent = "\uFF0B LoRA";
    addTop.title = "Add a slot without scrolling to the bottom of the stack.";
    addTop.onclick = () => {
      const slots = node._rnSlots || [];
      node._rnFocusSlot = slots.length;
      slots.push(LS_newSlot());
      LS_writeSlots(node);
      render(node);
    };
    line.append(slab, seed, dice, addTop);
  }

  // the shared panel reads and writes through these instead of a widget; the
  // accessors resolve the picked set at event time
  const pickSet = (n) => {
    const c = n._rnCfg;
    const nm = n._rnLoraSet || "";
    return (nm && (c.lora_sets || []).find((st) => st.name === nm)) || c.loras;
  };
  node._rnStackRead = (n) => { const S = pickSet(n || node); return { ui: S.ui, slots: S.slots }; };
  node._rnStackWrite = (n, v) => {
    const S = pickSet(n);
    const before = JSON.stringify(S.slots || []);
    S.ui = v.ui || {};
    S.slots = v.slots || [];
    if (S.ui.loaded_from && JSON.stringify(S.slots) !== before) S.ui.dirty = true;
    writeCfg(n);
  };
  node._rnSlots = L.slots;
  node._rnUI = L.ui;

  // THE STACK IN A BOX. The group cards were sitting straight on the panel's
  // background, which read as floating; everything else
  // on this panel lives in a bordered surface. min-height:0 with overflow on
  // the box is what lets a long stack scroll INSIDE it, which is also what
  // turns the footer into a floating bar exactly when it should be one.
  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:120px;"
    + "background:#16181c;border:1px solid #2a2e35;border-radius:8px;padding:8px;"
    + "overflow:auto";
  body.appendChild(box);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:1;min-height:0";
  box.appendChild(host);
  buildLoraPanel(node, host);
}

// The Paint LoRA tab: the paint pass's own stack, in the paint column. A separate
// stack, never a mirror of the main tab's: a paint pass is usually a low-denoise
// detail pass, which wants a detail LoRA and none of the style LoRAs that fight a
// subject reference. ONE stack, and the Stack preset row is how sets get swapped;
// tying stacks to the model choice was tried for a day and rolled back as confusing
// before the Models tab exists to make it render. The shared panel edits whichever
// stack the accessors point at, and the accessors are read at event time, so
// re-pointing them here is safe: only one host is ever on screen, and the main
// LoRAs tab re-points them back when it builds.
function paintLorasBody(node, body) {
  const cfg = node._rnCfg;
  const PL = cfg.paint_loras;

  // ONE choice, two settings, plain words: whose LoRAs does the paint pass render
  // with. Paint overrides Main for the paint pass and nothing else.
  const modes = [
    ["main", "Main LoRAs", "The paint pass renders with the main LoRAs tab's stack, "
                           + "the same as the rest of the workflow. The stack below "
                           + "does nothing. The default."],
    ["paint", "Paint LoRAs", "The stack below replaces the main LoRAs for the paint "
                             + "pass only. The rest of the workflow keeps the main "
                             + "tab's."],
  ];
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const seg = document.createElement("div");
  seg.className = "rn-ws-seg";
  for (const [value, label, tip] of modes) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    b.className = "rn-ws-segb" + (cfg.paint.lora_mode === value ? " on" : "");
    b.onclick = () => { cfg.paint.lora_mode = value; writeCfg(node); render(node); };
    seg.appendChild(b);
  }
  row.appendChild(seg);
  body.appendChild(row);

  const hint = document.createElement("div");
  hint.className = "rn-ws-note";
  hint.textContent = cfg.paint.lora_mode === "paint"
    ? "These LoRAs run instead of the main tab's when the paint pass renders. "
      + "Leave Paint Render's model input unwired and the rig arrives with this "
      + "stack by itself, or wire the paint_model output. Krea 2 only for now: an "
      + "external chain loads its own model and cannot hear this."
    : "The paint pass renders with a LoRAs-tab set: the rig's own by default. "
      + "Nothing to edit here; the stacks live on the LoRAs tab.";
  body.appendChild(hint);

  // WHAT WILL ACTUALLY RUN, in one line. The routing is three-way (paint stack,
  // the paint pass's own set, the rig's set) and until this line existed the
  // only way to find out was to read the console after a queue - which is how
  // "the painting is not carrying the correct LoRAs" felt like a bug when the
  // routing was right.
  {
    const rig = (cfg.models?.rigs || [])[cfg.models?.active || 0] || {};
    const setName = cfg.paint.lora_mode === "paint" ? null
      : (cfg.paint.lora_set || rig.lora_set || MAIN_SET);
    const stack = cfg.paint.lora_mode === "paint"
      ? (cfg.paint_loras.slots || [])
      : (setName === MAIN_SET ? (cfg.loras.slots || [])
         : ((cfg.lora_sets || []).find((x) => x.name === setName)?.slots || []));
    const n = stack.filter((x) => x && x.type !== "title" && x.name && x.name !== "None").length;
    const line = document.createElement("div");
    line.className = "rn-ws-note";
    line.style.cssText = "border-left:2px solid #b8283c;padding-left:7px";
    line.textContent = "The paint pass renders with: "
      + (cfg.paint.lora_mode === "paint"
          ? "the Paint LoRAs stack below"
          : "the LoRAs tab's \"" + setName + "\" set"
            + (cfg.paint.lora_set ? " (picked here)" : " (the rig's own choice)"))
      + " \u00b7 " + n + " LoRA" + (n === 1 ? "" : "s");
    line.title = "Read this before queueing: it is the stack that will be on the model "
               + "when the paint pass renders.";
    body.appendChild(line);
  }

  if (cfg.paint.lora_mode !== "paint") {
    // MAIN: blank on purpose,
    // apart from which LoRAs-tab set the paint pass runs with
    const srow = document.createElement("div");
    srow.className = "rn-ws-row";
    const sl = document.createElement("span");
    sl.className = "rn-ws-note";
    sl.textContent = "Set";
    if (typeof cfg.paint.lora_set !== "string") cfg.paint.lora_set = "";
    srow.append(sl, loraSetSelect(node, cfg, () => cfg.paint.lora_set,
                                  (v) => { cfg.paint.lora_set = v; }, "(rig's set)",
                                  "Which LoRAs-tab set the paint pass renders with. (rig's set) "
                                  + "follows the Models tab."));
    body.appendChild(srow);
    return;
  }

  const seedRow = document.createElement("div");
  seedRow.className = "rn-ws-row";
  const slab = document.createElement("span");
  slab.className = "rn-ws-note";
  slab.textContent = "Seed";
  const seed = document.createElement("input");
  seed.type = "number";
  seed.min = 0;
  seed.value = PL.seed;
  seed.style.cssText = "width:130px;background:#15171b;border:1px solid #33373d;"
                     + "border-radius:4px;color:#e8ecf1;font-size:12px;padding:4px 6px";
  seed.title = "Drives any slot set to a random strength range, separately from the "
             + "main stack's seed.";
  seed.addEventListener("change", () => {
    PL.seed = Math.max(0, parseInt(seed.value, 10) || 0);
    writeCfg(node);
  });
  seedRow.append(slab, seed);
  body.appendChild(seedRow);
  // the same saved stacks the main tab and the LoRA Stack node use: save a "Face
  // detailer" once, load it here, on the main tab, or on the node
  loraPresetRow(node, body, PL);

  node._rnStackRead = () => {
    const s = node._rnCfg.paint_loras;
    return { ui: s.ui, slots: s.slots };
  };
  node._rnStackWrite = (n, v) => {
    const s = n._rnCfg.paint_loras;
    const before = JSON.stringify(s.slots || []);
    s.ui = v.ui || {};
    s.slots = v.slots || [];
    if (s.ui.loaded_from && JSON.stringify(s.slots) !== before) s.ui.dirty = true;
    writeCfg(n);
  };
  node._rnSlots = PL.slots;
  node._rnUI = PL.ui;

  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:120px;"
    + "background:#16181c;border:1px solid #2a2e35;border-radius:8px;padding:8px;"
    + "overflow:auto";
  body.appendChild(box);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:1;min-height:0";
  box.appendChild(host);
  buildLoraPanel(node, host);
}

// A row at the top of Advanced for things that ACT rather than configure.
// THE WORKSPACE CARD on Advanced: the settings for the whole node that used to crowd
// the footer. Resize and the studio preset change renders; the workspace presets save
// and load the whole panel.
function workspaceCard(node, body) {
  const cfg = node._rnCfg;
  const card = document.createElement("div");
  card.className = "rn-ws-card rn-ws-wscard";
  const ch = document.createElement("div");
  ch.className = "ch";
  ch.textContent = "WORKSPACE";
  card.appendChild(ch);
  const line = (label, ctrls, help) => {
    const r = document.createElement("div");
    r.className = "rn-ws-row";
    r.style.flexWrap = "wrap";
    const l = document.createElement("span");
    l.className = "rn-ws-swlabel";
    l.style.cssText = "min-width:150px;font-weight:600;color:#c8ccd2";
    l.textContent = label;
    r.append(l, ...ctrls);
    const h = document.createElement("div");
    h.className = "rn-ws-note";
    h.textContent = help;
    card.append(r, h);
  };
  const resLab = document.createElement("span");
  resLab.className = "rn-ws-note";
  resLab.textContent = "Resize long edge";
  const res = document.createElement("select");
  res.className = "rn-ws-res";
  for (const [v, label] of [[1024, "1024 px"], [1536, "1536 px"], [0, "off (original size)"]]) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = label;
    o.selected = cfg.resize === v;
    res.appendChild(o);
  }
  res.title = "Small images scale up, huge ones scale down, aspect kept. Keeps the studio fast "
            + "whatever gets dropped in. VRAM note: 1536 costs about 2.25x the tokens of 1024, "
            + "and the fidelity dials' bias matrix grows with that squared. 8 to 12 GB cards "
            + "should stay at 1024.";
  res.onchange = () => { cfg.resize = parseInt(res.value, 10); writeCfg(node); };
  // the studio preset, drivable from here so the whole setup lives in one panel.
  // The list is mirrored from a Krea2RedNode in the graph (it knows the saved user
  // presets too); the fallback list covers a workspace placed before the studio.
  const presetLab = document.createElement("span");
  presetLab.className = "rn-ws-note";
  presetLab.textContent = "Studio preset";
  const psel = document.createElement("select");
  psel.className = "rn-ws-res";
  const studioNode = findNode("Krea2RedNode");
  const presetValues = studioNode?.widgets?.find((w) => w.name === "preset")?.options?.values
    || ["custom (use settings)", "Balanced", "Max identity", "Style only",
        "Outfit transfer", "Pose transfer", "Anime to real", "Real to anime"];
  for (const [v, label] of [["", "node's own"], ...presetValues.map((x) => [x, x])]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = cfg.studio_preset === v;
    psel.appendChild(o);
  }
  psel.title = "Overrides the studio node's preset through the bundle, announced in the "
             + "console. Pick 'custom (use settings)' to hand control to the dials. "
             + "'node's own' leaves the studio widget in charge.";
  psel.onchange = () => {
    cfg.studio_preset = psel.value;
    writeCfg(node);
    pushStudioPreset(node);                          // the studio dropdown follows visibly
  };

  line("Resize long edge", [res],
       "Every gallery picture is scaled so its long side matches, aspect kept. 1024 suits "
       + "most cards; 1536 costs about twice the VRAM.");
  line("Studio preset", [psel],
       "Hands the studio node a preset through the bundle. Node's own leaves its widget in "
       + "charge; custom (use settings) hands control to the dials.");
  // the workspace presets: the node's own preset widget, with save and delete beside it
  const pw = findWidget(node, "preset");
  const wsel = document.createElement("select");
  wsel.className = "rn-ws-res rn-ws-wspreset";
  for (const v of (pw?.options?.values || [CUSTOM_SENTINEL])) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v === CUSTOM_SENTINEL ? "Custom (live)" : v;
    o.selected = (pw?.value ?? CUSTOM_SENTINEL) === v;
    wsel.appendChild(o);
  }
  wsel.title = "Load a saved workspace: galleries, selections, masks and dials. Loading "
             + "replaces the whole panel.";
  wsel.onchange = () => {
    if (!pw) return;
    pw.value = wsel.value;
    pw.callback?.(wsel.value);
  };
  const saveAs = document.createElement("button");
  saveAs.className = "rn-ws-btn rn-ws-bigbtn";
  saveAs.textContent = "Save as";
  saveAs.title = "Save this whole workspace under a name, for this machine.";
  saveAs.onclick = async () => {
    const name = (window.prompt("Name this workspace preset") || "").trim();
    if (!name) return;
    try {
      const r = await api.fetchApi("/rednode/workspace_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, config: node._rnCfg }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      refreshPresetList(node, d.presets || []);
      render(node);
    } catch (e) { alert(`Could not save: ${e.message}`); }
  };
  const del = document.createElement("button");
  del.className = "rn-ws-btn rn-ws-bigbtn";
  del.textContent = "Delete";
  del.disabled = !pw || !pw.value || pw.value === CUSTOM_SENTINEL;
  del.title = del.disabled ? "Pick a saved preset first." : `Delete "${pw.value}".`;
  del.onclick = async () => {
    const name = pw?.value;
    if (!name || name === CUSTOM_SENTINEL) return;
    try {
      const r = await api.fetchApi("/rednode/workspace_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }),
      });
      const d = await r.json();
      refreshPresetList(node, d.presets || []);
      pw.value = CUSTOM_SENTINEL;
      render(node);
    } catch (e) { alert(`Could not delete: ${e.message}`); }
  };
  line("Workspace presets", [wsel, saveAs, del],
       "Save and load the whole panel. Presets store file names, so they belong to this "
       + "machine.");
  body.appendChild(card);
}

function advancedTools(node, body) {
  workspaceCard(node, body);
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const btn = document.createElement("button");
  btn.className = "rn-ws-btn";
  btn.style.width = "auto";
  btn.style.padding = "0 10px";
  btn.textContent = node._rnReleasing ? "Unloading..." : "Unload caption models";
  btn.title = "Hand back everything the auto prompt system is holding, right now: the "
            + "Ollama model, the WD14 tagger's sessions, and any JoyCaption or QwenVL "
            + "pipeline still cached. Useful before a big render when captioning has "
            + "left the card full.";
  btn.onclick = async () => {
    if (node._rnReleasing) return;
    node._rnReleasing = true;
    render(node);
    try {
      const res = await api.fetchApi("/rednode/release_engines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: node._rnCfg.auto?.model || "",
                               url: node._rnCfg.auto?.url || "" }),
      });
      const d = await res.json();
      console.log("[RedNode Workspace] released:", (d.done || []).join("; "));
      node._rnReleased = (d.done || []).length
        ? "Released. See the console for what went."
        : "Nothing was being held.";
    } catch (e) {
      console.error("[RedNode Workspace] could not release the engines:", e);
      node._rnReleased = `Could not release: ${e.message}`;
    } finally {
      node._rnReleasing = false;
      render(node);
    }
  };
  const note = document.createElement("span");
  note.className = "rn-ws-note";
  note.textContent = node._rnReleased
    || "Captioning holds its models between runs so the next one is fast.";
  row.append(btn, note);
  body.appendChild(row);
  workspacePrefs(node, body);
}

// ---- Workspace preferences, on the Advanced tab -----------------------------
// Display choices for THIS install: how the panel looks, never what a run renders.
// The values live in the settings store through wsPref/setWsPref rather than in the
// node's config, so a shared workflow cannot carry one person's arrangement into
// somebody else's panel. The controls sit here because this is where you go to
// change how the Workspace behaves; the storage is what makes that safe to share.
function workspacePrefs(node, body) {
  const sect = document.createElement("div");
  sect.className = "rn-ws-sect";
  const head = document.createElement("div");
  head.className = "head";
  head.style.cursor = "default";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = "WORKSPACE PREFERENCES (this install, not the workflow)";
  head.appendChild(ttl);
  sect.appendChild(head);

  // Paint layout: three explicit choices, stacked being exactly what always
  // happened. Automatic exists but is never imposed; that ordering was your
  // direct instruction after automatic UI guesses went wrong before.
  const lay = document.createElement("div");
  lay.className = "rn-ws-row";
  const layLab = document.createElement("span");
  layLab.className = "hint";
  layLab.style.cssText = "flex:none;width:110px";
  layLab.textContent = "Paint layout";
  const laySeg = document.createElement("div");
  laySeg.className = "rn-ws-seg";
  laySeg.style.flex = "0 0 auto";
  const now = String(wsPref("PaintLayout", "stacked"));
  for (const [id, label, why] of [
    ["stacked", "Stacked", "Paint above Result, the familiar arrangement."],
    ["side", "Side by side", "Always beside each other, however narrow the node."],
    ["auto", "Automatic", "Side by side when the node is wide enough, stacked when "
                        + "it is not."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (now === id ? " on" : "");
    b.dataset.layout = id;
    b.textContent = label;
    b.title = why;
    b.onclick = () => { setWsPref("PaintLayout", id); render(node); };
    laySeg.appendChild(b);
  }
  const layHint = document.createElement("span");
  layHint.className = "hint";
  layHint.textContent = "Node view only: full screen always sits side by side.";
  lay.append(layLab, laySeg, layHint);
  sect.appendChild(lay);

  // Mask overlay look: mode, opacity, colour. Changing one repaints every live
  // Paint pane AND Masks painter IN PLACE through repaintOverlays: no render,
  // because nothing structural changed and a rebuild here is exactly the class of
  // churn item 5 removed.
  const repaintPanes = () => {
    for (const n of allNodes()) {
      if (n.type === NODE_NAME) repaintOverlays(n);
    }
  };
  const ov = document.createElement("div");
  ov.className = "rn-ws-row";
  const ovLab = document.createElement("span");
  ovLab.className = "hint";
  ovLab.style.cssText = "flex:none;width:110px";
  ovLab.textContent = "Mask overlay";
  const ovSeg = document.createElement("div");
  ovSeg.className = "rn-ws-seg";
  ovSeg.style.flex = "0 0 auto";
  const modeBtns = [];
  const syncModes = () => {
    const now = String(wsPref("OverlayMode", "hatch"));
    for (const [b, id] of modeBtns) {
      b.className = "rn-ws-segb" + (now === id ? " on" : "");
    }
  };
  for (const [id, label, why] of [
    ["hatch", "Hatch", "The default: see-through diagonal bands that read on any "
                     + "picture."],
    ["flat", "Flat", "One solid colour for anyone who finds the hatch hard to read. "
                   + "The opacity slider goes all the way to opaque."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb";
    b.dataset.overlayMode = id;
    b.textContent = label;
    b.title = why;
    b.onclick = () => { setWsPref("OverlayMode", id); syncModes(); repaintPanes(); };
    ovSeg.appendChild(b);
    modeBtns.push([b, id]);
  }
  syncModes();
  const opRng = document.createElement("input");
  opRng.type = "range";
  opRng.min = 10; opRng.max = 100; opRng.step = 5;
  opRng.value = Number(wsPref("OverlayOpacity", 55)) || 55;
  opRng.style.cssText = "flex:1 1 90px;min-width:70px;height:22px;cursor:pointer;"
                      + "accent-color:#b8283c";
  opRng.title = "Overlay opacity. In Flat mode 100 hides the picture under the mask "
              + "entirely, which is a deliberate choice and never a clamp; Hatch "
              + "keeps its see-through gaps at any opacity.";
  const opVal = document.createElement("span");
  opVal.className = "rn-ws-zpct";
  opVal.style.minWidth = "34px";
  opVal.textContent = `${opRng.value}%`;
  opRng.addEventListener("input", () => {
    setWsPref("OverlayOpacity", Number(opRng.value) || 55);
    opVal.textContent = `${opRng.value}%`;
    repaintPanes();
  });
  const swatches = document.createElement("span");
  swatches.className = "rn-ws-swrow";
  swatches.style.cssText = "display:flex;gap:4px;flex:none;align-items:center";
  const swBtns = [];
  const syncSwatches = () => {
    const now = String(wsPref("OverlayColor", "red"));
    for (const [b, id] of swBtns) {
      b.className = "rn-ws-swatch" + (now === id ? " on" : "");
    }
  };
  for (const [id, rgb] of Object.entries(OVERLAY_COLORS)) {
    const b = document.createElement("button");
    b.className = "rn-ws-swatch";
    b.dataset.overlayColor = id;
    b.style.background = `rgb(${rgb})`;
    const cap = id.charAt(0).toUpperCase() + id.slice(1);
    b.title = id === "red" ? "Red, the default."
      : ["blue", "magenta", "yellow"].includes(id)
        ? `${cap}. Chosen to stay distinct under colour vision deficiency.`
        : `${cap}. Separates by brightness alone, so it works for every kind of `
          + "colour vision.";
    b.onclick = () => { setWsPref("OverlayColor", id); syncSwatches(); repaintPanes(); };
    swatches.appendChild(b);
    swBtns.push([b, id]);
  }
  syncSwatches();
  ov.append(ovLab, ovSeg, opRng, opVal, swatches);
  sect.appendChild(ov);

  // Which tabs are on the strip. Every tab except Advanced can go: someone who
  // never touches People or does their own post work should not carry those tabs.
  // The lit dot is the SAME dot the strip shows, so a hidden tab that is still
  // doing something says so in the one place you would go to unhide it.
  const vis = document.createElement("div");
  vis.className = "rn-ws-row";
  const visLab = document.createElement("span");
  visLab.className = "hint";
  visLab.style.cssText = "flex:none;width:110px";
  visLab.textContent = "Tabs shown";
  const visWrap = document.createElement("span");
  visWrap.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;flex:1 1 auto;"
                        + "min-width:0";
  const hidden = hiddenTabSet();
  const cfg = node._rnCfg;
  for (const t of TAB_ORDER) {
    if (t.id === "advanced") continue;             // the way back is not optional
    const isHidden = hidden.has(t.id);
    const tb = document.createElement("button");
    tb.className = "rn-ws-btn rn-ws-compact rn-ws-tabvis" + (isHidden ? "" : " on");
    tb.dataset.tab = t.id;
    tb.style.width = "auto";
    tb.style.padding = "0 8px";
    const dot = document.createElement("span");
    dot.className = "dot" + (tabLit(cfg, t.id) ? " on" : "");
    const lab2 = document.createElement("span");
    lab2.textContent = t.label;
    tb.append(dot, lab2);
    tb.title = (isHidden
      ? `Hidden. Click to put ${t.label} back on the strip.`
      : `Shown. Click to take ${t.label} off the strip.`)
      + " Hiding a tab never turns it off: whatever it is doing, it keeps doing, "
      + "and the green dot still says so here.";
    tb.onclick = () => {
      const next = hiddenTabSet();
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      setWsPref("HiddenTabs", [...next]);
      render(node);
    };
    visWrap.appendChild(tb);
  }
  const visHint = document.createElement("span");
  visHint.className = "hint";
  visHint.style.flexBasis = "100%";
  visHint.textContent = "Hiding a tab does not turn it off. This install only, "
                      + "never the workflow.";
  vis.append(visLab, visWrap, visHint);
  sect.appendChild(vis);

  // ---- VRAM: hand the card back when it has been full and idle ---------------
  // On the tab rather than only in the settings dialog, at : a
  // behaviour that unloads models on its own must be visible where you work, not
  // discovered later in a menu. OFF by default; automatic that guesses wrong is
  // worse than none.
  const freeRow = document.createElement("div");
  freeRow.className = "rn-ws-row";
  freeRow.style.flexWrap = "wrap";
  const freeLab = document.createElement("span");
  freeLab.className = "hint";
  freeLab.style.cssText = "flex:none;width:110px";
  freeLab.textContent = "Auto unload";
  const freeOn = document.createElement("button");
  const syncFreeOn = () => {
    const on = !!wsPref("AutoFree", false);
    freeOn.className = "rn-ws-btn rn-ws-compact" + (on ? " on" : "");
    freeOn.textContent = on ? "On" : "Off";
    freeOn.dataset.autofree = on ? "on" : "off";
  };
  freeOn.style.cssText = "width:auto;padding:0 12px";
  freeOn.title = "On, models are handed back once VRAM has been above the threshold "
               + "with NOTHING running or queued for the whole delay. It can never "
               + "interrupt a run: high VRAM while sampling is the model working, "
               + "which is why the idle requirement is the whole safety of this.";
  freeOn.onclick = () => {
    setWsPref("AutoFree", !wsPref("AutoFree", false));
    render(node);
  };
  syncFreeOn();
  freeRow.append(freeLab, freeOn);

  if (wsPref("AutoFree", false)) {
    const num = (key, dflt, min, max, step, label, title, suffix) => {
      const wrap = document.createElement("span");
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex:1 1 190px;"
                         + "min-width:0";
      const l = document.createElement("span");
      l.className = "hint";
      l.style.cssText = "flex:none;font-size:11px";
      l.textContent = label;
      const rng = document.createElement("input");
      rng.type = "range";
      rng.min = min; rng.max = max; rng.step = step;
      rng.value = Number(wsPref(key, dflt)) || dflt;
      rng.title = title;
      rng.dataset.autofreeKey = key;
      rng.style.cssText = "flex:1 1 70px;min-width:60px;height:22px;cursor:pointer;"
                        + "accent-color:#b8283c";
      const val = document.createElement("span");
      val.className = "rn-ws-zpct";
      val.style.minWidth = "44px";
      val.textContent = `${rng.value}${suffix}`;
      rng.addEventListener("input", () => {
        const v = snapStep(rng.value, min, max, step);
        setWsPref(key, v);
        val.textContent = `${v}${suffix}`;
      });
      wrap.append(l, rng, val);
      return wrap;
    };
    freeRow.appendChild(num("AutoFreeAt", 95, 50, 99, 1, "above",
      "How full the card must be before an idle spell counts. The CARD's figure, "
      + "including other applications, because the question is whether there is "
      + "room at all.", "%"));
    freeRow.appendChild(num("AutoFreeAfter", 30, 5, 300, 5, "idle for",
      "How long VRAM must stay high with nothing running or queued. Short values "
      + "unload between passes while you are still working, which costs a reload "
      + "every time.", "s"));

    const scopeSeg = document.createElement("div");
    scopeSeg.className = "rn-ws-seg";
    scopeSeg.style.flex = "0 0 auto";
    const scopeBtns = [];
    const syncScope = () => {
      const now = String(wsPref("AutoFreeScope", "both"));
      for (const [b, v] of scopeBtns) {
        b.className = "rn-ws-segb" + (now === v ? " on" : "");
      }
    };
    for (const [id, label, why] of [
      ["both", "Everything", "Renderer models and the caption engines."],
      ["models", "Models only", "The sampler's checkpoint and LoRAs. Leaves WD14, "
                              + "JoyCaption and QwenVL where they are."],
      ["engines", "Captioners only", "WD14, JoyCaption and QwenVL, which cache "
                                   + "between runs. Keeps the sampler warm."],
    ]) {
      const b = document.createElement("button");
      b.className = "rn-ws-segb";
      b.dataset.autofreeScope = id;
      b.textContent = label;
      b.title = why;
      b.onclick = () => { setWsPref("AutoFreeScope", id); syncScope(); };
      scopeSeg.appendChild(b);
      scopeBtns.push([b, id]);
    }
    syncScope();
    freeRow.appendChild(scopeSeg);

    const freeHint = document.createElement("span");
    freeHint.className = "hint";
    freeHint.style.flexBasis = "100%";
    freeHint.textContent = "Never runs while a prompt is running or queued. Anything "
                         + "starting resets the timer. Unloading costs one reload on "
                         + "the next run, nothing else.";
    freeRow.appendChild(freeHint);
  }
  sect.appendChild(freeRow);

  // Separate from the idle watcher above, and separate on purpose: this one is about
  // the moment you CHANGE renderer, which the idle rule never sees.
  const swRow = document.createElement("div");
  swRow.className = "rn-ws-row";
  swRow.style.flexWrap = "wrap";
  const swLab = document.createElement("span");
  swLab.className = "hint";
  swLab.style.cssText = "flex:none;width:110px";
  swLab.textContent = "On switch";
  const swSeg = document.createElement("div");
  swSeg.className = "rn-ws-seg";
  swSeg.style.flex = "0 0 auto";
  const switchBtns = [];
  const syncSw = () => {
    const now = String(wsPref("FreeOnSwitch", "always"));
    for (const [b, v] of switchBtns) {
      b.className = "rn-ws-segb" + (now === v ? " on" : "");
    }
  };
  for (const [id, label, why] of [
    ["always", "Always unload", "Unload the previous renderer every time you switch. "
                              + "The safe answer on a card with little room."],
    ["high", "Only when full", "Unload only if VRAM is already above the auto unload "
                             + "threshold. Keeps a small card safe without taxing a "
                             + "big one."],
    ["never", "Keep both", "Leave the previous renderer resident. Two models can sit "
                         + "together on a card with room, which makes switching "
                         + "between them instant instead of a reload."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb";
    b.dataset.freeSwitch = id;
    b.textContent = label;
    b.title = why;
    b.onclick = () => { setWsPref("FreeOnSwitch", id); syncSw(); };
    swSeg.appendChild(b);
    switchBtns.push([b, id]);
  }
  syncSw();
  const swHint = document.createElement("span");
  swHint.className = "hint";
  swHint.style.flexBasis = "100%";
  swHint.textContent = "What happens to the old model when the Paint tab's Rendered "
                     + "by changes. Unrelated to the idle watcher above.";
  swRow.append(swLab, swSeg, swHint);
  sect.appendChild(swRow);
  body.appendChild(sect);
}

// The Paint tab: paint a region on the last result, set a denoise, queue. The brush
// writes an ordinary mask PNG (painted = transparent, the convention load_mask already
// reads), uploads it beside the other managed files, and the tab drives the SAME
// edit_mask / output_latent / denoise sockets the rest of the node uses. So the
// inpaint runs on whatever sampler chain you already have, with nothing rewired.
let lastResult = null;                               // {filename, subfolder, type}
let lastPaintResultOwner = null;                     // Workspace that queued it
// WHAT THE RESULT PANE SHOWS, which is deliberately not the same thing. lastResult
// keeps quietly tracking the newest image out of ANY queue, because that is what Use
// last result pulls in; this only moves when something asked it to. Sharing one
// variable meant an ordinary workflow queue pushed its picture into the Paint tab's
// result pane and onto the strip beside it, which is the tab announcing work that has
// nothing to do with it.
let shownResult = null;
// The last few finished results, newest first, for the strip under the result pane.
// Session state like lastResult: reopening a workflow tomorrow starts fresh, which is
// right, because the files these point at may already be gone.
let resultHistory = [];
// Temporary Preview nodes created by Post-process + Save. Keying by our own node id,
// rather than prompt id, closes the race where a very fast queue can execute before
// the /prompt response reaches the browser.
const pendingPaintFinals = new Map();
// Paint Generate owns its own tiny prompts, so its progress can be separated from an
// ordinary queue or a Post + Save pass by prompt id.
const paintProgressRuns = new Map();
const paintRunWaiters = new Map();

function syncPaintProgress(node) {
  const ui = node?._rnPaintProgressEl;
  const state = node?._rnPaintProgress;
  if (!ui) return;
  const active = !!state?.active;
  const determinate = active && Number(state.max) > 0 && state.determinate;
  ui.root.classList.toggle("active", active);
  ui.root.classList.toggle("indeterminate", active && !determinate);
  if (determinate) {
    const pct = Math.max(0, Math.min(100, Number(state.value) / Number(state.max) * 100));
    ui.fill.style.width = `${pct}%`;
    ui.fill.style.transform = "";
    ui.root.setAttribute("aria-valuenow", String(Math.round(pct)));
  } else {
    ui.fill.style.width = "";
    ui.root.removeAttribute("aria-valuenow");
  }
}

function beginPaintProgress(node, promptId = "") {
  const old = String(node?._rnPaintProgress?.promptId || "");
  if (old) paintProgressRuns.delete(old);
  node._rnPaintProgress = {
    active: true, determinate: false, value: 0, max: 0,
    promptId: String(promptId || ""),
  };
  if (promptId) paintProgressRuns.set(String(promptId), node);
  syncPaintProgress(node);
}

function bindPaintProgress(node, promptId) {
  const id = String(promptId || "");
  if (!node || !id) return;
  const old = String(node._rnPaintProgress?.promptId || "");
  if (old && old !== id) paintProgressRuns.delete(old);
  node._rnPaintProgress ||= { active: true, determinate: false, value: 0, max: 0 };
  node._rnPaintProgress.promptId = id;
  paintProgressRuns.set(id, node);
  syncPaintProgress(node);
}

// The live frame in the result pane. Updated in place: a redraw of the whole
// tab per step would destroy whatever dropdown is open under the pointer.
function showPaintLiveFrame(node, d) {
  node._rnPaintLive = { src: String(d.data), step: Number(d.step) || 0,
                        total: Number(d.total) || 0, label: String(d.label || "") };
  const pane = node._rnRootEl?.querySelector?.(".rn-ws-presult");
  if (!pane) return;                       // another tab is up; drawn when Paint is
  paintLiveOverlay(node, pane);
}

function paintLiveOverlay(node, pane) {
  const live = node._rnPaintLive;
  let img = pane.querySelector(".rn-ws-plive");
  let tag = pane.querySelector(".rn-ws-plive-tag");
  if (!live) {
    img?.remove();
    tag?.remove();
    return;
  }
  if (!img) {
    img = document.createElement("img");
    img.className = "rn-ws-plive";
    pane.appendChild(img);
  }
  if (!tag) {
    tag = document.createElement("span");
    tag.className = "rn-ws-plive-tag";
    pane.appendChild(tag);
  }
  if (img.src !== live.src) img.src = live.src;
  tag.textContent = (live.label ? `${live.label} · ` : "")
                  + (live.total ? `rendering ${live.step} / ${live.total}` : "rendering");
}

function clearPaintLive(node) {
  if (!node?._rnPaintLive) return;
  node._rnPaintLive = null;
  const pane = node._rnRootEl?.querySelector?.(".rn-ws-presult");
  if (pane) paintLiveOverlay(node, pane);
}

function finishPaintProgress(promptId, failed = false, message = "") {
  const id = String(promptId || "");
  const node = paintProgressRuns.get(id);
  paintProgressRuns.delete(id);
  // the run is over: the frame comes off so the result shows the moment it lands
  for (const n of allNodes()) {
    if (n?.type === NODE_NAME && n._rnPaintLive
        && (n === node || String(n._rnPaintProgress?.promptId || "") === id)) {
      clearPaintLive(n);
    }
  }
  const waiter = paintRunWaiters.get(id);
  paintRunWaiters.delete(id);
  waiter?.resolve?.({ ok: !failed, message: String(message || "") });
  if (!node) return;
  const state = node._rnPaintProgress;
  if (!state || String(state.promptId || "") !== id) return;
  if (!failed && state.determinate) {
    state.value = state.max;
    syncPaintProgress(node);
  }
  const delay = failed ? 0 : 260;
  setTimeout(() => {
    if (String(node._rnPaintProgress?.promptId || "") !== id) return;
    node._rnPaintProgress.active = false;
    syncPaintProgress(node);
  }, delay);
}

function waitForPaintRun(promptId) {
  const id = String(promptId || "");
  if (!id) return Promise.resolve({ ok: false, message: "Paint returned no prompt id" });
  return new Promise((resolve) => paintRunWaiters.set(id, { resolve }));
}

function bindPaintRunWaiter(fromId, toId) {
  const from = String(fromId || "");
  const to = String(toId || "");
  if (!from || !to || from === to) return;
  const waiter = paintRunWaiters.get(from);
  if (!waiter) return;
  paintRunWaiters.delete(from);
  paintRunWaiters.set(to, waiter);
}

function paintBatchSettings(node) {
  return node._rnPaintBatchSettings ||= { count: 1, forever: false };
}

function syncPaintBatchUi(node) {
  const run = node?._rnPaintBatchRun;
  const active = !!run?.active;
  const remaining = active ? (run.forever ? "∞" : Math.max(0, run.remaining || 0)) : 0;
  if (node?._rnPaintQueueBadge) {
    node._rnPaintQueueBadge.textContent = `Queue ${remaining}`;
    node._rnPaintQueueBadge.classList.toggle("active", active);
    node._rnPaintQueueBadge.title = active
      ? (run.forever ? "Generating one image at a time until you stop it"
                     : `${remaining} Paint image${remaining === 1 ? "" : "s"} remaining`)
      : "No Paint images queued";
  }
  if (node?._rnPaintGenButton) {
    const b = node._rnPaintGenButton;
    b.disabled = false;
    b.textContent = active
      ? (run.stop ? "Stopping…" : `Stop${run.forever ? " · ∞" : ` · ${remaining}`}`)
      : "Generate";
  }
}

function resultUrl(r) {
  return api.apiURL(`/view?filename=${encodeURIComponent(r.filename)}`
    + `&type=${r.type || "output"}&subfolder=${encodeURIComponent(r.subfolder || "")}`
    + `&rand=${r.rand || 0}`);
}

const resultEntry = (r) =>
  (r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename)
  + (r.type && r.type !== "input" ? ` [${r.type}]` : "");

// Take a picture into the Paint tab from a drop or a file picker. It lands in the
// same managed folder the masks do, so the tab is self-contained: you can paint on
// something that never came out of this workflow at all.
async function adoptPaintSource(node, file) {
  if (!file || !file.type?.startsWith("image/")) return;
  const { blob, name } = await normalisedUpload(file);
  const body = new FormData();
  body.append("image", blob, name);
  body.append("type", "input");
  body.append("subfolder", "rednode/paint");
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  const d = await res.json();
  if (!d.name) throw new Error("the upload returned no name");
  const P = node._rnCfg.paint;
  P.source = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
  node._rnStrokes = [];
  writeCfg(node);
  render(node);
}

// Pull a picture out of a clipboard event. `files` covers a copied image FILE, and the
// items walk covers a screenshot or a browser's "copy image", which arrive as raw data
// with no file entry. getAsFile must be called here, synchronously: the item is dead
// once the event handler returns.
function clipboardImage(e) {
  const dt = e.clipboardData;
  const direct = [...(dt?.files || [])].find((f) => f.type?.startsWith("image/"));
  if (direct) return direct;
  for (const item of dt?.items || []) {
    if (item.kind === "file" && item.type?.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

function paintDropZone(node, el) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.outline = "2px dashed #4a8fe0";
  });
  el.addEventListener("dragleave", () => { el.style.outline = ""; });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.outline = "";
    try {
      // a result dragged from the pane next door arrives as data, not as a file
      const inApp = e.dataTransfer?.getData?.("application/x-rednode-result");
      if (inApp) {
        adoptResult(node, JSON.parse(inApp), "dragged onto the canvas");
        return;
      }
      await adoptPaintSource(node, (e.dataTransfer?.files || [])[0]);
    } catch (err) {
      console.error("[RedNode Workspace] could not take that picture:", err);
      alert(`Could not use that image: ${err.message}`);
    }
  });
}

function pickPaintSource(node) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    try {
      await adoptPaintSource(node, (inp.files || [])[0]);
    } catch (err) {
      console.error("[RedNode Workspace] could not take that picture:", err);
      alert(`Could not use that image: ${err.message}`);
    }
  };
  inp.click();
}

async function uploadMask(node, canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return null;
  const body = new FormData();
  body.append("image", blob, `paint_${Date.now()}.png`);
  body.append("type", "input");
  body.append("subfolder", "rednode/paint");
  body.append("overwrite", "false");
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  const d = await res.json();
  if (!d.name) throw new Error("the upload returned no name");
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

// Generate ONLY the painted region.
//
// ComfyUI queues whatever the graph contains, so pressing go normally re-runs the
// lot. Here the prompt is built as usual and then PRUNED to the Paint Render
// node's own inputs and their inputs, walking back from it. Everything else is
// dropped before it is sent, so the sampler runs once, on a crop, and nothing
// upstream of the rest of the workflow is touched.
/**
 * Which key in the BUILT PROMPT is this canvas node?
 *
 * Not always its own id. ComfyUI flattens subgraphs when it builds a prompt, and an
 * inner node is namespaced with the subgraph node's id, so a Paint Render tucked
 * inside a subgraph is keyed something like "12:8375" rather than "8375". Generate
 * looked it up by the bare id, found nothing, and reported the node as muted or
 * bypassed, which was never what was wrong.
 *
 * The separator is ComfyUI's business and could change, so this does not hardcode
 * one. In order: the exact id, then any key ENDING in the id after a non-digit
 * boundary, then, only if the class is unambiguous in the whole prompt, that single
 * entry. Being deliberately conservative about the last one: guessing between two
 * Paint Renders would silently drive the wrong one.
 */
function promptKeyFor(prompt, node) {
  if (!prompt || !node) return "";
  const id = String(node.id);
  if (prompt[id]) return id;
  const type = node.type || node.comfyClass;
  const keys = Object.keys(prompt);
  const suffix = keys.filter((k) => {
    if (!k.endsWith(id)) return false;
    const before = k[k.length - id.length - 1];
    return before !== undefined && !/\d/.test(before);   // "12:8375", not "18375"
  });
  // a namespaced match still has to BE the right kind of node
  const typed = suffix.filter((k) => !type || prompt[k]?.class_type === type);
  if (typed.length === 1) return typed[0];
  if (type) {
    const all = keys.filter((k) => prompt[k]?.class_type === type);
    if (all.length === 1) return all[0];
  }
  return typed[0] || "";
}

function pruneToNode(prompt, targetId) {
  const keep = new Set();
  const walk = (id) => {
    if (keep.has(id) || !prompt[id]) return;
    keep.add(id);
    for (const v of Object.values(prompt[id].inputs || {})) {
      // a wired input is ["<node id>", slot]; anything else is a plain widget value
      if (Array.isArray(v) && v.length === 2) walk(String(v[0]));
    }
  };
  walk(String(targetId));
  // The render node reads the Paint tab out of the QUEUED PROMPT, and the Workspace
  // is not one of its inputs, so pruning to ancestors alone dropped the very node
  // holding the settings: it found nothing to paint and returned an empty frame.
  // Keep every Workspace, with ITS ancestors so the links still resolve.
  for (const [id, n] of Object.entries(prompt)) {
    if (n?.class_type === "RedNodeStudioWorkspace") walk(String(id));
  }

  // ...and everything DOWNSTREAM of the paint result. Ancestors alone meant a Save
  // node wired to this node's image output was pruned away and never ran, so the
  // painted result existed only inside the node. Anything consuming the result is
  // part of what Generate is for.
  //
  // Their own ancestors come along so their other inputs resolve, which can pull in
  // more than the paint branch if you wire one to the main generation as well. That
  // is the honest trade: a node you asked to receive this image has to be able to
  // run, and quietly not saving would be the worse answer.
  const consumers = new Set([String(targetId)]);
  for (let pass = 0; pass < 12; pass++) {
    let added = false;
    for (const [id, n] of Object.entries(prompt)) {
      if (consumers.has(String(id))) continue;
      for (const v of Object.values(n?.inputs || {})) {
        if (Array.isArray(v) && v.length === 2 && consumers.has(String(v[0]))) {
          consumers.add(String(id));
          added = true;
          break;
        }
      }
    }
    if (!added) break;
  }
  for (const id of consumers) walk(id);
  const out = {};
  for (const id of keep) out[id] = prompt[id];
  return out;
}

// Which node Generate should drive. RedNode Paint Render does the whole job itself;
// RedNode Paint In is the end of a chain with somebody else's renderer in it. Both are
// stamped the same way, so Generate does not need to care which it found.
export function paintTargets() {
  return [
    ...findNodes("RedNodePaintRender").map((n) => ({ node: n, kind: "render" })),
    ...findNodes("RedNodePaintIn").map((n) => ({ node: n, kind: "bridge" })),
  ];
}

// The Models-tab rigs as paint choices: the built-in door. Picking one queues the
// WORKSPACE itself, so the pass renders inside it, on the routed paint model with
// the folded Studio's identity conditioning, and no render node has to exist.
export function rigTargets(cfg) {
  return (cfg?.models?.rigs || []).map((r, i) => {
    const name = r.name || `Rig ${i + 1}`;
    return { kind: "rig", rigName: name, node: { id: "rig:" + name, widgets: [] } };
  });
}
export const allPaintChoices = (cfg) => [...paintTargets(), ...rigTargets(cfg)];

// Nodes that only carry a picture from one place to another. A paint chain named after
// one of these comes out as "VAE Decode", which answers nothing: this row is asked
// WHICH ENGINE is going to paint, and a decode step is the same in every chain there is.
const PAINT_PLUMBING = new Set([
  "Reroute", "RerouteNode", "PrimitiveNode", "Note", "MarkdownNote",
  "VAEEncode", "VAEEncodeTiled", "VAEEncodeForInpaint", "VAEDecode", "VAEDecodeTiled",
  "ImageScale", "ImageScaleBy", "ImageResize", "ImageCrop", "ImageBatch",
  "LatentUpscale", "LatentUpscaleBy",
  "RedNodePaintOut", "RedNodePaintIn", "RedNodeStudioWorkspace",
]);

// A title somebody typed, as opposed to the one the node was born with. A renamed node
// anywhere in a chain already says what that chain is, and that
// beats anything guessed from node types.
function namedByHand(n) {
  const title = String(n?.title || "").trim();
  if (!title) return false;
  const born = n?.constructor?.title || n?.constructor?.nodeData?.display_name;
  return born ? title !== born : title !== String(n?.type || "");
}

// The walk is bounded because it runs on every panel render, and because an unbounded
// crawl back from a Paint In wired into the main graph would visit the whole workflow.
const PAINT_TRACE_DEPTH = 8;
const PAINT_TRACE_NODES = 160;

/**
 * Walk back from a Paint In to whatever actually rendered the picture.
 *
 * A bridge is a chain: Paint Out hands the picture out, somebody else's renderer works
 * on it, Paint In composites the result home. Naming the row after the Paint In named
 * the PLUMBING, so a graph with an NAI chain in it offered "Paint In (own chain) #8408"
 * and said nothing about which engine the button was about to spend money on.
 *
 * The walk stops AT a Paint Out instead of going through it. Past that point is the
 * workflow that made the source picture, which is not what is doing the rendering, and
 * a chain wired back into the main graph would otherwise name a checkpoint loader.
 */
function bridgeRenderer(node) {
  if (!node) return null;
  const seen = new Set([node]);
  let level = [node];
  let first = null;
  for (let depth = 0; depth < PAINT_TRACE_DEPTH && level.length; depth++) {
    const next = [];
    for (const n of level) {
      for (const inp of (n?.inputs || [])) {
        if (!inp?.link) continue;
        const g = n.graph || app.graph;
        // newer frontends keep the link table as a Map, older ones as a plain object
        const link = g?.links?.get?.(inp.link) ?? g?.links?.[inp.link];
        if (!link) continue;
        // by id inside this graph first: a subgraph has its own numbering, and the
        // pack-wide lookup would happily hand back a same-numbered node from elsewhere
        const src = g?.getNodeById?.(link.origin_id) || nodeById(link.origin_id);
        if (!src || seen.has(src)) continue;
        seen.add(src);
        if (seen.size > PAINT_TRACE_NODES) return first;
        if (String(src.type || "") === "RedNodePaintOut") continue;
        if (!PAINT_PLUMBING.has(String(src.type || ""))) {
          if (namedByHand(src)) return src;
          // nearest to the Paint In is nearest to the finished picture
          first ||= src;
        }
        next.push(src);
      }
    }
    level = next;
  }
  return first;
}

// Whatever the node calls itself, cut to something a row can hold. The picker sits in a
// line with its own label and the panel's controls, and a node called "Ultimate SD
// Upscale (with model and prompt)" would push all of that off the end of the panel.
const RENDERER_LABEL_MAX = 28;

function shortLabel(n) {
  const raw = (String(n?.title || "").trim() || String(n?.type || "").trim())
    .replace(/\s+/g, " ");
  return raw.length > RENDERER_LABEL_MAX
    ? `${raw.slice(0, RENDERER_LABEL_MAX - 1).trim()}…` : raw;
}

// What a renderer is called, before any id is added. A node you renamed is the one thing
// on the canvas that already says what is inside it, so that name wins over everything.
// Otherwise say what will actually run: the built-in renderer is Krea 2 shaped, and a
// bridge is named after the engine found in its chain.
function rendererLabel(t) {
  const born = t?.kind === "render" ? "RedNode Paint Render"
                                    : "RedNode Paint In (composite back)";
  const title = String(t?.node?.title || "").trim();
  if (title && title !== born) return shortLabel(t.node);
  if (t?.kind === "render") return "Krea 2";
  const src = bridgeRenderer(t?.node);
  // Nothing wired yet, or a chain of pure plumbing. Today's wording is still true and
  // still picks the right node; it just cannot say more than "your own chain".
  return src ? shortLabel(src) : "Paint In (own chain)";
}

// What to call a renderer in the picker. The id is NOISE while there is one of each
// kind, which is the usual graph, so it is only spent on telling two identical labels
// apart: two Paint Ins on the same engine, or two chains nobody has wired yet.
export function rendererName(t) {
  if (t?.kind === "rig") return "Built-in: " + t.rigName;
  let label = "";
  try {
    label = rendererLabel(t);
    const others = paintTargets();
    const clash = others.some((o) => o.node !== t?.node && rendererLabel(o) === label);
    if (!clash) return label;
  } catch (err) {
    // A half-wired graph must not take the panel down with it: this runs on every
    // render, including while you are still dragging the wires in.
    console.debug?.("[RedNode Workspace] could not name a renderer:", err);
    if (!label) label = t?.kind === "render" ? "Paint Render" : "Paint In (own chain)";
  }
  return `${label} #${t?.node?.id}`;
}

function chosenTarget(cfg) {
  const found = allPaintChoices(cfg);
  if (!found.length) return null;
  const P = cfg?.paint || {};
  const byId = found.find((t) => String(t.node.id) === String(P.renderer ?? ""));
  if (byId) return byId;
  // The id it pointed at is gone. Deleting a node and putting a fresh one back is an
  // ordinary thing to do and ComfyUI hands out a new id every time, so an id on its own
  // is not a durable way to record a choice. The NAME is: you renamed that node after
  // what is inside it precisely so you would recognise it again.
  const name = String(P.renderer_name ?? "");
  const byName = name && found.find((t) => rendererName(t) === name);
  if (byName) return byName;
  // A node you never renamed is called "Paint In (own chain) #8408", id and all, so its
  // name cannot outlive the id either. Its KIND can: if the choice was a bridge, land
  // on a bridge rather than silently switching to a Paint Render, which is a different
  // renderer producing different pictures.
  const kind = String(P.renderer_kind ?? "");
  return (kind && found.find((t) => t.kind === kind)) || found[0];
}

/**
 * Point the stored choice back at a node that exists, and say whether anything moved.
 *
 * Without this the config keeps an id that resolves to nothing. Everything downstream
 * quietly falls back to the first target, so the panel shows one renderer, drives
 * another, and gives no sign which. Recording the name alongside the id is what lets
 * the choice survive the node being recreated at all.
 */
function healRenderer(cfg) {
  const t = chosenTarget(cfg);
  if (!t || !cfg?.paint) return false;
  const P = cfg.paint;
  const id = String(t.node.id);
  const nm = rendererName(t);
  if (String(P.renderer ?? "") === id && P.renderer_name === nm
      && P.renderer_kind === t.kind) return false;
  P.renderer = id;
  P.renderer_name = nm;
  P.renderer_kind = t.kind;
  return true;
}

// cfg and steps arrived on this tab AFTER people had workflows using the widgets on
// RedNode Paint Render. Defaulting them here would silently overwrite what those users
// set, so the tab adopts the renderer's current values the first time instead, once.
// A bridge target has no such widgets, so it gets the node's own defaults.
function seedSamplerDials(cfg) {
  const P = cfg?.paint;
  if (!P || (typeof P.cfg === "number" && typeof P.steps === "number")) return false;
  const widgets = chosenTarget(cfg)?.node?.widgets || [];
  const from = (name, fallback) => {
    const w = widgets.find((x) => x?.name === name);
    return typeof w?.value === "number" ? w.value : fallback;
  };
  if (typeof P.cfg !== "number") P.cfg = from("cfg", 1.0);
  if (typeof P.steps !== "number") P.steps = from("steps", 8);
  return true;
}

// "control after generate" is a FRONTEND widget behaviour: ComfyUI advances those
// values as part of its own queue button. Generate posts a pruned prompt straight to
// /prompt, so that step never happens, the seed never moves, and every run after the
// first is served from the cache: you press Generate and nothing changes.
//
// This does what the widget would have done, and only what it says: randomize,
// increment or decrement. A seed set to "fixed" stays fixed, because that is the
// user asking for a reproducible result.
//
// The new value has to come from the WIDGET'S OWN limits. Seed ranges are not a
// convention: a KSampler takes up to 2^64, plenty of API nodes take 2^32 or less, and
// handing one of those a number past its max gets the whole prompt thrown out with
// "outputs failed validation" before a single node runs.
function advanceSeeds(prompt, keptIds) {
  for (const id of keptIds) {
    const gnode = nodeById(id);
    const widgets = gnode?.widgets || [];
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      if (!w || typeof w.value !== "number") continue;
      if (!/^(seed|noise_seed)$/i.test(String(w.name || ""))) continue;
      const slot = prompt[String(id)]?.inputs;
      // a seed driven by a link is somebody else's to advance, not ours
      if (!slot || !(w.name in slot) || Array.isArray(slot[w.name])) continue;
      const ctrl = widgets.find((c) => /control[_ ]?after[_ ]?generate/i.test(
        String(c?.name || "")));
      const mode = String(ctrl?.value || "fixed").toLowerCase();
      const opt = w.options || {};
      const lo = Number.isFinite(opt.min) ? Math.max(0, Math.floor(opt.min)) : 0;
      // MAX_SAFE_INTEGER because past it JSON.stringify emits exponent notation and
      // the float is no longer the integer we picked
      const hi = Math.min(Number.isFinite(opt.max) ? Math.floor(opt.max) : 0xffffffff,
                          Number.MAX_SAFE_INTEGER);
      let next = w.value;
      if (mode === "randomize") next = lo + Math.floor(Math.random() * (hi - lo + 1));
      else if (mode === "increment") next = w.value + 1;
      else if (mode === "decrement") next = w.value - 1;
      else continue;                       // fixed, or something we do not know
      next = Math.max(lo, Math.min(hi, next));
      w.value = next;                      // so the canvas agrees with what ran
      slot[w.name] = next;
    }
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

// Rolled seeds stay inside 32 bits ON PURPOSE, not because JS could not go higher.
// The seed socket feeds whatever you wired it into, and the receiver's range is
// theirs, not ours: NovelAI's node caps its seed at 9999999999 and the service clamps
// anything past it, so a 2^53 roll landed on the SAME clamped value every single time.
// The number on screen changed, the seed NAI actually used did not, and every Generate
// after the first came back as the identical picture. 0..2^32-1 is the range every
// sampler and every service accepts, and it is what ComfyUI's own seed widgets roll.
export function rollSeed() {
  return Math.floor(Math.random() * 0x100000000);
}

async function paintGenerate(node) {
  if (!node._rnCfg?.paint?.on) {
    // a blank white result with no word of why is the worst answer a button
    // can give; say what is off and where the switch is
    alert("Paint is switched off on this tab, so Generate would render a blank "
        + "canvas. Switch Paint on with the switch at the top of the Paint tab, "
        + "then press Generate. The main Queue button renders the workspace as "
        + "usual.");
    return;
  }
  const picked = chosenTarget(node._rnCfg);
  if (!picked) {
    alert("Nothing to paint with. Either add a RedNode Paint Render node and wire "
        + "model, positive, negative and vae into it, or add RedNode Paint Out and "
        + "Paint In with your own renderer in between. Generate drives whichever it "
        + "finds.");
    return;
  }
  if (picked.kind === "rig") {
    // THE BUILT-IN DOOR: queue the workspace itself. The run token lives only in
    // the QUEUED copy of the config, never the saved one, so an ordinary queue can
    // never repaint by accident.
    const { output } = await app.graphToPrompt();
    const wsKey = promptKeyFor(output, node);
    if (!wsKey) { alert("The workspace is not in the queued graph."); return; }
    const pruned = pruneToNode(output, wsKey);
    try {
      const c = JSON.parse(pruned[wsKey].inputs.config || "{}");
      c.paint = c.paint || {};
      c.paint.run_token = `paint-${Date.now()}`;
      pruned[wsKey].inputs.config = JSON.stringify(c);
    } catch (e) { alert("Could not stamp the paint run: " + e.message); return; }
    advanceSeeds(pruned, Object.keys(pruned));
    const requestedPromptId = globalThis.crypto?.randomUUID?.() || "";
    let completion = requestedPromptId ? waitForPaintRun(requestedPromptId) : null;
    beginPaintProgress(node, requestedPromptId);
    try {
      const body = { prompt: pruned, client_id: api.clientId ?? api.socket?.clientId };
      if (requestedPromptId) body.prompt_id = requestedPromptId;
      const res = await api.fetchApi("/prompt", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      const d2 = await res.json().catch(() => ({}));
      if (!res.ok || d2.error) {
        throw new Error(d2.error?.message || d2.error
                        || `queue refused Paint (${res.status})`);
      }
      const actualPromptId = String(d2.prompt_id || requestedPromptId);
      bindPaintRunWaiter(requestedPromptId, actualPromptId);
      bindPaintProgress(node, actualPromptId);
      completion ||= waitForPaintRun(actualPromptId);
      console.log("[RedNode Workspace] built-in paint pass queued on rig "
                  + picked.rigName);
      return { promptId: actualPromptId, completion };
    } catch (e) {
      if (requestedPromptId) finishPaintProgress(requestedPromptId, true);
      else {
        node._rnPaintProgress.active = false;
        syncPaintProgress(node);
      }
      throw e;
    }
  }
  // Roll BEFORE the prompt is built, so the seed that runs is the seed on screen. It
  // also keys Paint Out's IS_CHANGED: with a fixed seed and nothing else touched, a
  // second Generate is served from the cache, which is correct, because the same seed
  // and settings genuinely are the same picture.
  {
    const P = node._rnCfg?.paint;
    if (P && P.seed_random !== false) {
      P.seed = rollSeed();
      writeCfg(node);
      render(node);       // the number shown must be the number about to run
    }
  }
  const target = picked.node;
  // A renderer switch is the one moment the previous model is dead weight: its branch
  // is about to be pruned away, so nothing will evict it until VRAM runs short. Free it
  // here, before the post, because nothing is executing yet and the ordering is certain.
  // NOT on every Generate: twenty low-denoise passes on one model is the normal way to
  // use this tab, and freeing each time makes every pass a multi-gigabyte reload.
  //
  // WHETHER it frees is a choice. On a card with room, two renderers sitting
  // resident together makes switching between them instant, and paying a
  // multi-gigabyte reload for memory nobody needed back is the wrong trade. "high"
  // is the middle answer: only unload when VRAM is already over the auto unload
  // threshold, so a small card is still protected and a big one is not taxed.
  if (paintGenerate._last && paintGenerate._last !== String(target.id)) {
    const when = String(wsPref("FreeOnSwitch", "always"));
    let free = when !== "never";
    if (free && when === "high") {
      try {
        const s = await (await api.fetchApi("/rednode/vram_state")).json();
        const at = Math.max(0.5, Math.min(0.99,
          (Number(wsPref("AutoFreeAt", 95)) || 95) / 100));
        free = Number.isFinite(Number(s?.used)) ? Number(s.used) >= at : true;
        if (!free) {
          console.log(`[RedNode Workspace] renderer switched, but VRAM is at `
                    + `${Math.round(Number(s.used) * 100)}% so the previous model `
                    + `stays resident`);
        }
      } catch (e) {
        free = true;         // cannot read the card: behave as it always did
      }
    }
    if (free) {
      try {
        const r = await api.fetchApi("/rednode/free_models", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const info = await r.json().catch(() => ({}));
        if (info.count) {
          console.log(`[RedNode Workspace] renderer switched, freed ${info.count} `
                    + `model(s), about ${Math.round(info.freed / 1048576)} MB`);
        }
      } catch (e) {
        console.warn("[RedNode Workspace] could not free the previous renderer:", e);
      }
    }
  }
  paintGenerate._last = String(target.id);
  const { output } = await app.graphToPrompt();
  // A NODE INSIDE A SUBGRAPH IS NOT KEYED BY ITS OWN ID. ComfyUI flattens subgraphs
  // when it builds a prompt and namespaces the inner ids with the subgraph node's,
  // so looking the target up by its litegraph id found nothing and Generate refused
  // to run with "is it muted or bypassed?", which is the one thing it was not.
  const targetKey = promptKeyFor(output, target);
  if (!targetKey) {
    alert("The Paint Render node is not in the queued graph. Is it muted or bypassed?");
    return;
  }
  const pruned = pruneToNode(output, targetKey);
  if (!pruned[targetKey]) {
    alert("The Paint Render node is not in the queued graph. Is it muted or bypassed?");
    return;
  }
  // stamp THIS run so the render node knows it was asked for. Without it the node
  // would render on every ordinary queue as well, quietly stacking up pictures.
  pruned[targetKey].inputs.run_token = `paint-${Date.now()}`;
  // Without this a second Generate is a cache hit and nothing happens. The render
  // node itself does not care, since its IS_CHANGED is NaN on a paint run, but
  // anything else in the chain does, which is the whole bridge case.
  advanceSeeds(pruned, Object.keys(pruned));
  const requestedPromptId = globalThis.crypto?.randomUUID?.() || "";
  let completion = requestedPromptId ? waitForPaintRun(requestedPromptId) : null;
  beginPaintProgress(node, requestedPromptId);
  let d;
  try {
    const body = {
      prompt: pruned,
      client_id: api.clientId ?? api.socket?.clientId,
    };
    if (requestedPromptId) body.prompt_id = requestedPromptId;
    const res = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) {
      throw new Error(d.error?.message || d.error || `queue refused Paint (${res.status})`);
    }
    const actualPromptId = String(d.prompt_id || requestedPromptId);
    bindPaintRunWaiter(requestedPromptId, actualPromptId);
    bindPaintProgress(node, actualPromptId);
    completion ||= waitForPaintRun(actualPromptId);
    console.log(`[RedNode Workspace] painting ${Object.keys(pruned).length} nodes `
              + `instead of ${Object.keys(output).length}`);
    return { promptId: actualPromptId, completion };
  } catch (e) {
    if (requestedPromptId) finishPaintProgress(requestedPromptId, true);
    else {
      node._rnPaintProgress.active = false;
      syncPaintProgress(node);
    }
    throw e;
  }
}

function openPaintBatchMenu(node, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector(".rn-ws-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "rn-ws-menu";
  for (const t of ["pointerdown", "click", "contextmenu"]) {
    menu.addEventListener(t, (e) => e.stopPropagation());
  }
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = "Paint generation queue";
  menu.appendChild(note);

  const run = node._rnPaintBatchRun;
  if (run?.active) {
    const status = document.createElement("div");
    status.className = "note";
    status.textContent = run.forever
      ? "Generating forever, one image at a time"
      : `${Math.max(0, run.remaining || 0)} image(s) remaining`;
    const stop = document.createElement("button");
    stop.textContent = "Stop after the current image";
    stop.onclick = () => {
      run.stop = true;
      syncPaintBatchUi(node);
      menu.remove();
    };
    menu.append(status, stop);
  } else {
    const cfg = paintBatchSettings(node);
    const countRow = document.createElement("div");
    countRow.className = "rn-ws-batchrow";
    const countLabel = document.createElement("label");
    countLabel.textContent = "Images";
    const count = document.createElement("input");
    count.type = "number";
    count.min = "1";
    count.max = "999";
    count.step = "1";
    count.value = String(Math.max(1, Math.min(999, Number(cfg.count) || 1)));
    countRow.append(countLabel, count);

    const foreverRow = document.createElement("div");
    foreverRow.className = "rn-ws-batchrow";
    const foreverLabel = document.createElement("label");
    foreverLabel.textContent = "Generate forever";
    const forever = document.createElement("input");
    forever.type = "checkbox";
    forever.checked = !!cfg.forever;
    foreverRow.append(foreverLabel, forever);

    const hint = document.createElement("div");
    hint.className = "note";
    hint.style.whiteSpace = "normal";
    hint.textContent = "Runs sequentially so ComfyUI stays responsive. Generate becomes "
                     + "Stop while the queue is active.";

    const start = document.createElement("button");
    const sync = () => {
      cfg.count = Math.max(1, Math.min(999, Math.round(Number(count.value) || 1)));
      count.value = String(cfg.count);
      cfg.forever = forever.checked;
      count.disabled = cfg.forever;
      start.textContent = cfg.forever ? "Start generating forever"
                                     : `Start ${cfg.count} image${cfg.count === 1 ? "" : "s"}`;
    };
    count.addEventListener("input", sync);
    forever.addEventListener("change", sync);
    sync();
    start.onclick = () => {
      sync();
      menu.remove();
      node._rnPaintGenerate?.();
    };
    menu.append(countRow, foreverRow, hint, start);
  }

  document.body.appendChild(menu);
  const mw = 240;
  const mh = menu.getBoundingClientRect().height || 170;
  menu.style.left = Math.max(6, Math.min(ev.clientX || 0,
    (window.innerWidth || 1920) - mw - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(ev.clientY || 0,
    (window.innerHeight || 1080) - mh - 6)) + "px";
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

function paintBody(node, body) {
  const cfg = node._rnCfg;
  const P = cfg.paint;
  // Two rooms, two arrangements, decided ONCE at the top: in the node the canvases
  // stack and the primary bar leads; over the whole window the canvases sit side by
  // side, the zoom bar stands up as a left rail, and the primary bar moves under
  // the pictures. Same panel, same handlers, different furniture positions.
  const fs = !!node._rnFsPrev;
  if (seedSamplerDials(cfg)) writeCfg(node);

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (P.on ? " on" : "");
  on.title = P.on
    ? "The painted region drives output_latent, edit_mask and denoise. Queue to run "
      + "it. Switching this OFF also hands back whatever the paint renderer left in "
      + "VRAM, since you are done with it."
    : "Off: this tab changes nothing and the other tabs keep their claim on "
      + "output_latent.";
  on.onclick = () => {
    const wasOn = P.on;
    P.on = !P.on;
    writeCfg(node);
    render(node);
    // SWITCHING OFF IS SAYING YOU ARE DONE, so the model the paint pass loaded is
    // dead weight from here: the renderer-switch free never fires because there was
    // no switch, and the idle watcher is off by default, so without this the
    // checkpoint sits there until something else needs the room. Only on the ON to
    // OFF edge, never on OFF to ON, where you are about to want it back.
    //
    // Fire and forget: the server declines while the queue is busy, and a failure
    // here costs nothing but the memory staying put, which is where it already was.
    if (wasOn) {
      api.fetchApi("/rednode/free_models", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).then((r) => r.json()).then((d) => {
        if (d?.count) {
          console.log(`[RedNode Workspace] Paint switched off, freed ${d.count} `
                    + `model(s), about ${Math.round((d.freed || 0) / 1048576)} MB`);
        }
      }).catch((e) => {
        console.debug?.("[RedNode Workspace] could not free on Paint off:", e);
      });
    }
  };
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "Paint what you want changed, set the denoise, queue. It runs on "
                   + "your own sampler; wire the vae input so the source can be encoded.";
  row.style.cssText += ";padding-bottom:8px;border-bottom:1px solid #2a2e35";
  // The tab's OWN size dial, like Thumbs on the galleries: scales only this tab, on
  // top of the global UI scale. It applies on release for the same reason the global
  // one does: the slider lives inside the very thing it resizes, and a live apply
  // moves the slider under the pointer mid-drag.
  const fsBtn = document.createElement("button");
  fsBtn.className = "rn-ws-btn";
  fsBtn.style.cssText = "width:auto;padding:2px 10px;height:24px;flex:none";
  fsBtn.textContent = node._rnFsPrev ? "\u2715 Close" : "\u26F6 Full screen";
  fsBtn.title = node._rnFsPrev
    ? "Back to the node. Everything you did here is already in it."
    : "The whole panel over the window: a bigger canvas to paint on, same node, "
      + "nothing copied. Esc closes.";
  fsBtn.onclick = () => {
    if (node._rnFsPrev) node._rnFsClose?.();
    else openFullscreen(node);
  };
  const tsWrap = document.createElement("span");
  tsWrap.style.cssText = "margin-left:auto;display:flex;align-items:center;gap:6px;"
                       + "flex:none";
  const sizesB = document.createElement("button");
  sizesB.className = "rn-ws-btn";
  sizesB.style.cssText = "width:auto;padding:3px 12px;font-size:11.5px;flex:none";
  sizesB.textContent = "Sizes \u25BE";
  sizesB.title = "One dial per region: the top bar, the settings column, and in full "
               + "screen the left rail. The pictures never scale; they own their "
               + "space.";
  sizesB.onclick = (e) => {
    e.stopPropagation();
    openSizesMenu(node, sizesB, fs);
  };
  // THE LIVE FRAME SIZE: how big the picture-forming frames over the result pane
  // are decoded, for paint runs only. Bigger is sharper on a big node and costs a
  // little more per step to decode and send; the default is the stream's 512.
  const liveSel = document.createElement("select");
  liveSel.className = "rn-ws-select";
  liveSel.style.cssText = "height:24px;padding:0 6px;font-size:11.5px";
  for (const [v, l] of [[0, "Live 512 px"], [768, "Live 768 px"], [1024, "Live 1024 px"],
                        [1536, "Live 1536 px"], [-1, "Live full size"]]) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = l;
    o.selected = (P.live_px || 0) === v;
    liveSel.appendChild(o);
  }
  liveSel.title = "The size of the live frames drawn over the result pane while a paint "
                + "run samples, decoded by the small VAE each step. 512 is the stream's "
                + "default and quick; bigger is sharper on a large node and costs a "
                + "little per step; full size is the decoder's own output.";
  liveSel.onchange = () => { P.live_px = parseInt(liveSel.value, 10) || 0; writeCfg(node); };
  tsWrap.append(liveSel, sizesB);
  row.append(on, hint, tsWrap, fsBtn);
  body.appendChild(row);

  // THE TOP BAR: the two dials moved constantly, the mode, and Generate, in one row
  // above the picture. Generate lived at the tail of a row of six small buttons at
  // the bottom, the same size as "Open image", and the single most-pressed control
  // on the tab deserves better than being found by reading. The controls themselves
  // are built where they always were and RETARGETED here, so their logic is the
  // logic that is already tested.
  const topbarBox = document.createElement("div");
  topbarBox.className = "rn-ws-topbar";
  body.appendChild(topbarBox);
  // The Tab size dial scales THIS bar and the settings boxes, nothing else: the
  // canvases stay solid so the picture never moves while its controls grow. The zoom
  // sits on an INNER wrapper, never on the flex item itself: a zoomed flex item
  // reports its unzoomed size to the flex algorithm, which is the bug that floated
  // the footer mid-panel three times now, and an inner block child sizes its parent
  // honestly.
  const tScale = Math.max(0.7, Math.min(2.5, parseFloat(P.scale) || 1));
  const topScale = Math.max(0.7, Math.min(2.5, parseFloat(P.scale_top) || 1));
  const topbar = document.createElement("div");
  topbar.style.cssText = "flex:1 1 auto;width:100%;min-width:0;display:grid;"
                      + "grid-template-columns:1fr 1fr;gap:10px;align-items:stretch";
  if (Math.abs(topScale - 1) >= 0.001) topbar.style.zoom = String(topScale);
  topbarBox.appendChild(topbar);

  // TWO COLUMNS, your layout: the pictures stacked on the left, paint above
  // result, and every setting in a column on the right. One tall stack under the
  // canvases was fine with four controls and is a wall with fourteen: the settings
  // read top to bottom beside the picture they change, and the canvases get the
  // full height instead of pushing everything below the fold. On a narrow node the
  // side column wraps underneath, which is the old layout, so nothing is lost.
  const cols = document.createElement("div");
  cols.className = "rn-ws-pcols";
  const pmain = document.createElement("div");
  pmain.className = "rn-ws-pmain";
  const psideBox = document.createElement("div");
  psideBox.className = "rn-ws-pside";
  if (fs) {
    // its own scrollbar in the big room: the column must never be the thing that
    // decides the page's height, and the dials at its tail must be reachable on a
    // 1080p screen without scrolling the canvases away
    psideBox.style.alignSelf = "stretch";
    psideBox.style.overflowY = "auto";
    psideBox.style.minHeight = "0";
  }
  // same rule as the top bar: the zoom lives on an inner wrapper, the flex item
  // stays honest about its size
  const pside = document.createElement("div");
  pside.style.cssText = "display:flex;flex-direction:column;gap:6px";
  if (Math.abs(tScale - 1) >= 0.001) pside.style.zoom = String(tScale);

  // THE COLUMN'S OWN TAB STRIP. Full screen painting means living on this tab, and
  // every trip to the top strip to nudge a LoRA is a trip away from the canvas. The
  // strip swaps only the column: the canvases stay put, which is the point. The rest
  // of paintBody keeps building into pside exactly as before; when LoRAs is the active
  // sub-tab the finished column is simply not shown. Cheap, and it keeps every handler
  // in the column alive either way.
  const sideTab = node.properties?.rn_paint_side === "loras" ? "loras" : "paint";
  const strip = document.createElement("div");
  strip.className = "rn-ws-seg";
  strip.style.cssText = "margin-bottom:2px;align-self:stretch";
  for (const [value, label, tip] of [
    ["paint", "Paint", "The painting controls."],
    ["loras", "Paint LoRAs", "LoRAs for the paint pass only. Two settings inside: the "
                             + "paint pass renders with the main LoRAs tab's stack, or "
                             + "with the stack in here instead."],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    b.style.flex = "1";
    b.className = "rn-ws-segb" + (sideTab === value ? " on" : "");
    b.onclick = () => {
      (node.properties ||= {}).rn_paint_side = value === "paint" ? undefined : value;
      render(node);
    };
    strip.appendChild(b);
  }
  psideBox.appendChild(strip);
  psideBox.appendChild(pside);
  if (sideTab === "loras") {
    pside.style.display = "none";
    const ploras = document.createElement("div");
    ploras.style.cssText = "display:flex;flex-direction:column;gap:6px";
    if (Math.abs(tScale - 1) >= 0.001) ploras.style.zoom = String(tScale);
    psideBox.appendChild(ploras);
    paintLorasBody(node, ploras);
  }
  cols.append(pmain, psideBox);
  body.appendChild(cols);
  if (fs) pmain.appendChild(topbarBox);    // re-appending MOVES it: the bar sits
                                           // under the pictures and STOPS at the
                                           // result's right edge, and the settings
                                           // column keeps the full height beside it

  let zbar = null;                 // built with the canvases, placed after the stage
  const stage = document.createElement("div");
  // The arrangement is the USER'S setting, not a guess: automatic layout here has
  // been gotten wrong before, so it is one of three explicit choices and the
  // default is exactly what always happened. NODE VIEW ONLY, stated by you:
  // full screen has the room by definition and never reads this.
  const layoutPref = fs ? "side" : String(wsPref("PaintLayout", "stacked"));
  stage.className = "rn-ws-paint"
    + (layoutPref === "side" ? ""
       : layoutPref === "auto" ? " rn-ws-pauto" : " rn-ws-pcol");

  // THE PAINT SOURCE IS ONLY EVER WHAT WAS CHOSEN. It used to fall back to the newest
  // result whenever it was empty, which made "empty" mean FOLLOW THE WORKFLOW: every
  // finished queue changed the picture under the brush. That is not a preference, it
  // is destructive, because changing the picture trips the invariant below and WIPES
  // the strokes and the saved mask. A queue with nothing to do with the Paint tab
  // could throw away work in progress, and did.
  //
  // Empty now means nothing is chosen, and the pane says so. A result arrives here
  // three ways, all of them deliberate: the Paint tab's own Generate adopts what it
  // just rendered, Use last result pulls the newest one in, and the result pane can be
  // clicked or dragged.
  const src = P.source || "";

  // THE MASK FOLLOWS THE PICTURE, enforced here at the one place every path funnels
  // through. Strokes and the saved mask belong to the picture they were painted on,
  // and until now every way of bringing in a new picture was separately responsible
  // for remembering to clear them: the drop path did, the result-pane click forgot
  // the saved mask, and follow-the-result mode cleared nothing at all, so a new
  // render arrived and the OLD strokes were replayed on top of it. That is how a
  // repaint landed through the previous picture's mask, and how two masks arrived
  // combined. Keying the clear off the picture itself retires the whole class:
  // an entry point added next month cannot reintroduce it by forgetting.
  //
  // KEEP MASK is the one exception, and it is the upscale round trip: send a picture
  // out, bring the bigger version back, and the mask that still describes it should not
  // be thrown away. The STROKES still go, always, because they are recorded in the old
  // picture's pixel coordinates and would land somewhere else on a differently sized
  // one; the saved mask is a file the server rescales to whatever picture it is given.
  if (node._rnStrokesFor !== src) {
    if (node._rnStrokesFor !== undefined) {
      node._rnStrokes = [];
      if (!P.keep_mask) {
        if (P.mask) { P.mask = ""; writeCfg(node); }
        if (P.auto_mask) { P.auto_mask = ""; writeCfg(node); }
      }
      // The colour sheet NEVER survives a source change, Keep mask or not. The
      // render already resolved those colours into the result; carrying the sheet
      // onto it would stamp the same flat blobs over the detail it just made.
      if (P.colour) { P.colour = ""; writeCfg(node); }
    }
    node._rnStrokesFor = src;
  }

  // THE PANE OUTLIVES THE RENDER. Rebuilding the canvases for every button press is
  // the root under four separate bugs: the black flash, the ring sized from a 300px
  // default canvas, the hatch drawn at a stale scale, and Clear resurrecting a mask
  // through the reseed. While the picture is the same picture, the SAME canvas
  // elements are re-parented into the fresh DOM: pixels, listeners, zoom transform
  // and measured geometry all survive, so none of those states can recur. A new
  // source, or crossing into or out of full screen, still builds honestly fresh.
  const prevPane = node._rnPaintPane;
  const adopted = !!(src && prevPane && prevPane.src === src && prevPane.fs === fs
                     && prevPane.left);
  let left;
  if (adopted) {
    left = prevPane.left;
    zbar = prevPane.zbar || null;
    // the closures live-read the config, but their DISPLAYS were written at build
    // time: a configure that swapped node._rnCfg would otherwise show stale values
    prevPane.syncControls?.();
  } else {
  // ---- left: the picture with a brush over it
  left = document.createElement("div");
  left.className = "rn-ws-pcanvas";
  const tagL = document.createElement("span");
  tagL.className = "rn-ws-plabel";
  tagL.textContent = "Paint";
  left.appendChild(tagL);

  if (!src) {
    // an empty pane keyed to nothing must not leave old canvases adoptable: coming
    // back to the same file later has to rebuild against the config as it is THEN.
    // The pane's API goes with it, or a closure over canvases nobody can see keeps
    // answering questions about them, which showed as a stale Auto shape label.
    delete node._rnPaintPane;
    node._rnSyncShapeNote = null;
    node._rnShowAll = null;
    node._rnSeedBase = null;
    node._rnResetPaint = null;
    node._rnRebuildMask = null;
    node._rnMaskCanvas = null;
    node._rnPaintLayer = null;
    node._rnColourCanvas = null;
    node._rnRebuildColour = null;
    if (node._rnShapeNoteEl) node._rnShapeNoteEl.textContent = "";
    const empty = document.createElement("div");
    empty.className = "rn-ws-pempty";
    empty.textContent = "Drop an image here, or click to choose one. Use last result "
                      + "brings in the newest thing your workflow made.";
    empty.style.cursor = "pointer";
    empty.onclick = () => pickPaintSource(node);
    left.appendChild(empty);
  } else {
    // Rebuilding the DOM still creates new canvases, but a decoded picture can be
    // painted into them in this same JavaScript turn. Waiting for another onload,
    // even from browser cache, exposed the dark panel for one frame on every render.
    // Pending loads are shared too, so a settings render does not restart the request.
    const cachedPaintImage = node._rnPaintImageCache;
    const reusingPaintImage = cachedPaintImage?.source === src
      && !!cachedPaintImage.image;
    const img = reusingPaintImage ? cachedPaintImage.image : new Image();
    if (!reusingPaintImage) node._rnPaintImageCache = { source: src, image: img };
    const paintImageReady = !!(img.complete && img.naturalWidth && img.naturalHeight);
    const base = document.createElement("canvas");
    const layer = document.createElement("canvas");
    // A new canvas claims to be 300x150 before the picture has sized it. That is not
    // geometry, and treating it as geometry makes every render briefly resize the
    // brush ring and hatch around a made-up 300px source.
    let paintCanvasReady = false;
    layer.className = "paintlayer";
    // the colour sheet: real colours between the picture and the mask view, the
    // fourth canvas the design named. It shows itself, so it needs no hatch.
    const sheet = document.createElement("canvas");
    sheet.className = "paintcolour";
    left.append(base, sheet, layer);
    node._rnPaintLayer = layer;
    node._rnColourCanvas = sheet;

    // THE MASK AND THE LOOK OF IT ARE TWO DIFFERENT THINGS, and they used to be one
    // canvas. The brush drew at 55% alpha so you could see the picture underneath,
    // maskCanvas() exported that canvas's ALPHA as the mask, and so the see-through
    // look silently became the mask's STRENGTH: one pass of the brush meant "redo
    // this 55%". Worse, every pointer sample is its own stroke and consecutive
    // samples overlap, so alpha built up along the path and a slow drag came out near
    // solid while a fast one stayed near half. Paint In blends crop*(1-m) + back*m,
    // so an even-looking stroke landed unevenly, weakest where the hand moved fastest.
    // Erase had the mirror fault: destination-out at 0.55 removed 55% and left a
    // ghost, which is why erasing felt like scrubbing.
    //
    // So: `mask` is the truth, offscreen, always full alpha, and it is the only thing
    // the server ever sees. `layer` is a VIEW of it, drawn with a hatch you can see
    // through. Painting means redo this, at full strength, exactly as it does in every
    // other editor; softness belongs to Paint In's strength dial and to denoise, which
    // are the controls that say so out loud.
    const mask = node._rnMaskCanvas = document.createElement("canvas");
    const mctx = () => mask.getContext("2d");
    const lctx = () => layer.getContext("2d");
    // THE PANE OUTLIVES node._rnCfg. A configure replaces the config object while
    // these closures live on, so a captured P is a write to something nothing reads
    // and a read of values nobody can change. Every handler that runs after build
    // time goes through here instead.
    const livePaint = () => node._rnCfg?.paint || P;

    // The hatch tile: one light band and one dark band on a transparent ground, so it
    // reads on a bright sky and a black jacket without choosing a colour per image,
    // and the gaps are what you see the picture through.
    //
    // HOW THE OVERLAY LOOKS IS THE USER'S, an accessibility choice as much as taste:
    // a see-through hatch is unreadable to some people, and red is invisible to
    // others. Mode, opacity and colour come from the install-wide preferences; at
    // their defaults every number below reproduces the original look exactly, band
    // alpha 0.55 and tint 0.16, so nobody's panel changes uninvited.
    const tile = document.createElement("canvas");
    tile.width = tile.height = 8;
    let tileFor = "";
    const drawTile = (o) => {
      const t = tile.getContext("2d");
      t.clearRect?.(0, 0, 8, 8);
      t.lineWidth = 2;
      t.strokeStyle = `rgba(255,255,255,${o})`;
      t.beginPath(); t.moveTo(-2, 6); t.lineTo(6, -2); t.stroke();
      t.strokeStyle = `rgba(0,0,0,${o})`;
      t.beginPath(); t.moveTo(2, 10); t.lineTo(10, 2); t.stroke();
      tileFor = String(o);
    };
    const overlayLook = () => ({
      mode: String(wsPref("OverlayMode", "hatch")),
      o: Math.max(0.1, Math.min(1, (Number(wsPref("OverlayOpacity", 55)) || 55) / 100)),
      rgb: OVERLAY_COLORS[String(wsPref("OverlayColor", "red"))] || OVERLAY_COLORS.red,
    });
    drawTile(overlayLook().o);
    // Kept a constant size ON SCREEN rather than in image pixels. In image space the
    // hatch turns into a flat grey wash at fit on a big picture and into huge stripes
    // at 8x, and neither reads as a mask.
    let patScale = 0;
    let overlayDrawOwed = false;
    const imagePixelsPerVisualPixel = () => {
      if (!paintCanvasReady || !layer.width) return 0;
      const r = layer.getBoundingClientRect();
      return r.width > 0 ? layer.width / r.width : 0;
    };
    const pattern = (s) => {
      if (!s) return null;
      const p = lctx().createPattern(tile, "repeat");
      patScale = s;
      if (p && p.setTransform && typeof DOMMatrix === "function") {
        p.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
      }
      return p;
    };

    // Repaint the VIEW from the mask, over one rectangle. Per stroke segment that
    // rectangle is the segment's own bounding box, so the cost follows the brush
    // rather than the picture and a 4K frame still paints smoothly.
    const showRect = (rx, ry, rw, rh) => {
      // Tint without hatch is not a partial success: it is the reported flat red wash.
      // Defer both until one measured scale can paint them as a single honest view.
      const scale = imagePixelsPerVisualPixel();
      if (!scale) {
        patScale = 0;
        overlayDrawOwed = true;
        return false;
      }
      const c = lctx();
      rx = Math.max(0, Math.floor(rx)); ry = Math.max(0, Math.floor(ry));
      rw = Math.min(layer.width - rx, Math.ceil(rw));
      rh = Math.min(layer.height - ry, Math.ceil(rh));
      if (rw <= 0 || rh <= 0) return false;
      c.save();
      // the clip is what keeps destination-in from wiping the rest of the canvas
      c.beginPath();
      c.rect(rx, ry, rw, rh);
      c.clip();
      c.globalCompositeOperation = "source-over";
      c.clearRect(rx, ry, rw, rh);
      const look = overlayLook();
      if (look.mode === "flat") {
        // one colour at the chosen opacity, all the way to fully opaque: somebody
        // choosing flat is choosing "I must see the boundary" over "I must see
        // through it", and that trade is theirs to make
        c.fillStyle = `rgba(${look.rgb},${look.o})`;
        c.fillRect(rx, ry, rw, rh);
        patScale = scale;            // flat needs no rescale, so zooms stop repainting
      } else {
        // the tint keeps its original ratio to the bands, so the default opacity
        // reproduces the historic 0.16 tint exactly
        c.fillStyle = `rgba(${look.rgb},${+(look.o * 0.16 / 0.55).toFixed(4)})`;
        c.fillRect(rx, ry, rw, rh);
        if (tileFor !== String(look.o)) drawTile(look.o);
        const p = pattern(scale);
        if (p) { c.fillStyle = p; c.fillRect(rx, ry, rw, rh); }
      }
      c.globalCompositeOperation = "destination-in";
      c.drawImage(mask, rx, ry, rw, rh, rx, ry, rw, rh);
      c.restore();
      return true;
    };
    const showAll = () => {
      if (showRect(0, 0, layer.width, layer.height)) overlayDrawOwed = false;
    };

    // THE SAVED MASK IS ALSO A BASE COAT, but only when no strokes are waiting to be
    // replayed. P.mask already contains those strokes baked into the uploaded file;
    // drawing both would double paint strokes and make erased coverage reappear.
    // P.auto_mask stays independent, so it remains the base even while live strokes
    // sit above it.
    //
    // The AUTO base lives in its OWN config key rather than in `mask`. Export writes
    // the composite of base plus strokes back into `mask` every pass, so sharing one
    // key would bake the strokes into the base, and undoing a stroke would leave it
    // visibly still there.
    //
    // INVERTED ON THE WAY IN, which is the whole subtlety. The file follows ComfyUI's
    // convention, painted means TRANSPARENT, because that is what load_mask reads. The
    // mask canvas is the opposite: painted is opaque. So this is maskCanvas() run
    // backwards, and drawing the PNG straight in would mask precisely everything you
    // did not want.
    let baseImg = null;
    let baseFor = "";
    const drawBase = () => {
      if (!baseImg?.naturalWidth || !mask.width) return;
      const scratch = document.createElement("canvas");
      scratch.width = mask.width;
      scratch.height = mask.height;
      const s = scratch.getContext("2d");
      s.fillStyle = "#fff";
      s.fillRect(0, 0, scratch.width, scratch.height);
      s.globalCompositeOperation = "destination-out";
      s.drawImage(baseImg, 0, 0, scratch.width, scratch.height);
      mctx().globalCompositeOperation = "source-over";
      mctx().drawImage(scratch, 0, 0);
    };
    const rebuildMask = () => {
      mctx().clearRect(0, 0, mask.width, mask.height);
      drawBase();
      replayStrokes(node, mask);
      showAll();
      node._rnSyncShapeNote?.();
    };
    node._rnRebuildMask = rebuildMask;
    node._rnShowAll = showAll;
    // THE COLOUR SHEET'S TRUTH, rebuilt the same way the mask is: base coat from
    // the saved file, live strokes replayed on top. The saved file is skipped as
    // base while colour strokes are pending, because it already has them baked
    // in, the exact double-paint rule the mask fought over first.
    let colourBaseImg = null;
    const rebuildColour = () => {
      const sc = sheet.getContext("2d");
      sc.clearRect(0, 0, sheet.width, sheet.height);
      if (colourBaseImg?.naturalWidth) {
        sc.globalCompositeOperation = "source-over";
        sc.drawImage(colourBaseImg, 0, 0, sheet.width, sheet.height);
      }
      replayColour(node, sheet);
    };
    node._rnRebuildColour = rebuildColour;
    const colourBaseSrc = (node._rnStrokes || []).some((st) => st[8])
      ? "" : (P.colour || "");
    if (colourBaseSrc) {
      colourBaseImg = new Image();
      colourBaseImg.onload = () => {
        if ((livePaint().colour || "") === colourBaseSrc) rebuildColour();
      };
      colourBaseImg.onerror = () => {
        console.warn("[RedNode Workspace] the saved colour paint is gone:",
                     colourBaseSrc);
        colourBaseImg = null;
      };
      colourBaseImg.src = viewUrl(colourBaseSrc);
    }
    // What Automatic would pick, computed the way the server computes it. The scan
    // runs on a <=96px downsample and only at settle moments (a rebuild, a save),
    // never per stroke segment: at 4096 the full canvas is millions of pixels and a
    // scan mid-drag would be felt in the hand.
    const maskBounds = () => {
      try {
        if (!mask.width || !mask.height) return null;
        const step = Math.max(1, Math.ceil(Math.max(mask.width, mask.height) / 96));
        const sw = Math.max(1, Math.floor(mask.width / step));
        const sh = Math.max(1, Math.floor(mask.height / step));
        const scr = document.createElement("canvas");
        scr.width = sw;
        scr.height = sh;
        const sc = scr.getContext("2d");
        sc.drawImage(mask, 0, 0, sw, sh);
        if (typeof sc.getImageData !== "function") return null;  // no raster to ask
        const data = sc.getImageData(0, 0, sw, sh).data;
        let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            if (data[(y * sw + x) * 4 + 3] > 12) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) return null;
        return { x0: x0 * step, y0: y0 * step,
                 x1: Math.min(mask.width, (x1 + 1) * step),
                 y1: Math.min(mask.height, (y1 + 1) * step) };
      } catch (e) {
        return null;                                 // an unreadable canvas says nothing
      }
    };
    node._rnSyncShapeNote = () => {
      const el = node._rnShapeNoteEl;
      if (!el) return;
      const lp = livePaint();
      // blank is the honest state everywhere the number does not apply: Whole frame,
      // a manual shape, nothing painted yet. A stale label is worse than none.
      let text = "";
      // INVERTED IS DELIBERATELY BLANK. What the server boxes there is the mask the
      // other way up, so the region is everything OUTSIDE the paint: labelling the
      // painted blob would name a shape the render never uses, and a confidently
      // wrong readout is worse than none.
      if (lp.mask_only && !lp.invert && String(lp.region_shape || "auto") === "auto"
          && paintCanvasReady) {
        const box = maskBounds();
        const label = box ? autoShapeLabel(box, mask.width, mask.height) : "";
        if (label) text = `Auto: ${label}`;
      }
      el.textContent = text;
    };
    // The pane persists across renders now, so the two moments that used to lean on
    // a rebuild to change the base coat ask the pane directly: an auto mask landing
    // seeds it, Clear paint empties it. Without these, an adopted canvas would keep
    // showing whatever was on it, which is exactly the resurrection Clear once had.
    node._rnSeedBase = (file) => {
      const wanted = String(file || "");
      baseFor = wanted;
      if (!wanted) { baseImg = null; rebuildMask(); return; }
      baseImg = new Image();
      baseImg.onload = () => { if (baseFor === wanted) rebuildMask(); };
      baseImg.onerror = () => {
        console.warn("[RedNode Workspace] the auto mask is gone:", wanted);
        baseImg = null;
      };
      baseImg.src = viewUrl(wanted);
    };
    node._rnResetPaint = () => {
      baseImg = null;
      baseFor = "";
      rebuildMask();
    };
    node._rnResetColour = () => {
      colourBaseImg = null;
      rebuildColour();
    };
    // WHICH FILE IS THE BASE COAT depends on whether strokes are still pending, and
    // the two answers are different files:
    //
    // - Strokes PENDING: the auto mask is the base and the strokes replay on top of
    //   it, which is what lets an erase be undone back to the auto mask. `P.mask`
    //   must NOT be the base here, because it already has those strokes baked in and
    //   drawing both would double every one of them.
    // - NO strokes: `P.mask` is the composite of everything that has happened,
    //   including erases, and it is the truth. The auto mask is only the fallback for
    //   a slot that has one and has never been saved.
    //
    // Reported: Mask subject, erase part of it, generate, drag the result back with
    // Keep mask on. The picture change clears the strokes, and `P.auto_mask` used to
    // win unconditionally, so the canvas came back as the ORIGINAL segmenter output
    // and every erase since was lost.
    const baseSrc = node._rnStrokes?.length ? P.auto_mask : (P.mask || P.auto_mask);
    node._rnBaseFor = baseSrc || "";     // which file the coverage came from, for both
                                         // the guards and a console when one looks wrong
    if (baseSrc) {
      baseFor = baseSrc;
      baseImg = new Image();
      baseImg.onload = () => {
        // the SAME precedence the seed used, or this rejects the very file it just
        // asked for and the loaded base is thrown away
        const lp = livePaint();
        const want = node._rnStrokes?.length ? lp.auto_mask : (lp.mask || lp.auto_mask);
        if (baseFor === want) rebuildMask();
      };
      baseImg.onerror = () => {
        console.warn("[RedNode Workspace] the saved mask is gone:", baseFor);
        baseImg = null;
      };
      baseImg.src = viewUrl(baseSrc);
    }

    // THE VIEW: zoom and pan. Session state like the strokes, deliberately not in the
    // config: where you are zoomed is like where your mouse is, not part of the
    // picture, and it must never dirty the workflow or key a re-render.
    //
    // A CSS transform on BOTH canvases, identical, so they stay registered. Transform
    // is the right tool here even though the panel scale uses zoom: the brush maps
    // pointer to pixels through getBoundingClientRect, which reflects transforms, so
    // painting while zoomed needs no brush changes at all. The brush keeps covering
    // the same IMAGE pixels at any zoom, which is the point: zoom in and the same
    // brush does finer work.
    const V = node._rnView ||= { z: 1, x: 0, y: 0 };
    const applyView = () => {
      const t = V.z === 1 && !V.x && !V.y
        ? "" : `translate(${V.x}px, ${V.y}px) scale(${V.z})`;
      base.style.transform = t;
      sheet.style.transform = t;
      layer.style.transform = t;
      // The hatch is sized in SCREEN pixels, so a zoom change means redrawing it. A
      // pan does not: the picture moves, the scale does not, and repainting a 4K view
      // on every pointermove of a drag would be felt. Comparing against the scale the
      // pattern was last built at is what tells the two apart.
      const s = imagePixelsPerVisualPixel();
      if (!s) patScale = 0;
      else if (overlayDrawOwed || (patScale && Math.abs(s - patScale) > 0.001)) {
        showAll();
      }
      node._rnSyncZbar?.();
      node._rnSyncRing?.();
    };
    // m is measured from the pane CENTRE, because the canvases are flex-centred and
    // scale about their own middle: the image point under m stays put across z0->z1
    const zoomAt = (mx, my, z1) => {
      z1 = Math.max(1, Math.min(8, z1));
      if (z1 === V.z) return;
      V.x = mx - (z1 / V.z) * (mx - V.x);
      V.y = my - (z1 / V.z) * (my - V.y);
      V.z = z1;
      if (z1 === 1) { V.x = 0; V.y = 0; }
      applyView();
    };
    left.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = left.getBoundingClientRect();
      // 1.2 per notch, not 1.15: reported as feeling slow at the old rate
      zoomAt(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2,
             V.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });
    applyView();
    // A zoom is not the only thing that changes the hatch's on-screen scale. The pane
    // itself changes width when the layout reflows around it, an auto prompt caption
    // growing the settings column being the reported case, and a hatch drawn for the
    // old width aliases into a blocky grid of squares at the new one. Nothing below
    // re-measures on a reflow, so the wrong drawing stood until a zoom or a pointer
    // move happened to repaint it.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => {
        // Re-measure and repaint ONLY. render() from a resize callback rebuilds the
        // panel, which reflows the layout, which fires this again, forever.
        const s = imagePixelsPerVisualPixel();
        if (!s) return;
        if (overlayDrawOwed || !patScale || Math.abs(s - patScale) > 0.001) showAll();
        node._rnSyncRing?.();
      });
      ro.observe(left);
    }
    const drawPaintImage = () => {
      base.width = layer.width = img.naturalWidth;
      base.height = layer.height = img.naturalHeight;
      mask.width = layer.width;
      mask.height = layer.height;
      sheet.width = layer.width;
      sheet.height = layer.height;
      base.getContext("2d").drawImage(img, 0, 0);
      paintCanvasReady = true;
      // the strokes so far survive a re-render, so switching tabs is not destructive,
      // and the auto mask under them survives it the same way
      if (node._rnStrokes?.length || baseImg || overlayDrawOwed) rebuildMask();
      if ((node._rnStrokes || []).some((st) => st[8]) || colourBaseImg) {
        rebuildColour();
      }
      node._rnSyncRing?.();
      // the layout can hold the full height now, so a scroll restore the browser
      // clamped at render time is paid here, once. The still-at-zero check is what
      // keeps it from ever fighting you: a hand that scrolled since the render
      // moved the body off the clamp, and that position wins.
      const owed = node._rnScrollOwed;
      if (owed && owed.tab === node._rnBodyTab && node._rnBodyEl
          && Number(node._rnBodyEl.scrollTop || 0) === Number(owed.clamped || 0)) {
        node._rnBodyEl.scrollTop = owed.top;
      }
      delete node._rnScrollOwed;
    };
    img.onload = () => {
      const current = node._rnPaintImageCache;
      if (current?.image !== img || current.source !== node._rnCfg?.paint?.source) return;
      drawPaintImage();
    };
    img.onerror = () => {
      if (node._rnPaintImageCache?.image === img) delete node._rnPaintImageCache;
      delete node._rnPaintPane;      // a broken pane must not be adoptable: rebuild retries
      left.replaceChildren(tagL);
      const bad = document.createElement("div");
      bad.className = "rn-ws-pempty";
      bad.textContent = "That image is gone. Queue another run, or send one here from a "
                      + "gallery.";
      left.appendChild(bad);
    };
    if (paintImageReady) drawPaintImage();
    else if (!reusingPaintImage) img.src = viewUrl(P.source);

    let drawing = false;
    const at = (e) => {
      const r = layer.getBoundingClientRect();
      return [((e.clientX - r.left) / Math.max(1, r.width)) * layer.width,
              ((e.clientY - r.top) / Math.max(1, r.height)) * layer.height];
    };
    // Drawing a circle per pointer sample leaves GAPS on a fast drag, which is
    // what makes a brush feel like it needs clicking over and over. Join each
    // sample to the last with a round-capped line and the stroke is continuous
    // however fast you move.
    const stroke = (x0, y0, x1, y1, erase) => {
      const lp = livePaint();
      if (paintMode(node) === "colour") {
        // colour goes on the SHEET and records its colour as the 9th field; it
        // never touches the mask, the two passes stay deliberately separate
        const col = paintColour(node);
        maskSegment(sheet, x0, y0, x1, y1, lp.brush, erase,
                    lp.brush_shape || "round", col);
        (node._rnStrokes ||= []).push([x0, y0, x1, y1, lp.brush, erase ? 1 : 0,
                                       node._rnDragSeq, lp.brush_shape || "round",
                                       col]);
        node._rnColourDirty = true;
        return;
      }
      maskSegment(mask, x0, y0, x1, y1, lp.brush, erase, lp.brush_shape || "round");
      // repaint only what this segment touched, padded by the brush radius
      const pad = lp.brush / 2 + 2;
      showRect(Math.min(x0, x1) - pad, Math.min(y0, y1) - pad,
               Math.abs(x1 - x0) + pad * 2, Math.abs(y1 - y0) + pad * 2);
      // the 7th field names the DRAG this segment belongs to, so undo can take a
      // whole gesture back rather than one dot of it
      // the 8th field is the SHAPE, per segment: switch shapes mid-mask and an
      // undo replay must repaint each stroke the way it was made, not the way the
      // toggle happens to sit now
      (node._rnStrokes ||= []).push([x0, y0, x1, y1, lp.brush, erase ? 1 : 0,
                                     node._rnDragSeq, lp.brush_shape || "round"]);
    };
    // THE BRUSH RING. A circle showing what the brush will cover, which every paint
    // editor has and this had only a crosshair for, so brush size was a number you
    // guessed at and then undid.
    //
    // A DOM element rather than a CSS cursor: browsers cap a cursor image near 128px
    // and the brush goes to 400, which at 8x zoom is thousands of screen pixels. It
    // sits in `left`, a sibling of the canvases, so the canvases' transform does not
    // move it and the pane's overflow clips it at the edge.
    const ring = document.createElement("div");
    ring.className = "rn-ws-ring";
    left.appendChild(ring);
    let ringErase = false;
    node._rnSyncRing = () => {
      if (!node._rnLastPtr || node._rnPanMode) { ring.style.display = "none"; return; }
      const lr = left.getBoundingClientRect();
      // TWO coordinate spaces, and the ring lives in the inner one. clientX and the
      // rects are VISUAL pixels; the ring's transform is CSS pixels INSIDE the
      // panel's UI zoom, so a visual offset written straight into the transform
      // rendered zoom-times too far from the pane corner: the ring drifted off the
      // true brush point at any scale above 100%, worse with distance, and painting
      // read as "not where the mouse is" while the MARK was right all along, because
      // at() maps by ratio and never leaves visual space. Divide by the pane's own
      // measured zoom, the ratio of its visual width to its layout width, which
      // needs no knowledge of which ancestors zoom or by how much.
      const z = lr.width / Math.max(1, left.offsetWidth || lr.width);
      // Unknown scale stays unknown. Falling back to the canvas width made a fresh
      // browser canvas's default 300px size look like a valid answer until image load.
      const imagePerPx = imagePixelsPerVisualPixel();
      if (!imagePerPx) { ring.style.display = "none"; return; }
      // the SAME mapping the brush uses for SIZE, then into local pixels too
      const perPx = 1 / imagePerPx;
      const d = Math.max(3, (livePaint().brush * perPx) / z);
      ring.style.width = ring.style.height = `${d}px`;
      // minus 1: absolute children start inside the pane's 1px border, the rect
      // measures outside it
      const px = (node._rnLastPtr.x - lr.left) / z - 1;
      const py = (node._rnLastPtr.y - lr.top) / z - 1;
      ring.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
      ring.style.borderStyle = ringErase ? "dashed" : "solid";
      ring.style.borderColor = paintMode(node) === "colour"
        ? paintColour(node) : "#fff";
      // the ring IS the brush preview, so it takes the brush's shape: a circle
      // promising a square mark is the shape chooser looking broken
      ring.style.borderRadius = (livePaint().brush_shape === "square") ? "0" : "50%";
      ring.style.display = "block";
    };
    layer.addEventListener("pointermove", (e) => {
      node._rnLastPtr = { x: e.clientX, y: e.clientY };
      ringErase = !!e.ctrlKey || (e.buttons & 2) === 2;
      node._rnSyncRing();
    });
    layer.addEventListener("pointerenter", (e) => {
      node._rnLastPtr = { x: e.clientX, y: e.clientY };
      node._rnSyncRing();
    });
    layer.addEventListener("pointerleave", () => {
      node._rnLastPtr = null;
      ring.style.display = "none";
      // the moment the brush is put down. Saving here costs nothing anybody can see,
      // and it means the mask is already current before the mouse reaches Generate.
      if ((node._rnMaskDirty || node._rnColourDirty) && !drawing) {
        saveMaskNow(node);
      }
    });

    layer.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      left.focus?.({ preventScroll: true });
      // The middle button always pans, and the hand toggle makes the left button pan
      // too, for pens and tablets that have no middle button. At fit there is nothing
      // to move, so a pan gesture does nothing rather than sliding the picture out
      // from under the pane.
      if (e.button === 1 || (node._rnPanMode && e.button === 0)) {
        if (V.z <= 1) return;
        let gx = e.clientX, gy = e.clientY;
        layer.setPointerCapture?.(e.pointerId);
        const pmove = (ev) => {
          V.x += ev.clientX - gx;
          V.y += ev.clientY - gy;
          gx = ev.clientX; gy = ev.clientY;
          applyView();
        };
        const pup = (ev) => {
          layer.releasePointerCapture?.(ev?.pointerId ?? e.pointerId);
          layer.removeEventListener("pointermove", pmove);
          layer.removeEventListener("pointerup", pup);
          layer.removeEventListener("pointercancel", pup);
        };
        layer.addEventListener("pointermove", pmove);
        layer.addEventListener("pointerup", pup);
        layer.addEventListener("pointercancel", pup);
        return;
      }
      if (paintMode(node) === "colour" && e.button === 0
          && (node._rnEyedrop || e.altKey)) {
        // the eyedropper: the pixels are already here, on the picture and the
        // sheet; sample the composite of the two at the brush point
        const [sx, sy] = at(e);
        try {
          const scr = document.createElement("canvas");
          scr.width = scr.height = 1;
          const sc = scr.getContext("2d");
          sc.drawImage(base, Math.floor(sx), Math.floor(sy), 1, 1, 0, 0, 1, 1);
          sc.drawImage(sheet, Math.floor(sx), Math.floor(sy), 1, 1, 0, 0, 1, 1);
          const px = sc.getImageData(0, 0, 1, 1).data;
          node.properties = node.properties || {};
          node.properties.rn_paint_colour = "#" + [px[0], px[1], px[2]]
            .map((v) => v.toString(16).padStart(2, "0")).join("");
        } catch (err) { /* a tainted canvas keeps the old colour */ }
        node._rnEyedrop = false;
        node._rnSyncColourUI?.();
        node._rnSyncRing?.();
        return;
      }
      drawing = true;
      // a new stroke is a new undo unit, and it makes any redone future moot
      node._rnDragSeq = (node._rnDragSeq || 0) + 1;
      node._rnRedo = [];
      // right button erases, so a slip does not mean starting over
      const erase = e.button === 2 || e.ctrlKey;
      let [px, py] = at(e);
      stroke(px, py, px, py, erase);                 // a tap still marks a dot
      // The panel wrapper stops pointermove from propagating, so the canvas can be
      // dragged on without dragging the node behind it. That wall also sits between
      // this canvas and WINDOW, so window listeners never fire and a drag only ever
      // produced the first dot. Capture the pointer and listen on the layer itself:
      // capture retargets every later move here even when the pointer leaves it.
      layer.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        if (!drawing) return;
        ev.stopPropagation();
        const [x, y] = at(ev);
        stroke(px, py, x, y, erase);
        px = x; py = y;
      };
      const up = (ev) => {
        drawing = false;
        layer.releasePointerCapture?.(ev?.pointerId ?? e.pointerId);
        layer.removeEventListener("pointermove", move);
        layer.removeEventListener("pointerup", up);
        layer.removeEventListener("pointercancel", up);
        node._rnPaintDirty = true;
        node._rnSyncZbar?.();
        markMaskDirty(node);      // saved when the pointer leaves, not mid-gesture
      };
      layer.addEventListener("pointermove", move);
      layer.addEventListener("pointerup", up);
      layer.addEventListener("pointercancel", up);
    });
    layer.addEventListener("contextmenu", (e) => e.preventDefault());

    // ---- the zoom bar: view controls and the undo pair, in one row under the pane
    const redrawLayer = () => {
      // the mask is what undo and redo change; the view is repainted from it, and the
      // auto mask is put back first because undo takes back STROKES, not the base coat
      rebuildMask();
      rebuildColour();
      node._rnPaintDirty = true;
      node._rnColourDirty = true;    // an undone colour stroke must reach the file too
    };
    const undo = () => {
      const st = node._rnStrokes || [];
      if (!st.length) return;
      // one drag is many segments: undo takes back the GESTURE, or the button is a
      // joke that removes one dot of a line at a time
      const id = st[st.length - 1][6];
      const grp = [];
      do { grp.unshift(st.pop()); }
      while (st.length && id !== undefined && st[st.length - 1][6] === id);
      (node._rnRedo ||= []).push(grp);
      redrawLayer();
      node._rnSyncZbar?.();
    };
    const redo = () => {
      const grp = (node._rnRedo || []).pop();
      if (!grp) return;
      (node._rnStrokes ||= []).push(...grp);
      redrawLayer();
      node._rnSyncZbar?.();
    };
    zbar = document.createElement("div");
    zbar.className = "rn-ws-zbar";
    const zb = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "rn-ws-btn rn-ws-zb";
      b.textContent = txt;
      b.title = title;
      b.onclick = fn;
      zbar.appendChild(b);
      return b;
    };
    const handB = zb("\u270B", "Drag moves the view instead of painting. The middle "
      + "mouse button always pans; this is for pens and tablets without one.",
      () => { node._rnPanMode = !node._rnPanMode; node._rnSyncZbar?.(); });
    zb("\u2212", "zoom out", () => zoomAt(0, 0, V.z / 1.25));
    const pct = document.createElement("span");
    pct.className = "rn-ws-zpct";
    zbar.appendChild(pct);
    zb("+", "zoom in. The mouse wheel zooms at the pointer.",
      () => zoomAt(0, 0, V.z * 1.25));
    zb("Fit", "the whole picture in the pane again", () => zoomAt(0, 0, 1));

    // ---- the brush, with the other canvas tools. Size, then shape: round and
    // square, the two every paint editor agrees on. Soft edges are the Feather
    // dial's job, not a third shape.
    // The brush controls live in ONE wrapper so the room decides their home: on the
    // zoom bar in the node, on the primary bar beside denoise in full screen, which
    // is the concept's arrangement.
    const brushCtl = document.createElement("span");
    brushCtl.className = "rn-ws-pcard";
    const bTop = document.createElement("div");
    bTop.className = "top";
    const bLab = document.createElement("span");
    bLab.className = "rn-ws-zpct";
    bLab.style.minWidth = "0";
    bLab.textContent = "Brush";
    const bRng = document.createElement("input");
    bRng.type = "range";
    bRng.min = 2; bRng.max = 400; bRng.step = 1;
    bRng.value = P.brush;
    bRng.style.cssText = "width:110px;height:22px;cursor:pointer;accent-color:#b8283c";
    bRng.title = "How wide the brush is, in pixels of the source image.";
    const bVal = document.createElement("span");
    bVal.className = "rn-ws-zpct";
    bVal.style.minWidth = "34px";
    bVal.textContent = String(P.brush);
    const bSync = () => {
      const lp = livePaint();
      bVal.textContent = String(lp.brush);
      bRng.value = lp.brush;
      for (const [pb, pv] of bPills) {
        pb.className = "rn-ws-dpb" + (Number(lp.brush) === pv ? " on" : "");
      }
    };
    bRng.addEventListener("input", () => {
      livePaint().brush = snapStep(bRng.value, 2, 400, 1);
      bSync();
      writeCfg(node);
      node._rnSyncRing?.();
    });
    bTop.append(bLab, bRng, bVal);
    // size pills, from the concept: the sizes a hand actually flicks between
    const bPre = document.createElement("span");
    bPre.className = "rn-ws-dpre";
    const bPills = [];
    for (const pv of [32, 64, 128, 256, 400]) {
      const pb = document.createElement("button");
      pb.textContent = String(pv);
      pb.title = `brush ${pv}px`;
      pb.onclick = () => {
        livePaint().brush = pv;
        bSync();
        writeCfg(node);
        node._rnSyncRing?.();
      };
      bPre.appendChild(pb);
      bPills.push([pb, pv]);
    }
    bPre.classList?.add?.("under");
    const shapes = [["round", "\u26AA", "round brush: soft, even strokes"],
                    ["square", "\u2B1B", "square brush: hard corners, straight-edged "
                                        + "masks along architecture and frames"]];
    const shapeBtns = [];
    const syncShape = () => {
      for (const [bt, val] of shapeBtns) {
        bt.className = "rn-ws-btn rn-ws-zb"
          + ((livePaint().brush_shape || "round") === val ? " on" : "");
      }
    };
    for (const [val, glyph, tip] of shapes) {
      const bt = document.createElement("button");
      bt.textContent = glyph;
      bt.title = tip;
      bt.onclick = () => {
        livePaint().brush_shape = val;
        writeCfg(node);
        syncShape();
        node._rnSyncRing?.();
      };
      bTop.appendChild(bt);
      shapeBtns.push([bt, val]);
    }
    brushCtl.append(bTop, bPre);
    syncShape();
    bSync();
    const colourClu = buildColourCluster(node);
    if (fs) {
      // THE RAIL OWNS THE BRUSH in the big room, per your drawing: a vertical
      // bar filling the rail's empty middle, label at the top, value beneath it, the
      // shape toggles stacked below, and undo staying pinned at the rail's foot. The
      // size pills remain a card and node-room feature; the rail is too narrow to
      // wear them well.
      const rb = document.createElement("div");
      rb.style.cssText = "display:flex;flex-direction:column;align-items:center;"
                       + "gap:7px;flex:1 1 100px;min-height:90px";
      bLab.classList?.add?.("ttl");
      bRng.style.cssText = "writing-mode:vertical-lr;direction:rtl;width:26px;"
                         + "flex:1 1 60px;min-height:60px;cursor:pointer;"
                         + "accent-color:#b8283c";
      const shapeCol = document.createElement("div");
      shapeCol.style.cssText = "display:flex;flex-direction:column;gap:4px";
      for (const [bt] of shapeBtns) shapeCol.appendChild(bt);
      rb.append(bLab, bRng, bVal, shapeCol, colourClu.el);
      zbar.appendChild(rb);
    } else {
      // ONE line under the canvas, your sketch: view buttons with undo beside
      // Fit, then the brush stretched across the middle, then the size pills at the
      // right end, so the gap between the two pictures stays a single row tall
      brushCtl.className = "rn-ws-pcard rowline";
      bRng.style.width = "";
      bRng.style.flex = "1 1 120px";
      bTop.style.flex = "1 1 auto";
      brushCtl.append(bTop);
      zbar.appendChild(brushCtl);
      bPre.appendChild(colourClu.el);
      zbar.appendChild(bPre);
    }
    const sp = document.createElement("span");
    sp.className = "sp";
    zbar.appendChild(sp);
    const undoB = zb("\u21B6", "undo the last stroke. Ctrl+Z with the pointer on the "
                             + "picture works too.", undo);
    const redoB = zb("\u21B7", "redo. Ctrl+Y, or Ctrl+Shift+Z.", redo);
    if (fs) {
      // the vertical brush is the rail's flexible middle now; the old spacer would
      // fight it for the space
      sp.style.flex = "0 0 8px";
    }
    if (!fs) {
      // undo lives beside Fit, not exiled past the brush: the sketch's left cluster
      sp.remove();
      // index-based, because the harness's fake DOM has no nextSibling and the
      // real one does not need it either
      const kids = [...zbar.children];
      const fi = kids.indexOf(kids.find((c) => c.textContent === "Fit"));
      if (fi >= 0) {
        const anchor = kids[fi + 1] || null;
        zbar.insertBefore(undoB, anchor);
        zbar.insertBefore(redoB, anchor);
      }
    }
    node._rnSyncZbar = () => {
      pct.textContent = `${Math.round(V.z * 100)}%`;
      handB.className = "rn-ws-btn rn-ws-zb" + (node._rnPanMode ? " on" : "");
      // no system cursor in brush mode: the ring IS the cursor, and a crosshair on top
      // of it just adds a second thing following the mouse
      layer.style.cursor = node._rnPanMode ? "grab" : "none";
      node._rnSyncRing?.();
      undoB.disabled = !(node._rnStrokes || []).length;
      redoB.disabled = !(node._rnRedo || []).length;
    };
    node._rnSyncZbar();
    // keyboard, scoped to the pane rather than the document so nothing leaks and
    // nothing fires while you type in a prompt box
    left.tabIndex = -1;
    left.style.outline = "none";
    left.addEventListener("keydown", (e) => {
      if (!e.ctrlKey) return;
      const k = String(e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { undo(); e.preventDefault(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { redo(); e.preventDefault(); }
    });
    // The same canvas over the whole window, with the tools that mark it and nothing
    // else. Distinct from the panel's own Full screen, which brings the prompts, the
    // dials and the result pane too: this one is for drawing.
    left.appendChild(canvasOnlyButton(
      "Paint over the whole window: just this canvas and its tools. The panel's own "
      + "Full screen brings everything else with it.",
      () => openPaintCanvasOnly(node)));

    // What an adopting render refreshes: the displayed values, never the elements.
    // The closures read the live config at use time, so only the text and classes
    // written at build can go stale.
    const syncControls = () => {
      bSync();
      syncShape();
      colourClu.sync();
      node._rnSyncZbar?.();
    };
    node._rnPaintPane = { src, fs, left, zbar, syncControls, undo, redo, zoomAt,
                          rebuildMask, baseFor: () => baseFor };
  }
  // fresh pane only: re-registering on an adopted one would double the drop handlers
  paintDropZone(node, left);
  }
  // WHILE THE CANVAS-ONLY ROOM IS OPEN the pane lives in that overlay, and taking it
  // back here would empty the room you are painting in. The panel still renders
  // normally around a stand-in.
  if (node._rnCanvasOnly?.pane === left) {
    const held = document.createElement("div");
    held.className = "rn-ws-pempty";
    held.textContent = "Painting full screen. Close it to bring the canvas back here.";
    stage.appendChild(held);
  } else {
    stage.appendChild(left);
  }

  // ---- right: what came out
  const right = document.createElement("div");
  right.className = "rn-ws-presult";
  const tagR = document.createElement("span");
  tagR.className = "rn-ws-plabel";
  tagR.textContent = "Result";
  right.appendChild(tagR);
  const resultResolution = document.createElement("span");
  resultResolution.className = "rn-ws-presolution";
  resultResolution.style.display = "none";
  right.appendChild(resultResolution);
  const paintProgress = document.createElement("div");
  paintProgress.className = "rn-ws-pgen-progress";
  paintProgress.setAttribute("role", "progressbar");
  paintProgress.setAttribute("aria-label", "Paint generation progress");
  const paintProgressFill = document.createElement("div");
  paintProgressFill.className = "fill";
  paintProgress.appendChild(paintProgressFill);
  right.appendChild(paintProgress);
  node._rnPaintProgressEl = { root: paintProgress, fill: paintProgressFill };
  syncPaintProgress(node);
  if (node._rnPaintLive) paintLiveOverlay(node, right);
  if (shownResult) {
    // the pane shows the picked history entry if one is picked, else what was last put
    // here on purpose. The pick is display state only: Use last result and the mask
    // invariant read lastResult, so browsing history never changes what runs.
    const shown = node._rnResultView || shownResult;
    const rimg = document.createElement("img");
    rimg.src = resultUrl(shown);
    const syncResultResolution = () => {
      const w = Number(rimg.naturalWidth) || 0;
      const h = Number(rimg.naturalHeight) || 0;
      if (!w || !h) return;
      resultResolution.textContent = `${w} × ${h}`;
      resultResolution.style.display = "";
    };
    rimg.addEventListener("load", syncResultResolution);
    if (rimg.complete) requestAnimationFrame(syncResultResolution);
    // The result inspects the same way the paint pane does: wheel zooms at the
    // pointer, the middle button pans, double-click fits. Its view is its own state,
    // because comparing a zoomed-in result against a zoomed-out mask is the point.
    const RV = node._rnResView ||= { z: 1, x: 0, y: 0 };
    const applyRV = () => {
      rimg.style.transform = RV.z === 1 && !RV.x && !RV.y
        ? "" : `translate(${RV.x}px, ${RV.y}px) scale(${RV.z})`;
    };
    right.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = right.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      // matches the paint pane's own rate: both scroll under the same hand
      const z1 = Math.max(1, Math.min(8, RV.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (z1 === RV.z) return;
      RV.x = mx - (z1 / RV.z) * (mx - RV.x);
      RV.y = my - (z1 / RV.z) * (my - RV.y);
      RV.z = z1;
      if (z1 === 1) { RV.x = 0; RV.y = 0; }
      applyRV();
    }, { passive: false });
    rimg.addEventListener("pointerdown", (e) => {
      if (e.button !== 1 || RV.z <= 1) return;   // middle pans; left stays the drag
      e.preventDefault();
      e.stopPropagation();
      let gx = e.clientX, gy = e.clientY;
      rimg.setPointerCapture?.(e.pointerId);
      const mv = (ev) => {
        RV.x += ev.clientX - gx; RV.y += ev.clientY - gy;
        gx = ev.clientX; gy = ev.clientY;
        applyRV();
      };
      const up = (ev) => {
        rimg.releasePointerCapture?.(ev?.pointerId ?? e.pointerId);
        rimg.removeEventListener("pointermove", mv);
        rimg.removeEventListener("pointerup", up);
        rimg.removeEventListener("pointercancel", up);
      };
      rimg.addEventListener("pointermove", mv);
      rimg.addEventListener("pointerup", up);
      rimg.addEventListener("pointercancel", up);
    });
    rimg.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      RV.z = 1; RV.x = 0; RV.y = 0;
      applyRV();
    });
    applyRV();
    rimg.title = "Drag onto the Paint pane to paint on this image, or into a folder "
               + "in Explorer to drop a copy there. Right-click for actions.";
    // DRAG replaces the old click-adopts: a whole pane spending its click on one
    // action was a wasted surface, and dragging a picture onto the place you paint
    // is the gesture every editor already teaches
    rimg.draggable = true;
    rimg.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("application/x-rednode-result",
                              JSON.stringify(shown));
      // The same drag, carried out of the browser: DownloadURL is Chromium's drag-out,
      // and dropping on a Windows folder downloads the file there. Two payloads on one
      // gesture, each read only by its own destination: the Paint pane takes the line
      // above and Explorer takes this one. Firefox ignores it, and the internal drag
      // still works there. The URL must be absolute: relative ones are dropped as text.
      const base = window.location?.href;
      if (base) {
        const abs = new URL(resultUrl(shown), base).href;
        const name = String(shown.filename || "rednode_result.png").split("/").pop();
        const mime = /\.webp$/i.test(name) ? "image/webp"
                   : /\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png";
        ev.dataTransfer.setData("DownloadURL", `${mime}:${name}:${abs}`);
      }
      ev.dataTransfer.effectAllowed = "copy";
    });
    rimg.addEventListener("contextmenu", (ev) => openResultMenu(node, shown, ev));
    right.appendChild(rimg);
    const actions = document.createElement("div");
    actions.className = "rn-ws-pactions";
    const finalButton = (label, withPost, primary = false) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = primary ? "primary" : "";
      b.disabled = !!node._rnFinalBusy;
      b.title = withPost
        ? "Apply the Workspace Post tab once, then file that finished copy in Save. "
          + "The editable Paint source stays unprocessed."
        : "File this painted result in Save exactly as shown, without applying the "
          + "Workspace Post tab.";
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await runPaintFinal(node, shown, withPost);
        } catch (err) {
          console.error(`[RedNode Workspace] ${label} failed:`, err);
          alert(`${label} failed: ${err.message}`);
        }
      };
      return b;
    };
    actions.append(
      finalButton("Save", false),
      finalButton("Post + Save", true, true),
    );
    right.appendChild(actions);
    if (node._rnFinalStatus) {
      const status = document.createElement("div");
      status.className = "rn-ws-pstatus";
      status.textContent = node._rnFinalStatus;
      if (node._rnFinalFailed) status.style.color = "#fca5a5";
      right.appendChild(status);
    }
    if (resultHistory.length > 1) {
      // the strip: the last few runs, small on purpose, along the pane's bottom. It
      // exists for the two-pass way this tab is used, comparing denoise values, so
      // the compare is one click rather than a re-render.
      const strip = document.createElement("div");
      strip.className = "rn-ws-rstrip";
      for (const r of resultHistory) {
        const t = document.createElement("img");
        t.src = resultUrl(r);
        const current = (shown.filename === r.filename
                         && (shown.subfolder || "") === (r.subfolder || ""));
        t.className = "t" + (current ? " cur" : "");
        t.title = "Show this run in the pane. The newest run takes the pane back.";
        t.onclick = (e) => {
          e.stopPropagation();
          node._rnResultView = r;
          render(node);
        };
        strip.appendChild(t);
      }
      right.appendChild(strip);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "rn-ws-pempty";
    empty.textContent = "Your next result appears here.";
    right.appendChild(empty);
  }
  // THE TOOLBAR IS A ROW OF CONTROLS, so it only belongs BETWEEN the panes while
  // they are stacked. Side by side and Automatic-gone-wide put the panes in a flex
  // row, and a `flex:none` toolbar dropped in the middle of that row becomes a
  // full-height column between two slivers. In a row arrangement it goes under the
  // pair instead, which is what full screen already does with the rail.
  const paneRow = !fs && layoutPref !== "stacked";
  if (zbar && !fs && !paneRow) stage.appendChild(zbar);
  stage.appendChild(right);
  pmain.appendChild(stage);
  if (zbar && paneRow) {
    // Automatic may be stacked right now (a narrow node), but the toolbar sits
    // under the pair either way: that is the same place it occupies when stacked,
    // one row lower, so crossing the breakpoint never moves it.
    pmain.appendChild(zbar);
  }
  if (zbar && fs) {
    // the concept's tool rail: the same bar stood upright on the far left.
    // EVERY LINE HERE MUST BE IDEMPOTENT. The pane persists across renders now, so
    // this same zbar arrives already railed: `className +=` would append the class
    // again and again, and re-wrapping would nest one zoomed div per render, so the
    // rail grew by railScale to the power of however many buttons had been pressed.
    zbar.classList.add("rn-ws-zrail");
    const railScale = Math.max(0.7, Math.min(2.5, parseFloat(P.scale_rail) || 1));
    // the wrapper is remembered ON the bar rather than looked for among its
    // children: this same bar comes back on every adopted render, and identity is
    // the only reliable way to know whether it is already wrapped
    let railIn = zbar._rnRailIn || null;
    if (Math.abs(railScale - 1) >= 0.001) {
      if (!railIn) {
        // the zoom rides an inner wrapper: the rail is a flex item with siblings
        // after it, which is the exact shape that floated the footer three times
        railIn = document.createElement("div");
        railIn.dataset.railIn = "1";
        railIn.style.cssText = "display:flex;flex-direction:column;"
                             + "align-items:stretch;gap:7px;flex:1 1 auto;min-height:0";
        for (const c of [...zbar.children]) railIn.appendChild(c);
        zbar.appendChild(railIn);
        zbar._rnRailIn = railIn;
      }
      railIn.style.zoom = String(railScale);   // update in place, never re-wrap
    } else if (railIn) {
      // back to 100%: unwrap, so the dial can be turned down as well as up
      for (const c of [...railIn.children]) zbar.appendChild(c);
      railIn.remove();
      zbar._rnRailIn = null;
    }
    cols.insertBefore(zbar, cols.children[0] || null);
  }

  // ---- the controls that matter while inpainting
  const tools = document.createElement("div");
  tools.className = "rn-ws-row";
  const mk = (label, key, min, max, step, hint, wide = 170) => {
    const l = document.createElement("span");
    l.className = "rn-ws-note";
    l.textContent = label;
    const r = document.createElement("input");
    r.type = "range";
    r.min = min; r.max = max; r.step = step;
    r.value = P[key];
    r.style.cssText = `width:${wide}px;height:18px;accent-color:#b8283c`;
    r.title = hint;
    const v = document.createElement("span");
    v.className = "rn-ws-note";
    v.textContent = String(P[key]);
    r.addEventListener("input", () => {
      P[key] = snapStep(r.value, min, max, step);
      v.textContent = String(P[key]);
      writeCfg(node);
    });
    return [l, r, v];
  };
  // Denoise gets a row to itself. Picking it is the whole skill in this process, there
  // is no preset that gets it right, and it is the dial I move most while painting. At
  // 130px wide a 0.01 step meant fighting the mouse for the value I actually wanted.
  const dRow = document.createElement("div");
  dRow.className = "rn-ws-pcard";
  dRow.style.minWidth = "0";       // the grid column owns the width now
  const dHead = document.createElement("div");
  dHead.className = "head";
  const dTop = document.createElement("div");
  dTop.className = "top";
  const dLab = document.createElement("span");
  dLab.className = "rn-ws-note";
  dLab.style.cssText = "font-size:13px;font-weight:600;min-width:60px";
  dLab.textContent = "Denoise";
  const dRange = document.createElement("input");
  dRange.type = "range";
  dRange.min = 0; dRange.max = 1; dRange.step = 0.01;
  dRange.value = P.denoise;
  dRange.style.cssText = "width:100%;height:30px;cursor:pointer;"
                       + "accent-color:#b8283c";
  dRange.title = "How hard the painted area is repainted. Roughing a shape in wants "
               + "0.7 to 1.0; refining what is already there wants 0.25 to 0.45. There "
               + "is no right number, which is why this one is worth the room.";
  const dVal = document.createElement("span");
  dVal.className = "rn-ws-note";
  dVal.style.cssText = "font-size:15px;font-weight:700;min-width:44px;text-align:right;"
                     + "font-variant-numeric:tabular-nums";
  dVal.textContent = Number(P.denoise).toFixed(2);
  const dTrack = document.createElement("div");
  dTrack.className = "rn-ws-denoise-track";
  const dZones = document.createElement("div");
  dZones.className = "rn-ws-denoise-zones";
  const dZoneLabels = document.createElement("div");
  dZoneLabels.className = "rn-ws-denoise-labels";
  const zoneSpec = [
    { id: "small", label: "Small", color: "#45c46b",
      title: "Below 0.40: small, controlled changes" },
    { id: "detail", label: "Detail", color: "#e0aa35",
      title: "0.40 to 0.60: detail editing" },
    { id: "big", label: "Big", color: "#e05268",
      title: "Above 0.60: larger, more diverse changes" },
  ];
  const zoneEls = [];
  for (const z of zoneSpec) {
    const bar = document.createElement("span");
    bar.className = "rn-ws-denoise-zone";
    bar.style.color = z.color;
    bar.title = z.title;
    const label = document.createElement("span");
    label.textContent = z.label;
    label.title = z.title;
    dZones.appendChild(bar);
    dZoneLabels.appendChild(label);
    zoneEls.push({ ...z, bar, label });
  }
  const syncDenoiseZone = () => {
    const v = Number(P.denoise) || 0;
    const active = v < 0.4 ? "small" : (v <= 0.6 ? "detail" : "big");
    for (const z of zoneEls) {
      z.bar.classList.toggle("active", z.id === active);
      z.label.classList.toggle("active", z.id === active);
    }
    const z = zoneEls.find((x) => x.id === active);
    dRange.style.accentColor = z.color;
    dVal.style.color = z.color;
    dVal.title = z.title;
  };
  dTrack.append(dRange, dZones, dZoneLabels);
  dRange.addEventListener("input", () => {
    P.denoise = snapStep(dRange.value, 0, 1, 0.01);
    dVal.textContent = Number(P.denoise).toFixed(2);
    syncDenoiseZone();
    writeCfg(node);
  });
  // The four denoise values you actually works between, one click each. The
  // active pill doubles as a zone readout, and the pills live NEXT to the slider
  // rather than replacing it, because the slider is still how in-between values
  // happen. The brush is gone from this bar: it is a canvas tool and lives on the
  // zoom bar with the other canvas tools, which also hands denoise the full width.
  const dpre = document.createElement("div");
  dpre.className = "rn-ws-dpre";
  const dpbs = [];
  const syncDpre = () => {
    for (const [b, v] of dpbs) {
      b.className = "rn-ws-dpb"
        + (Math.abs((parseFloat(P.denoise) || 0) - v) < 0.004 ? " on" : "");
    }
  };
  for (const v of [0.4, 0.5, 0.6, 0.7]) {
    const b = document.createElement("button");
    b.textContent = v.toFixed(1);
    b.title = "set denoise to " + v.toFixed(1);
    b.onclick = () => {
      P.denoise = v;
      dRange.value = v;
      dVal.textContent = v.toFixed(2);
      syncDpre();
      syncDenoiseZone();
      writeCfg(node);
    };
    dpre.appendChild(b);
    dpbs.push([b, v]);
  }
  syncDpre();
  syncDenoiseZone();
  dRange.addEventListener("input", syncDpre);
  // PASSES BELONGS ON THIS ROW, not in the settings box, because it multiplies THIS
  // number and nothing else. Settling a shape means running the same low denoise over
  // the last result three or four times, and by hand that is drag the result onto the
  // canvas, Generate, drag, Generate: four waits and three pictures to ignore before
  // the one worth keeping. The count runs that chain inside one Generate, with the
  // same mask and the same crop, and hands back only the last picture.
  const pWrap = document.createElement("div");
  const pLab = document.createElement("span");
  pLab.className = "k";
  pLab.textContent = "Passes";
  const pInp = document.createElement("input");
  pInp.type = "number";
  pInp.min = 1; pInp.max = PASS_MAX; pInp.step = 1;
  pInp.value = String(P.passes ?? 1);
  pInp.title = "How many times Generate runs this denoise over its own result before "
             + "showing you anything. 1 is a single pass, the way it has always worked. "
             + "4 at a denoise of 0.25 does what four presses at 0.25 do, holding a "
             + "shape steady instead of letting it drift, with the mask and the crop "
             + "unchanged between passes and a fresh seed for each. Only the last "
             + "picture comes back. This drives RedNode Paint Render; a renderer of "
             + "your own wired through Paint Out and Paint In still runs once.";
  const syncPasses = () => {
    const n = Math.max(1, Math.min(PASS_MAX, Math.round(Number(P.passes) || 1)));
    pWrap.className = "rn-ws-passes" + (n > 1 ? " on" : "");
    pLab.title = n > 1
      ? `Every Generate runs ${n} passes at this denoise and shows you the last one.`
      : "One pass per Generate.";
  };
  pInp.addEventListener("change", () => {
    P.passes = Math.max(1, Math.min(PASS_MAX, Math.round(Number(pInp.value) || 1)));
    pInp.value = String(P.passes);
    syncPasses();
    writeCfg(node);
  });
  // A browser changes a FOCUSED number box on wheel, so clicking in here and then
  // scrolling the panel would quietly turn 1 pass into 6 with nothing said. The wheel
  // convention in this pack is for SLIDERS (rednode_wheel.js), and dropping the focus
  // is what keeps this box out of that gesture entirely.
  pInp.addEventListener("wheel", () => pInp.blur(), { passive: true });
  syncPasses();
  pWrap.append(pLab, pInp);
  dLab.classList?.add?.("ttl");
  dHead.append(dLab, dpre);
  dTop.append(dTrack, dVal, pWrap);
  dRow.append(dHead, dTop);
  topbar.appendChild(dRow);

  // ---- the settings, boxed by JOB. The open state lives on the node, never in P:
  // Paint Out hashes the whole paint config, so storing furniture there would make
  // opening a box needlessly re-render the picture.
  const sbox = (title, key, openByDefault = true) => {
    const bx = document.createElement("div");
    bx.className = title ? "rn-ws-sbox rn-ws-sect" : "rn-ws-sbox";
    pside.appendChild(bx);
    if (!title) return bx;
    const opened = node._rnPaintBoxes ||= {};
    const open = Object.prototype.hasOwnProperty.call(opened, key)
      ? !!opened[key] : !!openByDefault;
    const head = document.createElement("div");
    head.className = "head";
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = open ? "\u25be" : "\u25b8";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = title;
    head.append(arr, ttl);
    head.onclick = () => {
      node._rnPaintBoxes[key] = !open;
      render(node);
    };
    bx.appendChild(head);
    const content = document.createElement("div");
    content.className = "rn-ws-sbody";
    if (open) bx.appendChild(content);
    return content;
  };
  // What you SAY first, then the compact paint settings, then routing. Feather/CFG/
  // Steps stay above Use as reference, LoRAs and Rendered by so the sampling controls
  // read as one block before the wider workflow choices.
  autoSection(node, pside, "paint");
  const promptBox = sbox("Prompts", "prompts", true);
  const kwBox = sbox("Keywords", "keywords", false);
  const sampBox = sbox("Paint settings", "settings", true);
  const routeBox = sbox("Routing", "routing", false);
  const autoMaskBox = sbox("Auto mask", "auto_mask", true);
  const maskStateBox = sbox("Mask state", "mask_state", true);
  const srow = (label, key, min, max, step, digits, title) => {
    const r = document.createElement("div");
    r.className = "rn-ws-srow";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = min; rng.max = max; rng.step = step;
    rng.value = P[key] ?? min;
    rng.style.cssText = "flex:1 1 auto;min-width:60px;height:26px;cursor:pointer;"
                      + "accent-color:#b8283c";
    rng.title = title;
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = Number(P[key] ?? min).toFixed(digits);
    rng.addEventListener("input", () => {
      P[key] = snapStep(rng.value, min, max, step);
      v.textContent = Number(P[key]).toFixed(digits);
      writeCfg(node);
    });
    r.append(k, rng, v);
    sampBox.appendChild(r);
  };
  srow("Feather", "feather", 0, 64, 1, 0,
       "Softens the mask edge so the repaint blends instead of leaving a seam.");
  srow("CFG", "cfg", 1, 30, 0.1, 1,
       "How hard the sampler is pushed toward the prompt. Rides the cfg output of "
       + "RedNode Paint Out, and drives RedNode Paint Render directly.");
  srow("Steps", "steps", 1, 60, 1, 0,
       "Sampler steps for the paint pass. Rides the steps output of RedNode Paint "
       + "Out, and drives RedNode Paint Render directly.");

  // ---- Seed and Mask shape share one line. They are both compact, set-and-leave
  // controls, and icons keep the four aspect choices readable without spending half
  // the row on the words Auto / Square / Wide / Tall.
  {
    const wrap = document.createElement("div");
    // The ordinary settings-row class is what gives both labels the same small muted
    // type as Feather, CFG and Steps. A `k` class without this parent looks valid in
    // source but receives none of that styling.
    wrap.className = "rn-ws-srow rn-ws-seedline";
    const lab = document.createElement("span");
    lab.className = "k seedlab";
    lab.textContent = "Seed";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.className = "rn-ws-num";
    inp.style.width = "84px";
    inp.style.color = "#ddd";
    inp.value = String(P.seed ?? 0);
    inp.title = "The seed the paint run uses, out of RedNode Paint Out's seed socket. "
              + "Type one to repeat a result.";
    inp.onchange = () => {
      const v = parseInt(inp.value, 10);
      P.seed = Number.isFinite(v) && v >= 0 ? v : 0;
      inp.value = String(P.seed);
      // typing a seed IS asking for that seed, so random switches itself off rather
      // than overwriting the number on the next press
      P.seed_random = false;
      writeCfg(node); render(node);
    };
    // The word, not just an icon: a lone dice that highlights when active reads as
    // "press me to randomise" as easily as "random is on", and the wrong reading
    // cost a session of confusion once already.
    const dice = segSwitch([
      ["random", "\uD83C\uDFB2 Random", "A new seed is rolled before each Generate."],
      ["fixed", "\uD83D\uDCCC Fixed", "This exact seed runs every Generate, so an unchanged "
                                    + "setup is served from cache and nothing re-renders."],
    ], P.seed_random !== false ? "random" : "fixed",
    (v) => { P.seed_random = v === "random"; writeCfg(node); render(node); });
    wrap.append(lab, inp, dice);

    // Painted only: Whole frame has no crop to shape, so showing this there would
    // promise a control that cannot do anything.
    if (P.mask_only) {
      const shLab = document.createElement("span");
      shLab.className = "k masklab";
      shLab.textContent = "Mask shape";
      shLab.title = "The aspect the painted area grows toward. The crop only grows, "
                  + "so nothing painted is cut away.";
      const shSeg = document.createElement("div");
      shSeg.className = "rn-ws-seg";
      // A smaller minimum did nothing while flex-grow immediately filled the space
      // again. Refusing growth makes the bar stay at the four icons' natural width.
      shSeg.style.flex = "0 0 auto";
      const nowShape = String(P.region_shape || "auto");
      for (const [id, icon, name, why] of [
        ["auto", "\u2726", "Automatic",
         "Choose whichever of 1:1, 4:3, 3:4, 16:9 and 9:16 is already closest."],
        ["square", "\u25A1", "Square", "Grow the painted area toward 1:1."],
        ["landscape", "\u25AD", "Wide", "Grow it toward 4:3, adding room to the sides."],
        ["portrait", "\u25AF", "Tall", "Grow it toward 3:4, adding room above and below."],
      ]) {
        const b = document.createElement("button");
        b.className = "rn-ws-segb rn-ws-shapeb" + (nowShape === id ? " on" : "");
        b.dataset.shape = id;
        b.textContent = icon;
        b.setAttribute("aria-label", `${name} mask shape`);
        b.title = `${name}: ${why}`;
        b.onclick = () => { P.region_shape = id; writeCfg(node); render(node); };
        shSeg.appendChild(b);
      }
      // NEVER SHRINK, off by default. The size dial works in both directions now,
      // so a region bigger than the budget comes down to it: that is what makes a
      // control called size honest, and on a small card or a model with a low
      // native resolution it is the difference between a pass that works and one
      // that duplicates limbs or takes the machine down. This restores the old
      // refusal for work where every pixel of an already-large region matters.
      const floorB = segSwitch([
        ["target", "Size is a target", "The mask size is a target in BOTH directions, so a "
                                       + "big region is brought down to it."],
        ["floor", "Never shrink", "A region already bigger than the mask size renders at "
                                  + "its own size. Keeps every pixel of a large region, at "
                                  + "that region's cost; the VRAM tier ceiling still applies."],
      ], P.region_floor ? "floor" : "target",
      (v) => {
        const live = node._rnCfg?.paint || P;
        live.region_floor = v === "floor";
        writeCfg(node);
        render(node);
      });
      floorB.dataset.regionFloor = "1";

      // What Automatic actually picked, filled by the pane, which owns the mask
      // pixels. Blank whenever the answer does not apply, never stale.
      const shNote = document.createElement("span");
      shNote.className = "hint";
      shNote.style.cssText = "flex:none;font-size:10.5px;opacity:.6";
      node._rnShapeNoteEl = shNote;
      wrap.append(shLab, shSeg, floorB, shNote);
    } else {
      // Whole frame has no region to shape, so the readout must vanish with the row
      node._rnShapeNoteEl = null;
    }
    sampBox.appendChild(wrap);
    node._rnSyncShapeNote?.();
  }

  const row2 = document.createElement("div");
  row2.className = "rn-ws-row";
  row2.style.flexWrap = "wrap";
  // Painted / Whole frame / Inverted: ONE three-way switch where two toggles stood.
  // mask_only and invert can express four states but only three mean anything, since
  // inverting a mask the sampler ignores does nothing, and two toggles made the
  // useless fourth state reachable while hiding that the three real ones are
  // alternatives. The config still stores mask_only and invert, so nothing saved
  // changes shape and Paint Out reads exactly what it always read.
  const seg = document.createElement("div");
  seg.className = "rn-ws-seg";
  const segBtn = (label, title, active, apply) => {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (active ? " on" : "");
    b.textContent = label;
    b.title = title;
    b.onclick = () => { apply(); writeCfg(node); render(node); };
    seg.appendChild(b);
    return b;
  };
  segBtn("Painted",
         "Only what you painted changes; everything else is held to the source at "
         + "every step.",
         P.mask_only && !P.invert,
         () => { P.mask_only = true; P.invert = false; });
  segBtn("Whole frame",
         "The whole picture is repainted from the source at this denoise, and the "
         + "brush is ignored.",
         !P.mask_only,
         () => { P.mask_only = false; P.invert = false; });
  segBtn("Inverted",
         "What you painted is what STAYS, and everything else is repainted. Quicker "
         + "when the thing you want kept is smaller than the thing you want redone.",
         P.mask_only && P.invert,
         () => { P.mask_only = true; P.invert = true; });
  // Mask size on the primary bar, in the mode's old slot: and the
  // right one, it is the dial that decides what a paint pass costs and where it
  // lived buried it below the fold in the big room.
  const maskCtl = document.createElement("span");
  maskCtl.className = "rn-ws-pcard";
  maskCtl.style.cssText = "flex:3 1 300px;min-width:250px";
  const mTop = document.createElement("div");
  mTop.className = "top";
  const mLab = document.createElement("span");
  mLab.className = "rn-ws-zpct";
  mLab.style.minWidth = "0";
  mLab.textContent = "Mask size";
  const mRng = document.createElement("input");
  mRng.type = "range";
  // THE INPUT RUNS IN POSITIONS, NOT SIZES. A linear 512..4096 slider gave the
  // 1280..1536 band a hand actually works in 7 percent of the travel and handed 57
  // to the reach above 2048, so precise drags were impossible exactly where they
  // matter. maskPosOf/maskValueOf give each band a chosen share of the track, and
  // the zone bar's grid shares the same numbers so handle and colour agree.
  // mRng.value is therefore NEVER a size: convert before snapping, or the slider
  // silently writes sizes between 512 and 1000 while the readout looks plausible.
  mRng.min = 0; mRng.max = MASK_POS_MAX; mRng.step = 1;
  mRng.value = maskPosOf(P.mask_size);
  mRng.style.cssText = "width:100%;height:22px;cursor:pointer;accent-color:#b8283c";
  mRng.title = "The resolution a paint pass runs at. On Painted it is a pixel BUDGET, "
             + "so a long region gets the same detail as a compact one rather than "
             + "being rationed by its longest side, and a region already bigger than "
             + "the budget renders at its own size instead of being shrunk. On Whole "
             + "frame it is the resolution the frame is scaled TO, in both directions, "
             + "and the frame comes back at that size: above the picture it is an "
             + "upscale pass, below it the whole picture goes through at your working "
             + "size. The VRAM tier is the ceiling either way: "
             + `${WHOLE_FRAME_CAPS.low} on low, ${WHOLE_FRAME_CAPS.medium} on `
             + `medium, ${WHOLE_FRAME_CAPS.high} on high.`;
  const mVal = document.createElement("span");
  mVal.className = "rn-ws-zpct";
  mVal.style.minWidth = "38px";
  mVal.textContent = String(P.mask_size);
  const mTrack = document.createElement("div");
  mTrack.className = "rn-ws-mask-track";
  const mZones = document.createElement("div");
  mZones.className = "rn-ws-mask-zones";
  const mRisk = document.createElement("div");
  mRisk.className = "rn-ws-mask-risk";
  const maskZoneSpec = [
    { id: "low", label: "Low / standard VRAM", color: "#45c46b",
      title: "512 to 1280: low to standard relative VRAM use" },
    { id: "medium", label: "Medium VRAM", color: "#e0aa35",
      title: "1281 to 1536: medium relative VRAM use" },
    { id: "high", label: "High VRAM", color: "#e05268",
      title: "1537 to 2048: high relative VRAM use" },
    { id: "very-high", label: "Very high VRAM", color: "#ff334f",
      title: "Above 2048: very high relative VRAM use" },
  ];
  const maskZoneEls = [];
  for (const z of maskZoneSpec) {
    const bar = document.createElement("span");
    bar.className = "rn-ws-mask-zone";
    bar.style.color = z.color;
    bar.title = z.title;
    mZones.appendChild(bar);
    maskZoneEls.push({ ...z, bar });
  }
  const maskZoneFor = (value) => {
    const v = Number(value) || MASK_MIN;
    if (v <= 1280) return maskZoneEls[0];
    if (v <= 1536) return maskZoneEls[1];
    if (v <= 2048) return maskZoneEls[2];
    return maskZoneEls[3];
  };
  mTrack.append(mRng, mZones, mRisk);
  mRng.addEventListener("input", () => {
    P.mask_size = snapStep(maskValueOf(mRng.value), MASK_MIN, MASK_MAX, 64);
    mVal.textContent = String(P.mask_size);
    writeCfg(node);
  });
  const mHead = document.createElement("div");
  mHead.className = "head";
  mLab.classList?.add?.("ttl");
  const mPre = document.createElement("span");
  mPre.className = "rn-ws-dpre";
  const mPills = [];
  const mSync = () => {
    mVal.textContent = String(P.mask_size);
    mRng.value = maskPosOf(P.mask_size);        // position, never the size itself
    const active = maskZoneFor(P.mask_size);
    for (const z of maskZoneEls) z.bar.classList.toggle("active", z === active);
    mRng.style.accentColor = active.color;
    mVal.style.color = active.color;
    mVal.title = active.title;
    mRisk.textContent = active.label;
    mRisk.style.color = active.color;
    for (const [pb, pv] of mPills) {
      const risk = maskZoneFor(pv).id;
      pb.className = `rn-ws-dpb risk-${risk}`
                   + (Number(P.mask_size) === pv ? " on" : "");
    }
  };
  for (const pv of [1024, 1280, 1536, 1792, 2048]) {
    const pb = document.createElement("button");
    pb.textContent = String(pv);
    pb.title = `mask size ${pv}px`;
    pb.onclick = () => { P.mask_size = pv; mSync(); writeCfg(node); };
    mPre.appendChild(pb);
    mPills.push([pb, pv]);
  }
  mRng.addEventListener("input", mSync);
  // THE RESIZE BUTTON: make the source THIS size, now, without a render. It is the
  // Resize Reference node's job done in place, a canvas resample that keeps aspect,
  // so getting a picture to the chosen resolution stops costing a trip through the
  // graph. It shares the whole-frame maths and the tier cap through resampleTarget,
  // so the number on this row means one thing everywhere. It is NOT an upscaler:
  // pushed far past the source it looks soft, exactly like Resize Reference.
  const resizeB = document.createElement("button");
  resizeB.className = "rn-ws-btn rn-ws-zb";
  resizeB.textContent = node._rnResizing ? "⋯" : "⤢";
  resizeB.disabled = !src || !!node._rnResizing;
  resizeB.title = !src
    ? "Bring in a picture first."
    : "Resample the source so its long edge is the mask size, keeping aspect. A plain "
      + "resize, not an upscaler: the same thing the Resize Reference node does. A "
      + "size at or below the picture's own is ignored, never applied, and the VRAM "
      + "tier's ceiling still applies. With Keep mask on, the mask survives the trip.";
  resizeB.onclick = async () => {
    if (node._rnResizing) return;
    const live = node._rnCfg?.paint || P;
    if (!live.source) return;
    node._rnResizing = true;
    render(node);
    try {
      // reuse the decoded picture when it is the one on the canvas, else load it
      const cached = node._rnPaintImageCache;
      let im = cached?.source === live.source && cached.image?.complete
        && cached.image.naturalWidth ? cached.image : null;
      if (!im) {
        im = new Image();
        await new Promise((ok, bad) => {
          im.onload = ok;
          im.onerror = () => bad(new Error("could not load the source to resize"));
          im.src = viewUrl(live.source);
        });
      }
      const t = resampleTarget(im.naturalWidth, im.naturalHeight, live.mask_size,
                               node._rnCfg?.vram_tier);
      node._rnLastResize = t;                        // console diagnosis and tests
      if (t.noop) {
        // SAY it rather than silently doing less than the number on screen: a capped
        // or pointless resize that looks like success reads as the button being broken
        console.log(`[RedNode Workspace] resize skipped: source is `
                  + `${im.naturalWidth}x${im.naturalHeight}, `
                  + (t.capped ? `the ${node._rnCfg?.vram_tier} tier caps the ask` :
                     `already at or past ${live.mask_size}`));
        alert(t.capped
          ? "The VRAM tier's ceiling is at or below the picture's own size, so there "
            + "is nothing to grow. Raise the tier in the footer for more."
          : "The picture already meets that size. A resize never shrinks.");
        return;
      }
      // NOT normalisedUpload: that helper caps at STORE_MAX_EDGE for gallery thumbs,
      // and a deliberate resize to 4096 silently coming back 2048 is this feature
      // looking broken while reporting success
      const cnv = document.createElement("canvas");
      cnv.width = t.w;
      cnv.height = t.h;
      cnv.getContext("2d").drawImage(im, 0, 0, t.w, t.h);
      const blob = await new Promise((r) => cnv.toBlob(r, "image/png"));
      if (!blob) throw new Error("the canvas produced nothing");
      const stem = String(live.source).split(/[\\/]/).pop()
        .replace(/[.][^.]+$/, "").replace(/^resized_\d+_/, "") || "image";
      const bodyFd = new FormData();
      bodyFd.append("image", blob, `resized_${t.w > t.h ? t.w : t.h}_${stem}.png`);
      bodyFd.append("type", "input");
      bodyFd.append("subfolder", "rednode/paint");
      const res = await api.fetchApi("/upload/image", { method: "POST", body: bodyFd });
      const d = await res.json();
      if (!d.name) throw new Error("the upload returned no name");
      const after = node._rnCfg?.paint || live;
      after.source = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
      if (t.capped) {
        // the clamp is SAID even when the resize ran: the dial still shows the
        // asked-for number, and a quietly smaller result is the request and the
        // outcome disagreeing, which reads as the button being broken
        const got = Math.max(t.w, t.h);
        console.log(`[RedNode Workspace] resize clamped by the `
                  + `${node._rnCfg?.vram_tier} tier: ${t.w}x${t.h}, not `
                  + `${after.mask_size}`);
        alert(`Asked for ${after.mask_size} but the ${node._rnCfg?.vram_tier} tier `
            + `caps it, so the picture is now ${got}. Raise the tier in the footer `
            + `for more.`);
      }
      writeCfg(node);
      // the source changed, so the strokes-follow-the-picture funnel in the next
      // render decides the mask's fate exactly as a drop would: Keep mask keeps it
    } catch (e) {
      console.error("[RedNode Workspace] resize failed:", e);
      alert(`Could not resize: ${e.message}`);
    } finally {
      node._rnResizing = false;
      render(node);
    }
  };
  const queueBadge = document.createElement("span");
  queueBadge.className = "rn-ws-pqueue";
  node._rnPaintQueueBadge = queueBadge;
  mHead.append(mLab, mPre, resizeB, queueBadge);
  mTop.append(mTrack, mVal);
  maskCtl.append(mHead, mTop);
  mSync();
  syncPaintBatchUi(node);
  const barRight = document.createElement("span");
  barRight.style.cssText = "display:flex;gap:10px;flex:1 1 0;min-width:0;"
                         + "align-items:stretch";
  maskCtl.style.cssText = "flex:1 1 auto;min-width:0";
  barRight.appendChild(maskCtl);

  // Mask shape stays out of this primary bar so Denoise and Mask size keep the room
  // they need. Its four compact icons live beside Seed in the settings box.
  topbar.appendChild(barRight);
  // Generate above, the mode beneath it, one stacked block per your layout
  // NOT one box: Generate and the mode are two boxes stacked, each its own, and the
  // mode's box takes the width its three words need rather than being squeezed to
  // the button's width. The pair parks hard against the bar's right edge.
  const genWrap = document.createElement("span");
  genWrap.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;"
                        + "align-items:stretch;align-self:stretch";
  genWrap.appendChild(seg);
  barRight.appendChild(genWrap);

  const open = document.createElement("button");
  open.className = "rn-ws-btn rn-ws-compact";
  open.style.width = "auto";
  open.style.padding = "0 10px";
  open.textContent = "Open image";
  open.title = "Choose a picture to paint on. You can also drop one straight onto the "
             + "canvas.";
  open.onclick = () => pickPaintSource(node);

  const useLast = document.createElement("button");
  useLast.className = "rn-ws-btn rn-ws-compact";
  useLast.style.width = "auto";
  useLast.style.padding = "0 10px";
  useLast.textContent = "Use last result";
  useLast.disabled = !lastResult;
  useLast.title = lastResult
    ? "Pull the newest image out of your workflow onto the canvas. A one-off: nothing "
      + "arrives here on its own except what this tab's own Generate makes."
    : "Nothing has come out of the workflow yet.";
  // A PULL, not a mode. It used to blank the source, which meant "follow the
  // workflow", so pressing it once signed you up for every later queue replacing the
  // picture. Now it pins the file it found, through the same path the result pane's
  // own "Paint on this image" uses.
  useLast.onclick = () => {
    if (!lastResult) return;
    showResult(lastResult, node);    // asked for, so now it may appear on the pane
    adoptResult(node, lastResult, "Use last result pressed");
  };

  // AUTO MASK. Outlining a person by hand is the right tool for a patch and the wrong
  // one for "everything except this person", which is the whole of a background
  // replacement. The server drives whichever segmenter is installed and hands back an
  // ordinary mask file, so feathering, inverting, the region crop and Generate are all
  // the machinery that already exists.
  // "Mask background", not "Background": this tab already has Subject, Scene and
  // Moodboard reference toggles, so a bare "Subject" button doing something entirely
  // different sits two inches from one that does not.
  for (const [label, want, why] of [
    ["Mask background", "background",
     "Mask everything except the subject, so a repaint replaces the background. Adds "
     + "to the canvas like paint: the brush can tidy it afterwards, and Clear paint "
     + "takes it away. Needs a segmenter installed; the console says if none is."],
    ["Mask subject", "subject",
     "Mask the subject instead of the background. The same mask the other way up."],
  ]) {
    const auto = document.createElement("button");
    auto.className = "rn-ws-btn rn-ws-automask rn-ws-compact";
    auto.style.width = "auto";
    auto.style.padding = "0 10px";
    auto.dataset.want = want;
    auto.textContent = node._rnAutoMasking === want ? "Working..." : label;
    auto.disabled = !src || !!node._rnAutoMasking;
    auto.title = src ? why : "Bring in a picture first.";
    auto.onclick = async () => {
      if (node._rnAutoMasking) return;
      node._rnAutoMasking = want;
      render(node);
      try {
        const res = await api.fetchApi("/rednode/auto_mask", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: P.source, want }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        // Through the LIVE config, not the P captured when this button was built. The
        // render above, the one that puts "Working..." on the button, can replace
        // node._rnCfg, and writing to the old object then lands on something nothing
        // reads: the mask came back, the panel said nothing, and the key stayed empty.
        const live = node._rnCfg?.paint || P;
        // it REPLACES rather than adding to what is there, which is what you
        // asked for: press it and the canvas shows that mask. The strokes go with it,
        // because they were drawn against a mask that is no longer the one underneath.
        live.auto_mask = d.mask;
        // the segmenter replaces mask coverage; colour paint is not coverage
        node._rnStrokes = (node._rnStrokes || []).filter((st) => st[8]);
        node._rnRedo = [];
        writeCfg(node);
        // the pane persists across renders, so the new base coat is seeded here
        // rather than by the rebuild that no longer happens
        node._rnSeedBase?.(d.mask);
        // an auto mask is a mask like any other, so an ordinary queue must get it too.
        // Safe to do straight away: this is a press, not a brush stroke, and the panel
        // is already rebuilding around it.
        saveMaskNow(node);
      } catch (e) {
        console.error("[RedNode Workspace] auto mask failed:", e);
        alert(`Could not make that mask: ${e.message}`);
      } finally {
        node._rnAutoMasking = "";
        render(node);
      }
    };
    row2.appendChild(auto);
  }

  // CUT. Not a render: it takes the picture and the mask that are already here and
  // writes the masked part out as a PNG with the rest transparent. The natural partner
  // to Mask subject, and there is no reason to sample anything to get it.
  //
  // The server writes the FILE. A ComfyUI IMAGE is three channels, so a cutout sent
  // down a wire arrives with its alpha discarded and a black background where the
  // transparency was; only the file keeps it, and only as a PNG.
  const cut = document.createElement("button");
  cut.className = "rn-ws-btn rn-ws-compact";
  cut.style.width = "auto";
  cut.style.padding = "0 10px";
  cut.textContent = node._rnCutting ? "Cutting..." : "Cut";
  // ANY coverage counts, exactly as Generate does. Asking only about the SAVED mask
  // meant a canvas with a mask plainly on it could still leave this greyed out, which
  // is the same fault Generate had: the panel arguing with what is on screen. Strokes
  // count, an auto mask counts, and a saved mask counts.
  const haveMask = !!(P.mask || P.auto_mask || node._rnStrokes?.length);
  cut.disabled = !src || !!node._rnCutting || !haveMask;
  cut.title = !src ? "Bring in a picture first."
    : !haveMask
      ? "Paint a mask first, or press Mask background or Mask subject."
      : "Write the masked part out as a PNG with the rest transparent, into "
        + "output/cutouts. No sampling, so it is instant. It lands in the result pane, "
        + "where Save files it. Inverted flips which side is kept, the same as it does "
        + "for a render. Save it as a PNG: jpeg and webp cannot carry transparency.";
  cut.onclick = async () => {
    if (node._rnCutting) return;
    // SNAPSHOT FIRST, before the render below can rebuild the canvas. The same reason
    // Generate does it: reading the mask after a re-render hands back a blank one,
    // because the strokes are only replayed once the picture's onload fires.
    const canvas = node._rnMaskCanvas;
    const snapshot = canvas ? maskCanvas(canvas, P.feather) : null;
    node._rnCutting = true;
    render(node);
    try {
      const live = node._rnCfg?.paint || P;
      // Cut what is ON SCREEN, not what was last saved. Relying on the saved mask made
      // this cut a stale one whenever the auto-save had not fired yet, which is the
      // same staleness the Save mask button used to cause before it was retired.
      const mask = snapshot ? await uploadMask(node, snapshot)
                            : (live.mask || live.auto_mask);
      if (snapshot) { live.mask = mask; node._rnMaskDirty = false; writeCfg(node); }
      const res = await api.fetchApi("/rednode/cut", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: live.source, mask,
                               invert: !!live.invert }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      // straight to the result pane, which is where anything finished belongs, and
      // NOT onto the canvas: a cutout is an output, not the next thing to paint on
      showResult({ ...d.result, rand: (Math.random() * 1e9) | 0, prompt_id: "" },
                 node);
    } catch (e) {
      console.error("[RedNode Workspace] cut failed:", e);
      alert(`Could not cut that out: ${e.message}`);
    } finally {
      node._rnCutting = false;
      render(node);
    }
  };
  row2.appendChild(cut);

  // KEEP MASK, for the upscale round trip: send a picture out, bring the bigger version
  // back, and paint the same region again without redrawing it. The server already
  // rescales a mask to whatever picture it is given, so a different SIZE has always
  // worked; the caveat is aspect, because that rescale stretches rather than fits.
  const keep = document.createElement("button");
  keep.className = "rn-ws-btn rn-ws-compact" + (P.keep_mask ? " on" : "");
  keep.style.width = "auto";
  keep.style.padding = "0 10px";
  keep.textContent = P.keep_mask ? "Keeping mask" : "Keep mask";
  keep.title = P.keep_mask
    ? "A new picture keeps this mask. Brush strokes still go, because they are "
      + "recorded in the old picture's pixels and would land somewhere else. The mask "
      + "itself is stretched to fit, so the same shape at a different size is exact "
      + "and a different aspect ratio is not."
    : "Off: a new picture starts with a clean mask, which is right unless the new "
      + "picture is the same one back at another size. Turn this on for an upscale "
      + "round trip.";
  keep.onclick = () => {
    const live = node._rnCfg?.paint || P;
    live.keep_mask = !live.keep_mask;
    writeCfg(node);
    render(node);
  };
  const clear = document.createElement("button");
  clear.className = "rn-ws-btn rn-ws-compact";
  clear.style.width = "auto";
  clear.style.padding = "0 10px";
  clear.textContent = "Clear paint";
  clear.title = "Wipe the current mode's work: in Mask mode the strokes and any "
              + "saved or auto mask, in Colour mode the painted colours. The other "
              + "mode's work and the picture underneath are untouched.";
  clear.onclick = () => {
    const live = node._rnCfg?.paint || P;
    if (paintMode(node) === "colour") {
      // only the coloured strokes and the sheet go; the mask keeps its coverage
      node._rnStrokes = (node._rnStrokes || []).filter((st) => !st[8]);
      if (live.colour) { live.colour = ""; writeCfg(node); }
      node._rnColourDirty = false;
      node._rnPaintDirty = true;
      node._rnResetColour?.();
      render(node);
      return;
    }
    node._rnStrokes = (node._rnStrokes || []).filter((st) => st[8]);
    // Both files are base coats when the pane rebuilds. Clearing only the strokes
    // lets either one redraw the coverage immediately after Clear appears to wipe it.
    if (live.mask || live.auto_mask) {
      live.mask = "";
      live.auto_mask = "";
      writeCfg(node);
    }
    // No mask is deliberately an empty config value. Uploading a blank PNG here leaves
    // a truthy filename that passes Generate's coverage guard and races the old base
    // image load, which is why Clear used to need several presses.
    node._rnMaskDirty = false;
    node._rnPaintDirty = true;
    // the pane persists across renders: without this, the adopted canvas would keep
    // showing the coverage Clear just removed, which is the old resurrection again
    node._rnResetPaint?.();
    render(node);
  };

  // SAVE MASK IS GONE, because it was never your job. The mask now uploads by
  // itself when a stroke ends and when an auto mask lands, so what an ordinary queue
  // paints through is always what is on screen. Clear stores NO mask instead of
  // uploading an empty one. The button was not broken, it was manual: paint, queue
  // normally without remembering to press it, and the run silently used the previous
  // mask. Its own tooltip warned about exactly that, which is the tell that it should
  // never have been a button.
  // Phrases you retype constantly when fixing a region. They append rather than
  // replace, because a detail fix is usually "what I already said, plus hands".
  const DETAILS = [
    ["Hands", "detailed hands, five fingers, correct anatomy"],
    ["Face", "sharp facial detail, clear eyes, natural skin texture"],
    ["Eyes", "detailed eyes, clear irises, catchlights"],
    ["Hair", "detailed hair strands, natural flow"],
    ["Skin", "natural skin texture, visible pores, no plastic sheen"],
    ["Fabric", "detailed fabric weave, natural folds and drape"],
    ["Background", "clean detailed background, natural depth"],
    ["Sharpen", "crisp focus, fine detail, no blur"],
  ];

  // What the painted patch should become. Without this the patch is rendered with
  // whatever conditioning is wired into the render node, which is the whole-image
  // prompt, so a painted region is told to be more of the same picture.
  for (const [key, label, hint] of [
    ["prompt", "Positive",
     "What the painted region should become, for example \"a red hat\". Needs the "
     + "render node's clip input wired. Leave it empty to use the main conditioning."],
    ["negative", "Negative",
     "The matching negative for the paint prompt. Only used when a paint prompt is set."],
  ]) {
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    row.style.cssText = "align-items:flex-start;gap:5px";
    const lab = document.createElement("span");
    lab.className = "hint";
    lab.style.cssText = "flex:none;width:62px;padding-top:5px";
    lab.textContent = label;
    const box = document.createElement("textarea");
    box.className = "rn-ws-vsp";
    box.style.cssText = "flex:1;min-height:" + (key === "prompt" ? "68" : "44") + "px";
    box.value = P[key] || "";
    box.placeholder = key === "prompt" ? "leave empty to use the main prompt" : "";
    box.title = hint;
    box.oninput = () => { P[key] = box.value; writeCfg(node); };
    row.append(lab, expandable(box, "Paint \u00b7 " + label,
                               (v) => { P[key] = v; writeCfg(node); }));
    promptBox.appendChild(row);
  }

  // ---- KEYWORDS, in their own box: a searchable dropdown to pick from the library,
  // and only the PICKED ones shown as chips beneath it. The library can hold fifty
  // to a hundred snippets, and a wall of every chip at once was unreadable at ten:
  // the dropdown is the door, the chips are the state. Same job as an A1111 styles
  // selector, same machinery as the pack's channel and LoRA pickers. Only NAMES live
  // here; the text stays in the global library and is expanded at run time, so
  // editing a keyword updates every mask that uses it.
  {
    const kwPick = document.createElement("input");
    kwPick.type = "text";
    kwPick.placeholder = "Add a keyword...";
    kwPick.style.cssText = "background:#15171b;border:1px solid #33373d;"
      + "border-radius:5px;color:#e8ecf1;font-size:13px;padding:6px 9px;width:100%;"
      + "box-sizing:border-box";
    kwPick.title = "Click and type to search the saved @keywords, enter to add one. "
                 + "Added keywords join the paint prompt at run time.";
    kwBox.appendChild(kwPick);
    const kwRow = document.createElement("div");
    kwRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
    kwBox.appendChild(kwRow);
    const fillChips = () => {
      kwRow.replaceChildren();
      const picked = P.keywords || [];
      if (!picked.length) {
        const e = document.createElement("span");
        e.className = "hint";
        e.style.cssText = "flex:none;font-size:10.5px;opacity:.48";
        e.textContent = "None picked yet";
        kwRow.appendChild(e);
        return;
      }
      for (const name of picked) {
        const chip = document.createElement("button");
        chip.className = "rn-ws-btn on";
        chip.style.cssText = "width:auto;padding:2px 8px;font-size:11px;height:22px";
        chip.textContent = "@" + name + " ×";
        chip.title = "@" + name + " joins the paint prompt at run time. Click to "
                   + "take it off.";
        chip.onclick = () => {
          P.keywords = (P.keywords || []).filter((k) => k !== name);
          writeCfg(node);
          fillChips();
        };
        kwRow.appendChild(chip);
      }
    };
    fillChips();
    makePicker(kwPick,
      () => Object.keys(node._rnKwCache || {})
        .filter((n) => !(P.keywords || []).includes(n)),
      (v) => {
        if (!v) return;
        P.keywords = [...(P.keywords || []), v];
        writeCfg(node);
        fillChips();
      },
      { clearOnPick: true });
    (async () => {
      try {
        const r = await fetch("/rednode/prompts");
        const j = await r.json();
        node._rnKwCache = j.keywords || {};
      } catch (e) { /* the library API is not up, the cached names stand */ }
    })();
  }

  // Quick details is gone by request: preset chips are clutter next to a real
  // prompt box, and the keyword library will do this job properly.

  // Reference painting. Off by default: the plain encode is what makes Generate feel
  // instant, and encoding references costs real time.

  // Heal a renderer choice left pointing at a deleted id BEFORE anything reads it.
  // This ran further down, next to the Rendered by row it repairs, until the
  // reference row below started deciding from P.renderer too: healing after that
  // decision let the buttons sit enabled for one render when a renderer was
  // deleted and recreated.
  if (paintTargets().length && healRenderer(cfg)) writeCfg(node);

  const refRow = document.createElement("div");
  refRow.className = "rn-ws-row";
  const rlab = document.createElement("span");
  rlab.className = "hint";
  rlab.style.cssText = "flex:none;width:96px";
  rlab.textContent = "Use as reference";
  refRow.appendChild(rlab);
  // THE MODEL DECIDES whether these are offered, your rule since the Models
  // tab exists: references are Krea 2 conditioning, so a rig whose CLIP type is
  // krea2 can carry them and any other model cannot, wherever the render runs. A
  // graph with no rigs configured keeps the old renderer-kind rule (internal Paint
  // Render yes, external chain no, "Krea2 Workspace" by exact name yes), so nothing
  // unmigrated changes.
  const refT = allPaintChoices(cfg)
    .find((x) => String(x.node.id) === String(P.renderer ?? ""));
  const refName = String(refT ? rendererName(refT) : P.renderer_name || "")
    .trim().toLowerCase();
  const activeRig = (cfg.models?.rigs || [])[cfg.models?.active || 0];
  const refsLive = activeRig
    ? activeRig.clip_type === "krea2"
    : ((refT ? refT.kind === "render" : true) || refName === "krea2 workspace");
  for (const [key, label, tip] of [
    ["use_subject", "Subject",
     "Paint with the Subject tab's image as the identity reference, so a repainted "
     + "face stays the same person."],
    ["use_scene", "Scene",
     "Paint with the Scene tab's image as reference. Useful for putting an outfit or "
     + "an object from that picture onto this one."],
    ["use_moodboard", "Moodboard",
     "Paint with the Moodboard tab's style reference, so the patch matches the look."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-btn rn-ws-compact" + (P[key] ? " on" : "");
    b.style.cssText = "width:auto;padding:0 10px";
    b.textContent = label;
    if (refsLive) {
      b.title = tip + " Needs a paint prompt and the render node's clip input wired. "
              + "Slower than painting with the prompt alone.";
      b.onclick = () => { P[key] = !P[key]; writeCfg(node); render(node); };
    } else {
      b.disabled = true;
      b.title = activeRig
        ? "References are Krea 2 conditioning, and the active rig is not a Krea 2 "
          + "model (its CLIP type is not krea2). Switch the active rig on the "
          + "Models tab and they come back."
        : "References cannot ride this chain: its sampler takes plain text "
          + "conditioning, so these toggles would change nothing. Pick the "
          + "Krea2 Workspace chain, or the internal Paint Render, and they "
          + "come back.";
    }
    refRow.appendChild(b);
  }
  routeBox.appendChild(refRow);
  if (refsLive
      && (P.use_subject || P.use_scene || P.use_moodboard) && !(P.prompt || "").trim()) {
    const warn = document.createElement("div");
    warn.className = "rn-ws-note";
    warn.textContent = "References only apply when there is a paint prompt to attach "
                     + "them to. Without one the patch uses the main conditioning.";
    routeBox.appendChild(warn);
  }

  // THE OLD "LoRA tab / Wired in" SWITCH, retired by the Paint
  // LoRAs tab in the paint column is the one LoRA choice now, and this row said the
  // same kind of thing in different words right underneath it. It still WORKS for a
  // workflow saved with the non-default "tab" setting (Paint Render keeps honouring
  // it, or that workflow would render differently after an update), so the row shows
  // ONLY then, as the way to turn it off. Something switched on must look on. Flip it
  // to Wired in once and it is gone for good.
  const lmode = P.loras_mode || (P.use_loras ? "tab" : "wired");
  if (lmode === "tab") {
    const loraRow = document.createElement("div");
    loraRow.className = "rn-ws-row";
    const llab = document.createElement("span");
    llab.className = "hint";
    llab.style.cssText = "flex:none;width:96px";
    llab.textContent = "LoRAs";
    loraRow.appendChild(llab);
    const off = document.createElement("button");
    off.className = "rn-ws-segb on";
    off.textContent = "Legacy: main stack re-applied. Click to retire";
    off.title = "This workflow was saved with the old switch applying the main LoRAs "
              + "tab inside the render node. That still runs, which doubles the LoRAs "
              + "if the model wired in already carries them. Click to turn it off and "
              + "use the Paint LoRAs tab in the paint column instead.";
    off.onclick = () => {
      P.loras_mode = "wired";
      P.use_loras = false;
      writeCfg(node);
      render(node);
    };
    loraRow.appendChild(off);
    routeBox.appendChild(loraRow);
  }

  // the rigs count as choices: a one-node graph has no renderer NODES at all,
  // and gating this row on them alone made the whole Model choice vanish there
  const found = allPaintChoices(cfg);
  if (found.length) {
    // healed above, before the reference row read the choice
    const rrow = document.createElement("div");
    rrow.className = "rn-ws-row";
    const rl = document.createElement("span");
    rl.className = "hint";
    rl.style.cssText = "flex:none;width:96px";
    // "Model choice", renamed from "Rendered by" 2026-08-12: the row now carries a
    // whole per-model profile (CFG, Steps, its own paint LoRA stack), not just which
    // node runs, and the destination is picking a model and having it route through
    // its own paint rig. The config keys keep their old names; saved workflows care.
    rl.textContent = "Model choice";
    rrow.appendChild(rl);
    {
      // ALWAYS a dropdown, even when there is only one renderer. It used to be plain
      // text in that case, and plain text cannot notice a second renderer arriving: add
      // a Paint In to a graph that had only a Paint Render and the row went on naming
      // the old node, with no control to change it, because nothing redraws this panel
      // when a node is created. A select holding one option costs a glance and stays
      // honest the moment you open it.
      const sel = document.createElement("select");
      sel.className = "rn-ws-res";
      // REBUILT EVERY TIME IT IS OPENED, not once when the panel last drew. Renderers
      // come and go while this panel is sitting there, and a list built at draw time
      // goes stale the moment you delete one and put another back. Nothing forces the
      // panel to redraw for that, so the list kept offering an id that no longer
      // existed and the node it named was long gone.
      const fill = () => {
        const live = allPaintChoices(cfg);
        const cur = String(P.renderer ?? "");
        sel.replaceChildren();
        for (const t of live) {
          const o = document.createElement("option");
          o.value = String(t.node.id);
          o.textContent = rendererName(t);
          o.selected = cur === String(t.node.id);
          sel.appendChild(o);
        }
      };
      fill();
      sel.addEventListener("pointerdown", fill);
      sel.addEventListener("focus", fill);
      sel.title = "Which model renders the paint pass, via whichever node runs it. "
                + "Name your Paint In nodes after what is in them, NAI, SDXL, "
                + "whatever, and that is what shows here. Paint Render does the whole "
                + "job itself; Paint In is the end of a chain with your own renderer "
                + "in it. CFG, Steps and the paint LoRA stack are remembered PER "
                + "model choice and switch back with it.";
      sel.onchange = () => {
        // REMEMBER WHAT THE OUTGOING RENDERER WAS USING, before it is overwritten.
        // Keyed by the same display name the dropdown already shows and already
        // disambiguates on a clash, so a second SDXL bridge does not share a slot
        // with the first. Reading P.cfg/P.steps HERE, not at the moment they were
        // last typed, is what makes this correct after any number of untracked
        // tweaks: whatever is on the dial right now is what this renderer was using.
        const prevKey = String(P.renderer_name || P.renderer_kind || P.renderer || "");
        if (prevKey && typeof P.cfg === "number" && typeof P.steps === "number") {
          (P.renderer_profiles ||= {})[prevKey] = { cfg: P.cfg, steps: P.steps };
        }
        P.renderer = sel.value;
        // the name is what survives the node being recreated, so it is recorded
        // whenever the choice is actually made
        const t = paintTargets().find((x) => String(x.node.id) === String(sel.value));
        P.renderer_name = t ? rendererName(t) : "";
        P.renderer_kind = t ? t.kind : "";
        // RESTORE THE INCOMING RENDERER'S OWN NUMBERS, if it has ever been used
        // before. A renderer with no profile yet is left alone rather than reset to
        // its node's own widget defaults: that is the existing "adopt once, then it
        // is yours" rule for cfg/steps, and switching back and forth before ever
        // touching the dial must not fight it.
        const newKey = String(P.renderer_name || P.renderer_kind || P.renderer || "");
        const saved = (P.renderer_profiles || {})[newKey];
        if (saved) { P.cfg = saved.cfg; P.steps = saved.steps; }
        writeCfg(node);
        render(node);
      };
      rrow.appendChild(sel);
    }
    routeBox.appendChild(rrow);
    // A CHAIN NAMED "Krea2 Workspace" is the studio-conditioning rig: its sampler
    // takes the MAIN studio's positive and negative, so the boxes above have nothing
    // to say there. The name is an exact agreement so the trade is visible at the
    // moment of choosing, rather than discovered from a render that ignored the box.
    const rt = found.find((x) => String(x.node.id) === String(P.renderer ?? ""));
    const rname = String(rt ? rendererName(rt) : P.renderer_name || "").trim();
    if (rname.toLowerCase() === "krea2 workspace") {
      const wrow = document.createElement("div");
      wrow.className = "rn-ws-row";
      const warn = document.createElement("span");
      warn.className = "hint";
      warn.style.color = "#d4b25f";
      warn.textContent = "This chain renders with the MAIN prompt and its references. "
                       + "The Positive and Negative boxes above are ignored.";
      wrow.appendChild(warn);
      routeBox.appendChild(wrow);
    }
  }

  const gen = document.createElement("button");
  gen.className = "rn-ws-gen";
  node._rnPaintGenButton = gen;
  gen.title = "Render just the painted region: it saves the mask, crops to what you "
            + "painted, samples that crop at the mask size, and composites it back. "
            + "Nothing else in the workflow runs. Needs a RedNode Paint Render node "
            + "in the graph with model, positive, negative and vae wired.";
  gen.onclick = async () => {
    const current = node._rnPaintBatchRun;
    if (current?.active) {
      current.stop = true;
      syncPaintBatchUi(node);
      return;
    }
    // Invert steps around this check on purpose: it reads "keep what I painted",
    // and painting nothing keeps nothing, so inverted-nothing means the WHOLE frame
    // regenerates. The blank canvas still uploads, the server loads it as all-zero,
    // and invert turns that into all-one.
    //
    // AN AUTO MASK COUNTS AS PAINT. It covers half the picture and is plainly visible
    // on the canvas, and this refused to run against it because it counts brush
    // STROKES and an auto mask is not one. Pressing Mask subject and then being told
    // to paint something first, when the subject is sitting there masked, is the panel
    // arguing with what is on screen. One tap of the brush "fixed" it, which is the
    // tell: the mask was always fine, the question was wrong.
    if (!(node._rnStrokes || []).some((st) => !st[8])
        && !P.mask && !P.auto_mask && !P.invert) {
      alert("Paint something first: Generate renders only the region you painted. "
          + "(Mask background or Mask subject count too, and with Invert on, nothing "
          + "painted means the whole frame.)");
      return;
    }
    // Snapshot the mask BEFORE anything re-renders. render() rebuilds the panel and
    // creates a fresh canvas, and the strokes are only replayed onto it once the base
    // image's onload fires. Reading the layer after a render therefore hands back a
    // blank canvas, which reached the server as an empty mask and came back as
    // "nothing is painted yet" with the tab covered in brush strokes.
    const layer = node._rnMaskCanvas;      // the mask, not the hatched view of it
    const snapshot = layer ? maskCanvas(layer, P.feather) : null;
    // the colour sheet is snapshotted at the same moment, for the same reason;
    // only when unsaved work is on it, else the saved file is already the truth
    let csnap = null;
    if (node._rnColourDirty && node._rnColourCanvas?.width) {
      csnap = document.createElement("canvas");
      csnap.width = node._rnColourCanvas.width;
      csnap.height = node._rnColourCanvas.height;
      csnap.getContext("2d").drawImage(node._rnColourCanvas, 0, 0);
    }
    const settings = paintBatchSettings(node);
    const run = {
      active: true,
      stop: false,
      forever: !!settings.forever,
      remaining: Math.max(1, Math.min(999, Math.round(Number(settings.count) || 1))),
    };
    node._rnPaintBatchRun = run;
    node._rnPainting = true;
    syncPaintBatchUi(node);
    try {
      if (snapshot) {
        // no silent adoption: an empty source means nothing is on the canvas, so there
        // is nothing painted to run, and reaching for the newest workflow result here
        // is the follow-the-workflow behaviour arriving by a side door.
        // This IS the save-before-Generate half of the rule, and it always was: the
        // snapshot was taken above, before any re-render could blank the canvas.
        P.mask = await uploadMask(node, snapshot);
        if (csnap) {
          P.colour = await uploadMask(node, csnap);
          node._rnColourDirty = false;
        }
        node._rnMaskDirty = false;
        writeCfg(node);
      }
      render(node);
      while (!run.stop && (run.forever || run.remaining > 0)) {
        const queued = await paintGenerate(node);
        const finished = await queued.completion;
        if (!finished.ok) {
          throw new Error(finished.message || "the Paint image did not complete");
        }
        if (!run.forever) run.remaining = Math.max(0, run.remaining - 1);
        syncPaintBatchUi(node);
      }
    } catch (e) {
      console.error("[RedNode Workspace] paint generate failed:", e);
      alert(`Could not paint: ${e.message}`);
    } finally {
      run.active = false;
      node._rnPainting = false;
      syncPaintBatchUi(node);
      render(node);
    }
  };
  gen.addEventListener("contextmenu", (e) => openPaintBatchMenu(node, e));
  syncPaintBatchUi(node);

  // CTRL+ENTER GENERATES, over this panel, on this tab. Reaching for the mouse to
  // press one button is the wrong shape for a paint loop, where the whole gesture is
  // brush, adjust, fire, look, again.
  //
  // Registered on the panel ROOT rather than on the button or the canvas, so it works
  // wherever the pointer is inside the node, and re-registered only when the root
  // itself changes, which is the full-screen room swapping in. The handler DECLINES on
  // any other tab by returning false, so Ctrl+Enter over the LoRAs tab still queues the
  // workflow the way it always did.
  node._rnPaintGenerate = gen.onclick;
  const host = node._rnRootEl;
  if (host && node._rnHotHost !== host) {
    if (node._rnHotHost) forgetHotkeys(node._rnHotHost);
    if (node._rnHotHost) forgetPaste(node._rnHotHost);
    node._rnHotHost = host;
    panelHotkey(host, "ctrl+Enter", () => {
      if (node._rnTab !== "paint") return false;
      if (typeof node._rnPaintGenerate !== "function") return false;
      node._rnPaintGenerate();
    });
    // Paste a picture straight onto the canvas, the same road a drop takes: it is stored
    // in the managed paint folder, so a screenshot that never came from this workflow is
    // as usable as a result. Declining on every other tab and on a clipboard with no
    // image leaves ComfyUI's own paste alone, including pasting copied NODES.
    panelPaste(host, (e) => {
      if (node._rnTab !== "paint") return false;
      const file = clipboardImage(e);
      if (!file) return false;
      adoptPaintSource(node, file).catch((err) => {
        console.error("[RedNode Workspace] could not paste that picture:", err);
        alert(`Could not use that image: ${err.message}`);
      });
    });
  }

  // The note stays: it was the half of Save mask that was actually telling you
  // something. It is held on the node so a save can update THIS SPAN instead of
  // re-rendering the panel, which is what made the canvas flash.
  const state = document.createElement("span");
  state.className = "rn-ws-note";
  state.textContent = node._rnMaskDirty ? "Unsaved paint"
    : (P.mask ? "Mask saved" : "Nothing painted yet");
  state.title = "The mask saves itself when you take the brush off the canvas, and "
              + "again just before Generate, so a queue always paints through what is "
              + "on screen.";
  node._rnMaskNote = state;
  gen.title += "  Ctrl+Enter does the same. Right-click for batch or Forever.";
  genWrap.insertBefore(gen, seg);          // Generate on top, the mode under it

  const maskActions = document.createElement("div");
  maskActions.className = "rn-ws-row";
  state.classList.add("rn-ws-file-state");
  maskActions.append(open, useLast, keep, clear, state);
  autoMaskBox.appendChild(row2);             // background, subject and Cut
  maskStateBox.appendChild(maskActions);
  if (!P.mask_only) {
    const capRow = document.createElement("div");
    capRow.className = "rn-ws-row";
    const clab = document.createElement("span");
    clab.className = "hint";
    clab.style.cssText = "flex:none;width:96px";
    clab.textContent = "Large frames";
    capRow.appendChild(clab);
    // the SHARED table, not a third copy: this one had drifted to 3072 on high while
    // the server capped at 4096, so the button named a ceiling that was not the one
    // being applied
    const cap = wholeFrameLimit(cfg.vram_tier);
    const fb = document.createElement("button");
    fb.className = "rn-ws-btn" + (P.fit_whole ? " on" : "");
    fb.style.cssText = "width:auto;padding:0 10px";
    fb.textContent = P.fit_whole ? `Fit to ${cap}px` : "Full size";
    fb.title = P.fit_whole
      ? `A whole-frame paint larger than ${cap}px is rendered at ${cap} and scaled `
        + "back. That ceiling comes from the VRAM tier in the footer. Without it a 4K "
        + "frame is minutes of sampling and can run out of memory."
      : "Whole-frame paints render at the picture's full size. Sharpest, and on a big "
        + "image the slowest by far.";
    fb.onclick = () => { P.fit_whole = !P.fit_whole; writeCfg(node); render(node); };
    capRow.appendChild(fb);
    const note = document.createElement("span");
    note.className = "hint";
    note.textContent = `${cfg.vram_tier} VRAM tier`;
    capRow.appendChild(note);
    maskStateBox.appendChild(capRow);
  }
}

// ONE place that puts a brush segment into the mask, used by live painting and by
// replay, so the two can never drift into painting differently.
//
// SOLID, always. The mask says WHERE, not how much: a painted pixel means redo this,
// and the strength of the change is denoise's job. Drawing it at the brush's
// see-through display alpha is what made an even stroke land unevenly, and made erase
// leave a ghost that took several passes to scrub out.
function maskSegment(mask, x0, y0, x1, y1, w, erase, shape, colour) {
  const ctx = mask.getContext("2d");
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  // the same primitive draws the mask (white, exported as alpha) and the colour
  // sheet (the chosen colour, shown as itself): one implementation, per the rule
  ctx.strokeStyle = colour || "#fff";
  ctx.fillStyle = colour || "#fff";
  ctx.lineWidth = w;
  const square = shape === "square";
  ctx.lineCap = square ? "square" : "round";
  ctx.lineJoin = square ? "miter" : "round";
  if (square && x0 === x1 && y0 === y1) {
    // a TAP. Canvas only renders a zero-length segment when the cap is round, which
    // is the quiet reason taps ever left a dot; with a square cap the same path
    // draws nothing, so the dot has to be placed by hand.
    ctx.fillRect(x0 - w / 2, y0 - w / 2, w, w);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

// Rebuild the mask from the recorded strokes. Takes the MASK canvas, never the
// visible one: the visible canvas is a hatched view now and replaying onto it would
// put hatch gaps into the mask itself.
// `strokes` lets a caller replay a list that is not the Paint tab's own: the Masks
// tab keeps one per mask slot, so two painters can be open at once without sharing
// the single node-level list the Paint tab uses.
function replayStrokes(node, mask, strokes) {
  // the 9th field is the COLOUR, and its presence routes the stroke: coloured
  // strokes belong to the colour sheet and must never feed the mask
  for (const [x0, y0, x1, y1, w, erase, , shape, col]
       of strokes || node._rnStrokes || []) {
    if (col) continue;
    maskSegment(mask, x0, y0, x1, y1, w, erase, shape || "round");
  }
}

// Rebuild the COLOUR SHEET from the recorded strokes: only the coloured ones,
// each in the colour it was made with, erases included.
function replayColour(node, sheet, strokes) {
  for (const [x0, y0, x1, y1, w, erase, , shape, col]
       of strokes || node._rnStrokes || []) {
    if (!col) continue;
    maskSegment(sheet, x0, y0, x1, y1, w, erase, shape || "round", col);
  }
}

// Colour paint mode state. Panel state, so it lives on node.properties like the
// strip tab, never in the config: the server only ever needs the finished sheet.
function paintMode(node) {
  return node.properties?.rn_paint_mode === "colour" ? "colour" : "mask";
}
function paintColour(node) {
  return node.properties?.rn_paint_colour || "#e03131";
}

// The Mask / Colour pair with the palette, the picker swatch and the eyedropper,
// one builder for the strip and the canvas-only room. Mode and colour live on
// node.properties: panel state, never config.
function buildColourCluster(node) {
  const wrap = document.createElement("div");
  wrap.className = "rn-ws-cclu";
  const setMode = (m) => {
    node.properties = node.properties || {};
    node.properties.rn_paint_mode = m;
    if (m !== "colour") node._rnEyedrop = false;
    sync();
    node._rnSyncRing?.();
  };
  const setColour = (c) => {
    node.properties = node.properties || {};
    node.properties.rn_paint_colour = c;
    node.properties.rn_paint_mode = "colour";   // picking a colour means painting it
    sync();
    node._rnSyncRing?.();
  };
  const maskB = document.createElement("button");
  maskB.textContent = "Mask";
  maskB.title = "Mask mode: the brush marks WHERE the render may change things, "
              + "exactly as the tab has always worked.";
  maskB.onclick = () => setMode("mask");
  const colB = document.createElement("button");
  colB.textContent = "Colour";
  colB.title = "Colour mode: the brush paints real colour onto the picture. Paint "
             + "rough colour, switch back to Mask and mask over it, and a slightly "
             + "raised denoise resolves the colours into the image.";
  colB.onclick = () => setMode("colour");
  wrap.append(maskB, colB);
  const pal = ["#e03131", "#f59f00", "#ffd43b", "#2f9e44", "#1971c2",
               "#f8f9fa", "#141414"];
  const chips = [];
  for (const c of pal) {
    const ch = document.createElement("button");
    ch.className = "rn-ws-cchip";
    ch.style.background = c;
    ch.title = "Paint with this colour.";
    ch.onclick = () => setColour(c);
    wrap.appendChild(ch);
    chips.push(ch);
  }
  const pickIn = document.createElement("input");
  pickIn.type = "color";
  pickIn.style.cssText = "width:0;height:0;border:0;padding:0;opacity:0;flex:none";
  pickIn.oninput = () => setColour(pickIn.value);
  const swatch = document.createElement("button");
  swatch.className = "rn-ws-cchip";
  swatch.style.borderRadius = "50%";
  swatch.title = "The colour on the brush. Click for the full picker; the chips "
               + "are just the fast ones.";
  swatch.onclick = () => pickIn.click?.();
  const eyeB = document.createElement("button");
  eyeB.textContent = "\u2299";
  eyeB.title = "Eyedropper: the next click on the picture picks up its colour "
             + "instead of painting. Alt+click samples any time in Colour mode.";
  eyeB.onclick = () => { node._rnEyedrop = !node._rnEyedrop; sync(); };
  wrap.append(swatch, pickIn, eyeB);
  const sync = () => {
    const mode = paintMode(node);
    const col = paintColour(node);
    maskB.className = "rn-ws-btn rn-ws-zb" + (mode === "mask" ? " on" : "");
    colB.className = "rn-ws-btn rn-ws-zb" + (mode === "colour" ? " on" : "");
    swatch.style.background = col;
    pickIn.value = col;
    for (let i = 0; i < chips.length; i++) {
      chips[i].className = "rn-ws-cchip"
        + (mode === "colour" && pal[i] === col ? " on" : "");
    }
    eyeB.className = "rn-ws-btn rn-ws-zb" + (node._rnEyedrop ? " on" : "");
  };
  node._rnSyncColourUI = sync;
  sync();
  return { el: wrap, sync };
}

// The saved mask follows ComfyUI's own convention: PAINTED areas are transparent,
// which is what load_mask reads (1 - alpha). Feather blurs the edge so a repaint
// blends instead of leaving a seam.
//
// Hand this the MASK canvas. It reads alpha, and the visible layer's alpha is now the
// hatch pattern, so exporting that would ship a striped mask with unpainted gaps.
function maskCanvas(layer, feather) {
  const out = document.createElement("canvas");
  out.width = layer.width;
  out.height = layer.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);          // opaque = untouched
  ctx.globalCompositeOperation = "destination-out";
  if (feather > 0 && ctx.filter !== undefined) ctx.filter = `blur(${feather}px)`;
  ctx.drawImage(layer, 0, 0);                         // painted = punched through
  return out;
}

// The Latent tab: the workspace's own Empty Latent Image, feeding output_latent.


// ---------------------------------------------------------------- Models tab
// Load the rig INSIDE the workspace: checkpoint or diffusion model, CLIP, VAE, by
// name, several rigs kept and switched by clicking. The active rig fills whatever
// input is not wired (a wired input always wins), rides out on the model / clip /
// vae outputs, and Paint Out hands it to external chains. The lists come from
// ComfyUI's own /object_info for the stock loader nodes, so whatever core can load,
// this can offer, with the shared picker's search and recents over the top.
let MODEL_LISTS = null;
async function fetchModelLists() {
  if (MODEL_LISTS) return MODEL_LISTS;
  const pull = async (nodeName, field) => {
    try {
      const r = await api.fetchApi("/object_info/" + nodeName);
      const d = await r.json();
      const v = d?.[nodeName]?.input?.required?.[field]?.[0];
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  };
  MODEL_LISTS = {
    checkpoints: await pull("CheckpointLoaderSimple", "ckpt_name"),
    unets: await pull("UNETLoader", "unet_name"),
    // quantised files with loaders of their own (workspace.py UNET_LOADERS);
    // an absent pack answers with an empty list, which the Loader row says
    ggufs: await pull("UnetLoaderGGUF", "unet_name"),
    int8s: await pull("OTUNetLoaderW8A8", "unet_name"),
    int8_types: await pull("OTUNetLoaderW8A8", "model_type"),
    clips: await pull("CLIPLoader", "clip_name"),
    clip_types: await pull("CLIPLoader", "type"),
    vaes: await pull("VAELoader", "vae_name"),
    loras: await pull("LoraLoader", "lora_name"),
    samplers: await pull("KSampler", "sampler_name"),
    schedulers: await pull("KSampler", "scheduler"),
  };
  return MODEL_LISTS;
}
// schedule shapes the pack builds itself (sampler_dials.py); a rig may name them
const RIG_EXTRA_SCHEDULERS = ["beta57", "bong_tangent", "hyperbolic"];

function modelsBody(node, page) {
  const cfg = node._rnCfg;
  const M = cfg.models;
  if (!MODEL_LISTS) fetchModelLists().then(() => render(node));

  // WHAT STOPS A RENDER, at the top where it is seen: the same reasons a run that
  // comes out empty gives, before anyone queues
  {
    const probs = setupProblems(node, cfg);
    if (probs.length) {
      const warn = document.createElement("div");
      warn.className = "rn-ws-setupwarn";
      const t = document.createElement("div");
      t.className = "ttl";
      t.textContent = "Before this renders";
      warn.appendChild(t);
      for (const p of probs) {
        const line = document.createElement("div");
        line.textContent = p;
        warn.appendChild(line);
      }
      page.appendChild(warn);
    }
  }

  // Boxes with a width cap, flowing left to right and wrapping when the node is
  // narrow: a wide node stops stretching every row across the whole panel.
  const mwrap = document.createElement("div");
  mwrap.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start";
  page.appendChild(mwrap);
  // box headers carry an icon, an accent and an optional badge now, the
  // ChatGPT-mock direction the direction pointed at: sections identify themselves
  // at a glance and the border whispers the same colour
  const mkBox = (title, accent, icon, badge) => {
    const a = accent || "#c8ccd2";
    const b = document.createElement("div");
    b.style.cssText = "flex:1 1 340px;max-width:560px;min-width:300px;display:flex;"
                    + "flex-direction:column;gap:6px;padding:9px;background:#1a1d22;"
                    + "border:1px solid " + a + "44;border-radius:7px";
    const t = document.createElement("div");
    t.style.cssText = "display:flex;align-items:center;gap:7px;font-size:12.5px;"
                    + "font-weight:700;letter-spacing:.04em;color:" + a;
    if (icon) {
      const ic = document.createElement("span");
      ic.textContent = icon;
      ic.style.cssText = "font-size:13px";
      t.appendChild(ic);
    }
    const tt = document.createElement("span");
    tt.textContent = title;
    t.appendChild(tt);
    if (badge) {
      const bd = document.createElement("span");
      bd.textContent = badge;
      bd.style.cssText = "font-size:9.5px;font-weight:700;letter-spacing:.05em;"
        + "padding:2px 7px;border-radius:8px;background:#3a2f14;color:#c98a2d;"
        + "border:1px solid #c98a2d55";
      t.appendChild(bd);
    }
    b.appendChild(t);
    mwrap.appendChild(b);
    return b;
  };
  // pills flow in a grid; the grid appears where the first pill lands, so
  // notes and other rows keep their document order around it
  const pillMount = (box) => {
    if (!box._grid || box._grid !== box.lastChild) {
      const g = document.createElement("div");
      g.className = "rn-ws-pillgrid";
      box.appendChild(g);
      box._grid = g;
    }
    return box._grid;
  };
  const pill = (box, label, control, hint) => {
    const row = document.createElement("div");
    row.className = "rn-ws-pill";
    if (hint) row.title = hint;
    const lab = document.createElement("span");
    lab.className = "k";
    lab.textContent = label;
    row.append(lab, control);
    pillMount(box).appendChild(row);
    return row;
  };
  // ---- the page header and the RIG bar, your mock made real:
  // rig chips with an ACTIVE badge, add and manage on the same line
  {
    const head = document.createElement("div");
    head.style.cssText = "display:flex;flex-direction:column;gap:2px";
    const h1 = document.createElement("div");
    h1.style.cssText = "font-size:19px;font-weight:700;color:#e8ecf1";
    h1.textContent = "Models";
    const sub = document.createElement("div");
    sub.className = "rn-ws-note";
    sub.textContent = "Configure the active rig and sampling settings.";
    head.append(h1, sub);
    page.insertBefore(head, mwrap);

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"
      + "background:#1a1d22;border:1px solid #2a2e34;border-radius:7px;"
      + "padding:9px";
    const blab = document.createElement("div");
    blab.style.cssText = "display:flex;flex-direction:column;flex:none;"
      + "max-width:170px";
    const bt = document.createElement("span");
    bt.style.cssText = "font-size:11px;font-weight:700;letter-spacing:.06em;"
      + "color:#b8283c";
    bt.textContent = "RIG";
    const bh = document.createElement("span");
    bh.className = "rn-ws-note";
    bh.textContent = "The active rig loads at queue time.";
    blab.append(bt, bh);
    bar.appendChild(blab);
    M.rigs.forEach((r, i) => {
      const chip = document.createElement("button");
      const activeChip = M.active === i;
      chip.style.cssText = "display:flex;align-items:center;gap:7px;"
        + "padding:8px 14px;border-radius:7px;cursor:pointer;font-size:13px;"
        + "font-weight:600;background:" + (activeChip ? "#a855f71a" : "#15171b")
        + ";border:1px solid " + (activeChip ? "#a855f7" : "#2a2e34")
        + ";color:#e8ecf1";
      const dot = document.createElement("span");
      dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex:none;"
        + "background:" + ([r.checkpoint || r.unet, r.clip, r.vae]
          .filter(Boolean).length || r.kind !== "files" ? "#3f9e63" : "#666");
      chip.appendChild(dot);
      const nm = document.createElement("span");
      nm.textContent = r.name || ("Rig " + (i + 1));
      chip.appendChild(nm);
      if (activeChip) {
        const badge = document.createElement("span");
        badge.textContent = "ACTIVE";
        badge.style.cssText = "font-size:9px;font-weight:700;padding:2px 7px;"
          + "border-radius:8px;background:#1e5233;color:#a7f3c0";
        chip.appendChild(badge);
      }
      chip.title = activeChip
        ? "The active rig: it loads and renders. Its settings fill the boxes "
          + "below."
        : "Make this rig active. The boxes below edit the active rig.";
      chip.onclick = () => { M.active = i; writeCfg(node); render(node); };
      bar.appendChild(chip);
    });
    const addChip = document.createElement("button");
    addChip.className = "rn-ws-btn";
    addChip.style.cssText = "width:auto;padding:0 14px";
    addChip.textContent = "＋ New Rig";
    addChip.onclick = () => {
      M.rigs.push({ name: nextRigName(M.rigs), checkpoint: "", unet: "", clip: "",
                    clip_type: "", vae: "" });
      M.active = M.rigs.length - 1;
      node._rnRigManage = true;
      writeCfg(node); render(node);
    };
    bar.appendChild(addChip);
    const spring = document.createElement("span");
    spring.style.flex = "1";
    bar.appendChild(spring);
    // ACTIVE PROMPT: which Prompts-tab row this rig renders,
    // right here, and a switcher. Choosing a row moves this rig into that
    // row's rig list (and out of the others), so one rig has one prompt.
    if (M.rigs.length && Array.isArray(cfg.prompts?.rows)) {
      const rows = cfg.prompts.rows;
      const rigName = M.rigs[M.active]?.name || ("Rig " + (M.active + 1));
      const rigsOf = (row) => (Array.isArray(row.rigs) ? row.rigs : (row.rig ? [row.rig] : []));
      const curIdx = rows.findIndex((row) => rigsOf(row).includes(rigName) && String(row.text || "").trim());
      const fallbackIdx = curIdx >= 0 ? -1 : rows.findIndex((row) => !rigsOf(row).length && String(row.text || "").trim());
      const pwrap = document.createElement("div");
      pwrap.style.cssText = "display:flex;align-items:center;gap:6px";
      const pl = document.createElement("span");
      pl.className = "rn-ws-note";
      pl.textContent = "Active prompt";
      const psel = document.createElement("select");
      psel.className = "rn-ws-select";
      psel.title = "The Prompts-tab row this rig renders. Pick another to move the rig onto it "
                 + "(one rig, one prompt). Rows are edited on the Prompts tab.";
      const o0 = document.createElement("option");
      o0.value = "-1";
      o0.textContent = fallbackIdx >= 0 ? "(unlinked: " + (rows[fallbackIdx].name || "Prompt " + (fallbackIdx + 1)) + ")" : "(none)";
      psel.appendChild(o0);
      rows.forEach((row, j) => {
        const o = document.createElement("option");
        o.value = String(j);
        o.textContent = (row.name || "Prompt " + (j + 1)) + (rigsOf(row).length ? "  [" + rigsOf(row).join(", ") + "]" : "");
        o.selected = j === curIdx;
        psel.appendChild(o);
      });
      psel.onchange = () => {
        const j = parseInt(psel.value, 10);
        rows.forEach((row) => {
          if (!Array.isArray(row.rigs)) row.rigs = row.rig ? [row.rig] : [];
          row.rigs = row.rigs.filter((x) => x !== rigName);
          row.rig = row.rigs[0] || "";
        });
        if (j >= 0 && rows[j]) { rows[j].rigs.push(rigName); rows[j].rig = rows[j].rigs[0]; }
        writeCfg(node); render(node);
      };
      const goP = document.createElement("button");
      goP.className = "rn-ws-btn";
      goP.style.cssText = "width:auto;padding:0 10px";
      goP.textContent = "Edit ▸";
      goP.title = "Open the Prompts tab on this prompt.";
      goP.onclick = () => {
        if (curIdx >= 0) node._rnPromptSel = curIdx;
        node._rnTab = "prompts"; (node.properties ||= {}).rn_tab = "prompts"; render(node);
      };
      pwrap.append(pl, psel, goP);
      bar.appendChild(pwrap);
    }
    const manage = document.createElement("button");
    manage.className = "rn-ws-btn";
    manage.style.cssText = "width:auto;padding:0 14px";
    manage.textContent = "⚙ Manage rigs";
    manage.title = "Rename, reorder or remove rigs.";
    manage.onclick = () => {
      node._rnRigManage = !node._rnRigManage;
      render(node);
    };
    bar.appendChild(manage);
    page.insertBefore(bar, mwrap);
  }

  let body = null;
  if (node._rnRigManage || !M.rigs.length) {
  body = mkBox("Rigs", "#b8283c", "⚙");

  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = M.rigs.length
    ? "Rename rigs here; the Prompts tab links prompts to a rig by its name. "
      + "Close with Manage rigs when done."
    : "No rigs yet. Add one, name it, and pick its files; the workspace then loads "
      + "it so the graph needs no loader nodes.";
  body.appendChild(note);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:5px";
  M.rigs.forEach((rig, i) => {
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    const use = document.createElement("button");
    use.className = "rn-ws-segb" + (M.active === i ? " on" : "");
    use.textContent = M.active === i ? "Active" : "Use";
    use.title = "The active rig is the one that loads and renders.";
    use.onclick = () => { M.active = i; writeCfg(node); render(node); };
    const name = document.createElement("input");
    name.type = "text";
    name.value = rig.name;
    name.placeholder = "Rig " + (i + 1);
    name.style.cssText = "flex:1;min-width:0;background:#15171b;border:1px solid "
                       + "#33373d;border-radius:4px;color:#e8ecf1;font-size:13px;"
                       + "padding:4px 7px";
    name.title = "Name this rig; the Prompts tab links prompts to it by this name.";
    name.addEventListener("change", () => { rig.name = name.value; writeCfg(node); });
    const files = document.createElement("span");
    files.className = "hint";
    files.textContent = [rig.checkpoint || rig.unet, rig.clip, rig.vae]
      .filter(Boolean).length + " file(s)";
    const del = document.createElement("button");
    del.className = "rn-ws-btn";
    del.style.width = "auto";
    del.textContent = "\u2715";
    del.title = "Remove this rig. Files on disk are untouched.";
    del.onclick = () => {
      M.rigs.splice(i, 1);
      if (M.active >= M.rigs.length) M.active = Math.max(0, M.rigs.length - 1);
      writeCfg(node); render(node);
    };
    row.append(use, name, files, del);
    list.appendChild(row);
  });
  body.appendChild(list);

  const add = document.createElement("button");
  add.className = "rn-ws-btn";
  add.style.width = "auto";
  add.style.padding = "0 10px";
  add.textContent = "\uFF0B Rig";
  add.onclick = () => {
    M.rigs.push({ name: nextRigName(M.rigs), checkpoint: "", unet: "", clip: "", clip_type: "", vae: "" });
    M.active = M.rigs.length - 1;
    writeCfg(node); render(node);
  };
  body.appendChild(add);
  }

  const rig = M.rigs[M.active];
  if (!rig) return;
  body = mkBox("Model", "#4a8fe0", "🧊");

  // the active rig's files: one picker per kind, the LoRA picker behaviour exactly,
  // with recents shared per kind so the model you use daily is always on top
  const L = MODEL_LISTS
    || { checkpoints: [], unets: [], clips: [], clip_types: [], vaes: [] };
  const FILE_ICONS = { "Checkpoint": "📦", "Diffusion model": "✳",
                       "CLIP": "🔗", "VAE": "〰", "Base model": "🧊",
                       "LoRA": "⭐" };
  const pickRow = (label, key, items, recentKey, hint) => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = rig[key];
    input.placeholder = "None";
    input.title = hint + " Click and type to search; recently used come first.";
    makePicker(input, () => items(), (v) => {
      rig[key] = v;
      writeCfg(node); render(node);
    }, { current: () => rig[key], emptyLabel: "none", recent: recentKey });
    // the mock's file pill: icon, label over the value, Local files button
    const row = document.createElement("div");
    row.className = "rn-ws-pill";
    row.style.cssText = "min-height:52px;grid-column:1/-1";
    if (hint) row.title = hint;
    const ic = document.createElement("span");
    ic.style.cssText = "font-size:15px;flex:none";
    ic.textContent = FILE_ICONS[label] || "📄";
    const mid = document.createElement("div");
    mid.style.cssText = "display:flex;flex-direction:column;gap:1px;flex:1;"
      + "min-width:0";
    const lab = document.createElement("span");
    lab.className = "k";
    lab.textContent = label;
    input.style.cssText = "background:transparent;border:none;outline:none;"
      + "color:#e8ecf1;font-size:13px;font-weight:600;text-align:left;"
      + "padding:0;width:100%";
    mid.append(lab, input);
    const browse = document.createElement("button");
    browse.className = "rn-ws-btn";
    browse.style.cssText = "width:auto;padding:0 12px;flex:none";
    browse.textContent = "📁 Local files";
    browse.title = "Browse and search the installed files.";
    browse.onclick = () => { input.focus(); input.click(); };
    row.append(ic, mid, browse);
    pillMount(body).appendChild(row);
  };
  // EXTERNAL RENDERER: this rig is the cockpit for an engine outside the
  // workspace (the NovelAI chain). No files load; its numbers and prompt ride
  // the typed output sockets instead.
  {
    const krow = document.createElement("div");
    krow.className = "rn-ws-row";
    const kb = document.createElement("button");
    // personal-only kinds (window.rnRigKinds, from a gitignored local
    // web file) join the segment when present; public installs never see them
    const kindOpts = [
      ["", "Local files", "Loads a checkpoint or diffusion model here, as always."],
      ["node", "Your own nodes", "Your own workflow is the rig: your loaders into RedNode Rig "
                                 + "Model, your own sampler fed by RedNode Rig Inputs, its "
                                 + "result into RedNode Rig Result. The Workspace applies its "
                                 + "LoRAs, prompts, cameras and references and calls your "
                                 + "sampler every time it samples. Nothing is wired."],
      ["external", "External renderer", "Loads NOTHING: this rig carries the numbers and "
                                        + "prompt for an engine outside the workspace; use "
                                        + "RedNode Rig Out and Rig In to bridge it."],
      ...(window.rnRigKinds || []).map((k) => [k, window.rnLocalRigLabel?.(k) || k, ""]),
    ];
    const kbSeg = segSwitch(kindOpts,
      kindOpts.some((o) => o[0] === (rig.kind || "")) ? (rig.kind || "") : "",
      (v) => { rig.kind = v || ""; writeCfg(node); render(node); });
    krow.appendChild(kbSeg);
    body.appendChild(krow);
  }
  if (rig.kind === "node") {
    // WHICH RIG NODES: the rig name on your Rig Model, Rig Inputs and Rig Result, with a
    // button that drops all three
    const found = customRigNodes();
    const want = rig.node || rig.name;
    const sel = document.createElement("select");
    sel.className = "rn-ws-select";
    const names = [...new Set(found.map((c) => c.name))];
    if (!names.includes(want)) names.unshift(want);
    for (const nm of names) {
      const o = document.createElement("option");
      o.value = nm;
      o.textContent = nm + (found.some((c) => c.name === nm) ? "" : "  (not on the canvas)");
      o.selected = nm === want;
      sel.appendChild(o);
    }
    sel.title = "The rig name on your RedNode Rig Model, Rig Inputs and Rig Result nodes.";
    sel.onchange = () => { rig.node = sel.value === rig.name ? "" : sel.value; writeCfg(node); render(node); };
    pill(body, "Rig nodes", sel, sel.title);
    // the model family decides the encode: Krea 2 gets the identity system, so the
    // Subject, People and Scene references and the masks reach your sampler's prompts
    const fam = document.createElement("select");
    fam.className = "rn-ws-select";
    for (const [v, t] of [["krea2", "Krea 2 (references and masks)"], ["", "Other model"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      o.selected = (rig.clip_type === "krea2" ? "krea2" : "") === v;
      fam.appendChild(o);
    }
    fam.title = "Which way the Workspace encodes this rig's prompts with your CLIP. Krea 2 "
              + "uses the Studio's identity system, so the Subject, People and Scene tabs and "
              + "the masks are in the positive your sampler gets. Other is a plain text encode.";
    fam.onchange = () => { rig.clip_type = fam.value; writeCfg(node); render(node); };
    pill(body, "Model family", fam, fam.title);
    const addB = document.createElement("button");
    addB.className = "rn-ws-btn";
    addB.style.cssText = "width:auto;padding:0 12px";
    addB.textContent = "Add the rig nodes";
    addB.title = "Puts RedNode Rig Model, Rig Inputs and Rig Result beside this Workspace, "
               + "named for this rig. Put your loaders before Rig Model and your sampler "
               + "between Rig Inputs and Rig Result; nothing connects to the Workspace.";
    addB.onclick = () => {
      const LG = globalThis.LiteGraph;
      const x0 = (node.pos?.[0] || 0) - 420;
      const y0 = (node.pos?.[1] || 0) + 40;
      RIG_NODES.forEach((type, k) => {
        const made = LG?.createNode?.(type);
        if (!made) return;
        made.pos = [x0, y0 + k * 180];
        (node.graph || app.graph)?.add?.(made);
        const w = (made.widgets || []).find((x) => x?.name === "rig");
        if (w) { w.value = want; w.callback?.(want); }
      });
      app.graph?.setDirtyCanvas?.(true, true);
      render(node);
    };
    const en = document.createElement("div");
    en.className = "rn-ws-note";
    en.textContent = found.some((c) => c.name === want)
      ? "Found on the canvas. Your loaders go into Rig Model, which hands your sampler the "
        + "model and clip with this Workspace's LoRAs on them. Rig Inputs hands it the "
        + "prompts, latent, seed and the numbers below; your result goes into Rig Result. "
        + "The Workspace calls it for the render, every pass, the Paint tab and every "
        + "Detailer pass on this rig. No wires to the Workspace."
      : `No rig nodes for "${want}" yet. Add them, or set your nodes' rig name to match.`;
    const brow = document.createElement("div");
    brow.className = "rn-ws-row";
    brow.append(addB);
    body.append(brow, en);
  } else if (rig.kind === "external") {
    const en = document.createElement("div");
    en.className = "rn-ws-note";
    en.textContent = "No files load for this rig. Set its numbers in the "
                   + "Sampler box (sampler and scheduler are free text there, "
                   + "an external engine names its own), link a Prompts-tab "
                   + "row to it by name, and bridge with RedNode Rig Out and "
                   + "Rig In: Rig Out hands your engine the prompt, seed and "
                   + "numbers; its image input is the i2i switch.";
    body.appendChild(en);
  } else if (rig.kind) {
    // a personal-only kind: its settings box comes from the local web file
    window.rnLocalRigUI?.(node, body, rig, {
      write: () => writeCfg(node),
      redraw: () => render(node),
    });
  } else {
  pickRow("Checkpoint", "checkpoint", () => L.checkpoints, "models",
          "A full checkpoint: model, CLIP and VAE in one file.");
  pickRow("Diffusion model", "unet",
          () => [...new Set([...(L.unets || []), ...(L.ggufs || []), ...(L.int8s || [])])],
          "models",
          "A bare diffusion model; add CLIP and VAE below. Wins over the checkpoint's. "
          + ".gguf and INT8 files are listed too when their loader packs are installed.");
  {
    // WHICH LOADER the file goes through. By file name sends a .gguf through
    // ComfyUI-GGUF and anything else through core; an INT8 W8A8 file is a
    // .safetensors, so that loader has to be named here.
    const absent = (list) => (MODEL_LISTS && !(list || []).length ? " (pack not installed)" : "");
    const sel = document.createElement("select");
    for (const [v, t] of [["", "By file name"], ["core", "Standard"],
                          ["gguf", "GGUF" + absent(L.ggufs)],
                          ["int8", "INT8 W8A8" + absent(L.int8s)]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      o.selected = v === (rig.unet_loader || "");
      sel.appendChild(o);
    }
    sel.title = "The loader the diffusion model goes through. By file name: a .gguf "
              + "through ComfyUI-GGUF, anything else through the standard loader. "
              + "INT8 W8A8 files look like any .safetensors, so pick that loader "
              + "for one (ComfyUI-INT8-Fast). A pack that is not installed says so "
              + "in the console when the rig loads.";
    sel.onchange = () => { rig.unet_loader = sel.value; writeCfg(node); render(node); };
    pill(body, "Loader", sel);
    if ((rig.unet_loader || "") === "int8") {
      const ts = document.createElement("select");
      for (const t of ["", ...(L.int8_types || [])]) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = t || "Loader default";
        o.selected = t === (rig.int8_type || "");
        ts.appendChild(o);
      }
      ts.title = "The INT8 loader's model type: which layers it keeps in full "
               + "precision. Loader default unless the file's page says otherwise.";
      ts.onchange = () => { rig.int8_type = ts.value; writeCfg(node); };
      pill(body, "INT8 type", ts);
    }
  }
  pickRow("CLIP", "clip", () => L.clips, "clips",
          "The text encoder. Krea 2 wants qwen3vl with the type set to krea2. "
          + "LEAVE ON NONE with a checkpoint chosen and the checkpoint's own baked "
          + "CLIP is used.");
  {
    const sel = document.createElement("select");
    for (const t of ["", ...L.clip_types]) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t || "default";
      o.selected = t === rig.clip_type;
      sel.appendChild(o);
    }
    sel.title = "How the CLIP file is interpreted. krea2 for the Krea 2 encoder. "
              + "This also decides how the built-in render encodes prompts: krea2 "
              + "runs the Studio identity system, anything else encodes plain text.";
    sel.onchange = () => { rig.clip_type = sel.value; writeCfg(node); };
    pill(body, "CLIP type", sel);
  }
  pickRow("VAE", "vae", () => L.vaes, "vaes",
          "The VAE. Comes out on the workspace's vae output and through Paint Out. "
          + "Leave on None with a checkpoint chosen and the checkpoint's own is used.");

  // Say WHERE each piece will come from, so a checkpoint's baked CLIP and VAE stop
  // being an invisible feature. This mirrors the loader's real precedence: the
  // separate file wins, the checkpoint fills, otherwise there is nothing.
  {
    const src = document.createElement("div");
    src.className = "rn-ws-note";
    const from = (own, kind) => own ? "its own file"
      : (rig.checkpoint ? "the checkpoint's baked " + kind
                        : "nowhere, pick one");
    const lk = rig.unet_loader || (/\.gguf$/i.test(rig.unet || "") ? "gguf" : "");
    src.textContent = "This rig resolves: model from "
      + (rig.unet ? "the diffusion model file"
                    + (lk === "gguf" ? " through the GGUF loader"
                       : lk === "int8" ? " through the INT8 loader" : "")
         : rig.checkpoint ? "the checkpoint" : "nowhere, pick one")
      + "; CLIP from " + from(rig.clip, "CLIP")
      + "; VAE from " + from(rig.vae, "VAE") + ".";
    body.appendChild(src);
  }
  }

  // HOLD TWO RIGS: the two-rig Detailer flow (mix render, official face pass)
  // reloads both models from disk every queue on the one-slot cache. This
  // toggle keeps both in system RAM instead. Explicitly off by default, per
  // the house rule: it costs a second model's RAM the whole session.
  {
    const hs = document.createElement("select");
    for (const [v, lbl] of [["", "Off"], ["on", "On"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lbl;
      o.selected = (M.hold_two ? "on" : "") === v;
      hs.appendChild(o);
    }
    hs.onchange = () => {
      M.hold_two = hs.value === "on";
      writeCfg(node); render(node);
    };
    pill(body, "Hold two rigs", hs,
         "Keep the last TWO rigs loaded instead of one, so a chain that "
         + "renders on one rig and detail-passes on another stops reloading "
         + "both models from disk every queue. Costs a second model's system "
         + "RAM (roughly 13 GB for a Krea 2) for as long as ComfyUI runs - "
         + "only worth it with plenty of RAM to spare.");
  }

  // IDENTITY RESCUE, SHELVED: restoring the
  // LoRA-touched layers toward the official base did not bring faces back on
  // the moody mix - even attention layers that literally WERE the official
  // weights changed nothing, so the mechanism lives deeper. The backend
  // (identity_rescue.py, the parse fields, the load hook, the RAM cap) stays
  // intact and tested for a revisit; this box only appears when a saved
  // config still has the toggle ON, so it can be switched off, then it hides.
  if (rig.rescue) {
    body = mkBox("Identity rescue", "#c98a2d", "⭐", "SHELVED");
    const rh = document.createElement("div");
    rh.className = "rn-ws-note";
    rh.textContent = "This experiment is shelved: it did not bring identity "
                   + "back on merged models. It shows because this rig still "
                   + "has it on. Switch it off and the box disappears; the "
                   + "Detailer's official-rig face pass is the working method.";
    body.appendChild(rh);
    const trow = document.createElement("div");
    trow.className = "rn-ws-row";
    const tb = document.createElement("button");
    tb.className = "rn-ws-on on";
    tb.style.width = "auto";
    tb.style.padding = "0 10px";
    tb.textContent = "Rescue on";
    tb.title = "Switch the shelved rescue off. The box hides once it is off.";
    tb.onclick = () => { rig.rescue = !rig.rescue; writeCfg(node); render(node); };
    trow.appendChild(tb);
    body.appendChild(trow);
    pickRow("Base model", "rescue_base",
            () => [...(L.checkpoints || []), ...(L.unets || [])], "models",
            "The model the LoRA was trained against - for the Identity Edit "
            + "LoRA, the official Krea 2 Turbo. Checkpoints and diffusion "
            + "models both work; only the needed tensors are read from the "
            + "file, never a whole second model.");
    pickRow("LoRA", "rescue_lora", () => L.loras || [], "loras",
            "The identity LoRA. Its own file says which layers to restore; "
            + "nothing else on this rig is touched.");
    const srow = document.createElement("div");
    srow.className = "rn-ws-row";
    const slab = document.createElement("span");
    slab.className = "rn-ws-note";
    slab.style.cssText = "flex:none;width:110px";
    slab.textContent = "Strength";
    const sr = document.createElement("input");
    sr.type = "range";
    sr.min = 0; sr.max = 1; sr.step = 0.05;
    sr.value = rig.rescue_strength ?? 1.0;
    sr.style.cssText = "width:160px;height:20px;accent-color:#b8283c";
    sr.title = "1.0 makes the touched layers exactly the base's before the "
             + "LoRA lands. Lower keeps more of the mix in those layers and "
             + "trades identity fidelity back for the mix's look.";
    const sv = document.createElement("span");
    sv.className = "rn-ws-note";
    sv.textContent = Number(rig.rescue_strength ?? 1.0).toFixed(2);
    sr.addEventListener("input", () => {
      rig.rescue_strength = snapStep(sr.value, 0, 1, 0.05);
      sv.textContent = Number(rig.rescue_strength).toFixed(2);
      writeCfg(node);
    });
    srow.append(slab, sr, sv);
    body.appendChild(srow);
  }

  // The rig's sampler settings, the numbers a KSampler needs, so loading the
  // workspace really is the whole model setup: wire steps, cfg, sampler_name and
  // scheduler from the workspace outputs and the channel run becomes optional.
  body = mkBox("Sampler", "#3f9e63", "🎛");
  // the mock's Sampler presets: the saved sampler profiles, applied to this
  // rig's five numbers in one pick
  {
    const headRow = body.firstChild;
    const spring = document.createElement("span");
    spring.style.flex = "1";
    headRow.appendChild(spring);
    const psel = document.createElement("select");
    psel.className = "rn-ws-res";
    psel.style.cssText = "font-size:11px;max-width:150px";
    const fill = (profiles) => {
      psel.replaceChildren();
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = "Sampler presets";
      psel.appendChild(o0);
      Object.keys(profiles || {}).forEach((nm) => {
        const o = document.createElement("option");
        o.value = nm;
        o.textContent = nm;
        psel.appendChild(o);
      });
    };
    fill(node._rnSamplerProfiles);
    if (!node._rnSamplerProfiles) {
      api.fetchApi("/rednode/sampler_profiles").then(async (r) => {
        node._rnSamplerProfiles = (await r.json())?.profiles || {};
        fill(node._rnSamplerProfiles);
      }).catch(() => {});
    }
    psel.title = "Apply a saved sampler profile (the Sampler Config node's "
               + "presets) to this rig's steps, cfg, sampler, scheduler and "
               + "detailer steps.";
    psel.onchange = () => {
      const pr = node._rnSamplerProfiles?.[psel.value];
      if (!pr) return;
      for (const k of ["steps", "cfg", "sampler", "scheduler",
                       "detailer_steps"]) {
        if (pr[k] !== undefined && pr[k] !== null) rig[k] = pr[k];
      }
      writeCfg(node); render(node);
    };
    headRow.appendChild(psel);
  }
  const sh = document.createElement("div");
  sh.className = "rn-ws-note";
  sh.textContent = "Sampler settings for this rig. They ride the workspace outputs "
                 + "named steps, cfg, sampler_name, scheduler and detailer_steps.";
  body.appendChild(sh);
  const numRow = (label, key, step, hint) => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    inp.value = rig[key];
    inp.title = hint;
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) { rig[key] = step === 1 ? Math.round(v) : v; writeCfg(node); }
    });
    pill(body, label, inp, hint);
  };
  const selRow = (label, key, items, hint) => {
    const sel = document.createElement("select");
    for (const v of items.length ? items : [rig[key]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      o.selected = v === rig[key];
      sel.appendChild(o);
    }
    sel.title = hint;
    sel.onchange = () => { rig[key] = sel.value; writeCfg(node); };
    pill(body, label, sel, hint);
  };
  numRow("Steps", "steps", 1, "Sampling steps for this rig.");
  numRow("CFG", "cfg", 0.1, "CFG for this rig. Turbo distills live near 1.");
  if (rig.kind && rig.kind !== "node") {
    // an external engine names its own samplers, so these are free text notes
    // riding the sockets, not comfy's lists
    const txtRow = (label, key, hint) => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = rig[key];
      inp.title = hint;
      inp.onchange = () => { rig[key] = inp.value; writeCfg(node); };
      pill(body, label, inp, hint);
    };
    txtRow("Sampler", "sampler",
           "Free text for an external engine's sampler name (NovelAI's names "
           + "are its own). Rides the sampler_name output as a plain value; a "
           + "comfy KSampler would not accept it, which is fine, this rig is "
           + "not for one.");
    txtRow("Scheduler", "scheduler",
           "Free text for the external engine's scheduler or noise schedule.");
    const drow = document.createElement("div");
    drow.className = "rn-ws-row";
    const dlab = document.createElement("span");
    dlab.className = "rn-ws-note";
    dlab.style.cssText = "flex:none;width:110px";
    dlab.textContent = "Denoise";
    const dr = document.createElement("input");
    dr.type = "range";
    dr.min = 0; dr.max = 1; dr.step = 0.01;
    dr.value = rig.denoise ?? 1.0;
    dr.style.cssText = "width:160px;height:20px;accent-color:#b8283c";
    dr.title = "The strength dial for the external engine, carried on the "
             + "workspace's denoise output while this rig is active. 1.0 for "
             + "a fresh render; lower it when you wire an image into the "
             + "engine for an i2i pass.";
    const dv = document.createElement("span");
    dv.className = "rn-ws-note";
    dv.textContent = Number(rig.denoise ?? 1.0).toFixed(2);
    dr.addEventListener("input", () => {
      rig.denoise = snapStep(dr.value, 0, 1, 0.05);
      dv.textContent = Number(rig.denoise).toFixed(2);
      writeCfg(node);
    });
    drow.append(dlab, dr, dv);
    body.appendChild(drow);
  } else {
    selRow("Sampler", "sampler", L.samplers || [],
           "Comes out typed, so it wires straight into a KSampler's sampler_name.");
    // the pack's own three shapes ride the rig's dropdown after core's list: the
    // built-in sampler runs them, a stock KSampler on the socket gets "simple"
    selRow("Scheduler", "scheduler", [...(L.schedulers || []), ...RIG_EXTRA_SCHEDULERS],
           "Wires straight into a KSampler's scheduler. beta57, bong_tangent and "
           + "hyperbolic are this pack's own shapes: the built-in sampler and the "
           + "Detailer run them, and the scheduler socket hands a stock KSampler "
           + "simple instead.");
    // A SECOND PAIR, for image to image runs only. Blank is what every rig saved
    // before this had, and blank means the pair above, so nothing moves unasked.
    const i2iRow = (label, key, items, hint) => {
      const sel = document.createElement("select");
      const cur = String(rig[key] || "");
      for (const [v, t] of [["", "Same as above"]].concat((items || []).map((v) => [v, v]))) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        o.selected = v === cur;
        sel.appendChild(o);
      }
      sel.title = hint;
      sel.onchange = () => { rig[key] = sel.value; writeCfg(node); };
      pill(body, label, sel, hint);
    };
    i2iRow("i2i sampler", "i2i_sampler", L.samplers || [],
           "The sampler an IMAGE TO IMAGE run uses in place of the one above. The "
         + "whole run follows it: the render, the paint pass, and the detailer, "
         + "which inherits whatever the rig hands it. The sampler that draws well "
         + "from noise is not always the one that repaints well over a picture that "
         + "already exists. Same as above leaves i2i on the main sampler, and a "
         + "blank canvas always uses the main pair, refine passes included.");
    i2iRow("i2i scheduler", "i2i_scheduler", L.schedulers || [],
           "The scheduler an image to image run uses in place of the one above, on "
         + "the same terms as the i2i sampler beside it. Same as above leaves i2i "
         + "on the main scheduler.");
  }
  numRow("Detailer steps", "detailer_steps", 1,
         "Steps for detailer passes, on its own output.");
  // LORA SET: which LoRAs-tab set this rig renders with. Main by default.
  // Detailer passes and the paint pass on this rig inherit the choice unless
  // they pick their own set.
  if (rig.kind !== "external") {
    if (typeof rig.lora_set !== "string") rig.lora_set = "";
    const sel = loraSetSelect(node, cfg, () => rig.lora_set, (v) => { rig.lora_set = v; },
      MAIN_SET, "The LoRAs-tab set this rig renders with. Detailer passes and the paint "
              + "pass on this rig inherit it unless they pick their own. Make sets with "
              + "the + on the LoRAs tab.");
    pill(body, "LoRA set", sel,
         "Which LoRAs-tab set this rig renders with. Main = the first tab there.");
    dialsCard(node, rig, body);
  }

  // The embedded sampler: comfy core's KSampler run inside the node. External is
  // the default; the five settings above still ride the outputs either way.
  const smRow = document.createElement("div");
  smRow.className = "rn-ws-row";
  const smSeg = document.createElement("div");
  smSeg.className = "rn-ws-seg";
  for (const [value, label, tip] of [
    ["external", "External sampler", "Wire your own KSampler: model, clip and the "
                                     + "five settings above come out as sockets. A camera "
                                     + "path renders its shots only with the built-in "
                                     + "sampler; here it is shot 1."],
    ["internal", "Built-in sampler", "The node runs comfy core's KSampler and the "
                                     + "VAE decode itself: positive, negative and "
                                     + "the finished image come out as sockets."],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    b.className = "rn-ws-segb" + (M.sampler_mode === value ? " on" : "");
    b.onclick = () => { M.sampler_mode = value; writeCfg(node); render(node); };
    smSeg.appendChild(b);
  }
  smRow.appendChild(smSeg);
  body.appendChild(smRow);
  if (M.sampler_mode === "internal") {
    body = mkBox("Seed", "#8fa8c8", "🎲");
    {
      const sub = document.createElement("div");
      sub.className = "rn-ws-note";
      sub.textContent = "Seed value used to generate results.";
      body.appendChild(sub);
    }
    // THE NUMBER, in its own big field: the mock's seed box, tall and full
    // width, the state riding inside at the right edge
    const seedBox = document.createElement("div");
    seedBox.style.cssText = "display:flex;align-items:center;gap:10px;background:#101216;"
      + "border:1px solid #2f333a;border-radius:8px;padding:0 14px;min-height:46px";
    const seed = document.createElement("input");
    seed.type = "number";
    seed.min = 0;
    seed.value = M.seed;
    seed.disabled = M.seed_random;
    seed.style.cssText = "flex:1;min-width:0;background:transparent;border:none;"
      + "outline:none;color:#e8ecf1;font-size:16px;font-weight:600;padding:0";
    seed.title = M.seed_random
      ? "Random every run: pin one with New fixed random or Use last queued to edit."
      : "The pinned seed. Type one, or use the buttons below.";
    seed.addEventListener("change", () => {
      M.seed = Math.max(0, parseInt(seed.value, 10) || 0);
      writeCfg(node);
    });
    const state = document.createElement("span");
    state.className = "rn-ws-note";
    state.style.cssText = "flex:none;font-size:12px";
    state.textContent = M.seed_random ? "Random every run" : "Fixed";
    seedBox.append(seed, state);
    body.appendChild(seedBox);

    // THE THREE ACTIONS, tall bordered buttons in a row, each in its tint;
    // the active mode fills. Copy is a fourth, full-width, when there is a
    // last seed to copy - a real button, not a note.
    const act = document.createElement("div");
    act.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:8px";
    const mkSeedBtn = (icon, label, tip, fn, opts = {}) => {
      const b = document.createElement("button");
      const tint = opts.tint || "#8fa8c8";
      b.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;"
        + "min-height:44px;padding:0 12px;border-radius:8px;cursor:pointer;"
        + "font-size:13px;font-weight:600;"
        + (opts.on
           ? "background:" + tint + ";border:1px solid " + tint + ";color:#fff"
           : "background:#15171b;border:1px solid " + tint + "88;color:" + tint);
      const ic = document.createElement("span");
      ic.textContent = icon;
      ic.style.fontSize = "15px";
      const tx = document.createElement("span");
      tx.textContent = label;
      b.append(ic, tx);
      b.title = tip;
      b.disabled = !!opts.disabled;
      if (b.disabled) b.style.opacity = ".4";
      b.onclick = fn;
      return b;
    };
    const last = node._rnLastSeed;
    act.append(
      mkSeedBtn("🔀", "Random each run",
        "A fresh seed every queue, the default.",
        () => { M.seed_random = true; writeCfg(node); render(node); },
        { on: M.seed_random, tint: "#b8283c" }),
      mkSeedBtn("🎲", "New fixed random",
        "Roll one random seed and PIN it, for repeatable A/B runs.",
        () => {
          M.seed = Math.floor(Math.random() * 2 ** 48);
          M.seed_random = false;
          writeCfg(node); render(node);
        }, { on: !M.seed_random && node._rnSeedMode === "fixed", tint: "#4a8fe0" }),
      mkSeedBtn("🕓", "Use last queued",
        last == null
          ? "Becomes available after the first queue this session."
          : "Pin the seed the last run actually used: " + last,
        () => {
          if (node._rnLastSeed == null) return;
          M.seed = node._rnLastSeed;
          M.seed_random = false;
          node._rnSeedMode = "last";
          writeCfg(node); render(node);
        }, { disabled: last == null, tint: "#c8ccd2" }));
    body.appendChild(act);
    if (last != null) {
      const cp = mkSeedBtn("📋", "Copy last used seed: " + last,
        "Copy it to the clipboard.",
        () => {
          navigator.clipboard?.writeText(String(last));
          cp.lastChild.textContent = "Copied " + last;
          setTimeout(() => { cp.lastChild.textContent = "Copy last used seed: " + last; }, 1200);
        }, { tint: "#8fa8c8" });
      cp.style.width = "100%";
      body.appendChild(cp);
    }
  }
}

// ---------------------------------------------------------------- Prompts tab
// Named prompts, each linked to a rig by name. Krea 2 prompts belong in the RedNode
// Prompt Box style; anything else gets a plain box, which is the switch on each row.
// The Prompt Frame's own field lists, read off the node definition so the tab and
// the node can never disagree about a dropdown. One fetch per session.
let FRAME_DEF = null;
async function fetchFrameDef() {
  if (FRAME_DEF) return FRAME_DEF;
  try {
    const r = await api.fetchApi("/object_info/RedNodePromptFrame");
    const d = await r.json();
    const req = d?.RedNodePromptFrame?.input?.required || {};
    const opt = d?.RedNodePromptFrame?.input?.optional || {};
    const all = { ...req, ...opt };
    const listOf = (n) => (Array.isArray(all[n]?.[0]) ? all[n][0] : []);
    const defOf = (n) => all[n]?.[1]?.default;
    FRAME_DEF = {
      opts: {
        style: listOf("style"), framing: listOf("framing"),
        framing_push: listOf("framing_push"),
        camera_height: listOf("camera_height"),
        placement_where: listOf("placement_where"),
        placement_what: listOf("placement_what"), lighting: listOf("lighting"),
        brightness_min: all.brightness?.[1]?.min ?? -3,
        brightness_max: all.brightness?.[1]?.max ?? 3,
        push_tooltip: all.framing_push?.[1]?.tooltip || "",
      },
      defaults: {
        style: defOf("style") ?? "None", style_extra: "",
        subject: "", surroundings: "",
        framing: defOf("framing") ?? "Balanced",
        framing_push: defOf("framing_push") ?? "Off",
        camera_height: defOf("camera_height") ?? "Eye level",
        camera_off: defOf("camera_off") ?? false,
        placement_where: defOf("placement_where") ?? "None",
        placement_what: defOf("placement_what") ?? "None",
        placement: "", lighting: defOf("lighting") ?? "None",
        brightness: defOf("brightness") ?? 0, light_and_colour: "",
      },
    };
  } catch (e) { /* server not up; the tab shows a note instead */ }
  return FRAME_DEF;
}

// A SWITCH SHOWS BOTH WORDS. One button whose label changes with its state
// reads as "press me to do this" as easily as "this is on", and it cost more
// than one session of confusion. Every two-way (or three-way) choice on the
// panel is a segment: every option visible, the live one filled, like the
// Canvas row and the Camera tab's Prompt / Image to image pair.
function segSwitch(options, current, onPick, title) {
  const seg = document.createElement("div");
  seg.className = "rn-ws-seg rn-ws-switch";
  if (title) seg.title = title;
  for (const [value, label, tip] of options) {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (current === value ? " on" : "");
    b.textContent = label;
    if (tip) b.title = tip;
    b.onclick = () => { if (current !== value) onPick(value); };
    seg.appendChild(b);
  }
  return seg;
}

function promptsBody(node, body) {
  const cfg = node._rnCfg;
  const R = cfg.prompts.rows;
  const M = cfg.models;

  // the mock's masthead: title, subtitle, and the RIG bar so the prompt you
  // are writing is visibly the active rig's
  {
    const head = document.createElement("div");
    head.style.cssText = "display:flex;flex-direction:column;gap:2px";
    const h1 = document.createElement("div");
    h1.style.cssText = "font-size:19px;font-weight:700;color:#e8ecf1";
    h1.textContent = "Prompts";
    const sub = document.createElement("div");
    sub.className = "rn-ws-note";
    sub.textContent = "Write prompts that live with the model they were written for.";
    head.append(h1, sub);
    body.appendChild(head);
    // the PROMPT bar: switch and add prompts up here, one
    // editor below for the active one. The chip names the prompt and its
    // rig; the active prompt is lit and badged.
    {
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"
        + "background:#1a1d22;border:1px solid #2a2e34;border-radius:7px;padding:9px";
      const bt = document.createElement("span");
      bt.style.cssText = "font-size:11px;font-weight:700;letter-spacing:.06em;"
        + "color:#a855f7;flex:none";
      bt.textContent = "PROMPT";
      bar.appendChild(bt);
      if (typeof node._rnPromptSel !== "number" || node._rnPromptSel >= R.length) {
        node._rnPromptSel = Math.max(0, R.length - 1);
      }
      R.forEach((row, i) => {
        const chip = document.createElement("button");
        const on = node._rnPromptSel === i;
        chip.style.cssText = "display:flex;align-items:center;gap:7px;padding:8px 14px;"
          + "border-radius:7px;cursor:pointer;font-size:13px;font-weight:600;"
          + "background:" + (on ? "#a855f71a" : "#15171b") + ";border:1px solid "
          + (on ? "#a855f7" : "#2a2e34") + ";color:#e8ecf1";
        const nm = document.createElement("span");
        nm.textContent = row.name || ("Prompt " + (i + 1));
        chip.appendChild(nm);
        {
          const rigsOf = Array.isArray(row.rigs) ? row.rigs : (row.rig ? [row.rig] : []);
          if (rigsOf.length) {
            const rg = document.createElement("span");
            rg.className = "rn-ws-note";
            rg.textContent = rigsOf.join(" · ");
            chip.appendChild(rg);
          }
        }
        if (on) {
          const badge = document.createElement("span");
          badge.textContent = "ACTIVE";
          badge.style.cssText = "font-size:9px;font-weight:700;padding:2px 7px;"
            + "border-radius:8px;background:#1e5233;color:#a7f3c0";
          chip.appendChild(badge);
        }
        chip.title = "Edit this prompt below.";
        chip.onclick = () => { node._rnPromptSel = i; render(node); };
        bar.appendChild(chip);
      });
      const addP = document.createElement("button");
      addP.className = "rn-ws-btn";
      addP.style.cssText = "width:auto;padding:0 14px";
      addP.textContent = "\uFF0B New Prompt";
      addP.onclick = () => {
        R.push({ name: "", rig: "", rigs: [], kind: "krea2", text: "", negative: "" });
        node._rnPromptSel = R.length - 1;
        writeCfg(node); render(node);
      };
      bar.appendChild(addP);
      body.appendChild(bar);
    }
  }
  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = R.length
    ? "" : "No prompts yet. Add one, name it, and link it to a rig from the Models tab.";
  if (note.textContent) body.appendChild(note);

  R.forEach((row, i) => {
    if (i !== node._rnPromptSel) return;      // one editor: the active prompt's
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:7px;"
                      + "background:#1a1d22;border:1px solid #2a2e34;border-radius:6px";
    const folded = () => false;
    const head = document.createElement("div");
    head.className = "rn-ws-row";

    const name = document.createElement("input");
    name.type = "text";
    name.value = row.name;
    name.placeholder = "Prompt " + (i + 1);
    // a set width, so the rig chips and the box kind sit right after the name
    // instead of at the far end of a box nobody needs that wide
    name.style.cssText = "flex:0 0 200px;min-width:0;background:#15171b;border:1px solid "
                       + "#33373d;border-radius:4px;color:#e8ecf1;font-size:13px;"
                       + "padding:4px 7px";
    name.addEventListener("change", () => { row.name = name.value; writeCfg(node); render(node); });
    // RIGS: a chip per rig on
    // the Models tab, click to include or drop; row.rig mirrors the first for
    // older readers. No chip lit = an unlinked row that serves any rig.
    const rigPick = document.createElement("div");
    rigPick.className = "rn-ws-seg";
    rigPick.title = "Which Models-tab rigs this prompt serves. Click to add or remove; "
                  + "none lit = it serves any rig that has no prompt of its own.";
    if (!Array.isArray(row.rigs)) row.rigs = row.rig ? [row.rig] : [];
    cfg.models.rigs.forEach((r, j) => {
      const nm = r.name || "Rig " + (j + 1);
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (row.rigs.includes(nm) ? " on" : "");
      b.textContent = nm;
      b.onclick = () => {
        row.rigs = row.rigs.includes(nm) ? row.rigs.filter((x) => x !== nm) : [...row.rigs, nm];
        row.rig = row.rigs[0] || "";
        writeCfg(node); render(node);
      };
      rigPick.appendChild(b);
    });
    if (!cfg.models.rigs.length) {
      const e = document.createElement("span"); e.className = "rn-ws-note"; e.textContent = "No rigs yet (Models tab)";
      rigPick.appendChild(e);
    }
    const kind = segSwitch([
      ["krea2", "Krea 2 box", "The frame editor: Style, Subject, Surroundings, Light and "
                              + "colour and the camera, with wildcards and @keywords."],
      ["plain", "Plain box", "One plain text box, for any other model or for a prompt "
                             + "you want typed as is."],
    ], row.kind === "krea2" ? "krea2" : "plain",
    (v) => { row.kind = v; writeCfg(node); render(node); });
    const del = document.createElement("button");
    del.className = "rn-ws-btn";
    del.style.width = "auto";
    del.textContent = "\u2715";
    del.onclick = () => {
      R.splice(i, 1);
      node._rnPromptSel = Math.max(0, Math.min(node._rnPromptSel, R.length - 1));
      writeCfg(node); render(node);
    };
    // the Camera words switch lives on the frame editor's Camera section
    // (rednode_prompt_frame.js), where the chips it greys out are
    if (row.kind !== "plain") {
      row.frame = row.frame && typeof row.frame === "object" ? row.frame : {};
    }
    head.append(name, rigPick, kind, del);
    box.appendChild(head);

    if (folded()) { body.appendChild(box); return; }

    if (row.kind === "krea2") {
      // THE PROMPT FRAME ITSELF, one for one: the same buildFrameEditor the node's
      // panel calls, values living in row.frame, the assembled prompt streaming into
      // row.text through the same server preview the node uses. What you asked
      // for three times, drawn by the code that already existed.
      if (!FRAME_DEF) {
        const wait = document.createElement("div");
        wait.className = "rn-ws-note";
        wait.textContent = "Loading the Prompt Frame fields...";
        box.appendChild(wait);
        fetchFrameDef().then(() => render(node));
      } else {
        row.frame = row.frame && typeof row.frame === "object" ? row.frame : {};
        const host = document.createElement("div");
        const typedOf = (n) => (row.frame[n] !== undefined ? row.frame[n]
                                                           : FRAME_DEF.defaults[n]);
        const camOff = () => !!row.frame.camera_off;
        const tabOff = () => !!(cfg.camera && cfg.camera.on === false);
        const F = {
          opts: FRAME_DEF.opts,
          get: typedOf,
          // the preview writes row.text, which is what the queue encodes, so it
          // assembles with the camera the run will actually have: none when the
          // Camera tab or the row's Camera words switch is off
          getPreview: (n) => (n === "camera" ? ((camOff() || tabOff()) ? "" : typedOf(n))
                              : n === "camera_height" ? (camOff() ? "Eye level" : typedOf(n))
                              : typedOf(n)),
          resolveWildcards: false,   // the queue rolls them with the run seed
          set: (n, v) => { row.frame[n] = v; },
          folds: {
            get: (k) => node.properties?.rn_prompt_groups?.[i + ":" + k],
            set: (k, v) => {
              node.properties = node.properties || {};
              (node.properties.rn_prompt_groups ||= {})[i + ":" + k] = v;
            },
          },
          dirty: () => writeCfg(node),
          onPreview: (assembled) => {
            // the row's text IS the assembled prompt, so everything downstream
            // (the paint fallback, prompt_row_for) reads it with no new plumbing
            if (row.text !== assembled) { row.text = assembled; writeCfg(node); }
          },
        };
        // the mock's two columns: the frame on the left, the assembled prompt
        // in a PROMPT PREVIEW card on the right, side by side when wide
        // the frame lays itself out in two columns now (writing left,
        // dials and preview right), the arrangement you drew
        F.twoColumn = true;
        // the studio has its own tab now: Advanced on the frame opens it there
        F.openCameraTab = () => {
          node._rnPromptSel = i; node._rnCameraSub = "prompt";
          node._rnTab = "camera"; (node.properties ||= {}).rn_tab = "camera"; render(node);
        };
        // the Auto sort button borrows the Auto Prompt's Ollama choice
        F.sortModel = () => cfg.auto?.model || "";
        F.sortUrl = () => cfg.auto?.url || "";
        // the studio's own live paragraph, for the panel's CAMERA PROMPT card
        F.studioPreview = async (state) => {
          const r = await fetch("/rednode/camera_studio_preview", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state),
          });
          const j = await r.json();
          return j.prompt || "";
        };
        const ed = buildFrameEditor(host, F);
        ed.previewNow();
        box.appendChild(host);


      }
    } else {
      const text = document.createElement("textarea");
      text.rows = 3;
      text.value = row.text;
      text.placeholder = "Prompt...";
      text.style.cssText = "width:100%;box-sizing:border-box;background:#101216;"
                         + "border:1px solid #2a2e34;border-radius:5px;color:#e2e5ea;"
                         + "font-size:13px;padding:6px 8px;resize:vertical";
      text.addEventListener("change", () => { row.text = text.value; writeCfg(node); });
      box.appendChild(expandable(text, (row.name || "Prompt") + " \u00b7 prompt",
                                 (v) => { row.text = v; writeCfg(node); }));
    }

    const neg = document.createElement("textarea");
    neg.rows = 2;
    neg.value = row.negative;
    neg.placeholder = "Negative (optional)";
    neg.style.cssText = "width:100%;box-sizing:border-box;background:#101216;"
                      + "border:1px solid #2a2e34;border-radius:5px;color:#b08a8a;"
                      + "font-size:12px;padding:6px 8px;resize:vertical";
    neg.addEventListener("change", () => { row.negative = neg.value; writeCfg(node); });
    box.appendChild(expandable(neg, (row.name || "Prompt") + " \u00b7 negative",
                               (v) => { row.negative = v; writeCfg(node); }));
    body.appendChild(box);
  });

  const add = document.createElement("span");
  add.style.display = "none";                // adding moved to the PROMPT bar
  body.appendChild(add);
}

// THE BIG PROMPT EDITOR, the Sick Ollie interaction you asked for: a
// small box grows into a proper fullscreen writing surface. Esc cancels,
// Ctrl+Enter saves, Save commits through the same change path the inline box
// uses, so config writing stays in one place.
// ONE CARD STYLE for grouped controls, your box treatment: slightly
// darker ground, a border, a small title. The Latent tab's CANVAS card set
// the look; every tab's clusters use this same helper now.
// fold: {node, key, open} makes the card a fold-down section (
// SOURCE / PASS / RE-ANGLE like AUTO PROMPT). The head toggles it; the state
// lives on node._rnCardFolds[key] so a re-render keeps it. Everything after the
// head hides when folded.
function sectionCard(title, accent, summary, fold) {
  const card = document.createElement("div");
  const a = accent || "#8fa8c8";
  card.style.cssText = "display:flex;flex-direction:column;gap:7px;"
    + "background:#1b1e23;border:1px solid " + a + "55;border-radius:7px;"
    + "padding:9px";
  if (title) {
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:baseline;gap:8px";
    if (fold && fold.node) {
      const folds = (fold.node._rnCardFolds ||= {});
      const isOpen = folds[fold.key] === undefined ? fold.open !== false : !!folds[fold.key];
      const arr = document.createElement("span");
      arr.className = "arr";
      arr.style.cssText = "color:" + a + ";cursor:pointer;font-size:12px";
      arr.textContent = isOpen ? "▾" : "▸";
      head.appendChild(arr);
      head.style.cursor = "pointer";
      head.onclick = (e) => {
        if (e.target && e.target !== head && e.target !== arr && e.target.tagName !== "DIV") return;
        folds[fold.key] = !isOpen;
        render(fold.node);
      };
      if (!isOpen) card.classList.add("rn-ws-card-folded");
    }
    const t = document.createElement("div");
    t.style.cssText = "font-size:11px;font-weight:700;letter-spacing:.06em;"
      + "color:" + a;
    t.textContent = title;
    head.appendChild(t);
    if (summary) {
      const sm = document.createElement("div");
      sm.style.cssText = "margin-left:auto;font-size:11px;color:#7f8792";
      sm.textContent = summary;
      head.appendChild(sm);
    }
    card.appendChild(head);
  }
  return card;
}

function openBigEdit(title, value, onSave) {
  document.querySelector(".rn-ws-bigedit")?.remove();
  const ov = document.createElement("div");
  ov.className = "rn-ws-bigedit";
  ov.style.cssText = "position:fixed;inset:0;z-index:10050;background:#0c0d10ee;"
    + "display:flex;align-items:center;justify-content:center";
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;gap:10px;"
    + "width:min(920px,94vw);height:min(72vh,760px);background:#16181c;"
    + "border:1px solid #3a3f47;border-radius:8px;padding:14px;"
    + "box-shadow:0 10px 40px rgba(0,0,0,.6)";
  const h = document.createElement("div");
  h.style.cssText = "font:600 14px system-ui,sans-serif;color:#e8ecf1";
  h.textContent = title;
  const ta = document.createElement("textarea");
  ta.value = value || "";
  ta.style.cssText = "flex:1;min-height:0;background:#101216;border:1px solid "
    + "#2a2e34;border-radius:6px;color:#e2e5ea;font-size:14px;line-height:1.5;"
    + "padding:10px 12px;resize:none";
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
  const mk = (label, primary, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "padding:7px 18px;border-radius:5px;font-size:13px;"
      + "cursor:pointer;border:1px solid " + (primary
        ? "#2e7d4f;background:#2e7d4f;color:#fff"
        : "#33373d;background:#15171b;color:#c8ccd2");
    b.onclick = fn;
    return b;
  };
  const closeIt = () => ov.remove();
  const saveIt = () => { onSave(ta.value); closeIt(); };
  foot.append(mk("Cancel", false, closeIt), mk("Save", true, saveIt));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeIt(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveIt();
  });
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeIt(); });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.append(h, ta, foot);
  ov.appendChild(panel);
  document.body.appendChild(ov);
  ta.focus();
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
}

// Wraps a textarea so it can grow: an expand glyph in the corner, and a
// double-click anywhere in the box, both open the big editor.
function expandable(ta, title, onSave) {
  // THE WRAPPER MUST CARRY THE TEXTAREA'S SIZING ( "the
  // prompt box is the wrong size, not wide enough"). These boxes sit in flex
  // rows and size themselves with flex:1, but wrapping one in a plain block
  // left that flex:1 with nothing to flex against, so the textarea fell back
  // to its intrinsic ~20-column width - a narrow box in a wide pane. The wrap
  // takes the flex role, and the textarea fills it.
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;flex:1;min-width:0;width:100%";
  ta.style.width = "100%";
  ta.style.boxSizing = "border-box";
  ta.style.flex = "none";
  const btn = document.createElement("button");
  btn.textContent = "\u26F6";
  btn.title = "Open the fullscreen editor. Double-clicking the box does the "
            + "same; Esc cancels, Ctrl+Enter saves.";
  btn.style.cssText = "position:absolute;top:3px;right:6px;z-index:2;"
    + "background:#15171bcc;border:1px solid #33373d;border-radius:4px;"
    + "color:#9aa0a8;cursor:pointer;font-size:11px;padding:1px 5px";
  const open = () => openBigEdit(title, ta.value, (v) => {
    ta.value = v;
    onSave(v);
  });
  btn.onclick = open;
  ta.addEventListener("dblclick", open);
  wrap.append(ta, btn);
  return wrap;
}

function latentBody(node, body) {
  const cfg = node._rnCfg;
  const L = cfg.latent;
  const eff = (v) => Math.floor(v * (L.scale || 1) / 8) * 8;   // what actually ships

  // CANVAS and PASSES as sub-tabs, the Img2Img layout: a light each, a status bar
  const nP = Math.max(1, Math.min(PASS_MAX, Math.round(Number(L.passes) || 1)));
  const props = (node.properties ||= {});
  let sub = node._rnLatSub || props.rn_latent_sub || "canvas";
  if (sub !== "canvas" && sub !== "passes") sub = "canvas";
  node._rnLatSub = sub;
  const strip = document.createElement("div");
  strip.className = "rn-ws-sub";
  for (const [id, label, lit, tip] of [
    ["canvas", "CANVAS", !!L.on, "The empty latent: its shape, size and batch."],
    ["passes", "PASSES", !!(L.on && nP > 1),
     "The built-in sampler's passes on this canvas: pass 1 generates, the rest refine."],
  ]) {
    const b = document.createElement("button");
    b.className = "rn-ws-subt" + (id === sub ? " cur" : "");
    b.dataset.sub = id;
    b.title = tip;
    const lt = document.createElement("span");
    lt.className = "lt" + (lit ? " on" : "");
    const tx = document.createElement("span");
    tx.textContent = label;
    b.append(lt, tx);
    b.onclick = () => { node._rnLatSub = id; props.rn_latent_sub = id; render(node); };
    strip.appendChild(b);
  }
  body.appendChild(strip);

  const bar = document.createElement("div");
  bar.className = "rn-ws-status";
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (L.on ? " on" : "");
  on.title = L.on ? "The empty latent goes out on output_latent."
                  : "Off: output_latent stays empty unless the edit mask provides one.";
  on.onclick = () => { L.on = !L.on; writeCfg(node); render(node); };
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = "Latent";
  const srcBtn = segSwitch([
    ["tab", "This tab", "The canvas is built here, from the size on the Canvas tab. The "
                        + "workspace's own Empty Latent Image: wire output_latent to the "
                        + "sampler and to the studio, one source for both."],
    ["input", "Wired input", "output_latent is whatever you wired into the node's latent "
                             + "socket. The size controls are ignored; the passes still run."],
  ], L.source === "input" ? "input" : "tab",
  (v) => { L.source = v; writeCfg(node); render(node); });
  bar.append(on, nm, srcBtn);
  for (const text of [
    L.source === "input" ? "Wired latent" : L.random ? "Random size"
      : `${eff(L.w)} × ${eff(L.h)}`,
    L.source === "input" || L.random ? "" : (L.aspect || "Custom"),
    `Batch ${L.batch}`,
    nP > 1 ? `${nP} Passes` : "Single pass",
  ]) {
    if (!text) continue;
    const c = document.createElement("span");
    c.className = "rn-ws-chip";
    c.textContent = text;
    bar.appendChild(c);
  }
  // RESET: a square 1024 canvas, one latent, one pass, nothing varied per pass. The
  // switch and the source are left as they are.
  const reset = document.createElement("button");
  reset.className = "rn-ws-btn rn-ws-compact rn-ws-latreset";
  reset.style.cssText = "margin-left:auto;padding:0 12px";
  reset.textContent = "↺ Reset";
  reset.title = "Back to the start: a square 1024 × 1024 canvas, batch 1, random off, a "
              + "single pass, and every per-pass setting cleared.";
  reset.onclick = () => {
    Object.assign(L, { aspect: "1:1", w: 1024, h: 1024, scale: 1, batch: 1, random: false,
                       passes: 1, refine: 0.45, pass_custom: false, scale_custom: false,
                       steps_custom: false, rig_custom: false, handoff_continue: false });
    for (const k of ["mp", "pass_denoise", "pass_scale", "pass_steps", "pass_rig"]) delete L[k];
    writeCfg(node);
    render(node);
  };
  bar.appendChild(reset);
  body.appendChild(bar);
  if (sub === "passes") {
    passesTab(node, body, "latent");
    return;
  }
  if (L.source === "input") {
    const note = document.createElement("div");
    note.className = "rn-ws-note";
    note.textContent = "Wire your latent into the node's latent input. Nothing wired "
                     + "there falls back to this canvas.";
    body.appendChild(note);
  }

  // the visual stage: the canvas drawn at its real aspect, draggable to reshape.
  // Horizontal drag changes width, vertical changes height, snapped to 64.
  const vrow = document.createElement("div");
  vrow.className = "rn-ws-row";
  vrow.style.alignItems = "flex-start";
  const stage = document.createElement("div");
  stage.className = "rn-ws-latstage";
  const rect = document.createElement("div");
  rect.className = "rn-ws-latrect" + (L.random ? " rolling" : "");
  const fit = 360 / Math.max(L.w, L.h);
  rect.style.width = Math.max(48, Math.round(L.w * fit)) + "px";
  rect.style.height = Math.max(40, Math.round(L.h * fit)) + "px";
  rect.style.flexDirection = "column";
  rect.style.fontSize = "20px";
  const ASPECT_LIST = [
    ["1:1", 1, 1, "Square"], ["2:3", 2, 3, "Portrait"],
    ["3:4", 3, 4, "Portrait Standard"], ["4:5", 4, 5, "Portrait Tall"],
    ["9:16", 9, 16, "Portrait Phone"], ["4:3", 4, 3, "Landscape Standard"],
    ["3:2", 3, 2, "Landscape"], ["16:9", 16, 9, "Widescreen"],
  ];
  const rectLabel = () => {
    if (L.random) { rect.textContent = "?"; return; }
    const a = ASPECT_LIST.find((x) => Math.abs(L.w / L.h - x[1] / x[2]) < 0.02);
    rect.replaceChildren();
    const big = document.createElement("span");
    big.textContent = eff(L.w) + " × " + eff(L.h);
    const smallL = document.createElement("span");
    smallL.style.cssText = "font-size:11px;font-weight:600;opacity:.75";
    smallL.textContent = a ? a[0] + " · " + a[3] : "custom";
    rect.append(big, smallL);
  };
  rectLabel();
  rect.title = L.random
    ? "Random is on: a preset size is rolled each queue."
    : "Drag an EDGE to reshape: top or bottom changes height, left or right "
      + "changes width. The pixel budget stays locked, so this changes the "
      + "ratio, not the scale. Snaps to 64.";
  if (!L.random) {
    // EDGE-HANDLE RESIZE, your spec: grab the top or bottom edge and
    // only height moves; grab left or right and only width moves; the edge
    // you hold lights up; the pixel BUDGET is locked, so a drag trades one
    // dimension for the other and the total pixels stay where the Scale
    // slider put them - reshaping the ratio, never the scale.
    const EDGE = 14;               // px from an edge that counts as that edge
    const edgeAt = (ev) => {
      const r = rect.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const dl = x, dr = r.width - x, dt = y, db = r.height - y;
      const m = Math.min(dl, dr, dt, db);
      if (m > EDGE) return null;
      if (m === dt) return "top";
      if (m === db) return "bottom";
      if (m === dl) return "left";
      return "right";
    };
    const cursorFor = (edge) => (edge === "top" || edge === "bottom") ? "ns-resize"
                              : edge ? "ew-resize" : "default";
    const glow = (edge) => {
      // the held edge in blue at 3px, the rest at their resting 2px
      const on = "3px solid #9dc0ff", off = "2px solid #4a8fe0";
      rect.style.borderTop = edge === "top" ? on : off;
      rect.style.borderBottom = edge === "bottom" ? on : off;
      rect.style.borderLeft = edge === "left" ? on : off;
      rect.style.borderRight = edge === "right" ? on : off;
    };
    rect.addEventListener("pointermove", (ev) => {
      if (rect._rnDrag) return;
      const edge = edgeAt(ev);
      rect.style.cursor = cursorFor(edge);
      glow(edge);
    });
    rect.addEventListener("pointerleave", () => { if (!rect._rnDrag) glow(null); });
    rect.addEventListener("pointerdown", (e) => {
      const edge = edgeAt(e);
      if (!edge) return;           // the middle is not a handle
      // OWN THE GESTURE: without capture, the moment the pointer leaves the
      // panel LiteGraph takes the drag and pans the canvas, and the events
      // stop reaching us, so the box freezes half-resized
      e.stopPropagation();
      e.preventDefault();
      try { rect.setPointerCapture(e.pointerId); } catch (err) { /* older hosts */ }
      rect._rnDrag = edge;
      glow(edge);
      const startX = e.clientX, startY = e.clientY, w0 = L.w, h0 = L.h;
      const budget = w0 * h0;      // locked for the whole drag
      const snap = (v) => Math.max(256, Math.min(4096, Math.round(v / 64) * 64));
      // 3 px of pointer per 8 canvas px: a full sweep of the stage covers a
      // sensible range instead of the old x6, which you found twitchy
      const GAIN = 8 / 3;
      const move = (ev) => {
        let w = w0, h = h0;
        if (edge === "left" || edge === "right") {
          const dx = ev.clientX - startX;
          w = snap(w0 + (edge === "right" ? dx : -dx) * GAIN);
          h = snap(budget / w);
        } else {
          const dy = ev.clientY - startY;
          h = snap(h0 + (edge === "bottom" ? dy : -dy) * GAIN);
          w = snap(budget / h);
        }
        L.w = w; L.h = h;
        const f = 360 / Math.max(L.w, L.h);
        rect.style.width = Math.max(48, Math.round(L.w * f)) + "px";
        rect.style.height = Math.max(40, Math.round(L.h * f)) + "px";
        rectLabel();
      };
      const up = (ev) => {
        rect.removeEventListener("pointermove", move);
        rect.removeEventListener("pointerup", up);
        rect.removeEventListener("pointercancel", up);
        try { rect.releasePointerCapture(ev.pointerId); } catch (err) { /* ok */ }
        rect._rnDrag = null;
        glow(null);
        // hand-shaped: the tag goes unless the new ratio IS a preset; the
        // budget stays the budget, that is the whole point of the lock
        const hit = ASPECT_LIST.find((x) => Math.abs(L.w / L.h - x[1] / x[2]) < 0.02);
        L.aspect = hit ? hit[0] : "";
        writeCfg(node); render(node);
      };
      // listeners on the CAPTURING element: with capture set, every move and
      // the release arrive here wherever the pointer roams
      rect.addEventListener("pointermove", move);
      rect.addEventListener("pointerup", up);
      rect.addEventListener("pointercancel", up);
    });
  }
  {
    const sqPx = Math.round(1024 * fit);
    if (!L.random && sqPx <= 400) {
      const sq = document.createElement("div");
      sq.className = "rn-ws-latsq";
      sq.style.width = sq.style.height = sqPx + "px";
      const sl = document.createElement("span");
      sl.textContent = "1024 × 1024";
      sq.appendChild(sl);
      stage.appendChild(sq);
    }
  }
  stage.appendChild(rect);

  // ASPECT presets, the Sick Ollie canvas system you preferred: a ratio
  // shapes the pixel budget (the Scale number below) into a canvas, floored
  // to 64s. w/h stay the stored truth, so nothing downstream changes.
  const ASPECTS = ASPECT_LIST;
  const mpOf = () => (typeof L.mp === "number" && L.mp > 0)
    ? L.mp
    : Math.max(0.25, Math.round((L.w * L.h * (L.scale || 1) * (L.scale || 1)) / 1e6 * 20) / 20);
  const mpCalc = (wr, hr, mp) => {
    const total = Math.max(0.05, mp) * 1e6;
    const w = Math.sqrt(total * wr / hr);
    const r64 = (v) => Math.max(256, Math.round(v / 64) * 64);
    return [r64(w), r64(w * hr / wr)];
  };
  const applyAspect = (key) => {
    const a = ASPECTS.find((x) => x[0] === key) || ASPECTS[2];
    L.aspect = a[0];
    L.mp = mpOf();
    const wh = mpCalc(a[1], a[2], L.mp);
    L.w = wh[0]; L.h = wh[1];
    L.scale = 1;                     // mp IS the budget now; no double scaling
    L.random = false;
    writeCfg(node); render(node);
  };
  const chips = document.createElement("div");
  chips.className = "rn-ws-latchips";
  for (const [key, wr, hr, name] of ASPECTS) {
    const chip = document.createElement("div");
    const cur = !L.random && (L.aspect ? L.aspect === key
      : Math.abs(L.w / L.h - wr / hr) < 0.02);
    chip.className = "rn-ws-latchip" + (cur ? " cur" : "");
    chip.title = key + " (" + name + ")";
    const mini = document.createElement("i");
    const mfit = 24 / Math.max(wr, hr);
    mini.style.width = Math.max(6, Math.round(wr * mfit)) + "px";
    mini.style.height = Math.max(6, Math.round(hr * mfit)) + "px";
    chip.appendChild(mini);
    const cl = document.createElement("span");
    cl.textContent = key;
    chip.appendChild(cl);
    chip.onclick = () => applyAspect(key);
    chips.appendChild(chip);
  }
  const dice = document.createElement("div");
  dice.className = "rn-ws-latchip rn-ws-latdice" + (L.random ? " cur" : "");
  dice.title = L.random
    ? "Random is on: one of these presets is rolled fresh each queue. Click to stop."
    : "Roll a random preset size on every queue.";
  const dIco = document.createElement("span");
  dIco.textContent = "🎲";
  dIco.style.fontSize = "16px";
  const dLab = document.createElement("span");
  dLab.textContent = "Random";
  dice.append(dIco, dLab);
  dice.onclick = () => { L.random = !L.random; writeCfg(node); render(node); };
  chips.appendChild(dice);

  // the whole canvas cluster lives in ONE card: slightly
  // darker ground and a border, so size controls read as a single place
  const cols = document.createElement("div");
  cols.style.cssText = "display:grid;grid-template-columns:minmax(0,1.5fr) "
    + "minmax(320px,1fr);gap:12px;align-items:start";
  const previewCard = sectionCard("CANVAS PREVIEW", "#4a8fe0");
  const canvasCard = sectionCard("SIZE", "#4a8fe0",
    (L.random ? "random preset" : L.w + " × " + L.h)
    + " · batch " + L.batch);
  vrow.style.flexDirection = "column";
  vrow.style.alignItems = "stretch";
  vrow.append(chips, stage);
  previewCard.appendChild(vrow);
  let statStrip = null;
  {
    const strip = document.createElement("div");
    strip.style.cssText = "display:grid;grid-template-columns:1fr;gap:8px";
    const cell = (icon, k, v) => {
      const c = document.createElement("div");
      c.style.cssText = "display:flex;align-items:center;gap:10px;background:#101216;"
        + "border:1px solid #2a2e34;border-radius:8px;padding:12px 14px";
      const ic = document.createElement("span");
      ic.textContent = icon;
      ic.style.cssText = "font-size:14px;color:#8fa8c8";
      const t = document.createElement("div");
      t.style.cssText = "display:flex;flex-direction:column;min-width:0";
      const kk = document.createElement("span");
      kk.className = "rn-ws-note";
      kk.textContent = k;
      const vv = document.createElement("span");
      vv.style.cssText = "font-size:15px;font-weight:600;color:#e8ecf1";
      vv.textContent = v;
      t.append(kk, vv);
      c.append(ic, t);
      return c;
    };
    const w0 = eff(L.w), h0 = eff(L.h);
    // tokens = latent pixels / 4 (2x2 patch); ~0.55 MB of working set per
    // token on a 12B DiT with fused attention, plus ~0.35 GB fixed sampling
    // overhead - calibrated to turbo runs peaking ~2.5 GB over the weights
    // at 832x1216 and ~4 GB at 1152x1536. This is the ACTIVATION cost on top of
    // the model weights (which are the same at any size). Rough by design.
    const tokens = (w0 / 8) * (h0 / 8) / 4;
    const gb = 0.35 + (tokens * (L.batch || 1) * 0.55) / 1024;
    strip.append(
      cell("⬚", "Latent grid", L.random ? "—" : (w0 / 8) + " × " + (h0 / 8)),
      cell("▥", "Megapixels", L.random ? "—" : ((w0 * h0) / 1e6).toFixed(2)),
      cell("∿", "VRAM (est., activations)", L.random ? "—"
           : "~" + gb.toFixed(1) + " GB + model"));
    statStrip = strip;
  }
  cols.appendChild(previewCard);
  // the same presets as a NAMED dropdown, the Sick Ollie box you asked
  // for beside the visual chips: squares for the eye, names for the click
  {
    const arow = document.createElement("div");
    arow.className = "rn-ws-row";
    const alab = document.createElement("span");
    alab.className = "rn-ws-note";
    alab.style.cssText = "flex:none;width:62px";
    alab.textContent = "Aspect";
    const asel = document.createElement("select");
    asel.className = "rn-ws-res";
    const current = ASPECTS.find((x) => x[0] === L.aspect
      || Math.abs(L.w / L.h - x[1] / x[2]) < 0.02);
    const opts = [["", "(custom " + L.w + " x " + L.h + ")"]].concat(
      ASPECTS.map((a) => [a[0], a[0] + " (" + a[3] + ")"]));
    for (const [value, label] of opts) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      o.selected = value === (current ? current[0] : "");
      asel.appendChild(o);
    }
    asel.title = "The canvas ratio by name; the Scale below is the pixel "
               + "budget it shapes. Same presets as the chips above.";
    asel.onchange = () => { if (asel.value) applyAspect(asel.value); };
    const swapTop = document.createElement("button");
    swapTop.className = "rn-ws-btn";
    swapTop.style.cssText = "width:auto;padding:0 12px";
    swapTop.textContent = "⇄ Swap";
    swapTop.title = "Swap width and height.";
    swapTop.onclick = () => {
      const w = L.w; L.w = L.h; L.h = w;
      // the tag follows the flip, or the old tag and the new ratio light
      // two chips at once
      const flipped = ASPECTS.find((x) => Math.abs(L.w / L.h - x[1] / x[2]) < 0.02);
      L.aspect = flipped ? flipped[0] : "";
      writeCfg(node); render(node);
    };
    arow.append(alab, asel, swapTop);
    canvasCard.appendChild(arow);
  }
  if (L.random && node._rnPicks?.latent) {
    const rolled = document.createElement("div");
    rolled.className = "rn-ws-note";
    rolled.textContent = `last roll: ${node._rnPicks.latent}`;
    canvasCard.appendChild(rolled);
  }

  const srow = document.createElement("div");
  srow.className = "rn-ws-row";
  const slab = document.createElement("span");
  slab.className = "rn-ws-note";
  slab.textContent = "Scale";
  const sr = document.createElement("input");
  sr.type = "range";
  sr.min = 0.25; sr.max = 4; sr.step = 0.05;
  sr.value = mpOf();
  sr.style.cssText = "width:160px;height:20px;accent-color:#4a8fe0";
  const sv = document.createElement("span");
  sv.className = "rn-ws-note";
  const svText = () => mpOf().toFixed(2) + " = " + eff(L.w) + " x " + eff(L.h);
  sv.textContent = svText();
  sr.title = "The pixel budget, in millions of pixels, shaped by the aspect "
           + "chip above (the Sick Ollie numbers, our name). 1.00 is Krea 2's "
           + "native training size, 2.00 is twice the pixels and the VRAM to "
           + "match. Snaps to 64s.";
  sr.addEventListener("input", () => {
    L.mp = parseFloat(sr.value);
    const a = ASPECTS.find((x) => x[0] === L.aspect);
    const wr = a ? a[1] : L.w, hr = a ? a[2] : L.h;
    const wh = mpCalc(wr, hr, L.mp);
    L.w = wh[0]; L.h = wh[1];
    L.scale = 1;
    sv.textContent = svText();
    rectLabel();
    writeCfg(node);
  });
  sr.addEventListener("change", () => render(node));
  srow.append(slab, sr, sv);
  canvasCard.appendChild(srow);

  const drow = document.createElement("div");
  drow.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const num = (label, key, min, max, step, unit) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;gap:6px";
    const wl = document.createElement("span");
    wl.className = "rn-ws-note";
    wl.style.cssText = "flex:none;width:72px;font-size:13px";
    wl.textContent = label;
    const i = document.createElement("input");
    i.type = "number";
    i.min = min; i.max = max; i.step = step;
    i.value = L[key];
    i.style.cssText = "flex:1;min-width:0;background:#101216;border:1px solid #2f333a;"
      + "border-radius:7px;color:#e8ecf1;font-size:15px;font-weight:600;padding:10px 12px";
    const commit = (v) => {
      const snapped = key === "batch" ? Math.round(v) : Math.round(v / 8) * 8;
      L[key] = Math.max(min, Math.min(max, snapped));
      i.value = L[key];
      if (key !== "batch") L.aspect = "";
      writeCfg(node); render(node);
    };
    i.addEventListener("change", () => commit(parseInt(i.value, 10) || min));
    const un = document.createElement("span");
    un.className = "rn-ws-note";
    un.style.cssText = "flex:none;width:18px";
    un.textContent = unit || "";
    const mk = (t, d) => {
      const b = document.createElement("button");
      b.className = "rn-ws-btn";
      b.style.cssText = "width:38px;height:38px;padding:0;font-size:16px";
      b.textContent = t;
      b.onclick = () => commit((parseInt(i.value, 10) || min) + d);
      return b;
    };
    r.append(wl, i, un, mk("−", -step), mk("+", step));
    return r;
  };
  drow.append(num("Width", "w", 256, 4096, 64, "px"),
              num("Height", "h", 256, 4096, 64, "px"),
              num("Batch", "batch", 1, 64, 1, ""));
  canvasCard.appendChild(drow);
  if (statStrip) canvasCard.appendChild(statStrip);
  cols.appendChild(canvasCard);
  if (L.source === "input") {
    // a wired latent IS the canvas: nothing in these two boxes reaches the run,
    // so they read as switched off and take less room; the refine passes below
    // still run on the wired latent
    cols.style.opacity = ".35";
    cols.style.pointerEvents = "none";
    cols.style.maxHeight = "150px";
    cols.style.overflow = "hidden";
    cols.title = "A wired latent is the canvas, so the size and preview here are not "
               + "used. Switch the source to This tab to use them. The passes on the "
               + "Passes tab still run on the wired latent.";
  }
  body.appendChild(cols);


  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = !L.on
    ? "Off. The edit mask can still drive output_latent on its own."
    : L.random
      ? `output_latent carries ${L.batch} latent(s) at a size rolled fresh each queue. `
        + "A real Img2Img pass takes over instead; this is the canvas for prompt "
        + "only, and for a plain generation."
      : `output_latent carries ${L.batch} empty latent(s) at ${eff(L.w)} x ${eff(L.h)}. `
        + "A real Img2Img pass takes over instead; this is the canvas for prompt "
        + "only, and for a plain generation. An edit mask outranks both.";
  if (L.on && nP > 1) {
    note.textContent += ` The built-in sampler runs ${nP} passes on it (the Passes tab): `
      + "pass 1 generates, the rest refine. An Img2Img pass owns the canvas when one is "
      + "running, and its own passes are used then, not these.";
  }
  body.appendChild(note);
}

// The built-in Prompt Converter, on the Img2Img tab: the standalone node's pipeline
// applied to the i2i prompt, with the moodboard as the style authority.
// Img2Img pass mode: real i2i (encoded source + denoise) or prompt only (the Latent
// tab's canvas takes over and the source just donates its description)
// A per-pass list, always as long as the pass count. A shorter stored list
// repeats its last value, so raising the count never moves a number that was
// already chosen, and an empty one falls back to the single dial above it.
// Denoise and Scale both ride this.
// `first` is pass 1's default where that pass is not the same job as the rest, which
// is the Latent tab: pass 1 generates the picture and the passes after it refine what
// it made, so the list opens at a full denoise instead of at the refine dial. Left
// out, pass 1 falls back to the dial like every other pass, which is the Img2Img tab.
// `base` is the config key of the single dial, or a number to use as the dial (the
// rig's step count). `fillNew` gives passes added past a stored list the dial value
// instead of a copy of the last pass.
function passValueList(t, key, base, min, max, first, fillNew = false) {
  const n = Math.max(1, Math.min(PASS_MAX, Math.round(Number(t.passes) || 1)));
  const src = Array.isArray(t[key]) ? t[key] : [];
  const fit = (v) => Math.max(min, Math.min(max, v));
  const baseVal = () => (typeof base === "number" ? base : t[base]);
  const dial = () => fit(Number(baseVal()) || min);
  const head = () => fit(Number(first === undefined ? baseVal() : first) || min);
  const out = [];
  for (let i = 0; i < n; i++) {
    // With nothing stored yet the list opens on the dial, pass 1 aside. With a list
    // stored, a count raised past it repeats its last value, so a number already
    // chosen never moves. Same two rules as _pass_list in workspace.py, which is
    // what the sampler actually reads: the two disagreeing is a bug you only see
    // at render time.
    if (!src.length) { out.push(i ? dial() : head()); continue; }
    if (i >= src.length && fillNew) { out.push(dial()); continue; }
    const v = Number(i < src.length ? src[i] : src[src.length - 1]);
    out.push(Number.isFinite(v) ? fit(v) : (i ? out[i - 1] : head()));
  }
  return out;
}

// SAMPLER DIALS per rig (sampler_dials.py), every one off by default and folded
// away: AuraFlow shift on the model, Detail Daemon's sigma nudge, Seed Variance's
// conditioning jitter, densify the tail of the schedule. They ride the built-in
// sampler and every Detailer pass on this rig.
function dialsCard(node, rig, body) {
  // a rig made before the dials existed, or one the test harness hands over raw
  if (typeof rig.shift !== "number") rig.shift = 0;
  for (const k of ["dd", "variance", "densify"]) {
    if (!rig[k] || typeof rig[k] !== "object") rig[k] = {};
  }
  const folds = (node._rnCardFolds ||= {});
  const key = "dials:" + (rig.name || "");
  const open = !!folds[key];
  const head = document.createElement("div");
  head.className = "rn-ws-row";
  head.style.cursor = "pointer";
  const arrow = document.createElement("span");
  arrow.className = "rn-ws-note";
  arrow.textContent = open ? "\u25be" : "\u25b8";
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  const on = [rig.shift > 0 ? "shift " + Number(rig.shift).toFixed(2) : "",
              rig.dd.on ? "detail daemon" : "", rig.variance.on ? "seed variance" : "",
              rig.densify.on ? "densify" : ""].filter(Boolean);
  lab.textContent = "Sampler dials" + (on.length ? ": " + on.join(", ") : "");
  lab.title = "Extra sampler controls for this rig, all off by default. They ride the "
            + "built-in sampler and every Detailer pass on this rig.";
  head.append(arrow, lab);
  head.onclick = () => { folds[key] = !open; render(node); };
  body.appendChild(head);
  if (!open) return;

  const box = document.createElement("div");
  box.className = "rn-ws-dials";
  box.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 0 6px 14px";
  const bar = (parent, label, get, set, min, max, step, fmt, hint) => {
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    const l = document.createElement("span");
    l.className = "rn-ws-note";
    l.style.minWidth = "84px";
    l.textContent = label;
    const rg = document.createElement("input");
    rg.type = "range";
    rg.min = min; rg.max = max; rg.step = step;
    rg.value = get();
    rg.style.cssText = "flex:1;min-width:0;height:20px;accent-color:#e0a84a";
    rg.title = hint;
    const v = document.createElement("span");
    v.className = "rn-ws-note";
    v.textContent = fmt(get());
    rg.addEventListener("input", () => {
      set(snapStep(rg.value, min, max, step));
      v.textContent = fmt(get());
      writeCfg(node);
    });
    row.append(l, rg, v);
    parent.appendChild(row);
    return row;
  };
  const sw = (parent, label, get, set, hint) => {
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    const b = document.createElement("button");
    b.className = "rn-ws-sw" + (get() ? " on" : "");
    b.title = hint;
    b.onclick = () => { set(!get()); writeCfg(node); render(node); };
    const l = document.createElement("span");
    l.className = "rn-ws-note";
    l.textContent = label;
    row.append(b, l);
    parent.appendChild(row);
    return row;
  };
  const f2 = (x) => Number(x).toFixed(2);
  const pct = (x) => Math.round(Number(x) * 100) + "%";

  // SHIFT
  const srow = document.createElement("div");
  srow.className = "rn-ws-row";
  const slab = document.createElement("span");
  slab.className = "rn-ws-note";
  slab.style.minWidth = "84px";
  slab.textContent = "Shift";
  const sinp = document.createElement("input");
  sinp.type = "number";
  sinp.step = "0.05"; sinp.min = "0"; sinp.max = "100";
  sinp.value = String(rig.shift || 0);
  sinp.style.width = "72px";
  sinp.title = "AuraFlow shift on this rig's model, the ModelSamplingAuraFlow patch. 0 "
             + "leaves the model as it loads; Krea 2 graphs often run 1.7 to 3. Higher "
             + "spends more steps at high noise, which favours composition over detail.";
  sinp.addEventListener("change", () => {
    const v = parseFloat(sinp.value);
    rig.shift = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    sinp.value = String(rig.shift);
    writeCfg(node); render(node);
  });
  const snote = document.createElement("span");
  snote.className = "rn-ws-note";
  snote.textContent = rig.shift > 0 ? "" : "0 = model default";
  srow.append(slab, sinp, snote);
  box.appendChild(srow);

  // DETAIL DAEMON
  const dd = rig.dd;
  sw(box, "Detail Daemon", () => !!dd.on, (v) => { dd.on = v; },
     "The model is told a slightly smaller sigma than the schedule's at each step, by a "
     + "curve over the run, so it paints finer detail late without more steps. Off by "
     + "default. Re-implemented from the MIT description of Jonseed's Detail Daemon.");
  if (dd.on) {
    bar(box, "Amount", () => dd.amount ?? 0.1, (v) => { dd.amount = v; }, -1, 1, 0.01, f2,
        "How much detail. 0.1 is gentle, 0.3 strong; negative smooths instead.");
    bar(box, "Start", () => dd.start ?? 0.2, (v) => { dd.start = v; }, 0, 1, 0.01, pct,
        "Where in the run the nudge begins, as a share of the steps.");
    bar(box, "End", () => dd.end ?? 0.8, (v) => { dd.end = v; }, 0, 1, 0.01, pct,
        "Where it ends.");
    const akey = "dials_adv:" + (rig.name || "");
    const aopen = !!folds[akey];
    const arow = document.createElement("div");
    arow.className = "rn-ws-row";
    arow.style.cursor = "pointer";
    const aarr = document.createElement("span");
    aarr.className = "rn-ws-note";
    aarr.textContent = aopen ? "\u25be" : "\u25b8";
    const alab = document.createElement("span");
    alab.className = "rn-ws-note";
    alab.textContent = "Advanced";
    arow.append(aarr, alab);
    arow.onclick = () => { folds[akey] = !aopen; render(node); };
    box.appendChild(arow);
    if (aopen) {
      bar(box, "Bias", () => dd.bias ?? 0.5, (v) => { dd.bias = v; }, 0, 1, 0.01, f2,
          "Where the peak sits between start and end. 0.5 is the middle.");
      bar(box, "Exponent", () => dd.exponent ?? 1, (v) => { dd.exponent = v; }, 0, 10, 0.05, f2,
          "The curve's shape. 1 is linear ramps; higher keeps the nudge small until near the peak.");
      bar(box, "Start offset", () => dd.start_offset ?? 0, (v) => { dd.start_offset = v; }, -1, 1, 0.01, f2,
          "The floor before the window: a nudge that is already on from step 1.");
      bar(box, "End offset", () => dd.end_offset ?? 0, (v) => { dd.end_offset = v; }, -1, 1, 0.01, f2,
          "The floor after the window.");
      bar(box, "Fade", () => dd.fade ?? 0, (v) => { dd.fade = v; }, 0, 1, 0.05, f2,
          "Scales the whole curve down. 0 is the full curve.");
      sw(box, "Smooth", () => dd.smooth !== false, (v) => { dd.smooth = v; },
         "Cosine-eased ramps up and down. Off is straight lines.");
      bar(box, "CFG scale", () => dd.cfg_scale ?? 1, (v) => { dd.cfg_scale = v; }, 0, 30, 0.5, f2,
          "The nudge is multiplied by this. The original node reads the sampler's cfg; a "
          + "turbo at cfg 1 needs the number set here to feel anything. 0 = the sampler's cfg.");
    }
  }

  // SEED VARIANCE
  const va = rig.variance;
  sw(box, "Seed Variance", () => !!va.on, (v) => { va.on = v; },
     "For the first part of the run a share of the text conditioning's values are "
     + "jittered, so the same seed and prompt land on a different composition; the "
     + "clean conditioning is back for the rest. It does not touch the seed or the noise. "
     + "Off by default.");
  if (va.on) {
    bar(box, "Values", () => va.percent ?? 0.3, (v) => { va.percent = v; }, 0, 1, 0.01, pct,
        "The share of conditioning positions that get jitter.");
    bar(box, "Strength", () => va.strength ?? 0.05, (v) => { va.strength = v; }, 0, 0.5, 0.005, f2,
        "The jitter, as a fraction of the conditioning's own spread. 0.05 nudges, 0.2 wanders.");
    bar(box, "Window", () => va.window ?? 0.3, (v) => { va.window = v; }, 0, 1, 0.01, pct,
        "How far into the run the jitter applies. The first 30% decides composition.");
  }

  // DENSIFY
  const de = rig.densify;
  sw(box, "Densify the tail", () => !!de.on, (v) => { de.on = v; },
     "The last part of the schedule resampled to more steps, so the detail band gets "
     + "them and the rest of the run stays as it was. Off by default.");
  if (de.on) {
    bar(box, "Last", () => de.last ?? 0.3, (v) => { de.last = v; }, 0.05, 1, 0.05, pct,
        "The share of the schedule that counts as the tail.");
    bar(box, "Extra steps", () => de.extra ?? 4, (v) => { de.extra = v; }, 0, 30, 1, (x) => Math.round(Number(x)) + "",
        "How many steps the tail gains.");
  }
  body.appendChild(box);
}

// CONTINUE THE NOISE between passes: the passes become segments of one schedule,
// each picking up the last one's leftover noise with none added, the hand-off's
// other form. Denoise per pass has no say while it is on.
function continueRow(node, t) {
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const b = document.createElement("button");
  b.className = "rn-ws-sw" + (t.handoff_continue ? " on" : "");
  b.title = t.handoff_continue
    ? "On: one schedule for all the passes, cut at each pass's step count; pass 1 "
      + "leaves its noise and the next carries on from the cut with none added. Denoise "
      + "per pass is ignored. Switch off to re-noise between passes as usual."
    : "Off: every pass re-noises to its denoise. Switch on to hand the leftover noise "
      + "from one pass to the next instead, which is how a HighNoise / LowNoise pair "
      + "is meant to relay.";
  b.onclick = () => { t.handoff_continue = !t.handoff_continue; writeCfg(node); render(node); };
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = "Continue the noise between passes";
  row.append(b, lab);
  const sync = () => {
    const many = Math.max(1, Math.round(Number(t.passes) || 1)) > 1;
    row.style.display = many ? "" : "none";
    return !!t.handoff_continue && many;
  };
  return { row, sync };
}

// Which page of the panel is showing: the tab, and the sub-tab (and inner tab) inside
// it where there is one. The body's kept scroll position is keyed on this.
function viewKeyOf(node, cur) {
  const p = node.properties || {};
  if (cur === "i2i") return "i2i/" + (node._rnI2iSub || p.rn_i2i_sub || "source");
  if (cur === "latent") return "latent/" + (node._rnLatSub || p.rn_latent_sub || "canvas");
  if (cur === "identity") {
    let sub = node._rnIdSub || p.rn_identity_sub || "subject";
    if (sub === "people") sub = "subject";
    const inner = node._rnIdInner?.[sub] || p["rn_identity_" + sub] || "gallery";
    return sub === "masks" ? "identity/masks" : `identity/${sub}/${inner}`;
  }
  return cur;
}

// ---- Img2Img as sub-tabs ---------------------------------------------------------
// One section at a time under a strip of tabs, each with a light saying whether that
// section is doing anything, and a status bar that stays put. The sections are the
// same builders the stacked layout used; `flat` drops their own fold.
const I2I_SUBS = [["source", "SOURCE"], ["passes", "PASSES"], ["auto", "AUTO PROMPT"],
                  ["reangle", "RE-ANGLE"], ["swap", "SWAP"], ["converter", "CONVERTER"]];

const capFirst = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);

function convActive(c) {
  return !!(c && c.on !== false && (c.gender !== "off" || c.style !== "off" || c.act !== "off"
    || c.remove_cum || c.shave || String(c.rules || "").trim() || c.lock));
}

// Re-angle's "skip the pass": the re-shot picture is the image output, so the
// source's own encode and every pass stand aside
function i2iSkipped(t) {
  return !!(t.reangle?.on && t.reangle?.skip_pass && !t.prompt_only);
}

// true (lit), false (dark), or "skip" (amber: stood aside for Re-angle's skip)
// A switched-off tab uses nothing on its pages; say so where it would look live
function tabOffNote(name) {
  const n = document.createElement("div");
  n.className = "rn-ws-card rn-ws-note rn-ws-skipnote rn-ws-offnote";
  n.textContent = `${name} is off, so nothing on this page is used: no auto prompt, no `
                + "boosts, no converter. Turn it on with the switch on the bar above.";
  return n;
}

function i2iSubLit(cfg, id) {
  const t = cfg.tabs.i2i;
  if ((id === "source" || id === "passes") && t.on && i2iSkipped(t)) return "skip";
  if (id === "source") return !!(t.on && (t.images.length || t.canvas !== "gallery"));
  if (id === "passes") return !!(t.on && !t.prompt_only);
  if (id === "auto") return !!(t.on && t.auto?.on);
  if (id === "reangle") return !!(t.on && t.reangle?.on && !t.prompt_only);
  if (id === "swap") return !!(t.on && t.swap?.on && !t.prompt_only);
  if (id === "converter") return !!t.on && convActive(t.conv);
  return false;
}

function i2iTabs(node, body) {
  const cfg = node._rnCfg;
  const t = cfg.tabs.i2i;
  const props = (node.properties ||= {});
  let sub = node._rnI2iSub || props.rn_i2i_sub || "source";
  if (!I2I_SUBS.some(([id]) => id === sub)) sub = "source";
  node._rnI2iSub = sub;

  const strip = document.createElement("div");
  strip.className = "rn-ws-sub";
  for (const [id, label] of I2I_SUBS) {
    const b = document.createElement("button");
    b.className = "rn-ws-subt" + (id === sub ? " cur" : "");
    b.dataset.sub = id;
    const lt = document.createElement("span");
    const lit = i2iSubLit(cfg, id);
    lt.className = "lt" + (lit === "skip" ? " skip" : lit ? " on" : "");
    if (lit === "skip") {
      b.title = id === "source"
        ? "Re-angle skips the pass: the source is re-shot and that picture goes "
          + "straight to the image output, with no encode of its own."
        : "Re-angle skips the pass: none of these passes run. Switch Skip the pass "
          + "off on the Re-angle tab to run them on the re-shot picture.";
    }
    const tx = document.createElement("span");
    tx.textContent = label;
    b.append(lt, tx);
    b.onclick = () => { node._rnI2iSub = id; props.rn_i2i_sub = id; render(node); };
    strip.appendChild(b);
  }
  body.appendChild(strip);

  const bar = document.createElement("div");
  bar.className = "rn-ws-status";
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (t.on ? " on" : "");
  on.title = t.on ? "This tab feeds the studio. Click to disable it."
                  : "Disabled: this tab outputs nothing.";
  on.onclick = () => { t.on = !t.on; writeCfg(node); render(node); };
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = "Img2Img";
  bar.append(on, nm);
  const npass = Math.max(1, Math.min(PASS_MAX, Math.round(Number(t.passes) || 1)));
  const engines = AUTO_ENGINES.filter(([k]) => t.auto?.[k]).map(([, l]) => l);
  for (const text of [
    t.canvas === "image" ? "Wired image" : t.canvas === "latent" ? "Wired latent"
      : `${t.images.length} Image${t.images.length === 1 ? "" : "s"}`,
    t.prompt_only ? "Prompt only"
      : i2iSkipped(t) ? "Passes skipped"
      : npass > 1 ? `${npass} Passes` : `Denoise ${Number(t.denoise).toFixed(2)}`,
    !t.auto?.on ? "Auto prompt off" : engines.length ? engines.join(", ") : "No engine on",
  ]) {
    const c = document.createElement("span");
    c.className = "rn-ws-chip";
    c.textContent = text;
    bar.appendChild(c);
  }
  body.appendChild(bar);

  const onlyNote = (what) => {
    const n = document.createElement("div");
    n.className = "rn-ws-card rn-ws-note";
    n.textContent = `${what} works on an image to image pass. The Passes tab is set to `
                  + "Prompt only, so the source only donates its prompt.";
    body.appendChild(n);
  };
  if (!t.on && sub !== "source") body.appendChild(tabOffNote("Img2Img"));
  if (sub === "source") galleryBody(node, body, "i2i", IMAGE_TABS.i2i, { layout: "tabs" });
  else if (sub === "passes") passesTab(node, body);
  else if (sub === "auto") autoSection(node, body, "i2i", { flat: true });
  else if (sub === "reangle") {
    if (t.prompt_only) onlyNote("Re-angle");
    else reangleSection(node, body, "i2i", { flat: true });
  } else if (sub === "swap") {
    if (t.prompt_only) onlyNote("Swap");
    else swapSection(node, body, "i2i", { flat: true });
  } else if (sub === "converter") converterSection(node, body, "i2i", { flat: true });
}

// ---- Krea 2 Identity as sub-tabs ---------------------------------------------------
// Subject, People, Scene and Masks under one tab: the same strip and status bar as
// Img2Img. Subject and Scene get the toolbar gallery with its dials, auto prompt and
// converter under it; People and Masks keep their own bodies.
function identityTabs(node, body) {
  const cfg = node._rnCfg;
  const props = (node.properties ||= {});
  let sub = node._rnIdSub || props.rn_identity_sub || "subject";
  if (sub === "people") sub = "subject";
  if (!IDENTITY_SUBS.some((s) => s.id === sub)) sub = "subject";
  node._rnIdSub = sub;

  const strip = document.createElement("div");
  strip.className = "rn-ws-sub";
  for (const s of IDENTITY_SUBS) {
    const b = document.createElement("button");
    b.className = "rn-ws-subt" + (s.id === sub ? " cur" : "");
    b.dataset.sub = s.id;
    b.title = s.tip;
    const lt = document.createElement("span");
    lt.className = "lt" + (tabLit(cfg, s.id) ? " on" : "");
    const tx = document.createElement("span");
    tx.textContent = s.label;
    b.append(lt, tx);
    b.onclick = () => { node._rnIdSub = s.id; props.rn_identity_sub = s.id; render(node); };
    strip.appendChild(b);
  }
  body.appendChild(strip);

  const bar = document.createElement("div");
  bar.className = "rn-ws-status";
  if (sub === "subject" || sub === "scene") {
    const t = cfg.tabs[sub];
    const on = document.createElement("button");
    on.className = "rn-ws-sw" + (t.on ? " on" : "");
    on.title = t.on ? "This tab feeds the studio. Click to disable it."
                    : "Disabled: this tab outputs nothing.";
    on.onclick = () => { t.on = !t.on; writeCfg(node); render(node); };
    bar.appendChild(on);
  }
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = sub === "subject" ? "Subject" : sub === "scene" ? "Scene" : "Krea 2 Identity";
  bar.appendChild(nm);
  const pics = (n) => `${n} Image${n === 1 ? "" : "s"}`;
  const tabState = (t) => (t.on ? pics(t.images.length) : "Off");
  const bm = cfg.tabs.boost_mask, em = cfg.tabs.edit_mask;
  const St = cfg.tabs.subject;
  const nPeople = St.images.length ? 1 + (St.extra_sel || []).length : 0;
  for (const text of [
    `Subject: ${!St.on ? "Off" : nPeople === 1 ? "1 Person" : `${nPeople} People`}`,
    `Scene: ${tabState(cfg.tabs.scene)}`,
    `Masks: ${bm.on && em.on ? "Boost + Edit" : bm.on ? "Boost" : em.on ? "Edit" : "Off"}`,
  ]) {
    const c = document.createElement("span");
    c.className = "rn-ws-chip";
    c.textContent = text;
    bar.appendChild(c);
  }
  body.appendChild(bar);

  if (sub === "masks") { masksBody(node, body); return; }
  // Subject and Scene: the same inner tabs, Gallery, Boosts, Auto prompt, Converter
  const t = cfg.tabs[sub];
  const innerSubs = [
    ["gallery", "GALLERY", tabLit(cfg, sub)],
    ["boosts", "BOOSTS", !!(t.on && cfg.use_dials && DIALS.some((dd) => dd.tab === sub
                                                     && cfg.dials[dd.key] !== undefined))],
    ["auto", "AUTO PROMPT", !!(t.on && t.auto?.on)],
    ["converter", "CONVERTER", !!t.on && convActive(t.conv)],
  ];
  const ikey = "rn_identity_" + sub;
  let inner = (node._rnIdInner ||= {})[sub] || props[ikey] || "gallery";
  if (!innerSubs.some(([id]) => id === inner)) inner = "gallery";
  const istrip = document.createElement("div");
  istrip.className = "rn-ws-sub inner";
  for (const [id, label, lit] of innerSubs) {
    const b = document.createElement("button");
    b.className = "rn-ws-subt" + (id === inner ? " cur" : "");
    b.dataset.inner = id;
    const lt = document.createElement("span");
    lt.className = "lt" + (lit ? " on" : "");
    const tx = document.createElement("span");
    tx.textContent = label;
    b.append(lt, tx);
    b.onclick = () => { node._rnIdInner[sub] = id; props[ikey] = id; render(node); };
    istrip.appendChild(b);
  }
  body.appendChild(istrip);
  if (!t.on && inner !== "gallery") body.appendChild(tabOffNote(sub === "subject" ? "Subject" : "Scene"));
  if (inner === "gallery") galleryBody(node, body, sub, IMAGE_TABS[sub], { layout: "tabs" });
  else if (inner === "boosts") dialSection(node, body, sub, { flat: true });
  else if (inner === "auto") autoSection(node, body, sub, { flat: true });
  else converterSection(node, body, sub, { flat: true });
}

// THE PASSES TAB: setup on the left (kind, count, which settings vary per pass, the
// values every pass shares), one card per pass on the right holding only the
// settings that vary. Same config keys and rules as the stacked pass box.
function passesTab(node, body, kind = "i2i") {
  const cfg = node._rnCfg;
  // the Latent tab runs the same passes, with pass 1 generating the picture and the
  // rest refining it: its denoise list opens at 1.00 and its shared dial is Refine
  const isLat = kind === "latent";
  const t = isLat ? cfg.latent : cfg.tabs.i2i;
  const clampN = (v) => Math.max(1, Math.min(PASS_MAX, Math.round(Number(v) || 1)));
  const npass = clampN(t.passes);
  const many = npass > 1;
  const cols = document.createElement("div");
  cols.className = "rn-ws-cols rn-ws-passtab" + (isLat ? " lat" : "");

  const setup = document.createElement("div");
  setup.className = "rn-ws-card l";
  const sh = document.createElement("div");
  sh.className = "ch";
  sh.textContent = "SETUP";
  setup.appendChild(sh);
  const kindSeg = isLat ? null : segSwitch([
    ["i2i", "Image to image", "output_latent is the source image ENCODED (wire the vae "
                              + "input), and the denoise socket carries the strength. "
                              + "This BEATS the Latent tab: an image to image pass paints onto "
                              + "your picture, not a blank canvas."],
    ["prompt", "Prompt only", "The source only donates its prompt, and the canvas comes "
                              + "from the Latent tab."],
  ], t.prompt_only ? "prompt" : "i2i",
  (v) => { t.prompt_only = v === "prompt"; writeCfg(node); render(node); });
  if (kindSeg) setup.appendChild(kindSeg);

  const heading = (text) => {
    const h = document.createElement("div");
    h.className = "ch";
    h.style.cssText = "font-size:10.5px;font-weight:700;letter-spacing:.08em;color:#8a919b";
    h.textContent = text;
    return h;
  };
  const dimLine = (text) => {
    const d = document.createElement("div");
    d.className = "rn-ws-note";
    d.style.fontStyle = "italic";
    d.textContent = text;
    return d;
  };
  const fmtD = (v) => Number(v).toFixed(2);
  const fmtS = (v) => Number(v).toFixed(2) + "x";
  const fmtT = (v) => (Number(v) > 0 ? Math.round(Number(v)) + " Steps" : "Rig's steps");
  // a new pass takes the main rig's step count as a real number
  const rigs0 = cfg.models?.rigs || [];
  const rig0 = rigs0[Math.max(0, Math.min(rigs0.length - 1, Math.round(Number(cfg.models?.active) || 0)))];
  const rigSteps = Math.max(1, Math.min(60, Math.round(Number(rig0?.steps) || 8)));

  // the per-pass lists this render works with; only a switched-on list is stored
  const VARY = [
    { flag: "pass_custom", label: "Denoise", key: "pass_denoise",
      base: isLat ? "refine" : "denoise", first: isLat ? 1.0 : undefined,
      min: 0, max: 1, step: 0.01, accent: "#b8283c", fmt: fmtD,
      tip: isLat
        ? "Each pass runs its own denoise. Pass 1 starts from an empty canvas, so it wants "
          + "the full 1.00 unless you are after a hazier draft; the passes after it work "
          + "on the picture the one before them made."
        : "Each pass runs its own denoise. Each pass starts from the picture the one "
          + "before it made, so a strong first pass changes the shot and weaker ones settle it." },
    { flag: "scale_custom", label: "Scale", key: "pass_scale", base: "scale",
      first: isLat ? 1.0 : undefined,
      min: 0.25, max: 3, step: 0.05, accent: "#4a8fe0", fmt: fmtS,
      tip: isLat
        ? "Each pass runs at its own size, as a multiple of the canvas. Pass 1's is the "
          + "size the canvas is built at, so 0.5 there drafts at half size and the passes "
          + "after it climb. Going up costs the square of it in pixels."
        : "Each pass runs at its own size, the first setting the size the source is "
          + "encoded at. Going up between passes costs the square of it in pixels." },
    { flag: "steps_custom", label: "Steps", key: "pass_steps", base: rigSteps, fillNew: true,
      min: 0, max: 60, step: 1, accent: "#e0a84a", fmt: fmtT,
      tip: "Each pass runs its own step count, 0 meaning the rig's. A relay drafts in one "
         + "or two steps and finishes at the full count." },
    { flag: "rig_custom", label: "Rig",
      tip: "Each pass names its Models-tab rig, with its own LoRA set and sampler numbers. "
         + "A rig of another model family encodes the prompt again and moves the latent "
         + "to its own VAE. Turn on Hold two rigs to keep both loaded." },
  ];
  const rigList = () => {
    const src = Array.isArray(t.pass_rig) ? t.pass_rig : [];
    const out = [];
    for (let i = 0; i < clampN(t.passes); i++) {
      out.push(String((i < src.length ? src[i] : (src.length ? src[src.length - 1] : "")) || ""));
    }
    return out;
  };
  const lists = {};
  for (const v of VARY) {
    if (!(many && t[v.flag])) continue;
    if (v.flag === "rig_custom") lists.rig = t.pass_rig = rigList();
    else lists[v.flag] = t[v.key] = passValueList(t, v.key, v.base, v.min, v.max, v.first, v.fillNew);
  }

  if (!(t.prompt_only && !isLat)) {
    const prow = document.createElement("div");
    prow.className = "rn-ws-row";
    const plab = document.createElement("span");
    plab.className = "rn-ws-note";
    plab.textContent = "Passes";
    const stepper = document.createElement("div");
    stepper.className = "rn-ws-stepper" + (many ? " on" : "");
    const setPasses = (n) => {
      t.passes = clampN(n);
      for (const v of VARY) {
        if (!t[v.flag]) continue;
        if (v.flag === "rig_custom") t.pass_rig = rigList();
        else t[v.key] = passValueList(t, v.key, v.base, v.min, v.max, v.first, v.fillNew);
      }
      writeCfg(node);
      render(node);
    };
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.title = "One pass fewer.";
    minus.onclick = () => setPasses(npass - 1);
    const pInp = document.createElement("input");
    pInp.type = "number";
    pInp.min = 1; pInp.max = PASS_MAX; pInp.step = 1;
    pInp.value = String(npass);
    pInp.title = "How many times the built-in sampler runs over its own result. 1 is a "
               + "single pass. 4 at a low denoise adds detail while the shape holds, a fresh "
               + "seed each pass, and only the last picture comes back. An external sampler "
               + "wired to the sockets still runs once.";
    pInp.addEventListener("change", () => setPasses(pInp.value));
    pInp.addEventListener("wheel", () => pInp.blur(), { passive: true });
    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.title = "One pass more.";
    plus.onclick = () => setPasses(npass + 1);
    stepper.append(minus, pInp, plus);
    prow.append(plab, stepper);
    if (many) {
      const reset = document.createElement("button");
      reset.className = "rn-ws-btn rn-ws-compact rn-ws-passreset";
      reset.style.cssText = "margin-left:auto;padding:0 12px";
      reset.textContent = "↺ Reset";
      reset.title = "Put every pass's denoise, scale and steps back to the defaults: "
                  + (isLat ? "pass 1 at 1.00 and the rest at Refine, " : "the shared denoise, ")
                  + "the shared scale, and the main rig's " + rigSteps + " steps. The rig "
                  + "per pass is kept.";
      reset.onclick = () => {
        for (const v of VARY) {
          if (!v.key) continue;
          delete t[v.key];
          if (t[v.flag]) t[v.key] = passValueList(t, v.key, v.base, v.min, v.max, v.first, v.fillNew);
        }
        writeCfg(node);
        render(node);
      };
      prow.appendChild(reset);
    }
    setup.append(prow, document.createElement("hr"), heading("VARY PER PASS"));

    const tiles = document.createElement("div");
    tiles.className = "rn-ws-tiles";
    for (const v of VARY) {
      const tile = document.createElement("div");
      tile.className = "rn-ws-tile" + (many ? "" : " dis");
      tile.dataset.vary = v.flag;
      const sw = document.createElement("button");
      sw.className = "rn-ws-sw" + (t[v.flag] ? " on" : "");
      const nm = document.createElement("span");
      nm.textContent = v.label;
      tile.title = many ? v.tip : "One pass has nothing to vary. Add a pass first.";
      tile.onclick = () => {
        t[v.flag] = !t[v.flag];
        if (t[v.flag]) {
          if (v.flag === "rig_custom") t.pass_rig = rigList();
          else t[v.key] = passValueList(t, v.key, v.base, v.min, v.max, v.first, v.fillNew);
        }
        writeCfg(node);
        render(node);
      };
      tile.append(sw, nm);
      tiles.appendChild(tile);
    }
    setup.appendChild(tiles);
    if (!many) setup.appendChild(dimLine("One pass: add a pass to vary settings per pass."));

    // RAMP: space a varied setting evenly across the passes, lowest to highest (Up)
    // or highest to lowest (Down), so a climb or a fall needs no bar set by hand
    const rampable = VARY.filter((v) => v.key && lists[v.flag]);
    if (rampable.length) {
      setup.appendChild(heading("RAMP"));
      for (const v of rampable) {
        const rrow = document.createElement("div");
        rrow.className = "rn-ws-row rn-ws-ramp";
        const rl = document.createElement("span");
        rl.className = "rn-ws-note";
        rl.style.minWidth = "58px";
        rl.textContent = v.label;
        rrow.appendChild(rl);
        for (const [dir, word, tip] of [
          ["up", "Up", "lowest on the first pass, highest on the last"],
          ["down", "Down", "highest on the first pass, lowest on the last"],
        ]) {
          const b = document.createElement("button");
          b.className = "rn-ws-btn rn-ws-compact";
          b.style.cssText = "flex:1 1 0;padding:0 10px";
          b.dataset.ramp = v.flag + ":" + dir;
          b.textContent = (dir === "up" ? "↗ " : "↘ ") + word;
          b.title = `Space the ${v.label.toLowerCase()} evenly across the passes, ${tip}.`;
          b.onclick = () => {
            const list = passValueList(t, v.key, v.base, v.min, v.max, v.first, v.fillNew);
            const lo = Math.min(...list), hi = Math.max(...list);
            const [a, z] = dir === "up" ? [lo, hi] : [hi, lo];
            t[v.key] = list.map((_, i) =>
              snapStep(a + (z - a) * (i / Math.max(1, list.length - 1)), v.min, v.max, v.step));
            writeCfg(node);
            render(node);
          };
          rrow.appendChild(b);
        }
        setup.appendChild(rrow);
      }
    }

    setup.append(document.createElement("hr"), heading("SAME FOR EVERY PASS"));
    const shDial = (label, key, min, max, step, accent, fmt, tip) => {
      const w = document.createElement("div");
      w.className = "rn-ws-shdial";
      w.dataset.shared = key;
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;
      const rg = document.createElement("input");
      rg.type = "range";
      rg.min = min; rg.max = max; rg.step = step;
      rg.value = t[key];
      rg.style.accentColor = accent;
      rg.title = tip;
      const val = document.createElement("span");
      val.className = "v";
      val.textContent = fmt(t[key]);
      rg.addEventListener("input", () => {
        t[key] = snapStep(rg.value, min, max, step);
        val.textContent = fmt(t[key]);
        writeCfg(node);
      });
      w.append(k, rg, val);
      return w;
    };
    let sharedCount = 0;
    if (!lists.pass_custom && isLat) {
      if (t.refine === undefined) t.refine = 0.45;
      setup.appendChild(shDial("Refine", "refine", 0, 1, 0.01, "#b8283c", fmtD,
        "How much each pass AFTER the first repaints the picture pass 1 made. 0.45 "
        + "rebuilds detail while the shape holds; past about 0.6 the later passes start "
        + "rewriting the shot rather than finishing it."));
      setup.appendChild(dimLine(many ? "Pass 1 generates at 1.00; Refine is the denoise "
                                       + "for passes 2 and on."
                                     : "Refine is used from pass 2 on."));
      sharedCount++;
    } else if (!lists.pass_custom) {
      setup.appendChild(shDial("Denoise", "denoise", 0, 1, 0.01, "#b8283c", fmtD,
        "How much the sampler repaints the source. 0.5 keeps composition, 0.75 reworks "
        + "it. Rides the denoise output socket."));
      sharedCount++;
    }
    if (!lists.scale_custom && isLat) {
      setup.appendChild(dimLine("Scale: the canvas size"));
      sharedCount++;
    } else if (!lists.scale_custom) {
      setup.appendChild(shDial("Scale", "scale", 0.25, 3, 0.05, "#4a8fe0", fmtS,
        "Scales the source before it is encoded, so the pass can come out bigger or "
        + "smaller than the resize at the bottom. 2 doubles both edges and costs four "
        + "times the pixels."));
      sharedCount++;
    }
    if (!lists.steps_custom) { setup.appendChild(dimLine("Steps: the rig's own count")); sharedCount++; }
    if (!lists.rig) { setup.appendChild(dimLine("Rig: this workspace's rig")); sharedCount++; }
    if (!sharedCount) setup.appendChild(dimLine("Nothing, every setting varies per pass."));

    if (many) {
      setup.appendChild(document.createElement("hr"));
      setup.appendChild(continueRow(node, t).row);
    }
  }

  const right = document.createElement("div");
  right.className = "r";
  right.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0";
  if (!isLat && i2iSkipped(t)) {
    const n = document.createElement("div");
    n.className = "rn-ws-card rn-ws-note rn-ws-skipnote";
    n.textContent = "Skipped: Re-angle's Skip the pass is on, so the re-shot picture "
                  + "goes straight to the image output and none of these passes run. "
                  + "The settings are kept for when it is switched off.";
    right.appendChild(n);
  }
  if (!isLat && t.prompt_only) {
    const n = document.createElement("div");
    n.className = "rn-ws-card rn-ws-note";
    n.textContent = "Prompt only: the source donates its prompt, and the canvas comes "
                  + "from the Latent tab. Switch to Image to image to run passes over the "
                  + "picture.";
    right.appendChild(n);
  } else {
    const resize = Number(cfg.resize) || 0;
    const r8 = (v) => Math.max(8, Math.floor(v / 8) * 8);
    const latW = r8(Number(t.w || 1024) * (Number(t.scale) || 1));
    const latH = r8(Number(t.h || 1024) * (Number(t.scale) || 1));
    // a size that is not known until the run: say what it is, times the scale
    const ofUnknown = (sc, what) => Math.abs(Number(sc) - 1) < 1e-6
      ? what : `${Number(sc).toFixed(2)}x ${what}`;
    const sizeOf = (sc) => isLat
      ? (t.source === "input" ? ofUnknown(sc, "the wired latent's size")
         : t.random ? ofUnknown(sc, "the size rolled each run")
         : `${r8(latW * sc)} × ${r8(latH * sc)}`)
      : resize > 0 ? `${Math.round(resize * sc)} px`
                   : ofUnknown(sc, "the source's own size");
    // what a pass runs at when the setting does not vary
    const baseScale = isLat ? 1 : t.scale;
    const rigNames = (cfg.models?.rigs || []).map((r) => String(r.name || "")).filter(Boolean);
    const pdial = (label, value, v, i, cls) => {
      const w = document.createElement("div");
      w.className = "rn-ws-pdial " + cls;
      w.style.borderLeftColor = v.accent;
      const k = document.createElement("span");
      k.className = "k";
      k.style.color = v.accent;
      k.textContent = label;
      const barEl = document.createElement("div");
      barEl.className = "bar";
      const rg = document.createElement("input");
      rg.type = "range";
      rg.min = v.min; rg.max = v.max; rg.step = v.step;
      rg.value = value;
      rg.style.accentColor = v.accent;
      rg.title = v.tip;
      const val = document.createElement("span");
      val.className = "v";
      val.textContent = v.fmt(value);
      rg.addEventListener("input", () => {
        const n = snapStep(rg.value, v.min, v.max, v.step);
        t[v.key][i] = n;
        val.textContent = v.fmt(n);
        writeCfg(node);
        if (v.flag === "scale_custom" && sizeEls[i]) sizeEls[i].textContent = "Output: " + capFirst(sizeOf(n));
      });
      barEl.append(rg, val);
      w.append(k, barEl);
      return w;
    };
    const sizeEls = [];
    for (let i = 0; i < npass; i++) {
      const card = document.createElement("div");
      card.className = "rn-ws-passcard";
      card.dataset.pass = String(i + 1);
      const pn = document.createElement("div");
      pn.className = "pn";
      pn.textContent = String(i + 1);
      const pb = document.createElement("div");
      pb.className = "pb";
      if (isLat && many) {
        const badge = document.createElement("span");
        badge.className = "rn-ws-badge" + (i ? "" : " gen");
        badge.textContent = i ? "REFINE" : "GENERATE";
        badge.title = i ? "This pass repaints the picture the pass before it made."
                        : "This pass makes the picture from the empty canvas.";
        pb.appendChild(badge);
      }
      const line1 = document.createElement("div");
      line1.className = "rn-ws-pline";
      for (const v of VARY) {
        if (v.flag === "rig_custom" || !lists[v.flag]) continue;
        line1.appendChild(pdial(v.label, lists[v.flag][i], v, i, v.flag));
      }
      if (!line1.children.length) {
        line1.appendChild(dimLine(isLat
          ? `Denoise ${i ? fmtD(t.refine ?? 0.45) : "1.00"} · Canvas size · Rig's steps`
            + (many ? ", as set on the left" : "")
          : `Denoise ${fmtD(t.denoise)} · Scale ${fmtS(t.scale)} · Rig's steps`
            + (many ? ", as set on the left" : "")));
      }
      const line2 = document.createElement("div");
      line2.className = "rn-ws-pline2";
      const sz = document.createElement("span");
      sz.className = "dim";
      sz.textContent = "Output: " + capFirst(sizeOf(lists.scale_custom ? lists.scale_custom[i] : baseScale));
      sizeEls[i] = sz;
      line2.appendChild(sz);
      if (lists.rig) {
        const rl = document.createElement("span");
        rl.className = "rn-ws-note";
        rl.textContent = "Rig";
        const sel = document.createElement("select");
        sel.className = "rn-ws-res";
        for (const [val, txt] of [["", "(This rig)"], ...rigNames.map((nm) => [nm, nm])]) {
          const o = document.createElement("option");
          o.value = val; o.textContent = txt; o.selected = val === lists.rig[i];
          sel.appendChild(o);
        }
        sel.title = VARY[3].tip;
        sel.onchange = () => { t.pass_rig[i] = sel.value; writeCfg(node); };
        line2.append(rl, sel);
      }
      pb.append(line1, line2);
      card.append(pn, pb);
      right.appendChild(card);
    }
    const last = lists.scale_custom ? lists.scale_custom[npass - 1] : baseScale;
    right.appendChild(dimLine(
      `Finishes at ${sizeOf(last)}`
      + (many && t.handoff_continue
        ? ". Continue the noise is on: the passes share one schedule, so the denoise "
          + "per pass is ignored."
        : "")));
  }
  cols.append(setup, right);
  body.appendChild(cols);
}

// The chosen picture under the Source gallery: what it is, and the two things to do
// with it. The size is the original's, asked of the server, since the grid shows
// resized thumbnails.
const _chosenSize = new Map();
function chosenStrip(node, body, t, tabName) {
  const card = document.createElement("div");
  card.className = "rn-ws-card rn-ws-chosencard";
  const strip = document.createElement("div");
  strip.className = "rn-ws-chosen";
  card.appendChild(strip);
  const text = (s) => {
    const n = document.createElement("span");
    n.className = "rn-ws-note";
    n.textContent = s;
    strip.appendChild(n);
  };
  const entry = t.images[t.sel];
  if (t.canvas !== "gallery") {
    text(`The canvas comes from the wired ${t.canvas} input, so the gallery is not used.`);
  } else if (t.random) {
    text("Random is on: a picture from this collection is picked on every run.");
  } else if (!entry) {
    text("No picture chosen yet.");
  } else {
    const img = document.createElement("img");
    img.src = thumbUrl(entry, 160);
    img.alt = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const p = parseName(entry);
    const fn = document.createElement("span");
    fn.className = "fn";
    fn.textContent = p.filename;
    fn.title = entry;
    const dim = document.createElement("span");
    dim.className = "dim";
    const key = entry + "|" + node_rand(entry);
    const show = (d) => {
      if (!d) return;
      const mb = d.bytes ? ` · ${(d.bytes / 1048576).toFixed(1)} MB` : "";
      dim.textContent = `${d.w} × ${d.h}${mb}`;
    };
    if (_chosenSize.has(key)) show(_chosenSize.get(key));
    else {
      api.fetchApi(`/rednode/image_size?filename=${encodeURIComponent(p.filename)}`
                   + `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && !d.error) { _chosenSize.set(key, d); show(d); } })
        .catch(() => {});
    }
    meta.append(fn, dim);
    if (tabName === "subject" && (t.extra_sel || []).length) {
      const more = document.createElement("span");
      more.className = "dim";
      const n = t.extra_sel.length;
      more.textContent = `Main subject, with ${n} more ${n === 1 ? "person" : "people"}`;
      meta.appendChild(more);
    }
    const openB = document.createElement("button");
    openB.className = "rn-ws-btn";
    openB.textContent = "Open";
    openB.title = "Open the full picture in a new browser tab.";
    openB.onclick = () => window.open(viewUrl(entry), "_blank");
    const rm = document.createElement("button");
    rm.className = "rn-ws-btn";
    rm.textContent = "Remove";
    rm.title = "Remove it from this gallery. The file itself stays in ComfyUI/input.";
    rm.onclick = () => {
      const i = t.sel;
      t.images.splice(i, 1);
      if (t.sel >= t.images.length) t.sel = Math.max(0, t.images.length - 1);
      activeGroup(t, tabName).sel = t.sel;
      writeCfg(node);
      render(node);
    };
    strip.append(img, meta, openB, rm);
  }
  body.appendChild(card);
}

// RE-ANGLE: image to image from a different viewpoint. Runs BEFORE the i2i
// pass: the source is re-shot by the multi-angle edit model (Qwen-Image-Edit
// 2511 + fal's Multiple-Angles LoRA, the standalone example workflow's graph)
// from the camera chosen here, and that picture becomes the i2i source - so the
// Krea pass at a low denoise polishes it, and hi-res follows as usual. Several
// views (a camera path on the studio) come back as a batch.
const RA_AZ = ["front view", "front-right quarter view", "right side view", "back-right quarter view",
               "back view", "back-left quarter view", "left side view", "front-left quarter view"];
const RA_EL = ["low-angle shot", "eye-level shot", "elevated shot", "high-angle shot"];
const RA_DI = ["close-up", "medium shot", "wide shot"];
const SW_MODES = ["face", "head", "person"];
const SW_REFS = ["subject", "subject2", "subject3"];
const SW_MODE_TIP = {
  face: "Only the face. Hair, head shape and everything else stay from the picture (BFS Face).",
  head: "The whole head, hair included: the strongest identity (BFS Head, the author's recommended one).",
  person: "The whole person: no BFS LoRA is trained for it, the base edit model does its best. The weakest of the three, here to test.",
};
// the author's own prompts (swap.py holds them; shown here as placeholders)
const SW_PROMPT_HINT = {
  face: "face swap face from {face} to {body}. swap only the face (not the hair), match the skin tone to {body}, keep {body} pose and lighting.",
  head: "head_swap: start with {body} as the base image, keeping its lighting, environment, and background. remove the head from {body} completely and replace it with the head from {face}, strictly preserving the hair, eye color, and nose structure of {face}. copy the eye direction, head rotation, and micro-expressions from {body}. high quality, sharp details, 4k",
  person: "replace the person in {body} with the person from {face}, keeping the pose, framing, camera angle, lighting, environment and background of {body}. the face, hair, body and clothing come from {face}. high quality, sharp details",
};
const RA_DEFAULT = { unet: "qwen_image_edit_2511_fp8mixed.safetensors", clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                     vae: "qwen_image_vae.safetensors", lora_angles: "qwen-image-edit-2511-multiple-angles-lora.safetensors",
                     lora_light: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" };
function reangleSection(node, body, tabName, { flat = false } = {}) {
  if (tabName !== "i2i") return;
  const t = node._rnCfg.tabs.i2i;
  if (t.prompt_only) return;
  const R = t.reangle;
  if (!MODEL_LISTS) fetchModelLists().then(() => render(node));
  const L = MODEL_LISTS || {};
  const open = (node._rnReangleOpen ||= { engine: false });
  const card = sectionCard("RE-ANGLE", "#f0c58a",
    !R.on ? "off"
          : (R.camera === "studio" ? "camera from the Camera tab" : R.azimuth + " · " + R.elevation + " · " + R.distance),
    flat ? null : { node, key: "i2i_reangle", open: !!R.on });
  const row0 = document.createElement("div");
  row0.className = "rn-ws-row";
  const sw = document.createElement("div");
  sw.className = "rn-ws-sw" + (R.on ? " on" : "");
  sw.title = "On: before the image to image pass, the source is re-shot from another "
           + "viewpoint by the multi-angle edit model, and THAT picture is the i2i source. "
           + "Off: the source is used as it is.";
  sw.onclick = () => { R.on = !R.on; writeCfg(node); render(node); };
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = R.on
    ? (R.skip_pass
        ? "The source is re-shot from the camera below and goes straight to the image output."
        : "The source is re-shot from the camera below, then the i2i pass runs on it at the denoise above.")
    : "Image to image from a different angle: re-shoot the source first, then paint over it.";
  row0.append(sw, lab);
  card.appendChild(row0);
  if (R.on) {
    // SKIP THE PASS: the re-shot picture as it is. The point is memory: with the
    // pass on, the rig and the edit model both want the card in one run.
    const srow = document.createElement("div");
    srow.className = "rn-ws-row";
    const ssw = document.createElement("div");
    ssw.className = "rn-ws-sw" + (R.skip_pass ? " on" : "");
    ssw.title = R.skip_pass
      ? "On: the re-shot picture is the image output as it is. No encode and no i2i "
        + "pass, so the rig never enters VRAM beside the edit model. Polish it in a "
        + "Detailer pass afterwards if you want the Krea look. Built-in sampler only."
      : "Off: the i2i pass runs on the re-shot picture at the denoise above, the "
        + "normal run. Switch on to stop after the re-shot and keep the rig out of "
        + "VRAM while the edit model works.";
    ssw.onclick = () => { R.skip_pass = !R.skip_pass; writeCfg(node); render(node); };
    const sl = document.createElement("span");
    sl.className = "rn-ws-note";
    sl.textContent = "Skip the i2i pass";
    srow.append(ssw, sl);
    card.appendChild(srow);
    // camera source
    const crow = document.createElement("div");
    crow.className = "rn-ws-row";
    const clab = document.createElement("span");
    clab.className = "rn-ws-note";
    clab.textContent = "Camera";
    const cseg = document.createElement("div");
    cseg.className = "rn-ws-seg";
    for (const [v, l, tip] of [["bands", "Bands", "Pick the viewpoint from the model's bands: 8 directions, 4 heights, 3 distances."],
                               ["studio", "Studio", "Take the camera from the Camera tab's Img2Img studio (its own stage, separate from the prompt's). A camera path there gives one view per shot, as a batch."]]) {
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (R.camera === v ? " on" : "");
      b.textContent = l; b.title = tip;
      b.onclick = () => { R.camera = v; writeCfg(node); render(node); };
      cseg.appendChild(b);
    }
    crow.append(clab, cseg);
    if (R.camera === "bands") {
      const mkSel = (opts, get, set, title) => {
        const sel = document.createElement("select");
        sel.className = "rn-ws-select";
        for (const o of opts) {
          const op = document.createElement("option");
          op.value = o; op.textContent = o; op.selected = o === get();
          sel.appendChild(op);
        }
        sel.title = title;
        sel.onchange = () => { set(sel.value); writeCfg(node); render(node); };
        return sel;
      };
      crow.append(mkSel(RA_AZ, () => R.azimuth, (v) => { R.azimuth = v; }, "Direction. 'right' = the camera moved to YOUR right."),
                  mkSel(RA_EL, () => R.elevation, (v) => { R.elevation = v; }, "Height of the camera."),
                  mkSel(RA_DI, () => R.distance, (v) => { R.distance = v; }, "Distance. Coarse: three steps; use the i2i denoise + Krea for exact framing."));
    } else {
      const nudge = document.createElement("div");
      nudge.className = "rn-ws-sw" + (R.nudge ? " on" : "");
      nudge.title = "Nudge between the bands from the studio's real geometry (a little more to the left/right, further back, much closer). Verified for direction and distance; heights do not nudge.";
      nudge.onclick = () => { R.nudge = !R.nudge; writeCfg(node); render(node); };
      const nl = document.createElement("span");
      nl.className = "rn-ws-note";
      nl.textContent = "Nudge between bands";
      const col = document.createElement("div");
      col.className = "rn-ws-sw" + (R.collapse ? " on" : "");
      col.title = "A camera path: merge shots that land in the same bands, so the same viewpoint is not rendered twice.";
      col.onclick = () => { R.collapse = !R.collapse; writeCfg(node); render(node); };
      const cl = document.createElement("span");
      cl.className = "rn-ws-note";
      cl.textContent = "Collapse same views";
      const goCam = document.createElement("button");
      goCam.className = "rn-ws-btn";
      goCam.style.cssText = "width:auto;padding:0 10px";
      goCam.textContent = "Open Camera tab ▸";
      goCam.title = "The Img2Img studio lives on the Camera tab (Img2Img sub-tab). Place the camera there.";
      goCam.onclick = () => { node._rnCameraSub = "i2i"; node._rnTab = "camera"; (node.properties ||= {}).rn_tab = "camera"; render(node); };
      crow.append(nudge, nl, col, cl, goCam);
    }
    card.appendChild(crow);
    // extra words
    const erow = document.createElement("div");
    erow.className = "rn-ws-row";
    const el = document.createElement("span");
    el.className = "rn-ws-note";
    el.textContent = "Extra";
    const ex = document.createElement("input");
    ex.type = "text";
    ex.value = R.extra;
    ex.placeholder = "Words appended to the camera prompt (optional)";
    ex.style.cssText = "flex:1;min-width:120px;background:#101216;border:1px solid #2a2e34;border-radius:4px;color:#e2e5ea;font-size:12px;padding:3px 6px";
    ex.onchange = () => { R.extra = ex.value; writeCfg(node); };
    erow.append(el, ex);
    card.appendChild(erow);
    // engine (folded)
    const eh = document.createElement("button");
    eh.className = "rn-ws-on";
    eh.style.cssText = "width:auto;padding:0 10px";
    eh.textContent = (open.engine ? "▾" : "▸") + " Engine: " + ((R.unet || RA_DEFAULT.unet).replace(/\.safetensors$/i, ""))
      + " · " + R.steps + " steps · cfg " + R.cfg + " · " + (R.seed_random ? "random seed" : "seed " + R.seed);
    eh.onclick = () => { open.engine = !open.engine; render(node); };
    card.appendChild(eh);
    if (open.engine) {
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center";
      const pick = (label, list, key, dflt, tip) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const sel = document.createElement("select"); sel.className = "rn-ws-select";
        const names = [...new Set([...(list || []), ...(R[key] ? [R[key]] : []), ...(dflt ? [dflt] : [])])];
        const cur = R[key] || dflt;
        for (const n of names) {
          const op = document.createElement("option"); op.value = n; op.textContent = n; op.selected = n === cur;
          sel.appendChild(op);
        }
        if (key.startsWith("lora_")) { const op = document.createElement("option"); op.value = "None"; op.textContent = "(none)"; op.selected = R[key] === "None"; sel.appendChild(op); }
        sel.title = tip;
        sel.onchange = () => { R[key] = sel.value; writeCfg(node); render(node); };
        grid.append(l, sel);
      };
      pick("Edit model", L.unets, "unet", RA_DEFAULT.unet, "Qwen-Image-Edit-2511 (diffusion_models). fp8 fits beside Krea 2 with Comfy swapping them.");
      pick("Text encoder", L.clips, "clip", RA_DEFAULT.clip, "Qwen2.5-VL 7B (text_encoders).");
      pick("VAE", L.vaes, "vae", RA_DEFAULT.vae, "The Qwen Image VAE.");
      pick("Angles LoRA", L.loras, "lora_angles", RA_DEFAULT.lora_angles, "fal's Multiple-Angles LoRA: the viewpoint vocabulary.");
      pick("Speed LoRA", L.loras, "lora_light", RA_DEFAULT.lora_light, "The Lightning 4-step LoRA: 4 steps, cfg 1. (none) = a plain 20+ step run at cfg 2.5-4.");
      const num = (label, key, min, max, step, tip) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:6px;align-items:center";
        const inp = document.createElement("input"); inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
        inp.value = String(R[key]); inp.title = tip;
        inp.style.cssText = "width:80px;background:#101216;border:1px solid #2a2e34;border-radius:4px;color:#e2e5ea;font-size:12px;padding:3px 6px";
        inp.onchange = () => { const v = Number(inp.value); if (Number.isFinite(v)) R[key] = Math.max(min, Math.min(max, v)); writeCfg(node); render(node); };
        inp.addEventListener("wheel", () => inp.blur(), { passive: true });
        wrap.appendChild(inp);
        grid.append(l, wrap);
        return wrap;
      };
      num("Angles strength", "lora_angles_strength", 0, 2, 0.05, "0.8-1.0 recommended.");
      num("Speed strength", "lora_light_strength", 0, 2, 0.05, "1.0 with the Lightning LoRA.");
      num("Steps", "steps", 1, 60, 1, "4 with the Lightning LoRA; 20-30 without.");
      num("CFG", "cfg", 0, 20, 0.1, "1.0 with the Lightning LoRA; 2.5-4 without.");
      const sam = (label, list, key, fallback, tip) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const sel = document.createElement("select"); sel.className = "rn-ws-select";
        for (const n of (list && list.length ? list : fallback)) {
          const op = document.createElement("option"); op.value = n; op.textContent = n; op.selected = n === R[key];
          sel.appendChild(op);
        }
        sel.title = tip;
        sel.onchange = () => { R[key] = sel.value; writeCfg(node); render(node); };
        grid.append(l, sel);
      };
      sam("Sampler", L.samplers, "sampler", ["euler"], "euler / simple is what the LoRA card uses.");
      sam("Scheduler", L.schedulers, "scheduler", ["simple"], "");
      num("Shift", "shift", 0, 10, 0.1, "ModelSamplingAuraFlow shift; 3.1 per fal's workflow. 0 = off.");
      const sl = document.createElement("span"); sl.className = "rn-ws-note"; sl.textContent = "Seed";
      const srow = document.createElement("div"); srow.style.cssText = "display:flex;gap:6px;align-items:center";
      const rsw = document.createElement("div"); rsw.className = "rn-ws-sw" + (R.seed_random ? " on" : "");
      rsw.title = "Random: the run's seed (a re-queue re-shoots). Fixed: the number, and a re-queue that only changed the denoise reuses the cached view.";
      rsw.onclick = () => { R.seed_random = !R.seed_random; writeCfg(node); render(node); };
      const rl = document.createElement("span"); rl.className = "rn-ws-note"; rl.textContent = R.seed_random ? "random (the run's seed)" : "fixed";
      srow.append(rsw, rl);
      if (!R.seed_random) {
        const si = document.createElement("input"); si.type = "number"; si.min = 0; si.step = 1; si.value = String(R.seed);
        si.style.cssText = "width:120px;background:#101216;border:1px solid #2a2e34;border-radius:4px;color:#e2e5ea;font-size:12px;padding:3px 6px";
        si.onchange = () => { const v = Math.floor(Number(si.value)); if (Number.isFinite(v) && v >= 0) R.seed = v; writeCfg(node); };
        srow.appendChild(si);
      }
      grid.append(sl, srow);
      const cn = document.createElement("span"); cn.className = "rn-ws-note"; cn.textContent = "CFG norm";
      const cnsw = document.createElement("div"); cnsw.className = "rn-ws-sw" + (R.cfg_norm ? " on" : "");
      cnsw.title = "CFGNorm as in fal's workflow. Cosmetic at cfg 1.";
      cnsw.onclick = () => { R.cfg_norm = !R.cfg_norm; writeCfg(node); render(node); };
      grid.append(cn, cnsw);
      card.appendChild(grid);
    }
    const note = document.createElement("div");
    note.className = "rn-ws-note";
    note.textContent = "The edit model (about 20 GB) loads beside the rig; Comfy swaps them. The re-shot "
      + "picture rides the i2i_image output too. Direction is exact, height is good, distance is "
      + "coarse: leave framing to the denoise and the Krea pass.";
    card.appendChild(note);
  }
  body.appendChild(card);
}

function swapSection(node, body, tabName, { flat = false } = {}) {
  if (tabName !== "i2i") return;
  const t = node._rnCfg.tabs.i2i;
  if (t.prompt_only) return;
  const S = t.swap;
  if (!MODEL_LISTS) fetchModelLists().then(() => render(node));
  const L = MODEL_LISTS || {};
  const open = (node._rnSwapOpen ||= { engine: false });
  const refName = (r) => r === "subject" ? "Main subject" : "Person " + r.replace("subject", "");
  const card = sectionCard("SWAP", "#e08fb0",
    !S.on ? "off" : S.mode + " from " + refName(S.reference),
    flat ? null : { node, key: "i2i_swap", open: !!S.on });
  const row0 = document.createElement("div");
  row0.className = "rn-ws-row";
  const sw = document.createElement("div");
  sw.className = "rn-ws-sw" + (S.on ? " on" : "");
  sw.title = "On: before the image to image pass (and after RE-ANGLE), the person in the "
           + "source gets the Subject's face, head or body from the BFS swap LoRA on the "
           + "Qwen edit model, and THAT picture is the i2i source. The Krea 2 pass then "
           + "finishes it with the same Subject at the denoise above. Off: nothing swapped.";
  sw.onclick = () => { S.on = !S.on; writeCfg(node); render(node); };
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = S.on
    ? refName(S.reference) + " goes onto the person first, then the i2i pass runs on it at the denoise above."
    : "Put the Subject onto the person in the picture, then paint over it.";
  row0.append(sw, lab);
  card.appendChild(row0);
  if (S.on) {
    const mrow = document.createElement("div");
    mrow.className = "rn-ws-row";
    const ml = document.createElement("span");
    ml.className = "rn-ws-note";
    ml.textContent = "Swap";
    const mseg = document.createElement("div");
    mseg.className = "rn-ws-seg";
    for (const m of SW_MODES) {
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (S.mode === m ? " on" : "");
      b.textContent = m; b.title = SW_MODE_TIP[m];
      b.onclick = () => { S.mode = m; writeCfg(node); render(node); };
      mseg.appendChild(b);
    }
    const rl = document.createElement("span");
    rl.className = "rn-ws-note";
    rl.textContent = "Reference";
    const rseg = document.createElement("div");
    rseg.className = "rn-ws-seg";
    for (const r of SW_REFS) {
      const b = document.createElement("button");
      b.className = "rn-ws-segb" + (S.reference === r ? " on" : "");
      b.textContent = refName(r);
      b.title = "The reference person, as picked in order in the Subject gallery: the "
              + "main subject, then Person 2 and 3. The Subject tab must be on.";
      b.onclick = () => { S.reference = r; writeCfg(node); render(node); };
      rseg.appendChild(b);
    }
    mrow.append(ml, mseg, rl, rseg);
    card.appendChild(mrow);
    // prompt: the author's words for the mode, or your own
    const prow = document.createElement("div");
    prow.className = "rn-ws-row";
    const pl = document.createElement("span");
    pl.className = "rn-ws-note";
    pl.textContent = "Prompt";
    const px = document.createElement("input");
    px.type = "text";
    px.value = S.prompt;
    px.placeholder = SW_PROMPT_HINT[S.mode];
    px.title = "Empty = the LoRA author's prompt for this mode (the placeholder). Your own words replace it; {face} and {body} become the Picture numbers in the order the LoRA wants.";
    px.style.cssText = "flex:1;min-width:120px;background:#101216;border:1px solid #2a2e34;border-radius:4px;color:#e2e5ea;font-size:12px;padding:3px 6px";
    px.onchange = () => { S.prompt = px.value; writeCfg(node); };
    prow.append(pl, px);
    card.appendChild(prow);
    // engine (folded)
    const eh = document.createElement("button");
    eh.className = "rn-ws-on";
    eh.style.cssText = "width:auto;padding:0 10px";
    eh.textContent = (open.engine ? "\u25be" : "\u25b8") + " Engine: " + ((S.lora_swap || "first BFS file").replace(/\.safetensors$/i, ""))
      + " \u00b7 " + S.steps + " steps \u00b7 cfg " + S.cfg + " \u00b7 " + (S.seed_random ? "random seed" : "seed " + S.seed);
    eh.onclick = () => { open.engine = !open.engine; render(node); };
    card.appendChild(eh);
    if (open.engine) {
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center";
      const inpCss = "background:#101216;border:1px solid #2a2e34;border-radius:4px;color:#e2e5ea;font-size:12px;padding:3px 6px";
      const pick = (label, list, key, dflt, tip, noneLabel) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const sel = document.createElement("select"); sel.className = "rn-ws-select";
        const names = [...new Set([...(list || []), ...(S[key] ? [S[key]] : []), ...(dflt ? [dflt] : [])])];
        const cur = S[key] || dflt;
        if (noneLabel) { const op = document.createElement("option"); op.value = ""; op.textContent = noneLabel; op.selected = !S[key]; sel.appendChild(op); }
        for (const n of names) {
          const op = document.createElement("option"); op.value = n; op.textContent = n; op.selected = n === cur;
          sel.appendChild(op);
        }
        if (key === "lora_light") { const op = document.createElement("option"); op.value = "None"; op.textContent = "(none)"; op.selected = S[key] === "None"; sel.appendChild(op); }
        sel.title = tip;
        sel.onchange = () => { S[key] = sel.value; writeCfg(node); render(node); };
        grid.append(l, sel);
      };
      const loras = L.loras || [];
      // LoRA fields are searchable pickers (the pack's own): a native select is
      // unusable at a few hundred files. BFS files lead the unfiltered list.
      const loraPick = (label, key, tip, emptyLabel) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const inp = document.createElement("input"); inp.type = "text";
        inp.value = S[key] && S[key] !== "None" ? S[key] : "";
        inp.placeholder = emptyLabel + " - click and type to search";
        inp.title = tip + " Click and type to search; recently used come first.";
        inp.style.cssText = inpCss;
        makePicker(inp, () => loras.filter((n) => /bfs/i.test(n)).concat(loras.filter((n) => !/bfs/i.test(n))),
                   (v) => { S[key] = v || (key === "lora_light" ? "None" : ""); writeCfg(node); render(node); },
                   { current: () => (S[key] && S[key] !== "None" ? S[key] : ""), emptyLabel, recent: "swap-lora" });
        grid.append(l, inp);
      };
      loraPick("Swap LoRA", "lora_swap",
               "Alissonerdx's BFS file for the Qwen edit model: Face V1 for face, Head V3/V4/V5 for head. The Krea 2 BFS files do NOT go here (those are Detailer pass LoRAs).",
               "(first Qwen BFS file in the folder)");
      const ol = document.createElement("span"); ol.className = "rn-ws-note"; ol.textContent = "Picture order";
      const orow = document.createElement("div"); orow.className = "rn-ws-seg";
      for (const [v, l, tip] of [["auto", "Auto", "Read the order off the file name: Face V1 and Head V1-V2 want face first, Head V3+ body first."],
                                 ["body_first", "Body first", "Picture 1 = the source, Picture 2 = the reference (Head V3, V4, V5)."],
                                 ["face_first", "Face first", "Picture 1 = the reference, Picture 2 = the source (Face V1, Head V1-V2)."]]) {
        const b = document.createElement("button");
        b.className = "rn-ws-segb" + (S.order === v ? " on" : "");
        b.textContent = l; b.title = tip;
        b.onclick = () => { S.order = v; writeCfg(node); render(node); };
        orow.appendChild(b);
      }
      grid.append(ol, orow);
      pick("Edit model", L.unets, "unet", RA_DEFAULT.unet, "Qwen-Image-Edit-2509 or 2511 (diffusion_models); shared with RE-ANGLE, read once.");
      pick("Text encoder", L.clips, "clip", RA_DEFAULT.clip, "Qwen2.5-VL 7B (text_encoders).");
      pick("VAE", L.vaes, "vae", RA_DEFAULT.vae, "The Qwen Image VAE.");
      loraPick("Speed LoRA", "lora_light",
               "A Lightning LoRA: 4-8 steps, cfg 1. The BFS author warns it makes skin plastic; (none) = 16-20 steps at cfg 1.5-2.5.",
               "(none)");
      const num = (label, key, min, max, step, tip) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:6px;align-items:center";
        const inp = document.createElement("input"); inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
        inp.value = String(S[key]); inp.title = tip;
        inp.style.cssText = "width:80px;" + inpCss;
        inp.onchange = () => { const v = Number(inp.value); if (Number.isFinite(v)) S[key] = Math.max(min, Math.min(max, v)); writeCfg(node); render(node); };
        inp.addEventListener("wheel", () => inp.blur(), { passive: true });
        wrap.appendChild(inp);
        grid.append(l, wrap);
      };
      num("Swap strength", "lora_swap_strength", 0, 2, 0.05, "1.0; 1.2-1.3 when the likeness slips (the author's tip).");
      num("Speed strength", "lora_light_strength", 0, 2, 0.05, "1.0 with a Lightning LoRA.");
      num("Steps", "steps", 1, 60, 1, "16-20 without a speed LoRA; 4-8 with one. Too many steps at low cfg = contrast and plastic skin.");
      num("CFG", "cfg", 0, 20, 0.1, "1.5-2.5 without a speed LoRA; 1.0 with one.");
      const sam = (label, list, key, fallback, tip) => {
        const l = document.createElement("span"); l.className = "rn-ws-note"; l.textContent = label;
        const sel = document.createElement("select"); sel.className = "rn-ws-select";
        const names = [...new Set([...(list && list.length ? list : fallback), S[key]])];
        for (const n of names) {
          const op = document.createElement("option"); op.value = n; op.textContent = n; op.selected = n === S[key];
          sel.appendChild(op);
        }
        sel.title = tip;
        sel.onchange = () => { S[key] = sel.value; writeCfg(node); render(node); };
        grid.append(l, sel);
      };
      sam("Sampler", L.samplers, "sampler", ["er_sde", "ddim", "euler"], "The author's picks: er_sde + beta, or ddim + ddim_uniform. Not in this ComfyUI = euler.");
      sam("Scheduler", L.schedulers, "scheduler", ["beta", "ddim_uniform", "simple"], "");
      num("Shift", "shift", 0, 10, 0.1, "ModelSamplingAuraFlow shift; 3.0 is the Qwen edit default. 0 = off.");
      const ks = document.createElement("span"); ks.className = "rn-ws-note"; ks.textContent = "Size";
      const ksw = document.createElement("div"); ksw.className = "rn-ws-sw" + (S.keep_size ? " on" : "");
      ksw.title = "Off: the frame is brought to the edit model's ~1 MP working size (the i2i scale and the Krea pass bring it back up). On: swap at the source's own size, slower past 1 MP.";
      ksw.onclick = () => { S.keep_size = !S.keep_size; writeCfg(node); render(node); };
      const ksl = document.createElement("span"); ksl.className = "rn-ws-note"; ksl.textContent = S.keep_size ? "the source's own size" : "the model's ~1 MP";
      const ksr = document.createElement("div"); ksr.style.cssText = "display:flex;gap:6px;align-items:center"; ksr.append(ksw, ksl);
      grid.append(ks, ksr);
      const sl = document.createElement("span"); sl.className = "rn-ws-note"; sl.textContent = "Seed";
      const srow = document.createElement("div"); srow.style.cssText = "display:flex;gap:6px;align-items:center";
      const rsw = document.createElement("div"); rsw.className = "rn-ws-sw" + (S.seed_random ? " on" : "");
      rsw.title = "Random: the run's seed (a re-queue swaps again). Fixed: the number, and a re-queue that only changed the denoise reuses the cached swap.";
      rsw.onclick = () => { S.seed_random = !S.seed_random; writeCfg(node); render(node); };
      const rl2 = document.createElement("span"); rl2.className = "rn-ws-note"; rl2.textContent = S.seed_random ? "random (the run's seed)" : "fixed";
      srow.append(rsw, rl2);
      if (!S.seed_random) {
        const si = document.createElement("input"); si.type = "number"; si.min = 0; si.step = 1; si.value = String(S.seed);
        si.style.cssText = "width:120px;" + inpCss;
        si.onchange = () => { const v = Math.floor(Number(si.value)); if (Number.isFinite(v) && v >= 0) S.seed = v; writeCfg(node); };
        srow.appendChild(si);
      }
      grid.append(sl, srow);
      const cn = document.createElement("span"); cn.className = "rn-ws-note"; cn.textContent = "CFG norm";
      const cnsw = document.createElement("div"); cnsw.className = "rn-ws-sw" + (S.cfg_norm ? " on" : "");
      cnsw.title = "CFGNorm on the edit model. Off by default here; try it if cfg 2+ over-saturates.";
      cnsw.onclick = () => { S.cfg_norm = !S.cfg_norm; writeCfg(node); render(node); };
      grid.append(cn, cnsw);
      card.appendChild(grid);
    }
    const note = document.createElement("div");
    note.className = "rn-ws-note";
    note.textContent = "Same edit model as RE-ANGLE (read once, Comfy swaps it with the rig). With RE-ANGLE on, "
      + "the swap runs on the re-shot view. The swapped picture rides the i2i_image output too; keep the "
      + "Subject tab on so the Krea pass finishes the same person, and let the Detailer's face pass do the rest.";
    card.appendChild(note);
  }
  body.appendChild(card);
}

function converterSection(node, body, tabName, { flat = false } = {}) {
  if (!CONVERTER_TABS.includes(tabName)) return;
  const cfg = node._rnCfg;
  const c = cfg.tabs[tabName].conv;
  const open = flat || !!(node._rnConvOpen ||= {})[tabName];
  const active = convActive(c);
  const isOn = c.on !== false;

  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-conv" + (flat ? " flat" : "");
  const head = document.createElement("div");
  head.className = "head";
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = open ? "▾" : "▸";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = "PROMPT CONVERTER"
    + (!isOn ? ": off" : active ? "" : ": nothing set");
  const onSw = document.createElement("button");
  onSw.className = "rn-ws-sw" + (isOn ? " on" : "");
  onSw.title = isOn
    ? "On: this tab's prompt runs through the converter below. Switch off to pass it "
      + "through untouched; the settings are kept."
    : "Off: this tab's prompt passes through untouched. The settings below are kept "
      + "for when it is switched back on.";
  onSw.onclick = (e) => {
    e.stopPropagation();
    c.on = !isOn;
    writeCfg(node);
    render(node);
  };
  head.append(arr, onSw, ttl);          // toggle in front of the title
  if (flat) {
    arr.style.display = "none";
    head.style.cursor = "default";
  } else {
    head.onclick = () => { node._rnConvOpen[tabName] = !open; render(node); };
  }
  sect.appendChild(head);

  if (open) {
    const lists = autoStatus.converter || {};
    const sel = (label, key, options, hint) => {
      const w = document.createElement("div");
      w.className = "rn-ws-row";
      const t = document.createElement("span");
      t.className = "rn-ws-note";
      t.textContent = label;
      const el = document.createElement("select");
      el.className = "rn-ws-res";
      for (const v of options || ["off"]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = capFirst(v);
        o.selected = c[key] === v;
        el.appendChild(o);
      }
      el.title = hint;
      el.onchange = () => { c[key] = el.value; writeCfg(node); };
      w.append(t, el);
      return w;
    };
    const boolB = (label, key, hint) => {
      const w = document.createElement("div");
      w.className = "rn-ws-row";
      const t = document.createElement("span");
      t.className = "rn-ws-note";
      t.textContent = label;
      const b = document.createElement("button");
      b.className = "rn-ws-sw" + (c[key] ? " on" : "");
      b.title = hint;
      b.onclick = () => { c[key] = !c[key]; writeCfg(node); render(node); };
      w.append(t, b);
      return w;
    };
    sect.append(
      sel("Gender swap", "gender", lists.gender, "Whole-word, case-preserving gender swap."),
      sel("Style convert", "style", lists.style,
          "Medium vocabulary between photography and anime terms."),
      sel("NSFW act", "act", lists.act, "Rewrite act terms to the chosen one."),
      boolB("Remove cum terms", "remove_cum", "Strip cum, ejaculation, semen, sperm."),
      boolB("Shave pubic", "shave", "Rewrite pubic hair mentions to shaved."),
      boolB("Mood owns the style", "lock",
            "Strip style words the moodboard prompt does not itself use, so this tab's "
            + "image cannot smuggle its own style past the mood."),
      boolB("Mood owns the lighting", "lock_lighting",
            "Stronger: also strip lighting and atmosphere words (golden hour, bokeh, "
            + "backlighting, long shadows) the mood does not use. Lighting the mood "
            + "mentions survives."),
    );
    const rl = document.createElement("div");
    rl.className = "rn-ws-note";
    rl.textContent = "Custom rules, one per line: word => replacement";
    const ta = document.createElement("textarea");
    ta.className = "rn-ws-vsp";
    ta.rows = 2;
    ta.value = c.rules;
    ta.placeholder = "Prince => princess";
    ta.addEventListener("change", () => { c.rules = ta.value; writeCfg(node); });
    sect.append(rl, ta);
  }
  body.appendChild(sect);
}

// A collapsible "Dials" box at the bottom of the tab those dials belong to.
// ONE-CLICK BOOST SETTINGS for Subject, from recipes the pack already uses. Each sets
// every subject dial at once; the dials below stay editable, and a preset reads as
// picked while they still match it.
const SUBJECT_BOOST_PRESETS = [
  { id: "balanced", label: "Balanced",
    tip: "The default: a clear likeness that still follows the prompt.",
    v: { reference_fidelity: 2.5, likeness_vs_obedience: 768, subject_likeness_px: 0,
         identity_start: 0, identity_end: 1, isolate_refs: false, boost_blocks: "all" } },
  { id: "strong", label: "Strong likeness",
    tip: "Holds the faces harder, for when a person drifts. Costs more VRAM and follows "
       + "the prompt a little less.",
    v: { reference_fidelity: 4, likeness_vs_obedience: 1024, subject_likeness_px: 1024,
         identity_start: 0, identity_end: 1, isolate_refs: false, boost_blocks: "all" } },
  { id: "prompt", label: "Prompt first",
    tip: "A looser likeness so the prompt leads, for new styles and big changes. No boost "
       + "matrix is built, so it is the lightest on VRAM.",
    v: { reference_fidelity: 1, likeness_vs_obedience: 512, subject_likeness_px: 0,
         identity_start: 0, identity_end: 1, isolate_refs: false, boost_blocks: "all" } },
  { id: "pose", label: "Pose only",
    tip: "The people guide only the first part of the render: their pose and layout carry "
       + "over, while the look comes from the prompt.",
    v: { reference_fidelity: 2.5, likeness_vs_obedience: 768, subject_likeness_px: 0,
         identity_start: 0, identity_end: 0.3, isolate_refs: false, boost_blocks: "all" } },
  { id: "group", label: "Several people",
    tip: "For two or three people: each reference is kept from reading the others, so "
       + "faces blend less. Costs more VRAM.",
    v: { reference_fidelity: 2.5, likeness_vs_obedience: 768, subject_likeness_px: 0,
         identity_start: 0, identity_end: 1, isolate_refs: true, boost_blocks: "all" } },
];

// The Scene's one dial, the same way. Below 1 weakens the scene's pull (the pack's
// anime and real recipes use 0.47 on the subject for that); at or below 0 it is
// clamped to almost nothing, so the slider stops at 0.
const SCENE_BOOST_PRESETS = [
  { id: "loose", label: "Loose",
    tip: "The place is only a hint: the prompt is free to redraw it. Below 1 weakens the "
       + "scene's pull.",
    v: { scene_fidelity: 0.5 } },
  { id: "normal", label: "Normal",
    tip: "The default: the scene guides the place with no extra pull, and no boost matrix "
       + "is built, so it is the lightest on VRAM.",
    v: { scene_fidelity: 1 } },
  { id: "close", label: "Close",
    tip: "Stays near the scene picture's layout and look. Costs more VRAM.",
    v: { scene_fidelity: 2 } },
  { id: "copy", label: "Copy the scene",
    tip: "Rebuilds the scene picture closely, the pack's anime and real conversion value. "
       + "Costs more VRAM and follows the prompt less.",
    v: { scene_fidelity: 3.2 } },
];

function boostPresetRow(node, cfg, presets = SUBJECT_BOOST_PRESETS) {
  const val = (k) => {
    if (cfg.dials[k] !== undefined) return cfg.dials[k];
    return DIALS.find((d) => d.key === k)?.def;
  };
  const cur = presets.find((p) =>
    Object.entries(p.v).every(([k, v]) => val(k) === v));
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:4px 0 6px";
  const row = document.createElement("div");
  row.className = "rn-ws-bpresets";
  for (const p of presets) {
    const b = document.createElement("button");
    b.className = "rn-ws-bpreset" + (cur === p ? " cur" : "");
    b.dataset.preset = p.id;
    b.textContent = p.label;
    b.title = p.tip;
    b.onclick = () => {
      Object.assign(cfg.dials, p.v);
      cfg.use_dials = true;          // a preset only counts with the dials going out
      writeCfg(node);
      render(node);
    };
    row.appendChild(b);
  }
  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.style.opacity = ".8";
  note.textContent = cur
    ? `${cur.label}: ${cur.tip}`
    : "Custom: the dials below no longer match a preset. Pick one to start again.";
  wrap.append(row, note);
  return wrap;
}

function dialSection(node, body, tabId, { flat = false } = {}) {
  const cfg = node._rnCfg;
  const dials = DIALS.filter((d) => d.tab === tabId);
  if (!dials.length) return;
  const opened = (node._rnDialsOpen ||= {})[tabId];
  const open = flat || (opened !== undefined ? !!opened : tabId === "advanced");

  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-dials";
  const head = document.createElement("div");
  head.className = "head";
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = open ? "▾" : "▸";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  const touched = dials.filter((d) => cfg.dials[d.key] !== undefined).length;
  ttl.textContent = `DIALS: ${dials.map((d) => d.label).join(", ")}`
                  + (touched ? ` · ${touched} set` : "");
  const on = document.createElement("button");
  on.className = "rn-ws-sw" + (cfg.use_dials ? " on" : "");
  on.title = cfg.use_dials
    ? "Every dial on every tab goes out as the settings. The studio needs preset 'custom (use settings)'."
    : "Off: the settings output is empty and the studio's preset stays in charge.";
  on.onclick = (e) => { e.stopPropagation(); cfg.use_dials = !cfg.use_dials; writeCfg(node); render(node); };
  head.append(arr, on, ttl);        // toggle in front of the title, see the masks head
  if (flat) {
    arr.style.display = "none";
    head.style.cursor = "default";
    sect.classList.add("flat");
    ttl.textContent = (tabId === "subject" ? "BOOSTS, for every person" : "BOOSTS")
                    + (touched ? ` · ${touched} set` : "");
  } else {
    head.onclick = (e) => {
      if (e.target === on) return;
      node._rnDialsOpen[tabId] = !open;
      render(node);
    };
  }
  if (tabId === "advanced") ttl.textContent = "STUDIO SETTINGS" +
    (touched ? `: ${touched} set` : ": all at defaults");
  sect.appendChild(head);
  if (flat && tabId === "subject") sect.appendChild(boostPresetRow(node, cfg));
  if (flat && tabId === "scene") sect.appendChild(boostPresetRow(node, cfg, SCENE_BOOST_PRESETS));

  if (open) {
    for (const d of dials) {
      const ceiling = dialCap(cfg, d.key);
      const dMax = ceiling === undefined ? d.max : Math.min(d.max, ceiling);
      const wrap = document.createElement("div");
      wrap.className = "rn-ws-dial";
      const lab = document.createElement("span");
      lab.className = "lab";
      lab.textContent = d.label;
      lab.title = d.hint + (ceiling !== undefined && ceiling < d.max
        ? `

Held to ${ceiling} by the ${cfg.vram_tier} VRAM tier. Change the tier `
          + "in the footer to go higher."
        : "");
      let setChip = null;
      if (d.vram) {
        const chip = document.createElement("span");
        setChip = (v) => {
          const st = vramState(d, v);
          chip.className = "rn-ws-vram " + st.cls;
          chip.textContent = st.label;
          chip.title = st.tip;
        };
        setChip(cfg.dials[d.key] ?? d.def);
        lab.appendChild(chip);
      }
      if (d.bool) {
        const cur = cfg.dials[d.key] ?? d.def;
        const sw = document.createElement("button");
        sw.className = "rn-ws-sw" + (cur ? " on" : "");
        sw.title = d.hint;
        sw.onclick = () => {
          cfg.dials[d.key] = !cur;
          writeCfg(node); render(node);
        };
        wrap.append(lab, sw);
        sect.appendChild(wrap);
        continue;
      }
      if (d.choice) {
        const sel = document.createElement("select");
        sel.className = "rn-ws-res";
        for (const c of d.choice) {
          const o = document.createElement("option");
          o.value = c;
          o.textContent = c;
          o.selected = (cfg.dials[d.key] ?? d.def) === c;
          sel.appendChild(o);
        }
        sel.title = d.hint;
        sel.onchange = () => { cfg.dials[d.key] = sel.value; writeCfg(node); };
        wrap.append(lab, sel);
        sect.appendChild(wrap);
        continue;
      }
      if (d.text) {
        const col = document.createElement("div");
        col.style.cssText = "flex:1;display:flex;flex-direction:column;gap:5px";
        const ta = document.createElement("textarea");
        ta.className = "rn-ws-vsp";
        ta.value = cfg.dials[d.key] ?? "";
        ta.placeholder = "Empty = the training default";
        ta.title = d.hint;
        ta.rows = 3;
        ta.addEventListener("change", () => {
          const v = ta.value.trim();
          if (v) cfg.dials[d.key] = ta.value;
          else delete cfg.dials[d.key];
          writeCfg(node); render(node);
        });

        // the preset row: pick a premade or saved prompt, save the current one, delete
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;gap:5px;align-items:center";
        const psel = document.createElement("select");
        psel.className = "rn-ws-res";
        psel.style.flex = "1";
        const current = (cfg.dials[d.key] ?? "").trim();
        const names = Object.keys(visionPrompts);
        const matched = names.find((n) => visionPrompts[n].trim() === current);
        for (const [v, label] of [["", "training default"],
                                  ...names.map((n) => [n, visionBuiltin.includes(n) ? `${n} (pack)` : n])]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = label;
          o.selected = current ? v === matched : v === "";
          psel.appendChild(o);
        }
        psel.title = "Premade and saved vision prompts. Picking one fills the box; edit freely after.";
        psel.onchange = () => {
          if (psel.value) cfg.dials[d.key] = visionPrompts[psel.value] || "";
          else delete cfg.dials[d.key];
          writeCfg(node); render(node);
        };
        const saveB = document.createElement("button");
        saveB.className = "rn-ws-btn";
        saveB.textContent = "Save…";
        saveB.disabled = !current;
        saveB.title = current ? "Save the box's text as a named prompt."
                              : "Type a prompt first.";
        saveB.onclick = () => {
          document.querySelector(".rn-ws-panel")?.remove();
          const m = document.createElement("div");
          m.className = "rn-ws-panel";
          for (const ev of ["pointerdown", "click", "keydown", "contextmenu"]) {
            m.addEventListener(ev, (e) => e.stopPropagation());
          }
          const h = document.createElement("h5");
          h.textContent = "Save vision prompt";
          const inp = document.createElement("input");
          inp.placeholder = "Prompt name";
          const note = document.createElement("div");
          note.className = "rn-ws-note";
          const ok = document.createElement("button");
          ok.textContent = "Save";
          ok.onclick = async () => {
            try {
              const res = await api.fetchApi("/rednode/vision_prompts", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "save", name: inp.value.trim(), text: current }),
              });
              const dd = await res.json();
              if (dd.error) throw new Error(dd.error);
              visionPrompts = dd.prompts || {};
              visionBuiltin = dd.builtin || [];
              m.remove();
              render(node);
            } catch (e) { note.textContent = `Could not save: ${e.message}`; }
          };
          m.append(h, inp, ok, note);
          document.body.appendChild(m);
          const r = saveB.getBoundingClientRect();
          const mh = m.getBoundingClientRect().height || 140;
          m.style.left = Math.max(6, r.left - 150) + "px";
          m.style.top = Math.max(6, r.top - mh - 6) + "px";
          inp.focus();
          const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
          setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
        };
        const delB = document.createElement("button");
        delB.className = "rn-ws-btn";
        delB.textContent = "✕";
        const delOk = matched && !visionBuiltin.includes(matched);
        delB.disabled = !delOk;
        delB.title = !matched ? "Pick a saved prompt to delete it."
                   : visionBuiltin.includes(matched) ? "Pack prompts cannot be deleted."
                   : `Delete "${matched}".`;
        delB.onclick = async () => {
          try {
            const res = await api.fetchApi("/rednode/vision_prompts", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "delete", name: matched }),
            });
            const dd = await res.json();
            visionPrompts = dd.prompts || {};
            visionBuiltin = dd.builtin || [];
            render(node);
          } catch (e) { console.error("[RedNode Workspace] delete failed:", e); }
        };
        bar.append(psel, saveB, delB);
        col.append(bar, ta);
        wrap.style.alignItems = "flex-start";
        wrap.append(lab, col);
        sect.appendChild(wrap);
        continue;
      }
      const range = document.createElement("input");
      range.type = "range";
      range.min = d.min; range.max = dMax; range.step = d.step;
      range.value = Math.min(cfg.dials[d.key] ?? d.def, dMax);
      const val = document.createElement("input");
      val.className = "val";
      val.value = String(cfg.dials[d.key] ?? d.def);
      const apply = (v) => {
        const num = snapStep(v, d.min, dMax, d.step);
        if (num === null) return;
        cfg.dials[d.key] = num;
        range.value = num; val.value = String(num);
        setChip?.(num);                              // the VRAM chip follows the value live
        writeCfg(node);
      };
      range.addEventListener("input", () => apply(range.value));
      val.addEventListener("change", () => apply(val.value));
      wrap.append(lab, range, val);
      sect.appendChild(wrap);
    }
    const reset = document.createElement("button");
    reset.className = "rn-ws-btn";
    reset.style.alignSelf = "flex-start";
    reset.textContent = "Reset these dials";
    reset.onclick = () => {
      for (const d of dials) delete cfg.dials[d.key];
      writeCfg(node); render(node);
    };
    sect.appendChild(reset);
  }
  body.appendChild(sect);
}

// The Post tab can override how fine its sliders step. Controls that already move
// in whole numbers (seed, blend if, radius) keep their own step: forcing three
// decimals onto a 0..255 control would be silly.


// The tier ceilings, mirrored from VRAM_CAPS in workspace.py. The server is the
// authority; these exist so a slider STOPS at the ceiling instead of letting you
// drag somewhere that gets quietly pulled back on the next queue.

const dialCap = (cfg, key) => VRAM_CAPS[cfg.vram_tier || "high"]?.[key];


// ---- socket tuck -------------------------------------------------------------
// 25 sockets is a skyscraper. Tucked, every UNWIRED slot parks as a bare dot on
// the node's bottom edge (inputs from the left, outputs from the right); wired
// slots keep their labelled rows, and widgets_start_y pins the panel right below
// those rows so all the reclaimed space goes to the panel. Dropping a wire on a
// parked dot still works, and the slot pops back into its row when it connects.
const SLOT_H = () => globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;

function untuckSlot(s) {
  if (!s._rnTucked) return;
  delete s.pos;
  if (s._rnLbl === undefined || s._rnLbl === " ") delete s.label;
  else s.label = s._rnLbl;
  delete s._rnTucked;
  delete s._rnLbl;
}

// 0 = full rows, 1 = unwired sockets tucked, 2 = everything tucked (wires ride
// down to the dots; hover a dot for its name)
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
  const H = node.size?.[1] || 430;
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

// ---- render ----------------------------------------------------------------
// Ordered the way a session actually flows: canvas first (latent, source image),
// then the look, then the edit-node inputs (subject, people, scene, masks), then
// the studio settings. The group field colours the strip so the purposes read.

const tabLit = (cfg, id) =>
  id === "identity" ? IDENTITY_SUBS.some((s) => tabLit(cfg, s.id))
  : id === "people" ? (cfg.tabs.subject2.on && cfg.tabs.subject2.images.length) ||
                    (cfg.tabs.subject3.on && cfg.tabs.subject3.images.length)
  // ON is enough to light the tab: a wired boost_mask_in/edit_mask_in counts even
  // before anything is painted, and the ON click deserves visible feedback either way
  : id === "masks" ? cfg.tabs.boost_mask.on || cfg.tabs.edit_mask.on
  // the moodboard only outputs what is IN the batch, so an empty batch must not light up
  : id === "moodboard" ? cfg.tabs.moodboard.on && cfg.tabs.moodboard.sel.length
  : id === "loras" ? !!(cfg.loras?.on && cfg.loras?.slots?.length)
  : id === "paint" ? cfg.paint?.on
  : id === "post" ? POST_FX.some((fx) => cfg.post?.[fx.id]?.on)
  : id === "latent" ? cfg.latent.on
  : id === "models" ? !!cfg.models?.rigs?.some?.((r) =>
      r.checkpoint || r.unet || r.clip || r.vae)
  : id === "prompts" ? !!cfg.prompts?.rows?.some?.((x) => x.text.trim())
  // the Camera tab is lit when a prompt's studio is live or the re-angle studio has a camera
  : id === "camera" ? !!(cfg.camera?.on !== false
                         && (cfg.prompts?.rows?.some?.((x) => x.frame && String(x.frame.camera || "").trim())
                             || String(cfg.tabs?.i2i?.reangle?.studio || "").trim()))
  : id === "advanced" ? cfg.use_dials &&
      DIALS.some((d) => d.tab === "advanced" && cfg.dials[d.key] !== undefined)
  // IMG2IMG DOES NOT NEED A GALLERY IMAGE ( the dot stays
  // dark with the tab on and the canvas set to Wired image). Its canvas can be
  // the wired image_in or latent input, in which case the tab has no picture of
  // its own and the plain rule below - on AND a gallery image - can never light
  // it, however hard it is working. Prompt-only counts too: the tab is then
  // contributing its words rather than a canvas, which is still doing something.
  : id === "i2i" ? !!(cfg.tabs.i2i.on
                      && (cfg.tabs.i2i.images.length
                          || cfg.tabs.i2i.canvas !== "gallery"
                          || cfg.tabs.i2i.prompt_only))
  : cfg.tabs[id].on && cfg.tabs[id].images.length;

// WHICH SECTIONS ARE FOLDED OPEN, kept across a reload. Every one of these lives on the
// node as a plain runtime field, so leaving a workflow and coming back rebuilt the node
// and threw the whole layout back to its defaults. They are snapshotted into properties
// rather than the config JSON because folding a box must never dirty what a render
// produces, which is the same reason the open state was put on the node to begin with.
const FOLD_MAPS = ["_rnMaskBoxes", "_rnAutoOpen", "_rnConvOpen", "_rnDialsOpen",
                   "_rnPaintBoxes", "_rnFxOpen"];

function restoreFolds(node) {
  const saved = node.properties?.rn_folds;
  if (!saved || typeof saved !== "object") return;
  for (const key of FOLD_MAPS) {
    // only when untouched this session, so a restore can never stomp a live fold
    if (node[key] === undefined && saved[key] && typeof saved[key] === "object") {
      node[key] = { ...saved[key] };
    }
  }
  if (node._rnAutoAdv === undefined) node._rnAutoAdv = !!saved._rnAutoAdv;
}

function saveFolds(node) {
  const out = {};
  for (const key of FOLD_MAPS) {
    if (node[key] && typeof node[key] === "object") out[key] = { ...node[key] };
  }
  out._rnAutoAdv = !!node._rnAutoAdv;
  // These maps are mutated in place all over the panel, so the snapshot is taken after
  // the render rather than at each toggle. Only WRITE on a real change: properties are
  // serialised, and rewriting an identical value every render marks the workflow dirty
  // and leaves an unsaved-changes prompt behind for scrolling around.
  const next = JSON.stringify(out);
  if (node._rnFoldSig === next) return;
  node._rnFoldSig = next;
  (node.properties ||= {}).rn_folds = out;
}

export function render(node) {
  // Newer frontends draw an input dot for EVERY widget, hidden ones included, which
  // leaks an unlabeled socket carrying the hidden JSON widget's tooltip. Strip those
  // dots on every render; the widget itself (and its serialisation) is untouched.
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const w = node.inputs[i]?.widget;
    if (w && ["config"].includes(w.name)) node.inputs.splice(i, 1);
  }
  const root = node._rnRootEl;
  if (!root) return;
  const cfg = node._rnCfg;
  // HIDDEN TABS are a per-install view preference, and HIDING NEVER TURNS ANYTHING
  // OFF: a hidden Masks tab with a mask configured still applies it at queue time.
  // Visibility and behaviour welded together would mean tidying the panel silently
  // changes what a workflow renders. The current tab stays on the strip even while
  // hidden, so a deliberate jump (the LoRA tab button in Routing) can never land on
  // a blank panel; leave the tab and its button goes.
  // The tab you were last on survives a reload. _rnTab is runtime-only, so switching
  // workflows and coming back rebuilt the node with it undefined and dropped you on
  // Subject every time. Properties serialise with the workflow, which is where the
  // pre-fold size already lives, so per-node panel state has a home there.
  if (node._rnTab === undefined && node.properties?.rn_tab) {
    node._rnTab = String(node.properties.rn_tab);
  }
  if (node._rnTab === "people") node._rnTab = "subject";     // People is part of Subject now
  if (IDENTITY_SUBS.some((s) => s.id === node._rnTab)) {
    node._rnIdSub = node._rnTab;
    (node.properties ||= {}).rn_identity_sub = node._rnTab;
    node._rnTab = "identity";
    node.properties.rn_tab = "identity";
  }
  restoreFolds(node);
  const hidden = hiddenTabSet();
  const tabsShown = TAB_ORDER.filter((t) => t.id === "advanced"
    || t.id === node._rnTab || !hidden.has(t.id));
  const fallbackTab = !hidden.has("identity") ? "identity"
    : (TAB_ORDER.find((t) => !hidden.has(t.id))?.id || "advanced");
  const cur = TAB_ORDER.some((t) => t.id === node._rnTab) ? node._rnTab : fallbackTab;
  // Most controls still rebuild this body today. Keep the outgoing tab's position in
  // the one rebuild funnel so no button can forget it; a different tab starts clean.
  // The kept position belongs to the VIEW, not just the tab: Img2Img, Latent and
  // Identity hold several pages under one tab, and one page's offset on another reads
  // as the panel jumping.
  const viewKey = viewKeyOf(node, cur);
  const previousBody = node._rnBodyEl;
  const previousBodyTab = node._rnBodyTab;
  const previousScroll = previousBodyTab === viewKey ? Number(previousBody?.scrollTop || 0) : 0;
  root.replaceChildren();
  const host = document.createElement("div");
  host.className = "rn-ws-host";
  applyScale(host, cfg.ui_scale);
  root.appendChild(host);

  const tabs = document.createElement("div");
  tabs.className = "rn-ws-tabs";
  let prevGroup = null;
  // the FILTERED list drives the loop, so prevGroup only ever sees neighbours that
  // are really on the strip: a `continue` over hidden tabs after the assignment
  // would draw group separators for buttons that are not there
  for (const t of tabsShown) {
    const b = document.createElement("button");
    b.className = "rn-ws-tab g-" + t.group + (t.id === cur ? " cur" : "")
                + (prevGroup && prevGroup !== t.group ? " gstart" : "");
    prevGroup = t.group;
    const dot = document.createElement("span");
    dot.className = "dot" + (tabLit(cfg, t.id) ? " on" : "");
    if (t.id === "models" || t.id === "prompts") {
      const probs = setupProblems(node, cfg).filter((p) => (t.id === "prompts") === p.startsWith("No prompt"));
      if (probs.length) {
        dot.className = "dot warn";
        b.title = probs.join("\n");
      }
    }
    const lab = document.createElement("span");
    lab.textContent = t.label;
    b.append(dot, lab);
    b.onclick = () => {
      node._rnTab = t.id;
      (node.properties ||= {}).rn_tab = t.id;   // so the reload lands back here
      render(node);
    };
    tabs.appendChild(b);
  }
  const tmode = tuckMode(node);
  const tuck = document.createElement("button");
  tuck.className = "rn-ws-tuck" + (tmode === 1 ? " on" : tmode === 2 ? " on all" : "");
  tuck.textContent = "🔌";
  tuck.title = tmode === 0
    ? "Tuck every unwired socket down to the node's bottom edge as a bare dot, so the "
      + "sockets stop eating the node's height. Wired sockets keep their rows. A second "
      + "click tucks those too."
    : tmode === 1
      ? "Unwired sockets sit as bare dots on the bottom edge (inputs left, outputs "
        + "right); hover a dot for its name, drop a wire on it to bring it back. Click "
        + "to tuck the wired rows down there too."
      : "Everything is tucked; the wires ride down to their dots and every slot row is "
        + "panel space now. Click to restore the full rows.";
  tuck.onclick = () => {
    (node.properties ||= {}).rn_tucked = (tuckMode(node) + 1) % 3;
    applyTuck(node);
    render(node);
  };
  // its own row, above the tabs: the strip stays pure tabs and sits on the box
  const toprow = document.createElement("div");
  toprow.className = "rn-ws-toprow";
  toprow.appendChild(tuck);
  host.append(toprow, tabs);

  const body = document.createElement("div");
  body.className = "rn-ws-body"
    + (["paint", "prompts", "latent"].includes(cur) ? " full" : "");
  if (cur === "identity") identityTabs(node, body);
  else if (cur === "models") modelsBody(node, body);
  else if (cur === "prompts") promptsBody(node, body);
  else if (cur === "camera") cameraBody(node, body);
  else if (cur === "latent") latentBody(node, body);
  else if (cur === "post") postBody(node, body);
  else if (cur === "paint") paintBody(node, body);
  else if (cur === "loras") lorasBody(node, body);
  else if (cur === "advanced") advancedTools(node, body);
  else if (cur === "i2i") i2iTabs(node, body);     // its sections as sub-tabs
  else galleryBody(node, body, cur, IMAGE_TABS[cur], { multi: cur === "moodboard" });
  // Section order, the same on every tab: what the tab DOES (its dials), then how
  // its prompt is made, then how that prompt is reworked. The converter reads the
  // auto prompt's output, so it reads top to bottom in the order it runs.
  if (cur !== "i2i" && cur !== "identity") {
    dialSection(node, body, cur);                  // each tab carries its own dials
    if (cur !== "paint") {
      autoSection(node, body, cur);                // captions for this tab's image
    }
    converterSection(node, body, cur);             // the built-in Prompt Converter
  }
  node._rnAfterMount = null;
  host.appendChild(body);
  // a tab that needs its own scroll back (the Post list) sets this while building;
  // it runs now, with the body in the page and nothing painted yet
  try { node._rnAfterMount?.(); } catch (e) { /* a restore is never worth a broken panel */ }
  node._rnAfterMount = null;
  node._rnBodyEl = body;
  const foot = document.createElement("div");
  foot.className = "rn-ws-foot";
  // Panel size, in the panel, next to the other things that apply to the whole panel.
  // Same shape as the Thumbs slider on the gallery tabs, for the same reason: you set
  // it while looking at the thing it changes, not in a dialog two clicks away.
  const uiWrap = document.createElement("span");
  uiWrap.className = "rn-ws-thumbs";
  const uiLab = document.createElement("span");
  uiLab.className = "t";
  uiLab.textContent = "UI";
  const uiRng = document.createElement("input");
  uiRng.type = "range";
  uiRng.min = 0.7; uiRng.max = 4; uiRng.step = 0.05;
  uiRng.value = cfg.ui_scale;
  uiRng.style.width = "160px";
  uiRng.title = "Size of everything in this panel: text, sliders, buttons, thumbnails. "
              + "Applies when you let go. The node itself does not move or grow: "
              + "bigger content means fewer things per row inside the same frame, and "
              + "the panel scrolls for the rest.";
  // Typed, for when the slider is too coarse: 165 then enter.
  const uiVal = document.createElement("input");
  uiVal.type = "text";
  uiVal.inputMode = "numeric";
  uiVal.style.cssText = "background:#15171b;border:1px solid #33373d;"
                     + "border-radius:5px;color:#ddd;font-size:11px;padding:4px 6px;"
                     + "width:48px";
  uiVal.style.textAlign = "right";
  uiVal.value = `${Math.round(cfg.ui_scale * 100)}%`;
  uiVal.title = "Type a percent, 70 to 400, and press enter.";
  const setScale = (v) => {
    cfg.ui_scale = Math.max(0.7, Math.min(4, v));
    uiRng.value = cfg.ui_scale;
    uiVal.value = `${Math.round(cfg.ui_scale * 100)}%`;
    writeCfg(node);
    render(node);          // render owns the effective-zoom math, one place only
  };

  // The number tracks the drag; the ZOOM waits for release. The slider lives inside
  // the very container the zoom resizes, so applying live moved the slider under the
  // pointer mid-drag and the drag chased its own tail. Applying on release is not a
  // compromise here, it is the only version that is not fighting itself.
  uiRng.addEventListener("input", () => {
    uiVal.value = `${Math.round(parseFloat(uiRng.value) * 100)}%`;
  });
  uiRng.addEventListener("change", () => {
    setScale(Math.round(parseFloat(uiRng.value) * 20) / 20);
  });
  uiVal.addEventListener("change", () => {
    const n = parseFloat(String(uiVal.value).replace("%", "").trim());
    if (Number.isFinite(n)) setScale(n / 100);
    else uiVal.value = `${Math.round(cfg.ui_scale * 100)}%`;
  });
  uiWrap.append(uiLab, uiRng, uiVal);
  foot.appendChild(uiWrap);
  const TIERS = ["high", "medium", "low"];
  const tierBtn = document.createElement("button");
  tierBtn.className = "rn-ws-btn rn-ws-tier " + (cfg.vram_tier || "high");
  tierBtn.style.width = "auto";
  tierBtn.style.padding = "0 10px";
  tierBtn.textContent = { high: "VRAM: free range", medium: "VRAM: medium",
                          low: "VRAM: low" }[cfg.vram_tier || "high"];
  tierBtn.title = "How much VRAM this workspace is allowed to spend. Low and medium "
                + "hold the expensive dials (the fidelity pair, the likeness caps, "
                + "style detail, resize, latent size and the moodboard batch) to "
                + "numbers that tier can take, so a slider cannot quietly cost you "
                + "gigabytes. Free range removes every ceiling. Anything held back is "
                + "named in the console.";
  tierBtn.onclick = () => {
    const i = TIERS.indexOf(cfg.vram_tier || "high");
    cfg.vram_tier = TIERS[(i + 1) % TIERS.length];
    writeCfg(node);
    render(node);
  };

  // DRAFT: iterate on the base render alone. The Detailer and Post nodes read this
  // off the queued workspace and pass the picture through while it is on, so a seed
  // costs one sampler run to judge and one flip renders the keeper in full.
  const draftBtn = document.createElement("button");
  draftBtn.className = "rn-ws-btn rn-ws-draft" + (cfg.draft ? " on" : "");
  draftBtn.style.width = "auto";
  draftBtn.style.padding = "0 10px";
  draftBtn.textContent = cfg.draft ? "DRAFT" : "Draft";
  draftBtn.title = cfg.draft
    ? "Draft is ON: the Detailer and the Post chain pass the picture through, so a "
      + "queue is the base render alone. Click to render the keeper in full."
    : "Draft: skip the Detailer passes and the Post chain for fast rerolls on the "
      + "base render. Nothing on those nodes changes; they pass the picture through "
      + "until this is off again.";
  draftBtn.onclick = () => { cfg.draft = !cfg.draft; writeCfg(node); render(node); };

  const cog = document.createElement("button");
  cog.className = "rn-ws-cog";
  cog.textContent = "⚙";
  cog.title = "Save or delete workspace presets.";
  cog.onclick = () => openCog(node, cog);
  foot.append(draftBtn, tierBtn, cog);
  // INSIDE the host, not on the wrap. The host carries the UI zoom, and a sibling
  // placed after a zoomed flex item is laid out against the UNZOOMED height, so at any
  // scale above 1 the foot rendered part-way up the panel, floating over the effect
  // cards. In the zoomed flow it sits where the eye expects, at the end, and it scales
  // with the controls it belongs to.
  foot.style.zoom = Math.abs((cfg.ui_scale || 1) - 1) < 0.001
    ? "" : String(1 / cfg.ui_scale);
  host.appendChild(foot);
  // the kept scroll goes back now, with the footer in: restored before it, a place
  // near the bottom was clamped short by the footer's height
  node._rnBodyTab = viewKey;
  if (previousBody && previousBodyTab === viewKey) {
    body.scrollTop = previousScroll;
    // The rebuilt body may not be able to HOLD the restored offset yet: canvases get
    // their height on image load, so scrollHeight is briefly small and the browser
    // clamps the write toward zero. Record what was wanted; the paint image's ready
    // path re-applies it once, when the layout can carry it.
    if (previousScroll && Number(body.scrollTop || 0) !== previousScroll) {
      // remember WHERE the clamp landed, not just that it did: a body tall enough
      // for 200 of the 400 wanted clamps to 200, and a payer that only fires from
      // exactly 0 would drop that restore on the floor
      node._rnScrollOwed = { tab: viewKey, top: previousScroll,
                             clamped: Number(body.scrollTop || 0) };
    } else {
      delete node._rnScrollOwed;
    }
  } else {
    delete node._rnScrollOwed;
  }


  applyTuck(node);
  saveFolds(node);        // after the body built, so every fold map exists to snapshot
  if (node._rnWidget?.options) node._rnWidget.options.getMinHeight = () => MIN_PANEL_H;
  if (!node._rnSized) {
    node._rnSized = true;
    node.setSize([Math.max(node.size[0], NODE_MIN_W), Math.max(node.size[1], 430)]);
  }
  node.graph?.setDirtyCanvas(true, true);
}

// ---- auto prompt engine status ---------------------------------------------
// asked once at load: is Ollama up, which models, is WD14 installed
let autoStatus = { ollama: false, models: [], wd14: false };
async function refreshAutoStatus() {
  try {
    const res = await api.fetchApi("/rednode/autoprompt_status");
    autoStatus = await res.json();
  } catch (e) { /* both engines simply show unavailable */ }
}

// ---- vision prompt presets -------------------------------------------------
// Shipped premades plus your saved ones, fetched once and after every change.
let visionPrompts = {};        // {name: text}
let visionBuiltin = [];        // names that ship with the pack (not deletable)
async function refreshVisionPrompts() {
  try {
    const res = await api.fetchApi("/rednode/vision_prompts");
    const d = await res.json();
    visionPrompts = d.prompts || {};
    visionBuiltin = d.builtin || [];
  } catch (e) { /* offline: the box still types */ }
}

// ---- caption instructions --------------------------------------------------
// A different thing from the vision system prompt above: that one changes how the
// Krea 2 encoder READS the references, this one is what Ollama is TOLD to write.
let instructionPrompts = {};   // {name: text}
let instructionBuiltin = [];   // names that ship with the pack (not deletable)
async function refreshInstructions() {
  try {
    const res = await api.fetchApi("/rednode/caption_instructions");
    const d = await res.json();
    instructionPrompts = d.prompts || {};
    instructionBuiltin = d.builtin || [];
  } catch (e) { /* offline, or an older pack build: the box still types */ }
}

// The footer's studio-preset choice drives the studio node's own preset widget
// WIRELESSLY, the way Control Panel drives dropdowns: the widget value is what reaches
// the server at queue time, so this works whether or not the bundle is wired. The
// bundle override stays as the belt to this suspender.
// One preset system: while a workspace exists, the studio's own preset dropdown is
// hidden (its value keeps serialising, and the footer drives it wirelessly). Deleting
// the workspace puts the dropdown back.
function setStudioPresetHidden(hidden) {
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === "Krea2RedNode") {
        const w = (n.widgets || []).find((x) => x.name === "preset");
        if (w) {
          if (hidden && !w._rnHidden) {
            w._rnHidden = { type: w.type, computeSize: w.computeSize };
            w.type = "hidden";
            w.computeSize = () => [0, -4];
          } else if (!hidden && w._rnHidden) {
            w.type = w._rnHidden.type;
            w.computeSize = w._rnHidden.computeSize;
            delete w._rnHidden;
          }
          n.setDirtyCanvas?.(true, true);
        }
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
}

function pushStudioPreset(node) {
  setStudioPresetHidden(true);
  const v = node._rnCfg?.studio_preset;
  if (!v) return;                                   // "node's own": never touch the widget
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === "Krea2RedNode") {
        const w = (n.widgets || []).find((x) => x.name === "preset");
        if (w && w.value !== v) {
          w.value = v;
          try { w.callback?.(v); } catch (e) { /* the widget's own hook */ }
          n.setDirtyCanvas?.(true, true);
        }
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
}

// ---- presets ---------------------------------------------------------------
function refreshPresetList(node, names) {
  const w = findWidget(node, "preset");
  if (!w) return;
  w.options = w.options || {};
  w.options.values = [CUSTOM_SENTINEL, ...names];
  if (!w.options.values.includes(w.value)) w.value = CUSTOM_SENTINEL;
}

function openCog(node, anchor) {
  document.querySelector(".rn-ws-panel")?.remove();
  const m = document.createElement("div");
  m.className = "rn-ws-panel";
  for (const t of ["pointerdown", "pointerup", "click", "dblclick", "keydown", "contextmenu"]) {
    m.addEventListener(t, (e) => e.stopPropagation());
  }
  const h = document.createElement("h5");
  h.textContent = "Workspace presets";
  const inp = document.createElement("input");
  inp.placeholder = "Preset name, e.g. red dress shoot";
  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = "A preset stores the whole workspace: galleries, selections, masks, dials. "
                   + "Filenames only, so it is per-machine.";

  const save = document.createElement("button");
  save.textContent = "Save this workspace as a preset";
  save.onclick = async () => {
    const name = inp.value.trim();
    if (!name) { note.textContent = "Give the preset a name first"; return; }
    try {
      const res = await api.fetchApi("/rednode/workspace_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, config: node._rnCfg }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      refreshPresetList(node, d.presets || []);
      note.textContent = `Saved "${name}"`;
    } catch (e) { note.textContent = `Could not save: ${e.message}`; }
  };

  const del = document.createElement("button");
  del.textContent = "Delete the selected preset";
  del.onclick = async () => {
    const pw = findWidget(node, "preset");
    const name = pw?.value;
    if (!name || name === CUSTOM_SENTINEL) { note.textContent = "Pick a preset on the node first"; return; }
    try {
      const res = await api.fetchApi("/rednode/workspace_presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }),
      });
      const d = await res.json();
      refreshPresetList(node, d.presets || []);
      if (pw) pw.value = CUSTOM_SENTINEL;
      note.textContent = `Deleted "${name}"`;
    } catch (e) { note.textContent = `Could not delete: ${e.message}`; }
  };

  m.append(h, inp, save, del, note);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  // the cog sits at the node's bottom edge, so the panel opens UPWARD — downward put it
  // off-screen, the same trap the LoRA stack cog already solved
  const mh = m.getBoundingClientRect().height || 220;
  m.style.left = Math.max(6, Math.min(r.right - 300, (window.innerWidth || 1920) - 306)) + "px";
  m.style.top = Math.max(6, r.top - mh - 6) + "px";
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

// ---- build -----------------------------------------------------------------
function build(node) {
  if (!node.addDOMWidget || node._rnWidget) return;
  const cfgW = findWidget(node, "config");
  if (!cfgW) { requestAnimationFrame(() => build(node)); return; }
  // a Workspace just dropped on the canvas starts ready to render: the built-in
  // sampler and a square latent. A loaded workflow's config replaces this on
  // configure, so nothing saved is touched.
  if (!node._rnSeeded && (!cfgW.value || cfgW.value === "{}")) {
    node._rnSeeded = true;
    cfgW.value = JSON.stringify({
      models: { sampler_mode: "internal" },
      latent: { on: true, aspect: "1:1", w: 1024, h: 1024, scale: 1 },
    });
  }
  cfgW.type = "hidden";
  cfgW.hidden = true;
  cfgW.computeSize = () => [0, -4];
  if (cfgW.element) cfgW.element.style.display = "none";
  if (cfgW.inputEl) cfgW.inputEl.style.display = "none";

  node._rnCfg = readCfg(node);

  const wrap = document.createElement("div");
  wrap.className = "rn-ws-wrap";
  for (const t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "keydown", "contextmenu"]) {
    wrap.addEventListener(t, (e) => e.stopPropagation());
  }
  // The panel is tall enough to scroll, so a plain wheel belongs to the panel.
  // Shift+wheel hands the gesture to the canvas instead, so the node can be
  // zoomed without dragging the pointer off it first.
  wrap.addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;                         // plain wheel scrolls the panel
    e.preventDefault();
    e.stopPropagation();
    app.canvas?.processMouseWheel?.(e);
  }, { passive: false });
  // MIDDLE-DRAG PANS THE CANVAS, the same gesture as on bare canvas, and the companion
  // to shift+wheel above. Zoomed in, this panel can cover the viewport with no canvas
  // left to grab, and every pointer event here is stopped dead, so there was no way out
  // but to zoom back out first. Capture phase and no modifier, so it works anywhere on
  // the panel including over controls: no dead zones to learn, and nothing to conflict
  // with since the middle button does nothing else here.
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 1) return;
    const ds = app.canvas?.ds;
    if (!ds || !Array.isArray(ds.offset)) return;
    e.preventDefault();
    e.stopPropagation();
    let lastX = e.clientX;
    let lastY = e.clientY;
    const prevCursor = wrap.style.cursor;
    wrap.style.cursor = "grabbing";
    const move = (ev) => {
      // offset is in graph space, so the drag has to be divided by the zoom or the
      // canvas runs away from the pointer at anything but 100%
      const scale = ds.scale || 1;
      ds.offset[0] += (ev.clientX - lastX) / scale;
      ds.offset[1] += (ev.clientY - lastY) / scale;
      lastX = ev.clientX;
      lastY = ev.clientY;
      app.canvas?.setDirty?.(true, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      wrap.style.cursor = prevCursor;
    };
    // on WINDOW, so a drag that leaves the panel keeps panning instead of sticking
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }, true);
  // the browser's own middle-click autoscroll would fight the pan, and on a page with
  // no scrollbar it just plants the drifting compass cursor over everything
  const eatMiddle = (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  };
  wrap.addEventListener("mousedown", eatMiddle, true);
  wrap.addEventListener("auxclick", eatMiddle, true);
  // hovering any slider and rolling the wheel adjusts it, one listener for all of them
  bindSliderWheel(wrap);
  node._rnRootEl = wrap;

  const w = node.addDOMWidget("rednode_workspace_ui", "rednode_workspace_ui", wrap, {
    serialize: false,
    getValue: () => cfgW.value,
    setValue: (v) => { cfgW.value = v ?? "{}"; node._rnCfg = readCfg(node); render(node); },
    getMinHeight: () => MIN_PANEL_H,
  });
  w.element = wrap;
  w.options.getMinHeight = () => MIN_PANEL_H;
  w.options.minNodeSize = [NODE_MIN_W, MIN_PANEL_H + 60];
  node._rnWidget = w;

  const prevSer = node.onSerialize;
  node.onSerialize = function (o) {
    prevSer?.apply(this, arguments);
    for (const arr of [o?.inputs, o?.outputs]) {
      for (const slot of arr || []) {
        if (slot.label === " ") { delete slot.label; delete slot.pos; }
      }
    }
  };

  const prevCC = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    prevCC?.apply(this, args);
    applyTuck(this);
  };
  const prevRz = node.onResize;
  node.onResize = function (...args) {
    prevRz?.apply(this, args);
    applyTuck(this);
  };

  // picking a preset replaces the whole workspace, then drops back to "custom (live)" —
  // the config is the truth and you are free to edit from there
  const pw = findWidget(node, "preset");
  if (pw && !pw._rnHooked) {
    pw._rnHooked = true;
    const prior = pw.callback;
    pw.callback = async function (value) {
      prior?.apply(this, arguments);
      if (!value || value === CUSTOM_SENTINEL) return;
      try {
        const res = await api.fetchApi(`/rednode/workspace_presets?name=${encodeURIComponent(value)}`);
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        cfgW.value = JSON.stringify(d.config || {});
        node._rnCfg = readCfg(node);
        // Rebuild against the new object. Every control captured the config it was
        // built with, so without this they keep writing into the one the preset just
        // replaced: the edit lands on an orphan, writeCfg serialises the live config,
        // and the change is silently lost. The Paint prompt showed it first, staying
        // empty however much was typed into it.
        render(node);
        node.graph?.change?.();
      } catch (e) {
        console.error("[RedNode Workspace] could not load preset:", e);
      }
      pw.value = CUSTOM_SENTINEL;
      render(node);
    };
  }

  render(node);
  pushStudioPreset(node);                            // also hides the studio's own dropdown
}

// the server tells us which images a random tab actually rolled
api.addEventListener("rednode-workspace-seed", (e) => {
  // the run's seed, straight from the build: feeds "Use last queued" and
  // "Copy last seed" on the Models tab, the Sick Ollie seed console you
  // asked ours to match
  const d = e?.detail || {};
  for (const n of allNodes()) {
    if (n?.type === NODE_NAME && String(n.id) === String(d.node)) {
      n._rnLastSeed = d.seed;
      if (n._rnTab === "models") render(n);
    }
  }
});

api.addEventListener("rednode.workspace_picked", (e) => {
  const d = e.detail || {};
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === NODE_NAME && String(n.id) === String(d.node)) {
        n._rnPicks = d.picks || {};
        render(n);
        return;
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
});

// the server reports the prompts each run actually produced
api.addEventListener("rednode.workspace_prompts", (e) => {
  const d = e.detail || {};
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n.type === NODE_NAME && String(n.id) === String(d.node)) {
        n._rnPrompts = d.prompts || {};
        if (d.people && typeof d.people === "object") {
          n._rnPersonCaps = { ...(n._rnPersonCaps || {}), ...d.people };
        }
        render(n);
        return;
      }
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(app.graph);
});

// The studio's prompt box is called `instruction` in the code, because that is
// what the edit model consumes and what every saved API workflow addresses. That
// is a poor label to meet in the UI, so it reads "prompt" on the node while the
// underlying name stays put.
function labelStudioPrompt(node) {
  const w = (node.widgets || []).find((x) => x.name === "instruction");
  if (w) w.label = "prompt";
  for (const slot of node.inputs || []) {
    if (slot?.widget?.name === "instruction" || slot?.name === "instruction") {
      slot.label = "prompt";
    }
  }
}

app.registerExtension({
  name: "RedNode.Workspace",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === "Krea2RedNode") {
      const onCreatedS = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onCreatedS?.apply(this, arguments);
        labelStudioPrompt(this);
      };
      const onConfigureS = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        onConfigureS?.apply(this, arguments);
        labelStudioPrompt(this);
      };
      return;
    }
    if (nodeData?.name === "RedNodePaintOut") {
      // The rig widget arrives as a plain STRING; here it becomes a dropdown of the
      // Models tab's rig names, read LIVE from whichever workspace is on the graph,
      // so a rig added a second ago is already in the list. Values-as-function is
      // LiteGraph's own combo contract. Setting .type on the existing widget is not
      // honoured on current frontends (see rednode_slots.makeCombo), so replace it
      // at the SAME index: widgets_values is positional.
      const rigNames = () => {
        const names = ["(active rig)"];
        const seen = new Set();
        const walkGraph = (graph) => {
          for (const n of graph?._nodes || []) {
            if (n?.type === NODE_NAME) {
              try {
                const cfgW = n.widgets?.find((w) => w.name === "config");
                const rigs = JSON.parse(cfgW?.value || "{}").models?.rigs || [];
                rigs.forEach((r, i) => {
                  const nm = String(r?.name || "") || `Rig ${i + 1}`;
                  if (!seen.has(nm)) { seen.add(nm); names.push(nm); }
                });
              } catch (e) { /* a half-typed config is not an error */ }
            }
            if (n?.subgraph) walkGraph(n.subgraph);
          }
        };
        walkGraph(app.graph);
        return names;
      };
      const onCreatedPO = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onCreatedPO?.apply(this, arguments);
        const i = (this.widgets || []).findIndex((w) => w.name === "rig");
        if (i < 0) return;
        const prev = this.widgets[i].value || "(active rig)";
        const tip = this.widgets[i].options?.tooltip;
        this.widgets.splice(i, 1);
        const combo = this.addWidget("combo", "rig", prev, () => {},
                                     { values: rigNames });
        if (tip) combo.options.tooltip = tip;
        const at = this.widgets.indexOf(combo);
        if (at !== i) { this.widgets.splice(at, 1); this.widgets.splice(i, 0, combo); }
      };
      return;
    }
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
        // A configure swaps the config wholesale: the persisted paint canvases may
        // no longer represent what it says, so adoption would show a mask that is
        // not the config's mask. Configure is rare (a load, a graph undo), and a
        // rebuild here is the honest path; the button-press renders still adopt.
        delete this._rnPaintPane;
        this._rnCfg = readCfg(this);
        render(this);
        pushStudioPreset(this);                      // a loaded workflow re-asserts it
      });
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._rnRO?.disconnect?.();
      this._rnFsClose?.();
      onRemoved?.apply(this, arguments);
      // the last workspace leaving puts the studio's own dropdown back
      requestAnimationFrame(() => {
        const any = allNodes().some((n) => n.type === NODE_NAME);
        if (!any) setStudioPresetHidden(false);
      });
    };
  },
  async setup() {
    injectStyle();
    refreshVisionPrompts();
    refreshInstructions();
    refreshAutoStatus();
    refreshPostPresets();
    refreshLoraPresets();
    // THE LIVE FRAMES of a paint run (live_preview.py): matched by the run the
    // tab queued, or by this node's own id when the run was not bound, and only
    // while the tab says a paint run is active. Drawn over the result pane.
    api.addEventListener?.("rednode-live-frame", (e) => {
      const d = e?.detail || {};
      if (!d.data) return;
      const byRun = paintProgressRuns.get(String(d.prompt_id || ""));
      const node = byRun || allNodes().find((n) => n?.type === NODE_NAME
        && String(n.id) === String(d.node) && n._rnPaintProgress?.active);
      if (!node || !node._rnPaintProgress?.active) return;
      showPaintLiveFrame(node, d);
    });
    api.addEventListener?.("progress", (e) => {
      const d = e?.detail || {};
      const node = paintProgressRuns.get(String(d.prompt_id || ""));
      if (!node) return;
      const value = Number(d.value);
      const max = Number(d.max);
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
      node._rnPaintProgress = {
        ...node._rnPaintProgress,
        active: true, determinate: true, value, max,
      };
      syncPaintProgress(node);
    });
    const endPaintRun = (e, failed = false) => {
      const message = e?.detail?.exception_message || e?.detail?.error
        || (failed ? "the Paint run stopped before completing" : "");
      finishPaintProgress(e?.detail?.prompt_id, failed, String(message || ""));
    };
    api.addEventListener?.("execution_success", (e) => endPaintRun(e));
    api.addEventListener?.("execution_error", (e) => endPaintRun(e, true));
    api.addEventListener?.("execution_interrupted", (e) => endPaintRun(e, true));
    // The Paint tab works on whatever came out LAST. An executed event fires for
    // every output node in the chain, the draft save, an autosave inside somebody's
    // renderer, each stage preview, then the composite, and the panel used to redraw
    // on all of them, so a run visibly pulled every intermediate picture through the
    // result pane on its way to the real one. The only reliable way to know an image
    // was last is to wait for the run to finish: each event just records what it saw,
    // each overwriting the one before, and the single redraw happens when ComfyUI
    // says the prompt is over.
    api.addEventListener?.("executed", (e) => {
      const imgs = e?.detail?.output?.images
        || e?.detail?.output?.rn_paint_images;
      if (!Array.isArray(imgs) || !imgs.length) return;
      const im = imgs[imgs.length - 1];
      const finalNodeId = String(e?.detail?.node ?? "");
      const pendingFinal = pendingPaintFinals.get(finalNodeId);
      if (pendingFinal) {
        pendingPaintFinals.delete(finalNodeId);
        const finished = {
          filename: im.filename,
          subfolder: im.subfolder || "",
          type: im.type || "temp",
          prompt_id: e?.detail?.prompt_id || "",
        };
        saveResultAsKeeper(finished).then(
          () => {
            notifySavePending(pendingFinal.saveNoticeId, "done");
            settlePaintFinal(pendingFinal.node, "Postprocessed result saved");
          },
          (err) => {
            console.error("[RedNode Workspace] Post + Save failed:", err);
            notifySavePending(pendingFinal.saveNoticeId, "error", err.message);
            settlePaintFinal(pendingFinal.node, `Save failed: ${err.message}`, true);
            alert(`Post + Save failed: ${err.message}`);
          },
        );
        return; // this final copy must not become the next editable Paint source
      }
      // prompt_id is what lets the save system find where THIS run's image was
      // filed, which is what Save as a keeper stands on
      const promptId = String(e?.detail?.prompt_id || "");
      lastResult = { filename: im.filename, subfolder: im.subfolder || "",
                     type: im.type || "output", rand: (Math.random() * 1e9) | 0,
                     prompt_id: promptId, fresh: true };
      // ONLY A PAINT RUN ADOPTS ITS OWN RESULT. That is the loop the tab exists for:
      // paint, generate, the result becomes the thing you paint on, again. Every other
      // queue just updates the result pane and leaves the canvas alone.
      //
      // paintProgressRuns already maps a prompt id to the node that queued it, and the
      // entry is still there during `executed` because it is cleared at run end. The
      // prompt is pruned to the paint chain, so the only image output in it is the
      // composite: no stage preview, draft save or renderer autosave can be mistaken
      // for the result, which is how intermediate pictures were being pulled in.
      const painter = promptId && paintProgressRuns.get(promptId);
      lastPaintResultOwner = painter || null;
      if (painter) {
        // THE RESULT PANE, NEVER THE CANVAS. Not even this tab's own run: finishing a
        // pass must not take away the picture and the mask you are working on. You
        // look at the result, and if you want to keep going from it you say so, with
        // Use last result or by dragging it across. Nothing on this panel replaces
        // what is under the brush without being asked.
        lastResult.paint = true;                 // this tab made it, so it may show it
      } else if (promptId && paintProgressRuns.size) {
        // a paint run is in flight and this is NOT it: worth saying, because if the
        // canvas still changes here then the registry is matching something it should
        // not and the id is the evidence
        console.log(`[RedNode Workspace] result from run ${promptId} is not a paint `
                  + `run (waiting on ${[...paintProgressRuns.keys()].join(", ")}); `
                  + "the canvas is left alone");
      }
    });
    api.addEventListener?.("executing", (e) => {
      if (e?.detail?.node != null) return;       // null node means the prompt is done
      if (!lastResult?.fresh) return;            // a run that made no images
      delete lastResult.fresh;
      // ONLY THIS TAB'S OWN RUNS REACH THE PANE. An ordinary queue still updates
      // lastResult, so Use last result can pull it in when asked, but it does not put
      // itself on screen, take over the strip or redraw the tab underneath you.
      if (!lastResult.paint) return;
      const owner = lastPaintResultOwner;
      lastPaintResultOwner = null;
      showResult(lastResult, owner);
    });
    const failPaintFinal = (e) => {
      const promptId = String(e?.detail?.prompt_id || "");
      if (!promptId) return;
      for (const [nodeId, pending] of pendingPaintFinals) {
        if (pending.promptId !== promptId) continue;
        pendingPaintFinals.delete(nodeId);
        const message = e?.detail?.exception_message || e?.detail?.error
          || "the queued final did not complete";
        notifySavePending(pending.saveNoticeId, "error", String(message));
        settlePaintFinal(pending.node, `Post failed: ${message}`, true);
      }
    };
    api.addEventListener?.("execution_error", failPaintFinal);
    api.addEventListener?.("execution_interrupted", failPaintFinal);
  },
});
