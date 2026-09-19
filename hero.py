"""RedNode Hero Creator: a clean subject reference out of any photograph.

A subject reference carries its clothing into every generation. A photo in a
pageant sash puts the sash on her in a tennis match. Three fixes were measured
(hub IDEAS.md, 2026-08-02) and cropping to head and neck beat both prompting the
clothing away and generating a studio headshot: real pixels, no generational
loss, and the clothing gone because it is out of frame.

So this is mostly a cropper, and that is deliberate. It finds the head, cuts
above the garment, drops the background and enlarges a small face. Nothing here
goes through a sampler, so nothing here can soften a face.

What it does NOT do is repair. Where a crop cannot win on its own, because the
face is behind a swim cap or a hand, a front on regeneration is needed and that
costs likeness in proportion to how little real detail the source had. That pass
is a separate job with a rig attached; this module reports WHY one is needed and
leaves the decision alone.

Measured behaviour behind the constants is in the hub's HERO_CREATOR.md.
"""

import contextlib
import os
import time

import numpy as np
import torch
from PIL import Image

import folder_paths
import nodes as _core          # the core node classes, by name

from . import workspace as _ws
from .automask import INSTALL_HINT, _prepared_segmenters, _subject_mask_prepared
from .refine_pipeline import _sam3_mask, _vosr2

# What SAM3 is asked for. Four questions, not one: the head and the hair decide
# the crop, the occluders decide whether a crop can win at all, and the garment
# decides where to cut. Guessing the garment line from a fraction of the face
# height was tried and it is wrong for a headdress and wrong again for a high
# collar, so it is measured instead.
HEAD = "head"
HAIR = "hair"
OCCLUDERS = "hand, goggles, swim cap, hat, headdress, sunglasses, visor"
GARMENT = "shirt, dress, costume, swimsuit, collar, necklace, strap"

WORKING = 768          # under this on the short edge, the crop is enlarged
FLOOR = 400            # under this, a regenerated face drifts; say so, do not hide it
NECK = 0.15            # how far below the chin to cut, as a fraction of FACE height
SIDE_PAD = 0.08        # breathing room beside the ears
TOP_PAD = 0.10         # and above the hair
THRESHOLD = 0.35

# Below this share of the head area, the hair is treated as not visible and has
# to be invented. Measured with the OCCLUDERS taken out, because SAM3 returns a
# swim cap as hair: a capped head scored 0.28 and the check that exists to catch
# exactly that case never fired.
HAIR_MIN = 0.10
COVER_MAX = 0.08       # occluder over the head box, above which a crop cannot win


# Heroes already made, keyed by the source and the settings that shape the
# output. Making one runs SAM3 four times, a matting pass and often an upscale,
# so pressing the button twice on the same picture should cost nothing.
_HERO_CACHE = {}


def _source_key(source, sam_model, enlarge):
    """What makes two presses the SAME press.

    The filename alone is what automask keys on, and that is enough while
    pictures are only ever added. A gallery slot can be overwritten with a
    different photograph under the same name though, and a hero remembered by
    name alone would then be somebody else's face, which is the worst possible
    way for a cache to be wrong. So the file's size and mtime go in the key.
    """
    name = os.path.normcase(os.path.normpath(str(source)))
    size = mtime = 0
    try:
        st = os.stat(_ws._filepath(source))
        size, mtime = int(st.st_size), int(st.st_mtime)
    except Exception:
        pass                       # unreadable: fall back to the name, and re-run
    return (name, size, mtime, str(sam_model or ""), bool(enlarge))


def _cached_hero(key):
    """A remembered hero, but only while its file is still on disk."""
    got = _HERO_CACHE.get(key)
    if not got:
        return None
    entry = got["entry"]
    path = os.path.join(folder_paths.get_output_directory(),
                        entry.get("subfolder", ""), entry["filename"])
    if not os.path.isfile(path):
        _HERO_CACHE.pop(key, None)      # deleted from the output folder: make it again
        return None
    return got


