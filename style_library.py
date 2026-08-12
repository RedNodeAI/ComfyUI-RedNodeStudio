"""Prompt-only style blocks for Krea 2 — no LoRA needed.

Each block describes how the picture is physically made: medium, linework, how colour is
applied, how shadows behave, the texture artefact, and what is crisp versus loose. That
structure came out of matching a reference over 21 rounds, and it transfers: the same six
parts describe a screenprint as well as they describe an ink wash.

Every block below was generated and reviewed on this install (2026-08-04). Seven worked
first time; screenprint and risograph did not, and the fix is noted on each.

An ablation (every block regenerated with one sentence removed, then pixel-diffed against
the full block) found only one inert sentence across ~40 — these are already lean, so
trimming them costs real control. The opening sentence naming the made object is the
strongest clause in almost every block; do not drop it.

Three words to keep out of any new block: "gouache", "animation cel" and "1990s" force a
Ghibli look that overrides every other instruction. "Storybook" pulls Western picture-book.
Subject-class nouns ("figure", "portrait", "character") leak from style into content and
will summon a person into a landscape.
"""

NONE = "None"

STYLES = {
    "Soft anime": (
        "A modern Japanese anime digital illustration. Crisp fine digital lineart of even "
        "thin weight in deep warm brown, sharp and unbroken, with fine interior lines for "
        "surface detail. The subject is coloured with smooth clean digital colour and soft "
        "gradients, no canvas texture and no paper grain. Colour is rich and fully "
        "saturated. Only the background is loose: blocked in with visible dabs and streaks, "
        "clearly looser than the crisply drawn subject. A second layer of light sketch "
        "lines is left visible over the colour. Shadows are a distinctly different hue from "
        "the base colour, cooler and more saturated."),

    "Classic cel animation": (
        "A hand-inked animation cel from a feature film, photographed over a painted "
        "background. The subject is outlined in even-weight black ink and filled with flat "
        "opaque colour, one hard-edged shadow tone and nothing else. The background is "
        "painted separately in soft gouache with visible brush texture, so it sits clearly "
        "behind the line art. Slight film grain over the whole frame."),

    "Screenprint poster": (
        # naming the process was not enough: the reduction has to be an instruction
        "A hand-pulled screenprint poster in three flat spot inks. Think of it as cut "
        "paper: every shape is a flat area of one solid ink with a hard edge, detail "
        "reduced to the simplest silhouette that still reads. Coarse halftone dots for any "
        "mid-tone. The black layer sits slightly off-register from the colour layers. Rough "
        "uncoated stock."),

    "Sumi-e ink wash": (
        "Painted with a loaded bamboo brush on absorbent rice paper. Every stroke starts "
        "heavy and lifts to a dry split end; the ink bleeds outward where the brush rested. "
        "Tone comes only from how much water was in the ink, never from added colour. Most "
        "of the paper is left empty. A single small red seal mark."),

    "Oil painting": (
        "Painted wet-into-wet in oils on primed linen with a loaded flat brush. Each stroke "
        "keeps its own edge instead of blending, ridges of paint catching the light along "
        "every mark. Colour is broken rather than mixed, warm and cool strokes sitting side "
        "by side. The weave of the canvas shows wherever the paint is scraped thin."),

    "Watercolour": (
        "Painted wet-on-wet in transparent watercolour on cold-pressed paper. Washes run "
        "together and bloom where they meet, pigment settling into the paper's texture and "
        "pooling darker at the edge of every shape. Highlights are bare white paper, never "
        "opaque paint. Soft boundaries throughout, with a few confident dark accents "
        "dropped in last."),

    "Charcoal": (
        "Drawn with compressed charcoal on grey paper. Broad areas blocked in with the side "
        "of the stick then smeared flat with a cloth, the darkest accents pressed in with "
        "the tip, highlights cut back out with a kneaded eraser. Loose charcoal dust "
        "catches on the paper tooth. Monochrome, warm black on cool grey."),

    "Risograph": (
        # same fix as screenprint: forbid rendering, or it draws a normal illustration
        "A two-colour risograph print, fluorescent pink and teal only. Every form is a flat "
        "block of one ink or the overprint of both; nothing is blended or shaded. The two "
        "layers are visibly misaligned by several millimetres. Coarse dot screens for tone, "
        "roller streaks, and rough recycled paper showing through."),

    "Graphite sketch": (
        "Drawn in graphite on toothed cartridge paper. Light construction lines are still "
        "visible under the finished strokes, tone built by hatching in one direction then "
        "crossing it, edges smudged with a finger, highlights lifted with an eraser. The "
        "paper grain breaks up every stroke."),

    # --- photographic, amateur to professional -----------------------------------------
    # All six describe optical EFFECTS rather than camera equipment: naming a camera body
    # tested worse in the civitai corpus, while effect words (grain, halation, falloff,
    # depth of field) appear all over the curated Krea moodboard catalogue.

    "Photo: phone flash": (
        # needs a dark scene to work: a window in the surroundings overrides the flash
        "A snapshot lit only by a hard flash at the camera position. The light comes "
        "straight from the viewer, so the nearest surfaces are blown out and everything a "
        "step further back falls off fast into muddy shadow. Hard black shadow edges on the "
        "wall behind. Sensor noise in the darks, slightly crooked framing."),

    "Photo: compact camera": (
        "A casual point-and-shoot photo. Flat automatic exposure, everything from "
        "foreground to background in focus, a faint green cast from mixed indoor light, "
        "mild overall softness, slightly heavy-handed sharpening halo around high-contrast "
        "edges."),

    "Photo: available light": (
        "A photograph taken in available light. Shallow depth of field with the background "
        "falling softly out of focus, natural light falloff across the subject, fine grain "
        "in the shadows, honest skin and fabric texture, careful but unfussy framing."),

    "Photo: editorial": (
        "A professional editorial photograph. Controlled soft key light with a clean "
        "falloff, tack-sharp detail through the plane of focus, neutral colour, smooth "
        "highlight rolloff, every texture legible without looking sharpened."),

    "Photo: 35mm film": (
        "A 35mm film photograph. Visible silver grain, halation blooming around the "
        "brightest highlights, warm highlight rolloff into cream rather than white, gentle "
        "edge softness, colours slightly shifted toward amber and cyan."),

    "Photo: ultra detailed": (
        # deliberately NOT called "large format": that term drags the image to black and
        # white on its own, the same way "gouache" drags it to Ghibli
        "A very high resolution colour photograph. Every surface holds fine micro-detail, "
        "the tonal range runs from open shadow to held highlight without clipping, geometry "
        "is perfectly undistorted, colour is natural and neutral."),
}

