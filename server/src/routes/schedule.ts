import { getRouterParam, HTTPError, readBody } from "h3";
import type { H3, H3Event } from "h3";
import type { RootSchedule, ScheduleWindow } from "@webdirstat/shared";
import type { Config } from "../config.ts";
import type { Store } from "../store/db.ts";
import type { Scheduler } from "../scan/scheduler.ts";
import { getSchedule, putSchedule } from "../store/settings.ts";
import { findRoot } from "../scan/resolve-path.ts";

const TIME_RE = /^\d{1,2}:\d{2}$/;

function badRequest(message: string): never {
  throw HTTPError.status(400, "Bad Request", { message });
}

/** Validates + normalizes an untrusted schedule payload into a RootSchedule. */
function parseSchedule(body: unknown): RootSchedule {
  if (typeof body !== "object" || body === null) badRequest("Expected a JSON object");
  const b = body as Record<string, unknown>;

  const windows: ScheduleWindow[] = [];
  if (b.windows !== undefined) {
    if (!Array.isArray(b.windows)) badRequest('"windows" must be an array');
    for (const w of b.windows) {
      const win = w as Record<string, unknown>;
      if (
        !Array.isArray(win.days) ||
        !win.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) ||
        typeof win.from !== "string" ||
        typeof win.to !== "string" ||
        !TIME_RE.test(win.from) ||
        !TIME_RE.test(win.to)
      ) {
        badRequest("Each window needs days[0-6], from 'HH:MM', to 'HH:MM'");
      }
      windows.push({ days: [...new Set(win.days as number[])].sort((x, y) => x - y), from: win.from, to: win.to });
    }
  }

  const intervalMs =
    b.intervalMs == null ? null : Number.isFinite(Number(b.intervalMs)) ? Number(b.intervalMs) : badRequest("bad intervalMs");
  const concurrency = Number(b.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) badRequest("concurrency must be a positive integer");
  const minIntervalMs = Number(b.minIntervalMs);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) badRequest("minIntervalMs must be >= 0");
  const historyGenerations = Number(b.historyGenerations);
  if (!Number.isInteger(historyGenerations) || historyGenerations < 0) badRequest("historyGenerations must be >= 0");

  return {
    enabled: Boolean(b.enabled),
    concurrency,
    intervalMs,
    windows,
    timezone: typeof b.timezone === "string" && b.timezone ? b.timezone : badRequest("timezone required"),
    minIntervalMs,
    onWindowEnd: b.onWindowEnd === "abort" ? "abort" : "finish",
    historyGenerations,
  };
}

/** Read/update the per-root schedule (DB-backed settings the UI edits; env seeds defaults). */
export function registerScheduleRoutes(app: H3, config: Config, store: Store, scheduler: Scheduler): void {
  app.get("/api/roots/:id/schedule", (event: H3Event): RootSchedule => {
    const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
    return getSchedule(store, root.id, config.scheduleDefaults);
  });

  app.put("/api/roots/:id/schedule", async (event: H3Event): Promise<RootSchedule> => {
    const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
    const schedule = parseSchedule(await readBody(event));
    putSchedule(store, root.id, schedule);
    scheduler.reschedule();
    return schedule;
  });
}
