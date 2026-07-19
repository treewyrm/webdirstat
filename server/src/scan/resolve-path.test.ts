import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ResolvedRoot } from "../config.ts";
import { findRoot, resolveScanPath } from "./resolve-path.ts";

/** Builds a ResolvedRoot over a real directory, resolving canonicalPath like config.ts does. */
async function makeRoot(id: string, absolutePath: string): Promise<ResolvedRoot> {
  return { id, label: id, absolutePath, canonicalPath: await realpath(absolutePath) };
}

/** Runs `fn`, returns the thrown error, or fails if nothing was thrown. */
async function caught(fn: () => Promise<unknown>): Promise<{ status?: number; message?: string }> {
  try {
    await fn();
  } catch (error) {
    return error as { status?: number; message?: string };
  }
  assert.fail("expected the call to throw");
}

describe("resolveScanPath", () => {
  let dir: string; // the root
  let outside: string; // a sibling dir the root must never reach
  let root: ResolvedRoot;

  before(async () => {
    // Both under one temp parent so a symlink can point from inside the root to outside it.
    const parent = await mkdtemp(join(tmpdir(), "wds-resolve-"));
    dir = join(parent, "root");
    outside = join(parent, "outside");
    await mkdir(join(dir, "sub", "deep"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(dir, "file.txt"), "hi");
    await writeFile(join(outside, "secret.txt"), "nope");
    root = await makeRoot("data", dir);
  });

  after(async () => {
    await rm(join(dir, ".."), { recursive: true, force: true });
  });

  test("resolves the root itself for an empty/undefined path", async () => {
    assert.equal(await resolveScanPath(root, ""), root.absolutePath);
    assert.equal(await resolveScanPath(root, undefined), root.absolutePath);
  });

  test("resolves a normal nested subpath", async () => {
    assert.equal(await resolveScanPath(root, "sub/deep"), join(dir, "sub", "deep"));
    assert.equal(await resolveScanPath(root, "file.txt"), join(dir, "file.txt"));
  });

  test("rejects a parent-traversal escape (lexical guard, 403)", async () => {
    const err = await caught(() => resolveScanPath(root, "../outside"));
    assert.equal(err.status, 403);
  });

  test("rejects a deep traversal that climbs back out", async () => {
    const err = await caught(() => resolveScanPath(root, "sub/../../outside"));
    assert.equal(err.status, 403);
  });

  test("rejects an absolute path outside the root", async () => {
    // resolve() treats an absolute segment as the whole path, landing outside the root.
    const err = await caught(() => resolveScanPath(root, outside));
    assert.equal(err.status, 403);
  });

  test("a prefix-sibling directory does not count as inside the root", async () => {
    // `${dir}-evil` shares the root's path as a string prefix; guards against a naive
    // startsWith(absolutePath) that omits the separator.
    const evil = `${dir}-evil`;
    await mkdir(evil, { recursive: true });
    try {
      const err = await caught(() => resolveScanPath(root, "../root-evil"));
      assert.equal(err.status, 403);
    } finally {
      await rm(evil, { recursive: true, force: true });
    }
  });

  test("returns 404 for a non-existent (but in-bounds) path", async () => {
    const err = await caught(() => resolveScanPath(root, "sub/does-not-exist"));
    assert.equal(err.status, 404);
  });

  test("rejects a symlink escaping the root (realpath guard, 403)", async () => {
    // Lexically inside the root, but its realpath lands in `outside`.
    const link = join(dir, "escape");
    await symlink(outside, link);
    try {
      const err = await caught(() => resolveScanPath(root, "escape"));
      assert.equal(err.status, 403);
    } finally {
      await rm(link, { force: true });
    }
  });

  test("allows a symlink that stays inside the root", async () => {
    const link = join(dir, "inward");
    await symlink(join(dir, "sub"), link);
    try {
      // Passes the realpath guard; returns the lexical target (not the resolved one).
      assert.equal(await resolveScanPath(root, "inward"), link);
    } finally {
      await rm(link, { force: true });
    }
  });
});

describe("findRoot", () => {
  const roots: ResolvedRoot[] = [
    { id: "data", label: "Data", absolutePath: "/data", canonicalPath: "/data" },
    { id: "media", label: "Media", absolutePath: "/media", canonicalPath: "/media" },
  ];

  test("finds a root by id", () => {
    assert.equal(findRoot(roots, "media").label, "Media");
  });

  test("throws 404 for an unknown id", () => {
    assert.throws(
      () => findRoot(roots, "nope"),
      (err: { status?: number }) => err.status === 404,
    );
  });
});
