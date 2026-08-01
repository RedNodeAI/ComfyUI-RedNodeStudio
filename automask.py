"""Auto masking: one button on the Paint tab instead of outlining a person by hand.

Painting a mask by hand is the right tool for a patch, and the wrong one for "everything
except this person". So the panel asks here for a subject or background mask and gets
back an ordinary mask PNG, in the same folder and the same convention the brush writes,
which means everything downstream, feathering, inverting, the region crop, Generate, is
the machinery that already exists. Nothing here knows what it will be used for.

NO MODEL SHIPS WITH THIS, and nothing is downloaded. It drives whichever segmenter is
already installed, exactly as postprocess.auto_depth() drives whichever depth estimator
is installed, and says so in the console when it cannot find one. That keeps a big
optional dependency out of the pack and lets the machine's existing models earn their
disk space.

Model order is cheapest-that-does-the-job, not newest:

  RMBG / BiRefNet   a purpose-built subject-and-background net, and the only one here
                    with a clean edge through hair, which is the whole game when the
                    background is about to be repainted behind someone.
  person yolo segm  a fraction of the size and faster, blobby through hair. The
                    fallback, and plenty for a body-shaped region.

SAM 3 is deliberately not in that list. It is for masking arbitrary things a sentence
can describe, and at 3.3 GB it would compete with the renderer for VRAM to do a job a
52 MB model already does. It belongs behind a text box, not behind this button.
"""

import os
import time

import numpy as np
import torch
from PIL import Image

import folder_paths

from . import workspace as _ws

WANTS = ("background", "subject")

# Tried in order, best first. Names verified against the installed packs rather than
# guessed: the first version of this listed plausible-sounding names and a fixed output
# slot, and every one of them missed.
SEGMENTERS = (
    "RMBG",             # comfyui-rmbg's main node: RMBG-2.0, INSPYRENET, BEN
    "BiRefNetRMBG",     # same pack, the BiRefNet family
    "BRIA_RMBG",        # the older standalone wrapper
)
# BodySegment was in this list and should never have been. It segments body PARTS,
# hair, arms, torso, so as a fallback for "everything except the person" it produces
# something that looks like a mask and is the wrong shape entirely. It was reached
# every time, because the real segmenter above it was failing silently, and the bad
# masks it made were blamed on the model rather than on being asked the wrong question.

# When a required choice looks like a model list, these win if they are in it. RMBG-2.0
# is the one worth having here: a clean edge through hair is the whole game when the
# background behind someone is about to be repainted.
PREFERRED = ("rmbg-2.0", "birefnet-general", "inspyrenet")

# The model file to name in the "install one of these" message, per segmenter.
INSTALL_HINT = ("comfyui-rmbg brings RMBG-2.0, which is the one to have for this. "
                "The Impact subpack's person_yolov8m-seg is a lighter fallback.")

# A panel is rebuilt surprisingly often; its JavaScript state is therefore the wrong
# place to remember an expensive segmentation. These entries live for the server
# process and point at ordinary managed input files. The file is still the authority:
# if it has been removed, the entry is discarded and the model runs again.
_AUTO_MASK_CACHE = {}


def _node(name):
    try:
        import nodes
    except Exception:
        return None
    return getattr(nodes, "NODE_CLASS_MAPPINGS", {}).get(name)


def _as_mask(out):
    """Pull a [1,H,W] mask out of whatever a wrapper handed back."""
    if isinstance(out, dict):
        out = out.get("result", out.get("ui", None))
    while isinstance(out, (list, tuple)) and out:
        # a MASK is 3-D and an IMAGE is 4-D; prefer the first thing shaped like a mask
        for item in out:
            if torch.is_tensor(item) and item.ndim == 3:
                return item
        out = out[0]
    if not torch.is_tensor(out):
        return None
    t = out
    if t.ndim == 4:                      # an IMAGE came back: take its first channel
        t = t[..., 0]
    if t.ndim == 2:
        t = t[None,]
    return t if t.ndim == 3 else None


