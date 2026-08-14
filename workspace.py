"""RedNode Studio Workspace — the whole scattered input rig in one tabbed node.

What it replaces: the pile of LoadImage nodes, resize chains, mask inputs, source chain
links and floating slider bars that feed RedNode Studio. One node, one panel with tabs
(Subject / People / Scene / Moodboard / Masks / Dials), remembered image galleries per
tab, and every output the studio wants — both as one bundle and as flat sockets for the
Get/Set wiring style.

Storage: filenames only, exactly like LoadImage. The galleries hold names of files in
the ComfyUI input directory; uploads go through the normal /upload API, so workflows
stay small and the files survive restarts. Missing files show up as a readable error
naming the file, not a silent skip of the image you selected.

Resize: every image is scaled so its LONG EDGE hits the target (1024 or 1536, or off),
aspect preserved, dims rounded to /8 so downstream latents never complain. Small images
scale up, huge ones scale down — nothing is cropped.

Masks: painted in ComfyUI's own mask editor over the tab's selected image (the panel
opens it). The editor writes a clipspace file whose alpha carries the mask; this node
reads `1 - alpha`, the LoadImage convention. The `boost_mask_in` / `edit_mask_in`
sockets accept a wired MASK instead and always win over the painted one.

The `config` widget is plain JSON and the single source of truth; the panel above edits
it, and it is hand-editable if the UI is ever unavailable.
"""

import hashlib
import random as _random
import json
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
import comfy.samplers

from .rednode import SETTINGS_TYPE
from . import autoprompt
from . import postprocess
from . import lora_stack as _lora
from .prompt_tools import SWAP_MODES, STYLE_MODES, ACT_MODES, convert_text

WORKSPACE_TYPE = "KREA2_WORKSPACE"
CUSTOM_SENTINEL = "custom (live)"

# the Latent tab's preset canvas sizes; the JS list mirrors this order
LATENT_PRESETS = [(1024, 1024), (832, 1216), (1216, 832), (896, 1152), (1152, 896),
                  (768, 1344), (1344, 768)]

# tabs whose caption can run through the built-in Prompt Converter. The converter
# is plain text work (gender, medium, the NSFW swaps, custom rules, the authority
# lock), so anything that produces a prompt can use one.
CONVERTER_TABS = ("i2i", "subject", "scene")

# ---------------------------------------------------------------------------
# VRAM tiers. Half these dials cost memory in ways nothing on screen explains: the
# fidelity pair builds an L x L attention bias that grows with resolution SQUARED,
# the likeness caps feed more vision tokens, and resize multiplies both. A user who
# drags three of them up has no way to know which one cost the 4 GB.
#
# So: pick a tier and the numbers are held to what that tier can take. "high" is
# free range and stays the default, because capping someone who never asked would
# be its own surprise.
VRAM_TIERS = ("low", "medium", "high")

# The shape a painted region is grown toward. Defined HERE rather than beside the
# geometry in paint_render, because paint_render imports this module and the reverse
# would be a cycle. paint_render re-exports it, so there is still one list.
REGION_SHAPES = ("auto", "square", "landscape", "portrait")

# How many times one Generate may run the same low denoise over its own result. Ten
# because past that a chain has stopped settling a shape and started eating it, and
# because a mistyped 40 is twenty minutes of sampling nobody asked for. Same reason
# REGION_SHAPES lives here: paint_render imports this module, not the other way.
PAINT_PASS_MAX = 10

VRAM_CAPS = {
    "low": {
        "resize": 1024,
        "reference_fidelity": 2.5, "scene_fidelity": 1.5,
        "likeness_vs_obedience": 768, "subject_likeness_px": 1024,
        "style_detail_px": 384, "latent_scale": 1.25, "latent_batch": 2,
        "moodboard_refs": 3,
    },
    "medium": {
        "resize": 1536,
        "reference_fidelity": 6.0, "scene_fidelity": 4.0,
        "likeness_vs_obedience": 1536, "subject_likeness_px": 2048,
        "style_detail_px": 768, "latent_scale": 1.6, "latent_batch": 4,
        "moodboard_refs": 6,
    },
    "high": {},
}


def rerun_reasons(cfg):
    """Why this node cannot be cached between queues, in the user's own terms.

    A node that re-runs every time re-captions every time, and from the console
    that just looks like the caption cache failing. These are the switches that
    cause it, so the answer is on screen instead of being guesswork.
    """
    why = []
    for name in ("subject", "subject2", "subject3", "scene", "moodboard", "i2i"):
        t = cfg["tabs"].get(name) or {}
        if t.get("random") and t.get("on") and len(t.get("images") or []) > 1:
            why.append(f"the {name} tab's dice is on, so it picks a different image "
                       "each queue")
        a = t.get("auto") or {}
        if a.get("on") and t.get("on") and not a.get("fixed", True):
            why.append(f"the {name} tab's auto prompt is set to FRESH")
    if cfg["latent"]["on"] and cfg["latent"]["random"]:
        why.append("the Latent tab's dice is on")
    return why


def vram_report(cfg, tabs, post_cfg):
    """Name what is actually spending VRAM this run, loudest first.

    Nothing on screen tells you that fidelity 4.0 at resize 1536 costs several
    times what fidelity 4.0 at 1024 does, so the console says it out loud instead
    of leaving people to guess which knob emptied their card.
    """
    d = cfg["dials"]
    px = cfg["resize"] or 1024
    heavy = []
    if d.get("reference_fidelity", 1.0) != 1.0 or d.get("scene_fidelity", 1.0) != 1.0:
        # the bias matrix is L x L and L grows with resolution SQUARED
        scale = (px / 1024.0) ** 2
        heavy.append(f"fidelity dials build an attention bias matrix "
                     f"(~{scale:.1f}x the 1024 cost at resize {px})")
    if d.get("isolate_refs"):
        heavy.append("isolate refs adds a second bias matrix")
    grounding = max(int(d.get("likeness_vs_obedience", 0) or 0),
                    int(d.get("subject_likeness_px", 0) or 0))
    if grounding > 1024:
        heavy.append(f"likeness {grounding}px feeds extra vision tokens")
    if int(d.get("style_detail_px", 0) or 0) > 512:
        heavy.append(f"style detail {int(d['style_detail_px'])}px enlarges every ref")
    mb = tabs.get("moodboard", {})
    if mb.get("on") and isinstance(mb.get("sel"), list) and len(mb["sel"]) > 2:
        heavy.append(f"{len(mb['sel'])} moodboard refs are encoded together")
    engines = []
    for name in ("subject", "scene", "moodboard", "i2i"):
        a = tabs.get(name, {}).get("auto") or {}
        if not (a.get("on") and tabs[name].get("on")):
            continue
        for eng, key in (("Ollama", "ollama"), ("WD14", "wd14"), ("JoyCaption", "joy"),
                         ("QwenVL", "qwen")):
            if a.get(key) and eng not in engines:
                engines.append(eng)
    if engines:
        heavy.append(f"{', '.join(engines)} each load a model to caption")
    post_on = [n for n in postprocess.ORDER if post_cfg[n]["on"]]
    if any(n in postprocess.DEPTH_EFFECTS for n in post_on):
        heavy.append("depth of field / haze load a depth estimator")
    if d.get("boosts_off"):
        # the master off switch forces both fidelity dials to 1.0 downstream, so the
        # matrix warnings above are describing something that will not happen
        heavy = [x for x in heavy if "bias matrix" not in x]
        heavy.insert(0, "boosts off: no attention bias matrix is built")
    tier = cfg.get("vram_tier", "high")
    if heavy:
        print(f"[RedNode Workspace] VRAM ({tier} tier): " + "; ".join(heavy), flush=True)
    else:
        print(f"[RedNode Workspace] VRAM ({tier} tier): nothing expensive is on",
              flush=True)


def cap_for(tier, key):
    return VRAM_CAPS.get(tier, {}).get(key)


def _cap(tier, key, value, what, notes):
    """Hold `value` to the tier's ceiling, recording anything that was pulled down."""
    ceiling = cap_for(tier, key)
    if ceiling is None or value is None or value <= ceiling:
        return value
    notes.append(f"{what} {value:g} -> {ceiling:g}")
    return ceiling


# the managed folder inside ComfyUI/input: panel uploads land here (per-tab subfolders),
# and images in here get caption sidecars written next to them
MANAGED_SUBFOLDER = "rednode"


def _managed(entry):
    return str(entry).replace("\\", "/").startswith(MANAGED_SUBFOLDER + "/")

# every key the Settings dict carries, at the Settings node's own defaults — the studio
# indexes some of these unconditionally, so the workspace must always send a full dict
SETTINGS_DEFAULTS = dict(
    transfer="style", reference_processing="full image", style_directive=True,
    hide_style_refs=True, style_detail_px=384, likeness_vs_obedience=768,
    reference_fidelity=2.5, scene_fidelity=1.0, fit_mode="fit",
    identity_start=0.0, identity_end=1.0, isolate_refs=False, boost_blocks="all",
    subject_likeness_px=0, edit_mask_feather=2, picture_labels=False,
    ref_t0_modulation=False, vision_system_prompt="", attention="auto",
)

# the dials the panel surfaces (name -> clamp range); everything else stays at default.
# style_strength is NOT a settings key: it is the studio's own widget, so it rides the
# bundle at the top level instead of inside the settings dict.
DIALS = {
    "style_strength": (0.0, 1.0),
    "reference_fidelity": (0.0, 10.0),
    "scene_fidelity": (0.0, 10.0),
    "likeness_vs_obedience": (0, 2048),
    "subject_likeness_px": (0, 4096),
    "style_detail_px": (128, 1536),
    "edit_mask_feather": (0, 32),
    "identity_start": (0.0, 1.0),
    "identity_end": (0.0, 1.0),
}

# boolean dials, surfaced as ON/OFF switches in the dial sections
BOOL_DIALS = ("hide_style_refs", "style_directive", "isolate_refs",
              "picture_labels", "ref_t0_modulation", "boosts_off",
              "caption_passthrough", "echo_prompts")

# choice dials: value must be one of the listed options or it is dropped
CHOICE_DIALS = {
    "transfer": ["style", "subject"],
    "reference_processing": ["full image", "quadrant crops (2x2)", "fine tiles (4x4)"],
    "fit_mode": ["fit", "crop (legacy)"],
    "boost_blocks": ["all", "early", "mid", "late"],
    "attention": ["auto", "default", "pytorch"],
}

# free-text dials (the vision system prompt); passed through as-is
TEXT_DIALS = ("vision_system_prompt",)

# vision system prompts shipped with the pack. They change how the encoder READS the
# references; the names are what the Advanced tab's picker shows. User-saved prompts
# live beside them and may not reuse these names.
VISION_PROMPTS = {
    "Style extract": (
        "Describe the artistic style, color palette, lighting, texture and rendering "
        "technique of the reference images in detail. Ignore their subjects, people and "
        "composition entirely."),
    "Identity lock": (
        "Describe the person's face, hair, eyes and distinguishing features in precise "
        "detail. Treat clothing and background as unimportant."),
    "Anime to real": (
        "Describe the person's identity, face, hair and clothing as a real human being. "
        "Ignore the illustration style completely."),
    "Real to anime": (
        "Describe the person and scene as stylized anime artwork. Focus on shapes, hair "
        "color and outfit rather than photographic detail."),
    "Garment focus": (
        "Describe the clothing and accessories in the reference images in full "
        "construction detail: fabric, pattern, cut, seams and fit. The person wearing "
        "them is unimportant."),
}


# CAPTION INSTRUCTIONS: what Ollama is TOLD to write about an image. Distinct from
# VISION_PROMPTS above, which change how the Krea 2 encoder READS the references.
# These stand in for autoprompt.SYSTEM_PROMPTS, which was reachable only by editing
# the source. Ollama alone reads these: the local captioners answer worse when handed
# wording they were not trained on, so they keep the mode's own.
# Each entry is BOTH halves of the Ollama call: the system prompt and the question.
# Plenty of vision models take their orders from the question and skim the system
# prompt, so a preset that set only one half would work on some models and not others.
CAPTION_INSTRUCTIONS = {
    "Booru tags only": {
        "system": (
            "Describe the image as a flat comma-separated list of booru-style tags only. "
            "No sentences, no preamble, no explanation."),
        "question": "List the tags for this image."},
    "One short sentence": {
        "system": (
            "Describe the image in a single short sentence of no more than twenty words. "
            "Answer with the sentence only, no preamble."),
        "question": "Describe this image in one short sentence."},
    "Camera and lighting": {
        "system": (
            "Describe only the camera work and lighting: shot type, angle, lens character, "
            "depth of field, light direction, quality and colour temperature. Do not "
            "describe the subject's identity or the story. Answer with the description "
            "only, no preamble."),
        "question": "Describe the camera work and the lighting."},
    "Clothing only": {
        "system": (
            "Describe only the clothing and accessories in full construction detail: "
            "garment type, fabric, pattern, cut, fit and how it sits on the body. Do not "
            "describe the face, the background or the lighting. Answer with the "
            "description only, no preamble."),
        "question": "Describe the clothing and accessories."},
    "No people": {
        "system": (
            "Describe the setting, objects, lighting and composition. Refer to any people "
            "only as 'a person' or 'people' with no description of their appearance. "
            "Answer with the description only, no preamble."),
        "question": "Describe the setting and the composition."},
}


def _instruction_pair(value):
    """One preset as {system, question}. Tolerates the plain string the first build of
    this feature saved, so nobody's saved wordings are lost to the format change."""
    if isinstance(value, str):
        return {"system": value, "question": ""}
    if isinstance(value, dict):
        return {"system": str(value.get("system") or ""),
                "question": str(value.get("question") or "")}
    return {"system": "", "question": ""}


def _instructions_path(make=False):
    override = os.environ.get("KREA2RN_CAPTION_INSTRUCTIONS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "caption_instructions.json")


def load_caption_instructions():
    """Shipped instructions plus the user's saved ones; shipped names always win.
    Every entry comes back as {system, question} whatever shape it was stored in."""
    out = {}
    try:
        with open(_instructions_path(), encoding="utf-8") as f:
            data = json.load(f)
        for name, value in (data.get("prompts") or {}).items():
            pair = _instruction_pair(value)
            if pair["system"].strip() or pair["question"].strip():
                out[str(name)] = pair
    except (OSError, ValueError):
        pass
    out.update({k: _instruction_pair(v) for k, v in CAPTION_INSTRUCTIONS.items()})
    return out


def save_caption_instruction(name, text, question=""):
    name = str(name).strip()
    if not name:
        raise ValueError("give the instruction a name")
    if name in CAPTION_INSTRUCTIONS:
        raise ValueError(f"{name!r} ships with the pack and cannot be overwritten")
    system = str(text or "")
    question = str(question or "")
    # either half alone is a usable preset: some models need only the question changed
    if not system.strip() and not question.strip():
        raise ValueError("type an instruction or a question first")
    user = {}
    try:
        with open(_instructions_path(), encoding="utf-8") as f:
            user = json.load(f).get("prompts") or {}
    except (OSError, ValueError):
        pass
    user[name] = {"system": system, "question": question}
    with open(_instructions_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 2, "prompts": user}, f, indent=2, ensure_ascii=False)
    return name


