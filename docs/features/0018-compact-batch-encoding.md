# 0018 — Compact wire encoding for the batch tile query

Status: **Phase 1 Done** (transport compression) · **Phase 2 Proposed** (binary encoding, deferred)

> **Phase 1 shipped.** Content-negotiated response compression (brotli preferred, gzip
> fallback) is live for every JSON/text response — see
> [http/compression.ts](../../server/src/http/compression.ts), wired in
> [index.ts](../../server/src/index.ts) by wrapping `app.fetch`, env-seeded in
> [config.ts](../../server/src/config.ts) (`COMPRESSION`, `COMPRESSION_QUALITY`,
> `COMPRESSION_MIN_SIZE`). Measured on a 420-file fixture batch: **51 995 → 5 019 bytes
> (~10.4×)** with brotli q5. SSE is excluded; small bodies skip the threshold. Phase 2
> (below) is deferred until measurement on a real multi-million-file share shows the
> compressed batch is still the bottleneck.

On a share with several million files, map navigation over `POST /api/tree/batch`
([routes/batch.ts](../../server/src/routes/batch.ts)) moves a lot of bytes. Each settled
camera frame fires a batch that can return up to the guardrail cap — **20 000 children**
across up to 64 directories — and a fast pan/zoom fires many of them. On a LAN that's
free; over a remote link it's the dominant cost of using the app, and most of it is JSON
structure, not information.

The ask: **make the batch payload smaller on the wire.** This doc argues the order of
operations matters — there's a large, near-free win to take *first* (transport
compression), and a smaller, more expensive win behind it (a bespoke binary encoding).

## What's actually in the payload

