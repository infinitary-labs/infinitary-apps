import type { AppDatabase } from "./db";

/**
 * The per-task timeline (task-system design section 4.4): every state
 * change commits with the event that explains it, in the same transaction.
 * `text` is the timeline line; `feed = 0` keeps a crewmate's own notes out
 * of the global feed, which reads this table since P3
 * (src/core/tasks/taskFeed.ts authors the feed line from event and record).
 */

export type TaskEventActor = "captain" | "firstmate" | "crewmate" | "supervisor" | "host";

export type TaskEventKind =
  | "created"
  | "ask"
  | "answered"
  | "briefed"
  | "dispatched"
  | "steered"
  | "progress"
  | "report"
  | "failed"
  | "card_raised"
  | "card_resolved"
  | "status"
  | "linked"
  | "unlinked"
  | "moved"
  | "pr_opened"
  | "ci"
  | "landed"
  | "merged"
  | "triaged"
  | "note"
  | "compacted"
  | "interrupted"
  | "decided"
  | "escalated"
  | "review"
  | "cap_reset"
  | "replied";

export type TaskEvent = {
  id: number;
  taskId: string;
  at: number;
  actor: TaskEventActor;
  kind: TaskEventKind;
  text: string;
  data: Record<string, unknown> | null;
  ref: string | null;
  feed: boolean;
};

export type InsertTaskEvent = Omit<TaskEvent, "id" | "data" | "ref" | "feed"> &
  Partial<Pick<TaskEvent, "data" | "ref" | "feed">>;

/**
 * How an event's task stands to another task the event concerns, read from
 * the typed links when the event was written (docs/task-record.md, "Whom an
 * event concerns"): it is a `part` of that task, its `parent`, a `follow-up`
 * filed from it, its `origin`, a `blocker` it waits for, a `waiter` waiting
 * for it, its `replacement`, the task it `replaced`, work `built-on` it (the
 * event's task names it as its basis), or `related` to it.
 */
export const TASK_CONCERN_RELATIONS = [
  "part",
  "parent",
  "follow-up",
  "origin",
  "blocker",
  "waiter",
  "replacement",
  "replaced",
  "built-on",
  "related",
] as const;
export type TaskConcernRelation = (typeof TASK_CONCERN_RELATIONS)[number];

/** One other task an event concerns: `via`, the task a replacement carried it through. */
export type TaskConcern = { taskId: string; relation: TaskConcernRelation; via: string | null };

/** An event another task wrote, as a task it concerns reads it. */
export type ConcernedTaskEvent = TaskEvent & { relation: TaskConcernRelation; via: string | null };

type Row = {
  id: number;
  task_id: string;
  at: number;
  actor: TaskEventActor;
  kind: TaskEventKind;
  text: string;
  data_json: string | null;
  ref: string | null;
  feed: number;
};

