import { z } from "zod";
import { usageCostSourceSchema } from "./events";
import type { WorkKind } from "./routingPolicy";

/**
 * Settings → Usage (docs/usage.md): the recorded model usage across the
 * fleet, read from the usage ledger by `UsageStore.summary`. The core
 * answers one summary per period and kind of work; the unit (tokens or
 * estimated dollars) is the window's own choice, so every number here
 * carries both.
 */

export const USAGE_PERIODS = ["7d", "30d", "all"] as const;
export const usagePeriodSchema = z.enum(USAGE_PERIODS);
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;

/**
 * Which work: everything, task work (a task's own turns and the supporting
 * model calls made for it), the Firstmate's own conversation, or other
 * work - model calls tied to no task, or to a task the record no longer has.
 */
export const USAGE_SCOPES = ["all", "task", "firstmate", "other"] as const;
export const usageScopeSchema = z.enum(USAGE_SCOPES);
export type UsageScope = z.infer<typeof usageScopeSchema>;

export const usageQuerySchema = z.strictObject({
  period: usagePeriodSchema,
  scope: usageScopeSchema,
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** What Usage opens on: all work, the last 30 days. */
export const DEFAULT_USAGE_QUERY: UsageQuery = { period: "30d", scope: "all" };

/** How Usage shows every amount; tokens until the captain picks dollars. */
export const usageUnitSchema = z.enum(["tokens", "usd"]);
export type UsageUnit = z.infer<typeof usageUnitSchema>;

const categoriesSchema = <T extends z.ZodType>(value: T) =>
  z.object({ input: value, output: value, cacheRead: value, cacheWrite: value });

/**
 * One aggregate over ledger records. Token categories are the known sums,
 * each counted once. `cost` is the known estimate in USD over the priced
 * records only, null when none is priced: a record with no price, or an
 * older zero, is never counted as free.
 */
export const usageAmountSchema = z.object({
  tokens: categoriesSchema(z.number()),
  /** Records summed here. */
  records: z.number(),
  /** Records that reported any token count. */
  counted: z.number(),
  /** Records reporting each token category; absent on older homes, never inferred from counted. */
  tokenReported: categoriesSchema(z.number()).optional(),
  cost: z.number().nullable(),
  /** Records with a price. */
  priced: z.number(),
  /** The estimate by category over the priced records that split it, null where none did. */
  costParts: categoriesSchema(z.number().nullable()),
  /** Priced records whose estimate is split by category. */
  split: z.number(),
});
export type UsageAmount = z.infer<typeof usageAmountSchema>;
export type UsageCategory = keyof UsageAmount["tokens"];

export const EMPTY_USAGE_AMOUNT: UsageAmount = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  records: 0,
  counted: 0,
  tokenReported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: null,
  priced: 0,
  costParts: { input: null, output: null, cacheRead: null, cacheWrite: null },
  split: 0,
};

/**
 * Where usage went: one task, the Firstmate, or other work. The tab reads
 * `UsageWhere`; the largest tasks stay in the published summary for its clients.
 */
export const usagePlaceSchema = z.object({
  kind: z.enum(["task", "firstmate", "other"]),
  /** The task's key, title and project; null for the Firstmate and other work. */
  task: z.object({ key: z.string(), title: z.string(), project: z.string().nullable() }).nullable(),
  amount: usageAmountSchema,
});
export type UsagePlace = z.infer<typeof usagePlaceSchema>;

/**
 * The kinds of work Where it went names: the whole-task kind a task's shape
 * saved (`workKindSchema`). A task with none, `unclear`, or a kind this list
 * does not know is null, "Other task work".
 */
export const USAGE_WORK_KINDS = [
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "implement",
  "fix",
  "chore",
  "review",
  "operation",
] as const satisfies ReadonlyArray<WorkKind | "operation">;
export const usageWorkKindSchema = z.enum(USAGE_WORK_KINDS);
export type UsageWorkKind = z.infer<typeof usageWorkKindSchema>;

/** One project's usage: its subtotal, and the same usage by kind of work. */
export const usageProjectSchema = z.object({
  /** Null when the record no longer has the task's project. */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  amount: usageAmountSchema,
  /** Each kind once; together they are the subtotal, never added to it. */
  kinds: z.array(z.object({ kind: usageWorkKindSchema.nullable(), amount: usageAmountSchema })),
});
export type UsageProject = z.infer<typeof usageProjectSchema>;

/**
 * Where usage went (docs/usage.md): the Firstmate's own conversation, each
 * project's task work by kind, and other work. The Firstmate, the project
 * subtotals and other work add up to the whole.
 */
export const usageWhereSchema = z.object({
  firstmate: usageAmountSchema,
  projects: z.array(usageProjectSchema),
  other: usageAmountSchema,
});
export type UsageWhere = z.infer<typeof usageWhereSchema>;

/**
 * How a model row knows its model: every record named by the provider
 * (`served`), the model the app asked for on some (`requested`), or recorded
 * before models were kept apart on some (`recorded`) - the weakest wins.
 */
export const usageAttributionSchema = z.enum(["served", "requested", "recorded"]);
export type UsageAttribution = z.infer<typeof usageAttributionSchema>;

/** Where a model's estimates came from; `unrecorded` for priced records from before the source was kept. */
export const usagePriceSourceSchema = z.union([usageCostSourceSchema, z.literal("unrecorded")]);
export type UsagePriceSource = z.infer<typeof usagePriceSourceSchema>;

export const usageModelSchema = z.object({
  /** Stable identity: the provider and model as recorded. */
  id: z.string(),
  provider: z.string().nullable(),
  providerName: z.string().nullable(),
  model: z.string().nullable(),
  /** The model by the name every surface gives it, or its id; null when none was recorded. */
  name: z.string().nullable(),
  attribution: usageAttributionSchema,
  priceSources: z.array(usagePriceSourceSchema),
  amount: usageAmountSchema,
  /** The work it served: the Firstmate, other work, and its largest tasks. */
  places: z.array(usagePlaceSchema),
  /** Its work, by project and kind, over this model's records alone. */
  where: usageWhereSchema,
});
export type UsageModel = z.infer<typeof usageModelSchema>;

export const usageDaySchema = z.object({
  /** The local calendar date, YYYY-MM-DD. */
  date: z.string(),
  amount: usageAmountSchema,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

export const usageSummarySchema = z.object({
  query: usageQuerySchema,
  /** The first local day the period covers; null for all time with nothing recorded. */
  since: z.number().nullable(),
  /** When the summary was read: today is partial until it ends. */
  at: z.number(),
  total: usageAmountSchema,
  /** Every local day of the period, oldest first, today last. */
  days: z.array(usageDaySchema),
  models: z.array(usageModelSchema),
  /**
   * The Firstmate, other work, and the largest tasks by tokens and by
   * estimate, so either unit can name its own three largest.
   */
  places: z.array(usagePlaceSchema),
  /** Where it went, by project and kind of work. */
  where: usageWhereSchema,
  /** Tasks finished in the period and kind of work. */
  finished: z.number(),
  /** Tasks finished across all retained history, for the milestones. */
  finishedEver: z.number(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Recent tasks: ten at first, ten more each time the captain asks. */
export const USAGE_TASK_PAGE = 10;
/** The most tasks one read lists. */
export const USAGE_TASKS_MAX = 5000;

/** Recent tasks over a period and kind of work, the newest `limit` of them. */
export const usageTasksQuerySchema = z.strictObject({
  period: usagePeriodSchema,
  scope: usageScopeSchema,
  limit: z.number().int().min(1).max(USAGE_TASKS_MAX),
});
export type UsageTasksQuery = z.infer<typeof usageTasksQuerySchema>;

/**
 * One task's usage in the period. `reported` says how many records named
 * each token category and `costReported` how many priced records split
 * their estimate into it, so a category no record reported is told from a
 * measured zero.
 */
export const usageTaskSchema = z.object({
  task: z.object({ key: z.string(), title: z.string(), project: z.string().nullable() }),
  /** When the task was created: the list's order, newest first. */
  createdAt: z.number(),
  amount: usageAmountSchema,
  reported: categoriesSchema(z.number()),
  costReported: categoriesSchema(z.number()),
});
export type UsageTask = z.infer<typeof usageTaskSchema>;

export const usageTasksSchema = z.object({
  query: usageTasksQuerySchema,
  /** The newest tasks with recorded usage in the period and work, at most `limit`. */
  tasks: z.array(usageTaskSchema),
  /** How many tasks have recorded usage in the period and work. */
  matching: z.number(),
});
export type UsageTasks = z.infer<typeof usageTasksSchema>;

/** The tokens an amount counts, each category once. */
export function usageTokens(amount: UsageAmount): number {
  const { input, output, cacheRead, cacheWrite } = amount.tokens;
  return input + output + cacheRead + cacheWrite;
}

/**
 * An amount in the chosen unit, or null where it is not available: no
 * record reported a token count, or no record is priced.
 */
export function usageValue(amount: UsageAmount, unit: UsageUnit): number | null {
  if (unit === "usd") return amount.cost;
  return amount.counted > 0 ? usageTokens(amount) : null;
}

/** One token category in the chosen unit, or null where it is not available. */
export function usageCategoryValue(
  amount: UsageAmount,
  category: UsageCategory,
  unit: UsageUnit,
): number | null {
  if (unit === "usd") return amount.costParts[category];
  return (amount.tokenReported?.[category] ?? 0) > 0 ? amount.tokens[category] : null;
}

/** Sums amounts, keeping an unknown estimate unknown until some record is priced. */
export function addUsageAmounts(amounts: readonly UsageAmount[]): UsageAmount {
  const plus = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  return amounts.reduce<UsageAmount>(
    (sum, next) => ({
      tokens: {
        input: sum.tokens.input + next.tokens.input,
        output: sum.tokens.output + next.tokens.output,
        cacheRead: sum.tokens.cacheRead + next.tokens.cacheRead,
        cacheWrite: sum.tokens.cacheWrite + next.tokens.cacheWrite,
      },
      records: sum.records + next.records,
      counted: sum.counted + next.counted,
      tokenReported:
        (sum.records === 0 || sum.tokenReported) && (next.records === 0 || next.tokenReported)
          ? {
              input: (sum.tokenReported?.input ?? 0) + (next.tokenReported?.input ?? 0),
              output: (sum.tokenReported?.output ?? 0) + (next.tokenReported?.output ?? 0),
              cacheRead: (sum.tokenReported?.cacheRead ?? 0) + (next.tokenReported?.cacheRead ?? 0),
              cacheWrite:
                (sum.tokenReported?.cacheWrite ?? 0) + (next.tokenReported?.cacheWrite ?? 0),
            }
          : undefined,
      cost: plus(sum.cost, next.cost),
      priced: sum.priced + next.priced,
      costParts: {
        input: plus(sum.costParts.input, next.costParts.input),
        output: plus(sum.costParts.output, next.costParts.output),
        cacheRead: plus(sum.costParts.cacheRead, next.costParts.cacheRead),
        cacheWrite: plus(sum.costParts.cacheWrite, next.costParts.cacheWrite),
      },
      split: sum.split + next.split,
    }),
    EMPTY_USAGE_AMOUNT,
  );
}

/** Finished-work milestones: a few counts worth noticing, and nothing past them. */
export const USAGE_MILESTONES = [1, 10, 25, 50] as const;

/** The milestone a count has reached, and the next one, if any. */
export function usageMilestone(finished: number): { reached: number | null; next: number | null } {
  const reached = [...USAGE_MILESTONES].reverse().find((stop) => finished >= stop) ?? null;
  const next = USAGE_MILESTONES.find((stop) => finished < stop) ?? null;
  return { reached, next };
}
