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
from .overrides import env as _env
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
from . import sampler_dials as _dials
from .prompt_tools import SWAP_MODES, STYLE_MODES, ACT_MODES, convert_text

WORKSPACE_TYPE = "KREA2_WORKSPACE"
RIG_TYPE = "RN_RIG"                 # a RedNode Rig Model's record (custom_rig.py)
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
    """Why this node cannot be cached between queues, in your own terms.

    A node that re-runs every time re-captions every time, and from the console
    that just looks like the caption cache failing. These are the switches that
    cause it, so the answer is on screen instead of being guesswork.
    """
    why = []
    for name in IMAGE_TABS:
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
    for name in AUTO_TABS:
        a = tabs.get(name, {}).get("auto") or {}
        if not (a.get("on") and tabs[name].get("on")):
            continue
        for eng, key in (("Ollama", "ollama"), ("WD14", "wd14"), ("JoyCaption", "joy"),
                         ("QwenVL", "qwen")):
            if a.get(key) and eng not in engines:
                engines.append(eng)
    if engines:
        heavy.append(f"{', '.join(engines)} each load a model to caption")
    post_on = sorted(postprocess.active_fx(post_cfg))
    if any(n in postprocess.DEPTH_EFFECTS for n in post_on):
        heavy.append("depth of field / haze load a depth estimator")
    if d.get("boosts_off"):
        # the master off switch holds both fidelity dials at 1.0 or below downstream;
        # a pull above 1 never happens, a loosened one still builds the matrix
        if all(d.get(k, 1.0) >= 1.0 for k in ("reference_fidelity", "scene_fidelity")):
            heavy = [x for x in heavy if "bias matrix" not in x]
            heavy.insert(0, "boosts off: no attention bias matrix is built")
        else:
            heavy.insert(0, "boosts off: no extra pull, but a fidelity below 1.0 still "
                            "builds the bias matrix to loosen it")
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
    """A panel upload: under the managed subfolder by name AND by where it resolves,
    so "rednode/../x" is not one."""
    if not str(entry).replace("\\", "/").startswith(MANAGED_SUBFOLDER + "/"):
        return False
    bare, base = _entry_base(entry)
    return _inside_dir(os.path.join(base, MANAGED_SUBFOLDER), base) \
        and _inside_dir(os.path.join(base, bare), os.path.join(base, MANAGED_SUBFOLDER))

