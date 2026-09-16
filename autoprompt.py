"""RedNode auto-prompt engines: describe a workspace image, mode-aware.

The finding this implements: Krea 2 responds best to natural language MIXED with
SD-style tag vocabulary, not either alone. So an auto prompt here is an LLM paragraph
(Ollama, with a per-mode system prompt) plus a filtered WD14 tag line, either appended
after each other or blended by a second LLM pass.

Modes carry the hard-won parsing rules:
  subject     full person description, no scenery talk
  scene_view  the place and camera; any people are just "a person", never described
  scene_style / style   the art style only; no subjects, no story

Engines:
  Ollama  plain HTTP to the local server, no pack dependency, full system-prompt control
  WD14    the installed comfyui-wd14-tagger pack, called through its registered node
  Wired   any STRING a captioner chain produces (JoyCaption, Florence, CLIP-gen) is
          combined in through the workspace's caption sockets

Every engine fails SOFT: a dead Ollama or missing tagger prints one console line and the
prompt is built from whatever did answer. A queue never dies because a captioner did.
"""

import base64
import hashlib
import inspect
import json
import re
import sys
import urllib.error
import urllib.request

OLLAMA_URL = "http://127.0.0.1:11434"
TIMEOUT = 120

# ---------------------------------------------------------------------------
# per-mode system prompts for the captioning LLM (not the Krea 2 vision encoder)
# ---------------------------------------------------------------------------
SYSTEM_PROMPTS = {
    # the person's TRAITS only: the prompt and the camera own the setting, the light,
    # the framing and the pose, so a caption that describes them fights both
    "subject": (
        "Describe only the person in the image, for an image generation prompt: their "
        "face, eyes, hair, skin, apparent age, build, expression, makeup, tattoos, "
        "clothing and accessories, precisely. Leave out everything that is not the "
        "person: the background, the location, the lighting, the camera, the shot type, "
        "the framing and the pose. Do not say what is absent. Do not use names. Mix plain "
        "sentences with comma-separated descriptors. Answer with the description only, "
        "no preamble."),
    "scene_view": (
        "Describe the location, layout, lighting and camera framing of the image for an "
        "image generation prompt. State the image orientation and the camera angle. "
        "Refer to any people only as 'a person' or 'people', with no description of "
        "their appearance, clothing or identity. Mix plain sentences with comma-"
        "separated descriptors. Answer with the description only, no preamble."),
    "scene_style": (
        "Describe only the artistic style of the image for an image generation prompt: "
        "medium, color palette, lighting character, texture, rendering technique and "
        "mood. Do not describe the subjects, objects or location. Mix plain sentences "
        "with comma-separated descriptors. Answer with the description only, no "
        "preamble."),
}
SYSTEM_PROMPTS["i2i"] = (
    "Describe this image completely for an image-to-image generation prompt: the "
    "people with their appearance and clothing, the setting, the lighting, the camera "
    "framing and the composition. State the image orientation. Mix plain sentences "
    "with comma-separated descriptors. Do not use names. Answer with the description "
    "only, no preamble.")
# the Scene tab's third reading: what is going on, rather than where or how it looks
SYSTEM_PROMPTS["scene_action"] = (
    "Describe what is happening in the image for an image generation prompt: the "
    "activity, how many people there are, where they are and how they are posed, what "
    "they are doing and how they interact, and the kind of place it happens in, in a "
    "few words. Refer to people only as 'a person', 'a man', 'a woman' or 'people', "
    "never describing their faces, hair, clothing or identity. Mix plain sentences with "
    "comma-separated descriptors. Answer with the description only, no preamble.")
SYSTEM_PROMPTS["style"] = SYSTEM_PROMPTS["scene_style"]
SYSTEM_PROMPTS["people"] = SYSTEM_PROMPTS["subject"]

# opt-in, appended to every mode prompt when you flip it on: your content needs
# captions that name what is there instead of dancing around it
FRANK_CLAUSE = (" Describe any nudity or sexual content plainly and specifically, without "
                "euphemism and without omission.")


def mode_prompt(mode, frank=False, custom=""):
    """The mode's shipped wording, or `custom` in its place. The frank clause is still
    appended either way, so turning FRANK on keeps biting with your own wording."""
    base = str(custom or "").strip() or SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["subject"])
    return base + (FRANK_CLAUSE if frank else "")


# Ollama takes TWO strings: the system prompt (mode_prompt above, what the model is told
# to BE) and you message (this, what it is ASKED). Only the system half was ever
# reachable. Plenty of vision models lean far harder on the question than on the system
# prompt, so setting one without the other only half works. Empty means this default,
# which is the exact string every existing workflow has been sending.
DEFAULT_QUESTION = "Describe this image."


BLEND_SYSTEM = (
    "You merge image descriptions into one image generation prompt. Combine every fact "
    "from the inputs into a single prompt that mixes natural sentences with "
    "comma-separated tag vocabulary. Keep all concrete details, drop duplicates, add "
    "nothing new. Answer with the prompt only, no preamble.")

