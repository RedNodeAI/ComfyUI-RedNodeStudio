"""Krea 2 RedNode — the simple front door.

One node covers the 90% path: identity source(s) + style references + instruction in,
positive AND matching grounded negative out (same sources, same VAE, same fit geometry —
the mismatch class of bugs is structurally impossible). A preset dropdown replaces the
knob wall; the advanced settings node plugs into `settings` to take full manual control
(connected settings replace the preset entirely — all-or-nothing, no field mixing).

Internally this orchestrates the proven nodes (Fusion for the positive, Identity Edit for
the grounded negative), so every code path is the one already validated. The originals
remain available as advanced/legacy nodes.
"""

import json
import os

SETTINGS_TYPE = "KREA2_SETTINGS"

REF_MODES = ["full image", "quadrant crops (2x2)", "fine tiles (4x4)"]

# preset-dropdown sentinel: hand control to the connected Settings node
CUSTOM_SENTINEL = "custom (use settings)"


def _presets_path(make=False):
    """User-preset store. ComfyUI user dir when available (survives pack updates),
    pack-local fallback otherwise; KREA2RN_PRESETS env overrides (tests)."""
    override = os.environ.get("KREA2RN_PRESETS")
    if override:
        return override
    try:
        import folder_paths
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "presets.json")


def _load_user_presets():
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        return {str(k): dict(v) for k, v in data.get("presets", {}).items() if isinstance(v, dict)}
    except (OSError, ValueError):
        return {}


def _save_user_preset(name, cfg):
    path = _presets_path(make=True)
    presets = _load_user_presets()
    presets[name] = dict(cfg)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
    return path

# mirror vision system prompt for the real→anime preset (validated 2026-07-24 via the
# user's with/without comparison — without it the output lands at 2.5D semi-real)
REAL2ANIME_SYSTEM = (
    "Describe the person in the image as an anime character: detail their identity, face "
    "shape, eye and hair color, hairstyle, build, clothing and colors as clean stylized "
    "anime features with flat colors and simple shapes. Ignore photographic realism, skin "
    "texture, pores, film grain and lens artifacts — describe only what this person and "
    "scene would look like as an anime illustration. Describe the eyes as large expressive "
    "anime eyes, keeping their color; never describe them as small realistic eyes:"
)

# user-tested vision system prompt for the anime→real preset (2026-07-24)
ANIME2REAL_SYSTEM = (
    "Describe the person in the image as a real human being: detail their identity, face "
    "shape, eye and hair color, hairstyle, build, clothing and colors as physical real-world "
    "features. Ignore the illustration style, lineart, cel shading and outlines — describe "
    "only what this person and scene would look like in reality. Describe the eyes as "
    "realistic human eyes of natural size and proportion, keeping their color; never "
    "describe them as large anime eyes:"
)

