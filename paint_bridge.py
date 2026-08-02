"""RedNode Paint Out and Paint In: the Paint tab with somebody else's renderer.

RedNode Paint Render does the whole job in one node, which is fast and Krea 2 shaped.
This pair opens the middle of it up. Paint Out hands you the picture and the mask that
the Paint tab is holding; you send those through whatever you like, an API model, a
different architecture, another pack's img2img; Paint In takes the result and
composites it back through the feathered mask.

Everything except the render itself is model-agnostic, so there is no reason it should
be locked to one model. This is the same idea as Refine Crop and Refine Paste, except
those hand out a LATENT, which is no use to a service that speaks in pictures, and
these read the Paint tab instead of needing the image and mask wired in.

The handoff carries the original picture and the mask, so Paint In needs no second
copy of either. Nothing here knows or cares what happened in between.
"""

import hashlib
import json

import torch
import torch.nn.functional as F

from . import workspace as _ws
from .paint_render import (REGION_SHAPES as SHAPES, _bbox, _fit, _fit_region, _out,
                          _active_auto_prompt, _paint_from_prompt, _workspace_cfg,
                          grow_to_aspect, region_aspect, whole_frame_limit)

PAINT_TYPE = "RN_PAINT"

# "auto" first, so it is the default for a freshly added node. Existing workflows
# keep whatever they saved.
SCOPES = ("auto", "whole frame", "painted region")


