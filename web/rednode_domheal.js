import { app } from "../../scripts/app.js";

// A NUDGE, not a fix, and it is worth being honest about which.
//
// Reported: open ComfyUI's own properties sidebar, click a node, drag it, and every
// custom node's DOM panel in the graph lands in the wrong place or at the wrong
// scale. It then STAYS wrong after the sidebar closes. Confirmed against frontend
// 1.47.11 and backend v0.29.2, both current, so it is not a stale build.
//
// It is not this pack's bug. In this frontend, a DOM widget's position and scale come
// from ComfyUI's own reactive `domWidget` store (pos, size, zIndex, visible, active),
// rendered by their component. Nothing here computes a position, which is also why
// every unrelated pack breaks the same way at the same moment. The one lever a plugin
// has is to make their side recompute.
//
// So: when the canvas element's own size changes, which is exactly what their sidebar
// opening and closing does, ask every RedNode panel node to re-measure and ask the
// canvas for a full redraw. If the bad state is a layout their store simply never
// recomputed, this clears it. If their stored value is itself wrong, this cannot help,
// and the honest answer is an upstream report rather than a deeper hack here.
//
// Deliberately cheap and idempotent: a resize is rare, the work is a size write and a
// dirty flag, and it must never fight the user or fire during a drag.

const PANEL_WIDGETS = ["rednode_workspace_ui", "rednode_control_ui",
                       "rednode_channel_ui", "rednode_lora_ui", "rednode_group_ui"];

/** Every node in the graph and its subgraphs, since panels live in both. */
function everyNode(graph, seen = new Set(), out = []) {
  if (!graph || seen.has(graph)) return out;
  seen.add(graph);
  for (const n of graph._nodes || graph.nodes || []) {
    out.push(n);
    if (n?.subgraph) everyNode(n.subgraph, seen, out);
  }
  return out;
}

/** Does this node carry one of our DOM panels? */
function isPanelNode(node) {
  return (node?.widgets || []).some((w) => PANEL_WIDGETS.includes(w?.name));
}

function healPanels() {
  let touched = 0;
  try {
    for (const node of everyNode(app.graph)) {
      if (!isPanelNode(node)) continue;
      // setSize with the size it already has is the smallest thing that makes
      // litegraph and the widget store agree again: it runs onResize, which is what
      // recomputes a DOM widget's box, without changing anything the user chose.
      try { node.setSize?.(node.size); } catch (e) { /* a half-built node, skip it */ }
      node.setDirtyCanvas?.(true, true);
      touched++;
    }
    if (touched) app.canvas?.setDirty?.(true, true);
  } catch (e) {
    // never let a heal attempt break the canvas it is trying to rescue
    console.debug?.("[RedNode] panel heal skipped:", e);
  }
  return touched;
}

app.registerExtension({
  name: "RedNode.DomWidgetHeal",
  async setup() {
    const canvasEl = app.canvasEl || app.canvas?.canvas
      || document.querySelector("canvas#graph-canvas");
    if (!canvasEl || typeof ResizeObserver !== "function") return;

    // COALESCED to one frame. Opening a sidebar animates its width, so the observer
    // fires many times in a row; healing on every one of those would write node sizes
    // dozens of times a second for the length of the animation.
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        // NOT while a drag is in flight: litegraph is mid-gesture and writing a node
        // size underneath it is how a nudge turns into a jump under the pointer.
        if (app.canvas?.node_dragged || app.canvas?.pointer?.isDown) {
          schedule();          // try again on the next frame, once the hand is off
          return;
        }
        healPanels();
      });
    };

    let last = canvasEl.clientWidth;
    new ResizeObserver(() => {
      // width is the axis a side panel moves; a height-only change is the browser
      // window and their store handles that one correctly today
      if (canvasEl.clientWidth === last) return;
      last = canvasEl.clientWidth;
      schedule();
    }).observe(canvasEl);
  },
});
