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
def bearing_from(subject_pos, cam_pos):
    """The direction from a subject to the camera, in FACING degrees
    (0 = +z, 90 = +x, the same convention as facing_deg)."""
    return math.degrees(math.atan2(float(cam_pos[0]) - float(subject_pos[0]),
                                   float(cam_pos[2]) - float(subject_pos[2])))


def rel_bearing(subject_pos, cam_pos, facing_deg):
    """Where the camera sits relative to the way the subject faces, -180..180:
    0 in front, +90 on the subject's LEFT, -90 on their RIGHT, +-180 behind.
    (Fixed 2026-08-17: the old form used the look yaw with a sign that only
    held for facing 0; a subject facing +x got its sides swapped.)"""
    return (bearing_from(subject_pos, cam_pos) - float(facing_deg) + 180) % 360 - 180


def _facing_relation(rel):
    """Front / three-quarter / profile / rear three-quarter / rear, from a
    rel_bearing() value; the side named is the one nearer the camera."""
    a = abs(rel)
    side = "left" if rel > 0 else "right"
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
    Returns the model-facing text (str). output: "krea2" (the physical-camera
    paragraph, the tuned default), "short" (the same facts in a few plain
    words, for encoders that choke on meters and degrees), "tags" (booru-style
    tags for Pony / Illustrious / tag-trained XL). short and tags are UNTUNED
    on XL as of 2026-08-17: built from the same geometry, wording unproven.
    """
    if output in ("tags", "short"):
        return _describe_compact(camera, subjects, output)
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
    rel = _facing_relation(rel_bearing(spos, cpos, prime.get("facing_deg", 0)))
    # STRAIGHT DOWN OR UP the horizontal bearing means nothing: "rear
    # three-quarter view, the camera behind" under "direct overhead" pulled the
    # model to a three-quarter shot (the user's boxing report). Past 75 degrees
    # of pitch the relation is simply the top (or underside) of the subject.
    if abs(geo["pitch"]) >= 75:
        rel = ("seen from directly above" if geo["pitch"] < 0
               else "seen from directly below")
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
    # OVER THE SHOULDER (two-person scenes, the user's ask): a person standing
    # close in front of the lens, on the look line, nearer than the target, is
    # the foreground shoulder. Say it as the shot it is - the model knows the
    # grammar of an OTS far better than "1 m from the camera, in line with" -
    # and skip that person's ordinary blocking line.
    ots = _ots_person(cpos, look_at, geo, subjects, ti)
    if ots is not None:
        oname = str(subjects[ots].get("name") or "the other person")
        opos_o = [float(x) for x in subjects[ots]["pos"]]
        which, lateral = _ots_side(cpos, look_at, opos_o)
        gaze = ("looking toward %s" % oname if _faces_each_other(prime, subjects[ots])
                else "looking past them")
        if lateral < 0.28:
            # dead ahead of the lens: not a shoulder at an edge but a back in
            # the middle of the frame (a "from behind" foreground). Said so, or
            # the model draws the person twice - once as the shoulder, once as
            # the person the text mentions.
            parts.append(_cap("%s stands between the camera and %s with %s back to the lens, "
                              "filling the lower middle of the near foreground, softly out of "
                              "focus; %s is seen past %s, sharp, %s."
                              % (oname, sname, "their", sname, "them", gaze)))
        else:
            # they face away from us, so the shoulder at the frame's left edge is
            # their RIGHT shoulder
            parts.append(_cap("An over-the-shoulder shot: the back of %s's head and %s shoulder "
                              "are in the near foreground at the %s edge of the frame, close to "
                              "the lens and softly out of focus, and %s is seen past them, "
                              "sharp, %s."
                              % (oname, "right" if which == "left" else "left", which, sname, gaze)))
    # WHAT IS IN THE FRAME (room sets, the user's ask): only things the lens
    # can see get a line - inside the horizontal field of view plus a margin,
    # not behind the camera, not beyond 14 m - nearest first, at most eight.
    # Walls never get their own line: a room's walls are the room, and the
    # Subject / Surroundings text says what the room looks like.
    look_dir = _norm((look_at[0] - cpos[0], 0.0, look_at[2] - cpos[2]))
    half_fov = fov_deg(focal) / 2.0 + 12.0
    walls = _wall_segments(subjects)
    visible = []
    for o in others:
        ok = subjects.index(o)
        if str(o.get("kind") or "person") == "wall":
            continue
        opos = [float(x) for x in o.get("pos", [0, 0, 0])]
        d_flat = math.hypot(opos[0] - cpos[0], opos[2] - cpos[2])
        if d_flat > 14.0:
            continue
        # behind a wall from where the camera stands: not in the picture (a
        # doorway is a gap between two wall parts, so it stays open)
        if _occluded((cpos[0], cpos[2]), (opos[0], opos[2]), walls):
            continue
        if d_flat > 0.05:
            v = _norm((opos[0] - cpos[0], 0.0, opos[2] - cpos[2]))
            ang = math.degrees(math.acos(max(-1.0, min(1.0, v[0] * look_dir[0] + v[2] * look_dir[2]))))
            if ang > half_fov and ok != ots:
                continue
        visible.append((d_flat, ok, o))
    visible.sort(key=lambda t: t[0])
    others = [o for _, _, o in visible[:8]]
    for o in others:
        ok = subjects.index(o)
        if (ti, ok) in related_pairs or (ok, ti) in related_pairs:
            continue
        if ok == ots:
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
        # FACING (the user's ask: a better sense of which way things face):
        # a person's or an object's front, relative to the camera; a door is
        # said as a doorway; walls have no front
        facing_words = ""
        if kind in ("person", "object", "door"):
            o_rel = rel_bearing(opos, cpos, o.get("facing_deg", 0))
            facing_words = _facing_words(kind, o_rel, prime, o, oname, sname)
        parts.append(_cap("%s %s %s, %s %s, %s from the camera%s."
                          % (oname, verb, depth, side, sname, _metres(d_cam),
                             (", " + facing_words) if facing_words else "")))
    roll = float(camera.get("roll_deg", 0) or 0)
    if abs(roll) >= 5:
        parts.append("The camera is rolled %d degrees to the %s, a Dutch tilt."
                     % (int(round(abs(roll))), "left" if roll < 0 else "right"))
    parts.append(lens_phrase(focal) + ".")
    # DEPTH OF FIELD (the user's ask, "bokeh"): with an aperture set, the
    # physics of lens, f-number and distance says what is sharp and what
    # dissolves - and the stage knows how far every other thing is, so the
    # words name who is soft. Off (no aperture) says nothing, as before.
    dof = dof_words(camera, subjects, ti, cpos, geo, focal)
    if dof:
        parts.append(dof)
    return " ".join(p if p.endswith(".") else p + "." for p in parts)


def _wall_segments(subjects):
    """[(x1, z1, x2, z2)] for every wall entry: it runs along its facing
    (facing 0 = along x, 90 = along z), size[0] long."""
    segs = []
    for s_ in subjects:
        if str(s_.get("kind") or "") != "wall":
            continue
        p = [float(x) for x in s_.get("pos", [0, 0, 0])]
        length = float((s_.get("size") or [1.0, 0.2])[0])
        f = math.radians(float(s_.get("facing_deg", 0)))
        dx, dz = math.cos(f) * length / 2.0, math.sin(f) * length / 2.0
        segs.append((p[0] - dx, p[2] - dz, p[0] + dx, p[2] + dz))
    return segs


def _occluded(a, b, walls):
    """True when the segment a->b (camera to thing, ground plan) crosses a
    wall segment strictly between them (the thing itself may sit ON a wall:
    a window or a door, hence the 0.97 cut)."""
    ax, az = a
    bx, bz = b
    for (x1, z1, x2, z2) in walls:
        d = (bx - ax) * (z2 - z1) - (bz - az) * (x2 - x1)
        if abs(d) < 1e-9:
            continue
        t = ((x1 - ax) * (z2 - z1) - (z1 - az) * (x2 - x1)) / d     # along a->b
        u = ((x1 - ax) * (bz - az) - (z1 - az) * (bx - ax)) / d     # along the wall
        if 0.02 < t < 0.97 and 0.0 <= u <= 1.0:
            return True
    return False


def _ots_person(cpos, look_at, geo, subjects, ti):
    """Index of a person who is the foreground shoulder of an OTS, or None:
    a person (not the target) within 1.6 m of the camera, nearer than the
    target, and within 35 degrees of the look direction."""
    best, best_d = None, 9e9
    look = _norm((look_at[0] - cpos[0], 0.0, look_at[2] - cpos[2]))
    for k, s_ in enumerate(subjects):
        if k == ti or str(s_.get("kind") or "person") != "person":
            continue
        opos = [float(x) for x in s_.get("pos", [0, 0, 0])]
        d = math.hypot(opos[0] - cpos[0], opos[2] - cpos[2])
        if d > 1.6 or d >= geo["ground"] - 0.3 or d < 0.15:
            continue
        v = _norm((opos[0] - cpos[0], 0.0, opos[2] - cpos[2]))
        cosang = look[0] * v[0] + look[2] * v[2]
        if cosang < math.cos(math.radians(35)):
            continue
        if d < best_d:
            best, best_d = k, d
    return best


def _ots_side(cpos, look_at, opos):
    """(left|right, lateral metres): which edge of the frame the foreground
    person sits at, and how far off the look line they are."""
    look = _norm((look_at[0] - cpos[0], 0.0, look_at[2] - cpos[2]))
    right = (-look[2], 0.0, look[0])
    dot = (opos[0] - cpos[0]) * right[0] + (opos[2] - cpos[2]) * right[2]
    return ("right" if dot >= 0 else "left"), abs(dot)


def _faces_each_other(a, b):
    """True when a's facing points roughly at b (within 60 degrees)."""
    apos = [float(x) for x in a.get("pos", [0, 0, 0])]
    bpos = [float(x) for x in b.get("pos", [0, 0, 0])]
    to_b = math.degrees(math.atan2(bpos[0] - apos[0], bpos[2] - apos[2]))   # 0 = +z
    d = (to_b - float(a.get("facing_deg", 0)) + 180) % 360 - 180
    return abs(d) < 60


