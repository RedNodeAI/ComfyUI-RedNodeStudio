"""The identity forward must find its references however ComfyUI passes them.

ComfyUI calls the Krea 2 diffusion model's forward through a wrapper executor, and the
argument layout has changed between releases:

    older:  (x, timesteps, context, attention_mask, transformer_options)
    0.29.2: (x, timesteps, context, attention_mask, ref_latents, transformer_options)

Our patched _forward accepts both by swallowing the extra positionals into *_drift and
unpacking them. The failure this file exists to prevent: the "no identity extras, hand
off to stock" check ran BEFORE that unpacking and only inspected kwargs. On 0.29.2,
where ref_latents arrives positionally, it saw nothing, concluded there was no identity
work, and delegated to the stock forward — skipping the reference attention bias,
ref_boost, the edit mask, the fidelity dials, isolate_refs and t0 modulation on every
run. Nothing raised; faces just came out as somebody else, and no dial changed anything
because the code that reads the dials was never reached.

Run standalone:  python tests/test_forward_signature.py
"""
import importlib.util
import inspect
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PACK = os.path.dirname(_HERE)
for _c in [os.environ.get("COMFYUI_ROOT"), os.path.dirname(os.path.dirname(_PACK)),
           r"E:\Comfy Ui\ComfyUI_windows_portable\ComfyUI"]:
    if _c and os.path.isfile(os.path.join(_c, "comfy", "model_base.py")):
        if _c not in sys.path:
            sys.path.insert(0, _c)
        break

fails = []


def check(name, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'' if cond else '  ' + detail}")
    if not cond:
        fails.append(name)


def main():
    src = open(os.path.join(_PACK, "identity.py"), encoding="utf-8").read()
    body = src.split("def _krea2_forward(", 1)
    check("the patched forward exists", len(body) == 2)
    if len(body) != 2:
        return 1
    fn = body[1].split("\ndef ", 1)[0]

    # 1. The drift unpack must come BEFORE the delegation check, or positional
    #    ref_latents are invisible to it.
    unpack = fn.find("native_ref = drift.pop(0)")
    if unpack < 0:
        unpack = fn.find("drift = list(_drift)")
    delegate = fn.find("_rednode_orig_forward")
    check("the drift unpack runs before the stock delegation",
          unpack >= 0 and delegate >= 0 and unpack < delegate,
          f"unpack@{unpack} delegate@{delegate}")

    # 2. The delegation decision must not be made from kwargs alone.
    decide = re.search(r"if not (.+?):\s*\n\s*orig = SingleStreamDiT", fn)
    check("a delegation decision is present", bool(decide))
    if decide:
        expr = decide.group(1)
        check("it tests the merged references, not just kwargs",
              "kwargs.get" not in expr, f"decides on: {expr!r}")

    # 3. Both documented call shapes must be accepted by the signature itself.
    spec = importlib.util.spec_from_file_location("_rn_identity_src",
                                                  os.path.join(_PACK, "identity.py"))
    sig_line = next(l for l in src.splitlines() if l.startswith("def _krea2_forward("))
    check("extra positionals are swallowed rather than rejected",
          "*_drift" in sig_line, sig_line)
    check("transformer_options is still accepted by keyword",
          "transformer_options=None" in sig_line, sig_line)

    # 4. If ComfyUI is importable, assert the REAL call shape is one we handle: the
    #    executor passes everything after `self` positionally, so count what forward
    #    hands it and make sure *_drift can absorb the surplus.
    try:
        from comfy.ldm.krea2.model import SingleStreamDiT
        fwd = inspect.signature(SingleStreamDiT.forward)
        names = [p for p in fwd.parameters if p != "self"]
        named = [n for n in ("x", "timesteps", "context", "attention_mask") if n in names]
        check("core forward still starts with the four we bind by name",
              len(named) == 4, str(names))
        surplus = [n for n in names
                   if n not in ("self", "x", "timesteps", "context", "attention_mask",
                                "kwargs")]
        print(f"        (this core passes {len(surplus)} extra arg(s): {surplus})")
    except Exception as e:
        print(f"        (ComfyUI not importable here, skipping the live check: {e})")

    print("=" * 52)
    print(f"{len(fails)} FAILURE(S): {fails}" if fails else "ALL PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
