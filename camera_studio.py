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
        kind = str(s.get("kind") or "person")
        if kind not in ("person", "object", "wall", "window", "door"):
            kind = "object"
        subjects.append({
            "name": str(s.get("name") or "").strip()
                    or ("the subject" if kind == "person" else "an object"),
            "pos": [num(p[0], 0, -30, 30), num(p[1], 0, 0, 30), num(p[2], 0, -30, 30)],
            "height": num(s.get("height"), 1.7 if kind == "person" else 0.8, 0.05, 6.0),
            "facing_deg": num(s.get("facing_deg"), 0, -360, 720) % 360,
            "kind": kind,
            # a relation to another entry: {"kind": "on", "to": index}
            "rel": ({"kind": str(s["rel"].get("kind") or ""),
                     "to": int(num(s["rel"].get("to"), -1, -1, 64))}
                    if isinstance(s.get("rel"), dict) else None),
            # objects have a footprint; people are points
            "size": [num((s.get("size") or [0.6, 0.6])[0], 0.6, 0.05, 20),
                     num((s.get("size") or [0.6, 0.6])[-1], 0.6, 0.05, 20)],
        })
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0, "kind": "person", "rel": None,
                     "size": [0.6, 0.6]}]
    if camera["target"] >= len(subjects) or subjects[camera["target"]]["kind"] != "person":
        people = [i for i, x in enumerate(subjects) if x["kind"] == "person"]
        camera["target"] = people[0] if people else 0
    return {"camera": camera, "subjects": subjects,
            "output": (d.get("output") if d.get("output") in _ct.OUTPUT_MODES else "krea2"),
            "join": str(d.get("join") or "lead"),
            # AUTO LATENT, the user's ask: an empty latent shaped by the camera's
            # angle, lens and the scene's spread, at a pixel budget. Off by
            # default (the house rule); on, wire the latent output into the
            # sampler instead of an Empty Latent and the frame follows the shot.
            # the zoom LoRA (the user's zoom_krea2_loraholic): controlled from
            # the camera, not the LoRA tab. mode: off | auto (from shot size) | manual
            "zoom_lora": str(d.get("zoom_lora") or ""),
            "zoom_mode": (d.get("zoom_mode") if d.get("zoom_mode") in ("off", "auto", "manual")
                          else "off"),
            "zoom_strength": num(d.get("zoom_strength"), 0.0, -20.0, 20.0),
            # THE CAMERA LORAS: {key: {name, mode, strength}} for zoom / height /
            # orbit / back. The zoom_* fields above are the legacy single-LoRA
            # form; _camera_loras() merges both, the newer dict winning.
            "cam_loras": _camera_loras(d),
            "auto_latent": bool(d.get("auto_latent")),
            "latent_mp": num(d.get("latent_mp"), 1.0, 0.25, 4.0),
            "latent_batch": int(num(d.get("latent_batch"), 1, 1, 64))}


def _camera_loras(d):
    """Normalise the per-key LoRA controls; legacy zoom_* fields fold in."""
    out = {}
    raw = d.get("cam_loras") if isinstance(d.get("cam_loras"), dict) else {}
    for key in _ct.CAMERA_LORA_KEYS:
        e = raw.get(key) if isinstance(raw.get(key), dict) else {}
        name = str(e.get("name") or "")
        mode = e.get("mode") if e.get("mode") in ("off", "auto", "manual") else "off"
        try:
            strength = float(e.get("strength", 0.0))
        except (TypeError, ValueError):
            strength = 0.0
        if key == "zoom" and not e:
            # legacy single-zoom form
            name = str(d.get("zoom_lora") or "")
            mode = d.get("zoom_mode") if d.get("zoom_mode") in ("off", "auto", "manual") else "off"
            try:
                strength = float(d.get("zoom_strength", 0.0))
            except (TypeError, ValueError):
                strength = 0.0
        lo, hi = _ct.CAMERA_LORA_RANGE[key]
        out[key] = {"name": name, "mode": mode,
                    "strength": max(lo - 4.0, min(hi + 4.0, strength))}
    return out


AUTO_FN = {"zoom": _ct.auto_zoom_strength, "height": _ct.auto_height_strength,
           "orbit": _ct.auto_orbit_strength, "back": _ct.auto_back_strength}


def resolve_camera_loras(st):
    """[{key, name, strength}] for every camera LoRA this state switches on.

    Auto strengths come from the geometry (the same numbers the words use);
    manual ones are the user's. Off, or no file picked, means absent. A slot
    at strength 0 is dropped too: nothing to apply."""
    out = []
    for key in _ct.CAMERA_LORA_KEYS:
        e = (st.get("cam_loras") or {}).get(key) or {}
        if e.get("mode", "off") == "off" or not e.get("name"):
            continue
        if e["mode"] == "auto":
            strength = AUTO_FN[key](st["camera"], st["subjects"])
        else:
            strength = float(e.get("strength", 0.0))
        if abs(strength) < 0.05:
            continue
        out.append({"key": key, "name": e["name"], "strength": round(strength, 2)})
    return out


