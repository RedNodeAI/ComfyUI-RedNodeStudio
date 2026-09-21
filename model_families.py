"""One-click rig setups: find a model family's files by name and hand back its numbers.

The Models tab's Setup page asks here which of a family's files are installed. Each
role (the diffusion model, the text encoder, the VAE, or one checkpoint) is matched
against the file names ComfyUI already lists for its folder, newest first by the
file's date on disk, so a fresh download is the one picked. Nothing is downloaded
and nothing leaves the machine: file names from folder_paths and a local stat.

The numbers are the ones each family is known to run on. The panel writes them
into a rig; after that the rig is ordinary and every value stays editable.
"""

import os
import re

# role -> the ComfyUI folders its files live in
ROLE_FOLDERS = {
    "checkpoint": ("checkpoints",),
    "unet": ("diffusion_models", "unet"),
    "clip": ("text_encoders", "clip"),
    "vae": ("vae",),
}

# A role's match: every word in `all` is in the name, none in `none`, and at least
# one of `any` when given. Names are compared lower case with only letters and
# digits kept, so "Qwen_3_4B" and "qwen3-4b" read alike. `example` is what the page
# asks for when nothing matches.
FAMILIES = (
    {
        "id": "krea2_turbo",
        "label": "Krea 2 Turbo",
        "blurb": "The official distilled Krea 2. The model this pack is built around, and "
                 "the one Krea 2 Identity was trained on.",
        "roles": {
            # INT8 files need the INT8 loader and its model type, which a name cannot
            # tell, so they are left for the Files page
            "unet": {"all": ("krea2", "turbo"), "none": ("raw", "int8", "lora"),
                     "example": "krea2_turbo_fp8.safetensors in models/diffusion_models"},
            "clip": {"all": ("qwen3", "vl", "4b"), "none": (),
                     "example": "qwen3vl_4b_fp8_scaled.safetensors in models/text_encoders"},
            "vae": {"all": (), "any": ("qwenimagevae", "wan21vae"), "none": (),
                    "example": "qwen_image_vae.safetensors in models/vae"},
        },
        "rig": {"clip_type": "krea2", "steps": 8, "cfg": 1.0, "sampler": "euler",
                "scheduler": "simple", "official": True},
    },
    {
        "id": "zimage_turbo",
        "label": "Z-Image Turbo",
        "blurb": "Tongyi's distilled Z-Image: fast photoreal from a small model.",
        "roles": {
            "unet": {"all": ("zimage", "turbo"), "none": ("lora", "int8"),
                     "example": "z_image_turbo_bf16.safetensors in models/diffusion_models"},
            "clip": {"all": ("qwen34b",), "none": ("vl",),
                     "example": "qwen_3_4b.safetensors in models/text_encoders"},
            "vae": {"all": (), "any": ("ae", "fluxae", "fluxvae"), "exact_any": ("ae",), "none": (),
                    "example": "ae.safetensors (the Flux VAE) in models/vae"},
        },
        "rig": {"clip_type": "lumina2", "steps": 9, "cfg": 1.0, "sampler": "res_multistep",
                "scheduler": "simple"},
    },
    {
        "id": "sdxl",
        "label": "SDXL / Illustrious / Pony",
        "blurb": "One checkpoint file carries the model, its text encoders and its VAE.",
        "roles": {
            "checkpoint": {"all": (), "any": ("sdxl", "xl", "illustrious", "noobai", "pony"),
                           "none": ("refiner", "inpaint", "lora"),
                           "example": "an SDXL, Illustrious or Pony checkpoint in "
                                      "models/checkpoints"},
        },
        "rig": {"clip_type": "", "steps": 28, "cfg": 6.0, "sampler": "dpmpp_2m",
                "scheduler": "karras"},
    },
)

_BY_ID = {f["id"]: f for f in FAMILIES}


def _norm(text):
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def matches(name, rule):
    """Whether a file name fits a role's rule."""
    stem = _norm(os.path.splitext(os.path.basename(str(name)))[0])
    full = _norm(os.path.splitext(str(name))[0])
    if any(_norm(w) in full for w in rule.get("none", ())):
        return False
    if not all(_norm(w) in full for w in rule.get("all", ())):
        return False
    exact = rule.get("exact_any") or ()
    anyw = [w for w in (rule.get("any") or ()) if w not in exact]
    if exact or anyw:
        return stem in {_norm(w) for w in exact} or any(_norm(w) in full for w in anyw)
    return True


def _listed(role):
    """[(name, mtime)] for every file ComfyUI lists in the role's folders."""
    try:
        import folder_paths
    except Exception:
        return []
    out, seen = [], set()
    for folder in ROLE_FOLDERS[role]:
        try:
            names = folder_paths.get_filename_list(folder)
        except Exception:
            continue
        for n in names:
            if n in seen:
                continue
            seen.add(n)
            try:
                path = folder_paths.get_full_path(folder, n)
                mt = os.path.getmtime(path) if path else 0.0
            except Exception:
                mt = 0.0
            out.append((n, mt))
    return out


def find(family_id, listed=None):
    """{role: [names, newest first]} for one family. `listed` may be injected (tests):
    it takes a role and returns [(name, mtime)]."""
    fam = _BY_ID.get(family_id)
    if not fam:
        return None
    lister = listed or _listed
    found = {}
    for role, rule in fam["roles"].items():
        hits = [(n, mt) for n, mt in lister(role) if matches(n, rule)]
        hits.sort(key=lambda x: -x[1])
        found[role] = [n for n, _ in hits]
    return found


def describe():
    """The families for the panel: labels, what each role wants, and the numbers."""
    return [{"id": f["id"], "label": f["label"], "blurb": f["blurb"],
             "roles": {r: {"example": rule["example"]} for r, rule in f["roles"].items()},
             "rig": dict(f["rig"])} for f in FAMILIES]


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/rednode/model_families")
    async def _rednode_model_families(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        fams = describe()
        want = str(data.get("family") or "")
        for f in fams:
            if not want or f["id"] == want:
                f["found"] = find(f["id"])
        return web.json_response({"families": fams})
except Exception as e:  # no server (tests, a bare import)
    print("[RedNode Krea2] model family route not registered: %s" % e, flush=True)
