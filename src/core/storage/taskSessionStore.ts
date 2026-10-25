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

  list(taskId: string): TaskSession[] {
    return this.db
      .prepare(`
      SELECT conversation, resume_token, file, computer, device_id, provider, model, account_id, opened_at, last_at, began
      FROM task_sessions WHERE task_id = ? ORDER BY opened_at, rowid
    `)
      .all(taskId) as TaskSession[];
  }
}
