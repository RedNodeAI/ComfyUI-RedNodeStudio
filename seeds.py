"""Linked seeds: which seed each part of a run takes.

The Seed tab's number is Main, the run seed: prompts, wildcards, every render pass
and the paint pass always take it. Other parts can be linked to Main, or to a named
seed of your own, or left on "own", which is what each did before links existed:
its page's own seed or its own random roll. Nothing is linked until you link it.

A named seed is a number, or a fresh roll every queue when it is random.

"Same seed every pass" gives every pass of a render, and every pass of a Detailer
stage, the one seed instead of the seed plus the pass number.
"""

import random as _random

# the parts that can be linked, in the order the Seed tab lists them
AREAS = ("reangle", "realism", "swap", "upscale", "detailer", "loras", "post", "auto")


def parse(raw):
    r = raw if isinstance(raw, dict) else {}
    extra = []
    seen = {"main", "own"}
    for s in (r.get("extra") or [])[:16]:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").strip()[:32]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        try:
            val = max(0, min(2 ** 53, int(s.get("seed", 0))))
        except (TypeError, ValueError):
            val = 0
        extra.append({"name": name, "seed": val, "random": bool(s.get("random"))})
    names = {e["name"] for e in extra}
    links_in = r.get("links") if isinstance(r.get("links"), dict) else {}
    links = {}
    for a in AREAS:
        v = str(links_in.get(a) or "own")
        links[a] = v if v in ("main", "own") or v in names else "own"
    return {"extra": extra, "links": links, "same_pass": bool(r.get("same_pass"))}


def values(scfg, run_seed, rng=None):
    """{seed name: the number it has this queue}; Main is the run seed."""
    rng = rng or _random
    out = {"main": int(run_seed)}
    for e in scfg.get("extra") or []:
        out[e["name"]] = rng.getrandbits(48) if e["random"] else int(e["seed"])
    return out


def seed_for(scfg, vals, area):
    """The linked seed for `area`, or None when it keeps its own."""
    link = (scfg.get("links") or {}).get(area, "own")
    return None if link == "own" else vals.get(link)


def any_random_link(scfg):
    """A linked seed that re-rolls, so the node has to run again every queue."""
    rolls = {e["name"] for e in scfg.get("extra") or [] if e["random"]}
    return any(v in rolls for v in (scfg.get("links") or {}).values())
