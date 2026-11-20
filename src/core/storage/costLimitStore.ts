import { type CostLimit, costLimitSchema } from "@shared/costLimit";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/** Where a limit below the app's own is set: on one task, or on one project. */
export type CostLimitScope = "task" | "project";

/**
 * A task held at its cost limit (docs/usage.md, "The cost limit"): the
 * limit it passed and what it and everything under it had spent then. It
 * stands until the captain answers its card or their words pass it.
 */
export type CostHold = { taskId: string; limitUsd: number; spentUsd: number; at: number };

/** What a task and everything under it spent, as the usage ledger estimates it. */
export type FamilySpend = {
  /** Estimated dollars, summed over every priced record. */
  usd: number;
  /** Records the ledger could not price: they add nothing, and the card says so. */
  unpriced: number;
};

/**
 * The cost limits below the app's own and the holds they place
 * (docs/usage.md, "The cost limit"). The one writer of `cost_limits` and
 * `cost_holds`; the app's own limit lives in settings
 * (`SettingsStore.getTaskCostLimit`).
 */
export class CostLimitStore {
  constructor(private readonly db: AppDatabase) {}

  /** The limit set on one task or one project, or null when it follows the next level. */
  limitOf(scope: CostLimitScope, ownerId: string): CostLimit | null {
    const row = prepared(
      this.db,
      "SELECT limit_json FROM cost_limits WHERE scope = ? AND owner_id = ?",
    ).get(scope, ownerId) as { limit_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = costLimitSchema.safeParse(JSON.parse(row.limit_json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** The nearest explicit answer on this task or above it, before project/app defaults. */
  taskLimit(taskId: string): { limit: CostLimit; taskId: string } | undefined {
    const seen = new Set<string>();
    let id: string | null = taskId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const limit = this.limitOf("task", id);
      if (limit) return { limit, taskId: id };
      const row = prepared(this.db, "SELECT parent_id FROM tasks WHERE id = ?").get(id) as
        | { parent_id: string | null }
        | undefined;
      id = row?.parent_id ?? null;
    }
    return undefined;
  }

  /** Sets one task's or one project's limit; null lets it follow the next level again. */
  setLimit(scope: CostLimitScope, ownerId: string, limit: CostLimit | null, at: number): void {
    if (limit === null) {
      prepared(this.db, "DELETE FROM cost_limits WHERE scope = ? AND owner_id = ?").run(
        scope,
        ownerId,
      );
      return;
    }
    prepared(
      this.db,
      `INSERT INTO cost_limits (scope, owner_id, limit_json, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, owner_id) DO UPDATE SET limit_json = excluded.limit_json, at = excluded.at`,
    ).run(scope, ownerId, JSON.stringify(costLimitSchema.parse(limit)), at);
  }

  /** The hold standing on a task, if one does. */
  hold(taskId: string): CostHold | undefined {
    const row = prepared(
      this.db,
      "SELECT task_id, limit_usd, spent_usd, at FROM cost_holds WHERE task_id = ?",
    ).get(taskId) as HoldRow | undefined;
    return row ? holdOf(row) : undefined;
  }

  placeHold(hold: CostHold): void {
    prepared(
      this.db,
      `INSERT INTO cost_holds (task_id, limit_usd, spent_usd, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET limit_usd = excluded.limit_usd,
         spent_usd = excluded.spent_usd, at = excluded.at`,
    ).run(hold.taskId, hold.limitUsd, hold.spentUsd, hold.at);
  }

  /** Lifts a task's hold; whether one stood. */
  clearHold(taskId: string): boolean {
    return prepared(this.db, "DELETE FROM cost_holds WHERE task_id = ?").run(taskId).changes > 0;
  }

  /**
   * What a task and every task under it spent, read from the usage ledger:
   * the captain's choice on INF-3112's plan, so a program's parts, a plan's
   * pieces and a review count against the task they sit under.
   */
  familySpend(taskId: string): FamilySpend {
    const row = prepared(
      this.db,
      `WITH RECURSIVE family(id) AS (
         SELECT ?
         UNION SELECT tasks.id FROM tasks JOIN family ON tasks.parent_id = family.id
       )
       SELECT COALESCE(SUM(CASE WHEN cost > 0 THEN cost END), 0) AS usd,
              COALESCE(SUM(CASE WHEN cost > 0 THEN 0 ELSE 1 END), 0) AS unpriced
       FROM usage_events WHERE task_id IN (SELECT id FROM family)`,
    ).get(taskId) as { usd: number; unpriced: number };
    return { usd: row.usd, unpriced: row.unpriced };
  }

  /**
   * Of the task families - a task with nothing above it, and everything
   * under it - that spent anything since `since`, how many spent `limitUsd`
   * or more then: the tasks the limit would have asked about. Reads each
   * record since then once, by time, and walks up the tasks they name.
   */
  recent(limitUsd: number | null, since: number): { asked: number; tasks: number } {
    const rows = prepared(this.db, "SELECT task_id, cost FROM usage_events WHERE at >= ?").all(
      since,
    ) as { task_id: string; cost: number | null }[];
    const spent = new Map<string, number>();
    for (const row of rows)
      spent.set(
        row.task_id,
        (spent.get(row.task_id) ?? 0) + (row.cost && row.cost > 0 ? row.cost : 0),
      );
    const parentOf = new Map<string, string | null>();
    const known = new Set<string>();
    let unknown = [...spent.keys()];
    while (unknown.length > 0) {
      const found = prepared(
        this.db,
        "SELECT id, parent_id FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
      ).all(JSON.stringify(unknown)) as { id: string; parent_id: string | null }[];
      for (const id of unknown) parentOf.set(id, null);
      for (const row of found) {
        parentOf.set(row.id, row.parent_id);
        known.add(row.id);
      }
      unknown = found
        .map((row) => row.parent_id)
        .filter((id): id is string => id !== null && !parentOf.has(id));
    }
    const families = new Map<string, number>();
    for (const [taskId, usd] of spent) {
      // Only recorded tasks: the first mate's own conversation is not one.
      if (!known.has(taskId)) continue;
      let top = taskId;
      const seen = new Set<string>();
      for (let up = parentOf.get(top); up && !seen.has(up); up = parentOf.get(top)) {
        seen.add(top);
        top = up;
      }
      families.set(top, (families.get(top) ?? 0) + usd);
    }
    let asked = 0;
    if (limitUsd !== null) for (const usd of families.values()) if (usd >= limitUsd) asked++;
    return { asked, tasks: families.size };
  }
}

type HoldRow = { task_id: string; limit_usd: number; spent_usd: number; at: number };

function holdOf(row: HoldRow): CostHold {
  return { taskId: row.task_id, limitUsd: row.limit_usd, spentUsd: row.spent_usd, at: row.at };
}
