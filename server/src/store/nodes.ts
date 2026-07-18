import type { StatementSync } from "node:sqlite";
import type { NodeKind, TreeChild, TypeRollupEntry } from "@webdirstat/shared";
import type { Store } from "./db.ts";

/** A raw node row as stored. */
export interface NodeRow {
  id: number;
  generation: number;
  root_id: string;
  parent_id: number | null;
  name: string;
  kind: NodeKind;
  size: number;
  mtime_ms: number | null;
  child_count: number;
  ext: string | null;
  error: string | null;
}

/**
 * Prepared-statement writer for one scan into one staged generation. Holds the
 * statements so the hot insert path reuses them. Callers drive it from the walk:
 * insert a directory (pre-order) to get its id, insert leaves as they are seen,
 * then update the directory's aggregate size + child_count on exit.
 */
export class NodeWriter {
  private readonly insertStmt: StatementSync;
  private readonly updateDirStmt: StatementSync;

  constructor(
    private readonly store: Store,
    private readonly generation: number,
    private readonly rootId: string,
  ) {
    this.insertStmt = store.db.prepare(
      `INSERT INTO node (generation, root_id, parent_id, name, kind, size, mtime_ms, child_count, ext, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateDirStmt = store.db.prepare("UPDATE node SET size = ?, child_count = ?, error = ? WHERE id = ?");
  }

  private insert(
    parentId: number | null,
    name: string,
    kind: NodeKind,
    size: number,
    mtimeMs: number | null,
    childCount: number,
    ext: string | null,
    error: string | null,
  ): number {
    const { lastInsertRowid } = this.insertStmt.run(
      this.generation,
      this.rootId,
      parentId,
      name,
      kind,
      size,
      mtimeMs,
      childCount,
      ext,
      error,
    );
    return Number(lastInsertRowid);
  }

  /** Inserts a directory shell (aggregate filled in later via {@link updateDir}). Returns its id. */
  insertDir(parentId: number | null, name: string, mtimeMs: number | null, error: string | null): number {
    return this.insert(parentId, name, "directory", 0, mtimeMs, 0, null, error);
  }

  /** Inserts a leaf (file/symlink/other) whose size is already known. Returns its id. */
  insertLeaf(
    parentId: number,
    name: string,
    kind: Exclude<NodeKind, "directory">,
    size: number,
    mtimeMs: number | null,
    ext: string | null,
    error: string | null,
  ): number {
    return this.insert(parentId, name, kind, size, mtimeMs, 0, ext, error);
  }

  /** Fills in a directory's precomputed aggregate size, direct-child count, and read error. */
  updateDir(id: number, size: number, childCount: number, error: string | null): void {
    this.updateDirStmt.run(size, childCount, error, id);
  }
}

/** Writes the accumulated per-extension rollup for a generation. */
export function writeTypeRollup(
  store: Store,
  generation: number,
  rootId: string,
  rollup: Map<string, { bytes: number; count: number }>,
): void {
  const stmt = store.db.prepare(
    "INSERT INTO type_rollup (generation, root_id, ext, total_bytes, total_count) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [ext, { bytes, count }] of rollup) {
    stmt.run(generation, rootId, ext, bytes, count);
  }
}

/** Appends the tiny per-scan summary row. */
export function writeScanSummary(
  store: Store,
  summary: { generation: number; rootId: string; endedMs: number; totalBytes: number; totalCount: number; durationMs: number },
): void {
  store.db
    .prepare(
      "INSERT INTO scan_summary (generation, root_id, ended_ms, total_bytes, total_count, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(summary.generation, summary.rootId, summary.endedMs, summary.totalBytes, summary.totalCount, summary.durationMs);
}

export interface TypeRollup {
  types: TypeRollupEntry[];
  omittedTail?: { count: number; bytes: number };
}

/** A raw `{ext, total_bytes, total_count}` row from either rollup query. */
interface TypeRow {
  ext: string;
  total_bytes: number;
  total_count: number;
}

/**
 * Caps a fully-sorted list of per-extension rows at `limit`, summing what's left
 * off into the omitted tail. There is one row per extension either way (never per
 * file), so materializing all of them and slicing in JS is cheap regardless of how
 * many files the scan covered.
 */
function capTypes(sorted: TypeRow[], limit: number): TypeRollup {
  const shown = sorted.slice(0, limit);
  const types: TypeRollupEntry[] = shown.map((r) => ({ ext: r.ext, totalBytes: r.total_bytes, totalCount: r.total_count }));
  const result: TypeRollup = { types };
  const rest = sorted.slice(limit);
  if (rest.length > 0) {
    result.omittedTail = { count: rest.length, bytes: rest.reduce((sum, r) => sum + r.total_bytes, 0) };
  }
  return result;
}

/**
 * The whole-root per-extension rollup for a generation, largest first, capped at
 * `limit`. Read straight from the tiny `type_rollup` table the walk filled — one
 * row per extension, no re-aggregation over the tree.
 */
export function typeRollupOf(store: Store, rootId: string, generation: number, limit: number): TypeRollup {
  const rows = store.db
    .prepare(
      `SELECT ext, total_bytes, total_count
       FROM type_rollup WHERE generation = ? AND root_id = ? ORDER BY total_bytes DESC, ext ASC`,
    )
    .all(generation, rootId) as unknown as TypeRow[];
  return capTypes(rows, limit);
}

/**
 * The per-extension rollup for one subtree (files under `parentId`, recursively),
 * aggregated on demand — there is no precomputed per-directory table. The recursive
 * CTE walks parent_id links, which stay within the node's generation (ids are
 * generation-scoped), so no extra generation filter is needed. `COALESCE(ext,'')`
 * mirrors the walk's extension-less `""` bucket. Bounded by the subtree's size, so
 * the root case must go through {@link typeRollupOf} instead of aggregating the
 * whole tree here.
 */
export function subtreeTypeRollup(store: Store, parentId: number, limit: number): TypeRollup {
  const rows = store.db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM node WHERE parent_id = ?
         UNION ALL
         SELECT n.id FROM node n JOIN sub ON n.parent_id = sub.id
       )
       SELECT COALESCE(n.ext, '') AS ext, SUM(n.size) AS total_bytes, COUNT(*) AS total_count
       FROM node n JOIN sub ON n.id = sub.id
       WHERE n.kind = 'file'
       GROUP BY COALESCE(n.ext, '')
       ORDER BY total_bytes DESC, ext ASC`,
    )
    .all(parentId) as unknown as TypeRow[];
  return capTypes(rows, limit);
}

/** A node by id, scoped to a (root, generation) so a stale/foreign id resolves to nothing. */
export function getNodeById(store: Store, id: number, rootId: string, generation: number): NodeRow | undefined {
  return store.db
    .prepare("SELECT * FROM node WHERE id = ? AND root_id = ? AND generation = ?")
    .get(id, rootId, generation) as NodeRow | undefined;
}

/** The top node of a root's generation, or undefined if not staged/scanned. */
export function rootNodeRow(store: Store, rootId: string, generation: number): NodeRow | undefined {
  const gen = store.db
    .prepare("SELECT root_node_id FROM root_generation WHERE root_id = ? AND generation = ?")
    .get(rootId, generation) as { root_node_id: number | null } | undefined;
  if (!gen?.root_node_id) return undefined;
  return store.db.prepare("SELECT * FROM node WHERE id = ?").get(gen.root_node_id) as NodeRow | undefined;
}

/**
 * Resolves a client relative path to a stored node by walking name segments from
 * the generation's root node. Purely in-store — no filesystem access — so it can
 * only ever reach nodes actually under the root (symlinks are never stored, so
 * there is no traversal escape). `..`/absolute segments are refused defensively.
 */
export function resolvePathToNode(
  store: Store,
  rootId: string,
  generation: number,
  relPath: string,
): NodeRow | undefined {
  const root = rootNodeRow(store, rootId, generation);
  if (!root) return undefined;

  const segments = relPath.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) return undefined;

