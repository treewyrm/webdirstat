# 0010 — Shaded (cushion) treemap tiles

Status: **Done**

A client-only display option to render treemap tiles with a raised, WinDirStat-style
**cushion** shading instead of the flat fill, so nesting and boundaries read without
relying on outlines. Raised during first hands-on testing of the pan/zoom treemap
([feature 0002](0002-pan-zoom-treemap.md)).

## What shipped

A **Shaded (cushion) tiles** toggle in the Display settings pane
([DisplaySettings.vue](../../client/src/components/DisplaySettings.vue)), backed by
`useDisplaySettings.shaded` (default **off**, persisted client-side). Shading is a
pure rendering-layer transform of the same `colorFor` base color — no protocol,
server, or layout change. Toggling just repaints (`scheduleDraw`), no refetch/relayout.

**Rendering** ([MapTreemap.vue](../../client/src/components/MapTreemap.vue)):

- **One color-independent cushion sprite**, built once (`cushionSprite`): a 128×128
  offscreen canvas holding a soft top-left specular highlight (white alpha) plus
  all-edge darkening (black alpha). `drawTile` fills the flat base color as before,
  then `drawImage`s that sprite stretched over the tile (source-over) when shading is
  on. The base color shows through, and every tile — any color or aspect ratio —
  reuses the same sprite: one `drawImage` per tile, no per-frame gradient allocation.
  This sidesteps the per-tile gradient + `(color, size-bucket)` cache the proposal
  weighed; the accumulated Van Wijk cushion was ruled out as not worth the per-frame
  cost/state. The tail tile stays flat; labels and shimmer are unaffected (drawn after
  the overlay).

## Crisp single-pixel seams (shipped alongside)

The flat-mode borders were reworked on the same branch. Previously each tile
`strokeRect`'d all four edges at `lineWidth: 1`, so a shared boundary was painted
twice and landed on two device pixels (a ~2px seam, doubled again for `drawDirFrame`).
Now `drawTileBorder` draws only a tile's **top and left** edges — a shared boundary is
painted once, by the lower/right neighbor — snapped to a device-pixel center at
`lineWidth = 1/dpr` for a genuine single physical pixel on retina. `drawDirFrame`
reuses the same helper, so folders and files share one consistent seam
(`rgba(0,0,0,0.5)`); a directory's outer right/bottom edge is covered by its neighbor,
the map's outermost edge by the canvas edge.

Fixed-top-left light was kept fixed (no intensity slider) — the WinDirStat convention.
