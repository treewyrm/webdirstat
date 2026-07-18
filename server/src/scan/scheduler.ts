import type { RootSchedule } from "@webdirstat/shared";
import type { ResolvedRoot } from "../config.ts";
import type { Store } from "../store/db.ts";
import { scheduleLog } from "../logger.ts";
import { getSchedule, getScanState } from "../store/settings.ts";
import { computeNextScanAt, currentWindowEnd, isWindowOpen } from "./schedule.ts";
import type { Scanner } from "./scanner.ts";

/** Never sleep less than this (avoids a busy loop) or more than this (periodic re-evaluation). */
const MIN_SLEEP_MS = 1000;
const MAX_SLEEP_MS = 3_600_000;

/**
 * Fires scheduled rescans when both gates open (stale past interval AND inside a
 * window), serialized through the single scanner. Implemented as a timer that
 * sleeps to the next relevant instant and recomputes, rather than polling.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly roots: ResolvedRoot[],
    private readonly defaults: RootSchedule,
    private readonly scanner: Scanner,
  ) {}

  start(): void {
    this.stopped = false;
    // Recompute whenever the scanner goes idle (a scan finished → freshness moved).
    this.scanner.onSettled = () => this.tick();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scanner.onSettled = null;
  }

  /** Re-evaluate now (called after a schedule edit via the API). */
  reschedule(): void {
    this.tick();
  }

  private scheduleOf(rootId: string): RootSchedule {
    return getSchedule(this.store, rootId, this.defaults);
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();

    // 1. Enforce onWindowEnd=abort: cut a running scan whose window just closed.
    const runningRoot = this.scanner.runningRoot();
    if (runningRoot) {
      const schedule = this.scheduleOf(runningRoot);
      if (schedule.onWindowEnd === "abort" && !isWindowOpen(now, schedule.windows, schedule.timezone)) {
        scheduleLog.info(`${runningRoot}: window closed, aborting running scan`);
        this.scanner.stop();
      }
    }

    // 2. Dispatch every root that is due now (the scanner serializes them).
    for (const root of this.roots) {
      if (root.id === this.scanner.runningRoot() || this.scanner.isQueued(root.id)) continue;
      const schedule = this.scheduleOf(root.id);
      const state = getScanState(this.store, root.id);
      const nextAt = computeNextScanAt(now, schedule, state.lastScanStartedAt, state.lastScanEndedAt);
      if (nextAt != null && nextAt <= now) {
        scheduleLog.info(`${root.id}: due, queueing scheduled scan`);
        this.scanner.start(root.id, "scheduled", "queue");
      }
    }

    // 3. Sleep to the next relevant instant.
    this.armTimer(now);
  }

  private armTimer(now: number): void {
    let wake = Number.POSITIVE_INFINITY;

    for (const root of this.roots) {
      if (root.id === this.scanner.runningRoot() || this.scanner.isQueued(root.id)) continue;
      const schedule = this.scheduleOf(root.id);
      const state = getScanState(this.store, root.id);
      const nextAt = computeNextScanAt(now, schedule, state.lastScanStartedAt, state.lastScanEndedAt);
      if (nextAt != null && nextAt > now) wake = Math.min(wake, nextAt);
    }

    // Wake at the running window's end if we may need to abort it.
    const runningRoot = this.scanner.runningRoot();
    if (runningRoot) {
      const schedule = this.scheduleOf(runningRoot);
      if (schedule.onWindowEnd === "abort") {
        const end = currentWindowEnd(now, schedule.windows, schedule.timezone);
        if (end != null && end > now) wake = Math.min(wake, end);
      }
    }

    if (this.timer) clearTimeout(this.timer);
    if (wake === Number.POSITIVE_INFINITY) {
      // Nothing scheduled; still re-evaluate periodically as a safety net.
      this.timer = setTimeout(() => this.tick(), MAX_SLEEP_MS);
    } else {
      const delay = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, wake - now));
      this.timer = setTimeout(() => this.tick(), delay);
    }
    this.timer.unref?.();
  }
}
