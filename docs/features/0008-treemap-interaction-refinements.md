# 0008 — Treemap interaction refinements (hover path + descend)

Status: **Proposed**

Two small usability items raised during first hands-on testing of the pan/zoom
treemap ([feature 0002](0002-pan-zoom-treemap.md)). Both are client-only.

## 1. Full path on hover

**Today** the hover tooltip shows only the tile's name and size
([App.vue](../../client/src/App.vue) tooltip block; the hovered `WorldNode` is
emitted from [MapTreemap.vue](../../client/src/components/MapTreemap.vue)
`onMouseMove` → `emit("hover", …)`).

Because the whole map is on screen at once, a bare filename is ambiguous — the same
name occurs under many directories, and you can't tell *where* the hovered tile
lives without reading the breadcrumbs.

**Change:** show the node's **full path** (root-relative, or with the root label
prefixed) in the tooltip. The data is already present — `WorldNode` carries `path`
(it's what `flyToPath` and the focus chain use), so this is a template change, not
a data-fetch change. Long paths should truncate/wrap so the tooltip stays readable.

Gate it behind the **hover label** toggle in
[feature 0007](0007-display-settings-pane.md) (full path vs. name only) so users who
find the full path noisy can turn it off.

## 2. Descending into a specific folder

**Today** a *single* click on a directory tile already flies the camera into it
(`onClick` → `flyTo` in `MapTreemap.vue`; the hint reads "click a folder to fly
in"). So descent exists — but testing showed it isn't discoverable, and a single
click is easy to trigger by accident while panning, so it doesn't *read* as
"enter this folder."

Options to make "go deep into this folder" deliberate and obvious:

- **Double-click to descend** (matches WinDirStat / file-manager muscle memory);
  keep single click for select/hover-detail only, or leave single-click fly-in but
  add double-click as a stronger "zoom to fill" that also re-derives the focus
  folder.
- **A descend affordance** — clicking a breadcrumb already flies to that level; a
  reciprocal "zoom into hovered folder" via double-click closes the loop.
- ~~Make the fly-in **fill the viewport more aggressively** so the descended folder
  clearly becomes the current folder~~ — **done.** The focus derivation in
  `emitFocus` requires the folder rect to *fully contain* the viewport;
  `targetTransformFor` used to *fit-inside* at 90% (`0.9 * min(ratio)`), so the
  camera glided toward a folder but it never became current — clicking a folder in
  the list (or on the map) just panned toward its region. It now **cover-fits**
  (`FLY_COVER * max(ratio)`) so the target fully contains the viewport and becomes
  the current folder; this applies to list clicks, breadcrumb clicks, and single
  clicks on the map alike.

## Shape of the change

- `MapTreemap.vue`: add a `dblclick` listener alongside the existing `click`/
  `mousemove`, reusing `nodeAtEvent` + `flyTo`. Decide the single- vs. double-click
  split (recommend: double-click = descend, single = detail only).
- Tooltip template in `App.vue`: swap `name` for `path` (toggle-gated).
- Update the on-canvas hint text to match whatever gesture is chosen.

## Open questions

- **Keep single-click fly-in?** Dropping it in favor of double-click is cleaner but
  changes current behavior; keeping both risks a confusing single-then-double.
- **Fit factor.** Should descending re-root the view so the focus folder fully
  contains the viewport (breadcrumbs update immediately), or just zoom toward it?
- **Touch/trackpad.** Double-click ≈ double-tap; confirm it doesn't fight pinch-zoom.

## Recommendation

Ship the **full-path hover** first (trivial, high value, data already present),
gated by [feature 0007](0007-display-settings-pane.md)'s toggle. Then make descent
deliberate with **double-click**, and tighten the fly-in fit so the descended folder
becomes the current folder.

## Decision

Not yet decided — pending discussion.