# every key the Settings dict carries, at the Settings node's own defaults — the studio
# indexes some of these unconditionally, so the workspace must always send a full dict
SETTINGS_DEFAULTS = dict(
    transfer="style", reference_processing="full image", style_directive=True,
    hide_style_refs=True, style_detail_px=384, likeness_vs_obedience=768,
    reference_fidelity=2.5, scene_fidelity=1.0, fit_mode="fit",
    identity_start=0.0, identity_end=1.0, isolate_refs=False, boost_blocks="all",
    scene_start=0.0, scene_end=1.0,
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
    "scene_start": (0.0, 1.0),
    "scene_end": (0.0, 1.0),
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
    override = _env("KREA2RN_CAPTION_INSTRUCTIONS")
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
    """Shipped instructions plus your saved ones; shipped names always win.
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
    override = _env("KREA2RN_VISION_PROMPTS")
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

# THE WORKSPACE'S OWN STAGE TAPS: the moments it can photograph for the Stage View,
# in the order they happen. Off unless switched on (the STAGES sub-tab).
# the moments a run can photograph for the Stages strip, in the order they happen
TAP_POINTS = ("refs", "source", "editor", "reangle", "realism", "swap", "render",
              "passes", "post", "final")
# the list a workflow saved before the Editor, Realism, Render and Post points existed
# carries: it meant "everything", so it still does
_OLD_TAP_ALL = ("refs", "source", "reangle", "swap", "passes", "final")
TAP_PX = (320, 512, 768, 1024, 1536, 0)

# the tab names the Run tab's log uses
RUN_TAB_NAMES = {"subject": "Subject", "scene": "Scene", "moodboard": "Moodboard",
                 "i2i": "Img2Img", "text_style": "Image to text Style",
                 "text_subject": "Image to text Subject", "text_scene": "Image to text Scene"}

# IMAGE TO TEXT, under Img2Img's Auto prompt: galleries that are only ever captioned.
# Their pictures never reach the model, so they work on any rig.
TEXT_TABS = ("text_style", "text_subject", "text_scene")
# swap_ref: the Swap page's own gallery, read only when Swap's reference is "own"
# editor_src: the Editor tab's source, what Re-angle, Realism and Swap edit
# ai: the AI tab's own gallery, for captioning a picture without turning anything on
IMAGE_TABS = ("i2i", "subject", "subject2", "subject3", "scene", "moodboard",
              "swap_ref", "editor_src", "ai") + TEXT_TABS
# the tabs with an auto prompt, and the ones whose selection is a list
AUTO_TABS = ("subject", "scene", "moodboard", "i2i", "ai") + TEXT_TABS
# Inject into, stored as "follow the rig": the caption joins whichever row this
# rig renders, so switching rigs moves it with them instead of leaving it aimed
# at another rig's words. The panel writes this; prompt_row_for resolves it.
AUTO_ROW = "(auto)"
MULTI_TABS = ("moodboard",) + TEXT_TABS


def _presets_path(make=False):
    override = _env("KREA2RN_WORKSPACE_PRESETS")
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


# What a Moodboard picture gives its auto prompt, any mix of the three, captioned
# one read at a time and joined in this order
MOOD_READS = ("style", "subject", "scene_action")
# the Frame slots an auto prompt can join, and where each Moodboard read goes unless
# told otherwise
INJECT_SLOTS = ("style", "subject", "surroundings", "light_and_colour", "prompt")
MOOD_SLOT_DEFAULTS = {"style": "style", "subject": "subject", "scene_action": "surroundings"}


def mood_reads(meta, default="style"):
    """A Moodboard picture's reads; a picture never set takes the tab's mode."""
    r = meta.get("reads") if isinstance(meta, dict) else None
    if isinstance(r, list):
        return [m for m in MOOD_READS if m in r]
    return [default if default in MOOD_READS else "style"]


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
        "florence": bool(auto_in.get("florence")),
        "length": max(0, min(300, int(auto_in.get("length", 0))))
                  if isinstance(auto_in.get("length"), (int, float)) else 0,
        # fixed (default): the same image reuses the cached prompt. Unfixed
        # re-runs the LLM every queue for fresh wording each run.
        "fixed": bool(auto_in.get("fixed", True)),
        # the Subject tab's: rewrite the prompt row with the named people's captions
        "rewrite": bool(auto_in.get("rewrite")),
        # Injection: this tab's caption lands in a named Prompts-tab row, into one
        # Frame slot, automatically at queue time. Empty = the caption only rides
        # its own output socket, exactly as before.
        "inject_row": str(auto_in.get("inject_row") or ""),
        # before or after the words already typed in that slot
        "inject_pos": "before" if auto_in.get("inject_pos") == "before" else "after",
        "inject_slot": (str(auto_in.get("inject_slot"))
                        if auto_in.get("inject_slot") in INJECT_SLOTS
                        else "subject"),
        # the Moodboard's: each read joins its own Frame slot
        "inject_slots": {
            m: (str((auto_in.get("inject_slots") or {}).get(m))
                if isinstance(auto_in.get("inject_slots"), dict)
                and (auto_in.get("inject_slots") or {}).get(m) in INJECT_SLOTS
                else MOOD_SLOT_DEFAULTS[m])
            for m in MOOD_READS},
    }


def _file_gb(folders, name):
    """A model file's size in GB, looked up in the first folder that has it."""
    if not name:
        return 0.0
    try:
        import folder_paths
    except Exception:
        return 0.0
    for f in folders:
        try:
            p = folder_paths.get_full_path(f, name)
        except Exception:
            p = None
        if p and os.path.isfile(p):
            return os.path.getsize(p) / 1024 ** 3
    return 0.0


def _vosr2_gb(bundle):
    """A VOSR 2.0 bundle's size in GB. It is a FOLDER (DiT + Qwen VAE + DINOv2),
    not a single file, so _file_gb cannot see it. Falls back to the measured
    size of the one published bundle when the folder is not on disk yet, since
    the pass would download it on first run rather than fail."""
    try:
        import folder_paths
        root = os.path.join(folder_paths.models_dir, "vosr2", bundle or "VOSR2")
        if os.path.isdir(root):
            total = 0
            for dirpath, dirnames, names in os.walk(root):
                if ".cache" in dirpath:
                    continue
                for n in names:
                    try:
                        total += os.path.getsize(os.path.join(dirpath, n))
                    except OSError:
                        pass
            if total:
                return total / 1024 ** 3
    except Exception:
        pass
    return 6.5


# THE PASS KINDS THAT LOAD NO RIG: their own loaders do the loading, so the
# rig on the card is not their cost. Both upscalers, and the estimate and the
# run must agree on the set (refine_pipeline.UPSCALERS is the run's copy).
UPSCALE_KINDS = ("upscale", "vosr2")

# rough working memory for a diffusion transformer at batch 1, per megapixel sampled
WORK_GB_PER_MP = 1.8
# the Qwen edit model (Swap, Re-angle) per megapixel of each picture it reads
EDIT_WORK_GB_PER_MP = 3.0

# the widgets a loader names its file in, per socket of a RedNode Rig Model node
RIG_FILE_KEYS = {
    "model": ("unet_name", "ckpt_name"),
    "clip": ("clip_name", "clip_name1", "clip_name2", "clip_name3", "ckpt_name"),
    "vae": ("vae_name", "ckpt_name"),
}


def _add_rig_file(rec, key, value):
    if key == "ckpt_name":
        rec["checkpoint"] = value
    elif key == "unet_name":
        rec.setdefault("unet", value)
    elif key == "vae_name":
        rec.setdefault("vae", value)
    elif value not in rec.setdefault("clips", []):
        rec["clips"].append(value)


def graph_rig_files(prompt):
    """{rig name: {unet, checkpoint, clips, vae}} for "Your own nodes" rigs: the
    files named by the loaders wired into each RedNode Rig Model node. The Models
    tab holds no file names for such a rig, so its size was invisible."""
    out = {}
    if not isinstance(prompt, dict):
        return out
    for n in prompt.values():
        if not isinstance(n, dict) or n.get("class_type") != "RedNodeRigModel":
            continue
        ins = n.get("inputs") or {}
        rig = (ins.get("rig").strip() if isinstance(ins.get("rig"), str) else "") or "My rig"
        rec = out.setdefault(rig, {})
        for sock, keys in RIG_FILE_KEYS.items():
            queue, seen = [ins.get(sock)], set()
            while queue and len(seen) < 40:
                link = queue.pop(0)
                if not (isinstance(link, list) and len(link) == 2):
                    continue
                nid = str(link[0])
                up = prompt.get(nid)
                if nid in seen or not isinstance(up, dict):
                    continue
                seen.add(nid)
                uin = up.get("inputs") or {}
                hits = [(k, uin[k]) for k in keys if isinstance(uin.get(k), str) and uin[k]]
                if hits:
                    for k, v in hits:
                        _add_rig_file(rec, k, v)
                    continue
                queue.extend(v for v in uin.values() if isinstance(v, list))
    return out


def _edit_stage(cfg, render_px, render_batch, i2i_run):
    """(name, parts, total GB, working GB) for the Qwen edit engine when Swap or
    Re-angle will run, else None. It loads after or before the render, so the
    run's peak is the larger of the two stages, not their sum."""
    it = cfg["tabs"]["i2i"]
    sw = it.get("swap") or {}
    ra = it.get("reangle") or {}
    src_px = float(cfg["resize"] or 1024) ** 2 * 0.75
    jobs = []
    # a stage on the render runs whatever the pass mode; a source stage needs the
    # pass (i2i_run already says no under Prompt only)
    if ra.get("on"):
        if ra.get("target") == "render":
            jobs.append(("Re-angle", ra, render_px, render_batch, 1))
        elif i2i_run:
            jobs.append(("Re-angle", ra, src_px, 1, 1))
    if sw.get("on"):
        if sw.get("target") == "render":
            jobs.append(("Swap", sw, render_px, render_batch, 2))
        elif i2i_run:
            jobs.append(("Swap", sw, src_px, 1, 2))
    if not jobs:
        return None
    best = None
    for name, sc, px, batch, pics in jobs:
        parts = []
        for label, folders, key in (
                ("Edit model", ("diffusion_models", "unet", "unet_gguf"), "unet"),
                ("Edit text encoder", ("text_encoders", "clip"), "clip"),
                ("Edit VAE", ("vae",), "vae")):
            g = _file_gb(folders, sc.get(key))
            if g:
                parts.append(["%s (%s)" % (label, name), round(g, 1)])
        work = EDIT_WORK_GB_PER_MP * (px / 1e6) * pics * batch
        parts.append(["Edit working memory (%s, %.1f MP, %d pictures%s)"
                      % (name, px / 1e6, pics, ", batch of %d" % batch if batch > 1 else ""),
                      round(work, 1)])
        total = sum(g for _n, g in parts)
        if best is None or total > best[2]:
            best = (name, parts, total, work)
    return best


def vae_images(t):
    """A decode as IMAGE [N, H, W, C]. A video VAE (Krea 2's Wan) hands back
    [batch, frames, H, W, C]; taking [0] kept the first picture of a batch."""
    if t.ndim > 4:
        t = t.reshape((-1,) + tuple(t.shape[-3:]))
    # an RGBA VAE (Qwen Image 2.1) decodes four channels; every stage after the
    # decode blends and saves RGB, so the alpha stops here
    if t.ndim == 4 and t.shape[-1] > 3:
        t = t[..., :3]
    return t


def estimate_vram(cfg, rig_files=None):
    """{"peak": GB, "need": GB, "parts": [[name, GB], ...], "work": GB,
    "stages": [[name, GB]]} for the Workspace's own run, from the model files it
    will load and the size it works at. "peak" is everything resident at once;
    "need" is what cannot leave the card while a stage samples (vram_hold.decide). Rough on purpose: it decides whether Auto holds, and it is shown so
    the number is not a mystery. `rig_files` names the files of "Your own nodes"
    rigs (graph_rig_files). None when the Workspace does not render (external
    sampler, no rig)."""
    rig_files = rig_files if isinstance(rig_files, dict) else {}
    M = cfg["models"]
    rigs = M.get("rigs") or []
    if not rigs or M.get("sampler_mode") != "internal":
        return None
    active = rigs[min(M.get("active", 0), len(rigs) - 1)]
    tabs = cfg["tabs"]
    it = tabs["i2i"]
    i2i_run = it["on"] and not it["prompt_only"] and (it["images"] or it["canvas"] != "gallery")
    run = it if i2i_run else cfg["latent"]
    names = [active["name"]] + [n for n in (run.get("pass_rig") or []) if n] \
        if run.get("rig_custom") else [active["name"]]
    used = [r for r in rigs if r["name"] in names] or [active]

    def files(r):
        # a rig of your own nodes names its files in the workflow, not on the tab
        if r.get("kind") == "node":
            got = rig_files.get(str(r.get("node") or r.get("name") or "").strip()) or {}
            return {"unet": got.get("unet") or r.get("unet"),
                    "checkpoint": got.get("checkpoint") or r.get("checkpoint"),
                    "clips": got.get("clips") or ([r["clip"]] if r.get("clip") else []),
                    "vae": got.get("vae") or r.get("vae")}
        return {"unet": r.get("unet"), "checkpoint": r.get("checkpoint"),
                "clips": [r["clip"]] if r.get("clip") else [], "vae": r.get("vae")}

    def model_gb(r):
        f = files(r)
        return (_file_gb(("diffusion_models", "unet", "unet_gguf"), f["unet"])
                or _file_gb(("checkpoints",), f["checkpoint"]))

    parts = []
    mg = max((model_gb(r), r["name"]) for r in used)
    if mg[0]:
        parts.append(["Model (%s)" % mg[1], round(mg[0], 1)])
    af = files(active)
    te = sum(_file_gb(("text_encoders", "clip", "clip_gguf"), c) for c in af["clips"])
    if te:
        parts.append(["Text encoder", round(te, 1)])
    vae = _file_gb(("vae",), af["vae"])
    if vae:
        parts.append(["VAE", round(vae, 1)])
    # the size it works at: the Latent tab's canvas, or the resize for a source
    if i2i_run:
        edge = cfg["resize"] or 1024
        px = edge * edge * 0.75
    else:
        px = cfg["latent"]["w"] * cfg["latent"]["h"]
    scales = [float(x) for x in (run.get("pass_scale") or []) if x] \
        if run.get("scale_custom") else [float(run.get("scale") or 1.0)]
    px *= max([1.0] + scales) ** 2
    batch = max(1, int(cfg["latent"].get("batch") or 1)) if not i2i_run else 1
    krea2 = active.get("clip_type") == "krea2"
    nrefs = 0
    if krea2:
        nrefs = sum(1 for n in ("subject", "scene")
                    if tabs[n]["on"] and tabs[n]["images"]
                    and not (n == "scene" and tabs[n].get("words_only")))
        nrefs += len(tabs["subject"].get("extra_sel") or [])
    work = WORK_GB_PER_MP * (px / 1e6) * batch * (1 + 0.5 * nrefs)
    parts.append(["Working memory (%.1f MP%s%s)"
                  % (px / 1e6, ", batch of %d" % batch if batch > 1 else "",
                     ", %d refs" % nrefs if nrefs else ""), round(work, 1)])
    d = cfg["dials"]
    boosted = krea2 and nrefs and cfg.get("use_dials") and any(
        abs(float(d.get(k, 1.0)) - 1.0) > 1e-6 for k in ("reference_fidelity", "scene_fidelity"))
    if boosted:
        tokens = px / 256 * (1 + nrefs)
        parts.append(["Fidelity boost matrix", round(tokens * tokens * 4 / 1024 ** 3, 1)])
    render = round(sum(g for _n, g in parts), 1)
    render_work = sum(g for n, g in parts if "Working memory" in n or "boost matrix" in n)

    def need_of(stage_parts, total):
        # WHAT CANNOT LEAVE THE CARD while the stage samples. The text encoder has
        # done its work by then, SAM3 has found its target and the upscale model has
        # grown the frame: ComfyUI drops all three by itself when the card fills, so
        # they are in "peak" (everything resident) and not in "need". A pass on the
        # rig already on the card carries that rig's text encoder inside one part.
        drop = sum(g for n, g in stage_parts
                   if str(n).startswith(("Text encoder", "Edit text encoder", "SAM3",
                                         "Upscale model")))
        if any(str(n).startswith("Rig on the card") for n, _g in stage_parts):
            drop += te
        return round(max(0.0, total - drop), 1)

    out = {"peak": render, "parts": parts, "work": round(render_work, 1),
           "need": need_of(parts, render), "stages": [["Render", render]]}

    def rig_cost(name):
        # (model, text encoder, VAE) in GB for a rig named on a Detailer pass
        r = next((x for x in rigs if x.get("name") == name), None)
        if not r:
            return (0.0, 0.0, 0.0)
        f = files(r)
        return (model_gb(r),
                sum(_file_gb(("text_encoders", "clip", "clip_gguf"), c) for c in f["clips"]),
                _file_gb(("vae",), f["vae"]))
    # the stages after the render, each its own peak: the edit engine for a
    # Swap or Re-angle, and the Detailer's passes with their own loads
    later = [_edit_stage(cfg, px, batch, i2i_run),
             _detailer_stage(cfg, (mg[0] or 0.0) + te + vae, px, rig_cost)]
    for st in later:
        if not st:
            continue
        name, eparts, etotal, ework = st
        out["parts"] = out["parts"] + eparts
        out["stages"].append([name, round(etotal, 1)])
        out["peak"] = round(max(out["peak"], etotal), 1)
        out["work"] = round(max(out["work"], ework), 1)
        out["need"] = round(max(out["need"], need_of(eparts, etotal)), 1)
    return out


def _detailer_stage(cfg, base_gb, render_px, rig_cost=None):
    """(name, parts, total GB, working GB) for the Detailer's passes when the
    Workspace runs them, else None. Each pass is costed on its own and the
    heaviest wins, since they run one after another. A pass keeps the rig's
    model, text encoder and VAE on the card (base_gb) unless it frees VRAM
    first; on top of that a detailer pass loads the SAM3 checkpoint, a tiled
    pass its upscale model, and a SeedVR2 pass its DiT and VAE plus working
    memory at the size it writes, which is where a 4K pass becomes the run's
    real peak. A pass on ANOTHER rig loads that rig's files as well, on top of
    the main rig still on the card, which is how two models end up resident at
    once; rig_cost(name) gives (model, text encoder, VAE) in GB for a rig."""
    if not cfg.get("detailer_on"):
        return None
    raw = cfg.get("detailer") if isinstance(cfg.get("detailer"), dict) else {}
    stages = [s for s in (raw.get("stages") or []) if isinstance(s, dict)
              and s.get("on", True)
              and s.get("type") in ("sampler", "detailer", "upscale", "usdu", "vosr2",
                                    "realism")]
    if not stages:
        return None
    from .refine_pipeline import UPSCALE_SIZES
    best = None
    for i, s in enumerate(stages):
        kind = s.get("type")
        label = {"sampler": "Sampler pass", "detailer": "Detailer pass",
                 "upscale": "SeedVR2 pass", "usdu": "Tiled upscale",
                 "vosr2": "VOSR2 pass", "realism": "Realism pass"}[kind]
        parts = []
        other = str(s.get("rig") or "").strip()
        active_name = str((cfg["models"].get("rigs") or [{}])[min(cfg["models"].get("active", 0),
                          max(0, len(cfg["models"].get("rigs") or []) - 1))].get("name") or "")
        if other and other != active_name and rig_cost and kind not in UPSCALE_KINDS:
            # A PASS ON ANOTHER RIG NEEDS THAT RIG, NOT BOTH. ComfyUI evicts the
            # main model when this one wants the room, so the two are never
            # summed; counting them together read tens of GB over anything the
            # chart ever showed.
            om, ot, ov = rig_cost(other)
            if om:
                parts.append(["Model (%s, %s %d)" % (other, label, i + 1), round(om, 1)])
            if ot:
                parts.append(["Text encoder (%s, %s %d)" % (other, label, i + 1), round(ot, 1)])
            if ov:
                parts.append(["VAE (%s, %s %d)" % (other, label, i + 1), round(ov, 1)])
        elif kind not in UPSCALE_KINDS and not s.get("free_vram"):
            parts.append(["Rig on the card (%s %d)" % (label, i + 1), round(base_gb, 1)])
        if kind == "detailer":
            g = _file_gb(("sam3",), str(s.get("sam_model") or "sam3.pt"))
            if g:
                parts.append(["SAM3 (%s %d)" % (label, i + 1), round(g, 1)])
        if kind == "usdu":
            g = _file_gb(("upscale_models",), str(s.get("usdu_model") or ""))
            if g:
                parts.append(["Upscale model (%s %d)" % (label, i + 1), round(g, 1)])
        if kind == "upscale":
            g = _file_gb(("seedvr2",), str(s.get("dit_model") or ""))
            if g:
                # blocks swapped to the CPU are not on the card: by default all
                # 36 are, leaving roughly a tenth of the file resident
                try:
                    swapped = max(0, min(36, int(s.get("blocks_to_swap", 36))))
                except (TypeError, ValueError):
                    swapped = 36
                g = g * max(0.1, (36 - swapped) / 36.0)
                parts.append(["SeedVR2 model on the card (%s %d)" % (label, i + 1), round(g, 1)])
            g = _file_gb(("seedvr2",), str(s.get("vae_model") or ""))
            if g:
                parts.append(["SeedVR2 VAE (%s %d)" % (label, i + 1), round(g, 1)])
        if kind == "vosr2":
            # the whole bundle goes to the card: no block swapping to discount,
            # and force_full_load=True in the pack's loader means all of it
            g = _vosr2_gb(str(s.get("vosr2_model") or ""))
            if g:
                parts.append(["VOSR2 bundle (%s %d)" % (label, i + 1), round(g, 1)])
        # the size the pass works at: SeedVR2 writes its target size; a tiled
        # pass one tile at a time; a sampler or detailer pass its crop or the
        # picture as it arrives, grown by the pass's scale
        if kind == "upscale":
            px = float(UPSCALE_SIZES.get(str(s.get("size") or "1080p"), UPSCALE_SIZES["1080p"]))
            if s.get("tiled", True) is not False:
                # tiled encode and decode: a tile at a time, never the frame
                try:
                    tile = max(64, min(4096, int(s.get("tile", 1024))))
                except (TypeError, ValueError):
                    tile = 1024
                px = min(px, float(tile * tile))
        elif kind == "vosr2":
            # VOSR2 tiles, which is why its measured peak barely moves between
            # x2 and x4. A tile of 0 means no tiling, and then the cost follows
            # the output, which is not knowable from the config; 1080p stands
            # in for it so the estimate is not silently optimistic.
            try:
                tile = max(0, min(4096, int(s.get("vosr2_tile", 512))))
            except (TypeError, ValueError):
                tile = 512
            px = float(tile * tile) if tile else float(UPSCALE_SIZES["1080p"])
        elif kind == "usdu":
            try:
                tile = max(256, min(2048, int(s.get("usdu_tile", 1024))))
            except (TypeError, ValueError):
                tile = 1024
            px = float(tile * tile)
        else:
            try:
                crop = int(s.get("crop_res") or 0)
            except (TypeError, ValueError):
                crop = 0
            try:
                scale = max(0.25, min(4.0, float(s.get("scale") or 1.0)))
            except (TypeError, ValueError):
                scale = 1.0
            px = float(crop * crop) if crop else float(render_px) * scale * scale
        work = WORK_GB_PER_MP * (px / 1e6)
        parts.append(["Working memory (%s %d, %.1f MP)" % (label, i + 1, px / 1e6), round(work, 1)])
        total = sum(g for _n, g in parts)
        if best is None or total > best[2]:
            best = ("Detailer", parts, total, work)
    return best


def _normalise_taps(raw):
    t = raw if isinstance(raw, dict) else {}
    pts = t.get("points")
    try:
        px = int(t.get("px", 768))
    except (TypeError, ValueError):
        px = 768
    if isinstance(pts, list) and sorted(set(pts)) == sorted(_OLD_TAP_ALL):
        pts = list(TAP_POINTS)
    return {"on": bool(t.get("on")),
            "px": px if px in TAP_PX else 768,
            "points": ([p for p in TAP_POINTS if p in pts] if isinstance(pts, list)
                       else list(TAP_POINTS))}


def _pass_list(raw, on, base, lo, hi, n, first=None):
    """(switch, one value per pass). A short stored list repeats its last value, so
    raising the pass count never moves a number already chosen, and an empty one falls
    back to the single dial above it. `first` is the default for pass 1 where that pass
    is not the same job as the rest, which is the Latent tab: it generates, the others
    refine. Shared by the Img2Img tab and the Latent tab so both read one field either
    way and the sampler loop does not care which tab it came from.

    ONE PASS HAS NOTHING TO VARY, so the list never speaks for it. The panel already
    works this way: at one pass it hides the per-pass cards and shows the single dial,
    while the stored list stays in the workflow for when the count goes back up. The
    server did not, so dropping the Img2Img tab back to one pass left the list's stale
    first value overriding the Denoise bar, and the bar looked dead. The Detailer's
    repeat reads this too, which had the same silent override at a repeat of 1.
    """
    n = max(1, int(n))
    use = n > 1 and bool(on) and isinstance(raw, list) and bool(raw)
    out = []
    for i in range(max(1, int(n))):
        v = base if (i or first is None) else first
        if use:
            try:
                v = float(raw[i] if i < len(raw) else raw[-1])
            except (TypeError, ValueError):
                v = base if (i or first is None) else first
        out.append(max(lo, min(hi, v)))
    return use, out


def _pass_names(raw, on, n):
    """(switch, one rig name per pass): "" means the run's own rig. The same
    repeat rule as _pass_list, and the same single-pass rule: one pass runs on the
    run's own rig, because the panel offers no rig picker until there are two."""
    n = max(1, int(n))
    use = n > 1 and bool(on) and isinstance(raw, list) and bool(raw)
    out = []
    for i in range(max(1, int(n))):
        v = ""
        if use:
            pick = raw[i] if i < len(raw) else raw[-1]
            v = str(pick)[:48] if isinstance(pick, str) else ""
        out.append(v)
    return use, out


def _parse_seeds(raw):
    from .seeds import parse
    return parse(raw)


def _parse_final(raw):
    from .prompt_sort import parse_final
    return parse_final(raw)


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
        if name in MULTI_TABS:
            # the moodboard batches several refs, and Image to text captions every
            # picked picture, so their selection is a list
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
        default_mode = {"scene": "scene_view", "moodboard": "style", "i2i": "i2i",
                        "ai": "i2i", "text_style": "style",
                        "text_scene": "scene_view"}.get(name, "subject")
        tabs[name] = {
            "on": bool(t.get("on", name in ("subject", "scene", "moodboard") + TEXT_TABS)),
            "images": images,
            "sel": sel,
            "mask": str(t.get("mask") or ""),
            "random": bool(t.get("random")),
            "auto": _normalise_auto(t.get("auto"), default_mode),
            # a slot for a personal-only extension's settings on this tab, kept as
            # written; the shipped pack reads nothing in it (2026-09-25)
            "local": t.get("local") if isinstance(t.get("local"), dict) else {},
        }
        if name == "subject":
            # THE OTHER PEOPLE, picked in order in the same gallery: person 2, 3 and on.
            # sel stays the main subject, so everything that reads it is unchanged.
            ex = t.get("extra_sel") if isinstance(t.get("extra_sel"), list) else []
            seen, extra_sel = {sel}, []
            for i in ex:
                if isinstance(i, (int, float)) and 0 <= int(i) < len(images) \
                        and int(i) not in seen:
                    seen.add(int(i))
                    extra_sel.append(int(i))
            tabs[name]["extra_sel"] = extra_sel
            # per picture: the person's name and whether its auto prompt runs
            pm_in = t.get("people_meta") if isinstance(t.get("people_meta"), dict) else {}
            tabs[name]["people_meta"] = {
                str(k): {"name": str((v or {}).get("name") or "").strip()[:40],
                         "auto": (bool(v.get("auto")) if isinstance(v, dict) and "auto" in v
                                  else None)}
                for k, v in pm_in.items() if isinstance(v, dict)}
        if name == "swap_ref":
            tabs[name]["on"] = True          # Swap's own switch decides; this has none
        if name == "editor_src":
            tabs[name]["on"] = True          # the stages' own switches decide
            # WHAT THE EDITOR EDITS: its gallery picture, or the new render
            _fr = str(t.get("from") or "")
            tabs[name]["from"] = _fr if _fr in ("gallery", "render") else ""
        if name in TEXT_TABS:
            # an Image to text tab exists to be captioned: its switch is the auto prompt's
            tabs[name]["auto"]["on"] = tabs[name]["on"]
        if name == "scene":
            # words only: the Scene picture is captioned but not sent as a reference
            tabs[name]["words_only"] = bool(t.get("words_only"))
        if name == "moodboard":
            # per picture: which reads its auto prompt takes
            pm_in = t.get("pic_meta") if isinstance(t.get("pic_meta"), dict) else {}
            tabs[name]["pic_meta"] = {
                str(k): {"reads": [m for m in MOOD_READS if m in v["reads"]]}
                for k, v in pm_in.items()
                if isinstance(v, dict) and isinstance(v.get("reads"), list)}
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
            # A DENOISE PER PASS, off by default. On, the list drives the passes
            # in order and a short list repeats its last value, so the count can
            # be raised without the numbers already chosen moving. Off, the list
            # is still filled with the single dial, which keeps the sampler loop
            # reading one field either way.
            tabs[name]["pass_custom"], tabs[name]["pass_denoise"] = _pass_list(
                t.get("pass_denoise"), t.get("pass_custom"),
                tabs[name]["denoise"], 0.0, 1.0, tabs[name]["passes"])
            # THE SAME FOR SIZE. Pass 1's scale is the size the source is encoded
            # at, so it stands in for the single dial while the switch is on, and
            # each later pass resizes the latent before it samples.
            tabs[name]["scale_custom"], tabs[name]["pass_scale"] = _pass_list(
                t.get("pass_scale"), t.get("scale_custom"),
                tabs[name]["scale"], 0.25, 3.0, tabs[name]["passes"])
            if tabs[name]["scale_custom"]:
                tabs[name]["scale"] = tabs[name]["pass_scale"][0]
            # A RIG PER PASS and STEPS PER PASS: the relay a HighNoise / LowNoise
            # pair wants, pass 1 drafting on one rig and pass 2 finishing on the
            # other at a denoise just under 1. "" is the run's rig, 0 its steps.
            tabs[name]["rig_custom"], tabs[name]["pass_rig"] = _pass_names(
                t.get("pass_rig"), t.get("rig_custom"), tabs[name]["passes"])
            tabs[name]["steps_custom"], _st = _pass_list(
                t.get("pass_steps"), t.get("steps_custom"), 0.0, 0.0, 200.0,
                tabs[name]["passes"])
            tabs[name]["pass_steps"] = [int(round(v)) for v in _st]
            # CONTINUE THE NOISE: the passes are segments of ONE schedule, each
            # picking up the last one's leftover noise with none added, the
            # hand-off's other form. Denoise per pass has no say while it is on.
            tabs[name]["handoff_continue"] = bool(t.get("handoff_continue"))
            # RE-ANGLE: the viewpoint stage that runs before the i2i pass
            from . import reangle as _re_parse
            tabs[name]["reangle"] = _re_parse.parse(t.get("reangle"))
            # REALISM: the medium stage, between the viewpoint and the character
            from . import realism as _rl_parse
            tabs[name]["realism"] = _rl_parse.parse(t.get("realism"))
            # SWAP: the character stage that runs after Re-angle, before the pass
            from . import swap as _sw_parse
            tabs[name]["swap"] = _sw_parse.parse(t.get("swap"))
        if name in CONVERTER_TABS:
            conv_in = t.get("conv") if isinstance(t.get("conv"), dict) else {}
            tabs[name]["conv"] = {
                # the converter's own switch; on for every workflow saved before it
                "on": bool(conv_in.get("on", True)),
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
    # THE EDITOR'S SOURCE, for a workflow saved before the Editor had one. Re-angle,
    # Realism and Swap edited the Img2Img picture then, and only with Img2Img on a
    # real pass. Such a workflow gets that picture copied across.
    # The panel does the same on load (readCfg, Trap 13).
    # ONE CHOICE FOR EVERY EDITOR STAGE: the Source page says whether Re-angle,
    # Realism and Swap edit its gallery picture or the new render. A workflow saved
    # before it had the choice takes it from its stages: the render when every stage
    # that is on worked on the render, the gallery otherwise.
    _it0 = tabs["i2i"]
    _ed0 = tabs["editor_src"]
    if not _ed0["from"]:
        _on = [x for x in (_it0.get("reangle") or {}, _it0.get("swap") or {}) if x.get("on")]
        _ed0["from"] = ("render" if _on and all(x.get("target") == "render" for x in _on)
                        else "gallery")
    for _k in ("reangle", "realism", "swap"):
        if isinstance(_it0.get(_k), dict):
            _it0[_k]["target"] = "render" if _ed0["from"] == "render" else "source"
    if "editor_src" not in tabs_in:
        _it = tabs["i2i"]
        _src = [x for x in (_it.get("reangle") or {}, _it.get("realism") or {},
                            _it.get("swap") or {})
                if x.get("on") and x.get("target", "source") == "source"]
        if _src and _it["on"] and not _it.get("prompt_only") and _it["images"]:
            tabs["editor_src"]["images"] = list(_it["images"])
            tabs["editor_src"]["sel"] = _it["sel"]
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
    # REFINE PASSES on a canvas that starts empty. The Img2Img tab's per-pass denoise
    # and scale, brought to the tab that has no source image: pass 1 generates the
    # picture at the full denoise, and every pass after it treats what came out as its
    # own source, which is an image to image chain that begins from nothing. That is
    # the draft small and climb workflow without a second node or a wire.
    try:
        _lps = int(lat_in.get("passes", 1))
    except (TypeError, ValueError):
        _lps = 1
    latent_cfg["passes"] = max(1, min(PAINT_PASS_MAX, _lps))
    # The single dial the later passes run at. Pass 1 is not on it: a canvas of noise
    # sampled at 0.45 is mush, so the first pass always gets the run's own denoise
    # unless the per-pass list below says otherwise in as many words.
    try:
        latent_cfg["refine"] = max(0.0, min(1.0, float(lat_in.get("refine", 0.45))))
    except (TypeError, ValueError):
        latent_cfg["refine"] = 0.45
    latent_cfg["pass_custom"], latent_cfg["pass_denoise"] = _pass_list(
        lat_in.get("pass_denoise"), lat_in.get("pass_custom"),
        latent_cfg["refine"], 0.0, 1.0, latent_cfg["passes"], first=1.0)
    latent_cfg["scale_custom"], latent_cfg["pass_scale"] = _pass_list(
        lat_in.get("pass_scale"), lat_in.get("scale_custom"),
        1.0, 0.25, 3.0, latent_cfg["passes"])
    # a rig and a step count per pass, as on the Img2Img tab: the relay
    latent_cfg["rig_custom"], latent_cfg["pass_rig"] = _pass_names(
        lat_in.get("pass_rig"), lat_in.get("rig_custom"), latent_cfg["passes"])
    latent_cfg["steps_custom"], _lst = _pass_list(
        lat_in.get("pass_steps"), lat_in.get("steps_custom"), 0.0, 0.0, 200.0,
        latent_cfg["passes"])
    latent_cfg["pass_steps"] = [int(round(v)) for v in _lst]
    latent_cfg["handoff_continue"] = bool(lat_in.get("handoff_continue"))
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
    # THE CAMERA MASTER SWITCH ( "there is no way to
    # turn the cameras off, no toggle on this tab like the others"). Off, the
    # Camera tab contributes NOTHING to a render: no camera paragraph, no camera
    # slider LoRAs, no camera path, and the re-angle falls back to its bands.
    # The studio state is kept, so switching it back on restores every camera
    # exactly as it was - the same contract as the image tabs' own toggles.
    cin = data.get("camera") if isinstance(data.get("camera"), dict) else {}
    camera_cfg = {"on": True if cin.get("on") is None else bool(cin.get("on"))}
    # LORA SETS: the LoRAs tab holds MAIN plus any
    # number of named sets, each a whole stack of its own, each its own tab up
    # there. A rig, a Detailer pass and the paint pass name the set they run
    # with, so image-to-image, from-scratch, camera work and different models
    # each keep their own LoRAs without the stack being swapped by hand.
    lora_sets = []
    for st in (data.get("lora_sets") if isinstance(data.get("lora_sets"), list) else []):
        if not isinstance(st, dict):
            continue
        try:
            sseed = int(st.get("seed", 0))
        except (TypeError, ValueError):
            sseed = 0
        nm = str(st.get("name") or "").strip()[:48]
        if not nm or nm == MAIN_SET or any(x["name"] == nm for x in lora_sets):
            continue
        lora_sets.append({
            "name": nm,
            # its own switch, like Main's: off, whoever picks this set renders raw
            "on": bool(st.get("on", True)),
            "slots": st.get("slots") if isinstance(st.get("slots"), list) else [],
            "ui": st.get("ui") if isinstance(st.get("ui"), dict) else {},
            "seed": max(0, sseed),
        })
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
            # an unnamed rig is "Rig N", the same label the panel shows and links a
            # prompt row by; left empty, a row linked to "Rig 1" never matched it and
            # the run encoded an empty prompt without a word
            "name": str(r.get("name") or "").strip() or "Rig %d" % (len(rigs) + 1),
            "checkpoint": str(r.get("checkpoint") or ""),
            "unet": str(r.get("unet") or ""),
            # WHICH LOADER the diffusion model file goes through: "" is by the
            # file's name (.gguf through ComfyUI-GGUF, anything else core's
            # UNETLoader); gguf, int8 and core name one outright. INT8 W8A8
            # files are .safetensors, so that loader has to be named.
            "unet_loader": (str(r.get("unet_loader"))
                            if r.get("unet_loader") in ("gguf", "int8", "core") else ""),
            "int8_type": str(r.get("int8_type") or ""),   # the INT8 loader's model_type
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
            # A SECOND PAIR, for image to image runs only: the sampler that draws
            # well from noise is not always the one that repaints well over a
            # picture that already exists. Empty means "the pair above", so a rig
            # that never sets one behaves exactly as it always did, and a blank
            # canvas keeps the main pair whatever this says.
            "i2i_sampler": str(r.get("i2i_sampler") or ""),
            "i2i_scheduler": str(r.get("i2i_scheduler") or ""),
            # an EXTERNAL rig loads no files: it is the cockpit for a renderer
            # outside the workspace (the NovelAI chain). Its numbers and prompt
            # ride the typed output sockets; sampler and scheduler are free
            # text because an external engine names its own. The denoise field
            # is its i2i strength, carried on the denoise socket when active.
            "kind": (str(r.get("kind"))
                     if r.get("kind") in ("external", "node")
                     or r.get("kind") in RIG_KIND_HANDLERS else "files"),
            # a "node" rig (your own nodes): the rig name on its Rig Model, Rig Inputs and
            # Rig Result nodes ("" means the same name as the rig itself)
            "node": str(r.get("node") or "")[:64],
            "denoise": _num("denoise", 0.0, 1.0, 1.0, float),
            # a handled kind (the personal NovelAI rig) carries its own extra
            # settings; the raw dict rides along so the handler reads them
            # without this parse needing to know their names
            "raw": (dict(r) if r.get("kind") in RIG_KIND_HANDLERS else None),
            # IDENTITY RESCUE, per rig: restore the layers the named LoRA
            # touches back toward the named base checkpoint before the stack
            # lands, which is what makes an identity LoRA fire on a merged
            # model. Off unless every piece is named, per the house rule.
            # whether this rig's model is the official Krea 2 Turbo the identity
            # system was trained on; None until set, then the file name decides
            "official": (bool(r.get("official")) if isinstance(r.get("official"), bool)
                         else None),
            "rescue": bool(r.get("rescue")),
            "rescue_base": str(r.get("rescue_base") or ""),
            "rescue_lora": str(r.get("rescue_lora") or ""),
            "rescue_strength": _num("rescue_strength", 0.0, 1.0, 1.0, float),
            # LORA SET, per rig: which LoRAs-tab set (Main or a named set) this
            # rig renders with. "" = Main. A Detailer pass or the paint pass on
            # this rig inherits it unless it names its own.
            "lora_set": str(r.get("lora_set") or "")[:48],
            # SAMPLER DIALS, per rig, all off by default: AuraFlow shift, Detail
            # Daemon, Seed Variance, densify the tail (sampler_dials.py)
            "dials": _dials.parse_dials(r),
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
        # ONE PROMPT, SEVERAL RIGS: a row lists the
        # rigs it serves; the old single "rig" is read as a one-item list and
        # written back as the first entry, so older configs keep working.
        _rigs = [str(x).strip() for x in (p.get("rigs") if isinstance(p.get("rigs"), list) else [])
                 if str(x).strip()]
        if not _rigs and str(p.get("rig") or "").strip():
            _rigs = [str(p.get("rig")).strip()]
        prompt_rows.append({
            # an unnamed row is "Prompt N", the label the panel shows and an Inject
            # into choice saves; left empty, an injected caption never found its row
            "name": str(p.get("name") or "").strip() or "Prompt %d" % (len(prompt_rows) + 1),
            "rig": _rigs[0] if _rigs else "",
            "rigs": _rigs,
            "kind": "plain" if p.get("kind") == "plain" else "krea2",
            "text": str(p.get("text") or ""),
            "negative": str(p.get("negative") or ""),
            # THE LORA SET this prompt renders with: "" = the rig's set, "Main" or a
            # named LoRAs-tab set. Prompts no longer link to rigs; the chosen row
            # renders on whichever rig is active.
            "lora_set": str(p.get("lora_set") or "")[:48],
            # the Frame editor's fields, kept as the panel wrote them. row["text"]
            # holds the ASSEMBLED prompt (the tab streams it in from the preview
            # route), so nothing downstream needs to re-run the assembly.
            "frame": {str(k): v for k, v in fr.items()
                      if isinstance(v, (str, int, float, bool))},
            # the caption layer: sectioned by the split instruction, kept apart from
            # the typed text so clearing it never eats your words
            "auto": {str(k): str(v) for k, v in
                     (p.get("auto") if isinstance(p.get("auto"), dict) else {}).items()
                     if isinstance(v, str)},
        })
    # the chosen row (the Prompts tab writes it; prompt_row_for reads it first)
    try:
        _pact = int(prin.get("active", -1))
    except (TypeError, ValueError):
        _pact = -1
    prompts_cfg = {"rows": prompt_rows, "active": _pact if 0 <= _pact < len(prompt_rows) else -1}
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
        # BLEND, the Detailer's: how much of the repaint goes back under the mask.
        # 1 is the repaint, 0.5 keeps half of what was painted over as it was
        "blend": max(0.0, min(1.0, float(pin.get("blend", 1.0))
                              if isinstance(pin.get("blend"), (int, float)) else 1.0)),
        # What the painted region should become. Empty means "use whatever conditioning
        # is wired into the render node", which is the whole-image prompt and rarely
        # what you want for a patch.
        "prompt": str(pin.get("prompt") or ""),
        # The automatic caption is a separate layer, not text pasted into the box.
        # Keeping it separate lets OFF remove it without eating your words, and
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
    # the live frame's long edge while a paint run samples: 0 is the stream's
    # default (512), -1 the decoder's own size; set on the Paint tab's header
    try:
        paint_cfg["live_px"] = max(-1, min(4096, int(pin.get("live_px") or 0)))
    except (TypeError, ValueError):
        paint_cfg["live_px"] = 0
    # Which LoRAs the paint branch carries: the main stack's ("main", the default and
    # exactly what every workflow did before this existed) or the model choice's own
    # paint stack applied to the raw wired model ("paint"). Two options, your
    # call; a bare paint pass is the raw model wired in. A branch, never a chain:
    # chained, the paint pass would inherit the very style LoRAs it is escaping.
    # "none" existed for one unreleased day and folds into "main".
    plm = str(pin.get("lora_mode") or "main").lower()
    paint_cfg["lora_mode"] = plm if plm in ("main", "paint") else "main"
    # main mode may name a LoRAs-tab set; "" = the rig's own set
    paint_cfg["lora_set"] = str(pin.get("lora_set") or "")[:48]
    # The built-in paint door's run stamp. It exists only in the QUEUED copy of the
    # config (Generate stamps it there), never in the saved workflow, so an ordinary
    # queue can never repaint by accident.
    paint_cfg["run_token"] = str(pin.get("run_token") or "")
    # THE PROMPTS TAB FEEDS THE PAINT, when the paint box is silent. Text typed in the
    # Paint tab always wins, your standing rule: what you write is first
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
    # THE VRAM LIMIT IS A CARD SIZE (8, 12, 16, 24 GB or free range); the dial
    # ceilings follow from it. A workflow saved with Low or Medium reads as 16 or 24.
    from . import vram_hold as _vh
    vram_gb = _vh.card_gb({"vram_gb": data.get("vram_gb"), "vram_tier": tier}
                          if "vram_gb" in data else {"vram_tier": tier})
    tier = _vh.TIER_FOR_GB.get(vram_gb, "high")
    vram_hold_mode = _vh.hold_mode(data)
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
        # the server's Ollama address (OLLAMA_HOST); never taken from the workflow
        "url": autoprompt.OLLAMA_URL,
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
        # LOW VRAM CAPTIONING, off unless asked: the main model leaves the card before
        # the engines run, and every engine leaves before the sampler loads it again
        "low_vram": bool(auto_in.get("low_vram", False)),
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
        # Florence-2, one choice shared by every tab: which models/LLM folder and
        # which of the pack's caption tasks
        "florence_model": str(auto_in.get("florence_model") or ""),
        "florence_task": (str(auto_in.get("florence_task"))
                          if auto_in.get("florence_task") in autoprompt.FLORENCE_TASKS
                          else "more_detailed_caption"),
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
            # DRAFT: the Detailer and Post nodes pass the picture through while this
            # is on, so a seed iterates on the base render alone; one flip renders
            # the keeper in full. Off by default.
            "draft": bool(data.get("draft")),
            # hold the run under the VRAM limit's card size (vram_hold.py)
            "vram_hold": bool(data.get("vram_hold")),
            "vram_gb": vram_gb, "vram_hold_mode": vram_hold_mode,
            # THE BUILT-IN CHAIN: the Workspace runs the Detailer passes, Post FX and
            # the save itself when these are on. The settings are the Detailer and
            # Save nodes' own, so a card means the same thing in either place.
            "detailer_on": bool(data.get("detailer_on")),
            "detailer": data.get("detailer") if isinstance(data.get("detailer"), dict) else {},
            "post_on": data.get("post_on") is not False,
            "save_on": bool(data.get("save_on")),
            "save": data.get("save") if isinstance(data.get("save"), dict) else {},
            # THE UPSCALE TAB: one Detailer pass of an upscale kind, run on its own
            # by RedNodeUpscaleRender. The stage rides RAW, exactly as "detailer"
            # does above, so refine_pipeline.parse_pipeline stays the only owner of
            # that schema instead of a second copy drifting here (KNOWN_TRAPS 13).
            "upscale": _upscale_cfg(data.get("upscale")),
            # THE FINAL PROMPT: the Editor Converter page's block (prompt_sort.py)
            "final": _parse_final(data.get("final")),
            # SAVED FOLDER BATCHES, per tab: {"upscale": {name: [files]}, ...}.
            # Managed input names, so a saved folder is a list of pictures already
            # copied in rather than a path on anybody's drive.
            "batch_folders": _batch_folders(data.get("batch_folders")),
            "taps": _normalise_taps(data.get("taps")),
            "post": data.get("post") if isinstance(data.get("post"), dict) else {},
            "loras": loras_cfg, "paint_loras": paint_loras_cfg, "lora_sets": lora_sets,
            # the shelf a Workspace carries beside its pages: the Shelf node's own
            # shape, parsed by shelf.py, read here for its Override
            "shelf": data.get("shelf") if isinstance(data.get("shelf"), dict) else {},
            "camera": camera_cfg,
            "models": models_cfg, "prompts": prompts_cfg,
            # LINKED SEEDS: which seed each part of a run takes (seeds.py)
            "seeds": _parse_seeds(data.get("seeds"))}


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
# STEPS ON THE IMG2IMG SOURCE, registered by a personal-only extension: each is
# called with (cfg, image) once the source picture is picked and before it is
# encoded, and hands back the picture to go on with. The shipped pack registers
# none. A step that raises is a line, never a failed render.
SOURCE_STEPS = []
# why the active rig last failed to load ("" when it loaded, or nothing was asked)
RIG_LOAD_ERROR = {"text": ""}

# RedNode Rig Model nodes that ran, by rig name: {"name", "model", "clip", "vae", "node"}.
# The node writes here when the queued prompt links it in; the rig loaders read here.
# Last writer wins on a name clash, and says so.
_NODE_RIGS = {}


def register_node_rig(name, model=None, clip=None, vae=None, node_id=None):
    nm = str(name or "").strip() or "My rig"
    rec = {"name": nm, "model": model, "clip": clip, "vae": vae, "node": str(node_id or "")}
    old = _NODE_RIGS.get(nm)
    if old and old["node"] and rec["node"] and old["node"] != rec["node"]:
        print("[RedNode Rig] two Rig Model nodes name the rig %r; the one that ran last "
              "is used" % nm, flush=True)
    _NODE_RIGS[nm] = rec
    have = [k for k in ("model", "clip", "vae") if rec[k] is not None]
    print("[RedNode Rig] %r ready: %s" % (nm, ", ".join(have) or "nothing wired in"),
          flush=True)
    return rec


def shelf_override(prompt, own=None):
    """The shelf that speaks for the galleries this run, or None.

    A shelf with Override on hands its picked picture to the tabs it names, in
    place of whatever those galleries hold. Nothing is written back: the
    substitution lives for the length of one run, so switching Override off
    hands every tab its own picture again.

    ONE SHELF AT A TIME. The panel switches the others off as you turn one on, so
    two can only meet here in a workflow saved with both, or a shelf pasted from
    one. The one switched on LAST wins, because that is the one just chosen. With
    no way to tell them apart the run stops instead of guessing: rendering from
    the wrong picture quietly is worse than not rendering (you, 2026-09-24).
    """
    from . import shelf as _shelf
    found = []
    for nid, n in (prompt.items() if isinstance(prompt, dict) else []):
        if not isinstance(n, dict) or n.get("class_type") != "RedNodeShelf":
            continue
        rec = _shelf.RedNodeShelf.parse((n.get("inputs") or {}).get("config"))
        if rec["override"] and rec["entry"] and rec["tabs"]:
            rec["node"] = str(nid)
            found.append(rec)
    # THE WORKSPACE'S OWN SHELF, the column beside its pages: not a node in the
    # prompt, so it is handed in by the Workspace itself and joins the same rule
    if own and isinstance(own[0], dict) and own[0]:
        rec = _shelf.RedNodeShelf.parse(json.dumps(own[0]))
        if rec["override"] and rec["entry"] and rec["tabs"]:
            rec["node"] = "%s (its own shelf)" % (own[1] if own[1] is not None else "?")
            found.append(rec)
    if not found:
        return None
    if len(found) > 1:
        newest = max(f["at"] for f in found)
        latest = [f for f in found if f["at"] == newest]
        if len(latest) > 1 or not newest:
            raise ValueError(
                "RedNode Workspace: %d shelves have Override on (nodes %s) and nothing "
                "says which was chosen last. Switch it off on all but one, then queue "
                "again." % (len(found), ", ".join(sorted(f["node"] for f in found))))
        print("[RedNode Workspace] %d shelves have Override on; the one switched on "
              "last (node %s) speaks for the galleries"
              % (len(found), latest[0]["node"]), flush=True)
        return latest[0]
    return found[0]


def apply_shelf_override(cfg, rec):
    """Put an overriding shelf's picture on the tabs it names. Returns the tab ids."""
    if not rec:
        return []
    done = []
    for name in rec["tabs"]:
        t = cfg["tabs"].get(name)
        if not isinstance(t, dict):
            continue
        t["images"] = [rec["entry"]]
        # the list-selection tabs (moodboard and the Image to text ones) keep a list
        t["sel"] = [0] if isinstance(t.get("sel"), list) else 0
        # a dice roll over one picture is the same picture, but it prints as a roll
        t["random"] = False
        # ticking a tab on the shelf is as deliberate as a right-click send, and a
        # send switches its tab on; an override onto a switched-off tab would do
        # nothing at all and look like the switch was broken
        t["on"] = True
        done.append(name)
    if done:
        print("[RedNode Workspace] the shelf on node %s overrides %s with %r"
              % (rec.get("node", "?"), ", ".join(done), rec["entry"]), flush=True)
    return done


def custom_rig_names(prompt):
    """The rig names on the Rig Model nodes in this queued prompt; None when there is no
    prompt to read, which callers take as "do not filter"."""
    if not isinstance(prompt, dict):
        return None
    out = set()
    for n in prompt.values():
        if isinstance(n, dict) and n.get("class_type") == "RedNodeRigModel":
            v = (n.get("inputs") or {}).get("rig")
            out.add((v.strip() if isinstance(v, str) else "") or "My rig")
    return out


def node_rig(name, prompt=None):
    """A Rig Model's record by rig name, or None. With the prompt, only a node that is in
    this queue counts, so a node deleted since an earlier run is not used."""
    nm = str(name or "").strip()
    names = custom_rig_names(prompt)
    if names is not None and nm not in names:
        return None
    return _NODE_RIGS.get(nm)


def _rig_cache_clear():
    _RIG_CACHE["slots"] = []


def is_qwen21_clip(clip):
    """True when this CLIP is Qwen-Image-2.1's text encoder (Qwen3-VL 8B)."""
    tok = getattr(clip, "tokenizer", None)
    return type(tok).__name__ == "QwenImage21Tokenizer"


def plain_encode(clip, text):
    """Conditioning for a rig outside the Krea 2 system. Qwen-Image-2.1 is encoded
    the way core's Text Encode Qwen Image 2.1 does it with no reference images: an
    empty prompt still yields a token, so the negative never comes back empty.
    Every other model gets core's CLIPTextEncode."""
    if is_qwen21_clip(clip):
        tokens = clip.tokenize(str(text or ""), images=[], keep_vision=True,
                               prevent_empty_text=True)
        return clip.encode_from_tokens_scheduled(tokens)
    import nodes as _core_enc
    return _core_enc.CLIPTextEncode().encode(clip, text)[0]


def prompt_row_for(models_cfg, prompts_cfg, rig_name=""):
    """The Prompts-tab row that renders: the one you chose, when it has words,
    else the first row with words. None when no row has any, which callers must
    treat as "no opinion", never as an empty prompt.

    Rows used to link to rigs and each rig found its own row. Since 2026-09-21 the
    chosen row renders on whichever rig is active, and a Detailer pass names a row
    when it wants another; `rig_name` is kept for the callers and ignored. Old
    links in a saved workflow are simply not read.
    """
    rows = prompts_cfg.get("rows") or []
    try:
        pick = int(prompts_cfg.get("active", -1))
    except (TypeError, ValueError):
        pick = -1
    if 0 <= pick < len(rows) and str(rows[pick].get("text") or "").strip():
        return rows[pick]
    for row in rows:
        if str(row.get("text") or "").strip():
            return row
    return None

def rig_is_official(rec):
    """The Identity Edit LoRA takes faces on the official Krea 2 Turbo; community
    mixes lose it. A rig says so itself, or its model file's name does."""
    rec = rec or {}
    if isinstance(rec.get("official"), bool):
        return rec["official"]
    return "official" in ("%s %s" % (rec.get("unet") or "", rec.get("checkpoint") or "")).lower()


def rig_text_key(rec, clip, from_rec=True):
    """What decides a rig's conditioning: two rigs with the same key share it. A files
    rig is its CLIP file and type; your own nodes, or a wired CLIP, the object itself."""
    ctype = str((rec or {}).get("clip_type") or "")
    if not from_rec or (rec or {}).get("kind") == "node":
        return ("obj", id(clip), ctype)
    return ("file", str(rec.get("clip") or "ckpt:%s" % (rec.get("checkpoint") or "")), ctype)


def rig_vae_key(rec, vae, from_rec=True):
    """What decides a rig's latent space: two rigs with the same key share latents."""
    if not from_rec or (rec or {}).get("kind") == "node":
        return ("obj", id(vae))
    return ("file", str(rec.get("vae") or "ckpt:%s" % (rec.get("checkpoint") or "")))


def _write_temp_batch(image, prefix, whose):
    """[{filename, subfolder, type: "temp"}] for every picture in `image`, written to
    ComfyUI's temp folder. Shared by keep_before_post and keep_final_result. Never
    fatal: a failed write just means no picture there."""
    try:
        import folder_paths
        out_dir = folder_paths.get_temp_directory()
        os.makedirs(out_dir, exist_ok=True)
        recs = []
        t = image
        if t.ndim > 4:
            t = t.reshape((-1,) + tuple(t.shape[-3:]))
        for k in range(int(t.shape[0])):
            arr = (t[k].detach().cpu().float().clamp(0, 1).numpy() * 255).astype("uint8")
            name = "%s%08x.png" % (prefix, _random.randint(0, 0xffffffff))
            Image.fromarray(arr[..., :3], mode="RGB").save(os.path.join(out_dir, name),
                                                          compress_level=4)
            recs.append({"filename": name, "subfolder": "", "type": "temp"})
        return recs
    except Exception as exc:
        print("[RedNode Workspace] could not keep %s: %s" % (whose, exc), flush=True)
        return []


def keep_before_post(image):
    """The finished picture before Post FX, written to the temp folder, as file
    records for the Paint tab's Use last result (Before Post). Post's grain,
    vignette and grade are hard to paint out, so the tab can start from the
    picture underneath."""
    return _write_temp_batch(image, "rednode_prepost_", "the picture before Post")


def keep_raw_render(image):
    """The render as it left the sampler, before the Editor's edits on it, the
    Detailer and Post FX, written to the temp folder as file records. The Run page's Raw / Before Post / After Post
    switch reads these; only written when the Save tab's raw copy is on."""
    return _write_temp_batch(image, "rednode_raw_", "the raw render")


def keep_final_result(image):
    """The finished picture, written to the temp folder, when the Save switch is
    off or the built-in save failed. So the Run tab's Live picture and the Review
    always have this run's result, even when it was never written to disk."""
    return _write_temp_batch(image, "rednode_final_", "the final picture")


def blocked(message=None):
    """An ExecutionBlocker: downstream nodes skip instead of crashing.

    With a message, core stops the run there and shows the message as the error, which
    is how a render that produced nothing says why instead of finishing quietly.

    Core nodes like PreviewImage have no None guard, so handing them None on a
    paint run or in external-sampler mode is a TypeError in your face.
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
    return ExecutionBlocker(message)


def _clip_hint(rig, err=""):
    """A sentence about the CLIP type when it is the likely cause, else ""."""
    if rig and rig.get("clip") and not rig.get("clip_type"):
        return (" The rig's CLIP type is empty, which loads it as Stable Diffusion; set it "
                "to match the model, krea2 for Krea 2.")
    e = str(err).lower()
    if any(k in e for k in ("mat1 and mat2", "size mismatch", "shape", "dimension")):
        return (" A shape error like this usually means the CLIP type does not match the "
                "model; check the rig's CLIP type on the Models tab.")
    return ""


def nothing_rendered(cfg, rig_name, model, clip, enc_err=None, samp_err=None,
                     no_vae=False):
    """The sentence a run shows when the Workspace's image output came out empty."""
    head = "RedNode Studio Workspace rendered nothing, so its image output is empty. "
    m = cfg.get("models") or {}
    rigs = m.get("rigs") or []
    rig = rigs[max(0, min(int(m.get("active", 0)), len(rigs) - 1))] if rigs else None
    who = ("the rig %r" % rig_name) if rig_name else "the active rig"
    if m.get("sampler_mode") != "internal":
        return head + ("The Models tab is set to External sampler, which hands the model, the "
                       "prompts and the latent to your own KSampler and renders nothing itself. "
                       "Choose Built-in sampler on the Models tab, or wire a KSampler and take "
                       "the picture from there.")
    if rig and rig.get("kind") in RIG_KIND_HANDLERS:
        return head + ("%s renders through its own engine and returned no picture%s."
                       % (who[0].upper() + who[1:], (": %s" % samp_err) if samp_err else ""))
    if rig is None and model is None:
        return head + ("There is no rig on the Models tab and no model is wired in. Add a rig "
                       "and choose its diffusion model or checkpoint, its text encoder (CLIP) "
                       "and its VAE.")
    if rig and rig.get("kind") == "external":
        return head + ("%s is an External renderer, which loads no model. Pick a rig that "
                       "loads one." % (who[0].upper() + who[1:]))
    if model is None:
        if RIG_LOAD_ERROR["text"]:
            return head + ("%s could not load: %s.%s"
                           % (who[0].upper() + who[1:], RIG_LOAD_ERROR["text"],
                              "" if (rig or {}).get("kind") == "node"
                              else " Check the files chosen on the Models tab."))
        return head + ("%s has no diffusion model or checkpoint chosen, and no model is wired "
                       "in. Choose one on the Models tab." % (who[0].upper() + who[1:]))
    if clip is None:
        return head + ("%s has no text encoder (CLIP) chosen and none is wired in, so the prompt "
                       "could not be encoded. Choose the CLIP and its type on the Models tab."
                       % (who[0].upper() + who[1:]))
    if enc_err:
        return head + "Encoding the prompt failed: %s.%s" % (enc_err, _clip_hint(rig, enc_err))
    if samp_err:
        return head + "Sampling failed: %s.%s" % (samp_err, _clip_hint(rig, samp_err))
    if no_vae:
        return head + ("%s has no VAE chosen and none is wired in, so the picture could not be "
                       "decoded. Choose a VAE on the Models tab." % (who[0].upper() + who[1:]))
    return head + "The console lines starting with [RedNode Workspace] say what happened."


# The loaders a diffusion model file can go through besides core's UNETLoader,
# by NODE_CLASS_MAPPINGS the way SAM3 and SeedVR2 are called: node, its file
# field, the pack to install. A quantised file that core cannot read has a
# loader of its own; the rig names it or, for .gguf, the file's name does.
UNET_LOADERS = {
    "gguf": ("UnetLoaderGGUF", "unet_name", "ComfyUI-GGUF"),
    "int8": ("OTUNetLoaderW8A8", "unet_name", "ComfyUI-INT8-Fast or ComfyUI-Flux2-INT8"),
}


def unet_loader_for(name, choice=""):
    """Which loader a diffusion model file takes: the rig's explicit choice,
    else by the file's name (.gguf through the GGUF pack, anything else core)."""
    if choice in UNET_LOADERS:
        return choice
    if choice == "core":
        return ""
    return "gguf" if str(name).lower().endswith(".gguf") else ""


def _load_unet(name, choice="", int8_type=""):
    """A diffusion model through the loader it needs. A pack that is not
    installed is named in the error, which load_active_rig prints."""
    import nodes as _nodes
    kind = unet_loader_for(name, choice)
    if not kind:
        return _nodes.UNETLoader().load_unet(unet_name=name, weight_dtype="default")[0]
    node, field, pack = UNET_LOADERS[kind]
    cls = (getattr(_nodes, "NODE_CLASS_MAPPINGS", None) or {}).get(node)
    if cls is None:
        raise RuntimeError("%r wants the %s loader (%s, node %s), which is not installed"
                           % (name, kind.upper(), pack, node))
    kw = {}
    try:
        # the node's own defaults under the file, so a version that grew a
        # widget still calls; the INT8 loader's model_type is the rig's when set
        it = cls.INPUT_TYPES()
        merged = dict(it.get("required") or {})
        merged.update(it.get("optional") or {})
        for k, spec in merged.items():
            if not (isinstance(spec, (tuple, list)) and spec):
                continue
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if "default" in opts:
                kw[k] = opts["default"]
            elif isinstance(spec[0], list) and spec[0]:
                kw[k] = spec[0][0]
        if kind == "int8" and int8_type and "model_type" in merged:
            kw["model_type"] = int8_type
    except Exception:
        pass
    kw[field] = name
    print("[RedNode Workspace] %s through %s" % (name, node), flush=True)
    return getattr(cls(), cls.FUNCTION)(**kw)[0]


def load_active_rig(cfg, name="", prompt=None):
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
    if rig.get("kind") == "node":
        # A CUSTOM RIG NODE: whatever the user wired into it, loaded by their own nodes.
        # The rig cache is not involved; ComfyUI's cache holds those.
        target = rig.get("node") or rig["name"]
        rec = node_rig(target, prompt)
        if rec is None:
            RIG_LOAD_ERROR["text"] = (
                "the RedNode Rig Model node for the rig %r did not run this queue. Check a Rig "
                "Model node with that rig name is on the canvas and not bypassed, and queue "
                "from the ComfyUI page, which links it in" % target)
            print("[RedNode Workspace] rig %r: %s" % (rig["name"], RIG_LOAD_ERROR["text"]),
                  flush=True)
            return rig["name"], None, None, None
        RIG_LOAD_ERROR["text"] = ""
        print("[RedNode Workspace] rig %r takes its model from your own nodes (Rig Model %r)"
              % (rig["name"], target), flush=True)
        return rig["name"], rec["model"], rec["clip"], rec["vae"]
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
            rig.get("rescue_strength", 1.0)) if _resc else None,
           (rig.get("unet_loader") or "", rig.get("int8_type") or ""))
    if not any(key[:5]):
        return rig["name"], None, None, None
    from . import run_events as _rev
    for n, slot in enumerate(_RIG_CACHE["slots"]):
        if slot["key"] == key:
            _RIG_CACHE["slots"].insert(0, _RIG_CACHE["slots"].pop(n))
            _rev.note_once(("rig", rig["name"]), "%s ready: already in RAM" % rig["name"])
            _rev.name_rig(rig["name"], slot["model"], slot["clip"], slot["vae"])
            return rig["name"], slot["model"], slot["clip"], slot["vae"]
    # make room BEFORE loading, so the cap is a peak-RAM promise, not a tidy-up:
    # one slot by default, two when the Models tab's Hold-two toggle says so
    cap = 2 if (cfg.get("models") or {}).get("hold_two") else 1
    while len(_RIG_CACHE["slots"]) >= cap:
        dropped = _RIG_CACHE["slots"].pop()
        _rev.note("%s dropped from RAM to make room for %s"
                  % (dropped.get("name") or dropped["key"][0] or dropped["key"][1],
                     rig["name"]), "unload")
        print("[RedNode Workspace] rig cache: dropping %r to make room"
              % (dropped["key"][0] or dropped["key"][1],), flush=True)
    model = clip = vae = None
    RIG_LOAD_ERROR["text"] = ""
    import time as _time
    _t0 = _time.time()
    _rev.begin("rig:" + rig["name"], "Load %s" % rig["name"])
    try:
        import nodes as _nodes
        if rig["checkpoint"]:
            model, clip, vae = _nodes.CheckpointLoaderSimple().load_checkpoint(
                ckpt_name=rig["checkpoint"])[:3]
        if rig["unet"]:
            model = _load_unet(rig["unet"], rig.get("unet_loader") or "",
                               rig.get("int8_type") or "")
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
        RIG_LOAD_ERROR["text"] = str(exc)
        _rev.end("rig:" + rig["name"], "Load %s" % rig["name"], "error", error=str(exc)[:200])
        return rig["name"], None, None, None
    _RIG_CACHE["slots"].insert(0, {"key": key, "model": model, "clip": clip,
                                   "vae": vae, "name": rig["name"]})
    kinds = [k for k, v in (("model", model), ("clip", clip), ("vae", vae)) if v is not None]
    _rev.name_rig(rig["name"], model, clip, vae)
    _rev.end("rig:" + rig["name"], "Load %s" % rig["name"], parts=kinds)
    _rev.note("%s loaded from disk into RAM in %.1f s (%s)"
              % (rig["name"], _time.time() - _t0, ", ".join(kinds)), "load")
    print("[RedNode Workspace] Models tab loaded %s (%s)"
          % (rig["name"] or rig["checkpoint"] or rig["unet"], ", ".join(kinds)),
          flush=True)
    return rig["name"], model, clip, vae