def trim_words(text, max_words):
    """Cut to about max_words at a natural boundary: sentence end first, then comma.

    Long prompts overpower the mood, so the budget is enforced by parsing, not just
    requested from the LLM. 0 means free length.
    """
    t = str(text or "").strip()
    try:
        n = int(max_words or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return t
    words = t.split()
    if len(words) <= n:
        return t
    head = " ".join(words[:n])
    if head.endswith("."):
        return head
    dot = head.rfind(". ")
    if dot >= len(head) // 4:
        return head[:dot + 1].strip()
    comma = head.rfind(",")
    if comma >= len(head) // 4:
        return head[:comma].strip()
    return head.rstrip(" ,.;")


# ---------------------------------------------------------------------------
# WD14 tag filtering: the parse-out lists, shipped instead of rebuilt by hand
# ---------------------------------------------------------------------------
# tags that describe a person; scene and style modes must not leak them
PERSON_TAG_PARTS = (
    "girl", "boy", "woman", "man", "person", "solo", "hair", "eye", "face", "smile",
    "mouth", "lip", "teeth", "skin", "breast", "chest", "cleavage", "navel", "thigh",
    "leg", "arm", "hand", "finger", "shoulder", "neck", "collarbone", "looking_",
    "portrait", "bangs", "ponytail", "braid", "twintail", "makeup", "blush", "freckle",
    "dress", "shirt", "skirt", "jacket", "corset", "choker", "necklace", "earring",
    "glove", "stocking", "panties", "bra", "bikini", "swimsuit", "uniform", "costume",
    "sleeve", "collar", "hat", "nude", "topless", "underwear", "cosplay", "tattoo",
)
# scenery tags; subject mode drops them so the person stays the point
SCENE_TAG_PARTS = (
    "outdoor", "indoor", "sky", "cloud", "tree", "forest", "mountain", "ocean", "beach",
    "city", "street", "building", "room", "wall", "window", "door", "grass", "flower",
    "water", "night", "day", "sunset", "sunlight", "moon", "star_", "landscape",
    "scenery", "background", "market", "crowd", "road", "bridge", "field", "snow",
    "rain", "architecture", "interior", "exterior",
)
# person-count tags become plain words in scene view instead of vanishing
COUNT_WORDS = {
    "1girl": "one person", "1boy": "one person", "2girls": "two people",
    "2boys": "two people", "3girls": "three people", "3boys": "three people",
    "multiple_girls": "several people", "multiple_boys": "several people",
    "6+girls": "a group of people", "6+boys": "a group of people",
}


# SUBJECT CAPTIONS KEEP THE PERSON. Florence and the taggers take no instruction, and
# the language models drift, so every subject caption is cut at use: a sentence about
# the setting, the light, the camera or the framing goes, a mixed sentence loses the
# clause that is about them, and statements of what is absent go.
import re as _re

_NOT_PERSON = (
    "background", "backdrop", "setting", "scene", "room", "wall", "street", "road",
    "city", "building", "outdoor", "indoor", "sky", "landscape", "window", "studio",
    "lighting", "sunlight", "daylight", "natural light", "soft light", "light source",
    "illuminat", "backlit", "shadow", "camera", "shot", "close-up", "closeup",
    "orientation", "framing", "framed", "in frame", "cropped", "centered", "centred",
    "composition", "photograph", "the image", "this image", "the photo", "the picture",
    "depth of field", "bokeh", "blurred", "blurry", "visible", "facing", "looking at",
    "pose", "posing", "posed", "standing", "sitting", "seated", "leaning",
)
_PERSON = (
    "hair", "eye", "face", "skin", "lip", "nose", "brow", "cheek", "freckle", "makeup",
    "wear", "dress", "shirt", "top", "sweater", "jacket", "coat", "necklace", "earring",
    "tattoo", "woman", "man", "girl", "boy", "person", "she ", "he ", "her ", "his ",
    "expression", "smile", "complexion", "build", "beard", "glasses",
)
_WHERE = _re.compile(
    r"\s*\b(?:standing|sitting|seated|posing|leaning)?\s*\b(?:on|in|at|against|near|"
    r"in front of|outside|inside|by)\s+(?:a|an|the)\s+[^,.;]*?\b(?:street|road|room|"
    r"wall|city|building|background|backdrop|studio|park|beach|forest|field|window|"
    r"cafe|café|market|garden|kitchen|bedroom|office)\b[^,.;]*", _re.I)
_ABSENT = _re.compile(r"^\s*(?:there (?:is|are) )?no\s+\w+(?:\s+\w+)?\s*\.?\s*$", _re.I)


def _about(text, words):
    t = " " + text.lower() + " "
    return any(w in t for w in words)


def subject_only(text):
    """A subject caption with the setting, light, camera, framing and pose taken out."""
    out = []
    for sent in _re.split(r"(?<=[.!?])\s+", str(text or "").strip()):
        s = _WHERE.sub("", sent).strip()
        if not s or _ABSENT.match(s):
            continue
        if not _about(s, _NOT_PERSON):
            out.append(s)
            continue
        if not _about(s, _PERSON):
            continue                                   # a sentence about something else
        # a mixed sentence keeps its clauses about the person
        end = s[-1] if s[-1] in ".!?" else "."
        kept = [c.strip() for c in _re.split(r",\s*|\s+with\s+", s.rstrip(".!?"))
                if c.strip() and not _about(c, _NOT_PERSON)]
        if kept and _about(" ".join(kept), _PERSON):
            out.append(", ".join(kept) + end)
    return " ".join(out).strip()


def _matches(tag, parts):
    t = tag.strip().lower().replace(" ", "_")
    return any(p in t for p in parts)


def filter_tags(tags_line, mode):
    """The mode-aware tag parse the user used to maintain by hand."""
    out = []
    for raw in str(tags_line or "").split(","):
        tag = raw.strip()
        if not tag:
            continue
        key = tag.lower().replace(" ", "_")
        if mode in ("scene_view", "scene_action", "scene_style", "style"):
            if key in COUNT_WORDS:
                if mode in ("scene_view", "scene_action") and COUNT_WORDS[key] not in out:
                    out.append(COUNT_WORDS[key])
                continue
            if _matches(tag, PERSON_TAG_PARTS):
                continue
        if mode in ("subject", "people") and _matches(tag, SCENE_TAG_PARTS):
            continue
        out.append(tag)
    return ", ".join(out)


# ---------------------------------------------------------------------------
# Ollama, plain HTTP
# ---------------------------------------------------------------------------
def _http_json(url, payload=None, timeout=TIMEOUT):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


# What actually goes over the wire to a vision model.
#
# Sending the file as-is meant sending whatever you happened to have: a webp
# or an avif a vision endpoint may not decode at all, and a 4000px original that
# is megabytes of base64 for a model that will look at a fraction of it. Both show
# up as "the captioner is slow" rather than as an error, which is the worst way for
# a problem to present.
VISION_MAX_EDGE = 1024


def vision_payload(path, max_edge=VISION_MAX_EDGE):
    """JPEG bytes at a sane size, whatever the source format was."""
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            src_w, src_h = im.size
            im = im.convert("RGB")
            if max(im.size) > max_edge:
                scale = max_edge / max(im.size)
                im = im.resize((max(1, int(im.width * scale)),
                                max(1, int(im.height * scale))), Image.LANCZOS)
            buf = _io_bytes()
            im.save(buf, format="JPEG", quality=90, optimize=True)
            data = buf.getvalue()
        try:
            import os as _os
            was = _os.path.getsize(path)
            if was > len(data) * 1.5 or max(src_w, src_h) > max_edge:
                print(f"[RedNode AutoPrompt] vision input: {src_w}x{src_h} "
                      f"{was // 1024} KB -> {im.width}x{im.height} "
                      f"{len(data) // 1024} KB", flush=True)
        except OSError:
            pass
        return data
    except Exception as e:
        # a format PIL cannot read at all: fall back to the raw file and let the
        # engine decide, rather than dropping the image entirely
        print(f"[RedNode AutoPrompt] could not re-encode the image ({e}); sending it "
              "as it is", flush=True)
        try:
            with open(path, "rb") as f:
                return f.read()
        except OSError:
            return None


def _io_bytes():
    import io as _io
    return _io.BytesIO()


def ollama_model_sizes(url=OLLAMA_URL, transport=_http_json):
    """{model name: file size in bytes} from Ollama's list; {} when it is not running."""
    try:
        data = transport(f"{url.rstrip('/')}/api/tags", None, 10)
        return {m["name"]: int(m.get("size") or 0)
                for m in data.get("models", []) if m.get("name")}
    except Exception:
        return {}


def ollama_models(url=OLLAMA_URL, transport=_http_json):
    return sorted(ollama_model_sizes(url, transport))


import re as _re
import time as _time


def _strip_think(text):
    """Reasoning models leak <think> blocks into the response; a prompt never wants them."""
    return _re.sub(r"<think>.*?</think>", "", text, flags=_re.DOTALL).strip()


def ollama_generate(model, system, prompt, image_bytes=None, url=OLLAMA_URL,
                    transport=_http_json, options=None, think=False, keep_alive=0):
    """One completion; returns "" and prints one line on any failure (fail soft).

    `options` are Ollama sampler options (temperature, seed, num_ctx, num_predict,
    top_k, top_p); zero/None values are simply not sent, leaving the model's own
    defaults in charge. `think` gates reasoning models' thinking pass.
    """
    opts = {"temperature": 0.2}
    for key, val in (options or {}).items():
        if val is None:
            continue
        if key in ("seed", "num_ctx", "num_predict", "top_k") and not int(val):
            continue
        if key == "top_p" and not float(val):
            continue
        opts[key] = val
    # keep_alive 0 releases the model's RAM the moment the response lands. The cost:
    # a second call (the blend pass, or the next tab) reloads it. That trade sits in
    # the advanced settings.
    payload = {"model": model, "system": system, "prompt": prompt, "stream": False,
               "options": opts, "think": bool(think),
               "keep_alive": f"{max(0, int(keep_alive))}s"}
    if image_bytes:
        payload["images"] = [base64.b64encode(image_bytes).decode()]
    try:
        data = transport(f"{url.rstrip('/')}/api/generate", payload, TIMEOUT)
        return _strip_think(str(data.get("response", "")))
    except Exception as e:
        print(f"[RedNode AutoPrompt] Ollama unavailable ({e}); continuing without it",
              flush=True)
        return ""


MERGE_PEOPLE_SYSTEM = """You merge an image prompt with descriptions of the people in it, for a text to image model.

Rules:
1. Keep every fact of the prompt: the scene, the action, the camera, the light, the style.
2. The people are named. Where the prompt mentions people in general ("a woman", "two friends", "they"), use their names instead, and describe each person by name with the facts from their description: looks, hair, clothing.
3. A person the prompt does not mention is placed into the scene naturally.
4. Leave out anything in a description about a background or a setting; the prompt owns the setting.
5. Write flowing sentences. No lists, no headings, no quotes around names. Add nothing that changes the picture.
6. Answer with ONLY the finished prompt."""

_MERGE_CACHE = {}


def merge_people(prompt, people, model, url=OLLAMA_URL, keep_alive=0, reuse=True,
                 generate=None):
    """The prompt and the named people's captions, rewritten into one prompt by Ollama.

    people: [(name, caption)]. REUSE keeps the last answer for the same inputs, so the
    rewrite runs once; FRESH asks again. "" on any failure, having printed why."""
    people = [(str(n), str(c)) for n, c in people if str(c).strip()]
    if not people:
        return ""
    key = json.dumps([str(prompt), people, str(model)])
    if reuse and key in _MERGE_CACHE:
        print("[RedNode AutoPrompt] people rewrite: reused", flush=True)
        return _MERGE_CACHE[key]
    lines = "\n".join("%s: %s" % (n, c) for n, c in people)
    user = ("Prompt:\n%s\n\nPeople:\n%s\n\nWrite the merged prompt."
            % (str(prompt).strip() or "(empty)", lines))
    gen = generate or (lambda m, s, p: ollama_generate(
        m, s, p, url=url, options={"temperature": 0.4, "num_predict": 700},
        keep_alive=keep_alive))
    text = _strip_think(str(gen(model, MERGE_PEOPLE_SYSTEM, user) or "")).strip().strip('"')
    if not text:
        print("[RedNode AutoPrompt] people rewrite: no answer, the captions are "
              "appended instead", flush=True)
        return ""
    if len(_MERGE_CACHE) >= 64:
        _MERGE_CACHE.pop(next(iter(_MERGE_CACHE)))
    _MERGE_CACHE[key] = text
    print("[RedNode AutoPrompt] people rewrite: %d people merged into the prompt"
          % len(people), flush=True)
    return text


def ollama_unload(model, url=OLLAMA_URL, transport=_http_json):
    """Drop the model from Ollama's memory now.

    Lets a run hold the model across its tabs (one load instead of four) and still
    hand the VRAM back at the end, which is what keep_alive 0 was reaching for.
    """
    if not model:
        return
    try:
        transport(f"{url.rstrip('/')}/api/generate",
                  {"model": model, "prompt": "", "keep_alive": 0, "stream": False}, 30)
        print(f"[RedNode AutoPrompt] released {model} from Ollama", flush=True)
    except Exception as e:
        print(f"[RedNode AutoPrompt] could not release {model} ({e})", flush=True)


# ---------------------------------------------------------------------------
# WD14 through the installed tagger pack
# ---------------------------------------------------------------------------
def _node_cls(name):
    try:
        import nodes
        return nodes.NODE_CLASS_MAPPINGS.get(name)
    except Exception:
        return None


# style vocabulary the STYLE LOCK scrubs from subject and scene prompts when the
# moodboard owns the style. Phrases first, so "oil painting" goes before "painting".
STYLE_VOCAB = (
    "photo-realistic", "photorealistic", "hyperrealistic", "hyper-realistic",
    "film grain", "35mm", "dslr", "photography", "photographic", "photograph",
    "cinematic lighting", "cinematic", "3d render", "3d rendered", "octane render",
    "unreal engine", "cgi", "digital painting", "digital art", "concept art",
    "oil painting", "watercolour", "watercolor", "acrylic", "gouache",
    "pencil drawing", "pencil sketch", "charcoal", "line art", "lineart",
    "ink drawing", "vector art", "pixel art", "low poly", "cel-shaded", "cel shading",
    "claymation", "stop motion", "airbrush", "pastel drawing", "anime", "manga",
    "cartoon", "comic book", "comic", "illustration", "illustrated", "sketch",
    "painting", "realistic", "render",
)


# lighting and atmosphere vocabulary: style in this model's eyes, but split from the
# medium list because stripping it is a stronger, opt-in choice (it borders on content)
LIGHTING_VOCAB = (
    "golden hour", "blue hour", "backlighting", "backlit", "rim lighting", "rim light",
    "halo effect", "lens flare", "light rays", "god rays", "volumetric lighting",
    "volumetric light", "chiaroscuro", "dramatic lighting", "moody lighting",
    "studio lighting", "soft lighting", "hard lighting", "ambient lighting",
    "natural lighting", "neon lighting", "cinematic light", "long shadows",
    "soft shadows", "hard shadows", "deep shadows", "depth of field",
    "shallow depth", "bokeh", "vignette", "motion blur", "high contrast", "low key",
    "high key", "hdr", "overexposed", "underexposed", "grainy", "glow", "glowing",
)


def strip_style_terms(text, keep_text="", include_lighting=False):
    """Remove style vocabulary that the mood prompt does NOT itself use.

    The deterministic half of the style lock: a photo-sourced subject caption stops
    smuggling "photorealistic, film grain" into a prompt whose style the moodboard
    owns. Terms present in keep_text survive, so agreeing styles are never stripped.
    """
    out = str(text or "")
    keep = str(keep_text or "").lower()
    vocab = STYLE_VOCAB + (LIGHTING_VOCAB if include_lighting else ())
    for term in vocab:
        if term in keep:
            continue
        out = _re.sub(r"(?i)\b" + _re.escape(term) + r"\b", "", out)
    out = _re.sub(r"\s*,\s*(?:,\s*)+", ", ", out)          # collapse ", , ,"
    out = _re.sub(r"\(\s*\)", "", out)
    out = _re.sub(r"[ \t]{2,}", " ", out)
    out = _re.sub(r"\s+([,.;])", r"\1", out)
    out = _re.sub(r"(?m)^[,.;\s]+", "", out)
    return out.strip(" ,;\n")


STYLE_LOCK_SYSTEM = (
    "You enforce a target art style on an image description. Remove or reword any "
    "artistic style, medium, rendering or photography references that conflict with the "
    "target style. Keep every content detail: people, clothing, objects, layout, "
    "lighting direction. Do not add new details. Answer with the corrected description "
    "only, no preamble.")


def enforce_style(text, style_text, model="", clip=None, url=OLLAMA_URL, transport=None,
                  options=None, keep_alive=0):
    """The rewrite half of the style lock.

    The loaded CLIP is tried FIRST: the rewrite is text-only and the encoder is already
    resident, so it costs nothing extra. Ollama is the fallback, the word scrub the
    floor. Something always comes back.
    """
    transport = transport or _http_json
    if clip is not None and hasattr(clip, "generate"):
        try:
            instruction = (STYLE_LOCK_SYSTEM + f"\n\nTarget style: {style_text}\n\n"
                           f"Description to correct:\n{text}")
            tokens = clip.tokenize(instruction, min_length=1, thinking=False)
            ids = clip.generate(tokens, do_sample=False, max_length=512)
            out = str(clip.decode(ids)).strip()
            if out:
                return out
        except Exception as e:
            print(f"[RedNode AutoPrompt] style lock via CLIP failed ({e}); trying Ollama",
                  flush=True)
    if model:
        rewritten = ollama_generate(
            model, STYLE_LOCK_SYSTEM,
            f"Target style: {style_text}\n\nDescription to correct:\n{text}",
            None, url, transport, options=options, keep_alive=keep_alive)
        if rewritten:
            return rewritten
    print("[RedNode AutoPrompt] style lock rewrite failed; scrubbing words instead",
          flush=True)
    return strip_style_terms(text, style_text)



def _wd14_node():
    return _node_cls("WD14Tagger|pysssss")


def _call_filtered(fn, **kwargs):
    """Call another pack's node function with only the parameters it accepts, letting
    its own defaults cover the rest. Survives their signature growing or shrinking.
    A required parameter this call does not name takes the node's widget default:
    two packs can register the same node name at different versions (an older
    Florence2ModelLoader with a required attention), and whichever loaded last wins."""
    params = inspect.signature(fn).parameters
    call = {k: v for k, v in kwargs.items() if k in params}
    owner = getattr(fn, "__self__", None)
    for name, p in params.items():
        if (name in call or p.default is not inspect.Parameter.empty
                or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) or owner is None):
            continue
        d = _widget_default(type(owner), name)
        if d is not None:
            call[name] = d
    return fn(**call)


