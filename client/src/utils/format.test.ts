import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatAgo, formatBytes, formatCount, formatUntil } from "./format";

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

describe("formatBytes", () => {
  test("zero and non-positive → '0 B'", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(-5), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
  });

  test("bytes have no decimals", () => {
    assert.equal(formatBytes(512), "512 B");
  });

  test("binary units (KiB/MiB, base 1024)", () => {
    assert.equal(formatBytes(1024), "1.00 KiB");
    assert.equal(formatBytes(1536), "1.50 KiB");
    assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MiB"); // ≥10 → 1 decimal
  });

  test("decimal units (KB/MB, base 1000)", () => {
    assert.equal(formatBytes(1000, "decimal"), "1.00 KB");
    assert.equal(formatBytes(2_500_000, "decimal"), "2.50 MB");
  });

  test("clamps to the largest unit", () => {
    assert.match(formatBytes(1024 ** 7), / PiB$/); // beyond the unit table
  });
});

describe("formatCount", () => {
  test("small counts are unchanged", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(999), "999");
  });

  test("large counts are grouped (separator is locale-dependent, but present)", () => {
    assert.notEqual(formatCount(1_000_000), "1000000");
  });
});

describe("formatAgo", () => {
  test("null → 'never'", () => {
    assert.equal(formatAgo(null), "never");
  });

  test("recent → 'just now'", () => {
    assert.equal(formatAgo(Date.now() - 10_000), "just now");
  });

  test("minutes / hours / days", () => {
    assert.equal(formatAgo(Date.now() - 5 * M), "5m ago");
    assert.equal(formatAgo(Date.now() - 3 * H), "3h ago");
    assert.equal(formatAgo(Date.now() - 2 * D), "2d ago");
  });
});

describe("formatUntil", () => {
  test("null → null", () => {
    assert.equal(formatUntil(null), null);
  });

  test("past → 'due now'", () => {
    assert.equal(formatUntil(Date.now() - 1000), "due now");
  });

  test("minutes / hours / days ahead", () => {
    assert.equal(formatUntil(Date.now() + 5 * M), "in 5m");
    assert.equal(formatUntil(Date.now() + 3 * H), "in 3h");
    assert.equal(formatUntil(Date.now() + 2 * D), "in 2d");
  });
});
