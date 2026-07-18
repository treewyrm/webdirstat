import type { RootSchedule } from "@webdirstat/shared";
import type { Store } from "./db.ts";

interface SettingsRow {
  root_id: string;
  enabled: number;
  concurrency: number;
  interval_ms: number | null;
  windows: string;
  timezone: string;
  min_interval_ms: number;
  on_window_end: string;
  history_generations: number;
  last_scan_started_ms: number | null;
  last_scan_ended_ms: number | null;
  last_scan_status: string | null;
}

/** Last-scan bookkeeping used by the scheduler to decide the next action. */
export interface ScanState {
  lastScanStartedAt: number | null;
  lastScanEndedAt: number | null;
  lastScanStatus: "ok" | "aborted" | "error" | null;
}

function toSchedule(row: SettingsRow): RootSchedule {
  return {
    enabled: row.enabled !== 0,
    concurrency: row.concurrency,
    intervalMs: row.interval_ms,
    windows: JSON.parse(row.windows) as RootSchedule["windows"],
    timezone: row.timezone,
    minIntervalMs: row.min_interval_ms,
    onWindowEnd: row.on_window_end === "abort" ? "abort" : "finish",
    historyGenerations: row.history_generations,
  };
}

/**
 * Inserts the env-seeded defaults for a root on first run only (INSERT OR IGNORE),
 * so later UI edits persist across restarts even if the env defaults change.
 */
export function seedRootSettings(store: Store, rootId: string, defaults: RootSchedule): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO root_settings
         (root_id, enabled, concurrency, interval_ms, windows, timezone, min_interval_ms, on_window_end, history_generations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rootId,
      defaults.enabled ? 1 : 0,
      defaults.concurrency,
      defaults.intervalMs,
      JSON.stringify(defaults.windows),
      defaults.timezone,
      defaults.minIntervalMs,
      defaults.onWindowEnd,
      defaults.historyGenerations,
    );
}

function row(store: Store, rootId: string): SettingsRow | undefined {
  return store.db.prepare("SELECT * FROM root_settings WHERE root_id = ?").get(rootId) as SettingsRow | undefined;
}

/** Reads a root's schedule (falls back to `defaults` if the row is somehow missing). */
export function getSchedule(store: Store, rootId: string, defaults: RootSchedule): RootSchedule {
  const r = row(store, rootId);
  return r ? toSchedule(r) : defaults;
}

/** Overwrites a root's schedule (the UI's PUT target). */
export function putSchedule(store: Store, rootId: string, schedule: RootSchedule): void {
  store.db
    .prepare(
      `UPDATE root_settings SET
         enabled = ?, concurrency = ?, interval_ms = ?, windows = ?, timezone = ?,
         min_interval_ms = ?, on_window_end = ?, history_generations = ?
       WHERE root_id = ?`,
    )
    .run(
      schedule.enabled ? 1 : 0,
      schedule.concurrency,
      schedule.intervalMs,
      JSON.stringify(schedule.windows),
      schedule.timezone,
      schedule.minIntervalMs,
      schedule.onWindowEnd,
      schedule.historyGenerations,
      rootId,
    );
}

export function getScanState(store: Store, rootId: string): ScanState {
  const r = row(store, rootId);
  return {
    lastScanStartedAt: r?.last_scan_started_ms ?? null,
    lastScanEndedAt: r?.last_scan_ended_ms ?? null,
    lastScanStatus: (r?.last_scan_status as ScanState["lastScanStatus"]) ?? null,
  };
}

export function recordScanStart(store: Store, rootId: string, startedMs: number): void {
  store.db
    .prepare("UPDATE root_settings SET last_scan_started_ms = ?, last_scan_status = NULL WHERE root_id = ?")
    .run(startedMs, rootId);
}

export function recordScanEnd(
  store: Store,
  rootId: string,
  endedMs: number,
  status: "ok" | "aborted" | "error",
): void {
  store.db
    .prepare("UPDATE root_settings SET last_scan_ended_ms = ?, last_scan_status = ? WHERE root_id = ?")
    .run(endedMs, status, rootId);
}
