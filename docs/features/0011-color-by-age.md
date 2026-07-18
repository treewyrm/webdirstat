# 0011 — Color tiles by age (mtime)

Status: **Done**

A display option to color treemap tiles by **modification time** instead of by file
type — older files render darker/duller, newer ones brighter — so a viewer can spot
stale vs. recently-touched regions at a glance. Borrowed from
[GrandPerspective](https://grandperspectiv.sourceforge.net/), which offers a
"color by modification/creation/access time" mapping alongside its by-type coloring.
Client-only; no protocol or server change.

## Today

`colorFor` ([color.ts](../../client/src/utils/color.ts)) returns one deterministic
color per tile from the node's **kind + name**: neutral tones for
directories/symlinks/other, an extension-hash palette entry for files. It never looks
at time. [MapTreemap.vue](../../client/src/components/MapTreemap.vue) `drawTile` calls
`colorFor(node)` for the fill.

The data is already there — no server work needed. `mtimeMs` is:

- captured in the walk (`stat.mtimeMs`,
  [walk.ts:172](../../server/src/scan/walk.ts#L172)),
- stored per row (`mtime_ms`, [schema.ts:29](../../server/src/store/schema.ts#L29)),
- returned per child (`nodes.ts` maps it to `mtimeMs` when non-null,
  [nodes.ts:187](../../server/src/store/nodes.ts#L187)),
- and declared optional on `TreeChild` ([types.ts](../../shared/src/types.ts))
  and available on the map's `WorldNode`.

There's even a `(generation, root_id, mtime_ms)` index
([schema.ts:37](../../server/src/store/schema.ts#L37)) already in place (added for a
future "newest/oldest" query), unused today.

## Change

Add an **age** coloring mode. When active, map each tile's `mtimeMs` onto a
**sequential ramp** (dark/cool = old → bright/warm = new) and use that as the fill,
replacing the type-hash color for files.

Design choices to settle:

- **Ramp domain.** Normalize `mtimeMs` against the **[oldest, newest]** actually
  present in the current tree rather than absolute calendar time, so the gradient
  always spans the visible data. A **log scale on age** (now − mtime) reads better
  than linear — most files cluster recent, a few are ancient. The oldest/newest
  bounds come cheaply from `scan_summary` or a one-shot min/max query (the mtime
  index makes it trivial) — or, simplest first cut, track running min/max across
  tiles the client has already loaded.
- **Ramp itself.** A single-hue sequential scale (light→dark). `d3-scale` +
  `d3-scale-chromatic` are the natural fit but not yet dependencies; a hand-rolled
  two-color lerp in `color.ts` avoids adding them for a first cut.
- **Directories.** GrandPerspective colors *files*; a folder has no single age. Options:
  keep directories neutral (as today) and only age-color files; or age-color a
  directory by an **aggregate** (e.g. newest descendant mtime), which would need a
  precomputed rollup and is out of scope for a first pass. Start with **files only,
  directories stay neutral**.
- **Missing mtime.** `mtimeMs` is optional (nulled on stat error). Fall back to a
  flat "unknown" tone.

## As a display setting

This is a per-viewer visual preference with no server side — it belongs in the
**display settings pane** ([feature 0007](0007-display-settings-pane.md)) as a
**color-mode** control: **Type / Age** (and it composes with the **Flat / Shaded**
fill toggle from [feature 0010](0010-shaded-treemap-tiles.md) — age picks the base
color, shading transforms it). Default **Type** (current behavior); age is opt-in.

## Legend

By-type coloring needs no legend (color is arbitrary identity). An **age** ramp is
quantitative and wants a small **gradient legend** ("older ← → newer" with the actual
date bounds) so the color is readable. Modest bit of UI; note it, don't block on it.

## Shape of the change

- `color.ts`: add an age-ramp function `colorByAge(mtimeMs, bounds)` returning a hex
  string; keep `colorFor` for type mode. A `mode` parameter (or a second entry point)
  selects between them. Extend `Colorable` with an optional `mtimeMs`.
- `MapTreemap.vue`: pass the current color mode + age bounds into the fill path;
  compute/track bounds (min/max mtime) as tiles load, or read them from summary.
- Read the mode from the `useDisplaySettings` composable proposed in
  [feature 0007](0007-display-settings-pane.md); add a **Type / Age** control to
  `SettingsEditor.vue`, plus the gradient legend when Age is active.
- No protocol / server change — `mtimeMs` already ships.

## Open questions

- **mtime vs. ctime vs. atime.** GrandPerspective offers all three. We only capture
  `mtime` today; atime is often unreliable (noatime mounts) and ctime isn't stat'd.
  Ship **mtime only**; the others are a scan-time addition if ever wanted.
- **Bounds source.** Running client-side min/max is simplest but the ramp shifts as
  more tiles load (a tile's color isn't stable until bounds settle); a summary-level
  global min/max keeps colors stable from first paint. Prefer the latter if a cheap
  min/max is added to `scan_summary`.
- **Colorblind-safe ramp.** Pick a perceptually-uniform single-hue ramp (e.g.
  viridis-like) rather than a red↔green age gradient.

## Recommendation

Depends on [feature 0007](0007-display-settings-pane.md)'s settings pane existing to
host the **Type / Age** toggle. First cut: **files only**, **log-scaled age** against
**client-tracked min/max**, a **hand-rolled two-color ramp** (no new deps), and a
small gradient legend. Promote bounds to a summary-level min/max (stable colors) and
consider directory aggregates as follow-ups.

## Decision

Shipped the recommended first cut. Details of what landed:

- **`color.ts`** — `Colorable` gains `mtimeMs?`; a `ColorMode` (`"type" | "age"`)
  and `AgeBounds` type. `colorByAge(mtimeMs, bounds, now?)` log-scales age (now −
  mtime) onto a perceptually-uniform, colorblind-safe **viridis** ramp
  (`AGE_RAMP` = `#440154 → #21918c → #fde725`, dark/old → bright/new). `fillFor(node,
  mode, bounds)` dispatches: age-colors plain, non-errored **files** only;
  directories/symlinks/other/tail and errored files keep their `colorFor` neutral
  tones. Missing mtime falls back to a flat neutral.
- **Bounds** — client-tracked running **[oldest, newest]** mtime, widened as tiles
  load (`noteAgeBounds` in `MapTreemap.vue`, reset on reseed). The map emits an
  `@agebounds` event so `App.vue` can draw the legend; colors settle as bounds do
  (the accepted first-cut tradeoff — see the summary-min/max follow-up below).
- **`WorldNode`** carries `mtimeMs` (threaded through `layout.ts`); it already
  shipped on `TreeChild`, so **no protocol/server change**.
- **Setting** — `colorMode` added to `useDisplaySettings` (default `"type"`, no
  version bump — merges into existing stored prefs). A **Tile color** select in
  `DisplaySettings.vue`, plus a **duplicated compact "Color: Type / Age" select in
  the app header** (`App.vue` toolbar) for quick access, both bound to the same
  reactive setting.
- **Legend** — a small gradient bar (older ← → newer with the actual date bounds),
  shown in the treemap pane only while Age mode is active and bounds exist.

Verified end-to-end against a fixture with a 2017–2026 mtime spread: old files
render deep purple, newest bright yellow, directories stay neutral, and the header
select + Display-pane select stay in sync.

### Follow-ups (not done)

- Promote bounds to a **summary-level min/max** in `scan_summary` so colors are
  stable from first paint rather than shifting as tiles load.
- **Directory aggregates** (e.g. newest-descendant mtime) so folders can age-color
  too; today they stay neutral.
- ctime/atime modes (would need a scan-time capture change).
