// The group rule engine. PURE: no DOM, no graph, no app. Give it a set of groups, a
// list of rules and whatever the Workspace currently says, and it tells you which
// groups run, which do not, and WHY for every one of them.
//
// Kept pure on purpose. The reason people hand-toggle groups before every queue is
// that they do not trust what is about to happen, and the answer to that is a panel
// that shows the outcome before the run. A panel can only show a reason if the engine
// produces one, and an engine can only be trusted if it can be tested without a
// browser. So: one function, no side effects, a reason attached to every decision.
//
// Membership is NOT geometric here. ComfyUI groups are rectangles and a node belongs
// to one because its position happens to fall inside the box, which changes silently
// when you drag something. Everything in this file works on explicit names.

export const RULE_KINDS = ["requires", "excludes", "follows", "only if"];

/** A rule the panel can store. Kept as plain data so it survives in the config JSON. */
export function makeRule(kind = "requires", a = "", b = "") {
  return { kind, a, b, on: true };
}

const norm = (s) => String(s ?? "").trim();

/**
 * Work out what a queue would actually run.
 *
 * @param {string[]} groups   every group name in the workflow
 * @param {object[]} rules    {kind, a, b, on}
 * @param {object}   opts
 *   - manual: {name: boolean}  what the user set by hand, the starting position
 *   - state:  {key: boolean}   Workspace facts an "only if" rule can read
 * @returns {{on: object, why: object, conflicts: object[], order: string[]}}
 */
export function evaluate(groups, rules, opts = {}) {
  const names = (groups || []).map(norm).filter(Boolean);
  const known = new Set(names);
  const manual = opts.manual || {};
  const state = opts.state || {};

  const on = {};
  const why = {};
  for (const g of names) {
    on[g] = manual[g] !== false;               // absent means on, same as the canvas
    why[g] = on[g] ? "on by hand" : "off by hand";
  }

  const live = (rules || []).filter((r) => r && r.on !== false
    && RULE_KINDS.includes(r.kind)
    && known.has(norm(r.a))
    && (r.kind === "only if" ? norm(r.b) : known.has(norm(r.b))));

  const conflicts = [];
  // Fixed point. Rules can chain (C follows B, B requires A), so one pass is not
  // enough, and a cycle must stop rather than spin. The cap is the only thing between
  // a user's typo and a hung browser, which is why it is a cap and not a cycle check:
  // it is simpler and it cannot be wrong.
  const LIMIT = Math.max(8, names.length * 4);
  let pass = 0;
  let changed = true;
  while (changed && pass < LIMIT) {
    changed = false;
    pass++;
    for (const r of live) {
      const a = norm(r.a);
      const b = norm(r.b);
      const set = (g, value, reason) => {
        if (on[g] === value) return;
        on[g] = value;
        why[g] = reason;
        changed = true;
      };
      if (r.kind === "requires") {
        // A needs B, so asking for A switches B on. The other direction is deliberate:
        // turning B off does NOT silently kill A, it reports a conflict, because a
        // rule quietly undoing what you just clicked is how people stop trusting this.
        if (on[a] && !on[b]) {
          if (manual[b] === false) {
            conflicts.push({ rule: r,
              text: `${a} requires ${b}, but ${b} is switched off by hand` });
          } else {
            set(b, true, `on because ${a} requires it`);
          }
        }
      } else if (r.kind === "excludes") {
        if (on[a] && on[b]) {
          if (manual[a] === false || manual[b] !== false) {
            set(b, false, `off because ${a} excludes it`);
          }
          if (manual[a] !== false && manual[b] !== false) {
            conflicts.push({ rule: r,
              text: `${a} and ${b} are both on by hand and they exclude each other, `
                  + `so ${b} loses` });
          }
        }
      } else if (r.kind === "follows") {
        if (on[a] !== on[b]) {
          set(a, on[b], on[b] ? `on because it follows ${b}`
                              : `off because it follows ${b}`);
        }
      } else if (r.kind === "only if") {
        const ok = !!state[b];
        if (on[a] && !ok) set(a, false, `off because ${b} is not on`);
      }
    }
  }
  if (pass >= LIMIT) {
    conflicts.push({ rule: null,
      text: "these rules never settle, so something refers back to itself. The last "
          + "state reached is shown, and it may not be what you meant." });
  }

  return { on, why, conflicts, order: names };
}

/** Just the names that would run, for the places that do not care why. */
export function running(groups, rules, opts) {
  const r = evaluate(groups, rules, opts);
  return r.order.filter((g) => r.on[g]);
}

/** One line per group, for the preview panel and for a console summary. */
export function explain(groups, rules, opts) {
  const r = evaluate(groups, rules, opts);
  return r.order.map((g) => ({ group: g, on: r.on[g], why: r.why[g] }));
}
