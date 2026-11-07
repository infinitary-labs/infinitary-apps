import type { AppDatabase } from "../../src/core/storage/db";

/**
 * The tables a task's write can reach: its row, the history its delivery
 * column keeps, its change evidence, its permissions, its running work with
 * the turn's declarations, its timeline and the board sequence.
 */
export const TASK_WRITE_TABLES = [
  "tasks",
  "task_record_history",
  "task_delivery_evidence",
  "task_permissions",
  "task_execution",
  "task_events",
  "task_board",
] as const;

/**
 * Every row the database itself inserts, updates or deletes in these
 * tables, read through triggers of the test's own: a write that sets a row
 * to the values it already held still counts, so a test sees what a code
 * path writes and not only what changed.
 */
export function rowWrites(db: AppDatabase, tables: readonly string[] = TASK_WRITE_TABLES) {
  db.exec("CREATE TABLE test_row_writes (tbl TEXT NOT NULL, op TEXT NOT NULL)");
  for (const table of tables)
    for (const op of ["INSERT", "UPDATE", "DELETE"])
      db.exec(
        `CREATE TRIGGER test_writes_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
         BEGIN INSERT INTO test_row_writes (tbl, op) VALUES ('${table}', '${op}'); END`,
      );
  return {
    /** The writes since the last call, as `table OP` in the order the database made them. */
    take(): string[] {
      const rows = db.prepare("SELECT tbl, op FROM test_row_writes ORDER BY rowid").all() as {
        tbl: string;
        op: string;
      }[];
      db.exec("DELETE FROM test_row_writes");
      return rows.map((row) => `${row.tbl} ${row.op}`);
    },
  };
}
