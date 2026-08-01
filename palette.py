"""RedNode Palette — the colours that drive every RedNode Router in the workflow.

One node, a list of named colours, each on or off. Every router reads it wirelessly (the
frontend mirrors the active set into each router, the same mechanism RedNode Control
Panel uses), so one place decides which branches run everywhere.

Named sets can be saved as presets: "hires portrait" turns on two colours, and the whole
graph re-routes. `preset` is an ordinary dropdown, so RedNode Control Panel can drive it
and a control scene can carry it.

Nothing happens at execution time; the routers hold the state they need. All the UI is in
web/rednode_palette.js.
"""

import json
import os

import folder_paths


CUSTOM_SENTINEL = "custom (live)"


def _presets_path(make=False):
    override = os.environ.get("KREA2RN_PALETTE_PRESETS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "palette_presets.json")


def load_presets():
    """{preset name: [colour name, …]} — the colours that preset switches on."""
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for name, colors in (data.get("presets") or {}).items():
            if isinstance(colors, list):
                out[str(name)] = [str(c) for c in colors if str(c).strip()]
        return out
    except (OSError, ValueError):
        return {}


def save_preset(name, colors):
    name = str(name).strip()
    if not name:
        raise ValueError("give the preset a name")
    if name == CUSTOM_SENTINEL:
        raise ValueError(f"{CUSTOM_SENTINEL!r} is reserved")
    presets = load_presets()
    presets[name] = [str(c) for c in (colors or []) if str(c).strip()]
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
    return name


def delete_preset(name):
    presets = load_presets()
    presets.pop(str(name), None)
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)


class RedNodePalette:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": ([CUSTOM_SENTINEL] + sorted(load_presets()),
                           {"tooltip": "switch on a saved set of colours. 'custom (live)' leaves "
                                       "them as they are."}),
                "config": ("STRING", {"default": "{}", "multiline": True,
                           "tooltip": "the colours and which are on, as JSON. The panel above "
                                      "edits this; editable by hand if the UI is unavailable."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("The colours that drive every RedNode Router: switch a colour on and the "
                   "branches tagged with it take over, with no wires and no boolean gates.")

    def noop(self, preset=CUSTOM_SENTINEL, config="{}"):
        return ()


# ---------------------------------------------------------------------------
# HTTP API for the panel (presets live on disk, shared by every workflow)
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/palette_presets")
    async def _rednode_palette_presets(request):
        name = request.query.get("name")
        presets = load_presets()
        if name:
            if name not in presets:
                return web.json_response({"error": "no such preset"}, status=404)
            return web.json_response({"name": name, "colors": presets[name]})
        return web.json_response({"presets": sorted(presets)})

    @PromptServer.instance.routes.post("/rednode/palette_presets")
    async def _rednode_palette_presets_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_preset(data.get("name", ""), data.get("colors") or [])
            elif data.get("action") == "delete":
                delete_preset(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"presets": sorted(load_presets())})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] palette preset HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodePalette": RedNodePalette}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePalette": "RedNode Palette"}
