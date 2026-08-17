"""Re-angle: the Img2Img tab's viewpoint stage.

The user's ask (2026-08-17): "image to image, but from a different angle".
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
        "seed": num("seed", 0, 0, 2 ** 53, int),
        "seed_random": bool(r.get("seed_random", True)),
        "trigger": str(r.get("trigger") if r.get("trigger") is not None else "<sks>")[:40],
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


def _load_engine(rc):
    key = (rc["unet"], rc["clip"], rc["vae"], rc["lora_angles"], rc["lora_angles_strength"],
           rc["lora_light"], rc["lora_light_strength"], rc["shift"], rc["cfg_norm"])
    if _MODEL_CACHE["key"] == key and _MODEL_CACHE["model"] is not None:
        return _MODEL_CACHE["model"], _MODEL_CACHE["clip"], _MODEL_CACHE["vae"]
    print("[RedNode Re-angle] loading %s + %s + %s" % (rc["unet"], rc["clip"], rc["vae"]), flush=True)
    model = _call("UNETLoader", unet_name=rc["unet"], weight_dtype="default")
    if rc["lora_light"] and rc["lora_light"] != "None" and rc["lora_light_strength"] > 0:
        model = _call("LoraLoaderModelOnly", model=model, lora_name=rc["lora_light"],
                      strength_model=float(rc["lora_light_strength"]))
    if rc["lora_angles"] and rc["lora_angles"] != "None" and rc["lora_angles_strength"] > 0:
        model = _call("LoraLoaderModelOnly", model=model, lora_name=rc["lora_angles"],
                      strength_model=float(rc["lora_angles_strength"]))
    if rc["shift"] > 0:
        model = _call("ModelSamplingAuraFlow", model=model, shift=float(rc["shift"]))
    if rc["cfg_norm"]:
        try:
            model = _call("CFGNorm", model=model, strength=1.0)
        except Exception as e:
            print("[RedNode Re-angle] CFGNorm skipped: %s" % e, flush=True)
    clip = _call("CLIPLoader", clip_name=rc["clip"], type="qwen_image", device="default")
    vae = _call("VAELoader", vae_name=rc["vae"])
    _MODEL_CACHE.update({"key": key, "model": model, "clip": clip, "vae": vae})
    return model, clip, vae


def _source_key(img):
    """A cheap, stable hash of the source picture (shape + a 64x64 thumbnail)."""
    t = img[:1, :, :, :3]
    thumb = torch.nn.functional.interpolate(t.permute(0, 3, 1, 2), size=(64, 64), mode="area")
    b = (thumb.clamp(0, 1) * 255).to(torch.uint8).contiguous().cpu().numpy().tobytes()
    return hashlib.sha1(b).hexdigest() + ":%dx%d" % (img.shape[2], img.shape[1])


def render(rc, source, prompts, seed):
    """IMAGE tensor [N,H,W,3] - the source re-shot for each prompt. Cached."""
    with torch.inference_mode():
        return _render(rc, source, prompts, seed)


def _render(rc, source, prompts, seed):
    import nodes as _core
    key = json.dumps({"src": _source_key(source), "p": prompts, "seed": int(seed),
                      "steps": rc["steps"], "cfg": rc["cfg"], "sampler": rc["sampler"],
                      "scheduler": rc["scheduler"], "unet": rc["unet"], "loras":
                      [rc["lora_angles"], rc["lora_angles_strength"], rc["lora_light"], rc["lora_light_strength"]],
                      "shift": rc["shift"], "cfg_norm": rc["cfg_norm"]}, sort_keys=True)
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
        out = _core.common_ksampler(model, int(seed) + i, int(rc["steps"]), float(rc["cfg"]),
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
