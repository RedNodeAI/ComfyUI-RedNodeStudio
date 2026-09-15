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
    # MATCH A REFERENCE: the picture's colour statistics moved onto a reference
    # picture's (per-channel mean and spread), with skin held back so faces keep
    # their hue. source names where the reference comes from: a Workspace tab
    # for the wireless node, the reference input for the standalone one.
    "match": {"on": False, "source": "moodboard", "method": "adain", "strength": 1.0,
              "skin_protect": 0.5, "ref_file": ""},
    # A LUT: a .cube file from models/luts, trilinear, strength past 1 overdrives
    "lut": {"on": False, "file": "", "strength": 1.0, "log": False},
    "clarity": {"on": False, "radius": 3, "offset": 2.0, "strength": 0.4,
                "blend_mode": "soft light", "blend_if_dark": 50, "blend_if_light": 205,
                "dark_intensity": 0.4, "light_intensity": 0.0},
    "sharpen": {"on": False, "mode": "lucy", "iterations": 1, "kernel_size": 3,
                "amount": 0.5, "radius": 1.0},
    # THE DEPTH CARD: not an effect, the settings for the depth map the two depth
    # effects share. Which estimator, which Depth Anything V2 checkpoint, and the
    # working resolution. "auto" is whichever is installed, and its own default file.
    "depth": {"on": False, "estimator": "auto", "model": "auto", "resolution": 512},
    # THE MASK CARD: settings, not an effect. Any card can be limited to the
    # subject or the background; this is where the mask comes from (the pack's
    # own auto-mask, or the mask wired into the standalone node) and how soft
    # its edge is, in pixels.
    "mask": {"on": False, "source": "auto", "feather": 12},
    "dof": {"on": False, "focus": 0.35, "range": 0.15, "blur": 6.0, "flip_depth": False},
    # RELIGHT: a new key light over the depth map's relief. Azimuth is where it
    # comes from (0 right, 90 top, 180 left, 270 below), elevation how high it
    # sits (0 grazing, 90 straight on). Ambient is what the unlit side keeps.
    "relight": {"on": False, "azimuth": 45.0, "elevation": 35.0, "intensity": 0.6,
                "warmth": 0.0, "ambient": 0.6, "softness": 0.5, "shadow": 0.4,
                "relief": 1.0, "flip_depth": False},
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
SETTINGS_CARDS = ("depth", "mask")
LIMITS = ("off", "subject", "background")
MATCH_METHODS = ("adain", "linear")
MATCH_SOURCES = ("file", "moodboard", "subject", "scene", "i2i", "wired")
MASK_SOURCES = ("auto", "wired")
# every effect can be limited to the subject or the background; the settings
# cards cannot, they are not effects
for _n, _blk in DEFAULTS.items():
    if _n not in SETTINGS_CARDS:
        _blk["limit"] = "off"
# the Depth card's choices: panel keys to the estimator node each one means, and
# the Depth Anything V2 checkpoints by their short names
DEPTH_ESTIMATORS = {
    "depth_anything_v2": "DepthAnythingV2Preprocessor",
    "depth_anything": "DepthAnythingPreprocessor",
    "midas": "MiDaS-DepthMapPreprocessor",
    "zoe": "Zoe-DepthMapPreprocessor",
}
DEPTH_MODELS = {"vitg": "depth_anything_v2_vitg.pth", "vitl": "depth_anything_v2_vitl.pth",
                "vitb": "depth_anything_v2_vitb.pth", "vits": "depth_anything_v2_vits.pth"}
SHARPEN_MODES = ("lucy", "unsharp")
CA_DIRECTIONS = ("horizontal", "vertical", "radial")

# the chain order: repair, tone, detail, light, lens
ORDER = ("denoise", "color", "match", "lut", "clarity", "sharpen",   # repair and grade
         "relight",                                                  # light
         "haze",                                             # the air
         "distortion", "dof", "aberration", "bloom",         # the lens...
         "light_wrap", "diffusion", "vignette",              # ...and its glare
         "halation", "rolloff", "grain")                     # the film

# effects that cannot run without a depth map wired into the node
DEPTH_EFFECTS = ("dof", "haze", "relight")


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


