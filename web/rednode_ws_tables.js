// The Workspace's tables and pure helpers.
//
// Everything in here is DATA or a pure function: no node, no DOM, no config. It
// lives apart from rednode_workspace.js because that file had grown past 4000
// lines carrying eleven tabs, and a block edit in it twice took neighbouring code
// with it. Splitting the parts that cannot misbehave is the cheap half of fixing
// that, and it costs nothing at runtime: same values, same functions, imported.

// Which tabs exist, in the order they are shown.

// GROUPED ORDER: each group runs contiguously
// so the strip's colour underlines read as bands - model tabs, then canvas
// tabs, then mood, edit, post, settings - instead of interleaving.
export const TAB_ORDER = [
  { id: "models", label: "Models", group: "model" },
  { id: "prompts", label: "Prompts", group: "model" },
  { id: "camera", label: "Camera", group: "model" },
  { id: "loras", label: "LoRAs", group: "model" },
  { id: "latent", label: "Latent", group: "canvas" },
  { id: "i2i", label: "Img2Img", group: "canvas" },
  { id: "paint", label: "Paint", group: "canvas" },
  { id: "moodboard", label: "Moodboard", group: "mood" },
  // Subject, People, Scene and Masks are sub-tabs of this one (IDENTITY_SUBS)
  { id: "identity", label: "Krea 2 Identity", group: "edit" },
  { id: "post", label: "Post", group: "post" },
  { id: "advanced", label: "Advanced", group: "cfg" },
];

// The Krea 2 Identity tab's sub-tabs: the tabs that feed the identity system. Their
// ids are the old top-level tab ids, so a saved rn_tab still lands on them; the old
// People tab is part of Subject now.
export const IDENTITY_SUBS = [
  { id: "subject", label: "SUBJECT", tip: "The people to preserve, picked in order in one gallery: the first is the main subject." },
  { id: "scene", label: "SCENE", tip: "The place: the setting the people are put into." },
  { id: "masks", label: "MASKS", tip: "The subject boost and edit masks, painted in place." },
];

// The gallery tabs and their headings.

// thumbSlider used to gate which of these got a thumbnail size control: Img2Img,
// Subject and Subject 2 had one, Scene, Moodboard and Subject 3 did not, and the size
// behind it was one shared number so the slider on one tab resized the others. Every
// gallery draws its own now, so there is no flag to set and none to forget.
export const IMAGE_TABS = {
  i2i: { label: "Img2Img", hint: "The source image for an image-to-image pass. Its auto "
       + "prompt describes everything and runs through the built-in converter." },
  subject: { label: "Subject", hint: "The person to preserve. The face you want kept." },
  scene: { label: "Scene", hint: "The place. A real image rebuilt as in-context latents." },
  moodboard: { label: "Moodboard", hint: "The look. Select several and they batch into one style signal." },
};

export const PEOPLE_TABS = {
  subject2: { label: "Subject 2" },
  subject3: { label: "Subject 3" },
};

// Every dial, on the tab it belongs to.

export const DIALS = [
  { tab: "subject", key: "boosts_off", bool: true, def: false, label: "Boosts off (low VRAM)",
    hint: "One switch for smaller cards: forces subject and scene fidelity to 1.0 and "
        + "isolation off, so the large attention bias matrix is never built. The sliders "
        + "below keep their values for when this goes back off." },
  { tab: "subject", key: "boost_blocks", choice: ["all", "early", "mid", "late"], def: "all",
    label: "Boost blocks",
    says: { all: "The boosts act through the whole network.",
            early: "Leans on composition and pose.",
            mid: "Between the two: shapes and parts.",
            late: "Leans on texture and fine detail." },
    hint: "Where in the network the fidelity dials act, both Subject fidelity here and "
        + "Scene fidelity on the Scene tab. Early leans composition and pose, late leans "
        + "texture and detail. Experimental: A/B it." },
  { tab: "subject", key: "reference_fidelity", label: "Subject fidelity", min: 0, max: 10, step: 0.05, def: 2.5, vram: "high",
    hint: "Pull toward the subject's appearance. 2 to 6 recommended. Any value other than "
        + "1.0 builds a large attention bias matrix; its size grows with resolution squared." },
  { tab: "subject", key: "likeness_vs_obedience", label: "Likeness vs obedience", min: 0, max: 2048, step: 64, def: 768, vram: "med",
    hint: "Lower follows the instruction more, higher preserves likeness more. Higher "
        + "values feed more vision tokens to the encoder." },
  { tab: "subject", key: "subject_likeness_px", label: "Subject likeness px", min: 0, max: 4096, step: 64, def: 0, vram: "med",
    hint: "Separate likeness cap for the subject when a scene is connected. 0 = shared. "
        + "Higher values feed more vision tokens to the encoder." },
  { tab: "subject", key: "identity_start", label: "Identity start", min: 0, max: 1, step: 0.05, def: 0,
    hint: "When the identity refs switch on during sampling." },
  { tab: "subject", key: "identity_end", label: "Identity end", min: 0, max: 1, step: 0.05, def: 1,
    hint: "When they switch off. Around 0.3 gives pose-only transfer." },
  { tab: "scene", key: "scene_fidelity", label: "Scene fidelity", min: 0, max: 10, step: 0.05, def: 1.0, vram: "high",
    hint: "Pull toward the scene reference's appearance. Any value other than 1.0 builds "
        + "a large attention bias matrix; its size grows with resolution squared." },
  { tab: "moodboard", key: "style_strength", label: "Style strength", min: 0, max: 1, step: 0.05, def: 0.5,
    says: (v) => (v <= 0 ? "Off: the pictures add no look."
                : v < 0.35 ? "A faint hint of the pictures' look."
                : v < 0.7 ? "A clear share of the look, and the prompt still leads."
                : "The look dominates the render."),
    hint: "How much of the style refs survives. This drives the studio's own style_strength "
        + "widget through the bundle and works with ANY preset, named ones included." },
  { tab: "moodboard", key: "transfer", choice: ["style", "subject"], def: "style",
    label: "Transfer",
    labels: { style: "The look", subject: "The content" },
    says: { style: "Takes palette, light, texture and mood. The prompt decides what is in the picture.",
            subject: "Takes the arrangement and objects. The prompt decides how it looks." },
    hint: "What the engine pulls OUT of the images on this tab. It reads the moodboard "
        + "references only; Subject, People, Scene and Masks are untouched. Style takes "
        + "the look (palette, lighting, texture, mood) and leaves the content behind, so "
        + "the prompt decides what is in the picture. Subject takes the content instead "
        + "(composition, objects, what is happening) and lets the prompt decide the look. "
        + "Style is right for a mood board; subject suits copying an arrangement or a "
        + "garment out of a reference photo." },
  { tab: "moodboard", key: "reference_processing", label: "Reference processing",
    def: "full image", choice: ["full image", "quadrant crops (2x2)", "fine tiles (4x4)"],
    labels: { "full image": "Whole picture", "quadrant crops (2x2)": "Cut in 4",
              "fine tiles (4x4)": "Cut in 16" },
    says: { "full image": "Each picture is read whole, layout included.",
            "quadrant crops (2x2)": "Each picture is cut in 4, so its layout stops leaking in.",
            "fine tiles (4x4)": "Cut in 16 small tiles: only colour and texture survive." },
    hint: "How the images on this tab are cut up before encoding. Crops and tiles "
        + "scramble their composition so only the look survives, which is the fix when "
        + "a moodboard reference keeps smuggling its own subject or layout into the "
        + "result. Full image keeps them whole." },
  { tab: "moodboard", key: "style_detail_px", label: "Style detail res", min: 128, max: 1536, step: 64, def: 384, vram: "med",
    says: (v) => (v < 512 ? "Reads the broad look. Light on VRAM."
                : v < 1024 ? "Reads finer pattern and fabric detail."
                : "Reads fine fabric and print detail. Heavy on VRAM."),
    hint: "Vision budget per moodboard ref. Higher resolves fabric and pattern detail, "
        + "and feeds more vision tokens to the encoder." },
  { tab: "moodboard", key: "hide_style_refs", bool: true, def: true, label: "Hide style refs",
    says: { true: "The pictures pass their look through the prompt only. Safest with people in them.",
            false: "The pictures stay in view of the model: a much stronger look." },
    hint: "On (indirect): refs are deleted after encoding and style survives via the prompt, "
        + "safest with people in the refs. OFF keeps the vision tokens in the conditioning: "
        + "a much STRONGER style signal. Try off when the moodboard feels weak." },
  { tab: "moodboard", key: "style_directive", bool: true, def: true, label: "Style directive",
    says: { true: "Adds a line telling the model: style from the pictures, content from my words.",
            false: "No extra line: the pictures and the prompt mix freely." },
    hint: "Adds the 'style from the refs, subjects from the text' sentence." },
  { tab: "subject", key: "isolate_refs", bool: true, def: false, label: "Isolate refs", vram: "high",
    hint: "Two-subject setups: stops the references reading each other. Builds the same "
        + "large attention bias matrix as the fidelity dials." },
  { tab: "masks", key: "edit_mask_feather", label: "Edit mask feather", min: 0, max: 32, step: 1, def: 2,
    hint: "Soft edge on the edit mask, in latent pixels." },
  // the Advanced tab: everything else the Settings node offers, so the workspace can
  // fully replace it
  { tab: "advanced", key: "fit_mode", choice: ["fit", "crop (legacy)"], def: "fit", label: "Fit mode",
    hint: "How EVERY reference image is fitted to the output grid, subject, scene and "
        + "moodboard alike, which is why it lives here and not on one tab. Fit is the "
        + "v1.2 pixel-space geometry: blur-proof at any aspect ratio. Crop is the v1 "
        + "legacy behaviour, still useful with an edit mask whose source is not on the "
        + "target grid." },
  { tab: "advanced", key: "attention", choice: ["auto", "default", "pytorch"], def: "auto",
    label: "Attention",
    hint: "Attention backend for the reference pass only. Auto fixes the Blackwell xformers "
        + "crash when it applies; pytorch avoids sage smearing on reference detail." },
  { tab: "advanced", key: "caption_passthrough", bool: true, def: true,
    label: "Caption inputs pass through",
    hint: "Text wired into subject_caption_in, scene_caption_in, mood_caption_in or "
        + "i2i_caption_in always reaches the matching prompt output, even when that "
        + "tab's auto prompt is off. Switch off to make a wired caption count only "
        + "while the tab's engines are running." },
  { tab: "advanced", key: "echo_prompts", bool: true, def: true,
    label: "Echo prompts to console",
    hint: "Print the first 100 characters of each generated caption to the console, "
        + "which is handy while tuning an engine. Off logs only the length, so a "
        + "console screenshot never carries your writing. The prompt still reaches "
        + "the prompt outputs and the panel either way." },
  { tab: "advanced", key: "picture_labels", bool: true, def: false, label: "Picture labels",
    hint: "Experimental training parity: 'Picture N:' prefixes in the grounded prompt. A/B it." },
  { tab: "advanced", key: "ref_t0_modulation", bool: true, def: false, label: "Ref t0 modulation",
    hint: "Experimental training parity: modulate reference tokens at timestep 0. A/B it." },
  { tab: "advanced", key: "vision_system_prompt", text: true, def: "", label: "Vision system prompt",
    hint: "How the encoder READS the references, before your instruction sees them. Empty = "
        + "training default. For style: 'Describe the artistic style, color palette, lighting "
        + "and rendering technique of the reference images; ignore their subjects entirely.'" },
];

