import { defineHandler, readValidatedBody } from "h3";
import { z } from "zod";
import type { TreeBatchNode, TreeBatchRequest, TreeBatchResolved, TreeBatchResponse } from "@webdirstat/shared";
import { childrenOf, getNodeById, resolvePathToNode, type NodeRow } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { pinGeneration } from "./generation.ts";
import type { RouteContext, RouteFactory } from "./context.ts";

// Guardrails so one batch can't ask the server to serialize half the tree.
const MAX_REQUESTS = 64;
const MAX_NODES = 20_000; // total children returned across the whole response
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_DEPTH = 8;
/** Don't expand the interior of a directory smaller than this fraction of its anchor (sub-pixel). */
const SIZE_FRACTION = 0.001;

interface Frame {
  id: number;
  kind: string;
  size: number;
  childCount: number;
  level: number;
}

/**
 * The untrusted-body contract in one schema. zod implements Standard Schema, so
 * `readValidatedBody` consumes it directly and a malformed body becomes a 400
 * automatically; the inferred type flows into the handler.
 */
const BatchBody = z.object({
  root: z.string().min(1),
  generation: z.number().optional(),
  requests: z
    .object({
      parentId: z.number().optional(),
      path: z.string().optional(),
      limit: z.number().optional(),
      depth: z.number().optional(),
      minSize: z.number().optional(),
    })
    .array()
    .max(MAX_REQUESTS),
});

/**
 * The tile query for map navigation: many directories' children (depth 1) plus
 * optional subtree spines (depth > 1) in one round trip, keyed by id, generation
 * pinned. Anchors are `{parentId}` (ownership-checked) or `{path}` (traversal
 * guarded via in-store resolution). See docs/issues/0002 "POST /api/tree/batch".
 */
export const registerBatchRoute: RouteFactory = ({ app, config, store }) => {
  app.post(
    "/api/tree/batch",
    defineHandler(async (event): Promise<TreeBatchResponse> => {
      const query = await readValidatedBody(event, BatchBody);

      const root = findRoot(config.roots, query.root);
      const generation = pinGeneration(store, root.id, query.generation);

      const nodes: Record<string, TreeBatchNode> = {};
      const resolved: (TreeBatchResolved | null)[] = [];
      let budget = MAX_NODES;
      let truncated = false;

      for (const request of query.requests) {
        const anchor = resolveAnchor(store, root.id, generation, request);
        if (!anchor) {
          resolved.push(null);
          continue;
        }
        resolved.push({
          id: anchor.id,
          path: typeof request.path === "string" ? request.path : "",
          kind: anchor.kind,
          size: anchor.size,
          childCount: anchor.child_count,
        });

        const depth = clamp(request.depth ?? 1, 1, MAX_DEPTH);
        const limit = clamp(request.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
        const minSize = request.minSize != null && request.minSize > 0 ? Math.floor(request.minSize) : 0;
        const threshold = anchor.size * SIZE_FRACTION;

        // Breadth-first expansion down to `depth`, size-pruning small interiors.
        const stack: Frame[] = [{ id: anchor.id, kind: anchor.kind, size: anchor.size, childCount: anchor.child_count, level: 1 }];
        while (stack.length > 0) {
          const frame = stack.pop()!;
          if (frame.kind !== "directory" || frame.id in nodes) continue;
          if (budget <= 0) {
            truncated = true;
            break;
          }

          const slice = childrenOf(store, frame.id, limit, minSize);
          const entry: TreeBatchNode = { children: slice.rows, childCount: slice.childCount };
          if (slice.omittedTail) entry.omittedTail = slice.omittedTail;
          if (slice.foldedSmall) entry.foldedSmall = slice.foldedSmall;
          nodes[frame.id] = entry;
          budget -= slice.rows.length;

          if (frame.level < depth) {
            for (const child of slice.rows) {
              if (child.kind !== "directory" || child.childCount === 0 || child.size < threshold) continue;
              stack.push({ id: child.id, kind: child.kind, size: child.size, childCount: child.childCount, level: frame.level + 1 });
            }
          }
        }
        if (truncated) break;
      }

      const response: TreeBatchResponse = { generation, resolved, nodes };
      if (truncated) response.truncated = true;
      return response;
    }),
  );
};

function resolveAnchor(store: RouteContext["store"], rootId: string, generation: number, request: TreeBatchRequest): NodeRow | undefined {
  if (typeof request.parentId === "number") return getNodeById(store, request.parentId, rootId, generation);
  if (typeof request.path === "string") return resolvePathToNode(store, rootId, generation, request.path);
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
