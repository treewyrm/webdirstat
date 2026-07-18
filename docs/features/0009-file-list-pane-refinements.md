# 0009 — File-list pane refinements (kind icon + name truncation)

Status: **Done**

Implemented in [App.vue](../../client/src/App.vue): each `.list-row` now leads with a
[Lucide](https://lucide.dev) (`@lucide/vue`) glyph chosen by `child.kind`
(`Folder` / `Link2` / `File`), directory glyphs brightened via `.list-row.dir .icon`;
the row is a `grid-template-columns: auto 1fr auto` with the name column truncating
(`text-overflow: ellipsis`, `min-width: 0`, `title` for the full name) and the size
column pinned right with `tabular-nums`. Verified end-to-end against a mixed fixture
(dirs, files, a long filename, a symlink) — all four kinds render distinct icons and
the long name ellipsizes while sizes stay column-aligned.

Two small readability items in the left **list pane** raised during first hands-on
testing of the pan/zoom treemap ([feature 0002](0002-pan-zoom-treemap.md)). Both
are client-only, both live in the same `.list-row` markup in
[App.vue](../../client/src/App.vue) (rows rendered around
[App.vue:186-197](../../client/src/App.vue#L186-L197), styled around
[App.vue:314-345](../../client/src/App.vue#L314-L345)).

## 1. Distinguish directories from files

**Today** a directory row and a file row look identical — both are just
`name` + `size` with a percentage bar behind them. The only differences are subtle:
directories get `cursor: pointer` (`.list-row.dir`) and a different accent, but
nothing tells you at a glance which rows you can descend into.

`child.kind` is already on every row (`"directory" | "file" | "symlink" | …`; it's
what gates `flyToChild` and the `.dir` class), so the data is present — this is a
template + CSS change, not a data change.

**Change:** prefix each row with a small **kind glyph** — a folder mark for
directories, a file/document mark for files, a link mark for symlinks, and the error
tone already applied via `.list-row.error`.

Use **[Lucide](https://lucide.dev)** (`lucide-vue-next`) for the glyphs — SVG
components colored via `currentColor`, so they track the row's text color and the
error/`.dir` accents, and unused icons never ship. Map `child.kind` to an icon:
`Folder` (directory), `File` (file), `Link` / `Link2` (symlink), with the error tone
handled by the existing `.list-row.error` color rather than a separate icon. Keep it
aligned in a fixed-width leading column so names still line up (this dovetails with
item 2's grid).

This is webdirstat's **first icon dependency** — Lucide is the chosen library; if
icons from other families are ever needed, graduate to Iconify's `unplugin-icons`
without changing the inline-SVG rendering model.

## 2. Long names shouldn't push the size column away

**Today** `.list-row` is a `display: flex; justify-content: space-between` with the
`.name` and `.size` spans free to size themselves. A long filename grows the name
span and shoves `size` off toward (or past) the right edge, so the numbers no longer
line up and can clip.

**Change:** let the name column take the remaining width and **truncate with an
ellipsis**, keeping `size` pinned right. Because `text-overflow: ellipsis` needs a
block-ish box with a bounded width, the clean fix is to move the row from bare flex
to a small grid (or give `.name` `flex: 1; min-width: 0`):

```css
.list-row {
  display: grid;
  grid-template-columns: auto 1fr auto; /* icon · name · size */
  gap: 0.4rem;
  align-items: center;
}
.list-row .name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0; /* let the ellipsis actually kick in inside the grid track */
}
.list-row .size {
  font-variant-numeric: tabular-nums; /* numbers stay aligned across rows */
  white-space: nowrap;
}
```

Note the existing `.name`/`.size` already carry `position: relative; z-index: 1` so
they render above the percentage `.bar` — keep that. The full name stays available
on hover via a `title={{ child.name }}` attribute (and the tooltip/hover-path work in
[feature 0008](0008-treemap-interaction-refinements.md)).

## Shape of the change

- [App.vue](../../client/src/App.vue): add a leading `.icon` element to `.list-row`
  chosen by `child.kind`; add `title` to the name span.
- Row CSS: flex → `grid-template-columns: auto 1fr auto`; add the ellipsis rules to
  `.name` and tabular numerals to `.size`.

## Open questions

- **Breadcrumb overflow.** The breadcrumb nav already scrolls
  (`.breadcrumbs { overflow-x: auto }`); no change needed, but worth confirming long
  root labels still read.
- **Symlink / other kinds.** ~~Give each its own glyph, or fold non-directory kinds
  into one "file" mark?~~ **Resolved:** distinct folder / link / file glyphs, `"other"`
  folds into the file glyph, error tone via the existing `.list-row.error` color.

## Recommendation

Ship both together — same rows, same commit. Grid + ellipsis is the higher-value,
zero-risk half; the kind icon is a small readability win that also gives the grid its
leading column.

## Decision

**Both shipped together** with **Lucide** (`@lucide/vue`) as the icon library — the
project's first icon dependency. Implemented and verified; see the status note at the
top.
