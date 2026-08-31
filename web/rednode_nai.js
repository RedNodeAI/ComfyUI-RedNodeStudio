// The NovelAI rig's panel UI - The NovelAI rig's panel: public since 2026-08-19.
// One-for-one with ComfyUI_NAIDGenerator's option set, per the user's call.
// Settings write onto the rig object and ride the config JSON; the backend
// reads them off the rig's raw dict (nai_rig.py). No image content is
// ever inspected here - the vibe picker forwards bytes untouched.

window.rnRigKinds = ["novelai", ...(window.rnRigKinds || [])
  .filter((k) => k !== "novelai")];
window.rnLocalRigLabel = (k) => (k === "novelai" ? "NovelAI (personal)" : k);

const NAI_MODELS = [
  "nai-diffusion-5-full", "nai-diffusion-5-curated",
  "nai-diffusion-4-5-full", "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full", "nai-diffusion-4-curated-preview",
  "nai-diffusion-3", "nai-diffusion-furry-3", "nai-diffusion-2",
];
const isV5 = (m) => String(m || "").startsWith("nai-diffusion-5");

window.rnLocalRigUI = (node, body, rig, ctx) => {
  if (rig.kind !== "novelai") return;
  const note = document.createElement("div");
  note.className = "rn-ws-note";
  note.textContent = "Renders through the NovelAI API at queue time. Prompt "
    + "from this rig's Prompts-tab row; size from the Latent tab; steps, "
    + "guidance (CFG), the NAI sampler name and the noise schedule from the "
    + "Sampler box (scheduler = native, karras, exponential or "
    + "polyexponential). The Denoise dial is i2i strength when an image "
    + "feeds the i2i tab. Token: the NAI_ACCESS_TOKEN environment variable, or the Token row below.";
  body.appendChild(note);

  const row = (label, el) => {
    const r = document.createElement("div");
    r.className = "rn-ws-row";
    const l = document.createElement("span");
    l.className = "rn-ws-note";
    l.style.cssText = "flex:none;width:110px";
    l.textContent = label;
    r.append(l, el);
    body.appendChild(r);
    return r;
  };
  const toggle = (label, key, dv, tip) => {
    const cur = rig[key] === undefined ? dv : !!rig[key];
    const b = document.createElement("button");
    b.className = "rn-ws-on" + (cur ? " on" : "");
    b.style.width = "auto";
    b.style.padding = "0 10px";
    b.textContent = label + (cur ? ": on" : ": off");
    b.title = tip;
    b.onclick = () => { rig[key] = !cur; ctx.write(); ctx.redraw(); };
    return b;
  };
  const select = (values, cur, onpick, tip) => {
    const el = document.createElement("select");
    el.className = "rn-ws-res";
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      o.selected = v === cur;
      el.appendChild(o);
    }
    el.title = tip;
    el.onchange = () => { onpick(el.value); ctx.write(); };
    return el;
  };
  const numBox = (key, dv, min, max, step, tip) => {
    const el = document.createElement("input");
    el.type = "number";
    el.min = min; el.max = max; el.step = step;
    el.value = String(rig[key] ?? dv);
    el.style.width = "70px";
    el.title = tip;
    el.onchange = () => {
      rig[key] = Math.max(min, Math.min(max, parseFloat(el.value) || dv));
      el.value = String(rig[key]);
      ctx.write();
    };
    el.addEventListener("wheel", () => el.blur(), { passive: true });
    return el;
  };

  // THE TOKEN, first, because nothing else on this rig works without one. It
  // is written to the ComfyUI user directory by a route and NEVER into the
  // workflow: a token in a graph is a credential you hand over every time you
  // share the graph. The panel only ever learns whether one is present.
  {
    const state = document.createElement("span");
    state.className = "rn-ws-note";
    state.textContent = "checking...";
    const box = document.createElement("input");
    box.type = "password";
    box.placeholder = "paste your NovelAI persistent token (pst-...)";
    box.style.cssText = "flex:1;min-width:120px;background:#15171b;border:1px solid "
      + "#33373d;border-radius:4px;color:#e8ecf1;font-size:12px;padding:4px 6px";
    box.title = "Your own NovelAI subscription token. Stored in the ComfyUI user "
              + "folder, never in this workflow, and never shown again once set. "
              + "NAI_ACCESS_TOKEN in the environment wins over it.";
    const save = document.createElement("button");
    save.className = "rn-ws-btn";
    save.style.cssText = "width:auto;padding:0 10px";
    save.textContent = "Set";
    const refresh = async () => {
      try {
        const api = (await import("../../scripts/api.js")).api;
        const d = await (await api.fetchApi("/rednode/nai_token")).json();
        state.textContent = d.present
          ? (d.source === "environment" ? "set (from NAI_ACCESS_TOKEN)" : "set")
          : "not set: this rig cannot render yet";
        state.style.color = d.present ? "#86d3a1" : "#e0a84a";
        save.textContent = d.present ? "Replace" : "Set";
      } catch (e) { state.textContent = "cannot reach the server"; }
    };
    save.onclick = async () => {
      const tok = box.value.trim();
      if (!tok) return;
      try {
        const api = (await import("../../scripts/api.js")).api;
        await api.fetchApi("/rednode/nai_token", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tok }),
        });
        box.value = "";
        refresh();
      } catch (e) {
        state.textContent = "could not store it: " + e.message;
      }
    };
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:6px;flex:1;align-items:center";
    wrap.append(box, save);
    row("Token", wrap);
    row("", state);
    refresh();
  }

  row("Model", select(NAI_MODELS, rig.nai_model || "nai-diffusion-4-5-full",
                      (v) => { rig.nai_model = v; ctx.redraw(); },
                      "Which NovelAI model renders. V5 (2026-08-21) is the "
                      + "current generation; it has no Vibe Transfer yet, so "
                      + "this panel says so when a V5 model is picked."));

  // the site's sampler dropdown: display names, Recommended on top. Writes
  // the rig's sampler field with the API name, same field the Sampler box
  // free-text edits.
  {
    const groups = [
      ["RECOMMENDED", [["Euler Ancestral", "k_euler_ancestral"]]],
      ["OTHER", [["Euler", "k_euler"],
                 ["DPM++ 2S Ancestral", "k_dpmpp_2s_ancestral"],
                 ["DPM++ 2M SDE", "k_dpmpp_2m_sde"],
                 ["DPM++ 2M", "k_dpmpp_2m"],
                 ["DPM++ SDE", "k_dpmpp_sde"]]],
    ];
    const el = document.createElement("select");
    el.className = "rn-ws-res";
    for (const [gname, entries] of groups) {
      const og = document.createElement("optgroup");
      og.label = gname;
      for (const [label, value] of entries) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        o.selected = value === rig.sampler;
        og.appendChild(o);
      }
      el.appendChild(og);
    }
    el.title = "NAI's sampler, the site's list. Euler Ancestral is NAI's "
             + "recommendation.";
    el.onchange = () => { rig.sampler = el.value; ctx.write(); };
    row("Sampler", el);
  }

  const grow = document.createElement("div");
  grow.className = "rn-ws-row";
  const glab = document.createElement("span");
  glab.className = "rn-ws-note";
  glab.style.cssText = "flex:none;width:110px";
  glab.textContent = "Guidance";
  const gnum = numBox("cfg", 5.0, 0, 10, 0.1,
      "Prompt Guidance, the site's dial: how strongly the prompt steers. "
      + "This IS the rig's CFG field, shown here with NAI's name and range.");
  gnum.value = String(rig.cfg ?? 5.0);
  gnum.onchange = () => {
    rig.cfg = Math.max(0, Math.min(10, parseFloat(gnum.value) || 5.0));
    gnum.value = String(rig.cfg);
    ctx.write();
  };
  grow.append(glab, gnum);
  body.appendChild(grow);

  row("UC preset", select(["Heavy", "Light", "Human Focus", "None"],
      ["Heavy", "Light", "Human Focus", "None"][rig.nai_ucpreset ?? 0],
      (v) => {
        rig.nai_ucpreset = ["Heavy", "Light", "Human Focus", "None"].indexOf(v);
        ctx.write();
      },
      "Undesired Content Preset, the site's Settings pane: a server-side "
      + "negative baseline layered under your own negative."));

  const togRow = document.createElement("div");
  togRow.className = "rn-ws-row";
  togRow.append(
    toggle("Quality tags", "nai_quality", true,
           "Add Quality Tags, the site's Settings pane: the server prepends "
           + "its quality tags to the prompt."),
    toggle("Free limit", "nai_free", true,
           "The Opus free-tier limiter, on by default like the NAID node: "
           + "clamps the canvas to 1024x1024 pixels and steps to 28 so the "
           + "generation stays free. V5 is the first generation NAI also "
           + "caps by count for Opus, so this clamp no longer means "
           + "unlimited there."),
    toggle("Variety", "nai_variety", false,
           "NAI's variety boost: skip cfg above sigma, sized to the canvas."),
    toggle("Decrisper", "nai_decrisper", false,
           "NAI's decrisper (dynamic thresholding)."));
  body.appendChild(togRow);

  row("SMEA", select(["none", "SMEA", "SMEA+DYN"], rig.nai_smea || "none",
                     (v) => { rig.nai_smea = v; },
                     "SMEA sampling for large canvases; DYN adds the dynamic "
                     + "variant. Ignored on ddim, same as NAI."));

  const dials = document.createElement("div");
  dials.className = "rn-ws-row";
  const dlab = (t) => {
    const l = document.createElement("span");
    l.className = "rn-ws-note";
    l.textContent = t;
    return l;
  };
  dials.append(
    dlab("Uncond"), numBox("nai_uncond", 1.0, 0, 1.5, 0.05,
        "uncond_scale, NAI's undesired content strength. 1.0 is neutral."),
    dlab("Rescale"), numBox("nai_rescale", 0.0, 0, 1, 0.02,
        "cfg_rescale. 0 off; higher tames burn at high guidance."),
    dlab("i2i noise"), numBox("nai_noise", 0.0, 0, 0.99, 0.02,
        "Extra noise for i2i, NAI's own dial. 0 leaves it alone."));
  body.appendChild(dials);

  // CHARACTER PROMPTS, the NAI site's card list: each character a card with
  // Prompt / Undesired Content tabs, reorder arrows, fold, a 5x5 position
  // picker, and the global "AI's Choice" control at the bottom.
  {
    const list = rig.nai_character = rig.nai_character || [];
    const head = document.createElement("div");
    head.className = "rn-ws-row";
    const ht = document.createElement("span");
    ht.className = "rn-ws-note";
    ht.style.fontWeight = "700";
    ht.textContent = "Character Prompts";
    const addC = document.createElement("button");
    addC.textContent = "＋ Add Character";
    addC.onclick = () => {
      list.push({ prompt: "", negative: "", center: { x: 0.5, y: 0.5 },
                  use_coords: false });
      ctx.write(); ctx.redraw();
    };
    const spring = document.createElement("span");
    spring.style.flex = "1";
    head.append(ht, spring, addC);
    body.appendChild(head);

    const CELLS = [0.1, 0.3, 0.5, 0.7, 0.9];
    list.forEach((c, i) => {
      const card = document.createElement("div");
      card.style.cssText = "display:flex;flex-direction:column;gap:5px;"
        + "background:#15171b;border:1px solid #2a2e34;border-radius:6px;"
        + "padding:6px";
      const top = document.createElement("div");
      top.style.cssText = "display:flex;align-items:center;gap:6px";
      const name = document.createElement("span");
      name.className = "rn-ws-note";
      name.style.cssText = "flex:1;cursor:pointer;font-weight:600;color:#c8ccd2";
      name.textContent = "\u{1F464} Character " + (i + 1)
        + (c.folded && c.prompt ? " · " + c.prompt.slice(0, 32) : "");
      name.title = "Click to fold or unfold this character.";
      name.onclick = () => { c.folded = !c.folded; ctx.write(); ctx.redraw(); };
      const mk = (t, tip, fn, dis) => {
        const b = document.createElement("button");
        b.textContent = t;
        b.title = tip;
        b.disabled = !!dis;
        b.style.padding = "1px 7px";
        b.onclick = fn;
        return b;
      };
      top.append(name,
        mk("▲", "Move this character up; order matters to NAI.", () => {
          if (i > 0) {
            [list[i - 1], list[i]] = [list[i], list[i - 1]];
            ctx.write(); ctx.redraw();
          }
        }, i === 0),
        mk("▼", "Move this character down.", () => {
          if (i < list.length - 1) {
            [list[i + 1], list[i]] = [list[i], list[i + 1]];
            ctx.write(); ctx.redraw();
          }
        }, i === list.length - 1),
        mk("✕", "Remove this character.", () => {
          list.splice(i, 1);
          ctx.write(); ctx.redraw();
        }));
      card.appendChild(top);

      if (!c.folded) {
        const tabs = document.createElement("div");
        tabs.style.cssText = "display:flex;gap:6px";
        const mkTab = (label, key) => {
          const on = (c.ui_tab || "prompt") === key;
          const b = document.createElement("button");
          b.textContent = label;
          b.style.cssText = "padding:1px 8px;font-size:11px"
            + (on ? ";background:#b8283c;border-color:#b8283c;color:#fff" : "");
          b.onclick = () => { c.ui_tab = key; ctx.write(); ctx.redraw(); };
          return b;
        };
        tabs.append(mkTab("Prompt", "prompt"),
                    mkTab("Undesired Content", "negative"));
        card.appendChild(tabs);
        const ta = document.createElement("textarea");
        ta.rows = 2;
        ta.style.cssText = "background:#0f1114;border:1px solid #33373d;"
          + "border-radius:4px;color:#e8ecf1;font-size:12px;padding:4px 7px;"
          + "resize:vertical";
        const key = (c.ui_tab || "prompt") === "negative" ? "negative"
                                                          : "prompt";
        ta.value = c[key] || "";
        ta.placeholder = key === "prompt" ? "girl, red hair, ..."
                                          : "undesired content for this "
                                            + "character";
        ta.onchange = () => { c[key] = ta.value; ctx.write(); };
        card.appendChild(ta);

        const pos = document.createElement("div");
        pos.style.cssText = "display:flex;align-items:center;gap:6px";
        const plab = document.createElement("span");
        plab.className = "rn-ws-note";
        plab.textContent = "Position";
        const pbtn = document.createElement("button");
        pbtn.textContent = c.use_coords
          ? c.center.x.toFixed(1) + ", " + c.center.y.toFixed(1)
          : "AI's Choice";
        pbtn.title = "Where this character stands. AI's Choice lets NAI "
                   + "decide; picking a cell pins it.";
        pbtn.onclick = () => { c.ui_pick = !c.ui_pick; ctx.redraw(); };
        pos.append(plab, pbtn);
        if (c.use_coords) {
          const clear = document.createElement("button");
          clear.textContent = "AI's Choice";
          clear.title = "Unpin: let NAI place this character.";
          clear.onclick = () => {
            c.use_coords = false;
            c.center = { x: 0.5, y: 0.5 };
            ctx.write(); ctx.redraw();
          };
          pos.appendChild(clear);
        }
        card.appendChild(pos);
        if (c.ui_pick) {
          const grid = document.createElement("div");
          grid.style.cssText = "display:grid;grid-template-columns:repeat(5,"
            + "22px);gap:3px;padding:4px";
          CELLS.forEach((y) => CELLS.forEach((x) => {
            const cell = document.createElement("div");
            const on = c.use_coords && c.center.x === x && c.center.y === y;
            cell.style.cssText = "width:22px;height:22px;border-radius:3px;"
              + "cursor:pointer;border:1px solid #33373d;background:"
              + (on ? "#b8283c" : "#1a1d22");
            cell.title = x + ", " + y;
            cell.onclick = () => {
              c.center = { x, y };
              c.use_coords = true;
              c.ui_pick = false;
              ctx.write(); ctx.redraw();
            };
            grid.appendChild(cell);
          }));
          card.appendChild(grid);
        }
      }
      body.appendChild(card);
    });

    if (list.length) {
      const foot = document.createElement("div");
      foot.className = "rn-ws-row";
      const fl = document.createElement("span");
      fl.className = "rn-ws-note";
      fl.textContent = "Character Positions (Global)";
      const anyPinned = list.some((c) => c.use_coords);
      const fb = document.createElement("button");
      fb.textContent = anyPinned ? "Use pinned positions" : "✔ AI's Choice";
      fb.title = "AI's Choice everywhere: one click unpins every character "
               + "and lets NAI place them all.";
      fb.onclick = () => {
        list.forEach((c) => {
          c.use_coords = false;
          c.center = { x: 0.5, y: 0.5 };
        });
        ctx.write(); ctx.redraw();
      };
      const spring2 = document.createElement("span");
      spring2.style.flex = "1";
      foot.append(fl, spring2, fb);
      body.appendChild(foot);
    }
  }

  // The models whose vibes are ENCODED (server-side, 2 Anlas a time) rather
  // than sent as pixels: mirrors _VIBE_MODEL_KEYS in nai_rig.py.
  const V4_VIBE_MODELS = ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated",
                          "nai-diffusion-4-full", "nai-diffusion-4-curated-preview"];

  // VIBE TRANSFER: multiple slots, each a file pick with strength and info.
  // The file's bytes go straight to base64; nothing reads the picture.
  const vibes = rig.nai_vibe || [];
  vibes.forEach((v, i) => {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;gap:6px;align-items:center;flex:1";
    const tag = document.createElement("span");
    tag.className = "rn-ws-note";
    tag.textContent = (v.name || ("vibe " + (i + 1)))
                    + (v.naiv4vibe ? " (.naiv4vibe)" : "");
    const st = numBox("__vs" + i, v.strength ?? 0.6, 0, 1, 0.05,
                      "This vibe's strength.");
    st.value = String(v.strength ?? 0.6);
    st.onchange = () => {
      v.strength = Math.max(0, Math.min(1, parseFloat(st.value) || 0.6));
      ctx.write();
    };
    line.append(tag, st);
    if (!v.naiv4vibe) {
      // an encoding file carries its own information_extracted; images get
      // the dial
      const inf = numBox("__vi" + i, v.info ?? 1.0, 0, 1, 0.05,
                         "Information extracted for this vibe.");
      inf.value = String(v.info ?? 1.0);
      inf.onchange = () => {
        v.info = Math.max(0, Math.min(1, parseFloat(inf.value) || 1.0));
        ctx.write();
      };
      line.append(inf);
    }
    // ENCODE: the one button here that spends money, so it says the price and
    // asks first (the user, 2026-08-18). A raw image on V4/V4.5 is encoded by
    // NovelAI on EVERY render at 2 Anlas a time; encoding it once writes a
    // .naiv4vibe next to it and every render after that is free. Re-encoding
    // the same picture at the same Information costs nothing: the file is
    // reused. V5 has no Vibe Transfer, so the button stays away there.
    if (!v.naiv4vibe && v.file && V4_VIBE_MODELS.includes(rig.nai_model)) {
      const enc = document.createElement("button");
      enc.textContent = "Encode · 2 Anlas";
      enc.title = "Encode this picture into a .naiv4vibe once, for " + rig.nai_model
                + " at Information " + (v.info ?? 1.0) + ". Costs 2 Anlas the first "
                + "time; after that this vibe is free to render, and re-encoding the "
                + "same picture at the same Information costs nothing. Without it, "
                + "NovelAI encodes the picture again on every render and charges "
                + "every time.";
      enc.onclick = async () => {
        if (!confirm("Encode this vibe for " + rig.nai_model + " at Information "
                     + (v.info ?? 1.0) + "?\n\nThis spends 2 Anlas the first time. "
                     + "The same picture at the same Information is free afterwards.")) {
          return;
        }
        enc.disabled = true;
        enc.textContent = "Encoding...";
        try {
          const r = await api.fetchApi("/rednode/nai_vibe_encode", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: v.file, model: rig.nai_model,
                                   info: v.info ?? 1.0, name: v.name || "vibe" }),
          });
          const d = await r.json();
          if (d.error) throw new Error(d.error);
          // the entry becomes the encoded file; the picture stays on disk
          v.file = d.file;
          v.naiv4vibe = true;
          v.name = (v.name || "vibe") + " (encoded)";
          ctx.write(); ctx.redraw();
          console.log("[RedNode NAI] vibe encoded:", d.file,
                      d.spent ? "(2 Anlas spent)" : "(already encoded, free)");
        } catch (e) {
          console.error("[RedNode NAI] vibe encode failed:", e);
          alert("Could not encode this vibe: " + e.message);
          enc.disabled = false;
          enc.textContent = "Encode · 2 Anlas";
        }
      };
      line.append(enc);
    }
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Remove this vibe.";
    del.onclick = () => { vibes.splice(i, 1); ctx.write(); ctx.redraw(); };
    line.append(del);
    row(i === 0 ? "Vibe" : "", line);
  });
  const add = document.createElement("button");
  add.textContent = "＋ Add vibe (image or .naiv4vibe)";
  add.title = "A picture is uploaded to input/rednode/nai_vibe and resized to "
            + "the canvas at send time; a .naiv4vibe file (exported from the "
            + "NAI site) sends its precomputed encoding for the current "
            + "model. Only the FILENAME lives in the workflow: bytes in the "
            + "config bloated saves and broke the draft autosave.";
  add.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/png,image/jpeg,image/webp,.naiv4vibe,application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const isEnc = /\.naiv4vibe$/i.test(f.name);
      const api = (await import("../../scripts/api.js")).api;
      const body = new FormData();
      let rel = "";
      try {
        if (isEnc) {
          body.append("file", f, f.name);
          const r = await api.fetchApi("/rednode/nai_vibe_upload",
                                       { method: "POST", body });
          const d = await r.json();
          if (!d.file) throw new Error(d.error || "upload failed");
          rel = d.file;
        } else {
          body.append("image", f, f.name);
          body.append("type", "input");
          body.append("subfolder", "rednode/nai_vibe");
          const r = await api.fetchApi("/upload/image",
                                       { method: "POST", body });
          const d = await r.json();
          if (!d.name) throw new Error("upload returned no name");
          rel = d.subfolder ? d.subfolder + "/" + d.name : d.name;
        }
      } catch (e) {
        console.warn("[RedNode NAI] vibe upload failed:", e);
        return;
      }
      rig.nai_vibe = [...(rig.nai_vibe || []),
                      { file: rel, strength: 0.6, info: 1.0,
                        naiv4vibe: isEnc, name: f.name }];
      ctx.write(); ctx.redraw();
    };
    inp.click();
  };
  row(vibes.length ? "" : "Vibe", add);
  {
    const raw = vibes.filter((v) => !v.naiv4vibe);
    if (raw.length && V4_VIBE_MODELS.includes(rig.nai_model)) {
      const warn = document.createElement("div");
      warn.className = "rn-ws-note";
      warn.style.color = "#e0a84a";
      warn.textContent = raw.length + " vibe" + (raw.length === 1 ? " is" : "s are")
        + " a raw picture, so " + rig.nai_model + " encodes "
        + (raw.length === 1 ? "it" : "them") + " again every render: "
        + (2 * raw.length) + " Anlas per image. Press Encode to pay once.";
      row("", warn);
    }
  }

  // V5 shipped without Vibe Transfer; the backend drops vibes on V5 rather
  // than let the request 400, so say it here instead of in the console only
  if (isV5(rig.nai_model || "nai-diffusion-4-5-full")) {
    const v5note = document.createElement("div");
    v5note.className = "rn-ws-note";
    v5note.style.color = "#f0a0a8";
    v5note.textContent = "V5 has no Vibe Transfer yet, so any vibe listed "
      + "here is left out of a V5 render. The entries stay on the rig and "
      + "come back the moment you pick a V4.x model.";
    body.appendChild(v5note);
  }

  // vibes saved by the first build carry their bytes inline; say so, since
  // that entry is what bloats the workflow, and offer the one-click cure
  const inline = vibes.filter((v) => v.data && !v.file);
  if (inline.length) {
    const warn = document.createElement("div");
    warn.className = "rn-ws-note";
    warn.style.color = "#f0a0a8";
    warn.textContent = inline.length + " vibe(s) still hold their bytes "
      + "inside this workflow (the old way), which is what breaks the draft "
      + "autosave. Remove and re-add them, or click Drop inline vibes.";
    const drop = document.createElement("button");
    drop.textContent = "Drop inline vibes";
    drop.onclick = () => {
      rig.nai_vibe = vibes.filter((v) => !(v.data && !v.file));
      ctx.write(); ctx.redraw();
    };
    const wrow = document.createElement("div");
    wrow.className = "rn-ws-row";
    wrow.append(warn, drop);
    body.appendChild(wrow);
  }
};
