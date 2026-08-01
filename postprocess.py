"""RedNode post processing: one grading chain instead of a shelf of little nodes.

Every effect here is an independent implementation of a standard, long-published
image operation, written from the maths rather than adapted from any pack:

  denoise   bilateral filter (Tomasi & Manduchi, 1998): a Gaussian spatial weight
            multiplied by a Gaussian weight on the intensity difference, so flat
            areas average and edges do not
  colour    brightness as a gain, contrast around mid grey, saturation as a lerp
            between the luma and the colour
  clarity   unsharp mask at a large radius (local contrast), composited through a
            soft light blend and gated by a luminance range, the classic
            "blend if" limiter
  sharpen   unsharp mask, or Richardson-Lucy deconvolution (Richardson 1972,
            Lucy 1974) against a Gaussian point spread function
  bloom     luminance threshold with a soft knee, blur, then screen composite
  halation  the same threshold, blurred wider and tinted warm, added not screened:
            film's red-sensitive layer scattering light back through the base
  distortion  radial remap of the sampling grid, barrel or pincushion
  aberration  per-channel geometric offset, radial and/or axis-aligned
  grain     value noise at a chosen scale, mixed mono or coloured
  vignette  radial luminance falloff

  dof       depth-weighted defocus: the circle of confusion grows with distance
            from the focal plane, so a depth map drives a per-pixel blur
  haze      aerial perspective: distance fades towards a haze colour and loses
            contrast, which is most of what makes a background read as far away
  light wrap  bright regions bleed onto the darker pixels beside them, the way a
            real lens flares across an edge
  diffusion  the pro-mist filter: a soft veil over the whole frame that lifts the
            blacks slightly instead of only glowing the highlights
  rolloff   a soft shoulder near white so highlights compress instead of clipping

ORDER OF THE CHAIN. The rule compositors use is that lensing goes LAST, in the
order light actually meets a physical camera, so the chain is:

  1. repair and grade the picture   denoise, colour, clarity, sharpen
  2. the air in front of the lens   haze
  3. the lens, in light-path order  distortion (glass geometry), depth of field
                                    (focus), chromatic aberration (dispersion),
                                    bloom (veiling glare), light wrap, diffusion
                                    (front filter), vignette (cos^4 falloff)
  4. the film behind it             halation (base reflection), highlight
                                    roll-off (response curve), grain (emulsion)

Two consequences are worth stating because they are easy to get backwards:
sharpening runs BEFORE depth of field, or it re-sharpens what the defocus just
blurred; and grain runs after the vignette, because grain is the emulsion itself
and the vignette is light falling off before it ever reaches the film.

Which effects to offer was informed by skatardude10's ComfyUI-Optical-Realism
(github.com/skatardude10/ComfyUI-Optical-Realism), a good survey of the optical
phenomena worth simulating. The feature list is the debt; the implementations
here are written independently from the underlying optics, as above.

Images are ComfyUI IMAGE tensors: [B, H, W, C] float in 0..1.
"""
import base64
import inspect
import io as _io
import json
import math
import os
import random as _random
import time

import torch
import torch.nn.functional as F

POST_TYPE = "KREA2_POST"

# The default for every control is the value the pack ships with, chosen to match
# a grade the author had already tuned across several packs' nodes.
DEFAULTS = {
    "denoise": {"on": False, "sigma": 0.997, "threshold": 0.051, "radius_multiplier": 1.149},
    "color": {"on": False, "brightness": 1.0, "contrast": 1.0, "saturation": 1.0,
              "temperature": 0.0, "tint": 0.0, "black_point": 0.0},
    "clarity": {"on": False, "radius": 3, "offset": 2.0, "strength": 0.4,
                "blend_mode": "soft light", "blend_if_dark": 50, "blend_if_light": 205,
                "dark_intensity": 0.4, "light_intensity": 0.0},
    "sharpen": {"on": False, "mode": "lucy", "iterations": 1, "kernel_size": 3,
                "amount": 0.5, "radius": 1.0},
    "dof": {"on": False, "focus": 0.35, "range": 0.15, "blur": 6.0, "flip_depth": False},
    "haze": {"on": False, "strength": 0.35, "start": 0.45, "lift": 0.12,
             "flip_depth": False},
    "light_wrap": {"on": False, "strength": 0.4, "radius": 2.5, "threshold": 0.7},
    "diffusion": {"on": False, "strength": 0.25, "radius": 4.0, "black_lift": 0.03},
    "rolloff": {"on": False, "knee": 0.75, "strength": 0.6},
    "bloom": {"on": False, "intensity": 1.16, "threshold": 0.62, "smoothing": 0.23,
              "radius_multiplier": 1.0, "saturation": 0.77, "exposure": 1.0},
    "halation": {"on": False, "strength": 0.35, "threshold": 0.75, "radius": 3.0,
                 "warmth": 0.7},
    "distortion": {"on": False, "amount": 0.0, "edge_softness": 0.0},
    "aberration": {"on": False, "amount": 0.47, "red_shift": 1.0, "green_shift": -1.0,
                   "blue_shift": -3.0, "direction": "horizontal"},
    "grain": {"on": False, "power": 0.09, "scale": 1.0, "saturation": 1.0, "seed": 0},
    "vignette": {"on": False, "amount": 0.10, "feather": 0.6},
}

