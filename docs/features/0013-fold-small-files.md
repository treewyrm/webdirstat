# 0013 — Fold small files into one tile

Status: **Done** — Model A (server-side data threshold), shipped & verified.

Implemented across the protocol (`minSize` request field + `foldedSmall` response
field, [shared/src/types.ts](../../shared/src/types.ts)), the store
(`childrenOf` folds sub-threshold files disjointly from the count cap,
[nodes.ts](../../server/src/store/nodes.ts)), both routes
([tree.ts](../../server/src/routes/tree.ts), [batch.ts](../../server/src/routes/batch.ts)),
and the client (a `"small"` fold tile in [layout.ts](../../client/src/treemap/layout.ts) /
[color.ts](../../client/src/utils/color.ts), the "Fold small files" knob in
[DisplaySettings.vue](../../client/src/components/DisplaySettings.vue), and
unfold-on-click in [MapTreemap.vue](../../client/src/components/MapTreemap.vue)).
Verified against a fixture: the sub-threshold files never cross the wire, `foldedSmall`
and `omittedTail` are disjoint and sum exactly to `childCount`, directories are never
folded, and `minSize: 0` is byte-identical to pre-0013 behavior.

A directory can hold hundreds of tiny files nobody wants to look at individually.
Fold every child below a user-defined size into a **single synthetic tile** — one
neutral rect that holds their combined area — so the folder view shows the handful
of things that matter instead of a mist of sub-pixel slivers.

This is a **generalization of the mechanism already shipped**: the `omittedTail`
remainder tile (`+N smaller`, [layout.ts](../../client/src/treemap/layout.ts) lines
86–98) already folds a *set* of children into one proportional neutral tile. That
fold is driven by a **count cap** (top-N by size); this feature drives the same tile
shape from a **size threshold**. The two are complementary — a folder typically has
a few big files plus a long tail of tiny ones — and should render as two *distinct*
tiles, not one.

## Today

`/api/tree` and `/api/tree/batch` return a directory's direct children size-sorted
and capped at a `limit`, with an `omittedTail` (`{count, bytes}`) for whatever fell
past the cap ([tree.ts](../../server/src/routes/tree.ts) lines 46–56). The client
squarifies that list and, if a tail is present, appends one remainder tile
([layout.ts](../../client/src/treemap/layout.ts) `layoutInto`). Every child that
*is* in the top-N gets its own tile regardless of how tiny it renders, so a wide
folder is still visually noisy even when each file is a one-pixel sliver.

## The core fork: data threshold vs. render threshold

Decide this first; everything else follows from it.

### A. Data threshold (server-side, bytes or % of parent)

Add an optional `minSize` to the `/api/tree` query and to `TreeBatchRequest`. The
store is indexed `(parent_id, size DESC)` ([schema.ts](../../server/src/store/schema.ts)),
so "children ≥ threshold" is a range scan and "count + bytes of children < threshold"
is a cheap tail aggregate — computed exactly where `childrenOf` already builds
`omittedTail`. Return it as a new field (e.g. `foldedSmall: {count, bytes}`) on
`TreeSlice` / `TreeBatchNode`, rendered as its own tile.

- **Wins:** actually shrinks the payload — the stated motivation; hundreds of tiny
  rows never cross the wire. The fold is stable and cacheable in the client's tile
  LRU.
- **Costs:** protocol change on both sides (`shared/src/types.ts` + both consumers).
  Threshold is camera-independent, so a folded file stays folded however far you zoom
  in — needs an explicit **unfold** affordance (refetch that directory with
  `minSize: 0`).

### B. Render threshold (client-side, pixels)

Fold at layout time: after squarify in `layoutInto`
([layout.ts](../../client/src/treemap/layout.ts) lines 82–116), sweep leaves whose
world rect is below N px² into one "small files" tile.

- **Wins:** no protocol change. **Camera-aware** — zoom in and the same files unfold
  naturally as their rects grow past the threshold. This is the most treemap-native
  behavior (effectively what WinDirStat does), and drill-in is *free* (just zoom).
- **Costs:** doesn't reduce payload — the top-N cap still governs the wire. Can't
  fold what the cap already dropped (though the tail tile still covers that).

**Recommendation: ship B first.** It's small, self-contained, needs no schema churn,
and its drill-in falls out of the existing zoom. Add A later only if payload size
turns out to be a measured problem. The two can also coexist (A trims the wire, B
tidies the frame).

