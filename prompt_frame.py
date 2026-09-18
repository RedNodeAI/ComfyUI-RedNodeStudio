"""RedNode Prompt Frame — assembles a prompt in the order that controls framing.

Krea 2 decides how tight or wide a shot is from what the prompt describes FIRST and at
greatest length. Measured on this install (Comfy Development/projects/prompt-corpus/
POSITION_AND_FRAMING.md): flipping a prompt from subject-first to surroundings-first drops
the subject's share of frame from ~35% to ~3%, with total word count held constant. The
same ladder reproduced on three unrelated subject/scene pairs.

So this node keeps the two competing parts in separate boxes and emits them in the order
the chosen framing needs. It re-orders your text; it never rewrites it.

Two other measured facts shape the design:

  - Everything that is not competing for the frame (palette, lighting, mood, texture) is
    obeyed wherever it sits: an isolated instruction moved from the front of a prompt to
    the back changed adherence by ~2 dE, i.e. nothing. Those go in one free box with no
    ordering logic.
  - At the wide end the subject can vanish outright unless it is anchored to something
    already named in the surroundings. "Somewhere in it, a camera" lost the camera;
    "Sitting on the green cutting mat in the middle of the bench, a camera" did not.
"""

import json
import os

try:
    from .style_library import (CHOICES as STYLE_CHOICES, NONE as STYLE_NONE, block,
                                light_conflict_note, palette_note)
    from .prompt_lists import (LIGHTING_CHOICES, NONE as LIST_NONE, PLACEMENT_OBJECTS,
                               PLACEMENT_PREPOSITIONS, SELF_LIT_STYLES, build_placement,
                               EXPOSURE_MIN, EXPOSURE_MAX, exposure,
                               lighting as lighting_text)
except ImportError:  # loaded as a plain file (tests)
    from style_library import (CHOICES as STYLE_CHOICES, NONE as STYLE_NONE, block,
                               light_conflict_note, palette_note)
    from prompt_lists import (LIGHTING_CHOICES, NONE as LIST_NONE, PLACEMENT_OBJECTS,
                              PLACEMENT_PREPOSITIONS, SELF_LIT_STYLES, build_placement,
                              EXPOSURE_MIN, EXPOSURE_MAX, exposure,
                              lighting as lighting_text)

# framing steps, tightest first. The real switch is between "Half" and "Balanced":
# everything above puts the subject first, everything below puts the surroundings first.
FRAMINGS = ["Portrait", "Half body", "Balanced", "Full scene", "Roomscale"]
SUBJECT_FIRST = {"Portrait", "Half body"}
PLACEMENT_NEEDED = {"Full scene", "Roomscale"}

LEAD_IN = {
    "Portrait": "A close view of ",
    "Half body": "A three-quarter view of ",
}
JOIN = {
    "Balanced": "In the middle of it, ",
    "Full scene": "",
    "Roomscale": "",
}
# Scale cue appended after the subject at the two widest steps. Without these, Balanced,
# Full scene and Roomscale all assemble identically once a placement is supplied, which
# would make three of the five dropdown entries the same prompt.
SCALE_CUE = {
    "Full scene": "seen full length",
    "Roomscale": "small in the distance",
}

# CAMERA HEIGHT, (2026-08-17), rewritten the same day from their
# research into Krea's own Krea 2 prompting docs, June 2026 slider notes and
# community testing. The findings that shape this table:
#   - treat the camera as a PHYSICAL OBJECT: position -> direction -> the
#     subject's relation to it -> which surfaces it sees -> the ground/sky. Each
#     stop stacks those as mutually reinforcing constraints a natural-language
#     encoder cannot quietly reinterpret as eye level; a bare "high angle" can.
#   - a lens per stop: 50mm for gentle stops, wider as the angle steepens, never
#     below ~18mm or the model reads "crazy wide" instead of "camera above".
#   - high angle, near-overhead and true top-down are DIFFERENT results, so the
#     scale has seven stops, three each side of eye level, not five.
#   - camera-first: the block LEADS the prompt (community testing reports strong
#     positional bias for camera/lens words), so assemble() puts it in front of
#     everything, before the style block. Eye level says nothing.
# Two knobs the research calls decisive live OUTSIDE the prompt and the tooltip
# says so: Krea's Movement slider (+30-50 obeys angles far better than the
# -10..0 you run), Creativity Raw/Low, and moodboard strength kept to
# 20-40% while the geometry is being solved, since references carry composition.
CAMERA_HEIGHTS = ["Worm's eye", "Low angle", "Slight low", "Eye level",
                  "Slight high", "High angle", "Bird's eye"]
