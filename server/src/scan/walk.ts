import { readdir, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Dirent } from "node:fs";
import type { NodeKind } from "@webdirstat/shared";
import { createLimiter } from "./limiter.ts";

/**
 * Sink the walk drives instead of building an in-memory tree. Implemented by the
 * store persister so memory stays O(tree depth), not O(node count): a directory is
 * announced on entry (to mint its id for its children), leaves are streamed as
 * seen, and the directory's precomputed aggregate is written on exit.
 */
export interface WalkSink {
  /** Announce a directory (pre-order). Returns the id children should parent to. */
  enterDir(parentId: number | null, name: string, mtimeMs: number | null): number;
  /** Stream a non-directory entry with its already-known size. */
  leaf(
    parentId: number,
    name: string,
    kind: Exclude<NodeKind, "directory">,
    size: number,
    mtimeMs: number | null,
    error: string | null,
  ): void;
  /** Close a directory with its aggregate size + direct-child count (and read error, if any). */
  exitDir(id: number, size: number, childCount: number, error: string | null): void;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (entries: number, bytes: number, path: string) => void;
  /** Max concurrent readdir/lstat syscalls in flight, across the whole tree. */
  concurrency?: number;
}

export interface ScanResult {
  /** Store id of the root directory node (feeds root_generation.root_node_id). */
  rootNodeId: number;
  entries: number;
  bytes: number;
}

const PROGRESS_INTERVAL_MS = 150;

/**
 * Recursively walks a directory, streaming every entry into `sink` and aggregating
 * sizes bottom-up. Never follows symlinks (they are streamed as zero-size leaves).
 */
export async function scanTree(rootPath: string, sink: WalkSink, options: ScanOptions = {}): Promise<ScanResult> {
  const { signal, onProgress, concurrency = 4 } = options;
  const withLimit = createLimiter(concurrency);

  let entries = 0;
  let bytes = 0;
  let lastReport = 0;

  function tick(path: string) {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress(entries, bytes, path);
  }

  function checkAborted() {
    if (signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
  }

  /** Walks a directory, inserting its row via the sink. Returns its id + aggregate size. */
  async function walkDir(parentId: number | null, absPath: string, name: string): Promise<{ id: number; size: number }> {
    checkAborted();
    entries++;
    const id = sink.enterDir(parentId, name, null);

    let dirents: Dirent[];
    try {
      dirents = await withLimit(() => readdir(absPath, { withFileTypes: true }));
    } catch (error) {
      tick(absPath);
      sink.exitDir(id, 0, 0, (error as NodeJS.ErrnoException).code ?? "EACCES");
      return { id, size: 0 };
    }

    tick(absPath);
    const childSizes = await Promise.all(dirents.map((dirent) => walkEntry(id, absPath, dirent)));
    const size = childSizes.reduce((sum, s) => sum + s, 0);
    sink.exitDir(id, size, dirents.length, null);
    return { id, size };
  }

  /** Walks one directory entry, returning the bytes it contributes to its parent. */
  async function walkEntry(parentId: number, parentAbsPath: string, dirent: Dirent): Promise<number> {
    checkAborted();
    const absPath = join(parentAbsPath, dirent.name);

    if (dirent.isSymbolicLink()) {
      entries++;
      sink.leaf(parentId, dirent.name, "symlink", 0, null, null);
      tick(absPath);
      return 0;
    }

    if (dirent.isDirectory()) {
      return (await walkDir(parentId, absPath, dirent.name)).size;
    }

    if (dirent.isFile()) {
      entries++;
      try {
        const stat = await withLimit(() => lstat(absPath));
        bytes += stat.size;
        sink.leaf(parentId, dirent.name, "file", stat.size, stat.mtimeMs, null);
        tick(absPath);
        return stat.size;
      } catch (error) {
        sink.leaf(parentId, dirent.name, "file", 0, null, (error as NodeJS.ErrnoException).code ?? "ENOENT");
        tick(absPath);
        return 0;
      }
    }

    entries++;
    sink.leaf(parentId, dirent.name, "other", 0, null, null);
    tick(absPath);
    return 0;
  }

  const { id: rootNodeId } = await walkDir(null, rootPath, basename(rootPath) || rootPath);
  onProgress?.(entries, bytes, rootPath);
  return { rootNodeId, entries, bytes };
}
