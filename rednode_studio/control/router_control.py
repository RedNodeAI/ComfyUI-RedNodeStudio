"""RedNode Router Control — one switchboard for every colour Router.

The work is deliberately frontend-only. It discovers Routers across the canvas and
subgraphs, collapses repeated branch rules into unique colour combinations, and lets
one click replace the Palette's active set. There is no execution-time value to pass:
Routers already serialize the Palette state they need when the prompt is queued.
"""


class RedNodeRouterControl:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = (
        "A switchboard for all RedNode Routers. Shows the Router count, de-duplicates "
        "their branch colour combinations, and activates one exact combination at a time."
    )

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"RedNodeRouterControl": RedNodeRouterControl}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeRouterControl": "RedNode Router Control"}
