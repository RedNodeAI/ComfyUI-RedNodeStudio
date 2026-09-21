"""Sampler nodes from other packs, picked on a rig instead of ComfyUI's KSampler.

A rig's Sampling tab can name a sampler node that ships in another pack. Every call
the pack samples through (sampler_dials.sample_with_dials: the passes, the render
polish, the Detailer) then runs that node, looked up by name in NODE_CLASS_MAPPINGS
the way Realism calls its workflow's nodes, with the call's model, prompts, latent,
steps, cfg, seed, scheduler and denoise, plus the node's own settings kept on the
rig.

An ADAPTER per node, because every pack's node takes different inputs. A call the
adapter cannot express (a pass that continues the last one's noise, or starts or
stops part way) falls back to the built-in sampler and says so, rather than
guessing at the node's meaning.
"""

ADAPTERS = {
    "res4lyf_clownshark": {
        "label": "RES4LYF ClownsharKSampler",
        "node": "ClownsharKSampler_Beta",
        "pack": "RES4LYF",
    },
}


def parse_node(raw):
    """A rig's sampler_node block, normalised. "" id is the built-in sampler."""
    r = raw if isinstance(raw, dict) else {}
    nid = str(r.get("id") or "")
    try:
        eta = max(-100.0, min(100.0, float(r.get("eta", 0.5))))
    except (TypeError, ValueError):
        eta = 0.5
    return {
        "id": nid if nid in ADAPTERS else "",
        # ClownsharKSampler's own: the noise added and taken away each step, its
        # sampler (RES4LYF's list, res_2m by default) and bongmath
        "eta": eta,
        "sampler_name": str(r.get("sampler_name") or "res_2m"),
        "bongmath": r.get("bongmath", True) is not False,
    }


def _registry():
    import nodes as _core
    return getattr(_core, "NODE_CLASS_MAPPINGS", None) or {}


def run(node, model, seed, steps, cfg, scheduler, positive, negative, latent,
        denoise=1.0, sigmas=None, disable_noise=False, start_step=None, last_step=None):
    """The latent from the rig's sampler node, or None for the built-in sampler."""
    node = node or {}
    ad = ADAPTERS.get(node.get("id") or "")
    if not ad:
        return None
    if disable_noise or start_step or last_step is not None or sigmas is not None:
        print("[RedNode sampler node] %s: this call continues or cuts a schedule, which the "
              "node is not asked to do; the built-in sampler runs it" % ad["label"], flush=True)
        return None
    cls = _registry().get(ad["node"])
    if cls is None:
        print("[RedNode sampler node] %s is not installed (it comes with %s); the built-in "
              "sampler runs instead" % (ad["label"], ad["pack"]), flush=True)
        return None
    fn = getattr(cls(), getattr(cls, "FUNCTION", "") or "", None)
    if fn is None:
        return None
    print("[RedNode sampler node] %s: %s, eta %.2f, %s, %d steps, cfg %s"
          % (ad["label"], node["sampler_name"], node["eta"], scheduler, int(steps), cfg),
          flush=True)
    return fn(model=model, positive=positive, negative=negative, latent_image=latent,
              eta=float(node["eta"]), sampler_name=node["sampler_name"], scheduler=scheduler,
              steps=int(steps), steps_to_run=-1, denoise=float(denoise), cfg=float(cfg),
              seed=int(seed), sampler_mode="standard", bongmath=bool(node["bongmath"]))[0]
