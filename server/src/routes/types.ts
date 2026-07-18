import { defineHandler, getRouterParam, getValidatedQuery } from "h3";
import { z } from "zod";
import type { TypeRollupResponse } from "@webdirstat/shared";
import { resolvePathToNode, subtreeTypeRollup, typeRollupOf, type TypeRollup } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { pinGeneration } from "./generation.ts";
import type { RouteFactory } from "./context.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const TypesQuery = z.object({
  path: z.string().default(""),
  limit: z.coerce.number().catch(DEFAULT_LIMIT).default(DEFAULT_LIMIT),
  generation: z.string().optional(),
});

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Space-by-file-type breakdown (feature 0005), size-sorted and capped, pinned to the
 * same generation model as the tree reads (explicit generation allowed while
 * retained, else current live; a pruned generation is 410, an unscanned root 404).
 *
 * Scope follows `path`: empty ("" = the whole root) is answered from the precomputed
 * `type_rollup` table in O(extensions); a subpath is aggregated on demand over just
 * that subtree so the panel can track the currently focused folder. A `path` that
 * doesn't resolve (transient during a generation swap) or points at a non-directory
 * returns an empty breakdown rather than erroring, so navigation never faults it.
 */
export const registerTypesRoute: RouteFactory = ({ app, config, store }) => {
  app.get(
    "/api/roots/:id/types",
    defineHandler(async (event): Promise<TypeRollupResponse> => {
      const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
      const query = await getValidatedQuery(event, TypesQuery);
      const limit = clampLimit(query.limit);

      const generation = pinGeneration(store, root.id, query.generation);

      let rollup: TypeRollup;
      if (query.path === "") {
        rollup = typeRollupOf(store, root.id, generation, limit);
      } else {
        const node = resolvePathToNode(store, root.id, generation, query.path);
        rollup =
          node && node.kind === "directory" ? subtreeTypeRollup(store, node.id, limit) : { types: [] };
      }

      const response: TypeRollupResponse = { generation, root: root.id, path: query.path, types: rollup.types };
      if (rollup.omittedTail) response.omittedTail = rollup.omittedTail;
      return response;
    }),
  );
};
