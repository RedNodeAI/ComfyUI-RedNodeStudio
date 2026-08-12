// A searchable picker, shared by anything in this pack that chooses from a long list.
//
// A plain <select> is fine for five things and unusable at fifty. Channels go the same
// way LoRAs did: one workflow ends up with a channel per prompt fragment, per model,
// per stage, and scrolling a native dropdown to find "scene_prompt" is worse than
// typing it. So the behaviour here is deliberately the same as the LoRA picker, because
// a second search box that works differently is worse than no second search box:
//
//   click or focus   open the list
//   type             filter it
//   up / down        move
//   enter            take the highlighted one
//   escape           cancel and put back what was there
//
// Channels differ from LoRAs in one way: the list is not fixed. Naming a channel is how
// one comes into existence, so with allowNew the text you typed is offered as its own
// entry at the top, and taking it creates the channel.

const CSS = `
/* Above EVERY panel layer in this pack, including the full screen overlay at 9990
   and the menus at 10003. A picker is transient and always answers the click that
   opened it, so topmost is the only correct answer: at 2400 it opened behind the
   full screen backdrop and simply appeared not to work. */
.rn-pick-drop { position: fixed; z-index: 10004; max-height: 320px; overflow-y: auto;
  background: #1b1b1f; border: 1px solid #3a3a42; border-radius: 6px; padding: 3px;
  box-shadow: 0 8px 26px rgba(0,0,0,.55); font-size: 12px; }
.rn-pick-drop > div { padding: 4px 8px; border-radius: 4px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ddd; }
.rn-pick-drop > div:hover { background: #2b2b33; }
.rn-pick-drop > div.sel { background: #33415c; color: #fff; }
.rn-pick-drop .hint { float: right; margin-left: 14px; font-size: 10px; opacity: .45; }
.rn-pick-drop .make { color: #86d3a1; }
.rn-pick-drop .cur { color: #f0c58a; }
.rn-pick-drop .rec .hint { color: #86d3a1; opacity: .7; }
.rn-pick-drop .none { opacity: .5; cursor: default; }
.rn-pick-drop .none:hover { background: none; }
`;

