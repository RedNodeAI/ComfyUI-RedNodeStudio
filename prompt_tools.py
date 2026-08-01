"""RedNode prompt tools.

RedNode Prompt Combine — prompt combiner with a JS-powered "+ add textbox" button
(web/rednode_prompt.js), Power-Lora-Loader style: one node, unlimited boxes.

Two textboxes by default; the button adds text_3, text_4, ... dynamically. `order`
rearranges parts without rewiring ("2,1", "3,1" — unlisted parts follow in natural
order). Empty parts are skipped. Separator kept (\n escape supported). No help output.

RedNode Prompt Swap — word-boundary gender swap for captions/prompts, ported from the
user's Forge Neo JoyCaption Ultra helper (its switch-replacement table verbatim, incl.
its ambiguity choices like her→his). Fixes the naive Replace-Text failure where "her"
matches inside "there"/"another". Single-pass (rules can't chain into each other),
case-preserving (She→He, HER→HIS), extensible via custom rules.
"""

import re


class _FlexText(dict):
    """Accepts any dynamically-added text_N widget as a valid optional STRING input."""

    def __contains__(self, key):
        return True

    def __getitem__(self, key):
        return ("STRING", {"multiline": True, "default": ""})

    def get(self, key, default=None):
        return self[key]


def _apply_order(panel, merged, order):
    """Rearrange the panel's rows by a 1-based CSV, carrying each row's socket with it.

    Rows the order does not mention follow in their existing order, so a half-written
    order still produces the whole prompt rather than silently dropping the rest. An
    index that does not exist is ignored rather than raised: this field is usually fed
    by a dropdown of saved orderings, and a preset written when there were six pieces
    should not break a prompt that now has five.
    """
    text = str(order or "").strip()
    if not text:
        return panel
    parts = panel["parts"]
    idx = []
    for piece in text.replace(";", ",").split(","):
        piece = piece.strip()
        if not piece.isdigit():
            continue
        n = int(piece)
        if 1 <= n <= len(parts) and n not in idx:
            idx.append(n)
    if not idx:
        return panel
    idx += [n for n in range(1, len(parts) + 1) if n not in idx]
    # the sockets move WITH their rows, or every piece arrives in the wrong place
    remapped = {}
    for new_i, old_n in enumerate(idx):
        value = merged.get(f"part_{old_n}")
        if value is not None:
            remapped[f"part_{new_i + 1}"] = value
    for key in [k for k in list(merged) if k.startswith("part_")]:
        merged.pop(key)
    merged.update(remapped)
    return {"channel": panel.get("channel", ""),
            "parts": [parts[n - 1] for n in idx]}