def _first_string(result):
    if isinstance(result, dict):
        result = result.get("result", ("",))
    while isinstance(result, (list, tuple)):
        result = result[0] if result else ""
    return str(result).strip()


# ---------------------------------------------------------------------------
# JoyCaption and QwenVL, through their installed packs. Singleton instances on
# purpose: both cache their model on the node INSTANCE, so a fresh instance per
# call would reload gigabytes every run.
# ---------------------------------------------------------------------------
_jc_instance = None
_qwen_instance = None


def joycaption_available():
    return _node_cls("JC_adv") is not None or _node_cls("JC") is not None


def qwenvl_available():
    return _node_cls("AILab_QwenVL") is not None


def _widget_default(cls, name):
    try:
        spec = cls.INPUT_TYPES()["required"][name]
        default = (spec[1] or {}).get("default") if len(spec) > 1 else None
        if default is not None:
            return default
        opts = spec[0]
        return opts[0] if isinstance(opts, (list, tuple)) and opts else None
    except Exception:
        return None


def joycaption_options():
    """The installed pack's own choice lists, for the panel's advanced settings."""
    cls = _node_cls("JC_adv") or _node_cls("JC")
    out = {}
    try:
        req = cls.INPUT_TYPES()["required"]
        for key in ("quantization", "prompt_style", "caption_length"):
            spec = req.get(key)
            if spec and isinstance(spec[0], (list, tuple)):
                out[key] = list(spec[0])
    except Exception:
        pass
    return out


