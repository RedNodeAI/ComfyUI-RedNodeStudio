"""RedNode Save — filing, with a record you can actually read.

Two problems this solves.

Filing. SaveImage writes everything into one folder with a counter, which is fine
until there are four hundred of them. Here the folder, the subfolder, the name and
the numbering are separate settings on a panel, and there is a drafts and keepers
split, because which images matter is something you learn after looking at them.

The record. A PNG's embedded workflow is a ComfyUI-shaped blob: it does not survive
the trip to Forge Neo, it cannot be read without loading the image into something,
and it is useless to a person scanning a folder. So every image can also get a plain
text file next to it with the prompts and the settings laid out for reading, by a
human or by a model. The PNG metadata still goes in, for drag-back. The text file is
the portable copy.

Nothing in here reads any file the user already had. It writes.
"""

import json
import os
import re
import shutil
import sys
import time

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

DRAFTS = "drafts"
KEEPERS = "keepers"

# What the last runs wrote, so the panel can offer to promote them. A convenience,
# not a database, so it is capped.
LAST_SAVED = []
MAX_REMEMBERED = 200

DEFAULTS = {
    "root": "",                  # base folder under ComfyUI/output; blank = the root
    "subfolder": "%date%/%preset%",
    "name": "%date%_%time%",
    "numbering": "counter",      # counter | time | seed | none
    "pad": 4,
    "split_drafts": True,        # drafts and keepers subfolders
    "keep": False,
    "write_text": True,          # the readable .txt
    "write_json": False,         # the machine-readable .rn.json
    "embed_png": True,           # the usual ComfyUI workflow blob, for drag-back
    "prompts_folder": "",        # optional second home for every text file
    "format": "png",             # png | jpeg | webp
    "quality": 90,               # jpeg and webp only; png is lossless
    "compress": 4,               # png only: 0..9, file size against save time
}

NUMBERING = ("counter", "time", "seed", "none")
FORMATS = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}

TOKENS = ("%date%", "%time%", "%year%", "%month%", "%day%",
          "%preset%", "%seed%", "%model%", "%w%", "%h%", "%size%")

# Naming conventions worth starting from. These ship built in and cannot be deleted;
# anything the user saves lives beside them and can be.
BUILTIN_PRESETS = {
    "Date and time": {"subfolder": "%date%", "name": "%date%_%time%",
                      "numbering": "counter", "pad": 4},
    "Date, then preset": {"subfolder": "%date%/%preset%", "name": "%date%_%time%",
                          "numbering": "counter", "pad": 4},
    "Preset, then date": {"subfolder": "%preset%/%date%", "name": "%preset%_%seed%",
                          "numbering": "counter", "pad": 3},
    "By model": {"subfolder": "%model%/%date%", "name": "%model%_%size%",
                 "numbering": "counter", "pad": 4},
    "Seed in the name": {"subfolder": "%date%", "name": "%date%_%seed%",
                         "numbering": "none", "pad": 4},
    "Just numbered": {"subfolder": "", "name": "image", "numbering": "counter",
                      "pad": 5},
}

# only the naming half of the config travels in a preset. Where the files go, and
# what gets written beside them, are separate decisions and stay put.
PRESET_KEYS = ("subfolder", "name", "numbering", "pad")


def _presets_path(make=False):
    override = os.environ.get("KREA2RN_SAVE_PRESETS")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "save_presets.json")


def load_presets():
    """The user's saved naming conventions, keyed by name."""
    try:
        with open(_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        presets = data.get("presets") if isinstance(data, dict) else None
        return {str(k): {p: v[p] for p in PRESET_KEYS if p in v}
                for k, v in (presets or {}).items() if isinstance(v, dict)}
    except (OSError, ValueError, TypeError):
        return {}


def save_preset(name, cfg):
    name = str(name or "").strip()
    if not name:
        raise ValueError("give the preset a name")
    if name in BUILTIN_PRESETS:
        raise ValueError(f"{name!r} is a built-in name; pick another")
    full = parse_config(cfg)
    presets = load_presets()
    presets[name] = {k: full[k] for k in PRESET_KEYS}
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)
    return presets[name]


def delete_preset(name):
    presets = load_presets()
    if str(name) not in presets:
        raise ValueError("no preset by that name")
    presets.pop(str(name))
    with open(_presets_path(make=True), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "presets": presets}, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# config
