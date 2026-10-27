import { type FmModelUsage, type FmUsage, usageCostSourceSchema } from "@shared/events";
import type { ObserveUsageModel } from "@shared/observe";
import {
  addUsageAmounts,
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
  type UsageTasks,
  type UsageTasksQuery,
  type UsageWhere,
  type UsageWorkKind,
  usageTokens,
} from "@shared/usage";
import type { AppDatabase } from "./db";

/**
 * The per-account usage ledger (broker phase 2, D-18): one `usage_events`
 * row per reported call and model, keyed by the task and the account that
 * served it. Cost comes from the session's own usage (Pi's listed
 * prices, Claude's own estimate) - never a proxy, and never a zero the
 * session could not price. The one writer of the table; the published
 * views read it through `views.ts`, Observe through `byTask`, the Usage
 * tab through `summary` (docs/usage.md).
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

/** The Firstmate's own conversation keeps its usage under this task id (services.ts). */
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

/** The first moment a period covers; null for all time. */
function periodStart(period: UsageQuery["period"], now: number): number | null {
  return period === "all" ? null : localDayStart(now, 1 - PERIOD_DAYS[period]);
}

/** What the summary knows of a task: how it is named, its project and its saved kind. */
type TaskFacts = NonNullable<UsagePlace["task"]> & {
  projectId: string | null;
  kind: UsageWorkKind | null;
};

/** The SQL that sums ledger records into one amount's columns. */
const AMOUNT_COLUMNS = `COUNT(*) AS records,
                SUM(input IS NOT NULL OR output IS NOT NULL
                    OR cache_read IS NOT NULL OR cache_write IS NOT NULL) AS counted,
                COUNT(input) AS reported_input,
                COUNT(output) AS reported_output,
                COUNT(cache_read) AS reported_cache_read,
                COUNT(cache_write) AS reported_cache_write,
                COALESCE(SUM(input), 0) AS input,
                COALESCE(SUM(output), 0) AS output,
                COALESCE(SUM(cache_read), 0) AS cache_read,
                COALESCE(SUM(cache_write), 0) AS cache_write,
                SUM(CASE WHEN cost > 0 THEN cost END) AS cost,
                SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS priced,
                SUM(CASE WHEN cost > 0 THEN cost_input END) AS cost_input,
                SUM(CASE WHEN cost > 0 THEN cost_output END) AS cost_output,
                SUM(CASE WHEN cost > 0 THEN cost_cache_read END) AS cost_cache_read,
                SUM(CASE WHEN cost > 0 THEN cost_cache_write END) AS cost_cache_write,
                SUM(CASE WHEN cost > 0 AND (cost_input IS NOT NULL OR cost_output IS NOT NULL
                    OR cost_cache_read IS NOT NULL OR cost_cache_write IS NOT NULL)
                    THEN 1 ELSE 0 END) AS split`;

/** Ledger records summed by `AMOUNT_COLUMNS`. */
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

