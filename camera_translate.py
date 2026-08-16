"""Camera Studio, layer 3: the TRANSLATOR. Geometry in, model language out.

Numbers never go to the model raw. A camera state - where the camera is,
where it looks, its lens - and a scene of subjects become a paragraph in the
form Krea 2 actually obeys (KNOWLEDGE.md, "Krea 2 camera-angle prompting"):
the camera as a PHYSICAL OBJECT, position -> tilt in degrees -> the subject's
relation to it -> which surfaces it sees -> what fills the background -> a
lens. Each of those is a constraint the encoder cannot quietly reinterpret
as an eye-level shot; a bare "high angle" it can.

Coordinates: metres, right-handed. x right, y UP, z toward the viewer (a
subject facing the default camera faces +z). Ground is y = 0. A subject
stands at (x, 0, z) with its head at y = height. The camera is at (x, y, z)
and aims at a target point (a subject's face by default).

Pure functions, no ComfyUI imports: the node, the Prompt Frame's Camera
height dial and the lab all call the same code, so there is one source of
truth for what a "high angle" says.
"""
import math

# ---------------------------------------------------------------- lens table
# focal length -> horizontal FOV on a full-frame 36mm sensor, and the words
# the research says each range should carry. Never below ~14mm in wording:
# past that Krea reads "crazy wide image" instead of "camera position".
LENS_WORDS = [
    (0, 20, "ultra-wide-angle lens"),
    (20, 30, "wide-angle lens"),
    (30, 42, "lens"),
    (42, 70, "lens"),
    (70, 400, "telephoto lens"),
]


def fov_deg(focal_mm, sensor_mm=36.0):
    """Horizontal field of view for a focal length, degrees."""
    f = max(4.0, float(focal_mm))
    return math.degrees(2.0 * math.atan(sensor_mm / (2.0 * f)))


def focal_for_fov(fov, sensor_mm=36.0):
    return sensor_mm / (2.0 * math.tan(math.radians(max(1.0, min(170.0, fov)) / 2.0)))


def lens_phrase(focal_mm):
    f = int(round(float(focal_mm)))
    for lo, hi, word in LENS_WORDS:
        if lo <= f < hi:
            return "Shot with a %dmm %s" % (f, word)
    return "Shot with a %dmm lens" % f


# ---------------------------------------------------------------- geometry
def _v(a, b):
    return (b[0] - a[0], b[1] - a[1], b[2] - a[2])


def _len(v):
    return math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)


def _norm(v):
    n = _len(v) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def camera_geometry(cam_pos, target_pos):
    """The numbers the words are made from: distance, pitch, height delta,
    horizontal (ground) distance, and the yaw of the look direction."""
    d = _v(cam_pos, target_pos)
    dist = _len(d)
    ground = math.sqrt(d[0] ** 2 + d[2] ** 2)
    pitch = math.degrees(math.atan2(d[1], ground)) if (ground or d[1]) else 0.0
    yaw = math.degrees(math.atan2(d[0], -d[2])) if ground else 0.0   # 0 = looking -z
    return {"distance": dist, "ground": ground, "pitch": pitch,     # pitch < 0: down
            "dy": cam_pos[1] - target_pos[1], "yaw": yaw}


# ---------------------------------------------------------------- vertical stops
# The pitch bands and what each says. Wordings are the user's researched
# blocks (KNOWLEDGE.md), parameterised by the real numbers.
def _height_words(cam_y, subj_top, dy_face):
    """How far the camera sits above/below the face, in plain metres."""
    m = abs(dy_face)
    if m < 0.15:
        return "at the subject's eye level"
    if m < 0.6:
        return "roughly %d cm %s the subject's eye level" % (
            int(round(m * 100 / 10.0) * 10), "above" if dy_face > 0 else "below")
    if dy_face > 0:
        above_head = max(0.0, cam_y - subj_top)
        if above_head >= 0.5:
            return "about %s above the subject's head" % _metres(above_head)
        return "about %s above the subject's eye level" % _metres(m)
    if cam_y <= 0.25:
        return "on the ground"
    return "about %s below the subject's eye level" % _metres(m)