function fromRow(row: Row): TaskEvent {
  let data: Record<string, unknown> | null = null;
  if (row.data_json) {
    try {
      data = JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  return {
    id: row.id,
    taskId: row.task_id,
    at: row.at,
    actor: row.actor,
    kind: row.kind,
    text: row.text,
    data,
    ref: row.ref,
    feed: row.feed === 1,
  };
}

export class TaskEventStore {
  constructor(private readonly db: AppDatabase) {}

  insert(event: InsertTaskEvent): number {
    const result = this.db
      .prepare(
        "INSERT INTO task_events (task_id, at, actor, kind, text, data_json, ref, feed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.taskId,
        event.at,
        event.actor,
        event.kind,
        event.text,
        event.data ? JSON.stringify(event.data) : null,
        event.ref ?? null,
        (event.feed ?? true) ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  /** The other tasks an event concerns, written with it (migration 71). */
  insertConcerns(eventId: number, concerns: readonly TaskConcern[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO task_event_concerns (event_id, task_id, relation, via) VALUES (?, ?, ?, ?)",
    );
    for (const concern of concerns) {
      insert.run(eventId, concern.taskId, concern.relation, concern.via);
    }
  }

  /** Every event of other tasks that concerns this one, in timeline order. */
  listConcerning(taskId: string): ConcernedTaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, c.relation AS relation, c.via AS via FROM task_event_concerns c
         JOIN task_events e ON e.id = c.event_id
         WHERE c.task_id = ? ORDER BY e.at, e.id`,
      )
      .all(taskId) as (Row & { relation: TaskConcernRelation; via: string | null })[];
    return rows.map((row) => ({ ...fromRow(row), relation: row.relation, via: row.via }));
  }

  /** Every concern row, oldest event first (the task export carries them). */
  listAllConcerns(): (TaskConcern & { eventId: number })[] {
    const rows = this.db
      .prepare(
        "SELECT event_id, task_id, relation, via FROM task_event_concerns ORDER BY event_id, task_id",
      )
      .all() as {
      event_id: number;
      task_id: string;
      relation: TaskConcernRelation;
      via: string | null;
    }[];
    return rows.map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      relation: row.relation,
      via: row.via,
    }));
  }

  /** The task whose newest event of `kind` carries `ref` (a card id → its task). */
  latestTaskForRef(kind: TaskEventKind, ref: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT task_id FROM task_events WHERE kind = ? AND ref = ? ORDER BY id DESC LIMIT 1",
      )
      .get(kind, ref) as { task_id: string } | undefined;
    return row?.task_id;
  }

  /** The inbox rows the supervisor's own steers (the idle ladder's nudges) rode on a task. */
  ladderSteerRows(taskId: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(data_json, '$.inboxId') AS row FROM task_events
         WHERE task_id = ? AND kind = 'steered' AND actor = 'supervisor'`,
      )
      .all(taskId) as { row: number | null }[];
    return rows.flatMap((entry) => (typeof entry.row === "number" ? [entry.row] : []));
  }

  countFor(taskId: string, except: readonly TaskEventKind[] = []): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?${exclusion(except)}`)
      .get(taskId, ...except) as { n: number };
    return row.n;
  }

  /** The oldest `limit` events of a task, in timeline order. */
  listOldest(taskId: string, limit: number, except: readonly TaskEventKind[] = []): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_events WHERE task_id = ?${exclusion(except)} ORDER BY at, id LIMIT ?`,
      )
      .all(taskId, ...except, limit) as Row[];
    return rows.map(fromRow);
  }

  /** Every event of a task at or before `at`, in timeline order. */
  listUpTo(taskId: string, at: number, except: readonly TaskEventKind[] = []): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_events WHERE task_id = ? AND at <= ?${exclusion(except)} ORDER BY at, id`,
      )
      .all(taskId, at, ...except) as Row[];
    return rows.map(fromRow);
  }

  deleteIds(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM task_event_concerns WHERE event_id IN (${marks})`).run(...ids);
    this.db.prepare(`DELETE FROM task_events WHERE id IN (${marks})`).run(...ids);
  }

  listFor(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY at, id")
      .all(taskId) as Row[];
    return rows.map(fromRow);
  }

  /**
   * Events of one kind newer than `since`, newest first, capped - the
   * contribution channel's backlog read (roadmap 1.4: the R2 `decided`
   * records not yet sent). `countByKindSince` is the whole backlog's size.
   */
  listByKindSince(kind: TaskEventKind, since: number, limit: number): TaskEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_events WHERE kind = ? AND at > ? ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(kind, since, limit) as Row[];
    return rows.map(fromRow);
  }

  /**
   * One actor's events whose `data.via` names `via`, at or after `since`,
   * newest first, across every task: the captain's task card clicks
   * (`TaskService.taskCardClicksSince`).
   */
  listByActorViaSince(actor: TaskEventActor, via: string, since: number): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_events
         WHERE at >= ? AND actor = ? AND json_extract(data_json, '$.via') = ?
         ORDER BY at DESC, id DESC`,
      )
      .all(since, actor, via) as Row[];
    return rows.map(fromRow);
  }

  countByKindSince(kind: TaskEventKind, since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind = ? AND at > ?")
      .get(kind, since) as { n: number };
    return row.n;
  }

  /** The newest feed-worthy events across every task, newest first. */
  listFeed(limit: number): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE feed = 1 ORDER BY at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(fromRow);
  }

  deleteAll(): void {
    this.db.prepare("DELETE FROM task_event_concerns").run();
    this.db.prepare("DELETE FROM task_events").run();
  }
}

/**
 * What compaction leaves alone: the kinds it names, and every event another
 * task's Activity reads (a `task_event_concerns` row), which stays verbatim.
 * Only compaction passes `except`.
 */
/**
 * What compaction leaves alone: the exempt kinds, events another task
 * reads, and events whose data marks them `journal: true` - a record a
 * replay reads back, such as a program's ask answers and its start.
 */
function exclusion(except: readonly TaskEventKind[]): string {
  if (except.length === 0) return "";
  return ` AND kind NOT IN (${except.map(() => "?").join(", ")}) AND id NOT IN (SELECT event_id FROM task_event_concerns) AND CASE WHEN json_valid(data_json) THEN coalesce(json_extract(data_json, '$.journal'), 0) ELSE 0 END != 1`;
}
