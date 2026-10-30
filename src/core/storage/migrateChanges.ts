import { CHANGE_TABLES } from "./changeStore";
import type { AppDatabase } from "./db";
import { TaskStore } from "./taskStore";

/**
 * The change record's first migration (INF-1868 piece 1; `docs/saved-data-compatibility.md`,
 * "The change record"): the tables, and one change for each open task that
 * carries one, read out of its delivery facts exactly as saved. The facts
 * stay where they were and every reader reads them there; the record is a
 * projection until later pieces key the tools to it.
 */
export function migrateChanges(db: AppDatabase): void {
  db.exec(CHANGE_TABLES);
  const store = new TaskStore(db);
  for (const task of store.list()) store.changes.project(task);
}
