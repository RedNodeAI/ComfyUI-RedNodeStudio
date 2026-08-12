RedNode Studio changelog

New versions go at the top. The release action reads the section matching the
pyproject version and puts it on the GitHub release, so the bold version line
format matters: **version** then a date, notes below until the next bold line.

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
