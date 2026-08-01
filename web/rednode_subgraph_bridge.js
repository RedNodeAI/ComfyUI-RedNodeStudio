import { app } from "../../scripts/app.js";
import { membersOf, spliceChannels, danglingLinks } from "./rednode_channels.js";

// The boundary pair, frontend half. PROTOTYPE.
//
// A RedNode Channel Out sits inside a subgraph and names a value. A RedNode Subgraph
// Receive sits outside and asks for that name. Before the prompt is built, this file
// rewrites both away: the value is exposed on the subgraph's own boundary, and the
// consumer that was wired to the Receive is rewired to that boundary slot instead.
//
// So at run time there is no channel, no lookup and no wireless anything. There is a
// wire, and ComfyUI orders it the way it orders every other wire. That is the whole
// argument for this design over the stash-a-global approach: with no link there is no
// dependency, and a receiver can run before the sender meant to fill it.
//
// The pure part (matching sends to receives, spotting duplicates and orphans) is
// separated from the graph-walking part on purpose, because only the pure part can be
// tested without a browser, and the graph-walking part is the bit Comfy will break.

export const SEND = "RedNodeSubgraphSend";
export const RECEIVE = "RedNodeSubgraphReceive";

const widget = (node, name) =>
  String((node?.widgets || []).find((w) => w?.name === name)?.value ?? "").trim();

/** Every Send and every reader on the canvas, subgraphs included. */
export function collect(root) {
  const sends = [];
  const readers = [];
  const seen = new Set();
  const visit = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of graph._nodes || []) {
      if (n?.type === SEND) {
        sends.push({ id: String(n.id), node: n, channel: widget(n, "channel"),
                     label: widget(n, "label") || widget(n, "channel") });
      } else if (n?.type === RECEIVE) {
        readers.push({ id: String(n.id), node: n, channel: widget(n, "channel") });
      }
      if (n?.subgraph) visit(n.subgraph);
    }
  };
  visit(root || app.graph);
  return { sends, readers };
}

/**
 * What is on every channel, and which readers would come up empty. Reads only, so it is
 * safe any time, and it is the thing to look at when a channel is not doing what you
 * expect.
 */
export function report(root) {
  const { sends, readers } = collect(root);
  const channels = {};
  for (const s of sends) {
    if (s.channel) (channels[s.channel] ||= []).push(s.label);
  }
  const lines = [];
  for (const [name, labels] of Object.entries(channels)) {
    lines.push(`${name}: ${membersOf(sends, name).map((m) => m.label).join(", ")}`
             + (labels.length > 8 ? `  (only the first 8 have sockets)` : ""));
  }
  for (const r of readers) {
    if (!r.channel) lines.push(`node ${r.id}: no channel name yet`);
    else if (!channels[r.channel]) {
      lines.push(`node ${r.id}: nothing sends to '${r.channel}'`);
    }
  }
  return { sends, readers, channels, lines: lines.length ? lines
                                            : ["no channels in this workflow"] };
}

