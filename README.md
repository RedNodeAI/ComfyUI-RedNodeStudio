# RedNode Studio

One panel that runs the whole picture, and the nodes around it. The Studio Workspace holds the
models, the prompts, the camera, the LoRAs, the references, the canvas, the painting and the
grading in one tabbed node, samples the render itself, and hands the result to a Detailer that
lists its passes instead of wiring them. Everything else in the pack, the routing, the review,
the saving, the stage comparison, exists to keep the canvas small around that.

![The whole rig: one Workspace, a Detailer, live previews, the post chain and Save](images/graph.webp)

**62 nodes · No pip dependencies · Advanced Krea 2 tools included**

- Build and control complex workflows without filling the canvas with utility wires.
- Paint, compare, grade and review images without leaving the workspace panel.
- Run moodboard and identity-preserving Krea 2 workflows from one interface.
- Watch every step of a render as it forms, decoded by the small VAE.

Search **RedNode Studio** in ComfyUI Manager, or clone it:

```
git clone https://github.com/RedNodeAI/ComfyUI-RedNodeStudio.git ComfyUI/custom_nodes/ComfyUI-RedNodeStudio
```

## Install

Search for **RedNode Studio** in ComfyUI Manager, or clone it with the line above.

Restart ComfyUI. Everything registers under the `krea2` and `RedNode` categories in the node menu.

Python 3.10 or newer. No pip dependencies beyond what ComfyUI already installs.

## Quick start

Open the template browser and load **RedNode Studio**, or open
`example_workflows/RedNodeStudio_V1.3.json` directly. It is the whole rig wired up, and it reads
left to right. It pulls in a few other packs, and ComfyUI Manager offers them when you open it.

If you would rather build it yourself, the graph is short:

1. Add **RedNode Studio Workspace**. On its Models tab, make a rig: the model, its CLIP, its VAE,
   and the sampler numbers. Choose **Built-in sampler** and the node renders on its own.
2. Write the prompt on the Prompts tab, and put a reference on the Subject tab if there is a face
   to keep.
3. Wire the workspace's `image` output into **RedNode Studio Detailer**, then into **RedNode Post
   FX**, then into **RedNode Save** and **RedNode Image Review**. Add a **RedNode Live Preview**
   on the same output to watch the render form.

That is one node doing the work and four watching it. The **External sampler** setting is the
other route: the workspace then hands out the model, the conditioning and the latent as sockets,
and your own KSampler does the sampling, which is exactly what every workflow did before the
built-in one existed.

## The Workspace

Thirteen tabs, in four groups. The strip sits on the panel and the panel sits on the node; press
the full screen button and the same panel takes the whole window. The socket tuck, the plug on the
row above the tabs, parks unwired sockets as dots along the node's bottom edge, so a node with
forty sockets is no taller than its panel.

![The Models tab: two rigs, the sampler numbers, the built-in sampler chosen](images/workspace-models.webp)

**Models.** A rig is a model with its CLIP and VAE, its sampler numbers, its detailer steps, a
second sampler pair for image to image runs, and which LoRA set it carries. Keep several and switch
the active one; a Detailer pass can name any of them, so a face can be detailed by a different
model from the one that rendered the frame. The same tab chooses between the built-in sampler and
an external one, holds the seed, and can keep two rigs in RAM at once so a two-rig chain stops
reloading. Each rig also folds away a set of sampler dials, all off by default: an AuraFlow shift
on the model, Detail Daemon (a sigma nudge over the run for finer detail without more steps),
Seed Variance (a jitter on the conditioning early in the run, so one seed lands on different
compositions) and densify the tail (extra steps only in the last part of the schedule). They ride
the built-in sampler and every Detailer pass on that rig, and so do three schedule shapes of the
pack's own on the scheduler list, beta57, bong_tangent and hyperbolic; a stock KSampler on the
scheduler socket is handed simple when a rig names one of those. A diffusion model file goes
through the loader the rig names: by file name, a .gguf through ComfyUI-GGUF and anything else
through the standard loader, or INT8 W8A8 outright through ComfyUI-INT8-Fast when that pack is
installed; the file picker lists those packs' files beside the standard ones. A rig can also be
your own nodes: name it on RedNode Rig Model, Rig Inputs and Rig Result, and every pass on that rig
samples through your graph, with no wire to the Workspace. A Krea 2 rig carries an Official Krea 2
model switch, and the identity edit warns until it is set. The tab is laid out by purpose: a Rigs
bar, then Files and Sampling side by side, the Seed across the bottom. The footer carries the UI
scale and the presets cog; the resize long edge and the studio preset are on the Advanced tab.

**Run.** Queue the workflow and watch it. Generate sits beside Full or Draft (Draft makes the
Detailer and the Post chain pass the picture through for fast rerolls) and the VRAM limit, your
card's size from 8 GB to 32 GB+, or Free range. Under them the run's estimated peak, worked out
from the model files it will load, the size it works at and, for Swap and Re-angle, the edit
engine as a stage of its own. Hold is Auto, On or Off: Auto keeps the run under the limit only
when the estimate says it must, so a run that fits keeps its speed, and holding streams the
weights through the card instead of loading them whole. Below: a box per stage (captions, encode,
each pass, decode, Swap, Detailer, Post FX, Save) with its state, time and step count; the picture
forming, with a batch's frames as a strip under it; a VRAM chart with model loads and unloads
marked and the models on the card now; and a log of what is happening in plain words, every
Detailer pass and paint pass named with what it did. A box or a line opens the page that decides
it, the finished picture opens full screen with the Review's menu, and History under the log
reopens any run of the session. The Review sub-tab keeps every finished picture from this
Workspace like an Image Review node, the Stages sub-tab shows the last run's Stage Taps like a
Stage View node, and the Save sub-tab holds RedNode Save's settings: switched on, the Workspace
files every finished picture itself.

