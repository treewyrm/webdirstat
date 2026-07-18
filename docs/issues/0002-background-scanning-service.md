# 0002 — Background scanning service with a persistent store

Status: **Done** — built milestone by milestone; all four milestones landed and
verified end-to-end. Full design: change (B) store as the load-bearing piece,
change (A) background refresh on top.

**Build progress:**
- ✅ **Milestone 1 — the slice store (change B).** Embedded `node:sqlite`
  ([`store/`](../../server/src/store)), generation-aware flat `node` table with the
  decide-now schema (ext/mtime for search, `type_rollup`, `scan_summary`), a
  streaming store-writing walk ([walk.ts](../../server/src/scan/walk.ts) +
  [persist.ts](../../server/src/scan/persist.ts)) that stages a full re-walk and
  atomic-swaps it in with history pruning, and
  [`GET /api/tree`](../../server/src/routes/tree.ts) serving one size-sorted,
  capped directory level with generation pinning. Client reworked to lazy per-level
  slice fetching. **The whole-tree JSON blob is gone.**
- ✅ **Milestone 2 — background refresh + scheduler (change A).** Scan runs in a
  `worker_threads` worker ([scan-worker.ts](../../server/src/scan/scan-worker.ts))
  with its own DB connection (WAL: one writer, concurrent readers). Observable
  single-flight state machine ([scanner.ts](../../server/src/scan/scanner.ts)) —
  `idle → scanning → swapping → idle`, `queue`/`preempt`/stop — exposed over
  `GET /api/status` (SSE). Scheduler ([scheduler.ts](../../server/src/scan/scheduler.ts))
  composes the freshness + window gates with a sleep-to-next-instant timer;
  timezone-aware weekly windows incl. cross-midnight and `onWindowEnd` abort
  ([schedule.ts](../../server/src/scan/schedule.ts)). DB-backed per-root settings
  seeded from env (`SCAN_INTERVAL`, `SCAN_WINDOWS`, `SCAN_CONCURRENCY`,
  `HISTORY_GENERATIONS`, …), editable via `GET`/`PUT /api/roots/:id/schedule`.
  Persisted `lastScan*` defeats a restart-storm rescan. Client gets a live
  Start/Stop button, staleness stamp, and schedule editor. Graceful shutdown
  checkpoints the WAL. Server bundling moved from tsup (esbuild) to **tsdown**
  (rolldown), which preserves the `node:sqlite` specifier.
- ✅ **Milestone 3 — `POST /api/tree/batch` tile query.**
  ([batch.ts](../../server/src/routes/batch.ts)) Many directories' children
  (`depth: 1`, the frontier) plus size-pruned subtree spines (`depth > 1`, the
  cold fly-to) in one round trip, response flat + keyed by directory id, with a
  `resolved[]` array so path-anchored fly-tos learn their id. Anchors are
  `{parentId}` (root/generation-ownership checked, no traversal surface) or
  `{path}` (in-store traversal-guarded). Generation-pinned (410 on stale);
  guardrails on requests-per-batch, per-level limit, depth, and a total
  nodes-per-response budget with a `truncated` signal. Generation pinning shared
  with the tree route ([generation.ts](../../server/src/routes/generation.ts)).
  Client `fetchTreeBatch` helper added (consumed in M4).
- ✅ **Milestone 4 — full pan/zoom treemap client ([feature 0002](../features/0002-pan-zoom-treemap.md)).**
  `d3-zoom` camera as source of truth over a fixed world
  ([layout.ts](../../client/src/treemap/layout.ts) lays out one directory level at
  a time into world rects; [MapTreemap.vue](../../client/src/components/MapTreemap.vue)
  draws it). Level-of-detail rendering bounded by on-screen tile size; interiors
  fetched as map tiles via `POST /api/tree/batch` when zoom reveals them, with the
  client discipline the design calls for — debounce to one batch per settled camera
  frame, dedupe against the laid-out tree, `AbortController`-cancel stale batches,
  LRU eviction. Breadcrumbs + list + "current folder" **derived from the camera**
  (deepest directory that fully contains the viewport). Click-to-fly-in with a
  spine prefetch; animated gradient-pan shimmer on tiles awaiting data;
  generation-pinned reads that re-seed on a swap (410). The old re-root-on-drill
  model is gone.

