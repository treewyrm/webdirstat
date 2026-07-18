import { opendir, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Dir, Dirent } from "node:fs";
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
  /** Max concurrent opendir/lstat syscalls in flight, across the whole tree. */
  concurrency?: number;
}

export interface ScanResult {
  /** Store id of the root directory node (feeds root_generation.root_node_id). */
  rootNodeId: number;
  entries: number;
  bytes: number;
}

const PROGRESS_INTERVAL_MS = 150;

/** What draining a directory yields: aggregate size, direct-child count, and a read error if one aborted the listing. */
interface DirWalk {
  size: number;
  count: number;
  readError: string | null;
}

/**
 * Drains `dir` one entry at a time (never buffering the whole listing the way
 * `readdir` does, so memory stays O(depth) for the listing too) while running up
 * to `width` child walks concurrently. Reads are strictly sequential — the driver
 * loop is the only caller of `dir.read()`, so no directory-handle locking is
 * needed. `width` only needs headroom above the shared syscall limiter to keep it
 * saturated; the limiter still caps real I/O. Always closes the handle.
 */
async function drainDir(dir: Dir, width: number, fn: (dirent: Dirent) => Promise<number>): Promise<DirWalk> {
  let size = 0;
  let count = 0;
  let readError: string | null = null;
  let abort: unknown = null;
  const inFlight = new Set<Promise<void>>();

  // Child walks fold their bytes into `size` and never reject (abort is captured), so
  // the tracking promises stay settle-only — Promise.race/allSettled see no rejections.
  const run = async (dirent: Dirent): Promise<void> => {
    try {
      const bytes = await fn(dirent);
      size += bytes; // read+write in one tick — `size += await …` would read size *before* the await and lose concurrent updates.
    } catch (error) {
      abort ??= error;
    }
  };

  try {
    while (abort === null) {
      let dirent: Dirent | null;
      try {
        dirent = await dir.read();
      } catch (error) {
        readError = (error as NodeJS.ErrnoException).code ?? "EIO";
        break;
      }
      if (dirent === null) break;
      count++;
      if (inFlight.size >= width) await Promise.race(inFlight);
      const p = run(dirent);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    }
  } finally {
    await Promise.allSettled(inFlight);
    await dir.close().catch(() => {});
  }

  if (abort !== null) throw abort;
  return { size, count, readError };
}

/**
 * Recursively walks a directory, streaming every entry into `sink` and aggregating
 * sizes bottom-up. Never follows symlinks (they are streamed as zero-size leaves).
 */
export async function scanTree(rootPath: string, sink: WalkSink, options: ScanOptions = {}): Promise<ScanResult> {
  const { signal, onProgress, concurrency = 4 } = options;
  const withLimit = createLimiter(concurrency);
  // Per-directory fan-out cap: headroom above `concurrency` (some entries are symlinks/dirs
  // that don't spend an lstat slot) while keeping live promises O(width · depth), not O(width).
  const fanout = Math.max(concurrency * 2, 64);

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

    let dir: Dir;
    try {
      dir = await withLimit(() => opendir(absPath));
    } catch (error) {
      tick(absPath);
      sink.exitDir(id, 0, 0, (error as NodeJS.ErrnoException).code ?? "EACCES");
      return { id, size: 0 };
    }

    tick(absPath);
    const { size, count, readError } = await drainDir(dir, fanout, (dirent) => walkEntry(id, absPath, dirent));
    sink.exitDir(id, size, count, readError);
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
