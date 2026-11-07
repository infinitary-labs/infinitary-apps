import type { Statement } from "better-sqlite3";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/**
 * The feed's grouped view, kept between reads (INF-2971's first finding).
 * The feed shows the newest feed-worthy events, with a program and its
 * direct parts sharing one row at their latest event (INF-1137, INF-1348).
 * Grouping the whole history on every read walked every feed-worthy event
 * on the main thread each time the feed changed, and its cost grew with
 * every day of use. This keeps the newest groups for each connection and,
 * on the next read, folds in only the feed-worthy events written since.
 *
 * What the fold cannot see from the new events alone makes the kept view
 * stale, and the next read groups again from the newest event backwards,
 * stopping once it holds enough groups: a feed-worthy event deleted,
 * changed or written below the newest one already read, a task's parent
 * changed or a task deleted, and a program written or removed. Connection
 * triggers (`TEMP`, never saved with the record) call back into this
 * module for each such write, whichever code made it. A read inside an
 * open transaction never keeps or uses the view, so a rolled-back write
 * cannot leave a row in it.
 */

/** A feed-worthy event row with the program it groups under, if any. */
export type GroupedFeedRow = Record<string, unknown> & {
  id: number;
  at: number;
  program_id: string | null;
};

type Kept = {
  /** False until the triggers are on this connection, or when they could not be made. */
  watched: boolean;
  stale: boolean;
  /** The largest event id the kept view has read past. */
  lastId: number;
  /** How many groups the kept view holds at most. */
  limit: number;
  /** The newest group rows, newest first. */
  rows: GroupedFeedRow[];
};

const kept = new WeakMap<AppDatabase, Kept>();

/** The connection function each trigger calls with the event id or 0 it touched. */
const TOUCH = "fm_feed_touched";

/** Each write the fold cannot see; `id` 0 makes the view stale whatever it read. */
const TRIGGERS: Record<string, string> = {
  fm_feed_event_inserted: `AFTER INSERT ON task_events WHEN NEW.feed = 1
    BEGIN SELECT ${TOUCH}(NEW.id); END`,
  fm_feed_event_updated: `AFTER UPDATE ON task_events WHEN OLD.feed = 1 OR NEW.feed = 1
    BEGIN SELECT ${TOUCH}(min(OLD.id, NEW.id)); END`,
  fm_feed_event_deleted: `AFTER DELETE ON task_events WHEN OLD.feed = 1
    BEGIN SELECT ${TOUCH}(OLD.id); END`,
  fm_feed_task_parent: `AFTER UPDATE OF parent_id ON tasks
    WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN SELECT ${TOUCH}(0); END`,
  fm_feed_task_deleted: `AFTER DELETE ON tasks BEGIN SELECT ${TOUCH}(0); END`,
  fm_feed_program_inserted: `AFTER INSERT ON task_programs BEGIN SELECT ${TOUCH}(0); END`,
  fm_feed_program_updated: `AFTER UPDATE ON task_programs
    WHEN OLD.value_json IS NOT NEW.value_json OR OLD.task_id IS NOT NEW.task_id
    BEGIN SELECT ${TOUCH}(0); END`,
  fm_feed_program_deleted: `AFTER DELETE ON task_programs BEGIN SELECT ${TOUCH}(0); END`,
};

const PROGRAM = `CASE
  WHEN json_type(parent_program.value_json, '$.program') = 'object' THEN t.parent_id
  WHEN json_type(own_program.value_json, '$.program') = 'object' THEN t.id
END`;

// CROSS JOIN keeps the events outermost, so the newest-first walk follows
// task_events_feed and stops when the caller stops reading.
const GROUPED = `SELECT e.*, ${PROGRAM} AS program_id
  FROM task_events e
  CROSS JOIN tasks t ON t.id = e.task_id
  LEFT JOIN task_programs parent_program ON parent_program.task_id = t.parent_id
  LEFT JOIN task_programs own_program ON own_program.task_id = t.id`;

