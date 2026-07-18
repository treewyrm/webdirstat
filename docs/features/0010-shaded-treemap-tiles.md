# 0010 — Shaded (cushion) treemap tiles

Status: **Proposed**

A display option to switch tile rendering between the current **flat** fill and a
**shaded / cushioned** fill — the raised, gradient-lit look WinDirStat uses, where
each tile appears as a rounded pillow so nesting and boundaries read without relying
on outlines. Raised during first hands-on testing of the pan/zoom treemap
([feature 0002](0002-pan-zoom-treemap.md)). Client-only.

## Today

Tiles are drawn flat in
[MapTreemap.vue](../../client/src/components/MapTreemap.vue) `drawTile`
([around L170-184](../../client/src/components/MapTreemap.vue#L170-L184)): a single
`ctx.fillStyle = colorFor(node); ctx.fillRect(...)` plus a thin dark stroke, with
directory framing in `drawDirFrame`. `colorFor`
([color.ts](../../client/src/utils/color.ts)) returns one solid color per tile —
neutral tones for directories/symlinks, an extension-hash color for files.

Flat fills are crisp and cheap, but with the whole map on screen at once, adjacent
same-color tiles blur together and depth is carried only by the 1px strokes.

## Change

Add a **shaded** rendering mode. The classic treemap "cushion" technique (Van Wijk &
Van de Wetering) sums a smooth height bump per nesting level and shades by a surface
normal, giving each subtree a rounded, lit appearance. A pragmatic canvas
approximation that keeps `colorFor` as the base color:

- Replace the flat `fillRect` with a **radial or diagonal gradient** per tile: base
  color at the tile center/top-left, darkened toward the edges (or a lighter
  highlight offset to a fixed light direction, darker on the opposite corner).
  Cheap, no per-level state — reads as a soft cushion immediately.
The **per-tile gradient** is the approach — most of the visual payoff for a fraction
of the complexity, and it composes with the existing directory frame and labels. The
truer accumulated cushion (summing a height/shading factor as the recursion descends
in `drawNode` to deepen ridge lines between nested siblings) is **not** worth the
extra per-frame cost and state; ruled out.

### Performance

The map is a canvas redrawn on every camera frame (`draw` →
[MapTreemap.vue:126](../../client/src/components/MapTreemap.vue#L126)). Building a
`createLinearGradient`/`createRadialGradient` per tile per frame is measurably more
expensive than a solid fill. Mitigations: cache gradients keyed by
`(color, rounded-size-bucket)`; or precompute a small set of vertical gradient strips
and `drawImage`-scale them; or only enable shading below a tile-count threshold. Worth
a quick profile on a dense tree before committing to the per-tile approach.

## As a display setting

This is a per-viewer visual preference with no server side — it belongs in the
**display settings pane** ([feature 0007](0007-display-settings-pane.md)) as a
**Flat / Shaded** toggle (it's exactly the "color scheme knobs" placeholder that doc
lists). Default **flat** (current behavior); shaded is opt-in.

## Shape of the change

- `MapTreemap.vue`: branch `drawTile` (and possibly `drawDirFrame`) on a `shaded`
  flag; add the gradient builder + a small gradient cache.
- Read the flag from the `useDisplaySettings` composable proposed in
  [feature 0007](0007-display-settings-pane.md); add a **Flat / Shaded** control to
  `SettingsEditor.vue`.
- No protocol / server / `colorFor` signature change — shading is a rendering-layer
  transform of the same base color.

## Open questions

- **Light direction / intensity.** Fixed top-left light is the WinDirStat convention;
  intensity could itself become a slider, but start fixed.
- **Interaction with labels & shimmer.** Confirm on-canvas name labels
  (`drawLabel`) and the load shimmer (`drawShimmer`) still read over a shaded fill.

## Recommendation

Depends on [feature 0007](0007-display-settings-pane.md)'s settings pane existing to
host the toggle. Implement the **per-tile gradient** cushion behind a **Flat / Shaded**
switch (default flat), with a gradient cache, and profile against a dense tree before
enabling by default (leave it opt-in).

## Decision

**Per-tile gradient approximation.** The fuller accumulated-cushion technique is ruled
out — not worth the added complexity or per-frame cost. Remaining specifics (light
intensity, gradient caching strategy) settle at implementation time.
