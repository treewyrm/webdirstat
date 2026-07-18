# 0007 — Display settings pane (client-local)

Status: **Proposed**

Raised during first hands-on testing of the pan/zoom treemap
([feature 0002](0002-pan-zoom-treemap.md)).

## Goal

A small **settings pane**, opened the same way the schedule editor is (a ghost
toggle button in the top bar that reveals a panel — see
[App.vue](../../client/src/App.vue) `showSchedule` /
[ScheduleEditor.vue](../../client/src/components/ScheduleEditor.vue)), holding
**display preferences that live in the browser**, not on the server.

These are per-viewer, per-device UI choices — they have no place in the server's
per-root `root_settings` (which is shared scan/schedule config). They belong in
`localStorage`.

## Why client-local

- The server store is about *what was scanned*; these are about *how one person
  likes to look at it*. Two people hitting the same instance can prefer different
  things without stepping on each other.
- No API, no schema, no migration — a `localStorage` key and a reactive object.
- Survives reloads; resets cleanly if cleared.

## Candidate settings

Start small; the pane is the home for display toggles as they accrue:

- **Hover label: full path vs. name only** — the toggle behind
  [feature 0008](0008-treemap-interaction-refinements.md)'s full-path hover.
- **Size units** — binary (MiB/GiB) vs. decimal (MB/GB); today `formatBytes`
  picks one unconditionally.
- **Color scheme knobs** — e.g. dim files vs. directories, or an intensity for the
  extension-hash palette ([color.ts](../../client/src/utils/color.ts)).
- **Label density** — whether to draw tile name labels, and the min tile size at
  which they appear.
- **Reduce motion** — skip / shorten the fly-to camera animation (`FLY_MS`).

Only the first two are worth shipping in a first cut; the rest are placeholders
that justify the pane existing.

## Shape of the change

- A `useDisplaySettings` composable (client) exposing a reactive settings object,
  seeded from `localStorage` and `watch`-persisted back under one namespaced key
  (e.g. `wds.display`), with a typed default and a version field so a future shape
  change can be migrated or discarded rather than throwing.
- A `SettingsEditor.vue` panel mirroring `ScheduleEditor.vue`'s look, toggled from
  the top bar next to **Schedule**.
- Consumers read from the composable: `MapTreemap.vue` (hover label, labels,
  motion, colors), the file-list/breadcrumb formatting (units).

## Open questions

- **Namespacing / instances.** One key for the whole app is fine; if per-root
  display prefs are ever wanted, key by root id. Start global.
- **Reset control.** A "restore defaults" button in the pane — cheap, worth it.
- **Where units formatting lives.** `formatBytes` is called in several places;
  thread the unit choice through a shared formatter rather than re-reading
  settings at each call site.

## Recommendation

Ship the composable + pane with **two real settings (hover full path, size units)**
and wire the hover toggle to [feature 0008](0008-treemap-interaction-refinements.md).
Everything else in the candidate list is a follow-up slotted into the same pane.

## Decision

Not yet decided — pending discussion.
