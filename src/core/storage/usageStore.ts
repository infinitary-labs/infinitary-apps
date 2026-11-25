import { type FmModelUsage, type FmUsage, usageCostSourceSchema } from "@shared/events";
import type { ObserveUsageModel } from "@shared/observe";
import {
  addUsageAmounts,
  COST_WINDOW_DAYS,
  EMPTY_USAGE_AMOUNT,
  USAGE_WORK_KINDS,
  type UsageAmount,
  type UsageAttribution,
  type UsageModel,
  type UsagePlace,
  type UsagePriceSource,
  type UsageProject,
  type UsageQuery,
  type UsageSummary,
  type UsageTask,
  type UsageTaskCost,
  type UsageTaskCosts,
  type UsageTaskCostsQuery,
  type UsageTasks,
  type UsageTasksQuery,
  type UsageWhere,
  type UsageWorkKind,
  usageTokens,
} from "@shared/usage";
import type { AppDatabase } from "./db";
import { taskReadTable } from "./taskRecordFields";
import { foldUsageDays, USAGE_DAY_SUMS } from "./usageDays";

/**
 * The per-account usage ledger (broker phase 2, D-18): one `usage_events`
 * row per reported call and model, keyed by the task and the account that
 * served it. Cost comes from the session's own usage (Pi's listed
 * prices, Claude's own estimate) - never a proxy, and never a zero the
 * session could not price. The one writer of the table; the published
 * views read it through `views.ts`. Observe's `byTask` and the Usage tab's
 * `summary` and `tasks` add up its daily totals (`usageDays.ts`), never
 * every row (docs/usage.md, "Daily totals").
 */

export type UsageInput = {
  taskId: string;
  accountId?: string;
  /** The model the session asked for. */
  model?: { provider: string; id: string };
  usage: FmUsage;
  at: number;
};

/**
 * How a row names its model (docs/usage.md): `served` is the model the
 * provider said answered, `requested` the model the session asked for.
 * Null on a row recorded before the column: the model recorded then, which
 * for Claude may sum several.
 */
export type ModelSource = "served" | "requested";

/** One ledger row as `UsageStore.record` wrote it; a token kind or cost the session left out stays null. */
export type UsageRow = {
  taskId: string;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  modelSource: ModelSource | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  at: number;
};

/** The Firstmate's own conversation keeps its usage under this task id (orchestrator/homeFirstmate.ts). */
export const FIRSTMATE_USAGE_TASK_ID = "firstmate";

/** How the summary names a model and a provider: the names Settings gives them. */
export type UsageNames = {
  model: (ref: { provider: string; id: string }) => string;
  provider: (provider: string) => string;
};

/** The largest tasks a summary names, per unit. */
const LARGEST_TASKS = 3;

/** The days each period covers, today included. */
const PERIOD_DAYS = { "7d": 7, "30d": 30 } as const;

function periodStart(period: UsageQuery["period"], now: number): number | null {
  return period === "all" ? null : localDayStart(now, 1 - PERIOD_DAYS[period]);
}

/** What the summary knows of a task: how it is named, its project and its saved kind. */
type TaskFacts = NonNullable<UsagePlace["task"]> & {
  projectId: string | null;
  kind: UsageWorkKind | null;
};

/** Ledger records summed into one amount's columns (`USAGE_DAY_SUMS`). */
type AmountRow = {
  records: number;
  counted: number;
  reported_input: number;
  reported_output: number;
  reported_cache_read: number;
  reported_cache_write: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  priced: number;
  cost_input: number | null;
  cost_output: number | null;
  cost_cache_read: number | null;
  cost_cache_write: number | null;
  split: number;
};

/** One grouped slice of the ledger: a local day, a model and its sources, a place. */
type LedgerGroup = AmountRow & {
  day: string;
  provider: string | null;
  model: string | null;
  model_source: ModelSource | null;
  cost_source: string | null;
  kind: UsagePlace["kind"];
  task_id: string | null;
};

