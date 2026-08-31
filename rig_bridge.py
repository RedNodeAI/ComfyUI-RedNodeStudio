"""RedNode Rig Out / Rig In - the Paint bridge pattern for external engines.

Your call (2026-08-14), replacing the wire-six-sockets approach: "we
create one node similar to the paint - one that has out and then one that has
in. That's it." Rig Out finds the Studio Workspace in the graph by itself (the
same discovery Paint Out uses), picks a rig by name, and hands out everything
an outside engine needs as plain typed values: prompt, negative, seed, denoise,
steps, cfg, sampler and scheduler as text, and the Latent tab's canvas size.
The engine (a NovelAI chain, anything) renders; Rig In takes its picture and
hands it onward - into the Studio Detailer, the i2i wired canvas, Review, Save.

An External rig on the Models tab is the natural partner (free-text sampler,
its own denoise dial), but Rig Out serves ANY rig's numbers; the workspace
stays the one cockpit either way.
"""
import json
import random

from . import workspace as _ws
from .paint_render import _workspace_cfg
from .refine_pipeline import _rig_settings


class RedNodeRigOut:
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("Everything an external engine needs, pulled from the Studio "
                   "Workspace by rig name: prompt and negative (wildcards "
                   "rolled), seed, denoise, steps, cfg, sampler and scheduler "
                   "as text, and the Latent tab's canvas size. Wire these into "
                   "your NovelAI (or any) chain; bring the picture back through "
                   "RedNode Rig In. The workspace just sits in the graph, no "
                   "wire between it and this node.")
    RETURN_TYPES = ("STRING", "STRING", "INT", "FLOAT", "INT", "FLOAT",
                    "STRING", "STRING", "INT", "INT", "IMAGE")
    RETURN_NAMES = ("prompt", "negative", "seed", "denoise", "steps", "cfg",
                    "sampler", "scheduler", "width", "height", "image")
    FUNCTION = "pull"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image": ("IMAGE", {"tooltip":
                        "The i2i source, and the mode switch: wired, the "
                        "denoise output carries the rig's own dial and the "
                        "picture rides through to the image output. Empty, "
                        "this is a fresh render and denoise comes out 1.0, "
                        "as an image to image with no image must."}),
                "rig": ("STRING", {"default": "(active rig)", "tooltip":
                        "Which Models-tab rig's numbers and prompt come out. "
                        "(active rig) follows the tab's Active choice; naming "
                        "an External rig makes this the NovelAI cockpit."}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    def pull(self, image=None, rig="(active rig)", prompt=None):
        cfg = _ws.parse_config(json.dumps(_workspace_cfg(prompt)))
        want = "" if rig == "(active rig)" else str(rig or "").strip()
        r = _rig_settings(cfg, want)
        name = r.get("name") or "(unnamed)"
        if want and name != want:
            # a typo must be LOUD, not a silent fall to the active rig with a
            # different prompt - exactly the confusion you hit
            print("[RedNode Rig Out] no rig named %r on the Models tab; using "
                  "the active rig %r and ITS prompt row. Pick from the "
                  "dropdown to avoid typos." % (want, name), flush=True)
        row = _ws.prompt_row_for(cfg["models"], cfg["prompts"], r.get("name", ""))
        seed = (random.getrandbits(48) if cfg["models"]["seed_random"]
                else cfg["models"]["seed"])
        text = ""
        negative = ""
        if row is not None:
            text = row["text"]
            negative = str(row.get("negative") or "")
            try:
                from .prompt_frame import expand as _pf_expand
                text = _pf_expand(text, seed, True)
            except Exception:
                pass
        lc = cfg.get("latent") or {}
        try:
            scale = float(lc.get("scale", 1.0) or 1.0)
        except (TypeError, ValueError):
            scale = 1.0
        w = max(64, int(int(lc.get("w", 832)) * scale) // 8 * 8)
        h = max(64, int(int(lc.get("h", 1216)) * scale) // 8 * 8)
        # THE MODE SWITCH: an image wired in means i2i and
        # the rig's own strength dial; nothing wired means a fresh render, and
        # an image to image with no image runs at denoise 1.0, no guessing
        denoise = float(r.get("denoise", 1.0)) if image is not None else 1.0
        print("[RedNode Rig Out] rig %r%s: %s, seed %d, denoise %.2f, "
              "%d steps, cfg %.1f, %s/%s, %d x %d, prompt %d char(s)"
              % (name, " (external)" if r.get("kind") == "external" else "",
                 ("i2i from %d x %d" % (image.shape[2], image.shape[1]))
                 if image is not None else "fresh render",
                 seed, denoise, int(r.get("steps", 8)),
                 float(r.get("cfg", 1.0)), r.get("sampler") or "?",
                 r.get("scheduler") or "?", w, h, len(text)), flush=True)
        return (text, negative, int(seed), denoise, int(r.get("steps", 8)),
                float(r.get("cfg", 1.0)), str(r.get("sampler") or ""),
                str(r.get("scheduler") or ""), w, h,
                image if image is not None else _ws.blocked())


class RedNodeRigIn:
    CATEGORY = "RedNode/Studio"
    DESCRIPTION = ("The way back from an external engine: its picture enters "
                   "the RedNode chain here, onward to the Studio Detailer, the "
                   "i2i wired canvas, Review or Save. A labelled junction, so "
                   "the graph reads 'NAI ends here' at a glance.")
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "take"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip":
                          "The external engine's rendered picture."}),
            },
            "optional": {
                "rig": ("STRING", {"default": "(active rig)", "tooltip":
                        "A label saying whose render this closes; shown in the "
                        "console receipt."}),
            },
        }

    def take(self, image, rig="(active rig)"):
        print("[RedNode Rig In] %r handed back %d x %d"
              % (rig, image.shape[2], image.shape[1]), flush=True)
        return (image,)


NODE_CLASS_MAPPINGS = {"RedNodeRigOut": RedNodeRigOut,
                       "RedNodeRigIn": RedNodeRigIn}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeRigOut": "RedNode Rig Out",
                              "RedNodeRigIn": "RedNode Rig In"}
