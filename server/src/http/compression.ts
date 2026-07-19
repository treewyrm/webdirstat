import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Response-compression settings, seeded from env in [config.ts](../config.ts). */
export interface CompressionConfig {
  /** Master switch. When false the wrapper is a no-op. */
  enabled: boolean;
  /** Brotli quality (0–11). Lower = less CPU; ~5 is a good dynamic-response balance. */
  quality: number;
  /** Don't bother compressing bodies smaller than this many bytes. */
  threshold: number;
}

/**
 * Content types worth compressing. Everything under `text/*` is included by the
 * prefix check below; this set covers the compressible `application/*` types we
 * actually serve. Anything already entropy-coded (images, video, fonts, gzip) is
 * absent on purpose — recompressing it wastes CPU for no gain.
 */
const COMPRESSIBLE = new Set([
  "application/json",
  "application/javascript",
  "application/manifest+json",
  "application/wasm",
  "image/svg+xml",
]);

/** Never buffer-and-compress a stream we must deliver incrementally (SSE). */
const NEVER = new Set(["text/event-stream"]);

function isCompressibleType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (NEVER.has(type)) return false;
  return type.startsWith("text/") || COMPRESSIBLE.has(type);
}

/**
 * Picks an encoding from the client's `Accept-Encoding`. Brotli is preferred
 * (best ratio, universal browser support); gzip is the fallback. We don't parse
 * q-values — a plain presence check matches every real browser and keeps this hot
 * path trivial. Returns `null` when the client accepts neither.
 */
function negotiate(acceptEncoding: string | null): "br" | "gzip" | null {
  if (!acceptEncoding) return null;
  const accept = acceptEncoding.toLowerCase();
  if (accept.includes("br")) return "br";
  if (accept.includes("gzip")) return "gzip";
  return null;
}

/** Whether `Vary` already advertises Accept-Encoding, so we don't duplicate it. */
function varyHasAcceptEncoding(headers: Headers): boolean {
  const vary = headers.get("vary");
  if (!vary) return false;
  return vary
    .split(",")
    .some((token) => token.trim().toLowerCase() === "accept-encoding");
}

/**
 * Content-negotiated response compression, applied at the fully-normalized web
 * `Response` boundary (see [index.ts](../index.ts) — it wraps `app.fetch`). This is
 * feature 0018 Phase 1: the batch tile query (and every other JSON read) ships as
 * raw JSON otherwise, and JSON this structural compresses ~8–15×.
 *
 * Uses the async zlib primitives so brotli runs on the libuv threadpool and never
 * blocks the event loop while a large batch body is compressed — important on a
 * modest NAS CPU serving many requests. Bodies are read fully into memory first, so
 * streamed responses that must stay incremental (SSE) are excluded by content type.
 */
export async function compressResponse(
  request: Request,
  response: Response,
  config: CompressionConfig,
): Promise<Response> {
  if (!config.enabled) return response;
  // No body to compress (204/304/HEAD), or someone already encoded it.
  if (!response.body) return response;
  if (response.headers.has("content-encoding")) return response;
  if (!isCompressibleType(response.headers.get("content-type"))) return response;

  const encoding = negotiate(request.headers.get("accept-encoding"));
  if (!encoding) return response;

  // Small-body fast path: if a Content-Length is already known and under the
  // threshold, skip without consuming the body (no rebuild needed).
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength < config.threshold) {
    return response;
  }

  const raw = Buffer.from(await response.arrayBuffer());

  const headers = new Headers(response.headers);
  if (!varyHasAcceptEncoding(headers)) headers.append("vary", "Accept-Encoding");

  // Below threshold once measured: return the buffered bytes uncompressed (the
  // original body is already consumed, so it must be rebuilt).
  if (raw.byteLength < config.threshold) {
    headers.set("content-length", String(raw.byteLength));
    return new Response(raw, { status: response.status, statusText: response.statusText, headers });
  }

  const compressed =
    encoding === "br"
      ? await brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: config.quality,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
          },
        })
      : await gz(raw, { level: 6 });

  headers.set("content-encoding", encoding);
  headers.set("content-length", String(compressed.byteLength));

  return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
