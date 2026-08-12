// Pin a node's widgets_values to its input NAMES instead of their positions.
//
// widgets_values is a positional array, and LiteGraph writes it and reads it by two
// different rules:
//
//   serialize()  skips widgets whose own `serialize` is false, but writes each kept value
//                at the WIDGET's index — so a skipped widget leaves a hole, and a hole is
//                written to the workflow file as null.
//   configure()  skips the same widgets but reads the saved array DENSELY from the front.
//
// A panel that is moved to the front of node.widgets (so the hidden native rows cannot
// draw over it) therefore costs the node a slot either way: as its own value if it is not
// marked, or as a leading null if it is. `addDOMWidget(…, {serialize: false})` does NOT
// mark it — that flag only reaches widget.options, which filters the API prompt, not the
// file. Every native value then loads one place to the right of where it was saved, the
// next save writes that back, and it compounds.
//
// It reads as an intermittent bug because a panel is added from onNodeCreated: how far
// the values have moved depends on whether the panel existed yet when the node was
// configured, which changes with how the workflow arrived — a tab switch, a reload, a
// workflow read out of a PNG.
//
// So: this writes the values by name, and reads them back by finding the run in the saved
// array that matches the node's own declared types. The layout comes from the node
// definition rather than from a list kept here, because a list kept here is a list that
// goes stale the first time an input is added.
//
// Used by the panels that reorder their widgets. A panel that leaves its DOM widget at the
// end of the list does not need it (a trailing extra value harms nothing), but it is
// harmless there too.

const CAG = ["fixed", "increment", "decrement", "randomize"];
const NUMERIC = { INT: true, FLOAT: true };

/** The ordered list of values a node of this definition saves, one entry per widget. */
export function specFrom(nodeData) {
  const groups = [nodeData?.input?.required, nodeData?.input?.optional];
  const spec = [];
  for (const group of groups) {
    for (const [name, def] of Object.entries(group || {})) {
      const type = Array.isArray(def) ? def[0] : def;
      const opts = (Array.isArray(def) ? def[1] : null) || {};
      if (opts.forceInput) continue;               // drawn as a socket, never as a row
      if (Array.isArray(type)) {                   // a list of choices is a combo widget
        const values = type.slice();
        spec.push({
          name, kind: "combo", values,
          fix: values.includes(opts.default) ? opts.default : values[0],
          is: (v) => values.includes(v),
        });
      } else if (NUMERIC[type]) {
        const lo = typeof opts.min === "number" ? opts.min : -Infinity;
        const hi = typeof opts.max === "number" ? opts.max : Infinity;
        spec.push({
          name, kind: "number",
          fix: typeof opts.default === "number" ? opts.default : 0,
          is: (v) => Number.isFinite(v) && v >= lo && v <= hi,
        });
        // ComfyUI puts this straight after the number it belongs to, and it is saved
        if (opts.control_after_generate) {
          spec.push({
            name: "control_after_generate", kind: "combo", values: CAG.slice(),
            fix: "fixed", is: (v) => CAG.includes(v),
          });
        }
      } else if (type === "BOOLEAN") {
        spec.push({
          name, kind: "boolean", fix: opts.default === true,
          is: (v) => typeof v === "boolean",
        });
      } else if (type === "STRING") {
        spec.push({
          name, kind: "string", fix: typeof opts.default === "string" ? opts.default : "",
          is: (v) => typeof v === "string",
        });
      }
      // anything else (IMAGE, MODEL, …) is a connection, not a widget, so not a value
    }
  }
  return spec;
}

const widgetOf = (node, name) => node.widgets?.find((w) => w.name === name);

// Strict wants the declared vocabulary and range, which is what tells a colour name apart
// from someone's typing. Loose only wants the right kind of value, so one setting put out
// of range by hand costs that setting rather than the whole row.
const fitsAt = (spec, vals, at, strict) => spec.every((f, i) =>
  strict ? f.is(vals[at + i]) : typeof vals[at + i] === typeof f.fix);

