"""RedNode Studio — a studio rig for ComfyUI: workspace panel, painting, control panels,
LoRA management and grading, plus Krea 2 moodboard and identity editing.

Nodes:
- Krea 2 Moodboard (moodboard.py): one-node vibe transfer — prompt + reference images in,
  conditioning out. Effects applied post-encode (strength, style/subject extract, crops, indirect,
  directives). Multiple refs/crops form separate vision spans (use indirect if outputs grid).
- Krea2 Moodboard Encode (this file): the packed-span variant — multiple references are packed into
  ONE vision span (structurally grid-safe, references blend jointly). Best as the `fuse_with` feeder.
- Krea 2 Identity Edit (identity.py): instruction-based identity-preserving editing for krea2_edit
  LoRAs (e.g. krea2_identity_edit_v1) — dual conditioning (in-context ref latents at RoPE frames
  1..N + image-grounded instruction), with a `fuse_with` input to fuse a moodboard conditioning in
  front (style from the moodboard, identity from the edit source).

Strength is an information knob, not a magnitude knob (per-token RMSNorms erase scaling): "style"
extract collapses spans toward a mean/±std statistics signature, "subject" whitens the statistics
away and keeps the token structure. Ported from the authors' Forge Neo implementation.
"""

import math
import os

import torch

import node_helpers

# Krea 2 support landed in ComfyUI on 2026-06-23. Most of this pack has nothing to do
# with Krea 2 (the Workspace, Save, Paint, Post, Review, LoRA Stack, Control Panel and
# the rest all work with any model), so an older ComfyUI must not take the whole pack
# down with it. Import failure here costs you the Krea 2 nodes and nothing else.
try:
    import comfy.text_encoders.krea2
    import comfy.text_encoders.qwen3vl
    from comfy.text_encoders.krea2 import KREA2_TEMPLATE, Krea2TEModel

    from .identity import Krea2IdentityEdit, fit_image_to_latent, krea2_template
    from .moodboard import Krea2Moodboard
    from .rebalance import Krea2Rebalance
    KREA2_AVAILABLE = True
    _KREA2_WHY = ""
except ImportError as _e:
    KREA2_AVAILABLE = False
    _KREA2_WHY = str(_e)
    # Named so the code below reads the same either way. Nothing that touches these is
    # ever registered when Krea 2 is missing, so none of them are reachable.
    KREA2_TEMPLATE = ""
    Krea2TEModel = None
    Krea2IdentityEdit = Krea2Moodboard = Krea2Rebalance = None
    fit_image_to_latent = krea2_template = None

STYLE_DIRECTIVE = (
    "The image uses only the art style, color palette, lighting, texture, rendering technique and "
    "overall mood of the reference images. The subjects, objects and composition of the image come "
    "from the following text description alone. "
)
SUBJECT_DIRECTIVE = (
    "The image depicts the same subjects, objects and composition as the reference images, "
    "rendered in the art style described by the following text. "
)
VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"

# Sizes of spliced vision spans, recorded in splice order during the current encode.
_SPAN_SIZES = []
# Moodboard transaction flag (set by set_flags): span recording and packed handling run
# ONLY inside an owned encode; every other Qwen3-VL user gets the stored stock path.
_MB_ACTIVE = False


# ---------------------------------------------------------------------------
# Patch 1: packed multi-image spans — Qwen3VL.preprocess_embed accepts a LIST of images and
# concatenates their tokens into one contiguous span (single image reference to the model).
# ---------------------------------------------------------------------------
def _build_preprocess_embed(_orig_unused):
    # The live original is always read from the class attribute the guard maintains —
    # never a closure — so version rebuilds and tests see one source of truth.
    def preprocess_embed(self, embed, device):
        orig = comfy.text_encoders.qwen3vl.Qwen3VL._rednode_orig_preprocess_embed
        if not _MB_ACTIVE:
            return orig(self, embed, device)
        data = embed.get("data", None)
        if isinstance(data, (list, tuple)):
            merged_all, deepstack_all, grids = [], [], []
            for img in data:
                merged, extra = orig(self, {"type": "image", "data": img, "original_type": "image"}, device)
                merged_all.append(merged)
                deepstack_all.append(extra["deepstack"] if isinstance(extra, dict) else None)
                grids.append(extra["grid"] if isinstance(extra, dict) else extra)
            merged = torch.cat(merged_all, dim=0)
            deepstack = None
            if deepstack_all and deepstack_all[0] is not None:
                deepstack = [torch.cat([ds[i] for ds in deepstack_all], dim=0) for i in range(len(deepstack_all[0]))]
            _SPAN_SIZES.append(merged.shape[0])
            # Re-review V2: the language-model pass consumes the grid for MRoPE positions, so a
            # single grids[0] would misposition packed images 2..N (that WAS the historical
            # behavior of every release so far). The per-subimage metadata below lets the guarded
            # build_image_inputs wrapper emit correct positions per packed subimage; grids[0]
            # remains as the legacy fallback (KREA2MB_LEGACY_PACKED_POSITIONS=1).
            return merged, {"grid": grids[0], "grids": grids,
                            "sizes": [m.shape[0] for m in merged_all],
                            "deepstacks": deepstack_all,
                            "deepstack": deepstack, "packed": True}

        merged, extra = orig(self, embed, device)
        if merged is not None:
            _SPAN_SIZES.append(merged.shape[0])
        return merged, extra
    return preprocess_embed


