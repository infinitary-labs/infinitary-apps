import { describe, expect, it } from "vitest";
import {
  COST_MIN_TASKS,
  COST_POINTS,
  costDayEnds,
  costPoint,
  costSeries,
  quantile,
  type UsageTaskCost,
  type UsageTaskCosts,
} from "./usage";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 5, 15, 0).getTime();
const FM = { id: "repo-fm", name: "firstmate-3000" };
const WEB = { id: "repo-web", name: "Website" };

/** A finished task, closed `daysAgo` days before now, costing `cost` dollars at about 2.3M tokens a dollar. */
const task = (
  daysAgo: number,
  cost: number | null,
  more: Partial<UsageTaskCost> = {},
): UsageTaskCost => ({
  closedAt: NOW - daysAgo * DAY,
  project: FM,
  kind: "implement",
  tokens: cost === null ? 120_000 : Math.round(cost * 2_300_000),
  cost,
  ...more,
});

/** Thirty days of work with the week before them: firstmate-3000's builds grow dearer, Website's fixes stay flat. */
function month(): UsageTaskCosts {
  const tasks: UsageTaskCost[] = [];
  for (let day = 36; day >= 0; day--) {
    const growth = 1 + (36 - day) / 36;
    tasks.push(task(day + 0.5, 4 * growth), task(day + 0.4, 6 * growth));
    tasks.push(task(day + 0.3, 2, { project: WEB, kind: "fix" }));
    tasks.push(task(day + 0.2, 2.4, { project: WEB, kind: "fix" }));
  }
  tasks.push(task(3.1, null), task(40, null));
  tasks.sort((a, b) => a.closedAt - b.closedAt);
  return { query: { period: "30d" }, since: NOW - 30 * DAY, at: NOW, tasks };
}
const ALL = { projects: null, kinds: null };

describe("Cost per task's sliding median (INF-6217's plan)", () => {
  it("interpolates a quantile between the two nearest values", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("draws no median for a window with too few tasks, never a zero", () => {
    const values = [1, 2, 3, 4].map((value, index) => ({ at: NOW - index * DAY, value }));
    expect(COST_MIN_TASKS).toBeGreaterThan(values.length);
    expect(costPoint(values, NOW)).toEqual({ at: NOW, tasks: 4, median: null, q1: null, q3: null });
  });

  it("counts only the tasks closed in the week before a point", () => {
    const values = [0.5, 1, 2, 3, 4, 5, 6, 9].map((daysAgo, index) => ({
      at: NOW - daysAgo * DAY,
      value: index + 1,
    }));
    expect(costPoint(values, NOW)).toMatchObject({ tasks: 7, median: 4 });
  });

  it("follows a project that grows dearer while the rest stay flat", () => {
    const costs = month();
    const fm = costSeries(costs, { projects: new Set(["repo-fm"]), kinds: null }, "usd");
    expect(fm.points).toHaveLength(COST_POINTS + 1);
    expect(fm.points[0]?.at).toBe(costs.since);
    expect(fm.now.at).toBe(NOW);
    expect(fm.start).toBe(fm.points[0]);
    expect(fm.change).toBeGreaterThan(0.5);
    const web = costSeries(costs, { projects: new Set(["repo-web"]), kinds: null }, "usd");
    expect(web.now.median).toBeCloseTo(2.2, 5);
    expect(web.change).toBeCloseTo(0, 5);
    const fixes = costSeries(costs, { projects: null, kinds: new Set(["fix"]) }, "usd");
    expect(fixes.points.map((point) => point.median)).toEqual(
      web.points.map((point) => point.median),
    );
  });

  it("leaves out tasks with no estimate in dollars, counting only those in the period", () => {
    const costs = month();
    expect(costSeries(costs, ALL, "usd").missing).toBe(1);
    expect(costSeries(costs, ALL, "tokens").missing).toBe(0);
  });

  it("has no change when only the window ending now has a median, and no start when none has", () => {
    const tasks = [0.1, 0.2, 0.3, 0.4, 0.5].map((daysAgo) => task(daysAgo, 3));
    const series = costSeries(
      { query: { period: "30d" }, since: NOW - 30 * DAY, at: NOW, tasks },
      ALL,
      "usd",
    );
    expect(series.now.median).toBe(3);
    expect(series.start).toBe(series.now);
    expect(series.change).toBeNull();
    const lone = costSeries(
      { query: { period: "30d" }, since: NOW - 30 * DAY, at: NOW, tasks: [task(0.1, 3)] },
      ALL,
      "usd",
    );
    expect(lone.start).toBeNull();
    expect(lone.change).toBeNull();
  });

  it("gives the Values table one row per local day, today ending now", () => {
    const costs = month();
    const ends = costDayEnds(costs);
    expect(ends[ends.length - 1]).toBe(NOW);
    expect(ends).toHaveLength(31);
    for (const end of ends.slice(0, -1)) expect(new Date(end + 1).getHours()).toBe(0);
    expect(costDayEnds({ ...costs, since: null })).toEqual([]);
  });
});
