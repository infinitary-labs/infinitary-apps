import { HERE } from "@shared/deviceNames";
import { deviceJoinedLine } from "@shared/devices";
import { feedLineFrom } from "@shared/feed";
import { runsOnLine } from "@shared/repos";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { ActivityStore } from "../storage/activityStore";
import type { TaskEvent } from "../storage/taskEventStore";
import { seedTask } from "./seedTask";
import { type FeedSubject, recentFeed, taskFeedLine } from "./taskFeed";
import { TaskService } from "./taskService";

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
    // INF-1845: the merge's own line, the change and where it went in.
    ["merged", { line: "Merged #709 on GitHub" }, "Merged #709 on GitHub"],
    ["status", { container: true, reason: "finished" }, "Done: everything under it is finished"],
    ["status", { container: true, reason: "cancelled" }, "Stopped: nothing under it went ahead"],
    ["status", { reason: "answered", basisOf: "FM3K-43" }, "Answered: The update itself."],
    ["status", { reason: "answered", waitedOnBy: "FM3K-43" }, "Answered: The update itself."],
    // INF-1845: the captain's choice on an answer's card, never "Updated: chose".
    [
      "status",
      { reason: "answered", choice: "Approve and build" },
      'You chose "Approve and build"',
    ],
    ["status", { reason: "answered" }, "Answered"],
    ["status", { reason: "discarded" }, "Discarded"],
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

  // INF-1845, the captain's "stay consistent with desktop": a finished report is followed by Finished.
  it("leaves a finished report off the feed, and keeps one that is not", () => {
    expect(
      taskFeedLine(record, event("report", { summary: "All done.", finished: true })),
    ).toBeNull();
    expect(taskFeedLine(record, event("report", { summary: "All done." }))?.text).toBe(
      "Reported: All done.",
    );
  });

  // INF-1845: a merge that left the project's folder behind still says so, as a warning.
  it("paints a folder a merge left behind as a warning", () => {
    expect(
      taskFeedLine(record, event("note", { feedLine: true, folderRefresh: { cause: "dirty" } }))
        ?.kind,
    ).toBe("warn");
  });

  it("keeps timeline-only events off the feed and preserves semantic kinds", () => {
    expect(taskFeedLine(record, { ...event("progress"), feed: false })).toBeNull();
    expect(taskFeedLine(record, event("landed"))?.kind).toBe("ok");
    expect(taskFeedLine(record, event("failed"))?.kind).toBe("danger");
    expect(taskFeedLine(record, event("status", { status: "dropped" }))?.kind).toBe("warn");
  });
});

// INF-3486: a computer that controls the first mate names the first mate's
// computer where its own words say this computer, so the feed says which
// lines are its own words - never a crewmate's report or the captain's turn.
describe("the first mate's own words on the feed", () => {
  it("marks every line the first mate's computer wrote, and leaves the captain's and a crewmate's words unmarked", () => {
    const db = freshDatabase();
    try {
      const tasks = new TaskService({ db, strict: true });
      const signUp = seedTask(tasks, {
        id: "sign-up",
        title: "Sign up on the harbour site",
        status: "idle",
        startPolicy: "on-request",
        outcome: `The form is filled in on ${HERE.this} and waits for the captain's sign-in.`,
      });
      // The note the core writes when a saved sign-in is refused (`eventSeam`).
      const refused = `Your saved sign-in was not used for "${signUp.title}": No sign-in for harbour.example is saved on ${HERE.this}. Its browser is still paused for you.`;
      tasks.note(signUp.id, refused, { news: true, feed: true, data: { feedLine: true } });
      const activity = new ActivityStore(db);
      const joined = deviceJoinedLine({ name: "MacBook Air", kind: "view" });
      activity.record({ kind: "info", text: runsOnLine("harbour-site", null, true) });
      activity.record({ kind: "info", text: joined });
      const captain = feedLineFrom({
        type: "user_turn",
        text: `Keep the harbour site on ${HERE.this}.`,
      });
      if (!captain) throw new Error("The captain's turn writes a feed line");
      activity.record(captain);

      const lines = recentFeed(tasks, activity, 20).map(({ text, event, saidHere }) => ({
        text,
        event,
        saidHere,
      }));
      expect(lines).toEqual(
        expect.arrayContaining([
          { text: refused, event: "note", saidHere: true },
          { text: runsOnLine("harbour-site", null, true), event: undefined, saidHere: true },
          { text: joined, event: undefined, saidHere: true },
          { text: captain.text, event: undefined, saidHere: undefined },
          {
            text: `Reported: The form is filled in on ${HERE.this} and waits for the captain's sign-in.`,
            event: "report",
            saidHere: undefined,
          },
        ]),
      );
      // Each of those sentences says this computer, so each one marked is named on a view.
      expect(lines.filter((line) => line.text.includes(HERE.this))).toHaveLength(5);
    } finally {
      db.close();
    }
  });
});