// The Latent tab's preset canvas sizes; workspace.py mirrors this order.

export const LATENT_PRESETS = [
  ["1024 x 1024 (square)", 1024, 1024],
  ["832 x 1216 (portrait)", 832, 1216],
  ["1216 x 832 (landscape)", 1216, 832],
  ["896 x 1152 (portrait)", 896, 1152],
  ["1152 x 896 (landscape)", 1152, 896],
  ["768 x 1344 (tall)", 768, 1344],
  ["1344 x 768 (wide)", 1344, 768],
];

// The post chain: every effect, its controls, and what each one is for.

export const POST_FX = [
  { id: "denoise", label: "Denoise", cost: "scales with sigma",
    blurb: "Smooths noise while leaving edges alone. Run it first, before anything "
         + "that sharpens, or you sharpen the noise too.",
    controls: [
      { key: "sigma", label: "Sigma", min: 0, max: 5, step: 0.001, def: 0.997,
        hint: "How far the smoothing reaches. Bigger cleans more and costs more." },
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.001, def: 0.051,
        hint: "How different a neighbouring pixel may be and still count as the same "
            + "surface. This is what saves edges: raise it and edges start melting." },
      { key: "radius_multiplier", label: "Radius multiplier", min: 0.5, max: 3,
        step: 0.001, def: 1.149,
        hint: "Widens the window around sigma. Above about 1.5 it gets slow fast." },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, def: 1.0,
        hint: "How much of the smoothing lands on the picture. 1 is all of it; 0.6 to 0.8 "
            + "cleans the noise but leaves a little texture, so skin does not go waxy." },
    ] },
  { id: "color", label: "Colour",
    blurb: "The whole tone and colour grade: exposure, the tone curve, lift, gamma and "
         + "gain, white balance with a Measure button, vibrance and split tone. Every "
         + "dial sits at no change until you move it.",
    controls: [
      { head: "Tone" },
      { key: "exposure", label: "Exposure", min: -3, max: 3, step: 0.05, def: 0.0,
        hint: "In stops, the way a camera counts light: +1 is twice the light, -1 is "
            + "half. Done in linear light, so it behaves like opening the lens rather "
            + "than turning up a screen." },
      { key: "brightness", label: "Brightness", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "A straight gain on every channel. 1.00 changes nothing. Exposure is the "
            + "truer control." },
      { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "Pivots around mid grey, so highlights and shadows spread apart while "
            + "the midpoint stays put." },
      { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "Opens or closes the dark end only, by multiplying, so black stays black "
            + "instead of turning into grey haze. White is not touched." },
      { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "Negative pulls a bright sky or a lit cheek back down, positive pushes it "
            + "up. Nothing below mid grey moves, and pure white stays white, so a white "
            + "background is never turned grey." },
      { key: "local_hdr", label: "Local HDR", min: 0, max: 1, step: 0.01, def: 0.0,
        hint: "Flattens the big tonal swing across the frame and leaves the fine detail "
            + "alone: shadows open, bright windows come back, the way a phone's HDR "
            + "reads. 0.3 to 0.5 is plenty." },
      { key: "black_point", label: "Black point", min: -0.5, max: 0.5, step: 0.01, def: 0.0,
        hint: "Positive crushes the blacks for contrast. Negative lifts them into the "
            + "faded, milky film look." },
      { head: "Lift, gamma, gain" },
      { key: "lift", label: "Lift", min: -0.5, max: 0.5, step: 0.005, def: 0.0,
        hint: "Raises or lowers the blacks while white stays put, the colourist's "
            + "shadow wheel. A small positive lift is the soft, printed floor." },
      { key: "gamma", label: "Gamma", min: 0.2, max: 3, step: 0.01, def: 1.0,
        hint: "Bends the midtones: above 1 brightens them, below 1 darkens them, black "
            + "and white stay where they are." },
      { key: "gain", label: "Gain", min: 0, max: 2, step: 0.01, def: 1.0,
        hint: "Scales from black up, so white moves most. Just under 1 takes the edge "
            + "off hot highlights without touching the blacks." },
      { head: "Colour" },
      { key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "0 is black and white, 1 is untouched, above 1 pushes every colour." },
      { key: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "Saturation for the colours that need it: dull colours move most, strong "
            + "ones hardly at all, and skin is held back, so faces do not go orange. "
            + "Negative mutes the same way." },
      { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "White balance trim. Positive warms (more red, less blue), negative cools. "
            + "The frame's average brightness is put back afterwards, so this moves "
            + "colour and never exposure." },
      { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "The other white balance axis: positive pushes green, negative magenta. "
            + "Brightness is held steady here too." },
      { key: "awb", label: "Auto estimator", def: "shades_of_grey", step: 1,
        choice: ["shades_of_grey", "grey_world", "white_patch", "grey_edge"],
        labels: { grey_world: "Grey world (the average is grey)",
                  white_patch: "White patch (the brightest is white)",
                  shades_of_grey: "Shades of grey (the safe pick)",
                  grey_edge: "Grey edge (the edges average grey)" },
        hint: "How Measure works out the light the picture was made under. Shades of "
            + "grey is the safe pick. Grey world suits a busy frame, white patch a frame "
            + "with something truly white in it, grey edge a frame dominated by one "
            + "colour, a red dress or a green field. Choosing one changes nothing on "
            + "its own." },
      { button: "awb", label: "Auto white balance", text: "Measure",
        hint: "Measures the last picture this chain was given and writes the answer into "
            + "Temperature and Tint, then switches this card on. The numbers are yours "
            + "to nudge afterwards. Needs one queued run first, so there is a picture "
            + "to look at." },
      { head: "Split tone" },
      { key: "split_shadow", label: "Shadow tint", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "Colours the dark end without moving its brightness: negative is cool "
            + "blue, positive warm amber. Cool shadows with warm highlights is the "
            + "classic cinema pairing. Pure black takes no tint." },
      { key: "split_highlight", label: "Highlight tint", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "The same for the bright end. A little warmth here makes skin and late sun "
            + "look printed rather than rendered." },
      { key: "split_balance", label: "Balance", min: -1, max: 1, step: 0.05, def: 0.0,
        hint: "Where shadow stops and highlight starts. Negative hands more of the frame "
            + "to the highlight tint, positive more to the shadow tint." },
    ] },
  { id: "match", label: "Match reference",
    blurb: "Moves the frame's colour onto a reference picture's: per channel, the "
         + "average and the spread. Skin is held back so faces keep their hue. Drop a "
         + "picture onto the card, or use a Workspace tab's picture or the wired input.",
    controls: [
      { key: "source", label: "Reference", def: "moodboard",
        choice: ["file", "moodboard", "subject", "scene", "i2i", "wired"],
        labels: { file: "A picture dropped here", moodboard: "Moodboard tab",
                  subject: "Subject tab", scene: "Scene tab", i2i: "Img2Img tab",
                  wired: "The reference input" },
        step: 1,
        hint: "Where the reference picture comes from. Drop a picture on the box below "
            + "to use it and nothing else; the tabs are the Workspace's selected pictures, "
            + "on the Workspace's Post tab only; the reference input is whatever is wired "
            + "into the standalone Post FX node." },
      { key: "method", label: "Method", def: "adain", choice: ["adain", "linear"],
        labels: { adain: "Statistics (sRGB)", linear: "Statistics (linear light)" },
        step: 1,
        hint: "Both move the mean and the spread per channel. Linear light matches "
            + "exposure more truthfully; sRGB is the usual look-transfer." },
      { key: "strength", label: "Strength", min: 0, max: 1.5, step: 0.01, def: 1.0,
        hint: "How far toward the reference. 1 is all the way; past it overdrives." },
      { key: "skin_protect", label: "Skin protect", min: 0, max: 1, step: 0.01, def: 0.5,
        hint: "Holds skin's hue and caps its saturation near the original's, so a cool "
            + "grade does not turn a face grey. 0 grades everything alike." },
    ] },
  { id: "lut", label: "LUT",
    blurb: "A .cube colour lookup from models/luts, the way grades are shared. "
         + "Trilinear; strength past 1 overdrives the look.",
    controls: [
      { key: "file", label: "File", def: "", choice: [""], dynamic: "luts", step: 1,
        hint: "A .cube file in models/luts. Drop files there and Refresh the list." },
      { key: "strength", label: "Strength", min: 0, max: 2, step: 0.01, def: 1.0,
        hint: "0 is off, 1 is the LUT as cut, 2 pushes its change twice as far." },
      { key: "log", label: "Log", min: 0, max: 1, step: 1, def: 0,
        hint: "For LUTs cut for log footage: a 2.2 gamma in and out around the "
            + "lookup. Off for LUTs made for normal pictures, which is most of them." },
    ] },
  { id: "skin", label: "Skin", cost: "scales with the frame",
    costHint: "The mask is built in Lab and measured over wide windows, so this card "
            + "costs about a fifth of a second on a 1 MP frame and around a second at "
            + "4K. Setting the subject mask to Always adds the auto-mask on top.",
    blurb: "Retouching that lands on skin and nowhere else. The card finds skin by "
         + "colour, keeps eyes, teeth, lips and fine detail out of it, drops busy "
         + "pattern like printed cloth, and cuts to the subject mask as well when the "
         + "chain has one. Every edit dial starts at 0, so switching the card on changes "
         + "nothing until you move one.",
    controls: [
      { key: "subject", label: "Subject mask", def: "auto", step: 1,
        choice: ["off", "auto", "always"],
        labels: { off: "Skin colour only", auto: "Use one if the chain has one",
                  always: "Always make one" },
        hint: "Whether the skin mask is also cut to the subject. Auto uses the mask the "
            + "chain already made for another card, so it costs nothing on its own. "
            + "Always runs the auto-mask for this card, which takes a second or two. "
            + "Skin colour only can catch a wooden floor or a tan wall." },
      { key: "show", label: "Show the mask", def: "off", step: 1,
        choice: ["off", "mask", "over"],
        labels: { off: "No, grade the picture", mask: "The mask in black and white",
                  over: "The mask painted over the picture" },
        hint: "Puts the mask on screen instead of the grade, so you can see what the card "
            + "has selected before you move a dial. Set it back to the first choice before "
            + "the final render. A card showing its mask ignores its own Limit row." },
      { key: "protect", label: "Protect", min: 0, max: 1, step: 0.01, def: 1.0,
        hint: "Holds eyes, teeth, lips and fine detail like lashes and nostrils out of the "
            + "mask. 1 is the full hold." },
      { key: "pattern_reject", label: "Pattern reject", min: 0, max: 1, step: 0.01, def: 0.6,
        hint: "Drops busy areas out of the mask by how much brightness and colour jump "
            + "about locally, so pores stay in and printed fabric, knitwear and hair are "
            + "cut. Raise it if a patterned shirt is being smoothed." },
      { key: "mask_soften", label: "Mask softness", min: 0, max: 12, step: 0.5, def: 3,
        hint: "Blurs the mask by this many pixels so its edge does not speckle." },
      { key: "de_yellow", label: "De-yellow", min: 0, max: 15, step: 0.1, def: 0,
        hint: "Takes yellow out of skin. 2 to 5 is a normal correction for tungsten light "
            + "or a yellow wall bouncing back. Nothing else in the frame moves." },
      { key: "rosy", label: "Rosy", min: 0, max: 12, step: 0.1, def: 0,
        hint: "Puts red back. Use it after de-yellow when skin has gone flat or grey. 1 to "
            + "3 is plenty." },
      { key: "saturation", label: "Skin saturation", min: -1, max: 1, step: 0.01, def: 0,
        hint: "Scales how colourful skin is and nothing else. Negative calms a flushed or "
            + "over-orange render; a small positive brings life back to pale skin." },
      { key: "brighten", label: "Brightness", min: 0, max: 15, step: 0.1, def: 0,
        hint: "Lifts skin. The lift fades out near white, so a forehead or cheekbone "
            + "already close to blown does not clip." },
      { key: "shadow_lift", label: "Shadow lift", min: 0, max: 25, step: 0.1, def: 0,
        hint: "Opens the shaded side of a face without touching the lit side: the lift is "
            + "weighted by how dark the skin already is, squared." },
      { key: "evenness", label: "Evenness", min: 0, max: 1, step: 0.01, def: 0,
        hint: "Pulls skin colour toward its own local average, so blotches, red patches and "
            + "a shadowed jaw even out while brightness and texture stay. 0.3 to 0.6 is "
            + "natural; 1 flattens the colour completely." },
      { key: "smooth", label: "Smoothing", min: 0, max: 1, step: 0.01, def: 0,
        hint: "Softens the brightness of skin. Work with Texture below: smoothing at 1 with "
            + "texture at 0 is the plastic look nobody wants." },
      { key: "texture_preserve", label: "Texture", min: 0, max: 1, step: 0.01, def: 0.55,
        hint: "How much of the fine detail smoothing puts back. 1 keeps every pore, so "
            + "smoothing does nothing; 0 keeps none. Around 0.5 takes out blotches and "
            + "leaves skin reading as skin." },
    ] },
  { id: "clarity", label: "Clarity",
    blurb: "Local contrast: it thickens midtone detail without touching overall "
         + "brightness. This is the punch, not the sharpness.",
    controls: [
      { key: "radius", label: "Radius", min: 1, max: 64, step: 1, def: 3,
        hint: "How broad the detail it works on is. Small stays near edges, large "
            + "shapes the whole image." },
      { key: "offset", label: "Offset", min: 0.1, max: 10, step: 0.01, def: 2.0,
        hint: "Multiplies the radius. Radius times offset is the real reach." },
      { key: "strength", label: "Strength", min: 0, max: 3, step: 0.01, def: 0.4,
        hint: "How hard the recovered detail is pushed back in." },
      { key: "blend_mode", label: "Blend mode", def: "soft light",
        choice: ["soft light", "overlay", "normal", "linear light"],
        hint: "How the detail is composited. Soft light is gentle and the safe "
            + "default; overlay bites harder; linear light is brutal." },
      { key: "blend_if_dark", label: "Blend if dark", min: 0, max: 255, step: 1, def: 50,
        hint: "Tones below this (0 to 255, as in the Photoshop slider) are treated as "
            + "shadows and take the dark intensity." },
      { key: "blend_if_light", label: "Blend if light", min: 0, max: 255, step: 1, def: 205,
        hint: "Tones above this count as highlights and take the light intensity. "
            + "Between the two the effect crossfades." },
      { key: "dark_intensity", label: "Dark intensity", min: 0, max: 2, step: 0.01, def: 0.4,
        hint: "How much clarity the shadows get. This is where clarity usually earns "
            + "its keep." },
      { key: "light_intensity", label: "Light intensity", min: 0, max: 2, step: 0.01, def: 0.0,
        hint: "How much the highlights get. Keep it low or skin and skies go crunchy." },
    ] },
  { id: "sharpen", label: "Sharpen",
    blurb: "True sharpening. Lucy deconvolution reverses a Gaussian blur instead of "
         + "just boosting edge contrast, so one or two passes beat a heavy unsharp. "
         + "Detail band is the guarded option for an AI frame: it lifts the detail "
         + "layer only, soft-clips it so halos cannot grow, and holds back on noise, "
         + "shadows, highlights, hair edges and skin.",
    controls: [
      { key: "mode", label: "Mode", def: "lucy", choice: ["lucy", "unsharp", "band"],
        labels: { lucy: "Lucy deconvolution", unsharp: "Unsharp mask",
                  band: "Detail band (guarded)" },
        hint: "Lucy is Richardson-Lucy deconvolution: it estimates what the image "
            + "looked like before it was blurred. Unsharp is the classic halo-prone "
            + "edge boost, cheaper and blunter. Detail band splits the picture into a "
            + "soft base and a detail layer and lifts only the detail, with guards for "
            + "halos, noise, shadows, highlights, hair edges and skin: the one to reach "
            + "for on an AI frame." },
      { key: "iterations", label: "Iterations", min: 1, max: 20, step: 1, def: 1,
        hint: "Lucy only. Each pass sharpens further and amplifies noise further. "
            + "1 to 3 is the useful range." },
      { key: "kernel_size", label: "Kernel size", min: 1, max: 31, step: 2, def: 3,
        hint: "Lucy only. How wide the blur it assumes was. Match it to the softness "
            + "you are fighting." },
      { key: "amount", label: "Amount", min: 0, max: 3, step: 0.01, def: 0.5,
        hint: "Unsharp and detail band. How hard the detail is pushed back in. On the "
            + "detail band the ceiling tightens as this rises, so a big number bites "
            + "without haloing." },
      { key: "radius", label: "Radius", min: 0.1, max: 10, step: 0.1, def: 1.0,
        hint: "Unsharp and detail band. How far from an edge the effect reaches: on "
            + "unsharp that is the halo's width, on the detail band how coarse the "
            + "detail layer is. 1 to 3 pixels is the useful range." },
      { key: "edge_preserve", label: "Edge preserve", min: 0.001, max: 0.2, step: 0.001,
        def: 0.02,
        hint: "Detail band only. How closely the soft base follows edges before the "
            + "detail is taken off it. Low follows them hard, which keeps halos off hair "
            + "and lashes; high behaves more like a plain blur and bites harder." },
      { key: "noise_gate", label: "Noise gate", min: 0, max: 0.5, step: 0.005, def: 0.055,
        hint: "Detail band only. Detail finer than this is left alone, so the grain an AI "
            + "paints onto skin is not turned into black speckles." },
      { key: "shadow_protect", label: "Shadow protect", min: 0, max: 1, step: 0.01, def: 0.35,
        hint: "Detail band only. How much sharpening is held back in the darkest tones, "
            + "where noise lives and detail does not." },
      { key: "highlight_protect", label: "Highlight protect", min: 0, max: 1, step: 0.01,
        def: 0.5,
        hint: "Detail band only. How much is held back near white, so skin speculars and "
            + "skies do not gain a hard rim." },
      { key: "fringe_hold", label: "Fringe hold", min: 0, max: 1, step: 0.01, def: 0.5,
        hint: "Detail band only. Where brightness already jumps a long way, hair against "
            + "a bright background for instance, the sharpening eases off so the edge "
            + "does not gain a white outline." },
      { key: "skin_protect", label: "Skin protect", min: 0, max: 1, step: 0.01, def: 0,
        hint: "Detail band only. Holds sharpening back on skin-coloured areas so pores do "
            + "not turn gritty. 0.5 to 0.7 is a portrait setting." },
    ] },
  // NOT an effect: the settings for the depth map the two depth effects share.
  // Drawn as a card so it lives beside them, with no switch of its own.
  { id: "depth", label: "Depth", settings: true, cost: "depth model",
    blurb: "Depth of field and haze need to know what is near and what is far. The "
         + "node works that out itself with the estimator chosen here; nothing to "
         + "wire. The depth input on the node is only for a map of your own.",
    controls: [
      { key: "estimator", label: "Estimator", choice: ["auto", "depth_anything_v2",
                                                       "depth_anything", "midas", "zoe"],
        labels: { auto: "Auto (first installed)", depth_anything_v2: "Depth Anything V2",
                  depth_anything: "Depth Anything", midas: "MiDaS", zoe: "ZoeDepth" },
        step: 1, def: "auto",
        hint: "Which depth estimator makes the map. All four come with "
            + "comfyui_controlnet_aux. Auto takes the first one installed, Depth "
            + "Anything V2 first; one that is not installed falls back to that "
            + "with a console line." },
      { key: "model", label: "Model", choice: ["auto", "vitl", "vitb", "vits", "vitg"],
        labels: { auto: "Auto (the estimator's default)", vitl: "Large (vitl)",
                  vitb: "Base (vitb)", vits: "Small (vits)", vitg: "Giant (vitg)" },
        step: 1, def: "auto",
        hint: "The Depth Anything V2 checkpoint. Large is its default and the usual "
            + "choice; Small is quick and coarse; Giant is the best map and the "
            + "slowest download. Other estimators ignore this." },
      { key: "resolution", label: "Resolution", min: 256, max: 2048, step: 64, def: 512,
        hint: "The size the estimator works at, long edge. 512 is quick and enough for "
            + "a soft blur or haze; 1024 keeps edges cleaner on a big frame at the "
            + "cost of seconds." },
    ] },
  // NOT an effect either: where the subject mask comes from when a card is
  // limited to the subject or the background, and how soft its edge is.
  { id: "mask", label: "Mask", settings: true,
    blurb: "Any card can be limited to the subject or the background with the Limit "
         + "row at its foot. This is where the mask comes from: the pack's own "
         + "auto-mask, the same one the Paint tab uses, or a mask wired into the "
         + "standalone node.",
    controls: [
      { key: "source", label: "Source", choice: ["auto", "wired"],
        labels: { auto: "Auto (the pack's mask)", wired: "The mask input" },
        step: 1, def: "auto",
        hint: "Auto runs the installed segmenter on the frame once per queue. Wired "
            + "is the standalone node's mask input; the Workspace node has no input "
            + "and always uses auto." },
      { key: "feather", label: "Feather", min: 0, max: 64, step: 1, def: 12,
        hint: "How soft the mask's edge is, in pixels, so a limited card does not "
            + "cut a hard line round the subject." },
    ] },
  { id: "relight", label: "Relight", depth: true, cost: "depth model",
    blurb: "A new key light over the picture's relief. The depth map says which way "
         + "every surface faces, so the side towards the light keeps its brightness "
         + "and the side away falls to ambient, with contact shadows where higher "
         + "ground blocks the light. Distances are worked out for you.",
    controls: [
      { key: "azimuth", label: "From", min: 0, max: 360, step: 5, def: 45,
        hint: "Where the light comes from, around the frame: 0 is the right edge, 90 "
            + "the top, 180 the left, 270 below." },
      { key: "elevation", label: "Height", min: 5, max: 85, step: 5, def: 35,
        hint: "How high the light sits. Low is grazing and dramatic, with long "
            + "shadows; high is flat and even." },
      { key: "intensity", label: "Strength", min: 0, max: 1, step: 0.01, def: 0.6,
        hint: "How much of the new light shows. 0 is off; 1 is the full relight." },
      { key: "ambient", label: "Ambient", min: 0, max: 1, step: 0.01, def: 0.6,
        hint: "What the side facing away keeps. Low is a hard single light; high "
            + "is a soft fill." },
      { key: "warmth", label: "Warmth", min: -1, max: 1, step: 0.05, def: 0,
        hint: "The light's own colour: positive warm, negative cool. The shadows "
            + "keep the picture's colour." },
      { key: "shadow", label: "Contact shadow", min: 0, max: 1, step: 0.01, def: 0.4,
        hint: "Shadows cast by higher ground onto lower: under a chin, behind a "
            + "shoulder. 0 turns them off." },
      { key: "softness", label: "Softness", min: 0, max: 1, step: 0.01, def: 0.5,
        hint: "Smooths the relief before lighting it. Low picks up pores and "
            + "noise; high lights only the big shapes." },
      { key: "relief", label: "Relief", min: 0, max: 3, step: 0.05, def: 1.0,
        hint: "How steep the terrain reads. Higher makes every surface lean "
            + "further into or away from the light." },
      { key: "flip_depth", label: "Flip depth", min: 0, max: 1, step: 1, def: 0,
        hint: "Depth estimators disagree about which end is near. If the light "
            + "lands on the wrong side of things, set this to 1." },
    ] },
  { id: "haze", label: "Atmospheric haze", depth: true, cost: "depth model",
    blurb: "Distance washes out towards the air's own colour and loses contrast. "
         + "This is most of what makes a background read as far away, and it is "
         + "the thing AI renders least. Distances are worked out for you.",
    controls: [
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, def: 0.35,
        hint: "How much the far distance fades. Small values read as clean air, "
            + "large as fog." },
      { key: "start", label: "Start distance", min: 0, max: 1, step: 0.01, def: 0.45,
        hint: "How far away the haze begins. Everything nearer stays untouched." },
      { key: "lift", label: "Lift", min: -0.3, max: 0.5, step: 0.01, def: 0.12,
        hint: "How bright the haze is relative to the scene. Positive is daylight "
            + "mist, negative is a dark, smoky distance." },
      { key: "flip_depth", label: "Flip depth", min: 0, max: 1, step: 1, def: 0,
        hint: "Set to 1 if the foreground hazes instead of the background." },
    ] },
  { id: "distortion", label: "Lens distortion",
    clears: { card: "distortion", key: "lens", to: "custom" },
    blurb: "Real glass never maps the world to a perfect rectangle. A little barrel "
         + "reads as a wide lens, a little pincushion as a long one. The frame is "
         + "resampled, so no black corners appear. Pick a lens to fill these dials and "
         + "the fringing on the Chromatic aberration card in one go.",
    controls: [
      { key: "lens", label: "Lens", def: "custom", step: 1, fills: "lens",
        choice: ["custom", "ultrawide_14", "wide_24", "reportage_35", "normal_50",
                 "portrait_85", "long_135", "vintage_55", "anamorphic_40",
                 "phone_main", "phone_ultrawide"],
        labels: { custom: "Custom (your own dials)", ultrawide_14: "14 mm ultra wide",
                  wide_24: "24 mm wide", reportage_35: "35 mm reportage",
                  normal_50: "50 mm normal", portrait_85: "85 mm portrait",
                  long_135: "135 mm long", vintage_55: "55 mm vintage",
                  anamorphic_40: "40 mm anamorphic", phone_main: "Phone, main camera",
                  phone_ultrawide: "Phone, ultra wide" },
        hint: "Fills this card's dials and the Chromatic aberration card's with the way "
            + "that kind of glass bends and splits light: barrel on the wide lenses, a "
            + "touch of pincushion on the long ones, soft corners on the cheap and the "
            + "old ones. Picking one switches both cards on. Every dial stays yours "
            + "afterwards, and moving one puts this back to Custom. The amounts are "
            + "sized to the frame, so a lens looks the same at any resolution. These are "
            + "characterful values for that kind of glass, not measured profiles." },
      { key: "scale_by_size", label: "Scale to the frame", min: 0, max: 1, step: 1, def: 0,
        hint: "Sizes the edge softness against the frame's short edge, with 1024 as the "
            + "reference, so a picture twice as big gets twice the softness in pixels "
            + "and the same look. 0 keeps it in fixed pixels. Picking a lens sets it to 1." },
      { key: "amount", label: "Amount", min: -0.5, max: 0.5, step: 0.005, def: 0.0,
        hint: "Positive is barrel (bulges out, wide-angle). Negative is pincushion "
            + "(pinches in, telephoto). 0 is off. Small values, 0.02 to 0.08, sell "
            + "it without anyone noticing." },
      { key: "edge_softness", label: "Edge softness", min: 0, max: 1, step: 0.01, def: 0.0,
        hint: "Blurs towards the corners the way cheap glass loses resolution "
            + "off-axis. The centre stays sharp." },
    ] },
  { id: "dof", label: "Depth of field", depth: true, cost: "depth model",
    blurb: "Blurs by distance, so the focal plane stays sharp and everything either "
         + "side of it falls away. The Post node works out the distances itself; "
         + "nothing to wire.",
    controls: [
      { key: "focus", label: "Focus distance", min: 0, max: 1, step: 0.01, def: 0.35,
        hint: "Where the sharp plane sits in the depth map. 0 is the nearest thing "
            + "in frame, 1 the furthest." },
      { key: "range", label: "Focus range", min: 0.01, max: 1, step: 0.01, def: 0.15,
        hint: "How deep the sharp zone is. Narrow is a fast portrait lens, wide is "
            + "a landscape stopped down." },
      { key: "blur", label: "Blur", min: 0.3, max: 30, step: 0.1, def: 6.0,
        hint: "How soft the out-of-focus areas go at their worst." },
      { key: "flip_depth", label: "Flip depth", min: 0, max: 1, step: 1, def: 0,
        hint: "Depth estimators disagree about which end is near. If the wrong half "
            + "of the image blurs, set this to 1." },
    ] },
  { id: "aberration", label: "Chromatic aberration",
    clears: { card: "distortion", key: "lens", to: "custom" },
    blurb: "Splits the colour channels apart like cheap glass. One amount dial rides "
         + "all three offsets, so you can dial the whole effect without losing its "
         + "character.",
    controls: [
      { key: "amount", label: "Amount", min: 0, max: 3, step: 0.01, def: 0.47,
        hint: "Master scale on the three shifts below. 0 switches the effect off "
            + "without disturbing the offsets." },
      { key: "red_shift", label: "Red shift", min: -20, max: 20, step: 0.5, def: 1,
        hint: "Pixels to move the red channel. Opposite signs on red and blue give "
            + "the familiar cyan and orange fringing." },
      { key: "green_shift", label: "Green shift", min: -20, max: 20, step: 0.5, def: -1,
        hint: "Pixels to move the green channel. Leave near 0 to keep luminance put." },
      { key: "blue_shift", label: "Blue shift", min: -20, max: 20, step: 0.5, def: -3,
        hint: "Pixels to move the blue channel." },
      { key: "direction", label: "Direction", def: "horizontal",
        choice: ["horizontal", "vertical", "radial"],
        hint: "Horizontal and vertical are the flat, stylised split. Radial pushes "
            + "the channels apart from the centre outwards, which is what a real "
            + "lens does: clean in the middle, fringing at the corners." },
      { key: "scale_by_size", label: "Scale to the frame", min: 0, max: 1, step: 1, def: 0,
        hint: "Sizes the three shifts against the frame's short edge, with 1024 as the "
            + "reference, so the same settings fringe by the same amount at any "
            + "resolution. Radial is already a share of the frame and ignores this. 0 "
            + "keeps the shifts in fixed pixels. Picking a lens sets it to 1." },
    ] },
  { id: "bloom", label: "Bloom",
    blurb: "Bright areas bleed light into their surroundings, the way a real lens "
         + "does. Sits after sharpening so the glow stays smooth.",
    controls: [
      { key: "intensity", label: "Intensity", min: 0, max: 5, step: 0.01, def: 1.16,
        hint: "How strong the glow comes back over the image." },
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, def: 0.62,
        hint: "How bright a pixel must be to glow at all. Lower makes the whole "
            + "image hazy." },
      { key: "smoothing", label: "Smoothing", min: 0.01, max: 1, step: 0.01, def: 0.23,
        hint: "The soft knee on that threshold: how gradually a pixel starts glowing, "
            + "so lit edges ramp up instead of switching on." },
      { key: "radius_multiplier", label: "Radius multiplier", min: 0.1, max: 5,
        step: 0.01, def: 1.0,
        hint: "How far the light spreads. Large values are a soft-focus dream look." },
      { key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01, def: 0.77,
        hint: "How coloured the glow is. Under 1 keeps it closer to white light." },
      { key: "exposure", label: "Exposure", min: 0.1, max: 4, step: 0.01, def: 1.0,
        hint: "Scales the image feeding the glow, so you can push more of it over "
            + "the threshold without moving the threshold." },
    ] },
  { id: "light_wrap", label: "Light wrap",
    blurb: "Bright areas bleed onto the darker pixels beside them. Unlike bloom it "
         + "only lands where bright meets dark, which is what softens the hard "
         + "edge that makes a subject look pasted onto its background.",
    controls: [
      { key: "strength", label: "Strength", min: 0, max: 2, step: 0.01, def: 0.4,
        hint: "How far the light creeps over the edge." },
      { key: "radius", label: "Radius", min: 0.1, max: 10, step: 0.1, def: 2.5,
        hint: "How wide the wrap is. Keep it tight or it turns into bloom." },
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, def: 0.7,
        hint: "How bright an area must be before it wraps." },
    ] },
  { id: "diffusion", label: "Diffusion (pro-mist)",
    blurb: "A soft veil over the whole frame, not just the highlights. Detail "
         + "stays but everything gains a gentle halo and slightly milky blacks. "
         + "The filter cinematographers reach for to take the digital edge off.",
    controls: [
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, def: 0.25,
        hint: "How heavy the veil is. Past 0.4 it reads as a dream sequence." },
      { key: "radius", label: "Radius", min: 0.5, max: 20, step: 0.1, def: 4.0,
        hint: "How far the veil spreads from each point." },
      { key: "black_lift", label: "Black lift", min: 0, max: 0.2, step: 0.005, def: 0.03,
        hint: "How much the blacks lift. A real mist filter always lifts them a "
            + "little; that is what stops the image looking digitally clean." },
    ] },
  { id: "vignette", label: "Vignette",
    blurb: "Darkens towards the corners to pull the eye inward. Two falloff laws, a "
         + "shape that runs from the frame's own oval to a true circle, and a colour "
         + "that lands in the darkened band and nowhere else.",
    controls: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, def: 0.10,
        hint: "How dark the corners go. Small values read as a lens, large as a mood." },
      { key: "feather", label: "Feather", min: 0.05, max: 1, step: 0.01, def: 0.6,
        hint: "How gradually it falls off. Low is a hard circle, high is a soft, "
            + "barely-there fade." },
      { key: "law", label: "Falloff", def: "smooth", step: 1, choice: ["smooth", "cos4"],
        labels: { smooth: "Smooth band (the shipped look)",
                  cos4: "Natural (cosine to the fourth)" },
        hint: "How the light falls away. Smooth band holds the centre flat and fades in "
            + "a ring near the edge, which is the graphic look. Natural is what glass "
            + "actually does: the light drops from the middle outward, so there is no "
            + "ring at all, just a gentle bowl. Both reach the same darkness in the "
            + "corners, so Amount means one thing either way." },
      { key: "roundness", label: "Roundness", min: 0, max: 1, step: 0.01, def: 0,
        hint: "0 follows the frame's own shape, so a wide picture gets an oval and every "
            + "edge darkens alike. 1 is a true circle, which on a wide picture darkens "
            + "the left and right more than the top and bottom. On a square picture it "
            + "does nothing." },
      { key: "tint_hue", label: "Ring colour", min: 0, max: 359, step: 1, def: 30,
        hint: "The colour the darkened band takes, as a hue: 0 red, 30 amber, 60 yellow, "
            + "120 green, 210 blue, 300 magenta. It does nothing until the strength "
            + "below is above 0." },
      { key: "tint_amount", label: "Ring colour strength", min: 0, max: 1, step: 0.01,
        def: 0,
        hint: "How much of that colour lands in the falloff, and only there: the centre "
            + "is never tinted. It rides as a filter, so raising it does not make the "
            + "corners any darker. 0.15 to 0.35 with an amber hue reads as warm old "
            + "glass; a blue at the same strength reads as cold and modern." },
    ] },
  { id: "halation", label: "Halation",
    blurb: "The warm bleed film gets around bright edges. Light passes through the "
         + "emulsion, bounces off the back of the base and scatters into the "
         + "red-sensitive layer, which is why it is warm, wide and soft. Bloom "
         + "brightens; halation stains.",
    controls: [
      { key: "strength", label: "Strength", min: 0, max: 2, step: 0.01, def: 0.35,
        hint: "How much of the warm bleed is added back. Subtle is the whole point." },
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, def: 0.75,
        hint: "How bright an area must be to halate. Higher keeps it to real "
            + "highlights: windows, skin speculars, practical lights." },
      { key: "radius", label: "Radius", min: 0.1, max: 10, step: 0.1, def: 3.0,
        hint: "How far the bleed spreads. Wider than bloom by nature." },
      { key: "warmth", label: "Warmth", min: 0, max: 1, step: 0.01, def: 0.7,
        hint: "How red the bleed is. 0 is a neutral white glow, 1 is full orange-red, "
            + "the classic look on backlit hair and window frames." },
    ] },
  { id: "film", label: "Film stock",
    blurb: "A named stock's own response: how it turns light into density. Shadows "
         + "and highlights flatten at the two ends of its curve, it sits on a little "
         + "base fog, and it has its own saturation and its own colour in the shadows "
         + "and the highlights. Grain is its own card; the two together are the whole "
         + "emulsion. These are readings of each stock's character, not measured "
         + "profiles.",
    controls: [
      { key: "stock", label: "Stock", def: "none", step: 1,
        choice: ["none", "portra400", "ektar100", "gold200", "fuji400h", "superia400",
                 "ektachrome100", "cinestill800t", "instant600", "trix400", "hp5",
                 "acros100"],
        labels: { none: "(none)", portra400: "Portra 400", ektar100: "Ektar 100",
                  gold200: "Gold 200", fuji400h: "Fuji Pro 400H",
                  superia400: "Superia 400", ektachrome100: "Ektachrome 100 (slide)",
                  cinestill800t: "Cinestill 800T", instant600: "Instant film",
                  trix400: "Tri-X 400 (black and white)",
                  hp5: "HP5 Plus 400 (black and white)",
                  acros100: "Acros 100 (black and white)" },
        hint: "Which stock. Portra 400 is soft, warm and forgiving, the portrait answer. "
            + "Ektar 100 is contrasty, fine and saturated, for landscape and colour. Gold "
            + "200 is the warm, yellow consumer film of holiday snaps. Fuji Pro 400H runs "
            + "cool and pastel. Superia 400 carries green in the shadows. Ektachrome is "
            + "slide film: deep blacks, clean colour, steep contrast. Cinestill 800T is a "
            + "tungsten cinema stock, so daylight goes blue and night lights come out "
            + "right. Instant film is the milky, low contrast print with cyan shadows and "
            + "warm highlights. Tri-X is the gritty black and white, HP5 the gentler one, "
            + "Acros the fine, smooth one. (none) leaves the picture as it is." },
      { key: "wratten", label: "Filter", def: "none", step: 1,
        choice: ["none", "yellow8", "orange16", "red25", "green11"],
        labels: { none: "(none)", yellow8: "Yellow 8", orange16: "Orange 16",
                  red25: "Red 25", green11: "Green 11" },
        hint: "Black and white stocks only: the glass filter on the front of the lens. "
            + "Yellow 8 darkens a blue sky a little. Orange 16 goes further and smooths "
            + "skin. Red 25 is the dramatic one: near-black sky, white clouds. Green 11 "
            + "lifts foliage and darkens skin. The picture's brightness is held steady "
            + "whichever you pick." },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, def: 1.0,
        hint: "How far toward the stock. 1 is the stock as it is; half way is a hint of "
            + "it over the picture you already had." },
      { key: "fade", label: "Fade", min: 0, max: 1, step: 0.01, def: 0.0,
        hint: "Raises the base fog, the expired-film look: the blacks go milky while "
            + "everything brighter barely moves. 0 is fresh film." },
    ] },
  { id: "rolloff", label: "Highlight roll-off",
    blurb: "A soft shoulder near white so highlights compress instead of clipping "
         + "to a flat blob. Sensors clip abruptly, film shoulders off; this is the "
         + "difference on skin speculars and skies.",
    controls: [
      { key: "knee", label: "Knee", min: 0, max: 0.99, step: 0.01, def: 0.75,
        hint: "Where the shoulder starts. Everything below is untouched." },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01, def: 0.6,
        hint: "How hard the top end is compressed into the space that remains." },
    ] },
  { id: "grain", label: "Grain",
    blurb: "Film grain, generated at a size rather than per pixel, and weighted "
         + "towards the midtones the way real emulsion behaves.",
    controls: [
      { key: "power", label: "Power", min: 0, max: 1, step: 0.001, def: 0.09,
        hint: "How visible the grain is. Past about 0.2 it stops reading as film." },
      { key: "scale", label: "Scale", min: 0.1, max: 8, step: 0.1, def: 1.0,
        hint: "Grain size. 1 is one pixel per grain; larger makes coarser, chunkier "
            + "grain that survives being downscaled." },
      { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, def: 1.0,
        hint: "0 is monochrome grain, which usually looks more like film. 1 is full "
            + "colour speckle." },
      { key: "seed", label: "Seed", min: 0, max: 2147483647, step: 1, def: 0,
        hint: "Same seed, same grain. Change it if a pattern lands somewhere "
            + "distracting." },
      { key: "softness", label: "Softness", min: 0, max: 1, step: 0.01, def: 0.0,
        hint: "Rounds each grain off so it reads as silver rather than digital speckle. "
            + "The grain stays as visible; only its edge softens. 0.5 to 0.8 is the "
            + "scanned film look." },
    ] },
];

