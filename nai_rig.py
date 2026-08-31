"""The NovelAI rig - PERSONAL ONLY, gitignored, never ships.

Registers the "novelai" rig kind: a Models-tab rig that renders through the
NovelAI API directly. The request construction is a one-for-one port of
ComfyUI_NAIDGenerator's GenerateNAID (don't reinvent, copy
what already works), including the v4 prompt structures, the Opus free-tier
limiter, variety, decrisper, SMEA, noise schedules, cfg rescale, uncond
scale, vibe transfer, character prompts, and the i2i strength/noise pair.
Transport is `requests` with the same retry policy the reference uses.

Token: the NAI_ACCESS_TOKEN environment variable, or the Token row on
  the rig, which writes it to the ComfyUI user directory - never into a
  workflow and never into the pack folder.

Settings read off the rig's raw dict (written by web/rednode_local_nai.js):
  nai_model      one of _MODELS (V2..V5), default nai-diffusion-4-5-full;
                 V5 has no vibe transfer yet, so vibes are dropped on V5
  nai_free       bool, Opus free-tier limiter (<=1024x1024, <=28 steps)
  nai_variety    bool -> skip_cfg_above_sigma by canvas size
  nai_decrisper  bool -> dynamic_thresholding
  nai_smea       "none" | "SMEA" | "SMEA+DYN"
  nai_uncond     float 0..1.5, uncond_scale
  nai_rescale    float 0..1, cfg_rescale
  nai_noise      float, i2i noise
  nai_vibe       list of {"data": b64 png, "strength": f, "info": f}
  nai_character  list of {"prompt", "negative", "center":{x,y}, "use_coords"}
The rig's steps/cfg/sampler carry the numbers (sampler is NAI's own name);
the rig's scheduler field is NAI's noise_schedule; width and height come
from the Latent tab. The image-is-the-switch rule stands: no source image
means action "generate", a source means "img2img" at the rig's denoise dial.
"""
import base64
import io
import hashlib
import json
import re
import os
import zipfile

import numpy as np
import requests
import torch
from requests.adapters import HTTPAdapter, Retry

from . import workspace as _ws

_BASE = "https://image.novelai.net"
def _token_paths():
    """Where a token may live, best first. NEVER inside the pack folder: a
    public pack is a checkout that gets updated, reinstalled and sometimes
    committed, and a credential in it is one `git add .` from being published.
    """
    out = []
    try:
        import folder_paths
        out.append(os.path.join(folder_paths.get_user_directory(), "default",
                                "rednode", "nai_token.txt"))
    except Exception:
        pass
    # the personal build kept it beside the module; still read, never written
    out.append(os.path.join(os.path.dirname(__file__), "local", "nai_token.txt"))
    out.append(os.path.join(os.path.dirname(__file__), "nai_token.txt"))
    return out


def _token_file(make=False):
    for p in _token_paths():
        if os.path.exists(p):
            return p
    p = _token_paths()[0]
    if make:
        os.makedirs(os.path.dirname(p), exist_ok=True)
    return p
_MODELS = ("nai-diffusion-2", "nai-diffusion-furry-3", "nai-diffusion-3",
           "nai-diffusion-4-curated-preview", "nai-diffusion-4-full",
           "nai-diffusion-4-5-curated", "nai-diffusion-4-5-full",
           # V5, launched 2026-08-21. These two id strings are NAI's naming
           # convention and match what NAIDGenerator ships, but NAI has not
           # published them; if a V5 render comes back "unknown model", the
           # string is what to fix.
           "nai-diffusion-5-curated", "nai-diffusion-5-full")
_SAMPLERS = ("k_euler", "k_euler_ancestral", "k_dpmpp_2s_ancestral",
             "k_dpmpp_2m_sde", "k_dpmpp_2m", "k_dpmpp_sde", "ddim")
_SCHEDULES = ("native", "karras", "exponential", "polyexponential")


