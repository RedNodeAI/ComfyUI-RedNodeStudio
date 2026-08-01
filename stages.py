"""RedNode Stages: see what your workflow did, step by step, without wiring previews.

Two nodes:

  RedNode Stage Tap    drop it anywhere in the chain. Whatever goes in comes back
                       out untouched, and a thumbnail of that moment is recorded.
                       Takes IMAGE or LATENT (a latent is decoded for the preview
                       when a VAE is wired, and passed on as a latent regardless).

  RedNode Stage View   the panel. Shows every tap of the last run in order, step 1
                       to step N, and lets you drag a wipe between any two of them.

The point is that the taps and the view never touch each other in the graph: the
view reads the same in-memory store the taps write to, the wireless pattern the
Control Panel and the Post node already use. No Set/Get pairs, no preview nodes
fanned out across the canvas, nothing to rewire when the workflow changes.
"""
import base64
import io as _io
import time

import torch

MAX_STAGES = 24
THUMB_PX = 320

# The last run's taps, in the order they executed. A tap notices a new run by the
# identity of the PROMPT dict every node in one execution shares.
STAGES = []
_RUN = {"key": None, "n": 0}


def _thumb(image, px=THUMB_PX):
    """A PNG data URI of an IMAGE tensor's first frame, long edge at most px.

    Not every decoder hands back a tidy [B, H, W, 3]. Video VAEs (WanVAE, which is
    what Krea2 decodes with) return [B, T, H, W, C], and a decode can carry an
    alpha channel. Peel the leading dimensions down to one frame and take the
    first three channels, rather than handing PIL something it cannot draw.
    """
    from PIL import Image
    t = image
    while t.ndim > 3:
        t = t[0]
    if t.ndim != 3:
        raise ValueError(f"expected an image, got shape {tuple(image.shape)}")
    if t.shape[-1] == 1:
        t = t.repeat(1, 1, 3)                        # a single-channel decode
    elif t.shape[-1] > 3:
        t = t[..., :3]                               # drop alpha and anything after
    arr = (t.detach().cpu().float().clamp(0, 1).numpy() * 255).astype("uint8")
    img = Image.fromarray(arr, mode="RGB")
    if max(img.width, img.height) > px:
        scale = px / max(img.width, img.height)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                         Image.LANCZOS)
    buf = _io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _run_key(prompt):
    """What tells one queued run from the next.

    id(prompt) was the old answer and it is not safe: CPython reuses addresses, so
    a freed prompt dict and the next one can share an id, and the strip would carry
    on numbering into a run that had already ended. ComfyUI hands the executing
    node a real prompt id, so ask for that and keep id() only as the fallback for
    an older ComfyUI that has no such context.
    """
    try:
        from comfy_execution.utils import get_executing_context
        ctx = get_executing_context()
        if ctx is not None and getattr(ctx, "prompt_id", None):
            return ("prompt_id", str(ctx.prompt_id))
    except Exception:
        pass
    return ("id", id(prompt)) if prompt is not None else None


def _new_run_if_needed(prompt):
    key = _run_key(prompt)
    if key != _RUN["key"]:
        _RUN["key"] = key
        _RUN["n"] = 0
        STAGES.clear()


def record(image, label="", prompt=None, source="image"):
    """Add one stage to the run. Failing to make a thumbnail is never fatal."""
    _new_run_if_needed(prompt)
    _RUN["n"] += 1
    step = _RUN["n"]
    try:
        uri = _thumb(image)
    except Exception as e:
        print(f"[RedNode Stages] step {step} could not be previewed ({e})", flush=True)
        return step
    STAGES.append({
        "step": step,
        "label": str(label or "").strip() or f"Step {step}",
        "thumb": uri,
        "source": source,
        "w": int(image.shape[-2]), "h": int(image.shape[-3]),
        "ts": time.time(),
    })
    while len(STAGES) > MAX_STAGES:
        STAGES.pop(0)
    return step


