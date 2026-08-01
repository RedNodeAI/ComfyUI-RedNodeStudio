// Arrow keys for the viewer panels.
//
// A canvas node cannot take keyboard focus the way a form control does, and stealing
// focus would break typing in every prompt box on the graph. So the rule is the one
// people already expect from a photo viewer: the panel your pointer is over is the
// panel the arrows drive. Move the mouse away and the keys go back to ComfyUI.
//
// Nothing is captured unless a handler is actually registered for the panel under the
// pointer, and never while a text field has focus.

const panels = new Map();          // element -> handler(direction)
let hovered = null;

function typing() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

// left/right and up/down both work: which axis feels natural depends on whether the
// panel is showing a row of stages or a stack of runs, and guessing wrong is annoying
const KEYS = {
  ArrowLeft: -1, ArrowUp: -1, PageUp: -1,
  ArrowRight: 1, ArrowDown: 1, PageDown: 1,
};

// ---------------------------------------------------------------- panel hotkeys
// The same idea as the arrows, for combinations that OVERRIDE something ComfyUI already
// binds. Ctrl+Enter is the case this exists for: on the Paint tab it should render the
// painted region, which is one crop-sized sample, and everywhere else it must stay
// ComfyUI's own queue-the-whole-workflow.
//
// Registered per element and matched by walking UP from whatever the pointer is really
// over, so a hotkey on the panel works over every control inside it. The arrows use
// exact-match hover instead, because there the target IS the panel.
const hotkeys = new Map();          // element -> Map(combo -> handler)
let lastOver = null;

// ---------------------------------------------------------------- panel paste
// Ctrl+V cannot go through panelHotkey. A keydown carries no clipboard, and reading it
// afterwards means navigator.clipboard.read(), which prompts for permission and returns
// nothing until the user agrees. The browser's own paste event arrives with the data
// already attached and asks nobody, so this mirrors the same hover matching for `paste`.
//
// STOPPING THE EVENT IS THE POINT, not a detail: ComfyUI reacts to a pasted image by
// creating a LoadImage node on the graph. Without this, one press would take the picture
// AND litter the canvas with a node nobody asked for.
const pastes = new WeakMap();       // element -> handler(event)

function findPaste() {
  for (let n = lastOver; n; n = up(n)) {
    const found = pastes.get(n);
    if (found) return found;
  }
  return null;
}

const up = (n) => (n && (n.parentElement || n.parentNode || n._parent)) || null;

function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  const k = String(e.key || "");
  parts.push(k.length === 1 ? k.toLowerCase() : k);
  return parts.join("+");
}

function findHotkey(combo) {
  for (let n = lastOver; n; n = up(n)) {
    const found = hotkeys.get(n)?.get(combo);
    if (found) return found;
  }
  return null;
}

let wired = false;
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("pointerover", (e) => { lastOver = e.target; }, true);
  // WINDOW, CAPTURE PHASE, and both halves matter. Window is the first stop on the
  // capture path, so stopping here beats any listener bound on document or below,
  // whichever registered first. If ComfyUI ever moves its own shortcut to window
  // capture and registers before this file loads, one press would fire both and queue
  // the whole workflow as well; that would need its keybinding API instead of this.
  window.addEventListener("keydown", (e) => {
    // A modified combination is allowed to fire WHILE TYPING, deliberately: typing a
    // paint prompt and pressing Ctrl+Enter is the whole gesture, and plain Enter still
    // has to insert a newline. An unmodified hotkey never steals from a text field.
    const combo = comboOf(e);
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (mod || !typing()) {
      const hit = findHotkey(combo);
      if (hit) {
        // A HANDLER MAY DECLINE by returning false, and then the key carries on to
        // ComfyUI untouched. Registration is per panel, but a panel has tabs: binding
        // Ctrl+Enter for the Paint tab must not swallow it on the LoRAs tab, where it
        // still means queue the workflow. Deciding inside the handler beats
        // registering and unregistering as tabs change, which is the version of this
        // that leaks entries and forgets one path.
        if (hit(e) === false) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        return;
      }
    }
    if (!hovered || typing()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = KEYS[e.key];
    const handler = panels.get(hovered);
    if (!handler) return;
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation();
    handler(e.key === "Home" ? "first" : e.key === "End" ? "last" : step);
  }, true);

  // Window capture for the same reason the keydown uses it: whoever else is listening,
  // this decides first.
  window.addEventListener("paste", (e) => {
    // NEVER while a text field has focus. Pasting text into a prompt box is the common
    // case by far, and stealing that would be a worse bug than the missing feature.
    if (typing()) return;
    const hit = findPaste();
    if (!hit) return;
    if (hit(e) === false) return;      // declined, so ComfyUI still gets the paste
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  }, true);
}

/**
 * Run `handler` for `combo` while the pointer is anywhere over `el`.
 *
 * `combo` is lower-case parts joined by "+", modifiers first in the order
 * ctrl, shift, alt: "ctrl+Enter", "ctrl+shift+z". Meta counts as ctrl, so a Mac
 * needs no second registration.
 *
 * Return false from `handler` to decline the press: the key is then passed on to
 * ComfyUI as if nothing were bound, which is how one registration covers a panel
 * whose tabs do not all want the binding.
 */
export function panelHotkey(el, combo, handler) {
  if (!el || typeof handler !== "function" || !combo) return;
  wire();
  if (!hotkeys.has(el)) hotkeys.set(el, new Map());
  hotkeys.get(el).set(String(combo), handler);
}

export function forgetHotkeys(el) {
  hotkeys.delete(el);
  if (lastOver === el) lastOver = null;
}

/**
 * Handle a clipboard paste while the pointer is anywhere over `el`.
 *
 * The handler receives the ClipboardEvent. Return false to decline, which passes the
 * paste on to ComfyUI untouched: that is how one registration can cover a panel where
 * only some tabs want it, and how a text-only clipboard still reaches the graph.
 */
export function panelPaste(el, handler) {
  if (!el || typeof handler !== "function") return;
  wire();
  pastes.set(el, handler);
}

export function forgetPaste(el) {
  pastes.delete(el);
}

/** Drive `el`'s panel with the arrow keys while the pointer is over it. */
export function arrowKeys(el, handler) {
  if (!el || typeof handler !== "function") return;
  wire();
  panels.set(el, handler);
  el.addEventListener("pointerenter", () => { hovered = el; });
  el.addEventListener("pointerleave", () => { if (hovered === el) hovered = null; });
}

export function forgetArrowKeys(el) {
  panels.delete(el);
  if (hovered === el) hovered = null;
}
