import { defineHandler, getRouterParam, readValidatedBody } from "h3";
import { z } from "zod";
import type { RootSchedule } from "@webdirstat/shared";
import { getSchedule, putSchedule } from "../store/settings.ts";
import { findRoot } from "../scan/resolve-path.ts";
import type { RouteFactory } from "./context.ts";

const TIME_RE = /^\d{1,2}:\d{2}$/;

const Window = z
  .object({
    days: z.array(z.number().int().min(0).max(6)),
    from: z.string().regex(TIME_RE),
    to: z.string().regex(TIME_RE),
  })
  .transform((w) => ({ days: [...new Set(w.days)].sort((a, b) => a - b), from: w.from, to: w.to }));

/**
 * The whole schedule contract, replacing the former hand-rolled parseSchedule. As a
 * Standard Schema it drives `readValidatedBody` (auto-400 on bad input) and its inferred
 * type is `RootSchedule`. Lenient fields mirror the old coercions: `enabled` falls back to
 * false, `onWindowEnd` to "finish".
 */
const ScheduleSchema = z.object({
  enabled: z.boolean().catch(false),
  concurrency: z.coerce.number().int().min(1),
  intervalMs: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
  windows: z.array(Window).default([]),
  timezone: z.string().min(1),
  minIntervalMs: z.coerce.number().min(0),
  onWindowEnd: z.enum(["abort", "finish"]).catch("finish"),
  historyGenerations: z.coerce.number().int().min(0),
}) satisfies z.ZodType<RootSchedule, unknown>;

/** Read/update the per-root schedule (DB-backed settings the UI edits; env seeds defaults). */
export const registerScheduleRoutes: RouteFactory = ({ app, config, store, scheduler }) => {
  app.get(
    "/api/roots/:id/schedule",
    defineHandler((event): RootSchedule => {
      const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
      return getSchedule(store, root.id, config.scheduleDefaults);
    }),
  );

  app.put(
    "/api/roots/:id/schedule",
    defineHandler(async (event): Promise<RootSchedule> => {
      const root = findRoot(config.roots, getRouterParam(event, "id") ?? "");
      const schedule = await readValidatedBody(event, ScheduleSchema);
      putSchedule(store, root.id, schedule);
      scheduler.reschedule();
      return schedule;
    }),
  );
};