def _metres(m):
    m = float(m)
    if m < 0.95:
        return "%d cm" % int(round(m * 100 / 10.0) * 10)
    if abs(m - round(m)) < 0.15:
        return "%d meter%s" % (int(round(m)), "" if int(round(m)) == 1 else "s")
    return "%.1f meters" % m


def vertical_block(geo, cam_y, subject_height, subject_word="the subject",
                   pronoun_obj="them", possessive="their", pronoun_subj="they"):
    """The physical-camera paragraph for the camera's height and pitch."""
    pitch = geo["pitch"]
    dy = geo["dy"]
    down = pitch < 0
    steep = abs(pitch)
    where = _height_words(cam_y, subject_height, dy)
    S, sp, po, ps = subject_word, pronoun_subj, pronoun_obj, possessive

    if steep < 8:
        return ("Eye-level photograph. The camera is %s and level, pointing straight "
                "at %s; %s %s the lens directly, natural proportions."
                % (where, S, sp, "meet" if sp == "they" else "meets"))
    if down:
        if steep >= 80:
            return ("Direct overhead photograph. The camera is mounted vertically above "
                    "%s, %s, and points straight down at 90 degrees, its optical axis "
                    "perpendicular to the floor. %s is directly beneath the lens; the top "
                    "of %s head and shoulders are seen from above and the floor fills the "
                    "entire background. True top-down perspective, not an oblique "
                    "high-angle view." % (S, where, _cap(S), ps))
        if steep >= 55:
            return ("Extreme high-angle perspective. The camera is positioned %s and "
                    "pitched steeply downward at around %d degrees toward %s. %s stands "
                    "beneath the camera looking upward into the elevated lens; %s head "
                    "appears nearest the lens while the torso and legs recede strongly "
                    "toward the floor, and a large area of floor is visible around %s. "
                    "Pronounced perspective depth." % (where, int(round(steep)), S,
                                                       _cap(S), ps, po))
        if steep >= 30:
            return ("Strong high-angle photograph. The camera is positioned %s and tilted "
                    "downward at %d degrees. %s stands beneath the camera looking upward "
                    "into the lens; the top planes of %s head and shoulders are clearly "
                    "visible and the floor surrounds %s body. Strong but realistic "
                    "perspective." % (where, int(round(steep)), _cap(S), ps, ps))
        return ("High-angle photograph. The camera is %s and tilted downward about %d "
                "degrees toward %s face. %s %s %s eyes toward the camera; the top of "
                "the hair and shoulders slightly visible, subtle elevated perspective, "
                "natural proportions." % (where, int(round(steep)), ps, _cap(sp),
                                          "raise" if sp == "they" else "raises", ps))
    # looking up
    if steep >= 55:
        return ("Extreme low-angle photograph, a worm's-eye view. The camera is %s and "
                "points steeply upward at around %d degrees. %s towers above the camera "
                "and looks down toward the lens; the underside of the chin and the soles "
                "of the shoes are nearest the camera, the head and shoulders recede "
                "upward, and the sky or ceiling fills the background. Pronounced upward "
                "foreshortening." % (where, int(round(steep)), _cap(S)))
    # LOW SIDE, rewritten from the 2026-08-17 lab sweep: the first wording said
    # the subject "looks down toward the lens" and named "the underside of the
    # jaw", and Krea 2 read those as a downward-looking scene and flipped the
    # shot HIGH. The worm's-eye block that worked leads with what is NEAREST the
    # camera and what FILLS THE BACKGROUND (sky), never with a downward verb, so
    # both low stops now follow that template. Nothing here says "down".
    if steep >= 25:
        return ("Low-angle photograph, shot from below. The camera is %s, near the "
                "ground, pointing upward at around %d degrees toward %s. %s stands "
                "tall above the camera; %s legs and torso are nearest the lens and "
                "loom large, the head is furthest away and smaller, and the sky or "
                "ceiling fills the space above and behind %s. Clear upward "
                "perspective." % (where, int(round(steep)), S, _cap(S), ps, po))
    return ("Slightly low-angle photograph, the camera %s and pointing gently upward "
            "toward %s. %s chin and jawline sit slightly nearer the lens than %s eyes, "
            "and open sky or ceiling shows above and behind the head, subtle heroic "
            "perspective, natural proportions." % (where, S, _cap(ps), ps))