def joycaption_caption(image_tensor, prompt, unload=True, quantization="",
                       prompt_style="", caption_length="", memory="auto",
                       use_mode_prompt=True):
    """One caption from the installed JoyCaption pack; "" and one line on failure.

    With use_mode_prompt on (the default), our mode prompt rides custom_prompt and the
    pack's prompt_style is ignored by the pack itself. Off hands control back to its
    prompt_style / caption_length pair. memory "auto" follows the RAM unload setting.
    """
    global _jc_instance
    cls = _node_cls("JC_adv") or _node_cls("JC")
    if cls is None:
        print("[RedNode AutoPrompt] ComfyUI-JoyCaption is not installed; skipping it",
              flush=True)
        return ""
    try:
        if _jc_instance is None or type(_jc_instance) is not cls:
            _jc_instance = cls()
        fn = getattr(_jc_instance, cls.FUNCTION)
        mem = memory if memory in ("Keep in Memory", "Clear After Run", "Global Cache") \
            else ("Clear After Run" if unload else "Keep in Memory")
        text = _first_string(_call_filtered(
            fn, image=image_tensor,
            model=_widget_default(cls, "model"),
            quantization=quantization or _widget_default(cls, "quantization"),
            prompt_style=prompt_style or _widget_default(cls, "prompt_style") or "Descriptive",
            caption_length=caption_length or _widget_default(cls, "caption_length") or "any",
            max_new_tokens=512, temperature=0.6, top_p=0.9, top_k=0,
            custom_prompt=prompt if use_mode_prompt else "",
            memory_management=mem))
        if mem == "Clear After Run":
            free_vram()                      # hand the space back before the next engine loads
        return text
    except Exception as e:
        print(f"[RedNode AutoPrompt] JoyCaption failed ({e}); continuing without it",
              flush=True)
        return ""


