"""RedNode Camera Studio: the node. A scene, a camera, and the translator.

The panel (web/rednode_camera_studio.js) draws a top-view planner - subjects
as dots with facing arrows, the camera with its lens frustum - and keeps the
whole state in the hidden config widget, the pack's pattern. This node reads
that state and hands out:

  prompt        the physical-camera paragraph from camera_translate, ready to
                lead a Krea 2 prompt (or to be joined onto one via prompt_in)
  camera_json   the raw state as JSON, for anything downstream that wants
                numbers instead of words (video models, other translators)
  image         the optional image input, passed through untouched, so the
                node can sit in a review chain and annotate what it sees

Standalone first, by the user's call; the panel is host-agnostic so the
Workspace can mount it later.
"""
import json

from . import camera_translate as _ct


def _ws_blocked():
    """A blocked output when the auto latent is off, so a wired sampler skips
    cleanly instead of receiving None (the workspace's own pattern)."""
    try:
        from . import workspace as _ws
        return _ws.blocked()
    except Exception:
        return None


def parse_state(config_json):
    """The panel's state, normalised. Junk never reaches the translator."""
    try:
        d = json.loads(config_json or "{}")
    except (ValueError, TypeError):
        d = {}
    if not isinstance(d, dict):
        d = {}

    def num(v, dv, lo=None, hi=None):
        try:
            x = float(v)
        except (TypeError, ValueError):
            x = dv
        if lo is not None:
            x = max(lo, x)
        if hi is not None:
            x = min(hi, x)
        return x

    cam = d.get("camera") if isinstance(d.get("camera"), dict) else {}
    pos = cam.get("pos") if isinstance(cam.get("pos"), list) and len(cam.get("pos")) == 3 else [0, 1.56, 3.0]
    camera = {
        "pos": [num(pos[0], 0, -30, 30), num(pos[1], 1.56, 0, 30), num(pos[2], 3, -30, 30)],
        "target": int(num(cam.get("target"), 0, 0, 64)),
        "target_height": (num(cam.get("target_height"), 0, 0, 30)
                          if cam.get("target_height") is not None else None),
        "focal_mm": num(cam.get("focal_mm"), 35, 8, 400),
        "roll_deg": num(cam.get("roll_deg"), 0, -90, 90),
        # lock on subject (default) or aim at a free point for off-centre frames
        "lock": cam.get("lock", True) is not False,
        "aim": ([num(cam["aim"][0], 0, -30, 30), num(cam["aim"][1], 0, 0, 30),
                 num(cam["aim"][2], 0, -30, 30)]
                if isinstance(cam.get("aim"), list) and len(cam.get("aim")) == 3
                else [0.0, 0.0, 0.0]),
    }
    subjects = []
    for s in (d.get("subjects") if isinstance(d.get("subjects"), list) else []):
        if not isinstance(s, dict):
            continue
        p = s.get("pos") if isinstance(s.get("pos"), list) and len(s.get("pos")) == 3 else [0, 0, 0]
        subjects.append({
            "name": str(s.get("name") or "").strip() or "the subject",
            "pos": [num(p[0], 0, -30, 30), num(p[1], 0, 0, 30), num(p[2], 0, -30, 30)],
            "height": num(s.get("height"), 1.7, 0.3, 4.0),
            "facing_deg": num(s.get("facing_deg"), 0, -360, 720) % 360,
        })
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    if camera["target"] >= len(subjects):
        camera["target"] = 0
    return {"camera": camera, "subjects": subjects,
            "output": str(d.get("output") or "krea2"),
            "join": str(d.get("join") or "lead"),
            # AUTO LATENT, the user's ask: an empty latent shaped by the camera's
            # angle, lens and the scene's spread, at a pixel budget. Off by
            # default (the house rule); on, wire the latent output into the
            # sampler instead of an Empty Latent and the frame follows the shot.
            "auto_latent": bool(d.get("auto_latent")),
            "latent_mp": num(d.get("latent_mp"), 1.0, 0.25, 4.0),
            "latent_batch": int(num(d.get("latent_batch"), 1, 1, 64))}


class RedNodeCameraStudio:
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("A virtual cinematography planner: place subjects and a camera "
                   "on a top-view stage, set the lens, and the node writes the "
                   "physical-camera paragraph Krea 2 obeys - where the camera is, "
                   "its tilt, what it sees, the lens - plus scene blocking for "
                   "several subjects. Wire prompt_in to lead your prompt with it.")
    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "LATENT", "INT", "INT")
    RETURN_NAMES = ("prompt", "camera_json", "image", "latent", "width", "height")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                "prompt_in": ("STRING", {"forceInput": True, "tooltip":
                              "Your prompt; the camera paragraph is joined onto it "
                              "(leading it, per the research on positional bias, "
                              "unless the panel says otherwise)."}),
                "image": ("IMAGE", {"tooltip": "Passed through untouched, so the node "
                                    "can sit in a review chain."}),
            },
        }

    def run(self, config="{}", prompt_in=None, image=None):
        st = parse_state(config)
        cam_text = _ct.describe(st["camera"], st["subjects"], output=st["output"])
        if prompt_in and str(prompt_in).strip():
            body = str(prompt_in).strip()
            out = (cam_text + " " + body) if st["join"] == "lead" else (body + " " + cam_text)
        else:
            out = cam_text
        state_out = json.dumps({"camera": st["camera"], "subjects": st["subjects"],
                                "geometry": _ct.camera_geometry(
                                    st["camera"]["pos"],
                                    [st["subjects"][st["camera"]["target"]]["pos"][0],
                                     st["subjects"][st["camera"]["target"]]["pos"][1]
                                     + st["subjects"][st["camera"]["target"]]["height"] * 0.92,
                                     st["subjects"][st["camera"]["target"]]["pos"][2]]),
                                "fov_deg": _ct.fov_deg(st["camera"]["focal_mm"])})
        # the auto latent: always COMPUTED (width/height come out either way,
        # so a graph can read the suggestion), only ALLOCATED when the toggle
        # is on - an empty 16-channel latent for Krea 2 at the suggested shape
        w, h, why = _ct.auto_latent_size(st["camera"], st["subjects"], st["latent_mp"])
        latent = None
        if st["auto_latent"]:
            import torch
            latent = {"samples": torch.zeros([st["latent_batch"], 16, h // 8, w // 8])}
        print("[RedNode Camera Studio] %d subject(s), lens %dmm, %s; auto latent %s: "
              "%d x %d (%s)"
              % (len(st["subjects"]), int(st["camera"]["focal_mm"]),
                 cam_text.split(".")[0], "ON" if st["auto_latent"] else "off",
                 w, h, why), flush=True)
        return (out, state_out, image,
                latent if latent is not None else _ws_blocked(), w, h)


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/camera_studio_preview")
    async def _rn_camera_studio_preview(request):
        """The panel's live paragraph: the same translator the node runs."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        st = parse_state(json.dumps(body))
        return web.json_response({"prompt": _ct.describe(st["camera"], st["subjects"],
                                                         output=st["output"])})
except Exception as _e:
    print("[RedNode Camera Studio] preview route not registered: %s" % _e, flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeCameraStudio": RedNodeCameraStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeCameraStudio": "RedNode Camera Studio"}
