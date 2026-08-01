import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// RedNode Sampler Config: the right-click entries that author named profiles.
//
// A profile is a saved dial set, steps, cfg, sampler, scheduler, detailer steps,
// picked later from the node's profile widget. The node holds TWO dial sets, turbo
// and full, so saving asks which side to read rather than guessing from the
// detection, which the browser cannot see anyway. Deleting is a submenu per name.
//
// The profile combo's option list is baked into object_info, so after a save or a
// delete the frontend needs fresh definitions before the new name shows up in the
// dropdown; the menu says so rather than pretending it was instant.

const NODE = "RedNodeSamplerConfig";

const wval = (node, name) => (node.widgets || []).find((w) => w?.name === name)?.value;

function sideValues(node, side) {
  return {
    steps: wval(node, `${side}_steps`),
    cfg: wval(node, `${side}_cfg`),
    sampler: wval(node, `${side}_sampler`),
    scheduler: wval(node, `${side}_scheduler`),
    detailer_steps: wval(node, `${side}_detailer_steps`),
  };
}

async function saveProfile(node, side) {
  const name = prompt(`Save the ${side} dials as a profile named:`);
  if (!name || !name.trim()) return;
  const res = await api.fetchApi("/rednode/sampler_profiles", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), values: sideValues(node, side) }),
  });
  const d = await res.json();
  if (d.error) { alert(`Could not save the profile: ${d.error}`); return; }
  const w = (node.widgets || []).find((x) => x?.name === "profile");
  if (w?.options?.values && !w.options.values.includes(name.trim())) {
    w.options.values.push(name.trim());           // usable now, not after a refresh
  }
  if (w) w.value = name.trim();
  app.graph?.setDirtyCanvas?.(true, true);
  console.log(`[RedNode Sampler Config] saved profile '${name.trim()}'`);
}

app.registerExtension({
  name: "RedNode.SamplerConfig.Profiles",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const orig = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvasArg, options) {
      const r = orig?.apply(this, arguments);
      const node = this;
      options.push(
        { content: "Save the turbo dials as a profile...",
          callback: () => saveProfile(node, "turbo") },
        { content: "Save the full dials as a profile...",
          callback: () => saveProfile(node, "full") },
        { content: "Delete a profile", has_submenu: true,
          callback: async (value, opts, e, prev) => {
            const res = await api.fetchApi("/rednode/sampler_profiles");
            const d = await res.json();
            const names = Object.keys(d.profiles || {}).sort();
            const items = names.length ? names : ["(no profiles saved)"];
            new LiteGraph.ContextMenu(items, {
              event: e, parentMenu: prev,
              callback: async (name) => {
                if (!names.length) return;
                const del = await api.fetchApi("/rednode/sampler_profiles", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name, delete: true }),
                });
                const dd = await del.json();
                if (dd.error) { alert(`Could not delete: ${dd.error}`); return; }
                const w = (node.widgets || []).find((x) => x?.name === "profile");
                if (w?.options?.values) {
                  const i = w.options.values.indexOf(name);
                  if (i > 0) w.options.values.splice(i, 1);
                  // a node left pointing at the deleted name falls back to auto,
                  // matching what the server will do at queue time anyway
                  if (w.value === name) w.value = "auto";
                }
                app.graph?.setDirtyCanvas?.(true, true);
                console.log(`[RedNode Sampler Config] deleted profile '${name}'`);
              },
            });
          } },
      );
      return r;
    };
  },
});
