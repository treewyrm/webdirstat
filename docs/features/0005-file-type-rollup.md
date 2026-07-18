# 0005 — File-type (extension) rollup

Status: **Done** — raw rollup + "By type" panel shipped, both whole-root and
subtree-scoped (the panel tracks the focused folder), with a Raw/Grouped toggle
that folds extensions into families. Follow-up: make the family map
user-customizable and persisted (folds into feature 0007).

Prerequisite: [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md).
Shares the scan-time **`ext`** column with
[feature 0004 — search & filter](0004-search-and-filter.md); the accumulation is
called out in 0002's schema section.

## Goal

The signature WinDirStat view: **"you have 41 GB of `.mov`, 12 GB of `.zip`, 8 GB
of `.iso`."** A per-root breakdown of space by file type, answering "what *kind*
of thing is filling this disk" independent of *where* it lives in the tree.

The client already colors treemap tiles by extension
([color.ts](../../client/src/utils/color.ts)), so users are primed to think in
types — but there is no aggregate; this adds the number behind the color.

## Why the store makes this nearly free

The walk makes exactly one recursive pass (it has to, for bottom-up sizes). That
same pass can accumulate `ext → {bytes, count}` with no extra I/O — a small table
written at scan time, read back instantly. No re-walk, no client-side aggregation
over a giant tree.

## Shape of the change

### Schema (decide-now, in 0002)

```
type_rollup(generation, root_id, ext, total_bytes, total_count)
index (root_id, total_bytes DESC)
```

Filled during the walk (per generation, so it swaps atomically with the tree and
composes with [history](0003-history-and-diff.md): type breakdown over time).

### API

```
GET /api/roots/:id/types?limit&generation
→ { generation, types: [ {ext, totalBytes, totalCount}, … ], omittedTail }
```

Capped + generation-pinned like the tree reads.

### UI

- A "by type" panel: sorted bars / list of extensions by total size.
- Cross-link to [search](0004-search-and-filter.md): clicking `.mov` runs
  `GET /api/search?ext=mov` to itemize and locate them.

## Open questions

- **Bucketing.** ~~Group known families vs. raw extensions?~~ **Resolved:** raw by
  default with an optional Grouped toggle; grouping is a client-side fold over the
  rollup ([families.ts](../../client/src/utils/families.ts) → `groupByFamily`). Known
  extensions collapse into families (`.mov/.mp4/.mkv` → "Video"), unknown ones pass
  through as their own row so nothing is hidden. **Remaining:** the family map is a
  hardcoded default today; making it user-editable and persisted (localStorage) is a
  follow-up that folds into the display-settings pane (feature 0007) — see the TODO
  in `families.ts`.
- **Extension-less / special nodes.** Directories, symlinks, dotfiles with no
  extension, `.tar.gz` double extensions — define the split rule once (shared with
  0004 so search and rollup agree).
- **Scope.** ~~Per-root only, or also "types within the current subtree"?~~
  **Resolved:** both. Whole-root ("" path) is served from the precomputed
  `type_rollup` table; a subpath is aggregated on demand with a recursive CTE over
  just that subtree (`subtreeTypeRollup`), and the panel tracks the focused folder.
  Per-directory precomputation was not needed — the on-demand query is bounded by
  the subtree, and the expensive whole-tree case stays on the precomputed table.

## Recommendation

Accumulate the **per-root `type_rollup` in 0002's walk from the first cut** (one
pass, tiny table), expose `GET /api/roots/:id/types`, and add a "by type" panel.
Grouping into families and subtree-scoped rollups are follow-ups.

## Decision

Adopted the recommendation. The walk fills `type_rollup` in its single pass
([persist.ts](../../server/src/scan/persist.ts)); reads go through
`GET /api/roots/:id/types` ([types.ts](../../server/src/routes/types.ts) →
`typeRollupOf`/`subtreeTypeRollup` in [nodes.ts](../../server/src/store/nodes.ts)),
generation-pinned and capped like the tree reads. The route's `path` param scopes it:
"" reads the precomputed table, a subpath aggregates that subtree on demand. The
client shows the "By type" panel as the **Types** tab of the left side shell
([TypeList.vue](../../client/src/components/TypeList.vue)) that tracks the focused
folder (debounced) and whose swatches reuse the treemap's extension coloring
(`colorForExt`, [color.ts](../../client/src/utils/color.ts)). Extension-less files
land in the `""` bucket, shown as "(no extension)". A Raw/Grouped toggle folds
extensions into families client-side
([families.ts](../../client/src/utils/families.ts)); the family map is a hardcoded
default, with making it user-editable + persisted deferred to feature 0007.