if (!document.getElementById("rn-pick-css")) {
  const style = document.createElement("style");
  style.id = "rn-pick-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// RECENTLY USED. A list that only sorts alphabetically makes you hunt for the channel
// you named forty seconds ago, and the one just created is the one most likely wanted
// next. Recents ride in localStorage rather than the workflow: it is a record of what
// this person has been doing, not of what the graph is, and a workflow handed to
// somebody else should not arrive carrying it. Pickers that share a `recent` key share
// the list, which is the point when two nodes choose from the same channels.
const RECENT_MAX = 8;

function readRecent(key) {
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem("rn-recent-" + key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) { return []; }               // private mode, or somebody else's data
}

function pushRecent(key, value) {
  if (!key || !value) return;
  try {
    const next = [value, ...readRecent(key).filter((x) => x !== value)].slice(0, RECENT_MAX);
    localStorage.setItem("rn-recent-" + key, JSON.stringify(next));
  } catch (e) { /* storage full or blocked: recents are a convenience, not state */ }
}

/** Keep canvas gestures off a floating element: LiteGraph reads them globally. */
function stopEvents(el) {
  for (const ev of ["pointerdown", "pointermove", "pointerup", "click", "dblclick",
                    "wheel", "contextmenu"]) {
    el.addEventListener(ev, (e) => e.stopPropagation());
  }
}

/**
 * Make `input` a searchable picker.
 *
 * items()      -> array of strings, or {value, hint} objects. Called on every keystroke,
 *                 so a caller can return a list that changed since the last open.
 * onPick(v)    -> chosen. "" means the empty entry, when emptyLabel is set.
 * opts.current -> what is set now: it leads the list and is marked, so the field always
 *                 shows what it is rather than only what you could change it to.
 * opts.allowNew-> offer the typed text as a new entry.
 * opts.clearOnPick -> empty the field after a pick, for add-to-a-list fields where
 *                the picked value lands somewhere else and the field is only a door.
 * opts.emptyLabel -> text for a "none" entry at the top. Omit for no empty option.
 * opts.recent  -> a key. Picks are remembered under it and float to the top of an
 *                 unfiltered list, marked "recent". Two pickers sharing a key share
 *                 the list.
 */
export function makePicker(input, items, onPick, opts = {}) {
  let drop = null, list = [], sel = 0, before = "";

  const close = (restore) => {
    if (restore) input.value = before;
    drop?.remove();
    drop = null;
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", place);
  };
  const outside = (e) => {
    if (drop && !drop.contains(e.target) && e.target !== input) close(true);
  };
  const place = () => {
    if (!drop) return;
    const r = input.getBoundingClientRect();
    drop.style.left = `${r.left}px`;
    drop.style.top = `${r.bottom + 3}px`;
    drop.style.minWidth = `${Math.max(r.width, 220)}px`;
  };

  const build = () => {
    // WHAT IS SET IS NOT A SEARCH. The field shows the current value, so on open the box
    // is already full of it, and using that text as the filter showed a one-entry list
    // of the thing you already had: the click that said "show me the channels" showed
    // everything except the channels. Only text TYPED since the open filters; `before`
    // is what the field held when it opened.
    const typedQ = String(input.value || "").trim();
    const q = typedQ === before.trim() ? "" : typedQ.toLowerCase();
    const cur = String(opts.current?.() ?? "");
    const raw = (items() || []).map((x) =>
      typeof x === "string" ? { value: x, hint: "" } : x);

    let out = raw.filter((x) => !q || String(x.value).toLowerCase().includes(q)
                             || String(x.hint || "").toLowerCase().includes(q));

    // Naming a channel is how one comes into existence, so a name that matches nothing
    // is an offer rather than a dead end. Only for text typed this open: the value the
    // field was already holding exists by definition.
    const typed = q ? typedQ : "";
    if (opts.allowNew && typed && !raw.some((x) => x.value === typed)) {
      out = [{ value: typed, hint: "new channel", make: true }, ...out];
    }
    if (opts.emptyLabel && !q) {
      out = [...out, { value: "", label: opts.emptyLabel, empty: true }];
    }
    // Recently used float up, newest first, and say so. Only while the list is
    // unfiltered: once you are typing, the ranking you want is the one you asked for.
    if (!q && opts.recent) {
      const recent = readRecent(opts.recent).filter((r) => r !== cur);
      for (const name of [...recent].reverse()) {
        const i = out.findIndex((x) => x.value === name && !x.make && !x.empty);
        if (i < 0) continue;
        const [hit] = out.splice(i, 1);
        out.unshift({ ...hit, hint: hit.hint || "recent", rec: true });
      }
    }
    // whatever is set leads the list, so the field always shows what it currently is
    if (!q && cur) {
      const i = out.findIndex((x) => x.value === cur);
      if (i > 0) out = [out[i], ...out.filter((_, j) => j !== i)];
    }
    list = out.slice(0, 400);

    drop.replaceChildren();
    if (!list.length) {
      const d = document.createElement("div");
      d.className = "none";
      d.textContent = "no match";
      drop.appendChild(d);
      return;
    }
    list.forEach((x, i) => {
      const d = document.createElement("div");
      d.textContent = x.label ?? (x.value || "");
      if (x.make) d.classList.add("make");
      if (x.rec) d.classList.add("rec");
      if (x.empty) d.classList.add("none");
      if (!x.make && !x.empty && x.value === cur) d.classList.add("cur");
      const hint = x.hint || (!x.make && !x.empty && x.value === cur ? "current" : "");
      if (hint) {
        const s = document.createElement("span");
        s.className = "hint";
        s.textContent = hint;
        d.appendChild(s);
      }
      if (i === sel) d.classList.add("sel");
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); take(x); });
      drop.appendChild(d);
    });
    drop.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };

  const take = (x) => {
    input.value = opts.clearOnPick ? "" : x.value;
    before = input.value;
    close(false);
    if (x.value) pushRecent(opts.recent, x.value);   // creating one counts as using it
    onPick(x.value);
  };

  const open = () => {
    if (drop) return;
    before = String(input.value || "");
    drop = document.createElement("div");
    drop.className = "rn-pick-drop";
    stopEvents(drop);
    document.body.appendChild(drop);
    place();
    sel = 0;
    build();
    // The field opens holding its current value, and typing must SEARCH, not append to
    // it: nobody hunting for a channel wants "Final_Imagesx". Selected, the first
    // keystroke replaces the lot, and a click elsewhere still keeps it.
    if (before) input.select();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
  };

  input.addEventListener("focus", open);
  input.addEventListener("pointerdown", (e) => { e.stopPropagation(); open(); });
  input.addEventListener("keydown", (e) => {
    if (!drop && e.key !== "Escape" && e.key !== "Tab") open();
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, list.length - 1); build(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); build(); e.preventDefault(); }
    else if (e.key === "Enter") { if (list[sel]) take(list[sel]); e.preventDefault(); }
    else if (e.key === "Escape") { close(true); input.blur(); e.stopPropagation(); }
    else if (e.key === "Tab") { close(true); }
    else setTimeout(() => { sel = 0; if (drop) build(); }, 0);
  });
  // typing then clicking away should not quietly keep half a name in the box
  input.addEventListener("blur", () => setTimeout(() => { if (!drop) input.value = before; }, 120));

  return { refresh: () => { before = String(input.value || ""); if (drop) build(); } };
}
