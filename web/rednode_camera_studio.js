import { app } from "../../scripts/app.js";

// RedNode Camera Studio - the panel. Phase 1: a 2D TOP-VIEW planner.
//
// A stage seen from above: subjects as dots with a facing arrow, the camera
// as an icon with its lens FRUSTUM drawn as a wedge (the one visual that
// makes focal length legible - widen the lens, watch the cone open). Drag
// a subject to move it, drag the camera to move it, drag the little arrow
// on a subject to turn it. Beside the stage, the numbers: camera height,
// pitch (derived and shown), lens, roll, per-subject height and facing, and
// the live paragraph the translator will send. The backend does the words;
// the panel keeps the state in the hidden config widget, the pack's pattern.
//
// Written HOST-AGNOSTIC: buildStudio(host, S) takes a container and a state
// store, exactly the Prompt Frame's shape, so the Workspace can mount the
// same panel later. Only the thin node-registration at the bottom is
// node-specific.

const NODE_NAME = "RedNodeCameraStudio";
const PX_PER_M = 44;               // stage scale at "normal"; see pxm() (wide 22, huge 11)
const STAGE_W = 520, STAGE_H = 420;

const css = document.createElement("style");
css.id = "rn-cs-style";
css.textContent = `
.rn-cs{display:flex;flex-direction:column;gap:8px;padding:8px;box-sizing:border-box;
  font:13px 'Segoe UI',system-ui,sans-serif;color:#d6d9de;background:rgba(0,0,0,.16);
  border:1px solid rgba(255,255,255,.13);border-radius:6px;overflow:auto;color-scheme:dark}
.rn-cs .cols{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,1fr);gap:10px;
  align-items:start}
.rn-cs .card{display:flex;flex-direction:column;gap:7px;background:#1b1e23;
  border:1px solid #2a2e34;border-radius:8px;padding:9px}
.rn-cs .card>.ttl{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;
  letter-spacing:.06em;color:#4a8fe0}
.rn-cs .card>.ttl .sum{margin-left:auto;font-size:11px;color:#7f8792;font-weight:400}
.rn-cs canvas.stage{display:block;width:100%;background:#0f1114;border:1px solid #2a2e34;
  border-radius:8px;cursor:crosshair;touch-action:none}
.rn-cs .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rn-cs .k{font-size:12px;color:#8a919b;flex:none;width:76px}
.rn-cs input[type=range]{flex:1;min-width:90px;height:20px;accent-color:#4a8fe0}
.rn-cs input[type=number],.rn-cs input[type=text],.rn-cs select{background:#101216;
  border:1px solid #2f333a;border-radius:6px;color:#e8ecf1;font-size:13px;font-weight:600;
  padding:5px 8px;outline:none}
.rn-cs input[type=number]{width:70px;text-align:right}
.rn-cs .v{font-size:12px;color:#c8ccd2;flex:none;min-width:58px;text-align:right}
.rn-cs button{background:#15171b;border:1px solid #33373d;border-radius:6px;color:#c8ccd2;
  cursor:pointer;font-size:12px;padding:5px 10px}
.rn-cs button:hover{border-color:#4a8fe0;color:#fff}
.rn-cs button.on{background:#4a8fe0;border-color:#4a8fe0;color:#fff}
.rn-cs .chips{display:flex;gap:6px;flex-wrap:wrap}
.rn-cs .chip{padding:5px 10px;border-radius:6px;cursor:pointer;background:#101216;
  border:1px solid #2a2e34;color:#c8ccd2;font-size:12px}
.rn-cs .chip.on{border-color:#4a8fe0;background:#4a8fe01a;color:#fff}
.rn-cs .subj{display:flex;flex-direction:column;gap:6px;background:#15171b;
  border:1px solid #2a2e34;border-radius:7px;padding:7px}
.rn-cs .subj.sel{border-color:#4a8fe0}
.rn-cs .subj .head{display:flex;align-items:center;gap:6px}
.rn-cs .subj .head select{flex:none;width:96px;padding-right:2px}
.rn-cs .subj .head input[type=text]{flex:1;min-width:120px}
.rn-cs .subj .rel select{flex:1;min-width:0}
.rn-cs .out{background:#101216;border:1px solid #2a2e34;border-radius:7px;padding:9px 11px;
  font-size:12.5px;line-height:1.5;color:#e2e5ea;white-space:pre-wrap;min-height:90px}
.rn-cs .note{font-size:11.5px;color:#7f8792}
`;

// ---- state -----------------------------------------------------------------
const DEFAULT = () => ({
  camera: { pos: [0, 1.56, 3.0], target: 0, target_height: null, focal_mm: 35, roll_deg: 0,
            lock: true, aim: [0, 0, 0] },
  subjects: [{ name: "the subject", pos: [0, 0, 0], height: 1.7, facing_deg: 0 }],
  output: "krea2", join: "lead",
  auto_latent: false, latent_mp: 1.0, latent_batch: 1,
  zoom_lora: "", zoom_mode: "off", zoom_strength: 0,
  cam_loras: {},
  path: { mode: "off", shots: 10, b: null, orbit_from: 0, orbit_to: 180 },
  stage_zoom: "normal",
});
const CAM_LORA_KEYS = ["zoom", "height", "orbit", "back"];
const CAM_LORA_RANGE = { zoom: [-10, 12], height: [-10, 12], orbit: [-8, 8], back: [0, 8] };
const CAM_LORA_LABEL = { zoom: "Zoom", height: "Height", orbit: "Orbit", back: "Back" };
const CAM_LORA_HINT = {
  zoom: "Push in / pull out. Auto follows the shot size: close pushes in, wide pulls out.",
  height: "Camera height. Auto follows the tilt: below eye level pulls minus, above pushes plus.",
  orbit: "Camera swung round the subject. Auto follows where the camera sits against the way they face.",
  back: "Seen from behind. Auto rises once the camera passes their shoulder line; 0 in front.",
};
// which files count as the default pick for each key (RedNode's own sliders,
// then the community zoom): first match wins, the user can pick any file
const CAM_LORA_GUESS = {
  zoom: [/zoom/i], height: [/camera_height/i, /cam(era)?[_ -]?height/i],
  orbit: [/camera_orbit/i, /orbit/i], back: [/camera_back/i, /back_view/i],
};
function camLoraEntry(st, key) {
  if (!st.cam_loras || typeof st.cam_loras !== "object") st.cam_loras = {};
  let e = st.cam_loras[key];
  if (!e || typeof e !== "object") {
    e = { name: "", mode: "off", strength: 0 };
    if (key === "zoom" && st.zoom_lora) {   // legacy single-zoom form folds in
      e = { name: st.zoom_lora, mode: st.zoom_mode || "off", strength: st.zoom_strength || 0 };
    }
    st.cam_loras[key] = e;
  }
  return e;
}

function normalise(d) {
  const o = DEFAULT();
  if (d && typeof d === "object") {
    if (d.camera && typeof d.camera === "object") {
      const c = d.camera;
      if (Array.isArray(c.pos) && c.pos.length === 3) o.camera.pos = c.pos.map(Number);
      if (typeof c.target === "number") o.camera.target = c.target;
      if (typeof c.target_height === "number") o.camera.target_height = c.target_height;
      if (typeof c.focal_mm === "number") o.camera.focal_mm = c.focal_mm;
      if (typeof c.roll_deg === "number") o.camera.roll_deg = c.roll_deg;
      if (c.lock === false) o.camera.lock = false;
      if (Array.isArray(c.aim) && c.aim.length === 3) o.camera.aim = c.aim.map(Number);
    }
    if (Array.isArray(d.subjects) && d.subjects.length) {
      o.subjects = d.subjects.filter((s) => s && typeof s === "object").map((s) => ({
        name: typeof s.name === "string" ? s.name : "the subject",
        pos: Array.isArray(s.pos) && s.pos.length === 3 ? s.pos.map(Number) : [0, 0, 0],
        height: typeof s.height === "number" ? s.height : 1.7,
        facing_deg: typeof s.facing_deg === "number" ? s.facing_deg : 0,
        kind: ["person", "object", "wall", "window", "door"].includes(s.kind) ? s.kind : "person",
        size: Array.isArray(s.size) && s.size.length === 2 ? s.size.map(Number) : [0.6, 0.6],
        locked: s.locked === true,
        rel: (s.rel && typeof s.rel === "object" && typeof s.rel.to === "number")
          ? { kind: String(s.rel.kind || ""), to: s.rel.to } : null,
      }));
    }
    if (d.join === "trail") o.join = "trail";
    if (d.auto_latent === true) o.auto_latent = true;
    if (["krea2", "short", "tags"].includes(d.output)) o.output = d.output;
    if (typeof d.zoom_lora === "string") o.zoom_lora = d.zoom_lora;
    if (["off", "auto", "manual"].includes(d.zoom_mode)) o.zoom_mode = d.zoom_mode;
    if (typeof d.zoom_strength === "number") o.zoom_strength = d.zoom_strength;
    if (["normal", "wide", "huge"].includes(d.stage_zoom)) o.stage_zoom = d.stage_zoom;
    if (d.path && typeof d.path === "object") {
      const p = d.path;
      o.path = {
        mode: ["off", "ab", "orbit"].includes(p.mode) ? p.mode : "off",
        shots: Math.max(1, Math.min(64, Math.round(Number(p.shots) || 10))),
        b: (p.b && typeof p.b === "object" && Array.isArray(p.b.pos)) ? JSON.parse(JSON.stringify(p.b)) : null,
        orbit_from: Number.isFinite(Number(p.orbit_from)) ? Number(p.orbit_from) : 0,
        orbit_to: Number.isFinite(Number(p.orbit_to)) ? Number(p.orbit_to) : 180,
      };
    }
    if (d.cam_loras && typeof d.cam_loras === "object") {
      o.cam_loras = {};
      for (const k of CAM_LORA_KEYS) {
        const e = d.cam_loras[k];
        if (!e || typeof e !== "object") continue;
        o.cam_loras[k] = {
          name: typeof e.name === "string" ? e.name : "",
          mode: ["off", "auto", "manual"].includes(e.mode) ? e.mode : "off",
          strength: typeof e.strength === "number" ? e.strength : 0,
        };
      }
    }
    if (typeof d.latent_mp === "number") o.latent_mp = d.latent_mp;
    if (typeof d.latent_batch === "number") o.latent_batch = d.latent_batch;
  }
  if (o.camera.target >= o.subjects.length) o.camera.target = 0;
  return o;
}