def _token():
    """The NovelAI persistent token: the environment first, then the file."""
    env = (os.environ.get("NAI_ACCESS_TOKEN") or "").strip()
    if env:
        return env
    try:
        with open(_token_file(), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _calc_res(pixel_count, aspect):
    # NAID's calculate_resolution, verbatim: floor to 64s at a pixel budget
    pixel_count = pixel_count / 4096
    w, h = aspect
    k = (pixel_count * w / h) ** 0.5
    return int(np.floor(k) * 64), int(np.floor(k * h / w) * 64)


def _resize(image, w, h):
    import comfy.utils
    s = image.movedim(-1, 1)
    s = comfy.utils.common_upscale(s, w, h, "bilinear", "disabled")
    return s.movedim(1, -1)


def _b64_png(image):
    from PIL import Image
    arr = (image[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


_VIBE_MODEL_KEYS = {          # NAID's map, for .naiv4vibe encoding files
    "nai-diffusion-4-5-full": "v4-5full",
    "nai-diffusion-4-5-curated": "v4-5curated",
    "nai-diffusion-4-full": "v4full",
    "nai-diffusion-4-curated-preview": "v4curated",
}


def _vibe_png(data_b64, w, h):
    """The vibe re-encoded the way NAID sends it: canvas-sized PNG pixels.

    The raw upload can be a 4K photo; base64 of the whole file times the
    request out (you hit exactly this). NAID resizes every vibe to the
    canvas before encoding, keeping the payload small. Bytes in, bytes out.
    """
    from PIL import Image
    img = Image.open(io.BytesIO(base64.b64decode(data_b64))).convert("RGB")
    img = img.resize((w, h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _vibe_encoding(data_b64, model):
    """A .naiv4vibe file's precomputed encoding for this model, or None.

    One-for-one with NAID's VibeEncodingFile: prefer the current model's key,
    fall back to the first encoding present. Returns (encoding, info) or None.
    """
    data = json.loads(base64.b64decode(data_b64).decode("utf-8"))
    encodings = data.get("encodings") or {}
    info = (data.get("importInfo") or {}).get("information_extracted", 1.0)
    found = []
    for mkey, sub in encodings.items():
        if isinstance(sub, dict):
            for leaf in sub.values():
                if isinstance(leaf, dict) and leaf.get("encoding"):
                    found.append((mkey, leaf["encoding"]))
    if not found:
        return None
    want = _VIBE_MODEL_KEYS.get(model)
    for mkey, enc in found:
        if mkey == want:
            return enc, float(info)
    return found[0][1], float(info)


# ------------------------------------------------------------- vibe encoding
# THE ONE CALL IN THIS FILE THAT COSTS MONEY ( "we
# need to make sure we can spend the points to render the vibe, so when we load
# the image we should have a button to render the vibe file for the 2 points").
#
# For V4 and V4.5, a vibe reference must be ENCODED before it can steer a
# render. There are two ways that happens and only one of them is under your
# control:
#   - send the raw image with the generation. NAI encodes it server-side and
#     charges 2 Anlas EVERY TIME, because nothing is kept between requests.
#   - encode it once through /ai/encode-vibe, pay the 2 Anlas once, and keep
#     the encoding. Every render after that is free.
# So this is deliberately a button, never automatic, and the result is written
# to disk as a .naiv4vibe bundle: the same shape the NovelAI site exports and
# _vibe_encoding() already reads, so the two are interchangeable and re-encoding
# the same picture at the same settings costs nothing.
#
# Contract verified against the published NovelAI SDKs (2026-08-18):
#   POST {base}/ai/encode-vibe  {"image": <b64 png>, "information_extracted":
#   0<x<=1, "model": <full model name>} -> the encoding as raw bytes.
_ENCODE_MAX_PX = 1024          # what gets sent: a 4K photo is a needless upload


def _encode_png(data_b64, cap=_ENCODE_MAX_PX):
    """The uploaded picture as a PNG no larger than `cap` on its long side."""
    from PIL import Image
    img = Image.open(io.BytesIO(base64.b64decode(data_b64)))
    img = img.convert("RGB")
    if max(img.size) > cap:
        r = cap / float(max(img.size))
        img = img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))),
                         Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _post_encode_vibe(tok, image_b64, model, info):
    """The paid call. Returns the encoding as a base64 string, or raises."""
    resp = requests.post(f"{_BASE}/ai/encode-vibe",
                         json={"image": image_b64,
                               "information_extracted": float(info),
                               "model": str(model)},
                         headers={"Authorization": "Bearer " + tok},
                         timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError("HTTP %d - %s" % (resp.status_code, resp.text[:300]))
    return base64.b64encode(resp.content).decode("utf-8")


def _vibe_bundle(encoding_b64, model, info, source_name=""):
    """A minimal .naiv4vibe, in the shape _vibe_encoding() reads back."""
    key = _VIBE_MODEL_KEYS.get(model, model)
    return {
        "identifier": "novelai-vibe-transfer",
        "version": 1,
        "createdBy": "RedNode Studio",
        "name": source_name or "vibe",
        "importInfo": {"model": model, "information_extracted": float(info)},
        "encodings": {key: {"%g" % float(info): {"encoding": encoding_b64,
                                                 "params": {"information_extracted":
                                                            float(info)}}}},
    }


def encode_vibe_file(image_b64, model, info, name="vibe", tok=None,
                     post=_post_encode_vibe):
    """Encode a picture into a .naiv4vibe on disk. (rel_path, spent) where
    spent says whether this actually cost 2 Anlas.

    A file for the same picture, model and information_extracted is reused, so
    pressing the button twice on one image is free the second time.
    """
    digest = hashlib.sha1(base64.b64decode(image_b64)).hexdigest()[:12]
    stem = "%s_%s_%s_%g" % (re.sub(r"[^A-Za-z0-9_-]+", "_", name)[:40] or "vibe",
                            digest, _VIBE_MODEL_KEYS.get(model, model), float(info))
    d = _vibe_dir(make=True)
    path = os.path.join(d, stem + ".naiv4vibe")
    rel = "rednode/nai_vibe/" + os.path.basename(path)
    if os.path.exists(path):
        print("[RedNode NAI rig] vibe already encoded for this picture at "
              "information %g: no Anlas spent" % float(info), flush=True)
        return rel, False
    tok = tok if tok is not None else _token()
    if not tok:
        raise RuntimeError("no NovelAI token; cannot encode a vibe")
    enc = post(tok, _encode_png(image_b64), model, info)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_vibe_bundle(enc, model, info, name), f)
    print("[RedNode NAI rig] vibe encoded (2 Anlas) -> %s" % rel, flush=True)
    return rel, True


def _vibe_dir(make=False):
    import folder_paths
    d = os.path.join(folder_paths.get_input_directory(), "rednode", "nai_vibe")
    if make:
        os.makedirs(d, exist_ok=True)
    return d


def _read_vibe_file(rel):
    """A vibe file's bytes as base64, from inside input/ only."""
    import folder_paths
    root = os.path.realpath(folder_paths.get_input_directory())
    path = os.path.realpath(os.path.join(root, rel))
    if not (path == root or path.startswith(root + os.sep)):
        raise ValueError("outside the input folder")
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/nai_vibe_upload")
    @PromptServer.instance.routes.get("/rednode/nai_token")
    async def _rn_nai_token_get(request):
        """Whether a token is set, and where from. NEVER the token itself."""
        env = bool((os.environ.get("NAI_ACCESS_TOKEN") or "").strip())
        path = _token_file()
        has = env or os.path.exists(path)
        return web.json_response({"present": has,
                                  "source": "environment" if env
                                  else (path if os.path.exists(path) else ""),
                                  "path": _token_paths()[0]})

    @PromptServer.instance.routes.post("/rednode/nai_token")
    async def _rn_nai_token_post(request):
        """Store a token in the ComfyUI user directory. It never goes into the
        workflow, so it cannot be shared by sending someone your graph."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        tok = str(body.get("token") or "").strip()
        path = _token_file(make=True)
        if not tok:
            try:
                os.remove(path)
            except OSError:
                pass
            return web.json_response({"present": False, "cleared": True})
        with open(path, "w", encoding="utf-8") as f:
            f.write(tok)
        print("[RedNode NAI rig] token stored in %s" % path, flush=True)
        return web.json_response({"present": True, "path": path})

    @PromptServer.instance.routes.post("/rednode/nai_vibe_encode")
    async def _rn_nai_vibe_encode(request):
        """Encode one picture into a .naiv4vibe. THIS SPENDS 2 ANLAS, unless
        the same picture at the same information_extracted was encoded before,
        in which case the cached file comes back and nothing is spent.

        The panel calls this from a button and never on its own: an automatic
        encode is somebody's money going out with no click behind it.
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        img_b64 = str(body.get("image") or "")
        rel = str(body.get("file") or "")
        if not img_b64 and rel:
            try:
                import folder_paths
                path = os.path.join(folder_paths.get_input_directory(),
                                    *rel.split("/"))
                with open(path, "rb") as f:
                    img_b64 = base64.b64encode(f.read()).decode("utf-8")
            except Exception as exc:
                return web.json_response({"error": "cannot read %r: %s" % (rel, exc)},
                                         status=400)
        if not img_b64:
            return web.json_response({"error": "no image"}, status=400)
        model = str(body.get("model") or "nai-diffusion-4-5-full")
        try:
            info = float(body.get("info", 1.0))
        except (TypeError, ValueError):
            info = 1.0
        info = max(0.01, min(1.0, info))
        try:
            out, spent = encode_vibe_file(img_b64, model, info,
                                          name=str(body.get("name") or "vibe"))
        except Exception as exc:
            print("[RedNode NAI rig] vibe encode failed: %s" % exc, flush=True)
            return web.json_response({"error": str(exc)}, status=502)
        return web.json_response({"file": out, "spent": bool(spent),
                                  "anlas": 2 if spent else 0,
                                  "model": model, "info": info})

    async def _rn_nai_vibe_upload(request):
        """A .naiv4vibe file into input/rednode/nai_vibe (comfy's image
        upload refuses non-images). Images go through /upload/image."""
        try:
            reader = await request.multipart()
            field = await reader.next()
            name = os.path.basename(field.filename or "vibe.naiv4vibe")
            if not name.lower().endswith(".naiv4vibe"):
                return web.json_response({"error": "not a .naiv4vibe file"},
                                         status=400)
            d = _vibe_dir(make=True)
            base, ext = os.path.splitext(name)
            path = os.path.join(d, name)
            n = 1
            while os.path.exists(path):
                path = os.path.join(d, "%s_%d%s" % (base, n, ext))
                n += 1
            with open(path, "wb") as f:
                while True:
                    chunk = await field.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
            rel = "rednode/nai_vibe/" + os.path.basename(path)
            return web.json_response({"file": rel})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
except Exception as _e:
    print("[RedNode NAI rig] vibe upload route not registered: %s" % _e,
          flush=True)


def _from_zip(data):
    from PIL import Image
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            img = Image.open(io.BytesIO(z.read(name))).convert("RGB")
            out.append(torch.from_numpy(
                np.asarray(img).astype(np.float32) / 255.0))
    return torch.stack(out, 0) if out else None


def _post(tok, body):
    retries = Retry(total=3, backoff_factor=1,
                    status_forcelist=[429, 500, 502, 503, 504],
                    allowed_methods=["POST"])
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retries))
    resp = session.post(f"{_BASE}/ai/generate-image", json=body,
                        headers={"Authorization": "Bearer " + tok},
                        timeout=180)
    if resp.status_code >= 400:
        print("[RedNode NAI rig] HTTP %d - %s"
              % (resp.status_code, resp.text[:600]), flush=True)
        return None
    return resp.content


