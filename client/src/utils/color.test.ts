import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AGE_RAMP,
  type Colorable,
  colorByAge,
  colorByFolder,
  colorFor,
  colorForExt,
  fillFor,
  SMALL_TILE_COLOR,
} from "./color";

const HEX = /^#[0-9a-f]{6}$/i;
const file = (name: string, over: Partial<Colorable> = {}): Colorable => ({ kind: "file", name, ...over });

describe("colorForExt", () => {
  test("is deterministic per extension", () => {
    assert.equal(colorForExt("pdf"), colorForExt("pdf"));
  });

  test("the empty (extension-less) tone is fixed", () => {
    assert.equal(colorForExt(""), "#8a8f99");
  });

  test("always returns a hex color", () => {
    for (const ext of ["ts", "png", "tar", "zzz"]) assert.match(colorForExt(ext), HEX);
  });
});

describe("colorFor", () => {
  test("fixed neutral tones for non-file kinds", () => {
    assert.equal(colorFor({ kind: "directory", name: "src" }), "#3a3f4b");
    assert.equal(colorFor({ kind: "symlink", name: "link" }), "#6b6f7a");
    assert.equal(colorFor({ kind: "other", name: "dev" }), "#4a4e58");
    assert.equal(colorFor({ kind: "small", name: "fold" }), SMALL_TILE_COLOR);
  });

  test("errored nodes get the error tone regardless of kind", () => {
    assert.equal(colorFor({ kind: "directory", name: "denied", error: "EACCES" }), "#5b1f22");
  });

  test("files are colored by extension (from the name)", () => {
    assert.equal(colorFor(file("Report.PDF")), colorForExt("pdf"));
    // Case-insensitive: extension is lowercased before hashing.
    assert.equal(colorFor(file("a.PNG")), colorFor(file("b.png")));
  });
});

describe("colorByAge", () => {
  const bounds = { min: 0, max: 100 * 86_400_000 };
  const now = 200 * 86_400_000;

  test("no mtime → the flat unknown tone", () => {
    assert.equal(colorByAge(undefined, bounds, now), "#4a4e58");
  });

  test("newest maps to the bright ramp end, oldest to the dark end", () => {
    assert.equal(colorByAge(bounds.max, bounds, now), AGE_RAMP.at(-1)); // newest → bright
    assert.equal(colorByAge(bounds.min, bounds, now), AGE_RAMP[0]); // oldest → dark
  });

  test("is deterministic and always hex", () => {
    const mid = 50 * 86_400_000;
    assert.equal(colorByAge(mid, bounds, now), colorByAge(mid, bounds, now));
    assert.match(colorByAge(mid, bounds, now), HEX);
  });
});

describe("fillFor", () => {
  const bounds = { min: 0, max: 100 };

  test("age mode colors plain files by mtime", () => {
    const f = file("x.txt", { mtimeMs: 50 });
    assert.equal(fillFor(f, "age", bounds), colorByAge(50, bounds));
  });

  test("age mode leaves directories on their type tone", () => {
    const dir: Colorable = { kind: "directory", name: "src" };
    assert.equal(fillFor(dir, "age", bounds), colorFor(dir));
  });

  test("errored files fall back to the type/error tone even in age mode", () => {
    const f = file("bad.txt", { error: "EACCES", mtimeMs: 50 });
    assert.equal(fillFor(f, "age", bounds), colorFor(f));
  });

  test("type mode (or no bounds) always uses colorFor", () => {
    const f = file("x.txt", { mtimeMs: 50 });
    assert.equal(fillFor(f, "type", bounds), colorFor(f));
    assert.equal(fillFor(f, "age", null), colorFor(f));
  });

  test("folder mode colors siblings by their shared containing folder", () => {
    const a = file("a.txt", { path: "src/lib/a.txt" });
    const b = file("b.txt", { path: "src/lib/b.txt" });
    const other = file("c.txt", { path: "src/util/c.txt" });
    assert.equal(fillFor(a, "folder", null), fillFor(b, "folder", null));
    assert.notEqual(fillFor(a, "folder", null), fillFor(other, "folder", null));
    assert.equal(fillFor(a, "folder", null), colorByFolder("src/lib/a.txt"));
  });

  test("folder mode leaves errored tiles on the error tone", () => {
    const f = file("bad.txt", { error: "EACCES", path: "src/bad.txt" });
    assert.equal(fillFor(f, "folder", null), colorFor(f));
  });
});