def qwenvl_caption(image_tensor, mode_prompt, unload=True):
    """One caption from the installed QwenVL pack (the same Qwen3-VL family as the
    Krea 2 text encoder, which is as close to 'generate with the loaded clip' as
    ComfyUI allows); "" and one line on failure."""
    global _qwen_instance
    cls = _node_cls("AILab_QwenVL")
    if cls is None:
        print("[RedNode AutoPrompt] ComfyUI-QwenVL is not installed; skipping it",
              flush=True)
        return ""
    try:
        if _qwen_instance is None or type(_qwen_instance) is not cls:
            _qwen_instance = cls()
        fn = getattr(_qwen_instance, cls.FUNCTION)
        text = _first_string(_call_filtered(
            fn, image=image_tensor,
            model_name=_widget_default(cls, "model_name"),
            quantization=_widget_default(cls, "quantization"),
            attention_mode=_widget_default(cls, "attention_mode") or "auto",
            preset_prompt=_widget_default(cls, "preset_prompt"),
            custom_prompt=mode_prompt,
            max_tokens=512, seed=1,
            keep_model_loaded=not unload))
        if unload:
            free_vram()                      # hand the space back before the next engine loads
        return text
    except Exception as e:
        print(f"[RedNode AutoPrompt] QwenVL failed ({e}); continuing without it",
              flush=True)
        return ""


# ---------------------------------------------------------------------------
# Florence-2, through kijai's comfyui-florence2 pack: the loader's model list is
# models/LLM, the run node hands back (image, mask, caption, data). The loaded
# model is held between calls on purpose and dropped when unload says so.
# ---------------------------------------------------------------------------
_fl_model = {"key": None, "obj": None}

FLORENCE_TASKS = ("more_detailed_caption", "detailed_caption", "caption",
                  "prompt_gen_mixed_caption", "prompt_gen_mixed_caption_plus",
                  "prompt_gen_tags", "prompt_gen_analyze")


def engine_defaults():
    """The installed caption packs' own default model and quantization, for the panel's
    VRAM estimates. Empty strings where a pack is missing."""
    qwen, joy = _node_cls("AILab_QwenVL"), (_node_cls("JC_adv") or _node_cls("JC"))
    return {
        "qwen_model": str(_widget_default(qwen, "model_name") or "") if qwen else "",
        "qwen_quant": str(_widget_default(qwen, "quantization") or "") if qwen else "",
        "joy_quant": str(_widget_default(joy, "quantization") or "") if joy else "",
    }


_fl_warned = set()


def _florence_classes():
    """The Florence-2 loader and run node to use.

    kijai's comfyui-florence2 runs its own native model. Other packs register nodes
    under the same names on the older transformers path, which on current
    transformers generates nothing but <s> tokens; whichever pack loads last owns
    the names. So kijai's module is found directly when it is loaded, and the
    registered names are only the fallback."""
    for m in list(sys.modules.values()):
        if (callable(getattr(m, "load_florence2", None))
                and isinstance(getattr(m, "Florence2ModelLoader", None), type)
                and isinstance(getattr(m, "Florence2Run", None), type)):
            loader, run = m.Florence2ModelLoader, m.Florence2Run
            reg = _node_cls("Florence2ModelLoader")
            if reg is not None and reg is not loader and "shadowed" not in _fl_warned:
                _fl_warned.add("shadowed")
                print("[RedNode AutoPrompt] another pack registers Florence2ModelLoader "
                      "(%s); the auto prompt uses comfyui-florence2's own nodes instead"
                      % getattr(reg, "__module__", "?"), flush=True)
            return loader, run
    return _node_cls("Florence2ModelLoader"), _node_cls("Florence2Run")


def florence_available():
    loader, run = _florence_classes()
    return loader is not None and run is not None


def florence_models():
    """The Florence-2 folders in models/LLM, as the pack's loader lists them."""
    cls = _florence_classes()[0]
    try:
        return [str(x) for x in cls.INPUT_TYPES()["required"]["model"][0]]
    except Exception:
        return []


def florence_release():
    """Drop the held Florence-2 model."""
    _fl_model["key"], _fl_model["obj"] = None, None