# Escape hatch for A/B against the historical (mispositioned) packed layout.
_LEGACY_PACKED_POSITIONS = os.environ.get("KREA2MB_LEGACY_PACKED_POSITIONS", "") == "1"


def _build_build_image_inputs(_orig_unused):
    """MRoPE fix (re-review V2): expand a packed multi-image span into per-subimage
    entries before the stock position/DeepStack builder runs, so every packed image gets
    positions from ITS OWN grid (identical to N separate images, minus the extra vision
    tokens). Non-packed entries and foreign callers pass through untouched."""
    def build_image_inputs(self, embeds, embeds_info):
        orig = comfy.text_encoders.qwen3vl.Qwen3VL._rednode_orig_build_image_inputs
        if _LEGACY_PACKED_POSITIONS:
            return orig(self, embeds, embeds_info)
        expanded, changed = [], False
        for e in embeds_info:
            ex = e.get("extra") if isinstance(e, dict) else None
            if (isinstance(e, dict) and e.get("type") == "image" and isinstance(ex, dict)
                    and ex.get("packed") and ex.get("grids") and ex.get("sizes")):
                idx = e.get("index", 0)
                dss = ex.get("deepstacks") or [None] * len(ex["grids"])
                for grid, rows, ds in zip(ex["grids"], ex["sizes"], dss):
                    sub = dict(e)
                    sub["index"], sub["size"] = idx, rows
                    sub["extra"] = {"grid": grid, "deepstack": ds}
                    expanded.append(sub)
                    idx += rows
                changed = True
            else:
                expanded.append(e)
        return orig(self, embeds, expanded if changed else embeds_info)
    return build_image_inputs


# ---------------------------------------------------------------------------
# Patch 2: moodboard effects inside Krea2's encode (pre-template-strip, spans known exactly).
# Controlled by attributes set on clip.cond_stage_model by the nodes; outside an owned
# moodboard transaction the STORED STOCK method runs (delegation, not a maintained copy).
# ---------------------------------------------------------------------------


