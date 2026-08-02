import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// RedNode settings, in ComfyUI's own settings dialog.
//
// Only things that are GLOBAL belong here: preferences that apply to every workflow you
// open. Anything that belongs to one workflow, the Post chain, the paint strokes, which
// images are on a tab, stays on the node where you can see it next to its effect.
//
// Measured before writing any of this, so the numbers in the descriptions are real: the
// whole pack's stored state is about 456 KB, of which roughly 200 KB is regenerable LoRA
// caches and 104 KB is Look thumbnails.

const ID = {
  captionCache: "RedNode.Captions.Cache",
  captionCap: "RedNode.Captions.CacheSize",
  lookThumbs: "RedNode.Post.LookThumbnails",
  reviewKeep: "RedNode.Review.HistoryLength",
  savedCap: "RedNode.Save.IndexSize",
  switchAsks: "RedNode.Switch.ResolveRounds",
};

// Workspace display preferences. They live HERE, per install, and never inside the
// workflow config: a preference stored in the workflow travels with a shared file
// and silently rearranges the panel for whoever opens it, which is how somebody
// downloads a workflow and concludes the pack is missing tabs. The controls that
// edit these sit on the Workspace's Advanced tab, next to their effect; this file
// only declares them so the settings dialog can show and persist them.
const WS_PREFS = [
  {
    id: "RedNode.Workspace.PaintLayout",
    name: "Paint and Result arrangement (node view)",
    category: ["RedNode", "Workspace", "Paint layout"],
    tooltip: "How the Paint and Result panes share the node's room: stacked, side by "
           + "side, or deciding by the width available. Full screen always sits side "
           + "by side and ignores this.",
    type: "combo",
    options: ["stacked", "side", "auto"],
    defaultValue: "stacked",
  },
  {
    id: "RedNode.Workspace.OverlayMode",
    name: "Paint mask overlay style",
    category: ["RedNode", "Workspace", "Mask overlay"],
    tooltip: "Hatch is the default and reads on any picture. Flat is a single colour "
           + "for people who find the hatch hard to read.",
    type: "combo",
    options: ["hatch", "flat"],
    defaultValue: "hatch",
  },
  {
    id: "RedNode.Workspace.OverlayOpacity",
    name: "Paint mask overlay opacity",
    category: ["RedNode", "Workspace", "Mask overlay opacity"],
    tooltip: "In Flat mode 100 is fully opaque and hides the picture under the mask, "
           + "which is a deliberate choice some people need. Hatch keeps its "
           + "see-through gaps whatever this says.",
    type: "slider",
    attrs: { min: 10, max: 100, step: 5 },
    defaultValue: 55,
  },
  {
    id: "RedNode.Workspace.SaveRecentShown",
    name: "Recent saves drawn at once",
    category: ["RedNode", "Workspace", "Recent saves"],
    tooltip: "Every card in the Save node's recent list decodes its own image, and a "
           + "zoomed-out canvas counts as 'on screen' for all of them at once, so a long "
           + "list costs hundreds of megabytes and makes the canvas crawl. This bounds "
           + "how many are DRAWN; the list itself keeps everything, and the header offers "
           + "to draw the rest. 0 draws all of them.",
    type: "slider",
    attrs: { min: 0, max: 200, step: 5 },
    defaultValue: 25,
  },
  {
    id: "RedNode.Workspace.LowZoomHide",
    name: "Blank RedNode panels below this zoom",
    category: ["RedNode", "Workspace", "Low zoom"],
    tooltip: "Our panels are HTML sitting over the canvas, so unlike ordinary nodes they "
           + "keep painting every row and thumbnail however far you zoom out. Below this "
           + "zoom they stop drawing their contents and become plain boxes, which is all "
           + "you could read at that size anyway. Raise it to blank them sooner on a big "
           + "workflow. 0 turns it off and draws them at every zoom.",
    type: "slider",
    attrs: { min: 0, max: 1, step: 0.05 },
    defaultValue: 0.55,
  },
  {
    id: "RedNode.Workspace.SliderWheelNotches",
    name: "Wheel clicks to cross a slider",
    category: ["RedNode", "Workspace", "Slider wheel"],
    tooltip: "Hovering a slider and rolling the wheel adjusts it. This is how many "
           + "clicks it takes to go from one end to the other, on every slider whatever "
           + "its units. A wheel has about 9 clicks in a comfortable thumb stroke, so 40 "
           + "is roughly four strokes end to end. Lower moves faster and coarser. Hold "
           + "Space while rolling for one exact step at a time.",
    type: "slider",
    attrs: { min: 8, max: 120, step: 4 },
    defaultValue: 40,
  },
  {
    id: "RedNode.Workspace.OverlayColor",
    name: "Paint mask overlay colour",
    category: ["RedNode", "Workspace", "Mask overlay colour"],
    tooltip: "Red is the pack's colour and stays the default. Blue, magenta and "
           + "yellow are chosen to survive colour vision deficiency; white and black "
           + "separate by brightness alone, so they work for every kind including "
           + "total colour blindness.",
    type: "combo",
    options: ["red", "blue", "magenta", "yellow", "white", "black"],
    defaultValue: "red",
  },
  {
    // AUTOMATIC UNLOADING, off by default. Automatic behaviour that guesses wrong is
    // worse than none, so this is an option you switch on, never the behaviour.
    id: "RedNode.Workspace.AutoFree",
    name: "Unload models when VRAM stays high and nothing is running",
    category: ["RedNode", "VRAM", "Auto unload"],
    tooltip: "Off by default. On, the panel watches VRAM and hands back every model "
           + "ComfyUI is holding, plus the caption engines, once it has been above "
           + "the threshold with an EMPTY QUEUE for the whole delay. It can never "
           + "interrupt a run: high VRAM during sampling is the model doing its job, "
           + "so the idle requirement is what makes this safe rather than a nuisance.",
    type: "boolean",
    defaultValue: false,
  },
  {
    id: "RedNode.Workspace.AutoFreeAt",
    name: "Unload above this VRAM percentage",
    category: ["RedNode", "VRAM", "Auto unload threshold"],
    tooltip: "How full the card has to be before an idle spell counts. The card's own "
           + "figure, including other applications, because the question is whether "
           + "there is room at all.",
    type: "slider",
    attrs: { min: 50, max: 99, step: 1 },
    defaultValue: 95,
  },
  {
    id: "RedNode.Workspace.AutoFreeAfter",
    name: "Seconds of idle before unloading",
    category: ["RedNode", "VRAM", "Auto unload delay"],
    tooltip: "How long VRAM must stay above the threshold with nothing running or "
           + "queued. Short values will unload between passes while you are still "
           + "working, which costs a reload each time.",
    type: "slider",
    attrs: { min: 5, max: 300, step: 5 },
    defaultValue: 30,
  },
  {
    id: "RedNode.Workspace.FreeOnSwitch",
    name: "Unload the previous renderer when switching",
    category: ["RedNode", "VRAM", "Renderer switch"],
    tooltip: "Always is the old behaviour. On a card with room, two renderers can sit "
           + "resident together and switching between them is instant, so Never is "
           + "faster while painting. When high only unloads if VRAM is already above "
           + "the auto unload threshold, which keeps a small card protected without "
           + "paying a reload on a big one.",
    type: "combo",
    options: ["always", "high", "never"],
    defaultValue: "always",
  },
  {
    id: "RedNode.Workspace.AutoFreeScope",
    name: "What auto unload hands back",
    category: ["RedNode", "VRAM", "Auto unload scope"],
    tooltip: "Renderer models are the sampler's checkpoint and LoRAs. Caption engines "
           + "are WD14, JoyCaption and QwenVL, which cache between runs and are the "
           + "ones that surprise people.",
    type: "combo",
    options: ["both", "models", "engines"],
    defaultValue: "both",
  },
  {
    // edited from the Workspace's Advanced tab, where the lit dots live; the dialog
    // has no honest control for a per-tab checklist
    id: "RedNode.Workspace.HiddenTabs",
    name: "Hidden Workspace tabs",
    category: ["RedNode", "Workspace", "Hidden tabs"],
    tooltip: "Managed from the Workspace's Advanced tab. Hiding a tab never turns it "
           + "off: whatever it was doing, it keeps doing.",
    type: "hidden",
    defaultValue: [],
  },
];

