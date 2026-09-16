RedNode Studio changelog

New versions go at the top. The release action reads the section matching the
pyproject version and puts it on the GitHub release, so the bold version line
format matters: **version** then a date, notes below until the next bold line.

**1.4.0** - 2026-09-14

The sampler learned some tricks, the Detailer grew four kinds of pass, the
Post tab became a list beside one editor, and a Draft switch makes a seed
cheap to judge.

### Previews

- Live Preview saves and shows its finished frame at 512 px instead of the full
  picture, and keeps only its latest file in the temp folder. Several Live
  Previews showing full-size pictures made the whole canvas lag while panning,
  and every run left another full-size PNG behind until ComfyUI restarted
- Image Review loads its big picture on the node at 768 px (512 or 1024 in the
  settings) and the original only in full screen. It keeps a set number of
  pictures, 24 by default, counting every frame of a batch, and deletes its own
  older preview files from the temp folder to the same number. Files a Save node
  wrote are never touched
- Either preview node can show its picture at full size instead, chosen per node
  from its right-click menu: Show the full-size preview on Live Preview (the run
  then saves the whole frame), Show the full-size picture on the node on Image
  Review

### Rigs

- A rig made of your own nodes, three nodes that share the rig's name.
  RedNode Rig Model takes your loaders and hands back the model, CLIP and VAE
  with the Workspace's LoRAs and camera LoRAs for that rig applied. RedNode Rig
  Inputs hands your sampler the positive, negative, latent, seed, steps, CFG,
  sampler, scheduler, denoise, start step and end step, with the cameras and,
  on a Krea 2 rig, the Subject and Scene references. RedNode Rig Result
  takes the finished latent or picture
- On the Models tab a rig of kind Your own nodes names those nodes, and has no
  built-in sampler settings of its own. The main render, every Latent and
  Img2Img pass, the paint pass and every Detailer pass on that rig sample
  through your nodes, each with its own values, and the result carries on to
  the Detailer, Post FX and Save. A KSampler between them renders pixel for
  pixel what the built-in sampler does. The Tiled upscale pass keeps its own
  sampler
- No wires to the Workspace or the Detailer, and as many rigs as you like: when
  you queue, the page links in only the Rig Model nodes a rig in use names, so
  an unused rig never runs and never loads its models. An Add the rig nodes
  button puts all three on the canvas with the rig's name
- A rig per pass can be another model family: Z-Image drafting and Krea 2
  finishing, or the other way round, straight from the Latent or Img2Img tab.
  A pass on a rig with another text encoder encodes the prompts again with
  it (Krea 2 style on a Krea 2 rig, a plain encode otherwise), and a pass on
  a rig with another VAE decodes the latent with the last rig's VAE and
  encodes it with its own. The picture is decoded with the last pass's VAE.
  Rigs that share the same files still hand the latent straight over

### Workspace

- The Img2Img tab is six sub-tabs: Source, Passes, Auto prompt, Re-angle, Swap
  and Converter, each with a light showing whether that section is on, over a
  status bar with the tab's switch, the picture count, the passes and the
  engines in use. Source is one gallery with its canvas, collection and thumb
  size on a toolbar, and a strip under it naming the chosen picture with its
  size. Passes has a setup column (the pass kind, the count, which settings
  vary per pass, and the values every pass shares) beside one card per pass
  holding only the settings that vary, with Ramp Up and Down for each one.
  With Re-angle's Skip the pass on, the Source and Passes lights turn amber and
  the Passes tab says the passes are skipped. A Reset button puts every pass's
  denoise, scale and steps back to the defaults, and a pass's steps start at
  the main rig's step count
- Subject, Scene and Masks are one Krea 2 Identity tab with a sub-tab each,
  the same strip of lights and status bar as Img2Img, so the top bar is four
  tabs shorter. A workflow saved on one of the old tabs opens on its sub-tab
- People merged into Subject: one gallery where a click adds the next person
  and takes one out again, numbered in order with the first as the main
  subject, a Make this the main subject menu choice, and a warning past three
  people. A workflow with Person 2 or 3 on its own gallery has that picture
  added to the Subject gallery on load. Swap's reference reads Main subject,
  Person 2 and Person 3 from the same list
- Subject and Scene each have Gallery, Boosts, Auto prompt and Converter tabs.
  The Subject boosts now apply to every person: extra people used to take the
  Scene fidelity. With extra people and no Scene picture, the main subject
  is now the last reference, where the boost and the boost mask aim; before,
  those landed on the last extra person
