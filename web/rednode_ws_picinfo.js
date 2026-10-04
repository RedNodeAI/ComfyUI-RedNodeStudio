// PICTURE INFO, a page on the Tools tab: drop a picture on it and read how it was made,
// the way A1111's PNG Info does. It reads A1111, Forge and Neo pictures, this pack's,
// plain ComfyUI ones and a JPEG or WebP's EXIF comment (rednode_png_meta.readPicture).
// Every part copies on a click, Send to Workspace hands it to the Prompts tab's
// import, and Save a copy writes the picture again for A1111 / Neo, for Civitai, or
// with nothing in it. The file is read in the browser; the original is never changed.
import { api } from "../../scripts/api.js";
import { render, importPictureFile, droppedPackPicture,
         adoptPaintSource } from "./rednode_workspace.js";
import { readPicture, a1111Text, writePngText, matchLora } from "./rednode_png_meta.js";
import { panelPaste } from "./rednode_keys.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const CSS = `
.rn-pi-drop{border:2px dashed #3a3f47;border-radius:10px;padding:18px;text-align:center;
  color:#9aa2ad;font-size:12.5px;cursor:pointer}
.rn-pi-drop.over{border-color:#b8283c;color:#fff;background:#2a1116}
.rn-pi-head{display:flex;gap:14px;align-items:flex-start}
.rn-pi-thumb{max-width:200px;max-height:200px;border-radius:6px;border:1px solid #2a2e35;flex:none}
.rn-pi-meta{display:flex;flex-direction:column;gap:6px;min-width:0}
.rn-pi-name{font-size:13px;font-weight:700;color:#e8ecf1;word-break:break-all}
.rn-pi-text{white-space:pre-wrap;font-size:12.5px;line-height:1.5;color:#dde2e8;background:#14161a;
  border:1px solid #262a31;border-radius:6px;padding:8px 10px;max-height:220px;overflow:auto;
  cursor:copy}
.rn-pi-text:hover{border-color:#b8283c}
.rn-pi-text.dim{color:#8a919b}
.rn-pi-grid{display:flex;flex-wrap:wrap;gap:6px}
.rn-pi-kv{display:inline-flex;gap:6px;align-items:baseline;background:#14161a;border:1px solid #262a31;
  border-radius:6px;padding:4px 9px;cursor:copy;font-size:12px}
.rn-pi-kv:hover{border-color:#b8283c}
.rn-pi-kv .k{color:#8a919b}
.rn-pi-kv .v{color:#e8ecf1;font-weight:600}
.rn-pi-lora{display:flex;gap:8px;align-items:center;padding:4px 2px;cursor:copy;font-size:12.5px}
.rn-pi-lora:hover .n{color:#fff}
.rn-pi-lora .n{flex:1;min-width:0;word-break:break-all;color:#dde2e8}
.rn-pi-lora .w{color:#8a919b}
.rn-pi-ok{color:#9fe0b4;font-size:11px}
.rn-pi-miss{color:#f3b0ba;font-size:11px}
.rn-pi-acts{display:flex;flex-wrap:wrap;gap:8px}
.rn-pi-acts .rn-ws-btn{width:auto;padding:6px 14px}
.rn-pi-cardhead{display:flex;align-items:center;gap:8px}
.rn-pi-cardhead .ch{flex:1;font-size:11px;font-weight:700;letter-spacing:.08em;color:#8a919b}
.rn-pi-copy{width:auto !important;padding:2px 10px !important;font-size:11px !important}
.rn-pi-raw summary{cursor:pointer;color:#8a919b;font-size:12px}
.rn-pi-rawkey{font-size:11px;color:#8a919b;margin-top:6px}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.appendChild(Object.assign(el("style"), { textContent: CSS }));
}

// a word on the element for a moment, then back
function flashText(target, text) {
  const was = target.dataset.was ?? target.textContent;
  target.dataset.was = was;
  target.textContent = text;
  setTimeout(() => { target.textContent = was; delete target.dataset.was; }, 900);
}
function copy(text, target) {
  navigator.clipboard?.writeText(String(text ?? "")).then(() => target && flashText(target, "Copied"))
    .catch(() => {});
}

// the installed LoRA names, asked once
let loraList = null;
async function installedLoras() {
  if (loraList) return loraList;
  try {
    const r = await api.fetchApi("/object_info/LoraLoader");
    loraList = (await r.json())?.LoraLoader?.input?.required?.lora_name?.[0] || [];
  } catch (e) { loraList = []; }
  return loraList;
}

async function load(node, file) {
  if (!file) return;
  const prev = node._rnPicInfo;
  if (prev?.url) URL.revokeObjectURL(prev.url);
  const buf = await file.arrayBuffer();
  const info = readPicture(buf, file.name);
  node._rnPicInfo = { file, info, url: URL.createObjectURL(file), status: "" };
  const list = await installedLoras();
  for (const l of info.loras) l.file = matchLora(String(l.name).split(/[\\/]/).pop()
    .replace(/\.(safetensors|pt|ckpt|bin)$/i, ""), list) || (list.includes(l.name) ? l.name : "");
  render(node);
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// the picture as PNG bytes: a PNG as it is, anything else drawn once onto a canvas
async function pngBytes(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 137 && u8[1] === 80) return buf;
  const bmp = await createImageBitmap(file);
  const c = Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  c.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  return blob.arrayBuffer();
}

const base = (name) => String(name || "picture").replace(/\.[^.]+$/, "");

async function saveCopy(node, how) {
  const S = node._rnPicInfo;
  if (!S) return;
  const say = (t) => { S.status = t; render(node); };
  try {
    const buf = await pngBytes(S.file);
    // the ComfyUI graph stays in an A1111 or Civitai copy, so it still opens in ComfyUI
    const keep = {};
    for (const k of ["workflow", "prompt"]) if (S.info.chunks?.[k]) keep[k] = S.info.chunks[k];
    if (how === "strip") {
      download(writePngText(buf, {}), base(S.file.name) + "_clean.png");
      say("Saved a copy with no metadata at all.");
      return;
    }
    if (how === "a1111") {
      download(writePngText(buf, { parameters: a1111Text(S.info), ...keep }),
               base(S.file.name) + "_a1111.png");
      say("Saved a copy A1111, Forge and Neo read: the prompt with its LoRA tags, the "
          + "negative and the settings.");
      return;
    }
    say("Building the Civitai record: model and LoRA hashes. The first time a model is "
        + "hashed the whole file is read, which can take a minute.");
    const r = await api.fetchApi("/rednode/civitai_text", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positive: S.info.positive, negative: S.info.negative,
                             model: S.info.model, loras: S.info.loras.map((l) => ({
                               name: l.file || l.name, weight: l.weight })),
                             settings: S.info.settings }) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
    const texts = { parameters: d.parameters, ...keep };
    if (d.resources && d.resources !== "[]") texts.civitaiResources = d.resources;
    download(writePngText(buf, texts), base(S.file.name) + "_civitai.png");
    say("Saved a copy for Civitai, with the model and LoRA hashes it links by."
        + (d.missing?.length ? " Not installed here, so listed without a hash: "
           + d.missing.join(", ") + "." : ""));
  } catch (e) {
    say(`Could not write the copy: ${e.message}`);
  }
}

function card(title, copyText) {
  const c = el("div", "rn-ws-card");
  const head = el("div", "rn-pi-cardhead");
  head.appendChild(el("div", "ch", title));
  if (copyText != null) {
    const b = el("button", "rn-ws-btn rn-pi-copy", "Copy");
    b.title = `Copy the ${title.toLowerCase()}.`;
    b.onclick = () => copy(copyText, b);
    head.appendChild(b);
  }
  c.appendChild(head);
  return c;
}

export function picInfoBody(node, body) {
  style();
  const S = node._rnPicInfo;

  // THE DROP ZONE: a file, a paste, or a picture dragged from the Shelf or a Review
  const top = el("div", "rn-ws-card");
  top.appendChild(el("div", "ch", "PICTURE INFO"));
  const drop = el("div", "rn-pi-drop");
  drop.append(S ? "Drop another picture here, paste one, or " : "Drop a picture here, paste one, or ");
  const pick = el("button", "rn-ws-btn rn-pi-copy", "Choose file");
  const input = Object.assign(el("input"), { type: "file", accept: "image/*" });
  input.style.display = "none";
  input.onchange = () => load(node, input.files?.[0]);
  pick.onclick = (e) => { e.stopPropagation(); input.click(); };
  drop.append(pick, input);
  drop.appendChild(el("div", "rn-ws-note",
    "Reads A1111, Forge, Neo, ComfyUI and RedNode Studio pictures, PNG, JPEG or WebP. "
    + "Nothing is uploaded and the picture is never changed."));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0] || await droppedPackPicture(e).catch(() => null);
    if (f) load(node, f);
  });
  top.appendChild(drop);
  panelPaste(top, (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (!f) return false;
    load(node, f);
  });
  body.appendChild(top);
  if (!S) return;
  const I = S.info;

  // WHAT IT IS
  const head = el("div", "rn-ws-card");
  const hrow = el("div", "rn-pi-head");
  const img = Object.assign(el("img", "rn-pi-thumb"), { src: S.url, alt: "" });
  const meta = el("div", "rn-pi-meta");
  meta.appendChild(el("div", "rn-pi-name", I.name));
  const chips = el("div", "rn-pi-grid");
  chips.appendChild(el("span", "rn-ws-chip", I.source || "No generation data"));
  chips.appendChild(el("span", "rn-ws-chip", I.kind.toUpperCase()));
  if (I.hasWorkflow) chips.appendChild(el("span", "rn-ws-chip", "ComfyUI workflow inside"));
  if (I.rig) chips.appendChild(el("span", "rn-ws-chip", "Rig: " + I.rig));
  meta.appendChild(chips);
  if (!I.found) {
    meta.appendChild(el("div", "rn-ws-note",
      "This picture carries no generation data. Many websites strip it when a picture is "
      + "uploaded, and most JPEG and WebP pictures never had any."));
  }
  hrow.append(img, meta);
  head.appendChild(hrow);
  body.appendChild(head);
  if (!I.found) return;

  // THE PROMPT AND THE NEGATIVE, each copies on a click
  const pc = card("PROMPT", I.positive);
  const pt = el("div", "rn-pi-text" + (I.positive ? "" : " dim"), I.positive || "No prompt.");
  pt.title = "Click to copy.";
  pt.onclick = () => I.positive && copy(I.positive, pt);
  pc.appendChild(pt);
  body.appendChild(pc);
  if (I.negative) {
    const nc = card("NEGATIVE", I.negative);
    const nt = el("div", "rn-pi-text", I.negative);
    nt.title = "Click to copy.";
    nt.onclick = () => copy(I.negative, nt);
    nc.appendChild(nt);
    body.appendChild(nc);
  }

  // THE SETTINGS, one chip each, a click copies the value
  const st = I.settings || {};
  const items = [["Model", I.model], ["Steps", st.steps], ["Sampler", st.sampler],
    ["Scheduler", st.scheduler], ["CFG", st.cfg], ["Seed", st.seed],
    ["Size", st.width && st.height ? `${st.width} × ${st.height}` : ""],
    ["Denoise", st.denoise], ["CLIP skip", st.clip_skip], ["Shift", st.shift]]
    .filter(([, v]) => v != null && v !== "");
  if (items.length) {
    const sc = card("SETTINGS");
    const g = el("div", "rn-pi-grid");
    for (const [k, v] of items) {
      const kv = el("span", "rn-pi-kv");
      const vv = el("span", "v", String(v));
      kv.append(el("span", "k", k), vv);
      kv.title = `Click to copy the ${k.toLowerCase()}.`;
      kv.onclick = () => copy(k === "Size" ? `${st.width}x${st.height}` : v, vv);
      g.appendChild(kv);
    }
    sc.appendChild(g);
    body.appendChild(sc);
  }

  // THE LORAS: installed or not, a click copies its A1111 tag
  if (I.loras.length) {
    const lc = card("LORAS", I.loras.map((l) => `<lora:${String(l.name).split(/[\\/]/).pop()
      .replace(/\.(safetensors|pt|ckpt|bin)$/i, "")}:${l.weight}>`).join(" "));
    for (const l of I.loras) {
      const row = el("div", "rn-pi-lora");
      const n = el("span", "n", String(l.name));
      row.append(n, el("span", "w", Number(l.weight).toFixed(2)),
                 el("span", l.file ? "rn-pi-ok" : "rn-pi-miss", l.file ? "Installed" : "Not installed"));
      const tag = `<lora:${String(l.name).split(/[\\/]/).pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, "")}:${l.weight}>`;
      row.title = `Click to copy ${tag}`;
      row.onclick = () => copy(tag, n);
      lc.appendChild(row);
    }
    body.appendChild(lc);
  }

  // USE IT
  const uc = card("USE IT");
  const acts = el("div", "rn-pi-acts");
  const all = el("button", "rn-ws-btn", "Copy all");
  all.title = "Copy everything as A1111 text: the prompt with its LoRA tags, the negative and the settings.";
  all.onclick = () => copy(a1111Text(I), all);
  const send = el("button", "rn-ws-btn", "Send to Workspace");
  send.title = "Bring the prompt, its LoRAs and its settings into this Workspace; it asks "
             + "which parts, the same as Import on the Prompts tab.";
  send.onclick = () => importPictureFile(node, S.file);
  const toPaint = el("button", "rn-ws-btn", "Send to Paint");
  toPaint.title = "Put the picture itself on the Paint tab.";
  toPaint.onclick = () => adoptPaintSource(node, S.file, "paint");
  acts.append(all, send, toPaint);
  uc.appendChild(acts);
  body.appendChild(uc);

  // SAVE A COPY
  const wc = card("SAVE A COPY");
  const wacts = el("div", "rn-pi-acts");
  const a1 = el("button", "rn-ws-btn", "For A1111 / Neo");
  a1.title = "A PNG with the A1111 parameters text, which A1111, Forge and Neo read.";
  a1.onclick = () => saveCopy(node, "a1111");
  const cv = el("button", "rn-ws-btn", "For Civitai");
  cv.title = "A PNG with the parameters text and the model and LoRA hashes Civitai links "
           + "by, the same record RedNode Save writes.";
  cv.onclick = () => saveCopy(node, "civitai");
  const sp = el("button", "rn-ws-btn", "Without metadata");
  sp.title = "A PNG with every text record taken out: no prompt, no workflow, no settings.";
  sp.onclick = () => saveCopy(node, "strip");
  wacts.append(a1, cv, sp);
  wc.appendChild(wacts);
  wc.appendChild(el("div", "rn-ws-note",
    "Each one downloads a new PNG; the picture you dropped is not changed. The A1111 and "
    + "Civitai copies keep a ComfyUI workflow if the picture had one."));
  if (S.status) wc.appendChild(el("div", "rn-ws-note", S.status));
  body.appendChild(wc);

  // RAW: the records as they are in the file
  const keys = Object.keys(I.chunks || {});
  if (keys.length || I.paramText) {
    const rc = el("div", "rn-ws-card");
    const det = el("details", "rn-pi-raw");
    det.appendChild(el("summary", "", `Raw records (${keys.length || 1})`));
    const shown = keys.length ? keys : ["parameters"];
    for (const k of shown) {
      const v = keys.length ? I.chunks[k] : I.paramText;
      det.appendChild(el("div", "rn-pi-rawkey", `${k} · ${String(v).length.toLocaleString()} characters`));
      const t = el("div", "rn-pi-text", String(v).length > 4000 ? String(v).slice(0, 4000) + "…" : String(v));
      t.title = "Click to copy all of it.";
      t.onclick = () => copy(v, t);
      det.appendChild(t);
    }
    rc.appendChild(det);
    body.appendChild(rc);
  }
}