// The tier ceilings, mirrored from VRAM_CAPS in workspace.py.

export const VRAM_CAPS = {
  low: { reference_fidelity: 2.5, scene_fidelity: 1.5, likeness_vs_obedience: 768,
         subject_likeness_px: 1024, style_detail_px: 384 },
  medium: { reference_fidelity: 6, scene_fidelity: 4, likeness_vs_obedience: 1536,
            subject_likeness_px: 2048, style_detail_px: 768 },
  high: {},
};

// The Mask size slider's track shares. A LINEAR 512..4096 slider was honest and
// unusable at once: the 1280..1536 band a hand actually works in was 7 percent of
// the travel, and everything above 2048 was 57, so the red end dominated a row
// whose useful drags were a sliver. The slider input therefore runs in POSITIONS,
// 0..MASK_POS_MAX, and these stops convert between position and value so each
// band owns a chosen share of the track. The zone bar's grid columns must equal
// the position shares EXACTLY, or the handle sits over one colour while the bar
// claims another; MASK_ZONE_FR exists so the two cannot be edited apart.
export const MASK_POS_MAX = 1000;
export const MASK_STOPS = [
  [512, 0],       // 40% of the track: the everyday half of the range
  [1280, 400],
  [1536, 600],    // 20%: the band that was an undraggable 7
  [2048, 850],    // 25%
  [4096, 1000],   // 15%: above 2048 is a deliberate reach, not the default drag
];
export const MASK_ZONE_FR = "40fr 20fr 25fr 15fr";

