"""Re-angle: the Img2Img tab's viewpoint stage.

Your ask (2026-08-17): "image to image, but from a different angle".
Before the workspace's own i2i pass, the source picture is re-shot from the
camera the tab asks for - Qwen-Image-Edit-2511 with fal's Multiple-Angles LoRA
(and the Lightning 4-step LoRA), the same graph the standalone example
workflow runs - and the RESULT becomes the i2i source. The Krea 2 pass then
runs on it at the tab's denoise, passes and all, so a low denoise polishes the
re-angled picture and hi-res can follow. Several viewpoints (a camera path on
the studio) come back as a batch, one i2i canvas each.

Everything Comfy-side goes through core's own node classes, looked up by name
in NODE_CLASS_MAPPINGS at call time, so this follows core across versions and
never reimplements a loader or an encoder. Models are cached in one slot;
results are cached by (source, prompts, settings) so a re-queue that only
moved the denoise does not re-run the edit model.
"""
import hashlib
import json

import torch

from . import camera_translate as _ct

# defaults: the files the pack's install notes put in place; any Qwen Edit
# 2511 build, its Qwen2.5-VL encoder and the two LoRAs work
DEFAULTS = {
    "unet": "qwen_image_edit_2511_fp8mixed.safetensors",
    "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    "vae": "qwen_image_vae.safetensors",
    "lora_angles": "qwen-image-edit-2511-multiple-angles-lora.safetensors",
    "lora_light": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
}
SAMPLERS_FALLBACK = ["euler"]
SCHEDULERS_FALLBACK = ["simple"]

# the multi-angle vocabulary lives with the node that writes it
from .camera_studio import MA_AZIMUTHS, MA_ELEVATIONS, MA_DISTANCES, multi_angle_words  # noqa: E402


def parse(raw):
    """The Img2Img tab's reangle block, normalised. Off by default."""
    r = raw if isinstance(raw, dict) else {}

    def num(k, dv, lo, hi, cast=float):
        try:
            v = cast(r.get(k, dv))
        except (TypeError, ValueError):
            v = dv
        return max(lo, min(hi, v))

    def pick(k, options, dv):
        v = r.get(k)
        return v if v in options else dv

    return {
        "on": bool(r.get("on", False)),
        # where the camera comes from: the three bands set here, or the active
        # prompt row's Camera Studio (its camera, or its whole path)
        "camera": pick("camera", ("bands", "studio"), "bands"),
        "azimuth": pick("azimuth", MA_AZIMUTHS, "front-right quarter view"),
        "elevation": pick("elevation", MA_ELEVATIONS, "eye-level shot"),
        "distance": pick("distance", MA_DISTANCES, "medium shot"),
        "nudge": bool(r.get("nudge", False)),
        "collapse": bool(r.get("collapse", True)),
        "extra": str(r.get("extra") or "")[:500],
        # the engine
        "unet": str(r.get("unet") or DEFAULTS["unet"]),
        "clip": str(r.get("clip") or DEFAULTS["clip"]),
        "vae": str(r.get("vae") or DEFAULTS["vae"]),
        "lora_angles": str(r.get("lora_angles") or DEFAULTS["lora_angles"]),
        "lora_angles_strength": num("lora_angles_strength", 1.0, 0.0, 2.0),
        "lora_light": str(r.get("lora_light") if r.get("lora_light") is not None else DEFAULTS["lora_light"]),
        "lora_light_strength": num("lora_light_strength", 1.0, 0.0, 2.0),
        "steps": num("steps", 4, 1, 60, int),
        "cfg": num("cfg", 1.0, 0.0, 20.0),
        "sampler": str(r.get("sampler") or "euler"),
        "scheduler": str(r.get("scheduler") or "simple"),
        "shift": num("shift", 3.1, 0.0, 10.0),
        "cfg_norm": bool(r.get("cfg_norm", True)),
        # PyTorch attention for the edit model unless ComfyUI's own is asked for
        "attention": pick("attention", ATTENTIONS, "pytorch"),
        "seed": num("seed", 0, 0, 2 ** 53, int),
        "seed_random": bool(r.get("seed_random", True)),
        "trigger": str(r.get("trigger") if r.get("trigger") is not None else "<sks>")[:40],
        # the Camera tab's Img2Img studio: a Camera Studio state (JSON string),
        # separate from the prompt's studio, so re-angle and the words can
        # point their cameras differently
        "studio": r.get("studio") if isinstance(r.get("studio"), str) else "",
        # STOP AFTER THE RE-SHOT: the re-angled picture is the workspace's image
        # output as it is, no encode and no i2i pass, so the rig never enters
        # VRAM beside the edit model. Off by default; the pass is the normal run.
        "skip_pass": bool(r.get("skip_pass", False)),
    }


