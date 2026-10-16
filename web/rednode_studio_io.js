// RedNode Studio Inputs / Outputs, the logic. PURE: no app, no graph, no DOM, so a test can
// reach it (tests/check_studio_io.mjs). The node itself lives in rednode_studio_io_node.js.
//
// spliceStudioIO rewrites the built prompt the way spliceChannels does for Sender and
// Grabber: by the time anything executes there is an ordinary wire into and out of the
// Workspace, and no wireless anything.

export const IO = "RedNodeStudioIO";
export const WS = "RedNodeStudioWorkspace";
export const ONLY = "(the only workspace)";

// output names in slot order, off the node definitions as they register (the node file
// fills these in beforeRegisterNodeDef); the splice maps by NAME, never by a copied list
export const NAMES = { io: null, ws: null };

/**
 * Resolve every Studio IO node inside the BUILT PROMPT. Mutates the prompt; returns a report.
 *
 * For each IO node: find its Workspace (the `#id` at the front of the picker value, or the
 * only Workspace in the prompt when the value is the default); move each wired input onto
 * the Workspace's input of the same name; point every link that reads the IO node at the
 * Workspace's output of the same name; delete the IO node. An input whose source already
 * depends on the Workspace (or on this node) would close a loop, so it is left out and
 * reported. An IO node whose Workspace cannot be found is LEFT IN: its own server error
 * then names the problem.
 */
export function spliceStudioIO(prompt, names) {
  const resolved = [], unresolved = [], loops = [];
  if (!prompt || typeof prompt !== "object") return { resolved, unresolved, loops };
  const ioNames = names?.io || [], wsNames = names?.ws || [];
  const ios = Object.entries(prompt).filter(([, n]) => n?.class_type === IO);
  if (!ios.length) return { resolved, unresolved, loops };
  const workspaces = Object.keys(prompt).filter((id) => prompt[id]?.class_type === WS);

  const dependsOn = (fromId, targetId) => {
    const want = String(targetId), seen = new Set(), stack = [String(fromId)];
    while (stack.length) {
      const id = stack.pop();
      if (id === want) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const v of Object.values(prompt[id]?.inputs || {})) {
        if (Array.isArray(v) && v.length === 2) stack.push(String(v[0]));
      }
    }
    return false;
  };

  for (const [ioId, io] of ios) {
    const pick = String(io.inputs?.workspace ?? ONLY).trim();
    let wsId = null;
    const m = /^#(\S+)/.exec(pick);
    if (m) {
      // a root node's prompt id is its canvas id; a node inside a subgraph is flattened
      // under a longer id that ends with it
      const tail = workspaces.filter((id) => id.endsWith(":" + m[1]));
      wsId = workspaces.find((id) => id === m[1]) || (tail.length === 1 ? tail[0] : null);
    } else if (pick === ONLY || !pick) {
      wsId = workspaces.length === 1 ? workspaces[0] : null;
    }
    if (!wsId) {
      unresolved.push({ id: String(ioId), pick,
                        reason: !workspaces.length ? "no Workspace in the prompt"
                              : m ? `no Workspace ${pick} in the prompt`
                              : `${workspaces.length} Workspaces: choose one` });
      continue;
    }
    const ws = prompt[wsId];
    ws.inputs ||= {};
    let moved = 0, pointed = 0;
    for (const [name, v] of Object.entries(io.inputs || {})) {
      if (name === "workspace" || !Array.isArray(v) || v.length !== 2) continue;
      if (dependsOn(v[0], wsId) || dependsOn(v[0], ioId)) {
        loops.push({ id: String(ioId), input: name, from: String(v[0]) });
        continue;
      }
      ws.inputs[name] = [...v];
      moved++;
    }
    for (const node of Object.values(prompt)) {
      for (const [name, v] of Object.entries(node?.inputs || {})) {
        if (!Array.isArray(v) || v.length !== 2 || String(v[0]) !== String(ioId)) continue;
        const outName = ioNames[v[1]];
        const wsSlot = outName == null ? -1 : wsNames.indexOf(outName);
        if (wsSlot < 0) {
          unresolved.push({ id: String(ioId), pick,
                            reason: `output ${v[1]} has no Workspace socket` });
          continue;
        }
        node.inputs[name] = [String(wsId), wsSlot];
        pointed++;
      }
    }
    delete prompt[ioId];
    resolved.push({ id: String(ioId), workspace: String(wsId), moved, pointed });
  }
  return { resolved, unresolved, loops };
}
