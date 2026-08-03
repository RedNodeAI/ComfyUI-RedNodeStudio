"""RedNode Paint Render: the Workspace's Paint tab, rendered on its own.

Inpainting by hand is doing what a detailer does automatically, so this works the
way a detailer does: crop to what you painted, render THAT at its own resolution,
and composite it back. The rest of the picture is never touched and never
re-rendered, which is the whole point of painting a region instead of re-running
the workflow.

Wire it once, off to the side: model, positive, negative, vae. The Paint tab's
Generate button then queues this node alone (the panel prunes the prompt to this
node's own inputs), so pressing Generate costs one crop-sized sample rather than
a whole batch.
"""
import json
import math
import os
import random

import torch
import torch.nn.functional as F

import comfy.sample
import comfy.samplers
import comfy.utils
import folder_paths
import nodes

from . import workspace as _ws


def _active_auto_prompt(pc):
    """The automatic caption layer, only while Paint Auto Prompt is on."""
    auto = (pc or {}).get("auto")
    if not isinstance(auto, dict) or not auto.get("on"):
        return ""
    return str((pc or {}).get("auto_prompt") or "").strip()


def _encode_text(clip, text):
    """Encode Paint text with Krea's template when that encoder is installed."""
    try:
        from comfy.text_encoders.krea2 import KREA2_TEMPLATE
        template = {"llama_template": KREA2_TEMPLATE}
    except ImportError:
        # This node paints with any model, so it has to work on a ComfyUI with no
        # Krea 2 in it. A plain tokenize is what every other architecture wants.
        template = {}
    return clip.encode_from_tokens_scheduled(clip.tokenize(text, **template))


def _bbox(mask, pad=0.25):
    """The painted region's box, padded, or None when nothing was painted.

    The padding matters: a crop that hugs the paint gives the model no context to
    match lighting and texture against, and the seam shows.
    """
    ys, xs = torch.where(mask[0] > 0.02)
    if not len(ys) or not len(xs):
        return None
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    h, w = mask.shape[1], mask.shape[2]
    py = int((y1 - y0) * pad)
    px = int((x1 - x0) * pad)
    return (max(0, y0 - py), min(h, y1 + py), max(0, x0 - px), min(w, x1 + px))


# The most a paint pass may render, by VRAM tier, and now the ceiling on BOTH modes.
# The tab's size dial is a target resolution rather than a multiplier, deliberately: a
# multiplier compounds when you iterate on the same picture, so a forgotten 1.5x becomes
# 2.25x and then 3.4x without anyone touching it, while "2048" means 2048 no matter how
# many passes it has been through. These caps are what stops that target asking for more
# than the card has, so the dial can offer 4K without a low-tier machine trying it.
# LOW IS 1280, not 1536, at the user's call after watching a low-tier run: 1536 was
# still asking too much of a small card. This number matters more than it looks,
# because the caps are the ONLY thing that shrinks a painted region: the size dial is
# a pixel BUDGET that never scales a region below its own pixels, so on a big picture
# the tier ceiling is what the card actually renders at.
WHOLE_FRAME_CAPS = {"low": 1280, "medium": 2048, "high": 4096}


def whole_frame_limit(tier):
    # the fallback is READ from the table, not written out again: a hardcoded number
    # here went stale the moment the high tier moved, and an unknown tier silently got
    # the OLD ceiling while the named one had changed
    return WHOLE_FRAME_CAPS.get(str(tier or "high").lower(), WHOLE_FRAME_CAPS["high"])


# THE SHAPE of a painted region, and why it is not left as whatever the mask happened
# to be. Two reasons, neither of them detail: an aspect far outside anything the model
# was trained on comes back with artifacts, and a box hugging a long mask has almost no
# room above and below it to match lighting and texture against, which is the same thing
# `context` exists for.
#
# These are the ratios the model has actually seen. The list doubles as the aspect CAP:
# the widest bucket is 16:9, so nothing more extreme than that can come out of the auto
# path, and no separate cap constant has to be invented or kept in step.
REGION_BUCKETS = (9 / 16, 3 / 4, 1.0, 4 / 3, 16 / 9)
# one list, defined in workspace.py because that module cannot import this one
REGION_SHAPES = _ws.REGION_SHAPES
SHAPE_ASPECT = {"square": 1.0, "landscape": 4 / 3, "portrait": 3 / 4}


