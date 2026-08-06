"""RedNode Save Video: RedNode Save, for a sequence of frames.

The same filing system, deliberately. This module IMPORTS the path builder, the token
resolver, the metadata collector, the text record, the presets and the drafts-and-
keepers index from save_node rather than copying any of it, so a video lands in the
same tree as the pictures, under the same %date%/%preset% folders, with the same
readable .txt beside it, and Image Review and the Save tab find it the same way. One
filing system with two front doors beats two systems that drift apart by Christmas.

What is genuinely new is encoding, and the settings that only mean something to a
moving picture: frames per second, container, codec, quality, and whether a GIF loops.

ENCODER. ComfyUI ships no video encoder, so this looks for one in the order that
works for the most people: the ffmpeg that imageio_ffmpeg brings with it (a Python
package, so it is simply there), then ffmpeg on PATH, and for GIF and animated WebP,
Pillow alone, which needs nothing at all. A machine with none of those still gets the
frames filed as an image sequence rather than an error, because a save node that
loses somebody's render because a codec was missing has failed at its one job.
"""

import json
import os
import shutil
import subprocess
import time

import numpy as np
import torch
from PIL import Image

import folder_paths

from .save_node import (DEFAULTS, build_path, collect_meta, final_path, parse_config,
                        remember, render_text, resolve, run_id, seed_from_prompt,
                        workspace_from_prompt)

# mp4 is what plays everywhere, webm is what the web wants, gif is what chat windows
# accept, and webp is the one that does animation without gif's 256 colours.
CONTAINERS = ("mp4", "webm", "gif", "webp")
CONTAINER_EXT = {"mp4": ".mp4", "webm": ".webm", "gif": ".gif", "webp": ".webp"}

VIDEO_DEFAULTS = dict(DEFAULTS)
VIDEO_DEFAULTS.update({
    "name": "%date%_%time%",
    "container": "mp4",
    "fps": 16.0,
    # 0..100 like the image formats, mapped onto each encoder's own scale at the
    # point of use, so one dial on the panel means the same thing everywhere.
    "quality": 85,
    "loop": True,            # gif and webp only
    "pingpong": False,       # play forward then back, for a seamless short loop
})


def _ffmpeg_exe():
    """The encoder, preferring the one that travels with the Python package.

    imageio_ffmpeg carries its own binary, so it works on a machine where nobody has
    ever installed ffmpeg, which is most machines. A PATH ffmpeg is the fallback for
    anyone who deliberately keeps their own, usually a newer one.
    """
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    return shutil.which("ffmpeg")


def frames_to_uint8(images):
    """The IMAGE batch as a list of HWC uint8 arrays, which every encoder here wants."""
    out = []
    for frame in images:
        arr = frame.detach().cpu().numpy() if torch.is_tensor(frame) else np.asarray(frame)
        out.append(np.clip(255.0 * arr, 0, 255).astype(np.uint8))
    return out


def _even(n):
    """h264 refuses odd dimensions, and silently is not an option."""
    return n - (n % 2)


def encode_ffmpeg(frames, path, fps, container, quality, exe):
    """Pipe raw frames into ffmpeg. Returns None on success, or a reason string.

    Raw RGB over a pipe rather than writing a temp image sequence: a hundred PNGs to
    disk and back is slower than the encode itself, and it leaves litter behind when
    a run is interrupted.
    """
    h, w = frames[0].shape[0], frames[0].shape[1]
    if container == "mp4":
        w, h = _even(w), _even(h)
    # 0..100 onto CRF, where LOWER is better: 100 maps to 14 (visually lossless for
    # this purpose) and 0 to 40 (bad but tiny), which keeps one dial honest across
    # the containers.
    crf = int(round(40 - (quality / 100.0) * 26))
    codec = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf),
             "-preset", "medium"] if container == "mp4" else \
            ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", str(crf), "-b:v", "0"]
    cmd = [exe, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           *codec, "-movflags", "+faststart" if container == "mp4" else "+faststart",
           path]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE)
        for f in frames:
            proc.stdin.write(f[:h, :w, :3].tobytes())
        proc.stdin.close()
        err = proc.stderr.read().decode("utf-8", "replace").strip()
        if proc.wait() != 0:
            return err or f"ffmpeg exited {proc.returncode}"
    except Exception as e:
        return str(e)
    return None


def encode_pillow(frames, path, fps, container, quality, loop):
    """GIF and animated WebP with no external tool at all."""
    imgs = [Image.fromarray(f[:, :, :3]) for f in frames]
    ms = max(1, int(round(1000.0 / max(0.1, fps))))
    kw = {"save_all": True, "append_images": imgs[1:], "duration": ms,
          "loop": 0 if loop else 1}
    if container == "webp":
        kw["quality"] = int(quality)
        kw["lossless"] = quality >= 100
    else:
        kw["optimize"] = True
    imgs[0].save(path, **kw)


