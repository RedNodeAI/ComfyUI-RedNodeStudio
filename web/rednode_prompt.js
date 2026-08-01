import { app } from "../../scripts/app.js";

// RedNode Prompt Combine's growth button used to live here: a "+ add textbox" that
// added text_3, text_4 and so on. The panel in rednode_combine.js replaces it, so this
// file keeps only the part that still matters, which is loading the workflows that
// button left behind.
//
// Those nodes have text_3.. widgets and no config. The panel builds its rows from the
// config, so without this they would open with the two legacy boxes and their extra
// prompts sitting invisible in widgets that nothing reads.

const NODE = "RedNodePromptCombine";

app.registerExtension({
  name: "rednode.promptcombine.migrate",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        const cfgW = (this.widgets || []).find((w) => w?.name === "config");
        if (!cfgW) return;
        let cfg = {};
        try { cfg = JSON.parse(cfgW.value || "{}"); } catch (e) { cfg = {}; }
        if (Array.isArray(cfg.parts) && cfg.parts.length > 2) return;   // already moved
        const extras = (this.widgets || [])
          .filter((w) => /^text_\d+$/.test(w?.name || ""))
          .map((w) => ({ i: parseInt(w.name.split("_")[1], 10), v: String(w.value ?? "") }))
          .filter((x) => x.i > 2)
          .sort((a, b) => a.i - b.i);
        if (!extras.length) return;
        const parts = Array.isArray(cfg.parts) && cfg.parts.length
          ? cfg.parts
          : [{ kind: "text", name: "", on: true,
               text: String((this.widgets || []).find((w) => w?.name === "text_1")?.value ?? "") },
             { kind: "text", name: "", on: true,
               text: String((this.widgets || []).find((w) => w?.name === "text_2")?.value ?? "") }];
        for (const x of extras) {
          parts.push({ kind: "text", name: "", on: true, text: x.v });
        }
        cfgW.value = JSON.stringify({ ...cfg, parts });
        this._rnCB = null;                    // make the panel re-read it
        console.log("[RedNode Prompt Combine] moved this node's extra text boxes into "
                  + "the panel. Save the workflow to keep it.");
        this.onConfigure?.call?.(this, info);
      }, 0);
      return r;
    };
  },
});
