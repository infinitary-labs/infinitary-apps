import { TAG_CHECK_WEEK_DAYS, type TagCheckReach } from "@shared/tagCheck";
import type { AppDatabase } from "./db";

/**
 * What the decision model has left to judge (docs/task-tags.md, "Automatic
 * tagging"), read from `tasks`, `project_tags` and `task_tags` and never
 * written: `TaskService` writes the judgments. Every read answers the next
 * task's pairs only, newest task first, so a long record is never loaded.
 *
 * A pair is judged when its row was set by a person or the first mate, or
 * set by the decision model at the tag's current description revision. A
 * decision-model row with no revision is one whose task's words changed or
 * whose task moved on its own into the project, which automatic tagging
 * asks again; one carried from an emptied project holds `STALE_JUDGMENT`,
 * which only a check asks.
 */

/** One task and the tags to ask about it. */
export type TagWorkItem = { taskId: string; tagIds: string[] };

/** A check's tasks: its project, its reach, the tags it asks and when it started. */
export type TagCheckScope = {
  projectId: string;
  reach: TagCheckReach;
  tagIds: readonly string[] | null;
  at: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows a next-task read takes: more than any one task's tags, so the first task's pairs are whole. */
const PAIRS = 1000;

// i18n-exempt: SQL, never shown to a person
const OPEN = "t.status IN ('open', 'active')";

function reachClause(reach: TagCheckReach): string {
  if (reach === "open") return OPEN;
  // i18n-exempt: SQL, never shown to a person
  if (reach === "week") return `(${OPEN} OR (t.status = 'done' AND t.closed_at >= @since))`;
  return "1";
}

/** A pair a check asks: no row yet, or the decision model's at another description, or none. */
// i18n-exempt: SQL, never shown to a person
const UNJUDGED =
  "(x.task_id IS NULL OR (x.set_by = 'decision' AND (x.revision IS NULL OR x.revision != p.revision)))";

export class TagWork {
  constructor(private readonly db: AppDatabase) {}

  private present: boolean | undefined;
  /** A record opened at an older version has no tags tables and holds no work. */
  private exists(): boolean {
    this.present ??=
      this.db
        // i18n-exempt: SQL, never shown to a person
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_tags'")
        .get() !== undefined;
    return this.present;
  }

  /**
   * The newest task automatic tagging owes a request: a tag of its project
   * with no row, on a task filed after `since` and no earlier than the tag;
   * or a decision-model row with no revision. Tasks in `skip` wait out a
   * failed request. Each half seeks its rows by an index (`tasks_created_at`,
   * `task_tags_unjudged`), and `TaskTagger` moves `since` up to the newest
   * task whenever nothing is owed, so a long record is never walked.
   */
  nextAuto(since: number, skip: readonly string[]): TagWorkItem | undefined {
    if (!this.exists()) return undefined;
    const rows = this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `SELECT task_id, tag_id FROM (
           SELECT t.id AS task_id, p.id AS tag_id, t.created_at AS created_at FROM tasks t INDEXED BY tasks_created_at
           JOIN project_tags p ON p.project_id = t.project_id
           LEFT JOIN task_tags x ON x.task_id = t.id AND x.tag_id = p.id
           WHERE t.created_at > @since AND t.created_at >= p.created_at AND x.task_id IS NULL
           UNION
           SELECT t.id, p.id, t.created_at FROM task_tags x
           JOIN tasks t ON t.id = x.task_id
           JOIN project_tags p ON p.id = x.tag_id AND p.project_id = t.project_id
           WHERE x.set_by = 'decision' AND x.revision IS NULL
         )
         WHERE task_id NOT IN (SELECT value FROM json_each(@skip))
         ORDER BY created_at DESC, task_id LIMIT ${PAIRS}`,
      )
      .all({ since, skip: JSON.stringify(skip) }) as { task_id: string; tag_id: string }[];
    return firstItem(rows);
  }

  /** When the newest task was filed, read from `tasks_created_at` alone; null with no tasks. */
  newestFiled(): number | null {
    const row = this.db
      // i18n-exempt: SQL, never shown to a person
      .prepare("SELECT MAX(created_at) AS at FROM tasks")
      .get() as { at: number | null };
    return row.at;
  }

  /** The newest task a check still owes a request, outside `skip`. */
  nextCheck(scope: TagCheckScope, skip: readonly string[]): TagWorkItem | undefined {
    if (!this.exists()) return undefined;
    const rows = this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `SELECT t.id AS task_id, p.id AS tag_id FROM tasks t
         JOIN project_tags p ON p.project_id = t.project_id
         LEFT JOIN task_tags x ON x.task_id = t.id AND x.tag_id = p.id
         WHERE t.project_id = @project AND t.created_at <= @at AND ${reachClause(scope.reach)}
           AND (@tags IS NULL OR p.id IN (SELECT value FROM json_each(@tags)))
           AND ${UNJUDGED}
           AND t.id NOT IN (SELECT value FROM json_each(@skip))
         ORDER BY t.created_at DESC, t.id LIMIT ${PAIRS}`,
      )
      .all(this.params(scope, { skip: JSON.stringify(skip) })) as {
      task_id: string;
      tag_id: string;
    }[];
    return firstItem(rows);
  }

  /** How many tasks a check of this scope still owes a request: one request each. */
  remaining(scope: TagCheckScope): number {
    if (!this.exists()) return 0;
    const row = this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `SELECT COUNT(DISTINCT t.id) AS n FROM tasks t
         JOIN project_tags p ON p.project_id = t.project_id
         LEFT JOIN task_tags x ON x.task_id = t.id AND x.tag_id = p.id
         WHERE t.project_id = @project AND t.created_at <= @at AND ${reachClause(scope.reach)}
           AND (@tags IS NULL OR p.id IN (SELECT value FROM json_each(@tags)))
           AND ${UNJUDGED}`,
      )
      .get(this.params(scope, {})) as { n: number };
    return row.n;
  }

  private params(scope: TagCheckScope, extra: Record<string, string>) {
    return {
      project: scope.projectId,
      at: scope.at,
      since: scope.at - TAG_CHECK_WEEK_DAYS * DAY_MS,
      tags: scope.tagIds ? JSON.stringify(scope.tagIds) : null,
      ...extra,
    };
  }
}

/** The first task's pairs, in the order the query ranked them. */
function firstItem(rows: readonly { task_id: string; tag_id: string }[]): TagWorkItem | undefined {
  const first = rows[0];
  if (!first) return undefined;
  return {
    taskId: first.task_id,
    tagIds: rows.filter((row) => row.task_id === first.task_id).map((row) => row.tag_id),
  };
}