- The Subject auto prompt has a People card: a row per picked person with a
  name box, its own switch (the main subject on by default), a Generate
  button and that person's latest caption. Captions for several people are
  joined under their names, "Person 2" where none is given
- The Subject's Auto prompt reads in the order it runs: People, the engines,
  Each person's caption (how the engines combine for one person), then the
  Combined prompt at the end. The Combined prompt shows the people's captions
  joined as the queue will send them before any queue has run. Both steps
  carry a small flow of what goes in, how it is joined and what comes out:
  the engines that are on, Append or Blend, one caption per person; then the
  people by name, Joined or Rewrite with Ollama, into the prompt row
- Rewrite into the prompt with these names, in the Combined prompt: at queue
  time Ollama merges the prompt row named under Inject into with the people's
  captions, using the names. Preview rewrite asks for it now and shows it; the
  queue reuses that answer while the text and people stay the same, and Fresh
  asks again every queue. Without an answer the captions are appended
- Subject captions keep to the person's traits. The instruction asks for the
  face, hair, skin, build, expression, clothing and accessories and leaves out
  the background, lighting, camera, framing and pose, and every subject
  caption (Florence and the taggers included, and captions saved before) is
  cut at use: sentences about the place, the light or the shot go, a mixed
  sentence keeps its clauses about the person, and "No nudity" style lines go
- Inject into has a Before my words / After my words choice on every tab: an
  injected caption can lead the words already typed in its slot instead of
  following them. After is the default, as before
- Subject Boosts has one-click presets above the dials, each with a plain
  description: Balanced (the default), Strong likeness, Prompt first (the
  lightest on VRAM), Pose only and Several people. A preset sets every
  subject dial at once and switches the dials on; the dials stay editable,
  and the row reads Custom once they no longer match
- Scene, Img2Img and Moodboard auto prompts have a Picture card at the top:
  the picture being captioned, its name, a Generate button that captions it
  now, and its latest caption
