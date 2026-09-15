RedNode Studio changelog

New versions go at the top. The release action reads the section matching the
pyproject version and puts it on the GitHub release, so the bold version line
format matters: **version** then a date, notes below until the next bold line.

**1.4.0** - 2026-09-14

The sampler learned some tricks, the Detailer grew four kinds of pass, the
Post tab became a list beside one editor, and a Draft switch makes a seed
cheap to judge.

### Workspace

- A Draft switch in the footer: on, the Detailer and the Post chain pass the
  picture through, so a queue is the base render alone; off again, the next
  queue renders the keeper in full
- Sampler dials per rig, folded on the rig card: AuraFlow shift, Detail Daemon
  (a sigma nudge over a step window), Seed Variance (a conditioning jitter for
  the first steps) and a densified tail (extra steps in the last part of the
  schedule). They ride the built-in sampler and every Detailer pass on the rig
- Three schedule shapes of the pack's own on the scheduler list: beta57,
  bong_tangent and hyperbolic. A stock KSampler on the scheduler socket is
  handed simple when a rig names one
- A rig and a step count per pass on the Latent and Img2Img tabs, and a
  continue mode that hands the second pass the first pass's leftover noise:
  the relay a HighNoise and LowNoise pair wants
- A Loader choice under the rig's diffusion model: by file name (a .gguf
  through ComfyUI-GGUF, anything else through core), or INT8 W8A8 through
  its pack's loader; the picker lists those packs' files beside core's
- Florence-2 (comfyui-florence2) as a fifth caption engine on every tab's
  Auto prompt, with one model folder and task shared by every tab; Describe
  To Boxes gains a Florence + Ollama engine
- A Rewrite button beside Auto sort on the Prompt Frame, with a style tag
  (keep, photoreal, cinematic, illustration): the boxes go through the Auto
  Prompt's Ollama model as a writer and come back for editing
- Save writes Civitai metadata with AutoV2 hashes, and plays a finish sound
  when asked
- The frame's camera segment is Off, Simple, Advanced: Off writes no camera
  sentence at all, shot size, height stop and studio paragraph alike, and
  the chips grey out. The Camera tab's switch now strips the studio's
  paragraph from the queued prompt too, not only the LoRAs and the path
- Saved snippets per section of the Prompt Frame: Style, Subject,
  Surroundings and Light and colour each save and load their own named
  pieces without touching the other boxes
- The frame's head line is two groups, Saved prompts (load and save the
  whole frame) and Tools (Auto sort, and Rewrite with a readable style
  choice); the placement box is a counted box like the others

### Studio Detailer

- A Blend bar beside Denoise on detailer passes: how much of the rendered
  crop goes back; Feather sits on the card beside it
- Free VRAM before a pass, a toggle on every card's header: every model
  ComfyUI holds is unloaded before the pass runs
- Tone lock, beside Repeat: the pass keeps its new detail and takes the tone
  of the picture as it arrived, skin hue held; the drift fix for a long chain
