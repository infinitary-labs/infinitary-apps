import { byTagName, type TagSetter, type TaskTagView } from "@shared/tags";
import type { Statement } from "better-sqlite3";
import type { AppDatabase } from "./db";

/**
 * The tags each task carries (docs/task-tags.md), one `task_tags` row per
 * task and tag: on or off, who set it, and the tag's description revision
 * it was judged at. Written only through `TaskService`, whose writer holds
 * this store. A tag reads on a task only while the tag belongs to the
 * task's own project.
 */

export type TaskTagRow = {
  taskId: string;
  tagId: string;
  on: boolean;
  by: TagSetter;
  revision: number | null;
  at: number;
};

type Row = {
  task_id: string;
  tag_id: string;
  state: "on" | "off";
  set_by: TagSetter;
  revision: number | null;
  at: number;
};

export class TaskTagStore {
  private present: boolean | undefined;
  constructor(private readonly db: AppDatabase) {}

  /** A record opened at an older version has no tags table and reads none. */
  exists(): boolean {
    this.present ??=
      this.db
        // i18n-exempt: SQL, never shown to a person
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_tags'")
        .get() !== undefined;
    return this.present;
  }

  /** A task's rows, on and off, by tag id. */
  rowsOf(taskId: string): Map<string, TaskTagRow> {
    const rows = new Map<string, TaskTagRow>();
    if (!this.exists()) return rows;
    for (const row of this.db
      // i18n-exempt: SQL, never shown to a person
      .prepare("SELECT * FROM task_tags WHERE task_id = ?")
      .all(taskId) as Row[])
      rows.set(row.tag_id, {
        taskId: row.task_id,
        tagId: row.tag_id,
        on: row.state === "on",
        by: row.set_by,
        revision: row.revision,
        at: row.at,
      });
    return rows;
  }

  /**
   * The tags each of these tasks carries, alphabetical: only tags of the
   * task's own project, and only those on.
   */
  viewsFor(taskIds: readonly string[]): Map<string, TaskTagView[]> {
    const byTask = new Map<string, TaskTagView[]>();
    if (!this.exists() || taskIds.length === 0) return byTask;
    const read = this.db.prepare(
      // i18n-exempt: SQL, never shown to a person
      `SELECT x.task_id, p.id, p.name, x.set_by FROM task_tags x
       JOIN project_tags p ON p.id = x.tag_id
       JOIN tasks t ON t.id = x.task_id AND t.project_id = p.project_id
       WHERE x.state = 'on' AND x.task_id IN (SELECT value FROM json_each(?))`,
    );
    const rows = read.all(JSON.stringify(taskIds)) as {
      task_id: string;
      id: string;
      name: string;
      set_by: TagSetter;
    }[];
    for (const row of rows) {
      const list = byTask.get(row.task_id) ?? [];
      list.push({ id: row.id, name: row.name, by: row.set_by });
      byTask.set(row.task_id, list);
    }
    for (const list of byTask.values()) list.sort(byTagName);
    return byTask;
  }

  private one: Statement | undefined;
  private carried: boolean | undefined;

  /**
   * One task's tags, as `viewsFor` reads them: every row view the board
   * builds asks it, so it reads nothing until some task carries a tag.
   */
  viewsOf(taskId: string): TaskTagView[] {
    if (!this.exists()) return [];
    this.carried ||= this.any();
    if (!this.carried) return [];
    this.one ??= this.db.prepare(
      // i18n-exempt: SQL, never shown to a person
      `SELECT p.id, p.name, x.set_by AS by FROM task_tags x
       JOIN project_tags p ON p.id = x.tag_id
       JOIN tasks t ON t.id = x.task_id AND t.project_id = p.project_id
       WHERE x.state = 'on' AND x.task_id = ?`,
    );
    return (this.one.all(taskId) as TaskTagView[]).sort(byTagName);
  }

  /** Whether any task carries any tag, so a board with none reads nothing more. */
  any(): boolean {
    // i18n-exempt: SQL, never shown to a person
    return this.exists() && this.db.prepare("SELECT 1 FROM task_tags LIMIT 1").get() !== undefined;
  }

  set(row: TaskTagRow): void {
    if (row.on) this.carried = true;
    this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `INSERT INTO task_tags (task_id, tag_id, state, set_by, revision, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, tag_id) DO UPDATE SET state = excluded.state, set_by = excluded.set_by,
           revision = excluded.revision, at = excluded.at`,
      )
      .run(row.taskId, row.tagId, row.on ? "on" : "off", row.by, row.revision, row.at);
  }

  /** Tasks carrying a tag now. */
  carrying(tagId: string): string[] {
    if (!this.exists()) return [];
    return (
      (
        this.db
          // i18n-exempt: SQL, never shown to a person
          .prepare("SELECT task_id FROM task_tags WHERE tag_id = ? AND state = 'on'")
          .all(tagId) as { task_id: string }[]
      ).map((row) => row.task_id)
    );
  }

  deleteTag(tagId: string): void {
    // i18n-exempt: SQL, never shown to a person
    if (this.exists()) this.db.prepare("DELETE FROM task_tags WHERE tag_id = ?").run(tagId);
  }

  /** Every row of a task, on and off: a move to another project, or the task's own purge. */
  deleteFor(taskId: string): number {
    if (!this.exists()) return 0;
    // i18n-exempt: SQL, never shown to a person
    return this.db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(taskId).changes;
  }

  deleteAll(): void {
    // i18n-exempt: SQL, never shown to a person
    if (this.exists()) this.db.prepare("DELETE FROM task_tags").run();
  }
}