- The Scene's Picture card chooses what the scene gives: Background (the
  place, people left out), Situation (what is happening: the activity and
  where the people are, nobody's looks described, a new caption mode) or
  Style (only the look). It replaces the View / Style dropdown
- Scene Boosts has presets for Scene fidelity too: Loose (0.5, the place is a
  hint), Normal (1.0, the default and lightest), Close (2.0) and Copy the
  scene (3.2)
- The Prompt Converter's labels and choices start with a capital
- A Reset button on the Latent status bar puts back a square 1024 canvas,
  batch 1, random off and a single pass with nothing varied per pass
- The Latent tab is two sub-tabs, Canvas and Passes, with the same lights and
  status bar. Canvas keeps the aspect buttons and the drag-to-reshape preview,
  with a dashed 1024 square behind it for scale, and the Size card now carries
  the latent grid, megapixels and VRAM estimate. Passes is the Img2Img pass
  layout: pass 1 is marked Generate and the rest Refine, and the Refine dial
  is the shared denoise for passes 2 and on
- Every Auto prompt box lists its engines on the left and shows the picked
  engine's own settings beside them, then the settings every engine shares and
  the result. The settings cog is gone; picking an engine is how its settings
  open
- The engines list lightest first (CLIP gen, WD14, Florence, Ollama, QwenVL,
  JoyCaption), each with a rough VRAM figure and a total for the ones switched
  on. Ollama's comes from the picked model's size
- Low VRAM captioning, a switch shared by every tab and off by default:
  the main model is unloaded before the engines caption, and every engine
  (Ollama and JoyCaption included) is unloaded before the sampler loads the
  model again. Slower, but the captioners and the model never share the card
- The Prompt Converter has its own on switch in its header, so it reads as on
  or off at a glance. Off passes the prompt through untouched and keeps the
  settings; workflows saved before it load with the converter on
- A switched-off tab lights nothing underneath it: its Auto prompt, Boosts,
  Converter, Re-angle and Swap lights go dark and those pages say the tab is
  off and nothing on them is used
- The footer keeps only the UI size and the presets cog (Draft and the VRAM
  limit are on the Run tab). Resize
  long edge, Studio preset and the workspace presets (with Save as and
  Delete) move to a Workspace card at the top of the Advanced tab
- An auto prompt injected into an unnamed prompt row now lands: the server
  names unnamed rows Prompt 1, Prompt 2 and on, as the Inject into list does,
  so a row with an empty box still gets its caption. The No prompt warning
  counts a row an auto prompt feeds, and turning the camera words off no
  longer rebuilds a frame row without its injected captions
- The camera switch on a prompt's Frame keeps Off after the panel redraws, and
  reads Off while the Camera tab has cameras switched off. Picking Simple or
  Advanced there turns the cameras back on
- The Camera tab's master switch sits on its own card, bigger, with CAMERAS ON
  or CAMERAS OFF written beside it
- Switching a Plain box to a Krea 2 box keeps the typed prompt: the words move
  into Subject when the Frame's boxes are empty
- The Scene and Subject galleries no longer say the canvas comes from a wired
  input. Only Img2Img has that choice; the other tabs show the chosen picture
- The Moodboard tab uses sub-tabs like Krea 2 Identity: Gallery, Boosts and
  Auto prompt, with a status bar for the batch, what it takes and the strength.
  Boosts has six presets (A hint, Balanced, Strong look, Look no layout, Outfit
  transfer, Copy the layout). Transfer and Reference processing are button
  switches in plain words, and each dial says what its current value does.
  Boost blocks on Subject is a button switch too
- The painted Edit mask is gone from the Masks page. The Paint tab does
  in-place edits, with a denoise. A painted edit mask in an older workflow is
  ignored; a MASK wired into edit_mask_in still goes out with its latent. The
  Subject boost mask card opens by itself
- The Moodboard's auto prompt captions every picture in the batch, not only the
  first. Its Pictures card has a row per picture with Style, Subject and
  Situation switches (any mix; Style by default), a Generate button that
  captions each one that is on, and a caption per switch. The captions join as
  the style lines, then the subject lines, then the situation lines. A picture
  with every switch off is left out of the caption and still styles the render
- Combine and Style lock are labelled button switches with a line saying what
  the pick does. Combine reads Append or Blend with Ollama
- A Krea 2 rig has an Official Krea 2 model switch on the Models tab. Until it
  is set, a model file with "official" in its name counts as official. When
  Subject or Scene has pictures and the render's rig is not official, the Krea 2
  Identity tab and the console warn that faces rarely land on community mixes
- The Moodboard injects each read into its own Frame slot: Style captions as
  Style, Subject as Subject, Situation as Surroundings, each changeable under
  Inject into. Every tab's Inject into can pick As Style too
- Scene has its own window, Scene from and Scene until on its Boosts page:
  outside it only the Scene picture leaves the render, and the subject keeps its
  own timing. A Layout only preset (the scene leaves after the first 35% of the
  steps) leads the Scene presets, and Loose now also ends the scene at 60%
- Scene reaches the render as Picture and words, or Words only: the picture is
  captioned but not sent as a reference, the gentlest way to put a person into
  a place. The status bar says so, and the page warns when Words only has no
  auto prompt injected to carry it
- Boosts off stops a Subject or Scene fidelity above 1.0 but keeps one below it,
  so Loose works with Boosts off. A fidelity below 1.0 still builds the bias
  matrix, and the console says so
- Img2Img's Auto prompt has two tabs: I2I prompt (the source picture's caption,
  as before) and Image to text. Image to text has Style, Subject and Scene side
  tabs, each with its own gallery and auto prompt: every picked picture is
  described and the words join the chosen prompt (Style, Subject and
  Surroundings by default). The pictures never reach the model, so it works on
  any rig, and it runs with the Img2Img tab switched off. Scene reads the
  Background or the Situation. Right-click Send to reaches all three. Each side
  tab's own switch runs its auto prompt; there is no second switch
- The Florence auto prompt uses comfyui-florence2's own nodes even when another
  installed pack registers Florence2ModelLoader under the same name. Such a copy
  runs Florence on the older transformers path, which on current transformers
  captions nothing but a line of <s> tokens. The console says when a copy is
  being passed over, and when Florence returns no words
- A Run tab: Generate queues the workflow beside Full or Draft and the VRAM
  limit, with the run number, seed and time. A box per stage (captions,
  encode, each pass, decode, Detailer, Post FX, Save) shows Waiting, the step
  it is on, Done with its time, Skipped with the reason, or Failed. The picture
  forming shows beside a VRAM chart with model loads and unloads marked, the
  card's size dashed, and the models on the card now; a log says what is
  happening in plain words (captions made, models loaded and freed, a pass on
  another model family). The server sends these as rednode.run_stage events.
  The VRAM chart has a GB scale, times, the peak and the latest value marked,
  and with the VRAM limit on Low or Medium a line at the card that limit suits
  (16 or 24 GB); the line under the chart says when a run went over it
