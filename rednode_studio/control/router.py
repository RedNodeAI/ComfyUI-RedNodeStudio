"""RedNode Router — the advanced switch: branches pass on conditions, not boolean chains.

Four variables usually means eight gates and a wall of true/false nodes that nobody can
read a week later. This replaces that with named colours:

  * RedNode Palette holds the colours and which of them are ON right now.
  * Each branch here says which colours it needs, and whether it needs ALL of them or
    ANY of them.
  * The first branch whose condition is met passes. A branch with no colours is the
    "otherwise" branch.

So "hi-res portrait" is two colours switched on, not six wired gates. And because the
palette is read wirelessly, one dropdown can re-route the whole workflow at once.

Like RedNode Switch, the inputs are lazy: the branches that did not win never execute.

`rules` and `active` are plain JSON. `active` is written by the palette in the frontend
(the same wireless mechanism RedNode Control Panel uses), which is why it has to be a
real widget: widget values are what reach the server at queue time.

The panel is in web/rednode_router.js; this file is the wiring and the matching rules.
"""

import json

from .switch import ANY, MAX_INPUTS


def parse_rules(rules_json):
    """{slot: {"colors": [name…], "mode": "all"|"any", "label": str}}"""
    try:
        data = json.loads(rules_json or "{}")
    except ValueError:
        return {}
    if isinstance(data, dict) and isinstance(data.get("rules"), (dict, list)):
        data = data["rules"]
    out = {}
    items = data.items() if isinstance(data, dict) else enumerate(data, start=1)
    for k, v in items:
        try:
            n = int(k)
        except (TypeError, ValueError):
            continue
        if not (1 <= n <= MAX_INPUTS) or not isinstance(v, dict):
            continue
        colors = [str(c) for c in (v.get("colors") or []) if str(c).strip()]
        out[n] = {
            "colors": colors,
            "mode": "any" if str(v.get("mode", "all")).lower() == "any" else "all",
            "label": str(v.get("label") or "").strip(),
        }
    return out


def parse_active(active_json):
    """The colours switched on right now, as a set of names."""
    try:
        data = json.loads(active_json or "[]")
    except ValueError:
        return set()
    if isinstance(data, dict):
        data = data.get("active", [])
    if not isinstance(data, list):
        return set()
    return {str(c) for c in data if str(c).strip()}


def branch_matches(rule, active):
    """A branch with no colours never matches on its own — it is the fallback instead."""
    colors = (rule or {}).get("colors") or []
    if not colors:
        return False
    if rule.get("mode") == "any":
        return any(c in active for c in colors)
    return all(c in active for c in colors)


def resolve_branch(rules_json, active_json, connected=()):
    """Which branch wins: first match, then the 'otherwise' branch, then anything wired.

    `connected` narrows to branches that actually have something plugged in, so a rule
    pointing at an empty socket does not swallow the run.
    """
    rules = parse_rules(rules_json)
    active = parse_active(active_json)
    live = set(connected)

    for n in sorted(rules):
        if live and n not in live:
            continue
        if branch_matches(rules[n], active):
            return n

    for n in sorted(rules):                      # an "otherwise" branch: rule, no colours
        if live and n not in live:
            continue
        if not (rules[n].get("colors") or []):
            return n

    return min(live) if live else 1              # nothing set up yet: first wired branch


class RedNodeRouter:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_INPUTS + 1):
            optional[f"input_{i}"] = (ANY, {
                "lazy": True,                    # branches that lose are never executed
                "tooltip": f"branch {i} — connect anything; set its colours on the panel",
            })
        return {
            "required": {
                "rules": ("STRING", {"default": "{}", "multiline": True, "tooltip":
                          "which colours each branch needs, as JSON. The panel above edits "
                          "this; editable by hand if the UI is unavailable."}),
                # written by RedNode Palette in the frontend. A real widget, not a hidden
                # input: only widget values are sent to the server at queue time.
                "active": ("STRING", {"default": "[]", "multiline": True, "tooltip":
                           "the colours switched on right now — mirrored from RedNode Palette."}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("selected",)
    FUNCTION = "route"
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Advanced switch: each branch passes when its colours are on (ALL or ANY of "
                   "them). Replaces chains of boolean gates, and the losing branches never run.")

    def check_lazy_status(self, rules="{}", active="[]", **kwargs):
        connected = [i for i in range(1, MAX_INPUTS + 1) if f"input_{i}" in kwargs]
        want = f"input_{resolve_branch(rules, active, connected)}"
        if want in kwargs and kwargs[want] is None:
            return [want]
        if want not in kwargs and connected:
            return [f"input_{connected[0]}"]
        return []

    def route(self, rules="{}", active="[]", **kwargs):
        connected = [i for i in range(1, MAX_INPUTS + 1) if kwargs.get(f"input_{i}") is not None]
        idx = resolve_branch(rules, active, connected)
        value = kwargs.get(f"input_{idx}")
        if value is None:
            if not connected:
                raise ValueError(
                    "RedNode Router: nothing is connected to it. Wire your branches into "
                    "input_1, input_2 … and give them colours on the panel.")
            idx = connected[0]
            value = kwargs[f"input_{idx}"]
            print(f"[RedNode Router] no branch matched the live colours — passing branch {idx}",
                  flush=True)
        return (value,)


NODE_CLASS_MAPPINGS = {"RedNodeRouter": RedNodeRouter}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeRouter": "RedNode Router (advanced switch)"}
