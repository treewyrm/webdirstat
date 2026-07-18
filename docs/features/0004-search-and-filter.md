# 0004 — Search & filter

Status: **Decided** — schema decide-now half already shipped in 0002's first cut
(`ext` column, `node_gen_root_mtime`, `node_gen_root_ext`). This note fleshes out
the remaining additive work into a concrete implementation design. Not yet started.

Prerequisite: [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md).
Shares the scan-time **`ext`** column with
[feature 0005 — type rollup](0005-file-type-rollup.md) (Done).

## Goal

Let the user **find** space offenders directly, not only by drilling the treemap:

- "Every file larger than 1 GB, anywhere under this root."
- "All `.iso` / `.mov` / `.zip` files, biggest first."
- "Nothing touched in 2 years and over 100 MB" — the classic archive/delete
  candidate query.
- "Every file whose name contains `backup`" — filename substring search.

This is often what "what's eating my disk?" actually means, and it's a capability
the old whole-tree-in-browser model simply couldn't offer without shipping the
entire tree to the client first.

## Why the store makes this nearly free

0002's flat `node` table turns each predicate into **one indexed query** over
already-scanned data — no re-walk, no giant transfer. The scan already writes the
columns and indexes these predicates need.

## Scope decision (v1)

Full structured search **including filename substring (FTS)**, whole-root and
subtree-scoped, with a size index added so the pure-size case is index-backed too.
Decided 2026-07-18.

## Shape of the change

### Schema — one new migration (append-only)

- **`node_gen_root_size` index** `(generation, root_id, kind, size DESC)` — the
  headline "files > N bytes anywhere under this root, biggest first" query has no
  supporting index today (`node_parent_size` is keyed on `parent_id`, not root; the
  gen/root indexes aren't size-sorted), so it would scan the whole generation. This
  index makes it a range scan. Append as migration `1 → 2`; bump `SCHEMA_VERSION`.
- **`node_fts` fts5 virtual table** for filename substring search:

  ```sql
  CREATE VIRTUAL TABLE node_fts USING fts5(
    name,
    node_id     UNINDEXED,
    generation  UNINDEXED,
    root_id     UNINDEXED,
    tokenize = 'trigram'          -- substring MATCH, not just prefix/token
  );
  ```

  Trigram tokenizer gives true substring matching (`node_fts MATCH 'backup'`
  matches `mybackup.tar`), which prefix fts5 cannot. It is a standalone (not
  external-content) table so generation pruning is a plain `DELETE … WHERE
  generation IN (…)` and doesn't have to stay in lockstep with `node` triggers.

### Scan-time population

Populate `node_fts` in the walk's **`leaf` sink** alongside the existing
`type_rollup` accumulation ([persist.ts](../../server/src/scan/persist.ts#L61)) —
insert `(name, node_id, generation, root_id)` for `kind === 'file'`. Add the row
via a prepared statement on `NodeWriter` so the hot path reuses it, and gate the
insert on the same `COMMIT_EVERY` transaction batching. On **prune**, delete the
retired generations' fts rows in [generations.ts](../../server/src/store/generations.ts)
`prune()`, and on the abort path (`dropGeneration`) delete the staged generation's
fts rows too, so a failed scan leaves no orphan index rows.

### Server query — `server/src/store/search.ts`

Two-stage, to keep results bounded and paths durable:

1. **Match + cap in SQL.** Build the WHERE clause from the optional predicates,
   always `generation + root_id` scoped and `kind = 'file'`, `ORDER BY size DESC`
   (default; also mtime/name), `LIMIT`. `nameLike` joins/filters via `node_fts
   MATCH`; the structured filters ride the `node_gen_root_size` /
   `node_gen_root_mtime` / `node_gen_root_ext` indexes. Subtree scope ("search
   here") prepends a recursive CTE from a `parentId` (same shape as
   `subtreeTypeRollup`) that restricts the candidate id set before filtering.
2. **Reconstruct `path` for the capped survivors only.** The `node` table stores
   `parent_id`, not path — so walk `parent_id` up to the root for each of the ~200
   returned ids (JS loop over a prepared `SELECT parent_id, name WHERE id = ?`, the
   reverse of `resolvePathToNode`). Cheap because it runs only on the capped set,
   never the match set.

Return `{ generation, results: [{id, path, name, kind, size, mtimeMs}], omittedCount }`
in the `capTypes`/`childrenOf` style (cap + omitted aggregate).

### Server route — `server/src/routes/search.ts`

`GET /api/search?root&scope&path&minSize&maxSize&ext&olderThan&newerThan&nameLike&sort&limit&generation`

Same skeleton as [tree.ts](../../server/src/routes/tree.ts): zod-validated query,
`findRoot`, `pinGeneration`, clamp `limit` against a `MAX_LIMIT`. **Generation-pinned**
(410 → client re-seeds from its path anchor) and **capped** like every other read.
`scope=here` + `path` resolves an anchor via `resolvePathToNode`; `scope=root` (default)
ignores `path`.

### shared/src/types.ts

Add `SearchQuery`, `SearchResult`, `SearchResponse`. Protocol contract — both sides
move together.

### Client

- **Filters panel + results list** alongside the existing list pane in
  [App.vue](../../client/src/App.vue). Structured inputs (size min/max, extension,
  age, name-contains) + a here/everywhere toggle — **not** a raw query language
  (over-scope, per the original note). Size-desc default sort; mtime/name/path as
  options.
- **Reveal-in-map** reuses `flyToPath`, but with a seeding step: today
  [flyToPath](../../client/src/components/MapTreemap.vue#L622) walks the in-memory
  `worldRoot` and `break`s when a segment isn't laid out — a deep result won't be.
  So first issue a `POST /api/tree/batch` with a **`path` anchor + `depth`** to seed
  the spine down to the result, then fly. The batch API already supports path
  anchors ([batch.ts](../../server/src/routes/batch.ts)); this is the one client
  piece that isn't free. Results carry `path`, so they also feed
  [feature 0006 — export/copy paths](0006-export-paths.md) directly.

## Suggested phasing

1. **Done.** Migration (`node_gen_root_size` + `node_fts`) + scan-time fts
   population + prune hook. Verified a rescan populates and a prune cleans up.
2. **Done.** `searchNodes()` + `GET /api/search` (whole-root, structured
   filters: size/ext/age, sort size|mtime|name, path reconstruction, exact
   `omittedCount`). Curl-verified against a fixture, incl. 410/404 guards.
3. `nameLike` (fts trigram MATCH) and subtree `scope=here`. The `SearchParams`
   contract already reserves `nameLike`; add `scope`/`path` alongside it.
4. Client filters panel + results list + reveal-in-map spine-seed.

## Open questions (resolved)

- **Scope:** whole-root and subtree, via a toggle. ✓
- **Sort:** size-desc default; mtime, name, path also. ✓
- **Result → map linkage:** fly-to via the result's path, seeding the spine first. ✓
- **Filtering UI vs. query box:** structured filters, no query language. ✓
- **FTS:** in v1, trigram tokenizer for substring names. ✓

## Decision

Decided 2026-07-18: full structured search incl. FTS filename substring, whole-root
+ subtree, with the `node_gen_root_size` index migration. Implement in the phases
above.
