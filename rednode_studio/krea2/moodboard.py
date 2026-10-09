"""Krea 2 Moodboard (vibe transfer) for ComfyUI.

Reference images are encoded through Qwen3-VL into the Krea 2 conditioning, then the
vision-token rows are post-processed to control WHAT transfers:

- strength: 1.0 keeps full reference detail (layout/pose can leak); lower values collapse
  the rows toward per-reference statistics (a mean / mean+std / mean-std token cycle),
  keeping palette/texture/mood while dropping spatial detail. Plain magnitude scaling does
  nothing here (RMSNorms erase it) -- spatial-detail collapse is the working lever.
- extract "style": channel statistics over the span = the look (palette/lighting/texture).
- extract "subject": whitening (v - mean) / std removes the style statistics and keeps the
  token structure = subject/composition; the text prompt then controls the look.
- indirect: the vision rows are DELETED after the LLM pass -- the DiT never sees reference
  tokens, style arrives only through how the refs re-contextualized the prompt tokens.
  Strongest anti-content-leak mode (and the safe mode for crops / multiple references).
- reference processing: 2x2 shuffled crops kill composition but keep object-level content;
  4x4 tiles are small enough that subjects are mostly never encoded at all.

Ported from the verified sd-forge-krea2-moodboard mechanics. NOTE: unlike the Neo port,
multiple references (and crops) become SEPARATE vision spans here, which Krea 2 can read
as "an image containing N pictures" and produce grid outputs -- if you see grids, enable
`indirect` (deleted spans cannot grid) or use a single full reference.
"""

import torch

import comfy.utils
import node_helpers
from comfy.text_encoders.krea2 import KREA2_TEMPLATE
from comfy.text_encoders import qwen_vl

VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"
IM_START, USER, NEWLINE = 151644, 872, 198
VISION_START = 151652

STYLE_DIRECTIVE = (" Use the reference image only as a style guide: adopt its color palette,"
                   " lighting, texture, tone and overall mood, but do not copy its subjects,"
                   " people, objects, layout or composition. ")
SUBJECT_DIRECTIVE = (" Use the reference image as a subject guide: depict the same subject and"
                     " composition, while the text description controls the style, medium and"
                     " look. ")

# Shuffle orders: adjacent tiles never stay adjacent, so composition cannot survive.
CROP_ORDERS = {
    2: (2, 0, 3, 1),
    4: (10, 3, 12, 5, 0, 15, 6, 9, 2, 13, 4, 11, 8, 1, 14, 7),
}


def _expand_style_crops(images, n):
    crops = []
    order = CROP_ORDERS.get(n) or tuple(range(n * n))
    for image in images:
        h, w = image.shape[1] // n, image.shape[2] // n
        grid = [image[:, r * h:(r + 1) * h, c * w:(c + 1) * w] for r in range(n) for c in range(n)]
        crops.extend(grid[i] for i in order)
    return crops


def _image_token_rows(data):
    # Same math the TE uses when it expands an <|image_pad|> into embed rows.
    _, grid = qwen_vl.process_qwen2vl_images(data, patch_size=16,
                                             image_mean=[0.5, 0.5, 0.5], image_std=[0.5, 0.5, 0.5])
    return int(torch.prod(torch.tensor(grid)).item()) // 4


def _vision_spans_after_strip(tok_pairs):
    """Map each vision span to post-template-strip row indices.

    Walks the token list accumulating output rows (1 per text token, grid/4 per image),
    replicating the Krea2 TE's system+user prefix strip so indices line up with the
    conditioning tensor rows."""
    spans = []
    rows = 0
    template_end = -1
    count_im_start = 0
    ids = []
    for v in tok_pairs:
        elem = v[0]
        if isinstance(elem, dict):
            n = _image_token_rows(elem["data"])
            spans.append((rows, rows + n))
            ids.append(None)
            rows += n
        else:
            tid = int(elem) if not torch.is_tensor(elem) else -1
            if tid == IM_START and count_im_start < 2:
                template_end = rows
                count_im_start += 1
            ids.append(tid)
            rows += 1
    if template_end >= 0 and len(ids) > (template_end + 3):
        if ids[template_end + 1] == USER and ids[template_end + 2] == NEWLINE:
            template_end += 3
    template_end = max(template_end, 0)
    return [(max(s - template_end, 0), e - template_end) for s, e in spans if e > template_end]


