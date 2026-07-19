# 0017 — Testing

Status: **In progress** — tooling wired up; Tiers 1–3 landed (88 tests). Non-goals
(Vue components, HTTP/SSE end-to-end) still open.

Landed so far:
- **Tier 1** — [resolve-path.test.ts](../../server/src/scan/resolve-path.test.ts),
  [generations.test.ts](../../server/src/store/generations.test.ts).
- **Tier 2** — [schedule.test.ts](../../server/src/scan/schedule.test.ts),
  [config.test.ts](../../server/src/config.test.ts) (after extracting the pure
  `parseRootSpecs`/`slugify` out of the FS-touching `loadConfig`),
  [ext.test.ts](../../server/src/scan/ext.test.ts).
- **Tier 3** — [color.test.ts](../../client/src/utils/color.test.ts),
  [format.test.ts](../../client/src/utils/format.test.ts),
  [layout.test.ts](../../client/src/treemap/layout.test.ts).

One wrinkle resolved: the client's `vue-tsc` pass is DOM-only (no `@types/node`), so
client `*.test.ts` (which import `node:test`/`node:assert`) can't be typechecked by the app
config, yet **excluding** them left the editor with no config for those files — the language
server then reports "Cannot find module 'node:test'". Fixed with the `create-vue`-style
**project-reference split** under `client/`:

- [tsconfig.json](../../client/tsconfig.json) — a *solution* file (`files: []`) referencing
  the two real projects. The editor discovers it and routes each file to its owner.
- [tsconfig.app.json](../../client/tsconfig.app.json) — the browser bundle: DOM libs, **no
  Node types**, excludes `*.test.ts`. Verified: app code referencing a Node global (e.g.
  `process`) still fails typecheck, so nothing Node-only leaks into the bundle.
- [tsconfig.test.json](../../client/tsconfig.test.json) — adds `@types/node` on top of the
  DOM libs; owns the test files.

Both are `composite`, so the client `typecheck`/`build` scripts run `vue-tsc --build`
(build-mode is what makes references resolve). Server tests keep full `tsc` coverage since
that workspace already has `@types/node`.

The project has no tests and no working linter — [CLAUDE.md](../../CLAUDE.md) says
`pnpm typecheck` is the only verification. That's fine for shape but catches nothing
about *behavior*: the two path-traversal guards, the atomic generation swap, schedule
window math, deterministic tile colors — all currently unverified except by hand.

Goal: a **lightweight, zero-heavy-framework** test setup that covers the high-value
pure logic and the security-critical paths, runnable in CI and locally with one command,
without pulling in Jest/Vitest/jsdom.

## Approach: `node:test` + `node:assert`, run through `tsx`