def _facing_words(kind, o_rel, prime, o, oname, sname):
    """Which way a person / object / door faces, as the camera sees it."""
    a = abs(o_rel)
    if kind == "person":
        if _faces_each_other(o, prime):
            return "facing %s" % sname
        if a < 35:
            return "facing the camera"
        if a < 110:
            return "turned side-on to the camera"
        return "with their back to the camera"
    if kind == "door":
        return "an open doorway"
    # an object: its front
    if a < 45:
        return "its front toward the camera"
    if a < 135:
        return "seen from its side"
    return "its back to the camera"


# ---------------------------------------------------------------- lights
# THE LIGHT RIG (the user's ask, 2026-08-18: "add a light source like Unreal -
# diameter, soft or hard, directional or orbital, colour tone - through
# prompting"). Same contract as the camera translator and the depth-of-field
# sentence: geometry and physics in, prose out, no renderer involved.
#
# WHY THIS CAN WORK AT ALL, and the rule every sentence here obeys: the corpus
# study behind prompt_lists.LIGHTING found that lighting is followed when it
# names A SOURCE, A DIRECTION and WHAT IT LANDS ON, and ignored when it is a
# bare label ("cinematic lighting" measured as a large change with no control).
# A light standing on the stage knows all three, and knows them in the units a
# photographer would use, so it writes the long form every time.
#
# The physics that is real rather than decorative:
#   - HARDNESS is angular size. A source's apparent width from the subject,
#     2*atan(d/2L), decides the shadow edge: the sun is 0.5 deg and cuts hard,
#     a 1 m softbox at 1 m is 53 deg and wraps. This is the same kind of
#     computation dof_words() makes from the blur circle, and it means "big
#     light close" and "small light far" stop being guesses.
#   - RATIO is inverse square. Key and fill intensities at their own distances
#     give a lighting ratio in stops, which is what low-key and high-key
#     actually mean, so the words follow the rig instead of a mood label.
#   - DIRECTION is the same bearing maths the camera uses, read twice: against
#     the VIEWER (screen left/right, which is what a viewer sees) and against
#     the subject's own facing (short vs broad lighting, rim, backlight).
LIGHT_KINDS = ("softbox", "bulb", "sun", "window", "practical", "ambient")

