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
# WHAT THE SOURCE IS ROUNDED TO. 16 is the floor: the latent grid patchifies
# there, so anything smaller decodes short. The larger steps snap the working
# size towards the coarse buckets an edit model is trained on, at the cost of
# cropping: 512 turns a portrait into 1024x1536 and a squarish picture into a
# square. The workflow this came from uses 512, which is why it is offered.
ROUNDINGS = (16, 64, 512)
SNAP = 16
MAX_SIDE = 1536
# WHAT THE VISION ENCODER SEES, which is not the size the picture renders at.
# Qwen3-VL gets a coarse read and the VAE reference latents carry the detail:
# ai-toolkit trains this at 384x384 total pixels and the workflow this came from
# asks for 384. Feeding it the render size instead (1536) is roughly sixteen
# times the pixel budget it was trained on, and the result was a conversion that
# treated the source as a loose reference rather than the picture to keep.
VL_SIZE = 384
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
        # THE RIG'S OWN STACK, on by default. Everywhere else in the pack a rig
        # arrives carrying its LoRAs, and the workflow this came from stacks the
        # conversion LoRA on top of one; a pass that quietly dropped it would
        # convert into a different look than the render beside it.
        "loras": bool(r.get("loras", True)),
        "lora_set": str(r.get("lora_set") or "")[:48],   # "" = the rig's own set
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
        "vl_size": num("vl_size", VL_SIZE, 64, 2048, int),
        "round_to": (int(r.get("round_to")) if r.get("round_to") in ROUNDINGS
                     or str(r.get("round_to")) in [str(x) for x in ROUNDINGS]
                     else SNAP),
        # "" = the rig's own pair. A pass can want a different one: beta57 comes
        # from RES4LYF and is what the workflow this came from renders with.
        "sampler": str(r.get("sampler") or ""),
        "scheduler": str(r.get("scheduler") or ""),
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
    snap = int(rc.get("round_to") or SNAP)
    scale = min(1.0, float(rc["max_side"]) / max(h, w))
    nh = max(snap, int(round(h * scale / snap)) * snap)
    nw = max(snap, int(round(w * scale / snap)) * snap)
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


def sampler_for(node_id, label):
    """The pack's own sampler, streaming a frame a step under `node_id`.

    sample_with_dials, NOT core's common_ksampler: beta57, bong_tangent and
    hyperbolic are schedule shapes this pack builds itself (sampler_dials.py),
    and core has never heard of them. Going through core would have printed "no
    beta57 in this build" and quietly rendered on the rig's scheduler instead,
    which is not what the workflow this came from renders with. With nothing on
    and a stock scheduler it IS common_ksampler.

    The decode is this pack's own (live_preview.py), through the tiny decoder in
    models/vae_approx that matches the latent format: lighttaew2_1 for Krea 2.
    Without that file the frames fall back to latent2rgb rather than stopping.
    """
    from . import sampler_dials as _dials
    if node_id is None:
        return _dials.sample_with_dials
    try:
        from . import live_preview as _live
        return _live.sampled(node_id, _dials.sample_with_dials, label=label)
    except Exception:
        return _dials.sample_with_dials


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
                                          "max_side", "loras", "lora_set",
                                          "round_to", "sampler", "scheduler",
                                          "vl_size")}},
                     sort_keys=True)
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
    sampler = str(rc["sampler"] or rec.get("sampler") or "euler")
    scheduler = str(rc["scheduler"] or rec.get("scheduler") or "simple")
    # a pair this build does not have falls back and SAYS so, rather than
    # failing the pass over the name of a scheduler
    try:
        import comfy.samplers as _cs
        if sampler not in _cs.KSampler.SAMPLERS:
            print("[RedNode Realism] no %r sampler in this build; euler instead"
                  % sampler, flush=True)
            sampler = "euler"
        from . import sampler_dials as _sd
        known = list(_cs.KSampler.SCHEDULERS) + list(getattr(_sd, "EXTRA_SCHEDULERS", ()))
        if scheduler not in known:
            print("[RedNode Realism] no %r scheduler here; the rig's is used instead"
                  % scheduler, flush=True)
            scheduler = str(rec.get("scheduler") or "simple")
    except Exception:
        pass

    src = _prepared(source, rc)
    # the rig's stack first, then the conversion LoRA on top of it: the order the
    # workflow this came from wires, and the order the Detailer's passes use
    if rc["loras"]:
        try:
            import json as _json
            from . import lora_stack as _lora
            lc = _ws.lora_set_cfg(cfg, rc["lora_set"] or _ws.rig_lora_set(cfg),
                                  "Realism") or {}
            slots = lc.get("slots") or []
            if slots and lc.get("on", True):
                model, _c2, _w, applied = _lora.apply_stack(
                    model, clip, _lora.CUSTOM_SENTINEL,
                    _json.dumps({"ui": lc.get("ui") or {}, "slots": slots}),
                    int(lc.get("seed", 0) or 0), None, tag="Realism LoRAs")
                clip = _c2 if _c2 is not None else clip
                print("[RedNode Realism] rig stack applied: %s" % applied, flush=True)
        except Exception as exc:
            print("[RedNode Realism] the rig's LoRA stack could not be applied (%s); "
                  "the conversion LoRA runs alone" % exc, flush=True)
    # model AND clip, because that is what the workflow's stack node does and a
    # file with no text-encoder keys is unaffected either way
    model, clip = _call("LoraLoader", model=model, clip=clip, lora_name=rc["lora"],
                        strength_model=rc["strength"], strength_clip=rc["strength"])[:2]
    latent = {"samples": vae.encode(src)}
    # ref_t0_modulation is TRUE and is not a setting: it is the reference method
    # the conversion runs on, and without it this pass returns the illustration
    # it was given. See the findings in the module docstring.
    from .identity import Krea2IdentityEdit
    positive = Krea2IdentityEdit().encode(
        clip=clip, prompt=rc["prompt"], vae=vae, image=src,
        grounding_px=int(rc["vl_size"]),
        ref_boost=rc["boost"], ref_boost_a=rc["boost"], target_latent=latent,
        fit_mode="fit", ref_t0_modulation=True, system_prompt=rc["system"])[0]
    negative = _call("CLIPTextEncode", clip=clip, text="")[0]
    print("[RedNode Realism] %s on %s, boost %.2f, %d steps, VL read %d px, "
          "rig stack %s" % (rc["lora"], rig_name or "the active rig", rc["boost"],
                            steps, rc["vl_size"], "on" if rc["loras"] else "off"),
          flush=True)
    # through common_ksampler rather than the KSampler node, because that is
    # what the live stream wraps: a pass you cannot watch is a pass you cannot
    # tell from a hang.
    # sample_with_dials hands back the LATENT ITSELF, not core's one-tuple: it
    # unwraps common_ksampler on the way through. Indexing [0] here asked a dict
    # for key 0 and the pass failed with the message "0".
    out = sampler_for(node_id, "realism")(
        model, int(seed), steps, guide, sampler, scheduler, positive, negative,
        latent, denoise=1.0)
    img = _call("VAEDecode", samples=out, vae=vae)[0]
    # out of inference mode, so nothing downstream trips over a tensor whose
    # version counter is not tracked (the Hero Creator learned this one)
    img = torch.from_numpy(img.detach().cpu().numpy())
    _RESULT_CACHE.append((key, img.clone()))
    del _RESULT_CACHE[:-_CACHE_KEEP]
    return img
