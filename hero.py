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

import os
import time

import numpy as np
import torch
from PIL import Image

import folder_paths

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


def make_hero(source, sam_model="", enlarge=True):
    """The lossless half: locate, crop, cut to white, enlarge. Returns (entry, report).

    Raises ValueError with a readable reason. Every caller of this is a person
    pressing a button, so a reason they can act on beats a traceback.
    """
    image = _ws.load_image(source, 0)               # 0 = its own size, no resize
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
    flat = _on_white(crop, sub)

    side = min(int(flat.shape[0]), int(flat.shape[1]))
    grew = ""
    if enlarge and side < WORKING:
        mult = min(8, max(2, -(-WORKING // max(1, side))))
        up, why_up = _vosr2(flat.unsqueeze(0), {"vosr2_scale": mult}, 0)
        if up is not None:
            flat = up[0]
            grew = "VOSR2 x%d" % mult
        else:
            grew = "not enlarged: %s" % why_up

    arr = _pad_square(flat.detach().cpu().numpy())
    png = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
    folder = os.path.join(folder_paths.get_output_directory(), "heroes")
    os.makedirs(folder, exist_ok=True)
    stem = os.path.splitext(os.path.basename(str(source)))[0][:40] or "hero"
    fname = "%s_hero_%s.png" % (stem, time.strftime("%Y%m%d-%H%M%S"))
    Image.fromarray(png, "RGB").save(os.path.join(folder, fname))

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
    return {"filename": fname, "subfolder": "heroes", "type": "output"}, report


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
                                      bool(data.get("enlarge", True)))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": "the hero failed (%s)" % e}, status=500)
        print("[RedNode Hero] %s/%s %s, %d px%s"
              % (entry["subfolder"], entry["filename"], report["route"],
                 report["crop_side"],
                 ", " + report["enlarged"] if report["enlarged"] else ""), flush=True)
        return web.json_response({"result": entry, "report": report})

except Exception:                     # no server (tests, or a bare import): fine
    pass
