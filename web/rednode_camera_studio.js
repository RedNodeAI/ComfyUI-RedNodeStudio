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
const PX_PER_M = 44;               // stage scale
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
.rn-cs .subj .head input[type=text]{flex:1;min-width:0}
.rn-cs .out{background:#101216;border:1px solid #2a2e34;border-radius:7px;padding:9px 11px;
  font-size:12.5px;line-height:1.5;color:#e2e5ea;white-space:pre-wrap;min-height:90px}
.rn-cs .note{font-size:11.5px;color:#7f8792}
`;

// ---- state -----------------------------------------------------------------
const DEFAULT = () => ({
  camera: { pos: [0, 1.56, 3.0], target: 0, target_height: null, focal_mm: 35, roll_deg: 0 },
  subjects: [{ name: "the subject", pos: [0, 0, 0], height: 1.7, facing_deg: 0 }],
  output: "krea2", join: "lead",
});

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
    }
    if (Array.isArray(d.subjects) && d.subjects.length) {
      o.subjects = d.subjects.filter((s) => s && typeof s === "object").map((s) => ({
        name: typeof s.name === "string" ? s.name : "the subject",
        pos: Array.isArray(s.pos) && s.pos.length === 3 ? s.pos.map(Number) : [0, 0, 0],
        height: typeof s.height === "number" ? s.height : 1.7,
        facing_deg: typeof s.facing_deg === "number" ? s.facing_deg : 0,
      }));
    }
    if (typeof d.output === "string") o.output = d.output;
    if (d.join === "trail") o.join = "trail";
  }
  if (o.camera.target >= o.subjects.length) o.camera.target = 0;
  return o;
}

// ---- geometry mirrors of the translator, for the live readout ---------------
const fovDeg = (f) => (2 * Math.atan(36 / (2 * Math.max(4, f)))) * 180 / Math.PI;
function geometry(cam, subj) {
  const face = [subj.pos[0], subj.pos[1] + subj.height * 0.92, subj.pos[2]];
  const tgt = cam.target_height != null ? [face[0], cam.target_height, face[2]] : face;
  const dx = tgt[0] - cam.pos[0], dy = tgt[1] - cam.pos[1], dz = tgt[2] - cam.pos[2];
  const ground = Math.hypot(dx, dz);
  return {
    distance: Math.hypot(dx, dy, dz),
    pitch: (ground || dy) ? Math.atan2(dy, ground) * 180 / Math.PI : 0,
    yaw: ground ? Math.atan2(dx, -dz) * 180 / Math.PI : 0,
    tgt,
  };
}

// ---- the panel ---------------------------------------------------------------
// S: { get(): state, set(state): void, onChange(): void, preview(state)->Promise<string> }
export function buildStudio(host, S) {
  if (!document.getElementById("rn-cs-style")) document.head.appendChild(css);
  host.classList.add("rn-cs");
  let st = normalise(S.get());
  let sel = 0;                       // selected subject index
  let dragging = null;               // {kind: "cam"|"subj"|"face", i}
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
  legend.textContent = "Drag a subject to move it, its arrow to turn it, the camera "
    + "to move it. Wheel over the stage changes the lens. Up on the stage is away "
    + "from the default camera (-z).";
  stageCard.appendChild(legend);
  cols.appendChild(stageCard);

  // ---- right: the controls
  const right = document.createElement("div");
  right.style.cssText = "display:flex;flex-direction:column;gap:10px;min-width:0";
  cols.appendChild(right);

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
  outRow.append(copyB, joinB);
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

  const worldToPx = (x, z) => [STAGE_W / 2 + x * PX_PER_M, STAGE_H / 2 + z * PX_PER_M];
  const pxToWorld = (px, py) => [(px - STAGE_W / 2) / PX_PER_M, (py - STAGE_H / 2) / PX_PER_M];

  // ---- draw the stage
  function draw() {
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, STAGE_W, STAGE_H);
    // grid, 1m
    g.strokeStyle = "#1a1d22";
    g.lineWidth = 1;
    for (let x = STAGE_W / 2 % PX_PER_M; x < STAGE_W; x += PX_PER_M) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, STAGE_H); g.stroke();
    }
    for (let y = STAGE_H / 2 % PX_PER_M; y < STAGE_H; y += PX_PER_M) {
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

    // subjects
    st.subjects.forEach((s, i) => {
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
    stSum.textContent = "1 square = 1 m";
  }

  // ---- hit testing and drag
  const hit = (px, py) => {
    const cam = st.camera;
    const [cx, cy] = worldToPx(cam.pos[0], cam.pos[2]);
    if (Math.hypot(px - cx, py - cy) < 14) return { kind: "cam" };
    for (let i = st.subjects.length - 1; i >= 0; i--) {
      const s = st.subjects[i];
      const [sx, sy] = worldToPx(s.pos[0], s.pos[2]);
      const r = 9 + s.height * 2;
      const fa = (s.facing_deg * Math.PI) / 180;
      const ax = sx + Math.sin(fa) * (r + 16), ay = sy + Math.cos(fa) * (r + 16);
      if (Math.hypot(px - ax, py - ay) < 9) return { kind: "face", i };
      if (Math.hypot(px - sx, py - sy) < r + 3) return { kind: "subj", i };
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
    dragging = h;
    if (h.kind !== "cam") { sel = h.i; renderSubjects(); }
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e) => {
    const [px, py] = evPos(e);
    if (!dragging) {
      canvas.style.cursor = hit(px, py) ? "grab" : "crosshair";
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const [wx, wz] = pxToWorld(px, py);
    const snap = (v) => Math.round(v * 20) / 20;
    if (dragging.kind === "cam") {
      st.camera.pos[0] = snap(wx); st.camera.pos[2] = snap(wz);
    } else if (dragging.kind === "subj") {
      st.subjects[dragging.i].pos[0] = snap(wx);
      st.subjects[dragging.i].pos[2] = snap(wz);
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
    // target
    const trow = document.createElement("div");
    trow.className = "row";
    const tk = document.createElement("span");
    tk.className = "k";
    tk.textContent = "Target";
    const tsel = document.createElement("select");
    st.subjects.forEach((s, i) => {
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
      head.append(tag, nm, del);
      box.appendChild(head);
      box.appendChild(slider("Height", 0.5, 2.5, 0.01, () => s.height,
        (v) => { s.height = v; }, (v) => v.toFixed(2) + " m"));
      box.appendChild(slider("Facing", 0, 359, 1, () => s.facing_deg,
        (v) => { s.facing_deg = v; }, (v) => Math.round(v) + "°"));
      subjCard.appendChild(box);
    });
    const add = document.createElement("button");
    add.textContent = "＋ Subject";
    add.onclick = () => {
      const n = st.subjects.length;
      st.subjects.push({ name: n === 1 ? "a second person" : "another person",
                         pos: [n * 1.2 - 0.6, 0, -1.5 * n], height: 1.75, facing_deg: 0 });
      sel = st.subjects.length - 1;
      write(); render();
    };
    subjCard.appendChild(add);
  }

  let previewTimer = null;
  function readout() {
    const cam = st.camera;
    const s = st.subjects[cam.target] || st.subjects[0];
    const geo = geometry(cam, s);
    camSum.textContent = "pitch " + Math.round(-geo.pitch) + "° · "
      + geo.distance.toFixed(1) + " m · " + Math.round(fovDeg(cam.focal_mm)) + "° fov";
    joinB.textContent = st.join === "lead" ? "Leads the prompt" : "Trails the prompt";
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
