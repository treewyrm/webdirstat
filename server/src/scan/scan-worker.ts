import { parentPort, workerData } from "node:worker_threads";
import type { ScanSummary } from "@webdirstat/shared";
import { Store } from "../store/db.ts";
import { persistScan } from "./persist.ts";

/** Immutable inputs handed to the worker at spawn time. */
export interface ScanWorkerData {
  dbPath: string;
  rootId: string;
  absolutePath: string;
  concurrency: number;
  historyGenerations: number;
}

/** Messages the worker posts back to the main thread. */
export type ScanWorkerMessage =
  | { type: "progress"; entries: number; bytes: number; path: string }
  | { type: "swapping" }
  | { type: "done"; summary: ScanSummary }
  | { type: "aborted" }
  | { type: "error"; message: string };

/** Messages the main thread posts to the worker. */
export type ScanWorkerCommand = { type: "abort" };

const port = parentPort;
if (port) {
  const data = workerData as ScanWorkerData;
  const controller = new AbortController();

  port.on("message", (command: ScanWorkerCommand) => {
    if (command.type === "abort") controller.abort();
  });

  const post = (message: ScanWorkerMessage) => port.postMessage(message);

  // Its own connection: the write transaction never contends with the main
  // thread's reader connection (WAL allows one writer + concurrent readers).
  const store = Store.open(data.dbPath);

  void (async () => {
    try {
      const summary = await persistScan(store, data.rootId, data.absolutePath, {
        signal: controller.signal,
        concurrency: data.concurrency,
        historyGenerations: data.historyGenerations,
        onProgress: (entries, bytes, path) => post({ type: "progress", entries, bytes, path }),
        onSwapping: () => post({ type: "swapping" }),
      });
      post({ type: "done", summary });
    } catch (error) {
      if ((error as Error).name === "AbortError") post({ type: "aborted" });
      else post({ type: "error", message: (error as Error).message });
    } finally {
      store.close();
    }
  })();
}
