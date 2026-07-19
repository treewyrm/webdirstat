# 0016 — Scope the map view to a subfolder

Status: **Decided** — Model A (world root carries the subfolder as its base `path`).
Not yet implemented.

Bring back the ability (present in the original tech demo, dropped in the move to the
camera-derived "Google-Maps" view) to open the treemap **rooted at a subfolder** of a
configured root, instead of always the root itself. Purely a **view/read** concern —
**no scanning involved**. The store already holds the whole tree; this just chooses a
different node as the world root the camera sits over.

Motivation: on a large share you often want to work inside one folder without the rest
of the tree competing for pixels — treat `Data/projects/foo` as the whole map for a
while, then pop back out.

## Today

The server already supports reading any subpath — `GET /api/tree?root&path` is *the*
path entry point, and `POST /api/tree/batch` is id+generation based. Scoping is
entirely a client seeding question; **no API or store change is needed.**

The client always seeds the world root from the configured root:

- [App.vue](../../client/src/App.vue) `loadRoot()` calls `fetchTree(rootId, "", …)` —
  the empty path is the root — and stores the result as `seed`.
- [MapTreemap.vue](../../client/src/components/MapTreemap.vue) `reseed()` builds the
  world root with `makeRoot(props.seed.node, …)`, its world rect the whole viewport.
- [layout.ts](../../client/src/treemap/layout.ts) `makeRoot` fixes the world root's
  `path` to `""`, and `layoutInto` builds every descendant's `path` by appending names
  down from there. Those node paths are **root-relative** and feed everything
  path-driven: breadcrumbs, the Files/Types/Search panes (`focusPath`), `flyToPath`,
  and the stale-reseed anchor.

So "scope to a subfolder" = seed the world root from `fetchTree(rootId, subpath, …)`
instead of `""`. The read Just Works; the real work is reconciling the **path base**
so everything downstream still resolves correctly.

## The crux: path base bookkeeping

Every server call that takes a `path` expects it **relative to the configured root**,
but the tree-walk helpers (`flyToPath`, `descendLoaded`) walk segments **from the world
root**. Today those two frames coincide because the world root *is* the configured root
(base = `""`). Seed at a subfolder and they diverge — that gap is the whole feature.

Two ways to close it:

### A. World root carries the subfolder as its base `path`

Seed `makeRoot(props.seed.node, …)` with `path = subpath` instead of `""`; children
keep appending, so **all node paths stay root-relative** and the path-consuming panes
(Types, Search, breadcrumbs, stale-reseed) work unchanged.

- **Costs:** the tree-*walk* helpers now break the other way — `flyToPath` /
  `descendLoaded` split a path and walk from the world root's children, so they must
  **strip the base prefix** first. `flyToChild` in App builds `${focusPath}/${name}`
  (root-relative), which lands correctly at the panes but must be de-based before it
  reaches `flyToPath`. A handful of spots, each small.

### B. World root stays `""`-based; a separate anchor prefixes server calls

Keep node paths relative to the *subfolder* world root, and store the subfolder base
separately (a `viewRoot` ref in App / prop on the map). Prefix it onto every server
`path` call (`fetchTree` reseed, Types, Search) and strip it off nothing (walks are
already world-root-relative).

- **Costs:** every path-driven pane and the stale-reseed must remember to apply the
  prefix; easy to miss one. Breadcrumbs naturally start at the subfolder (may be a win
  — see below).

**Lean A.** Root-relative node paths are the existing contract that the most code
already assumes (three panes + reseed vs. two walk helpers); keeping that invariant and
fixing the two walkers is the smaller, less error-prone change.

## Sub-decisions

- **How the subfolder is chosen.** Natural triggers: a context action on a directory
  tile / file-list row / breadcrumb ("Open as root" / "Focus here"), and a way back out
  ("Up to full root"). The camera already has fly-to; this is a distinct *reseed*, not
  a fly — the world rect resets to the subfolder.
