# 0007 — Unified settings modal

Status: **Done** — shipped as the ⚙ Settings modal ([SettingsModal.vue](../../client/src/components/SettingsModal.vue)) with **Display** ([DisplaySettings.vue](../../client/src/components/DisplaySettings.vue), backed by [useDisplaySettings.ts](../../client/src/composables/useDisplaySettings.ts)) and **Scanning** (migrated `ScheduleEditor`) categories; the Schedule ghost button is retired. The Display panel also absorbed the shaded-tiles ([feature 0010](0010-shaded-treemap-tiles.md)) and color-by-age ([feature 0011](0011-color-by-age.md)) toggles that landed after this was written, beyond the v1 hover-path + size-units scope.

Originally scoped as a small client-local *display* pane (a ghost-toggle drawer
mirroring the schedule editor). Reframed during planning into a single **settings
modal** that is the one home for everything configurable — client-local display
prefs *and* the existing per-root server schedule — with a category rail on the
left and a detail panel on the right.

Raised during first hands-on testing of the pan/zoom treemap
([feature 0002](0002-pan-zoom-treemap.md)).

## Goal

A modal window (native `<dialog>` + `showModal()` — free backdrop, focus-trap,
Esc-to-close) opened from a single **⚙ Settings** button in the top bar. Left: a
category rail. Right: the active category's form. It unites every configurable
surface under one roof so settings have a predictable home as they accrue,
instead of sprouting one ghost-toggle drawer per concern.

This **replaces** two things:

- The narrow "client-local display pane" this doc originally proposed — that
  becomes the **Display** category.
- The standalone **Schedule** ghost button + inline `ScheduleEditor` drawer in
  [App.vue](../../client/src/App.vue) — that becomes the **Scanning** category.
  The top bar drops the Schedule toggle; one Settings button takes its place.

The **Types** toggle stays in the top bar — it is a data *view*, not a setting,
and is not absorbed.

## Two kinds of config under one modal

The categories differ in scope, and the modal must stay honest about that:

| Category    | Scope             | Storage                          | Per-root? |
| ----------- | ----------------- | -------------------------------- | --------- |
| **Display** | global, per-device| `localStorage` (`wds.display`)   | no        |
| **Scanning**| per-root          | server (`PUT /api/roots/:id/schedule`) | **yes** |

**Root context: a modal-wide root switcher lives in the modal header** (seeded
from `App`'s `selectedRootId`). Per-root categories (Scanning) configure the
switcher's current root; global categories (Display) ignore it. The switcher is
only meaningful for per-root categories, so it is hidden/disabled while a global
category is active and revealed when a per-root category is selected.

### Why Display is client-local

- The server store is about *what was scanned*; display prefs are about *how one
  person likes to look at it*. Two viewers of the same instance can differ
  without stepping on each other.
- No API, no schema, no migration — a `localStorage` key and a reactive object.
- Survives reloads; resets cleanly if cleared.

## Categories (v1)

- **Display** (client-local, global) — ship two real settings:
  - **Hover label: full path vs. name only** — the toggle behind
    [feature 0008](0008-treemap-interaction-refinements.md)'s full-path hover.
  - **Size units** — binary (MiB/GiB) vs. decimal (MB/GB); today `formatBytes`
    ([format.ts](../../client/src/utils/format.ts)) picks binary unconditionally.

  Follow-ups slotted into the same pane later: label density (draw tile names +
  min tile size), reduce motion (skip/shorten fly-to `FLY_MS`), color-scheme
  knobs (dim files vs. dirs, extension-hash intensity —
  [color.ts](../../client/src/utils/color.ts)).

- **Scanning** (per-root, server) — the current `ScheduleEditor` form verbatim
  (automatic scanning, refresh interval, quiet-hours windows, timezone,
  concurrency, min gap, on-window-end, history generations), now driven by the
  modal-wide root switcher instead of the app's root select.

- *(placeholder rail slot — e.g. **About/Roots** — a later category; its
  existence is part of why a rail beats a flat drawer.)*

## Shape of the change

- **`useDisplaySettings` composable** (client) — a reactive settings object
  seeded from `localStorage` and `watch`-persisted back under one namespaced key
  (`wds.display`), with a typed default and a `version` field so a future shape
  change can be migrated or discarded rather than throwing.
- **`SettingsModal.vue`** — the `<dialog>` shell: header (title + root switcher +
  close), left category rail, right detail slot. Owns which category is active.
- **`DisplaySettings.vue`** — the Display panel; reads/writes the composable.
- **Scanning panel** — reuse the existing `ScheduleEditor.vue` body, lifting its
  root from a prop fed by the modal switcher (it already takes `rootId`).
- **Consumers** read the composable: `MapTreemap.vue` (hover label, later labels/
  motion/colors) and the file-list/breadcrumb formatting (units).
- **Units formatting** — thread the unit choice through a shared formatter rather
  than re-reading settings at each `formatBytes` call site.

## Open questions

- **Reset control.** A "restore defaults" button on the Display panel — cheap,
  worth it (client-local only; the server schedule has its own Save).
- **Where units live.** `formatBytes` is called in several places
  (`App.vue`, `FileList.vue`, `TypeList.vue`); pass the unit base into the
  formatter or wrap it, don't re-read settings per call site.
- **Switcher visibility.** Hide vs. disable the header root switcher on global
  categories — lean toward hide so Display reads as unambiguously global.

## Recommendation

Ship the modal with the **Display** category (two real settings: hover full path,
size units) and the **Scanning** category (the migrated schedule form), retire
the Schedule ghost button, and wire the hover toggle to
[feature 0008](0008-treemap-interaction-refinements.md). Everything else in the
Display candidate list is a follow-up that drops into the same rail.

## Decision

Decided: unified `<dialog>` settings modal, category rail + modal-wide root
switcher, single ⚙ Settings button replacing the Schedule toggle. Ready to
implement.
