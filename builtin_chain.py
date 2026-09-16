"""What the Workspace already did this run, so the separate nodes step aside.

The Workspace can run the Detailer passes, Post FX and the save itself. A workflow
built before that still has RedNode Studio Detailer, RedNode Post Process and
RedNode Save wired after it; they check here and pass the picture through rather
than detailing, grading or filing it a second time.
"""

_DONE = {}
_MAX_RUNS = 32


def _run_key():
    try:
        from comfy_execution.utils import get_executing_context
        ctx = get_executing_context()
        if ctx is not None and getattr(ctx, "prompt_id", None):
            return str(ctx.prompt_id)
    except Exception:
        pass
    return None


def mark(step):
    key = _run_key()
    if key is None:
        return
    _DONE.setdefault(key, set()).add(step)
    while len(_DONE) > _MAX_RUNS:
        _DONE.pop(next(iter(_DONE)))


def done(step):
    key = _run_key()
    return key is not None and step in _DONE.get(key, ())
