import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;

// Finding nodes across subgraphs.
//
// app.graph only exposes the TOP level, so `app.graph._nodes.find(...)` quietly
// misses anything the user has tucked inside a subgraph. Every wireless feature in
// this pack depends on finding its partner node, so a flat scan turns "it works"
// into "it silently does nothing" the moment somebody tidies their workflow into
// subgraphs. Always go through here.

export function allNodes(root = app.graph) {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;           // subgraphs can be reused
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      out.push(n);
      // only descend into a REAL subgraph: n.graph points back at the parent
      if (n.subgraph) walk(n.subgraph);
    }
  };
  walk(root);
  return out;
}

// Groups are per-graph too: a group inside a subgraph never shows up in
// app.graph._groups, so collecting them walks the same way the nodes do.
export function allGroups(root = app.graph) {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const g of (graph._groups || graph.groups || [])) out.push(g);
    for (const n of (graph._nodes || graph.nodes || [])) if (n.subgraph) walk(n.subgraph);
  };
  walk(root);
  return out;
}

export const findNodes = (type, root = app.graph) =>
  allNodes(root).filter((n) => n.type === type);

export const findNode = (type, root = app.graph) =>
  allNodes(root).find((n) => n.type === type);

export const nodeById = (id, root = app.graph) =>
  allNodes(root).find((n) => String(n.id) === String(id));
