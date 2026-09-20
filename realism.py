"""Realism: the Img2Img tab's medium stage.

An illustration goes in and a photograph comes out, before the workspace's own
i2i pass, the way Re-angle re-shoots the source before it. The Krea 2 pass then
runs on the converted picture at the tab's denoise, so a low denoise polishes it
and the passes follow as usual.

Proved 2026-09-21 against the Anything2RealWorkflow, in
`Comfy Development/projects/comfyui-krea2moodboard/A2R_FINDINGS.md`:

  - `index_timestep_zero` IS the mechanism. Every path that supplies it
    converts and every path without it does nothing, on every seed tried. Our
    own Krea2IdentityEdit does it through ref_t0_modulation, so this needs no
    third-party node and no model patch. That toggle is NOT a setting here: off,
    the feature simply does not work.
  - The system prompt decides how much reference boost the conversion can take.
    One that only describes the picture forces the boost down to 0.4; one that
    tells the encoder to explain how the instruction should ALTER the image
    works at 1.0. Hence the default below, which is worded for the change.
  - Denoise is 1.0. The references, not the latent, carry the picture across.

The rig is the one on the Models tab: the same Krea 2 turbo the render uses, so
the model is already in the loader cache and this costs no extra VRAM. Only the
realism LoRA is loaded on top.
"""

import json

import torch

# what the pass asks for, and what it is told to be. The instruction names the
# CHANGE rather than describing the picture, which is what lets the reference
# boost stay at 1.0 (see the findings above).
WANT = "transform the image to realistic photograph"
SYSTEM = ("Describe the key features of the input image (color, shape, size, texture, "
          "objects, background), then explain how the user's text instruction should "
          "alter or modify the image. Generate a new image that meets the user's "
          "requirements while maintaining consistency with the original input where "
          "appropriate.")
SNAP = 16          # the latent grid patchifies at /16; 512 is what squared the source
MAX_SIDE = 1536
_RESULT_CACHE = []
_CACHE_KEEP = 4


def parse(raw):
    """The Img2Img tab's realism block, normalised. Off by default."""
    r = raw if isinstance(raw, dict) else {}

    def num(k, dv, lo, hi, cast=float):
        try:
            v = cast(r.get(k, dv))
        except (TypeError, ValueError):
            v = dv
        return max(lo, min(hi, v))

    return {
        "on": bool(r.get("on", False)),
        # the LoRA that does the converting. No default file name: it is the
        # user's own download and naming one here would age badly.
        "lora": str(r.get("lora") or ""),
        "strength": num("strength", 1.0, 0.0, 2.0),
        "prompt": str(r.get("prompt") if r.get("prompt") is not None else WANT)[:500],
        "system": str(r.get("system") if r.get("system") is not None else SYSTEM)[:2000],
        # 1.0 works with the instruction above; 1.5 holds the illustration
        "boost": num("boost", 1.0, 0.0, 3.0),
        "steps": num("steps", 0, 0, 60, int),        # 0 = the rig's own
        "cfg": num("cfg", 0.0, 0.0, 20.0),           # 0 = the rig's own
        "seed": num("seed", 0, 0, 2 ** 53, int),
        "seed_random": bool(r.get("seed_random", True)),
        # an illustration is oversaturated and a denoise-1.0 pass carries that
        # straight into "real" skin
        "desaturate": num("desaturate", 20, 0, 100, int),
        "max_side": num("max_side", MAX_SIDE, 512, 2048, int),
        "skip_pass": bool(r.get("skip_pass", False)),
    }


def _source_key(image):
    """Cheap fingerprint of a source tensor, as Re-angle keys its cache."""
    t = image[:1, ::16, ::16, :3].float()
    return [list(image.shape), round(float(t.mean()), 6), round(float(t.std()), 6)]


def _prepared(image, rc):
    """Desaturated, bounded, and snapped so the latent grid patchifies.

    Snapped to 16, not to 512. The workflow this came from rounds to 512 and
    that is what turns a portrait into a square, losing framing nobody asked to
    lose.
    """
    img = image[:1, :, :, :3].float()
    amount = rc["desaturate"] / 100.0
    if amount > 0:
        # Rec.709 luma, mixed in by amount: -20 is a nudge, not a grade
        lum = (img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722)
        img = img * (1.0 - amount) + lum.unsqueeze(-1) * amount
    h, w = int(img.shape[1]), int(img.shape[2])
    scale = min(1.0, float(rc["max_side"]) / max(h, w))
    nh = max(SNAP, int(round(h * scale / SNAP)) * SNAP)
    nw = max(SNAP, int(round(w * scale / SNAP)) * SNAP)
    if (nh, nw) != (h, w):
        import comfy.utils
        moved = img.movedim(-1, 1)
        img = comfy.utils.common_upscale(moved, nw, nh, "lanczos", "disabled").movedim(1, -1)
    return img.clamp(0.0, 1.0)


