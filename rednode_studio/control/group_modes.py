"""RedNode Group Modes — preset on/off states for whole groups (fast mode, detail mode, ...).

Define modes, one per line as 'mode name: group1, group2'. The listed GROUP TITLES are
enabled in that mode; any group named in some OTHER mode but not this one gets bypassed.
Groups never mentioned anywhere are left untouched. Pick a mode from the dropdown and it
flips your whole pipeline in one click.

Frontend controller (all logic in web/rednode_group_modes.js); it does nothing at run time.
"""


class RedNodeGroupModes:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "modes": ("STRING", {
                    "multiline": True,
                    "default": "fast:\ndetail: face detail, upscale, skin refine",
                    "tooltip": "One mode per line: 'mode name: group1, group2'. Group names must match your "
                               "group TITLES. The listed groups are enabled; groups named in any OTHER mode "
                               "but not this one get bypassed; groups never mentioned are left alone. '#' comments."}),
                "mode": ("STRING", {
                    "default": "",
                    "tooltip": "Active mode (dropdown, built from the lines above). Picking one flips the groups."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Preset group on/off modes (fast, detail, ...). Each mode enables a set of groups and "
                   "bypasses the rest. Switch your whole pipeline in one click.")

    def noop(self, modes="", mode=""):
        return ()


NODE_CLASS_MAPPINGS = {"RedNodeGroupModes": RedNodeGroupModes}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeGroupModes": "RedNode Group Modes"}
