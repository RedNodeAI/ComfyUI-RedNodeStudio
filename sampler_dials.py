"""Sampler dials per rig: the built-in sampler's extra controls, all off by default.

  shift      AuraFlow shift on the rig's model (core's ModelSamplingAuraFlow patch),
             0 = the model as it loads.
  dd         Detail Daemon: at each step the model is told a slightly smaller sigma
             than the schedule's, by a curve over the run, so it paints finer detail
             late without more steps. The curve is re-implemented from the MIT
             description (Jonseed's ComfyUI-Detail-Daemon; credit in the README),
             nothing of that pack is imported.
  variance   Seed Variance: for the first part of the run a fraction of the text
             conditioning's values are jittered by a small amount, so the same seed
             and prompt land on a different composition. The clean conditioning is
             back for the rest of the steps.
  q21_shift  Qwen Image 2.1's size-aware shift: its own scheduler's mu for the canvas
             being sampled, and the schedule's last step on sigma 0.02.
  densify    the tail of the schedule resampled to more steps, so the detail band
             gets the extra steps and the rest of the run stays as it was.
  focus      the same steps bent toward high noise (structure) or low noise (detail).
  quick      Quick start: the steps before the grow point run on a half-size latent
             (the layout is decided there, as well as at full size), then the state
             is grown back and the run carries on. About half the sampling time on
             a flow model's first pass. After the SPEED idea (Xiao, Chao, Yariv and
             Wetzstein, 2026); the maths is written here from the paper.

Everything here works on the sigma schedule and a clone of the model, through the
model function wrapper (Quick start through a sampler wrapper), so the wired originals
are never touched. sample_with_dials is the one entry the Workspace's built-in sampler
and the Detailer call; with nothing on and no custom schedule it is exactly core's
common_ksampler.
"""
import json
import math

import numpy as np
import torch

import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import nodes as _core

DD_DEFAULTS = {"on": False, "amount": 0.1, "start": 0.2, "end": 0.8, "bias": 0.5,
               "exponent": 1.0, "start_offset": 0.0, "end_offset": 0.0, "fade": 0.0,
               "smooth": True, "cfg_scale": 1.0}
VAR_DEFAULTS = {"on": False, "percent": 0.3, "strength": 0.05, "window": 0.3}
DENS_DEFAULTS = {"on": False, "last": 0.3, "extra": 4}
QUICK_DEFAULTS = {"on": False, "grow_at": 0}


def _num(d, key, lo, hi, dv):
    try:
        v = float(d.get(key, dv))
    except (TypeError, ValueError, AttributeError):
        v = dv
    if v != v:                                   # NaN
        v = dv
    return max(lo, min(hi, v))


def parse_dials(r):
    """The four dials off a raw rig dict, clamped, every field present."""
    r = r if isinstance(r, dict) else {}
    dd = r.get("dd") if isinstance(r.get("dd"), dict) else {}
    va = r.get("variance") if isinstance(r.get("variance"), dict) else {}
    de = r.get("densify") if isinstance(r.get("densify"), dict) else {}
    qk = r.get("quick") if isinstance(r.get("quick"), dict) else {}
    return {
        "shift": _num(r, "shift", 0.0, 100.0, 0.0),
        # Qwen Image 2.1's own size-aware shift (qwen21_mu below), off by default
        "q21_shift": bool(r.get("q21_shift")),
        "dd": {
            "on": bool(dd.get("on")),
            "amount": _num(dd, "amount", -5.0, 5.0, 0.1),
            "start": _num(dd, "start", 0.0, 1.0, 0.2),
            "end": _num(dd, "end", 0.0, 1.0, 0.8),
            "bias": _num(dd, "bias", 0.0, 1.0, 0.5),
            "exponent": _num(dd, "exponent", 0.0, 10.0, 1.0),
            "start_offset": _num(dd, "start_offset", -1.0, 1.0, 0.0),
            "end_offset": _num(dd, "end_offset", -1.0, 1.0, 0.0),
            "fade": _num(dd, "fade", 0.0, 1.0, 0.0),
            "smooth": dd.get("smooth", True) is not False,
            "cfg_scale": _num(dd, "cfg_scale", 0.0, 100.0, 1.0),
            # classic: the smaller sigma reaches the whole model call; look: only the
            # timestep the model is shown, the denoising maths keeps the real sigma
            "method": "look" if dd.get("method") == "look" else "classic",
            # steps: start and end are shares of this pass's steps; noise: shares of
            # the model's own noise range, the same place in any pass layout
            "window": "noise" if dd.get("window") == "noise" else "steps",
        },
        "variance": {
            "on": bool(va.get("on")),
            "percent": _num(va, "percent", 0.0, 1.0, 0.3),
            "strength": _num(va, "strength", 0.0, 1.0, 0.05),
            "window": _num(va, "window", 0.0, 1.0, 0.3),
        },
        "densify": {
            "on": bool(de.get("on")),
            "last": _num(de, "last", 0.0, 1.0, 0.3),
            "extra": int(round(_num(de, "extra", 0, 60, 4))),
        },
        # the schedule bent toward structure (below 0) or detail (above 0); 0 = as it is
        "focus": _num(r, "focus", -1.0, 1.0, 0.0),
        # Quick start: grow_at 0 picks the step itself (the one nearest noise 0.7)
        "quick": {
            "on": bool(qk.get("on")),
            "grow_at": int(round(_num(qk, "grow_at", 0, 200, 0))),
        },
        # a sampler node from another pack in place of ComfyUI's KSampler
        # (sampler_nodes.py); rides the dials so every call that samples on the rig
        # carries it
        "node": _sampler_node(r.get("sampler_node")),
    }


