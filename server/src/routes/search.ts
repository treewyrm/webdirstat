import { defineHandler, getValidatedQuery } from "h3";
import { z } from "zod";
import type { SearchResponse } from "@webdirstat/shared";
import { searchNodes, type SearchCriteria } from "../store/search.ts";
import { resolvePathToNode } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { pinGeneration } from "./generation.ts";
import type { RouteFactory } from "./context.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * Query contract. Everything arrives as strings; numeric predicates coerce and drop
 * when absent/garbage (`.optional()` + no `.catch` default means an unparseable value
 * becomes `undefined` → the predicate is simply omitted). `sort` falls back to size.
 */
const SearchQuery = z.object({
  root: z.string().min(1),
  scope: z.enum(["root", "here"]).catch("root").default("root"),
  path: z.string().default(""),
  minSize: z.coerce.number().optional(),
  maxSize: z.coerce.number().optional(),
  ext: z.string().optional(),
  olderThan: z.coerce.number().optional(),
  newerThan: z.coerce.number().optional(),
  nameLike: z.string().optional(),
  sort: z.enum(["size", "mtime", "name"]).catch("size").default("size"),
  limit: z.coerce.number().catch(DEFAULT_LIMIT).default(DEFAULT_LIMIT),
  generation: z.string().optional(),
});

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** A non-negative finite byte/time bound, or undefined to drop the predicate. */
function bound(n: number | undefined): number | undefined {
  if (n == null || !Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/** Normalizes an extension to the stored form: lowercased, leading dots stripped. */
function normalizeExt(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const ext = raw.replace(/^\.+/, "").toLowerCase().trim();
  return ext.length > 0 ? ext : undefined;
}

/**
 * Structured file search over one root (feature 0004): "files larger than N",
 * "all .iso, biggest first", "nothing touched in 2 years", filename substring.
 * Generation-pinned like every read (explicit while retained, else current live;
 * pruned → 410, unscanned → 404) and capped (`limit` + `omittedCount`) so a query
 * can't serialize a million matches. `scope=here` restricts to the subtree at
 * `path`; a `path` that doesn't resolve to a directory yields empty results (never
 * an error), so navigation never faults it — mirroring the types route.
 */
export const registerSearchRoute: RouteFactory = ({ app, config, store }) => {
  app.get(
    "/api/search",
    defineHandler(async (event): Promise<SearchResponse> => {
      const query = await getValidatedQuery(event, SearchQuery);

      const root = findRoot(config.roots, query.root);
      const generation = pinGeneration(store, root.id, query.generation);

      // Subtree scope: resolve the anchor. A non-empty path that isn't a live
      // directory (stale during a swap, or a file) → empty, not an error.
      let subtreeOf: number | undefined;
      if (query.scope === "here" && query.path !== "") {
        const anchor = resolvePathToNode(store, root.id, generation, query.path);
        if (!anchor || anchor.kind !== "directory") {
          return { generation, root: root.id, results: [], omittedCount: 0 };
        }
        subtreeOf = anchor.id;
      }

      const criteria: SearchCriteria = { sort: query.sort, limit: clampLimit(query.limit) };
      const minSize = bound(query.minSize);
      const maxSize = bound(query.maxSize);
      const olderThan = bound(query.olderThan);
      const newerThan = bound(query.newerThan);
      const ext = normalizeExt(query.ext);
      const nameLike = query.nameLike?.trim();
      if (minSize != null) criteria.minSize = minSize;
      if (maxSize != null) criteria.maxSize = maxSize;
      if (ext != null) criteria.ext = ext;
      if (olderThan != null) criteria.olderThan = olderThan;
      if (newerThan != null) criteria.newerThan = newerThan;
      if (nameLike) criteria.nameLike = nameLike;
      if (subtreeOf != null) criteria.subtreeOf = subtreeOf;

      const { results, omittedCount } = searchNodes(store, root.id, generation, criteria);
      return { generation, root: root.id, results, omittedCount };
    }),
  );
};