/** Where in a saved array this node's own run of values starts, or -1. */
function findRun(spec, vals) {
  for (const strict of [true, false]) {
    const hits = [];
    for (let at = 0; at + spec.length <= vals.length; at++) {
      if (fitsAt(spec, vals, at, strict)) hits.push(at);
    }
    if (hits.length === 1) return hits[0];
    // More than one place fits: the extra values a broken save added went on the FRONT,
    // so the run that reaches the end of the array is the one that was really written.
    if (hits.length > 1) return hits.includes(vals.length - spec.length)
      ? vals.length - spec.length : hits[0];
  }
  return -1;
}

// Nothing fits, so the array was saved while already scrambled. Free-form text is the part
// worth having back and a shift keeps the order of it, so the typing goes into the text
// boxes in the order it was found. Everything else falls to its default below.
//
// Blank entries are dropped rather than counted: they are what a broken save inserted in
// the first place, and keeping them would push the real text along by exactly as far as
// the fault did. The cost is that a box deliberately left empty closes up, so text can
// land one box over — recovered and in the wrong place beats lost, but only just, which
// is why this only runs when no arrangement of the array fits the node at all.
function rescueText(node, spec, vals) {
  const vocabulary = new Set(spec.flatMap((f) => f.values || []));
  const typed = vals.filter((v) => typeof v === "string" && v.trim() && !vocabulary.has(v));
  let i = 0;
  for (const f of spec) {
    if (f.kind !== "string" || i >= typed.length) continue;
    const w = widgetOf(node, f.name);
    if (w) w.value = typed[i++];
  }
}

/** Any value that cannot be what its widget is takes the widget's own default. */
function sanitise(node, spec) {
  for (const f of spec) {
    const w = widgetOf(node, f.name);
    if (w && !f.is(w.value)) w.value = f.fix;
  }
}

/**
 * Make this node type save and load its widget values by name.
 *
 * Call from beforeRegisterNodeDef, before anything else wraps configure.
 * `after(node)` runs once the values are settled, for panels that mirror them into a DOM.
 *
 * ONE CONSTRAINT: a dropdown is repaired against the list in the node definition, so this
 * suits nodes whose choices are fixed in python. On a node whose list is filled at runtime
 * — model files, saved presets, anything read off disk — a valid saved choice that is not
 * in the definition would be read as damage and reset to the default. Such a node needs
 * the membership test relaxed for that widget before it can use this.
 */
export function pinWidgetValues(nodeType, nodeData, after) {
  const spec = specFrom(nodeData);
  if (!spec.length) return spec;

  // onSerialize runs after LiteGraph has filled widgets_values in, so this replaces a
  // sparse positional array with the node's own values in order. It must return nothing.
  const onSerialize = nodeType.prototype.onSerialize;
  nodeType.prototype.onSerialize = function (info) {
    onSerialize?.apply(this, arguments);
    if (!info) return;
    info.widgets_values = spec.map((f) => {
      const w = widgetOf(this, f.name);
      return w && f.is(w.value) ? w.value : f.fix;
    });
  };

  // configure(), not onConfigure(): LiteGraph hands the saved values to the widgets and
  // only then calls onConfigure, so a repair there would be reading what it meant to fix.
  const configure = nodeType.prototype.configure;
  nodeType.prototype.configure = function (info) {
    const saved = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
    const at = saved && saved.length >= spec.length ? findRun(spec, saved) : -1;
    const result = configure?.apply(this, arguments);
    // Assign by name rather than trusting the positional pass that just ran: this node's
    // widget list is reordered, and on some loads the panel is not in it yet.
    if (at >= 0) {
      spec.forEach((f, i) => {
        const w = widgetOf(this, f.name);
        if (w && typeof saved[at + i] === typeof f.fix) w.value = saved[at + i];
      });
    } else if (saved) {
      rescueText(this, spec, saved);
    }
    sanitise(this, spec);
    after?.(this);
    return result;
  };
  return spec;
}
