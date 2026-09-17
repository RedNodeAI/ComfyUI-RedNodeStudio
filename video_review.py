"""RedNode Video Review: watch what the graph just made, without filing it.

RedNode Image Review for a sequence. Frames in, a player in the node, nothing kept:
the clip is written to ComfyUI's temp folder, which it clears on its own, so this is
the node you leave wired while you iterate and RedNode Save Video is the one you reach
for when a take is worth keeping. Wire both and the same frames get watched and filed.

TWO WAYS IN. Frames get encoded to a preview clip. The `path` output of RedNode Save
Video, wired in, plays the file that was really written instead, which is the better of
the two whenever it is available: no second encode, and what plays is the actual clip
at the actual quality in the actual container rather than a lookalike of it.

ComfyUI's preview channel only carries images, so this cannot use it: the payload is
its own, and web/rednode_video_review.js turns it into a real video element with a
scrubber, a loop toggle and the previous runs in a strip. That is also why the preview
prefers a container a browser will actually play, which rules out anything exotic
however well ffmpeg handles it.
"""

import json
import os
import shutil
import subprocess
import time

import folder_paths

from .save_video import (CONTAINER_EXT, SILENT_CONTAINERS, _ffmpeg_exe, encode_ffmpeg,
                         encode_pillow, frames_to_uint8, write_wav)

# What a browser plays without a plugin or a codec pack. mp4 first because every
# browser has h264; webp is the one that needs no encoder at all, so it is the floor.
PREVIEW_CONTAINERS = ("mp4", "webp")

# The panel's own settings, same shape and same blob as RedNode Save Video's, so the
# two nodes' frame rate dials are the same control and not a lookalike.
REVIEW_DEFAULTS = {"fps": 16.0}

# How many of this session's preview clips stay on disk. ComfyUI clears its temp folder
# on startup, but a long session of a hundred takes should not leave a hundred videos
# sitting there in the meantime. Comfortably more than the strip in the panel holds, so
# clicking back through the strip never lands on a file that has been swept.
PRUNE_TO = 10


def prune(tmp_dir, keep=PRUNE_TO):
    """Drop all but the newest few preview clips this process has written.

    Only ours, matched by the prefix: the temp folder is shared with ComfyUI itself and
    with every other pack, and a preview node has no business deleting their files.
    Sorted by name because the name carries the timestamp, which makes this independent
    of whatever the filesystem thinks the mtimes are.
    """
    try:
        mine = sorted(f for f in os.listdir(tmp_dir)
                      if f.startswith(f"rn_preview_{os.getpid()}_"))
    except OSError:
        return
    for f in mine[:-keep] if len(mine) > keep else []:
        try:
            os.remove(os.path.join(tmp_dir, f))
        except OSError:
            pass                      # a clip still being served is not worth a fuss


def probe(path, exe):
    """Duration in seconds from the file itself, or 0 if it will not say.

    Frames and rate cannot be recovered cheaply from a container, and a count that
    needed a full decode would make the preview slower than the save. Duration is the
    part the player actually shows, and ffmpeg gives it from the header alone.
    """
    if not exe:
        return 0.0
    try:
        r = subprocess.run([exe, "-i", path], capture_output=True, text=True, timeout=20)
        for line in (r.stderr or "").splitlines():
            if "Duration:" in line:
                h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
                return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        pass
    return 0.0


def play_filed(video_path, tmp_dir, loop):
    """A payload for a file that already exists, or None if there is nothing to play.

    /view only serves ComfyUI's own folders, and this node only plays from the
    output folder: the path is a node input, which a queued workflow can set to
    anything, so a clip outside output is refused rather than copied into reach.
    """
    path = str(video_path or "").strip()
    if not path or not os.path.isfile(path):
        return None
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext not in CONTAINER_EXT:
        return None

    root = os.path.abspath(folder_paths.get_output_directory())
    full = os.path.abspath(path)
    kind, sub, name = "output", "", os.path.basename(full)
    try:
        rel = os.path.relpath(full, root)
        inside = not rel.startswith(os.pardir + os.sep) and rel != os.pardir
    except ValueError:
        inside = False               # a different drive, which Windows makes common
    if inside:
        sub = os.path.dirname(rel).replace(os.sep, "/")
    else:
        print("[RedNode Video Review] the clip is filed outside ComfyUI's output folder, "
              "so it is not played here; save it under output to see it", flush=True)
        return None

    exe = _ffmpeg_exe()
    secs = probe(full, exe)
    return {"filename": name, "subfolder": sub, "type": kind, "format": ext,
            "fps": 0, "frames": 0, "seconds": round(secs, 2), "loop": bool(loop),
            # gif and webp have no audio track, and for the rest ffmpeg is asked
            "audio": ext not in SILENT_CONTAINERS and has_audio(full, exe)}


def has_audio(path, exe):
    if not exe:
        return False
    try:
        r = subprocess.run([exe, "-i", path], capture_output=True, text=True, timeout=20)
        return "Audio:" in (r.stderr or "")
    except Exception:
        return False


