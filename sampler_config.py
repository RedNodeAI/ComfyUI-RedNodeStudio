"""RedNode Sampler Config: one node, the right sampler settings for the loaded model.

The problem it replaces: rgthree's KSampler Config plus a manual switch every time the
checkpoint changes between a turbo distill (8 steps, CFG 1) and a full model (20 steps,
CFG 3). This node holds BOTH profiles and picks one by looking at what is actually
loaded.

Detection: the MODEL socket carries no filename, so the node reads the queued prompt
graph instead (the hidden PROMPT input), walks upstream from its own model input through
LoRA loaders and patchers until it finds the loader, and takes the file name it loads.
Names matching turbo / hyper / lightning / lcm / distill / dmd / schnell pick the turbo
profile; everything else is full. The console says what was detected and why, and an
override dropdown wins over detection for the odd mislabelled file.

Outputs plug straight into a KSampler: steps, cfg, sampler and scheduler (as real combo
types, so they connect to widget-inputs), plus the model passed through, denoise, and an
is_turbo BOOLEAN for driving a RedNode Switch or Router.
"""

import json
import os
import re

import comfy.samplers

TURBO_PATTERN = re.compile(r"turbo|hyper|lightning|lcm|distill|dmd|schnell", re.IGNORECASE)
_FILE_SUFFIXES = (".safetensors", ".sft", ".gguf", ".ckpt", ".pt", ".pth")


def find_model_file(prompt, unique_id):
    """Walk the queued graph upstream from this node's model input to the loader's file.

    Follows `model` links through however many LoRA loaders / patch nodes sit between,
    and returns the first filename-shaped widget value it meets. None when the chain
    cannot be traced (missing prompt, model not linked, exotic loader with no filename).
    """
    if not isinstance(prompt, dict):
        return None
    node = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(node, dict):
        return None
    link = (node.get("inputs") or {}).get("model")
    seen = set()
    best = None
    while isinstance(link, list) and len(link) >= 1:
        src_id = str(link[0])
        if src_id in seen:
            break
        seen.add(src_id)
        src = prompt.get(src_id)
        if not isinstance(src, dict):
            break
        inputs = src.get("inputs") or {}
        for value in inputs.values():
            if isinstance(value, str) and value.lower().endswith(_FILE_SUFFIXES):
                # the DEEPEST file wins: a LoRA loader between here and the checkpoint
                # also names a .safetensors, and reading that one would let a detail
                # LoRA's name decide the sampler profile
                best = value
                break
        link = inputs.get("model")
    return best


def is_turbo_name(filename):
    return bool(TURBO_PATTERN.search(str(filename or "")))


# ---- named profiles: user-authored dial sets, one JSON in the ComfyUI user dir -----
# The turbo/full pair covers two kinds of model; the user runs four or five. A profile
# is a NAMED version of the same dial set, Z-Turbo, XL, NAI, FLUX, whatever, authored
# from the node's right-click menu and picked from the appended profile widget. "auto"
# keeps the detection behaviour exactly, so a workflow that never touches profiles
# never changes.

PROFILE_KEYS = ("steps", "cfg", "sampler", "scheduler", "detailer_steps")


def _profiles_path(make=False):
    import folder_paths
    base = os.path.join(folder_paths.get_user_directory(), "default", "rednode")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "sampler_profiles.json")