  const childByName = store.db.prepare("SELECT * FROM node WHERE parent_id = ? AND name = ?");
  let current = root;
  for (const segment of segments) {
    const next = childByName.get(current.id, segment) as NodeRow | undefined;
    if (!next) return undefined;
    current = next;
  }
  return current;
}

export interface Children {
  rows: TreeChild[];
  childCount: number;
  omittedTail?: { count: number; bytes: number };
  foldedSmall?: { count: number; bytes: number };
}

/**
 * A directory's direct children, largest first, capped at `limit`, with the omitted
 * tail summed. When `minSize > 0`, direct **files** below that byte threshold are
 * folded out of the rows into a separate `foldedSmall` aggregate (feature 0013,
 * Model A) — directories are never folded. The two buckets are disjoint by
 * construction: folded files are excluded from the candidate set before the `limit`
 * cap runs, so a file is never counted in both `foldedSmall` and `omittedTail`.
 * The `(parent_id, size DESC)` index serves both the row scan and the tail aggregate.
 */
export function childrenOf(store: Store, parentId: number, limit: number, minSize = 0): Children {
  const fold = minSize > 0 ? minSize : 0;

  // `fold = 0` disables the predicate (nothing is `size < 0`), so the query is a
  // no-op superset identical to the pre-0013 behavior.
  const rows = store.db
    .prepare(
      `SELECT id, name, kind, size, mtime_ms, child_count, ext, error
       FROM node WHERE parent_id = ? AND NOT (kind = 'file' AND size < ?)
       ORDER BY size DESC, name ASC LIMIT ?`,
    )
    .all(parentId, fold, limit) as Array<Omit<NodeRow, "generation" | "root_id" | "parent_id">>;

  const agg = store.db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b,
              COALESCE(SUM(CASE WHEN kind = 'file' AND size < ? THEN 1 ELSE 0 END), 0) AS fc,
              COALESCE(SUM(CASE WHEN kind = 'file' AND size < ? THEN size ELSE 0 END), 0) AS fb
       FROM node WHERE parent_id = ?`,
    )
    .get(fold, fold, parentId) as { c: number; b: number; fc: number; fb: number };

  const children: TreeChild[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    size: r.size,
    childCount: r.child_count,
    ...(r.mtime_ms != null ? { mtimeMs: r.mtime_ms } : {}),
    ...(r.ext != null ? { ext: r.ext } : {}),
    ...(r.error != null ? { error: r.error } : {}),
  }));

  // childCount stays the true direct-child total; the fold is a rendering split.
  const result: Children = { rows: children, childCount: agg.c };

  // The candidate set the cap runs over excludes the folded files.
  const shownBytes = children.reduce((sum, c) => sum + c.size, 0);
  const nonFoldedCount = agg.c - agg.fc;
  const nonFoldedBytes = agg.b - agg.fb;
  const omittedCount = nonFoldedCount - children.length;
  if (omittedCount > 0) result.omittedTail = { count: omittedCount, bytes: nonFoldedBytes - shownBytes };
  if (agg.fc > 0) result.foldedSmall = { count: agg.fc, bytes: agg.fb };
  return result;
}