BLEND_MODES = ("soft light", "overlay", "normal", "linear light")
SHARPEN_MODES = ("lucy", "unsharp")
CA_DIRECTIONS = ("horizontal", "vertical", "radial")

# the chain order: repair, tone, detail, light, lens
ORDER = ("denoise", "color", "clarity", "sharpen",          # repair and grade
         "haze",                                             # the air
         "distortion", "dof", "aberration", "bloom",         # the lens...
         "light_wrap", "diffusion", "vignette",              # ...and its glare
         "halation", "rolloff", "grain")                     # the film

# effects that cannot run without a depth map wired into the node
DEPTH_EFFECTS = ("dof", "haze")


# ---------------------------------------------------------------------------
# helpers
def _nchw(img):
    return img.permute(0, 3, 1, 2)


def _nhwc(t):
    return t.permute(0, 2, 3, 1)


def _luma(t):
    """Rec.709 luminance of an NCHW tensor, kept as a 1-channel map."""
    r, g, b = t[:, 0:1], t[:, 1:2], t[:, 2:3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _gauss_kernel(sigma, device, dtype):
    radius = max(1, int(round(sigma * 3)))
    x = torch.arange(-radius, radius + 1, device=device, dtype=dtype)
    k = torch.exp(-(x ** 2) / (2 * sigma * sigma))
    return k / k.sum()


def gaussian_blur(t, sigma):
    """Separable Gaussian blur on NCHW, reflect-padded so edges do not darken."""
    if sigma <= 0:
        return t
    k = _gauss_kernel(sigma, t.device, t.dtype)
    r = (k.numel() - 1) // 2
    c = t.shape[1]
    kx = k.view(1, 1, 1, -1).expand(c, 1, 1, -1)
    ky = k.view(1, 1, -1, 1).expand(c, 1, -1, 1)
    # reflect padding needs the pad smaller than the side; fall back to replicate
    mode = "reflect" if r < min(t.shape[2], t.shape[3]) else "replicate"
    t = F.pad(t, (r, r, 0, 0), mode=mode)
    t = F.conv2d(t, kx, groups=c)
    t = F.pad(t, (0, 0, r, r), mode=mode)
    return F.conv2d(t, ky, groups=c)


def _clamp01(t):
    return t.clamp(0.0, 1.0)


# ---------------------------------------------------------------------------
# effects
# Denoise is the one effect whose cost runs away with its settings: the window is
# (2r+1) squared passes over the whole picture, and r follows sigma and the radius
# multiplier together. Measured on a 1024 by 1024 frame: 0.1 s at the shipped
# defaults, 0.55 s at sigma 2, 4.5 s at both sliders maxed. That is slow, not
# broken, so nothing here is capped: capping would quietly change a grade somebody
# had already tuned. It says so instead, once per set of settings, because four
# seconds with no explanation reads as a hang.
_DENOISE_SAID = None


def _denoise_notice(radius, pixels):
    global _DENOISE_SAID
    taps = (2 * radius + 1) ** 2
    if taps < 400:
        return
    key = (taps, pixels)
    if key == _DENOISE_SAID:
        return
    _DENOISE_SAID = key
    secs = taps * pixels / 8.6e8        # from the measurement above
    print(f"[RedNode Post] denoise is set wide (radius {radius}, {taps} passes over "
          f"{pixels // 1000} K pixels), so expect around {secs:.0f} s. Lower sigma or "
          "the radius multiplier if that is not worth it.", flush=True)


def denoise(img, sigma=0.997, threshold=0.051, radius_multiplier=1.149):
    """Bilateral filter: average neighbours that are both CLOSE and SIMILAR.

    sigma sets how far the averaging reaches, threshold how different a pixel may
    be before it stops contributing (so edges survive), and radius_multiplier
    trades speed for reach by widening the window around that sigma.
    """
    if sigma <= 0 or threshold <= 0:
        return img
    t = _nchw(img)
    radius = max(1, int(round(sigma * radius_multiplier * 2)))
    _denoise_notice(radius, t.shape[-1] * t.shape[-2])
    guide = _luma(t)
    two_ss = 2.0 * sigma * sigma
    two_tt = 2.0 * threshold * threshold
    acc = torch.zeros_like(t)
    wsum = torch.zeros_like(guide)
    pad = F.pad(t, (radius,) * 4, mode="replicate")
    gpad = F.pad(guide, (radius,) * 4, mode="replicate")
    h, w = t.shape[2], t.shape[3]
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            spatial = math.exp(-(dx * dx + dy * dy) / two_ss)
            if spatial < 1e-4:
                continue
            shifted = pad[:, :, radius + dy:radius + dy + h, radius + dx:radius + dx + w]
            gshift = gpad[:, :, radius + dy:radius + dy + h, radius + dx:radius + dx + w]
            wr = torch.exp(-((gshift - guide) ** 2) / two_tt) * spatial
            acc += shifted * wr
            wsum += wr
    return _nhwc(acc / wsum.clamp_min(1e-6))


def color(img, brightness=1.0, contrast=1.0, saturation=1.0, temperature=0.0,
          tint=0.0, black_point=0.0):
    """Brightness as a gain, contrast pivoting on mid grey, saturation as a lerp,
    plus a white-balance style temperature/tint trim and a black point lift.

    temperature moves the red and blue channels in opposite directions (warm is
    more red, less blue), tint does the same for green against magenta, and
    black_point rescales the range so the darkest tone lands where you ask.
    """
    t = _nchw(img) * float(brightness)
    t = (t - 0.5) * float(contrast) + 0.5
    if temperature or tint:
        warm = float(temperature) * 0.5
        gm = float(tint) * 0.5
        gain = torch.tensor([1.0 + warm, 1.0 + gm, 1.0 - warm],
                            device=t.device, dtype=t.dtype).view(1, 3, 1, 1)
        t = t * gain
    if saturation != 1.0:
        t = _luma(t) + (t - _luma(t)) * float(saturation)
    bp = float(black_point)
    if bp:
        # positive crushes the blacks, negative lifts them into a faded, milky look
        t = (t - bp) / max(1e-3, 1.0 - bp) if bp > 0 else t * (1.0 + bp) - bp
    return _clamp01(_nhwc(t))


def _blend(base, top, mode):
    """Composite `top` over `base`, both NCHW in 0..1."""
    if mode == "normal":
        return top
    if mode == "overlay":
        return torch.where(base <= 0.5, 2 * base * top,
                           1 - 2 * (1 - base) * (1 - top))
    if mode == "linear light":
        return base + 2 * top - 1
    # soft light, the W3C/photoshop formulation
    d = torch.where(base <= 0.25, ((16 * base - 12) * base + 4) * base, torch.sqrt(base.clamp_min(0)))
    return torch.where(top <= 0.5,
                       base - (1 - 2 * top) * base * (1 - base),
                       base + (2 * top - 1) * (d - base))


def _blend_if(lum, dark, light):
    """The 'blend if' limiter: 0 below `dark`, 1 above `light`, smooth between.

    dark and light arrive on the familiar 0..255 scale.
    """
    lo = float(dark) / 255.0
    hi = float(light) / 255.0
    if hi <= lo:
        return torch.ones_like(lum)
    return ((lum - lo) / (hi - lo)).clamp(0.0, 1.0)


def clarity(img, radius=3, offset=2.0, strength=0.4, blend_mode="soft light",
            blend_if_dark=50, blend_if_light=205, dark_intensity=0.4,
            light_intensity=0.0):
    """Local contrast: a wide unsharp mask composited through a blend mode.

    radius x offset is the blur reach, so the detail it lifts is broad shapes
    rather than pixel edges. dark_intensity and light_intensity weight the two
    ends of the tonal range separately, gated by the blend-if window.
    """
    t = _nchw(img)
    sigma = max(0.1, float(radius) * float(offset) / 3.0)
    blurred = gaussian_blur(t, sigma)
    detail = _clamp01((t - blurred) * float(strength) + 0.5)
    mixed = _blend(t, detail, blend_mode if blend_mode in BLEND_MODES else "soft light")
    lum = _luma(t)
    upper = _blend_if(lum, blend_if_dark, blend_if_light)     # 1 in the highlights
    weight = upper * float(light_intensity) + (1.0 - upper) * float(dark_intensity)
    return _clamp01(_nhwc(t + (mixed - t) * weight))


def sharpen(img, mode="lucy", iterations=1, kernel_size=3, amount=0.5, radius=1.0):
    """Richardson-Lucy deconvolution, or a plain unsharp mask.

    Lucy assumes the image was blurred by a Gaussian point spread function and
    walks an estimate back towards the sharp original, one multiplicative step
    per iteration. It recovers real detail rather than just raising edge
    contrast, which is why one or two iterations beat a heavy unsharp pass.
    """
    t = _nchw(img)
    if mode == "unsharp":
        blurred = gaussian_blur(t, max(0.1, float(radius)))
        return _clamp01(_nhwc(t + (t - blurred) * float(amount)))
    sigma = max(0.3, float(kernel_size) / 3.0)
    est = t.clamp_min(1e-6)
    obs = t.clamp_min(1e-6)
    for _ in range(max(1, min(20, int(iterations)))):
        conv = gaussian_blur(est, sigma).clamp_min(1e-6)
        est = est * gaussian_blur(obs / conv, sigma)
        est = est.clamp(0.0, 4.0)
    return _clamp01(_nhwc(est))


def bloom(img, intensity=1.16, threshold=0.62, smoothing=0.23, radius_multiplier=1.0,
          saturation=0.77, exposure=1.0):
    """Screen a blurred copy of the bright areas back over the image.

    smoothing is the soft knee: how gradually a pixel starts counting as bright,
    so a lit edge glows instead of switching on. saturation controls how coloured
    the glow is, exposure scales the source brightness feeding it.
    """
    t = _nchw(img) * float(exposure)
    lum = _luma(t)
    thr = float(threshold)
    knee = max(1e-4, float(smoothing))
    mask = ((lum - thr) / knee).clamp(0.0, 1.0)               # soft knee ramp
    mask = mask * mask * (3 - 2 * mask)                       # smoothstep
    bright = t * mask
    if saturation != 1.0:
        bl = _luma(bright)
        bright = bl + (bright - bl) * float(saturation)
    sigma = max(0.5, 8.0 * float(radius_multiplier))
    glow = gaussian_blur(bright, sigma) * float(intensity)
    base = _nchw(img)
    screened = 1 - (1 - base) * (1 - glow.clamp(0.0, 1.0))    # screen composite
    return _clamp01(_nhwc(screened))


def _depth_map(depth, like, flip=False):
    """A [B,1,H,W] 0..1 distance map matched to `like`, 0 near and 1 far.

    Depth Anything and friends output an IMAGE, so take its luminance and resize
    it if the grader is working at a different size.
    """
    d = _nchw(depth)
    if d.shape[1] >= 3:
        d = _luma(d)
    else:
        d = d[:, :1]
    if d.shape[0] != like.shape[0]:
        d = d[:1].expand(like.shape[0], -1, -1, -1)
    if d.shape[2:] != like.shape[2:]:
        d = F.interpolate(d, size=like.shape[2:], mode="bilinear", align_corners=False)
    lo, hi = float(d.min()), float(d.max())
    if hi - lo > 1e-6:
        d = (d - lo) / (hi - lo)                      # normalise: encoders disagree
    return 1.0 - d if flip else d


def dof(img, depth=None, focus=0.35, range=0.15, blur=6.0, flip_depth=False):  # noqa: A002
    """Defocus that grows with distance from the focal plane.

    The blur is mixed per pixel by the circle of confusion, so the focal plane
    stays sharp and everything falls off smoothly either side of it. This is a
    depth-weighted defocus rather than sprite bokeh: no polygonal highlights, but
    no halos around foreground edges either.
    """
    if depth is None:
        print("[RedNode Post] depth of field needs a depth map on the node's depth "
              "input; skipping it", flush=True)
        return img
    t = _nchw(img)
    d = _depth_map(depth, t, flip_depth)
    coc = ((d - float(focus)).abs() / max(1e-3, float(range))).clamp(0.0, 1.0)
    coc = coc * coc * (3 - 2 * coc)
    soft = gaussian_blur(t, max(0.3, float(blur)))
    return _clamp01(_nhwc(t * (1 - coc) + soft * coc))


def haze(img, depth=None, strength=0.35, start=0.45, lift=0.12, flip_depth=False):
    """Aerial perspective: distance washes out towards the atmosphere's colour.

    Contrast and saturation drop with distance and everything drifts towards a
    pale value. It is most of what separates a photographed background from an
    AI one, which tends to render distance at the same punch as the foreground.
    """
    if depth is None:
        print("[RedNode Post] atmospheric haze needs a depth map on the node's depth "
              "input; skipping it", flush=True)
        return img
    t = _nchw(img)
    d = _depth_map(depth, t, flip_depth)
    far = ((d - float(start)) / max(1e-3, 1.0 - float(start))).clamp(0.0, 1.0)
    far = far * far * (3 - 2 * far) * float(strength)
    veil = _luma(t).mean() + float(lift)              # the scene's own average, lifted
    return _clamp01(_nhwc(t * (1 - far) + veil * far))


def light_wrap(img, strength=0.4, radius=2.5, threshold=0.7):
    """Bright regions bleed onto the darker pixels beside them.

    Distinct from bloom: this only lands where a bright area meets a darker one,
    which is what softens the hard composite edge that makes a subject look
    pasted onto its background.
    """
    t = _nchw(img)
    lum = _luma(t)
    bright = ((lum - float(threshold)) / max(1e-4, 1.0 - float(threshold))).clamp(0.0, 1.0)
    spread = gaussian_blur(t * bright, max(0.5, float(radius) * 2.0))
    # only where the pixel itself is DARKER than what is spreading onto it
    gate = (1.0 - lum).clamp(0.0, 1.0)
    return _clamp01(_nhwc(t + spread * gate * float(strength)))


def diffusion(img, strength=0.25, radius=4.0, black_lift=0.03):
    """The pro-mist filter: a soft veil over the whole frame.

    Unlike bloom it does not wait for a threshold, so the image keeps its detail
    but gains a gentle halo everywhere and slightly milky blacks. This is the
    filter most cinematographers reach for to take the digital edge off.
    """
    t = _nchw(img)
    soft = gaussian_blur(t, max(0.5, float(radius)))
    veiled = 1 - (1 - t) * (1 - soft * float(strength))       # screen the veil back
    return _clamp01(_nhwc(veiled * (1.0 - float(black_lift)) + float(black_lift)))


def rolloff(img, knee=0.75, strength=0.6):
    """A soft shoulder near white, so highlights compress instead of clipping flat.

    Digital sensors clip abruptly; film shoulders off. Everything below the knee
    is untouched, everything above is compressed into the space that remains.
    """
    t = _nchw(img)
    k = min(0.999, max(0.0, float(knee)))
    s = max(0.0, min(1.0, float(strength)))
    over = (t - k).clamp_min(0.0)
    head = 1.0 - k
    if head <= 1e-6:
        return img
    # tanh gives a smooth, monotonic shoulder that never exceeds 1
    compressed = head * torch.tanh(over / head)
    return _clamp01(_nhwc(t - over * s + compressed * s))


def halation(img, strength=0.35, threshold=0.75, radius=3.0, warmth=0.7):
    """The warm bleed film gets around bright edges.

    Physically this is light passing through the emulsion, bouncing off the back
    of the base and scattering into the red-sensitive layer, which is why it is
    warm and why it is wider and softer than bloom. Added rather than screened,
    so it stains rather than just brightening.
    """
    t = _nchw(img)
    lum = _luma(t)
    mask = ((lum - float(threshold)) / max(1e-4, 1.0 - float(threshold))).clamp(0.0, 1.0)
    glow = gaussian_blur(t * mask, max(0.5, float(radius) * 4.0))
    w = float(warmth)
    tint = torch.tensor([1.0, 1.0 - 0.45 * w, 1.0 - 0.85 * w],
                        device=t.device, dtype=t.dtype).view(1, 3, 1, 1)
    return _clamp01(_nhwc(t + glow * tint * float(strength)))


def distortion(img, amount=0.0, edge_softness=0.0):
    """Barrel (positive) or pincushion (negative) lens distortion.

    Real glass never maps the world to a perfect rectangle. A little barrel reads
    as a wide lens; a little pincushion reads as a long one. edge_softness blurs
    towards the corners, the way a cheap lens loses resolution off-axis.
    """
    t = _nchw(img)
    a = float(amount)
    if a:
        b, c, h, w = t.shape
        ys = torch.linspace(-1, 1, h, device=t.device, dtype=t.dtype).view(1, h, 1).expand(b, h, w)
        xs = torch.linspace(-1, 1, w, device=t.device, dtype=t.dtype).view(1, 1, w).expand(b, h, w)
        r2 = xs * xs + ys * ys
        f = 1.0 + a * r2                       # the classic radial polynomial
        grid = torch.stack((xs * f, ys * f), dim=-1)
        t = F.grid_sample(t, grid, mode="bilinear", padding_mode="border",
                          align_corners=True)
    e = float(edge_softness)
    if e > 0:
        b, c, h, w = t.shape
        ys = torch.linspace(-1, 1, h, device=t.device, dtype=t.dtype).view(1, 1, h, 1)
        xs = torch.linspace(-1, 1, w, device=t.device, dtype=t.dtype).view(1, 1, 1, w)
        d = (torch.sqrt(xs * xs + ys * ys) / math.sqrt(2.0)).clamp(0, 1)
        soft = gaussian_blur(t, 1.0 + 3.0 * e)
        k = (d ** 2) * e
        t = t * (1 - k) + soft * k
    return _clamp01(_nhwc(t))


def _shift(plane, px, direction):
    """Move one colour plane by px pixels, replicate-padded at the edge."""
    n = int(round(px))
    if n == 0:
        return plane
    if direction == "vertical":
        pad = F.pad(plane, (0, 0, abs(n), abs(n)), mode="replicate")
        h = plane.shape[2]
        start = abs(n) - n
        return pad[:, :, start:start + h, :]
    pad = F.pad(plane, (abs(n), abs(n), 0, 0), mode="replicate")
    w = plane.shape[3]
    start = abs(n) - n
    return pad[:, :, :, start:start + w]


def aberration(img, amount=0.47, red_shift=1.0, green_shift=-1.0, blue_shift=-3.0,
               direction="horizontal"):
    """Split the colour channels the way a cheap lens does.

    `amount` scales the per-channel shifts, so one dial rides the whole effect
    while the three offsets keep the character of the split. Radial pushes the
    channels apart from the centre outwards, which is what a real lens does;
    horizontal and vertical are the flat, stylised version.
    """
    t = _nchw(img)
    shifts = [float(red_shift), float(green_shift), float(blue_shift)]
    a = float(amount)
    if direction == "radial":
        out = []
        b, c, h, w = t.shape
        ys = torch.linspace(-1, 1, h, device=t.device, dtype=t.dtype).view(1, h, 1).expand(b, h, w)
        xs = torch.linspace(-1, 1, w, device=t.device, dtype=t.dtype).view(1, 1, w).expand(b, h, w)
        for i, s in enumerate(shifts):
            k = 1.0 + (s * a) / 100.0                          # a percent-ish scale
            grid = torch.stack((xs * k, ys * k), dim=-1)
            out.append(F.grid_sample(t[:, i:i + 1], grid, mode="bilinear",
                                     padding_mode="border", align_corners=True))
        return _clamp01(_nhwc(torch.cat(out, dim=1)))
    planes = [_shift(t[:, i:i + 1], s * a, direction) for i, s in enumerate(shifts)]
    return _clamp01(_nhwc(torch.cat(planes, dim=1)))


def grain(img, power=0.09, scale=1.0, saturation=1.0, seed=0):
    """Film grain: noise generated at `scale` then resampled up, so the grain has
    a size instead of being one-pixel static. saturation 0 is mono grain, 1 is
    fully coloured.
    """
    t = _nchw(img)
    b, c, h, w = t.shape
    gen = torch.Generator(device="cpu")
    gen.manual_seed(int(seed) & 0x7FFFFFFF)
    s = max(0.05, float(scale))
    gh, gw = max(1, int(h / s)), max(1, int(w / s))
    noise = torch.randn((b, 3, gh, gw), generator=gen).to(t.device, t.dtype)
    if (gh, gw) != (h, w):
        noise = F.interpolate(noise, size=(h, w), mode="bilinear", align_corners=False)
    if saturation != 1.0:
        mono = noise.mean(dim=1, keepdim=True)
        noise = mono + (noise - mono) * float(saturation)
    # grain reads strongest in the midtones, as it does on film
    weight = 1.0 - (2.0 * _luma(t) - 1.0).abs()
    return _clamp01(_nhwc(t + noise * float(power) * weight))


def vignette(img, amount=0.10, feather=0.6):
    """Radial falloff towards the corners. feather sets how soon it starts."""
    t = _nchw(img)
    b, c, h, w = t.shape
    ys = torch.linspace(-1, 1, h, device=t.device, dtype=t.dtype).view(1, 1, h, 1)
    xs = torch.linspace(-1, 1, w, device=t.device, dtype=t.dtype).view(1, 1, 1, w)
    d = torch.sqrt(xs * xs + ys * ys) / math.sqrt(2.0)
    edge = max(1e-3, float(feather))
    fall = ((d - (1.0 - edge)) / edge).clamp(0.0, 1.0)
    fall = fall * fall * (3 - 2 * fall)
    return _clamp01(_nhwc(t * (1.0 - fall * float(amount))))


# ---------------------------------------------------------------------------
EFFECTS = {
    "denoise": denoise, "color": color, "dof": dof, "haze": haze, "clarity": clarity,
    "sharpen": sharpen, "bloom": bloom, "halation": halation, "light_wrap": light_wrap,
    "diffusion": diffusion, "rolloff": rolloff, "distortion": distortion,
    "aberration": aberration, "grain": grain, "vignette": vignette,
}


def parse_post(data):
    """Normalise a post config dict: every block present, every value in range."""
    out = {}
    src = data if isinstance(data, dict) else {}
    for name, defaults in DEFAULTS.items():
        block = src.get(name) if isinstance(src.get(name), dict) else {}
        cur = dict(defaults)
        for key, dv in defaults.items():
            if key not in block:
                continue
            v = block[key]
            if isinstance(dv, bool):
                cur[key] = bool(v)
            elif isinstance(dv, str):
                cur[key] = str(v)
            elif isinstance(dv, int):
                try:
                    cur[key] = int(v)
                except (TypeError, ValueError):
                    pass
            else:
                try:
                    cur[key] = float(v)
                except (TypeError, ValueError):
                    pass
        out[name] = cur
    # random ranges: {"rand": {"intensity": [lo, hi]}} on any block, rolled fresh
    # each queue. Only keys the block actually has, and only numeric ones.
    for name, defaults in DEFAULTS.items():
        raw = src.get(name) if isinstance(src.get(name), dict) else {}
        rin = raw.get("rand") if isinstance(raw.get("rand"), dict) else {}
        rand = {}
        for key, pair in rin.items():
            if key not in defaults or isinstance(defaults[key], (bool, str)):
                continue
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                continue
            try:
                lo, hi = float(pair[0]), float(pair[1])
            except (TypeError, ValueError):
                continue
            rand[key] = [min(lo, hi), max(lo, hi)]
        if rand:
            out[name]["rand"] = rand
    out["clarity"]["blend_mode"] = (out["clarity"]["blend_mode"]
                                    if out["clarity"]["blend_mode"] in BLEND_MODES
                                    else "soft light")
    out["sharpen"]["mode"] = (out["sharpen"]["mode"]
                              if out["sharpen"]["mode"] in SHARPEN_MODES else "lucy")
    out["aberration"]["direction"] = (out["aberration"]["direction"]
                                      if out["aberration"]["direction"] in CA_DIRECTIONS
                                      else "horizontal")
    out["sharpen"]["iterations"] = max(1, min(20, out["sharpen"]["iterations"]))
    out["sharpen"]["kernel_size"] = max(1, min(31, out["sharpen"]["kernel_size"]))
    out["clarity"]["radius"] = max(1, min(64, out["clarity"]["radius"]))
    return out


def roll_block(name, block):
    """Draw a value for every control set to a random range. Ints stay ints."""
    rolled = {}
    for key, (lo, hi) in (block.get("rand") or {}).items():
        if isinstance(DEFAULTS[name].get(key), int):
            rolled[key] = _random.randint(int(round(lo)), int(round(hi)))
        else:
            rolled[key] = round(_random.uniform(lo, hi), 4)
    return rolled


# A chain slower than this gets its time broken down in the console. Below it the
# report is noise: every effect at shipped defaults on a 1 MP frame totals under a
# third of a second, so anything taking seconds has one specific cause and the only
# useful thing to print is which one.
SLOW_CHAIN_SECONDS = 2.0


def apply_post(image, config, depth=None, on_effect=None, rolls=None, extra_timings=()):
    """Run the whole chain in grading order. Blocks that are off cost nothing."""
    cfg = parse_post(config)
    out = image
    timings = []
    for name in ORDER:
        block = cfg[name]
        if not block.get("on"):
            continue
        args = {k: v for k, v in block.items() if k not in ("on", "rand")}
        drawn = roll_block(name, block)
        if drawn:
            args.update(drawn)
            if rolls is not None:
                rolls[name] = drawn
            shown = ", ".join(f"{k} {v}" for k, v in sorted(drawn.items()))
            print(f"[RedNode Post] {name} rolled {shown}", flush=True)
        if name in DEPTH_EFFECTS:
            args["depth"] = depth
        started = time.time()
        out = EFFECTS[name](out, **args)
        timings.append((name, time.time() - started))
        if on_effect:
            on_effect(name)
    report_timings(timings, extra_timings)
    return out


def report_timings(timings, extra=()):
    """Say where the time went, but only when there was time worth explaining.

    `extra` carries stages that are not effects, depth estimation above all. That one
    loads a model, and it is almost always the answer when a grade takes seconds
    rather than a fraction of one.
    """
    stages = list(extra) + list(timings)
    total = sum(t for _, t in stages)
    if total < SLOW_CHAIN_SECONDS:
        return
    worst = [(n, t) for n, t in sorted(stages, key=lambda kv: -kv[1])[:4] if t >= 0.05]
    print(f"[RedNode Post] the chain took {total:.1f}s. Slowest: "
          + ", ".join(f"{n} {t:.1f}s" for n, t in worst), flush=True)
    if dict(stages).get("depth map", 0) >= 1.0:
        print("[RedNode Post] most of that is the depth model, which depth of field and "
              "haze both need. Turn those two off, or wire a depth image into the depth "
              "input to reuse one you already have.", flush=True)


# ---------------------------------------------------------------------------
# Look presets: a name, the whole chain, and a thumbnail of what it did. A grade
# is a visual thing, so the picker shows the picture rather than the numbers.
THUMB_PX = 132


def _presets_path(make=False):
    override = os.environ.get("KREA2RN_POST_PRESETS")
    if override:
        return override
    try:
        import folder_paths
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "post_presets.json")