def region_aspect(w, h, shape="auto"):
    """The aspect to grow a painted box toward, or None to leave it alone.

    Auto picks the bucket the box is already closest to, measured in log space so
    being 20% too wide and 20% too tall are the same distance. Because it is the
    NEAREST of five, the growth is small by construction: adjacent buckets are a
    factor of 4/3 apart, so auto never adds more than about 15% to an axis unless the
    box is more extreme than the widest bucket, which is exactly the case worth
    correcting.
    """
    shape = str(shape or "auto")
    if shape in SHAPE_ASPECT:
        return SHAPE_ASPECT[shape]
    if shape != "auto" or w <= 0 or h <= 0:
        return None
    a = float(w) / float(h)
    return min(REGION_BUCKETS, key=lambda b: abs(math.log(a / b)))


def grow_to_aspect(box, full_h, full_w, target):
    """Extend a box toward `target` aspect without ever clipping what is inside it.

    GROW, NEVER SHRINK. The box is around somebody's paint, so trimming it to reach a
    nicer number would silently drop part of what they asked to be redone. Only the
    short axis is extended, and only into space the picture actually has.

    Growth is centred, then SLID back inside the frame rather than truncated. Near an
    edge, truncating would quietly hand back less context than was asked for, which is
    worst exactly where context is scarcest; sliding keeps the requested size whenever
    the picture is big enough to hold it.
    """
    y0, y1, x0, x1 = box
    h, w = y1 - y0, x1 - x0
    if not target or h <= 0 or w <= 0:
        return box
    a = float(w) / float(h)
    if a < target:                                   # too tall: widen it
        want = min(int(full_w), int(round(h * target)))
        grow = want - w
        if grow > 0:
            x0 -= grow // 2
            x1 += grow - grow // 2
            if x0 < 0:
                x1 -= x0
                x0 = 0
            if x1 > full_w:
                x0 -= x1 - full_w
                x1 = full_w
            x0 = max(0, x0)
    elif a > target:                                 # too wide: heighten it
        want = min(int(full_h), int(round(w / target)))
        grow = want - h
        if grow > 0:
            y0 -= grow // 2
            y1 += grow - grow // 2
            if y0 < 0:
                y1 -= y0
                y0 = 0
            if y1 > full_h:
                y0 -= y1 - full_h
                y1 = full_h
            y0 = max(0, y0)
    return (y0, y1, x0, x1)