# The words come from the Camera Studio translator (camera_translate.py), the
# one source of truth the studio node also runs - tuned against real renders on
# 2026-08-17 (CAMERA_STUDIO.md). This table is built from it at import: the
# frame's Camera height dial and the studio can never disagree about a stop.
try:
    from . import camera_translate as _ct
except ImportError:  # loaded as a plain file (tests)
    import camera_translate as _ct


def _camera_stop_text(stop):
    if stop == "Eye level":
        return ""
    cam = _ct.preset_camera(stop)
    subj = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7, "facing_deg": 0}]
    # the frame wants only the vertical block and the lens: the subject's
    # facing and distance sentence belongs to the studio, where you placed
    # a real camera; here the stop is a viewpoint, not a blocking
    geo = _ct.camera_geometry(cam["pos"], [0, 1.7 * 0.92, 0])
    block = _ct.vertical_block(geo, cam["pos"][1], 1.7)
    return block + " " + _ct.lens_phrase(cam["focal_mm"])


CAMERA_HEIGHT_TEXT = {stop: _camera_stop_text(stop) for stop in CAMERA_HEIGHTS}

# PUSHING THE FRAMING HARDER. Two levers, because the framing loses to two different
# things and each needs its own answer.
#
# Position: the scale cue sits right after the subject, and everything about light and
# colour comes after it, so on a full prompt the framing instruction ends up in the
# middle with forty words behind it. The front and the end are where an autoregressive
# encoder pays most attention, and the cue holds neither. "Restate" adds a short closing
# sentence so it holds both.
#
# Vocabulary: "small in the distance" is scene description. "Extreme long shot" is a
# framing LABEL, and captions are full of those, so it is read as an instruction about
# the camera instead of a detail about the woman.
#
# Off by default. These change what an existing workflow emits, and a prompt that
# quietly rewrites itself after an update is worse than one that needs a box ticked.
PUSH_OFF = "Off"
PUSH_RESTATE = "Restate at the end"
PUSH_CAMERA = "Camera words"
PUSH_BOTH = "Both"
FRAMING_PUSH = [PUSH_OFF, PUSH_RESTATE, PUSH_CAMERA, PUSH_BOTH]

# The label a caption would use for each step, and the closing restatement.
CAMERA_CUE = {
    "Portrait": "close-up portrait",
    "Half body": "medium shot",
    "Balanced": "medium wide shot",
    "Full scene": "full body, wide shot",
    "Roomscale": "extreme long shot, the figure small in frame",
}
CLOSING = {
    "Portrait": "Close-up portrait, the face filling the frame.",
    "Half body": "Medium shot, from the waist up.",
    "Balanced": "Medium wide shot, the figure and the place both in view.",
    "Full scene": "Wide shot, the whole figure small against the scene.",
    "Roomscale": "Extreme long shot, the figure very small in a wide frame.",
}

# Words that mean a block of text is describing its own light. Used to spot the collision
# between a style that lights itself and a Lighting choice, for style text arriving on the
# wire as well as from the dropdown, where only the dropdown was ever checked. A word list
# is a rough test, so it only ever produces a note, never a change to the prompt.
LIGHT_WORDS = ("light", "lighting", "lit", "shadow", "highlight", "backlit", "ambient",
               "sunlit", "glow", "exposure", "silhouette")

CUSTOM = "Custom"