def _height_only_block(geo, cam_y, subject_top, sname):
    """The camera's height and general pitch relative to the subject, with no
    claim of aiming at them - for the unlocked (off-centre) composition."""
    p = geo["pitch"]
    steep = abs(p)
    where = _height_words(cam_y, subject_top, geo["dy"])
    if steep < 8:
        return ("Eye-level photograph. The camera is %s and held level."
                % where)
    if p < 0:
        kind = ("Direct overhead" if steep >= 80 else "Extreme high-angle"
                if steep >= 55 else "High-angle")
        return ("%s photograph. The camera is %s and pitched downward about %d "
                "degrees; the ground fills much of the frame and %s is seen from "
                "above." % (kind, where, int(round(steep)), sname))
    kind = ("Extreme low-angle" if steep >= 55 else "Low-angle")
    return ("%s photograph, shot from below. The camera is %s and pointing upward "
            "about %d degrees; the sky or ceiling fills much of the frame and %s "
            "is seen from below." % (kind, where, int(round(steep)), sname))


def _aim_words(aim_geo, look_at, cpos):
    """Where the lens points when unlocked, in plain words."""
    d = aim_geo["distance"]
    p = aim_geo["pitch"]
    tilt = ("level" if abs(p) < 8 else
            "tilted %s about %d degrees" % ("down" if p < 0 else "up", int(round(abs(p)))))
    return "%s, toward a point %s away" % (tilt, _metres(d))


def _cap(t):
    return t[:1].upper() + t[1:] if t else t


# ---------------------------------------------------------------- horizontal
def _facing_relation(yaw_cam_to_subject, subject_facing_deg):
    """Where the camera sits relative to the way the subject FACES.

    Both in degrees around y, 0 = +z (toward the default camera). The
    difference says front / three-quarter / profile / rear three-quarter / rear.
    """
    rel = (yaw_cam_to_subject - subject_facing_deg + 180) % 360 - 180   # -180..180
    a = abs(rel)
    side = "left" if rel < 0 else "right"
    if a < 20:
        return "square on to the camera, facing it directly"
    if a < 65:
        return "turned in a three-quarter view, %s side nearer the camera" % side
    if a < 115:
        return "in %s profile to the camera" % side
    if a < 160:
        return "in a rear three-quarter view, the camera behind and to the %s" % side
    return "seen from behind, back to the camera"


def _distance_words(dist, focal_mm):
    """A shot-size cue from distance and lens, in the framing vocabulary."""
    # rough: horizontal FOV at distance -> width of frame; compare with a body
    width_m = 2.0 * dist * math.tan(math.radians(fov_deg(focal_mm) / 2.0))
    if width_m < 0.9:
        return "a tight close-up of the face"
    if width_m < 1.6:
        return "a head-and-shoulders portrait"
    if width_m < 2.6:
        return "a three-quarter figure"
    if width_m < 4.5:
        return "the whole figure with room around them"
    return "a wide view with the figure small in the frame"


