# 0001 — Scaling to very large trees (~2M files)

Status: **Decided** — resolved via the background-service rework in
[0002](0002-background-scanning-service.md), not the standalone minimal fix.

Related: [0002 — Background scanning service](0002-background-scanning-service.md),
[feature 0002 — Pan/zoom treemap](../features/0002-pan-zoom-treemap.md).

## Context

Target NAS has ~1.76M files on the share we'd point this at. The current scan/render
path was built and verified against directories in the thousands-of-files range
(this repo's own `node_modules`), not millions.

## Problem

Two parts of the current design don't bound with file count:

1. **Server → client transfer.** [scanTree](../../server/src/scan/walk.ts) builds the
   entire tree in memory, then [the scan route](../../server/src/routes/scan.ts) sends
   it as one `JSON.stringify`'d string in a single SSE `done` message. At ~2M files
   this is plausibly several hundred MB to ~1GB of JSON, held in full on the server
   (mid-stringify) and in the browser tab (mid-parse) at the same time. Worst place
   for that to bite is exactly a NAS-class container with modest RAM.
2. **Client rendering.** [Treemap.vue](../../client/src/components/Treemap.vue) lays
   out and draws every leaf via `d3-hierarchy`. Most of 2M tiles would be sub-pixel
   at any screen size, so it's wasted layout/draw/hit-test work, and redraws on
   resize/drill will lag.

The scan walk itself ([walk.ts](../../server/src/scan/walk.ts)) is comparatively fine —
it's already concurrency-limited (default 4 in-flight syscalls) so it won't hammer
the NAS's disks, and a full recursive pass is inherent to getting accurate bottom-up
directory sizes no matter what we do downstream.

## Options

### A — Capped rollup (per directory)

Keep the full recursive scan (needed for accurate sizes), but when building each
directory's `children`, keep only the top N largest (files and subdirectories
combined, N ~100–300) and fold the rest into one synthetic leaf:
`{ name: "N other items", kind: "other", size: <real sum of the remainder> }`.

- Directory sizes stay exactly correct — the rollup size is a real sum, not an estimate.
- Bounds memory, JSON size, and rendered node count to a fixed ceiling independent
  of actual file count.
- Loses the ability to see every individual small file/dir in the treemap or list
  pane — by design, since they're not visible at that scale anyway.
- Smallest change: contained to `walk.ts`'s child-collection step.

### B — Fully lazy, per-directory API

Don't ship the whole tree at once. Client fetches one directory's immediate
children (with sizes) at a time, on drill-in — closer to how `ncdu` works.

- Preserves full itemization at every level, however deep.
- Bigger protocol change: needs a new endpoint, and the aggregate size for a
  directory still requires a full recursive pass under the hood *before* any
  size can be shown — so either that pass still happens eagerly (same memory
  cost as today, just not shipped to the client in one shot), or sizes are
  computed lazily too and the UI can't show accurate totals until each
  subdirectory has been visited.
- More round-trips, more moving parts, no longer a "one scan, browse offline" model.

### C — Hybrid: capped rollup + on-demand expansion

Do A by default. When a user clicks into a rolled-up "N other items" tile, fire a
targeted rescan of just that directory (cheap — it's usually a small subtree by
definition, since the big stuff was already promoted out).

- Same bounded cost as A in the common case.
- Recovers full itemization for the rare directory where someone actually wants
  to see every file.
- Extra complexity: a second scan entry point, and a rollup node needs to
  remember the real directory path it was aggregated from.

## Recommendation

Start with **A**. It directly fixes all three bottlenecks (memory, transfer,
render) with a change scoped to one function, and a WinDirStat-style tool is
about finding the big offenders, not itemizing every 4KB file. Revisit **C**
only if in practice people want to drill past the cap.

## Decision

**Decided (2026-07-17): fix this at the root via the background-service rework,
not the standalone minimal option.** We're committing to
[issue 0002](0002-background-scanning-service.md) — a persistent store that serves
the tree in slices — which addresses all three bottlenecks above (server→client
transfer, client memory, render count) *and*, unlike Option A, unlocks
[feature 0002 (pan/zoom treemap)](../features/0002-pan-zoom-treemap.md).

Option **A** (capped rollup) is **not** pursued as a standalone change. The
capping instinct still holds, but it moves into 0002's API as a per-slice `limit`
(size-sorted top-N per directory, paged/expandable) rather than a lossy fold
baked irreversibly into the walk. The options above are kept for history; see
0002 for the chosen design.
