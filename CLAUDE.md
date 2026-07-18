# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Requires Node 24+ and pnpm 11.8.0 (`corepack enable`). Run from the repo root.

```sh
pnpm install
pnpm dev         # server on :3000 + client (Vite) on :5173 proxying /api → :3000, in parallel
pnpm build       # builds client (vue-tsc + vite) then server (tsdown)
pnpm typecheck   # tsc/vue-tsc --noEmit across shared, server, client — the real pre-commit check
pnpm start       # runs the built server (server/dist/index.js)
```

Run a single workspace's script with a filter, e.g. `pnpm --filter ./server run dev`.

Run the built server against a real path:

```sh
ROOTS="Data=/some/path" DB_PATH=./data/wds.db CLIENT_DIST=./client/dist node server/dist/index.js
```

`node:sqlite` is why the server builds with **tsdown** (rolldown), not tsup (esbuild): esbuild
strips the `node:` prefix from builtins, and `node:sqlite` has no bare `sqlite` alias, so an
esbuild bundle fails at runtime. tsdown preserves the specifier. See
[server/tsdown.config.ts](server/tsdown.config.ts) (two entries: `index.ts` + the scan worker).

There is **no test suite and no working linter**. `pnpm lint` delegates to per-package `lint`
scripts that don't exist (no ESLint config anywhere), so it fails — use `pnpm typecheck` for
verification. Debugging both dev servers together is set up in [.claude/launch.json](.claude/launch.json).

### Screenshotting the running app (headless)

To verify UI changes, build both, run the server with `CLIENT_DIST` set so one process serves API +
SPA, scan a small fixture dir (`POST /api/scan {"root":...,"mode":"preempt"}`), then screenshot.

**Gotcha: `--virtual-time-budget` never settles** — the client holds `GET /api/status` (SSE) open
forever, so that flag (and any "wait for network idle") hangs until timeout and yields no image.
**Drive Chrome over CDP and control capture timing yourself** instead:

1. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu
   --remote-debugging-port=9222 --user-data-dir=<tmp> about:blank &`
2. Connect to `webSocketDebuggerUrl` from `http://localhost:9222/json/version` (Node 24 has global
   `WebSocket`/`fetch`). `Target.createTarget` **must pass `newWindow:true`** to accept `width`/
   `height` (else `-32602 "Target position can only be set for new windows"`).
3. `Target.attachToTarget {flatten:true}` → `Page.enable` → `Emulation.setDeviceMetricsOverride`
   (e.g. `deviceScaleFactor:2` for retina) → `Page.navigate` → **fixed `setTimeout` wait** (not a
   load event) → `Page.captureScreenshot`.

The list pane (breadcrumbs + files) is camera-derived, so on load it shows the **root's** children;
to screenshot deep rows without driving zoom, point `ROOTS` at a fixture whose top level already has
the mix you want to see.

## Architecture

A WinDirStat-style disk-usage visualizer, shipped as one Docker container. pnpm monorepo with
three workspaces ([pnpm-workspace.yaml](pnpm-workspace.yaml)):

- **shared** — TypeScript types only, no runtime code. Consumed as **raw `.ts` source**: its
  `package.json` `main`/`exports` point at `src/index.ts`, and the tsconfig sets
  `allowImportingTsExtensions`. Both server and client import `@webdirstat/shared` directly; there
  is no build step for it. [shared/src/types.ts](shared/src/types.ts) is the protocol contract
  (`TreeChild`, `TreeSlice`, `TreeBatchRequest`, `ScannerStatus`, `RootSchedule`, etc.) — change it
  and both sides move together.