def _apply_moodboard(cond, spans, strength, extract, indirect):
    b, seq, fused = cond.shape
    z = cond.reshape(b, seq, 12, fused // 12).clone()
    keep = torch.ones(seq, dtype=torch.bool)
    for start, end in spans:
        end = min(end, seq)
        if end <= start:
            continue
        if indirect:
            keep[start:end] = False
            continue
        span = z[:, start:end]                                   # (B, rows, 12, 2560)
        mu = span.mean(dim=1, keepdim=True)
        sigma = span.std(dim=1, keepdim=True) + 1e-6
        if extract == "subject":
            target = (span - mu) / sigma
        else:
            stats = torch.cat([mu, mu + sigma, mu - sigma], dim=1)   # (B, 3, 12, 2560)
            idx = torch.arange(end - start, device=span.device) % 3
            target = stats[:, idx]
        z[:, start:end] = strength * span + (1.0 - strength) * target
    z = z.reshape(b, seq, fused)
    if indirect:
        z = z[:, keep]
    return z


class Krea2Moodboard:
    """Krea-style vibe transfer for Krea 2. Feeds the KSampler's positive input;
    keep the negative a plain empty encode."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                                       "tooltip": "1.0 = full reference detail (layout/pose can leak); lower = keep palette/texture/mood only."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "reference image; leave unconnected for a plain Krea 2 text encode"}),
                "image2": ("IMAGE",),
                "extract": (["style", "subject"], {"tooltip": "style = palette/lighting/texture; subject = composition/content, prompt controls the look."}),
                "position": (["before", "after"], {"tooltip": "Vision tokens before or after the prompt. 'after' keeps the prompt image-blind (less content leak)."}),
                "reference_processing": (["full", "2x2 crops", "4x4 tiles"], {"tooltip": "Shuffled crops kill composition, keep palette/texture. Crops make several vision spans: if outputs turn into grids, enable indirect."}),
                "indirect": ("BOOLEAN", {"default": False, "tooltip": "Delete vision rows after encoding: style only via prompt re-contextualization. Strongest anti-leak mode; forces 'before' position."}),
                "style_directive": ("BOOLEAN", {"default": True, "tooltip": "Inject a declarative style-not-content (or subject) sentence next to the vision span."}),
                "vision_px": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32,
                                      "tooltip": "Cap on the longest side fed to Qwen3-VL. 0 = never resize."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "RedNode/Krea 2"

    def encode(self, clip, prompt, strength, image=None, image2=None, extract="style", position="before",
               reference_processing="full", indirect=False, style_directive=True, vision_px=1024):
        images = [img for img in (image, image2) if img is not None]
        images = [img[b:b + 1] for img in images for b in range(img.shape[0])]

        if not images:
            # no reference connected: behave exactly like a plain Krea 2 text encode
            tokens = clip.tokenize(prompt, llama_template=KREA2_TEMPLATE)
            return (clip.encode_from_tokens_scheduled(tokens),)

        if reference_processing == "2x2 crops":
            images = _expand_style_crops(images, 2)
        elif reference_processing == "4x4 tiles":
            images = _expand_style_crops(images, 4)

        images_vl = []
        for img in images:
            samples = img.movedim(-1, 1)
            h, w = samples.shape[2], samples.shape[3]
            if vision_px and max(h, w) > vision_px:
                scale_by = vision_px / max(h, w)
                samples = comfy.utils.common_upscale(samples, round(w * scale_by), round(h * scale_by), "area", "disabled")
            images_vl.append(samples.movedim(1, -1)[:, :, :, :3])

        directive = ""
        if style_directive:
            directive = SUBJECT_DIRECTIVE if extract == "subject" else STYLE_DIRECTIVE

        vision_prompt = VISION_BLOCK * len(images_vl)
        if indirect:
            position = "before"
        if position == "before":
            text = vision_prompt + directive + prompt
        else:
            text = prompt + directive + vision_prompt

        tokens = clip.tokenize(text, images=images_vl, llama_template=KREA2_TEMPLATE)
        spans = _vision_spans_after_strip(tokens["qwen3vl_4b"][0])
        conditioning = clip.encode_from_tokens_scheduled(tokens)

        out = []
        for cond, extras in conditioning:
            new_extras = extras.copy()
            new_extras.pop("attention_mask", None)  # row surgery invalidates it; absent = all-ones
            out.append([_apply_moodboard(cond, spans, strength, extract, indirect), new_extras])
        return (out,)