class RedNodeSaveVideo:
    """File a sequence of frames as a video, into the same tree RedNode Save uses."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "the frames, in order. Any node that "
                                     "makes a batch of images makes a video here."}),
                "config": ("STRING", {"default": json.dumps(VIDEO_DEFAULTS),
                           "multiline": True,
                           "tooltip": "the panel's settings; edited through the node, "
                                      "not by hand"}),
            },
            "optional": {
                "fps": ("FLOAT", {"forceInput": True, "tooltip":
                        "wire the frame rate from whatever made the frames, and it "
                        "wins over the panel's own setting so the two cannot disagree"}),
                "seed": ("INT", {"forceInput": True,
                         "tooltip": "for the seed token and the record. Without it the "
                                    "first seed in the queued graph is used."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    # The frames pass through, exactly as RedNode Save passes its image through, so
    # this node can sit mid-chain and still feed a preview or a second save.
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "path")
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Video"
    DESCRIPTION = ("Files a batch of frames as a video into the same folder tree "
                   "RedNode Save uses: the same base folder, subfolder, name and "
                   "numbering tokens, the same drafts and keepers split, and the same "
                   "readable text record beside the file. mp4, webm, gif or animated "
                   "webp. Wire fps from whatever produced the frames and it wins over "
                   "the panel, so the two can never disagree.")

    def save(self, images, config="{}", fps=None, seed=None, prompt=None,
             extra_pnginfo=None):
        cfg = parse_config(config)
        raw = {}
        try:
            raw = json.loads(config or "{}")
        except (ValueError, TypeError):
            raw = {}
        # the video-only keys travel in the same config blob; parse_config knows the
        # image keys and leaves these to us
        container = str(raw.get("container") or "mp4").lower()
        if container not in CONTAINERS:
            container = "mp4"
        rate = float(fps if fps is not None else raw.get("fps") or 16.0)
        rate = max(0.1, min(240.0, rate))
        quality = int(raw.get("quality", cfg.get("quality", 85)) or 85)
        loop = raw.get("loop", True) is not False
        pingpong = raw.get("pingpong") is True

        frames = frames_to_uint8(images)
        if not frames:
            print("[RedNode Save Video] no frames arrived, so nothing was written",
                  flush=True)
            return {"ui": {"images": []}, "result": (images, "")}
        if pingpong and len(frames) > 2:
            # the middle frames back again, ends not repeated, so the loop is seamless
            frames = frames + frames[-2:0:-1]

        out_dir = folder_paths.get_output_directory()
        ws = workspace_from_prompt(prompt)
        preset = ws.get("studio_preset") or ws.get("preset") or "no preset"
        if seed is None:
            seed = seed_from_prompt(prompt)
        when = time.time()
        h, w = frames[0].shape[0], frames[0].shape[1]
        ctx = {"when": when, "preset": preset, "seed": seed, "keep": cfg["keep"],
               "width": w, "height": h}
        meta = collect_meta(prompt, ctx)
        ctx["model"] = meta.get("model")

        folder, stem = build_path(cfg, ctx)
        # The container decides the extension, and final_path is TOLD it rather than
        # having it swapped on afterwards: its counter scans for files that already
        # match, so renaming later restarted the count at 1 every run and overwrote
        # the previous video.
        path = final_path(out_dir, folder, stem, cfg, ctx,
                          ext=CONTAINER_EXT[container])

        why = None
        if container in ("gif", "webp"):
            try:
                encode_pillow(frames, path, rate, container, quality, loop)
            except Exception as e:
                why = str(e)
        else:
            exe = _ffmpeg_exe()
            why = (encode_ffmpeg(frames, path, rate, container, quality, exe)
                   if exe else "no ffmpeg found")
            if why:
                # NEVER lose the render over a codec. Animated webp needs nothing but
                # Pillow, so it is the fallback that still produces one playable file.
                print(f"[RedNode Save Video] {container} encoding failed ({why}); "
                      f"writing an animated webp instead", flush=True)
                path = os.path.splitext(path)[0] + ".webp"
                try:
                    encode_pillow(frames, path, rate, "webp", quality, loop)
                    why = None
                except Exception as e:
                    why = f"{why}; webp fallback also failed: {e}"

        if why:
            print(f"[RedNode Save Video] could not write a video ({why}). The frames "
                  f"are still on the wire, so a RedNode Save node will file them as "
                  f"stills.", flush=True)
            return {"ui": {"images": []}, "result": (images, "")}

        base = os.path.splitext(path)[0]
        if cfg["write_text"]:
            ctx["frames"] = len(frames)
            ctx["fps"] = rate
            text = render_text(meta, ctx, os.path.basename(path))
            text += (f"\nframes: {len(frames)}\nfps: {rate:g}\n"
                     f"duration: {len(frames) / rate:.2f}s\ncontainer: {container}\n")
            with open(base + ".txt", "w", encoding="utf-8") as f:
                f.write(text)

        run = run_id()
        remember({"path": path, "kept": bool(cfg["keep"]), "preset": preset,
                  "seed": seed, "when": when, "run": run, "index": 0})
        rel = os.path.relpath(path, out_dir).replace("\\", "/")
        print(f"[RedNode Save Video] {'keeper' if cfg['keep'] else 'draft'}: {rel} "
              f"({len(frames)} frames at {rate:g} fps, {len(frames) / rate:.2f}s)",
              flush=True)
        # ComfyUI's own gallery only shows images, so the ui payload stays empty and
        # the console line is the receipt. The path output is for wiring onward.
        return {"ui": {"images": []}, "result": (images, path)}


NODE_CLASS_MAPPINGS = {"RedNodeSaveVideo": RedNodeSaveVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeSaveVideo": "RedNode Save Video"}
