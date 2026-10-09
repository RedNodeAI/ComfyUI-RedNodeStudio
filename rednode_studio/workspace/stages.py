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

MAX_STAGES = 48
THUMB_PX = 320                     # the strip's thumbnail, always
# The size the view gets. The Stage Tap offers these on the node and the Detailer's
# taps carry one in their config; 0 keeps the frame as it is. The thumbnail in the
# strip stays small whatever is chosen, so the list stays light.
TAP_SIZES = {"320 px": 320, "512 px": 512, "768 px": 768, "1024 px": 1024,
             "1536 px": 1536, "full size": 0}
TAP_DEFAULT = "768 px"
MAX_BYTES = 400 * 1024 * 1024      # of view-size pictures held in memory, whole run

# The last run's taps, in the order they executed. A tap notices a new run by the
# identity of the PROMPT dict every node in one execution shares. The view-size
# PNG of each stage lives beside the list, keyed by step, and is served by URL:
# a 1536 px PNG in the JSON list would make every refresh of the strip a
# multi-megabyte read.
STAGES = []
_PNG = {}
_RUN = {"key": None, "n": 0}


def _frame(image):
    """The first frame of an IMAGE tensor as a PIL image.

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
    return Image.fromarray(arr, mode="RGB")


def _png_bytes(img, px):
    """PNG bytes of a PIL image, long edge at most px; px 0 leaves it as it is."""
    from PIL import Image
    if px and max(img.width, img.height) > px:
        scale = px / max(img.width, img.height)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                         Image.LANCZOS)
    buf = _io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _thumb(image, px=THUMB_PX):
    """A PNG data URI of an IMAGE tensor's first frame, long edge at most px."""
    return "data:image/png;base64," + base64.b64encode(
        _png_bytes(_frame(image), px)).decode("ascii")


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
        _PNG.clear()


def _drop_oldest():
    old = STAGES.pop(0)
    _PNG.pop(old["step"], None)


def record(image, label="", prompt=None, source="image", px=None):
    """Add one stage to the run. Failing to make a thumbnail is never fatal.

    px is the long edge the view's picture is kept at (0 = as it is); the strip's
    thumbnail is always THUMB_PX. None means the default tap size.
    """
    _new_run_if_needed(prompt)
    _RUN["n"] += 1
    step = _RUN["n"]
    if px is None:
        px = TAP_SIZES[TAP_DEFAULT]
    try:
        frame = _frame(image)
        full = _png_bytes(frame, px)
        uri = "data:image/png;base64," + base64.b64encode(
            _png_bytes(frame, THUMB_PX)).decode("ascii")
    except Exception as e:
        print(f"[RedNode Stages] step {step} could not be previewed ({e})", flush=True)
        return step
    ts = time.time()
    _PNG[step] = full
    STAGES.append({
        "step": step,
        "label": str(label or "").strip() or f"Step {step}",
        "thumb": uri,
        # the view-size picture, by URL; the stamp stops a browser showing last
        # run's step 3 for this run's step 3
        "full": "/rednode/stages/%d.png?t=%d" % (step, int(ts * 1000)),
        "px": int(px),
        "source": source,
        "w": int(image.shape[-2]), "h": int(image.shape[-3]),
        "ts": ts,
    })
    while len(STAGES) > MAX_STAGES:
        _drop_oldest()
    while len(STAGES) > 1 and sum(len(v) for v in _PNG.values()) > MAX_BYTES:
        _drop_oldest()                               # full-size taps of a 4K chain
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
                "size": (list(TAP_SIZES), {"default": TAP_DEFAULT,
                                           "tooltip": "how big the Stage View keeps "
                                           "this frame. Bigger is sharper on the node "
                                           "and in its full screen; full size is the "
                                           "frame as it is. The strip's thumbnail "
                                           "stays small either way"}),
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

    def tap(self, label="", size=TAP_DEFAULT, image=None, latent=None, vae=None,
            prompt=None):
        shot = image
        source = "image"
        # the wired VAE IS the object the workflow decodes with, so previewing a
        # latent costs nothing beyond the decode itself
        if shot is None and latent is not None and vae is not None:
            try:
                shot = vae.decode(latent["samples"])
                if shot.ndim == 4 and shot.shape[-1] > 3:
                    shot = shot[..., :3]          # an RGBA VAE (Qwen Image 2.1)
                source = "latent"
            except Exception as e:
                print(f"[RedNode Stages] could not decode the latent for a preview ({e})",
                      flush=True)
        if shot is not None:
            step = record(shot, label, prompt, source,
                          px=TAP_SIZES.get(size, TAP_SIZES[TAP_DEFAULT]))
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

    @PromptServer.instance.routes.get("/rednode/stages/{step}.png")
    async def _rednode_stage_png(request):
        try:
            data = _PNG.get(int(request.match_info["step"]))
        except (TypeError, ValueError):
            data = None
        if data is None:
            return web.Response(status=404, text="no such stage in this run")
        return web.Response(body=data, content_type="image/png",
                            headers={"Cache-Control": "no-store"})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] stage HTTP route not registered: {e}", flush=True)
