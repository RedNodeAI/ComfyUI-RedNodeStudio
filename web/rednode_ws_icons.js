// The Workspace rail's icons, one per tab, as inline SVG line drawings.
//
// Placeholders drawn to one grid (24 x 24, 1.8 stroke, round caps) so they sit
// together; each is swappable on its own. They inherit the text colour, so the
// active item's white and the rail's grey need nothing extra.

const svg = (body) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";

export const TAB_ICONS = {
  overview: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  models: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/>'
    + '<path d="M12 12v9"/>'),
  prompts: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>'),
  camera: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7l1.5-3h4l1.5 3"/>'
    + '<circle cx="12" cy="13.5" r="3.5"/>'),
  loras: svg('<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/>'
    + '<path d="M3 16.5l9 4.5 9-4.5"/>'),
  latent: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7a5 5 0 1 0 5 5"/><path d="M12 7v5h5"/>'),
  i2i: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/>'
    + '<path d="M21 16l-5-5-9 9"/>'),
  editor: svg('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'),
  paint: svg('<path d="M19.5 4.5l-8 8"/><path d="M11.5 12.5c-2.5-.5-4.5 1-5 3.5-.3 1.6-1.3 2.6-3 3 '
    + '4 1.5 8.5 0 8.5-3.5"/>'),
  moodboard: svg('<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" '
    + 'height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" '
    + 'y="13" width="7" height="7" rx="1.2"/>'),
  identity: svg('<path d="M7 19c1-2 1.5-4.5 1.5-7a3.5 3.5 0 0 1 7 0c0 3-.6 5.5-1.7 8"/>'
    + '<path d="M11 21c.7-2 1-5 1-9"/><path d="M4.5 15c.3-1 .5-2 .5-3a7 7 0 0 1 13.5-2.5"/>'
    + '<path d="M19 13c0 2-.3 4-1 6"/>'),
  detailer: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/>'
    + '<circle cx="9" cy="17" r="2"/>'),
  post: svg('<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="12" r="2.5"/>'
    + '<circle cx="7" cy="17" r="2.5"/><path d="M9.2 8.3l5.6 2.6M9.2 15.7l5.6-2.6"/>'),
  run: svg('<path d="M7 4.5l12 7.5-12 7.5z"/>'),
  advanced: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3'
    + 'M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
};

// the rail's own two: fold it to icons, and open it back out to labels
export const RAIL_ICONS = {
  fold: svg('<path d="M15 6l-6 6 6 6"/><path d="M20 4v16"/>'),
  open: svg('<path d="M9 6l6 6-6 6"/><path d="M4 4v16"/>'),
};
