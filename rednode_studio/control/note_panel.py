"""RedNode Note Panel — every RedNode Note in the workflow, styled from one place.

A label wants to carry nothing but its words. Putting the size, font, colour and glow on
the note itself meant a settings box sitting over the sign, which is the opposite of what
a sign is for, and no way to make thirty labels agree without visiting all thirty.

So the settings move here. This node finds every RedNode Note in the workflow, including
the ones inside subgraphs, lists them, and drives their widgets live the way RedNode
Control Panel drives dropdowns: no wires, and the note serialises the value you picked
here. One button restyles the lot, which is how a workflow ends up with labels that look
like one set rather than thirty decisions.

Nothing happens at execution time; all the behaviour is in web/rednode_note_panel.js.
"""


class RedNodeNotePanel:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("STRING", {"default": "{}", "multiline": True,
                           "tooltip": "Panel state (which note is expanded, the style used by "
                                      "'Apply to all'). The panel above edits this; editable by "
                                      "hand if the UI is unavailable."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Every RedNode Note in the workflow in one list, with its size, font, colour "
                   "and glow. Drives them live, no wires, and can restyle all of them at once.")

    def noop(self, config="{}"):
        return ()


NODE_CLASS_MAPPINGS = {"RedNodeNotePanel": RedNodeNotePanel}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeNotePanel": "RedNode Note Panel"}
