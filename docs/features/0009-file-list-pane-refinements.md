# 0009 — File-list pane refinements (kind icon + name truncation)

Status: **Done**

Two readability items in the left **list pane**, raised during first hands-on
testing of the pan/zoom treemap ([feature 0002](0002-pan-zoom-treemap.md)), both
client-only in [App.vue](../../client/src/App.vue).

## What shipped

- **Kind icon.** Each `.list-row` leads with a [Lucide](https://lucide.dev)
  (`@lucide/vue`) glyph chosen by `child.kind` — `Folder` / `Link2` / `File`
  (`"other"` folds into the file glyph, error tone via the existing
  `.list-row.error` color). Directory glyphs are brightened via `.list-row.dir
  .icon`. Glyphs are SVG components colored by `currentColor`, so they track the
  row's text/accent colors and unused icons never ship. This is webdirstat's
  **first icon dependency** — if other families are ever needed, graduate to
  Iconify's `unplugin-icons` without changing the inline-SVG model.
- **Name truncation.** The row moved from bare flex to
  `grid-template-columns: auto 1fr auto` (icon · name · size). The name column
  truncates (`overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  min-width: 0`, full name kept in a `title`); the size column is pinned right
  with `tabular-nums` so numbers stay aligned across rows. A long filename no
  longer shoves the size column off the edge.

Verified end-to-end against a mixed fixture (dirs, files, a long filename, a
symlink): all four kinds render distinct icons, the long name ellipsizes, sizes
stay column-aligned.
