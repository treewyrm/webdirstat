import type { StatementSync } from "node:sqlite";
import type { NodeKind, SearchResult, SearchSort } from "@webdirstat/shared";
import type { Store } from "./db.ts";

/**
 * The predicates a search runs, already normalized (ext lowercased, limit clamped).
 * Every field except `sort`/`limit` is optional and ANDed together; none present is
 * a valid "biggest files under this root" query.
 */
export interface SearchCriteria {
  minSize?: number;
  maxSize?: number;
  ext?: string;
  /** Match `mtime_ms < olderThan` (files not touched since this instant). */
  olderThan?: number;
  /** Match `mtime_ms >= newerThan`. */
  newerThan?: number;
  sort: SearchSort;
  limit: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Matches past the cap — an exact count, so the UI can say "+N more". */
  omittedCount: number;
}

/**
 * SQL `ORDER BY` per sort key. All keep `name` as a stable tiebreaker so equal-size /
 * equal-mtime pages are deterministic across requests. `size`/`mtime` descend
 * ("largest / newest first"); a direction toggle is a future UI concern.
 */
const ORDER_BY: Record<SearchSort, string> = {
  size: "size DESC, name ASC",
  mtime: "mtime_ms DESC, name ASC",
  name: "name ASC, size DESC",
};

/** A raw row from the match query — enough to build a {@link SearchResult}. */
interface MatchRow {
  id: number;
  name: string;
  size: number;
  mtime_ms: number | null;
}

/**
 * Whole-root file search over one pinned generation (feature 0004). Files only, since
 * that is what "what's eating my disk" means and what the size/age/ext predicates
 * target. Two stages so the result set stays bounded and paths stay durable:
 *
 * 1. Count + fetch in SQL — the predicates ride the generation-scoped indexes
 *    (`node_gen_root_size` for size/no-filter, `node_gen_root_ext` for ext,
 *    `node_gen_root_mtime` for age), ordered and capped at `limit`, so we never
 *    materialize a million matches. A separate `COUNT(*)` gives the exact overflow.
 * 2. Reconstruct each survivor's relative path by walking `parent_id` to the root —
 *    only for the ~`limit` returned rows, never the whole match set. `node` stores
 *    parent links, not paths; this is the reverse of {@link resolvePathToNode}.
 */
export function searchNodes(store: Store, rootId: string, generation: number, criteria: SearchCriteria): SearchOutcome {
  const where: string[] = ["generation = ?", "root_id = ?", "kind = 'file'"];
  const params: (number | string)[] = [generation, rootId];

  if (criteria.minSize != null) {
    where.push("size >= ?");
    params.push(criteria.minSize);
  }
  if (criteria.maxSize != null) {
    where.push("size <= ?");
    params.push(criteria.maxSize);
  }
  if (criteria.ext != null) {
    where.push("ext = ?");
    params.push(criteria.ext);
  }
  if (criteria.olderThan != null) {
    where.push("mtime_ms IS NOT NULL AND mtime_ms < ?");
    params.push(criteria.olderThan);
  }
  if (criteria.newerThan != null) {
    where.push("mtime_ms IS NOT NULL AND mtime_ms >= ?");
    params.push(criteria.newerThan);
  }
  const whereSql = where.join(" AND ");

  const total = (
    store.db.prepare(`SELECT COUNT(*) AS c FROM node WHERE ${whereSql}`).get(...params) as { c: number }
  ).c;

  const rows = store.db
    .prepare(`SELECT id, name, size, mtime_ms FROM node WHERE ${whereSql} ORDER BY ${ORDER_BY[criteria.sort]} LIMIT ?`)
    .all(...params, criteria.limit) as unknown as MatchRow[];

  const pathStmt = store.db.prepare("SELECT parent_id, name FROM node WHERE id = ?");
  const results: SearchResult[] = rows.map((r) => ({
    id: r.id,
    path: reconstructPath(pathStmt, r.id),
    name: r.name,
    kind: "file" as NodeKind,
    size: r.size,
    ...(r.mtime_ms != null ? { mtimeMs: r.mtime_ms } : {}),
  }));

  return { results, omittedCount: Math.max(0, total - results.length) };
}

/**
 * Builds a node's relative-from-root path by walking `parent_id` upward. The root
 * node (the only one with a null parent) contributes no segment — the path is
 * relative to it — so its name is dropped and the segments are reversed into
 * top-down order. `stmt` is prepared once by the caller and reused across the page.
 */
function reconstructPath(stmt: StatementSync, nodeId: number): string {
  const segments: string[] = [];
  let id: number | null = nodeId;
  while (id != null) {
    const row = stmt.get(id) as { parent_id: number | null; name: string } | undefined;
    if (!row) break;
    if (row.parent_id == null) break; // reached the root node; its name isn't part of the relative path
    segments.push(row.name);
    id = row.parent_id;
  }
  return segments.reverse().join("/");
}
