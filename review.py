"""RedNode Image Review — a viewing surface with memory.

Wire it where you would put a PreviewImage. The newest image always lands on top, and
the strip below remembers the ones before it, so comparing this run against the last
few is a glance, not a folder dig. Right-clicking an image offers Copy, and — the fun
part — Rerun: the exact prompt that produced it is re-queued from ComfyUI's own history
(same seed, same everything), or re-queued with fresh seeds.

Server-side this IS PreviewImage: images are saved to the temp dir and announced to the
browser through the standard `ui.images` channel. All the memory, browsing and rerun
logic lives in web/rednode_review.js, which pairs each arrival with its prompt_id from
the `executed` event. History survives a page reload (it rides in node.properties), but
temp images do not survive a ComfyUI restart — slots whose file is gone show as missing
rather than pretending otherwise.
"""

import os
import re

import nodes

# core's SaveImage name: <prefix>_<5-digit counter>_.png
_COUNTED = re.compile(r"^(?P<stem>.+)_(?P<n>\d{5})_\.png$")


def prune_temp(saved, keep):
    """Delete this node's older temp previews past the newest `keep`.

    A preview node writes a PNG into the temp folder on every run and nothing removes
    them before a restart, so several of these nodes on a long session fill the disk.
    Only files carrying this node instance's own name stem go (core gives every preview
    node a random suffix), only in the temp folder, and never the ones just saved.
    Returns how many went; any failure keeps the files rather than raising.
    """
    try:
        import folder_paths
        if not saved or saved[0].get("type") != "temp":
            return 0
        m = _COUNTED.match(str(saved[0].get("filename") or ""))
        if not m:
            return 0
        stem = m.group("stem")
        temp = os.path.abspath(folder_paths.get_temp_directory())
        folder = os.path.abspath(os.path.join(temp, saved[0].get("subfolder") or ""))
        if os.path.commonpath([temp, folder]) != temp:
            return 0
        mine = []
        for name in os.listdir(folder):
            mm = _COUNTED.match(name)
            if mm and mm.group("stem") == stem:
                mine.append((int(mm.group("n")), name))
        mine.sort(reverse=True)
        gone = 0
        for _, name in mine[max(int(keep), len(saved)):]:
            try:
                os.remove(os.path.join(folder, name))
                gone += 1
            except OSError:
                pass
        return gone
    except Exception:
        return 0


class RedNodeImageReview(nodes.PreviewImage):
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("An image preview that remembers: newest on top, the previous runs in a "
                   "browsable strip, and right-click Copy / Rerun (same seed) / Rerun with "
                   "new seeds.")

    # A REAL passthrough output. Workflows wire Review into Save, and core's
    # execution cache indexes the link's socket against these declarations: a link
    # into a node that declares no outputs is an IndexError at cache time.
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)

    def save_images(self, images=None, **kw):
        # The workspace's image output is legitimately None when the embedded
        # sampler is off (external mode) or the queue was a paint run: nothing
        # rendered internally, so there is nothing to preview. A quiet empty pane
        # beats the TypeError core's save path throws on None.
        if images is None:
            print("[RedNode Image Review] no image on this run; nothing to preview",
                  flush=True)
            # blocked, not None: a core node wired after this has no None guard
            from .workspace import blocked
            return {"ui": {"images": []}, "result": (blocked(),)}
        out = super().save_images(images=images, **kw)
        out["result"] = (images,)
        # the strip keeps this many pictures, so the temp folder keeps no more of them
        try:
            from . import settings
            keep = settings.get("review_keep", 24)
        except Exception:
            keep = 24
        prune_temp((out.get("ui") or {}).get("images") or [], keep)
        return out


NODE_CLASS_MAPPINGS = {"RedNodeImageReview": RedNodeImageReview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeImageReview": "RedNode Image Review"}