# apparent-size bands -> shadow character. Degrees of angular width.
def hardness_words(angular_deg):
    if angular_deg >= 45:
        return ("very soft", "shadows so soft they barely have an edge")
    if angular_deg >= 20:
        return ("soft", "soft-edged shadows that wrap around the form")
    if angular_deg >= 8:
        return ("fairly soft", "gently graded shadow edges")
    if angular_deg >= 2:
        return ("crisp", "clearly drawn shadow edges")
    return ("hard", "hard-edged shadows with a sharp line between light and dark")


def angular_size_deg(diameter_m, distance_m):
    """How wide the source looks from where it is standing, in degrees."""
    d = max(0.001, float(diameter_m))
    L = max(0.05, float(distance_m))
    return math.degrees(2.0 * math.atan((d / 2.0) / L))


def colour_words(kelvin):
    """Colour of the light. 0 = don't mention it.

    NAME THE COLOUR, NEVER THE THING THAT MAKES IT (the user, 2026-08-18):
    the first version said "candle-warm" under 2200 K and the model drew
    candles. A colour word is a description; a light-source noun is an object,
    and an object named in a prompt gets rendered. Same reason the source
    wording below stopped saying softbox and bulb.
    """
    try:
        k = float(kelvin or 0)
    except (TypeError, ValueError):
        k = 0.0
    if k <= 0:
        return ""
    if k < 2200:
        return "deep amber"
    if k < 3000:
        return "warm amber"
    if k < 4000:
        return "warm white"
    if k < 5200:
        return "neutral white"
    if k < 6500:
        return "cool white"
    if k < 9000:
        return "cold blue-white"
    return "icy blue"


# HOW MUCH LIGHT LANDS, which is what makes a picture dark - NOT the colour
# (the user, 2026-08-18: "when the colour is very low should it be quite dark?").
# 1900 K is the colour of a candle flame, not its level: a warm scene can be
# blazing and a blue one can be nearly black. Level is power over distance
# squared, and the nominal is power 1.0 at 2 m, so a light dragged back really
# does dim the scene, exactly as it would in a room.
LEVEL_NOMINAL = 0.25          # illuminance of power 1.0 at 2 m
LEVEL_BANDS = (0.12, 0.4, 2.5, 8.0)


def illuminance(intensity, distance_m):
    try:
        i = max(0.0, float(intensity))
    except (TypeError, ValueError):
        i = 1.0
    return i / max(0.05, float(distance_m)) ** 2


def level_words(rel, sname="the subject"):
    """(sentence, step) for how lit the scene is, relative to the nominal.
    step: -2 very dark .. +2 blown, 0 = ordinary, which says nothing.

    DARKNESS IS A THING, NOT AN EXPOSURE (the user, 2026-08-18: "I am still not
    getting the dark effect I want"). The corpus-validated entries in
    prompt_lists.LIGHTING never say "the frame is dark"; they name the lit POOL
    and then what lies BEYOND it - "deep shadow beyond a tight pool of orange
    light", "everything beyond the pool falling away into dark", "leaving the
    room behind dark". A model can draw an unlit background; it cannot draw an
    f-stop. So the dark bands describe the room, not the exposure.
    """
    lo, dim, hi, blown = LEVEL_BANDS
    if rel < lo:
        return ("a tight pool of light on %s and nothing else, the background "
                "unlit and velvety black, the walls and floor beyond swallowed "
                "by it" % sname, -2)
    if rel < dim:
        return ("the light falling away quickly past %s, the background dark and "
                "unlit, only the nearest shapes catching any of it" % sname, -1)
    if rel < hi:
        return ("", 0)
    if rel < blown:
        return ("everything around %s lit as well, shadows open and full of "
                "detail" % sname, 1)
    return ("the whole scene flooded with light, highlights close to blowing "
            "out", 2)


def rig_level(camera, subjects, lights):
    """The level step a placed rig implies, or 0 when there is none. The frame's
    own Brightness dial can disagree with this, and prompt_frame says so."""
    live = [l for l in (lights or []) if l.get("on", True)]
    if not live:
        return 0
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face = [spos[0], spos[1] + float(prime.get("height", 1.7)) * 0.92, spos[2]]
    total = 0.0
    for l in live:
        lpos = [float(x) for x in l.get("pos", [0, 2.0, 0])]
        total += illuminance(l.get("intensity", 1.0), _len(_v(lpos, face)))
    return level_words(total / LEVEL_NOMINAL)[1]


def _light_geometry(light, subject_face, subject_pos, facing_deg, cam_pos):
    """Where a light stands, in the two frames a sentence needs: against the
    VIEWER (screen left/right, front/back) and against the SUBJECT's facing."""
    lpos = [float(x) for x in light.get("pos", [0, 2.0, 0])]
    geo = camera_geometry(lpos, subject_face)          # light -> face
    dist = geo["distance"]
    # elevation of the light as seen from the face: + is above
    elev = math.degrees(math.atan2(lpos[1] - subject_face[1],
                                   max(0.01, geo["ground"])))
    # bearing of the light around the subject, measured against the CAMERA's
    # bearing: 0 = from behind the camera, 180 = straight into the lens
    b_light = bearing_from(subject_pos, lpos)
    b_cam = bearing_from(subject_pos, cam_pos)
    rel_cam = (b_light - b_cam + 180) % 360 - 180      # + = viewer's right
    rel_face = rel_bearing(subject_pos, lpos, facing_deg)
    return {"pos": lpos, "distance": dist, "elev": elev,
            "rel_cam": rel_cam, "rel_face": rel_face}


