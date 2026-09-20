import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { allNodes } from "./rednode_graph.js";
import { readCfg, setupProblems, sectionCard, expandable } from "./rednode_workspace.js";
import { makePicker } from "./rednode_picker.js";

const TYPE = "RedNodeStudioAssistant";
const clone = (v) => JSON.parse(JSON.stringify(v));
const widget = (node) => node.widgets?.find((w) => w.name === "config");
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
// what was left out, as a count you can open rather than a wall you cannot close
const foldedNotices = (notices, label) => {
  const wrap = el("details", undefined, "rn-as-notice");
  wrap.append(el("summary", `${notices.length} ${label}`),
              el("pre", notices.join("\n")));
  return wrap;
};
const button = (text, fn) => {
  const b = el("button", text);
  b.type = "button";
  b.onclick = fn;
  return b;
};

export function targets(root = app.graph) {
  const found = [], seen = new Set();
  const walk = (graph, path) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes || graph.nodes || []) {
      const key = `${path}/${node.id}`;
      if (node.type === "RedNodeStudioWorkspace") found.push({ node, key });
      if (node.subgraph) walk(node.subgraph, key);
    }
  };
  walk(root, "Root");
  return found;
}

function chosen(node) {
  const available = targets();
  const key = node.properties?.rn_assistant_target;
  return available.find((t) => t.key === key) || (!key && available.length === 1 ? available[0] : null);
}

// words: the Include my words switch, which lives on the ASSISTANT node. It is
// passed in rather than read here, because `target.node` is the Workspace, and
// reading the switch off that found nothing and held the words back however the
// box was ticked. Default off: a caller that forgets sends less, never more.
export function snapshotOf(target, words = false) {
  const node = target.node;
  // Normalisation works on a detached widget when the panel has no cached config yet.
  const cfg = node._rnCfg ? clone(node._rnCfg)
    : readCfg({ widgets: [{ name: "config", value: widget(node)?.value || "{}" }] });
  const diagnostics = setupProblems(node, clone(cfg));
  const graph = node.graph;
  const connections = (node.inputs || []).map((input) => {
    const links = graph?.links || graph?._links;
    const link = links?.get?.(input.link) || links?.[input.link];
    const source = (graph?._nodes || graph?.nodes || []).find((n) => n.id === link?.origin_id);
    return { input: input.name, connected: input.link != null, from: source?.type || "Unknown node" };
  });
  // YOUR WRITTEN WORDS, OFF BY DEFAULT. Prompt rows, the frame fields behind a
  // Krea 2 row, the camera paragraph and the caption instructions are things
  // you typed, and the assistant can do its job without reading them: it can
  // still say a row has words, which rig it serves, which row renders and where
  // a caption lands. Switch Include my words on when you want it to read them,
  // and they go no further than Ollama on this machine. Stripped HERE rather
  // than in Python, so what is not wanted is never sent at all.
  cfg.words_included = !!words;
  if (!cfg.words_included) {
    for (const row of cfg.prompts?.rows || []) {
      if (!row || typeof row !== "object") continue;
      // the flags keep every has-text decision working with the words gone
      row.has_text = !!String(row.text || "").trim();
      row.has_negative = !!String(row.negative || "").trim();
      row.text = ""; row.negative = "";
      if (row.frame && typeof row.frame === "object") {
        row.frame_filled = Object.keys(row.frame)
          .filter((k) => String(row.frame[k] || "").trim());
        delete row.frame;
      }
    }
    for (const key of ["instruction", "system", "question", "prompt", "exclude_tags"]) {
      if (typeof cfg.auto?.[key] === "string") cfg.auto[key] = "";
    }
    // the camera's dials are settings and stay; the paragraph it writes is
    // prompt wording, and anything that long in there is that paragraph
    for (const [key, value] of Object.entries(cfg.camera || {})) {
      if (typeof value === "string" && value.length > 40) cfg.camera[key] = "";
    }
  }
  // Counts and selections are enough; gallery filenames are not part of Stage 1.
  for (const tab of Object.values(cfg.tabs || {})) {
    if (!tab || typeof tab !== "object") continue;
    if (Array.isArray(tab.images)) tab.images = tab.images.map(() => null);
    for (const key of ["mask", "src", "pic_meta", "people_meta", "collections"]) delete tab[key];
  }
  delete cfg.auto?.url;
  const outside = allNodes().filter((n) => n !== node && n.type !== TYPE)
    .map((n) => ({ type: n.type, title: n.title || n.type }));
  return { target: { node_id: node.id, title: node.title || "Workspace", key: target.key },
    taken_at: new Date().toISOString(), config: cfg, connections, diagnostics, outside };
}

