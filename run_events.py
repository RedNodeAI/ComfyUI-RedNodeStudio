"""The Run tab's feed: which stage of a render is running, and what the card holds.

Every event goes to the browser as `rednode.run_stage`:

    {"run": n, "t": seconds since the run began, "kind": ...}

kind "start"   a run began (the Workspace build), with the node id
kind "stage"   a stage started, finished, failed or was skipped: key, label, state,
               secs (how long it took), info (steps, size, rig ...)
kind "note"    a line for the log: text, level (info, load, unload, warn)
kind "info"    facts for the top row (seed, rig)
kind "vram"    a memory sample: used and total MB, and the models on the card when
               that list changed since the last sample

Samples are taken at every stage event and about once a second while a stage is
running, from a small thread that stops when nothing is running. Model loads and
unloads are not hooked: the list of loaded models is compared between samples, so
a captioner or a rig arriving or leaving shows up as a note with its size.

Nothing here is ever fatal. A failed send is a missing line on a panel, never a
failed render.
"""

import functools
import threading
import time

_state = {
    "run": 0,          # run counter since ComfyUI started
    "t0": 0.0,         # when the current run began
    "node": None,      # the Workspace node that started it
    "active": {},      # stage key -> start time, for stages still running
    "models": None,    # the last model list sent, to find loads and unloads
    "last": 0.0,       # when anything was last sent
    "skipped": set(),  # stages a tracked call skipped itself
    "news": 0.0,       # when a stage last started, moved or ended
}
_lock = threading.Lock()
_ticker = {"thread": None}
TICK = 1.0             # seconds between samples while a stage runs
IDLE_STOP = 30.0       # the sampler stops after this long with nothing running
STUCK_STOP = 1800.0    # and after this long with no stage news at all


def _send(payload):
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("rednode.run_stage", payload)
    except Exception:
        pass


def _now():
    return time.time() - (_state["t0"] or time.time())


def vram():
    """{"used": MB, "total": MB} for the card, or {} without CUDA."""
    try:
        import torch
        if not torch.cuda.is_available():
            return {}
        free, total = torch.cuda.mem_get_info()
        return {"used": round((total - free) / 2 ** 20), "total": round(total / 2 ** 20)}
    except Exception:
        return {}


_NAMES = {"Krea2": "Krea 2", "Flux": "Flux", "SDXL": "SDXL", "ZImage": "Z-Image",
          "AutoencodingEngine": "VAE", "AutoencoderKL": "VAE", "WanVAE": "VAE",
          "Florence2": "Florence-2"}


def _model_name(lm):
    """A readable name for one entry of comfy's loaded model list."""
    try:
        m = lm.model
        inner = getattr(m, "model", None)
        cls = type(inner if inner is not None else m).__name__
        if cls in _NAMES:
            return _NAMES[cls]
        low = cls.lower()
        if "clip" in low or "text" in low or low.endswith("te") or "temodel" in low:
            return "Text encoder (%s)" % cls
        return cls
    except Exception:
        return "Model"


def loaded_models():
    """[{"name", "mb"}] for what ComfyUI holds on the card, largest first."""
    out = []
    try:
        import comfy.model_management as mm
        for lm in list(mm.current_loaded_models):
            try:
                mb = round(lm.model_loaded_memory() / 2 ** 20)
            except Exception:
                mb = 0
            if mb <= 0:
                continue
            out.append({"name": _model_name(lm), "mb": mb})
    except Exception:
        return []
    out.sort(key=lambda x: -x["mb"])
    return out


def _sample(force_models=False):
    """A vram event, with the model list when it changed, plus load and unload notes."""
    payload = {"run": _state["run"], "t": round(_now(), 2), "kind": "vram",
               "node": _state["node"], "vram": vram()}
    models = loaded_models()
    before = _state["models"]
    if force_models or models != before:
        payload["models"] = models
        if before is not None:
            old_names = {m["name"] for m in before}
            new_names = {m["name"] for m in models}
            for m in models:
                if m["name"] not in old_names:
                    note("%s loaded (%.1f GB)" % (m["name"], m["mb"] / 1024), "load")
            for m in before:
                if m["name"] not in new_names:
                    note("%s unloaded (%.1f GB freed)" % (m["name"], m["mb"] / 1024), "unload")
        _state["models"] = models
    _state["last"] = time.time()
    _send(payload)


