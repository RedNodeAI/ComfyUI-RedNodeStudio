"""RedNode Group Control — one readable panel for every group in the workflow.

Why it exists: bypassing groups means hunting tiny canvas text at whatever zoom you
happen to be at. This lists every group as a big row you can toggle, jump to, colour
and fold, and saves named on/off "scenes" so a whole pipeline flips in one click.

Everything happens in the browser (groups and node modes are frontend state), so this
node does nothing at run time — it exists to hold the panel and its config, exactly
like RedNode LoRA Stack holds its slot list. `config` is the source of truth and is
plain JSON, so a workflow that loses the widget can still be repaired by hand.

Scenes are stored beside the other RedNode presets in the ComfyUI user directory.
"""

import json
import os

import folder_paths


CUSTOM_SENTINEL = "custom (live)"


def _scenes_path(make=False):
    override = os.environ.get("KREA2RN_GROUP_SCENES")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "group_scenes.json")


def load_scenes():
    """{scene name: {group title: True(on)/False(bypassed)}}"""
    try:
        with open(_scenes_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for k, v in (data.get("scenes") or {}).items():
            if isinstance(v, dict):
                out[str(k)] = {str(gk): bool(gv) for gk, gv in v.items()}
        return out
    except (OSError, ValueError):
        return {}


def save_scene(name, states):
    name = str(name).strip()
    if not name:
        raise ValueError("give the scene a name")
    if name == CUSTOM_SENTINEL:
        raise ValueError(f"{CUSTOM_SENTINEL!r} is reserved")
    scenes = load_scenes()
    scenes[name] = {str(k): bool(v) for k, v in (states or {}).items()}
    with open(_scenes_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "scenes": scenes}, f, indent=2, ensure_ascii=False)
    return name


def delete_scene(name):
    scenes = load_scenes()
    scenes.pop(str(name), None)
    with open(_scenes_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "scenes": scenes}, f, indent=2, ensure_ascii=False)


class RedNodeGroupControl:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene": ([CUSTOM_SENTINEL] + sorted(load_scenes()),
                          {"tooltip": "apply a saved on/off scene to every group named in it. "
                                      "'custom (live)' just leaves the groups as they are."}),
                "config": ("STRING", {"default": "{}", "multiline": True,
                           "tooltip": "panel state (row order, colours, folds). The panel above edits "
                                      "this; editable by hand if the UI is unavailable."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("Turn workflow groups on/off from one readable panel: jump to a group, colour it, "
                   "fold it away, and save named scenes (fast / detail / upscale…) that flip the whole "
                   "pipeline at once.")

    def noop(self, scene=CUSTOM_SENTINEL, config="{}"):
        return ()


# ---------------------------------------------------------------------------
# HTTP API for the panel (scenes live on disk, shared by every workflow)
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/group_scenes")
    async def _rednode_group_scenes(request):
        name = request.query.get("name")
        scenes = load_scenes()
        if name:
            if name not in scenes:
                return web.json_response({"error": "no such scene"}, status=404)
            return web.json_response({"name": name, "states": scenes[name]})
        return web.json_response({"scenes": sorted(scenes)})

    @PromptServer.instance.routes.post("/rednode/group_scenes")
    async def _rednode_group_scenes_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_scene(data.get("name", ""), data.get("states") or {})
            elif data.get("action") == "delete":
                delete_scene(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"scenes": sorted(load_scenes())})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] group scene HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeGroupControl": RedNodeGroupControl}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeGroupControl": "RedNode Group Control"}
