# 0012 — Highlight the map tile when hovering a list row

Status: **Proposed**

Hovering a row in the left **file-list pane** should highlight the corresponding
tile in the **map view**, when that tile is currently on screen. Closes the loop on
the list↔map relationship: today hover flows only **map → list** (the hovered
`WorldNode` is emitted from
[MapTreemap.vue](../../client/src/components/MapTreemap.vue) `onMouseMove` and
reflected into the tooltip / focus in [App.vue](../../client/src/App.vue)). This adds
the reverse direction, **list → map**, so pointing at a filename shows *where* it
lives on the map at a glance. Client-only; no protocol or server change.

## Today

The file-list pane and the map are both derived from the same focus folder, but they
don't cross-highlight. Rows carry the child's `id` and `path` (used for
list-click fly-to); the map keeps a set of laid-out `WorldNode`s keyed by `id` for
the currently-rendered directory levels. There's already a "hovered node" concept on
the map side (drives the tooltip) — this feature is a second, list-driven highlight
that feeds the same canvas.

## Change

- **App.vue**: on `mouseenter`/`mouseleave` of a list row, set a reactive
  `highlightedId` (the row's node `id`) and pass it to `MapTreemap.vue` as a prop;
  clear on leave. This is the mirror of the existing `@hover`/focus reflection.
- **MapTreemap.vue**: accept a `highlightId` prop. In the canvas draw path, if a
  laid-out `WorldNode` matches that `id` **and** its world rect intersects the
  viewport, draw a **highlight overlay** on it (e.g. an inset outline / brighter
  border, same treatment used for the map-side hovered tile so the two directions
  look identical). Because rendering is canvas, this is a redraw trigger on
  `highlightId` change, not a DOM class.

## "If it is visible"

The row may point at a tile that isn't currently laid out — it's inside a collapsed
(not-yet-revealed) directory, or panned/zoomed off screen. Behavior in that case:

- **Not laid out / off screen:** no highlight (the honest, simplest answer). The
  lookup is a miss in the rendered `WorldNode` set, or the rect fails the viewport
  intersection test — draw nothing extra.
- **Optional nicety:** if the tile is laid out but off screen, could show a
  directional edge indicator ("it's that way"). Out of scope for a first cut; note
  it, don't block on it.

## Shape of the change

- `App.vue`: `highlightedId` ref + row `@mouseenter`/`@mouseleave` handlers; pass as
  a prop to the map.
- `MapTreemap.vue`: `highlightId` prop; in `drawTile`/the draw loop, add the overlay
  when `node.id === highlightId` and the rect is on screen; watch the prop to trigger
  a redraw.
- Reuse the existing hovered-tile highlight styling so map-hover and list-hover
  render the same way.

## Open questions

- **Bidirectional?** Should map hover also highlight the list row (scroll it into
  view / tint it)? That's the symmetric other half; can ship independently. This doc
  covers list → map only.
- **Highlight style.** Match the map's own hover treatment, or use a distinct accent
  so "you're pointing from the list" is visually different from "you're pointing on
  the map"? Prefer matching for consistency unless testing says otherwise.
- **Perf.** Highlight is a single extra draw pass gated on a rect test — negligible.
  Just ensure the `highlightId` watch coalesces into the existing render scheduling
  rather than forcing a synchronous redraw per pointer move.

## Aside — cap the number of list rows

While touching the file-list pane, consider adding an **upper limit** on how many
rows it renders. The pane is sorted largest-first, so a very wide directory (many
thousands of children) would render a huge DOM list even though only the top entries
matter — and every extra row also adds a hover target this feature has to reason
about. Cap at some sensible N (matching or near the `tree`/`batch` child cap), and
show the remainder the way the map already does — a single **"… X more"** summary row
(the list analog of the map's `omittedTail` remainder tile). Keeps the pane bounded
and the hover set small. Minor, orthogonal to the highlight itself — note it, don't
block on it.

## Decision

Not yet decided — pending discussion.
