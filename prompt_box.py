"""RedNode Prompt Box — an all-in-one manual-prompt field.

A custom editor widget (web/rednode_promptbox.js) with per-node font size and text color,
live highlighting of __wildcards__ and @keywords, plus a built-in prompt pipeline:

  @keyword   -> expands to a fixed saved prompt (RedNode Prompt Keywords library)
  __wildcard__ / {a|b}  -> resolved to a random pick, seeded (seed + control_after_generate)

Because the wildcard engine is built in (wildcards.py), the box is self-contained: no
external wildcard node needed. Turn resolve_wildcards OFF to let __wildcards__ pass through
untouched to an external wildcard node instead.
"""

TEXT_COLORS = ["default", "white", "green", "amber", "cyan", "pink", "red", "blue"]


class RedNodePromptBox:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True, "default": "", "dynamicPrompts": False,
                    "tooltip": "Your prompt. @keywords expand to saved prompts; __wildcards__ and "
                               "{a|b} resolve to random picks (seeded) unless resolve_wildcards is off."}),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True,
                    "tooltip": "Seed for wildcard picks. Same seed = same result; set the control to "
                               "'randomize' to re-roll every run (that's your generate button)."}),
                "resolve_wildcards": ("BOOLEAN", {
                    "default": True, "label_on": "resolve __wildcards__", "label_off": "pass through",
                    "tooltip": "ON: this box resolves __wildcards__ / {a|b} itself. OFF: they pass "
                               "through untouched so an external wildcard node can handle them."}),
                "font_size": ("INT", {
                    "default": 16, "min": 8, "max": 48, "step": 1,
                    "tooltip": "Font size for this box only."}),
                "text_color": (TEXT_COLORS, {
                    "default": "default",
                    "tooltip": "Base text color for this box (highlighted tokens keep their own colors)."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("All-in-one prompt box: adjustable font/color, live highlighting, @keyword macros, "
                   "and a built-in seeded __wildcard__ / {a|b} engine (toggle off to pass wildcards "
                   "through to an external node). Outputs the finished prompt STRING.")

    def run(self, text, seed=0, resolve_wildcards=True, font_size=16, text_color="default"):
        # 1) @keywords -> saved text (may itself contain wildcards). 2) wildcards -> random picks.
        from .prompt_library import expand_keywords
        out = expand_keywords(text)
        if resolve_wildcards:
            from .wildcards import resolve
            out = resolve(out, seed)
        return (out,)


NODE_CLASS_MAPPINGS = {"RedNodePromptBox": RedNodePromptBox}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodePromptBox": "RedNode Prompt Box"}
