// What a picture says about itself, read in the browser. A PNG this pack saved
// holds the A1111 "parameters" text (the prompt, the negative, one settings
// line), the "civitaiResources" list, and, with embedding on, ComfyUI's
// "workflow" and "prompt" chunks, where the Workspace's whole config sits as
// its widget value. Any other PNG with a parameters chunk gives at least the
// prompt. Nothing here talks to the server: the bytes come from a file the
// user picked or a saved picture fetched for viewing.

// the text chunks of a PNG, keyword to text; tEXt and uncompressed iTXt
export function pngTextChunks(buf) {
  const out = {};
  try {
    const u8 = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (u8.length < 8 || sig.some((b, i) => u8[i] !== b)) return out;
    const dv = new DataView(buf);
    const latin = (a, b) => { let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };
    const utf8 = new TextDecoder("utf-8");
    let p = 8;
    while (p + 8 <= u8.length) {
      const len = dv.getUint32(p);
      const type = latin(p + 4, p + 8);
      const a = p + 8, b = a + len;
      if (b > u8.length) break;
      if (type === "tEXt") {
        const z = u8.indexOf(0, a);
        if (z > 0 && z < b) out[latin(a, z)] = latin(z + 1, b);
      } else if (type === "iTXt") {
        const z = u8.indexOf(0, a);
        if (z > 0 && z < b) {
          const key = latin(a, z);
          const comp = u8[z + 1];
          // language tag and translated keyword, each zero-ended
          let q = z + 3;
          q = u8.indexOf(0, q) + 1;
          q = u8.indexOf(0, q) + 1;
          if (comp === 0 && q > 0 && q <= b) out[key] = utf8.decode(u8.subarray(q, b));
        }
      } else if (type === "IEND") break;
      p = b + 4;
    }
  } catch (e) { /* not a png we can read */ }
  return out;
}

// the A1111 parameters text: the prompt, "Negative prompt: ...", then one
// settings line. Keys are picked out one by one, since the line also carries
// JSON with commas of its own.
export function parseParameters(text) {
  const t = String(text || "").replace(/\r/g, "");
  if (!t.trim()) return null;
  const lines = t.split("\n");
  let settingsAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Steps: \d+|^Seed: \d+|, Seed: \d+|^Size: \d+x\d+/.test(lines[i])) { settingsAt = i; break; }
  }
  const bodyLines = settingsAt >= 0 ? lines.slice(0, settingsAt) : lines;
  const settingsLine = settingsAt >= 0 ? lines[settingsAt] : "";
  const body = bodyLines.join("\n");
  const negAt = body.indexOf("Negative prompt:");
  const positive = (negAt >= 0 ? body.slice(0, negAt) : body).trim();
  const negative = negAt >= 0 ? body.slice(negAt + "Negative prompt:".length).trim() : "";
  const grab = (re) => { const m = settingsLine.match(re); return m ? m[1].trim() : ""; };
  const num = (v) => (v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const size = settingsLine.match(/Size: (\d+)x(\d+)/);
  return {
    positive, negative,
    settings: {
      steps: num(grab(/Steps: ([\d.]+)/)),
      sampler: grab(/Sampler: ([^,]+)/),
      scheduler: grab(/Schedule type: ([^,]+)/),
      cfg: num(grab(/CFG scale: ([\d.]+)/)),
      seed: num(grab(/Seed: (\d+)/)),
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      denoise: num(grab(/Denoising strength: ([\d.]+)/)),
      model: grab(/(?:^|, )Model: ([^,]+)/),
      clip_skip: num(grab(/Clip skip: (\d+)/)),
      // "Lora hashes": name to its 12-character hash, as A1111 and Neo write it
      lora_hashes: Object.fromEntries((grab(/Lora hashes: "([^"]*)"/) || "").split(",")
        .map((x) => x.split(":").map((y) => y.trim())).filter((x) => x.length === 2 && x[0] && x[1])),
      shift: num(grab(/(?:^|, )Shift: ([\d.]+)/)),
    },
  };
}

// <lora:name:weight> tags, the way A1111 / Forge / Neo write them in the prompt:
// the LoRAs in order, and the words with the tags and their loose commas taken out
export function loraTags(text) {
  const loras = [];
  const clean = String(text || "").replace(/<(lora|lyco):([^:>]+)(?::([^:>]*))?(?::[^>]*)?>/gi, (m, kind, name, w) => {
    const v = Number(String(w ?? "1").trim());
    loras.push({ name: name.trim(), weight: Number.isFinite(v) ? v : 1 });
    return "";
  });
  const words = clean.split("\n").map((l) => l.replace(/\s*,(\s*,)+/g, ",").replace(/^[\s,]+|[\s,]+$/g, ""))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: words, loras };
}

