"""RedNode Switch — pick one branch by name, and only run that branch.

Why it exists: the usual way to choose between four latent setups (empty 1024, empty
1536, image-to-image, inpaint…) is to bypass three groups and leave one enabled. That
works, but it means hunting groups on the canvas every time, and the choice is spread
across four places instead of being one setting.

This node takes any number of inputs of any type and passes one of them through, chosen
by NAME rather than by index — "img2img", not "3". The inputs are lazy, so the branches
you did not choose are never executed: exactly the saving you get from bypassing their
groups, without the bypassing.

The `selected` widget is a plain STRING that the frontend turns into a dropdown of your
own labels. That is deliberate: a real COMBO would be validated server-side against a
fixed list, and these choices are yours. It also means RedNode Control Panel sees it as
an ordinary dropdown, so a saved scene can flip which branch runs.

All the labelling UI is in web/rednode_switch.js; this file is the wiring.
"""

import json


class AnyType(str):
    """Type sentinel that compares equal to every other type.

    ComfyUI checks link types with `!=`, so a string that is never unequal accepts any
    connection. This is the long-standing way to write a type-agnostic node.
    """

    def __ne__(self, other):
        return False

    def __eq__(self, other):
        return True

    def __hash__(self):
        return hash("*")


ANY = AnyType("*")
MAX_INPUTS = 8


def _labels(labels_json):
    """{slot number: label} — the panel writes it, and it is only used for naming."""
    try:
        data = json.loads(labels_json or "{}")
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for k, v in (data.get("labels") or data).items():
        try:
            n = int(k)
        except (TypeError, ValueError):
            continue
        if 1 <= n <= MAX_INPUTS and isinstance(v, str) and v.strip():
            out[n] = v.strip()
    return out


def resolve_index(selected, labels_json, connected=()):
    """Which input slot does `selected` mean?

    Accepts a label ("img2img"), a slot number ("3"), or a label with its number in
    front, which is how the panel writes them ("3 · img2img"). Falls back to the first
    connected input so a renamed or deleted branch degrades to something that works
    instead of failing the whole queue.
    """
    labels = _labels(labels_json)
    sel = str(selected or "").strip()

    for n, name in labels.items():                       # exact label
        if sel == name:
            return n
    if " · " in sel:                                     # "3 · img2img" from the panel
        head = sel.split(" · ", 1)[0].strip()
        if head.isdigit() and 1 <= int(head) <= MAX_INPUTS:
            return int(head)
        for n, name in labels.items():
            if sel.split(" · ", 1)[1].strip() == name:
                return n
    if sel.isdigit() and 1 <= int(sel) <= MAX_INPUTS:    # plain slot number
        return int(sel)

    for n in sorted(connected):                          # nothing matched: first live input
        return n
    return 1


class RedNodeSwitch:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_INPUTS + 1):
            optional[f"input_{i}"] = (ANY, {
                "lazy": True,                            # unchosen branches never execute
                "tooltip": f"branch {i} — connect anything; name it on the panel",
            })
        return {
            "required": {
                "selected": ("STRING", {"default": "1", "tooltip":
                             "which branch to pass through. The panel turns this into a "
                             "dropdown of your own names, so RedNode Control Panel can drive it."}),
                # NOT "hidden": hidden inputs never become widgets, so the panel would have
                # nowhere to store the names. It is a normal widget that the panel hides.
                "labels": ("STRING", {"default": "{}", "multiline": True, "tooltip":
                           "branch names, as JSON. The panel above edits this; editable by "
                           "hand if the UI is unavailable."}),
            },
            "optional": optional,
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("selected",)
    FUNCTION = "pick"
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Pass one of several inputs through, chosen by name. Unchosen branches are "
                   "never executed, so it replaces bypassing a group per option. Works with any "
                   "type: latent, image, model, conditioning.")

    # -- lazy evaluation ---------------------------------------------------
    # ComfyUI calls this before running the node: return the names of the inputs it
    # actually has to produce. Everything upstream of the others is skipped.
    def check_lazy_status(self, selected="1", labels="{}", **kwargs):
        # NEVER ASK FOR THE SAME INPUT TWICE.
        #
        # ComfyUI resolves a lazy node by calling this, executing whatever names come
        # back, then calling it again. That loop only ends when the node stops asking.
        # An input whose upstream is BYPASSED or MUTED resolves to None and stays None
        # however many times it is evaluated, so returning its name again on the next
        # pass asks for something that can never arrive, and the executor keeps trying:
        # the queue appears to run over and over, doing nothing, while memory climbs.
        #
        # Reported 2026-08-01: a workflow with the Krea 2 samplers bypassed and a switch
        # selecting a branch fed through them. Nothing in the log named this node, which
        # is what made it hard to see.
        #
        # So each candidate is asked for at most once. Once every wired branch has been
        # asked and none produced a value, resolution stops and pick() reports it in
        # terms of the real cause rather than handing None downstream.
        asked = self.__dict__.setdefault("_rn_asked", set())
        wired = [i for i in range(1, MAX_INPUTS + 1) if f"input_{i}" in kwargs]

        want = f"input_{resolve_index(selected, labels, wired)}"
        # the chosen branch first, then any other wired branch as a fallback
        order = [want] + [f"input_{i}" for i in wired if f"input_{i}" != want]

        for name in order:
            if name not in kwargs:
                continue
            if kwargs[name] is not None:        # already have a value: done
                asked.clear()
                return []
            if name not in asked:
                asked.add(name)
                return [name]

        asked.clear()                           # nothing left to try
        return []

    def pick(self, selected="1", labels="{}", **kwargs):
        self.__dict__.pop("_rn_asked", None)     # the next run asks afresh
        live = [i for i in range(1, MAX_INPUTS + 1) if kwargs.get(f"input_{i}") is not None]
        wired = [i for i in range(1, MAX_INPUTS + 1) if f"input_{i}" in kwargs]
        idx = resolve_index(selected, labels, live)
        value = kwargs.get(f"input_{idx}")
        if value is None:
            if not wired:
                raise ValueError(
                    "RedNode Switch: nothing is connected to it. Wire your branches into "
                    "input_1, input_2 … and pick one on the panel.")
            if not live:
                # Wired, but every branch came back empty. Passing None on would fail
                # somewhere else entirely, in whichever node first tried to use it, with
                # a message about the wrong type that names neither this node nor the
                # real cause. Say it here, and say what actually does it.
                names = ", ".join(_labels(labels).get(i, f"input_{i}") for i in wired)
                raise ValueError(
                    f"RedNode Switch: every branch wired into it came back empty "
                    f"({names}). The usual cause is that the branch is BYPASSED or "
                    f"MUTED further upstream, so nothing can ever reach this node. "
                    f"Re-enable the group feeding the branch you picked, or point "
                    f"'{selected}' at one that is live.")
            idx = live[0]
            value = kwargs[f"input_{idx}"]
            name = _labels(labels).get(idx, f"input_{idx}")
            print(f"[RedNode Switch] '{selected}' is not connected — passing {name} instead", flush=True)
        return (value,)


NODE_CLASS_MAPPINGS = {"RedNodeSwitch": RedNodeSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeSwitch": "RedNode Switch"}
