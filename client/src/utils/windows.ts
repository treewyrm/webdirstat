import type { ScheduleWindow } from "@webdirstat/shared";

// Client-side mirror of the server's SCAN_WINDOWS text format, used by the schedule
// editor: "Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00". Kept tiny and in sync with
// server/src/scan/schedule.ts (parseWindows).

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TIME_RE = /^\d{1,2}:\d{2}$/;

function parseDays(spec: string): number[] {
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const range = token.split("-");
    if (range.length === 2) {
      const start = DAY_INDEX[range[0]!.slice(0, 3)];
      const end = DAY_INDEX[range[1]!.slice(0, 3)];
      if (start === undefined || end === undefined) continue;
      for (let d = start; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === end) break;
      }
    } else {
      const d = DAY_INDEX[token.slice(0, 3)];
      if (d !== undefined) days.add(d);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** Parses the windows text field, throwing on a malformed segment. */
export function parseWindows(raw: string): ScheduleWindow[] {
  const windows: ScheduleWindow[] = [];
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace === -1) throw new Error(`Bad window: "${trimmed}"`);
    const days = parseDays(trimmed.slice(0, lastSpace));
    const [from, to] = trimmed.slice(lastSpace + 1).split("-");
    if (days.length === 0 || !from || !to || !TIME_RE.test(from) || !TIME_RE.test(to)) {
      throw new Error(`Bad window: "${trimmed}"`);
    }
    windows.push({ days, from, to });
  }
  return windows;
}

/** Compresses consecutive days into ranges for display (e.g. [1,2,3,4,5] → "Mon-Fri"). */
function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const groups: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    groups.push(j > i ? `${DAY_NAMES[sorted[i]!]}-${DAY_NAMES[sorted[j]!]}` : DAY_NAMES[sorted[i]!]!);
    i = j + 1;
  }
  return groups.join(",");
}

export function formatWindows(windows: ScheduleWindow[]): string {
  return windows.map((w) => `${formatDays(w.days)} ${w.from}-${w.to}`).join("; ");
}
