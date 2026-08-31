"""RedNode Studio Detailer: the post-render passes as a list, not a wire maze.

Start, then the passes in order, then End. Each pass names a RIG from the Models tab,
so a face can be detailed by a different model from the one that rendered the frame.
Two pass kinds, both taken from the shapes the user already runs as subgraphs:

  sampler   whole-frame refine at a denoise, an img2img over the incoming picture
  detailer  SAM3 segments a target (face, hair, hands...), a low-denoise pass over
            the crop, composited back through a feathered mask

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
        if s.get("type") not in ("sampler", "detailer"):
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
                            0.15 if s["type"] == "detailer" else 0.3),
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
            "padding": _num("padding", 0.0, 2.0, 0.35),
            # the crop's working resolution: its long edge is resized to this
            # before rendering, then the result goes back at the crop's own
            # size. 0 keeps the old behaviour, the crop as it comes (x Scale).
            # A small face stops meaning a quality-starved render.
            "crop_res": _num("crop_res", 0, 4096, 0, int),
            # iteration, the Paint tab's Passes on a single pass: run this pass
            # over its own result N times, fresh seed each round
            "repeat": _num("repeat", 1, 10, 1, int),
            "color": str(s.get("color") or ""),      # panel cosmetics, kept
        })
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
            "taps": bool(data.get("taps"))}


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
    if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
        scheduler = "simple"
    start = min(stage["start_step"], max(0, int(steps) - 1))
    end = stage["end_step"] or None
    if end is not None:
        end = max(start + 1, min(int(end), int(steps)))
    return int(steps), float(cfg), sampler, scheduler, int(start), end


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


def _sam3_mask(image, target, threshold, sam_model=""):
    """A [1,H,W] mask for `target`, through ComfyUI-Easy-Sam3, or None with a reason.

    The Easy-Sam3 nodes are called the way the graph calls them, through their own
    classes out of NODE_CLASS_MAPPINGS, so this follows that pack instead of
    reimplementing it. `sam_model` overrides the loader's checkpoint choice when
    set. Everything is inside one try because an optional dependency may be absent,
    half-installed or reshaped, and every one of those must come back as words
    rather than a dead queue.
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

    def run(self, image, config="{}", prompt=None, unique_id=None):
        # A paint-door run or an external-sampler workspace hands over no image
        # at all; pass the nothing along like Review and Save do, don't crash
        if image is None:
            print("[RedNode Detailer] no image arrived (paint run or external "
                  "sampler), passes skipped", flush=True)
            return (_ws.blocked(), "no image arrived, passes skipped")
        cfg = parse_pipeline(config)
        stages = [(k, s) for k, s in enumerate(cfg["stages"])
                  if s["on"] and s["type"] != "title"]
        report = []
        if not stages:
            return (image, "no passes configured")
        try:
            ws_cfg = _ws.parse_config(json.dumps(_workspace_cfg(prompt)))
        except Exception:
            ws_cfg = _ws.parse_config("{}")
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
                    img, label, prompt=prompt, source="detailer")
            except Exception as exc:
                print("[RedNode Detailer] taps unavailable: %s" % exc, flush=True)
        if tap:
            tap(image, "Detailer in")

        out = image
        for i, (card_idx, s) in enumerate(stages, 1):
            self._notify(unique_id, card_idx, len(cfg["stages"]), "run")
            tag = "%d/%d %s" % (i, len(stages), s["type"])
            # AN ENGINE RIG (a handled kind, the personal NovelAI rig) takes
            # its own road: the handler renders, nothing loads
            rigd = _rig_settings(ws_cfg, s["rig"])
            if rigd.get("kind") in _ws.RIG_KIND_HANDLERS:
                out, lines = self._handler_pass(out, rigd, s, ws_cfg,
                                                seed + i, tag, tap)
                for line in lines:
                    print("[RedNode Detailer] " + line, flush=True)
                    report.append(line)
                continue
            rig_name, model, clip, vae = _ws.load_active_rig(ws_cfg, name=s["rig"])
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
                row = _ws.prompt_row_for(ws_cfg["models"], ws_cfg["prompts"],
                                         s["rig"])
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
                if s["type"] == "sampler":
                    if use_picture:
                        pic = self._resize(out, s["scale"])
                        if s.get("crop_res"):
                            pic = self._resize(pic, s["crop_res"] / max(pic.shape[1], pic.shape[2]))
                        pos, neg = _encode(pic)
                    out = self._sample(out, model, pos, neg, vae, s, rseed,
                                       steps, cfg_v, sampler, scheduler, start,
                                       end)
                    line = ("%s: rig %r, %d steps%s, cfg %.1f, %s/%s, denoise "
                            "%.2f" % (tag, rig_name, steps, window, cfg_v,
                                      sampler, scheduler, s["denoise"]))
                    if abs(s["scale"] - 1.0) >= 1e-3:
                        line += ", scale %.2f -> %d x %d" % (
                            s["scale"], out.shape[2], out.shape[1])
                else:
                    out, why = self._detail(out, model, pos, neg, vae, s, rseed,
                                            steps, cfg_v, sampler, scheduler,
                                            start, end,
                                            encode_for=_encode if use_picture else None)
                    line = "%s: %s on rig %r, %s" % (
                        tag, s["target"], rig_name,
                        why or ("%d steps%s, %s/%s, denoise %.2f"
                                % (steps, window, sampler, scheduler,
                                   s["denoise"])))
                if reps > 1:
                    line += ", repeat %d of %d" % (r + 1, reps)
                print("[RedNode Detailer] " + line, flush=True)
                report.append(line)
                if tap and not why:
                    tap(out, "%d %s%s" % (i, s["target"] if s["type"] == "detailer"
                                          else "sampler",
                                          " x%d" % (r + 1) if reps > 1 else ""))
                if why:
                    break
                # a sampler pass's scale must not compound across repeats: 1.5x
                # three times is 3.4x and a VRAM surprise. The first round
                # scales, the rest refine at the size it landed on.
                if r == 0 and reps > 1 and s["type"] == "sampler" \
                        and abs(s["scale"] - 1.0) >= 1e-3:
                    s = dict(s, scale=1.0)
        if tap:
            tap(out, "Detailer out")
        self._notify(unique_id, -1, len(cfg["stages"]), "end")
        return (out, "\n".join(report))

    @staticmethod
    def _ksample(model, seed, steps, cfg_v, sampler, scheduler, pos, neg, lat,
                 denoise, start, end):
        return _core.common_ksampler(
            model, seed, steps, cfg_v, sampler, scheduler, pos, neg, lat,
            denoise=max(0.01, denoise),
            start_step=start if start > 0 else None,
            last_step=end,
            force_full_denoise=end is not None)[0]

    @staticmethod
    def _resize(img, scale):
        if abs(scale - 1.0) < 1e-3:
            return img
        h = max(64, int(img.shape[1] * scale) // 8 * 8)
        w = max(64, int(img.shape[2] * scale) // 8 * 8)
        return F.interpolate(img.permute(0, 3, 1, 2), size=(h, w),
                             mode="bilinear",
                             align_corners=False).permute(0, 2, 3, 1)

    def _sample(self, image, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
                scheduler, start, end):
        # the scale sticks on a sampler pass: a 0.5 pass hands the next pass a
        # smaller frame, a 2.0 pass a bigger one, which is how the chain grows
        image = self._resize(image, s["scale"])
        lat = {"samples": vae.encode(image[:, :, :, :3])}
        out = self._ksample(model, seed, steps, cfg_v, sampler, scheduler, pos,
                            neg, lat, s["denoise"], start, end)
        img = vae.decode(out["samples"])
        while img.ndim > 4:
            img = img[0]
        return img

    def _locate(self, image, s):
        """The target's mask and padded box, or a why-string: shared by the
        model path and the engine-rig path, so both aim identically."""
        mask, why = _sam3_mask(image, s["target"], s["threshold"], s["sam_model"])
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
    def _paste(image, crop, rendered, mask, box, feather):
        """The rendered crop back into the frame under the feathered mask."""
        y0, y1, x0, x1 = box
        m = mask[:, y0:y1, x0:x1].unsqueeze(-1).clamp(0, 1)
        if feather > 0:
            k = int(feather) * 2 + 1
            m = F.avg_pool2d(m.permute(0, 3, 1, 2), k, stride=1,
                             padding=k // 2).permute(0, 2, 3, 1).clamp(0, 1)
        merged = image.clone()
        merged[:, y0:y1, x0:x1, :3] = crop * (1 - m) + rendered * m
        return merged

    def _detail(self, image, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
                scheduler, start, end):
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
        out = self._ksample(model, seed, steps, cfg_v, sampler, scheduler, pos,
                            neg, lat, s["denoise"], start, end)
        rendered = vae.decode(out["samples"])
        while rendered.ndim > 4:
            rendered = rendered[0]
        if rendered.shape[1:3] != crop.shape[1:3]:
            rendered = F.interpolate(rendered.permute(0, 3, 1, 2),
                                     size=crop.shape[1:3], mode="bilinear",
                                     align_corners=False).permute(0, 2, 3, 1)
        return self._paste(image, crop, rendered, mask, box,
                           s["feather"]), None

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
            row = _ws.prompt_row_for(ws_cfg["models"], ws_cfg["prompts"],
                                     s["rig"])
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
            why = None
            try:
                if s["type"] == "sampler":
                    src = self._resize(out, s["scale"])
                    img = handler("render", rig=eff, cfg=ws_cfg,
                                  prompt_text=text,
                                  negative_text=s["negative"], seed=rseed,
                                  source_image=src, denoise=s["denoise"])
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
                                      denoise=s["denoise"])
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
                                              s["feather"])
            except Exception as exc:
                why = "the engine failed: %s" % exc
            line = "%s: %s rig %r, %s" % (
                tag, rigd["kind"], rigd.get("name") or s["rig"],
                why or ("%s, denoise %.2f"
                        % (s["target"] if s["type"] == "detailer"
                           else "whole frame", s["denoise"])))
            if reps > 1:
                line += ", repeat %d of %d" % (r + 1, reps)
            lines.append(line)
            if tap and not why:
                tap(out, "%s %s%s" % (tag.split(" ")[0], rigd.get("kind"),
                                      " x%d" % (r + 1) if reps > 1 else ""))
            if why:
                break
            if r == 0 and reps > 1 and s["type"] == "sampler" \
                    and abs(s["scale"] - 1.0) >= 1e-3:
                s = dict(s, scale=1.0)
        return out, lines


# ---- named pass-list presets: the user's layouts, one JSON in the user dir ------
# The panel ships premade layouts client-side (the proven face-identity chain among
# them); this store holds the user's OWN saved lists, server-side so they survive
# browsers and reinstalls the way sampler profiles do.

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


# The class carried "Advanced" for a few hours before the user named it properly.
# The alias keeps any node placed in that window loading; the display name is one.
RedNodeStudioAdvanced = RedNodeStudioDetailer

NODE_CLASS_MAPPINGS = {"RedNodeStudioDetailer": RedNodeStudioDetailer,
                       "RedNodeStudioAdvanced": RedNodeStudioAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioDetailer": "RedNode Studio Detailer",
                              "RedNodeStudioAdvanced": "RedNode Studio Detailer "
                                                       "(renamed)"}
