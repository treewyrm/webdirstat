# 0020 — Color tiles by folder

Status: **Done**

A third **color mode** alongside Type ([feature 0011](0011-color-by-age.md) added
Age): color each tile by the **folder that directly contains it**, so every tile in one
directory shares a hue and folder boundaries read as solid color blocks across the whole
map. Client-only; no protocol or server change.

## Change

- **`color.ts`** — `ColorMode` gains `"folder"`; `Colorable` gains an optional `path`
  (root-relative, already on `WorldNode`). `colorByFolder(path)` hashes the node's
  **parent folder path** onto a wide HSL hue spread (`hsl(h, 42%, 46%)`) — more distinct
  for adjacent folders than the 10-swatch `PALETTE`. `fillFor` dispatches folder mode
  before the `colorFor` fallback; **errored** tiles keep their error tone, and the
  synthetic tail/small tiles are still handled upstream in `drawTile`.
- **Selectors** — the `"By folder"` option added to both the Display-pane select
  (`DisplaySettings.vue`) and the compact `TileToolbar.vue` select, both bound to the
  same `settings.colorMode`. The existing `colorMode` watch in `MapTreemap.vue` already
  repaints on any mode change; folder mode needs no bounds and no legend.

Every tile in a directory shares one color; a directory's own collapsed tile takes its
**parent's** color (it belongs to that parent), so an expanded folder becomes a solid
block distinct from its siblings.
