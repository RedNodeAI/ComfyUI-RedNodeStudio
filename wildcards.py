"""RedNode wildcard engine — resolves __wildcards__ and {a|b|c} inline choices, seeded.

Built into RedNode Prompt Box so the box is self-contained (no external wildcard node
needed), but compatible with the standard A1111 / Impact / dynamicprompts syntax so your
existing wildcard .txt files keep working. Reads from every installed wildcard folder:
ComfyUI/wildcards and each custom_nodes/*/wildcards.

Syntax supported:
  __name__            random line from wildcards/name.txt (nested paths + * globs ok)
  {a|b|c}             random choice
  {2$$a|b|c}          pick 2, joined by ", "  (also {1-3$$...} for a random count)
  nesting             chosen text may contain more __wildcards__ / {..}
  # comments          lines starting with # in a wildcard file are ignored
Weights ("5::opt") are accepted but treated as plain options in this version.
"""

import fnmatch
import glob
import os
import random
import re

_INDEX = None          # {name(lower, '/'): [file paths]}
_FILE_CACHE = {}       # path -> [lines]

_WC_RE = re.compile(r"__([A-Za-z0-9_\-./*]+?)__")
_BRACE_RE = re.compile(r"\{([^{}]*)\}")   # innermost {...} (no nested braces)
_WEIGHT_RE = re.compile(r"^\s*\d+(?:\.\d+)?::")


def _roots():
    roots = []
    try:
        import folder_paths
        base = folder_paths.base_path
        roots.append(os.path.join(base, "wildcards"))
        cn = os.path.join(base, "custom_nodes")
        if os.path.isdir(cn):
            for d in sorted(os.listdir(cn)):
                wd = os.path.join(cn, d, "wildcards")
                if os.path.isdir(wd):
                    roots.append(wd)
    except Exception:
        pass
    return [r for r in roots if os.path.isdir(r)]


def _build_index():
    idx = {}
    for root in _roots():
        for path in glob.glob(os.path.join(root, "**", "*.txt"), recursive=True):
            rel = os.path.relpath(path, root)
            name = os.path.splitext(rel)[0].replace("\\", "/").lower()
            idx.setdefault(name, []).append(path)
    return idx


def _index():
    global _INDEX
    if _INDEX is None:
        _INDEX = _build_index()
    return _INDEX


def refresh():
    """Drop caches so newly added / edited wildcard files are picked up."""
    global _INDEX
    _INDEX = None
    _FILE_CACHE.clear()


def refresh_index():
    """Re-scan folders on the next lookup (cheap; keeps file-content cache). Lets a page
    reload pick up newly added wildcard files without a full restart or a UI button."""
    global _INDEX
    _INDEX = None


def wildcard_names():
    return sorted(_index().keys())


def _lines_for(name):
    name = name.lower()
    idx = _index()
    paths = list(idx.get(name, []))
    if not paths and "*" in name:
        for n in idx:
            if fnmatch.fnmatch(n, name):
                paths.extend(idx[n])
    if not paths:
        return None
    out = []
    for p in paths:
        if p not in _FILE_CACHE:
            try:
                with open(p, encoding="utf-8") as f:
                    _FILE_CACHE[p] = [ln.strip() for ln in f
                                      if ln.strip() and not ln.lstrip().startswith("#")]
            except Exception:
                _FILE_CACHE[p] = []
        out.extend(_FILE_CACHE[p])
    return out


def _resolve_braces(text, rng):
    def repl(m):
        body = m.group(1)
        count, sep = 1, ", "
        if "$$" in body:
            pre, body = body.split("$$", 1)
            mm = re.match(r"\s*(\d+)(?:-(\d+))?\s*$", pre)
            if mm:
                lo = int(mm.group(1))
                hi = int(mm.group(2)) if mm.group(2) else lo
                count = rng.randint(min(lo, hi), max(lo, hi))
        opts = [_WEIGHT_RE.sub("", o).strip() for o in body.split("|")]
        opts = [o for o in opts if o != ""]
        if not opts:
            return ""
        if count <= 1:
            return rng.choice(opts)
        picks = opts[:]
        rng.shuffle(picks)
        return sep.join(picks[:count])

    out = text
    for _ in range(50):
        new = _BRACE_RE.sub(repl, out)
        if new == out:
            break
        out = new
    return out


def resolve(text, seed=0, max_depth=50):
    """Resolve all __wildcards__ and {a|b} in text using a seeded RNG. Unknown wildcards
    are left as-is (so a typo stays visible rather than vanishing)."""
    if not text or ("__" not in text and "{" not in text):
        return text
    rng = random.Random(seed)

    def pick(m):
        lines = _lines_for(m.group(1))
        return rng.choice(lines) if lines else m.group(0)

    out = text
    for _ in range(max_depth):
        before = out
        out = _resolve_braces(out, rng)
        out = _WC_RE.sub(pick, out)
        if out == before:
            break
    return out


# ---------------------------------------------------------------------------
# HTTP API — wildcard names for the "insert wildcard" dropdown on the box
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/wildcards")
    async def _rednode_get_wildcards(request):
        refresh_index()  # re-scan folders so a page reload picks up newly added files
        return web.json_response({"names": wildcard_names()})

except Exception as e:  # server/aiohttp unavailable (standalone tests)
    print(f"[RedNode Krea2] wildcard HTTP route not registered: {e}", flush=True)
