"""AnyPaint on the Paint tab: Krea 2 Turbo inpainting with the krea2-anypaint LoRA.

The LoRA was trained with a particular setup around it, and on its own it does little.
This module is that setup, built on ComfyUI core's Krea 2 model:

  reference  the whole crop, with the painted area filled by the median colour of the
             kept pixels (a flat grey reads as content and gets copied back), shrunk to
             a 384 px long edge. It goes to the text encoder as Picture 1, and to the
             model as a reference read at timestep 0 whose tokens sit across the whole
             target grid and attend only to each other.
  keep       everything outside the painted area grown by a 32 px border is held to the
             source at every step, on whole 2 x 2 latent tokens, so the kept pixels come
             back as they were and the border is the model's to blend.
  paste      the redraw goes back over the original with a soft edge inside the border,
             and the colour drift measured in the outer border is taken out.

The reference runs in this module's own wrapper around the diffusion model, so it does
not depend on how anything else treats Krea 2 references. Method after yijunwang2's
krea2-anypaint reference pipeline (huggingface.co/yijunwang2/krea2-anypaint).
"""
import torch
import torch.nn.functional as F
from einops import rearrange

REF_EDGE = 384           # the reference's long edge, as trained
TOKEN_PX = 16            # Krea 2: 8x VAE, 2 x 2 patches
BORDER_PX = 32           # the band around the paint the model redraws to blend
STEPS = 8
SAMPLER = "euler"        # the keep is exact for euler, the sampler it was trained with
SCHEDULER = "simple"
PICTURE_PREFIX = "Picture 1: <|vision_start|><|image_pad|><|vision_end|>"
WRAPPER_KEY = "rednode_anypaint"


def find_lora(installed):
    """The AnyPaint LoRA among the installed names, or ""."""
    hits = [n for n in (installed or []) if "anypaint" in str(n).lower()]
    return sorted(hits, key=lambda n: (len(n), n))[0] if hits else ""


def is_krea2(model):
    try:
        return type(model.model).__name__ == "Krea2"
    except AttributeError:
        return False


# ------------------------------------------------------------------------- preparation
def median_fill(rgb, gen):
    """rgb (1,H,W,3), gen (H,W) 0/1: the painted pixels set to the kept pixels' median."""
    out = rgb.clone()
    g = gen > 0.5
    kept = rgb[0][~g]
    colour = kept.median(dim=0).values if kept.numel() else torch.full((3,), 0.5)
    out[0][g] = colour.to(out.dtype)
    return out


