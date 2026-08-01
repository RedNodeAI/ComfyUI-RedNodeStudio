"""RedNode Pass — sits in a wire and flips palette colours as the chain reaches it.

Put it anywhere in a chain: whatever goes in comes straight out, and when execution
reaches it, the colours you listed are switched on, off or flipped. Use it to light up
where a run has got to, or to leave the graph set up differently for the next run
("first pass done → switch on hires").

The node has two modes, both driven from the browser:

  LIVE (default) — the colours follow the node's own enabled/bypassed state. Drop it in a
    group and that group becomes a switch: enable it and its colours come on, bypass it
    and they go off. Nothing has to execute, so the routing is right before you queue.
    This is the point of the whole thing: one wireless control instead of a wall of
    boolean gates.

  ON EXECUTE — the colours change when the chain actually reaches the node, which is what
    this file implements. ComfyUI freezes the prompt when you press Queue, so the routers
    in flight already hold their colours: a change here lands on the NEXT run. The panel
    says so, and a live node ignores these events entirely.

Nothing is computed here; the value is passed through untouched and the colour change is
an event sent to the browser, where RedNode Palette applies it (web/rednode_pass.js).
"""

import json

from .switch import ANY


def parse_actions(colors_json):
    """[{"name": "hires", "do": "on"|"off"|"flip"}] — anything malformed is dropped."""
    try:
        data = json.loads(colors_json or "[]")
    except ValueError:
        return []
    if isinstance(data, dict):
        data = data.get("colors", [])
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        do = str(item.get("do") or "").strip().lower()
        if name and do in ("on", "off", "flip"):
            out.append({"name": name, "do": do})
    return out


class RedNodePass:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (ANY, {"tooltip": "anything — it comes out the other side untouched"}),
                "colors": ("STRING", {"default": "[]", "multiline": True, "tooltip":
                           "which colours to switch when the chain reaches here, as JSON. "
                           "The panel above edits this."}),
                "always_run": ("BOOLEAN", {"default": False, "tooltip":
                               "fire even when nothing upstream changed. Costs you the cache: "
                               "everything downstream of this node recomputes every queue."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Passes anything straight through and switches RedNode Palette colours. In "
                   "live mode the colours follow this node's enabled/bypassed state, so a group "
                   "containing it acts as a switch; in on-execute mode they change when the chain "
                   "reaches it, which lands on the next run.")

    @classmethod
    def IS_CHANGED(cls, always_run=False, **kwargs):
        # NaN never equals itself, so ComfyUI treats the node as changed every time. Only
        # opt in deliberately: it also invalidates the cache for everything downstream.
        return float("nan") if always_run else False

    def run(self, value=None, colors="[]", always_run=False, unique_id=None):
        actions = parse_actions(colors)
        if actions:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "rednode.pass_colors", {"node": unique_id, "actions": actions})
            except Exception as e:
                print(f"[RedNode Pass] could not reach the browser: {e}", flush=True)
            print("[RedNode Pass] " + ", ".join(f"{a['do']} {a['name']}" for a in actions)
                  + " (applies to the next run)", flush=True)
        return (value,)


NODE_CLASS_MAPPINGS = {"RedNodePass": RedNodePass}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePass": "RedNode Pass (colour trigger)"}
