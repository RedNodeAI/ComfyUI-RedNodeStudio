"""Swap: the Img2Img tab's character stage.

Your ask (2026-08-18): put the Subject onto the person in the picture,
the way the face function does, but in the engine where a swap is known to
land - Qwen-Image-Edit-2509/2511 with Alissonerdx's BFS (Best Face Swap)
LoRA, the same edit engine Re-angle runs (shared through reangle.load_engine,
so the 20 GB base is read once for both). It runs after Re-angle and before
the i2i pass: the swapped frame BECOMES the i2i source, the Krea 2 pass with
the Subject reference finishes it at the tab's denoise, and the Detailer's
face pass can follow. One chain, two engines, each doing the part it is good
at.

Three modes, one engine: face (the face only, hair and head shape stay),
head (the whole head, hair included) and person (the base model's own
multi-image edit, no LoRA trained for it - the weakest, offered to test).
Which two-image order the LoRA was trained on differs by version (Face V1 and
Head V1-V2 want face first, Head V3/V4/V5 want body first); "auto" reads it
off the file name and the prompt's Picture numbers follow.

Everything Comfy-side goes through core's node classes, like Re-angle.
Results are cached by (source, reference, prompt, settings) so a re-queue
that only moved the denoise does not re-run the edit model.
"""
import hashlib
import json
import re

import torch

from . import reangle as _engine

MODES = ("face", "head", "person")
# the Subject gallery's people, or "own": the Swap page's own gallery
REFS = ("subject", "subject2", "subject3", "own")
ORDERS = ("auto", "body_first", "face_first")

DEFAULTS = {
    "unet": _engine.DEFAULTS["unet"],
    "clip": _engine.DEFAULTS["clip"],
    "vae": _engine.DEFAULTS["vae"],
    "lora_swap": "",            # "" = the first BFS file in the loras folder
    "lora_light": "None",       # the author's advice: Lightning = plastic skin
}

# The author's own prompts, with the picture numbers left as placeholders so
# they follow the order. {face} is the reference, {body} the picture being edited.
PROMPTS = {
    "face": ("face swap face from {face} to {body}. swap only the face (not the "
             "hair), match the skin tone to {body}, keep {body} pose and lighting."),
    "head": ("head_swap: start with {body} as the base image, keeping its lighting, "
             "environment, and background. remove the head from {body} completely and "
             "replace it with the head from {face}, strictly preserving the hair, eye "
             "color, and nose structure of {face}. copy the eye direction, head "
             "rotation, and micro-expressions from {body}. high quality, sharp "
             "details, 4k"),
    "person": ("replace the person in {body} with the person from {face}, keeping "
               "the pose, framing, camera angle, lighting, environment and "
               "background of {body}. the face, hair, body and clothing come from "
               "{face}. high quality, sharp details"),
}


def parse(raw):
    """The Img2Img tab's swap block, normalised. Off by default."""
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
        "mode": pick("mode", MODES, "head"),
        "reference": pick("reference", REFS, "subject"),
        "order": pick("order", ORDERS, "auto"),
        "prompt": str(r.get("prompt") or "")[:2000],
        "keep_size": bool(r.get("keep_size", False)),
        # source: the Img2Img source before its pass. render: the finished render
        # (a Latent tab render too), then a polish pass of the rig over the result
        "target": pick("target", ("source", "render"), "source"),
        "polish": bool(r.get("polish", True)),
        "polish_denoise": num("polish_denoise", 0.3, 0.05, 1.0),
        # the engine
        "unet": str(r.get("unet") or DEFAULTS["unet"]),
        "clip": str(r.get("clip") or DEFAULTS["clip"]),
        "vae": str(r.get("vae") or DEFAULTS["vae"]),
        "lora_swap": str(r.get("lora_swap") or ""),
        "lora_swap_strength": num("lora_swap_strength", 1.0, 0.0, 2.0),
        "lora_light": str(r.get("lora_light") if r.get("lora_light") is not None else DEFAULTS["lora_light"]),
        "lora_light_strength": num("lora_light_strength", 1.0, 0.0, 2.0),
        "steps": num("steps", 16, 1, 60, int),
        "cfg": num("cfg", 2.0, 0.0, 20.0),
        "sampler": str(r.get("sampler") or "er_sde"),
        "scheduler": str(r.get("scheduler") or "beta"),
        "shift": num("shift", 3.0, 0.0, 10.0),
        "cfg_norm": bool(r.get("cfg_norm", False)),
        "seed": num("seed", 0, 0, 2 ** 63 - 1, int),
        "seed_random": bool(r.get("seed_random", True)),
    }


def guess_order(lora_name):
    """The two-image order a BFS file was trained on, from its name.
    Face V1 and Head V1/V2 = face first; Head V3+ = body first (the README's
    table). Anything unknown = body first, the current versions' order."""
    n = (lora_name or "").lower()
    if re.search(r"face[_\- ]?v1(?!\d)|head[_\- ]?v[12](?!\d)", n):
        return "face_first"
    return "body_first"


def default_lora():
    """The first BFS file for the Qwen edit model in the loras folder, or "".
    The Krea 2 / Flux / LTX BFS files are skipped: they carry the same name
    stem and do nothing on this engine."""
    try:
        import folder_paths
        names = list(folder_paths.get_filename_list("loras"))
    except Exception:
        return ""
    return pick_qwen_bfs(names)


