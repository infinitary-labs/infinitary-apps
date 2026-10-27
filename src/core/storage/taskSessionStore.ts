import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "./db";

/** One conversation, independent of the task's mutable resume pointer. */
export const taskSessionSchema = z.object({
  conversation: z.string(),
  resume_token: z.string(),
  file: z.string(),
  computer: z.string().nullable(),
  device_id: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  account_id: z.string().nullable(),
  opened_at: z.number(),
  last_at: z.number(),
  began: z.string(),
});
export type TaskSession = z.infer<typeof taskSessionSchema>;

/** Pi's file name travels with its conversation; Claude's token is already its id. */
export function conversationOf(token: string): string {
  return basename(token).replace(/\.jsonl$/, "");
}

/** Only TaskService writes this table. Resuming a conversation never adds another row. */
export class TaskSessionStore {
  constructor(private readonly db: AppDatabase) {}

  record(taskId: string, session: TaskSession): void {
    this.db
      .prepare(`
      INSERT INTO task_sessions
        (task_id, conversation, resume_token, file, computer, device_id, provider, model, account_id, opened_at, last_at, began)
      VALUES (@taskId, @conversation, @resume_token, @file, @computer, @device_id, @provider, @model, @account_id, @opened_at, @last_at, @began)
      ON CONFLICT (task_id, conversation) DO UPDATE SET
        resume_token = excluded.resume_token, file = excluded.file, computer = excluded.computer, device_id = excluded.device_id,
        provider = excluded.provider, model = excluded.model, account_id = excluded.account_id,
        last_at = MAX(task_sessions.last_at, excluded.last_at)
    `)
      .run({ taskId, ...session });
  }

  private observationTable: boolean | undefined;

  private hasObservations(): boolean {
    this.observationTable ??= Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_session_observations'").get(),
    );
    return this.observationTable;
  }

  observe(taskId: string, facts: TaskSessionObservation, identity?: string): void {
    if (!this.hasObservations()) return;
    // Explicit identities restore retained history, including identical older readings.
    // A newly supplied boundary records a transition, not another copy every turn.
    if (identity === undefined) {
      const fields = [
        "conversation",
        "file",
        "computer",
        "device_id",
        "provider",
        "model",
        "account_id",
      ] as const;
      const previous = this.db
        .prepare(
          `SELECT ${fields.join(", ")} FROM task_session_observations
         WHERE task_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(taskId) as Pick<TaskSessionObservation, (typeof fields)[number]> | undefined;
      if (previous && fields.every((field) => previous[field] === facts[field])) return;
    }
    this.db
      .prepare(`INSERT INTO task_session_observations
      (id, task_id, conversation, file, computer, device_id, provider, model, account_id, began, observed_at)
      VALUES (@id, @taskId, @conversation, @file, @computer, @device_id, @provider, @model, @account_id, @began, @observed_at)`)
      .run({ ...facts, id: identity ?? randomUUID(), taskId });
  }

  observations(taskId: string): TaskSessionObservationRecord[] {
    if (!this.hasObservations()) return [];
    return this.db
      .prepare(
        "SELECT seq, id, task_id AS taskId, conversation, file, computer, device_id, provider, model, account_id, began, observed_at FROM task_session_observations WHERE task_id = ? ORDER BY seq",
      )
      .all(taskId) as TaskSessionObservationRecord[];
  }

  observation(id: string): TaskSessionObservationRecord | undefined {
    if (!this.hasObservations()) return undefined;
    return this.db
      .prepare(
        "SELECT seq, id, task_id AS taskId, conversation, file, computer, device_id, provider, model, account_id, began, observed_at FROM task_session_observations WHERE id = ?",
      )
      .get(id) as TaskSessionObservationRecord | undefined;
  }

  list(taskId: string): TaskSession[] {
    return this.db
      .prepare(`
      SELECT conversation, resume_token, file, computer, device_id, provider, model, account_id, opened_at, last_at, began
      FROM task_sessions WHERE task_id = ? ORDER BY opened_at, rowid
    `)
      .all(taskId) as TaskSession[];
  }
}

/** Immutable observed facts, never a reconstruction from the conversation's changing row. */
export const taskSessionObservationSchema = taskSessionSchema
  .omit({ resume_token: true, opened_at: true, last_at: true })
  .extend({ observed_at: z.number() });
export type TaskSessionObservation = z.infer<typeof taskSessionObservationSchema>;

export const taskSessionObservationRecordSchema = taskSessionObservationSchema.extend({
  id: z.string(),
  taskId: z.string(),
  seq: z.number().int(),
});
export type TaskSessionObservationRecord = z.infer<typeof taskSessionObservationRecordSchema>;