Related: [0001 — Scaling to very large trees](0001-large-tree-scaling.md)
(the scaling problem this resolves),
[feature 0002 — Pan/zoom treemap](../features/0002-pan-zoom-treemap.md)
(the navigation feature this store enables).

## Context

The current design is stateless and on-demand: the client hits
[`/api/scan`](../../server/src/routes/scan.ts), the server walks the tree
([walk.ts](../../server/src/scan/walk.ts)) while streaming progress over SSE,
then ships the **entire** tree in one `JSON.stringify`'d `done` message. The
client holds the whole tree in memory and browses it offline.

That model was built and verified against thousands-of-files directories. The
target is a NAS with ~1.76M files, where it breaks down in two ways already
captured in 0001 (server→client transfer of hundreds of MB to ~1GB of JSON;
rendering millions of sub-pixel tiles), plus a UX cost specific to the on-demand
model: every view starts with "click scan, wait minutes, then browse."

This doc proposes a different shape: a **background scanning service** that owns
a persistent store, rescans configured roots on a schedule, and serves the UI
slices of the tree on demand instead of one giant blob.

## Two separable changes

The proposal bundles two changes that solve different problems and are worth
justifying independently:

- **(A) Move scanning off the request path** — background/scheduled scans in a
  worker. Fixes *UX*: data is always present with a freshness stamp; no manual
  scan-and-wait.
- **(B) Persist results in a queryable store and serve slices** — the UI fetches
  one directory level at a time. Fixes *scale*: the server never stringifies a
  2M-node tree and the client never holds more than one directory's children.

**(B) is the change that actually fixes the NAS problem.** (A) alone (background
scan, but still handing the whole tree to the browser) just relocates the wait
and keeps the ~1GB-JSON bottleneck. Once data lives in a queryable store, (A)
comes almost for free.

**Design property — (A) is opt-in per root.** The background scheduler is a
switch (`enabled`, see the scheduling section), not a hard dependency. With it
**on**, this is the always-fresh background service. With it **off**, the service
degrades gracefully to a manual, on-demand scanner — Start/Stop only, no
automatic walks — over the exact same store. Because (B) is always present
underneath, "manual-only" does **not** drag back the ~1GB-blob problem: the
client reads slices either way. So the same build serves both postures, and it's
the operator's choice per root, not a compile-time mode.

## Proposed design

### Store — embedded SQLite (`node:sqlite`)

Single-container app; no reason to run a separate DB service. Use Node's
**built-in** SQLite module (`node:sqlite`) rather than a third-party binding like
`better-sqlite3` — no native `node-gyp` build step, no ABI-per-Node-version
rebuild, one less dependency to keep current. It exposes a synchronous
`DatabaseSync` / prepared-statement API that's a near drop-in for the
`better-sqlite3` style the queries below assume.

- Requires **Node 24+** (already pinned in [`.nvmrc`](../../.nvmrc) and
  `package.json` `engines`). `node:sqlite` landed in 22.5.0 behind
  `--experimental-sqlite` and the flag was dropped in 22.13/23.4; pinning to the
  Node 24 LTS gets it flag-free. The module is still marked experimental, so
  expect the occasional API tweak across minors.

A **flat** node table, not nested JSON:

```
node(id, root_id, parent_id, name, kind, size, mtime_ms, child_count, error)
index (parent_id, size DESC)
```

- 2M rows at ~100–200 B each ≈ a 200–400 MB DB file — fine on NAS.
- "Children of directory X, largest first, top N" is one indexed query.
- Directory aggregate `size` is precomputed bottom-up at scan time (the walk
  already does this) and stored, so reads never recompute.
- Host paths stay server-side; the client **enters** the tree by `root` +
  relative `path` as today, then navigates by node `id` within a generation (see
  the identity section under API shape).

#### Schema decisions to make *now* (the store-enabled features force them)

The store unlocks capabilities the old whole-tree-in-browser model couldn't do at
all — history/diff, search, type rollups (each its own feature doc). Most can be
layered later, but three touch the **schema/scan-time** and are expensive to
retrofit, so decide them before the first migration even if the UI comes later:

