"""Realism: the Img2Img tab's medium stage.

An illustration goes in and a photograph comes out, before the workspace's own
i2i pass, the way Re-angle re-shoots the source before it. The Krea 2 pass then
runs on the converted picture at the tab's denoise.

THIS IS THE ANYTHING2REAL WORKFLOW, NODE FOR NODE. Not an equivalent of it: the
same nodes, in the same order, with the same values, called by name through
NODE_CLASS_MAPPINGS the way Re-angle and the Detailer's optional passes call
theirs. A first version rebuilt it from this pack's own parts (our identity
encoder for Easy_QwenEdit2509 and the Ostris patch, our own resize and colour
code, our sampler for core's KSampler). Each swap looked equivalent on its own
and together they were not: the results came back close and looser, a reference
rather than a copy. The workflow is the specification, so it runs as written.

  LoadImage -> ColorCorrect (saturation -20)
            -> ImageScaleByAspectRatio V2 (original, crop, lanczos, 512, longest 1536)
            -> Easy_QwenEdit2509 (crop, vl 384)
                 positive      -> FluxKontextMultiReferenceLatentMethod (index_timestep_zero)
                 zero_negative -> FluxKontextMultiReferenceLatentMethod (index_timestep_zero)
                 latent        -> KSampler
  rig model -> the rig's LoRA stack -> the conversion LoRA -> Krea2OstrisEditModelPatch
            -> KSampler (8 steps, cfg 1, euler, beta57, denoise 1.0) -> VAEDecode

The packs it needs are named up front, all of them, before anything loads.

TWO ENGINES, chosen on the page, never switched between on their own:

  exact        the workflow above. The default, and the one that matches it.
  alternative  the first version, kept because its look is worth having: this
               pack's own identity encoder with the reference method on, its own
               resize and colour, and the pack's sampler. Looser than the
               workflow, a reference more than a copy, which is the point of it.
               Needs no third-party pack at all.
"""

import json

import torch

WANT = "transform the image to realistic photograph"

# every node the graph calls, and where it comes from, so a missing one is named
# with the pack to install rather than failing half way through a load
NODES = {
    "ColorCorrect": "comfyui-post-processing-nodes",
    "LayerUtility: ImageScaleByAspectRatio V2": "ComfyUI_LayerStyle",
    "Easy_QwenEdit2509": "ComfyUI-Apt_Preset",
    "FluxKontextMultiReferenceLatentMethod": "ComfyUI core",
    "Krea2OstrisEditModelPatch": "comfyui-krea2-ostris-edit",
    "LoraLoader": "ComfyUI core",
    "KSampler": "ComfyUI core",
    "VAEDecode": "ComfyUI core",
}
# the workflow renders on beta57, which core's KSampler only knows once RES4LYF
# has registered it; a different beta57 would not be the workflow's
SCHEDULER_PACK = {"beta57": "RES4LYF", "bong_tangent": "RES4LYF"}
ROUNDINGS = ("8", "16", "32", "64", "128", "256", "512", "None")
ENGINES = ("exact", "alternative")
# THE SYSTEM INSTRUCTION: Easy_QwenEdit2509's own default, copied from the
# installed node and checked byte for byte (304 characters, the same 304 the
# workflow carries). It names the CHANGE rather than describing the picture,
# which is also what lets the alternative engine's reference boost sit at 1.0.
SYSTEM = ("Describe the key features of the input image (color, shape, size, "
              "texture, objects, background), then explain how the user's text "
              "instruction should alter or modify the image. Generate a new image that "
              "meets the user's requirements while maintaining consistency with the "
              "original input where appropriate.")
# THE CONVERSION LORAS THIS STAGE KNOWS, found by hash when nothing is chosen.
# `names` shortlists the installed files first, so finding one never means
# hashing a whole LoRA library; `sha256` then confirms which file it is. An
# empty sha256 falls back to the name match alone, and says so.
KNOWN_LORAS = (
    {"label": "Anything2Real Characters V3",
     "names": ("anything2real", "anythingtoreal", "a2r"),
     "sha256": ""},
)
# the bound on how many files one search may hash. The same bound the Civitai
# card's search holds: a shortlist, never a scan of the library.
FIND_MAX = 5
_RESULT_CACHE = []
_CACHE_KEEP = 4


