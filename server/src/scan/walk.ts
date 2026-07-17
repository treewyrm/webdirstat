import { readdir, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Dirent } from "node:fs";
import type { ScanNode } from "@webdirstat/shared";
import { createLimiter } from "./limiter.ts";

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (entries: number, bytes: number, path: string) => void;
  /** Max concurrent readdir/lstat syscalls in flight, across the whole tree. */
  concurrency?: number;
}

export interface ScanResult {
  tree: ScanNode;
  entries: number;
  bytes: number;
}

const PROGRESS_INTERVAL_MS = 150;

/** Recursively walks a directory, aggregating sizes bottom-up. Never follows symlinks. */
export async function scanTree(rootPath: string, options: ScanOptions = {}): Promise<ScanResult> {
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

  async function walkDir(absPath: string, name: string): Promise<ScanNode> {
    checkAborted();
    entries++;

    let dirents: Dirent[];
    try {
      dirents = await withLimit(() => readdir(absPath, { withFileTypes: true }));
    } catch (error) {
      tick(absPath);
      return { name, kind: "directory", size: 0, error: (error as NodeJS.ErrnoException).code ?? "EACCES" };
    }

    tick(absPath);
    const children = await Promise.all(dirents.map((dirent) => walkEntry(absPath, dirent)));
    const size = children.reduce((sum, child) => sum + child.size, 0);
    children.sort((a, b) => b.size - a.size);

    return { name, kind: "directory", size, children };
  }

  async function walkEntry(parentAbsPath: string, dirent: Dirent): Promise<ScanNode> {
    checkAborted();
    const absPath = join(parentAbsPath, dirent.name);

    if (dirent.isSymbolicLink()) {
      entries++;
      tick(absPath);
      return { name: dirent.name, kind: "symlink", size: 0 };
    }

    if (dirent.isDirectory()) {
      return walkDir(absPath, dirent.name);
    }

    if (dirent.isFile()) {
      entries++;
      try {
        const stat = await withLimit(() => lstat(absPath));
        bytes += stat.size;
        tick(absPath);
        return { name: dirent.name, kind: "file", size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        tick(absPath);
        return { name: dirent.name, kind: "file", size: 0, error: (error as NodeJS.ErrnoException).code ?? "ENOENT" };
      }
    }

    entries++;
    tick(absPath);
    return { name: dirent.name, kind: "other", size: 0 };
  }

  const tree = await walkDir(rootPath, basename(rootPath) || rootPath);
  onProgress?.(entries, bytes, rootPath);

  return { tree, entries, bytes };
}
