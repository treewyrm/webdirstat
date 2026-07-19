import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RootSchedule } from "@webdirstat/shared";
import {
  computeNextScanAt,
  currentWindowEnd,
  isWindowOpen,
  parseDuration,
  parseWindows,
} from "./schedule.ts";

const H = 3_600_000;
const M = 60_000;
const D = 86_400_000;
const TZ = "UTC"; // no DST — keeps window math deterministic across CI machines

describe("parseDuration", () => {
  test("unit suffixes", () => {
    assert.equal(parseDuration("6h"), 6 * H);
    assert.equal(parseDuration("90m"), 90 * M);
    assert.equal(parseDuration("2d"), 2 * D);
    assert.equal(parseDuration("10s"), 10_000);
  });

  test("compound and whitespace", () => {
    assert.equal(parseDuration("1h30m"), 90 * M);
    assert.equal(parseDuration("1h 30m"), 90 * M);
    assert.equal(parseDuration(" 2d "), 2 * D);
  });

  test("a bare number is milliseconds", () => {
    assert.equal(parseDuration("500"), 500);
  });

  test("empty / invalid → null", () => {
    assert.equal(parseDuration(undefined), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration("garbage"), null);
  });
});

describe("parseWindows", () => {
  test("a day range and time span", () => {
    assert.deepEqual(parseWindows("Mon-Fri 01:00-05:00"), [
      { days: [1, 2, 3, 4, 5], from: "01:00", to: "05:00" },
    ]);
  });

  test("a comma day list (sorted, Sun=0)", () => {
    assert.deepEqual(parseWindows("Sat,Sun 00:00-08:00"), [
      { days: [0, 6], from: "00:00", to: "08:00" },
    ]);
  });

  test("a range wrapping past Sunday", () => {
    assert.deepEqual(parseWindows("Fri-Mon 22:00-04:00"), [
      { days: [0, 1, 5, 6], from: "22:00", to: "04:00" },
    ]);
  });

  test("multiple semicolon-separated segments", () => {
    assert.deepEqual(parseWindows("Mon-Fri 01:00-05:00; Sat,Sun 00:00-08:00"), [
      { days: [1, 2, 3, 4, 5], from: "01:00", to: "05:00" },
      { days: [0, 6], from: "00:00", to: "08:00" },
    ]);
  });

  test("invalid segments are skipped", () => {
    assert.deepEqual(parseWindows(""), []);
    assert.deepEqual(parseWindows("no-time-here"), []);
    assert.deepEqual(parseWindows("Mon 1-2"), []); // times need HH:MM
    assert.deepEqual(parseWindows("Xyz 01:00-05:00"), []); // unknown day
  });
});

describe("isWindowOpen / currentWindowEnd", () => {
  const windows = parseWindows("Mon-Fri 01:00-05:00");
  // 2026-01-05 is a Monday.
  const monday = (h: number, m = 0) => Date.UTC(2026, 0, 5, h, m);

  test("empty window list is always open and never closes", () => {
    assert.equal(isWindowOpen(monday(3), [], TZ), true);
    assert.equal(currentWindowEnd(monday(3), [], TZ), null);
  });

  test("inside the window", () => {
    assert.equal(isWindowOpen(monday(2), windows, TZ), true);
    assert.equal(currentWindowEnd(monday(2), windows, TZ), monday(5));
  });

  test("the start is inclusive, the end exclusive", () => {
    assert.equal(isWindowOpen(monday(1), windows, TZ), true);
    assert.equal(isWindowOpen(monday(5), windows, TZ), false);
  });

  test("outside the window", () => {
    assert.equal(isWindowOpen(monday(6), windows, TZ), false);
    assert.equal(currentWindowEnd(monday(6), windows, TZ), null);
    // Sunday 2026-01-04 is not a Mon-Fri day.
    assert.equal(isWindowOpen(Date.UTC(2026, 0, 4, 3), windows, TZ), false);
  });

  test("a window crossing midnight covers the early hours of the next day", () => {
    const overnight = parseWindows("Fri 22:00-04:00");
    // Friday 2026-01-02 23:00 → open; Saturday 2026-01-03 02:00 → still open; 05:00 → closed.
    assert.equal(isWindowOpen(Date.UTC(2026, 0, 2, 23), overnight, TZ), true);
    assert.equal(isWindowOpen(Date.UTC(2026, 0, 3, 2), overnight, TZ), true);
    assert.equal(isWindowOpen(Date.UTC(2026, 0, 3, 5), overnight, TZ), false);
  });
});

describe("computeNextScanAt", () => {
  const base: RootSchedule = {
    enabled: true,
    concurrency: 4,
    intervalMs: 6 * H,
    windows: [],
    timezone: TZ,
    minIntervalMs: H,
    onWindowEnd: "finish",
    historyGenerations: 3,
  };
  const sched = (over: Partial<RootSchedule>): RootSchedule => ({ ...base, ...over });
  const now = Date.UTC(2026, 0, 5, 12); // Monday noon UTC

  test("disabled → null", () => {
    assert.equal(computeNextScanAt(now, sched({ enabled: false }), null, null), null);
  });

  test("never scanned, no windows → due now (a past instant)", () => {
    // wanted = lastEnded(0) + interval and floor = lastStarted(0) + minInterval both land just
    // after the epoch — long before `now` — so the scan is due immediately (returned ≤ now).
    const at = computeNextScanAt(now, sched({}), null, null);
    assert.ok(at !== null && at <= now, `expected a due (≤ now) instant, got ${at}`);
  });

  test("freshness gate: next scan is intervalMs after the last scan ended", () => {
    const endedAt = now - H; // scanned an hour ago, interval is 6h
    const at = computeNextScanAt(now, sched({}), now - 2 * H, endedAt);
    assert.equal(at, endedAt + 6 * H);
  });

  test("no interval means always wanted (gated only by minInterval floor)", () => {
    const startedAt = now - 10 * M; // minInterval is 1h
    const at = computeNextScanAt(now, sched({ intervalMs: null }), startedAt, now - 5 * M);
    assert.equal(at, startedAt + H);
  });

  test("window gate: a due scan waits for the next open window", () => {
    // At Monday noon, wanted-now, but the only window is Tue 01:00–05:00.
    const windows = parseWindows("Tue 01:00-05:00");
    const at = computeNextScanAt(now, sched({ intervalMs: null, minIntervalMs: 0, windows }), null, null);
    assert.equal(at, Date.UTC(2026, 0, 6, 1)); // Tuesday 01:00 UTC
  });

  test("a not-yet-stale scan is scheduled at the future wanted instant", () => {
    // Scanned just now; with a 6h interval and no windows the next scan is now + 6h.
    const at = computeNextScanAt(now, sched({ minIntervalMs: 0 }), now, now);
    assert.equal(at, now + 6 * H);
  });
});