def parse_config(raw):
    """Normalise the panel's JSON. Anything missing or wrong falls back to a default."""
    data = raw if isinstance(raw, dict) else {}
    if isinstance(raw, str):
        try:
            data = json.loads(raw or "{}")
        except (ValueError, TypeError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    out = dict(DEFAULTS)
    for key, default in DEFAULTS.items():
        if key not in data:
            continue
        value = data[key]
        if isinstance(default, bool):
            out[key] = bool(value)
        elif isinstance(default, int):
            lo, hi = (1, 100) if key == "quality" else (0, 9)
            try:
                out[key] = max(lo, min(hi, int(value)))
            except (TypeError, ValueError):
                pass
        else:
            out[key] = str(value or "")
    if out["numbering"] not in NUMBERING:
        out["numbering"] = "counter"
    if out["format"] not in FORMATS:
        out["format"] = "png"
    return out


def _slug(text, fallback="none"):
    """A path-safe fragment.

    Percent survives on purpose, so a token nobody recognises stays readable in the
    name and a typo shows itself instead of quietly becoming a plausible folder.
    """
    out = re.sub(r"[^A-Za-z0-9 _.%-]+", "_", str(text or "")).strip(" ._")
    out = re.sub(r"\s+", " ", out)
    return out[:60] or fallback


def resolve(text, ctx):
    """Fill the tokens in one fragment. Unknown tokens are left visible."""
    t = time.localtime(ctx.get("when") or time.time())
    values = {
        "%date%": time.strftime("%Y-%m-%d", t),
        "%time%": time.strftime("%H%M%S", t),
        "%year%": time.strftime("%Y", t),
        "%month%": time.strftime("%m", t),
        "%day%": time.strftime("%d", t),
        "%preset%": _slug(ctx.get("preset"), "no preset"),
        "%seed%": str(ctx.get("seed")) if ctx.get("seed") is not None else "noseed",
        "%model%": _slug(os.path.splitext(str(ctx.get("model") or ""))[0], "model"),
        "%w%": str(ctx.get("width", 0)),
        "%h%": str(ctx.get("height", 0)),
        "%size%": f"{ctx.get('width', 0)}x{ctx.get('height', 0)}",
    }
    out = str(text or "")
    for token, value in values.items():
        out = out.replace(token, value)
    return out


def build_path(cfg, ctx):
    """The folder and the filename stem, both resolved and made safe."""
    parts = []
    for chunk in (cfg["root"], ):
        for piece in resolve(chunk, ctx).replace("\\", "/").split("/"):
            if piece.strip():
                parts.append(_slug(piece, ""))
    if cfg["split_drafts"]:
        parts.append(KEEPERS if ctx.get("keep") else DRAFTS)
    for piece in resolve(cfg["subfolder"], ctx).replace("\\", "/").split("/"):
        if piece.strip():
            parts.append(_slug(piece, ""))
    folder = "/".join(p for p in parts if p)
    stem = _slug(resolve(cfg["name"], ctx), "image")
    return folder, stem


def final_path(base_dir, folder, stem, cfg, ctx):
    """Where this image actually goes, numbering applied, never overwriting."""
    ext = FORMATS.get(cfg.get("format", "png"), ".png")
    directory = os.path.join(base_dir, *[p for p in folder.split("/") if p])
    os.makedirs(directory, exist_ok=True)
    mode = cfg["numbering"]
    pad = cfg["pad"]

    if mode == "time":
        stem = f"{stem}_{time.strftime('%H%M%S', time.localtime(ctx.get('when')))}"
    elif mode == "seed":
        stem = f"{stem}_{ctx.get('seed') if ctx.get('seed') is not None else 'noseed'}"
    elif mode == "counter":
        n = 1
        used = re.compile(re.escape(stem) + r"_(\d+)" + re.escape(ext) + r"$", re.I)
        try:
            for name in os.listdir(directory):
                m = used.match(name)
                if m:
                    n = max(n, int(m.group(1)) + 1)
        except OSError:
            pass
        stem = f"{stem}_{n:0{pad}d}"

    candidate = os.path.join(directory, stem + ext)
    if not os.path.exists(candidate):
        return candidate
    n = 2
    while os.path.exists(os.path.join(directory, f"{stem}_{n:03d}{ext}")):
        n += 1
    return os.path.join(directory, f"{stem}_{n:03d}{ext}")


# ---------------------------------------------------------------------------
# reading the queued graph
def _source(prompt, node, key):
    """Follow one input back to the node feeding it, or None."""
    link = (node.get("inputs") or {}).get(key)
    if isinstance(link, list) and link and isinstance(prompt.get(str(link[0])), dict):
        return prompt[str(link[0])]
    return None


# input names that hold words, best first
TEXT_FIELDS = ("text", "prompt", "instruction", "text_g", "string", "value")


def _text_behind(prompt, node, key, depth=0, seen=None):
    """Walk back from a conditioning input until something holds actual words.

    Encoders, style nodes, combiners and prompt boxes all sit between the sampler and
    the words, and every workflow stacks them differently, so this follows the chain
    rather than assuming a shape.

    It follows EVERY wired input rather than a list of names. The earlier version had
    a hardcoded set that did not include `instruction`, which is exactly what RedNode
    Studio calls its prompt, so a wired prompt was never found: the walk stopped at
    the studio node and reported nothing.
    """
    src = _source(prompt, node, key)
    if src is None:
        return ""
    return _text_of(prompt, src, depth, seen)


def _input_text(prompt, node, key, depth, seen):
    """A string input as it will reach a node, whether typed or wired."""
    value = (node.get("inputs") or {}).get(key)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        # Each combiner row is independent. Copying the ancestry set preserves a
        # deliberate duplicate when the same source feeds two rows.
        return _text_behind(prompt, node, key, depth + 1, set(seen or ()))
    return ""


def _prompt_combine_text(prompt, node, depth=0, seen=None):
    """Reconstruct RedNode Prompt Combine exactly from its queued inputs.

    The modern panel stores its row order/on-state/typed text in config and receives
    wires (including channel subscriptions) as part_N. The older reader only joined
    text_N, so a perfectly available channel-built prompt looked unavailable.
    """
    inputs = node.get("inputs") or {}
    try:
        from .prompt_tools import _apply_order
        from .text_combine import join_parts, parse_config
    except ImportError:
        return ""

    config = _input_text(prompt, node, "config", depth, seen)
    panel = parse_config(config)
    separator = (
        _input_text(prompt, node, "separator", depth, seen)
        if "separator" in inputs else ", "
    )

    if panel["parts"]:
        merged = {}
        for key in inputs:
            if re.fullmatch(r"part_\d+", str(key)):
                merged[str(key)] = _input_text(prompt, node, key, depth, seen)
        merged.setdefault("part_1", _input_text(prompt, node, "text_1", depth, seen))
        merged.setdefault("part_2", _input_text(prompt, node, "text_2", depth, seen))
        order = _input_text(prompt, node, "order", depth, seen)
        return join_parts(_apply_order(panel, merged, order), merged, separator)

    numbered = sorted(
        (str(key) for key in inputs if re.fullmatch(r"text_\d+", str(key))),
        key=lambda key: int(key.split("_")[1]),
    )
    parts = [_input_text(prompt, node, key, depth, seen) for key in numbered]
    order = _input_text(prompt, node, "order", depth, seen).strip()
    if order:
        try:
            chosen = [
                int(piece)
                for piece in order.replace(";", ",").split(",")
                if piece.strip()
            ]
        except ValueError:
            chosen = []
        if chosen and all(1 <= n <= len(parts) for n in chosen):
            parts = [parts[n - 1] for n in chosen] + [
                part for n, part in enumerate(parts, 1) if n not in chosen
            ]
    sep = separator.replace("\\n", "\n")
    return sep.join(part.strip() for part in parts if part and part.strip())


def _text_of(prompt, src, depth=0, seen=None):
    """The words a node holds, following its wired inputs when it holds none itself."""
    if depth > 12:
        return ""
    seen = seen if seen is not None else set()
    marker = id(src)
    if marker in seen:
        return ""                     # a graph can loop back; do not chase it forever
    seen.add(marker)

    inputs = src.get("inputs") or {}

    if src.get("class_type") == "RedNodePromptCombine":
        combined = _prompt_combine_text(prompt, src, depth, seen)
        if combined:
            return combined

    # A combiner holds the prompt in pieces (text_1, text_2, ...), so taking the first
    # one would report a fragment as if it were the whole prompt. Assemble it instead,
    # in the order the node names them, using its own separator when it has one.
    numbered = sorted((f for f in inputs if re.fullmatch(r"text_\d+", str(f))),
                      key=lambda f: int(str(f).split("_")[1]))
    if numbered:
        sep = inputs.get("separator")
        sep = sep if isinstance(sep, str) else ", "
        parts = []
        for field in numbered:
            value = inputs.get(field)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
            elif isinstance(value, list):
                found = _text_behind(prompt, src, field, depth + 1, seen)
                if found:
                    parts.append(found)
        if parts:
            return sep.join(parts)

    for field in TEXT_FIELDS:
        value = inputs.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    # text-shaped names first, then anything else that is wired
    ordered = ([f for f in TEXT_FIELDS if isinstance(inputs.get(f), list)]
               + [f for f, v in inputs.items()
                  if isinstance(v, list) and f not in TEXT_FIELDS])
    for field in ordered:
        found = _text_behind(prompt, src, field, depth + 1, seen)
        if found:
            return found
    return ""


def flagged_prompt(prompt):
    """The text of a node flagged as the final prompt, if there is one.

    Tracing back from the sampler finds the right words on its own, so this is not
    normally needed. It exists for the workflow with several combiners, where naming
    the winner is easier than reasoning about which branch won.
    """
    if not isinstance(prompt, dict):
        return ""
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        if (node.get("inputs") or {}).get("is_final_prompt"):
            found = _text_of(prompt, node)
            if found:
                return found
    return ""


def collect_meta(prompt, ctx):
    """Everything worth writing down, pulled out of the queued graph."""
    meta = {"positive": "", "negative": "", "model": "", "loras": [],
            "sampler": {}, "preset": ctx.get("preset") or "", "seed": ctx.get("seed"),
            "post": [], "tabs": [], "dials": {}, "negative_note": ""}
    if not isinstance(prompt, dict):
        return meta

    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}

        if "KSampler" in cls or "SamplerCustom" in cls:
            for key, field in (("steps", "steps"), ("cfg", "cfg"),
                               ("sampler_name", "sampler"), ("scheduler", "scheduler"),
                               ("denoise", "denoise")):
                if isinstance(inputs.get(key), (int, float, str)):
                    meta["sampler"].setdefault(field, inputs[key])
            for key in ("seed", "noise_seed"):
                if isinstance(inputs.get(key), (int, float)) \
                        and not isinstance(inputs.get(key), bool):
                    meta["seed"] = meta["seed"] if meta["seed"] is not None \
                        else int(inputs[key])
            if not meta["positive"]:
                meta["positive"] = _text_behind(prompt, node, "positive")
            if not meta["negative"] and not meta["negative_note"]:
                # A node that outputs BOTH sides, like RedNode Studio, has one set of
                # words on it: the instruction, which belongs to the positive. Tracing
                # the negative back lands on that same node and would report the
                # positive prompt as if it were the negative. It is not: the studio
                # encodes its negative with an empty prompt and the same references,
                # which is the grounded unconditional the edit model expects.
                pos_link = inputs.get("positive")
                neg_link = inputs.get("negative")
                same_node = (isinstance(pos_link, list) and isinstance(neg_link, list)
                             and pos_link and neg_link
                             and str(pos_link[0]) == str(neg_link[0]))
                if same_node:
                    src = _source(prompt, node, "negative") or {}
                    meta["negative_note"] = (
                        "grounded negative from "
                        f"{src.get('class_type') or 'the same node'}: an empty prompt "
                        "with the same references, not a written negative")
                else:
                    meta["negative"] = _text_behind(prompt, node, "negative")

        if "CheckpointLoader" in cls or "UNETLoader" in cls:
            for key in ("ckpt_name", "unet_name"):
                if isinstance(inputs.get(key), str):
                    meta["model"] = meta["model"] or inputs[key]

        if "LoraLoader" in cls:
            name = inputs.get("lora_name")
            if isinstance(name, str):
                strength = inputs.get("strength_model", inputs.get("strength"))
                meta["loras"].append({"name": name, "strength": strength})

        if cls == "RedNodeLoraStack":
            meta["loras"].extend(_slots_from(inputs.get("stack_json")))

        if cls == "RedNodeStudioWorkspace":
            raw = inputs.get("config")
            try:
                wcfg = json.loads(raw) if isinstance(raw, str) else {}
            except (ValueError, TypeError):
                wcfg = {}
            if isinstance(wcfg, dict):
                # merge, do not replace: a graph can carry both a standalone stack
                # node and the Workspace's own LoRAs tab, and update() would drop
                # whichever was collected first
                extra = _from_workspace(wcfg)
                meta["loras"].extend(extra.pop("loras", []))
                meta.update(extra)

    # a node that says it holds the final prompt is believed over the trace
    flagged = flagged_prompt(prompt)
    if flagged:
        meta["positive"] = flagged

    # The backstop, and the one that actually holds up. Comparing the sampler's two
    # link origins only catches a studio wired straight in; route either side through
    # a Set/Get pair or a switch and the origins differ while both still trace back to
    # the same instruction. Nobody writes an identical positive and negative, so if
    # they came out the same, the trace found one prompt twice.
    if meta["negative"] and meta["negative"] == meta["positive"]:
        meta["negative"] = ""
        if not meta["negative_note"]:
            meta["negative_note"] = (
                "grounded negative: an empty prompt with the same references, not a "
                "written negative (the positive was traced through both inputs)")

    # de-duplicate: the same LoRA can arrive from the stack node and the Workspace tab
    seen_loras, unique = set(), []
    for lora in meta["loras"]:
        key = (lora.get("name"), lora.get("strength"))
        if key in seen_loras:
            continue
        seen_loras.add(key)
        unique.append(lora)
    meta["loras"] = unique
    return meta


