import * as _appmod from "../../scripts/app.js";
import { makePicker } from "./rednode_picker.js";
const { app } = _appmod;
// ComfyApp is exported by every real frontend, but read it defensively: the mask-editor
// round-trip degrades to the wired-mask fallback rather than breaking the whole panel
const ComfyApp = _appmod.ComfyApp || {};
import { api } from "../../scripts/api.js";
import { postBody, looksSection, openPostCog, refreshPostPresets,
         fxStep, cardOrder } from "./rednode_ws_post.js";
import { TAB_ORDER, IMAGE_TABS, PEOPLE_TABS, DIALS, LATENT_PRESETS, POST_FX,
         VRAM_CAPS, snapStep, MASK_POS_MAX, MASK_ZONE_FR, maskPosOf,
         maskValueOf, resampleTarget, autoShapeLabel, WHOLE_FRAME_CAPS,
         wholeFrameLimit } from "./rednode_ws_tables.js";
import { allNodes, findNode, findNodes, nodeById } from "./rednode_graph.js";
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
.rn-ws-tabs{display:flex;gap:3px;flex:none;flex-wrap:wrap}
.rn-ws-tab{background:#1b1e23;border:1px solid #2a2e35;border-bottom:0;border-radius:6px 6px 0 0;
  color:#9aa0a8;cursor:pointer;font-size:12.5px;font-weight:600;padding:8px 14px;display:flex;
  align-items:center;gap:6px}