def pick_qwen_bfs(names):
    low = [(n.lower(), n) for n in names]
    other = ("krea2", "krea_2", "flux", "klein", "ltx")
    cands = [(l, n) for l, n in low if "bfs" in l and not any(o in l for o in other)]
    for want in (lambda s: "qwen" in s or "2509" in s or "2511" in s, lambda s: True):
        for l, n in cands:
            if want(l):
                return n
    return ""


def resolve(sc):
    """The effective LoRA, order and prompt for this run."""
    lora = sc["lora_swap"] or default_lora()
    order = sc["order"] if sc["order"] != "auto" else guess_order(lora)
    if order == "face_first":
        face, body = "Picture 1", "Picture 2"
    else:
        face, body = "Picture 2", "Picture 1"
    template = sc["prompt"].strip() or PROMPTS[sc["mode"]]
    if sc["mode"] == "face" and not sc["prompt"].strip():
        # the Face V1 card says "Image N"; keep its words
        face, body = face.replace("Picture", "Image"), body.replace("Picture", "Image")
    prompt = template.replace("{face}", face).replace("{body}", body)
    return lora, order, prompt


def _key(img):
    t = img[:1, :, :, :3]
    thumb = torch.nn.functional.interpolate(t.permute(0, 3, 1, 2), size=(64, 64), mode="area")
    b = (thumb.clamp(0, 1) * 255).to(torch.uint8).contiguous().cpu().numpy().tobytes()
    return hashlib.sha1(b).hexdigest() + ":%dx%d" % (img.shape[2], img.shape[1])


def _valid_sampling(sampler, scheduler):
    try:
        import comfy.samplers as _cs
        if sampler not in _cs.KSampler.SAMPLERS:
            print("[RedNode Swap] sampler %r is not in this ComfyUI; using euler" % sampler, flush=True)
            sampler = "euler"
        if scheduler not in _cs.KSampler.SCHEDULERS:
            print("[RedNode Swap] scheduler %r is not in this ComfyUI; using simple" % scheduler, flush=True)
            scheduler = "simple"
    except Exception:
        pass
    return sampler, scheduler


def render(sc, source, reference, seed):
    """IMAGE tensor [N,H,W,3]: every frame of `source` with the person swapped
    for `reference` (one image). Cached."""
    with torch.inference_mode():
        return _render(sc, source, reference, seed)


def _render(sc, source, reference, seed):
    import nodes as _core
    lora, order, prompt = resolve(sc)
    if not lora:
        raise RuntimeError("no BFS LoRA found in the loras folder; pick one in the Swap engine")
    sampler, scheduler = _valid_sampling(sc["sampler"], sc["scheduler"])
    src_frames = [source[i:i + 1, :, :, :3] for i in range(source.shape[0])]
    ref = reference[:1, :, :, :3]
    key = json.dumps({"src": [_key(f) for f in src_frames], "ref": _key(ref), "p": prompt,
                      "order": order, "seed": int(seed), "steps": sc["steps"], "cfg": sc["cfg"],
                      "sampler": sampler, "scheduler": scheduler, "unet": sc["unet"],
                      "loras": [lora, sc["lora_swap_strength"], sc["lora_light"], sc["lora_light_strength"]],
                      "shift": sc["shift"], "cfg_norm": sc["cfg_norm"], "keep": sc["keep_size"]},
                     sort_keys=True)
    for k, imgs in _engine._RESULT_CACHE:
        if k == key:
            print("[RedNode Swap] %d frame(s) from the cache" % imgs.shape[0], flush=True)
            return imgs.clone()
    model, clip, vae = _engine.load_engine(
        sc["unet"], sc["clip"], sc["vae"],
        [(sc["lora_light"], sc["lora_light_strength"]), (lora, sc["lora_swap_strength"])],
        sc["shift"], sc["cfg_norm"], tag="Swap")
    print("[RedNode Swap] %s swap, %s, %s: %s" % (
        sc["mode"], lora, "face first" if order == "face_first" else "body first", prompt), flush=True)
    outs = []
    for i, frame in enumerate(src_frames):
        if sc["keep_size"]:
            scaled = frame
        else:
            try:
                scaled = _engine._call("FluxKontextImageScale", image=frame)
            except Exception:
                scaled = frame
        images = {"image1": ref, "image2": scaled} if order == "face_first" \
            else {"image1": scaled, "image2": ref}
        pos = _engine._call("TextEncodeQwenImageEditPlus", clip=clip, prompt=prompt, vae=vae, **images)
        neg = _engine._call("TextEncodeQwenImageEditPlus", clip=clip, prompt="", vae=vae, **images)
        latent = {"samples": vae.encode(scaled)}
        if len(src_frames) > 1:
            print("[RedNode Swap] frame %d of %d" % (i + 1, len(src_frames)), flush=True)
        out = _core.common_ksampler(model, int(seed) + i, int(sc["steps"]), float(sc["cfg"]),
                                    sampler, scheduler, pos, neg, latent, denoise=1.0)[0]
        img = vae.decode(out["samples"])
        while img.ndim > 4:
            img = img[0]
        outs.append(img[:, :, :, :3])
    h = min(o.shape[1] for o in outs)
    w = min(o.shape[2] for o in outs)
    imgs = torch.cat([o[:, :h, :w, :] for o in outs], dim=0).detach()
    _engine._RESULT_CACHE.insert(0, (key, imgs.cpu()))
    del _engine._RESULT_CACHE[_engine._RESULT_KEEP:]
    return imgs


def free():
    _engine.free()
