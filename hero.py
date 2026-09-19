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
import hashlib
import io
import json
import os
import re
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
    path = os.path.join(folder_paths.get_input_directory(),
                        *(entry.get("subfolder", "") or "").split("/"),
                        entry["filename"])
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


# Where a hero is written. The INPUT folder, not the output one, and that is the
# whole of the persistence story: the gallery is backed by input, so a hero
# written to output was never a gallery picture. It looked like one until a
# restart, and then the slot pointed at nothing.
HERO_DIR = "rednode/heroes"
MANIFEST = "set.json"


def set_folder(source):
    """One folder per gallery picture: "<readable name>_<hash>".

    The hash is of the WHOLE entry, not the file's name. "people/anna.png" and
    "refs/anna.png" are two different pictures and a folder named for the stem
    alone would have them overwrite each other. The readable half is there so
    the folder can be browsed and recognised, which is the point of having
    folders at all.
    """
    entry = str(source)
    stem = os.path.splitext(os.path.basename(entry))[0][:40]
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", stem).strip("_") or "hero"
    short = hashlib.md5(entry.encode("utf-8")).hexdigest()[:8]
    return "%s/%s_%s" % (HERO_DIR, stem, short)


def _abs_set(sub):
    return os.path.join(folder_paths.get_input_directory(), *sub.split("/"))


def read_manifest(sub):
    try:
        with io.open(os.path.join(_abs_set(sub), MANIFEST), encoding="utf-8") as f:
            got = json.load(f)
        return got if isinstance(got, dict) else {}
    except Exception:
        return {}


def _write_manifest(sub, source, kind, fname, report):
    """Record what this folder holds, beside what it holds.

    So the folder is self-describing and the set can be rebuilt by reading the
    disk. The workflow's copy is then a cache rather than the only record: a
    fresh workflow, or one whose properties were lost, can still find every
    picture that was made and say which gallery entry each came from.
    """
    man = read_manifest(sub) or {}
    man["source"] = str(source)
    if kind == "edit":
        man.setdefault("edits", [])
        man["edits"].append({"filename": fname, "report": report})
    else:
        man[kind] = {"filename": fname, "report": report}
        if kind == "crop":
            # a new crop invalidates both: they were made from the old one
            man.pop("front", None)
            man["edits"] = []
    try:
        with io.open(os.path.join(_abs_set(sub), MANIFEST), "w", encoding="utf-8") as f:
            json.dump(man, f, indent=2)
    except Exception as exc:                 # the pictures matter, the note does not
        print("[RedNode Hero] could not write %s: %s" % (MANIFEST, exc), flush=True)


def _save_hero(flat, source, tag="crop", report=None):
    """Square it with white and write it into this picture's own folder.

    The crop and the front-on have FIXED names, because there is one of each and
    remaking one replaces it: a timestamped name would leave the old file behind
    as an orphan every time. Changes are timestamped, because there are many and
    each one is kept.
    """
    arr = _pad_square(flat.detach().cpu().numpy())
    png = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
    sub = set_folder(source)
    os.makedirs(_abs_set(sub), exist_ok=True)
    fname = ("edit_%s.png" % time.strftime("%Y%m%d-%H%M%S")) if tag == "edit" \
        else "%s.png" % tag
    Image.fromarray(png, "RGB").save(os.path.join(_abs_set(sub), fname))
    _write_manifest(sub, source, tag, fname, report or {})
    # rand busts the browser's cache: crop.png keeps its name when remade, so
    # without it the panel would show the previous one for ever
    return {"filename": fname, "subfolder": sub, "type": "input",
            "rand": int(time.time() * 1000) % 1000000000}


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
    # written AFTER the report, so the folder's note carries it and the set can
    # be rebuilt from disk with its chips intact
    return _save_hero(flat, source, "crop", report), report


def make_edit(base_entry, want, unet="", clip="", vae="", lora="", sam_model="",
              source="hero", seed=0, override=False):
    """A changed version of an already finished hero.

    Runs on the FRONT-ON picture, not on the source photograph and not folded
    into the front-on render itself. Two reasons. It is the cleanest picture in
    the chain, already front on and already cut out, so the change is the only
    thing being asked for. And keeping it separate means the front-on stays a
    single fixed picture while the changes pile up beside it, which is what a
    person comparing blue hair against grey actually needs.

    Every call writes a NEW file. A change is a variant, not a correction.
    """
    if not str(want or "").strip():
        raise ValueError("there is nothing to change. Pick a hair, eye or age "
                         "change, or type one, and press again.")
    if not (unet and clip and vae):
        raise ValueError("the change needs a model, a text encoder and a VAE from "
                         "the active rig. Set them on the Models tab.")
    if not lora:
        raise ValueError("the change works through a Krea 2 edit LoRA, and none is "
                         "switched on in the LoRAs tab.")
    if not (base_entry or {}).get("filename"):
        raise ValueError("make the front-on picture first: a change is made from it.")

    try:
        return _edit(base_entry, want, unet, clip, vae, lora, sam_model, source, seed,
                     bool(override))
    except Exception as exc:
        # a traceback keeps the frame that holds the models alive
        _settle()
        raise ValueError(str(exc) or exc.__class__.__name__) from None