# ---------------------------------------------------------------- the paragraph
def describe(camera, subjects, output="krea2"):
    """camera: {pos:[x,y,z], target: index|None, target_height: m|None,
                focal_mm, roll_deg}
    subjects: [{name, pos:[x,y,z], height, facing_deg, primary?}]
    Returns the model-facing paragraph (str). output modes beyond krea2 come
    later; today every mode returns the Krea 2 paragraph.
    """
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    sname = str(prime.get("name") or "the subject")
    sh = float(prime.get("height", 1.7))
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face_y = spos[1] + sh * 0.92
    th = camera.get("target_height")
    cpos = [float(x) for x in camera.get("pos", [0, face_y, 3.0])]
    focal = float(camera.get("focal_mm", 35))
    # LOCK ON SUBJECT (default): the camera aims at the target's face and the
    # subject sits centre frame. UNLOCKED: the camera aims at a free point
    # (aim: [x, y, z]), so the subject can sit off-centre or at the edge -
    # the user's ask, for less centred compositions. The vertical block is
    # still measured to the subject (that is what "high angle" means); the
    # composition sentence says where in the frame the subject lands.
    locked = camera.get("lock", True) is not False
    aim = camera.get("aim")
    if locked or not (isinstance(aim, (list, tuple)) and len(aim) == 3):
        look_at = [spos[0], float(th) if th is not None else face_y, spos[2]]
    else:
        look_at = [float(aim[0]), float(aim[1]), float(aim[2])]
    geo = camera_geometry(cpos, [spos[0], face_y, spos[2]])   # angle TO the subject
    aim_geo = camera_geometry(cpos, look_at)                   # where the lens points

    if locked:
        parts = [vertical_block(geo, cpos[1], spos[1] + sh, subject_word=sname)]
    else:
        # unlocked: the height relation still matters (it is what makes the
        # shot high or low) but the block must not claim the lens points at
        # the subject - the aim sentence says where it really points
        parts = [_height_only_block(geo, cpos[1], spos[1] + sh, sname)]
    # horizontal relation and distance
    rel = _facing_relation(geo["yaw"], float(prime.get("facing_deg", 0)))
    if locked:
        parts.append(_cap("%s is %s, %s from the camera, centered in the frame, "
                          "framed as %s."
                          % (sname, rel, _metres(geo["distance"]),
                             _distance_words(geo["distance"], focal))))
    else:
        # where does the subject fall in the frame? Angle between the lens
        # axis and the subject direction, signed left/right, as a fraction of
        # the half-FOV
        d_yaw = ((geo["yaw"] - aim_geo["yaw"] + 180) % 360) - 180
        half = fov_deg(focal) / 2.0
        frac = max(-1.4, min(1.4, d_yaw / max(1e-6, half)))
        if abs(frac) < 0.15:
            where = "near the center of the frame"
        elif abs(frac) < 0.5:
            where = "a little %s of center" % ("right" if frac > 0 else "left")
        elif abs(frac) < 0.9:
            where = "well %s of center, in the %s third of the frame" % (
                ("right", "right") if frac > 0 else ("left", "left"))
        elif abs(frac) <= 1.0:
            where = "at the very %s edge of the frame" % ("right" if frac > 0 else "left")
        else:
            where = "just outside the %s edge of the frame, mostly cut off" % (
                "right" if frac > 0 else "left")
        parts.append(_cap("The camera is not aimed at %s: it points %s, at open %s, "
                          "and %s falls %s, %s, %s from the camera. The composition "
                          "gives space to the scene rather than centering the figure."
                          % (sname, _aim_words(aim_geo, look_at, cpos),
                             "ground" if look_at[1] < 0.6 else "space",
                             sname, where, rel, _metres(geo["distance"]))))
    # RELATIONSHIPS, the user's ask: "the girl sits on the bed" is a relation,
    # not two positions. An entry may declare rel = {kind, to}; the pair's
    # relation is stated in words FIRST (the model reads "on the bed" far
    # more reliably than "0.4 m above and level with"), and the geometry
    # blocking below then covers everything else.
    REL_WORDS = {
        "on": "%s is on %s", "in": "%s is in %s", "beside": "%s is right beside %s",
        "behind": "%s is directly behind %s", "holding": "%s is holding %s",
        "leaning on": "%s is leaning on %s", "under": "%s is under %s",
        "at": "%s is at %s", "sitting on": "%s is sitting on %s",
        "lying on": "%s is lying on %s", "standing on": "%s is standing on %s",
        "looking at": "%s is looking at %s", "next to": "%s is next to %s",
    }
    related_pairs = set()
    for k, s_ in enumerate(subjects):
        rel = s_.get("rel")
        if not isinstance(rel, dict):
            continue
        kind = str(rel.get("kind") or "").strip().lower()
        to = rel.get("to")
        if kind not in REL_WORDS or not isinstance(to, int) or to < 0 or to >= len(subjects) or to == k:
            continue
        a = str(s_.get("name") or "the subject")
        b = str(subjects[to].get("name") or "the object")
        parts.append(_cap(REL_WORDS[kind] % (a, b)) + ".")
        related_pairs.add((k, to))
    # the other subjects: blocking relative to the primary and the camera. A
    # related pair's member skips its geometry line against the primary when
    # the relation already said where it is (on the bed says enough).
    others = [s for k, s in enumerate(subjects) if k != ti]
    for o in others:
        ok = subjects.index(o)
        if (ti, ok) in related_pairs or (ok, ti) in related_pairs:
            continue
        opos = [float(x) for x in o.get("pos", [0, 0, 0])]
        d_cam = _len(_v(cpos, opos))
        d_prime = _len(_v(spos, opos))
        # in front of / behind, from the camera's point of view
        along = geo["distance"] - _len(_v(cpos, [opos[0], look_at[1], opos[2]]))
        depth = ("in the foreground, nearer the camera than %s" % sname if along > 0.6
                 else "in the background, %s behind %s" % (_metres(d_prime), sname)
                 if along < -0.6 else "level with %s" % sname)
        # left / right of the primary as the camera sees it
        cx = _norm((look_at[0] - cpos[0], 0.0, look_at[2] - cpos[2]))
        right = (-cx[2], 0.0, cx[0])                     # perpendicular, camera-right
        side_dot = (opos[0] - spos[0]) * right[0] + (opos[2] - spos[2]) * right[2]
        side = ("to the right of" if side_dot > 0.35 else "to the left of"
                if side_dot < -0.35 else "in line with")
        # OBJECTS share the stage with people (the user's ask: a bed, a lamp,
        # a window placed and named, and the words say where they are - the
        # Subject and Surroundings text still say what they LOOK like). A
        # person "stands"; an object "sits" (or "is" for a wall/window).
        kind = str(o.get("kind") or "person")
        oname = str(o.get("name") or ("a second person" if kind == "person"
                                      else "an object"))
        verb = ("stands" if kind == "person" else "is"
                if kind in ("wall", "window", "door") else "sits")
        parts.append(_cap("%s %s %s, %s %s, %s from the camera."
                          % (oname, verb, depth, side, sname, _metres(d_cam))))
    roll = float(camera.get("roll_deg", 0) or 0)
    if abs(roll) >= 5:
        parts.append("The camera is rolled %d degrees to the %s, a Dutch tilt."
                     % (int(round(abs(roll))), "left" if roll < 0 else "right"))
    parts.append(lens_phrase(focal) + ".")
    return " ".join(p if p.endswith(".") else p + "." for p in parts)