.rn-ws-tab.cur{background:#242830;color:#fff;border-color:#3d434c}
/* group colours: canvas blue, mood amber, edit-node red, settings grey */
.rn-ws-tab{border-top:2px solid transparent}
.rn-ws-tab.g-canvas{border-top-color:#4a8fe0}
.rn-ws-tab.g-model{border-top-color:#a855f7}
.rn-ws-tab.g-mood{border-top-color:#e08a3c}
.rn-ws-tab.g-edit{border-top-color:#b8283c}
.rn-ws-tab.g-post{border-top-color:#22a39f}
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
.rn-ws-gen{flex:1 1 auto;min-width:120px;min-height:38px;padding:0 18px;border-radius:6px;
  border:1px solid #2f7a4d;background:#1f9d55;color:#fff;font-weight:700;
  font-size:14.5px;cursor:pointer;letter-spacing:.01em}
.rn-ws-gen:hover{background:#24b463}
.rn-ws-gen:disabled{opacity:.6;cursor:default}
.rn-ws-zbar{display:flex;gap:4px;align-items:center;flex:none;padding:1px 0;
  flex-wrap:wrap}
.rn-ws-zrail{flex-direction:column;align-items:stretch;align-self:stretch;
  background:#16181c;border:1px solid #2f333a;border-radius:6px;padding:8px 7px;
  gap:7px;flex-wrap:nowrap}
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
.rn-ws-tab.gstart{margin-left:9px}
.rn-ws-tab .dot{width:7px;height:7px;border-radius:50%;background:#4a5058;flex:none}
.rn-ws-tab .dot.on{background:#22c55e;box-shadow:0 0 5px #22c55e}
.rn-ws-body{background:#242830;border:1px solid #3d434c;border-radius:0 7px 7px 7px;padding:8px;
  display:flex;flex-direction:column;gap:7px;flex:1 1 auto;min-height:0;overflow:auto}
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
.rn-ws-sect .rn-ws-dial{margin-left:12px}
.rn-ws-fxwrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));
  gap:8px;align-items:start}
.rn-ws-fxwrap .rn-ws-fx{margin:0}
.rn-ws-cost{font-size:9.5px;letter-spacing:.02em;padding:1px 6px;border-radius:9px;
  border:1px solid #6b5a2a;color:#d4b25f;background:#241f12;white-space:nowrap;flex:none}
.rn-ws-fx .blurb{font-size:10.5px;opacity:.5;line-height:1.35;margin:2px 0 0;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.rn-ws-fxgrid{display:flex;flex-direction:column;gap:6px;margin:5px 0 2px}
.rn-ws-fxc{display:flex;flex-direction:column;gap:2px;min-width:0}
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
.rn-ws-latstage{position:relative;width:200px;height:150px;background:#111316;border:1px solid #33373d;
  border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
.rn-ws-latrect{background:#1d2a3a;border:2px solid #4a8fe0;border-radius:3px;display:flex;
  align-items:center;justify-content:center;color:#9dc0ff;font-size:11px;font-weight:700;
  cursor:move;user-select:none;box-shadow:0 0 10px #4a8fe044}
.rn-ws-latrect.rolling{border-color:#f0c58a;color:#f0c58a;border-style:dashed;box-shadow:0 0 10px #f0c58a44}
.rn-ws-latchips{display:flex;flex-wrap:wrap;gap:5px;align-content:flex-start;flex:1}
.rn-ws-latchip{width:34px;height:30px;background:#15171b;border:1px solid #33373d;border-radius:4px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.rn-ws-latchip:hover{border-color:#b8283c}
.rn-ws-latchip.cur{border-color:#4a8fe0;background:#161d29}
.rn-ws-latchip i{display:block;background:#3a4b61;border:1px solid #6b93c4;border-radius:2px}
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
const AUTO_MODES = new Set(["subject", "scene_view", "scene_style",
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
function mirrorActive(t, name) {
  const g = activeGroup(t, name);
  t.images = g.images;
  t.sel = normSel(name, g.sel, g.images.length);
  g.sel = t.sel;
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
      if (typeof t.scale !== "number") t.scale = 1;
      t.scale = Math.max(0.25, Math.min(3, t.scale));
    }
    if (CONVERTER_TABS.includes(name)) {
      t.conv = t.conv && typeof t.conv === "object" ? t.conv : {};
      for (const [k, dv] of [["gender", "off"], ["style", "off"], ["act", "off"]]) {
        if (typeof t.conv[k] !== "string") t.conv[k] = dv;
      }
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
    for (const c of fx.controls) {
      if (c.choice) { if (typeof b[c.key] !== "string") b[c.key] = c.def; }
      else if (typeof b[c.key] !== "number") b[c.key] = c.def;
    }
  }
  d.latent.on = !!d.latent.on;
  d.latent.random = !!d.latent.random;
  d.latent.source = d.latent.source === "input" ? "input" : "tab";
  if (typeof d.latent.scale !== "number") d.latent.scale = 1;
  d.latent.scale = Math.max(1, Math.min(2, d.latent.scale));
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
  d.auto.frank = !!d.auto.frank;
  for (const k of ["joy_quant", "joy_style", "joy_length"]) {
    if (typeof d.auto[k] !== "string") d.auto[k] = "";
  }
  if (typeof d.auto.joy_memory !== "string") d.auto.joy_memory = "auto";
  if (!["off", "scrub", "rewrite"].includes(d.auto.style_lock)) d.auto.style_lock = "off";
  if (d.auto.joy_mode_prompts === undefined) d.auto.joy_mode_prompts = true;
  if (d.use_dials === undefined) d.use_dials = true;
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
  ["subject", "Subject"],
  ["subject2", "People: second"],
  ["subject3", "People: third"],
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
  // ultrawide grows towards 1.8x, nothing ever shrinks below 1x, and the user's UI
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
 *  user already moved to another picture while the copy was in flight. */
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
 *  which is a tell that the job was never the user's to remember.
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
async function runStandaloneAutoPrompt(node, tabName, entry) {
  if (node._rnAutoBusy) {
    throw new Error("An auto prompt is already running.");
  }
  node._rnAutoBusy = tabName;
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
    (node._rnPrompts ||= {})[tabName] = prompt;
    if (d.skipped?.length) {
      console.log("[RedNode Workspace] standalone auto prompt skipped:",
                  d.skipped.join("; "));
    }
    return prompt;
  } finally {
    node._rnAutoBusy = null;
    render(node);
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
  // Captioning can take long enough for the user to keep typing. A second notice
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
  for (const [target, label] of SEND_TARGETS) {
    if (target === tabName) continue;
    const dup = node._rnCfg.tabs[target]?.images.includes(entry);
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

function galleryBody(node, body, tabName, meta, { multi = false } = {}) {
  const cfg = node._rnCfg;
  const t = cfg.tabs[tabName];

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const on = document.createElement("button");
  on.className = "rn-ws-on" + (t.on ? " on" : "");
  on.textContent = t.on ? "ON" : "OFF";
  on.title = t.on ? "This tab feeds the studio. Click to disable it."
                  : "Disabled: this tab outputs nothing.";
  on.onclick = () => { t.on = !t.on; writeCfg(node); render(node); };
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = meta.hint || "";
  row.append(on, hint);
  body.appendChild(row);

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
      // THIS gallery's cells, not every cell in the panel. The People tab draws three
      // galleries at once, so a panel-wide sweep would drag Subject 3's thumbnails
      // along with Subject 2's slider.
      const scope = grid || node._rnRootEl;
      for (const cell of scope.querySelectorAll(".rn-ws-cell, .rn-ws-add")) {
        cell.style.width = cell.style.height = cfg.thumbs[tabName] + "px";
      }
    });
    th.append(tl, tr);
    row.appendChild(th);
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
  body.appendChild(coll);

  grid = document.createElement("div");        // the slider above closes over this
  grid.className = "rn-ws-grid";
  const cellPx = thumbOf(cfg, tabName);
  t.images.forEach((entry, i) => {
    const cell = document.createElement("div");
    const selected = multi ? t.sel.includes(i) : t.sel === i;
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
    const x = document.createElement("button");
    x.className = "rn-ws-x";
    x.textContent = "✕";
    x.title = "Remove from this gallery. The file itself stays in ComfyUI/input.";
    x.onclick = (e) => {
      e.stopPropagation();
      t.images.splice(i, 1);                          // t.images IS the group's array
      if (multi) t.sel = t.sel.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k));
      else if (t.sel >= t.images.length) t.sel = Math.max(0, t.images.length - 1);
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
      } else {
        t.sel = i;
      }
      activeGroup(t, tabName).sel = t.sel;           // the collection owns the selection
      writeCfg(node); render(node);
    };
    grid.appendChild(cell);
  });

  const add = document.createElement("button");
  add.className = "rn-ws-add";
  add.style.width = add.style.height = cellPx + "px";
  add.textContent = "+";
  add.title = "Add images, or drop files anywhere on this grid.";
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
  body.appendChild(grid);

  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = !t.images.length
    ? "No images yet. Use + or drop files here; the gallery remembers them."
    : multi && !t.sel.length && !t.random
      ? `NOTHING in the batch: ${t.images.length} image(s) here, none selected, so this tab `
        + `outputs nothing. Click the ones to use.`
      : t.random
      ? `🎲 random: one of these ${t.images.length} is picked fresh each run`
        + (multi ? " (a single ref, ignoring the batch selection)" : "")
        + (node._rnPicks?.[tabName] ? `. Last run rolled the amber one` : "")
      : multi
        ? `${t.sel.length} of ${t.images.length} in the batch. Click to add or remove; numbers show batch order.`
        : `${t.images.length} remembered. The highlighted one is used.`;
  body.appendChild(note);
}

function peopleBody(node, body) {
  const cfg = node._rnCfg;
  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = "Extra people become the Krea2 source chain; the subject stays the last ref. "
                   + "3+ refs is beyond the edit LoRA's training, so identities may blend.";
  body.appendChild(note);
  for (const [name, meta] of Object.entries(PEOPLE_TABS)) {
    const h = document.createElement("div");
    h.style.cssText = "font-size:11px;font-weight:700;opacity:.65;letter-spacing:.3px;margin-top:2px";
    h.textContent = meta.label;
    body.appendChild(h);
    galleryBody(node, body, name, meta);
  }
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
    on.className = "rn-ws-on" + (t.on ? " on" : "");
    on.textContent = t.on ? "ON" : "OFF";
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
    node._rnStrokes = [];
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
          title: "Wipe the strokes and any saved or auto mask.",
          run: (refresh) => {
            const live = P();
            node._rnStrokes = [];
            live.mask = "";
            live.auto_mask = "";
            node._rnMaskDirty = false;
            writeCfg(node);
            node._rnResetPaint?.();
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
function autoSection(node, body, tabName) {
  if (!["subject", "scene", "moodboard", "i2i", "paint"].includes(tabName)) return;
  const cfg = node._rnCfg;
  const isPaint = tabName === "paint";
  const a = isPaint ? cfg.paint.auto : cfg.tabs[tabName].auto;
  const open = !!(node._rnAutoOpen ||= {})[tabName];

  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-auto";
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
  on.className = "rn-ws-on" + (a.on ? " on" : "");
  on.textContent = a.on ? "ON" : "OFF";
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
  head.append(arr, on, ttl);        // toggle in front of the title, see the masks head
  head.onclick = (e) => {
    if (e.target === on) return;
    node._rnAutoOpen[tabName] = !open;
    render(node);
  };
  sect.appendChild(head);

  if (open) {
    const row = document.createElement("div");
    row.className = "rn-ws-row";
    const eng = (key, label, ok, why) => {
      const b = document.createElement("button");
      b.className = "rn-ws-on" + (a[key] && ok ? " on" : "");
      b.textContent = label;
      b.style.width = "auto";
      b.style.padding = "0 9px";
      b.disabled = !ok;
      b.title = ok ? `Use ${label} for this tab.` : why;
      b.onclick = () => { a[key] = !a[key]; writeCfg(node); render(node); };
      return b;
    };
    const fixedBtn = document.createElement("button");
    fixedBtn.className = "rn-ws-on" + (a.fixed ? " on" : "");
    fixedBtn.textContent = a.fixed ? "REUSE" : "FRESH";
    fixedBtn.style.width = "auto";
    fixedBtn.style.padding = "0 9px";
    fixedBtn.title = a.fixed
      ? "Reuse: the same image keeps its prompt; the LLM does not re-run. Click for "
        + "fresh wording every queue."
      : "Fresh: the LLM re-runs on EVERY queue and the whole graph downstream "
        + "recomputes. Click to reuse the prompt per image instead.";
    fixedBtn.onclick = () => { a.fixed = !a.fixed; writeCfg(node); render(node); };

    const adv = document.createElement("button");
    adv.className = "rn-ws-cog" + (node._rnAutoAdv ? " on" : "");
    adv.style.marginLeft = "0";
    adv.style.width = "28px";
    adv.style.height = "26px";
    adv.textContent = "⚙";
    adv.title = node._rnAutoAdv
      ? "Advanced engine settings are open. Click to close them."
      : "Advanced engine settings, shared by every tab.";
    adv.onclick = () => {
      node._rnAutoAdv = !node._rnAutoAdv;
      render(node);
    };

    row.append(
      eng("ollama", "Ollama", autoStatus.ollama,
          "Ollama is not reachable. Start it and reopen the workflow."),
      eng("wd14", "WD14 tags", autoStatus.wd14,
          "comfyui-wd14-tagger is not installed."),
      eng("joy", "JoyCaption", autoStatus.joy,
          "ComfyUI-JoyCaption is not installed."),
      eng("qwen", "QwenVL", autoStatus.qwen,
          "ComfyUI-QwenVL is not installed."),
      eng("clipgen", "CLIP gen", true, ""),
      fixedBtn, adv,
    );
    // the button is always offered: whether it works depends on the clip INPUT being
    // wired, which only the queue can know; the tooltip says so
    for (const b of row.children) {
      if (b.textContent === "CLIP gen") {
        b.title = "Captions with the workflow's ALREADY-LOADED text encoder (zero extra "
                + "models). Wire the studio's CLIP into the workspace clip input.";
      }
    }
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "JoyCaption and QwenVL run their own models (heavy; unloaded per "
                     + "the RAM setting). Anything else wires into the caption sockets.";
    row.appendChild(hint);
    sect.appendChild(row);

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
      sect.appendChild(mrow);
    }

    if (tabName === "scene") {
      const mrow = document.createElement("div");
      mrow.className = "rn-ws-row";
      const mlab = document.createElement("span");
      mlab.className = "rn-ws-note";
      mlab.textContent = "Describe the";
      const msel = document.createElement("select");
      msel.className = "rn-ws-res";
      for (const [v, label] of [["scene_view", "View: location, layout, camera"],
                                ["scene_style", "Style: palette, lighting, rendering"]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        o.selected = a.mode === v;
        msel.appendChild(o);
      }
      msel.title = "View describes the place; people stay 'a person', never described. "
                 + "Style describes only the look.";
      msel.onchange = () => { a.mode = msel.value; writeCfg(node); render(node); };
      mrow.append(mlab, msel);
      sect.appendChild(mrow);
    }

    if (node._rnAutoAdv) {
      const advBox = document.createElement("div");
      advBox.className = "rn-ws-advgrid";
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
        b.className = "rn-ws-on" + (cfg.auto[key] ? " on" : "");
        b.textContent = cfg.auto[key] ? "ON" : "OFF";
        b.title = hint;
        b.onclick = () => { cfg.auto[key] = !cfg.auto[key]; writeCfg(node); render(node); };
        w.append(t, b);
        return w;
      };

      const h1 = document.createElement("div");
      h1.className = "advh";
      h1.textContent = "WD14";
      advBox.appendChild(h1);
      if (autoStatus.wd14_models?.length) {
        const w = document.createElement("label");
        w.className = "cellc wide";
        const t = document.createElement("span");
        t.textContent = "Model";
        const sel = document.createElement("select");
        sel.className = "rn-ws-res";
        for (const m of autoStatus.wd14_models) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          o.selected = (cfg.auto.wd14_model || autoStatus.wd14_model) === m;
          sel.appendChild(o);
        }
        sel.onchange = () => { cfg.auto.wd14_model = sel.value; writeCfg(node); };
        w.append(t, sel);
        advBox.appendChild(w);
      }
      advBox.append(
        num("Threshold", "threshold", 0, 1, 0.01, "General tag confidence floor."),
        num("Character thr", "character_threshold", 0, 1, 0.01, "Character tag confidence floor."),
        boolBtn("underscores→spaces", "replace_underscore", "Replace underscores with spaces in tags."),
        boolBtn("unload after run", "wd14_unload",
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
      advBox.appendChild(ex);

      if (autoStatus.joy) {
        const hj = document.createElement("div");
        hj.className = "advh";
        hj.textContent = "JoyCaption";
        advBox.appendChild(hj);
        const jsel = (label, key, options, hint) => {
          const w = document.createElement("label");
          w.className = "cellc";
          const t = document.createElement("span");
          t.textContent = label;
          t.title = hint;
          const sel = document.createElement("select");
          sel.className = "rn-ws-res";
          for (const [v, lab2] of options) {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = lab2;
            o.selected = cfg.auto[key] === v;
            sel.appendChild(o);
          }
          sel.title = hint;
          sel.onchange = () => { cfg.auto[key] = sel.value; writeCfg(node); };
          w.append(t, sel);
          return w;
        };
        const packOpts = autoStatus.joy_options || {};
        const withDefault = (list) => [["", "pack default"], ...(list || []).map((x) => [x, x])];
        advBox.append(
          jsel("Quantization", "joy_quant", withDefault(packOpts.quantization),
               "Speed against quality; 8-bit suits most cards."),
          jsel("Caption length", "joy_length", withDefault(packOpts.caption_length),
               "How long JoyCaption's paragraph runs."),
          jsel("Memory", "joy_memory",
               [["auto", "Auto (RAM setting)"], ["Keep in Memory", "Keep in Memory"],
                ["Clear After Run", "Clear After Run"], ["Global Cache", "Global Cache"]],
               "Auto follows the unload-after-run setting. Global Cache is fastest and "
               + "hungriest."),
          jsel("Prompt style", "joy_style", withDefault(packOpts.prompt_style),
               "Only used when mode prompts are OFF below."),
          boolBtn("mode prompts", "joy_mode_prompts",
                  "On: this panel's per-tab prompts steer JoyCaption (scene stays "
                  + "anonymous, style stays subject-free). Off: the pack's own prompt "
                  + "style above takes over."),
        );
      }

      const hx = document.createElement("div");
      hx.className = "advh";
      hx.textContent = "Extras (every engine)";
      advBox.appendChild(hx);
      advBox.append(
        boolBtn("frank wording", "frank",
                "Appends a clause telling every engine to describe nudity and sexual "
                + "content plainly, without euphemism. Off ships the neutral prompts."),
      );

      const h2 = document.createElement("div");
      h2.className = "advh";
      h2.textContent = "Ollama";
      advBox.appendChild(h2);
      advBox.append(
        num("Temperature", "temperature", 0, 2, 0.05, "Higher = looser wording. 0.2 is factual."),
        num("Seed", "seed", 0, 2147483647, 1, "0 = unseeded. A fixed seed pins the wording."),
        num("num_ctx", "num_ctx", 0, 131072, 256, "Context window. 0 = the model's default."),
        num("num_predict", "num_predict", 0, 8192, 16, "Response length cap. 0 = default."),
        num("top_k", "top_k", 0, 200, 1, "0 = default."),
        num("top_p", "top_p", 0, 1, 0.01, "0 = default."),
        boolBtn("think", "think", "Reasoning models think before answering: better reads, slower."),
        num("Keep alive s", "keep_alive", 0, 3600, 5,
            "How long Ollama keeps the model in RAM after a response. 0 unloads immediately (saves RAM, reloads next call); 300 keeps it warm."),
      );

      // THE INSTRUCTION: what Ollama is actually TOLD to write. Until now this was
      // reachable only by editing autoprompt.py's SYSTEM_PROMPTS, which is not a
      // setting. Ollama alone reads it, which is why it sits under Ollama: the local
      // captioners answer worse when handed wording they were not trained on, so they
      // keep the mode's own. Wrapped because a panel that cannot draw one settings row
      // must still hand the prompt over. An exception in this exact spot once took
      // every gallery prompt down with it.
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
        advBox.append(pick, wrap, qwrap, brow);
      } catch (e) {
        console.error("[RedNode] the instruction row could not be drawn", e);
      }

      sect.appendChild(advBox);
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
      sect.appendChild(lrow);
    }

    const crow = document.createElement("div");
    crow.className = "rn-ws-row";
    const clab = document.createElement("span");
    clab.className = "rn-ws-note";
    clab.textContent = "Combine";
    const csel = document.createElement("select");
    csel.className = "rn-ws-res";
    for (const [v, label] of [["append", "Append: paragraph, then tag line"],
                              ["blend", "Blend: one LLM pass rewrites it all"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      o.selected = a.combine === v;
      csel.appendChild(o);
    }
    csel.title = "Append keeps every engine's words as they came. Blend costs one more "
               + "Ollama pass and rewords everything into one prompt.";
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

    if (autoStatus.models?.length) {
      const mlab2 = document.createElement("span");
      mlab2.className = "rn-ws-note";
      mlab2.textContent = "Model";
      const osel = document.createElement("select");
      osel.className = "rn-ws-res";
      for (const m of autoStatus.models) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        o.selected = cfg.auto.model === m;
        osel.appendChild(o);
      }
      if (!cfg.auto.model && autoStatus.models.length) {
        cfg.auto.model = autoStatus.models[0];
      }
      osel.title = "The Ollama model used for every tab's captions.";
      osel.onchange = () => { cfg.auto.model = osel.value; writeCfg(node); };
      crow.append(mlab2, osel);
    }
    sect.appendChild(crow);

    // What this picture has been called before. A session that has just opened
     // knows nothing, but the captions were written beside the image at the time,
     // so they can simply be read back. Nothing is regenerated and nothing is
     // overwritten by looking.
    const recall = document.createElement("button");
    recall.className = "rn-ws-btn";
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
        const t2 = cfg.tabs[tabName];
        const idx = Array.isArray(t2.sel) ? (t2.sel[0] ?? 0) : t2.sel;
        const entry = (t2.images || [])[idx];
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
    rrow.appendChild(recall);
    if (!isPaint && node._rnSaved) {
      const clr = document.createElement("button");
      clr.className = "rn-ws-btn";
      clr.style.width = "auto";
      clr.style.padding = "0 10px";
      clr.textContent = "Hide";
      clr.onclick = () => { node._rnSaved = null; render(node); };
      rrow.appendChild(clr);
    }
    sect.appendChild(rrow);
    if (!isPaint && node._rnSaved) {
      const box = document.createElement("div");
      box.className = "rn-ws-note";
      box.style.whiteSpace = "pre-wrap";
      box.textContent = node._rnSaved;
      box.title = "Click to copy.";
      box.style.cursor = "pointer";
      box.onclick = () => navigator.clipboard?.writeText?.(node._rnSaved);
      sect.appendChild(box);
    }

    const last = node._rnPrompts?.[tabName];
    const autoError = node._rnAutoErrors?.[tabName];
    const prev = document.createElement("div");
    prev.className = "rn-ws-note";
    prev.style.whiteSpace = "pre-wrap";
    prev.textContent = node._rnAutoBusy === tabName
      ? "generating the auto prompt..."
      : autoError ? `automatic prompt failed: ${autoError}`
      : last ? `last run:
${last}` : isPaint
        ? "no prompt generated yet; right-click a result"
        : "no prompt generated yet; queue a run, or right-click a thumbnail";
    prev.title = last ? "The prompt the last run produced. Click to copy." : "";
    if (last) {
      prev.style.cursor = "pointer";
      prev.onclick = () => navigator.clipboard?.writeText?.(last);
    }
    sect.appendChild(prev);
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
export const postWrite = (node) => (node._rnPostWrite || writeCfg)(node);
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

function loraPresetRow(node, body) {
  const cfg = node._rnCfg;
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
      cfg.loras.slots = d.slots || [];
      cfg.loras.ui = { ...(cfg.loras.ui || {}), loaded_from: name };
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
    const name = prompt("Name this stack", cfg.loras.ui?.loaded_from || "");
    if (!name) return;
    try {
      await loraPresetAction(node, { action: "save", name,
                                     slots: cfg.loras.slots || [] });
      cfg.loras.ui = { ...(cfg.loras.ui || {}), loaded_from: name };
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

  const from = cfg.loras.ui?.loaded_from;
  if (from) {
    const note = document.createElement("div");
    note.className = "rn-ws-note";
    note.textContent = `Loaded from "${from}". Edits here are not saved back until you `
                     + "save again.";
    body.appendChild(note);
  }
}

function lorasBody(node, body) {
  const cfg = node._rnCfg;
  const L = cfg.loras;

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const on = document.createElement("button");
  on.className = "rn-ws-on" + (L.on ? " on" : "");
  on.textContent = L.on ? "ON" : "OFF";
  on.title = L.on
    ? "The stack is applied to the model input and handed back on the model output."
    : "Off: the model passes through untouched.";
  on.onclick = () => { L.on = !L.on; writeCfg(node); render(node); };
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "Wire the model in and take it from the model output. Trigger words "
                   + "come out on lora_keywords.";
  row.append(on, hint);
  body.appendChild(row);

  const seedRow = document.createElement("div");
  seedRow.className = "rn-ws-row";
  const slab = document.createElement("span");
  slab.className = "rn-ws-note";
  slab.textContent = "Seed";
  const seed = document.createElement("input");
  seed.type = "number";
  seed.min = 0;
  seed.value = L.seed;
  seed.style.cssText = "width:130px;background:#15171b;border:1px solid #33373d;"
                     + "border-radius:4px;color:#e8ecf1;font-size:12px;padding:4px 6px";
  seed.title = "Drives any slot set to a random strength range. The same seed and the "
             + "same stack give the same strengths.";
  seed.addEventListener("change", () => {
    L.seed = Math.max(0, parseInt(seed.value, 10) || 0);
    writeCfg(node);
  });
  seedRow.append(slab, seed);
  body.appendChild(seedRow);
  loraPresetRow(node, body);

  // the shared panel reads and writes through these instead of a widget
  node._rnStackRead = () => ({ ui: cfg.loras.ui, slots: cfg.loras.slots });
  node._rnStackWrite = (n, v) => {
    cfg.loras.ui = v.ui || {};
    cfg.loras.slots = v.slots || [];
    writeCfg(n);
  };
  node._rnSlots = cfg.loras.slots;
  node._rnUI = cfg.loras.ui;

  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:1;min-height:80px";
  body.appendChild(host);
  buildLoraPanel(node, host);
}

// A row at the top of Advanced for things that ACT rather than configure.
function advancedTools(node, body) {
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
  // happened. Automatic exists but is never imposed; that ordering was the user's
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
  // On the tab rather than only in the settings dialog, at the user's call: a
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

function finishPaintProgress(promptId, failed = false, message = "") {
  const id = String(promptId || "");
  const node = paintProgressRuns.get(id);
  paintProgressRuns.delete(id);
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
// anywhere in a chain is the user having already said what that chain is, and that
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
  let label = "";
  try {
    label = rendererLabel(t);
    const others = paintTargets();
    const clash = others.some((o) => o.node !== t?.node && rendererLabel(o) === label);
    if (!clash) return label;
  } catch (err) {
    // A half-wired graph must not take the panel down with it: this runs on every
    // render, including while the user is still dragging the wires in.
    console.debug?.("[RedNode Workspace] could not name a renderer:", err);
    if (!label) label = t?.kind === "render" ? "Paint Render" : "Paint In (own chain)";
  }
  return `${label} #${t?.node?.id}`;
}

function chosenTarget(cfg) {
  const found = paintTargets();
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
// The seed socket feeds whatever the user wired it into, and the receiver's range is
// theirs, not ours: NovelAI's node caps its seed at 9999999999 and the service clamps
// anything past it, so a 2^53 roll landed on the SAME clamped value every single time.
// The number on screen changed, the seed NAI actually used did not, and every Generate
// after the first came back as the identical picture. 0..2^32-1 is the range every
// sampler and every service accepts, and it is what ComfyUI's own seed widgets roll.
export function rollSeed() {
  return Math.floor(Math.random() * 0x100000000);
}

async function paintGenerate(node) {
  const picked = chosenTarget(node._rnCfg);
  if (!picked) {
    alert("Nothing to paint with. Either add a RedNode Paint Render node and wire "
        + "model, positive, negative and vae into it, or add RedNode Paint Out and "
        + "Paint In with your own renderer in between. Generate drives whichever it "
        + "finds.");
    return;
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
  // WHETHER it frees is the user's call. On a card with room, two renderers sitting
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
  on.className = "rn-ws-on" + (P.on ? " on" : "");
  on.textContent = P.on ? "ON" : "OFF";
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
  tsWrap.append(sizesB);
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

  // TWO COLUMNS, the user's layout: the pictures stacked on the left, paint above
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
  psideBox.appendChild(pside);
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
  // default is exactly what always happened. NODE VIEW ONLY, stated by the user:
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
    left.append(base, layer);
    node._rnPaintLayer = layer;

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
      base.getContext("2d").drawImage(img, 0, 0);
      paintCanvasReady = true;
      // the strokes so far survive a re-render, so switching tabs is not destructive,
      // and the auto mask under them survives it the same way
      if (node._rnStrokes?.length || baseImg || overlayDrawOwed) rebuildMask();
      node._rnSyncRing?.();
      // the layout can hold the full height now, so a scroll restore the browser
      // clamped at render time is paid here, once. The still-at-zero check is what
      // keeps it from ever fighting the user: a hand that scrolled since the render
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
      if (node._rnMaskDirty && !drawing) saveMaskNow(node);
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
      node._rnPaintDirty = true;
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
    if (fs) {
      // THE RAIL OWNS THE BRUSH in the big room, per the user's drawing: a vertical
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
      rb.append(bLab, bRng, bVal, shapeCol);
      zbar.appendChild(rb);
    } else {
      // ONE line under the canvas, the user's sketch: view buttons with undo beside
      // Fit, then the brush stretched across the middle, then the size pills at the
      // right end, so the gap between the two pictures stays a single row tall
      brushCtl.className = "rn-ws-pcard rowline";
      bRng.style.width = "";
      bRng.style.flex = "1 1 120px";
      bTop.style.flex = "1 1 auto";
      brushCtl.append(bTop);
      zbar.appendChild(brushCtl);
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
      node._rnSyncZbar?.();
    };
    node._rnPaintPane = { src, fs, left, zbar, syncControls, undo, redo, zoomAt,
                          rebuildMask, baseFor: () => baseFor };
  }
  // fresh pane only: re-registering on an adopted one would double the drop handlers
  paintDropZone(node, left);
  }
  // WHILE THE CANVAS-ONLY ROOM IS OPEN the pane lives in that overlay, and taking it
  // back here would empty the room the user is painting in. The panel still renders
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
    rimg.title = "Drag onto the Paint pane to paint on this image. Right-click for "
               + "actions.";
    // DRAG replaces the old click-adopts: a whole pane spending its click on one
    // action was a wasted surface, and dragging a picture onto the place you paint
    // is the gesture every editor already teaches
    rimg.draggable = true;
    rimg.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("application/x-rednode-result",
                              JSON.stringify(shown));
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
  // The four denoise values the user actually works between, one click each. The
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
  dLab.classList?.add?.("ttl");
  dHead.append(dLab, dpre);
  dTop.append(dTrack, dVal);
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
    const dice = document.createElement("button");
    dice.className = "rn-ws-btn" + (P.seed_random !== false ? " on" : "");
    dice.textContent = P.seed_random !== false ? "\uD83C\uDFB2 random" : "\uD83D\uDCCC fixed";
    dice.title = P.seed_random !== false
      ? "A new seed is rolled before each Generate. Click to keep the current one, "
        + "which repeats the same picture until something else changes."
      : "This exact seed runs every Generate, so an unchanged setup is served from "
        + "cache and nothing re-renders. Click to roll a new seed each press.";
    dice.onclick = () => {
      P.seed_random = P.seed_random === false;
      writeCfg(node); render(node);
    };
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
      const floorB = document.createElement("button");
      floorB.className = "rn-ws-btn rn-ws-compact" + (P.region_floor ? " on" : "");
      floorB.dataset.regionFloor = "1";
      floorB.style.width = "auto";
      floorB.style.padding = "0 8px";
      floorB.textContent = P.region_floor ? "Never shrink" : "Size is a target";
      floorB.title = P.region_floor
        ? "On: a region already bigger than the mask size renders at its own size "
          + "instead of coming down to it. Keeps every pixel of a large region, at "
          + "that region's cost. The VRAM tier ceiling still applies."
        : "Off: the mask size is a target in BOTH directions, so a big region is "
          + "brought down to it. Click to keep large regions at their own size "
          + "instead, which preserves detail but can push a model past the "
          + "resolution it was trained on.";
      floorB.onclick = () => {
        const live = node._rnCfg?.paint || P;
        live.region_floor = !live.region_floor;
        writeCfg(node);
        render(node);
      };

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
  // Mask size on the primary bar, in the mode's old slot: the user's call, and the
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
  // Generate above, the mode beneath it, one stacked block per the user's layout
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
        // it REPLACES rather than adding to what is there, which is what the user
        // asked for: press it and the canvas shows that mask. The strokes go with it,
        // because they were drawn against a mask that is no longer the one underneath.
        live.auto_mask = d.mask;
        node._rnStrokes = [];
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
  clear.title = "Wipe the brush strokes and any saved or auto mask. The picture "
              + "underneath is untouched.";
  clear.onclick = () => {
    node._rnStrokes = [];
    const live = node._rnCfg?.paint || P;
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

  // SAVE MASK IS GONE, because it was never the user's job. The mask now uploads by
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
    row.append(lab, box);
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
  // WHERE THE RENDER RUNS decides whether these are offered. The toggles feed Paint
  // Render's own reference conditioning, so they are live there; on an external chain
  // they change nothing and a dead button teaches the wrong lesson. The one exception
  // by exact name: a chain called "Krea2 Workspace", whose sampler takes the main
  // studio conditioning and carries the references itself.
  const refT = paintTargets().find((x) => String(x.node.id) === String(P.renderer ?? ""));
  const refName = String(refT ? rendererName(refT) : P.renderer_name || "")
    .trim().toLowerCase();
  const refsLive = (refT ? refT.kind === "render" : true) || refName === "krea2 workspace";
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
      b.title = "References cannot ride this chain: its sampler takes plain text "
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

  const loraRow = document.createElement("div");
  loraRow.className = "rn-ws-row";
  const llab = document.createElement("span");
  llab.className = "hint";
  llab.style.cssText = "flex:none;width:96px";
  llab.textContent = "LoRAs";
  loraRow.appendChild(llab);
  // Three states, one switch, the same shape as the paint mode: where the LoRAs for
  // this paint pass come from. A toggle could only ever say two of the three.
  const lseg = document.createElement("div");
  lseg.className = "rn-ws-seg";
  const lmode = P.loras_mode || (P.use_loras ? "tab" : "wired");
  const lbtn = (label, val, title) => {
    const b = document.createElement("button");
    b.className = "rn-ws-segb" + (lmode === val ? " on" : "");
    b.textContent = label;
    b.title = title;
    b.onclick = () => {
      P.loras_mode = val;
      P.use_loras = val === "tab";     // the old key stays true for older readers
      writeCfg(node);
      render(node);
    };
    lseg.appendChild(b);
  };
  lbtn("LoRA tab", "tab",
       "The Workspace's LoRAs tab is applied to whatever model reaches the render "
       + "node. Use this when painting on a DIFFERENT model that arrives raw. "
       + "WARNING: if the model wired there already came through the LoRAs tab, they "
       + "are applied twice.");
  lbtn("Wired in", "wired",
       "The model is used exactly as wired, whatever is on it. Right when you wired "
       + "the Workspace's model output, which already carries the LoRAs tab, or an "
       + "external LoRA loader's output. Wire the RAW model here to paint with no "
       + "LoRAs at all.");
  // No third state. Once LoRAs are baked into a model this node cannot take them
  // off, so None could only ever be Wired in wearing another name, and a button that
  // does nothing new is worse than a button that is not there. Painting without
  // LoRAs is what Wired in already does when the raw model is what you wired.
  loraRow.appendChild(lseg);
  if (lmode === "tab") {
    const warn = document.createElement("span");
    warn.className = "hint";
    warn.style.color = "#d4b25f";
    warn.textContent = "Wire the RAW model here, not the LoRA output";
    loraRow.appendChild(warn);
  }
  routeBox.appendChild(loraRow);

  const found = paintTargets();
  if (found.length) {
    // healed above, before the reference row read the choice
    const rrow = document.createElement("div");
    rrow.className = "rn-ws-row";
    const rl = document.createElement("span");
    rl.className = "hint";
    rl.style.cssText = "flex:none;width:96px";
    rl.textContent = "Rendered by";
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
        const live = paintTargets();
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
      sel.title = "Which node Generate drives. Name your Paint In nodes after what is "
                + "in them, NAI, SDXL, whatever, and that is what shows here. Paint "
                + "Render does the whole job itself; Paint In is the end of a chain "
                + "with your own renderer in it. CFG and Steps below are remembered "
                + "PER renderer and switch back with it, since models rarely agree "
                + "on what those numbers should be.";
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
    if (!node._rnStrokes?.length && !P.mask && !P.auto_mask && !P.invert) {
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
function maskSegment(mask, x0, y0, x1, y1, w, erase, shape) {
  const ctx = mask.getContext("2d");
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
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
  for (const [x0, y0, x1, y1, w, erase, , shape] of strokes || node._rnStrokes || []) {
    maskSegment(mask, x0, y0, x1, y1, w, erase, shape || "round");
  }
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


function latentBody(node, body) {
  const cfg = node._rnCfg;
  const L = cfg.latent;
  const eff = (v) => Math.floor(v * (L.scale || 1) / 8) * 8;   // what actually ships

  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const on = document.createElement("button");
  on.className = "rn-ws-on" + (L.on ? " on" : "");
  on.textContent = L.on ? "ON" : "OFF";
  on.title = L.on ? "The empty latent goes out on output_latent."
                  : "Off: output_latent stays empty unless the edit mask provides one.";
  on.onclick = () => { L.on = !L.on; writeCfg(node); render(node); };
  const srcBtn = document.createElement("button");
  srcBtn.className = "rn-ws-on" + (L.source === "input" ? " on" : "");
  srcBtn.style.width = "auto";
  srcBtn.style.padding = "0 10px";
  srcBtn.textContent = L.source === "input" ? "Wired input" : "This tab";
  srcBtn.title = L.source === "input"
    ? "output_latent is whatever you wired into the node's latent socket. The size "
      + "controls below are ignored. Click to build the canvas here instead."
    : "The canvas is built here, from the size below. Click to use a latent wired "
      + "into the node's latent socket instead.";
  srcBtn.onclick = () => {
    L.source = L.source === "input" ? "tab" : "input";
    writeCfg(node);
    render(node);
  };
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = L.source === "input"
    ? "Your own latent passes straight through to output_latent."
    : "The workspace's own Empty Latent Image. Wire output_latent to the sampler and "
      + "to the studio, one source for both.";
  row.append(on, srcBtn, hint);
  body.appendChild(row);
  if (L.source === "input") {
    const note = document.createElement("div");
    note.className = "rn-ws-note";
    note.textContent = "Wire your latent into the node's latent input. Nothing wired "
                     + "there falls back to the canvas below.";
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
  const fit = 140 / Math.max(L.w, L.h);
  rect.style.width = Math.max(28, Math.round(L.w * fit)) + "px";
  rect.style.height = Math.max(24, Math.round(L.h * fit)) + "px";
  rect.textContent = L.random ? "?" : `${eff(L.w)} × ${eff(L.h)}`;
  rect.title = L.random
    ? "Random is on: a preset size is rolled each queue."
    : "Drag to reshape: sideways for width, up and down for height. Snaps to 64.";
  if (!L.random) {
    rect.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY, w0 = L.w, h0 = L.h;
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        const w1 = Math.abs(dx) < 6 ? w0 : w0 + dx * 6;
        const h1 = Math.abs(dy) < 6 ? h0 : h0 + dy * 6;
        L.w = Math.max(256, Math.min(4096, Math.round(w1 / 64) * 64));
        L.h = Math.max(256, Math.min(4096, Math.round(h1 / 64) * 64));
        const f = 140 / Math.max(L.w, L.h);
        rect.style.width = Math.max(28, Math.round(L.w * f)) + "px";
        rect.style.height = Math.max(24, Math.round(L.h * f)) + "px";
        rect.textContent = `${eff(L.w)} × ${eff(L.h)}`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        writeCfg(node); render(node);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
  stage.appendChild(rect);

  const chips = document.createElement("div");
  chips.className = "rn-ws-latchips";
  for (const [label, w, h] of LATENT_PRESETS) {
    const chip = document.createElement("div");
    chip.className = "rn-ws-latchip" + (!L.random && L.w === w && L.h === h ? " cur" : "");
    chip.title = label;
    const mini = document.createElement("i");
    const mfit = 22 / Math.max(w, h);
    mini.style.width = Math.max(6, Math.round(w * mfit)) + "px";
    mini.style.height = Math.max(6, Math.round(h * mfit)) + "px";
    chip.appendChild(mini);
    chip.onclick = () => {
      L.w = w; L.h = h; L.random = false;
      writeCfg(node); render(node);
    };
    chips.appendChild(chip);
  }
  const dice = document.createElement("div");
  dice.className = "rn-ws-latchip" + (L.random ? " cur" : "");
  dice.title = L.random
    ? "Random is on: one of these presets is rolled fresh each queue. Click to stop."
    : "Roll a random preset size on every queue.";
  dice.textContent = "🎲";
  dice.onclick = () => { L.random = !L.random; writeCfg(node); render(node); };
  chips.appendChild(dice);

  vrow.append(stage, chips);
  body.appendChild(vrow);
  if (L.random && node._rnPicks?.latent) {
    const rolled = document.createElement("div");
    rolled.className = "rn-ws-note";
    rolled.textContent = `last roll: ${node._rnPicks.latent}`;
    body.appendChild(rolled);
  }

  const srow = document.createElement("div");
  srow.className = "rn-ws-row";
  const slab = document.createElement("span");
  slab.className = "rn-ws-note";
  slab.textContent = "Scale";
  const sr = document.createElement("input");
  sr.type = "range";
  sr.min = 1; sr.max = 2; sr.step = 0.05;
  sr.value = L.scale;
  sr.style.cssText = "width:140px;accent-color:#4a8fe0";
  const sv = document.createElement("span");
  sv.className = "rn-ws-note";
  const svText = () => `${Number(L.scale).toFixed(2)}x = ${eff(L.w)} x ${eff(L.h)}`;
  sv.textContent = svText();
  sr.title = "Multiplies the canvas. 1 is the base size, 2 doubles both edges, which is "
           + "four times the pixels (and the VRAM to match). Snaps to 8.";
  sr.addEventListener("input", () => {
    L.scale = parseFloat(sr.value);
    sv.textContent = svText();
    rect.textContent = L.random ? "?" : `${eff(L.w)} × ${eff(L.h)}`;
    writeCfg(node);
  });
  srow.append(slab, sr, sv);
  body.appendChild(srow);

  const drow = document.createElement("div");
  drow.className = "rn-ws-row";
  const num = (label, key, min, max) => {
    const wl = document.createElement("span");
    wl.className = "rn-ws-note";
    wl.textContent = label;
    const i = document.createElement("input");
    i.type = "number";
    i.min = min; i.max = max; i.step = 64;
    i.value = L[key];
    i.style.cssText = "width:82px;background:#15171b;border:1px solid #33373d;border-radius:4px;"
                    + "color:#e8ecf1;font-size:12px;padding:4px 6px";
    i.addEventListener("change", () => {
      const v = Math.max(min, Math.min(max, Math.round((parseInt(i.value, 10) || min) / 8) * 8));
      L[key] = v; i.value = v;
      writeCfg(node); render(node);
    });
    return [wl, i];
  };
  const swap = document.createElement("button");
  swap.className = "rn-ws-btn";
  swap.textContent = "⇄";
  swap.title = "Swap width and height.";
  swap.onclick = () => { const w = L.w; L.w = L.h; L.h = w; writeCfg(node); render(node); };
  drow.append(...num("Width", "w", 256, 4096), ...num("Height", "h", 256, 4096), swap,
              ...num("Batch", "batch", 1, 64));
  body.appendChild(drow);

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
  body.appendChild(note);
}

// The built-in Prompt Converter, on the Img2Img tab: the standalone node's pipeline
// applied to the i2i prompt, with the moodboard as the style authority.
// Img2Img pass mode: real i2i (encoded source + denoise) or prompt only (the Latent
// tab's canvas takes over and the source just donates its description)
function i2iPassRow(node, body, tabName) {
  if (tabName !== "i2i") return;
  const t = node._rnCfg.tabs.i2i;
  const row = document.createElement("div");
  row.className = "rn-ws-row";
  const lab = document.createElement("span");
  lab.className = "rn-ws-note";
  lab.textContent = "Pass";
  const b = document.createElement("button");
  b.className = "rn-ws-on" + (t.prompt_only ? "" : " on");
  b.style.width = "auto";
  b.style.padding = "0 10px";
  b.textContent = t.prompt_only ? "Prompt only (Latent tab canvas)" : "Image to image";
  b.title = t.prompt_only
    ? "The source only donates its prompt, and the canvas comes from the Latent "
      + "tab. Click for a real image to image pass, which paints onto the source "
      + "itself and takes over output_latent."
    : "output_latent is the source image ENCODED (wire the vae input), and the denoise "
      + "socket carries the strength below. This BEATS the Latent tab: an image to "
      + "image pass paints onto your picture, not a blank canvas. Click for prompt "
      + "only instead.";
  b.onclick = () => { t.prompt_only = !t.prompt_only; writeCfg(node); render(node); };
  row.append(lab, b);

  if (!t.prompt_only) {
    const dlab = document.createElement("span");
    dlab.className = "rn-ws-note";
    dlab.textContent = "Denoise";
    const dr = document.createElement("input");
    dr.type = "range";
    dr.min = 0; dr.max = 1; dr.step = 0.05;
    dr.value = t.denoise;
    dr.style.cssText = "width:110px;accent-color:#b8283c";
    const dv = document.createElement("span");
    dv.className = "rn-ws-note";
    dv.textContent = Number(t.denoise).toFixed(2);
    dr.title = "How much the sampler repaints the source. 0.5 keeps composition, 0.75 "
             + "reworks it. Rides the denoise output socket.";
    dr.addEventListener("input", () => {
      t.denoise = snapStep(dr.value, 0, 1, 0.01);
      dv.textContent = Number(t.denoise).toFixed(2);
      writeCfg(node);
    });
    row.append(dlab, dr, dv);

    // the i2i pass gets its own size, separate from the global resize
    const slab = document.createElement("span");
    slab.className = "rn-ws-note";
    slab.textContent = "Scale";
    const sr = document.createElement("input");
    sr.type = "range";
    sr.min = 0.25; sr.max = 3; sr.step = 0.05;
    sr.value = t.scale;
    sr.style.cssText = "width:130px;height:18px;accent-color:#4a8fe0";
    const sv = document.createElement("span");
    sv.className = "rn-ws-note";
    const svText = () => `${Number(t.scale).toFixed(2)}x`;
    sv.textContent = svText();
    sr.title = "Scales the source before it is encoded, so an image to image pass can "
             + "come out bigger or smaller than the resize dropdown at the bottom "
             + "without moving that for every other tab. 1 keeps the resized size; 2 "
             + "doubles both edges and costs four times the pixels.";
    sr.addEventListener("input", () => {
      t.scale = snapStep(sr.value, 0.25, 3, 0.05);
      sv.textContent = svText();
      writeCfg(node);
    });
    row.append(slab, sr, sv);
  }
  body.appendChild(row);
}

function converterSection(node, body, tabName) {
  if (!CONVERTER_TABS.includes(tabName)) return;
  const cfg = node._rnCfg;
  const c = cfg.tabs[tabName].conv;
  const open = !!(node._rnConvOpen ||= {})[tabName];
  const active = c.gender !== "off" || c.style !== "off" || c.act !== "off"
    || c.remove_cum || c.shave || c.rules.trim() || c.lock;

  const sect = document.createElement("div");
  sect.className = "rn-ws-sect rn-ws-conv";
  const head = document.createElement("div");
  head.className = "head";
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.textContent = open ? "▾" : "▸";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = "PROMPT CONVERTER" + (active ? "" : ": all off");
  head.append(arr, ttl);
  head.onclick = () => { node._rnConvOpen[tabName] = !open; render(node); };
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
        o.textContent = v;
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
      b.className = "rn-ws-on" + (c[key] ? " on" : "");
      b.textContent = c[key] ? "ON" : "OFF";
      b.title = hint;
      b.onclick = () => { c[key] = !c[key]; writeCfg(node); render(node); };
      w.append(t, b);
      return w;
    };
    sect.append(
      sel("gender swap", "gender", lists.gender, "Whole-word, case-preserving gender swap."),
      sel("style convert", "style", lists.style,
          "Medium vocabulary between photography and anime terms."),
      sel("nsfw act", "act", lists.act, "Rewrite act terms to the chosen one."),
      boolB("remove cum terms", "remove_cum", "Strip cum, ejaculation, semen, sperm."),
      boolB("shave pubic", "shave", "Rewrite pubic hair mentions to shaved."),
      boolB("mood owns the style", "lock",
            "Strip style words the moodboard prompt does not itself use, so this tab's "
            + "image cannot smuggle its own style past the mood."),
      boolB("mood owns the lighting", "lock_lighting",
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
function dialSection(node, body, tabId) {
  const cfg = node._rnCfg;
  const dials = DIALS.filter((d) => d.tab === tabId);
  if (!dials.length) return;
  const opened = (node._rnDialsOpen ||= {})[tabId];
  const open = opened !== undefined ? !!opened : tabId === "advanced";

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
  on.className = "rn-ws-on" + (cfg.use_dials ? " on" : "");
  on.textContent = cfg.use_dials ? "ON" : "OFF";
  on.title = cfg.use_dials
    ? "Every dial on every tab goes out as the settings. The studio needs preset 'custom (use settings)'."
    : "Off: the settings output is empty and the studio's preset stays in charge.";
  on.onclick = (e) => { e.stopPropagation(); cfg.use_dials = !cfg.use_dials; writeCfg(node); render(node); };
  head.append(arr, on, ttl);        // toggle in front of the title, see the masks head
  head.onclick = (e) => {
    if (e.target === on) return;
    node._rnDialsOpen[tabId] = !open;
    render(node);
  };
  if (tabId === "advanced") ttl.textContent = "STUDIO SETTINGS" +
    (touched ? `: ${touched} set` : ": all at defaults");
  sect.appendChild(head);

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
        sw.className = "rn-ws-on" + (cur ? " on" : "");
        sw.textContent = cur ? "ON" : "OFF";
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
  id === "people" ? (cfg.tabs.subject2.on && cfg.tabs.subject2.images.length) ||
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
  : id === "advanced" ? cfg.use_dials &&
      DIALS.some((d) => d.tab === "advanced" && cfg.dials[d.key] !== undefined)
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
  restoreFolds(node);
  const hidden = hiddenTabSet();
  const tabsShown = TAB_ORDER.filter((t) => t.id === "advanced"
    || t.id === node._rnTab || !hidden.has(t.id));
  const fallbackTab = !hidden.has("subject") ? "subject"
    : (TAB_ORDER.find((t) => !hidden.has(t.id))?.id || "advanced");
  const cur = TAB_ORDER.some((t) => t.id === node._rnTab) ? node._rnTab : fallbackTab;
  // Most controls still rebuild this body today. Keep the outgoing tab's position in
  // the one rebuild funnel so no button can forget it; a different tab starts clean.
  const previousBody = node._rnBodyEl;
  const previousBodyTab = node._rnBodyTab;
  const previousScroll = previousBodyTab === cur ? Number(previousBody?.scrollTop || 0) : 0;
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
  tabs.appendChild(tuck);
  host.appendChild(tabs);

  const body = document.createElement("div");
  body.className = "rn-ws-body";
  if (cur === "people") peopleBody(node, body);
  else if (cur === "latent") latentBody(node, body);
  else if (cur === "masks") masksBody(node, body);
  else if (cur === "post") postBody(node, body);
  else if (cur === "paint") paintBody(node, body);
  else if (cur === "loras") lorasBody(node, body);
  else if (cur === "advanced") advancedTools(node, body);
  else galleryBody(node, body, cur, IMAGE_TABS[cur], { multi: cur === "moodboard" });
  // Section order, the same on every tab: what the tab DOES (its dials), then how
  // its prompt is made, then how that prompt is reworked. The converter reads the
  // auto prompt's output, so it reads top to bottom in the order it runs.
  i2iPassRow(node, body, cur);                     // i2i: real pass or prompt only
  dialSection(node, body, cur);                    // each tab carries its own dials
  if (cur !== "paint") {
    autoSection(node, body, cur);                  // captions for this tab's image
  }
  converterSection(node, body, cur);               // the built-in Prompt Converter
  host.appendChild(body);
  node._rnBodyEl = body;
  node._rnBodyTab = cur;
  if (previousBody && previousBodyTab === cur) {
    body.scrollTop = previousScroll;
    // The rebuilt body may not be able to HOLD the restored offset yet: canvases get
    // their height on image load, so scrollHeight is briefly small and the browser
    // clamps the write toward zero. Record what was wanted; the paint image's ready
    // path re-applies it once, when the layout can carry it.
    if (previousScroll && Number(body.scrollTop || 0) !== previousScroll) {
      // remember WHERE the clamp landed, not just that it did: a body tall enough
      // for 200 of the 400 wanted clamps to 200, and a payer that only fires from
      // exactly 0 would drop that restore on the floor
      node._rnScrollOwed = { tab: cur, top: previousScroll,
                             clamped: Number(body.scrollTop || 0) };
    } else {
      delete node._rnScrollOwed;
    }
  } else {
    delete node._rnScrollOwed;
  }

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
  const resLab = document.createElement("span");
  resLab.className = "rn-ws-note";
  resLab.textContent = "Resize long edge to";
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

  const cog = document.createElement("button");
  cog.className = "rn-ws-cog";
  cog.textContent = "⚙";
  cog.title = "Save or delete workspace presets.";
  cog.onclick = () => openCog(node, cog);
  foot.append(resLab, res, presetLab, psel, tierBtn, cog);
  // INSIDE the host, not on the wrap. The host carries the UI zoom, and a sibling
  // placed after a zoomed flex item is laid out against the UNZOOMED height, so at any
  // scale above 1 the foot rendered part-way up the panel, floating over the effect
  // cards. In the zoomed flow it sits where the eye expects, at the end, and it scales
  // with the controls it belongs to.
  foot.style.zoom = Math.abs((cfg.ui_scale || 1) - 1) < 0.001
    ? "" : String(1 / cfg.ui_scale);
  host.appendChild(foot);

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
// Shipped premades plus the user's saved ones, fetched once and after every change.
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
      const imgs = e?.detail?.output?.images;
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
