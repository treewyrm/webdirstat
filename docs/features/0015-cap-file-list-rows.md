# 0015 — Cap the number of file-list rows

Status: **Done**

The left **file-list pane** renders every child of the focused directory. It's sorted
largest-first, so for a very wide directory (many thousands of children) only the top
entries carry any signal, yet the pane builds a DOM row for each one. Cap the visible
rows at a sensible N and fold the remainder into a single **"… X more"** summary row —
the list analog of the map's `omittedTail` remainder tile.

Split out of feature [0012](0012-list-hover-map-highlight.md) (the list → map hover
highlight), which noted it as orthogonal: every extra row is also an extra hover target
that highlight feature has to reason about, so a bounded list keeps that set small too.
Client-only; no protocol or server change.

## Today

- [MapTreemap.vue](../../client/src/components/MapTreemap.vue) `emitFocus` builds the
  focus children from `focusNode.children`, **filtering out the synthetic `tail`
  node**, and emits them to [App.vue](../../client/src/App.vue) as `focusChildren`.
- Those children are already bounded by what the map fetched for that level
  (`BATCH_LIMIT = 200`, or the root `tree` slice cap), so the list is not unbounded in
  the pathological sense — but 200 rows is still a large DOM list where only the top
  dozen matter, and the omitted-tail count past the fetch cap is **dropped entirely**
  from the list (it's filtered out), so the pane silently under-reports.
- [FileList.vue](../../client/src/components/FileList.vue) `v-for`s over every child it
  receives and shows an `Empty directory` line only when there are none.

## Change

- **FileList.vue**: render at most `N` rows (`children.slice(0, N)`); when there are
  more, append one non-interactive summary row — **"… X more (Y)"** where `X` is the
  hidden count and `Y` the formatted summed size of the hidden rows. It carries no
  `id`, is not a hover/fly target, and visually echoes the map's tail tile (muted,
  dashed) so the two remainders read as the same concept.
- Decide where the hidden **count + bytes** come from:
  - If the cap `N` is **≥** the map's fetch cap, the only remainder is the existing
    `omittedTail`, which `emitFocus` currently discards — so the real fix is to **plumb
    the focus node's `omittedTail`** (count + bytes) through the `@focus` payload to the
    list, rather than recomputing. Cleanest, and it also stops the silent under-report.
  - If `N` is **<** the fetch cap, the list additionally hides `children.length − N`
    fetched rows; sum those locally and add them to any `omittedTail`.
- Keep the pane sorted largest-first (already is), so the cut is always "the smallest
  tail", matching the bar visualization.

## Open questions

- **What is N?** Match the map/`batch` child cap (~200) for a pure DOM-cost win with no
  behavioral change to what's shown, or pick a smaller human-scale number (e.g. 50) so
  the pane is a genuine "top files" list. Prefer the smaller number — the list is a
  reading surface, not the map — but that makes the `omittedTail` plumbing above
  mandatory, not optional.
- **Interaction on the summary row.** Inert label only (proposed), or clicking it
  reveals more / raises the cap? Inert for a first cut.
- **Does the map already answer this?** The remainder is visible on the map as the tail
  tile; the list row is mostly there so the pane doesn't lie about the total. Worth a
  sanity check that the summed size in the list reconciles with `focusSize`.

## Shape of the change

- `MapTreemap.vue`: include the focus node's `omittedTail` in the `@focus` payload.
- `App.vue`: carry it alongside `focusChildren` and pass it to `FileList`.
- `FileList.vue`: `N` cap + a single muted "… X more" summary row; sum any locally
  hidden rows into the omitted-tail count/bytes.

## Decision

Implemented as the "Shape of the change" section describes:

- **N = 50** (`ROW_CAP` in `FileList.vue`) — the smaller, human-scale "top files" number,
  making the `omittedTail` plumbing mandatory (below), not the 200 DOM-cost-only variant.
- **`omittedTail` plumbed** from the focus node through the `@focus` payload
  (`MapTreemap.vue` → `App.vue` → `FileList.vue`), fixing the prior silent under-report.
- **Single inert summary row** — `FileList.vue` folds the locally hidden rows
  (`children.slice(50)`) plus any `omittedTail` into one muted, dashed **"… X more (Y)"**
  row. It carries no `id`, is not a hover/fly target. Inert for this first cut (no
  reveal-more / raise-cap interaction).
