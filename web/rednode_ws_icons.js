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

// the rail's own two: fold it to icons, and open it back out to labels
export const RAIL_ICONS = {
  fold: svg('<path d="M15 6l-6 6 6 6"/><path d="M20 4v16"/>'),
  open: svg('<path d="M9 6l6 6-6 6"/><path d="M4 4v16"/>'),
  // the whole panel over the window, and back
  full: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  unfull: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
};
