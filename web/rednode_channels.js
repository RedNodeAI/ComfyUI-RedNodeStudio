// The channel system's logic. PURE: no app, no graph, no DOM.
//
// A CHANNEL IS A GROUP. A Send puts values on a named channel, each with a label saying
// what it is; as many Sends as you like can feed one channel, from anywhere; a Receive
// subscribes to one OR SEVERAL channels and gets everything on them, listed, and you
// pick and choose: mute the rows you do not want, reorder the rest, and the sockets are
// your own custom output set.
//
// Split out from the graph-walking half deliberately: that half rides on frontend
// internals Comfy changes without ceremony and cannot load outside a browser. This half
// is the logic worth testing, so it lives where a test can reach it.

/**
 * Channel members in a stable, VISIBLE order.
 *
 * By LABEL, not by node id. The reader lists the labels and its sockets have to line up
 * with that list. Node ids depend on the order things happened to be dropped on the
 * canvas, which the user cannot see and would never expect to matter.
 */
export function sortMembers(members) {
  members.sort((a, b) => String(a.label).localeCompare(String(b.label))
                      || String(a.id).localeCompare(String(b.id)));
  return members;
}

/**
 * A label worked out from where the value came from, so nobody has to type one.
 *
 * This is the actual complaint about Get and Set nodes: naming every single one by hand,
 * twice, and keeping the two spellings in step forever. But the graph already knows what
 * the value is and where it came from. A node you renamed, the slot it came out of, the
 * subgraph or group it lives in: all of that is better than a name someone typed once
 * and never revisited.
 */
export function deriveLabel(src) {
  const clean = (v) => String(v ?? "").trim();
  const title = clean(src?.title) || clean(src?.type);
  const slot = clean(src?.slot);
  const where = clean(src?.container);
  // The slot name is dropped when it just repeats the node name, which happens
  // constantly: a "Load Image" whose output slot is called IMAGE reads better as
  // "Load Image" than as "Load Image IMAGE".
  const same = slot && title.toUpperCase().includes(slot.toUpperCase());
  const base = [title, same ? "" : slot].filter(Boolean).join(" ");
  const out = [where, base].filter(Boolean).join(" / ");
  return out.slice(0, 64);
}

/**
 * Whether an auto-name should replace what a row currently holds. PURE.
 *
 * The rule: a name the panel wrote is the panel's to keep current, so rewiring the
 * socket renames the row; a name the user typed is theirs forever. Telling those apart
 * needs the row to remember what the panel last wrote (previousAuto), because by the
 * time of the next look the two are just strings.
 *
 * Returns the name to write, or null for leave-it-alone.
 */
export function nextAutoName(current, previousAuto, derived) {
  const cur = String(current || "").trim();
  const prev = String(previousAuto || "").trim();
  const auto = String(derived || "").trim();
  if (!auto) return null;                 // nothing wired in, nothing to offer
  if (cur && cur !== prev) return null;   // the user typed this, never touch it
  if (cur === auto) return null;          // already right
  return auto;
}

/**
 * Everything on one channel, in the order it was collected.
 *
 * Collection order is SEND order: each Send's rows in the order they sit on it, Sends
 * in the order they are walked. That is the order the user actually built, so it is
 * the default. Alphabetical is still one click away in the node's menu, and whichever
 * arrangement is chosen gets written into the stored order, which both the panel and
 * the queue-time splice follow.
 */
/**
 * A channel name that is not already taken: "Model Here", then "Model Here_01". PURE.
 *
 * An unnamed channel is an unreachable one, so a Send names itself after whatever is
 * wired into its first row. Two Sends fed by the same kind of node would otherwise
 * silently share a channel and pool their values, which is a real behaviour but never
 * what someone who named nothing meant.
 */
export function uniqueChannelName(base, taken) {
  const want = String(base || "").trim().slice(0, 64) || "channel";
  const used = new Set((taken || []).map((t) => String(t || "").trim()));
  if (!used.has(want)) return want;
  for (let n = 1; n < 1000; n++) {
    const tryName = `${want}_${String(n).padStart(2, "0")}`;
    if (!used.has(tryName)) return tryName;
  }
  return want;
}

export function membersOf(sends, channel) {
  const want = String(channel || "").trim();
  if (!want) return [];
  return (sends || []).filter(
    (s) => String(s?.channel || "").trim() === want).slice(0, 64);
}