## Sub-decisions (independent of A/B)

- **Files only, or include small directories?** Folding a sub-threshold *directory*
  hides a whole subtree by its aggregate size — sometimes wanted, sometimes
  surprising. Conservative default: fold `kind === "file"` only, preserve directory
  structure. A toggle can come later.
- **Where the setting lives.** This is a **view** preference, not a scan preference,
  so it does **not** belong in `RootSchedule` (that's scan config). A client UI knob
  persisted to `localStorage` is the right home — a natural fit for the display
  settings pane in [0007](0007-display-settings-pane.md). Model A passes it as a
  query param; model B never touches the server.
- **Two distinct tiles.** Keep `omittedTail` (count cap, safety net) and the
  small-files fold as separate tiles with separate tones in
  [color.ts](../../client/src/utils/color.ts). Merging them blurs "past the cap" with
  "below threshold" and muddles the count math the labels report.
- **Label.** Mirror the tail tile's `+N smaller`; e.g. `+N under 1 MB`. Keep the
  count honest (files only, if that's the chosen scope).

## Shape of the change

**Model B (recommended first cut):**

- [layout.ts](../../client/src/treemap/layout.ts): after squarify, fold leaves under
  the px² threshold into one synthetic `WorldNode` (new `kind: "small"`, like the
  existing `"tail"`); it's a dead-end (`children: []`) since zoom is the drill-in.
- [color.ts](../../client/src/utils/color.ts): a tone for the `"small"` kind,
  distinct from the tail tone.
- [App.vue](../../client/src/App.vue) (or the 0007 settings pane): a threshold
  slider/toggle persisted to `localStorage`, passed to the map.

**Model A (if/when added):**

- `shared/src/types.ts`: `minSize` on `TreeBatchRequest`; `foldedSmall` on
  `TreeSlice` / `TreeBatchNode`.
- [tree.ts](../../server/src/routes/tree.ts) + [batch.ts](../../server/src/routes/batch.ts)
  query schemas; the store aggregate alongside `omittedTail`.
- Client: pass `minSize`, render `foldedSmall` as a tile, plus an unfold path
  (refetch with `minSize: 0`).

## Open questions

- **Absolute bytes vs. % of parent?** A fixed 1 MB is huge in a config dir and
  trivial in a video library; a percent-of-parent threshold scales across folders but
  is less predictable. Absolute is simpler to reason about for a first cut.
- **Interaction with the count cap.** With model A a size threshold makes the count
  cap rarely bite; keep the cap as a safety net for folders that are wide *and* all
  large. Confirm the two tiles never double-count the same child.
- **Should the folded tile be clickable at all in model B?** Probably no explicit
  action — zooming already reveals it. Revisit if testing wants an "expand here."

## Decision

**Model A (server-side data threshold).** Chosen over B because the stated
motivation is payload — keeping the long tail of tiny rows off the wire — which
only A delivers; B never touches the protocol. Doing the schema change now settles
it permanently rather than retrofitting `shared/src/types.ts` later.

Settled sub-decisions:

- **Absolute bytes**, not % of parent — simpler to reason about for a first cut
  (the open question above resolves this way).
- **Files only** (`kind === "file"`) — preserve directory structure; folding a
  sub-threshold *directory* would hide a whole subtree by aggregate size. A
  dirs-too toggle can come later.
- **Two distinct tiles** — keep `omittedTail` (count cap) and `foldedSmall` (size
  threshold) as separate tiles with separate tones in
  [color.ts](../../client/src/utils/color.ts); confirm the two never double-count
  the same child.
- **Knob lives in the Display pane** — [DisplaySettings.vue](../../client/src/components/DisplaySettings.vue)
  (feature [0007](0007-display-settings-pane.md), now Done), persisted to
  `localStorage`, passed through as the `minSize` query param.

Accepted consequence — **A is camera-independent**: a folded file stays folded
however far you zoom in. Ship an explicit **unfold-on-click** on the small-files
tile (refetch that directory with `minSize: 0`); do **not** rely on zoom to reveal
folded files. B (camera-aware layout fold) can still be layered on later to also
tidy the frame — the two coexist (A trims the wire, B tidies the frame) — but is
out of scope for this first cut.

Implementation follows "Model A" under **Shape of the change** above.