def _tick():
    while True:
        time.sleep(TICK)
        with _lock:
            running = bool(_state["active"])
            idle = time.time() - _state["last"]
            quiet = time.time() - _state["news"]
        if quiet > STUCK_STOP or (not running and idle > IDLE_STOP):
            break
        if running:
            _sample()
    _ticker["thread"] = None


def _ensure_ticker():
    th = _ticker["thread"]
    if th is None or not th.is_alive():
        th = threading.Thread(target=_tick, name="rednode-run-sampler", daemon=True)
        _ticker["thread"] = th
        th.start()


def run_start(node=None, **info):
    """A new run: the counter moves on, the clock restarts."""
    try:
        with _lock:
            _state["run"] += 1
            _state["t0"] = time.time()
            _state["node"] = None if node is None else str(node)
            _state["active"] = {}
            _state["news"] = time.time()
        _send({"run": _state["run"], "t": 0.0, "kind": "start",
               "node": _state["node"], "info": info})
        _sample(force_models=True)
        _ensure_ticker()
    except Exception:
        pass


def stage_event(key, label, state, secs=None, **info):
    try:
        with _lock:
            _state["news"] = time.time()
            if state == "start":
                _state["active"][key] = time.time()
            else:
                _state["active"].pop(key, None)
        payload = {"run": _state["run"], "t": round(_now(), 2), "kind": "stage",
                   "node": _state["node"], "key": key, "label": label, "state": state,
                   "info": info}
        if secs is not None:
            payload["secs"] = round(secs, 2)
        _send(payload)
        _sample()
        if state == "start":
            _ensure_ticker()
    except Exception:
        pass


class stage:
    """with stage("pass2", "Pass 2 · Refine", steps=8): ... sends start, then done or
    error with the time it took. The error still raises."""

    def __init__(self, key, label, **info):
        self.key, self.label, self.info = key, label, info

    def __enter__(self):
        self.t = time.time()
        stage_event(self.key, self.label, "start", **self.info)
        return self

    def __exit__(self, exc_type, exc, tb):
        state = "done" if exc_type is None else "error"
        extra = dict(self.info)
        if exc is not None:
            extra["error"] = str(exc)[:200]
        stage_event(self.key, self.label, state, secs=time.time() - self.t, **extra)
        return False


def skip(key, label, why=""):
    with _lock:
        _state["skipped"].add(key)
    stage_event(key, label, "skip", why=why)


def begin(key, label, **info):
    stage_event(key, label, "start", **info)


def progress(key, label, **info):
    """A running stage's news (the Detailer's pass 2 of 3); it stays running."""
    try:
        _send({"run": _state["run"], "t": round(_now(), 2), "kind": "stage",
               "node": _state["node"], "key": key, "label": label, "state": "progress",
               "info": info})
    except Exception:
        pass


def end(key, label, state="done", **info):
    """Finish a stage begun with begin(); the time comes from its start."""
    t = _state["active"].get(key)
    stage_event(key, label, state, secs=(time.time() - t) if t else None, **info)


def tracked(key, label):
    """A node method as one stage: begun on entry, done on return, error on a raise.
    A call that ran skip() for its own key is left as skipped."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            with _lock:
                _state["skipped"].discard(key)
            begin(key, label)
            try:
                out = fn(*a, **kw)
            except Exception as exc:
                end(key, label, "error", error=str(exc)[:200])
                raise
            with _lock:
                was_skipped = key in _state["skipped"]
                _state["skipped"].discard(key)
            if not was_skipped:
                end(key, label, "done")
            return out
        return wrapper
    return deco


def fail_active(exc=None):
    """Every stage still running ends as failed: a raise skipped its end()."""
    for key in list(_state["active"]):
        stage_event(key, key, "error", error=str(exc or "")[:200])


def info(**fields):
    """Facts about the run for the top row: the seed, the rig."""
    try:
        _send({"run": _state["run"], "t": round(_now(), 2), "kind": "info",
               "node": _state["node"], "info": fields})
    except Exception:
        pass


def note(text, level="info"):
    """One line for the Run tab's log."""
    try:
        _send({"run": _state["run"], "t": round(_now(), 2), "kind": "note",
               "node": _state["node"], "text": str(text), "level": level})
    except Exception:
        pass
