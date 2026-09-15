"""Running your own rig nodes when a Workspace rig samples (see custom_rig.py).

When the Workspace, the Detailer or the Paint tab samples on a rig of kind "Your own
nodes", the call site names the rig with `using(...)` and sampler_dials.sample_with_dials
hands the call here. The rig's nodes are read out of the queued prompt: from its Rig
Result back up the links, stopping at Rig Inputs and Rig Model, whose outputs are this
call's values (the Workspace's conditioning, latent and numbers; the LoRA'd model, clip
and vae). Each node in between runs through ComfyUI's own execution.get_input_data and
get_output_data, the calls ComfyUI makes for every node. A node that depends on neither
(a loader, a model patch, a constant) runs once and is reused while its inputs are the
same. A rig with no Rig Result in the queue samples with the built-in sampler.
"""

import asyncio
import concurrent.futures
import contextlib
import contextvars
import json

RIG_MODEL = "RedNodeRigModel"
RIG_INPUTS = "RedNodeRigInputs"
RIG_RESULT = "RedNodeRigResult"

_ACTIVE = contextvars.ContextVar("rn_rig_chain", default=None)
_CONST = {}                     # signature -> outputs of a node that ignores the rig's values
_CONST_MAX = 64


def _rig_of(node):
    v = (node.get("inputs") or {}).get("rig")
    return (v.strip() if isinstance(v, str) else "") or "My rig"


@contextlib.contextmanager
def using(rig, prompt, clip=None, vae=None):
    """While active, the shared sampler entry samples through this rig's own nodes."""
    name = str(rig or "").strip()
    token = _ACTIVE.set({"rig": name, "prompt": prompt, "clip": clip, "vae": vae}
                        if name else None)
    try:
        yield
    finally:
        _ACTIVE.reset(token)


def active():
    """The rig in use, only when the queued prompt holds a Rig Result for it."""
    ctx = _ACTIVE.get()
    if not ctx or not isinstance(ctx.get("prompt"), dict):
        return None
    has = any(isinstance(n, dict) and n.get("class_type") == RIG_RESULT and _rig_of(n) == ctx["rig"]
              for n in ctx["prompt"].values())
    return ctx if has else None


def rig_for(rigdict):
    """The rig name to sample through for a Models tab rig, "" for the built-in sampler."""
    if not isinstance(rigdict, dict) or rigdict.get("kind") != "node":
        return ""
    return str(rigdict.get("node") or rigdict.get("name") or "").strip()


# ---- the plan ------------------------------------------------------------------------
def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], (str, int)) \
        and isinstance(v[1], int)


def _plan(prompt, rig):
    """(result id, {start id: class}, node ids in run order)."""
    results = [str(nid) for nid, n in prompt.items()
               if isinstance(n, dict) and n.get("class_type") == RIG_RESULT and _rig_of(n) == rig]
    if not results:
        raise RuntimeError("no RedNode Rig Result for the rig %r is in this queue" % rig)
    if len(results) > 1:
        print("[RedNode Rig] two Rig Result nodes name the rig %r; using node %s"
              % (rig, results[0]), flush=True)
    end = results[0]
    order, state, starts = [], {}, {}

    def visit(nid):
        nid = str(nid)
        if state.get(nid) == 2:
            return
        if state.get(nid) == 1:
            raise RuntimeError("the rig %r loops back on itself at node %s" % (rig, nid))
        node = prompt.get(nid)
        if not isinstance(node, dict):
            raise RuntimeError("the rig %r links to node %s, which is not in this queue "
                               "(bypassed or muted?)" % (rig, nid))
        state[nid] = 1
        cls = node.get("class_type")
        if cls in (RIG_INPUTS, RIG_MODEL):
            starts[nid] = cls
            state[nid] = 2
            return
        for v in (node.get("inputs") or {}).values():
            if _is_link(v):
                visit(v[0])
        state[nid] = 2
        order.append(nid)

    visit(end)
    return end, starts, order


def _depends_on_starts(prompt, nid, starts, memo):
    nid = str(nid)
    if nid in memo:
        return memo[nid]
    if nid in starts:
        memo[nid] = True
        return True
    memo[nid] = False
    memo[nid] = any(_depends_on_starts(prompt, v[0], starts, memo)
                    for v in (prompt[nid].get("inputs") or {}).values() if _is_link(v))
    return memo[nid]


def _signature(prompt, nid, memo):
    nid = str(nid)
    if nid in memo:
        return memo[nid]
    node = prompt[nid]
    parts = {}
    for k, v in sorted((node.get("inputs") or {}).items()):
        parts[k] = ["@", _signature(prompt, v[0], memo), v[1]] if _is_link(v) else v
    memo[nid] = json.dumps([node.get("class_type"), parts], sort_keys=True, default=str)
    return memo[nid]


