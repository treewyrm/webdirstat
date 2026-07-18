# 0002 — Pan/zoom treemap (map-style navigation)

Status: **Done** — implemented as milestone 4 of
[issue 0002](../issues/0002-background-scanning-service.md). `d3-zoom` camera,
viewport-driven lazy nested layout fetching tiles via `POST /api/tree/batch`, LOD
by on-screen size, camera-derived focus/breadcrumbs, fly-to, shimmer placeholders.
See [MapTreemap.vue](../../client/src/components/MapTreemap.vue) +
[layout.ts](../../client/src/treemap/layout.ts).

Prerequisite: [issue 0002 — Background scanning service with a persistent
store](../issues/0002-background-scanning-service.md), specifically its change
**(B)** — a queryable store that serves the tree in **slices** (one directory's
children on demand) instead of one giant blob. **This prerequisite is now
committed (Decided).**
Related: [issue 0001 — Scaling to very large trees](../issues/0001-large-tree-scaling.md).

## Goal

Navigate the treemap like a map (Google Maps / OpenStreetMap): continuous
**pan** (drag) and **zoom** (wheel, centered on the cursor) over one stable
layout, instead of the current *re-root on drill* model where clicking a folder
throws away the whole treemap and lays out a fresh one around that folder's
contents.

The pain point being fixed: today drilling is discontinuous. The tiles you were
looking at vanish and a new, unrelated arrangement appears, so you lose your
sense of *where* you are in the tree. A map keeps the world fixed and moves the
camera — you always know where the thing you were just looking at is, because it
didn't move.

The user's framing captures the core mechanic: **zoom factor + which nodes fall
inside the viewport tells us which folders to draw, and to what depth.** That is
level-of-detail (LOD) rendering — the same idea as map tiles becoming more
detailed as you zoom in.

## Why issue 0002 is a prerequisite, not just related

The naive version of this feature lays out one nested treemap of the *entire*
subtree in the browser and treats pan/zoom as pure camera math over it. That
works at the thousands-of-files scale — but it re-hits the exact wall issues 0001
and 0002 describe: a full nested layout is O(nodes) in time and memory, so on a
~1.76M-file NAS the browser is again holding ~1GB of tree just to let you scroll
around it. Map-style navigation makes that *worse*, because the whole point is to
stay zoomed out over the entire volume.

But the fix falls out naturally once you notice the two problems are the same
shape:

> **Panning and zooming a map is a tile-fetching problem, and issue 0002's
> slice API is the tile server.**

As the camera moves, the viewport + zoom level determine which directories, at
which depths, are currently visible and big enough to matter. That is a *query*:
"give me the children of the directories intersecting this viewport, down to the
depth where tiles fall below N pixels." Issue 0002's `GET /api/tree?root&path`
slice endpoint answers exactly that, one directory at a time, from an indexed
store — no giant blob, no whole-tree layout, the browser only ever holds what's
on (or near) screen.

So this feature is a strong *reason to build* issue 0002's change (B), and (B) is
what makes this feature scale. They should be decided together.

## The key realization: nested treemap layout is already top-down per-directory

Squarified treemap layout of a directory places its **direct children** into that
directory's rectangle, needing only those children's names and sizes — which is
precisely one 0002 slice (and 0002 already stores each directory's aggregate
`size` precomputed bottom-up, so a slice carries the sizes the layout needs). So
the layout is inherently:

1. Lay out the root's children into the viewport → each child directory gets a
   world rectangle.
2. For any child directory whose rectangle is large enough on screen to show its
   interior, fetch *its* slice and lay its children into *its* rectangle.
3. Recurse only into directories the current zoom makes visible.

This is lazy, viewport-driven nested layout — the browser never lays out or holds
a directory it isn't looking at. It maps 1:1 onto map tiles: **each directory's
interior layout is a tile, fetched when zoom brings it into view, cached after.**

## Shape of the change

### 1. Camera as source of truth

State `{ scale, tx, ty }` mapping world → screen coordinates. Rendering applies
it via `ctx.setTransform` and the existing draw loop in
[Treemap.vue](../../client/src/components/Treemap.vue) stays largely the same,
just drawn under that transform.

- **Pan**: pointer drag updates `tx/ty`.
- **Zoom**: wheel updates `scale`, keeping the point under the cursor fixed
  (`s' = s·k`, `t' = cursor − (cursor − t)·k`).
- **Use `d3-zoom`** (`d3.zoom()` on the canvas) rather than hand-rolling
  wheel/drag math — it produces a `d3.zoomTransform` we feed straight into
  `setTransform`, and handles momentum, touch, and pinch.

### 2. Viewport-driven slice fetching + lazy layout

After every camera change, run the top-down walk above against what's **already
laid out**, and for each visible directory whose interior isn't laid out yet (and
is big enough on screen), request its 0002 slice. When a slice arrives, lay its
children into the parent's known rectangle and redraw. Keep an LRU-ish cache of
laid-out directories keyed by `root+path`; evict interiors far outside the
viewport to bound memory. This is the map's "load tiles for the current view."