def _sampler_node(raw):
    try:
        from .sampler_nodes import parse_node
    except ImportError:            # loaded as a plain file (tests)
        from sampler_nodes import parse_node
    return parse_node(raw)


# ------------------------------------------------------------------ extra schedulers
# Three schedule shapes core does not ship, each one proven on Krea 2 in the field: a
# beta curve at 0.5 / 0.7 (RES4LYF's usual pair), an arctangent sigmoid after
# RES4LYF's bong tangent, and a tanh hyperbolic. Each is a
# unit curve of positions into the model's own sigma table, indexed the way core's
# beta scheduler indexes, so shift and the flow range come from the model, not from
# here. A rig names them like any scheduler; the sockets hand a stock KSampler
# "simple" instead, since core would reject the name.
EXTRA_SCHEDULERS = ("beta57", "bong_tangent", "hyperbolic")


def scheduler_ok(name):
    return name in comfy.samplers.KSampler.SCHEDULERS or name in EXTRA_SCHEDULERS


def unit_curve(name, steps):
    """`steps` positions from 1 (all noise) down toward 0, one per step."""
    steps = max(1, int(steps))
    if name == "beta57":
        import scipy.stats
        ts = 1.0 - np.linspace(0.0, 1.0, steps, endpoint=False)
        return np.clip(scipy.stats.beta.ppf(ts, 0.5, 0.7), 0.0, 1.0)
    if name == "bong_tangent":
        slope, pivot = 0.2, 0.6 * steps
        x = np.arange(steps, dtype=np.float64)
        s_ = ((2.0 / math.pi) * np.arctan(-slope * (x - pivot)) + 1.0) / 2.0
        lo, hi = float(s_[-1]), float(s_[0])
        return (s_ - lo) / max(1e-9, hi - lo) if steps > 1 else np.ones(1)
    if name == "hyperbolic":
        k = 1.0
        x = np.linspace(0.0, 1.0, steps, endpoint=False)
        return (np.tanh(k * (1.0 - 2.0 * x)) + math.tanh(k)) / (2.0 * math.tanh(k))
    raise KeyError(name)


def extra_sigmas(model, name, steps):
    """The schedule for an extra name, read off the model's sigma table like core's
    beta scheduler: a position per step, duplicates dropped, a final 0."""
    ms = model.get_model_object("model_sampling")
    total = len(ms.sigmas) - 1
    idx = np.rint(unit_curve(name, steps) * total).astype(int)
    sigs, last = [], -1
    for i in idx:
        if i != last:
            sigs.append(float(ms.sigmas[int(i)]))
        last = i
    sigs.append(0.0)
    return torch.FloatTensor(sigs)


def any_on(dials):
    d = dials or {}
    return bool((d.get("dd") or {}).get("on") or (d.get("variance") or {}).get("on")
                or (d.get("densify") or {}).get("on") or (d.get("quick") or {}).get("on")
                or abs(float(d.get("focus") or 0.0)) >= 1e-6)


# ------------------------------------------------------------------ quick start
# The first steps of a render decide the layout, and they decide it as well on a
# half-size latent. So the run starts small: the starting noise is shrunk by keeping
# the low quarter of its cosine spectrum (orthonormal, so white noise stays white at
# the same strength), the steps up to the grow point run there, then the state is
# grown back in the same spectrum with fresh noise in the empty high band and the
# run carries on at full size. Every step before the grow costs a quarter.
#
# The maths of the grow, for a flow model (x = (1 - t) picture + t noise): padding the
# small state's spectrum into a full-size one leaves its picture part 1/r as strong
# as a full-size picture (r = full / small per side) while its noise part stays at
# level t, so the padded state is scaled by k = r / (1 + (r - 1) t) to be a proper
# full-size state again, at noise level k t. For the SDXL family (x = picture +
# sigma noise) the scale is r and the run carries on at r sigma; its auto grow point
# is read on the same 0..1 scale, t = sigma / (1 + sigma).
#
# After SPEED (Xiao, Chao, Yariv and Wetzstein, 2026, spectral progressive
# diffusion). Written here from the paper; nothing of any implementation imported.
QUICK_NOISE_FLOW = 0.7     # auto: grow at the step nearest this noise level (flow models)
QUICK_NOISE_SIGMA = 0.6    # the same on t = sigma / (1 + sigma) for the SDXL family
QUICK_MIN_START = 0.9      # a pass starting with less noise keeps the layout it was given
_DCT = {}


