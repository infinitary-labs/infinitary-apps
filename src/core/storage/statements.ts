import type { Statement } from "better-sqlite3";
import type { AppDatabase } from "./db";

const compiled = new WeakMap<AppDatabase, Map<string, Statement>>();

/**
 * A statement compiled once per database and reused, for a read the host
 * repeats many times a second. Compiling `SELECT *` on the wide task table
 * costs more than running it: crew status reads each live row on every
 * crew event, and recompiling those reads stalled the main process long
 * enough to delay keystrokes in the message box (INF-683). SQLite
 * recompiles a statement on its own when the schema changes under it.
 * Only for statements run to completion (`get`, `all`, `run`), never one
 * iterated, whose cursor a second caller would share.
 */
export function prepared(db: AppDatabase, sql: string): Statement {
  let statements = compiled.get(db);
  if (!statements) {
    statements = new Map();
    compiled.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}
