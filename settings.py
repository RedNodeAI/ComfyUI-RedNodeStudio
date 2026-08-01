"""The pack's global preferences, set from ComfyUI's own settings dialog.

Only genuinely global choices live here. Anything belonging to one workflow, the Post
chain, the paint strokes, which images are on a tab, stays on its node where you can
see it next to what it does.

The browser pushes these once at startup and again on change, rather than the server
asking per request, so a queued run never waits on the frontend. Anything not pushed
keeps the default, which is what an older frontend or a headless run gets.

This module deliberately imports nothing from the rest of the pack: everything else
imports it, and a cycle here would break the whole import.
"""

import json
import os

DEFAULTS = {
    "caption_cache": True,     # reuse a caption already made for an image
    "caption_cap": 800,        # how many captions to remember
    "look_thumbs": True,       # store a thumbnail with each Look preset
    "saved_cap": 500,          # how many saved images the index remembers
}

PREFS = dict(DEFAULTS)

# the caches this pack owns and can rebuild from nothing. Presets, records and images
# are NOT in here and are never touched by the clear button.
CACHE_FILES = ("lora_type_cache.json", "lora_hash_cache.json",
               "lora_civitai_cache.json", "prompt_cache.json")


def _dir(make=False):
    override = os.environ.get("KREA2RN_SETTINGS_DIR")
    if override:
        base = override
    else:
        try:
            import folder_paths
            base = os.path.join(folder_paths.get_user_directory(), "default",
                                "rednode-krea2")
        except Exception:
            base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return base


def get(key, fallback=None):
    """One preference, falling back to its default rather than to None."""
    if key in PREFS:
        return PREFS[key]
    return DEFAULTS.get(key, fallback)


def update(data):
    """Take what the frontend sent, ignoring anything unrecognised or ill-typed."""
    if not isinstance(data, dict):
        return dict(PREFS)
    for key, default in DEFAULTS.items():
        if key not in data:
            continue
        value = data[key]
        if isinstance(default, bool):
            PREFS[key] = bool(value)
        else:
            try:
                PREFS[key] = max(1, int(value))
            except (TypeError, ValueError):
                pass
    return dict(PREFS)


def clear_caches():
    """Delete the regenerable caches. Returns the bytes freed and what went.

    Only files this pack wrote and can rebuild. A missing file is not an error: the
    point is to end up with them gone, not to report on how they got that way.
    """
    freed, gone = 0, []
    base = _dir()
    for name in CACHE_FILES:
        path = os.path.join(base, name)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        try:
            os.remove(path)
        except OSError as e:
            print(f"[RedNode] could not remove {name} ({e})", flush=True)
            continue
        freed += size
        gone.append(name)
    # the caption cache is also held in memory, so clearing only the file would let it
    # write itself straight back
    try:
        from . import autoprompt
        autoprompt._cache.clear()
    except Exception:
        pass
    if gone:
        print(f"[RedNode] cleared {len(gone)} cache file(s), {freed // 1024} KB: "
              + ", ".join(gone), flush=True)
    return freed, gone


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/settings")
    async def _rednode_settings_get(request):
        return web.json_response({"settings": dict(PREFS), "defaults": dict(DEFAULTS)})

    @PromptServer.instance.routes.post("/rednode/settings")
    async def _rednode_settings_post(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        return web.json_response({"settings": update(data)})

    @PromptServer.instance.routes.post("/rednode/clear_caches")
    async def _rednode_clear_caches(request):
        try:
            freed, gone = clear_caches()
        except Exception as e:
            return web.json_response({"error": f"could not clear them ({e})"}, status=500)
        return web.json_response({"freed": freed, "files": gone})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] settings HTTP routes not registered: {e}", flush=True)
