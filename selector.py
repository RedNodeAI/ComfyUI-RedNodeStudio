"""RedNode Selector — a dropdown of your own choices; outputs the picked value.

Type choices in `choices`, one per line. A dropdown (`selected`) lists them and the node
outputs the chosen value. A line may be:
  value                 -> dropdown shows it and outputs it
  Label: value          -> dropdown shows the short Label, outputs the longer value
'#' comments and blank lines are skipped. A clean single-box "pick one and send it" node.
"""


def parse_choices(text):
    """[(label, value)] from the multiline choices text."""
    items = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if ":" in s:
            label, value = s.split(":", 1)
            label, value = label.strip(), value.strip()
            if label and value:
                items.append((label, value))
                continue
        items.append((s, s))
    return items


class RedNodeSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "choices": ("STRING", {
                    "multiline": True, "default": "",
                    "tooltip": "One choice per line. Use 'Label: value' to show a short label but "
                               "output the longer value; a plain line is used for both. '#' comments "
                               "and blank lines are skipped."}),
                "selected": ("STRING", {
                    "default": "",
                    "tooltip": "The picked choice — a dropdown populated from the lines above."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "RedNode/Prompt"
    DESCRIPTION = ("A dropdown of your own choices; outputs the selected value. One choice per line "
                   "('Label: value' optional). Wire the value into any STRING/prompt input.")

    def run(self, choices, selected=""):
        items = parse_choices(choices)
        by_label = {label: value for label, value in items}
        if selected in by_label:
            return (by_label[selected],)
        # tolerate a selection given as the value itself
        for label, value in items:
            if value == selected:
                return (value,)
        return (selected,)


NODE_CLASS_MAPPINGS = {"RedNodeSelector": RedNodeSelector}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeSelector": "RedNode Selector"}