const NEWEST_FIRST = `${GROUPED} WHERE e.feed = 1 ORDER BY e.at DESC, e.id DESC`;
const WRITTEN_SINCE = `${GROUPED} WHERE e.id > ? AND e.feed = 1 ORDER BY e.id`;
const LAST_ID = "SELECT MAX(id) AS id FROM task_events";

/** The group a row belongs to: its program, or the event alone. */
function groupOf(row: GroupedFeedRow): string {
  return row.program_id === null ? `event:${row.id}` : `program:${row.program_id}`;
}

function newerFirst(a: GroupedFeedRow, b: GroupedFeedRow): number {
  return b.at - a.at || b.id - a.id;
}

/**
 * The newest `limit` groups, newest first, each at its latest event: what
 * a window over every feed-worthy event would answer, read newest first
 * and stopped once `limit` groups are found. A group's later events are
 * older than its first, and a group first seen after that is older than
 * every group already held.
 */
function groupNewest(db: AppDatabase, limit: number, walk?: Statement): GroupedFeedRow[] {
  const groups = new Map<string, GroupedFeedRow>();
  if (limit <= 0) return [];
  for (const row of (walk ?? db.prepare(NEWEST_FIRST)).iterate() as Iterable<GroupedFeedRow>) {
    const group = groupOf(row);
    if (groups.has(group)) continue;
    groups.set(group, row);
    if (groups.size >= limit) break;
  }
  return [...groups.values()];
}

/** Folds rows written since into the kept groups, newest first, at most `limit`. */
function fold(rows: GroupedFeedRow[], written: GroupedFeedRow[], limit: number): GroupedFeedRow[] {
  const groups = new Map(rows.map((row) => [groupOf(row), row]));
  for (const row of written) {
    const group = groupOf(row);
    const held = groups.get(group);
    if (!held || newerFirst(row, held) < 0) groups.set(group, row);
  }
  return [...groups.values()].sort(newerFirst).slice(0, limit);
}

function lastId(db: AppDatabase): number {
  return (prepared(db, LAST_ID).get() as { id: number | null }).id ?? 0;
}

/** Puts the triggers on this connection once; false when it cannot. */
function watch(db: AppDatabase, state: Kept): boolean {
  if (state.watched) return true;
  try {
    db.function(TOUCH, { deterministic: false }, (id: unknown) => {
      if (typeof id !== "number" && typeof id !== "bigint") return null;
      if (Number(id) <= state.lastId) state.stale = true;
      return null;
    });
    for (const [name, body] of Object.entries(TRIGGERS))
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} ${body}`);
  } catch {
    return false;
  }
  state.watched = true;
  state.stale = true;
  return true;
}

/** Each connection's newest-first walk, iterated, so never shared through `prepared`. */
const walks = new WeakMap<AppDatabase, Statement>();

/**
 * The newest `limit` feed groups, newest first. Reads only what was
 * written since the last read on this connection while the kept view
 * holds; groups again from the newest event backwards when it does not.
 */
export function feedGroups(db: AppDatabase, limit: number): GroupedFeedRow[] {
  let state = kept.get(db);
  if (!state) {
    state = { watched: false, stale: true, lastId: 0, limit: 0, rows: [] };
    kept.set(db, state);
  }
  if (db.inTransaction || !watch(db, state)) return groupNewest(db, limit);
  if (state.stale || limit > state.limit) {
    let walk = walks.get(db);
    if (!walk) {
      walk = db.prepare(NEWEST_FIRST);
      walks.set(db, walk);
    }
    state.lastId = lastId(db);
    state.rows = groupNewest(db, limit, walk);
    state.limit = limit;
    state.stale = false;
    return state.rows.slice(0, limit);
  }
  const written = prepared(db, WRITTEN_SINCE).all(state.lastId) as GroupedFeedRow[];
  if (written.length > 0) {
    state.rows = fold(state.rows, written, state.limit);
    state.lastId = Math.max(state.lastId, ...written.map((row) => row.id));
  }
  return state.rows.slice(0, limit);
}