def florence_caption(image_tensor, task="more_detailed_caption", model="", unload=True,
                     precision="fp16"):
    """One caption from the installed Florence-2 pack; "" and one line on failure.
    "" for the model picks the first folder the loader lists."""
    loader, run = _florence_classes()
    if loader is None or run is None:
        print("[RedNode AutoPrompt] comfyui-florence2 is not installed; skipping Florence",
              flush=True)
        return ""
    try:
        name = model or _widget_default(loader, "model")
        if not name:
            print("[RedNode AutoPrompt] no Florence-2 folder in models/LLM; skipping it",
                  flush=True)
            return ""
        key = (name, precision)
        if _fl_model["obj"] is None or _fl_model["key"] != key:
            got = _call_filtered(getattr(loader(), loader.FUNCTION), model=name,
                                 precision=precision)
            vals = getattr(got, "args", None)
            if vals is None:
                vals = got if isinstance(got, (list, tuple)) else [got]
            _fl_model["obj"], _fl_model["key"] = vals[0], key
        out = _call_filtered(
            getattr(run(), run.FUNCTION), image=image_tensor, text_input="",
            florence2_model=_fl_model["obj"],
            task=task if task in FLORENCE_TASKS else "more_detailed_caption",
            fill_mask=False, keep_model_loaded=not unload, max_new_tokens=512,
            num_beams=3, do_sample=True, seed=1)
        vals = getattr(out, "args", None)
        if vals is None:
            vals = out.get("result", ()) if isinstance(out, dict) else out
        text = _first_string(vals[2]) if isinstance(vals, (list, tuple)) and len(vals) > 2 else ""
        text = re.sub(r"</?s>", "", text or "").strip()
        if not text:
            print("[RedNode AutoPrompt] Florence-2 returned no words for this picture. "
                  "If the console shows a line of <s> tokens, the Florence node in use is "
                  "not comfyui-florence2's own; update or reinstall comfyui-florence2.",
                  flush=True)
        if unload:
            florence_release()
            free_vram()                      # hand the space back before the next engine loads
        return text
    except Exception as e:
        print(f"[RedNode AutoPrompt] Florence-2 failed ({e}); continuing without it",
              flush=True)
        return ""


def wd14_available():
    return _wd14_node() is not None


def wd14_default_model():
    cls = _wd14_node()
    try:
        spec = cls.INPUT_TYPES()["required"]["model"]
        opts = spec[0]
        default = (spec[1] or {}).get("default") if len(spec) > 1 else None
        return default or (opts[0] if opts else "")
    except Exception:
        return ""


def wd14_models():
    cls = _wd14_node()
    try:
        opts = cls.INPUT_TYPES()["required"]["model"][0]
        return list(opts) if isinstance(opts, (list, tuple)) else []
    except Exception:
        return []


def wd14_tag(image_tensor, model="", threshold=0.35, character_threshold=0.85,
             replace_underscore=False, exclude_tags=""):
    """Run the installed tagger; "" plus one console line when it cannot run."""
    cls = _wd14_node()
    if cls is None:
        print("[RedNode AutoPrompt] comfyui-wd14-tagger is not installed; "
              "continuing without tags", flush=True)
        return ""
    try:
        fn = getattr(cls(), cls.FUNCTION)
        kwargs = {"image": image_tensor, "model": model or wd14_default_model(),
                  "threshold": float(threshold),
                  "character_threshold": float(character_threshold),
                  "exclude_tags": str(exclude_tags), "replace_underscore": bool(replace_underscore),
                  "trailing_comma": False}
        accepted = set(inspect.signature(fn).parameters)
        result = fn(**{k: v for k, v in kwargs.items() if k in accepted})
        if isinstance(result, dict):
            result = result.get("result", ("",))
        tags = result[0] if isinstance(result, (list, tuple)) else result
        if isinstance(tags, (list, tuple)):
            tags = tags[0] if tags else ""
        return str(tags).strip()
    except Exception as e:
        print(f"[RedNode AutoPrompt] WD14 failed ({e}); continuing without tags",
              flush=True)
        return ""


# ---------------------------------------------------------------------------
# combining
# ---------------------------------------------------------------------------
def combine_append(paragraphs, tag_line):
    parts = [p.strip() for p in paragraphs if p and p.strip()]
    if tag_line.strip():
        parts.append(tag_line.strip())
    return "\n\n".join(parts)


def clipgen_caption(clip, image_tensor, mode_prompt, max_length=512):
    """Generate a caption with the ALREADY-LOADED text encoder, the way comfy-core's
    Generate Text node does: clip.tokenize -> clip.generate -> clip.decode.

    Zero extra models in memory — this is the encoder the workflow already carries.
    Needs a VL-family CLIP on a recent ComfyUI; anything else fails soft with one line.
    Greedy decoding on purpose: captions should be stable, not creative.
    """
    if clip is None:
        print("[RedNode AutoPrompt] CLIP gen is on but no CLIP is wired into the "
              "workspace clip input; skipping it", flush=True)
        return ""
    if not hasattr(clip, "generate"):
        print("[RedNode AutoPrompt] this CLIP cannot generate text (needs a VL text "
              "encoder and a recent ComfyUI); skipping it", flush=True)
        return ""
    try:
        tokens = clip.tokenize(mode_prompt, image=image_tensor, min_length=1, thinking=False)
        ids = clip.generate(tokens, do_sample=False, max_length=int(max_length))
        raw = str(clip.decode(ids))
        # Some frontends decode the WHOLE sequence: the instruction comes back verbatim,
        # followed by a bare "assistant" role marker, then the actual answer. Keep only
        # the answer: cut after the echoed instruction, then strip leading role tokens.
        idx = raw.rfind(mode_prompt)
        if idx != -1:
            raw = raw[idx + len(mode_prompt):]
        raw = _re.sub(r"^[\s:]*(?:<\|?im_(?:start|end)\|?>|assistant|system|user)\b[\s:]*",
                      "", raw, count=3, flags=_re.IGNORECASE)
        return _strip_think(raw)
    except Exception as e:
        print(f"[RedNode AutoPrompt] CLIP gen failed ({e}); continuing without it",
              flush=True)
        return ""


