"""RedNode Live Preview: watch the picture form, step by step, on a node of its own.

Wire it where the picture comes out, the workspace's image output usually. While the
node upstream samples, ComfyUI streams that node's in-progress preview to the
browser, tagged with the node's id; the panel catches the stream for the node it is
wired to and draws it big, with a step bar, instead of the thumbnail ComfyUI paints
on the node that is working. When the run lands, the finished frame replaces it.

Server-side this IS PreviewImage, exactly as Image Review is: the finished picture is
saved to the temp dir and announced through the standard `ui.images` channel, and the
image passes straight through so the node can sit inline. The live half is entirely
web/rednode_live_preview.js, which needs no help from here: the stream already
exists, this node only gives it a place to be seen.
"""

import nodes


class RedNodeLivePreview(nodes.PreviewImage):
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Shows the picture forming step by step while the node wired into "
                   "it renders, then the finished frame. Wire the workspace's image "
                   "output in; the live preview needs no other wire.")

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)

    def save_images(self, images=None, **kw):
        # nothing rendered (external sampler, a paint run): an empty pane, and a
        # blocked output rather than a None a core node cannot take
        if images is None:
            print("[RedNode Live Preview] no image on this run; nothing to show",
                  flush=True)
            from .workspace import blocked
            return {"ui": {"images": []}, "result": (blocked(),)}
        out = super().save_images(images=images, **kw)
        out["result"] = (images,)
        return out


NODE_CLASS_MAPPINGS = {"RedNodeLivePreview": RedNodeLivePreview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeLivePreview": "RedNode Live Preview"}
