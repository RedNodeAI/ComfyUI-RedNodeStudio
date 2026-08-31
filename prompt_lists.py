"""Pick-lists for the Prompt Frame node: lighting, and placement building blocks.

LIGHTING is built from two pieces of evidence. Which lighting concepts matter comes from
the 3549-moodboard Krea catalogue (25,395 keywords): chiaroscuro dominates at ~700 uses
across its variants, then silhouette/backlit, golden hour, soft diffused, low-key, dappled
sunlight, volumetric and studio. How to word them comes from the civitai corpus: lighting
is followed when it names a source, a direction and what it lands on, and largely ignored
when it is a bare label. "Cinematic lighting" measured as a large change with no control —
it hands the decision back to the model. So every entry below is written the long way.

PLACEMENT_* exist because a placement has to name something already in the scene or the
subject can vanish at wide framings. Prepositions plus common anchor objects cover most of
what people actually write, and both lists are editable text once inserted.
"""

NONE = "None"

# source + direction + what it lands on, every time
LIGHTING = {
    "Hard side light (chiaroscuro)": (
        "A single hard light from one side, carving a bright edge along the subject and "
        "dropping the far side into deep shadow"),
    "Backlit silhouette": (
        "Strong light from directly behind, reducing the subject to a dark shape with a "
        "bright rim along its edges"),
    "Rim light on dark": (
        "A bright edge light from behind and to one side, separating the subject from a "
        "dark background"),
    "Golden hour": (
        "Low warm sun from the side, raking long shadows across everything and turning the "
        "highlights amber"),
    "Blue hour": (
        "Even blue twilight after sunset with no direct sun, the first warm artificial "
        "lights just beginning to show"),
    "Harsh noon": (
        "Hard sun directly overhead, short black shadows under everything, highlights "
        "blown out"),
    "Overcast flat": (
        "Flat overcast light from above, even and almost shadowless, colours slightly "
        "muted"),
    "Soft window light": (
        "Soft daylight from a window to one side, falling off gently across the subject "
        "into soft shadow"),
    "Soft diffused": (
        "Broad soft light from a large source close by, wrapping around the subject with "
        "no hard shadow edges anywhere"),
    "Studio softbox": (
        "A large soft key light above and to one side with a gentle fill opposite, clean "
        "falloff onto a plain background"),
    "High key": (
        "Bright even light from several directions, almost no shadow anywhere, the "
        "background pale and clean"),
    "Low key": (
        "One small light in darkness, most of the frame falling to near black, only the "
        "essential shapes catching any light"),
    "Dappled sunlight": (
        "Sunlight broken by leaves overhead, scattering bright patches and soft shadow "
        "across the subject and the ground"),
    "Volumetric shafts": (
        "Shafts of light cutting down through haze, the beams clearly visible in the air "
        "and pooling where they land"),
    "Candlelight": (
        "A small warm flame low and close, lighting from below, deep shadow beyond a tight "
        "pool of orange light"),
    "Firelight": (
        "Warm flickering light from below and to one side, orange on the nearest surfaces, "
        "the background falling into deep shadow"),
    "Neon two-tone": (
        "Coloured neon light from two sides, magenta from one and cyan from the other, wet "
        "surfaces catching both"),
    "Screen glow": (
        "Cold blue light from a screen just out of frame, lighting the subject from below "
        "and leaving the room behind dark"),
    "Streetlight at night": (
        "A sodium streetlight overhead, orange light pooling on wet ground, everything "
        "beyond the pool falling away into dark"),
    "Moonlight": (
        "Cool blue light from high above, low contrast throughout, detail sinking away "
        "into the shadows"),
}

LIGHTING_CHOICES = [NONE] + list(LIGHTING)

# Styles that light the scene themselves; picking one of these AND a lighting option is
# usually a mistake. Kept here so the node can say so.
SELF_LIT_STYLES = {"Photo: phone flash", "Photo: editorial",
                   "Photo: nocturnal low-key"}

PLACEMENT_PREPOSITIONS = [
    NONE, "on", "in", "under", "on top of", "beside", "behind", "in front of",
    "at the edge of", "at the foot of", "against", "between", "leaning on", "sitting on",
    "standing on", "half-hidden by", "framed by", "reflected in", "next to", "beneath",
    "perched on",
]

PLACEMENT_OBJECTS = [
    NONE, "the bed", "the chair", "the sofa", "the table", "the desk", "the window",
    "the doorway", "the staircase", "the wall", "the fence", "the railing", "the tree",
    "the rock", "the bench", "the counter", "the bridge", "the path", "the shoreline",
    "the car", "the bookshelf", "the far wall",
]


# How bright the whole frame is, separately from where the light comes from. -3 to +3,
# 0 emits nothing at all so the lighting choice is left to speak for itself.
# Verified 2026-08-05 as a monotonic ramp: mean frame luminance rises step by step across
# the range, so the slider does what the label says.
EXPOSURE = {
    -3: ("The frame is very dark, almost everything falling away to black, only the few "
         "essential shapes catching any light at all"),
    -2: "The frame is dark and underexposed, deep shadow covering most of it",
    -1: "The frame sits a little dark, with heavy shadows and few bright areas",
    0:  "",
    1:  "The frame sits a little bright, shadows open and full of detail",
    2:  "The frame is bright and airy, with very little shadow anywhere",
    3:  ("The frame is very bright, close to overexposed, highlights washing out and "
         "almost no shadow left"),
}

EXPOSURE_MIN, EXPOSURE_MAX = -3, 3


def lighting(name):
    """Lighting text for a choice. NONE or unknown gives ''."""
    return LIGHTING.get(name, "")


def exposure(level):
    """Brightness wording for a slider step. 0 gives '' so nothing is forced."""
    try:
        level = int(level)
    except (TypeError, ValueError):
        return ""
    return EXPOSURE.get(max(EXPOSURE_MIN, min(EXPOSURE_MAX, level)), "")


def build_placement(preposition, obj, written=""):
    """Written text always wins; the two dropdowns are a shortcut, not a replacement."""
    written = " ".join((written or "").split()).strip()
    if written:
        return written
    if preposition in (NONE, "", None) or obj in (NONE, "", None):
        return ""
    return "%s %s" % (preposition, obj)