// WHERE A CHANGE REACHES THE WORKFLOW, and the only place. The server decided
// the change is a real setting and carries a legal value; this walks the path it
// validated and writes the leaf. It re-reads the live value first: a proposal is
// built from a snapshot, and between reading it and pressing Apply you may have
// moved the same dial yourself. A value that has moved is left alone and said so,
// rather than being quietly overwritten by an older idea of it.
function applyChange(cfg, change) {
  if (change.op === "prompt_add") {
    const rows = (cfg.prompts ||= {}).rows ||= [];
    rows.push(clone(change.value));
    return { ok: true, what: `${change.label} added` };
  }
  const parts = [];
  for (const chunk of String(change.path).split(".")) {
    const [name, ...rest] = chunk.split("[");
    if (name) parts.push(name);
    for (const piece of rest) parts.push(Number(piece.replace("]", "")));
  }
  let node = cfg;
  for (const part of parts.slice(0, -1)) {
    if (node == null || typeof node !== "object") return { ok: false, what: "the setting moved" };
    node = node[part];
  }
  const leaf = parts[parts.length - 1];
  if (node == null || typeof node !== "object") return { ok: false, what: "the setting moved" };
  const live = shownValue(node[leaf]);
  if (live !== change.before && change.before !== "(your words, not shown)") {
    return { ok: false, what: `it is ${live} now, not ${change.before}` };
  }
  node[leaf] = change.value;
  return { ok: true, what: `${change.label}: ${change.before} to ${change.after}` };
}
// the panel's own rendering of a value, so "already changed" compares like for
// like against what the server put in the proposal
const shownValue = (value) => typeof value === "boolean" ? (value ? "On" : "Off")
  : value === undefined || value === null ? "Not set" : String(value);

function applyAll(node, target, changes) {
  const s = state(node);
  const live = target.node;
  const cfg = live._rnCfg || (live._rnCfg = readCfg(live));
  // one snapshot of everything, before anything moves, so Undo is one step
  (s.undo ||= []).push({ at: new Date().toLocaleTimeString(), config: clone(cfg),
                         count: changes.length });
  while (s.undo.length > 10) s.undo.shift();
  const done = [], refused = [];
  for (const change of changes) {
    const result = applyChange(cfg, change);
    (result.ok ? done : refused).push(result.what);
  }
  if (!done.length) s.undo.pop();
  writeLive(live);
  s.notice = [done.length ? `Applied: ${done.join("; ")}.` : "Nothing was applied.",
    refused.length ? `Left alone, changed since: ${refused.join("; ")}.` : ""]
    .filter(Boolean).join("\n");
  renderAssistant(node);
}

function undoLast(node) {
  const s = state(node);
  const target = chosen(node);
  const step = s.undo?.pop();
  if (!step || !target) { s.notice = "Nothing to undo."; renderAssistant(node); return; }
  target.node._rnCfg = clone(step.config);
  writeLive(target.node);
  s.notice = `Undone: the ${step.count} change(s) applied at ${step.at}.`;
  renderAssistant(node);
}

// the Workspace's own write path, so its panel re-reads exactly as it would
// after any other edit
function writeLive(workspace) {
  const w = widget(workspace);
  if (w) w.value = JSON.stringify(workspace._rnCfg);
  workspace.graph?.change?.();
  workspace.onConfigure?.();
  app.graph?.setDirtyCanvas?.(true, true);
}