class RedNodePaintOut:
    """The Paint tab's picture and mask, on their way to somebody else's renderer."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scope": (list(SCOPES), {"default": "auto", "tooltip":
                          "Auto follows the Paint tab: its Painted mode hands out the "
                          "region, Whole frame hands out the picture, so the switch you "
                          "set while painting is the one that runs. Whole frame hands "
                          "out the full picture and a full-size mask, which is what "
                          "most hosted models expect, and forces that even while "
                          "painting a region. Painted region hands out just the painted "
                          "area plus context, the way RedNode Paint Render works, which "
                          "puts more pixels on the part being redone."}),
                "context": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 2.0,
                            "step": 0.05, "tooltip":
                            "Painted region only: how much extra room around the paint "
                            "to include, as a fraction of its size. Some context is "
                            "what lets a renderer match the lighting instead of leaving "
                            "a seam."}),
                "region_size": ("INT", {"default": 0, "min": 0, "max": 4096,
                                "step": 64, "tooltip":
                                "Painted region only: the PIXEL BUDGET the region is "
                                "handed out at, as the side of a square. 1024 means "
                                "about a megapixel however the region is shaped, so a "
                                "long thin mask gets the same detail as a compact one "
                                "instead of being rationed by its longest side. 0 "
                                "follows the Paint tab's size dial, which is what the "
                                "whole-frame path already does; anything else forces "
                                "that budget."}),
                # APPENDED, after region_size, so nothing already wired moves.
                "region_shape": (list(SHAPES), {"default": "auto", "tooltip":
                                 "Painted region only: the shape the region is grown "
                                 "to. Auto picks whichever of 1:1, 4:3, 3:4, 16:9 and "
                                 "9:16 the painted area is already closest to, which "
                                 "keeps it inside what the model was trained on. The "
                                 "box only ever GROWS, adding context around the "
                                 "paint, so nothing you painted is ever cropped out."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "the picture to work from. Leave it "
                                    "unwired and it follows the Paint tab, the same as "
                                    "RedNode Paint Render does."}),
                # The Paint tab promises "leave empty to use the main prompt", and the
                # internal renderer keeps that promise through the conditioning wired
                # into it. A bridge renderer only ever hears text, so the promise has
                # to be kept here instead: wire the main prompt in once and the empty
                # box hands IT out.
                "main_prompt": ("STRING", {"forceInput": True, "tooltip":
                                "your main prompt. When the Paint tab's prompt box is "
                                "empty, the prompt output hands this out instead, which "
                                "is the same promise the box makes for the internal "
                                "renderer."}),
                "main_negative": ("STRING", {"forceInput": True, "tooltip":
                                  "your main negative. When the Paint tab's negative "
                                  "box is empty, the negative output hands this out "
                                  "instead."}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    # denoise and prompt come out as plain values so they can drive somebody else's
    # node: an img2img strength dial, a prompt box. The Paint tab stays the one place
    # those are set, whatever ends up doing the rendering.
    # width and height are APPENDED, so nothing already wired moves. They are the
    # size of the image THIS node is handing out, which in painted-region scope is not
    # the size of the source picture: a renderer that needs its dimensions told to it
    # has to hear them from here, not from a Get Image Info on the original.
    # cfg and steps are APPENDED for the same reason width and height were: slot order
    # is positional in a saved workflow, so anything already wired keeps its socket.
    # APPENDED, never inserted or reordered. Output slots are positional in a saved
    # workflow, so a new socket on the end costs nothing and every existing wire stays
    # where it was, while moving one silently repoints somebody's graph.
    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "STRING", PAINT_TYPE, "INT", "INT",
                    "FLOAT", "INT", "STRING", "INT")
    RETURN_NAMES = ("image", "mask", "denoise", "prompt", "paint", "width", "height",
                    "cfg", "steps", "negative", "seed")
    FUNCTION = "handoff"
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Hands the Paint tab's picture and mask out so any renderer can do "
                   "the work: a hosted model, a different architecture, another pack's "
                   "img2img. Wire the result into RedNode Paint In to composite it back "
                   "through the feathered mask. The paint output carries the original, "
                   "so nothing needs wiring twice. denoise, prompt, width, height, cfg "
                   "and steps come out too, for wiring into whatever the renderer calls "
                   "its strength, its prompt, its dimensions and its sampler dials, so "
                   "the Paint tab stays the one place you set them. The width and height "
                   "are of the image being handed out, which in painted-region scope is "
                   "not the size of the original picture. Wire your main prompt and "
                   "negative into main_prompt and main_negative and the tab's empty "
                   "boxes fall back to them, the same promise the boxes make for the "
                   "internal renderer.")

    # THE reason this node needs one. ComfyUI builds its cache key from the node's real
    # inputs, and hidden ones are not among them (comfy_execution/caching.py, which
    # signs node["inputs"]). This node's real inputs are scope, context and region_size,
    # and none of those change when you paint: everything that does change arrives
    # through the hidden PROMPT. So after the first run it was cached forever, and every
    # Generate handed the renderer the FIRST run's picture, mask, denoise and prompt.
    # Paint Render never showed this because it has a run_token that changes every time.
    #
    # THIS IGNORES, IT DOES NOT WATCH, and the direction is the whole point. It used to
    # list the keys worth noticing, which meant every key added afterwards was silently
    # unwatched. feather and mask_size both change the picture and neither was ever on
    # that list, so altering the mask edge or its size handed back the previous render
    # with nothing to say why. The two mistakes do not cost the same: forget to ignore a
    # key here and you get one needless re-render, forget to watch one and you get the
    # wrong image and no error. So only keys that CANNOT change the picture are named,
    # and everything else, including anything added later, is hashed by default.
    @classmethod
    def IS_CHANGED(cls, prompt=None, **kwargs):
        found = _paint_from_prompt(prompt)
        if found is None:
            if prompt:
                # A queued graph with no Workspace in it: the picture arrives on the
                # image wire, the wire's upstream signature already covers it, and
                # there is no paint config to go stale, so caching normally is right.
                return ""
            # Current ComfyUI never shows this method the graph at all. IsChangedCache
            # in execution.py evaluates IS_CHANGED with constants only: it calls
            # get_input_data without the dynprompt, and without a dynprompt the hidden
            # PROMPT is filled with {}. So the paint config is invisible from here,
            # however carefully the branch below hashes it. Hashing that emptiness
            # returned the same digest every press, which is the forever-cached bug in
            # new clothes: the first press after a restart landed, every press after
            # it composited through the PREVIOUS mask, and the cache-check line below
            # was silently skipped, so nothing said why. When the config cannot be
            # seen, refuse to vouch for the cache: NaN never compares equal to itself
            # (comfy_execution/caching.py uses that same marker for "cannot cache"),
            # so the signature never matches and this node re-runs whenever it is
            # actually pulled. Paint In's lazy gate keeps idle queues from pulling it,
            # and on a paint run the seed has rolled anyway, so the honest answer
            # costs nothing a real run was not already paying.
            print("[RedNode Paint Out] cache check: this ComfyUI build hands "
                  "IS_CHANGED an empty PROMPT, so the paint config cannot be "
                  "inspected and this node re-runs rather than trust the cache",
                  flush=True)
            return float("NaN")
        pc = dict(found)
        for k in ("brush", "brush_shape",                        # the tool, not the mark
                  "renderer", "renderer_name", "renderer_kind",  # who consumes it
                  "scale", "zoom", "tab", "open", "collapsed",   # panel furniture
                  "preview", "result", "history",                # what it last made
                  "seed_random"):     # whether the seed rolls, not what it rolled to;
                                      # the seed itself IS hashed, so a roll re-renders
                                      # and a fixed repeat is correctly served cached
            pc.pop(k, None)
        raw = json.dumps(pc, sort_keys=True, default=str)
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        # SAYS WHAT IT SEES, once per queue, unconditionally: a guard here once kept
        # the empty-prompt case silent, which cost an evening. If mask/seed do not
        # move between two presses, the frontend posted a stale config; if they move
        # and the "handing out" line still does not print, the cache ignored this
        # hash.
        print(f"[RedNode Paint Out] cache check: {digest[:8]} "
              f"(mask={pc.get('mask') or '(none)'}, seed={pc.get('seed', 0)})",
              flush=True)
        return digest

    def handoff(self, scope="whole frame", context=0.25, region_size=1024,
                region_shape="auto", image=None, prompt=None,
                main_prompt="", main_negative=""):
        pc = _paint_from_prompt(prompt) or {}
        base = image
        if base is None:
            if not pc.get("source"):
                # A shared workflow whose author never saved a source, or a fresh
                # graph queued before anyone painted: hand out a blank frame rather
                # than taking the queue down for everything downstream.
                print("[RedNode Paint Out] no picture set on the Paint tab, so a "
                      "blank frame goes out. Open an image on the tab, or wire one "
                      "into this node.", flush=True)
                base = _ws.blank_frame()
            else:
                base = _ws.load_image_or_blank(pc["source"], 0,
                                               "RedNode Paint Out")
        full_h, full_w = base.shape[1], base.shape[2]

        mask = None
        if pc.get("mask"):
            try:
                mask = _ws.load_mask(pc["mask"], (full_h, full_w))
            except ValueError as e:
                print(f"[RedNode Paint Out] the mask is unusable ({e})", flush=True)
        if mask is None:
            if pc.get("invert"):
                # Invert reads "keep what I painted", and painting nothing keeps
                # nothing: the whole frame is the region. Without this the fallback
                # below handed out an EMPTY mask under invert, which is the exact
                # opposite of what inverted-nothing means, and the composite quietly
                # returned the original untouched.
                mask = torch.ones((1, full_h, full_w))
                print("[RedNode Paint Out] nothing is painted and invert is on, so "
                      "the WHOLE frame is the region", flush=True)
            else:
                # no paint yet: hand out the whole picture and an empty mask rather
                # than failing, so a half-built graph still runs
                mask = torch.zeros((1, full_h, full_w))
                print("[RedNode Paint Out] nothing is painted yet, so the mask is "
                      "empty", flush=True)
        elif pc.get("invert"):
            mask = 1.0 - mask

        # "auto" follows the Paint tab, the same way region_shape already does. The tab's
        # Painted mode is mask_only, and it is the switch you are looking at while you
        # paint, so it should decide the handoff. The two explicit values stay as a
        # forced override for a renderer that can only take one shape.
        want_scope = str(scope or "auto")
        if want_scope == "auto":
            want_scope = ("painted region" if pc.get("mask_only", True) and mask is not None
                          else "whole frame")
            print(f"[RedNode Paint Out] scope auto -> {want_scope} (from the Paint tab)",
                  flush=True)

        if want_scope == "painted region":
            box = _bbox(mask, pad=float(context))
            if box is None:
                box = (0, full_h, 0, full_w)
            # The node's widget wins when it is not on auto, and the Paint tab's own
            # setting fills in otherwise, so the tab stays the one place things are set
            # while the node can still override for a renderer with its own opinion.
            want = str(region_shape or "auto")
            if want == "auto":
                want = str(pc.get("region_shape") or "auto")
            grown = grow_to_aspect(box, full_h, full_w,
                                   region_aspect(box[3] - box[2], box[1] - box[0],
                                                 want))
            if grown != box:
                print(f"[RedNode Paint Out] region grown for shape ({want}): "
                      f"{box[3] - box[2]} x {box[1] - box[0]} to "
                      f"{grown[3] - grown[2]} x {grown[1] - grown[0]}", flush=True)
            box = grown
            y0, y1, x0, x1 = box
            crop = base[:, y0:y1, x0:x1, :]
            tier = str(_workspace_cfg(prompt).get("vram_tier") or "high")
            # 0 follows the tab's size dial, which is what the whole-frame path below
            # already does. Two paths on one node reading the same decision from two
            # places is how a dial stops meaning what it says.
            budget = int(region_size or 0) or int(pc.get("mask_size", 1024))
            out_img = _fit_region(crop, min(budget, whole_frame_limit(tier)),
                                  cap=whole_frame_limit(tier))
            out_mask = F.interpolate(
                mask[:, y0:y1, x0:x1].unsqueeze(1),
                size=(out_img.shape[1], out_img.shape[2]),
                mode="bilinear", align_corners=False).squeeze(1)
            print(f"[RedNode Paint Out] handing out the painted region "
                  f"{x1 - x0} x {y1 - y0} at {out_img.shape[2]} x {out_img.shape[1]}",
                  flush=True)
        else:
            # WHOLE FRAME TAKES THE TAB'S SIZE AS A SCALE, the same as the internal
            # renderer does, because sampling above a model's native resolution is where
            # the detail is and the tab is the one place that number lives. Scaling here
            # rather than downstream means the renderer receives the bigger picture, the
            # width and height outputs describe it, and Paint In composites at that size
            # with no change of its own: the handoff carries the scaled base and a box
            # covering it.
            tier = str(_workspace_cfg(prompt).get("vram_tier") or "high")
            # only when the TAB asked. With no Workspace in the graph there is no dial
            # and no intent, so a wired image is handed on at the size it arrived at
            # rather than being upscaled to a default nobody chose.
            want = (min(int(pc["mask_size"]), whole_frame_limit(tier))
                    if "mask_size" in pc else 0)
            target = max(full_h, full_w)
            if want > target:                        # never downscale somebody's picture
                base = _fit(base, want)
                mask = F.interpolate(mask.unsqueeze(1),
                                     size=(base.shape[1], base.shape[2]),
                                     mode="bilinear", align_corners=False).squeeze(1)
                full_h, full_w = base.shape[1], base.shape[2]
                print(f"[RedNode Paint Out] whole frame scaled to {full_w} x {full_h} "
                      f"by the tab's size ({want})", flush=True)
            box = (0, full_h, 0, full_w)
            out_img, out_mask = base, mask
            print(f"[RedNode Paint Out] handing out the whole frame "
                  f"{full_w} x {full_h} with a full-size mask "
                  f"(mask file {pc.get('mask') or '(wired image)'}, "
                  f"seed {pc.get('seed', 0)})", flush=True)

        denoise = float(pc.get("denoise", 0.6))
        words = str(pc.get("prompt") or "")
        # toggled keyword chips ride behind the typed prompt as @names, then the same
        # expansion below turns them into their saved text. Unknown names pass through
        # as-is, which is the library's own rule, so a renamed keyword shows itself in
        # the prompt instead of silently vanishing.
        kws = [k for k in (pc.get("keywords") or []) if isinstance(k, str) and k]
        if kws:
            words = ", ".join(x for x in [words] + ["@" + k for k in kws] if x)
        try:                                    # @keyword macros, as everywhere else
            from . import prompt_library
            words = prompt_library.expand_keywords(words)
        except Exception:
            pass
        # The empty box falls back to whatever is wired into main_prompt, keeping the
        # tab's "leave empty to use the main prompt" promise for renderers that only
        # hear text. The wired text is passed through UNTOUCHED: it is somebody's
        # finished prompt, already expanded by whatever built it, not this node's to
        # rewrite. And when both are empty, say so out loud: a hosted renderer given
        # an empty prompt paints something, silently, and it is never what was meant.
        if not words.strip():
            words = str(main_prompt or "")
            if not words.strip():
                print("[RedNode Paint Out] no prompt to hand out: the Paint box is "
                      "empty and nothing is wired into main_prompt", flush=True)
        auto_words = _active_auto_prompt(pc)
        if auto_words:
            # The automatic layer sits before the user's Paint text or its wired-main
            # fallback. Replacing the box here would break the exact fallback this
            # bridge exists to preserve.
            words = ", ".join(x for x in (auto_words, words) if x)
        # Absent from an older config, in which case the renderer's own dials are the
        # ones the user set and these carry that node's defaults rather than fighting it
        cfg_scale = float(pc.get("cfg", 1.0))
        steps = int(pc.get("steps", 8))
        # The tab has had a Paint negative box since the beginning and this node never
        # handed it out, so everything typed into it went nowhere. Same @keyword
        # expansion as the positive, or the two boxes would not behave the same.
        against = str(pc.get("negative") or "")
        try:
            from . import prompt_library
            against = prompt_library.expand_keywords(against)
        except Exception:
            pass
        # Same fallback, independently: the main negative is what the render should
        # avoid whether or not the paint prompt box was used, so it does not wait on
        # the positive the way the internal renderer's conditioning does.
        if not against.strip():
            against = str(main_negative or "")
        seed = int(pc.get("seed", 0))
        return (out_img, out_mask, denoise, words,
                {"base": base, "mask": mask, "box": box, "scope": scope},
                int(out_img.shape[2]), int(out_img.shape[1]), cfg_scale, steps,
                against, seed)


class RedNodePaintIn:
    """The rendered picture, composited back where it came from."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # LAZY, and gated by the run token below. Without this, wiring
                # this node to anything that runs would fire the whole renderer chain
                # on EVERY ordinary queue: for a hosted model that is a paid API call
                # per queue, made silently. Declining the input means nothing upstream
                # of it is executed at all.
                "image": ("IMAGE", {"lazy": True,
                          "tooltip": "whatever your renderer produced"}),
                "paint": (PAINT_TYPE, {"tooltip": "from RedNode Paint Out. Carries the "
                                       "original picture, the mask and where the region "
                                       "came from, so none of it needs wiring twice."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0,
                             "step": 0.05, "tooltip":
                             "How much of the render lands. 1.0 replaces the masked "
                             "area completely; lower blends it with what was there, "
                             "which can rescue a result that went too far."}),
                "run_token": ("STRING", {"default": "", "tooltip":
                              "leave this empty. The Paint tab's Generate button fills "
                              "it in for its own runs. While it is empty this node sits "
                              "out, and the renderer feeding it is never executed, so "
                              "an ordinary queue costs nothing. Clear it and press "
                              "Generate to paint."}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "paste"
    # An OUTPUT node, for the same two reasons Paint Render is one. ComfyUI refuses a
    # prompt with no outputs, and Generate prunes to this node, so without this the
    # whole chain is rejected with "Prompt has no outputs". It also means the result
    # surfaces on the node and reaches the Paint tab's result pane, ready to paint on
    # again, instead of existing only on a wire.
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Composites a rendered picture back through the Paint tab's feathered "
                   "mask, so only what you painted changes and the rest of the image is "
                   "untouched. Pair it with RedNode Paint Out and put any renderer you "
                   "like in between.")

    def check_lazy_status(self, run_token="", **kwargs):
        """Ask for the rendered image only on a real paint run.

        This is what stops an ordinary queue from calling a hosted renderer. An empty
        token means nobody asked, so the image is never requested and the chain that
        would have produced it is never executed.
        """
        if not str(run_token or "").strip():
            return []
        return ["image"] if kwargs.get("image") is None else []

    @classmethod
    def IS_CHANGED(cls, run_token="", **kwargs):
        # painting again with the same settings must still re-render, but only when
        # this really is a paint run
        return float("nan") if str(run_token or "").strip() else "idle"

    def paste(self, image=None, paint=None, strength=1.0, run_token="", prompt=None):
        if paint is None:
            raise ValueError("RedNode Paint In: wire the paint output of RedNode "
                             "Paint Out into this node.")
        if not str(run_token or "").strip() or image is None:
            # quietly: this fires on every ordinary queue and the picture is unchanged
            return {"ui": {"images": []}, "result": (paint["base"],)}
        base = paint["base"]
        mask = paint["mask"]
        y0, y1, x0, x1 = paint["box"]
        crop_h, crop_w = y1 - y0, x1 - x0

        back = image
        while back.ndim > 4:                        # video VAEs hand back 5D
            back = back[0]
        if back.shape[1] != crop_h or back.shape[2] != crop_w:
            # whatever size the renderer chose, it goes back at the size it left
            back = F.interpolate(back.permute(0, 3, 1, 2), size=(crop_h, crop_w),
                                 mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
        if back.shape[-1] != base.shape[-1]:
            back = back[..., :base.shape[-1]]

        m = mask[:, y0:y1, x0:x1].unsqueeze(-1).to(back.dtype)
        m = m * max(0.0, min(1.0, float(strength)))
        result = base.clone()
        crop = base[:, y0:y1, x0:x1, :]
        result[:, y0:y1, x0:x1, :] = crop * (1 - m) + back * m
        print(f"[RedNode Paint In] composited a {back.shape[2]} x {back.shape[1]} "
              f"render back through the mask; the rest of the picture is untouched",
              flush=True)
        return _out(result)


NODE_CLASS_MAPPINGS = {
    "RedNodePaintOut": RedNodePaintOut,
    "RedNodePaintIn": RedNodePaintIn,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RedNodePaintOut": "RedNode Paint Out (to any renderer)",
    "RedNodePaintIn": "RedNode Paint In (composite back)",
}
