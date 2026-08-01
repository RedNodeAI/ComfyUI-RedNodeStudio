"""Freeing the previous renderer's model when the Paint tab switches to another one.

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
the loader could just as easily run after it.
"""


def queue_busy():
    """True when something is running or waiting, in which case freeing would race it."""
    try:
        from server import PromptServer
        running, pending = PromptServer.instance.prompt_queue.get_current_queue()
        return bool(running) or bool(pending)
    except Exception:
        return False            # cannot tell, so do not block the user on a guess


def free_models():
    """Unload every model ComfyUI is holding. Returns (how many, bytes they were using).

    Nothing here is destructive: a model is a file on disk and reloads on demand. The
    cost of being wrong is one reload, which is exactly what a renderer switch pays
    anyway.
    """
    try:
        import comfy.model_management as mm
    except Exception as e:
        raise RuntimeError(f"ComfyUI's model management is unavailable ({e})")

    held = []
    try:
        held = list(mm.current_loaded_models)
    except Exception:
        pass
    freed = 0
    for m in held:
        try:
            freed += int(m.model_memory())
        except Exception:
            pass

    mm.unload_all_models()
    try:
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
    return len(held), freed


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