# preset -> full internal config (documented in plain language in the settings node)
PRESETS = {
    "Balanced": dict(transfer="style", reference_processing="full image", style_directive=True,
                     hide_style_refs=True, style_detail_px=384, likeness_vs_obedience=768,
                     reference_fidelity=2.5, scene_fidelity=1.0, fit_mode="fit"),
    "Max identity": dict(transfer="style", reference_processing="full image", style_directive=True,
                         hide_style_refs=True, style_detail_px=384, likeness_vs_obedience=1024,
                         reference_fidelity=4.0, scene_fidelity=1.0, fit_mode="fit"),
    "Style only": dict(transfer="style", reference_processing="full image", style_directive=True,
                       hide_style_refs=True, style_detail_px=768, likeness_vs_obedience=768,
                       reference_fidelity=1.0, scene_fidelity=1.0, fit_mode="fit"),
    # user-discovered recipe: garment/product photos in moodboard_style transfer onto the subject
    # with no captioning. 1280px vision budget resolves fabric patterns; style extract + directive
    # with fidelity boosts 2.0 keeps the face while the garment carries over. style_strength 1.0.
    "Outfit transfer": dict(transfer="style", reference_processing="full image", style_directive=True,
                            hide_style_refs=False, style_detail_px=1280, likeness_vs_obedience=768,
                            reference_fidelity=2.0, scene_fidelity=2.0, fit_mode="fit"),
    # session recipe (2026-07-23), EXPERIMENTAL: early pose emphasis — the ref latents are
    # active only for the first ~30% of sampling, so the reference drives composition/pose
    # while identity/texture never lock via the DiT path. NOTE: the grounded (Qwen) conditioning
    # still carries the source at every step, so some identity/style can persist — validate
    # with fixed-seed A/Bs. The prompt describes WHO; the ref contributes WHERE/HOW they stand.
    "Pose transfer": dict(transfer="style", reference_processing="full image", style_directive=True,
                          hide_style_refs=True, style_detail_px=384, likeness_vs_obedience=768,
                          reference_fidelity=2.5, scene_fidelity=1.0, fit_mode="fit",
                          identity_end=0.3),
    # user-tested recipe (2026-07-24): anime→real conversion. Wiring: the ANIME image goes
    # into scene_image (its content pulled hard, 3.21), the real subject face into
    # subject_image (latent pull deliberately LOOSE at 0.47 — identity arrives via the
    # grounding, not pixel copying), refs drop at 63%, both training-parity toggles ON,
    # and the vision system prompt reads the refs as real human beings (incl. the
    # anime-eye normalization clause). Instruction: describe the photorealistic shot,
    # e.g. "A photorealistic photograph of this character as a real person, natural skin
    # texture, real fabric and hair".
    "Anime to real": dict(transfer="style", reference_processing="full image", style_directive=False,
                          hide_style_refs=True, style_detail_px=768, likeness_vs_obedience=768,
                          reference_fidelity=0.47, scene_fidelity=3.21, fit_mode="fit",
                          identity_end=0.63, isolate_refs=True, picture_labels=True,
                          ref_t0_modulation=True, vision_system_prompt=ANIME2REAL_SYSTEM),
    # mirror direction, user-tested numbers (style_detail_px raised to 1024 for this one).
    # Wiring: REAL image → scene_image, face to keep → subject_image. The system prompt is
    # the full-anime last mile — same settings WITHOUT it produce the 2.5D semi-real look
    # (save that variant under your own name via Preset Save if you want it on the dial).
    "Real to anime": dict(transfer="style", reference_processing="full image", style_directive=False,
                          hide_style_refs=True, style_detail_px=1024, likeness_vs_obedience=768,
                          reference_fidelity=0.47, scene_fidelity=3.21, fit_mode="fit",
                          identity_end=0.63, isolate_refs=True, picture_labels=True,
                          ref_t0_modulation=True, vision_system_prompt=REAL2ANIME_SYSTEM),
}

_DEFAULT_PRESET = "Balanced"


def resolve_preset_name(name):
    """Preset names gained capitals; workflows saved before that used lower case.

    Match case-insensitively so an older workflow (or a hand-written prompt) keeps
    working instead of silently falling back to the default.
    """
    if name in PRESETS:
        return name
    low = str(name or "").strip().lower()
    for key in PRESETS:
        if key.lower() == low:
            return key
    return None