# Teaching presets. Each one exists to answer a placement question people actually ask,
# by showing the answer rather than explaining it. Loading a preset fills both boxes.
PRESETS = {
    "Close portrait": {
        "framing": "Portrait",
        "subject": ("a woman in her thirties, dark hair pushed back, a worn red waterproof "
                    "jacket zipped to the chin, wind-reddened cheeks, a faint scar through "
                    "one eyebrow"),
        "surroundings": "grey cloud, out of focus",
        "placement": "",
        "light_and_colour": "overcast daylight, muted palette of slate, rust and bone",
        "note": "Clothing, hair and expression all belong to Subject. They travel with the "
                "person, so they are part of the person.",
    },
    "Character in a room": {
        "framing": "Half body",
        "subject": ("a man in his forties in a heavy knitted jumper, sleeves pushed up, "
                    "reading glasses pushed onto his forehead"),
        "surroundings": ("a cluttered home study in soft focus: shelves of books, a desk "
                         "lamp, papers"),
        "placement": "",
        "light_and_colour": "warm lamplight from the left, deep shadows",
        "note": "The jumper is Subject; the shelves are Surroundings. If it stays behind "
                "when he walks out of the room, it is Surroundings.",
    },
    "Full body in a space": {
        "framing": "Balanced",
        "subject": "a woman in a long coat and boots, holding a paper cup",
        "surroundings": ("an empty train platform at dawn: wet concrete, a row of steel "
                         "benches, a departure board, tracks curving away"),
        "placement": "standing beside the second bench",
        "light_and_colour": "cold blue light, long reflections on the wet concrete",
        "note": "Surroundings now leads, so the figure shrinks to fit what is left. That "
                "single swap is what zooms the camera out.",
    },
    "Wide scene, small figure": {
        "framing": "Roomscale",
        "subject": "a small figure in a yellow jacket",
        "surroundings": ("a wide view of a whole quarry: terraced grey rock, a flooded pit "
                         "of still green water, a haul road switchbacking up the far wall, "
                         "machinery parked at the top"),
        "placement": "standing at the water's edge on the lowest terrace",
        "light_and_colour": "flat overcast light, desaturated except the jacket",
        "note": "At this width the subject disappears without a placement. Name something "
                "already in the Surroundings and put the figure on it.",
    },
    "Object, no person": {
        "framing": "Balanced",
        "subject": ("a battered black rangefinder camera, chrome worn to brass at the "
                    "corners, a frayed leather strap"),
        "surroundings": ("a cluttered repair bench: a green cutting mat, screwdrivers in a "
                         "rack, a magnifier lamp, jars of screws"),
        "placement": "sitting on the cutting mat under the magnifier lamp",
        "light_and_colour": "warm workshop light, shallow depth of field",
        "note": "Subject does not have to be a character. The same ordering rule frames an "
                "object against its setting.",
    },
}


def _clean(text):
    return " ".join((text or "").split()).strip()


def _sentence(text):
    """Trim trailing punctuation so the node can supply its own."""
    text = _clean(text)
    return text[:-1].rstrip() if text.endswith((".", ",", ";")) else text


def _cap(text):
    return text[0].upper() + text[1:] if text else text


# Same font/colour choices the Prompt Box offers, so the two boxes look like one product.
TEXT_COLORS = ["default", "white", "green", "amber", "cyan", "pink", "red", "blue"]


def _join_in(*parts):
    """Join text blocks into sentences. Socket text adds to typed text, never replaces it.

    Only parts AFTER the first are capitalised. The first keeps whatever case it was
    written in, because assemble() decides where that block sits and capitalises it there
    if it starts a sentence. Capitalising it here produced "In the middle of it, A hiker".
    """
    out = []
    for part in parts:
        part = _sentence(part)
        if not part:
            continue
        out.append(_cap(part) if out else part)
    return ". ".join(out)


def expand(text, seed=0, resolve_wildcards=True):
    """@keywords then __wildcards__, exactly the order the Prompt Box uses.

    Applied AFTER assembly so a wildcard can sit in any box, and so a keyword that
    expands to several sentences still lands in the right block.
    """
    try:
        try:
            from .prompt_library import expand_keywords
        except ImportError:
            from prompt_library import expand_keywords
        text = expand_keywords(text)
    except Exception:
        pass  # keyword library unavailable: leave @keywords as written
    if resolve_wildcards:
        try:
            try:
                from .wildcards import resolve
            except ImportError:
                from wildcards import resolve
            text = resolve(text, seed)
        except Exception:
            pass  # wildcard engine unavailable: leave __wildcards__ as written
    return text


