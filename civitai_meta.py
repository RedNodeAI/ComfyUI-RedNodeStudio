"""Civitai-readable metadata for RedNode Save.

Civitai reads three things off an uploaded picture: the A1111 `parameters` text
(prompt, negative, Steps, Sampler, CFG, Seed, Size, Model), the `Hashes` map inside
it, and a `Civitai resources` list. The hashes are what link a picture to the models
that made it: AutoV2, the first ten hex digits of the file's SHA-256, upper case.
With those in place every picture posted from the pack lists its checkpoint and its
LoRAs under the image, with links, which is how people find a LoRA.

Hashing a model is a full read of the file, so it happens once: the digest is kept
in a `.sha256` sidecar beside the model, in sha256sum's own format, and read from
there ever after. A LoRA the ⓘ button already looked up is not read again either;
that cache is consulted before the file is.

Nothing here talks to Civitai. The version id is added only when the ⓘ lookup has
already put it in its cache.
"""

import hashlib
import json
import os
import re

import folder_paths

SIDECAR = ".sha256"
_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")

# which model folders a resource kind can live in, in the order to look
KIND_FOLDERS = {
    "checkpoint": ("checkpoints",),
    "unet": ("diffusion_models", "unet"),
    "lora": ("loras",),
}


def _full_path(kind, name):
    """The file a resource name points at, or None. Patched by the tests."""
    for folder in KIND_FOLDERS.get(kind, ()):
        try:
            p = folder_paths.get_full_path(folder, name)
        except Exception:
            p = None
        if p and os.path.isfile(p):
            return p
    return None


def _hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_of(path):
    """The file's SHA-256, read from the sidecar when there is one, hashed and
    written beside the file when there is not."""
    side = path + SIDECAR
    try:
        with open(side, encoding="utf-8") as f:
            first = (f.read(200).split() or [""])[0]
        if _HEX64.match(first):
            return first.lower()
    except OSError:
        pass
    digest = ""
    try:
        # the ⓘ button's cache: keyed by path, size and mtime, hashes on a miss
        from .lora_info import file_sha256
        digest = file_sha256(path)
    except Exception:
        digest = ""
    if not _HEX64.match(digest or ""):
        try:
            size = os.path.getsize(path) / 1e9
        except OSError:
            size = 0.0
        print(f"[RedNode Save] hashing {os.path.basename(path)} ({size:.1f} GB) for "
              "the Civitai record, once; the digest is kept beside the file",
              flush=True)
        digest = _hash_file(path)
    try:
        with open(side, "w", encoding="utf-8") as f:
            f.write(f"{digest}  {os.path.basename(path)}\n")
    except OSError:
        pass    # a read-only model folder: hashed again next time, nothing lost
    return digest


def autov2(path):
    """Civitai's short hash: the first ten hex digits, upper case."""
    return sha256_of(path)[:10].upper()


def _stem(name):
    return os.path.splitext(os.path.basename(str(name or "").replace("\\", "/")))[0]


def _version_id(digest):
    """The Civitai version id, if the ⓘ lookup has cached it. No network."""
    try:
        from .lora_info import _load
        hit = (_load("civitai") or {}).get(digest)
        data = hit.get("data") if isinstance(hit, dict) else None
        vid = (data or {}).get("version_id")
        return int(vid) if vid else None
    except Exception:
        return None