- **server** — [h3](https://h3.dev) v2 API. Built with `tsdown` to ESM.
- **client** — Vue 3 + Vite SPA. Built with `vue-tsc` + `vite`.

### Scan flow (the core design decision)

> This model replaced the original "one scan, ship the whole tree as one JSON blob, browse
> offline" design (which didn't bound with file count). The rework is written up in
> [docs/issues/0002-background-scanning-service.md](docs/issues/0002-background-scanning-service.md)
> (**Done**) — read it before making scaling changes; the scaling problem it solves is
> [docs/issues/0001-large-tree-scaling.md](docs/issues/0001-large-tree-scaling.md).

Scanning is **decoupled from browsing**. A background scanner populates a persistent SQLite store;
the client reads the tree in slices and never holds more than what's on screen.

1. **Store** ([server/src/store/](server/src/store/)) — embedded `node:sqlite` (`DatabaseSync`,
   WAL mode). A **flat, generation-aware** `node` table ([schema.ts](server/src/store/schema.ts)):
   each row is `(id, generation, root_id, parent_id, name, kind, size, mtime_ms, child_count, ext,
   error)`, indexed `(parent_id, size DESC)` so "children of X, largest first" is one query.
   Directory aggregate `size` is precomputed bottom-up at scan time. Also filled per scan:
   `scan_summary`, `type_rollup` (ext → bytes/count), and DB-backed per-root `root_settings`.
2. **Walk** ([walk.ts](server/src/scan/walk.ts)) drives a **sink** (`enterDir`/`leaf`/`exitDir`)
   instead of building an in-memory tree — O(depth) memory, not O(nodes). Still concurrency-limited
   (default 4 in-flight syscalls, [limiter.ts](server/src/scan/limiter.ts)) and abortable.
   [persist.ts](server/src/scan/persist.ts) writes the walk into a fresh **staging** generation
   (periodic commits), writes the summary, then **atomically swaps** staging → live and prunes
   retired generations past `HISTORY_GENERATIONS` ([generations.ts](server/src/store/generations.ts)).
   Reads always see one complete, consistent generation.
3. **Scanner** ([scanner.ts](server/src/scan/scanner.ts)) runs the walk in a `worker_threads`
   worker ([scan-worker.ts](server/src/scan/scan-worker.ts)) with its own DB connection (WAL: one
   writer, concurrent readers), keeping the HTTP loop responsive. It is a single-flight state
   machine `idle → scanning → swapping → idle` with a queue, `preempt`, and stop, observable over
   SSE. The [scheduler](server/src/scan/scheduler.ts) composes a freshness gate (staleness
   `interval`) with tz-aware weekly windows ([schedule.ts](server/src/scan/schedule.ts)) and a
   `minInterval` floor, sleeping to the next relevant instant. Automatic scanning is opt-in per
   root; with it off the service is manual-only Start/Stop over the same store.

**Reads pin a `generation`.** Because rescans atomic-swap generations (and `id`s are
generation-scoped, reassigned each swap), a request against a swapped-out generation returns
**410**; the client re-seeds from its durable **path** anchor against the new generation.

**API** (all under `/api`, [server/src/routes/](server/src/routes/)):
- `GET /api/roots` — `{ id, label }` only, never host paths.
- `GET /api/tree?root&path&limit&generation` — one directory level, size-sorted, capped, with an
  `omittedTail` (count + bytes past the cap). The **path entry point**; each child carries its `id`.
- `POST /api/tree/batch` — the **tile query**: many directories' children (`depth: 1` frontier)
  plus size-pruned subtree spines (`depth > 1`, cold fly-to) in one round trip, flat + keyed by id,
  with a `resolved[]` for path anchors and caps + a `truncated` signal.
- `POST /api/scan` (`mode=queue|preempt`), `POST /api/scan/stop` — trigger/stop; bypass the gates.
- `GET /api/status` (SSE) — global scanner state + current generation + queue.
- `GET /api/roots/:id/status`, `GET`/`PUT /api/roots/:id/schedule` — per-root freshness + settings.

### Roots and path security

Scannable directories are configured via the `ROOTS` env var: `Label1=/path,Label2=/path`
(comma-separated; defaults to `Data=/data`). Parsing/slugifying happens in
[server/src/config.ts](server/src/config.ts), which resolves each root to both an `absolutePath`
and a `canonicalPath` (symlinks resolved) used as the containment boundary.

**Real host paths never reach the client** — the `/api/roots` endpoint returns only `{ id, label }`.
The client sends back a root `id` plus a relative subpath.

Two independent path-traversal guards, both must be kept intact:

- [server/src/scan/resolve-path.ts](server/src/scan/resolve-path.ts) — validates the client's
  relative scan path: lexical containment check against `absolutePath`, then a `realpath` check
  against `canonicalPath` to catch symlinks escaping the root.
- [server/src/static/serve.ts](server/src/static/serve.ts) — the same two-layer (lexical +
  `realpath`) check when serving the built client bundle in production.

**Symlinks are never followed** during a walk — they appear as their own zero-size `symlink` node.
This avoids cycles and prevents escaping the mounted volume.

### Client rendering

Navigation is **map-style**: the camera is the source of truth, and the "current folder"
(breadcrumbs + file-list pane) is *derived* from it — the deepest directory whose world rect fully
contains the viewport. [client/src/components/MapTreemap.vue](client/src/components/MapTreemap.vue)
owns a `d3-zoom` camera over a fixed world and draws a nested squarified treemap to a **canvas**
(not DOM). It lays out one directory level at a time into world rects
([client/src/treemap/layout.ts](client/src/treemap/layout.ts) via `d3-hierarchy`), fetching each
directory's interior as a **tile** (`POST /api/tree/batch`) only when zoom reveals it — level of
detail by on-screen size. Client discipline the design requires: debounce to one batch per settled
camera frame, dedupe against an LRU of laid-out directories, `AbortController`-cancel stale batches,
and evict interiors far outside the viewport. Just-revealed tiles show an animated gradient-pan
shimmer until their data arrives. [client/src/App.vue](client/src/App.vue) seeds the map, reflects
the `@focus` event into the breadcrumbs and the left side shell, and drives fly-to via a ref; it also
owns the scanner status SSE, the Start/Stop control, and the staleness stamp. The left shell is a
**tab strip** ([FileList.vue](client/src/components/FileList.vue) / [TypeList.vue](client/src/components/TypeList.vue)
— feature 0005 — / [SearchPanel.vue](client/src/components/SearchPanel.vue) — feature 0004),
mutually exclusive with only one pane shown at a time (defaults to Files); the shell owns
width/border/scroll/background. All display and scan settings live behind the ⚙ button in
[SettingsModal.vue](client/src/components/SettingsModal.vue) (feature 0007), which houses the
**Display** ([DisplaySettings.vue](client/src/components/DisplaySettings.vue)) and **Scanning**
(the migrated [ScheduleEditor.vue](client/src/components/ScheduleEditor.vue)) categories. Tile colors
are deterministic — by default directories/symlinks get fixed neutral tones, files are colored by
extension hash, and the omitted-tail remainder tile its own tone
([client/src/utils/color.ts](client/src/utils/color.ts)); a Display toggle can instead color files by
modification age (feature 0011), and shaded/cushion shading is an orthogonal toggle (feature 0010).

### Dev vs. production server

`CLIENT_DIST` (env) controls whether the server also serves the static SPA. In dev it's **unset**,
so Vite serves the client on :5173 and proxies `/api` to the h3 server on :3000. In the Docker image
it's set to the built bundle, so the single server process serves both API and SPA on one port
(8080). See [Dockerfile](Dockerfile) (multi-stage: builder → prod-deps → runtime).

`DB_PATH` (env, default `./data/webdirstat.db`; `/db/webdirstat.db` in the image) is the store file.
It **must** live on writable storage — never the read-only scanned share — so the Docker image
declares a separate writable `/db` volume alongside the read-only `/data` mounts. Env vars
`SCAN_INTERVAL`, `SCAN_WINDOWS`, `SCAN_CONCURRENCY`, `SCAN_MIN_INTERVAL`, `SCAN_ON_WINDOW_END`,
`HISTORY_GENERATIONS`, and `SCAN_ENABLED` seed the per-root schedule defaults in
[config.ts](server/src/config.ts); the UI overrides and persists them per root.

## docs/ convention

[docs/issues/](docs/issues/) and [docs/features/](docs/features/) hold design notes that outlive a
session, one numbered file each (`0001-...`, zero-padded, never renumbered). Each carries a status
line: `Proposed` → `Decided` → `In progress` → `Done` (or `Rejected`). Consult and update these when
working on anything they cover; see [docs/README.md](docs/README.md).
