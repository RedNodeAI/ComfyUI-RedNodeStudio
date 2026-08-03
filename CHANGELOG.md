RedNode Studio changelog

New versions go at the top. The release action reads the section matching the
pyproject version and puts it on the GitHub release, so the bold version line
format matters: **version** then a date, notes below until the next bold line.

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
