"""RedNode Identity Rescue — land an identity LoRA on a merged model.

A LoRA is a weight delta trained against ONE base. A community mix has averaged
that base away, and the reference-attention behaviour identity editing rides is
the first casualty: the LoRA still applies, the mechanism no longer fires. The
observation that started this: the Identity Edit LoRA works on the official
Krea 2 Turbo and stops putting faces on newer mixes.

The rescue: restore ONLY the layers the LoRA actually touches back toward the
base it was trained on. The LoRA's own file says which layers those are; the
base checkpoint donates just those tensors (streamed from the file, never a
full second model in memory); the difference is applied as a load-time patch,
the same mechanism a difference LoRA uses. The mix keeps its look everywhere
else, and the LoRA lands on weights it recognises.

NOT A NODE, by : this is plumbing for the Studio Workspace's
Models tab, where a rig carries a Rescue toggle instead of the graph carrying
another node. `rescue_model` is the whole public surface. At strength 1.0 the
touched layers ARE the base's; lower keeps more of the mix in them and trades
identity fidelity back for look.
"""
import json
import struct

import torch

import folder_paths

_LORA_SUFFIXES = (".lora_a.weight", ".lora_b.weight", ".lora_down.weight",
                  ".lora_up.weight", ".alpha", ".dora_scale", ".diff",
                  ".diff_b")

# THE RAM CAP. An identity LoRA can touch essentially every core layer of a
# 12B model, and holding fp16 diffs for all of them is 20+ GB on top of a
# running ComfyUI - which took your whole machine down on 2026-08-14.
# The rescue now prices the diffs from the file header BEFORE reading a single
# tensor, and past this budget it refuses and points at the offline bake
# (Comfy Development/tools/bake_rescue.py), which streams to disk instead.
import os as _os
try:
    RESCUE_MAX_MB = int(_os.environ.get("RN_RESCUE_MAX_MB", "") or 2048)
except ValueError:
    RESCUE_MAX_MB = 2048