def _installed():
    try:
        import folder_paths
        return list(folder_paths.get_filename_list("loras"))
    except Exception:
        return []


def _norm(text):
    return "".join(c for c in str(text or "").lower() if c.isalnum())


def lora_hash(name):
    """SHA256 of an installed LoRA, through the Civitai card's own disk cache, so
    a file is read once and never again while its size and date stay put."""
    try:
        import folder_paths
        from . import lora_info
        path = folder_paths.get_full_path("loras", name)
        return lora_info.file_sha256(path).lower() if path else ""
    except Exception:
        return ""


def _shortlist(hints, installed):
    hints = [_norm(h) for h in hints if len(_norm(h)) > 2]
    out = []
    for name in installed:
        stem = _norm(name.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        if any(h in stem for h in hints):
            out.append(name)
    return out[:FIND_MAX]


def find_lora(rc, installed=None, hasher=None):
    """(name, sha256, how) for the conversion LoRA, or ("", "", why).

    In order: the file chosen, if it is still there; the file whose hash was
    recorded when it was chosen, under whatever name it has now; the known
    Anything2Real LoRA. Only ever fills an empty or missing choice, never
    replaces one that is there.
    """
    installed = _installed() if installed is None else installed
    hasher = hasher or lora_hash
    chosen = rc.get("lora") or ""
    if chosen and chosen in installed:
        return chosen, rc.get("lora_sha256") or "", "chosen"

    want = (rc.get("lora_sha256") or "").lower()
    if want:
        # the recorded file under a new name: shortlist by the old name first
        hints = [chosen.rsplit("/", 1)[-1].rsplit(".", 1)[0]] + [
            h for k in KNOWN_LORAS for h in k["names"]]
        for name in _shortlist(hints, installed):
            if hasher(name) == want:
                return name, want, "hash"

    for known in KNOWN_LORAS:
        for name in _shortlist(known["names"], installed):
            if known["sha256"]:
                if hasher(name) == known["sha256"].lower():
                    return name, known["sha256"].lower(), "hash"
            else:
                # no reference hash yet: a name match, labelled as one
                return name, "", "name"
    return "", "", "not found"


def parse(raw):
    """The Img2Img tab's realism block, normalised. Off by default.

    Every default is the workflow's own value. Anything not in the workflow is
    not here.
    """
    r = raw if isinstance(raw, dict) else {}

    def num(k, dv, lo, hi, cast=float):
        try:
            v = cast(r.get(k, dv))
        except (TypeError, ValueError):
            v = dv
        return max(lo, min(hi, v))

    def pick(k, options, dv):
        v = str(r.get(k)) if r.get(k) is not None else None
        return v if v in options else dv

    return {
        "on": bool(r.get("on", False)),
        "engine": pick("engine", ENGINES, "exact"),
        # alternative only: how hard the encoder holds the source. 1.0 converts
        # with the instruction below; 1.5 holds the illustration.
        "boost": num("boost", 1.0, 0.0, 3.0),
        # the conversion LoRA: the user's own download, so no file is named here
        "lora": str(r.get("lora") or ""),
        # the SHA256 of the file that was chosen, recorded when it was picked, so
        # the same LoRA is found again under another name or on another machine:
        # a shared workflow carries the hash with it
        "lora_sha256": str(r.get("lora_sha256") or "").lower()[:64],
        "strength": num("strength", 1.0, 0.0, 2.0),
        # the rig's LoRA stack under it, as the workflow stacks one under it
        "loras": bool(r.get("loras", True)),
        "lora_set": str(r.get("lora_set") or "")[:48],
        # "" = the Models tab's rig. The workflow loads its own three files, so a
        # rig on a different encoder or VAE will not match until these are set.
        "unet": str(r.get("unet") or ""),
        "clip": str(r.get("clip") or ""),
        "vae": str(r.get("vae") or ""),
        "prompt": str(r.get("prompt") if r.get("prompt") is not None else WANT)[:500],
        # the node's second box: what the encoder is told to BE. Both engines read
        # it. Empty comes back as the default rather than as no instruction.
        "system": (str(r.get("system")) if str(r.get("system") or "").strip()
                   else SYSTEM)[:2000],
        # ColorCorrect
        "saturation": num("saturation", -20.0, -100.0, 100.0),
        # ImageScaleByAspectRatio V2
        "round_to": pick("round_to", ROUNDINGS, "512"),
        "longest": num("longest", 1536, 256, 4096, int),
        "fit": pick("fit", ("letterbox", "crop", "fill"), "crop"),
        # Easy_QwenEdit2509
        "vl_size": num("vl_size", 384, 64, 2048, int),
        "auto_resize": pick("auto_resize", ("crop", "pad", "stretch"), "crop"),
        # Krea2OstrisEditModelPatch
        "kv_cache": bool(r.get("kv_cache", False)),
        # KSampler
        "steps": num("steps", 8, 1, 100, int),
        "cfg": num("cfg", 1.0, 0.0, 20.0),
        "sampler": str(r.get("sampler") or "euler"),
        "scheduler": str(r.get("scheduler") or "beta57"),
        "seed": num("seed", 0, 0, 2 ** 53, int),
        "seed_random": bool(r.get("seed_random", True)),
        "skip_pass": bool(r.get("skip_pass", False)),
    }


def _source_key(image):
    """Cheap fingerprint of a source tensor, as Re-angle keys its cache."""
    t = image[:1, ::16, ::16, :3].float()
    return [list(image.shape), round(float(t.mean()), 6), round(float(t.std()), 6)]


def _registry():
    import nodes as _core
    return getattr(_core, "NODE_CLASS_MAPPINGS", None) or {}


def missing(rc):
    """Every pack this run needs and does not have, named, before any load.

    The alternative engine is this pack and core, so it needs nothing at all.
    """
    if rc.get("engine") == "alternative":
        return []
    reg = _registry()
    out = sorted({pack for node, pack in NODES.items() if node not in reg})
    try:
        import comfy.samplers as _cs
        if rc["scheduler"] not in _cs.KSampler.SCHEDULERS:
            out.append("%s (for the %s scheduler)"
                       % (SCHEDULER_PACK.get(rc["scheduler"], "a pack that adds it"),
                          rc["scheduler"]))
    except Exception:
        pass
    return out


def _call(name, **kw):
    """A node through the entry point IT declares, looked up by name."""
    cls = _registry().get(name)
    if cls is None:
        raise ValueError("this ComfyUI has no %s node (install %s)"
                         % (name, NODES.get(name, "the pack that provides it")))
    fn = getattr(cls(), getattr(cls, "FUNCTION", "") or "", None)
    if fn is None:
        raise ValueError("the %s node has no callable entry point" % name)
    return fn(**kw)


def sampler_for(node_id, label):
    """Core's KSampler node, streaming a frame a step under `node_id`.

    The node itself, not a helper standing in for it: the workflow runs core's
    KSampler, and beta57 there is whichever one RES4LYF registered. The live
    stream wraps prepare_callback, which the KSampler node reaches through
    common_ksampler, so watching it costs nothing.
    """
    def run(**kw):
        return _call("KSampler", **kw)
    if node_id is None:
        return run
    try:
        from . import live_preview as _live
        return _live.sampled(node_id, run, label=label)
    except Exception:
        return run


def _prepared(image, rc):
    """The alternative engine's picture: desaturated, bounded, snapped.

    It reads the same recipe the exact engine does where the values mean the same
    thing: the saturation cut, the rounding and the longest side.
    """
    img = image[:1, :, :, :3].float()
    amount = max(0.0, -float(rc["saturation"])) / 100.0
    if amount > 0:
        lum = (img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722)
        img = img * (1.0 - amount) + lum.unsqueeze(-1) * amount
    h, w = int(img.shape[1]), int(img.shape[2])
    snap = 16 if rc["round_to"] == "None" else max(16, int(rc["round_to"]))
    scale = min(1.0, float(rc["longest"]) / max(h, w))
    nh = max(snap, int(round(h * scale / snap)) * snap)
    nw = max(snap, int(round(w * scale / snap)) * snap)
    if (nh, nw) != (h, w):
        import comfy.utils
        moved = img.movedim(-1, 1)
        img = comfy.utils.common_upscale(moved, nw, nh, "lanczos", "disabled").movedim(1, -1)
    return img.clamp(0.0, 1.0)


def alt_sampler_for(node_id, label):
    """The pack's own sampler for the alternative engine, streamed.

    Its beta57 is the pack's continuous curve rather than RES4LYF's stepped one,
    part of why this engine looks the way it does. It returns the latent itself,
    not core's one-tuple.
    """
    from . import sampler_dials as _dials
    if node_id is None:
        return _dials.sample_with_dials
    try:
        from . import live_preview as _live
        return _live.sampled(node_id, _dials.sample_with_dials, label=label)
    except Exception:
        return _dials.sample_with_dials


def _render_alternative(rc, source, model, clip, vae, seed, node_id):
    """The first version: this pack's identity encoder, reference method on."""
    src = _prepared(source, rc)
    latent = {"samples": vae.encode(src)}
    from .identity import Krea2IdentityEdit
    positive = Krea2IdentityEdit().encode(
        clip=clip, prompt=rc["prompt"], vae=vae, image=src,
        grounding_px=int(rc["vl_size"]), ref_boost=rc["boost"],
        ref_boost_a=rc["boost"], target_latent=latent, fit_mode="fit",
        ref_t0_modulation=True, system_prompt=rc["system"])[0]
    negative = _call("CLIPTextEncode", clip=clip, text="")[0]
    return alt_sampler_for(node_id, "realism")(
        model, int(seed), int(rc["steps"]), float(rc["cfg"]), rc["sampler"],
        rc["scheduler"], positive, negative, latent, denoise=1.0)


def _engine(rc, cfg, ws):
    """(model, clip, vae) - the rig's, or the files this block names instead."""
    rig_name, model, clip, vae = ws.load_active_rig(cfg)
    if rc["unet"]:
        model = _call("UNETLoader", unet_name=rc["unet"], weight_dtype="default")[0]
    if rc["clip"]:
        clip = _call("CLIPLoader", clip_name=rc["clip"], type="krea2")[0]
    if rc["vae"]:
        vae = _call("VAELoader", vae_name=rc["vae"])[0]
    return rig_name, model, clip, vae


def render(rc, source, cfg, seed, node_id=None):
    """IMAGE [1,H,W,3]: the source as a photograph. Cached by what made it."""
    with torch.inference_mode():
        return _render(rc, source, cfg, seed, node_id)


def _render(rc, source, cfg, seed, node_id=None):
    # a choice that is empty, or names a file that has gone, is looked for by
    # hash before it is refused: a shared workflow or a renamed file still runs
    if not str(rc["lora"] or "").strip() or rc["lora"] not in _installed():
        name, digest, how = find_lora(rc)
        if name:
            print("[RedNode Realism] conversion LoRA found by %s: %s" % (how, name),
                  flush=True)
            rc = dict(rc, lora=name, lora_sha256=digest or rc.get("lora_sha256", ""))
    # what can be refused without loading anything comes first
    if not str(rc["lora"] or "").strip():
        raise ValueError("no realism LoRA is chosen on the Img2Img tab, and none "
                         "was found by hash either: pick one first.")
    need = missing(rc)
    if need:
        raise ValueError("the Anything2Real graph needs %s, which this ComfyUI does "
                         "not have" % ", ".join(need))

    from . import workspace as _ws
    key = json.dumps({"src": _source_key(source), "seed": int(seed),
                      "rc": {k: v for k, v in rc.items() if k not in ("on", "skip_pass")}},
                     sort_keys=True)
    for k, img in _RESULT_CACHE:
        if k == key:
            print("[RedNode Realism] from the cache", flush=True)
            return img.clone()

    rig_name, model, clip, vae = _engine(rc, cfg, _ws)
    if model is None or clip is None or vae is None:
        raise ValueError("the realism pass needs a model, a text encoder and a VAE: "
                         "set them on the Models tab or on this page.")

    # the LoRAs: the rig's stack first, the conversion LoRA on top, on model AND
    # clip, which is what the workflow's two stack nodes do
    if rc["loras"]:
        try:
            from . import lora_stack as _lora
            lc = _ws.lora_set_cfg(cfg, rc["lora_set"] or _ws.rig_lora_set(cfg),
                                  "Realism") or {}
            slots = lc.get("slots") or []
            if slots and lc.get("on", True):
                model, _c2, _w, applied = _lora.apply_stack(
                    model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": lc.get("ui") or {}, "slots": slots}),
                    int(lc.get("seed", 0) or 0), None, tag="Realism LoRAs")
                clip = _c2 if _c2 is not None else clip
                print("[RedNode Realism] rig stack applied: %s" % applied, flush=True)
        except Exception as exc:
            print("[RedNode Realism] the rig's LoRA stack could not be applied (%s); "
                  "the conversion LoRA runs alone" % exc, flush=True)
    model, clip = _call("LoraLoader", model=model, clip=clip, lora_name=rc["lora"],
                        strength_model=rc["strength"], strength_clip=rc["strength"])[:2]

    if rc["engine"] == "alternative":
        print("[RedNode Realism] alternative engine: %s on %s, boost %.2f, %d steps"
              % (rc["lora"], rig_name or "the active rig", rc["boost"], rc["steps"]),
              flush=True)
        out = _render_alternative(rc, source, model, clip, vae, seed, node_id)
        return _finish(key, _call("VAEDecode", samples=out, vae=vae)[0])

    # the picture, exactly as the workflow prepares it
    img = source[:1, :, :, :3]
    img = _call("ColorCorrect", image=img, temperature=0.0, hue=0.0, brightness=0.0,
                contrast=0.0, saturation=float(rc["saturation"]), gamma=1.0)[0]
    img = _call("LayerUtility: ImageScaleByAspectRatio V2",
                aspect_ratio="original", proportional_width=1, proportional_height=1,
                fit=rc["fit"], method="lanczos", round_to_multiple=rc["round_to"],
                scale_to_side="longest", scale_to_length=int(rc["longest"]),
                background_color="#000000", image=img)[0]

    # the encode: image1 and latent_image are the same picture, and both of the
    # node's boxes are filled, the prompt and the system instruction
    positive, negative, latent = _call(
        "Easy_QwenEdit2509", clip=clip, vae=vae, image1=img, latent_image=img,
        auto_resize=rc["auto_resize"], vl_size=int(rc["vl_size"]),
        prompt=rc["prompt"], system_prompt=rc["system"])[:3]
    positive = _call("FluxKontextMultiReferenceLatentMethod", conditioning=positive,
                     reference_latents_method="index_timestep_zero")[0]
    negative = _call("FluxKontextMultiReferenceLatentMethod", conditioning=negative,
                     reference_latents_method="index_timestep_zero")[0]
    model = _call("Krea2OstrisEditModelPatch", model=model,
                  kv_cache=bool(rc["kv_cache"]))[0]

    print("[RedNode Realism] %s on %s: %d steps, cfg %s, %s / %s, vl %d, round %s"
          % (rc["lora"], rig_name or "the active rig", rc["steps"], rc["cfg"],
             rc["sampler"], rc["scheduler"], rc["vl_size"], rc["round_to"]), flush=True)
    # core's KSampler node returns a one-tuple; the latent is its first item
    out = sampler_for(node_id, "realism")(
        model=model, seed=int(seed), steps=int(rc["steps"]), cfg=float(rc["cfg"]),
        sampler_name=rc["sampler"], scheduler=rc["scheduler"], positive=positive,
        negative=negative, latent_image=latent, denoise=1.0)[0]
    return _finish(key, _call("VAEDecode", samples=out, vae=vae)[0])


def _finish(key, image):
    """Out of inference mode, cached, and handed back."""
    # a plain tensor, so nothing downstream trips over one whose version counter
    # is not tracked
    image = torch.from_numpy(image.detach().cpu().numpy())
    _RESULT_CACHE.append((key, image.clone()))
    del _RESULT_CACHE[:-_CACHE_KEEP]
    return image


# ---------------------------------------------------------------------------
# HTTP: the page asks which file is the conversion LoRA, and what a chosen one
# hashes to so the hash can travel with the workflow
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/realism/find_lora")
    async def _rednode_realism_find(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        rc = {"lora": str(data.get("lora") or ""),
              "lora_sha256": str(data.get("lora_sha256") or "").lower()[:64]}
        name, digest, how = find_lora(rc)
        return web.json_response({"name": name, "sha256": digest, "how": how})

    @PromptServer.instance.routes.post("/rednode/realism/lora_hash")
    async def _rednode_realism_hash(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        name = str(data.get("name") or "")
        if name not in _installed():
            return web.json_response({"error": "no such LoRA"}, status=404)
        return web.json_response({"name": name, "sha256": lora_hash(name)})

except Exception as e:  # no server (tests, a bare import)
    print("[RedNode Krea2] realism routes not registered: %s" % e, flush=True)