def load_presets():
    """{name: {"config": chain dict, "thumb": data URI or ""}}."""
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for name, entry in (data.get("presets") or {}).items():
            if isinstance(entry, dict) and isinstance(entry.get("config"), dict):
                out[str(name)] = {"config": entry["config"],
                                  "thumb": str(entry.get("thumb") or "")}
        return out
    except (OSError, ValueError):
        return {}


def _write_presets(presets):
    path = _presets_path(make=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"presets": presets}, f, indent=2)
    os.replace(tmp, path)


def thumb_data_uri(image, px=THUMB_PX):
    """A small centre-cropped PNG data URI of an IMAGE tensor's first frame."""
    from PIL import Image
    # same peeling as the Stage taps: a video VAE hands back [B, T, H, W, C], and a
    # decode can carry alpha, neither of which PIL will draw
    t = image
    while t.ndim > 3:
        t = t[0]
    if t.shape[-1] == 1:
        t = t.repeat(1, 1, 3)
    elif t.shape[-1] > 3:
        t = t[..., :3]
    arr = (t.detach().cpu().float().clamp(0, 1).numpy() * 255).astype("uint8")
    img = Image.fromarray(arr, mode="RGB")
    side = min(img.width, img.height)                     # square crop, centred
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    img = img.crop((left, top, left + side, top + side)).resize((px, px), Image.LANCZOS)
    buf = _io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def save_preset(name, config, thumb=""):
    # the thumbnails are most of what this file weighs, so the settings dialog can turn
    # them off and keep Looks as settings only
    try:
        from . import settings
        if not settings.get("look_thumbs", True):
            thumb = ""
    except Exception:
        pass
    name = str(name or "").strip()
    if not name:
        raise ValueError("a preset needs a name")
    if not isinstance(config, dict):
        raise ValueError("a preset needs a config")
    presets = load_presets()
    keep = presets.get(name, {}).get("thumb", "")
    presets[name] = {"config": parse_post(config),
                     "thumb": str(thumb or "") or keep}   # keep the old shot if none given
    _write_presets(presets)
    return presets