**Detailer.** The RedNode Studio Detailer's passes, run by the Workspace after the render and
before Post FX when switched on, so a single Workspace renders, details, grades and files. A
Detailer, Post Process or Save node already in an older workflow steps aside for any step the
Workspace did.

**Prompts.** Rows, each linked to one or more rigs, so a rig renders its own words. A row is either
a Frame box, the prompt frame editor with Style, Subject, Surroundings and Light and colour and the
framing dial between them, or a Plain box for any other model. Each writing box keeps its saved
versions behind a Presets button, and an Anything else box under the frame takes raw text: Auto
sort files it into the boxes, Rewrite rewrites the boxes in place. The frame's Camera section has a Camera words switch that stops every
camera sentence it writes, shot size, height stop and the studio's paragraph alike, and the Camera
tab's switch strips the studio's paragraph from the queued prompt as well as the LoRAs and the path. The auto prompt captions the references through a local vision model
(Ollama, WD14, JoyCaption, QwenVL or Florence-2, one Florence model and task shared by every tab),
with a length budget, a converter for gender and style swaps, and a saved prompts button.
Wildcards and `@keyword` macros resolve on the run's seed.

**Camera.** The stage from the camera section below, on its own tab, with a master switch. It has
two studios: the one behind the prompt, whose camera writes the paragraph and drives the camera
LoRAs, and a separate one for the Img2Img tab's re-angle.

![The LoRAs tab: Main and a named set, grouped slots, a random range, the row menu](images/lora-stack.webp)

**LoRAs.** The main stack, plus named sets on their own sub-tabs. Rows drag by their grip, switch
off by their eye, and group under titles; a strength can be a random range with the roll shown
after the run. A rig picks its set by name, and so can a Detailer pass or a paint pass. The Paint
tab has a stack of its own.

![The Latent tab: the canvas, and two refine passes with a denoise and a scale each](images/latent.webp)

**Latent.** The canvas size, with aspect presets, a random size, and an auto latent that follows
the camera's frame at a pixel budget. Refine passes run on the blank canvas: pass 1 generates, and
every pass after it treats what pass 1 made as its source, at a Refine dial or a denoise and a
scale per pass with a Ramp, so a draft-small-then-climb run needs no second node. A rig and a step
count per pass are there too, which is how a HighNoise and LowNoise pair relays: pass 1 drafts on
one rig in a step or two, pass 2 finishes on the other at a denoise just under 1, with Hold two
rigs keeping both models loaded. Continue the noise between passes makes the passes segments of
one schedule instead, each carrying the last one's leftover noise on with none added, which is
how a Wan-style pair is meant to relay. The Img2Img tab's passes have the same sections.

![The Img2Img tab: source, pass, RE-ANGLE, SWAP and the auto prompt](images/img2img.webp)

**Img2Img.** A source picture, the pass over it, and two stages that run before the pass.
Denoise is a full-width bar, and with several passes each one can have its own denoise and its
own scale. RE-ANGLE re-shoots the source from another viewpoint with the multi-angle edit model,
from three bands or from the Camera tab's studio, and a switch stops after the re-shot so the rig
never enters VRAM beside the edit model. SWAP puts a face, head or whole person onto the picture: the Subject's, another picked person's,
or a picture from Swap's own gallery. It works on the source before the pass, or on the new
render, a Latent tab render too, with a polish pass by the rig afterwards; a Fast switch runs it
on the Lightning LoRA, quick phrase buttons build its prompt, and both stages show their steps on
the Run tab and run the edit model on PyTorch attention, so SageAttention does not break them. Its Auto prompt page also holds IMAGE TO TEXT: Style,
Subject and Scene galleries whose pictures are only described in words, never sent to the model,
so a look, a person or a place can steer any rig's prompt.

![The Paint tab in full screen: the mask, the result, and the paint settings](images/paint.webp)

**Paint.** Mask a region, set the denoise, queue. It composites back by itself, and it runs on
whichever renderer you point it at: a rig from the Models tab, the pack's own Paint Render, or an
outside chain through Paint Out and Paint In. Auto-mask the subject or the background rather than
painting by hand, paint in colour to steer the fill, and run the low-denoise chain as passes in
one Generate. While it samples, the picture forms over the result pane, step by step, at a frame
size the tab chooses. Every result stays in a history with a full screen viewer of its own, and
one click sends the keeper through the post chain and into the save tree. Blend sits beside
Feather, the Detailer's dial for how much of the repaint goes back under the mask. Use last result
can take the picture from before Post FX, so grain and grade never land under the brush, and the
Subject, Scene and Moodboard reference toggles follow the Model choice's rig.

![The Subject tab, with references and the identity dials](images/workspace-subject.webp)

**Krea 2 Identity: Subject, Scene, Masks.** One tab with a sub-tab for each, and a light on
each showing what is in use. Subject is one gallery where you pick the people in order: the
first is the main subject, and the others follow as Person 2, 3 and on (more than three still
runs, with a warning that faces may blend). Scene is a place rebuilt as in-context latents.
Subject and Scene each have Gallery, Boosts, Auto prompt and Converter tabs; the Subject boosts
apply to every person. Scene has a window, from and until, and a Words only switch that captions
the picture without sending it as a reference; Boosts off keeps a fidelity set below 1. Masks holds the subject boost mask, which rides into the identity edit
and is sized against the main subject's picture. To change part of a picture in place, use
the Paint tab.

**Moodboard.** Batches several pictures into one style signal. Gallery, Boosts and Auto prompt
tabs sit under a status bar, and Boosts has one-click presets from A hint to Outfit transfer. Its
Auto prompt reads every picture as Style, Subject or Situation and injects the words into that
slot of the prompt frame. Right-click a picture in any
gallery for the gallery menu.

