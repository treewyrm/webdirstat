# 0003 — Scan history & diff

Status: **Proposed**

Prerequisite: [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md),
specifically the persistent store and its generations. The *decide-now* half of
this feature (retain history, don't overwrite-in-place) is called out in 0002's
schema section because it is expensive to retrofit.

## Goal

Answer the question a disk keeps posing on a NAS: **"what changed, and what's
growing?"** Two levels:

1. **Trends** — per-root total bytes / file count over time, so you can see a
   share creeping toward full before it gets there.
2. **Diff** — between two scans, what was **added, removed, grew, or shrank**, so
   "my disk filled up this week" has an answer instead of a manual hunt.

## Why it belongs to 0002 (and why part of it is decide-now)

0002's refresh model already **mints a new generation per scan and atomic-swaps**
it in. The naive implementation then discards the previous generation. That throw
is the only thing standing between "we have history" and "we don't" — and once a
scan is discarded, it's gone.

The decide-now part is **not** *how much* history to keep — that's a config knob
(below) that can legitimately be **zero**. It's only that the store is built
**generation-aware**, and the swap **prunes by a retention policy rather than
unconditionally deleting**. Get that shape right and retention becomes a setting;
get it wrong (overwrite-in-place) and history needs a schema rebuild to add.

## Retention is configuration

How many full generations to keep is an operator setting
(`HISTORY_GENERATIONS`, env-bootstrapped + DB-backed like 0002's other config;
per-root is reasonable — keep history on the important share, not the scratch one):

- **`0`** — keep no full generations. No diff; the live tree only. For users who
  don't want history at all (or are tight on the writable disk the DB lives on).
- **`1`** — keep the previous generation → "diff against last scan," the common
  case, at the cost of one extra ~200–400 MB region.
- **`N`** — keep more for a longer diff baseline; storage grows ~linearly.

The tiny `scan_summary` row (below) is a separate, near-free toggle — default on
even when `HISTORY_GENERATIONS=0`, since it's kilobytes and powers trends/ETA — but
also disable-able for someone who truly wants nothing retained.

## Shape of the change

### Tier 1 — record a summary (tiny, default on)

On every swap, append one row:

```
scan_summary(generation, root_id, ended_ms, total_bytes, total_count, duration_ms)
```

Kilobytes per scan, forever. Enables:

- Trend sparklines / a small chart per root (bytes & count over time).
- A **scan ETA** (this scan's likely duration from prior `duration_ms`), useful in
  the progress UI 0002 already surfaces.
- "Last N scans" freshness history beyond just "last scanned".

Cheap enough to default on even if diff never ships (and even when
`HISTORY_GENERATIONS=0`), but still disable-able for someone who wants nothing
retained at all.

### Tier 2 — retain `HISTORY_GENERATIONS` full generations (enables diff)

When the retention setting is ≥1, keep that many old node tables (not just the
live one) instead of dropping on swap. `GET /api/diff?root&from=<gen>&to=<gen>`
walks the two generations and returns per-path deltas: added / removed / `Δsize`.
Because node identity is **path-stable across generations** (0002's identity
model: path is the durable key, `id` is generation-scoped), pairing nodes between
generations is a path join.

- **Cost is why it's a config knob:** each retained generation is another
  ~200–400 MB DB region for the 2M target. The operator sets the count (incl. `0`),
  so nobody pays for history they don't want.
- Overlaps with the incremental-rescan machinery 0002 defers to v2: move/rename
  detection via `(dev, ino, mtime)` is the same primitive that makes a diff say
  "moved" instead of "removed here + added there".

## Open questions

- **Retention policy shape.** Simple last-K (the `HISTORY_GENERATIONS` count) vs.
  time-based tiering (keep daily for a week, weekly for a month)? Start with a
  plain count; tiering is a later refinement. Confirm the count is **per-root**
  (keep history on the important share, none on scratch) vs. global.
- **Diff granularity.** Full per-node diff is heavy to compute and to render on a
  2M tree; likely cap/aggregate like the tree view (top-N changed per directory,
  with a rolled-up remainder), reusing 0002's `limit` + `omittedTail` shape.
- **Diff visualization.** A separate "changes" list, or overlay the treemap
  (grew = warm, shrank = cool)? The pan/zoom map ([feature 0002](0002-pan-zoom-treemap.md))
  could carry a diff color mode.
- **Interaction with atomic swap under an open camera.** If a diff view pins two
  generations, generation-pinning (0002) already keeps reads consistent; decide
  whether a new scan landing prompts a "newer data available" nudge.

## Recommendation

Build 0002's store **generation-aware with policy-driven pruning** from the first
cut, and default `scan_summary` on (near-free, powers trends/ETA). Keep *how much*
history behind `HISTORY_GENERATIONS` (default low — `1`, "diff against last", is a
sensible starting default; `0` for none). Then **Tier 2 (diff endpoint + UI)** is a
pure follow-up needing no schema change — the store was already built to allow it.

## Decision

Not yet decided — pending discussion. What must be settled before 0002's schema is
frozen is only the **shape** (generation-aware store, prune-by-policy swap, summary
table), not the retention *count* — that's runtime config, `0` included.