/**
 * A reader's whole view: several channels' members in one list, each row keyed
 * "channel/label" so mute and order survive two channels using the same label.
 */
export function memberView(sends, channelList, order) {
  const out = [];
  for (const ch of channelList || []) {
    for (const m of membersOf(sends, ch)) {
      out.push({ ...m, channel: ch, key: `${ch}/${m.label}` });
    }
  }
  return applyOrder(out, order).slice(0, 64);
}

/** A reader's display order applied to its rows. PURE.
 *  Rows the order does not mention are appended in their natural position, so a new
 *  Send joining a channel appears rather than vanishing. */
export function applyOrder(members, order) {
  if (!Array.isArray(order) || !order.length) return members;
  const byKey = new Map(members.map((m) => [m.key ?? m.label, m]));
  const out = [];
  for (const key of order) {
    const m = byKey.get(key);
    if (m) { out.push(m); byKey.delete(key); }
  }
  for (const m of members) {
    const key = m.key ?? m.label;
    if (byKey.has(key)) { out.push(m); byKey.delete(key); }
  }
  return out;
}

/**
 * Socket assignment: hidden rows get NO socket at all. PURE.
 *
 * Hiding a reader row means "I do not want a wire here", so the socket goes, and any
 * wire on it goes with it, deliberately. Unhide and the socket comes back for
 * reattaching. The splice derives the same list from the same config, so the frontend
 * and the queue can never disagree about which socket is which.
 */
export function socketOrder(view, hidden) {
  return (view || []).filter((m) => !(hidden || {})[m.key]);
}

/**
 * A label with its source node's name stripped off the front. PURE.
 *
 * Auto-names read "RedNode Studio Workspace scene_image" fifteen times over, and the
 * grouping header already says where they come from, so the rows only need the part
 * that differs. The STORED label keeps the full text, because labels are the identity
 * readers match on and "scene_image" from two different workspaces must not collide.
 */
export function shortLabel(label, from) {
  const l = String(label || "");
  const f = String(from || "").trim();
  if (f && l.toLowerCase().startsWith(f.toLowerCase()) && l.length > f.length) {
    const rest = l.slice(f.length).replace(/^[\s\-:·/]+/, "");
    if (rest) return rest;
  }
  return l;
}

/**
 * Automatic grouping: runs of two or more consecutive rows from the same source node
 * become a group under that node's name. PURE: rows in, [{header, rows}] out, where a
 * null header means ungrouped. Nobody types anything; the source titles were already
 * in the graph.
 */
export function autoGroups(rows, fromOf) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const from = String(fromOf(rows[i]) || "").trim();
    let j = i + 1;
    while (from && j < rows.length && String(fromOf(rows[j]) || "").trim() === from) j++;
    if (from && j - i >= 2) out.push({ header: from, rows: rows.slice(i, j) });
    else for (let k = i; k < j; k++) out.push({ header: null, rows: [rows[k]] });
    i = j;
  }
  return out;
}

/**
 * The row name a publisher takes on its channel.
 *
 * The node TITLE, because that is the name the user already chose and already reads on
 * the canvas: titling the node is how you name the value, with nothing extra to fill
 * in. An untitled node falls back to its kind, with the pack prefix dropped since every
 * row in the list would otherwise start with the same word.
 */
export function publisherLabel(title, classType) {
  return String(title || "").trim()
      || String(classType || "").replace(/^RedNode/, "").trim()
      || "value";
}

/**
 * Give every publisher a name unique on its channel.
 *
 * Two nodes with the same title on one channel would collapse into one row, so the
 * second takes a suffix. WHICH one takes it has to be decided the same way in the
 * browser and at queue time, or the two disagree about which node a row means, so the
 * order is fixed by node id rather than by whatever order they were walked in.
 */
export function labelPublishers(pubs) {
  const taken = new Set();
  return [...pubs]
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined,
                                               { numeric: true }))
    .map((p) => {
      const base = publisherLabel(p.title, p.classType);
      let label = base;
      for (let n = 2; taken.has(`${p.channel}/${label}`); n++) label = `${base} ${n}`;
      taken.add(`${p.channel}/${label}`);
      return { ...p, label };
    });
}

