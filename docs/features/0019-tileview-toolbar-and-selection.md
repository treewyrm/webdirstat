# 0019 — Tileview toolbar & selection

Status: **Proposed** (selection model + toolbar shape decided; the Files-mode bulk
cap is the one open question).

Related: [feature 0006 — Export / copy paths](0006-export-paths.md) (the primary
**consumer** of the selection this feature produces — it grew out of the 0006
discussion and outgrew it), [feature 0002 — Pan/zoom treemap](0002-pan-zoom-treemap.md)
(the camera/canvas this sits on), [feature 0010 — Shaded tiles](0010-shaded-treemap-tiles.md)
and [feature 0011 — Color by age](0011-color-by-age.md) (whose view controls this
relocates onto the toolbar — surface only, no behavior change), [feature 0016 — Scope
to subfolder](0016-scope-view-to-subfolder.md) (whose breadcrumb affordance the
too-big-to-marquee case reuses).

## Background

This started as the selection half of 0006 ("let the user mark nodes, then export
their paths"). The design conversation kept growing — directories as first-class
marks, a boolean marquee, a Files/Folders target toggle, interaction modes — until it
was clearly a **canvas UI update**, not an export detail. So the selection model and
the toolbar that drives it live here; 0006 keeps only the act of turning a selection
into clipboard text / a file.

## Goal

Give the treemap (tileview) a small **toolbar** that makes its now-richer interaction
model **discoverable** and consolidates the view controls that today float loose near
the map or hide in the Settings modal:

- an **interaction-tool** switch — Navigate vs. Marquee,
- a **selection target** switch — Files vs. Folders,
- the **tile color mode** controls (extension / age, cushion shading) relocated from
  [App.vue](../../client/src/App.vue) / Settings, and
- the **selection status** (count + Clear) with the hook to **Export** (0006).

The selection itself is a single, durable, `localStorage`-persisted set that every
surface (canvas, file-list, later search) writes into.

## The toolbar

A control strip **docked above the view**, spanning the map's own column (not the
app-wide header, and not floating over the canvas): the treemap now lives in a `.view`
flex-column that owns `[TileToolbar.vue](../../client/src/components/TileToolbar.vue)`
plus the map, so a future non-treemap view drops into the same slot with its own strip.
Docking above (rather than floating over) keeps it from obscuring content at any zoom.
It hosts, grouped:

1. **Interaction tool (mutually exclusive):**
   - **Navigate** (cursor icon) — *default.* Drag pans, wheel zooms, plain-click
     toggles a single target into/out of the selection.
   - **Marquee** (area icon) — drag draws a selection box; wheel still zooms; **pan
     relocates to space-drag** (the drawing-app convention) since drag is now the box.
2. **Selection target (mutually exclusive) — a two-button, icon-only segmented
   control** (file icon | folder icon), active one visibly highlighted so it reads as
   a choice *between the two*. Governs what the canvas click/marquee targets.
   **Default: Files** (files occupy the space, not folders). Persisted.
3. **View / color** — the `colorMode` select (extension / age) + the **shaded
   (cushion)** toggle, moved here from [DisplaySettings.vue](../../client/src/components/DisplaySettings.vue)
   / the loose select at [App.vue](../../client/src/App.vue) `.color-mode`. They bind
   the **same shared `settings` state**, so this is a relocation, not a fork; the
   Settings modal can keep the full-labelled versions or cede them. The **age legend**
   rides along near the toolbar when age mode is active.
4. **Selection status + export** — an always-visible **count + one-click Clear** ("12
   marked · Clear"), plus two direct **export buttons — Copy (clipboard)** and **Save
   (file)** — whose behavior (path form, format, subsumption, the optional endpoint) is
   [0006](0006-export-paths.md)'s. They're disabled when the selection is empty.

## Interaction model

Modal tools are the **primary, discoverable** path; the modifier gestures are kept as
**optional accelerators** so a power user needn't switch tools (hybrid — the marquee's
`zoom.filter` work is the same either way, so keeping them is nearly free).

| Tool | Drag | Alt-drag | Plain-click | Wheel |
|---|---|---|---|---|
| **Navigate** (default) | Pan | *(accel.)* subtract-marquee | Toggle one target | Zoom |
| **Marquee** | Add-marquee | Subtract-marquee | Toggle one target | Zoom |

- In **Navigate** mode, **shift-drag** is the accelerator for add-marquee (so you can
  lasso without leaving the cursor tool); **alt-drag** subtracts. In **Marquee** mode
  those are the base gestures (plain-drag adds, alt-drag subtracts) and **pan is
  space-drag**.
- **No "replace" marquee**, ever — the set is persistent and accretes across a cleanup
  tour, so a silent wipe is a footgun. "Start over" is the explicit **Clear** button.
- **Full-containment**, not intersection — grazing a neighbor shouldn't grab it.
- **Shift-click stays Scope** (feature 0016), distinct from shift-*drag*; d3 already
  splits click vs. drag on a move threshold.
- **Live preview during a drag:** additions wash in the accent; subtractions show a
  "will-remove" treatment over currently-marked items in the band; commit on release.
  This live snap is what makes containment usable despite gapless packing (below).

## The selection set

- **A single, path-keyed, heterogeneous set** (`{ rootId → [relative paths] }`) shared
  by every surface. Files *and* directories are first-class. Keyed by **path, not
  `id`** — `id`s are reassigned every rescan swap; paths are the durable anchor already
  used by breadcrumbs and the stale-reseed, so the set survives LOD churn *and* a
  generation swap mid-session.
- **A marked directory is one member** (exported as one line — see 0006), not an
  expansion of its contents.
- **Subsumption / dedup.** A marked descendant under a marked directory is redundant;
  collapse to the **shallowest marked ancestors** (a prefix check over the path keys).
  Holds across mode switches (mark a folder in Folders mode, add a file inside it in
  Files mode → the file is subsumed).
