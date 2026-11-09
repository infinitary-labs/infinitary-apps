import { z } from "zod";

/**
 * The per-task cost limit (docs/usage.md, "The cost limit"; INF-3112's
 * plan): an amount in estimated US dollars, the same estimate Settings →
 * Usage shows, past which a task asks the captain before it spends more.
 * It counts the task and everything under it, its parts and its review
 * included. Three places set it, and the first that is set wins, read
 * live: the task itself, its project, then the app.
 */

/**
 * The app's limit until the captain changes it: the captain's choice on
 * INF-3112's plan, drawn from the captain's own ledger (about 22 asks a
 * week at their volume, 29% of task spend past it).
 */
export const COST_LIMIT_DEFAULT_USD = 50;

/** A limit at one place: an amount in estimated dollars, or no limit at all. */
export const costLimitSchema = z.union([
  z.strictObject({ usd: z.number().positive().finite() }),
  z.strictObject({ none: z.literal(true) }),
]);
export type CostLimit = z.infer<typeof costLimitSchema>;

/** Where the limit a task follows was set. */
export type CostLimitSource = "task" | "project" | "app";

/** The app's own limit when nothing was saved: the default. */
export const DEFAULT_COST_LIMIT: CostLimit = { usd: COST_LIMIT_DEFAULT_USD };

/** The limit a task follows: its own, else its project's, else the app's. */
export function effectiveCostLimit(levels: {
  task?: CostLimit | null | undefined;
  project?: CostLimit | null | undefined;
  app: CostLimit;
}): { limit: CostLimit; source: CostLimitSource } {
  if (levels.task) return { limit: levels.task, source: "task" };
  if (levels.project) return { limit: levels.project, source: "project" };
  return { limit: levels.app, source: "app" };
}

/** The amount of a limit, or null when it is no limit. */
export function limitUsd(limit: CostLimit): number | null {
  return "usd" in limit ? limit.usd : null;
}

/**
 * A dollar amount as a card says it: whole dollars when it is one, cents
 * otherwise ("$50", "$51.37").
 */
export function formatUsd(usd: number): string {
  const cents = Math.round(usd * 100);
  return cents % 100 === 0
    ? `$${(cents / 100).toLocaleString("en-US")}`
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The limit Allow more sets: the limit raised by `step`, as many times as
 * it takes to sit above what the task has already spent, so the task can
 * spend at least `step` more before it asks again and the amount stays a
 * round multiple the captain recognises ($50 → $100 → $150).
 */
export function raisedLimit(limit: number, step: number, spent: number): number {
  let next = limit + step;
  while (next <= spent) next += step;
  return next;
}

/** The hold card's title: the task and the limit it passed. */
export function costHoldTitle(handle: string, limit: number): string {
  return `${handle} passed its ${formatUsd(limit)} limit`;
}

/** How far back the app's row counts the tasks its limit would have asked about. */
export const RECENT_COST_DAYS = 30;

/**
 * The app's own limit as Settings → Intelligence shows it, with the live
 * fact beside it: of the task families that spent anything in the last
 * `days`, how many spent past the limit and so would have asked.
 */
export const appCostLimitViewSchema = z.object({
  limit: costLimitSchema,
  recent: z.object({
    asked: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    days: z.number().int().positive(),
  }),
});
export type AppCostLimitView = z.infer<typeof appCostLimitViewSchema>;