def delete_caption_instruction(name):
    name = str(name).strip()
    if name in CAPTION_INSTRUCTIONS:
        raise ValueError(f"{name!r} ships with the pack and cannot be deleted")
    user = {}
    try:
        with open(_instructions_path(), encoding="utf-8") as f:
            user = json.load(f).get("prompts") or {}
    except (OSError, ValueError):
        pass
    user.pop(name, None)
    with open(_instructions_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "prompts": user}, f, indent=2, ensure_ascii=False)


def _vision_path(make=False):
    override = os.environ.get("KREA2RN_VISION_PROMPTS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "vision_prompts.json")


def load_vision_prompts():
    """Shipped prompts plus the user's saved ones; shipped names always win."""
    out = {}
    try:
        with open(_vision_path(), encoding="utf-8") as f:
            data = json.load(f)
        for name, text in (data.get("prompts") or {}).items():
            if isinstance(text, str) and text.strip():
                out[str(name)] = text
    except (OSError, ValueError):
        pass
    out.update(VISION_PROMPTS)
    return out


def save_vision_prompt(name, text):
    name = str(name).strip()
    if not name:
        raise ValueError("give the prompt a name")
    if name in VISION_PROMPTS:
        raise ValueError(f"{name!r} ships with the pack and cannot be overwritten")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("the prompt text is empty")
    user = {}
    try:
        with open(_vision_path(), encoding="utf-8") as f:
            user = json.load(f).get("prompts") or {}
    except (OSError, ValueError):
        pass
    user[name] = text
    with open(_vision_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "prompts": user}, f, indent=2, ensure_ascii=False)
    return name


def delete_vision_prompt(name):
    name = str(name).strip()
    if name in VISION_PROMPTS:
        raise ValueError(f"{name!r} ships with the pack and cannot be deleted")
    user = {}
    try:
        with open(_vision_path(), encoding="utf-8") as f:
            user = json.load(f).get("prompts") or {}
    except (OSError, ValueError):
        pass
    user.pop(name, None)
    with open(_vision_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "prompts": user}, f, indent=2, ensure_ascii=False)

IMAGE_TABS = ("i2i", "subject", "subject2", "subject3", "scene", "moodboard")


def _presets_path(make=False):
    override = os.environ.get("KREA2RN_WORKSPACE_PRESETS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "workspace_presets.json")


def load_presets():
    """{preset name: full workspace config dict}. Galleries are filenames, so presets are
    per-machine — which is what a working set of reference images is anyway."""
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for name, cfg in (data.get("presets") or {}).items():
            if isinstance(cfg, dict):
                out[str(name)] = cfg
        return out
    except (OSError, ValueError):
        return {}


def save_preset(name, config):
    name = str(name).strip()
    if not name:
        raise ValueError("give the preset a name")
    if name == CUSTOM_SENTINEL:
        raise ValueError(f"{CUSTOM_SENTINEL!r} is reserved")
    if not isinstance(config, dict):
        raise ValueError("a workspace preset stores the whole config object")
    presets = load_presets()
    presets[name] = config
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
    return name


def delete_preset(name):
    presets = load_presets()
    presets.pop(str(name), None)
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)


# The clamp notice, printed once per change instead of once per parse. parse_config
# runs more than once per queue (IS_CHANGED and build both call it), so an unchanged
# ceiling used to say the same thing two or three times per run.
_LAST_HELD = None


def _announce_held(tier, held):
    global _LAST_HELD
    if not held:
        _LAST_HELD = None      # a clean parse re-arms the notice
        return
    msg = (f"[RedNode Workspace] {tier} VRAM tier held back: {', '.join(held)}. "
           "Switch the tier in the footer to lift the ceiling.")
    if msg != _LAST_HELD:
        _LAST_HELD = msg
        print(msg, flush=True)


def _normalise_auto(auto_in, default_mode):
    """Return the shared per-image auto-prompt contract."""
    auto_in = auto_in if isinstance(auto_in, dict) else {}
    mode = str(auto_in.get("mode") or default_mode)
    if mode not in autoprompt.SYSTEM_PROMPTS:
        mode = default_mode
    return {
        "on": bool(auto_in.get("on")),
        "ollama": bool(auto_in.get("ollama", True)),
        "wd14": bool(auto_in.get("wd14", True)),
        "mode": mode,
        "combine": "blend" if auto_in.get("combine") == "blend" else "append",
        "joy": bool(auto_in.get("joy")),
        "qwen": bool(auto_in.get("qwen")),
        "clipgen": bool(auto_in.get("clipgen")),
        "length": max(0, min(300, int(auto_in.get("length", 0))))
                  if isinstance(auto_in.get("length"), (int, float)) else 0,
        # fixed (default): the same image reuses the cached prompt. Unfixed
        # re-runs the LLM every queue for fresh wording each run.
        "fixed": bool(auto_in.get("fixed", True)),
        # Injection: this tab's caption lands in a named Prompts-tab row, into one
        # Frame slot, automatically at queue time. Empty = the caption only rides
        # its own output socket, exactly as before.
        "inject_row": str(auto_in.get("inject_row") or ""),
        "inject_slot": (str(auto_in.get("inject_slot"))
                        if auto_in.get("inject_slot") in
                        ("subject", "surroundings", "light_and_colour", "prompt")
                        else "subject"),
    }