def _round8(t_nhwc):
    """The same picture at its own size, nudged to a multiple of 8 for the sampler.

    The no-dial path. When nothing asked for a size the frame keeps its own, and the
    only change allowed is the /8 nudge the sampler needs. A dial that DID ask goes
    through _fit instead, in either direction, since the 2026-08-03 sizing change.
    """
    h, w = t_nhwc.shape[1], t_nhwc.shape[2]
    nh, nw = max(64, (h // 8) * 8), max(64, (w // 8) * 8)
    if (nh, nw) == (h, w):
        return t_nhwc
    t = t_nhwc.permute(0, 3, 1, 2)
    t = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
    return t.permute(0, 2, 3, 1)


def _fit(t_nhwc, target):
    """Scale a crop so its LONG EDGE is `target`, rounded to /8 for the sampler.

    Still long-edge, and deliberately so: the whole-frame path uses this as a VRAM
    ceiling, where a cap on the longest side is exactly the right thing. The painted
    REGION uses _fit_region below, because there the long edge is the wrong ruler.
    """
    h, w = t_nhwc.shape[1], t_nhwc.shape[2]
    scale = target / max(h, w)
    nh = max(64, int(round(h * scale / 8)) * 8)
    nw = max(64, int(round(w * scale / 8)) * 8)
    t = t_nhwc.permute(0, 3, 1, 2)
    t = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
    return t.permute(0, 2, 3, 1)


def _fit_region(t_nhwc, budget_side, cap=0, floor=False):
    """Scale a painted region to a PIXEL BUDGET, keeping its aspect, rounded to /8.

    THE detail bug this fixes, reported as long masks coming back soft. Scaling a crop
    by its long edge means the detail a region gets depends on its SHAPE rather than on
    what it costs. On a 1024-wide picture, a 200x200 mask pads to about 300x300 and gets
    a 3.4x upscale, while an arm at 900x150 pads to about 1024x225, whose long edge is
    already 1024, so it renders at its original resolution and gains nothing. A mask
    spanning the full width was scaled DOWN. The longer the paint, the less detail it
    got, which is the opposite of useful.

    THE DIAL IS A TARGET IN BOTH DIRECTIONS. It used to refuse to scale a region DOWN,
    on the reasoning that the composite would scale it back up afterwards and soften
    the one area being worked on. That reasoning is real but it is not the user's to
    have made for them, and it made a control named "size" unable to reduce a size:
    set 1024, paint a 1404 region, and it rendered 1408 while the readout said 1024.

    Two things outrank the softening, both from the user, who paints for a living:

    - A REGION FAR ABOVE A MODEL'S NATIVE RESOLUTION IS NOT SOFT, IT IS WRONG. Push an
      SD1.5-era model to 1404 and it duplicates limbs and repeats texture. Refusing to
      come down turned a quality trade into a broken render.
    - On an 8 or 12 GB card the difference between 1024 and 1408, with an XL-class
      model and several LoRAs loaded, is the difference between a pass that runs and
      one that takes the machine down.

    `floor=True` restores the old refusal, for anyone who wants detail preserved above
    all: it is the Paint tab's "Never shrink" toggle, off by default. It lives in the
    workflow config rather than in the install's settings, because it changes what
    renders, and a preference that changes a render has to travel with the workflow.
    """
    h, w = t_nhwc.shape[1], t_nhwc.shape[2]
    # the dial keeps its meaning: `budget_side` is the side of the square whose pixel
    # count is being spent, so a compact mask costs exactly what it costs today
    budget = float(budget_side) * float(budget_side)
    scale = math.sqrt(budget / max(1.0, float(h) * float(w)))
    if floor:
        scale = max(1.0, scale)
    nh = max(64, int(round(h * scale / 8)) * 8)
    nw = max(64, int(round(w * scale / 8)) * 8)
    # the one reason to go under: a region that big will not fit on the card at all
    if cap and max(nh, nw) > cap:
        return _fit(t_nhwc, cap)
    t = t_nhwc.permute(0, 3, 1, 2)
    t = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
    return t.permute(0, 2, 3, 1)


class RedNodePaintRender:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # LAZY on purpose. This is an output node, so it is called on every
                # queue, and ComfyUI evaluates a node's inputs before calling it. That
                # meant a normal generation encoded CLIP and staged the model just to
                # hand them to a paint node that was going to sit the run out. Lazy
                # inputs let it decline them: on a run that is not a paint run, none
                # of this branch is computed at all.
                "model": ("MODEL", {"lazy": True}),
                "positive": ("CONDITIONING", {"lazy": True}),
                "negative": ("CONDITIONING", {"lazy": True}),
                "vae": ("VAE", {"lazy": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 200}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                # An output node runs on EVERY queue, which meant a normal run also
                # sampled a paint crop nobody asked for: press queue a few times and
                # pictures pile up. The Paint tab's Generate button stamps this with a
                # fresh token; an empty one means "this is somebody else's run" and
                # the node does nothing.
                "run_token": ("STRING", {"default": "", "tooltip":
                              "leave this empty. The Paint tab's Generate button fills "
                              "it in for its own runs; while it is empty this node sits "
                              "out of normal queues instead of rendering a crop nobody "
                              "asked for"}),
            },
            "optional": {
                # normally NOT needed: the picture comes from the Paint tab, which is
                # what you painted on. Wire this only to paint over something else.
                "image": ("IMAGE", {"lazy": True, "tooltip":
                                    "the picture to paint on. Wire it and "
                                    "there is no guessing about which image this is "
                                    "working from. Leave it empty and it falls back to "
                                    "whatever the Paint tab is showing"}),
                "clip": ("CLIP", {"lazy": True, "tooltip":
                                  "wire this to type a prompt on the Paint "
                                  "tab. Without it the patch is rendered with whatever "
                                  "conditioning is on the positive and negative inputs, "
                                  "which is your whole-image prompt"}),
                "positive_override": ("CONDITIONING", {"lazy": True, "tooltip":
                                      "conditioning for the painted patch instead of the "
                                      "main positive, for when you want a full grounded "
                                      "encode rather than a plain text one"}),
                "negative_override": ("CONDITIONING", {"lazy": True, "tooltip":
                                      "the matching negative for the override"}),
            },
            # unique_id so check_lazy_status can see which of these are actually
            # wired: asking for an input that has no link would never resolve
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "render"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Renders ONLY what you painted on the Workspace's Paint tab: it crops "
                   "to the painted region, samples that crop at the tab's mask size and "
                   "denoise, and composites it back. The rest of the image is never "
                   "re-rendered. Wire model, positive, negative, vae, and the image "
                   "you want to paint on, then press Generate on the Paint tab. Leaving "
                   "the image unwired makes it follow the tab instead. The result "
                   "appears on this node and in the tab's result pane.")

    def check_lazy_status(self, run_token="", prompt=None, unique_id=None, **kwargs):
        """Ask for the inputs only on a real paint run.

        An empty run token means somebody pressed Queue for their own reasons and this
        node is a bystander. Returning nothing here means NONE of the inputs are
        evaluated, so a normal generation stops paying for a paint branch it is not
        using.

        This node is an OUTPUT_NODE, so it does execute on every queue and there is no
        avoiding that: it is what makes a pruned paint prompt a valid one. What it must
        not do is drag its inputs' chains along with it. The four heavy inputs were
        already lazy; the optional ones were not, which is why a wired CLIP kept
        encoding on every ordinary queue.
        """
        if not str(run_token or "").strip():
            return []
        need = ["model", "positive", "negative", "vae"]
        linked = _linked_inputs(prompt, unique_id)
        if linked is not None:
            # only ask for an optional input that something is actually wired into.
            # Asking for one that is not connected would never resolve, and
            # check_lazy_status is called again until it returns nothing.
            need += [n for n in ("image", "clip", "positive_override",
                                 "negative_override") if n in linked]
        return [n for n in need if kwargs.get(n) is None]

    @classmethod
    def IS_CHANGED(cls, run_token="", **kwargs):
        # painting again with the same numbers must still re-render, but only when
        # this is actually a paint run: a bare queue must not re-run it at all
        return float("nan") if str(run_token or "").strip() else "idle"

    @staticmethod
    def _conditioning(clip, positive, negative, pc, pos_over, neg_over,
                      prompt=None, vae=None):
        """Which prompt the patch is rendered with, strongest claim first.

        1. conditioning wired into the override inputs
        2. a prompt typed on the Paint tab, encoded here when a CLIP is wired
        3. the main positive and negative, which is the whole-image prompt

        The override comes FIRST because wiring one is a deliberate act, and because
        of the shape it exists for: the Workspace hands the paint prompt out on
        `paint_prompt`, you join it with the LoRA keywords, run it through a studio
        node for the references, and wire the result back in here. If a typed prompt
        outranked that, building the chain would silently do nothing, since the tab
        obviously still holds the words that started it.

        Three is last because it is what the node used to do unconditionally, and it is
        rarely what anyone wanted: telling a painted patch to be more of the whole
        picture is not the edit you had in mind when you painted a region.
        """
        auto_words = _active_auto_prompt(pc)
        if pos_over is not None:
            if auto_words and clip is not None:
                auto_cond = _encode_text(clip, auto_words)
                pos_over = nodes.ConditioningConcat().concat(
                    pos_over, auto_cond)[0]
            print("[RedNode Paint] painting with the wired override conditioning",
                  flush=True)
            return pos_over, neg_over if neg_over is not None else negative
        typed = str((pc or {}).get("prompt") or "").strip()
        if typed:
            # @keyword macros work here exactly as in the Prompt Box, so a detail
            # phrase you type constantly lives in one place
            try:
                from . import prompt_library
                typed = prompt_library.expand_keywords(typed)
            except Exception:
                pass
        combined = ", ".join(x for x in (auto_words, typed) if x)
        refs_on = [k[4:] for k in ("use_subject", "use_scene", "use_moodboard")
                   if (pc or {}).get(k)]
        # Switching a reference on and getting no reference painting used to be
        # completely silent, so the only way to find out was to compare pictures.
        if refs_on and not (typed and clip is not None):
            missing = []
            if not typed:
                missing.append("a prompt typed on the Paint tab")
            if clip is None:
                missing.append("a clip wired into this node")
            print(f"[RedNode Paint] {', '.join(refs_on)} switched on as a reference, but "
                  f"reference painting also needs {' and '.join(missing)}. Painting "
                  "without the references.", flush=True)
        if typed and clip is not None and refs_on:
            built = RedNodePaintRender._with_refs(clip, vae, combined, pc, prompt)
            if built is not None:
                return built
        if typed and clip is not None:
            neg_words = str((pc or {}).get("negative") or "").strip()
            pos = _encode_text(clip, combined)
            neg = _encode_text(clip, neg_words)
            print(f"[RedNode Paint] painting with the tab's own prompt: "
                  f"{combined[:60]}",
                  flush=True)
            return pos, neg
        if auto_words and clip is not None:
            # An empty Paint box promises to keep the wired main conditioning. Encode
            # only the automatic caption and concatenate it, preserving the main
            # conditioning metadata and references instead of replacing them.
            auto_cond = _encode_text(clip, auto_words)
            pos = nodes.ConditioningConcat().concat(positive, auto_cond)[0]
            print("[RedNode Paint] combined the automatic caption with the main "
                  "conditioning", flush=True)
            return pos, negative
        if typed:
            print("[RedNode Paint] the Paint tab has a prompt but no CLIP is wired to "
                  "this node, so it cannot be encoded. Wire clip, wire the override "
                  "inputs, or clear the prompt to use the main conditioning.",
                  flush=True)
        elif auto_words:
            print("[RedNode Paint] Auto Prompt is on but no CLIP is wired, so its "
                  "caption cannot be combined with the main conditioning. Wire clip "
                  "or use Paint Out's text prompt output.", flush=True)
        return positive, negative

    @staticmethod
    def _apply_loras(model, clip, pc, prompt):
        """Put the Workspace's LoRAs tab onto the model this node was handed.

        Normally unnecessary: wire the Workspace's model output, which is already
        LoRA-applied, and this stays off. It exists for painting on a DIFFERENT model
        from the main generation, which arrives raw and still wants the stack.

        Off by default and it has to be. With the LoRA-applied model wired, turning
        this on applies every LoRA a second time, at double strength, silently.
        """
        if not pc.get("use_loras"):
            return model, clip
        cfg = _workspace_cfg(prompt)
        lc = cfg.get("loras") if isinstance(cfg.get("loras"), dict) else {}
        slots = lc.get("slots") or []
        if not lc.get("on", True) or not slots:
            print("[RedNode Paint] use LoRAs is on but the Workspace's LoRAs tab is "
                  "empty or off, so the model is used as it arrived", flush=True)
            return model, clip
        try:
            from . import lora_stack as _lora
            model, clip, _words, applied = _lora.apply_stack(
                model, clip, _lora.CUSTOM_SENTINEL,
                json.dumps({"ui": lc.get("ui") or {}, "slots": slots}),
                int(lc.get("seed", 0) or 0), None, tag="Paint LoRAs")
            print(f"[RedNode Paint] LoRAs applied for this paint: {applied}. If the "
                  "model wired here already went through the LoRAs tab, they are on "
                  "twice; switch this off.", flush=True)
        except Exception as e:
            print(f"[RedNode Paint] could not apply the LoRAs ({e}); painting with the "
                  "model as it arrived", flush=True)
        return model, clip

    @staticmethod
    def _with_refs(clip, vae, words, pc, prompt):
        """Conditioning for the patch WITH the Workspace's reference images.

        Painting an outfit onto a person, or repainting a face, wants the references
        the picture was made from. Rather than reimplementing that, the job goes to
        the studio node, which is the validated path from references plus words to a
        matched positive and negative.

        Opt in, because it costs real time: the plain text encode is what makes
        painting feel instant, and that speed is the point of painting.
        """
        wcfg = _workspace_cfg(prompt)
        refs = {}
        if pc.get("use_subject"):
            refs["subject_image"] = _tab_image(wcfg, "subject")
        if pc.get("use_scene"):
            refs["scene_image"] = _tab_image(wcfg, "scene")
        if pc.get("use_moodboard"):
            refs["moodboard_style"] = _tab_image(wcfg, "moodboard")
        refs = {k: v for k, v in refs.items() if v is not None}
        if not refs:
            print("[RedNode Paint] reference painting is on but those tabs have no "
                  "image, so the patch uses the prompt alone", flush=True)
            return None
        dials = wcfg.get("dials") if isinstance(wcfg.get("dials"), dict) else {}
        preset = str(wcfg.get("studio_preset") or "").strip() or "Balanced"
        try:
            from . import rednode as _rn
            pos, neg = _rn.Krea2RedNode().encode(
                clip=clip, instruction=words, preset=preset,
                style_strength=float(dials.get("style_strength", 0.5)),
                negative_prompt=str(pc.get("negative") or ""), vae=vae, **refs)
        except Exception as e:
            print(f"[RedNode Paint] could not build the reference conditioning ({e}); "
                  "using the prompt alone instead", flush=True)
            return None
        print(f"[RedNode Paint] painting with {', '.join(sorted(refs))} as reference, "
              f"preset {preset}", flush=True)
        return pos, neg

    def render(self, model=None, positive=None, negative=None, vae=None,
               seed=0, steps=8, cfg=1.0,
               sampler_name="euler", scheduler="simple", run_token="", image=None,
               clip=None, positive_override=None, negative_override=None,
               prompt=None, unique_id=None):
        if not str(run_token or "").strip():
            # Quietly. This fires on every ordinary queue, and a line plus a black
            # 64px preview per run is noise about a node that did nothing. The inputs
            # were not even evaluated, thanks to check_lazy_status.
            return {"ui": {"images": []},
                    "result": (image if image is not None
                               else _ws.blank_frame(),)}
        pc = _paint_from_prompt(prompt) or {}
        # a wired image is never thrown away: if the tab has nothing to say, the
        # picture still comes back out rather than being replaced by a black frame
        if not pc.get("on") or (image is None and not pc.get("source")):
            print("[RedNode Paint] nothing to render: switch the Paint tab on and paint "
                  "something", flush=True)
            return _out(image if image is not None else _ws.blank_frame())

        if image is not None:
            base = image
            print(f"[RedNode Paint] painting the WIRED image "
                  f"({image.shape[2]} x {image.shape[1]})", flush=True)
        else:
            base = _ws.load_image_or_blank(pc["source"], 0, "RedNode Paint Render")
            print(f"[RedNode Paint] painting {pc['source']} from the Paint tab",
                  flush=True)
        full_h, full_w = base.shape[1], base.shape[2]
        mask = None
        if pc.get("mask"):
            try:
                mask = _ws.load_mask(pc["mask"], (full_h, full_w))
            except ValueError as e:
                print(f"[RedNode Paint] the mask is unusable ({e})", flush=True)

        if mask is not None and pc.get("invert"):
            # painting what stays rather than what changes, which is quicker when the
            # thing you want kept is smaller than the thing you want redone
            mask = 1.0 - mask
            print("[RedNode Paint] the painted area is inverted: everything you did "
                  "NOT paint is what changes", flush=True)

        if mask is None or not pc.get("mask_only", True):
            box = (0, full_h, 0, full_w)
        else:
            box = _bbox(mask)
            if box is None:
                print("[RedNode Paint] nothing is painted yet, so there is nothing to "
                      "render", flush=True)
                return _out(base)
            # the shape step: grow the box toward an aspect the model knows, adding
            # context rather than trimming paint. Defaults to auto, so a config saved
            # before the Paint tab had the control gets the sensible behaviour.
            shape = str(pc.get("region_shape") or "auto")
            grown = grow_to_aspect(box, full_h, full_w,
                                   region_aspect(box[3] - box[2], box[1] - box[0],
                                                 shape))
            if grown != box:
                print(f"[RedNode Paint] region grown for shape ({shape}): "
                      f"{box[3] - box[2]} x {box[1] - box[0]} to "
                      f"{grown[3] - grown[2]} x {grown[1] - grown[0]}", flush=True)
            box = grown
        y0, y1, x0, x1 = box

        crop = base[:, y0:y1, x0:x1, :]
        crop_h, crop_w = crop.shape[1], crop.shape[2]
        whole = not pc.get("mask_only", True) or mask is None
        if whole:
            # MASK SIZE IS THE SCALE, and whole frame keeps the bigger result. Sampling
            # above a model's native resolution is where the detail comes from, and the
            # working number is around 1.5x whatever the model recommends. This used to
            # render the frame at its own size and refuse to resize, which was only
            # correct while the composite scaled everything back down to the source and
            # threw the extra away. It does not any more: an upscaled whole-frame pass
            # composites AT the new size and hands the larger picture on, so the tab is
            # its own resolution pass and needs no upscaler beside it.
            tier = str(_workspace_cfg(prompt).get("vram_tier") or "high")
            cap = whole_frame_limit(tier)
            # only when the TAB asked: with no Workspace in the graph there is no dial
            # and no intent, so a wired image renders at the size it arrived at
            want = int(pc["mask_size"]) if "mask_size" in pc else 0
            # THE DIAL IS THE WORKING SIZE, BOTH DIRECTIONS (2026-08-03). Whole frame
            # means the whole picture through the sampler at the size the tab asks for:
            # a 3K frame with the dial at 1024 renders at 1024. A never-downscale rule
            # stood here before, and it made the dial read as dead on any big frame,
            # when the point of the mode is that the FRAME goes through, at YOUR size.
            target = want if want else max(crop_h, crop_w)
            capped = pc.get("fit_whole", True) and target > cap
            if capped:
                target = max(cap, 64)
            # scaled is INTENT, the dial or the cap: _round8 may still nudge an odd
            # frame a few pixels, and a nudge must keep compositing into the original
            scaled = target != max(crop_h, crop_w)
            work = _fit(crop, target) if scaled else _round8(crop)
            if capped:
                print(f"[RedNode Paint] whole frame wanted {want} px but the {tier} VRAM "
                      f"tier caps it at {cap}, so it renders at {work.shape[2]} x "
                      f"{work.shape[1]}. Raise the tier in the Workspace footer, or "
                      "switch off Fit large frames.", flush=True)
            elif work.shape[2] != crop_w or work.shape[1] != crop_h:
                print(f"[RedNode Paint] whole frame {crop_w} x {crop_h} scaled to "
                      f"{work.shape[2]} x {work.shape[1]} by the mask size, denoise "
                      f"{pc['denoise']}"
                      + (" (mask limits what changes)" if mask is not None else ""),
                      flush=True)
            else:
                print(f"[RedNode Paint] whole frame at its own {work.shape[2]} x "
                      f"{work.shape[1]}, denoise {pc['denoise']}"
                      + (" (mask limits what changes)" if mask is not None else ""),
                      flush=True)
        else:
            # A painted region is small, so rendering it AT the mask size puts more
            # pixels on it than it had. That extra resolution is the detail, and it is
            # spent as a pixel BUDGET so a long region gets as much of it as a compact
            # one instead of being rationed by its longest side.
            # the tier caps the BUDGET, which is the thing that costs: area is what
            # fills VRAM, so bounding the budget bounds the cost whatever shape the
            # region is, even though a wide region's long edge can exceed the number
            tier = str(_workspace_cfg(prompt).get("vram_tier") or "high")
            cap = whole_frame_limit(tier)
            want = int(pc.get("mask_size", 1024))
            budget = min(want, cap)
            if budget < want:
                print(f"[RedNode Paint] region wanted a {want} px budget but the {tier} "
                      f"VRAM tier caps it at {cap}", flush=True)
            floor = bool(pc.get("region_floor"))
            work = _fit_region(crop, budget, cap=cap, floor=floor)
            if floor and work.shape[2] >= crop_w and work.shape[1] >= crop_h \
                    and crop_w * crop_h > budget * budget:
                print(f"[RedNode Paint] Never shrink is on, so this region renders at "
                      f"its own size rather than coming down to the {budget} px budget",
                      flush=True)
            print(f"[RedNode Paint] region {crop_w} x {crop_h} rendered at "
                  f"{work.shape[2]} x {work.shape[1]}, denoise {pc['denoise']}",
                  flush=True)

        # WHOLE FRAME AT ZERO DENOISE IS A PURE SCALE, so it does not sample. This is a
        # real step in the way this tab gets used: run the frame up to working resolution
        # with nothing changed, paint the details on that, then a low-denoise whole-frame
        # pass to settle the feathered edges. Only the first of those wants no model at
        # all, and sampling seven steps at 4K to produce the picture you already have is
        # minutes for nothing. Skipping the VAE round trip matters too: encode and decode
        # are not lossless, so the "unchanged" frame really is unchanged.
        if whole and float(pc.get("denoise", 0.6)) <= 0.0:
            print(f"[RedNode Paint] whole frame at denoise 0: scaled to "
                  f"{work.shape[2]} x {work.shape[1]} and handed straight back, with no "
                  "sampling and no VAE round trip", flush=True)
            return _out(work)

        model, clip = self._apply_loras(model, clip, pc, prompt)
        pos, neg = self._conditioning(clip, positive, negative, pc,
                                      positive_override, negative_override,
                                      prompt=prompt, vae=vae)
        latent = {"samples": vae.encode(work[:, :, :, :3])}
        # The Paint tab owns these when it has them, the same way it already owns
        # denoise, so the dials you are looking at while painting are the ones that run.
        # Absent means a workflow saved before the tab had them: the widgets on this
        # node are what that user set, so they keep winning.
        steps = int(pc.get("steps", steps))
        cfg = float(pc.get("cfg", cfg))
        out = nodes.common_ksampler(model, seed, steps, cfg, sampler_name, scheduler,
                                    pos, neg, latent,
                                    denoise=max(0.01, float(pc["denoise"])))[0]
        painted = vae.decode(out["samples"])
        while painted.ndim > 4:                               # video VAEs hand back 5D
            painted = painted[0]

        # A WHOLE-FRAME PASS THAT RESIZED KEEPS THE RENDER'S SIZE, up or down. Scaling
        # the render back to the source would spend the whole sample on pixels that are
        # then thrown away going up, and quietly un-shrink a frame the dial brought
        # down going the other way. The picture and the mask come TO the render size
        # instead, so the pass hands on the frame at the dial and the paint still
        # limits what changed. A painted REGION is unaffected: it cannot change the
        # frame's size, so it comes back down and composites where it came from.
        if whole and scaled:
            big_h, big_w = painted.shape[1], painted.shape[2]
            up = F.interpolate(base.permute(0, 3, 1, 2), size=(big_h, big_w),
                               mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
            if mask is None:
                print(f"[RedNode Paint] done; the frame comes back at {big_w} x {big_h}",
                      flush=True)
                return _out(painted)
            m = F.interpolate(mask.unsqueeze(1), size=(big_h, big_w),
                              mode="bilinear", align_corners=False).squeeze(1)
            m = m.unsqueeze(-1).to(painted.dtype)
            result = up * (1 - m) + painted[..., :up.shape[-1]] * m
            print(f"[RedNode Paint] done; the frame comes back at {big_w} x {big_h}, "
                  "with only the painted area re-rendered", flush=True)
            return _out(result)

        # back to the crop's own size, then into the picture through the mask so only
        # what was painted actually changes
        back = _fit(painted, max(crop_h, crop_w))
        back = F.interpolate(back.permute(0, 3, 1, 2), size=(crop_h, crop_w),
                             mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
        result = base.clone()
        if mask is not None:
            # Through the mask ALWAYS, whichever mode. The two modes decide how much
            # gets RENDERED, not how much is allowed to change: whole frame exists so
            # the model can see the entire picture for context, not so it may repaint
            # all of it. Compositing the raw render in whole-frame mode replaced parts
            # of the image nobody painted over.
            m = mask[:, y0:y1, x0:x1].unsqueeze(-1).to(back.dtype)
            result[:, y0:y1, x0:x1, :] = crop * (1 - m) + back * m
        else:
            result[:, y0:y1, x0:x1, :] = back
        print("[RedNode Paint] done; the rest of the picture was never re-rendered",
              flush=True)
        return _out(result)


def _out(image):
    """Return the image AND show it, because nothing downstream will.

    Generate prunes the queued prompt to this node's own inputs, so a Save or
    Preview wired after it is deliberately not part of the run. The result has to
    surface from here or it goes nowhere: this writes a temp preview, which puts
    it on the node and, through the executed event, into the Paint tab's result
    pane ready to paint on again.
    """
    try:
        from PIL import Image as _PILImage
        out_dir = folder_paths.get_temp_directory()
        os.makedirs(out_dir, exist_ok=True)
        name = f"rednode_paint_{random.randint(0, 0xffffffff):08x}.png"
        t = image[0] if image.ndim == 4 else image
        arr = (t.detach().cpu().float().clamp(0, 1).numpy() * 255).astype("uint8")
        _PILImage.fromarray(arr[..., :3], mode="RGB").save(os.path.join(out_dir, name),
                                                          compress_level=4)
        return {"ui": {"images": [{"filename": name, "subfolder": "", "type": "temp"}]},
                "result": (image,)}
    except Exception as e:
        print(f"[RedNode Paint] could not write the preview ({e})", flush=True)
        return (image,)


def _workspace_cfg(prompt):
    """The whole Workspace config from the queued graph, for the reference tabs."""
    if not isinstance(prompt, dict):
        return {}
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "RedNodeStudioWorkspace":
            continue
        raw = (node.get("inputs") or {}).get("config")
        if isinstance(raw, str):
            try:
                cfg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if isinstance(cfg, dict):
                return cfg
    return {}


def _tab_image(cfg, name, target=1024):
    """The image currently selected on one Workspace tab, or None."""
    tab = ((cfg.get("tabs") or {}).get(name) or {})
    if not tab.get("on"):
        return None
    images = tab.get("images") or []
    if not images:
        return None
    sel = tab.get("sel", 0)
    if isinstance(sel, list):
        sel = sel[0] if sel else 0
    try:
        return _ws.load_image(images[int(sel) % len(images)], target)
    except Exception as e:
        print(f"[RedNode Paint] could not load the {name} reference ({e})", flush=True)
        return None


def _linked_inputs(prompt, unique_id):
    """The names of this node's inputs that something is actually wired into.

    None when it cannot be worked out, which callers must read as "do not ask for any
    optional input": requesting one with no link behind it never resolves, and
    check_lazy_status is called again until it asks for nothing.
    """
    try:
        inputs = (prompt or {})[str(unique_id)]["inputs"]
    except (KeyError, TypeError):
        return None
    if not isinstance(inputs, dict):
        return None
    return {k for k, v in inputs.items() if isinstance(v, (list, tuple)) and len(v) == 2}


def _paint_from_prompt(prompt):
    """The Paint tab's settings, read off the Workspace in the queued graph."""
    if not isinstance(prompt, dict):
        return None
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "RedNodeStudioWorkspace":
            continue
        raw = (node.get("inputs") or {}).get("config")
        if not isinstance(raw, str):
            continue
        try:
            return _ws.parse_config(raw)["paint"]
        except (ValueError, TypeError, KeyError):
            continue
    return None


NODE_CLASS_MAPPINGS = {"RedNodePaintRender": RedNodePaintRender}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePaintRender": "RedNode Paint Render"}
