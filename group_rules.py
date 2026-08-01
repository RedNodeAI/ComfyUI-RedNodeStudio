"""RedNode Group Rules: say what may run, and see it before it runs. PROTOTYPE.

RedNode Group Control already lists every group and toggles it. This is the layer above
that: rules between groups, evaluated when you press Queue, with a panel that shows the
outcome first.

Why that last part is the point. The reason people toggle groups by hand before every
run is not that toggling is hard, it is that they do not trust what is about to happen.
A rule engine that silently rearranged things would make that worse, not better. So
every decision this makes carries a reason, and the panel shows all of them: "these four
groups run, these three do not, and here is the rule that decided each one."

Membership is explicit, by group name, and that is the deliberate break from ComfyUI's
own model. A ComfyUI group is a rectangle and a node is in it because its position falls
inside the box, which changes when you drag something and tells nobody. No rule layer can
be reliable on that footing.

Like Group Control, this node does nothing at run time. Groups and node modes are
frontend state; the node exists to hold the panel and its config. `config` is plain JSON
so a workflow that loses the widget can still be repaired by hand.

The engine itself is web/rednode_rules.js, kept pure and tested without a browser.
"""

import json
import os

import folder_paths

KINDS = ("requires", "excludes", "follows", "only if")


def _sets_path(make=False):
    override = os.environ.get("KREA2RN_GROUP_RULES")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "group_rules.json")


def load_sets():
    """{set name: [rule, ...]}  Saved rule sets, so one pipeline's logic is reusable."""
    try:
        with open(_sets_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_sets(sets):
    path = _sets_path(make=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sets, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)          # atomic, so a crash mid-write cannot truncate it
    return path


def clean_rule(raw):
    """One rule, normalised. Returns None for anything unusable rather than raising:
    a half-typed rule in the panel must not take the whole config down with it."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind not in KINDS:
        return None
    a = str(raw.get("a") or "").strip()
    b = str(raw.get("b") or "").strip()
    if not a or not b:
        return None
    return {"kind": kind, "a": a, "b": b, "on": bool(raw.get("on", True))}


def clean_rules(raw):
    out = []
    seen = set()
    for r in raw if isinstance(raw, list) else []:
        c = clean_rule(r)
        if not c:
            continue
        key = (c["kind"], c["a"], c["b"])
        if key in seen:                 # the same rule twice changes nothing but noise
            continue
        seen.add(key)
        out.append(c)
    return out


def parse_config(config_json):
    try:
        data = json.loads(config_json or "{}")
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "rules": clean_rules(data.get("rules")),
        # what the user set by hand, which is the starting position the rules move from
        "manual": {str(k): bool(v) for k, v in (data.get("manual") or {}).items()
                   if isinstance(data.get("manual"), dict)},
        "enabled": bool(data.get("enabled", True)),
        "set_name": str(data.get("set_name") or ""),
    }


class RedNodeGroupRules:
    """Holds the rule list and its panel. Everything happens in the browser."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Rules between groups, evaluated when you queue, with a panel that "
                   "shows which groups will run and which will not BEFORE the run "
                   "starts. B requires A. A excludes B. C follows A. B only if the "
                   "Paint tab is on. Membership is by name, not by which rectangle a "
                   "node happens to be sitting in.")

    def noop(self, config="{}"):
        return {}


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/group_rules")
    async def _rn_rules_get(request):
        return web.json_response({"sets": load_sets(), "kinds": list(KINDS)})

    @PromptServer.instance.routes.post("/rednode/group_rules")
    async def _rn_rules_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "not JSON"}, status=400)
        name = str(data.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "a rule set needs a name"}, status=400)
        sets = load_sets()
        if data.get("delete"):
            sets.pop(name, None)
        else:
            sets[name] = clean_rules(data.get("rules"))
        save_sets(sets)
        return web.json_response({"sets": sets})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] group rule routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeGroupRules": RedNodeGroupRules}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeGroupRules": "RedNode Group Rules"}
