/**
 * The store schema. Kept as one versioned migration list so `PRAGMA user_version`
 * drives forward migrations. The shape is frozen up front for capabilities whose
 * UIs land later (history/diff, search, type rollup) because they are expensive to
 * retrofit — see docs/issues/0002 and docs/features/0003–0005.
 */

/** Bumped when a new migration is appended. Must equal MIGRATIONS.length. */
export const SCHEMA_VERSION = 2;

/**
 * Ordered DDL migrations. Index i upgrades the DB from `user_version === i` to
 * `user_version === i + 1`. Never edit a shipped migration — append a new one.
 */
export const MIGRATIONS: string[] = [
  // 0 → 1: initial schema.
  `
  -- One flat row per filesystem entry. Directory aggregate size + child_count are
  -- precomputed at scan time so reads never recompute. id is a global, opaque,
  -- generation-scoped handle; the durable identity is (root_id, path).
  CREATE TABLE node (
    id           INTEGER PRIMARY KEY,
    generation   INTEGER NOT NULL,
    root_id      TEXT    NOT NULL,
    parent_id    INTEGER,
    name         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime_ms     INTEGER,
    child_count  INTEGER NOT NULL DEFAULT 0,
    ext          TEXT,
    error        TEXT
  );
  -- Children of X, largest first. id is globally unique so parent_id alone is enough.
  CREATE INDEX node_parent_size ON node (parent_id, size DESC);
  -- Age predicates (search, feature 0004).
  CREATE INDEX node_gen_root_mtime ON node (generation, root_id, mtime_ms);
  -- Extension queries (search + type rollup, features 0004/0005).
  CREATE INDEX node_gen_root_ext ON node (generation, root_id, ext, size DESC);

  -- One row per (root, generation). "Current" for a root = the row WHERE state='live'.
  -- Atomic swap flips staging→live and the old live→retired in a single transaction;
  -- retention prune deletes retired generations (and their nodes) beyond the keep count.
  CREATE TABLE root_generation (
    root_id       TEXT    NOT NULL,
    generation    INTEGER NOT NULL,
    root_node_id  INTEGER,
    state         TEXT    NOT NULL,
    created_ms    INTEGER NOT NULL,
    PRIMARY KEY (root_id, generation)
  );
  CREATE INDEX root_generation_state ON root_generation (root_id, state);

  -- Tiny per-swap summary (kilobytes forever): trends + scan ETA. Default on even
  -- when HISTORY_GENERATIONS=0.
  CREATE TABLE scan_summary (
    generation   INTEGER PRIMARY KEY,
    root_id      TEXT    NOT NULL,
    ended_ms     INTEGER NOT NULL,
    total_bytes  INTEGER NOT NULL,
    total_count  INTEGER NOT NULL,
    duration_ms  INTEGER NOT NULL
  );

  -- Per-root ext → {bytes,count}, accumulated in the walk's single pass (feature 0005).
  CREATE TABLE type_rollup (
    generation   INTEGER NOT NULL,
    root_id      TEXT    NOT NULL,
    ext          TEXT    NOT NULL,
    total_bytes  INTEGER NOT NULL,
    total_count  INTEGER NOT NULL,
    PRIMARY KEY (generation, root_id, ext)
  );
  CREATE INDEX type_rollup_bytes ON type_rollup (generation, root_id, total_bytes DESC);

  -- DB-backed per-root config (env-seeded, UI-overridable) + scheduler persistence.
  CREATE TABLE root_settings (
    root_id              TEXT PRIMARY KEY,
    enabled              INTEGER NOT NULL DEFAULT 0,
    concurrency          INTEGER,
    interval_ms          INTEGER,
    windows              TEXT,
    timezone             TEXT,
    min_interval_ms      INTEGER,
    on_window_end        TEXT,
    history_generations  INTEGER,
    last_scan_started_ms INTEGER,
    last_scan_ended_ms   INTEGER,
    last_scan_status     TEXT
  );

  -- Small key/value bag. Holds the global monotonic generation counter.
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO meta (key, value) VALUES ('next_generation', '1');
  `,

  // 1 → 2: search & filter (feature 0004). Additive — no existing data touched.
  `
  -- Whole-root "files larger than N, biggest first" has no index today: node_parent_size
  -- is keyed on parent_id (not root), and node_gen_root_{mtime,ext} aren't size-sorted, so
  -- a pure-size search scans the whole generation. This makes it a range scan. kind is in
  -- the key so the common files-only predicate is satisfied from the index.
  CREATE INDEX node_gen_root_size ON node (generation, root_id, kind, size DESC);

  -- Filename substring search. Standalone (not external-content) fts5 so generation prune
  -- is a plain DELETE and never has to stay in lockstep with the node table. The trigram
  -- tokenizer gives true substring MATCH ('backup' matches 'mybackup.tar'), which the
  -- default prefix/token tokenizer cannot. Populated in the walk's leaf sink for files only
  -- (search targets kind='file'); the UNINDEXED columns scope a MATCH to one (root, gen).
  CREATE VIRTUAL TABLE node_fts USING fts5(
    name,
    node_id     UNINDEXED,
    generation  UNINDEXED,
    root_id     UNINDEXED,
    tokenize = 'trigram'
  );
  `,
];