/** Slider position (0..MASK_POS_MAX) for a mask size value. */
export function maskPosOf(value) {
  const v = Math.max(MASK_STOPS[0][0], Math.min(MASK_STOPS.at(-1)[0], Number(value) || 0));
  for (let i = 1; i < MASK_STOPS.length; i++) {
    const [v1, p1] = MASK_STOPS[i];
    if (v <= v1) {
      const [v0, p0] = MASK_STOPS[i - 1];
      return p0 + ((v - v0) / (v1 - v0)) * (p1 - p0);
    }
  }
  return MASK_POS_MAX;
}

/** Mask size value for a slider position: the exact inverse of maskPosOf. */
export function maskValueOf(pos) {
  const p = Math.max(0, Math.min(MASK_POS_MAX, Number(pos) || 0));
  for (let i = 1; i < MASK_STOPS.length; i++) {
    const [v1, p1] = MASK_STOPS[i];
    if (p <= p1) {
      const [v0, p0] = MASK_STOPS[i - 1];
      return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0);
    }
  }
  return MASK_STOPS.at(-1)[0];
}

// Mirrored from WHOLE_FRAME_CAPS in paint_render.py. A resample costs no VRAM by
// itself; the cap protects what comes NEXT, which is painting and rendering on the
// bigger canvas, and that was your explicit call.
export const WHOLE_FRAME_CAPS = { low: 1280, medium: 2048, high: 4096 };

