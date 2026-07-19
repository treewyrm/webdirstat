# HTTP API reference

Status: **Living reference** — update alongside the routes it describes.

The one consumer of this API is the bundled Vue SPA; it is not a public contract. The
authoritative **shapes** live in [shared/src/types.ts](../shared/src/types.ts), imported as raw
source by both server and client so the two sides cannot drift. This document does **not** re-type
those shapes — it links to them and captures the *behavioral protocol* the types can't express:
generation pinning, the 410 re-seed, the cap/fold semantics, when to use which read, and the SSE
lifecycle.

Everything lives under `/api` and is registered in [server/src/index.ts](../server/src/index.ts).

## Cross-cutting behavior

### Generation pinning (read the whole thing before touching a read route)

Rescans build a fresh **generation** in a staging area and atomically swap it live; node `id`s are
generation-scoped integers, reassigned on every swap. So the read model, implemented once in
[pinGeneration](../server/src/routes/generation.ts):

- **`generation` omitted** → the request runs against the **current live** generation. Root never
  scanned → **404**.
- **`generation` given** → that historical generation is used *while it is still retained*
  (`historyGenerations` deep). A generation that has been **pruned** → **410 Gone**.

**The 410 contract.** `id`s are only valid while their generation is pinned. When a read against a
pinned generation returns 410 (a rescan swapped it out mid-browse), the client must **re-seed from
its durable anchor** — the root `id` + relative **path**, which survives across generations — not
from the now-invalid `id`s. This is normal protocol flow, not an error condition; the server does
not even log it (see the `onError` note in [index.ts](../server/src/index.ts)).

`path` is the durable address; `id` is a within-generation performance handle.

### Caps and folds (every read is bounded)

No read can serialize an unbounded slice of the tree. Two independent, non-overlapping mechanisms:

- **Count cap** — each request has a `limit` (server-clamped; defaults below). Children past the cap
  are summarized in [`omittedTail`](../shared/src/types.ts#L30) `{ count, bytes }` so layout can
  reserve a remainder tile.
- **Size fold** (`minSize`, feature 0013) — direct **files** smaller than `minSize` bytes are folded
  out *before* the cap into [`foldedSmall`](../shared/src/types.ts#L43) `{ count, bytes }`.
  Directories are never folded. A folded file is removed before the cap applies, so it can never
  also appear in `omittedTail` — the two buckets are disjoint.

### Response compression (feature 0018)

Every JSON/text response is content-negotiated compressed (brotli preferred, gzip fallback)
when the client sends `Accept-Encoding` and the body clears a size threshold — transparent
to the client, which just decodes it. Applied by wrapping `app.fetch`
([http/compression.ts](../server/src/http/compression.ts)); the **SSE** stream
(`GET /api/status`) is excluded (it must stay incremental). Tuned via `COMPRESSION`,
`COMPRESSION_QUALITY`, `COMPRESSION_MIN_SIZE`. Matters most for `POST /api/tree/batch`,
which is mostly repetitive JSON structure and compresses ~10×.

### Validation & errors

Query strings and JSON bodies are validated with zod. Malformed input → **400**. Path/`root`
resolution failures → **404**. Store unreachable (health) → **503**. Real host paths never appear in
any response — the client only ever sends a root `id` + relative path (see the path-security section
of [CLAUDE.md](../CLAUDE.md)).

### Auth (feature 0001)

When `PASSWORD` is set, a blanket `/api/**` guard ([routes/auth.ts](../server/src/routes/auth.ts))
401s any unauthenticated call except the public probes: `GET /api/session`, `POST /api/login`,
`POST /api/logout`, `GET /api/health`. Auth is a session cookie. When `PASSWORD` is unset the guard
is never installed and everything is open.

---

## Endpoints

### `GET /api/session` — auth probe *(public)*
Returns `{ required, authenticated }` so the SPA learns on load whether a gate exists and whether
it's already in. Always present, even with no gate configured.

### `POST /api/login` · `POST /api/logout` *(public)*
`login` takes `{ password }`; wrong password → 401, success sets the session cookie. `logout` clears
it. Only meaningful when `PASSWORD` is set. [routes/auth.ts](../server/src/routes/auth.ts)

### `GET /api/health` *(public)*
Liveness/readiness probe for the container orchestrator. `{ status: "ok" }` when the store answers a
trivial query; **503** when it doesn't (so a healthcheck loop reads "not ready", not "crashed").
[routes/health.ts](../server/src/routes/health.ts)

### `GET /api/roots`
The configured roots as [`ScanRoot[]`](../shared/src/types.ts#L5) — `{ id, label }` only. **Never
host paths.** [routes/roots.ts](../server/src/routes/roots.ts)

### `GET /api/tree` — the path entry point
`?root&path&limit&generation&minSize` → one directory level as a [`TreeSlice`](../shared/src/types.ts#L49),
size-sorted and capped. Addressed **durably by path** (`path=""` is the root); the returned children
carry generation-scoped `id`s you use for `id`-addressed navigation thereafter. Path not found in
the pinned generation → 404. `limit` default **1000**, max **10 000**.
[routes/tree.ts](../server/src/routes/tree.ts)

Use this to **enter** a subtree (from a URL, a bookmark, a search hit, or a 410 re-seed).

### `POST /api/tree/batch` — the tile query (map navigation)
Body [`TreeBatchQuery`](../shared/src/types.ts#L94) → [`TreeBatchResponse`](../shared/src/types.ts#L118):
many directories in one round trip, flat and keyed by directory `id`. Each request anchors by
`parentId` (the common case — you already hold ids) **or** by `path` (a cold fly-to with no id yet).
`depth: 1` (default) returns just the anchor's children; `depth > 1` returns a size-pruned subtree
spine that many levels deep. `resolved[]` echoes each anchor's resolved node in order (or `null`),
so a path-anchored fly-to learns its `id`. [routes/batch.ts](../server/src/routes/batch.ts)

Guardrails so one call can't serialize half the tree: ≤ **64** requests, ≤ **20 000** total children
(`truncated: true` if hit), `limit` default **200** / max **1000**, `depth` max **8**, and interiors
smaller than 0.1 % of their anchor are pruned unexpanded.

Use this to **fill in** what's already on screen, not to enter a subtree cold.

### `GET /api/roots/:id/types` — space by file type (feature 0005)
`?path&limit&generation` → [`TypeRollupResponse`](../shared/src/types.ts#L139). `path=""` (whole
root) is served from a precomputed table in O(extensions); a subpath is aggregated on demand over
that subtree. Same generation model as the tree reads. A `path` that doesn't resolve (transient
during a swap) or isn't a directory yields an **empty** breakdown, never an error — so navigation
never faults it. `limit` default **100** / max **1000**. [routes/types.ts](../server/src/routes/types.ts)

### `GET /api/search` — structured file search (feature 0004)
Query [`SearchParams`](../shared/src/types.ts#L166) → [`SearchResponse`](../shared/src/types.ts#L203).
Every predicate is optional and ANDed (`minSize`/`maxSize`, `ext`, `olderThan`/`newerThan`,
`nameLike`, `sort`); an empty query is a valid "top files by size". `scope="here"` restricts to the
subtree at `path` (an unresolvable/`non-directory` path → empty, not an error). Each hit carries a
durable `path` (reconstructed from parent links) that feeds fly-to and export. Generation-pinned and
capped (`limit` default **200** / max **1000**, overflow reported as `omittedCount`).
[routes/search.ts](../server/src/routes/search.ts)

### `GET /api/status` — global scanner state *(SSE)*
An `text/event-stream` that pushes the current [`ScannerStatus`](../shared/src/types.ts#L247) once
immediately, then again on **every** scanner transition (`idle → scanning → swapping → idle`, queue
changes). There is one scanner across all roots; scans are serialized. **Lifecycle:** the stream
stays open indefinitely — the client holds it for the life of the page and unsubscribes on close.
(This is the connection that makes "wait for network idle" hang; see the screenshot note in
CLAUDE.md.) [routes/status.ts](../server/src/routes/status.ts)

### `GET /api/roots/:id/status` — per-root facts
[`RootStatus`](../shared/src/types.ts#L287): live generation (or null if never scanned), last-scan
timestamps + result, totals, whether a window is open now, next expected automatic scan, and this
root's relation to the scanner (`scanning`/`queued`/null). Polled, not streamed.
[routes/status.ts](../server/src/routes/status.ts)

### `POST /api/scan` · `POST /api/scan/stop` · `DELETE /api/scan` — manual control
`POST /api/scan` takes `{ root, mode }` (`mode` in `queue` | `preempt`, default `queue`; may be in
body or query, body wins) and returns `{ outcome, status }`. Unknown root → 404. `stop` (also
`DELETE /api/scan`) aborts the running scan and returns `{ status }`. **Manual control bypasses the
schedule freshness/window gates.** [routes/scan.ts](../server/src/routes/scan.ts)

### `GET /api/roots/:id/schedule` · `PUT /api/roots/:id/schedule` — per-root config
GET/PUT the DB-backed [`RootSchedule`](../shared/src/types.ts#L267) (env-seeded defaults, UI-edited):
`enabled`, `concurrency`, `intervalMs`, `windows`, `timezone`, `minIntervalMs`, `onWindowEnd`,
`historyGenerations`. PUT validates and reschedules the scanner. [routes/schedule.ts](../server/src/routes/schedule.ts)

---

## Typical client flows

- **Cold entry (URL / bookmark / search hit):** `GET /api/tree?root&path` → hold the returned
  `generation` + child `id`s.
- **Map navigation:** as zoom reveals interiors, batch them with `POST /api/tree/batch` anchored by
  `parentId`, pinning the held `generation`. Debounce to one batch per settled camera frame; cancel
  stale batches.
- **Mid-browse rescan (410):** any read returns **410** → discard the `id`s, re-seed with
  `GET /api/tree?root&path` (no `generation`) to land on the new live generation, then continue.
- **Fly-to a deep path with no id:** `POST /api/tree/batch` with a `{ path, depth }` request; read
  the resolved anchor `id` out of `resolved[]`.
