import { createEventStream, getQuery, HTTPError } from "h3";
import type { H3, H3Event } from "h3";
import type { ScanEvent } from "@webdirstat/shared";
import type { Config } from "../config.ts";
import type { Store } from "../store/db.ts";
import { findRoot } from "../scan/resolve-path.ts";
import { ScanBusyError, type ScanRunner } from "../scan/runner.ts";

/**
 * Milestone-1 manual scan: an SSE stream of progress, terminating in a `done`
 * event that carries a scan *summary* (not the tree — the tree now lives in the
 * store and is read in slices via `/api/tree`). Guarded by the single-flight
 * runner; the full scheduler/state-machine arrives in milestone 2.
 */
export function registerScanRoute(app: H3, config: Config, store: Store, runner: ScanRunner): void {
  app.get("/api/scan", (event: H3Event) => {
    const query = getQuery(event);
    const rootId = typeof query.root === "string" ? query.root : "";
    if (!rootId) throw HTTPError.status(400, "Bad Request", { message: 'Missing "root" query parameter' });

    const root = findRoot(config.roots, rootId);

    const stream = createEventStream(event);
    const send = (payload: ScanEvent) => stream.push(JSON.stringify(payload));

    void (async () => {
      try {
        const summary = await runner.run(store, root, {
          concurrency: config.scanConcurrency,
          historyGenerations: config.historyGenerations,
          onProgress: (entries, bytes, path) => {
            const relative = path.slice(root.absolutePath.length) || "/";
            void send({ type: "progress", entries, bytes, path: relative });
          },
        });
        await send({ type: "done", summary });
      } catch (error) {
        if (error instanceof ScanBusyError) {
          await send({ type: "error", message: error.message });
        } else if ((error as Error).name !== "AbortError") {
          await send({ type: "error", message: (error as Error).message });
        }
      } finally {
        await stream.close();
      }
    })();

    return stream.send();
  });
}
