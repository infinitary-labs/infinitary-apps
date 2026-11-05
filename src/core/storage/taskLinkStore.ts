import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import type { TaskEventActor } from "./taskEventStore";

/**
 * Typed edges between tasks (task-system design section 4.3). `blocks`:
 * `to` is not ready until `from` closes. `holdsMerge` is the separate mark
 * that the same edge also holds `to`'s close, set only where someone
 * promised that hold (INF-416 piece E). `related` is informational;
 * `discovered-from` is provenance with no readiness effect; `replaced-by`:
 * `to` does `from`'s work now (FI3-1189's rule 1), with no readiness effect
 * of its own; writing it moves `from`'s live waits to `to` (INF-1826). P0
 * carries the after-task wait on `blocks`; the full graph (cycle refusal,
 * parents, the ready query) is P2.
 */

export type TaskLinkType = "blocks" | "related" | "discovered-from" | "replaced-by";

export type TaskLink = {
  fromId: string;
  toId: string;
  type: TaskLinkType;
  actor: TaskEventActor;
  createdAt: number;
  /** A blocks edge holds the waiter's close. Absent on every other type. */
  holdsMerge: boolean;
};

type Row = {
  from_id: string;
  to_id: string;
  type: TaskLinkType;
  actor: TaskEventActor;
  created_at: number;
  holds_merge: number;
};

function fromRow(row: Row): TaskLink {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type,
    actor: row.actor,
    createdAt: row.created_at,
    holdsMerge: row.holds_merge === 1,
  };
}

export class TaskLinkStore {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Idempotent: the same edge twice is one row. A repeat that promises a
   * merge hold sets the mark; a repeat never clears one. Returns whether
   * the edge was new.
   */
  insert(link: TaskLink): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO task_links (from_id, to_id, type, actor, created_at, holds_merge) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(link.fromId, link.toId, link.type, link.actor, link.createdAt, link.holdsMerge ? 1 : 0);
    if (result.changes === 0 && link.holdsMerge) {
      this.db
        .prepare(
          "UPDATE task_links SET holds_merge = 1 WHERE from_id = ? AND to_id = ? AND type = ? AND holds_merge = 0",
        )
        .run(link.fromId, link.toId, link.type);
    }
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
        ? prepared(
            this.db,
            "SELECT * FROM task_links WHERE to_id = ? AND type = ? ORDER BY created_at",
          ).all(toId, type)
        : prepared(this.db, "SELECT * FROM task_links WHERE to_id = ? ORDER BY created_at").all(
            toId,
          )
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

  /** Every edge from or to one of these tasks, oldest first, as `listAll` orders them. */
  listTouching(ids: readonly string[]): TaskLink[] {
    if (ids.length === 0) return [];
    const json = JSON.stringify(ids);
    const rows = prepared(
      this.db,
      `SELECT * FROM task_links
       WHERE from_id IN (SELECT value FROM json_each(?))
          OR to_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, from_id, to_id`,
    ).all(json, json) as Row[];
    return rows.map(fromRow);
  }

  /** Every link one task is on, at either end. */
  deleteFor(taskId: string): void {
    this.db.prepare("DELETE FROM task_links WHERE from_id = ? OR to_id = ?").run(taskId, taskId);
  }

  deleteAll(): void {
    this.db.prepare("DELETE FROM task_links").run();
  }
}