The bulk of a [`TreeBatchResponse`](../../shared/src/types.ts#L118) is `nodes` — every
visited directory's children — and each child is a
[`TreeChild`](../../shared/src/types.ts#L15):

```json
{"id":148213,"name":"IMG_20240712_183355.jpg","kind":"file","size":4211233,"childCount":0,"mtimeMs":1720801435000,"ext":"jpg"}
```

Per child, the **keys** (`"id":`, `"name":`, `"kind":`, `"size":`, `"childCount":`,
`"mtimeMs":`, `"ext":`) plus quotes/commas/braces are ~55–60 constant bytes, repeated for
every one of up to 20 000 rows. On top of that:

- `kind` is one of four strings; `"directory"` is 11 bytes to carry 2 bits.
- `ext` is almost always a suffix already present in `name` — carried twice.
- `ext` and `kind` values repeat massively across a response (thousands of `"jpg"`).

So well over half of a batch body is structural overhead and low-entropy repetition — the
exact profile that a general-purpose compressor eats for breakfast.

## Today: responses ship uncompressed

There is **no response compression anywhere** in the stack — no `Content-Encoding`, no
gzip/brotli middleware in [index.ts](../../server/src/index.ts) or any route, and the
Docker image runs the h3 server as a single process on one port with **no reverse proxy**
in front ([Dockerfile](../../Dockerfile)). So every byte described above goes out
verbatim. Nothing is offloading compression for us; if we want it, it has to be in
process.

This is the headline finding: **the traffic the user is seeing is uncompressed JSON.**

## Phase 1 — turn on transport compression (done)

*Implemented as described below.* Decisions made during implementation: intercept at the
fully-normalized web-`Response` boundary by wrapping `app.fetch` (uniform across JSON API,
static SPA, and — excluded — SSE) rather than per-route; async `node:zlib` primitives so
brotli runs on the libuv threadpool and never blocks the event loop; a content-type
allowlist (`text/*` + a set of compressible `application/*`) with `text/event-stream`
explicitly excluded; brotli default quality **5** (env-tunable). On by default because
there is no proxy in the container to do it for us.

Content-negotiated response compression (brotli preferred, gzip fallback) on the JSON API
routes. The browser sends `Accept-Encoding: br, gzip` automatically and transparently
decodes; **zero client changes**, and it applies to *every* endpoint (`/api/tree`,
`/api/search`, `/api/roots/:id/types`, the batch), not just the batch.

- Node 26 ships brotli and gzip in `node:zlib` (`brotliCompressSync`, `gzipSync`), plus
  zstd — but **brotli is the safe default**: universal browser support and best ratio on
  text. Reserve zstd for a later tune (browser support is Chromium-only today).
- Wrap it as one h3 middleware registered after the auth guard: inspect `Accept-Encoding`,
  skip bodies under a threshold (~1 KB), skip already-binary responses, set
  `Content-Encoding` + `Vary: Accept-Encoding`, compress the serialized body.
- **Use a balanced quality, not max.** A NAS CPU compressing 20 000-row bodies on every
  pan frame must not become the bottleneck — brotli quality ~4–5 (or gzip level 6) buys
  most of the ratio for a fraction of the CPU of quality 11. This is a tunable, ideally an
  env knob.
- **Do not compress the SSE stream** (`GET /api/status`) — buffering breaks event
  delivery. Compress discrete JSON responses only.

Expected effect: JSON this repetitive typically compresses **~8–15×**. That very likely
resolves the remote-traffic complaint on its own, at ~a dozen lines and no protocol
change. It's also strictly additive — the binary format below stacks *on top* of it.

Caveat (BREACH-class): compressing a response whose body mixes attacker-controlled input
with a secret can leak the secret. Here the body is file names + sizes and carries no
secret (auth is a cookie, never reflected into the body), so the risk is negligible —
worth a sentence in the code, not a blocker.

## Phase 2 — a compact binary batch encoding (optional, measured)

Only if Phase-1 measurement shows the batch is *still* the pain point. A bespoke binary
encoding of the batch response, negotiated by `Accept`/content-type, kept **strictly
additive** alongside the JSON path.

Where it wins even after compression:

- **Client decode CPU / GC.** Parsing 20 000 objects via `JSON.parse` and rebuilding them
  allocates heavily; on a huge map firing batches during rapid navigation this shows up as
  jank. A tight reader into flat/typed structures is faster and lighter than the compressor
  can make `JSON.parse` be. This — not raw bytes — is often the stronger reason.
- **Lower pre-compression entropy**, so the compressor has less to do and the residual
  after compression is smaller: enum-code `kind` (2 bits), dictionary-code `ext`
  per response, and **drop `ext` entirely when it's the literal suffix of `name`** (a
  1-bit "derive from name" flag), reconstructing it client-side.

Sketch (row-based, one section per directory, LEB128 varints):

- **Header** — magic + format version + `generation`.
- **resolved[]** — count, then per entry either a null flag or
  `{id, kind, size, childCount, path}` (`path` len-prefixed UTF-8).
- **ext dictionary** — the distinct extensions in this response, once.
- **nodes** — directory count; per directory `parentId`, `childCount`, a flags byte
  (`omittedTail`/`foldedSmall` present), optional aggregates, child count, then per child:
  a flags byte (2 bits `kind`; bits for `mtimeMs`/`error` present, `ext` = derive-from-name
  vs. dict-index vs. absent), `id`, `size`, `childCount` as varints, `name` (len + UTF-8),
  and the present optionals. `truncated` in the header flags.
- Consider **delta+zigzag** for `id` and a shared base for `mtimeMs`, but note children are
  size-sorted so ids aren't monotonic in emission order — measure before assuming it helps.

### Costs to weigh honestly

- **Two serializers for one shape.** [shared/src/types.ts](../../shared/src/types.ts) is
  the single contract; JSON stays (it's the debuggable default and every other endpoint
  uses it). A second encoder/decoder for the same shape is drift surface. Mitigate with a
  **golden round-trip test**: encode → decode must equal the JSON path for a fixture set,
  run in the [0017](0017-testing.md) suite.
- **Loses devtools inspectability** of the batch response (JSON path stays available for
  debugging via content negotiation).
- **New client decoder** to write, test, and version — and a `version` byte + graceful
  fallback to JSON when the client is older than the server or vice versa.
- **Marginal byte win over compressed JSON may be modest.** Be disciplined: if Phase-1
  compression already gets the batch under the pain threshold and decode CPU is fine, Phase
  2 may not be worth the permanent maintenance cost. Let the measurement decide.

## Recommendation

1. **Ship Phase 1** (transport compression) and measure real remote traffic + client
   decode time against a multi-million-file fixture. Small, universal, reversible.
2. **Only then** decide on Phase 2. Frame its justification on the *measured residual* —
   both bytes-after-compression and client decode/GC cost — not on the raw-JSON numbers
   that motivated the request, since Phase 1 changes those out from under it.

## Open questions

- **Scope of compression** — batch only, or all JSON routes (recommended: all; it's the
  same middleware and `/api/search` / `/api/tree` benefit too)?
- **Codec + quality knob** — brotli default; expose quality (and later zstd) as env,
  matching the existing `SCAN_*` env-config style in [config.ts](../../server/src/config.ts)?
- **Does Phase 2 survive contact with Phase-1 numbers at all**, and if so is the primary
  goal *bytes* or *client decode CPU*? That choice changes the encoding (bytes → aggressive
  dict/delta; CPU → a layout that reads straight into the client's tile structures with
  minimal allocation).
- **Content negotiation mechanism** for Phase 2 — a custom `Accept: application/x-wds-batch`
  + versioned content-type, with automatic JSON fallback.
```

