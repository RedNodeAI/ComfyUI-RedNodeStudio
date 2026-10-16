"""RedNode Studio Inputs / Outputs: the Workspace's sockets on their own node, wireless.

The Workspace node is the panel alone. This node picks a Workspace from a list and carries
the sockets that are still in use: eleven inputs on the left, seventeen outputs on the
right. Nothing is wired between the two nodes.

How it resolves: when the prompt is queued from the canvas, the pack's queue-time splice
(web/rednode_studio_io.js, run from the same graphToPrompt hook that resolves Sender and
Grabber) moves every link into this node onto the Workspace's input of the same name,
points every link out of this node at the Workspace's output of the same name, and drops
this node. By the time anything executes there is an ordinary wire, so execution order
and the values themselves come from ComfyUI as always. The Workspace keeps its full socket
contract on the server for exactly that reason; the frontend just does not show it.

The lists here are the cull of 2026-10-16: the four external-caption inputs went (the Auto
Prompt engines caption inside the Workspace now), and of the Workspace's 36 outputs the 17
that an outside graph still has a use for stay (the sampler settings came back the same day:
External sampler needs them typed). Append to these lists, never reorder: the node's slots
are positional in saved workflows.
"""

from . import workspace as _ws

ONLY = "(the only workspace)"

INPUTS = ("model", "clip", "vae", "latent", "image_in", "boost_mask_in", "edit_mask_in",
          "style_in", "subject_in", "surroundings_in", "light_and_colour_in")

OUTPUTS = ("workspace", "image", "result_latent", "model", "clip", "vae", "positive",
           "negative", "denoise", "seed", "prompt_text", "negative_text", "post_process",
           # the active rig's sampler settings, typed as the sampler and scheduler choice
           # lists, so a stock KSampler on External sampler takes them straight (Rig Out hands
           # them out as text, which a KSampler's dropdowns refuse)
           "steps", "cfg", "sampler_name", "scheduler")


def _ws_cls():
    return _ws.RedNodeStudioWorkspace


class RedNodeStudioIO:
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("The Studio Workspace's inputs and outputs, on their own node. Choose the "
                   "Workspace; wire in and out of here. No wire runs between the two nodes: "
                   "the pack joins them when you queue.")
    RETURN_TYPES = tuple(_ws_cls().RETURN_TYPES[_ws_cls().RETURN_NAMES.index(n)]
                         for n in OUTPUTS)
    RETURN_NAMES = OUTPUTS
    FUNCTION = "resolve"

    @classmethod
    def INPUT_TYPES(cls):
        ws_optional = _ws_cls().INPUT_TYPES()["optional"]
        return {
            "required": {
                # a STRING, not a COMBO: the choices are the Workspaces on this canvas, which
                # a COMBO's fixed value list could not validate. The panel turns it into a
                # dropdown (web/rednode_studio_io.js).
                "workspace": ("STRING", {"default": ONLY, "tooltip":
                    "Which Studio Workspace this node stands in for. With one Workspace on "
                    "the canvas the default finds it by itself."}),
            },
            "optional": {name: ws_optional[name] for name in INPUTS},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def resolve(self, workspace=ONLY, unique_id=None, **_wired):
        # Only reached when a queue path skipped the canvas hook (an API call, another
        # pack's own queue). Nothing can be made up here: the values live on the
        # Workspace, and the splice is what carries them.
        raise RuntimeError(
            "RedNode Studio Inputs / Outputs is joined to its Workspace when the prompt is "
            "queued from the canvas, and this prompt was queued another way (an API call, or "
            "another pack's queue path). Queue from the canvas, or wire the Workspace "
            "directly in that prompt.")


NODE_CLASS_MAPPINGS = {"RedNodeStudioIO": RedNodeStudioIO}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioIO": "RedNode Studio Inputs / Outputs"}
