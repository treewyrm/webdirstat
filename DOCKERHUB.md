# WebDirStat

A self-hosted, WinDirStat-style **disk-usage visualizer** for your NAS or server.
It scans mounted directories in the background into a SQLite store and renders them
as a zoomable, nested **treemap** in the browser — so you can see, at a glance, what's
eating your space.

- **Interactive treemap** — a canvas-rendered squarified treemap you zoom and pan like
  a map; the current folder, breadcrumbs, and file list are all derived from the camera.
- **Background scanning** — scans run in a worker thread into a generation-versioned
  SQLite store, so browsing stays instant and rescans swap in atomically. Optional
  scheduling with weekly time-windows and staleness intervals.
- **Bounded memory** — the client only ever holds what's on screen; the server walks the
  tree with O(depth) memory, so it handles very large trees.
- **Read-only by design** — the scanned volume is mounted read-only; symlinks are shown
  but never followed (no cycles, no escaping the mount).
- **Optional password gate** — a shared-password login for anything past a trusted LAN.
- Single container, multi-arch (`linux/amd64` + `linux/arm64`), non-root.

## Quick start

```sh
docker run -d --name webdirstat \
  -p 8080:8080 \
  -v /path/to/scan:/data:ro \
  -v /path/to/appdata/webdirstat:/db \
  -e ROOTS="Data=/data" \
  treewyrm/webdirstat:latest
```

Then open **http://SERVER-IP:8080/** and press **Start** to run the first scan.

### docker-compose

```yaml
services:
  webdirstat:
    image: treewyrm/webdirstat:latest
    container_name: webdirstat
    ports:
      - "8080:8080"
    volumes:
      - /path/to/scan:/data:ro          # the share(s) you want to analyze — read-only
      - /path/to/appdata/webdirstat:/db # writable store (must NOT be the scanned share)
    environment:
      ROOTS: "Data=/data"
      PUID: "1000"                      # uid/gid that owns your /db appdata dir
      PGID: "1000"
      # PASSWORD: "changeme"            # uncomment to require login
      # TZ: "Europe/London"             # for scheduled scan windows
    restart: unless-stopped
```

## Volumes

| Path   | Mode         | Purpose |
|--------|--------------|---------|
| `/data`| **read-only**| The directory (or directories) to analyze. Mount `:ro` — the app never writes here. |
| `/db`  | writable     | The SQLite store. **Must** be writable storage, and must **not** be the scanned share. |

Mount multiple shares under `/data/<name>` (e.g. `/mnt/user/movies:/data/movies:ro`) and
point `ROOTS` at each, or add more volumes and reference them in `ROOTS`.

## Ports

| Container | Purpose |
|-----------|---------|
| `8080`    | Web UI + API (HTTP). |

## Environment variables

### Core

| Variable   | Default        | Description |
|------------|----------------|-------------|
| `ROOTS`    | `Data=/data`   | The directories to scan, as `Label=/path,Label2=/path2`. Paths are the **in-container** mount points (`/data`), not host paths. A bare path (`ROOTS=/data`) derives its label from the basename. Because `=` and `,` are legal in paths, a path containing `,` must use the explicit `Label=/path` form. |
| `PUID`     | `1000`         | User id the app runs as. Set to the owner of your `/db` appdata directory so the store is writable. |
| `PGID`     | `1000`         | Group id the app runs as. |
| `TZ`       | container/UTC  | Timezone, used to interpret scheduled scan windows. |

### Authentication (optional)

| Variable         | Default   | Description |
|------------------|-----------|-------------|
| `PASSWORD`       | *(unset)* | Shared login password. Unset = open (no login). |
| `SESSION_SECRET` | *(random)*| ≥32-char secret that seals the session cookie. If unset, an ephemeral key is generated and **all logins reset on restart** — set a fixed value in production. |

> The session cookie is sent over plain HTTP (works on a LAN). For exposure beyond a
> trusted network, put TLS in front (reverse proxy, Tailscale, etc.).

### Scanning schedule (optional)

Automatic scanning is **opt-in** — off unless you set `SCAN_ENABLED=true` or express any
schedule intent (`SCAN_INTERVAL` / `SCAN_WINDOWS`). With it off, the service is manual-only
(Start/Stop in the UI). Everything below can also be set per-root in the UI.

| Variable              | Default   | Description |
|-----------------------|-----------|-------------|
| `SCAN_ENABLED`        | *(auto)*  | `true`/`1` to enable automatic scanning. Defaults on if an interval or window is set. |
| `SCAN_INTERVAL`       | *(none)*  | Staleness threshold before a rescan, e.g. `24h`, `7d`, `90m`. |
| `SCAN_WINDOWS`        | *(none)*  | Weekly time windows when scanning is allowed, e.g. `Mon-Fri 02:00-05:00`. |
| `SCAN_MIN_INTERVAL`   | `1h`      | Minimum floor between rescans, regardless of other triggers. |
| `SCAN_CONCURRENCY`    | `4`       | Max concurrent filesystem syscalls during a walk. |
| `SCAN_ON_WINDOW_END`  | `finish`  | `finish` lets an in-flight scan complete past a window's end; `abort` stops it. |
| `HISTORY_GENERATIONS` | `0`       | How many past scan generations to retain (0 = keep only the live one). |

### Compression (optional)

| Variable               | Default | Description |
|------------------------|---------|-------------|
| `COMPRESSION`          | `true`  | brotli/gzip content-negotiated compression of API + SPA. `false` to disable. |
| `COMPRESSION_QUALITY`  | `5`     | brotli quality, 0–11. |
| `COMPRESSION_MIN_SIZE` | `1024`  | Minimum response size (bytes) to compress. |

## Notes

- **Runs as non-root.** Set `PUID`/`PGID` (default `1000`) to match the owner of your `/db`
  appdata directory; the container adjusts the runtime user to those ids and `chown`s `/db`
  on start, so the store is writable without any manual `chown`. The read-only `/data` share
  is never touched.
- **Healthcheck** built in — hits `/api/health`, which also pings the store, so your
  orchestrator shows green/red honestly.
- Tags: `latest`, plus semver `X.Y.Z` and `X.Y` per release.

## Source & support

Source, issues, and full docs: **https://github.com/treewyrm/webdirstat**
License: MIT.