function fingerprint(target, words) {
  // Compare full live state as well as connections, including paths omitted from the snapshot.
  const snap = snapshotOf(target, words);
  return JSON.stringify([widget(target.node)?.value, target.node._rnCfg,
    snap.connections, snap.outside, snap.diagnostics]);
}

function state(node) {
  if (node._rnAssistant) return node._rnAssistant;
  let saved;
  try { saved = JSON.parse(widget(node)?.value || "{}"); } catch { saved = {}; }
  const transcript = Array.isArray(saved?.transcript) ? saved.transcript.filter((t) =>
    t && ["user", "assistant"].includes(t.role) && typeof t.content === "string")
    // a proposal is about the state it was made against, so it does not come
    // back live after a reload: the answer stays, the buttons do not
    .map((t) => (t.changes?.length ? { ...t, applied: true } : t)) : [];
  return (node._rnAssistant = { transcript, model: typeof saved?.model === "string" ? saved.model : "",
    words: !!saved?.words,
    notice: "Read only. Ask about settings or inspect the context without running a model.",
    models: [], draft: "", pending: null, context: "", generation: 0 });
}

function saveOwn(node) {
  const s = state(node);
  let removed = 0;
  while (s.transcript.length > 20 || JSON.stringify(s.transcript).length > 32000) {
    s.transcript.shift(); removed++;
  }
  if (removed) s.notice = `Transcript: ${removed} oldest turns removed from the saved conversation.`;
  const w = widget(node);
  if (w) w.value = JSON.stringify({ model: s.model, words: !!s.words, transcript: s.transcript });
  node.graph?.change?.();
}

function stop(node, message) {
  const s = state(node);
  s.generation++;
  s.pending?.controller.abort();
  s.pending = null;
  s.notice = message;
  renderAssistant(node);
}

export function refreshTargets(node) {
  const s = state(node), available = targets();
  if (s.pending && !available.some((t) => t.node === s.pending.target.node)) {
    stop(node, "Target deleted. Request cancelled. Choose a Workspace and ask again.");
  }
  const signature = JSON.stringify(available.map((t) => [t.key, t.node.title]));
  if (signature !== s.targetSignature) {
    s.targetSignature = signature;
    renderAssistant(node);
  }
}

