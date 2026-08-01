import { app } from "../../scripts/app.js";

// "Add RedNode" on the canvas right-click, the way the Get/Set packs do it. One entry,
// a submenu of the nodes people actually reach for, and the new node lands where the
// mouse was. The full set stays in the Add Node dialog under RedNode/.
//
// LiteGraph.ContextMenu is right HERE, because this is the canvas's own native menu.
// Inside a DOM panel it is banned (it draws at canvas scale), which is a different
// place with a different rule.

const QUICK = [
  ["RedNode Studio Workspace", "RedNodeStudioWorkspace"],
  ["RedNode Save", "RedNodeSave"],
  ["RedNode Image Review", "RedNodeImageReview"],
  ["RedNode Sender", "RedNodeSubgraphSend"],
  ["RedNode Grabber", "RedNodeSubgraphReceive"],
  ["RedNode Paint Render", "RedNodePaintRender"],
  ["RedNode Paint Out", "RedNodePaintOut"],
  ["RedNode Paint In", "RedNodePaintIn"],
  ["RedNode Post FX", "RedNodePostFX"],
  ["RedNode Prompt Box", "RedNodePromptBox"],
  ["RedNode LoRA Stack", "RedNodeLoraStack"],
  ["RedNode Control Panel", "RedNodeControlPanel"],
  ["RedNode Group Control", "RedNodeGroupControl"],
  ["RedNode Group Modes", "RedNodeGroupModes"],
  ["RedNode Palette", "RedNodePalette"],
  ["RedNode Router", "RedNodeRouter"],
  ["RedNode Router Control", "RedNodeRouterControl"],
];

app.registerExtension({
  name: "RedNode.CanvasMenu",
  async setup() {
    const LGraphCanvas = window.LGraphCanvas || globalThis.LiteGraph?.LGraphCanvas;
    const LiteGraph = globalThis.LiteGraph;
    if (!LGraphCanvas?.prototype?.getCanvasMenuOptions || !LiteGraph) return;
    const orig = LGraphCanvas.prototype.getCanvasMenuOptions;
    LGraphCanvas.prototype.getCanvasMenuOptions = function (...args) {
      const options = orig.apply(this, args) || [];
      const canvas = this;
      options.push(null, {
        content: "Add RedNode",
        has_submenu: true,
        callback: (value, opts, e, menu) => {
          // only offer what this install actually registered, so a menu entry can
          // never create a missing-node placeholder
          const here = QUICK.filter(([, type]) => LiteGraph.registered_node_types?.[type]);
          new LiteGraph.ContextMenu(here.map(([label]) => label), {
            event: e,
            parentMenu: menu,
            callback: (label) => {
              const entry = here.find(([l]) => l === label);
              if (!entry) return;
              const node = LiteGraph.createNode(entry[1]);
              if (!node) return;
              node.pos = canvas.graph_mouse ? [...canvas.graph_mouse]
                       : canvas.convertEventToCanvasOffset?.(e) || [100, 100];
              (canvas.graph || app.graph)?.add(node);
            },
          });
        },
      });
      return options;
    };
  },
});