![The Post tab: saved effects, the chain list on the left, the selected effect's editor on the right](images/post-fx.webp)

**Post.** The grading chain, twenty effects in physical camera order, with random ranges on any
dial. The tab is a list of the chain on the left, an eye per effect to switch it on, and the
selected effect's controls on the right, one at a time; the Order view lays the effects that are on
out as numbered cards to drag into another order, double or take out. Every card has a Limit row:
whole frame, subject only or background only, through the pack's own auto-mask, with the Mask card
setting the source and the feather. RedNode Post Process finds these settings by itself when it
sits at the end of the graph.

The cards cover the whole grade. Colour is exposure in stops, shadows and highlights that keep
black black and white white, local HDR, lift, gamma and gain, vibrance that leaves skin alone, and
split tone, with a Measure button that reads the frame's white balance and writes it into the
dials. Skin retouches skin and nothing else: a mask built from colour that stays off eyes, lips,
teeth and busy fabric, then de-yellow, rosy, evenness, and smoothing with a texture dial that keeps
the pores. Sharpen has a Detail band mode for AI frames that bites without halos, speckled skin or
white rims on hair. Film stock turns light into density the way twelve stocks do, colour negative,
slide, tungsten cinema, instant and black and white with its lens filters. Lens distortion carries
a lens picker, from a 14 mm ultra wide to a 135 mm, phone, vintage and anamorphic glass, that fills
the distortion and fringing dials at a size that holds at any resolution. Depth of field, haze and
Relight, a new key light over the picture's relief with contact shadows, make their own depth map;
the Depth card picks the estimator, the checkpoint and the resolution. Match reference moves the
frame's colour onto a dropped picture or a Moodboard, Subject, Scene or Img2Img picture with skin
held back, and LUT applies a .cube file from models/luts.

Saved effects has two tabs. Mine keeps the effects you save, every dial and the order, with a
picture of what they did. Shipped is a library of seventeen looks that come with the pack, each
with a picture: Pro Grade starting points for Krea 2 and Z-Image, portrait, beauty and product
advertising grades, food, cinematic and night looks, a faded 70s print, 90s instant film,
disposable flash, an early digital compact and black and white. Apply one freely; save a copy under
your own name to change it, since the shipped ones cannot be edited or deleted.

![The Advanced tab: workspace preferences and the studio settings](images/advanced.webp)

**Advanced.** The workspace's preferences for this install rather than this workflow: the paint
layout, the mask overlay, whether prompts echo to the console, and a button to unload the caption
models.

## The Detailer

![The Detailer: two sampler passes, a face detailer and an upscale, with a Live Preview watching](images/detailer.webp)

RedNode Studio Detailer is the post-render work as a list, read top to bottom, with no wires
between the passes. Each pass is a card: what it is, which rig runs it, what it aims at, and three
boxes under that. Sampling holds steps, CFG, sampler, scheduler and a start and end step window,
where anything left empty inherits the rig's own numbers. Strength holds Scale and Denoise as bars
and the Repeat count, and a repeat above one offers a denoise and a scale per round with a Ramp.
Prompt holds the LoRA stack switch and its set, the four Krea 2 references, a LoRA for this pass
only, which Prompts-tab row it reads, and a box that wins over all of that when it has words.

Three kinds of pass:

- **Sampler**: the whole frame refined at a denoise, an image to image over what arrived. Its
  scale sticks, so 0.5 then 2.0 across two passes is the shrink-and-regrow chain.
- **Detailer**: SAM3 segments a target, face, hair, hands, eyes, clothes or background, the crop
  renders at a working resolution, and goes back under a feathered mask at a blend, so a stronger
  denoise can be softened at the paste instead of at the sampler. The SAM file and its precision
  are picked once on the node.
- **Upscale**: SeedVR2 at a size, 720p, 1080p, 2K, 1440p or 4K as a pixel budget, with the short
  edge worked out from the frame's own aspect. The loader dials sit on the card. A region, face
  or hair, upscales that crop only and the frame keeps its size; an out-of-memory halves the
  tile and tries again.
- **Tiled upscale**: Ultimate SD Upscale as a pass, the rig's model and the pass's prompt over
  tiles, an upscale model first or a plain resize, opened on 6 steps of deis at 0.25 denoise,
  1024 tiles padded 128 and no seam fix. Needs ComfyUI_UltimateSDUpscale.
- **On every card**: Free VRAM before the pass, and Tone lock, which keeps the pass's new detail
  but takes the tone from the picture as it arrived, the drift fix for a long chain.

Duplicate a pass with the button beside its delete and nudge one number, which is how a chain
gets built. Group titles fold and switch a set of passes at once. Premade layouts ship, the face
identity chain among them, and your own save by name. Taps record the input, every pass and the
output into a Stage View strip, so a chain can be read step by step. A batch goes through every
pass one picture at a time, SeedVR2 included, and the Run tab's log names each pass with what it
did.

## Watching a render

![A Live Preview mid-render: pass 1 of 2, step 3 of 8](images/live-preview.webp)

**RedNode Live Preview** shows the picture forming. Wire an image output into it and every step of
that node's render lands on it, decoded by the small VAE, with a bar and the pass it belongs to,
then the finished frame, kept at 512 px since it is a preview; the output passes the full picture
on. Both the workspace's built-in sampler and the Detailer's passes stream,
whatever ComfyUI's own preview setting is. For Krea 2 the sharp version needs
`lighttaew2_1.safetensors` in `models/vae_approx`; without it the frames are the colour smear.

**RedNode Image Review** is a preview that remembers: the newest picture on top and the runs before
it in a strip, right-click for Copy, Keep, Name and Rerun with the same seed or fresh ones. Double
click the picture for a full screen room where the wheel zooms and a drag pans. A run that made
several pictures, a camera path or a batch, shows them in a column beside the big one. Left and
right arrows walk the history, up and down walk the frames of that column.

![The Image Review's full screen room, the history strip along the bottom](images/review.webp)

![The Save node: the naming pattern, drafts and keepers, recent saves](images/save-browser.webp)

**RedNode Save** files by date, preset, seed, model or size, splits drafts from keepers, and keeps
a browser to cull a session without leaving the graph. The Review and the Save node share the
run's id, so keeping the picture you are looking at needs no wire. Every file also carries the
A1111 parameters text with the model and LoRA hashes, so a picture posted to Civitai lists what
made it, with links; each model file is hashed once and the digest kept in a `.sha256` beside it.
The Civitai metadata switch on the panel turns that off. A finish sound sits on the same panel,
off by default: every run, or once when the queue empties, so a batch sounds once at the end.

![Comparing two stages of a run with a wipe](images/stage-wipe.webp)

**RedNode Stage Tap and Stage View** photograph any point in the graph and compare two of them with
a wipe. The Detailer's Taps feed the same strip. A Full screen button, or a double-click on the
picture, puts the strip and the wipe over the whole window. Each tap keeps its frame at a size you
pick on the node, 320 px up to full size, and the view scales it to fill whatever room it has.

## Keeping the canvas small

![A full pipeline, grouped by stage](images/graph.webp)

Stages live in subgraphs and groups, so the canvas stays this small however much is in it. Group
Control switches groups on and off from one panel, Group Modes names whole configurations, and
branches you did not pick never execute.

![One panel driving nodes with no wires, including into a subgraph](images/wireless.webp)

Control Panel drives other nodes' dropdowns, sliders and toggles from one node, including nodes
inside subgraphs. Palette and Router route the graph by colour. Sender and Grabber replace a
canvas of Get and Set nodes with named channels. The wires that are not there are the point.

## The camera stage

![The stage from above: two subjects, the camera, its path, and the sets and camera controls beside it](images/camera-stage.webp)

RedNode Camera Studio is a stage seen from above. Put the subjects on it, drag the walls out to the
size of the room, then move the camera. Every subject card carries a lock, a duplicate button and a
remove button; a duplicate lands at the end of the list beside its original, unlocked, ready to drag
into place. What comes out of it is not "wide shot": it is the physical
camera language the model already answers to, a lens length, a height, a distance and an angle,
worked out from where you actually put things. The tab has its own switch like the others, so the
whole camera leaves the prompt in one click when you want the words to do the framing instead.

Fifteen setups ship with it, and a set carries the whole stage at once: camera, subjects, room size,
path and lights. Load one and adjust, rather than building a room from nothing every time. A camera
path renders one image per shot, so an orbit from -60 to +60 is a single queue and one scene from
six viewpoints. That holds on the built-in sampler and on an engine rig; an external sampler gets
one conditioning, and the tab says so when a path meets one.

![The lights: key and rim, each with size, height, exposure and colour, the light rigs, and the paragraph the stage writes](images/camera-lights.webp)

Lights sit on the same stage, each with a size and a distance, and both of those do work.
Illuminance falls off with the square of the distance, and how hard a shadow reads is really the
light's angular size from where the subject is standing, so a wide source close in and a small one
across the room come out as different words. Those words describe light and never fixtures: name a
lamp in a prompt and you get a lamp in the picture, so the wording stays on what the light is doing
to the scene. Exposure runs in stops either side of a centred zero, darker one way and brighter the
other, and colour runs in mireds either side of neutral daylight, warm one way and cool the other.

The stage turns that same geometry into slider strengths. Four camera sliders, zoom, height, orbit
and back, each one off, auto or manual. On auto the slider follows the stage, so pushing the camera
in moves zoom with it and there is no second number to keep in sync. The two lighting sliders work
the same way off the exposure and colour dials. Every slot is empty until you pick a file, and the
stage is happy with none of them.

In a plain graph, without the Workspace, wire a model and clip into RedNode Camera Studio and take
them out again: they come out with the sliders applied at the strengths the panel shows, and the
prompt output leads your text. That is the whole classic setup: the Studio, a text encode and a
sampler. On a camera path the model comes out once per shot, each at that shot's strengths. RedNode
Camera LoRAs does the same job as a separate node for graphs that want the slider files and modes
chosen there, or that get their camera_json from elsewhere.

Three of the sliders are mine, trained for Krea 2, and they are attached to the
[v1.2.0 release](https://github.com/RedNodeAI/ComfyUI-RedNodeStudio/releases/tag/v1.2.0) and listed
[on Civitai](https://civitai.com/models/2937168) with example strips:
`camera_height_krea2_rednode`, `camera_orbit_krea2_rednode` and `camera_back_krea2_rednode`. Free to
use and share, just not to sell. The zoom slider and the colour temperature slider are Loraholic's,
on Civitai: [zoom](https://civitai.com/models/2717832) and
[colour temperature](https://civitai.com/models/2760910). The brightness slider is PornMaster Krea2
Light Slider, also on Civitai. They all go in `models/loras`.

## The prompt frame

![The frame editor: Style, Subject, Surroundings, Light and colour, the framing dial, and the preview it writes](images/prompt.webp)

Word order sets the framing. Open a prompt with the person and you get a close shot. Put the room
first and the camera pulls back, same words. That is most of what "wide" and "close" actually mean
to the model, and it is the first thing to go once a prompt is long enough to be useful.

RedNode Prompt Frame splits the writing into Subject and Surroundings and puts a framing dial
between them. Portrait, Half body, Balanced, Full scene, Roomscale. The two tight steps lead with
the subject and open it with "A close view of" or "A three-quarter view of". Balanced and wider lead
with the surroundings and set the subject inside them, then add a scale cue at the two widest steps,
"seen full length" and "small in the distance". Your wording is never rewritten. Only the order and
the joining words change.

At Full scene and Roomscale a subject with nowhere to stand can drop out of the picture entirely.
Two dropdowns build a placement, "beside the doorway", or type your own and it overrides both.

Style blocks, twenty lighting setups and a brightness ramp slot in around that text at fixed
positions. The second output is a notice line, and it does real work: it says when the style already
lights its own scene and the lighting dropdown will fight it, when a wide framing has no placement,
when the prompt has run past the 90 to 150 word working range, and when Portrait framing carries
surroundings long enough to pull the camera back on their own. Wildcards and @keywords resolve in
the finished text, seeded, the same as the Prompt Box.

The panel builds its preview by asking the node, so what it shows on the canvas is what renders.
The same editor is what a Krea 2 prompt row on the Workspace's Prompts tab is. Each section,
Style, Subject, Surroundings and Light and colour, saves and loads its own named snippets, and
the camera segment reads Off, Simple or Advanced: Off writes no camera sentence at all.

RedNode Describe To Boxes fills those boxes from a picture. It sends the image to a local Ollama
vision model, asks for five labelled sections, and hands back Subject, Surroundings and Light and
colour on separate outputs, with the raw reply on a fourth in case the split came back malformed.
Its engine choice adds Florence + Ollama: Florence-2 writes the caption and Ollama, text only, sorts
it into the sections. The vision model is released from VRAM as soon as the reply lands, so it does
not sit on top of your checkpoint for the rest of the queue. Beside the Frame's Auto sort button a
Rewrite button sends the boxes through the same Ollama model as a writer, with a style tag
(keep, photoreal, cinematic, illustration), and puts the result back in the boxes for editing.

## The Krea 2 system

The workspace works with any model. This section is about the part that only applies to Krea 2.

Stock ComfyUI runs Krea 2 text-to-image perfectly well. These nodes exist for what the stock nodes
cannot do with reference images.

Stock image-reference encodes (the qwen-edit style nodes) pass references through the encoder as
semantic description only, using QwenImage's template rather than Krea 2's. The model learns what
is in your reference, with no control over which aspect transfers, no strength dial, and
multi-reference inputs that can collapse into grid or collage outputs. Core's `ReferenceLatent`
attaches latents that Krea 2's stock model ignores, because there is no in-context pixel path, so
no true identity preservation and no edit-LoRA support.

This pack adds both halves on top of the stock implementation: the moodboard controls (strength,
style against subject extraction, crops, indirect mode, grid-safe packed spans) and the full
identity-edit recipe (in-context source latents at RoPE frames 1 to N, Krea 2 template grounded
instruction and grounded negative, v1.2 fit geometry, ref_boost). Every patch is additive. Leave
the nodes unused and each patched path is bit-identical to stock ComfyUI.

To use it you need:

- ComfyUI with native Krea 2 support
- The **qwen3vl_4b** text encoder with vision weights, loaded through CLIPLoader with type `krea2`
- `qwen_image_vae`
- For editing, a krea2_edit LoRA at strength 1.0 through LoraLoaderModelOnly

The Workspace folds the studio in: a Krea 2 rig encodes through the identity system with the tab
images loaded, so the references never need a wire. **RedNode Studio (Krea 2)** is the same encode
as a node of its own, for a classic graph: it replaces the positive `CLIPTextEncode`, takes the
references on sockets, and outputs a matched positive and negative pair.

Companion to the [Forge Neo version](https://github.com/RedNodeAI/forge-neo-krea2-toolkit), same
algorithms and same knobs.

## The nodes

### Studio and workspace

| Node | What it does |
|---|---|
| RedNode Studio Workspace | The whole input rig in one tabbed panel, wired to the studio by a single bundle. The Latent tab runs refine passes on a blank canvas, the Img2Img tab's RE-ANGLE can stop after the re-shot so the rig stays out of VRAM, a rig can name a second sampler pair for image to image runs, and a camera path renders one image per shot on the built-in sampler and on an engine rig. |
| RedNode Studio Detailer | The post-render passes as a visual list: sampler refines and SAM3 face detailers in order, each with its own rig, steps, CFG, sampler, step window and scale ratio, no wires between them. A pass can repeat with a denoise and a scale per round, pick which Prompts-tab row it reads, and a SeedVR2 upscale pass (720p to 4K) sits in the same list; the SAM file and precision are picked on the node. |
| RedNode Studio (Krea 2) | Moodboard and identity edit in one node, with a matched grounded negative. The studio the Workspace folds in, for a classic graph. |
| RedNode Studio Settings (Advanced) | Every dial in plain language, for when a preset is not enough. |

RedNode Studio Preset Save and Preset Load still ship and still work, but the Workspace covers
what they did. Treat them as legacy.

### Routing and control

| Node | What it does |
|---|---|
| RedNode Palette | The colours that drive every Router. Switch a colour, re-route the graph. |
| RedNode Router (advanced switch) | Each branch passes when its colours are on. Losing branches never run. |
| RedNode Router Control | Counts every Router and turns their unique colour combinations into one non-stacking switchboard. |
| RedNode Switch | Pass one of several inputs through, chosen by name. |
| RedNode Pass (colour trigger) | Passes anything through and flips Palette colours as it goes. |
| RedNode Free VRAM | Unloads models at this exact point in the chain, so a second big model can run on a card that cannot hold both. |
| RedNode Control Panel | Many other nodes' dropdowns and toggles on one node, no wires. |
| RedNode Combo Control | The single-row version of the same idea. |
| RedNode Group Control | Turn workflow groups on and off, with saved scenes. |
| RedNode Group Modes | Named modes that enable one set of groups and bypass the rest. |
| RedNode Rig Out / Rig In | Hand a Models-tab rig's prompt, seed and sampler numbers to an outside engine, then bring its picture back into the chain. |

### Camera

| Node | What it does |
|---|---|
| RedNode Camera Studio | A top-view stage: place the subjects, the walls and the lights, move the camera, and the geometry is written as the physical-camera language Krea 2 obeys. Wire a model and clip through it and they come out with the slider LoRAs applied. Camera paths render one image per shot. |
| RedNode Camera LoRAs | Applies the camera slider LoRAs (zoom, height, orbit, back) from the studio's own geometry, off / auto / manual per slider. |
| RedNode Camera Multi-Angle | Turns the studio's camera into a Qwen-Image-Edit Multiple-Angles prompt, for re-shooting an existing photo from another viewpoint. |

### Images, painting and review

| Node | What it does |
|---|---|
| RedNode Save | Files images by date, preset and seed, and splits drafts from keepers. |
| RedNode Paint Render | Renders only the region you painted, then composites it back. |
| RedNode Paint Out / Paint In | Hand the painted region to any other renderer, then composite the result back. |
| RedNode Refine Crop / Refine Paste | Cut a masked region out for refinement by any sampler, then put it back. |
| RedNode Image Review | A preview that remembers, with a browsable strip of previous runs. Double-click the picture for a full screen view where the wheel zooms and a drag pans. A run that made several pictures shows them in a column beside the big one; click to view any of them. |
| RedNode Live Preview | Shows the picture forming step by step while the node wired into it renders, then the finished frame. The workspace and the Detailer decode every step with the small VAE (lighttaew2_1 in models/vae_approx for Krea 2) and stream it here, whatever ComfyUI's own preview setting is. |
| RedNode Rig Model | Your own loaders as a Workspace rig. Wire in a model, CLIP and VAE; out come the same with the Workspace's LoRAs for that rig applied, ready for your sampler. Give it the rig's name, and pick Your own nodes for that rig on the Models tab. Nothing is wired to the Workspace. |
| RedNode Rig Inputs | What the Workspace hands your sampler for the rig named on it: positive, negative, latent, seed, steps, CFG, sampler, scheduler, denoise, start step and end step. The prompts carry the cameras, and on a Krea 2 rig the Subject (every person picked) and Scene references. |
| RedNode Rig Result | The end of your rig: wire in the finished latent or picture. The main render, every Latent and Img2Img pass, the paint pass and every Detailer pass on that rig sample through your nodes, each with its own values, and the result carries on to the Detailer, Post FX and Save. |
| RedNode Stage Tap / Stage View | Photograph any point in the graph at a chosen size, then compare stages with a wipe, on the node or full screen. |

### LoRAs and sampling

| Node | What it does |
|---|---|
| RedNode LoRA Stack | Multi-LoRA loader with per-slot strength, random ranges, trigger words and presets. |
| RedNode LoRA Stack Save | Saves a stack under a name. Keep it muted unless you are saving. |
| RedNode Sampler Config (auto turbo) | Detects a turbo distill from the loader's filename and outputs matching settings. |

### Prompting

| Node | What it does |
|---|---|
| RedNode Prompt Box | Prompt editor with highlighting, @keyword macros and a seeded wildcard engine. |
| RedNode Prompt Frame | Subject and Surroundings in their own boxes, emitted in the order that sets the framing. Five steps from Portrait to Roomscale, plus placement, style, lighting and a warnings output. |
| RedNode Describe To Boxes | Reads a picture into Subject, Surroundings and Light and colour, ready to wire into the Frame. Runs on a local Ollama vision model, or Florence-2 with Ollama sorting its caption. |
| RedNode Prompt Combine | Prompt pieces joined in the order you drag them, typed, wired, or pulled wholesale from a channel. |
| RedNode Text Combine | The plain string joiner: same rows, no prompt flag. |
| RedNode Prompt Converter | Word-boundary gender and style swaps for captions. |
| RedNode Prompt Keywords | The global @keyword library that every Prompt Box reads. |
| RedNode Selector | A dropdown of your own choices, output as a string. |
| RedNode Note | A canvas label with big glowing text, a colour and a font. Unselected it is just the sign, with no title bar and no settings. |
| RedNode Note Panel | Every RedNode Note in the workflow in one list, with its size, font, colour and glow. Drives them live, and can restyle all of them at once. |
| RedNode Report | A sign whose words come from the run: wire a value through it and it reports what went past, in the same styling. Passes the value straight on. |

### Post processing

| Node | What it does |
|---|---|
| RedNode Post Process | The Workspace Post tab's grading chain. Image in, graded image out; the subject mask and the match reference are found by itself. |
| RedNode Post FX (standalone) | The same chain with its own panel, for any image, no workspace needed. Depth of field and haze make their own depth map; the Depth card on the panel picks the estimator, the Depth Anything V2 checkpoint and the working resolution. |

### Moodboard and identity

| Node | What it does |
|---|---|
| Krea 2 Moodboard | One-node vibe transfer. Prompt and references in, conditioning out. |
| Krea 2 Moodboard Encode (packed) | Same, with every reference packed into one vision span. |
| Krea 2 Identity Edit | In-context identity preservation with the edit LoRA. |
| Krea 2 Moodboard + Identity Fusion | Both of the above fused into a single encode. |
| Krea2 Edit Source Chain | Chains extra reference images for multi-reference editing. |
| Krea 2 Conditioning Rebalance | Per-layer reweighting of the Qwen3-VL conditioning stack. |

### Prototypes

Unfinished, and marked so on the node.

| Node | What it does |
|---|---|
| RedNode Group Rules | Rules between groups, and a panel showing what a queue will run before it runs. |
| RedNode Sender / Grabber | Named channels replacing a canvas of Get and Set nodes. One reader lists everything on a channel. They work anywhere, subgraph or not. |
| RedNode Channel Convert | Converts between string, int, float and boolean. Placed automatically when a channel row asks for it. |

## Example workflows

In `example_workflows/`, and in ComfyUI's own template browser once the pack is installed.

- `RedNodeStudio_V1.3.json` is the full rig and the one to start with: a single
  workspace panel drives the models, the prompts and the sampler, with painting, identity
  edit, the Detailer's passes and its SeedVR2 upscale, and the grading chain around it. The rigs
  and the Prompts tab are options rather than requirements, so a graph wired the old way keeps
  working. It pulls in a few other packs and ComfyUI Manager offers them when you open it:
  SeedVR2 Video Upscaler, pysssss custom-scripts, easy-use, comfyui-krea-moodboards and
  Krea2-BBOX-Prompter. Manager installs packs but not models, so the upscaler's two files are
  yours to fetch: `seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors` and
  `ema_vae_fp16.safetensors`.
- `RedNode_Studio_Pro_Grade.json` is the V1.3 graph with the settings of a heavy Krea 2 grading
  flow set on the pack's own controls: 10 steps on the beta57 schedule with Detail Daemon and a
  densified tail, i2i at 0.97, a face and eyes detailer group, a tiled pass at 0.25 with Tone lock,
  then SeedVR2 to 2K with the VRAM freed first. Pick a 1x skin model on the tiled card when you
  have one; it ships resize-only.
- `RedNode_MultiAngle.json` re-shoots an existing photo from another viewpoint:
  the Camera Studio's geometry becomes a Multiple-Angles prompt for Qwen-Image-Edit-2511, and
  Krea 2 finishes the frame.
- `RedNode_Studio_Simple_Angles.json` is the camera stage in a plain graph, no Workspace:
  Camera Studio with the loaders wired through it, a Prompt Box and Prompt Combine for the
  words, a stock KSampler, Save and Review. The stage sets the camera slider strengths by
  itself, and a camera path renders one image per shot. The three RedNode sliders it names
  are the free Civitai files above.

Two optional packs matter to the STUDIO itself rather than to a workflow. **ComfyUI-Easy-Sam3**
gives the Detailer its face, hair and hands masks (it wants `sam3.pt` in `models/sam3`). Without
it the pack runs fine and a detailer pass says so and passes the picture through untouched, rather
than failing. **ComfyUI-SeedVR2_VideoUpscaler** is what the Detailer's upscale pass runs on, and
an upscale pass without it passes the picture through the same way.

Baked-in settings worth knowing: ModelSamplingAuraFlow shift 1.15 (ComfyUI's stock Krea 2 default,
the node is there as a handle), Euler with the simple scheduler, turbo at 8 steps and CFG 1. With
the v1.2 LoRA, 8 steps gets composition and 12 gets face detail. Generate at 2MP or under.
Matching output aspect to the source is no longer required once `target_latent` is connected,
though staying close still looks best.

## Downloads

Everything the pack needs beyond ComfyUI and the image models themselves, with where each file
goes. ComfyUI Manager installs the packs; the files are yours to fetch.

### Krea 2

| File | Goes in | Where from |
|---|---|---|
| `qwen3vl_4b_fp8_scaled.safetensors` (or the bf16) | `models/text_encoders` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/text_encoders) |
| `qwen_image_vae.safetensors` | `models/vae` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/vae) |
| `krea2_identity_edit_v1_2.safetensors`, the identity edit LoRA by lbouaraba | `models/loras` | [Civitai](https://civitai.com/models/2761113) or [Hugging Face](https://huggingface.co/conradlocke/krea2-identity-edit) |

The identity edit LoRA only behaves on the official Krea 2 Turbo; on other Krea 2 checkpoints the face
drifts. Keep one rig on the official Turbo and point the face passes at it: a Detailer card names its
rig, so the rest of the picture can render on any model and the face still lands on Turbo.

### Camera and light sliders

| File | Goes in | Where from |
|---|---|---|
| `camera_height_krea2_rednode.safetensors` | `models/loras` | [v1.2.0 release](https://github.com/RedNodeAI/ComfyUI-RedNodeStudio/releases/download/v1.2.0/camera_height_krea2_rednode.safetensors) or [Civitai](https://civitai.com/models/2937168) |
| `camera_orbit_krea2_rednode.safetensors` | `models/loras` | [v1.2.0 release](https://github.com/RedNodeAI/ComfyUI-RedNodeStudio/releases/download/v1.2.0/camera_orbit_krea2_rednode.safetensors) or [Civitai](https://civitai.com/models/2937168) |
| `camera_back_krea2_rednode.safetensors` | `models/loras` | [v1.2.0 release](https://github.com/RedNodeAI/ComfyUI-RedNodeStudio/releases/download/v1.2.0/camera_back_krea2_rednode.safetensors) or [Civitai](https://civitai.com/models/2937168) |
| Zoom slider, Loraholic's | `models/loras` | [Civitai](https://civitai.com/models/2717832) |
| Colour temperature slider, Loraholic's | `models/loras` | [Civitai](https://civitai.com/models/2760910) |

The three camera files are mine: free to use and share, not to sell. The two Loraholic sliders
are theirs and are only ever linked. Every slider slot is optional; the Camera LoRAs card is happy
with none of them, and the brightness slot takes whichever light slider you pick.

### The Detailer

| File | Goes in | Where from |
|---|---|---|
| [ComfyUI-Easy-Sam3](https://github.com/yolain/ComfyUI-Easy-Sam3), the pack | Manager | the face, hair and hands masks |
| `sam3.pt` | `models/sam3` | [facebook/sam3](https://huggingface.co/facebook/sam3), gated: request access on the page, then download |
| [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler), the pack | Manager | the upscale pass |
| `seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors` | `models/SEEDVR2` | [AInVFX/SeedVR2_comfyUI](https://huggingface.co/AInVFX/SeedVR2_comfyUI/tree/main) |
| `ema_vae_fp16.safetensors` | `models/SEEDVR2` | [numz/SeedVR2_comfyUI](https://huggingface.co/numz/SeedVR2_comfyUI/blob/main/ema_vae_fp16.safetensors) |

The SeedVR2 loaders also fetch their files on first use when the folder is empty, so the two rows
above are for anyone who would rather place them by hand. The 3B model is smaller and its loader's
default; the 7B is what the example workflow runs.

### Ollama

| What | Where from |
|---|---|
| [comfyui-ollama-describer](https://github.com/alisson-anjos/ComfyUI-Ollama-Describer), the pack | Manager; it installs the `ollama` client library the Ollama engine talks through |
| Ollama itself | [ollama.com](https://ollama.com); set `OLLAMA_HOST` if it runs on another machine on your network |

Without that library the Ollama engine, Rewrite, Auto sort and the People rewrite say so and
step aside; Florence, WD14, JoyCaption, QwenVL and CLIP gen run in-process and need nothing.

### Live preview and depth

| File | Goes in | Where from |
|---|---|---|
| `lighttaew2_1.safetensors`, the small VAE for Krea 2 frames | `models/vae_approx` | [lightx2v/Autoencoders](https://huggingface.co/lightx2v/Autoencoders/blob/main/lighttaew2_1.safetensors) |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux), the pack | Manager | the Post FX Depth card's estimators; each fetches its own weights on first use |

Without the small VAE the live frames still stream, as the colour smear rather than a decode.

### Re-angle and swap

The Img2Img tab's RE-ANGLE and the multi-angle workflow run on Qwen-Image-Edit-2511; the SWAP
stage and the Detailer's swap presets run on the BFS files.

| File | Goes in | Where from |
|---|---|---|
| `qwen_image_edit_2511_fp8mixed.safetensors` | `models/diffusion_models` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/tree/main/split_files/diffusion_models) |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/tree/main/split_files/text_encoders) |
| `qwen_image_vae.safetensors` | `models/vae` | the same file as the Krea 2 one above |
| `qwen-image-edit-2511-multiple-angles-lora.safetensors` | `models/loras` | [fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA) |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras` | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) |
| `bfs_head_swap_v1.1_krea2.safetensors` and the body swap file | `models/loras` | [Alissonerdx/BFS-Best-Face-Swap](https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/tree/main) |

## Performance

Measured on a 5090. A classic single KSampler pass runs about 17 seconds. A full chain, meaning a
second pass, a face detailer and a 4K upscale, lands between 45 and 60 seconds depending on how
much fits in VRAM at once. Mid-range cards land at roughly double, so a full quality chain can pass
a minute and a half per image. Krea 2 is a quality-first model rather than a fast one.

For low VRAM: set resize to 1024, keep to one reference where you can, turn the fidelity dials off
or set boost blocks to `all`, leave the captioner unload default on, and use smaller Ollama models.
The Run tab's VRAM limit is your card's size: it holds the expensive dials to what that card can
take, estimates the run's peak from the files it will load, and Hold keeps the weights under the
line when the estimate says they must be.

**RedNode Free VRAM** is the other half of that. Put it in the chain before a second big model
loads, and the first one is unloaded at that exact point rather than when the driver runs out of
room. On a card that cannot hold two models at once, that is the difference between a pass running
normally and a pass running an order of magnitude slower while it spills into system memory.

The example workflow ships with three, all switchable from the panel. Two sit in the Low VRAM
Options group, before the face detailer and before the upscale, and are on by default. The third
is on the Z Turbo detailer branch and is off, because that branch only needs it when the detailer
runs a different model from the main pass.

## Settings and stored data

Global preferences live in ComfyUI's own settings dialog, under **RedNode**: whether
captions are remembered between runs and how many, whether saved effects keep a picture, how
many pictures each Image Review keeps (on its strip and in the temp folder) and the size its big
picture loads at on the node, how many saved images the index remembers, and a button
to clear the regenerable caches. Anything that belongs to a single workflow, the grading
chain, the paint strokes, which images are on a tab, stays on its node instead.

What the pack keeps on disk, measured rather than estimated:

| Where | Size | What |
|---|---|---|
| `user/default/rednode-krea2/` | about 456 KB | presets, scenes, the keyword library, the saved index, and roughly 200 KB of regenerable LoRA caches |
| inside a workflow file | about 65 KB on a large graph | each node's own settings, mostly the Workspace's galleries, dials and strokes |
| beside a saved image | a few KB | the text record, and the JSON one if you asked for it |

Clearing the caches never touches a preset, a record or an image. Those are your work;
the caches rebuild themselves.

## License

**PolyForm Noncommercial 1.0.0.** Free for personal use, hobby projects, research, study and
noncommercial organizations. Commercial use needs my permission, so get in touch. Full terms in
[LICENSE](LICENSE).

In plain language: use it, modify it, learn from it, share it, all fine. Selling it or building it
into something you sell is not, unless you have arranged that with me separately.

ComfyUI itself is GPL-3.0 and is a separate work. Releases up to and including v1.4 were published
under GPL-3.0 and stay available under those terms. The license change applies from v2.0 onward.

## How it works

Small additive patches at import time: packed list-spans in Qwen3-VL preprocessing, moodboard
effects inside Krea 2's `encode_token_weights`, and the in-context ref-latents branch on the Krea 2
DiT, following the same `reference_latents` conditioning contract that QwenImage and Flux edit
models use. A patch guard checks each one at startup and reports what it found. With the nodes
unused, every patched path returns exactly what stock ComfyUI returns.

## Credits

[ComfyUI](https://github.com/comfyanonymous/ComfyUI).
[lbouaraba/ComfyUI-Krea2Edit](https://github.com/lbouaraba/comfyui-krea2edit), Apache-2.0, the
identity-edit dual-conditioning recipe this reimplements.
[Jonseed/ComfyUI-Detail-Daemon](https://github.com/Jonseed/ComfyUI-Detail-Daemon), MIT, the
detail curve the rig's Detail Daemon dial re-implements.
[nova452/ComfyUI-ConditioningKrea2Rebalance](https://github.com/nova452/ComfyUI-ConditioningKrea2Rebalance)
and [huwhitememes/comfyui-krea2-conditioning](https://github.com/huwhitememes/comfyui-krea2-conditioning),
Apache-2.0, the per-layer rebalance mechanic and its RMS-renormalized variant.
[no8d/ComfyUI-NO8D-controls](https://github.com/no8d/ComfyUI-NO8D-controls), MIT, the LoRA-stack
row-list UI that inspired RedNode LoRA Stack, implemented independently here.
[skatardude10/ComfyUI-Optical-Realism](https://github.com/skatardude10/ComfyUI-Optical-Realism),
which I read as a survey of which optical effects were worth having while building the grading
chain. Loraholic for the Krea 2 zoom and colour temperature sliders the Camera LoRAs card drives.
ethanfel and ostris for the Krea 2 vision-conditioning recipes. Krea.ai for Krea 2, under
the Krea Community License.

Not affiliated with Krea.ai.
