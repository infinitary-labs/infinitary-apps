import type { WorkShape } from "@shared/routingPolicy";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/** Each remaining shape field's typed owner; the composed WorkShape remains a compatible read. */
export const CONTRACT_FIELDS = [
  "ongoing",
  "internal_step",
  "outside_reader",
  "result_schema",
  "skipped_plan_because",
  "deliverable",
] as const satisfies readonly (keyof WorkShape)[];
export const PROGRAM_FIELDS = [
  "program",
  "program_part",
] as const satisfies readonly (keyof WorkShape)[];
export const WORKSPACE_FIELDS = [
  "in_place",
  "branch",
  "built_on",
] as const satisfies readonly (keyof WorkShape)[];
export const PLACEMENT_FIELDS = [
  "runs_on_ask",
  "placement_requirements",
  "placement_fallback_accepted",
  "placement_wait",
  "start_wait_since",
  "computer_move",
  "home_copy",
  "away_copies",
  "start_at_approval",
  "needs_merge",
] as const satisfies readonly (keyof WorkShape)[];
export const ROUTING_FIELDS = [
  "intelligence",
  "kind",
  "premium_ask",
  "override_model_id",
  "review_model",
  "override_speed",
  "override_reasoning",
  "escalation",
  "kind_source",
  "kind_detail",
  "rigor",
  "autonomy",
] as const satisfies readonly (keyof WorkShape)[];

export type TaskContract = Pick<WorkShape, (typeof CONTRACT_FIELDS)[number]>;
export type TaskProgram = Pick<WorkShape, (typeof PROGRAM_FIELDS)[number]>;
export type TaskWorkspaceFacts = Pick<WorkShape, (typeof WORKSPACE_FIELDS)[number]>;
export type TaskPlacementRequest = Pick<WorkShape, (typeof PLACEMENT_FIELDS)[number]>;
export type TaskRouting = Pick<WorkShape, (typeof ROUTING_FIELDS)[number]>;

/** Physical records, not a generic fact registry. Each column holds one statically typed family. */
export const SHAPE_RECORD_TABLES = [
  "task_contracts",
  "task_programs",
  "task_workspace_facts",
  "task_placement_requests",
  "task_routing_requests",
  "task_legacy_shapes",
] as const;
const FIELDS = [
  CONTRACT_FIELDS,
  PROGRAM_FIELDS,
  WORKSPACE_FIELDS,
  PLACEMENT_FIELDS,
  ROUTING_FIELDS,
] as const;

/** Low-level persistence beneath TaskService's named operations; never a public task patch API. */
export class TaskOwnedShapeStore {
  private present = false;
  constructor(private readonly db: AppDatabase) {}

  exists(): boolean {
    this.present ||= Boolean(
      prepared(this.db, "SELECT 1 FROM sqlite_master WHERE name = 'task_contracts'").get(),
    );
    return this.present;
  }

  replace(taskId: string, shape: WorkShape | null): void {
    const remaining: Record<string, unknown> = { ...shape };
    for (const [i, fields] of FIELDS.entries()) {
      const value: Record<string, unknown> = {};
      for (const key of fields) {
        if (Object.hasOwn(remaining, key)) value[key] = remaining[key];
        delete remaining[key];
      }
      this.set(
        SHAPE_RECORD_TABLES[i]!,
        taskId,
        Object.keys(value).length ? JSON.stringify(value) : null,
      );
    }
    // Unknown older fields remain evidence, not new operational input.
    this.set(
      "task_legacy_shapes",
      taskId,
      Object.keys(remaining).length ? JSON.stringify(remaining) : null,
    );
  }

  private set(
    table: (typeof SHAPE_RECORD_TABLES)[number],
    taskId: string,
    json: string | null,
  ): void {
    if (json === null) prepared(this.db, `DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
    else
      prepared(
        this.db,
        `INSERT INTO ${table} (task_id, value_json) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET value_json = excluded.value_json`,
      ).run(taskId, json);
  }
}

/** JSON composition preserves explicit nulls, booleans and unknown older fields, unlike json_patch. */
export function composedShapeSql(taskId: string): string {
  return `(SELECT json_group_object(key, CASE
    WHEN type IN ('object', 'array') THEN json(value)
    WHEN type = 'true' THEN json('true') WHEN type = 'false' THEN json('false') ELSE value END)
    FROM (${SHAPE_RECORD_TABLES.map((table) => `SELECT key, value, type FROM json_each((SELECT value_json FROM ${table} WHERE task_id = ${taskId}))`).join(" UNION ALL ")}))`;
}
