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

NOT A NODE, by the user's call: this is plumbing for the Studio Workspace's
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


def _dequant(t, sd_get, name):
    """A base tensor as float32, scaled-fp8 handled when the scale rides along."""
    out = t.float()
    if t.dtype in (getattr(torch, "float8_e4m3fn", None),
                   getattr(torch, "float8_e5m2", None)):
        scale = sd_get(name.replace(".weight", ".scale_weight"))
        if scale is not None:
            out = out * scale.float()
    return out


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
        ckpt_path = folder_paths.get_full_path_or_raise("checkpoints",
                                                        base_checkpoint)
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
        mb = 0.0
        with safe_open(ckpt_path, framework="pt", device="cpu") as f:
            names = set(f.keys())

            def sd_get(n):
                return f.get_tensor(n) if n in names else None

            for key in sorted(model_keys):
                mix_w = model_sd.get(key)
                # a checkpoint file carries the "model." prefix the live state
                # dict has already shed
                ck = key if key in names else "model." + key
                if mix_w is None or ck not in names:
                    missing += 1
                    continue
                base_w = _dequant(f.get_tensor(ck), sd_get, ck)
                if tuple(base_w.shape) != tuple(mix_w.shape):
                    missing += 1
                    continue
                diff = (base_w - mix_w.float()).to(torch.float16)
                patches[key] = ("diff", (diff,))
                mb += diff.numel() * 2 / (1024.0 * 1024.0)

        m = model.clone()
        applied = m.add_patches(patches, float(strength))
        line = ("[%s] %d layer(s) restored toward %r at strength %.2f "
                "(%.0f MB of diffs)"
                % (who, len(applied), base_checkpoint, strength, mb))
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
