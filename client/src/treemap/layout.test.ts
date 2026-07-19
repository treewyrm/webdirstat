import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TreeChild } from "@webdirstat/shared";
import { indexById, layoutInto, makeRoot, type WorldNode } from "./layout";

const RECT = { x0: 0, y0: 0, x1: 100, y1: 100 };

/** True if `c`'s rect sits within `p`'s (with a float epsilon). */
function within(c: WorldNode, p: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const e = 1e-6;
  return c.x0 >= p.x0 - e && c.y0 >= p.y0 - e && c.x1 <= p.x1 + e && c.y1 <= p.y1 + e;
}

describe("makeRoot", () => {
  const node = { id: 1, name: "root", kind: "directory" as const, size: 300, childCount: 2 };

  test("defaults to the empty root path with an unloaded interior", () => {
    const root = makeRoot(node, RECT);
    assert.equal(root.path, "");
    assert.equal(root.depth, 0);
    assert.equal(root.children, null);
    assert.deepEqual({ x0: root.x0, y0: root.y0, x1: root.x1, y1: root.y1 }, RECT);
  });

  test("a basePath scopes the world root (feature 0016)", () => {
    assert.equal(makeRoot(node, RECT, "projects/foo").path, "projects/foo");
  });
});

describe("layoutInto", () => {
  const rows: TreeChild[] = [
    { id: 2, name: "dirA", kind: "directory", size: 200, childCount: 3 },
    { id: 3, name: "fileB", kind: "file", size: 100, childCount: 0, ext: "txt" },
  ];

  test("lays every child inside the parent rect and appends the path", () => {
    const root = makeRoot({ id: 1, name: "root", kind: "directory", size: 300, childCount: 2 }, RECT);
    layoutInto(root, rows, undefined);

    assert.equal(root.children?.length, 2);
    const [a, b] = root.children!;
    assert.ok(within(a!, root) && within(b!, root), "children nest within the parent rect");
    assert.deepEqual(
      root.children!.map((c) => c.path),
      ["dirA", "fileB"],
    );
    assert.equal(a!.depth, 1);
  });

  test("path base propagates from a scoped root", () => {
    const root = makeRoot({ id: 1, name: "foo", kind: "directory", size: 300, childCount: 2 }, RECT, "projects/foo");
    layoutInto(root, rows, undefined);
    assert.deepEqual(
      root.children!.map((c) => c.path),
      ["projects/foo/dirA", "projects/foo/fileB"],
    );
  });

  test("non-empty directories stay unloaded (children: null), leaves are terminal ([])", () => {
    const root = makeRoot({ id: 1, name: "root", kind: "directory", size: 300, childCount: 2 }, RECT);
    layoutInto(root, rows, undefined);
    const dir = root.children!.find((c) => c.name === "dirA")!;
    const leaf = root.children!.find((c) => c.name === "fileB")!;
    assert.equal(dir.children, null, "unfetched interior");
    assert.deepEqual(leaf.children, []);
  });

  test("bigger children get more area (squarified, size-sorted)", () => {
    const root = makeRoot({ id: 1, name: "root", kind: "directory", size: 300, childCount: 2 }, RECT);
    layoutInto(root, rows, undefined);
    const area = (n: WorldNode) => (n.x1 - n.x0) * (n.y1 - n.y0);
    const dir = root.children!.find((c) => c.name === "dirA")!;
    const leaf = root.children!.find((c) => c.name === "fileB")!;
    assert.ok(area(dir) > area(leaf), "the 200-byte dir tiles larger than the 100-byte file");
  });

  test("an omitted tail becomes a remainder tile (id -1)", () => {
    const root = makeRoot({ id: 1, name: "root", kind: "directory", size: 350, childCount: 2 }, RECT);
    layoutInto(root, rows, { count: 5, bytes: 50 });
    const tail = root.children!.find((c) => c.kind === "tail");
    assert.ok(tail, "a tail tile is present");
    assert.equal(tail!.id, -1);
    assert.equal(tail!.size, 50);
    assert.match(tail!.name, /\+5/);
  });

  test("a zero-area or zero-size directory lays out empty", () => {
    const flat = makeRoot({ id: 1, name: "root", kind: "directory", size: 0, childCount: 0 }, RECT);
    layoutInto(flat, rows, undefined);
    assert.deepEqual(flat.children, []);
  });
});

describe("indexById", () => {
  test("indexes the root and its loaded children by id", () => {
    const root = makeRoot({ id: 1, name: "root", kind: "directory", size: 300, childCount: 2 }, RECT);
    layoutInto(root, [
      { id: 2, name: "dirA", kind: "directory", size: 200, childCount: 3 },
      { id: 3, name: "fileB", kind: "file", size: 100, childCount: 0 },
    ], undefined);

    const idx = indexById(root);
    // dirA is unloaded (children null), so it's indexed but not descended into.
    assert.deepEqual([...idx.keys()].sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(idx.get(2)!.name, "dirA");
  });
});
