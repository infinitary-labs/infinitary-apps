import type { CommittedPlacement } from "@shared/placement";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import { conversationOf } from "./taskSessionStore";

/**
 * A task's running work (INF-1296 piece 3, `docs/task-record.md` "A task's
 * execution record"): one row per task in `task_execution`, beside the
 * conversations `task_sessions` lists. The resume binding is the opaque
 * token the backend resumes from and, where that token belongs to a
 * recorded conversation, that conversation's key; the computer and account
 * the crewmate runs on; the placement committed for it; the idle clock and
 * the recovery ladder's rung; a manual start that did not begin; when a
 * started task went back to the backlog (INF-2062); and what
 * the current turn's report declared about whose turn follows it. A record
 * still reads every one of them where it read them before, so no reader
 * changes. Only TaskStore writes this table, beneath TaskService.
 */
export type TaskExecution = {
  sessionFile: string | null;
  /** The recorded conversation the resume token belongs to; null for a token none records. */
  conversation: string | null;
  deviceId: string | null;
  accountId: string | null;
  placement: CommittedPlacement | null;
  idleSince: number | null;
  recoveryRung: number;
  recoveryCount: number;
  recoveryAt: number | null;
  startNotice: string | null;
  /**
   * When this started task went back to the backlog (INF-2062,
   * `TaskService.setQueued`): it waits there for a Start, its work kept,
   * and nothing the host sends wakes it. Null while it is not there.
   */
  backlogSince: number | null;
  /** The current turn's declarations, under the delivery fields a record reads them as. */
  turn: Record<string, unknown> | null;
};

/**
 * The delivery fields that are the current turn's declarations (FI3-435,
 * INF-1244): kept from a report until its task's next turn starts. A record
 * reads them on its delivery facts, as it did before they had a row.
 */
export const TURN_DECLARATION_FIELDS = [
  "captainWait",
  "finishedAt",
  "mergeCompletion",
  "needsFirstmate",
  "checkBack",
] as const;

/** The record fields this table holds, and the column each is saved in. */
export const EXECUTION_COLUMNS = {
  sessionFile: "session_file",
  deviceId: "device_id",
  accountId: "account_id",
  placement: "placement_json",
  idleSince: "idle_since",
  recoveryRung: "recovery_rung",
  recoveryCount: "recovery_count",
  recoveryAt: "recovery_at",
  startNotice: "start_notice",
  backlogSince: "backlog_since",
} as const;
export type ExecutionField = keyof typeof EXECUTION_COLUMNS;

type Row = {
  task_id: string;
  session_file: string | null;
  conversation: string | null;
  device_id: string | null;
  account_id: string | null;
  placement_json: string | null;
  idle_since: number | null;
  recovery_rung: number;
  recovery_count: number;
  recovery_at: number | null;
  start_notice: string | null;
  backlog_since?: number | null;
  turn_json: string | null;
};

export const NO_EXECUTION: TaskExecution = {
  sessionFile: null,
  conversation: null,
  deviceId: null,
  accountId: null,
  placement: null,
  idleSince: null,
  recoveryRung: 0,
  recoveryCount: 0,
  recoveryAt: null,
  startNotice: null,
  backlogSince: null,
  turn: null,
};

function parseObject<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fromRow(row: Row): TaskExecution {
  return {
    sessionFile: row.session_file,
    conversation: row.conversation,
    deviceId: row.device_id,
    accountId: row.account_id,
    placement: parseObject<CommittedPlacement>(row.placement_json),
    idleSince: row.idle_since,
    recoveryRung: row.recovery_rung ?? 0,
    recoveryCount: row.recovery_count ?? 0,
    recoveryAt: row.recovery_at,
    startNotice: row.start_notice,
    backlogSince: row.backlog_since ?? null,
    turn: parseObject<Record<string, unknown>>(row.turn_json),
  };
}

/** A delivery split into what its column keeps and the current turn's declarations. */
export function splitTurn<T extends object>(
  delivery: T | null | undefined,
): { delivery: T | null; turn: Record<string, unknown> | null } {
  if (!delivery) return { delivery: null, turn: null };
  const kept = { ...delivery } as Record<string, unknown>;
  const turn: Record<string, unknown> = {};
  for (const field of TURN_DECLARATION_FIELDS) {
    if (kept[field] !== undefined) turn[field] = kept[field];
    delete kept[field];
  }
  return { delivery: kept as T, turn: Object.keys(turn).length > 0 ? turn : null };
}

