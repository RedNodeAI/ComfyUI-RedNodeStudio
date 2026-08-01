"""RedNode Sender and Grabber: the boundary pair. PROTOTYPE.

Rather than fighting subgraph isolation the way Get/Set nodes do, a node INSIDE the
subgraph is paired with one OUTSIDE, and they cooperate across the boundary.

What makes it different from every wireless node in the ecosystem: the pair does not
move data at run time. ComfyUI flattens subgraphs when it builds a prompt, because the
API format has no concept of one, so by that point both ends are ordinary entries in one
flat map. Just before the run the pair is spliced out: whatever was reading the Receive
is pointed at whatever fed the Send, and both nodes are dropped.

By the time anything executes there is an ordinary wire and no channel at all. ComfyUI
works out execution order purely from links, so anything that stashes a value somewhere
and picks it up elsewhere has a race in it: the receiver can run before the sender. A
real link cannot.

THE SHAPE:

  A CHANNEL IS A GROUP. A Send drops values onto a named channel, each with a label
  saying what it is. As many Sends as you like can feed one channel, from anywhere. One
  Receive subscribes to that channel and gets everything on it, listed, and you pull out
  the ones you want. One reader replaces a Get node per value, which is the point.

Both ends are driven by a panel, the same as the LoRA stack and every other panel in this
pack: a plus button, a row per value, each with its name, its type and an optional
conversion, colour coded by type. The raw sockets follow the panel and are not something
anyone should have to look at.

`config` is plain JSON and is the source of truth, so a workflow that loses its widget
can still be repaired by hand.

STATUS: prototype. The config handling and the splice are plain data work and are
tested. The panel rides on litegraph, which Comfy changes without ceremony.
"""

import json

ANY = "*"

# ComfyUI builds a node's sockets from static RETURN_TYPES and INPUT_TYPES, so there has
# to be a ceiling somewhere: the sockets cannot literally be created on demand. This is
# just the top of the range, not a target. The panel only ever SHOWS the rows you added
# with the plus button, and the frontend removes the rest, so an empty Send has no value
# sockets at all rather than the wall of them a fixed eight used to give.
#
# 64 rather than 8 because the number was never doing any work: the cost of an unused
# declaration is a line in an INPUT_TYPES dict, and running out at 8 is a real limit
# somebody will hit while collecting a subgraph's outputs.
MAX_SLOTS = 64

# The types worth offering by name. "any" is first and is the default, because a value
# nobody has thought about should connect rather than refuse.
TYPES = ("any", "LATENT", "IMAGE", "MASK", "MODEL", "CLIP", "VAE", "CONDITIONING",
         "STRING", "INT", "FLOAT", "BOOLEAN")

# What a value can be turned into on the way through. Empty means leave it alone.
CONVERSIONS = ("", "STRING", "INT", "FLOAT", "BOOLEAN")


def clean_slot(raw):
    """One row of the panel, normalised. None for anything unusable, because a
    half-typed row must not take the whole config down with it."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()[:64]
    if not name:
        return None
    kind = str(raw.get("type") or "any").strip()
    if kind not in TYPES:
        kind = "any"
    conv = str(raw.get("convert") or "").strip().upper()
    if conv not in CONVERSIONS:
        conv = ""
    return {"name": name, "type": kind, "convert": conv}


def parse_config(config_json):
    """{channel, publish, slots[]}. Duplicated names within one node are dropped: a name
    two sockets answer to is not a name, and quietly picking one is exactly the behaviour
    that makes the existing wireless nodes confusing."""
    try:
        data = json.loads(config_json or "{}")
    except (ValueError, TypeError):
        data = {}
    if isinstance(data, list):                      # tolerate a bare list of slots
        data = {"slots": data}
    if not isinstance(data, dict):
        data = {}
    slots, seen = [], set()
    for raw in data.get("slots") or []:
        slot = clean_slot(raw)
        if not slot or slot["name"] in seen:
            continue
        seen.add(slot["name"])
        slots.append(slot)
    return {
        "channel": str(data.get("channel") or "").strip()[:64],
        "publish": bool(data.get("publish")),
        "slots": slots[:MAX_SLOTS],
    }


class RedNodeSubgraphSend:
    """Puts values on a named channel. Driven by its panel, not by its sockets."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # channel and publish are REAL widgets as well as living in the panel.
                # The panel writes them and they write the panel, so whichever you touch
                # the other follows. They stay widgets because that is what makes them
                # reachable from the Control Panel and the rest of the wireless system,
                # which a value buried in a JSON blob would not be.
                "channel": ("STRING", {"default": "", "tooltip":
                            "the channel these values go on. A channel is a group: "
                            "several Sends can share one and a single Receive picks up "
                            "all of them."}),
                "publish": ("BOOLEAN", {"default": False, "tooltip":
                            "Off, this belongs to the subgraph it sits in. On, the "
                            "channel is offered further out too. Off is the safe "
                            "default: two instances of one subgraph would otherwise "
                            "both claim the same name."}),
                "config": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {f"value_{i}": (ANY, {"lazy": True})
                         for i in range(1, MAX_SLOTS + 1)},
        }

    RETURN_TYPES = ()
    FUNCTION = "declare"
    CATEGORY = "RedNode/Channels"
    OUTPUT_NODE = True
    DESCRIPTION = ("Puts values on a named channel so a RedNode Grabber inside "
                   "the subgraph can pull them out, with nothing wired through the "
                   "boundary by hand. Add rows in the panel: each gets a name, a type "
                   "and a socket. Several Senders can share one channel and the Grabber "
                   "lists them all. The pair is spliced into real wires before the run, "
                   "so execution order is ComfyUI's problem rather than ours.")

    def check_lazy_status(self, **kwargs):
        # Nothing is read here: this node is removed from the prompt before the run.
        # Asking for the inputs would execute whatever feeds them a second time.
        return []

    def declare(self, channel="", publish=False, config="{}", **kwargs):
        cfg = parse_config(config)
        cfg["channel"] = cfg["channel"] or str(channel or "").strip()
        names = ", ".join(s["name"] for s in cfg["slots"]) or "nothing"
        print(f"[RedNode Sender] '{names}' was not resolved before the run, so "
              f"this node did nothing. That means the pack's frontend did not load; "
              f"check the browser console.", flush=True)
        return {"ui": {"channel": [cfg["channel"]]}}