def _fusion_args(cfg):
    """Map plain-language settings onto the legacy fusion/identity node argument names."""
    return dict(
        ref_start=float(cfg.get("identity_start", 0.0)),
        ref_end=float(cfg.get("identity_end", 1.0)),
        strength=None,  # filled from the basic node's style_strength
        extract="subject / concept" if cfg["transfer"] == "subject" else "style / vibe",
        reference_processing=cfg["reference_processing"],
        style_directive=bool(cfg["style_directive"]),
        indirect=bool(cfg["hide_style_refs"]),
        budget_px=int(cfg["style_detail_px"]),
        grounding_px=int(cfg["likeness_vs_obedience"]),
        ref_boost=float(cfg["reference_fidelity"]),
        ref_boost_a=float(cfg["scene_fidelity"]),
        fit_mode=cfg["fit_mode"],
        isolate_refs=bool(cfg.get("isolate_refs", False)),
        boost_blocks=cfg.get("boost_blocks", "all"),
        edit_mask_feather=int(cfg.get("edit_mask_feather", 2)),
        grounding_px_subject=int(cfg.get("subject_likeness_px", 0)),
        picture_labels=bool(cfg.get("picture_labels", False)),
        ref_t0_modulation=bool(cfg.get("ref_t0_modulation", False)),
        system_prompt=str(cfg.get("vision_system_prompt", "")),
        attention=str(cfg.get("attention", "auto")),
    )


