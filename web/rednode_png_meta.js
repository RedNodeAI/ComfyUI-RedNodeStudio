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
// and back: ComfyUI's names the way A1111, Forge and Neo write them
const A1111_SAMPLER_NAMES = {
  euler: "Euler", euler_ancestral: "Euler a", heun: "Heun", lms: "LMS", dpm_2: "DPM2",
  dpm_2_ancestral: "DPM2 a", dpmpp_2s_ancestral: "DPM++ 2S a", dpmpp_2m: "DPM++ 2M",
  dpmpp_sde: "DPM++ SDE", dpmpp_2m_sde: "DPM++ 2M SDE", dpmpp_3m_sde: "DPM++ 3M SDE",
  dpm_fast: "DPM fast", dpm_adaptive: "DPM adaptive", lcm: "LCM", ddim: "DDIM", uni_pc: "UniPC",
  ipndm: "iPNDM", deis: "DEIS", res_multistep: "Res Multistep", er_sde: "ER SDE",
};
const A1111_SCHEDULE_NAMES = {
  simple: "Simple", normal: "Normal", karras: "Karras", exponential: "Exponential",
  sgm_uniform: "SGM Uniform", beta: "Beta", ddim_uniform: "DDIM", linear_quadratic: "Linear Quadratic",
  kl_optimal: "KL Optimal",
};
export function a1111Sampler(name) {
  const k = String(name || "").trim();
  return A1111_SAMPLER_NAMES[k.toLowerCase()] || k;
}
export function a1111Scheduler(name) {
  const k = String(name || "").trim();
  return A1111_SCHEDULE_NAMES[k.toLowerCase()] || k;
}
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

// ---- reading any picture ------------------------------------------------------