// ---- geometry mirrors of the translator, for the live readout ---------------
const fovDeg = (f) => (2 * Math.atan(36 / (2 * Math.max(4, f)))) * 180 / Math.PI;
function geometry(cam, subj) {
  const face = [subj.pos[0], subj.pos[1] + subj.height * 0.92, subj.pos[2]];
  const tgt = cam.lock === false && Array.isArray(cam.aim) ? cam.aim
    : cam.target_height != null ? [face[0], cam.target_height, face[2]] : face;
  const dx = tgt[0] - cam.pos[0], dy = tgt[1] - cam.pos[1], dz = tgt[2] - cam.pos[2];
  const ground = Math.hypot(dx, dz);
  return {
    distance: Math.hypot(dx, dy, dz),
    pitch: (ground || dy) ? Math.atan2(dy, ground) * 180 / Math.PI : 0,
    yaw: ground ? Math.atan2(dx, -dz) * 180 / Math.PI : 0,
    tgt,
  };
}

// the auto-latent aspect rule, mirrored from camera_translate.suggest_aspect
// for the live readout; the backend's copy is the one that allocates
function suggestAspect(st) {
  const cam = st.camera;
  const prime = st.subjects[cam.target] || st.subjects[0];
  const geo = geometry({ ...cam, lock: true, target_height: null }, prime);
  const steep = Math.abs(geo.pitch), fov = fovDeg(cam.focal_mm);
  let spread = 0;
  if (st.subjects.length > 1) {
    const yaws = st.subjects.map((s) => {
      const dx = s.pos[0] - cam.pos[0], dz = s.pos[2] - cam.pos[2];
      return Math.atan2(dx, -dz) * 180 / Math.PI;
    });
    spread = Math.max(...yaws) - Math.min(...yaws);
  }
  const widthM = 2 * geo.distance * Math.tan((fov / 2) * Math.PI / 180);
  if (st.subjects.length > 1 && spread > fov * 0.45) return [16, 9, "several subjects spread across the view: wide"];
  if (st.subjects.length > 1 && spread > fov * 0.25) return [3, 2, "two or more subjects side by side: landscape"];
  if (steep >= 55 && geo.pitch > 0) return [2, 3, "steep low angle: tall, the figure towers"];
  if (steep >= 55 && geo.pitch < 0) return [3, 4, "steep high angle: portrait, the ground stretches"];
  if (steep >= 25 && fov >= 60) return [2, 3, "an angled wide-lens shot: tall"];
  if (widthM < 1.6) return [4, 5, "a close portrait: near square"];
  if (widthM >= 4.5) return [3, 2, "a wide view: landscape"];
  return [3, 4, "the default portrait frame"];
}
function autoZoomStrength(st) {
  const cam = st.camera;
  const prime = st.subjects[cam.target] || st.subjects[0];
  const face = [prime.pos[0], prime.pos[1] + prime.height * 0.92, prime.pos[2]];
  const dist = Math.hypot(face[0] - cam.pos[0], face[1] - cam.pos[1], face[2] - cam.pos[2]);
  const widthM = 2 * dist * Math.tan((fovDeg(cam.focal_mm) / 2) * Math.PI / 180);
  const lo = Math.log(0.5), hi = Math.log(8.0);
  const tt = (Math.log(Math.max(0.5, Math.min(8, widthM))) - lo) / (hi - lo);
  // mirrors camera_translate.auto_zoom_strength: an assist, half the raw curve, -4..+6
  return Math.round(Math.max(ZOOM_AUTO_MIN, Math.min(ZOOM_AUTO_MAX, (12 - tt * 22) * ZOOM_AUTO_FACTOR)) * 10) / 10;
}
const ZOOM_AUTO_FACTOR = 0.5, ZOOM_AUTO_MIN = -4, ZOOM_AUTO_MAX = 6;
function primeGeo(st) {
  const cam = st.camera;
  const prime = st.subjects[cam.target] || st.subjects[0];
  const face = [prime.pos[0], prime.pos[1] + prime.height * 0.92, prime.pos[2]];
  const d = [face[0] - cam.pos[0], face[1] - cam.pos[1], face[2] - cam.pos[2]];
  const ground = Math.hypot(d[0], d[2]);
  const pitch = (ground || d[1]) ? Math.atan2(d[1], ground) * 180 / Math.PI : 0;
  const yaw = ground ? Math.atan2(d[0], -d[2]) * 180 / Math.PI : 0;
  const facing = prime.facing_deg || 0;
  // bearing of the camera from the subject in FACING degrees (0 = +z, 90 = +x);
  // rel +90 = camera on the subject's LEFT (mirrors camera_translate.rel_bearing)
  const bearing = Math.atan2(cam.pos[0] - face[0], cam.pos[2] - face[2]) * 180 / Math.PI;
  const rel = ((bearing - facing + 180) % 360 + 360) % 360 - 180;
  return { pitch, yaw, rel };
}
function clampKey(key, v) {
  const [lo, hi] = CAM_LORA_RANGE[key];
  return Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10;
}
// auto caps mirror camera_translate (tuned on the words+LoRAs strip)
const HEIGHT_AUTO_FACTOR = 0.08, HEIGHT_AUTO_MIN = -2.5, HEIGHT_AUTO_MAX = 3, BACK_AUTO_MAX = 3;
function autoHeightStrength(st) {
  const v = clampKey("height", -primeGeo(st).pitch * HEIGHT_AUTO_FACTOR);
  return Math.round(Math.max(HEIGHT_AUTO_MIN, Math.min(HEIGHT_AUTO_MAX, v)) * 10) / 10;
}
function autoOrbitStrength(st) { return clampKey("orbit", 8 * Math.sin(primeGeo(st).rel * Math.PI / 180)); }
function autoBackStrength(st) { return clampKey("back", BACK_AUTO_MAX * Math.max(0, -Math.cos(primeGeo(st).rel * Math.PI / 180))); }
const AUTO_FN = { zoom: autoZoomStrength, height: autoHeightStrength,
                  orbit: autoOrbitStrength, back: autoBackStrength };
// camera path (mirror of camera_translate.camera_path) for the stage dots
function lerp(a, b, t) { return a + (b - a) * t; }
function orbitCamera(st, bearing) {
  const cam = st.camera;
  const prime = st.subjects[cam.target] || st.subjects[0];
  const ground = Math.hypot(cam.pos[0] - prime.pos[0], cam.pos[2] - prime.pos[2]) || 3;
  const b = ((prime.facing_deg || 0) + bearing) * Math.PI / 180;   // +90 = the subject's left
  return { ...cam, pos: [prime.pos[0] + ground * Math.sin(b), cam.pos[1], prime.pos[2] + ground * Math.cos(b)] };
}
function pathCameras(st) {
  const p = st.path || { mode: "off" };
  const n = Math.max(1, Math.min(64, p.shots || 1));
  const cam = st.camera;
  if (p.mode === "ab" && p.b && Array.isArray(p.b.pos)) {
    if (n === 1) return [cam];
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      return { ...cam, pos: [0, 1, 2].map((k) => lerp(cam.pos[k], p.b.pos[k], t)),
               focal_mm: lerp(cam.focal_mm, p.b.focal_mm ?? cam.focal_mm, t) };
    });
  }
  if (p.mode === "orbit") {
    if (n === 1) return [orbitCamera(st, p.orbit_from || 0)];
    return Array.from({ length: n }, (_, i) => orbitCamera(st, lerp(p.orbit_from || 0, p.orbit_to ?? 180, i / (n - 1))));
  }
  return [cam];
}
let LORA_LIST = null;
async function fetchLoras() {
  if (LORA_LIST) return LORA_LIST;
  try {
    const r = await fetch("/object_info/LoraLoader");
    const d = await r.json();
    const v = d?.LoraLoader?.input?.required?.lora_name?.[0];
    LORA_LIST = Array.isArray(v) ? v : [];
  } catch (e) { LORA_LIST = []; }
  return LORA_LIST;
}
function autoLatentSize(st) {
  const [wr, hr, why] = suggestAspect(st);
  const total = Math.max(0.05, st.latent_mp || 1) * 1e6;
  const w = Math.sqrt(total * wr / hr), h = w * hr / wr;
  const r = (v) => Math.max(64, Math.round(v / 64) * 64);
  return [r(w), r(h), wr + ":" + hr + ", " + why];
}

// the Prompt Frame's simple chips as a studio camera, mirroring
// camera_translate.camera_from_frame; the backend's copy is the truth
const FRAMING_SHOTS = { "Portrait": [1.6, 65], "Half body": [2.0, 50], "Balanced": [3.0, 35],
                        "Full scene": [4.5, 28], "Roomscale": [7.0, 24] };