def parse_config(config_json):
    """Normalised config: {tabs: {name: {on, images, sel, mask}}, dials: {...}, resize, use_dials}."""
    try:
        data = json.loads(config_json or "{}")
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    tabs_in = data.get("tabs") if isinstance(data.get("tabs"), dict) else {}
    tabs = {}
    for name in IMAGE_TABS + ("boost_mask", "edit_mask"):
        t = tabs_in.get(name) if isinstance(tabs_in.get(name), dict) else {}
        images = [str(x) for x in t.get("images", []) if str(x).strip()] \
            if isinstance(t.get("images"), list) else []
        sel = t.get("sel", 0)
        if name == "moodboard":
            # the moodboard batches several refs, so its selection is a list
            sel = [int(i) for i in sel if isinstance(i, (int, float))] if isinstance(sel, list) else \
                  ([int(sel)] if isinstance(sel, (int, float)) else [])
            sel = [i for i in sel if 0 <= i < len(images)]
        else:
            try:
                sel = int(sel)
            except (TypeError, ValueError):
                sel = 0
            if not (0 <= sel < len(images)):
                sel = 0
        default_mode = {"scene": "scene_view", "moodboard": "style",
                        "i2i": "i2i"}.get(name, "subject")
        tabs[name] = {
            "on": bool(t.get("on", name in ("subject", "scene", "moodboard"))),
            "images": images,
            "sel": sel,
            "mask": str(t.get("mask") or ""),
            "random": bool(t.get("random")),
            "auto": _normalise_auto(t.get("auto"), default_mode),
        }
        if name == "i2i":
            tabs[name]["prompt_only"] = bool(t.get("prompt_only"))
            # the i2i canvas source: the gallery as always, or a wired image or
            # latent, which is how one workspace chains into the next
            tabs[name]["canvas"] = (t.get("canvas")
                                    if t.get("canvas") in ("image", "latent")
                                    else "gallery")
            try:
                dn = float(t.get("denoise", 0.7))
            except (TypeError, ValueError):
                dn = 0.7
            tabs[name]["denoise"] = max(0.0, min(1.0, dn))
            # the i2i pass gets its own scale: the global resize decides the working
            # size for every tab, and an i2i pass often wants to come out bigger or
            # smaller than that without moving it for everything else
            try:
                isc = float(t.get("scale", 1.0))
            except (TypeError, ValueError):
                isc = 1.0
            tabs[name]["scale"] = max(0.25, min(3.0, isc))
            # iteration, the Paint tab's Passes brought over: the embedded sampler
            # runs the i2i chain this many times, fresh seed each pass, and only
            # the last picture comes back
            try:
                ips = int(t.get("passes", 1))
            except (TypeError, ValueError):
                ips = 1
            tabs[name]["passes"] = max(1, min(PAINT_PASS_MAX, ips))
        if name in CONVERTER_TABS:
            conv_in = t.get("conv") if isinstance(t.get("conv"), dict) else {}
            tabs[name]["conv"] = {
                "gender": conv_in.get("gender") if conv_in.get("gender") in SWAP_MODES else "off",
                "style": conv_in.get("style") if conv_in.get("style") in STYLE_MODES else "off",
                "act": conv_in.get("act") if conv_in.get("act") in ACT_MODES else "off",
                "remove_cum": bool(conv_in.get("remove_cum")),
                "shave": bool(conv_in.get("shave")),
                "rules": str(conv_in.get("rules") or ""),
                # ON by default only for i2i, where the source image is the thing
                # that smuggles a style past the mood. Adding a converter to the
                # subject and scene tabs must not silently change what they output.
                "lock": bool(conv_in.get("lock", name == "i2i")),
                "lock_lighting": bool(conv_in.get("lock_lighting")),
            }
    dials_in = data.get("dials") if isinstance(data.get("dials"), dict) else {}
    dials = {}
    for key, (lo, hi) in DIALS.items():
        try:
            v = float(dials_in[key])
        except (KeyError, TypeError, ValueError):
            continue
        dials[key] = max(lo, min(hi, v))
    for key in BOOL_DIALS:
        if key in dials_in:
            dials[key] = bool(dials_in[key])
    for key, options in CHOICE_DIALS.items():
        if str(dials_in.get(key)) in options:
            dials[key] = str(dials_in[key])
    for key in TEXT_DIALS:
        if isinstance(dials_in.get(key), str) and dials_in[key].strip():
            dials[key] = dials_in[key]
    lat_in = data.get("latent") if isinstance(data.get("latent"), dict) else {}

    def _lat_dim(key, default):
        try:
            v = int(lat_in.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(256, min(4096, (v // 8) * 8))

    latent_cfg = {
        "on": bool(lat_in.get("on")),
        "w": _lat_dim("w", 1024),
        "h": _lat_dim("h", 1024),
        "batch": max(1, min(64, int(lat_in.get("batch", 1))
                            if isinstance(lat_in.get("batch"), (int, float)) else 1)),
        "random": bool(lat_in.get("random")),
        # "tab" builds the canvas here; "input" hands the job to a LATENT wired into
        # the node, because plenty of workflows already make their latent elsewhere
        # and there is no reason to force ours on them
        "source": "input" if lat_in.get("source") == "input" else "tab",
    }
    try:
        latent_cfg["scale"] = max(1.0, min(2.0, float(lat_in.get("scale", 1.0))))
    except (TypeError, ValueError):
        latent_cfg["scale"] = 1.0
    # the LoRAs tab: the stack the panel edits, in the same shape the LoRA Stack
    # node's hidden widget uses, so one panel implementation serves both
    lin = data.get("loras") if isinstance(data.get("loras"), dict) else {}
    try:
        lseed = int(lin.get("seed", 0))
    except (TypeError, ValueError):
        lseed = 0
    loras_cfg = {
        "on": bool(lin.get("on", True)),
        "slots": lin.get("slots") if isinstance(lin.get("slots"), list) else [],
        "ui": lin.get("ui") if isinstance(lin.get("ui"), dict) else {},
        "seed": max(0, lseed),
    }
    # The paint pass's OWN stack, ONE and flat, separate from the tab above and never
    # chained after it: a paint pass is usually a low-denoise detail pass, which wants
    # a detail LoRA and none of the style LoRAs that fight a subject reference. Same
    # shape as loras_cfg so the same panel edits both; the Stack preset row is how
    # sets get swapped. No "on" flag: paint.lora_mode below is the switch. A config
    # saved during the one local day this was keyed per model choice (a "stacks"
    # object) collapses to the active choice's stack, or the first non-empty one.
    pln = data.get("paint_loras") if isinstance(data.get("paint_loras"), dict) else {}
    stacks_in = pln.get("stacks") if isinstance(pln.get("stacks"), dict) else None
    if stacks_in is not None:
        _pin0 = data.get("paint") if isinstance(data.get("paint"), dict) else {}
        key = str(_pin0.get("renderer_name") or _pin0.get("renderer_kind")
                  or _pin0.get("renderer") or "")
        pick = stacks_in.get(key)
        if not (isinstance(pick, dict) and pick.get("slots")):
            pick = next((v for v in stacks_in.values()
                         if isinstance(v, dict) and isinstance(v.get("slots"), list)
                         and v.get("slots")), {})
        pln = pick if isinstance(pick, dict) else {}
    try:
        plseed = int(pln.get("seed", 0))
    except (TypeError, ValueError):
        plseed = 0
    paint_loras_cfg = {
        "slots": pln.get("slots") if isinstance(pln.get("slots"), list) else [],
        "ui": pln.get("ui") if isinstance(pln.get("ui"), dict) else {},
        "seed": max(0, plseed),
    }
    # The Models tab: named rigs loaded INSIDE the workspace, so a custom workflow is
    # two nodes dropped in the middle instead of a transfer harness of loaders and
    # channel hops. Each rig is a checkpoint OR a diffusion model + CLIP + VAE, all by
    # filename; the active one loads at build time (cached, so it re-reads nothing
    # until a name changes) and fills whatever input is not wired. A wired input
    # always wins, which is how the rest of the panel already behaves.
    min_ = data.get("models") if isinstance(data.get("models"), dict) else {}
    rigs = []
    for r in (min_.get("rigs") if isinstance(min_.get("rigs"), list) else []):
        if not isinstance(r, dict):
            continue
        def _num(key, lo, hi, dv, cast=int):
            try:
                v = cast(r.get(key, dv))
            except (TypeError, ValueError):
                v = dv
            return max(lo, min(hi, v))
        rigs.append({
            "name": str(r.get("name") or ""),
            "checkpoint": str(r.get("checkpoint") or ""),
            "unet": str(r.get("unet") or ""),
            "clip": str(r.get("clip") or ""),
            "clip_type": str(r.get("clip_type") or ""),
            "vae": str(r.get("vae") or ""),
            # the rig's OWN sampler settings, the same five keys a Sampler Config
            # profile carries, so "load the workspace and it works" includes the
            # numbers a KSampler needs. Defaults are the turbo reality this pack
            # lives in; a full model's rig just types its own.
            "steps": _num("steps", 1, 200, 8),
            "cfg": _num("cfg", 0.0, 30.0, 1.0, float),
            "sampler": str(r.get("sampler") or "euler"),
            "scheduler": str(r.get("scheduler") or "simple"),
            "detailer_steps": _num("detailer_steps", 0, 200, 8),
            # an EXTERNAL rig loads no files: it is the cockpit for a renderer
            # outside the workspace (the NovelAI chain). Its numbers and prompt
            # ride the typed output sockets; sampler and scheduler are free
            # text because an external engine names its own. The denoise field
            # is its i2i strength, carried on the denoise socket when active.
            "kind": (str(r.get("kind"))
                     if r.get("kind") == "external"
                     or r.get("kind") in RIG_KIND_HANDLERS else "files"),
            "denoise": _num("denoise", 0.0, 1.0, 1.0, float),
            # a handled kind (the personal NovelAI rig) carries its own extra
            # settings; the raw dict rides along so the handler reads them
            # without this parse needing to know their names
            "raw": (dict(r) if r.get("kind") in RIG_KIND_HANDLERS else None),
            # IDENTITY RESCUE, per rig: restore the layers the named LoRA
            # touches back toward the named base checkpoint before the stack
            # lands, which is what makes an identity LoRA fire on a merged
            # model. Off unless every piece is named, per the house rule.
            "rescue": bool(r.get("rescue")),
            "rescue_base": str(r.get("rescue_base") or ""),
            "rescue_lora": str(r.get("rescue_lora") or ""),
            "rescue_strength": _num("rescue_strength", 0.0, 1.0, 1.0, float),
        })
    try:
        active = int(min_.get("active", 0))
    except (TypeError, ValueError):
        active = 0
    try:
        mseed = int(min_.get("seed", 0))
    except (TypeError, ValueError):
        mseed = 0
    models_cfg = {"rigs": rigs,
                  "active": max(0, min(active, len(rigs) - 1)) if rigs else 0,
                  # the embedded sampler: comfy core's own KSampler run inside the
                  # build, so the graph is the workspace and an image. External is
                  # the default and exactly what every workflow did before.
                  "sampler_mode": ("internal" if min_.get("sampler_mode") == "internal"
                                   else "external"),
                  # hold TWO rigs in RAM instead of one: the two-rig Detailer
                  # flow stops reloading both models every queue. Explicitly
                  # off by default; it costs a second model's system RAM.
                  "hold_two": bool(min_.get("hold_two")),
                  "seed": max(0, mseed),
                  "seed_random": (True if min_.get("seed_random") is None
                                  else bool(min_.get("seed_random")))}
    # The Prompts tab: named prompts, each linked to a rig by the rig's NAME, each
    # marked with which editor draws it (the Krea 2 styled box, or a plain one for
    # every other model). Authoring and storage; encoding stays downstream.
    prin = data.get("prompts") if isinstance(data.get("prompts"), dict) else {}
    prompt_rows = []
    for p in (prin.get("rows") if isinstance(prin.get("rows"), list) else []):
        if not isinstance(p, dict):
            continue
        fr = p.get("frame") if isinstance(p.get("frame"), dict) else {}
        prompt_rows.append({
            "name": str(p.get("name") or ""),
            "rig": str(p.get("rig") or ""),
            "kind": "plain" if p.get("kind") == "plain" else "krea2",
            "text": str(p.get("text") or ""),
            "negative": str(p.get("negative") or ""),
            # the Frame editor's fields, kept as the panel wrote them. row["text"]
            # holds the ASSEMBLED prompt (the tab streams it in from the preview
            # route), so nothing downstream needs to re-run the assembly.
            "frame": {str(k): v for k, v in fr.items()
                      if isinstance(v, (str, int, float, bool))},
            # the caption layer: sectioned by the split instruction, kept apart from
            # the typed text so clearing it never eats the user's words
            "auto": {str(k): str(v) for k, v in
                     (p.get("auto") if isinstance(p.get("auto"), dict) else {}).items()
                     if isinstance(v, str)},
        })
    prompts_cfg = {"rows": prompt_rows}
    # the Paint tab: an inpaint loop that stays inside the node. The painted mask
    # and the source ride the SAME sockets the edit mask and Img2Img already use
    # (edit_mask, output_latent, denoise), so the sampler chain needs no changes.
    pin = data.get("paint") if isinstance(data.get("paint"), dict) else {}
    try:
        pdn = float(pin.get("denoise", 0.6))
    except (TypeError, ValueError):
        pdn = 0.6
    try:
        brush = int(pin.get("brush", 48))
    except (TypeError, ValueError):
        brush = 48
    paint_cfg = {
        "on": bool(pin.get("on")),
        "source": str(pin.get("source") or ""),
        "mask": str(pin.get("mask") or ""),
        # The colour sheet: an RGBA file of everything painted in colour mode,
        # composited over the source before any paint pass renders. Its own key
        # because colour is PIXELS and the mask is COVERAGE; the two never mix.
        "colour": str(pin.get("colour") or ""),
        # The segmenter's mask, which the tab draws UNDER the brush strokes. Its own key
        # on purpose: "mask" above is overwritten with the exported base-plus-strokes
        # composite every time a paint pass runs, so keeping the auto mask there would
        # bake the strokes into the base. Undo would then peel a stroke off a picture
        # that already contains it and nothing on screen would change.
        "auto_mask": (str(pin.get("auto_mask"))
                      if isinstance(pin.get("auto_mask"), str) else ""),
        # For the upscale round trip: send a picture out, bring the upscaled version
        # back, and the mask that still describes it is worth keeping instead of being
        # cleared along with the old source. Off by default because a mask carried onto
        # an unrelated picture masks the wrong thing. A different SIZE is already handled
        # (load_mask resizes to the picture it is given); the caveat is ASPECT RATIO,
        # since that resize stretches rather than fits, so a mask kept across a reframe
        # comes back skewed.
        "keep_mask": bool(pin.get("keep_mask")),
        "denoise": max(0.0, min(1.0, pdn)),
        # mask only composites the untouched area back at every step, so only what
        # you painted can change. Off repaints the whole frame from the source.
        "mask_only": bool(pin.get("mask_only", True)),
        "brush": max(2, min(400, brush)),
        # A pixel BUDGET now, as the side of a square, not a long edge. Scaling a
        # region by its longest side rationed the detail by shape: a compact mask got a
        # 3x upscale while a long one got none at all, which is why long masks came
        # back soft. The number means the same thing it always did for a square region.
        # 512 at the bottom because nothing useful happens below it, 4096 at the top
        # because that is where a 4K pass lands. The VRAM tier is the real ceiling and
        # clamps this further at render time; this is only the range the dial may hold.
        "mask_size": max(512, min(4096, int(pin.get("mask_size", 1024))
                                 if isinstance(pin.get("mask_size"), (int, float))
                                 else 1024)),
        # The shape the painted box is grown toward, so the region lands on an aspect
        # the model was trained on and carries context above and below a long mask.
        # Auto picks the nearest of the buckets; the box only ever grows.
        "region_shape": (str(pin.get("region_shape"))
                         if str(pin.get("region_shape") or "") in REGION_SHAPES
                         else "auto"),
        # OFF by default: the size dial is a target in both directions, so a region
        # bigger than the budget comes DOWN to it. On means keep the old refusal, for
        # work where preserving every pixel of an already-large region beats the cost.
        # It changes what renders, so it belongs here in the workflow rather than in
        # the install's display settings.
        "region_floor": bool(pin.get("region_floor")),
        "feather": max(0, min(64, int(pin.get("feather", 4))
                              if isinstance(pin.get("feather"), (int, float)) else 4)),
        # What the painted region should become. Empty means "use whatever conditioning
        # is wired into the render node", which is the whole-image prompt and rarely
        # what you want for a patch.
        "prompt": str(pin.get("prompt") or ""),
        # The automatic caption is a separate layer, not text pasted into the box.
        # Keeping it separate lets OFF remove it without eating the user's words, and
        # lets an empty box combine it with the wired main prompt instead of replacing
        # conditioning whose original text is not available here.
        "auto_prompt": str(pin.get("auto_prompt") or ""),
        "negative": str(pin.get("negative") or ""),
        # The seed this paint run uses, handed out by Paint Out so it can drive whatever
        # sampler is in the chain. The tab rolls it before each Generate when random is
        # on, so the number shown is always the number that was used: a seed you cannot
        # read afterwards is no use for repeating the one good result out of ten.
        "seed": max(0, min(2**53, int(pin.get("seed", 0))
                           if isinstance(pin.get("seed"), (int, float)) else 0)),
        "seed_random": bool(pin.get("seed_random", True)),
        # @keywords toggled on for the paint prompt: NAMES only, the text lives in the
        # global prompt library and is expanded by Paint Out and Paint Render at run
        # time, so editing a keyword updates every mask that uses it
        "keywords": [str(k)[:64] for k in pin.get("keywords") or []
                     if isinstance(k, str) and k.strip()][:32],
        # Reference images for the painted patch. Off by default because the fast
        # path is the point of painting: a plain text encode is near instant, and
        # encoding references costs real time. On, the patch is built by the studio
        # node with these refs, so a repaint can carry the same face or the same
        # outfit as the picture it sits in.
        "use_subject": bool(pin.get("use_subject")),
        "use_scene": bool(pin.get("use_scene")),
        "use_moodboard": bool(pin.get("use_moodboard")),
        # A 4K whole-frame paint is minutes of sampling and an out-of-memory risk, so
        # by default it is held to the VRAM tier's ceiling and scaled back afterwards.
        # Off means render it at full size and accept the cost.
        "fit_whole": bool(pin.get("fit_whole", True)),
        # paint what STAYS instead of what changes
        "invert": bool(pin.get("invert")),
        # purely a UI state: whether the set-and-forget dials are folded open. It lives
        # in the config so the tab looks the same when the workflow is reopened.
        "adv_open": bool(pin.get("adv_open")),
        # Apply the LoRAs tab to whatever model reaches the render node. OFF by
        # default, and it must stay that way: with the LoRA-applied model already
        # wired this applies the whole stack a SECOND time. It exists for the case
        # where paint runs on a different model from the main generation, which is
        # then wired raw and wants the stack put on it here.
        "use_loras": bool(pin.get("use_loras")),
        # Paint captions a generated result, but its prompt controls an image edit.
        # Reuse the exact gallery contract so both entry points stay in sync.
        "auto": _normalise_auto(pin.get("auto"), "i2i"),
    }
    # cfg and steps are the exception to the whitelist's "always produce a value" rule.
    # They arrived on the Paint tab after people already had workflows setting them on
    # the render node's own widgets, so ABSENT has to survive as absent: that is the
    # signal for the node to keep using what its user set. Inventing a default here
    # would silently re-sample every one of those workflows at 8 steps and cfg 1.0.
    if isinstance(pin.get("cfg"), (int, float)) and not isinstance(pin.get("cfg"), bool):
        paint_cfg["cfg"] = max(0.0, min(30.0, float(pin["cfg"])))
    if isinstance(pin.get("steps"), (int, float)) and not isinstance(pin.get("steps"), bool):
        paint_cfg["steps"] = max(1, min(100, int(pin["steps"])))
    # Passes: the same paint pass run over its own result, N times, inside one Generate.
    # It is the loop people already do by hand at a low denoise to settle a shape,
    # dragging the result back onto the canvas between presses. Absent, like cfg and
    # steps, so an old workflow keeps the node's own widget rather than being told it
    # now renders once.
    if isinstance(pin.get("passes"), (int, float)) and not isinstance(pin.get("passes"), bool):
        paint_cfg["passes"] = max(1, min(PAINT_PASS_MAX, int(pin["passes"])))
    # Which LoRAs the paint branch carries: the main stack's ("main", the default and
    # exactly what every workflow did before this existed) or the model choice's own
    # paint stack applied to the raw wired model ("paint"). Two options, the user's
    # call; a bare paint pass is the raw model wired in. A branch, never a chain:
    # chained, the paint pass would inherit the very style LoRAs it is escaping.
    # "none" existed for one unreleased day and folds into "main".
    plm = str(pin.get("lora_mode") or "main").lower()
    paint_cfg["lora_mode"] = plm if plm in ("main", "paint") else "main"
    # The built-in paint door's run stamp. It exists only in the QUEUED copy of the
    # config (Generate stamps it there), never in the saved workflow, so an ordinary
    # queue can never repaint by accident.
    paint_cfg["run_token"] = str(pin.get("run_token") or "")
    # THE PROMPTS TAB FEEDS THE PAINT, when the paint box is silent. Text typed in the
    # Paint tab always wins, the user's standing rule: what you write is first
    # priority. An empty box takes the row linked to the ACTIVE rig, so the Prompt Box
    # editor on the Prompts tab authors paint prompts by simply leaving the paint box
    # alone. Paint Out re-resolves against its own pinned rig; prompt_from says which
    # source won so it can tell.
    paint_cfg["prompt_from"] = "box" if paint_cfg["prompt"].strip() else ""
    if not paint_cfg["prompt"].strip():
        _row = prompt_row_for(models_cfg, prompts_cfg)
        if _row is not None:
            paint_cfg["prompt"] = _row["text"]
            paint_cfg["prompt_from"] = "prompts_tab"
            if not paint_cfg["negative"].strip():
                paint_cfg["negative"] = _row["negative"]
    tier = str(data.get("vram_tier") or "high").lower()
    tier = tier if tier in VRAM_TIERS else "high"
    studio_preset = str(data.get("studio_preset") or "").strip()
    auto_in = data.get("auto") if isinstance(data.get("auto"), dict) else {}
    def _num(key, default, lo, hi):
        v = auto_in.get(key, default)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, v))

    auto = {
        "model": str(auto_in.get("model") or ""),
        "url": str(auto_in.get("url") or autoprompt.OLLAMA_URL),
        "wd14_model": str(auto_in.get("wd14_model") or ""),
        "threshold": _num("threshold", 0.35, 0.0, 1.0),
        "character_threshold": _num("character_threshold", 0.85, 0.0, 1.0),
        "replace_underscore": bool(auto_in.get("replace_underscore")),
        "exclude_tags": str(auto_in.get("exclude_tags") or ""),
        "temperature": _num("temperature", 0.2, 0.0, 2.0),
        "seed": int(_num("seed", 0, 0, 2**31)),
        "num_ctx": int(_num("num_ctx", 0, 0, 131072)),
        "num_predict": int(_num("num_predict", 0, 0, 8192)),
        "top_k": int(_num("top_k", 0, 0, 200)),
        "top_p": _num("top_p", 0.0, 0.0, 1.0),
        "think": bool(auto_in.get("think")),
        # RAM policy: unload by default. keep_alive 0 frees Ollama's model after every
        # response; wd14_unload drops the tagger's ONNX session after each run.
        "keep_alive": int(_num("keep_alive", 0, 0, 3600)),
        "wd14_unload": bool(auto_in.get("wd14_unload", True)),
        "frank": bool(auto_in.get("frank")),
        # The two halves of the Ollama call. instruction replaces the mode's shipped
        # system wording; question replaces autoprompt.DEFAULT_QUESTION. Engine settings,
        # so they sit with the other Ollama ones rather than per tab. Empty is what every
        # existing workflow has. Capped because they ride in the saved file.
        "instruction": str(auto_in.get("instruction") or "")[:4000],
        "question": str(auto_in.get("question") or "")[:1000],
        "joy_quant": str(auto_in.get("joy_quant") or ""),
        "joy_style": str(auto_in.get("joy_style") or ""),
        "joy_length": str(auto_in.get("joy_length") or ""),
        "joy_memory": str(auto_in.get("joy_memory") or "auto"),
        "joy_mode_prompts": bool(auto_in.get("joy_mode_prompts", True)),
        "style_lock": auto_in.get("style_lock")
                      if auto_in.get("style_lock") in ("off", "scrub", "rewrite") else "off",
    }
    # hold the expensive dials to the tier BEFORE anything downstream reads them
    held = []
    for key in ("reference_fidelity", "scene_fidelity", "likeness_vs_obedience",
                "subject_likeness_px", "style_detail_px"):
        if key in dials:
            dials[key] = _cap(tier, key, dials[key], key, held)
    latent_cfg["scale"] = _cap(tier, "latent_scale", latent_cfg["scale"],
                               "latent scale", held)
    latent_cfg["batch"] = int(_cap(tier, "latent_batch", latent_cfg["batch"],
                                   "latent batch", held) or latent_cfg["batch"])
    mb_cap = cap_for(tier, "moodboard_refs")
    if mb_cap and isinstance(tabs.get("moodboard", {}).get("sel"), list) \
            and len(tabs["moodboard"]["sel"]) > mb_cap:
        held.append(f"moodboard refs {len(tabs['moodboard']['sel'])} -> {mb_cap}")
        tabs["moodboard"]["sel"] = tabs["moodboard"]["sel"][:mb_cap]
    resize = data.get("resize", 1024)
    resize = int(resize) if resize in (0, 1024, 1536, "0", "1024", "1536") else 1024
    resize = _cap(tier, "resize", resize, "resize", held) if resize else resize
    _announce_held(tier, held)
    return {"tabs": tabs, "dials": dials, "resize": resize,
            "use_dials": bool(data.get("use_dials", True)),
            "studio_preset": studio_preset, "auto": auto, "latent": latent_cfg,
            "vram_tier": tier, "paint": paint_cfg,
            "post": data.get("post") if isinstance(data.get("post"), dict) else {},
            "loras": loras_cfg, "paint_loras": paint_loras_cfg,
            "models": models_cfg, "prompts": prompts_cfg}


# ---------------------------------------------------------------------------
# The Models tab's loader. ONE rig cached at a time by default, keyed by the
# filenames, so a queue that changes nothing re-reads nothing and switching rigs
# drops the old references before the new files load. The Models tab's "Hold two
# rigs" toggle widens this to TWO slots, which is the two-rig Detailer flow
# (mix main render + official face passes) skipping both full disk loads every
# queue - at the price of both models held in system RAM, which is why it is an
# explicit choice and not the behaviour. Loading goes through ComfyUI's own
# loader nodes rather than reimplementing them: those are the code paths every
# workflow already exercises, and they follow core across versions.
# ---------------------------------------------------------------------------
_RIG_CACHE = {"slots": []}     # newest first: {key, model, clip, vae}

# Rig-kind handlers, registered by personal-only modules under local/ (which
# is gitignored and never ships). A handler owns its kind end to end:
# handler(op, **ctx) - op "render" receives rig, cfg, prompt_text,
# negative_text, seed, source_image and denoise, and returns an IMAGE tensor
# or None. On a public install this dict is empty and such kinds simply do
# not exist: the toggle never offers them and the parse folds them to files.
RIG_KIND_HANDLERS = {}


def _rig_cache_clear():
    _RIG_CACHE["slots"] = []


def prompt_row_for(models_cfg, prompts_cfg, rig_name=""):
    """The Prompts-tab row serving a rig; empty name means the active rig.

    The first row linked to that rig WITH TEXT wins, so an empty draft row does not
    blank a working prompt. None when nothing matches, which callers must treat as
    "no opinion", never as an empty prompt.
    """
    rigs = models_cfg.get("rigs") or []
    want = str(rig_name or "").strip()
    if (not want or want == "(active rig)") and rigs:
        want = rigs[max(0, min(int(models_cfg.get("active", 0)),
                               len(rigs) - 1))]["name"]
    rows = prompts_cfg.get("rows") or []
    for row in rows:
        if row["rig"] == want and row["text"].strip():
            return row
    # An UNLINKED row serves any rig: with one rig on the tab, demanding the link
    # be typed before anything renders is a tax, and an unlinked row with text is
    # the obvious intent. An exact link still wins, so multi-rig stays exact.
    for row in rows:
        if not row["rig"].strip() and row["text"].strip():
            return row
    return None


def blocked():
    """A silent ExecutionBlocker: downstream nodes skip instead of crashing.

    Core nodes like PreviewImage have no None guard, so handing them None on a
    paint run or in external-sampler mode is a TypeError in the user's face.
    Blocking the socket is core's own way of saying "nothing this run". Plain
    None offline, where comfy_execution does not exist.
    """
    try:
        from comfy_execution.graph_utils import ExecutionBlocker
    except Exception:
        try:
            from comfy_execution.graph import ExecutionBlocker
        except Exception:
            return None
    return ExecutionBlocker(None)


def load_active_rig(cfg, name=""):
    """(name, model, clip, vae) for a Models-tab rig; Nones when unset.

    `name` pins a specific rig, which is how two Paint Out nodes carry two different
    chains' models at once. Empty or "(active rig)" follows the Models tab's choice.
    A name that matches nothing falls back to the active rig AND SAYS SO: a renamed
    rig should degrade to the tab's choice, not to silence.
    """
    m = cfg.get("models") or {}
    rigs = m.get("rigs") or []
    if not rigs:
        return "", None, None, None
    rig = rigs[max(0, min(int(m.get("active", 0)), len(rigs) - 1))]
    want = str(name or "").strip()
    if want and want != "(active rig)":
        match = next((r for r in rigs if r["name"] == want), None)
        if match is not None:
            rig = match
        else:
            print("[RedNode Workspace] no rig named %r on the Models tab; using the "
                  "active rig %r instead" % (want, rig["name"]), flush=True)
    if rig.get("kind") == "external" or rig.get("kind") in RIG_KIND_HANDLERS:
        # an engine rig: nothing to load, and that is the point. External rigs
        # ride the sockets and the Rig Out bridge; a handled kind renders
        # inside build() through its registered handler.
        print("[RedNode Workspace] rig %r is %s: no files load"
              % (rig["name"] or "(unnamed)", rig.get("kind")), flush=True)
        return rig["name"], None, None, None
    # the rescue fields ride the cache key: toggling Rescue or moving its dial
    # must reload, or the cache would keep handing out the unpatched model
    _resc = (bool(rig.get("rescue")) and rig.get("rescue_base")
             and rig.get("rescue_lora"))
    key = (rig["checkpoint"], rig["unet"], rig["clip"], rig["clip_type"],
           rig["vae"],
           (rig["rescue_base"], rig["rescue_lora"],
            rig.get("rescue_strength", 1.0)) if _resc else None)
    if not any(key[:5]):
        return rig["name"], None, None, None
    for n, slot in enumerate(_RIG_CACHE["slots"]):
        if slot["key"] == key:
            _RIG_CACHE["slots"].insert(0, _RIG_CACHE["slots"].pop(n))
            return rig["name"], slot["model"], slot["clip"], slot["vae"]
    # make room BEFORE loading, so the cap is a peak-RAM promise, not a tidy-up:
    # one slot by default, two when the Models tab's Hold-two toggle says so
    cap = 2 if (cfg.get("models") or {}).get("hold_two") else 1
    while len(_RIG_CACHE["slots"]) >= cap:
        dropped = _RIG_CACHE["slots"].pop()
        print("[RedNode Workspace] rig cache: dropping %r to make room"
              % (dropped["key"][0] or dropped["key"][1],), flush=True)
    model = clip = vae = None
    try:
        import nodes as _nodes
        if rig["checkpoint"]:
            model, clip, vae = _nodes.CheckpointLoaderSimple().load_checkpoint(
                ckpt_name=rig["checkpoint"])[:3]
        if rig["unet"]:
            model = _nodes.UNETLoader().load_unet(
                unet_name=rig["unet"], weight_dtype="default")[0]
        if rig["clip"]:
            clip = _nodes.CLIPLoader().load_clip(
                clip_name=rig["clip"],
                type=rig["clip_type"] or "stable_diffusion")[0]
        if rig["vae"]:
            vae = _nodes.VAELoader().load_vae(vae_name=rig["vae"])[0]
        if _resc and model is not None:
            # the Models tab's Rescue toggle: this rig's LoRA-landing layers
            # restored toward the named base, so an identity LoRA fires on a
            # merged model. Everything that takes this rig gets it for free.
            from .identity_rescue import rescue_model
            model = rescue_model(model, rig["rescue_base"], rig["rescue_lora"],
                                 rig.get("rescue_strength", 1.0),
                                 who="RedNode Workspace rescue")
    except Exception as exc:
        print("[RedNode Workspace] the Models tab could not load %r: %s"
              % (rig["name"] or key, exc), flush=True)
        return rig["name"], None, None, None
    _RIG_CACHE["slots"].insert(0, {"key": key, "model": model, "clip": clip,
                                   "vae": vae})
    kinds = [k for k, v in (("model", model), ("clip", clip), ("vae", vae)) if v is not None]
    print("[RedNode Workspace] Models tab loaded %s (%s)"
          % (rig["name"] or rig["checkpoint"] or rig["unet"], ", ".join(kinds)),
          flush=True)
    return rig["name"], model, clip, vae


def load_paint_rig(cfg, name=""):
    """The rig THROUGH the paint LoRA routing: what a paint node should render with.

    "It should just be doing it automatically" (the user, 2026-08-12): the raw rig
    goes through whichever stack the Paint LoRAs routing names, the paint stack when
    it says paint, the main tab's stack otherwise, so every socket that hands a
    model to a paint chain hands the SAME stacked model the routing promises.
    """
    nm, model, clip, vae = load_active_rig(cfg, name)
    if model is None:
        return nm, model, clip, vae
    use_paint = cfg["paint"].get("lora_mode") == "paint"
    lc = (cfg.get("paint_loras") if use_paint else cfg.get("loras")) or {}
    slots = lc.get("slots") or []
    if slots and lc.get("on", True):
        model, c2, _w, applied = _lora.apply_stack(
            model, clip, _lora.CUSTOM_SENTINEL,
            json.dumps({"ui": lc.get("ui") or {}, "slots": slots}),
            int(lc.get("seed", 0) or 0), None, tag="Paint rig LoRAs")
        clip = c2 if c2 is not None else clip
        print("[RedNode Workspace] paint rig %r, %s stack applied: %s"
              % (nm or "(unnamed)", "paint" if use_paint else "main", applied),
              flush=True)
    else:
        print("[RedNode Workspace] paint rig %r, no %s stack to apply"
              % (nm or "(unnamed)", "paint" if use_paint else "main"), flush=True)
    return nm, model, clip, vae


def resize_dims(w, h, target):
    """Long edge to `target`, aspect kept, both dims rounded to /8 (min 8)."""
    if not target or (w <= 0 or h <= 0):
        return w, h
    scale = target / max(w, h)
    nw = max(8, int(round(w * scale / 8)) * 8)
    nh = max(8, int(round(h * scale / 8)) * 8)
    return nw, nh


def _inside_input(path):
    """True when a resolved path really sits inside ComfyUI's input folder.

    _managed() only looks at the front of the name, which is the right test for
    "did this panel put it there" and the wrong one for "is this safe to read":
    "rednode/../../secrets.txt" starts with rednode/ too. Anything reached from an
    HTTP request gets resolved and checked against the folder itself.
    """
    try:
        root = os.path.realpath(folder_paths.get_input_directory())
        real = os.path.realpath(path)
        return real == root or real.startswith(root + os.sep)
    except Exception:
        return False


def _filepath(name):
    """Resolve a gallery entry ("sub/f.png" or "f.png [input]") to a real path."""
    path = folder_paths.get_annotated_filepath(str(name))
    if not path or not os.path.isfile(path):
        raise ValueError(
            f"RedNode Workspace: the image {name!r} is not in the ComfyUI input folder any "
            "more. Re-add it on the panel (its gallery slot will show as missing).")
    return path


BLANK_EDGE = 1024


def blank_frame(size=BLANK_EDGE):
    """A white square, for when the picture a workflow names is not here.

    Shared workflows are the point of this: a paint source is a file on the machine
    that made it, so somebody opening a workflow from a friend, or their own after a
    restart cleared temp, names an image nobody else has. Raising there takes the
    whole queue down over a picture, and every node downstream dies with it.

    White rather than black or noise, and paired with an EMPTY mask by the callers,
    because the pair means the compositor changes nothing and any renderer in the
    chain gets an obviously blank canvas. The run survives and the failure is
    visible in the result instead of hidden inside a plausible-looking image.
    """
    return torch.ones((1, size, size, 3), dtype=torch.float32)


def load_image_or_blank(name, target, who):
    """load_image, but a missing picture is a white frame and a console line."""
    try:
        return load_image(name, target)
    except (ValueError, OSError) as e:
        print(f"[{who}] {e}", flush=True)
        print(f"[{who}] carrying on with a blank {BLANK_EDGE}px frame so the rest of "
              f"the workflow still runs. Set a picture on the Paint tab, or wire one "
              f"into this node.", flush=True)
        return blank_frame()


def load_image(name, target):
    """IMAGE tensor [1,H,W,3] in 0..1, long edge resized to `target`."""
    img = Image.open(_filepath(name))
    img = ImageOps.exif_transpose(img)
    rgb = img.convert("RGB")
    if target:
        nw, nh = resize_dims(rgb.width, rgb.height, target)
        if (nw, nh) != (rgb.width, rgb.height):
            rgb = rgb.resize((nw, nh), Image.LANCZOS)
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def composite_colour(base, colour_name, who="RedNode Paint"):
    """The colour sheet alpha-composited over the base IMAGE tensor.

    base is [1,H,W,3]; the sheet is an RGBA PNG in the sheet's own size, rescaled
    to the base. The colours become part of the picture the paint pass renders
    from, which is the whole colour-paint workflow: paint rough colour, mask over
    it, and a raised denoise resolves it into the image. A missing or broken
    sheet leaves the base untouched with a console line, never an error.
    """
    if not colour_name:
        return base
    try:
        img = Image.open(_filepath(colour_name))
        img = ImageOps.exif_transpose(img).convert("RGBA")
        h, w = int(base.shape[1]), int(base.shape[2])
        if (img.width, img.height) != (w, h):
            img = img.resize((w, h), Image.LANCZOS)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        rgb = torch.from_numpy(arr[..., :3])
        alpha = torch.from_numpy(arr[..., 3:4])
        out = base.clone()
        out[0] = base[0] * (1.0 - alpha) + rgb * alpha
        print(f"[{who}] colour paint composited over the source", flush=True)
        return out
    except Exception as e:
        print(f"[{who}] could not composite the colour paint ({e}); "
              "using the source as it is", flush=True)
        return base


def load_mask(name, size_hw=None):
    """MASK tensor [1,H,W] from a painted file's alpha (1 - alpha, LoadImage convention).

    A file with no alpha channel means nothing was painted: all-zero mask.
    """
    img = Image.open(_filepath(name))
    img = ImageOps.exif_transpose(img)
    if "A" in img.getbands():
        alpha = img.getchannel("A")
        if size_hw and (alpha.height, alpha.width) != tuple(size_hw):
            alpha = alpha.resize((size_hw[1], size_hw[0]), Image.BILINEAR)
        arr = np.asarray(alpha, dtype=np.float32) / 255.0
        mask = 1.0 - torch.from_numpy(arr)
    else:
        h, w = size_hw if size_hw else (img.height, img.width)
        mask = torch.zeros((h, w), dtype=torch.float32)
    return mask[None,]


def batch_images(tensors):
    """Batch refs the way ImageBatch does: everything bilinear-matched to the first's dims."""
    if not tensors:
        return None
    base = tensors[0]
    out = [base]
    for t in tensors[1:]:
        if t.shape[1:3] != base.shape[1:3]:
            t = torch.nn.functional.interpolate(
                t.movedim(-1, 1), size=(base.shape[1], base.shape[2]),
                mode="bilinear", antialias=True).movedim(1, -1)
        out.append(t)
    return torch.cat(out, dim=0)


class RedNodeStudioWorkspace:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("STRING", {"default": "{}", "multiline": True, "tooltip":
                           "the workspace state (galleries, selections, masks, dials) as JSON. "
                           "The panel above edits this."}),
                # AFTER config: widget values restore by position, so the new widget must
                # come last or every existing workspace would swap its values on load
                "preset": ([CUSTOM_SENTINEL] + sorted(load_presets()),
                           {"tooltip": "load a saved workspace (galleries, selections, masks, "
                                       "dials). 'custom (live)' leaves it as it is. Presets "
                                       "store filenames, so they are per-machine."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT"},
            "optional": {
                # the loaded text encoder: CLIP gen captions with it, comfy-core style,
                # so auto prompting costs no extra model at all
                "clip": ("CLIP", {"tooltip": "wire the workflow's CLIP here and the CLIP gen "
                                  "engine captions with the already-loaded text encoder"}),
                "latent": ("LATENT", {"tooltip": "your own latent. Set the Latent tab's "
                           "source to 'wired input' and this comes straight back out of "
                           "output_latent, instead of the canvas this node would build"}),
                "model": ("MODEL", {"tooltip": "wire the model here and the LoRAs tab "
                            "applies its stack, handing it back on the model output "
                            "with the trigger words on lora_keywords"}),
                "vae": ("VAE", {"tooltip": "wire the workflow's VAE and the Img2Img tab's "
                                "source image comes out of output_latent ENCODED, ready "
                                "for the sampler at the tab's denoise"}),
                # wired captions from any external captioner chain (JoyCaption, Florence):
                # combined into that tab's auto prompt
                "subject_caption_in": ("STRING", {"forceInput": True, "tooltip":
                    "external caption for the subject, merged into subject_prompt"}),
                "scene_caption_in": ("STRING", {"forceInput": True, "tooltip":
                    "external caption for the scene, merged into scene_prompt"}),
                "mood_caption_in": ("STRING", {"forceInput": True, "tooltip":
                    "external caption for the moodboard, merged into moodboard_prompt"}),
                "i2i_caption_in": ("STRING", {"forceInput": True, "tooltip":
                    "external caption for the img2img source, merged into i2i_prompt"}),
                # escape hatches: a wired mask always beats the painted one
                "boost_mask_in": ("MASK", {"tooltip": "optional wired subject-boost mask — "
                                           "overrides the one painted on the Masks tab"}),
                "edit_mask_in": ("MASK", {"tooltip": "optional wired edit mask — overrides the "
                                          "one painted on the Masks tab"}),
                # APPENDED: the Frame-vocabulary inputs, the same four the Prompt
                # Frame node takes, for the helper nodes that build prompt pieces.
                # Each joins the ACTIVE rig's prompt row: on a Krea 2 row it lands in
                # its slot after the typed text; on a plain row all four combine and
                # append at the end. The old *_caption_in sockets keep feeding the
                # per-tab auto prompts exactly as before.
                "style_in": ("STRING", {"forceInput": True, "tooltip":
                    "style wording for the active prompt row, joined after its own"}),
                "subject_in": ("STRING", {"forceInput": True, "tooltip":
                    "subject wording for the active prompt row, joined after its own"}),
                "surroundings_in": ("STRING", {"forceInput": True, "tooltip":
                    "surroundings wording for the active prompt row, joined after "
                    "its own"}),
                "light_and_colour_in": ("STRING", {"forceInput": True, "tooltip":
                    "light and colour wording for the active prompt row, joined "
                    "after its own"}),
                # APPENDED: the chain input. Wire another workspace's image output
                # here, set the Img2Img tab's canvas to Wired image, and this one
                # renders over it at the tab's denoise. Pixels fit every model, so
                # a Krea 2 workspace can feed an XL one this way; the latent input
                # does the same for same-model chains with no VAE round trip.
                "image_in": ("IMAGE", {"tooltip":
                    "an image to use as the Img2Img canvas when the tab's canvas "
                    "is set to Wired image. Chain another workspace's image output "
                    "in here."}),
            },
        }

    RETURN_TYPES = (WORKSPACE_TYPE, "IMAGE", "IMAGE", "IMAGE", "KREA2_SOURCES",
                    "MASK", "MASK", SETTINGS_TYPE, "LATENT", "FLOAT", "STRING",
                    "STRING", "STRING", "STRING", "IMAGE", "STRING", "FLOAT",
                    postprocess.POST_TYPE, "MODEL", "STRING", "CLIP", "STRING",
                    "MODEL", "VAE", "INT", "FLOAT",
                    comfy.samplers.KSampler.SAMPLERS,
                    comfy.samplers.KSampler.SCHEDULERS, "INT",
                    "CONDITIONING", "CONDITIONING", "IMAGE", "LATENT", "INT",
                    "STRING", "STRING")
    RETURN_NAMES = ("workspace", "subject_image", "scene_image", "moodboard_style",
                    "extra_subjects", "subject_boost_mask", "edit_mask", "settings",
                    "output_latent", "style_strength", "studio_preset",
                    "subject_prompt", "scene_prompt", "moodboard_prompt",
                    "i2i_image", "i2i_prompt", "denoise", "post_process",
                    "model", "lora_keywords", "clip", "paint_prompt",
                    "paint_model", "vae",
                    "steps", "cfg", "sampler_name", "scheduler", "detailer_steps",
                    "positive", "negative", "image", "result_latent", "seed",
                    "prompt_text", "negative_text")
    FUNCTION = "build"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("The whole studio input rig in one tabbed panel: per-tab image galleries, "
                   "painted masks, extra people and the fidelity dials. Outputs one workspace "
                   "bundle for the studio's `workspace` input, plus flat sockets for Get/Set "
                   "wiring. Disabled tabs output nothing.")

    @classmethod
    def IS_CHANGED(cls, config="{}", **kwargs):
        cfg0 = parse_config(config)
        # a live random tab has to re-roll on every queue — NaN never equals itself.
        # Deliberate cost: downstream recomputes each run, which a fresh image needs anyway.
        # An UNFIXED auto prompt re-rolls the same way: fresh LLM wording per queue.
        if cfg0["models"]["seed_random"] and (
                cfg0["models"]["sampler_mode"] == "internal"
                or any(r.get("text") for r in cfg0["prompts"]["rows"])):
            return float("nan")
        for name in IMAGE_TABS:
            t = cfg0["tabs"][name]
            if t["random"] and t["on"] and len(t["images"]) > 1:
                return float("nan")
            a = t.get("auto") or {}
            if a.get("on") and t["on"] and not a.get("fixed", True):
                return float("nan")
        # a random latent size re-rolls per queue too
        if cfg0["latent"]["on"] and cfg0["latent"]["random"]:
            return float("nan")
        # the config already changes when selections do; hash file mtimes too, so
        # re-painting a mask or overwriting an upload re-runs the node
        cfg = cfg0
        h = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode())
        for tab in cfg["tabs"].values():
            for name in list(tab["images"]) + ([tab["mask"]] if tab["mask"] else []):
                try:
                    h.update(str(os.path.getmtime(folder_paths.get_annotated_filepath(name))).encode())
                except Exception:
                    h.update(b"missing")
        return h.hexdigest()

    def build(self, config="{}", preset=CUSTOM_SENTINEL, prompt=None,
              boost_mask_in=None, edit_mask_in=None,
               unique_id=None, subject_caption_in=None, scene_caption_in=None,
               mood_caption_in=None, clip=None, i2i_caption_in=None, vae=None,
               model=None, latent=None, style_in=None, subject_in=None,
               surroundings_in=None, light_and_colour_in=None, image_in=None):
        latent_in = latent
        cfg = parse_config(config)
        # THE MODELS TAB FILLS WHAT IS NOT WIRED, and it must happen FIRST: the auto
        # prompt's CLIP gen and everything after read `clip`, so a fill that arrived
        # just before the LoRA block left them seeing None. A wired input always wins.
        rig_name, rig_model, rig_clip, rig_vae = load_active_rig(cfg)
        if model is None and rig_model is not None:
            model = rig_model
        if clip is None and rig_clip is not None:
            clip = rig_clip
        # THE VAE TOO. The i2i encode, the latent tab and the folded Studio all read
        # `vae`, and each of them silently sat out on a rig-only graph because only
        # the wired socket was consulted: an image on the Img2Img tab was ignored
        # outright. One rule, everywhere: wired wins, the rig fills.
        if vae is None and rig_vae is not None:
            vae = rig_vae
        # ONE SEED PER QUEUE, shared by the wildcard picks, the embedded sampler and
        # the built-in paint pass, so a single number reproduces the whole render and
        # Randomize re-rolls all of it together.
        run_seed = (_random.getrandbits(48) if cfg["models"]["seed_random"]
                    else cfg["models"]["seed"])
        _rigs = cfg["models"]["rigs"]
        _ar = (_rigs[cfg["models"]["active"]] if _rigs
               else {"steps": 8, "cfg": 1.0, "sampler": "euler",
                     "scheduler": "simple", "detailer_steps": 8})
        rig_steps, rig_cfg = _ar["steps"], _ar["cfg"]
        rig_detailer = _ar["detailer_steps"]
        rig_sampler = (_ar["sampler"] if _ar["sampler"]
                       in comfy.samplers.KSampler.SAMPLERS else "euler")
        rig_scheduler = (_ar["scheduler"] if _ar["scheduler"]
                         in comfy.samplers.KSampler.SCHEDULERS else "simple")
        target = cfg["resize"]
        tabs = cfg["tabs"]

        # every consumer (image, mask sizing, latent dims) must see the SAME roll, so the
        # chosen index per tab is resolved once and memoised
        picks = {}

        def chosen_index(name):
            t = tabs[name]
            if name in picks:
                return picks[name]
            idx = t["sel"]
            if t["random"] and len(t["images"]) > 1:
                idx = _random.randrange(len(t["images"]))
            picks[name] = idx
            return idx

        def tab_image(name):
            t = tabs[name]
            if not t["on"] or not t["images"]:
                return None
            i = chosen_index(name)
            # SAY WHICH PICTURE. The console reported that a reference was encoded and
            # how many there were, but never which file, so "the output is not the
            # person I chose" could not be told apart from "the model ignored the
            # person I chose" without opening the gallery and counting slots. One is a
            # wiring bug and the other is a model result, and they need completely
            # different fixes. The index is printed with it because an off-by-one in a
            # gallery selection looks exactly like the wrong image being sent.
            print(f"[RedNode Workspace] {name}: using image {i + 1} of "
                  f"{len(t['images'])} — {t['images'][i]}"
                  + ("  (dice on)" if t.get("random") and len(t["images"]) > 1 else ""),
                  flush=True)
            return load_image(t["images"][i], target)

        subject = tab_image("subject")
        scene = tab_image("scene")
        i2i_img = tab_image("i2i")

        mood = None
        mt = tabs["moodboard"]
        if mt["on"] and mt["images"]:
            if mt["random"] and len(mt["images"]) > 1:
                i = _random.randrange(len(mt["images"]))
                picks["moodboard"] = i
                mood = load_image(mt["images"][i], target)
            elif mt["sel"]:
                mood = batch_images([load_image(mt["images"][i], target) for i in mt["sel"]])

        extra = [img for img in (tab_image("subject2"), tab_image("subject3")) if img is not None]
        extra = extra or None

        boost = boost_mask_in
        bt = tabs["boost_mask"]
        if boost is None and bt["on"] and bt["mask"]:
            size = subject.shape[1:3] if subject is not None else None
            boost = load_mask(bt["mask"], size)

        # The edit mask was painted over a base image; the sampler's latent has to be
        # EXACTLY that image's post-resize dims or the painted region lands offset. So the
        # mask is sized to the base, and a matching empty latent goes out alongside it —
        # feed that latent to both the studio's output_latent and the sampler.
        def edit_base_dims():
            for tab_name in ("scene", "subject"):
                t = tabs[tab_name]
                if t["on"] and t["images"]:
                    with Image.open(_filepath(t["images"][chosen_index(tab_name)])) as im:
                        im = ImageOps.exif_transpose(im)
                        w, h = im.width, im.height
                    nw, nh = resize_dims(w, h, target) if target else (w, h)
                    return nh, nw
            return None

        edit = edit_mask_in
        latent = None
        et = tabs["edit_mask"]
        base_hw = edit_base_dims() if (et["on"] and (et["mask"] or edit_mask_in is not None)) else None
        if edit is None and et["on"] and et["mask"]:
            edit = load_mask(et["mask"], base_hw)
        if base_hw is not None:
            # 4 channels on purpose: comfy's fix_empty_latent_channels() re-shapes it to
            # whatever the sampled model wants, exactly as EmptyLatentImage relies on
            latent = {"samples": torch.zeros((1, 4, base_hw[0] // 8, base_hw[1] // 8))}

        # The Paint tab deliberately does NOT touch these outputs. It used to feed
        # output_latent and edit_mask, which meant a normal queue quietly inherited
        # whatever was painted: you would run the workflow and get your picture back
        # wearing a mask it knew nothing about. Painting is its own loop now, run by
        # RedNode Paint Render, which reads the tab straight from the queued prompt.
        denoise_out = 1.0
        painted = False

        # output_latent precedence, strongest claim first:
        #   1. the edit-mask base, because the paint has to stay aligned to it
        #   2. a real Img2Img pass: choosing "image to image" IS the explicit choice
        #   3. the Latent tab, which is the canvas a prompt-only pass generates onto
        # (the Paint tab sits outside all of this: it has its own render node.)
        it = tabs["i2i"]
        # THE CHAIN CANVASES. "Wired image" substitutes the wired picture for the
        # gallery pick and rides the whole existing encode path, scale, tiling and
        # all. "Wired latent" takes the latent input as the canvas directly and
        # applies the tab's denoise, which a bare wired latent never did. Both say
        # so, and say when the wire is missing rather than silently falling back.
        if it["on"] and not it["prompt_only"] and it["canvas"] == "image":
            if image_in is not None:
                i2i_img = image_in
                print("[RedNode Workspace] i2i canvas: the wired image input "
                      f"({image_in.shape[2]} x {image_in.shape[1]})", flush=True)
            else:
                print("[RedNode Workspace] the i2i canvas is set to Wired image but "
                      "nothing is wired into image_in; using the gallery", flush=True)
        if it["on"] and not it["prompt_only"] and it["canvas"] == "latent":
            if latent_in is not None:
                latent = latent_in
                denoise_out = it["denoise"]
                print("[RedNode Workspace] i2i canvas: the wired latent, denoise "
                      "%.2f" % denoise_out, flush=True)
            else:
                print("[RedNode Workspace] the i2i canvas is set to Wired latent "
                      "but nothing is wired into latent", flush=True)
        real_i2i = it["on"] and i2i_img is not None and not it["prompt_only"]
        if latent is None and real_i2i:
            if vae is not None:
                enc = i2i_img
                if it["scale"] != 1.0:
                    eh = max(64, int(enc.shape[1] * it["scale"]) // 8 * 8)
                    ew = max(64, int(enc.shape[2] * it["scale"]) // 8 * 8)
                    enc = torch.nn.functional.interpolate(
                        enc.permute(0, 3, 1, 2), size=(eh, ew), mode="bilinear",
                        align_corners=False).permute(0, 2, 3, 1)
                    print(f"[RedNode Workspace] i2i scale {it['scale']:g}: "
                          f"{i2i_img.shape[2]} x {i2i_img.shape[1]} -> {ew} x {eh}",
                          flush=True)
                px = enc.shape[1] * enc.shape[2]
                print(f"[RedNode Workspace] encoding the i2i source "
                      f"({enc.shape[2]} x {enc.shape[1]})...", flush=True)
                try:
                    # a big source encoded whole is a long VRAM spike that looks
                    # exactly like a hang, so tile it past roughly 2 megapixels
                    pixels = enc[:, :, :, :3]
                    if px > 2_100_000 and hasattr(vae, "encode_tiled"):
                        print("[RedNode Workspace] that is large, so encoding it in "
                              "tiles. Lower the i2i scale to skip this.", flush=True)
                        try:
                            # The tile geometry is passed explicitly on purpose. A video
                            # VAE (3 latent dims, e.g. WanVAE) builds its overlap tuple
                            # out of this argument, and left at None it becomes
                            # (1, None, None) and the tiler does int minus None. An
                            # ordinary 2D VAE never hits that, which is why calling it
                            # bare looked fine.
                            samples = vae.encode_tiled(pixels, tile_x=512, tile_y=512,
                                                       overlap=64)
                        except Exception as e:
                            # tiling is an optimisation, not the point. Losing the whole
                            # i2i pass because the tiler disagreed with this VAE would be
                            # a bad trade, so try it whole before giving up.
                            print(f"[RedNode Workspace] the tiled encode failed ({e}); "
                                  "encoding it whole instead, which needs more VRAM",
                                  flush=True)
                            samples = vae.encode(pixels)
                    else:
                        samples = vae.encode(pixels)
                    latent = {"samples": samples}
                    denoise_out = it["denoise"]
                    print(f"[RedNode Workspace] i2i pass: source encoded into "
                          f"output_latent, denoise {denoise_out} on the denoise socket"
                          + (". The Latent tab is on but the i2i pass takes precedence."
                             if cfg["latent"]["on"] else ""), flush=True)
                except Exception as e:
                    print(f"[RedNode Workspace] could not encode the i2i source ({e}). "
                          "output_latent falls back to the Latent tab and denoise stays "
                          "1.0, so the i2i pass is NOT happening this run.", flush=True)
            else:
                print("[RedNode Workspace] the Img2Img tab wants a real i2i pass but no "
                      "VAE is wired, so there is nothing to encode with. Wire the vae "
                      "input. Until then output_latent falls back to the Latent tab and "
                      "denoise stays 1.0, which looks exactly like image to image doing "
                      "nothing.", flush=True)

        # Every OTHER way the pass can fail to happen used to be silent, and silence is
        # the worst possible answer here: the Latent tab quietly fills the slot and
        # denoise stays 1.0, so it reads as "the latent overrode my i2i" or "denoise is
        # broken" when the truth is that the pass never ran at all. Say which.
        if latent is None and it["on"] and not it["prompt_only"] and i2i_img is None:
            print("[RedNode Workspace] the Img2Img tab is on and set to a real pass, but "
                  "it has no usable image, so there is nothing to encode. output_latent "
                  "falls back to the Latent tab and denoise stays 1.0.", flush=True)

        # any ENGINE rig (external, or a handled kind like the personal NAI
        # rig) is the cockpit for a renderer that is not a loaded checkpoint:
        # the denoise socket and the handler both read ITS strength dial
        if _ar.get("kind", "files") != "files":
            denoise_out = _ar.get("denoise", 1.0)

        # the Latent tab: the canvas for a prompt-only pass, or for a plain
        # generation. Its source can be a latent wired into this node instead.
        lat_cfg = cfg["latent"]
        if latent is None and lat_cfg["on"] and lat_cfg["source"] == "input":
            if latent_in is not None:
                latent = latent_in
                sm = latent_in.get("samples")
                if sm is not None:
                    print(f"[RedNode Workspace] using the wired latent "
                          f"({sm.shape[3] * 8} x {sm.shape[2] * 8}, batch {sm.shape[0]})",
                          flush=True)
            else:
                print("[RedNode Workspace] the Latent tab is set to the wired input but "
                      "nothing is wired into the latent socket; building the canvas "
                      "here instead", flush=True)

        if latent is None and cfg["latent"]["on"]:
            lc = cfg["latent"]
            lw, lh = lc["w"], lc["h"]
            if lc["random"]:
                lw, lh = LATENT_PRESETS[_random.randrange(len(LATENT_PRESETS))]
            # the scale slider multiplies the base canvas; 2.0 is four times the pixels
            lw = int(lw * lc["scale"]) // 8 * 8
            lh = int(lh * lc["scale"]) // 8 * 8
            if lc["random"]:
                picks["latent"] = f"{lw} x {lh}"
                print(f"[RedNode Workspace] rolled latent size: {lw} x {lh}", flush=True)
            latent = {"samples": torch.zeros((lc["batch"], 4, lh // 8, lw // 8))}

        # output_latent must never leave here as None. It used to be allowed to, and a
        # None travelling down a LATENT wire does not fail here where the cause is: it
        # fails inside whatever sampler received it, as "'NoneType' object is not
        # subscriptable", which points at the wrong node entirely. If every claim above
        # declined, hand out a plain canvas and say loudly why, so the run completes and
        # the console explains itself.
        # Only when a real i2i pass was ASKED FOR and could not be delivered. Everything
        # off still outputs nothing, which is the documented behaviour and the honest
        # one: inventing a canvas nobody asked for would silently generate at the wrong
        # size. But if the Img2Img tab is on and set to a real pass, the user is plainly
        # expecting a latent, so give one at the source's own size rather than a None.
        if latent is None and it["on"] and not it["prompt_only"]:
            fw = fh = int(cfg["resize"] or 1024) or 1024
            if i2i_img is not None:
                fh, fw = int(i2i_img.shape[1]) // 8 * 8, int(i2i_img.shape[2]) // 8 * 8
            latent = {"samples": torch.zeros((1, 4, max(8, fh // 8), max(8, fw // 8)))}
            print(f"[RedNode Workspace] the i2i pass could not deliver a latent, so "
                  f"output_latent is an empty {fw} x {fh} canvas instead of nothing. A "
                  "None here would have crashed your sampler blaming its own node. See "
                  "above for why the pass did not run.", flush=True)

        # ---- the settings dict: always complete, whatever the dials say --------
        # ...unless the dials are switched off entirely, which hands the studio back
        # to whatever Settings node is wired to it
        settings = None if not cfg["use_dials"] else dict(SETTINGS_DEFAULTS)
        for key, val in (cfg["dials"].items() if settings is not None else ()):
            if key not in SETTINGS_DEFAULTS:
                continue                                  # style_strength and friends
            if isinstance(SETTINGS_DEFAULTS[key], bool):
                settings[key] = bool(val)
            elif isinstance(SETTINGS_DEFAULTS[key], int):
                settings[key] = int(val)
            else:
                settings[key] = val
        # the one-click OFF for the attention-bias machinery: no boosts, no isolation,
        # no L x L matrix, regardless of where the sliders sit. The low-VRAM switch.
        if settings is not None and cfg["dials"].get("boosts_off"):
            settings["reference_fidelity"] = 1.0
            settings["scene_fidelity"] = 1.0
            settings["isolate_refs"] = False

        # NOT a settings key: the studio owns this widget, so it rides the bundle only
        # when the dial was actually set here, and the studio says so out loud
        style_strength = cfg["dials"].get("style_strength")

        # ---- auto prompts: engines fail soft, results ride outputs + bundle ----
        wired_map = {"subject": subject_caption_in, "scene": scene_caption_in,
                     "moodboard": mood_caption_in, "i2i": i2i_caption_in}
        tensor_map = {"subject": subject, "scene": scene, "moodboard": mood,
                      "i2i": i2i_img}
        prompts = {}
        # Ollama across several tabs: keep the model resident for the run instead of
        # letting keep_alive 0 unload and reload it per tab. Four reloads of a vision
        # model while the sampler holds its own VRAM is what turns captioning from
        # slow into stuck. It is released again below.
        ga0 = cfg["auto"]
        ollama_tabs = [n for n in ("subject", "scene", "moodboard", "i2i")
                       if tabs[n]["auto"]["on"] and tabs[n]["auto"]["ollama"]
                       and tabs[n]["on"]]
        run_keep_alive = max(300, int(ga0["keep_alive"])) if ollama_tabs else \
            int(ga0["keep_alive"])
        for tab_name in ("subject", "scene", "moodboard", "i2i"):
            t = tabs[tab_name]
            a = t["auto"]
            wired = [wired_map[tab_name]] if wired_map[tab_name] else []
            if not (a["on"] and t["on"] and (t["images"] or wired)):
                # a wired caption is text the user plumbed in by hand, so it ALWAYS
                # passes through, even with this tab's auto prompt (or the tab itself)
                # switched off. Dropping it made "I wired text in and got nothing out"
                # a silent, baffling dead end. Engines still need auto on. The
                # Advanced tab's caption passthrough switch turns this off.
                passthru = cfg["dials"].get("caption_passthrough", True)
                prompts[tab_name] = wired[0] if (wired and passthru) else ""
                continue
            # the moodboard's selection is a LIST (it batches); caption the roll when
            # random, otherwise the batch's first image. Indexing with the raw list
            # crashed the queue.
            entry = None
            if t["images"]:
                idx = chosen_index(tab_name)
                if isinstance(idx, list):
                    idx = idx[0] if idx else 0
                entry = t["images"][idx]
            img_bytes = None
            if entry and a["ollama"]:
                # re-encoded, not the raw file: a webp the endpoint cannot read, or
                # a huge original, both just look like a slow captioner. Deferred, so
                # a cached caption costs no resize at all.
                img_bytes = (lambda pth=_filepath(entry):
                             autoprompt.vision_payload(pth))
            mtime = None
            if entry:
                try:
                    mtime = os.path.getmtime(_filepath(entry))
                except OSError:
                    pass
            ga = cfg["auto"]

            # every tensor engine needs the image, not just WD14 — gating on WD14 alone
            # silently starved CLIP gen, JoyCaption and QwenVL of their input. And the
            # moodboard tensor is a BATCH: caption its first ref (the resolved entry).
            need_tensor = a["wd14"] or a["joy"] or a["qwen"] or a["clipgen"]
            t_img = tensor_map[tab_name] if need_tensor else None
            if t_img is not None and t_img.shape[0] > 1:
                t_img = t_img[:1]

            def _build(a=a, img_bytes=img_bytes, tab_name=tab_name, wired=wired, ga=ga,
                       t_img=t_img):
                return autoprompt.build_prompt(
                    a["mode"], image_bytes=img_bytes,
                    image_tensor=t_img,
                    wired=wired, use_ollama=a["ollama"], use_wd14=a["wd14"],
                    use_joy=a["joy"], use_qwen=a["qwen"],
                    use_clip=a["clipgen"], clip=clip,
                    unload_heavy=ga["wd14_unload"],
                    combine=a["combine"], max_words=a["length"],
                    model=ga["model"], url=ga["url"],
                    wd14_model=ga["wd14_model"], threshold=ga["threshold"],
                    character_threshold=ga["character_threshold"],
                    replace_underscore=ga["replace_underscore"],
                    exclude_tags=ga["exclude_tags"],
                    ollama_options={"temperature": ga["temperature"], "seed": ga["seed"],
                                    "num_ctx": ga["num_ctx"], "num_predict": ga["num_predict"],
                                    "top_k": ga["top_k"], "top_p": ga["top_p"]},
                    think=ga["think"], keep_alive=run_keep_alive,
                    frank=ga["frank"],
                    joy_opts={"quantization": ga["joy_quant"], "prompt_style": ga["joy_style"],
                              "caption_length": ga["joy_length"], "memory": ga["joy_memory"],
                              "use_mode_prompt": ga["joy_mode_prompts"]},
                    instruction=ga["instruction"], question=ga["question"],
                    # cache_base stays exactly as it was. build_prompt folds the
                    # instruction into Ollama's own key, and only once one is typed,
                    # so nobody's saved captions move.
                    cache_base=[tab_name, entry, mtime, a["mode"], ga["frank"]],
                    use_cache=a["fixed"],
                    sidecar=(_filepath(entry) + ".rn.json")
                            if entry and _managed(entry) else None)

            # per-engine caching happens INSIDE build_prompt now: the key carries the
            # image and mode, so toggling one engine reuses every other engine's part.
            # FRESH (fixed off) rebuilds but still stores, so flipping back is warm.
            prompts[tab_name] = _build()
            if prompts[tab_name]:
                # the caption itself is only echoed when asked for: it is the user's
                # writing about the user's picture, and a console is a public place
                # the moment a screenshot is taken
                if cfg["dials"].get("echo_prompts", True):
                    print(f"[RedNode Workspace] auto prompt ({tab_name}/{a['mode']}): "
                          f"{prompts[tab_name][:100]}...", flush=True)
                else:
                    print(f"[RedNode Workspace] auto prompt ({tab_name}/{a['mode']}): "
                          f"{len(prompts[tab_name])} characters", flush=True)
        # hand the VRAM back if that is what the user asked for; holding it was only
        # ever to get through this run's tabs on one load
        if ollama_tabs and int(ga0["keep_alive"]) <= 0:
            autoprompt.ollama_unload(ga0["model"], ga0["url"])

        any_engines = any(
            tabs[n]["auto"]["on"] and (tabs[n]["auto"]["wd14"] or tabs[n]["auto"]["ollama"]
                                       or tabs[n]["auto"]["joy"] or tabs[n]["auto"]["qwen"])
            for n in ("subject", "scene", "moodboard", "i2i"))
        # STYLE LOCK: the moodboard's prompt is the style authority. Style vocabulary in
        # the subject and scene prompts that the mood prompt does not itself use is
        # scrubbed (or LLM-rewritten), so an image-to-image source cannot smuggle its
        # own style past the moodboard.
        lock = cfg["auto"]["style_lock"]
        if lock != "off" and prompts.get("moodboard"):
            mood_text = prompts["moodboard"]
            for tab_name in ("subject", "scene", "i2i"):
                if not prompts.get(tab_name):
                    continue
                if lock == "rewrite":
                    # the loaded CLIP does the rewrite for free when wired; Ollama backs
                    # it up; the scrub is always the floor inside enforce_style
                    prompts[tab_name] = autoprompt.cached_part(
                        ["stylelock", prompts[tab_name], mood_text,
                         cfg["auto"]["model"], clip is not None],
                        lambda t=prompts[tab_name]: autoprompt.enforce_style(
                            t, mood_text, model=cfg["auto"]["model"], clip=clip,
                            url=cfg["auto"]["url"], keep_alive=cfg["auto"]["keep_alive"]))
                else:
                    prompts[tab_name] = autoprompt.strip_style_terms(
                        prompts[tab_name], mood_text)

        # AUTO PROMPTS INTO THE PROMPT ROWS, automatically. A tab whose auto prompt
        # names a row hands its finished caption (converter and all) to that row at
        # queue time. A Krea 2 row re-assembles through RedNodePromptFrame.run with
        # the caption on the matching *_in input, which joins it AFTER the typed
        # text, the standing rule; a plain row appends it. No button, no wire.
        injections = {}
        for _tn in ("subject", "scene", "moodboard", "i2i"):
            _a = tabs[_tn].get("auto") or {}
            _cap = (prompts.get(_tn) or "").strip()
            if _a.get("on") and _a.get("inject_row") and _cap:
                injections.setdefault(_a["inject_row"], {})                     .setdefault(_a.get("inject_slot", "subject"), []).append(_cap)
        _wired_frame = {"style": style_in, "subject": subject_in,
                        "surroundings": surroundings_in,
                        "light_and_colour": light_and_colour_in}
        if any(str(v or "").strip() for v in _wired_frame.values()):
            _target = prompt_row_for(cfg["models"], cfg["prompts"])
            if _target is None and cfg["prompts"]["rows"]:
                _target = cfg["prompts"]["rows"][0]
            if _target is None:
                print("[RedNode Workspace] frame inputs are wired but the Prompts "
                      "tab has no row to receive them", flush=True)
            else:
                _hit0 = injections.setdefault(_target["name"], {})
                for _k, _v in _wired_frame.items():
                    _v = str(_v or "").strip()
                    if _v:
                        _hit0.setdefault(_k, []).append(_v)
        for _row in cfg["prompts"]["rows"]:
            _hit = injections.get(_row["name"])
            if not _hit:
                continue
            _flat = ", ".join(c for k in ("style", "subject", "surroundings",
                                          "light_and_colour", "prompt")
                              for c in _hit.get(k, []))
            if _row["kind"] == "krea2" and _row.get("frame"):
                _fr = _row["frame"]
                try:
                    from .prompt_frame import RedNodePromptFrame
                    _ins = {k: ", ".join(v) for k, v in _hit.items() if k != "prompt"}
                    _extra = ", ".join(_hit.get("prompt", []))
                    _row["text"], _n2 = RedNodePromptFrame().run(
                        subject=str(_fr.get("subject") or ""),
                        surroundings=str(_fr.get("surroundings") or ""),
                        framing=str(_fr.get("framing") or "Balanced"),
                        placement=str(_fr.get("placement") or ""),
                        light_and_colour=str(_fr.get("light_and_colour") or ""),
                        placement_where=str(_fr.get("placement_where") or "None"),
                        placement_what=str(_fr.get("placement_what") or "None"),
                        lighting=str(_fr.get("lighting") or "None"),
                        brightness=int(_fr.get("brightness") or 0),
                        style=str(_fr.get("style") or "None"),
                        style_extra=str(_fr.get("style_extra") or ""),
                        framing_push=str(_fr.get("framing_push") or "Off"),
                        style_in=_ins.get("style", ""),
                        subject_in=_ins.get("subject", ""),
                        surroundings_in=_ins.get("surroundings", ""),
                        light_and_colour_in=", ".join(
                            x for x in (_ins.get("light_and_colour", ""), _extra) if x),
                        seed=run_seed)
                    print("[RedNode Workspace] auto prompt injected into %r"
                          % (_row["name"] or "a prompt row"), flush=True)
                except Exception as exc:
                    print("[RedNode Workspace] could not inject into %r: %s"
                          % (_row["name"], exc), flush=True)
            elif _flat:
                _t = _row["text"].strip().rstrip(",")
                _row["text"] = (_t + ", " + _flat) if _t else _flat
                print("[RedNode Workspace] auto prompt injected into %r"
                      % (_row["name"] or "a prompt row"), flush=True)
        # WILDCARDS RESOLVE AT QUEUE TIME, with the run seed. The tab stores the
        # text unresolved (the preview shows the tokens), so a __wildcard__ or {a|b}
        # re-rolls every queue instead of being baked at seed 0 the day it was typed.
        # Resolving twice is safe: a resolved text has no tokens left to match.
        try:
            from .prompt_frame import expand as _pf_expand
            for _row in cfg["prompts"]["rows"]:
                if _row["text"]:
                    _row["text"] = _pf_expand(_row["text"], run_seed, True)
        except Exception as exc:
            print("[RedNode Workspace] wildcard resolve failed: %s" % exc, flush=True)

        # a paint prompt that came FROM a row must see the injected version
        if cfg["paint"].get("prompt_from") == "prompts_tab":
            _row3 = prompt_row_for(cfg["models"], cfg["prompts"])
            if _row3 is not None:
                cfg["paint"]["prompt"] = _row3["text"]

        # the LoRAs tab: the stack rides the model through, exactly as the LoRA Stack
        # node does it (same code), so the workspace can carry the whole rig
        lora_words = ""
        lora_clip = clip
        raw_model = model            # the wired input, kept: the paint branch starts here
        lc = cfg["loras"]
        n_lora = sum(1 for x in lc["slots"] if x.get("type") != "title")
        if model is not None and lc["on"] and lc["slots"]:
            # the CLIP goes in too when it is wired: plenty of LoRAs carry text
            # encoder weights, and dropping them applies half the LoRA while
            # looking like it worked
            # pass OUR node id, so the rolls a random slot drew come back to this
            # panel: the tab hosts the same list and wants the same highlight
            model, lora_clip, lora_words, _applied = _lora.apply_stack(
                model, clip, _lora.CUSTOM_SENTINEL,
                json.dumps({"ui": lc["ui"], "slots": lc["slots"]}),
                lc["seed"], unique_id, tag="Workspace LoRAs")
            if clip is None:
                print("[RedNode Workspace] no clip is wired, so only the model half of "
                      "each LoRA is applied. Wire clip for the text encoder half.",
                      flush=True)
            lora_clip = lora_clip if lora_clip is not None else clip
        elif model is None and lc["on"] and n_lora:
            # the commonest way for this to look broken: slots set up, nothing wired
            print(f"[RedNode Workspace] the LoRAs tab has {n_lora} LoRA(s) but no model "
                  "is wired into the workspace, so none of them can be applied. Wire "
                  "your model into the model input and take it from the model output.",
                  flush=True)
        elif model is not None and lc["slots"] and not lc["on"]:
            print("[RedNode Workspace] the LoRAs tab is off; the model passes through "
                  "unchanged", flush=True)

        # The paint branch: ONE INPUT, TWO BRANCHES, never a chain. apply_stack ends in
        # load_lora_for_models, which clones before patching, so applying the paint
        # stack to raw_model leaves the main stack's model untouched and vice versa.
        # "main" hands back the main-stacked model, so a workflow that wires paint_model
        # without ever opening the paint LoRA tab behaves exactly as the model output.
        paint_mode = cfg["paint"].get("lora_mode", "main")
        pls = cfg["paint_loras"]
        paint_model = model
        # the clip matching the branch: the paint prompt must encode with the same
        # LoRA text-encoder half the paint model carries, or trigger words and TE
        # weights silently sit out of the conditioning
        paint_clip = lora_clip
        if paint_mode == "paint":
            if raw_model is not None and pls["slots"]:
                paint_model, _paint_clip, _pw, _pa = _lora.apply_stack(
                    raw_model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": pls["ui"], "slots": pls["slots"]}),
                    pls["seed"], unique_id, tag="Workspace Paint LoRAs")
                paint_clip = _paint_clip if _paint_clip is not None else clip
            elif raw_model is not None:
                # asked for the paint stack with nothing in it: the honest reading is
                # "no LoRAs on the paint pass", and saying so beats guessing "main"
                paint_model = raw_model
                print("[RedNode Workspace] paint LoRA routing is set to the paint "
                      "stack, but the stack is empty, so the paint branch carries "
                      "the bare model.", flush=True)

        # the Post tab: a grading chain configured here, applied at the end of the
        # graph by RedNode Post Process (post processing happens after the sampler,
        # so this node can only carry the settings, not run them)
        post_cfg = postprocess.parse_post(cfg["post"])
        on_fx = [n for n in postprocess.ORDER if post_cfg[n]["on"]]
        if on_fx:
            print(f"[RedNode Workspace] post chain: {', '.join(on_fx)}", flush=True)
        vram_report(cfg, tabs, post_cfg)
        why = rerun_reasons(cfg)
        if why:
            print("[RedNode Workspace] this node re-runs every queue because "
                  + "; ".join(why) + ". A rolled image is a different picture, so its "
                  "caption is made again.", flush=True)

        # the built-in Prompt Converter, applied to the i2i prompt: gender and style
        # tables, the NSFW swaps, custom rules and the mood-authority lock, exactly the
        # standalone node's pipeline
        for tab_name in CONVERTER_TABS:
            conv = tabs[tab_name].get("conv") or {}
            if not (prompts.get(tab_name) and conv):
                continue
            before = prompts[tab_name]
            prompts[tab_name] = convert_text(
                before, gender_swap=conv["gender"], style_convert=conv["style"],
                nsfw_act_swap=conv["act"], nsfw_remove_cum=conv["remove_cum"],
                nsfw_shave_pubic=conv["shave"], custom_rules=conv["rules"],
                lock_to_authority=conv["lock"],
                style_authority=prompts.get("moodboard", ""),
                lock_lighting=conv["lock_lighting"])
            if prompts[tab_name] != before:
                print(f"[RedNode Workspace] converter reworked the {tab_name} prompt",
                      flush=True)

        if cfg["auto"]["wd14_unload"] and any_engines:
            autoprompt.wd14_release()
            # and hand the freed space back BEFORE the studio encode and sampler run,
            # or they inherit a fragmented pool from captioners that already left
            autoprompt.free_vram()

        if any(prompts.values()):
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "rednode.workspace_prompts", {"node": unique_id, "prompts": prompts})
            except Exception:
                pass

        rolled = {name: tabs[name]["images"][i] for name, i in picks.items()
                  if name in tabs and tabs[name]["random"] and tabs[name]["on"]
                  and tabs[name]["images"]}
        if "latent" in picks:
            rolled["latent"] = picks["latent"]
        if rolled:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "rednode.workspace_picked", {"node": unique_id, "picks": rolled})
            except Exception:
                pass
            print("[RedNode Workspace] rolled: "
                  + ", ".join(f"{k} -> {v}" for k, v in rolled.items()), flush=True)

        # like style_strength: the studio preset is the studio's own widget, so it rides
        # the bundle only when chosen here, and the studio announces the override
        studio_preset = cfg["studio_preset"] or None

        workspace = {
            "subject_image": subject, "scene_image": scene, "moodboard_style": mood,
            "extra_subjects": extra, "subject_boost_mask": boost, "edit_mask": edit,
            "settings": settings, "output_latent": latent, "style_strength": style_strength,
            "preset": studio_preset,
            "subject_prompt": prompts["subject"], "scene_prompt": prompts["scene"],
            "moodboard_prompt": prompts["moodboard"],
            "i2i_image": i2i_img, "i2i_prompt": prompts["i2i"],
            "denoise": denoise_out, "post": post_cfg,
            "lora_keywords": lora_words, "clip": lora_clip,
            # The Models tab's rig rides the bundle so Paint Out can hand model, CLIP
            # and VAE to an external chain without a loader in sight. The model here
            # is the LoRA-applied one, the same object the model output carries.
            "rig": {"name": rig_name, "model": model, "clip": lora_clip,
                    "vae": rig_vae},
        }
        # THE STUDIO, FOLDED IN. Krea2RedNode's encode consumes the workspace bundle,
        # which is where the auto prompt captions already live, so the caption
        # out-and-back wiring is not needed: encoding HERE is what injects them. The
        # standalone Studio node stays for classic graphs; direct wires there still
        # win because the bundle rules are unchanged. The prompt is the Prompts tab's
        # row for the active rig, typed text first as always.
        positive = negative = rig_image = result_latent_out = None
        _prow = prompt_row_for(cfg["models"], cfg["prompts"])
        _mode = cfg["models"]["sampler_mode"]
        # THE MODEL DECIDES THE ENCODE, the same rule the reference toggles follow:
        # a krea2 CLIP type gets the Studio identity system, refs and all; any other
        # rig gets core's plain text encode, because feeding an XL clip into the
        # Krea 2 encoder is a hard error about a model nobody chose.
        _rigs_now = cfg["models"]["rigs"]
        _rig_is_krea2 = (not _rigs_now
                         or _rigs_now[cfg["models"]["active"]].get("clip_type")
                         == "krea2")
        if clip is not None and (_mode == "internal"
                                 or (_prow or {}).get("text", "").strip()):
            try:
                _enc_clip = lora_clip if lora_clip is not None else clip
                if _rig_is_krea2:
                    from .rednode import Krea2RedNode
                    positive, negative = Krea2RedNode().encode(
                        _enc_clip,
                        (_prow or {}).get("text", ""),
                        studio_preset or CUSTOM_SENTINEL,
                        style_strength if style_strength is not None else 0.5,
                        negative_prompt=(_prow or {}).get("negative", ""),
                        vae=vae if vae is not None else rig_vae,
                        workspace=workspace)
                else:
                    import nodes as _core_enc
                    positive = _core_enc.CLIPTextEncode().encode(
                        _enc_clip, (_prow or {}).get("text", ""))[0]
                    negative = _core_enc.CLIPTextEncode().encode(
                        _enc_clip, (_prow or {}).get("negative", ""))[0]
                    print("[RedNode Workspace] plain text encode for %r: not a "
                          "Krea 2 rig, so the Studio identity system sits out"
                          % (rig_name or "this rig"), flush=True)
            except Exception as exc:
                print("[RedNode Workspace] built-in encode failed: %s" % exc,
                      flush=True)
        # THE EMBEDDED SAMPLER: comfy core's common_ksampler with this rig's five
        # settings, then the VAE decode, so the whole render is one node and an
        # image output. A latent from the tabs (i2i, edit) keeps its denoise; a
        # fresh canvas samples at 1.0 from an empty Krea 2 latent (16 channel).
        # NEVER ON A PAINT RUN: a paint Generate queues this node with a run token,
        # and rendering a whole fresh image underneath the paint pass is exactly
        # the "ignores everything I painted" the user reported. A paint run paints.
        # the active rig's prompt row as PLAIN TEXT for the two appended string
        # sockets: what an external renderer (the NovelAI chain) reads instead
        # of conditioning. Wildcards roll on this run's seed, same as the
        # folded encode, so both sides of a hybrid chain see the same prompt.
        prompt_text_out = ""
        negative_text_out = ""
        _prow0 = prompt_row_for(cfg["models"], cfg["prompts"], "")
        if _prow0 is not None:
            prompt_text_out = _prow0["text"]
            negative_text_out = str(_prow0.get("negative") or "")
            try:
                from .prompt_frame import expand as _pf_expand0
                prompt_text_out = _pf_expand0(prompt_text_out, run_seed, True)
            except Exception:
                pass

        _prt = str(cfg["paint"].get("run_token") or "")
        # A HANDLED RIG KIND renders here: the registered handler (a personal
        # local/ module, the NovelAI rig) is the engine, and its picture takes
        # the image output exactly as the embedded sampler's would. Everything
        # downstream - Detailer chains, Review, Save - neither knows nor cares.
        _hk = _ar.get("kind")
        if (_mode == "internal" and not _prt and _hk in RIG_KIND_HANDLERS):
            try:
                _himg = RIG_KIND_HANDLERS[_hk](
                    "render", rig=_ar, cfg=cfg, prompt_text=prompt_text_out,
                    negative_text=negative_text_out, seed=int(run_seed),
                    source_image=i2i_img, denoise=denoise_out)
                if _himg is not None:
                    rig_image = _himg
            except Exception as exc:
                print("[RedNode Workspace] the %r rig's handler failed: %s"
                      % (_hk, exc), flush=True)
        if (_mode == "internal" and not _prt and positive is not None
                and model is not None):
            try:
                import nodes as _core
                _seed = run_seed
                _lat = latent
                _dn = denoise_out if latent is not None else 1.0
                # THE IMG2IMG TAB, honoured: with no edit latent, an image on the
                # Img2Img tab is the canvas, encoded here and sampled at the tab's
                # denoise. Without this the embedded sampler started every run from
                # an empty latent and the i2i image was ignored outright.
                if _lat is None and i2i_img is not None:
                    _v0 = vae if vae is not None else rig_vae
                    if _v0 is not None:
                        _lat = {"samples": _v0.encode(i2i_img[:, :, :, :3])}
                        _dn = denoise_out
                        print("[RedNode Workspace] built-in sampler: img2img from "
                              "the Img2Img tab at denoise %.2f" % _dn, flush=True)
                    else:
                        print("[RedNode Workspace] the Img2Img tab has an image but "
                              "no VAE is wired or on the rig, so it cannot be "
                              "encoded; sampling a fresh canvas instead", flush=True)
                if _lat is None:
                    _lc = cfg["latent"]
                    _lat = {"samples": torch.zeros(
                        [_lc["batch"], 16, _lc["h"] // 8, _lc["w"] // 8])}
                print("[RedNode Workspace] built-in sampler: seed %d, %d steps, "
                      "cfg %.1f, %s/%s, denoise %.2f" % (
                          _seed, rig_steps, rig_cfg, rig_sampler, rig_scheduler,
                          _dn), flush=True)
                # PASSES, the Paint tab's iteration on the i2i chain: each pass
                # samples the previous pass's latent at the same denoise with a
                # fresh seed, which adds detail while the low denoise holds the
                # shape. Only a real i2i run iterates; a fresh canvas or an edit
                # latent runs once, passes or no passes.
                _i2i_run = (real_i2i
                            or (it["on"] and not it["prompt_only"]
                                and it["canvas"] == "latent"
                                and latent_in is not None))
                _npass = int(it.get("passes", 1)) if _i2i_run else 1
                _out = _lat
                for _p in range(max(1, _npass)):
                    if _npass > 1:
                        print("[RedNode Workspace] i2i pass %d of %d, denoise "
                              "%.2f" % (_p + 1, _npass, _dn), flush=True)
                    _out = _core.common_ksampler(
                        model, _seed + _p, rig_steps, rig_cfg, rig_sampler,
                        rig_scheduler, positive, negative, _out,
                        denoise=_dn)[0]
                result_latent_out = _out
                _v = vae if vae is not None else rig_vae
                if _v is None:
                    print("[RedNode Workspace] built-in sampler rendered, but no "
                          "VAE is wired or named on the rig, so there is no image "
                          "to decode.", flush=True)
                else:
                    rig_image = _v.decode(_out["samples"])
                    while rig_image.ndim > 4:
                        rig_image = rig_image[0]
            except Exception as exc:
                print("[RedNode Workspace] built-in sampler failed: %s" % exc,
                      flush=True)

        # THE BUILT-IN PAINT DOOR. When Generate chose a rig as the model choice, it
        # queued THIS node with a run token stamped into the config copy. The pass
        # runs on the routed paint model (paint stack overriding main, as agreed)
        # with the folded Studio's conditioning, which is the identity clip system
        # the user was missing: refs, edit masks and all, exactly what the classic
        # Paint Render wiring carried, with no render node on the canvas.
        ui_extra = None
        if _prt:
            try:
                from .paint_render import RedNodePaintRender
                _pseed = run_seed
                _n_stack = len([x for x in
                                (pls["slots"] if paint_mode == "paint"
                                 else cfg["loras"]["slots"])
                                if isinstance(x, dict) and x.get("type") != "title"])
                print("[RedNode Workspace] built-in paint pass: %s stack, %d LoRA "
                      "slot(s) on the model going in" % (paint_mode, _n_stack),
                      flush=True)
                _pr = RedNodePaintRender().render(
                    model=paint_model if paint_model is not None else model,
                    positive=positive, negative=negative,
                    vae=vae if vae is not None else rig_vae,
                    seed=_pseed, steps=rig_steps, cfg=rig_cfg,
                    sampler_name=rig_sampler, scheduler=rig_scheduler,
                    run_token=_prt, clip=paint_clip,
                    prompt=prompt, unique_id=unique_id)
                if isinstance(_pr, dict) and isinstance(_pr.get("ui"), dict):
                    # a PRIVATE key on purpose: core draws a ui "images" list as a
                    # giant preview under the node, and under a full panel that is a
                    # second copy of the picture. The result pane reads this key off
                    # the executed event; core's preview system has never heard of it.
                    ui_extra = {"rn_paint_images": _pr["ui"].get("images") or []}
                print("[RedNode Workspace] built-in paint pass rendered with rig %r"
                      % (rig_name or "(none)"), flush=True)
            except Exception as exc:
                print("[RedNode Workspace] built-in paint pass failed: %s" % exc,
                      flush=True)

        _result = (workspace, subject, scene, mood, extra, boost, edit, settings, latent,
                style_strength if style_strength is not None else 0.5,
                studio_preset or "",
                prompts["subject"], prompts["scene"], prompts["moodboard"],
                i2i_img, prompts["i2i"], denoise_out, post_cfg, model, lora_words,
                lora_clip,
                # APPENDED, so no existing link index moves. The Paint tab's prompt as
                # a plain string, so it can be routed like any other: joined with the
                # LoRA keywords, sent through a studio node, and the result wired back
                # into the render node's override inputs. Without this the paint prompt
                # could only ever be encoded inside the render node.
                str(cfg["paint"].get("prompt") or ""),
                # APPENDED: the paint branch's model. Wire it into Paint Render to give
                # the paint pass its own LoRAs; on the default routing it is the same
                # model the model output carries, so old graphs lose nothing.
                paint_model,
                # APPENDED: the Models tab's VAE, None until a rig names one. The tab
                # loads it; this socket is how the rest of the graph takes it.
                rig_vae,
                # APPENDED: the active rig's sampler settings, so a stock KSampler
                # wired to these five needs no Sampler Config and no channels.
                rig_steps, rig_cfg, rig_sampler, rig_scheduler, rig_detailer,
                # APPENDED: the folded-in Studio's conditioning, and the embedded
                # sampler's picture. The whole classic chain, one node. The two
                # render products block when nothing rendered (paint run,
                # external mode), so a core PreviewImage skips instead of dying;
                # the other None sockets stay None because there None means
                # "unset", not "absent this run".
                positive, negative,
                rig_image if rig_image is not None else blocked(),
                # APPENDED: the embedded sampler's latent before decode, for
                # chaining a same-model workspace with no VAE round trip
                result_latent_out if result_latent_out is not None else blocked(),
                # APPENDED: this run's seed, randomised or pinned per the Models
                # tab. Wire it into an external renderer (the NovelAI chain) so
                # the workspace stays the one cockpit for reproducibility too.
                int(run_seed),
                # APPENDED: the active rig's Prompts-tab row as plain text,
                # wildcards rolled on this run's seed, and its negative. The
                # rest of what an external renderer needs: prompt in, strength
                # off the denoise socket, seed above, numbers on their sockets.
                prompt_text_out, negative_text_out)
        if ui_extra:
            return {"ui": ui_extra, "result": _result}
        return _result


# ---------------------------------------------------------------------------
# HTTP API for the panel (presets live on disk, shared by every workflow)
# ---------------------------------------------------------------------------
def standalone_autoprompt(config_json, tab_name, entry):
    """One tab's caption engines for one image, right now, outside the queue.

    Runs with the exact cache keys a queued run uses, so every part it bakes is
    what the next queue picks up through REUSE. CLIP gen needs the workflow's
    loaded text encoder, which only exists during execution; it is skipped here
    and reported back.
    """
    if tab_name not in ("subject", "scene", "moodboard", "i2i", "paint"):
        raise ValueError(f"the {tab_name!r} tab has no auto prompt")
    cfg = parse_config(config_json)
    a = cfg["paint"]["auto"] if tab_name == "paint" else cfg["tabs"][tab_name]["auto"]
    ga = cfg["auto"]
    skipped = (["CLIP gen (needs the workflow's CLIP; it runs on the next queue)"]
               if a["clipgen"] else [])
    if not (a["ollama"] or a["wd14"] or a["joy"] or a["qwen"]):
        raise ValueError("no engines that can run standalone are on for this tab"
                         + (" (CLIP gen only runs with the queue)"
                            if a["clipgen"] else ""))
    path = _filepath(entry)
    print(f"[RedNode Workspace] standalone auto prompt captioning {entry} "
          f"for {tab_name}", flush=True)
    img_bytes = None
    if a["ollama"]:
        img_bytes = autoprompt.vision_payload(path)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = None
    t_img = (load_image(entry, cfg["resize"])
             if (a["wd14"] or a["joy"] or a["qwen"]) else None)
    prompt = autoprompt.build_prompt(
        a["mode"], image_bytes=img_bytes, image_tensor=t_img,
        wired=(), use_ollama=a["ollama"], use_wd14=a["wd14"],
        use_joy=a["joy"], use_qwen=a["qwen"],
        use_clip=False, clip=None,
        unload_heavy=ga["wd14_unload"],
        combine=a["combine"], max_words=a["length"],
        model=ga["model"], url=ga["url"],
        wd14_model=ga["wd14_model"], threshold=ga["threshold"],
        character_threshold=ga["character_threshold"],
        replace_underscore=ga["replace_underscore"],
        exclude_tags=ga["exclude_tags"],
        ollama_options={"temperature": ga["temperature"], "seed": ga["seed"],
                        "num_ctx": ga["num_ctx"], "num_predict": ga["num_predict"],
                        "top_k": ga["top_k"], "top_p": ga["top_p"]},
        think=ga["think"], keep_alive=ga["keep_alive"],
        frank=ga["frank"],
        joy_opts={"quantization": ga["joy_quant"], "prompt_style": ga["joy_style"],
                  "caption_length": ga["joy_length"], "memory": ga["joy_memory"],
                  "use_mode_prompt": ga["joy_mode_prompts"]},
        instruction=ga["instruction"], question=ga["question"],
        cache_base=[tab_name, entry, mtime, a["mode"], ga["frank"]],
        use_cache=a["fixed"],
        sidecar=(path + ".rn.json") if _managed(entry) else None)
    return {"prompt": prompt, "skipped": skipped}


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/autoprompt_status")
    async def _rednode_autoprompt_status(request):
        url = request.query.get("url") or autoprompt.OLLAMA_URL
        models = autoprompt.ollama_models(url)
        return web.json_response({
            "ollama": bool(models), "models": models,
            "wd14": autoprompt.wd14_available(),
            "wd14_model": autoprompt.wd14_default_model(),
            "wd14_models": autoprompt.wd14_models(),
            "joy": autoprompt.joycaption_available(),
            "qwen": autoprompt.qwenvl_available(),
            "joy_options": autoprompt.joycaption_options(),
            "converter": {"gender": SWAP_MODES, "style": STYLE_MODES, "act": ACT_MODES},
        })

    _standalone_busy = {"on": False}

    @PromptServer.instance.routes.post("/rednode/autoprompt_run")
    async def _rednode_autoprompt_run(request):
        # the heavy engines run in a worker thread so the UI stays alive; one at
        # a time, because two JoyCaption loads at once is a VRAM incident
        if _standalone_busy["on"]:
            return web.json_response(
                {"error": "an auto prompt is already running; wait for it to finish"},
                status=409)
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        _standalone_busy["on"] = True
        try:
            import asyncio
            result = await asyncio.get_event_loop().run_in_executor(
                None, standalone_autoprompt, str(data.get("config") or "{}"),
                str(data.get("tab") or ""), str(data.get("entry") or ""))
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        finally:
            _standalone_busy["on"] = False

    @PromptServer.instance.routes.get("/rednode/image_prompts")
    async def _rednode_image_prompts(request):
        entry = request.query.get("entry") or ""
        if not entry:
            return web.json_response({"error": "no image given"}, status=400)
        try:
            path = _filepath(entry)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=404)
        if not _inside_input(path):
            return web.json_response(
                {"error": "that path is outside the input folder"}, status=403)
        if not _managed(entry):
            # captions are only written beside images in our own folder
            return web.json_response({"parts": {}, "updated": "", "managed": False})
        data = autoprompt.saved_parts(path + ".rn.json")
        data["managed"] = True
        return web.json_response(data)

    @PromptServer.instance.routes.post("/rednode/release_engines")
    async def _rednode_release_engines(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        import asyncio
        done = await asyncio.get_event_loop().run_in_executor(
            None, autoprompt.release_engines, str(data.get("model") or ""),
            str(data.get("url") or autoprompt.OLLAMA_URL))
        return web.json_response({"done": done})

    @PromptServer.instance.routes.get("/rednode/post_presets")
    async def _rednode_post_presets(request):
        presets = postprocess.load_presets()
        name = request.query.get("name")
        if name:
            entry = presets.get(name)
            if not entry:
                return web.json_response({"error": f"no preset named {name!r}"}, status=404)
            return web.json_response({"name": name, "config": entry["config"],
                                      "thumb": entry["thumb"]})
        return web.json_response({
            "presets": [{"name": n, "thumb": e["thumb"]} for n, e in sorted(presets.items())],
            "last_thumb": postprocess.LAST_THUMB["uri"],
            "last_rolls": postprocess.LAST_ROLLS,
        })

    @PromptServer.instance.routes.post("/rednode/post_presets")
    async def _rednode_post_presets_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                # the thumbnail is whatever the last graded run produced, unless the
                # caller sent one; no run yet just means a preset without a picture
                postprocess.save_preset(data.get("name", ""), data.get("config"),
                                        data.get("thumb") or postprocess.LAST_THUMB["uri"])
            elif data.get("action") == "delete":
                postprocess.delete_preset(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        presets = postprocess.load_presets()
        return web.json_response({
            "presets": [{"name": n, "thumb": e["thumb"]} for n, e in sorted(presets.items())],
            "last_thumb": postprocess.LAST_THUMB["uri"],
        })

    @PromptServer.instance.routes.get("/rednode/vision_prompts")
    async def _rednode_vision_prompts(request):
        return web.json_response({"prompts": load_vision_prompts(),
                                  "builtin": sorted(VISION_PROMPTS)})

    @PromptServer.instance.routes.post("/rednode/vision_prompts")
    async def _rednode_vision_prompts_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_vision_prompt(data.get("name", ""), data.get("text", ""))
            elif data.get("action") == "delete":
                delete_vision_prompt(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"prompts": load_vision_prompts(),
                                  "builtin": sorted(VISION_PROMPTS)})

    @PromptServer.instance.routes.get("/rednode/caption_instructions")
    async def _rednode_caption_instructions(request):
        return web.json_response({"prompts": load_caption_instructions(),
                                  "builtin": sorted(CAPTION_INSTRUCTIONS)})

    @PromptServer.instance.routes.post("/rednode/caption_instructions")
    async def _rednode_caption_instructions_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_caption_instruction(data.get("name", ""), data.get("text", ""),
                                         data.get("question", ""))
            elif data.get("action") == "delete":
                delete_caption_instruction(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"prompts": load_caption_instructions(),
                                  "builtin": sorted(CAPTION_INSTRUCTIONS)})

    @PromptServer.instance.routes.get("/rednode/workspace_presets")
    async def _rednode_workspace_presets(request):
        name = request.query.get("name")
        presets = load_presets()
        if name:
            if name not in presets:
                return web.json_response({"error": "no such preset"}, status=404)
            return web.json_response({"name": name, "config": presets[name]})
        return web.json_response({"presets": sorted(presets)})

    @PromptServer.instance.routes.post("/rednode/workspace_presets")
    async def _rednode_workspace_presets_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                save_preset(data.get("name", ""), data.get("config"))
            elif data.get("action") == "delete":
                delete_preset(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"presets": sorted(load_presets())})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] workspace preset HTTP routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {"RedNodeStudioWorkspace": RedNodeStudioWorkspace}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeStudioWorkspace": "RedNode Studio Workspace"}
