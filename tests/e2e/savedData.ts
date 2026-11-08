import { join } from "node:path";
import Database from "better-sqlite3";
import { KNOWLEDGE_DB_FILE } from "../../src/core/storage/knowledgeStore";

/**
 * Reads the app's saved data while the app runs (docs/e2e-contracts.md,
 * "One writer once the app runs"). The core is the one writer of
 * `firstmate.db` once it has launched; a spec that opens the stores itself
 * (`openDatabase`, `new TaskService`) becomes a second writer - the service
 * constructor runs boot recovery against the live database. This opens the
 * file read-only with `query_only` on, hands `read` the connection and
 * closes it, so a write is refused by the database itself.
 *
 * Seeding stays what it was: before the first launch, or while the app is
 * stopped, with the stores (`seedTask`, `CardStore`).
 */
export function readSavedData<T>(
  userDataDir: string,
  read: (db: Database.Database) => T,
  file = "firstmate.db",
): T {
  const db = new Database(join(userDataDir, file), { readonly: true });
  try {
    db.pragma("query_only = ON");
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Reads the knowledge collection while the app runs, as `readSavedData` reads
 * `firstmate.db`: the core is its one writer once it has launched, and the
 * file sits in the folder the core keeps it in (`paths.knowledgeDir`).
 */
export function readKnowledgeData<T>(userDataDir: string, read: (db: Database.Database) => T): T {
  return readSavedData(userDataDir, read, join("knowledge", KNOWLEDGE_DB_FILE));
}