def _slots_from(raw):
    """Enabled LoRAs out of a stack's hidden JSON.

    The slot key is `enabled`, not `on`. Getting that wrong is silent: every stack
    reads as empty and the record simply has no LoRAs in it, which is what happened.
    """
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (ValueError, TypeError):
        return []
    out = []
    for slot in (data.get("slots") or []) if isinstance(data, dict) else []:
        if not isinstance(slot, dict) or slot.get("type") == "title":
            continue
        name = str(slot.get("name") or "")
        if not name or name.lower() in ("none", "no lora", ""):
            continue
        if not slot.get("enabled", slot.get("on", False)):
            continue
        out.append({"name": name, "strength": slot.get("strength")})
    return out


def _from_workspace(cfg):
    """What the Studio Workspace can tell us that the graph alone cannot.

    It already carries the preset, the LoRA tab, the grading chain and which image
    tabs were in play, so the record can have all of it without another wire.
    """
    out = {}
    preset = cfg.get("studio_preset") or cfg.get("preset")
    if preset:
        out["preset"] = preset
    loras = cfg.get("loras") if isinstance(cfg.get("loras"), dict) else {}
    if loras.get("on", True):
        found = _slots_from(loras)
        if found:
            out["loras"] = found
    post = cfg.get("post") if isinstance(cfg.get("post"), dict) else {}
    on = [name for name, block in post.items()
          if isinstance(block, dict) and block.get("on")]
    if on:
        out["post"] = on
    tabs = cfg.get("tabs") if isinstance(cfg.get("tabs"), dict) else {}
    used = [name for name, tab in tabs.items()
            if isinstance(tab, dict) and tab.get("on") and tab.get("images")]
    if used:
        out["tabs"] = used
    dials = cfg.get("dials") if isinstance(cfg.get("dials"), dict) else {}
    if dials and cfg.get("use_dials", True):
        out["dials"] = dials
    return out


