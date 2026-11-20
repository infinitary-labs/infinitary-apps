import { z } from "zod";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import type { TaskEventActor } from "./taskEventStore";
import { TASK_REFERENCE_KINDS, type TaskReferenceKind } from "./taskReferenceFields";

export {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReferenceKind,
} from "./taskReferenceFields";

export const taskReferenceSchema = z.object({
  kind: z.enum(TASK_REFERENCE_KINDS),
  /** The task as it was named, a key or an id, exactly as the shape kept it. */
  ref: z.string(),
  /** The task the name resolved to when it was recorded; null when it named none. */
  targetId: z.string().nullable(),
  /** Who recorded it; null on a reference saved before relationships were recorded. */
  actor: z.enum(["captain", "firstmate", "crewmate", "supervisor", "host"]).nullable(),
  /** When it was recorded; null on a reference saved before relationships were recorded. */
  recordedAt: z.number().nullable(),
});
export type TaskReference = z.infer<typeof taskReferenceSchema>;

type Row = {
  task_id: string;
  kind: TaskReferenceKind;
  ref: string;
  target_id: string | null;
  actor: TaskEventActor | null;
  recorded_at: number | null;
};

function fromRow(row: Row): TaskReference {
  return {
    kind: row.kind,
    ref: row.ref,
    targetId: row.target_id,
    actor: row.actor,
    recordedAt: row.recorded_at,
  };
}

/** Only TaskService writes this table, through its relationship operations. */
export class TaskReferenceStore {
  private present = false;

  constructor(private readonly db: AppDatabase) {}

  /** Whether this database has the table yet; migration tests read an older schema. */
  private exists(): boolean {
    this.present ||= Boolean(
      prepared(
        this.db,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_references'",
      ).get(),
    );
    return this.present;
  }

  /** Replaces the task's reference of that kind. */
  set(taskId: string, reference: TaskReference): void {
    prepared(
      this.db,
      `INSERT INTO task_references (task_id, kind, ref, target_id, actor, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, kind) DO UPDATE SET
         ref = excluded.ref, target_id = excluded.target_id,
         actor = excluded.actor, recorded_at = excluded.recorded_at`,
    ).run(
      taskId,
      reference.kind,
      reference.ref,
      reference.targetId,
      reference.actor,
      reference.recordedAt,
    );
  }

  delete(taskId: string, kind: TaskReferenceKind): boolean {
    return (
      prepared(this.db, "DELETE FROM task_references WHERE task_id = ? AND kind = ?").run(
        taskId,
        kind,
      ).changes === 1
    );
  }

  /** A task's references, in `TASK_REFERENCE_KINDS` order. */
  list(taskId: string): TaskReference[] {
    if (!this.exists()) return [];
    const rows = prepared(this.db, "SELECT * FROM task_references WHERE task_id = ?").all(
      taskId,
    ) as Row[];
    return rows.map(fromRow).sort(byKind);
  }

  /** The references of each of these tasks, by task id. */
  listFor(taskIds: readonly string[]): Map<string, TaskReference[]> {
    const byTask = new Map<string, TaskReference[]>();
    if (taskIds.length === 0 || !this.exists()) return byTask;
    const rows = prepared(
      this.db,
      "SELECT * FROM task_references WHERE task_id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(taskIds)) as Row[];
    for (const row of rows) {
      const list = byTask.get(row.task_id) ?? [];
      list.push(fromRow(row));
      byTask.set(row.task_id, list);
    }
    for (const list of byTask.values()) list.sort(byKind);
    return byTask;
  }

  /**
   * The other tasks whose reference of this kind names this one by its id or
   * its key, as `TaskService.resolve` reads a name: an id exactly, a key in
   * any case. The answer-delivery sweep reads it for every task a message
   * covers, so it seeks the name through `task_references_name`
   * (queryIndexes.ts) instead of walking every reference (INF-2971's first
   * finding); the exact id comparison then runs on the rows it found.
   */
  taskIdsNaming(kind: TaskReferenceKind, id: string, key: string | null): string[] {
    if (!this.exists()) return [];
    const named = (key ?? "").toUpperCase();
    const rows = prepared(
      this.db,
      `SELECT task_id, trim(ref) AS trimmed, upper(trim(ref)) AS named FROM task_references
       WHERE kind = ? AND upper(trim(ref)) IN (upper(?), ?) AND task_id != ?`,
    ).all(kind, id, named, id) as { task_id: string; trimmed: string; named: string }[];
    return rows
      .filter((row) => row.trimmed === id || (named !== "" && row.named === named))
      .map((row) => row.task_id);
  }

  deleteFor(taskId: string): void {
    if (!this.exists()) return;
    prepared(this.db, "DELETE FROM task_references WHERE task_id = ?").run(taskId);
  }

  deleteAll(): void {
    if (!this.exists()) return;
    this.db.prepare("DELETE FROM task_references").run();
  }
}

function byKind(a: TaskReference, b: TaskReference): number {
  return TASK_REFERENCE_KINDS.indexOf(a.kind) - TASK_REFERENCE_KINDS.indexOf(b.kind);
}
