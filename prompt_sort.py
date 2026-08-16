"""Auto-sort: a prompt reorganised into the Prompt Frame's boxes, by Ollama.

The user's ask (2026-08-17): the auto prompt already leans on the local Ollama
server; the same engine can read what is written across Style, Subject,
Surroundings and Light & colour, and put every phrase into the box it belongs
in - one button that tidies a prompt somebody typed as a lump.

Contract:
  - the model may MOVE and lightly TIDY phrases, never invent content and
    never drop it: every idea in goes to some box out
  - Style and Lighting may name a preset from the frame's own dropdown lists
    ONLY when the text clearly says so; otherwise they stay untouched
  - strict JSON out; anything else is a soft failure and the frame stays as
    it was, with one console line saying why
"""
import json

try:
    from . import autoprompt as _ap
    from .style_library import CHOICES as STYLE_CHOICES
    from .prompt_lists import LIGHTING_CHOICES
except ImportError:  # loaded as a plain file (tests)
    import autoprompt as _ap
    from style_library import CHOICES as STYLE_CHOICES
    from prompt_lists import LIGHTING_CHOICES

FIELDS = ("subject", "surroundings", "style_extra", "light_and_colour", "placement")

SYSTEM = """You reorganise an image prompt into labelled boxes. You are a sorter, not a writer.

Boxes:
- subject: who or what the picture is of, and how they look (person, clothes, expression, pose, objects that are the point).
- surroundings: where it is - the place, the environment, background elements, weather.
- style_extra: how the picture is MADE - medium, rendering, camera/lens words, film stock, art style wording.
- light_and_colour: lighting mood, time of day light, colour palette, tonal mood.
- placement: where the subject stands IN the scene, as one short phrase (e.g. "standing at the water's edge"), or empty.

Rules:
1. Every phrase from the input must land in exactly one box. Do not invent anything. Do not drop anything.
2. Keep the writer's wording; you may split, merge and lightly punctuate, nothing more.
3. If the input clearly names a style from this list, put its exact name in "style" (else ""): %s
4. If the input clearly names a lighting from this list, put its exact name in "lighting" (else ""): %s
5. Answer with ONLY a JSON object with keys: subject, surroundings, style_extra, light_and_colour, placement, style, lighting. Strings only. No commentary, no markdown fences."""


def _system():
    styles = ", ".join(str(s) for s in STYLE_CHOICES if str(s).lower() != "none")
    lights = ", ".join(str(l) for l in LIGHTING_CHOICES if str(l).lower() != "none")
    return SYSTEM % (styles, lights)


def _extract_json(text):
    """The first {...} object in a reply; models like to wrap it in prose."""
    text = str(text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    a = text.find("{")
    b = text.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("no JSON object in the reply")
    return json.loads(text[a:b + 1])


def sort_fields(fields, model, url=_ap.OLLAMA_URL, transport=None, generate=None):
    """fields: dict of the frame's text boxes -> a dict of sorted boxes, or None.

    `generate` may be injected (tests); it takes (model, system, prompt) and
    returns the reply text. Returns None on any failure, having printed why.
    """
    lump = "\n".join("%s: %s" % (k, str(fields.get(k) or "").strip())
                     for k in FIELDS if str(fields.get(k) or "").strip())
    if not lump.strip():
        print("[RedNode Prompt Sort] nothing to sort", flush=True)
        return None
    gen = generate or (lambda m, s, p: _ap.ollama_generate(
        m, s, p, url=url, options={"temperature": 0.1, "num_predict": 700},
        keep_alive=0, **({"transport": transport} if transport else {})))
    reply = gen(model, _system(), "Input boxes as currently filled (some may be "
                                  "wrong or lumped together):\n\n" + lump
                                  + "\n\nReturn the JSON.")
    if not reply:
        print("[RedNode Prompt Sort] the model returned nothing", flush=True)
        return None
    try:
        data = _extract_json(reply)
    except Exception as exc:
        print("[RedNode Prompt Sort] could not read the reply (%s): %r"
              % (exc, str(reply)[:200]), flush=True)
        return None
    out = {}
    for k in FIELDS:
        v = data.get(k, "")
        out[k] = str(v).strip() if isinstance(v, (str, int, float)) else ""
    # the presets: only an EXACT name from the lists is honoured
    st = str(data.get("style") or "").strip()
    lt = str(data.get("lighting") or "").strip()
    out["style"] = st if st in [str(x) for x in STYLE_CHOICES] else ""
    out["lighting"] = lt if lt in [str(x) for x in LIGHTING_CHOICES] else ""
    # nothing lost: if the sorter emptied every text box, refuse the result
    if not any(out[k] for k in FIELDS):
        print("[RedNode Prompt Sort] the reply had no text in any box; keeping "
              "the frame as it was", flush=True)
        return None
    return out


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/prompt_sort")
    async def _rn_prompt_sort(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        model = str(body.get("model") or "").strip()
        url = str(body.get("url") or _ap.OLLAMA_URL)
        if not model:
            return web.json_response(
                {"error": "no Ollama model chosen: pick one on the Auto Prompt "
                          "section (any tab) first"}, status=400)
        import asyncio
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: sort_fields(body.get("fields") or {}, model, url=url))
        if result is None:
            return web.json_response(
                {"error": "the sorter could not produce a result; the console "
                          "says why"}, status=502)
        return web.json_response({"fields": result})
except Exception as _e:
    print("[RedNode Prompt Sort] route not registered: %s" % _e, flush=True)
