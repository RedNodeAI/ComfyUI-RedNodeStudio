"""RedNode Studio Advanced: the post-render passes as a list, not a wire maze.

Start, then the passes in order, then End. Each pass names a RIG from the Models tab,
so a face can be detailed by a different model from the one that rendered the frame.
Two pass kinds, both taken from the shapes the user already runs as subgraphs:

  sampler   whole-frame refine at a denoise, an img2img over the incoming picture
  detailer  SAM3 segments a target (face, hair, hands...), a low-denoise pass over
            the crop, composited back through a feathered mask

SAM3 arrives through ComfyUI-Easy-Sam3 when it is installed, the same pack the
release workflow already carries. Without it the detailer stage says so plainly and
passes the image through, because a silent no-op teaches the wrong lesson and a hard
error kills a queue over an optional dependency.
"""

import json

import torch
import torch.nn.functional as F

import nodes as _core

from . import workspace as _ws
from .paint_render import _bbox, _encode_text, _workspace_cfg, grow_to_aspect, \
    region_aspect


def parse_pipeline(config_json):
    """The stage list, normalised. Unknown kinds are dropped, values clamped."""
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
            "steps": _num("steps", 1, 200, 8, int),
            "target": str(s.get("target") or "face"),
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


def _sam3_mask(image, target, threshold):
    """A [1,H,W] mask for `target`, through ComfyUI-Easy-Sam3, or None with a reason.

    The Easy-Sam3 nodes are called the way the graph calls them, through their own
    classes out of NODE_CLASS_MAPPINGS, so this follows that pack instead of
    reimplementing it. Everything is inside one try because an optional dependency
    may be absent, half-installed or reshaped, and every one of those must come back
    as words rather than a dead queue.
    """
    try:
        loader_cls = _core.NODE_CLASS_MAPPINGS.get("easy sam3ModelLoader")
        seg_cls = _core.NODE_CLASS_MAPPINGS.get("easy sam3ImageSegmentation")
        if loader_cls is None or seg_cls is None:
            return None, ("ComfyUI-Easy-Sam3 is not installed, and it is what "
                          "segments %r. Install it in Manager." % target)
        loader = loader_cls()
        lf = getattr(loader, loader_cls.FUNCTION)
        model = lf(**_defaults_for(loader_cls))[0]
        seg = seg_cls()
        sf = getattr(seg, seg_cls.FUNCTION)
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
        out = sf(**kwargs)
        # the mask is whichever output is mask-shaped; packs disagree about order
        for v in (out if isinstance(out, (tuple, list)) else [out]):
            if torch.is_tensor(v) and v.ndim == 3:
                return v, None
        return None, "the segmenter returned no mask for %r" % target
    except Exception as exc:
        return None, "SAM3 failed on %r: %s" % (target, exc)


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


class RedNodeStudioAdvanced:
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
                   "face detailers in order, each through a rig picked from the "
                   "Models tab, no wires between them. Feed the workspace's image "
                   "output in, take the finished picture out, and put the post "
                   "process after it.")

    def run(self, image, config="{}", prompt=None, unique_id=None):
        cfg = parse_pipeline(config)
        stages = [s for s in cfg["stages"] if s["on"]]
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
        for i, s in enumerate(stages, 1):
            tag = "%d/%d %s" % (i, len(stages), s["type"])
            rig_name, model, clip, vae = _ws.load_active_rig(ws_cfg, name=s["rig"])
            if model is None or clip is None or vae is None:
                line = "%s: rig %r is missing a %s, pass skipped" % (
                    tag, s["rig"] or rig_name or "(active)",
                    "model" if model is None else
                    "clip" if clip is None else "vae")
                print("[RedNode Advanced] " + line, flush=True)
                report.append(line)
                continue
            pos = _encode_text(clip, s["prompt"])
            neg = _encode_text(clip, s["negative"])
            if s["type"] == "sampler":
                out = self._sampler_pass(out, model, pos, neg, vae, s, seed + i)
                line = "%s: rig %r, denoise %.2f" % (tag, rig_name, s["denoise"])
            else:
                out, why = self._detailer_pass(out, model, pos, neg, vae, s,
                                               seed + i)
                line = "%s: %s on rig %r, %s" % (
                    tag, s["target"], rig_name,
                    why or ("denoise %.2f" % s["denoise"]))
            print("[RedNode Advanced] " + line, flush=True)
            report.append(line)
        return (out, "\n".join(report))

    @staticmethod
    def _sampler_pass(image, model, pos, neg, vae, s, seed):
        lat = {"samples": vae.encode(image[:, :, :, :3])}
        out = _core.common_ksampler(model, seed, s["steps"], 1.0, "euler",
                                    "simple", pos, neg, lat,
                                    denoise=max(0.01, s["denoise"]))[0]
        img = vae.decode(out["samples"])
        while img.ndim > 4:
            img = img[0]
        return img

    @staticmethod
    def _detailer_pass(image, model, pos, neg, vae, s, seed):
        mask, why = _sam3_mask(image, s["target"], s["threshold"])
        if mask is None:
            return image, why + "; passed through"
        # the mask sized to the picture, then the paint machinery's own box maths
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
        lat = {"samples": vae.encode(crop)}
        out = _core.common_ksampler(model, seed, s["steps"], 1.0, "euler",
                                    "simple", pos, neg, lat,
                                    denoise=max(0.01, s["denoise"]))[0]
        rendered = vae.decode(out["samples"])
        while rendered.ndim > 4:
            rendered = rendered[0]
        if rendered.shape[1:3] != crop.shape[1:3]:
            rendered = F.interpolate(rendered.permute(0, 3, 1, 2),
                                     size=crop.shape[1:3], mode="bilinear",
                                     align_corners=False).permute(0, 2, 3, 1)
        # composite through the softened mask, so the seam feathers instead of cuts
        m = mask[:, y0:y1, x0:x1].unsqueeze(-1).clamp(0, 1)
        if s["feather"] > 0:
            k = int(s["feather"]) * 2 + 1
            m = F.avg_pool2d(m.permute(0, 3, 1, 2), k, stride=1,
                             padding=k // 2).permute(0, 2, 3, 1).clamp(0, 1)
        merged = image.clone()
        merged[:, y0:y1, x0:x1, :3] = crop * (1 - m) + rendered * m
        return merged, None


NODE_CLASS_MAPPINGS = {"RedNodeStudioAdvanced": RedNodeStudioAdvanced}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioAdvanced": "RedNode Studio Advanced"}