def _dct_matrix(n, device):
    """The orthonormal DCT-II matrix for n points: coefficients = D @ signal."""
    key = (int(n), str(device))
    m = _DCT.get(key)
    if m is None:
        k = torch.arange(n, dtype=torch.float64).unsqueeze(1)
        i = torch.arange(n, dtype=torch.float64).unsqueeze(0)
        m = torch.cos(math.pi * (2 * i + 1) * k / (2 * n)) * math.sqrt(2.0 / n)
        m[0] /= math.sqrt(2.0)
        m = m.to(device=device, dtype=torch.float32)
        _DCT[key] = m
    return m


def spectrum(x):
    """The cosine spectrum of the last two (height, width) dims."""
    h, w = x.shape[-2:]
    return _dct_matrix(h, x.device) @ x.float() @ _dct_matrix(w, x.device).T


def unspectrum(c):
    h, w = c.shape[-2:]
    return _dct_matrix(h, c.device).T @ c @ _dct_matrix(w, c.device)


def shrink_noise(x, h, w):
    """x at full size -> h x w, keeping the low part of its spectrum."""
    return unspectrum(spectrum(x)[..., :h, :w].contiguous()).to(x.dtype)


def grow_state(y, H, W, level, seed, kind="flow"):
    """The small state at noise `level` -> a full-size state, and the level it
    carries on at (see the notes above)."""
    h, w = y.shape[-2:]
    c = torch.zeros(*y.shape[:-2], H, W, device=y.device, dtype=torch.float32)
    c[..., :h, :w] = spectrum(y)
    g = torch.Generator(device="cpu").manual_seed(int(seed) & 0xFFFFFFFF)
    fresh = torch.randn(*y.shape[:-2], H, W, generator=g).to(y.device)
    fresh[..., :h, :w] = 0.0            # fresh noise only where the small state had nothing
    c = c + float(level) * fresh
    r = math.sqrt((H * W) / float(h * w))
    k = r if kind == "sigma" else r / (1.0 + (r - 1.0) * float(level))
    return (unspectrum(c) * k).to(y.dtype), k * float(level)


def noise_kind(model_sampling, sigmas=None):
    """'flow' (Krea 2, Z-Image, Flux, Qwen Image, Wan), 'sigma' (SDXL, SD 1.5 and the
    other eps / v models), or None for a sampling this does not know."""
    try:
        import comfy.model_sampling as ms
        if model_sampling is not None:
            if isinstance(model_sampling, ms.CONST):
                return "flow"
            if (isinstance(model_sampling, (ms.EPS, ms.V_PREDICTION))
                    and not isinstance(model_sampling, getattr(ms, "EDM", ()))):
                return "sigma"
            return None
    except Exception:
        pass
    if sigmas is not None:
        try:
            return "flow" if float(sigmas.max()) <= 1.001 else None
        except Exception:
            return None
    return None


def _unit_level(s, kind):
    """A noise level on the 0..1 scale: t for flow, sigma / (1 + sigma) otherwise."""
    return float(s) if kind == "flow" else float(s) / (1.0 + float(s))


def quick_plan(sigmas, grow_at, kind="flow"):
    """The step the picture grows at, counted from the pass's first step, or None to
    stay at full size. grow_at 0 picks the step nearest the auto noise level. The
    last step always runs at full size, the last two when the pass ends at 0 and
    has four or more steps: that is where the detail is made."""
    n = len(sigmas) - 1
    if n < 2:
        return None
    lv = [_unit_level(float(v), kind) for v in sigmas]
    keep = 2 if (lv[-1] <= 0.0 and n >= 4) else 1
    target = QUICK_NOISE_FLOW if kind == "flow" else QUICK_NOISE_SIGMA
    if int(grow_at) > 0:
        j = int(grow_at)
    else:
        j = min(range(1, n), key=lambda i: (abs(lv[i] - target), i))
    return max(1, min(j, n - keep))


def _model_sampling_of(model_k):
    """The live model_sampling behind a sampler's model callable, or None."""
    m = model_k
    for _ in range(6):
        p = getattr(m, "model_patcher", None)
        if p is not None:
            try:
                return p.get_model_object("model_sampling")
            except Exception:
                return None
        m = getattr(m, "inner_model", None)
        if m is None:
            break
    return None


def _half_start(model_k, x, s0, h, w, kind):
    """The starting state at half size: the noise shrinks as noise, the picture as a
    picture (its spectrum is r times its half-size version's). An empty latent is
    pure noise. None when the two cannot be told apart."""
    lat, nz = getattr(model_k, "latent_image", None), getattr(model_k, "noise", None)
    if torch.is_tensor(lat) and torch.is_tensor(nz) and lat.shape == x.shape:
        if not torch.count_nonzero(lat):
            return shrink_noise(x, h, w)
        r = math.sqrt((x.shape[-2] * x.shape[-1]) / float(h * w))
        lat = lat.to(x.device, x.dtype)
        if kind == "sigma":
            return (shrink_noise(lat, h, w) / r + shrink_noise(x - lat, h, w)).to(x.dtype)
        nz = nz.to(x.device, x.dtype)
        return ((1.0 - s0) * shrink_noise(lat, h, w) / r + s0 * shrink_noise(nz, h, w)).to(x.dtype)
    return shrink_noise(x, h, w) if s0 >= 0.99 else None


