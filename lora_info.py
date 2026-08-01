"""Civitai lookup for LoRA slots (the ⓘ button in RedNode LoRA Stack).

Civitai can be queried by file hash, so a local LoRA is identified without ever sending
its name or contents anywhere: SHA-256 the file, ask
`/api/v1/model-versions/by-hash/<sha256>`, show what comes back.

Two caches keep it cheap, both on disk beside the presets:
- hashes, keyed by path+size+mtime (re-hashing a 600 MB file every click would be silly);
- Civitai answers, keyed by hash (including "not found", so misses stay quiet).

Nothing here runs unless the user clicks ⓘ. No network call happens at import, on queue,
or during sampling — this module only serves an HTTP route for the frontend.
"""

import asyncio
import hashlib
import re
import shutil
import threading
import json
import os
import time
import urllib.error
import urllib.request

import folder_paths

CIVITAI_BY_HASH = "https://civitai.com/api/v1/model-versions/by-hash/{}"
CIVITAI_VERSION = "https://civitai.com/api/v1/model-versions/{}"
CIVITAI_SEARCH = "https://civitai.com/search/models?query={}"
CIVITAI_MODEL = "https://civitai.com/api/v1/models/{}"
_TIMEOUT = 12
_CACHE_TTL = 7 * 24 * 3600      # re-check Civitai weekly
_MEM = {}                        # in-process hash cache (path -> (sig, hash))


def _cache_path(kind):
    override = os.environ.get("KREA2RN_LORA_CACHE")
    if override:
        base, name = os.path.dirname(override), os.path.basename(override)
        return os.path.join(base, f"{kind}_{name}")
    try:
        base = os.path.join(folder_paths.get_user_directory(), "default", "rednode-krea2")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "user_data")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"lora_{kind}_cache.json")