class RedNodePromptCombine:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text_1": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True}),
                "text_2": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True}),
                "separator": ("STRING", {"default": ", ", "tooltip": "placed between parts; type \\n for a newline"}),
                "order": ("STRING", {"default": "", "tooltip": "rearrange parts without rewiring: 1-based indices, e.g. '2,1' or '3,1'. Unlisted parts follow in natural order. Empty = natural order."}),
                "is_final_prompt": ("BOOLEAN", {"default": False, "label_on": "final prompt",
                                    "label_off": "not flagged",
                                    "tooltip": "flags this as THE prompt for RedNode Save's "
                                               "text record. Save traces the prompt back "
                                               "from the sampler on its own, so this is "
                                               "only needed when a workflow has several "
                                               "combiners and you want to name the winner. "
                                               "No wire either way."}),
                # APPENDED, never inserted: widgets_values is positional, so new
                # widgets on the end cost nothing and every saved workflow still
                # loads. A workflow from before the panel has neither, and takes the
                # legacy path in combine() unchanged.
                "channel": ("STRING", {"default": "", "tooltip":
                            "OPTIONAL. Name a channel and every string on it becomes a "
                            "row here, with no wires. Leave it empty to use only the "
                            "boxes and wires you set up by hand."}),
                "config": ("STRING", {"default": "{}", "multiline": True}),
                "channel_out": ("STRING", {"default": "", "tooltip":
                                "OPTIONAL. Put this node's combined prompt onto a "
                                "channel, so anything subscribed to that name picks it "
                                "up with no wire. This is the general form of the "
                                "final-prompt flag: instead of one node being the "
                                "winner, any number of results can be named and "
                                "collected. Reading and sending the same channel would "
                                "make this node wait on itself, so that value is left "
                                "out and the console says so."}),
            },
            "optional": _FlexText(),
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "combine"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = "Combine prompt parts with a separator. Two boxes by default, '+ add textbox' for more, reorderable via the order field."

    def combine(self, text_1, text_2, separator=", ", order="",
                is_final_prompt=False, channel="", config="{}", channel_out="",
                **kwargs):
        # channel and channel_out are read on the CANVAS, not here: by the time this
        # runs the frontend has already turned both into ordinary links. They are
        # declared so ComfyUI draws them and so the Control Panel can drive them.
        # The panel's own record, when there is one. It carries the row order, which
        # rows are off, and any text typed into the panel rather than the legacy
        # boxes, none of which the plain order field can express. It wins over `order`
        # because it is what the user was looking at when they arranged it.
        from .text_combine import parse_config as _pc, join_parts as _jp
        panel = _pc(config)
        if panel["parts"]:
            merged = dict(kwargs)
            # the two legacy boxes stay usable as ordinary sources for their rows
            merged.setdefault("part_1", text_1)
            merged.setdefault("part_2", text_2)
            # `order` still decides, and that is the point of it: a RedNode Selector
            # holding named orderings ("Moodboard Focus: 6,1,2,3,4,5") wired into this
            # field switches the whole prompt around without touching the panel. The
            # panel is where an order is BUILT; this field is how one is CHOSEN, and a
            # choice made at run time has to beat the arrangement saved in the file.
            panel = _apply_order(panel, merged, order)
            return (_jp(panel, merged, separator),)
        return self._legacy(text_1, text_2, separator, order, **kwargs)

    def _legacy(self, text_1, text_2, separator=", ", order="", **kwargs):
        extras = sorted(
            ((int(k.split("_")[1]), v) for k, v in kwargs.items()
             if isinstance(v, str) and k.startswith("text_") and k.split("_")[1].isdigit()),
            key=lambda t: t[0])
        parts = [text_1, text_2] + [v for _, v in extras]

        if order.strip():
            try:
                idx = [int(p) for p in order.replace(";", ",").split(",") if p.strip()]
            except ValueError:
                raise ValueError(f"RedNode Prompt Combine: 'order' must be comma-separated numbers, got {order!r}")
            bad = [i for i in idx if not 1 <= i <= len(parts)]
            if bad:
                raise ValueError(
                    f"RedNode Prompt Combine: 'order' references part {bad[0]} but only {len(parts)} part(s) exist")
            parts = [parts[i - 1] for i in idx] + [p for n, p in enumerate(parts, 1) if n not in idx]

        sep = separator.replace("\\n", "\n")
        return (sep.join(p.strip() for p in parts if p and p.strip()),)


# The Neo JoyCaption Ultra switch tables, verbatim (word => replacement, lowercase).
# her→his / hers→his etc. are the helper's tested ambiguity choices — keep them.
_M2F = {
    "1boy": "1girl", "boy": "girl", "male": "female", "man": "woman",
    "he": "she", "him": "her", "himself": "herself", "his": "hers",
    "son": "daughter", "father": "mother", "brother": "sister", "uncle": "aunt",
    "grandfather": "grandmother", "grandpa": "grandma",
    "guy": "gal", "dude": "chick", "gentleman": "lady", "sir": "ma'am",
    "mister": "miss", "mr": "ms",
    "boys": "girls", "males": "females", "men": "women",
    "he's": "she's", "he'll": "she'll",
}
_F2M = {
    "1girl": "1boy", "girl": "boy", "female": "male", "woman": "man",
    "she": "he", "her": "his", "hers": "his", "herself": "himself",
    "daughter": "son", "mother": "father", "sister": "brother", "aunt": "uncle",
    "grandmother": "grandfather", "grandma": "grandpa",
    "gal": "guy", "chick": "dude", "lady": "gentleman", "ma'am": "sir",
    "miss": "mister", "ms": "mr",
    "girls": "boys", "females": "males", "women": "men",
    "she's": "he's", "she'll": "he'll",
}

SWAP_MODES = ["off", "male → female", "female → male"]

# Neo helper's act/content switches, verbatim (vaginal → anal is NEW, same rule shape —
# the Neo helper only shipped the oral variant). Empty replacement = remove the word.
_ACT_TABLES = {
    "vaginal → oral": {
        "vaginal sex": "oral sex", "vaginal": "oral",
        "intercourse": "oral sex", "penetration": "oral sex",
    },
    "vaginal → anal": {
        "vaginal sex": "anal sex", "vaginal": "anal",
        "intercourse": "anal sex", "penetration": "anal sex",
    },
}
ACT_MODES = ["off"] + list(_ACT_TABLES)
# Neo's r"\bej(e)?aculation\b" regex expanded to its two literal spellings.
_CUM_REMOVE = {"cum": "", "ejaculation": "", "ejeaculation": "", "semen": "", "sperm": ""}
_NO_PUBIC = {"pubic hair": "no pubic hair, shaved pubic hair",
             "pubes": "no pubic hair, shaved pubic hair"}


