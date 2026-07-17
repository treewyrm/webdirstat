# 0004 — Search & filter

Status: **Proposed**

Prerequisite: [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md).
The *decide-now* half (carry the columns/indexes a search needs) is called out in
0002's schema section.

## Goal

Let the user **find** space offenders directly, not only by drilling the treemap:

- "Every file larger than 1 GB, anywhere under this root."
- "All `.iso` / `.mov` / `.zip` files, biggest first."
- "Nothing touched in 2 years and over 100 MB" — the classic archive/delete
  candidate query.

This is often what "what's eating my disk?" actually means, and it's a capability
the old whole-tree-in-browser model simply couldn't offer without shipping the
entire tree to the client first.

## Why the store makes this nearly free

0002's flat `node` table in SQLite turns each of the above into **one indexed
query** over already-scanned data — no re-walk, no giant transfer. The only
requirement is that the scan wrote the columns and indexes these predicates need,
which is why it's flagged as a schema decision in 0002 rather than a pure add-on.

## Shape of the change

### Schema (the decide-now part, in 0002)

- **`ext`** column — the file extension, split once at scan time (cheaper and more
  consistent than `LIKE '%.iso'` scans; also shared with
  [feature 0005 — type rollup](0005-file-type-rollup.md)).
- Index on **`mtime_ms`** for age predicates.
- `size` is already indexed for the tree view; size filters ride that.
- Optional **FTS** (SQLite `fts5`) on `name` if substring/filename search is
  wanted; skip if prefix/extension filtering is enough for v1.

### API

```
GET /api/search?root&minSize&maxSize&ext&olderThan&newerThan&nameLike&limit&generation
→ { generation, results: [ {id, path, name, kind, size, mtimeMs}, … ], omittedCount }
```

- **Generation-pinned** like every other read (0002), and **capped** (`limit` +
  `omittedCount`) so a query can't ask the server to serialize a million matches.
- Results carry `path` (durable) so they feed straight into
  [feature 0006 — export/copy paths](0006-export-paths.md) and into treemap
  "reveal in map" (fly the camera to a result).

## Open questions

- **Scope of search:** whole root vs. current subtree. Probably a toggle
  ("search here" vs. "search everything").
- **Sort options:** size-desc default; also mtime, name, path.
- **Result → map linkage.** Clicking a result should "reveal" it in the pan/zoom
  treemap ([feature 0002](0002-pan-zoom-treemap.md)) — a fly-to using the result's
  path, which the batch API's path-anchored request already supports.
- **How much filtering UI** vs. a query box. Start with a few structured filters
  (size, ext, age); a raw query language is over-scope.

## Recommendation

Land the **schema bits (`ext` column, `mtime_ms` index) inside 0002's first cut**
so no re-walk is needed later, then build the `GET /api/search` endpoint + a
filters panel as a follow-up. FTS on names is optional and can come last.

## Decision

Not yet decided — pending discussion. (The column/index choices should be settled
before 0002's schema is frozen.)
