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
    if steep >= 25:
        return ("Low-angle photograph. The camera is %s and tilted upward at around %d "
                "degrees. %s is above the camera and looks down toward the lens; the "
                "underside of the jaw is visible and the sky or ceiling shows behind the "
                "head. Clear upward perspective." % (where, int(round(steep)), _cap(S)))
    return ("Slightly low-angle photograph. The camera is %s and tilted gently upward "
            "toward %s face; a hint of the ceiling or sky behind the head, subtle heroic "
            "perspective, natural proportions." % (where, ps))


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
    look_at = [spos[0], float(th) if th is not None else face_y, spos[2]]
    cpos = [float(x) for x in camera.get("pos", [0, face_y, 3.0])]
    focal = float(camera.get("focal_mm", 35))
    geo = camera_geometry(cpos, look_at)

    parts = [vertical_block(geo, cpos[1], spos[1] + sh, subject_word=sname)]
    # horizontal relation and distance
    rel = _facing_relation(geo["yaw"], float(prime.get("facing_deg", 0)))
    parts.append(_cap("%s is %s, %s from the camera, framed as %s."
                      % (sname, rel, _metres(geo["distance"]),
                         _distance_words(geo["distance"], focal))))
    # the other subjects: blocking relative to the primary and the camera
    others = [s for k, s in enumerate(subjects) if k != ti]
    for o in others:
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
        oname = str(o.get("name") or "a second person")
        parts.append(_cap("%s stands %s, %s %s, %s from the camera."
                          % (oname, depth, side, sname, _metres(d_cam))))
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