# Style converter tables — NEW (no Neo source; the helper never had these). Medium/style
# vocabulary only, high-precision entries; risky common words (bare "real", "2d") are left
# out on purpose — extend per-workflow via custom_rules.
_R2A = {
    "photorealistic": "anime style", "hyperrealistic": "anime style",
    "photoreal": "anime style", "realistic": "anime style",
    "photograph": "anime illustration", "photography": "anime artwork",
    "photographed": "illustrated", "photo": "anime illustration",
    "film still": "anime screenshot", "movie still": "anime screenshot",
    "live-action": "anime", "live action": "anime",
    "skin texture": "cel shading",
}
_A2R = {
    "anime illustration": "photograph", "anime artwork": "photograph",
    "anime screenshot": "film still", "anime art": "photograph",
    "anime style": "photorealistic style", "anime": "photorealistic",
    "manga panel": "photograph", "manga": "photorealistic",
    "illustration": "photograph", "illustrated": "photographed",
    "drawing": "photograph", "drawn": "photographed",
    "cartoon": "photorealistic", "digital art": "photograph",
    "cel shading": "natural skin texture", "cel shaded": "photorealistic",
    "cel-shaded": "photorealistic",
    "1girl": "a woman", "1boy": "a man", "2girls": "two women", "2boys": "two men",
    "kawaii": "cute", "waifu": "beautiful woman",
}
STYLE_MODES = ["off", "realistic → anime", "anime → realistic"]


def _fix_articles(text):
    """a/an repair scoped to the style tables' vocabulary ('a anime illustration',
    'an photograph') — never a general-English article rewrite."""
    t = re.sub(r"\b([Aa]) (?=(?:anime|illustration|illustrated)\b)", lambda m: m.group(1) + "n ", text)
    t = re.sub(r"\b([Aa])n (?=(?:photo|film|movie|cel|manga|drawing|realistic|photorealistic)\w*)",
               lambda m: m.group(1) + " ", t)
    return t


def _tidy(text):
    """Post-removal cleanup (the Neo helper's comma cleanup equivalent)."""
    t = re.sub(r"\s+", " ", text)
    t = re.sub(r"\s*,(?:\s*,)+", ",", t)
    t = re.sub(r"\s+,", ",", t)
    t = re.sub(r",(?=\S)", ", ", t)
    return re.sub(r"^[,\s]+|[,\s]+$", "", t)


def _match_case(src, repl):
    if src.isupper() and len(src) > 1:
        return repl.upper()
    if src[:1].isupper():
        return repl[:1].upper() + repl[1:]
    return repl


def _swap_words(text, mapping):
    if not text or not mapping:
        return text
    # longest-first so "she's" wins over "she"; \b keeps "her" out of "there"/"another"
    keys = sorted(mapping, key=len, reverse=True)
    pattern = re.compile(r"\b(" + "|".join(re.escape(k) for k in keys) + r")\b", re.IGNORECASE)
    return pattern.sub(lambda m: _match_case(m.group(0), mapping[m.group(0).lower()]), text)