def resources(model_name, model_kind, loras):
    """[{type, name, weight, hash, sha256, modelVersionId?}] for the model and the
    LoRAs. A file that is not installed is listed without a hash rather than
    dropped: the name is still a lead."""
    out = []
    if model_name:
        out.append(_resource("checkpoint", model_kind or "checkpoint", model_name, 1.0))
    seen = set()
    for lora in loras or []:
        name = str((lora or {}).get("name") or "")
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            weight = float(lora.get("strength", 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        if weight == 0:
            continue      # a zero-strength slot rendered nothing
        out.append(_resource("lora", "lora", name, weight))
    return out


def _resource(rtype, kind, name, weight):
    entry = {"type": rtype, "name": name, "weight": weight}
    path = _full_path(kind, name)
    if kind == "checkpoint" and not path:
        path = _full_path("unet", name)     # a diffusion model in a checkpoint field
    if path:
        try:
            digest = sha256_of(path)
        except OSError as exc:
            print(f"[RedNode Save] could not hash {name}: {exc}", flush=True)
            digest = ""
        if digest:
            entry["sha256"] = digest
            entry["hash"] = digest[:10].upper()
            vid = _version_id(digest)
            if vid:
                entry["modelVersionId"] = vid
    return entry


def hashes(res):
    """The A1111 `Hashes` map: model, then lora:<stem>."""
    out = {}
    for r in res:
        if not r.get("hash"):
            continue
        if r["type"] == "checkpoint":
            out.setdefault("model", r["hash"])
        else:
            out[f"lora:{_stem(r['name'])}"] = r["hash"]
    return out


def civitai_resources(res):
    """The `Civitai resources` list: ONLY resources whose Civitai version id is known.

    Civitai's reader (@civitai/generation-metadata) validates every entry against
    `modelVersionId: number`, and one entry without it fails the whole schema, so the
    site then shows nothing at all: no prompt, no steps, no seed. A resource known
    only by its hash is already in `Model hash`, `Lora hashes` and `Hashes`, which is
    where Civitai matches hashes; listing it here as well is what broke the upload."""
    out = []
    for r in res:
        vid = r.get("modelVersionId")
        if isinstance(vid, bool) or not isinstance(vid, int) or vid <= 0:
            continue
        entry = {"type": r["type"], "weight": r.get("weight", 1.0),
                 "modelName": _stem(r["name"]), "modelVersionId": vid}
        if r.get("hash"):
            entry["hash"] = r["hash"]
        out.append(entry)
    return out


def _num(v):
    if isinstance(v, bool) or v is None:
        return ""
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def parameters(meta, ctx, res, sampler=None):
    """The A1111 parameters text: prompt, negative, then the settings line."""
    s = dict(sampler or meta.get("sampler") or {})
    pos = str(meta.get("positive") or "").strip()
    neg = str(meta.get("negative") or "").strip()
    lines = [pos]
    if neg:
        lines.append("Negative prompt: " + neg)
    model = next((r for r in res if r["type"] == "checkpoint"), None)
    parts = []
    if s.get("steps") not in (None, ""):
        parts.append(f"Steps: {_num(s['steps'])}")
    if s.get("sampler"):
        parts.append(f"Sampler: {s['sampler']}")
    if s.get("scheduler"):
        parts.append(f"Schedule type: {s['scheduler']}")
    if s.get("cfg") not in (None, ""):
        parts.append(f"CFG scale: {_num(s['cfg'])}")
    if ctx.get("seed") is not None:
        parts.append(f"Seed: {ctx['seed']}")
    if ctx.get("width") and ctx.get("height"):
        parts.append(f"Size: {ctx['width']}x{ctx['height']}")
    if model:
        if model.get("hash"):
            parts.append(f"Model hash: {model['hash']}")
        parts.append(f"Model: {_stem(model['name'])}")
    try:
        den = float(s.get("denoise"))
        if den < 1.0:
            parts.append(f"Denoising strength: {den:g}")
    except (TypeError, ValueError):
        pass
    lora_bits = [f"{_stem(r['name'])}: {r['hash']}" for r in res
                 if r["type"] == "lora" and r.get("hash")]
    if lora_bits:
        parts.append('Lora hashes: "' + ", ".join(lora_bits) + '"')
    hmap = hashes(res)
    if hmap:
        parts.append("Hashes: " + json.dumps(hmap, separators=(", ", ": ")))
    civ = civitai_resources(res)
    if civ:
        parts.append("Civitai resources: " + json.dumps(civ, separators=(", ", ": ")))
    parts.append("Version: RedNode Studio")
    lines.append(", ".join(parts))
    return "\n".join(lines)


def exif_bytes(text):
    """EXIF with the parameters text as UserComment, the way A1111 writes a JPEG,
    which is where Civitai looks on a JPEG or WebP."""
    from PIL import Image
    ex = Image.Exif()
    ex.get_ifd(0x8769)[0x9286] = b"UNICODE\x00" + str(text).encode("utf-16-be")
    return ex.tobytes()