def quick_sampler(inner, grow_at=0, tag="RedNode sampler dials"):
    """A sampler around `inner` (a KSAMPLER) that runs the steps before the grow
    point at half size. It stands aside, saying why, on a masked run, a pass that
    starts below QUICK_MIN_START, a model sampling it does not know or too few steps."""
    inner_fn, inner_opts = inner.sampler_function, dict(getattr(inner, "extra_options", {}) or {})

    def run(model_k, x, sigmas, extra_args=None, callback=None, disable=None, **_kw):
        extra_args = dict(extra_args or {})

        def go(xx, ss, offset):
            cb = None
            if callback is not None:
                cb = lambda d, _o=offset: callback({**d, "i": d["i"] + _o})
            return inner_fn(model_k, xx, ss, extra_args=extra_args, callback=cb,
                            disable=disable, **inner_opts)

        why = None
        if extra_args.get("denoise_mask") is not None:
            why = "a mask is on, and it works on the whole picture only"
        kind = None if why else noise_kind(_model_sampling_of(model_k), sigmas)
        if why is None and kind is None:
            why = "this model's noise type is not one it knows (flow and SDXL families are)"
        if why is None and _unit_level(float(sigmas[0]), kind) < QUICK_MIN_START:
            why = ("the pass starts at noise %.2f, so the layout is already set"
                   % _unit_level(float(sigmas[0]), kind))
        j = None if why else quick_plan(sigmas, grow_at, kind)
        if j is None and why is None:
            why = "too few steps"
        if j is None:
            print("[%s] quick start sits out: %s" % (tag, why), flush=True)
            return go(x, sigmas, 0)
        H, W = int(x.shape[-2]), int(x.shape[-1])
        h, w = max(2, int(round(H / 2))), max(2, int(round(W / 2)))
        xs = _half_start(model_k, x, float(sigmas[0]), h, w, kind)
        if xs is None:
            print("[%s] quick start sits out: the starting picture and its noise cannot be "
                  "told apart" % tag, flush=True)
            return go(x, sigmas, 0)
        y = go(xs, sigmas[:j + 1], 0)
        X, lvl = grow_state(y, H, W, float(sigmas[j]), int(extra_args.get("seed") or 0) + 7, kind)
        rest = torch.cat([torch.tensor([lvl], dtype=sigmas.dtype, device=sigmas.device),
                          sigmas[j + 1:]])
        n = len(sigmas) - 1
        print("[%s] quick start: %d of %d steps at half size (latent %d x %d of %d x %d), "
              "grown at noise %.3f and carried on at %.3f, %d at full size"
              % (tag, j, n, w, h, W, H, float(sigmas[j]), lvl, n - j), flush=True)
        return go(X, rest, j)

    return comfy.samplers.KSAMPLER(run, extra_options={},
                                   inpaint_options=dict(getattr(inner, "inpaint_options", {}) or {}))


# ------------------------------------------------------------------ the curve
def detail_schedule(steps, start, end, bias, amount, exponent, start_offset,
                    end_offset, fade, smooth):
    """One multiplier per step: 0 outside the window, rising from `start` to a
    peak of `amount` at the bias point, falling back to 0 by `end`. The rise and
    fall are cosine-eased when smooth, then raised to `exponent`; the two offsets
    are the floor before and after the window; fade scales the whole curve down."""
    steps = max(1, int(steps))
    start, end = min(start, end), max(start, end)
    mid = start + bias * (end - start)
    curve = np.zeros(steps, dtype=np.float64)
    if steps == 1:
        curve[0] = amount * (1.0 - fade)
        return curve
    s_i, m_i, e_i = [int(round(x * (steps - 1))) for x in (start, mid, end)]
    rise = np.linspace(0.0, 1.0, m_i - s_i + 1)
    fall = np.linspace(1.0, 0.0, e_i - m_i + 1)
    if smooth:
        rise = 0.5 * (1.0 - np.cos(rise * math.pi))
        fall = 0.5 * (1.0 - np.cos(fall * math.pi))
    rise = rise ** exponent
    fall = fall ** exponent
    rise = rise * (amount - start_offset) + start_offset
    fall = fall * (amount - end_offset) + end_offset
    curve[s_i:m_i + 1] = rise
    curve[m_i:e_i + 1] = fall
    curve[:s_i] = start_offset
    curve[e_i + 1:] = end_offset
    return curve * (1.0 - fade)


# ------------------------------------------------------------------ schedules
def rig_sigmas(model, sampler, scheduler, steps, denoise=1.0):
    """The schedule core's KSampler would run, denoise trim included; an extra
    scheduler name builds its own with the same trim rule."""
    if scheduler in EXTRA_SCHEDULERS:
        steps = max(1, int(steps))
        if denoise is None or denoise > 0.9999:
            return _terminal(model, extra_sigmas(model, scheduler, steps))
        if denoise <= 0.0:
            return torch.FloatTensor([])
        new_steps = int(steps / denoise)
        return _terminal(model, extra_sigmas(model, scheduler, new_steps)[-(steps + 1):])
    ks = comfy.samplers.KSampler(model, steps=max(1, int(steps)), device=model.load_device,
                                 sampler=sampler, scheduler=scheduler, denoise=denoise,
                                 model_options=model.model_options)
    return _terminal(model, ks.sigmas)


