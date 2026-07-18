import { defineHandler, getValidatedQuery, HTTPError } from "h3";
import { z } from "zod";
import type { TreeSlice } from "@webdirstat/shared";
import { childrenOf, resolvePathToNode } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { pinGeneration } from "./generation.ts";
import type { RouteFactory } from "./context.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

/**
 * Query contract. Params arrive as strings, so `limit` is coerced (and defaulted
 * when absent/garbage); `generation` is passed through to {@link pinGeneration}.
 */
const TreeQuery = z.object({
  root: z.string().min(1),
  path: z.string().default(""),
  limit: z.coerce.number().catch(DEFAULT_LIMIT).default(DEFAULT_LIMIT),
  generation: z.string().optional(),
});

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * One directory level, size-sorted and capped — the entry point into the tree.
 * `path` addresses durably (root + relative path); the returned children carry
 * generation-scoped `id`s for id-addressed navigation thereafter.
 */
export const registerTreeRoute: RouteFactory = ({ app, config, store }) => {
  app.get(
    "/api/tree",
    defineHandler(async (event): Promise<TreeSlice> => {
      const query = await getValidatedQuery(event, TreeQuery);

      const root = findRoot(config.roots, query.root);
      const limit = clampLimit(query.limit);

      const generation = pinGeneration(store, root.id, query.generation);
      const node = resolvePathToNode(store, root.id, generation, query.path);
      if (!node) throw HTTPError.status(404, "Not Found", { message: "Path not found in this generation" });

      const children = node.kind === "directory" ? childrenOf(store, node.id, limit) : { rows: [], childCount: 0 };

      const slice: TreeSlice = {
        generation,
        root: root.id,
        path: query.path,
        node: { id: node.id, name: node.name, kind: node.kind, size: node.size, childCount: node.child_count },
        children: children.rows,
        childCount: children.childCount,
      };
      if ("omittedTail" in children && children.omittedTail) slice.omittedTail = children.omittedTail;
      return slice;
    }),
  );
};
