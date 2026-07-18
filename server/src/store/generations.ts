import type { Store } from "./db.ts";

export type GenerationState = "staging" | "live" | "retired";

/**
 * Allocates the next global generation number and records a fresh `staging` row
 * for the root. The number is monotonic across all roots so ids never collide.
 */
export function allocateGeneration(store: Store, rootId: string): number {
  const { db } = store;
  return store.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'next_generation'").get() as
      | { value: string }
      | undefined;
    const generation = Number(row?.value ?? "1");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'next_generation'").run(String(generation + 1));
    db.prepare(
      "INSERT INTO root_generation (root_id, generation, root_node_id, state, created_ms) VALUES (?, ?, NULL, 'staging', ?)",
    ).run(rootId, generation, Date.now());
    return generation;
  });
}

/**
 * Drops a generation entirely (its node rows, type rollup, and pointer row). Used
 * to discard a staging generation after an aborted or failed scan — the live tree
 * is never touched.
 */
export function dropGeneration(store: Store, rootId: string, generation: number): void {
  store.transaction(() => {
    store.db.prepare("DELETE FROM node WHERE generation = ? AND root_id = ?").run(generation, rootId);
    store.db.prepare("DELETE FROM type_rollup WHERE generation = ? AND root_id = ?").run(generation, rootId);
    store.db.prepare("DELETE FROM root_generation WHERE root_id = ? AND generation = ?").run(rootId, generation);
  });
}

/** The live generation number for a root, or undefined if it has never been scanned. */
export function currentLiveGeneration(store: Store, rootId: string): number | undefined {
  const row = store.db
    .prepare("SELECT generation FROM root_generation WHERE root_id = ? AND state = 'live'")
    .get(rootId) as { generation: number } | undefined;
  return row?.generation;
}

/** True if the given (root, generation) is currently the live one. */
export function isLive(store: Store, rootId: string, generation: number): boolean {
  const row = store.db
    .prepare("SELECT state FROM root_generation WHERE root_id = ? AND generation = ?")
    .get(rootId, generation) as { state: GenerationState } | undefined;
  return row?.state === "live";
}

/** Records the top node id for a staged generation (called once the root dir is inserted). */
export function setRootNode(store: Store, rootId: string, generation: number, rootNodeId: number): void {
  store.db
    .prepare("UPDATE root_generation SET root_node_id = ? WHERE root_id = ? AND generation = ?")
    .run(rootNodeId, rootId, generation);
}

/**
 * Atomically promotes `stagingGen` to `live` and demotes the previous live
 * generation to `retired`, in one transaction. Reads never see a half-swapped
 * store: before the commit they see the old live tree, after it the new one.
 */
export function swap(store: Store, rootId: string, stagingGen: number): void {
  store.transaction(() => {
    store.db
      .prepare("UPDATE root_generation SET state = 'retired' WHERE root_id = ? AND state = 'live'")
      .run(rootId);
    store.db
      .prepare("UPDATE root_generation SET state = 'live' WHERE root_id = ? AND generation = ?")
      .run(rootId, stagingGen);
  });
}

/**
 * Deletes retired generations for a root beyond the newest `keep`, dropping their
 * node rows and type rollups (scan_summary rows are tiny and kept forever for
 * trends). `keep = 0` drops every retired generation → "no history".
 */
export function prune(store: Store, rootId: string, keep: number): void {
  const retired = store.db
    .prepare(
      "SELECT generation FROM root_generation WHERE root_id = ? AND state = 'retired' ORDER BY generation DESC",
    )
    .all(rootId) as Array<{ generation: number }>;

  const doomed = retired.slice(Math.max(0, keep));
  if (doomed.length === 0) return;

  store.transaction(() => {
    for (const { generation } of doomed) {
      store.db.prepare("DELETE FROM node WHERE generation = ? AND root_id = ?").run(generation, rootId);
      store.db.prepare("DELETE FROM type_rollup WHERE generation = ? AND root_id = ?").run(generation, rootId);
      store.db.prepare("DELETE FROM root_generation WHERE root_id = ? AND generation = ?").run(rootId, generation);
    }
  });
}
