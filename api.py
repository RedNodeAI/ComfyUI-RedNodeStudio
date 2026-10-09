"""RedNode Studio's API for other packs: the calls RedNode Video Studio builds its cast sheets from, and the Post FX
chain for a clip (grade_video, API_VERSION 2).

Frozen signatures under API_VERSION; a change that breaks a caller bumps it. Everything here wraps code the
Hero Creator already runs: the segmenter cut to white, VOSR2, and the Krea 2 Identity render. The one new
piece is the render's frame shape: a standing figure needs a tall frame, where the headshot is square.

A character sheet keeps the costume, the opposite of the headshot: for a film character the clothes are part
of who they are, so only the background is removed.
"""
import numpy as np
import torch
from PIL import Image

from . import hero as _hero
from .automask import INSTALL_HINT, _prepared_segmenters, _subject_mask_prepared

API_VERSION = 3          # 2: grade_video; 3: refresh_frame

PANEL = (768, 1152)            # one standing figure, 2:3, multiples of 16
MARGIN = 0.05                  # white above the head and below the feet, as a share of the panel height
FIGURE_FLOOR = 900             # a figure shorter than this is enlarged with VOSR2 before it is laid out
STEPS = 8
POLISH = 0.25                  # the second, low-denoise pass that pulls face and fabric back to the source
BOOST = 1.0                    # 1.0 lets the body turn; 2.0 holds the source pose (Hero measurements)

SYSTEM = ("A full-body studio reference of the person in the reference image, head to feet, keeping their face, "
          "hair and outfit. Plain white background, even soft studio lighting.")
LOOK = "the same person, same face and hair, full body from head to feet, standing"
BACKDROP = "plain white background, even soft studio lighting"
# three quarter and profile always face right: a sheet whose turns go both ways reads as two people
ANGLES = {
    "Front": "front view, facing the camera directly, arms relaxed at the sides",
    "Three Quarter": "three-quarter view, body and face turned to the right of the picture at 45 degrees",
    "Profile": "side view in profile, facing the right edge of the picture",
    "Back": "back view, seen from behind, facing away from the camera",
}


def _check(files):
    files = files or {}
    if not (files.get("unet") and files.get("clip") and files.get("vae")):
        raise ValueError("the sheet render needs a Krea 2 model, text encoder and VAE")
    if not files.get("lora"):
        raise ValueError("the sheet render works through the Krea 2 Identity Edit LoRA; choose it first")
    return files


def figure_mask(image):
    """[H,W] float mask of the figure, from the same segmenters the Hero cut uses."""
    with _hero.progress_safe():
        prepared = _prepared_segmenters(image)
        sub, used, _identity = _subject_mask_prepared(prepared)
    if sub is None:
        raise ValueError("no segmenter is installed, and it is what drops the background. " + INSTALL_HINT)
    if sub.shape[1:] != image.shape[1:3]:
        sub = torch.nn.functional.interpolate(sub.unsqueeze(1), size=(image.shape[1], image.shape[2]),
                                              mode="bilinear", align_corners=False).squeeze(1)
    return sub[0].detach().cpu().clamp(0.0, 1.0), used


def enlarge(image, mult):
    """[1,H,W,3] through VOSR2 at x mult, or the picture unchanged with the reason."""
    up, why = _hero._vosr2(image, dict(_hero.VOSR2_PASS, vosr2_scale=float(mult)), 0)
    return (image, "not enlarged: %s" % why) if up is None else (up, "VOSR2 x%g" % float(mult))


