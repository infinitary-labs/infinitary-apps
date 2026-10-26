/**
 * A task's policy inputs (INF-1296 piece 3, `docs/task-record.md` "A
 * task's policy record"): the delivery, merging and care the captain asked
 * for when it was filed (`delivery_ask`, `autonomy_ask`, `rigor_ask`) and
 * the live edits made since (`policies`). They live in `task_policies`,
 * one row per task, and a record's work shape is still read with each one
 * under the shape field it was saved in, so every reader of the shape reads
 * the same words. The closed snapshot (`delivery.closedPolicies`) is
 * history, not an input, and stays where it is. This file imports nothing
 * at run time, so the offline tools under `scripts/` read a saved database
 * through it too.
 */
export const POLICY_SHAPE_FIELDS = [
  "delivery_ask",
  "autonomy_ask",
  "rigor_ask",
  "policies",
] as const;
export type PolicyShapeField = (typeof POLICY_SHAPE_FIELDS)[number];

/** A `task_policies` row as saved. */
export type TaskPolicyRow = {
  task_id: string;
  delivery_ask: string | null;
  autonomy_ask: number | null;
  rigor_ask: string | null;
  edits_json: string | null;
};

/** The shape fields one saved row puts back, each only where it holds one. */
export function policyShapeFields(row: TaskPolicyRow): Partial<Record<PolicyShapeField, unknown>> {
  const fields: Partial<Record<PolicyShapeField, unknown>> = {};
  if (row.delivery_ask !== null) fields.delivery_ask = row.delivery_ask;
  if (row.autonomy_ask !== null) fields.autonomy_ask = row.autonomy_ask === 1;
  if (row.rigor_ask !== null) fields.rigor_ask = row.rigor_ask;
  if (row.edits_json !== null) {
    try {
      fields.policies = JSON.parse(row.edits_json);
    } catch {
      // A row this build wrote always parses; an unreadable one adds nothing.
    }
  }
  return fields;
}
