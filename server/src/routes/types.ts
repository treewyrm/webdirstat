import { defineHandler, getRouterParam, getValidatedQuery } from "h3";
import { z } from "zod";
import type { TypeRollupResponse } from "@webdirstat/shared";
import { typeRollupOf } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { pinGeneration } from "./generation.ts";
import type { RouteFactory } from "./context.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const TypesQuery = z.object({
  limit: z.coerce.number().catch(DEFAULT_LIMIT).default(DEFAULT_LIMIT),
  generation: z.string().optional(),
});

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Per-root space-by-file-type breakdown (feature 0005): the extension rollup the
 * walk precomputed, size-sorted and capped, pinned to the same generation model as
 * the tree reads (explicit generation allowed while retained, else current live;
 * a pruned generation is 410, an unscanned root 404).
 */
export const registerTypesRoute: RouteFactory = ({ app, config, store }) => {
  app.get(
    "/api/roots/:id/types",
    defineHandler(async (event): Promise<TypeRollupResponse> => {
      const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
      const query = await getValidatedQuery(event, TypesQuery);
      const limit = clampLimit(query.limit);

      const generation = pinGeneration(store, root.id, query.generation);
      const rollup = typeRollupOf(store, root.id, generation, limit);

      const response: TypeRollupResponse = { generation, root: root.id, types: rollup.types };
      if (rollup.omittedTail) response.omittedTail = rollup.omittedTail;
      return response;
    }),
  );
};
