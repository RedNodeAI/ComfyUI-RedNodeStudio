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
import math
import os

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
        # aperture (f-number) for the depth-of-field words; 0 = off
        "aperture": num(cam.get("aperture"), 0, 0, 64),
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
            # LOCKED (the user's ask): a placed thing the stage will not drag
            # (walls, doors, furniture of a room set). Only the panel honours it.
            "locked": bool(s.get("locked", False)),
        })
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0, "kind": "person", "rel": None,
                     "size": [0.6, 0.6]}]
    # THE LIGHTS (2026-08-18): things on the stage like the subjects, but read
    # by camera_translate.light_words instead of the camera paragraph. Diameter
    # and distance decide how hard the light is, intensity and distance decide
    # the ratio against the others, kelvin its colour. Junk never reaches the
    # translator, the same contract as everything else here.
    lights = []
    for l in (d.get("lights") if isinstance(d.get("lights"), list) else []):
        if not isinstance(l, dict):
            continue
        p = l.get("pos") if isinstance(l.get("pos"), list) and len(l.get("pos")) == 3 else [1.5, 2.0, 1.5]
        kind = str(l.get("kind") or "softbox")
        if kind not in _ct.LIGHT_KINDS:
            kind = "softbox"
        lights.append({
            "name": str(l.get("name") or "").strip() or "a light",
            "kind": kind,
            "pos": [num(p[0], 1.5, -30, 30), num(p[1], 2.0, 0, 30), num(p[2], 1.5, -30, 30)],
            # metres across: a 1 m softbox at 1 m wraps, a 5 cm bulb cuts hard
            "diameter": num(l.get("diameter"), 1.0, 0.01, 20.0),
            # relative power; with distance it gives the lighting ratio
            "intensity": num(l.get("intensity"), 1.0, 0.0, 100.0),
            # colour temperature; 0 = say nothing about colour
            "kelvin": num(l.get("kelvin"), 0, 0, 20000),
            "on": l.get("on", True) is not False,
            "locked": bool(l.get("locked", False)),
        })
    if camera["target"] >= len(subjects) or subjects[camera["target"]]["kind"] != "person":
        people = [i for i, x in enumerate(subjects) if x["kind"] == "person"]
        camera["target"] = people[0] if people else 0
    return {"camera": camera, "subjects": subjects, "lights": lights,
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
            # CAMERA PATH (batch angles): off | ab (A -> B, N shots) | orbit
            "path": _camera_path(d),
            # STAGE ZOOM: normal (12 x 9 m), wide (24 x 19 m) or huge (48 x 38 m):
            # an apartment, a pitch, a street need room. Display only.
            "stage_zoom": (d.get("stage_zoom") if d.get("stage_zoom") in ("normal", "wide", "huge")
                           else "normal"),
            "light_loras": _light_loras(d),
            "auto_latent": bool(d.get("auto_latent")),
            "latent_mp": num(d.get("latent_mp"), 1.0, 0.25, 4.0),
            "latent_batch": int(num(d.get("latent_batch"), 1, 1, 64))}


def _camera_path(d):
    raw = d.get("path") if isinstance(d.get("path"), dict) else {}
    mode = raw.get("mode") if raw.get("mode") in _ct.PATH_MODES else "off"
    try:
        shots = int(raw.get("shots", 10) or 10)
    except (TypeError, ValueError):
        shots = 10
    shots = max(1, min(64, shots))
    b = raw.get("b") if isinstance(raw.get("b"), dict) else None
    if b is not None:
        # normalise B like a camera: reuse parse_state on a wrapper
        b = parse_state(json.dumps({"camera": b}))["camera"]

    def _deg(k, dv):
        try:
            v = float(raw.get(k, dv))
        except (TypeError, ValueError):
            v = dv
        return max(-360.0, min(360.0, v))
    return {"mode": mode, "shots": shots, "b": b,
            "orbit_from": _deg("orbit_from", 0.0), "orbit_to": _deg("orbit_to", 180.0)}


def _light_loras(d):
    """The lighting LoRA controls, same shape as the camera ones. Both rows
    Off until asked: a slider that costs image quality is not switched on for
    anybody by default."""
    out = {}
    raw = d.get("light_loras") if isinstance(d.get("light_loras"), dict) else {}
    for key in _ct.LIGHT_LORA_KEYS:
        e = raw.get(key) if isinstance(raw.get(key), dict) else {}
        mode = e.get("mode") if e.get("mode") in ("off", "auto", "manual") else "off"
        try:
            strength = float(e.get("strength", 0.0))
        except (TypeError, ValueError):
            strength = 0.0
        lo, hi = _ct.LIGHT_LORA_RANGE[key]
        out[key] = {"name": str(e.get("name") or ""), "mode": mode,
                    "strength": max(lo, min(hi, strength))}
    return out