# ---------------------------------------------------------------------------
# the readable record
def render_text(meta, ctx, image_name):
    """A plain text record. Written for a person first, and it parses fine anyway.

    Deliberately not JSON and deliberately not the PNG blob. Both of those need a
    tool to read, and neither survives moving an image between ComfyUI and Forge Neo.
    """
    lines = []

    def block(title, body):
        if not body:
            return
        lines.append(title)
        lines.append("-" * len(title))
        lines.append(str(body).strip())
        lines.append("")

    lines.append(image_name)
    lines.append("=" * len(image_name))
    lines.append("")
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ctx.get("when")))
    head = [f"Saved     {stamp}", f"Size      {ctx.get('width')} x {ctx.get('height')}"]
    if meta.get("model"):
        head.append(f"Model     {meta['model']}")
    if meta.get("preset"):
        head.append(f"Preset    {meta['preset']}")
    if meta.get("seed") is not None:
        head.append(f"Seed      {meta['seed']}")
    lines.extend(head)
    lines.append("")

    block("Positive prompt", meta.get("positive"))
    block("Negative prompt", meta.get("negative") or meta.get("negative_note"))

    sampler = meta.get("sampler") or {}
    if sampler:
        rows = [f"{k.capitalize():<10}{v}" for k, v in sampler.items()]
        block("Sampler", "\n".join(rows))

    if meta.get("loras"):
        rows = []
        for lora in meta["loras"]:
            strength = lora.get("strength")
            rows.append(f"{lora['name']}"
                        + (f"  at {strength}" if strength is not None else ""))
        block("LoRAs", "\n".join(rows))

    if meta.get("tabs"):
        block("Studio inputs", ", ".join(meta["tabs"]))
    if meta.get("dials"):
        block("Studio dials",
              "\n".join(f"{k:<26}{v}" for k, v in sorted(meta["dials"].items())))
    if meta.get("post"):
        block("Post processing", ", ".join(meta["post"]))

    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# Titles. Deliberately a vision model rather than the workflow's CLIP: a CLIP object
# only exists while a run is executing, and this happens on a right-click long after.
# The pack already hit that wall with CLIP-gen captions, which can only run on a queue.
#
# The prompt is short and example-led on purpose. Ollama models vary enormously in how
# much they chat, and the reliable lever across all of them is showing the exact shape
# of the answer rather than describing it. The cleanup does the rest, because some
# model somewhere will always say "Sure! Here's a title:" regardless.
TITLE_SYSTEM = (
    "You give pictures short evocative titles, like a gallery card.\n"
    "Rules: at most four words. No punctuation. No quotes. No preamble. No "
    "explanation. Never describe what you are doing. Reply with the title only.\n"
    "Examples of correct replies:\n"
    "Red Lantern Morning\n"
    "The Long Walk Home\n"
    "Ash and Neon"
)

TITLE_USER = "Title this picture in four words or fewer."

# what models put in front of an answer no matter what the system prompt said
TITLE_JUNK = re.compile(
    r"^(sure|okay|ok|here(?:'s| is)|the title(?: is)?|title|certainly|of course)"
    r"[\s:,.!-]*", re.I)

TITLES = {}                       # path -> title, for the session
MAX_TITLES = 400


def clean_title(raw, words=4):
    """Whatever the model said, reduced to a title or to nothing.

    Deliberately strict. A bad title is worse than none, because it lands in the
    record and possibly a filename, so anything still shaped like a sentence after
    the junk is stripped is rejected rather than trimmed into nonsense.
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"<think>.*?</think>", " ", text, flags=re.S | re.I)
    text = re.sub(r"[*_`#>]+", " ", text)
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    # A lead-in almost always ends in a colon, and there are endless ways to word one,
    # so rather than chasing every phrasing: if there is a colon and what precedes it
    # talks about titling, keep what follows. A title that genuinely contains a colon
    # is left alone because its prefix says nothing about titles.
    if ":" in line:
        head, _, tail = line.partition(":")
        if tail.strip() and len(head.split()) <= 8 and any(
                w in head.lower() for w in ("title", "here", "sure", "name", "call",
                                            "certainly", "course", "okay")):
            line = tail.strip()
    for _ in range(3):                       # a bare "Title Foo" with no colon
        stripped = TITLE_JUNK.sub("", line).strip()
        if stripped == line:
            break
        line = stripped
    line = " ".join(line.strip(" \"'`.,:;!?-").split())
    if not line:
        return ""
    parts = line.split()
    # a title is a few words; anything much longer is a sentence the model wrote
    # instead of a title, and chopping a sentence at four words reads as nonsense
    if len(parts) > words * 2:
        return ""
    return " ".join(parts[:words])


def make_title(path, model="", url=None):
    """A short title for one image, from the installed vision model."""
    from . import autoprompt
    if not os.path.isfile(path):
        raise ValueError("that image is not on disk any more")
    chosen = str(model or "").strip()
    if not chosen:
        found = autoprompt.ollama_models(**({"url": url} if url else {}))
        vision = [m for m in found if any(k in m.lower()
                                          for k in ("vl", "vision", "llava", "gemma"))]
        chosen = (vision or found or [""])[0]
    if not chosen:
        raise ValueError("no Ollama vision model is available to name it with")
    raw = autoprompt.ollama_generate(
        chosen, TITLE_SYSTEM, TITLE_USER,
        image_bytes=autoprompt.vision_payload(path),
        **({"url": url} if url else {}),
        options={"temperature": 0.7, "num_predict": 32})
    title = clean_title(raw)
    if not title:
        raise ValueError(f"{chosen} did not give anything usable as a title")
    TITLES[os.path.realpath(path)] = title
    while len(TITLES) > MAX_TITLES:
        TITLES.pop(next(iter(TITLES)))
    # if a text record sits beside it, the title belongs in there too
    side = os.path.splitext(path)[0] + ".txt"
    if os.path.isfile(side):
        try:
            with open(side, "r+", encoding="utf-8") as f:
                body = f.read()
                if "\nTitle\n" not in body:
                    f.seek(0)
                    f.write(body.rstrip()
                            + "\n\nTitle\n-----\n" + title + "\n")
        except OSError:
            pass
    return title


def run_id():
    """The queued run this save belongs to.

    ComfyUI hands the executing node a real prompt id, and RedNode Image Review already
    stores that same id against every picture it shows. Recording it here is the whole
    of the cross-node link: Review can then say "keep the one I am looking at" without
    either node knowing the other exists.
    """
    try:
        from comfy_execution.utils import get_executing_context
        ctx = get_executing_context()
        if ctx is not None and getattr(ctx, "prompt_id", None):
            return str(ctx.prompt_id)
    except Exception:
        pass
    return ""


def find_saved(prompt_id, index=0):
    """The file a given run's Nth image was written to, or None."""
    if not prompt_id:
        return None
    same = [e for e in LAST_SAVED if e.get("run") == str(prompt_id)]
    if not same:
        return None
    try:
        return same[int(index)]
    except (IndexError, ValueError, TypeError):
        return same[0] if len(same) == 1 else None


