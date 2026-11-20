/** Internal readers of old and current saved profiles share the same column projection. */
export function taskReadTable(db: {
  prepare(sql: string): { get(): unknown };
}): "tasks" | "task_records" {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'task_records'")
    .get()
    ? "task_records"
    : "tasks";
}
