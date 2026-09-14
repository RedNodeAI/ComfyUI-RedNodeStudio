"""RedNode Describe To Boxes — an image in, Prompt Frame's boxes out.

The split is done by the captioner while it is still looking at the image, not by a
classifier afterwards. That choice is measured: a keyword splitter over clauses left 21.7%
unsorted and stole subject clauses that happened to mention light ("the cat's silhouette
remains a dark, soft-edged shadow" was filed under lighting). Asking for labelled sections
up front scored 100% format compliance over 30 captions across eight unrelated image
types, at about a second each. See Comfy Development/projects/prompt-corpus/
AUTOPROMPT_SPLIT.md.

No word is rewritten here. The model writes the sections; this module only cuts them apart
on the labels and hands them to the right box.

Engine work is delegated to autoprompt.py, which already owns Ollama, QwenVL, JoyCaption
and WD14 and already releases the model on keep_alive=0.
"""

import re

SECTIONS = ["SUBJECT", "SURROUNDINGS", "LIGHT", "COLOUR", "MOOD"]

# The wording that tested best (v4). The load-bearing line is the one about light: it is
# exactly the failure that killed the keyword splitter.
SPLIT_INSTRUCTION = (
    "Sort what you see in this image into exactly five labelled sections, in this order, "
    "each on its own line:\n"
    "SUBJECT: the main thing only. What it is, what it is wearing or made of, its pose, "
    "its expression, its own colours and materials.\n"
    "SURROUNDINGS: the place only. The setting, the background, the objects near it.\n"
    "LIGHT: where the light comes from, its direction and how hard or soft it is.\n"
    "COLOUR: the overall palette in a few words.\n"
    "MOOD: the feeling, in a few words.\n"
    "Rules. Every label appears exactly once and is never empty. If the main thing is lit "
    "or shadowed, that belongs in LIGHT, not SUBJECT. Do not name the place in SUBJECT. "
    "Write nothing before SUBJECT and nothing after the MOOD line. No bullets, no "
    "markdown, no preamble.")

# Ollama looks at the picture itself. Florence + Ollama has Florence-2 (kijai's
# pack) write the caption and Ollama, text only, sort it into the sections: the
# eyes and the words split the way Lonecat's flow splits them.
ENGINES = ["Ollama", "Florence + Ollama"]

TEXT_SPLIT_INSTRUCTION = SPLIT_INSTRUCTION.replace(
    "what you see in this image", "this description of an image")


def florence_then_sort(image_tensor, model, instruction, max_tokens, seed):
    """Florence-2 captions the picture; Ollama sorts the caption. Returns
    (raw_reply, notice) with the caption itself when nothing can sort it."""
    try:
        from .autoprompt import florence_caption, ollama_generate
    except ImportError:
        from autoprompt import florence_caption, ollama_generate
    caption = florence_caption(image_tensor, "more_detailed_caption", "", True)
    if not caption.strip():
        return "", "Florence-2 returned nothing (is comfyui-florence2 installed?)."
    if not model or model.startswith("("):
        return "SUBJECT: " + caption, "Florence-2 captioned; no Ollama to sort it, so the caption is in subject."
    text_instruction = (TEXT_SPLIT_INSTRUCTION if instruction == SPLIT_INSTRUCTION
                        else instruction)
    raw = ollama_generate(model, "", text_instruction + "\n\nDescription: " + caption,
                          options={"seed": seed, "num_predict": max_tokens,
                                   "temperature": 0.2}) or ""
    return raw, ""


def parse_sections(text):
    """Cut the reply on its labels. Returns (sections, problems) and never raises."""
    text = text or ""
    out, problems = {}, []
    for i, name in enumerate(SECTIONS):
        nxt = SECTIONS[i + 1] if i + 1 < len(SECTIONS) else None
        pattern = (r"%s\s*:\s*(.*?)(?=\n\s*%s\s*:|$)" % (name, nxt) if nxt
                   else r"%s\s*:\s*(.*)$" % name)
        m = re.search(pattern, text, re.S | re.I)
        value = " ".join(m.group(1).split()) if m else ""
        # a model that runs on can bleed the next label into this one
        value = re.split(r"\b(?:%s)\s*:" % "|".join(SECTIONS), value, 1, re.I)[0].strip()
        if not m:
            problems.append("no %s section" % name)
        elif not value:
            problems.append("%s was empty" % name)
        out[name] = value
    head = re.split(r"SUBJECT\s*:", text, 1, re.I)[0].strip()
    if len(head) > 4:
        problems.append("the model wrote a preamble before SUBJECT")
    return out, problems


def to_boxes(sections):
    """Five sections onto the three Prompt Frame text boxes. Light, colour and mood all
    land together because the node treats them as one order-insensitive block."""
    light = ". ".join(s for s in (sections.get("LIGHT", ""), sections.get("COLOUR", ""),
                                  sections.get("MOOD", "")) if s)
    return {
        "subject": sections.get("SUBJECT", ""),
        "surroundings": sections.get("SURROUNDINGS", ""),
        "light_and_colour": light,
    }


