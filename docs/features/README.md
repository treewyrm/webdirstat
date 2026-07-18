# Feature plans

Write-ups for planned features, one file per feature, numbered (`0001-...`). Same
status convention as [issues](../issues/): Proposed → Decided → In progress → Done.

A feature doc should cover: what it does from the user's perspective, the rough
shape of the change (which files/layers it touches), and open questions — not a
full implementation plan.

Filed:

- [0001 — Password protection](0001-password-protection.md) — *Proposed.*
  Independent of the scaling rework below.
- [0002 — Pan/zoom treemap](0002-pan-zoom-treemap.md) — *Done.* Map-style
  navigation; built on the slice store from
  [issue 0002](../issues/0002-background-scanning-service.md) (its milestone 4).
- [0003 — History & diff](0003-history-and-diff.md) — *Proposed.*
- [0004 — Search & filter](0004-search-and-filter.md) — *Proposed.*
- [0005 — File-type rollup](0005-file-type-rollup.md) — *Done.* `GET /api/roots/:id/types`
  over the walk-filled `type_rollup` table (whole-root) or an on-demand subtree
  aggregate (`?path=`) + a "By type" panel that tracks the focused folder with a
  Raw/Grouped family toggle; user-editable families deferred to 0007.
- [0006 — Export paths](0006-export-paths.md) — *Proposed.*
- [0007 — Display settings pane](0007-display-settings-pane.md) — *Proposed.*
  Client-local (`localStorage`) display preferences in a schedule-editor-style pane.
- [0008 — Treemap interaction refinements](0008-treemap-interaction-refinements.md) —
  *Proposed.* Full-path hover + deliberate descend-into-folder; from first testing.
- [0009 — File-list pane refinements](0009-file-list-pane-refinements.md) — *Done.*
  Kind icons (first Lucide dependency) + name truncation in the list pane.
- [0010 — Shaded (cushion) treemap tiles](0010-shaded-treemap-tiles.md) —
  *Proposed.* Cushion shading for depth cues on the treemap.
- [0011 — Color tiles by age](0011-color-by-age.md) — *Proposed.* Optional
  mtime-based tile coloring (old→dark, new→bright); client-only, `mtimeMs` already ships.
- [0012 — Highlight map tile on list hover](0012-list-hover-map-highlight.md) —
  *Proposed.* Hovering a file-list row highlights its tile on the map (if visible);
  the list → map mirror of the existing map → list hover. Client-only.
- [0013 — Fold small files into one tile](0013-fold-small-files.md) — *Proposed.*
  Fold children below a user-set size into one synthetic tile (a size-threshold
  sibling of the `omittedTail` count-cap tile). Fork: client px threshold vs. server
  byte threshold; leaning client-only first.
