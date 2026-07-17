# 0001 — Password protection

Status: **Proposed**

## Goal

A single shared password gating the whole app (UI + API), configured via one
Docker env var. No accounts, no per-user anything, no login/user database —
if you know the password you're in, matching the "one NAS, one admin" reality
this is built for.

## Constraint that decides the mechanism

[api.ts](../../client/src/api.ts) drives the scan endpoint with a native
browser `EventSource`, and `EventSource` cannot send custom headers or a
bearer token — it only carries whatever the browser attaches automatically
(cookies, and cached HTTP Basic credentials for the origin). That rules out
a bearer-token/API-key scheme without also replacing `EventSource` with a
`fetch` + `ReadableStream` reader (real complexity for no real benefit here).

## Where it should live

As a single guard registered before all routes in
[server/src/index.ts](../../server/src/index.ts) — one `onRequest` hook (or
h3's `requireBasicAuth` utility, which exists for exactly this) wrapping
everything, API and the static client bundle alike. Not a login page, not
per-route checks scattered around.

## Options

### A — HTTP Basic Auth (h3's built-in `requireBasicAuth`)

Env vars: `PASSWORD` (required to enable the gate; unset = auth disabled,
same "opt-in" pattern as `ROOTS`), optional `USERNAME` (default `admin`).

- Zero custom UI — the browser's native credential prompt handles it, and
  the browser then attaches `Authorization` automatically to every
  subsequent request on the origin, including the `EventSource` scan
  request, with no client code change needed.
- Smallest possible implementation: h3 ships this utility already.
- No logout button (clearing it means clearing the browser's saved
  credentials for the origin) and no session expiry — acceptable given
  "no account management" is the explicit goal.
- Credentials are base64, not encrypted — this scheme only makes sense
  behind TLS (reverse proxy, Tailscale, etc.) or on a fully trusted LAN.
  Worth a line in the README, not a blocker for a NAS tool.

### B — Session cookie behind a small login form

Client shows a login form when it gets a 401; server sets a signed cookie
(h3 has session utils built in) after checking the password against an env
var. Cookies ride along with `EventSource` requests fine, same-origin.

- Nicer UX (matches the SPA's own look, supports a logout button, cookie
  expiry).
- Real added surface: a login route, a session secret env var, guard logic
  for "unauthenticated API call → show login" in the SPA instead of a
  browser-native prompt.

### C — Don't build it in; document a reverse-proxy pattern instead

Leave the app open and tell users to put Authelia/Traefik/nginx basic-auth/
Tailscale in front if they want a gate.

- Zero app code, and probably more secure in practice (a real reverse proxy
  handles this better long-term).
- Doesn't meet the ask — "defined as env var for docker" implies it should
  work standalone with `docker run -e PASSWORD=...`, no extra infra assumed.

## Recommendation

**A.** It's the one that's actually just "a simple check" — no login UI,
no session plumbing, works with the existing `EventSource`-based scan
endpoint unmodified, and h3 already provides the primitive. Revisit **B**
only if a logout button or session expiry turns out to matter in practice.

## Decision

Not yet decided — pending discussion.
