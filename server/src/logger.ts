import { createConsola } from "consola";

/** Base logger. `LOG_LEVEL` (a consola numeric level) overrides the default verbosity. */
export const logger = createConsola({
  level: process.env.LOG_LEVEL ? Number(process.env.LOG_LEVEL) : undefined,
  formatOptions: { date: true, colors: true },
});

/** Tagged child loggers, so each subsystem's lines are visually grouped. */
export const scanLog = logger.withTag("scan");
export const scheduleLog = logger.withTag("scheduler");

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Human-readable byte count, e.g. `1.2 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1) return "0 B";
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}

/** Human-readable duration, e.g. `450ms`, `12.3s`, `1m03s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
