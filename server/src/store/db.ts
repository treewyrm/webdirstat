import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

/**
 * The open store handle. `node:sqlite` is synchronous, so every call blocks the
 * event loop briefly — fine for the small, indexed reads the API makes and for the
 * batched writes the scanner does inside a transaction.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (creating parent dirs + file as needed), applies PRAGMAs, and migrates. */
  static open(path: string): Store {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    const db = new DatabaseSync(path);
    // WAL keeps reads non-blocking during the scanner's write transaction; NORMAL
    // is the standard durability/speed trade for WAL; FKs on for parent_id integrity.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");

    migrate(db);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a single transaction, rolling back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/** Applies each pending migration in order, advancing `user_version` as it goes. */
function migrate(db: DatabaseSync): void {
  let version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Store schema is version ${version}, newer than this build supports (${SCHEMA_VERSION}). Refusing to open.`,
    );
  }
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    version++;
  }
}
