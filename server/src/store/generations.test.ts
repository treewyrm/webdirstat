import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Store } from "./db.ts";
import {
  allocateGeneration,
  currentLiveGeneration,
  dropGeneration,
  isLive,
  prune,
  setRootNode,
  swap,
} from "./generations.ts";

const ROOT = "data";

/** Inserts a placeholder node row so we can prove prune/drop delete node rows too. */
function seedNode(store: Store, generation: number, rootId = ROOT): void {
  store.db
    .prepare(
      "INSERT INTO node (generation, root_id, parent_id, name, kind, size) VALUES (?, ?, NULL, 'root', 'dir', 0)",
    )
    .run(generation, rootId);
}

function nodeCount(store: Store, generation: number, rootId = ROOT): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM node WHERE generation = ? AND root_id = ?")
    .get(generation, rootId) as { n: number };
  return row.n;
}

describe("generation lifecycle", () => {
  let store: Store;

  beforeEach(() => {
    store = Store.open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("allocateGeneration hands out monotonic numbers across roots", () => {
    assert.equal(allocateGeneration(store, "a"), 1);
    assert.equal(allocateGeneration(store, "b"), 2);
    assert.equal(allocateGeneration(store, "a"), 3);
  });

  test("a freshly allocated generation is staging, not live", () => {
    const gen = allocateGeneration(store, ROOT);
    assert.equal(isLive(store, ROOT, gen), false);
    assert.equal(currentLiveGeneration(store, ROOT), undefined);
  });

  test("swap promotes staging to live and demotes the previous live", () => {
    const g1 = allocateGeneration(store, ROOT);
    setRootNode(store, ROOT, g1, 10);
    swap(store, ROOT, g1);
    assert.equal(isLive(store, ROOT, g1), true);
    assert.equal(currentLiveGeneration(store, ROOT), g1);

    const g2 = allocateGeneration(store, ROOT);
    swap(store, ROOT, g2);
    assert.equal(currentLiveGeneration(store, ROOT), g2);
    assert.equal(isLive(store, ROOT, g2), true);
    assert.equal(isLive(store, ROOT, g1), false, "old generation must be retired after swap");
  });

  test("swap is scoped per root", () => {
    const a = allocateGeneration(store, "a");
    const b = allocateGeneration(store, "b");
    swap(store, "a", a);
    // Swapping root a must not touch root b's (still-staging) generation.
    assert.equal(currentLiveGeneration(store, "a"), a);
    assert.equal(currentLiveGeneration(store, "b"), undefined);
    assert.equal(isLive(store, "b", b), false);
  });

  test("dropGeneration discards a staging generation's nodes, leaving live untouched", () => {
    const live = allocateGeneration(store, ROOT);
    seedNode(store, live);
    swap(store, ROOT, live);

    const staging = allocateGeneration(store, ROOT);
    seedNode(store, staging);
    dropGeneration(store, ROOT, staging);

    assert.equal(nodeCount(store, staging), 0, "staging nodes gone");
    assert.equal(nodeCount(store, live), 1, "live nodes untouched");
    assert.equal(currentLiveGeneration(store, ROOT), live);
  });

  test("prune keeps the newest N retired generations and deletes the rest with their nodes", () => {
    const gens: number[] = [];
    // Six successive swaps → generation 6 live, 1..5 retired (newest retired first).
    for (let i = 0; i < 6; i++) {
      const g = allocateGeneration(store, ROOT);
      seedNode(store, g);
      swap(store, ROOT, g);
      gens.push(g);
    }
    const live = gens.at(-1)!;

    prune(store, ROOT, 2); // keep 2 retired generations

    const survivors = store.db
      .prepare("SELECT generation FROM root_generation WHERE root_id = ? ORDER BY generation DESC")
      .all(ROOT) as Array<{ generation: number }>;
    // live (6) + the two newest retired (5, 4).
    assert.deepEqual(
      survivors.map((r) => r.generation),
      [gens[5], gens[4], gens[3]],
    );
    assert.equal(isLive(store, ROOT, live), true, "live generation never pruned");
    assert.equal(nodeCount(store, gens[0]!), 0, "pruned generation's nodes deleted");
    assert.equal(nodeCount(store, live), 1, "live generation's nodes retained");
  });

  test("prune with keep=0 drops all retired generations but never the live one", () => {
    const g1 = allocateGeneration(store, ROOT);
    swap(store, ROOT, g1);
    const g2 = allocateGeneration(store, ROOT);
    swap(store, ROOT, g2); // g1 retired, g2 live

    prune(store, ROOT, 0);

    assert.equal(currentLiveGeneration(store, ROOT), g2);
    const rows = store.db
      .prepare("SELECT generation FROM root_generation WHERE root_id = ?")
      .all(ROOT) as Array<{ generation: number }>;
    assert.deepEqual(
      rows.map((r) => r.generation),
      [g2],
      "only the live generation remains",
    );
  });
});