export async function ask(node, question, contextOnly = false) {
  const s = state(node), target = chosen(node);
  if (!target || s.pending) return;
  if (!contextOnly && (!question?.trim() || question.length > 4000)) {
    s.notice = "Ask a question of 1 to 4000 characters."; renderAssistant(node); return;
  }
  let snapshot, before;
  const words = !!state(node).words;
  try { snapshot = snapshotOf(target, words); before = fingerprint(target, words); }
  catch {
    s.notice = "Workspace settings could not be read. Reopen its panel and try again.";
    renderAssistant(node); return;
  }
  const model = s.model || snapshot.config.auto?.model || "";
  if (!contextOnly && !model) {
    s.notice = "Choose an installed Ollama model first."; renderAssistant(node); return;
  }
  const id = ++s.generation, controller = new AbortController();
  s.pending = { id, controller, target, fingerprint: before };
  s.lastQuestion = question;
  s.notice = contextOnly ? "Building context..." : "Waiting for local Ollama...";
  const history = s.transcript.filter((t) => t.target?.key === target.key && !t.stale)
    .map((t) => ({ role: t.role, content: t.content }));
  if (!contextOnly) {
    s.transcript.push({ role: "user", content: question, target: snapshot.target, taken_at: snapshot.taken_at });
    s.draft = "";
    saveOwn(node);
  }
  renderAssistant(node);
  try {
    const response = await api.fetchApi(`/rednode/assistant/${contextOnly ? "context" : "chat"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify(contextOnly ? { snapshot } : { snapshot, question, history, model }),
    });
    const result = await response.json();
    if (id !== s.generation) return;
    if (response.ok === false || result.error) throw new Error(result.error || "Assistant request failed.");
    const live = chosen(node);
    if (!live || live.node !== target.node) {
      s.notice = "Target changed or was deleted. Reply discarded. Choose a Workspace and ask again.";
      return;
    }
    if (result.target?.key !== snapshot.target.key || result.taken_at !== snapshot.taken_at) {
      throw new Error("Reply did not match the requested Workspace snapshot.");
    }
    const stale = fingerprint(live, words) !== s.pending.fingerprint;
    s.context = result.context || result.text || "";
    s.contextStamp = `${snapshot.target.title} (${snapshot.target.key}), ${snapshot.taken_at}`;
    s.notice = [stale ? "Workspace changed. This answer describes an earlier state. Ask again for current settings."
      : "Snapshot: " + s.contextStamp, ...(result.notices || []), result.count_method || ""].join("\n");
    if (!contextOnly) {
      s.transcript.push({ role: "assistant", content: result.answer || "No reply returned.",
        target: snapshot.target, taken_at: snapshot.taken_at, stale,
        // a proposal built from a state that has already moved is not offered:
        // the numbers in it describe a workflow that no longer exists
        changes: stale ? [] : (result.changes || []), notices: result.notices || [] });
      saveOwn(node);
    }
  } catch (error) {
    if (id === s.generation) s.notice = error.name === "AbortError" ? "Request cancelled." : "Error: " + error.message;
  } finally {
    if (id === s.generation) { s.pending = null; renderAssistant(node); }
  }
}

function installStyle() {
  if (document.getElementById("rn-assistant-css")) return;
  const style = el("style"); style.id = "rn-assistant-css";
  style.textContent = `.rn-assistant {height:100%;overflow:auto;box-sizing:border-box;padding:10px;
    display:flex;flex-direction:column;gap:10px;background:#15171b;color:#dde1e8;font:15px sans-serif}
  .rn-assistant button,.rn-assistant select,.rn-assistant input,.rn-assistant textarea {
    color:#dde1e8;background:#242830;border:1px solid #414957;border-radius:6px;font:inherit;padding:7px;min-width:0}
  .rn-assistant button {cursor:pointer} .rn-assistant button:disabled {opacity:.45;cursor:default}
  .rn-assistant .rn-as-toolbar {display:flex;flex-wrap:wrap;gap:7px;align-items:center}
  .rn-assistant .rn-as-transcript {display:flex;flex-direction:column;gap:10px}
  .rn-assistant .rn-as-message {padding:9px;background:#20242b;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere}
  .rn-assistant .rn-as-stamp {color:#9aa9bd;font-size:13px;margin-bottom:5px}
  .rn-assistant .rn-as-notice {white-space:pre-wrap;color:#b8c8dd;font-size:13px;overflow-wrap:anywhere}
  .rn-assistant textarea {min-height:80px;resize:vertical;width:100%;box-sizing:border-box}
  .rn-assistant pre {white-space:pre-wrap;overflow-wrap:anywhere;font:13px sans-serif}`;
  document.head.appendChild(style);
}

export function renderAssistant(node) {
  const root = node._rnAssistantRoot;
  if (!root) return;
  const s = state(node), available = targets(), target = chosen(node);
  // Hidden config never exposes a phantom connection socket.
  node.inputs = (node.inputs || []).filter((i) => !(i.name === "config" && i.link == null));
  root.replaceChildren();
  const head = sectionCard("Studio Assistant", "#8fb4ff", "Read only");
  const tools = el("div", undefined, "rn-as-toolbar");
  if (available.length > 1 || (available.length && !target)) {
    const picker = el("select"); picker.title = "Workspace";
    const blank = el("option", "Choose a Workspace"); blank.value = ""; picker.append(blank);
    for (const t of available) {
      const option = el("option", `${t.node.title || "Workspace"} (${t.key})`);
      option.value = t.key; option.selected = t.key === target?.key; picker.append(option);
    }
    picker.value = target?.key || "";
    picker.onchange = () => {
      (node.properties ||= {}).rn_assistant_target = picker.value;
      node.graph?.change?.();
      stop(node, "Workspace selected. Earlier replies retain their snapshot labels.");
    };
    tools.append(picker);
  } else tools.append(el("span", target ? target.node.title || "Workspace" : "No Workspace on the canvas."));
  head.append(tools);
  if (target) {
    const modelLine = el("div", undefined, "rn-as-toolbar");
    modelLine.append(el("span", "Model"));
    const model = el("input"); model.type = "text"; model.title = "Ollama model";
    model.value = s.model || target.node._rnCfg?.auto?.model || readCfg(target.node).auto?.model || "";
    model.placeholder = "Workspace model";
    makePicker(model, () => s.models, (value) => { s.model = value; saveOwn(node); },
      { current: () => model.value, allowNew: false });
    model.onchange = () => { s.model = model.value.trim(); saveOwn(node); };
    const words = el("label", undefined, "rn-as-words");
    const box = el("input"); box.type = "checkbox"; box.checked = !!s.words;
    box.onchange = () => {
      s.words = box.checked;
      saveOwn(node);
      s.notice = box.checked
        ? "Including your words. Prompt text, frame fields and caption instructions "
          + "now go to Ollama on this machine with each question."
        : "Your words are held back. The assistant sees that rows have text, not what it says.";
      renderAssistant(node);
    };
    box.title = "Off: the assistant knows a prompt row has words but never reads them. "
      + "On: your prompt text, Prompt Frame fields and caption instructions are included "
      + "in what it is asked about, on this machine only.";
    words.append(box, el("span", "Include my words"));
    modelLine.append(words);
    const undo = button("Undo last change", () => undoLast(node));
    undo.disabled = !state(node).undo?.length;
    undo.title = undo.disabled ? "Nothing has been applied yet."
      : `Put the Workspace back as it was before the change at ${state(node).undo.at(-1).at}.`;
    modelLine.append(undo);
    const reload = button("Refresh models", async () => {
      try {
        const response = await api.fetchApi("/rednode/assistant/models");
        const got = await response.json();
        s.models = got.models || [];
        s.notice = got.error || got.note || `${s.models.length} installed models available.`;
      } catch { s.notice = "Ollama could not be reached."; }
      renderAssistant(node);
    });
    reload.disabled = !!s.pending;
    modelLine.append(model, reload); head.append(modelLine);
  }
  root.append(head);
  const transcript = el("div", undefined, "rn-as-transcript");
  for (const turn of s.transcript) {
    const block = el("div", undefined, "rn-as-message");
    block.append(el("div", `${turn.role === "user" ? "You" : "Assistant"}: ${turn.target?.title || "Workspace"} `
      + `(${turn.target?.key || "Earlier target"}), ${turn.taken_at || "Earlier snapshot"}`
      + (turn.stale ? " | Earlier state; ask again" : ""), "rn-as-stamp"));
    block.append(el("div", turn.content));
    // ONE LINE, OPENABLE. Every turn was printing its whole omission list, and
    // on a real workflow that is fifteen lines of what the answer does not
    // cover, under every answer, with the same list again at the bottom. The
    // disclosure has to be there; it does not have to be the loudest thing on
    // the panel.
    if (turn.changes?.length && !turn.applied) {
      const box = el("div", undefined, "rn-as-diff");
      box.append(el("div", `${turn.changes.length} change(s) proposed. Nothing is set until you press Apply.`));
      for (const change of turn.changes) {
        box.append(el("div", change.op === "prompt_add"
          ? `${change.label}: ${change.detail}`
          : `${change.label} (${change.path}): ${change.before} to ${change.after}`
            + (change.note ? ` — ${change.note}` : "")));
      }
      const row = el("div", undefined, "rn-as-toolbar");
      const target = chosen(node);
      const apply = button("Apply", () => {
        turn.applied = true; saveOwn(node); applyAll(node, target, turn.changes);
      });
      apply.disabled = !target;
      apply.title = target ? "Write these into the Workspace. Undo puts them back."
        : "Choose a Workspace first.";
      row.append(apply, button("Dismiss", () => {
        turn.applied = true; saveOwn(node);
        state(node).notice = "Proposal dismissed. Nothing was changed.";
        renderAssistant(node);
      }));
      box.append(row);
      block.append(box);
    } else if (turn.changes?.length) {
      // what it was, kept: "already handled" told you a proposal had existed and
      // nothing about what it did to the workflow
      const done = el("div", undefined, "rn-as-diff");
      done.append(el("div", `${turn.changes.length} change(s) proposed, already handled.`));
      for (const change of turn.changes) {
        done.append(el("div", change.op === "prompt_add"
          ? `${change.label}: ${change.detail}`
          : `${change.label}: ${change.before} to ${change.after}`));
      }
      block.append(done);
    }
    if (turn.notices?.length) block.append(foldedNotices(turn.notices, "Detail not shown"));
    transcript.append(block);
  }
  root.append(transcript);
  const [stamp, ...rest] = String(s.notice || "").split("\n").filter(Boolean);
  if (stamp) root.append(el("div", stamp, "rn-as-notice"));
  if (rest.length) root.append(foldedNotices(rest, "Detail not shown"));
  if (s.context) {
    const details = el("details"), summary = el("summary", "Context: " + s.contextStamp);
    details.append(summary, el("pre", s.context)); root.append(details);
  }
  if (target) {
    const question = el("textarea"); question.placeholder = "Ask about the Workspace";
    question.value = s.draft; question.maxLength = 4000;
    question.oninput = () => { s.draft = question.value; };
    question.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); ask(node, question.value);
      }
    });
    root.append(expandable(question, "Assistant question", (value) => { s.draft = value; }));
    const actions = el("div", undefined, "rn-as-toolbar");
    const send = button("Ask", () => ask(node, question.value)); send.disabled = !!s.pending;
    const inspect = button("Show context", () => ask(node, "", true)); inspect.disabled = !!s.pending;
    actions.append(send, inspect);
    if (s.pending) actions.append(button("Cancel", () => stop(node, "Request cancelled. Ollama may finish its current call.")));
    else if (s.lastQuestion) actions.append(button("Ask again", () => ask(node, s.lastQuestion)));
    root.append(actions);
  }
  root.append(button("Clear conversation", () => {
    stop(node, "Conversation cleared.");
    s.transcript = []; s.context = ""; s.lastQuestion = ""; saveOwn(node); renderAssistant(node);
  }));
  root.append(el("div", "Conversation is saved with this node. Clear it before sharing the workflow.", "rn-as-notice"));
}

app.registerExtension({
  name: "RedNode.Assistant",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      installStyle();
      const w = widget(this);
      if (w) { w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4]; }
      const root = el("div", undefined, "rn-assistant rn-ws");
      for (const name of ["pointerdown", "pointerup", "click", "keydown", "contextmenu", "wheel"])
        root.addEventListener(name, (event) => event.stopPropagation());
      this._rnAssistantRoot = root;
      this.addDOMWidget?.("rednode_assistant_ui", "rednode_assistant_ui", root,
        { serialize: false, getMinHeight: () => 360 });
      this.size = [Math.max(this.size?.[0] || 0, 480), Math.max(this.size?.[1] || 0, 520)];
      refreshTargets(this);
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      this._rnAssistant?.pending?.controller.abort();
      if (this._rnAssistant) this._rnAssistant.generation++;
      this._rnAssistant = null;
      renderAssistant(this);
    };
    const drawn = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      drawn?.apply(this, arguments);
      if (performance.now() > (this._rnAssistantNext || 0)) {
        this._rnAssistantNext = performance.now() + 500;
        refreshTargets(this);
      }
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._rnAssistant) { this._rnAssistant.generation++; this._rnAssistant.pending?.controller.abort(); }
      removed?.apply(this, arguments);
    };
  },
});