// A1111 writes a JPEG's or WebP's parameters into EXIF as a UserComment: an
// 8-byte charset marker, then the text. Found by its marker rather than by walking
// the EXIF tree, which is enough for the one field anyone writes there.
export function exifUserComment(buf) {
  try {
    const u8 = new Uint8Array(buf);
    const find = (pat, from = 0) => {
      outer: for (let i = from; i <= u8.length - pat.length; i++) {
        for (let j = 0; j < pat.length; j++) if (u8[i + j] !== pat[j]) continue outer;
        return i;
      }
      return -1;
    };
    const asBytes = (s) => [...s].map((c) => c.charCodeAt(0));
    let at = find(asBytes("UNICODE\0"));
    if (at >= 0) {
      const body = u8.subarray(at + 8, Math.min(u8.length, at + 8 + 200000));
      let end = body.length;
      for (let i = 0; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
      const raw = body.subarray(0, end - (end % 2));
      const be = new TextDecoder("utf-16be").decode(raw);
      const le = new TextDecoder("utf-16le").decode(raw);
      const ascii = (s) => (s.match(/[ -~\n]/g) || []).length;
      return (ascii(be) >= ascii(le) ? be : le).replace(/\0+$/, "");
    }
    at = find(asBytes("ASCII\0\0\0"));
    if (at >= 0) {
      let end = at + 8;
      while (end < u8.length && u8[end] !== 0) end++;
      return new TextDecoder("latin1").decode(u8.subarray(at + 8, end));
    }
  } catch (e) { /* not a picture we can read */ }
  return "";
}

// A ComfyUI graph with no Workspace in it: the sampler's numbers, the two encodes
// that feed it, the model loader and the LoRA loaders.
export function comfyPromptSummary(pr) {
  if (!pr || typeof pr !== "object") return null;
  const nodes = pr;
  const node = (ref) => (Array.isArray(ref) ? nodes[String(ref[0])] : null);
  const sampler = Object.values(nodes).find((n) => n?.inputs && "steps" in n.inputs
    && ("seed" in n.inputs || "noise_seed" in n.inputs));
  // follow a conditioning input back to the text that made it
  const textOf = (ref, depth = 0) => {
    const n = node(ref);
    if (!n || depth > 6) return "";
    const i = n.inputs || {};
    if (typeof i.text === "string") return i.text;
    if (typeof i.text_g === "string") return i.text_g;
    for (const k of ["conditioning", "conditioning_1", "conditioning_to", "positive", "clip"]) {
      if (Array.isArray(i[k])) { const t = textOf(i[k], depth + 1); if (t) return t; }
    }
    return "";
  };
  const si = sampler?.inputs || {};
  const loader = Object.values(nodes).find((n) => n?.inputs && (n.inputs.ckpt_name || n.inputs.unet_name));
  const loras = Object.values(nodes)
    .filter((n) => n?.inputs && typeof n.inputs.lora_name === "string")
    .map((n) => ({ name: n.inputs.lora_name,
                   weight: Number(n.inputs.strength_model ?? n.inputs.strength ?? 1) }));
  const latent = Object.values(nodes).find((n) => n?.inputs && Number.isFinite(Number(n.inputs.width))
    && Number.isFinite(Number(n.inputs.height)) && /Latent/i.test(n.class_type || ""));
  const num = (v) => (Number.isFinite(Number(v)) && typeof v !== "object" ? Number(v) : null);
  if (!sampler && !loader && !loras.length) return null;
  return {
    positive: textOf(si.positive), negative: textOf(si.negative),
    settings: { steps: num(si.steps), cfg: num(si.cfg), seed: num(si.seed ?? si.noise_seed),
                sampler: typeof si.sampler_name === "string" ? si.sampler_name : "",
                scheduler: typeof si.scheduler === "string" ? si.scheduler : "",
                denoise: num(si.denoise), width: num(latent?.inputs?.width),
                height: num(latent?.inputs?.height) },
    model: String(loader?.inputs?.ckpt_name || loader?.inputs?.unet_name || ""),
    loras,
  };
}

// Everything a picture says about how it was made, from whichever record it has:
// the A1111 parameters text (A1111, Forge, Neo, this pack), this pack's Workspace
// setup, a plain ComfyUI graph, or a JPEG / WebP's EXIF comment.
export function readPicture(buf, name = "") {
  const u8 = new Uint8Array(buf);
  const isPng = u8[0] === 137 && u8[1] === 80;
  const kind = isPng ? "png" : (u8[0] === 0xff && u8[1] === 0xd8 ? "jpeg"
    : (String.fromCharCode(...u8.subarray(8, 12)) === "WEBP" ? "webp" : "other"));
  const chunks = isPng ? pngTextChunks(buf) : {};
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const exif = isPng ? "" : exifUserComment(buf);
  const paramText = chunks.parameters || exif || "";
  const params = parseParameters(paramText);
  const config = isPng ? workspaceConfigIn(chunks) : null;
  const summary = config ? summariseConfig(config) : null;
  const comfy = !params && !config ? comfyPromptSummary(parse(chunks.prompt)) : null;
  const info = {
    name, kind, chunks, paramText,
    source: config ? "RedNode Studio" : params ? (exif ? "A1111 / Forge / Neo (EXIF)" : "A1111 / Forge / Neo")
      : comfy ? "ComfyUI" : "",
    hasWorkflow: !!chunks.workflow,
    positive: "", negative: "", settings: {}, model: "", loras: [],
  };
  if (params) {
    const tags = loraTags(params.positive);
    info.positive = tags.text;
    info.negative = params.negative;
    info.settings = { ...params.settings };
    info.model = params.settings.model || "";
    info.loras = tags.loras;
    if (/Version: RedNode Studio/.test(paramText) && !config) info.source = "RedNode Studio";
  }
  if (summary) {
    if (!info.positive) { info.positive = summary.prompt; info.negative = summary.negative; }
    const st = info.settings;
    for (const k of ["steps", "cfg", "sampler", "scheduler", "seed", "width", "height"]) {
      if (st[k] == null || st[k] === "") st[k] = summary[k];
    }
    if (!info.model) info.model = summary.model;
    if (!info.loras.length) info.loras = summary.loras;
    info.rig = summary.rigName;
  }
  if (comfy) {
    info.positive = comfy.positive; info.negative = comfy.negative;
    info.settings = comfy.settings; info.model = comfy.model; info.loras = comfy.loras;
  }
  // the Civitai list names LoRAs the prompt does not tag
  for (const r of parseResources(chunks.civitaiResources)) {
    if (r.type === "lora" && !info.loras.some((l) => l.name === r.name)) info.loras.push({ name: r.name, weight: r.weight });
  }
  info.found = !!(info.positive || info.negative || info.model || info.loras.length
                  || Object.values(info.settings).some((v) => v != null && v !== ""));
  return info;
}

// ---- writing ------------------------------------------------------------------

const stem = (n) => String(n || "").split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|bin|gguf)$/i, "");

