import { defineHandler, getQuery, HTTPError, readBody } from "h3";
import { z } from "zod";
import type { ScannerStatus } from "@webdirstat/shared";
import type { RouteFactory } from "./context.ts";

/** root/mode may arrive in the JSON body or the query string; body wins on overlap. */
const ScanParams = z.object({
  root: z.string().min(1, 'Missing "root"'),
  mode: z.enum(["queue", "preempt"]).catch("queue"),
});

/** Manual scan control: start (queue/preempt) and stop. Bypasses the schedule gates. */
export const registerScanRoutes: RouteFactory = ({ app, scanner }) => {
  app.post(
    "/api/scan",
    defineHandler(async (event): Promise<{ outcome: string; status: ScannerStatus }> => {
      const body = ((await readBody(event).catch(() => undefined)) ?? {}) as Record<string, unknown>;
      const query = getQuery(event) as Record<string, unknown>;
      const parsed = ScanParams.safeParse({ ...query, ...body });
      if (!parsed.success) {
        throw HTTPError.status(400, "Bad Request", { message: parsed.error.issues[0]?.message ?? "Invalid scan request" });
      }

      const { root: rootId, mode } = parsed.data;
      const trigger = mode === "preempt" ? "preempt" : "manual";
      const outcome = scanner.start(rootId, trigger, mode);
      if (outcome === "unknown-root") throw HTTPError.status(404, "Not Found", { message: `Unknown root "${rootId}"` });
      return { outcome, status: scanner.status() };
    }),
  );

  const stop = (): { status: ScannerStatus } => {
    scanner.stop();
    return { status: scanner.status() };
  };
  app.post("/api/scan/stop", () => stop());
  app.delete("/api/scan", () => stop());
};
