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