MAIN_SET = "Main"


def camera_on(cfg):
    """Is the Camera tab switched on? Missing block = on (the old behaviour)."""
    c = cfg.get("camera")
    return True if not isinstance(c, dict) or c.get("on") is None else bool(c["on"])


def rig_lora_set(cfg, name=""):
    """The named rig's LoRA set (the active rig's when unnamed); "" = Main.

    For the active rig, the rendering prompt's own LoRA set wins when it names one;
    left on "the rig's set" the rig decides, as before prompts carried one."""
    try:
        rigs = cfg.get("models", {}).get("rigs") or []
        want = str(name or "").strip()
        _act = rigs[max(0, min(int(cfg["models"].get("active", 0)), len(rigs) - 1))] if rigs else None
        if not want or want == "(active rig)" or (_act and want == _act.get("name")):
            _row = prompt_row_for(cfg.get("models") or {}, cfg.get("prompts") or {})
            if _row and str(_row.get("lora_set") or "").strip():
                return str(_row["lora_set"])
        if want and want != "(active rig)":
            for r in rigs:
                if r.get("name") == want:
                    return str(r.get("lora_set") or "")
        if rigs:
            i = max(0, min(int(cfg["models"].get("active", 0)), len(rigs) - 1))
            return str(rigs[i].get("lora_set") or "")
    except Exception:
        pass
    return ""


def lora_set_cfg(cfg, set_name="", who="Workspace"):
    """The stack a set name means: {"on", "slots", "ui", "seed", "name"}.
    "" or Main = the LoRAs tab's main stack; a named set = that tab; a name
    that no longer exists = Main, said out loud."""
    main = dict(cfg.get("loras") or {})
    main.setdefault("on", True)
    main.setdefault("slots", [])
    main.setdefault("ui", {})
    main.setdefault("seed", 0)
    main["name"] = MAIN_SET
    want = str(set_name or "").strip()
    if not want or want == MAIN_SET:
        return main
    for st in cfg.get("lora_sets") or []:
        if st.get("name") == want:
            return {"on": bool(st.get("on", True)), "slots": st.get("slots") or [],
                    "ui": st.get("ui") or {},
                    "seed": int(st.get("seed", 0) or 0), "name": want}
    print("[RedNode %s] LoRA set %r is not on the LoRAs tab any more; using Main"
          % (who, want), flush=True)
    return main


def load_paint_rig(cfg, name=""):
    """The rig THROUGH the paint LoRA routing: what a paint node should render with.

    "It should just be doing it automatically": the raw rig
    goes through whichever stack the Paint LoRAs routing names, the paint stack when
    it says paint, the main tab's stack otherwise, so every socket that hands a
    model to a paint chain hands the SAME stacked model the routing promises.
    """
    nm, model, clip, vae = load_active_rig(cfg, name)
    if model is None:
        return nm, model, clip, vae
    use_paint = cfg["paint"].get("lora_mode") == "paint"
    lc = (cfg.get("paint_loras") if use_paint
          else lora_set_cfg(cfg, cfg["paint"].get("lora_set") or rig_lora_set(cfg, name),
                            "Paint rig")) or {}
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


def _inside_dir(path, root):
    """True when `path` sits inside `root` (or is it), by name or after links.

    Two readings, and either one is enough.

    The first is lexical, on the normalised name: ".." is collapsed before the
    comparison, so "rednode/../../secrets.txt" is refused exactly as it was. The
    second follows links, which catches the same climb spelled through one.

    Both are needed because A FOLDER SOMEBODY LINKED IN THEMSELVES is ordinary
    here: an output folder junctioned onto another drive resolves outside the
    root and is still precisely where the pictures live. ComfyUI's own helper
    refuses those since it started resolving links, which is how a picture you
    can see in a gallery, and drag, came back as "not in the input folder any
    more" (you, 2026-09-23).
    """
    try:
        rootn = os.path.normcase(os.path.abspath(root))
        pathn = os.path.normcase(os.path.abspath(path))
        if pathn == rootn or pathn.startswith(rootn + os.sep):
            return True
        rootr = os.path.normcase(os.path.realpath(root))
        realp = os.path.normcase(os.path.realpath(path))
        return realp == rootr or realp.startswith(rootr + os.sep)
    except Exception:
        return False


def _inside_input(path):
    """True when a resolved path really sits inside ComfyUI's input folder.

    _managed() only looks at the front of the name, which is the right test for
    "did this panel put it there" and the wrong one for "is this safe to read":
    "rednode/../../secrets.txt" starts with rednode/ too. Anything reached from an
    HTTP request gets resolved and checked against the folder itself.
    """
    return _inside_dir(path, folder_paths.get_input_directory())


def _same_dir(a, b):
    """The same folder, whatever the case and the trailing slash say."""
    try:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
    except Exception:
        return False


def _entry_base(name):
    """(bare name, the ComfyUI folder an entry's annotation names; input by default)."""
    bare, base = folder_paths.annotated_filepath(str(name))
    return bare, (base or folder_paths.get_input_directory())


