"""RedNode Report — a label whose words come from the run, not from you.

RedNode Note is typed by hand and never executes. This is its counterpart: drop it into a
chain and it reports what actually went past, on the node, in the same sign styling. Good
for "which sampler did this run take", "what did the prompt end up as", "how big was the
latent", and anything else you would otherwise learn by opening three nodes.

NOT AN OUTPUT NODE, and this is the important part. ComfyUI executes every output node AND
everything upstream of it, so a monitor hung off a wire inside a RedNode Switch branch
drags that branch into the run whatever the switch chose. That exact fault shipped once in
RedNode Stage Tap and showed up as two samplers firing at once, with the symptom pointing
at the switch rather than at the watcher. A watcher that changes what the workflow RUNS is
not a watcher. So this passes its value straight through and runs when it is wired inline,
which is its natural shape; the panel says so on the node when nothing is wired onward.

The reading is pushed to the browser as it happens. Nothing is stored in the workflow, so
a report is always from the run you just did rather than from whenever the file was saved.
"""

class AnyType(str):
    """Type sentinel that compares equal to every other type, so any wire connects."""

    def __ne__(self, other):
        return False

    def __eq__(self, other):
        return True

    def __hash__(self):
        return hash("*")


ANY = AnyType("*")
MAX_CHARS = 2000

# the Note's palette, so a report and a label read as the same family
COLORS = ["red", "violet", "cyan", "amber", "lime", "rose", "blue", "white", "custom"]


def describe(value):
    """A short, honest reading of whatever came down the wire."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return f"{value}"
    # torch tensors and the dicts ComfyUI wraps latents in: say the shape, which is the
    # useful fact, without importing torch just to look
    shape = getattr(value, "shape", None)
    if shape is not None:
        return f"{type(value).__name__} {tuple(shape)}"
    if isinstance(value, dict):
        inner = value.get("samples")
        inner_shape = getattr(inner, "shape", None)
        if inner_shape is not None:
            return f"latent {tuple(inner_shape)}"
        return ", ".join(sorted(value)[:8]) or "{}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "empty"
        return f"{len(value)} x {describe(value[0])}"
    return type(value).__name__


class RedNodeReport:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "label": ("STRING", {"default": "", "multiline": False,
                          "tooltip": "Shown above the reading, so a row of these says which is "
                                     "which. Leave it empty for the reading alone."}),
                "font_size": ("INT", {"default": 28, "min": 8, "max": 200, "step": 1,
                          "tooltip": "Reading size. Smaller than a Note's, because a reading is "
                                     "read up close rather than across the graph."}),
                "color": (COLORS, {"default": "red",
                          "tooltip": "Text and glow colour, the same set the Note uses."}),
                "glow": ("INT", {"default": 40, "min": 0, "max": 100, "step": 1,
                          "tooltip": "How far the glow spreads. 0 is flat text."}),
                "custom_color": ("STRING", {"default": "#b8283c",
                          "tooltip": "A hex colour such as #b8283c, used when color is 'custom'."}),
            },
            "optional": {
                "value": (ANY, {"tooltip": "Anything. Text is shown as it is; a tensor or latent "
                                           "reports its shape; a list reports its length."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "report"
    # See the module docstring: an output node would drag its whole upstream into every
    # run and force unchosen switch branches. This one earns its execution by being in
    # the chain, exactly like RedNode Stage Tap after the same lesson.
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Reports whatever passes through it, on the node, in the RedNode Note sign "
                   "styling. Passes the value straight on. WIRE ITS OUTPUT ONWARD: a report "
                   "left dangling does not run, which is what stops it forcing an unchosen "
                   "switch branch to execute.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # a report must run every queue or the node would show a stale reading
        return float("nan")

    def report(self, label="", font_size=28, color="red", glow=40,
               custom_color="#b8283c", value=None, unique_id=None):
        text = describe(value)[:MAX_CHARS]
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "rednode.report", {"node": str(unique_id), "label": str(label), "text": text})
        except Exception as e:
            print(f"[RedNode Report] could not reach the browser: {e}", flush=True)
        line = f"{label}: {text}" if label else text
        print(f"[RedNode Report] {line}", flush=True)
        return (value,)


NODE_CLASS_MAPPINGS = {"RedNodeReport": RedNodeReport}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeReport": "RedNode Report"}
