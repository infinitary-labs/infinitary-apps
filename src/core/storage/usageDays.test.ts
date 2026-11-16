import type { UsageQuery } from "@shared/usage";
import { describe, expect, it } from "vitest";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { type AppDatabase, openInMemoryDatabase } from "./db";
import { localZone } from "./usageDays";
import { localDate, type UsageNames, UsageStore } from "./usageStore";

// INF-4404 (built on INF-4393's freeze diagnosis): the usage figures add up
// daily totals instead of every ledger record on each read, and answer
// exactly as the ledger does.

const NOW = new Date(2026, 10, 15, 15, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const names: UsageNames = { model: (ref) => ref.id, provider: (provider) => provider };

/** Every figure the daily totals serve, for one period. */
function figures(store: UsageStore, period: UsageQuery["period"]) {
  return {
    summary: store.summary({ period, scope: "all" }, { now: NOW, names }),
    tasks: store.tasks({ period, scope: "all", limit: 50 }, { now: NOW }),
    byTask: store.byTask(),
  };
}

/** A crewmate's turns over two days on one model, its review on another, and the first mate's. */
function ledger(): { db: AppDatabase; store: UsageStore } {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  for (const id of ["site", "review"]) seedTask(tasks, { id, title: id, status: "running" });
  const store = new UsageStore(db);
  for (let turn = 0; turn < 12; turn++) {
    store.record({
      taskId: "site",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: {
        input: 4000 + turn,
        output: 300,
        cacheRead: 20000,
        cost: 0.25,
        costSource: "listed-prices",
        costParts: { input: 0.125, output: 0.0625, cacheRead: 0.0625, cacheWrite: 0 },
      },
      at: NOW - (turn < 6 ? 2 * DAY : HOUR) - turn * 60_000,
    });
  }
  store.record({
    taskId: "review",
    model: { provider: "anthropic-claude", id: "opus" },
    usage: {
      models: [
        { model: "claude-opus-4-1", input: 900, output: 90, cost: 0.5, costSource: "claude" },
      ],
    },
    at: NOW - 3 * HOUR,
  });
  store.record({
    taskId: "firstmate",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    usage: { input: 300, output: 30 },
    at: NOW - 2 * HOUR,
  });
  return { db, store };
}

const count = (db: AppDatabase, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the usage ledger's daily totals", () => {
  it("keeps one row per day, task and model, and folds later records as a recount would", () => {
    const { db, store } = ledger();
    const first = figures(store, "all");
    expect(first.summary.total.records).toBe(14);
    // Twelve crewmate turns on two days, one review and one first mate turn.
    expect(count(db, "usage_events")).toBe(14);
    expect(count(db, "usage_days")).toBe(4);

    // More turns on a folded day, a new day's turn, and a row another build
    // wrote straight into the ledger without this one's writer.
    store.record({
      taskId: "site",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: { input: 10, output: 1, cost: 0.5, costSource: "listed-prices" },
      at: NOW - 30 * 60_000,
    });
    store.record({
      taskId: "review",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: { input: 7 },
      at: NOW - 5 * DAY,
    });
    db.prepare(
      "INSERT INTO usage_events (task_id, provider, model, input, output, cost, at) VALUES ('site', 'openai-codex', 'gpt-5.5', 400, 40, 0.75, ?)",
    ).run(NOW - 10 * 60_000);

    for (const period of ["all", "7d", "30d"] as const) {
      const folded = figures(store, period);
      db.prepare("DELETE FROM usage_days_state").run();
      expect(folded).toEqual(figures(store, period));
    }
    const after = figures(store, "all");
    expect(after.summary.total.records).toBe(17);
    expect(after.summary.total.cost).toBe(12 * 0.25 + 0.5 + 0.5 + 0.75);
    expect(after.summary.days.map((day) => day.date)).toContain(localDate(NOW - 5 * DAY));
    // The turn on a folded day joined its row; the new day and the other
    // build's row, which names no model or price source, added one each.
    expect(count(db, "usage_days")).toBe(6);
    db.close();
  });

  it("counts every day again when the time zone it counted days in changes", () => {
    const { db, store } = ledger();
    const here = figures(store, "all");
    // Days counted where the clock read a day earlier, as after travel west.
    db.prepare("UPDATE usage_days_state SET zone = 'Pacific/Pago_Pago' WHERE id = 1").run();
    db.prepare("UPDATE usage_days SET day = date(day, '-1 day')").run();
    expect(figures(store, "all")).toEqual(here);
    expect((db.prepare("SELECT zone FROM usage_days_state").get() as { zone: string }).zone).toBe(
      localZone(),
    );
    db.close();
  });
});
