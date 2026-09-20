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
# Writing one. A wildcard IS a text file with a value per line, so the node that
# makes one writes exactly that: no database, no JSON, nothing that has to be
# exported before another wildcard tool can read it.
# ---------------------------------------------------------------------------

# letters, digits, underscore, hyphen, and / for a folder. No dots, so nothing
# can climb out of the folder with .. and nothing writes a name like ".gitignore"
_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]+(?:/[A-Za-z0-9_\-]+)*$")


def _write_root(make=False):
    """Where new wildcards are saved: ComfyUI's own wildcards folder.

    The shared one on purpose, not a folder inside this pack. It is already on
    the search path for every wildcard node anyone has installed, and a pack
    folder would put your writing inside a git checkout that updates.
    """
    try:
        import folder_paths
        base = os.path.join(folder_paths.base_path, "wildcards")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "wildcards")
    if make:
        os.makedirs(base, exist_ok=True)
    return base


def clean_name(name):
    """The name as a file: __Hair__, hair, hair.txt and @hair all mean hair."""
    name = str(name or "").strip().strip("_").strip()
    if name.lower().endswith(".txt"):
        name = name[:-4]
    name = name.replace("\\", "/")
    # a leading slash is REFUSED rather than trimmed. Trimming it would turn
    # "/etc/passwd" into a subfolder quietly, which is safe and reads like the
    # name was accepted as typed
    if not _NAME_RE.match(name):
        raise ValueError("a wildcard name is letters, digits, _ or -, and / for a "
                         "folder. No spaces, no dots.")
    return name


def _path_for(name, root=None):
    """The file this name means inside a root, with the root proved afterwards.

    The name is checked first and joined second, and the result is still
    compared against the root: two guards, because this one takes a name from an
    HTTP request and turns it into a path on your disk.
    """
    root = os.path.abspath(root or _write_root())
    path = os.path.abspath(os.path.join(root, *clean_name(name).split("/")) + ".txt")
    if os.path.commonpath([root, path]) != root:
        raise ValueError("that name does not stay inside the wildcards folder")
    return path


def read_wildcard(name):
    """The lines of a wildcard, as written, from wherever it is installed.

    Comments and blank lines come back too: this is for editing the file, not
    for drawing from it.
    """
    name = clean_name(name)
    for root in [_write_root()] + _roots():
        path = os.path.join(root, *name.split("/")) + ".txt"
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return f.read()
            except Exception:
                return ""
    return ""


def save_wildcard(name, values):
    """Write one value per line, and make it usable this second.

    refresh() rather than refresh_index(): the file's contents are cached too,
    so editing a wildcard you have already drawn from has to drop both or the
    next queue keeps rolling the old lines.
    """
    name = clean_name(name)
    lines = [ln.strip() for ln in str(values or "").replace("\r\n", "\n").split("\n")]
    body = "\n".join(lines).strip("\n")
    path = _path_for(name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _write_root(make=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body + "\n" if body else "")
    refresh()
    return name


def delete_wildcard(name):
    """Delete one of ours, and only ours.

    Rebuilt from the write root, so a wildcard installed by another pack cannot
    be deleted from this panel however the name is spelled.
    """
    name = clean_name(name)
    path = _path_for(name)
    if os.path.isfile(path):
        os.remove(path)
    refresh()
    return name


def wildcard_list():
    """Every wildcard, with how many values it holds and whether it is ours."""
    mine = os.path.abspath(_write_root())
    out = []
    for name in wildcard_names():
        paths = _index().get(name) or []
        editable = any(os.path.abspath(p).startswith(mine + os.sep) for p in paths)
        out.append({"name": name, "count": len(_lines_for(name) or []),
                    "editable": editable,
                    "shared": len(paths) > 1})
    return out


class RedNodeWildcards:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "wildcard": ("STRING", {"default": "", "tooltip":
                    "name only, no underscores (letters, digits, _ or -, and / for a "
                    "folder). Referenced as __name__ in any prompt box."}),
                "values": ("STRING", {"multiline": True, "default": "", "tooltip":
                    "one value per line. A line may itself contain __wildcards__ or "
                    "{a|b} choices. Lines starting with # are notes and are never drawn."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Write a __wildcard__ without leaving ComfyUI: a name, a value per "
                   "line, Save. It is a plain .txt in ComfyUI's wildcards folder, so "
                   "every wildcard node reads it and nothing has to be exported. One "
                   "library, reused across all workflows.")

    def noop(self, wildcard="", values=""):
        return ()


# ---------------------------------------------------------------------------
# HTTP API — wildcard names for the "insert wildcard" dropdown on the box
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/wildcards")
    async def _rednode_get_wildcards(request):
        refresh_index()  # re-scan folders so a page reload picks up newly added files
        # `names` is what the Prompt Box's dropdown has always read; `files` is
        # the editor's view of the same list and is additive, so an older panel
        # keeps working against a newer server.
        return web.json_response({"names": wildcard_names(), "files": wildcard_list(),
                                  "folder": _write_root()})

    @PromptServer.instance.routes.post("/rednode/wildcards")
    async def _rednode_post_wildcards(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        action = data.get("action")
        try:
            if action == "save":
                save_wildcard(data.get("name", ""), data.get("values", ""))
            elif action == "delete":
                delete_wildcard(data.get("name", ""))
            elif action == "read":
                return web.json_response({"name": clean_name(data.get("name", "")),
                                          "values": read_wildcard(data.get("name", "")),
                                          "names": wildcard_names(),
                                          "files": wildcard_list()})
            elif action != "list":
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except OSError as e:
            return web.json_response({"error": "could not write it (%s)" % e}, status=500)
        refresh()
        return web.json_response({"names": wildcard_names(), "files": wildcard_list(),
                                  "folder": _write_root()})

except Exception as e:  # server/aiohttp unavailable (standalone tests)
    print(f"[RedNode Krea2] wildcard HTTP route not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeWildcards": RedNodeWildcards}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeWildcards": "RedNode Wildcards"}