class RedNodeStageTap:
    """Pass-through that photographs the workflow at this point."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "label": ("STRING", {"default": "", "tooltip": "what this point in the "
                                     "workflow is, e.g. 'after upscale'. Empty just "
                                     "numbers the step"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "wire the image through this node; it comes "
                                    "out of the image output untouched"}),
                "latent": ("LATENT", {"tooltip": "or wire a latent through. It passes out "
                                      "unchanged either way; wire a vae as well and the "
                                      "preview shows what that latent looks like"}),
                "vae": ("VAE", {"tooltip": "only needed to preview a LATENT: wire the "
                                "same VAE your workflow decodes with. Without it a latent "
                                "still passes through, just without a picture"}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("image", "latent")
    FUNCTION = "tap"
    # NOT an output node, reversed after real use. It WAS one, so that a tap hung
    # off a wire as a pure monitor still ran instead of being dead code. The cost
    # of that turned out to be far worse than the problem it solved: ComfyUI
    # executes every output node AND everything upstream of it, so a tap sitting
    # inside a RedNode Switch branch dragged that branch into the run whatever the
    # switch had chosen. Reported live as two samplers firing at once in a face
    # detailer, and the symptom points at the switch rather than at the tap, which
    # makes it expensive to diagnose. A watcher that changes what the workflow
    # RUNS is not a watcher.
    #
    # So a tap now runs when it is wired inline, which is its natural shape: image
    # and latent both pass straight through, so it belongs in the chain rather than
    # dangling off it. The old dead-monitor confusion is answered in the panel
    # instead, where a tap with nothing wired onward says so on the node itself,
    # which is a better answer than silently changing execution.
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Drop this into a chain and it photographs that moment for the Stage "
                   "View panel, passing the image or latent straight through. The view "
                   "finds these by itself, so nothing needs wiring to it. Wire a VAE as "
                   "well to preview latents. WIRE ITS OUTPUT ONWARD: a tap left dangling "
                   "does not run, which is what keeps it from forcing an unchosen switch "
                   "branch to execute.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # a tap must run every queue or the strip would show a stale workflow
        return float("nan")

    def tap(self, label="", image=None, latent=None, vae=None, prompt=None):
        shot = image
        source = "image"
        # the wired VAE IS the object the workflow decodes with, so previewing a
        # latent costs nothing beyond the decode itself
        if shot is None and latent is not None and vae is not None:
            try:
                shot = vae.decode(latent["samples"])
                source = "latent"
            except Exception as e:
                print(f"[RedNode Stages] could not decode the latent for a preview ({e})",
                      flush=True)
        if shot is not None:
            step = record(shot, label, prompt, source)
            print(f"[RedNode Stages] step {step}: "
                  f"{str(label).strip() or 'unnamed'} ({source})", flush=True)
        elif latent is not None:
            # still count the step, so the numbering matches the graph
            _new_run_if_needed(prompt)
            _RUN["n"] += 1
            print("[RedNode Stages] a latent passed through with no VAE wired, so "
                  "there is nothing to show for that step", flush=True)
        return (image, latent)


class RedNodeStageView:
    """The panel. Reads the taps; nothing to wire into it."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Shows every RedNode Stage Tap from the last run in order, with a "
                   "drag-across wipe to compare any two of them. It finds the taps by "
                   "itself: no wires, no Set/Get pairs, nothing to redo when the "
                   "workflow changes.")

    def noop(self):
        return {}


NODE_CLASS_MAPPINGS = {"RedNodeStageTap": RedNodeStageTap,
                       "RedNodeStageView": RedNodeStageView}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStageTap": "RedNode Stage Tap",
                              "RedNodeStageView": "RedNode Stage View"}

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/stages")
    async def _rednode_stages(request):
        return web.json_response({"stages": STAGES})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] stage HTTP route not registered: {e}", flush=True)
