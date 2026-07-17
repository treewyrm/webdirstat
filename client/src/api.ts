import type { ScanEvent, ScanRoot } from "@webdirstat/shared";

export async function fetchRoots(): Promise<ScanRoot[]> {
  const res = await fetch("/api/roots");
  if (!res.ok) throw new Error(`Failed to load roots: ${res.status}`);
  return res.json() as Promise<ScanRoot[]>;
}

export interface ScanHandlers {
  onEvent: (event: ScanEvent) => void;
  onError?: () => void;
}

/** Starts an SSE scan and returns a function that cancels it. */
export function startScan(rootId: string, path: string, handlers: ScanHandlers): () => void {
  const params = new URLSearchParams({ root: rootId });
  if (path) params.set("path", path);
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