# ---------------------------------------------------------------- presets
# The Prompt Frame's Camera height stops as camera states, so the dial and
# the studio share one translator. Subject 1.7m at origin facing +z; camera
# on the +z side looking at the face.
def preset_camera(stop, distance=3.0, focal_mm=None):
    face = 1.7 * 0.92
    table = {
        "Worm's eye":  (0.15, -60, 24),
        "Low angle":   (0.9, -30, 35),
        "Slight low":  (face - 0.3, -12, 50),
        "Eye level":   (face, 0, 50),
        "Slight high": (face + 0.4, 20, 50),
        "High angle":  (1.7 + 1.5, 45, 35),
        "Bird's eye":  (1.7 + 2.5, 88, 28),
    }
    y, pitch_deg, f = table.get(stop, table["Eye level"])
    # place the camera so that its pitch to the face is pitch_deg at the height y;
    # the true overhead stop sits almost on top of the head, so its ground
    # distance is tiny by construction and the pitch reads ~90
    dy = y - face
    if pitch_deg:
        ground = abs(dy) / math.tan(math.radians(abs(pitch_deg)))
    else:
        ground = distance
    ground = max(0.05 if abs(pitch_deg) >= 85 else 0.35, min(12.0, ground))
    return {"pos": [0.0, y, ground], "target": 0,
            "focal_mm": focal_mm if focal_mm is not None else f, "roll_deg": 0}


