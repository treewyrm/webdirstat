# Feature plans

Write-ups for planned features, one file per feature, numbered (`0001-...`). Same
status convention as [issues](../issues/): Proposed → Decided → In progress → Done.

A feature doc should cover: what it does from the user's perspective, the rough
shape of the change (which files/layers it touches), and open questions — not a
full implementation plan.

Filed:

- [0001 — Password protection](0001-password-protection.md) — *Proposed.*
  Independent of the scaling rework below.
- [0002 — Pan/zoom treemap](0002-pan-zoom-treemap.md) — *Decided.* Map-style
  navigation; built on the slice store from
  [issue 0002](../issues/0002-background-scanning-service.md).
- [0003 — History & diff](0003-history-and-diff.md) — *Proposed.*
- [0004 — Search & filter](0004-search-and-filter.md) — *Proposed.*
- [0005 — File-type rollup](0005-file-type-rollup.md) — *Proposed.*
- [0006 — Export paths](0006-export-paths.md) — *Proposed.*
- [0007 — Display settings pane](0007-display-settings-pane.md) — *Proposed.*
  Client-local (`localStorage`) display preferences in a schedule-editor-style pane.
- [0008 — Treemap interaction refinements](0008-treemap-interaction-refinements.md) —
  *Proposed.* Full-path hover + deliberate descend-into-folder; from first testing.