def _direction_words(g):
    """Where the light comes from, told the way a viewer sees it."""
    a = abs(g["rel_cam"])
    side = "right" if g["rel_cam"] > 0 else "left"
    if a < 18:
        where = "from behind the camera, straight onto the subject"
    elif a < 65:
        where = "from the %s of frame" % side
    elif a < 115:
        where = "from directly %s of the subject, edge on" % side
    elif a < 160:
        where = "from behind the subject on the %s, raking forward" % side
    else:
        where = "from directly behind the subject, straight back into the lens"
    e = g["elev"]
    if e >= 55:
        height = "almost overhead"
    elif e >= 25:
        height = "high and angled down"
    elif e >= 8:
        height = "a little above the face"
    elif e >= -8:
        height = "level with the face"
    elif e >= -30:
        height = "from below the face"
    else:
        height = "from low down, throwing shadows upward"
    return where, height


# The classic setups, recognised from the geometry. A named setup is obeyed far
# better than a described one (the same reason the camera translator names its
# bands), so when a rig lands on one, the sentence says its name as well.
def named_setup(g, hard, filled=False):
    e, a, rel_face = g["elev"], abs(g["rel_cam"]), g["rel_face"]
    if a >= 160:
        # a silhouette needs an EMPTY shadow side; with a fill in the rig the
        # same geometry is a rim/backlight, and calling it a silhouette while
        # asking for shadow detail is a contradiction the model has to resolve
        if filled:
            return "a strong backlight drawing a bright rim around the edges"
        return "a backlit silhouette" if hard else "a soft backlight"
    if a >= 115:
        return "rim lighting"
    if 22 <= e <= 62 and 28 <= a <= 68:
        return "Rembrandt lighting, a small triangle of light on the shadow cheek"
    if e >= 35 and a < 25:
        return "butterfly lighting, a small shadow straight under the nose"
    if 85 <= a <= 115 and abs(e) < 25:
        return "split lighting, half the face lit and half in shadow"
    if e <= -25 and a < 65:
        return "uplighting from below"
    if a < 20 and abs(e) < 20:
        return "flat frontal lighting"
    if abs(rel_face) > 100 and a < 90:
        return "short lighting, the lit side turned away from the camera"
    return ""


def _ratio_words(key, others):
    """Key-to-fill in stops, which is what low-key and high-key really mean."""
    def pull(l):
        try:
            i = float(l.get("intensity", 1.0))
        except (TypeError, ValueError):
            i = 1.0
        return max(0.0, i)
    kp = pull(key["light"]) / max(0.05, key["geo"]["distance"]) ** 2
    fills = [pull(o["light"]) / max(0.05, o["geo"]["distance"]) ** 2 for o in others]
    if kp <= 0 or not fills or max(fills) <= 0:
        return "the shadow side falling away with no fill" if not fills else ""
    stops = math.log(kp / max(fills), 2)
    if stops >= 4:
        return "the fill far below it, so the shadows stay deep and low-key"
    if stops >= 2:
        return "a fill about %d stops down, keeping detail in the shadows" % round(stops)
    if stops >= 0.7:
        return "a fill close behind it, an even, high-key balance"
    return ("the two nearly equal, flat and shadowless" if len(fills) == 1
            else "the others nearly as strong, flat and shadowless")


def light_words(camera, subjects, lights, join=", "):
    """The lighting paragraph for a stage's lights, or "" when there are none.

    Source, direction and what it lands on, every time, plus the shadow
    character its real angular size implies, its colour, and the ratio to any
    other light. Lights beyond the first two are summarised rather than
    described: a paragraph naming four exact sources averages into mush, which
    is the same obedience ceiling the reference stack has.
    """
    live = [l for l in (lights or []) if l.get("on", True)]
    if not live:
        return ""
    geo0, _rel = _prime_geo(camera, subjects)
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    sname = str(prime.get("name") or "the subject")
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face = [spos[0], spos[1] + float(prime.get("height", 1.7)) * 0.92, spos[2]]
    cpos = [float(x) for x in camera.get("pos", [0, face[1], 3.0])]
    rigs = []
    for l in live:
        g = _light_geometry(l, face, spos, prime.get("facing_deg", 0), cpos)
        rigs.append({"light": l, "geo": g,
                     "power": (float(l.get("intensity", 1.0) or 0)
                               / max(0.05, g["distance"]) ** 2)})
    rigs.sort(key=lambda r: -r["power"])
    key, others = rigs[0], rigs[1:]
    kl, kg = key["light"], key["geo"]
    kind = str(kl.get("kind") or "softbox")
    if kind not in LIGHT_KINDS:
        kind = "softbox"
    # the sun is a special case: 150 million km away, so its angular size is
    # fixed at half a degree no matter what diameter the stage gives it
    ang = 0.53 if kind == "sun" else angular_size_deg(kl.get("diameter", 1.0), kg["distance"])
    hard_word, shadow_words = hardness_words(ang)
    where, height = _direction_words(kg)
    colour = colour_words(kl.get("kelvin", 0))
    tint = (colour.replace(" ", "-") + " ") if colour else ""
    # HARDWARE IS AN OBJECT. "softbox" and "bulb" put studio gear in the frame
    # the same way "candle-warm" put candles in it, so the sentence describes
    # the LIGHT and only names a thing where the thing is wanted in shot: a
    # practical lamp, and a window, which is a feature of the room anyway.
    # A panel and a bare bulb differ by ONE thing a picture can show: how hard
    # their shadows are, which the size and distance already decided. So neither
    # names itself; "soft light" and "hard light" is the whole honest difference,
    # and the direction clause that follows reads without a second "from".
    source = {"softbox": "%s %slight" % (hard_word, tint),
              "bulb": "%s %slight" % (hard_word, tint),
              "sun": "hard direct %ssunlight" % tint,
              "window": "%s %sdaylight through a window" % (hard_word, tint),
              "practical": "%s %slight cast by a lamp in the scene" % (hard_word, tint),
              "ambient": "%s %sambient light" % (hard_word, tint)}[kind]
    lead = "%s lit by %s %s, %s" % (sname, source, where, height)
    bits = [lead, shadow_words]
    # the LEVEL of the whole rig, so turning the power down darkens the picture
    # instead of doing nothing (with one light it used to do exactly nothing:
    # intensity only ever fed the ratio between two of them)
    total_e = sum(illuminance(r["light"].get("intensity", 1.0), r["geo"]["distance"])
                  for r in rigs)
    lvl, _step = level_words(total_e / LEVEL_NOMINAL, sname)
    if lvl:
        bits.append(lvl)
    setup = named_setup(kg, ang < 8, filled=bool(others))
    if setup:
        bits.append(setup)
    ratio = _ratio_words(key, others)
    if ratio:
        bits.append(ratio)
    if len(others) == 1:
        og = others[0]["geo"]
        ow, _oh = _direction_words(og)
        oc = colour_words(others[0]["light"].get("kelvin", 0))
        bits.append("a second, %sweaker light %s"
                    % (oc.replace(" ", "-") + " " if oc else "", ow))
    elif len(others) > 1:
        bits.append("%d further sources filling the scene" % len(others))
    return _cap(join.join(b for b in bits if b)) + "."


