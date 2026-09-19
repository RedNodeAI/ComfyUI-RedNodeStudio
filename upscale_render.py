"""RedNode Upscale: the Workspace's Upscale tab, run on its own.

The tab holds ONE Detailer pass of an upscale kind (SeedVR2, VOSR 2.0 or the
tiled upscale), so this node is a DOOR rather than a second implementation. It
takes that one pass as its own config and hands it to
`RedNodeStudioDetailer`, which already knows how to run all three, resolve a rig
for the tiled one, honour a region, hold VRAM and report progress. Nothing about
how an upscaler runs lives here, and nothing about the pass schema is copied
here either: `refine_pipeline.parse_pipeline` clamps the stage when it runs.

It is SELF-CONTAINED, like the Detailer node. The tab queues it alone, so the
Workspace is not in the pruned prompt and the hidden PROMPT has nothing to say;
Generate stamps the pass and the Workspace settings into the queued copy. Wired
by hand beside a Workspace it falls back to reading that Workspace instead.

Gated by `run_token` exactly as the paint nodes are. An OUTPUT_NODE is called on
every queue, and without the gate an ordinary render would upscale a picture
nobody asked for, which is the bug the Paint tab already learned once.

The result goes back as a temp preview through `paint_render._out`, which is
what puts it in the tab's result pane, where Post and Save can take it.
"""
import json

from . import workspace as _ws
from . import run_events as _run
from .paint_render import _out, _workspace_cfg


def _say(line):
    print("[RedNode Upscale] " + line, flush=True)


class RedNodeUpscaleRender:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # SELF-CONTAINED, the way the Detailer node is. The tab queues this
                # node ALONE, so the Workspace is not in the pruned prompt and the
                # hidden PROMPT has nothing to read: Generate stamps both of these
                # into the queued copy instead. The saved workflow keeps whatever
                # the tab last wrote, so the node also works wired by hand.
                "config": ("STRING", {"default": "{}", "multiline": True,
                                      "tooltip": "the one upscale pass; the "
                                                 "Upscale tab writes this"}),
                # The same gate the paint nodes use. The Upscale tab's Generate
                # button stamps a fresh token for its own runs; empty means this
                # is somebody else's queue and the node sits it out.
                "run_token": ("STRING", {"default": "", "tooltip":
                              "leave this empty. The Upscale tab's Generate button "
                              "fills it in for its own runs; while it is empty this "
                              "node stays out of ordinary queues instead of "
                              "upscaling a picture nobody asked for"}),
            },
            "optional": {
                # Normally NOT wired: the picture comes from the Upscale tab, the
                # same way the Paint tab feeds its own node. Wire it to upscale
                # something else and there is no guessing which image this is.
                "image": ("IMAGE", {"lazy": True, "tooltip":
                                    "the picture to upscale. Leave it empty and it "
                                    "follows the Upscale tab's own source"}),
                # the Workspace settings, for the rig a TILED pass needs. Stamped
                # by Generate; the other two methods load no rig and ignore it.
                "ws_config": ("STRING", {"default": "", "multiline": True,
                                         "tooltip": "the Workspace settings, for the "
                                                    "rig a tiled upscale runs on"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "render"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Upscales the Workspace's Upscale tab picture with SeedVR2, "
                   "VOSR 2.0 or the tiled upscale, whichever the tab has picked. "
                   "Press Generate on the tab; the finished picture lands in the "
                   "tab's result pane, ready for Post and Save. The three methods "
                   "are the Detailer's own upscale passes, so a setting means the "
                   "same thing in either place.")

    def check_lazy_status(self, run_token="", **kwargs):
        """Ask for the image only on a real upscale run.

        An empty token means this is a bystander on somebody else's queue, and
        returning nothing means the wired image's whole chain is never evaluated.
        """
        if not str(run_token or "").strip():
            return []
        return ["image"] if kwargs.get("image", None) is None else []

    @classmethod
    def IS_CHANGED(cls, run_token="", **kwargs):
        # the settings arrive through the hidden PROMPT, which IS_CHANGED cannot
        # see on some builds, so an idle node stays stable and a real run always
        # re-runs rather than serving a stale picture (see paint_bridge.py)
        return str(run_token or "").strip() or 0.0

    @_run.tracked("upscale", "Upscale")
    def render(self, config="{}", run_token="", image=None, ws_config="",
               prompt=None, unique_id=None):
        if not str(run_token or "").strip():
            # quietly: this fires on every ordinary queue and the inputs were not
            # even evaluated, so a log line per run would be noise about nothing
            return {"ui": {"images": []},
                    "result": (image if image is not None else _ws.blank_frame(),)}
        # the stamped config first; falling back to a Workspace in the same graph
        # keeps the node useful when somebody wires it up by hand
        up = None
        try:
            own = json.loads(config or "{}")
            if isinstance(own, dict) and own:
                up = _ws.parse_config(json.dumps({"upscale": own}))["upscale"]
        except (ValueError, TypeError):
            up = None
        if up is None:
            try:
                up = _ws.parse_config(json.dumps(_workspace_cfg(prompt)))["upscale"]
            except Exception:
                up = _ws.parse_config("{}")["upscale"]
        if not up.get("on"):
            _run.skip("upscale", "Upscale", "the Upscale tab is off")
            _say("nothing to do: switch the Upscale tab on")
            return _out(image if image is not None else _ws.blank_frame())

        if image is not None:
            base = image
            _say("upscaling the WIRED image")
        elif up.get("source"):
            base = _ws.load_image_or_blank(up["source"], 0, "RedNode Upscale")
            _say("upscaling %s" % up["source"])
        else:
            _run.skip("upscale", "Upscale", "the Upscale tab has no picture")
            _say("nothing to upscale: give the Upscale tab a picture")
            return _out(_ws.blank_frame())

        stage = dict(up.get("stage") or {})
        stage["on"] = True
        cfg = {"stages": [stage], "seed": up.get("seed", 0),
               "seed_random": up.get("seed_random", True)}
        # the Detailer's own machinery, with chain_step None: the Workspace may
        # already have run its Detailer passes on this queue, and this pass is a
        # door of its own rather than part of that chain
        from .refine_pipeline import RedNodeStudioDetailer
        out, report = RedNodeStudioDetailer().run(
            base, json.dumps(cfg), prompt=prompt, unique_id=unique_id,
            chain_step=None,
            ws_config=str(ws_config) if str(ws_config or "").strip() else None)
        for line in str(report or "").splitlines():
            if line.strip():
                _say(line.strip())
        return _out(out if out is not None else base)


NODE_CLASS_MAPPINGS = {"RedNodeUpscaleRender": RedNodeUpscaleRender}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeUpscaleRender": "RedNode Upscale"}