// A1111's sampler and schedule names as ComfyUI's; unknown names come back lowercased
const A1111_SAMPLERS = {
  "euler": "euler", "euler a": "euler_ancestral", "heun": "heun", "lms": "lms",
  "dpm2": "dpm_2", "dpm2 a": "dpm_2_ancestral", "dpm++ 2s a": "dpmpp_2s_ancestral",
  "dpm++ 2m": "dpmpp_2m", "dpm++ sde": "dpmpp_sde", "dpm++ 2m sde": "dpmpp_2m_sde",
  "dpm++ 2m sde heun": "dpmpp_2m_sde", "dpm++ 3m sde": "dpmpp_3m_sde", "dpm fast": "dpm_fast",
  "dpm adaptive": "dpm_adaptive", "lcm": "lcm", "ddim": "ddim", "unipc": "uni_pc",
  "ipndm": "ipndm", "deis": "deis", "res multistep": "res_multistep", "er sde": "er_sde",
};
const A1111_SCHEDULES = {
  "automatic": "", "simple": "simple", "normal": "normal", "karras": "karras",
  "exponential": "exponential", "sgm uniform": "sgm_uniform", "beta": "beta",
  "ddim": "ddim_uniform", "linear quadratic": "linear_quadratic", "kl optimal": "kl_optimal",
};
export function comfySampler(name) {
  const k = String(name || "").trim().toLowerCase();
  if (!k) return "";
  return A1111_SAMPLERS[k] ?? k.replace(/\+\+/g, "pp").replace(/[\s-]+/g, "_");
}
export function comfyScheduler(name) {
  const k = String(name || "").trim().toLowerCase();
  if (!k) return "";
  return A1111_SCHEDULES[k] ?? k.replace(/[\s-]+/g, "_");
}

// an installed LoRA file for a tag's name: the same file name with any folder and
// extension, case ignored; "" when there is none
export function matchLora(name, installed) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return "";
  const base = (f) => String(f).split(/[\\/]/).pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, "").toLowerCase();
  return (installed || []).find((f) => base(f) === want) || "";
}

// the Workspace's own config out of the embedded graph, if the picture has one
export function workspaceConfigIn(chunks) {
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const wf = parse(chunks.workflow);
  for (const n of (wf?.nodes || [])) {
    if (n?.type === "RedNodeStudioWorkspace") {
      const c = parse(n.widgets_values?.[0]);
      if (c && typeof c === "object") return c;
    }
  }
  return workspaceConfigInPrompt(parse(chunks.prompt));
}

// the same, out of an API prompt map (the "prompt" chunk, or ComfyUI's history)
export function workspaceConfigInPrompt(pr) {
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  for (const v of Object.values(pr || {})) {
    if (v?.class_type === "RedNodeStudioWorkspace") {
      const c = typeof v.inputs?.config === "string" ? parse(v.inputs.config) : v.inputs?.config;
      if (c && typeof c === "object") return c;
    }
  }
  return null;
}

// the "civitaiResources" chunk as [{type, name, weight}]
export function parseResources(text) {
  try {
    const arr = JSON.parse(text || "[]");
    return Array.isArray(arr) ? arr.map((r) => ({
      type: String(r?.type || ""), name: String(r?.modelName || r?.name || ""),
      weight: Number.isFinite(Number(r?.weight)) ? Number(r.weight) : 1,
    })).filter((r) => r.name) : [];
  } catch (e) { return []; }
}

// the prompt row a config renders. Mirrors the server's prompt_row_for: the
// chosen row when it serves the active rig with words, else the first row
// linked to it with words, else the first unlinked row with words.
export function chosenRow(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const M = cfg.models || {};
  const rigs = Array.isArray(M.rigs) ? M.rigs : [];
  const rig = rigs[Math.max(0, Math.min(Number(M.active) || 0, rigs.length - 1))] || null;
  const rows = Array.isArray(cfg.prompts?.rows) ? cfg.prompts.rows : [];
  const activeName = rig?.name || "";
  const linksOf = (r) => (Array.isArray(r?.rigs) ? r.rigs : (r?.rig ? [r.rig] : [])).filter((x) => String(x || "").trim());
  const hasWords = (r) => String(r?.text || "").trim().length > 0;
  const pick = rows[Number(cfg.prompts?.active)];
  return (pick && hasWords(pick) && (linksOf(pick).includes(activeName) || !linksOf(pick).length)) ? pick
    : rows.find((r) => linksOf(r).includes(activeName) && hasWords(r))
      || rows.find((r) => !linksOf(r).length && hasWords(r)) || null;
}

// what a Workspace config says about a run: the rig, its settings, the LoRAs,
// the canvas, the chosen prompt row
export function summariseConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const M = cfg.models || {};
  const rigs = Array.isArray(M.rigs) ? M.rigs : [];
  const rig = rigs[Math.max(0, Math.min(Number(M.active) || 0, rigs.length - 1))] || null;
  const activeName = rig?.name || "";
  const row = chosenRow(cfg);
  const loras = (Array.isArray(cfg.loras?.slots) ? cfg.loras.slots : [])
    .filter((s) => s && s.type !== "title" && s.enabled !== false && String(s.name || "").trim())
    .map((s) => ({ name: String(s.name), weight: Number.isFinite(Number(s.strength)) ? Number(s.strength) : 1 }));
  return {
    rigName: activeName,
    model: String(rig?.unet || rig?.checkpoint || ""),
    steps: rig?.steps ?? null, cfg: rig?.cfg ?? null,
    sampler: rig?.sampler || "", scheduler: rig?.scheduler || "",
    seed: M.seed_random === false && Number.isFinite(Number(M.seed)) ? Number(M.seed) : null,
    width: cfg.latent?.w ?? null, height: cfg.latent?.h ?? null,
    prompt: row ? String(row.text || "") : "", negative: row ? String(row.negative || "") : "",
    loras,
  };
}
