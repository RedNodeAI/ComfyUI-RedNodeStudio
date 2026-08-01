// The Workspace's tables and pure helpers.
//
// Everything in here is DATA or a pure function: no node, no DOM, no config. It
// lives apart from rednode_workspace.js because that file had grown past 4000
// lines carrying eleven tabs, and a block edit in it twice took neighbouring code
// with it. Splitting the parts that cannot misbehave is the cheap half of fixing
// that, and it costs nothing at runtime: same values, same functions, imported.

// Which tabs exist, in the order they are shown.

export const TAB_ORDER = [
  { id: "latent", label: "Latent", group: "canvas" },
  { id: "i2i", label: "Img2Img", group: "canvas" },
  { id: "loras", label: "LoRAs", group: "model" },
  { id: "paint", label: "Paint", group: "canvas" },
  { id: "moodboard", label: "Moodboard", group: "mood" },
  { id: "subject", label: "Subject", group: "edit" },
  { id: "people", label: "People", group: "edit" },
  { id: "scene", label: "Scene", group: "edit" },
  { id: "masks", label: "Masks", group: "edit" },
  { id: "post", label: "Post", group: "post" },
  { id: "advanced", label: "Advanced", group: "cfg" },
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
    hint: "How much of the style refs survives. This drives the studio's own style_strength "
        + "widget through the bundle and works with ANY preset, named ones included." },
  { tab: "moodboard", key: "transfer", choice: ["style", "subject"], def: "style",
    label: "Transfer",
    hint: "What the engine pulls OUT of the images on this tab. It reads the moodboard "
        + "references only; Subject, People, Scene and Masks are untouched. Style takes "
        + "the look (palette, lighting, texture, mood) and leaves the content behind, so "
        + "the prompt decides what is in the picture. Subject takes the content instead "
        + "(composition, objects, what is happening) and lets the prompt decide the look. "
        + "Style is right for a mood board; subject suits copying an arrangement or a "
        + "garment out of a reference photo." },
  { tab: "moodboard", key: "reference_processing", label: "Reference processing",
    def: "full image", choice: ["full image", "quadrant crops (2x2)", "fine tiles (4x4)"],
    hint: "How the images on this tab are cut up before encoding. Crops and tiles "
        + "scramble their composition so only the look survives, which is the fix when "
        + "a moodboard reference keeps smuggling its own subject or layout into the "
        + "result. Full image keeps them whole." },
  { tab: "moodboard", key: "style_detail_px", label: "Style detail res", min: 128, max: 1536, step: 64, def: 384, vram: "med",
    hint: "Vision budget per moodboard ref. Higher resolves fabric and pattern detail, "
        + "and feeds more vision tokens to the encoder." },
  { tab: "moodboard", key: "hide_style_refs", bool: true, def: true, label: "Hide style refs",
    hint: "On (indirect): refs are deleted after encoding and style survives via the prompt, "
        + "safest with people in the refs. OFF keeps the vision tokens in the conditioning: "
        + "a much STRONGER style signal. Try off when the moodboard feels weak." },
  { tab: "moodboard", key: "style_directive", bool: true, def: true, label: "Style directive",
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
    ] },
  { id: "color", label: "Colour",
    blurb: "Brightness, contrast and saturation. 1.00 on all three is untouched.",
    controls: [
      { key: "brightness", label: "Brightness", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "A straight gain on every channel. 1.00 changes nothing." },
      { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "Pivots around mid grey, so highlights and shadows spread apart while "
            + "the midpoint stays put." },
      { key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01, def: 1.0,
        hint: "0 is black and white, 1 is untouched, above 1 pushes the colour." },
      { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "White balance trim. Positive warms (more red, less blue), negative "
            + "cools. 0 leaves the balance alone." },
      { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01, def: 0.0,
        hint: "The other white balance axis: positive pushes green, negative magenta." },
      { key: "black_point", label: "Black point", min: -0.5, max: 0.5, step: 0.01, def: 0.0,
        hint: "Positive crushes the blacks for contrast. Negative lifts them into the "
            + "faded, milky film look." },
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
         + "just boosting edge contrast, so one or two passes beat a heavy unsharp.",
    controls: [
      { key: "mode", label: "Mode", def: "lucy", choice: ["lucy", "unsharp"],
        hint: "Lucy is Richardson-Lucy deconvolution: it estimates what the image "
            + "looked like before it was blurred. Unsharp is the classic halo-prone "
            + "edge boost, cheaper and blunter." },
      { key: "iterations", label: "Iterations", min: 1, max: 20, step: 1, def: 1,
        hint: "Lucy only. Each pass sharpens further and amplifies noise further. "
            + "1 to 3 is the useful range." },
      { key: "kernel_size", label: "Kernel size", min: 1, max: 31, step: 2, def: 3,
        hint: "Lucy only. How wide the blur it assumes was. Match it to the softness "
            + "you are fighting." },
      { key: "amount", label: "Amount", min: 0, max: 3, step: 0.01, def: 0.5,
        hint: "Unsharp only. How much edge contrast to add." },
      { key: "radius", label: "Radius", min: 0.1, max: 10, step: 0.1, def: 1.0,
        hint: "Unsharp only. How far from an edge the halo reaches." },
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
    blurb: "Real glass never maps the world to a perfect rectangle. A little barrel "
         + "reads as a wide lens, a little pincushion as a long one. The frame is "
         + "resampled, so no black corners appear.",
    controls: [
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
    blurb: "Darkens towards the corners to pull the eye inward. Last in the chain, "
         + "on top of everything else.",
    controls: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, def: 0.10,
        hint: "How dark the corners go. Small values read as a lens, large as a mood." },
      { key: "feather", label: "Feather", min: 0.05, max: 1, step: 0.01, def: 0.6,
        hint: "How gradually it falls off. Low is a hard circle, high is a soft, "
            + "barely-there fade." },
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
// bigger canvas, and that was the user's explicit call.
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
