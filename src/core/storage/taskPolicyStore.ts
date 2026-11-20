import { repoDeliverySchema } from "@shared/repos";
import { rigorSchema } from "@shared/rigor";
import type { WorkShape } from "@shared/routingPolicy";
import { taskPolicyStateSchema } from "@shared/taskPolicies";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import { POLICY_SHAPE_FIELDS, policyShapeFields, type TaskPolicyRow } from "./taskPolicyFields";

export { POLICY_SHAPE_FIELDS, type PolicyShapeField } from "./taskPolicyFields";

/** A shape field's value is a policy input only when its type is the one the shape declares. */
const POLICY_SCHEMAS = {
  delivery_ask: repoDeliverySchema,
  autonomy_ask: { safeParse: (value: unknown) => ({ success: typeof value === "boolean" }) },
  rigor_ask: rigorSchema,
  policies: taskPolicyStateSchema,
} as const;

/**
 * A shape split into what the shape column keeps and the policy row it
 * names (INF-1296 piece 3). A value of another type than the field
 * declares is not a policy input: it stays in the shape as it was saved,
 * where every reader met it before. Each moved value is kept exactly as
 * saved, so a live edit keeps any field this build does not know.
 */
export function splitPolicies(shape: WorkShape | null | undefined): {
  shape: WorkShape | null;
  row: Omit<TaskPolicyRow, "task_id"> | null;
} {
  if (!shape) return { shape: shape ?? null, row: null };
  const kept: Record<string, unknown> = { ...shape };
  const row: Omit<TaskPolicyRow, "task_id"> = {
    delivery_ask: null,
    autonomy_ask: null,
    rigor_ask: null,
    edits_json: null,
  };
  let named = false;
  for (const field of POLICY_SHAPE_FIELDS) {
    const value = kept[field];
    if (value === undefined || !POLICY_SCHEMAS[field].safeParse(value).success) continue;
    delete kept[field];
    named = true;
    if (field === "delivery_ask") row.delivery_ask = value as string;
    else if (field === "autonomy_ask") row.autonomy_ask = value ? 1 : 0;
    else if (field === "rigor_ask") row.rigor_ask = value as string;
    else row.edits_json = JSON.stringify(value);
  }
  return { shape: kept as WorkShape, row: named ? row : null };
}

/** A shape as it is read: the stored fields, and each policy input under its shape field. */
export function withPolicies(
  shape: WorkShape | null,
  row: TaskPolicyRow | undefined,
): WorkShape | null {
  if (!shape || !row) return shape;
  return { ...shape, ...policyShapeFields(row) } as WorkShape;
}

/**
 * A task's policy inputs. Only TaskStore writes this table, beneath
 * TaskService: a shape write replaces them with what the shape names, as
 * the shape column did before them.
 */
export class TaskPolicyStore {
  private present = false;

  constructor(private readonly db: AppDatabase) {}

  /** Whether this database has the table yet; migration tests read an older schema. */
  exists(): boolean {
    this.present ||= Boolean(
      prepared(
        this.db,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_policies'",
      ).get(),
    );
    return this.present;
  }

  /** Replaces the task's policy inputs; none clears them. */
  set(taskId: string, row: Omit<TaskPolicyRow, "task_id"> | null): void {
    if (!row) {
      prepared(this.db, "DELETE FROM task_policies WHERE task_id = ?").run(taskId);
      return;
    }
    prepared(
      this.db,
      `INSERT INTO task_policies (task_id, delivery_ask, autonomy_ask, rigor_ask, edits_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET
         delivery_ask = excluded.delivery_ask, autonomy_ask = excluded.autonomy_ask,
         rigor_ask = excluded.rigor_ask, edits_json = excluded.edits_json`,
    ).run(taskId, row.delivery_ask, row.autonomy_ask, row.rigor_ask, row.edits_json);
  }

  get(taskId: string): TaskPolicyRow | undefined {
    if (!this.exists()) return undefined;
    return prepared(this.db, "SELECT * FROM task_policies WHERE task_id = ?").get(taskId) as
      | TaskPolicyRow
      | undefined;
  }

  /** The policy rows of each of these tasks, by task id. */
  listFor(taskIds: readonly string[]): Map<string, TaskPolicyRow> {
    const byTask = new Map<string, TaskPolicyRow>();
    if (taskIds.length === 0 || !this.exists()) return byTask;
    const rows = prepared(
      this.db,
      "SELECT * FROM task_policies WHERE task_id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(taskIds)) as TaskPolicyRow[];
    for (const row of rows) byTask.set(row.task_id, row);
    return byTask;
  }

  deleteFor(taskId: string): void {
    if (!this.exists()) return;
    prepared(this.db, "DELETE FROM task_policies WHERE task_id = ?").run(taskId);
  }

  deleteAll(): void {
    if (!this.exists()) return;
    this.db.prepare("DELETE FROM task_policies").run();
  }
}
