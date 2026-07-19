import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { type CompressionConfig, compressResponse } from "./compression.ts";

const on: CompressionConfig = { enabled: true, quality: 5, threshold: 64 };

/** A JSON response big enough to clear the threshold, of a compressible type. */
function jsonResponse(payload: unknown): Response {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json;charset=UTF-8", "content-length": String(body.length) },
  });
}

function request(acceptEncoding?: string): Request {
  const headers = new Headers();
  if (acceptEncoding != null) headers.set("accept-encoding", acceptEncoding);
  return new Request("http://x/api/tree/batch", { method: "POST", headers });
}

/** A payload whose serialized form is comfortably over the threshold. */
const big = { nodes: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `file_${i}.jpg`, kind: "file", size: i * 1000 })) };

describe("compressResponse — negotiation", () => {
  test("prefers brotli when offered, and the body round-trips", async () => {
    const res = await compressResponse(request("gzip, br"), jsonResponse(big), on);
    assert.equal(res.headers.get("content-encoding"), "br");
    const decoded = brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    assert.deepEqual(JSON.parse(decoded), big);
  });

  test("falls back to gzip when brotli isn't offered", async () => {
    const res = await compressResponse(request("gzip, deflate"), jsonResponse(big), on);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    const decoded = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    assert.deepEqual(JSON.parse(decoded), big);
  });

  test("no Accept-Encoding → passes through uncompressed", async () => {
    const res = await compressResponse(request(), jsonResponse(big), on);
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("sets Vary: Accept-Encoding when it compresses", async () => {
    const res = await compressResponse(request("br"), jsonResponse(big), on);
    assert.match(res.headers.get("vary") ?? "", /accept-encoding/i);
  });

  test("reports the compressed length in Content-Length", async () => {
    const res = await compressResponse(request("br"), jsonResponse(big), on);
    const declared = Number(res.headers.get("content-length"));
    const actual = (await res.arrayBuffer()).byteLength;
    assert.equal(declared, actual);
  });
});

describe("compressResponse — exclusions", () => {
  test("disabled config is a no-op", async () => {
    const original = jsonResponse(big);
    const res = await compressResponse(request("br"), original, { ...on, enabled: false });
    assert.equal(res, original);
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("SSE (text/event-stream) is never compressed", async () => {
    const sse = new Response("data: hello\n\n".repeat(50), {
      headers: { "content-type": "text/event-stream" },
    });
    const res = await compressResponse(request("br"), sse, on);
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("already-encoded responses are left alone", async () => {
    const pre = new Response("x".repeat(500), {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    const res = await compressResponse(request("br"), pre, on);
    assert.equal(res, pre);
  });

  test("non-compressible types (e.g. images) pass through", async () => {
    const img = new Response(Buffer.alloc(500), { headers: { "content-type": "image/png" } });
    const res = await compressResponse(request("br"), img, on);
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("bodies under the threshold are not compressed", async () => {
    const small = new Response('{"ok":true}', {
      headers: { "content-type": "application/json", "content-length": "11" },
    });
    const res = await compressResponse(request("br"), small, on);
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("text/* is compressible (covers HTML/CSS/JS SPA assets)", async () => {
    const html = new Response("<!doctype html>" + "<div></div>".repeat(50), {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
    const res = await compressResponse(request("br"), html, on);
    assert.equal(res.headers.get("content-encoding"), "br");
  });
});
