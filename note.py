"""RedNode Note — a canvas label you can actually read across a zoomed-out graph.

Comfy's built-in Note renders small grey text in a grey box, which is fine for a sentence
and useless as a sign over a section of a big workflow. Same idea, drawn properly: big
text, a colour you pick, and a glow, so a label still reads at the zoom level where you
are actually navigating.

Unselected it draws as a painted block with glowing text, no title bar and no controls,
which is what you want almost all of the time. Click it and the ordinary node comes back
so you can edit it. Nothing here runs: no inputs, no outputs, no execution.

`note` and `font_size` keep their names and stay first, so notes saved before the rest of
these settings existed still load with their text and size intact.

All the drawing is in web/rednode_note.js.
"""

# Families actually present on a normal Windows, macOS or Linux box. Shipping a font file
# means shipping its licence, so these are the safe ones, plus whatever the user names
# themselves in custom_font.
FONTS = [
    "Consolas", "Courier New", "Lucida Console", "Impact", "Arial Black",
    "Trebuchet MS", "Verdana", "Georgia", "Segoe UI", "system-ui", "custom",
]

# Named colours chosen to stay legible on a dark canvas and to keep working for the
# common kinds of colour blindness: no red/green pair here carries meaning on its own.
# red first and by default: it is the pack's branding, not merely one option
COLORS = ["red", "violet", "cyan", "amber", "lime", "rose", "blue", "white", "custom"]

BACKDROPS = ["painted", "outline", "transparent"]


class RedNodeNote:
    """The text, and nothing else.

    The size, font, colour, glow and backdrop used to be widgets here. They are node
    PROPERTIES now, edited from RedNode Note Panel. Two reasons, and the second is the
    one that settled it:

    1. A sign should carry its words and nothing else. A stack of settings sitting under
       the text is the opposite of what a label is for, and thirty labels could not be
       made to agree without visiting all thirty.
    2. Widgets cannot be reliably hidden from a plugin. ComfyUI's frontend renders them
       through its own layer, and display, `hidden`, `type` and `computeSize` are all
       only advisory: three separate attempts to fold these rows away were each
       overridden. A property is never rendered as a row, so there is nothing to hide.

    Notes saved when these were widgets keep their look: the panel reads the old
    widgets_values on load and seeds the properties from it.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "note": ("STRING", {"multiline": True, "default": "",
                          "tooltip": "Your label. Not wired to anything; it just sits on the "
                                     "canvas. Style it from a RedNode Note Panel."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("A canvas label with big glowing text. The node carries only the words; its "
                   "size, font, colour and glow live on a RedNode Note Panel, which styles every "
                   "note in the workflow from one place.")

    def noop(self, note=""):
        return ()


NODE_CLASS_MAPPINGS = {"RedNodeNote": RedNodeNote}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeNote": "RedNode Note"}
