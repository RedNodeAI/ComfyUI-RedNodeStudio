import * as _appmod from "../../scripts/app.js";
const { app } = _appmod;

// RedNode Studio — one job: load workflows saved before the widgets were reordered.
//
// widgets_values is a positional array, so moving a widget moves what every saved
// workflow puts in it. Three orders exist now:
//
//   v1  instruction, preset, style_strength     the original
//   v2  style_strength, preset, instruction     preset in the middle
//   v3  style_strength, instruction, preset     preset last, where it is today
//
// v3 exists because a combo drawn directly above a multiline box collides with it:
// the textarea is a real HTML element floating over the canvas and does not respect
// the canvas-drawn widget above it. Moving the combo below the text boxes ends the
// overlap outright, which no amount of layout fiddling above it would.
//
// The three types are distinct enough to tell the orders apart with no version flag.
// Anything that matches none of them is left alone rather than guessed at.

const NODE_NAME = "Krea2RedNode";
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number";

/** [instruction, preset, strength, ...] */
const looksV1 = (v) => Array.isArray(v) && v.length >= 3
  && isStr(v[0]) && isStr(v[1]) && isNum(v[2]);
/** [strength, preset, instruction, ...] */
const looksV2 = (v) => Array.isArray(v) && v.length >= 3
  && isNum(v[0]) && isStr(v[1]) && isStr(v[2]);

app.registerExtension({
  name: "RedNode.Studio.Migrate",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const v = info?.widgets_values;
      if (looksV1(v)) {
        const [instruction, preset, strength, ...rest] = v;
        info.widgets_values = [strength, instruction, preset, ...rest];
        console.log("[RedNode Studio] moved this node's saved values to the current "
                  + "widget order (strength, prompt, preset). Save to keep it.");
      } else if (looksV2(v)) {
        const [strength, preset, instruction, ...rest] = v;
        info.widgets_values = [strength, instruction, preset, ...rest];
        console.log("[RedNode Studio] the preset moved below the text boxes, so this "
                  + "node's saved values moved with it. Save to keep it.");
      }
      return onConfigure?.apply(this, arguments);
    };
  },
});