def assemble(style, subject, surroundings, framing, placement, light_and_colour,
             push=PUSH_OFF, camera_height="Eye level", camera=None, camera_off=False):
    """Order the parts for the chosen framing. Pure text; no rewriting of user words.

    `camera` is a Camera Studio state (dict with camera/subjects); when given,
    its translator paragraph LEADS the prompt and stands in for the simple
    camera-height stop, so one engine writes every camera word.
    """
    style, light_and_colour = _sentence(style), _sentence(light_and_colour)
    subject, surroundings = _sentence(subject), _sentence(surroundings)
    placement = _sentence(placement)

    camera_words = push in (PUSH_CAMERA, PUSH_BOTH)
    restate = push in (PUSH_RESTATE, PUSH_BOTH)

    parts = []
    # CAMERA FIRST: the block leads everything, before the style, because a
    # camera instruction that arrives after the picture is already established
    # in the reader's head loses; in front, everything else is described from
    # that viewpoint. Eye level contributes nothing.
    cam = ""
    studio_live = False
    if isinstance(camera, dict) and camera.get("camera"):
        try:
            cam = _ct.describe(camera["camera"], camera.get("subjects") or [])
            studio_live = bool(cam)
        except Exception:
            cam = ""
    if not cam:
        cam = CAMERA_HEIGHT_TEXT.get(camera_height, "")
    # CAMERA WORDS OFF: no paragraph, no height stop, no shot-size lead-in or
    # cue, no closing restatement. The subject and the place stand on their own.
    if camera_off:
        cam, studio_live, camera_words, restate = "", False, False, False
    # ONE ENGINE FOR THE CAMERA: with the studio live its paragraph carries the
    # framing too ("framed as ..."), so the simple shot-size wording steps out.
    # Left in, "A three-quarter view of ..." after "Direct overhead photograph"
    # read as an angle and pulled the render off the top-down view (your
    # boxing report, 2026-08-18).
    if studio_live:
        camera_words = False
        restate = False
    if cam and (subject or surroundings):
        parts.append(_cap(cam) if cam.endswith(".") else _cap(cam) + ".")
    if style:
        parts.append(_cap(style) + ".")

    if framing in SUBJECT_FIRST:
        lead = "" if (studio_live or camera_off) else LEAD_IN.get(framing, "")
        if subject:
            parts.append(_cap(lead + subject if lead else subject) + ".")
            # the tight steps carry their framing in the lead-in, so the camera word goes
            # beside the subject rather than replacing wording that is already doing the job
            if camera_words and CAMERA_CUE.get(framing):
                parts.append(_cap(CAMERA_CUE[framing]) + ".")
        if surroundings:
            parts.append(_cap(surroundings) + ".")
    else:
        if surroundings:
            parts.append(_cap(surroundings) + ".")
        tail = []
        join = "" if (studio_live or camera_off) else JOIN.get(framing, "")
        if placement:
            tail.append(placement.rstrip(",") + ",")
        elif join:
            tail.append(join.rstrip())
        if subject:
            tail.append(subject)
        # the camera label replaces the descriptive cue rather than joining it: two
        # framing phrases in one clause read as two instructions, not a louder one
        cue = (CAMERA_CUE.get(framing) if camera_words else None) or SCALE_CUE.get(framing)
        if studio_live or camera_off:
            cue = None
        if cue and subject:
            tail.append("," + " " + cue)
        if tail:
            joined = " ".join(t for t in tail if t).replace(" ,", ",")
            parts.append(_cap(joined) + ".")

    if light_and_colour:
        parts.append(_cap(light_and_colour) + ".")
    # LAST, after the light: the point is to hold the end of the prompt, and anything
    # appended after this would take that position back off it.
    if restate and (subject or surroundings) and CLOSING.get(framing):
        parts.append(CLOSING[framing])
    return " ".join(parts)


# SAVED SNIPPETS, one store per section of the frame: a style you keep coming
# back to, a subject you draw every week, a place, a light. Each section saves
# and loads its own fields only, so a saved subject never drags a style along.
SNIPPET_KEYS = {
    "style": ("style", "style_extra"),
    "subject": ("subject",),
    "surroundings": ("surroundings",),
    "light": ("lighting", "brightness", "light_and_colour"),
}
_SNIPPET_PATH = {"override": ""}     # tests point this at a temp file


def _snippet_path():
    if _SNIPPET_PATH["override"]:
        return _SNIPPET_PATH["override"]
    import os as _os
    import folder_paths as _fp
    base = _os.path.join(_fp.get_user_directory(), "default", "rednode")
    _os.makedirs(base, exist_ok=True)
    return _os.path.join(base, "frame_snippets.json")


