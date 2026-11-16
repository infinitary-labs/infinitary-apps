import {
  type AppCostLimitView,
  type CostLimit,
  effectiveCostLimit,
  limitUsd,
  RECENT_COST_DAYS,
  type TaskCostView,
} from "@shared/costLimit";
import { CostLimitStore } from "./costLimitStore";
import type { AppDatabase } from "./db";
import type { TaskRecord } from "./taskRecords";
import { type UsageInput, UsageStore } from "./usageStore";

/** What the home's usage wiring reads beyond its database. */
export type HomeUsageFacts = {
  /** The app's own limit, from Settings → Intelligence. */
  appLimit(): CostLimit;
  /** A project's own limit, or null when it follows the app's. */
  projectLimit(repoId: string): CostLimit | null | undefined;
};

/**
 * The home's usage ledger and cost limits (docs/usage.md): the per-account
 * ledger (broker phase 2), whose cost comes from session turn_end and
 * model-powered tool_end usage (Pi's listed prices, Claude's own estimate) -
 * never a proxy - keyed by the serving account and model; and each task's
 * cost limit below the app's own, with the holds a limit placed
 * ("The cost limit").
 */
export type HomeUsage = {
  usageStore: UsageStore;
  costLimitStore: CostLimitStore;
  /** A task record's live family spend and the effective limit it follows. */
  taskCostOf(record: TaskRecord): TaskCostView;
  /** The app's own limit as Settings → Intelligence shows it, with its recent tasks. */
  appCostLimitView(): AppCostLimitView;
  /** Record one response's usage now. */
  recordUsage(input: Omit<UsageInput, "at">): void;
};

export function homeUsage(db: AppDatabase, facts: HomeUsageFacts): HomeUsage {
  const usageStore = new UsageStore(db);
  const costLimitStore = new CostLimitStore(db);
  return {
    usageStore,
    costLimitStore,
    taskCostOf: (record) => ({
      ...costLimitStore.familySpend(record.id),
      ...effectiveCostLimit({
        task: costLimitStore.taskLimit(record.id)?.limit,
        project: record.repoId ? facts.projectLimit(record.repoId) : null,
        app: facts.appLimit(),
      }),
    }),
    appCostLimitView: () => {
      const limit = facts.appLimit();
      const since = Date.now() - RECENT_COST_DAYS * 24 * 60 * 60 * 1000;
      return {
        limit,
        recent: { ...costLimitStore.recent(limitUsd(limit), since), days: RECENT_COST_DAYS },
      };
    },
    recordUsage: (input) => {
      usageStore.record({ ...input, at: Date.now() });
    },
  };
}
