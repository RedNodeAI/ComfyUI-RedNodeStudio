"""RedNode Studio Detailer: the post-render passes as a list, not a wire maze.

Start, then the passes in order, then End. Each pass names a RIG from the Models tab,
so a face can be detailed by a different model from the one that rendered the frame.
Two pass kinds, both taken from the shapes you already runs as subgraphs:

  sampler   whole-frame refine at a denoise, an img2img over the incoming picture
  detailer  SAM3 segments a target (face, hair, hands...), a low-denoise pass over
            the crop, composited back through a feathered mask
  upscale   SeedVR2 at a named size (720p to 4K), the workflow's upscale group as
            one card: its two loaders, its dials, and its short-edge maths

Every pass carries the full sampler vocabulary: steps, CFG, sampler, scheduler, a
denoise, and a start/end step window for the partial-schedule tricks detailer chains
are built from. Anything left at its "rig" default inherits the rig's own settings
(detailer passes take the rig's detailer_steps, sampler passes its steps), so the
Models tab stays the one place a model's numbers live.

The prompt is the workspace's own when the box is empty: the pass looks up the
Prompts-tab row for ITS rig, exactly the text the main render used, wildcards rolled
on this run's seed. Typed text in the pass wins, the standing rule.

SAM3 arrives through ComfyUI-Easy-Sam3 when it is installed, the same pack the
release workflow already carries, and the SAM model is a visible choice per pass
rather than a silent default. Without the pack the detailer stage says so plainly
and passes the image through, because a silent no-op teaches the wrong lesson and a
hard error kills a queue over an optional dependency.
"""

import json

import torch
import torch.nn.functional as F

import comfy.samplers
import nodes as _core

from . import workspace as _ws
from . import live_preview as _live
from . import sampler_dials as _dials
from .paint_render import _bbox, _encode_text, _workspace_cfg, grow_to_aspect, \
    region_aspect


def parse_pipeline(config_json):
    """The stage list, normalised. Unknown kinds are dropped, values clamped.

    Zero means "the rig's": steps, cfg, sampler and scheduler left at their zero
    values inherit from the stage's rig, so the parse cannot fill real defaults in
    without erasing that meaning.
    """
    try:
        data = json.loads(config_json or "{}")
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    stages = []
    for s in (data.get("stages") if isinstance(data.get("stages"), list) else []):
        if not isinstance(s, dict):
            continue
        if s.get("type") == "title":
            # a group header: pure panel furniture that divides the list. The
            # run skips it; it parses so the round trip never loses a group.
            stages.append({"type": "title", "on": bool(s.get("on", True)),
                           "name": str(s.get("name") or ""),
                           "color": str(s.get("color") or "")})
            continue
        if s.get("type") not in ("sampler", "detailer", "upscale", "usdu"):
            continue

        def _num(key, lo, hi, dv, cast=float):
            try:
                v = cast(s.get(key, dv))
            except (TypeError, ValueError):
                v = dv
            return max(lo, min(hi, v))
        stages.append({
            "on": bool(s.get("on", True)),
            "type": s["type"],
            "rig": str(s.get("rig") or ""),
            "prompt": str(s.get("prompt") or ""),
            "negative": str(s.get("negative") or ""),
            "denoise": _num("denoise", 0.0, 1.0,
                            0.15 if s["type"] == "detailer" else
                            0.25 if s["type"] == "usdu" else 0.3),
            "steps": _num("steps", 0, 200, 0, int),          # 0 = the rig's
            "cfg": _num("cfg", 0.0, 30.0, 0.0),              # 0 = the rig's
            "sampler": str(s.get("sampler") or ""),          # "" = the rig's
            "scheduler": str(s.get("scheduler") or ""),      # "" = the rig's
            "start_step": _num("start_step", 0, 200, 0, int),
            "end_step": _num("end_step", 0, 200, 0, int),    # 0 = to the end
            "target": str(s.get("target") or "face"),
            "sam_model": str(s.get("sam_model") or ""),      # "" = the loader default
            # 1.0 is the picture as it arrives. A sampler pass at 0.5 then another
            # at 2.0 is the shrink-and-regrow chain that invents detail, which is
            # the whole point of this node being a list.
            "scale": _num("scale", 0.25, 4.0, 1.0),
            # ON by default, because everywhere else in the pack a rig arrives
            # carrying its stack; raw is the explicit choice, not the accident
            "loras": bool(s.get("loras", True)),
            # which LoRAs-tab SET this pass runs with: "" = the rig's own
            # choice (Models tab), and that "" too = Main
            "lora_set": str(s.get("lora_set") or "")[:48],
            # Krea 2 references for this pass, the same three toggles the Paint
            # tab offers, off by default for the same reason they are there
            "use_subject": bool(s.get("use_subject")),
            "use_scene": bool(s.get("use_scene")),
            "use_moodboard": bool(s.get("use_moodboard")),
            # PICTURE: the picture as it arrives (a detailer's crop) rides the
            # pass as the FIRST reference, the Scene slot - the base image of
            # a two-reference edit LoRA (BFS head/body swap on Krea 2: base
            # first, the Subject second, the order the Studio already keeps).
            # Wins over the Scene tab when both are on. Off by default.
            "use_picture": bool(s.get("use_picture")),
            # A LoRA only THIS pass loads, model side, on top of the stack (or
            # of the raw rig): the swap file lives here, never on the main
            # render. "" / "None" = nothing.
            "lora": str(s.get("lora") or ""),
            "lora_strength": _num("lora_strength", 0.0, 2.0, 1.0),
            "threshold": _num("threshold", 0.05, 0.95, 0.5),
            "feather": _num("feather", 0, 64, 8, int),
            # BLEND: how much of the rendered crop goes back. 1 is the render
            # under the mask as before; 0.5 halves it against the crop as it
            # was, the dial tuned against denoise (0.3 to 0.5 with blend under
            # 1 keeps a face's own skin under a stronger repaint).
            "blend": _num("blend", 0.0, 1.0, 1.0),
            "padding": _num("padding", 0.0, 2.0, 0.35),
            # FREE VRAM before this pass: every model ComfyUI holds unloaded at
            # the moment nothing is mid-allocation, so a big rig or the SeedVR2
            # loaders never overlap the pass before. Runs every queue.
            "free_vram": bool(s.get("free_vram")),
            # TONE LOCK: the result keeps its own detail and takes the pass
            # input's tone (its low frequencies at a radius) by strength, skin
            # hue held. The drift fix for a long chain. Off by default.
            "tone_lock": bool(s.get("tone_lock")),
            "tone_radius": _num("tone_radius", 4, 256, 32, int),
            "tone_strength": _num("tone_strength", 0.0, 1.0, 1.0),
            # an upscale pass on a region only: SAM3's target, the crop through
            # the upscaler and back under the feathered matte. "" is the frame.
            "region": str(s.get("region") or "")[:48],
            # A TILED UPSCALE (Ultimate SD Upscale): the rig's model and prompt
            # over tiles, an upscale model first ("" is a plain resize), the
            # tile, its padding and mask blur, the seam fix. Denoise above 0.4
            # invents subjects in tiles, so the defaults sit at 0.25.
            "usdu_model": str(s.get("usdu_model") or ""),
            "upscale_by": _num("upscale_by", 0.25, 4.0, 2.0),
            "usdu_tile": _num("usdu_tile", 256, 2048, 1024, int),
            "usdu_padding": _num("usdu_padding", 0, 512, 128, int),
            "usdu_blur": _num("usdu_blur", 0, 64, 8, int),
            "usdu_mode": str(s.get("usdu_mode") or "Linear"),
            "seam_mode": str(s.get("seam_mode") or "None"),
            "seam_denoise": _num("seam_denoise", 0.0, 1.0, 0.35),
            "seam_width": _num("seam_width", 0, 512, 64, int),
            "seam_padding": _num("seam_padding", 0, 512, 16, int),
            "tiled_decode": bool(s.get("tiled_decode")),
            # the crop's working resolution: its long edge is resized to this
            # before rendering, then the result goes back at the crop's own
            # size. 0 keeps the old behaviour, the crop as it comes (x Scale).
            # A small face stops meaning a quality-starved render.
            "crop_res": _num("crop_res", 0, 4096, 0, int),
            # iteration, the Paint tab's Passes on a single pass: run this pass
            # over its own result N times, fresh seed each round
            "repeat": _num("repeat", 1, 10, 1, int),
            "color": str(s.get("color") or ""),      # panel cosmetics, kept
            # WHICH PROMPT this pass reads when its box is empty: "" is the row
            # linked to its rig, else a Prompts-tab row by name, or "#N" for
            # the Nth row when it has no name
            "prompt_row": str(s.get("prompt_row") or "")[:64],
            # A SEEDVR2 UPSCALE PASS: its size and the loader dials the workflow
            # sets by hand. "" on a combo is the loader's own default.
            "size": str(s.get("size") or "1080p"),
            "dit_model": str(s.get("dit_model") or ""),
            "vae_model": str(s.get("vae_model") or ""),
            "attention": str(s.get("attention") or ""),
            "blocks_to_swap": _num("blocks_to_swap", 0, 36, 36, int),
            "offload": str(s.get("offload") or "cpu"),
            "cache_model": bool(s.get("cache_model")),
            "tiled": (True if s.get("tiled") is None else bool(s.get("tiled"))),
            "tile": _num("tile", 64, 4096, 1024, int),
            "tile_overlap": _num("tile_overlap", 0, 1024, 128, int),
            "color_fix": str(s.get("color_fix") or "lab"),
            "max_edge": _num("max_edge", 0, 16384, 0, int),
            "input_noise": _num("input_noise", 0.0, 1.0, 0.0),
            "latent_noise": _num("latent_noise", 0.0, 1.0, 0.0),
        })
        if stages[-1]["size"] not in UPSCALE_SIZES:
            stages[-1]["size"] = "1080p"
        st = stages[-1]
        # A DENOISE PER ROUND and A SCALE PER ROUND, the Img2Img PASS rule on a
        # repeat. Off, each list is the single dial repeated, so the loop reads
        # one field either way; on, a short list repeats its last value, so a
        # raised count never moves a number already chosen. round_stage says
        # what the scale list means on each kind of pass.
        st["pass_custom"], st["pass_denoise"] = _ws._pass_list(
            s.get("pass_denoise"), s.get("pass_custom"), st["denoise"],
            0.0, 1.0, st["repeat"])
        st["scale_custom"], st["pass_scale"] = _ws._pass_list(
            s.get("pass_scale"), s.get("scale_custom"), st["scale"],
            0.25, 4.0, st["repeat"])
        if st["scale_custom"]:
            st["scale"] = st["pass_scale"][0]
    try:
        seed = int(data.get("seed", 0))
    except (TypeError, ValueError):
        seed = 0
    return {"stages": stages, "seed": max(0, seed),
            "seed_random": (True if data.get("seed_random") is None
                            else bool(data.get("seed_random"))),
            # record the input, every pass and the output into the RedNode
            # Stage View strip, so a chain can be read step by step without
            # wiring taps. Off by default, per the house rule.
            "taps": bool(data.get("taps")),
            # the long edge the strip keeps each frame at; 0 is the frame as it is
            "tap_px": (int(data["tap_px"])
                       if isinstance(data.get("tap_px"), (int, float))
                       and not isinstance(data.get("tap_px"), bool)
                       and int(data["tap_px"]) >= 0 else 768),
            # the node's own SAM: the checkpoint every detailer pass segments
            # with unless it names its own, and the precision it loads at. ""
            # is the loader's first file and the loader's own precision.
            "sam_model": str(data.get("sam_model") or ""),
            "sam_precision": str(data.get("sam_precision") or "")}