# ------------------------------------------------------- the lighting LoRAs
# Two third-party sliders the light rig can drive, the way the camera drives
# its own. Every number below was MEASURED on the sandbox (2026-08-19, 54
# images, mean luminance and a warm/cool balance per frame); the tables are in
# the hub's CAMERA_STUDIO.md. Nothing here is assumed, because the two authors
# of "light sliders" disagree about which way is brighter.
LIGHT_LORA_KEYS = ("brightness", "colour")
LIGHT_LORA_RANGE = {"brightness": (-10.0, 10.0), "colour": (-4.0, 4.0)}
# the part of each dial that is actually usable, for the panel to say so
LIGHT_LORA_CLEAN = {"brightness": (-10.0, 10.0), "colour": (-4.0, 4.0)}

# BRIGHTNESS: negative darkens, positive brightens, and how well the plus side
# works depends entirely on HEADROOM (measured twice, 2026-08-19 - the first
# sweep only used well-exposed scenes and wrongly read the plus side as broken).
#   on an already-lit scene: +1.5 and +3 do almost nothing, +6 lifts about 9%
#   but blows 10-37% of the frame to white - it has nowhere to go;
#   on a DARK scene, which is when anyone asks for it: 0.151 -> 0.219 at +1.5,
#   0.343 at +3, 0.466 at +6, 0.495 at +10, with under 5% clipped and the
#   crushed blacks recovered from 16.7% to 0.7%. A real, monotonic lift.
# So auto works both ways, gently on the plus side because that is where the
# clipping lives when a scene is already bright.
# THE USER'S NUMBERS, and they overrule the strip (2026-08-19): "almost black
# is around -9 not -4, and around 10 is good for high brightness" - then "in
# fact you can use -10, its cleaner". The sandbox
# sweep was a bare Turbo at 8 steps with no other LoRAs on the model; their
# real stack carries the identity LoRA, the bypasses and a style, and a slider
# lands very differently underneath that lot. They judge by the generation, so
# the dial is theirs: the ends of the file's own range, and the halfway points
# between.
LIGHT_AUTO_BY_STEP = {-2: -10.0, -1: -5.0, 0: 0.0, 1: 5.0, 2: 10.0}

# COLOUR: positive is warm. Linear in MIREDS from a neutral, with a different
# factor each way because the LoRA is not symmetric: the warm side is gentle
# and near-linear to +4, the cool side turns violent past -2.5.
COLOUR_NEUTRAL_K = 5200.0
COLOUR_WARM_PER_MIRED = 0.011
COLOUR_COOL_PER_MIRED = 0.0435
COLOUR_MAX_WARM = 4.0
COLOUR_MAX_COOL = -4.0        # the file's own range, per the user


def auto_light_strength(camera, subjects, lights):
    """Brightness-slider strength from the rig's own level: minus when the rig
    is dim, plus when it is bright, 0 for an ordinary one."""
    return LIGHT_AUTO_BY_STEP.get(rig_level(camera, subjects, lights), 0.0)