def delete_preset(name):
    presets = load_presets()
    presets.pop(str(name or ""), None)
    _write_presets(presets)
    return presets


# the most recent graded frame, so "save this look" has a picture to save. Held in
# memory only: it is a preview, not something worth writing to disk every run.
LAST_THUMB = {"uri": ""}

# what the random ranges actually drew last run, so the panel can show it back
LAST_ROLLS = {}


# Depth of field and haze need to know what is near and what is far, and working
# that out takes a neural net rather than maths on the pixels. Rather than make
# the user wire a second node for it, drive whichever depth estimator they have
# installed, exactly as the auto prompt drives WD14 and JoyCaption.
DEPTH_NODES = ("DepthAnythingV2Preprocessor", "DepthAnythingPreprocessor",
               "MiDaS-DepthMapPreprocessor", "Zoe-DepthMapPreprocessor")


def _depth_node():
    try:
        import nodes
    except Exception:
        return None, ""
    for name in DEPTH_NODES:
        cls = getattr(nodes, "NODE_CLASS_MAPPINGS", {}).get(name)
        if cls is not None:
            return cls, name
    return None, ""


def auto_depth(image, resolution=512):
    """A depth map for `image` from the installed estimator, or None."""
    cls, name = _depth_node()
    if cls is None:
        print("[RedNode Post] depth of field and haze need a depth map. Install "
              "comfyui_controlnet_aux (it brings Depth Anything V2) or wire one into "
              "the depth input; skipping those two for now.", flush=True)
        return None
    try:
        fn = getattr(cls(), cls.FUNCTION)
        accepted = set(inspect.signature(fn).parameters)
        kwargs = {"image": image, "resolution": int(resolution)}
        # every wrapper names its checkpoint argument differently, so only fill it
        # when the signature asks and let its own default stand otherwise
        result = fn(**{k: v for k, v in kwargs.items() if k in accepted})
        if isinstance(result, dict):
            result = result.get("result", (None,))
        out = result[0] if isinstance(result, (list, tuple)) else result
        if out is None:
            return None
        print(f"[RedNode Post] depth map made with {name}", flush=True)
        return out
    except Exception as e:
        print(f"[RedNode Post] the installed depth estimator failed ({e}); skipping "
              "depth of field and haze", flush=True)
        return None


