import type { ScanSummary } from "@webdirstat/shared";
import type { ResolvedRoot } from "../config.ts";
import type { Store } from "../store/db.ts";
import { persistScan, type PersistOptions } from "./persist.ts";

/**
 * Enforces the "one scan at a time" invariant. In milestone 1 this is a plain
 * single-flight lock over an in-process scan; milestone 2 grows it into the full
 * observable state machine (idle/scanning/swapping, queue, preempt) behind a worker.
 */
export class ScanRunner {
  private current: { rootId: string; controller: AbortController } | null = null;

  get running(): { rootId: string } | null {
    return this.current ? { rootId: this.current.rootId } : null;
  }

  /** Runs a scan; throws if one is already in flight. */
  async run(
    store: Store,
    root: ResolvedRoot,
    options: Omit<PersistOptions, "signal">,
  ): Promise<ScanSummary> {
    if (this.current) throw new ScanBusyError(this.current.rootId);
    const controller = new AbortController();
    this.current = { rootId: root.id, controller };
    try {
      return await persistScan(store, root.id, root.absolutePath, { ...options, signal: controller.signal });
    } finally {
      this.current = null;
    }
  }

  /** Aborts the running scan, if any. */
  abort(): void {
    this.current?.controller.abort();
  }
}

export class ScanBusyError extends Error {
  constructor(public readonly rootId: string) {
    super(`A scan is already running (root "${rootId}")`);
    this.name = "ScanBusyError";
  }
}
