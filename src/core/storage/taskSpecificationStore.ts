import type { SpawnIntent } from "../orchestrator/intentBrief";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/** Immutable specifications, with the current reference on the task core. */
export type TaskSpecification = { goal: string | null; prompt: string; intent: SpawnIntent | null };

export type SavedSpecification = { goal: string | null; prompt: string; intentJson: string | null };

export class TaskSpecificationStore {
  private present = false;
  constructor(private readonly db: AppDatabase) {}

  exists(): boolean {
    this.present ||= Boolean(
      prepared(this.db, "SELECT 1 FROM sqlite_master WHERE name = 'task_specifications'").get(),
    );
    return this.present;
  }

  history(taskId: string): SavedSpecification[] {
    return prepared(
      this.db,
      "SELECT goal, prompt, intent_json AS intentJson FROM task_specifications WHERE task_id = ? ORDER BY id",
    ).all(taskId) as SavedSpecification[];
  }

  revision(taskId: string): number {
    return (
      prepared(this.db, "SELECT COUNT(*) AS n FROM task_specifications WHERE task_id = ?").get(
        taskId,
      ) as { n: number }
    ).n;
  }

  at(taskId: string, revision: number): SavedSpecification | undefined {
    if (!Number.isInteger(revision) || revision < 1) return undefined;
    return prepared(
      this.db,
      "SELECT goal, prompt, intent_json AS intentJson FROM task_specifications WHERE task_id = ? ORDER BY id LIMIT 1 OFFSET ?",
    ).get(taskId, revision - 1) as SavedSpecification | undefined;
  }

  /** Import remaps storage-local revision identities and points at the same final specification. */
  restore(taskId: string, history: readonly SavedSpecification[]): void {
    if (!history.length) return;
    prepared(this.db, "DELETE FROM task_specifications WHERE task_id = ?").run(taskId);
    const insert = prepared(
      this.db,
      "INSERT INTO task_specifications (task_id, goal, prompt, intent_json) VALUES (?, ?, ?, ?)",
    );
    for (const saved of history) {
      const row = insert.run(taskId, saved.goal, saved.prompt, saved.intentJson);
      prepared(this.db, "UPDATE tasks SET specification_id = ? WHERE id = ?").run(
        row.lastInsertRowid,
        taskId,
      );
    }
  }

  /** A new revision only when the authored specification changed. Unknown historical time stays unknown. */
  revise(taskId: string, patch: Partial<TaskSpecification>): void {
    const previous = prepared(
      this.db,
      `SELECT s.* FROM tasks t LEFT JOIN task_specifications s
      ON s.id = t.specification_id WHERE t.id = ?`,
    ).get(taskId) as {
      id: number;
      goal: string | null;
      prompt: string;
      intent_json: string | null;
    };
    const goal = "goal" in patch ? (patch.goal ?? null) : previous.goal;
    const prompt = patch.prompt ?? previous.prompt;
    const intent =
      "intent" in patch
        ? patch.intent
          ? JSON.stringify(patch.intent)
          : null
        : previous.intent_json;
    if (
      previous.id &&
      goal === previous.goal &&
      prompt === previous.prompt &&
      intent === previous.intent_json
    )
      return;
    const inserted = prepared(
      this.db,
      "INSERT INTO task_specifications (task_id, goal, prompt, intent_json) VALUES (?, ?, ?, ?)",
    ).run(taskId, goal, prompt, intent);
    prepared(this.db, "UPDATE tasks SET specification_id = ? WHERE id = ?").run(
      inserted.lastInsertRowid,
      taskId,
    );
  }
}