export function wholeFrameLimit(tier) {
  // read from the table, not written out again, for the same reason the Python
  // twin does: a hardcoded fallback goes stale the moment the high tier moves
  return WHOLE_FRAME_CAPS[String(tier || "high").toLowerCase()] ?? WHOLE_FRAME_CAPS.high;
}

/** The resize button's target for a w x h source at a mask size, on a VRAM tier.
 *
 *  Mirrors the WHOLE-FRAME rule in paint_render.py, `_fit` plus the never-downscale
 *  target logic, NOT `_fit_region`'s pixel budget: whole frame scales by the LONG
 *  EDGE, and the button must mean exactly what a Whole frame render means by the
 *  same number, or the picture changes size twice between the two. Sides round to
 *  /8 the way `_fit` rounds. `noop` is true when the picture already meets or beats
 *  the reachable size; `capped` says the tier, not the dial, decided the number.
 */
export function resampleTarget(w, h, size, tier) {
  const W = Math.max(1, Math.round(Number(w) || 0));
  const H = Math.max(1, Math.round(Number(h) || 0));
  const cap = wholeFrameLimit(tier);
  const asked = Math.max(0, Math.round(Number(size) || 0));
  const want = Math.min(asked, cap);
  const long = Math.max(W, H);
  if (want <= long) return { w: W, h: H, scale: 1, capped: asked > cap, noop: true };
  const scale = want / long;
  // Python's round() is half-to-even and Math.round is half-up, and _fit is the
  // authority here: on a source whose side hits an exact .5 (a 1010px side doubled,
  // say) the two would land 8px apart, and then the button and a Whole frame render
  // of the same picture disagree about its size, which is the one thing this
  // function exists to prevent.
  const round8even = (x) => {
    const q = x / 8;
    const f = Math.floor(q);
    const d = q - f;
    const n = d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
    return Math.max(64, n * 8);
  };
  return {
    w: round8even(W * scale),
    h: round8even(H * scale),
    scale, capped: asked > cap, noop: false,
  };
}

