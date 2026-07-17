import { getQuery, HTTPError } from "h3";
import type { H3, H3Event } from "h3";
import type { TreeSlice } from "@webdirstat/shared";
import type { Config } from "../config.ts";
import type { Store } from "../store/db.ts";
import { currentLiveGeneration } from "../store/generations.ts";
import { childrenOf, resolvePathToNode, rootNodeRow } from "../store/nodes.ts";
import { findRoot } from "../scan/resolve-path.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * One directory level, size-sorted and capped — the entry point into the tree.
 * `path` addresses durably (root + relative path); the returned children carry
 * generation-scoped `id`s for id-addressed navigation thereafter.
 */
export function registerTreeRoute(app: H3, config: Config, store: Store): void {
  app.get("/api/tree", (event: H3Event): TreeSlice => {
    const query = getQuery(event);
    const rootId = typeof query.root === "string" ? query.root : "";
    if (!rootId) throw HTTPError.status(400, "Bad Request", { message: 'Missing "root" query parameter' });

    const root = findRoot(config.roots, rootId);
    const path = typeof query.path === "string" ? query.path : "";
    const limit = parseLimit(query.limit);

    // Pin a generation: explicit if given (historical reads allowed while retained),
    // else the current live one. A pinned-but-pruned generation is 410 Gone.
    let generation: number;
    if (typeof query.generation === "string") {
      const g = Number(query.generation);
      if (!Number.isInteger(g)) throw HTTPError.status(400, "Bad Request", { message: "Invalid generation" });
      if (!rootNodeRow(store, root.id, g)) {
        throw HTTPError.status(410, "Gone", { message: "Generation is no longer available; refetch the current view" });
      }
      generation = g;
    } else {
      const live = currentLiveGeneration(store, root.id);
      if (live === undefined) throw HTTPError.status(404, "Not Found", { message: `Root "${root.id}" has not been scanned yet` });
      generation = live;
    }

    const node = resolvePathToNode(store, root.id, generation, path);
    if (!node) throw HTTPError.status(404, "Not Found", { message: "Path not found in this generation" });

    const children = node.kind === "directory" ? childrenOf(store, node.id, limit) : { rows: [], childCount: 0 };

    const slice: TreeSlice = {
      generation,
      root: root.id,
      path,
      node: { id: node.id, name: node.name, kind: node.kind, size: node.size, childCount: node.child_count },
      children: children.rows,
      childCount: children.childCount,
    };
    if ("omittedTail" in children && children.omittedTail) slice.omittedTail = children.omittedTail;
    return slice;
  });
}