def _header_keys(path):
    """Tensor names out of a safetensors header. Never the weights."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        head = json.loads(f.read(n))
    head.pop("__metadata__", None)
    return list(head)


def _lora_target_names(keys):
    """The layer names a LoRA file patches, suffixes stripped, case kept."""
    names = set()
    for k in keys:
        low = k.lower()
        for suf in _LORA_SUFFIXES:
            if low.endswith(suf):
                names.add(k[: len(k) - len(suf)])
                break
    return names


def _true_weight(t):
    """The real values behind a live model tensor, as float32.

    A quantised model (the mixed-precision moody mix that started this) keeps
    packed int8/fp4 storage in its state dict; raw .float() on that is garbage
    at ~100x the true magnitude, which is exactly what the magnitude guard
    caught in the field. comfy_kitchen's QuantizedTensor knows how to unpack
    itself, so ask it; anything unquantised just casts.
    """
    if hasattr(t, "dequantize"):
        try:
            return t.dequantize().float()
        except Exception:
            return t.float()      # the magnitude guard has the last word
    return t.float()


def _dequant(t, sd_get, name):
    """A base tensor as float32, scaled fp8 dequantised whichever way the file
    spells its scale.

    The official Krea 2 Turbo fp8 stores a per-tensor F32 scalar named
    "{layer}.weight_scale"; comfy's older fp8 ops used "{layer}.scale_weight".
    The first release of this file read only the second spelling, missed, and
    handed back raw fp8 values at wrong magnitudes: the diffs then DESTROYED
    the model and the render came out as pure noise. Both spellings now, and
    the caller sanity-checks magnitudes besides.
    """
    out = t.float()
    if t.dtype not in (getattr(torch, "float8_e4m3fn", None),
                       getattr(torch, "float8_e5m2", None)):
        return out
    stem = name[:-len(".weight")] if name.endswith(".weight") else name
    for sib in (stem + ".weight_scale", stem + ".scale_weight",
                name + "_scale"):
        scale = sd_get(sib)
        if scale is not None:
            return out * scale.float()
    return out          # plain unscaled fp8: the cast alone is the right answer


def rescue_model(model, base_checkpoint, lora_name, strength,
                 who="RedNode Identity Rescue"):
    """The rig's model with its LoRA-landing layers restored toward the base.

    Returns a patched CLONE, or the model untouched with a console line when
    anything is missing or unreadable: a broken rescue must never take a render
    down, it just renders the way it did before the toggle existed.
    """
    try:
        if float(strength) <= 0.0:
            return model
        import comfy.lora
        from safetensors import safe_open

        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        # the base can be a full checkpoint OR a bare diffusion model; the
        # official Krea 2 Turbo fp8 ships as the latter
        ckpt_path = None
        for folder in ("checkpoints", "diffusion_models"):
            ckpt_path = folder_paths.get_full_path(folder, base_checkpoint)
            if ckpt_path:
                break
        if not ckpt_path:
            print("[%s] base %r is in neither checkpoints nor diffusion_models; "
                  "rendering without the rescue" % (who, base_checkpoint),
                  flush=True)
            return model
        targets = _lora_target_names(_header_keys(lora_path))
        if not targets:
            print("[%s] no LoRA layers recognised in %r; the model passes "
                  "through untouched" % (who, lora_name), flush=True)
            return model

        # the same name resolution comfy's own LoRA loader uses, so whatever
        # naming style the file speaks maps to the same model keys
        key_map = comfy.lora.model_lora_keys_unet(model.model, {})
        model_keys = set()
        te_layers = 0
        offset_skipped = 0
        for name in targets:
            mk = key_map.get(name)
            if mk is None:
                if name.lower().startswith(("lora_te", "text_encoders.")):
                    te_layers += 1     # the clip's business, not this patch's
                continue
            if not isinstance(mk, str):
                offset_skipped += 1    # fused-slice patches; rare, out of scope
                continue
            model_keys.add(mk)
        if not model_keys:
            print("[%s] none of %r's layers exist on this model; is this the "
                  "right architecture?" % (who, lora_name), flush=True)
            return model

        model_sd = model.model.state_dict()
        patches = {}
        missing = 0
        wild = 0
        mb = 0.0
        with safe_open(ckpt_path, framework="pt", device="cpu") as f:
            names = set(f.keys())

            def sd_get(n):
                return f.get_tensor(n) if n in names else None

            # PRICE FIRST, READ SECOND. Resolve every key and total what the
            # fp16 diffs would weigh, from header shapes alone. Refusing here
            # costs nothing; agreeing blindly cost them their machine.
            resolved = {}
            est_mb = 0.0
            for key in sorted(model_keys):
                if model_sd.get(key) is None:
                    continue
                for cand in (key, "model." + key,
                             key[len("diffusion_model."):]
                             if key.startswith("diffusion_model.") else None):
                    if cand and cand in names:
                        resolved[key] = cand
                        break
                if key not in resolved:
                    continue
                try:
                    shape = f.get_slice(resolved[key]).get_shape()
                except Exception:
                    shape = tuple(model_sd[key].shape)
                n = 1
                for d in shape:
                    n *= int(d)
                est_mb += n * 2 / (1024.0 * 1024.0)
            if est_mb > RESCUE_MAX_MB:
                print("[%s] the diffs for %r would need about %d MB of RAM "
                      "(cap %d MB): this LoRA touches most of the model, and "
                      "patching that live is what a bake is for. Run the "
                      "offline bake (Comfy Development/tools/bake_rescue.py) "
                      "and put the baked file on the rig instead. Rescue "
                      "skipped, rendering without it."
                      % (who, lora_name, est_mb, RESCUE_MAX_MB), flush=True)
                return model

            for key in sorted(model_keys):
                mix_w = model_sd.get(key)
                ck = resolved.get(key)
                if mix_w is None or ck is None:
                    missing += 1
                    continue
                mix_w = _true_weight(mix_w)
                base_w = _dequant(f.get_tensor(ck), sd_get, ck)
                if tuple(base_w.shape) != tuple(mix_w.shape):
                    missing += 1
                    continue
                # THE MAGNITUDE GUARD. A base value that is 8x away from the
                # mix's on the same layer is not a different model, it is a
                # quantisation format this code failed to read, and patching it
                # in would (did) destroy the model. Skip the layer and say so.
                bn = float(base_w.abs().mean())
                mn = float(mix_w.float().abs().mean())
                if mn > 1e-8 and (bn > mn * 8.0 or bn * 8.0 < mn):
                    wild += 1
                    continue
                diff = (base_w - mix_w.float()).to(torch.float16)
                patches[key] = ("diff", (diff,))
                mb += diff.numel() * 2 / (1024.0 * 1024.0)

        if wild and wild >= len(patches):
            # most layers failed the magnitude check: the whole read is suspect,
            # and half a rescue is worse than none
            print("[%s] the base's values are far from the mix's on %d layer(s)"
                  " - a quantisation format this code cannot read safely. "
                  "Rescue aborted, rendering without it." % (who, wild),
                  flush=True)
            return model
        m = model.clone()
        applied = m.add_patches(patches, float(strength))
        line = ("[%s] %d layer(s) restored toward %r at strength %.2f "
                "(%.0f MB of diffs)"
                % (who, len(applied), base_checkpoint, strength, mb))
        if wild:
            line += ", %d skipped on the magnitude guard" % wild
        if missing:
            line += ", %d not found in the base" % missing
        if offset_skipped:
            line += ", %d fused-slice layer(s) skipped" % offset_skipped
        if te_layers:
            line += ", %d text-encoder layer(s) left to the clip" % te_layers
        print(line, flush=True)
        return m
    except Exception as exc:
        print("[%s] rescue failed (%s); rendering without it" % (who, exc),
              flush=True)
        return model
