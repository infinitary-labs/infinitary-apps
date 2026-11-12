import { foldForSearch } from "@shared/searchText";
import { taskStatusSchema } from "@shared/tasks";
import type { TaskQueryInput } from "../tasks/taskQuery";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/** The compact selection for `tasks`; bodies are loaded only for its page. */
export type TaskSelection = { ids: string[]; total: number; order?: string[] };
export type TaskSelectionInput = Pick<TaskQueryInput, "status" | "text" | "snapshot"> & {
  projectId?: string;
  parentId?: string;
  limit: number;
  skip: number;
};

/**
 * The window's search of earlier work (`TaskProtocol.search`): the typed
 * text as typed (the search trims and folds it), the start of the board's
 * window and how many to answer.
 */
export type ClosedTaskSearchInput = { text: string; recentFrom: number; limit: number };
/** The ids it found, newest closed first; the views are composed from these alone. */
export type ClosedTaskSearch = { ids: string[] };

const registered = new WeakSet<AppDatabase>();
export function registerTaskSearch(db: AppDatabase): void {
  if (registered.has(db)) return;
  db.function("task_search_fold", { deterministic: true }, (value: string) => foldForSearch(value));
  registered.add(db);
}

const STATUS_ORDER = { active: 0, open: 1, done: 2, dropped: 3 };
type Match = {
  id: string;
  status: keyof typeof STATUS_ORDER;
  priority: number;
  updated_at: number;
  created_at: number;
  seq: number;
};

/** Seek the requested status partitions and return only matching rows, never full task bodies. */
export function selectTasks(db: AppDatabase, input: TaskSelectionInput): TaskSelection {
  registerTaskSearch(db);
  const statuses =
    input.status === "live"
      ? ["open", "active"]
      : input.status === "closed"
        ? ["done", "dropped"]
        : input.status
          ? [input.status]
          : taskStatusSchema.options;
  const where = ["status IN (SELECT value FROM json_each(?))"];
  const params: string[] = [JSON.stringify(statuses)];
  if (input.projectId) {
    where.push("project_id = ?");
    params.push(input.projectId);
  }
  if (input.parentId) {
    where.push("parent_id = ?");
    params.push(input.parentId);
  }
  const needle = input.text?.trim();
  if (needle) {
    where.push(
      "(instr(task_search_fold(title), ?) > 0 OR instr(task_search_fold(COALESCE(goal, '')), ?) > 0)",
    );
    params.push(foldForSearch(needle), foldForSearch(needle));
  }
  const matches = prepared(
    db,
    `SELECT id, status, priority, updated_at, created_at, seq FROM task_records WHERE ${where.join(" AND ")}`,
  ).all(...params) as Match[];
  // Ordering these compact matches in the reader avoids a SQLite temporary
  // sort of the wide record projection; page, total and kept order share this read.
  matches.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.priority - b.priority ||
      b.updated_at - a.updated_at ||
      a.created_at - b.created_at ||
      a.seq - b.seq,
  );
  const ids = matches.slice(input.skip, input.skip + input.limit).map((row) => row.id);
  return {
    ids,
    total: matches.length,
    ...(input.snapshot && matches.length > ids.length
      ? { order: matches.map((row) => row.id) }
      : {}),
  };
}

type ClosedMatch = { id: string; closed_at: number | null; created_at: number; seq: number };

/**
 * Closed work the board does not list - dropped work of any age, any work
 * closed before `recentFrom`, and a question, decision or operation closed
 * within the window - whose key, title or goal holds the folded text, newest
 * closed first, at most `limit`. SQLite seeks the closed rows and matches
 * them, so only the matches' ids leave this read: the record process answers
 * the window's searches with it, off the main thread (docs/task-record.md).
 */
export function selectClosedTasks(db: AppDatabase, input: ClosedTaskSearchInput): ClosedTaskSearch {
  const needle = foldForSearch(input.text.trim());
  if (!needle) return { ids: [] };
  registerTaskSearch(db);
  const matches = prepared(
    db,
    `SELECT id, closed_at, created_at, seq FROM task_records
     WHERE status IN ('done', 'dropped')
       AND (status = 'dropped' OR kind <> 'work' OR COALESCE(closed_at, 0) < ?)
       AND (instr(task_search_fold(COALESCE(key, '')), ?) > 0
         OR instr(task_search_fold(title), ?) > 0
         OR instr(task_search_fold(COALESCE(goal, '')), ?) > 0)`,
  ).all(input.recentFrom, needle, needle, needle) as ClosedMatch[];
  // Sorting the compact matches here keeps SQLite from a temporary sort.
  matches.sort(
    (a, b) =>
      (b.closed_at ?? 0) - (a.closed_at ?? 0) || a.created_at - b.created_at || a.seq - b.seq,
  );
  return { ids: matches.slice(0, input.limit).map((row) => row.id) };
}