def resolve_zoom(st):
    """{name, strength} for the zoom LoRA this state asks for, or None.
    Kept for the older callers; the workspace uses resolve_camera_loras."""
    for e in resolve_camera_loras(st):
        if e["key"] == "zoom":
            return {"name": e["name"], "strength": e["strength"]}
    return None


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
        zoom = resolve_zoom(st)
        state_out = json.dumps({"camera": st["camera"], "subjects": st["subjects"],
                                "zoom": zoom,
                                "camera_loras": resolve_camera_loras(st),
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


def _lora_choices():
    """The LoRA files ComfyUI knows, with a None entry first. Offline (tests)
    the list is just None."""
    try:
        import folder_paths
        names = list(folder_paths.get_filename_list("loras"))
    except Exception:
        names = []
    return ["None"] + names


def _guess_lora(key, names):
    """The default pick per key: RedNode's own camera sliders, then the
    community zoom. First match wins; "None" when nothing fits."""
    import re
    pats = {"zoom": [r"zoom"], "height": [r"camera_height", r"cam(era)?[_ -]?height"],
            "orbit": [r"camera_orbit", r"orbit"], "back": [r"camera_back", r"back_view"]}
    for pat in pats[key]:
        for n in names:
            if n != "None" and re.search(pat, n, re.I):
                return n
    return "None"


class RedNodeCameraLoRAs:
    """The studio's camera LoRAs as a standalone node: model (+clip) in, the
    four slider LoRAs applied at strengths that follow the camera_json from
    the Camera Studio, model (+clip) out. Completes the standalone chain
    (Studio.prompt -> your text encode, Studio.camera_json -> here -> sampler)
    so the studio drives any Krea 2 graph without the workspace."""
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Applies the camera slider LoRAs (zoom / height / orbit / back) "
                   "at strengths set from the Camera Studio's camera_json - Auto "
                   "follows the camera, Manual is your number, Off skips. Wire the "
                   "studio's camera_json in and take model (and clip) out to the "
                   "sampler. Works with the RedNode camera sliders for Krea 2; any "
                   "slider LoRA can sit in a slot.")
    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("model", "clip", "applied")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        names = _lora_choices()
        req = {"model": ("MODEL",),
               "camera_json": ("STRING", {"forceInput": True, "tooltip":
                               "The Camera Studio's camera_json output. Auto strengths "
                               "are computed from it; without it Auto reads 0."})}
        for key in _ct.CAMERA_LORA_KEYS:
            lo, hi = _ct.CAMERA_LORA_RANGE[key]
            req[key + "_lora"] = (names, {"default": _guess_lora(key, names)})
            req[key + "_mode"] = (["off", "auto", "manual"], {"default": "off", "tooltip":
                                  "Auto: strength from the camera. Manual: the number below."})
            req[key + "_strength"] = ("FLOAT", {"default": 0.0, "min": float(lo) - 4.0,
                                     "max": float(hi) + 4.0, "step": 0.1,
                                     "tooltip": "Used in Manual mode. About +-8 is a strong "
                                                "effect for the RedNode sliders."})
        return {"required": req, "optional": {"clip": ("CLIP",)}}

    def run(self, model, camera_json="", clip=None, **kw):
        try:
            d = json.loads(camera_json or "{}")
        except (ValueError, TypeError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        # accept the studio's camera_json (camera + subjects) or a raw panel state
        cam_state = {"camera": d.get("camera") or {}, "subjects": d.get("subjects") or []}
        st = parse_state(json.dumps(cam_state))
        wanted = []
        for key in _ct.CAMERA_LORA_KEYS:
            name = kw.get(key + "_lora", "None")
            mode = kw.get(key + "_mode", "off")
            if mode == "off" or not name or name == "None":
                continue
            if mode == "auto":
                strength = AUTO_FN[key](st["camera"], st["subjects"]) if d else 0.0
            else:
                strength = float(kw.get(key + "_strength", 0.0))
            if abs(strength) < 0.05:
                continue
            wanted.append((key, name, round(strength, 2)))
        if not wanted:
            return (model, clip, "")
        return _apply_loras(model, clip, wanted)


def _apply_loras(model, clip, wanted):
    """Chain the LoRAs onto clones of model/clip (never the wired originals)."""
    import comfy.sd
    import comfy.utils
    import folder_paths
    applied, missing = [], []
    for key, name, strength in wanted:
        path = folder_paths.get_full_path("loras", name)
        if path is None:
            missing.append(name)
            continue
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        model, clip = comfy.sd.load_lora_for_models(model, clip, lora, strength,
                                                    strength if clip is not None else 0.0)
        applied.append("%s %+.1f (%s)" % (key, strength, name))
    if missing:
        print("[RedNode Camera LoRAs] not found, skipped: %s" % ", ".join(missing), flush=True)
    if applied:
        print("[RedNode Camera LoRAs] " + ", ".join(applied), flush=True)
    return (model, clip, ", ".join(applied))


NODE_CLASS_MAPPINGS = {"RedNodeCameraStudio": RedNodeCameraStudio,
                       "RedNodeCameraLoRAs": RedNodeCameraLoRAs}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeCameraStudio": "RedNode Camera Studio",
                              "RedNodeCameraLoRAs": "RedNode Camera LoRAs"}
