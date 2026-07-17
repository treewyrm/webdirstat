import type { ScanEvent, ScanRoot, TreeSlice } from "@webdirstat/shared";

export async function fetchRoots(): Promise<ScanRoot[]> {
  const res = await fetch("/api/roots");
  if (!res.ok) throw new Error(`Failed to load roots: ${res.status}`);
  return res.json() as Promise<ScanRoot[]>;
}

export class NotScannedError extends Error {
  constructor() {
    super("This root has not been scanned yet.");
    this.name = "NotScannedError";
  }
}

export interface FetchTreeOptions {
  limit?: number;
  generation?: number;
}

/** Fetches one directory level (size-sorted, capped) from the store. */
export async function fetchTree(rootId: string, path: string, options: FetchTreeOptions = {}): Promise<TreeSlice> {
  const params = new URLSearchParams({ root: rootId });
  if (path) params.set("path", path);
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.generation != null) params.set("generation", String(options.generation));

  const res = await fetch(`/api/tree?${params.toString()}`);
  if (res.status === 404) throw new NotScannedError();
  if (!res.ok) throw new Error(`Failed to load tree: ${res.status}`);
  return res.json() as Promise<TreeSlice>;
}

export interface ScanHandlers {
  onEvent: (event: ScanEvent) => void;
  onError?: () => void;
}

/** Starts an SSE scan (writes into the store) and returns a function that closes the stream. */
export function startScan(rootId: string, handlers: ScanHandlers): () => void {
  const params = new URLSearchParams({ root: rootId });
  const source = new EventSource(`/api/scan?${params.toString()}`);

  source.onmessage = (message: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(message.data) as ScanEvent;
      handlers.onEvent(payload);
      if (payload.type === "done" || payload.type === "error") source.close();
    } catch (error) {
      console.error("Failed to parse scan event", error);
    }
  };

  source.onerror = () => {
    // Prevent the browser's default auto-reconnect from silently starting a duplicate scan.
    source.close();
    handlers.onError?.();
  };

  return () => source.close();
}