def prompts_for(rc, camera_jsons):
    """The "<sks> azimuth elevation distance" prompt list for this run.
    camera_jsons: [] -> the bands as set; else one prompt per studio camera
    (collapsed to distinct bands when asked)."""
    trig = rc["trigger"].strip()
    shots = []
    for j in camera_jsons or []:
        try:
            d = json.loads(j) if isinstance(j, str) else j
        except (ValueError, TypeError):
            d = None
        if not (isinstance(d, dict) and d.get("camera")):
            continue
        from .camera_studio import parse_state
        st = parse_state(json.dumps({"camera": d.get("camera") or {}, "subjects": d.get("subjects") or []}))
        shots.append(multi_angle_words(st["camera"], st["subjects"], "viewer"))
    if not shots:
        shots = [(rc["azimuth"], rc["elevation"], rc["distance"], 0, 0, "")]
    if rc["collapse"]:
        kept = []
        for sh in shots:
            key = (sh[0], sh[1], sh[2], sh[5] if rc["nudge"] else "")
            if not kept or kept[-1] != key:
                kept.append(key)
        shots = [(k[0], k[1], k[2], 0, 0, k[3]) for k in kept]
    out = []
    for az, el, di, _, _, nd in shots:
        p = " ".join(x for x in (trig, az, el, di) if x)
        if rc["nudge"] and nd:
            p += ", " + nd
        if rc["extra"].strip():
            p += " " + rc["extra"].strip()
        out.append(p)
    return out


# ---------------------------------------------------------------- the engine
# Two caches. The BASE (unet + clip + vae, the 20 GB read) is shared by every
# Qwen-Image-Edit stage in the pack (Re-angle, Swap); the PATCHED model (LoRAs,
# shift, CFGNorm on a clone of the base) is kept per recipe, so switching from
# a re-angle run to a swap run patches a clone and never re-reads the files.
_BASE_CACHE = {"key": None, "model": None, "clip": None, "vae": None}
_MODEL_CACHE = {"key": None, "model": None, "clip": None, "vae": None}
_RESULT_CACHE = []          # newest first: (key, images_cpu)
_RESULT_KEEP = 4


def _node(name):
    import nodes
    cls = nodes.NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise RuntimeError("ComfyUI has no node %r; update ComfyUI (Qwen Image Edit 2511 support)" % name)
    return cls


def _call(name, **kw):
    """Run a core node by name, V1 or V3, and hand back its first output."""
    cls = _node(name)
    if hasattr(cls, "execute") and not hasattr(cls, "FUNCTION"):
        out = cls.execute(**kw)                       # V3: classmethod, NodeOutput
        args = getattr(out, "args", out)
        return args[0] if isinstance(args, (tuple, list)) else args
    inst = cls()
    out = getattr(inst, cls.FUNCTION)(**kw)
    if hasattr(out, "args"):
        out = out.args
    return out[0] if isinstance(out, (tuple, list)) else out


ATTENTIONS = ("pytorch", "comfy")


def _pytorch_attention(func, *args, **kwargs):
    # ComfyUI's per-model attention override: this model samples with PyTorch
    # attention whatever ComfyUI was started with
    from comfy.ldm.modules.attention import attention_pytorch
    return attention_pytorch(*args, **kwargs)


