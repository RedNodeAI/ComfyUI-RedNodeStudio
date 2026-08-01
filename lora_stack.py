"""RedNode LoRA Stack — multi-LoRA loader with per-slot randomization, trigger-word
output, and named presets.

Why it exists: with a dozen tuned LoRAs, the per-run chores are always the same —
retype the strengths, remember which ones pair, paste the trigger words. This node
saves the whole stack under a name and restores every number, toggle and keyword in
one dropdown.

Design notes:
- `stack_json` is the source of truth (a list of slot dicts). The web widget in
  web/rednode_lora_stack.js renders it; without the widget the node still works by
  editing the JSON directly, so a frontend hiccup can never break a workflow.
- Per-slot randomization rolls a strength in [rand_min, rand_max] driven by `seed`,
  so a run is reproducible: same seed + same stack = same strengths. The rolled
  values are printed once per execution and exported on `strengths_used`.
- Presets are stored next to the RedNode Studio presets (ComfyUI user dir), same
  pattern: JSON, bounded, human-editable.

Slot schema (all keys optional except name):
    {"name": "foo.safetensors", "enabled": true, "strength": 1.0,
     "clip_strength": null,          # null/absent = follow strength
     "trigger": "keywords",
     "random": false, "rand_min": 0.0, "rand_max": 2.0,
     "scale_min": -2.0, "scale_max": 2.0,
     "label": "nickname",           # display only; the file is still `name`
     "note": "free text"}           # user's own notes, carried through presets

`rand_min`/`rand_max` are the random band (rolled when `random` is on).
`scale_min`/`scale_max` are UI-only: the slider's end stops. They carry through
presets so a saved stack restores the same slider feel; sampling ignores them.

UI layout (row list, drag-to-reorder, per-slot menu) is inspired by the MIT-licensed
NO8D-controls LoRA stack (github.com/no8d/ComfyUI-NO8D-controls); this is an
independent implementation.
"""

import json
import os
import random

import comfy.sd
import comfy.utils
import folder_paths

NO_LORA = "None"
_EPS = 1e-6
CUSTOM_SENTINEL = "custom (use stack)"


# --------------------------------------------------------------- preset store

