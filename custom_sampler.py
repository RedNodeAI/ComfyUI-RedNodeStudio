"""RedNode Sampler Start and Sampler End: your own sampler chain, used by the rigs.

Build a sampler chain on the canvas the way you would anywhere: a KSampler, a
SamplerCustomAdvanced with its own sigmas and guider, any pack's sampler. Take what it
needs from RedNode Sampler Start (model, positive, negative, latent, seed, steps, cfg,
sampler, scheduler, denoise, start and end step, vae) and put its finished latent into
RedNode Sampler End, under a name. On the Workspace's Models tab a rig's Sampler choice
names that chain, and from then on every render on that rig samples through it instead
of the built-in KSampler: the main render, each Latent and Img2Img pass, the paint pass
and every Detailer pass, each call with its own conditioning, latent and denoise.

Nothing is wired and the chain never runs on its own. When a rig samples, the pack
reads the chain out of the queued prompt and runs its nodes itself, in order, through
ComfyUI's own get_input_data and get_output_data, the calls ComfyUI makes for every
node. Nodes that do not depend on Sampler Start (a model patch, a loader, a constant)
run once per queue and are reused by every pass.
"""

import asyncio
import concurrent.futures
import contextlib
import contextvars
import json

import comfy.samplers

NODE_START = "RedNodeSamplerStart"
NODE_END = "RedNodeSamplerEnd"
START_OUTPUTS = ("model", "positive", "negative", "latent", "seed", "steps", "cfg",
                 "sampler_name", "scheduler", "denoise", "start_step", "end_step", "vae")

_ACTIVE = contextvars.ContextVar("rn_custom_sampler", default=None)
_CONST = {}                     # signature -> outputs of a chain node that ignores Start
_CONST_MAX = 64


class RedNodeSamplerStart:
    """What a sampling step has, handed to your own chain."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT", "INT", "INT", "FLOAT",
                    comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS,
                    "FLOAT", "INT", "INT", "VAE")
    RETURN_NAMES = START_OUTPUTS
    FUNCTION = "start"
    CATEGORY = "RedNode/Models"
    DESCRIPTION = ("The start of your own sampler chain. The Workspace and the Detailer "
                   "fill these outputs each time a rig using the chain samples; wire what "
                   "your sampler needs from here and end the chain at RedNode Sampler End.")

    def start(self):
        # only the rigs run this chain; queued on its own it hands out nothing
        from comfy_execution.graph_utils import ExecutionBlocker
        return tuple(ExecutionBlocker(None) for _ in START_OUTPUTS)


class RedNodeSamplerEnd:
    """The finished latent of your own sampler chain, under a name."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "name": ("STRING", {"default": "My sampler", "tooltip":
                     "What a rig's Sampler choice on the Models tab calls this chain."}),
            "latent": ("LATENT", {"tooltip": "Your sampler's finished latent."}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "end"
    CATEGORY = "RedNode/Models"
    DESCRIPTION = ("The end of your own sampler chain. Name it, then pick that name as a "
                   "rig's Sampler on the Models tab: every render and pass on that rig "
                   "samples through this chain. No wires to the Workspace or the Detailer.")

    def end(self, name="My sampler", latent=None):
        return ()


# ---- which chain is in use --------------------------------------------------------
@contextlib.contextmanager
def using(name, prompt):
    """While active, sampler_dials.sample_with_dials runs the named chain instead."""
    token = _ACTIVE.set({"name": str(name).strip(), "prompt": prompt}
                        if str(name or "").strip() else None)
    try:
        yield
    finally:
        _ACTIVE.reset(token)


def active():
    return _ACTIVE.get()


def chain_names(prompt):
    """The names of the Sampler End nodes in a queued prompt."""
    if not isinstance(prompt, dict):
        return []
    return sorted({str((n.get("inputs") or {}).get("name") or "").strip() or "My sampler"
                   for n in prompt.values()
                   if isinstance(n, dict) and n.get("class_type") == NODE_END})


# ---- running a chain ---------------------------------------------------------------
def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], (str, int)) \
        and isinstance(v[1], int)


def _plan(prompt, name):
    """(end id, start ids, the chain's node ids in run order)."""
    ends = [nid for nid, n in prompt.items()
            if isinstance(n, dict) and n.get("class_type") == NODE_END
            and (str((n.get("inputs") or {}).get("name") or "").strip() or "My sampler") == name]
    if not ends:
        raise RuntimeError("no RedNode Sampler End node named %r is in this queue. Check it is "
                           "on the canvas and not bypassed" % name)
    if len(ends) > 1:
        print("[RedNode Sampler] two Sampler End nodes are named %r; using node %s"
              % (name, ends[0]), flush=True)
    end = str(ends[0])
    order, state, starts = [], {}, set()

    def visit(nid):
        nid = str(nid)
        if state.get(nid) == 2:
            return
        if state.get(nid) == 1:
            raise RuntimeError("the sampler chain %r loops back on itself at node %s" % (name, nid))
        node = prompt.get(nid)
        if not isinstance(node, dict):
            raise RuntimeError("the sampler chain %r links to node %s, which is not in this "
                               "queue (bypassed or muted?)" % (name, nid))
        state[nid] = 1
        if node.get("class_type") == NODE_START:
            starts.add(nid)
        else:
            for v in (node.get("inputs") or {}).values():
                if _is_link(v):
                    visit(v[0])
        state[nid] = 2
        if node.get("class_type") != NODE_START:
            order.append(nid)

    visit(end)
    if not starts:
        print("[RedNode Sampler] the chain %r has no Sampler Start in it, so it ignores the "
              "rig's model, prompts and latent" % name, flush=True)
    return end, starts, order


