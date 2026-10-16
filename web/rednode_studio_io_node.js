// RedNode Studio Inputs / Outputs, the node: the Workspace picker, the Workspace node's own
// sockets hidden, and the lookups the Workspace panel uses for its warnings. The splice
// that joins the two at queue time is the pure half, rednode_studio_io.js, run from the
// graphToPrompt hook in rednode_subgraph_bridge.js.
import { app } from "../../scripts/app.js";
import { allNodes, findNodes } from "./rednode_graph.js";
import { IO, WS, ONLY, NAMES } from "./rednode_studio_io.js";

/** Every Workspace on the canvas, root graph and subgraphs, as picker entries. */
export function workspaceChoices() {
  const out = [ONLY];
  for (const n of findNodes(WS)) out.push(`#${n.id} ${n.title || "Workspace"}`);
  return out;
}

/** The Workspace an IO node stands in for, or null. */
export function workspaceOf(io) {
  const w = (io.widgets || []).find((x) => x.name === "workspace");
  const pick = String(w?.value ?? ONLY).trim();
  const all = findNodes(WS);
  const m = /^#(\S+)/.exec(pick);
  if (m) return all.find((n) => String(n.id) === m[1]) || null;
  return all.length === 1 ? all[0] : null;
}

/** The IO nodes that stand in for this Workspace. */
export function ioNodesFor(wsNode) {
  return findNodes(IO).filter((io) => workspaceOf(io) === wsNode);
}

function titleFor(io) {
  const ws = workspaceOf(io);
  io.title = ws ? `Studio I/O: ${ws.title || "Workspace"}` : "Studio I/O: choose a Workspace";
}

/** Drop any socket a saved workflow restored onto the Workspace node; the node shows none. */
function stripWorkspaceSockets(node) {
  const dropped = [];
  for (let i = (node.outputs || []).length - 1; i >= 0; i--) {
    const o = node.outputs[i];
    if ((o.links || []).length) dropped.push(o.name);
    try { node.disconnectOutput?.(i); } catch (e) { /* no links */ }
    node.outputs.splice(i, 1);
  }
  for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
    const s = node.inputs[i];
    // the frontend's own widget socket for config stays only while it is wired
    if (s.name === "config" && s.link != null) continue;
    if (s.link != null) dropped.push(s.name);
    try { node.disconnectInput?.(i); } catch (e) { /* no link */ }
    node.inputs.splice(i, 1);
  }
  if (dropped.length) {
    console.warn(`[RedNode Workspace] since 1.7 the Workspace node carries no sockets; these `
               + `wires were dropped on load: ${dropped.join(", ")}. Add a RedNode Studio `
               + `Inputs / Outputs node, choose this Workspace, and wire from there.`);
  }
  return dropped;
}

app.registerExtension({
  name: "RedNode.StudioIO",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === WS) {
      NAMES.ws = [...(nodeData.output_name || [])];
      // the panel is the node: no socket rows. The server keeps the sockets; the
      // splice puts the wires there.
      nodeData.output = [];
      nodeData.output_name = [];
      nodeData.output_is_list = [];
      nodeData.output_tooltips = [];
      if (nodeData.input) nodeData.input.optional = {};
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        onConfigure?.apply(this, arguments);
        stripWorkspaceSockets(this);
      };
      return;
    }
    if (nodeData?.name !== IO) return;
    NAMES.io = [...(nodeData.output_name || [])];
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      // the workspace widget arrives as a STRING; it becomes a dropdown of the
      // Workspaces on the canvas, read live (values-as-function is LiteGraph's own combo
      // contract). Replaced at the SAME index: widgets_values is positional.
      const i = (this.widgets || []).findIndex((w) => w.name === "workspace");
      if (i < 0) return;
      const prev = this.widgets[i].value || ONLY;
      const tip = this.widgets[i].options?.tooltip;
      this.widgets.splice(i, 1);
      const combo = this.addWidget("combo", "workspace", prev,
                                   () => { titleFor(this); this.setDirtyCanvas?.(true, true); },
                                   { values: workspaceChoices });
      if (tip) combo.options.tooltip = tip;
      const at = this.widgets.indexOf(combo);
      if (at !== i) { this.widgets.splice(at, 1); this.widgets.splice(i, 0, combo); }
      titleFor(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      titleFor(this);
    };
  },
  // a Workspace renamed or added after this node: the title follows
  async afterConfigureGraph() {
    for (const n of allNodes()) if (n?.type === IO) titleFor(n);
  },
});