def key_light_kelvin(camera, subjects, lights):
    """The colour temperature of the light doing the work, or 0 when none of
    them states one. The key is the strongest AT THE SUBJECT, the same rule
    light_words() uses."""
    live = [l for l in (lights or []) if l.get("on", True)]
    if not live:
        return 0.0
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face = [spos[0], spos[1] + float(prime.get("height", 1.7)) * 0.92, spos[2]]
    best, best_power = None, -1.0
    for l in live:
        lpos = [float(x) for x in l.get("pos", [0, 2.0, 0])]
        power = illuminance(l.get("intensity", 1.0), _len(_v(lpos, face)))
        if power > best_power:
            best, best_power = l, power
    try:
        return float((best or {}).get("kelvin", 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def auto_colour_strength(camera, subjects, lights):
    """Colour-slider strength from the key light's kelvin. 0 when the rig does
    not state a colour - saying nothing beats inventing a cast."""
    k = key_light_kelvin(camera, subjects, lights)
    if k <= 0:
        return 0.0
    mired = 1e6 / max(1000.0, k)
    delta = mired - (1e6 / COLOUR_NEUTRAL_K)          # + = warmer than neutral
    if delta >= 0:
        return round(min(COLOUR_MAX_WARM, delta * COLOUR_WARM_PER_MIRED), 2)
    return round(max(COLOUR_MAX_COOL, delta * COLOUR_COOL_PER_MIRED), 2)


LIGHT_AUTO_FN = {"brightness": auto_light_strength, "colour": auto_colour_strength}


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
ZOOM_AUTO_FACTOR, ZOOM_AUTO_MIN, ZOOM_AUTO_MAX = 0.5, -4.0, 6.0


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
    # an ASSIST to the words (which already carry the framing): half the raw
    # curve, and never past -4 / +6 - at -6 the community zoom pulled a dolly's
    # wide shots out into a field and shrank a high wide shot to a speck
    # (camera path examples, 2026-08-17)
    return round(max(ZOOM_AUTO_MIN, min(ZOOM_AUTO_MAX, strength * ZOOM_AUTO_FACTOR)), 1) + 0.0


# ---------------------------------------------------------------- camera LoRAs
# THE CAMERA'S OWN LORAS (the user's ask, 2026-08-17): four slider LoRAs the
# studio drives from the geometry, so nobody dials them by hand - zoom (from
# the shot size), height (from the pitch), orbit and back (from where the
# camera sits relative to the way the subject faces). Public strengths: about
# +-8 is a strong effect for the RedNode camera sliders (raw x0.375), and the
# range the studio hands out is clamped to what stays clean on Krea 2:
# height -10..+12, orbit -8..+8, back 0..+8. Sign conventions are the ones the
# LoRAs were trained with:
#   height: minus = camera low looking up, plus = camera high looking down
#   orbit:  minus = camera swung to ITS left (subject faces frame-right),
#           plus  = camera swung to ITS right (subject faces frame-left)
#   back:   0 = as prompted, plus = seen from behind (one-sided)
CAMERA_LORA_KEYS = ("zoom", "height", "orbit", "back")
CAMERA_LORA_RANGE = {"zoom": (ZOOM_MIN, ZOOM_MAX), "height": (-10.0, 12.0),
                     "orbit": (-8.0, 8.0), "back": (0.0, 8.0)}


def _prime_geo(camera, subjects):
    """(geo, rel) for the camera against the target subject's face - the same
    numbers describe() builds its words from, so LoRA and words agree."""
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
    geo = camera_geometry(cpos, face)
    rel = rel_bearing(spos, cpos, prime.get("facing_deg", 0))
    return geo, rel


def _clamp_key(key, v):
    lo, hi = CAMERA_LORA_RANGE[key]
    return round(max(lo, min(hi, v)), 1) + 0.0   # + 0.0: no '-0.0'


# AUTO CAPS, tuned on the end-to-end strips (2026-08-17/18): height was first
# made a light assist (words carried it on single-subject scenes), then raised
# again after a two-boxer wide scene showed the words losing to the sports
# prior with the LoRA at +3 (factor 0.15, -5..+8: raw +3 read as a clear high
# angle, raw -1.9 stays inside v2's clean low side); orbit runs to +-8; back
# changes the person past raw 2, so dead behind is 3. Manual still runs the
# full public range.
HEIGHT_AUTO_FACTOR = 0.15
HEIGHT_AUTO_MIN, HEIGHT_AUTO_MAX = -5.0, 8.0
BACK_AUTO_MAX = 3.0


def auto_height_strength(camera, subjects):
    """Pitch to the height slider, as an ASSIST to the words: -30 deg (a low
    angle) is -4.5, +40 deg about +6, saturating at -5 / +6. Stronger than
    that on top of the paragraph overshoots (blown-out worm's eye) and the low
    side starts changing the person. Manual still runs -10..+12."""
    geo, _ = _prime_geo(camera, subjects)
    # pitch < 0 means the camera looks DOWN (it is above the face) = plus
    v = _clamp_key("height", -geo["pitch"] * HEIGHT_AUTO_FACTOR)
    return round(max(HEIGHT_AUTO_MIN, min(HEIGHT_AUTO_MAX, v)), 1) + 0.0


def auto_orbit_strength(camera, subjects):
    """Bearing to the orbit slider: camera at the subject's left side (rel +90,
    the translator's 'left profile') is +8, at their right side -8, front 0.
    Behind (180) is 0 too: that is the back slider's job."""
    _, rel = _prime_geo(camera, subjects)
    return _clamp_key("orbit", 8.0 * math.sin(math.radians(rel)))


def auto_back_strength(camera, subjects):
    """Bearing to the back slider: 0 until the camera passes the subject's
    shoulder line, then rising to +5 dead behind (rear three-quarter ~ +3.5).
    More than that changes the person (short hair, darker) on top of the words."""
    _, rel = _prime_geo(camera, subjects)
    return _clamp_key("back", BACK_AUTO_MAX * max(0.0, -math.cos(math.radians(rel))))


def auto_camera_loras(camera, subjects):
    """All four auto strengths at once: {zoom, height, orbit, back}."""
    return {"zoom": auto_zoom_strength(camera, subjects),
            "height": auto_height_strength(camera, subjects),
            "orbit": auto_orbit_strength(camera, subjects),
            "back": auto_back_strength(camera, subjects)}


# ---------------------------------------------------------------- other outputs
OUTPUT_MODES = ("krea2", "short", "tags")


def _shot_facts(camera, subjects):
    """The geometry every output mode is written from: pitch band, bearing
    band, framing band, lens band, roll, lock. One place, three wordings."""
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    ti = camera.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    sname = str(prime.get("name") or "the subject")
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    face_y = spos[1] + float(prime.get("height", 1.7)) * 0.92
    cpos = [float(x) for x in camera.get("pos", [0, face_y, 3.0])]
    focal = float(camera.get("focal_mm", 35))
    geo = camera_geometry(cpos, [spos[0], face_y, spos[2]])
    rel = rel_bearing(spos, cpos, prime.get("facing_deg", 0))
    width_m = 2.0 * geo["distance"] * math.tan(math.radians(fov_deg(focal) / 2.0))
    p = geo["pitch"]          # > 0: camera below the face, looking up
    if p >= 55:
        pitch = "worm"
    elif p >= 20:
        pitch = "low"
    elif p >= 6:
        pitch = "slightly_low"
    elif p > -6:
        pitch = "eye"
    elif p > -20:
        pitch = "slightly_high"
    elif p > -55:
        pitch = "high"
    elif p > -80:
        pitch = "bird"
    else:
        pitch = "overhead"
    a = abs(rel)
    side = "left" if rel > 0 else "right"
    if a < 20:
        bearing = "front"
    elif a < 65:
        bearing = "three_quarter"
    elif a < 115:
        bearing = "profile"
    elif a < 160:
        bearing = "rear_three_quarter"
    else:
        bearing = "back"
    if width_m < 0.9:
        framing = "closeup"
    elif width_m < 1.6:
        framing = "portrait"
    elif width_m < 2.6:
        framing = "cowboy"
    elif width_m < 4.5:
        framing = "full"
    else:
        framing = "wide"
    fov = fov_deg(focal)
    lens = "ultra_wide" if fov > 85 else "wide" if fov > 60 else "normal" if fov > 30 else "tele"
    roll = float(camera.get("roll_deg", 0) or 0)
    return {"name": sname, "pitch": pitch, "pitch_deg": p, "bearing": bearing, "side": side,
            "framing": framing, "lens": lens, "focal": focal, "roll": roll,
            "locked": camera.get("lock", True) is not False,
            "others": [str(o.get("name") or "another person") for k, o in enumerate(subjects) if k != ti]}


_TAGS = {
    "pitch": {"worm": "from below, worm's-eye view, extreme low angle",
              "low": "from below, low angle", "slightly_low": "slightly from below",
              "eye": "eye level", "slightly_high": "slightly from above",
              "high": "from above, high angle", "bird": "from above, bird's-eye view",
              "overhead": "from above, top-down view, overhead"},
    "bearing": {"front": "facing viewer, looking at viewer", "three_quarter": "three-quarter view",
                "profile": "from side, profile", "rear_three_quarter": "from behind, looking back",
                "back": "from behind, back turned"},
    "framing": {"closeup": "close-up, face focus", "portrait": "portrait, upper body",
                "cowboy": "cowboy shot", "full": "full body", "wide": "wide shot, full body, scenery"},
    "lens": {"ultra_wide": "fisheye, wide-angle lens", "wide": "wide-angle lens",
             "normal": "", "tele": "telephoto lens, compressed perspective"},
}

_SHORT = {
    "pitch": {"worm": "extreme low-angle shot from ground level looking straight up at %s",
              "low": "low-angle shot from below, looking up at %s",
              "slightly_low": "shot from slightly below %s's eye level",
              "eye": "eye-level shot of %s",
              "slightly_high": "shot from slightly above %s's eye level",
              "high": "high-angle shot from above, looking down at %s",
              "bird": "steep high-angle shot from well above, looking down on %s",
              "overhead": "top-down overhead shot, looking straight down on %s"},
    "bearing": {"front": "facing the camera", "three_quarter": "in a three-quarter view",
                "profile": "in profile", "rear_three_quarter": "seen from behind and to the side",
                "back": "seen from behind"},
    "framing": {"closeup": "close-up of the face", "portrait": "head and shoulders",
                "cowboy": "three-quarter figure", "full": "full figure",
                "wide": "wide shot with the figure small in the frame"},
    "lens": {"ultra_wide": "ultra-wide lens", "wide": "wide-angle lens", "normal": "",
             "tele": "telephoto lens"},
}


def _describe_compact(camera, subjects, output):
    f = _shot_facts(camera, subjects)
    if output == "tags":
        parts = [_TAGS["pitch"][f["pitch"]], _TAGS["bearing"][f["bearing"]],
                 _TAGS["framing"][f["framing"]], _TAGS["lens"][f["lens"]]]
        if abs(f["roll"]) >= 5:
            parts.append("dutch angle")
        if not f["locked"]:
            parts.append("off-center composition")
        if f["others"]:
            parts.append("multiple subjects")
        return ", ".join(p for p in parts if p)
    # short: a sentence or two, no numbers
    bits = [_SHORT["pitch"][f["pitch"]] % f["name"], _SHORT["bearing"][f["bearing"]],
            _SHORT["framing"][f["framing"]]]
    if abs(f["roll"]) >= 5:
        bits.append("dutch tilt")
    if _SHORT["lens"][f["lens"]]:
        bits.append(_SHORT["lens"][f["lens"]])
    if not f["locked"]:
        bits.append("the subject off-center")
    text = ", ".join(bits) + "."
    if f["others"]:
        text += " Also in the scene: %s." % ", ".join(f["others"])
    return _cap(text)


# ---------------------------------------------------------------- camera paths
# BATCH ANGLES (the user's ask, 2026-08-17): one scene, the camera moving, N
# shots. Two paths: A -> B (straight line between two camera states, lens and
# roll blended too) and ORBIT (a circle round the target at the current
# distance and height, from one bearing to another). Everything else - the
# subjects, relations, lock - stays as it is; only the camera differs per shot.
PATH_MODES = ("off", "ab", "orbit")


def _lerp(a, b, t):
    return a + (b - a) * t


def interpolate_camera(cam_a, cam_b, t):
    """The camera t of the way (0..1) from A to B: position, lens, roll and
    the free-aim point blend; lock/target come from A."""
    pa = [float(x) for x in cam_a.get("pos", [0, 1.56, 3.0])]
    pb = [float(x) for x in cam_b.get("pos", pa)]
    out = dict(cam_a)
    out["pos"] = [round(_lerp(pa[i], pb[i], t), 3) for i in range(3)]
    out["focal_mm"] = round(_lerp(float(cam_a.get("focal_mm", 35)),
                                  float(cam_b.get("focal_mm", cam_a.get("focal_mm", 35))), t), 1)
    out["roll_deg"] = round(_lerp(float(cam_a.get("roll_deg", 0) or 0),
                                  float(cam_b.get("roll_deg", cam_a.get("roll_deg", 0)) or 0), t), 1)
    aa, ab = cam_a.get("aim"), cam_b.get("aim")
    if isinstance(aa, (list, tuple)) and isinstance(ab, (list, tuple)) and len(aa) == 3 and len(ab) == 3:
        out["aim"] = [round(_lerp(float(aa[i]), float(ab[i]), t), 3) for i in range(3)]
    return out


def orbit_camera(cam, subjects, bearing_deg):
    """The camera moved round the target to bearing_deg (relative to the way
    the subject faces: 0 = in front, +90 = the subject's LEFT side, -90 their
    right, 180 = behind), keeping the current ground distance and height."""
    if not subjects:
        subjects = [{"name": "the subject", "pos": [0, 0, 0], "height": 1.7,
                     "facing_deg": 0}]
    ti = cam.get("target")
    if not isinstance(ti, int) or ti < 0 or ti >= len(subjects):
        ti = 0
    prime = subjects[ti]
    spos = [float(x) for x in prime.get("pos", [0, 0, 0])]
    cpos = [float(x) for x in cam.get("pos", [0, 1.56, 3.0])]
    ground = math.hypot(cpos[0] - spos[0], cpos[2] - spos[2]) or 3.0
    facing = float(prime.get("facing_deg", 0))
    # facing degrees: 0 = +z, 90 = +x. The camera sits at facing + bearing.
    b = math.radians(facing + bearing_deg)
    out = dict(cam)
    out["pos"] = [round(spos[0] + ground * math.sin(b), 3), cpos[1],
                  round(spos[2] + ground * math.cos(b), 3)]
    return out


def camera_path(camera, subjects, path):
    """[camera, ...] for the batch. path: {mode: off|ab|orbit, shots: N,
    b: camera-state, orbit_from: deg, orbit_to: deg (+90 = the subject's
    left)}. off -> [camera]."""
    mode = (path or {}).get("mode", "off")
    n = int((path or {}).get("shots", 1) or 1)
    n = max(1, min(64, n))
    if mode == "ab" and isinstance((path or {}).get("b"), dict):
        if n == 1:
            return [dict(camera)]
        return [interpolate_camera(camera, path["b"], i / (n - 1.0)) for i in range(n)]
    if mode == "orbit":
        a0 = float((path or {}).get("orbit_from", 0.0) or 0.0)
        a1 = float((path or {}).get("orbit_to", 180.0) or 0.0)
        if n == 1:
            return [orbit_camera(camera, subjects, a0)]
        return [orbit_camera(camera, subjects, _lerp(a0, a1, i / (n - 1.0))) for i in range(n)]
    return [dict(camera)]


# ---------------------------------------------------------------- depth of field
COC_MM = 0.03            # circle of confusion, full-frame 35 mm
APERTURES = [1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0]


def dof_limits(focal_mm, f_number, dist_m):
    """(near_m, far_m or None for infinity, hyperfocal_m) for a full-frame lens."""
    f = float(focal_mm)
    N = max(0.7, float(f_number))
    s = max(0.05, float(dist_m)) * 1000.0
    H = f * f / (N * COC_MM) + f
    near = H * s / (H + (s - f))
    far = (H * s / (H - (s - f))) if s < H else None
    return near / 1000.0, (far / 1000.0 if far is not None else None), H / 1000.0


def blur_circle_mm(focal_mm, f_number, focus_m, other_m):
    """Blur circle on the sensor for a thing at other_m when focus is at focus_m."""
    f = float(focal_mm)
    N = max(0.7, float(f_number))
    s = max(0.05, float(focus_m)) * 1000.0
    d = max(0.05, float(other_m)) * 1000.0
    return (f * f / (N * max(1.0, s - f))) * abs(d - s) / d


def _blur_word(b):
    if b < COC_MM:
        return "sharp"
    if b < 3 * COC_MM:
        return "just slightly soft"
    if b < 8 * COC_MM:
        return "softly out of focus"
    return "dissolved into bokeh"


def dof_words(camera, subjects, ti, cpos, geo, focal):
    """The depth-of-field sentence, or "" when no aperture is set."""
    try:
        N = float(camera.get("aperture") or 0)
    except (TypeError, ValueError):
        N = 0.0
    if N <= 0:
        return ""
    prime = subjects[ti]
    sname = str(prime.get("name") or "the subject")
    dist = geo["distance"]
    near, far, hyper = dof_limits(focal, N, dist)
    depth = (far - near) if far is not None else None
    # background: the farthest visible non-wall thing, else 3 m past the subject
    others = []
    for k, o in enumerate(subjects):
        if k == ti or str(o.get("kind") or "person") == "wall":
            continue
        op = [float(x) for x in o.get("pos", [0, 0, 0])]
        d = _len(_v(cpos, [op[0], cpos[1], op[2]]))
        others.append((d, str(o.get("name") or "an object"), str(o.get("kind") or "person")))
    others.sort()
    fstop = ("Shot at f/%g" % N)
    if depth is None or depth > max(6.0, dist * 2.5):
        # everything sharp
        span = ("everything from %s to the far background" % sname) if not others else                ("everything from %s to %s" % (sname, others[-1][1]))
        return _cap("%s: deep depth of field, %s is in focus, no background blur." % (fstop, span))
    if depth < 0.25:
        head = ("%s: razor-thin depth of field, only %s's face is truly sharp (about %d cm of focus)"
                % (fstop, sname, max(1, int(round(depth * 100)))))
    elif depth < 1.0:
        head = ("%s: shallow depth of field, %s is sharp within about %d cm"
                % (fstop, sname, int(round(depth * 100))))
    else:
        head = ("%s: moderate depth of field, %s is sharp within about %.1f meters"
                % (fstop, sname, depth))
    bits = []
    for d, name, kind in others[:5]:
        b = blur_circle_mm(focal, N, dist, d)
        w = _blur_word(b)
        if w == "sharp":
            continue
        where = "behind" if d > dist else "in front"
        bits.append("%s, %.1f m %s, is %s" % (name, abs(d - dist), where, w))
    bg = blur_circle_mm(focal, N, dist, dist + 3.0)
    tail = ""
    if _blur_word(bg) != "sharp":
        tail = "; the background %s" % ("melts into soft creamy bokeh" if bg >= 8 * COC_MM
                                          else "goes soft" if bg >= 3 * COC_MM else "is slightly soft")
    return _cap(head + ("; " + "; ".join(bits) if bits else "") + tail + ".")