- The Run tab's live picture shows the finished picture once a run is done:
  what RedNode Save filed, else what Image Review or Live Preview showed, else
  any preview. The Run tab has Run, Review and Stages sub-tabs. Review is the
  Image Review panel holding every finished picture from this Workspace's runs
  (copy, open the folder, run again); Stages is the Stage View panel with the
  last run's taps and the compare wipe. Both panels can now be hosted outside
  their own nodes
- The Workspace has its own stage taps, switched on from the Run tab's Stages
  sub-tab: References, Img2Img source, Re-angle, Swap, Each pass (drawn by the
  small preview decoder, no extra VAE decode) and Final picture, each on or off,
  at a chosen size. The same card switches each Detailer's taps and counts the
  Stage Tap nodes in the workflow
- Hold under it, beside the VRAM limit on Low or Medium: ComfyUI keeps the card
  past 16 or 24 GB free for the run (its --reserve-vram setting), so a model
  that does not fit loads in part, and the text encoder leaves the card before
  sampling. Slower, and it stays near the line. Off puts ComfyUI's own reserve
  back on the next run
- The Run tab's log says a model loaded once it holds a real share of the card
  (no more "loaded (0.0 GB)"), and the limit's label on the chart sits on the
  left, clear of the latest value
- The Run tab says which rigs a run used: loaded from disk with how long it took
  (a Load box in the pipeline too), already in RAM, or dropped from RAM to make
  room. The card list names each model's rig ("Krea 2 · Rig 2") and leaves out
  anything under 50 MB. The VRAM chart is taller, and its labels keep clear of
  each other
- Hold under it reaches the Detailer: before each Detailer pass samples, the
  text encoder leaves the card. Holding now unloads only the text encoders, so
  the diffusion model is not reloaded for every pass
- The Workspace's Post tab has an on and off switch. Off, RedNode Post Process
  passes the picture through and the cards keep their settings
- The Workspace runs the Detailer, Post FX and the save itself. A Detailer tab
  (between Krea 2 Identity and Post) holds the RedNode Studio Detailer's own
  panel with an on and off switch; the Run tab's Save sub-tab holds RedNode
  Save's panel with its own switch. After the render the Workspace runs the
  passes, then the Post chain, then files the picture, and its image output is
  the finished picture, so one node is a whole workflow. A Detailer, Post
  Process or Save node already after the Workspace passes the picture through
  when the Workspace did that step, so nothing runs twice. The Run tab plans and
  times these steps either way
- The VRAM limit is your card's size: 8, 12, 16 or 24 GB, or Free range. A run
  is kept half a GB under it (15.5 on a 16 GB card), 8, 12 and 16 GB hold the
  dials to the old Low ceilings and 24 GB to Medium, and a workflow saved with
  Low or Medium opens as 16 or 24 GB. Hold is Auto, On or Off: Auto estimates
  the run's peak from the model files it will load and the size it works at,
  and holds only when that is over the limit, so a run that fits keeps its
  speed. The Run tab shows the estimate with its parts and what Hold will do;
  the log says it again when the run starts
- Generate works before anything has been queued since ComfyUI started. An
  engine with a progress bar (Florence among them) used to fail on "no attribute
  last_prompt_id" and return no caption
- JoyCaption's caption is its caption again: the advanced node returns the
  question it was asked first and the caption second, and the auto prompt was
  reading the question. JoyCaption captions saved before this are not reused,
  and a model load error is said in the console instead of becoming the caption
- A new Workspace starts ready to render: the built-in sampler, and the latent
  on at a square 1024. Loaded workflows keep what they saved
- A new rig is named Rig 1, Rig 2 and so on, and an unnamed rig in an older
  workflow reads the same way. A prompt linked to an unnamed rig used to be
  skipped without a word, so the render ignored its prompt
- When the Workspace renders nothing, the run stops with the reason instead of
  finishing quietly: External sampler chosen, no rig, no model, a model that
  failed to load, no CLIP, a failed encode or sample (with a pointer at the CLIP
  type when that is the likely cause), or no VAE. The Models tab lists the same
  problems at the top before a queue, and the Models and Prompts tabs show a red
  dot while something is missing
- A Draft switch (Full or Draft on the Run tab): on, the Detailer and the Post chain pass the
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
- Switches show both words: the Latent tab's source, the rig kind on the
  Models tab, a prompt row's box kind, the auto prompt's Reuse / Fresh, the
  Img2Img pass kind, the Paint seed and region floor are all segments with
  the live word filled, like the Canvas row