@contextlib.contextmanager
def progress_safe():
    """Let nodes that report progress run outside a queue item.

    ComfyUI sets `last_prompt_id` on the server when a QUEUE ITEM starts, and its
    progress hook reads it back (main.py). A node called from an HTTP route runs
    outside any execution, so the attribute was never set and a node that
    reports progress dies on that rather than on anything to do with the
    picture: SAM3 came back as "'PromptServer' object has no attribute
    'last_prompt_id'", which names nothing a user could act on.

    Only what is MISSING is filled in, and it is taken back out afterwards, so a
    real execution running at the same time is never touched.
    """
    srv = None
    try:
        from server import PromptServer
        srv = PromptServer.instance
    except Exception:
        srv = None
    added = []
    if srv is not None:
        for attr, val in (("last_prompt_id", "rednode-hero"), ("last_node_id", None)):
            if not hasattr(srv, attr):
                setattr(srv, attr, val)
                added.append(attr)
    try:
        yield
    finally:
        for attr in added:
            try:
                delattr(srv, attr)
            except Exception:
                pass


def _mask_np(image, target, sam_model=""):
    """A boolean array for `target`, or None with the reason SAM3 gave."""
    mask, why = _sam3_mask(image, target, THRESHOLD, sam_model)
    if mask is None:
        return None, why
    arr = mask[0].detach().cpu().numpy()
    return arr > 0.4, None


def _box(m):
    """The tight bounding box of a boolean mask, or None when it is empty."""
    if m is None or not m.any():
        return None
    ys, xs = np.nonzero(m)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def crop_rect(head_box, hair_box, garment_top, w, h):
    """Where to cut. NOT square, and that matters.

    Forcing a square around the box centre pulls the bottom edge back below the
    chin: the hair widens the box, squaring grows it vertically to match, and a
    costume comes back into a crop whose whole purpose is to leave clothing out.
    The size of a centred square comes from its wider side, so no amount of
    anchoring the padding fixes it. Cut the rectangle where it belongs and pad it
    to square with white afterwards, once the background IS white.
    """
    x0, y0, x1, y1 = head_box
    chin, face_h = y1, y1 - y0
    if hair_box:                                   # a tall style must not be guillotined
        x0 = min(x0, hair_box[0])
        y0 = min(y0, hair_box[1])
        x1 = max(x1, hair_box[2])
    bottom = int(chin + face_h * NECK)
    # never above the chin: losing the jaw costs more likeness than a collar
    # costs, and a garment that high is a repair job rather than a crop
    if garment_top is not None:
        bottom = min(bottom, max(chin, garment_top - 2))
    side = int((x1 - x0) * SIDE_PAD)
    return (max(0, x0 - side), max(0, y0 - int(face_h * TOP_PAD)),
            min(w, x1 + side), min(h, bottom))


def _on_white(image, mask):
    """The subject over white. The background is SOLVED here, with no generation.

    Which is the point: a repair pass that also had to invent a backdrop would
    need a far higher denoise, and denoise is what costs a likeness.
    """
    rgb = image[0].detach().cpu().clamp(0.0, 1.0)
    m = mask[0].detach().cpu().clamp(0.0, 1.0).unsqueeze(-1)
    return rgb * m + (1.0 - m)


