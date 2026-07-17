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