### 3. Level of detail (the drawing rule)

Walk the laid-out world tree top-down while drawing. For each node compute its
on-screen size (`screen width/height`):

- **Off-screen** (rect doesn't intersect the viewport) → skip the subtree.
- **On-screen but small** (children would be < ~4px) → draw this node as a single
  tile, stop recursing (and don't fetch its slice).
- **On-screen and large** → recurse into children (fetching the slice if needed).

Draw cost is bounded by *screen pixels*, not tree size. Labels appear per-node
only when that node's on-screen box clears the text threshold (the existing
`w > 40 && h > 14` idea, applied per level).

### 4. Focus / breadcrumbs / list pane become *derived*

Today `focusPath` in [App.vue](../../client/src/App.vue) is the source of truth
and the treemap follows it. Invert it: the **camera** is the source of truth, and
"current folder" is derived — the deepest directory whose world rect fully
contains (or best covers) the viewport. Breadcrumbs and the list pane update
continuously as you zoom, which is exactly the "which folders am I looking at, to
what level" readout the user described.

- Clicking a tile / breadcrumb, or double-clicking, animates the camera
  (`d3-zoom` transition) to frame that node — drill becomes "fly to."
- Hit-testing moves to **world coords** (invert the camera transform on
  `offsetX/offsetY`) and must respect LOD: you hit whichever tile is actually
  drawn at the current depth, so the flat `laidOutLeaves` array becomes a
  depth-aware lookup.

## Open questions

- **Request batching / latency.** *(Resolved in 0002's API shape.)* The top-down
  walk can want several directories' slices for one viewport (many siblings all
  big enough to open at once). Firing N separate `GET /api/tree` requests per pan
  is chatty. 0002 now specifies **`POST /api/tree/batch`**: many directories'
  children (`depth: 1`) plus optional subtree spines (`depth > 1`, for the cold
  fly-to waterfall) in one round trip, keyed by node `id`, generation-pinned. Two
  things this feature must own on the **client** side: debounce to one batch per
  settled camera frame, dedupe against the laid-out-directory cache, and cancel
  stale in-flight batches on fast zoom-through — the endpoint affords batching but
  the client scheduling is what caps request volume.
- **Capped slices (0002's `limit`) vs. a stable layout.** *(Half-resolved: the
  batch response carries `omittedTail` — count + bytes past the cap — so the
  remainder rect can be reserved up front.)* Zooming into the long tail below the
  cap still needs a source for the items: either a paged slice request, or the
  "+M smaller items" tile expanding on demand. The layout must stay stable when
  that extra data arrives (append into the reserved remainder rect, don't reflow
  what's already drawn).
- **Loading states while tiles stream in.** A just-revealed directory is a blank
  rectangle until its slice returns. Needs a placeholder fill / shimmer so
  panning doesn't flash empty boxes, the map convention.
- **Layout stability across refreshes.** *(Mechanism resolved: 0002's tile API is
  generation-pinned — reads pin a `generation` and a swapped-out one returns
  409/410.)* The remaining **product** call is what to do on that signal: hold the
  pinned generation for the session (stable, but stale) or re-flow live with a
  "data updated" nudge. If sizes change under an open camera, interiors may need
  re-layout either way.
- **Zoom vs. re-root at extreme depth.** A folder buried 12 levels deep is a
  sub-pixel speck until hugely zoomed. Likely keep an explicit click-to-enter that
  recenters the camera (or re-roots) as a teleport, coexisting with free zoom.

## Recommendation

Build this **on top of issue 0002's slice store (change B)**, as viewport-driven
lazy nested layout: `d3-zoom` camera as source of truth, per-directory interiors
fetched as map-style tiles when zoom reveals them, LOD by on-screen size,
focus/breadcrumbs derived from the camera. This keeps the browser holding only
what's visible — the same property that makes 0002 worth building — instead of
re-importing the whole-tree memory problem the current model has.

Sequence: land 0002 (B) first (with the batch tile query below —
`POST /api/tree/batch` — baked into its API shape), then this feature. Decide the
two together, since this feature is a large part of the *why* for 0002.

## Decision

**Decided (2026-07-17): the slice-driven map-tile approach is the plan.** With
its prerequisite ([issue 0002](../issues/0002-background-scanning-service.md)) now
committed, this is the target navigation model — `d3-zoom` camera as source of
truth, per-directory interiors fetched as tiles when zoom reveals them, LOD by
on-screen size, focus/breadcrumbs derived from the camera. The batch tile query
it needs (`POST /api/tree/batch`) is being folded into 0002's API from the start.

Implementation waits on the store landing. The open questions above (capped-slice
paging, request batching, loading states, refresh stability, deep-zoom teleport)
are design details to settle during build, not blockers on the direction.
