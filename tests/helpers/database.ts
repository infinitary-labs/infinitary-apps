import { openInMemoryDatabase } from "@core/storage/db";
import { registerViewFunctions } from "@core/storage/views";
import Database from "better-sqlite3";

let migrated: Buffer | undefined;

/**
 * A fresh real SQLite connection for non-migration integration tests. Only the
 * empty migrated image is shared, never a connection or a test's writes.
 * Migration/backfill tests must continue to call openInMemoryDatabase directly.
 */
export function freshDatabase(): Database.Database {
  if (!migrated) {
    const template = openInMemoryDatabase();
    try {
      migrated = template.serialize();
    } finally {
      template.close();
    }
  }
  const db = new Database(migrated);
  // SQLite serialization carries schema/data, not connection-local functions.
  // Keep published views readable just as on openInMemoryDatabase's connection.
  registerViewFunctions(db);
  return db;
}

/**
 * Marks a migrated database as saved by a newer version: one migration past
 * the newest this build applied. Refusal tests read the head from the
 * database itself, so adding the next real migration never turns their
 * "future" version into an ordinary one.
 */
export function recordNewerMigration(db: Database.Database): void {
  const { newest } = db.prepare("SELECT MAX(version) AS newest FROM schema_migrations").get() as {
    newest: number;
  };
  db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(newest + 1);
}

/** How many rows the reads in `read` took from the database, counted where SQLite hands them over. */
export function rowsRead(db: Database.Database, read: () => void): number {
  const statement = Object.getPrototypeOf(db.prepare("SELECT 1")) as {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
  };
  const { all, get } = statement;
  let rows = 0;
  statement.all = function (this: unknown, ...args: unknown[]) {
    const found = all.apply(this, args);
    rows += found.length;
    return found;
  };
  statement.get = function (this: unknown, ...args: unknown[]) {
    const found = get.apply(this, args);
    if (found !== undefined) rows += 1;
    return found;
  };
  try {
    read();
  } finally {
    statement.all = all;
    statement.get = get;
  }
  return rows;
}
