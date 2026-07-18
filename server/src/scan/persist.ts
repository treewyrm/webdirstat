import type { ScanSummary } from "@webdirstat/shared";
import type { Store } from "../store/db.ts";
import {
  allocateGeneration,
  dropGeneration,
  prune,
  setRootNode,
  swap,
} from "../store/generations.ts";
import { NodeWriter, writeScanSummary, writeTypeRollup } from "../store/nodes.ts";
import { splitExt } from "./ext.ts";
import { scanTree, type WalkSink } from "./walk.ts";

export interface PersistOptions {
  signal?: AbortSignal;
  onProgress?: (entries: number, bytes: number, path: string) => void;
  /** Notified when the walk finishes and the atomic swap begins. */
  onSwapping?: () => void;
  concurrency?: number;
  /** Retired generations to keep after the swap (`HISTORY_GENERATIONS`). */
  historyGenerations?: number;
}

/** Commit the open write transaction and reopen a new one every this many ops, so a
 * multi-million-node walk never holds one giant transaction. Staging rows aren't
 * live until the swap, so committing partial staging is invisible to readers. */
const COMMIT_EVERY = 50_000;

/**
 * Runs one full scan of `absolutePath` into a fresh staging generation for `rootId`,
 * then atomically swaps it live and prunes history. On abort/failure the staging
 * generation is dropped and the previous live tree is left untouched.
 */
export async function persistScan(
  store: Store,
  rootId: string,
  absolutePath: string,
  options: PersistOptions = {},
): Promise<ScanSummary> {
  const { signal, onProgress, onSwapping, concurrency = 4, historyGenerations = 0 } = options;
  const startedAt = Date.now();

  const generation = allocateGeneration(store, rootId);
  const writer = new NodeWriter(store, generation, rootId);
  const rollup = new Map<string, { bytes: number; count: number }>();

  let ops = 0;
  const maybeCommit = () => {
    if (++ops % COMMIT_EVERY === 0) {
      store.db.exec("COMMIT");
      store.db.exec("BEGIN");
    }
  };

  const sink: WalkSink = {
    enterDir(parentId, name, mtimeMs) {
      const id = writer.insertDir(parentId, name, mtimeMs, null);
      maybeCommit();
      return id;
    },
    leaf(parentId, name, kind, size, mtimeMs, error) {
      const ext = kind === "file" ? splitExt(name) : null;
      writer.insertLeaf(parentId, name, kind, size, mtimeMs, ext, error);
      if (kind === "file") {
        const key = ext ?? "";
        const acc = rollup.get(key) ?? { bytes: 0, count: 0 };
        acc.bytes += size;
        acc.count += 1;
        rollup.set(key, acc);
      }
      maybeCommit();
    },
    exitDir(id, size, childCount, error) {
      writer.updateDir(id, size, childCount, error);
      maybeCommit();
    },
  };

  store.db.exec("BEGIN");
  let result;
  try {
    result = await scanTree(absolutePath, sink, { signal, onProgress, concurrency });
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    dropGeneration(store, rootId, generation);
    throw error;
  }

  const endedMs = Date.now();
  const durationMs = endedMs - startedAt;

  // Finalize: root pointer, rollup, summary, then the atomic swap + history prune.
  onSwapping?.();
  setRootNode(store, rootId, generation, result.rootNodeId);
  store.transaction(() => writeTypeRollup(store, generation, rootId, rollup));
  writeScanSummary(store, {
    generation,
    rootId,
    endedMs,
    totalBytes: result.bytes,
    totalCount: result.entries,
    durationMs,
  });
  swap(store, rootId, generation);
  prune(store, rootId, Math.max(0, historyGenerations));

  return { generation, root: rootId, entries: result.entries, bytes: result.bytes, durationMs };
}