def load_snippets():
    """{section: {name: {field: value}}}, every section present."""
    out = {k: {} for k in SNIPPET_KEYS}
    try:
        with open(_snippet_path(), encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return out
    if not isinstance(d, dict):
        return out
    for sec, keys in SNIPPET_KEYS.items():
        items = d.get(sec) if isinstance(d.get(sec), dict) else {}
        for name, val in items.items():
            if isinstance(val, dict) and str(name).strip():
                out[sec][str(name).strip()[:64]] = {k: val[k] for k in keys if k in val}
    return out


def save_snippet(section, name, value=None, delete=False):
    """Save or delete one snippet; returns the section's names or raises ValueError."""
    if section not in SNIPPET_KEYS:
        raise ValueError("no such section: %r" % section)
    name = str(name or "").strip()[:64]
    if not name:
        raise ValueError("a snippet needs a name")
    lib = load_snippets()
    if delete:
        lib[section].pop(name, None)
    else:
        val = value if isinstance(value, dict) else {}
        lib[section][name] = {k: val[k] for k in SNIPPET_KEYS[section] if k in val}
    with open(_snippet_path(), "w", encoding="utf-8") as f:
        json.dump(lib, f, indent=1)
    return sorted(lib[section])


class RedNodePromptFrame:
    """Subject + Surroundings, emitted in the order that sets the framing."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "subject": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Who or what the picture is about, and how it looks. "
                               "Clothing, hair, colours and expression go here: if it "
                               "moves with the character, it belongs to the subject."}),
                "surroundings": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Where it is. Room, landscape, background, props. If it "
                               "stays behind when the subject walks away, it goes here."}),
                "framing": (FRAMINGS, {
                    "default": "Balanced",
                    "tooltip": "How tight the shot is. Portrait and Half body put the "
                               "subject first; Balanced and wider put the surroundings "
                               "first, which is what pulls the camera back."}),
                "placement_where": (PLACEMENT_PREPOSITIONS, {
                    "default": LIST_NONE,
                    "tooltip": "Quick placement, first half: on, under, beside, behind. "
                               "Use with the next box. Anything typed into Placement "
                               "overrides both."}),
                "placement_what": (PLACEMENT_OBJECTS, {
                    "default": LIST_NONE,
                    "tooltip": "Quick placement, second half: the bench, the doorway, the "
                               "tree. Pick something you already described in "
                               "Surroundings, or the model has nothing to attach to."}),
                "placement": ("STRING", {
                    "default": "", "dynamicPrompts": False,
                    "tooltip": "Where the subject is standing or sitting, named against "
                               "something you already put in Surroundings, for example "
                               "\"on the second bench\" or \"at the water's edge\". "
                               "Overrides the two dropdowns above. Needed at Full scene "
                               "and Roomscale, where the subject can vanish without it. "
                               "Ignored at Portrait and Half body."}),
                "brightness": ("INT", {
                    "default": 0, "min": EXPOSURE_MIN, "max": EXPOSURE_MAX, "step": 1,
                    "display": "slider",
                    "tooltip": "How light or dark the whole frame is, separately from "
                               "where the light comes from. 0 says nothing and leaves it "
                               "to the lighting choice. Measured as a smooth ramp: mean "
                               "brightness runs 0.17 at -3 up to 0.67 at +3."}),
                "lighting": (LIGHTING_CHOICES, {
                    "default": LIST_NONE,
                    "tooltip": "Twenty lighting setups, each written as a source, a "
                               "direction and what the light lands on, which is the form "
                               "the model actually follows. Added before your own Light "
                               "and colour text."}),
                "light_and_colour": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Lighting, palette and mood, for example \"low sun from the "
                               "left, muted slate and rust, quiet and still\". Added at the "
                               "end. Order does not matter for these, so nothing is "
                               "rearranged."}),
                "style": (STYLE_CHOICES, {
                    "default": STYLE_NONE,
                    "tooltip": "How the picture is made, emitted before everything else. "
                               "Nine tested blocks, none of which need a LoRA. Pick None "
                               "to let the checkpoint decide, or to use only your own "
                               "wording in Style extra."}),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                    "tooltip": "Seed for __wildcard__ picks. Same seed gives the same "
                               "result; set the control to randomize to re-roll every "
                               "run."}),
                "resolve_wildcards": ("BOOLEAN", {
                    "default": True, "label_on": "resolve __wildcards__",
                    "label_off": "pass through",
                    "tooltip": "ON: this node resolves __wildcards__ and {a|b} itself. "
                               "OFF: they pass through untouched for an external wildcard "
                               "node. @keywords are always expanded."}),
                "font_size": ("INT", {
                    "default": 13, "min": 8, "max": 32, "step": 1,
                    "tooltip": "Text size in this panel only. Does not change the "
                               "prompt."}),
                "text_color": (TEXT_COLORS, {
                    "default": "default",
                    "tooltip": "Text colour in this panel only. Does not change the "
                               "prompt."}),
            },
            "optional": {
                # sockets, so any node that emits text can feed the two boxes that most
                # often come from somewhere else. Appended to whatever is typed, never
                # replacing it, so a helper node adds to the scene instead of wiping it.
                "surroundings_in": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Text from another node, added to the end of Surroundings. "
                               "Anything that outputs a STRING will do."}),
                "style_in": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Text from another node, added after the chosen style and "
                               "your Style extra."}),
                "subject_in": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Text from another node, added to the end of Subject."}),
                "light_and_colour_in": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Text from another node, added to the end of Light and "
                               "colour. Pair this with RedNode Describe To Boxes."}),
                "style_extra": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Your own style wording, added after the chosen style. Use "
                               "it to adjust a preset, or on its own with style set to "
                               "None. Right-click to convert to an input if you would "
                               "rather wire it in."}),
                # APPENDED, and it has to be. widgets_values is positional, so an input
                # added higher up moves every value a saved workflow holds below it.
                "camera": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": "Camera Studio state as JSON (the panel writes it). "
                               "When set, its paragraph leads the prompt and the "
                               "simple camera height stop is superseded."}),
                "camera_off": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "On: no camera words at all. The shot size wording, the "
                               "camera height stop and the Camera Studio's paragraph all "
                               "stay out, and the subject and the place stand on their "
                               "own. The camera settings are kept for when this goes off "
                               "again."}),
                "camera_height": (CAMERA_HEIGHTS, {
                    "default": "Eye level",
                    "tooltip": "Where the camera stands, from the ground looking up "
                               "to straight down; the framing slider is zoom, this is "
                               "height. Eye level adds nothing. Each stop LEADS the "
                               "prompt with a physical camera description: position, "
                               "tilt, what it sees of the subject, the floor or sky, "
                               "and a lens - the form Krea 2 obeys. Two knobs outside "
                               "the prompt matter as much: Krea's Movement slider "
                               "(+30 to +50 obeys angles far better than 0) with "
                               "Creativity on Raw or Low, and moodboard strength kept "
                               "to 20-40% while you solve the angle, since references "
                               "carry composition."}),
                "framing_push": (FRAMING_PUSH, {
                    "default": PUSH_OFF,
                    "tooltip": "Push the framing harder when a long prompt is talking over "
                               "it. Restate at the end repeats the shot as a closing "
                               "sentence, so the framing holds the front and the end of the "
                               "prompt instead of the middle. Camera words swap the "
                               "descriptive cue for the label a caption would use "
                               "(\"extreme long shot\" rather than \"small in the "
                               "distance\"), which is read as an instruction about the "
                               "camera. Off leaves the prompt exactly as it was."}),
                "extra": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Anything else, typed as is and added after everything "
                               "the frame placed. Press Auto sort to file it into the "
                               "boxes instead."}),
                "extra": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Anything else, typed as is and added after everything "
                               "the frame placed. Press Auto sort to file it into the "
                               "boxes instead."}),
                "extra": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Anything else, typed as is and added after everything "
                               "the frame placed. Press Auto sort to file it into the "
                               "boxes instead."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "notice")
    FUNCTION = "run"
    CATEGORY = "RedNode/Prompt"

    def run(self, subject, surroundings, framing, placement, light_and_colour,
            placement_where=LIST_NONE, placement_what=LIST_NONE, lighting=LIST_NONE,
            brightness=0, seed=0, resolve_wildcards=True, font_size=13,
            text_color="default",
            style=STYLE_NONE, style_extra="",
            surroundings_in="", style_in="", subject_in="", light_and_colour_in="",
            framing_push=PUSH_OFF, camera_height="Eye level", camera="",
            camera_off=False, extra=""):
        style_text = _join_in(block(style), style_extra, style_in)
        cam_state = None
        if isinstance(camera, str) and camera.strip():
            try:
                cam_state = json.loads(camera)
            except ValueError:
                cam_state = None
        elif isinstance(camera, dict):
            cam_state = camera
        subject = _join_in(subject, subject_in)
        surroundings = _join_in(surroundings, surroundings_in)
        placed = build_placement(placement_where, placement_what, placement)
        # THE STAGE'S LIGHTS (2026-08-18). A light standing on the studio stage
        # writes this box, exactly as its camera writes the camera paragraph:
        # source, direction, what it lands on, the shadow character its real
        # angular size implies. It leads the box, because a placed rig is a
        # decision and the free text around it is seasoning.
        rig_light, rig_step = "", 0
        if cam_state:
            try:
                from . import camera_studio as _cs
                from . import camera_translate as _ct2
                _st = _cs.parse_state(json.dumps(cam_state))
                rig_light = _ct2.light_words(_st["camera"], _st["subjects"], _st["lights"])
                rig_step = _ct2.rig_level(_st["camera"], _st["subjects"], _st["lights"])
            except Exception:
                rig_light = ""
        lit = _join_in(rig_light, lighting_text(lighting), exposure(brightness),
                       light_and_colour, light_and_colour_in)
        prompt = assemble(style_text, subject, surroundings, framing, placed, lit,
                          framing_push, camera_height, cam_state,
                          camera_off=bool(camera_off))
        # THE EXTRA BOX: anything typed there rides at the end, as written, after
        # everything the frame placed (Auto sort files it into the boxes instead)
        if _clean(extra):
            tail = _cap(_sentence(extra)) + "."
            prompt = (prompt.rstrip() + (" " if prompt.strip() else "") + tail).strip()
        prompt = expand(prompt, seed, resolve_wildcards)
        words = len(prompt.split())

        notes = []
        note = palette_note(style)
        if note and _clean(lit):
            notes.append(note)
        clash = light_conflict_note(style, surroundings)
        if clash:
            notes.append(clash)
        # A style block wired in from a moodboard describes its own light as readily as
        # one off the dropdown, and only the dropdown was ever checked, so the collision
        # this is built to catch went unmentioned on exactly the prompts most likely to
        # hit it. Only fires when the dropdown checks below cannot: no style chosen here,
        # but style text arriving from somewhere else.
        if style not in SELF_LIT_STYLES and lighting != LIST_NONE:
            wired = _clean(_join_in(style_extra, style_in)).lower()
            if any(w in wired for w in LIGHT_WORDS):
                notes.append("The style text sets its own light, and the %s option will "
                             "fight it. Use one or the other." % lighting)
        # the rig's own level and the Brightness dial can pull opposite ways:
        # "a dim scene, most of the frame sinking into shadow" next to "the
        # frame is bright and airy" is a contradiction the model resolves by
        # picking one, which reads as the dial doing nothing
        if rig_step and brightness and (rig_step > 0) != (int(brightness) > 0):
            notes.append("The stage's lights make this %s and Brightness asks for the "
                         "opposite. Turn the lights' Power up or down instead, or set "
                         "Brightness back to 0."
                         % ("a bright scene" if rig_step > 0 else "a dark scene"))
        if rig_light and lighting != LIST_NONE:
            notes.append("The stage has lights placed, and the %s option describes "
                         "the light too. Use one or the other: clear the option, or "
                         "switch the stage lights off on the Camera tab." % lighting)
        if style in SELF_LIT_STYLES and lighting != LIST_NONE:
            notes.append("%s already sets its own light, so the %s option will fight it. "
                         "Use one or the other." % (style, lighting))
        if _clean(placement) and (placement_where != LIST_NONE
                                  or placement_what != LIST_NONE):
            notes.append("Placement text is set, so the two placement dropdowns are "
                         "ignored.")
        if framing in PLACEMENT_NEEDED and not placed:
            notes.append("No placement set at %s framing. The subject may not appear at all. "
                         "Name a spot in the surroundings, for example \"standing at the "
                         "water's edge\"." % framing)
        if words > 190:
            notes.append("%d words. Long prompts are followed less closely; 90 to 150 is "
                         "the working range." % words)
        elif words > 150:
            notes.append("%d words. Getting long; 90 to 150 is the working range." % words)
        if framing == "Portrait" and len(_clean(surroundings).split()) > 25:
            notes.append("The surroundings are long for Portrait framing, which will pull "
                         "the camera back. Shorten them or choose a wider framing.")
        if not _clean(subject):
            notes.append("Subject is empty.")

        return (prompt, " ".join(notes))


# ---------------------------------------------------------------------------
# HTTP API — teaching presets, read by web/rednode_prompt_frame.js
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    import os as _os

    _FRAME_FIELDS = ("subject", "surroundings", "placement", "light_and_colour",
                     "framing", "style", "style_extra", "lighting", "brightness",
                     "framing_push", "placement_where", "placement_what",
                     "camera_height", "camera")

    def _user_preset_path():
        import folder_paths as _fp
        base = _os.path.join(_fp.get_user_directory(), "default", "rednode")
        _os.makedirs(base, exist_ok=True)
        return _os.path.join(base, "frame_prompts.json")

    def _user_presets():
        try:
            with open(_user_preset_path(), encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    @PromptServer.instance.routes.post("/rednode/frame_prompt_save")
    async def _rednode_frame_prompt_save(request):
        """Save or delete a user frame prompt. The shipped examples are read-only."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        name = str(data.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "no name"}, status=400)
        if name in PRESETS:
            return web.json_response(
                {"error": "%r ships with the pack; save under another name" % name},
                status=400)
        users = _user_presets()
        if data.get("action") == "delete":
            users.pop(name, None)
        else:
            pin = data.get("preset") if isinstance(data.get("preset"), dict) else {}
            users[name] = {k: pin[k] for k in _FRAME_FIELDS if k in pin}
        try:
            with open(_user_preset_path(), "w", encoding="utf-8") as f:
                json.dump(users, f, indent=1)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "user": sorted(users)})

    @PromptServer.instance.routes.get("/rednode/frame_snippets")
    async def _rednode_frame_snippets(request):
        return web.json_response({"snippets": load_snippets()})

    @PromptServer.instance.routes.post("/rednode/frame_snippet_save")
    async def _rednode_frame_snippet_save(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            names = save_snippet(str(data.get("section") or ""), data.get("name"),
                                 data.get("value"), delete=data.get("action") == "delete")
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"ok": True, "names": names})

    @PromptServer.instance.routes.get("/rednode/prompt_frame_presets")
    async def _rednode_prompt_frame_presets(request):
        users = _user_presets()
        merged = {**PRESETS, **users}
        name = request.query.get("name")
        if name:
            if name not in PRESETS:
                return web.json_response({"error": "no such preset"}, status=404)
            return web.json_response({"name": name, "preset": PRESETS[name]})
        return web.json_response({"presets": merged, "user": sorted(users)})

    @PromptServer.instance.routes.post("/rednode/prompt_frame_preview")
    async def _rednode_prompt_frame_preview(request):
        """Assemble exactly as the node would, so the panel never duplicates the rules."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            prompt, notice = RedNodePromptFrame().run(
                subject=data.get("subject", ""),
                surroundings=data.get("surroundings", ""),
                framing=data.get("framing", FRAMINGS[2]),
                placement=data.get("placement", ""),
                light_and_colour=data.get("light_and_colour", ""),
                placement_where=data.get("placement_where", LIST_NONE),
                placement_what=data.get("placement_what", LIST_NONE),
                lighting=data.get("lighting", LIST_NONE),
                brightness=data.get("brightness", 0),
                style=data.get("style", STYLE_NONE),
                style_extra=data.get("style_extra", ""),
                seed=data.get("seed", 0),
                resolve_wildcards=data.get("resolve_wildcards", True),
                framing_push=data.get("framing_push", PUSH_OFF),
                camera_height=data.get("camera_height", "Eye level"),
                camera=data.get("camera", ""),
                camera_off=bool(data.get("camera_off")),
                extra=data.get("extra", ""),
                # text wired into the Workspace's frame sockets, when the panel
                # could read it off the upstream node: joined after each box's
                # own words, exactly as the run joins it
                style_in=str(data.get("style_in") or ""),
                subject_in=str(data.get("subject_in") or ""),
                surroundings_in=str(data.get("surroundings_in") or ""),
                light_and_colour_in=str(data.get("light_and_colour_in") or ""))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"prompt": prompt, "notice": notice,
                                  "words": len(prompt.split())})
except Exception:  # no server (tests, headless import)
    pass
