"""RedNode Custom Rig: your own model stack, or your own sampler chain, as a named rig.

Wire in whatever you built: a merged model through its own LoRA loaders, a GGUF with a
different CLIP, a whole sampler chain's finished latent or picture. Give it a name. On
the Workspace's Models tab a rig of kind "Custom node" names it, and from then on the
built-in sampler, every Detailer pass and the paint door use it like any rig loaded
from files. Put as many of these on the canvas as you like.

Nothing is wired to the Workspace or the Detailer. ComfyUI only runs a node when a link
in the queued prompt asks for it, so when you press Queue the page adds that link into
the prompt for each Custom Rig a Workspace or Detailer actually uses this run
(web/rednode_custom_rig.js). A Custom Rig nothing uses is never linked, so it never runs
and its models never load. The link lands on an input the consumer does not declare,
which ComfyUI still orders by and does not validate, so no socket is added anywhere.
"""

from . import workspace as _ws


class RedNodeCustomRig:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "name": ("STRING", {"default": "Custom rig", "tooltip":
                         "What the Models tab calls this. Make a rig of kind Custom node "
                         "and pick this name; the Detailer's passes then name that rig."}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "The model this rig samples with, after "
                                               "whatever loaders and patches you like."}),
                "clip": ("CLIP", {"tooltip": "The text encoder its prompts go through."}),
                "vae": ("VAE", {"tooltip": "The VAE that decodes its pictures."}),
                "latent": ("LATENT", {"tooltip": "A finished latent from your own sampler "
                                                 "chain. With this or an image wired, the "
                                                 "picture IS the render and the built-in "
                                                 "sampler steps aside."}),
                "image": ("IMAGE", {"tooltip": "A finished picture from your own chain, "
                                               "used as the render."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (_ws.RIG_TYPE,)
    RETURN_NAMES = ("rig",)
    FUNCTION = "publish"
    CATEGORY = "RedNode/Models"
    DESCRIPTION = ("Your own model stack or sampler chain as a named rig for the Studio "
                   "Workspace and Detailer. No wires to them: pick its name on the "
                   "Models tab, and it runs only when a rig in use names it.")

    def publish(self, name="Custom rig", model=None, clip=None, vae=None, latent=None,
                image=None, unique_id=None):
        return (_ws.register_node_rig(name, model, clip, vae, latent, image, unique_id),)


NODE_CLASS_MAPPINGS = {"RedNodeCustomRig": RedNodeCustomRig}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeCustomRig": "RedNode Custom Rig"}