/** Read a RedNode setting, with the default if the store has nothing yet. */
export function setting(id, fallback) {
  try {
    const v = app.ui?.settings?.getSettingValue?.(id);
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

async function post(route, body) {
  const res = await api.fetchApi(route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const d = await res.json().catch(() => ({}));
  if (d.error) throw new Error(d.error);
  return d;
}

// In-memory stand-in for hosts whose settings store is absent or read-only (the
// synthetic harness, an ancient frontend). Reads prefer the real store; writes go to
// both, so the panel behaves identically either way within a session.
const prefFallback = {};

// Who to tell when one of these changes. The Workspace registers here; the settings
// DIALOG reaches the panel through each entry's `onChange` below, which is the hook
// the frontend actually calls. Listening for `setting.<id>` events on the api object
// was tried first and was completely inert: nothing dispatches those.
const prefListeners = [];

/** Be told when a Workspace preference changes, by short key. */
export function onWsPrefChange(fn) {
  if (typeof fn === "function") prefListeners.push(fn);
}

function firePrefChange(key) {
  for (const fn of prefListeners) {
    try { fn(key); } catch (e) { console.error("[RedNode] preference listener:", e); }
  }
}
for (const s of WS_PREFS) {
  const key = s.id.replace("RedNode.Workspace.", "");
  s.onChange = (v) => { prefFallback[key] = v; firePrefChange(key); };
}

/** Read a Workspace display preference by its short name. */
export function wsPref(key, fallback) {
  const id = "RedNode.Workspace." + key;
  const v = setting(id, undefined);
  if (v !== undefined) return v;
  return key in prefFallback ? prefFallback[key] : fallback;
}

/** Write one, into the settings store when it exists and the session either way. */
export function setWsPref(key, value) {
  prefFallback[key] = value;
  try {
    app.ui?.settings?.setSettingValue?.("RedNode.Workspace." + key, value);
  } catch (e) { /* the session copy above still applies */ }
}

app.registerExtension({
  name: "RedNode.Settings",
  settings: [
    ...WS_PREFS,
    {
      id: ID.captionCache,
      name: "Remember captions between runs",
      category: ["RedNode", "Captions", "Cache"],
      tooltip: "On, a picture that has already been described is not described again, "
             + "which is the difference between a run taking a moment and a run loading "
             + "a vision model. Off, every queue re-captions from scratch.",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: ID.captionCap,
      name: "How many captions to remember",
      category: ["RedNode", "Captions", "Size"],
      tooltip: "The cache is a plain file, roughly 60 KB at 800 entries. Lower it if you "
             + "want it tidier; there is no performance reason to.",
      type: "slider",
      attrs: { min: 50, max: 2000, step: 50 },
      defaultValue: 800,
    },
    {
      id: ID.lookThumbs,
      name: "Save a thumbnail with each Look",
      category: ["RedNode", "Post processing", "Look thumbnails"],
      tooltip: "A grade is a visual thing, so the Looks picker shows the picture rather "
             + "than the numbers. Those thumbnails are most of the 104 KB that file "
             + "takes. Turn this off and Looks are saved as settings only.",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: ID.reviewKeep,
      name: "Runs kept in the Review strip",
      category: ["RedNode", "Image Review", "History"],
      tooltip: "This history is stored in your WORKFLOW file, not globally, so a longer "
             + "strip makes every save of that workflow slightly bigger. It is small: "
             + "24 runs costs about half a kilobyte.",
      type: "slider",
      attrs: { min: 4, max: 100, step: 4 },
      defaultValue: 24,
    },
    {
      id: ID.savedCap,
      name: "Saved images remembered by the Save node",
      category: ["RedNode", "Save", "Index size"],
      tooltip: "How many saved images stay in the panel for keeping, unkeeping and "
             + "deleting, and how far back Image Review can recover a preview. It "
             + "records paths, not pictures, so even a few thousand is a small file. "
             + "Raise it if you generate big batches and cull them here; entries past "
             + "this many are only forgotten, never deleted from disk.",
      type: "slider",
      attrs: { min: 50, max: 5000, step: 50 },
      defaultValue: 500,
    },
    {
      id: ID.switchAsks,
      name: "Switch: rounds before a branch is called unreachable",
      category: ["RedNode", "Control", "Switch resolve rounds"],
      tooltip: "A Switch asks ComfyUI to produce the branch you picked, and asks again "
             + "until the value arrives. A branch whose group is bypassed never arrives, "
             + "so there has to be a point where it stops: without one the queue spins "
             + "and memory climbs. This is that point, counted per branch. An ordinary "
             + "chain settles in two or three rounds and a switch feeding another switch "
             + "in a few more, so the default is far above anything normal. Raise it only "
             + "if the console says a branch was given up on that you know is live.",
      type: "slider",
      attrs: { min: 4, max: 512, step: 4 },
      defaultValue: 64,
    },
    {
      id: "RedNode.Caches.Clear",
      name: "Clear the regenerable caches",
      category: ["RedNode", "Maintenance", "Clear caches"],
      tooltip: "Empties the LoRA type, hash and Civitai lookup caches, and the caption "
             + "cache. About 260 KB. Nothing you made is touched: no presets, no images, "
             + "no records. They rebuild themselves as you work.",
      type: () => {
        const btn = document.createElement("button");
        btn.textContent = "Clear caches";
        btn.className = "p-button p-component";
        btn.onclick = async () => {
          if (!confirm("Clear the LoRA and caption caches?\n\nPresets, images and "
                     + "records are not touched. The caches rebuild as you work.")) {
            return;
          }
          btn.disabled = true;
          const was = btn.textContent;
          try {
            const d = await post("/rednode/clear_caches", {});
            btn.textContent = `Cleared ${Math.round((d.freed || 0) / 1024)} KB`;
          } catch (e) {
            btn.textContent = "Failed";
            console.error("[RedNode] could not clear the caches:", e);
            alert(`Could not clear them: ${e.message}`);
          }
          setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 2500);
        };
        return btn;
      },
    },
  ],

  async setup() {
    // The server owns the caption cache and the saved index, so it has to be told what
    // the user chose. Sent once at startup and again whenever a value changes, rather
    // than read per request, so a run never waits on the browser.
    const push = async () => {
      try {
        await post("/rednode/settings", {
          caption_cache: !!setting(ID.captionCache, true),
          caption_cap: parseInt(setting(ID.captionCap, 800)) || 800,
          look_thumbs: !!setting(ID.lookThumbs, true),
          saved_cap: parseInt(setting(ID.savedCap, 200)) || 200,
          switch_lazy_asks: parseInt(setting(ID.switchAsks, 64)) || 64,
        });
      } catch (e) {
        /* an older pack build without the route: the defaults still apply */
      }
    };
    await push();
    for (const id of Object.values(ID)) {
      api.addEventListener?.(`setting.${id}`, push);
    }
    // the settings dialog does not always emit per-id events, so catch the generic one
    api.addEventListener?.("settings.changed", push);
  },
});