def with_attention(model, attention, tag):
    """The model, on PyTorch attention unless `attention` is "comfy". Qwen-Image
    with SageAttention gives black or broken pictures, so the edit engine opts
    out while the rest of the run keeps whatever ComfyUI was started with."""
    if attention == "comfy":
        return model
    try:
        m = model.clone()
        m.model_options.setdefault("transformer_options", {})[
            "optimized_attention_override"] = _pytorch_attention
        try:
            import comfy.model_management as mm
            if mm.sage_attention_enabled():
                print("[RedNode %s] the edit model runs PyTorch attention; SageAttention "
                      "stays on for everything else" % tag, flush=True)
        except Exception:
            pass
        return m
    except Exception as e:
        print("[RedNode %s] could not set PyTorch attention (%s); ComfyUI's is used"
              % (tag, e), flush=True)
        return model


def load_engine(unet, clip_name, vae_name, loras, shift, cfg_norm, tag="Re-angle",
                attention="pytorch"):
    """model, clip, vae for a Qwen-Image-Edit stage. `loras` is a list of
    (name, strength) applied in order; "None", "" and strength 0 are skipped.
    `attention` is "pytorch" (the default) or "comfy" (the launch setting)."""
    loras = tuple((str(n), float(s)) for n, s in loras
                  if n and n != "None" and float(s) > 0)
    key = (unet, clip_name, vae_name, loras, float(shift), bool(cfg_norm), attention)
    if _MODEL_CACHE["key"] == key and _MODEL_CACHE["model"] is not None:
        return _MODEL_CACHE["model"], _MODEL_CACHE["clip"], _MODEL_CACHE["vae"]
    bkey = (unet, clip_name, vae_name)
    if _BASE_CACHE["key"] != bkey or _BASE_CACHE["model"] is None:
        print("[RedNode %s] loading %s + %s + %s" % (tag, unet, clip_name, vae_name), flush=True)
        _BASE_CACHE.update({"key": None, "model": None, "clip": None, "vae": None})
        base = _call("UNETLoader", unet_name=unet, weight_dtype="default")
        clip = _call("CLIPLoader", clip_name=clip_name, type="qwen_image", device="default")
        vae = _call("VAELoader", vae_name=vae_name)
        _BASE_CACHE.update({"key": bkey, "model": base, "clip": clip, "vae": vae})
    model = _BASE_CACHE["model"]
    for name, strength in loras:
        model = _call("LoraLoaderModelOnly", model=model, lora_name=name, strength_model=strength)
    if float(shift) > 0:
        model = _call("ModelSamplingAuraFlow", model=model, shift=float(shift))
    if cfg_norm:
        try:
            model = _call("CFGNorm", model=model, strength=1.0)
        except Exception as e:
            print("[RedNode %s] CFGNorm skipped: %s" % (tag, e), flush=True)
    model = with_attention(model, attention, tag)
    _MODEL_CACHE.update({"key": key, "model": model, "clip": _BASE_CACHE["clip"],
                         "vae": _BASE_CACHE["vae"]})
    return model, _BASE_CACHE["clip"], _BASE_CACHE["vae"]


def unload_from_card():
    """The edit engine off the card, still held in RAM, so a run that used it does
    not keep 20 GB of VRAM for the rest of the run and into the next. Returns how
    many loaded models went."""
    try:
        import comfy.model_management as mm
    except Exception:
        return 0
    models = [m for m in (_MODEL_CACHE["model"], _BASE_CACHE["model"]) if m is not None]
    parts = [getattr(x, "patcher", None) for x in (_BASE_CACHE["clip"], _BASE_CACHE["vae"])
             if x is not None]
    parts = [p for p in parts if p is not None]
    if not models and not parts:
        return 0
    gone = 0
    for i in range(len(mm.current_loaded_models) - 1, -1, -1):
        lm = mm.current_loaded_models[i]
        m = getattr(lm, "model", None)
        if m is None:
            continue
        hit = any(m is p for p in parts) or any(
            m is t or (hasattr(m, "is_clone") and m.is_clone(t)) for t in models)
        if hit:
            lm.model_unload()
            mm.current_loaded_models.pop(i)
            gone += 1
    if gone:
        mm.soft_empty_cache()
    return gone


