RedNode Studio changelog

New versions go at the top. The release action reads the section matching the
pyproject version and puts it on the GitHub release, so the bold version line
format matters: **version** then a date, notes below until the next bold line.

**1.5.1** - 2026-09-23

### New

- RedNode Shelf: a place to put pictures while you move them around. Drop them on, drag
  them off onto any gallery, the Paint pane, another shelf or a folder on your desktop,
  and right-click one to send it straight to a Workspace tab. Dragging out copies, so
  nothing leaves the shelf until you take it off. The picture picked on it also comes out
  of an image socket, which makes it a Load Image you can drag out of
- AI tab: pictures to words on a page of its own, with its own gallery saved with the
  workflow. Picture captions the one you picked with the same engines the rest of the pack
  uses; Batch captions every picture on the page and writes each caption beside its own
  picture as a .txt, which is the layout a LoRA trainer expects. The Img2Img tab keeps its
  own Auto prompt
- Image to Text, a Detailer pass that renders nothing: it reads the picture at its place in
  the chain and hands those words to the passes after it, so a chain that has already
  changed the picture can describe what it has. It reads the picture arriving at the pass
  or the AI tab's picked one, with the AI tab's engines or its own, and the words typed on
  its card are combined with what it read. A pass can take them by its Prompt picker: the
  last Image to Text, or a named one. Nothing of this reaches the metadata, which still
  carries the prompt the run was asked for
- What's happening says Prompt completed once an Image to Text pass has read the picture,
  and that line opens the whole prompt it wrote in a box you can select from, with Copy.
  It stays with the run, so a run reopened from the column still holds its words
- Every page opens with the same bar: the page's own tabs in the middle, Generate on the
  right, the page's name and its line underneath. Paint keeps its tool bar. The bar holds
  its size whatever Page size is set to
- The rail lists the open tab's pages under it, with the light each page carries, and the
  Krea 2 Identity tab goes one level further. Advanced has Pages on the rail, on by
  default, and Generate on the rail, off by default now that every page header carries one
- Every LoRA set has a switch of its own, not only Main. Off, whoever picks that set renders raw
  and the set keeps its rows for when it is switched back on. The LoRAs page's title sits in the
  middle under the set tabs, and so does every other page's title and its line
- The Run tab is three pages: Live, Review and Save. The Stages page sits under Review now, so
  one page holds the run's finished pictures and what the taps photographed on the way; a
  workflow saved on the old Stages page opens on Review. The first page is Live rather than a
  second Run
- The rail follows a run. The tab whose stage is running pulses red, the tabs whose stages have
  finished wear a green ring, and the open tab's own page rows do the same, so where the run is
  can be read from any tab rather than only from the Run page's pipeline
- The Run page keeps this session's runs in a column of pictures down its left, click one
  to open it again. The finished picture and every thumbnail drag out onto the Paint pane
  or into a folder, and a Raw / Before Post / After Post switch appears for a run that kept
  more than one version
- The Latent tab's Scale reads in 1024s: 1.00 is 1024 x 1024, 1.50 is 1536 x 1536, with
  Quick sizes from 1024 to 2048 in quarter steps
- Realism is a Detailer pass now, so an illustration can become a photograph in the middle of a
  chain and every pass after it works on the photograph. The recipe stays on the Editor's Realism
  page and the card carries what is worth changing per pass: the engine, the photo finish, the
  conversion LoRA and its strength, which LoRA set runs under it, and the words it is asked for.
  It also has a Denoise bar, which that page does not: 1.00 converts as the page does, and below
  that the picture is the starting point and only part of it is rewritten, so the original's own
  texture survives. Blend mixes the conversion back over the picture it came from for no extra
  render. No scale on this one: it converts at the frame's own size, snapped to 16 rather than
  the workflow's 512, so nothing is cropped away, and the frame comes back the size it arrived
- The Editor's Realism page picks which LoRA set runs under the conversion, rather than only
  whether one does. The switch had no picker beside it, so every conversion ran whatever the
  rig pointed at, which is Main unless a rig names another: the first set on the tab, for
  anyone who never set one. A line under the picker names the set that will actually run and
  how many LoRAs are in it, and the page's summary names it too
- Delete takes a picture off the Shelf, the one you are pointing at, leaving the file on
  disk exactly where it was. An empty shelf passes Delete on to ComfyUI, which is how the
  node itself is still removed with the pointer over its panel
- Copy and paste on the Shelf. Ctrl+C puts the picture you are pointing at on the system
  clipboard at full size, and Ctrl+V over the shelf takes a copied picture or a screenshot and
  puts it on top. The shelf under the pointer is the one the keys drive, a prompt box you are
  typing in keeps its own copy and paste, and a clipboard with no picture in it passes straight
  through to ComfyUI
- The Shelf can be the picture. Its new Override switch hands the picture picked on it to the
  tabs you tick (Img2Img, Editor, Subject, Scene, Moodboard) in place of what their galleries
  hold, and switches those tabs on for the run. Nothing is written into the Workspace, so
  switching it off gives every tab its own picture back; drop a new picture on the shelf and
  the next run uses that one. Only one shelf can hold it: turning it on anywhere turns it off
  everywhere else, and a workflow that arrives with two on runs the one switched on last, or
  stops and says so if they cannot be told apart
