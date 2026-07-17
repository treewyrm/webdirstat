import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScanRoot } from "@webdirstat/shared";

export interface ResolvedRoot extends ScanRoot {
  /** Absolute host path this root points to. Never sent to the client. */
  absolutePath: string;
  /**
   * Canonical (symlinks resolved) form of `absolutePath`, used as the
   * containment boundary for traversal checks. Falls back to `absolutePath`
   * if the directory doesn't exist yet at startup.
   */
  canonicalPath: string;
}

function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "root"
  );
}

/**
 * Parses the `ROOTS` env var: `Label1=/path/one,Label2=/path/two`.
 * Falls back to a single root pointing at `/data`, matching a `-v host:/data` mount.
 */
async function parseRoots(raw: string | undefined): Promise<ResolvedRoot[]> {
  const entries = (raw ?? "Data=/data")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const roots: ResolvedRoot[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    const label = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
    const path = separatorIndex === -1 ? entry : entry.slice(separatorIndex + 1);
    if (!path.trim()) continue;

    let id = slugify(label);
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);

    const absolutePath = resolve(path.trim());
    let canonicalPath = absolutePath;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch {
      console.warn(`[webdirstat] root "${label}" (${absolutePath}) does not exist yet`);
    }

    roots.push({ id, label: label.trim() || id, absolutePath, canonicalPath });
  }

  return roots;
}

export interface Config {
  port: number;
  host: string;
  roots: ResolvedRoot[];
  /** Directory containing the built Vue client (index.html + assets). Unset in dev. */
  clientDist: string | undefined;
  /** Path to the SQLite store file. Must be on writable storage, not the scanned share. */
  dbPath: string;
  /** Max concurrent readdir/lstat syscalls per scan (per-root override arrives in M2). */
  scanConcurrency: number;
  /** Retired generations to keep after a swap (`HISTORY_GENERATIONS`; 0 = no history). */
  historyGenerations: number;
}

export async function loadConfig(): Promise<Config> {
  return {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
    roots: await parseRoots(process.env.ROOTS),
    clientDist: process.env.CLIENT_DIST,
    dbPath: process.env.DB_PATH || "./data/webdirstat.db",
    scanConcurrency: Number(process.env.SCAN_CONCURRENCY) || 4,
    historyGenerations: Math.max(0, Number(process.env.HISTORY_GENERATIONS) || 0),
  };
}