def _terminal(model, sigmas):
    term = (getattr(model, "model_options", None) or {}).get("rn_q21_terminal")
    return stretch_terminal(sigmas, term) if term else sigmas


def densify(sigmas, last, extra):
    """The last `last` fraction of the schedule resampled to `extra` more steps by
    linear interpolation on the step index, both ends pinned; the head untouched."""
    sig = sigmas.detach().float().cpu()
    n = len(sig) - 1
    extra = int(extra)
    if n < 1 or extra <= 0 or last <= 0:
        return sigmas
    k = int(round((1.0 - float(last)) * n))
    k = max(0, min(n - 1, k))
    tail = sig[k:]
    m = len(tail) - 1
    pos = np.linspace(0.0, float(m), m + extra + 1)
    new_tail = np.interp(pos, np.arange(m + 1, dtype=np.float64), tail.numpy().astype(np.float64))
    new_tail[0], new_tail[-1] = float(tail[0]), float(tail[-1])
    out = torch.cat([sig[:k], torch.tensor(new_tail, dtype=sig.dtype)])
    return out.to(sigmas.device, sigmas.dtype)


def refocus(sigmas, focus):
    """The schedule's steps moved toward structure or detail: `focus` below 0 bunches
    the steps at high noise (composition), above 0 at low noise (texture), 0 leaves it
    alone. Same step count, both ends pinned; the sigma curve is resampled on warped
    positions, the way densify resamples the tail."""
    try:
        f = float(focus or 0.0)
    except (TypeError, ValueError):
        f = 0.0
    if f != f:                                   # NaN
        f = 0.0
    f = max(-1.0, min(1.0, f))
    sig = sigmas.detach().float().cpu()
    n = len(sig) - 1
    if abs(f) < 1e-6:
        return sigmas
    # the closing 0 is not a step to bend toward: the warp runs over the sigmas above
    # it, so the model's floor (SDXL's sigma_min, Qwen 2.1's 0.02 tail) stays put
    ends_zero = n >= 1 and float(sig[-1]) == 0.0
    m = n - 1 if ends_zero else n
    if m < 2:                                    # one interval has nothing to bend
        return sigmas
    g = 1.0 + 2.0 * abs(f)
    u = np.linspace(0.0, 1.0, m + 1)
    w = (1.0 - (1.0 - u) ** g) if f > 0 else (u ** g)
    out = np.interp(w * m, np.arange(m + 1, dtype=np.float64), sig[:m + 1].numpy().astype(np.float64))
    out[0], out[m] = float(sig[0]), float(sig[m])
    if ends_zero:
        out = np.append(out, 0.0)
    return torch.tensor(out, dtype=sig.dtype).to(sigmas.device, sigmas.dtype)


def segments(sigmas, counts):
    """The schedule cut into consecutive runs of `counts` steps, the cut sigma on
    both sides, for the hand-off's continuation: pass 1 runs the first segment and
    leaves its noise, the next pass carries on from that sigma with no new noise.
    A short schedule ends the last segment early; a long one gives the last pass
    the remainder."""
    n = len(sigmas) - 1
    out, at = [], 0
    counts = [max(0, int(c)) for c in counts]
    for i, c in enumerate(counts):
        if i == len(counts) - 1:
            b = n
        else:
            b = min(n, at + c)
        if b <= at:
            out.append(sigmas[at:at + 1])
        else:
            out.append(sigmas[at:b + 1])
        at = b
    return out


# ------------------------------------------------------------------ the model
def apply_shift(model, shift):
    """Core's AuraFlow shift on a clone of the model; 0 leaves it alone."""
    try:
        shift = float(shift or 0.0)
    except (TypeError, ValueError):
        shift = 0.0
    if shift <= 0.0 or model is None:
        return model
    try:
        from comfy_extras.nodes_model_advanced import ModelSamplingAuraFlow
        return ModelSamplingAuraFlow().patch_aura(model, shift)[0]
    except Exception as exc:
        print("[RedNode sampler dials] shift %.2f could not be applied (%s); the model "
              "runs as it loads" % (shift, exc), flush=True)
        return model


# ------------------------------------------------------------------ Qwen Image 2.1
# Qwen Image 2.1's published scheduler moves its shift with the picture: mu runs from
# 0.5 at 256 tokens to 0.9 at 8192 (one token per 16 px square, one per latent cell)
# and the schedule is stretched so its last step lands on sigma 0.02. Core fixes mu at
# 0.69, the 1024 x 1024 value, so any other canvas samples with the wrong shift.
Q21_BASE_TOKENS, Q21_BASE_MU = 256, 0.5
Q21_MAX_TOKENS, Q21_MAX_MU = 8192, 0.9
Q21_TERMINAL = 0.02
_Q21_SAMPLING = None


def is_qwen21(model):
    try:
        return type(model.model.model_config).__name__ == "QwenImage21"
    except AttributeError:
        return False


