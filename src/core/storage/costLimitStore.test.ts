import { describe, expect, it } from "vitest";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CostLimitStore } from "./costLimitStore";
import { openInMemoryDatabase } from "./db";
import { UsageStore } from "./usageStore";

// INF-3112's plan, built by INF-3131: the limit counts a task and everything
// under it, and Settings shows how many recent tasks it would have asked about.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);

function ledger() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  const usage = new UsageStore(db);
  const store = new CostLimitStore(db);
  const spend = (taskId: string, cost: number | undefined, at = NOW) =>
    usage.record({
      taskId,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      usage: { input: 120_000, output: 4_000, ...(cost !== undefined ? { cost } : {}) },
      at,
    });
  const task = (id: string, parentId?: string) =>
    seedTask(tasks, { id, title: id, status: "idle", ...(parentId ? { parentId } : {}) });
  return { db, store, spend, task };
}

describe("CostLimitStore", () => {
  it("sums a task's spend with every task under it, and counts what could not be priced", () => {
    const { db, store, spend, task } = ledger();
    task("plan");
    task("piece", "plan");
    task("review", "piece");
    task("other");
    spend("plan", 12.5);
    spend("piece", 30.25);
    spend("review", 8);
    spend("review", undefined);
    spend("other", 400);
    expect(store.familySpend("plan")).toEqual({ usd: 50.75, unpriced: 1 });
    expect(store.familySpend("piece")).toEqual({ usd: 38.25, unpriced: 1 });
    expect(store.familySpend("other")).toEqual({ usd: 400, unpriced: 0 });
    db.close();
  });

  it("counts the task families of the last days that reached the limit, never the first mate", () => {
    const { db, store, spend, task } = ledger();
    task("big");
    task("big-part", "big");
    task("small");
    task("old");
    spend("big", 30, NOW - DAY);
    spend("big-part", 25, NOW - 2 * DAY);
    spend("small", 49.99, NOW - DAY);
    spend("old", 500, NOW - 40 * DAY);
    spend("firstmate", 900, NOW - DAY);
    const since = NOW - 30 * DAY;
    expect(store.recent(50, since)).toEqual({ asked: 1, tasks: 2 });
    expect(store.recent(40, since)).toEqual({ asked: 2, tasks: 2 });
    expect(store.recent(null, since)).toEqual({ asked: 0, tasks: 2 });
    db.close();
  });

  it("keeps task and project limits and the holds they place", () => {
    const { db, store } = ledger();
    expect(store.limitOf("task", "a")).toBeNull();
    store.setLimit("task", "a", { usd: 100 }, NOW);
    store.setLimit("project", "a", { none: true }, NOW);
    expect(store.limitOf("task", "a")).toEqual({ usd: 100 });
    expect(store.limitOf("project", "a")).toEqual({ none: true });
    store.setLimit("task", "a", null, NOW);
    expect(store.limitOf("task", "a")).toBeNull();

    store.placeHold({ taskId: "a", limitUsd: 50, spentUsd: 51.2, at: NOW });
    expect(store.hold("a")).toEqual({ taskId: "a", limitUsd: 50, spentUsd: 51.2, at: NOW });
    expect(store.clearHold("a")).toBe(true);
    expect(store.clearHold("a")).toBe(false);
    expect(store.hold("a")).toBeUndefined();
    db.close();
  });
});