def _call_args(cls, image):
    """Fill a node's REQUIRED inputs from its own declaration, or None if it cannot be.

    Guessing argument names is what broke the first version: RMBG's function signature
    is (self, image, model, **params), so filtering by the signature dropped everything
    except `image` and the call died on the missing `model` it had never been told
    about. A node already says what it needs, so ask it.
    """
    try:
        spec = cls.INPUT_TYPES() or {}
    except Exception:
        return None
    out = {}
    # OPTIONAL INPUTS TOO, with their declared defaults. ComfyUI fills those in when it
    # runs a graph; calling a node directly does not, and these nodes read them straight
    # out of **params. RMBG does `params["sensitivity"]` on the very first mask it
    # builds, so passing only the required inputs raised KeyError, the failure was
    # swallowed as "try the next segmenter", and a body-parts segmenter answered
    # instead. The mask came out wrong and the real model was never even asked.
    for section in ("required", "optional"):
        for key, decl in (spec.get(section) or {}).items():
            kind = decl[0] if isinstance(decl, (list, tuple)) and decl else None
            opts = decl[1] if isinstance(decl, (list, tuple)) and len(decl) > 1 \
                and isinstance(decl[1], dict) else {}
            if kind == "IMAGE":
                out[key] = image
            elif isinstance(kind, (list, tuple)) and kind:
                # a dropdown: take a known-good one when it is offered, else whatever is
                # first, which is the node's own idea of a sensible default
                pick = next((c for c in kind if str(c).lower() in PREFERRED), None)
                out[key] = pick if pick is not None else kind[0]
            elif "default" in opts:
                out[key] = opts["default"]
            elif section == "required":
                return None              # a required input nothing here can supply
    # The one default worth overriding. It is the resolution the segmenter works at, and
    # it decides how the edge comes out: at 1024 a 2K picture is masked small and scaled
    # back up, which is exactly the soft, approximate edge that makes a replaced
    # background look pasted on. Hair is the whole reason to use this model at all.
    if "process_res" in out:
        want = max(int(out["process_res"] or 0), min(2048, max(image.shape[1],
                                                               image.shape[2])))
        out["process_res"] = max(256, (want // 8) * 8)
    return out if any(v is image for v in out.values()) else None


def _mask_slot(cls):
    """Which output is the MASK, by its declared type rather than by position."""
    types = list(getattr(cls, "RETURN_TYPES", ()) or ())
    return types.index("MASK") if "MASK" in types else 0


def _stable_cache_value(value):
    """Make a node setting deterministic and hashable without touching image tensors."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return tuple(_stable_cache_value(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((str(key), _stable_cache_value(item))
                            for key, item in value.items()))
    return repr(value)


def _segmenter_identity(name, cls, kwargs):
    """The node and exact model/settings which would answer this request."""
    settings = tuple(sorted(
        (str(key), _stable_cache_value(value))
        for key, value in kwargs.items()
        if not torch.is_tensor(value)
    ))
    return (
        str(name),
        str(getattr(cls, "__module__", "")),
        str(getattr(cls, "__qualname__", getattr(cls, "__name__", ""))),
        settings,
    )


def _prepared_segmenters(image):
    """Resolve usable segmenters once so cache lookup and execution agree exactly."""
    prepared = []
    for name in SEGMENTERS:
        cls = _node(name)
        if cls is None:
            continue
        kwargs = _call_args(cls, image)
        if kwargs is None:
            print(f"[RedNode Paint] {name} needs an input this cannot supply, skipping",
                  flush=True)
            continue
        prepared.append((name, cls, kwargs, _segmenter_identity(name, cls, kwargs)))
    return prepared


def _subject_mask_prepared(prepared):
    """Run prepared candidates and also return the identity of the one that answered."""
    for name, cls, kwargs, identity in prepared:
        try:
            got = getattr(cls(), cls.FUNCTION)(**kwargs)
            slot = _mask_slot(cls)
            mask = None
            if isinstance(got, (list, tuple)) and len(got) > slot:
                mask = _as_mask(got[slot])
            if mask is None:
                mask = _as_mask(got)
            if mask is None:
                continue
            chose = {k: v for k, v in kwargs.items() if not torch.is_tensor(v)}
            print(f"[RedNode Paint] subject mask made with {name} {chose}", flush=True)
            return mask.clamp(0.0, 1.0), name, identity
        except Exception as e:
            # LOUD, and named. This was one quiet line, so when the best segmenter
            # failed on a missing argument the next one answered instead and the only
            # evidence was a mask that looked wrong. A silent fallback to a worse tool
            # is indistinguishable from the good tool being bad at its job.
            print(f"[RedNode Paint] WARNING: {name} could not make a mask "
                  f"({type(e).__name__}: {e}). Falling back to a lesser segmenter, so "
                  "the result will be worse than this model can do.", flush=True)
    print("[RedNode Paint] no segmenter is installed, so auto masking has nothing to "
          f"drive. {INSTALL_HINT}", flush=True)
    return None, "", None


def subject_mask(image):
    """A subject mask [1,H,W] in 0..1 from the installed segmenter, or None.

    1.0 means subject. The caller inverts for a background mask, so there is one code
    path and the inversion is visible at the point it is decided.
    """
    mask, used, _identity = _subject_mask_prepared(_prepared_segmenters(image))
    return mask, used


def _source_cache_key(source):
    """Normalise a gallery filename while retaining filename-based cache semantics."""
    return os.path.normcase(os.path.normpath(str(source)))


def _cached_mask_exists(name):
    """Only accept a remembered file that still lives below ComfyUI's input folder."""
    try:
        root = os.path.realpath(folder_paths.get_input_directory())
        parts = str(name).replace("\\", "/").split("/")
        path = os.path.realpath(os.path.join(root, *parts))
        return os.path.commonpath((root, path)) == root and os.path.isfile(path)
    except (OSError, TypeError, ValueError):
        return False


def _cached_auto_mask(source, want, prepared):
    """Return a valid entry for the model currently configured to answer, if any."""
    source_key = _source_cache_key(source)
    candidates = tuple(item[3] for item in prepared)
    for _name, _cls, _kwargs, identity in prepared:
        key = (source_key, str(want), identity)
        remembered = _AUTO_MASK_CACHE.get(key)
        if remembered is None:
            continue
        # The answering model alone is the cache key, but the candidate chain is also
        # remembered. If a newly installed or reconfigured model now comes before the
        # old fallback, reusing the fallback would hide that change and hand back a
        # different mask from the one this press would otherwise produce.
        if remembered["candidates"] != candidates:
            continue
        if _cached_mask_exists(remembered["mask"]):
            print("[RedNode Paint] reusing the mask for this picture "
                  f"({remembered['used']})", flush=True)
            return remembered["mask"], remembered["covered"], remembered["used"]
        _AUTO_MASK_CACHE.pop(key, None)
    return None


def write_mask_png(mask, name_hint="auto"):
    """Write a mask as the brush writes one, and return its gallery entry.

    Same convention as the panel: PAINTED IS TRANSPARENT, which is what load_mask reads
    back as 1 - alpha. Writing it any other way would make an auto mask mean the
    opposite of a painted one.

    UNFEATHERED on purpose. Export feathers when the mask is handed to a renderer, so
    softening it here would blur an already-blurred edge and the region would creep.
    """
    m = mask[0] if mask.ndim == 3 else mask
    arr = (m.detach().cpu().clamp(0.0, 1.0).numpy() * 255.0).astype(np.uint8)
    h, w = arr.shape
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[..., 3] = 255 - arr                       # painted -> transparent
    folder = os.path.join(folder_paths.get_input_directory(),
                          _ws.MANAGED_SUBFOLDER, "paint")
    os.makedirs(folder, exist_ok=True)
    fname = f"{name_hint}_{time.strftime('%Y%m%d-%H%M%S')}_{int(time.time() * 1000) % 1000}.png"
    Image.fromarray(rgba, "RGBA").save(os.path.join(folder, fname))
    return f"{_ws.MANAGED_SUBFOLDER}/paint/{fname}"


def auto_mask(source, want="background"):
    """The mask file for `source`, as a gallery entry. Raises with a readable reason."""
    if str(want) not in WANTS:
        raise ValueError(f"want must be one of {', '.join(WANTS)}")
    image = _ws.load_image(source, 0)                # 0 = its own size, no resize
    prepared = _prepared_segmenters(image)
    remembered = _cached_auto_mask(source, want, prepared)
    if remembered is not None:
        return remembered
    mask, used, identity = _subject_mask_prepared(prepared)
    if mask is None:
        raise ValueError("no segmenter is installed. " + INSTALL_HINT)
    if mask.shape[1:] != image.shape[1:3]:
        mask = torch.nn.functional.interpolate(
            mask.unsqueeze(1), size=(image.shape[1], image.shape[2]),
            mode="bilinear", align_corners=False).squeeze(1)
    covered = float(mask.mean())
    if covered < 0.001:
        raise ValueError("the segmenter found no subject in this picture")
    if want == "background":
        mask = 1.0 - mask
    # `used` travels back so the panel can name what answered. A fallback to a lesser
    # segmenter should be visible on screen, not only in a console line nobody reads.
    filename = write_mask_png(mask, want)
    _AUTO_MASK_CACHE[(_source_cache_key(source), str(want), identity)] = {
        "mask": filename,
        "covered": covered,
        "used": used,
        "candidates": tuple(item[3] for item in prepared),
    }
    return filename, covered, used


def cut_out(source, mask_name, invert=False):
    """Write the masked part of `source` as a PNG with everything else transparent.

    Written as a FILE rather than handed back as an IMAGE, and that is the whole point:
    a ComfyUI IMAGE is three channels, so a cutout sent down a wire arrives with its
    alpha discarded and a black background where the transparency was. The file keeps
    it, and a PNG is the only format here that can.

    Lands in the output folder, so it is beside everything else a run produced and the
    Save node can file it from there.
    """
    image = _ws.load_image(source, 0)
    if not mask_name:
        raise ValueError("there is no mask to cut with. Paint one, or press Mask "
                         "background or Mask subject first.")
    mask = _ws.load_mask(mask_name, (image.shape[1], image.shape[2]))
    if invert:
        mask = 1.0 - mask
    if float(mask.max()) < 0.01:
        raise ValueError("the mask is empty, so a cut would be a fully transparent "
                         "picture")
    rgb = (image[0].detach().cpu().clamp(0.0, 1.0).numpy() * 255.0).astype(np.uint8)
    alpha = (mask[0].detach().cpu().clamp(0.0, 1.0).numpy() * 255.0).astype(np.uint8)
    rgba = np.dstack([rgb[..., :3], alpha])
    folder = os.path.join(folder_paths.get_output_directory(), "cutouts")
    os.makedirs(folder, exist_ok=True)
    stem = os.path.splitext(os.path.basename(str(source)))[0][:40] or "cut"
    fname = f"{stem}_cut_{time.strftime('%Y%m%d-%H%M%S')}.png"
    Image.fromarray(rgba, "RGBA").save(os.path.join(folder, fname))
    covered = float(mask.mean())
    return {"filename": fname, "subfolder": "cutouts", "type": "output"}, covered


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/auto_mask")
    async def _rednode_auto_mask(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        source = str(data.get("source") or "")
        want = str(data.get("want") or "background")
        if not source:
            return web.json_response({"error": "no picture to mask"}, status=400)
        try:
            name, covered, used = auto_mask(source, want)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response(
                {"error": f"the segmenter failed ({e})"}, status=500)
        print(f"[RedNode Paint] auto {want} mask for {source}: {name} "
              f"({covered * 100:.0f}% of the frame is subject, via {used})", flush=True)
        return web.json_response({"mask": name, "subject": covered, "used": used})

    @PromptServer.instance.routes.post("/rednode/cut")
    async def _rednode_cut(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        source = str(data.get("source") or "")
        mask_name = str(data.get("mask") or "")
        if not source:
            return web.json_response({"error": "no picture to cut"}, status=400)
        try:
            entry, covered = cut_out(source, mask_name, bool(data.get("invert")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": f"the cut failed ({e})"}, status=500)
        print(f"[RedNode Paint] cut {entry['subfolder']}/{entry['filename']} "
              f"({covered * 100:.0f}% of the frame kept, the rest transparent)",
              flush=True)
        return web.json_response({"result": entry, "kept": covered})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] auto-mask HTTP route not registered: {e}", flush=True)