app.registerExtension({
  name: "RedNode.SubgraphBridge",
  async setup() {
    // Resolve on the BUILT PROMPT, not on the graph. ComfyUI flattens subgraphs when it
    // builds a prompt, so by this point both ends are ordinary nodes in one flat map and
    // the whole job is splicing a link and dropping two nodes.
    //
    // This is why pressing Queue now just works. The earlier design wanted the graph
    // rewritten first, which meant typing a console command before every run, and a
    // node you have to run a command to use is not a feature.
    //
    // Nothing here touches the user's graph, so nothing is left behind in the saved
    // workflow and there is nothing to undo if it goes wrong.
    const orig = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const out = res?.output;
        if (out) {
          // A reader bypassed or muted on the canvas is absent from the prompt, so its
          // id has to be handed over: its consumers are then skipped silently, the way
          // a branch behind an unplugged Get node is. This is also what makes the
          // Receive controllable from Group Control: bypass the group it sits in and
          // everything reading it stands down without an error.
          const deadReaders = [];
          const walk = (graph, seen = new Set()) => {
            if (!graph || seen.has(graph)) return;
            seen.add(graph);
            for (const n of graph._nodes || []) {
              if (n?.type === RECEIVE && n.mode && n.mode !== 0) {
                deadReaders.push(String(n.id));
              }
              if (n?.subgraph) walk(n.subgraph, seen);
            }
          };
          walk(app.graph);

          // Nothing to do, so do nothing. A workflow without a single channel node
          // should not have its prompt copied, walked or rewritten on the way to the
          // queue: it cannot benefit and it can only break.
          const touches = Object.values(out).some(
            (n) => n?.class_type === SEND || n?.class_type === RECEIVE
                || String(n?.inputs?.channel_out ?? "").trim());
          if (!touches && !deadReaders.length) return res;

          // Splice a COPY. res.output is the object about to be posted, and the splice
          // mutates as it goes, so working on it directly means a failure halfway
          // through submits a half-rewritten prompt. Deleting nodes is the whole
          // mechanism here, so the failure mode is a link pointing at something that is
          // gone, which takes down the queue thread rather than erroring politely.
          // A few milliseconds of copying buys the right to change our mind.
          // What was ALREADY broken when the prompt reached us, so the blame lands in
          // the right place. Several packs rewrite the prompt on the way to the queue,
          // and the server's NodeNotFoundError names none of them.
          const before = danglingLinks(out);
          const known = new Set(before.map((d) => `${d.id}|${d.input}`));
          const draft = JSON.parse(JSON.stringify(out));
          const r = spliceChannels(draft, { deadReaders });
          const introduced = (r.dangling || [])
            .filter((d) => !known.has(`${d.id}|${d.input}`));

          if (before.length) {
            for (const d of before.slice(0, 6)) {
              console.error(`[RedNode] the prompt already had a broken link BEFORE this `
                          + `pack touched it: node ${d.id} input '${d.input}' points at `
                          + `${d.missing}, which is not in the prompt.`);
            }
            console.error(`[RedNode] that is not from this pack. It will raise `
                        + `NodeNotFoundError on the server and take the queue thread `
                        + `down with it. Something else that rewrites prompts is the `
                        + `place to look, and a bypassed or muted node inside a `
                        + `subgraph is the usual cause.`);
          }

          if (introduced.length) {
            for (const d of introduced.slice(0, 6)) {
              console.error(`[RedNode] node ${d.id} input '${d.input}' would point at `
                          + `${d.missing}, which the splice removed.`);
            }
            console.error(`[RedNode] the channel splice was DISCARDED and your prompt `
                        + `was sent unchanged, so anything relying on a channel will `
                        + `error by name instead. This is a bug in this pack: please `
                        + `report it with the workflow.`);
            try {
              app.extensionManager?.toast?.add?.({
                severity: "error", life: 10000,
                summary: "RedNode: channels not resolved",
                detail: "The splice would have left a broken link, so it was discarded "
                      + "and your prompt was sent as it was.",
              });
            } catch (e) { /* older frontends have no toast */ }
          } else {
            // commit IN PLACE: callers already hold a reference to res.output
            for (const k of Object.keys(out)) delete out[k];
            Object.assign(out, draft);
          }
          if (r.resolved.length) {
            console.log(`[RedNode] subgraph channels resolved: `
                      + `${r.resolved.join(", ")}`);
          }
          for (const u of r.unresolved) {
            console.warn(`[RedNode] nothing sends the channel '${u.channel}', so node `
                       + `${u.id} has no value. Check the Send's channel name.`);
          }
          for (const c of r.cycles || []) {
            const what = c.self
              ? `node ${c.id} both sends to and reads the channel '${c.channel}', so it `
                + `would be waiting on itself`
              : `'${c.label}' on channel '${c.channel}' leads back to node ${c.id} `
                + `through another node that reads a channel this one sends to`;
            console.error(`[RedNode] ${what}. That value was left out. Change one of `
                        + `the two channel names.`);
            try {
              app.extensionManager?.toast?.add?.({
                severity: "error", life: 8000,
                summary: "RedNode: a channel feeds itself",
                detail: c.self
                  ? `Node ${c.id} sends to '${c.channel}' and reads it too.`
                  : `'${c.label}' on '${c.channel}' loops back to node ${c.id}.`,
              });
            } catch (e) { /* older frontends have no toast; the console has it */ }
          }
        }
      } catch (e) {
        // never take the queue down over this: a failure here means the pair does not
        // resolve, and the node's own error says so far more clearly than a stack trace
        console.error("[RedNode] could not resolve the subgraph channels:", e);
      }
      return res;
    };
    globalThis.rednodeBridge = { report, collect, spliceChannels };
    console.log("[RedNode] channels loaded. They resolve when you queue.");
  },
});