export function cameraFromFrame(framing, cameraHeight, subjectHeight = 1.7,
                                subjectPos = [0, 0, 0], bearingDeg = 0) {
  const [dist, focal] = FRAMING_SHOTS[framing] || FRAMING_SHOTS["Balanced"];
  const face = subjectPos[1] + subjectHeight * 0.92;
  const H = { "Worm's eye": [0.15, -60], "Low angle": [0.9, -30], "Slight low": [face - 0.3, -12],
              "Eye level": [face, 0], "Slight high": [face + 0.4, 20],
              "High angle": [subjectHeight + 1.5, 45], "Bird's eye": [subjectHeight + 2.5, 88] };
  let [y, pitch] = H[cameraHeight] || H["Eye level"];
  let ground;
  if (!pitch) ground = dist;
  else if (Math.abs(pitch) < 30) {
    ground = dist;
    y = Math.max(0.1, face + Math.tan(pitch * Math.PI / 180) * ground);
  } else {
    ground = Math.abs(y - face) / Math.tan(Math.abs(pitch) * Math.PI / 180);
    ground = Math.max(Math.abs(pitch) >= 85 ? 0.05 : 0.35, Math.min(12, ground));
  }
  const yaw = bearingDeg * Math.PI / 180;
  return { pos: [subjectPos[0] + Math.sin(yaw) * ground, y, subjectPos[2] + Math.cos(yaw) * ground],
           target: 0, target_height: null, focal_mm: focal, roll_deg: 0, lock: true, aim: [0, 0, 0] };
}