- Generate on the Paint tab with Paint switched off says so instead of
  rendering a blank canvas

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

- Seventeen looks ship with the pack, each with a picture of what it does:
  Pro Grade starting points for Krea 2 and Z-Image, natural photo, soft and
  Portra portraits, beauty editorial, clean and dark luxury product grades,
  warm food, teal and orange, Cinestill night, low key, faded 70s print, 90s
  Polaroid, disposable flash, early digital compact and black and white.
  Saved effects has Mine and Shipped tabs; a shipped look can be applied and
  copied but never renamed, overwritten or deleted
- Highlights on the Colour card leave pure white and mid grey where they
  are, so recovering the bright end never greys a white background
- The Post tab is a chain list beside one editor: the list says what is on
  and in what order, the editor shows the picked card's dials
- A Limit on every card: subject, background or a mask, with a feather
- A Mask card (the auto-mask source and its feather), a Match card (the
  picture's colour moved onto a reference, AdaIN or linear, with a skin
  hold) and a LUT card (.cube files from models/luts). Drop a picture onto
  the Match card to use it as the reference, or pick the Moodboard, Subject,
  Scene or Img2Img tab, or the wired input; each Match reads its own
- A Relight card: a new key light over the depth map's relief, direction,
  height, strength, ambient, warmth, contact shadows, and the subject mask
  rounding the subject off
- The chain is yours to order. The Post tab has two views: Effects, the
  list beside one editor as before, with an Additional row that adds any
  effect to the end of the chain; and Order, the effects that are on as a
  row of numbered cards you drag about, where an effect is doubled in place
  or taken out, and Camera order puts everything back. Under the cards an
  order-at-a-glance map of small coloured squares jumps to a card when
  clicked; right-click a card or a square to type the place it should take.
  Saved orders keep the run order alone, apart from looks: applying one
  moves the effects it names and skips the rest.
- A Skin card: retouching that only lands on skin. The mask is built in Lab
  from colour, minus eyes, teeth, lips and fine detail, minus printed
  pattern, and cut to the subject mask when the chain has one; Show the mask
  puts it on screen. De-yellow, rosy, skin saturation, brightness with a
  highlight guard, shadow lift, evenness, and smoothing with a texture dial,
  all starting at 0
- Denoise gains a strength dial and Grain a softness dial
- A Film stock card between Halation and Highlight roll-off: twelve stock
  looks (colour negative, slide, tungsten cinema, instant and three black and
  white) as a characteristic curve with base fog and shadow and highlight
  colour, Wratten filters for the black and white stocks, strength and fade
- The Colour card grows into a full grade: exposure in stops, shadows,
  highlights, local HDR, lift, gamma and gain, vibrance that holds skin, and
  split tone, in headed groups. Temperature and tint now put the frame's
  brightness back, so a saved grade with a non-zero temperature reads about
  3 percent different at mid grey
- Auto white balance: a Measure button on the Colour card reads the last
  frame the chain was given with one of four estimators and writes the
  answer into Temperature and Tint
- A lens picker on Lens distortion: ten named lenses fill the distortion and
  chromatic aberration dials at once, every dial still editable, and both
  cards can size their pixel amounts against the frame so a lens reads the
  same at 1024 as at 4K
- A Detail band mode on Sharpen: a guided-filter base, the detail layer
  soft-clipped so halos stop growing as the amount rises, a noise gate so AI
  skin grain does not become speckles, and shadow, highlight, hair edge and
  skin protection
- Vignette gains a falloff law (the smooth band, or the natural cosine to the
  fourth that real glass follows), a roundness dial from the frame's oval to a
  true circle, and a ring colour that lands in the falloff only and tints
  without darkening
- The Post tab says when a model is missing. Depth of field, haze and
  Relight carry a depth chip that reads No depth model when no estimator is
  installed, and a card limited to the subject or background reads No mask
  model without a segmenter; each links to its settings card, which lists
  what is installed, where the weights live and what to install. An effect
  that is on without its model gets a warning mark in the list
- Clicking in the Post list no longer makes it jump: the list keeps its
  scroll position through every click Every effect always
  stays in the chain and only switches on or off; the extra copies you add
  are the ones that can be deleted. An effect can be in the chain more than once,
  each instance with its own dials and Limit, so a sharpen can work the
  subject early and the whole frame at the end. Saved chains render exactly
  as before

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
