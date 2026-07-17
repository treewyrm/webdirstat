# 0002 — Background scanning service with a persistent store

Status: **Proposed**

Related: [0001 — Scaling to very large trees](0001-large-tree-scaling.md)

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
- Host paths stay server-side; the client keeps addressing nodes by
  `root` + relative `path`, as today.

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

### API shape

- `GET /api/roots` — unchanged.
- `GET /api/roots/:id/status` — last scan time, in-progress flag, entry/byte totals.
- `GET /api/tree?root&path&limit` — one directory's children, size-sorted, capped.
- `POST /api/scan` — trigger a rescan (or leave purely scheduled).

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

## Risks / open points

- **Scan load on the NAS** while users are actively using the share — schedule
  off-peak, keep concurrency low.
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

Not yet decided — pending discussion.
