import { createEventStream, getRouterParam } from "h3";
import type { H3, H3Event } from "h3";
import type { RootStatus } from "@webdirstat/shared";
import type { Config } from "../config.ts";
import type { Store } from "../store/db.ts";
import type { Scanner } from "../scan/scanner.ts";
import { currentLiveGeneration } from "../store/generations.ts";
import { getSchedule, getScanState } from "../store/settings.ts";
import { computeNextScanAt, isWindowOpen } from "../scan/schedule.ts";
import { findRoot } from "../scan/resolve-path.ts";

/** Global scanner state (SSE) + per-root status. The Start/Stop button derives from these. */
export function registerStatusRoutes(app: H3, config: Config, store: Store, scanner: Scanner): void {
  // Live global scanner state, pushed on every transition.
  app.get("/api/status", (event: H3Event) => {
    const stream = createEventStream(event);
    const send = () => void stream.push(JSON.stringify(scanner.status()));
    send();
    const unsubscribe = scanner.subscribe(() => send());
    stream.onClosed(() => unsubscribe());
    return stream.send();
  });

  app.get("/api/roots/:id/status", (event: H3Event): RootStatus => {
    const rootId = getRouterParam(event, "id") ?? "";
    const root = findRoot(config.roots, rootId);

    const now = Date.now();
    const generation = currentLiveGeneration(store, root.id) ?? null;
    const scanState = getScanState(store, root.id);
    const schedule = getSchedule(store, root.id, config.scheduleDefaults);

    const summary =
      generation != null
        ? (store.db
            .prepare("SELECT total_bytes AS b, total_count AS c FROM scan_summary WHERE generation = ?")
            .get(generation) as { b: number; c: number } | undefined)
        : undefined;

    const active =
      scanner.runningRoot() === root.id ? "scanning" : scanner.isQueued(root.id) ? "queued" : null;

    return {
      root: root.id,
      generation,
      lastScanStartedAt: scanState.lastScanStartedAt,
      lastScanEndedAt: scanState.lastScanEndedAt,
      lastScanStatus: scanState.lastScanStatus,
      totalBytes: summary?.b ?? null,
      totalCount: summary?.c ?? null,
      enabled: schedule.enabled,
      windowOpen: isWindowOpen(now, schedule.windows, schedule.timezone),
      nextScanAt: computeNextScanAt(now, schedule, scanState.lastScanStartedAt, scanState.lastScanEndedAt),
      active,
    };
  });
}
