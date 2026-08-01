import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { wsPref } from "./rednode_settings.js";

// Hand the card back when it has been full and IDLE for a while.
//
// The existing free happens on a renderer SWITCH only, and deliberately so: the normal
// way to use the Paint tab is twenty low-denoise passes on one model, and freeing each
// time turns every pass into a multi-gigabyte reload. What that leaves is the case this
// covers: you stop working, and the last model plus whatever the captioners cached sit
// there holding the card.
//
// WHY IDLE IS THE WHOLE DESIGN. VRAM at 98% during sampling is the model doing its job,
// not a leak. A watcher that fires on the percentage alone would spend its time either
// blocked by the queue guard or trying to free memory the running pass is using. So the
// condition is high AND nothing running AND nothing queued, held for the full delay, and
// any activity at all resets the clock.
//
// It lives in the browser because that is where the safe moment is knowable. A server
// timer would be a thread freeing memory on its own schedule, which can land in the
// middle of an executing prompt; ComfyUI has no idle hook to hang one on. The server
// still refuses when the queue is busy, so this is guarded at both ends.
//
// OFF BY DEFAULT. Automatic behaviour that guesses wrong is worse than none.

const TICK = 3000;                 // how often to look; cheap, and drift does not matter
let heldSince = 0;                 // when the high-and-idle spell began, 0 for "not in one"
let working = false;               // one request in flight at a time

function enabled() {
  return !!wsPref("AutoFree", false);
}

async function tick() {
  if (!enabled() || working) {
    heldSince = 0;                 // switching it off abandons any spell in progress
    return;
  }
  let state = null;
  try {
    const res = await api.fetchApi("/rednode/vram_state");
    state = await res.json();
  } catch (e) {
    return;                        // an older pack build or a server hiccup: just wait
  }
  const used = Number(state?.used);
  if (!Number.isFinite(used)) return;          // no readable device, nothing to decide on

  const threshold = Math.max(0.5, Math.min(0.99,
    (Number(wsPref("AutoFreeAt", 95)) || 95) / 100));
  const delayMs = Math.max(5, Number(wsPref("AutoFreeAfter", 30)) || 30) * 1000;

  // ANY activity resets the clock, not just a running prompt: something queued means
  // work is about to start, and unloading in front of it is the worst possible timing.
  if (state.busy || used < threshold) {
    heldSince = 0;
    return;
  }
  if (!heldSince) {
    heldSince = Date.now();
    return;
  }
  if (Date.now() - heldSince < delayMs) return;

  working = true;
  heldSince = 0;                   // whatever happens, this spell is spent
  try {
    const scope = String(wsPref("AutoFreeScope", "both"));
    const pct = Math.round(used * 100);
    console.log(`[RedNode] VRAM has been at ${pct}% with an idle queue for `
              + `${Math.round(delayMs / 1000)}s, unloading (${scope})`);
    // MODELS FIRST, then the captioners, when both are asked for. The caption
    // engines are the ones that surprise people, since a vision model cached
    // between runs is invisible until something else needs the room.
    if (scope !== "engines") {
      const r = await api.fetchApi("/rednode/free_models",
                                   { method: "POST",
                                     headers: { "Content-Type": "application/json" },
                                     body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (d.skipped) {
        // the queue started between our check and the request; nothing was freed
        // and the next tick decides again from scratch
        console.log("[RedNode] auto unload stood down: the queue started");
        return;
      }
      if (d.count) {
        console.log(`[RedNode] freed ${d.count} model(s), about `
                  + `${Math.round((d.freed || 0) / 1048576)} MB`);
      }
    }
    if (scope !== "models") {
      try {
        await api.fetchApi("/rednode/release_engines",
                           { method: "POST",
                             headers: { "Content-Type": "application/json" },
                             body: JSON.stringify({ model: "", url: "" }) });
      } catch (e) {
        // the captioners are a bonus when models were also asked for; the models
        // are the win and they are already done
        console.debug?.("[RedNode] caption engines were not released:", e);
      }
    }
  } catch (e) {
    console.warn("[RedNode] auto unload failed:", e);
  } finally {
    working = false;
  }
}

app.registerExtension({
  name: "RedNode.AutoFree",
  async setup() {
    // A prompt starting or finishing is real activity, so it resets the clock without
    // waiting for the next poll to notice.
    for (const ev of ["execution_start", "executing", "execution_success",
                      "execution_error", "status"]) {
      api.addEventListener?.(ev, () => { heldSince = 0; });
    }
    setInterval(tick, TICK);
  },
});
