"""Freeing VRAM: on a Paint tab renderer switch (HTTP, below) and at a chosen point in a
run (RedNode Free VRAM, at the end of this file).

--- the renderer switch ---

Freeing the previous renderer's model when the Paint tab switches to another one.

The Paint tab's renderer dropdown lists every RedNode Paint Render and every RedNode
Paint In in the graph, so a workflow can hold as many renderer setups as you like and
Generate picks one. Generate prunes the prompt to that branch, which means the branches
you did NOT pick are never executed and their loaders never allocate anything: ten
setups in a graph is not ten models in VRAM.

What does linger is the one you used LAST. Switch from a Krea 2 branch to an SDXL
branch and the Krea 2 model is still resident until ComfyUI evicts it under pressure.
That is what this frees, and only on a switch.

Deliberately NOT on a timer and NOT on every Generate:

- Every Generate would be worse than doing nothing. The normal way to use the Paint tab
  is twenty low-denoise passes on the same model while tuning a mask, and freeing each
  time turns every one of those into a multi-gigabyte reload.
- A timer needs a background thread freeing memory on its own schedule, which can land
  in the middle of an executing prompt. ComfyUI has no idle hook to hang it on.

Called from the browser BEFORE the prompt is posted, because that is the only moment
nothing is executing and the ordering is guaranteed. A node could not do this reliably:
execution order between sibling branches is not defined, so a node meant to run before
the loader could just as easily run after it. RedNode Free VRAM sidesteps that by sitting
IN the wire rather than beside it.
"""

from .switch import ANY


def queue_busy():
    """True when something is running or waiting, in which case freeing would race it."""
    try:
        from server import PromptServer
        running, pending = PromptServer.instance.prompt_queue.get_current_queue()
        return bool(running) or bool(pending)
    except Exception:
        return False            # cannot tell, so do not block the user on a guess


def _loaded_for(mm, keep):
    """The LoadedModel entries backing the wires in `keep`, [] for anything not resident.

    Matched on clone_base_uuid, not identity: a model that has been through a LoRA or a
    sampling patch is a CLONE of the resident ModelPatcher, so `is` would miss it and we
    would free the very thing the user asked to keep. Same test comfy's own
    unload_model_and_clones uses.

    `keep` takes anything, because plenty of useful models are not ComfyUI MODELs (SAM3,
    upscalers, a pack's own loader). Those are not in current_loaded_models at all, so
    they match nothing here — which is correct: nothing in this file can free them either.
    """
    wanted = [k for k in (keep if isinstance(keep, (list, tuple)) else [keep])
              if k is not None]
    if not wanted:
        return []
    try:
        loaded = list(mm.current_loaded_models)
    except Exception:
        return []
    out = []
    for lm in loaded:
        m = getattr(lm, "model", None)
        if m is None:
            continue
        for k in wanted:
            base = getattr(k, "clone_base_uuid", None)
            if m is k or (base is not None
                          and getattr(m, "clone_base_uuid", None) == base):
                out.append(lm)
                break
    return out


def unmanaged(mm, keep):
    """The wires in `keep` that ComfyUI is not managing, so nothing here can touch them."""
    wanted = [k for k in (keep if isinstance(keep, (list, tuple)) else [keep])
              if k is not None]
    held = _loaded_for(mm, keep)
    held_models = [getattr(lm, "model", None) for lm in held]
    out = []
    for k in wanted:
        base = getattr(k, "clone_base_uuid", None)
        if any(m is k or (base is not None
                          and getattr(m, "clone_base_uuid", None) == base)
               for m in held_models):
            continue
        out.append(k)
    return out


def free_models(keep=None, empty=True):
    """Unload the models ComfyUI is holding. Returns (how many, bytes they were using).

    `keep` is an optional MODEL to leave resident. Nothing here is destructive: a model
    is a file on disk and reloads on demand. The cost of being wrong is one reload, which
    is exactly what a renderer switch pays anyway.
    """
    try:
        import comfy.model_management as mm
    except Exception as e:
        raise RuntimeError(f"ComfyUI's model management is unavailable ({e})")

    keep_loaded = _loaded_for(mm, keep)
    held = []
    try:
        held = [m for m in mm.current_loaded_models if m not in keep_loaded]
    except Exception:
        pass
    freed = 0
    for m in held:
        try:
            freed += int(m.model_memory())
        except Exception:
            pass

    if keep_loaded:
        for dev in mm.get_all_torch_devices():
            try:
                mm.free_memory(1e30, dev, keep_loaded=keep_loaded)
            except Exception:
                pass
        if empty:
            _empty_cache()
        return len(held), freed

    mm.unload_all_models()
    if empty:
        _empty_cache()
    return len(held), freed