def own_post(config):
    """The chain out of this node's own panel widget."""
    try:
        data = json.loads(config) if isinstance(config, str) else config
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    # the panel stores the chain under "post", matching the workspace's config
    return data.get("post") if isinstance(data.get("post"), dict) else data


def post_from_prompt(prompt):
    """Find the Studio Workspace in the queued graph and read its Post tab.

    The settings live on a node at the FRONT of the graph while this one sits at
    the very end, so demanding a wire across the whole workflow is a poor trade.
    The same wireless trick the Control Panel and Sampler Config use applies
    here: read the queued prompt and take the config straight off the workspace.
    """
    if not isinstance(prompt, dict):
        return None
    found = []
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "RedNodeStudioWorkspace":
            continue
        raw = (node.get("inputs") or {}).get("config")
        if not isinstance(raw, str):
            continue
        try:
            cfg = parse_post((json.loads(raw) or {}).get("post"))
        except (ValueError, TypeError):
            continue
        found.append(cfg)
    if not found:
        return None
    # a workspace with something switched on wins over one sitting at defaults
    for cfg in found:
        if any(cfg[n].get("on") for n in ORDER):
            return cfg
    return found[0]


class RedNodePostProcess:
    """Applies the Workspace's Post tab to a finished image.

    One image in, one image out, and nothing else to wire. The chain comes from
    the Studio Workspace's Post tab, found in the queued graph, and depth of
    field and haze work out their own depth map. For a version that carries its
    own settings, use RedNode Post FX instead.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "the finished image, straight off the VAE "
                                    "decode. The grading chain comes from the Studio "
                                    "Workspace's Post tab automatically"}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("The Post tab's grading chain in one node, applied in physical camera "
                   "order: grade, then the air, then the lens, then the film. Wire the "
                   "finished image in and the graded image out. It finds the Studio "
                   "Workspace's Post tab by itself, so the post input is optional.")

    @classmethod
    def IS_CHANGED(cls, image=None, prompt=None):
        # any random range means this node must re-run every queue to draw again
        try:
            cfg = post_from_prompt(prompt) or parse_post({})
        except Exception:
            return float("nan")
        if any(cfg[n].get("on") and cfg[n].get("rand") for n in ORDER):
            return float("nan")
        return json.dumps(cfg, sort_keys=True)

    def run(self, image, prompt=None):
        cfg = post_from_prompt(prompt)
        if not cfg or not any(cfg[n].get("on") for n in ORDER):
            return (image,)
        # depth of field and haze need a depth map; make one rather than asking the
        # user to build a second branch of the graph for it
        depth = None
        extra = []
        if any(cfg[n].get("on") for n in DEPTH_EFFECTS):
            _t0 = time.time()
            depth = auto_depth(image)
            extra.append(("depth map", time.time() - _t0))
        ran = []
        LAST_ROLLS.clear()
        out = apply_post(image, cfg, depth=depth, on_effect=ran.append,
                         rolls=LAST_ROLLS, extra_timings=extra)
        if ran:
            print(f"[RedNode Post] applied: {', '.join(ran)}", flush=True)
        # hand the panel a picture of the result: the Post tab shows it, and saving
        # a look preset stores it as that look's thumbnail
        try:
            LAST_THUMB["uri"] = thumb_data_uri(out)
        except Exception as e:
            print(f"[RedNode Post] could not build the preview thumbnail ({e})", flush=True)
        return (out,)


class RedNodePostFX:
    """The same grading chain, carrying its own panel: no workspace needed.

    Sibling to RedNodePostProcess rather than a replacement. That one belongs at
    the tail of a Studio Workspace generation and takes its settings from the
    Post tab; this one is for building a workflow around images you already
    have, where there is no workspace to read from.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "any image: a Load Image, a batch from a "
                                    "folder, or the tail of a generation"}),
                # the panel's own copy of the chain
                "config": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                "depth": ("IMAGE", {"tooltip": "OPTIONAL. Depth of field and haze work out "
                                    "what is near and far by themselves; wire this only to "
                                    "supply your own depth map"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("The whole grading chain on a node of its own, with every control on "
                   "the node: denoise, colour, clarity, sharpen, haze, lens distortion, "
                   "depth of field, chromatic aberration, bloom, light wrap, diffusion, "
                   "vignette, halation, highlight roll-off and grain, applied in physical "
                   "camera order. Point it at any image; no Studio Workspace required.")

    @classmethod
    def IS_CHANGED(cls, image=None, config="{}", depth=None):
        try:
            cfg = parse_post(own_post(config))
        except Exception:
            return float("nan")
        if any(cfg[n].get("on") and cfg[n].get("rand") for n in ORDER):
            return float("nan")
        return json.dumps(cfg, sort_keys=True)

    def run(self, image, config="{}", depth=None):
        cfg = parse_post(own_post(config))
        if not any(cfg[n].get("on") for n in ORDER):
            return (image,)
        if depth is None and any(cfg[n].get("on") for n in DEPTH_EFFECTS):
            depth = auto_depth(image)
        ran = []
        LAST_ROLLS.clear()
        out = apply_post(image, cfg, depth=depth, on_effect=ran.append, rolls=LAST_ROLLS)
        if ran:
            print(f"[RedNode Post FX] applied: {', '.join(ran)}", flush=True)
        try:
            LAST_THUMB["uri"] = thumb_data_uri(out)
        except Exception as e:
            print(f"[RedNode Post FX] could not build the preview thumbnail ({e})",
                  flush=True)
        return (out,)


NODE_CLASS_MAPPINGS = {"RedNodePostProcess": RedNodePostProcess,
                       "RedNodePostFX": RedNodePostFX}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePostProcess": "RedNode Post Process",
                              "RedNodePostFX": "RedNode Post FX (standalone)"}