def qwen21_mu(h, w):
    """mu for a latent of h x w cells, the scheduler's straight line, not clamped."""
    n = max(1, int(h)) * max(1, int(w))
    return Q21_BASE_MU + (Q21_MAX_MU - Q21_BASE_MU) * (n - Q21_BASE_TOKENS) / float(
        Q21_MAX_TOKENS - Q21_BASE_TOKENS)


def stretch_terminal(sigmas, terminal):
    """The schedule stretched so its last non-zero sigma is `terminal`, the top held
    (diffusers' shift_terminal)."""
    sig = sigmas.detach().float().cpu()
    nz = sig > 0
    if not bool(nz.any()) or terminal <= 0:
        return sigmas
    last = float(sig[nz][-1])
    if last >= 1.0:
        return sigmas
    scale = (1.0 - last) / (1.0 - float(terminal))
    out = sig.clone()
    out[nz] = 1.0 - (1.0 - sig[nz]) / scale
    return out.to(sigmas.device, sigmas.dtype)


def mark_qwen21(model, on):
    """A clone of a Qwen Image 2.1 model flagged for the size-aware shift, which the
    sampler call applies once it knows the canvas; anything else comes back as is."""
    if not on or model is None or not is_qwen21(model):
        return model
    m = model.clone()
    m.model_options["rn_q21_dyn"] = True
    return m


def qwen21_shift(model, hw, quiet=False):
    """A clone sampling with mu for this canvas and the 0.02 tail, on a flagged model."""
    global _Q21_SAMPLING
    opts = getattr(model, "model_options", None) or {}
    if not opts.get("rn_q21_dyn") or opts.get("rn_q21_terminal"):
        return model
    import comfy.model_sampling as _ms
    if _Q21_SAMPLING is None:
        class _Q21Sampling(_ms.ModelSamplingFlux, _ms.CONST):
            pass
        _Q21_SAMPLING = _Q21Sampling
    mu = qwen21_mu(*hw)
    s = _Q21_SAMPLING(model.model.model_config)
    s.set_parameters(shift=mu)
    m = model.clone()
    m.add_object_patch("model_sampling", s)
    m.model_options["rn_q21_terminal"] = Q21_TERMINAL
    if not quiet:
        print("[RedNode sampler dials] Qwen 2.1 shift for %d x %d px: mu %.3f, last step "
              "sigma %.2f" % (int(hw[1]) * 16, int(hw[0]) * 16, mu, Q21_TERMINAL), flush=True)
    return m


DENSE = 1000     # points on the by-noise detail curve


def progress_of(ms, sigma):
    """How far along the run this sigma is on a model_sampling's own noise range: 0 at
    pure noise, 1 at done. Measured on the model's timestep between its top and its
    floor, so flow models read 1 - sigma, discrete models their index, and an EDM model
    (whose timestep goes negative below sigma 1) still counts straight. None when the
    object cannot say. The one place this ratio is written: the dials, the schedule
    preview and the starting-noise note all read it."""
    try:
        dev = ms.sigmas.device

        def ts(v):
            return float(ms.timestep(torch.tensor([float(v)], device=dev)).float().max())
        tm, tmax, tmin = ts(sigma), ts(float(ms.sigma_max)), ts(float(ms.sigma_min))
        span = tmax - tmin
        if span <= 0:
            return None
        return max(0.0, min(1.0, (tmax - tm) / span))
    except Exception:
        return None


def noise_progress(apply_model, sigma):
    """progress_of on the live model behind a bound apply_model; None without one."""
    ms = getattr(getattr(apply_model, "__self__", None), "model_sampling", None)
    return None if ms is None else progress_of(ms, sigma)