class Krea2RedNodeSettings:
    """Advanced control surface: plug into the RedNode's `settings` input to replace the preset."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "transfer": (["style", "subject"], {"default": "style",
                         "tooltip": "what the style references contribute: style = palette/lighting/texture/mood; subject = composition/content, the prompt controls the look. (technical: extract mode)"}),
            "reference_processing": (REF_MODES, {"default": "full image",
                         "tooltip": "crops/tiles scramble composition so only style survives from the references"}),
            "style_directive": ("BOOLEAN", {"default": True,
                         "tooltip": "adds a 'style from the refs, subjects from the text' sentence next to the references"}),
            "hide_style_refs": ("BOOLEAN", {"default": True,
                         "tooltip": "style references are deleted after encoding, so the image model never sees them — style transfers via the prompt; poses/people in the refs cannot be copied directly (a small residual influence via the re-contextualized prompt can remain). (technical: indirect mode)"}),
            "style_detail_px": ("INT", {"default": 384, "min": 128, "max": 1536, "step": 64,
                         "tooltip": "resolution budget per style reference fed to the vision encoder. (technical: budget_px)"}),
            "likeness_vs_obedience": ("INT", {"default": 768, "min": 0, "max": 2048, "step": 64,
                         "tooltip": "cap on the identity source fed to the vision encoder: lower = follows the instruction more, higher = preserves likeness more (768 balanced, 1024+ for faces). (technical: grounding_px)"}),
            "reference_fidelity": ("FLOAT", {"default": 2.5, "min": 0.0, "max": 10.0, "step": 0.05,
                         "tooltip": "pull toward the identity reference's appearance: 1.0 = off, 2-6 recommended with the v1.2 edit LoRA. (technical: ref_boost on the subject ref)"}),
            "scene_fidelity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05,
                         "tooltip": "same dial for the scene reference in two-source setups. (technical: ref_boost_a)"}),
            "fit_mode": (["fit", "crop (legacy)"], {"default": "fit",
                         "tooltip": "fit = v1.2 pixel-space geometry (blur-proof, any aspect ratio); crop = v1/v1.1 legacy behavior"}),
            "identity_start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                               "tooltip": "when the identity references become active during sampling (0 = first step). Start later (e.g. 0.2) to let the composition form freely before the identity locks in. (technical: ref timestep window)"}),
            "identity_end": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                             "tooltip": "when the identity references switch off (1 = last step). ~0.3 = pose-only transfer: the ref drives composition, identity never locks."}),
            "isolate_refs": ("BOOLEAN", {"default": False,
                             "tooltip": "two-subject setups: stop the references reading each other — fixes identity/style bleed between two people. No effect with a single reference. (technical: ref-to-ref attention block)"}),
            "boost_blocks": (["all", "early", "mid", "late"], {"default": "all",
                             "tooltip": "experimental: where in the network the fidelity dials act — early leans composition/pose, late leans texture/detail. (technical: DiT depth range for ref_boost)"}),
            "subject_likeness_px": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 64,
                             "tooltip": "separate likeness cap for the SUBJECT when a scene is also connected (the subject often deserves 1024+ while the scene doesn't). 0 = same as likeness_vs_obedience. (technical: grounding_px for the 2nd+ refs)"}),
            "edit_mask_feather": ("INT", {"default": 2, "min": 0, "max": 32,
                             "tooltip": "soft edge for the edit_mask input on the main node, in latent pixels (1 latent px ≈ 8 image px); 0 = hard edge"}),
            "picture_labels": ("BOOLEAN", {"default": False,
                             "tooltip": "EXPERIMENTAL training-parity: 'Picture N: ' prefixes in the grounded prompt (ai-toolkit layout). Applied to both outputs. A/B before adopting."}),
            "ref_t0_modulation": ("BOOLEAN", {"default": False,
                             "tooltip": "EXPERIMENTAL training-parity: modulate reference tokens at timestep 0 (as ai-toolkit trains). Applied to both outputs. A/B before adopting."}),
            "vision_system_prompt": ("STRING", {"multiline": True, "default": "",
                             "tooltip": "ADVANCED: override the vision system prompt for how the encoder READS the references (empty = training default). Example for anime→real: 'Describe the person's identity, face, hair and clothing as a real human being; ignore the illustration style.' Applied to both outputs; A/B."}),
            "attention": (["auto", "default", "pytorch"], {"default": "auto",
                          "tooltip": "attention backend for the reference pass only. auto = fix the RTX 50xx/Blackwell "
                                     "xformers crash when it applies; pytorch = always plain SDPA here (avoids sage's "
                                     "quantized-attention smearing on reference detail); default = never change it."}),
        }}

    RETURN_TYPES = (SETTINGS_TYPE,)
    RETURN_NAMES = ("settings",)
    FUNCTION = "build"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = "Advanced settings for RedNode Studio. Connect to `settings` and pick preset 'custom (use settings)'."

    def build(self, **kwargs):
        return (dict(kwargs),)


class Krea2RedNodePresetSave:
    """Save the connected Settings as a named preset (OUTPUT node: runs when queued —
    keep it muted/bypassed except when you actually want to save). Passes the settings
    through so it can sit inline between Settings and the RedNode."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "settings": (SETTINGS_TYPE,),
            "name": ("STRING", {"default": "", "tooltip": "preset name to save under (overwrites an existing saved preset of the same name; built-in names are protected). Appears in the RedNode preset list after a node-definition refresh (r)."}),
        }}

    RETURN_TYPES = (SETTINGS_TYPE,)
    RETURN_NAMES = ("settings",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = "Saves the connected RedNode Settings as a named preset (JSON in the ComfyUI user dir). Mute when not saving."

    def save(self, settings, name):
        name = (name or "").strip()
        if not name:
            raise ValueError("RedNode Preset Save: give the preset a name")
        # case-insensitive: "balanced" must stay protected now the built-in is "Balanced",
        # or you end up with two entries a capital letter apart
        if name == CUSTOM_SENTINEL or resolve_preset_name(name):
            raise ValueError(f"RedNode Preset Save: {name!r} is a built-in preset name - pick another")
        path = _save_user_preset(name, dict(settings))
        print(f"[Krea2 RedNode] preset {name!r} saved -> {path}", flush=True)
        return (settings,)


class Krea2RedNodePresetLoad:
    """Load any preset (built-in or saved) as a Settings object — plug into the RedNode's
    settings input (preset 'custom (use settings)'), or just execute it to print the full
    value dump for copying into a Settings node."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "preset": (list(PRESETS) + sorted(n for n in _load_user_presets() if n not in PRESETS),
                       {"tooltip": "built-in and saved presets; newly saved names appear after a node-definition refresh (r). A saved preset sharing a built-in's name is shadowed by the built-in - rename it via Preset Save."}),
        }}

    RETURN_TYPES = (SETTINGS_TYPE,)
    RETURN_NAMES = ("settings",)
    FUNCTION = "load"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = "Loads a preset as a RedNode Settings object and prints its values."

    @classmethod
    def IS_CHANGED(cls, preset=""):
        if preset in PRESETS:
            return ""
        try:
            return f"{preset}:{os.path.getmtime(_presets_path())}"
        except OSError:
            return ""

    def load(self, preset):
        cfg = PRESETS.get(preset) or _load_user_presets().get(preset)
        if cfg is None:
            raise ValueError(f"RedNode Preset Load: preset {preset!r} not found "
                             f"(saved presets live in {_presets_path()})")
        cfg = dict(cfg)
        print(f"[Krea2 RedNode] preset {preset!r}:", flush=True)
        for k, v in cfg.items():
            print(f"    {k} = {v!r}", flush=True)
        return (cfg,)


class Krea2RedNode:
    """Simple front door: sources + instruction in, positive + grounded negative out."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                # shown as "prompt" in the UI. The KEY stays `instruction` because
                # saved API workflows and every Get/Set wire address it by that name
                "style_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                                   "tooltip": "how much of the style references survives: 1.0 = raw reference detail, lower = purer style extract"}),
                # the sentinel is the DEFAULT on purpose: a fresh studio hands control to
                # whatever is plugged in (workspace or settings) and quietly runs Balanced
                # when nothing is. The workspace footer is the one preset picker; this
                # widget stays for old workflows and hides when a workspace exists.
                "instruction": ("STRING", {"multiline": True, "dynamicPrompts": True,
                               "default": "", "placeholder": "Prompt: what you want made",
                               "tooltip": "THE PROMPT. What you want made, written as an "
                               "instruction because that is what the edit model expects: "
                               "'a photo of this person at a night market' or 'make her "
                               "hair red'. Reference images come in on the sockets; this "
                               "box is the words."}),
                "preset": ([CUSTOM_SENTINEL] + list(PRESETS)
                           + sorted(n for n in _load_user_presets() if n not in PRESETS), {"default": CUSTOM_SENTINEL,
                           "tooltip": "balanced = identity + style fusion; max identity = strongest face lock; style only = pure vibe transfer; outfit transfer = put the clothes from moodboard_style onto the subject (style_strength 1.0; for strict garment construction ALSO feed the garment into scene_image and drop style_strength to 0.8); pose transfer = EXPERIMENTAL early pose emphasis: the ref drives composition early then drops out — describe the person in the instruction; some identity may still persist via the grounded conditioning; anime to real = convert an anime image (into scene_image) to a photorealistic shot, keeping the subject_image person's face — instruction like 'A photorealistic photograph of this character as a real person'. 'custom (use settings)' = hand control to the connected Settings node; any NAMED preset wins even when settings are connected. Your saved presets (RedNode Preset Save) appear in this list after a node-definition refresh."}),
            },
            "optional": {
                "negative_prompt": ("STRING", {"multiline": True, "default": "",
                                    "dynamicPrompts": True,
                                    "placeholder": "Negative: leave empty at CFG 1",
                                    "tooltip": "Leave EMPTY for turbo work at CFG 1. The "
                                               "grounded negative, an empty prompt with the "
                                               "same references, is what the edit model was "
                                               "trained against and is what you get. Write "
                                               "something here only for a full model at CFG "
                                               "above 1, where a written negative actually "
                                               "steers the image."}),
                "vae": ("VAE", {"tooltip": "required when a subject or scene image is connected"}),
                "subject_image": ("IMAGE", {"tooltip": "the person/subject to preserve — the face you want kept"}),
                "scene_image": ("IMAGE", {"tooltip": "optional environment/scene reference to place the subject into (two-ref edit LoRAs; ordering is handled for you)"}),
                "moodboard_style": ("IMAGE", {"tooltip": "style/vibe reference images — batch several for a joint moodboard"}),
                "extra_subjects": ("KREA2_SOURCES", {"tooltip": "chain more references (Krea2 Edit Source Chain); 3+ is beyond the edit LoRA's training"}),
                "output_latent": ("LATENT", {"tooltip": "connect the SAME empty latent you feed the sampler — enables the v1.2 blur-proof fit geometry on both outputs"}),
                "subject_boost_mask": ("MASK", {"tooltip": "optional region on the subject image to focus the identity boost on (e.g. just the face) — strong likeness without over-copying clothes/background. Right-click the subject image > Open in MaskEditor, or wire any MASK output."}),
                "edit_mask": ("MASK", {"tooltip": "hard edit locality: white = the region the model may change; everywhere else stays pixel-faithful to the FIRST source (re-imposed each denoising step). Wired to BOTH outputs so CFG stays consistent. Needs a matched output aspect ratio (or crop fit)."}),
                "settings": (SETTINGS_TYPE, {"tooltip": "optional Krea 2 RedNode Settings node — replaces the preset entirely when connected"}),
                "workspace": ("KREA2_WORKSPACE", {"tooltip": "everything at once from a RedNode Studio "
                              "Workspace node — its images, masks, extra people and dials. Anything "
                              "you ALSO wire directly (subject_image, settings…) wins over the bundle."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "encode"
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = "Moodboard + identity edit in one node, with a matched grounded negative output. Presets for the common modes (incl. your saved ones); plug in RedNode Settings and pick 'custom (use settings)' for full control."

    @classmethod
    def VALIDATE_INPUTS(cls, preset):
        """Take the preset name ourselves so older lower-case values still validate.

        Naming `preset` here tells ComfyUI to skip its own "is it in the list" check for
        this input only — everything else is still validated normally.
        """
        if not preset or preset == CUSTOM_SENTINEL:
            return True
        if resolve_preset_name(preset) or preset in _load_user_presets():
            return True
        return f"unknown preset {preset!r}"

    @classmethod
    def IS_CHANGED(cls, preset="Balanced", **kwargs):
        # re-execute when a SAVED preset in use was edited on disk; built-ins are static
        if preset == CUSTOM_SENTINEL or preset in PRESETS:
            return ""
        try:
            return f"{preset}:{os.path.getmtime(_presets_path())}"
        except OSError:
            return ""

    def encode(self, clip, instruction, preset, style_strength, negative_prompt="",
               vae=None, subject_image=None,
               scene_image=None, moodboard_style=None, extra_subjects=None, output_latent=None,
               subject_boost_mask=None, edit_mask=None, settings=None, workspace=None):
        import sys
        pkg = sys.modules[__package__]

        # A workspace bundle fills any input you did not wire directly — direct wires win,
        # so a workspace can drive a whole workflow while one socket is still overridable.
        if isinstance(workspace, dict):
            subject_image = subject_image if subject_image is not None else workspace.get("subject_image")
            scene_image = scene_image if scene_image is not None else workspace.get("scene_image")
            moodboard_style = moodboard_style if moodboard_style is not None else workspace.get("moodboard_style")
            extra_subjects = extra_subjects if extra_subjects is not None else workspace.get("extra_subjects")
            subject_boost_mask = subject_boost_mask if subject_boost_mask is not None else workspace.get("subject_boost_mask")
            edit_mask = edit_mask if edit_mask is not None else workspace.get("edit_mask")
            settings = settings if settings is not None else workspace.get("settings")
            output_latent = output_latent if output_latent is not None else workspace.get("output_latent")
            # the workspace's studio-preset choice (opt-in) overrides the node's own
            # preset widget, announced the same way as everything else in this chain
            ws_preset = str(workspace.get("preset") or "").strip()
            if ws_preset and ws_preset != preset:
                print(f"[Krea2 RedNode] workspace preset {ws_preset!r} overrides the "
                      f"node's {preset!r}")
                preset = ws_preset

            # style_strength is the one widget the bundle may override: the workspace dial
            # is opt-in, so setting it IS the explicit choice. Announced, never silent.
            ws_strength = workspace.get("style_strength")
            if ws_strength is not None and float(ws_strength) != float(style_strength):
                print(f"[Krea2 RedNode] workspace style_strength {float(ws_strength):.2f} "
                      f"overrides the node's {float(style_strength):.2f}")
                style_strength = float(ws_strength)

        # Preset rules: 'custom (use settings)' hands control to the connected Settings
        # node; any NAMED preset (built-in or saved) wins even when settings are connected.
        if preset == CUSTOM_SENTINEL:
            if settings is not None:
                cfg = dict(settings)
                print("[Krea2 RedNode] using the connected settings")
            else:
                cfg = dict(PRESETS[_DEFAULT_PRESET])
                # the designed default now, not a misconfiguration: no workspace, no
                # settings and no named preset simply means Balanced
                print(f"[Krea2 RedNode] nothing connected, using '{_DEFAULT_PRESET}'")
        else:
            user_presets = _load_user_presets()
            known = resolve_preset_name(preset)
            cfg = PRESETS.get(known) if known else user_presets.get(preset)
            if cfg is None:
                print(f"[Krea2 RedNode] WARNING: preset {preset!r} not found (deleted saved preset?) "
                      f"- falling back to '{_DEFAULT_PRESET}'")
                cfg = PRESETS[_DEFAULT_PRESET]
            cfg = dict(cfg)
            if settings is not None:
                print(f"[Krea2 RedNode] preset '{preset}' overrides the connected settings "
                      f"(choose '{CUSTOM_SENTINEL}' to use them)")
            else:
                print(f"[Krea2 RedNode] preset '{preset}'")
        args = _fusion_args(cfg)
        args["strength"] = float(style_strength)

        # training order for two-ref edit LoRAs is scene first, subject second — handled here
        # so users never have to know it.
        if scene_image is not None:
            ref1, ref2 = scene_image, subject_image
        else:
            ref1, ref2 = subject_image, None

        (positive,) = pkg.Krea2MoodboardIdentityFusion().encode(
            clip=clip, instruction=instruction,
            edit_source=ref1, edit_source2=ref2,
            moodboard_images=moodboard_style, vae=vae,
            sources=extra_subjects, target_latent=output_latent,
            ref_boost_mask=subject_boost_mask, edit_mask=edit_mask, **args)

        # the negative shares everything geometry/locality-related (edit_mask on BOTH passes
        # keeps CFG consistent inside the keep region) but no boost dials — boosts are
        # positive-only, so boost_blocks has nothing to restrict here.
        # An EMPTY negative prompt is the grounded unconditional: the same references
        # with no words, which is exactly what the edit model was trained against, and
        # the right answer for turbo work at CFG 1. Written words here only start
        # steering the image once CFG is above 1, which is why the box is optional and
        # empty by default rather than pre-filled with the usual junk list.
        neg_words = str(negative_prompt or "").strip()
        if neg_words:
            print(f"[Krea2 RedNode] negative prompt in use ({len(neg_words)} chars). "
                  "At CFG 1 this has no effect; it steers only above 1.", flush=True)
        from .identity import Krea2IdentityEdit
        (negative,) = Krea2IdentityEdit().encode(
            clip=clip, prompt=neg_words, vae=vae,
            image=ref1, image2=ref2, sources=extra_subjects,
            grounding_px=args["grounding_px"],
            grounding_px_subject=args["grounding_px_subject"],
            target_latent=output_latent, fit_mode=args["fit_mode"],
            ref_start=args["ref_start"], ref_end=args["ref_end"],
            edit_mask=edit_mask, edit_mask_feather=args["edit_mask_feather"],
            isolate_refs=args["isolate_refs"],
            picture_labels=args["picture_labels"],
            ref_t0_modulation=args["ref_t0_modulation"],
            system_prompt=args["system_prompt"],
            attention=args["attention"])

        return (positive, negative)