def round_stage(s, r):
    """The stage as round `r` of its repeat runs it.

    Denoise comes off the per-round list when that is on. Scale is the subtle
    one. A sampler pass's scale STICKS (whatever runs next sees the new size),
    so with the list on each round is a size against the picture as it arrived
    and the resize applied is the ratio to the round before; with it off the
    first round scales and the rest refine at the size it landed on, so 1.5x
    three times can never quietly become 3.4x. A detailer's scale only renders
    the crop bigger and never sticks, so each round simply takes its own.
    """
    out = dict(s)
    if s.get("pass_custom") and s.get("pass_denoise"):
        lst = s["pass_denoise"]
        out["denoise"] = float(lst[min(r, len(lst) - 1)])
    if s.get("scale_custom") and s.get("pass_scale"):
        lst = s["pass_scale"]
        cur = float(lst[min(r, len(lst) - 1)])
        if s["type"] == "sampler" and r > 0:
            prev = float(lst[min(r - 1, len(lst) - 1)])
            out["scale"] = cur / prev if prev > 1e-6 else 1.0
        else:
            out["scale"] = cur
    elif s["type"] == "sampler" and r > 0:
        out["scale"] = 1.0
    return out


# The upscale sizes as a PIXEL BUDGET, the way the workflow's combo carried
# them (921600, 2073600, ...): 1080p means 1920 x 1080's pixels whatever the
# frame's shape, and the short edge is worked out from its own aspect.
UPSCALE_SIZES = {"720p": 1280 * 720, "1080p": 1920 * 1080, "2K": 2048 * 1080,
                 "1440p": 2560 * 1440, "4K": 3840 * 2160}


def upscale_short_edge(w, h, target_px):
    """The workflow's own maths, min(sqrt(a/(b*c))*b, sqrt(a/(b*c))*c): the
    short edge that puts target_px pixels in a w x h frame at its aspect. Even,
    which the upscaler asks for."""
    f = (float(target_px) / max(1, int(w) * int(h))) ** 0.5
    return max(16, int(round(f * min(int(w), int(h)) / 2.0)) * 2)


