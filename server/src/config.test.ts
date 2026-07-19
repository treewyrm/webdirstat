import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRootSpecs, slugify } from "./config.ts";

describe("slugify", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    assert.equal(slugify("My Data"), "my-data");
    assert.equal(slugify("Backups (2024)"), "backups-2024");
  });

  test("trims leading/trailing dashes", () => {
    assert.equal(slugify("  --Media--  "), "media");
  });

  test("empty / all-punctuation falls back to 'root'", () => {
    assert.equal(slugify(""), "root");
    assert.equal(slugify("!!!"), "root");
  });
});

describe("parseRootSpecs", () => {
  test("defaults to Data=/data when unset", () => {
    assert.deepEqual(parseRootSpecs(undefined), [{ id: "data", label: "Data", path: "/data" }]);
  });

  test("labeled entries: text before the first '=' is the label", () => {
    assert.deepEqual(parseRootSpecs("Photos=/mnt/photos,Media=/mnt/media"), [
      { id: "photos", label: "Photos", path: "/mnt/photos" },
      { id: "media", label: "Media", path: "/mnt/media" },
    ]);
  });

  test("unlabeled entries derive the label from the basename, never the full path", () => {
    const [spec] = parseRootSpecs("/srv/big-share");
    assert.deepEqual(spec, { id: "big-share", label: "big-share", path: "/srv/big-share" });
  });

  test("a path containing '=' after the label separator is preserved", () => {
    assert.deepEqual(parseRootSpecs("Weird=/data/a=b"), [
      { id: "weird", label: "Weird", path: "/data/a=b" },
    ]);
  });

  test("duplicate labels get de-duplicated ids", () => {
    const specs = parseRootSpecs("Data=/one,Data=/two");
    assert.deepEqual(
      specs.map((s) => s.id),
      ["data", "data-2"],
    );
    // Labels stay as given; only the id is disambiguated.
    assert.deepEqual(
      specs.map((s) => s.label),
      ["Data", "Data"],
    );
  });

  test("blank entries and stray whitespace are ignored", () => {
    assert.deepEqual(parseRootSpecs(" A=/a , , B=/b "), [
      { id: "a", label: "A", path: "/a" },
      { id: "b", label: "B", path: "/b" },
    ]);
  });

  test("an entry with a label but empty path is dropped", () => {
    assert.deepEqual(parseRootSpecs("Empty=,Real=/r"), [{ id: "real", label: "Real", path: "/r" }]);
  });
});
