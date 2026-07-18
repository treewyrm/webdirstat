import type { RootSchedule, ScannerState, ScannerStatus, ScanSummary, ScanTrigger } from "@webdirstat/shared";
import type { ResolvedRoot } from "../config.ts";
import type { Store } from "../store/db.ts";
import { formatBytes, formatDuration, scanLog } from "../logger.ts";
import { getSchedule, recordScanEnd, recordScanStart } from "../store/settings.ts";
import type { ScanWorkerCommand, ScanWorkerData, ScanWorkerMessage } from "./scan-worker.ts";
import type { ScanWorkerFactory, ScanWorkerHandle } from "./worker-factory.ts";

export type StartOutcome = "started" | "queued" | "preempting" | "unknown-root";
export type ScanMode = "queue" | "preempt";

interface QueueEntry {
  rootId: string;
  trigger: ScanTrigger;
}

/** One in-flight worker + the closure guarding against stale/duplicate terminal events. */
interface Running {
  rootId: string;
  startedAt: number;
  trigger: ScanTrigger;
  worker: ScanWorkerHandle;
  settled: boolean;
}

export interface ScannerDeps {
  store: Store;
  dbPath: string;
  scheduleDefaults: RootSchedule;
  roots: ResolvedRoot[];
  /** DI seam: spawns the walk worker. See {@link ScanWorkerFactory}. */
  spawnWorker: ScanWorkerFactory;
}

/**
 * The single global scanner and the "one scan at a time" invariant made structural:
 * there is one worker slot. Additional requests queue; a manual preempt aborts the
 * running scan and jumps the queue. State is exposed verbatim for the UI.
 */
export class Scanner {
  private state: ScannerState = { phase: "idle" };
  private queue: QueueEntry[] = [];
  private running: Running | null = null;
  private readonly roots: Map<string, ResolvedRoot>;
  private readonly listeners = new Set<(status: ScannerStatus) => void>();
  /** Called after every transition to idle, so the scheduler can recompute. */
  onSettled: (() => void) | null = null;

  constructor(private readonly deps: ScannerDeps) {
    this.roots = new Map(deps.roots.map((r) => [r.id, r]));
  }

  status(): ScannerStatus {
    return { state: this.state, queue: this.queue.map((q) => ({ root: q.rootId, trigger: q.trigger })) };
  }

  /** The root currently walking/swapping, or null. */
  runningRoot(): string | null {
    return this.running?.rootId ?? null;
  }

  isQueued(rootId: string): boolean {
    return this.queue.some((q) => q.rootId === rootId);
  }

  subscribe(cb: (status: ScannerStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    const status = this.status();
    for (const cb of this.listeners) cb(status);
  }

  /** Enqueues (dedup by root) unless already at the front for preempt. */
  private enqueue(entry: QueueEntry, front: boolean): void {
    this.queue = this.queue.filter((q) => q.rootId !== entry.rootId);
    if (front) this.queue.unshift(entry);
    else this.queue.push(entry);
  }

  start(rootId: string, trigger: ScanTrigger, mode: ScanMode): StartOutcome {
    if (!this.roots.has(rootId)) return "unknown-root";

    if (!this.running) {
      this.dispatch(rootId, trigger);
      return "started";
    }
    if (mode === "preempt") {
      this.enqueue({ rootId, trigger }, true);
      this.abortCurrent();
      return "preempting";
    }
    this.enqueue({ rootId, trigger }, false);
    this.notify();
    return "queued";
  }

  /** Stops the running walk (abort + drop staging). Does not touch the scheduler or queue behind it. */
  stop(): void {
    this.abortCurrent();
  }

  private abortCurrent(): void {
    if (this.running) this.running.worker.postMessage({ type: "abort" } satisfies ScanWorkerCommand);
  }

  private dispatch(rootId: string, trigger: ScanTrigger): void {
    const root = this.roots.get(rootId)!;
    const schedule = getSchedule(this.deps.store, rootId, this.deps.scheduleDefaults);
    const startedAt = Date.now();
    recordScanStart(this.deps.store, rootId, startedAt);

    const workerData: ScanWorkerData = {
      dbPath: this.deps.dbPath,
      rootId,
      absolutePath: root.absolutePath,
      concurrency: schedule.concurrency,
      historyGenerations: schedule.historyGenerations,
    };
    const worker = this.deps.spawnWorker(workerData);

    const running: Running = { rootId, startedAt, trigger, worker, settled: false };
    this.running = running;
    this.state = { phase: "scanning", root: rootId, startedAt, trigger, progress: null };
    scanLog.start(`${rootId}: scan started (${trigger})`);

    worker.on("message", (msg: ScanWorkerMessage) => this.onMessage(running, msg));
    worker.on("error", (err) => this.settle(running, "error", err.message));
    worker.on("exit", () => {
      // A worker that exits without a terminal message is an unexpected crash.
      if (!running.settled) this.settle(running, "error", "Scan worker exited unexpectedly");
    });

    this.notify();
  }

  private onMessage(running: Running, msg: ScanWorkerMessage): void {
    if (running.settled || this.running !== running) return;
    switch (msg.type) {
      case "progress":
        if (this.state.phase === "scanning") {
          this.state = { ...this.state, progress: { entries: msg.entries, bytes: msg.bytes, path: msg.path } };
          this.notify();
        }
        break;
      case "swapping":
        this.state = { phase: "swapping", root: running.rootId, startedAt: running.startedAt, trigger: running.trigger };
        this.notify();
        break;
      case "done":
        this.settle(running, "ok", undefined, msg.summary);
        break;
      case "aborted":
        this.settle(running, "aborted");
        break;
      case "error":
        this.settle(running, "error", msg.message);
        break;
    }
  }

  private settle(running: Running, status: "ok" | "aborted" | "error", message?: string, summary?: ScanSummary): void {
    if (running.settled) return;
    running.settled = true;
    recordScanEnd(this.deps.store, running.rootId, Date.now(), status);
    void running.worker.terminate();
    if (this.running === running) this.running = null;
    this.logSettle(running, status, message, summary);

    this.state = { phase: "idle" };
    this.notify();
    this.runNext();
    if (this.state.phase === "idle") this.onSettled?.();
  }

  /** One end-of-scan line: success carries the summary, abort/error carry the reason. */
  private logSettle(running: Running, status: "ok" | "aborted" | "error", message?: string, summary?: ScanSummary): void {
    const elapsed = formatDuration(Date.now() - running.startedAt);
    switch (status) {
      case "ok": {
        const stats = summary
          ? `${summary.entries.toLocaleString()} entries, ${formatBytes(summary.bytes)}, gen ${summary.generation}`
          : "no summary";
        scanLog.success(`${running.rootId}: scan done in ${elapsed} (${stats})`);
        break;
      }
      case "aborted":
        scanLog.warn(`${running.rootId}: scan aborted after ${elapsed}`);
        break;
      case "error":
        scanLog.error(`${running.rootId}: scan failed after ${elapsed}${message ? ` — ${message}` : ""}`);
        break;
    }
  }

  private runNext(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (next) this.dispatch(next.rootId, next.trigger);
  }

  /** Aborts any running scan and refuses new ones (shutdown). */
  async shutdown(): Promise<void> {
    this.queue = [];
    if (this.running) {
      const worker = this.running.worker;
      this.running.settled = true;
      this.running = null;
      await worker.terminate();
    }
  }
}
