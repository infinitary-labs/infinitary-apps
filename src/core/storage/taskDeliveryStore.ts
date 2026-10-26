import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import {
  type EvidenceRow,
  PERMISSION_COLUMNS,
  type PermissionRow,
  splitDelivery,
} from "./taskDeliveryFields";

export {
  composeDelivery,
  type EvidenceRow,
  type PermissionRow,
  splitDelivery,
} from "./taskDeliveryFields";

/** The permission row's columns, every one of them a JSON value or null. */
const PERMISSION_ROW_COLUMNS = [
  ...Object.values(PERMISSION_COLUMNS),
  "validation_permissions_json",
  "pending_settle_json",
] as const;

/** The columns a delivery write replaces: all but a settle that has not run, a field of the record. */
const DELIVERY_PERMISSION_COLUMNS = PERMISSION_ROW_COLUMNS.filter(
  (column) => column !== "pending_settle_json",
);

function tableExists(db: AppDatabase, name: string): boolean {
  return Boolean(
    prepared(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

/**
 * A task's change evidence and its permissions and effects (INF-1296 piece
 * 4, `docs/task-record.md` "A task's change evidence and permissions"): one
 * `task_delivery_evidence` row and one `task_permissions` row per task that
 * has any. A record still reads every field on its delivery facts, and its
 * settle that has not run under `pendingSettle`, so no reader changes.
 * Only TaskStore writes these tables, beneath TaskService.
 */
export class TaskDeliveryStore {
  private present = false;

  constructor(private readonly db: AppDatabase) {}

  /** Whether this database has the tables yet; migration tests read an older schema. */
  exists(): boolean {
    this.present ||= tableExists(this.db, "task_delivery_evidence");
    return this.present;
  }

  evidence(taskId: string): EvidenceRow | undefined {
    if (!this.exists()) return undefined;
    return prepared(this.db, "SELECT * FROM task_delivery_evidence WHERE task_id = ?").get(
      taskId,
    ) as EvidenceRow | undefined;
  }

  permissions(taskId: string): PermissionRow | undefined {
    if (!this.exists()) return undefined;
    return prepared(this.db, "SELECT * FROM task_permissions WHERE task_id = ?").get(taskId) as
      | PermissionRow
      | undefined;
  }

  /** The evidence and permission rows of each of these tasks that has one, by task id. */
  listFor(taskIds: readonly string[]): {
    evidence: Map<string, EvidenceRow>;
    permissions: Map<string, PermissionRow>;
  } {
    const evidence = new Map<string, EvidenceRow>();
    const permissions = new Map<string, PermissionRow>();
    if (taskIds.length === 0 || !this.exists()) return { evidence, permissions };
    const ids = JSON.stringify(taskIds);
    for (const row of prepared(
      this.db,
      "SELECT * FROM task_delivery_evidence WHERE task_id IN (SELECT value FROM json_each(?))",
    ).all(ids) as EvidenceRow[])
      evidence.set(row.task_id, row);
    for (const row of prepared(
      this.db,
      "SELECT * FROM task_permissions WHERE task_id IN (SELECT value FROM json_each(?))",
    ).all(ids) as PermissionRow[])
      permissions.set(row.task_id, row);
    return { evidence, permissions };
  }

  /**
   * Writes a task's whole delivery facts, as the delivery column took them
   * before: its evidence and its delivery permissions are replaced, and
   * what is history is returned for the column. A settle that has not run
   * is the record's own field and stays.
   */
  setDelivery(taskId: string, delivery: object | null): Record<string, unknown> | null {
    const split = delivery ? splitDelivery(delivery) : null;
    if (split?.evidence) {
      prepared(
        this.db,
        `INSERT INTO task_delivery_evidence (task_id, format, mode, head_sha, evidence_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET format = excluded.format, mode = excluded.mode,
           head_sha = excluded.head_sha, evidence_json = excluded.evidence_json`,
      ).run(
        taskId,
        split.evidence.format,
        split.evidence.mode,
        split.evidence.head_sha,
        split.evidence.evidence_json,
      );
    } else {
      prepared(this.db, "DELETE FROM task_delivery_evidence WHERE task_id = ?").run(taskId);
    }
    this.writePermissions(
      taskId,
      Object.fromEntries(
        DELIVERY_PERMISSION_COLUMNS.map((column) => [column, split?.permissions?.[column] ?? null]),
      ),
    );
    return split?.history ?? null;
  }

  /** Records or clears a settle that has not run. */
  setPendingSettle(taskId: string, pending: unknown): void {
    this.writePermissions(taskId, {
      pending_settle_json:
        pending === null || pending === undefined ? null : JSON.stringify(pending),
    });
  }

  /** Writes these permission columns; a row left with none is removed. */
  private writePermissions(taskId: string, columns: Record<string, string | null>): void {
    const names = Object.keys(columns);
    const named = Object.values(columns).some((value) => value !== null);
    if (named)
      prepared(
        this.db,
        "INSERT INTO task_permissions (task_id) VALUES (?) ON CONFLICT DO NOTHING",
      ).run(taskId);
    this.db
      .prepare(
        `UPDATE task_permissions SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE task_id = ?`,
      )
      .run(...Object.values(columns), taskId);
    prepared(
      this.db,
      `DELETE FROM task_permissions WHERE task_id = ? AND ${PERMISSION_ROW_COLUMNS.map((column) => `${column} IS NULL`).join(" AND ")}`,
    ).run(taskId);
  }

  deleteFor(taskId: string): void {
    if (!this.exists()) return;
    prepared(this.db, "DELETE FROM task_delivery_evidence WHERE task_id = ?").run(taskId);
    prepared(this.db, "DELETE FROM task_permissions WHERE task_id = ?").run(taskId);
  }

  deleteAll(): void {
    if (!this.exists()) return;
    this.db.prepare("DELETE FROM task_delivery_evidence").run();
    this.db.prepare("DELETE FROM task_permissions").run();
  }
}
