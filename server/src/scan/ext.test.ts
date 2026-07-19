import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { splitExt } from "./ext.ts";

describe("splitExt", () => {
  test("takes the last extension, lowercased", () => {
    assert.equal(splitExt("Report.PDF"), "pdf");
    assert.equal(splitExt("archive.tar.gz"), "gz");
    assert.equal(splitExt("photo.JPEG"), "jpeg");
  });

  test("dotfiles have no extension (leading dot)", () => {
    assert.equal(splitExt(".bashrc"), null);
    assert.equal(splitExt(".gitignore"), null);
  });

  test("no dot → null", () => {
    assert.equal(splitExt("Makefile"), null);
    assert.equal(splitExt("README"), null);
  });

  test("a trailing dot → null", () => {
    assert.equal(splitExt("weird."), null);
  });

  test("a dotfile that also has a real extension keeps the last segment", () => {
    assert.equal(splitExt(".config.json"), "json");
  });
});