/** A delivery as it is read: the stored facts, and the current turn's declarations. */
export function withTurn<T extends object>(
  delivery: T | null,
  turn: Record<string, unknown> | null,
): T | null {
  if (!delivery || !turn) return delivery;
  return { ...delivery, ...turn };
}

export class TaskExecutionStore {
  private present = false;

  constructor(private readonly db: AppDatabase) {}

  /** Whether this database has the table yet; migration tests read an older schema. */
  exists(): boolean {
    this.present ||= Boolean(
      prepared(
        this.db,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_execution'",
      ).get(),
    );
    return this.present;
  }

  get(taskId: string): TaskExecution {
    if (!this.exists()) return NO_EXECUTION;
    const row = prepared(this.db, "SELECT * FROM task_execution WHERE task_id = ?").get(taskId) as
      | Row
      | undefined;
    return row ? fromRow(row) : NO_EXECUTION;
  }

  /** The execution of each of these tasks that has one, by task id. */
  listFor(taskIds: readonly string[]): Map<string, TaskExecution> {
    const byTask = new Map<string, TaskExecution>();
    if (taskIds.length === 0 || !this.exists()) return byTask;
    const rows = prepared(
      this.db,
      "SELECT * FROM task_execution WHERE task_id IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(taskIds)) as Row[];
    for (const row of rows) byTask.set(row.task_id, fromRow(row));
    return byTask;
  }

  /** The tasks whose committed placement still waits on its computer. */
  pendingPlacementIds(): string[] {
    if (!this.exists()) return [];
    return (
      prepared(
        this.db,
        "SELECT task_id FROM task_execution WHERE json_extract(placement_json, '$.reservation') = 'pending'",
      ).all() as { task_id: string }[]
    ).map((row) => row.task_id);
  }

  /**
   * Applies a change; only the named fields change. A new resume token
   * names the recorded conversation it belongs to, when `task_sessions`
   * records one for this task, and none otherwise: a token no conversation
   * records stays resumable without a conversation made up for it.
   */
  update(taskId: string, patch: Partial<Omit<TaskExecution, "conversation">>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(EXECUTION_COLUMNS) as [ExecutionField, string][]) {
      if (!(field in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[field];
      if (field === "placement") values.push(value ? JSON.stringify(value) : null);
      else if (field === "recoveryRung" || field === "recoveryCount") values.push(value ?? 0);
      else values.push(value ?? null);
    }
    if ("sessionFile" in patch) {
      sets.push("conversation = ?");
      values.push(this.conversationFor(taskId, patch.sessionFile ?? null));
    }
    if ("turn" in patch) {
      sets.push("turn_json = ?");
      values.push(patch.turn ? JSON.stringify(patch.turn) : null);
    }
    if (sets.length === 0) return;
    prepared(this.db, "INSERT INTO task_execution (task_id) VALUES (?) ON CONFLICT DO NOTHING").run(
      taskId,
    );
    this.db
      .prepare(`UPDATE task_execution SET ${sets.join(", ")} WHERE task_id = ?`)
      .run(...values, taskId);
  }

  /** The conversation a resume token belongs to, when this task records it. */
  private conversationFor(taskId: string, sessionFile: string | null): string | null {
    if (!sessionFile) return null;
    const conversation = conversationOf(sessionFile);
    return prepared(
      this.db,
      "SELECT 1 FROM task_sessions WHERE task_id = ? AND conversation = ?",
    ).get(taskId, conversation)
      ? conversation
      : null;
  }

  /**
   * Names an imported binding's conversation: the one its export recorded,
   * or, from an export before execution records, the recorded conversation
   * its token belongs to, as the migration named it.
   */
  pinConversation(taskId: string, exported: string | null | undefined): void {
    if (!this.exists()) return;
    const conversation =
      exported !== undefined
        ? exported
        : this.conversationFor(taskId, this.get(taskId).sessionFile);
    prepared(this.db, "UPDATE task_execution SET conversation = ? WHERE task_id = ?").run(
      conversation,
      taskId,
    );
  }

  deleteFor(taskId: string): void {
    if (!this.exists()) return;
    prepared(this.db, "DELETE FROM task_execution WHERE task_id = ?").run(taskId);
  }

  deleteAll(): void {
    if (!this.exists()) return;
    this.db.prepare("DELETE FROM task_execution").run();
  }
}