- Img2Img's Source page carries Denoise and Scale right under the picture, at one pass.
  Two passes and up vary these per pass on the Passes tab instead, so the quick pair steps
  aside once there is more than one

### Fixes

- The finished picture reaches ComfyUI's media assets, queue and history again. Silencing
  core's previewer had left the run with no standard images key
- Paint and Upscale runs no longer fire the Editor's Realism, Re-angle and Swap stages
- ComfyUI's keyboard shortcuts work with the pointer over the panel. Only keys going into a
  box you are typing in are held back, and Delete and Backspace stay blocked everywhere on
  the panel, since the panel's own node is the selected one
- The Workspace shows a loading screen from its first frame. The panel's shell goes up the
  moment the frontend can hold it, with a spinner and a status line, and the panel builds
  into it as soon as its widget and lists are there, retrying for as long as a slow first load
  can take. A node can no longer come up as a black box with its sockets and the config JSON
  showing; if the panel truly cannot build, the screen says why and offers Try again
- A panel that fails to build is retried and comes back; clicking a bare node builds it
  again, and a page that throws says so with a Try again instead of leaving a black
  rectangle
- A caption that outlives the config it started on is dropped rather than replacing the
  Paint prompt that is there now
- The Paint tab's LoRA column scrolls inside itself instead of stretching the whole page
- A Hero Creator redesign is filed beside its headshot
- Image to image honours its denoise on a rig that runs your own nodes. That rig kind was
  being read as an engine rig, whose own strength dial speaks for the denoise socket, so
  it handed over a 1.0 nobody set and every i2i pass came out as a full repaint. External
  and handled engine rigs keep their strength dial, which is theirs to set
- The Run page's full-screen view follows the run. Opened on a live frame it shows each newer
  frame at most of the screen's height, and when the run finishes the finished picture takes
  over at its own size, instead of the view staying on the small frame until it was closed and
  opened again
- The Save tab's raw output is the model's own render again: the copy is taken before the
  Editor's edits on the render, the Detailer and Post FX. It was taken after Re-angle, Realism
  and Swap had run, so a raw copy could carry a converted or swapped picture
- A brand new Workspace no longer warns that its converter does nothing
- The Realism page's conversion LoRA dropdown stays inside its card
- A picture kept in a folder you junctioned or linked into ComfyUI's output, input or temp
  folder loads again. It resolves onto another drive, which newer cores refuse, so a
  picture you could see in a gallery and drag around came back as "not in the ComfyUI input
  folder any more" when the run reached it. A name that climbs out of a folder is still
  refused, and the message now names the folder it actually looked in

- The two Pro Grade looks are now Camera Ready Krea 2 and Camera Ready Z-Image. Same
  dials, same pictures, new names. A saved copy you made under the old name is your own
  and is left alone
- Camera Ready Krea 2, the shipped look, was smoothing more than it needed to. Noise cleanup
  drops from 0.75 to 0.65, the skin pass eases back about a seventh, and the local contrast
  pass comes off. Pores and fabric survive it now. The colour trim is unchanged, and the
  other sixteen looks are untouched

**1.5.0** - 2026-09-22

The Workspace gets a new layout and four new jobs: an Editor tab, an Upscale page, Realism
and the Hero Creator. Qwen Image 2.1 runs as a rig, released 20 September and working here
two days later. The RedNode Studio template is now V1.5.

### New

- A tab rail replaces the tab strip: grouped, with an icon and a light per tab. It folds to
  icons only, drags wider or narrower, and sits on either side of the pages. Right-click a
  tab to switch it on or off, or to hide it. UI presets pick the tabs for the job (All,
  Basic, New image, Image to image, Edit, Paint, Finishing), and your own save on Advanced.
  A full screen button and a red Generate sit at its head; an Advanced switch, off by
  default, makes Generate open the Run page
- Editor tab: Source, Upscale, Realism, Re-angle, Swap and Converter, with its own source
  gallery. One choice on Source sends Re-angle, Realism and Swap to the gallery picture or
  to the new render, so a render can be turned into a photograph in the same queue. The
  edited picture is the image output
- Realism turns an illustration into a photograph. The Exact engine is the Anything2Real
  workflow node for node, with an optional photo finish and the Ostris encoder; the
  Alternative engine is the pack's own and needs no other pack. The conversion LoRA is found
  among your files by name and hash
- Upscale: SeedVR2, VOSR 2.0 or the tiled upscale on one picture or a folder, with a fit
  step first and a before and after in the result
- Hero Creator, on the Krea 2 Identity tab: a clean front-on headshot out of any gallery
  picture, cropped above the clothing, which can be redesigned with a render and sent back
  to the gallery as a subject
- Models tab: rig cards in a column, and Model, CLIP, VAE, Sampling, Seed and Setup pages.
  Setup makes a rig in one click for Krea 2 Turbo, Z-Image Turbo, Qwen Image 2.1, Anima
  (Nova Anime AM included) or SDXL / Illustrious / Pony from the files in your folders. Set and Missing badges on each file
  card, one Next step in the warning bar, and Match CLIP type from the text encoder file