def _filepath(name):
    """Resolve a gallery entry ("sub/f.png" or "f.png [input]") to a real path.

    The result has to sit inside the folder the entry names. ComfyUI's own helper
    refuses a climbing name since v0.28.0; this pack runs on older cores too, and a
    name can arrive over HTTP, so the check is made here as well."""
    bare, base = _entry_base(name)
    try:
        path = folder_paths.get_annotated_filepath(str(name))
    except ValueError:
        # Core refuses any name that RESOLVES outside the folder, which a junction
        # inside the folder does. Build the path ourselves and let _inside_dir
        # decide: it takes a link somebody put there and still refuses a climb.
        path = os.path.abspath(os.path.join(base, bare))
    if not path or not _inside_dir(path, base) or not os.path.isfile(path):
        folder = ("output" if _same_dir(base, folder_paths.get_output_directory())
                  else "temp" if _same_dir(base, folder_paths.get_temp_directory())
                  else "input")
        raise ValueError(
            f"RedNode Workspace: the image {name!r} is not in the ComfyUI {folder} folder "
            "any more. Re-add it on the panel (its gallery slot will show as missing).")
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


# "none" is a real choice: no upscaler at all, so the tab is a way to put a folder
# of pictures through the Detailer, Post and Save without going near Img2Img, which
# carries a tab full of other things. Fit first still applies, so it doubles as a
# batch resize.
UPSCALE_METHODS = ("upscale", "vosr2", "usdu", "none")


class _UpscaleHandled(Exception):
    """The upscale door is finished early: Send to Detailer has nothing to upscale.

    An exception rather than a flag because the door is one try block, and this
    is the one way out of it that is not a failure.
    """


def _batch_folders(raw):
    """Saved folder batches, keyed by tab then by name.

    Names are trimmed and capped, lists hold managed input filenames only. A
    saved batch is not a path: the pictures were copied into ComfyUI's input
    folder when they were taken, and this remembers which ones went together.
    """
    src = raw if isinstance(raw, dict) else {}
    out = {}
    for tab, saved in src.items():
        if not isinstance(saved, dict):
            continue
        keep = {}
        for name, files in list(saved.items())[:64]:
            nm = str(name or "").strip()[:48]
            if not nm or not isinstance(files, list):
                continue
            keep[nm] = [str(f) for f in files[:2000] if str(f or "").strip()]
        if keep:
            out[str(tab)[:32]] = keep
    return out


def _upscale_cfg(raw):
    """The Upscale tab: a source picture and ONE Detailer pass to run on it.

    The pass itself is not clamped here. It is handed to
    `refine_pipeline.parse_pipeline` when it runs, which is the only place that
    schema is allowed to live; a second copy in this file is exactly the drift
    KNOWN_TRAPS 13 is about.
    """
    d = raw if isinstance(raw, dict) else {}
    st = d.get("stage") if isinstance(d.get("stage"), dict) else {}
    kind = str(st.get("type") or "")
    if kind not in UPSCALE_METHODS:
        st = dict(st, type="vosr2")
    try:
        seed = max(0, int(d.get("seed", 0)))
    except (TypeError, ValueError):
        seed = 0
    return {
        "on": bool(d.get("on")),
        # the managed filename of the picture being upscaled, the same convention
        # cfg.paint["source"] uses
        "source": str(d.get("source") or ""),
        # stamped into the QUEUED copy by the tab's Generate, never saved: an
        # ordinary queue has no token and so never upscales by accident
        "run_token": str(d.get("run_token") or ""),
        # "upscale" runs the pass; "chain" skips it and sends the picture straight
        # into the builtin chain instead, which is the tab's Send to Detailer
        "run_mode": ("chain" if str(d.get("run_mode") or "") == "chain"
                     else "upscale"),
        # RESIZE: the long edge the picture is taken to BEFORE the method runs,
        # so a folder of mixed sizes comes out at one size. 0 leaves it alone.
        # Uses paint_render._fit, the same resize the Paint tab works to.
        "pre_size": max(0, min(8192, int(d.get("pre_size") or 0)))
                    if str(d.get("pre_size") or "0").lstrip("-").isdigit() else 0,
        # what the batch does with each picture once it is made. Panel-driven, so
        # the server only has to carry it rather than act on it.
        # "manual" is a real choice, not the absence of one: it says the pictures
        # are being handled by hand from the result card, which is why it also
        # stands the "nothing is being kept" warning down.
        "after": {"manual": bool((d.get("after") or {}).get("manual")),
                  "detailer": bool((d.get("after") or {}).get("detailer")),
                  "post": bool((d.get("after") or {}).get("post")),
                  "save": bool((d.get("after") or {}).get("save"))},
        "stage": st,
        "seed": seed,
        "seed_random": (True if d.get("seed_random") is None
                        else bool(d.get("seed_random"))),
    }


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


# The text chunks a RedNode save writes. Carried, not rebuilt: an upscale of last
# week's render must say what MADE that picture, not what happens to be loaded in
# the Workspace today.
# The graph chunks go too. "parameters" alone was not enough: the pack's own
# reader (web/rednode_png_meta.js, workspaceConfigIn) looks at "workflow" FIRST
# and only falls back to "prompt", so a carried prompt sat next to today's graph
# and the model, seed and LoRA stack came from whatever is loaded now.
CARRY_CHUNKS = ("parameters", "civitaiResources", "hashes", "rednode_words",
                "prompt", "workflow")