def resolve_light_loras(st):
    """[{key, name, strength}] for the lighting LoRAs this state switches on.

    Auto reads the light rig - the brightness slider from the level the lights
    actually make, the colour slider from the key light's kelvin - so the dials
    follow the stage instead of being set twice.
    """
    out = []
    for key in _ct.LIGHT_LORA_KEYS:
        e = (st.get("light_loras") or {}).get(key) or {}
        if e.get("mode", "off") == "off" or not e.get("name"):
            continue
        if e["mode"] == "auto":
            strength = _ct.LIGHT_AUTO_FN[key](st["camera"], st["subjects"],
                                              st.get("lights") or [])
        else:
            strength = float(e.get("strength", 0.0))
        if abs(strength) < 0.05:
            continue
        out.append({"key": key, "name": e["name"], "strength": round(strength, 2)})
    return out


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
    # BATCH ANGLES: with a camera path set, every output is a LIST of N shots
    # (prompt, camera_json, latent, width, height per shot; the image is
    # passed through once). ComfyUI runs the downstream nodes once per item,
    # so one Queue renders the whole path. With the path off the lists have
    # one entry and the graph behaves as before.
    OUTPUT_IS_LIST = (True, True, False, True, True, True)
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
        cams = _ct.camera_path(st["camera"], st["subjects"], st["path"])
        prompts, jsons, latents, ws, hs = [], [], [], [], []
        for i, cam in enumerate(cams):
            shot = self._shot(st, cam, prompt_in, i, len(cams))
            prompts.append(shot[0]); jsons.append(shot[1]); latents.append(shot[2])
            ws.append(shot[3]); hs.append(shot[4])
        if len(cams) > 1:
            print("[RedNode Camera Studio] camera path %s: %d shots" % (st["path"]["mode"], len(cams)),
                  flush=True)
        return (prompts, jsons, image, latents, ws, hs)

    def _shot(self, st, cam, prompt_in, index, count):
        """One shot's outputs for one camera state."""
        cam_text = _ct.describe(cam, st["subjects"], output=st["output"])
        if prompt_in and str(prompt_in).strip():
            body = str(prompt_in).strip()
            out = (cam_text + " " + body) if st["join"] == "lead" else (body + " " + cam_text)
        else:
            out = cam_text
        st_i = dict(st, camera=cam)
        zoom = resolve_zoom(st_i)
        prime = st["subjects"][cam["target"]]
        state_out = json.dumps({"camera": cam, "subjects": st["subjects"],
                                "zoom": zoom,
                                "camera_loras": resolve_camera_loras(st_i),
                                "shot": {"index": index, "count": count},
                                "geometry": _ct.camera_geometry(
                                    cam["pos"],
                                    [prime["pos"][0], prime["pos"][1] + prime["height"] * 0.92,
                                     prime["pos"][2]]),
                                "fov_deg": _ct.fov_deg(cam["focal_mm"])})
        # the auto latent: always COMPUTED (width/height come out either way,
        # so a graph can read the suggestion), only ALLOCATED when the toggle
        # is on - an empty 16-channel latent for Krea 2 at the suggested shape
        w, h, why = _ct.auto_latent_size(cam, st["subjects"], st["latent_mp"])
        latent = None
        if st["auto_latent"]:
            import torch
            latent = {"samples": torch.zeros([st["latent_batch"], 16, h // 8, w // 8])}
        if count == 1:
            print("[RedNode Camera Studio] %d subject(s), lens %dmm, %s; auto latent %s: "
                  "%d x %d (%s)"
                  % (len(st["subjects"]), int(cam["focal_mm"]),
                     cam_text.split(".")[0], "ON" if st["auto_latent"] else "off",
                     w, h, why), flush=True)
        return (out, state_out, latent if latent is not None else _ws_blocked(), w, h)


# ---------------------------------------------------------------- sets
# SETS (the user's ask, "save / load presets for the studio"): a named scene +
# camera state. Built-in sets ship in the pack's camera_sets/ folder (rooms
# built from objects, two-person scenes); the user's own live in the ComfyUI
# user dir like the LoRA presets. Loading a set replaces subjects, camera,
# path, stage zoom AND LIGHTS (2026-08-19, the user's ask): a room with a
# window and no light on it is half a set, and the lighting is the part people
# least want to place twice. The panel keeps the LoRA picks and output
# settings, because a file name is a machine's business, not a scene's.
_SETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camera_sets")
_SET_KEYS = ("camera", "subjects", "path", "stage_zoom", "lights")


def _user_sets_path(make=False):
    override = os.environ.get("KREA2RN_CAMERA_SETS")
    if override:
        return override
    try:
        import folder_paths
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "camera_sets.json")


def _set_state(raw):
    """Only the scene keys of a set, normalised through parse_state."""
    st = parse_state(json.dumps(raw if isinstance(raw, dict) else {}))
    return {k: st[k] for k in _SET_KEYS}


def builtin_sets():
    """[{name, group, description, state}] from camera_sets/*.json, sorted by
    the file's order field then name. Bad files are skipped, not fatal."""
    out = []
    try:
        names = sorted(os.listdir(_SETS_DIR))
    except OSError:
        return out
    for fn in names:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(_SETS_DIR, fn), encoding="utf-8") as f:
                d = json.load(f)
            out.append({"name": str(d.get("name") or fn[:-5]), "group": str(d.get("group") or "Sets"),
                        "description": str(d.get("description") or ""),
                        "text": str(d.get("text") or ""),
                        "order": int(d.get("order", 100)), "state": _set_state(d.get("state") or {})})
        except (OSError, ValueError, TypeError) as e:
            print("[RedNode Camera Studio] set %s skipped: %s" % (fn, e), flush=True)
    out.sort(key=lambda x: (x["order"], x["group"], x["name"]))
    return out


def load_user_sets():
    try:
        with open(_user_sets_path(), encoding="utf-8") as f:
            data = json.load(f)
        return {str(k): _set_state(v) for k, v in (data.get("sets") or {}).items()
                if isinstance(v, dict)}
    except (OSError, ValueError):
        return {}


def save_user_set(name, state):
    sets = load_user_sets()
    sets[name] = _set_state(state)
    path = _user_sets_path(make=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sets": sets}, f, indent=1)
    os.replace(tmp, path)
    return sets


def delete_user_set(name):
    sets = load_user_sets()
    sets.pop(name, None)
    path = _user_sets_path(make=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sets": sets}, f, indent=1)
    os.replace(tmp, path)
    return sets


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/camera_sets")
    async def _rn_camera_sets(request):
        return web.json_response({"builtin": builtin_sets(),
                                  "mine": [{"name": k, "state": v}
                                           for k, v in sorted(load_user_sets().items())]})

    @PromptServer.instance.routes.post("/rednode/camera_sets")
    async def _rn_camera_sets_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        name = str(data.get("name", "")).strip()[:80]
        if not name:
            return web.json_response({"error": "give the set a name"}, status=400)
        try:
            if data.get("action") == "delete":
                sets = delete_user_set(name)
            else:
                sets = save_user_set(name, data.get("state") or {})
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"mine": [{"name": k, "state": v} for k, v in sorted(sets.items())]})

    @PromptServer.instance.routes.post("/rednode/camera_studio_preview")
    async def _rn_camera_studio_preview(request):
        """The panel's live paragraph: the same translator the node runs."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        st = parse_state(json.dumps(body))
        # the lights ride the preview too, so the panel shows the same two
        # paragraphs the queue will send: camera first, then the light rig
        text = _ct.describe(st["camera"], st["subjects"], output=st["output"])
        lit = _ct.light_words(st["camera"], st["subjects"], st["lights"])
        return web.json_response({"prompt": (text + ("\n\n" + lit if lit else "")),
                                  "light": lit})
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
    pats = {"zoom": [r"zoom_krea2", r"zoom.*krea", r"krea.*zoom", r"zoom"],
            "height": [r"camera_height_krea2", r"camera_height", r"cam(era)?[_ -]?height"],
            "orbit": [r"camera_orbit_krea2", r"camera_orbit", r"orbit"],
            "back": [r"camera_back_krea2", r"camera_back", r"back_view"]}
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


# ---------------------------------------------------------------- multi-angle bridge
# THE MULTI-ANGLE EDIT LORA (fal's Qwen-Image-Edit-2511-Multiple-Angles): give
# it a photo and "<sks> <azimuth> <elevation> <distance>" and it re-renders the
# same picture from that viewpoint. This node writes that prompt from the
# studio's camera_json, so the same stage that plans a txt2img shot can steer
# a re-angle of an existing image - and a camera path re-angles it N times.
MA_AZIMUTHS = ["front view", "front-right quarter view", "right side view",
               "back-right quarter view", "back view", "back-left quarter view",
               "left side view", "front-left quarter view"]
MA_ELEVATIONS = ["low-angle shot", "eye-level shot", "elevated shot", "high-angle shot"]
MA_DISTANCES = ["close-up", "medium shot", "wide shot"]


def multi_angle_words(camera, subjects, side="viewer"):
    """(azimuth word, elevation word, distance word, azimuth_deg, elevation_deg)
    for the camera against the target subject. side: whose right the LoRA's
    "right side view" means - the viewer's (default; verified on renders
    2026-08-17: camera moved to our right, we see the subject's left side) or
    the subject's."""
    geo, rel = _ct._prime_geo(camera, subjects)
    # rel: 0 front, +90 the subject's LEFT, -90 their right, 180 behind.
    # The LoRA's azimuth runs front -> front-right -> right -> back-right ->
    # back -> ... clockwise seen from above; "right" = the subject's right by
    # default (rel -90), or the viewer's right (rel +90) when side == "viewer".
    a = -rel if side == "subject" else rel          # degrees clockwise from front
    a = (a + 360.0) % 360.0
    idx = int(((a + 22.5) % 360.0) // 45.0)
    az = MA_AZIMUTHS[idx]
    p = geo["pitch"]                                 # > 0: camera below, looking up
    if p > 15:
        el, el_deg = MA_ELEVATIONS[0], -30
    elif p > -15:
        el, el_deg = MA_ELEVATIONS[1], 0
    elif p > -45:
        el, el_deg = MA_ELEVATIONS[2], 30
    else:
        el, el_deg = MA_ELEVATIONS[3], 60
    focal = float(camera.get("focal_mm", 35))
    width_m = 2.0 * geo["distance"] * math.tan(math.radians(_ct.fov_deg(focal) / 2.0))
    di = MA_DISTANCES[0] if width_m < 1.3 else MA_DISTANCES[1] if width_m < 3.2 else MA_DISTANCES[2]
    # NUDGES between the bands (sandbox strip 2026-08-17: the edit model obeys
    # "rotate the camera a little more to the left/right", "move the camera a
    # little further back" and "much closer"; small height nudges do nothing)
    nudge = []
    off = ((a - idx * 45.0) + 180.0) % 360.0 - 180.0          # degrees past the band centre
    if abs(off) > 14.0:
        nudge.append("rotate the camera a little more to the %s" % ("right" if off > 0 else "left"))
    if di == MA_DISTANCES[1] and width_m > 2.4:
        nudge.append("move the camera a little further back")
    elif di == MA_DISTANCES[0] and width_m < 0.8:
        nudge.append("move the camera much closer")
    return az, el, di, int(round(a)), el_deg, ", ".join(nudge)


class RedNodeCameraMultiAngle:
    """Studio camera -> the multi-angle edit LoRA's prompt. Wire camera_json
    from the Camera Studio, or set the three bands by hand. Takes the whole
    camera path at once, so shots that land in the same bands can be
    collapsed (the LoRA only knows 8 x 4 x 3 viewpoints)."""
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Writes the prompt for fal's Qwen-Image-Edit-2511 Multiple-Angles "
                   "LoRA (\"<sks> azimuth elevation distance\") from the Camera "
                   "Studio's camera_json, so the stage steers a re-angle of an existing "
                   "photo. A camera path gives one prompt per shot; with collapse on, "
                   "shots that fall in the same bands are merged (the LoRA has only 96 "
                   "viewpoints, so a fine path would repeat itself). No camera_json: the "
                   "three pickers are used as set.")
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("prompt", "azimuth", "elevation", "distance", "azimuth_deg", "elevation_deg", "report")
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True, True, True, True, True, True, False)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "azimuth": (MA_AZIMUTHS, {"default": "front view"}),
                "elevation": (MA_ELEVATIONS, {"default": "eye-level shot"}),
                "distance": (MA_DISTANCES, {"default": "medium shot"}),
                "trigger": ("STRING", {"default": "<sks>", "tooltip": "The LoRA's trigger token; keep it."}),
                "right_means": (["the viewer's right", "the subject's right"], {"default": "the viewer's right",
                                "tooltip": "Which right the LoRA's 'right side view' is. Verified on the "
                                           "sandbox strip: the VIEWER's right (camera moved to our right, we "
                                           "see the subject's left side). Flip only if yours come out mirrored."}),
                "nudge": ("BOOLEAN", {"default": False, "tooltip":
                          "Add a plain-language nudge when the studio camera sits between the "
                          "LoRA's bands (a little more to the left/right, a little further back, "
                          "much closer). Verified on renders for azimuth and distance; height "
                          "nudges do nothing, so none are written."}),
                "collapse_same": ("BOOLEAN", {"default": True, "tooltip":
                                  "With a camera path: merge consecutive shots that map to the same "
                                  "bands, so you do not render the same viewpoint twice. Off: one "
                                  "prompt per shot regardless."}),
                "extra": ("STRING", {"default": "", "multiline": True, "tooltip":
                          "Optional words appended after the camera prompt."}),
            },
            "optional": {
                "camera_json": ("STRING", {"forceInput": True, "tooltip":
                                "From the Camera Studio: overrides the three pickers. A path's list is "
                                "taken whole."}),
            },
        }

    def run(self, azimuth, elevation, distance, trigger=None, right_means=None,
            nudge=None, collapse_same=None, extra=None, camera_json=None):
        # INPUT_IS_LIST: every input arrives as a list
        def first(v, dv):
            if isinstance(v, list):
                return v[0] if v else dv
            return v if v is not None else dv
        az0, el0, di0 = first(azimuth, "front view"), first(elevation, "eye-level shot"), first(distance, "medium shot")
        trig = str(first(trigger, "<sks>") or "").strip()
        side = "subject" if str(first(right_means, "the viewer's right")).startswith("the subject") else "viewer"
        collapse = bool(first(collapse_same, True))
        use_nudge = bool(first(nudge, False))
        ext = str(first(extra, "") or "").strip()
        jsons = [j for j in (camera_json if isinstance(camera_json, list) else [camera_json])
                 if isinstance(j, str) and j.strip()]
        shots = []
        for j in jsons:
            try:
                d = json.loads(j)
            except (ValueError, TypeError):
                d = None
            if not (isinstance(d, dict) and d.get("camera")):
                continue
            st = parse_state(json.dumps({"camera": d.get("camera") or {}, "subjects": d.get("subjects") or []}))
            shots.append(multi_angle_words(st["camera"], st["subjects"], side))
        if not shots:
            shots = [(az0, el0, di0, MA_AZIMUTHS.index(az0) * 45,
                      [-30, 0, 30, 60][MA_ELEVATIONS.index(el0)], "")]
        n_in = len(shots)
        if collapse:
            kept = []
            key = (lambda sh: (sh[0], sh[1], sh[2], sh[5])) if use_nudge else (lambda sh: sh[:3])
            for sh in shots:
                if not kept or key(kept[-1]) != key(sh):
                    kept.append(sh)
            shots = kept
        prompts = []
        for az, el, di, _, _, nd in shots:
            ptxt = " ".join(x for x in (trig, az, el, di) if x)
            if use_nudge and nd:
                ptxt += ", " + nd
            prompts.append(ptxt + (" " + ext if ext else ""))
        report = ("%d shot%s -> %d distinct viewpoint%s"
                  % (n_in, "" if n_in == 1 else "s", len(shots), "" if len(shots) == 1 else "s"))
        if n_in > len(shots):
            report += " (the LoRA knows 8 azimuths x 4 elevations x 3 distances; the rest fell in the same bands)"
        if n_in > 1:
            print("[RedNode Camera Multi-Angle] " + report, flush=True)
        return (prompts, [x[0] for x in shots], [x[1] for x in shots], [x[2] for x in shots],
                [int(x[3]) for x in shots], [int(x[4]) for x in shots], report)


NODE_CLASS_MAPPINGS = {"RedNodeCameraStudio": RedNodeCameraStudio,
                       "RedNodeCameraLoRAs": RedNodeCameraLoRAs,
                       "RedNodeCameraMultiAngle": RedNodeCameraMultiAngle}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeCameraStudio": "RedNode Camera Studio",
                              "RedNodeCameraLoRAs": "RedNode Camera LoRAs",
                              "RedNodeCameraMultiAngle": "RedNode Camera Multi-Angle"}
