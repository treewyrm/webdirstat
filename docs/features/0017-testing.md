# 0017 — Testing

Status: **In progress** — tooling wired up; Tier 1 (resolve-path, generations) landed.

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

- One root `test` glob vs. per-workspace `test` scripts (mirroring `typecheck`)? Per-package
  is more consistent with the existing script layout but means three invocations; a single
  root glob is simpler to start. Lean: **single root glob now**, split later if needed.
- Temp-DB helper location — a tiny `server/src/store/testing.ts` (make an in-memory store
  with `schema.ts` applied) is worth extracting so store tests don't each rebuild it.
- Coverage gate in CI, or run-only? Start run-only; a threshold invites gaming a young suite.
