import { app } from "../../scripts/app.js";

// Which nodes you just dropped in, so panels can put them where you will find them.
//
// The problem this solves: you add a node, go to the Control Panel to drive one of its
// dropdowns, and its entries are somewhere in a list of two hundred, sorted by nothing
// you remember. You know exactly which node you want and the list is the last place
// that knows. Same reason the LoRA picker floats new files to the top.
//
// LOADING A WORKFLOW IS NOT ADDING NODES. Every node in a saved workflow arrives through
// the same onNodeAdded, so without this the whole graph would be "new" every time you
// opened it, which is the same as nothing being new. ComfyUI brackets a load with
// beforeConfigureGraph and afterConfigureGraph, so additions inside that bracket are
// ignored. The opening restore is covered by a short settling window as well, in case
// an older frontend does not fire those hooks.
//
// Nothing is written to the workflow. This is a fact about your session, not about the
// graph: reopening a file tomorrow should not claim its nodes are new, and a saved
// workflow should not carry timestamps that mean nothing to whoever opens it next.

/** A node stays "new" for this long after you add it. */
export const NEW_FOR = 15 * 60 * 1000;

/** Keyed by the node OBJECT, not its id: ids repeat across subgraphs, and a WeakMap
 *  also lets a deleted node fall out of memory on its own. */
const addedAt = new WeakMap();

let loading = 0;
let settled = false;

/** When this node was added this session, or 0 for "it was already here". */
export function addedTime(node) {
  return (node && addedAt.get(node)) || 0;
}

/** Still worth flagging? */
export function isNew(node) {
  const t = addedTime(node);
  return !!t && Date.now() - t < NEW_FOR;
}

/** "NEW", or "NEW 12m" once it has been a while. Null when it is not new. */
export function newBadge(node) {
  const t = addedTime(node);
  if (!t) return null;
  const age = Date.now() - t;
  if (age >= NEW_FOR) return null;
  const mins = Math.floor(age / 60000);
  return mins < 1 ? "NEW" : `NEW ${mins}m`;
}

/** Newest first, then whatever order they were already in. Stable, so an equal pair
 *  keeps the caller's ordering rather than being shuffled. */
export function newestFirst(items, nodeOf) {
  return items
    .map((x, i) => ({ x, i, t: addedTime(nodeOf(x)) }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((e) => e.x);
}

app.registerExtension({
  name: "RedNode.Recent",
  beforeConfigureGraph() { loading++; },
  afterConfigureGraph() { loading = Math.max(0, loading - 1); },
  async setup() {
    // the workflow restored at startup arrives around now; give it a moment to land
    // before anything counts as something you did
    setTimeout(() => { settled = true; }, 2500);

    const hook = (graph) => {
      if (!graph || graph.__rnRecent) return;
      graph.__rnRecent = true;
      const prev = graph.onNodeAdded;
      graph.onNodeAdded = function (node) {
        if (settled && !loading && node) addedAt.set(node, Date.now());
        // a subgraph's inner graph is its own LGraph with its own onNodeAdded
        if (node?.subgraph) hook(node.subgraph);
        return prev?.apply(this, arguments);
      };
      for (const n of graph._nodes || []) if (n?.subgraph) hook(n.subgraph);
    };
    hook(app.graph);
    // opening another workflow replaces app.graph, so re-hook after every load
    const orig = app.loadGraphData;
    if (typeof orig === "function") {
      app.loadGraphData = function (...args) {
        const r = orig.apply(this, args);
        Promise.resolve(r).then(() => hook(app.graph)).catch(() => {});
        return r;
      };
    }
  },
});
