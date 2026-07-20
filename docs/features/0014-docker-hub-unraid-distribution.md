# 0014 — Docker Hub image + Unraid Community Applications

Status: **In progress** — **v0.1.0 is published to Docker Hub** as
`treewyrm/webdirstat` (multi-arch amd64+arm64; tags `0.1.0`, `0.1`, `latest`;
verified pull + run + health). Publishing pipeline and PUID/PGID runtime have
landed. Remaining: author the Unraid CA template (the last mile to one-click
install).

Related: [Dockerfile](../../Dockerfile) (the runtime image this ships),
[config.ts](../../server/src/config.ts) (the env vars a template must expose),
[feature 0001 — password protection](0001-password-protection.md) (**Done** —
the `PASSWORD`/`SESSION_SECRET` gate; the template should surface `PASSWORD`).

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

1. ~~**No published image.**~~ **Done** ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)):
   a `v*` tag push builds and pushes multi-arch to Docker Hub. `v0.1.0` is
   published and verified (pulls, runs, `/api/health` 200).
2. ~~**No multi-arch build.**~~ **Done** — the workflow builds `linux/amd64` +
   `linux/arm64` via QEMU + Buildx so the template "just works" on both.
3. **No CA template.** Unraid CA needs an XML template (the `<Container>` schema)
   describing ports, volumes, env vars, an icon, and a support/overview blurb.
4. ~~**No auth.**~~ **Done** (feature 0001). A shared-password gate ships behind
   the `PASSWORD` env var (opt-in; `SESSION_SECRET` seals the cookie). The CA
   template should expose `PASSWORD` as a prominent field and note that the
   cookie is `secure:false`, so TLS (reverse proxy / Tailscale) belongs in front
   for anything past a trusted LAN.

## Shape of the change

### Publishing pipeline

- ~~**GitHub Actions workflow**~~ **Done** ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)):
  on tag push (`v*`), `docker/build-push-action` with
  `platforms: linux/amd64,linux/arm64`, QEMU + Buildx, pushing to Docker Hub
  (`treewyrm/webdirstat`) with tags `latest`, `X.Y.Z`, and `X.Y`. Needs repo
  secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`.
- ~~**Image labels**~~ **Done** — `docker/metadata-action` injects
  `org.opencontainers.image.*` (source, revision, version, created auto; plus
  title/description/licenses set in the workflow). CA and Unraid's UI surface
  some of these.
- Consider **GHCR mirror** as well; costs nothing and gives a fallback registry.

### The Dockerfile is basically ready — small tightening

- ~~Add OCI labels~~ **Done** (via the workflow's `metadata-action`, above).
- ~~Add a **`HEALTHCHECK`**~~ **Done.** [Dockerfile](../../Dockerfile) now
  declares a `HEALTHCHECK` hitting a dedicated
  [`GET /api/health`](../../server/src/routes/health.ts) probe (cheaper and more
  honest than `/api/roots`: it also pings the SQLite store with `SELECT 1` and
  returns **503** if the store is unreachable, so Unraid's UI shows green/red
  correctly). The probe uses Node's global `fetch` rather than `wget` to avoid
  depending on busybox's HTTP-status handling.
- ~~Confirm the `/db` volume ownership story…~~ **Done — adopted (b).** The image
  now ships [`docker-entrypoint.sh`](../../docker-entrypoint.sh): it starts as
  root, remaps the `node` user/group to `PUID`/`PGID` (default 1000) via
  `usermod`/`groupmod` (shadow), `chown -R`s `/db`, then drops to `node` via
  `su-exec`. `/data` (read-only) is never chowned. Verified that a custom
  `PUID=1500 PGID=1600` remaps the process, takes `/db` ownership, and boots
  (health 200).

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
  - `PASSWORD` (feature 0001) — the shared login password; prominent, empty by
    default (blank = open). `SESSION_SECRET` — advanced; if left blank the app
    generates an ephemeral key (logins reset on container restart), so the
    template should ideally seed a random one.
  - `SCAN_ENABLED`, `SCAN_INTERVAL`, `SCAN_WINDOWS`, `SCAN_CONCURRENCY`,
    `SCAN_MIN_INTERVAL`, `SCAN_ON_WINDOW_END`, `HISTORY_GENERATIONS` — all
    advanced/optional; hide behind "Show more settings."
  - Leave `PORT`/`HOST`/`CLIENT_DIST`/`DB_PATH` fixed (not user-facing) — the
    template's volume/port mappings handle those.
- **Icon** + **overview** text + support thread URL (CA requires these).

## Open questions

- ~~**Registry namespace + image name**~~ **Resolved** — `treewyrm/webdirstat`,
  public; v0.1.0 published there.
- ~~**PUID/PGID vs. fixed uid 1000**~~ **Resolved — PUID/PGID** (see the
  entrypoint under "The Dockerfile is basically ready" above).
- ~~**Auth before promotion**~~ **Resolved** — feature 0001 landed the
  `PASSWORD` gate, so exposure is opt-in-safe. Remaining nicety: the CA template
  should default `SESSION_SECRET` to a generated value so logins survive restart.
- **Multi-root ergonomics** — is "many host shares under one `/data`" enough, or
  do we want first-class multi-volume support in the template? Probably start
  with the single `/data` + subfolders pattern and document it.
- ~~**Versioning source of truth**~~ **Resolved** — the workflow derives image
  tags (`X.Y.Z`, `X.Y`, `latest`) from the pushed git tag via `metadata-action`;
  first release is `v0.1.0`.

## Recommendation

Sequence it as: ~~**(1)** tighten the Dockerfile (OCI labels, `HEALTHCHECK`,
PUID/PGID entrypoint)~~ ✅, ~~**(2)** add the tag-triggered multi-arch build-push
workflow to Docker Hub~~ ✅, ~~**(3)** ship a minimal auth gate (0001)~~ ✅,
**(4)** author + submit the Unraid CA template. Steps 1–3 have landed and
`v0.1.0` is published; **(4)** is the last mile to one-click install.

## Decision

**Shipped v0.1.0.** The publishing pipeline and NAS-friendly runtime are in and
`v0.1.0` is live on Docker Hub (verified pull + run + health). The Unraid CA
template remains to be authored (step 4).

### Note: label/annotation source of truth (metadata-action)

`docker/metadata-action`'s `labels` input does **not** feed the `annotations`
output — a custom `labels:` block gave the image config a "WebDirStat" title +
custom description while the manifest annotations still showed the repo name
(`webdirstat`) + repo description, so the two disagreed. Fix: dropped the custom
`labels:` block and let the **repo's own name/description/license** drive both
outputs (one source of truth, self-syncing). The already-published `v0.1.0`
manifest keeps the minor cosmetic mismatch; the fix lands on the next release.