// ---- the panel ---------------------------------------------------------------
// S: { get(): state, set(state): void, onChange(): void, preview(state)->Promise<string> }
export function buildStudio(host, S) {
  if (!document.getElementById("rn-cs-style")) document.head.appendChild(css);
  host.classList.add("rn-cs");
  let st = normalise(S.get());
  let sel = 0;                       // selected subject index
  let dragging = null;               // {kind: "cam"|"subj"|"face", i}
  // STAGE SCALE (the user's ask: bigger rooms, outdoors): normal 12 x 9 m,
  // wide 24 x 19 m, huge 48 x 38 m. Same canvas, more metres per pixel.
  const pxm = () => (st.stage_zoom === "huge" ? 11 : st.stage_zoom === "wide" ? 22 : 44);
  const write = () => { S.set(st); S.onChange?.(); };

  const cols = document.createElement("div");
  cols.className = "cols";
  host.appendChild(cols);

  // ---- left: the stage card
  const stageCard = document.createElement("div");
  stageCard.className = "card";
  const stTtl = document.createElement("div");
  stTtl.className = "ttl";
  stTtl.textContent = "TOP VIEW";
  const stSum = document.createElement("span");
  stSum.className = "sum";
  stTtl.appendChild(stSum);
  stageCard.appendChild(stTtl);
  const canvas = document.createElement("canvas");
  canvas.className = "stage";
  canvas.width = STAGE_W; canvas.height = STAGE_H;
  canvas.style.aspectRatio = STAGE_W + " / " + STAGE_H;
  stageCard.appendChild(canvas);
  const legend = document.createElement("div");
  legend.className = "note";
  legend.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";
  const legendTxt = document.createElement("span");
  legendTxt.textContent = "Drag a thing to move it, its arrow (or an object's front edge) to turn it, "
    + "the camera to move it. Wheel = lens. Right-click = reset / fit. Locked things stay put.";
  legend.appendChild(legendTxt);
  const scaleChips = document.createElement("span");
  scaleChips.className = "chips";
  scaleChips.style.marginLeft = "auto";
  for (const [v, l, tip] of [["normal", "12 m", "Stage 12 x 9 m: a room."],
                             ["wide", "24 m", "Stage 24 x 19 m: an apartment, a ring, a yard."],
                             ["huge", "48 m", "Stage 48 x 38 m: a pitch, a street, outdoors."]]) {
    const c = document.createElement("span");
    c.className = "chip";
    c.dataset.zoom = v;
    c.textContent = l; c.title = tip;
    c.onclick = () => { st.stage_zoom = v; write(); render(); };
    scaleChips.appendChild(c);
  }
  legend.appendChild(scaleChips);
  stageCard.appendChild(legend);
  cols.appendChild(stageCard);

  // ---- right: the controls
  const right = document.createElement("div");
  right.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:0";
  cols.appendChild(right);

  // SETS (the user's ask): named scene + camera states. Built-in sets ship
  // with the pack (rooms built from objects, two-person scenes); yours are
  // saved server-side like the LoRA presets. Loading replaces subjects,
  // camera, path and stage scale and keeps your LoRA picks and output style.
  const setsCard = document.createElement("div");
  setsCard.className = "card";
  const setsTtl = document.createElement("div");
  setsTtl.className = "ttl";
  setsTtl.textContent = "SETS";
  const setsSum = document.createElement("span");
  setsSum.className = "sum";
  setsTtl.appendChild(setsSum);
  setsCard.appendChild(setsTtl);
  const setsRow = document.createElement("div");
  setsRow.className = "row";
  const setsSel = document.createElement("select");
  setsSel.style.cssText = "flex:1;min-width:0";
  const loadB = document.createElement("button");
  loadB.textContent = "Load";
  loadB.title = "Replace the stage with this set (subjects, camera, path, stage scale).";
  const saveB = document.createElement("button");
  saveB.textContent = "Save as…";
  saveB.title = "Save the current stage as one of your sets.";
  const delB = document.createElement("button");
  delB.textContent = "✕";
  delB.title = "Delete this set of yours (built-in sets cannot be deleted).";
  setsRow.append(setsSel, loadB, saveB, delB);
  setsCard.appendChild(setsRow);
  const setsNote = document.createElement("div");
  setsNote.className = "note";
  setsNote.textContent = "Pick a set and Load. Rooms are built from locked walls, doors and furniture; scenes place two people and the camera.";
  setsCard.appendChild(setsNote);
  right.appendChild(setsCard);
  let SETS = { builtin: [], mine: [] };
  const fillSets = () => {
    const cur = setsSel.value;
    setsSel.replaceChildren();
    const o0 = document.createElement("option");
    o0.value = ""; o0.textContent = "(pick a set)";
    setsSel.appendChild(o0);
    const groups = {};
    for (const b of SETS.builtin) (groups[b.group] = groups[b.group] || []).push(b);
    for (const [gname, items] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = gname;
      for (const b of items) {
        const o = document.createElement("option");
        o.value = "b:" + b.name; o.textContent = b.name; o.title = b.description || "";
        og.appendChild(o);
      }
      setsSel.appendChild(og);
    }
    if (SETS.mine.length) {
      const og = document.createElement("optgroup");
      og.label = "Mine";
      for (const m of SETS.mine) {
        const o = document.createElement("option");
        o.value = "m:" + m.name; o.textContent = m.name;
        og.appendChild(o);
      }
      setsSel.appendChild(og);
    }
    setsSel.value = [...setsSel.options].some((o) => o.value === cur) ? cur : "";
    setsSum.textContent = SETS.builtin.length + " built-in · " + SETS.mine.length + " mine";
    const opt = setsSel.selectedOptions[0];
    const chosen = findSet();
    setsNote.textContent = (opt && opt.title) || "Pick a set and Load. Rooms are built from locked walls, doors and furniture; scenes place two people and the camera.";
    if (chosen && chosen.text) setsNote.textContent += "  Example text: " + chosen.text;
    delB.disabled = !setsSel.value.startsWith("m:");
  };
  const fetchSets = async () => {
    try {
      const r = await fetch("/rednode/camera_sets");
      SETS = await r.json();
    } catch (e) { SETS = { builtin: [], mine: [] }; }
    fillSets();
  };
  fetchSets();
  setsSel.onchange = fillSets;
  function findSet() {
    const v = setsSel.value;
    if (v.startsWith("b:")) return SETS.builtin.find((b) => b.name === v.slice(2));
    if (v.startsWith("m:")) return SETS.mine.find((m) => m.name === v.slice(2));
    return null;
  }
  loadB.onclick = () => {
    const set = findSet();
    if (!set) return;
    const keep = { cam_loras: st.cam_loras, output: st.output, join: st.join,
                   auto_latent: st.auto_latent, latent_mp: st.latent_mp, latent_batch: st.latent_batch,
                   zoom_lora: st.zoom_lora, zoom_mode: st.zoom_mode, zoom_strength: st.zoom_strength };
    st = normalise({ ...JSON.parse(JSON.stringify(set.state)), ...keep });
    sel = 0;
    write(); render();
  };
  saveB.onclick = async () => {
    const cur = setsSel.value.startsWith("m:") ? setsSel.value.slice(2) : "";
    const name = (window.prompt("Save this stage as a set named:", cur) || "").trim();
    if (!name) return;
    try {
      const r = await fetch("/rednode/camera_sets", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name, state: st }) });
      const d = await r.json();
      if (d.mine) { SETS.mine = d.mine; fillSets(); setsSel.value = "m:" + name; fillSets(); }
    } catch (e) { /* server not up */ }
  };
  delB.onclick = async () => {
    if (!setsSel.value.startsWith("m:")) return;
    const name = setsSel.value.slice(2);
    if (!window.confirm("Delete your set '" + name + "'?")) return;
    try {
      const r = await fetch("/rednode/camera_sets", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name }) });
      const d = await r.json();
      if (d.mine) { SETS.mine = d.mine; fillSets(); }
    } catch (e) { /* server not up */ }
  };

  const camCard = document.createElement("div");
  camCard.className = "card";
  const camTtl = document.createElement("div");
  camTtl.className = "ttl";
  camTtl.textContent = "CAMERA";
  const camSum = document.createElement("span");
  camSum.className = "sum";
  camTtl.appendChild(camSum);
  camCard.appendChild(camTtl);
  right.appendChild(camCard);

  const subjCard = document.createElement("div");
  subjCard.className = "card";
  const sTtl = document.createElement("div");
  sTtl.className = "ttl";
  sTtl.textContent = "SUBJECTS";
  subjCard.appendChild(sTtl);
  right.appendChild(subjCard);

  // AUTO LATENT, the user's ask: the frame's aspect is part of the camera
  // language, so an empty latent shaped by the angle, lens and scene spread
  // comes out of the node; wire it into the sampler and the frame follows
  const latCard = document.createElement("div");
  latCard.className = "card";
  const lTtl = document.createElement("div");
  lTtl.className = "ttl";
  lTtl.textContent = "AUTO LATENT";
  const lSum = document.createElement("span");
  lSum.className = "sum";
  lTtl.appendChild(lSum);
  latCard.appendChild(lTtl);
  right.appendChild(latCard);

  // CAMERA PATH (batch angles, the user's ask): A -> B in N shots, or an
  // orbit round the subject. The node then emits N prompts / latents /
  // camera_json as lists, so one Queue renders the whole path. The dots on
  // the stage show where each shot's camera stands.
  const pathCard = document.createElement("div");
  pathCard.className = "card";
  const pTtl = document.createElement("div");
  pTtl.className = "ttl";
  pTtl.textContent = "CAMERA PATH";
  const pSum = document.createElement("span");
  pSum.className = "sum";
  pTtl.appendChild(pSum);
  pathCard.appendChild(pTtl);
  right.appendChild(pathCard);

  const outCard = document.createElement("div");
  outCard.className = "card";
  outCard.style.gridColumn = "1 / -1";
  const oTtl = document.createElement("div");
  oTtl.className = "ttl";
  oTtl.textContent = "CAMERA PROMPT";
  const oSum = document.createElement("span");
  oSum.className = "sum";
  oTtl.appendChild(oSum);
  outCard.appendChild(oTtl);
  const out = document.createElement("div");
  out.className = "out";
  outCard.appendChild(out);
  const outRow = document.createElement("div");
  outRow.className = "row";
  const copyB = document.createElement("button");
  copyB.textContent = "⧉ Copy";
  copyB.onclick = () => navigator.clipboard?.writeText(out.textContent || "");
  const joinB = document.createElement("button");
  joinB.title = "Where the camera paragraph goes when prompt_in is wired: leading "
    + "the prompt (the research's finding) or trailing it.";
  joinB.onclick = () => { st.join = st.join === "lead" ? "trail" : "lead"; write(); render(); };
  // OUTPUT STYLE (the user's ask: the studio for other models too). krea2 is
  // the tuned paragraph; short and tags are the same geometry in plain words
  // or booru tags, for XL-class encoders. Untuned there as of 2026-08-17.
  const styleSel = document.createElement("select");
  for (const [v, l] of [["krea2", "Krea 2 paragraph"], ["short", "Short (plain words)"],
                        ["tags", "Tags (booru)"]]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l;
    styleSel.appendChild(o);
  }
  styleSel.title = "Prompt style. Krea 2 paragraph is the tuned default; Short and Tags "
    + "say the same camera in plain words or booru tags for XL / Pony / Illustrious "
    + "(untuned there yet).";
  styleSel.onchange = () => { st.output = styleSel.value; write(); render(); };
  outRow.append(copyB, joinB, styleSel);
  outCard.appendChild(outRow);
  host.appendChild(outCard);

  // ---- helpers
  const slider = (label, min, max, step, get, set, fmt) => {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = label;
    const r = document.createElement("input");
    r.type = "range";
    r.min = min; r.max = max; r.step = step;
    r.value = get();
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = fmt(get());
    r.addEventListener("input", () => {
      set(parseFloat(r.value));
      v.textContent = fmt(get());
      draw(); readout();
    });
    r.addEventListener("change", () => { write(); render(); });
    row.append(k, r, v);
    return row;
  };

  const worldToPx = (x, z) => [STAGE_W / 2 + x * pxm(), STAGE_H / 2 + z * pxm()];
  const pxToWorld = (px, py) => [(px - STAGE_W / 2) / pxm(), (py - STAGE_H / 2) / pxm()];

  // ---- draw the stage
  function draw() {
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, STAGE_W, STAGE_H);
    // grid, 1m
    g.strokeStyle = "#1a1d22";
    g.lineWidth = 1;
    for (let x = STAGE_W / 2 % pxm(); x < STAGE_W; x += pxm()) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, STAGE_H); g.stroke();
    }
    for (let y = STAGE_H / 2 % pxm(); y < STAGE_H; y += pxm()) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(STAGE_W, y); g.stroke();
    }
    // origin cross
    g.strokeStyle = "#2a2e34";
    g.beginPath(); g.moveTo(STAGE_W / 2, 0); g.lineTo(STAGE_W / 2, STAGE_H); g.stroke();
    g.beginPath(); g.moveTo(0, STAGE_H / 2); g.lineTo(STAGE_W, STAGE_H / 2); g.stroke();

    const cam = st.camera;
    const tsub = st.subjects[cam.target] || st.subjects[0];
    const geo = geometry(cam, tsub);
    const [cx, cy] = worldToPx(cam.pos[0], cam.pos[2]);
    const [tx, ty] = worldToPx(geo.tgt[0], geo.tgt[2]);

    // frustum wedge: half the horizontal FOV each side of the look line
    const yaw = Math.atan2(tx - cx, -(ty - cy));      // screen yaw, 0 = up
    const half = (fovDeg(cam.focal_mm) / 2) * Math.PI / 180;
    const reach = Math.max(60, Math.hypot(tx - cx, ty - cy) * 1.6);
    const edge = (a) => [cx + Math.sin(a) * reach, cy - Math.cos(a) * reach];
    const [lx, ly] = edge(yaw - half), [rx, ry] = edge(yaw + half);
    g.fillStyle = "rgba(74,143,224,.10)";
    g.strokeStyle = "rgba(74,143,224,.55)";
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(lx, ly); g.lineTo(rx, ry); g.closePath();
    g.fill(); g.stroke();
    // look line to the target
    g.setLineDash([4, 4]);
    g.strokeStyle = "#9dc0ff";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
    g.setLineDash([]);

    // the camera path: a dot per shot, numbered at the ends
    if (st.path && st.path.mode !== "off") {
      const cams = pathCameras(st);
      g.fillStyle = "rgba(240,197,138,.9)";
      g.strokeStyle = "rgba(240,197,138,.5)";
      g.lineWidth = 1;
      g.beginPath();
      cams.forEach((c, i) => { const [px, py] = worldToPx(c.pos[0], c.pos[2]); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke();
      cams.forEach((c, i) => {
        const [px, py] = worldToPx(c.pos[0], c.pos[2]);
        g.beginPath(); g.arc(px, py, i === 0 || i === cams.length - 1 ? 4 : 2.5, 0, Math.PI * 2); g.fill();
      });
      g.font = "10px system-ui"; g.textAlign = "center";
      const [ax, ay] = worldToPx(cams[0].pos[0], cams[0].pos[2]);
      const [bx, by] = worldToPx(cams[cams.length - 1].pos[0], cams[cams.length - 1].pos[2]);
      const ab = st.path.mode === "ab";
      g.fillText(ab ? "A · 1" : "1", ax, ay - 7);
      g.fillText(ab ? "B · " + cams.length : String(cams.length), bx, by - 7);
    }
    // B: a second, hollow camera icon you can drag (A -> B mode)
    if (st.path && st.path.mode === "ab" && st.path.b && Array.isArray(st.path.b.pos)) {
      const [bx, by] = worldToPx(st.path.b.pos[0], st.path.b.pos[2]);
      g.strokeStyle = "#f0c58a";
      g.lineWidth = 2;
      g.beginPath(); g.arc(bx, by, 8, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#f0c58a";
      g.font = "bold 10px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("B", bx, by);
      g.font = "10px system-ui";
      g.fillText("h " + Number(st.path.b.pos[1]).toFixed(2) + " m · " + Math.round(st.path.b.focal_mm || st.camera.focal_mm) + "mm", bx, by + 20);
    }

    // the free aim point, when unlocked: a crosshair on the ground the lens
    // looks at; drag it to compose off-centre
    if (cam.lock === false) {
      const [ax, ay] = worldToPx(cam.aim[0], cam.aim[2]);
      g.strokeStyle = "#f0c58a";
      g.lineWidth = 2;
      g.beginPath(); g.arc(ax, ay, 8, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(ax - 13, ay); g.lineTo(ax + 13, ay); g.stroke();
      g.beginPath(); g.moveTo(ax, ay - 13); g.lineTo(ax, ay + 13); g.stroke();
      g.fillStyle = "#f0c58a";
      g.font = "10px system-ui";
      g.textAlign = "center";
      g.fillText("aim", ax, ay + 24);
    }
    // relations: a dashed line between related entries, drawn underneath
    st.subjects.forEach((s) => {
      if (!s.rel || !st.subjects[s.rel.to]) return;
      const o = st.subjects[s.rel.to];
      const [ax, ay] = worldToPx(s.pos[0], s.pos[2]);
      const [bx, by] = worldToPx(o.pos[0], o.pos[2]);
      g.setLineDash([3, 3]);
      g.strokeStyle = "#8fa8c8";
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#8fa8c8";
      g.font = "9px system-ui";
      g.textAlign = "center";
      g.fillText(s.rel.kind, (ax + bx) / 2, (ay + by) / 2 - 4);
    });
    // objects: rectangles with their footprint (walls as lines), before people
    st.subjects.forEach((s, i) => {
      if (s.kind === "person") return;
      const [sx, sy] = worldToPx(s.pos[0], s.pos[2]);
      const w = Math.max(10, s.size[0] * pxm()), d = Math.max(10, s.size[1] * pxm());
      g.save();
      g.translate(sx, sy);
      g.rotate(-(s.facing_deg * Math.PI) / 180);
      g.fillStyle = "#3a4552";
      g.strokeStyle = i === sel ? "#4a8fe0" : "#5b6675";
      g.lineWidth = i === sel ? 3 : 1.5;
      g.beginPath();
      if (s.kind === "object") g.rect(-w / 2, -d / 2, w, d);
      else g.rect(-w / 2, -3, w, 6);
      g.fill(); g.stroke();
      // the FRONT edge (facing 0 = +z = down on screen): a bright edge and a
      // small arrow, so a sofa, a door, a TV read which way they face
      if (s.kind === "object" || s.kind === "door") {
        const fy = s.kind === "object" ? d / 2 : 3;
        g.strokeStyle = "#e8ecf1";
        g.lineWidth = 3;
        g.beginPath(); g.moveTo(-w / 2, fy); g.lineTo(w / 2, fy); g.stroke();
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(0, fy); g.lineTo(0, fy + 10); g.stroke();
        g.fillStyle = "#e8ecf1";
        g.beginPath(); g.arc(0, fy + 12, 3.5, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      if (s.locked) {
        g.fillStyle = "#9aa0a8";
        g.font = "10px system-ui";
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("\uD83D\uDD12", sx + Math.max(w, 10) / 2 - 2, sy - Math.max(d, 8) / 2 - 2);
      }
      g.fillStyle = "#e8ecf1";
      g.font = "bold 10px system-ui";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String.fromCharCode(65 + i), sx, sy);
      g.fillStyle = "#9aa0a8";
      g.font = "10px system-ui";
      g.fillText(s.name.slice(0, 18), sx, sy + Math.max(d, 8) / 2 + 12);
    });
    // people: dots with a facing arrow
    st.subjects.forEach((s, i) => {
      if (s.kind !== "person") return;
      const [sx, sy] = worldToPx(s.pos[0], s.pos[2]);
      const r = 9 + s.height * 2;
      g.fillStyle = i === cam.target ? "#e0a84a" : "#c8ccd2";
      g.strokeStyle = i === sel ? "#4a8fe0" : "#2a2e34";
      g.lineWidth = i === sel ? 3 : 1.5;
      g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill(); g.stroke();
      // facing arrow: facing 0 = +z = DOWN on screen
      const fa = (s.facing_deg * Math.PI) / 180;
      const ax = sx + Math.sin(fa) * (r + 16), ay = sy + Math.cos(fa) * (r + 16);
      g.strokeStyle = "#e8ecf1";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(ax, ay); g.stroke();
      g.fillStyle = "#e8ecf1";
      g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill();
      if (s.locked) {
        g.fillStyle = "#9aa0a8";
        g.font = "10px system-ui";
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("\uD83D\uDD12", sx + r + 4, sy - r - 4);
      }
      g.fillStyle = "#101216";
      g.font = "bold 10px system-ui";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String.fromCharCode(65 + i), sx, sy);
      g.fillStyle = "#9aa0a8";
      g.font = "10px system-ui";
      g.fillText(s.name.slice(0, 18), sx, sy + r + 12);
    });

    // camera icon
    g.fillStyle = "#4a8fe0";
    g.strokeStyle = "#9dc0ff";
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = "#e8ecf1";
    g.font = "10px system-ui";
    g.textAlign = "center";
    g.fillText("h " + cam.pos[1].toFixed(2) + " m", cx, cy - 16);
    g.fillText(Math.round(cam.focal_mm) + "mm", cx, cy + 20);
    stSum.textContent = "1 square = 1 m · " + (st.stage_zoom === "huge" ? "48 x 38 m" : st.stage_zoom === "wide" ? "24 x 19 m" : "12 x 9 m");
    scaleChips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.zoom === (st.stage_zoom || "normal")));
  }

  // ---- hit testing and drag
  const hit = (px, py) => {
    const cam = st.camera;
    const [cx, cy] = worldToPx(cam.pos[0], cam.pos[2]);
    if (Math.hypot(px - cx, py - cy) < 14) return { kind: "cam" };
    if (st.path && st.path.mode === "ab" && st.path.b && Array.isArray(st.path.b.pos)) {
      const [bx, by] = worldToPx(st.path.b.pos[0], st.path.b.pos[2]);
      if (Math.hypot(px - bx, py - by) < 14) return { kind: "pathB" };
    }
    if (cam.lock === false) {
      const [ax, ay] = worldToPx(cam.aim[0], cam.aim[2]);
      if (Math.hypot(px - ax, py - ay) < 14) return { kind: "aim" };
    }
    for (let i = st.subjects.length - 1; i >= 0; i--) {
      const s = st.subjects[i];
      const [sx, sy] = worldToPx(s.pos[0], s.pos[2]);
      if (s.kind !== "person") {
        const w = Math.max(10, s.size[0] * pxm()), d = Math.max(10, s.size[1] * pxm());
        const a = (s.facing_deg * Math.PI) / 180;
        const lx = (px - sx) * Math.cos(a) - (py - sy) * Math.sin(a);
        const ly = (px - sx) * Math.sin(a) + (py - sy) * Math.cos(a);
        const hh = s.kind === "object" ? d / 2 : 6;
        // the front-edge handle turns an object / door
        if ((s.kind === "object" || s.kind === "door") && Math.abs(lx) < 8 && Math.abs(ly - (hh + 12)) < 8) {
          return { kind: "face", i, locked: !!s.locked };
        }
        if (Math.abs(lx) <= w / 2 + 3 && Math.abs(ly) <= hh + 3) return { kind: "subj", i, locked: !!s.locked };
        continue;
      }
      const r = 9 + s.height * 2;
      const fa = (s.facing_deg * Math.PI) / 180;
      const ax = sx + Math.sin(fa) * (r + 16), ay = sy + Math.cos(fa) * (r + 16);
      if (Math.hypot(px - ax, py - ay) < 9) return { kind: "face", i, locked: !!s.locked };
      if (Math.hypot(px - sx, py - sy) < r + 3) return { kind: "subj", i, locked: !!s.locked };
    }
    return null;
  };
  const evPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (STAGE_W / r.width),
            (e.clientY - r.top) * (STAGE_H / r.height)];
  };
  canvas.addEventListener("pointerdown", (e) => {
    const [px, py] = evPos(e);
    const h = hit(px, py);
    if (!h) return;
    e.preventDefault(); e.stopPropagation();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older hosts */ }
    if (h.kind === "subj" || h.kind === "face") { sel = h.i; renderSubjects(); }
    if (h.locked) { draw(); return; }        // select, never move: it is locked
    dragging = h;
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e) => {
    const [px, py] = evPos(e);
    if (!dragging) {
      const hv = hit(px, py);
      canvas.style.cursor = hv ? (hv.locked ? "not-allowed" : "grab") : "crosshair";
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const [wx, wz] = pxToWorld(px, py);
    // snap to 5 cm and CLAMP inside the stage: a thing dragged off the edge
    // was gone for good (the user's report), so the edge is a wall now
    const maxX = STAGE_W / 2 / pxm() - 0.4, maxZ = STAGE_H / 2 / pxm() - 0.4;
    const snap = (v) => Math.round(v * 20) / 20;
    const cx_ = (v) => Math.max(-maxX, Math.min(maxX, snap(v)));
    const cz_ = (v) => Math.max(-maxZ, Math.min(maxZ, snap(v)));
    if (dragging.kind === "cam") {
      st.camera.pos[0] = cx_(wx); st.camera.pos[2] = cz_(wz);
    } else if (dragging.kind === "pathB") {
      st.path.b.pos[0] = cx_(wx); st.path.b.pos[2] = cz_(wz);
    } else if (dragging.kind === "aim") {
      st.camera.aim[0] = cx_(wx); st.camera.aim[2] = cz_(wz);
    } else if (dragging.kind === "subj") {
      st.subjects[dragging.i].pos[0] = cx_(wx);
      st.subjects[dragging.i].pos[2] = cz_(wz);
    } else {
      const s = st.subjects[dragging.i];
      const [sx, sy] = worldToPx(s.pos[0], s.pos[2]);
      s.facing_deg = ((Math.atan2(px - sx, py - sy) * 180) / Math.PI + 360) % 360;
    }
    draw(); readout();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ok */ }
    dragging = null;
    canvas.style.cursor = "crosshair";
    write(); render();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // right-click the stage: the house DOM menu, with the rescues - a camera
  // dragged out of reach comes home, a scattered scene comes back in view,
  // or the whole stage resets. Never LiteGraph.ContextMenu inside a panel.
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    document.querySelector(".rn-cs-menu")?.remove();
    const m = document.createElement("div");
    m.className = "rn-cs-menu";
    m.style.cssText = "position:fixed;z-index:10000;display:flex;flex-direction:column;"
      + "gap:5px;background:#1a1d22;border:1px solid #3a3f47;border-radius:6px;"
      + "padding:8px;min-width:190px;font:12px 'Segoe UI',system-ui,sans-serif;"
      + "color:#d6d9de;box-shadow:0 6px 20px rgba(0,0,0,.5);left:" + e.clientX
      + "px;top:" + e.clientY + "px";
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "background:#15171b;border:1px solid #33373d;border-radius:4px;"
        + "color:#c8ccd2;cursor:pointer;font-size:12px;padding:5px 9px;text-align:left";
      b.onmouseenter = () => { b.style.borderColor = "#4a8fe0"; b.style.color = "#fff"; };
      b.onmouseleave = () => { b.style.borderColor = "#33373d"; b.style.color = "#c8ccd2"; };
      b.onclick = () => { m.remove(); fn(); };
      m.appendChild(b);
    };
    const prime = st.subjects[st.camera.target] || st.subjects[0];
    // CAMERA PATH from the right-click (the user's ask: the buttons were
    // confusing). A is always the camera; B is the second camera icon.
    {
      const [mx, my] = evPos(e);
      const [wx, wz] = pxToWorld(mx, my);
      const snap = (v) => Math.round(v * 20) / 20;
      const px_ = Math.max(-maxXv(), Math.min(maxXv(), snap(wx)));
      const pz_ = Math.max(-maxZv(), Math.min(maxZv(), snap(wz)));
      mk("Path: put A (the camera) here", () => {
        st.camera.pos[0] = px_; st.camera.pos[2] = pz_;
        if (st.path.mode === "off") st.path.mode = "ab";
        write(); render();
      });
      mk("Path: put B here (same height and lens)", () => {
        st.path.b = JSON.parse(JSON.stringify(st.camera));
        st.path.b.pos[0] = px_; st.path.b.pos[2] = pz_;
        if (st.path.mode === "off") st.path.mode = "ab";
        write(); render();
      });
      if (st.path.b) {
        mk("Path: swap A ↔ B", () => {
          const a = JSON.parse(JSON.stringify(st.camera));
          st.camera = normalise({ camera: st.path.b }).camera; st.path.b = a;
          write(); render();
        });
        mk("Path: clear B (path off)", () => { st.path.b = null; if (st.path.mode === "ab") st.path.mode = "off"; write(); render(); });
      }
    }
    mk("Reset camera (in front of subject)", () => {
      st.camera.pos = [prime.pos[0], prime.pos[1] + prime.height * 0.92,
                       prime.pos[2] + 3.0];
      st.camera.lock = true;
      write(); render();
    });
    mk("Bring everything back into view", () => {
      const clampX = (v) => Math.max(-maxXv(), Math.min(maxXv(), v));
      const clampZ = (v) => Math.max(-maxZv(), Math.min(maxZv(), v));
      st.camera.pos[0] = clampX(st.camera.pos[0]); st.camera.pos[2] = clampZ(st.camera.pos[2]);
      st.camera.aim[0] = clampX(st.camera.aim[0]); st.camera.aim[2] = clampZ(st.camera.aim[2]);
      st.subjects.forEach((s) => { s.pos[0] = clampX(s.pos[0]); s.pos[2] = clampZ(s.pos[2]); });
      write(); render();
    });
    mk("Reset the whole stage", () => {
      const keep = { auto_latent: st.auto_latent, latent_mp: st.latent_mp,
                     latent_batch: st.latent_batch, join: st.join, output: st.output };
      st = normalise({ ...keep });
      sel = 0;
      write(); render();
    });
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 8) + "px";
    if (r.right > innerWidth) m.style.left = Math.max(4, innerWidth - r.width - 8) + "px";
    const close = (ev) => {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  });
  const maxXv = () => STAGE_W / 2 / pxm() - 0.4;
  const maxZv = () => STAGE_H / 2 / pxm() - 0.4;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); e.stopPropagation();
    const f = st.camera.focal_mm;
    st.camera.focal_mm = Math.max(12, Math.min(200, Math.round(f * (e.deltaY > 0 ? 0.92 : 1.08))));
    write(); render();
  }, { passive: false });

  // ---- controls
  function renderCamera() {
    [...camCard.children].slice(1).forEach((c) => c.remove());
    const cam = st.camera;
    camCard.appendChild(slider("Height", 0, 6, 0.05, () => cam.pos[1],
      (v) => { cam.pos[1] = v; }, (v) => v.toFixed(2) + " m"));
    camCard.appendChild(slider("Lens", 12, 200, 1, () => cam.focal_mm,
      (v) => { cam.focal_mm = v; }, (v) => Math.round(v) + "mm · " + Math.round(fovDeg(v)) + "°"));
    camCard.appendChild(slider("Roll", -45, 45, 1, () => cam.roll_deg,
      (v) => { cam.roll_deg = v; }, (v) => Math.round(v) + "°"));
    // LOCK ON SUBJECT, the user's ask: on, the lens aims at the target and the
    // subject sits centre frame; off, the lens aims at a free point on the
    // stage (the amber crosshair, drag it) so the subject can sit off-centre
    const lrow = document.createElement("div");
    lrow.className = "row";
    const lk = document.createElement("span");
    lk.className = "k";
    lk.textContent = "Aim";
    const lockB = document.createElement("button");
    lockB.className = cam.lock !== false ? "on" : "";
    lockB.textContent = cam.lock !== false ? "◎ Locked on subject" : "◎ Free aim";
    lockB.title = "Locked: the camera aims at the target subject, centred in the "
                + "frame. Free aim: it aims at the amber crosshair on the stage - "
                + "drag that to compose with the subject off-centre or at the edge; "
                + "the paragraph then says where in the frame the subject falls.";
    lockB.onclick = () => {
      cam.lock = cam.lock === false;
      if (cam.lock === false && (!Array.isArray(cam.aim) || (cam.aim[0] === 0
          && cam.aim[2] === 0 && st.subjects[cam.target]))) {
        // seed the aim beside the subject so unlocking visibly changes something
        const s = st.subjects[cam.target] || st.subjects[0];
        cam.aim = [s.pos[0] + 1.5, 0, s.pos[2]];
      }
      write(); render();
    };
    lrow.append(lk, lockB);
    if (cam.lock === false) {
      const ah = document.createElement("input");
      ah.type = "number";
      ah.step = "0.1"; ah.min = "0"; ah.max = "6";
      ah.value = (cam.aim[1] ?? 0).toFixed(1);
      ah.title = "Height of the aim point in metres (0 = the ground).";
      ah.onchange = () => { cam.aim[1] = Math.max(0, parseFloat(ah.value) || 0); write(); render(); };
      const ak = document.createElement("span");
      ak.className = "k";
      ak.style.width = "auto";
      ak.textContent = "aim height";
      lrow.append(ak, ah);
    }
    camCard.appendChild(lrow);
    // target
    const trow = document.createElement("div");
    trow.className = "row";
    const tk = document.createElement("span");
    tk.className = "k";
    tk.textContent = "Target";
    const tsel = document.createElement("select");
    st.subjects.forEach((s, i) => {
      if (s.kind !== "person") return;         // the lens locks on people
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = String.fromCharCode(65 + i) + " · " + s.name;
      o.selected = i === cam.target;
      tsel.appendChild(o);
    });
    tsel.onchange = () => { cam.target = parseInt(tsel.value, 10); write(); render(); };
    const th = document.createElement("select");
    for (const [v, l] of [["face", "aim at the face"], ["chest", "aim at the chest"],
                          ["waist", "aim at the waist"], ["feet", "aim at the feet"]]) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      const s = st.subjects[cam.target] || st.subjects[0];
      const hmap = { face: null, chest: s.height * 0.72, waist: s.height * 0.55, feet: 0.15 };
      const cur = cam.target_height == null ? "face"
        : Math.abs(cam.target_height - (hmap.chest ?? -1)) < 0.05 ? "chest"
        : Math.abs(cam.target_height - (hmap.waist ?? -1)) < 0.05 ? "waist"
        : Math.abs(cam.target_height - 0.15) < 0.05 ? "feet" : "face";
      o.selected = v === cur;
      th.appendChild(o);
    }
    th.onchange = () => {
      const s = st.subjects[cam.target] || st.subjects[0];
      cam.target_height = { face: null, chest: s.height * 0.72, waist: s.height * 0.55,
                            feet: 0.15 }[th.value];
      write(); render();
    };
    trow.append(tk, tsel, th);
    camCard.appendChild(trow);
    // presets: the seven Camera height stops, so the dial and the studio agree
    const pk = document.createElement("div");
    pk.className = "note";
    pk.textContent = "Presets";
    camCard.appendChild(pk);
    const chips = document.createElement("div");
    chips.className = "chips";
    const PRESETS = {
      "Worm's eye": [0.15, -60, 24], "Low angle": [0.9, -30, 35],
      "Slight low": [1.264, -12, 50], "Eye level": [1.564, 0, 50],
      "Slight high": [1.964, 20, 50], "High angle": [3.2, 45, 35], "Bird's eye": [4.2, 88, 28],
    };
    for (const [name, [y, pitch, f]] of Object.entries(PRESETS)) {
      const c = document.createElement("div");
      c.className = "chip";
      c.textContent = name;
      c.onclick = () => {
        const s = st.subjects[cam.target] || st.subjects[0];
        const face = s.pos[1] + s.height * 0.92;
        const dy = y - face;
        let ground = pitch ? Math.abs(dy) / Math.tan(Math.abs(pitch) * Math.PI / 180) : 3.0;
        ground = Math.max(Math.abs(pitch) >= 85 ? 0.05 : 0.35, Math.min(12, ground));
        // keep the camera's current bearing, set its height and distance
        const yaw = Math.atan2(cam.pos[0] - s.pos[0], cam.pos[2] - s.pos[2]);
        cam.pos = [s.pos[0] + Math.sin(yaw) * ground, y, s.pos[2] + Math.cos(yaw) * ground];
        cam.focal_mm = f;
        write(); render();
      };
      chips.appendChild(c);
    }
    camCard.appendChild(chips);
    // CAMERA LORAS, the user's ask: four slider LoRAs are camera controls in
    // all but name (zoom, and RedNode's own height / orbit / back, trained from
    // text pairs on 2026-08-17), so they live here. Each row: which file, then
    // Off / Auto / Manual. Auto ties the strength to the geometry - the same
    // numbers the words are written from - so LoRA and words push the same
    // way. The workspace applies the active ones as extra slots on the rig's
    // stack when this prompt is active. Off by default (house rule).
    const zk = document.createElement("div");
    zk.className = "note";
    zk.style.cssText = "display:flex;align-items:center;gap:8px";
    zk.textContent = "Camera LoRAs";
    const allAuto = document.createElement("span");
    allAuto.className = "chip";
    allAuto.textContent = "All auto";
    allAuto.title = "Every row that has a file picked goes to Auto.";
    allAuto.onclick = () => {
      for (const k of CAM_LORA_KEYS) { const e = camLoraEntry(st, k); if (e.name) e.mode = "auto"; }
      write(); render();
    };
    const allOff = document.createElement("span");
    allOff.className = "chip";
    allOff.textContent = "All off";
    allOff.onclick = () => {
      for (const k of CAM_LORA_KEYS) camLoraEntry(st, k).mode = "off";
      write(); render();
    };
    zk.append(allAuto, allOff);
    camCard.appendChild(zk);
    const camLoraList = (list) => [...(list || [])];
    const guessName = (key, list) => {
      for (const rx of CAM_LORA_GUESS[key]) {
        const hit = list.find((n) => rx.test(n));
        if (hit) return hit;
      }
      return "";
    };
    for (const key of CAM_LORA_KEYS) {
      const e = camLoraEntry(st, key);
      const row = document.createElement("div");
      row.className = "row";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = CAM_LORA_LABEL[key];
      k.title = CAM_LORA_HINT[key];
      row.appendChild(k);
      const sel = document.createElement("select");
      sel.style.cssText = "flex:1;min-width:0;max-width:220px";
      const fill = (list) => {
        sel.replaceChildren();
        const o0 = document.createElement("option");
        o0.value = ""; o0.textContent = "(pick a LoRA)";
        sel.appendChild(o0);
        const names = [...new Set([...camLoraList(list), ...(e.name ? [e.name] : [])])];
        const guess = guessName(key, names);
        names.sort((x, y) => ((y === guess) - (x === guess)) || x.localeCompare(y));
        for (const nme of names) {
          const o = document.createElement("option");
          o.value = nme; o.textContent = nme.replace(/\.safetensors$/i, "");
          o.selected = nme === e.name;
          sel.appendChild(o);
        }
        if (!e.name && guess) {
          // remember the guess so Auto has a file the moment it is clicked;
          // mode stays off until the user asks
          e.name = guess;
          sel.value = guess;
        }
      };
      fill(LORA_LIST);
      if (!LORA_LIST) fetchLoras().then((l) => fill(l));
      sel.title = CAM_LORA_HINT[key];
      sel.onchange = () => { e.name = sel.value; write(); render(); };
      row.appendChild(sel);
      const modes = document.createElement("div");
      modes.className = "chips";
      for (const [v, l] of [["off", "Off"], ["auto", "Auto"], ["manual", "Manual"]]) {
        const c = document.createElement("div");
        c.className = "chip" + (e.mode === v ? " on" : "");
        c.textContent = l;
        c.onclick = () => { e.mode = v; write(); render(); };
        modes.appendChild(c);
      }
      row.appendChild(modes);
      camCard.appendChild(row);
      if (e.mode !== "off" && e.name) {
        const [lo, hi] = CAM_LORA_RANGE[key];
        if (e.mode === "manual") {
          camCard.appendChild(slider("Strength", lo, hi, 0.1, () => e.strength,
            (v) => { e.strength = v; }, (v) => (v > 0 ? "+" : "") + v.toFixed(1)));
        } else {
          const zn = document.createElement("div");
          zn.className = "note";
          const zs = AUTO_FN[key](st);
          zn.textContent = "Auto " + (zs > 0 ? "+" : "") + zs.toFixed(1) + " for this shot";
          camCard.appendChild(zn);
        }
      }
    }
  }

  function renderSubjects() {
    [...subjCard.children].slice(1).forEach((c) => c.remove());
    st.subjects.forEach((s, i) => {
      const box = document.createElement("div");
      box.className = "subj" + (i === sel ? " sel" : "");
      box.onclick = () => { if (sel !== i) { sel = i; renderSubjects(); draw(); } };
      const head = document.createElement("div");
      head.className = "head";
      const tag = document.createElement("span");
      tag.style.cssText = "font-weight:700;color:#e0a84a;flex:none";
      tag.textContent = String.fromCharCode(65 + i);
      const nm = document.createElement("input");
      nm.type = "text";
      nm.value = s.name;
      nm.placeholder = "the subject";
      nm.title = "How the paragraph names this subject: 'the woman', 'a man in a coat'.";
      nm.onchange = () => { s.name = nm.value.trim() || "the subject"; write(); render(); };
      const lockB = document.createElement("button");
      lockB.textContent = s.locked ? "\uD83D\uDD12" : "\uD83D\uDD13";
      lockB.title = s.locked ? "Locked: the stage will not move or turn it. Click to unlock."
                             : "Unlocked. Click to lock it in place (walls, doors, furniture).";
      lockB.onclick = (e) => { e.stopPropagation(); s.locked = !s.locked; write(); render(); };
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove this subject.";
      del.disabled = st.subjects.length <= 1;
      del.onclick = (e) => {
        e.stopPropagation();
        st.subjects.splice(i, 1);
        if (st.camera.target >= st.subjects.length) st.camera.target = 0;
        sel = Math.max(0, Math.min(sel, st.subjects.length - 1));
        write(); render();
      };
      const kindB = document.createElement("select");
      for (const v of ["person", "object", "wall", "window", "door"]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = v; o.selected = v === s.kind;
        kindB.appendChild(o);
      }
      kindB.title = "What this is: a person (the lens can lock on it), an object "
                  + "with a footprint, or a wall / window / door drawn as a line.";
      kindB.onchange = () => {
        s.kind = kindB.value;
        if (s.kind !== "person" && s.height > 2.5) s.height = 0.8;
        if (st.camera.target === i && s.kind !== "person") {
          const p = st.subjects.findIndex((x) => x.kind === "person");
          st.camera.target = p >= 0 ? p : 0;
        }
        write(); render();
      };
      head.append(tag, kindB, nm, lockB, del);
      box.appendChild(head);
      if (s.kind === "person") {
        box.appendChild(slider("Height", 0.5, 2.5, 0.01, () => s.height,
          (v) => { s.height = v; }, (v) => v.toFixed(2) + " m"));
      } else {
        box.appendChild(slider("Height", 0.05, 4, 0.05, () => s.height,
          (v) => { s.height = v; }, (v) => v.toFixed(2) + " m"));
        box.appendChild(slider("Width", 0.1, 8, 0.1, () => s.size[0],
          (v) => { s.size[0] = v; }, (v) => v.toFixed(1) + " m"));
        if (s.kind === "object") {
          box.appendChild(slider("Depth", 0.1, 8, 0.1, () => s.size[1],
            (v) => { s.size[1] = v; }, (v) => v.toFixed(1) + " m"));
        }
      }
      box.appendChild(slider("Facing", 0, 359, 1, () => s.facing_deg,
        (v) => { s.facing_deg = v; }, (v) => Math.round(v) + "°"));
      // FACING helpers (the user's ask): what "facing" means per kind, and two
      // one-click turns - toward the camera, toward another entry
      const frow = document.createElement("div");
      frow.className = "row";
      const fnote = document.createElement("span");
      fnote.className = "note";
      fnote.style.flex = "1";
      fnote.textContent = s.kind === "person" ? "Facing = where they look (arrow)."
        : s.kind === "door" ? "Facing = the way through the doorway (bright edge)."
        : s.kind === "object" ? "Facing = the object's front (bright edge)."
        : "Walls and windows have no front.";
      frow.appendChild(fnote);
      if (s.kind !== "wall" && s.kind !== "window") {
        const faceCam = document.createElement("button");
        faceCam.textContent = "Face camera";
        faceCam.onclick = () => {
          const c = st.camera.pos;
          s.facing_deg = ((Math.atan2(c[0] - s.pos[0], c[2] - s.pos[2]) * 180) / Math.PI + 360) % 360;
          write(); render();
        };
        frow.appendChild(faceCam);
        if (st.subjects.length > 1) {
          const faceSel = document.createElement("select");
          const o0 = document.createElement("option");
          o0.value = ""; o0.textContent = "Face…";
          faceSel.appendChild(o0);
          st.subjects.forEach((o2, j) => {
            if (j === i) return;
            const o = document.createElement("option");
            o.value = String(j); o.textContent = String.fromCharCode(65 + j) + " · " + o2.name.slice(0, 14);
            faceSel.appendChild(o);
          });
          faceSel.onchange = () => {
            const j = parseInt(faceSel.value, 10);
            if (Number.isNaN(j)) return;
            const t = st.subjects[j].pos;
            s.facing_deg = ((Math.atan2(t[0] - s.pos[0], t[2] - s.pos[2]) * 180) / Math.PI + 360) % 360;
            write(); render();
          };
          frow.appendChild(faceSel);
        }
      }
      box.appendChild(frow);
      // RELATION: "is [sitting on] [the bed]" - the words the model reads best;
      // the geometry then covers what the relation leaves unsaid
      if (st.subjects.length > 1) {
        const rrow = document.createElement("div");
        rrow.className = "row rel";
        rrow.style.flexWrap = "nowrap";
        const rk = document.createElement("span");
        rk.className = "k";
        rk.textContent = "Relation";
        const rkind = document.createElement("select");
        const KINDS = ["", "on", "sitting on", "lying on", "standing on", "in", "beside",
                       "next to", "behind", "under", "at", "holding", "leaning on",
                       "looking at"];
        for (const k of KINDS) {
          const o = document.createElement("option");
          o.value = k; o.textContent = k || "(none)";
          o.selected = k === (s.rel ? s.rel.kind : "");
          rkind.appendChild(o);
        }
        const rto = document.createElement("select");
        st.subjects.forEach((o2, j) => {
          if (j === i) return;
          const o = document.createElement("option");
          o.value = String(j);
          o.textContent = String.fromCharCode(65 + j) + " · " + o2.name;
          o.selected = !!(s.rel && s.rel.to === j);
          rto.appendChild(o);
        });
        const commitRel = () => {
          s.rel = rkind.value ? { kind: rkind.value, to: parseInt(rto.value, 10) } : null;
          write(); render();
        };
        rkind.onchange = commitRel;
        rto.onchange = commitRel;
        rrow.append(rk, rkind, rto);
        box.appendChild(rrow);
      }
      subjCard.appendChild(box);
    });
    const addRow = document.createElement("div");
    addRow.className = "row";
    const add = document.createElement("button");
    add.textContent = "＋ Person";
    add.onclick = () => {
      const n = st.subjects.length;
      st.subjects.push({ name: n === 1 ? "a second person" : "another person",
                         pos: [n * 1.2 - 0.6, 0, -1.5 * n], height: 1.75, facing_deg: 0,
                         kind: "person", size: [0.6, 0.6], rel: null });
      sel = st.subjects.length - 1;
      write(); render();
    };
    const addObj = document.createElement("button");
    addObj.textContent = "＋ Object";
    addObj.title = "A bed, a lamp, a table: placed and named here, described in your "
                 + "Subject or Surroundings text. The paragraph says WHERE it is.";
    addObj.onclick = () => {
      const n = st.subjects.length;
      st.subjects.push({ name: "the object", pos: [1.5, 0, -1.0 * n], height: 0.8,
                         facing_deg: 0, kind: "object", size: [1.0, 0.8], rel: null });
      sel = st.subjects.length - 1;
      write(); render();
    };
    addRow.append(add, addObj);
    subjCard.appendChild(addRow);
  }

  function renderPath() {
    [...pathCard.children].slice(1).forEach((c) => c.remove());
    const p = st.path;
    const modes = document.createElement("div");
    modes.className = "chips";
    for (const [v, l, tip] of [["off", "Off", "One shot: the camera as placed."],
                               ["ab", "A → B", "N shots on a straight line from this camera (A) to a second camera (B). Lens and roll blend too."],
                               ["orbit", "Orbit", "N shots round the subject at this distance and height, from one bearing to another (0 = in front, +90 = their left side, 180 = behind)."]]) {
      const c = document.createElement("div");
      c.className = "chip" + (p.mode === v ? " on" : "");
      c.textContent = l; c.title = tip;
      c.onclick = () => { p.mode = v; write(); render(); };
      modes.appendChild(c);
    }
    pathCard.appendChild(modes);
    if (p.mode === "off") { pSum.textContent = "1 shot"; return; }
    pathCard.appendChild(slider("Shots", 2, 24, 1, () => p.shots, (v) => { p.shots = Math.round(v); }, (v) => String(Math.round(v))));
    if (p.mode === "ab") {
      const row = document.createElement("div");
      row.className = "row";
      const setB = document.createElement("button");
      setB.textContent = p.b ? "B ← this camera" : "Set B = this camera";
      setB.title = "Copy the current camera (position, height, lens) into B. Then move the camera to where A should be. Right-click the stage does the same in one step.";
      setB.onclick = () => { p.b = JSON.parse(JSON.stringify(st.camera)); write(); render(); };
      const swap = document.createElement("button");
      swap.textContent = "Swap A ↔ B";
      swap.title = "The current camera becomes B and B becomes the current camera.";
      swap.disabled = !p.b;
      swap.onclick = () => { if (!p.b) return; const a = JSON.parse(JSON.stringify(st.camera)); st.camera = normalise({ camera: p.b }).camera; p.b = a; write(); render(); };
      const goB = document.createElement("button");
      goB.textContent = "Look at B";
      goB.title = "Move the camera to B (A is lost unless you Swap first).";
      goB.disabled = !p.b;
      goB.onclick = () => { if (!p.b) return; st.camera = normalise({ camera: p.b }).camera; write(); render(); };
      row.append(setB, swap, goB);
      pathCard.appendChild(row);
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = p.b
        ? "A is the camera; B is the hollow camera on the stage (drag it). B: " + p.b.pos.map((v) => v.toFixed(1)).join(", ")
          + " m, " + Math.round(p.b.focal_mm) + "mm. Right-click the stage to move A or B, swap, or clear."
        : "Right-click the stage where the path should end and choose \"Put B here\"; the camera is A. Or use the buttons.";
      pathCard.appendChild(n);
    } else {
      pathCard.appendChild(slider("From °", -180, 180, 5, () => p.orbit_from, (v) => { p.orbit_from = v; }, (v) => (v > 0 ? "+" : "") + Math.round(v) + "°"));
      pathCard.appendChild(slider("To °", -180, 180, 5, () => p.orbit_to, (v) => { p.orbit_to = v; }, (v) => (v > 0 ? "+" : "") + Math.round(v) + "°"));
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = "Bearing is relative to the way the subject faces: 0 in front, +90 their left side, 180 behind. Distance and height are this camera's.";
      pathCard.appendChild(n);
    }
    pSum.textContent = p.shots + " shots";
    const nn = document.createElement("div");
    nn.className = "note";
    nn.textContent = "The node emits every shot as a list: prompt, camera_json, latent, width and height each become "
      + p.shots + " entries, and the nodes after it run once per shot in one Queue. In the workspace only the placed camera is used.";
    pathCard.appendChild(nn);
  }

  function renderLatent() {
    [...latCard.children].slice(1).forEach((c) => c.remove());
    const row = document.createElement("div");
    row.className = "row";
    const b = document.createElement("button");
    b.className = st.auto_latent ? "on" : "";
    b.textContent = st.auto_latent ? "▦ Auto latent on" : "▦ Auto latent off";
    b.title = "On: the latent output is an empty latent shaped to suit this "
            + "camera - tall for steep low or high shots, wide for spread-out "
            + "blocking, near square for close portraits - at the pixel budget "
            + "below. Wire it into your sampler instead of an Empty Latent. Off: "
            + "the latent output blocks and width/height still report the "
            + "suggestion.";
    b.onclick = () => { st.auto_latent = !st.auto_latent; write(); render(); };
    row.appendChild(b);
    latCard.appendChild(row);
    latCard.appendChild(slider("Budget", 0.25, 4, 0.05, () => st.latent_mp,
      (v) => { st.latent_mp = v; }, (v) => v.toFixed(2) + " MP"));
    const brow = document.createElement("div");
    brow.className = "row";
    const bk = document.createElement("span");
    bk.className = "k";
    bk.textContent = "Batch";
    const bi = document.createElement("input");
    bi.type = "number"; bi.min = "1"; bi.max = "64"; bi.step = "1";
    bi.value = String(st.latent_batch || 1);
    bi.onchange = () => { st.latent_batch = Math.max(1, Math.min(64, parseInt(bi.value, 10) || 1)); write(); };
    brow.append(bk, bi);
    latCard.appendChild(brow);
    const why = document.createElement("div");
    why.className = "note";
    const [w, h, reason] = autoLatentSize(st);
    why.textContent = "Suggests " + w + " × " + h + " (" + reason + ")";
    latCard.appendChild(why);
    lSum.textContent = w + " × " + h;
  }

  let previewTimer = null;
  function readout() {
    const cam = st.camera;
    const s = st.subjects[cam.target] || st.subjects[0];
    const geo = geometry(cam, s);
    camSum.textContent = "pitch " + Math.round(-geo.pitch) + "° · "
      + geo.distance.toFixed(1) + " m · " + Math.round(fovDeg(cam.focal_mm)) + "° fov";
    joinB.textContent = st.join === "lead" ? "Leads the prompt" : "Trails the prompt";
    styleSel.value = ["krea2", "short", "tags"].includes(st.output) ? st.output : "krea2";
    { const [w, h] = autoLatentSize(st); lSum.textContent = w + " × " + h; }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const text = await S.preview(st);
        out.textContent = text || "";
        oSum.textContent = (text || "").split(/\s+/).filter(Boolean).length + " words";
      } catch (e) { /* server not up */ }
    }, 120);
  }

  function render() {
    st = normalise(st);
    renderCamera();
    renderSubjects();
    renderLatent();
    renderPath();
    draw();
    readout();
  }
  render();
  return { render, refresh: () => { st = normalise(S.get()); render(); } };
}