- **Persist to `localStorage`.** The path-keyed form *is* the durable form, so it
  survives a refresh and a 410 re-seed. (1) **Don't auto-prune** marks whose path
  vanished on a later rescan — a deleted path is still a meaningful "delete this" line;
  it just won't resolve for on-map highlight (subtle "not in current scan" affordance,
  later). (2) The invisible-persisted-set footgun is why **count + Clear** is required.

## Files vs. Folders semantics

The target toggle is **per-operation**, not a property of the set — flip freely and
the set holds a mix.

- **Folders mode** (target = directories):
  - *Marquee* marks every directory the band **fully contains**, collapsed to the
    shallowest (subsumption). If the band fully contains **no** directory but lies
    wholly **within one**, mark *that* directory — so a sloppy box roughly over a
    folder's area still grabs the folder (handles the undershoot from gapless packing).
    Files are never marked as units here.
  - *Click* marks the **directory enclosing the hit point** — clicking a *file* tile
    marks *its folder*. This dissolves the "everything I can click is a file tile"
    problem: in Folders mode a click always resolves up to a directory.
- **Files mode** (target = leaves): marquee/click mark individual **files**
  (fully-contained leaves). No folder collapse.

## The too-big-to-marquee case

You can't marquee a folder **larger than the viewport** — the one you're zoomed
*into*. Covered with no new gesture: **Folders-mode click** (resolves to the enclosing
folder) and a **mark toggle on the breadcrumb** — the same spot feature 0016 put
"scope here" for the identical "focused folder has no catchable tile" problem.

## Rendering

A marked directory renders as a **wash/tint over its whole rect** that persists as you
zoom into it (otherwise a marked folder vanishes the moment it expands), which also
visualizes subsumption — children sit visibly under the folder's mark. Marked files
get the same wash on their tile. Reuse the existing highlight-overlay draw pass
(feature 0012) rather than a DOM layer.

## Deferred non-goal: hole-punching / exclusions

Boolean **subtract operates on whole marked items** and **cannot fracture a marked
folder** — an alt-drag that doesn't fully enclose a marked folder does nothing to it.
"Mark folder X *except* subfolder Y" (materialized exclusions) is an explicit **v2**
feature: it would turn one clean folder line into potentially thousands of
surviving-child lines, destroying the export property that made directory-marking worth
doing. Not a modifier side-effect.

## Shape of the change

- **New component** — a `TileToolbar.vue` (name TBD) rendered over the canvas by
  [App.vue](../../client/src/App.vue), holding the tool/target/color/status groups and
  emitting the active tool + target + Clear/Export; first real on-canvas chrome.
- [MapTreemap.vue](../../client/src/components/MapTreemap.vue): accept `tool` /
  `targetMode` props; add the marquee overlay + band math; register the marquee
  drag-modes and space-drag-pan in `zoomBehavior.filter(…)` (none today); extend the
  draw pass with the selection wash (reusing the 0012 overlay); **remove the dead
  fly-to-folder** click branch.
- **Selection store** — a small path-keyed reactive store with `localStorage`
  persistence, subsumption on read/export, and add/subtract/toggle/clear ops; consumed
  by the canvas, [FileList.vue](../../client/src/components/FileList.vue) (row
  checkboxes), and later Search.
- [App.vue](../../client/src/App.vue): relocate the `colorMode` select + shaded toggle
  + age legend into the toolbar (same `settings` state); wire the breadcrumb mark
  toggle.
- [layout.ts](../../client/src/treemap/layout.ts): no change — its `.paddingInner(0)`
  gapless packing is what makes containment == folder-selection clean (and is the
  source of the undershoot nuance handled above).
- No server, store, protocol, or scan changes (export's optional endpoint is 0006).

## Open questions

- **Files-mode bulk cap — undecided, must be resolved.** In Files mode there's no
  folder collapse, so enclosing a folder full of many small files can mark thousands of
  leaves → thousands of export lines. There clearly needs to be an **upper limit**, but
  the exact behavior is unsettled: a hard cap, a soft warning with a "switch to
  Folders?" nudge, auto-promotion to the enclosing folder past a threshold, or
  something else. **Flagged, not decided.** *Interim:* the implementation uses a hard
  cap (`FILES_MARQUEE_CAP = 500`) that **refuses** an over-cap Files-mode add with a
  transient notice, as a safe placeholder until this is settled.
- ~~**Toolbar placement**~~ — **settled:** a strip docked above the view column (see
  "The toolbar"), not a floating group. Responsiveness on narrow viewports (how the
  groups wrap/collapse) is still open.
- **Whether the color controls fully leave the Settings modal** or are mirrored in both
  (both bind the same state, so either is safe — a UX call, not a correctness one).

## Decision

**Decided** for the selection model and toolbar shape; feature stays **Proposed**
overall pending the Files-mode bulk cap and toolbar-placement details.

- A **toolbar** over the canvas with: Navigate/Marquee tool switch (modal; pan →
  space-drag in Marquee), Files/Folders target toggle (icon two-button, **default
  Files**, persisted), relocated color-mode + shaded controls, and selection count +
  Clear + Export.
- **Modal tools primary, modifier gestures kept as accelerators** (shift-drag add /
  alt-drag subtract in Navigate too). **No replace**, **full-containment**, live
  preview.
- A **path-keyed, `localStorage`-persisted, heterogeneous** selection set; directories
  are one subsuming member; no auto-prune of vanished paths.
- Per-mode click/marquee semantics as above; **breadcrumb mark** + Folders-click for
  the too-big-to-marquee folder; **hole-punching/exclusions deferred to v2**;
  **fly-to-folder removed**.