/** The local calendar date of a moment, YYYY-MM-DD. */
export function localDate(at: number): string {
  const day = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The start of the local day `days` after the one holding `at`. */
function localDayStart(at: number, days = 0): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

/** Each local date from `since` through the day holding `until`, oldest first. */
function localDates(since: number, until: number): string[] {
  const dates: string[] = [];
  for (let day = localDayStart(since); day <= until; day = localDayStart(day, 1)) {
    dates.push(localDate(day));
  }
  return dates;
}

/** Groups by a key, summing each group's amount. */
function sumBy<K>(
  groups: readonly LedgerGroup[],
  key: (group: LedgerGroup) => K,
): Map<K, UsageAmount> {
  const parts = new Map<K, UsageAmount[]>();
  for (const group of groups) {
    const at = key(group);
    parts.set(at, [...(parts.get(at) ?? []), amountOf(group)]);
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
  constructor(private readonly db: AppDatabase) {}

  record(input: UsageInput): void {
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
    ) =>
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
    const served = input.usage.models ?? [];
    if (served.length === 0) {
      row(input.model, "requested", input.usage);
      return;
    }
    // One row per model the provider named, under the session's provider.
    this.db.transaction(() => {
      for (const { model, ...counts } of served) {
        row({ provider: input.model?.provider ?? null, id: model }, "served", counts);
      }
    })();
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
    const groups = this.db
      .prepare(
        `WITH placed AS (
           SELECT u.*,
                  CASE WHEN u.task_id = @firstmate THEN 'firstmate'
                       WHEN t.id IS NOT NULL THEN 'task'
                       ELSE 'other' END AS kind,
                  t.id AS known_task
           FROM usage_events u
           LEFT JOIN tasks t ON t.id = u.task_id
           WHERE @since IS NULL OR u.at >= @since
         )
         SELECT date(at / 1000, 'unixepoch', 'localtime') AS day,
                provider, model, model_source, cost_source, kind, known_task AS task_id,
                ${AMOUNT_COLUMNS}
         FROM placed
         WHERE @scope = 'all' OR kind = @scope
         GROUP BY day, provider, model, model_source, cost_source, kind, known_task`,
      )
      .all({
        firstmate: FIRSTMATE_USAGE_TASK_ID,
        since: periodSince,
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

    const tasks = this.taskFacts(groups);
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

    const models = [...new Set(groups.map((group) => modelKey(group)))].map((key): UsageModel => {
      const slice = groups.filter((group) => modelKey(group) === key);
      const [first] = slice;
      const provider = first?.provider ?? null;
      const model = first?.model ?? null;
      return {
        id: key,
        provider,
        providerName: provider === null ? null : names.provider(provider),
        model,
        name:
          model === null ? null : provider === null ? model : names.model({ provider, id: model }),
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

  /** The key, title, project and saved kind of each task the groups name. */
  private taskFacts(groups: readonly LedgerGroup[]): Map<string, TaskFacts> {
    const ids = [...new Set(groups.flatMap((group) => (group.task_id ? [group.task_id] : [])))];
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT t.id, t.key, t.title, p.id AS project_id, p.name AS project,
                CASE WHEN json_extract(t.shape_json, '$.deliverable') = 'operation' THEN 'operation'
                     ELSE json_extract(t.shape_json, '$.kind') END AS kind
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
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
    const params = {
      firstmate: FIRSTMATE_USAGE_TASK_ID,
      since: periodStart(query.period, options.now),
      limit: query.limit,
    };
    // The task records in the period and work, summed over the ledger's own
    // columns before any task column joins them.
    const recorded = `recorded AS (
           SELECT u.* FROM usage_events u JOIN tasks t ON t.id = u.task_id
           WHERE u.task_id <> @firstmate AND (@since IS NULL OR u.at >= @since)
         )`;
    const { matching } = this.db
      .prepare(`WITH ${recorded} SELECT COUNT(DISTINCT task_id) AS matching FROM recorded`)
      .get(params) as { matching: number };
    const costReported = (column: string) =>
      `SUM(CASE WHEN cost > 0 AND ${column} IS NOT NULL THEN 1 ELSE 0 END)`;
    const rows = this.db
      .prepare(
        `WITH ${recorded},
         summed AS (
           SELECT task_id,
                  ${AMOUNT_COLUMNS},
                  ${costReported("cost_input")} AS cost_reported_input,
                  ${costReported("cost_output")} AS cost_reported_output,
                  ${costReported("cost_cache_read")} AS cost_reported_cache_read,
                  ${costReported("cost_cache_write")} AS cost_reported_cache_write
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
      reported_input: number;
      reported_output: number;
      reported_cache_read: number;
      reported_cache_write: number;
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
   * Every task's usage summed in one query (or one task's), so a caller that
   * polls a whole list never pays a query per task.
   */
  byTask(taskId?: string): UsageRollup[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, provider, model,
              ${AMOUNT_COLUMNS},
              SUM(input IS NOT NULL) AS reported_input,
              SUM(output IS NOT NULL) AS reported_output,
              SUM(cache_read IS NOT NULL) AS reported_cache_read,
              SUM(cache_write IS NOT NULL) AS reported_cache_write,
              MAX(at) AS last_at, MIN(at) AS first_at,
              CASE WHEN SUM(model_source IS NULL) > 0 THEN 'historical'
                   WHEN SUM(model_source = 'requested') > 0 THEN 'requested'
                   ELSE 'served' END AS attribution
       FROM usage_events
       ${taskId === undefined ? "" : "WHERE task_id = ?"}
       GROUP BY task_id, provider, model
       ORDER BY task_id, provider, model`,
      )
      .all(...(taskId === undefined ? [] : [taskId])) as Array<
      AmountRow & {
        task_id: string;
        provider: string | null;
        model: string | null;
        reported_input: number;
        reported_output: number;
        reported_cache_read: number;
        reported_cache_write: number;
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
    project.kinds.set(kind, [...(project.kinds.get(kind) ?? []), group]);
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

/** A model's identity: its provider and the model as recorded. */
function modelKey(group: LedgerGroup): string {
  return `${group.provider ?? ""}/${group.model ?? ""}`;
}

/** The weakest naming across a model's records. */
function attributionOf(groups: readonly LedgerGroup[]): UsageAttribution {
  if (groups.some((group) => group.model_source === null)) return "recorded";
  if (groups.some((group) => group.model_source === "requested")) return "requested";
  return "served";
}

/** Where a model's priced records got their estimates. */
function priceSourcesOf(groups: readonly LedgerGroup[]): UsagePriceSource[] {
  const sources = new Set<UsagePriceSource>();
  for (const group of groups) {
    if (group.priced === 0) continue;
    const recorded = usageCostSourceSchema.safeParse(group.cost_source);
    sources.add(recorded.success ? recorded.data : "unrecorded");
  }
  return [...sources].sort();
}