/** The channel config off a Send or Receive node in the built prompt. */
export function readNodeConfig(node) {
  let d = {};
  try { d = JSON.parse(node?.inputs?.config || "{}"); } catch (e) { d = {}; }
  if (Array.isArray(d)) d = { slots: d };
  if (!d || typeof d !== "object") d = {};
  const primary = String(d.channel ?? node?.inputs?.channel ?? "").trim();
  const extra = (Array.isArray(d.channels) ? d.channels : [])
    .map((c) => String(c ?? "").trim()).filter(Boolean);
  const channels = [...new Set([...(primary ? [primary] : []), ...extra])];
  return {
    channel: primary,
    channels,
    publish: !!d.publish,
    muted: d.muted && typeof d.muted === "object" ? d.muted : {},
    hidden: d.hidden && typeof d.hidden === "object" ? d.hidden : {},
    order: Array.isArray(d.order) ? d.order.map(String) : [],
    slots: (Array.isArray(d.slots) ? d.slots : [])
      .map((s) => ({ name: String(s?.name ?? "").trim(),
                     type: String(s?.type ?? "any"),
                     convert: String(s?.convert ?? "").toUpperCase(),
                     on: s?.on !== false }))
      .filter((s) => s.name)
      .slice(0, 64),
  };
}

/**
 * Every link pointing at a node that is not in the prompt.
 *
 * This is the one mistake this file can make that ComfyUI cannot survive. Splicing
 * channels means deleting nodes, and if anything still points at one that is gone, the
 * server raises NodeNotFoundError while building its execution list. That happens on
 * the prompt_worker THREAD, which dies with it, so the queue stops accepting work and
 * the UI just reports that it cannot reach the server. Nothing about that message
 * mentions channels, or this pack, or which node.
 *
 * So it gets checked rather than reasoned about, and the caller throws the whole splice
 * away if this comes back non-empty. A workflow that queues with its channels
 * unresolved is a bad afternoon; a workflow that kills the queue thread is a restart
 * and no idea why.
 */
export function danglingLinks(prompt) {
  const out = [];
  if (!prompt || typeof prompt !== "object") return out;
  for (const [id, node] of Object.entries(prompt)) {
    for (const [name, v] of Object.entries(node?.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && !prompt[String(v[0])]) {
        out.push({ id: String(id), input: name, missing: String(v[0]) });
      }
    }
  }
  return out;
}

/**
 * Resolve the channels inside the BUILT PROMPT. PURE: takes the prompt object,
 * mutates and returns it.
 *
 * ComfyUI flattens subgraphs when it builds a prompt, because the API format has no
 * concept of one. So by this point every Send and Receive is an ordinary entry in one
 * flat map, and resolving them is splicing links: whatever read the Receive is pointed
 * at whatever fed the Send, and both nodes are dropped. By the time anything executes
 * there is an ordinary wire and no channel at all, which is why there is no race.
 *
 * opts.deadReaders: reader node ids bypassed ON THE CANVAS. A bypassed node is not in
 * the prompt at all, so its id has to arrive from the caller.
 */