def _positive_from_companion(entry):
    """The saved positive prompt, without exposing or logging the companion."""
    if not isinstance(entry, dict) or not entry.get("path"):
        return ""
    base = os.path.splitext(os.path.realpath(entry["path"]))[0]
    side_json = base + ".rn.json"
    if os.path.isfile(side_json):
        try:
            with open(side_json, "r", encoding="utf-8") as f:
                data = json.load(f)
            value = data.get("positive") if isinstance(data, dict) else ""
            if isinstance(value, str) and value.strip():
                return value.strip()
        except (OSError, ValueError, TypeError):
            pass

    side_text = base + ".txt"
    if not os.path.isfile(side_text):
        return ""
    try:
        with open(side_text, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return ""
    # record_text writes every section as: title, underline, body, blank line.
    # Stop at the next underlined section rather than the first blank line because
    # a deliberately formatted prompt may contain blank lines of its own.
    match = re.search(
        r"(?ms)^Positive prompt\r?\n-+\r?\n(.*?)"
        r"(?=\r?\n\r?\n[^\r\n]+\r?\n-+\r?\n|\Z)",
        text,
    )
    return match.group(1).strip() if match else ""


def _prompt_graph_for_run(prompt_id, prompt_server):
    """The queued graph retained in ComfyUI history, if it is still present."""
    pid = str(prompt_id or "")
    if not pid or prompt_server is None:
        return None
    try:
        history = prompt_server.prompt_queue.get_history(prompt_id=pid)
        row = (history.get(pid) or {}).get("prompt")
        graph = row[2] if isinstance(row, (list, tuple)) and len(row) > 2 else row
        return graph if isinstance(graph, dict) else None
    except Exception:
        return None


def _prompt_combine_candidates(graph):
    """Usable Prompt Combines, carrying text internally but labels only to the menu."""
    if not isinstance(graph, dict):
        return []
    found = []
    for node_id, node in graph.items():
        if not isinstance(node, dict) \
                or node.get("class_type") != "RedNodePromptCombine":
            continue
        value = _text_of(graph, node)
        if not isinstance(value, str) or not value.strip():
            continue
        inputs = node.get("inputs") or {}
        channel = inputs.get("channel_out")
        channel = channel.strip() if isinstance(channel, str) else ""
        # FINAL_PROMPT is the explicit wireless contract. The older final-prompt
        # checkbox remains the next-best signal for existing workflows.
        rank = 2 if channel.casefold() == "final_prompt" else (
            1 if inputs.get("is_final_prompt") else 0
        )
        label = f"Prompt Combine #{node_id}"
        if channel:
            label += f" \u2192 {channel}"
        found.append({
            "id": str(node_id),
            "label": label,
            "prompt": value.strip(),
            "rank": rank,
        })
    return found


def review_prompt_for_run(prompt_id, index=0, prompt_server=None, combine_id=""):
    """Resolve Copy prompt, or return label-only choices when combines are ambiguous."""
    pid = str(prompt_id or "")
    graph = _prompt_graph_for_run(pid, prompt_server)
    candidates = _prompt_combine_candidates(graph)

    if combine_id:
        selected = next(
            (item for item in candidates if item["id"] == str(combine_id)),
            None,
        )
        value = selected["prompt"] if selected else ""
        return {"found": bool(value), "prompt": value}

    if graph is not None:
        value = collect_meta(graph, {}).get("positive")
        if isinstance(value, str) and value.strip():
            return {"found": True, "prompt": value.strip()}

    value = _positive_from_companion(find_saved(pid, index))
    if value:
        return {"found": True, "prompt": value}

    if candidates:
        highest = max(item["rank"] for item in candidates)
        pool = (
            [item for item in candidates if item["rank"] == highest]
            if highest else candidates
        )
        if len(pool) == 1:
            return {"found": True, "prompt": pool[0]["prompt"]}
        return {
            "found": False,
            "prompt": "",
            "choices": [
                {"id": item["id"], "label": item["label"]}
                for item in pool
            ],
        }
    return {"found": False, "prompt": ""}


def positive_prompt_for_run(prompt_id, index=0, prompt_server=None):
    """Recover the positive prompt for callers that do not need ambiguity choices."""
    result = review_prompt_for_run(prompt_id, index, prompt_server)
    value = result.get("prompt")
    return value if isinstance(value, str) else ""


def _index_cap():
    """How many saved images to remember, from the settings dialog."""
    try:
        from . import settings
        return max(1, int(settings.get("saved_cap", MAX_REMEMBERED)))
    except Exception:
        return MAX_REMEMBERED


def _index_path(make=False):
    override = os.environ.get("KREA2RN_SAVE_INDEX")
    if override:
        return override
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    if make:
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "saved_index.json")


def load_index():
    """What was saved in earlier sessions.

    This exists because the list used to live only in memory, so a ComfyUI restart
    erased it. That is exactly when it is needed: Image Review's previews are temp
    files that die with the restart, and recovering them means knowing which output
    file belongs to which run. A list that forgets over a restart cannot do that.
    """
    try:
        with open(_index_path(), encoding="utf-8") as f:
            rows = (json.load(f) or {}).get("saved") or []
    except (OSError, ValueError, TypeError):
        return []
    out = []
    for row in rows:
        if isinstance(row, dict) and row.get("path"):
            out.append({"path": str(row["path"]), "kept": bool(row.get("kept")),
                        "preset": row.get("preset"), "seed": row.get("seed"),
                        "when": row.get("when"), "run": str(row.get("run") or ""),
                        "index": row.get("index", 0)})
    # the SETTING, not the old constant: raising the cap has to survive a reload, or
    # the index quietly shrinks back to 200 on the next restart
    return out[-_index_cap():]


def save_index():
    try:
        with open(_index_path(make=True), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "saved": LAST_SAVED}, f, indent=1,
                      ensure_ascii=False)
    except OSError as e:
        print(f"[RedNode Save] could not write the saved index ({e})", flush=True)


def remember(entry):
    LAST_SAVED.append(entry)
    while len(LAST_SAVED) > _index_cap():
        LAST_SAVED.pop(0)
    save_index()


COMPANIONS = (".txt", ".rn.json")