// The A1111 parameters text, the way A1111, Forge and Neo write it and read it back:
// the prompt with its <lora:name:weight> tags, the negative, then one settings line.
export function a1111Text(info) {
  const st = info?.settings || {};
  const tags = (info?.loras || []).map((l) => `<lora:${stem(l.name)}:${Number(l.weight ?? 1)}>`);
  const pos = [String(info?.positive || "").trim(), tags.join(" ")].filter(Boolean).join(" ");
  const lines = [pos];
  if (String(info?.negative || "").trim()) lines.push("Negative prompt: " + String(info.negative).trim());
  const parts = [];
  const has = (v) => v != null && v !== "";
  if (has(st.steps)) parts.push(`Steps: ${st.steps}`);
  if (st.sampler) parts.push(`Sampler: ${a1111Sampler(st.sampler)}`);
  if (st.scheduler) parts.push(`Schedule type: ${a1111Scheduler(st.scheduler)}`);
  if (has(st.cfg)) parts.push(`CFG scale: ${st.cfg}`);
  if (has(st.seed)) parts.push(`Seed: ${st.seed}`);
  if (st.width && st.height) parts.push(`Size: ${st.width}x${st.height}`);
  if (info?.model) parts.push(`Model: ${stem(info.model)}`);
  if (has(st.denoise) && Number(st.denoise) < 1) parts.push(`Denoising strength: ${st.denoise}`);
  if (has(st.clip_skip) && Number(st.clip_skip) > 1) parts.push(`Clip skip: ${st.clip_skip}`);
  if (parts.length) lines.push(parts.join(", "));
  return lines.join("\n");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function textChunk(key, value) {
  const k = new TextEncoder().encode(key);
  const v = String(value);
  // tEXt when the text is Latin-1, iTXt (UTF-8) when it is not, the way PIL decides
  if (/^[\x00-\xff]*$/.test(v)) {
    const data = new Uint8Array(k.length + 1 + v.length);
    data.set(k, 0);
    for (let i = 0; i < v.length; i++) data[k.length + 1 + i] = v.charCodeAt(i);
    return chunk("tEXt", data);
  }
  const vb = new TextEncoder().encode(v);
  const data = new Uint8Array(k.length + 5 + vb.length);
  data.set(k, 0);                         // key, 0, compression flag 0, method 0, "", ""
  data.set(vb, k.length + 5);
  return chunk("iTXt", data);
}

// A PNG's bytes with every text and metadata chunk taken out and `texts` written in
// their place, right after the header. The picture's pixels are untouched. An empty
// `texts` strips it clean.
const META_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);
export function writePngText(buf, texts = {}) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const parts = [u8.subarray(0, 8)];
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    const end = p + 12 + len;
    if (end > u8.length) break;
    if (!META_CHUNKS.has(type)) parts.push(u8.subarray(p, end));
    if (type === "IHDR") for (const [k, v] of Object.entries(texts)) if (v != null && v !== "") parts.push(textChunk(k, v));
    if (type === "IEND") break;
    p = end;
  }
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}
