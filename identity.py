"""Krea 2 Identity Edit for ComfyUI.

In-context identity/edit conditioning for Krea 2 edit LoRAs (e.g. krea2_identity_edit_v1):
clean source latents are prepended as extra image frames, distinguished from the noisy target
only by the RoPE frame index (sources 1..N, target 0), and the instruction prompt is grounded
through Qwen3-VL with the source image(s). The negative should be grounded too (empty prompt +
same image = the training unconditional), which matters for CFG > 1 recipes.

Mechanics match the verified sd-forge-krea2-edit port (itself ported from
github.com/lbouaraba/comfyui-krea2edit), rebuilt against ComfyUI's stock Krea 2 code.
The core classes are extended at import time; with no reference latents attached the
patched paths are bit-identical to stock, so normal Krea 2 use is unaffected.
"""

import math

import torch
import torch.nn.functional as F
from einops import rearrange

import comfy.conds
import comfy.ldm.common_dit
import comfy.model_base
import comfy.utils
import node_helpers
from comfy.ldm.flux.layers import timestep_embedding
from comfy.ldm.krea2.model import SingleStreamDiT
from comfy.text_encoders.krea2 import KREA2_TEMPLATE

VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"


def krea2_template(system_prompt=""):
    """The stock Krea 2 conditioning template, with an optional vision-system-prompt
    override. Structure (turn markers, user/assistant frame) matches KREA2_TEMPLATE
    byte-for-byte — only the system text between the markers changes, so the TE's
    dynamic template-strip keeps working at any system-prompt length."""
    sp = (system_prompt or "").strip()
    if not sp:
        return KREA2_TEMPLATE
    return ("<|im_start|>system\n" + sp +
            "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n")

CROP_TOL = 0.08  # near-matched-AR tolerance for the "fit" geometry (v1.2 upstream value)


