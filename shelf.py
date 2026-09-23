"""RedNode Shelf - a place to put pictures while you move them around.

Your ask (2026-09-23): moving a picture between tabs meant right-click, copy,
find the other tab, paste, and a core Load Image only ever takes a drop, it
never gives one back. The shelf holds as many pictures as you drop on it, in a
column you can scroll, and every one of them drags back OUT: onto a Workspace
gallery, the Paint pane, another shelf, or into a folder on your desktop.

Dragging out COPIES. The picture stays on the shelf until you take it off by
hand, so a misfired drag never loses one.

It is a Load Image as well, without being asked to be: the picture picked on
the shelf comes out of `image`, so a shelf beside the graph can feed anything
that wants a picture. Nothing is copied on disk; the shelf stores the same
"name.png [output]" entries the galleries use, so it points at pictures that
already exist.
"""
import json

from . import workspace as _ws


class RedNodeShelf:
    CATEGORY = "RedNode/Tools"
    DESCRIPTION = ("A shelf for pictures. Drop them on, drag them off onto any "
                   "gallery, the Paint pane or a folder, and right-click one to "
                   "send it straight to a Workspace tab. The picture picked here "
                   "also comes out of the image socket, so it doubles as a Load "
                   "Image you can drag out of.")
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "pick"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("STRING", {
                    "multiline": True, "default": "{}",
                    "tooltip": "The shelf's own state: the pictures on it and which "
                               "one is picked. The panel writes this; there is "
                               "nothing to type here.",
                }),
            },
            "optional": {
                "resize": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 64,
                    "tooltip": "Long edge for the picture on the image socket. 0 "
                               "hands it over at its own size.",
                }),
            },
        }

    @staticmethod
    def _entries(config):
        try:
            cfg = json.loads(config or "{}")
        except (TypeError, ValueError):
            return [], 0
        if not isinstance(cfg, dict):
            return [], 0
        items = [str(x) for x in (cfg.get("items") or []) if str(x).strip()]
        try:
            sel = int(cfg.get("sel", 0))
        except (TypeError, ValueError):
            sel = 0
        return items, max(0, min(sel, len(items) - 1)) if items else 0

    def pick(self, config="{}", resize=0):
        """The picked picture, or a blocked socket when the shelf is empty.

        Empty is the normal state of a shelf that is only being used to carry
        pictures between tabs, so it must not be an error: the socket simply has
        nothing on it and whatever is wired downstream is skipped.
        """
        items, sel = self._entries(config)
        if not items:
            return (_ws.blocked(),)
        try:
            return (_ws.load_image(items[sel], int(resize) or 0),)
        except Exception as exc:                      # a picture deleted since
            print("[RedNode Shelf] %r could not be read: %s" % (items[sel], exc),
                  flush=True)
            return (_ws.blocked(),)


NODE_CLASS_MAPPINGS = {"RedNodeShelf": RedNodeShelf}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeShelf": "RedNode Shelf"}
