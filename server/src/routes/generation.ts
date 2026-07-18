import { HTTPError } from "h3";
import type { Store } from "../store/db.ts";
import { currentLiveGeneration } from "../store/generations.ts";
import { rootNodeRow } from "../store/nodes.ts";

/**
 * Pins the generation a read runs against: the explicit one if given (historical
 * reads are allowed while retained), else the current live one. A pinned-but-pruned
 * generation is 410 Gone → the client refetches the current view; an unscanned root
 * is 404. Shared by the tree and batch read routes.
 */
export function pinGeneration(store: Store, rootId: string, raw: unknown): number {
  if (typeof raw === "string" || typeof raw === "number") {
    const generation = Number(raw);
    if (!Number.isInteger(generation)) {
      throw HTTPError.status(400, "Bad Request", { message: "Invalid generation" });
    }
    if (!rootNodeRow(store, rootId, generation)) {
      throw HTTPError.status(410, "Gone", { message: "Generation is no longer available; refetch the current view" });
    }
    return generation;
  }
  const live = currentLiveGeneration(store, rootId);
  if (live === undefined) {
    throw HTTPError.status(404, "Not Found", { message: `Root "${rootId}" has not been scanned yet` });
  }
  return live;
}
