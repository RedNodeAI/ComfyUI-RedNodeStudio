"""RedNode Live Preview: the picture forming, step by step, decoded by this pack.

Two halves. The NODE is PreviewImage with a pass-through output, the Image Review
shape: wire it where the picture comes out and the finished frame lands on it
through the standard `ui.images` channel.

The STREAM is the part that matters. While the Workspace's built-in sampler (or a
Detailer pass) runs, every step's denoised estimate is decoded here with the tiny
decoder from models/vae_approx (lighttaew2_1 for Krea 2, whichever file matches
the model's latent format), shrunk to a small JPEG, and sent to the browser as a
`rednode-live-frame` event carrying the node id, the step and the total. The
panel of every Live Preview node wired to that node draws it. This does NOT
depend on ComfyUI's own preview setting: a preview method of "none" still gets
frames here, because the decode is ours. Without a tiny decoder file the frames
fall back to latent2rgb, the colour smear, and the event says which decoder made
them.

The hook is the callback core's common_ksampler builds through
latent_preview.prepare_callback: `sampled()` wraps ONE sampler call so that the
callback also feeds our stream, and puts the original back in a finally, so
nothing outside that call is touched.
"""

import base64
import io

import nodes


class RedNodeLivePreview(nodes.PreviewImage):
    CATEGORY = "RedNode/Image"
    DESCRIPTION = ("Shows the picture forming step by step while the node wired into "
                   "it renders, decoded by the small VAE, then the finished frame. "
                   "Wire the workspace's image output in; the frames need no other "
                   "wire.")

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)

    @classmethod
    def INPUT_TYPES(cls):
        # the node's right-click "Show the full-size preview" writes this hidden switch,
        # so the run knows whether to save the small copy or the whole picture
        types = {k: dict(v) for k, v in nodes.PreviewImage.INPUT_TYPES().items()}
        types.setdefault("optional", {})["full_size"] = (
            "BOOLEAN", {"default": False,
                        "tooltip": "Save and show the finished frame at full size instead of "
                                   "the 512 px preview. Set from the node's right-click menu."})
        return types

    def save_images(self, images=None, full_size=False, **kw):
        # nothing rendered (external sampler, a paint run): an empty pane, and a
        # blocked output rather than a None a core node cannot take
        if images is None:
            print("[RedNode Live Preview] no image on this run; nothing to show",
                  flush=True)
            from .workspace import blocked
            return {"ui": {"images": []}, "result": (blocked(),)}
        # the panel only ever shows this small, so it is SAVED small: a full-size PNG
        # per run per node was disk written, then decoded and scaled in the browser on
        # every pan. The output socket still carries the full picture.
        out = super().save_images(images=images if full_size else preview_size(images), **kw)
        out["result"] = (images,)
        from .review import prune_temp
        prune_temp((out.get("ui") or {}).get("images") or [], 0)   # the latest run only
        return out


DONE_MAX = 512           # the long edge the finished frame is saved and shown at


def preview_size(images, long_edge=DONE_MAX):
    """IMAGE [B, H, W, C] scaled so the long edge is at most `long_edge`, area resampled."""
    try:
        import torch.nn.functional as F
        t = images
        while t.ndim > 4:
            t = t[0]
        h, w = int(t.shape[1]), int(t.shape[2])
        s = float(long_edge) / max(h, w)
        if s >= 1.0:
            return t
        size = (max(1, round(h * s)), max(1, round(w * s)))
        x = F.interpolate(t.movedim(-1, 1).float(), size=size, mode="area")
        return x.movedim(1, -1).clamp(0, 1)
    except Exception:
        return images


# ---- the stream ------------------------------------------------------------------

_PREVIEWER = {"key": None, "obj": None, "how": ""}
FRAME_MAX = 512          # the long edge of a streamed frame, in pixels
FRAME_QUALITY = 75


def _send(payload):
    """One frame to the browser. Never fatal: a preview that fails to send is a
    missing frame, not a dead render."""
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("rednode-live-frame", payload)
    except Exception:
        pass


