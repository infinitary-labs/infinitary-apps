import type { WorkShape } from "@shared/routingPolicy";
import { policyShapeFields, type TaskPolicyRow } from "./taskPolicyFields.ts";

/**
 * The three relationships a task names one of at most (INF-1296 piece 2,
 * `docs/task-record.md` "Relationships"): the task whose answer it builds
 * on (`basis`), the task whose last commit its working copy starts at
 * (`branch-source`), and the attempt the captain rejected that it retries
 * at a higher tier (`retry-of`). One row per task and kind keeps each to
 * one; none of them is a dependency, so the ready query never reads them.
 * This file imports nothing at run time but `taskPolicyFields.ts`, which
 * imports nothing, so the offline tools under `scripts/` read a saved
 * database through it too.
 */
export const TASK_REFERENCE_KINDS = ["basis", "branch-source", "retry-of"] as const;
export type TaskReferenceKind = (typeof TASK_REFERENCE_KINDS)[number];

/**
 * The work shape field each reference was saved in before it had a table
 * of its own, and is still read as: the shape a record reads carries it,
 * so every reader of the shape reads the same words.
 */
export const REFERENCE_SHAPE_FIELDS = {
  basis: "basis",
  "branch-source": "branch_from",
  "retry-of": "escalate_from",
} as const satisfies Record<TaskReferenceKind, keyof WorkShape>;

type SavedDatabase = {
  prepare(sql: string): { get(): unknown; all(): unknown[] };
};

/**
 * For a tool that reads a saved database's `tasks` rows itself: each row's
 * `shape_json` as the app reads its shape, with its references under their
 * shape fields and its policy inputs under theirs (INF-1296 pieces 2 and 3).
 * A database from before migration 95, or before the policy row, kept them
 * in the shape already, so its rows read unchanged.
 */
export function savedShapeReader(
  db: SavedDatabase,
): (taskId: string, shapeJson: string | null) => string | null {
  const has = (table: string) =>
    Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).get(),
    );
  const byTask = new Map<string, { kind: TaskReferenceKind; ref: string }[]>();
  if (has("task_references"))
    for (const row of db.prepare("SELECT task_id, kind, ref FROM task_references").all() as {
      task_id: string;
      kind: TaskReferenceKind;
      ref: string;
    }[])
      byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);
  const policies = new Map<string, TaskPolicyRow>();
  if (has("task_policies"))
    for (const row of db.prepare("SELECT * FROM task_policies").all() as TaskPolicyRow[])
      policies.set(row.task_id, row);
  if (byTask.size === 0 && policies.size === 0) return (_taskId, shapeJson) => shapeJson;
  return (taskId, shapeJson) => {
    const references = byTask.get(taskId);
    const policy = policies.get(taskId);
    if ((!references && !policy) || !shapeJson) return shapeJson;
    let shape: Record<string, unknown>;
    try {
      shape = JSON.parse(shapeJson) as Record<string, unknown>;
    } catch {
      return shapeJson;
    }
    for (const reference of references ?? [])
      shape[REFERENCE_SHAPE_FIELDS[reference.kind]] = reference.ref;
    if (policy) Object.assign(shape, policyShapeFields(policy));
    return JSON.stringify(shape);
  };
}
