import { app } from "../../scripts/app.js";

// RedNode Wildcards — write a __wildcard__ without leaving ComfyUI.
// The same shape as the @keyword manager next door, against /rednode/wildcards.
// A wildcard is a plain .txt with a value per line, so this writes exactly that
// and every other wildcard node reads it without an export step.
// On any change we fire "rednode-wildcards-dirty", so an open Prompt Box
// refreshes its insert dropdown instead of waiting for a page reload.

async function apiGet() {
  try { return await (await fetch("/rednode/wildcards")).json(); }
  catch (e) { return { names: [], files: [] }; }
}
async function apiPost(body) {
  try {
    const r = await fetch("/rednode/wildcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}
function notifyDirty() { window.dispatchEvent(new Event("rednode-wildcards-dirty")); }

const clean = (v) => String(v || "").trim().replace(/^_+|_+$/g, "").replace(/\.txt$/i, "");
const warn = (message) => {
  app.extensionManager?.toast?.add?.({ severity: "warn", summary: "RedNode",
    detail: message, life: 3000 }) ?? alert(message);
};

app.registerExtension({
  name: "rednode.wildcards",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "RedNodeWildcards") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const node = this;
      const nameW = node.widgets.find((w) => w.name === "wildcard");
      const textW = node.widgets.find((w) => w.name === "values");
      let files = [];

      // How many values it holds, and whether this panel may write it: a
      // wildcard that came with another pack is listed and read, never
      // overwritten from here.
      const info = node.addWidget("text", "holds", "", () => {}, { serialize: false });
      info.disabled = true;
      const describe = (name) => {
        const found = files.find((f) => f.name === clean(name).toLowerCase());
        info.value = !clean(name) ? ""
          : !found ? "New. Nothing saved under that name yet."
          : `${found.count} value(s)` + (found.editable ? "" : ", installed elsewhere: read only")
            + (found.shared ? ", and the name is used by more than one file" : "");
      };

      // picking one loads its lines in to edit, exactly as the keyword manager does
      const loadW = node.addWidget("combo", "Load saved", "", async (v) => {
        if (!v) return;
        const j = await apiPost({ action: "read", name: v });
        if (j.error) { warn("RedNode: " + j.error); return; }
        if (nameW) nameW.value = j.name || v;
        if (textW) textW.value = j.values || "";
        files = j.files || files;
        describe(j.name || v);
        node.setDirtyCanvas(true, true);
      }, { values: [""] });
      loadW.serialize = false;

      const refreshList = async (j) => {
        j = j || await apiGet();
        files = j.files || [];
        loadW.options.values = [""].concat((j.names || []).slice().sort());
        describe(nameW?.value);
        node.setDirtyCanvas(true, true);
      };

      const saveBtn = node.addWidget("button", "＋ Save / Update", null, async () => {
        const name = clean(nameW?.value);
        if (!name) { warn("Give the wildcard a name first"); return; }
        const j = await apiPost({ action: "save", name, values: textW?.value || "" });
        if (j.error) { warn("RedNode: " + j.error); return; }
        if (nameW) nameW.value = name;
        await refreshList(j);
        notifyDirty();
      });
      saveBtn.serialize = false;

      const delBtn = node.addWidget("button", "🗑 Delete", null, async () => {
        const name = clean(nameW?.value);
        if (!name) return;
        const j = await apiPost({ action: "delete", name });
        if (j.error) { warn("RedNode: " + j.error); return; }
        await refreshList(j);
        notifyDirty();
      });
      delBtn.serialize = false;

      if (nameW) {
        const typed = nameW.callback;
        nameW.callback = function () {
          const out = typed?.apply(this, arguments);
          describe(nameW.value);
          return out;
        };
      }

      refreshList();
      const w = Math.max(node.size?.[0] || 0, 340);
      const h = Math.max(node.size?.[1] || 0, 320);
      node.setSize([w, h]);
    };
  },
});