class RedNodeVideoReview:
    """A video preview that remembers, with the previous runs in a strip."""

    @classmethod
    def INPUT_TYPES(cls):
        # Everything is optional because there are two ways in and they are exclusive.
        # Frames get encoded to a preview clip. A path from RedNode Save Video plays
        # the file that was actually written, which is the better of the two when it
        # is available: no second encode, and what plays is the real thing at the real
        # quality in the real container, rather than a lookalike.
        return {
            "optional": {
                "images": ("IMAGE", {"tooltip":
                           "the frames to watch, in order. Leave this empty if a video "
                           "path is wired instead."}),
                "video_path": ("STRING", {"forceInput": True, "tooltip":
                               "the path output of RedNode Save Video. Wire it and the "
                               "file that was just filed is what plays, with nothing "
                               "encoded twice."}),
                # A socket, not a widget, exactly as RedNode Save Video has it: the
                # panel's dial is the setting and a wired rate beats it, so the two
                # can never disagree. It was a number box stepping 0.1 across a 240
                # range, which is a tenth of a frame per notch and 16.3 fps by accident.
                "fps": ("FLOAT", {"forceInput": True, "tooltip":
                        "wire the frame rate from whatever made the frames, and it "
                        "wins over the panel's own dial. A wired video path carries "
                        "its own rate, so both are ignored then."}),
                "audio": ("AUDIO", {"tooltip": "sound to play with the preview"}),
                "loop": ("BOOLEAN", {"default": True, "tooltip":
                         "whether the player loops. A short clip is easier to judge "
                         "looping, and a long one is easier to judge once."}),
                # Last on purpose: a workflow saved before the panel existed holds
                # [fps, loop] here, and the web file carries those two values across
                # into their new homes rather than letting them land shifted by one.
                "config": ("STRING", {"default": json.dumps(REVIEW_DEFAULTS),
                           "multiline": True,
                           "tooltip": "the panel's settings; edited through the node, "
                                      "not by hand"}),
            },
            "hidden": {"prompt": "PROMPT"},
        }

    # No outputs at all: this is somewhere frames END. RedNode Save Video passes its
    # frames through, so the pair chains in either order without a splitter.
    RETURN_TYPES = ()
    FUNCTION = "review"
    OUTPUT_NODE = True
    CATEGORY = "RedNode/Video"
    DESCRIPTION = ("Plays what the graph just made, in the node, with a scrubber and "
                   "the previous runs in a strip. Wire frames to preview them, or the "
                   "path output of RedNode Save Video to play the clip that was really "
                   "filed. Previewing frames files nothing: it goes to ComfyUI's temp "
                   "folder, so this is the node to leave wired while you iterate.")

    def review(self, images=None, video_path=None, fps=None, audio=None, loop=True,
               config="{}", prompt=None):
        try:
            raw = json.loads(config or "{}")
        except (ValueError, TypeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        # a wired rate wins over the dial, the same order Save Video uses. A config
        # blob is text and can be anything: a rate that will not read as a number is
        # worth a default, never a failed run.
        try:
            rate = float(fps if fps is not None else raw.get("fps") or 16.0)
        except (TypeError, ValueError):
            rate = 16.0
        rate = max(0.1, min(240.0, rate))
        tmp_dir = folder_paths.get_temp_directory()
        os.makedirs(tmp_dir, exist_ok=True)

        # a wired path wins, because it is the file that was really written
        filed = play_filed(video_path, tmp_dir, loop)
        if filed is not None:
            prune(tmp_dir)
            return {"ui": {"rn_videos": [filed]}}
        if video_path is not None and str(video_path).strip():
            print(f"[RedNode Video Review] nothing playable at {video_path!r}; falling "
                  f"back to the frames", flush=True)

        frames = frames_to_uint8(images) if images is not None else []
        if not frames:
            return {"ui": {"rn_videos": []}}

        stem = f"rn_preview_{os.getpid()}_{int(time.time() * 1000)}"

        wav = None
        if audio is not None:
            try:
                wav, _secs = write_wav(audio, os.path.join(tmp_dir, stem + ".wav"))
            except Exception as e:
                print(f"[RedNode Video Review] audio skipped ({e})", flush=True)
                wav = None

        path = os.path.join(tmp_dir, stem + ".mp4")
        container = "mp4"
        exe = _ffmpeg_exe()
        why = (encode_ffmpeg(frames, path, rate, "mp4", 80, exe, wav)
               if exe else "no ffmpeg found")
        if why:
            # A preview that cannot play is worth less than a silent one that can, so
            # the floor is the container needing no encoder at all.
            print(f"[RedNode Video Review] mp4 preview failed ({why}); showing an "
                  f"animated webp instead", flush=True)
            container = "webp"
            path = os.path.join(tmp_dir, stem + ".webp")
            try:
                encode_pillow(frames, path, rate, "webp", 80, loop)
            except Exception as e:
                print(f"[RedNode Video Review] could not build a preview ({e})",
                      flush=True)
                return {"ui": {"rn_videos": []}}

        if wav:
            try:
                os.remove(wav)
            except OSError:
                pass
        prune(tmp_dir)

        return {"ui": {"rn_videos": [{
            "filename": os.path.basename(path),
            "subfolder": "",
            "type": "temp",
            "format": container,
            "fps": rate,
            "frames": len(frames),
            "loop": bool(loop),
            # a webp carries no audio track, so the player must not promise one
            "audio": bool(wav) and container not in SILENT_CONTAINERS,
        }]}}


NODE_CLASS_MAPPINGS = {"RedNodeVideoReview": RedNodeVideoReview}
NODE_DISPLAY_NAME_MAPPINGS = {"RedNodeVideoReview": "RedNode Video Review"}
