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
        if not isinstance(s, dict) or s.get("type") not in ("sampler", "detailer"):
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
            "threshold": _num("threshold", 0.05, 0.95, 0.5),
            "feather": _num("feather", 0, 64, 8, int),
            "padding": _num("padding", 0.0, 2.0, 0.35),
        })
    try:
        seed = int(data.get("seed", 0))
    except (TypeError, ValueError):
        seed = 0
    return {"stages": stages, "seed": max(0, seed),
            "seed_random": (True if data.get("seed_random") is None
                            else bool(data.get("seed_random")))}


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
        model = getattr(loader, loader_cls.FUNCTION)(**lkw)[0]
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
        # the mask is whichever output is mask-shaped; packs disagree about order
        for v in (out if isinstance(out, (tuple, list)) else [out]):
            if torch.is_tensor(v) and v.ndim == 3:
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
        cfg = parse_pipeline(config)
        stages = [(k, s) for k, s in enumerate(cfg["stages"]) if s["on"]]
        report = []
        if not stages:
            return (image, "no passes configured")
        try:
            ws_cfg = _ws.parse_config(json.dumps(_workspace_cfg(prompt)))
        except Exception:
            ws_cfg = _ws.parse_config("{}")
        import random as _random
        seed = (_random.getrandbits(48) if cfg["seed_random"] else cfg["seed"])

        out = image
        for i, (card_idx, s) in enumerate(stages, 1):
            self._notify(unique_id, card_idx, len(cfg["stages"]), "run")
            tag = "%d/%d %s" % (i, len(stages), s["type"])
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
            pos = _encode_text(clip, text)
            neg = _encode_text(clip, s["negative"])
            window = ("" if start == 0 and end is None
                      else ", steps %d..%s" % (start, end if end is not None
                                               else "end"))
            if s["type"] == "sampler":
                out = self._sample(out, model, pos, neg, vae, s, seed + i,
                                   steps, cfg_v, sampler, scheduler, start, end)
                line = ("%s: rig %r, %d steps%s, cfg %.1f, %s/%s, denoise %.2f"
                        % (tag, rig_name, steps, window, cfg_v, sampler,
                           scheduler, s["denoise"]))
                if abs(s["scale"] - 1.0) >= 1e-3:
                    line += ", scale %.2f -> %d x %d" % (
                        s["scale"], out.shape[2], out.shape[1])
            else:
                out, why = self._detail(out, model, pos, neg, vae, s, seed + i,
                                        steps, cfg_v, sampler, scheduler, start,
                                        end)
                line = "%s: %s on rig %r, %s" % (
                    tag, s["target"], rig_name,
                    why or ("%d steps%s, %s/%s, denoise %.2f"
                            % (steps, window, sampler, scheduler, s["denoise"])))
            print("[RedNode Detailer] " + line, flush=True)
            report.append(line)
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

    def _detail(self, image, model, pos, neg, vae, s, seed, steps, cfg_v, sampler,
                scheduler, start, end):
        mask, why = _sam3_mask(image, s["target"], s["threshold"], s["sam_model"])
        if mask is None:
            return image, why + "; passed through"
        h, w = image.shape[1], image.shape[2]
        if mask.shape[1] != h or mask.shape[2] != w:
            mask = F.interpolate(mask.unsqueeze(1), size=(h, w),
                                 mode="bilinear", align_corners=False)[:, 0]
        box = _bbox(mask, pad=s["padding"])
        if box is None:
            return image, "nothing matched %r; passed through" % s["target"]
        box = grow_to_aspect(box, h, w, region_aspect(box[3] - box[2],
                                                      box[1] - box[0], "auto"))
        y0, y1, x0, x1 = box
        crop = image[:, y0:y1, x0:x1, :3]
        # a detailer's scale renders the crop BIGGER, then puts it back at its own
        # size: more pixels spent on the face, no change to the frame
        work = self._resize(crop, s["scale"]) if s["scale"] > 1.0 else crop
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
        m = mask[:, y0:y1, x0:x1].unsqueeze(-1).clamp(0, 1)
        if s["feather"] > 0:
            k = int(s["feather"]) * 2 + 1
            m = F.avg_pool2d(m.permute(0, 3, 1, 2), k, stride=1,
                             padding=k // 2).permute(0, 2, 3, 1).clamp(0, 1)
        merged = image.clone()
        merged[:, y0:y1, x0:x1, :3] = crop * (1 - m) + rendered * m
        return merged, None


# The class carried "Advanced" for a few hours before the user named it properly.
# The alias keeps any node placed in that window loading; the display name is one.
RedNodeStudioAdvanced = RedNodeStudioDetailer

NODE_CLASS_MAPPINGS = {"RedNodeStudioDetailer": RedNodeStudioDetailer,
                       "RedNodeStudioAdvanced": RedNodeStudioAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioDetailer": "RedNode Studio Detailer",
                              "RedNodeStudioAdvanced": "RedNode Studio Detailer "
                                                       "(renamed)"}