def body_cut(image, panel=PANEL):
    """The whole figure on white, laid out on one panel: head top and feet at fixed heights, centred.

    Every angle goes through this, so a sheet's figures share a height and read as one person.
    Returns ([1,ph,pw,3], report)."""
    image = _hero._plain(image)[:1, :, :, :3]
    _hero.say("Cutting the figure out")
    mask, used = figure_mask(image)
    box = _hero._box(mask.numpy() > 0.4)
    if box is None:
        raise ValueError("no figure was found in this picture")
    h, w = int(image.shape[1]), int(image.shape[2])
    x0, y0, x1, y1 = box
    report = {"segmenter": used, "figure_px": y1 - y0 + 1, "source_size": [w, h],
              # a figure touching the top or bottom edge is cut off by the frame: said, not refused
              "whole_figure": y0 > 2 and y1 < h - 3, "enlarged": ""}
    flat = _hero._on_white(image, mask.unsqueeze(0))[y0:y1 + 1, x0:x1 + 1]
    if flat.shape[0] < FIGURE_FLOOR:
        mult = min(4, max(2, -(-FIGURE_FLOOR // max(1, flat.shape[0]))))
        up, report["enlarged"] = enlarge(flat.unsqueeze(0), mult)
        flat = up[0].detach().cpu()
    pw, ph = panel
    room_h, room_w = ph * (1 - 2 * MARGIN), pw * (1 - MARGIN)
    scale = min(room_h / flat.shape[0], room_w / flat.shape[1])
    fw, fh = max(1, round(flat.shape[1] * scale)), max(1, round(flat.shape[0] * scale))
    arr = (flat.numpy().clip(0, 1) * 255).astype(np.uint8)
    fig = Image.fromarray(arr).resize((fw, fh), Image.LANCZOS)
    out = Image.new("RGB", (pw, ph), (255, 255, 255))
    out.paste(fig, ((pw - fw) // 2, int(ph * (1 - MARGIN)) - fh))
    return torch.from_numpy(np.asarray(out).astype(np.float32) / 255.0)[None], report


def _render(reference, want, files, seed, size=PANEL, outfit=None, start=None, denoise=1.0):
    """One Krea 2 Identity render in a frame of its own (see hero._render_front: every model handle dies here).

    `outfit` goes in as the first reference and the character as the subject, which the encode boosts.
    `start` with a denoise under 1 is the polish pass over an existing picture."""
    from .identity import Krea2IdentityEdit
    run = _hero._run
    _hero.say("Loading the model")
    model = run("UNETLoader", unet_name=files["unet"], weight_dtype="default")[0]
    model = run("LoraLoaderModelOnly", model=model, lora_name=files["lora"], strength_model=1.0)[0]
    cl = run("CLIPLoader", clip_name=files["clip"], type="krea2")[0]
    va = run("VAELoader", vae_name=files["vae"])[0]
    pw, ph = size
    latent = (run("VAEEncode", pixels=start, vae=va)[0] if start is not None
              else run("EmptyLatentImage", width=pw, height=ph, batch_size=1)[0])
    pos = Krea2IdentityEdit().encode(
        clip=cl, prompt=want, vae=va, image=outfit if outfit is not None else reference,
        image2=reference if outfit is not None else None, grounding_px=max(pw, ph), ref_boost=BOOST,
        ref_boost_a=BOOST, target_latent=latent, fit_mode="fit", ref_t0_modulation=False, system_prompt=SYSTEM)[0]
    neg = run("CLIPTextEncode", clip=cl, text="")[0]
    _hero.say("Rendering")
    out = run("KSampler", model=model, seed=int(seed) or 7000, steps=STEPS, cfg=1.0, sampler_name="euler",
              scheduler="simple", positive=pos, negative=neg, latent_image=latent, denoise=float(denoise))[0]
    return _hero._plain(run("VAEDecode", samples=out, vae=va)[0])


def _refresh(frame, reference, want, files, seed, denoise, steps, stack_json, moodboard, strength, extract):
    from .moodboard import Krea2Moodboard
    run = _hero._run
    _hero.say("Loading the model")
    rig = files.get("rig") or {}
    if rig.get("unet_loader") or rig.get("int8_type"):
        # a Workspace rig: through the loader it needs (GGUF, INT8), as the Workspace loads it
        from .workspace import _load_unet
        model = _load_unet(files["unet"], rig.get("unet_loader") or "", rig.get("int8_type") or "")
    else:
        model = run("UNETLoader", unet_name=files["unet"], weight_dtype="default")[0]
    # the refresh is Krea 2 by definition: its encoder loads as Krea 2 whatever the rig says (a Workspace keeps
    # another type there), and a file that is not the Krea 2 encoder is named instead of failing inside the encode
    cl = run("CLIPLoader", clip_name=files["clip"], type="krea2")[0]
    try:
        ok = "qwen3vl_4b" in cl.tokenize("a")
    except Exception:
        ok = False
    if not ok:
        raise ValueError("'%s' is not the Krea 2 text encoder (qwen3vl_4b): pick that encoder in the rig" % files["clip"])
    va = run("VAELoader", vae_name=files["vae"])[0]
    sampler, scheduler = rig.get("sampler") or "euler", rig.get("scheduler") or "simple"
    cfg_scale = float(rig.get("cfg") or 1.0)
    if stack_json:
        from .lora_stack import apply_stack
        model, cl = apply_stack(model, cl, stack_json=stack_json, seed=int(seed), tag="Refresh")[:2]
    latent = run("VAEEncode", pixels=frame, vae=va)[0]
    if moodboard and reference is not None:
        # the first picture as the Moodboard reference: the frame is pulled back to its subject and look
        pos = Krea2Moodboard().encode(clip=cl, prompt=want, strength=float(strength), image=reference, extract=extract)[0]
    else:
        pos = run("CLIPTextEncode", clip=cl, text=want)[0]
    neg = run("CLIPTextEncode", clip=cl, text="")[0]
    _hero.say("Refreshing the frame")
    out = run("KSampler", model=model, seed=int(seed) or 7000, steps=int(steps), cfg=cfg_scale, sampler_name=sampler,
              scheduler=scheduler, positive=pos, negative=neg, latent_image=latent, denoise=float(denoise))[0]
    return _hero._plain(run("VAEDecode", samples=out, vae=va)[0])


def refresh_frame(frame, want, files, seed=0, denoise=0.45, steps=20, reference=None, stack_json=None, moodboard=True,
                  strength=0.5, extract="subject"):
    """A frame through Krea 2 image-to-image at a low denoise: the same seed and prompt, the first picture as the
    Moodboard reference, a LoRA stack of the caller's. For a video's last frame between Segments, so a long scene
    keeps the first picture's quality instead of drifting. files: unet, clip, vae (Krea 2), and optionally "rig": a
    Workspace rig record (unet_loader, int8_type, clip_type, sampler, scheduler, cfg) to load and sample as the
    Workspace does. Models are released after."""
    for key in ("unet", "clip", "vae"):
        if not (files or {}).get(key):
            raise ValueError("refresh_frame needs the Krea 2 %s file" % key)
    if frame is None or frame.ndim != 4:
        raise ValueError("refresh_frame needs one frame as an IMAGE [1, H, W, 3]")
    try:
        with _hero.progress_safe():
            return _refresh(frame, reference, want, files, seed, denoise, steps, stack_json, moodboard, strength,
                            extract if extract in ("subject", "style") else "subject")
    except Exception as exc:
        raise ValueError(str(exc) or exc.__class__.__name__) from None
    finally:
        _hero._settle()


def render(reference, want, files, seed=0, size=PANEL, outfit=None, start=None, denoise=1.0):
    """Krea 2 Identity render with the given Krea 2 files; models are released afterwards."""
    files = _check(files)
    try:
        with _hero.progress_safe():
            return _render(reference, want, files, seed, size, outfit, start, denoise)
    except Exception as exc:
        # the traceback would keep the frame that holds the models alive; carry the reason out instead
        raise ValueError(str(exc) or exc.__class__.__name__) from None
    finally:
        _hero._settle()


def dress(character, outfit_text="", outfit_picture=None, extras="", seed=0, files=None):
    """The character, standing front on in the outfit asked for (words, or a second picture), cut to a panel.

    Describes what IS worn, never what comes off: "bare head" came back shaved (Hero lesson)."""
    wear = str(outfit_text or "").strip()
    if not wear and outfit_picture is None:
        raise ValueError("describe the outfit, or give an outfit picture")
    parts = [LOOK, ANGLES["Front"]]
    parts.append("wearing %s" % wear if wear else "wearing the outfit from the other reference picture")
    if str(extras or "").strip():
        parts.append(str(extras).strip())
    img = render(character, ", ".join(parts + [BACKDROP]), files, seed, outfit=outfit_picture)
    return body_cut(img)


def angle(body, name, seed=0, files=None, extras="", polish=POLISH):
    """One named angle of the figure in `body` (a body_cut panel), cleaned, polished and laid out.

    Returns ([1,ph,pw,3], report)."""
    if name not in ANGLES:
        raise ValueError("unknown angle %r; one of %s" % (name, ", ".join(ANGLES)))
    parts = [LOOK, ANGLES[name], "same outfit and details"]
    if str(extras or "").strip():
        parts.append(str(extras).strip())
    want = ", ".join(parts + [BACKDROP])
    _hero.say("Angle", name)
    first, rep = body_cut(render(body, want, files, seed))
    if polish and polish > 0:
        _hero.say("Polishing", name)
        first, rep = body_cut(render(body, want, files, seed + 1, start=first, denoise=polish))
    rep.update(angle=name, prompt=want, seed=int(seed), polish=float(polish or 0))
    return first, rep


def head_crop(image, side=768):
    """A square close-up of the head from a panel, on white and enlarged: the sheet's close-up column.
    Cut from the dressed front rather than rendered, so it is the same face with no new seed to drift."""
    image = _hero._plain(image)[:1, :, :, :3]
    with _hero.progress_safe():
        head, why = _hero._mask_np(image, _hero.HEAD)
    box = _hero._box(head) if head is not None else None
    if box is None:
        raise ValueError(why or "no head was found for the close-up")
    h, w = int(image.shape[1]), int(image.shape[2])
    x0, y0, x1, y1 = box
    s = int(max(x1 - x0, y1 - y0) * 1.5)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2 + (y1 - y0) // 6
    a, b = max(0, cx - s // 2), max(0, cy - s // 2)
    crop = image[:, b:min(h, b + s), a:min(w, a + s)]
    if min(crop.shape[1], crop.shape[2]) < side:
        crop, _ = enlarge(crop, min(4, max(2, -(-side // max(1, min(crop.shape[1], crop.shape[2]))))))
    flat = _hero._pad_square(crop[0].detach().cpu().numpy().clip(0, 1))
    sq = Image.fromarray((flat * 255).astype(np.uint8)).resize((side, side), Image.LANCZOS)
    return torch.from_numpy(np.asarray(sq).astype(np.float32) / 255.0)[None]


def compose(panels, closeup=None, panel=PANEL):
    """Panels side by side on white, in the order given; a close-up sits centred in a panel of its own.
    No text on the image: text in a reference can turn up in the video."""
    pw, ph = panel
    tiles = list(panels) + ([closeup] if closeup is not None else [])
    if not tiles:
        raise ValueError("no panels to lay out")
    sheet = Image.new("RGB", (pw * len(tiles), ph), (255, 255, 255))
    for i, t in enumerate(tiles):
        im = Image.fromarray((t[0].detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8))
        if im.size != (pw, ph):
            im.thumbnail((pw, ph), Image.LANCZOS)
        sheet.paste(im, (i * pw + (pw - im.width) // 2, (ph - im.height) // 2))
    return torch.from_numpy(np.asarray(sheet).astype(np.float32) / 255.0)[None]



def grade_video(images, config, seed=0, chunk=16, on_chunk=None):
    """The Post FX chain over a clip: images [N,H,W,3] float 0..1 in, the same shape out.

    config is a Post FX panel config (the dict or its JSON). Run in chunks on the card so memory stays bounded.
    Random dials are drawn once from seed for the whole clip, so the grade holds still from frame to frame; the
    grain alone gets a new seed per chunk so its pattern never repeats. A chunk that needs a subject mask or a
    depth map makes its own. on_chunk(done, total) is told after each chunk."""
    import random

    import comfy.model_management as mm

    from . import postprocess as P
    cfg = P.parse_post(config if isinstance(config, dict) else P.own_post(config))
    if not any(cfg[n].get("on") for n in P.ORDER):
        return images
    old = P._SEEDED["rng"]
    P._SEEDED["rng"] = random.Random(int(seed))
    try:
        for item in cfg.get("chain") or []:
            if item.get("on") and item.get("rand"):
                item.update(P.roll_block(item["fx"], item))
                item["rand"] = {}
    finally:
        P._SEEDED["rng"] = old
    grain = [i for i in cfg.get("chain") or [] if i["fx"] == "grain" and i.get("on")]
    depthy = any(cfg[n].get("on") for n in P.DEPTH_EFFECTS)
    resolver = P.match_resolver(ws_raw=None, wired=None) if "match" in P.active_fx(cfg) else None
    dev = mm.get_torch_device()
    n, out = int(images.shape[0]), []
    for k, i in enumerate(range(0, n, max(1, int(chunk)))):
        mm.throw_exception_if_processing_interrupted()
        part = images[i:i + chunk].to(dev, torch.float32)
        for g in grain:
            g["seed"] = (int(seed) + 7919 * k) & 0x7fffffff
        depth = P.auto_depth(part, settings=cfg.get("depth")) if depthy else None
        mask = P.auto_mask(part) if P.needs_mask(cfg) else None
        out.append(P.apply_post(part, cfg, depth=depth, mask=mask, reference=resolver).clamp(0, 1).cpu())
        del part
        if on_chunk:
            on_chunk(min(n, i + chunk), n)
    return torch.cat(out, 0)