def _load_engine(rc):
    return load_engine(rc["unet"], rc["clip"], rc["vae"],
                       [(rc["lora_light"], rc["lora_light_strength"]),
                        (rc["lora_angles"], rc["lora_angles_strength"])],
                       rc["shift"], rc["cfg_norm"], attention=rc.get("attention", "pytorch"))


def _source_key(img):
    """A cheap, stable hash of the source picture (shape + a 64x64 thumbnail)."""
    t = img[:1, :, :, :3]
    thumb = torch.nn.functional.interpolate(t.permute(0, 3, 1, 2), size=(64, 64), mode="area")
    b = (thumb.clamp(0, 1) * 255).to(torch.uint8).contiguous().cpu().numpy().tobytes()
    return hashlib.sha1(b).hexdigest() + ":%dx%d" % (img.shape[2], img.shape[1])


def sampler_for(node_id, label):
    """core's common_ksampler, streaming a frame a step to the Live Preview and the
    Run tab under `node_id` (live_preview.py). Plain when there is no node."""
    import nodes as _core
    if node_id is None:
        return _core.common_ksampler
    try:
        from . import live_preview as _live
        return _live.sampled(node_id, _core.common_ksampler, label=label)
    except Exception:
        return _core.common_ksampler


def render(rc, source, prompts, seed, node_id=None):
    """IMAGE tensor [N,H,W,3] - the source re-shot for each prompt. Cached.
    `node_id` streams the steps as live frames under that node."""
    with torch.inference_mode():
        return _render(rc, source, prompts, seed, node_id)


def _render(rc, source, prompts, seed, node_id=None):
    import nodes as _core
    key = json.dumps({"src": _source_key(source), "p": prompts, "seed": int(seed),
                      "steps": rc["steps"], "cfg": rc["cfg"], "sampler": rc["sampler"],
                      "scheduler": rc["scheduler"], "unet": rc["unet"], "loras":
                      [rc["lora_angles"], rc["lora_angles_strength"], rc["lora_light"], rc["lora_light_strength"]],
                      "shift": rc["shift"], "cfg_norm": rc["cfg_norm"],
                      "attention": rc.get("attention", "pytorch")}, sort_keys=True)
    for k, imgs in _RESULT_CACHE:
        if k == key:
            print("[RedNode Re-angle] %d view(s) from the cache" % imgs.shape[0], flush=True)
            return imgs.clone()
    model, clip, vae = _load_engine(rc)
    src = source[:1, :, :, :3]
    try:
        scaled = _call("FluxKontextImageScale", image=src)
    except Exception:
        scaled = src
    latent = {"samples": vae.encode(scaled)}
    neg = _call("TextEncodeQwenImageEditPlus", clip=clip, prompt="", vae=vae, image1=scaled)
    outs = []
    for i, p in enumerate(prompts):
        pos = _call("TextEncodeQwenImageEditPlus", clip=clip, prompt=p, vae=vae, image1=scaled)
        print("[RedNode Re-angle] view %d of %d: %s" % (i + 1, len(prompts), p), flush=True)
        label = "re-angle" + (" \u00b7 view %d of %d" % (i + 1, len(prompts))
                              if len(prompts) > 1 else "")
        out = sampler_for(node_id, label)(
            model, int(seed) + i, int(rc["steps"]), float(rc["cfg"]),
            rc["sampler"], rc["scheduler"], pos, neg, latent, denoise=1.0)[0]
        img = vae.decode(out["samples"])
        while img.ndim > 4:
            img = img[0]
        outs.append(img[:, :, :, :3])
    # same source, same scale: all views share a size, so they batch
    h = min(o.shape[1] for o in outs)
    w = min(o.shape[2] for o in outs)
    imgs = torch.cat([o[:, :h, :w, :] for o in outs], dim=0).detach()
    _RESULT_CACHE.insert(0, (key, imgs.cpu()))
    del _RESULT_CACHE[_RESULT_KEEP:]
    return imgs


def free():
    """Drop the cached engine (the Models tab's free / a rig switch may call it)."""
    _MODEL_CACHE.update({"key": None, "model": None, "clip": None, "vae": None})
    _BASE_CACHE.update({"key": None, "model": None, "clip": None, "vae": None})