def fit_image_to_latent(image, lat_h, lat_w, fit_mode="fit"):
    """Pixel-space source prep (upstream v1.2 'fit' geometry — the blur/stretch fix): resample
    the IMAGE to the target grid BEFORE VAE-encoding, so latents are never resized (latent
    resizing softens results; plain interpolate stretches mixed-AR sources).

    fit: AR-preserving fit-inside at the target's grid density, /16 floor-snapped and capped at
    the target's /16 floor (training-matched — a different node grid produces a different
    centered offset and a visible margin seam). Near-matched AR fills the target grid exactly
    via a minimal center-crop, restoring fit == crop at matched AR.
    crop: center-crop to the target AR then resize (v1/v1.1 legacy geometry, for older weights).
    """
    px_h, px_w = lat_h * 8, lat_w * 8
    img = image[..., :3].movedim(-1, 1).float()
    ih, iw = img.shape[-2:]
    if fit_mode == "fit":
        sc = min(px_h / ih, px_w / iw)
        if ih * sc >= px_h * (1 - CROP_TOL) and iw * sc >= px_w * (1 - CROP_TOL):
            s = max(px_h / ih, px_w / iw)
            ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
            y0, x0 = (ih - ch) // 2, (iw - cw) // 2
            img = img[..., y0:y0 + ch, x0:x0 + cw]
            nh, nw = px_h, px_w
        else:
            nh = min(max(16, int(ih * sc) // 16 * 16), max(16, px_h // 16 * 16))
            nw = min(max(16, int(iw * sc) // 16 * 16), max(16, px_w // 16 * 16))
        img = F.interpolate(img, size=(nh, nw), mode="bicubic", antialias=True)
    else:
        s = max(px_h / ih, px_w / iw)
        ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
        y0, x0 = (ih - ch) // 2, (iw - cw) // 2
        img = img[..., y0:y0 + ch, x0:x0 + cw]
        img = F.interpolate(img, size=(px_h, px_w), mode="bicubic", antialias=True)
    return img.movedim(1, -1).clamp(0, 1)


def _fit_latent(src, H, W):
    """Latent-space fallback fit: center-crop to the target AR, then resize. Equals the old
    plain-bilinear behavior at matched AR; at mismatched AR it crops instead of stretching."""
    sh, sw = src.shape[-2:]
    if (sh, sw) == (H, W):
        return src
    s = max(H / sh, W / sw)
    ch, cw = min(sh, int(round(H / s))), min(sw, int(round(W / s)))
    y0, x0 = (sh - ch) // 2, (sw - cw) // 2
    src = src[..., y0:y0 + ch, x0:x0 + cw]
    return F.interpolate(src.float(), size=(H, W), mode="bilinear")


def _imgids_offset(bs, frame, gh, gw, th, tw, device):
    """Stride-1 position grid for a (gh,gw) reference centered inside a (th,tw) target frame.
    The fit path resamples pixels to the target grid density, so positions stay stride-1 BY
    CONSTRUCTION — scaling them would only manufacture skip/collision artifacts. Equals the
    plain own-grid ids when gh==th and gw==tw (offset 0)."""
    off_h, off_w = max(0, (th - gh) // 2), max(0, (tw - gw) // 2)
    ids = torch.zeros(gh, gw, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = (torch.arange(gh, device=device, dtype=torch.float32) + off_h)[:, None]
    ids[..., 2] = (torch.arange(gw, device=device, dtype=torch.float32) + off_w)[None, :]
    return ids.reshape(1, gh * gw, 3).repeat(bs, 1, 1)


_warned = set()


def _warn_once(key, msg):
    if key not in _warned:
        _warned.add(key)
        print(msg, flush=True)


def _ref_isolation_bias(txtlen, slens, tgtlen, device, dtype, out=None):
    """isolate_refs: -1e4 additive bias on ref_i -> ref_j (i != j) attention, so the references
    stop reading each other — the identity/style-bleed path in two-person edits. Text and
    target rows are untouched. (-1e4, not -inf: fp16-safe, softmax ~ 0.)

    `out` writes into an existing L×L bias instead of allocating a second one: the boost
    bias only touches TARGET rows and this only touches REF rows, so assignment into the
    boost matrix's zero ref rows equals the old allocate-then-add, at half the peak VRAM.
    """
    offs = [txtlen]
    for sl in slens:
        offs.append(offs[-1] + sl)
    L = offs[-1] + tgtlen
    bias = out if out is not None else torch.zeros(1, 1, L, L, device=device, dtype=dtype)
    for i in range(len(slens)):
        for j in range(len(slens)):
            if i != j:
                bias[:, :, offs[i]:offs[i + 1], offs[j]:offs[j + 1]] = -1e4
    return bias


def _block_span_t0(block, x, vec, vec0, span, freqs, mask, transformer_options):
    """SingleStreamBlock.forward with t=0 modulation on the reference span (ai-toolkit
    training parity, re-review plan item). Mirrors the installed block line for line —
    mod -> prenorm/scale/shift -> attn -> gate -> postnorm -> mlp -> gate — using the
    block's OWN submodules (weights and attention patches route through block.attn), but
    the ref span's scale/shift/gates come from the t=0 modulation. Full-sequence ops with
    a span overwrite: no (B, L, 6F) modulation tensor is ever materialized."""
    a, b = span
    pre_s, pre_sh, pre_g, post_s, post_sh, post_g = block.mod(vec)
    pre_s0, pre_sh0, pre_g0, post_s0, post_sh0, post_g0 = block.mod(vec0)
    n1 = block.prenorm(x)
    h = (1 + pre_s) * n1 + pre_sh
    h[:, a:b] = (1 + pre_s0) * n1[:, a:b] + pre_sh0
    att = block.attn(h, freqs, mask, transformer_options=transformer_options)
    ga = pre_g * att
    ga[:, a:b] = pre_g0 * att[:, a:b]
    x = x + ga
    n2 = block.postnorm(x)
    h2 = (1 + post_s) * n2 + post_sh
    h2[:, a:b] = (1 + post_s0) * n2[:, a:b] + post_sh0
    ml = block.mlp(h2)
    gm = post_g * ml
    gm[:, a:b] = post_g0 * ml[:, a:b]
    return x + gm


_EDIT_MASK_EPS = {}      # fallback fixed noise per shape (no sampler transaction visible)
_EDIT_MASK_RUN_EPS = {}  # noise derived from the sampler's own first latent, per sampling run


def _composite_keep(x, src, mask, feather, timesteps, transformer_options=None):
    """edit_mask input compositing (RePaint-style): inside the mask (1) the model edits
    freely; outside (0) the model INPUT is replaced with the FIRST source latent noised to
    the current sigma, so the model always sees source-consistent context. The matching
    OUTPUT blend in the caller then forces denoised == source outside the mask EXACTLY —
    velocity-space compositing that holds for euler and ancestral samplers alike. Needs the
    source on the target grid (matched AR, or fit_mode 'crop'). x is the 4D pre-pad latent.

    Returns (x, state): state is None when compositing was skipped, else (m4, keep_v) with
    keep_v = (x_raw - source) / sigma, i.e. the velocity for which the sampler's
    `denoised = x - sigma*v` equals the source."""
    s0 = src
    if s0.ndim == 5:
        sb, sc, st, sh, sw = s0.shape
        s0 = s0.reshape(sb * st, sc, sh, sw)
    s0 = s0.to(x.device, x.dtype)
    if s0.shape[-2:] != x.shape[-2:]:
        _warn_once(("edit-mask-grid", tuple(s0.shape[-2:]), tuple(x.shape[-2:])),
                   f"[Krea2 Identity Edit] edit_mask SKIPPED - the source latent {tuple(s0.shape[-2:])} is "
                   f"not on the target grid {tuple(x.shape[-2:])} (aspect-ratio-mismatched 'fit'). Match "
                   "the output AR or use fit_mode 'crop (legacy)' to use edit_mask.")
        return x, None
    if s0.shape[0] != x.shape[0]:
        s0 = s0[:1].expand(x.shape[0], *s0.shape[1:])
    if mask.shape[0] > 1:
        _warn_once(("edit-mask-batch",),
                   "[Krea2 Identity Edit] edit_mask carries a batch of masks - one mask broadcasts to "
                   "the whole batch, using mask 1")
    m = mask[:1]
    if m.ndim == 2:
        m = m[None]
    m = F.interpolate(m[None].float(), size=x.shape[-2:], mode="bilinear")[0]
    for _ in range(max(0, int(feather))):
        m = F.avg_pool2d(m[None], 3, 1, 1)[0]
    m4 = m.clamp(0, 1).to(x.device, x.dtype)[None]                  # (1,1,H,W), 1 = editable
    if torch.is_tensor(timesteps):
        sig = timesteps.to(x.device, x.dtype).reshape(-1, 1, 1, 1)
        if sig.shape[0] not in (1, x.shape[0]):
            sig = sig[:1]
    else:
        sig = torch.full((1, 1, 1, 1), float(timesteps), device=x.device, dtype=x.dtype)
    # keep-velocity from the sampler's OWN latent: denoised = x - sigma*keep_v == source,
    # step-exact with no trajectory assumption (ancestral noise injections included).
    keep_v = (x - s0) / sig.clamp(min=1e-4)
    # Model-input noise for the keep region: derive it from the sampler's first latent when
    # the run is identifiable (seed-consistent, first-step composite is then a no-op),
    # falling back to fixed per-shape noise.
    eps = None
    ss = transformer_options.get("sample_sigmas", None) if isinstance(transformer_options, dict) else None
    if ss is not None:
        rkey = (id(ss), tuple(x.shape))
        eps = _EDIT_MASK_RUN_EPS.get(rkey)
        if eps is None:
            if len(_EDIT_MASK_RUN_EPS) > 4:
                _EDIT_MASK_RUN_EPS.clear()
            eps = ((x - (1.0 - sig) * s0) / sig.clamp(min=1e-3)).detach()
            _EDIT_MASK_RUN_EPS[rkey] = eps
    if eps is None:
        key = tuple(x.shape[1:])
        eps = _EDIT_MASK_EPS.get(key)
        if eps is None:
            if len(_EDIT_MASK_EPS) > 8:
                _EDIT_MASK_EPS.clear()
            eps = torch.randn(1, *x.shape[1:], device=x.device, dtype=torch.float32)
            _EDIT_MASK_EPS[key] = eps
        eps = eps.to(x.device, x.dtype)
    x_keep = (1.0 - sig) * s0 + sig * eps                           # flow: x_t = (1-t)x0 + t*eps
    return m4 * x + (1.0 - m4) * x_keep, (m4, keep_v)


def _ref_attn_bias(boosts, txtlen, slens, tgtlen, device, dtype, boost_mask=None, grids=None,
                   tgt_grid=None, fit_flags=None):
    """ref_boost: additive attention-logit bias on the [text | refs... | target] sequence —
    target rows get log(boost) on reference-key columns, i.e. it multiplies target->reference
    attention weight before renormalization. Per-ref, aligned with the source blocks (last
    entry = last ref = the subject by workflow convention)."""
    offs = [txtlen]
    for sl in slens:
        offs.append(offs[-1] + sl)
    rows0 = offs[-1]
    L = rows0 + tgtlen
    bias = torch.zeros(1, 1, L, L, device=device, dtype=dtype)
    for i, b in enumerate(boosts):
        if b == 1.0:
            continue
        if boost_mask is not None and grids is not None and i == len(boosts) - 1:
            # region-scoped boost (upstream v1.2 mechanic): the mask, given in the LAST
            # reference's image space, is shrunk to that ref's token grid; only those
            # token columns get the boost — e.g. boost just the face, not the scene.
            gh, gw = grids[i]
            m = boost_mask
            if m.ndim == 2:
                m = m[None]
            m = m[:1]
            # Alignment: a fit-prepared ref on its OWN grid (smaller than the target's)
            # was resized whole — no crop, the raw mask maps 1:1. Every other prep path
            # (near-match fill, crop legacy, latent-space fallback) is a CENTERED crop to
            # the grid's AR — align the mask by applying the same centered AR-crop.
            own_grid = (fit_flags is not None and tgt_grid is not None
                        and fit_flags[i] and (gh, gw) != tuple(tgt_grid))
            if not own_grid:
                mh, mw = m.shape[-2:]
                ch = max(1, min(mh, round(mw * gh / gw)))
                cw = max(1, min(mw, round(mh * gw / gh)))
                y0, x0 = (mh - ch) // 2, (mw - cw) // 2
                m = m[:, y0:y0 + ch, x0:x0 + cw]
            m = F.interpolate(m[None].float(), size=(gh, gw), mode="area")[0, 0]
            cols = offs[i] + torch.nonzero(m.reshape(-1) > 0.5, as_tuple=True)[0].to(device)
            if cols.numel():
                bias[:, :, rows0:, cols] = math.log(max(b, 1e-4))
            else:
                _warn_once(("boost-mask-empty", (gh, gw)),
                           f"[Krea2 Identity Edit] ref_boost_mask covers no tokens on the {gh}x{gw} "
                           "reference grid (mask too small, or outside the cropped region) - the "
                           "subject boost is OFF this run. Enlarge the masked area.")
            continue
        bias[:, :, rows0:, offs[i]:offs[i] + slens[i]] = math.log(max(b, 1e-4))
    return bias


# --------------------------------------------------------------------------
# model_base.Krea2: forward "reference_latents" from the conditioning to the
# DiT (same contract as QwenImage/Flux edit models use).
# --------------------------------------------------------------------------

def _krea2_extra_conds(self, **kwargs):
    out = comfy.model_base.Krea2._rednode_orig_extra_conds(self, **kwargs)
    ref_latents = kwargs.get("reference_latents", None)
    if ref_latents is not None:
        out["ref_latents"] = comfy.conds.CONDList([self.process_latent_in(lat) for lat in ref_latents])
        ref_boosts = kwargs.get("reference_boosts", None)
        if ref_boosts is not None:
            out["ref_boosts"] = comfy.conds.CONDConstant(list(ref_boosts))
        ref_fit = kwargs.get("reference_fit", None)
        if ref_fit is not None:
            out["ref_fit"] = comfy.conds.CONDConstant(list(ref_fit))
        ref_bmask = kwargs.get("reference_boost_mask", None)
        if ref_bmask is not None:
            # core CONDConstant compares tensors via is_equal/torch.equal on this ABI, so
            # identical pos/neg masks batch correctly (verified against 50e5270b8).
            out["ref_boost_mask"] = comfy.conds.CONDConstant(ref_bmask)
        ref_timing = kwargs.get("reference_timing", None)
        if ref_timing is not None:
            out["ref_timing"] = comfy.conds.CONDConstant(list(ref_timing))
        if kwargs.get("reference_isolate", None):
            out["ref_isolate"] = comfy.conds.CONDConstant(True)
        ref_bblocks = kwargs.get("reference_boost_blocks", None)
        if ref_bblocks is not None:
            out["ref_boost_blocks"] = comfy.conds.CONDConstant(str(ref_bblocks))
        ref_emask = kwargs.get("reference_edit_mask", None)
        if ref_emask is not None:
            out["ref_edit_mask"] = comfy.conds.CONDConstant(ref_emask)
            out["ref_edit_feather"] = comfy.conds.CONDConstant(int(kwargs.get("reference_edit_feather", 2)))
        ref_grid = kwargs.get("reference_target_grid", None)
        if ref_grid is not None:
            out["ref_expected_grid"] = comfy.conds.CONDConstant(list(ref_grid))
        if kwargs.get("reference_t0", None):
            out["ref_t0"] = comfy.conds.CONDConstant(True)
        attn_mode = kwargs.get("reference_attention", None)
        if attn_mode and attn_mode != "auto":
            out["ref_attention"] = comfy.conds.CONDConstant(str(attn_mode))
    return out


def _krea2_extra_conds_shapes(self, **kwargs):
    out = comfy.model_base.Krea2._rednode_orig_extra_conds_shapes(self, **kwargs)
    ref_latents = kwargs.get("reference_latents", None)
    if ref_latents is not None:
        out["ref_latents"] = list([1, 16, sum(map(lambda a: math.prod(a.size()[2:]), ref_latents))])
    return out


# --------------------------------------------------------------------------
# SingleStreamDiT._forward with the in-context source branch.
# Sequence becomes [text | source(s) | target]; positions: text at frame 0,
# source k at frame k (own h/w grid), target at frame 0. Only target tokens
# are returned. Sources are resized to the target latent size in latent space.
# --------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Attention backend, scoped to the reference-conditioned forward
# ---------------------------------------------------------------------------
# comfy/ldm/krea2/model.py captures `optimized_attention_masked` at import, so swapping
# that one module attribute changes Krea 2's attention and nothing else. Doing it around
# our forward (which only runs when reference latents are attached) keeps the change
# scoped to identity/moodboard work: plain t2i in the same session is untouched, and it
# reverts immediately instead of needing a restart or a second launcher.
#
# Two reasons to reach for it:
#   * xformers + a Blackwell/50-series GPU raises "No operator found for
#     memory_efficient_attention_forward … capability (12, 0) too new" — 'auto' catches
#     exactly that case and nothing else;
#   * quantized attention (sage) can smear reference-driven detail, so 'pytorch' forces
#     plain SDPA for reference work while the rest of the session keeps its speed.
ATTENTION_MODES = ["auto", "default", "pytorch"]


def _blackwell_xformers_crash_likely():
    """Is the active attention xformers on a GPU too new for it?"""
    try:
        import comfy.ldm.modules.attention as attn
        if getattr(attn.optimized_attention_masked, "__name__", "") != "attention_xformers":
            return False
        import torch
        if not torch.cuda.is_available():
            return False
        return torch.cuda.get_device_capability(0)[0] >= 10      # Blackwell and newer
    except Exception:
        return False


class _scoped_attention:
    """Swap Krea 2's attention for the duration of one forward, then put it back."""

    def __init__(self, mode):
        self.mode = mode or "auto"
        self.prev = None
        self.mod = None

    def __enter__(self):
        if self.mode == "default":
            return self
        if self.mode == "auto" and not _blackwell_xformers_crash_likely():
            return self
        try:
            import comfy.ldm.krea2.model as k2m
            from comfy.ldm.modules.attention import attention_pytorch
            if k2m.optimized_attention_masked is attention_pytorch:
                return self                                   # already what we want
            self.mod, self.prev = k2m, k2m.optimized_attention_masked
            k2m.optimized_attention_masked = attention_pytorch
            if self.mode == "auto":
                _warn_once(("attn-auto",),
                           "[Krea2 Identity Edit] xformers cannot run on this GPU - using PyTorch "
                           "attention for the reference pass (set attention='default' to opt out).")
        except Exception as e:  # noqa: BLE001 - never block a render over this
            _warn_once(("attn-swap", str(e)),
                       f"[Krea2 Identity Edit] could not switch attention backend ({e}); continuing with stock.")
        return self

    def __exit__(self, *exc):
        if self.mod is not None:
            self.mod.optimized_attention_masked = self.prev   # always restore
        return False


def _krea2_forward(self, x, timesteps, context, attention_mask=None, *_drift, transformer_options=None, **kwargs):
    # Signature-drift guard. Older cores call (..., attention_mask, transformer_options);
    # 0.29.2+ inserts ref_latents positionally between them. Accept both.
    #
    # Must run BEFORE the delegation check below, which decides whether there is any
    # identity work to do. Deciding from kwargs alone misses positional ref_latents and
    # silently skips the whole function: bias, boost, edit mask, dials, t0.
    native_ref = None
    drift = list(_drift)
    to_positional = False                  # did transformer_options arrive in *_drift?
    if drift and isinstance(drift[-1], dict) and transformer_options is None:
        transformer_options = drift.pop()
        to_positional = True
    if drift:
        native_ref = drift.pop(0)
    ref_latents = kwargs.get("ref_latents", None) or native_ref or []

    # No identity extras on this cond -> delegate to the STORED STOCK forward with the
    # argument layout it arrived in. *_drift is the ORIGINAL tuple and still carries
    # transformer_options when it came positionally, so passing it as a keyword as well
    # gives the same argument twice.
    if not ref_latents:
        orig = SingleStreamDiT._rednode_orig_forward
        if transformer_options is None or to_positional:
            return orig(self, x, timesteps, context, attention_mask, *_drift, **kwargs)
        return orig(self, x, timesteps, context, attention_mask, *_drift,
                    transformer_options=transformer_options, **kwargs)
    if transformer_options is None:
        transformer_options = {}
    # edit_mask compositing re-imposes the FIRST ref as the pixel-faithful source; grab it
    # before the timestep window can drop the refs (locality is independent of whether the
    # refs attend this step).
    edit_mask = kwargs.get("ref_edit_mask", None)
    comp_src = ref_latents[0] if (edit_mask is not None and len(ref_latents)) else None
    # timestep window: refs participate only inside [start, end] of sampling progress
    # (0 = first step, 1 = last). Outside the window the refs are dropped from the
    # sequence entirely — identity influence without composition lock (and faster steps).
    timing = kwargs.get("ref_timing", None)
    if timing and ref_latents:
        sig0 = timesteps.flatten()[0]
        ss = transformer_options.get("sample_sigmas", None) if isinstance(transformer_options, dict) else None
        if ss is not None and ss.numel() > 1:
            # true step progress from the run's actual schedule — shift-proof, so the
            # start/end labels mean what they say under any ModelSamplingAuraFlow shift.
            idx = int(torch.argmin((ss.to(sig0.device, sig0.dtype) - sig0).abs()).item())
            progress = idx / (ss.numel() - 1)
        else:
            progress = 1.0 - float(sig0)  # fallback: raw flow time (shift-skewed)
        if not (float(timing[0]) <= progress <= float(timing[1])):
            ref_latents = []
    ref_boosts = list(kwargs.get("ref_boosts", None) or [])
    ref_fit = list(kwargs.get("ref_fit", None) or [])
    # Defensive alignment: pad from the LEFT so attached values always map to the LAST refs
    # (last ref = the subject by workflow convention, matching the boost semantics).
    n = len(ref_latents)
    ref_boosts = [1.0] * max(0, n - len(ref_boosts)) + ref_boosts[-n:] if n else []
    ref_fit = [False] * max(0, n - len(ref_fit)) + ref_fit[-n:] if n else []
    temporal = x.ndim == 5
    if temporal:
        b5, c5, t5, h5, w5 = x.shape
        x = x.reshape(b5 * t5, c5, h5, w5)
    bs, c, H_orig, W_orig = x.shape
    expected = kwargs.get("ref_expected_grid", None)
    if expected is not None and (H_orig, W_orig) != tuple(expected):
        _warn_once(("target-grid", tuple(expected), (H_orig, W_orig)),
                   f"[Krea2 Identity Edit] the conditioning was encoded for a {tuple(expected)} latent "
                   f"grid but the sampler presented {(H_orig, W_orig)} (area conditioning, latent resize "
                   "or hires pass?). Fit geometry and edit_mask may misbehave - re-encode with the "
                   "actual sampling latent as target_latent.")
    comp_state = None
    if comp_src is not None:
        x, comp_state = _composite_keep(x, comp_src, edit_mask, kwargs.get("ref_edit_feather", 2),
                                        timesteps, transformer_options)
    patch = self.patch
    x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch))
    H, W = x.shape[-2], x.shape[-1]
    h_, w_ = H // patch, W // patch

    srcs = []
    for i, source in enumerate(ref_latents):
        src = source.to(device=x.device, dtype=x.dtype)
        if src.ndim == 5:
            sb, sc, st, sh, sw = src.shape
            src = src.reshape(sb * st, sc, sh, sw)
        if src.shape[0] != bs:
            src = src[:1].expand(bs, *src.shape[1:])
        # fit-prepared refs that fit inside the target keep their OWN grid (stride-1 offset
        # positions below); everything else is fitted to the target grid in latent space.
        native = ref_fit[i] and src.shape[-2] <= H and src.shape[-1] <= W
        if src.shape[-2:] != (H, W) and not native:
            src = _fit_latent(src, H, W).to(x.dtype)
        srcs.append(comfy.ldm.common_dit.pad_to_patch_size(src, (patch, patch)))

    context = self._unpack_context(context)

    img = rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch)
    img = self.first(img)
    src_imgs = [self.first(rearrange(s_, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch)) for s_ in srcs]

    t = self.tmlp(timestep_embedding(timesteps, self.tdim).unsqueeze(1).to(img.dtype))
    tvec = self.tproj(t)

    context = self.txtfusion(context, mask=None, transformer_options=transformer_options)
    context = self.txtmlp(context)

    txtlen, imglen = context.shape[1], img.shape[1]
    srclen = sum(si.shape[1] for si in src_imgs)
    combined = torch.cat([context] + src_imgs + [img], dim=1)

    device = combined.device
    txtpos = torch.zeros(bs, txtlen, 3, device=device, dtype=torch.float32)
    src_grids = [(s_.shape[-2] // patch, s_.shape[-1] // patch) for s_ in srcs]
    # _imgids_offset == plain own-grid ids when a ref's grid matches the target's, so this is
    # bit-identical to the old positions for every non-fit ref.
    srcpos = [_imgids_offset(bs, i + 1, gh, gw, h_, w_, device) for i, (gh, gw) in enumerate(src_grids)]
    if any(f and (h_ - gh > 2 or w_ - gw > 2) for f, (gh, gw) in zip(ref_fit, src_grids)):
        _warn_once(("fit-margin", tuple(src_grids), (h_, w_)),
                   f"[Krea2 Identity Edit] fit margins >2 tokens (ref grids {src_grids} in target ({h_},{w_})): "
                   "the fit geometry is trained for matched/near-matched aspect ratios. For a big AR "
                   "change prefer 'crop (legacy)' or set the output AR closer to the source.")
    imgids = torch.zeros(h_, w_, 3, device=device, dtype=torch.float32)
    imgids[..., 1] = torch.arange(h_, device=device, dtype=torch.float32)[:, None]
    imgids[..., 2] = torch.arange(w_, device=device, dtype=torch.float32)[None, :]
    imgpos = imgids.reshape(1, h_ * w_, 3).repeat(bs, 1, 1)
    pos = torch.cat([txtpos] + srcpos + [imgpos], dim=1)

    freqs = self.pe_embedder(pos)

    want_boost = bool(src_imgs) and any(b != 1.0 for b in ref_boosts)
    want_iso = bool(kwargs.get("ref_isolate", False)) and len(src_imgs) > 1
    # boost_blocks decides how the biases can SHARE memory: with the window covering every
    # block, isolation can write straight into the boost matrix (one L×L instead of two);
    # a partial window needs isolation standalone for the out-of-window blocks.
    nb = len(self.blocks)
    lo, hi = {"all": (0, nb), "early": (0, nb // 3), "mid": (nb // 3, (2 * nb) // 3),
              "late": ((2 * nb) // 3, nb)}.get(kwargs.get("ref_boost_blocks", "all"), (0, nb))
    full_window = (lo, hi) == (0, nb)
    if want_boost or want_iso:
        L = txtlen + srclen + imglen
        n_mats = 2 if (want_boost and want_iso and not full_window) else 1
        est_mb = n_mats * L * L * combined.element_size() // (1024 * 1024)
        if est_mb > 256:
            _warn_once(("bias-vram", L, n_mats),
                       f"[Krea2 Identity Edit] ref_boost/isolate_refs build {n_mats} attention bias "
                       f"matrix(es) totalling ~{est_mb} MB at this resolution ({L} tokens). If you hit "
                       "OOM, lower the resolution or turn the dials off.")
    attn_bias = None
    if want_boost:
        attn_bias = _ref_attn_bias(ref_boosts, txtlen, [si.shape[1] for si in src_imgs], imglen,
                                   combined.device, combined.dtype,
                                   boost_mask=kwargs.get("ref_boost_mask", None), grids=src_grids,
                                   tgt_grid=(h_, w_), fit_flags=ref_fit)
    iso_bias = None
    if want_iso:
        # full window: write straight into the boost matrix (rows are disjoint — boost
        # touches target rows, isolation ref rows), halving the peak allocation. Partial
        # window: standalone, because out-of-window blocks get isolation ALONE.
        share = attn_bias if (attn_bias is not None and full_window) else None
        iso_bias = _ref_isolation_bias(txtlen, [si.shape[1] for si in src_imgs], imglen,
                                       combined.device, combined.dtype, out=share)

    # boost_blocks: the BOOST bias acts only inside [lo, hi); isolation acts at every
    # depth. With a full window the two live in ONE matrix (iso_bias is attn_bias); with
    # a partial window the standalone iso matrix serves the out-of-window blocks and the
    # in-window fused sum is built in place, exactly as before the memory work.
    if attn_bias is not None and iso_bias is not None and not full_window:
        attn_bias += iso_bias
    bias_in = attn_bias if attn_bias is not None else iso_bias

    # t=0 reference modulation (opt-in, A/B-gated): ai-toolkit edit training modulates the
    # clean ref tokens at t=0 while text+target keep the real t (verified 2026-07-23,
    # commit b1e1a83). Needs the installed block ABI (mod/prenorm/attn/postnorm/mlp);
    # unknown blocks fall back to the standard path with a warning.
    t0_span = None
    if kwargs.get("ref_t0", False) and src_imgs:
        blk0 = self.blocks[0] if nb else None
        if all(hasattr(blk0, attr) for attr in ("mod", "prenorm", "attn", "postnorm", "mlp")):
            t0 = self.tmlp(timestep_embedding(torch.zeros_like(timesteps), self.tdim).unsqueeze(1).to(img.dtype))
            tvec0 = self.tproj(t0)
            t0_span = (txtlen, txtlen + srclen)
        else:
            _warn_once(("t0-abi",),
                       "[Krea2 Identity Edit] ref_t0_modulation: this ComfyUI's SingleStreamBlock "
                       "has an unknown layout - falling back to active-timestep modulation.")
    # only the reference-carrying pass is affected; stock t2i never reaches this code
    with _scoped_attention(kwargs.get("ref_attention", "auto")):
        for bi, block in enumerate(self.blocks):
            ab = bias_in if lo <= bi < hi else iso_bias
            if t0_span is not None:
                combined = _block_span_t0(block, combined, tvec, tvec0, t0_span, freqs, ab,
                                          transformer_options)
            else:
                combined = block(combined, tvec, freqs, ab, transformer_options=transformer_options)

    # LastLayer is tokenwise: slice to target tokens BEFORE it (identical math for the
    # kept tokens, no wasted projection of text/ref rows).
    final = self.last(combined[:, txtlen + srclen:txtlen + srclen + imglen], t)
    out = final
    out = rearrange(out, "b (h w) (c ph pw) -> b c (h ph) (w pw)",
                    h=h_, w=w_, ph=patch, pw=patch, c=self.channels)
    out = out[:, :, :H_orig, :W_orig]
    if comp_state is not None:
        # velocity-space compositing: outside the mask, force denoised == source exactly.
        m4, keep_v = comp_state
        out = m4 * out + (1.0 - m4) * keep_v.to(out.dtype)
    if temporal:
        out = out.reshape(b5, t5, self.channels, H_orig, W_orig).movedim(1, 2)
    return out


# Guarded install (roadmap phase E): idempotent, reload-safe, ABI-preflighted,
# all-or-nothing for this feature's three patch sites.
from ._patchguard import install_all as _pg_install  # noqa: E402

_PATCH_OK = _pg_install([
    (comfy.model_base.Krea2, "extra_conds", "_rednode_orig_extra_conds",
     lambda orig: _krea2_extra_conds, [["self"]]),
    (comfy.model_base.Krea2, "extra_conds_shapes", "_rednode_orig_extra_conds_shapes",
     lambda orig: _krea2_extra_conds_shapes, [["self"]]),
    (SingleStreamDiT, "_forward", "_rednode_orig_forward",
     lambda orig: _krea2_forward, [["self", "x", "timesteps", "context"]]),
])


# --------------------------------------------------------------------------
# Node
# --------------------------------------------------------------------------

class Krea2IdentityEdit:
    """Grounded Krea 2 edit conditioning.

    Use one for the positive (edit instruction) and one for the negative with an EMPTY
    prompt but the SAME image(s). With no image connected it behaves exactly like a plain
    Krea 2 CLIPTextEncode. Two-ref order: scene first, subject second.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True,
                                      "tooltip": "Edit instruction. Leave empty on the negative node."}),
            },
            "optional": {
                "vae": ("VAE",),
                "image": ("IMAGE",),
                "image2": ("IMAGE",),
                "grounding_px": ("INT", {"default": 768, "min": 0, "max": 4096, "step": 32,
                                         "tooltip": "Cap on the longest side fed to Qwen3-VL (the identity LoRA trained with 384-768px). 0 = never resize."}),
                "fuse_with": ("CONDITIONING", {"tooltip": "Optional conditioning to fuse in front of this one (e.g. Krea 2 Moodboard for scene/style vibe). Its token rows are prepended; this node's identity reference latents are kept. Matches the Neo moodboard+edit fusion layout."}),
                "sources": ("KREA2_SOURCES", {"tooltip": "chained sources (Krea2 Edit Source Chain) — inserted BETWEEN image (scene) and image2 (subject), so the subject stays the LAST ref and keeps the boost/mask dials. 3+ refs is beyond the LoRA's training; identities may blend."}),
                "ref_boost": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05, "round": 0.001,
                                        "tooltip": "reference-fidelity dial: multiplies target->reference attention. Applies to the LAST ref (the subject in two-ref workflows, the only ref in single-ref). 1.0 = off; >1 pulls harder toward the reference's appearance (the v1.2 edit-LoRA author suggests 2-6); <1 loosens. Set on the POSITIVE node; leave the negative at 1.0."}),
                "ref_boost_a": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05, "round": 0.001,
                                          "tooltip": "same dial for the earlier refs (the scene in two-ref workflows). No effect in single-ref workflows. 1.0 = off"}),
                "target_latent": ("LATENT", {"tooltip": "connect your (empty) sampling latent to enable the v1.2 'fit' geometry: refs are fitted in PIXEL space to the output resolution before VAE-encoding — fixes blur from resolution mismatch and removes the match-the-aspect-ratio requirement. With CFG > 1, connect it to the negative edit node too so both passes share one geometry."}),
                "fit_mode": (["fit", "crop (legacy)"], {"default": "fit",
                             "tooltip": "how refs fit a mismatched output AR (needs target_latent + vae): fit = resample to the target grid at a centered offset, matching how the v1.2 edit LoRA was trained; crop (legacy) = center-crop to the target AR then resize (v1/v1.1 geometry, for older weights)."}),
                "ref_boost_mask": ("MASK", {"tooltip": "optional region on the LAST (subject) reference to boost, e.g. just the face — boost the identity without over-copying the rest. Draw it on the reference image (MaskEditor / LoadImage mask output)."}),
                "ref_start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                              "tooltip": "when the references become active during sampling (0 = first step). Start later (e.g. 0.2) to let composition form freely before identity locks in."}),
                "ref_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                            "tooltip": "when the references switch off (1 = last step). Refs outside the window are dropped from the sequence entirely (also faster)."}),
                "edit_mask": ("MASK", {"tooltip": "hard edit locality: white = the region the model may change. Everywhere else the FIRST source is re-imposed at each denoising step, so untouched areas stay pixel-faithful instead of relying on the LoRA. Draw it in the source image's frame. Needs the source on the target grid (matched output AR, or fit_mode 'crop (legacy)'). With CFG > 1 wire the SAME mask to the negative node too."}),
                "edit_mask_feather": ("INT", {"default": 2, "min": 0, "max": 32,
                                     "tooltip": "soft edge for edit_mask, in latent pixels (1 latent px ≈ 8 image px); 0 = hard edge"}),
                "isolate_refs": ("BOOLEAN", {"default": False,
                                 "tooltip": "multi-ref only: stop the references attending to EACH OTHER — reduces identity/style bleed between two people. No effect with a single reference."}),
                "boost_blocks": (["all", "early", "mid", "late"], {"default": "all",
                                 "tooltip": "experimental: restrict the ref_boost dials to a depth range of the DiT. early = composition/pose-leaning pull, late = texture/detail-leaning pull, all = normal. Combines with ref_boost_mask and the ref_start/ref_end window."}),
                "grounding_px_subject": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 32,
                                        "tooltip": "separate grounding cap for the 2nd+ references (the subject in two-ref order often deserves 1024+ while the scene doesn't). 0 = use grounding_px for all refs."}),
                "picture_labels": ("BOOLEAN", {"default": False,
                                   "tooltip": "EXPERIMENTAL training-parity toggle: prefix each reference with 'Picture N: ' in the grounded prompt — the exact layout ai-toolkit edit training used. Default off (all validated community results ran without it). Use the SAME setting on the negative node; A/B before adopting."}),
                "ref_t0_modulation": ("BOOLEAN", {"default": False,
                                      "tooltip": "EXPERIMENTAL training-parity toggle: modulate the clean reference tokens at timestep 0 (ai-toolkit trains this way; the LoRA author's own node does not do it at inference). Default off. Use the SAME setting on the negative node; A/B before adopting."}),
                "system_prompt": ("STRING", {"multiline": True, "default": "",
                                  "tooltip": "ADVANCED: override the vision system prompt (empty = training default 'Describe the image by detailing the color, shape...'). Steers HOW the encoder reads the references — e.g. 'Describe the person's identity, face, hair and clothing as a real human being; ignore the illustration style' for anime→real. Off-template = mildly out-of-distribution: use the SAME text on the negative node and A/B."}),
                "attention": (ATTENTION_MODES, {"default": "auto",
                              "tooltip": "attention backend for the REFERENCE pass only (plain t2i is untouched). "
                                         "auto = switch to PyTorch only when xformers cannot run on this GPU "
                                         "(RTX 50xx/Blackwell crash); pytorch = always use PyTorch SDPA here, which "
                                         "avoids quantized-attention (sage) smearing on reference detail; "
                                         "default = never change it."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "RedNode/Krea 2"

    def encode(self, clip, prompt, vae=None, image=None, image2=None, grounding_px=768, fuse_with=None, sources=None,
               ref_boost=1.0, ref_boost_a=1.0, target_latent=None, fit_mode="fit", ref_boost_mask=None,
               ref_start=0.0, ref_end=1.0, edit_mask=None, edit_mask_feather=2, isolate_refs=False,
               boost_blocks="all", grounding_px_subject=0, picture_labels=False, ref_t0_modulation=False,
               system_prompt="", attention="auto"):
        # Ref order: scene first, chained extras in the middle, the designated SUBJECT LAST.
        # The boost/mask dials always target the last ref, so chained extras can never steal
        # the subject's boost or face mask.
        chain = list(sources) if sources else []
        if image2 is not None:
            all_sources = [image] + chain + [image2]
        else:
            all_sources = [image] + chain
        n_refs = sum(1 for s in all_sources if s is not None)
        if n_refs and not _PATCH_OK:
            raise ValueError(
                "Krea 2 Identity Edit: the startup patch preflight failed (ComfyUI ABI change) - "
                "identity references are disabled this session. Check the console startup message "
                "and update RedNode Studio.")
        if n_refs and vae is None:
            raise ValueError(
                "Krea 2 Identity Edit: connect the 'vae' input (your Krea 2 / qwen_image VAE). It encodes the "
                "source image into the in-context identity latents - without it there is no identity "
                "preservation, only text grounding.")
        # A PRESET NAME IS NOT AN INSTRUCTION. Both are STRING, so a preset output wired
        # into a prompt input connects happily and then silently tells the model to edit
        # toward the literal words "custom (use settings)". Found in a real log, where
        # this node was encoding exactly that on every run: a wasted text encode at best,
        # and junk conditioning wherever it was used. Warn rather than ignore it, because
        # deciding on somebody's behalf that their prompt was a mistake is worse than
        # saying so and letting them look.
        _sentinels = ("custom (use settings)", "custom (live)", "node's own", "none")
        if str(prompt).strip().lower() in _sentinels:
            print(f"[Krea2 Identity Edit] WARNING: the prompt is {prompt.strip()!r}, "
                  "which is a PRESET NAME rather than an edit instruction. Something "
                  "like a studio preset output is wired into this node's prompt input; "
                  "both are STRING so the link is legal and silent. It is being encoded "
                  "as written.", flush=True)

        if n_refs == 0:
            if target_latent is not None:
                print("[Krea2 Identity Edit] note: target_latent has no effect without a source image")
            if ref_boost != 1.0 or ref_boost_a != 1.0:
                print("[Krea2 Identity Edit] note: ref_boost has no effect without a source image")
            if edit_mask is not None:
                print("[Krea2 Identity Edit] note: edit_mask has no effect without a source image")
        if n_refs > 2:
            print(f"[Krea2 Identity Edit] {n_refs} references - the edit LoRA trained on 1-2; expect identity blending beyond that")
        images_vl = []
        ref_latents = []
        vision_prompt = ""
        for img in all_sources:
            if img is None:
                continue
            if img.shape[0] > 1:
                print(f"[Krea2 Identity Edit] input batch of {img.shape[0]} - using frame 1 (identity refs are single images; batch the moodboard input for multiple style refs)")
            img = img[:1]
            samples = img.movedim(-1, 1)
            h, w = samples.shape[2], samples.shape[3]
            # per-ref grounding: refs after the first (the subject in two-ref order) may get
            # their own cap — the subject often deserves 1024+ while the scene doesn't.
            gpx = grounding_px if not images_vl else (grounding_px_subject or grounding_px)
            if gpx and max(h, w) > gpx:
                scale_by = gpx / max(h, w)
                vl = comfy.utils.common_upscale(samples, round(w * scale_by), round(h * scale_by), "area", "disabled")
            else:
                vl = samples
            images_vl.append(vl.movedim(1, -1)[:, :, :, :3])
            if vae is not None:
                if target_latent is not None:
                    # v1.2 pixel-space path: fit the IMAGE to the output grid, then encode —
                    # the DiT never resizes these latents (blur-proof, AR-safe).
                    lh, lw = target_latent["samples"].shape[-2:]
                    mode = "crop" if fit_mode.startswith("crop") else "fit"
                    fitted = fit_image_to_latent(img[:1], lh, lw, mode)
                    ref_latents.append(vae.encode(fitted))
                else:
                    # legacy path: encode at source resolution; the DiT fits in latent space.
                    ref_latents.append(vae.encode(img[:, :, :, :3]))
            # training-parity labels (ai-toolkit layout): "Picture N: <vision block>"
            vision_prompt += (f"Picture {len(images_vl)}: " if picture_labels else "") + VISION_BLOCK

        print(f"[Krea2 Identity Edit] encoding ({len(images_vl)} ref(s)): {(vision_prompt + prompt)[:120]!r}")
        try:
            tokens = clip.tokenize(vision_prompt + prompt, images=images_vl,
                                   llama_template=krea2_template(system_prompt))
        except Exception as e:
            raise ValueError(
                "Krea 2 Identity Edit: this CLIP cannot encode Krea 2 image prompts. Load the qwen3vl_4b "
                f"(vision) text encoder with CLIPLoader type 'krea2'. (inner error: {e})") from e
        if "qwen3vl_4b" not in tokens:
            raise ValueError(
                "Krea 2 Identity Edit: wrong text-encoder type - load the qwen3vl_4b text encoder with "
                f"CLIPLoader type 'krea2' (this CLIP produced: {', '.join(tokens)})")
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        # provenance: standard 5-row Krea 2 template tail + the label policy used, so
        # fuse_with consumers trim exactly and can flag mismatched label policies.
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
                if ref_boost == 1.0:
                    print("[Krea2 Identity Edit] note: ref_boost_mask set but ref_boost is 1.0 - the mask has nothing to scope")
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_boost_mask": ref_boost_mask})
            if target_latent is not None:
                lh, lw = target_latent["samples"].shape[-2:]
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_target_grid": [int(lh), int(lw)]})
            if ref_start >= ref_end:
                print(f"[Krea2 Identity Edit] WARNING: ref_start ({ref_start}) >= ref_end ({ref_end}) - "
                      "the refs would NEVER be active. Ignoring the window (refs stay on every step).")
            elif ref_start > 0.0 or ref_end < 1.0:
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_timing": [float(ref_start), float(ref_end)]})
            if isolate_refs:
                if len(ref_latents) > 1:
                    conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_isolate": True})
                else:
                    print("[Krea2 Identity Edit] note: isolate_refs has no effect with a single reference")
            if boost_blocks != "all":
                if any(b != 1.0 for b in boosts):
                    conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_boost_blocks": boost_blocks})
                else:
                    print("[Krea2 Identity Edit] note: boost_blocks set but the ref_boost dials are 1.0 - nothing to restrict")
            if edit_mask is not None:
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_edit_mask": edit_mask,
                                   "reference_edit_feather": int(edit_mask_feather)})
            if ref_t0_modulation:
                conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_t0": True})
            if attention and attention != "auto":
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"reference_attention": attention})
        if fuse_with:
            # Fusion layout matches Neo: [moodboard rows][edit grounding + instruction rows].
            # Krea2 text tokens all sit at RoPE position 0, so order only affects attention, not
            # positions. This node's extras (identity ref latents) are the ones that must survive.
            #
            # The fused conditioning ends with the standard template tail
            # ("<|im_end|>\n<|im_start|>assistant\n" = 5 rows) — keeping it would put a
            # description boundary mid-sequence, which K2 can read as a SECOND subject being
            # described (two-people outputs). Trim it so the fusion reads as one description.
            if len(fuse_with) > 1:
                print("[Krea2 Identity Edit] fuse_with carries scheduled segments - only the first is fused")
            f_cond = fuse_with[0][0]
            f_labels = fuse_with[0][1].get("krea2_picture_labels", None)
            if f_labels is not None and bool(f_labels) != bool(picture_labels):
                _warn_once(("fuse-label-mismatch",),
                           "[Krea2 Identity Edit] fuse_with input used a different Picture-label "
                           "policy than this node - use the same picture_labels setting on both.")
            tail = fuse_with[0][1].get("krea2_template_tail", None)
            if tail is None:
                _warn_once(("fuse-untagged",),
                           "[Krea2 Identity Edit] fuse_with input is not from this pack - assuming it "
                           "ends with the standard 5-row Krea 2 template tail. Feed a Krea 2 Moodboard "
                           "Encode (or another node from this pack) for exact fusion.")
                tail = 5 if f_cond.shape[1] > 5 else 0
            if tail and f_cond.shape[1] > tail:
                f_cond = f_cond[:, :-int(tail)]
            conditioning = [[torch.cat((f_cond.to(cond.device, cond.dtype), cond), dim=1), extras]
                            for cond, extras in conditioning]
        return (conditioning,)