def _inside(path, root):
    """True when path really sits inside root. Everything here is HTTP-reachable."""
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def rebuild_index(root=None, cap=None):
    """Rebuild the recent-saves list from the files on disk, newest first.

    The index is a convenience built from files that are all still there, so losing
    it should never be final. It was: this pack's own test suite wrote over the real
    index, and the panel then showed rows pointing at deleted temp folders while
    seventeen thousand real images sat in the output folder unlisted. A list that
    cannot be rebuilt from the thing it describes is a single point of failure.

    What comes back and what does not. Path, when, kept and preset are all readable
    from the tree: `kept` is whether a path segment is the keepers folder, `preset` is
    the folder the file sits in, `when` is the file's own timestamp. The seed and the
    RUN ID are not on disk for older files, because run_id() was only ever written
    into the index. So a rebuilt row can be listed, previewed, kept and culled, but
    Image Review cannot use it to recover a preview from a past run. Anything saved
    after the companion records carry the run id (see save()) rebuilds complete.

    Newest first because that is the order the panel wants and the order a cull works
    in, and it is what decides which rows survive the cap.
    """
    out_dir = os.path.realpath(root or folder_paths.get_output_directory())
    limit = int(cap or _index_cap())
    exts = tuple(FORMATS.values())
    found = []
    for base, dirs, files in os.walk(out_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.lower().endswith(exts):
                continue
            path = os.path.join(base, name)
            try:
                when = os.path.getmtime(path)
            except OSError:
                continue
            found.append((when, path))
    # sort by time, then take the newest `limit`. Sorting the whole list and slicing
    # is right even on a big folder: it is a list of paths, not pictures.
    found.sort(key=lambda p: p[0], reverse=True)
    rows = []
    for when, path in found[:limit]:
        rel = os.path.relpath(path, out_dir).replace("\\", "/")
        parts = rel.split("/")[:-1]
        kept = KEEPERS in parts
        # the folder the image sits in, which under the default subfolder template is
        # the preset name. A guess, and labelled as one on the panel rather than
        # presented as recovered fact.
        preset = parts[-1] if parts else ""
        row = {"path": path, "kept": kept, "preset": preset, "seed": None,
               "when": when, "run": "", "index": 0, "rebuilt": True}
        # a .rn.json companion knows better than the filesystem does, when it exists
        side = os.path.splitext(path)[0] + ".rn.json"
        if os.path.isfile(side):
            try:
                with open(side, encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    if isinstance(d.get("kept"), bool):
                        row["kept"] = d["kept"]
                    if d.get("run"):
                        row["run"] = str(d["run"])
                    if d.get("seed") is not None:
                        row["seed"] = d["seed"]
            except (OSError, ValueError):
                pass
        rows.append(row)
    # Stored oldest first, because remember() appends and the cap drops from the
    # front. Hand the newest-first order back to the caller reversed, or the next
    # save would push out the newest rows instead of the oldest.
    rows.reverse()
    LAST_SAVED[:] = rows
    save_index()
    return rows


def move_saved(path, root="", to_keepers=True):
    """Move an image and its companions between the drafts and keepers trees.

    One function both ways, because keeping and unkeeping are the same move with the
    ends swapped, and a decision you cannot undo is not much of a decision.
    """
    out_dir = os.path.realpath(folder_paths.get_output_directory())
    base = os.path.join(out_dir, *[p for p in str(root or "").split("/") if p])
    src_root = os.path.join(base, DRAFTS if to_keepers else KEEPERS)
    dst_root = os.path.join(base, KEEPERS if to_keepers else DRAFTS)
    src = os.path.realpath(path)
    if not _inside(src, src_root):
        where = "drafts" if to_keepers else "keepers"
        raise ValueError(f"that file is not in the {where} folder")
    if not os.path.isfile(src):
        raise ValueError("that file is gone")
    dest = os.path.join(dst_root, os.path.relpath(src, os.path.realpath(src_root)))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    stem, ext = os.path.splitext(dest)
    n = 2
    while os.path.exists(dest):
        dest = f"{stem}_{n:03d}{ext}"
        n += 1
    shutil.move(src, dest)
    for suffix in COMPANIONS:
        companion = os.path.splitext(src)[0] + suffix
        if os.path.isfile(companion):
            shutil.move(companion, os.path.splitext(dest)[0] + suffix)
    for entry in LAST_SAVED:
        if os.path.realpath(entry.get("path", "")) == src:
            entry["path"] = dest
            entry["kept"] = bool(to_keepers)
    save_index()
    return dest


def promote(path, root=""):
    """Draft to keeper."""
    return move_saved(path, root, to_keepers=True)


def demote(path, root=""):
    """Keeper back to draft. The undo for pressing Keep by mistake."""
    return move_saved(path, root, to_keepers=False)


def open_folder(path, launcher=None):
    """Open a folder in the desktop's own file browser.

    Only ever inside the output directory, and only a folder. This is an HTTP route
    that starts a program, so it gets the narrowest job that is still useful: given
    a file, it opens the folder containing it.

    `launcher` exists so the tests can check the guards without a window appearing.
    Returns the folder that was opened.
    """
    out_dir = folder_paths.get_output_directory()
    target = os.path.realpath(path or out_dir)
    if os.path.isfile(target):
        target = os.path.dirname(target)
    if not _inside(target, out_dir):
        raise ValueError("that folder is outside the output folder")
    if not os.path.isdir(target):
        raise ValueError("that folder does not exist yet; save something first")
    if launcher is not None:
        launcher(target)
        return target
    if sys.platform == "win32":
        os.startfile(target)                     # no subprocess needed on Windows
    else:
        import subprocess
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, target])
    return target


def delete_saved(path):
    """Delete an image and its companions.

    Confined to the output directory. This is reachable over HTTP, and an unbounded
    delete route is not something to leave lying around.
    """
    out_dir = folder_paths.get_output_directory()
    src = os.path.realpath(path)
    if not _inside(src, out_dir):
        raise ValueError("that file is outside the output folder")
    if not os.path.isfile(src):
        raise ValueError("that file is gone")
    os.remove(src)
    for suffix in COMPANIONS:
        companion = os.path.splitext(src)[0] + suffix
        if os.path.isfile(companion):
            try:
                os.remove(companion)
            except OSError:
                pass
    for entry in list(LAST_SAVED):
        if os.path.realpath(entry.get("path", "")) == src:
            LAST_SAVED.remove(entry)
    save_index()
    return src


