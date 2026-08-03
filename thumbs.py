"""One resized-thumbnail route, for every grid and strip in the pack.

A browser decodes an image at its NATURAL size however small it is drawn. So a grid of
60px cards pointed at 3480x2382 originals holds a ~33 MB bitmap per visible card, and
the Save browser can show hundreds of them. That is the cost this removes; the download
was never the problem on localhost.

ComfyUI's own `/view?...&preview=webp;80` looks like the answer and is not: it
re-encodes at the original dimensions and never resizes, so the decode cost is
unchanged. Hence resizing here instead.

Used by the Review strip, the Save browser grid and the Workspace galleries. The BIG
picture in each of those still points at /view, because that one is meant to be looked
at.
"""

import io as _io
import os
import threading

THUMB_PX = 320
_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 512


def _resolve(filename, kind, subfolder):
    """The file a card names, or None. Same validation ComfyUI's /view does.

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
            # oldest first; a plain dict keeps insertion order, and a grid asks for the
            # newest entries most, so what is dropped is what was scrolled past
            for k in list(_CACHE)[:len(_CACHE) - _CACHE_MAX + 1]:
                _CACHE.pop(k, None)
        _CACHE[key] = data
    return data


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/rednode/thumb")
    async def _rednode_thumb(request):
        q = request.rel_url.query
        path = _resolve(q.get("filename", ""), q.get("type", "temp"), q.get("subfolder", ""))
        if path is None:
            # 404 rather than an error image: every caller falls back to /view before
            # it gives up, and each already knows how to draw a missing slot
            return web.Response(status=404)
        try:
            px = max(64, min(1024, int(q.get("px", THUMB_PX))))
        except ValueError:
            px = THUMB_PX
        try:
            data = thumbnail(path, px)
        except Exception as e:
            print(f"[RedNode] thumbnail failed for {os.path.basename(path)}: {e}",
                  flush=True)
            return web.Response(status=500)
        return web.Response(body=data, content_type="image/webp",
                            headers={"Cache-Control": "no-cache"})

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] thumbnail route not registered: {e}", flush=True)