class RedNodeSubgraphReceive:
    """The reader. Subscribes to a channel and hands out everything on it."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": ("STRING", {"default": "", "tooltip":
                            "the channel to read. Everything any RedNode Sender "
                            "puts on it is listed in the panel."}),
                "config": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = tuple([ANY] * MAX_SLOTS)
    RETURN_NAMES = tuple(f"value_{i}" for i in range(1, MAX_SLOTS + 1))
    FUNCTION = "fetch"
    CATEGORY = "RedNode/Channels"
    DESCRIPTION = ("Reads a channel. Name it in the panel and every value any RedNode "
                   "Sender has put on that channel is listed, with its type and "
                   "where it came from, and a socket each. Both ends are gone by the "
                   "time the graph runs: they are replaced with ordinary links, so "
                   "there is no race and no ordering to get wrong.")

    def fetch(self, channel="", config="{}"):
        cfg = parse_config(config)
        name = cfg["channel"] or str(channel or "").strip()
        which = repr(name) if name else "you asked for"
        raise RuntimeError(
            f"RedNode Grabber: nothing resolved the channel {which}. Either no "
            f"RedNode Sender is using that name, or the pack's frontend did not "
            f"load. This node is meant to be replaced by real wires before the run "
            f"starts, so reaching here always means the splice did not happen.")


class RedNodeChannelConvert:
    """Turns a value into another type on the way through a channel.

    Put into the prompt BY the splice when a row asks for a conversion, so the canvas
    does not fill up with converter nodes. It is an ordinary node and works by hand too.

    The conversions that cannot work still cannot work: nothing here turns an image into
    an integer. It refuses in plain words rather than handing on something wrong.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (ANY, {}),
                "to": (list(CONVERSIONS[1:]), {"default": "STRING"}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "convert"
    CATEGORY = "RedNode/Channels"
    DESCRIPTION = ("Converts a value between the simple types: string, int, float, "
                   "boolean. Used by the subgraph channels when a row asks for a "
                   "conversion, and usable on its own.")

    def convert(self, value=None, to="STRING"):
        try:
            if to == "STRING":
                return (value if isinstance(value, str) else str(value),)
            if to == "BOOLEAN":
                if isinstance(value, str):
                    # "false" and "0" reading as True is the classic trap here
                    return (value.strip().lower() not in ("", "false", "0", "no"),)
                return (bool(value),)
            if to == "INT":
                return (int(value) if isinstance(value, bool)
                        else int(round(float(value))),)
            if to == "FLOAT":
                return (float(value),)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"RedNode Channel Convert: cannot turn {type(value).__name__} into "
                f"{to} ({e}). The simple types convert between each other; anything "
                f"else, such as an image or a latent, does not.")
        raise ValueError(f"RedNode Channel Convert: '{to}' is not a type it knows.")


NODE_CLASS_MAPPINGS = {
    "RedNodeSubgraphSend": RedNodeSubgraphSend,
    "RedNodeSubgraphReceive": RedNodeSubgraphReceive,
    "RedNodeChannelConvert": RedNodeChannelConvert,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    # Kept in step with the copy in __init__.py, which is the one ComfyUI reads.
    # See the note there for why these are Sender and Grabber rather than the old
    # Channel Out and Channel In.
    "RedNodeSubgraphSend": "RedNode Sender",
    "RedNodeSubgraphReceive": "RedNode Grabber",
    "RedNodeChannelConvert": "RedNode Channel Convert",
}