class RedNodeSave:
    """Save images into a folder tree you describe on the panel."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "the finished images to file"}),
                "config": ("STRING", {"default": json.dumps(DEFAULTS), "multiline": True,
                           "tooltip": "the panel's settings; edited through the node, "
                                      "not by hand"}),
            },
            "optional": {
                "seed": ("INT", {"forceInput": True,
                         "tooltip": "for the seed token and the record. Without it the "
                                    "first seed in the queued graph is used."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    # An IMAGE passes straight through so this can feed RedNode Image Review, which
    # turns into the big viewer for what was just filed: right-click there offers Keep
    # and Unkeep for the very file this node wrote, found through the shared prompt id.
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Files images into a folder tree you set up on the node: base folder, "
                   "subfolder, name and numbering, with drafts kept apart from keepers. "
                   "Writes a plain text record of the prompts and settings next to each "
                   "image, which unlike PNG metadata is readable by eye and survives "
                   "moving between ComfyUI and other front ends.")

    def save(self, images, config="{}", seed=None, prompt=None, extra_pnginfo=None):
        cfg = parse_config(config)
        out_dir = folder_paths.get_output_directory()
        ws = workspace_from_prompt(prompt)
        preset = ws.get("studio_preset") or ws.get("preset") or "no preset"
        if seed is None:
            seed = seed_from_prompt(prompt)
        when = time.time()
        keep = cfg["keep"]

        results = []
        for image in images:
            arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)
            ctx = {"when": when, "preset": preset, "seed": seed, "keep": keep,
                   "width": img.width, "height": img.height}
            meta = collect_meta(prompt, ctx)
            ctx["model"] = meta.get("model")
            folder, stem = build_path(cfg, ctx)
            path = final_path(out_dir, folder, stem, cfg, ctx)

            fmt = cfg["format"]
            if fmt == "png":
                png_meta = None
                if cfg["embed_png"]:
                    png_meta = PngInfo()
                    if prompt is not None:
                        png_meta.add_text("prompt", json.dumps(prompt))
                    for key, value in (extra_pnginfo or {}).items():
                        png_meta.add_text(key, json.dumps(value))
                # PNG has no quality: it is lossless, and every level below produces
                # the identical image. What changes is the file size and how long the
                # save takes, which is worth a control but not a "quality" one.
                img.save(path, pnginfo=png_meta, compress_level=cfg["compress"])
            elif fmt == "jpeg":
                # no alpha in a jpeg, and no embedded workflow either: nothing reads
                # a ComfyUI graph back out of one, which is what the text record is for
                img.convert("RGB").save(path, quality=cfg["quality"], optimize=True)
            else:
                img.save(path, quality=cfg["quality"],
                         lossless=cfg["quality"] >= 100)

            base = os.path.splitext(path)[0]
            if cfg["write_text"]:
                text = render_text(meta, ctx, os.path.basename(path))
                with open(base + ".txt", "w", encoding="utf-8") as f:
                    f.write(text)
                extra = cfg["prompts_folder"].strip()
                if extra:
                    mirror = os.path.join(out_dir,
                                          *[p for p in resolve(extra, ctx)
                                            .replace("\\", "/").split("/") if p])
                    os.makedirs(mirror, exist_ok=True)
                    with open(os.path.join(mirror, os.path.basename(base) + ".txt"),
                              "w", encoding="utf-8") as f:
                        f.write(text)
            run = run_id()
            if cfg["write_json"]:
                # The run id goes in the companion as well as the index. It used to
                # live ONLY in the index, so when that file was lost the link between
                # a picture and the run that made it went with it, and no amount of
                # reading the folder afterwards could bring it back. Beside the image
                # it survives anything that happens to the index.
                with open(base + ".rn.json", "w", encoding="utf-8") as f:
                    json.dump({"saved": time.strftime("%Y-%m-%d %H:%M:%S",
                                                      time.localtime(when)),
                               "width": img.width, "height": img.height,
                               "kept": bool(keep), "run": run, "seed": seed,
                               **meta}, f, indent=2, ensure_ascii=False)

            remember({"path": path, "kept": bool(keep), "preset": preset,
                      "seed": seed, "when": when, "run": run,
                      "index": len(results)})
            rel = os.path.relpath(path, out_dir).replace("\\", "/")
            results.append({"filename": os.path.basename(path),
                            "subfolder": os.path.dirname(rel), "type": "output",
                            "rn_path": path, "rn_kept": bool(keep)})
            print(f"[RedNode Save] {'keeper' if keep else 'draft'}: {rel}", flush=True)

        return {"ui": {"images": results}, "result": (images,)}


def workspace_from_prompt(prompt):
    """The Studio Workspace's config out of the queued graph, if there is one."""
    if not isinstance(prompt, dict):
        return {}
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "RedNodeStudioWorkspace":
            continue
        raw = (node.get("inputs") or {}).get("config")
        if isinstance(raw, str):
            try:
                cfg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if isinstance(cfg, dict):
                return cfg
    return {}


