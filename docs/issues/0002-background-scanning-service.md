# 0002 — Background scanning service with a persistent store

Status: **Done** — built milestone by milestone; all four landed and verified
end-to-end. This replaced the original "one scan, ship the whole tree as one JSON
blob, browse offline" model, which didn't bound with file count
([0001](0001-large-tree-scaling.md)). The live architecture is documented in
[CLAUDE.md](../../CLAUDE.md); this doc is the historical record of the rework and
the decisions behind it.

Two separable changes, justified independently:

- **(B) Persist results in a queryable store, serve slices** — the load-bearing
  change. Fixes *scale*: the server never stringifies a 2M-node tree and the
  client never holds more than one directory's children. The NAS target is
  ~1.76M files.
- **(A) Move scanning off the request path** — background/scheduled scans in a
  worker. Fixes *UX*: data is always present with a freshness stamp; no
  scan-and-wait. **Opt-in per root** — with it off the service degrades to a
  manual Start/Stop scanner over the same store, without dragging back the blob
  problem (reads are slices either way).

## What shipped

- **Milestone 1 — the slice store (B).** Embedded `node:sqlite`
  ([`store/`](../../server/src/store)), generation-aware flat `node` table with
  the search/rollup columns baked in (`ext`, `mtime_ms`, `type_rollup`,
  `scan_summary`). Streaming store-writing walk
  ([walk.ts](../../server/src/scan/walk.ts) + [persist.ts](../../server/src/scan/persist.ts))
  stages a full re-walk and atomic-swaps it in with history pruning.
  [`GET /api/tree`](../../server/src/routes/tree.ts) serves one size-sorted,
  capped directory level with generation pinning. The whole-tree JSON blob is
  gone.
- **Milestone 2 — background refresh + scheduler (A).** Scan runs in a
  `worker_threads` worker ([scan-worker.ts](../../server/src/scan/scan-worker.ts))
  with its own DB connection (WAL: one writer, concurrent readers). Observable
  single-flight state machine ([scanner.ts](../../server/src/scan/scanner.ts)) —
  `idle → scanning → swapping → idle`, `queue`/`preempt`/stop — over
  `GET /api/status` (SSE). Scheduler ([scheduler.ts](../../server/src/scan/scheduler.ts))
  composes freshness + window gates, sleeping to the next relevant instant;
  tz-aware weekly windows incl. cross-midnight and `onWindowEnd` abort
  ([schedule.ts](../../server/src/scan/schedule.ts)). DB-backed per-root settings
  seeded from env, editable via `GET`/`PUT /api/roots/:id/schedule`. Persisted
  `lastScan*` defeats a restart-storm rescan. Server bundling moved tsup →
  **tsdown** to preserve the `node:sqlite` specifier.
- **Milestone 3 — `POST /api/tree/batch` tile query.**
  ([batch.ts](../../server/src/routes/batch.ts)) Many directories' children
  (`depth: 1`, the frontier) plus size-pruned subtree spines (`depth > 1`, cold
  fly-to) in one round trip, flat + keyed by id, with `resolved[]` so
  path-anchored fly-tos learn their id. Generation-pinned (410 on stale);
  guardrails on requests-per-batch, per-level limit, depth, and a total-nodes
  budget with a `truncated` signal.
- **Milestone 4 — full pan/zoom treemap client.**
  ([feature 0002](../features/0002-pan-zoom-treemap.md)) `d3-zoom` camera as
  source of truth, LOD by on-screen size, interiors fetched as tiles when zoom
  reveals them, breadcrumbs/list derived from the camera, generation-pinned reads
  that re-seed on a swap.

## Key design decisions (the "why", for future changes)

- **`node:sqlite` over `better-sqlite3`** — no native build step, no ABI rebuild
  per Node version, one fewer dependency. Requires Node 24+ (flag-free there).
- **Flat generation-aware table, not nested JSON.** `(parent_id, size DESC)`
  index makes "children of X, largest first, top N" one query. Directory
  aggregate `size` is precomputed bottom-up at scan time so reads never recompute.
  ~2M rows ≈ 200–400 MB — fine on NAS.
- **Schema decided up front for features that can't retrofit cheaply:**
  generation-keyed rows so history is a config knob (`HISTORY_GENERATIONS`, `0` =
  none) not a rebuild ([feature 0003](../features/0003-history-and-diff.md)); an
  `ext` column + `mtime_ms` index for search
  ([0004](../features/0004-search-and-filter.md)); a `type_rollup` table filled in
  the single walk pass ([0005](../features/0005-file-type-rollup.md)). The UIs
  come later; the columns had to be there from the first migration.
- **Stage-then-atomic-swap refresh.** Full re-walk into a staging generation,
  then flip a pointer. Reads always see one complete, consistent tree; a
  stopped/preempted scan just drops staging and never corrupts the live view.
  Incremental rescan deferred to v2 (a dir-mtime skip misses in-place file
  size changes, so it needs periodic full walks anyway — an optimization, not a
  correctness substitute).
- **Node identity: path (durable) + id (in-session).** Not inode (non-unique
  across volumes, reused after deletion, absent on SMB/NFS/FUSE, semantically
  many-paths-to-one). Path is the cross-generation anchor for entry points /
  bookmarks; the integer `id` is a compact opaque handle valid only within a
  pinned generation. `id`s are generation-scoped (reassigned each swap) and carry
  no traversal attack surface — only `root_id` ownership is checked; lexical +
  realpath guards stay at the path entry points
  ([resolve-path.ts](../../server/src/scan/resolve-path.ts)).
- **Generation pinning.** Every read pins a `generation`; a request against a
  swapped-out one returns 410, and the client re-seeds from its durable path
  anchor. This is what keeps a multi-tile interaction from stitching pre- and
  post-swap subtrees together.
- **Single-flight scanner is an invariant, not a policy.** One lock, one
  `AbortController`; `start` while `scanning` is rejected (409) — the caller must
  `preempt` (stop-then-start-mine) to replace it. Scans serialize globally across
  roots (one spindle); per-root concurrency governs syscalls *within* a walk.
  Stop cancels the one walk and leaves the scheduler alone.
- **Scheduler = enable switch + two composable gates.** `enabled: false` →
  automatic scans never fire but manual `POST /api/scan` still works. When on, a
  scan fires only when *stale past `interval`* AND *inside an allowed wall-clock
  window* AND *not already running* AND *past the `minInterval` floor*. Windows
  are stored as tz id + local `HH:MM` (DST shifts with the clock), may cross
  midnight. `onWindowEnd=finish` is the default (let a started scan complete);
  `abort` is the opt-in hard disk-quiet ceiling.

## Non-goal — the viewer is strictly read-only

It scans, stores, and *shows*; it never deletes, moves, renames, or writes into
the scanned roots (mounted read-only in the container). A disk-usage tool that can
also delete is a foot-gun on a NAS and would drag in a whole write-side
permissions/undo surface. The sanctioned help is to hand the user the info to act
elsewhere — copy/export selected paths
([feature 0006](../features/0006-export-paths.md)) — leaving the destructive
action entirely with the user.

Related: [0001 — Scaling to very large trees](0001-large-tree-scaling.md) (the
problem this resolved), [feature 0002 — Pan/zoom treemap](../features/0002-pan-zoom-treemap.md)
(the navigation this store enables).