- The SeedVR2 upscale pass can aim at a region (SAM3's targets): the crop
  goes through the upscaler and back at its own size, the frame keeps its
  size. An out-of-memory halves the tiled VAE's tile and tries again
- A Tiled upscale pass through Ultimate SD Upscale: the rig's model and the
  pass's prompt over tiles, an upscale model first or a plain resize, opened
  on 6 steps of deis at 0.25 denoise with 1024 tiles padded 128
- A batch goes through each pass one frame at a time, so a camera path's
  shots each get their own detection and their own render

### Post FX

- The Post tab is a chain list beside one editor: the list says what is on
  and in what order, the editor shows the picked card's dials
- A Limit on every card: subject, background or a mask, with a feather
- A Mask card (the auto-mask source and its feather), a Match card (the
  picture's colour moved onto a reference, AdaIN or linear, with a skin
  hold) and a LUT card (.cube files from models/luts)
- A Relight card: a new key light over the depth map's relief, direction,
  height, strength, ambient, warmth, contact shadows, and the subject mask
  rounding the subject off

### Camera Studio

- Model and clip sockets through the stage, so it works in a plain graph;
  the sliders are applied per shot
- A duplicate button on subject cards

### Review and Stage View

- Up and down walk a batch in Image Review
- Stage View: the taps keep a chosen size, the picture fills the box, the
  wipe drags, a full screen room, and nothing drags out of the node

### Examples

- RedNode_Studio_Simple_Angles: the camera stage in a plain graph
- RedNode_Studio_Pro_Grade: the V1.3 graph with a heavy grading flow's
  settings on the pack's own controls

**1.3.0** - 2026-09-13

Watching the picture form, the Detailer as a proper list, and a handful of
things that only made one image when they should have made several.

### Live Preview

- RedNode Live Preview, a new node: wire the workspace's image output in and
  the picture forms on it step by step, with a bar and a "rendering 4 / 27"
  tag, then the finished frame. The frames are decoded by the pack itself with
  the small VAE from models/vae_approx (lighttaew2_1 for Krea 2), so it works
  whatever ComfyUI's own preview setting is. Wire the Detailer's output instead
  to watch its passes; unwired, it shows whatever is rendering
- The same frames land over the Paint tab's result pane while a paint run
  samples, and come off the moment the result does
- Every frame says which pass, round or shot it belongs to, and the Paint tab
  picks its own frame size, 512 up to the decoder's full output

### Image Review

- A full screen room: the corner glyph, a double-click or the right-click
  menu opens it, Esc closes it. The wheel zooms the picture about the pointer,
  a drag pans, the wheel over the strip scrolls the strip, arrows walk the
  history
- A batch column: a run that made several pictures shows them down the left
  edge, click to view, the count reads "2 of 4", and the right-click actions
  follow the picture that is up

### Studio Detailer

- Each pass card is a header and three boxes: Sampling, Strength and Prompt.
  Scale is a bar beside Denoise, and a duplicate button sits by the delete on
  passes and group titles
- Repeat above one offers a denoise and a scale per round with a Ramp, the
  same rule the Img2Img tab's passes follow
- A pass picks which Prompts-tab row it reads; the rig's row stays the default
- A SeedVR2 upscale pass: Size 720p, 1080p, 2K, 1440p or 4K as a pixel budget
  with the short edge worked out from the frame's aspect, the loader dials on
  the card, the pack's own nodes doing the work. Needs ComfyUI-SeedVR2 installed
- The SAM file and precision are picked on the node, and the per-pass SAM list
  now reads the V3 loader's choices, which had left it empty

### Workspace

- Img2Img RE-ANGLE: a switch to skip the i2i pass, so the re-shot picture is
  the output and the rig never enters VRAM beside the edit model
- Img2Img PASS: a full-width denoise bar in hundredths, a denoise per pass and
  a scale per pass with a Ramp, the decode tiled when it gets big
- A camera path on an engine rig, the NovelAI rig, renders one image per shot
  and batches them; before, it rendered shot 1 and said nothing. On the
  external sampler a path still renders shot 1 only, and the console, the
  Camera tab and the sampler-mode tip now say so
- Post FX: the depth estimator is a Depth card on the post panel, both the
  standalone node and the Post tab: which estimator, which Depth Anything V2
  checkpoint, and the working resolution
- Latent tab: refine passes on a blank canvas. Pass 1 generates at the full
  denoise and every pass after it refines what pass 1 made, at a Refine dial
  or a denoise and scale per pass, so the tab with no source image gets the
  draft-and-climb run the Img2Img tab has
- A rig can name a second sampler and scheduler that take over on image to
  image runs; blank means the main pair, so nothing moves unasked

### Video

- Video Review: the frame rate is a dial on the panel with the same presets
  as Save Video, a wired fps socket wins over it, and a workflow saved before
  the panel keeps the rate and loop it had. Sound and loop flip the player on
  screen instead of rebuilding it and dropping back to the start
- Save Video announces its clip as animated, so the file shows in ComfyUI's
  outputs instead of only on the console

### Example workflows

- RedNodeStudio_V1.3 replaces the 1.2 Ultima file: the whole rig with the
  Detailer's passes and the SeedVR2 upscale on the node, the Post FX chain,
  three Image Reviews and two Live Previews watching the render and the passes
- RedNode_MultiAngle replaces the earlier multi-angle file: the Camera Studio
  drives a Qwen-Image-Edit-2511 re-shoot, and Krea 2 finishes the frame

### Fixes worth naming

- The socket tuck sits on its own row above the tabs; it used to wrap onto a
  stray line between the tabs and the box once the Camera tab filled the width
- The README named the wrong folder for the SAM3 file; it is models/sam3
- A pass latent resizes by its rank rather than an assumed four dims

**1.2.0** - 2026-08-31

The workspace becomes the whole studio, and the studio grows a camera and a set
of lights. Everything below is in this release; the sections are grouped by what
they change rather than by the order they were written.

### The Camera Studio

- A top-view stage inside the Prompt Frame and on its own Camera tab: place
  people, objects, walls, doors and windows, point a camera at them, and the
  geometry is written as the physical-camera language Krea 2 obeys - position,
  pitch in degrees, what the subject shows the lens, what is behind them, the
  lens itself. A bare "high angle" gets reinterpreted; the stack does not
- Lock on a subject or aim freely; walls occlude what the lens cannot see; a
  centred foreground person is named as between the camera and the subject
- Auto latent: the frame's aspect follows the camera, at a pixel budget
- Sets: built-in rooms (kitchen, living room, bedroom, bathroom, apartment) and
  two-person scenes (conversations, confrontation, boxing, baseball), plus your
  own saved and deleted from the panel. Every built-in set ships a light rig
- Camera paths: A to B in N shots, or an orbit sweep. The workspace renders one
  image per shot in the built-in sampler, each with its own camera words and its
  own camera-LoRA strengths, and the images come back as a batch
- Scene focus: the stage fills the screen with the subjects card beside it, Esc
  closes. Drag keeps the grab point; the wheel over a thing turns it
- Aperture: with an f-number set, the depth of field is computed from lens,
  aperture and distance, and says who is sharp and who dissolves
- Camera LoRAs card: zoom, height, orbit and back, each off / auto / manual,
  auto strengths coming from the same geometry the words come from. Three of the
  four sliders are ours and are a separate download; the zoom slider is
  Loraholic's and only ever linked, never shipped
- RedNode Camera Multi-Angle turns the same stage into a Qwen-Image-Edit
  Multiple-Angles prompt, for re-shooting an existing photo from a new viewpoint
- A master on/off for the whole Camera tab: off, nothing on it reaches a render

### Lights

- Place lights on the stage like subjects: a ring sized by the real diameter,
  tinted by its colour, with a dashed line to whatever it is aimed at
- The sentence they write names a source, a direction and what it lands on,
  which is what the corpus study found gets obeyed. Hardness is real angular
  size, the key-to-fill ratio is inverse square, and named setups (Rembrandt,
  butterfly, split, rim, uplight, short, silhouette) come out of the geometry
- Exposure per light in stops, centred on 0, and colour from cold through
  neutral to warm, spaced in mireds. Moving a light dims it, as it should
- One-click rigs: three-point, Rembrandt, window, backlit
- Two optional lighting LoRA rows, off / auto / manual, driven by the rig you
  placed: brightness from the level your lights make, colour from the key
  light's temperature. Both files are third-party and only ever linked
- Style "Photo: nocturnal low-key" for the dark, velvety look that words alone
  fight for

### Swaps, sets and passes

- Img2Img SWAP stage: put the Subject's face, head or whole person onto the
  picture with Alissonerdx's BFS LoRAs on Qwen-Image-Edit, before the Krea 2
  pass finishes it. Face, head and person modes, the Picture order read off the
  file name
- The same author's Krea 2 BFS files run instead as a Detailer pass, on two new
  per-pass options: Picture (the frame, or a detailer's crop, as the base
  reference) and a per-pass LoRA that never touches the main render. Presets for
  both head and body swap
- Img2Img RE-ANGLE: the source re-shot from another viewpoint by
  Qwen-Image-Edit-2511 and the Multiple-Angles LoRA before the i2i pass, from
  the bands or from the Camera tab's own studio
- LoRA sets: the LoRAs tab is Main plus any number of named sets, each on its
  own tab, and a rig, a Detailer pass or the paint pass picks one by name
- Detailer: a working resolution on sampler passes as well as detailer ones

### NovelAI

- The NovelAI rig is public: a Models-tab rig kind that renders through your own
  NovelAI subscription instead of a checkpoint, with the site's own option set,
  vibe transfer and character prompts
- Vibe encoding is a button that says its price: 2 Anlas the first time for a
  picture, model and Information, then cached and free. Nothing spends Anlas on
  its own
- Your token lives in NAI_ACCESS_TOKEN or in the ComfyUI user directory, never
  in a workflow and never in the pack folder

### Fixes worth naming

- An experimental reference toggle that rewrites the reference path now
  announces itself in the console: ref_t0_modulation cost a day of hunting a
  doubled, ghosted identity that no LoRA and no model was causing
- The Img2Img tab lights its dot on a wired canvas, prompt boxes fill their
  pane, the LoRA stack's footer sits under the stack instead of the node's
  bottom edge, and the select-mode bar appears where the rows are

**1.2.0 (the workspace work, written 2026-08-13)**

The workspace becomes the whole studio. Models load inside it, prompts live with the
model they were written for, the sampler runs inside the node, and painting picks its
model from a list. A full render is one node, a review and a save; the new
RedNodeStudio_Simple workflow ships exactly that. Existing workflows keep working
unchanged, because every new socket is appended and every new system is an option: a
wired input always wins, and the rig fills what is empty.

- Models tab: named rigs, several kept, one active. Checkpoint or diffusion model, CLIP with type, VAE, each field a searchable picker with recents. A checkpoint's baked CLIP and VAE are used when the separate fields stay on None, and a line under the box says where each piece comes from
- Each rig carries its sampler settings, the five Sampler Config profile keys, out on typed sockets a stock KSampler accepts, plus a seed with Randomize
- Built-in sampler: comfy core's own KSampler and the VAE decode run inside the node, positive, negative and the finished image on outputs. External stays the default
- The rig's CLIP type decides the encode: krea2 runs the Studio identity system with references and edit masks; anything else encodes plain text, so an XL rig renders as XL instead of erroring
- Prompts tab: named prompts linked to rigs, the Krea 2 rows drawing the full Prompt Frame editor, one implementation shared with the node. Sections fold, rows fold, the prompt library saves your own next to the examples
- Auto prompts inject themselves: each image tab's auto prompt names a prompt and a Frame slot, and the caption lands there at queue time, always after the typed text. The caption out-and-back wiring is retired
- The workspace takes style_in, subject_in, surroundings_in and light_and_colour_in, the Frame's own vocabulary, for helper chains; they join the active prompt after the typed text
- Wildcards in the prompts resolve at queue time on the run seed, shared with the sampler: Randomize re-rolls picks and noise together, one number reproduces the whole render
- Painting: the Model choice lists the rigs, and picking one runs the paint pass inside the workspace, on the routed paint model with the Studio's conditioning, no render node needed. External chains stay on the list
- Paint LoRAs: its own tab in the paint column with the shared stack presets, two routings, paint overriding main. Unwired Paint Render and Paint Out both take the rig through whichever stack the routing names, model half and text half together
- Use as reference follows the model: a Krea 2 rig opens Subject, Scene and Moodboard for painting wherever the render runs
- Chaining: the Img2Img tab's canvas can be a wired image (any model to any model) or a wired latent (same model, no VAE round trip, from the new result_latent output), at the tab's own denoise
- The Img2Img tab works rig-only: the rig's VAE encodes the source, which previously required a wired VAE and silently ignored the image without one
- Image Review and Save tolerate an empty run, and Review grew a real images passthrough output
- Paint Out picks its rig by name, so two external chains each carry their own model
- RedNode Studio Detailer, new node: the post-render passes as a list you can read. Start, then sampler refines and SAM3 face detailers in whatever order, then End into the post process. Each pass names its rig and carries the full vocabulary: steps, CFG, sampler, scheduler, a start/end step window, a scale ratio for the shrink-and-regrow chains that invent detail, and a prompt that defaults to the rig's own Prompts-tab row. Settings left empty inherit the rig's. The detailers segment face, hair, hands and friends through ComfyUI-Easy-Sam3 with a visible SAM model choice, and say plainly when the pack is not installed

**1.1.0** - 2026-08-12

Four new nodes. Video gets the filing system the pictures already had, and prompting gets
a node that treats word order as the setting it actually is.

- RedNode Save Video files a sequence into the same tree RedNode Save uses: the same base folder, subfolder, name and numbering tokens, the same drafts and keepers split, and the same readable text record beside the file. mp4, webm, gif or animated webp
- Save Video takes an audio track, and the prompt that made the clip. Sound shorter than the picture either plays once or repeats to the end, which is the choice ping pong forces on it
- Encoding looks for the ffmpeg that imageio_ffmpeg brings with it, then ffmpeg on PATH, then Pillow for gif and webp. A machine with none of those files the frames as an image sequence rather than losing a render to a missing codec
- RedNode Video Review plays what the graph just made, in the node, with a scrubber, a loop toggle and the previous runs in a strip. It files nothing, so leave it wired while you iterate. Feed it the path output of Save Video and it plays the clip that was really written instead of encoding a lookalike of it
- RedNode Prompt Frame puts Subject and Surroundings in their own boxes and orders them by framing, five steps from Portrait to Roomscale. Your wording is never rewritten, only the order and the joining words. Style blocks, twenty lighting setups, a brightness ramp and placement sit around that, and a second output calls out what quietly costs a render: a self-lit style fighting the lighting dropdown, a wide framing with nowhere for the subject to stand, a prompt run past the 90 to 150 word working range
- RedNode Describe To Boxes reads a picture into Subject, Surroundings and Light and colour on a local Ollama vision model, ready to wire straight into the Frame. The vision model is released from VRAM as soon as the reply lands, so it does not sit on top of the checkpoint for the rest of the queue
- Paint tab: a Passes box on the denoise row runs that same low denoise over its own result up to ten times inside one Generate, with a fresh seed each pass and the mask reapplied between them. The settling chain without the dragging, and only the last picture comes back
- Prompt Box values stop moving when the workflow changes. The panel was taking a slot in the saved widget list, so the prompt loaded into the seed, "fixed" into the wildcard toggle and the font size into the colour. Values are written and read by name now, and a workflow saved while it was wrong repairs itself on load
- Prompt Frame had the same fault and worse: its panel is built a frame late, so every load shifted Subject into Surroundings. Same fix
- Prompt Frame: a Push option under the Framing slider, off by default, for when a long prompt talks over the framing. Restate at the end repeats the shot as a closing sentence so the framing holds the end of the prompt as well as the front; Camera words swaps "small in the distance" for the label a caption would use, like "extreme long shot"
- Prompt Frame: the light conflict warning now also reads style text arriving on the wire, which is where a moodboard block lands and exactly where it never looked
- Prompt Frame: a tools fold like the Prompt Box has, so the seed, wildcard, font and colour rows tuck away under the panel. The text boxes also come back at whatever height you dragged them to
- Grabber: click the channel field and type to search, the same picker the LoRA rows use. Channels say how many values they carry, recently used ones come first, and a name that matches nothing is offered as a new channel
- The channel picker no longer filters by the name it already shows, which made the list a single entry of the thing you already had
- The example workflow ships as Rednode Ultima V1.1.0
- The README covers the prompt frame, and the node count on it is right again

**1.0.37** - 2026-08-04

- The registry listing carries the RedNode logo instead of the placeholder gradient

**1.0.36** - 2026-08-04

Speed and polish, plus the first documentation pass.

- Thumbnails are served resized instead of full size, in the Review strip, the Save grid and the Workspace galleries. Large galleries and big pictures load far lighter
- Save browser: clicking a card no longer flashes blank or jumps the view
- README: nine screenshots, so the panel can be seen before installing
- The example workflow ships as Rednode_Ultima_V1.0.36 Release
- Use as reference: the renderer choice is repaired before the buttons read it, so they cannot briefly look enabled after a renderer is deleted and recreated
- Patch notes now ride every release automatically, which is why this list exists

**1.0.35** - 2026-08-03

Bug fix patch for the Masks redesign and the Paint tab.

- Masks: undo and redo now save the mask, so a queue renders exactly what the canvas shows
- Masks: changing the Paint on picture drops the previous picture's mask instead of carrying it over
- Masks: Open image works now, and a picture of your own survives a reload
- Masks: an auto mask base coat survives a panel rebuild instead of silently vanishing on the next save
- Paint Out: the Never shrink setting now works on external renderer chains, as it already did on Paint Render
- Whole frame: the Mask size dial works in both directions. A 3K picture with the dial at 1024 renders at 1024 and comes back at 1024, so a big frame can be painted at a working size and upscaled after
- Overlay colour and opacity changes repaint open Masks painters immediately
- Rendered by: a chain named Krea2 Workspace shows a warning that the main prompt renders and the paint prompt boxes are ignored
- Use as reference greys out on renderer chains that cannot carry references, with the reason on hover
- The registry's Documentation link no longer points at a folder that does not exist

**1.0.2** - 2026-08-02

README corrections. Versions before the changelog existed; see the commit log.

**1.0.1** - 2026-08-02

First registry patch. See the commit log.

**1.0.0** - 2026-08-01

First registry release of RedNode Studio.