// The five aspects the Automatic mask shape can pick, with the words the panel
// shows. Ratio AND word, because the buttons only cover three of the five: saying
// just "wide" would hide the difference between 4:3 and 16:9, which is large.
export const REGION_BUCKET_LABELS = [
  [9 / 16, "9:16 tall"], [3 / 4, "3:4 tall"], [1, "1:1 square"],
  [4 / 3, "4:3 wide"], [16 / 9, "16:9 wide"],
];

/** The label Automatic would pick for a painted box, by the server's own rule.
 *
 *  Mirrors `_bbox` and `region_aspect` in paint_render.py: pad each side by 0.25 of
 *  the box, THEN clamp to the frame, then take the nearest bucket in log space. The
 *  clamp is not optional decoration: near an edge it changes the aspect, and a
 *  readout computed from the raw paint would disagree with what actually renders
 *  exactly where people paint most, against a subject at the frame's edge.
 *  `box` is {x0,y0,x1,y1} in image pixels, x1/y1 exclusive; w/h the full frame.
 */
export function autoShapeLabel(box, w, h) {
  if (!box || !(box.x1 > box.x0) || !(box.y1 > box.y0)) return "";
  const px = Math.trunc((box.x1 - box.x0) * 0.25);
  const py = Math.trunc((box.y1 - box.y0) * 0.25);
  const x0 = Math.max(0, box.x0 - px), x1 = Math.min(w, box.x1 + px);
  const y0 = Math.max(0, box.y0 - py), y1 = Math.min(h, box.y1 + py);
  const a = (x1 - x0) / Math.max(1, y1 - y0);
  let best = REGION_BUCKET_LABELS[0];
  for (const cand of REGION_BUCKET_LABELS) {
    if (Math.abs(Math.log(a / cand[0])) < Math.abs(Math.log(a / best[0]))) best = cand;
  }
  return best[1];
}

