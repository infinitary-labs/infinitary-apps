import { EMPTY_USAGE_AMOUNT, type UsageTask, type UsageTasks } from "@shared/usage";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
