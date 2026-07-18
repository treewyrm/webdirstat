# 0005 — File-type (extension) rollup

Status: **Done** — raw per-root rollup + "By type" panel shipped. Grouping into
families and subtree-scoped rollups remain follow-ups (see Open questions).

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

- **Bucketing.** Group known families (`.mov/.mp4/.mkv` → "Video",
  `.jpg/.png/...` → "Images") vs. raw extensions? Probably show raw with an
  optional grouped view; grouping is a client-side map over the rollup.
- **Extension-less / special nodes.** Directories, symlinks, dotfiles with no
  extension, `.tar.gz` double extensions — define the split rule once (shared with
  0004 so search and rollup agree).
- **Scope.** Per-root only, or also "types within the current subtree"? Whole-root
  is the cheap precomputed case; subtree rollups would need either an on-demand
  aggregate query or per-directory precomputation (heavier).

## Recommendation

Accumulate the **per-root `type_rollup` in 0002's walk from the first cut** (one
pass, tiny table), expose `GET /api/roots/:id/types`, and add a "by type" panel.
Grouping into families and subtree-scoped rollups are follow-ups.

## Decision

Adopted the recommendation. The walk fills `type_rollup` in its single pass
([persist.ts](../../server/src/scan/persist.ts)); reads go through
`GET /api/roots/:id/types` ([types.ts](../../server/src/routes/types.ts) →
`typeRollupOf` in [nodes.ts](../../server/src/store/nodes.ts)), generation-pinned and
capped like the tree reads. The client shows a toggled "By type" panel
([TypeList.vue](../../client/src/components/TypeList.vue)) whose swatches reuse the
treemap's extension coloring (`colorForExt`,
[color.ts](../../client/src/utils/color.ts)). Extension-less files land in the `""`
bucket, shown as "(no extension)". Family grouping and subtree-scoped rollups are
deferred.