def _render(rig, cfg, prompt_text, negative_text, seed, source_image, denoise):
    tok = _token()
    if not tok:
        print("[RedNode NAI rig] no NovelAI token: put your persistent token in "
              "NAI_ACCESS_TOKEN or in the Token row on the rig; skipping",
              flush=True)
        return None
    raw = rig.get("raw") or {}
    lc = cfg.get("latent") or {}
    try:
        scale = float(lc.get("scale", 1.0) or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    w0 = int(int(lc.get("w", 832)) * scale)
    h0 = int(int(lc.get("h", 1216)) * scale)
    if source_image is not None:
        # i2i takes its canvas from the SOURCE's aspect, not the Latent tab:
        # a Detailer face crop must not be squeezed into a portrait canvas
        h0 = int(source_image.shape[1])
        w0 = int(source_image.shape[2])
    width, height = _calc_res(w0 * h0, (w0, h0))

    model = raw.get("nai_model") if raw.get("nai_model") in _MODELS \
        else "nai-diffusion-4-5-full"
    sampler = str(rig.get("sampler") or "").strip()
    if sampler not in _SAMPLERS:
        if sampler:
            print("[RedNode NAI rig] %r is not an NAI sampler; using "
                  "k_euler_ancestral" % sampler, flush=True)
        sampler = "k_euler_ancestral"
    schedule = str(rig.get("scheduler") or "").strip()
    if schedule not in _SCHEDULES:
        schedule = "native"
    smea = str(raw.get("nai_smea") or "none")
    steps = int(rig.get("steps", 28))
    guidance = float(rig.get("cfg", 5.0))
    seed = int(seed) % (10 ** 10)
    positive = prompt_text or ""
    negative = negative_text or ""

    # one-for-one with GenerateNAID.generate
    params = {
        "params_version": 1, "width": width, "height": height,
        "scale": guidance, "sampler": sampler, "steps": steps,
        "seed": seed, "n_samples": 1,
        # the site's Settings pane: Undesired Content Preset (0 Heavy, 1
        # Light, 2 Human Focus, 3 None) and Add Quality Tags, both server-side
        "ucPreset": int(raw.get("nai_ucpreset", 0)),
        "qualityToggle": bool(raw.get("nai_quality", True)),
        "sm": smea in ("SMEA", "SMEA+DYN") and sampler != "ddim",
        "sm_dyn": smea == "SMEA+DYN" and sampler != "ddim",
        "dynamic_thresholding": bool(raw.get("nai_decrisper")),
        "controlnet_strength": 1.0, "legacy": False,
        "add_original_image": False,
        "cfg_rescale": float(raw.get("nai_rescale", 0.0) or 0.0),
        "noise_schedule": schedule, "legacy_v3_extend": False,
        "uncond_scale": float(raw.get("nai_uncond", 1.0) or 1.0),
        "negative_prompt": negative, "prompt": positive,
        "reference_image_multiple": [],
        "reference_information_extracted_multiple": [],
        "reference_strength_multiple": [],
        "extra_noise_seed": seed,
        "v4_prompt": {"use_coords": False, "use_order": False,
                      "caption": {"base_caption": positive,
                                  "char_captions": []}},
        "v4_negative_prompt": {"use_coords": False, "use_order": False,
                               "caption": {"base_caption": negative,
                                           "char_captions": []}},
    }
    if sampler == "k_euler_ancestral" and schedule != "native":
        params["deliberate_euler_ancestral_bug"] = False
        params["prefer_brownian"] = True

    action = "generate"
    if source_image is not None:
        action = "img2img"
        params["image"] = _b64_png(_resize(source_image[:, :, :, :3],
                                           width, height))
        params["strength"] = max(0.01, min(0.99, float(denoise)))
        params["noise"] = max(0.0, min(0.99,
                                       float(raw.get("nai_noise", 0.0) or 0.0)))

    # V5 shipped without Vibe Transfer (NAI's own release post, 2026-08-21:
    # Vibe Transfer and Precise Reference "not yet released" for V5). Sending
    # the reference_* arrays anyway makes the whole render fail on a 400, so
    # drop them and say why. Delete this block when NAI ships vibe for V5.
    vibe_list = list(raw.get("nai_vibe") or [])
    if vibe_list and model.startswith("nai-diffusion-5"):
        print("[RedNode NAI rig] %s has no Vibe Transfer yet; %d vibe(s) left "
              "out of this render (the rig keeps them for when you switch "
              "back to a V4.x model)" % (model, len(vibe_list)), flush=True)
        vibe_list = []

    for v in vibe_list:
        # a vibe is a FILE in the input folder now (rednode/nai_vibe/...),
        # never bytes in the config: bytes in the config bloated every saved
        # workflow into the megabytes and broke the frontend's draft saves
        data_b64 = v.get("data") or ""
        if v.get("file") and not data_b64:
            try:
                data_b64 = _read_vibe_file(v["file"])
            except Exception as exc:
                print("[RedNode NAI rig] vibe file %r unreadable (%s); "
                      "skipped" % (v["file"], exc), flush=True)
                continue
        if not data_b64:
            continue
        try:
            if v.get("naiv4vibe"):
                got = _vibe_encoding(data_b64, model)
                if got is None:
                    print("[RedNode NAI rig] the .naiv4vibe file holds no "
                          "encoding; skipped", flush=True)
                    continue
                enc, file_info = got
                params["reference_image_multiple"].append(enc)
                params["reference_information_extracted_multiple"].append(
                    file_info)
            else:
                # resized to the canvas and re-encoded, the NAID way; the raw
                # file was megabytes and timed the request out
                if model in _VIBE_MODEL_KEYS:
                    # V4/V4.5 encode server-side, and that is 2 Anlas EVERY
                    # render. Encoding it once in the panel makes it free.
                    print("[RedNode NAI rig] vibe %r is a raw image, so NovelAI "
                          "encodes it again this render (2 Anlas). Press Encode "
                          "on the vibe to pay once and keep it."
                          % (v.get("file") or "an uploaded picture"), flush=True)
                params["reference_image_multiple"].append(
                    _vibe_png(data_b64, width, height))
                params["reference_information_extracted_multiple"].append(
                    float(v.get("info", 1.0)))
        except Exception as exc:
            print("[RedNode NAI rig] vibe unreadable (%s); skipped" % exc,
                  flush=True)
            continue
        params["reference_strength_multiple"].append(
            float(v.get("strength", 0.6)))

    chars = [c for c in (raw.get("nai_character") or [])
             if str(c.get("prompt") or "").strip()]
    if chars:
        char_caps, neg_caps, char_prompts = [], [], []
        any_coords = False
        for c in chars:
            center = c.get("center") or {"x": 0.5, "y": 0.5}
            char_caps.append({"char_caption": c["prompt"],
                              "centers": [center]})
            neg_caps.append({"char_caption": str(c.get("negative") or ""),
                             "centers": [center]})
            char_prompts.append({"prompt": c["prompt"],
                                 "uc": str(c.get("negative") or ""),
                                 "center": center, "enabled": True})
            if c.get("use_coords"):
                any_coords = True
        params["v4_prompt"]["caption"]["char_captions"] = char_caps
        params["v4_prompt"]["use_coords"] = any_coords
        params["v4_prompt"]["use_order"] = True
        params["v4_negative_prompt"]["caption"]["char_captions"] = neg_caps
        params["v4_negative_prompt"]["use_coords"] = any_coords
        params["v4_negative_prompt"]["use_order"] = True
        params["characterPrompts"] = char_prompts

    # the Opus free-tier limiter, ON by default like the reference node
    if raw.get("nai_free", True):
        if width * height > 1024 * 1024:
            params["width"], params["height"] = _calc_res(
                1024 * 1024, (width, height))
            # AND THE SOURCE HAS TO FOLLOW. The i2i image was encoded above at
            # the pre-limit size, so shrinking only the canvas sent NovelAI a
            # picture whose pixels disagreed with the width and height beside
            # it - every img2img from a source over 1 MP, which is most of
            # them (found 2026-08-19 while answering "how do I get i2i working
            # with NAI"). Re-encode at the size actually being asked for.
            if source_image is not None:
                params["image"] = _b64_png(_resize(
                    source_image[:, :, :, :3], params["width"], params["height"]))
        if steps > 28:
            params["steps"] = 28
    if raw.get("nai_variety"):
        params["skip_cfg_above_sigma"] = (
            (params["width"] * params["height"] / 1011712) ** 0.5 * 19)
    if sampler == "ddim" and "nai-diffusion-2" not in model:
        params["sampler"] = "ddim_v3"

    print("[RedNode NAI rig] %s %s: %d x %d, %d steps, guidance %.1f, %s/%s, "
          "seed %d%s%s%s%s"
          % (action, model, params["width"], params["height"],
             params["steps"], guidance, params["sampler"], schedule, seed,
             ", strength %.2f" % params["strength"] if action == "img2img"
             else "",
             ", %d vibe(s)" % len(params["reference_image_multiple"])
             if params["reference_image_multiple"] else "",
             ", %d character(s)" % len(chars) if chars else "",
             ", free-limit" if raw.get("nai_free", True) else ""),
          flush=True)
    data = _post(tok, {"input": positive, "model": model, "action": action,
                       "parameters": params})
    if data is None:
        return None
    img = _from_zip(data)
    if img is None:
        print("[RedNode NAI rig] the API answered but the zip held no image",
              flush=True)
        return None
    print("[RedNode NAI rig] received %d x %d" % (img.shape[2], img.shape[1]),
          flush=True)
    return img


def _handler(op, **ctx):
    if op == "render":
        return _render(ctx["rig"], ctx["cfg"], ctx["prompt_text"],
                       ctx["negative_text"], ctx["seed"],
                       ctx.get("source_image"), ctx.get("denoise", 1.0))
    return None


_ws.RIG_KIND_HANDLERS["novelai"] = _handler
print("[RedNode NAI rig] registered (NAID-parity)", flush=True)