# ---------------------------------------------------------------------------
# colour spaces for the match card's skin hold and the LUT's log toggle
def _srgb_to_linear(t):
    return torch.where(t <= 0.04045, t / 12.92, ((t.clamp(min=0) + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(t):
    return torch.where(t <= 0.0031308, t * 12.92, 1.055 * t.clamp(min=0) ** (1 / 2.4) - 0.055)


def _rgb_to_hsv(t):
    """NCHW in 0..1 to (h, s, v), each N1HW, h in turns."""
    r, g, b = t[:, 0:1], t[:, 1:2], t[:, 2:3]
    mx = t.max(1, keepdim=True)[0]
    mn = t.min(1, keepdim=True)[0]
    d = mx - mn
    eps = 1e-8
    s_ = torch.where(mx > eps, d / (mx + eps), torch.zeros_like(mx))
    hr = ((g - b) / (d + eps)) % 6.0
    hg = (b - r) / (d + eps) + 2.0
    hb = (r - g) / (d + eps) + 4.0
    h = torch.where(mx == r, hr, torch.where(mx == g, hg, hb))
    h = torch.where(d > eps, h / 6.0, torch.zeros_like(h)) % 1.0
    return h, s_, mx


def _hsv_to_rgb(h, s_, v):
    h6 = (h % 1.0) * 6.0
    i = torch.floor(h6)
    f = h6 - i
    p = v * (1 - s_)
    q = v * (1 - s_ * f)
    t_ = v * (1 - s_ * (1 - f))
    i = i.long() % 6
    r = torch.where(i == 0, v, torch.where(i == 1, q, torch.where(i == 2, p,
        torch.where(i == 3, p, torch.where(i == 4, t_, v)))))
    g = torch.where(i == 0, t_, torch.where(i == 1, v, torch.where(i == 2, v,
        torch.where(i == 3, q, p))))
    b = torch.where(i == 0, p, torch.where(i == 1, p, torch.where(i == 2, t_,
        torch.where(i == 3, v, torch.where(i == 4, v, q)))))
    return torch.cat([r, g, b], 1)


def _skin_weight(t):
    """N1HW, 1 where the colour reads as skin: a hue window round 25 degrees, a
    saturation band that excludes grey and neon, and enough brightness to be skin."""
    h, s_, v = _rgb_to_hsv(t)
    deg = h * 360.0
    dh = torch.minimum((deg - 25.0).abs(), 360.0 - (deg - 25.0).abs())
    w_h = (1.0 - dh / 30.0).clamp(0, 1)
    w_s = ((s_ - 0.08) / 0.12).clamp(0, 1) * ((0.8 - s_) / 0.15).clamp(0, 1)
    w_v = ((v - 0.15) / 0.2).clamp(0, 1)
    return w_h * w_s * w_v


def _skin_hold(before, after, protect):
    """Give skin its hue back and cap its saturation near the original's, by the
    skin weight times protect. Everything that is not skin keeps the new grade."""
    if protect <= 0:
        return after
    w = _skin_weight(before) * float(protect)
    h0, s0, _v0 = _rgb_to_hsv(before)
    h1, s1, v1 = _rgb_to_hsv(after)
    dh = ((h0 - h1 + 0.5) % 1.0) - 0.5              # the short way round the wheel
    h2 = (h1 + dh * w) % 1.0
    cap = s0 * 1.15
    s2 = torch.where(s1 > cap, s1 + (cap - s1) * w, s1)
    return _hsv_to_rgb(h2, s2, v1)


_MATCH_SAID = {"no_ref": False}


def match(img, reference=None, method="adain", strength=1.0, skin_protect=0.5,
          source="moodboard", ref_file=""):
    """Move the picture's per-channel mean and spread onto the reference's. adain
    works in sRGB, linear in linear light. The reference's first frame is used."""
    if reference is None or strength <= 0:
        if reference is None and not _MATCH_SAID["no_ref"]:
            print("[RedNode Post] match: no reference picture, the card passed the "
                  "frame through", flush=True)
            _MATCH_SAID["no_ref"] = True
        return img
    x = _nchw(img).float()
    r = _nchw(reference[:1]).float().to(x.device)
    if r.shape[1] > 3:
        r = r[:, :3]
    if x.shape[1] > 3:
        x = x[:, :3]
    lin = method == "linear"
    xw, rw = (_srgb_to_linear(x), _srgb_to_linear(r)) if lin else (x, r)
    mu_x, sd_x = xw.mean((2, 3), keepdim=True), xw.std((2, 3), keepdim=True) + 1e-6
    mu_r, sd_r = rw.mean((2, 3), keepdim=True), rw.std((2, 3), keepdim=True) + 1e-6
    y = (xw - mu_x) * (sd_r / sd_x) + mu_r
    y = _linear_to_srgb(y.clamp(0, 1)) if lin else y
    y = y.clamp(0, 1)
    y = _skin_hold(x, y, skin_protect)
    out = x + (y - x) * float(strength)
    return _nhwc(_clamp01(out)).to(img.dtype)


# ---------------------------------------------------------------- the LUT card
_LUT_CACHE = {}


def _ensure_lut_folder():
    """models/luts as a ComfyUI model folder, registered once, so the file list
    and get_full_path work the way they do for every other model kind."""
    import folder_paths
    if "luts" in folder_paths.folder_names_and_paths:
        return
    path = os.path.join(folder_paths.models_dir, "luts")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    folder_paths.folder_names_and_paths["luts"] = ([path], {".cube"})


def lut_files():
    import folder_paths
    _ensure_lut_folder()
    try:
        return sorted(folder_paths.get_filename_list("luts"))
    except Exception:
        return []


def _load_cube(path):
    """A .cube file as (table[S, S, S, 3] indexed [b][g][r], domain_min, domain_max).
    The file lists red fastest, which is what the reshape assumes."""
    key = (path, os.path.getmtime(path))
    if key in _LUT_CACHE:
        return _LUT_CACHE[key]
    size, dmin, dmax, rows = 0, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            up = line.upper()
            if up.startswith("TITLE"):
                continue
            if up.startswith("LUT_3D_SIZE"):
                size = int(line.split()[-1])
                continue
            if up.startswith("LUT_1D_SIZE"):
                raise ValueError("1D LUTs are not supported, only LUT_3D_SIZE files")
            if up.startswith("DOMAIN_MIN"):
                dmin = [float(v) for v in line.split()[1:4]]
                continue
            if up.startswith("DOMAIN_MAX"):
                dmax = [float(v) for v in line.split()[1:4]]
                continue
            parts = line.split()
            if len(parts) >= 3:
                try:
                    rows.append([float(parts[0]), float(parts[1]), float(parts[2])])
                except ValueError:
                    continue
    if size <= 1:
        size = int(round(len(rows) ** (1.0 / 3.0)))
    if size <= 1 or len(rows) < size ** 3:
        raise ValueError("cube has %d rows for size %d" % (len(rows), size))
    table = torch.tensor(rows[:size ** 3], dtype=torch.float32).view(size, size, size, 3)
    _LUT_CACHE.clear()
    _LUT_CACHE[key] = (table, torch.tensor(dmin), torch.tensor(dmax))
    return _LUT_CACHE[key]


def lut(img, file="", strength=1.0, log=False):
    """Apply a .cube LUT, trilinear, from models/luts. strength blends and goes
    past 1 as an overdrive; log applies a 2.2 gamma in and out for LUTs cut for
    log footage."""
    if not file or file == "None" or strength <= 0:
        return img
    import folder_paths
    _ensure_lut_folder()
    path = folder_paths.get_full_path("luts", file)
    if path is None:
        print("[RedNode Post] LUT %r is not in models/luts; the card passed the frame "
              "through" % file, flush=True)
        return img
    try:
        table, dmin, dmax = _load_cube(path)
    except Exception as exc:
        print("[RedNode Post] LUT %r could not be read (%s); passed through" % (file, exc),
              flush=True)
        return img
    x = _nchw(img).float()
    if x.shape[1] > 3:
        x = x[:, :3]
    src = x.clamp(0, 1) ** (1.0 / 2.2) if log else x.clamp(0, 1)
    n, _c, h, w = src.shape
    dev = x.device
    lo = dmin.to(dev).view(1, 3, 1, 1)
    hi = dmax.to(dev).view(1, 3, 1, 1)
    rgb = ((src - lo) / (hi - lo).clamp(min=1e-6)).clamp(0, 1) * 2.0 - 1.0
    # the volume is [1, 3, B, G, R]; grid_sample's last axis is (x, y, z) = (r, g, b)
    vol = table.to(dev).permute(3, 0, 1, 2).unsqueeze(0).expand(n, -1, -1, -1, -1)
    grid = torch.stack([rgb[:, 0], rgb[:, 1], rgb[:, 2]], -1).view(n, 1, h, w, 3)
    out = F.grid_sample(vol, grid, mode="bilinear", padding_mode="border",
                        align_corners=True)[:, :, 0]
    if log:
        out = out.clamp(0, 1) ** 2.2
    res = x + (out - x) * float(strength)
    return _nhwc(_clamp01(res)).to(img.dtype)


# ---------------------------------------------------------------- the limit
_LIMIT_SAID = {"no_mask": False}


def limit_to(before, after, mask, limit, feather, name=""):
    """The effect's result only where the mask says, the rest of the frame as it
    was. mask is [1, H, W] with 1 for the subject; background is its inverse; the
    edge is softened by `feather` pixels. No mask: the whole frame, said once."""
    if limit not in ("subject", "background"):
        return after
    if mask is None:
        if not _LIMIT_SAID["no_mask"]:
            print("[RedNode Post] %s is limited to the %s but there is no mask; it ran "
                  "on the whole frame" % (name or "a card", limit), flush=True)
            _LIMIT_SAID["no_mask"] = True
        return after
    m = mask.float()
    while m.ndim > 3:
        m = m[0]
    if m.ndim == 2:
        m = m.unsqueeze(0)
    m = m[:1].unsqueeze(0).to(after.device)                       # [1, 1, H, W]
    if m.shape[-2:] != after.shape[1:3]:
        m = F.interpolate(m, size=after.shape[1:3], mode="bilinear", align_corners=False)
    if feather and feather > 0:
        m = gaussian_blur(m, float(feather) / 2.0)
    m = m.clamp(0, 1)
    if limit == "background":
        m = 1.0 - m
    m = m.permute(0, 2, 3, 1).to(after.dtype)                     # [1, H, W, 1]
    return before * (1.0 - m) + after * m


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


def _height_field(depth, like, flip, mask=None, softness=0.5):
    """[B,1,H,W] height, 1 near and 0 far, smoothed by softness; the subject mask
    adds a dome so a person reads as rounded rather than as a flat cut-out."""
    h = 1.0 - _depth_map(depth, like, flip)
    if mask is not None:
        m = mask if mask.ndim == 4 else mask.unsqueeze(1)
        m = m[:, :1].to(h.device, h.dtype)
        if m.shape[0] != h.shape[0]:
            m = m[:1].expand(h.shape[0], -1, -1, -1)
        if m.shape[2:] != h.shape[2:]:
            m = F.interpolate(m, size=h.shape[2:], mode="bilinear", align_corners=False)
        dome = gaussian_blur(m.clamp(0, 1), max(1.0, min(h.shape[2:]) * 0.04))
        h = h + dome * 0.35
    return gaussian_blur(h, 0.5 + float(softness) * 6.0)


def relight(img, depth=None, mask=None, azimuth=45.0, elevation=35.0, intensity=0.6,
            warmth=0.0, ambient=0.6, softness=0.5, shadow=0.4, relief=1.0,
            flip_depth=False):
    """A new key light over the picture's relief.

    The depth map becomes a height field, its gradient becomes normals, and a
    directional light shades them: the side facing the light keeps its
    brightness (a little more, so the picture does not simply darken), the side
    facing away falls to ambient. Contact shadows come from a short march up
    the height field towards the light: a pixel with higher ground between it
    and the light sits in shadow. Warmth tints the light itself. The subject
    mask, when the chain has one, rounds the subject off so faces light like
    faces and not like cardboard.
    """
    if depth is None:
        print("[RedNode Post] relight needs a depth map on the node's depth input; "
              "skipping it", flush=True)
        return img
    strength = max(0.0, min(1.0, float(intensity)))
    if strength <= 0:
        return img
    t = _nchw(img)
    B, _C, H, W = t.shape
    h = _height_field(depth, t, flip_depth, mask, softness)
    # normals from the gradient; relief scales how much the terrain leans
    k = 24.0 * max(0.0, float(relief))
    dx = (torch.roll(h, -1, 3) - torch.roll(h, 1, 3)) * 0.5 * k
    dy = (torch.roll(h, -1, 2) - torch.roll(h, 1, 2)) * 0.5 * k
    nx, ny, nz = -dx, dy, torch.ones_like(h)          # image y runs down; normal y up
    norm = (nx * nx + ny * ny + nz * nz).sqrt()
    nx, ny, nz = nx / norm, ny / norm, nz / norm
    az = math.radians(float(azimuth))
    el = math.radians(max(1.0, min(89.0, float(elevation))))
    lx, ly, lz = math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)
    diffuse = (nx * lx + ny * ly + nz * lz).clamp(0.0, 1.0)
    # contact shadows: march towards the light; ground higher than the line of
    # sight to the light puts this pixel in shadow
    sh = float(shadow)
    occl = torch.zeros_like(h)
    if sh > 0:
        steps, px = 10, max(1.0, min(H, W) / 96.0)
        rise = math.tan(el) * (k / 24.0) * 0.012
        ys = torch.linspace(-1, 1, H, device=t.device, dtype=t.dtype).view(1, H, 1)
        xs = torch.linspace(-1, 1, W, device=t.device, dtype=t.dtype).view(1, 1, W)
        for s in range(1, steps + 1):
            ox = lx * px * s * 2.0 / max(1, W - 1)
            oy = -ly * px * s * 2.0 / max(1, H - 1)
            grid = torch.stack([(xs + ox).expand(B, H, W), (ys + oy).expand(B, H, W)], -1)
            hs = F.grid_sample(h, grid, mode="bilinear", padding_mode="border",
                               align_corners=True)
            occl = torch.maximum(occl, ((hs - h) - rise * s).clamp(0.0, 1.0) * 6.0)
        occl = gaussian_blur(occl.clamp(0.0, 1.0), 1.5) * sh
    amb = max(0.0, min(1.0, float(ambient)))
    lit = (amb + (1.0 - amb) * diffuse) * (1.0 - occl * (1.0 - amb))
    lit = lit * 1.3                                     # the lit side gains, not just the far side losing
    w = float(warmth) * 0.5
    tint = torch.tensor([1.0 + w, 1.0, 1.0 - w], device=t.device, dtype=t.dtype).view(1, 3, 1, 1)
    gain = 1.0 + (lit * tint - 1.0) * strength
    return _clamp01(_nhwc(t * gain))


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
    "match": match, "lut": lut, "relight": relight,
}


def _guard(name, cur):
    """The per-card rules a typed coercion cannot express: a choice must be one of
    the card's own list, a size must sit inside what the card offers."""
    if name == "clarity":
        cur["blend_mode"] = cur["blend_mode"] if cur["blend_mode"] in BLEND_MODES else "soft light"
        cur["radius"] = max(1, min(64, cur["radius"]))
    elif name == "sharpen":
        cur["mode"] = cur["mode"] if cur["mode"] in SHARPEN_MODES else "lucy"
        cur["iterations"] = max(1, min(20, cur["iterations"]))
        cur["kernel_size"] = max(1, min(31, cur["kernel_size"]))
    elif name == "aberration":
        cur["direction"] = (cur["direction"] if cur["direction"] in CA_DIRECTIONS
                            else "horizontal")
    elif name == "depth":
        cur["estimator"] = cur["estimator"] if cur["estimator"] in DEPTH_ESTIMATORS else "auto"
        cur["model"] = cur["model"] if cur["model"] in DEPTH_MODELS else "auto"
        cur["resolution"] = max(128, min(2048, cur["resolution"]))
    elif name == "mask":
        cur["source"] = cur["source"] if cur["source"] in MASK_SOURCES else "auto"
        cur["feather"] = max(0, min(128, cur["feather"]))
    elif name == "match":
        cur["method"] = cur["method"] if cur["method"] in MATCH_METHODS else "adain"
        cur["source"] = cur["source"] if cur["source"] in MATCH_SOURCES else "moodboard"
    if name not in SETTINGS_CARDS and cur.get("limit") not in LIMITS:
        cur["limit"] = "off"
    return cur


def _parse_block(name, block):
    """One card's block, normalised: every key present, every value typed by its
    default, the random ranges kept only for numeric keys, then the card's guards."""
    defaults = DEFAULTS[name]
    block = block if isinstance(block, dict) else {}
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
    # random ranges: {"rand": {"intensity": [lo, hi]}} on any block, rolled fresh
    # each queue. Only keys the block actually has, and only numeric ones.
    rin = block.get("rand") if isinstance(block.get("rand"), dict) else {}
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
        cur["rand"] = rand
    return _guard(name, cur)


def parse_post(data):
    """Normalise a post config dict: every block present, every value in range,
    and the CHAIN, the effects in the order they run.

    The chain is a list of INSTANCES: one entry per run of an effect, in run
    order, each carrying its own dials, switch and Limit. The same effect may
    appear twice (a sharpen on the subject early, another on the whole frame at
    the end). A config with no chain, every config saved before the chain
    existed, gets the camera order with one instance of each effect, carrying
    the block it had, so nothing renders differently.

    The per-effect blocks stay in the result as a MIRROR of the first instance
    of each effect, for every reader that asks "is bloom on" without walking
    the chain; an effect with no instance reads as off.
    """
    out = {}
    src = data if isinstance(data, dict) else {}
    for name in DEFAULTS:
        out[name] = _parse_block(name, src.get(name))
    raw_chain = src.get("chain")
    chain = []
    if isinstance(raw_chain, list) and raw_chain:
        seen = set()
        for item in raw_chain:
            if not isinstance(item, dict):
                continue
            fx = str(item.get("fx") or "")
            if fx not in EFFECTS:
                continue                    # unknown, or a settings card
            cur = _parse_block(fx, item)
            cur["fx"] = fx
            base = str(item.get("id") or "").strip() or fx
            iid, n = base, 2
            while iid in seen:
                iid = "%s#%d" % (base, n)
                n += 1
            seen.add(iid)
            cur["id"] = iid
            chain.append(cur)
    explicit = bool(chain)
    if not chain:
        for fx in ORDER:
            cur = dict(out[fx])
            cur["fx"] = fx
            cur["id"] = fx
            chain.append(cur)
    # THE FULL RANGE IS ALWAYS THERE. Every effect keeps one BASE instance, whose
    # id is the effect's own name: it switches on and off but is never removed.
    # Extra instances (sharpen#2 ...) are the only ones that can be deleted. A
    # chain missing an effect gets its base back, off, at its camera position.
    if explicit:
        rank = {fx: i for i, fx in enumerate(ORDER)}
        for fx in ORDER:
            if any(c["id"] == fx for c in chain):
                continue
            mine = [c for c in chain if c["fx"] == fx]
            if mine:
                mine[0]["id"] = fx          # the first copy becomes the base
                continue
            cur = dict(out[fx])
            cur["on"] = False
            cur["fx"] = fx
            cur["id"] = fx
            at = next((i for i, c in enumerate(chain) if rank[c["fx"]] > rank[fx]),
                      len(chain))
            chain.insert(at, cur)
    out["chain"] = chain
    if explicit:
        base = {c["fx"]: c for c in chain if c["id"] == c["fx"]}
        for fx in ORDER:
            if fx in base:
                out[fx] = {k: v for k, v in base[fx].items() if k not in ("fx", "id")}
            else:
                out[fx] = dict(out[fx])
                out[fx]["on"] = False
    return out


def active_fx(cfg):
    """The effects with at least one instance switched on, as a set of names."""
    return {c["fx"] for c in (cfg.get("chain") or []) if c.get("on")}


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


def needs_mask(cfg):
    """True when any instance that is on is limited to the subject or the background."""
    return any(c.get("on") and c.get("limit") in ("subject", "background")
               for c in (cfg.get("chain") or []))


def auto_mask(image):
    """The pack's own subject mask for the frame (automask.py), or None, said."""
    try:
        from . import automask
        mask, used = automask.subject_mask(image)
    except Exception as exc:
        print("[RedNode Post] the auto mask failed (%s)" % exc, flush=True)
        return None
    if mask is None:
        print("[RedNode Post] no segmenter answered for the mask; limited cards run on "
              "the whole frame", flush=True)
        return None
    print("[RedNode Post] subject mask from %s" % used, flush=True)
    return mask


def apply_post(image, config, depth=None, on_effect=None, rolls=None, extra_timings=(),
               mask=None, reference=None):
    """Run the whole chain in grading order. Blocks that are off cost nothing."""
    cfg = parse_post(config)
    out = image
    timings = []
    for item in cfg.get("chain") or []:
        name = item["fx"]
        if not item.get("on"):
            continue
        args = {k: v for k, v in item.items()
                if k not in ("on", "rand", "limit", "fx", "id", "ref_file")}
        drawn = roll_block(name, item)
        if drawn:
            args.update(drawn)
            if rolls is not None:
                rolls[item["id"]] = drawn
            shown = ", ".join(f"{k} {v}" for k, v in sorted(drawn.items()))
            print(f"[RedNode Post] {item['id']} rolled {shown}", flush=True)
        if name in DEPTH_EFFECTS:
            args["depth"] = depth
        if name == "match":
            ref = reference(item) if callable(reference) else reference
            if ref is None and item.get("source") == "file":
                ref = file_reference(item.get("ref_file", ""))
            args["reference"] = ref
        if name == "relight":
            args["mask"] = mask
        started = time.time()
        res = EFFECTS[name](out, **args)
        # LIMITED TO THE SUBJECT OR THE BACKGROUND: this instance's result only
        # under the mask, softened by the Mask card's feather; the rest of the
        # frame as it was before it
        res = limit_to(out, res, mask, item.get("limit", "off"),
                       cfg["mask"]["feather"], item["id"])
        out = res
        timings.append((item["id"], time.time() - started))
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


# ---------------------------------------------------------------------------
# Saved ORDERS: a name and the run order of the effects that were on when it was
# saved, as instance ids. A look saves the whole chain (dials, switches and order);
# an order saves the order alone, so one order can be laid over any look. Applying
# one moves the effects it names into that order and skips the rest.
def _orders_path(make=False):
    return os.path.join(os.path.dirname(_presets_path(make=make)), "post_orders.json")


def load_orders():
    """{name: [instance id, ...]}"""
    try:
        with open(_orders_path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for name, ids in (data.get("orders") or {}).items():
        if isinstance(ids, list):
            clean = [str(i) for i in ids if isinstance(i, str) and i]
            out[str(name)] = list(dict.fromkeys(clean))
    return out


def _write_orders(orders):
    path = _orders_path(make=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"orders": orders}, f, indent=2)
    os.replace(tmp, path)


def save_order(name, ids):
    name = str(name or "").strip()
    if not name:
        raise ValueError("an order needs a name")
    if not isinstance(ids, list) or not ids:
        raise ValueError("an order needs at least one effect that is on")
    orders = load_orders()
    orders[name] = list(dict.fromkeys(str(i) for i in ids if isinstance(i, str) and i))
    _write_orders(orders)
    return orders


def delete_order(name):
    orders = load_orders()
    orders.pop(str(name or ""), None)
    _write_orders(orders)
    return orders


# the most recent graded frame, so "save this look" has a picture to save. Held in
# memory only: it is a preview, not something worth writing to disk every run.
LAST_THUMB = {"uri": ""}

# what the random ranges actually drew last run, so the panel can show it back
LAST_ROLLS = {}


# Depth of field and haze need to know what is near and what is far, and working
# that out takes a neural net rather than maths on the pixels. Rather than make
# you wire a second node for it, drive whichever depth estimator you have
# installed, exactly as the auto prompt drives WD14 and JoyCaption.
DEPTH_NODES = tuple(DEPTH_ESTIMATORS.values())


def _depth_node(want="auto"):
    """The estimator class and name: the one the Depth card asks for when it is
    installed, else the first installed one, with a line saying which."""
    try:
        import nodes
    except Exception:
        return None, ""
    maps = getattr(nodes, "NODE_CLASS_MAPPINGS", {})
    if want and want != "auto":
        name = DEPTH_ESTIMATORS.get(want, "")
        cls = maps.get(name)
        if cls is not None:
            return cls, name
        print("[RedNode Post] the Depth card asks for %s, which is not installed; "
              "using whichever estimator is" % (name or want), flush=True)
    for name in DEPTH_NODES:
        cls = maps.get(name)
        if cls is not None:
            return cls, name
    return None, ""


def auto_depth(image, resolution=512, settings=None):
    """A depth map for `image` from the installed estimator, or None.

    `settings` is the Depth card: which estimator, which Depth Anything V2
    checkpoint and the working resolution. Without it the first installed
    estimator runs at its own defaults, which is what this did before the card.
    """
    st = settings if isinstance(settings, dict) else {}
    want = str(st.get("estimator") or "auto")
    try:
        resolution = int(st.get("resolution") or resolution)
    except (TypeError, ValueError):
        pass
    cls, name = _depth_node(want)
    if cls is None:
        print("[RedNode Post] depth of field and haze need a depth map. Install "
              "comfyui_controlnet_aux (it brings Depth Anything V2) or wire one into "
              "the depth input; skipping those two for now.", flush=True)
        return None
    try:
        fn = getattr(cls(), cls.FUNCTION)
        accepted = set(inspect.signature(fn).parameters)
        kwargs = {"image": image, "resolution": int(resolution)}
        # the checkpoint choice is Depth Anything V2's vocabulary; every other
        # wrapper names its file differently or has none, so it is left to them
        model = str(st.get("model") or "auto")
        ckpt = ""
        if model in DEPTH_MODELS and name == "DepthAnythingV2Preprocessor":
            ckpt = DEPTH_MODELS[model]
            kwargs["ckpt_name"] = ckpt
        result = fn(**{k: v for k, v in kwargs.items() if k in accepted})
        if isinstance(result, dict):
            result = result.get("result", (None,))
        out = result[0] if isinstance(result, (list, tuple)) else result
        if out is None:
            return None
        print(f"[RedNode Post] depth map made with {name} at {int(resolution)}"
              + (f", {ckpt}" if ckpt else ""), flush=True)
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
    got = workspaces_from_prompt(prompt)
    return got[0] if got else None


def workspaces_from_prompt(prompt):
    """(post cfg, the workspace's raw config dict), the one with something on first."""
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
            data = json.loads(raw) or {}
            cfg = parse_post(data.get("post"))
        except (ValueError, TypeError):
            continue
        found.append((cfg, data if isinstance(data, dict) else {}))
    if not found:
        return None
    # a workspace with something switched on wins over one sitting at defaults
    for cfg, data in found:
        if any(cfg[n].get("on") for n in ORDER):
            return cfg, data
    return found[0]


def file_reference(name, long_edge=1024):
    """A picture dropped onto the Match card, from the input folder, as an IMAGE
    tensor; None, said once, when it is gone or unreadable. ComfyUI's own path
    helper refuses a name that climbs out of the input folder."""
    name = str(name or "").strip()
    if not name:
        return None
    try:
        import numpy as np
        import folder_paths
        from PIL import Image, ImageOps
        path = folder_paths.get_annotated_filepath(name)
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((long_edge, long_edge))
            arr = np.asarray(im).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None]
    except Exception as exc:
        print("[RedNode Post] the Match card's reference picture %r could not be read (%s)"
              % (name, exc), flush=True)
        return None