# ---------------------------------------------------------------- auto latent
# The frame's ASPECT is part of the camera language: a steep low or high shot
# with a wide lens wants a TALL frame (the figure towers, sky above; or the
# ground stretches away), a wide blocking of several subjects wants a WIDE
# one, a tight portrait sits near square. A latent that fights the geometry
# makes the model compromise, and the angle softens - the user's finding.
# suggest_aspect() returns (w_ratio, h_ratio, why) from the camera state and
# the scene; auto_latent_size() shapes it into a pixel budget on 64s.
def suggest_aspect(camera, subjects):
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face = [spos[0], spos[1] + float(prime.get("height", 1.7)) * 0.92, spos[2]]
    cpos = [float(x) for x in camera.get("pos", [0, face[1], 3.0])]
    focal = float(camera.get("focal_mm", 35))
    geo = camera_geometry(cpos, face)
    steep = abs(geo["pitch"])
    fov = fov_deg(focal)
    # the scene's horizontal spread as seen from the camera, in degrees
    spread = 0.0
    if len(subjects) > 1:
        yaws = []
        for s in subjects:
            p = [float(x) for x in s.get("pos", [0, 0, 0])]
            yaws.append(camera_geometry(cpos, [p[0], face[1], p[2]])["yaw"])
        spread = max(yaws) - min(yaws)
    # decision
    if len(subjects) > 1 and spread > fov * 0.45:
        return (16, 9, "several subjects spread across the view: wide")
    if len(subjects) > 1 and spread > fov * 0.25:
        return (3, 2, "two or more subjects side by side: landscape")
    if steep >= 55 and geo["pitch"] > 0:
        return (2, 3, "steep low angle: tall, the figure towers and the sky reads")
    if steep >= 55 and geo["pitch"] < 0:
        return (3, 4, "steep high angle: portrait, the ground stretches below")
    if steep >= 25 and fov >= 60:
        return (2, 3, "an angled wide-lens shot: tall to hold the perspective")
    if _distance_words(geo["distance"], focal) in ("a tight close-up of the face",
                                                    "a head-and-shoulders portrait"):
        return (4, 5, "a close portrait: near square")
    if _distance_words(geo["distance"], focal).startswith("a wide view"):
        return (3, 2, "a wide view: landscape")
    return (3, 4, "the default portrait frame")


def auto_latent_size(camera, subjects, megapixels=1.0, multiple=64):
    """(width, height, why) for the suggested aspect at a pixel budget."""
    wr, hr, why = suggest_aspect(camera, subjects)
    total = max(0.05, float(megapixels)) * 1_000_000.0
    w = math.sqrt(total * wr / hr)
    h = w * hr / wr
    r = lambda v: max(multiple, int(round(v / multiple)) * multiple)
    return r(w), r(h), "%d:%d, %s" % (wr, hr, why)