def _apply_moodboard_effects(model, out, spans, extra):
    """out: (B, 12, seq, 2560) pre-strip. spans: [(start, end)] post-splice indices."""
    limit = getattr(model, "moodboard_span_limit", None)
    if limit is not None:
        spans = spans[:limit]
    if not spans:
        return out, extra

    if getattr(model, "moodboard_hide_refs", False):
        keep = torch.ones(out.shape[2], dtype=torch.bool, device=out.device)
        for start, end in spans:
            keep[start:end] = False
        out = out[:, :, keep]
        if "attention_mask" in extra:
            extra["attention_mask"] = extra["attention_mask"][:, keep]
        return out, extra

    strength = float(getattr(model, "moodboard_strength", 1.0))
    if strength >= 1.0:
        return out, extra
    strength = max(0.0, strength)

    joint = torch.cat([out[:, :, start:end] for start, end in spans], dim=2)
    mu = joint.mean(dim=2, keepdim=True)
    sigma = joint.std(dim=2, keepdim=True)

    if getattr(model, "moodboard_extract", "style") == "subject":
        safe_sigma = sigma.clamp_min(1e-4)
        for start, end in spans:
            span = out[:, :, start:end]
            whitened = (span - mu) / safe_sigma
            out[:, :, start:end] = whitened + strength * (span - whitened)
    else:
        for start, end in spans:
            span = out[:, :, start:end]
            n = span.shape[2]
            coef = torch.tensor([0.0, 1.0, -1.0], device=span.device, dtype=span.dtype).repeat((n + 2) // 3)[:n].view(1, 1, n, 1)
            target = mu + coef * sigma
            out[:, :, start:end] = target + strength * (span - target)
    return out, extra


def _build_encode_token_weights(_orig_unused):
    def encode_token_weights(self, token_weight_pairs, template_end=-1):
        if not getattr(self, "moodboard_active", False):
            return Krea2TEModel._rednode_orig_encode_token_weights(self, token_weight_pairs, template_end)
        return _moodboard_encode_token_weights(self, token_weight_pairs, template_end)
    return encode_token_weights


def _moodboard_encode_token_weights(self, token_weight_pairs, template_end=-1):
    _SPAN_SIZES.clear()
    out, pooled, extra = super(Krea2TEModel, self).encode_token_weights(token_weight_pairs)
    tok_pairs = token_weight_pairs["qwen3vl_4b"][0]

    import numbers

    # Strip index (original logic) — always resolves before the first image span.
    count_im_start = 0
    if template_end == -1:
        for i, v in enumerate(tok_pairs):
            elem = v[0]
            if not torch.is_tensor(elem) and isinstance(elem, numbers.Integral):
                if elem == 151644 and count_im_start < 2:
                    template_end = i
                    count_im_start += 1
        if out.shape[2] > (template_end + 3):
            if tok_pairs[template_end + 1][0] == 872:
                if tok_pairs[template_end + 2][0] == 198:
                    template_end += 3

    # Post-splice span positions: walk the (pre-splice) token pairs, expanding image entries by the
    # sizes recorded during preprocessing (same order).
    spans = []
    offset = 0
    sizes = iter(list(_SPAN_SIZES))
    for i, v in enumerate(tok_pairs):
        elem = v[0]
        if isinstance(elem, dict):
            n = next(sizes, 0)
            start = i + offset
            spans.append((start, start + n))
            offset += n - 1

    out, extra = _apply_moodboard_effects(self, out, spans, extra)

    out = out[:, :, template_end:]
    b, n, seq, h = out.shape
    out = out.permute(0, 2, 1, 3).reshape(b, seq, n * h)

    if "attention_mask" in extra:
        extra["attention_mask"] = extra["attention_mask"][:, template_end:]
        if extra["attention_mask"].sum() == torch.numel(extra["attention_mask"]):
            extra.pop("attention_mask")

    return out, pooled, extra


# Guarded install (roadmap phase E): idempotent, reload-safe, ABI-preflighted,
# all-or-nothing for the moodboard feature's two TE patch sites.
from ._patchguard import VERSION as _PG_VERSION, install_all as _pg_install  # noqa: E402

# Nothing to patch when the text encoder is not there to patch
_TE_PATCH_OK = _pg_install([
    (comfy.text_encoders.qwen3vl.Qwen3VL, "preprocess_embed", "_rednode_orig_preprocess_embed",
     _build_preprocess_embed, [["self", "embed", "device"]]),
    (Krea2TEModel, "encode_token_weights", "_rednode_orig_encode_token_weights",
     _build_encode_token_weights, [["self", "token_weight_pairs"]]),
    (comfy.text_encoders.qwen3vl.Qwen3VL, "build_image_inputs", "_rednode_orig_build_image_inputs",
     _build_build_image_inputs, [["self", "embeds", "embeds_info"]]),
]) if KREA2_AVAILABLE else False


# ---------------------------------------------------------------------------
# Packed-span moodboard node
# ---------------------------------------------------------------------------
def expand_style_crops(images, n=2):
    orders = {
        2: (2, 0, 3, 1),
        4: (10, 3, 12, 5, 0, 15, 6, 9, 2, 13, 4, 11, 8, 1, 14, 7),
    }
    order = orders.get(n) or tuple(range(n * n))
    crops = []
    for image in images:
        h, w = image.shape[1] // n, image.shape[2] // n
        grid = [image[:, r * h:(r + 1) * h, c * w:(c + 1) * w] for r in range(n) for c in range(n)]
        crops.extend(grid[i] for i in order)
    return crops


def resize_area(image, total_px, never_upscale=False):
    samples = image.movedim(-1, 1)
    scale_by = math.sqrt(total_px / (samples.shape[3] * samples.shape[2]))
    if never_upscale:
        scale_by = min(1.0, scale_by)
    height = max(32, round(samples.shape[2] * scale_by))
    width = max(32, round(samples.shape[3] * scale_by))
    samples = torch.nn.functional.interpolate(samples, size=(height, width), mode="area")
    return samples.movedim(1, -1)[:, :, :, :3]


def set_flags(clip, strength=1.0, hide=False, extract="style", span_limit=None, active=False):
    global _MB_ACTIVE
    model = clip.cond_stage_model
    model.moodboard_strength = strength
    model.moodboard_hide_refs = hide
    model.moodboard_extract = extract
    model.moodboard_span_limit = span_limit
    model.moodboard_active = active
    _MB_ACTIVE = active


REF_MODES = ["full image", "quadrant crops (2x2)", "fine tiles (4x4)"]


class Krea2MoodboardEncode:
    """Packed-span moodboard: all references share ONE vision span (grid-safe, joint blending).
    Leave the prompt empty when feeding Krea 2 Identity Edit's `fuse_with` input."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                                       "tooltip": "1.0 = raw reference detail; lower = purer extract of the selected aspect"}),
                "extract": (["style / vibe", "subject / concept"],),
                "reference_processing": (REF_MODES,),
                "style_directive": ("BOOLEAN", {"default": True}),
                "indirect": ("BOOLEAN", {"default": False, "tooltip": "hide reference tokens from the DiT: style arrives only via prompt re-contextualization; poses/subjects cannot be copied directly (a small residual influence via the re-contextualized prompt can remain)"}),
                "position": (["before prompt", "after prompt"],),
                "budget_px": ("INT", {"default": 384, "min": 128, "max": 1536, "step": 64,
                                      "tooltip": "area budget per reference fed to the vision encoder"}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "reference images (batch them for multiple); leave unconnected for a plain Krea 2 text encode"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "RedNode/Krea 2"
    DESCRIPTION = "Moodboard conditioning with all references packed into one vision span. Use standalone (with prompt) or as the fuse_with feeder for Krea 2 Identity Edit (empty prompt)."

    def encode(self, clip, prompt, strength, extract, reference_processing, style_directive, indirect, position, budget_px, images=None):
        if images is None or images.shape[0] == 0:
            # no references connected: behave exactly like a plain Krea 2 text encode
            tokens = clip.tokenize(prompt, llama_template=KREA2_TEMPLATE)
            conditioning = clip.encode_from_tokens_scheduled(tokens)
            return (node_helpers.conditioning_set_values(conditioning, {"krea2_template_tail": 5}),)
        refs = [images[i:i + 1] for i in range(images.shape[0])]
        crops_n = 4 if "4x4" in reference_processing else 2 if "2x2" in reference_processing else 0
        total = int(budget_px) * int(budget_px)
        if crops_n:
            refs = expand_style_crops(refs, n=crops_n)
            total = total // (3 if crops_n == 2 else 12)
        refs = [resize_area(r, total, never_upscale=(budget_px >= 1024)) for r in refs]

        extract_key = "subject" if extract.startswith("subject") else "style"
        directive = ""
        if style_directive:
            directive = SUBJECT_DIRECTIVE if extract_key == "subject" else STYLE_DIRECTIVE

        if position == "after prompt":
            text = prompt + (" " + directive if directive else "") + VISION_BLOCK
        else:
            text = VISION_BLOCK + directive + prompt

        print(f"[Krea2 Moodboard Encode] encoding ({len(refs)} ref(s)): {text[:120]!r}")
        set_flags(clip, strength=float(strength), hide=bool(indirect), extract=extract_key, span_limit=None, active=True)
        try:
            tokens = clip.tokenize(text, images=[refs], llama_template=KREA2_TEMPLATE)
            conditioning = clip.encode_from_tokens_scheduled(tokens)
        finally:
            set_flags(clip)
        # provenance: ends with the standard 5-row Krea 2 template tail (fuse_with contract)
        conditioning = node_helpers.conditioning_set_values(conditioning, {"krea2_template_tail": 5})
        return (conditioning,)


class Krea2EditSourceChain:
    """Chainable identity/reference source. Each node appends one image to the list; connect the
    output to the next chain node's `sources` (or to the `sources` input on Krea 2 Identity Edit /
    Moodboard + Identity Fusion). Sources become in-context frames 1..N in chain order.

    NOTE: the krea2_identity_edit LoRA trained on 1-2 references — with 3+ the plumbing works but
    identities may blend (the LoRA author's multi-person recipe is chaining EDIT PASSES instead:
    place person A, then run a second edit adding person B)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "optional": {"sources": ("KREA2_SOURCES", {"tooltip": "previous chain link"})},
        }

    RETURN_TYPES = ("KREA2_SOURCES",)
    FUNCTION = "chain"
    CATEGORY = "RedNode/Krea 2"
    DESCRIPTION = "Appends one reference image to a chainable source list for multi-reference identity editing."

    def chain(self, image, sources=None):
        out = list(sources) if sources else []
        out.append(image)
        return (out,)


