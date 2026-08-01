"""Patch guard (roadmap phase E): owner-safe, reload-safe, transactional patching.

Every global patch this pack applies goes through install_all():

- Idempotent by owner+version sentinel: importing the pack twice (or an in-process
  custom-node reload) never wraps a wrapper — the original is stored as a CLASS
  attribute, which survives module reloads, so a re-install rebuilds around the true
  original instead of recursing into the previous wrapper.
- ABI preflight: the target's signature is checked against named known variants BEFORE
  anything is assigned. Unknown signature -> the whole spec list is rejected with an
  actionable message (better no patch than a silently wrong one).
- Foreign patches are chained, not clobbered: if another pack already replaced the
  method, we wrap THEIR callable (it stays active underneath ours) and say so once.
- Transactional: specs are applied in order; any failure restores every prior
  assignment, so a feature's patch set is all-or-nothing.
"""

import inspect

OWNER = "RedNodeAI/ComfyUI-RedNodeStudio"
VERSION = 2


def _signature_ok(fn, variants):
    if variants is None:
        return True
    try:
        params = list(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return True  # uninspectable (builtin/C) - do not block on it
    return any(all(p in params for p in v) for v in variants)


def install_all(specs):
    """specs: iterable of (cls, name, orig_attr, build, variants).

    build(original) -> replacement callable (bound-style function taking self).
    variants: list of parameter-name lists; the current target must contain all names
    of at least one variant, else the install is rejected. Returns True on success,
    False after a full rollback."""
    applied = []
    try:
        for cls, name, orig_attr, build, variants in specs:
            current = getattr(cls, name)
            if getattr(current, "_rednode_owner", None) == OWNER:
                if getattr(current, "_rednode_version", None) == VERSION:
                    continue  # exactly this version is already live
                # older/newer of ours: rebuild around the stored true original
            else:
                if not _signature_ok(current, variants):
                    try:
                        params = list(inspect.signature(current).parameters)
                    except (TypeError, ValueError):
                        params = "<uninspectable>"
                    raise RuntimeError(
                        f"{cls.__name__}.{name} has an unexpected signature {params!r} - the "
                        "ComfyUI ABI changed. Refusing to patch blindly; update "
                        "RedNode Studio.")
                mod = getattr(current, "__module__", "") or ""
                if not mod.startswith("comfy"):
                    print(f"[RedNode Krea2] note: {cls.__name__}.{name} is already patched by "
                          f"{mod!r} - chaining it (their patch stays active underneath)",
                          flush=True)
                setattr(cls, orig_attr, current)
            replacement = build(getattr(cls, orig_attr))
            replacement._rednode_owner = OWNER
            replacement._rednode_version = VERSION
            applied.append((cls, name, current))
            setattr(cls, name, replacement)
        return True
    except Exception as e:  # noqa: BLE001 - any failure must roll back cleanly
        for cls, name, prev in reversed(applied):
            setattr(cls, name, prev)
        print(f"[RedNode Krea2] PATCHING ABORTED ({e}) - originals restored, the pack's "
              "reference/moodboard features are disabled this session.", flush=True)
        return False