def _parse_custom_rules(rules_text):
    """Lines of 'word => replacement' (the Neo switch syntax; \\b markers optional,
    boundaries are always applied). '#' starts a comment; blank lines skipped."""
    mapping = {}
    for ln, line in enumerate((rules_text or "").splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if "=>" not in line:
            raise ValueError(f"RedNode Prompt Swap: custom rule line {ln} needs 'word => replacement', got {line!r}")
        a, b = (part.strip().replace("\\b", "") for part in line.split("=>", 1))
        if a:
            mapping[a.lower()] = b
    return mapping


def convert_text(text, gender_swap="off", style_convert="off", nsfw_act_swap="off",
                 nsfw_remove_cum=False, nsfw_shave_pubic=False, custom_rules="",
                 lock_to_authority=True, style_authority=None, lock_lighting=False):
    """The Converter's whole pipeline as a function, shared by the node and the
    workspace's i2i tab: swaps, style tables, mood-authority lock, custom rules, tidy."""
    mapping = _M2F if gender_swap == "male → female" else _F2M if gender_swap == "female → male" else {}
    style = _R2A if style_convert == "realistic → anime" else _A2R if style_convert == "anime → realistic" else {}
    custom = _parse_custom_rules(custom_rules)
    out = _swap_words(text, mapping)
    out = _swap_words(out, _ACT_TABLES.get(nsfw_act_swap, {}))
    if nsfw_remove_cum:
        out = _swap_words(out, _CUM_REMOVE)
    if nsfw_shave_pubic:
        out = _swap_words(out, _NO_PUBIC)
    if style:
        out = _fix_articles(_swap_words(out, style))
    locked = bool(lock_to_authority and str(style_authority or "").strip())
    if locked:
        from .autoprompt import strip_style_terms
        out = strip_style_terms(out, style_authority, include_lighting=lock_lighting)
    out = _swap_words(out, custom)
    if mapping or nsfw_act_swap in _ACT_TABLES or nsfw_remove_cum or nsfw_shave_pubic \
            or style or custom or locked:
        out = _tidy(out)
    return out


class RedNodePromptSwap:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "", "forceInput": True,
                          "tooltip": "Caption/prompt to convert. Wire a captioner (Florence2, JoyCaption, WD tagger) or any string output here."}),
                # --- normal conversions ---
                "gender_swap": (SWAP_MODES, {"default": "off",
                              "tooltip": "Swap gender words (whole words only, case-preserving, so 'her' never matches inside 'there'). e.g. male to female."}),
                "style_convert": (STYLE_MODES, {"default": "off",
                                  "tooltip": "Convert medium/style vocabulary between realistic photography and anime terms (photograph vs anime illustration, cel shading vs skin texture, 1girl to a woman, and so on). Whole-word, case-preserving, a/an repaired. Extend it with custom_rules."}),
            },
            "optional": {
                # --- NSFW conversions (all default off) ---
                "nsfw_act_swap": (ACT_MODES, {"default": "off",
                             "tooltip": "NSFW. Rewrite vaginal / intercourse / penetration terms to the chosen act (oral or anal)."}),
                "nsfw_remove_cum": ("BOOLEAN", {"default": False, "label_on": "remove", "label_off": "keep",
                                  "tooltip": "NSFW. Remove cum / ejaculation / semen / sperm terms; leftover commas and spaces are tidied."}),
                "nsfw_shave_pubic": ("BOOLEAN", {"default": False, "label_on": "shave", "label_off": "keep",
                                  "tooltip": "NSFW. Rewrite pubic-hair mentions to 'no pubic hair, shaved pubic hair'."}),
                # --- your own rules, applied last ---
                "custom_rules": ("STRING", {"multiline": True, "default": "",
                                  "tooltip": "Your own rules, one per line: word => replacement (applied last, whole-word, case-preserving; '#' starts a comment). Example:\nprince => princess\nking => queen"}),
                # --- the mood as style authority (appended AFTER the originals:
                # widget values restore by position, so new widgets must come last) ---
                "lock_to_authority": ("BOOLEAN", {"default": True, "label_on": "lock", "label_off": "off",
                                  "tooltip": "When style_authority is wired, strip style and medium words this text uses that the authority does not. Wire the workspace's moodboard_prompt in and a photo caption can no longer fight an anime moodboard."}),
                "style_authority": ("STRING", {"forceInput": True, "multiline": True,
                                  "tooltip": "The prompt that OWNS the style, usually the workspace's moodboard_prompt output. Style words in the passing text that this authority does not itself use are removed."}),
                "lock_lighting": ("BOOLEAN", {"default": False, "label_on": "lock", "label_off": "off",
                                  "tooltip": "Stronger authority lock: also strip lighting and atmosphere vocabulary (golden hour, bokeh, backlighting, long shadows) the authority does not use. Lighting words the authority mentions survive."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "swap"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = "Word-boundary gender swap for captions/prompts (Neo JoyCaption helper tables): her→his without mangling 'there'. Extensible via custom rules."

    def swap(self, text, gender_swap="off", style_convert="off", nsfw_act_swap="off",
             nsfw_remove_cum=False, nsfw_shave_pubic=False, custom_rules="",
             lock_to_authority=True, style_authority=None, lock_lighting=False):
        return (convert_text(text, gender_swap, style_convert, nsfw_act_swap,
                             nsfw_remove_cum, nsfw_shave_pubic, custom_rules,
                             lock_to_authority, style_authority, lock_lighting),)


NODE_CLASS_MAPPINGS = {
    "RedNodePromptCombine": RedNodePromptCombine,
    "RedNodePromptSwap": RedNodePromptSwap,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RedNodePromptCombine": "RedNode Prompt Combine",
    "RedNodePromptSwap": "RedNode Prompt Converter",
}
