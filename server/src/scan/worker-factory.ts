import { Worker } from "node:worker_threads";
import type { ScanWorkerCommand, ScanWorkerData, ScanWorkerMessage } from "./scan-worker.ts";

/** The subset of a worker_threads Worker the Scanner drives — the DI seam that lets tests inject a fake. */
export interface ScanWorkerHandle {
  postMessage(command: ScanWorkerCommand): void;
  on(event: "message", listener: (message: ScanWorkerMessage) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  terminate(): Promise<number>;
}

/** Spawns one scan worker per walk. Injected into the {@link Scanner} instead of a raw URL. */
export type ScanWorkerFactory = (data: ScanWorkerData) => ScanWorkerHandle;

/**
 * Resolve the scan-worker entry relative to the caller's module URL, picking the extension +
 * execArgv for dev (tsx/.ts) vs. the bundled build (tsdown/.js). `index` sits one level above
 * `scan/` in both layouts, so pass `import.meta.url` of the entry module.
 */
export function resolveWorkerEntry(entryUrl: string): { workerUrl: URL; execArgv: string[] | undefined } {
  const isTs = entryUrl.endsWith(".ts");
  const workerUrl = new URL(`./scan/scan-worker${isTs ? ".ts" : ".js"}`, entryUrl);
  const execArgv = isTs ? ["--import", "tsx"] : undefined;
  return { workerUrl, execArgv };
}

/** The real factory: spawns a `worker_threads` Worker from the resolved entry. */
export function createScanWorkerFactory(entryUrl: string): ScanWorkerFactory {
  const { workerUrl, execArgv } = resolveWorkerEntry(entryUrl);
  return (workerData) => new Worker(workerUrl, { workerData, execArgv });
}
