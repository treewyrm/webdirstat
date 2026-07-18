/** Kind of filesystem entry as reported by the scanner (symlinks are never followed). */
export type NodeKind = "file" | "directory" | "symlink" | "other";

/** A configured, scannable root (a mounted share/volume). The real host path never reaches the client. */
export interface ScanRoot {
  id: string;
  label: string;
}

/**
 * One child row in a directory slice. `id` is a generation-scoped, opaque handle
 * (the store's integer PK) — compact and valid only while its generation is pinned.
 * The durable cross-generation identity is the root + relative path.
 */
export interface TreeChild {
  id: number;
  name: string;
  kind: NodeKind;
  /** Bytes. For directories this is the aggregate of all descendant sizes. */
  size: number;
  /** Number of direct children (directories only; 0 for leaves). */
  childCount: number;
  mtimeMs?: number;
  /** Lowercased extension without the dot; files only (see the split rule). */
  ext?: string;
  /** Set when a directory could not be fully read (e.g. permission denied). */
  error?: string;
}

/** Aggregate of the children past a capped slice's `limit`, so layout can reserve a remainder. */
export interface OmittedTail {
  count: number;
  bytes: number;
}

/** One directory level, size-sorted and capped — the unit the client fetches and browses. */
export interface TreeSlice {
  /** The generation this slice was read from; pin it on subsequent reads. */
  generation: number;
  root: string;
  /** Relative path of the directory this slice describes ("" for the root). */
  path: string;
  /** The directory node itself. */
  node: {
    id: number;
    name: string;
    kind: NodeKind;
    size: number;
    childCount: number;
  };
  /** Direct children, largest first, capped at the request `limit`. */
  children: TreeChild[];
  /** Total direct children (may exceed `children.length` when capped). */
  childCount: number;
  /** Present when the slice was capped: what was left off the tail. */
  omittedTail?: OmittedTail;
}

// --- Batch tile query (POST /api/tree/batch) — the map-navigation fetch ---

/**
 * One anchor in a batch request. Anchored by `parentId` (the common case — you
 * already hold ids from a prior fetch) or by `path` (a cold fly-to from a URL /
 * bookmark with no id yet). `depth` 1 (default) returns just the anchor's
 * children; `depth > 1` returns a size-pruned subtree spine down that many levels.
 */
export interface TreeBatchRequest {
  parentId?: number;
  path?: string;
  limit?: number;
  depth?: number;
}

export interface TreeBatchQuery {
  root: string;
  generation?: number;
  requests: TreeBatchRequest[];
}

/** One directory's children in a batch response (flat, keyed by directory id). */
export interface TreeBatchNode {
  children: TreeChild[];
  childCount: number;
  omittedTail?: OmittedTail;
}

/** The resolved anchor node for a request (so path-anchored fly-tos learn their id). */
export interface TreeBatchResolved {
  id: number;
  path: string;
  kind: NodeKind;
  size: number;
  childCount: number;
}

export interface TreeBatchResponse {
  generation: number;
  /** Per request, in order: the resolved anchor node, or null if it wasn't found. */
  resolved: (TreeBatchResolved | null)[];
  /** Every visited directory's children, keyed by directory id. */
  nodes: Record<string, TreeBatchNode>;
  /** True if a per-response cap stopped the expansion early. */
  truncated?: boolean;
}

// --- File-type (extension) rollup (GET /api/roots/:id/types) — feature 0005 ---

/** One extension's whole-root aggregate, accumulated during the scan walk. */
export interface TypeRollupEntry {
  /** Lowercased extension without the dot; "" is the extension-less bucket. */
  ext: string;
  totalBytes: number;
  totalCount: number;
}

/** Breakdown of space by file type, size-sorted and capped like tree reads. */
export interface TypeRollupResponse {
  /** The generation this rollup was read from (pins with the seeded tree generation). */
  generation: number;
  root: string;
  /** The subtree this breakdown covers ("" = the whole root); echoes the request. */
  path: string;
  /** Extensions, largest first, capped at the request `limit`. */
  types: TypeRollupEntry[];
  /** Present when capped: the extensions (and their bytes) past the cap. */
  omittedTail?: OmittedTail;
}

/** Summary of a completed scan (what the `done` event carries — no tree). */
export interface ScanSummary {
  generation: number;
  root: string;
  entries: number;
  bytes: number;
  durationMs: number;
}

/** SSE events emitted while a manual scan runs (progress + terminal summary/error). */
export type ScanEvent =
  | { type: "progress"; entries: number; bytes: number; path: string }
  | { type: "done"; summary: ScanSummary }
  | { type: "error"; message: string };

// --- Milestone 2: background scanner state, per-root status, schedule ---

/** Why a scan is running: the scheduler, a plain manual start, or a manual preempt. */
export type ScanTrigger = "scheduled" | "manual" | "preempt";

export interface ScanProgress {
  entries: number;
  bytes: number;
  path: string;
}

/**
 * The single global scanner's state, exposed verbatim so the UI is a direct
 * reflection of it. There is one scanner across all roots (scans are serialized).
 */
export type ScannerState =
  | { phase: "idle" }
  | { phase: "scanning"; root: string; startedAt: number; trigger: ScanTrigger; progress: ScanProgress | null }
  | { phase: "swapping"; root: string; startedAt: number; trigger: ScanTrigger };

export interface ScannerStatus {
  state: ScannerState;
  /** Roots waiting behind the running scan, in order. */
  queue: Array<{ root: string; trigger: ScanTrigger }>;
}

/** How a manual scan interacts with an in-flight one. */
export type ScanMode = "queue" | "preempt";

/** A weekly-recurring allowed window, in local wall-clock time (evaluated against `timezone`). */
export interface ScheduleWindow {
  /** Days of week the window applies to, 0=Sunday … 6=Saturday. */
  days: number[];
  /** Local start time "HH:MM". */
  from: string;
  /** Local end time "HH:MM"; may be <= `from` to cross midnight. */
  to: string;
}

/** Per-root schedule + scan config (DB-backed, env-seeded, UI-editable). */
export interface RootSchedule {
  /** Master switch: when false, automatic scans never fire (manual still works). */
  enabled: boolean;
  /** Max concurrent syscalls for this root's walk. */
  concurrency: number;
  /** Max-staleness target; null = no freshness gate (scan whenever a window opens). */
  intervalMs: number | null;
  /** Allowed wall-clock windows; empty = always permitted. */
  windows: ScheduleWindow[];
  /** IANA timezone the windows are evaluated in. */
  timezone: string;
  /** Hard minimum gap between scans. */
  minIntervalMs: number;
  /** What to do if a window closes mid-scan. */
  onWindowEnd: "finish" | "abort";
  /** Retired generations to keep after a swap (0 = no history). */
  historyGenerations: number;
}

/** Per-root facts for the UI: freshness, totals, scheduler state. */
export interface RootStatus {
  root: string;
  /** Live generation, or null if never scanned. */
  generation: number | null;
  lastScanStartedAt: number | null;
  lastScanEndedAt: number | null;
  lastScanStatus: "ok" | "aborted" | "error" | null;
  totalBytes: number | null;
  totalCount: number | null;
  /** Scheduler master switch. */
  enabled: boolean;
  /** Whether an allowed window is open right now. */
  windowOpen: boolean;
  /** When the next automatic scan is expected, or null if none is scheduled. */
  nextScanAt: number | null;
  /** This root's relation to the scanner right now. */
  active: "scanning" | "queued" | null;
}
