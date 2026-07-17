# WebDirStat

A WinDirStat-style disk usage visualizer for a NAS, running as a single Docker container.

- **server** — [h3](https://h3.dev) v2 API: recursively scans a mounted directory, streaming progress over SSE, then returns the full size tree in one shot.
- **client** — Vue 3 + Vite SPA: renders the tree as a squarified treemap (canvas, via `d3-hierarchy`) with a WinDirStat-like file list pane and breadcrumb drill-down, entirely client-side once the scan completes.
- **shared** — TypeScript types shared between server and client (no runtime code).

## Develop

```sh
pnpm install
pnpm dev       # server on :3000, client (Vite) on :5173, proxying /api
```

## Build & run locally

```sh
pnpm build
ROOTS="Data=/some/path" CLIENT_DIST=./client/dist node server/dist/index.js
```

## Docker

```sh
docker build -t webdirstat .
docker run -p 8080:8080 -v /volume1/media:/data:ro webdirstat
```

`ROOTS` is a comma-separated list of `Label=/host/path` pairs; each becomes a selectable root in the UI (see [docker-compose.yml](docker-compose.yml) for a multi-share example). Mount shares read-only — the app only ever reads.

## Notes

- Symlinks are never followed (avoids cycles and escaping mounted volumes); they show up as their own tile.
- Very large trees (hundreds of thousands of files) render every leaf on the canvas — there's no level-of-detail cap yet, so extremely deep/wide shares may render slowly.
