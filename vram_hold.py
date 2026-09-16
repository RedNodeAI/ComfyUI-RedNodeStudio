"""Hold a run under its VRAM limit.

The Workspace's VRAM limit (Low, Medium) holds the expensive dials down, but the
models themselves still load whole: Krea 2 and its text encoder alone pass 16 GB.
With "Hold under it" on, ComfyUI is told to keep the rest of the card free, the
same knob its --reserve-vram flag sets. Its loader reads that number at every load,
so a model that does not fit loads in part, with the rest of its weights kept in
RAM and brought over as they are needed. Slower, and it stays under the line.

The reserve stays set while holding is on, for the whole queue (the Detailer and
Post run after the Workspace), and goes back to ComfyUI's own value on the next
Workspace run with holding off.
"""

TARGET_GB = {"low": 16, "medium": 24}
_orig = {"reserve": None}


def target_gb(cfg):
    """The GB this run is held under, or None."""
    tier = str(cfg.get("vram_tier") or "high")
    return TARGET_GB.get(tier) if cfg.get("vram_hold") else None


def apply(cfg):
    """Set or restore ComfyUI's reserve for this run. Returns (target GB, reserve MB)
    while holding, else None. Never fatal."""
    try:
        import comfy.model_management as mm
    except Exception:
        return None
    try:
        if _orig["reserve"] is None:
            _orig["reserve"] = int(mm.EXTRA_RESERVED_VRAM)
        tgt = target_gb(cfg)
        if tgt is None:
            if mm.EXTRA_RESERVED_VRAM != _orig["reserve"]:
                mm.EXTRA_RESERVED_VRAM = _orig["reserve"]
                print("[RedNode Workspace] VRAM hold off: ComfyUI's own reserve is back",
                      flush=True)
            return None
        total = int(mm.get_total_memory(mm.get_torch_device()))
        reserve = max(_orig["reserve"], total - tgt * 1024 ** 3)
        changed = mm.EXTRA_RESERVED_VRAM != reserve
        mm.EXTRA_RESERVED_VRAM = int(reserve)
        if changed:
            # what is already on the card was loaded under the old rule
            mm.unload_all_models()
            mm.soft_empty_cache()
            print("[RedNode Workspace] VRAM hold: keeping %.1f GB of the card free so the "
                  "run stays near %d GB; models that do not fit load in part"
                  % (reserve / 1024 ** 3, tgt), flush=True)
        return tgt, reserve // (1024 * 1024)
    except Exception as exc:
        print("[RedNode Workspace] VRAM hold could not be set: %s" % exc, flush=True)
        return None


def _is_text_encoder(lm):
    m = getattr(lm, "model", None)
    inner = getattr(m, "model", None)
    cls = type(inner if inner is not None else m).__name__.lower()
    return "clip" in cls or "text" in cls or "temodel" in cls or cls.endswith("te")


def before_sampling(cfg):
    """While holding: the text encoders leave the card before sampling; the diffusion
    model stays, so a Detailer pass does not reload it every time. True when a
    text encoder was unloaded."""
    if target_gb(cfg) is None:
        return False
    try:
        import comfy.model_management as mm
        gone = False
        for i in range(len(mm.current_loaded_models) - 1, -1, -1):
            lm = mm.current_loaded_models[i]
            if _is_text_encoder(lm):
                lm.model_unload()
                mm.current_loaded_models.pop(i)
                gone = True
        if gone:
            mm.soft_empty_cache()
        return gone
    except Exception as exc:
        print("[RedNode Workspace] VRAM hold: could not unload the text encoder: %s" % exc,
              flush=True)
        try:
            import comfy.model_management as mm
            mm.unload_all_models()
            mm.soft_empty_cache()
            return True
        except Exception:
            return False
