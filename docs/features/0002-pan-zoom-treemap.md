# 0002 — Pan/zoom treemap (map-style navigation)

Status: **Done** — shipped as milestone 4 of
[issue 0002](../issues/0002-background-scanning-service.md). See
[MapTreemap.vue](../../client/src/components/MapTreemap.vue) +
[layout.ts](../../client/src/treemap/layout.ts); the live behavior is summarized
in [CLAUDE.md](../../CLAUDE.md) ("Client rendering").

## What it does

Navigate the treemap like a map (Google/OpenStreetMap): continuous **pan** (drag)
and **zoom** (wheel, cursor-centered) over one stable layout, replacing the old
*re-root on drill* model where clicking a folder threw away the treemap and laid
out a fresh one. The world stays fixed and the camera moves, so you never lose
your place. **Zoom + which nodes fall in the viewport decides which folders to
draw and to what depth** — level-of-detail rendering, exactly like map tiles.

## Why it needed issue 0002

The naive version lays out one nested treemap of the *entire* subtree in the
browser — O(nodes) time and memory, so on a ~1.76M-file NAS the browser is again
holding ~1GB just to scroll around, and worse here because the point is to stay
zoomed out over the whole volume. The fix: panning/zooming a map is a
tile-fetching problem and issue 0002's slice API is the tile server. Squarified
layout of a directory only needs its direct children's names and sizes — one 0002
slice — so the layout is inherently lazy and top-down: lay out the root's
children, recurse only into directories the current zoom makes big enough on
screen, fetch each interior as a tile when revealed, cache after. The browser
never holds a directory it isn't looking at.

## How it was built

- **Camera as source of truth.** `d3-zoom` on the canvas produces a transform fed
  straight into `ctx.setTransform`; focus/breadcrumbs/list are *derived* — the
  deepest directory whose world rect fully contains the viewport.
- **Viewport-driven fetch + LOD.** After each settled camera frame, walk the
  laid-out world tree: skip off-screen subtrees, draw on-screen-but-small nodes as
  a single tile (no recurse, no fetch), recurse+fetch on-screen-and-large ones.
  Draw cost is bounded by screen pixels, not tree size. Interiors fetched via
  `POST /api/tree/batch`; click/breadcrumb animates a fly-to.
- **Client discipline the design requires:** debounce to one batch per settled
  frame, dedupe against an LRU of laid-out directories, `AbortController`-cancel
  batches made stale by fast zoom-through, evict interiors far outside the
  viewport. The endpoint affords batching; client scheduling is what caps request
  volume.

## Open questions — how they resolved

- **Request batching** → `POST /api/tree/batch` (many dirs' children + optional
  subtree spines in one trip, keyed by id, generation-pinned).
- **Capped slices vs. stable layout** → the batch response carries `omittedTail`
  (count + bytes past the cap) so a "+M smaller items" remainder rect is reserved
  up front; the long tail below the cap is not yet paged/expandable on zoom-in.
- **Loading states** → animated gradient-pan shimmer on tiles awaiting data.
- **Layout stability across refreshes** → tile reads are generation-pinned; a
  swapped-out generation returns 410 and the client re-seeds from its path anchor.
- **Deep-zoom teleport** → click-to-fly-in recenters the camera (with a spine
  prefetch), coexisting with free zoom.

Related: [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md),
[issue 0001 — Scaling to very large trees](../issues/0001-large-tree-scaling.md).