def make_wrapper(sigmas, dials, seed, cfg_scale, prev=None):
    """The model function wrapper for one sampling run: Detail Daemon's sigma nudge
    and Seed Variance's conditioning jitter, by step. `prev` is an existing wrapper
    to keep in the chain."""
    sig = sigmas.detach().float().cpu()
    n = max(1, len(sig) - 1)
    dd = (dials or {}).get("dd") or {}
    va = (dials or {}).get("variance") or {}
    curve = None
    look = dd.get("method") == "look"
    by_noise = dd.get("window") == "noise"
    if dd.get("on"):
        # by noise: a dense curve over the model's whole noise range, read at the
        # call's own position, so start and end mean the same in every pass layout
        curve = detail_schedule(DENSE if by_noise else n, dd["start"], dd["end"], dd["bias"],
                                dd["amount"], dd["exponent"], dd["start_offset"],
                                dd["end_offset"], dd["fade"], dd["smooth"])
        scale = float(dd.get("cfg_scale") or 0.0) or float(cfg_scale or 1.0)
    var_on = bool(va.get("on")) and va.get("strength", 0) > 0 and va.get("percent", 0) > 0
    warned = [False]

    def wrapper(apply_model, args):
        x, t, c = args["input"], args["timestep"], dict(args.get("c") or {})
        sigma_f = 0.0
        try:
            sigma_f = float(t.max().detach().cpu())
            idx = int(torch.argmin((sig - sigma_f).abs()).item())
        except Exception:
            idx = 0
        idx = max(0, min(n - 1, idx))
        restore = None
        if curve is not None:
            at = idx
            if by_noise:
                p = noise_progress(apply_model, sigma_f)
                at = idx * DENSE // max(1, n) if p is None else int(round(p * (DENSE - 1)))
                at = max(0, min(DENSE - 1, at))
            adj = float(curve[at]) * 0.1 * scale
            lie = max(1e-6, 1.0 - adj)
            if look:
                # LOOK ONLY: the model's timestep embedding sees the smaller sigma, the
                # input scaling and the denoised maths keep the real one. The live
                # model_sampling is looked up per call, since an object patch can
                # replace it between runs.
                ms = getattr(getattr(apply_model, "__self__", None), "model_sampling", None)
                if ms is not None and abs(adj) > 1e-9:
                    orig_ts, had = ms.timestep, "timestep" in ms.__dict__
                    ms.timestep = lambda s, _o=orig_ts, _l=lie: _o(s * _l)
                    restore = (ms, orig_ts, had)
                elif ms is None:
                    # another pack re-wrapped the model call, so there is no live
                    # model_sampling to show the lie to: the classic nudge instead
                    t = t * lie
                    if not warned[0]:
                        warned[0] = True
                        print("[RedNode sampler dials] look only: no live model sampling on "
                              "this call, nudging the sigma the classic way", flush=True)
            else:
                t = t * lie
        try:
            return _call(apply_model, args, x, t, c, idx)
        finally:
            if restore is not None:
                ms, orig_ts, had = restore
                if had:
                    ms.timestep = orig_ts
                else:
                    try:
                        del ms.timestep
                    except AttributeError:
                        pass

    def _call(apply_model, args, x, t, c, idx):
        if var_on and (idx / n) < float(va.get("window", 0.0)):
            ctx = c.get("c_crossattn")
            if torch.is_tensor(ctx) and ctx.ndim >= 2:
                g = torch.Generator(device="cpu").manual_seed(int(seed) * 1009 + idx)
                keep = torch.rand(ctx.shape[:-1], generator=g) < float(va["percent"])
                noise = torch.randn(ctx.shape, generator=g)
                spread = float(ctx.detach().float().std().cpu())
                amp = float(va["strength"]) * (spread if spread > 0 else 1.0)
                ctx = ctx + (noise * amp).to(ctx.device, ctx.dtype) * keep.unsqueeze(-1).to(ctx.device, ctx.dtype)
                c["c_crossattn"] = ctx
        if prev is not None:
            inner = dict(args)
            inner["input"], inner["timestep"], inner["c"] = x, t, c
            return prev(apply_model, inner)
        return apply_model(x, t, **c)
    return wrapper


def dial_model(model, sigmas, dials, seed, cfg_scale):
    """A clone of the model carrying the wrapper, or the model itself with nothing on."""
    dd_on = bool(((dials or {}).get("dd") or {}).get("on"))
    va = (dials or {}).get("variance") or {}
    var_on = bool(va.get("on")) and va.get("strength", 0) > 0 and va.get("percent", 0) > 0
    if not (dd_on or var_on):
        return model
    m = model.clone()
    prev = (m.model_options or {}).get("model_function_wrapper")
    m.set_model_unet_function_wrapper(make_wrapper(sigmas, dials, seed, cfg_scale, prev))
    return m


# ------------------------------------------------------------------ the sampler
def ksample(model, seed, steps, cfg, sampler, scheduler, positive, negative, latent,
            sigmas=None, disable_noise=False, quick=None):
    """core's common_ksampler with an explicit schedule and a no-new-noise switch.
    The live-frame stream wraps latent_preview.prepare_callback, so it works here
    exactly as it does on the core call. With `quick` on, the named sampler is
    wrapped by quick_sampler and the run goes through core's custom-sampler path,
    which takes a sampler object; everything else about the call is the same."""
    latent_image = latent["samples"]
    latent_image = comfy.sample.fix_empty_latent_channels(
        model, latent_image, latent.get("downscale_ratio_spacial", None),
        latent.get("downscale_ratio_temporal", None))
    if disable_noise:
        noise = torch.zeros(latent_image.size(), dtype=latent_image.dtype,
                            layout=latent_image.layout, device="cpu")
    else:
        noise = comfy.sample.prepare_noise(latent_image, seed, latent.get("batch_index"))
    n_steps = (len(sigmas) - 1) if sigmas is not None else int(steps)
    callback = latent_preview.prepare_callback(model, max(1, n_steps))
    if (quick or {}).get("on") and sigmas is not None:
        sobj = quick_sampler(comfy.samplers.sampler_object(sampler), int(quick.get("grow_at") or 0))
        samples = comfy.sample.sample_custom(
            model, noise, cfg, sobj, sigmas, positive, negative, latent_image,
            noise_mask=latent.get("noise_mask"), callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=seed)
    else:
        samples = comfy.sample.sample(
            model, noise, max(1, n_steps), cfg, sampler, scheduler, positive, negative,
            latent_image, denoise=1.0, disable_noise=disable_noise,
            noise_mask=latent.get("noise_mask"), sigmas=sigmas, callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=seed)
    out = dict(latent)
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples
    return out