def _presets_path(make=False):
    """LoRA-stack preset store; mirrors the RedNode Studio preset location."""
    override = os.environ.get("KREA2RN_LORA_PRESETS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "lora_presets.json")


def load_presets():
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for k, v in data.get("presets", {}).items():
            if isinstance(v, list):
                out[str(k)] = v
        return out
    except (OSError, ValueError):
        return {}


def save_preset(name, slots):
    path = _presets_path(make=True)
    presets = load_presets()
    presets[name] = slots
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
    return path


# ------------------------------------------------------------- slot handling

def parse_stack(stack_json):
    """Accepts either a bare list of slots (legacy) or {"ui": {...}, "slots": [...]}.
    Returns (slots, ui). `ui` is frontend-only (step size etc.) and passes through."""
    try:
        data = json.loads(stack_json or "[]")
    except (TypeError, ValueError) as e:
        raise ValueError(f"RedNode LoRA Stack: stack data is not valid JSON ({e})")
    if isinstance(data, dict):
        return data.get("slots") or [], data.get("ui") or {}
    if isinstance(data, list):
        return data, {}
    raise ValueError("RedNode LoRA Stack: stack data must be a list of slots")


def parse_slots(stack_json):
    slots, _ui = parse_stack(stack_json)
    clean = []
    for i, s in enumerate(slots, 1):
        if not isinstance(s, dict):
            raise ValueError(f"RedNode LoRA Stack: slot {i} must be an object")
        # title rows are labels for grouping — kept (so presets keep their layout)
        # but never loaded, never rolled, never contribute keywords
        if s.get("type") == "title":
            clean.append({"type": "title", "text": str(s.get("text", "") or ""),
                          "color": s.get("color") or None,
                          "text_color": s.get("text_color") or None})
            continue
        name = str(s.get("name", NO_LORA))

        def _num(key, default):
            try:
                return float(s.get(key, default))
            except (TypeError, ValueError):
                raise ValueError(f"RedNode LoRA Stack: slot {i} ({name}) has a non-numeric {key}")

        clip_s = s.get("clip_strength", None)
        clean.append({
            "type": "lora",
            "color": s.get("color") or None,
            # optional nickname shown instead of the filename (display only)
            "label": str(s.get("label", "") or "").strip() or None,
            # free-text note the user keeps about this LoRA (never affects sampling)
            "note": str(s.get("note", "") or "") or None,
            # colour of the nickname text (display only)
            "label_color": str(s.get("label_color", "") or "").strip() or None,
            # where this LoRA came from, stamped by the info lookup so a SHARED workflow
            # can point someone at the exact model version even without the file
            "civitai": s.get("civitai") if isinstance(s.get("civitai"), dict) else None,
            "name": name,
            "enabled": bool(s.get("enabled", True)),
            "strength": _num("strength", 1.0),
            "clip_strength": None if clip_s is None else float(clip_s),
            "trigger": str(s.get("trigger", "") or "").strip(),
            "random": bool(s.get("random", False)),
            "rand_step": _num("rand_step", 0.0),
            "rand_min": _num("rand_min", 0.0),
            "rand_max": _num("rand_max", 2.0),
            # UI-only slider bounds; preserved so presets keep their feel
            "scale_min": _num("scale_min", -2.0),
            "scale_max": _num("scale_max", 2.0),
        })
    return clean


def resolve_strengths(slots, seed, step=0.0):
    """Roll randomized slots. Deterministic: same seed + same stack -> same values.
    Each slot draws from its own stream (seed + index) so editing one slot's range
    doesn't reshuffle the others.

    `step` quantizes the roll: 0 draws anywhere in the range (thousands of values,
    hard to read or reproduce), while e.g. 0.25 over -1.5..1.5 gives exactly 13
    outcomes. A slot's own `rand_step` overrides the stack-wide value."""
    out = []
    for i, s in enumerate(slots):
        if s.get("type") == "title":
            out.append(0.0)                      # placeholder: keeps indices aligned
            continue
        st = s["strength"]
        if s["random"] and s["enabled"] and s["name"] != NO_LORA:
            lo, hi = sorted((s["rand_min"], s["rand_max"]))
            rng = random.Random(f"{seed}:{i}:{s['name']}")
            q = s.get("rand_step") or step or 0.0
            if q > 0 and hi > lo:
                n = int(round((hi - lo) / q))    # inclusive count of steps
                st = lo + rng.randint(0, max(0, n)) * q
                st = round(min(st, hi), 6)
            else:
                st = round(rng.uniform(lo, hi), 3)
        out.append(st)
    return out


def trigger_words(slots, strengths):
    """Keywords of the slots that actually loaded, in stack order, deduped."""
    words, seen = [], set()
    for s, st in zip(slots, strengths):
        if s.get("type") == "title":
            continue
        if not s["enabled"] or s["name"] == NO_LORA or abs(st) <= _EPS or not s["trigger"]:
            continue
        for part in s["trigger"].split(","):
            part = part.strip()
            if part and part.casefold() not in seen:
                seen.add(part.casefold())
                words.append(part)
    return ", ".join(words)


def _report_rolls(unique_id, slots, strengths):
    """Tell the panel what the randomized slots actually drew this run (display only —
    a websocket hiccup can never affect sampling, hence the blanket except)."""
    if unique_id is None:
        return
    rolled = {str(i): round(st, 4) for i, (s, st) in enumerate(zip(slots, strengths))
              if s.get("type") != "title" and s.get("random") and s.get("enabled")
              and s.get("name") != NO_LORA}
    if not rolled:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("rednode.lora_rolled",
                                        {"node": str(unique_id), "rolled": rolled})
    except Exception:
        pass


# ----------------------------------------------------------------- the nodes

class RedNodeLoraStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "preset": ([CUSTOM_SENTINEL] + sorted(load_presets()),
                           {"tooltip": "load a saved stack; 'custom (use stack)' uses the slots on this node. New saves appear after a node-definition refresh (r)."}),
                "stack_json": ("STRING", {"default": "[]", "multiline": True,
                               "tooltip": "the slot list (the panel above edits this). Editable by hand if the UI is unavailable."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                         "tooltip": "drives randomized slots — same seed + same stack = same strengths. Set control_after_generate to randomize for a fresh roll each queue."}),
            },
            "optional": {
                "clip": ("CLIP", {"tooltip": "optional — connect to apply CLIP-side LoRA strengths too"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("model", "clip", "keywords", "applied_loras")
    FUNCTION = "apply"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("Multi-LoRA loader: per-slot strength, optional randomized range, trigger-word "
                   "output for prompt building, and named presets for the whole stack.")

    @classmethod
    def IS_CHANGED(cls, preset=CUSTOM_SENTINEL, stack_json="[]", seed=0, **kwargs):
        # re-run when the seed moves (random rolls) or a saved preset changed on disk
        key = f"{preset}:{seed}:{stack_json}"
        if preset != CUSTOM_SENTINEL:
            try:
                key += f":{os.path.getmtime(_presets_path())}"
            except OSError:
                pass
        return key

    def apply(self, model, preset=CUSTOM_SENTINEL, stack_json="[]", seed=0, clip=None,
              unique_id=None):
        return apply_stack(model, clip, preset, stack_json, seed, unique_id)


def apply_stack(model, clip=None, preset=CUSTOM_SENTINEL, stack_json="[]", seed=0,
                unique_id=None, tag="LoRA Stack"):
    """Load and apply a stack. Shared by the node and the Workspace's LoRAs tab."""
    if True:
        if preset != CUSTOM_SENTINEL:
            saved = load_presets().get(preset)
            if saved is None:
                print(f"[RedNode {tag}] WARNING: preset {preset!r} not found (deleted?) - "
                      "using the slots on the node")
                slots = parse_slots(stack_json)
            else:
                slots = parse_slots(json.dumps(saved))
                n_lora = sum(1 for x in slots if x.get("type") != "title")
                print(f"[RedNode {tag}] preset '{preset}' ({n_lora} LoRA slot(s))")
        else:
            slots = parse_slots(stack_json)

        _slots_raw, ui = parse_stack(stack_json)
        strengths = resolve_strengths(slots, seed, float(ui.get("rand_step") or 0.0))
        cache, applied, missing = {}, [], []
        for s, st in zip(slots, strengths):
            if s.get("type") == "title":
                continue
            if not s["enabled"] or s["name"] == NO_LORA or abs(st) <= _EPS:
                continue
            path = folder_paths.get_full_path("loras", s["name"])
            if path is None:
                missing.append(s["name"])
                continue
            lora = cache.get(path)
            if lora is None:
                lora = comfy.utils.load_torch_file(path, safe_load=True)
                cache[path] = lora
            cs = st if s["clip_strength"] is None else s["clip_strength"]
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, st,
                                                        cs if clip is not None else 0.0)
            applied.append(f"{s['name']} @ {st:g}" + ("" if s["clip_strength"] is None else f"/{cs:g}"))

        if missing:
            print(f"[RedNode {tag}] WARNING: {len(missing)} LoRA file(s) not found, skipped: "
                  f"{', '.join(missing)}. Fix the names in the stack or re-save the preset.")
        print(f"[RedNode {tag}] applied {len(applied)}: {'; '.join(applied) if applied else 'none'}")
        _report_rolls(unique_id, slots, strengths)
        return (model, clip, trigger_words(slots, strengths), "; ".join(applied))


class RedNodeLoraStackSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stack_json": ("STRING", {"default": "[]", "multiline": True, "forceInput": True,
                               "tooltip": "wire the stack node's stack_json here (convert it to an input) to save exactly what that node holds"}),
                "name": ("STRING", {"default": "my stack",
                         "tooltip": "preset name; saving an existing name overwrites it"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("Save a LoRA stack under a name (strengths, toggles, random ranges and "
                   "keywords). Keep this node MUTED except when you actually want to save.")

    def save(self, stack_json, name):
        name = str(name).strip()
        if not name:
            raise ValueError("RedNode LoRA Stack Save: give the preset a name")
        if name == CUSTOM_SENTINEL:
            raise ValueError(f"RedNode LoRA Stack Save: {CUSTOM_SENTINEL!r} is reserved")
        slots = parse_slots(stack_json)
        path = save_preset(name, slots)
        print(f"[RedNode LoRA Stack] saved preset '{name}' ({len(slots)} slot(s)) -> {path}")
        return {"ui": {"text": [f"saved '{name}' ({len(slots)} slots)"]}}


# ---------------------------------------------------------------------------
# HTTP API so the panel can save/delete presets itself — the stack_json widget is
# hidden by the UI, so wiring it to the Save node by hand is not an option.
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/lora_presets")
    async def _rednode_lora_presets(request):
        name = request.query.get("name")
        if name:                                    # one preset's slots, for the panel to load
            presets = load_presets()
            if name not in presets:
                return web.json_response({"error": "no such preset"}, status=404)
            return web.json_response({"name": name, "slots": presets[name]})
        return web.json_response({"presets": sorted(load_presets())})

    @PromptServer.instance.routes.post("/rednode/lora_presets")
    async def _rednode_lora_presets_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        action = data.get("action")
        name = str(data.get("name", "")).strip()
        if not name:
            return web.json_response({"error": "give the preset a name"}, status=400)
        if name == CUSTOM_SENTINEL:
            return web.json_response({"error": f"{CUSTOM_SENTINEL!r} is reserved"}, status=400)
        try:
            if action == "save":
                save_preset(name, parse_slots(json.dumps(data.get("slots") or [])))
            elif action == "delete":
                presets = load_presets()
                presets.pop(name, None)
                with open(_presets_path(make=True), "w", encoding="utf-8") as f:
                    json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"presets": sorted(load_presets())})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] LoRA preset HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {
    "RedNodeLoraStack": RedNodeLoraStack,
    "RedNodeLoraStackSave": RedNodeLoraStackSave,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RedNodeLoraStack": "RedNode LoRA Stack",
    "RedNodeLoraStackSave": "RedNode LoRA Stack Save",
}
