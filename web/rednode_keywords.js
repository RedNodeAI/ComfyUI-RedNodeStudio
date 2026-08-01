import { app } from "../../scripts/app.js";

// RedNode Prompt Keywords — manager for the global @keyword library.
// Buttons talk straight to the /rednode/prompts API; on any change we fire
// "rednode-prompts-dirty" so every open prompt box re-colors its @keywords.

async function apiGet() {
  try { return await (await fetch("/rednode/prompts")).json(); }
  catch (e) { return { keywords: {} }; }
}
async function apiPost(body) {
  try {
    const r = await fetch("/rednode/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}
function notifyDirty() { window.dispatchEvent(new Event("rednode-prompts-dirty")); }

app.registerExtension({
  name: "rednode.promptkeywords",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "RedNodePromptKeywords") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const node = this;
      const nameW = node.widgets.find((w) => w.name === "keyword");
      const textW = node.widgets.find((w) => w.name === "prompt_text");

      // searchable combo of existing keywords; picking one loads it into the fields to edit
      const loadW = node.addWidget("combo", "load saved", "", async (v) => {
        if (!v) return;
        const j = await apiGet();
        const kw = j.keywords || {};
        if (v in kw) {
          if (nameW) nameW.value = v;
          if (textW) textW.value = kw[v];
          node.setDirtyCanvas(true, true);
        }
      }, { values: [""] });
      loadW.serialize = false;

      const refreshList = async () => {
        const j = await apiGet();
        loadW.options.values = [""].concat(Object.keys(j.keywords || {}).sort());
        node.setDirtyCanvas(true, true);
      };

      const saveBtn = node.addWidget("button", "＋ Save / Update", null, async () => {
        const name = (nameW?.value || "").trim().replace(/^@+/, "");
        if (!name) { app.extensionManager?.toast?.add?.({ severity: "warn", summary: "RedNode", detail: "Give the keyword a name first", life: 3000 }) ?? alert("Give the keyword a name first"); return; }
        const j = await apiPost({ action: "save", name, text: textW?.value || "" });
        if (j.error) { alert("RedNode: " + j.error); return; }
        if (nameW) nameW.value = name;
        await refreshList();
        notifyDirty();
      });
      saveBtn.serialize = false;

      const delBtn = node.addWidget("button", "🗑 Delete", null, async () => {
        const name = (nameW?.value || "").trim().replace(/^@+/, "");
        if (!name) return;
        await apiPost({ action: "delete", name });
        await refreshList();
        notifyDirty();
      });
      delBtn.serialize = false;

      refreshList();
      const w = Math.max(node.size?.[0] || 0, 320);
      const h = Math.max(node.size?.[1] || 0, 300);
      node.setSize([w, h]);
    };
  },
});