# ---- calling a node the way ComfyUI does -------------------------------------------
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
    input_data_all, _missing, v3_data = execution.get_input_data(
        inputs, class_def, nid, None, DynamicPrompt(prompt), {})
    obj = class_def()
    out, _ui, has_subgraph, pending = await execution.get_output_data(
        "rednode-rig", nid, obj, input_data_all, v3_data=v3_data)
    if pending:
        done = [await r if isinstance(r, asyncio.Task) else r for r in out]
        out, _ui, has_subgraph = execution.get_output_from_returns(done, obj)
    if has_subgraph:
        raise RuntimeError("node %s (%s) expands into a subgraph at run time, which a rig "
                           "cannot run" % (nid, class_type))
    is_list = getattr(obj, "OUTPUT_IS_LIST", None) or ()
    return tuple(slot if (i < len(is_list) and is_list[i])
                 else (slot[0] if isinstance(slot, list) and slot else slot)
                 for i, slot in enumerate(out))


async def _run(prompt, rig, start_values):
    from comfy_execution.graph_utils import ExecutionBlocker
    end, starts, order = _plan(prompt, rig)
    if RIG_INPUTS not in starts.values():
        print("[RedNode Rig] the rig %r has no Rig Inputs in its chain, so it ignores the "
              "Workspace's prompts and latent" % rig, flush=True)
    values = {nid: start_values[cls] for nid, cls in starts.items()}
    dep_memo, sig_memo = {}, {}
    for nid in order:
        if nid == end:
            break
        node = prompt[nid]
        const = not _depends_on_starts(prompt, nid, starts, dep_memo)
        key = _signature(prompt, nid, sig_memo) if const else None
        if const and key in _CONST:
            values[nid] = _CONST[key]
            continue
        try:
            out = await _call_node(nid, node, values, prompt)
        except Exception as exc:
            raise RuntimeError("rig %r: node %s (%s) failed: %s"
                               % (rig, nid, node.get("class_type"), exc)) from exc
        if any(isinstance(o, ExecutionBlocker) for o in out):
            raise RuntimeError("rig %r: node %s (%s) was blocked, so the rig has no result"
                               % (rig, nid, node.get("class_type")))
        values[nid] = out
        if const:
            if len(_CONST) >= _CONST_MAX:
                _CONST.pop(next(iter(_CONST)))
            _CONST[key] = out
    ins = prompt[end].get("inputs") or {}

    def pull(key):
        link = ins.get(key)
        if not _is_link(link):
            return None
        src = values.get(str(link[0]))
        return None if src is None or link[1] >= len(src) else src[link[1]]

    return pull("latent"), pull("image")


def _run_sync(coro):
    """ComfyUI already runs an event loop on this thread, so the rig runs on a short-lived
    worker thread of its own."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def run_rig(ctx, model, seed, steps, cfg, sampler, scheduler, positive, negative, latent,
            denoise=1.0, start_step=None, last_step=None, sigmas=None):
    """Sample through the rig's own nodes with this call's values; returns a LATENT."""
    rig = ctx["rig"]
    prompt = ctx["prompt"]
    if sigmas is not None:
        print("[RedNode Rig] %r samples with its own nodes; the shared schedule for "
              "continued noise is not passed to them" % rig, flush=True)
    clip, vae = ctx.get("clip"), ctx.get("vae")
    start_values = {
        RIG_MODEL: (model, clip, vae),
        RIG_INPUTS: (positive, negative, latent, int(seed), int(steps), float(cfg), sampler,
                     scheduler, float(denoise), int(start_step or 0),
                     int(last_step if last_step is not None else 10000)),
    }
    print("[RedNode Rig] sampling through the rig %r's own nodes: seed %d, %d steps, "
          "cfg %.2f, denoise %.2f" % (rig, int(seed), int(steps), float(cfg), float(denoise)),
          flush=True)
    lat, img = _run_sync(_run(prompt, rig, start_values))
    if isinstance(lat, dict) and "samples" in lat:
        return lat
    if img is not None:
        if vae is None:
            raise RuntimeError("the rig %r returned a picture, and there is no VAE to turn it "
                               "back into a latent for the next step" % rig)
        t = img
        while t.ndim > 4:
            t = t[0]
        out = dict(latent) if isinstance(latent, dict) else {}
        out.pop("noise_mask", None)
        out["samples"] = vae.encode(t[:, :, :, :3])
        return out
    raise RuntimeError("the Rig Result for %r has no latent or picture wired into it" % rig)
