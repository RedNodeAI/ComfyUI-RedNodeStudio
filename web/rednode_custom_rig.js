import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;

// RedNode Custom Rig, the page half: the links that make it run.
//
// ComfyUI runs a node only when a link in the queued prompt asks for it. A Custom Rig
// has no wire to the Workspace or the Detailer, so on the way to the queue this adds,
// into the prompt only, one link from each Custom Rig a consumer USES this run to that
// consumer, on an input named rn_rig_<id> that the consumer does not declare. ComfyUI
// orders by it and does not validate it, and the consumer ignores the value (the rig is
// read by name from what the node published). Nothing touches the canvas or the saved
// workflow, and a Custom Rig no rig in use names is never linked, so it never runs.

export const CUSTOM_RIG = "RedNodeCustomRig";
const WORKSPACE = "RedNodeStudioWorkspace";
const DETAILERS = new Set(["RedNodeStudioDetailer", "RedNodeStudioAdvanced"]);

const parse = (v) => {
  if (v && typeof v === "object") return v;
  try { const d = JSON.parse(v || "{}"); return d && typeof d === "object" ? d : null; } catch (e) { return null; }
};
const rigNameOf = (r, i) => String(r?.name || "").trim() || `Rig ${i + 1}`;

/** Add the queue-time links to a prompt (mutated). Returns how many were added. */
export function linkCustomRigs(output) {
  if (!output || typeof output !== "object") return 0;
  const byName = {};                                   // Custom Rig node name -> ids
  for (const [id, n] of Object.entries(output)) {
    if (n?.class_type !== CUSTOM_RIG) continue;
    const nm = String(n.inputs?.name ?? "").trim() || "Custom rig";
    (byName[nm] ||= []).push(id);
  }
  if (!Object.keys(byName).length) return 0;

  // every Workspace's rig list: rig name -> the Custom Rig node it takes
  const nodeFor = {};
  const workspaces = [];
  for (const [id, n] of Object.entries(output)) {
    if (n?.class_type !== WORKSPACE) continue;
    const cfg = parse(n.inputs?.config);
    if (!cfg) continue;
    const rigs = Array.isArray(cfg.models?.rigs) ? cfg.models.rigs : [];
    rigs.forEach((r, i) => {
      if (r?.kind === "node") nodeFor[rigNameOf(r, i)] = String(r.node || "").trim() || rigNameOf(r, i);
    });
    const active = rigs.length ? rigNameOf(rigs[Math.max(0, Math.min(rigs.length - 1, cfg.models?.active | 0))],
                                            Math.max(0, Math.min(rigs.length - 1, cfg.models?.active | 0))) : "";
    workspaces.push({ id, cfg, active });
  }
  if (!Object.keys(nodeFor).length) return 0;

  // does `from` depend on `to` through the prompt's links? A Custom Rig fed by its own
  // consumer (the Workspace's positive into a sampler into the rig) would become a loop
  // with the added link, and ComfyUI refuses the whole queue for a loop
  const dependsOn = (from, to) => {
    const seen = new Set();
    const stack = [String(from)];
    while (stack.length) {
      const id = stack.pop();
      if (id === String(to)) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const v of Object.values(output[id]?.inputs || {})) {
        if (Array.isArray(v) && v.length === 2 && output[String(v[0])]) stack.push(String(v[0]));
      }
    }
    return false;
  };
  let added = 0;
  const link = (consumerId, rigName) => {
    const target = nodeFor[rigName];
    if (!target) return;
    for (const rid of byName[target] || []) {
      const key = `rn_rig_${rid}`;
      const inputs = (output[consumerId].inputs ||= {});
      if (inputs[key]) continue;
      if (dependsOn(rid, consumerId)) {
        console.warn(`[RedNode Custom Rig] "${target}" is fed by the node that would use it, so `
          + "linking it would make a loop. It is left out of this queue.");
        continue;
      }
      inputs[key] = [rid, 0];
      added++;
    }
  };
  const activeName = workspaces[0]?.active || "";
  for (const w of workspaces) {
    const used = new Set([w.active]);
    for (const pass of [w.cfg.latent, w.cfg.tabs?.i2i]) {
      if (pass?.rig_custom && Array.isArray(pass.pass_rig)) pass.pass_rig.forEach((v) => v && used.add(String(v)));
    }
    if (w.cfg.paint?.renderer_name) used.add(String(w.cfg.paint.renderer_name));
    for (const name of used) link(w.id, name);
  }
  for (const [id, n] of Object.entries(output)) {
    if (!DETAILERS.has(n?.class_type)) continue;
    const cfg = parse(n.inputs?.config);
    for (const s of Array.isArray(cfg?.stages) ? cfg.stages : []) {
      if (!s || s.type === "title" || s.on === false) continue;
      link(id, String(s.rig || "").trim() || activeName);
    }
  }
  return added;
}

/** The Custom Rig nodes on the canvas, subgraphs included: [{node, name}]. */
export function customRigNodes(root = app.graph) {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
      if (n?.type === CUSTOM_RIG && !(n.mode === 2 || n.mode === 4)) {
        const w = (n.widgets || []).find((x) => x?.name === "name");
        out.push({ node: n, name: String(w?.value ?? "").trim() || "Custom rig" });
      }
      if (n?.subgraph) walk(n.subgraph);
    }
  };
  walk(root);
  return out;
}

app.registerExtension({
  name: "RedNode.CustomRig",
  async setup() {
    const orig = app.graphToPrompt;
    if (typeof orig !== "function") return;
    app.graphToPrompt = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const n = linkCustomRigs(res?.output);
        if (n) console.log(`[RedNode Custom Rig] linked ${n} Custom Rig input(s) into this queue`);
      } catch (e) {
        console.warn("[RedNode Custom Rig] could not link the Custom Rigs into the queue:", e);
      }
      return res;
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== CUSTOM_RIG) return;
    // the title follows the name, so a canvas with several reads at a glance
    const titled = (node) => {
      const w = (node.widgets || []).find((x) => x?.name === "name");
      const nm = String(w?.value ?? "").trim() || "Custom rig";
      node.title = `Custom Rig: ${nm}`;
    };
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const w = (this.widgets || []).find((x) => x?.name === "name");
      if (w) {
        const cb = w.callback;
        w.callback = (...a) => { const r = cb?.apply(w, a); titled(this); this.setDirtyCanvas?.(true, true); return r; };
      }
      titled(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      titled(this);
    };
  },
});