def reference(rgb, gen):
    """The median-filled crop shrunk to a REF_EDGE long edge on the token grid."""
    import comfy.utils
    ref = median_fill(rgb, gen)
    h, w = ref.shape[1:3]
    s = min(1.0, REF_EDGE / float(max(h, w)))
    rw = max(TOKEN_PX, int(round(w * s)) // TOKEN_PX * TOKEN_PX)
    rh = max(TOKEN_PX, int(round(h * s)) // TOKEN_PX * TOKEN_PX)
    return comfy.utils.common_upscale(ref.movedim(-1, 1), rw, rh, "lanczos",
                                      "disabled").movedim(1, -1).clamp(0, 1)


def _max_sq(m, r):
    """max_pool2d over a (2r+1) square, as a row pass then a column pass: the same
    result for 2(2r+1) work per pixel instead of (2r+1)^2."""
    k = 2 * r + 1
    m = F.max_pool2d(m, (1, k), stride=1, padding=(0, r))
    return F.max_pool2d(m, (k, 1), stride=1, padding=(r, 0))


def keep_mask(gen, border_px, lh, lw):
    """The sampler's noise mask (1 = generate) at latent size: a 2 x 2 token is kept only
    when every pixel of it lies outside the paint grown by the border."""
    g = gen[None, None].float()
    r = int(border_px)
    if r > 0:
        g = _max_sq(g, r)
    keep = (F.interpolate(1.0 - g.clamp(0, 1), size=(lh, lw), mode="nearest") > 0.5).float()
    hb, wb = lh // 2, lw // 2
    kt = keep[..., :hb * 2, :wb * 2].reshape(1, 1, hb, 2, wb, 2).amin(dim=(3, 5))
    kt = kt.repeat_interleave(2, 2).repeat_interleave(2, 3)
    full = torch.zeros((1, 1, lh, lw))
    full[..., :hb * 2, :wb * 2] = kt
    return (1.0 - full)[:, 0]


def grow(m, px):
    """A (1,1,H,W) mask grown by px (square)."""
    r = int(round(px))
    return _max_sq(m, r) if r > 0 else m


def soften(m, px):
    """A (1,1,H,W) mask blurred by about px (two box passes)."""
    r = max(0, int(round(px)))
    for _ in range(2):
        if r > 0:
            m = F.pad(m, (r, r, r, r), mode="replicate")
            m = F.avg_pool2d(F.avg_pool2d(m, (1, 2 * r + 1), stride=1), (2 * r + 1, 1), stride=1)
    return m


def paste_alpha(gen, border_px):
    """The matte the redraw goes back through: the paint, grown by half the border and
    softened inside it."""
    g = gen[None, None].float()
    a = soften(grow(g, border_px * 0.5), border_px * 0.25)[0, 0].clamp(0, 1)
    return torch.maximum(a, gen.float())


def seam_colour(redraw, original, alpha, gen, border_px):
    """The redraw with the colour drift taken out: the mean difference measured in the
    ring the model redrew outside the paste (grown by the whole border, minus the
    paste), removed where the redraw is pasted. (1,H,W,3) in, same out."""
    g = gen[None, None].float()
    ring = (grow(g, border_px)[0, 0] > 0.5) & (alpha < 0.05)
    if int(ring.sum()) < 16:
        return redraw
    drift = (redraw[0][ring] - original[0][ring]).mean(dim=0)
    return (redraw - drift.view(1, 1, 1, 3).to(redraw.dtype) * alpha[None, ..., None]).clamp(0, 1)


def encode(clip, vae, words, ref):
    """Positive conditioning: the words with the reference shown to the encoder as
    Picture 1, and the reference latent read at timestep 0."""
    import node_helpers
    try:
        from comfy.text_encoders.krea2 import KREA2_TEMPLATE
        tokens = clip.tokenize(PICTURE_PREFIX + words, images=[ref], llama_template=KREA2_TEMPLATE)
    except Exception:
        tokens = clip.tokenize(PICTURE_PREFIX + words, images=[ref])
    cond = clip.encode_from_tokens_scheduled(tokens)
    lat = vae.encode(ref[..., :3])
    cond = node_helpers.conditioning_set_values(cond, {"reference_latents": [lat]}, append=True)
    return node_helpers.conditioning_set_values(cond, {"reference_latents_method": "index_timestep_zero"})


def zero_out(cond):
    """The negative: the positive's shape with nothing in it (cfg 1 never reads it)."""
    out = []
    for t, d in cond:
        d = dict(d)
        if "pooled_output" in d and d["pooled_output"] is not None:
            d["pooled_output"] = torch.zeros_like(d["pooled_output"])
        out.append([torch.zeros_like(t), d])
    return out


# ------------------------------------------------------------------------- the model
def _attend(attn, x, freqs, keep=None, extra=None, to=None):
    """Krea 2 attention; keep collects this pass's K/V, extra appends the reference's."""
    from comfy.ldm.flux.math import apply_rope
    from comfy.ldm.modules.attention import optimized_attention_masked
    q, k, v, gate = attn.wq(x), attn.wk(x), attn.wv(x), attn.gate(x)
    q = rearrange(q, "B L (H D) -> B H L D", H=attn.heads)
    k = rearrange(k, "B L (H D) -> B H L D", H=attn.kvheads)
    v = rearrange(v, "B L (H D) -> B H L D", H=attn.kvheads)
    q, k = attn.qknorm(q, k)
    q, k = apply_rope(q, k, freqs)
    if keep is not None:
        keep.append((k, v))
    if extra is not None:
        k = torch.cat((k, extra[0].to(k.dtype)), 2)
        v = torch.cat((v, extra[1].to(v.dtype)), 2)
    if attn.kvheads != attn.heads:
        r = attn.heads // attn.kvheads
        k, v = k.repeat_interleave(r, 1), v.repeat_interleave(r, 1)
    out = optimized_attention_masked(q, k, v, attn.heads, mask=None, skip_reshape=True,
                                     transformer_options=to or {})
    return attn.wo(out * torch.sigmoid(gate))


def _run_block(block, x, vec, freqs, keep=None, extra=None, to=None):
    ps, psh, pg, qs, qsh, qg = block.mod(vec)
    x = x + pg * _attend(block.attn, (1 + ps) * block.prenorm(x) + psh, freqs, keep, extra, to)
    return x + qg * block.mlp((1 + qs) * block.postnorm(x) + qsh)


def _reference_kv(dit, refs, timesteps, bs, device, dtype, th, tw, to):
    """Each block's K/V for the reference tokens alone, at timestep 0, their positions
    spread over the target's th x tw token grid (centre-sampled)."""
    import comfy.ldm.common_dit
    import comfy.utils
    from comfy.ldm.flux.layers import timestep_embedding
    p = dit.patch
    toks, poss = [], []
    for i, ref in enumerate(refs):
        if ref.ndim == 5:
            rb, rc, rt, rh5, rw5 = ref.shape
            ref = ref.reshape(rb * rt, rc, rh5, rw5)
        ref = comfy.ldm.common_dit.pad_to_patch_size(ref.to(device, dtype), (p, p))
        ref = comfy.utils.repeat_to_batch_size(ref, bs)
        rh, rw = ref.shape[-2] // p, ref.shape[-1] // p
        toks.append(rearrange(ref, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=p, pw=p))
        ids = torch.zeros(rh, rw, 3, device=device)
        ids[..., 0] = i + 1.0
        ids[..., 1] = ((torch.arange(rh, device=device) + 0.5) * (th / rh) - 0.5)[:, None]
        ids[..., 2] = ((torch.arange(rw, device=device) + 0.5) * (tw / rw) - 0.5)[None, :]
        poss.append(ids.reshape(1, rh * rw, 3).repeat(bs, 1, 1))
    h = dit.first(torch.cat(toks, 1))
    t0 = dit.tproj(dit.tmlp(timestep_embedding(torch.zeros_like(timesteps), dit.tdim)
                            .unsqueeze(1).to(h.dtype)))
    freqs = dit.pe_embedder(torch.cat(poss, 1))
    kvs = []
    for block in dit.blocks:
        got = []
        h = _run_block(block, h, t0, freqs, keep=got, to=to)
        kvs.append(got[0])
    return kvs


_KV_CACHE = {}       # one paint's reference K/V: fixed across its steps (t0, same refs)


def _forward(executor, x, timesteps, context, attention_mask=None, ref_latents=None,
             transformer_options={}, **kwargs):
    """The diffusion model with the reference attended as extra keys. No reference: the
    model as it is."""
    if not ref_latents:
        return executor(x, timesteps, context, attention_mask, ref_latents, transformer_options, **kwargs)
    import comfy.ldm.common_dit
    from comfy.ldm.flux.layers import timestep_embedding
    dit = executor.class_obj
    to = transformer_options
    temporal = x.ndim == 5
    if temporal:
        b5, c5, t5, h5, w5 = x.shape
        x = x.reshape(b5 * t5, c5, h5, w5)
    bs, _, ho, wo = x.shape
    p = dit.patch
    x = comfy.ldm.common_dit.pad_to_patch_size(x, (p, p))
    th, tw = x.shape[-2] // p, x.shape[-1] // p
    dev = x.device
    key = (tuple(tuple(r.shape) for r in ref_latents),
           tuple(round(float(r.float().mean()), 6) for r in ref_latents),
           th, tw, bs, str(dev), x.dtype)
    kvs = _KV_CACHE.get(key)
    if kvs is None:
        _KV_CACHE.clear()
        kvs = _KV_CACHE[key] = _reference_kv(dit, ref_latents, timesteps, bs, dev, x.dtype, th, tw, to)
    ctx = dit.txtmlp(dit.txtfusion(dit._unpack_context(context), mask=None, transformer_options=to))
    img = dit.first(rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=p, pw=p))
    t = dit.tmlp(timestep_embedding(timesteps, dit.tdim).unsqueeze(1).to(img.dtype))
    tvec = dit.tproj(t)
    tl, il = ctx.shape[1], img.shape[1]
    seq = torch.cat((ctx, img), 1)
    ids = torch.zeros(th, tw, 3, device=dev)
    ids[..., 1] = torch.arange(th, device=dev)[:, None]
    ids[..., 2] = torch.arange(tw, device=dev)[None, :]
    pos = torch.cat((torch.zeros(bs, tl, 3, device=dev), ids.reshape(1, th * tw, 3).repeat(bs, 1, 1)), 1)
    freqs = dit.pe_embedder(pos)
    for block, kv in zip(dit.blocks, kvs):
        seq = _run_block(block, seq, tvec, freqs, extra=kv, to=to)
    out = dit.last(seq, t)[:, tl:tl + il]
    out = rearrange(out, "b (h w) (c ph pw) -> b c (h ph) (w pw)",
                    h=th, w=tw, ph=p, pw=p, c=dit.channels)[:, :, :ho, :wo]
    if temporal:
        out = out.reshape(b5, t5, dit.channels, ho, wo).movedim(1, 2)
    return out


_LORA_CACHE = {}


def prepare_model(model, lora_name, strength=1.0):
    """A clone with the AnyPaint LoRA on it and the reference wrapper around the
    diffusion model."""
    import comfy.patcher_extension as pe
    import comfy.sd
    import comfy.utils
    import folder_paths
    m = model
    if lora_name and strength:
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        sd = _LORA_CACHE.get(path)
        if sd is None:
            _LORA_CACHE.clear()
            sd = _LORA_CACHE[path] = comfy.utils.load_torch_file(path, safe_load=True)
        m, _ = comfy.sd.load_lora_for_models(m, None, sd, float(strength), 0.0)
    m = m.clone()
    m.add_wrapper_with_key(pe.WrappersMP.DIFFUSION_MODEL, WRAPPER_KEY, _forward)
    return m


# ------------------------------------------------------------------------- one paint
def paint(model, clip, vae, rgb, gen, words, seed, steps=STEPS, border_px=BORDER_PX,
          callback_wrap=None):
    """rgb (1,H,W,3) at the working size, gen (H,W) 0/1 painted. Returns the redraw at
    the same size, colour-matched, and the paste matte (H,W)."""
    import comfy.sample
    import comfy.utils
    import latent_preview
    ref = reference(rgb, gen)
    pos = encode(clip, vae, words, ref)
    neg = zero_out(pos)
    latent = vae.encode(rgb[..., :3])
    latent = comfy.sample.fix_empty_latent_channels(model, latent)
    lh, lw = latent.shape[-2], latent.shape[-1]
    noise_mask = keep_mask(gen, border_px, lh, lw)
    noise = comfy.sample.prepare_noise(latent, int(seed))
    callback = latent_preview.prepare_callback(model, int(steps))
    _KV_CACHE.clear()
    try:
        samples = comfy.sample.sample(
            model, noise, int(steps), 1.0, SAMPLER, SCHEDULER, pos, neg, latent,
            denoise=1.0, noise_mask=noise_mask, callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=int(seed))
    finally:
        _KV_CACHE.clear()
    out = vae.decode(samples)
    while out.ndim > 4:
        out = out[0]
    out = out[:1, :, :, :3].float().cpu()
    if out.shape[1:3] != rgb.shape[1:3]:
        out = F.interpolate(out.permute(0, 3, 1, 2), size=rgb.shape[1:3], mode="bilinear",
                            align_corners=False).permute(0, 2, 3, 1)
    alpha = paste_alpha(gen.cpu(), border_px)
    out = seam_colour(out, rgb[..., :3].float().cpu(), alpha, gen.cpu(), border_px)
    return out, alpha
