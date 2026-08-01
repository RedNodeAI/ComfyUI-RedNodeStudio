"""RedNode global prompt library — saved @keyword macros shared across all prompt boxes.

One JSON file in the ComfyUI user dir (same folder as the RedNode presets). Each entry is
NAME -> prompt text. In a prompt, @NAME expands to that saved text at run time — a FIXED
macro, unlike a random __wildcard__. Managed by the RedNode Prompt Keywords node and read
by RedNode Prompt Box (for both expansion and highlighting).

A small HTTP API (/rednode/prompts) lets the frontend list/save/delete keywords so the
manager node and the box highlighter stay in sync with the file.
"""

import json
import os
import re

_VALID_NAME = re.compile(r"^[A-Za-z0-9_]+$")
# @name, but only at a word start (so "me@site" / emails never expand)
_KEYWORD_RE = re.compile(r"(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)")


def _library_path(make=False):
    """Keyword store — ComfyUI user dir when available (survives pack updates), else a
    local folder. Mirrors rednode.py's preset path so both live under rednode-krea2/."""
    try:
        import folder_paths
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "prompt_library.json")


def load_library():
    """{name: text} of saved keywords (empty on any error)."""
    try:
        with open(_library_path(), encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("keywords", {})
        return {str(k): str(v) for k, v in items.items() if _VALID_NAME.match(str(k))}
    except Exception:
        return {}


def _write(lib):
    path = _library_path(make=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "keywords": lib}, f, indent=2, ensure_ascii=False)


def save_keyword(name, text):
    name = (name or "").strip().lstrip("@").strip()
    if not _VALID_NAME.match(name):
        raise ValueError("keyword name must be letters, digits or underscore (no spaces or @)")
    lib = load_library()
    lib[name] = text if text is not None else ""
    _write(lib)
    return name


def delete_keyword(name):
    name = (name or "").strip().lstrip("@").strip()
    lib = load_library()
    if name in lib:
        lib.pop(name)
        _write(lib)
    return name


def expand_keywords(text, library=None, max_depth=6):
    """Replace @NAME with its saved text. Leaves __wildcards__ and unknown @names as-is.
    Iterates (depth-guarded) so a saved prompt may itself contain @keywords."""
    if not text or "@" not in text:
        return text
    lib = load_library() if library is None else library
    if not lib:
        return text
    out = text
    for _ in range(max_depth):
        changed = False

        def repl(m):
            nonlocal changed
            key = m.group(1)
            if key in lib:
                changed = True
                return lib[key]
            return m.group(0)

        out = _KEYWORD_RE.sub(repl, out)
        if not changed:
            break
    return out


# ---------------------------------------------------------------------------
# Manager node — client-side buttons (web/rednode_keywords.js) do the real work via the
# HTTP API below; the node itself is just the panel that hosts them.
# ---------------------------------------------------------------------------
class RedNodePromptKeywords:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "keyword": ("STRING", {"default": "", "tooltip": "name only, no @ (letters/digits/underscore). Referenced as @name in a prompt box."}),
                "prompt_text": ("STRING", {"multiline": True, "default": "", "tooltip": "the fixed prompt @name expands to. May itself contain __wildcards__ or other @keywords."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Manage the global @keyword library (save / update / delete, searchable). "
                   "Every RedNode Prompt Box expands @name to the saved text automatically - "
                   "no wiring needed. One library, reused across all workflows.")

    def noop(self, keyword="", prompt_text=""):
        return ()


# ---------------------------------------------------------------------------
# HTTP API for the frontend (list / save / delete)
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/prompts")
    async def _rednode_get_prompts(request):
        return web.json_response({"keywords": load_library()})

    @PromptServer.instance.routes.post("/rednode/prompts")
    async def _rednode_post_prompts(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        action = data.get("action")
        try:
            if action == "save":
                save_keyword(data.get("name", ""), data.get("text", ""))
            elif action == "delete":
                delete_keyword(data.get("name", ""))
            elif action != "list":
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"keywords": load_library()})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] prompt library HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodePromptKeywords": RedNodePromptKeywords}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePromptKeywords": "RedNode Prompt Keywords"}
