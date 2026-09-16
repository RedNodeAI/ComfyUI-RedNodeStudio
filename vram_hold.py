"""Hold a run under its VRAM limit.

The VRAM limit is the card's size: 8, 12, 16 or 24 GB, or free range. A run is held
under that size less a little headroom (a 16 GB card is held near 15.5 GB), because
the card also carries the desktop and the browser.

Holding tells ComfyUI to keep the rest of the card free. On an install with
dynamic VRAM (comfy-aimdo, the default on NVIDIA) that is the allocator's simple
headroom: it evicts model weight pages to keep that much free, so the weights
stream through and the run stays near the line. On the older estimate-based
loader it is the reserve the --reserve-vram flag sets, and a model that does not
fit loads in part. Either way the text encoders leave the card before sampling.
Slower, and it stays near the line.

Hold is Auto, On or Off. Auto holds only when the run's estimated peak (the model
files it will load plus the working memory its size needs) is over the limit, so a
run that fits keeps its speed.

The reserve stays set for the whole queue (the Detailer and Post run after the
Workspace's sampler) and goes back to ComfyUI's own value on the next Workspace run
that does not hold.
"""

GB = 1024 ** 3
CARD_GB = (8, 12, 16, 24)
HEADROOM_GB = 0.5
# the dial ceilings each card size takes (VRAM_CAPS in workspace.py)
TIER_FOR_GB = {8: "low", 12: "low", 16: "low", 24: "medium"}
LEGACY_GB = {"low": 16, "medium": 24}
HOLD_MODES = ("auto", "on", "off")
_orig = {"reserve": None, "headroom": None}
# this queue's decision, read by the Detailer and Post that run after the Workspace
_current = {"limit": None}


def card_gb(cfg):
    """The card size the limit is set to, 0 for free range."""
    try:
        g = int(cfg.get("vram_gb") or 0)
    except (TypeError, ValueError):
        g = 0
    if g in CARD_GB:
        return g
    if "vram_gb" in cfg and not g:
        return 0
    return LEGACY_GB.get(str(cfg.get("vram_tier") or "high"), 0)


def tier_for(cfg):
    return TIER_FOR_GB.get(card_gb(cfg), "high")


def limit_gb(cfg):
    g = card_gb(cfg)
    return (g - HEADROOM_GB) if g else None


def hold_mode(cfg):
    m = cfg.get("vram_hold_mode")
    if m in HOLD_MODES:
        return m
    # a workflow from before Auto: its switch was on or it had none
    return "on" if cfg.get("vram_hold") is True else "auto"


def should_hold(cfg, estimate_gb=None):
    lim = limit_gb(cfg)
    if lim is None:
        return False
    mode = hold_mode(cfg)
    if mode == "off":
        return False
    if mode == "on":
        return True
    return estimate_gb is None or estimate_gb > lim


def _aimdo():
    """The dynamic VRAM allocator's control module, when that is what runs."""
    try:
        import comfy.memory_management as cmm
        if not getattr(cmm, "aimdo_enabled", False):
            return None
        import sys
        ctl = sys.modules.get("comfy_aimdo.control")
        if ctl is None:
            import comfy_aimdo.control as ctl
        return ctl if getattr(ctl, "lib", None) is not None else None
    except Exception:
        return None


def target_gb(cfg=None):
    """The GB this queue is held under, or None (decided by the Workspace's apply)."""
    return _current["limit"]


def apply(cfg, estimate_gb=None):
    """Decide and set ComfyUI's reserve for this run. Returns (limit GB, reserve MB)
    while holding, else None. Never fatal."""
    _current["limit"] = None
    try:
        import comfy.model_management as mm
    except Exception:
        return None
    try:
        if _orig["reserve"] is None:
            _orig["reserve"] = int(mm.EXTRA_RESERVED_VRAM)
        ctl = _aimdo()
        if ctl is not None and _orig["headroom"] is None:
            _orig["headroom"] = int(ctl.get_simple_vram_headroom())
        if not should_hold(cfg, estimate_gb):
            back = False
            if mm.EXTRA_RESERVED_VRAM != _orig["reserve"]:
                mm.EXTRA_RESERVED_VRAM = _orig["reserve"]
                back = True
            if ctl is not None and ctl.get_simple_vram_headroom() != _orig["headroom"]:
                ctl.set_simple_vram_headroom(_orig["headroom"])
                back = True
            if back:
                print("[RedNode Workspace] VRAM hold off: ComfyUI's own reserve is back",
                      flush=True)
            return None
        lim = limit_gb(cfg)
        total = int(mm.get_total_memory(mm.get_torch_device()))
        reserve = max(_orig["reserve"], int(total - lim * GB))
        changed = mm.EXTRA_RESERVED_VRAM != reserve
        mm.EXTRA_RESERVED_VRAM = int(reserve)
        how = "models that do not fit load in part"
        if ctl is not None:
            # dynamic VRAM: the allocator keeps this much free by evicting weight
            # pages, so the weights stream and the run stays near the line
            head = max(_orig["headroom"], int(total - lim * GB))
            if ctl.get_simple_vram_headroom() != head:
                ctl.set_simple_vram_headroom(head)
                changed = True
            how = "model weights stream through instead of sitting whole on the card"
        _current["limit"] = lim
        if changed:
            # what is already on the card was loaded under the old rule
            mm.unload_all_models()
            mm.soft_empty_cache()
            print("[RedNode Workspace] VRAM hold: keeping %.1f GB of the card free so the "
                  "run stays near %.1f GB; %s" % (reserve / GB, lim, how), flush=True)
        return lim, reserve // (1024 * 1024)
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
