import {
  costSeries,
  EMPTY_USAGE_AMOUNT,
  type UsageTask,
  type UsageTaskCosts,
  type UsageTasks,
} from "@shared/usage";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostBody } from "./UsageCostPerTask";
import { RecentTasksView, type RecentTasksViewProps } from "./UsageTab";

/**
 * Usage's recent tasks as the captain reads them (FI3-993): what the list
 * shows while a read is out, when one fails, when nothing matches, and
 * when more match than it shows. The words and numbers are `usageWords`'s.
 */

function task(index: number): UsageTask {
  return {
    task: { key: `WEB-${index}`, title: `Task ${index}`, project: "Website" },
    createdAt: new Date(2026, 9, 5, 15).getTime() - index * 3_600_000,
    amount: {
      ...EMPTY_USAGE_AMOUNT,
      tokens: { input: 100, output: 20, cacheRead: 800, cacheWrite: 50 },
      records: 1,
      counted: 1,
    },
    reported: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    costReported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function read(shown: number, matching: number): UsageTasks {
  return {
    query: { period: "30d", scope: "all", limit: shown },
    tasks: Array.from({ length: shown }, (_, index) => task(index + 1)),
    matching,
  };
}

function render(props: Partial<RecentTasksViewProps>): string {
  return renderToStaticMarkup(
    <RecentTasksView
      value={null}
      failed={false}
      unit="tokens"
      onMore={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );
}

const rows = (markup: string) => markup.match(/data-usage-task="/g)?.length ?? 0;

describe("Usage's recent tasks", () => {
  it("shows the tasks read with their five figures, the count, and See more while more match", () => {
    const markup = render({ value: read(10, 23) });
    expect(rows(markup)).toBe(10);
    expect(markup.match(/data-usage-figure="/g)?.length).toBe(50);
    expect(markup).toContain("Showing 10 of 23 tasks");
    expect(markup).toContain("See more");
    expect(markup).not.toContain("data-usage-tasks-retry");
  });

  it("keeps the tasks it shows when a longer read fails, and offers to try again", () => {
    const markup = render({ value: read(10, 23), failed: true });
    expect(rows(markup)).toBe(10);
    expect(markup).toContain("data-usage-tasks-retry");
    expect(markup).toContain("Try again");
    expect(markup).toContain("See more");
  });

  it("offers to try again when the first read fails, and says so while it reads", () => {
    expect(render({ failed: true })).toContain("data-usage-tasks-retry");
    const reading = render({});
    expect(reading).not.toContain("data-usage-tasks-retry");
    expect(rows(reading)).toBe(0);
  });

  it("says no task used anything in the selection, and drops See more once every task is shown", () => {
    const none = render({ value: read(0, 0) });
    expect(none).toContain("data-usage-tasks-empty");
    expect(none).not.toContain("data-usage-tasks-foot");
    const all = render({ value: read(23, 23) });
    expect(rows(all)).toBe(23);
    expect(all).toContain("All 23 tasks shown");
    expect(all).not.toContain("See more");
  });
});

describe("Usage's cost per task", () => {
  const NOW = new Date(2026, 9, 5, 15).getTime();
  const DAY = 86_400_000;
  const ALL = { projects: null, kinds: null };
  const costs = (daysAgo: number[]): UsageTaskCosts => ({
    query: { period: "30d" },
    since: NOW - 30 * DAY,
    at: NOW,
    tasks: daysAgo.map((ago, index) => ({
      closedAt: NOW - ago * DAY,
      project: { id: "repo-fm", name: "firstmate-3000" },
      kind: "implement",
      tokens: 2_000_000 + index * 100_000,
      cost: 2 + index / 10,
    })),
  });
  const renderCost = (value: UsageTaskCosts) =>
    renderToStaticMarkup(
      <CostBody costs={value} selection={ALL} series={costSeries(value, ALL, "usd")} unit="usd" />,
    );

  it("breaks the line and its band where a week has too few finished tasks", () => {
    // Six tasks a day for the first ten days and the last five, none between.
    const days = [...Array(10).keys()].map((day) => 29 - day).concat([4, 3, 2, 1, 0]);
    const markup = renderCost(costs(days.flatMap((day) => [day, day, day, day, day, day])));
    expect(markup.match(/data-usage-cost-line="/g)?.length).toBe(2);
    expect(markup.match(/data-usage-cost-band="/g)?.length).toBe(2);
    expect(markup).not.toContain("data-usage-cost-empty");
  });

  it("says too few tasks finished instead of drawing a line at zero", () => {
    const markup = renderCost(costs([3, 2, 1]));
    expect(markup).toContain("data-usage-cost-empty");
    expect(markup).not.toContain("data-usage-cost-line");
    expect(markup).not.toContain("$0.00");
  });
});