def _empty_cache():
    """Hand the freed blocks back to the driver. Unloading alone only drops references."""
    try:
        import comfy.model_management as mm
        mm.soft_empty_cache(force=True)
    except Exception:
        pass
    try:
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def vram_state():
    """(used_fraction, total_bytes) for the primary device, or (None, 0) if unknown.

    The same numbers ComfyUI's own /system_stats reports, read straight from model
    management so there is no second source to drift. The CARD's figure, not this
    process's: the question being asked is "is there room", and another application
    holding the memory matters exactly as much as we do.
    """
    try:
        import comfy.model_management as mm
        dev = mm.get_torch_device()
        total = int(mm.get_total_memory(dev))
        free = int(mm.get_free_memory(dev))
        if total <= 0:
            return None, 0
        return max(0.0, min(1.0, (total - free) / total)), total
    except Exception:
        return None, 0


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/vram_state")
    async def _rednode_vram_state(request):
        used, total = vram_state()
        return web.json_response({"used": used, "total": total,
                                  "busy": queue_busy()})

    @PromptServer.instance.routes.post("/rednode/free_models")
    async def _rednode_free_models(request):
        if queue_busy():
            # not an error: the browser asks on every switch and a busy queue simply
            # means this is not the moment. ComfyUI will evict under pressure anyway.
            return web.json_response({"skipped": "the queue is busy", "count": 0,
                                      "freed": 0})
        try:
            count, freed = free_models()
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        if count:
            print(f"[RedNode Krea2] renderer switched, freed {count} model(s), about "
                  f"{freed // (1024 * 1024)} MB", flush=True)
        return web.json_response({"count": count, "freed": freed})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] VRAM HTTP route not registered: {e}", flush=True)


class RedNodeFreeVRAM:
    """Free VRAM at a chosen point in the run, so two big models never overlap.

    The passthrough is the whole design. A node with an output nobody uses may run at any
    time or not at all, so a bare "free memory" node cannot promise it happens BETWEEN two
    stages. Threading the image (or latent, or anything) through it puts it in the data
    path, where the order is defined.

    Freeing early beats letting ComfyUI evict late. It evicts at the moment of the next
    load, by which point VRAM is fragmented and the allocation can still fail; doing it
    here, while nothing is mid-allocation, is the reliable version.

    There is no reload half: the next sampler that needs a model loads it. The only cost
    is that load.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (ANY, {"tooltip": "anything — it comes out untouched. Wiring it "
                                "through is what fixes WHEN the memory is freed."}),
                "unload_models": ("BOOLEAN", {"default": True, "tooltip":
                                  "unload every model ComfyUI is holding. They reload on "
                                  "demand, so the cost is load time, not the run."}),
                "empty_cache": ("BOOLEAN", {"default": True, "tooltip":
                                "hand the freed blocks back to the driver. Leave on: "
                                "unloading alone often leaves VRAM looking just as full."}),
                "always_run": ("BOOLEAN", {"default": False, "tooltip":
                               "free even when nothing upstream changed. Costs you the "
                               "cache: everything downstream recomputes every queue."}),
            },
            "optional": {
                "keep": (ANY, {"tooltip": "a model to leave resident — wire the one you are "
                         "about to use again. LoRA-patched clones count as the same model. "
                         "Models ComfyUI does not manage (SAM3, most upscalers) are never "
                         "unloaded by this node in the first place."}),
                "keep_2": (ANY, {"tooltip": "a second model to leave resident, for a "
                           "checkpoint and its CLIP or VAE."}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Unloads models at this exact point in the chain, for running a second "
                   "big model (a detailer, an upscaler) on a card that cannot hold both. "
                   "Whatever is wired in comes straight out; the wire is what fixes the "
                   "timing. Nothing needs reloading by hand.")

    @classmethod
    def IS_CHANGED(cls, always_run=False, **kwargs):
        # NaN never equals itself, so ComfyUI treats the node as changed every time.
        return float("nan") if always_run else False

    def run(self, value=None, unload_models=True, empty_cache=True, always_run=False,
            keep=None, keep_2=None):
        wants = [k for k in (keep, keep_2) if k is not None]
        if unload_models:
            kept = ""
            if wants:
                try:
                    import comfy.model_management as mm
                    n = len(_loaded_for(mm, wants))
                    loose = len(unmanaged(mm, wants))
                    kept = f", kept {n}" if n else ""
                    if loose:
                        # not a warning: this is the normal answer for SAM3 and friends,
                        # and saying nothing would read as "your keep wire did nothing"
                        kept += (f", {loose} not managed by ComfyUI "
                                 "(nothing here loads or frees those)")
                except Exception:
                    pass
            try:
                count, freed = free_models(keep=wants, empty=bool(empty_cache))
            except Exception as e:
                print(f"[RedNode Free VRAM] could not unload: {e}", flush=True)
            else:
                # asked-for vs actually-held: a `keep` wire whose model was not resident
                # keeps nothing, and the log should not claim otherwise
                print(f"[RedNode Free VRAM] freed {count} model(s), about "
                      f"{freed // (1024 * 1024)} MB{kept}", flush=True)
        elif empty_cache:
            _empty_cache()
            print("[RedNode Free VRAM] emptied the allocator cache", flush=True)
        return (value,)


NODE_CLASS_MAPPINGS = {"RedNodeFreeVRAM": RedNodeFreeVRAM}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeFreeVRAM": "RedNode Free VRAM"}
