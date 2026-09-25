# RedNode Studio

**One panel for every model and every job.** Render, edit, paint, upscale and finish a picture from a
single node in ComfyUI, on Krea 2, Qwen Image 2.1, Z-Image, Anima, SDXL, Illustrious or Pony.

<table>
<tr>
<td width="33%"><img src="images/run-tab.webp" alt="A Krea 2 render on the Run page, with the pipeline, the finished picture and the VRAM chart"></td>
<td width="33%"><img src="images/identity-run.webp" alt="The same woman in a new scene, rendered from a Hero Creator headshot"></td>
<td width="33%"><img src="images/run-rail-right.webp" alt="An Anima render with the tab rail on the right"></td>
</tr>
<tr>
<td align="center">Krea 2, from a two line prompt</td>
<td align="center">Same face, new scene, from one photo</td>
<td align="center">Anima, or any model you like</td>
</tr>
</table>

**63 nodes · No pip dependencies · Every model, every purpose**

Search **RedNode Studio** in ComfyUI Manager, or clone it:

```
git clone https://github.com/RedNodeAI/ComfyUI-RedNodeStudio.git ComfyUI/custom_nodes/ComfyUI-RedNodeStudio
```

Then open **RedNode Start Here Install** from the template browser, let Manager install what it
offers, restart, and open **RedNode Studio**. [The full guide](GUIDE.md) covers every tab, node and
setting.

## Why I built it

A ComfyUI graph for a finished picture turns into a wall of wires: loaders, samplers, detailers,
upscalers, grading, saving. I wanted one place where all of that lives, where switching models is
a click, and where the canvas stays small enough to see. The RedNode Studio Workspace is that
place. You pick a model, write a prompt, press Generate, and the render, the detail pass, the look
and the save all happen inside one panel.

## Every model, set up in one click

![Models Setup: one card per model family, each with the files it found in your folders](images/models-setup.webp)

Press the family you have and the rig is built: the model, its text encoder, its VAE and the
settings that model wants, found in your own folders by name. Krea 2 Turbo, Qwen Image 2.1,
Z-Image Turbo, Anima and SDXL / Illustrious / Pony are ready to go, and any other model loads by
hand. Keep as many rigs as you like and switch between them in a click.

## A studio, not a graph

<table>
<tr>
<td width="50%"><img src="images/overview.webp" alt="The Workspace Manager: the whole run in order, and what needs attention"></td>
<td width="50%"><img src="images/prompts.webp" alt="The Prompts tab with a Frame box"></td>
</tr>
<tr>
<td><b>See the whole run at a glance.</b> Every stage in order, green for on, grey for off, and a
plain word on anything that needs fixing. Click a box to jump to it.</td>
<td><b>Write prompts that build themselves.</b> Style, subject, surroundings and light in their own
boxes, a camera that writes its own sentence, wildcards and saved presets.</td>
</tr>
<tr>
<td><img src="images/editor-realism.webp" alt="The Re-render tab"></td>
<td><img src="images/paint.webp" alt="The Paint tab"></td>
</tr>
<tr>
<td><b>Edit any picture.</b> Turn an illustration into a photograph, re-shoot it from a new angle,
swap a face in, upscale it, all from the Tools tab and Re-render, on a gallery picture or on the render you just
made.</td>
<td><b>Paint what you want changed.</b> Mask a region, type what should be there, press Generate.
Only the painted part changes, and the result becomes the next thing you paint on.</td>
</tr>
<tr>
<td><img src="images/post-fx.webp" alt="Post FX with seventeen shipped looks"></td>
<td><img src="images/camera.webp" alt="The Camera tab"></td>
</tr>
<tr>
<td><b>Finish it like a photographer.</b> Twenty effects in camera order, from exposure and skin to
film stocks and lens glass, and seventeen ready made looks to start from.</td>
<td><b>Direct the camera.</b> Place the subject and the camera on a stage, pick the lens and the
height, and the prompt and the camera LoRAs follow.</td>
</tr>
</table>

## One photo in, the same person anywhere

<table>
<tr>
<td width="50%"><img src="images/hero-headshot.webp" alt="The Hero Creator: source photo, clean crop and front on headshot"></td>
<td width="50%"><img src="images/identity-run.webp" alt="The same woman on a beach at sunset"></td>
</tr>
</table>

The **Hero Creator** takes any photo, cuts the head out above the clothing and renders a clean front
on headshot. Drop that into the Subject gallery and Krea 2 Identity puts the same person in any
scene you write: a hotel lobby in green velvet becomes a beach at sunset in white linen.

## Built to run on your card

![The Run page: every stage timed, the live picture and the VRAM chart](images/run-tab.webp)

Watch every stage with its time, the picture forming step by step, and a VRAM chart that shows
what is on the card. Set a VRAM limit and the Workspace works out what the run needs and holds it
under your card's size, so a big model still runs on a small GPU.

## Keep what you make

![The Save page: folder patterns, drafts and keepers, and recent saves](images/save-page.webp)

File every picture by date, preset, seed, model or size, keep drafts apart from keepers, and cull a
session without leaving ComfyUI. Every file carries its prompt, its settings and the model and LoRA
hashes, so a picture posted to Civitai lists what made it.

## Make it yours

![The tab rail on the right hand side](images/run-rail-right.webp)

Put the tab rail on either side, fold it to icons, hide the tabs you never use, or pick a preset
for the job: Basic, New image, Image to image, Edit, Paint or Finishing. A red Generate sits at the
top wherever you are.

## And the rest

A Detailer that lists its passes instead of wiring them, a LoRA stack with search and groups,
moodboards, image to image with several passes, a local assistant that explains any setting,
seeds you can link across the whole run, live previews, a picture history with rerun, stage by
stage comparisons, and control panels that drive other nodes with no wires at all.

**[Read the full guide](GUIDE.md)** for every tab, node and setting, the model downloads, and
performance numbers. What changed in each version is in the [changelog](CHANGELOG.md).

## License

**PolyForm Noncommercial 1.0.0.** Free for personal use, hobby projects, research, study and
noncommercial organizations. Commercial use needs my permission, so get in touch. Full terms in
[LICENSE](LICENSE).

In plain language: use it, modify it, learn from it, share it, all fine. Selling it or building it
into something you sell is not, unless you have arranged that with me separately.

ComfyUI itself is GPL-3.0 and is a separate work. Releases up to and including v1.4 were published
under GPL-3.0 and stay available under those terms. The license change applies from v2.0 onward.

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