def build_prompt(mode, *, image_bytes=None, image_tensor=None, wired=(),
                 use_ollama=True, use_wd14=True, use_joy=False, use_qwen=False,
                 use_clip=False, clip=None, clip_fn=None,
                 frank=False, joy_opts=None, cache_base=None, use_cache=True, sidecar=None,
                 unload_heavy=True, joy_fn=None, qwen_fn=None, combine="append",
                 use_florence=False, florence_fn=None, florence_opts=None,
                 max_words=0, instruction="", question="",
                 model="", url=OLLAMA_URL, wd14_model="", threshold=0.35,
                 character_threshold=0.85, replace_underscore=False, exclude_tags="",
                 ollama_options=None, think=False, keep_alive=0,
                 transport=_http_json, tagger=wd14_tag):
    """One tab's auto prompt. Engines fail soft; whatever answered is combined."""
    mode = mode if mode in SYSTEM_PROMPTS else "subject"
    prompt_text = mode_prompt(mode, frank)
    # The typed instruction is an OLLAMA setting and reaches Ollama alone. The local
    # captioners are trained on their own phrasing and answer worse when handed
    # someone else's, so they keep the mode's wording no matter what is typed here.
    instruction = str(instruction or "").strip()
    ollama_text = mode_prompt(mode, frank, instruction) if instruction else prompt_text
    # the other half of the same setting: what Ollama is ASKED, not what it is told to be
    question = str(question or "").strip()
    ollama_ask = question or DEFAULT_QUESTION

    # Unbounded generation is how a caption turns into an essay, and the i2i mode
    # asks for EVERYTHING, so it is the one that runs away. Derive a token ceiling
    # from the word budget when there is one, and keep a generous backstop when
    # there is not. A number you set yourself always wins.
    ollama_options = dict(ollama_options or {})
    if not int(ollama_options.get("num_predict") or 0):
        ollama_options["num_predict"] = int(max_words * 2) if max_words else 512

    # each engine caches its OWN output, keyed on the image + the settings that change
    # its answer — never on the other engines' toggles. cache_base=None disables it.
    def part(name, extra, builder):
        def announced():
            print(f"[RedNode AutoPrompt] running {name}...", flush=True)
            t0 = _time.time()
            out = builder()
            print(f"[RedNode AutoPrompt] {name} finished in "
                  f"{_time.time() - t0:.1f}s", flush=True)
            return out

        if cache_base is None:
            return announced()
        return cached_part(list(cache_base) + [name, extra], announced, use_cache,
                           sidecar=sidecar, engine=name, mode=mode)

    paragraphs = []
    if use_ollama and model:
        # image_bytes may be a callable: resizing and re-encoding the picture is only
        # worth doing when the caption is actually going to be made, not on the way
        # to a cache hit
        def _ollama():
            data = image_bytes() if callable(image_bytes) else image_bytes
            return ollama_generate(model, ollama_text, ollama_ask,
                                   data, url, transport, options=ollama_options,
                                   think=think, keep_alive=keep_alive)

        # Both halves join the key ONLY once something is typed. Appending either
        # unconditionally would change every existing key, and since the key also
        # names the caption saved beside the image, every caption anyone had already
        # made would go unreachable at once. Untouched settings have to hash exactly
        # as they did before either existed.
        text = part("ollama", [model, ollama_options, think]
                    + ([instruction] if instruction else [])
                    + ([question] if question else []),
                    _ollama)
        if text:
            paragraphs.append(text)
    if use_joy and image_tensor is not None:
        text = part("joy", [joy_opts],
                    (lambda: joy_fn(image_tensor, prompt_text, unload_heavy))
                    if joy_fn is not None else
                    (lambda: joycaption_caption(image_tensor, prompt_text, unload_heavy,
                                                **(joy_opts or {}))))
        if text:
            paragraphs.append(text)
    if use_qwen and image_tensor is not None:
        text = part("qwen", [],
                    lambda: (qwen_fn or qwenvl_caption)(image_tensor, prompt_text, unload_heavy))
        if text:
            paragraphs.append(text)
    if use_florence and image_tensor is not None:
        fo = dict(florence_opts or {})
        text = part("florence", [fo.get("model", ""), fo.get("task", "")],
                    lambda: (florence_fn or florence_caption)(
                        image_tensor, fo.get("task") or "more_detailed_caption",
                        fo.get("model", ""), unload_heavy))
        if text:
            paragraphs.append(text)
    if use_clip and image_tensor is not None:
        text = part("clip", [],
                    lambda: (clip_fn or clipgen_caption)(clip, image_tensor, prompt_text))
        if text:
            paragraphs.append(text)
    if mode in ("subject", "people"):
        # the person's traits only, applied at use, so captions saved before this read
        # clean too; a wired caption is your own text and passes untouched
        paragraphs = [p for p in (subject_only(x) for x in paragraphs) if p]
    paragraphs.extend(str(w).strip() for w in wired if str(w or "").strip())

    tag_line = ""
    if use_wd14 and image_tensor is not None:
        tag_line = part("wd14", [wd14_model, threshold, character_threshold,
                                 replace_underscore, exclude_tags],
                        lambda: filter_tags(
                            tagger(image_tensor, wd14_model, threshold, character_threshold,
                                   replace_underscore, exclude_tags) if tagger is wd14_tag
                            else tagger(image_tensor, wd14_model, threshold), mode))

    if not paragraphs and not tag_line:
        return ""

    if combine == "blend" and use_ollama and model:
        material = "\n\n".join(paragraphs + ([f"Tags: {tag_line}"] if tag_line else []))
        blend_sys = BLEND_SYSTEM + (
            f" Keep the whole prompt under {max_words} words; drop the least important "
            "detail first." if max_words else "")
        blended = part("blend", [model, _key([material]), max_words],
                       lambda: ollama_generate(model, blend_sys, material, None, url,
                                               transport, options=ollama_options,
                                               think=think, keep_alive=keep_alive))
        if blended:
            return trim_words(blended, max_words)
        print("[RedNode AutoPrompt] blend pass failed; appending instead", flush=True)
    return trim_words(combine_append(paragraphs, tag_line), max_words)


def wd14_release():
    """Drop the tagger pack's cached ONNX sessions so their RAM comes back.

    The pack caches sessions in module-level dicts; this clears any dict in a wd14
    module whose values look like inference sessions, then collects. Fully defensive:
    a pack layout this cannot recognise simply keeps its cache.
    """
    try:
        import gc
        import sys
        for name, mod in list(sys.modules.items()):
            if "wd14" not in name.lower() or mod is None:
                continue
            for attr, val in list(vars(mod).items()):
                if isinstance(val, dict) and val and all(
                        "session" in type(v).__name__.lower() or hasattr(v, "run")
                        for v in val.values()):
                    val.clear()
        gc.collect()
    except Exception:
        pass


