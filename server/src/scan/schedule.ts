import type { RootSchedule, ScheduleWindow } from "@webdirstat/shared";

/** How far ahead to search for the next window opening before giving up. */
const HORIZON_DAYS = 14;
const DAY_MS = 86_400_000;

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Parses a duration like `6h`, `90m`, `1h30m`, `2d`, or a plain millisecond number.
 * Returns null for empty/invalid input.
 */
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let ms = 0;
  let matched = false;
  for (const [, n, unit] of trimmed.matchAll(re)) {
    matched = true;
    const value = Number(n);
    ms += value * ({ d: DAY_MS, h: 3_600_000, m: 60_000, s: 1000 })[unit!.toLowerCase()]!;
  }
  return matched ? ms : null;
}

function parseDays(spec: string): number[] {
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const range = token.split("-");
    if (range.length === 2) {
      const start = DAY_NAMES[range[0]!.slice(0, 3)];
      const end = DAY_NAMES[range[1]!.slice(0, 3)];
      if (start === undefined || end === undefined) continue;
      for (let d = start; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === end) break;
      }
    } else {
      const d = DAY_NAMES[token.slice(0, 3)];
      if (d !== undefined) days.add(d);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Parses `SCAN_WINDOWS` like `"Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00"` into
 * structured windows. Invalid segments are skipped.
 */
export function parseWindows(raw: string | undefined): ScheduleWindow[] {
  if (!raw) return [];
  const windows: ScheduleWindow[] = [];
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace === -1) continue;
    const daySpec = trimmed.slice(0, lastSpace).trim();
    const timeSpec = trimmed.slice(lastSpace + 1).trim();
    const [from, to] = timeSpec.split("-");
    if (!from || !to || !/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) continue;
    const days = parseDays(daySpec);
    if (days.length === 0) continue;
    windows.push({ days, from, to });
  }
  return windows;
}

interface TzParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Wall-clock fields of `utcMs` in `tz`. */
function tzParts(utcMs: number, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
  };
}

/** UTC offset (wall − UTC) in ms that `tz` has at instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = tzParts(utcMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - utcMs;
}

/** The UTC instant of a local wall-clock time in `tz` (double-pass to settle DST). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

function hm(spec: string): [number, number] {
  const [h, m] = spec.split(":");
  return [Number(h), Number(m)];
}

interface Interval {
  start: number;
  end: number;
}

/**
 * All window [start, end) instants intersecting the horizon after `fromMs`. A window
 * with `to <= from` crosses midnight and ends the next calendar day.
 */
function windowIntervals(fromMs: number, windows: ScheduleWindow[], tz: string): Interval[] {
  if (windows.length === 0) return [];
  const today = tzParts(fromMs, tz);
  const baseNoonUtc = Date.UTC(today.y, today.mo - 1, today.d, 12);
  const intervals: Interval[] = [];

  // Start one day back so a window that began yesterday and crosses midnight into
  // `fromMs` (e.g. Fri 22:00–Sat 04:00) is still captured; past-done ones are filtered below.
  for (let offset = -1; offset <= HORIZON_DAYS; offset++) {
    const day = new Date(baseNoonUtc + offset * DAY_MS);
    const cy = day.getUTCFullYear();
    const cmo = day.getUTCMonth() + 1;
    const cd = day.getUTCDate();
    const weekday = day.getUTCDay();

    for (const w of windows) {
      if (!w.days.includes(weekday)) continue;
      const [fh, fm] = hm(w.from);
      const [th, tm] = hm(w.to);
      const start = zonedToUtc(cy, cmo, cd, fh, fm, tz);
      const crossesMidnight = th < fh || (th === fh && tm <= fm);
      const endBase = new Date(baseNoonUtc + (offset + (crossesMidnight ? 1 : 0)) * DAY_MS);
      const end = zonedToUtc(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), th, tm, tz);
      if (end > fromMs) intervals.push({ start, end });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  return intervals;
}

/** True if an allowed window is open at `nowMs` (empty window list = always open). */
export function isWindowOpen(nowMs: number, windows: ScheduleWindow[], tz: string): boolean {
  if (windows.length === 0) return true;
  return windowIntervals(nowMs, windows, tz).some((iv) => iv.start <= nowMs && nowMs < iv.end);
}

/** If a window is open at `nowMs`, when it closes; otherwise null. Empty windows never close. */
export function currentWindowEnd(nowMs: number, windows: ScheduleWindow[], tz: string): number | null {
  if (windows.length === 0) return null;
  for (const iv of windowIntervals(nowMs, windows, tz)) {
    if (iv.start <= nowMs && nowMs < iv.end) return iv.end;
  }
  return null;
}

/** The earliest instant >= `fromMs` inside an allowed window (fromMs itself if already open). */
function nextWindowOpen(fromMs: number, windows: ScheduleWindow[], tz: string): number | null {
  if (windows.length === 0) return fromMs;
  for (const iv of windowIntervals(fromMs, windows, tz)) {
    if (iv.start <= fromMs && fromMs < iv.end) return fromMs;
    if (iv.start >= fromMs) return iv.start;
  }
  return null;
}

/**
 * When the next automatic scan should fire for a root, composing the freshness gate
 * (interval), the window gate, and the minInterval floor. Returns null if automatic
 * scanning is disabled or no window opens within the horizon.
 *
 * A returned instant <= now means "due now".
 */
export function computeNextScanAt(
  nowMs: number,
  schedule: RootSchedule,
  lastScanStartedAt: number | null,
  lastScanEndedAt: number | null,
): number | null {
  if (!schedule.enabled) return null;

  // Freshness: wanted once data is older than the interval. No interval → always wanted.
  const wanted = schedule.intervalMs == null ? nowMs : (lastScanEndedAt ?? 0) + schedule.intervalMs;
  // Floor: never closer than minInterval to the previous scan start.
  const floor = (lastScanStartedAt ?? 0) + schedule.minIntervalMs;
  const earliest = Math.max(wanted, floor);

  return nextWindowOpen(earliest, schedule.windows, schedule.timezone);
}
