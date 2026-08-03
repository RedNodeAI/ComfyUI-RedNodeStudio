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

import nodes


class RedNodeImageReview(nodes.PreviewImage):
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("An image preview that remembers: newest on top, the previous runs in a "
                   "browsable strip, and right-click Copy / Rerun (same seed) / Rerun with "
                   "new seeds.")


NODE_CLASS_MAPPINGS = {"RedNodeImageReview": RedNodeImageReview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeImageReview": "RedNode Image Review"}