# ---------------------------------------------------------------- frame presets
# The Prompt Frame's simple controls become PRESETS over the studio state, the
# user's design: a framing chip sets how close the camera is and the lens; a
# camera-height stop sets its height and pitch; the two compose. One engine
# writes every word, so "Portrait" and "Slight high" together mean exactly what
# the studio would say for that camera.
FRAMING_SHOTS = {
    # framing -> (ground distance to the face in metres, focal mm)
    "Portrait":   (1.6, 65),
    "Half body":  (2.0, 50),
    "Balanced":   (3.0, 35),
    "Full scene": (4.5, 28),
    "Roomscale":  (7.0, 24),
}


def camera_from_frame(framing="Balanced", camera_height="Eye level",
                      subject_height=1.7, subject_pos=(0.0, 0.0, 0.0), bearing_deg=0.0):
    """A camera state for the frame's two simple choices.

    bearing_deg keeps whatever side the camera was on (0 = in front, +z).
    """
    dist, focal = FRAMING_SHOTS.get(framing, FRAMING_SHOTS["Balanced"])
    face = subject_pos[1] + subject_height * 0.92
    heights = {
        "Worm's eye":  (0.15, -60), "Low angle": (0.9, -30), "Slight low": (face - 0.3, -12),
        "Eye level":   (face, 0), "Slight high": (face + 0.4, 20),
        "High angle":  (subject_height + 1.5, 45), "Bird's eye": (subject_height + 2.5, 88),
    }
    y, pitch = heights.get(camera_height, heights["Eye level"])
    if not pitch:
        ground = dist
    elif abs(pitch) < 30:
        # a GENTLE stop keeps the framing's distance and RISES to hold its
        # pitch: at roomscale a fixed 40 cm would flatten to eye level (true
        # physics, wrong intent). Steep stops keep their height and sit where
        # that height gives the pitch, close by construction.
        ground = dist
        y = face + math.tan(math.radians(pitch)) * ground
        y = max(0.1, y)
    else:
        ground = abs(y - face) / math.tan(math.radians(abs(pitch)))
        ground = max(0.05 if abs(pitch) >= 85 else 0.35, min(12.0, ground))
    yaw = math.radians(bearing_deg)
    pos = [subject_pos[0] + math.sin(yaw) * ground, y,
           subject_pos[2] + math.cos(yaw) * ground]
    return {"pos": pos, "target": 0, "target_height": None,
            "focal_mm": focal, "roll_deg": 0, "lock": True, "aim": [0, 0, 0]}


# ---------------------------------------------------------------- zoom LoRA
# The user's zoom LoRA (zoom_krea2_loraholic) is a camera control in all but
# name: positive strength pushes in, negative pulls out, and it is strong -
# the useful range runs about -10 (wide) to +12 (tight). auto_zoom_strength
# maps the camera's shot size onto that range so the LoRA and the words agree:
# a face close-up leans on the LoRA to push in, a wide view leans on it to
# pull out, and the balanced middle leaves it near zero.
ZOOM_MIN, ZOOM_MAX = -10.0, 12.0


def auto_zoom_strength(camera, subjects):
    """A zoom-LoRA strength for this camera, from the frame width at the subject."""
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face = [spos[0], spos[1] + float(prime.get("height", 1.7)) * 0.92, spos[2]]
    cpos = [float(x) for x in camera.get("pos", [0, face[1], 3.0])]
    focal = float(camera.get("focal_mm", 35))
    dist = _len(_v(cpos, face))
    width_m = 2.0 * dist * math.tan(math.radians(fov_deg(focal) / 2.0))
    # width of frame at the subject: ~0.6 m is a tight face, ~2 m a figure,
    # ~6 m a wide room. Log scale between them onto the LoRA's range.
    lo, hi = math.log(0.5), math.log(8.0)
    t = (math.log(max(0.5, min(8.0, width_m))) - lo) / (hi - lo)   # 0 tight .. 1 wide
    strength = ZOOM_MAX - t * (ZOOM_MAX - ZOOM_MIN)
    # gentle around the middle: the balanced shot should not lean on the LoRA
    return round(strength * 0.85, 1)
