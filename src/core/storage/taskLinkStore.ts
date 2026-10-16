import type { AppDatabase } from "./db";
import type { TaskEventActor } from "./taskEventStore";

/**
 * Typed edges between tasks (task-system design section 4.3). `blocks`:
 * `to` is not ready until `from` closes; `related` is informational;
 * `discovered-from` is provenance with no readiness effect; `replaced-by`:
 * `from` was dropped for `to`, which does its work (FI3-1189's rule 1), with
 * no readiness effect either. P0 carries the after-task wait on `blocks`;
 * the full graph (cycle refusal, parents, the ready query) is P2.
 */

export type TaskLinkType = "blocks" | "related" | "discovered-from" | "replaced-by";

export type TaskLink = {
  fromId: string;
  toId: string;
  type: TaskLinkType;
  actor: TaskEventActor;
  createdAt: number;
};

type Row = {
  from_id: string;
  to_id: string;
  type: TaskLinkType;
  actor: TaskEventActor;
  created_at: number;
};

function fromRow(row: Row): TaskLink {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export class TaskLinkStore {
  constructor(private readonly db: AppDatabase) {}

  /** Idempotent: the same edge twice is one row. Returns whether it was new. */
  insert(link: TaskLink): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(link.fromId, link.toId, link.type, link.actor, link.createdAt);
    return result.changes === 1;
  }

  delete(fromId: string, toId: string, type: TaskLinkType): boolean {
    const result = this.db
      .prepare("DELETE FROM task_links WHERE from_id = ? AND to_id = ? AND type = ?")
      .run(fromId, toId, type);
    return result.changes === 1;
  }

  /** Edges pointing at a task (its blockers, for type blocks). */
  listTo(toId: string, type?: TaskLinkType): TaskLink[] {
    const rows = (
      type
        ? this.db
            .prepare("SELECT * FROM task_links WHERE to_id = ? AND type = ? ORDER BY created_at")
            .all(toId, type)
        : this.db.prepare("SELECT * FROM task_links WHERE to_id = ? ORDER BY created_at").all(toId)
    ) as Row[];
    return rows.map(fromRow);
  }

  /** Edges leaving a task (what it blocks, for type blocks). */
  listFrom(fromId: string, type?: TaskLinkType): TaskLink[] {
    const rows = (
      type
        ? this.db
            .prepare("SELECT * FROM task_links WHERE from_id = ? AND type = ? ORDER BY created_at")
            .all(fromId, type)
        : this.db
            .prepare("SELECT * FROM task_links WHERE from_id = ? ORDER BY created_at")
            .all(fromId)
    ) as Row[];
    return rows.map(fromRow);
  }

  /** Every edge, oldest first (the board builder resolves them in one pass). */
  listAll(): TaskLink[] {
    const rows = this.db
      .prepare("SELECT * FROM task_links ORDER BY created_at, from_id, to_id")
      .all() as Row[];
    return rows.map(fromRow);
  }

  deleteAll(): void {
    this.db.prepare("DELETE FROM task_links").run();
  }
}
