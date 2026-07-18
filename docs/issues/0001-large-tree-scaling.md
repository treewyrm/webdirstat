# 0001 — Scaling to very large trees (~2M files)

Status: **Decided** — resolved via the background-service rework in
[0002](0002-background-scanning-service.md), not a standalone minimal fix.

Related: [0002 — Background scanning service](0002-background-scanning-service.md),
[feature 0002 — Pan/zoom treemap](../features/0002-pan-zoom-treemap.md).

## The problem

Target NAS has ~1.76M files. The original design (built/verified only against
thousands-of-files dirs like this repo's `node_modules`) didn't bound with file
count in two places:

1. **Server → client transfer.** The scan built the whole tree in memory, then
   sent it as one `JSON.stringify`'d string in a single SSE `done` message —
   plausibly several hundred MB to ~1GB of JSON, held in full on both server
   (mid-stringify) and browser (mid-parse) at once. Worst on a modest-RAM NAS
   container.
2. **Client rendering.** The treemap laid out and drew every leaf; most of 2M
   tiles are sub-pixel at any screen size, so it's wasted layout/draw/hit-test.

The walk itself was fine — already concurrency-limited (4 in-flight syscalls), and
a full recursive pass is inherent to accurate bottom-up directory sizes.

## Options considered

- **A — Capped rollup per directory.** Keep the full scan but ship only the top-N
  largest children, folding the rest into one synthetic "N other items" leaf with
  the real remainder sum. Smallest change (one function in `walk.ts`), bounds
  everything, but loses full itemization and keeps the "one scan, browse offline"
  model.
- **B — Fully lazy per-directory API.** Fetch one directory's children at a time
  on drill-in (ncdu-style). Preserves itemization but is a bigger protocol change.
- **C — Hybrid.** A by default, on-demand rescan of a rolled-up tile when clicked.

## Decision

**Decided (2026-07-17): fix at the root via the background-service rework, not any
standalone option here.** [Issue 0002](0002-background-scanning-service.md) — a
persistent store serving the tree in slices — addresses all three bottlenecks
*and*, unlike Option A, unlocks [feature 0002 (pan/zoom
treemap)](../features/0002-pan-zoom-treemap.md). The capping instinct survives as
0002's per-slice `limit` (size-sorted top-N, with an `omittedTail` remainder)
rather than a lossy fold baked irreversibly into the walk.
