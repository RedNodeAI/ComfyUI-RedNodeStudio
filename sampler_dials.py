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
  densify    the tail of the schedule resampled to more steps, so the detail band
             gets the extra steps and the rest of the run stays as it was.

Everything here works on the sigma schedule and a clone of the model, through the
model function wrapper, so the wired originals are never touched. sample_with_dials is
the one entry the Workspace's built-in sampler and the Detailer call; with nothing on
and no custom schedule it is exactly core's common_ksampler.
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
    return {
        "shift": _num(r, "shift", 0.0, 100.0, 0.0),
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
    }


# ------------------------------------------------------------------ extra schedulers
# Three schedule shapes core does not ship, chosen off Lonecat's Krea 2 graph, where
# they run on every render: a beta curve at 0.5 / 0.7 (RES4LYF's usual pair), an
# arctangent sigmoid after RES4LYF's bong tangent, and a tanh hyperbolic. Each is a
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
                or (d.get("densify") or {}).get("on"))


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
            return extra_sigmas(model, scheduler, steps)
        if denoise <= 0.0:
            return torch.FloatTensor([])
        new_steps = int(steps / denoise)
        return extra_sigmas(model, scheduler, new_steps)[-(steps + 1):]
    ks = comfy.samplers.KSampler(model, steps=max(1, int(steps)), device=model.load_device,
                                 sampler=sampler, scheduler=scheduler, denoise=denoise,
                                 model_options=model.model_options)
    return ks.sigmas


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


def make_wrapper(sigmas, dials, seed, cfg_scale, prev=None):
    """The model function wrapper for one sampling run: Detail Daemon's sigma nudge
    and Seed Variance's conditioning jitter, by step. `prev` is an existing wrapper
    to keep in the chain."""
    sig = sigmas.detach().float().cpu()
    n = max(1, len(sig) - 1)
    dd = (dials or {}).get("dd") or {}
    va = (dials or {}).get("variance") or {}
    curve = None
    if dd.get("on"):
        curve = detail_schedule(n, dd["start"], dd["end"], dd["bias"], dd["amount"],
                                dd["exponent"], dd["start_offset"], dd["end_offset"],
                                dd["fade"], dd["smooth"])
        scale = float(dd.get("cfg_scale") or 0.0) or float(cfg_scale or 1.0)
    var_on = bool(va.get("on")) and va.get("strength", 0) > 0 and va.get("percent", 0) > 0

    def wrapper(apply_model, args):
        x, t, c = args["input"], args["timestep"], dict(args.get("c") or {})
        try:
            sigma_f = float(t.max().detach().cpu())
            idx = int(torch.argmin((sig - sigma_f).abs()).item())
        except Exception:
            idx = 0
        idx = max(0, min(n - 1, idx))
        if curve is not None:
            adj = float(curve[idx]) * 0.1 * scale
            t = t * max(1e-6, 1.0 - adj)
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
            sigmas=None, disable_noise=False):
    """core's common_ksampler with an explicit schedule and a no-new-noise switch.
    The live-frame stream wraps latent_preview.prepare_callback, so it works here
    exactly as it does on the core call."""
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
    dials = dials or {}
    if sigmas is None and not any_on(dials) and scheduler not in EXTRA_SCHEDULERS:
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
    m = dial_model(model, sigmas, dials, seed, cfg)
    if (dials.get("dd") or {}).get("on"):
        print("[RedNode sampler dials] detail daemon amount %.2f, %.0f%% to %.0f%%"
              % (dials["dd"]["amount"], dials["dd"]["start"] * 100, dials["dd"]["end"] * 100),
              flush=True)
    if (dials.get("variance") or {}).get("on"):
        print("[RedNode sampler dials] seed variance: %.0f%% of the conditioning at %.2f "
              "for the first %.0f%% of steps" % (dials["variance"]["percent"] * 100,
                                                 dials["variance"]["strength"],
                                                 dials["variance"]["window"] * 100), flush=True)
    # core's KSampler only needs the name for a schedule it is not building
    core_sched = scheduler if scheduler in comfy.samplers.KSampler.SCHEDULERS else "simple"
    return ksample(m, seed, len(sigmas) - 1, cfg, sampler, core_sched, positive, negative,
                   latent, sigmas=sigmas, disable_noise=disable_noise)