def load_profiles():
    try:
        with open(_profiles_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    if isinstance(raw, dict):
        for name, cfg in raw.items():
            if not isinstance(cfg, dict) or not str(name).strip():
                continue
            out[str(name).strip()[:48]] = {k: cfg.get(k) for k in PROFILE_KEYS}
    return out


def save_profiles(profiles):
    with open(_profiles_path(make=True), "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=1)


class RedNodeSamplerConfig:
    @classmethod
    def INPUT_TYPES(cls):
        samplers = comfy.samplers.KSampler.SAMPLERS
        schedulers = comfy.samplers.KSampler.SCHEDULERS
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "the loaded model; its loader's file name decides the profile"}),
                "override": (["auto", "turbo", "full"], {"default": "auto", "tooltip":
                             "auto reads the loader's file name; turbo or full forces a profile "
                             "when a file is named misleadingly"}),
                "turbo_steps": ("INT", {"default": 8, "min": 1, "max": 200}),
                "turbo_cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1}),
                "turbo_sampler": (samplers, {"default": "euler"}),
                "turbo_scheduler": (schedulers, {"default": "simple"}),
                "full_steps": ("INT", {"default": 20, "min": 1, "max": 200}),
                "full_cfg": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 30.0, "step": 0.1}),
                "full_sampler": (samplers, {"default": "euler"}),
                "full_scheduler": (schedulers, {"default": "simple"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                            "tooltip": "passed through to both profiles"}),
                # AFTER the originals: widget values restore by position, so new widgets
                # must append or existing nodes would scramble on load
                "turbo_detailer_steps": ("INT", {"default": 6, "min": 1, "max": 100, "tooltip":
                                        "steps for the second detailer pass when a turbo model is loaded"}),
                "full_detailer_steps": ("INT", {"default": 12, "min": 1, "max": 100, "tooltip":
                                       "steps for the second detailer pass on a full model"}),
                # APPENDED, so saved workflows keep loading by position. The list is
                # rebuilt whenever the frontend refreshes object_info, which is how
                # every dynamic combo in ComfyUI stays current.
                "profile": (["auto"] + sorted(load_profiles()), {"default": "auto",
                            "tooltip": "auto detects turbo against full from the "
                            "loader's file name, exactly as before. A NAMED profile "
                            "overrides every dial with the set saved under that name: "
                            "right-click this node to save or delete profiles."}),
            },
            "optional": {
                "denoise_in": ("FLOAT", {"forceInput": True, "tooltip":
                               "wire the Workspace's denoise output here; when connected it "
                               "overrides the denoise widget, so an i2i pass drives the "
                               "sampler strength automatically"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("MODEL", "INT", "FLOAT", comfy.samplers.KSampler.SAMPLERS,
                    comfy.samplers.KSampler.SCHEDULERS, "FLOAT", "BOOLEAN", "STRING", "INT",
                    "INT")
    RETURN_NAMES = ("model", "steps", "cfg", "sampler_name", "scheduler", "denoise",
                    "is_turbo", "profile", "detailer_steps", "start_at_step")
    FUNCTION = "pick"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("Detects whether the loaded model is a turbo distill from its loader's file "
                   "name and outputs the matching sampler settings, so switching checkpoints "
                   "stops meaning re-typing steps and CFG.")

    @classmethod
    def VALIDATE_INPUTS(cls, profile=None, **kwargs):
        # a combo of saved names must not brick a workflow when a name is deleted:
        # pick() falls back to auto with a console line instead
        return True

    @classmethod
    def IS_CHANGED(cls, prompt=None, unique_id=None, profile="auto", **kwargs):
        # Two things change this node's answer without any widget changing: the
        # UPSTREAM loader's filename, and the CONTENTS of the picked profile, which
        # live in a file the user edits from the menu. Hash both, or a checkpoint
        # swap or a profile edit would serve stale settings.
        chosen = load_profiles().get(str(profile or "")) if profile != "auto" else None
        return f"{find_model_file(prompt, unique_id)}|{json.dumps(chosen, sort_keys=True)}"

    def pick(self, model, override="auto", turbo_steps=8, turbo_cfg=1.0,
             turbo_sampler="euler", turbo_scheduler="simple", full_steps=20,
             full_cfg=3.0, full_sampler="euler", full_scheduler="simple",
             denoise=1.0, turbo_detailer_steps=6, full_detailer_steps=12,
             profile="auto", denoise_in=None, prompt=None, unique_id=None):
        if profile and profile != "auto":
            chosen = load_profiles().get(str(profile))
            if chosen is None:
                print(f"[RedNode Sampler Config] profile {profile!r} no longer "
                      f"exists; falling back to auto detection", flush=True)
            else:
                dn = denoise_in if denoise_in is not None else denoise
                steps = int(chosen.get("steps") or full_steps)
                cfg = float(chosen.get("cfg") if chosen.get("cfg") is not None
                            else full_cfg)
                sampler = str(chosen.get("sampler") or full_sampler)
                scheduler = str(chosen.get("scheduler") or full_scheduler)
                det = int(chosen.get("detailer_steps") or full_detailer_steps)
                print(f"[RedNode Sampler Config] profile '{profile}' "
                      f"(steps {steps}, cfg {cfg}, {sampler}/{scheduler}, "
                      f"detailer {det})", flush=True)
                return (model, steps, cfg, sampler, scheduler, dn, False,
                        str(profile), det, 0)
        filename = find_model_file(prompt, unique_id)
        if override != "auto":
            turbo = override == "turbo"
            why = f"override = {override}"
        elif filename is None:
            turbo = False
            why = "could not trace the loader; assuming full (set override if wrong)"
        else:
            turbo = is_turbo_name(filename)
            why = f"'{filename}'"
        profile = "turbo" if turbo else "full"
        steps, cfg, sampler, scheduler = (
            (turbo_steps, turbo_cfg, turbo_sampler, turbo_scheduler) if turbo
            else (full_steps, full_cfg, full_sampler, full_scheduler))
        detailer_steps = turbo_detailer_steps if turbo else full_detailer_steps
        # the wired denoise (the Workspace's i2i dial) beats the widget. start_at_step
        # translates it for KSamplerAdvanced rigs, which have no denoise input at all:
        # add_noise = enable + this start step is the advanced sampler's partial pass
        if denoise_in is not None:
            try:
                denoise = max(0.0, min(1.0, float(denoise_in)))
            except (TypeError, ValueError):
                pass
        start_at = max(0, min(steps, round(steps * (1.0 - denoise))))
        extra = f", denoise {denoise}, start_at_step {start_at}" if denoise < 1.0 else ""
        print(f"[RedNode Sampler Config] {why} -> {profile} "
              f"(steps {steps}, cfg {cfg}, {sampler}/{scheduler}, "
              f"detailer {detailer_steps}{extra})", flush=True)
        return (model, steps, cfg, sampler, scheduler, denoise, turbo, profile,
                detailer_steps, start_at)


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/sampler_profiles")
    async def _rn_sampler_profiles(request):
        return web.json_response({"profiles": load_profiles()})

    @PromptServer.instance.routes.post("/rednode/sampler_profiles")
    async def _rn_sampler_profiles_post(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        name = str(body.get("name") or "").strip()[:48]
        if not name or name.lower() == "auto":
            return web.json_response({"error": "that name cannot be used"}, status=400)
        profiles = load_profiles()
        if body.get("delete"):
            profiles.pop(name, None)
        else:
            values = body.get("values") or {}
            profiles[name] = {k: values.get(k) for k in PROFILE_KEYS}
        try:
            save_profiles(profiles)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"profiles": profiles})
except Exception as _e:
    print(f"[RedNode Sampler Config] profile routes not registered: {_e}", flush=True)

NODE_CLASS_MAPPINGS = {"RedNodeSamplerConfig": RedNodeSamplerConfig}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeSamplerConfig": "RedNode Sampler Config (auto turbo)"}