function amountOf(group: AmountRow): UsageAmount {
  return {
    tokens: {
      input: group.input,
      output: group.output,
      cacheRead: group.cache_read,
      cacheWrite: group.cache_write,
    },
    records: group.records,
    counted: group.counted,
    tokenReported: {
      input: group.reported_input,
      output: group.reported_output,
      cacheRead: group.reported_cache_read,
      cacheWrite: group.reported_cache_write,
    },
    cost: group.cost,
    priced: group.priced,
    costParts: {
      input: group.cost_input,
      output: group.cost_output,
      cacheRead: group.cost_cache_read,
      cacheWrite: group.cost_cache_write,
    },
    split: group.split,
  };
}

export function localDate(at: number): string {
  const day = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function localDayStart(at: number, days = 0): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

function localDates(since: number, until: number): string[] {
  const dates: string[] = [];
  for (let day = localDayStart(since); day <= until; day = localDayStart(day, 1)) {
    dates.push(localDate(day));
  }
  return dates;
}

function sumBy<K>(
  groups: readonly LedgerGroup[],
  key: (group: LedgerGroup) => K,
): Map<K, UsageAmount> {
  const parts = new Map<K, UsageAmount[]>();
  for (const group of groups) {
    const at = key(group);
    const held = parts.get(at);
    if (held) held.push(amountOf(group));
    else parts.set(at, [amountOf(group)]);
  }
  return new Map([...parts].map(([at, amounts]) => [at, addUsageAmounts(amounts)]));
}

/** A place's identity: the Firstmate, other work, or one task. */
function placeKey(group: LedgerGroup): string {
  return group.kind === "task" ? `task:${group.task_id}` : group.kind;
}

/** A task's recorded sums and coverage; ledger rows are not conversation turns. */
export type UsageRollup = {
  task_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  records: number;
  reported: ObserveUsageModel["reported"];
  priced: number;
  last_at: number | null;
  first_at: number | null;
  models: ObserveUsageModel[];
};

export class UsageStore {
  /**
   * `folds: false` is the read-only record process's store
   * (`src/core/recordReads/`): it cannot write, so its reads take the daily
   * totals as the core's connection, their one writer, last folded them.
   */
  constructor(
    private readonly db: AppDatabase,
    private readonly options: { folds: boolean } = { folds: true },
  ) {}

  /** Brings the daily totals up to the ledger's newest row (`foldUsageDays`). */
  fold(): void {
    if (this.options.folds) foldUsageDays(this.db);
  }

  /** This calendar month's estimate from this account alone; missing prices are not free. */
  monthlyAccountEstimate(
    accountId: string,
    provider: string,
    now: number,
  ): { cost: number | null; partial: boolean } {
    const date = new Date(now);
    const first = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    const row = this.db
      .prepare(`
      SELECT SUM(cost) AS cost, COUNT(*) > COUNT(cost) AS incomplete
      FROM usage_events WHERE account_id = ? AND at >= ? AND at <= ? AND provider = ?
    `)
      .get(accountId, first, now, provider) as { cost: number | null; incomplete: number };
    return { cost: row.cost, partial: row.incomplete === 1 };
  }

  /** Writes one response's usage and answers the rows it wrote, one per served model. */
  record(input: UsageInput): UsageRow[] {
    const written: UsageRow[] = [];
    const insert = this.db.prepare(
      `INSERT INTO usage_events (task_id, account_id, provider, model, model_source,
         input, output, cache_read, cache_write, cost, cost_source,
         cost_input, cost_output, cost_cache_read, cost_cache_write, reasoning, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const row = (
      model: { provider: string | null; id: string } | undefined,
      source: ModelSource | null,
      counts: Omit<FmModelUsage, "model">,
    ) => {
      written.push({
        taskId: input.taskId,
        accountId: input.accountId ?? null,
        provider: model?.provider ?? null,
        model: model?.id ?? null,
        modelSource: model ? source : null,
        input: counts.input ?? null,
        output: counts.output ?? null,
        cacheRead: counts.cacheRead ?? null,
        cacheWrite: counts.cacheWrite ?? null,
        cost: counts.cost ?? null,
        at: input.at,
      });
      insert.run(
        input.taskId,
        input.accountId ?? null,
        model?.provider ?? null,
        model?.id ?? null,
        model ? source : null,
        counts.input ?? null,
        counts.output ?? null,
        counts.cacheRead ?? null,
        counts.cacheWrite ?? null,
        counts.cost ?? null,
        counts.cost === undefined ? null : (counts.costSource ?? null),
        counts.costParts?.input ?? null,
        counts.costParts?.output ?? null,
        counts.costParts?.cacheRead ?? null,
        counts.costParts?.cacheWrite ?? null,
        counts.reasoning ?? null,
        input.at,
      );
    };
    const served = input.usage.models ?? [];
    if (served.length === 0) {
      row(input.model, "requested", input.usage);
      return written;
    }
    this.db.transaction(() => {
      for (const { model, ...counts } of served) {
        row({ provider: input.model?.provider ?? null, id: model }, "served", counts);
      }
    })();
    return written;
  }

  /** The kind of work a task's shape saved, as the summary groups it; null when none or unknown. */
  workKind(taskId: string): UsageWorkKind | null {
    return this.taskFacts([taskId]).get(taskId)?.kind ?? null;
  }

  /**
   * Settings → Usage (docs/usage.md): the ledger over a period and kind of
   * work, grouped by local day, by provider and recorded model, and by
   * where it went. Finished tasks count work with a crewmate that started,
   * is done, and closed in the period; the milestones count them over all
   * retained history. Nothing here reads the newest model of a task: each
   * record keeps its own.
   */
  summary(query: UsageQuery, options: { now: number; names: UsageNames }): UsageSummary {
    const { now, names } = options;
    const periodSince = periodStart(query.period, now);
    this.fold();
    const groups = this.db
      .prepare(
        `WITH placed AS (
           SELECT d.*,
                  CASE WHEN d.task_id = @firstmate THEN 'firstmate'
                       WHEN t.id IS NOT NULL THEN 'task'
                       ELSE 'other' END AS kind,
                  t.id AS known_task
           FROM usage_days d
           LEFT JOIN tasks t ON t.id = d.task_id
           WHERE @since IS NULL OR d.day >= @since
         )
         SELECT day, provider, model, model_source, cost_source, kind, known_task AS task_id,
                ${USAGE_DAY_SUMS}
         FROM placed
         WHERE @scope = 'all' OR kind = @scope
         GROUP BY day, provider, model, model_source, cost_source, kind, known_task`,
      )
      .all({
        firstmate: FIRSTMATE_USAGE_TASK_ID,
        since: periodSince === null ? null : localDate(periodSince),
        scope: query.scope,
      }) as LedgerGroup[];

    // All time starts on the first day anything was recorded.
    const firstDay = groups.reduce<string | null>(
      (first, group) => (first === null || group.day < first ? group.day : first),
      null,
    );
    const since =
      periodSince ?? (firstDay === null ? null : new Date(`${firstDay}T00:00:00`).getTime());
    const byDay = sumBy(groups, (group) => group.day);
    const days =
      since === null
        ? []
        : localDates(since, now).map((date) => ({
            date,
            amount: byDay.get(date) ?? EMPTY_USAGE_AMOUNT,
          }));

    const tasks = this.taskFactsOf(groups);
    const places = (slice: readonly LedgerGroup[]): UsagePlace[] => {
      const amounts = [...sumBy(slice, placeKey)];
      const largest = (rank: (amount: UsageAmount) => number) =>
        amounts
          .filter(([key]) => key.startsWith("task:"))
          .sort(([, a], [, b]) => rank(b) - rank(a))
          .slice(0, LARGEST_TASKS)
          .map(([key]) => key);
      const named = new Set([...largest(usageTokens), ...largest((amount) => amount.cost ?? -1)]);
      return amounts.flatMap(([key, amount]): UsagePlace[] => {
        if (key === "firstmate" || key === "other") return [{ kind: key, task: null, amount }];
        if (!named.has(key)) return [];
        const task = tasks.get(key.slice("task:".length));
        return task
          ? [
              {
                kind: "task",
                task: { key: task.key, title: task.title, project: task.project },
                amount,
              },
            ]
          : [];
      });
    };

    const byModel = new Map<string, LedgerGroup[]>();
    for (const group of groups) {
      const key = modelKey(group);
      const slice = byModel.get(key);
      if (slice) slice.push(group);
      else byModel.set(key, [group]);
    }
    const models = [...byModel].map(([key, slice]): UsageModel => {
      const [first] = slice;
      const provider = first?.provider ?? null;
      const model = first?.model ?? null;
      return {
        id: key,
        ...modelNamesOf(provider, model, names),
        attribution: attributionOf(slice),
        priceSources: priceSourcesOf(slice),
        amount: addUsageAmounts(slice.map(amountOf)),
        places: places(slice),
        where: whereOf(slice, tasks),
      };
    });

    const finishedSince = (from: number | null) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks
             WHERE status = 'done' AND kind <> 'operation'
               AND assignee IS NOT NULL AND started_at IS NOT NULL
               AND closed_at IS NOT NULL AND (@from IS NULL OR closed_at >= @from)`,
          )
          .get({ from }) as { n: number }
      ).n;
    const finishedEver = finishedSince(null);
    return {
      query,
      since,
      at: now,
      total: addUsageAmounts(groups.map(amountOf)),
      days,
      models,
      places: places(groups),
      where: whereOf(groups, tasks),
      finished:
        query.scope === "all" || query.scope === "task"
          ? periodSince === null
            ? finishedEver
            : finishedSince(periodSince)
          : 0,
      finishedEver,
    };
  }

  private taskFactsOf(groups: readonly LedgerGroup[]): Map<string, TaskFacts> {
    return this.taskFacts([
      ...new Set(groups.flatMap((group) => (group.task_id ? [group.task_id] : []))),
    ]);
  }

  private taskFacts(ids: readonly string[]): Map<string, TaskFacts> {
    if (ids.length === 0) return new Map();
    // Read the two owners of the fields, not the compatibility view's composed shape.
    const split = taskReadTable(this.db) === "task_records";
    const contract = split ? "c.value_json" : "t.shape_json";
    const routing = split ? "r.value_json" : "t.shape_json";
    const rows = this.db
      .prepare(
        `SELECT t.id, t.key, t.title, p.id AS project_id, p.name AS project,
                CASE WHEN json_extract(${contract}, '$.deliverable') = 'operation' THEN 'operation'
                     ELSE json_extract(${routing}, '$.kind') END AS kind
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         ${
           split
             ? `LEFT JOIN task_contracts c ON c.task_id = t.id
                    LEFT JOIN task_routing_requests r ON r.task_id = t.id`
             : ""
}
         WHERE t.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as {
      id: string;
      key: string;
      title: string;
      project_id: string | null;
      project: string | null;
      kind: unknown;
    }[];
    return new Map(
      rows.map((row) => [
        row.id,
        {
          key: row.key,
          title: row.title,
          project: row.project,
          projectId: row.project_id,
          kind: workKindOf(row.kind),
        },
      ]),
    );
  }

  /**
   * Settings → Usage's recent tasks (docs/usage.md): every task with
   * recorded usage in the period and work, newest created first, the first
   * `limit` of them with their usage in the period and how much of each
   * category was reported. Ties on the moment break by task id, so a longer
   * read lists a shorter one's tasks first, in the same order.
   */
  tasks(query: UsageTasksQuery, options: { now: number }): UsageTasks {
    if (query.scope !== "all" && query.scope !== "task") return { query, tasks: [], matching: 0 };
    const since = periodStart(query.period, options.now);
    const params = {
      firstmate: FIRSTMATE_USAGE_TASK_ID,
      since: since === null ? null : localDate(since),
      limit: query.limit,
    };
    this.fold();
    // The task's daily totals in the period and work, summed over their own
    // columns before any task column joins them.
    const recorded = `recorded AS (
           SELECT d.* FROM usage_days d JOIN tasks t ON t.id = d.task_id
           WHERE d.task_id <> @firstmate AND (@since IS NULL OR d.day >= @since)
         )`;
    const { matching } = this.db
      .prepare(`WITH ${recorded} SELECT COUNT(DISTINCT task_id) AS matching FROM recorded`)
      .get(params) as { matching: number };
    const rows = this.db
      .prepare(
        `WITH ${recorded},
         summed AS (
           SELECT task_id,
                  ${USAGE_DAY_SUMS}
           FROM recorded
           GROUP BY task_id
         )
         SELECT summed.*, t.key, t.title, t.created_at, p.name AS project
         FROM summed
         JOIN tasks t ON t.id = summed.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT @limit`,
      )
      .all(params) as (AmountRow & {
      key: string;
      title: string;
      created_at: number;
      project: string | null;
      cost_reported_input: number;
      cost_reported_output: number;
      cost_reported_cache_read: number;
      cost_reported_cache_write: number;
    })[];
    return {
      query,
      matching,
      tasks: rows.map(
        (row): UsageTask => ({
          task: { key: row.key, title: row.title, project: row.project },
          createdAt: row.created_at,
          amount: amountOf(row),
          reported: {
            input: row.reported_input,
            output: row.reported_output,
            cacheRead: row.reported_cache_read,
            cacheWrite: row.reported_cache_write,
          },
          costReported: {
            input: row.cost_reported_input,
            output: row.cost_reported_output,
            cacheRead: row.cost_reported_cache_read,
            cacheWrite: row.cost_reported_cache_write,
          },
        }),
      ),
    };
  }

  /**
   * Settings → Usage's Cost per task (docs/usage.md, INF-6217's plan): each
   * task that finished in the period, or in the window before it, with what
   * it and its reviews spent over their whole lives. A review is the task
   * under the one it checks whose saved kind is review; it, and anything
   * under it, adds to that task and is never a point of its own. Finished is
   * the summary's rule. Reads the daily totals, never the ledger.
   */
  taskCosts(query: UsageTaskCostsQuery, options: { now: number }): UsageTaskCosts {
    this.fold();
    const periodSince = periodStart(query.period, options.now);
    const reach = periodSince === null ? null : localDayStart(periodSince, -COST_WINDOW_DAYS);
    // Read the two owners of the fields, not the compatibility view's composed shape.
    const split = taskReadTable(this.db) === "task_records";
    const contract = split ? "c.value_json" : "t.shape_json";
    const routing = split ? "r.value_json" : "t.shape_json";
    const rows = this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `WITH RECURSIVE facts AS (
           SELECT t.id, t.parent_id, t.project_id, p.name AS project, t.status, t.kind AS task_kind,
                  t.assignee, t.started_at, t.closed_at,
                  CASE WHEN json_extract(${contract}, '$.deliverable') = 'operation' THEN 'operation'
                       ELSE json_extract(${routing}, '$.kind') END AS work_kind
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
           ${
             split
               ? `LEFT JOIN task_contracts c ON c.task_id = t.id
                  LEFT JOIN task_routing_requests r ON r.task_id = t.id`
               : ""
}
         ),
         reviewing(id) AS (
           SELECT id FROM facts WHERE work_kind = 'review'
           UNION
           SELECT f.id FROM facts f JOIN reviewing ON f.parent_id = reviewing.id
         ),
         finished AS (
           SELECT * FROM facts
           WHERE status = 'done' AND task_kind <> 'operation'
             AND assignee IS NOT NULL AND started_at IS NOT NULL AND closed_at IS NOT NULL
             AND (@reach IS NULL OR closed_at >= @reach)
             AND id NOT IN (SELECT id FROM reviewing)
         ),
         counted(id, owner) AS (
           SELECT id, id FROM finished
           UNION
           SELECT f.id, counted.owner FROM facts f JOIN counted ON f.parent_id = counted.id
           WHERE counted.id <> counted.owner OR f.work_kind = 'review'
         ),
         spent AS (
           SELECT counted.owner,
                  SUM(d.counted) AS counted,
                  SUM(d.input + d.output + d.cache_read + d.cache_write) AS tokens,
                  SUM(d.cost) AS cost
           FROM counted JOIN usage_days d ON d.task_id = counted.id
           GROUP BY counted.owner
         )
         SELECT finished.closed_at, finished.project_id, finished.project, finished.work_kind,
                spent.counted, spent.tokens, spent.cost
         FROM finished LEFT JOIN spent ON spent.owner = finished.id
         ORDER BY finished.closed_at, finished.id`,
      )
      .all({ reach }) as {
      closed_at: number;
      project_id: string | null;
      project: string | null;
      work_kind: unknown;
      counted: number | null;
      tokens: number | null;
      cost: number | null;
    }[];
    const tasks = rows.map(
      (row): UsageTaskCost => ({
        closedAt: row.closed_at,
        project:
          row.project_id === null || row.project === null
            ? null
            : { id: row.project_id, name: row.project },
        kind: workKindOf(row.work_kind),
        tokens: row.counted ? row.tokens : null,
        cost: row.cost,
      }),
    );
    const first = tasks[0];
    const since = periodSince ?? (first === undefined ? null : localDayStart(first.closedAt));
    return { query, since, at: options.now, tasks };
  }

  /** Latest available ledger reading, not a lifetime total or an inferred price. */
  latestForTask(taskId: string): {
    at: number;
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_write: number | null;
    cost: number | null;
  } | null {
    return (
      (this.db
        .prepare(`SELECT at, input, output, cache_read, cache_write, cost
      FROM usage_events WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT 1`)
        .get(taskId) as ReturnType<UsageStore["latestForTask"]>) ?? null
    );
  }

  /**
   * One task's ledger readings since `since`, oldest first: each row is one
   * reported request, recorded when it ended (the heartbeat reads the first
   * mate's, docs/automation.md "The heartbeat").
   */
  readingsSince(
    taskId: string,
    since: number,
  ): { at: number; input: number | null; cache_read: number | null; cache_write: number | null }[] {
    return (
      this.db
        // i18n-exempt: SQL, never shown to a person
        .prepare(`SELECT at, input, cache_read, cache_write
      FROM usage_events WHERE task_id = ? AND at >= ? ORDER BY at, id`)
        .all(taskId, since) as ReturnType<UsageStore["readingsSince"]>
    );
  }

  /** One task's newest reading: when its last request ended and which provider served it. */
  lastReading(taskId: string): { at: number; provider: string | null } | null {
    return (
      (this.db
        .prepare(
          // i18n-exempt: SQL, never shown to a person
          `SELECT at, provider FROM usage_events WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT 1`,
        )
        .get(taskId) as { at: number; provider: string | null } | undefined) ?? null
    );
  }

  /**
   * Every task's usage summed in one query (or one task's), so a caller that
   * polls a whole list never pays a query per task.
   */
  byTask(taskId?: string): UsageRollup[] {
    this.fold();
    const rows = this.db
      .prepare(
        `SELECT task_id, provider, model,
              ${USAGE_DAY_SUMS},
              MAX(last_at) AS last_at, MIN(first_at) AS first_at,
              CASE WHEN SUM(model_source IS NULL) > 0 THEN 'historical'
                   WHEN SUM(model_source = 'requested') > 0 THEN 'requested'
                   ELSE 'served' END AS attribution
       FROM usage_days
       ${taskId === undefined ? "" : "WHERE task_id = ?"}
       GROUP BY task_id, provider, model
       ORDER BY task_id, provider, model`,
      )
      .all(...(taskId === undefined ? [] : [taskId])) as Array<
      AmountRow & {
        task_id: string;
        provider: string | null;
        model: string | null;
        last_at: number;
        first_at: number;
        attribution: ObserveUsageModel["attribution"];
      }
    >;
    const tasks = new Map<string, UsageRollup>();
    for (const row of rows) {
      let task = tasks.get(row.task_id);
      if (!task) {
        task = {
          task_id: row.task_id,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          cost: null,
          records: 0,
          reported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          priced: 0,
          last_at: row.last_at,
          first_at: row.first_at,
          models: [],
        };
        tasks.set(row.task_id, task);
      }
      const reported = {
        input: row.reported_input,
        output: row.reported_output,
        cacheRead: row.reported_cache_read,
        cacheWrite: row.reported_cache_write,
      };
      task.input += row.input;
      task.output += row.output;
      task.cache_read += row.cache_read;
      task.cache_write += row.cache_write;
      task.records += row.records;
      task.priced += row.priced ?? 0;
      if (row.cost !== null) task.cost = (task.cost ?? 0) + row.cost;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        task.reported[key] += reported[key];
      task.last_at = Math.max(task.last_at ?? row.last_at, row.last_at);
      task.first_at = Math.min(task.first_at ?? row.first_at, row.first_at);
      task.models.push({
        provider: row.provider,
        model: row.model,
        attribution: row.attribution,
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        ...(row.cost !== null ? { cost: row.cost } : {}),
        records: row.records,
        reported,
        priced: row.priced ?? 0,
      });
    }
    return [...tasks.values()];
  }
}

/** A model's provider and model with the names Settings gives them. */
function modelNamesOf(
  provider: string | null,
  model: string | null,
  names: UsageNames,
): Pick<UsageModel, "provider" | "providerName" | "model" | "name"> {
  return {
    provider,
    providerName: provider === null ? null : names.provider(provider),
    model,
    name: model === null ? null : provider === null ? model : names.model({ provider, id: model }),
  };
}

/**
 * The names a process without Settings gives: the recorded ids. The record
 * process answers the summary with these, and the core names its models
 * again with `nameUsageSummary`.
 */
export const RECORDED_USAGE_NAMES: UsageNames = {
  model: (ref) => ref.id,
  provider: (provider) => provider,
};

/** A summary with its models named as Settings names them. */
export function nameUsageSummary(summary: UsageSummary, names: UsageNames): UsageSummary {
  return {
    ...summary,
    models: summary.models.map((model) => ({
      ...model,
      ...modelNamesOf(model.provider, model.model, names),
    })),
  };
}

/** A saved kind Where it went names, or null for none, `unclear` or one it does not know. */
function workKindOf(kind: unknown): UsageWorkKind | null {
  return USAGE_WORK_KINDS.find((known) => known === kind) ?? null;
}

/**
 * Where a slice of the ledger went: the Firstmate, each project's task work
 * by saved kind, and other work. A task the facts lack, or whose project is
 * gone, sums under the project no longer on the record.
 */
function whereOf(
  groups: readonly LedgerGroup[],
  tasks: ReadonlyMap<string, TaskFacts>,
): UsageWhere {
  const projects = new Map<
    string,
    { project: UsageProject["project"]; kinds: Map<UsageWorkKind | null, LedgerGroup[]> }
  >();
  for (const group of groups) {
    if (group.kind !== "task") continue;
    const facts = group.task_id === null ? undefined : tasks.get(group.task_id);
    const id = facts?.projectId ?? null;
    let project = projects.get(id ?? "");
    if (!project) {
      project = {
        project: id === null ? null : { id, name: facts?.project ?? id },
        kinds: new Map(),
      };
      projects.set(id ?? "", project);
    }
    const kind = facts?.kind ?? null;
    const held = project.kinds.get(kind);
    if (held) held.push(group);
    else project.kinds.set(kind, [group]);
  }
  const sum = (slice: readonly LedgerGroup[]) => addUsageAmounts(slice.map(amountOf));
  return {
    firstmate: sum(groups.filter((group) => group.kind === "firstmate")),
    projects: [...projects.values()].map(({ project, kinds }) => ({
      project,
      amount: sum([...kinds.values()].flat()),
      kinds: [...kinds].map(([kind, slice]) => ({ kind, amount: sum(slice) })),
    })),
    other: sum(groups.filter((group) => group.kind === "other")),
  };
}

function modelKey(group: LedgerGroup): string {
  return `${group.provider ?? ""}/${group.model ?? ""}`;
}

/** The weakest naming across a model's records. */
function attributionOf(groups: readonly LedgerGroup[]): UsageAttribution {
  if (groups.some((group) => group.model_source === null)) return "recorded";
  if (groups.some((group) => group.model_source === "requested")) return "requested";
  return "served";
}

function priceSourcesOf(groups: readonly LedgerGroup[]): UsagePriceSource[] {
  const sources = new Set<UsagePriceSource>();
  for (const group of groups) {
    if (group.priced === 0) continue;
    const recorded = usageCostSourceSchema.safeParse(group.cost_source);
    sources.add(recorded.success ? recorded.data : "unrecorded");
  }
  return [...sources].sort();
}