def _edit(base_entry, want, unet, clip, vae, lora, sam_model, source, seed,
          override=False):
    with progress_safe():
        base = _ws.load_image("%s/%s" % (base_entry.get("subfolder", ""),
                                         base_entry["filename"]), 0)
        # OVERRIDE means override. The framing clause goes, and so does the
        # system prompt: leaving "a plain front-facing studio headshot" in place
        # while claiming the words are yours would be steering from behind.
        prompt = str(want).strip() if override             else "%s, %s" % (str(want).strip(), FRONT)
        render = _render_front(base, prompt, unet, clip, vae, lora, seed=seed,
                               system="" if override else None)
        try:
            flat, (head, hair, occ, head_box), used = crop_and_cut(render, sam_model)
        except ValueError:
            # An override can produce something with no head in it, and that is
            # the point of it. Erroring there would punish the feature for doing
            # what it was asked; the raw picture is handed back instead.
            if not override:
                raise
            flat = render[0]
            head = hair = occ = None
            head_box = None
            used = "no crop: the override's picture was kept whole"
        render = None
        _settle()

    side = min(int(flat.shape[0]), int(flat.shape[1]))
    if head is None:
        en, rep, hair_ratio, cover = [], [], 0.0, 0.0
    else:
        en, rep, hair_ratio, cover = assess(head, hair, occ, head_box, side)
    out = {
        "crop_side": side, "hair_ratio": hair_ratio, "cover": cover,
        "enlarge": en, "repair": rep, "enlarged": "", "segmenter": used,
        "below_floor": False, "route": "edit", "generated": True,
        "override": bool(override),
        "extra": str(want).strip(), "prompt": prompt, "seed": seed,
    }
    return _save_hero(flat, source, "edit", out), out


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
                                       str(data.get("sam_model") or ""),
                                       str(data.get("extra") or ""))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": "the render failed (%s)" % e}, status=500)
        print("[RedNode Hero] %s/%s front-on render from a %s px crop"
              % (entry["subfolder"], entry["filename"], report.get("from_crop")),
              flush=True)
        return web.json_response({"result": entry, "report": report})

    @PromptServer.instance.routes.post("/rednode/hero_edit")
    async def _rednode_hero_edit(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        try:
            entry, report = make_edit(data.get("base") or {},
                                      str(data.get("extra") or ""),
                                      str(data.get("unet") or ""),
                                      str(data.get("clip") or ""),
                                      str(data.get("vae") or ""),
                                      str(data.get("lora") or ""),
                                      str(data.get("sam_model") or ""),
                                      str(data.get("source") or "hero"),
                                      int(data.get("seed") or 0),
                                      bool(data.get("override")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": "the change failed (%s)" % e}, status=500)
        print("[RedNode Hero] %s/%s edit: %s"
              % (entry["subfolder"], entry["filename"], report.get("extra")), flush=True)
        return web.json_response({"result": entry, "report": report})

    @PromptServer.instance.routes.get("/rednode/hero_sets")
    async def _rednode_hero_sets(request):
        """Every set on disk, keyed by the gallery picture it was made from.

        The workflow keeps its own copy, but this is the one that survives a
        fresh workflow or lost properties: each folder says which entry it came
        from, so the index is rebuildable rather than authoritative.
        """
        root = os.path.join(folder_paths.get_input_directory(), *HERO_DIR.split("/"))
        out = {}
        try:
            names = sorted(os.listdir(root))
        except Exception:
            names = []
        for name in names:
            sub = "%s/%s" % (HERO_DIR, name)
            if not os.path.isdir(_abs_set(sub)):
                continue
            man = read_manifest(sub)
            src = str(man.get("source") or "")
            if not src:
                continue
            def one(rec):
                if not rec or not rec.get("filename"):
                    return None
                # only what is still THERE: a note outliving its picture would
                # put a dead slot on the card
                if not os.path.isfile(os.path.join(_abs_set(sub), rec["filename"])):
                    return None
                return {"result": {"filename": rec["filename"], "subfolder": sub,
                                   "type": "input"},
                        "report": rec.get("report") or {}}
            crop = one(man.get("crop"))
            if not crop:
                continue                      # no crop, no set
            out[src] = {"crop": crop, "front": one(man.get("front")),
                        "edits": [e for e in (one(x) for x in man.get("edits") or [])
                                  if e]}
        return web.json_response({"sets": out})

    @PromptServer.instance.routes.post("/rednode/hero_drop")
    async def _rednode_hero_drop(request):
        """Delete one picture this pack made. Only ever one of ours: the path is
        rebuilt from the hero folder, so nothing outside it can be named."""
        try:
            data = await request.json()
        except Exception:
            data = {}
        name = os.path.basename(str(data.get("filename") or ""))
        sub = str(data.get("subfolder") or "")
        if not name:
            return web.json_response({"error": "no picture named"}, status=400)
        # rebuilt from the hero root, so nothing outside it can be named however
        # the request is phrased
        if not sub.startswith(HERO_DIR + "/") or "/../" in sub or sub.endswith("/.."):
            return web.json_response({"error": "that is not a hero folder"}, status=400)
        path = os.path.join(_abs_set(sub), name)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except Exception as e:
            return web.json_response({"error": "could not delete it (%s)" % e},
                                     status=500)
        man = read_manifest(sub)
        if man:
            man["edits"] = [e for e in (man.get("edits") or [])
                            if e.get("filename") != name]
            try:
                with io.open(os.path.join(_abs_set(sub), MANIFEST), "w",
                             encoding="utf-8") as f:
                    json.dump(man, f, indent=2)
            except Exception:
                pass
        print("[RedNode Hero] deleted %s/%s" % (sub, name), flush=True)
        return web.json_response({"deleted": name})

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


def front_prompt(repair, extra=""):
    """The instruction, built from the reasons the crop lost, plus anything asked.

    Naming the actual job beats one generic studio line: "no swim cap" belongs in
    the prompt only when there IS one. The hair clause describes HAIR and never
    the absence of a hat, because "bare head" reads as bare scalp and came back
    shaved.
    """
    # What was ASKED for goes first. Later clauses were the ones that failed to
    # bite in testing, and a change of hair or age that quietly did not happen is
    # worse than one that did: the picture looks fine and is not what was wanted.
    bits = [str(extra).strip()] if str(extra or "").strip() else []
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


def _settle():
    """Collect, then let ComfyUI release whatever is now unreferenced."""
    import gc

    gc.collect()
    try:
        import comfy.model_management as _mm
        _mm.soft_empty_cache()
    except Exception:
        pass


def _render_front(base, want, unet, clip, vae, lora, seed=7000, system=None):
    """The render, in a frame of its own, returning only the picture.

    Its own function so that EVERY handle it takes on a model, a CLIP, a VAE, a
    conditioning or a latent dies with the frame when it returns. A model loaded
    inside an HTTP route is outside the executor's lifecycle, so nothing else
    will ever let go of it: model_management then finds a live reference each
    time it tries to evict and says "WARNING, memory leak with model Krea2",
    once per model per eviction, for the rest of the session.

    Clearing the names in a finally block does not do this. Assigning over
    locals() has no effect in CPython, and a hand written del list goes stale the
    first time the render gains a variable.
    """
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
        clip=cl, prompt=want, vae=va, image=base, grounding_px=side,
        ref_boost=FRONT_BOOST, ref_boost_a=FRONT_BOOST, target_latent=latent,
        fit_mode="fit", ref_t0_modulation=False,
        system_prompt=SYSTEM if system is None else system)[0]
    neg = _run("CLIPTextEncode", clip=cl, text="")[0]
    out = _run("KSampler", model=model, seed=int(seed) or 7000,
               steps=FRONT_STEPS, cfg=FRONT_CFG,
               sampler_name="euler", scheduler="simple", positive=pos, negative=neg,
               latent_image=latent, denoise=1.0)[0]
    return _run("VAEDecode", samples=out, vae=va)[0]


def make_front(source, unet="", clip="", vae="", lora="", sam_model="", extra=""):
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
    try:
        return _front(entry, report, source, unet, clip, vae, lora, sam_model, extra)
    except Exception as exc:
        # a traceback keeps the frame that holds the models alive, so the reason
        # is carried out and the traceback is dropped
        _settle()
        raise ValueError(str(exc) or exc.__class__.__name__) from None


def _front(entry, report, source, unet, clip, vae, lora, sam_model, extra=""):
    with progress_safe():
        base = _ws.load_image("%s/%s" % (entry["subfolder"], entry["filename"]), 0)

        render = _render_front(base, front_prompt(report.get("repair")),
                               unet, clip, vae, lora)
        flat, (head, hair, occ, head_box), used = crop_and_cut(render, sam_model)
        render = None
        _settle()

    fside = min(int(flat.shape[0]), int(flat.shape[1]))
    en, rep, hair_ratio, cover = assess(head, hair, occ, head_box, fside)
    out = {
        "crop_side": fside, "hair_ratio": hair_ratio, "cover": cover,
        "enlarge": en, "repair": rep, "enlarged": "", "segmenter": used,
        "below_floor": report.get("crop_side", 0) < FLOOR,
        "route": "front-on render", "generated": True,
        "from_crop": report.get("crop_side"),
        "prompt": front_prompt(report.get("repair"), extra),
        "extra": str(extra or "").strip(),
    }
    return _save_hero(flat, source, "front", out), out
