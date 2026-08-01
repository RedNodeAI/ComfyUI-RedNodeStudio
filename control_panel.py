"""RedNode Control Panel — every dropdown, toggle and number in the workflow, in one list.

Why it exists: the settings that actually change between runs (sampler, scheduler, model,
CFG, steps, denoise, a dozen true/false toggles) are scattered across the canvas. This node
collects the ones you care about into one panel and drives them live — no wires, no COMBO
edges. Each row points at another node's widget and sets it directly in the frontend, so at
queue time that node serializes the value you picked here.

Numbers came after dropdowns and toggles. Driving a sampler from here but flying across the
canvas for its CFG was half a panel, and wiring premade combos into numeric inputs is no
answer when the thing you want is a bar. A numeric row draws a bar between the widget's own
declared bounds; widgets that declare none (seeds above all) ask for the two ends once and
remember them on the row, because a bar with invented ends would be a dial that lies.

Stage 1 was RedNode Combo Control (one target). Stage 2 was this node with canvas combos.
This is Stage 3: the same panel language as RedNode LoRA Stack and RedNode Group Control —
searchable picker, drag order, section titles, colours, and saved scenes.

`config` is the source of truth and is plain JSON, so a workflow whose widget is damaged
can still be repaired by hand. Scenes live beside the other RedNode presets in the ComfyUI
user directory, so they are shared by every workflow.

Nothing happens at execution time; all the behaviour is in web/rednode_control_panel.js.
"""

import json
import os

import folder_paths


CUSTOM_SENTINEL = "custom (live)"


def _scenes_path(make=False):
    override = os.environ.get("KREA2RN_CONTROL_SCENES")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "control_scenes.json")


def load_scenes():
    """{scene name: {control key: value}} — the key is "Node title · widget"."""
    try:
        with open(_scenes_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for name, values in (data.get("scenes") or {}).items():
            if isinstance(values, dict):
                out[str(name)] = {str(k): _clean(v) for k, v in values.items()}
        return out
    except (OSError, ValueError):
        return {}


def _clean(v):
    """Values arrive from the browser: keep the JSON scalars, stringify anything else."""
    return v if isinstance(v, (str, int, float, bool)) or v is None else str(v)


def save_scene(name, values):
    name = str(name).strip()
    if not name:
        raise ValueError("give the scene a name")
    if name == CUSTOM_SENTINEL:
        raise ValueError(f"{CUSTOM_SENTINEL!r} is reserved")
    scenes = load_scenes()
    scenes[name] = {str(k): _clean(v) for k, v in (values or {}).items()}
    with open(_scenes_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "scenes": scenes}, f, indent=2, ensure_ascii=False)
    return name


def delete_scene(name):
    scenes = load_scenes()
    scenes.pop(str(name), None)
    with open(_scenes_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "scenes": scenes}, f, indent=2, ensure_ascii=False)


class RedNodeControlPanel:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene": ([CUSTOM_SENTINEL] + sorted(load_scenes()),
                          {"tooltip": "apply a saved set of values to every control named in it. "
                                      "'custom (live)' leaves the controls as they are."}),
                "config": ("STRING", {"default": "{}", "multiline": True,
                           "tooltip": "the control rows (target, value, bar range, colours, order). "
                                      "The panel above edits this; editable by hand if the UI is "
                                      "unavailable."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False
    CATEGORY = "RedNode/Control"
    DESCRIPTION = ("One node, many controls. Each row drives another node's dropdown, toggle or "
                   "number live (no wires), with search, colours, section titles and saved scenes.")

    def noop(self, scene=CUSTOM_SENTINEL, config="{}"):
        return ()


# ---------------------------------------------------------------------------
# HTTP API for the panel (scenes live on disk, shared by every workflow)
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/control_scenes")
    async def _rednode_control_scenes(request):
        name = request.query.get("name")
        scenes = load_scenes()
        if name:
            if name not in scenes:
                return web.json_response({"error": "no such scene"}, status=404)
            return web.json_response({"name": name, "values": scenes[name]})
        return web.json_response({"scenes": sorted(scenes)})

    @PromptServer.instance.routes.post("/rednode/control_scenes")
    async def _rednode_control_scenes_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_scene(data.get("name", ""), data.get("values") or {})
            elif data.get("action") == "delete":
                delete_scene(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"scenes": sorted(load_scenes())})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] control scene HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeControlPanel": RedNodeControlPanel}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeControlPanel": "RedNode Control Panel"}