def _box_blur(t, radius):
    """A separable box blur run twice on [B,H,W,C]: a cheap near-gaussian,
    edges weighted by what is there rather than by padding."""
    k = int(radius) * 2 + 1
    x = t.permute(0, 3, 1, 2)
    for _ in range(2):
        x = F.avg_pool2d(x, (k, 1), stride=1, padding=(k // 2, 0),
                         count_include_pad=False)
        x = F.avg_pool2d(x, (1, k), stride=1, padding=(0, k // 2),
                         count_include_pad=False)
    return x.permute(0, 2, 3, 1)


def tone_lock(before, after, radius=32, strength=1.0, skin=0.5):
    """The pass result with the pass input's tone. The result keeps its high
    frequencies (the detail the pass made); the input's low frequencies at the
    radius replace its own, by strength; skin hue is held to the input's. Colour
    and exposure stop wandering pass to pass down a long chain."""
    strength = max(0.0, min(1.0, float(strength)))
    if strength <= 0:
        return after
    a = after[:, :, :, :3]
    b = before[:, :, :, :3].to(a.device, a.dtype)
    if b.shape[1:3] != a.shape[1:3]:
        b = F.interpolate(b.permute(0, 3, 1, 2), size=a.shape[1:3], mode="bilinear",
                          align_corners=False).permute(0, 2, 3, 1)
    if b.shape[0] != a.shape[0]:
        b = b[:1].expand(a.shape[0], -1, -1, -1)
    r = max(1, min(int(radius), min(a.shape[1], a.shape[2]) // 2))
    locked = (a - _box_blur(a, r) + _box_blur(b, r)).clamp(0, 1)
    if skin > 0:
        try:
            from . import postprocess as _pp     # its helpers are NCHW
            locked = _pp._skin_hold(b.permute(0, 3, 1, 2), locked.permute(0, 3, 1, 2),
                                    skin).permute(0, 2, 3, 1)
        except Exception:
            pass
    return (a + (locked - a) * strength).clamp(0, 1)


def _is_oom(exc):
    oom = getattr(torch.cuda, "OutOfMemoryError", None)
    if oom is not None and isinstance(exc, oom):
        return True
    return "out of memory" in str(exc).lower()


def _call_node(cls, kw):
    """A node called the way the graph calls it, its outputs as a list. A V3
    node (comfy_api io.ComfyNode) hands back a NodeOutput with the values in
    .args rather than a tuple."""
    out = getattr(cls(), cls.FUNCTION)(**kw)
    vals = getattr(out, "args", None)
    if vals is None:
        vals = out if isinstance(out, (tuple, list)) else [out]
    return list(vals)


def _seedvr2(image, s, seed):
    """The picture through SeedVR2 at the pass's size, or None with a reason.

    The workflow's upscale group, mechanised: the DiT loader, the VAE loader
    and the upscaler, called through their own classes out of
    NODE_CLASS_MAPPINGS so this follows the pack instead of reimplementing it.
    The resolution is the workflow's maths, the short edge that puts the size's
    pixels in the frame. Nothing is cached here: the loaders own that (their
    cache_model dial), and a 7B checkpoint held twice is a RAM surprise.
    Everything inside one try for the reason SAM3 is: an optional pack must
    fail as words, never as a dead queue.
    """
    try:
        maps = _core.NODE_CLASS_MAPPINGS
        dit_cls = maps.get("SeedVR2LoadDiTModel")
        vae_cls = maps.get("SeedVR2LoadVAEModel")
        up_cls = maps.get("SeedVR2VideoUpscaler")
        if dit_cls is None or vae_cls is None or up_cls is None:
            return None, ("ComfyUI-SeedVR2_VideoUpscaler is not installed, and it "
                          "is what upscales. Install it in Manager.")

        def fill(cls, values):
            # the loader's own defaults, then the pass's choices over them;
            # "" on a combo keeps the default, a dial the node lacks is dropped
            kw = _defaults_for(cls)
            have = _all_inputs(cls)
            for k, v in values.items():
                if k in have and v is not None and v != "":
                    kw[k] = v
            return kw
        dit = _call_node(dit_cls, fill(dit_cls, {
            "model": s["dit_model"], "blocks_to_swap": s["blocks_to_swap"],
            "swap_io_components": False, "offload_device": s["offload"],
            "cache_model": s["cache_model"], "attention_mode": s["attention"]}))[0]
        h, w = int(image.shape[1]), int(image.shape[2])
        res = upscale_short_edge(
            w, h, UPSCALE_SIZES.get(s["size"], UPSCALE_SIZES["1080p"]))
        # THE TILE LADDER: an out-of-memory with the tiled VAE on halves the
        # tile (overlap kept to a quarter of it) down to 64 before giving up,
        # so a card that cannot fit 1024 still finishes at 512 or 256
        tile = int(s["tile"])
        while True:
            overlap = min(int(s["tile_overlap"]), tile // 4)
            vae = _call_node(vae_cls, fill(vae_cls, {
                "model": s["vae_model"], "encode_tiled": s["tiled"],
                "encode_tile_size": tile, "encode_tile_overlap": overlap,
                "decode_tiled": s["tiled"], "decode_tile_size": tile,
                "decode_tile_overlap": overlap,
                "offload_device": s["offload"], "cache_model": s["cache_model"]}))[0]
            try:
                outs = _call_node(up_cls, fill(up_cls, {
                    "image": image, "dit": dit, "vae": vae,
                    "seed": int(seed) & 0xffffffff, "resolution": res,
                    "max_resolution": s["max_edge"], "batch_size": 1,
                    "uniform_batch_size": False, "temporal_overlap": 0,
                    "prepend_frames": 0, "color_correction": s["color_fix"],
                    "input_noise_scale": s["input_noise"],
                    "latent_noise_scale": s["latent_noise"],
                    "offload_device": s["offload"], "enable_debug": False}))
                break
            except Exception as exc:
                if not (s["tiled"] and tile > 64 and _is_oom(exc)):
                    raise
                tile = max(64, tile // 2)
                print("[RedNode Detailer] SeedVR2 ran out of memory; the tile is "
                      "halved to %d and the pass tried again" % tile, flush=True)
                try:
                    import comfy.model_management as _mm
                    _mm.soft_empty_cache()
                except Exception:
                    pass
        for v in outs:
            if torch.is_tensor(v) and v.ndim == 4:
                return v, None
        return None, "SeedVR2 returned no image"
    except Exception as exc:
        return None, "SeedVR2 failed: %s" % exc


def _pass_prompt_row(ws_cfg, s):
    """The Prompts-tab row a pass reads: the one it names, else its rig's.

    A name that no longer exists falls back to the rig's row and says so,
    because a pass that silently went mute would be blamed on the model.
    """
    want = str(s.get("prompt_row") or "").strip()
    rows = (ws_cfg.get("prompts") or {}).get("rows") or []
    if want:
        for row in rows:
            if row.get("name") and row["name"] == want:
                return row
        if want.startswith("#"):
            try:
                idx = int(want[1:]) - 1
                if 0 <= idx < len(rows):
                    return rows[idx]
            except ValueError:
                pass
        print("[RedNode Detailer] prompt row %r is not on the Prompts tab; "
              "using the rig's" % want, flush=True)
    return _ws.prompt_row_for(ws_cfg["models"], ws_cfg["prompts"], s["rig"])


def _rig_settings(ws_cfg, name):
    """The named rig's dict, or the active one's, or bare defaults."""
    rigs = ws_cfg.get("models", {}).get("rigs") or []
    want = str(name or "").strip()
    for r in rigs:
        if want and r.get("name") == want:
            return r
    if rigs:
        return rigs[max(0, min(int(ws_cfg["models"].get("active", 0)),
                               len(rigs) - 1))]
    return {"steps": 8, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
            "detailer_steps": 8}


def resolve_sampling(stage, rig):
    """The numbers this pass actually runs with: its own, else the rig's.

    A detailer pass inherits the rig's detailer_steps, which is what that field has
    always been for; a sampler pass inherits the rig's main steps. An unknown
    sampler or scheduler degrades to the rig's, then to euler/simple, because an
    unknown combo value fails queue validation blaming the wrong node.
    """
    steps = stage["steps"] or (rig.get("detailer_steps", 8)
                               if stage["type"] == "detailer"
                               else rig.get("steps", 8))
    cfg = stage["cfg"] or rig.get("cfg", 1.0)
    sampler = stage["sampler"] or rig.get("sampler", "euler")
    if sampler not in comfy.samplers.KSampler.SAMPLERS:
        sampler = "euler"
    scheduler = stage["scheduler"] or rig.get("scheduler", "simple")
    if not _dials.scheduler_ok(scheduler):
        scheduler = "simple"
    start = min(stage["start_step"], max(0, int(steps) - 1))
    end = stage["end_step"] or None
    if end is not None:
        end = max(start + 1, min(int(end), int(steps)))
    return int(steps), float(cfg), sampler, scheduler, int(start), end


def _fill(cls, values):
    """The node's own defaults, then these choices over them: "" on a combo
    keeps the default, and a dial the node lacks is dropped, so a version that
    grew or lost a widget still calls."""
    kw = _defaults_for(cls)
    have = _all_inputs(cls)
    for k, v in values.items():
        if k in have and v is not None and v != "":
            kw[k] = v
    return kw


def _all_inputs(cls):
    it = cls.INPUT_TYPES()
    merged = {}
    merged.update(it.get("required") or {})
    merged.update(it.get("optional") or {})
    return merged


def _defaults_for(cls):
    """Every input's declared default, so a version that grew a widget still calls."""
    out = {}
    for name, spec in _all_inputs(cls).items():
        if isinstance(spec, (tuple, list)) and spec:
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if "default" in opts:
                out[name] = opts["default"]
            elif isinstance(spec[0], list) and spec[0]:
                out[name] = spec[0][0]
    return out


_SAM3_CACHE = {"key": None, "model": None}


def _sam3_mask(image, target, threshold, sam_model="", precision=""):
    """A [1,H,W] mask for `target`, through ComfyUI-Easy-Sam3, or None with a reason.

    The Easy-Sam3 nodes are called the way the graph calls them, through their own
    classes out of NODE_CLASS_MAPPINGS, so this follows that pack instead of
    reimplementing it. `sam_model` overrides the loader's checkpoint choice when
    set. Everything is inside one try because an optional dependency may be absent,
    half-installed or reshaped, and every one of those must come back as words
    rather than a dead queue. `precision` is the loader's own choice (fp16,
    bf16, fp32) when set; its default is fp32, which is twice the memory.
    """
    try:
        loader_cls = _core.NODE_CLASS_MAPPINGS.get("easy sam3ModelLoader")
        seg_cls = _core.NODE_CLASS_MAPPINGS.get("easy sam3ImageSegmentation")
        if loader_cls is None or seg_cls is None:
            return None, ("ComfyUI-Easy-Sam3 is not installed, and it is what "
                          "segments %r. Install it in Manager." % target)
        loader = loader_cls()
        lkw = _defaults_for(loader_cls)
        if sam_model:
            for key in ("model_name", "model", "ckpt_name", "sam_model"):
                if key in _all_inputs(loader_cls):
                    lkw[key] = sam_model
                    break
        if precision and "precision" in _all_inputs(loader_cls):
            lkw["precision"] = precision
        # a default checkpoint name that is not actually in the loader's list
        # (folder renamed, file updated) raises before anything segments; the
        # first real choice beats a stale default
        for key in ("model_name", "model", "ckpt_name"):
            spec = _all_inputs(loader_cls).get(key)
            if (spec and isinstance(spec[0], list) and spec[0]
                    and lkw.get(key) not in spec[0]):
                lkw[key] = spec[0][0]
        # ONE load per model choice, not one per pass: SAM3 is a full checkpoint
        # off disk, and three face passes were three multi-second reloads
        ckey = json.dumps(lkw, sort_keys=True, default=str)
        if _SAM3_CACHE["key"] == ckey and _SAM3_CACHE["model"] is not None:
            model = _SAM3_CACHE["model"]
        else:
            model = getattr(loader, loader_cls.FUNCTION)(**lkw)[0]
            _SAM3_CACHE["key"] = ckey
            _SAM3_CACHE["model"] = model
        seg = seg_cls()
        kwargs = _defaults_for(seg_cls)
        for key in ("sam3_model", "model"):
            if key in _all_inputs(seg_cls):
                kwargs[key] = model
        for key in ("image", "images"):
            if key in _all_inputs(seg_cls):
                kwargs[key] = image
        for key in ("prompt", "text", "text_prompt"):
            if key in _all_inputs(seg_cls):
                kwargs[key] = target
        for key in ("threshold", "confidence", "confidence_threshold"):
            if key in _all_inputs(seg_cls):
                kwargs[key] = threshold
        out = getattr(seg, seg_cls.FUNCTION)(**kwargs)
        # the mask is whichever output is mask-shaped; packs disagree about order.
        # A V3 node (comfy_api io.ComfyNode, which Easy-Sam3 is) hands back a
        # NodeOutput whose values live in .args, not a tuple: the old scan looked
        # AT the NodeOutput instead of inside it, found no tensor, and every
        # detailer pass "passed through" while claiming there was no mask.
        vals = getattr(out, "args", None)
        if vals is None:
            vals = out if isinstance(out, (tuple, list)) else [out]
        for v in vals:
            if torch.is_tensor(v) and v.ndim == 3:
                if v.shape[0] > 1:
                    # several detections (two faces, both hands): one coverage
                    # mask, so the pass redraws them all rather than erroring
                    v = v.amax(0, keepdim=True)
                return v, None
        return None, "the segmenter returned no mask for %r" % target
    except Exception as exc:
        return None, "SAM3 failed on %r: %s" % (target, exc)


class RedNodeStudioDetailer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "the rendered frame, usually the "
                                    "workspace's image output"}),
                "config": ("STRING", {"default": "{}", "multiline": True,
                                      "tooltip": "the pass list; the panel edits "
                                                 "this"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "report")
    FUNCTION = "run"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("The post-render passes as a visual list: sampler refines and "
                   "SAM3 face detailers in order, each through a rig picked from "
                   "the Models tab, each with its own steps, CFG, sampler, "
                   "scheduler and start/end step window, no wires between them. An "
                   "empty prompt box uses the rig's own Prompts-tab row. Feed the "
                   "workspace's image output in, take the finished picture out, "
                   "and put the post process after it.")

    @staticmethod
    def _tab_tensor(ws_cfg, name, multi=False):
        """The tab's selected image(s) as a tensor, or None, never an error."""
        try:
            t = ws_cfg.get("tabs", {}).get(name) or {}
            if not t.get("on") or not t.get("images"):
                return None
            target = ws_cfg.get("resize", 1024) or 1024
            if multi and isinstance(t.get("sel"), list):
                picks = [t["images"][j] for j in t["sel"]
                         if 0 <= j < len(t["images"])]
                if not picks:
                    return None
                return _ws.batch_images(
                    [_ws.load_image(pk, target) for pk in picks])
            j = t.get("sel") or 0
            if isinstance(j, list):
                j = j[0] if j else 0
            j = max(0, min(int(j), len(t["images"]) - 1))
            return _ws.load_image(t["images"][j], target)
        except Exception as exc:
            print("[RedNode Detailer] could not load the %s reference: %s"
                  % (name, exc), flush=True)
            return None

    @staticmethod
    def _notify(unique_id, stage, total, state):
        """Tell the panel which card is running, so the list lights up live.

        Config indices, not enabled-only ones: a skipped pass must not shift the
        highlight onto its neighbour. Fails silent, because the progress light is
        a nicety and the render is the job.
        """
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "rednode-detailer-step",
                {"node": str(unique_id), "stage": stage, "total": total,
                 "state": state})
        except Exception:
            pass

    def run(self, image, config="{}", prompt=None, unique_id=None, **_custom_rigs):
        # _custom_rigs: queue-time links from RedNode Custom Rig nodes; order only
        self._rn_prompt = prompt              # a rig's own sampler chain reads it
        # A paint-door run or an external-sampler workspace hands over no image
        # at all; pass the nothing along like Review and Save do, don't crash
        if image is None:
            print("[RedNode Detailer] no image arrived (paint run or external "
                  "sampler), passes skipped", flush=True)
            return (_ws.blocked(), "no image arrived, passes skipped")
        cfg = parse_pipeline(config)
        self._rn_uid = unique_id          # the Live Preview stream's tag for this node
        stages = [(k, s) for k, s in enumerate(cfg["stages"])
                  if s["on"] and s["type"] != "title"]
        report = []
        if not stages:
            return (image, "no passes configured")
        try:
            ws_cfg = _ws.parse_config(json.dumps(_workspace_cfg(prompt)))
        except Exception:
            ws_cfg = _ws.parse_config("{}")
        if ws_cfg.get("draft"):
            # the Workspace's Draft switch: every pass skipped, the frame through,
            # so a seed can be judged on the base render before it costs anything
            line = ("draft: the Workspace's Draft switch is on, every pass skipped and "
                    "the frame passed through")
            print("[RedNode Detailer] " + line, flush=True)
            self._notify(unique_id, -1, len(cfg["stages"]), "end")
            return (image, line)
        import random as _random
        seed = (_random.getrandbits(48) if cfg["seed_random"] else cfg["seed"])
        # THE TAPS: with the toggle on, the strip gets the input as it arrived,
        # a frame after every pass (every repeat round too), and the output.
        # Recording is never fatal: a thumbnail that fails to build is one
        # missing frame in the strip, not a dead queue.
        tap = None
        if cfg.get("taps"):
            try:
                from . import stages as _stages
                tap = lambda img, label: _stages.record(
                    img, label, prompt=prompt, source="detailer", px=cfg["tap_px"])
            except Exception as exc:
                print("[RedNode Detailer] taps unavailable: %s" % exc, flush=True)
        if tap:
            tap(image, "Detailer in")

        out = image
        for i, (card_idx, s) in enumerate(stages, 1):
            self._notify(unique_id, card_idx, len(cfg["stages"]), "run")
            tag = "%d/%d %s" % (i, len(stages), s["type"])
            s = dict(s, sam_model=s["sam_model"] or cfg["sam_model"],
                     sam_precision=cfg["sam_precision"])
            pass_in = out
            if s["free_vram"]:
                # every model ComfyUI holds unloaded before this pass, while
                # nothing is mid-allocation; the next sampler pays one load
                try:
                    from . import vram as _vram
                    count, freed = _vram.free_models()
                    line = "%s: freed %d model(s), about %d MB, before the pass" % (
                        tag, count, freed // (1024 * 1024))
                except Exception as exc:
                    line = "%s: free VRAM failed: %s" % (tag, exc)
                print("[RedNode Detailer] " + line, flush=True)
                report.append(line)
            # A SEEDVR2 UPSCALE loads no rig: the pack's own loaders do the
            # loading, and a pass that could not run passes the picture on.
            # With a region it works the target's crop only, and the frame
            # keeps its size: the region gains the detail, the way a detailer's
            # scale spends pixels on a face.
            if s["type"] == "upscale":
                if s["region"]:
                    self._rn_live_label = "upscale %d of %d" % (i, len(stages))
                    up, why = self._each_frame(
                        out, lambda frame, _s=s, _seed=seed + i:
                        self._upscale_region(frame, _s, _seed))
                    if why is not None:
                        up = None
                else:
                    up, why = _seedvr2(out, s, seed + i)
                if up is not None:
                    line = ("%s: SeedVR2 %s on %s, %d x %d kept" % (
                                tag, s["size"], s["region"], out.shape[2], out.shape[1])
                            if s["region"] else
                            "%s: SeedVR2 %s, %d x %d -> %d x %d" % (
                                tag, s["size"], out.shape[2], out.shape[1],
                                up.shape[2], up.shape[1]))
                    out = self._tone(up, pass_in, s, tag, report)
                else:
                    line = "%s: %s; passed through" % (tag, why)
                print("[RedNode Detailer] " + line, flush=True)
                report.append(line)
                if tap and up is not None:
                    tap(out, "%d upscale %s" % (i, s["size"]))
                continue
            # AN ENGINE RIG (a handled kind, the personal NovelAI rig) takes
            # its own road: the handler renders, nothing loads
            rigd = _rig_settings(ws_cfg, s["rig"])
            if rigd.get("kind") in _ws.RIG_KIND_HANDLERS:
                if s["type"] == "usdu":
                    line = ("%s: a tiled upscale needs a model rig and %r is an "
                            "engine rig; passed through" % (tag, rigd.get("name") or s["rig"]))
                    print("[RedNode Detailer] " + line, flush=True)
                    report.append(line)
                    continue
                out, lines = self._handler_pass(out, rigd, s, ws_cfg,
                                                seed + i, tag, tap)
                for line in lines:
                    print("[RedNode Detailer] " + line, flush=True)
                    report.append(line)
                out = self._tone(out, pass_in, s, tag, report)
                continue
            rig_name, model, clip, vae = _ws.load_active_rig(ws_cfg, name=s["rig"],
                                                             prompt=prompt)
            if model is None or clip is None or vae is None:
                line = "%s: rig %r is missing a %s, pass skipped" % (
                    tag, s["rig"] or rig_name or "(active)",
                    "model" if model is None else
                    "clip" if clip is None else "vae")
                print("[RedNode Detailer] " + line, flush=True)
                report.append(line)
                continue
            rig = _rig_settings(ws_cfg, s["rig"])
            steps, cfg_v, sampler, scheduler, start, end = resolve_sampling(s, rig)
            # the rig's sampler dials ride every pass on it: its shift on the model
            # now, Detail Daemon, Seed Variance and densify at the sampler call
            self._rn_dials = rig.get("dials") or {}
            self._rn_chain = rig.get("custom_sampler") or ""
            if self._rn_dials.get("shift"):
                model = _dials.apply_shift(model, self._rn_dials["shift"])
            # THE STACK, unless this pass says raw: the main LoRAs tab applied to
            # model AND clip, the same halves the rest of the pack learned to keep
            # together the hard way
            lc = _ws.lora_set_cfg(
                ws_cfg, s["lora_set"] or _ws.rig_lora_set(ws_cfg, s["rig"]), "Detailer")
            if s["loras"] and lc.get("on", True) and lc.get("slots"):
                try:
                    from . import lora_stack as _lora
                    model, _c2, _w, _applied = _lora.apply_stack(
                        model, clip, _lora.CUSTOM_SENTINEL,
                        json.dumps({"ui": lc.get("ui") or {},
                                    "slots": lc.get("slots") or []}),
                        int(lc.get("seed", 0) or 0), unique_id,
                        tag="Detailer LoRAs (%s)" % lc["name"])
                    clip = _c2 if _c2 is not None else clip
                except Exception as exc:
                    print("[RedNode Detailer] LoRAs failed on this pass: %s" % exc,
                          flush=True)
            if s["lora"] and s["lora"] != "None" and s["lora_strength"] > 0:
                try:
                    model = _pass_lora(model, s["lora"], s["lora_strength"])
                    print("[RedNode Detailer] pass LoRA %s @ %.2f" % (
                        s["lora"], s["lora_strength"]), flush=True)
                except Exception as exc:
                    print("[RedNode Detailer] pass LoRA %s failed: %s" % (
                        s["lora"], exc), flush=True)
            # THE WORKSPACE'S PROMPT IS THE DEFAULT: the row for this pass's rig,
            # the same text the main render used, wildcards rolled on this seed.
            # Typed text in the pass wins, the standing rule.
            text = s["prompt"]
            if not text.strip():
                row = _pass_prompt_row(ws_cfg, s)
                if row is not None:
                    try:
                        from .prompt_frame import expand as _pf_expand
                        text = _pf_expand(row["text"], seed + i, True)
                    except Exception:
                        text = row["text"]
            # THE REFERENCES, for a Krea 2 rig: any of the three toggles routes
            # this pass through the Studio encode with the tab images loaded, the
            # identity system instead of plain text. On any other rig they are
            # politely ignored, the same rule the Paint tab follows.
            refs_wanted = (s["use_subject"] or s["use_scene"]
                           or s["use_moodboard"] or s["use_picture"])
            rig_is_krea2 = rig.get("clip_type") == "krea2"
            if refs_wanted and not rig_is_krea2:
                print("[RedNode Detailer] references are Krea 2 conditioning and "
                      "rig %r is not a Krea 2 rig; encoding plain text"
                      % (rig_name or "(active)"), flush=True)
            # PICTURE makes the encode depend on what the pass is looking at
            # (the frame for a sampler pass, the crop for a detailer), so the
            # encode is a function and runs where the picture is known.
            use_picture = s["use_picture"] and rig_is_krea2

            def _encode(picture=None):
                if refs_wanted and rig_is_krea2:
                    try:
                        from .rednode import Krea2RedNode, PRESETS as _PRESETS, \
                            CUSTOM_SENTINEL as _CUSTOM
                        preset = ws_cfg.get("studio_preset") or "Balanced"
                        settings = None
                        target = None
                        if use_picture:
                            scene = picture[:, :, :, :3] if picture is not None else None
                            # A base-conditioned edit (the swap LoRAs) is the
                            # author's geometry: refs FITTED to the sampled size
                            # (v1.2 fit path, needs the target latent) and no
                            # attention boost on either reference - his workflow
                            # runs ref_boost 1 / 1. The Studio's Balanced 2.5x on
                            # the subject over-drives a swap LoRA into noise.
                            if scene is not None:
                                target = {"samples": torch.zeros(
                                    (1, 4, scene.shape[1] // 8, scene.shape[2] // 8))}
                            base = dict(_PRESETS.get(preset) or _PRESETS["Balanced"])
                            base.update(reference_fidelity=1.0, scene_fidelity=1.0,
                                        fit_mode="fit")
                            settings, preset = base, _CUSTOM
                        else:
                            scene = (self._tab_tensor(ws_cfg, "scene")
                                     if s["use_scene"] else None)
                        return Krea2RedNode().encode(
                            clip, text, preset,
                            0.5, negative_prompt=s["negative"], vae=vae,
                            subject_image=(self._tab_tensor(ws_cfg, "subject")
                                           if s["use_subject"] else None),
                            scene_image=scene,
                            moodboard_style=(self._tab_tensor(ws_cfg, "moodboard",
                                                              multi=True)
                                             if s["use_moodboard"] else None),
                            output_latent=target, settings=settings)
                    except Exception as exc:
                        print("[RedNode Detailer] reference encode failed, plain "
                              "text instead: %s" % exc, flush=True)
                return _encode_text(clip, text), _encode_text(clip, s["negative"])

            pos = neg = None
            if not use_picture:
                pos, neg = _encode()
            window = ("" if start == 0 and end is None
                      else ", steps %d..%s" % (start, end if end is not None
                                               else "end"))
            # REPEAT, the Paint tab's iteration on one pass: the pass runs over
            # its own result N times, a fresh seed each round, and only the last
            # picture moves on. A detailer that passed through (no mask, no SAM)
            # stops repeating: the same miss N times is noise in the console.
            reps = int(s.get("repeat", 1))
            why = None
            for r in range(max(1, reps)):
                rseed = seed + i + r * 131
                sr = round_stage(s, r)          # this round's denoise and scale
                # what the streamed frames say they are (live_preview.py)
                self._rn_live_label = "%s %d of %d" % (
                    "detailer" if s["type"] == "detailer" else "pass", i, len(stages)) \
                    + (" · round %d of %d" % (r + 1, reps) if reps > 1 else "")
                if s["type"] == "sampler":
                    def _one(frame, _sr=sr, _seed=rseed):
                        p, n = pos, neg
                        if use_picture:
                            pic = self._resize(frame, _sr["scale"])
                            if s.get("crop_res"):
                                pic = self._resize(pic, s["crop_res"] / max(pic.shape[1], pic.shape[2]))
                            p, n = _encode(pic)
                        return self._sample(frame, model, p, n, vae, _sr, _seed,
                                            steps, cfg_v, sampler, scheduler,
                                            start, end), None
                    out, _ = self._each_frame(out, _one)
                    line = ("%s: rig %r, %d steps%s, cfg %.1f, %s/%s, denoise "
                            "%.2f" % (tag, rig_name, steps, window, cfg_v,
                                      sampler, scheduler, sr["denoise"]))
                    if abs(sr["scale"] - 1.0) >= 1e-3:
                        line += ", scale %.2f -> %d x %d" % (
                            sr["scale"], out.shape[2], out.shape[1])
                elif s["type"] == "usdu":
                    before = (out.shape[2], out.shape[1])
                    def _one(frame, _sr=sr, _seed=rseed):
                        return self._usdu(frame, model, pos, neg, vae, _sr, _seed,
                                          steps, cfg_v, sampler, scheduler)
                    out, why = self._each_frame(out, _one)
                    line = "%s: tiled upscale on rig %r, %s" % (
                        tag, rig_name,
                        why or ("x%.2f %s, %d steps, %s/%s, denoise %.2f, tile %d, "
                                "%d x %d -> %d x %d"
                                % (sr["upscale_by"], sr["usdu_model"] or "resize",
                                   steps, sampler, scheduler, sr["denoise"],
                                   sr["usdu_tile"], before[0], before[1],
                                   out.shape[2], out.shape[1])))
                else:
                    def _one(frame, _sr=sr, _seed=rseed):
                        return self._detail(frame, model, pos, neg, vae, _sr, _seed,
                                            steps, cfg_v, sampler, scheduler,
                                            start, end,
                                            encode_for=_encode if use_picture else None)
                    out, why = self._each_frame(out, _one)
                    line = "%s: %s on rig %r, %s" % (
                        tag, s["target"], rig_name,
                        why or ("%d steps%s, %s/%s, denoise %.2f"
                                % (steps, window, sampler, scheduler,
                                   sr["denoise"])))
                if reps > 1:
                    line += ", repeat %d of %d" % (r + 1, reps)
                print("[RedNode Detailer] " + line, flush=True)
                report.append(line)
                if tap and not why:
                    tap(out, "%d %s%s" % (i, s["target"] if s["type"] == "detailer"
                                          else "usdu" if s["type"] == "usdu"
                                          else "sampler",
                                          " x%d" % (r + 1) if reps > 1 else ""))
                if why:
                    break
            if not why:
                out = self._tone(out, pass_in, s, tag, report)
        if tap:
            tap(out, "Detailer out")
        self._notify(unique_id, -1, len(cfg["stages"]), "end")
        return (out, "\n".join(report))

    def _usdu(self, frame, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
              scheduler):
        """Ultimate SD Upscale as a pass: the rig's model and this pass's prompt
        over tiles, through the pack's own node out of NODE_CLASS_MAPPINGS. An
        upscale model runs first; "" is a plain resize by the factor and the
        NoUpscale node. Returns (image, None) or (frame, why)."""
        maps = _core.NODE_CLASS_MAPPINGS
        cls, cls_no = maps.get("UltimateSDUpscale"), maps.get("UltimateSDUpscaleNoUpscale")
        if cls is None or cls_no is None:
            return frame, ("ComfyUI_UltimateSDUpscale is not installed, and it is what "
                           "tiles. Install it in Manager; passed through")
        if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            # the pack's own schedules are built for the built-in sampler; the
            # tiler takes core's names only
            print("[RedNode Detailer] scheduler %r is the pack's own; the tiled "
                  "upscale runs simple" % scheduler, flush=True)
            scheduler = "simple"
        img = frame[:, :, :, :3]
        kw = {"model": model, "positive": pos, "negative": neg, "vae": vae,
              "seed": int(seed) & 0xffffffffffffffff, "steps": int(steps),
              "cfg": float(cfg_v), "sampler_name": sampler, "scheduler": scheduler,
              "denoise": float(s["denoise"]), "mode_type": s["usdu_mode"],
              "tile_width": int(s["usdu_tile"]), "tile_height": int(s["usdu_tile"]),
              "mask_blur": int(s["usdu_blur"]), "tile_padding": int(s["usdu_padding"]),
              "seam_fix_mode": s["seam_mode"], "seam_fix_denoise": float(s["seam_denoise"]),
              "seam_fix_width": int(s["seam_width"]), "seam_fix_mask_blur": int(s["usdu_blur"]),
              "seam_fix_padding": int(s["seam_padding"]), "force_uniform_tiles": True,
              "tiled_decode": bool(s["tiled_decode"]), "batch_size": 1}
        try:
            if s["usdu_model"]:
                loader = maps.get("UpscaleModelLoader")
                if loader is None:
                    return frame, "core's UpscaleModelLoader is missing; passed through"
                um = _call_node(loader, _fill(loader, {"model_name": s["usdu_model"]}))[0]
                fn = lambda: _call_node(cls, _fill(cls, dict(
                    kw, image=img, upscale_by=float(s["upscale_by"]), upscale_model=um)))
            else:
                big = self._resize(img, float(s["upscale_by"]))
                fn = lambda: _call_node(cls_no, _fill(cls_no, dict(kw, upscaled_image=big)))
            # the tiler samples through core's common_ksampler, so every tile's
            # steps stream to the Live Preview like any pass
            outs = _live.sampled(self._rn_uid, fn,
                                 label=getattr(self, "_rn_live_label", ""))()
        except Exception as exc:
            return frame, "the tiled upscale failed: %s; passed through" % exc
        for v in outs:
            if torch.is_tensor(v) and v.ndim == 4:
                return v, None
        return frame, "the tiled upscale returned no image; passed through"

    def _tone(self, img, src, s, tag, report):
        """Tone lock on a pass that asked for it: the result's detail, the
        pass input's tone. A failure is a line, never a dead queue."""
        if not s.get("tone_lock") or img is src or img is None:
            return img
        try:
            res = tone_lock(src, img, s["tone_radius"], s["tone_strength"])
            line = "%s: tone lock, radius %d, strength %.2f" % (
                tag, s["tone_radius"], s["tone_strength"])
        except Exception as exc:
            res = img
            line = "%s: tone lock failed: %s" % (tag, exc)
        print("[RedNode Detailer] " + line, flush=True)
        report.append(line)
        return res

    def _upscale_region(self, frame, s, seed):
        """SeedVR2 on the region only: the target's box padded 16 and rounded
        to 8, the crop through the upscaler at the pass's size, back at the
        crop's own size under the feathered matte at the blend."""
        mask, box, why = self._locate(frame, dict(s, target=s["region"]))
        if why is not None:
            return frame, why
        H, W = frame.shape[1], frame.shape[2]
        y0, y1, x0, x1 = box
        y0, x0 = max(0, (y0 - 16) // 8 * 8), max(0, (x0 - 16) // 8 * 8)
        y1, x1 = min(H, -(-(y1 + 16) // 8) * 8), min(W, -(-(x1 + 16) // 8) * 8)
        crop = frame[:, y0:y1, x0:x1, :3]
        up, why = _seedvr2(crop, s, seed)
        if up is None:
            return frame, why
        if up.shape[1:3] != crop.shape[1:3]:
            up = F.interpolate(up.permute(0, 3, 1, 2), size=crop.shape[1:3],
                               mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
        return self._paste(frame, crop, up.to(crop.dtype), mask, (y0, y1, x0, x1),
                           s["feather"], s["blend"]), None

    def _each_frame(self, image, fn):
        """A batch goes through a pass one frame at a time.

        Krea 2's VAE is the Wan video VAE: a batch of N images encoded in one
        call is read as one clip of N frames and squeezed to (N-1)//4+1 latent
        frames, so a 5-shot camera path became a 2-frame latent against
        conditioning for one and the sampler died on the mismatch. Each frame
        also wants its own detection: one SAM mask over five faces is a union
        box, not a face. Returns the re-batched frames and the why of a pass
        that missed on EVERY frame; a miss on some keeps those as they were.
        """
        n = image.shape[0]
        if n <= 1:
            return fn(image)
        base = getattr(self, "_rn_live_label", "")
        outs, whys = [], []
        try:
            for k in range(n):
                self._rn_live_label = base + " \u00b7 image %d of %d" % (k + 1, n)
                o, w = fn(image[k:k + 1])
                outs.append(o)
                whys.append(w)
        finally:
            self._rn_live_label = base
        h, w = outs[0].shape[1], outs[0].shape[2]
        outs = [o if o.shape[1:3] == (h, w)
                else F.interpolate(o.permute(0, 3, 1, 2), size=(h, w), mode="bilinear",
                                   align_corners=False).permute(0, 2, 3, 1)
                for o in outs]
        missed = [k + 1 for k, w in enumerate(whys) if w]
        why = whys[0] if len(missed) == n else None
        if why is None and missed:
            print("[RedNode Detailer] passed through on image %s of %d: %s"
                  % (", ".join(map(str, missed)), n, whys[missed[0] - 1]), flush=True)
        return torch.cat(outs, 0), why

    def _ksample(self, model, seed, steps, cfg_v, sampler, scheduler, pos, neg, lat,
                 denoise, start, end):
        from . import custom_sampler as _custom
        with _custom.using(getattr(self, "_rn_chain", ""), getattr(self, "_rn_prompt", None)):
            return _dials.sample_with_dials(
                model, seed, steps, cfg_v, sampler, scheduler, pos, neg, lat,
                denoise=max(0.01, denoise), dials=getattr(self, "_rn_dials", None),
                start_step=start if start > 0 else None,
                last_step=end,
                force_full_denoise=end is not None)

    @staticmethod
    def _resize(img, scale):
        if abs(scale - 1.0) < 1e-3:
            return img
        h = max(64, int(round(img.shape[1] * scale)) // 8 * 8)
        w = max(64, int(round(img.shape[2] * scale)) // 8 * 8)
        return F.interpolate(img.permute(0, 3, 1, 2), size=(h, w),
                             mode="bilinear",
                             align_corners=False).permute(0, 2, 3, 1)

    def _sample(self, image, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
                scheduler, start, end):
        # the scale sticks on a sampler pass: a 0.5 pass hands the next pass a
        # smaller frame, a 2.0 pass a bigger one, which is how the chain grows
        image = self._resize(image, s["scale"])
        # RES on a sampler pass: the frame renders at that long edge and comes
        # back at its own size, so a big frame never sends Krea 2 past its
        # comfort zone (a 4K frame at denoise 1 is fuzz). The scale above still
        # sticks; this is a working size, not a new size.
        work = image
        if s.get("crop_res"):
            f = s["crop_res"] / max(image.shape[1], image.shape[2])
            work = self._resize(image, f)
            print("[RedNode Detailer] frame %d x %d, working at %d x %d"
                  % (image.shape[2], image.shape[1], work.shape[2], work.shape[1]),
                  flush=True)
        lat = {"samples": vae.encode(work[:, :, :, :3])}
        out = _live.sampled(getattr(self, "_rn_uid", None), self._ksample,
                            label=getattr(self, "_rn_live_label", ""))(
            model, seed, steps, cfg_v, sampler, scheduler, pos,
            neg, lat, s["denoise"], start, end)
        img = vae.decode(out["samples"])
        while img.ndim > 4:
            img = img[0]
        if img.shape[1:3] != image.shape[1:3]:
            img = F.interpolate(img.permute(0, 3, 1, 2), size=image.shape[1:3],
                                mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
        return img

    def _locate(self, image, s):
        """The target's mask and padded box, or a why-string: shared by the
        model path and the engine-rig path, so both aim identically."""
        mask, why = _sam3_mask(image, s["target"], s["threshold"], s["sam_model"],
                               s.get("sam_precision", ""))
        if mask is None:
            return None, None, why + "; passed through"
        h, w = image.shape[1], image.shape[2]
        if mask.shape[1] != h or mask.shape[2] != w:
            mask = F.interpolate(mask.unsqueeze(1), size=(h, w),
                                 mode="bilinear", align_corners=False)[:, 0]
        box = _bbox(mask, pad=s["padding"])
        if box is None:
            return None, None, "nothing matched %r; passed through" % s["target"]
        box = grow_to_aspect(box, h, w, region_aspect(box[3] - box[2],
                                                      box[1] - box[0], "auto"))
        return mask, box, None

    @staticmethod
    def _paste(image, crop, rendered, mask, box, feather, blend=1.0):
        """The rendered crop back into the frame under the feathered mask, at
        a blend: the matte scaled, so 0.5 leaves half the crop as it was."""
        y0, y1, x0, x1 = box
        m = mask[:, y0:y1, x0:x1].unsqueeze(-1).clamp(0, 1)
        if feather > 0:
            k = int(feather) * 2 + 1
            m = F.avg_pool2d(m.permute(0, 3, 1, 2), k, stride=1,
                             padding=k // 2).permute(0, 2, 3, 1).clamp(0, 1)
        m = m * max(0.0, min(1.0, float(blend)))
        merged = image.clone()
        merged[:, y0:y1, x0:x1, :3] = crop * (1 - m) + rendered * m
        return merged

    def _detail(self, image, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
                scheduler, start, end, encode_for=None):
        mask, box, why = self._locate(image, s)
        if why is not None:
            return image, why
        y0, y1, x0, x1 = box
        crop = image[:, y0:y1, x0:x1, :3]
        # a detailer's scale renders the crop BIGGER, then puts it back at its own
        # size: more pixels spent on the face, no change to the frame. A crop_res
        # goes further and pins the working size outright, so the render quality
        # stops depending on how large the face happened to be in frame.
        if s.get("crop_res"):
            f = s["crop_res"] / max(crop.shape[1], crop.shape[2])
            work = self._resize(crop, f)
            print("[RedNode Detailer] %s crop %d x %d, working at %d x %d"
                  % (s["target"], crop.shape[2], crop.shape[1],
                     work.shape[2], work.shape[1]), flush=True)
        else:
            work = self._resize(crop, s["scale"]) if s["scale"] > 1.0 else crop
        if encode_for is not None:
            # PICTURE on a detailer: the crop is the base reference, so the
            # swap lands on the face it is looking at, not on the whole frame
            pos, neg = encode_for(work)
        lat = {"samples": vae.encode(work)}
        out = _live.sampled(getattr(self, "_rn_uid", None), self._ksample,
                            label=getattr(self, "_rn_live_label", ""))(
            model, seed, steps, cfg_v, sampler, scheduler, pos,
            neg, lat, s["denoise"], start, end)
        rendered = vae.decode(out["samples"])
        while rendered.ndim > 4:
            rendered = rendered[0]
        if rendered.shape[1:3] != crop.shape[1:3]:
            rendered = F.interpolate(rendered.permute(0, 3, 1, 2),
                                     size=crop.shape[1:3], mode="bilinear",
                                     align_corners=False).permute(0, 2, 3, 1)
        return self._paste(image, crop, rendered, mask, box,
                           s["feather"], s["blend"]), None

    def _handler_pass(self, image, rigd, s, ws_cfg, seed, tag, tap=None):
        """A pass on an engine rig (a RIG_KIND_HANDLERS kind, the personal
        NovelAI rig): a sampler pass is whole-frame i2i through the handler,
        a detailer pass crops the target, sends the crop, and pastes the
        result back under the feathered mask. No model, clip or vae loads;
        LoRA and reference toggles do not apply to an outside engine.
        """
        handler = _ws.RIG_KIND_HANDLERS[rigd["kind"]]
        eff = dict(rigd)
        for key in ("steps", "cfg", "sampler", "scheduler"):
            if s[key]:
                eff[key] = s[key]
        text = s["prompt"]
        if not text.strip():
            row = _pass_prompt_row(ws_cfg, s)
            if row is not None:
                try:
                    from .prompt_frame import expand as _pf_expand
                    text = _pf_expand(row["text"], seed, True)
                except Exception:
                    text = row["text"]
        lines = []
        out = image
        reps = int(s.get("repeat", 1))
        for r in range(max(1, reps)):
            rseed = seed + r * 131
            sr = round_stage(s, r)
            why = None
            try:
                if s["type"] == "sampler":
                    src = self._resize(out, sr["scale"])
                    img = handler("render", rig=eff, cfg=ws_cfg,
                                  prompt_text=text,
                                  negative_text=s["negative"], seed=rseed,
                                  source_image=src, denoise=sr["denoise"])
                    if img is None:
                        why = "the engine returned nothing"
                    else:
                        out = img[:, :, :, :3]
                else:
                    mask, box, why = self._locate(out, s)
                    if why is None:
                        y0, y1, x0, x1 = box
                        crop = out[:, y0:y1, x0:x1, :3]
                        img = handler("render", rig=eff, cfg=ws_cfg,
                                      prompt_text=text,
                                      negative_text=s["negative"],
                                      seed=rseed, source_image=crop,
                                      denoise=sr["denoise"])
                        if img is None:
                            why = "the engine returned nothing"
                        else:
                            img = img[:, :, :, :3]
                            if img.shape[1:3] != crop.shape[1:3]:
                                img = F.interpolate(
                                    img.permute(0, 3, 1, 2),
                                    size=crop.shape[1:3], mode="bilinear",
                                    align_corners=False).permute(0, 2, 3, 1)
                            out = self._paste(out, crop, img, mask, box,
                                              s["feather"], s["blend"])
            except Exception as exc:
                why = "the engine failed: %s" % exc
            line = "%s: %s rig %r, %s" % (
                tag, rigd["kind"], rigd.get("name") or s["rig"],
                why or ("%s, denoise %.2f"
                        % (s["target"] if s["type"] == "detailer"
                           else "whole frame", sr["denoise"])))
            if reps > 1:
                line += ", repeat %d of %d" % (r + 1, reps)
            lines.append(line)
            if tap and not why:
                tap(out, "%s %s%s" % (tag.split(" ")[0], rigd.get("kind"),
                                      " x%d" % (r + 1) if reps > 1 else ""))
            if why:
                break
        return out, lines


# ---- named pass-list presets: your layouts, one JSON in you dir ------
# The panel ships premade layouts client-side (the proven face-identity chain among
# them); this store holds your OWN saved lists, server-side so they survive
# browsers and reinstalls the way sampler profiles do.

_PASS_LORA_CACHE = {}       # name -> loaded state dict, the last two files
_PASS_LORA_KEEP = 2


def _pass_lora(model, name, strength):
    """The pass's own LoRA on a clone of the model (model side only, the way
    LoraLoaderModelOnly does it). The file is kept loaded across queues."""
    import comfy.sd
    import comfy.utils
    import folder_paths
    lora = _PASS_LORA_CACHE.get(name)
    if lora is None:
        path = folder_paths.get_full_path("loras", name)
        if not path:
            raise FileNotFoundError("%s is not in the loras folder" % name)
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        _PASS_LORA_CACHE[name] = lora
        while len(_PASS_LORA_CACHE) > _PASS_LORA_KEEP:
            del _PASS_LORA_CACHE[next(iter(_PASS_LORA_CACHE))]
    new_model, _ = comfy.sd.load_lora_for_models(model, None, lora,
                                                 float(strength), 0.0)
    return new_model


def _presets_path(make=False):
    import os
    import folder_paths
    base = os.path.join(folder_paths.get_user_directory(), "default", "rednode")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "detailer_presets.json")


def load_presets():
    try:
        with open(_presets_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    if isinstance(raw, dict):
        for name, stages in raw.items():
            if not str(name).strip() or not isinstance(stages, list):
                continue
            # the parse is the gatekeeper: junk never gets stored or served
            out[str(name).strip()[:48]] = parse_pipeline(
                json.dumps({"stages": stages}))["stages"]
    return out


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/detailer_presets")
    async def _rn_detailer_presets_get(request):
        return web.json_response({"presets": load_presets()})

    @PromptServer.instance.routes.post("/rednode/detailer_presets")
    async def _rn_detailer_presets_post(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        name = str(body.get("name") or "").strip()[:48]
        if not name:
            return web.json_response({"error": "a preset needs a name"},
                                     status=400)
        presets = load_presets()
        if body.get("delete"):
            presets.pop(name, None)
        else:
            stages = body.get("stages")
            if not isinstance(stages, list) or not stages:
                return web.json_response({"error": "no passes to save"},
                                         status=400)
            presets[name] = parse_pipeline(
                json.dumps({"stages": stages}))["stages"]
        try:
            with open(_presets_path(make=True), "w", encoding="utf-8") as f:
                json.dump(presets, f, indent=1)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"presets": presets})
except Exception as _e:
    print(f"[RedNode Detailer] preset routes not registered: {_e}", flush=True)


# The class carried "Advanced" for a few hours before you named it properly.
# The alias keeps any node placed in that window loading; the display name is one.
RedNodeStudioAdvanced = RedNodeStudioDetailer

NODE_CLASS_MAPPINGS = {"RedNodeStudioDetailer": RedNodeStudioDetailer,
                       "RedNodeStudioAdvanced": RedNodeStudioAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioDetailer": "RedNode Studio Detailer",
                              "RedNodeStudioAdvanced": "RedNode Studio Detailer "
                                                       "(renamed)"}
