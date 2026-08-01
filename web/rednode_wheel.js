// Wheel over a slider ADJUSTS IT, instead of scrolling the panel past it.
//
// The paint tool's brush size did this first and it read so much better than dragging a
// 140px slider that it belongs on every slider in the pack. One DELEGATED handler per
// panel root covers all of them: wheel events bubble, so a single listener on the wrap
// catches all 22 sliders without touching a single slider's own code.
//
// The step is a RATIO of each slider's own range, never a fixed number. Feather is
// 0-64, CFG is 1-30 in tenths and UI scale is 0.6-1.6 in twentieths: a fixed step is
// either useless or violent depending on which one you land on. A ratio gives them all
// the same feel whatever units they happen to be in.
import { wsPref } from "./rednode_settings.js";

// A mouse wheel has 18-24 detents in a full turn, so one comfortable thumb stroke of a
// third to a half of a turn is about 9 clicks. Four to five of those strokes to cross a
// slider is ~40 clicks, which is this default: about 2.5% of a slider's range per click.
export const SLIDER_NOTCHES = 40;
// How long a gesture that began on the panel keeps owning the wheel, in ms. Without
// this, scrolling down a long tab silently edits every slider it passes over, which is
// the one way this feature could do real damage.
export const SCROLL_HOLD = 220;

// SPACE held = fine adjust, exactly one of the slider's own steps per click. Tracked
// rather than read off the wheel event because a wheel event carries no space state.
// Only ever READ while the pointer is over a slider, so it never interferes with
// space anywhere else, typing included.
let spaceHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.key === " ") spaceHeld = true;
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" || e.key === " ") spaceHeld = false;
  }, true);
  // a lost window never sends the keyup, and a stuck fine mode is invisible
  window.addEventListener("blur", () => { spaceHeld = false; });
}

/** Clicks needed to cross a slider, from the per-install setting. */
export function wheelNotches() {
  const n = Number(wsPref("SliderWheelNotches", SLIDER_NOTCHES));
  return Number.isFinite(n) && n >= 4 ? n : SLIDER_NOTCHES;
}

/** The value one wheel click moves `el`, snapped to its own step and never below it. */
export function wheelStep(el, fine = false) {
  const min = Number(el.min === "" ? 0 : el.min);
  const max = Number(el.max === "" ? 100 : el.max);
  const step = Number(el.step) || 1;          // step="any" reads NaN, treat it as 1
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return 0;
  if (fine) return step;
  const raw = (max - min) / wheelNotches();
  // land on the slider's own grid, and never propose a move it cannot make
  return Math.max(step, Math.round(raw / step) * step);
}

/** Apply one click to `el`. Returns true when the value actually moved. */
export function wheelApply(el, dir, fine = false) {
  const min = Number(el.min === "" ? 0 : el.min);
  const max = Number(el.max === "" ? 100 : el.max);
  const step = Number(el.step) || 1;
  const delta = wheelStep(el, fine);
  if (!delta) return false;
  const cur = Number(el.value);
  if (!Number.isFinite(cur)) return false;
  let next = min + Math.round((cur + dir * delta - min) / step) * step;
  next = Math.max(min, Math.min(max, next));
  // 0.05 steps otherwise land on 1.0500000000000003 and show it
  const dp = (String(step).split(".")[1] || "").length;
  next = Number(next.toFixed(dp));
  if (next === cur) return false;
  el.value = String(next);
  // what a real drag sends: the panels bind `input`, and `change` matches a mouse-up
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Give every slider under `root` wheel control. Safe to call more than once per root.
 */
export function bindSliderWheel(root) {
  if (!root || root._rnSliderWheel) return;
  root._rnSliderWheel = true;
  let lastPanelScroll = 0;
  root.addEventListener("wheel", (e) => {
    // shift+wheel is the canvas zoom everywhere in the pack, sliders included
    if (e.shiftKey) return;
    const el = e.target?.closest?.('input[type="range"]');
    if (!el || el.disabled) {
      lastPanelScroll = Date.now();      // this gesture belongs to the panel
      return;
    }
    // a gesture already scrolling the panel keeps it, so passing over a slider on the
    // way down a long tab cannot quietly change it
    if (Date.now() - lastPanelScroll < SCROLL_HOLD) return;
    // the slider owns this gesture now, so the panel must not also scroll, even at the
    // end of the track where the value has nowhere left to go
    e.preventDefault();
    e.stopPropagation();
    wheelApply(el, e.deltaY < 0 ? 1 : -1, spaceHeld);
  }, { passive: false });
}
