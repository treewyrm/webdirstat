# WebDirStat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A WinDirStat-style disk usage visualizer for a NAS, running as a single Docker container.

It scans configured roots in the background into a persistent SQLite store and serves the
tree to the browser **in slices** — the client fetches only the directories currently on
screen and navigates them like a map (continuous pan/zoom), so a multi-million-file share
never has to be held in memory on either side.

- **server** — [h3](https://h3.dev) v2 API. A background scanner (`worker_threads`) walks
  each root, streaming into an embedded `node:sqlite` store; a scheduler refreshes on a
  staleness interval within operator-configured wall-clock windows. The API serves one
  directory level at a time (`GET /api/tree`, `POST /api/tree/batch`) with generation-pinned
  reads. Built with [tsdown](https://tsdown.dev).
- **client** — Vue 3 + Vite SPA. Renders a `d3-zoom` pan/zoom treemap to a canvas, fetching
  directory tiles lazily as zoom reveals them (level-of-detail by on-screen size); breadcrumbs
  and the file-list pane are derived from the camera.
- **shared** — TypeScript types shared between server and client (no runtime code).

See [docs/](docs/) for the design notes behind this architecture — most recently
[issue 0002](docs/issues/0002-background-scanning-service.md) (the background service + slice
store) and [feature 0002](docs/features/0002-pan-zoom-treemap.md) (the pan/zoom map).

## Develop

```sh
pnpm install
pnpm dev       # server on :3000, client (Vite) on :5173, proxying /api
```

The dev server writes its store to `./data/webdirstat.db` by default (override with `DB_PATH`).

## Build & run locally

```sh
pnpm build
ROOTS="Data=/some/path" DB_PATH=./data/wds.db CLIENT_DIST=./client/dist node server/dist/index.js
```

## Docker

```sh
docker build -t webdirstat .
docker run -p 8080:8080 \
  -v /volume1/media:/data:ro \
  -v webdirstat-db:/db \
  webdirstat
```

Mount the scanned shares **read-only** — the app only ever reads them — but give the store a
**writable** volume (`DB_PATH` defaults to `/db/webdirstat.db` in the image; never point it at
the read-only share). See [docker-compose.yml](docker-compose.yml) for a multi-share example.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `ROOTS` | `Data=/data` | Comma-separated `Label=/host/path` pairs; each becomes a selectable root. |
| `DB_PATH` | `./data/webdirstat.db` (`/db/webdirstat.db` in Docker) | SQLite store file. Must be on writable storage. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` (`8080` in Docker) | Listen address. |
| `CLIENT_DIST` | unset in dev | Directory of the built SPA; when set the server also serves the client. |
| `SCAN_INTERVAL` | unset | Max-staleness target (e.g. `6h`); a rescan is *wanted* once data is older. |
| `SCAN_WINDOWS` | unset | Wall-clock windows a rescan is *allowed* in, e.g. `"Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00"`. |
| `SCAN_CONCURRENCY` | `4` | In-flight syscalls per walk (disk pressure). |
| `SCAN_MIN_INTERVAL` | `1h` | Hard floor between scans. |
| `SCAN_ON_WINDOW_END` | `finish` | `finish` lets a running scan complete past its window; `abort` cancels it. |
| `HISTORY_GENERATIONS` | `0` | Full past generations to retain (`0` = keep none). |
| `SCAN_ENABLED` | inferred | Master switch for *automatic* scans; defaults on if `SCAN_INTERVAL` or `SCAN_WINDOWS` is set. Manual scans always work. |

These seed the per-root defaults; the schedule is editable per root in the UI and persisted in
the store. With no schedule configured the service is manual-only (Start/Stop) over the same
slice store.

## Notes

- Symlinks are never followed (avoids cycles and escaping mounted volumes); they show up as
  their own zero-size tile.
- Scan data is always present with a "last scanned N ago" freshness stamp — the UI never blocks
  on a scan to browse.
- Very large trees are handled by the slice/tile model and level-of-detail rendering: the
  browser only ever holds what's on screen, so a multi-million-file NAS stays navigable.
