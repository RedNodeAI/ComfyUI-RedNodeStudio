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

import io as _io
import os
import threading

import nodes

# --- the strip's thumbnails -------------------------------------------------------
#
# The strip used to point at ComfyUI's /view, which serves the ORIGINAL file. A browser
# decodes an image at its natural size whatever it is drawn at, so a strip of twenty
# 3480x2382 results held twenty ~33 MB bitmaps to paint twenty 60px squares. That is
# most of a gigabyte to show a row of stamps, and it is what made a long history feel
# heavy.
#
# /view's own `preview=webp;80` does not help: it re-encodes and never resizes, so the
# decode cost is identical and only the download shrinks, which is nothing over
# localhost. So: resize here, server side, and hand the browser something small.
#
# The big preview above the strip still uses /view. That one is meant to be looked at.

THUMB_PX = 320
_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 256


def _resolve(filename, kind, subfolder):
    """The file a strip entry names, or None. Same validation ComfyUI's /view does.

    Rejecting traversal matters as much here as it does there: the filename arrives
    from the browser, and a route that resizes anything on disk is still a route that
    reads anything on disk.
    """
    import folder_paths
    if not filename or filename[0] == "/" or ".." in filename:
        return None
    filename, out_dir = folder_paths.annotated_filepath(filename)
    if not filename:
        return None
    if out_dir is None:
        out_dir = folder_paths.get_directory_by_type(kind or "temp")
    if out_dir is None:
        return None
    if subfolder:
        full = os.path.join(out_dir, subfolder)
        if os.path.commonpath((os.path.abspath(full), out_dir)) != out_dir:
            return None
        out_dir = full
    path = os.path.join(out_dir, os.path.basename(filename))
    return path if os.path.isfile(path) else None


def thumbnail(path, px=THUMB_PX):
    """WEBP bytes of `path`, long edge at most px. Cached on (path, mtime, px).

    mtime is in the key so a rewritten file is not served stale, which matters because
    temp filenames get reused across runs.
    """
    key = (path, os.path.getmtime(path), int(px))
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return hit

    from PIL import Image
    with Image.open(path) as img:
        img = img.convert("RGB")
        if max(img.width, img.height) > px:
            img.thumbnail((px, px), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="webp", quality=82, method=4)
    data = buf.getvalue()

    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            # oldest first; a plain dict keeps insertion order, and the strip asks for
            # the newest entries most, so the ones dropped are the ones scrolled past
            for k in list(_CACHE)[:len(_CACHE) - _CACHE_MAX + 1]:
                _CACHE.pop(k, None)
        _CACHE[key] = data
    return data


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/review_thumb")
    async def _rednode_review_thumb(request):
        q = request.rel_url.query
        path = _resolve(q.get("filename", ""), q.get("type", "temp"), q.get("subfolder", ""))
        if path is None:
            # 404 rather than an error image: the strip already knows how to show a
            # missing slot, and it falls back to /view before it gives up
            return web.Response(status=404)
        try:
            px = max(64, min(1024, int(q.get("px", THUMB_PX))))
        except ValueError:
            px = THUMB_PX
        try:
            data = thumbnail(path, px)
        except Exception as e:
            print(f"[RedNode Review] thumbnail failed for {os.path.basename(path)}: {e}",
                  flush=True)
            return web.Response(status=500)
        return web.Response(body=data, content_type="image/webp",
                            headers={"Cache-Control": "no-cache"})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] review thumbnail route not registered: {e}", flush=True)


class RedNodeImageReview(nodes.PreviewImage):
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("An image preview that remembers: newest on top, the previous runs in a "
                   "browsable strip, and right-click Copy / Rerun (same seed) / Rerun with "
                   "new seeds.")


NODE_CLASS_MAPPINGS = {"RedNodeImageReview": RedNodeImageReview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeImageReview": "RedNode Image Review"}