export function spliceChannels(prompt, opts = {}) {
  const resolved = [];
  const unresolved = [];
  const skipped = [];
  if (!prompt || typeof prompt !== "object") return { resolved, unresolved, skipped };

  const deadReaders = new Set((opts.deadReaders || []).map(String));

  const sends = [];               // one entry per named, wired Send row
  const readers = new Map();      // reader id -> its parsed config
  const pubs = [];                // nodes putting their own output on a channel
  for (const [id, node] of Object.entries(prompt)) {
    const t = node?.class_type;
    if (t === "RedNodeSubgraphSend") {
      const cfg = readNodeConfig(node);
      if (!cfg.channel) continue;
      cfg.slots.forEach((s, i) => {
        const src = node.inputs?.[`value_${i + 1}`];
        if (!Array.isArray(src)) return;         // nothing wired into that row
        // a row switched off at the SEND is off for every reader: it is simply not on
        // the channel, and readers' lists shrink accordingly
        if (!s.on) return;
        sends.push({ id: `${id}:${i}`, channel: cfg.channel, label: s.name, src,
                     convert: s.convert });
      });
    } else if (t === "RedNodeSubgraphReceive") {
      readers.set(String(id), readNodeConfig(node));
    }

    // PUBLISHERS. A node that names a channel_out puts its own first output onto that
    // channel, carried exactly like a Send row and read by anything subscribed. There
    // is deliberately no class list here: a node opts in by growing the field, which is
    // what makes this the general mechanism rather than a feature of the combiners.
    //
    // It replaces the two-node shape, where publishing meant wiring your result into a
    // Sender sitting next to it. The Sender node still exists for gathering several
    // values in one place; this is for the common case of one node, one result.
    const outCh = String(node?.inputs?.channel_out ?? "").trim();
    if (outCh) {
      pubs.push({ id: String(id), channel: outCh, title: node?._meta?.title,
                  classType: t });
    }
  }
  for (const p of labelPublishers(pubs)) {
    sends.push({ id: `${p.id}:out`, channel: p.channel, label: p.label, convert: "",
                 src: [p.id, 0], publisher: p.id });
  }

  // CYCLES. A publisher's value IS its own output, so a node that ends up reading a
  // channel it feeds would be waiting on itself. The direct case is the easy accident:
  // one node with channel and channel_out set to the same name. The indirect one is
  // just as real, where A feeds a channel B reads while B feeds a channel A reads, and
  // neither node looks wrong on its own.
  //
  // Both are the same question, asked once per wire before it is made: starting at the
  // source and walking backwards through its inputs, do we arrive at the consumer? If
  // we do, that wire would close the loop. Checking BEFORE each wire rather than
  // hunting for loops afterwards means the graph is never cyclic even for an instant,
  // so this walk can never run away.
  const cycles = [];
  const dependsOn = (fromId, targetId) => {
    const want = String(targetId);
    const seen = new Set();
    const stack = [String(fromId)];
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
  const noteCycle = (consumerId, m) => {
    cycles.push({
      id: String(consumerId),
      label: m?.label || "a channel value",
      channel: m?.channel || "",
      // whichever wire is reached first survives and the other is refused, so the one
      // named here depends on iteration order. Both ends are wrong either way.
      self: String(m?.src?.[0]) === String(consumerId),
    });
  };

  // slot N means the Nth SOCKET of that reader: its channels, its order, and hidden
  // rows sunk to the tail exactly as the panel sinks them
  const viewFor = (readerId) => {
    const cfg = readers.get(String(readerId));
    if (!cfg) return null;
    return socketOrder(memberView(sends, cfg.channels, cfg.order), cfg.hidden);
  };

  const MUTED = Symbol("muted");
  // A reader can feed another reader, so follow the chain rather than assuming one hop.
  // The cap is a runaway guard, not a cycle check: simpler, and it cannot be wrong. A
  // mute anywhere along the chain kills the value, the way unplugging an inner Get
  // node would.
  const memberFor = (readerId, slot, depth = 0) => {
    if (depth > 16) return null;
    const cfg = readers.get(String(readerId));
    const view = viewFor(readerId);
    const m = view ? view[slot] : null;
    if (!m) return null;
    if (cfg.muted && cfg.muted[m.key]) return MUTED;
    const [srcId, srcSlot] = m.src;
    if (!readers.has(String(srcId))) return m;
    const deeper = memberFor(srcId, srcSlot, depth + 1);
    if (deeper === MUTED || deeper === null) return deeper;
    return { ...deeper, convert: m.convert || deeper.convert };
  };

  // A consumer reading a muted row or a bypassed reader dies SILENTLY, and so does
  // everything downstream of it. That is what "it just does not send" means: the branch
  // does not run and it does not error, exactly like unplugging a Get node. A loud
  // error is reserved for a mistake, a typo'd channel; a mute is a decision.
  const dead = new Set();
  let converters = 0;
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const [name, value] of Object.entries(node?.inputs || {})) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      const [fromId, fromSlot] = value;
      if (deadReaders.has(String(fromId))) {
        dead.add(String(nodeId));
        skipped.push({ id: String(nodeId), because: "the reader is bypassed" });
        continue;
      }
      if (!readers.has(String(fromId))) continue;
      const cfg = readers.get(String(fromId));
      const m = memberFor(fromId, fromSlot);
      if (m === MUTED) {
        dead.add(String(nodeId));
        skipped.push({ id: String(nodeId),
                       because: "a channel value is switched off" });
        continue;
      }
      if (!m) {
        const held = memberView(sends, cfg.channels, null).length;
        unresolved.push({
          id: String(fromId),
          channel: cfg.channels.join(", ") || "(unnamed)",
          slot: fromSlot + 1,
          reason: !cfg.channels.length ? "the reader has no channel name"
                      : !held ? `nothing sends to '${cfg.channels.join("', '")}'`
                      : `only ${held} value(s) arrive, so output ${fromSlot + 1} `
                        + `is empty`,
        });
        continue;
      }
      if (dependsOn(m.src[0], nodeId)) {
        // Treated like a mute rather than an error: the branch stands down and nothing
        // downstream runs, which leaves no half-wired link behind for ComfyUI to
        // complain about in terms that would not name the real problem. The console
        // says what happened, because unlike a mute this is a mistake.
        dead.add(String(nodeId));
        noteCycle(nodeId, m);
        continue;
      }
      if (m.convert) {
        // A conversion needs a real node, so one is put INTO the prompt rather than the
        // user keeping a converter on the canvas. One per source and target type,
        // shared by everything that asked for the same thing.
        const cid = `rn_convert:${m.src[0]}:${m.src[1]}:${m.convert}`;
        if (!prompt[cid]) {
          prompt[cid] = { class_type: "RedNodeChannelConvert",
                          inputs: { value: [...m.src], to: m.convert } };
          converters++;
        }
        node.inputs[name] = [cid, 0];
      } else {
        node.inputs[name] = [...m.src];
      }
      if (m.label && !resolved.includes(m.label)) resolved.push(m.label);
    }
  }

  // SUBSCRIBERS: nodes that name a channel instead of taking wires. Their config
  // lists the rows in panel order, each channel row carrying the key it stands for,
  // and the socket for row N is part_N. Nothing here is specific to the combiners:
  // any node that grows a channel field and numbered sockets subscribes the same way,
  // which is what makes this worth doing once rather than per node.
  let subscribed = 0;
  for (const [nodeId, node] of Object.entries(prompt)) {
    const t = node?.class_type;
    if (t !== "RedNodePromptCombine" && t !== "RedNodeTextCombine") continue;
    let cfg = {};
    try { cfg = JSON.parse(node.inputs?.config || "{}"); } catch (e) { continue; }
    const parts = Array.isArray(cfg.parts) ? cfg.parts : [];
    if (!parts.length) continue;
    const byKey = new Map();
    for (const m of sends) byKey.set(`${m.channel}/${m.label}`, m);
    parts.forEach((part, i) => {
      const key = String(part?.key || "");
      if (!key) return;                      // a typed or hand-wired row, not ours
      const m = byKey.get(key);
      if (!m) return;                        // the channel no longer carries it

      // FOLLOW THE SOURCE FIRST. A value can arrive on a channel VIA another Receive:
      // wire a Receive's output into a Send row and the row's source IS that Receive.
      // The loop above rewires links that point at a reader, but it ran before this
      // one, so a link created HERE was never seen by it. Wiring m.src raw leaves this
      // socket pointing at a Receive that is deleted a few lines later, and the server
      // then raises NodeNotFoundError on the prompt_worker thread and the queue dies
      // with it. This is the bug that did exactly that.
      let src = m.src;
      // absent from the prompt means bypassed or muted upstream: the row stands down,
      // the same as any other value that is not coming
      if (!prompt[String(src[0])] || deadReaders.has(String(src[0]))) return;
      if (readers.has(String(src[0]))) {
        const deeper = memberFor(src[0], src[1]);
        if (!deeper || deeper === MUTED) return;
        src = deeper.src;
      }

      if (dependsOn(src[0], nodeId)) {
        // Its socket is optional, so leaving it unwired costs nothing: the row simply
        // contributes no text and the rest of the node still combines.
        noteCycle(nodeId, m);
        return;
      }
      node.inputs[`part_${i + 1}`] = [...src];
      subscribed++;
    });
  }

  // the silence has to be transitive: a node fed by a dead node is dead too, all the
  // way down, or the survivors error over links into nodes that no longer exist
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of Object.entries(prompt)) {
      if (dead.has(String(id))) continue;
      for (const v of Object.values(node?.inputs || {})) {
        if (Array.isArray(v) && v.length === 2 && dead.has(String(v[0]))) {
          dead.add(String(id));
          grew = true;
          break;
        }
      }
    }
  }
  for (const id of dead) delete prompt[id];

  // Drop both ends, but keep a reader whose wired output found nothing so its own error
  // names what is missing, rather than the value silently going absent.
  for (const [id] of readers) {
    if (!unresolved.some((u) => u.id === String(id))) delete prompt[id];
  }
  for (const [id, node] of Object.entries(prompt)) {
    if (node?.class_type === "RedNodeSubgraphSend") delete prompt[id];
  }
  return { resolved, unresolved, skipped, converters, subscribed, cycles,
           dangling: danglingLinks(prompt) };
}
