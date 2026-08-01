"""Krea 2 per-layer conditioning rebalance.

Krea 2 conditions on a 12-layer Qwen3-VL hidden-state stack packed as (B, seq, 12*2560).
The DiT's txtfusion projector mixes those taps linearly, so the RATIO between taps is a real
control surface: shallow taps carry broad syntax/composition, deep taps carry fine detail
(identity, texture, precise attributes). This node exposes the layer axis and applies a
per-tap gain, with optional RMS renormalization so tap ratios change while the overall
conditioning magnitude stays constant — the quality-preserving mode (global amplification
mostly degrades likeness/color; ratios are the useful knob).

Reimplements the community mechanic from nova452/ComfyUI-ConditioningKrea2Rebalance and the
RMS-renormalized variant from huwhitememes/comfyui-krea2-conditioning (both Apache-2.0).
Set renormalize=False and multiplier=4.0 to reproduce the original node's behavior.
Extras (reference_latents, boosts, masks, pooled outputs) pass through untouched.
"""

import torch

PRESET_WEIGHTS = {
    # the classic community profile: shallow taps untouched, deep detail taps boosted
    "balanced": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.5, 5.0, 1.1, 4.0, 1.0],
    # maximum fine-detail adherence
    "detail": [0.8, 0.8, 0.9, 0.9, 1.0, 1.0, 1.2, 3.0, 6.0, 1.5, 5.0, 1.2],
    # a light nudge
    "subtle": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 1.0, 1.5, 1.0],
    # no per-layer change (pair with multiplier for a plain global scale)
    "uniform": [1.0] * 12,
}
PRESET_NAMES = list(PRESET_WEIGHTS) + ["custom"]


def _parse_weights(text):
    parts = [p.strip() for p in str(text or "").replace(";", ",").split(",") if p.strip()]
    vals = [float(p) for p in parts]
    if len(vals) < 2:
        raise ValueError("per_layer_weights needs at least 2 comma-separated values")
    return vals


def _rms(t):
    return t.pow(2).mean(dim=tuple(range(1, t.dim()))).sqrt()


def _scale_tensor(t, multiplier, weights, renormalize):
    flat = t.shape[-1]
    n = len(weights)
    if flat % n != 0:  # not a stacked-tap tensor — never break the graph
        return t * multiplier
    orig_dtype = t.dtype
    f = t.float()
    ref_rms = _rms(f) if renormalize else None
    f = f.view(*f.shape[:-1], n, flat // n)
    gains = torch.tensor(weights, dtype=f.dtype, device=f.device)
    f = (f * gains.view(*([1] * (f.dim() - 2)), n, 1)).reshape(*t.shape)
    if renormalize:
        f = f * (ref_rms / _rms(f).clamp_min(1e-8)).view(-1, *([1] * (f.dim() - 1)))
    return (f * multiplier).to(orig_dtype)


class Krea2Rebalance:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "conditioning": ("CONDITIONING",),
            "preset": (PRESET_NAMES, {"default": "balanced",
                        "tooltip": "per-tap gain profile for the 12-layer stack; 'custom' uses per_layer_weights"}),
            "per_layer_weights": ("STRING", {"default": ", ".join(str(w) for w in PRESET_WEIGHTS["balanced"]),
                        "tooltip": "comma-separated gains, one per tap (12 for Krea 2), shallow -> deep. Only used when preset = custom"}),
            "multiplier": ("FLOAT", {"default": 1.0, "min": -1000.0, "max": 1000.0, "step": 0.01,
                        "tooltip": "global gain applied after the per-layer weighting. Keep at 1.0 with renormalize ON; >1 amplifies the whole tensor and can oversaturate"}),
            "renormalize": ("BOOLEAN", {"default": True,
                        "tooltip": "hold the conditioning's overall RMS so only the tap RATIOS change (quality-preserving). OFF + multiplier 4.0 = the original community node's behavior"}),
        }}

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "rebalance"
    CATEGORY = "RedNode/Krea 2"
    DESCRIPTION = "Per-layer (12-tap) reweighting of Krea 2's Qwen3-VL conditioning stack; deep taps carry fine detail/identity. RMS-renormalized by default."

    def rebalance(self, conditioning, preset="balanced", per_layer_weights="", multiplier=1.0, renormalize=True):
        weights = _parse_weights(per_layer_weights) if preset == "custom" else PRESET_WEIGHTS[preset]
        out = []
        for cond, extras in conditioning:
            # Krea 2's stack is exactly 12 taps; a different custom count would silently reshape
            # into meaningless "bands" — reject instead.
            if cond.shape[-1] == 12 * 2560 and len(weights) != 12:
                raise ValueError(
                    f"Krea 2 Conditioning Rebalance: Krea 2 has 12 conditioning taps - provide exactly 12 "
                    f"comma-separated weights (got {len(weights)})")
            out.append([_scale_tensor(cond, multiplier, weights, renormalize), dict(extras)])
        return (out,)