def seed_from_prompt(prompt):
    """The first seed the queued graph carries.

    Nothing clever: a workflow with several samplers has several seeds, and guessing
    which one counts would be worse than taking the first consistently.
    """
    if not isinstance(prompt, dict):
        return None
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for key in ("seed", "noise_seed"):
            v = (node.get("inputs") or {}).get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return int(v)
    return None


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/saved")
    async def _rednode_saved(request):
        out = []
        root = folder_paths.get_output_directory()
        # Send everything the index holds. It is paths, not pictures, so even a
        # thousand rows is a small JSON, and a culling session is exactly the case
        # this list exists for: 300 images made, and the point is to go through all
        # of them. The panel decides how many to DRAW.
        for e in LAST_SAVED[-_index_cap():]:
            path = e.get("path", "")
            try:
                rel = os.path.relpath(path, root).replace("\\", "/")
            except ValueError:
                rel = os.path.basename(path)
            out.append({"path": path, "name": os.path.basename(path),
                        "subfolder": os.path.dirname(rel),
                        "kept": bool(e.get("kept")), "preset": e.get("preset"),
                        "seed": e.get("seed"), "when": e.get("when"),
                        "run": e.get("run", ""), "index": e.get("index", 0),
                        "missing": not os.path.isfile(path)})
        return web.json_response({"saved": out})

    @PromptServer.instance.routes.post("/rednode/keep_result")
    async def _rednode_keep_result(request):
        """File an image the queue produced but no Save node filed, as a KEEPER.

        The paint tab's result is a temp preview unless a RedNode Save node sits in
        the paint branch, and asking the user to rewire their graph to keep one good
        picture is backwards. This copies the preview into the keepers tree through
        the same path builder a Save node uses, with the preset name "paint", so it
        lands organised exactly where the Save tab files everything else. A COPY, not
        a move: the temp file belongs to ComfyUI's cleanup, and the keepers copy is
        ours to index.
        """
        import shutil
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)
        name = os.path.basename(str(body.get("filename") or ""))
        sub = str(body.get("subfolder") or "")
        typ = str(body.get("type") or "temp")
        if not name:
            return web.json_response({"error": "no filename"}, status=400)
        roots = {"temp": folder_paths.get_temp_directory(),
                 "output": folder_paths.get_output_directory(),
                 "input": folder_paths.get_input_directory()}
        root = roots.get(typ)
        if root is None:
            return web.json_response({"error": f"unknown type {typ!r}"}, status=400)
        src = os.path.abspath(os.path.join(root, sub, name))
        # stay inside the declared root: the route takes names from the browser
        if not _inside(src, os.path.abspath(root)) or not os.path.isfile(src):
            return web.json_response({"error": "that image is gone"}, status=404)

        cfg = dict(DEFAULTS)
        cfg["format"] = os.path.splitext(name)[1].lstrip(".").lower() or "png"
        if cfg["format"] == "jpg":
            cfg["format"] = "jpeg"
        ctx = {"when": time.time(), "keep": True, "preset": "paint"}
        out_dir = folder_paths.get_output_directory()
        folder, stem = build_path(cfg, ctx)
        path = final_path(out_dir, folder, stem, cfg, ctx)
        try:
            shutil.copy2(src, path)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        remember({"path": path, "kept": True, "preset": "paint",
                  "seed": None, "when": ctx["when"],
                  "run": str(body.get("prompt_id") or ""), "index": 0})
        rel = os.path.relpath(path, out_dir).replace("\\", "/")
        print(f"[RedNode Save] keeper (from the result pane): {rel}", flush=True)
        return web.json_response({"path": path, "rel": rel})

    @PromptServer.instance.routes.get("/rednode/save_folders")
    async def _rednode_save_folders(request):
        """Folders that already exist under output, for the picker.

        The browser cannot see a filesystem, so the honest version of a folder
        picker is the server listing what is there and the panel letting you type
        anything else.
        """
        out_dir = folder_paths.get_output_directory()
        found = []
        for root, dirs, _files in os.walk(out_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")][:60]
            rel = os.path.relpath(root, out_dir).replace("\\", "/")
            if rel == ".":
                continue
            if rel.count("/") > 2:            # three levels is plenty to pick from
                dirs[:] = []
                continue
            found.append(rel)
            if len(found) > 300:
                break
        return web.json_response({"folders": sorted(found)})

    @PromptServer.instance.routes.get("/rednode/save_presets")
    async def _rednode_save_presets(request):
        return web.json_response({"builtin": BUILTIN_PRESETS, "presets": load_presets()})

    @PromptServer.instance.routes.post("/rednode/save_presets")
    async def _rednode_save_presets_post(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        action = str(data.get("action") or "save")
        try:
            if action == "delete":
                delete_preset(str(data.get("name") or ""))
            else:
                save_preset(str(data.get("name") or ""), data.get("config") or {})
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except OSError as e:
            return web.json_response({"error": f"could not write it: {e}"}, status=500)
        return web.json_response({"builtin": BUILTIN_PRESETS, "presets": load_presets()})

    @PromptServer.instance.routes.post("/rednode/title")
    async def _rednode_title(request):
        """Name one picture. On demand only: it loads a model and takes a moment."""
        try:
            data = await request.json()
        except Exception:
            data = {}
        path = str(data.get("path") or "")
        if not path:
            entry = find_saved(data.get("prompt_id") or "", data.get("index") or 0)
            path = entry["path"] if entry else ""
        if not path:
            return web.json_response(
                {"error": "nothing to name: no RedNode Save node filed this run"},
                status=404)
        if not _inside(path, folder_paths.get_output_directory()):
            return web.json_response({"error": "that file is outside the output folder"},
                                     status=400)
        import asyncio
        try:
            title = await asyncio.get_event_loop().run_in_executor(
                None, make_title, path, str(data.get("model") or ""))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": f"could not name it ({e})"}, status=500)
        print(f"[RedNode Save] titled {os.path.basename(path)}: {title}", flush=True)
        return web.json_response({"title": title, "path": path})

    @PromptServer.instance.routes.get("/rednode/prompt_for")
    async def _rednode_prompt_for(request):
        """The positive prompt behind an Image Review entry.

        The response is requested only by an explicit Copy prompt action. Never log
        the value, and tell browsers/proxies not to retain it.
        """
        result = review_prompt_for_run(
            request.query.get("prompt_id") or "",
            request.query.get("index") or 0,
            PromptServer.instance,
            request.query.get("node_id") or "",
        )
        response = web.json_response(result)
        response.headers["Cache-Control"] = "no-store"
        return response

    @PromptServer.instance.routes.get("/rednode/saved_for")
    async def _rednode_saved_for(request):
        """What a given run wrote, so another node can act on the image it is showing."""
        entry = find_saved(request.query.get("prompt_id") or "",
                           request.query.get("index") or 0)
        if entry is None:
            return web.json_response({"found": False})
        out_root = folder_paths.get_output_directory()
        try:
            rel = os.path.relpath(entry["path"], out_root).replace("\\", "/")
        except ValueError:
            rel = os.path.basename(entry["path"])
        return web.json_response({"found": True, "path": entry["path"],
                                  "name": os.path.basename(entry["path"]),
                                  "subfolder": os.path.dirname(rel),
                                  "title": TITLES.get(os.path.realpath(entry["path"]), ""),
                                  "kept": bool(entry.get("kept")),
                                  "missing": not os.path.isfile(entry["path"])})

    @PromptServer.instance.routes.post("/rednode/open_folder")
    async def _rednode_open_folder(request):
        """Opens a folder on the machine ComfyUI is running on, not the browser's."""
        try:
            data = await request.json()
        except Exception:
            data = {}
        try:
            opened = open_folder(str(data.get("path") or ""))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response(
                {"error": f"could not open a file browser here ({e})"}, status=500)
        return web.json_response({"opened": opened})

    @PromptServer.instance.routes.post("/rednode/clear_saved")
    async def _rednode_clear_saved(request):
        """Forget the recent-saves list. Deletes NOTHING from disk.

        The list is a convenience: which files this session wrote, so they can be
        kept, unkept or culled from the panel. Emptying it only stops them being
        listed. Every image and every record stays exactly where it is.
        """
        count = len(LAST_SAVED)
        LAST_SAVED.clear()
        save_index()
        print(f"[RedNode Save] cleared the recent saves list ({count} entries). No "
              "files were deleted.", flush=True)
        return web.json_response({"cleared": count})

    @PromptServer.instance.routes.post("/rednode/rebuild_index")
    async def _rednode_rebuild_index(request):
        """Rebuild the recent-saves list from the output folder. Writes no images.

        Replaces the list rather than merging into it: a rebuild means "make this
        match the folder", and merging would keep dead rows forever, which is the
        state this exists to get out of.
        """
        try:
            rows = rebuild_index()
        except OSError as e:
            return web.json_response(
                {"error": f"could not read the output folder ({e})"}, status=500)
        linked = sum(1 for r in rows if r.get("run"))
        print(f"[RedNode Save] rebuilt the saved list from the output folder: "
              f"{len(rows)} images, {linked} with a run id. Nothing was written or "
              "deleted.", flush=True)
        return web.json_response({"rebuilt": len(rows), "linked": linked})

    @PromptServer.instance.routes.post("/rednode/promote")
    async def _rednode_promote(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        path = str(data.get("path") or "")
        if not path:
            return web.json_response({"error": "no file given"}, status=400)
        try:
            if str(data.get("action") or "") == "delete":
                delete_saved(path)
                print(f"[RedNode Save] deleted {os.path.basename(path)}", flush=True)
                return web.json_response({"deleted": True})
            keep = data.get("keep", True)
            dest = move_saved(path, str(data.get("root") or ""), to_keepers=bool(keep))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except OSError as e:
            return web.json_response({"error": f"could not move it: {e}"}, status=500)
        rel = os.path.relpath(dest, folder_paths.get_output_directory()).replace("\\", "/")
        print(f"[RedNode Save] moved to {'keepers' if data.get('keep', True) else 'drafts'}"
              f": {rel}", flush=True)
        return web.json_response({"path": dest, "relative": rel})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] save HTTP routes not registered: {e}", flush=True)


# pick up what earlier sessions wrote, so a restart does not erase the link between
# a run and the file it produced
LAST_SAVED.extend(load_index())


NODE_CLASS_MAPPINGS = {"RedNodeSave": RedNodeSave}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeSave": "RedNode Save"}