- Seed page: link each part of a run (Re-angle, Realism, Swap, Upscale, Detailer, LoRA
  ranges, Post's random ranges, the auto prompt) to the main seed, a named seed or its own,
  and a Same seed every pass switch
- A rig can sample through another pack's sampler node, starting with RES4LYF's
  ClownsharKSampler
- Prompts no longer belong to rigs: the chosen row renders on whichever rig is active, and a
  row can name its own LoRA set
- The LoRA stack has a search box, pinned in long stacks, and Only on at the top
- Qwen Image 2.1: its own text encode, its RGBA VAE handled everywhere a picture is decoded,
  and a Setup family. Needs ComfyUI 0.37.0 or newer
- RedNode Studio Assistant: a read-only helper on a local Ollama model that explains a
  Workspace's settings and proposes changes that only apply when you press Apply
- RedNode Wildcards writes a __wildcard__ file from the canvas, and wildcards resolve in
  every prompt box
- Start Here offers seven more packs: the two the template's ZTurbo chain and prompt need,
  and the five behind Realism and the ClownsharKSampler

### Fixes

- A queue with a Re-angle, Realism or Swap seed linked to another part failed
- A blank canvas rendered at twice the width and height on a model with a 1/16 latent
  (Qwen Image 2.1, Flux 2), and four times as slowly. Krea 2, Z-Image and SDXL were not
  affected
- ComfyUI's own step preview was drawn on the Workspace and Detailer nodes when a live
  preview method was set, squeezing the panel to a strip, and stayed there after the run
- The Hero Creator's delete route accepted a Windows backslash path out of its folder
- A single-pass render from a blank canvas was labelled Img2Img on the Run page
- ComfyUI's Refresh did not reach the Models page's file pickers
- A boost mask alone lit Krea 2 Identity and raised the edit LoRA warning with the Subject
  off
- The Run page listed Save before Realism

**1.4.3** - 2026-09-19

Fixes, most of them the same shape: a control the panel shows, and a run that
read something else. Every one now has a test asserting the two agree.

### Fixes

- Civitai showed no generation data for any picture the pack saved. The
  "Civitai resources" list named every model and LoRA, with a version id only
  when one was known, and Civitai's reader wants a numeric id on every entry;
  one without it fails the whole picture, so the site kept nothing at all, not
  the prompt, not the steps, not the seed. The list now holds only resources
  whose version id is known, and is left out when there are none. A resource
  known by hash alone is still in Model hash, Lora hashes and Hashes, which is
  where Civitai matches hashes anyway. Pictures already saved can be repaired
  without re-rendering
- The Img2Img tab ignored its own Denoise bar at one pass. The per-pass lists
  only mean anything above one pass, so the panel hides them and shows the
  single dial while keeping the stored list for when the count goes back up;
  the run read that list whatever the count, and its stale first value won. The
  same silent override applied to scale, steps, the per-pass rig, and the
  Detailer's repeat
- The Latent tab's passes needed the canvas to be built on the tab AND a
  per-pass list switched on, so a plain three passes at the Refine denoise
  sampled once while the bar read 3 Passes, and a wired latent dropped them
  although the source picker says they still run. The pass count is the whole
  condition now
- Paint's Subject, Scene and Moodboard references were encoded through the
  Krea 2 path on a rig the panel had already greyed them out for, and a greyed
  button has no click handler, so they could not be switched off either. They
  are refused on a rig that is not Krea 2, with a line saying so, which is what
  the Detailer has always done. The panel also stopped judging by the Models
  tab's active rig when the target is a render node, whose model it cannot see
- The Prompt Converter rewrote a caption wired into a switched-off tab, while
  that page says in as many words that nothing on it is used. The caption still
  passes through, unchanged
- A Detailer card's header wrapped onto a second line once a pass had a name
  alongside SAM and Res

### Notes

- Checked against ComfyUI 0.35.1 as well as 0.30.2

**1.4.2** - 2026-09-18

Fixes for two things 1.4.1 got wrong, and a round of panel work on the Overview,
the Detailer and the Paint tab. The workflows and templates are unchanged.

### Fixes

- A saved picture could carry the wrong prompt. The saved record traced the
  prompt back from the first sampler in the workflow, so a second chain with
  its own Prompt Box put that box's words on a picture the Workspace rendered.
  The Workspace now hands Save the words it queued, and those win. Pictures
  saved before this keep the words they were saved with
- Import prompt took the first row linked to the rig instead of the row that
  rendered. It reads the chosen row now, the same rule the full screen data
  card uses, shows the words as rendered when they differ from the row, and
  offers them as a row of their own. A picture from before this fix imports
  from its embedded setup rather than from its saved text
- Auto hold was holding runs that fit. 1.4.1 started counting the Detailer's
  passes, and a pass on a second rig added its model, text encoder, SAM3 and
  working memory as if all of it sat on the card at once, which read tens of
  GB over the real peak. The estimate now also works out what the sampler
  itself needs. When that fits and the limit is the card, ComfyUI drops the
  rest by itself and the run keeps its speed; a limit set below the card still
  holds. The Run tab's card says which case it is
- The Run log called the VAE unloaded and loaded again on every tile of a
  tiled upscale. It never left: the log looks once a second and caught it
  mid-swap. A model back within three seconds is no longer announced

### Overview

- Workspace presets moved here from the Advanced tab, as a card of their own
  at the top, above What feeds the render. The entry for the panel as it
  stands reads Current instead of Custom (live). Advanced keeps a button that
  opens the Overview
- Right-click a box to turn its stage on or off: LoRAs, Camera, Moodboard,
  Paint, Img2Img, Latent, Re-angle, Swap and their polish, Detailer, Post FX
  and Save. Krea 2 Identity lists Subject, Scene and Masks; Auto prompt lists
  the galleries it is on for. It flips the same switch the stage's own page
  does. A left click still opens the page

### Detailer

- A Simple view beside Advanced, at the start of the top row. Simple keeps
  what most passes need: the rig, the target, the size and region, the
  strength bars, the upscale model, the LoRAs switch and the references.
  Nothing is reset, so a render is the same in either view, and a card shows
  a chip naming any hidden setting that is in use. Advanced is the default,
  and the choice is saved with the workflow
- Every pass has a name in front of its kind. Left alone it names itself,
  Tiled upscale, Tiled upscale 2, Face detailer, and follows the pass's type
  and target; type your own and it is kept, and the run log uses it
- The kinds read TILE UPSCALE and VR2 UPSCALE instead of USDU and UPSCALE
- The fold, eye, duplicate and delete buttons sat off centre in their boxes

### Paint

- Blank canvas, beside Open image: a white sheet at the Latent tab's size to
  paint on from nothing. A right-click offers mid grey or black
- Clear canvas, beside Clear paint: takes the picture off as well as the
  mask, the colours and the strokes. It asks first when there is painted work
  to lose. Clear paint still keeps the picture

**1.4.1** - 2026-09-18

A day of Prompts tab work after 1.4.0 went live, plus two things the Overview and
the Run tab got wrong.

### Prompts

- Import prompt, beside Add prompt: pick a PNG, or drop one anywhere on the page,
  and the browser reads its metadata. A picture RedNode Studio saved offers its
  prompt row whole, frame boxes included, or its entire Workspace setup after a
  second question. Any picture with the usual parameters text offers its words,
  in the Anything else box ready for Auto sort, or its words plus the steps,
  CFG, sampler, scheduler, denoise, size and a fixed seed. Nothing goes to the
  server
- The chosen prompt row is the one that renders. Two rows linked to the same rig
  used to fall to whichever came first, while the tab badged the row being
  edited as active. The choice rides the config now, the run reads it first,
  the ACTIVE badge marks the row that will render for the active rig, and a
  line under the bar says which serves what when the open row is not it
- As queued last run: a box under the preview with the words the last run
  sent, every socket, caption and wildcard resolved, with the time, the seed
  and Copy. The live preview cannot see what a computed upstream adds, so this
  is where a Style browser's or a Scene node's words show up
- The preview shows what the sockets add. A Wired in line names every wired
  frame and caption socket and its node; text a Prompt Box, a Note or a
  primitive holds is joined into the words the way the run joins it; a
  computed node is named as made when queued
- Rewrite as "A fresh variation": a fifth choice that keeps the subject,
  setting, mood and clothing category and moves the rest, pose, gesture,
  clothing detail, props, framing, light. Same boxes in and out
- The Prompt Frame reads top to bottom: the title and saved prompts at the top,
  the camera and the placement side by side, then Anything else, the tools bar
  and the preview, which is drawn as output rather than one more text box
- Advanced stays on the page. It sets the Camera Studio as the driver and shows
  an Open the Camera tab link instead of jumping there
- Clear leaves the prompt completely blank: the boxes, the two presets, the
  camera words off and the brightness at neutral
- A Text size slider on the prompt head scales the words in every box without
  moving the boxes; the delete button is a small red cross at the right end
  of the controls line

### Full screen

- A generation data card at the right edge of the full screen room, over the
  picture and unmoved by zoom or pan: the prompt with Copy, the negative, the
  rig and model, the settings, the LoRAs with strengths, Copy all, and Hide,
  which folds it to a tab. It follows the arrows through the history and reads,
  best first, the Workspace's own record of the words it queued, the saved
  file's metadata, or the run's setup from ComfyUI's history, and says which

### Run

- The VRAM estimate is a card under the pipeline stages: the number the run
  needs with nothing held, large; a bar against the card with the limit marked
  on it; a verdict in green, amber or red; the parts as chips. It was one long
  sentence on the top row. Hide folds it to one line
- The estimate counts the Detailer as a stage of its own: a pass on another rig
  costs that rig, a detailer pass the SAM3 checkpoint, a tiled pass its upscale
  model, a SeedVR2 pass the blocks it keeps on the card and a tile of working
  memory. Captioners are the one thing still not counted
- The measured peak reads from the run's first unload on, so what the run
  before left on the card is not called this run's peak, and it shows under the
  estimate for comparison

### Fixes

- The Overview said the SAM3 checkpoint was missing while the Detailer offered
  it: the SAM3 loader describes its file list in ComfyUI's newer combo shape,
  which the model list reader did not know. One reader now handles both shapes
  for every list the panel pulls
- The Run tab's on-card list named the diffusion model and its LoRA clone the
  same; the row says model, and a second copy says with LoRAs or copy
- The Post tab's settings cog sits on the Post FX switch bar; its own row read
  as a stray box

**1.4.0** - 2026-09-17

The panel is clearer to read. The big tabs are pages of sub-tabs, each with
a light that says whether its section is on, over a status bar that sums the
page up, and the Img2Img bar carries colour coded chips and an issues box. Two
new views: an Overview tab that maps the whole run in the order it happens,
green on, grey off, amber stood aside, red wants fixing, and a Run tab that
watches the render with its stages, its picture and its memory. The Run tab
also holds the VRAM limit, set to your card's size: the line under it says what
the run needs with nothing held, and the run holds models as it goes to stay
under the limit, so a rig that would not fit the card renders on it anyway.
The Detailer, the Post FX and the save now run inside the node, so nothing
needs wiring after it. Errors say what went wrong and where to fix it: nothing
fails silently any more, the log links to where a missing pack or model comes
from, and Check installs on the Overview names every pack and model your
settings call for. Beyond that: a rig can be your own nodes, Swap works on any
render, the Detailer grew four kinds of pass, and a Draft switch makes a seed
cheap to judge. The 1.3.1 security fixes are in, and the pack as published
makes no network call, runs no program and reads no environment variable.

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
- Holding works on ComfyUI's dynamic VRAM (the default on NVIDIA). That
  allocator ignores the old reserve and keeps every weight it has room for on
  the card, so a held run still loaded the whole model; holding now raises the
  allocator's headroom to the card past the limit, so weight pages are evicted
  and the run stays near the line. The old reserve stays for installs without
  dynamic VRAM
- While holding, the weights are held under the limit less the run's estimated
  working memory, so the sampler's own memory lands on the line instead of over
  it. The log says the held figure. The Run tab's pipeline boxes are narrower,
  so a chain with a rig load fits on one row
- The Models tab is laid out by purpose: a Rigs bar (the rig chips, Manage
  rigs, the Active prompt, and Hold two rigs, which moved here from the rig's
  files), then Files and Sampling side by side, then the Seed across the
  bottom. Sampling groups its rows as Main render, Image to image and
  Detailer, with the Sampler presets as a row of the first; the External or
  Built-in switch and the Sampler dials fold sit under them. The Loader is a
  button switch, file rows read label, file, picker, and every box has a
  one-line note under its header
- The Prompts tab, laid out to be read top to bottom: the prompt's name, its
  linked rigs and its box type each under a small label, with the box type now
  called Frame box (the prompt frame) or Plain box. The four writing boxes keep
  their saved versions behind one Presets button each instead of a row of
  controls. Shot size and camera height are the chips alone, no sliders. The
  Camera card is Camera and placement. The prompt preview has a column of its
  own on a wide panel, with a live dot and the warning as a red callout, and
  the Negative is one labelled strip under the frame
- An Anything else box under the prompt frame, with the tools bar right above
  it. Type freely, a whole prompt if you like, and press Auto sort: every
  phrase is filed into Style, Subject, Surroundings, Light and colour or
  Placement and the box empties. Whatever stays in it is added at the end of
  the prompt as written. A plain prompt switched to a Frame box lands here
  whole, ready to sort. The Prompt Frame node has the same box as its last
  input
- On the Run tab, a pipeline box or a log line opens the page that decides
  it: the encode opens Prompts, a pass its Passes page, a caption that tab's
  Auto prompt, a rig load the Models tab, the Detailer, Post FX and Save their
  own pages. The finished picture opens full screen on a click or the Full
  screen button, and a right-click on it gives the Image Review menu (Copy
  image, Copy prompt, Open in a new tab, Rerun)
- Batches on the Run tab: the estimate counts the batch, the pass line and the
  chips say "batch of N", and every finished picture sits as a thumbnail
  under the big one; a click puts it up, and full screen and the right-click
  menu open on that picture. The live picture shows up to four pictures of a
  batch forming, two to a row, instead of only the first
- Swap on Img2Img has an Own picture reference beside Main subject, Person 2
  and Person 3: a gallery on the Swap page, kept for the swap alone, so the
  person to put in does not have to be the Subject. Face, Head and Person
  read with capitals
- Swap works on a new render too. Works on picks Img2Img source (the source
  before its pass, as before) or New render: the finished picture, a Latent
  tab render as much as an Img2Img one, with Img2Img off if you like. A render
  swap is followed by a Polish pass, on by default at denoise 0.30, where the
  rig runs once more over the swapped picture so the face sits in its light.
  The Run tab plans Swap and Swap polish boxes for it, and the Img2Img tab
  lights for it with the tab itself off
- The VRAM estimate counts the Qwen edit engine when Swap or Re-angle will
  run: its model, text encoder and VAE, and its working memory for the two
  pictures it reads. It is a stage of its own, so the peak is the larger of
  the render and the edit stage, and Hold holds the weights under the limit
  less the larger working memory. The line on the Run tab names both stages
- The estimate counts a Your own nodes rig: its files are read from the
  loaders wired into its RedNode Rig Model node, through any patches between.
  Such a rig used to count as working memory only, so Auto thought a 12 GB
  model run fitted anywhere
- The edit model leaves the card once Swap and Re-angle are done, and stays
  in RAM for the next run. It used to sit on the card for the rest of the run
  and into the next one
- A 32 GB+ card as a VRAM limit: a 31.5 GB line, no dial ceilings, and Hold's
  Auto, On and Off like the other card sizes
- Swap and Re-angle run the edit model on PyTorch attention by default, with
  an Attention choice in their engine settings (PyTorch or ComfyUI's). Qwen
  Image breaks under SageAttention, so a ComfyUI started with Sage gave broken
  swaps and re-shots; the rest of the run keeps Sage
- Swap and Re-angle show their steps forming on the Run tab's live picture and
  on a Live Preview, like any pass, with a step count on their pipeline box.
  Re-angle and a swap on the Img2Img source have boxes of their own, before
  the encode, where they run
- A paint run reads as one on the Run tab: a Paint box of its own (with the
  pass count and steps), a Paint run chip, and a line saying what it is
  painting: the painted area, everything except it, or the whole frame, the
  size and the working size, denoise, passes, steps, cfg, feather, blend and
  the references. The Paint tab's console lines are in the log too, failures
  as warnings, and each leads to the Paint tab. History marks paint runs
- The Paint tab draws no live frame while its switch is off
- The Paint tab's result has a full screen viewer of its own: the Full screen
  button on the result pane, or a double-click on the result at 1:1, opens
  the Image Review's room over the tab's result history. Wheel zooms, drag
  moves, left and right walk the results, Esc closes, and the right-click
  menu there gives Copy image, Copy prompt, Open in a new tab and Rerun
- An Img2Img that is switched off now names only what is actually on. One
  line said its auto prompt, Re-angle, a source Swap and the converter did
  nothing whenever any one of them was on, so a workspace with just the
  converter on read as though three other things were being thrown away. It
  is a line each, naming the one thing, opening the page that owns it. A
  Re-angle set to the new render is never called idle, since it runs anyway
- The page note under a switched-off tab no longer lists the auto prompt, the
  boosts and the converter whatever page it is sitting on
- The preset strip across the top of the node is gone. The Advanced tab's
  Workspace presets row does the whole job: load, Save as and Delete, with the
  name you loaded staying picked so Delete has something to act on. The node
  carries one widget now, its config, and it was the last of the two so no
  saved workflow shifts a value
- The socket tuck sits on the tab row, at the right of the strip, rather than
  on a row of its own above it
- The Paint tab's Use last result works for a run that was never saved. It
  read only what a save had filed, so with Save switched off the button sat
  dead or offered an older picture. It reads the copy the Workspace keeps of
  the finished picture too
- BOOSTS only goes green when a dial is actually doing something. It used to
  light as soon as a dial had been touched, so moving one and putting it back
  left it green for good. The Advanced tab's dot and the DIALS fold's count
  read the same way now: set means different from that dial's own default
- The SAM3 checkpoint row links to a model. ComfyUI-Easy-Sam3 installs without
  one, so the row said where to put a file without saying where to get it. The
  Start here workflow's note and the README carry the same link
- Check installs covers the Post tab too. An effect that reads depth asks for
  comfyui_controlnet_aux and a Limit row set to the subject or the background
  asks for comfyui-rmbg, on the same terms the cards themselves use, and the
  server's own report answers whether each is here. Both join the Start here
  workflow and the README list
- The Post tab's effect list kept jumping back to the top on every click, and
  so did the Order view's cards. The hook a tab sets while building its body
  was being cleared after the tab had built it, so it never ran
- Krea 2 Identity says what it needs. The likeness rides a Krea 2 edit LoRA,
  so the Overview says when none is switched on, when the rig is not the
  official Krea 2 Turbo the LoRA was trained on, and when a Detailer pass runs
  with the LoRA stack switched off and can undo the likeness
- Check installs asks for a SAM3 checkpoint as well as the pack. ComfyUI-Easy-Sam3
  installs without one, and a Detailer pass then failed on the missing file
  while the check said the pack was fine
- The Start here workflow's notes are ComfyUI's own Note nodes
- A rig keeps the kind a local module registered. The panel cleared anything but
  External renderer and Your own nodes when a workflow loaded, and the next write
  persisted the loss, so a rig on a kind added by a private module quietly became
  a plain files rig. The picker and the server both accept those kinds; the config
  reader does now too, and it leaves a kind it does not recognise alone rather
  than wiping it
- The VRAM line stops calling its figure a peak. It is what the run would need
  with nothing held, which is what Hold reads to decide whether to hold; once it
  holds, the peak you actually see is far below it. Sitting beside the measured
  peak on the chart, the old wording read as the estimate being wrong by tens of
  gigabytes. It says "Needs about N GB unheld" now, and when the run will hold it
  adds that the chart's peak is the one to read
- A pass tap is decoded through the rig's VAE, so a photographed pass looks like
  the picture rather than a posterised approximation of it. The taps used a tiny
  preview decoder to avoid a decode per pass; on a model with no matching
  approximation that meant wrong colours, and a pass you could not compare with
  the finished frame. Where no VAE is to hand it still falls back, and says so by
  marking that tap a preview
- The two sampler modes say what they actually do. Built-in sampler claimed the
  node runs comfy core's KSampler, which is only true of a rig that loads files:
  on a Your own nodes rig it is YOUR sampler that works and the Workspace that
  drives it. That reading sent people to External sampler, where the Workspace
  renders nothing and the rig never runs at all. Both tips are rewritten, and a
  rig of your own nodes carries a line under the switch saying which mode calls
  it and that Built-in does not replace your sampler
- A rig built from Your own nodes says so when the sampler mode contradicts it.
  Only the built-in sampler calls such a rig, so on External sampler its Rig
  Model, Rig Inputs and Rig Result sat wired and idle and nothing rendered,
  which read as the rig being broken. The Models tab, the Run tab and the
  Overview all name the rig and say which switch fixes it
- The INT8 marker in the Start here workflow carries its Comfy Registry id.
  ComfyUI Manager's own list does not carry that repository, so it fell back to
  a git URL install and refused it, wanting allow_git_url_install in its config.
  Manager reads the registry id first, so it resolves in one step now
- The RedNode Studio template needs two packs of its own, and now says so. Its
  Light & Color and Scene nodes come from Krea2-BBOX-Prompter and its Style
  browser from ComfyUI-Krea-Moodboards. Both join the Start here workflow, the
  README's optional packs and the Quick start, so Manager offers them instead
  of the template opening with missing nodes
- A Start here workflow, `RedNode_Start_Here_Install.json`. It renders nothing:
  it holds one node from each pack the Workspace can lean on, so ComfyUI
  Manager finds them together and offers them in one pass, with a note saying
  what each one is for and where it lives. Each marker carries the pack's
  owner and repository, which is what Manager reads to match a missing node
  to its pack, so the offer lands on the right one
- The README lists the optional packs with what each adds and a link to each,
  and no longer says Manager offers packs when the main template is opened,
  which it does not
- The Overview has a Check installs button. It says which node packs, caption
  engines and model files these settings actually call for, which of them are
  already here, and where to get the rest. It reads what ComfyUI has loaded
  and the file lists it already hands the panel; it downloads and installs
  nothing, and ComfyUI Manager still does the installing
- A run log line naming a pack that is not installed carries a link to where
  that pack lives, beside the line that names it. Every address goes straight
  to the pack that owns the node types the Workspace looks up, checked one by
  one, rather than to a search page of forks to pick from
- A canvas set to Wired image or Wired latent, with nothing wired to it, is
  now said out loud. The Img2Img Source page says the socket is empty instead
  of claiming the wire feeds the canvas, the Source chip goes amber, the
  issues box and the Overview name the socket, and the Run tab's log carries
  the same sentence. The Latent tab's own wired input is covered the same way.
  Before this the panel showed a green Source and nothing standing in the way
  of a run while the render quietly fell back to the gallery
- The Overview's Auto prompt box named nothing and swept in every tab, so an
  Image to text gallery (Style, Subject or Scene words), always on by design
  and empty on almost every install, read as "on, no pictures" on workspaces
  that never touched it. It now counts only the galleries that feed the
  render, an Image to text one only once its words are wired to a prompt
  row, and names which gallery it means in both the box and the attention line
- Nothing rendered never fails silently again. The Run tab's log says why (no
  rig, no VAE, External sampler with nothing wired to it), the Models tab
  warns about External sampler whenever Save, the Detailer or Post FX expect
  a picture from it, not only when the image output is wired, and the
  pipeline always carries a Render box under External sampler naming it. A
  run with Save off still hands the panel its finished picture, kept as a
  temp file, so the Live picture and the Review are never empty just because
  nothing was written to disk
- Re-angle and Swap share one shape. Both work on the Img2Img source before
  its pass or on the new render, a Latent tab render too with Img2Img off if
  you like; an edit on the render is followed by a Polish pass by the rig, on
  by default at denoise 0.30. On the source both carry Skip the i2i pass, so
  the edited picture goes straight to the image output. The lights, the chips,
  the Run plan, the VRAM estimate and the Overview follow both stages
- An Overview tab in front of the others: the run as it is set up, one box
  per stage in the order it happens, green on, grey off, amber stood aside
  with the reason on hover, red wanting a fix. A click on a box opens the page
  that decides it, and a Needs attention list collects every reason a stage
  will not run
- The Img2Img bar's chips carry the colour of the page they report on, and the
  sub tabs wear the same colours; a click on a chip opens its page, and a chip
  for a stage that will not run turns amber. An issues box at the bar's right
  end says why, one line per reason, each a link to the page that fixes it
- A Swap on the render runs under Prompt only too, and the tab lights, the
  Swap page and the Run plan now say so
- Sampler presets on the Models tab save and delete again: Save beside the
  list keeps this rig's steps, cfg, sampler, scheduler and detailer steps
  under a name, Delete removes the picked one. They are the Sampler Config
  node's presets, shared with it
- On the Models tab the file picker's None entry sits at the top of the list
  instead of under every file, and the Local files buttons are gone: the box
  itself is the picker. The Loader choices read By file name, Standard, GGUF and INT8
  W8A8; a loader whose pack is missing is dimmed and says so on hover
- Not in this release: RedNode Save Video and RedNode Video Review (they run
  ffmpeg) and the LoRA panel's Civitai lookup. The Save panel's Browse and Open
  buttons and its folder-opening menu entries are gone for good: a route that
  launches a program on the machine is not worth keeping. The Comfy Registry's scanner
  flags every subprocess and network call in a pack, whatever it is for, and a
  flagged version never reaches a Registry install; these come back once that
  is settled. The pack reads no environment variable either
- Ollama is reached through the ollama client library, the one the
  comfyui-ollama-describer pack installs, instead of the pack's own HTTP call;
  without it the Ollama engine and the rewrites say so and step aside. The
  address is the server's own, OLLAMA_HOST or this PC, and is no longer taken
  from a workflow or a request
- Security: every gallery path is checked to sit inside the ComfyUI folder its
  name says, on older cores too (ComfyUI's own check arrived in 0.28); Keep and
  Unkeep only move inside the output folder; the delete route only removes
  pictures and clips; Video Review plays files from the output folder only;
  the Civitai version id must be a number; the Florence model must be one the
  loader lists; the small preview VAE loads with safe_load
- The NovelAI rig is no longer part of the pack: it is a personal-only
  module again, as it was before 1.2.0
- Civitai downloads are no longer part of the pack. The Comfy Registry's scan
  flags a node that fetches files onto the disk, and 1.2.0, 1.3.0 and 1.3.1
  were all held back, so a registry install kept getting 1.1.0. The LoRA
  panel keeps the update check, the version it needs and the Civitai links;
  the file is yours to fetch
- The Paint tab's Subject, Scene and Moodboard reference toggles follow the
  Model choice: a built-in rig picked there decides whether references are
  offered, instead of the Models tab's active rig. Generate on a built-in
  choice now renders on the rig it names; it used to render on the active rig
  whatever the choice said
- The Paint tab has the Detailer's Blend, beside Feather: how much of the
  repaint goes back under the mask. 1.00 is the repaint as before; 0.50
  keeps half of what was painted over, so a high denoise with a blend under 1
  repaints harder and still keeps the original's skin and grain
- The Paint tab's Use last result can pull the picture from before Post FX:
  a Before Post / After Post choice beside the button. Post's grain, vignette
  and grade were baked into what you painted and are hard to paint out; with
  Before Post the tab starts from the picture underneath, and Post runs again
  on the painted result. The Workspace keeps that picture as a temp file when
  it runs Post itself; a run without one pulls the finished picture and the
  button says so. Use last result also sees a run the Workspace saved itself,
  with no Review or Save node after it
- A Fast switch on Swap: on puts the Lightning speed LoRA on the swap at 4
  steps and cfg 1, about 8 times faster; off takes it out and puts the LoRA
  author's 16 steps at cfg 2 back. The engine fold still tunes each by hand
- Quick phrases under Swap's prompt: Match skin tone, Keep lighting, Keep
  expression, Keep age and more, with Keep hair for Face and the clothing
  ones for Person. A click adds one, starting from the LoRA author's prompt
  when the box is empty; a second click takes it out, and Author's prompt
  empties the box. Face mode keeps the author's Image wording with phrases
  added
- History under the Run tab's log: this session's finished runs, up to 20,
  each with its time, how it ended, batch and seed. Picking one shows its
  whole sheet again (pipeline, finished pictures, VRAM chart, log) under a
  banner with Back to live, and a new run returns the page to live by itself.
  Runs are kept in the page only, so a reload starts the list again
- The Run tab's log no longer says a model unloaded and loaded again when the
  sampler dials swap it for their patched copy. Nothing left the card; a model
  is said to unload only when its memory comes back
- The Detailer reports on the Run tab: each pass is named the way its card
  is (Sampler pass, Face detailer, SeedVR2 upscale, Tiled upscale) as it starts
  and when it finishes, with what it did, and the pipeline box shows the pass
  running. Found targets, working sizes, LoRAs, tone lock, freed VRAM and
  anything that failed or passed through are logged too, failures as warnings
- Full screen from the Run tab's picture closes again (the Close button and
  Esc did nothing when the Review sub-tab had not been opened yet)
- A batch rendered on Krea 2 in the Workspace keeps every picture. Krea 2's
  VAE is a video VAE, and the decode kept only the first picture of what it
  handed back, so a batch of two became one before the Detailer, Post FX and
  the save ever saw it. The same fix covers a pass that changes model family,
  a rig's own sampler chain, and the Live Preview's finished frame
- A SeedVR2 upscale pass keeps every picture of a batch. SeedVR2 is a video
  upscaler and read a batch as one clip, so a batch of two came back as one
  picture; each picture now goes through on its own
- Copy prompt works for a run the Workspace rendered itself. With no sampler
  node to trace, it used to answer that the prompt was no longer available;
  it now reads the Workspace's own prompt row
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
  Camera Ready starting points for Krea 2 and Z-Image, natural photo, soft and
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

- RedNodeStudio_V1.4 replaces the V1.3 template: one Workspace with three
  rigs on its Models tab, one loading its files there and two built from
  their own nodes on the canvas, with the Detailer, the grading and the save
  running inside the node. A note inside lists every model and LoRA file it
  loads and where to get each one
- RedNode_Start_Here_Install renders nothing: one node from each pack the
  Workspace can use, so ComfyUI Manager finds and installs them in one pass.
  Open it first, restart, then open the template
- RedNode_Studio_Simple_Angles: the camera stage in a plain graph

**1.3.1** - 2026-09-16

A security fix. Please update.

- Civitai LoRA downloads keep only the bare file name, only take .safetensors
  files, and can no longer write outside your loras folder. A Civitai version
  that only has a .ckpt or .pt file now has to be downloaded by hand
- The Save node's prompts folder always stays inside the output folder
- NovelAI vibe encoding only reads files from the input folder
- Auto Prompt and Prompt Sort only talk to Ollama on this PC or your local
  network
- Uploading a .naiv4vibe file on the NAI panel works again

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