def _pad_square(arr):
    """Centre on a white square. White padding costs nothing and adds no photo."""
    h, w = arr.shape[0], arr.shape[1]
    if h == w:
        return arr
    s = max(h, w)
    out = np.ones((s, s, 3), dtype=arr.dtype)
    out[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = arr
    return out


def assess(head, hair, occ, head_box, crop_side):
    """Why a crop is or is not enough, split by what would FIX it.

    Enlarging is an upscaler and does not put a face through a sampler, so it
    must never be filed with the repairs. Conflating the two was the first
    version's mistake and it sent faces to a sampler that only needed pixels.
    """
    enlarge, repair = [], []
    if crop_side < WORKING:
        enlarge.append("the crop is %d px, under the %d working size"
                       % (crop_side, WORKING))
    head_px = max(1, int(head.sum()))
    cover = 0.0
    if occ is not None and occ.any() and head_box:
        x0, y0, x1, y1 = head_box
        cover = float(occ[y0:y1 + 1, x0:x1 + 1].sum()) / head_px
        if cover > COVER_MAX:
            repair.append("%d%% of the head is covered" % round(cover * 100))
    bare = (hair & ~occ) if (hair is not None and occ is not None) else hair
    hair_ratio = (float(bare.sum()) / head_px) if bare is not None else 0.0
    if hair_ratio < HAIR_MIN:
        repair.append("hair is %d%% of the head, treat it as not visible"
                      % round(hair_ratio * 100))
    return enlarge, repair, round(hair_ratio, 3), round(cover, 3)


def make_hero(source, sam_model="", enlarge=True, rebuild=False):
    """The lossless half: locate, crop, cut to white, enlarge. Returns (entry, report).

    Raises ValueError with a readable reason. Every caller of this is a person
    pressing a button, so a reason they can act on beats a traceback.
    """
    key = _source_key(source, sam_model, enlarge)
    if not rebuild:
        got = _cached_hero(key)
        if got is not None:
            print("[RedNode Hero] reusing the hero already made for this picture",
                  flush=True)
            # said out loud in the report: a panel that showed a cached result as
            # if it had just been made would hide a stale one for ever
            return got["entry"], dict(got["report"], reused=True)
    entry, report = None, None
    with progress_safe():
        entry, report = _make_hero(source, sam_model, enlarge)
    report["reused"] = False
    _HERO_CACHE[key] = {"entry": entry, "report": report}
    return entry, report


def crop_and_cut(image, sam_model=""):
    """Locate, crop above the garment, drop the background. On any picture.

    Used twice per hero when a front on render is asked for: once on the source,
    to make a clean reference, and again on the RENDER, because a full
    regeneration reinvents clothing every time and puts back exactly what the
    first crop removed.
    """
    h, w = int(image.shape[1]), int(image.shape[2])
    head, why = _mask_np(image, HEAD, sam_model)
    if head is None:
        raise ValueError(why or "SAM3 found no head in this picture")
    head_box = _box(head)
    if head_box is None:
        raise ValueError("SAM3 found no head in this picture. Try a photo where "
                         "the face is not turned away or cut off at the edge.")
    hair, _ = _mask_np(image, HAIR, sam_model)
    occ, _ = _mask_np(image, OCCLUDERS, sam_model)
    gar, _ = _mask_np(image, GARMENT, sam_model)
    gar_box = _box(gar)

    rect = crop_rect(head_box, _box(hair), gar_box[1] if gar_box else None, w, h)
    crop = image[:, rect[1]:rect[3], rect[0]:rect[2], :]
    if crop.shape[1] < 8 or crop.shape[2] < 8:
        raise ValueError("the head is too small in this picture to crop from")

    prepared = _prepared_segmenters(crop)
    sub, used, _identity = _subject_mask_prepared(prepared)
    if sub is None:
        raise ValueError("no segmenter is installed, and it is what drops the "
                         "background. " + INSTALL_HINT)
    if sub.shape[1:] != crop.shape[1:3]:
        sub = torch.nn.functional.interpolate(
            sub.unsqueeze(1), size=(crop.shape[1], crop.shape[2]),
            mode="bilinear", align_corners=False).squeeze(1)
    return _on_white(crop, sub), (head, hair, occ, head_box), used


def _save_hero(flat, source, tag="hero"):
    """Square it with white and write it beside every other hero."""
    arr = _pad_square(flat.detach().cpu().numpy())
    png = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
    folder = os.path.join(folder_paths.get_output_directory(), "heroes")
    os.makedirs(folder, exist_ok=True)
    stem = os.path.splitext(os.path.basename(str(source)))[0][:40] or "hero"
    fname = "%s_%s_%s.png" % (stem, tag, time.strftime("%Y%m%d-%H%M%S"))
    Image.fromarray(png, "RGB").save(os.path.join(folder, fname))
    return {"filename": fname, "subfolder": "heroes", "type": "output"}


# _vosr2 reads a whole PASS, not a multiplier: the loader's checkpoint and dtype,
# the DiT tile and the VAE tile and both overlaps, the colour alignment. Handing
# it only the scale failed as "VOSR2 failed: 'vosr2_model'", which reads like a
# missing model rather than a missing dictionary key. The values are the
# Detailer's own defaults (refine_pipeline.py:203-210); the two that name files
# are left empty, which means "whatever the node itself defaults to".
VOSR2_PASS = {
    "vosr2_model": "", "vosr2_dtype": "", "vosr2_color": "wavelet",
    "vosr2_tile": 512, "vosr2_tile_overlap": 32,
    "vosr2_vae_tile": 1024, "vosr2_vae_overlap": 32,
}


def _enlarge(flat):
    """VOSR2 up to the working size. An upscaler, so it costs no likeness."""
    side = min(int(flat.shape[0]), int(flat.shape[1]))
    if side >= WORKING:
        return flat, side, ""
    mult = min(8, max(2, -(-WORKING // max(1, side))))
    up, why_up = _vosr2(flat.unsqueeze(0), dict(VOSR2_PASS, vosr2_scale=mult), 0)
    if up is None:
        return flat, side, "not enlarged: %s" % why_up
    return up[0], side, "VOSR2 x%d" % mult


def _make_hero(source, sam_model, enlarge):
    image = _ws.load_image(source, 0)               # 0 = its own size, no resize
    h, w = int(image.shape[1]), int(image.shape[2])
    flat, (head, hair, occ, head_box), used = crop_and_cut(image, sam_model)
    grew = ""
    side = min(int(flat.shape[0]), int(flat.shape[1]))
    if enlarge:
        flat, side, grew = _enlarge(flat)
    entry = _save_hero(flat, source)
    fname = entry["filename"]

    en, rep, hair_ratio, cover = assess(head, hair, occ, head_box, side)
    report = {
        "crop_side": side, "source_size": [w, h], "hair_ratio": hair_ratio,
        "cover": cover, "enlarge": en, "repair": rep, "enlarged": grew,
        "segmenter": used,
        # A crop under the floor has too little real detail for a regeneration to
        # hold a likeness, so the warning is attached here rather than discovered
        # afterwards by looking at a stranger.
        "below_floor": side < FLOOR,
        "route": "repair" if rep else ("enlarge" if en else "crop only"),
    }
    return entry, report


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/hero")
    async def _rednode_hero(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        source = str(data.get("source") or "")
        if not source:
            return web.json_response({"error": "no picture to work from"}, status=400)
        try:
            entry, report = make_hero(source, str(data.get("sam_model") or ""),
                                      bool(data.get("enlarge", True)),
                                      bool(data.get("rebuild")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": "the hero failed (%s)" % e}, status=500)
        if not report.get("reused"):
            print("[RedNode Hero] %s/%s %s, %d px%s"
                  % (entry["subfolder"], entry["filename"], report["route"],
                     report["crop_side"],
                     ", " + report["enlarged"] if report["enlarged"] else ""), flush=True)
        return web.json_response({"result": entry, "report": report})

    @PromptServer.instance.routes.post("/rednode/hero_front")
    async def _rednode_hero_front(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        source = str(data.get("source") or "")
        if not source:
            return web.json_response({"error": "no picture to work from"}, status=400)
        try:
            entry, report = make_front(source,
                                       str(data.get("unet") or ""),
                                       str(data.get("clip") or ""),
                                       str(data.get("vae") or ""),
                                       str(data.get("lora") or ""),
                                       str(data.get("sam_model") or ""))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": "the render failed (%s)" % e}, status=500)
        print("[RedNode Hero] %s/%s front-on render from a %s px crop"
              % (entry["subfolder"], entry["filename"], report.get("from_crop")),
              flush=True)
        return web.json_response({"result": entry, "report": report})

except Exception:                     # no server (tests, or a bare import): fine
    pass


# ---- the front on render ------------------------------------------------------------
# The crop is lossless and stops here for most pictures. Where it cannot win, because
# the face is behind a cap or a hand or turned away, the head has to be REBUILT, and
# that is a different bargain: the occluder goes and the pose comes front on, but the
# face is generated rather than kept. Measured: a 562 px crop came back nearly
# identical to its source, a 161 px crop came back a different person. Hence FLOOR.

FRONT = ("facing the camera directly, front view, head on, symmetrical, looking "
         "straight into the lens, neutral closed mouth, bare shoulders, no clothing, "
         "plain white background, even soft studio lighting")
SYSTEM = ("A plain front-facing studio headshot of the person in the reference. "
          "Even soft lighting, neutral expression, plain white background.")
# 2.0 holds the original pose, because the pose lives in the reference and boost IS
# adherence to it. 1.0 lets the head come front on, which is the whole job here.
FRONT_BOOST = 1.0
FRONT_STEPS = 8
FRONT_CFG = 1.0


def front_prompt(repair):
    """The instruction, built from the reasons the crop lost.

    Naming the actual job beats one generic studio line: "no swim cap" belongs in
    the prompt only when there IS one. The hair clause describes HAIR and never
    the absence of a hat, because "bare head" reads as bare scalp and came back
    shaved.
    """
    bits = []
    for r in repair or []:
        if "hair" in r:
            bits.append("a full head of natural hair, hairline visible, hair covering "
                        "the scalp, nothing worn on the head")
        if "covered" in r:
            bits.append("nothing covering the face, nothing held up beside the head")
    return ", ".join(bits + [FRONT])


# Every core node used by the render, by the name ComfyUI knows it as. Kept in
# one place so a test can check they all exist rather than finding out mid-render.
RENDER_NODES = ("UNETLoader", "LoraLoaderModelOnly", "CLIPLoader", "VAELoader",
                "EmptyLatentImage", "CLIPTextEncode", "KSampler", "VAEDecode")


def _run(name, **kw):
    """Call a core node through the entry point IT declares.

    Not a hardcoded method name. A node's callable is named by its own FUNCTION
    attribute, and hardcoding "load_unet" here would break silently the day core
    renamed it, in the middle of a render rather than at import.
    """
    cls = _core.NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise ValueError("this ComfyUI has no %s node, so the render cannot be built"
                         % name)
    fn = getattr(cls(), getattr(cls, "FUNCTION", "") or "", None)
    if fn is None:
        raise ValueError("the %s node has no callable entry point in this ComfyUI"
                         % name)
    return fn(**kw)


def make_front(source, unet="", clip="", vae="", lora="", sam_model=""):
    """Rebuild the head front on, then crop and cut the render.

    Step 6 is not optional. A full regeneration reinvents clothing every time, so
    the crop that took the garment out has to run again on the OUTPUT or the hero
    comes back in a collar.
    """
    if not (unet and clip and vae):
        raise ValueError("the front-on render needs a model, a text encoder and a "
                         "VAE from the active rig. Set them on the Models tab.")
    if not lora:
        raise ValueError("the front-on render works through a Krea 2 edit LoRA, and "
                         "none is switched on in the LoRAs tab. Without it the "
                         "reference steers nothing and the face comes back a stranger.")

    entry, report = make_hero(source, sam_model, True)
    with progress_safe():
        base = _ws.load_image("%s/%s [output]" % (entry["subfolder"], entry["filename"]), 0)

        # imported HERE, not at module level: identity.py needs
        # comfy.text_encoders.krea2, which an older core does not have, and an
        # unguarded import at the top took the whole pack down with it on one.
        from .identity import Krea2IdentityEdit

        model = _run("UNETLoader", unet_name=unet, weight_dtype="default")[0]
        model = _run("LoraLoaderModelOnly", model=model, lora_name=lora,
                     strength_model=1.0)[0]
        cl = _run("CLIPLoader", clip_name=clip, type="krea2")[0]
        va = _run("VAELoader", vae_name=vae)[0]

        side = int(base.shape[1])
        latent = _run("EmptyLatentImage", width=side, height=side, batch_size=1)[0]
        pos = Krea2IdentityEdit().encode(
            clip=cl, prompt=front_prompt(report.get("repair")), vae=va, image=base,
            grounding_px=side, ref_boost=FRONT_BOOST, ref_boost_a=FRONT_BOOST,
            target_latent=latent, fit_mode="fit", ref_t0_modulation=False,
            system_prompt=SYSTEM)[0]
        neg = _run("CLIPTextEncode", clip=cl, text="")[0]
        out = _run("KSampler", model=model, seed=7000, steps=FRONT_STEPS, cfg=FRONT_CFG,
                   sampler_name="euler", scheduler="simple", positive=pos, negative=neg,
                   latent_image=latent, denoise=1.0)[0]
        render = _run("VAEDecode", samples=out, vae=va)[0]

        flat, (head, hair, occ, head_box), used = crop_and_cut(render, sam_model)
        final = _save_hero(flat, source, "front")

    fside = min(int(flat.shape[0]), int(flat.shape[1]))
    en, rep, hair_ratio, cover = assess(head, hair, occ, head_box, fside)
    return final, {
        "crop_side": fside, "hair_ratio": hair_ratio, "cover": cover,
        "enlarge": en, "repair": rep, "enlarged": "", "segmenter": used,
        "below_floor": report.get("crop_side", 0) < FLOOR,
        "route": "front-on render", "generated": True,
        "from_crop": report.get("crop_side"),
        "prompt": front_prompt(report.get("repair")),
    }