def _jpeg_bytes(image_tensor, max_edge=1024):
    """ComfyUI IMAGE tensor (B,H,W,C float 0-1) to JPEG bytes for the vision API."""
    from io import BytesIO

    import numpy as np
    from PIL import Image

    arr = image_tensor
    if hasattr(arr, "cpu"):
        arr = arr.cpu().numpy()
    arr = np.asarray(arr)
    if arr.ndim == 4:
        arr = arr[0]
    im = Image.fromarray(np.clip(arr * 255.0, 0, 255).astype("uint8"))
    if max(im.size) > max_edge:
        scale = max_edge / max(im.size)
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                       Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, format="JPEG", quality=90, optimize=True)
    return buf.getvalue()


def _ollama_models():
    try:
        try:
            from .autoprompt import ollama_models
        except ImportError:
            from autoprompt import ollama_models
        names = list(ollama_models() or [])
        return names or ["(no ollama models found)"]
    except Exception:
        return ["(ollama unavailable)"]


class RedNodeDescribeToBoxes:
    """Describe an image straight into Subject / Surroundings / Light and colour."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "The picture to describe."}),
                "engine": (ENGINES, {
                    "default": ENGINES[0],
                    "tooltip": "Which captioner does the describing. Ollama is the only "
                               "one verified so far; the ComfyUI QwenVL nodes currently "
                               "cannot execute (their process() wants an argument their "
                               "INPUT_TYPES never declares)."}),
                "model": (_ollama_models(), {
                    "tooltip": "A vision model. Anything that follows instructions will "
                               "do; tested on qwen3-vl 8b instruct at Q4."}),
                "instruction": ("STRING", {
                    "multiline": True, "default": SPLIT_INSTRUCTION, "dynamicPrompts": False,
                    "tooltip": "What the captioner is asked for. The default is the "
                               "wording that scored 100% on format across 30 captions. "
                               "Change the section names here and the parser will not "
                               "find them."}),
                "max_tokens": ("INT", {
                    "default": 420, "min": 64, "max": 2048,
                    "tooltip": "Upper bound on the reply. Too low truncates MOOD."}),
                "seed": ("INT", {
                    "default": 1, "min": 0, "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                    "tooltip": "Same seed gives the same description."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("subject", "surroundings", "light_and_colour", "raw", "notice")
    FUNCTION = "run"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("Describes an image into labelled sections and hands them to the Prompt "
                   "Frame boxes. Wire subject/surroundings/light_and_colour into the "
                   "matching inputs on RedNode Prompt Frame.")

    def run(self, image, engine, model, instruction, max_tokens, seed):
        if engine == "Florence + Ollama":
            raw, notice = florence_then_sort(image, model, instruction, max_tokens, seed)
            if not raw.strip():
                return ("", "", "", "", notice or "The captioner returned nothing.")
            sections, problems = parse_sections(raw)
            boxes = to_boxes(sections)
            if not notice:
                notice = ("; ".join(problems) if problems
                          else "Described into %d words." % len(raw.split()))
            return (boxes["subject"], boxes["surroundings"], boxes["light_and_colour"],
                    raw, notice)
        if model.startswith("("):
            return ("", "", "", "", "No vision model available. Is Ollama running?")
        try:
            try:
                from .autoprompt import ollama_generate
            except ImportError:
                from autoprompt import ollama_generate
        except Exception as exc:
            return ("", "", "", "", "Could not load the caption engine: %s" % exc)

        try:
            blob = _jpeg_bytes(image)
        except Exception as exc:
            return ("", "", "", "", "Could not read the image: %s" % exc)

        # keep_alive defaults to 0 in ollama_generate, which releases the model's VRAM as
        # soon as the reply lands. Measured: 12350 MiB down to 2778 MiB, nothing held.
        raw = ollama_generate(model, "", instruction, image_bytes=blob,
                              options={"seed": seed, "num_predict": max_tokens,
                                       "temperature": 0.2}) or ""
        if not raw.strip():
            return ("", "", "", "", "The captioner returned nothing.")

        sections, problems = parse_sections(raw)
        boxes = to_boxes(sections)
        notice = ("; ".join(problems) if problems
                  else "Described into %d words." % len(raw.split()))
        return (boxes["subject"], boxes["surroundings"], boxes["light_and_colour"],
                raw, notice)


# ---------------------------------------------------------------------------
# HTTP: describe an input image straight into Frame slots, for the Prompts tab.
# The same split instruction and parser the node uses, the wording that scored
# 100% on format across 30 captions, so the tab and the node cannot drift.
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/describe_frame")
    async def _rednode_describe_frame(request):
        import asyncio
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        entry = str(data.get("entry") or "")
        if not entry:
            return web.json_response({"error": "no image chosen"}, status=400)

        def work():
            from .workspace import load_image
            img = load_image(entry, 1024)
            models = _ollama_models()
            model = str(data.get("model") or models[0])
            engine = str(data.get("engine") or ENGINES[0])
            if engine not in ENGINES:
                engine = ENGINES[0]
            try:
                seed = int(data.get("seed", 0))
            except (TypeError, ValueError):
                seed = 0
            subject, surroundings, lac, _raw, notice = RedNodeDescribeToBoxes().run(
                img, engine, model, SPLIT_INSTRUCTION, 400, max(0, seed))
            return {"subject": subject, "surroundings": surroundings,
                    "light_and_colour": lac, "notice": notice}
        try:
            out = await asyncio.get_event_loop().run_in_executor(None, work)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(out)
except Exception:  # no server (tests, headless import)
    pass