- **Build the store generation-aware so history is *possible* — the amount is
  config.** The decide-now part is only that the schema is keyed by `generation`
  and the swap **deletes by retention policy, not unconditionally**, so keeping
  history is a config knob rather than a rebuild. *How many* generations to keep is
  a runtime setting (`HISTORY_GENERATIONS`, default low, **`0` = keep none** for
  users who don't want history) — a full generation is another ~200–400 MB at the
  2M target, so this is a real storage lever the operator owns. The tiny
  `scan_summary(generation, root_id, ended_ms, total_bytes, total_count, duration_ms)`
  row per swap is near-free (kilobytes) and the basis for trend lines + a scan ETA;
  default it on but let it be disabled too. Keeping ≥1 full generation is what
  enables **diff** (added/removed/grown/shrunk). See
  [feature 0003 — history & diff](../features/0003-history-and-diff.md).
- **Carry the columns/indexes search needs.** A queryable store makes "files >1 GB
  anywhere", "every `.iso`", "untouched in 2 years" one indexed query — but only
  if the data is there: an **`ext`** column (split at scan time), an index on
  **`mtime_ms`**, optionally FTS on `name`. Cheap at scan time, a full re-walk to
  backfill otherwise. See [feature 0004 — search & filter](../features/0004-search-and-filter.md).
- **Accumulate the type rollup during the walk.** The signature WinDirStat view
  ("41 GB of `.mov`") is a per-root `ext → {bytes, count}` aggregate the walk can
  fill in its single existing pass into a small `type_rollup` table. One pass now
  vs. a re-walk later. See [feature 0005 — file-type rollup](../features/0005-file-type-rollup.md).

The existing **`error`** column already supports surfacing unreadable subtrees (a
correctness-perception fix — a permission-denied dir silently reads as zero
bytes); that's API/UX only, no schema change, so it's a fast-follow rather than a
decide-now.

### Scanner — a single worker thread

Scan runs in a `worker_threads` worker, scheduled and manually triggerable.

- The walk is **I/O-bound** — `readdir`/`lstat` already run on libuv's
  threadpool — so a worker does *not* make the scan faster. What it buys is
  keeping the HTTP event loop responsive and doing DB-write/diff CPU work off
  the main thread.
- **Do not** build a large worker pool: parallel stat storms hurt spinning NAS
  disks. Keep the existing concurrency limiter (default 4 in-flight syscalls,
  [limiter.ts](../../server/src/scan/limiter.ts)).

### Refresh — stage then atomic swap (first cut)

Full re-walk into a staging generation, then flip a pointer atomically. Reads
always see a complete, consistent tree; no half-updated state is ever visible. A
2M-file re-walk is minutes-to-tens-of-minutes, but it's background.

### Incremental rescan — later, with a caveat

The tempting optimization is "skip any subtree whose directory mtime is
unchanged." It only half-works: a directory's mtime changes on entry
add/remove/rename, but **not** when an existing file's contents (and size)
change in place — that bumps only the *file's* mtime, not the parent
directory's. So a pure dir-mtime skip misses files that grew/shrank without the
directory's entry list changing. Usable as an optimization *if* periodic full
re-walks still run to correct drift; not a correctness substitute. Ship
swap-based full rescans first; treat incremental as v2.

### Service configuration — concurrency & scheduling

The service is meant to live unattended on a NAS, so *when* and *how hard* it
scans must be operator-controllable. Two independent knobs, deliberately kept
orthogonal:

- **Concurrency** — how many syscalls are in flight at once (disk pressure).
- **Schedule** — *when* a rescan is allowed to run at all (wall-clock windows)
  and *how often* one is wanted (staleness interval).

#### Concurrency limiter

Already exists ([limiter.ts](../../server/src/scan/limiter.ts)) with a hardcoded
default of 4. Promote it to a configured value:

- **Global default**, overridable **per root** — roots can sit on different
  physical disks (a spinning NAS volume vs. a local SSD cache), and the gentle
  number for one is wasteful for the other. The per-root value flows into the
  limiter for that root's walk.
- Lower is gentler on spinning disks (less seek thrash, less audible spin-up);
  higher saturates SSD/NVMe. Default stays **4** — safe for the target NAS.
- **Optional pacing delay** (v2): a per-operation sleep (`readdir`/`lstat` spaced
  by N ms) for an "extra quiet" mode that bounds *rate*, not just parallelism.
  Concurrency caps how many at once; pacing caps how fast. Skip for the first
  cut — concurrency alone covers the stated need.

#### Scheduler — enable switch + two gates that compose

The scheduler has a master **`enabled`** boolean, independent of the scanner
state. `enabled: false` means *automatic* scans never fire — the scheduler is
dormant — but **manual `POST /api/scan` still works**, and any scan already
running is left alone (disabling the schedule is not a stop; use Stop for that).
This is the clean way to say "don't rescan on your own, I'll trigger it myself":
one flag, no need to clear the windows or set a huge interval to fake it. It's
per-root (a root can be manual-only while others stay scheduled) and lives in the
same DB-backed settings, editable in the UI.

When `enabled: true`, a rescan fires only when **both** gates below open, and
never while one is already running:

1. **Freshness gate (how often):** data is older than `interval` → a rescan is
   *wanted*. `interval` is a max-staleness target ("keep this no more than 6h
   old"), not a fixed alarm clock.
2. **Window gate (when allowed):** now falls inside an allowed wall-clock window
   → a rescan is *permitted*. Empty window list = always permitted.

```
scan when:  wanted (stale past interval)
        AND permitted (inside an allowed window)
        AND not already running
        AND past minInterval floor since the last scan
```

This composition is the whole point of splitting them, and it directly answers
the "don't fire up noisy drives at 3am" concern:

| interval | windows | behavior |
|---|---|---|
| `6h` | `Mon–Fri 01:00–05:00` | wants a refresh every 6h, but only ever runs it in the overnight window; daytime staleness is accepted until the window opens |
| unset | `01:00–05:00` daily | scan once at the **start of each window** (always "stale" → runs as soon as permitted) |
| `6h` | none | pure interval; runs every 6h whenever it comes due |
| unset | none | manual-only by omission (prefer `enabled: false` to say this explicitly) |

- **`minInterval` floor** — a hard minimum gap between scans regardless of the
  above, so a flapping mtime or a stale-at-window-open + immediate manual trigger
  can't back-to-back re-walk. Defaults to something like `1h`.

#### Window semantics

- **Weekly recurring windows**, each `{ days, from, to }` in **local wall-clock
  time** — off-peak is a human, local-time concept, so windows are evaluated
  against a configured IANA timezone (default: the container's `TZ` /
  `Intl.DateTimeFormat().resolvedOptions().timeZone`). Do **not** store UTC
  offsets; store the tz id + local `HH:MM` so DST shifts the window with the
  clock automatically. (The one ambiguous/skipped hour at a DST transition is an
  accepted edge; document, don't engineer around it.)
- Windows may **cross midnight** (`22:00–04:00`) and **span multiple days**;
  normalize to a set of `[start, end)` instants when computing the next boundary.

#### What happens at window end (`onWindowEnd`)

A full re-walk can outlast its window. Behavior is configurable; pick the default
for correctness + simplicity:

| mode | on window close mid-scan | trade-off | ship? |
|---|---|---|---|
| **`finish`** (default) | let the running scan complete | simplest; correct with staging+swap; disks are already spun up | **v1** |
| `abort` | cancel via `AbortController`, drop the staging generation, retry next window | strict disk-quiet guarantee; wastes the partial walk; a tree that never finishes in one window never updates (needs a warning) | v1 (opt-in) |
| `pause` | checkpoint staging + resume cursor, continue next window | least wasted work; requires persisting partial staging state + a resumable walk | **v2** |

Default `finish`: a scan that *started* inside a window is allowed to run to
completion. `abort` is the escape hatch for operators who need a hard ceiling on
disk activity and accept that very large trees may never refresh under tight
windows.

#### Manual trigger vs. the schedule

`POST /api/scan` is **user intent and bypasses both gates** (a `force` scan runs
now regardless of interval/window). It still respects the concurrency limiter —
it changes *when*, never *how hard*.

It interacts with the global single-scan lock in one of two ways, selectable per
request:

| mode | if a scan is already running | use when |
|---|---|---|
| **`queue`** (default) | wait behind it; run when the lock frees | "refresh soon," politeness — no wasted work |
| `preempt` | cancel the running scan (`AbortController`, drop its staging generation), then start this one | "I need *this* now" — a scheduled scan is hogging the drive, or the user just made a change they want reflected immediately |

Preempt is the queue-jump: user intent outranks an in-flight *scheduled* scan.
Notes that keep it honest:

- **It aborts, it doesn't stack** — the preempted scan's partial walk is
  discarded (same cost as `onWindowEnd=abort`); staging+swap means nothing
  half-written is ever visible, so this is safe, just wasteful of the work so far.
- **Preempting the same root that's already scanning** = restart it from scratch.
  Legitimate ("capture the change I just made") but pointless if nothing changed;
  the UI should make `preempt` a deliberate choice, not the default button.
- **Two manual requests** don't fight: the second either queues or preempts the
  first per its own mode. Only one scan ever runs.
- A preempt still can't run *two* scans at once — it replaces the running one, it
  doesn't run alongside it. The "one scan at a time" invariant below holds.

#### Scan state — observable and single-flight

There is **one scanner**, and it is a small explicit state machine, exposed
verbatim over the API so the UI is a direct reflection of it (no guessing from
side effects):

```
idle ──start──▶ scanning ──walk done──▶ swapping ──▶ idle
  ▲                 │
  └──── stop ───────┘   (abort: drop staging, no swap)
```

- **`idle`** — no walk running. *When* the next scan fires is a per-root fact
  (`nextScanAt` in each root's status), since each root schedules independently;
  the scanner state itself is global (one scanner, all roots).
- **`scanning { root, startedAt, progress, trigger }`** — a walk is in flight.
  `trigger` records *why* (`scheduled` | `manual` | `preempt`) so the UI can say
  "scheduled scan running" vs. "you started this." `progress` reuses the existing
  throttled progress the walk already emits.
- **`swapping`** — walk complete, staging generation being flipped in
  (near-instant; a distinct state mostly so a reader knows the store is mid-swap).

**Single-flight is the invariant, not just a policy.** The scanner is one lock,
one `AbortController`. `start` when already `scanning` is **rejected** (409) — the
caller must `preempt` if they mean "replace it." This is why simultaneous scans
are structurally impossible, not merely discouraged: there is nothing to run a
second walk *on*.

#### Start / stop control

The manual button is a **toggle over that state**: `idle` shows **Start**,
`scanning` shows **Stop**.

- **Start** = `POST /api/scan` (force; `mode` from the preempt section). Enabled
  only when `idle`; while `scanning` the button is the stop control instead.
- **Stop** = cancel the running walk: fire the `AbortController`, **drop the
  staging generation**, return to `idle`. The last committed tree is untouched
  (staging+swap again — a stopped scan never corrupts the live view; it just
  doesn't advance it). Distinct from `preempt`, which is *stop-then-start-mine*;
  plain stop just stops.
- **Stop does not touch the scheduler.** It cancels the one walk and nothing
  else; if the schedule says another scan is due inside an open window, it fires
  again on the normal terms (subject to `minInterval`). Stopping the scanner and
  stopping the *scheduler* are separate controls — see `enabled` below. This
  keeps Stop meaning exactly one thing.

The state feeds the global `GET /api/status` below; the button derives entirely
from it, so a scan started by the *scheduler* still shows a live **Stop** to any
client — the control reflects the system, not just this session's actions.

#### Multiple roots — one scan at a time

Scans are **serialized globally**: only one root walks at a time, even when both
come due together, so two roots on the same spindle can't double the disk load.
Additional due/triggered roots **queue**. (Per-root concurrency governs syscalls
*within* a single root's walk; the global lock governs *across* roots.) The
single-flight state machine above is what enforces this — the queue feeds the one
scanner slot.

#### Scheduler mechanics & persistence

- Persist `lastScanStartedAt` / `lastScanEndedAt` / `lastScanStatus` per root in
  the DB so restarts don't re-walk fresh data — on startup, compute the next
  action from persisted state, not from "now." This defeats a restart-storm
  rescan.
- Implement as a **timer that sleeps to the next relevant instant** (the min of:
  next staleness deadline, next window boundary) and recomputes, rather than a
  busy 60s poll. A coarse tick is acceptable as a first cut but the compute-next-
  wake form is cleaner and idles the process.

#### Where config lives

Now that there's a DB, config has two tiers:

- **Bootstrap from env** — `SCAN_CONCURRENCY`, `SCAN_INTERVAL`, `SCAN_WINDOWS`
  (e.g. `SCAN_WINDOWS="Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00"`),
  `HISTORY_GENERATIONS` (full generations to retain; `0` = none), matching the
  existing `ROOTS` env-var style. Fine for a headless first cut.
- **DB-backed settings, editable via the UI** — a `settings` table (or per-root
  columns) is the real home: per-root concurrency and per-root windows are
  awkward to express in a flat env string, and "let the NAS admin pick quiet
  hours in the UI" is exactly the ask. Env values seed the defaults; the UI
  overrides and persists them. A `PUT /api/roots/:id/schedule` completes the
  status/trigger endpoints below.

### API shape

- `GET /api/roots` — unchanged.
- `GET /api/status` — the **global scanner** state (`idle` | `scanning` |
  `swapping`) with its payload (which `root` is walking, `trigger`, live
  `progress`), the **current `generation`** (see below), and the queue of roots
  waiting behind it. There is one scanner, so this is global, not per-root — it is
  the single source the start/stop button derives from; push it over SSE (or poll)
  so the button and progress stay live without a manual refresh.
- `GET /api/roots/:id/status` — **per-root** facts: last scan time, entry/byte
  totals, this root's relation to the scanner (`scanning` now | `queued` | not
  active), **plus scheduler state**: `enabled`, current window open/closed,
  `nextScanAt` (so the UI can say "next refresh tonight at 01:00"), and whether the
  last run was cut short (`abort` mode / overrun).
- `GET /api/tree?root&path&limit&generation` — one directory's children,
  size-sorted, capped. The **path entry point** into the tree; each returned
  child carries its `id` (see identity below) for subsequent id-addressed fetches.
  Cache-friendly; good for cold first paint and debug.
- `POST /api/tree/batch` — the **tile endpoint** for map navigation: many
  directories' children (and optional subtree spines) in one round trip. Shape
  below.
- `POST /api/scan` — **start** a rescan now (`force`, bypasses interval + window
  gates). `mode=queue` (default) waits behind any running scan; `mode=preempt`
  cancels the running scan and jumps the queue. Rejected with **409** if a scan
  is already running and `mode=queue` isn't wanted — enforces single-flight.
- `POST /api/scan/stop` (or `DELETE /api/scan`) — **stop** the running walk:
  abort, drop the staging generation, return to `idle`. Does not touch the
  scheduler. No-op if already idle.
- `GET`/`PUT /api/roots/:id/schedule` — read/update the per-root `enabled`
  switch, concurrency, interval, windows, timezone, and `onWindowEnd` mode (the
  DB-backed settings the UI edits; env values seed the defaults).

#### Node identity — path (durable) + id (in-session)

Nodes are addressed two ways, by role — **not** by inode. Inode is the wrong key
here: unique only within one filesystem (a multi-volume NAS collides), **reused
after deletion** (a captured inode can point at a different file next scan),
frequently absent or synthetic on SMB/NFS/FUSE/FAT (the likely NAS mounts), and
semantically wrong — hard links make it *many paths → one inode*, but the treemap
addresses **positions in the hierarchy**, not file objects. (Inode has one
legit use: the scanner may key on `(dev, ino, mtime)` internally for move/rename
detection during incremental rescan — a scanner concern, never client-facing.)

- **Path = durable external identity.** Root `id` + relative path, as today.
  Survives rescans, swaps, and restarts. Used for entry points, deep links / URL
  state, bookmarks, breadcrumbs — anything that must outlive a generation.
- **`id` = ephemeral in-session handle.** The store's flat table already mints
  `node(id, root_id, parent_id, …)`; that integer PK is a compact, opaque handle.
  The client addresses the *entry point* by path, then navigates by `id`
  thereafter. Wins: "children of these" is index-native (`WHERE parent_id IN (…)`
  on the `(parent_id, size DESC)` index); integers are compact in batch bodies;
  and an integer has **no path-traversal attack surface** — validate its
  `root_id` is one the client may see, no lexical/symlink check needed (those stay
  at the path entry points, [resolve-path.ts](../../server/src/scan/resolve-path.ts)).

`id`s are **generation-scoped** — the staging swap rebuilds the table and
reassigns them — which is exactly why this composes with generation pinning:
`id`s are valid for precisely the window a generation is pinned, and the path is
the cross-generation anchor the client re-seeds from after a swap.

#### Generation pinning (consistency across the atomic swap)

Every read pins a `generation`. Because background rescans **atomic-swap**
generations, a multi-tile interaction that straddled a swap would stitch pre- and
post-swap subtrees into one inconsistent picture. So `status` exposes the current
generation, tile requests pin one, and a request against a swapped-out generation
returns **409/410** → the client refetches the current view (from its
path-addressed entry point) against the new generation. Cheap to build in now,
painful to retrofit; bake it in from the first cut. This is also feature 0002's
"layout stability across refreshes" open question, answered at the protocol level.

#### `POST /api/tree/batch` — the tile query

```
POST /api/tree/batch
{
  root: "data",
  generation: 7,
  requests: [
    { parentId: 4211, limit: 200 },          // depth 1 (default): just this dir's children
    { parentId: 4212, limit: 200 },
    { parentId: 8830, depth: 4 },            // subtree spine: down 4 levels, size-pruned
    { path: "big/deep/target", depth: 4 }    // same, anchored by path — a cold fly-to with no id yet
  ]
}
→ { generation: 7,
    nodes: {
      "4211": { children: [ {id, name, kind, size, childCount, mtimeMs}, … ],
                childCount: 812,
                omittedTail: { count: 612, bytes: 149042 } },
      …
    } }
```

- **`depth: 1` (default) — "children of these directories."** The frontier case:
  one zoom reveals N sibling directories now large enough to open; the client
  already laid out their parents so it holds all their `id`s, and sends **one**
  request instead of N. This is the fix for the hundred-simultaneous-fetches
  problem.
- **`depth > 1` — "subtree from here."** Collapses the per-level **waterfall** on
  a cold fly-to a deep path (otherwise one RTT per level) into a single trip.
  Server prunes nodes below a size fraction (sub-pixel anyway), size-sorted,
  capped per level.
- **A request anchor is `{ parentId }` *or* `{ path }`.** The `id` form is the
  common case (you already hold ids from a prior fetch); the `path` form is for
  the cold fly-to — a URL/bookmark hands you a path, not an id, so the server
  resolves the anchor and the deep load stays **one** trip instead of a
  path→id resolve followed by the spine fetch. Path anchors run the usual
  traversal guards; id anchors just check `root_id` ownership.
- Response is **flat, keyed by `id`**, each entry carrying `childCount` and an
  **`omittedTail`** aggregate (count + bytes past the `limit` cap) so layout
  reserves a "+M smaller items" remainder rect and stays stable — feature 0002's
  capped-slice question, answered in the protocol.
- **Guardrails:** POST-with-body (a long id/path list blows past URL length); a
  **cap on requests-per-batch and total nodes-per-response**, with a truncation
  signal, so one query can't ask the server to serialize half the tree.

**The endpoint is only half the fix — the client must coalesce.** Wheel-zoom
fires a storm of camera events; even with a batch endpoint, a batch per event is
bad. The client discipline pairs with the API: **debounce to one batch per
settled camera frame, dedupe against the laid-out-directory LRU cache (never
request a directory already held), and `AbortController`-cancel in-flight batches
made stale by fast zoom-through.** The API affords batching; client scheduling is
what actually caps request volume. See
[feature 0002](../features/0002-pan-zoom-treemap.md).

The treemap becomes **level-by-level / capped**, not one giant canvas — which
0001's rendering section says is needed *regardless* of the storage decision,
since millions of sub-pixel tiles are unrenderable anyway.

## Trade-offs vs the minimal fix

0001 recommends **Option A (capped rollup)** as the minimal fix: scoped to one
function, no DB, no service, keeps the "one scan, browse offline" model. This
doc is a genuine re-architecture. Both fix the scale problem.

| | Minimal (0001-A) | Full (this doc) |
|---|---|---|
| Scope | one function in `walk.ts` | DB, worker, scheduler, migrations, new endpoints, staleness UX |
| Data freshness | scan on demand | always fresh, background |
| Time-to-view | wait for full scan | instant (reads store) |
| Full itemization | lost past the cap | preserved at every level (lazy) |
| New failure modes | none | DB corruption/locking, stale reads, scan-vs-read concurrency |
| Foundation for history/trends | no | yes |

## Non-goals

- **The viewer is strictly read-only.** It scans, stores, and *shows* — it never
  deletes, moves, renames, or writes into the scanned roots. The scanned share is
  treated as read-only input (and in the container it's mounted that way). This is
  a deliberate safety boundary, not a missing feature: a disk-usage tool that can
  also delete is a foot-gun on a NAS, and it would drag in a whole write-side
  permissions/undo/confirmation surface that has nothing to do with visualizing
  usage. No mutation endpoints exist; the scanner opens nothing for write.
- **We can still *aid* the user without acting for them.** The sanctioned help is
  to hand the user the information to act elsewhere — e.g. copy/export the selected
  file path(s) to the clipboard or a file, so they can delete/move/archive with
  their own tools of choice. The tool surfaces "here is what's big and where it
  lives"; the destructive decision and action stay entirely with the user, outside
  this app. See [feature 0006 — export/copy paths](../features/0006-export-paths.md).

## Risks / open points

- **Scan load on the NAS** while users are actively using the share —
  operator-controllable via the **concurrency limiter** and the **scheduler's
  wall-clock windows** (see the configuration section above): keep concurrency
  low, confine rescans to off-peak hours. `onWindowEnd=abort` gives a hard
  ceiling at the cost of possibly never refreshing a tree too large to finish in
  one window.
- **Staleness UX** — the UI must clearly show "last scanned N ago" so nobody
  mistakes cached data for live.
- **DB lifecycle** — migrations, corruption recovery, where the file lives
  (must be on writable storage, not the read-only mounted share).
- **Concurrency** — reads during a scan; the staging+swap model handles this,
  incremental updates would need more care.

## Recommendation

For a tool meant to sit on a NAS and stay useful, the on-demand model fights the
use case — nobody wants to wait 15 minutes to see what's eating their disk. I
lean toward the **full** design: (B) queryable store as the load-bearing change,
(A) background refresh layered on top, full re-walk + atomic swap first,
incremental later. It's a real step up in complexity (DB, worker, scheduler,
staleness UX), so it should be a deliberate choice over 0001-A rather than a
drift into it.

The hinge between the two is whether **full per-file itemization at every level**
matters, or whether "show me the big offenders" is enough — if the latter,
0001-A is far less work.

## Decision

**Decided (2026-07-17): build the full design — going all-in on the background
service.** Rationale: the tool is meant to sit on a NAS and stay useful, and the
on-demand "scan-and-wait then hold the whole tree" model fights that at both the
scale ([0001](0001-large-tree-scaling.md)) and UX levels, while also capping what
the UI can become. Sequence:

1. **Change (B) — the slice store.** Embedded `node:sqlite`, flat node table,
   directory aggregate sizes precomputed at scan time, `GET /api/tree` serving
   one directory's size-sorted children (capped/paged). This is the load-bearing
   piece and it's what supersedes the minimal 0001-A fix.
2. **Change (A) — background refresh.** Scheduled + manually triggerable scan in a
   `worker_threads` worker, full re-walk into a staging generation + atomic swap.
   Incremental rescan deferred to v2 (with periodic full walks to correct drift).
3. **Shape the API for what's next.** Bake the **batch tile query**
   (`POST /api/tree/batch`, see the API-shape section) in from the start so
   [feature 0002 (pan/zoom treemap)](../features/0002-pan-zoom-treemap.md) —
   whose map-tile fetching this store serves directly — doesn't force a
   retrofit.

Open points below (scan load, staleness UX, DB lifecycle, concurrency) are
build-time details to handle, not blockers on the direction.
