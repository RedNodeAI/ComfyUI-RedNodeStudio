"""RedNode Refine Crop / Paste — sampler-agnostic region refinement (the DIY face
detailer that lets ANY sampler be the engine).

The classic detailer trick, split into two nodes so the sampler in the middle is YOUR
choice (built for pairing with KreaPhoton on Krea 2, where ancestral-tail detailers
speckle skin — see the hub debug checklist):

    image + face MASK ──► Refine Crop ──► LATENT ──► any sampler @ denoise ~0.35-0.5
                              │                          │
                              └────────── crop ──►  VAEDecode ──► Refine Paste ──► IMAGE

Crop: bounding-box of the mask + context margin, upscaled to target_px (long side,
/16-snapped for the K2 patch grid, never downscaled below native), VAE-encoded.
Paste: refined crop resized back, composited through the feathered original mask —
pixels outside the mask are untouched by construction.
"""

import torch
import torch.nn.functional as F

import comfy.utils

CROP_TYPE = "RN_CROP"


def _snap16(v):
    return max(16, int(round(v / 16.0)) * 16)


def _mask_bbox(mask):
    ys, xs = torch.nonzero(mask > 0.5, as_tuple=True)
    if ys.numel() == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


class RedNodeRefineCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "mask": ("MASK", {"tooltip": "the region to refine (face/hands/eyes) — SAM3 face mask, MaskEditor paint, or any MASK output. Pixels outside it are untouched by the paste."}),
            "vae": ("VAE",),
            "context_margin": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 2.0, "step": 0.05,
                               "tooltip": "extra context around the mask's bounding box, as a fraction of its size (0.5 = 50% on each side) — the sampler needs surroundings to blend lighting/skin"}),
            "target_px": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 64,
                          "tooltip": "upscale the crop so its long side reaches this before sampling (the whole point of a detailer: more pixels for the face). Never downscales a crop that is already larger. 0 = keep native size."}),
            "feather": ("INT", {"default": 8, "min": 0, "max": 64,
                        "tooltip": "paste-edge softness in image pixels (applied to the mask at paste time)"}),
        }}

    RETURN_TYPES = ("LATENT", CROP_TYPE)
    RETURN_NAMES = ("latent", "crop")
    FUNCTION = "crop"
    CATEGORY = "RedNode/Image"
    DESCRIPTION = "Cut the masked region (+context) out of the image, upscale it and encode it for refinement by ANY sampler (pair with KreaPhoton on Krea 2). Wire the sampler's decoded output into RedNode Refine Paste."

    def crop(self, image, mask, vae, context_margin=0.5, target_px=1024, feather=8):
        m = mask[0] if mask.ndim == 3 else mask
        if mask.ndim == 3 and mask.shape[0] > 1:
            print("[RedNode Refine] mask batch - using mask 1", flush=True)
        bb = _mask_bbox(m)
        if bb is None:
            raise ValueError("RedNode Refine Crop: the mask is empty - paint the region to refine "
                             "(or check the mask wire).")
        x0, y0, x1, y1 = bb
        H, W = image.shape[1], image.shape[2]
        if m.shape[-2:] != (H, W):
            raise ValueError(f"RedNode Refine Crop: mask is {tuple(m.shape[-2:])} but the image is "
                             f"{(H, W)} - draw the mask on THIS image.")
        mx, my = int((x1 - x0) * context_margin), int((y1 - y0) * context_margin)
        x0, y0 = max(0, x0 - mx), max(0, y0 - my)
        x1, y1 = min(W, x1 + mx), min(H, y1 + my)
        ch, cw = y1 - y0, x1 - x0

        scale = 1.0
        if target_px:
            scale = max(1.0, target_px / max(ch, cw))  # detailers upscale; never destroy pixels
        nh, nw = _snap16(ch * scale), _snap16(cw * scale)

        # bicubic, not lanczos: comfy's lanczos routes through PIL and quantizes to 8-bit
        crop_img = image[:, y0:y1, x0:x1, :].movedim(-1, 1)
        crop_img = comfy.utils.common_upscale(crop_img, nw, nh, "bicubic", "disabled")
        latent = vae.encode(crop_img.movedim(1, -1)[..., :3].clamp(0, 1))
        crop_data = {"bbox": (x0, y0, x1, y1), "image": image, "mask": m,
                     "feather": int(feather)}
        print(f"[RedNode Refine] crop ({cw}x{ch}) -> sampled at {nw}x{nh}", flush=True)
        return ({"samples": latent}, crop_data)


class RedNodeRefinePaste:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE", {"tooltip": "the REFINED crop - the sampler's output after VAEDecode"}),
            "crop": (CROP_TYPE, {"tooltip": "from RedNode Refine Crop"}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "paste"
    CATEGORY = "RedNode/Image"
    DESCRIPTION = "Composite the refined crop back into the original image through the feathered mask - outside the mask the original pixels are untouched."

    def paste(self, image, crop):
        x0, y0, x1, y1 = crop["bbox"]
        orig, m, feather = crop["image"], crop["mask"], crop["feather"]
        bh, bw = y1 - y0, x1 - x0

        ref = comfy.utils.common_upscale(image.movedim(-1, 1), bw, bh, "bicubic", "disabled")
        ref = ref.movedim(1, -1).to(orig.device, orig.dtype)
        if ref.shape[0] != orig.shape[0]:
            ref = ref[:1].expand(orig.shape[0], *ref.shape[1:])

        mm = m[y0:y1, x0:x1].float()[None, None].to(orig.device)
        for _ in range(max(0, int(feather))):
            mm = F.avg_pool2d(mm, 3, 1, 1)
        mm = mm.clamp(0, 1)[0, 0][None, :, :, None]

        out = orig.clone()
        region = out[:, y0:y1, x0:x1, :]
        # blend only the channels both sides have (RGBA originals keep their alpha untouched)
        c = min(region.shape[-1], ref.shape[-1])
        blended = region.clone()
        blended[..., :c] = region[..., :c] * (1.0 - mm) + ref[..., :c] * mm
        out[:, y0:y1, x0:x1, :] = blended
        return (out,)


NODE_CLASS_MAPPINGS = {
    "RedNodeRefineCrop": RedNodeRefineCrop,
    "RedNodeRefinePaste": RedNodeRefinePaste,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RedNodeRefineCrop": "RedNode Refine Crop",
    "RedNodeRefinePaste": "RedNode Refine Paste",
}
