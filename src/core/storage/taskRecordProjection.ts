import type { AppDatabase } from "./db";
import { composedShapeSql, SHAPE_RECORD_TABLES, TaskOwnedShapeStore } from "./taskOwnedShapeStore";

/** Columns whose old copies no longer have write authority after INF-1296. */
export const RETIRED_TASK_COLUMNS = [
  "goal",
  "intent_json",
  "prompt",
  "shape_json",
  "delivery_json",
  "pending_settle_json",
  "session_file",
  "account_id",
  "device_id",
  "placement_json",
  "idle_since",
  "recovery_rung",
  "recovery_count",
  "recovery_at",
  "start_notice",
] as const;

/** The internal compatibility read is derived, never independently writable or published as a new API. */
export function createTaskRecordProjection(db: AppDatabase): void {
  db.exec(`CREATE VIEW task_records AS SELECT t.*, s.goal, s.prompt, s.intent_json,
    CASE WHEN ${SHAPE_RECORD_TABLES.map((table) => `EXISTS(SELECT 1 FROM ${table} WHERE task_id = t.id)`).join(" OR ")}
      THEN ${composedShapeSql("t.id")} ELSE NULL END AS shape_json,
    h.delivery_json, h.pending_settle_json,
    x.session_file, x.account_id, x.device_id, x.placement_json, x.idle_since,
    COALESCE(x.recovery_rung, 0) AS recovery_rung, COALESCE(x.recovery_count, 0) AS recovery_count,
    x.recovery_at, x.start_notice
    FROM tasks t LEFT JOIN task_specifications s ON s.id = t.specification_id
    LEFT JOIN task_record_history h ON h.task_id = t.id
    LEFT JOIN task_execution x ON x.task_id = t.id`);
}

/** Transactional writer switch; all services start only after this completes. */
export function migrateTaskRecordRetirement(db: AppDatabase): void {
  db.exec(`ALTER TABLE task_events ADD COLUMN identity TEXT;
  CREATE UNIQUE INDEX task_events_identity ON task_events(identity);
  CREATE TABLE task_specifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    goal TEXT, prompt TEXT NOT NULL, intent_json TEXT
  );
  CREATE INDEX task_specifications_task ON task_specifications(task_id);
  ALTER TABLE tasks ADD COLUMN specification_id INTEGER REFERENCES task_specifications(id) DEFERRABLE INITIALLY DEFERRED;
  CREATE TABLE task_session_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
    conversation TEXT NOT NULL, file TEXT NOT NULL, computer TEXT, device_id TEXT, provider TEXT,
    model TEXT, account_id TEXT, began TEXT NOT NULL, observed_at INTEGER NOT NULL,
    FOREIGN KEY (task_id, conversation) REFERENCES task_sessions(task_id, conversation) ON DELETE CASCADE
  );
  CREATE INDEX task_session_observations_task ON task_session_observations(task_id, seq);
  CREATE TABLE task_record_history (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    delivery_json TEXT, pending_settle_json TEXT, unreadable_shape TEXT
  );`);
  const identities = db.prepare("UPDATE task_events SET identity = ? WHERE id = ?");
  for (const event of db.prepare("SELECT id, task_id FROM task_events").all() as {
    id: number;
    task_id: string;
  }[])
    identities.run(`task-event:${encodeURIComponent(event.task_id)}:${event.id}`, event.id);
  for (const table of SHAPE_RECORD_TABLES)
    db.exec(
      `CREATE TABLE ${table} (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, value_json TEXT NOT NULL)`,
    );
  const rows = db
    .prepare(
      "SELECT id, goal, prompt, intent_json, shape_json, delivery_json, pending_settle_json FROM tasks",
    )
    .all() as {
    id: string;
    goal: string | null;
    prompt: string;
    intent_json: string | null;
    shape_json: string | null;
    delivery_json: string | null;
    pending_settle_json: string | null;
  }[];
  const insert = db.prepare(
    "INSERT INTO task_specifications (task_id, goal, prompt, intent_json) VALUES (?, ?, ?, ?)",
  );
  const point = db.prepare("UPDATE tasks SET specification_id = ? WHERE id = ?");
  const history = db.prepare("INSERT INTO task_record_history VALUES (?, ?, ?, ?)");
  const shapes = new TaskOwnedShapeStore(db);
  for (const row of rows) {
    point.run(insert.run(row.id, row.goal, row.prompt, row.intent_json).lastInsertRowid, row.id);
    let unreadable: string | null = null;
    try {
      const shape = row.shape_json ? JSON.parse(row.shape_json) : null;
      if (shape && typeof shape === "object" && !Array.isArray(shape))
        shapes.replace(row.id, shape);
      else unreadable = row.shape_json;
    } catch {
      unreadable = row.shape_json;
    }
    history.run(row.id, row.delivery_json, row.pending_settle_json, unreadable);
  }
  db.exec("DROP INDEX IF EXISTS tasks_pending_placement");
  for (const column of RETIRED_TASK_COLUMNS) db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  createTaskRecordProjection(db);
}