def match_resolver(ws_raw=None, wired=None):
    """A reference per Match instance: its own dropped picture, a Workspace tab's
    picture, or the wired input. Each source is read once per run however many
    Match instances use it."""
    cache = {}

    def resolve(item):
        src = str(item.get("source") or "moodboard")
        key = (src, item.get("ref_file", "") if src == "file" else "")
        if key in cache:
            return cache[key]
        if src == "file":
            ref = file_reference(item.get("ref_file", ""))
        elif src == "wired":
            ref = wired
        else:
            ref = tab_reference(ws_raw, src)
        cache[key] = ref
        return ref
    return resolve


def tab_reference(ws_raw, name):
    """The picture a Workspace tab has selected (moodboard, subject, scene, i2i), as
    an IMAGE tensor, through the Detailer's tab reader; None when the tab is off."""
    if name not in ("moodboard", "subject", "scene", "i2i") or not isinstance(ws_raw, dict):
        return None
    try:
        from . import workspace as _ws
        from .refine_pipeline import RedNodeStudioDetailer
        cfg = _ws.parse_config(json.dumps(ws_raw))
        return RedNodeStudioDetailer._tab_tensor(cfg, name)
    except Exception as exc:
        print("[RedNode Post] could not read the %s tab for the match card (%s)" % (name, exc),
              flush=True)
        return None


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
        got = workspaces_from_prompt(prompt)
        cfg, ws_raw = (got if got else (None, {}))
        if not cfg or not any(cfg[n].get("on") for n in ORDER):
            return (image,)
        if isinstance(ws_raw, dict) and ws_raw.get("draft"):
            print("[RedNode Post] the Workspace's Draft switch is on; the chain is skipped "
                  "and the picture passes through", flush=True)
            return (image,)
        # depth of field and haze need a depth map; make one rather than asking the
        # user to build a second branch of the graph for it
        depth = None
        extra = []
        if active_fx(cfg) & set(DEPTH_EFFECTS):
            _t0 = time.time()
            depth = auto_depth(image, settings=cfg.get("depth"))
            extra.append(("depth map", time.time() - _t0))
        # a card limited to the subject wants a mask: the pack's own auto-mask
        mask = None
        if needs_mask(cfg):
            _t0 = time.time()
            mask = auto_mask(image)
            extra.append(("subject mask", time.time() - _t0))
        # the match card's reference is a Workspace tab's picture
        reference = None
        if "match" in active_fx(cfg):
            reference = match_resolver(ws_raw=ws_raw)
        ran = []
        LAST_ROLLS.clear()
        out = apply_post(image, cfg, depth=depth, on_effect=ran.append,
                         rolls=LAST_ROLLS, extra_timings=extra, mask=mask,
                         reference=reference)
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
                "depth": ("IMAGE", {"tooltip": "OPTIONAL. The node makes its own depth "
                                    "map, set up on the panel's Depth card; wire this "
                                    "only to supply a map of your own"}),
                "mask": ("MASK", {"tooltip": "OPTIONAL. A subject mask for cards limited "
                                  "to the subject or the background. Without it the "
                                  "node makes its own with the pack's auto-mask; the "
                                  "Mask card chooses which"}),
                "reference": ("IMAGE", {"tooltip": "OPTIONAL. The picture the Match "
                                        "reference card matches the frame's colour to, "
                                        "when the card's Reference is The reference input. "
                                        "A picture dropped on the card needs no wire"}),
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
    def IS_CHANGED(cls, image=None, config="{}", depth=None, mask=None, reference=None):
        try:
            cfg = parse_post(own_post(config))
        except Exception:
            return float("nan")
        if any(cfg[n].get("on") and cfg[n].get("rand") for n in ORDER):
            return float("nan")
        return json.dumps(cfg, sort_keys=True)

    def run(self, image, config="{}", depth=None, mask=None, reference=None):
        cfg = parse_post(own_post(config))
        if not any(cfg[n].get("on") for n in ORDER):
            return (image,)
        if depth is None and any(cfg[n].get("on") for n in DEPTH_EFFECTS):
            depth = auto_depth(image, settings=cfg.get("depth"))
        if needs_mask(cfg):
            if cfg["mask"].get("source") == "wired" and mask is None:
                print("[RedNode Post FX] the Mask card says wired but nothing is wired "
                      "into mask; making one instead", flush=True)
            if mask is None or cfg["mask"].get("source") != "wired":
                mask = mask if mask is not None else auto_mask(image)
        else:
            mask = None
        ran = []
        LAST_ROLLS.clear()
        # the Match card: a dropped picture or the wired input. This node reads
        # nothing from the rest of the graph, so the Workspace tabs are not its to use
        resolver = reference
        if "match" in active_fx(cfg):
            resolver = match_resolver(ws_raw=None, wired=reference)
        out = apply_post(image, cfg, depth=depth, on_effect=ran.append, rolls=LAST_ROLLS,
                         mask=mask, reference=resolver)
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
