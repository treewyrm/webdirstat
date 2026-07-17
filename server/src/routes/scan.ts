import { createEventStream, getQuery, HTTPError } from "h3";
import type { H3, H3Event } from "h3";
import type { ScanEvent } from "@webdirstat/shared";
import type { Config } from "../config.ts";
import { findRoot, resolveScanPath } from "../scan/resolve-path.ts";
import { scanTree } from "../scan/walk.ts";

export function registerScanRoute(app: H3, config: Config): void {
  app.get("/api/scan", async (event: H3Event) => {
    const query = getQuery(event);
    const rootId = typeof query.root === "string" ? query.root : "";
    const relativePath = typeof query.path === "string" ? query.path : undefined;

    if (!rootId) {
      throw HTTPError.status(400, "Bad Request", { message: 'Missing "root" query parameter' });
    }

    const root = findRoot(config.roots, rootId);
    const absolutePath = await resolveScanPath(root, relativePath);

    const stream = createEventStream(event);
    const controller = new AbortController();
    stream.onClosed(() => controller.abort());

    const send = (payload: ScanEvent) => stream.push(JSON.stringify(payload));

    void (async () => {
      const startedAt = Date.now();
      try {
        const { tree, entries, bytes } = await scanTree(absolutePath, {
          signal: controller.signal,
          onProgress: (scanned, scannedBytes, path) => {
            const relative = path.slice(root.absolutePath.length) || "/";
            void send({ type: "progress", entries: scanned, bytes: scannedBytes, path: relative });
          },
        });
        await send({ type: "done", tree, entries, bytes, durationMs: Date.now() - startedAt });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          await send({ type: "error", message: (error as Error).message });
        }
      } finally {
        await stream.close();
      }
    })();

    return stream.send();
  });
}
