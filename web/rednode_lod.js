import { app } from "../../scripts/app.js";
import { wsPref } from "./rednode_settings.js";

// BLANK OUR PANELS WHEN THEY ARE TOO SMALL TO READ.
//
// ComfyUI drops node detail when the text would render too small (its "Zoom Node Level
// of Detail" setting), which is why a zoomed-out canvas of ordinary nodes stays smooth.
// DOM widgets are not part of that: they are real HTML sitting over the canvas, so a
// panel keeps laying out and painting every row, every slider and every thumbnail at
// any zoom, however illegible it is.
//
// This pack is mostly panels. One Workspace builds around 490 elements, a Control Panel
// of 22 rows carries a range input each, and a big workflow has a dozen more. Zoomed
// out that is thousands of elements being painted to show the user a grey smudge.
//
// So: below a zoom, our panels stop rendering their contents. `content-visibility:
// hidden` is exactly the tool — the browser skips the whole subtree's layout and paint
// while the element keeps its box, so nothing moves and nothing reflows on the way back.
// One class on <body> switches every panel at once, so crossing the threshold costs a
// single class toggle rather than a walk of anything.
//
// Off is a real option (0), because it is a display trade and the user gets to make it.

const PANELS = ["rn-ws-wrap", "rn-cp-wrap", "rn-gc-wrap", "rn-ls-wrap", "rn-pb-wrap",
                "rn-pl-wrap", "rn-ps-wrap", "rn-rc-wrap", "rn-rt-wrap", "rn-rv-wrap",
                "rn-sg-wrap", "rn-sv-wrap", "rn-sw-wrap", "rn-np-wrap"];

const css = document.createElement("style");
css.textContent = `
body.rn-lod ${PANELS.map((c) => `.${c}`).join(", body.rn-lod ")} {
  content-visibility: hidden;
}
`;

let on = null;
const TICK = 250;

function threshold() {
  const v = Number(wsPref("LowZoomHide", 0.55));
  return Number.isFinite(v) ? v : 0.55;
}

function tick() {
  const limit = threshold();
  const scale = Number(app.canvas?.ds?.scale);
  // 0 turns it off, and an unreadable scale is no reason to blank anything
  const want = limit > 0 && Number.isFinite(scale) && scale < limit;
  if (want === on) return;                 // the common case: nothing to do at all
  on = want;
  document.body?.classList.toggle("rn-lod", want);
}

app.registerExtension({
  name: "RedNode.LevelOfDetail",
  async setup() {
    if (document.head && !css.isConnected) document.head.appendChild(css);
    // reading one number four times a second, and touching the DOM only when the
    // threshold is actually crossed. Cheaper by orders of magnitude than what it saves.
    setInterval(tick, TICK);
    tick();
  },
});