# Styles that describe their own light source, so a scene implying different light will
# fight them. Surfaced as a warning when the surroundings mention a window or daylight.
OWN_LIGHT = {"Photo: phone flash", "Photo: editorial"}

# Three of these impose their own palette or drop colour entirely, so a user's palette
# wording in the extras box will fight them. Surfaced in the tooltip.
MONOCHROME = {"Sumi-e ink wash", "Charcoal", "Graphite sketch"}
FIXED_PALETTE = {"Screenprint poster", "Risograph"}

CHOICES = [NONE] + list(STYLES)


def block(name):
    """The style text for a dropdown choice. NONE and anything unknown give ''."""
    return STYLES.get(name, "")


def palette_note(name):
    """Warning text when the chosen style will override the user's colour wording."""
    if name in MONOCHROME:
        return "%s has no colour, so palette wording in Light and colour will be " \
               "ignored." % name
    if name in FIXED_PALETTE:
        return "%s uses its own limited inks, so palette wording in Light and colour may " \
               "be overridden." % name
    return ""


# words in the surroundings that imply a strong daylight source
_DAYLIGHT = ("window", "daylight", "sunlight", "sunlit", "outdoors", "outside", "sky",
             "sun ", "morning light", "afternoon light")


def light_conflict_note(name, surroundings):
    """A style that supplies its own light loses to a scene that implies daylight.

    Measured 2026-08-05: "lit only by a hard flash at the camera position" produced no
    flash at all while the surroundings mentioned a kitchen window. The identical style
    on a dark room rendered the flash correctly.
    """
    if name not in OWN_LIGHT:
        return ""
    low = (surroundings or "").lower()
    hit = next((w for w in _DAYLIGHT if w in low), None)
    if not hit:
        return ""
    return ("%s supplies its own light, but Surroundings mentions \"%s\". The scene's "
            "light usually wins. Remove it, or pick a style that does not light the "
            "scene itself." % (name, hit.strip()))
