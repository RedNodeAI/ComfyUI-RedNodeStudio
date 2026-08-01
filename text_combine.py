"""RedNode Text Combine, and the joining core both combiners share.

Three ways for a piece to arrive, mixed freely in one ordered list:

- TEXT typed into the row itself, which is the plain string-joiner case.
- A WIRE into the row's socket, for a value built elsewhere in the graph.
- A CHANNEL SUBSCRIPTION: name a channel and every string on it becomes a row, with
  no wires at all. A Grabber feeding a combiner would be two nodes, a wire per
  prompt, and two panels listing the same values; naming the channel here is one node.

Every row can be switched off, which is the thing a plain "order" field cannot express:
trying a prompt without its lighting clause is one click, not a delete and a retype.

RedNode Prompt Combine is the prompt-specific sibling: same rows, plus the final-prompt
flag RedNode Save reads. This one is the ordinary string joiner, included so a workflow
does not need another pack for something this basic.
"""

import json

# ComfyUI builds sockets from a static declaration, so there has to be a ceiling. The
# panel only ever shows the rows you added.
MAX_PARTS = 32


def parse_config(config_json):
    """{channel, parts:[{kind, name, on, text, key}]}.

    kind "text" carries its own words; anything else takes the value wired into its
    socket, whether a person wired it or the channel splice did. Position is identity:
    the name is a label for the panel.
    """
    try:
        data = json.loads(config_json or "{}")
    except (ValueError, TypeError):
        data = {}
    if isinstance(data, list):
        data = {"parts": data}
    if not isinstance(data, dict):
        data = {}
    parts = []
    for raw in data.get("parts") or []:
        if not isinstance(raw, dict):
            continue
        parts.append({
            "kind": "text" if str(raw.get("kind") or "") == "text" else "slot",
            "name": str(raw.get("name") or "").strip()[:64],
            "on": raw.get("on") is not False,
            "text": str(raw.get("text") or ""),
            "key": str(raw.get("key") or ""),
        })
    return {
        "channel": str(data.get("channel") or "").strip()[:64],
        "parts": parts[:MAX_PARTS],
    }


def join_parts(cfg, kwargs, separator, prefix="part"):
    """The shared join.

    A wired socket always wins over the row's own text, because a wire is the more
    deliberate act. Switched-off rows are skipped entirely and empty pieces are
    dropped, so a cleared box never leaves a stray separator behind.
    """
    sep = (separator or "").replace("\\n", "\n")
    out = []
    for i, part in enumerate(cfg["parts"]):
        if not part["on"]:
            continue
        wired = kwargs.get(f"{prefix}_{i + 1}")
        text = wired if isinstance(wired, str) else part.get("text", "")
        text = (text or "").strip()
        if text:
            out.append(text)
    return sep.join(out)


class RedNodeTextCombine:
    """Text boxes, wires and channel values, joined in the order the panel shows."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "separator": ("STRING", {"default": ", ", "tooltip":
                              "placed between the pieces. Type \\n for a newline."}),
                "channel": ("STRING", {"default": "", "tooltip":
                            "OPTIONAL. Name a channel and every string on it becomes a "
                            "row here, with no wires. Leave it empty to use only the "
                            "rows you add by hand."}),
                "config": ("STRING", {"default": "{}", "multiline": True}),
                "channel_out": ("STRING", {"default": "", "tooltip":
                                "OPTIONAL. Put this node's joined text onto a channel, "
                                "so anything subscribed to that name picks it up with "
                                "no wire. Reading and sending the same channel would "
                                "make this node wait on itself, so that value is left "
                                "out and the console says so."}),
            },
            "optional": {f"part_{i}": ("STRING", {"forceInput": True})
                         for i in range(1, MAX_PARTS + 1)},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Joins text with a separator: type it into a row, wire it in, or "
                   "subscribe to a channel and get every string on it with no wires at "
                   "all. Drag to reorder, switch a row off to leave it out. For prompts "
                   "specifically, RedNode Prompt Combine adds the final-prompt flag.")

    def run(self, separator=", ", channel="", config="{}", channel_out="", **kwargs):
        # channel and channel_out are resolved on the CANVAS before this runs; they are
        # declared here so ComfyUI draws them and the wireless system can drive them.
        return (join_parts(parse_config(config), kwargs, separator),)


NODE_CLASS_MAPPINGS = {"RedNodeTextCombine": RedNodeTextCombine}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeTextCombine": "RedNode Text Combine"}