class Krea2MoodboardIdentityFusion:
    """Single-encode fusion: moodboard style + identity-edit source in ONE LLM pass, exactly like
    the Forge Neo implementation. Because the instruction and the edit grounding attend the
    moodboard span inside the encoder, `indirect` genuinely works here (unlike feeding a separate
    moodboard encode into `fuse_with`, where deleting rows deletes all image influence).

    Use for the KSampler POSITIVE; keep the negative a Krea 2 Identity Edit with an EMPTY prompt
    and the same source image. Requires a krea2_edit LoRA at strength 1.0 on the model."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "instruction": ("STRING", {"multiline": True, "default": "",
                                           "tooltip": "the edit instruction, e.g. 'create a photo of this person at a night market'"}),
                "strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05}),
                "extract": (["style / vibe", "subject / concept"],),
                "reference_processing": (REF_MODES,),
                "style_directive": ("BOOLEAN", {"default": True}),
                "indirect": ("BOOLEAN", {"default": True, "tooltip": "delete moodboard rows after encoding; style survives via in-encoder attention. Safest when style refs contain people."}),
                "budget_px": ("INT", {"default": 384, "min": 128, "max": 1536, "step": 64}),
                "grounding_px": ("INT", {"default": 768, "min": 0, "max": 2048, "step": 32,
                                         "tooltip": "longest-side cap for the edit source fed to the encoder"}),
            },
            "optional": {
                "edit_source": ("IMAGE", {"tooltip": "identity source image. Not connected = pure moodboard mode."}),
                "moodboard_images": ("IMAGE", {"tooltip": "style references (batch for several). Not connected = pure identity-edit mode."}),
                "vae": ("VAE", {"tooltip": "connect to attach the in-context identity latents (required for actual editing)"}),
                "edit_source2": ("IMAGE", {"tooltip": "2nd reference for two-ref LoRAs (scene first, subject second)"}),
                "sources": ("KREA2_SOURCES", {"tooltip": "chained sources (Krea2 Edit Source Chain) — inserted BETWEEN edit_source (scene) and edit_source2 (subject), so the subject stays the LAST ref and keeps the boost/mask dials. 3+ refs is beyond the LoRA's training; identities may blend."}),
                "ref_boost": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05, "round": 0.001,
                                        "tooltip": "reference-fidelity dial: multiplies target->reference attention for the LAST identity ref (the subject). 1.0 = off; >1 pulls harder toward the reference (the v1.2 edit-LoRA author suggests 2-6). Positive only — the moodboard span is unaffected."}),
                "ref_boost_a": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05, "round": 0.001,
                                          "tooltip": "same dial for the earlier identity refs (the scene in two-ref workflows). No effect single-ref. 1.0 = off"}),
                "target_latent": ("LATENT", {"tooltip": "connect your (empty) sampling latent to enable the v1.2 'fit' geometry: identity refs are fitted in PIXEL space to the output resolution before VAE-encoding — fixes blur from resolution mismatch and removes the match-the-aspect-ratio requirement. With CFG > 1, connect the same latent to the negative edit node too."}),
                "fit_mode": (["fit", "crop (legacy)"], {"default": "fit",
                             "tooltip": "how identity refs fit a mismatched output AR (needs target_latent + vae): fit = resample to the target grid at a centered offset (v1.2-trained geometry); crop (legacy) = center-crop to the target AR then resize (v1/v1.1 geometry, for older weights)."}),
                "ref_boost_mask": ("MASK", {"tooltip": "optional region on the LAST (subject) edit source to boost, e.g. just the face — identity boost without over-copying the scene"}),
                "ref_start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                              "tooltip": "when the identity refs become active (0 = first step). Start later to free composition before identity locks in."}),
                "ref_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                            "tooltip": "when the identity refs switch off (1 = last step)."}),
                "edit_mask": ("MASK", {"tooltip": "hard edit locality: white = the region the model may change. Everywhere else the FIRST edit source is re-imposed at each denoising step, so untouched areas stay pixel-faithful instead of relying on the LoRA. Needs the source on the target grid (matched output AR, or fit_mode 'crop (legacy)'). With CFG > 1 wire the SAME mask to the negative edit node too."}),
                "edit_mask_feather": ("INT", {"default": 2, "min": 0, "max": 32,
                                     "tooltip": "soft edge for edit_mask, in latent pixels (1 latent px ≈ 8 image px); 0 = hard edge"}),
                "isolate_refs": ("BOOLEAN", {"default": False,
                                 "tooltip": "multi-ref only: stop the identity references attending to EACH OTHER — reduces identity/style bleed between two people. No effect with a single reference."}),
                "boost_blocks": (["all", "early", "mid", "late"], {"default": "all",
                                 "tooltip": "experimental: restrict the ref_boost dials to a depth range of the DiT. early = composition/pose-leaning pull, late = texture/detail-leaning pull, all = normal. Combines with ref_boost_mask and the ref_start/ref_end window."}),
                "grounding_px_subject": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 32,
                                        "tooltip": "separate grounding cap for the 2nd+ edit sources (the subject in two-ref order often deserves 1024+ while the scene doesn't). 0 = use grounding_px for all refs."}),
                "picture_labels": ("BOOLEAN", {"default": False,
                                   "tooltip": "EXPERIMENTAL training-parity toggle: 'Picture N: ' prefixes on the vision blocks (ai-toolkit layout; the packed moodboard counts as Picture 1, edit sources follow). Default off. Match the negative node; A/B before adopting."}),
                "ref_t0_modulation": ("BOOLEAN", {"default": False,
                                      "tooltip": "EXPERIMENTAL training-parity toggle: modulate the clean reference tokens at timestep 0 (as ai-toolkit trains). Default off. Match the negative node; A/B before adopting."}),
                "system_prompt": ("STRING", {"multiline": True, "default": "",
                                  "tooltip": "ADVANCED: override the vision system prompt (empty = training default). Steers HOW the encoder reads ALL references (moodboard + edit sources) — e.g. domain-neutral identity reading for anime→real. Match the negative node; A/B."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "RedNode/Krea 2"
    DESCRIPTION = "Moodboard style + identity edit fused in a single encode (Neo-parity). Both image inputs are optional: ID only = plain identity edit, moodboard only = plain vibe transfer, both = fusion. Positive only; negative = Krea 2 Identity Edit with empty prompt + same image."

    def encode(self, clip, instruction, strength, extract, reference_processing, style_directive, indirect, budget_px, grounding_px, edit_source=None, moodboard_images=None, vae=None, edit_source2=None, sources=None,
               ref_boost=1.0, ref_boost_a=1.0, target_latent=None, fit_mode="fit", ref_boost_mask=None,
               ref_start=0.0, ref_end=1.0, edit_mask=None, edit_mask_feather=2, isolate_refs=False,
               boost_blocks="all", grounding_px_subject=0, picture_labels=False, ref_t0_modulation=False,
               system_prompt="", attention="auto"):
        import comfy.utils
        import node_helpers

        # moodboard side (optional): crops + area budget, packed into one span
        refs = []
        if moodboard_images is not None and moodboard_images.shape[0] > 0:
            refs = [moodboard_images[i:i + 1] for i in range(moodboard_images.shape[0])]
            crops_n = 4 if "4x4" in reference_processing else 2 if "2x2" in reference_processing else 0
            total = int(budget_px) * int(budget_px)
            if crops_n:
                refs = expand_style_crops(refs, n=crops_n)
                total = total // (3 if crops_n == 2 else 12)
            refs = [resize_area(r, total, never_upscale=(budget_px >= 1024)) for r in refs]

        extract_key = "subject" if extract.startswith("subject") else "style"
        directive = ""
        if refs and style_directive:
            directive = SUBJECT_DIRECTIVE if extract_key == "subject" else STYLE_DIRECTIVE

        # edit side (optional): grounding images + in-context ref latents. Order: scene first,
        # chained extras in the middle, the designated SUBJECT LAST — the boost/mask dials
        # always target the last ref, so chained extras can never steal the subject's dials.
        chain = list(sources) if sources else []
        if edit_source2 is not None:
            all_sources = [edit_source] + chain + [edit_source2]
        else:
            all_sources = [edit_source] + chain
        n_refs = sum(1 for s in all_sources if s is not None)
        if n_refs and vae is None:
            raise ValueError(
                "Krea 2 Fusion: connect the 'vae' input (your Krea 2 / qwen_image VAE). It encodes the edit "
                "source into the in-context identity latents - without it there is no identity preservation.")
        if n_refs == 0:
            if target_latent is not None:
                print("[Krea2 Fusion] note: target_latent has no effect without an edit source")
            if ref_boost != 1.0 or ref_boost_a != 1.0:
                print("[Krea2 Fusion] note: ref_boost has no effect without an edit source")
            if edit_mask is not None:
                print("[Krea2 Fusion] note: edit_mask has no effect without an edit source")
        if n_refs > 2:
            print(f"[Krea2 Fusion] {n_refs} identity references - the edit LoRA trained on 1-2; expect identity blending beyond that")
        edit_images = []
        ref_latents = []
        edit_blocks = ""
        for img in all_sources:
            if img is None:
                continue
            if img.shape[0] > 1:
                print(f"[Krea2 Fusion] edit-source batch of {img.shape[0]} - using frame 1 (batch the moodboard_images input for multiple style refs)")
            samples = img[:1].movedim(-1, 1)
            h, w = samples.shape[2], samples.shape[3]
            # per-ref grounding: refs after the first (the subject in two-ref order) may get
            # their own cap — the subject often deserves 1024+ while the scene doesn't.
            gpx = grounding_px if not edit_images else (grounding_px_subject or grounding_px)
            if gpx and max(h, w) > gpx:
                scale_by = gpx / max(h, w)
                samples = comfy.utils.common_upscale(samples, round(w * scale_by), round(h * scale_by), "area", "disabled")
            edit_images.append(samples.movedim(1, -1)[:, :, :, :3])
            if vae is not None:
                if target_latent is not None:
                    # v1.2 pixel-space path: fit the IMAGE to the output grid, then encode —
                    # the DiT never resizes these latents (blur-proof, AR-safe).
                    lh, lw = target_latent["samples"].shape[-2:]
                    mode = "crop" if fit_mode.startswith("crop") else "fit"
                    ref_latents.append(vae.encode(fit_image_to_latent(img[:1], lh, lw, mode)))
                else:
                    ref_latents.append(vae.encode(img[:1, :, :, :3]))
            # training-parity labels: packed moodboard = Picture 1, edit sources continue
            n_pic = (1 if refs else 0) + len(edit_images)
            edit_blocks += (f"Picture {n_pic}: " if picture_labels else "") + VISION_BLOCK

        mb_block = (("Picture 1: " if picture_labels else "") + VISION_BLOCK) if refs else ""
        text = mb_block + directive + edit_blocks + instruction
        images = ([refs] if refs else []) + edit_images  # span 1 = packed moodboard (if any); then edit grounding

        # Moodboard effects apply only to the leading moodboard span. With edit grounding present,
        # limit to that one span; moodboard-only mode covers all (its single) spans; edit-only or
        # text-only mode disables effects entirely so the grounding stays raw.
        if refs:
            span_limit = 1 if edit_images else None
        else:
            span_limit = 0

        print(f"[Krea2 Fusion] encoding ({len(refs)} mb ref(s), {len(edit_images)} edit ref(s)): {text[:120]!r}")
        set_flags(clip, strength=float(strength), hide=bool(indirect), extract=extract_key, span_limit=span_limit, active=True)
        try:
            try:
                template = krea2_template(system_prompt)
                tokens = clip.tokenize(text, images=images, llama_template=template) if images else clip.tokenize(text, llama_template=template)
            except ValueError:
                raise
            except Exception as e:
                raise ValueError(
                    "Krea 2 Fusion: this CLIP cannot encode Krea 2 image prompts. Load the qwen3vl_4b "
                    f"(vision) text encoder with CLIPLoader type 'krea2'. (inner error: {e})") from e
            if "qwen3vl_4b" not in tokens:
                raise ValueError(
                    "Krea 2 Fusion: wrong text-encoder type - load the qwen3vl_4b text encoder with "
                    f"CLIPLoader type 'krea2' (this CLIP produced: {', '.join(tokens)})")
            conditioning = clip.encode_from_tokens_scheduled(tokens)
        finally:
            set_flags(clip)

        # provenance: standard 5-row template tail + label policy (fuse_with contract)
        conditioning = node_helpers.conditioning_set_values(
            conditioning, {"krea2_template_tail": 5, "krea2_picture_labels": bool(picture_labels)})
        if ref_latents:
            extra = {"reference_latents": ref_latents,
                     "reference_fit": [target_latent is not None] * len(ref_latents)}
            boosts = [ref_boost_a] * (len(ref_latents) - 1) + [ref_boost]
            if any(b != 1.0 for b in boosts):
                extra["reference_boosts"] = boosts
            conditioning = node_helpers.conditioning_set_values(conditioning, extra, append=True)
            if ref_boost_mask is not None:
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_boost_mask": ref_boost_mask})
            if target_latent is not None:
                lh, lw = target_latent["samples"].shape[-2:]
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_target_grid": [int(lh), int(lw)]})
            if ref_start >= ref_end:
                print(f"[Krea2 Fusion] WARNING: ref_start ({ref_start}) >= ref_end ({ref_end}) - "
                      "the refs would NEVER be active. Ignoring the window (refs stay on every step).")
            elif ref_start > 0.0 or ref_end < 1.0:
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_timing": [float(ref_start), float(ref_end)]})
            if isolate_refs:
                if len(ref_latents) > 1:
                    conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_isolate": True})
                else:
                    print("[Krea2 Fusion] note: isolate_refs has no effect with a single reference")
            if boost_blocks != "all":
                if any(b != 1.0 for b in boosts):
                    conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_boost_blocks": boost_blocks})
                else:
                    print("[Krea2 Fusion] note: boost_blocks set but the ref_boost dials are 1.0 - nothing to restrict")
            if edit_mask is not None:
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_edit_mask": edit_mask,
                                   "reference_edit_feather": int(edit_mask_feather)})
            if ref_t0_modulation:
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_t0": True})
            if attention and attention != "auto":
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_attention": attention})
        return (conditioning,)


from .rednode import (Krea2RedNode, Krea2RedNodeSettings,  # noqa: E402  (needs the fusion class above)
                      Krea2RedNodePresetSave, Krea2RedNodePresetLoad)
from .prompt_tools import RedNodePromptCombine, RedNodePromptSwap  # noqa: E402
from .text_combine import RedNodeTextCombine  # noqa: E402
from .prompt_box import RedNodePromptBox  # noqa: E402
from .selector import RedNodeSelector  # noqa: E402
from .combo_control import RedNodeComboControl  # noqa: E402
from .control_panel import RedNodeControlPanel  # noqa: E402
from .note import RedNodeNote  # noqa: E402
from .note_panel import RedNodeNotePanel  # noqa: E402
from .report import RedNodeReport  # noqa: E402
from .group_modes import RedNodeGroupModes  # noqa: E402
from .prompt_library import RedNodePromptKeywords  # noqa: E402  (also registers the HTTP API)
from . import wildcards as _rednode_wildcards  # noqa: E402,F401  (registers the wildcard HTTP API)
from .refiner import RedNodeRefineCrop, RedNodeRefinePaste  # noqa: E402
from .lora_stack import RedNodeLoraStack, RedNodeLoraStackSave  # noqa: E402
from .group_control import RedNodeGroupControl  # noqa: E402
from .switch import RedNodeSwitch  # noqa: E402
from .router import RedNodeRouter  # noqa: E402
from .router_control import RedNodeRouterControl  # noqa: E402
from .palette import RedNodePalette  # noqa: E402
from .pass_through import RedNodePass  # noqa: E402
from .workspace import RedNodeStudioWorkspace  # noqa: E402
from .review import RedNodeImageReview  # noqa: E402
from .sampler_config import RedNodeSamplerConfig  # noqa: E402
from .postprocess import RedNodePostProcess, RedNodePostFX  # noqa: E402
from .stages import RedNodeStageTap, RedNodeStageView  # noqa: E402
from .paint_render import RedNodePaintRender  # noqa: E402
from .paint_bridge import RedNodePaintOut, RedNodePaintIn  # noqa: E402
from .save_node import RedNodeSave  # noqa: E402
from . import settings as _rednode_settings  # noqa: F401,E402  (settings routes)
from .vram import RedNodeFreeVRAM  # noqa: E402  (also registers the renderer-switch route)
from . import automask as _rednode_automask  # noqa: F401,E402  (auto-mask route)
from .group_rules import RedNodeGroupRules  # noqa: E402  (also registers its routes)
from .subgraph_bridge import (RedNodeSubgraphSend,  # noqa: E402
                              RedNodeSubgraphReceive, RedNodeChannelConvert)
from . import lora_info  # noqa: F401,E402  (registers the Civitai lookup route)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "RedNodePromptCombine": RedNodePromptCombine,
    "RedNodeTextCombine": RedNodeTextCombine,
    "RedNodePromptSwap": RedNodePromptSwap,
    "RedNodePromptBox": RedNodePromptBox,
    "RedNodeSelector": RedNodeSelector,
    "RedNodeComboControl": RedNodeComboControl,
    "RedNodeControlPanel": RedNodeControlPanel,
    "RedNodeNote": RedNodeNote,
    "RedNodeNotePanel": RedNodeNotePanel,
    "RedNodeReport": RedNodeReport,
    "RedNodeGroupModes": RedNodeGroupModes,
    "RedNodePromptKeywords": RedNodePromptKeywords,
    "RedNodeRefineCrop": RedNodeRefineCrop,
    "RedNodeRefinePaste": RedNodeRefinePaste,
    "RedNodeLoraStack": RedNodeLoraStack,
    "RedNodeLoraStackSave": RedNodeLoraStackSave,
    "RedNodeGroupControl": RedNodeGroupControl,
    "RedNodeSwitch": RedNodeSwitch,
    "RedNodeRouter": RedNodeRouter,
    "RedNodeRouterControl": RedNodeRouterControl,
    "RedNodePalette": RedNodePalette,
    "RedNodePass": RedNodePass,
    "RedNodeFreeVRAM": RedNodeFreeVRAM,
    "RedNodeStudioWorkspace": RedNodeStudioWorkspace,
    "RedNodeImageReview": RedNodeImageReview,
    "RedNodeSamplerConfig": RedNodeSamplerConfig,
    "RedNodePostProcess": RedNodePostProcess,
    "RedNodePostFX": RedNodePostFX,
    "RedNodePaintOut": RedNodePaintOut,
    "RedNodePaintIn": RedNodePaintIn,
    "RedNodeSave": RedNodeSave,
    "RedNodeGroupRules": RedNodeGroupRules,
    "RedNodeSubgraphSend": RedNodeSubgraphSend,
    "RedNodeSubgraphReceive": RedNodeSubgraphReceive,
    "RedNodeChannelConvert": RedNodeChannelConvert,
    "RedNodeStageTap": RedNodeStageTap,
    "RedNodeStageView": RedNodeStageView,
    "RedNodePaintRender": RedNodePaintRender,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RedNodePromptCombine": "RedNode Prompt Combine",
    "RedNodeTextCombine": "RedNode Text Combine",
    "RedNodePromptSwap": "RedNode Prompt Converter",
    "RedNodePromptBox": "RedNode Prompt Box",
    "RedNodeSelector": "RedNode Selector",
    "RedNodeComboControl": "RedNode Combo Control",
    "RedNodeControlPanel": "RedNode Control Panel",
    "RedNodeNote": "RedNode Note",
    "RedNodeNotePanel": "RedNode Note Panel",
    "RedNodeReport": "RedNode Report",
    "RedNodeGroupModes": "RedNode Group Modes",
    "RedNodePromptKeywords": "RedNode Prompt Keywords",
    "RedNodeRefineCrop": "RedNode Refine Crop",
    "RedNodeRefinePaste": "RedNode Refine Paste",
    "RedNodeLoraStack": "RedNode LoRA Stack",
    "RedNodeLoraStackSave": "RedNode LoRA Stack Save",
    "RedNodeGroupControl": "RedNode Group Control",
    "RedNodeSwitch": "RedNode Switch",
    "RedNodeRouter": "RedNode Router (advanced switch)",
    "RedNodeRouterControl": "RedNode Router Control",
    "RedNodePalette": "RedNode Palette",
    "RedNodePass": "RedNode Pass (colour trigger)",
    "RedNodeFreeVRAM": "RedNode Free VRAM",
    "RedNodeStudioWorkspace": "RedNode Studio Workspace",
    "RedNodeImageReview": "RedNode Image Review",
    "RedNodeSamplerConfig": "RedNode Sampler Config (auto turbo)",
    "RedNodePostProcess": "RedNode Post Process",
    "RedNodePostFX": "RedNode Post FX (standalone)",
    "RedNodePaintOut": "RedNode Paint Out (to any renderer)",
    "RedNodePaintIn": "RedNode Paint In (composite back)",
    "RedNodeSave": "RedNode Save",
    "RedNodeGroupRules": "RedNode Group Rules",
    # SENDER and GRABBER, not "Channel Out" and "Channel In". The old pair read
    # backwards at a glance: the one named "Out" is the one you wire values INTO,
    # and the one named "In" is the one that feeds values back out to other nodes,
    # which is the opposite of what the words suggest. The CLASS names are
    # deliberately untouched, so every saved workflow keeps working: a workflow
    # stores the class name, never the display name.
    "RedNodeSubgraphSend": "RedNode Sender",
    "RedNodeSubgraphReceive": "RedNode Grabber",
    "RedNodeChannelConvert": "RedNode Channel Convert",
    "RedNodeStageTap": "RedNode Stage Tap",
    "RedNodeStageView": "RedNode Stage View",
    "RedNodePaintRender": "RedNode Paint Render",
}

# The Krea 2 nodes, registered only when this ComfyUI can run them. Listing a node that
# cannot work is worse than not listing it: it loads into a workflow, then fails at
# queue time with an error about a text encoder the user has never heard of.
KREA2_ONLY_NODES = (
    "Krea2RedNode", "Krea2RedNodeSettings", "Krea2RedNodePresetSave",
    "Krea2RedNodePresetLoad", "Krea2Moodboard", "Krea2MoodboardEncode",
    "Krea2IdentityEdit", "Krea2MoodboardIdentityFusion", "Krea2EditSourceChain",
    "Krea2Rebalance",
)
if KREA2_AVAILABLE:
    NODE_CLASS_MAPPINGS.update({
        "Krea2RedNode": Krea2RedNode,
        "Krea2RedNodeSettings": Krea2RedNodeSettings,
        "Krea2RedNodePresetSave": Krea2RedNodePresetSave,
        "Krea2RedNodePresetLoad": Krea2RedNodePresetLoad,
        "Krea2Moodboard": Krea2Moodboard,
        "Krea2MoodboardEncode": Krea2MoodboardEncode,
        "Krea2IdentityEdit": Krea2IdentityEdit,
        "Krea2MoodboardIdentityFusion": Krea2MoodboardIdentityFusion,
        "Krea2EditSourceChain": Krea2EditSourceChain,
        "Krea2Rebalance": Krea2Rebalance,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "Krea2RedNode": "RedNode Studio (Krea 2)",
        "Krea2RedNodeSettings": "RedNode Studio Settings (Advanced)",
        "Krea2RedNodePresetSave": "RedNode Studio Preset Save",
        "Krea2RedNodePresetLoad": "RedNode Studio Preset Load",
        "Krea2Moodboard": "Krea 2 Moodboard",
        "Krea2MoodboardEncode": "Krea 2 Moodboard Encode (packed)",
        "Krea2IdentityEdit": "Krea 2 Identity Edit",
        "Krea2MoodboardIdentityFusion": "Krea 2 Moodboard + Identity Fusion",
        "Krea2EditSourceChain": "Krea2 Edit Source Chain",
        "Krea2Rebalance": "Krea 2 Conditioning Rebalance",
    })

# One-line startup diagnostic (phase E): which guarded patch sets are live.
if KREA2_AVAILABLE:
    from .identity import _PATCH_OK as _ID_PATCH_OK  # noqa: E402

    print(f"[RedNode Krea2] patch guard v{_PG_VERSION}: "
          f"identity={'ok' if _ID_PATCH_OK else 'DISABLED'}, "
          f"moodboard={'ok' if _TE_PATCH_OK else 'DISABLED'}", flush=True)
else:
    _ID_PATCH_OK = False
    print(f"[RedNode Krea2] This ComfyUI has no Krea 2 support, so the "
          f"{len(KREA2_ONLY_NODES)} Krea 2 nodes are unavailable ({_KREA2_WHY}). The other "
          f"{len(NODE_CLASS_MAPPINGS)} nodes loaded normally and work with any model. "
          f"Krea 2 arrived in ComfyUI on 2026-06-23: update ComfyUI to get them.",
          flush=True)
