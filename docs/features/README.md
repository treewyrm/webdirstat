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
- [0004 — Search & filter](0004-search-and-filter.md) — *Done.* Structured search
  (fts trigram name substring + size/ext/age filters, whole-root or subtree) over the
  flat `node` table; the Search tab of the left shell, results reveal-in-map.
- [0005 — File-type rollup](0005-file-type-rollup.md) — *Done.* `GET /api/roots/:id/types`
  over the walk-filled `type_rollup` table (whole-root) or an on-demand subtree
  aggregate (`?path=`) + a "By type" panel that tracks the focused folder with a
  Raw/Grouped family toggle; user-editable families deferred to 0007.
- [0006 — Export paths](0006-export-paths.md) — *Proposed.*
- [0007 — Display settings pane](0007-display-settings-pane.md) — *Done.* Shipped
  as the ⚙ Settings modal with **Display** (client-local `localStorage` prefs) and
  **Scanning** (the migrated `ScheduleEditor`) categories; the Schedule ghost button
  is retired.
- [0008 — Treemap interaction refinements](0008-treemap-interaction-refinements.md) —
  *Proposed.* Full-path hover + deliberate descend-into-folder; from first testing.
- [0009 — File-list pane refinements](0009-file-list-pane-refinements.md) — *Done.*
  Kind icons (first Lucide dependency) + name truncation in the list pane.
- [0010 — Shaded (cushion) treemap tiles](0010-shaded-treemap-tiles.md) —
  *Done.* Cushion shading for depth cues on the treemap; a Display toggle.
- [0011 — Color tiles by age](0011-color-by-age.md) — *Done.* Optional
  mtime-based tile coloring (old→dark, new→bright); client-only, a Display toggle.
- [0012 — Highlight map tile on list hover](0012-list-hover-map-highlight.md) —
  *Done.* Hovering a file-list row highlights its tile on the map (if visible);
  the list → map mirror of the existing map → list hover. Client-only.
- [0013 — Fold small files into one tile](0013-fold-small-files.md) — *Done.*
  Model A (server-side byte threshold): children below a user-set size fold into one
  synthetic tile, a size-threshold sibling of the `omittedTail` count-cap tile.
- [0014 — Docker Hub & Unraid distribution](0014-docker-hub-unraid-distribution.md) —
  *Proposed.* Publish the image to Docker Hub + an Unraid Community Applications
  template for local-NAS install.
- [0015 — Cap file-list rows](0015-cap-file-list-rows.md) — *Proposed.* Bound the
  Files pane's row count for very wide directories.