def _call(name, **kw):
    """A core or pack node through the entry point IT declares.

    Looked up in NODE_CLASS_MAPPINGS at call time, the way Re-angle and the
    Detailer's optional passes are called, so this follows ComfyUI across
    versions and never reimplements a loader.
    """
    import nodes as _core
    cls = (getattr(_core, "NODE_CLASS_MAPPINGS", None) or {}).get(name)
    if cls is None:
        raise ValueError("this ComfyUI has no %s node" % name)
    fn = getattr(cls(), getattr(cls, "FUNCTION", "") or "", None)
    if fn is None:
        raise ValueError("the %s node has no callable entry point" % name)
    return fn(**kw)


def render(rc, source, cfg, seed, node_id=None):
    """IMAGE [1,H,W,3]: the source as a photograph. Cached by what made it."""
    with torch.inference_mode():
        return _render(rc, source, cfg, seed, node_id)


def _render(rc, source, cfg, seed, node_id=None):
    # WHAT CAN BE REFUSED WITHOUT LOADING ANYTHING comes first, so the answer to
    # "no LoRA chosen" does not depend on the pack being importable as a package
    if not str(rc["lora"] or "").strip():
        raise ValueError("no realism LoRA is chosen on the Img2Img tab, and the "
                         "conversion is the LoRA's doing: pick one first.")
    from . import workspace as _ws
    key = json.dumps({"src": _source_key(source), "seed": int(seed), "rc":
                      {k: rc[k] for k in ("lora", "strength", "prompt", "system",
                                          "boost", "steps", "cfg", "desaturate",
                                          "max_side")}}, sort_keys=True)
    for k, img in _RESULT_CACHE:
        if k == key:
            print("[RedNode Realism] from the cache", flush=True)
            return img.clone()

    rig_name, model, clip, vae = _ws.load_active_rig(cfg)
    if model is None or clip is None or vae is None:
        raise ValueError("the realism pass runs on the Models tab's rig, and it has "
                         "no model, text encoder or VAE set.")
    rigs = (cfg.get("models") or {}).get("rigs") or []
    rec = rigs[max(0, min(int((cfg.get("models") or {}).get("active", 0)),
                          len(rigs) - 1))] if rigs else {}
    steps = int(rc["steps"] or rec.get("steps") or 8)
    guide = float(rc["cfg"] or rec.get("cfg") or 1.0)
    sampler = str(rec.get("sampler") or "euler")
    scheduler = str(rec.get("scheduler") or "simple")

    src = _prepared(source, rc)
    model = _call("LoraLoaderModelOnly", model=model, lora_name=rc["lora"],
                  strength_model=rc["strength"])[0]
    latent = {"samples": vae.encode(src)}
    # ref_t0_modulation is TRUE and is not a setting: it is the reference method
    # the conversion runs on, and without it this pass returns the illustration
    # it was given. See the findings in the module docstring.
    from .identity import Krea2IdentityEdit
    positive = Krea2IdentityEdit().encode(
        clip=clip, prompt=rc["prompt"], vae=vae, image=src,
        grounding_px=max(int(src.shape[1]), int(src.shape[2])),
        ref_boost=rc["boost"], ref_boost_a=rc["boost"], target_latent=latent,
        fit_mode="fit", ref_t0_modulation=True, system_prompt=rc["system"])[0]
    negative = _call("CLIPTextEncode", clip=clip, text="")[0]
    print("[RedNode Realism] %s on %s, boost %.2f, %d steps" %
          (rc["lora"], rig_name or "the active rig", rc["boost"], steps), flush=True)
    out = _call("KSampler", model=model, seed=int(seed), steps=steps, cfg=guide,
                sampler_name=sampler, scheduler=scheduler, positive=positive,
                negative=negative, latent_image=latent, denoise=1.0)[0]
    img = _call("VAEDecode", samples=out, vae=vae)[0]
    # out of inference mode, so nothing downstream trips over a tensor whose
    # version counter is not tracked (the Hero Creator learned this one)
    img = torch.from_numpy(img.detach().cpu().numpy())
    _RESULT_CACHE.append((key, img.clone()))
    del _RESULT_CACHE[:-_CACHE_KEEP]
    return img