def caption_model_release():
    """Drop cached JoyCaption / QwenVL models the way wd14_release drops sessions.

    Those packs keep their pipeline in a module-level global so a second run is
    fast. Nothing exposes an unload, so this clears any global in one of their
    modules that looks like a loaded model, defensively: a layout it cannot
    recognise simply keeps its cache and nothing breaks.
    """
    freed = []
    try:
        import os
        import sys
        wanted = ("joy", "qwen", "florence", "llava")
        for name, mod in list(sys.modules.items()):
            low = name.lower()
            if not any(w in low for w in wanted) or mod is None:
                continue
            # only ever touch a captioner pack's own module. ComfyUI ships
            # comfy.text_encoders.qwen3vl, which matches "qwen" and is emphatically
            # not ours to empty: nulling a global in core would break the running
            # workflow, not free a captioner.
            src = getattr(mod, "__file__", "") or ""
            if "custom_nodes" not in os.path.normpath(src).split(os.sep):
                continue
            for attr, val in list(vars(mod).items()):
                if val is None or attr.startswith("__"):
                    continue
                kind = type(val).__name__.lower()
                looks_loaded = (hasattr(val, "to") and hasattr(val, "eval")) or \
                    "pipeline" in kind or "processor" in kind or "model" in kind
                if looks_loaded and not isinstance(val, type):
                    try:
                        setattr(mod, attr, None)
                        freed.append(f"{name}.{attr}")
                    except Exception:
                        pass
    except Exception as e:
        print(f"[RedNode AutoPrompt] could not sweep captioner caches ({e})", flush=True)
    return freed


def release_engines(model="", url=OLLAMA_URL):
    """Everything the auto prompt system might be holding, handed back at once.

    Ollama first (it is a separate process and the biggest single win), then the
    tagger's ONNX sessions, then any cached vision pipeline, then make the
    allocator actually return the space.
    """
    done = []
    if model:
        ollama_unload(model, url)
        done.append(f"Ollama: released {model}")
    wd14_release()
    done.append("WD14: sessions dropped")
    florence_release()
    freed = caption_model_release()
    done.append(f"vision models: {len(freed)} cached object(s) dropped"
                if freed else "vision models: nothing cached")
    free_vram()
    done.append("VRAM handed back to the allocator")
    for line in done:
        print(f"[RedNode AutoPrompt] {line}", flush=True)
    return done


def free_vram():
    """Hand freed captioner memory back to the allocator before the heavy encode runs.

    Dropping a session or model releases the tensors; this makes the CUDA cache and
    ComfyUI's own pool actually return the space, so the sampler is not fighting ghost
    allocations from a captioner that already exited.
    """
    try:
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        import comfy.model_management as mm
        mm.soft_empty_cache()
    except Exception:
        pass


# The prompt cache: PER ENGINE, and persisted to disk.
#
# Per engine, because toggling JoyCaption off and back on must reuse JoyCaption's last
# output for that image instead of re-running every engine (the old whole-prompt key
# included the toggle states, so any flip rebuilt everything). Persisted, because a
# ComfyUI restart should not cost a re-caption of every remembered image.
_cache = {}


def _cache_cap():
    """How many captions to remember, from the settings dialog."""
    try:
        from . import settings
        return max(1, int(settings.get("caption_cap", 800)))
    except Exception:
        return 800


def _cache_on():
    """Whether to reuse a caption at all."""
    try:
        from . import settings
        return bool(settings.get("caption_cache", True))
    except Exception:
        return True
_disk_loaded = False


def _cache_path(make=False):
    import os
    override = os.environ.get("KREA2RN_PROMPT_CACHE")
    if override:
        return override
    try:
        import folder_paths
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "prompt_cache.json")


def _load_disk():
    global _disk_loaded
    if _disk_loaded:
        return
    _disk_loaded = True
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, str):
                    _cache.setdefault(k, v)
    except (OSError, ValueError):
        pass


def _save_disk():
    try:
        cap = _cache_cap()
        while len(_cache) > cap:                     # oldest-first cap
            _cache.pop(next(iter(_cache)))
        with open(_cache_path(make=True), "w", encoding="utf-8") as f:
            json.dump(_cache, f, ensure_ascii=False)
    except OSError:
        pass


def _key(parts):
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


# Sidecar files: the caption lives NEXT TO the image (image.png.rn.json), so an image
# and its generated prompts travel together. The workspace passes a sidecar path for
# images inside its managed folder; everything else uses the central cache alone.
def _sidecar_read(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _sidecar_write(path, key, value, engine, mode):
    try:
        data = _sidecar_read(path)
        parts = data.setdefault("parts", {})
        parts[key] = {"engine": engine, "mode": mode, "text": value}
        import time
        data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def saved_parts(path):
    """Everything already written beside an image, newest per engine.

    The captions are stored keyed by a cache hash, which is right for lookups and
    useless for reading. This flattens them into {engine: text} so the panel can
    just show what this picture has been described as before, without running
    anything and without overwriting it.
    """
    data = _sidecar_read(path)
    out = {}
    by_mode = {}
    for entry in (data.get("parts") or {}).values():
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("text") or "").strip()
        if not text:
            continue
        eng = str(entry.get("engine") or "part")
        mode = str(entry.get("mode") or "")
        # later writes win: the file is written in order, so the last one for an
        # engine is the newest description of this picture
        out[eng] = {"text": text, "mode": mode}
        by_mode.setdefault(mode, {})[eng] = text
    return {"parts": out, "by_mode": by_mode, "updated": data.get("updated", "")}


def cached_part(key_parts, builder, use_cache=True, sidecar=None, engine="", mode=""):
    """One engine's output. use_cache False (the FRESH toggle) always rebuilds, but the
    result is STILL stored, so flipping back to reuse starts from the newest run.
    A sidecar path additionally reads and writes the part beside the image itself."""
    _load_disk()
    key = _key(key_parts)
    # the settings dialog can switch reuse off entirely; the result is still stored so
    # turning it back on starts from the newest run rather than from nothing
    if not _cache_on():
        use_cache = False
    if use_cache and key in _cache:
        print(f"[RedNode AutoPrompt] reusing the cached {engine or 'part'}", flush=True)
        return _cache[key]
    if use_cache and sidecar:
        hit = (_sidecar_read(sidecar).get("parts") or {}).get(key)
        if isinstance(hit, dict) and hit.get("text"):
            _cache[key] = hit["text"]
            print(f"[RedNode AutoPrompt] reusing the {engine or 'part'} saved beside "
                  "the image", flush=True)
            return hit["text"]
    if not use_cache:
        print(f"[RedNode AutoPrompt] {engine or 'this part'} is set to FRESH, so it "
              "runs again every queue", flush=True)
    value = builder()
    if value:
        _cache[key] = value
        _save_disk()
        if sidecar:
            _sidecar_write(sidecar, key, value, engine, mode)
    return value


def cached_prompt(key_parts, builder):
    """Whole-result cache, kept for the callers that want it (in-memory semantics)."""
    key = _key(key_parts)
    if key not in _cache:
        _cache[key] = builder()
        if len(_cache) > _cache_cap():
            _cache.pop(next(iter(_cache)))
    return _cache[key]
