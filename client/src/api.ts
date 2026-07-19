import type {
  RootSchedule,
  RootStatus,
  ScannerStatus,
  ScanMode,
  ScanRoot,
  SearchParams,
  SearchResponse,
  TreeBatchRequest,
  TreeBatchResponse,
  TreeSlice,
  TypeRollupResponse,
} from "@webdirstat/shared";

export async function fetchRoots(): Promise<ScanRoot[]> {
  const res = await fetch("/api/roots");
  if (!res.ok) throw new Error(`Failed to load roots: ${res.status}`);
  return res.json() as Promise<ScanRoot[]>;
}

/** Whether a password gate is configured (feature 0001) and whether this client is past it. */
export interface SessionInfo {
  required: boolean;
  authenticated: boolean;
}

/** Probes the gate: `required=false` means the server is open (no `PASSWORD` set). */
export async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
  return res.json() as Promise<SessionInfo>;
}

/** Exchanges the shared password for a session cookie. Throws on a wrong password (401). */
export async function login(password: string): Promise<void> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) throw new Error("Incorrect password");
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
}

/** Clears the session cookie. Best-effort — a failure still drops the client to the gate. */
export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
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
  /** Fold direct files under this many bytes into a `foldedSmall` aggregate (feature 0013). */
  minSize?: number;
}

/** Fetches one directory level (size-sorted, capped) from the store. */
export async function fetchTree(rootId: string, path: string, options: FetchTreeOptions = {}): Promise<TreeSlice> {
  const params = new URLSearchParams({ root: rootId });
  if (path) params.set("path", path);
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.generation != null) params.set("generation", String(options.generation));
  if (options.minSize) params.set("minSize", String(options.minSize));

  const res = await fetch(`/api/tree?${params.toString()}`);
  if (res.status === 404) throw new NotScannedError();
  if (!res.ok) throw new Error(`Failed to load tree: ${res.status}`);
  return res.json() as Promise<TreeSlice>;
}

/**
 * The tile query for map navigation: many directories' children (and optional
 * subtree spines) in one round trip, generation-pinned. Pass an `AbortSignal` to
 * cancel a batch made stale by fast zoom-through.
 */
export async function fetchTreeBatch(
  rootId: string,
  generation: number,
  requests: TreeBatchRequest[],
  signal?: AbortSignal,
): Promise<TreeBatchResponse> {
  const res = await fetch("/api/tree/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: rootId, generation, requests }),
    signal,
  });
  if (res.status === 410) throw new Error("410 Gone: generation swapped out");
  if (!res.ok) throw new Error(`Batch failed: ${res.status}`);
  return res.json() as Promise<TreeBatchResponse>;
}

/** Subscribes to the global scanner state over SSE. Returns an unsubscribe function. */
export function subscribeStatus(onStatus: (status: ScannerStatus) => void): () => void {
  const source = new EventSource("/api/status");
  source.onmessage = (message: MessageEvent<string>) => {
    try {
      onStatus(JSON.parse(message.data) as ScannerStatus);
    } catch (error) {
      console.error("Failed to parse status event", error);
    }
  };
  // The browser auto-reconnects EventSource on transient errors, which is what we want here.
  return () => source.close();
}

/** Starts a manual scan (force; bypasses schedule gates). */
export async function startScan(rootId: string, mode: ScanMode = "queue"): Promise<void> {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: rootId, mode }),
  });
  if (!res.ok) throw new Error(`Failed to start scan: ${res.status}`);
}

/** Stops the running scan (abort + drop staging; leaves the scheduler alone). */
export async function stopScan(): Promise<void> {
  const res = await fetch("/api/scan/stop", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to stop scan: ${res.status}`);
}

export async function fetchRootStatus(rootId: string): Promise<RootStatus> {
  const res = await fetch(`/api/roots/${encodeURIComponent(rootId)}/status`);
  if (!res.ok) throw new Error(`Failed to load status: ${res.status}`);
  return res.json() as Promise<RootStatus>;
}

/**
 * Fetches the space-by-file-type breakdown, pinned to the seeded generation. `path`
 * scopes it to a subtree ("" = the whole root, answered from the precomputed table).
 */
export async function fetchTypes(rootId: string, path = "", generation?: number): Promise<TypeRollupResponse> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (generation != null) params.set("generation", String(generation));
  const query = params.toString();
  const res = await fetch(`/api/roots/${encodeURIComponent(rootId)}/types${query ? `?${query}` : ""}`);
  if (res.status === 404) throw new NotScannedError();
  if (!res.ok) throw new Error(`Failed to load types: ${res.status}`);
  return res.json() as Promise<TypeRollupResponse>;
}

/**
 * Structured file search (feature 0004), generation-pinned and capped. Only the set
 * predicates are sent; an all-empty query is a valid "biggest files" listing. A 404
 * (root never scanned) surfaces as {@link NotScannedError} like the tree read.
 */
export async function fetchSearch(params: SearchParams): Promise<SearchResponse> {
  const q = new URLSearchParams({ root: params.root });
  if (params.scope) q.set("scope", params.scope);
  if (params.path) q.set("path", params.path);
  if (params.minSize != null) q.set("minSize", String(params.minSize));
  if (params.maxSize != null) q.set("maxSize", String(params.maxSize));
  if (params.ext) q.set("ext", params.ext);
  if (params.olderThan != null) q.set("olderThan", String(params.olderThan));
  if (params.newerThan != null) q.set("newerThan", String(params.newerThan));
  if (params.nameLike) q.set("nameLike", params.nameLike);
  if (params.sort) q.set("sort", params.sort);
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.generation != null) q.set("generation", String(params.generation));

  const res = await fetch(`/api/search?${q.toString()}`);
  if (res.status === 404) throw new NotScannedError();
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function fetchSchedule(rootId: string): Promise<RootSchedule> {
  const res = await fetch(`/api/roots/${encodeURIComponent(rootId)}/schedule`);
  if (!res.ok) throw new Error(`Failed to load schedule: ${res.status}`);
  return res.json() as Promise<RootSchedule>;
}

export async function putSchedule(rootId: string, schedule: RootSchedule): Promise<RootSchedule> {
  const res = await fetch(`/api/roots/${encodeURIComponent(rootId)}/schedule`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(schedule),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(`Failed to save schedule: ${res.status} ${message}`);
  }
  return res.json() as Promise<RootSchedule>;
}
