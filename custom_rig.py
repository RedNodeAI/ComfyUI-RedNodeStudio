"""Your own workflow as a Workspace rig: RedNode Rig Model, Rig Inputs and Rig Result.

Build a rig the way you build any workflow: your own loaders and model patches, your own
sampler of any kind, your own decode. Three nodes tie it to a rig name.

- Rig Model sits after your loaders. Your model, CLIP and VAE go in; they come out with
  the Workspace's LoRAs for this rig applied (the LoRAs tab set and the camera LoRAs),
  ready for your sampler.
- Rig Inputs hands your sampler what the Workspace made for this call: positive and
  negative (the Prompts tab, the camera words, the Subject, People and Scene references
  on a Krea 2 rig), the latent, seed, steps, CFG, sampler, scheduler, denoise and the
  step window.
- Rig Result takes your finished latent or picture.

On the Models tab a rig of kind "Your own nodes" names the rig. Every time the Workspace,
the Detailer or the Paint tab samples on it, the pack fills Rig Model and Rig Inputs with
that call's values, runs your nodes between them and Rig Result through ComfyUI's own node
calls (rig_chain.py), and carries on with the result: the next pass, the Detailer, Post
FX, Save. Nothing is wired to the Workspace. Your loaders run once per queue; the rest runs
per call.
"""

import comfy.samplers

from . import workspace as _ws

RIG_MODEL = "RedNodeRigModel"
RIG_INPUTS = "RedNodeRigInputs"
RIG_RESULT = "RedNodeRigResult"
INPUT_OUTPUTS = ("positive", "negative", "latent", "seed", "steps", "cfg", "sampler_name",
                 "scheduler", "denoise", "start_step", "end_step")

_RIG_TIP = "The rig name, the same on all three rig nodes and on the Models tab."


def _blocked(n):
    from comfy_execution.graph_utils import ExecutionBlocker
    return tuple(ExecutionBlocker(None) for _ in range(n))


class RedNodeRigModel:
    """Your loaded model, CLIP and VAE, with the Workspace's LoRAs for this rig added."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"rig": ("STRING", {"default": "My rig", "tooltip": _RIG_TIP})},
            "optional": {
                "model": ("MODEL", {"tooltip": "From your own loaders and patches."}),
                "clip": ("CLIP", {"tooltip": "From your own CLIP loader. The Workspace "
                                             "encodes this rig's prompts with it."}),
                "vae": ("VAE", {"tooltip": "From your own VAE loader."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    FUNCTION = "publish"
    CATEGORY = "RedNode/Rigs"
    DESCRIPTION = ("Put this after your loaders. When a Workspace rig of kind Your own nodes "
                   "samples, the model and clip come out with that rig's LoRAs and camera "
                   "LoRAs applied. Wire them into your own sampler.")

    def publish(self, rig="My rig", model=None, clip=None, vae=None, unique_id=None):
        # the queue links this in when a rig in use names it: the Workspace takes the
        # raw pieces from here and applies its LoRAs itself
        _ws.register_node_rig(rig, model, clip, vae, node_id=unique_id)
        return (model, clip, vae)


class RedNodeRigInputs:
    """What the Workspace made for this sampling call, for your own sampler."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"rig": ("STRING", {"default": "My rig", "tooltip": _RIG_TIP})}}

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT", "INT", "FLOAT",
                    comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS,
                    "FLOAT", "INT", "INT")
    RETURN_NAMES = INPUT_OUTPUTS
    FUNCTION = "inputs"
    CATEGORY = "RedNode/Rigs"
    DESCRIPTION = ("Positive, negative, latent, seed and the sampling numbers for each call "
                   "on this rig: the main render, every pass, the Paint tab and every "
                   "Detailer pass. Wire what your sampler needs.")

    def inputs(self, rig="My rig"):
        return _blocked(len(INPUT_OUTPUTS))       # filled only when a rig samples


class RedNodeRigResult:
    """Your sampler's finished latent or picture, back to the Workspace."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"rig": ("STRING", {"default": "My rig", "tooltip": _RIG_TIP})},
            "optional": {
                "latent": ("LATENT", {"tooltip": "Your sampler's latent. Preferred: the "
                                                 "Workspace decodes it itself."}),
                "image": ("IMAGE", {"tooltip": "Or a finished picture, when your chain "
                                               "decodes it; it is encoded back with this "
                                               "rig's VAE for the next step."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "result"
    CATEGORY = "RedNode/Rigs"
    DESCRIPTION = ("The end of your rig. The Workspace takes what arrives here as the "
                   "sampled result and carries on with the Detailer, Post FX and Save.")

    def result(self, rig="My rig", latent=None, image=None):
        return ()


NODE_CLASS_MAPPINGS = {RIG_MODEL: RedNodeRigModel, RIG_INPUTS: RedNodeRigInputs,
                       RIG_RESULT: RedNodeRigResult}
NODE_DISPLAY_NAME_MAPPINGS = {RIG_MODEL: "RedNode Rig Model", RIG_INPUTS: "RedNode Rig Inputs",
                              RIG_RESULT: "RedNode Rig Result"}
