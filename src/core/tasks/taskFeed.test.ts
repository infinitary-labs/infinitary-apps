import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../storage/taskEventStore";
import { type FeedSubject, taskFeedLine } from "./taskFeed";

const record = {
  key: "FM3K-42",
  title: "A long task title that must never crowd out the actual activity update",
  assignee: "crewmate 1",
  delivery: null,
} satisfies FeedSubject & { title: string };

function event(kind: TaskEvent["kind"], data: TaskEvent["data"] = null): TaskEvent {
  return {
    id: 1,
    taskId: "task-42",
    at: 123,
    actor: "host",
    kind,
    text: "The update itself.",
    data,
    ref: null,
    feed: true,
  };
}

describe("task feed updates", () => {
  it.each<[TaskEvent["kind"], TaskEvent["data"], string]>([
    ["dispatched", null, "Started"],
    ["report", null, "Reported: The update itself."],
    ["report", { summary: "The chosen headline." }, "Reported: The chosen headline."],
    ["failed", null, "Failed: something went wrong - try again"],
    ["failed", { fatal: false }, "Problem: something went wrong - try again"],
    ["landed", null, "Merged"],
    ["merged", null, "Merged"],
    ["status", { container: true, reason: "finished" }, "Done: everything under it is finished"],
    ["status", { container: true, reason: "cancelled" }, "Stopped: nothing under it went ahead"],
    ["status", { reason: "answered", basisOf: "FM3K-43" }, "Answered: The update itself."],
    ["status", { reason: "answered", waitedOnBy: "FM3K-43" }, "Answered: The update itself."],
    ["status", { reason: "released" }, "Released outside this task"],
    ["status", { reason: "finished" }, "Finished"],
    ["status", { reason: "cancelled" }, "Stopped"],
    ["status", null, "Updated: The update itself."],
    [
      "escalated",
      { tier: "high", escalated_to: "FM3K-43" },
      "Moved to a stronger model: high; continues as FM3K-43",
    ],
    ["escalated", null, "Updated: The update itself."],
    ["note", { ledger: "verdict" }, "First mate: The update itself."],
    [
      "note",
      { undelivered: 1, why: "the task finished" },
      "Message undelivered: the task finished",
    ],
    ["note", null, "Noted: The update itself."],
    ["note", { feedLine: true, news: true }, "The update itself."],
    ["pr_opened", { prNumber: 7 }, "Opened a pull request"],
    ["pr_opened", null, "Pushed the branch"],
    ["ci", { ci: "green" }, "The checks passed"],
    ["ci", { ci: "red" }, "The checks failed"],
    ["ci", { ci: "pending" }, "The checks running"],
    ["ci", null, "Checks updated"],
    [
      "ci",
      { ciRounds: 3, ciCapAt: 123 },
      "3 repairs did not get the checks to pass - your first mate will ask you what to do",
    ],
    ["review", { reviewVerdict: "pass", reviewRisk: "low" }, "Passed its review, low risk"],
    ["review", { reviewVerdict: "findings" }, "The review found things to fix"],
    ["review", { reviewVerdict: "blocked" }, "The review could not finish"],
    ["review", null, "Review updated"],
    ["interrupted", null, "Updated: The update itself."],
  ])("authors %s as update content without a task-title prefix (%j)", (kind, data, expected) => {
    const line = taskFeedLine(record, event(kind, data));
    expect(line).toMatchObject({
      text: expected,
      taskKey: "FM3K-42",
      event: kind,
      at: 123,
    });
    // Renaming the task must not change either the update or its identity.
    const renamed = { ...record, title: "Renamed" };
    expect(taskFeedLine(renamed, event(kind, data))).toEqual(line);
  });

  it.each([
    "fm/task-42 is the branch to keep.",
    "src/index.ts contains the fix.",
    "pnpm test passed.",
    "iOS is the target.",
  ])("preserves deliberate lowercase names in authored notes: %s", (words) => {
    const line = taskFeedLine(record, {
      ...event("note", { feedLine: true }),
      text: words,
    });
    expect(line?.text).toBe(words);
    expect(taskFeedLine(record, event("report", { summary: words }))?.text).toBe(
      `Reported: ${words}`,
    );
  });

  it("keeps the update's own words, even when they name the task", () => {
    expect(taskFeedLine(record, event("report", { summary: record.title }))?.text).toBe(
      `Reported: ${record.title}`,
    );
  });

  it("keeps built-in-place and unassigned close updates without a title", () => {
    expect(
      taskFeedLine(
        { ...record, delivery: { mode: "in-place" } },
        event("status", { reason: "finished" }),
      )?.text,
    ).toBe("Built in place");
    expect(
      taskFeedLine({ ...record, assignee: null }, event("status", { reason: "cancelled" }))?.text,
    ).toBe("Updated: The update itself.");
  });

  it("keeps timeline-only events off the feed and preserves semantic kinds", () => {
    expect(taskFeedLine(record, { ...event("progress"), feed: false })).toBeNull();
    expect(taskFeedLine(record, event("landed"))?.kind).toBe("ok");
    expect(taskFeedLine(record, event("failed"))?.kind).toBe("danger");
    expect(taskFeedLine(record, event("status", { status: "dropped" }))?.kind).toBe("warn");
  });
});
