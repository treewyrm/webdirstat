# 0014 — Docker Hub image + Unraid Community Applications

Status: **Proposed**

Related: [Dockerfile](../../Dockerfile) (the runtime image this ships),
[config.ts](../../server/src/config.ts) (the env vars a template must expose),
[feature 0001 — password protection](0001-password-protection.md) (basically a
prerequisite once this is reachable on a home network).

## Goal

Turn the existing single-container image into something a NAS user installs in
two clicks: a **published, multi-arch Docker Hub image** and an **Unraid
Community Applications (CA) template** that maps the volumes and env vars
correctly by default. Primary motivating use case: run WebDirStat against a local
Unraid array to get WinDirStat-style disk-usage insight on the NAS itself.

The container already exists and is well-formed (`node:24-alpine`, non-root
`node` user, `/data` read-only + `/db` writable split, sane env defaults). This
feature is almost entirely **packaging, publishing, and defaults** — not app code.

## What's missing today

1. **No published image.** [Dockerfile](../../Dockerfile) builds locally but
   nothing pushes to a registry, and there's no CI to build it. `ls
   .github/workflows` is empty.
2. **No multi-arch build.** Unraid boxes are overwhelmingly `amd64`, but plenty
   of home NAS/ARM users exist; publish `linux/amd64` + `linux/arm64` so the
   template "just works" on both.
3. **No CA template.** Unraid CA needs an XML template (the `<Container>` schema)
   describing ports, volumes, env vars, an icon, and a support/overview blurb.
4. **No auth.** The moment this is reachable on a home LAN it exposes real host
   directory *structure* (not contents, but names + sizes). See 0001 — some
   minimal gate should ship before this is promoted for general use.

## Shape of the change

### Publishing pipeline

- **GitHub Actions workflow** (`.github/workflows/release.yml`): on tag push
  (`v*`), `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`,
  QEMU + Buildx, pushing to Docker Hub (`treewyrm/webdirstat` or similar) with
  tags `latest`, `X.Y.Z`, and `X.Y`.
- **Image labels** (`org.opencontainers.image.*`): source, version, license
  (MIT — already added), description. CA and Unraid's UI surface some of these.
- Consider **GHCR mirror** as well; costs nothing and gives a fallback registry.

### The Dockerfile is basically ready — small tightening

- Add OCI labels (above).
- ~~Add a **`HEALTHCHECK`**~~ **Done.** [Dockerfile](../../Dockerfile) now
  declares a `HEALTHCHECK` hitting a dedicated
  [`GET /api/health`](../../server/src/routes/health.ts) probe (cheaper and more
  honest than `/api/roots`: it also pings the SQLite store with `SELECT 1` and
  returns **503** if the store is unreachable, so Unraid's UI shows green/red
  correctly). The probe uses Node's global `fetch` rather than `wget` to avoid
  depending on busybox's HTTP-status handling.
- Confirm the `/db` volume ownership story survives a fresh Unraid install:
  Unraid bind-mounts host paths and often runs containers with `PUID`/`PGID`
  conventions. The image currently hardcodes `USER node` (uid 1000). Decide
  whether to (a) keep uid 1000 and document it, or (b) adopt the
  LinuxServer.io-style `PUID`/`PGID` + entrypoint `chown` pattern that Unraid
  users expect. **(b)** is the friendlier NAS default and worth doing here.

### Unraid CA template (`webdirstat.xml`)

A `<Container>` XML, typically hosted in a `unraid-templates` branch/repo and
submitted to the CA app feed. Must encode:

- **WebUI**: `http://[IP]:[PORT:8080]/`
- **Port**: `8080` → host (default 3000-ish, user-editable).
- **Volumes**:
  - `/data` → an array/share path, mounted **read-only** (`:ro`). The template
    should default it read-only and explain why (the app never writes there, and
    RO is a real safety guarantee for a disk tool).
  - `/db` → a small writable appdata path (`/mnt/user/appdata/webdirstat`).
- **Env vars**, mapped from [config.ts](../../server/src/config.ts) with helpful
  descriptions and sensible Unraid defaults:
  - `ROOTS` — the one that needs the clearest docs. Format
    `Label=/path,Label2=/path`, where the paths are the **in-container** mount
    points (i.e. `/data`), not host paths. A bare unlabeled path is also
    accepted (`ROOTS=/data`); the label is then derived from the path's basename
    (`data`), never the raw path. Because `=` and `,` are both legal in
    filesystem paths, a path containing `,` — or an unlabeled path containing
    `=` — must use the explicit `Label=/path` form. Multi-root story: either
    mount several host shares under `/data/<name>` and set
    `ROOTS=Movies=/data/movies,...`, or add more `/dataN` volume mappings.
  - `SCAN_ENABLED`, `SCAN_INTERVAL`, `SCAN_WINDOWS`, `SCAN_CONCURRENCY`,
    `SCAN_MIN_INTERVAL`, `SCAN_ON_WINDOW_END`, `HISTORY_GENERATIONS` — all
    advanced/optional; hide behind "Show more settings."
  - Leave `PORT`/`HOST`/`CLIENT_DIST`/`DB_PATH` fixed (not user-facing) — the
    template's volume/port mappings handle those.
- **Icon** + **overview** text + support thread URL (CA requires these).

## Open questions

- **Registry namespace + image name** — `treewyrm/webdirstat`? Confirm Docker Hub
  account and whether the repo should be public.
- **PUID/PGID vs. fixed uid 1000** — adopt the Unraid-idiomatic pattern (leaning
  yes) or document the fixed user? Affects `/db` write permissions on first run.
- **Auth before promotion** — does 0001 (or at least an optional
  `AUTH_PASSWORD` env → basic gate) need to land first? A disk-map of someone's
  NAS is mildly sensitive; recommend shipping *some* opt-in gate concurrently.
- **Multi-root ergonomics** — is "many host shares under one `/data`" enough, or
  do we want first-class multi-volume support in the template? Probably start
  with the single `/data` + subfolders pattern and document it.
- **Versioning source of truth** — root `package.json` version → git tag → image
  tag. Wire the workflow to derive image tags from the pushed git tag.

## Recommendation

Sequence it as: **(1)** tighten the Dockerfile (OCI labels, ~~`HEALTHCHECK`~~ ✅,
PUID/PGID entrypoint), **(2)** add the tag-triggered multi-arch build-push
workflow to Docker Hub, **(3)** ship a minimal auth gate (0001) so exposure is
opt-in-safe, **(4)** author + submit the Unraid CA template. Steps 1–2 are pure
packaging and can happen anytime the app is stable; 3 gates the "recommend to
others" moment; 4 is the last mile to one-click install.

## Decision

Not yet decided — deferred until the app is stable enough for external use.
This doc captures the plan so it survives to that point.