def sample_with_dials(model, seed, steps, cfg, sampler, scheduler, positive, negative,
                      latent, denoise=1.0, dials=None, sigmas=None, disable_noise=False,
                      start_step=None, last_step=None, force_full_denoise=False):
    """The one call the Workspace and the Detailer make. Nothing on and no custom
    schedule: core's common_ksampler, exactly as before. Otherwise the rig's schedule
    is built the way core builds it, densified if asked, the model clone gets the
    wrapper, and the run goes through ksample."""
    # A RIG MADE OF YOUR OWN NODES (custom_rig.py, rig_chain.py): while a caller samples on
    # one, its own sampler runs instead, with this call's model, prompts, latent and numbers
    # Qwen 2.1's size-aware shift: the canvas is known only here
    if latent is not None and torch.is_tensor(latent.get("samples")):
        model = qwen21_shift(model, tuple(latent["samples"].shape[-2:]))
    from . import rig_chain as _rigc
    _rig = _rigc.active()
    if _rig:
        return _rigc.run_rig(_rig, model, seed, steps, cfg, sampler, scheduler,
                             positive, negative, latent, denoise=denoise,
                             start_step=start_step, last_step=last_step, sigmas=sigmas)
    dials = dials or {}
    # A SAMPLER NODE FROM ANOTHER PACK, named on the rig: it runs the call when it
    # can express it, and hands it back to the built-in sampler when it cannot
    if (dials.get("node") or {}).get("id"):
        from . import sampler_nodes as _sn
        if any_on(dials):
            print("[RedNode sampler dials] the rig's sampler node runs this, so its "
                  "Detail Daemon, Seed Variance, densify and focus dials sit out", flush=True)
        got = _sn.run(dials["node"], model, seed, steps, cfg, scheduler, positive, negative,
                      latent, denoise=denoise, sigmas=sigmas, disable_noise=disable_noise,
                      start_step=start_step, last_step=last_step)
        if got is not None:
            return got
    if (sigmas is None and not any_on(dials) and scheduler not in EXTRA_SCHEDULERS
            and not (getattr(model, "model_options", None) or {}).get("rn_q21_terminal")):
        # only the keywords that differ from core's defaults travel, so a caller
        # (or a test's stand-in) that knows only denoise= keeps working
        kw = {"denoise": denoise}
        if disable_noise:
            kw["disable_noise"] = True
        if start_step:
            kw["start_step"] = start_step
        if last_step is not None:
            kw["last_step"] = last_step
        if force_full_denoise:
            kw["force_full_denoise"] = True
        return _core.common_ksampler(
            model, seed, steps, cfg, sampler, scheduler, positive, negative, latent, **kw)[0]
    if sigmas is None:
        sigmas = rig_sigmas(model, sampler, scheduler, steps, denoise)
        n = len(sigmas) - 1
        a = int(start_step or 0)
        b = n if last_step is None else min(n, int(last_step))
        if a > 0 or b < n:
            sigmas = sigmas[max(0, min(a, n - 1)):b + 1]
            if force_full_denoise and len(sigmas) > 1:
                sigmas = sigmas.clone()
                sigmas[-1] = 0.0
        de = dials.get("densify") or {}
        if de.get("on"):
            before = len(sigmas) - 1
            sigmas = densify(sigmas, de.get("last", 0.3), de.get("extra", 0))
            print("[RedNode sampler dials] densify: the last %d%% of the schedule "
                  "runs %d steps instead of %d" % (round(float(de.get("last", 0.3)) * 100),
                                                   len(sigmas) - 1 - (before - int(round(before * float(de.get("last", 0.3))))),
                                                   int(round(before * float(de.get("last", 0.3))))), flush=True)
        if abs(float(dials.get("focus") or 0.0)) >= 1e-6:
            sigmas = refocus(sigmas, dials["focus"])
            print("[RedNode sampler dials] focus %+.2f: the steps lean toward %s"
                  % (float(dials["focus"]), "detail" if float(dials["focus"]) > 0 else "structure"),
                  flush=True)
    m = dial_model(model, sigmas, dials, seed, cfg)
    if (dials.get("dd") or {}).get("on"):
        print("[RedNode sampler dials] detail daemon amount %.2f, %.0f%% to %.0f%% of the %s%s"
              % (dials["dd"]["amount"], dials["dd"]["start"] * 100, dials["dd"]["end"] * 100,
                 "noise range" if dials["dd"].get("window") == "noise" else "steps",
                 ", look only" if dials["dd"].get("method") == "look" else ""), flush=True)
    if (dials.get("variance") or {}).get("on"):
        print("[RedNode sampler dials] seed variance: %.0f%% of the conditioning at %.2f "
              "for the first %.0f%% of steps" % (dials["variance"]["percent"] * 100,
                                                 dials["variance"]["strength"],
                                                 dials["variance"]["window"] * 100), flush=True)
    # core's KSampler only needs the name for a schedule it is not building
    core_sched = scheduler if scheduler in comfy.samplers.KSampler.SCHEDULERS else "simple"
    return ksample(m, seed, len(sigmas) - 1, cfg, sampler, core_sched, positive, negative,
                   latent, sigmas=sigmas, disable_noise=disable_noise,
                   quick=dials.get("quick"))
