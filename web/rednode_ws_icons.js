// The Workspace rail's icons: one PNG per tab, and the rail's own buttons in SVG.
//
// The rail's own buttons are inline SVG in currentColor, so the active item's white
// and the rail's grey need nothing extra.

const svg = (body) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";

// THE TAB ICONS: web/icons/<tab id>.png, white strokes on transparent, cut from one
// generated sheet. Used as a MASK over the text colour, so they turn grey at rest and
// white on the open tab exactly as an SVG in currentColor would.
const png = (id) => {
  const url = new URL("./icons/" + id + ".png", import.meta.url).href;
  return '<span class="rn-ws-icimg" style="-webkit-mask-image:url(' + url + ');mask-image:url('
    + url + ')" aria-hidden="true"></span>';
};
const TAB_IDS = ["overview", "models", "prompts", "camera", "loras", "latent", "i2i", "editor",
                 "paint", "moodboard", "identity", "detailer", "post", "run", "advanced"];
export const TAB_ICONS = Object.fromEntries(TAB_IDS.map((id) => [id, png(id)]));
// the AI tab has no drawn icon in icons/, so it carries a line-art one: a spark,
// the same mark the auto prompt sections use
TAB_ICONS.ai = svg('<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>');
// Re-render (2026-09-25) has no PNG on the sheet either: a picture rendered again
// from itself, drawn as a frame with a turning arrow
TAB_ICONS.rerender = svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15.5 12a3.5 3.5 0 1 1-1-2.5"/><path d="M15.5 8v2.5H13"/>');

// THE SUB-TABS' ICONS, for the strip in a page header: the same weight as the rail's,
// drawn as line art so they read at 14px on the dark strip. An id with no icon here
// gets the plain square rather than an empty box, so a new sub-tab is never blank.
const SUB_PATHS = {
  canvas: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 15l4-4 3 3 4-5 5 6"/>',
  passes: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  files: '<path d="M4 6h7l2 2h7v10H4z"/>',
  sampling: '<path d="M4 17c4 0 4-10 8-10s4 10 8 10"/>',
  seed: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18"/>',
  source: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/>',
  gallery: '<rect x="3" y="6" width="8" height="12" rx="1.5"/><rect x="13" y="6" width="8" height="12" rx="1.5"/>',
  auto: '<path d="M12 4l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>',
  boosts: '<path d="M6 19V9M12 19V5M18 19v-7"/>',
  subject: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.7 3.1-5.7 7-5.7s7 2 7 5.7"/>',
  scene: '<path d="M3 18h18"/><path d="M5 18l4.5-6 3 3.5L16 10l3 8"/><circle cx="7.5" cy="6.5" r="2"/>',
  hero: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="2.6"/><path d="M8 18.5c0-2.3 1.8-3.6 4-3.6s4 1.3 4 3.6"/>',
  converter: '<path d="M7 4.5L3.5 8 7 11.5"/><path d="M3.5 8H14a4 4 0 014 4"/><path d="M17 19.5L20.5 16 17 12.5"/><path d="M20.5 16H10a4 4 0 01-4-4"/>',
  picture: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4 17l5-4.5 3.5 3L17 11l4 4"/>',
  batch: '<rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 20H5a2 2 0 01-2-2V7"/><path d="M9 12l3-3 2.5 2.5L17 9"/>',
  effects: '<path d="M4 20L14.5 9.5"/><path d="M12.5 7.5l4 4"/><path d="M18 3v3.5M16.25 4.75h3.5"/><path d="M6 5.5v2.5M4.75 6.75h2.5"/>',
  order: '<path d="M9 6.5h12M9 12h12M9 17.5h12"/><path d="M4 7.5V16"/><path d="M2.3 14.3L4 16l1.7-1.7"/>',
  reangle: '<circle cx="12" cy="12" r="2.6"/><path d="M4.5 12a7.5 7.5 0 0113-5"/><path d="M19.5 12a7.5 7.5 0 01-13 5"/><path d="M17.5 3.5V7h-3.5M6.5 20.5V17h3.5"/>',
  swap: '<circle cx="7" cy="8.5" r="3.2"/><circle cx="17" cy="15.5" r="3.2"/><path d="M11.5 6.5h5.5l-2-2"/><path d="M12.5 17.5H7l2 2"/>',
};
// Ids with a drawn icon in icons/ use it rather than the line art here: the Run
// page's own pages, and the Pipeline's stages, added 2026-09-23 in the icon set.
// Adding an icons/<id>.png for any of these is all it takes to use it.
const SUB_PNGS = ["run", "review", "stages", "save", "encode", "decode", "generate",
                  "detailer", "post", "paint"];
export const SUB_ICON = (id) => {
  const key = String(id || "");
  if (SUB_PNGS.includes(key)) return png(key);
  return svg(SUB_PATHS[key] || '<rect x="5" y="5" width="14" height="14" rx="2"/>');
};

// the rail's own two: fold it to icons, and open it back out to labels
export const RAIL_ICONS = {
  fold: svg('<path d="M15 6l-6 6 6 6"/><path d="M20 4v16"/>'),
  open: svg('<path d="M9 6l6 6-6 6"/><path d="M4 4v16"/>'),
  // the whole panel over the window, and back
  full: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  unfull: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
  // the UI preset: a layout of panels
  preset: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v16M10 10h10"/>'),
  // move the rail to the other side of the pages
  side: svg('<path d="M4 8h14l-4-4M20 16H6l4 4"/>'),
};