// Slider values snap to their step and carry only the decimals that step implies.
// Without this a drag lands on 0.30000000000000004 and an integer control shows ".0".
export function snapStep(v, min, max, step) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  const s = Math.abs(Number(step)) || 0.01;
  const snapped = Math.round((n - min) / s) * s + min;
  const dec = (String(s).split(".")[1] || "").length;
  return parseFloat(Math.max(min, Math.min(max, snapped)).toFixed(dec));
}

// The named lenses the Lens distortion card's picker fills in, for a 1024 px short
// edge (both cards size them to the frame). Characterful values for that kind of
// glass, not measured profiles of any one lens.
export const LENS_PRESETS = {
  ultrawide_14: { amount: 0.115, edge_softness: 0.22, ca_amount: 0.90,
                  red_shift: 1.5, green_shift: 0, blue_shift: -2.5, direction: "radial" },
  wide_24: { amount: 0.06, edge_softness: 0.12, ca_amount: 0.55,
             red_shift: 1, green_shift: -0.5, blue_shift: -2, direction: "radial" },
  reportage_35: { amount: 0.028, edge_softness: 0.08, ca_amount: 0.4,
                  red_shift: 0.8, green_shift: 0, blue_shift: -1.4, direction: "radial" },
  normal_50: { amount: 0.008, edge_softness: 0.04, ca_amount: 0.22,
               red_shift: 0.5, green_shift: 0, blue_shift: -1, direction: "radial" },
  portrait_85: { amount: -0.012, edge_softness: 0.03, ca_amount: 0.18,
                 red_shift: 0.4, green_shift: 0, blue_shift: -0.8, direction: "radial" },
  long_135: { amount: -0.03, edge_softness: 0.02, ca_amount: 0.15,
              red_shift: 0.3, green_shift: 0, blue_shift: -0.7, direction: "radial" },
  vintage_55: { amount: 0.02, edge_softness: 0.35, ca_amount: 0.8,
                red_shift: 1.2, green_shift: -0.4, blue_shift: -2.2, direction: "radial" },
  anamorphic_40: { amount: 0.05, edge_softness: 0.18, ca_amount: 0.7,
                   red_shift: 1.6, green_shift: 0, blue_shift: -1.6, direction: "horizontal" },
  phone_main: { amount: 0.075, edge_softness: 0.10, ca_amount: 0.35,
                red_shift: 0.6, green_shift: 0, blue_shift: -1.2, direction: "radial" },
  phone_ultrawide: { amount: 0.16, edge_softness: 0.30, ca_amount: 0.9,
                     red_shift: 1.4, green_shift: -0.3, blue_shift: -2.6, direction: "radial" },
};