def png_carry(name):
    """The RedNode metadata already in a picture, or {} if it has none.

    A picture dropped on the Upscale tab is usually one this pack made, and it
    carries its own prompt, model, LoRAs, seed and steps in its text chunks. Those
    belong to the render, so they follow the picture through an upscale rather
    than being replaced by whatever rig is loaded now.
    """
    try:
        with Image.open(_filepath(name)) as img:
            text = dict(getattr(img, "text", {}) or {})
    except Exception:
        return {}
    out = {k: text[k] for k in CARRY_CHUNKS if str(text.get(k) or "").strip()}
    # only worth carrying if it names a render: the two lists alone say nothing
    return out if out.get("parameters") else {}


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
                # the preset combo used to sit here, across the top of the node. The
                # Overview tab's Workspace preset card does the whole job now, so the
                # widget is gone; it was the LAST of the two, so nothing a saved
                # workflow stored shifts position. build() still accepts the argument
                # for a queue saved before this.
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT",
                       "extra_pnginfo": "EXTRA_PNGINFO"},
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
                "edit_mask_in": ("MASK", {"tooltip": "optional wired edit mask, sent out on "
                                          "edit_mask with a latent sized to the scene picture"}),
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
    # an output node: with the save built in, a one-node workflow is a whole run
    OUTPUT_NODE = True
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
        # a part linked to a named seed that re-rolls every queue
        from .seeds import any_random_link as _any_rl
        if _any_rl(cfg0["seeds"]):
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
                    h.update(str(os.path.getmtime(_filepath(name))).encode())
                except Exception:
                    h.update(b"missing")
        return h.hexdigest()

    @staticmethod
    def _shot_text(shot_state, row, run_seed):
        """The row's prompt re-assembled with one shot's camera: the Frame run
        again with that camera, so the paragraph describes where THIS shot
        stands. A plain row has no frame to re-run and keeps its words. No
        state (the Camera tab off) re-runs it with no camera; a row whose
        Camera words switch is off writes no camera words at all."""
        text = row.get("text", "")
        fr = row.get("frame") or {}
        words_off = bool(fr.get("camera_off"))
        cam_json = json.dumps(shot_state) if shot_state and not words_off else ""
        if row.get("kind") == "krea2" and fr:
            from .prompt_frame import RedNodePromptFrame
            text, _n = RedNodePromptFrame().run(
                subject=str(fr.get("subject") or ""),
                surroundings=str(fr.get("surroundings") or ""),
                framing=str(fr.get("framing") or "Balanced"),
                placement=str(fr.get("placement") or ""),
                light_and_colour=str(fr.get("light_and_colour") or ""),
                placement_where=str(fr.get("placement_where") or "None"),
                placement_what=str(fr.get("placement_what") or "None"),
                lighting=str(fr.get("lighting") or "None"),
                brightness=int(fr.get("brightness") or 0),
                style=str(fr.get("style") or "None"),
                style_extra=str(fr.get("style_extra") or ""),
                framing_push=str(fr.get("framing_push") or "Off"),
                camera_height=("Eye level" if words_off
                               else str(fr.get("camera_height") or "Eye level")),
                camera=cam_json,
                camera_off=words_off,
                seed=run_seed)
        return text

    @staticmethod
    def _pass_rig(cfg, name, prompt=None):
        """Another Models-tab rig for one pass of the built-in sampler: its model and
        CLIP with its own LoRA set applied, its VAE, and its sampler numbers. None when
        there is nothing to load, so the pass falls back to the run's rig and says so.

        The camera LoRAs are not re-applied on it: they are tuned for the run's
        model, and a relay's second rig is the same family anyway. The rig cache
        keeps one model unless Hold two is on, so the console asks for it.
        """
        rec = next((r for r in cfg["models"]["rigs"] if r.get("name") == name), None)
        if rec is None:
            print("[RedNode Workspace] no rig named %r for this pass; the run's rig "
                  "carries on" % name, flush=True)
            return None
        _nm, model, clip, vae = load_active_rig(cfg, name, prompt=prompt)
        ekey, vkey = rig_text_key(rec, clip), rig_vae_key(rec, vae)
        if model is None:
            print("[RedNode Workspace] pass rig %r has no model to load; the run's "
                  "rig carries on" % name, flush=True)
            return None
        if not cfg["models"].get("hold_two"):
            print("[RedNode Workspace] pass rig %r: turn on Hold two rigs on the Models "
                  "tab to keep both models loaded between queues" % name, flush=True)
        dials = rec.get("dials") or _dials.parse_dials(rec)
        if dials.get("shift"):
            model = _dials.apply_shift(model, dials["shift"])
        lc = lora_set_cfg(cfg, rec.get("lora_set") or "", "Workspace pass rig")
        if lc.get("on", True) and lc.get("slots"):
            model, _c, _w, _applied = _lora.apply_stack(
                model, clip, _lora.CUSTOM_SENTINEL,
                json.dumps({"ui": lc.get("ui") or {}, "slots": lc["slots"]}),
                int(lc.get("seed", 0) or 0), None, tag="Workspace pass rig LoRAs")
            clip = _c if _c is not None else clip
        steps = int(rec.get("steps") or 8)
        try:
            cfg_v = float(rec.get("cfg", 1.0) or 1.0)
        except (TypeError, ValueError):
            cfg_v = 1.0
        sampler = (rec.get("sampler") if rec.get("sampler")
                   in comfy.samplers.KSampler.SAMPLERS else "euler")
        scheduler = (rec.get("scheduler") if _dials.scheduler_ok(rec.get("scheduler"))
                     else "simple")
        print("[RedNode Workspace] pass rig %r: %d steps, cfg %.1f, %s/%s"
              % (name, steps, cfg_v, sampler, scheduler), flush=True)
        return model, steps, cfg_v, sampler, scheduler, dials, clip, vae, ekey, vkey

    @staticmethod
    def _pass_encode(cfg, rig_name, rec, clip, vae, text, negative, studio_preset,
                     style_strength, workspace):
        """A pass rig's own conditioning, for a rig with another text encoder: the same
        encode the run uses, by that rig's model family."""
        if rec.get("clip_type") == "krea2":
            from .rednode import Krea2RedNode
            return Krea2RedNode().encode(
                clip, text, studio_preset or CUSTOM_SENTINEL,
                style_strength if style_strength is not None else 0.5,
                negative_prompt=negative, vae=vae, workspace=workspace)
        return plain_encode(clip, text), plain_encode(clip, negative)

    def _shot_setup(self, si, shot_state, row, cfg, run_seed, enc_clip, model_pre_camera,
                    rig_is_krea2, studio_preset, style_strength, vae, workspace, lc, unique_id,
                    positive_fallback, model_fallback):
        """One camera-path shot: (positive conditioning, model) for that shot -
        the row re-assembled with the shot's camera, encoded; the camera LoRAs
        at the shot's strengths on the pre-camera model."""
        from .camera_studio import resolve_camera_loras as _cs_loras
        text = self._shot_text(shot_state, row, run_seed)
        # encode
        pos = positive_fallback
        if enc_clip is not None:
            if rig_is_krea2:
                from .rednode import Krea2RedNode
                pos, _neg = Krea2RedNode().encode(
                    enc_clip, text, studio_preset or CUSTOM_SENTINEL,
                    style_strength if style_strength is not None else 0.5,
                    negative_prompt=str(row.get("negative") or ""),
                    vae=vae, workspace=workspace)
            else:
                pos = plain_encode(enc_clip, text)
        # the shot's camera LoRAs on the pre-camera model
        model_i = model_fallback
        slots = [{"name": e["name"], "strength": float(e["strength"]), "enabled": True,
                  "type": "lora", "label": "camera %s" % e["key"]}
                 for e in _cs_loras(shot_state)]
        if model_pre_camera is not None:
            if slots:
                model_i, _, _w, _a = _lora.apply_stack(
                    model_pre_camera, None, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": lc["ui"], "slots": slots}), lc["seed"], unique_id,
                    tag="Workspace camera LoRAs")
            else:
                model_i = model_pre_camera
        print("[RedNode Workspace] shot %d: %s%s" % (
            si + 1, text.split(".")[0][:70],
            (" | LoRAs " + ", ".join("%s %+.1f" % (x["label"][7:], x["strength"]) for x in slots)) if slots else ""),
            flush=True)
        return pos, model_i

    def build(self, *a, **kw):
        """The run, with ComfyUI's own step preview kept off this node
        (live_preview.no_core_preview says why)."""
        from . import live_preview as _lpq
        with _lpq.no_core_preview():
            return self._build(*a, **kw)

    def _build(self, config="{}", preset=CUSTOM_SENTINEL, prompt=None, extra_pnginfo=None,
              boost_mask_in=None, edit_mask_in=None,
               unique_id=None, subject_caption_in=None, scene_caption_in=None,
               mood_caption_in=None, clip=None, i2i_caption_in=None, vae=None,
               model=None, latent=None, style_in=None, subject_in=None,
               surroundings_in=None, light_and_colour_in=None, image_in=None,
              **_custom_rigs):
        # _custom_rigs: the links the page adds at queue time from RedNode Rig Model
        # nodes (rn_rig_<id>). They only order the run; the records are read by name.
        latent_in = latent
        cfg = parse_config(config)
        # A SHELF WITH OVERRIDE ON speaks for the galleries it names, before anything
        # reads them: the VRAM estimate, the captioner and the sizes all have to see
        # the picture that is actually going to be rendered.
        _shelf_rec = shelf_override(prompt, own=(cfg.get("shelf"), unique_id))
        _shelf_tabs = apply_shelf_override(cfg, _shelf_rec)
        # the Upscale tab's own run, read EARLY: the rig load below happens long
        # before the doors, and an upscale must not drag a model onto the card
        _urt = str(cfg["upscale"].get("run_token") or "")
        _carry_for_save = {}          # a picture's own record, when it brought one
        # Send to Detailer: an upscale-tab run that skips the upscale and lets the
        # builtin chain have the picture, so Detailer, Post and Save run on it
        # exactly as they would on an ordinary render
        _uchain = bool(_urt and cfg["upscale"].get("run_mode") == "chain")
        # AN UPSCALE RUN THAT CARRIES ON. The tab's After a run steps are the
        # builtin chain, so they belong in the SAME queue as the upscale rather
        # than a second one: two queues showed as two runs, with the second one's
        # pipeline full of stages that never fire (the user, 2026-09-20).
        _uafter = bool(_urt and not _uchain
                       and any((cfg["upscale"].get("after") or {}).get(k)
                               for k in ("detailer", "post", "save")))
        # the Run tab's feed (run_events.py): a new run, then each stage as it goes
        from . import run_events as _run
        _run.run_start(node=unique_id, draft=bool(cfg.get("draft")))
        if _shelf_tabs:
            _run.note("The shelf is the picture: %s on %s"
                      % (_shelf_rec["entry"], ", ".join(_shelf_tabs)))
        from . import vram_hold as _hold
        try:
            _est = estimate_vram(cfg, graph_rig_files(prompt))
        except Exception as _ee:
            print("[RedNode Workspace] VRAM estimate failed: %s" % _ee, flush=True)
            _est = None
        _held = _hold.apply(cfg, _est)
        _lim = _hold.limit_gb(cfg)
        if _est and _lim:
            _run.note("Estimated peak about %.1f GB against the %d GB card's %.1f GB limit"
                      % (_est["peak"], _hold.card_gb(cfg), _lim))
        if _held:
            _run.note("Holding under %.1f GB (%s): the weights are held at %.1f GB to leave "
                      "room for the working memory, and ComfyUI keeps %.1f GB free"
                      % (_held[0], _hold.hold_mode(cfg).capitalize(),
                         _hold._current["held"], _held[1] / 1024), "unload")
        elif _lim and _hold.hold_mode(cfg) == "auto":
            if _hold.decide(cfg, _est)[1] == "droppable":
                _run.note("Not holding: what the sampler needs is about %.1f GB, under the "
                          "limit. The rest is the text encoder and SAM3, which ComfyUI "
                          "drops by itself when the card fills" % _est["need"])
            else:
                _run.note("Not holding: the run fits under the limit, so it keeps its speed")
        _taps = cfg["taps"]
        _render_tapped = None     # the picture the Render tap photographed, if any

        def _tap(point, label, img=None, latent=None, model_for=None):
            """One picture for the Stage View, when that tap point is switched on."""
            if not (_taps["on"] and point in _taps["points"]):
                return
            try:
                from . import stages as _stg
                if img is None and latent is not None:
                    # A PASS RESULT IS A LATENT. The rig's VAE draws it properly, which
                    # is what a tap is for: the approximate decoder below posterises and
                    # shifts the colours, and a pass photographed like that is not worth
                    # comparing against the finished picture. A decode of one frame at
                    # this size is a fraction of a second, and the tap is opt-in.
                    _tv = vae if vae is not None else rig_vae
                    if _tv is not None:
                        try:
                            img = vae_images(_tv.decode(latent["samples"][:1]))[:, :, :, :3]
                        except Exception as _de:
                            print("[RedNode Workspace] the %s tap could not decode (%s); "
                                  "drawing it with the preview decoder instead"
                                  % (label, _de), flush=True)
                            img = None
                if img is None and latent is not None and model_for is not None:
                    # no VAE to hand, or it refused: the pack's small preview decoder,
                    # which approximates the picture rather than decoding it
                    from . import live_preview as _lpv
                    _prev, _how = _lpv.our_previewer(model_for)
                    if _prev is None:
                        return
                    _x0 = latent["samples"][:1]
                    _f, _pil, _m = _prev.decode_latent_to_preview_image("PNG", _x0)
                    _arr = np.asarray(_pil.convert("RGB")).astype(np.float32) / 255.0
                    img = torch.from_numpy(_arr)[None]
                    label = "%s (preview)" % label
                if img is not None:
                    _stg.record(img, label, prompt=prompt, source="workspace",
                                px=_taps["px"])
            except Exception as _te:
                print("[RedNode Workspace] the %s tap was skipped: %s" % (label, _te),
                      flush=True)
        # THE MODELS TAB FILLS WHAT IS NOT WIRED, and it must happen FIRST: the auto
        # prompt's CLIP gen and everything after read `clip`, so a fill that arrived
        # just before the LoRA block left them seeing None. A wired input always wins.
        if _urt:
            # AN UPSCALE RUN LOADS NOTHING HERE. Only a tiled pass wants a rig at
            # all, and the Detailer loads its own per pass
            # (refine_pipeline.py, load_active_rig inside the pass loop), so a
            # SeedVR2 or VOSR2 press must not pull a whole model onto the card
            # first and then never touch it. The name is still read, because the
            # log lines and the run record below say which rig the run belongs to.
            _rigs = cfg["models"].get("rigs") or [{}]
            _at = max(0, min(int(cfg["models"].get("active", 0)), len(_rigs) - 1))
            rig_name = str(_rigs[_at].get("name") or "") or "Rig %d" % (_at + 1)
            rig_model = rig_clip = rig_vae = None
        else:
            rig_name, rig_model, rig_clip, rig_vae = load_active_rig(cfg, prompt=prompt)
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
        # the active rig's AuraFlow shift, on whatever model the run samples with
        _rigs0 = cfg["models"]["rigs"]
        _rig0 = _rigs0[cfg["models"]["active"]] if _rigs0 else {}
        _shift0 = float(((_rig0.get("dials") or {}).get("shift")) or 0.0)
        if model is not None and _shift0 > 0:
            model = _dials.apply_shift(model, _shift0)
            print("[RedNode Workspace] rig %r shift %.2f" % (_rig0.get("name") or "", _shift0),
                  flush=True)
        # ONE SEED PER QUEUE, shared by the wildcard picks, the embedded sampler and
        # the built-in paint pass, so a single number reproduces the whole render and
        # Randomize re-rolls all of it together.
        run_seed = (_random.getrandbits(48) if cfg["models"]["seed_random"]
                    else cfg["models"]["seed"])
        _run.info(seed=int(run_seed), rig=rig_name or "")
        # LINKED SEEDS: this queue's number for each named seed, and what each part
        # is linked to; None keeps the part's own seed, as before links existed
        from . import seeds as _seeds
        _seed_vals = _seeds.values(cfg["seeds"], run_seed)
        _linked = {a: _seeds.seed_for(cfg["seeds"], _seed_vals, a) for a in _seeds.AREAS}
        _same_pass = bool(cfg["seeds"]["same_pass"])
        for _a, _v in _linked.items():
            if _v is not None:
                print("[RedNode Workspace] seed: %s takes %s (%d)"
                      % (_a, cfg["seeds"]["links"][_a], _v), flush=True)
        if _linked["auto"] is not None:
            cfg["auto"]["seed"] = int(_linked["auto"]) & 0x7fffffff
        # a linked part's own stage block takes the linked number, fixed
        for _a in ("reangle", "realism", "swap"):
            # cfg["tabs"], not `tabs`: that name is bound further down, and the i2i
            # block is the same dict object either way
            _i2i_blk = cfg["tabs"]["i2i"]
            if _linked[_a] is not None and isinstance(_i2i_blk.get(_a), dict):
                _i2i_blk[_a] = dict(_i2i_blk[_a], seed=int(_linked[_a]), seed_random=False)
        if _linked["upscale"] is not None:
            cfg["upscale"] = dict(cfg["upscale"], seed=int(_linked["upscale"]), seed_random=False)
        if _linked["detailer"] is not None or _same_pass:
            cfg["detailer"] = dict(cfg["detailer"])
            if _linked["detailer"] is not None:
                cfg["detailer"].update(seed=int(_linked["detailer"]), seed_random=False)
            if _same_pass:
                cfg["detailer"]["same_seed"] = True
        _lseed = (lambda v: int(_linked["loras"])) if _linked["loras"] is not None else (lambda v: v)
        # the panel's "Use last queued" and "Copy last seed" read this: the
        # run's seed goes out as an event the moment it is decided
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "rednode-workspace-seed",
                {"node": str(unique_id or ""), "seed": int(run_seed)})
        except Exception:
            pass

        _rigs = cfg["models"]["rigs"]
        _ar = (_rigs[cfg["models"]["active"]] if _rigs
               else {"steps": 8, "cfg": 1.0, "sampler": "euler",
                     "scheduler": "simple", "detailer_steps": 8})
        rig_steps, rig_cfg = _ar["steps"], _ar["cfg"]
        rig_detailer = _ar["detailer_steps"]
        rig_sampler = (_ar["sampler"] if _ar["sampler"]
                       in comfy.samplers.KSampler.SAMPLERS else "euler")
        rig_scheduler = (_ar["scheduler"] if _dials.scheduler_ok(_ar["scheduler"])
                         else "simple")
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
        _tap("refs", "Subject reference", subject)
        scene_words_only = bool(tabs["scene"].get("words_only") and scene is not None)
        if scene_words_only:
            print("[RedNode Workspace] Scene is words only: its picture is captioned, not "
                  "sent as a reference", flush=True)
            scene = None
        i2i_img = tab_image("i2i")
        if i2i_img is not None:
            for _step in SOURCE_STEPS:
                try:
                    _sx = _step(cfg, i2i_img)
                    if _sx is not None:
                        i2i_img = _sx
                except Exception as _se:
                    print("[RedNode Workspace] a source step failed: %s; the source goes on "
                          "as it was" % _se, flush=True)
                    _run.note("A source step failed: %s" % str(_se)[:160], "warn")

        mood = None
        mt = tabs["moodboard"]
        if mt["on"] and mt["images"]:
            if mt["random"] and len(mt["images"]) > 1:
                i = _random.randrange(len(mt["images"]))
                picks["moodboard"] = i
                mood = load_image(mt["images"][i], target)
            elif mt["sel"]:
                mood = batch_images([load_image(mt["images"][i], target) for i in mt["sel"]])

        # the other people: picked in order in the Subject gallery, then any left on the
        # old Person 2 and Person 3 galleries of a workflow saved before they merged
        extra = []
        _st = tabs["subject"]
        if _st["on"] and _st["images"]:
            _main = chosen_index("subject")
            for _k, _i in enumerate(_st.get("extra_sel") or []):
                if _i == _main:
                    continue              # the dice rolled a person already picked
                print(f"[RedNode Workspace] subject: person {_k + 2} is image {_i + 1} "
                      f"of {len(_st['images'])} — {_st['images'][_i]}", flush=True)
                extra.append(load_image(_st["images"][_i], target))
        extra += [img for img in (tab_image("subject2"), tab_image("subject3")) if img is not None]
        if len(extra) >= 3:
            print(f"[RedNode Workspace] {len(extra) + 1} people: the identity edit LoRA "
                  "trained on up to three references, so identities may blend", flush=True)
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

        # The painted edit mask is retired: the Paint tab does in-place edits, with a
        # denoise. A wired edit_mask_in still goes out, with its latent.
        edit = edit_mask_in
        latent = None
        base_hw = edit_base_dims() if edit_mask_in is not None else None
        if base_hw is not None:
            # 4 channels on purpose: comfy's fix_empty_latent_channels() re-shapes it to
            # whatever the sampled model wants, exactly as EmptyLatentImage relies on
            # the 1/8 scale is named so core resizes it for a 1/16 model (Qwen Image 2.1);
            # without it such a model renders at twice the width and height
            latent = {"samples": torch.zeros((1, 4, base_hw[0] // 8, base_hw[1] // 8)),
                      "downscale_ratio_spacial": 8}

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
                _wmsg = ("The Img2Img canvas is set to Wired image, but nothing is wired "
                         "into image_in, so the gallery is used instead.")
                print("[RedNode Workspace] %s" % _wmsg, flush=True)
                _run.note(_wmsg, "warn")
        if it["on"] and not it["prompt_only"] and it["canvas"] == "latent":
            if latent_in is not None:
                latent = latent_in
                denoise_out = it["denoise"]
                print("[RedNode Workspace] i2i canvas: the wired latent, denoise "
                      "%.2f" % denoise_out, flush=True)
            else:
                _wmsg = ("The Img2Img canvas is set to Wired latent, but nothing is wired "
                         "into the latent socket.")
                print("[RedNode Workspace] %s" % _wmsg, flush=True)
                _run.note(_wmsg, "warn")
        if scene is not None:
            _tap("refs", "Scene reference", scene)
        if it["on"] and not it["prompt_only"] and i2i_img is not None:
            _tap("source", "Img2Img source", i2i_img)
        # RE-ANGLE: image to image from a different
        # angle. Before the i2i pass, the source is re-shot by the multi-angle edit
        # model from the camera this tab asks for - the three bands here, or the
        # active prompt row's Camera Studio (a path gives several views, one
        # canvas each). The result IS the i2i source from here on: encode,
        # denoise, passes, the i2i_image output, all unchanged.
        _rg = it.get("reangle") or {}

        def _reangle_cams():
            # the cameras the re-shot takes: none for the bands set on the page, or
            # the Camera tab's Img2Img studio (its own state); an empty one falls
            # back to the active prompt row's studio camera
            _cams = []
            if _rg["camera"] == "studio" and not camera_on(cfg):
                print("[RedNode Workspace] re-angle: the Camera tab is off, "
                      "so the bands are used instead of its studio", flush=True)
            if _rg["camera"] == "studio" and camera_on(cfg):
                # the Camera tab's Img2Img studio (its own state); an empty
                # one falls back to the active prompt row's studio camera
                _cj = _rg.get("studio") or ""
                if not (isinstance(_cj, str) and _cj.strip()):
                    _rrow = prompt_row_for(cfg["models"], cfg["prompts"])
                    _cj = ((_rrow or {}).get("frame") or {}).get("camera")
                if isinstance(_cj, str) and _cj.strip():
                    from .camera_studio import parse_state as _cs_ps
                    from . import camera_translate as _ct_re
                    _cst = _cs_ps(_cj)
                    for _c in _ct_re.camera_path(_cst["camera"], _cst["subjects"], _cst["path"]):
                        _cams.append(json.dumps({"camera": _c, "subjects": _cst["subjects"]}))
                else:
                    print("[RedNode Workspace] re-angle: camera from studio asked, but the "
                          "active prompt row has no studio camera; using the bands", flush=True)
            return _cams

        # EDIT ONLY: set once a source edit (Re-angle or Swap) with Skip the pass
        # has landed, and only where the built-in sampler would have run the pass.
        # It skips the encode and the sampler below, so the rig stays in RAM and
        # the image output is the edited picture itself. An external sampler runs
        # whatever is wired.
        _stage_only = False
        _stage_only_by = ""
        # the words a source stage made the picture from, for the saved record
        _stage_words = None
        # THE EDITOR'S SOURCE: Re-angle, Realism and Swap on the source edit the
        # Editor tab's own picture, one after another. The result is the image
        # output, or, with the hand-off on, the Img2Img pass's source.
        _ed = tabs["editor_src"]
        ed_img = None
        _ed_ran = []
        # NOT ON A PAINT OR UPSCALE RUN: those tabs queue this node with a token of
        # their own and want their own pass, nothing else. A paint Generate was
        # running Realism, Re-angle and Swap first, on the Editor's own picture.
        _own_run = bool(str(cfg["paint"].get("run_token") or "")
                        or str(cfg["upscale"].get("run_token") or ""))
        if not _own_run and any((it.get(_k) or {}).get("on")
               and (it.get(_k) or {}).get("target", "source") == "source"
               for _k in ("reangle", "realism", "swap")):
            ed_img = tab_image("editor_src")
            if ed_img is None:
                print("[RedNode Workspace] editor: no source picture on the Editor tab, "
                      "so its source stages are skipped", flush=True)
            else:
                _tap("editor", "Editor source", ed_img)
        if (_rg.get("on") and ed_img is not None
                and _rg.get("target", "source") == "source"):
            try:
                from . import reangle as _re
                _cams = _reangle_cams()
                _prompts = _re.prompts_for(_rg, _cams)
                _rseed = int(run_seed if _rg["seed_random"] else _rg["seed"])
                _before = tuple(ed_img.shape)
                _run.begin("reangle", "Re-angle", steps=int(_rg["steps"]),
                           batch=len(_prompts))
                ed_img = _re.render(_rg, ed_img, _prompts, _rseed, node_id=unique_id)
                _run.end("reangle", "Re-angle")
                _tap("reangle", "Re-angle result", ed_img)
                _ed_ran.append("re-angle")
                print("[RedNode Workspace] re-angle: %d view(s) from %s -> the edited picture "
                      "(%d x %d)" % (ed_img.shape[0], "the studio" if _cams else "the bands",
                                     ed_img.shape[2], ed_img.shape[1]), flush=True)
            except Exception as exc:
                _run.end("reangle", "Re-angle", "error", error=str(exc)[:200])
                print("[RedNode Workspace] re-angle failed: %s; the source is used as it is"
                      % exc, flush=True)
        # REALISM: an illustration becomes a photograph, through the workflow's
        # own nodes and a conversion LoRA. AFTER Re-angle, so the final viewpoint
        # is what gets converted, and BEFORE Swap, so a face lands on a
        # photograph rather than on cel shading.
        _rl = it.get("realism") or {}
        if _rl.get("on") and ed_img is not None and _rl.get("target", "source") == "source":
            try:
                from . import realism as _rl_mod
                _rseed2 = int(run_seed if _rl["seed_random"] else _rl["seed"])
                _run.begin("realism", "Realism", steps=int(_rl["steps"] or rig_steps))
                ed_img = _rl_mod.render(_rl, ed_img, cfg, _rseed2, node_id=unique_id)
                _run.end("realism", "Realism")
                _tap("realism", "Realism result", ed_img)
                _ed_ran.append("realism")
                print("[RedNode Workspace] realism: the picture is now a photograph "
                      "(%d x %d)" % (ed_img.shape[2], ed_img.shape[1]), flush=True)
            except Exception as exc:
                _run.end("realism", "Realism", "error", error=str(exc)[:200])
                print("[RedNode Workspace] realism failed: %s; the source is used as it is"
                      % exc, flush=True)
        # SWAP: the Subject onto the person in the
        # picture, in the engine where a swap lands - Qwen-Image-Edit + the BFS
        # LoRA - before the Krea 2 pass finishes it with the same Subject at the
        # tab's denoise. After Re-angle on purpose: the face lands on the final
        # viewpoint. The result IS the i2i source from here on, like Re-angle's.
        _sw = it.get("swap") or {}

        def _swap_ref():
            # Person 2 and 3 are the Subject gallery's picks in order, or the old
            # galleries of the same name on a workflow saved before they merged
            if _sw["reference"] == "own":
                return tab_image("swap_ref"), "Swap page's own"
            _people = [subject] + list(extra or [])
            _pk = {"subject": 0, "subject2": 1, "subject3": 2}.get(_sw["reference"], 0)
            return ((_people[_pk] if _pk < len(_people) and _people[_pk] is not None
                     else tab_image(_sw["reference"])),
                    _sw["reference"].replace("subject", "Subject ").strip())
        if (_sw.get("on") and ed_img is not None
                and _sw.get("target", "source") == "source"):
            _ref, _ref_name = _swap_ref()
            if _ref is None:
                print("[RedNode Workspace] swap: the %s gallery is off or empty, so there "
                      "is no reference; the source is used as it is" % _ref_name, flush=True)
            else:
                try:
                    from . import swap as _swap
                    _sseed = int(run_seed if _sw["seed_random"] else _sw["seed"])
                    _run.begin("swap", "Swap", steps=int(_sw["steps"]),
                               batch=int(ed_img.shape[0]))
                    ed_img = _swap.render(_sw, ed_img, _ref, _sseed, node_id=unique_id)
                    _run.end("swap", "Swap")
                    _tap("swap", "Swap result", ed_img)
                    _ed_ran.append("swap")
                    print("[RedNode Workspace] swap: %d frame(s), %s from the %s tab -> "
                          "the edited picture (%d x %d)" % (ed_img.shape[0], _sw["mode"],
                                                        _sw["reference"], ed_img.shape[2],
                                                        ed_img.shape[1]), flush=True)
                except Exception as exc:
                    _run.end("swap", "Swap", "error", error=str(exc)[:200])
                    print("[RedNode Workspace] swap failed: %s; the source is used as it is"
                          % exc, flush=True)

        # THE EDITED PICTURE IS THE IMAGE OUTPUT: the Editor is not Img2Img, so no
        # encode and no i2i pass, and the rig never shares the card with the edit
        # model. The Detailer and Post FX still run on it.
        if _ed_ran:
            i2i_img = ed_img
            if cfg["models"]["sampler_mode"] == "internal":
                _stage_only = True
                _stage_only_by = _ed_ran[-1]
                if _ed_ran[-1] == "realism":
                    _stage_words = {"positive": str(_rl.get("prompt") or "").strip(),
                                    "negative": ""}
            else:
                print("[RedNode Workspace] editor: the external sampler runs as wired, "
                      "with the edited picture on i2i_image", flush=True)

        def _edit_off():
            # the Qwen edit model is done for this run: off the card, kept in RAM
            try:
                from . import reangle as _ra_off
                if _ra_off.unload_from_card():
                    print("[RedNode Workspace] the edit model left the card for the rest "
                          "of the run (kept in RAM)", flush=True)
            except Exception as exc:
                print("[RedNode Workspace] could not move the edit model off the card: %s"
                      % exc, flush=True)
        if not ((_sw.get("on") and _sw.get("target") == "render")
                or (_rg.get("on") and _rg.get("target") == "render")):
            _edit_off()
        real_i2i = it["on"] and i2i_img is not None and not it["prompt_only"]
        # THE I2I PAIR takes over from here on: the built-in sampler, the paint
        # render, the sampler_name and scheduler sockets, and through those the
        # Studio Detailer, which inherits whatever the rig hands it. One switch, so
        # nothing downstream has to ask which kind of run this was. A blank canvas
        # keeps the main pair, refine passes and all: those are a generation that
        # then tidies up after itself, not an image to image run.
        if real_i2i:
            _i2i_s = str(_ar.get("i2i_sampler") or "")
            _i2i_c = str(_ar.get("i2i_scheduler") or "")
            _swapped = []
            if _i2i_s and _i2i_s in comfy.samplers.KSampler.SAMPLERS:
                if _i2i_s != rig_sampler:
                    _swapped.append("sampler %s -> %s" % (rig_sampler, _i2i_s))
                rig_sampler = _i2i_s
            elif _i2i_s:
                print("[RedNode Workspace] the rig's i2i sampler %r is not one this "
                      "build has, so the main sampler is used" % _i2i_s, flush=True)
            if _i2i_c and _dials.scheduler_ok(_i2i_c):
                if _i2i_c != rig_scheduler:
                    _swapped.append("scheduler %s -> %s" % (rig_scheduler, _i2i_c))
                rig_scheduler = _i2i_c
            elif _i2i_c:
                print("[RedNode Workspace] the rig's i2i scheduler %r is not one this "
                      "build has, so the main scheduler is used" % _i2i_c, flush=True)
            if _swapped:
                print("[RedNode Workspace] image to image run, so the rig's i2i pair "
                      "takes over: %s" % ", ".join(_swapped), flush=True)
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

        # An ENGINE rig (external, or a handled kind like the personal NAI rig) is
        # the cockpit for a renderer that is not a loaded checkpoint: the denoise
        # socket and the handler both read ITS strength dial.
        #
        # A "node" rig is NOT one of those, however much it looks like one here. It
        # samples through your own wired nodes, off this very socket, and the Models
        # tab shows it no strength dial at all — so this was handing it a 1.0 nobody
        # set and throwing the Img2Img denoise away (you, 2026-09-23). Every other
        # test in this file reads "external or a handled kind"; this one had drifted.
        if _ar.get("kind") == "external" or _ar.get("kind") in RIG_KIND_HANDLERS:
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
                _wmsg = ("The Latent tab is set to the wired input, but nothing is wired "
                         "into the latent socket, so the canvas is built here instead.")
                print("[RedNode Workspace] %s" % _wmsg, flush=True)
                _run.note(_wmsg, "warn")

        if latent is None and cfg["latent"]["on"]:
            lc = cfg["latent"]
            lw, lh = lc["w"], lc["h"]
            if lc["random"]:
                lw, lh = LATENT_PRESETS[_random.randrange(len(LATENT_PRESETS))]
            # the scale slider multiplies the base canvas; 2.0 is four times the pixels
            lw = int(lw * lc["scale"]) // 8 * 8
            lh = int(lh * lc["scale"]) // 8 * 8
            # WITH A SCALE PER PASS, pass 1's entry is the size the canvas is BUILT at,
            # not a ratio against it, so a first pass of 0.5 drafts small and the passes
            # after it climb from there. Every later pass is a ratio against this one.
            if lc.get("scale_custom") and lc.get("passes", 1) > 1:
                _p1 = float(lc["pass_scale"][0])
                if abs(_p1 - 1.0) > 1e-6:
                    lw = max(256, int(lw * _p1)) // 8 * 8
                    lh = max(256, int(lh * _p1)) // 8 * 8
                    print(f"[RedNode Workspace] latent pass 1 at {_p1:.2f}x: "
                          f"the canvas is built {lw} x {lh}", flush=True)
            if lc["random"]:
                picks["latent"] = f"{lw} x {lh}"
                print(f"[RedNode Workspace] rolled latent size: {lw} x {lh}", flush=True)
            latent = {"samples": torch.zeros((lc["batch"], 4, lh // 8, lw // 8)),
                      "downscale_ratio_spacial": 8}

        # output_latent must never leave here as None. It used to be allowed to, and a
        # None travelling down a LATENT wire does not fail here where the cause is: it
        # fails inside whatever sampler received it, as "'NoneType' object is not
        # subscriptable", which points at the wrong node entirely. If every claim above
        # declined, hand out a plain canvas and say loudly why, so the run completes and
        # the console explains itself.
        # Only when a real i2i pass was ASKED FOR and could not be delivered. Everything
        # off still outputs nothing, which is the documented behaviour and the honest
        # one: inventing a canvas nobody asked for would silently generate at the wrong
        # size. But if the Img2Img tab is on and set to a real pass, you are plainly
        # expecting a latent, so give one at the source's own size rather than a None.
        if latent is None and it["on"] and not it["prompt_only"]:
            fw = fh = int(cfg["resize"] or 1024) or 1024
            if i2i_img is not None:
                fh, fw = int(i2i_img.shape[1]) // 8 * 8, int(i2i_img.shape[2]) // 8 * 8
            latent = {"samples": torch.zeros((1, 4, max(8, fh // 8), max(8, fw // 8))),
                      "downscale_ratio_spacial": 8}
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
            # no pull above 1.0; a fidelity below it only loosens, so it stays
            settings["reference_fidelity"] = min(1.0, float(settings.get("reference_fidelity", 1.0)))
            settings["scene_fidelity"] = min(1.0, float(settings.get("scene_fidelity", 1.0)))
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
        subject_people = []          # [(name, caption)] for the Subject's picked people
        mood_parts = {}              # Moodboard read -> its joined captions
        people_caps = {}             # picture -> its caption, for the panel
        # Ollama across several tabs: keep the model resident for the run instead of
        # letting keep_alive 0 unload and reload it per tab. Four reloads of a vision
        # model while the sampler holds its own VRAM is what turns captioning from
        # slow into stuck. It is released again below.
        ga0 = cfg["auto"]
        ollama_tabs = [n for n in AUTO_TABS
                       if tabs[n]["auto"]["on"] and tabs[n]["auto"]["ollama"]
                       and tabs[n]["on"]]
        run_keep_alive = max(300, int(ga0["keep_alive"])) if ollama_tabs else \
            int(ga0["keep_alive"])
        low_vram = bool(ga0.get("low_vram"))
        captioning = [n for n in AUTO_TABS
                      if tabs[n]["on"] and tabs[n]["auto"]["on"] and tabs[n]["images"]
                      and any(tabs[n]["auto"][k] for k in ("ollama", "wd14", "joy", "qwen",
                                                           "florence"))]
        if low_vram and captioning:
            # a cached caption costs nothing, but there is no cheap way to know that
            # ahead, so the card is cleared whenever an engine could run
            try:
                import comfy.model_management as _mm
                _mm.unload_all_models()
            except Exception as _ue:
                print("[RedNode Workspace] low VRAM captioning: could not unload the "
                      "models (%s)" % _ue, flush=True)
            autoprompt.free_vram()
            _run.note("Low VRAM captioning: models unloaded before the captioners", "unload")
            print("[RedNode Workspace] low VRAM captioning: models unloaded before the "
                  "auto prompt engines run (%s)" % ", ".join(captioning), flush=True)
        if captioning:
            _run.begin("captions", "Captions", tabs=list(captioning))
        for tab_name in AUTO_TABS:
            t = tabs[tab_name]
            a = t["auto"]
            wired = [wired_map[tab_name]] if wired_map.get(tab_name) else []
            if not (a["on"] and t["on"] and (t["images"] or wired)):
                # a wired caption is text you plumbed in by hand, so it ALWAYS
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
            # WHO IS CAPTIONED: the one picture on most tabs; on Subject, every picked
            # person whose auto prompt is on (the main one by default), each by name
            # a words-only Scene loads its own picture: none went out as a reference
            targets = [(0, entry, tab_name == "scene" and scene_words_only, a["mode"])]
            if tab_name == "subject" and entry:
                _meta = t.get("people_meta") or {}
                _people = [idx] + [i for i in (t.get("extra_sel") or []) if i != idx]
                targets = []
                for _k, _i in enumerate(_people):
                    _pm = _meta.get(t["images"][_i]) or {}
                    _on = _pm.get("auto")
                    if (_k == 0) if _on is None else _on:
                        targets.append((_k, t["images"][_i], _k > 0, a["mode"]))
            if tab_name == "moodboard" and entry:
                # every picture in the batch (the rolled one when random), once per
                # read switched on for it
                _pmeta = t.get("pic_meta") or {}
                _idx = chosen_index(tab_name)
                _batch = _idx if isinstance(_idx, list) else [_idx]
                targets = [(_k, t["images"][_i], True, _m)
                           for _k, _i in enumerate(_batch)
                           for _m in mood_reads(_pmeta.get(t["images"][_i]), a["mode"])]
                if not targets and wired:
                    targets = [(0, None, False, a["mode"])]
            if tab_name in TEXT_TABS and entry:
                # IMAGE TO TEXT: every picked picture, each loading its own
                _idx = chosen_index(tab_name)
                _batch = _idx if isinstance(_idx, list) else [_idx]
                targets = [(_k, t["images"][_i], True, a["mode"])
                           for _k, _i in enumerate(_batch)]
            ga = cfg["auto"]

            # every tensor engine needs the image, not just WD14 — gating on WD14 alone
            # silently starved CLIP gen, JoyCaption and QwenVL of their input. And the
            # moodboard tensor is a BATCH: caption its first ref (the resolved entry).
            need_tensor = (a["wd14"] or a["joy"] or a["qwen"] or a["clipgen"]
                           or a["florence"])
            _caps = []
            for _n, (_k, entry, _own_img, _mode) in enumerate(targets):
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
                t_img = ((load_image(entry, target) if _own_img else tensor_map[tab_name])
                         if need_tensor else None)
                if t_img is not None and t_img.shape[0] > 1:
                    t_img = t_img[:1]

                # a wired caption joins once, not once per picture
                def _build(a=a, img_bytes=img_bytes, tab_name=tab_name,
                           wired=(wired if _n == 0 else []), ga=ga,
                           t_img=t_img, entry=entry, mtime=mtime, mode=_mode):
                    return autoprompt.build_prompt(
                        mode, image_bytes=img_bytes,
                        image_tensor=t_img,
                        wired=wired, use_ollama=a["ollama"], use_wd14=a["wd14"],
                        use_joy=a["joy"], use_qwen=a["qwen"],
                        use_clip=a["clipgen"], clip=clip,
                        use_florence=a["florence"],
                        florence_opts={"model": ga["florence_model"], "task": ga["florence_task"]},
                        unload_heavy=ga["wd14_unload"] or low_vram,
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
                                  "caption_length": ga["joy_length"],
                                  "memory": "Clear After Run" if low_vram else ga["joy_memory"],
                                  "use_mode_prompt": ga["joy_mode_prompts"]},
                        instruction=ga["instruction"], question=ga["question"],
                        # cache_base stays exactly as it was. build_prompt folds the
                        # instruction into Ollama's own key, and only once one is typed,
                        # so nobody's saved captions move.
                        cache_base=[tab_name, entry, mtime, mode, ga["frank"]],
                        use_cache=a["fixed"],
                        sidecar=(_filepath(entry) + ".rn.json")
                                if entry and _managed(entry) else None)

                # per-engine caching happens INSIDE build_prompt now: the key carries the
                # image and mode, so toggling one engine reuses every other engine's part.
                # FRESH (fixed off) rebuilds but still stores, so flipping back is warm.
                _cap = _build()
                if _cap:
                    _caps.append((_k, entry, _cap, _mode))
            if tab_name == "subject" and targets:
                _meta = t.get("people_meta") or {}
                subject_people = [((_meta.get(e) or {}).get("name") or "Person %d" % (k + 1), c)
                                  for k, e, c, _m in _caps]
                people_caps.update({e: c for _, e, c, _m in _caps})
                _named = any((_meta.get(e) or {}).get("name") for _, e, _c, _m in _caps)
                if len(_caps) == 1 and _caps[0][0] == 0 and not _named:
                    prompts[tab_name] = _caps[0][2]           # one person: as it always was
                else:
                    prompts[tab_name] = "\n".join("%s: %s" % p for p in subject_people)
            elif tab_name in TEXT_TABS:
                people_caps.update({"%s|%s" % (e, m): c for _, e, c, m in _caps})
                prompts[tab_name] = "\n".join(c for _, _, c, _m in _caps)
            elif tab_name == "moodboard" and targets and targets[0][1]:
                # the panel shows each read's caption under its picture
                people_caps.update({"%s|%s" % (e, m): c for _, e, c, m in _caps})
                for m0 in MOOD_READS:
                    _joined = "\n".join(c for _, _, c, m in _caps if m == m0)
                    if _joined:
                        mood_parts[m0] = _joined
                prompts[tab_name] = "\n".join(mood_parts.values())
            else:
                prompts[tab_name] = _caps[0][2] if _caps else ""
            if prompts[tab_name]:
                # the caption itself is only echoed when asked for: it is your
                # writing about your picture, and a console is a public place
                # the moment a screenshot is taken
                if tab_name in captioning:
                    _run.note("%s caption made (%d words)"
                              % (RUN_TAB_NAMES.get(tab_name, tab_name),
                                 len(prompts[tab_name].split())))
                if cfg["dials"].get("echo_prompts", True):
                    print(f"[RedNode Workspace] auto prompt ({tab_name}/{a['mode']}): "
                          f"{prompts[tab_name][:100]}...", flush=True)
                else:
                    print(f"[RedNode Workspace] auto prompt ({tab_name}/{a['mode']}): "
                          f"{len(prompts[tab_name])} characters", flush=True)
        if captioning:
            _run.end("captions", "Captions")
        # hand the VRAM back if that is what you asked for; holding it was only
        # ever to get through this run's tabs on one load
        if ollama_tabs and (int(ga0["keep_alive"]) <= 0 or low_vram):
            autoprompt.ollama_unload(ga0["model"], ga0["url"])
        if low_vram and captioning:
            # every engine off the card before the sampler loads the model again
            autoprompt.release_engines("", ga0["url"])
            print("[RedNode Workspace] low VRAM captioning: the engines are unloaded; "
                  "the main model loads again for sampling", flush=True)

        any_engines = any(
            tabs[n]["auto"]["on"] and (tabs[n]["auto"]["wd14"] or tabs[n]["auto"]["ollama"]
                                       or tabs[n]["auto"]["joy"] or tabs[n]["auto"]["qwen"]
                                       or tabs[n]["auto"]["florence"])
            for n in AUTO_TABS)
        # STYLE LOCK: the moodboard's prompt is the style authority. Style vocabulary in
        # the subject and scene prompts that the mood prompt does not itself use is
        # scrubbed (or LLM-rewritten), so an image-to-image source cannot smuggle its
        # own style past the moodboard.
        lock = cfg["auto"]["style_lock"]
        if lock != "off" and prompts.get("moodboard"):
            mood_text = prompts["moodboard"]
            for tab_name in ("subject", "scene", "i2i", "text_subject", "text_scene"):
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
        rewrite_people = {}          # row name -> the named people to merge into it
        injections_before = {}       # the same, for captions that go ahead of the typed words
        def _inject_row_of(_a):
            """The row this tab's caption joins: its own answer, or the rig's.

            Resolved once per tab here rather than stored, so a rig switch moves
            every caption with it; an unresolvable one is "nowhere", never the
            first row, because guessing would put words in a stranger's prompt.
            """
            _r = str(_a.get("inject_row") or "")
            if _r != AUTO_ROW:
                return _r
            _t = prompt_row_for(cfg["models"], cfg["prompts"])
            if _t is None and cfg["prompts"]["rows"]:
                _t = cfg["prompts"]["rows"][0]
            return str((_t or {}).get("name") or "")

        for _tn in AUTO_TABS:
            _a = tabs[_tn].get("auto") or {}
            _cap = (prompts.get(_tn) or "").strip()
            _irow = _inject_row_of(_a)
            if (_tn == "subject" and _a.get("on") and _irow
                    and _a.get("rewrite") and subject_people):
                rewrite_people[_irow] = (subject_people, bool(_a.get("fixed", True)))
                continue
            if not (_a.get("on") and _irow and _cap):
                continue
            _into = (injections_before if _a.get("inject_pos") == "before"
                     else injections).setdefault(_irow, {})
            if _tn == "moodboard" and mood_parts:
                # each read lands in its own slot: the look as Style, the person as
                # Subject, what is happening as Surroundings
                _slots = _a.get("inject_slots") or MOOD_SLOT_DEFAULTS
                for _m, _text in mood_parts.items():
                    _into.setdefault(_slots.get(_m, MOOD_SLOT_DEFAULTS[_m]), []).append(_text)
            else:
                _into.setdefault(_a.get("inject_slot", "subject"), []).append(_cap)
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
            _pre = injections_before.get(_row["name"]) or {}
            # ALWAYS RE-ASSEMBLE A KREA 2 ROW WITH A FRAME AT QUEUE TIME. The
            # row's text is the panel's last preview; with the studio on its own
            # Camera tab, moving the camera there changed the studio state but
            # not that text, so the queue rendered a stale paragraph (your
            # "height changes nothing" and then "everything is overhead", both
            # 2026-08-18). The frame + studio state are the truth; the text is a
            # cache of them.
            _fr0 = _row.get("frame") if isinstance(_row.get("frame"), dict) else {}
            _has_frame = (_row["kind"] == "krea2"
                          and any(str(_fr0.get(k) or "").strip()
                                  for k in ("subject", "surroundings", "style", "light_and_colour", "placement")))
            if not _hit and not _pre and not _has_frame:
                continue
            _row["_assembled"] = True        # camera state and captions are in its text now
            # a caption set to go BEFORE the typed words leads the slot it joins
            _lead = lambda key, typed: ", ".join(
                [c for c in _pre.get(key, []) if c] + ([typed] if typed else []))
            _hit = _hit or {}
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
                        subject=_lead("subject", str(_fr.get("subject") or "")),
                        surroundings=_lead("surroundings", str(_fr.get("surroundings") or "")),
                        framing=str(_fr.get("framing") or "Balanced"),
                        placement=str(_fr.get("placement") or ""),
                        light_and_colour=_lead("light_and_colour",
                                               str(_fr.get("light_and_colour") or "")),
                        placement_where=str(_fr.get("placement_where") or "None"),
                        placement_what=str(_fr.get("placement_what") or "None"),
                        lighting=str(_fr.get("lighting") or "None"),
                        brightness=int(_fr.get("brightness") or 0),
                        style=str(_fr.get("style") or "None"),
                        style_extra=str(_fr.get("style_extra") or ""),
                        framing_push=str(_fr.get("framing_push") or "Off"),
                        # the camera: the Camera Studio state when set, else the
                        # simple height stop. Missing here meant the studio's
                        # paragraph vanished from the QUEUED prompt whenever the
                        # auto prompt re-assembled the frame
                        camera_height=("Eye level" if _fr.get("camera_off")
                                       else str(_fr.get("camera_height") or "Eye level")),
                        camera=(str(_fr.get("camera") or "")
                                if camera_on(cfg) and not _fr.get("camera_off") else ""),
                        camera_off=bool(_fr.get("camera_off")),
                        extra=str(_fr.get("extra") or ""),
                        style_in=_ins.get("style", ""),
                        subject_in=_ins.get("subject", ""),
                        surroundings_in=_ins.get("surroundings", ""),
                        light_and_colour_in=", ".join(
                            x for x in (_ins.get("light_and_colour", ""), _extra) if x),
                        seed=run_seed)
                    if _pre.get("prompt"):
                        _row["text"] = ", ".join(_pre["prompt"] + [_row["text"]])
                    if _hit or _pre:
                        print("[RedNode Workspace] auto prompt injected into %r"
                              % (_row["name"] or "a prompt row"), flush=True)
                except Exception as exc:
                    print("[RedNode Workspace] could not re-assemble %r: %s"
                          % (_row["name"], exc), flush=True)
            elif _flat or _pre:
                _t = _row["text"].strip().rstrip(",")
                _first = ", ".join(c for k in ("style", "subject", "surroundings",
                                               "light_and_colour", "prompt")
                                   for c in _pre.get(k, []))
                _row["text"] = ", ".join(x for x in (_first, _t, _flat) if x)
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
                # THE NEGATIVE TOO. It is a prompt box like any other and it was
                # the one that never resolved, so a __wildcard__ typed there
                # reached the model as its own name. Offset by one so the two
                # boxes do not draw the same line from the same file.
                if _row.get("negative"):
                    _row["negative"] = _pf_expand(_row["negative"], run_seed + 1, True)
        except Exception as exc:
            print("[RedNode Workspace] wildcard resolve failed: %s" % exc, flush=True)

        # THE PEOPLE REWRITE: the row and the named people's captions, merged by
        # Ollama into one prompt that uses the names. Once, then reused, unless the
        # Subject auto prompt is on Fresh. Without an answer the captions are appended.
        for _row in cfg["prompts"]["rows"]:
            _rp = rewrite_people.get(_row["name"])
            if not _rp:
                continue
            _merged = autoprompt.merge_people(
                _row["text"], _rp[0], model=cfg["auto"]["model"], url=cfg["auto"]["url"],
                keep_alive=cfg["auto"]["keep_alive"], reuse=_rp[1])
            if _merged:
                _row["text"] = _merged
                print("[RedNode Workspace] %r rewritten with %s"
                      % (_row["name"] or "a prompt row",
                         ", ".join(n for n, _c in _rp[0])), flush=True)
            else:
                _t = _row["text"].strip().rstrip(",")
                _add = " ".join("%s: %s." % (n, c.rstrip(".")) for n, c in _rp[0])
                _row["text"] = (_t + ". " + _add) if _t else _add

        # THE FINAL PROMPT, the Editor's Converter page: the active rig's row as it
        # will be encoded, every caption, wildcard and people merge in. The local
        # model's rewrite first when switched on, then the converter, so a swap or a
        # rule of your own has the last word. Not on a paint or upscale run, and not
        # when an Editor edit is the output, which no prompt makes.
        _final_before = None
        _frow = prompt_row_for(cfg["models"], cfg["prompts"], "")
        if (_frow is not None and cfg["final"]["on"] and not _stage_only
                and not cfg["paint"].get("run_token") and not _urt):
            from .prompt_sort import finish_prompt as _finish
            _ftext, _fdid, _fwarn = _finish(
                _frow["text"], cfg["final"], model=cfg["auto"]["model"],
                url=cfg["auto"]["url"], keep_alive=cfg["auto"]["keep_alive"])
            if _fwarn:
                _run.note(_fwarn, "warn")
            if _ftext != _frow["text"]:
                _final_before = _frow["text"]
                _frow["text"] = _ftext
                print("[RedNode Workspace] final prompt: %s" % ", ".join(_fdid), flush=True)

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
        # THE ACTIVE RIG'S SET: Main, or the named LoRAs-tab set it picked
        lc = lora_set_cfg(cfg, rig_lora_set(cfg))
        if lc["name"] != MAIN_SET:
            print("[RedNode Workspace] LoRA set %r for this rig" % lc["name"], flush=True)
        # THE CAMERA'S LORAS: the active prompt row's Camera Studio may switch
        # on up to four slider LoRAs (zoom / height / orbit / back), each at a
        # strength that is auto from the geometry or set by hand. They join the
        # rig's stack as extra slots for this run, so the camera drives them
        # and nobody touches the LoRA tab. Missing files are the stack's own
        # business (it reports and skips, like any slot).
        _cam_slots = []
        # THE CAMERA PATH IN THE WORKSPACE ("the path only
        # makes one image here"): when the active prompt's studio has a path,
        # the built-in sampler renders every shot - its own camera words and
        # its own LoRA strengths per shot - and the image output is the batch.
        # _shot_states holds one studio state per shot (the path removed);
        # _cam_slots are the FIRST shot's, applied to the model output as
        # before; the loop below re-applies per shot on the pre-camera model.
        _shot_states = []
        _cam_state_row = None
        try:
            _zrow = prompt_row_for(cfg["models"], cfg["prompts"])
            _zfr = (_zrow or {}).get("frame") or {}
            _zcam = (_zfr.get("camera")
                     if camera_on(cfg) and not _zfr.get("camera_off") else None)
            if _zfr.get("camera") and not camera_on(cfg):
                print("[RedNode Workspace] the Camera tab is off: no camera "
                      "paragraph, no camera LoRAs, no path", flush=True)
            elif _zfr.get("camera") and _zfr.get("camera_off"):
                print("[RedNode Workspace] the row's Camera words are off: no "
                      "camera paragraph, no camera LoRAs, no path", flush=True)
            if isinstance(_zcam, str) and _zcam.strip():
                from .camera_studio import parse_state as _cs_parse, \
                    resolve_camera_loras as _cs_loras, \
                    resolve_light_loras as _cs_light_loras
                from . import camera_translate as _ct_path
                _cst = _cs_parse(_zcam)
                _cam_state_row = _zrow
                _cams = _ct_path.camera_path(_cst["camera"], _cst["subjects"], _cst["path"])
                for _c in _cams:
                    _shot_states.append(dict(_cst, camera=_c, path={"mode": "off", "shots": 1}))
                for _e in _cs_loras(_shot_states[0]):
                    _cam_slots.append({"name": _e["name"], "strength": float(_e["strength"]),
                                       "enabled": True, "type": "lora",
                                       "label": "camera %s" % _e["key"]})
                # THE LIGHTING LORAS ride the same road: extra slots for this
                # run, driven by the light rig rather than the camera. They are
                # on the Camera tab, so the tab's master switch covers them too.
                for _e in _cs_light_loras(_cst):
                    _cam_slots.append({"name": _e["name"], "strength": float(_e["strength"]),
                                       "enabled": True, "type": "lora",
                                       "label": "light %s" % _e["key"]})
                if _cam_slots:
                    print("[RedNode Workspace] camera / light LoRAs: "
                          + ", ".join("%s @ %+.1f" % (x["label"][7:], x["strength"]) for x in _cam_slots)
                          + (" (shot 1 of %d)" % len(_shot_states) if len(_shot_states) > 1 else ""),
                          flush=True)
        except Exception as _ze:
            print("[RedNode Workspace] camera LoRAs skipped: %s" % _ze, flush=True)
        # A PATH RENDERS ONLY IN THE BUILT-IN SAMPLER: the shots are rendered
        # inside this node, one each. An external sampler gets one conditioning
        # and one canvas, so a path there is shot 1 and nothing else, which
        # reads as "the path only made one image" unless it is said here.
        if len(_shot_states) > 1 and cfg["models"]["sampler_mode"] != "internal":
            print("[RedNode Workspace] camera path: %d shots, but the sampler is "
                  "external, so only shot 1 leaves this node; the built-in sampler "
                  "(Models tab) renders every shot as a batch" % len(_shot_states),
                  flush=True)
        _base_lc = lc                       # the tab's own stack, no camera slots
        if _cam_slots:
            lc = dict(lc, on=True, slots=list(lc["slots"]) + _cam_slots)
        n_lora = sum(1 for x in lc["slots"] if x.get("type") != "title")
        _model_pre_camera = model
        if model is not None and lc["on"] and lc["slots"]:
            # the CLIP goes in too when it is wired: plenty of LoRAs carry text
            # encoder weights, and dropping them applies half the LoRA while
            # looking like it worked
            # pass OUR node id, so the rolls a random slot drew come back to this
            # panel: the tab hosts the same list and wants the same highlight
            if len(_shot_states) > 1 and _cam_slots and _base_lc["on"] and _base_lc["slots"]:
                # a path: the tab's stack once, kept as the pre-camera model, and
                # the first shot's camera slots on top of it for the model output
                _model_pre_camera, lora_clip, lora_words, _applied = _lora.apply_stack(
                    model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": _base_lc["ui"], "slots": _base_lc["slots"]}),
                    _lseed(_base_lc["seed"]), unique_id, tag="Workspace LoRAs")
                model, _, _cw, _ca = _lora.apply_stack(
                    _model_pre_camera, None, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": lc["ui"], "slots": _cam_slots}),
                    _lseed(lc["seed"]), unique_id, tag="Workspace camera LoRAs")
            elif len(_shot_states) > 1 and _cam_slots:
                # a path with the tab's stack off: the wired model is the pre-camera one
                model, _, lora_words, _applied = _lora.apply_stack(
                    model, None, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": lc["ui"], "slots": _cam_slots}),
                    _lseed(lc["seed"]), unique_id, tag="Workspace camera LoRAs")
                lora_clip = clip
            else:
                model, lora_clip, lora_words, _applied = _lora.apply_stack(
                    model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": lc["ui"], "slots": lc["slots"]}),
                    _lseed(lc["seed"]), unique_id, tag="Workspace LoRAs")
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
        _paint_set = str(cfg["paint"].get("lora_set") or "")
        _pl = None
        if paint_mode == "main" and _paint_set and raw_model is not None \
                and lora_set_cfg(cfg, _paint_set, "Paint")["name"] != _base_lc["name"]:
            # main mode naming a DIFFERENT set than the rig's: that set on the
            # raw model, so the paint pass carries its own LoRAs, main untouched
            _pl = lora_set_cfg(cfg, _paint_set, "Paint")
            if _pl["slots"]:
                paint_model, _paint_clip, _pw, _pa = _lora.apply_stack(
                    raw_model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": _pl["ui"], "slots": _pl["slots"]}),
                    _lseed(_pl["seed"]), unique_id, tag="Workspace paint LoRAs (set %s)" % _pl["name"])
                paint_clip = _paint_clip if _paint_clip is not None else clip
            else:
                paint_model = raw_model
                print("[RedNode Workspace] paint LoRA set %r is empty, so the paint "
                      "branch carries no LoRAs" % _pl["name"], flush=True)
        if paint_mode == "paint":
            if raw_model is not None and pls["slots"]:
                paint_model, _paint_clip, _pw, _pa = _lora.apply_stack(
                    raw_model, clip, _lora.CUSTOM_SENTINEL,
                    json.dumps({"ui": pls["ui"], "slots": pls["slots"]}),
                    _lseed(pls["seed"]), unique_id, tag="Workspace Paint LoRAs")
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
            # A SWITCHED-OFF TAB CONVERTS NOTHING. A caption wired in by hand passes
            # through even with the tab off, on purpose, but the Converter page says
            # in as many words that nothing on it is used while the tab is off, and
            # its dot reads dark. It was still swapping genders, converting styles and
            # stripping terms against the moodboard on the way past.
            if not tabs[tab_name].get("on"):
                continue
            if not (prompts.get(tab_name) and conv and conv.get("on", True)):
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
                    "rednode.workspace_prompts", {"node": unique_id, "prompts": prompts,
                                                  "people": people_caps})
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
        _enc_err = _samp_err = None
        _no_vae = False
        _prow = prompt_row_for(cfg["models"], cfg["prompts"])
        if _prow is None and any(str(r.get("text") or "").strip()
                                 for r in cfg["prompts"]["rows"]):
            print("[RedNode Workspace] no prompt row serves the rig %r: every row with words "
                  "is linked to another rig, so the prompt is empty this run. Link a row to "
                  "this rig on the Prompts tab, or unlink one so it serves any rig."
                  % (rig_name or "(active)"), flush=True)
        # THE CAMERA WORDS OFF, by the tab's switch or the row's: the panel bakes
        # the studio paragraph and the height stop into the row's text as it
        # previews, so the switch has to strip them here as well as skip the
        # LoRAs and the path. The frame runs again with no camera.
        _pfr = (_prow or {}).get("frame") or {}
        if (_prow and _prow.get("kind") == "krea2" and _pfr
                and not _prow.get("_assembled")
                and (_pfr.get("camera_off")
                     or (_pfr.get("camera") and not camera_on(cfg)))):
            _prow = dict(_prow, text=self._shot_text(None, _prow, run_seed))
        _mode = cfg["models"]["sampler_mode"]
        # THE MODEL DECIDES THE ENCODE, the same rule the reference toggles follow:
        # a krea2 CLIP type gets the Studio identity system, refs and all; any other
        # rig gets core's plain text encode, because feeding an XL clip into the
        # Krea 2 encoder is a hard error about a model nobody chose.
        _rigs_now = cfg["models"]["rigs"]
        _rig_is_krea2 = (not _rigs_now
                         or _rigs_now[cfg["models"]["active"]].get("clip_type")
                         == "krea2")
        if (_rigs_now and _rig_is_krea2 and (subject is not None or scene is not None)
                and not rig_is_official(_rigs_now[cfg["models"]["active"]])):
            print("[RedNode Workspace] identity: the rig '%s' is not marked as the "
                  "official Krea 2 model. Subject and Scene references rarely land on "
                  "community mixes; render on the official Turbo, or mark the rig "
                  "official on the Models tab if it is."
                  % _rigs_now[cfg["models"]["active"]]["name"], flush=True)
        _enc_on = bool(clip is not None and not _stage_only and (
            _mode == "internal" or (_prow or {}).get("text", "").strip()))
        if _enc_on:
            _run.begin("encode", "Encode", krea2=bool(_rig_is_krea2))
        if _enc_on:
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
                    positive = plain_encode(_enc_clip, (_prow or {}).get("text", ""))
                    negative = plain_encode(_enc_clip, (_prow or {}).get("negative", ""))
                    print("[RedNode Workspace] %s for %r: not a Krea 2 rig, so the "
                          "Studio identity system sits out"
                          % ("Qwen Image 2.1 encode" if is_qwen21_clip(_enc_clip)
                             else "plain text encode", rig_name or "this rig"), flush=True)
            except Exception as exc:
                _enc_err = exc
                print("[RedNode Workspace] built-in encode failed: %s" % exc,
                      flush=True)
            _run.end("encode", "Encode", "error" if _enc_err is not None else "done")
            if _hold.before_sampling(cfg):
                _run.note("Text encoder unloaded before sampling (holding the limit)", "unload")
        # THE EMBEDDED SAMPLER: comfy core's common_ksampler with this rig's five
        # settings, then the VAE decode, so the whole render is one node and an
        # image output. A latent from the tabs (i2i, edit) keeps its denoise; a
        # fresh canvas samples at 1.0 from an empty Krea 2 latent (16 channel).
        # NEVER ON A PAINT RUN: a paint Generate queues this node with a run token,
        # and rendering a whole fresh image underneath the paint pass is exactly
        # the "ignores everything I painted" you reported. A paint run paints.
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
                negative_text_out = _pf_expand0(negative_text_out, run_seed + 1, True)
            except Exception:
                pass
            # THE WORDS AS QUEUED, for the Prompts tab: every socket, caption and
            # wildcard resolved, which the live preview cannot see. The row is
            # named by index and name so the panel shows it under the right one.
            try:
                _rows0 = cfg["prompts"].get("rows") or []
                _run.info(prompt=prompt_text_out, negative=negative_text_out,
                          final_before=str(_final_before or ""),
                          prompt_row=str(_prow0.get("name") or ""),
                          prompt_index=next((_i for _i, _r in enumerate(_rows0) if _r is _prow0), -1))
            except Exception:
                pass

        _prt = str(cfg["paint"].get("run_token") or "")
        # EITHER TAB'S OWN RUN. The Paint and Upscale tabs both queue THIS
        # node with a token stamped into their own config block, and neither
        # wants the ordinary render underneath it. Every guard below reads
        # "this is a plain render", so both tokens have to clear them.
        _norun = _prt or _urt
        # A HANDLED RIG KIND renders here: the registered handler (a personal
        # local/ module, the NovelAI rig) is the engine, and its picture takes
        # the image output exactly as the embedded sampler's would. Everything
        # downstream - Detailer chains, Review, Save - neither knows nor cares.
        _hk = _ar.get("kind")
        if _stage_only and _mode == "internal" and not _norun:
            # the re-shot picture is the render: nothing below runs, so the rig is
            # never asked for VRAM while the edit model holds it
            rig_image = i2i_img
            print("[RedNode Workspace] %s only: the edited picture is the image "
                  "output; no encode, no i2i pass" % (_stage_only_by or "re-angle"), flush=True)
        if (_mode == "internal" and not _norun and not _stage_only
                and _hk in RIG_KIND_HANDLERS):
            # THE CAMERA PATH ON AN ENGINE RIG: the same one-render-per-shot the
            # built-in sampler does, with the shot's words in place of its
            # conditioning; the engine cannot take a LoRA, so the words are the
            # whole of the camera. The pictures batch on the output. Without
            # this the NovelAI rig rendered shot 1 and the path read as broken.
            _h_shots = []
            if len(_shot_states) > 1 and _cam_state_row is not None:
                print("[RedNode Workspace] camera path: %d shots, one render each "
                      "on the %s rig" % (len(_shot_states), _hk), flush=True)
                for _si, _sst in enumerate(_shot_states):
                    _t = self._shot_text(_sst, _cam_state_row, run_seed)
                    try:
                        from .prompt_frame import expand as _pf_expand_s
                        _t = _pf_expand_s(_t, run_seed, True)
                    except Exception:
                        pass
                    print("[RedNode Workspace] shot %d: %s" % (
                        _si + 1, _t.split(".")[0][:70]), flush=True)
                    _h_shots.append(_t)
            else:
                _h_shots.append(prompt_text_out)
            _h_imgs = []
            for _t in _h_shots:
                try:
                    _himg = RIG_KIND_HANDLERS[_hk](
                        "render", rig=_ar, cfg=cfg, prompt_text=_t,
                        negative_text=negative_text_out, seed=int(run_seed),
                        source_image=i2i_img, denoise=denoise_out)
                    if _himg is not None:
                        _h_imgs.append(_himg)
                except Exception as exc:
                    _samp_err = exc
                    print("[RedNode Workspace] the %r rig's handler failed: %s"
                          % (_hk, exc), flush=True)
            if len(_h_imgs) == 1:
                rig_image = _h_imgs[0]
            elif _h_imgs:
                _hh = min(x.shape[1] for x in _h_imgs)
                _hw = min(x.shape[2] for x in _h_imgs)
                rig_image = torch.cat([x[:, :_hh, :_hw, :] for x in _h_imgs], dim=0)
        if (_mode == "internal" and not _norun and not _stage_only and rig_image is None
                and positive is not None and model is not None):
            try:
                import nodes as _core
                _seed = run_seed
                _lat = latent
                _dn = denoise_out if latent is not None else 1.0
                _lat_from_i2i = False
                # THE IMG2IMG TAB, honoured: with no edit latent, an image on the
                # Img2Img tab is the canvas, encoded here and sampled at the tab's
                # denoise. Without this the embedded sampler started every run from
                # an empty latent and the i2i image was ignored outright.
                if _lat is None and i2i_img is not None:
                    _v0 = vae if vae is not None else rig_vae
                    if _v0 is not None:
                        _lat = {"samples": _v0.encode(i2i_img[:, :, :, :3])}
                        _dn = denoise_out
                        _lat_from_i2i = True
                        print("[RedNode Workspace] built-in sampler: img2img from "
                              "the Img2Img tab at denoise %.2f" % _dn, flush=True)
                    else:
                        print("[RedNode Workspace] the Img2Img tab has an image but "
                              "no VAE is wired or on the rig, so it cannot be "
                              "encoded; sampling a fresh canvas instead", flush=True)
                if _lat is None:
                    _lc = cfg["latent"]
                    _lat = {"samples": torch.zeros(
                        [_lc["batch"], 16, _lc["h"] // 8, _lc["w"] // 8]),
                        "downscale_ratio_spacial": 8}
                from . import rig_chain as _rigc
                _chain0 = _rigc.rig_for(_ar)
                print("[RedNode Workspace] %s: seed %d, %d steps, "
                      "cfg %.1f, %s/%s, denoise %.2f" % (
                          ("your own nodes for the rig %r" % _chain0) if _chain0
                          else "built-in sampler",
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
                # THE LATENT TAB'S OWN PASSES: the same chain on a canvas that starts
                # empty. Pass 1 makes the picture, the passes after it refine what pass
                # 1 made, so the tab with no source image gets the draft-and-climb run
                # the Img2Img tab already had. It never competes with a real i2i pass:
                # that one owns the canvas and is checked first.
                # THE PASS COUNT IS THE WHOLE CONDITION. It used to also require the
                # canvas to be built on the tab, and at least one per-pass list to be
                # switched on. Both quietly cost the passes the panel says will run:
                # a wired latent dropped them although the source picker's own tooltip
                # promises "the passes still run", and a plain "3 passes, refine 0.45"
                # with no advanced list ran exactly once while the bar read 3 Passes.
                # A wired latent is the canvas like any other, and the Refine dial is
                # the denoise for passes 2 and on whether or not a list is open.
                _lc_pass = cfg["latent"]
                _lat_run = (not _i2i_run and not _lat_from_i2i
                            and bool(_lc_pass.get("on"))
                            and int(_lc_pass.get("passes", 1)) > 1)
                if _i2i_run:
                    _npass = int(it.get("passes", 1))
                elif _lat_run:
                    _npass = int(_lc_pass.get("passes", 1))
                else:
                    _npass = 1
                # which tab's per-pass lists the loop below reads, so it does not have
                # to ask twice further down
                _pass_cfg = it if _i2i_run else (_lc_pass if _lat_run else None)
                _pass_what = "latent" if _lat_run else "i2i"
                _v = vae if vae is not None else rig_vae
                # THE CAMERA PATH: one render per shot. Each shot re-assembles the
                # prompt with ITS camera (words) and re-applies the camera LoRAs at
                # ITS strengths on the pre-camera model, samples the same canvas
                # with the same seed, and the images batch on the output.
                _shot_list = [None]
                if len(_shot_states) > 1 and _cam_state_row is not None:
                    _shot_list = list(range(len(_shot_states)))
                    print("[RedNode Workspace] camera path: %d shots, one render each"
                          % len(_shot_states), flush=True)
                _shot_images, _last_out = [], None
                # A PASS RIG OF ANOTHER FAMILY: what the run encoded with and decodes
                # with, so a pass on a rig with another text encoder encodes the
                # prompts again and a pass with another VAE gets the latent moved
                _run_ekey = rig_text_key(_ar, clip, clip is rig_clip)
                _run_vkey = rig_vae_key(_ar, _v, _v is rig_vae)
                _prow_run = prompt_row_for(cfg["models"], cfg["prompts"])
                _penc = {}
                for _si in _shot_list:
                    _pos_i, _model_i = positive, model
                    _lat_vae, _lat_vkey = _v, _run_vkey
                    if _si is not None:
                        try:
                            _pos_i, _model_i = self._shot_setup(
                                _si, _shot_states[_si], _cam_state_row, cfg, run_seed,
                                lora_clip if lora_clip is not None else clip, _model_pre_camera,
                                _rig_is_krea2, studio_preset, style_strength, vae if vae is not None else rig_vae,
                                workspace, lc, unique_id, positive, model)
                        except Exception as _se:
                            print("[RedNode Workspace] shot %d setup failed: %s; using the placed camera"
                                  % (_si + 1, _se), flush=True)
                    _out = _lat
                    # the per-pass list only takes over when the Img2Img tab's
                    # advanced switch is on, so every other route (an override
                    # from Sampler Config, a re-angle, a fresh canvas) keeps the
                    # one denoise it has always used
                    _dn_steps = (_pass_cfg.get("pass_denoise")
                                 if _pass_cfg and _pass_cfg.get("pass_custom") else None)
                    # SIZE PER PASS: the source was encoded at the first pass's
                    # scale, so every later one is a ratio against that and the
                    # latent is resized before it samples. Latent side, not a VAE
                    # round trip: the picture is already in the sampler's space,
                    # and decoding to resize would cost two conversions a pass.
                    _sc_steps = (_pass_cfg.get("pass_scale")
                                 if _pass_cfg and _pass_cfg.get("scale_custom") else None)
                    _base_hw = (tuple(_out["samples"].shape[-2:])
                                if _pass_cfg and _sc_steps and _out is not None else None)
                    # CONTINUE THE NOISE: one schedule for all the passes, cut into
                    # segments of each pass's step count; pass 1 leaves its noise
                    # and every later pass carries on from the cut with none added
                    _segs = None
                    if _pass_cfg and _pass_cfg.get("handoff_continue") and _npass > 1:
                        _cnt = []
                        _sl0 = _pass_cfg.get("pass_steps") if _pass_cfg.get("steps_custom") else None
                        for _q in range(_npass):
                            _c = int(_sl0[min(_q, len(_sl0) - 1)]) if _sl0 else 0
                            _cnt.append(_c if _c > 0 else int(rig_steps))
                        try:
                            _full = _dials.rig_sigmas(_model_i, rig_sampler, rig_scheduler,
                                                      sum(_cnt), _dn)
                            _de = (_ar.get("dials") or {}).get("densify") or {}
                            if _de.get("on"):
                                _full = _dials.densify(_full, _de.get("last", 0.3), _de.get("extra", 0))
                            _segs = _dials.segments(_full, _cnt)
                            print("[RedNode Workspace] continuing the noise across %d passes: "
                                  "one schedule of %d steps, cut at %s"
                                  % (_npass, len(_full) - 1,
                                     ", ".join(str(len(s_) - 1) for s_ in _segs)), flush=True)
                        except Exception as _se:
                            print("[RedNode Workspace] could not build the shared schedule "
                                  "(%s); the passes re-noise as usual" % _se, flush=True)
                            _segs = None
                    for _p in range(max(1, _npass)):
                        _dnp = _dn
                        # On the Latent tab pass 1 is a generation and the rest are
                        # refinements, so the single dial only speaks for the rest. The
                        # per-pass list, when it is on, speaks for all of them.
                        if _lat_run and _p:
                            _dnp = float(_lc_pass.get("refine", 0.45))
                        if _pass_cfg and _dn_steps and _p < len(_dn_steps):
                            _dnp = float(_dn_steps[_p])
                        if _base_hw and _p < len(_sc_steps):
                            _ratio = float(_sc_steps[_p]) / max(1e-6, float(_sc_steps[0]))
                            _th = max(8, int(round(_base_hw[0] * _ratio)))
                            _tw = max(8, int(round(_base_hw[1] * _ratio)))
                            _sm = _out["samples"]
                            if (_th, _tw) != tuple(_sm.shape[-2:]):
                                try:
                                    # A LATENT IS NOT ALWAYS (B, C, H, W). A frame
                                    # axis makes it (B, C, T, H, W), and interpolate
                                    # wants one size per spatial dimension, so the
                                    # depth is carried through untouched and the mode
                                    # follows the rank. Only the picture is resized.
                                    if _sm.ndim >= 5:
                                        _size = tuple(_sm.shape[2:-2]) + (_th, _tw)
                                        _mode = "trilinear" if _sm.ndim == 5 else "nearest"
                                    else:
                                        _size = (_th, _tw)
                                        _mode = "bilinear"
                                    _kw = {} if _mode == "nearest" else {"align_corners": False}
                                    _res = dict(_out)
                                    _res["samples"] = torch.nn.functional.interpolate(
                                        _sm, size=_size, mode=_mode, **_kw)
                                    # a mask made for the old size cannot follow the
                                    # picture up, and a stale one crops the pass
                                    _res.pop("noise_mask", None)
                                    _out = _res
                                    print("[RedNode Workspace] %s pass %d scale %.2fx: "
                                          "%d x %d pixels" % (_pass_what, _p + 1,
                                                              float(_sc_steps[_p]),
                                                              _tw * 8, _th * 8), flush=True)
                                except Exception as _re_exc:
                                    # a pass at the wrong size still renders; losing
                                    # the whole run over a resize does not
                                    print("[RedNode Workspace] pass %d could not be "
                                          "resized (%s); it runs at %d x %d instead"
                                          % (_p + 1, _re_exc, int(_sm.shape[-1]) * 8,
                                             int(_sm.shape[-2]) * 8), flush=True)
                        # A RIG PER PASS: this pass samples on another Models-tab
                        # rig, its own LoRA set and sampler numbers with it. The
                        # conditioning stays the run's, which is right for a
                        # HighNoise / LowNoise pair (one text encoder between them).
                        # STEPS PER PASS on top: a relay drafts in one step and
                        # finishes in ten.
                        _model_p, _steps_p, _cfg_p = _model_i, rig_steps, rig_cfg
                        _sampler_p, _sched_p, _rig_p = rig_sampler, rig_scheduler, ""
                        _dials_p = _ar.get("dials") or {}
                        _pos_p, _neg_p = _pos_i, negative
                        _clip_p = lora_clip if lora_clip is not None else clip
                        _vae_p, _vkey_p = _v, _run_vkey
                        if _pass_cfg and _pass_cfg.get("rig_custom"):
                            _rl = _pass_cfg.get("pass_rig") or []
                            _rig_p = str(_rl[min(_p, len(_rl) - 1)] if _rl else "")
                        if _rig_p and _rig_p != str(_ar.get("name") or ""):
                            _got = self._pass_rig(cfg, _rig_p, prompt)
                            if _got is None:
                                _rig_p = ""
                            else:
                                (_model_p, _steps_p, _cfg_p, _sampler_p, _sched_p, _dials_p,
                                 _gclip, _gvae, _gekey, _gvkey) = _got
                                _prec = next((r for r in cfg["models"]["rigs"]
                                              if r.get("name") == _rig_p), {})
                                if _gclip is not None:
                                    _clip_p = _gclip
                                if (_gclip is not None
                                        and _gekey != _run_ekey):
                                    _ck = (_rig_p, _si)
                                    if _ck not in _penc:
                                        _row_p = prompt_row_for(cfg["models"], cfg["prompts"],
                                                                _rig_p)
                                        if _row_p is None or _row_p is _prow_run:
                                            _row_p = _prow or {}
                                        _txt_p = (self._shot_text(_shot_states[_si],
                                                                  _cam_state_row, run_seed)
                                                  if _si is not None else _row_p.get("text", ""))
                                        try:
                                            _penc[_ck] = self._pass_encode(
                                                cfg, _rig_p, _prec, _gclip,
                                                _gvae if _gvae is not None else _v,
                                                _txt_p, str(_row_p.get("negative") or ""),
                                                studio_preset, style_strength, workspace)
                                        except Exception as _pe:
                                            raise RuntimeError(
                                                "pass %d on the rig %r could not encode the "
                                                "prompt with that rig's own text encoder: %s"
                                                % (_p + 1, _rig_p, _pe)) from _pe
                                        _run.note("Pass %d on %s: another text encoder, "
                                                  "prompts encoded again" % (_p + 1, _rig_p))
                                        print("[RedNode Workspace] %s pass %d: the rig %r has "
                                              "another text encoder, so the prompts are "
                                              "encoded again with it (%s)"
                                              % (_pass_what, _p + 1, _rig_p,
                                                 "Krea 2" if _prec.get("clip_type") == "krea2"
                                                 else "plain text encode"), flush=True)
                                    _pos_p, _neg_p = _penc[_ck]
                                if (_gvae is not None
                                        and _gvkey != _run_vkey):
                                    _vae_p, _vkey_p = _gvae, _gvkey
                        else:
                            _rig_p = ""
                        if _pass_cfg and _pass_cfg.get("steps_custom"):
                            _sl = _pass_cfg.get("pass_steps") or []
                            _sv = int(_sl[min(_p, len(_sl) - 1)]) if _sl else 0
                            if _sv > 0:
                                _steps_p = _sv
                        if _npass > 1:
                            print("[RedNode Workspace] %s pass %d of %d, denoise %.2f%s%s"
                                  % (_pass_what, _p + 1, _npass, _dnp,
                                     (", rig %r" % _rig_p) if _rig_p else "",
                                     (", %d steps" % _steps_p) if _steps_p != rig_steps else ""),
                                  flush=True)
                        # every step of this call also streams a small frame,
                        # decoded by the pack's own tiny decoder, to any Live
                        # Preview node wired to this one (live_preview.py)
                        from . import live_preview as _live
                        _lbl = " · ".join(x for x in [
                            ("shot %d of %d" % (_si + 1, len(_shot_list))
                             if _si is not None and len(_shot_list) > 1 else ""),
                            ("pass %d of %d" % (_p + 1, _npass) if _npass > 1 else ""),
                            _rig_p,
                        ] if x)
                        _moved = False
                        if (_vkey_p != _lat_vkey and _out is not None
                                and _vae_p is not None):
                            _sm0 = _out["samples"]
                            if not bool(torch.count_nonzero(_sm0)):
                                # an empty canvas has no picture to carry over; the
                                # sampler sizes its channels for the model
                                pass
                            elif _lat_vae is None:
                                raise RuntimeError(
                                    "pass %d on the rig %r needs the latent moved to that "
                                    "rig's VAE, and there is no VAE to decode it with first"
                                    % (_p + 1, _rig_p or rig_name))
                            else:
                                _pix = vae_images(_lat_vae.decode(_sm0))
                                _mv = {k_: v_ for k_, v_ in _out.items() if k_ != "noise_mask"}
                                _mv["samples"] = _vae_p.encode(_pix[:, :, :, :3])
                                _out = _mv
                                _moved = True
                                _run.note("Pass %d on %s: latent moved to its VAE"
                                          % (_p + 1, _rig_p))
                                print("[RedNode Workspace] %s pass %d: the rig %r has "
                                      "another VAE, so the latent is decoded and encoded "
                                      "again with it" % (_pass_what, _p + 1, _rig_p),
                                      flush=True)
                            _lat_vae, _lat_vkey = _vae_p, _vkey_p
                        _cont = _segs is not None and not _moved
                        if _segs is not None and _moved:
                            print("[RedNode Workspace] %s pass %d adds fresh noise: a latent "
                                  "moved to another VAE cannot continue the last pass's "
                                  "noise" % (_pass_what, _p + 1), flush=True)
                        from . import rig_chain as _rigc
                        _rig_rec = (next((r for r in cfg["models"]["rigs"]
                                          if r.get("name") == _rig_p), None)
                                    if _rig_p else _ar) or {}
                        _pkey = "pass%d" % (_p + 1)
                        # a fresh canvas is Generate whatever the pass count; only a
                        # real Img2Img pass is called one
                        _plabel = "Pass %d · %s" % (
                            _p + 1, "Refine" if _p > 0
                            else ("Img2Img" if _i2i_run else "Generate"))
                        try:
                            # the picture size by the latent's own scale: 1/8 for a
                            # tagged blank canvas, else the model's (Qwen 2.1 is 1/16)
                            _ratio = _out.get("downscale_ratio_spacial")
                            if not _ratio:
                                try:
                                    _ratio = _model_p.get_model_object(
                                        "latent_format").spacial_downscale_ratio
                                except Exception:
                                    _ratio = 8
                            _psz = [int(_out["samples"].shape[-1]) * int(_ratio),
                                    int(_out["samples"].shape[-2]) * int(_ratio)]
                            _pbatch = int(_out["samples"].shape[0])
                        except Exception:
                            _psz, _pbatch = None, 1
                        _run.begin(_pkey, _plabel, steps=int(_steps_p),
                                   denoise=round(float(_dnp), 2), batch=_pbatch,
                                   rig=_rig_p or rig_name or "", size=_psz,
                                   shot=(_si + 1 if _si is not None
                                         and len(_shot_list) > 1 else None))
                        with _rigc.using(_rigc.rig_for(_rig_rec), prompt,
                                         clip=_clip_p, vae=_vae_p):
                            _out = _live.sampled(unique_id, _dials.sample_with_dials, label=_lbl)(
                                _model_p, _seed + (0 if _same_pass else _p), _steps_p, _cfg_p, _sampler_p,
                                _sched_p, _pos_p, _neg_p, _out,
                                denoise=_dnp, dials=_dials_p,
                                sigmas=(_segs[_p] if _cont else None),
                                disable_noise=bool(_cont and _p > 0))
                        _run.end(_pkey, _plabel)
                        _tap("passes", _plabel, latent=_out, model_for=_model_p)
                    _last_out = _out
                    # the last pass's VAE decodes: after a pass on another family the
                    # latent is in that rig's space
                    _v_run = _v
                    _v = _lat_vae if _lat_vae is not None else _v
                    if _v is not None:
                        _run.begin("decode", "Decode")
                        # the same courtesy the encode gets: past roughly 2
                        # megapixels a whole decode is a VRAM spike that reads as
                        # a hang, and a climbing scale reaches that on the last
                        # pass. Tiling is the optimisation, not the point, so a
                        # VAE that refuses still gets its whole decode.
                        _s = _out["samples"]
                        _px = int(_s.shape[-1]) * int(_s.shape[-2]) * 64
                        _img = None
                        if _px > 2_100_000 and hasattr(_v, "decode_tiled"):
                            try:
                                _img = _v.decode_tiled(_s, tile_x=512, tile_y=512,
                                                       overlap=64)
                                print("[RedNode Workspace] decoding %d x %d in tiles"
                                      % (int(_s.shape[-1]) * 8, int(_s.shape[-2]) * 8),
                                      flush=True)
                            except Exception as _de:
                                print("[RedNode Workspace] the tiled decode failed "
                                      "(%s); decoding it whole" % _de, flush=True)
                        if _img is None:
                            _img = _v.decode(_s)
                        _img = vae_images(_img)
                        _shot_images.append(_img)
                        _run.end("decode", "Decode")
                    _v = _v_run
                result_latent_out = _last_out
                if _v is None and not _shot_images:
                    _no_vae = True
                    print("[RedNode Workspace] built-in sampler rendered, but no "
                          "VAE is wired or named on the rig, so there is no image "
                          "to decode.", flush=True)
                elif _shot_images:
                    if len(_shot_images) == 1:
                        rig_image = _shot_images[0]
                    else:
                        _h = min(x.shape[1] for x in _shot_images)
                        _w = min(x.shape[2] for x in _shot_images)
                        rig_image = torch.cat([x[:, :_h, :_w, :] for x in _shot_images], dim=0)
            except Exception as exc:
                _samp_err = exc
                print("[RedNode Workspace] built-in sampler failed: %s" % exc,
                      flush=True)
                _run.fail_active(exc)

        def _polish(key, label, pic, dn):
            # THE POLISH PASS: the rig runs once more over an edited render at a
            # low denoise, the pass a source edit gets from the Img2Img pass, so
            # the new face or viewpoint sits in the render's light and grain.
            # Built-in sampler only; the edited picture is kept as it is otherwise.
            nonlocal rig_image, result_latent_out
            _pv = vae if vae is not None else rig_vae
            if _mode != "internal" or model is None or positive is None or _pv is None:
                _run.skip(key, label, "needs the built-in sampler")
                return
            try:
                from . import live_preview as _live
                from . import rig_chain as _rigc
                _run.begin(key, label, steps=int(rig_steps), denoise=round(dn, 2),
                           rig=rig_name or "", batch=int(pic.shape[0]),
                           size=[int(pic.shape[2]), int(pic.shape[1])])
                _plat = {"samples": _pv.encode(pic)}
                with _rigc.using(_rigc.rig_for(_ar), prompt,
                                 clip=lora_clip if lora_clip is not None else clip,
                                 vae=_pv):
                    _pout = _live.sampled(unique_id, _dials.sample_with_dials,
                                          label=label.lower())(
                        model, int(run_seed) + 1, rig_steps, rig_cfg, rig_sampler,
                        rig_scheduler, positive, negative, _plat,
                        denoise=dn, dials=_ar.get("dials") or {})
                rig_image = vae_images(_pv.decode(_pout["samples"]))[:, :, :, :3]
                _tap("editor", "Editor result", rig_image)
                result_latent_out = _pout
                _run.end(key, label)
                print("[RedNode Workspace] %s: %d steps at denoise %.2f"
                      % (label.lower(), int(rig_steps), dn), flush=True)
            except Exception as exc:
                _run.end(key, label, "error", error=str(exc)[:200])
                print("[RedNode Workspace] %s failed: %s; the edited picture is kept"
                      % (label.lower(), exc), flush=True)

        # THE RAW RENDER IS THIS ONE: the model's own output, before the Editor's
        # stages on the render (Re-angle, Realism, Swap), the Detailer and Post FX.
        # The raw copy used to be taken after those edits, so "raw" carried a
        # converted or swapped picture (you, 2026-09-25). Kept by reference, so it
        # costs nothing unless the Save tab asks for it. Taken LAZILY, right before
        # each edit that could change it: the render reaches this point by more
        # than one road (the sampler, a re-shot source kept as the output), and
        # not every road has set it yet by here.
        _raw_img = rig_image

        # RE-ANGLE ON THE RENDER: the finished picture (a Latent tab render as much
        # as an Img2Img one) is re-shot from the camera on the page, then the rig
        # polishes it. Before the swap, so a swapped face lands on the final
        # viewpoint, the order the source stages run in
        if (_rg.get("on") and _rg.get("target") == "render" and rig_image is not None
                and not _norun and not _stage_only):
            _reshot = None
            try:
                from . import reangle as _re
                _prompts = _re.prompts_for(_rg, _reangle_cams())
                _rseed = int(run_seed if _rg["seed_random"] else _rg["seed"])
                _run.begin("reangle", "Re-angle", steps=int(_rg["steps"]),
                           batch=len(_prompts) * int(rig_image.shape[0]))
                # the engine re-shoots one picture at a time: every render gets its views
                _views = [_re.render(_rg, rig_image[i:i + 1], _prompts, _rseed,
                                     node_id=unique_id)[:, :, :, :3]
                          for i in range(int(rig_image.shape[0]))]
                _vh = min(int(v.shape[1]) for v in _views)
                _vw = min(int(v.shape[2]) for v in _views)
                _reshot = torch.cat([v[:, :_vh, :_vw, :] for v in _views], dim=0)
                _run.end("reangle", "Re-angle")
                _tap("reangle", "Re-angle result", _reshot)
                print("[RedNode Workspace] re-angle: %d view(s) on the render (%d x %d)"
                      % (_reshot.shape[0], _reshot.shape[2], _reshot.shape[1]), flush=True)
                rig_image = _reshot
            except Exception as exc:
                _run.end("reangle", "Re-angle", "error", error=str(exc)[:200])
                print("[RedNode Workspace] re-angle failed: %s; the render is kept as it is"
                      % exc, flush=True)
            if not (_sw.get("on") and _sw.get("target") == "render"):
                _edit_off()
            if _reshot is not None and _rg["polish"]:
                _polish("reangle_polish", "Re-angle polish", _reshot, float(_rg["polish_denoise"]))

        # REALISM ON THE RENDER: render first, then turn it into a photograph, after
        # Re-angle and before Swap, the order the stages run on the source
        # (_rl is reused for a pass rig's LoRA list further up, so read it fresh)
        _rl_cfg = (cfg["tabs"]["i2i"].get("realism") or {})
        if _raw_img is None:
            _raw_img = rig_image
        if (_rl_cfg.get("on") and _rl_cfg.get("target") == "render" and rig_image is not None
                and not _norun and not _stage_only):
            try:
                from . import realism as _rl_mod
                _rseed3 = int(run_seed if _rl_cfg["seed_random"] else _rl_cfg["seed"])
                _run.begin("realism", "Realism", steps=int(_rl_cfg["steps"] or rig_steps),
                           batch=int(rig_image.shape[0]))
                _conv = [_rl_mod.render(_rl_cfg, rig_image[i:i + 1], cfg, _rseed3,
                                        node_id=unique_id)[:, :, :, :3]
                         for i in range(int(rig_image.shape[0]))]
                _ch = min(int(v.shape[1]) for v in _conv)
                _cw = min(int(v.shape[2]) for v in _conv)
                rig_image = torch.cat([v[:, :_ch, :_cw, :] for v in _conv], dim=0)
                _run.end("realism", "Realism")
                _tap("realism", "Realism result", rig_image)
                print("[RedNode Workspace] realism: the render is now a photograph "
                      "(%d x %d)" % (rig_image.shape[2], rig_image.shape[1]), flush=True)
            except Exception as exc:
                _run.end("realism", "Realism", "error", error=str(exc)[:200])
                print("[RedNode Workspace] realism failed: %s; the render is kept as it is"
                      % exc, flush=True)

        # SWAP ON THE RENDER: the finished picture (a Latent tab render as much as
        # an Img2Img one) gets the person, then the rig polishes it at a low
        # denoise, the pass a source swap gets from the Img2Img pass
        if _raw_img is None:
            _raw_img = rig_image
        if (_sw.get("on") and _sw.get("target") == "render" and rig_image is not None
                and not _norun and not _stage_only):
            _ref, _ref_name = _swap_ref()
            if _ref is None:
                _run.skip("swap", "Swap", "no reference picture")
                print("[RedNode Workspace] swap: the %s gallery is off or empty, so there "
                      "is no reference; the render is kept as it is" % _ref_name, flush=True)
            else:
                _swapped = None
                try:
                    from . import swap as _swap
                    _sseed = int(run_seed if _sw["seed_random"] else _sw["seed"])
                    _run.begin("swap", "Swap", steps=int(_sw["steps"]),
                               batch=int(rig_image.shape[0]))
                    _swapped = _swap.render(_sw, rig_image, _ref, _sseed,
                                            node_id=unique_id)[:, :, :, :3]
                    _run.end("swap", "Swap")
                    _tap("swap", "Swap result", _swapped)
                    print("[RedNode Workspace] swap: %d picture(s), %s from the %s gallery, "
                          "on the render" % (_swapped.shape[0], _sw["mode"], _ref_name),
                          flush=True)
                    rig_image = _swapped
                except Exception as exc:
                    _run.end("swap", "Swap", "error", error=str(exc)[:200])
                    print("[RedNode Workspace] swap failed: %s; the render is kept as it is"
                          % exc, flush=True)
                _edit_off()
                if _swapped is not None and _sw["polish"]:
                    _polish("swap_polish", "Swap polish", _swapped, float(_sw["polish_denoise"]))

        if rig_image is not None:
            _tap("render", "Render", rig_image)
            _render_tapped = rig_image

        # THE BUILT-IN PAINT DOOR. When Generate chose a rig as the model choice, it
        # queued THIS node with a run token stamped into the config copy. The pass
        # runs on the routed paint model (paint stack overriding main, as agreed)
        # with the folded Studio's conditioning, which is the identity clip system
        # what was missing: refs, edit masks and all, exactly what the classic
        # Paint Render wiring carried, with no render node on the canvas.
        ui_extra = None
        if _prt:
            try:
                from .paint_render import RedNodePaintRender
                _pseed = run_seed
                _n_stack = len([x for x in
                                (pls["slots"] if paint_mode == "paint"
                                 else _base_lc["slots"])
                                if isinstance(x, dict) and x.get("type") != "title"])
                print("[RedNode Workspace] built-in paint pass: %s, %d LoRA slot(s) "
                      "on the model going in"
                      % ("the Paint LoRAs stack" if paint_mode == "paint"
                         else "LoRA set %r" % (_pl["name"] if _paint_set else _base_lc["name"]),
                         _n_stack), flush=True)
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


        # THE UPSCALE TAB'S OWN DOOR, the same shape as the paint one above: the
        # tab queued THIS node with a token in its own config block, so there is
        # no render underneath and no node to wire. It holds ONE Detailer pass,
        # which is what actually runs it, so SeedVR2, VOSR 2.0 and the tiled
        # upscale mean the same thing here as they do on the Detailer.
        if _urt:
            # THE RUN TAB HEARS ABOUT IT. Without a stage of its own, an upscale
            # run showed the ordinary pipeline with everything sitting at waiting,
            # because none of those stages ever fire (the user, 2026-09-20).
            _run.begin("upscale", "Upscale")
            try:
                from .refine_pipeline import RedNodeStudioDetailer
                _up = cfg["upscale"]
                _ubase = (image_in if image_in is not None
                          else load_image_or_blank(_up.get("source") or "", 0,
                                                   "RedNode Upscale"))
                if _uchain:
                    # Send to Detailer: no upscale, the picture goes straight on
                    # and the builtin chain below does the work. Its record comes
                    # with it, so the save says what made it.
                    _carry_for_save = png_carry(_up.get("source") or "")
                    rig_image = _ubase
                    print("[RedNode Upscale] sent to the Detailer chain", flush=True)
                    raise _UpscaleHandled
                # what MADE this picture, if this pack made it. Read before
                # anything touches it, and carried from here on.
                _ucarry = png_carry(_up.get("source") or "")
                if _ucarry:
                    print("[RedNode Upscale] the picture carries its own record; the "
                          "upscale keeps it rather than this run's settings",
                          flush=True)
                _ukind = str((_up.get("stage") or {}).get("type") or "")
                _upre = int(_up.get("pre_size") or 0)
                if _upre:
                    from .paint_render import _fit as _paint_fit
                    _b4 = (int(_ubase.shape[2]), int(_ubase.shape[1]))
                    _ubase = _paint_fit(_ubase, _upre)
                    print("[RedNode Upscale] resized %d x %d to a %d long edge: "
                          "%d x %d" % (_b4[0], _b4[1], _upre,
                                       int(_ubase.shape[2]), int(_ubase.shape[1])),
                          flush=True)
                    # the picture the upscaler actually saw. The tab showed the
                    # original beside the result, which is not what went in when a
                    # resize came first (the user, 2026-09-20).
                    _uin = keep_before_post(_ubase)
                    if _uin:
                        ui_extra = dict(ui_extra or {})
                        ui_extra["rn_upscale_in"] = _uin
                if _ukind == "none":
                    # NO UPSCALER, on purpose: the picture as it arrived, fitted if
                    # asked. It still has to come back as a result, because what
                    # happens to it next is the batch's follow-ups or the Send
                    # buttons, and both read the result.
                    _uout = _ubase
                    print("[RedNode Upscale] no upscaler, the picture passes through "
                          "at %d x %d" % (int(_ubase.shape[2]), int(_ubase.shape[1])),
                          flush=True)
                else:
                    _ustage = dict(_up.get("stage") or {})
                    _ustage["on"] = True
                    _ucfg = {"stages": [_ustage], "seed": _up.get("seed", 0),
                             "seed_random": bool(_up.get("seed_random", True))}
                    _uout, _ureport = RedNodeStudioDetailer().run(
                        _ubase, config=json.dumps(_ucfg), prompt=prompt,
                        unique_id=unique_id, chain_step=None, **_custom_rigs)
                    for _line in str(_ureport or "").splitlines():
                        if _line.strip():
                            print("[RedNode Upscale] %s" % _line.strip(), flush=True)
                if _uout is not None and torch.is_tensor(_uout):
                    rig_image = _uout
                    from .paint_render import _out as _paint_out
                    _ur = _paint_out(_uout, _ucarry)
                    if isinstance(_ur, dict) and isinstance(_ur.get("ui"), dict):
                        ui_extra = dict(ui_extra or {})
                        # THE UPSCALER'S OWN OUTPUT, as its own pane. Published
                        # apart from the result because the chain below may carry
                        # on and make a different picture; rn_paint_images outranks
                        # the final one, so claiming it here would have shown the
                        # upscale where the finished picture belongs.
                        ui_extra["rn_upscale_images"] = _ur["ui"].get("images") or []
                        # with nothing following, the upscale IS the result, so it
                        # takes the key the result pane reads. Core's own preview
                        # system has never heard of it, so the panel does not get a
                        # second giant copy drawn under the node.
                        if not _uafter:
                            ui_extra["rn_paint_images"] = ui_extra["rn_upscale_images"]
                _run.end("upscale", "Upscale")
            except _UpscaleHandled:
                _run.end("upscale", "Upscale")
            except Exception as exc:
                _run.end("upscale", "Upscale", state="error")
                print("[RedNode Workspace] built-in upscale failed: %s" % exc,
                      flush=True)
        # THE BUILT-IN CHAIN, on a normal render: the Detailer passes, then Post FX,
        # then the save, each only when switched on here. The image output carries
        # the finished picture, and a separate node after this one steps aside.
        if rig_image is not None and (not _norun or _uchain or _uafter):
            from . import builtin_chain as _chain

            def _stage_save(img, level):
                """An extra copy of the run at an earlier stage, one level down.

                Writes through the same Save the finished picture uses, so the
                naming, the format and the metadata are whatever the Save panel
                says: an extra copy that did not match the real one would be
                worse than none. Never fatal, because a picture that failed to
                save an EARLIER stage must not cost the finished one.
                """
                if img is None:
                    return
                try:
                    from .save_node import RedNodeSave as _SaveCls
                    _scfg = dict(cfg["save"])
                    _base = str(_scfg.get("subfolder") or "").strip()
                    _scfg["subfolder"] = (_base + "/" + level) if _base else level
                    _SaveCls().save(img, config=json.dumps(_scfg), seed=run_seed,
                                    prompt=prompt, extra_pnginfo=extra_pnginfo)
                except Exception as exc:
                    print("[RedNode Workspace] the %s copy did not save: %s"
                          % (level, exc), flush=True)

            _stages_on = cfg["save"] if isinstance(cfg.get("save"), dict) else {}
            _want_raw = bool(cfg["save_on"] and _stages_on.get("stage_raw"))
            _want_det = bool(cfg["save_on"] and _stages_on.get("stage_prepost"))
            _ran_detailer = False
            if _want_raw:
                _raw_src = _raw_img if _raw_img is not None else rig_image
                _stage_save(_raw_src, "raw")
                # the same picture for the Run page's Raw view, as a temp file: the
                # saved copy's path depends on the Save panel's pattern, this does not
                _raw_files = keep_raw_render(_raw_src)
                if _raw_files:
                    ui_extra = dict(ui_extra or {})
                    ui_extra["rn_raw"] = _raw_files
            if cfg["detailer_on"] and (cfg["detailer"].get("stages") or []):
                try:
                    from .refine_pipeline import RedNodeStudioDetailer
                    _dout = RedNodeStudioDetailer().run(
                        rig_image, config=json.dumps(cfg["detailer"]), prompt=prompt,
                        unique_id=unique_id,
                        subject_words=prompts.get("subject") or "", **_custom_rigs)
                    if _dout and _dout[0] is not None and torch.is_tensor(_dout[0]):
                        rig_image = _dout[0]
                        _ran_detailer = True
                    _chain.mark("detailer")
                except Exception as exc:
                    print("[RedNode Workspace] the built-in Detailer failed: %s; the "
                          "render goes on without it" % exc, flush=True)
            # BEFORE POST, whatever got it here. With no Detailer that is the
            # raw picture again, so writing both would be one file under two names.
            if _want_det and (_ran_detailer or not _want_raw):
                _stage_save(rig_image, "before_post")
            if cfg["post_on"] and postprocess.active_fx(post_cfg):
                _pre = keep_before_post(rig_image)
                if _pre:
                    ui_extra = dict(ui_extra or {})
                    ui_extra["rn_before_post"] = _pre
                try:
                    with postprocess.use_seed(_linked["post"]):
                        rig_image = postprocess.RedNodePostProcess().run(rig_image, prompt=prompt)[0]
                    _chain.mark("post")
                    _tap("post", "Post FX result", rig_image)
                except Exception as exc:
                    print("[RedNode Workspace] the built-in Post FX failed: %s; the "
                          "picture goes on ungraded" % exc, flush=True)
            # THE FINISHED PICTURE, after the Detailer and Post FX. Skipped when nothing
            # touched the render, or the strip would show the same picture twice.
            if rig_image is not None and rig_image is not _render_tapped:
                _tap("final", "Final picture", rig_image)
            if cfg["save_on"]:
                try:
                    from .save_node import RedNodeSave
                    # the built-in sampler made this picture from the words above, so the
                    # record says those; a trace would land on any other sampler's text box
                    _words = None
                    if (_mode == "internal" and not _norun and not _stage_only
                            and prompt_text_out.strip()):
                        _words = {"positive": prompt_text_out, "negative": negative_text_out}
                    elif _stage_only and _stage_words and _stage_words["positive"]:
                        # the Realism stage made this picture from its own Ask for
                        # text; left unsaid, Save traced the rig's prompt row instead
                        _words = _stage_words
                    _sv = RedNodeSave().save(rig_image, config=json.dumps(cfg["save"]),
                                             seed=run_seed, prompt=prompt,
                                             extra_pnginfo=extra_pnginfo, words=_words,
                                             carry=_carry_for_save or None)
                    _chain.mark("save")
                    _simgs = ((_sv or {}).get("ui") or {}).get("images") or []
                    if _simgs:
                        # private, like the paint pass: core would draw a ui "images"
                        # list as a second copy of the picture under the panel
                        ui_extra = dict(ui_extra or {})
                        ui_extra["rn_run_images"] = _simgs
                except Exception as exc:
                    print("[RedNode Workspace] the built-in save failed: %s" % exc,
                          flush=True)
            if unique_id and not (ui_extra or {}).get("rn_run_images"):
                # SAVE OFF, OR IT FAILED: the Run tab's Live picture and the Review
                # still get this run's result, kept in the temp folder rather than
                # lost. The save above already covers the normal case; this is only
                # the gap it leaves. Gated on a real node id (unique_id, always set
                # by ComfyUI's executor) so a programmatic build() with no id, the
                # way most of this pack's own tests call it, keeps returning a plain
                # tuple exactly as before.
                _fimgs = keep_final_result(rig_image)
                if _fimgs:
                    ui_extra = dict(ui_extra or {})
                    ui_extra["rn_final_images"] = _fimgs
            # AND ComfyUI'S OWN PANELS: its assets, queue and history read the
            # standard ui "images" key, so the finished picture goes there too. The
            # node sets hideOutputImages, so the frontend does not draw it a second
            # time under the panel, the way core's Painter and Image Crop nodes do.
            _shown = ((ui_extra or {}).get("rn_run_images")
                      or (ui_extra or {}).get("rn_final_images"))
            if _shown:
                ui_extra = dict(ui_extra or {})
                ui_extra["images"] = _shown

        _empty = None
        if rig_image is None or result_latent_out is None:
            _why = (None if (_norun or _stage_only)
                    else nothing_rendered(cfg, rig_name, model, clip, _enc_err, _samp_err,
                                          _no_vae))
            if _why and rig_image is None:
                print("[RedNode Workspace] %s" % _why, flush=True)
                _run.note(_why, "warn")          # the Run tab's log says it too, so a
                                                  # sampler mode left on External by
                                                  # accident does not fail silently
            _empty = blocked(_why if rig_image is None else None)
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
                rig_steps, rig_cfg, rig_sampler,
                # an extra scheduler is the built-in sampler's; a stock KSampler on the
                # socket would reject the name, so it is handed "simple"
                (rig_scheduler if rig_scheduler in comfy.samplers.KSampler.SCHEDULERS
                 else "simple"),
                rig_detailer,
                # APPENDED: the folded-in Studio's conditioning, and the embedded
                # sampler's picture. The whole classic chain, one node. The two
                # render products block when nothing rendered (paint run,
                # external mode), so a core PreviewImage skips instead of dying;
                # the other None sockets stay None because there None means
                # "unset", not "absent this run".
                positive, negative,
                rig_image if rig_image is not None else _empty,
                # APPENDED: the embedded sampler's latent before decode, for
                # chaining a same-model workspace with no VAE round trip
                result_latent_out if result_latent_out is not None
                else (blocked(_why) if rig_image is None and not (_norun or _stage_only)
                      else blocked()),
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
class _progress_outside_a_run:
    """Progress bars made while no queued run is going.

    ComfyUI's progress hook falls back to the server's last prompt id, which only
    exists once something has been queued this session; a Generate press before
    that made every engine with a progress bar (Florence among them) fail. Inside
    this block the hook skips that one AttributeError; interrupts still raise."""

    def __enter__(self):
        try:
            import comfy.utils as _cu
        except Exception:
            self._cu = None
            return self
        self._cu, self._orig = _cu, _cu.PROGRESS_BAR_HOOK
        orig = self._orig
        if orig is not None:
            def _hook(*a, **kw):
                try:
                    return orig(*a, **kw)
                except AttributeError as e:
                    if "last_prompt_id" in str(e) or "last_node_id" in str(e):
                        return None
                    raise
            _cu.PROGRESS_BAR_HOOK = _hook
        return self

    def __exit__(self, *exc):
        if self._cu is not None:
            self._cu.PROGRESS_BAR_HOOK = self._orig
        return False


def standalone_autoprompt(config_json, tab_name, entry, mode=None):
    """One tab's caption engines for one image, right now, outside the queue.

    Runs with the exact cache keys a queued run uses, so every part it bakes is
    what the next queue picks up through REUSE. CLIP gen needs the workflow's
    loaded text encoder, which only exists during execution; it is skipped here
    and reported back.
    """
    if tab_name not in AUTO_TABS + ("paint",):
        raise ValueError(f"the {tab_name!r} tab has no auto prompt")
    cfg = parse_config(config_json)
    a = cfg["paint"]["auto"] if tab_name == "paint" else cfg["tabs"][tab_name]["auto"]
    ga = cfg["auto"]
    skipped = (["CLIP gen (needs the workflow's CLIP; it runs on the next queue)"]
               if a["clipgen"] else [])
    if not (a["ollama"] or a["wd14"] or a["joy"] or a["qwen"] or a["florence"]):
        raise ValueError("no engines that can run standalone are on for this tab"
                         + (" (CLIP gen only runs with the queue)"
                            if a["clipgen"] else ""))
    # a Moodboard picture is captioned once per read, each asked for by name
    mode = mode if mode in autoprompt.SYSTEM_PROMPTS else a["mode"]
    path = _filepath(entry)
    print(f"[RedNode Workspace] standalone auto prompt captioning {entry} "
          f"for {tab_name} ({mode})", flush=True)
    img_bytes = None
    if a["ollama"]:
        img_bytes = autoprompt.vision_payload(path)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = None
    t_img = (load_image(entry, cfg["resize"])
             if (a["wd14"] or a["joy"] or a["qwen"] or a["florence"]) else None)
    with _progress_outside_a_run():
        prompt = autoprompt.build_prompt(
            mode, image_bytes=img_bytes, image_tensor=t_img,
            wired=(), use_ollama=a["ollama"], use_wd14=a["wd14"],
            use_joy=a["joy"], use_qwen=a["qwen"],
            use_clip=False, clip=None,
            use_florence=a["florence"],
            florence_opts={"model": ga["florence_model"], "task": ga["florence_task"]},
            unload_heavy=ga["wd14_unload"] or ga.get("low_vram", False),
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
            cache_base=[tab_name, entry, mtime, mode, ga["frank"]],
            use_cache=a["fixed"],
            sidecar=(path + ".rn.json") if _managed(entry) else None)
    return {"prompt": prompt, "skipped": skipped, "mode": mode}


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/autoprompt_status")
    async def _rednode_autoprompt_status(request):
        url = autoprompt.OLLAMA_URL                 # the server's setting, not the caller's
        sizes = autoprompt.ollama_model_sizes(url)
        models = sorted(sizes)
        _ok, _note = autoprompt.ollama_status()
        return web.json_response({
            "ollama": bool(models), "models": models,
            "ollama_note": _note, "ollama_url": url,
            # for the panel's VRAM estimates
            "ollama_sizes": sizes,
            "engine_defaults": autoprompt.engine_defaults(),
            "wd14": autoprompt.wd14_available(),
            "wd14_model": autoprompt.wd14_default_model(),
            "wd14_models": autoprompt.wd14_models(),
            "joy": autoprompt.joycaption_available(),
            "qwen": autoprompt.qwenvl_available(),
            "joy_options": autoprompt.joycaption_options(),
            "florence": autoprompt.florence_available(),
            "florence_models": autoprompt.florence_models(),
            "florence_tasks": list(autoprompt.FLORENCE_TASKS),
            "converter": {"gender": SWAP_MODES, "style": STYLE_MODES, "act": ACT_MODES},
        })

    _standalone_busy = {"on": False}

    @PromptServer.instance.routes.post("/rednode/vram_estimate")
    async def _rednode_vram_estimate(request):
        # what a run with these settings should need, for the Run tab's VRAM line
        try:
            data = await request.json()
            cfg = parse_config(str(data.get("config") or "{}"))
            from . import vram_hold as _vh
            est = estimate_vram(cfg, data.get("rig_files"))
            lim = _vh.limit_gb(cfg)
            hold, why = _vh.decide(cfg, est)
            return web.json_response({
                "estimate": est, "card": _vh.card_gb(cfg), "limit": lim,
                "mode": _vh.hold_mode(cfg), "hold": hold, "why": why})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

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
                str(data.get("tab") or ""), str(data.get("entry") or ""),
                str(data.get("mode") or "") or None)
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        finally:
            _standalone_busy["on"] = False

    @PromptServer.instance.routes.post("/rednode/caption_write")
    async def _rednode_caption_write(request):
        """Write a caption beside its picture, as picture.txt.

        The AI tab's batch: a folder of captioned pictures is what a LoRA trainer
        expects, so the text goes next to the file rather than into a folder of its
        own (you, 2026-09-23). Only inside ComfyUI's input or output folders, only
        beside a picture that is really there, and only ever a .txt.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        entry = str(data.get("entry") or "")
        text = str(data.get("text") or "")
        if not entry:
            return web.json_response({"error": "no picture given"}, status=400)
        try:
            path = _filepath(entry)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        roots = [folder_paths.get_input_directory(), folder_paths.get_output_directory()]
        if not any(_inside_dir(path, r) for r in roots):
            return web.json_response(
                {"error": "that picture is outside ComfyUI's input and output folders"},
                status=403)
        txt = os.path.splitext(path)[0] + ".txt"
        try:
            with open(txt, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"written": os.path.basename(txt)})

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

    @PromptServer.instance.routes.post("/rednode/people_rewrite")
    async def _rednode_people_rewrite(request):
        # the Subject's Preview rewrite: the same merge the queue runs, asked now, so
        # the answer is cached and the queue reuses it for the same text and people
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        people = [(str(p[0]), str(p[1])) for p in (data.get("people") or [])
                  if isinstance(p, (list, tuple)) and len(p) == 2]
        if not people:
            return web.json_response({"error": "no captions to merge yet"}, status=400)
        ga = parse_config(str(data.get("config") or "{}"))["auto"]
        import asyncio
        text = await asyncio.get_event_loop().run_in_executor(
            None, lambda: autoprompt.merge_people(
                str(data.get("prompt") or ""), people, model=ga["model"], url=ga["url"],
                keep_alive=ga["keep_alive"], reuse=not data.get("fresh")))
        if not text:
            return web.json_response(
                {"error": "Ollama gave no answer; check it is running and a model is picked"},
                status=400)
        return web.json_response({"text": text})

    @PromptServer.instance.routes.post("/rednode/release_engines")
    async def _rednode_release_engines(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        import asyncio
        done = await asyncio.get_event_loop().run_in_executor(
            None, autoprompt.release_engines, str(data.get("model") or ""),
            autoprompt.OLLAMA_URL)
        return web.json_response({"done": done})

    @PromptServer.instance.routes.get("/rednode/luts")
    async def _rednode_luts(request):
        # the Post tab's LUT card lists models/luts through this; the folder is
        # registered on first ask, so a fresh install gets an empty list, not a 500
        try:
            files = postprocess.lut_files()
        except Exception as exc:
            print("[RedNode Post] could not list models/luts: %s" % exc, flush=True)
            files = []
        return web.json_response({"files": files})

    @PromptServer.instance.routes.get("/rednode/post_awb")
    async def _rednode_post_awb(request):
        # the Colour card's Measure button: a route, not a per-run mode, so the grade
        # stays a pure function of its numbers and the numbers stay the user's
        method = request.query.get("method") or "shades_of_grey"
        try:
            got = postprocess.auto_white_balance(method=method)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except Exception as exc:
            print("[RedNode Post] auto white balance failed: %s" % exc, flush=True)
            return web.json_response({"error": "could not measure that frame"}, status=500)
        return web.json_response(got)

    @PromptServer.instance.routes.get("/rednode/post_presets")
    async def _rednode_post_presets(request):
        name = request.query.get("name")
        if name:
            builtin = postprocess.BUILTIN_LOOKS.get(name)
            if builtin:
                return web.json_response({"name": name,
                                          "config": postprocess.parse_post(builtin["config"])})
            entry = postprocess.load_presets().get(name)
            if not entry:
                return web.json_response({"error": f"no preset named {name!r}"}, status=404)
            return web.json_response({"name": name, "config": entry["config"],
                                      "thumb": entry["thumb"]})
        return web.json_response({
            "presets": postprocess.looks_list(),
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
        return web.json_response({
            "presets": postprocess.looks_list(),
            "last_thumb": postprocess.LAST_THUMB["uri"],
        })

    @PromptServer.instance.routes.get("/rednode/post_status")
    async def _rednode_post_status(request):
        # which depth estimator and which segmenter the Post tab can drive here
        try:
            return web.json_response(postprocess.model_status())
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/rednode/post_orders")
    async def _rednode_post_orders(request):
        orders = postprocess.load_orders()
        return web.json_response({"orders": [{"name": n, "ids": ids}
                                             for n, ids in sorted(orders.items())]})

    @PromptServer.instance.routes.post("/rednode/post_orders")
    async def _rednode_post_orders_post(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            if data.get("action") == "save":
                postprocess.save_order(data.get("name", ""), data.get("ids"))
            elif data.get("action") == "delete":
                postprocess.delete_order(data.get("name", ""))
            else:
                return web.json_response({"error": "unknown action"}, status=400)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        orders = postprocess.load_orders()
        return web.json_response({"orders": [{"name": n, "ids": ids}
                                             for n, ids in sorted(orders.items())]})

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
