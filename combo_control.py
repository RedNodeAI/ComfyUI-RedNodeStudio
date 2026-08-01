"""RedNode Combo Control (Stage 1 prototype) — drive another node's dropdown from here.

Pick a target node, one of its dropdown/toggle widgets, and a value; this sets that widget
live in the graph, no wire. It proves the wireless-control mechanism before the full
Power-Lora-style multi-row control panel. Purely a frontend controller: it does nothing at
execution time (all the work is in web/rednode_combo_control.js).
"""


class RedNodeComboControl:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target": ("STRING", {"default": "", "tooltip": "Which node to control (dropdown, filled from your graph)."}),
                "widget": ("STRING", {"default": "", "tooltip": "Which dropdown/toggle on that node."}),
                "value": ("STRING", {"default": "", "tooltip": "The value to set (dropdown of that widget's choices)."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Control another node's dropdown/toggle from here, wireless. Stage-1 prototype "
                   "for the multi-row RedNode control panel.")

    def noop(self, target="", widget="", value=""):
        return ()


NODE_CLASS_MAPPINGS = {"RedNodeComboControl": RedNodeComboControl}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeComboControl": "RedNode Combo Control"}
