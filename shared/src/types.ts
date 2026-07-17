/** Kind of filesystem entry as reported by the scanner (symlinks are never followed). */
export type NodeKind = "file" | "directory" | "symlink" | "other";

/** A single node in a scanned directory tree. */
export interface ScanNode {
  name: string;
  kind: NodeKind;
  /** Bytes. For directories this is the sum of all descendant sizes. */
  size: number;
  mtimeMs?: number;
  /** Present only for directories; absent for files/symlinks/other. */
  children?: ScanNode[];
  /** Set when a directory could not be fully read (e.g. permission denied). */
  error?: string;
}

/** A configured, scannable root (a mounted share/volume). The real host path never reaches the client. */
export interface ScanRoot {
  id: string;
  label: string;
}

export interface ScanQuery {
  root: string;
  /** Relative subpath within the root, omitted or "" for the root itself. */
  path?: string;
}

export type ScanEvent =
  | { type: "progress"; entries: number; bytes: number; path: string }
  | { type: "done"; tree: ScanNode; entries: number; bytes: number; durationMs: number }
  | { type: "error"; message: string };
