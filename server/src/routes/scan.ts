import { getQuery, HTTPError, readBody } from "h3";
import type { H3, H3Event } from "h3";
import type { ScannerStatus } from "@webdirstat/shared";
import type { Scanner, ScanMode } from "../scan/scanner.ts";

interface ScanRequest {
  root?: string;
  mode?: string;
}

/** Manual scan control: start (queue/preempt) and stop. Bypasses the schedule gates. */
export function registerScanRoutes(app: H3, scanner: Scanner): void {
  app.post("/api/scan", async (event: H3Event): Promise<{ outcome: string; status: ScannerStatus }> => {
    const body = ((await readBody(event).catch(() => undefined)) ?? {}) as ScanRequest;
    const query = getQuery(event);
    const rootId = body.root ?? (typeof query.root === "string" ? query.root : "");
    if (!rootId) throw HTTPError.status(400, "Bad Request", { message: 'Missing "root"' });

    const mode: ScanMode = (body.mode ?? query.mode) === "preempt" ? "preempt" : "queue";
    const trigger = mode === "preempt" ? "preempt" : "manual";

    const outcome = scanner.start(rootId, trigger, mode);
    if (outcome === "unknown-root") throw HTTPError.status(404, "Not Found", { message: `Unknown root "${rootId}"` });
    return { outcome, status: scanner.status() };
  });

  const stop = (): { status: ScannerStatus } => {
    scanner.stop();
    return { status: scanner.status() };
  };
  app.post("/api/scan/stop", () => stop());
  app.delete("/api/scan", () => stop());
}