def _depends_on_start(prompt, nid, starts, memo):
    nid = str(nid)
    if nid in memo:
        return memo[nid]
    if nid in starts:
        memo[nid] = True
        return True
    memo[nid] = False
    hit = any(_depends_on_start(prompt, v[0], starts, memo)
              for v in (prompt[nid].get("inputs") or {}).values() if _is_link(v))
    memo[nid] = hit
    return hit


def _signature(prompt, nid, memo):
    """A key for a node that does not depend on Start: its class and inputs, links
    replaced by their own signatures, so an edit anywhere upstream changes it."""
    nid = str(nid)
    if nid in memo:
        return memo[nid]
    node = prompt[nid]
    parts = {}
    for k, v in sorted((node.get("inputs") or {}).items()):
        parts[k] = ["@", _signature(prompt, v[0], memo), v[1]] if _is_link(v) else v
    memo[nid] = json.dumps([node.get("class_type"), parts], sort_keys=True, default=str)
    return memo[nid]


async def _call_node(nid, node, values, prompt):
    import nodes
    import execution
    from comfy_execution.graph import DynamicPrompt

    class_type = node.get("class_type")
    class_def = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    if class_def is None:
        raise RuntimeError("node %s is a %r, which is not installed" % (nid, class_type))
    inputs = {}
    for k, v in (node.get("inputs") or {}).items():
        if _is_link(v):
            src = values.get(str(v[0]))
            if src is None or v[1] >= len(src):
                continue
            inputs[k] = src[v[1]]
        else:
            inputs[k] = v
    dyn = DynamicPrompt(prompt)
    input_data_all, _missing, v3_data = execution.get_input_data(
        inputs, class_def, nid, None, dyn, {})
    obj = class_def()
    out, _ui, has_subgraph, pending = await execution.get_output_data(
        "rednode-sampler", nid, obj, input_data_all, v3_data=v3_data)
    if pending:
        done = []
        for r in out:
            done.append(await r if isinstance(r, asyncio.Task) else r)
        out, _ui, has_subgraph = execution.get_output_from_returns(done, obj)
    if has_subgraph:
        raise RuntimeError("node %s (%s) expands into a subgraph at run time, which a sampler "
                           "chain cannot do" % (nid, class_type))
    is_list = getattr(obj, "OUTPUT_IS_LIST", None) or ()
    result = []
    for i, slot in enumerate(out):
        if i < len(is_list) and is_list[i]:
            result.append(slot)
        else:
            result.append(slot[0] if isinstance(slot, list) and slot else slot)
    return tuple(result)


async def _run(prompt, name, start_values):
    from comfy_execution.graph_utils import ExecutionBlocker
    end, starts, order = _plan(prompt, name)
    values = {s: start_values for s in starts}
    dep_memo, sig_memo = {}, {}
    for nid in order:
        if nid == end:
            break
        node = prompt[nid]
        const = not _depends_on_start(prompt, nid, starts, dep_memo)
        key = _signature(prompt, nid, sig_memo) if const else None
        if const and key in _CONST:
            values[nid] = _CONST[key]
            continue
        try:
            out = await _call_node(nid, node, values, prompt)
        except Exception as exc:
            raise RuntimeError("sampler chain %r: node %s (%s) failed: %s"
                               % (name, nid, node.get("class_type"), exc)) from exc
        if any(isinstance(o, ExecutionBlocker) for o in out):
            raise RuntimeError("sampler chain %r: node %s (%s) was blocked, so the chain has "
                               "no result" % (name, nid, node.get("class_type")))
        values[nid] = out
        if const:
            if len(_CONST) >= _CONST_MAX:
                _CONST.pop(next(iter(_CONST)))
            _CONST[key] = out
    link = (prompt[end].get("inputs") or {}).get("latent")
    if not _is_link(link):
        raise RuntimeError("the Sampler End %r has no latent wired into it" % name)
    src = values.get(str(link[0]))
    if src is None:
        raise RuntimeError("the Sampler End %r's latent came from a node that did not run" % name)
    latent = src[link[1]]
    if not isinstance(latent, dict) or "samples" not in latent:
        raise RuntimeError("the Sampler End %r was given a %s, not a latent"
                           % (name, type(latent).__name__))
    return latent


def _run_sync(coro):
    """Run a coroutine from inside a node function. ComfyUI already has an event loop
    running on this thread, so it runs on a short-lived worker thread of its own."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def run_chain(ctx, model, seed, steps, cfg, sampler, scheduler, positive, negative, latent,
              denoise=1.0, start_step=None, last_step=None, vae=None, sigmas=None):
    """Sample through the named chain with this call's values; returns the latent."""
    name = ctx["name"]
    prompt = ctx.get("prompt")
    if not isinstance(prompt, dict):
        raise RuntimeError("the custom sampler %r needs the queued prompt, which this run did "
                           "not carry" % name)
    if sigmas is not None:
        print("[RedNode Sampler] %r builds its own schedule; the rig's shared schedule for "
              "continued noise is not passed to it" % name, flush=True)
    n_steps = int(steps)
    start_values = (model, positive, negative, latent, int(seed), n_steps, float(cfg),
                    sampler, scheduler, float(denoise), int(start_step or 0),
                    int(last_step if last_step is not None else 10000), vae)
    print("[RedNode Sampler] sampling through %r: seed %d, %d steps, cfg %.2f, denoise %.2f"
          % (name, int(seed), n_steps, float(cfg), float(denoise)), flush=True)
    return _run_sync(_run(prompt, name, start_values))


NODE_CLASS_MAPPINGS = {NODE_START: RedNodeSamplerStart, NODE_END: RedNodeSamplerEnd}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_START: "RedNode Sampler Start",
                              NODE_END: "RedNode Sampler End"}