Node 24+ (we're on 26) ships a full test runner (`node:test`) and assertion library
(`node:assert/strict`) in core — no dependency, no config, TAP/spec output, `--watch`,
`--test-coverage` built in. That is the whole framework.

The one wrinkle is TypeScript. Rather than rely on native type-stripping (which chokes on
any non-erasable syntax), run the runner through **`tsx`**, which the server already has
as a devDep and already uses for `dev`. Node's `--import tsx` registers the loader so
`node:test` can import `.ts` (and `@webdirstat/shared`'s raw-`.ts` exports, and
`d3-hierarchy`) directly:

```jsonc
// root package.json
"scripts": {
  "test": "node --import tsx --test \"{shared,server,client}/**/*.test.ts\"",
  "test:watch": "node --import tsx --test --watch \"{shared,server,client}/**/*.test.ts\"",
  "test:cov":  "node --import tsx --test --experimental-test-coverage \"{shared,server,client}/**/*.test.ts\""
}
```

Tests live next to their subject as `*.test.ts` (e.g. `server/src/scan/schedule.test.ts`).
No new config files, no `tsconfig` changes — `tsx` reads the existing ones. `tsx` moves
from being a server-only devDep to a root devDep.

**Why not Vitest:** it's the natural fit for a Vite/Vue repo and worth reaching for *if
and when* we want to test Vue components (it brings jsdom/happy-dom + `@vue/test-utils`).
But the highest-value targets here are all framework-free pure functions, and the brief is
explicitly to avoid heavyweight suites. Component testing is deferred (see Non-goals); the
day we want it, add Vitest for the client workspace only — it can coexist with `node:test`
for server/shared.

## What to test (in priority order)

### Tier 1 — security & correctness invariants (must have)

1. **Path-traversal guards** — [resolve-path.ts](../../server/src/scan/resolve-path.ts)
   `resolveScanPath`. The single most important thing to test. Build a `ResolvedRoot`
   over a temp dir (`fs.mkdtemp`) and assert:
   - normal subpaths resolve inside the root;
   - `../` escapes, absolute paths, and `..%2f`-style inputs throw;
   - a symlink pointing outside `canonicalPath` throws the realpath check (create with
     `fs.symlink`);
   - `findRoot` throws on unknown id.
   The same two-layer check in [static/serve.ts](../../server/src/static/serve.ts)
   deserves an equivalent test if its guard is factored out reachably.

2. **Generation lifecycle** — [generations.ts](../../server/src/store/generations.ts)
   against an **in-memory / temp-file `node:sqlite`** store. This is the core
   scan-flow invariant and it's pure store logic, no worker needed:
   - `allocateGeneration` → `setRootNode` → `swap` makes the staging gen live and the old
     gen non-live (`isLive`/`currentLiveGeneration`);
   - `prune`/`dropGeneration` retire past `HISTORY_GENERATIONS` and don't touch the live one;
   - reads against a swapped-out generation are gone (the 410 precondition).
   Use a fresh temp DB per test (real `schema.ts` applied) — these are fast integration
   tests, not "unit" in the strict sense, but they're the ones that catch real bugs.

### Tier 2 — pure algorithm/parse logic (high value, trivial to test)

3. **Schedule math** — [schedule.ts](../../server/src/scan/schedule.ts): `parseDuration`,
   `parseWindows`, `isWindowOpen`, `currentWindowEnd`, `computeNextScanAt`. Pure functions
   over a passed-in `nowMs` + tz — table-driven cases, including tz-boundary and
   window-wrap-past-midnight edges. Zero setup.

4. **Config parsing** — [config.ts](../../server/src/config.ts) `ROOTS` parsing/slugifying
   (`Label1=/p,Label2=/p`, duplicate labels, empty, weird chars). May need a small refactor
   to export the parse/slug helper separately from the async `loadConfig()` (which touches
   the filesystem) — worth doing for testability.

5. **Ext / rollup helpers** — [scan/ext.ts](../../server/src/scan/ext.ts) extension
   extraction (dotfiles, multi-dot, no-ext, case).

### Tier 3 — client pure utils (framework-free, no DOM)

These import cleanly under `node:test` — no Vue, no jsdom:

6. **Deterministic colors** — [color.ts](../../client/src/utils/color.ts): `colorForExt`,
   `colorFor`, `colorByAge` (bounds clamping, the age ramp endpoints), `fillFor` per mode.
   Assert stability (same input → same hex) — that determinism is a documented guarantee.
7. **Formatting** — [format.ts](../../client/src/utils/format.ts): `formatBytes`
   (binary/decimal), `formatCount`, `formatAgo`/`formatUntil` (including `null`).
8. **Treemap layout** — [layout.ts](../../client/src/treemap/layout.ts): `makeRoot` path
   base (`""` vs. a scoped subpath — feature 0016), `layoutInto` producing child world
   rects that nest within the parent and sum sensibly, `indexById` completeness.

### Non-goals (for this pass)

- **Vue component / interaction tests** (MapTreemap camera, tab strip). Needs a DOM
  environment and `@vue/test-utils` — defer to a Vitest add-on if we ever want it.
- **HTTP route / SSE end-to-end tests.** Possible with `node:test` + h3's test utilities
  or a real `listen` on port 0, but it's a bigger lift; revisit after Tier 1–2 land.
- **The scan worker thread** end-to-end. The valuable logic inside it (walk sink,
  persist/swap) is reachable without the worker; test those directly.

## Rollout

1. Add `tsx` as a root devDep; add the `test` scripts above.
2. Land Tier 1 first (resolve-path, generations) — the tests most likely to catch a real
   regression, and they anchor the temp-dir / temp-DB helpers the rest reuse.
3. Add Tier 2 + 3 as pure-function batches.
4. Small refactors for testability where noted (export `config.ts` parse helper).
5. Wire `pnpm test` into CI alongside `pnpm typecheck`, and mention it in
   [CLAUDE.md](../../CLAUDE.md) ("There is no test suite" → the new command).

## Open questions

- ~~One root `test` glob vs. per-workspace scripts?~~ **Decided: single root glob**
  (`node --import tsx --test "{shared,server,client}/**/*.test.ts"`). Split later if needed.
- Temp-DB helper — store tests currently open `Store.open(":memory:")` directly, which is
  enough. Extract a `server/src/store/testing.ts` seeding helper only if node fixtures start
  repeating across files.
- Coverage gate in CI, or run-only? Start run-only (`pnpm test:cov` exists for local use); a
  threshold invites gaming a young suite.
- **CI**: `pnpm test` isn't wired into a CI workflow yet (no workflow exists in-repo). Add it
  alongside `pnpm typecheck` when CI lands.