def _load(kind):
    try:
        with open(_cache_path(kind), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _store(kind, data):
    try:
        with open(_cache_path(kind), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
    except OSError:
        pass


def file_sha256(path):
    """Hash with a disk cache keyed by path+size+mtime (a changed file re-hashes)."""
    st = os.stat(path)
    sig = f"{st.st_size}:{int(st.st_mtime)}"
    if _MEM.get(path, (None, None))[0] == sig:
        return _MEM[path][1]
    cache = _load("hash")
    hit = cache.get(path)
    if isinstance(hit, dict) and hit.get("sig") == sig and hit.get("hash"):
        _MEM[path] = (sig, hit["hash"])
        return hit["hash"]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):   # 4 MB blocks
            h.update(chunk)
    digest = h.hexdigest()
    cache[path] = {"sig": sig, "hash": digest}
    _store("hash", cache)
    _MEM[path] = (sig, digest)
    return digest


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "RedNodeStudio/RedNode"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"_notfound": True}
        return {"_error": f"Civitai returned HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001 — offline, DNS, TLS, timeout…
        return {"_error": f"Could not reach Civitai ({type(e).__name__})"}


def _fetch_civitai(digest):
    return _get_json(CIVITAI_BY_HASH.format(digest))


def _norm(text):
    return "".join(c for c in str(text or "").lower() if c.isalnum())


# ------------------------------------------------------------------- downloads
#
# Deliberate rules, because this writes to the user's model folder:
#   * one file per explicit click — never a batch, never automatic;
#   * streams to "<name>.part", verifies SHA-256 against what Civitai published,
#     and only then moves it into place. A mismatch deletes the file;
#   * NEVER overwrites: a colliding name gets " (2)", " (3)", …;
#   * NEVER repoints a slot. Switching stays a separate, manual click.
# Token (only needed for gated models): CIVITAI_API_TOKEN env var, or a
# civitai_token.txt next to the presets. It is never written into the pack.

_JOBS = {}          # id -> {state, got, total, name, error}
_JOB_SEQ = [0]


def _civitai_token():
    tok = (os.environ.get("CIVITAI_API_TOKEN") or "").strip()
    if tok:
        return tok
    try:
        base = os.path.dirname(_cache_path("hash"))
        with open(os.path.join(base, "civitai_token.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _dest_config_path():
    return os.path.join(os.path.dirname(_cache_path("hash")), "download_dir.txt")


def lora_folders():
    """Every configured loras root that exists on disk (download destinations)."""
    try:
        return [d for d in folder_paths.get_folder_paths("loras") if os.path.isdir(d)]
    except Exception:
        return []


def get_download_dir():
    """The chosen destination, or the first configured root. Always one of ComfyUI's own
    loras folders — an arbitrary path is never accepted, so downloads cannot escape them."""
    roots = lora_folders()
    if not roots:
        return None
    try:
        with open(_dest_config_path(), encoding="utf-8") as f:
            saved = f.read().strip()
        if saved and any(os.path.normcase(saved) == os.path.normcase(r) for r in roots):
            return saved
    except OSError:
        pass
    return roots[0]


def set_download_dir(path):
    roots = lora_folders()
    if not any(os.path.normcase(path) == os.path.normcase(r) for r in roots):
        raise ValueError("that folder is not one of ComfyUI's configured loras folders")
    with open(_dest_config_path(), "w", encoding="utf-8") as f:
        f.write(path)
    return path


def _unique_path(folder, filename):
    stem, ext = os.path.splitext(filename)
    cand = os.path.join(folder, filename)
    n = 2
    while os.path.exists(cand):
        cand = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    return cand


def _pick_file(version):
    """The primary model file of a version (largest .safetensors), plus its hash."""
    best = None
    for f in version.get("files") or []:
        name = f.get("name") or ""
        if not name.lower().endswith((".safetensors", ".ckpt", ".pt")):
            continue
        if best is None or (f.get("sizeKB") or 0) > (best.get("sizeKB") or 0):
            best = f
    if not best:
        return None
    return {
        "name": best.get("name"),
        "url": best.get("downloadUrl") or version.get("downloadUrl"),
        "sha256": ((best.get("hashes") or {}).get("SHA256") or "").lower(),
        "size_kb": best.get("sizeKB") or 0,
    }


def _download_job(job_id, version_id):
    job = _JOBS[job_id]
    try:
        version = _get_json(CIVITAI_MODEL.replace("/models/{}", "/model-versions/{}").format(version_id))
        if version.get("_error") or version.get("_notfound"):
            raise RuntimeError(version.get("_error") or "That version no longer exists on Civitai")
        info = _pick_file(version)
        if not info or not info["url"]:
            raise RuntimeError("No downloadable model file on that version")

        dest_dir = get_download_dir()
        if not dest_dir:
            raise RuntimeError("No writable loras folder found")

        need = int(info["size_kb"]) * 1024
        try:
            free = shutil.disk_usage(dest_dir).free
            if need and free < need * 1.1:
                raise RuntimeError(f"Not enough free space ({free // 2**20} MB free, "
                                   f"{need // 2**20} MB needed)")
        except OSError:
            pass

        job.update(name=info["name"], total=need, state="downloading")
        url = info["url"]
        tok = _civitai_token()
        if tok:
            url += ("&" if "?" in url else "?") + "token=" + tok
        req = urllib.request.Request(url, headers={"User-Agent": "RedNodeStudio/RedNode"})

        part = _unique_path(dest_dir, info["name"] + ".part")
        h = hashlib.sha256()
        try:
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as out:
                total = int(r.headers.get("Content-Length") or need or 0)
                job["total"] = total
                while True:
                    if job.get("cancel"):
                        raise RuntimeError("Cancelled")
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    job["got"] += len(chunk)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise RuntimeError("Civitai refused the download (this model needs an API token — "
                                   "set CIVITAI_API_TOKEN or create civitai_token.txt beside the presets)")
            raise RuntimeError(f"Download failed (HTTP {e.code})")

        got = h.hexdigest().lower()
        if info["sha256"] and got != info["sha256"]:
            os.remove(part)
            raise RuntimeError("Downloaded file failed its SHA-256 check — deleted, nothing was installed")

        final = _unique_path(dest_dir, info["name"])
        os.replace(part, final)
        rel = os.path.basename(final)
        job.update(state="done", path=final, lora_name=rel, verified=bool(info["sha256"]))
    except Exception as e:  # noqa: BLE001 — surface everything to the user
        job.update(state="error", error=str(e))
        for stray in (locals().get("part"),):
            if stray and os.path.exists(stray):
                try:
                    os.remove(stray)
                except OSError:
                    pass


# --------------------------------------------------------- base-model detection
#
# safetensors keeps a JSON header at the front of the file, so a LoRA's architecture
# can be read in milliseconds without loading a single tensor. Trainers disagree about
# metadata keys (and plenty of files carry none), so we try metadata first and fall
# back to the tensor key layout — verified against this machine's library.

_ARCH_BY_META = [
    ("krea", "Krea 2"), ("zimage", "Z-Image"), ("z-image", "Z-Image"),
    ("flux", "Flux"), ("qwen", "Qwen"), ("wan", "WAN"), ("anima", "Anima"),
    ("sdxl", "SDXL"), ("xl_base", "SDXL"), ("sd_v1", "SD 1.5"), ("sd15", "SD 1.5"),
    ("illustrious", "Illustrious"), ("pony", "Pony"), ("hunyuan", "Hunyuan"),
    ("chroma", "Chroma"), ("ltx", "LTX Video"), ("qwen-image", "Qwen Image"),
]
_ARCH_BY_KEYS = [
    # most specific first — several families share the generic "transformer_blocks" shape
    ("adaln_single.emb.timestep_embedder", "LTX Video"),
    ("attn1.to_gate", "LTX Video"),
    ("lora_transformer_context_embedder", "Chroma"),
    ("add_k_proj", "Qwen Image"),
    # WAN video LoRAs share Krea 2's "diffusion_model.blocks." prefix, but WAN is a
    # dual-stream model with cross-attention; Krea 2's SingleStreamDiT has none.
    ("cross_attn", "WAN"),
    ("diffusion_model.layers.", "Z-Image"),
    ("diffusion_model.blocks.", "Krea 2"),
    ("lora_unet_double_blocks", "Flux"),
    ("lora_unet_single_blocks", "Flux"),
    ("transformer.single_transformer_blocks", "Flux"),
    ("lora_unet_input_blocks", "SD/SDXL"),
    ("lora_unet_down_blocks", "SD/SDXL"),
    ("lora_te", "SD/SDXL"),
    ("lora_unet_blocks_", "Anima"),
]


def _safetensors_header(path, max_header=32 << 20):
    with open(path, "rb") as f:
        raw = f.read(8)
        if len(raw) < 8:
            return None
        n = int.from_bytes(raw, "little")
        if n <= 0 or n > max_header:
            return None
        return json.loads(f.read(n).decode("utf-8", "replace"))


def detect_base_model(path):
    """-> a short label like 'Krea 2' / 'Z-Image' / 'SD/SDXL' / 'Unknown'."""
    try:
        head = _safetensors_header(path)
    except Exception:  # noqa: BLE001 — unreadable/not safetensors
        return "Unknown"
    if not isinstance(head, dict):
        return "Unknown"
    meta = head.get("__metadata__") or {}
    blob = " ".join(str(meta.get(k, "")) for k in
                    ("ss_base_model_version", "base_model", "modelspec.architecture",
                     "ss_sd_model_name", "architecture", "model_type")).lower()
    for needle, label in _ARCH_BY_META:
        if needle in blob:
            return label
    keys = [k for k in head if k != "__metadata__"]
    sample = "\n".join(keys[:60])
    for needle, label in _ARCH_BY_KEYS:
        if needle in sample:
            return label
    return "Unknown"


def list_lora_types(refresh=False, with_times=False):
    """{lora name: base-model label} for every installed LoRA, cached by path+mtime.
    With `with_times`, also returns when each file landed in the folder so the picker
    can sort by newest (creation time on Windows, mtime elsewhere — whichever is later,
    which survives both copies and downloads)."""
    try:
        names = folder_paths.get_filename_list("loras")
    except Exception:
        return ({}, {}) if with_times else {}
    cache = {} if refresh else _load("type")
    out, times, dirty = {}, {}, False
    for name in names:
        path = folder_paths.get_full_path("loras", name)
        if not path:
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        times[name] = max(st.st_mtime, getattr(st, "st_ctime", 0))
        sig = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(path)
        if isinstance(hit, dict) and hit.get("sig") == sig:
            out[name] = hit.get("arch", "Unknown")
            continue
        arch = detect_base_model(path)
        cache[path] = {"sig": sig, "arch": arch}
        out[name] = arch
        dirty = True
    if dirty:
        _store("type", cache)
    return (out, times) if with_times else out


def _find_local_copy(version):
    """Is this Civitai version ALREADY sitting in the loras folder under another name?

    Hashing an entire library would be absurd, so: (1) consult the hash cache — files
    already looked up are free; (2) otherwise shortlist by filename similarity and hash
    only those. Returns the local LoRA name, or None."""
    want = set()
    for f in version.get("files") or []:
        h = (f.get("hashes") or {}).get("SHA256")
        if h:
            want.add(h.lower())
    if not want:
        return None
    try:
        local = folder_paths.get_filename_list("loras")
    except Exception:
        return None

    # (1) anything we've already hashed
    cache = _load("hash")
    by_hash = {v.get("hash", "").lower(): k for k, v in cache.items() if isinstance(v, dict)}
    for h in want:
        path = by_hash.get(h)
        if path:
            for name in local:
                if folder_paths.get_full_path("loras", name) == path:
                    return name

    # (2) shortlist by name, then confirm by hash (bounded — never a full-library scan)
    targets = [_norm(os.path.splitext(f.get("name", ""))[0]) for f in (version.get("files") or [])]
    targets += [_norm(version.get("name"))]
    targets = [t for t in targets if len(t) > 3]
    cands = []
    for name in local:
        n = _norm(os.path.splitext(os.path.basename(name))[0])
        if any(t and (t in n or n in t) for t in targets):
            cands.append(name)
    for name in cands[:5]:
        path = folder_paths.get_full_path("loras", name)
        if not path:
            continue
        try:
            if file_sha256(path).lower() in want:
                return name
        except OSError:
            continue
    return None


def _check_update(model_id, installed_version_id):
    """Is a newer version of this model published? Read-only: reports, never downloads.
    Civitai lists modelVersions newest-first."""
    if not model_id or not installed_version_id:
        return None
    raw = _get_json(CIVITAI_MODEL.format(model_id))
    versions = raw.get("modelVersions") if isinstance(raw, dict) else None
    if not versions:
        return None
    latest = versions[0]
    if latest.get("id") == installed_version_id:
        return {"available": False, "latest": latest.get("name")}
    # position of the installed one tells us how far behind it is
    behind = next((i for i, v in enumerate(versions) if v.get("id") == installed_version_id), None)
    return {
        "available": True,
        "latest": latest.get("name"),
        "latest_id": latest.get("id"),
        "published": (latest.get("publishedAt") or "")[:10],
        "behind": behind,
        # already downloaded it? then the UI can just offer to switch the slot over
        "installed_as": _find_local_copy(latest),
    }


def _summarize(raw, digest):
    """Keep the handful of fields worth showing; drop Civitai's very large payload."""
    if raw.get("_error"):
        return {"hash": digest, "error": raw["_error"]}
    if raw.get("_notfound"):
        return {"hash": digest, "found": False}
    model = raw.get("model") or {}
    stats = raw.get("stats") or {}
    images = [i.get("url") for i in (raw.get("images") or [])
              if isinstance(i, dict) and i.get("url") and i.get("nsfwLevel", 0) <= 1]
    return {
        "hash": digest,
        "found": True,
        "name": model.get("name") or raw.get("name") or "(unnamed)",
        "version": raw.get("name"),
        "type": model.get("type"),
        "base_model": raw.get("baseModel"),
        "trained_words": raw.get("trainedWords") or [],
        "downloads": stats.get("downloadCount"),
        "rating": stats.get("rating"),
        "thumbs_up": stats.get("thumbsUpCount"),
        "published": (raw.get("publishedAt") or "")[:10],
        "model_id": raw.get("modelId"),
        "version_id": raw.get("id"),
        "url": f"https://civitai.com/models/{raw.get('modelId')}?modelVersionId={raw.get('id')}"
               if raw.get("modelId") else None,
        "preview": images[0] if images else None,
        "description": (model.get("description") or "")[:400],
        "update": _check_update(raw.get("modelId"), raw.get("id")),
    }


def lookup_by_version(version_id):
    """Identify a LoRA we do NOT have, from provenance saved in a shared workflow."""
    raw = _get_json(CIVITAI_VERSION.format(version_id))
    if raw.get("_error"):
        return {"error": raw["_error"]}
    if raw.get("_notfound"):
        return {"found": False, "installed": False}
    d = _summarize(raw, "")
    d["installed"] = False
    return d


def search_url(lora_name):
    """A Civitai search for this filename, for when we have nothing better to go on."""
    import urllib.parse
    stem = os.path.splitext(os.path.basename(str(lora_name or "")))[0]
    # trim the noise trainers add: trailing step/epoch counts and version suffixes
    stem = re.sub(r"[-_]?(\d{4,}|e\d+|epoch\d+|step\d+|v\d+(\.\d+)?)$", "", stem, flags=re.I)
    return CIVITAI_SEARCH.format(urllib.parse.quote(stem.replace("_", " ").strip() or "lora"))


def lookup(lora_name, refresh=False):
    """name -> summary dict. Blocking (hashing + one HTTP call); call off the loop."""
    path = folder_paths.get_full_path("loras", lora_name)
    if not path:
        # not installed — the caller may still have provenance from the workflow
        return {"missing": True, "name": lora_name, "search_url": search_url(lora_name)}
    digest = file_sha256(path)
    cache = _load("civitai")
    hit = cache.get(digest)
    if not refresh and isinstance(hit, dict) and time.time() - hit.get("_at", 0) < _CACHE_TTL:
        return hit["data"]
    data = _summarize(_fetch_civitai(digest), digest)
    if not data.get("error"):                 # never cache transient network failures
        cache[digest] = {"_at": time.time(), "data": data}
        _store("civitai", cache)
    return data


# ---------------------------------------------------------------------------
# HTTP API for the frontend (the ⓘ button)
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/lora_download")
    async def _rednode_lora_download(request):
        """Start ONE verified download. Returns a job id to poll."""
        try:
            version_id = int((await request.json()).get("version_id"))
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        if any(j["state"] == "downloading" for j in _JOBS.values()):
            return web.json_response({"error": "a download is already running"}, status=409)
        _JOB_SEQ[0] += 1
        jid = str(_JOB_SEQ[0])
        _JOBS[jid] = {"state": "starting", "got": 0, "total": 0, "name": "", "error": None}
        threading.Thread(target=_download_job, args=(jid, version_id), daemon=True).start()
        return web.json_response({"job": jid})

    @PromptServer.instance.routes.get("/rednode/lora_download_status")
    async def _rednode_lora_download_status(request):
        job = _JOBS.get(request.query.get("job", ""))
        if not job:
            return web.json_response({"error": "unknown job"}, status=404)
        if request.query.get("cancel") == "1":
            job["cancel"] = True
        return web.json_response(job)

    @PromptServer.instance.routes.get("/rednode/lora_folders")
    async def _rednode_lora_folders(request):
        return web.json_response({"folders": lora_folders(), "current": get_download_dir()})

    @PromptServer.instance.routes.post("/rednode/lora_folders")
    async def _rednode_set_lora_folder(request):
        try:
            path = (await request.json()).get("path", "")
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        try:
            return web.json_response({"current": set_download_dir(path)})
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)

    @PromptServer.instance.routes.get("/rednode/lora_types")
    async def _rednode_lora_types(request):
        refresh = request.query.get("refresh") == "1"
        loop = asyncio.get_running_loop()
        types, times = await loop.run_in_executor(None, list_lora_types, refresh, True)
        kinds = sorted({v for v in types.values() if v and v != "Unknown"})
        return web.json_response({"types": types, "kinds": kinds, "times": times,
                                  "now": time.time()})

    @PromptServer.instance.routes.post("/rednode/lora_check_all")
    async def _rednode_lora_check_all(request):
        """Check a whole stack at once. Sequential on a worker thread: hashing is disk
        bound and Civitai is rate-limited, so this is deliberately unhurried."""
        try:
            names = (await request.json()).get("names") or []
        except Exception:
            return web.json_response({"error": "bad request body"}, status=400)
        names = [n for n in dict.fromkeys(names) if n and n != "None"][:64]

        def work():
            out = []
            for n in names:
                try:
                    d = lookup(n)
                except Exception as e:  # noqa: BLE001 — one bad file must not sink the batch
                    d = {"error": str(e)}
                out.append({
                    "name": n,
                    "found": bool(d.get("found")),
                    "error": d.get("error"),
                    "title": d.get("name"),
                    "version": d.get("version"),
                    "url": d.get("url"),
                    "update": d.get("update"),
                })
            return out

        loop = asyncio.get_running_loop()
        return web.json_response({"results": await loop.run_in_executor(None, work)})

    @PromptServer.instance.routes.get("/rednode/lora_info")
    async def _rednode_lora_info(request):
        name = request.query.get("name", "")
        if not name or name == "None":
            return web.json_response({"error": "no LoRA selected"}, status=400)
        refresh = request.query.get("refresh") == "1"
        vid = request.query.get("version_id")
        loop = asyncio.get_running_loop()
        # hashing is CPU/disk bound and files are large — keep it off the event loop
        data = await loop.run_in_executor(None, lookup, name, refresh)
        if data.get("missing") and vid:
            known = await loop.run_in_executor(None, lookup_by_version, vid)
            known.update(missing=True, search_url=data.get("search_url"))
            data = known
        return web.json_response(data)

except Exception as e:  # server/aiohttp unavailable (e.g. standalone tests)
    print(f"[RedNode Krea2] LoRA info HTTP route not registered: {e}", flush=True)