- **Breadcrumbs above the scope root.** Show the ancestors up to the configured root
  (context, and the click target to zoom back out), or start the trail fresh at the
  scope root? Showing them — rendered but visually marked as "above scope" — preserves
  the way out and matches the demo. This interacts with the A/B choice (A has the full
  root-relative path in hand; B does not without the extra anchor).
- **Persistence / shareability.** Is the scope ephemeral (lost on reload), or encoded
  in the URL / `localStorage` so a scoped view is linkable and survives refresh? A URL
  query (`?root=…&at=projects/foo`) is the cheap, shareable option and dovetails with a
  future deep-link feature.
- **Stale-reseed.** `@stale="loadRoot"` re-seeds on a 410 (generation swap). It must
  re-seed at the **same subfolder anchor**, not `""` — trivial once the anchor is a
  first-class piece of state, but must not be forgotten (its whole job is surviving a
  rescan).
- **Scope root that vanishes on rescan.** A rescan can remove the scoped subfolder
  (deleted/renamed on disk). The reseed's `fetchTree(rootId, subpath)` will 404 → fall
  back to the full root with a notice, rather than an empty map.
- **Relationship to fly-to.** Flying into a folder already makes it the *derived*
  current folder (breadcrumbs + panes) without reseeding. Scoping is the heavier
  "make this the entire world" action — worth being clear in the UI why both exist
  (fly = navigate within the map; scope = redraw the map from here).

## Shape of the change (Model A)

- [App.vue](../../client/src/App.vue): a `viewRoot` ref (subpath, default `""`); pass it
  to `loadRoot()`'s `fetchTree` and down to the map; a UI affordance to set/clear it;
  keep it as the stale-reseed anchor. Optionally sync to the URL query.
- [layout.ts](../../client/src/treemap/layout.ts) `makeRoot`: accept a base `path` for
  the world root instead of hard-coding `""`.
- [MapTreemap.vue](../../client/src/components/MapTreemap.vue): de-base incoming paths in
  `flyToPath` / `descendLoaded` (strip the world root's base before walking segments);
  `renderedKey` should include the scope so switching scope resets the camera.
- Breadcrumbs: optionally render + mark the above-scope ancestors and route their
  clicks to a rescope-outward.

No server, store, protocol, or scan changes. Rough effort: ~half a day for the core
reseed + path de-basing; the rest is UI polish (breadcrumbs affordance, URL sync).

## Decision

**Model A** — the world root carries the subfolder as its base `path`; node paths stay
**root-relative**, and the two tree-walk helpers (`flyToPath`, `descendLoaded`) strip
that base before walking segments. Chosen over B because root-relative node paths are
the invariant the most code already assumes (three panes + stale-reseed vs. two
walkers), so keeping it and de-basing the two walkers is the smaller, less error-prone
change. Still no server, store, protocol, or scan changes.

Sub-decisions settled with A:

- **Breadcrumbs show the above-scope ancestors**, rendered but marked as "above scope,"
  with their clicks re-scoping outward (up to and including the full root). A already
  has the full root-relative path in hand, so this is free; it also preserves the way
  back out, matching the demo.
- **Scope lives in the URL query** (e.g. `?root=…&at=projects/foo`), making a scoped
  view linkable and refresh-surviving, and doubling as the durable stale-reseed anchor.
  `localStorage`-only was rejected — not shareable, and the URL form dovetails with a
  future deep-link feature.
- **Stale-reseed re-seeds at the same subfolder anchor**, not `""`. If that
  `fetchTree(rootId, subpath)` 404s (the scoped folder was removed/renamed by a
  rescan), **fall back to the full root with a notice** rather than showing an empty
  map.
- **Scope is a distinct reseed, not a fly** — the world rect resets to the subfolder.
  Fly-to stays "navigate within the map"; scope stays "redraw the map from here." Both
  affordances coexist and the UI should make the difference legible.

Implementation follows Model A under **Shape of the change** above.