// ---- the node --------------------------------------------------------------------
async function previewFor(state) {
  const r = await fetch("/rednode/camera_studio_preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  const j = await r.json();
  return j.prompt || "";
}

function buildPanel(node) {
  if (node._rnCsPanel) return;
  const cw = node.widgets?.find((x) => x.name === "config");
  if (!cw) { requestAnimationFrame(() => buildPanel(node)); return; }
  cw.type = "hidden";
  cw.hidden = true;
  cw.computeSize = () => [0, -4];
  const host = document.createElement("div");
  const S = {
    get: () => { try { return JSON.parse(cw.value || "{}"); } catch (e) { return {}; } },
    set: (st) => { cw.value = JSON.stringify(st); },
    onChange: () => node.graph?.setDirtyCanvas(true, false),
    preview: previewFor,
  };
  const studio = buildStudio(host, S);
  const widget = node.addDOMWidget("camera_studio_ui", "camera_studio_ui", host, {
    getValue: () => "",
    setValue: () => {},
    getMinHeight: () => 560,
    serialize: false,
  });
  widget.serialize = false;
  widget.element = host;
  node._rnCsPanel = widget;
  node._rnCsRefresh = studio.refresh;
  const sz = node.computeSize();
  if (node.size[0] < 900) node.size[0] = 900;
  if (node.size[1] < sz[1]) node.size[1] = sz[1];
}

app.registerExtension({
  name: "RedNode.CameraStudio",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      requestAnimationFrame(() => buildPanel(this));
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => { buildPanel(this); this._rnCsRefresh?.(); });
    };
  },
});