def our_previewer(model):
    """(previewer, how) for this model's latent space, built by us.

    The tiny decoder from vae_approx when a file matches the format's name
    (lighttaew2_1 for Krea 2, a video-style TAE loaded the way core loads it),
    else latent2rgb, which every format with rgb factors has. Cached per format
    so a run of thirty steps loads the decoder once, not thirty times.
    """
    try:
        import latent_preview as lp
        import folder_paths
        import comfy.utils
        fmt = model.model.latent_format
    except Exception as exc:
        print("[RedNode Live Preview] no latent format to decode from: %s" % exc,
              flush=True)
        return None, ""
    name = getattr(fmt, "taesd_decoder_name", None)
    key = (name, fmt.__class__.__name__)
    if _PREVIEWER["key"] == key and _PREVIEWER["obj"] is not None:
        return _PREVIEWER["obj"], _PREVIEWER["how"]
    prev, how = None, ""
    if name:
        try:
            fn = next((f for f in folder_paths.get_filename_list("vae_approx")
                       if f.startswith(name)), "")
            path = folder_paths.get_full_path("vae_approx", fn) if fn else None
        except Exception:
            fn, path = "", None
        if path:
            try:
                if name in getattr(lp, "VIDEO_TAES", []):
                    from comfy.sd import VAE
                    tae = VAE(comfy.utils.load_torch_file(path))
                    tae.first_stage_model.show_progress_bar = False
                    prev = lp.TAEHVPreviewerImpl(tae)
                else:
                    from comfy.taesd.taesd import TAESD
                    prev = lp.TAESDPreviewerImpl(
                        TAESD(None, path, latent_channels=fmt.latent_channels)
                        .to(model.load_device))
                how = fn
            except Exception as exc:
                print("[RedNode Live Preview] the tiny decoder %s failed to load (%s); "
                      "frames fall back to latent2rgb" % (fn, exc), flush=True)
                prev = None
        else:
            print("[RedNode Live Preview] no %s* in models/vae_approx; frames are "
                  "latent2rgb until it is there" % name, flush=True)
    if prev is None and getattr(fmt, "latent_rgb_factors", None) is not None:
        prev = lp.Latent2RGBPreviewer(fmt.latent_rgb_factors,
                                      getattr(fmt, "latent_rgb_factors_bias", None),
                                      getattr(fmt, "latent_rgb_factors_reshape", None))
        how = "latent2rgb"
    _PREVIEWER.update(key=key, obj=prev, how=how)
    return prev, how


TILE_MAX = 4             # frames of a batch tiled into one live picture


def _tiled(previewer, x0):
    """A batch's frames, up to TILE_MAX, side by side in one picture. Core's tiny
    decoder only ever decodes the first latent, so a batch of four showed frame
    one forming and nothing of the other three."""
    n = min(int(x0.shape[0]), TILE_MAX)
    frames = [previewer.decode_latent_to_preview(x0[i:i + 1]) for i in range(n)]
    from PIL import Image
    w, h = frames[0].width, frames[0].height
    cols = 2 if n > 1 else 1
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, h * rows), (16, 17, 20))
    for i, f in enumerate(frames):
        sheet.paste(f.convert("RGB"), ((i % cols) * w, (i // cols) * h))
    return sheet


def frame_data(previewer, x0, size=None):
    """One step's estimate as a JPEG data URI. `size` is the long edge: None or 0
    is FRAME_MAX, a positive number is that, -1 is the decoder's own output
    untouched (the Paint tab's "full size", the sharpest and the most bytes).
    A batch is tiled, up to four frames."""
    if getattr(x0, "is_nested", False):
        x0 = x0.tensors[0]
    img = None
    if int(getattr(x0, "shape", [1])[0] or 1) > 1:
        try:
            img = _tiled(previewer, x0)
        except Exception:
            img = None                     # a decoder that cannot: frame one, as before
    if img is None:
        _fmt, img, _max = previewer.decode_latent_to_preview_image("JPEG", x0)
        img = img.copy()
    edge = int(size) if size else FRAME_MAX
    if edge > 0:
        img.thumbnail((edge, edge))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=FRAME_QUALITY)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def sampled(node_id, fn, label="", size=None):
    """`fn` (core's common_ksampler, or anything that builds its callback through
    latent_preview.prepare_callback) wrapped so every step also streams a frame
    tagged with `node_id`. The original prepare_callback goes back in a finally.

    Used as `sampled(unique_id, _core.common_ksampler)(model, seed, ...)`.
    """
    def run(*args, **kw):
        try:
            import latent_preview as lp
        except Exception:
            return fn(*args, **kw)
        orig = lp.prepare_callback
        nid = str(node_id) if node_id is not None else ""
        failed = [False]
        # the run this belongs to, so a panel that queued a run can match the
        # frames by run rather than by which node in the chain happens to sample
        pid = ""
        try:
            from comfy_execution.utils import get_executing_context
            ctx = get_executing_context()
            pid = str(getattr(ctx, "prompt_id", "") or "") if ctx else ""
        except Exception:
            pid = ""

        def prepare(model, steps, *pa, **pk):
            base = orig(model, steps, *pa, **pk)
            prev, how = our_previewer(model)
            if prev is None or not nid:
                return base

            def cb(step, x0, x, total):
                base(step, x0, x, total)
                if failed[0]:
                    return
                try:
                    _send({"node": nid, "prompt_id": pid, "step": int(step) + 1,
                           "total": int(total), "label": label, "decoder": how,
                           "data": frame_data(prev, x0, size)})
                except Exception as exc:
                    failed[0] = True
                    print("[RedNode Live Preview] frame decode failed (%s); no more "
                          "frames this run" % exc, flush=True)
            return cb
        lp.prepare_callback = prepare
        try:
            return fn(*args, **kw)
        finally:
            lp.prepare_callback = orig
    return run


NODE_CLASS_MAPPINGS = {"RedNodeLivePreview": RedNodeLivePreview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeLivePreview": "RedNode Live Preview"}
