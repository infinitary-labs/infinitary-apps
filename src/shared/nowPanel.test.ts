import { describe, expect, it } from "vitest";
import type { Card } from "./cards";
import { nowGroupOf, nowGroupsOf, taskStatusWord } from "./nowPanel";
import type { TaskView } from "./tasks";
import { presentBoard } from "./taskWaiting";

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    key: "SCR-1",
    projectId: "scratch",
    parentId: null,
    kind: "work",
    title: "A task",
    goal: null,
    priority: 2,
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    closedAt: null,
    ...overrides,
  };
}

const needsYou = { blocked: false, held: false, needsYou: true, ready: false };

describe("nowGroupOf", () => {
  it("INF-476 puts minimized notes on their own task row, including done work, without changing its operational waiting", () => {
    const note: Card = {
      id: "launch-note",
      taskId: "t1",
      author: "firstmate",
      priority: 20,
      title: "The launch review is ready",
      meta: "firstmate",
      body: "<p>The review stays beside Friday’s launch.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
      minimized: true,
    };
    const original = task({ status: "done", closedAt: 1000 });
    const board = { seq: 1, at: 1000, projects: [], tasks: [original], links: [] };
    const projected = presentBoard(board, [note]);
    expect(projected.tasks).toHaveLength(1);
    expect(projected.tasks[0]).toMatchObject({
      id: original.id,
      key: original.key,
      status: "done",
      waitingCardId: null,
      minimizedCardId: note.id,
    });
    expect(nowGroupOf(projected.tasks[0]!)).toBe("waiting");
    expect(board.tasks[0]).toBe(original);
    expect(nowGroupOf(presentBoard(board, [{ ...note, minimized: undefined }]).tasks[0]!)).toBe(
      "landed",
    );
    const { taskId: _task, ...standalone } = note;
    const alone = presentBoard({ ...board, tasks: [] }, [standalone]);
    expect(alone.tasks).toHaveLength(1);
    expect(alone.tasks[0]).toMatchObject({ key: "", title: note.title, minimizedCardId: note.id });
    expect(nowGroupOf(alone.tasks[0]!)).toBe("waiting");
  });
  // INF-1293 approved rule: work and author-owed replies outrank putting a
  // card aside, without hiding a separate ready choice or changing the mark.
  it.each([
    { activity: "running", workPosture: undefined },
    { activity: "idle", workPosture: { state: "active", reason: "job" } },
    { activity: "idle", workPosture: { state: "active", reason: "guidance" } },
    { activity: "idle", workPosture: { state: "active", reason: "checks" } },
  ] as const)("keeps continuing work under Working: %j", (state) => {
    const original = task({ status: "active", minimizedCardId: "launch-update", ...state });
    const note: Card = {
      id: "launch-update",
      taskId: original.id,
      author: "firstmate",
      priority: 20,
      title: "The launch review continues",
      meta: "firstmate",
      body: "<p>Checking the launch.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
      minimized: true,
    };
    const board = { seq: 1, at: 1000, projects: [], tasks: [original], links: [] };
    const projected = presentBoard(board, [note]);
    expect(nowGroupOf(projected.tasks[0]!)).toBe("working");
    expect(taskStatusWord(projected.tasks[0]!)).toBe("Working");
    expect(note.minimized).toBe(true);
    const choice = { ...note, id: "launch-choice", actions: [{ id: "go", label: "Launch" }] };
    const ready = presentBoard({ ...board, tasks: [{ ...original, waitingCardId: choice.id }] }, [
      note,
      choice,
    ]);
    expect(nowGroupOf(ready.tasks[0]!)).toBe("waiting");
    expect(taskStatusWord(ready.tasks[0]!)).toBe("Waiting on you");
    const required = presentBoard(
      {
        ...board,
        tasks: [
          {
            ...original,
            requiredAction: {
              cardId: "captain-action",
              state: "ready",
              result: "Approve the launch",
            } as const,
          },
        ],
      },
      [note],
    );
    expect(nowGroupOf(required.tasks[0]!)).toBe("waiting");
    expect(taskStatusWord(required.tasks[0]!)).toBe("Waiting on you");
  });

  it("keeps an unanswered minimized decision in Working while preserving a paused mark", () => {
    const original = task({
      status: "active",
      activity: "idle",
      workPosture: { state: "paused", reason: "access" },
    });
    const choice: Card = {
      id: "launch-choice",
      taskId: original.id,
      author: "firstmate",
      priority: 20,
      title: "Choose the launch day",
      meta: "firstmate",
      body: "<p>Choose a day.</p>",
      actions: [{ id: "go", label: "Friday" }],
      status: "ready",
      createdAt: 1000,
      minimized: true,
      awaiting: "answer",
    };
    const board = { seq: 1, at: 1000, projects: [], tasks: [original], links: [] };
    const projected = presentBoard(board, [choice]);
    expect(nowGroupOf(projected.tasks[0]!)).toBe("working");
    expect(taskStatusWord(projected.tasks[0]!)).toBe("Idle");
    expect(projected.tasks[0]!.workPosture).toEqual(original.workPosture);
    // A completed reply restores the original minimized-card rule, not a
    // new lifecycle rule for idle/finished notes.
    const answered = presentBoard(board, [{ ...choice, awaiting: undefined }]);
    expect(nowGroupOf(answered.tasks[0]!)).toBe("waiting");
    expect(choice.minimized).toBe(true);
  });

  it("puts anything that needs the captain first, whatever its status", () => {
    expect(nowGroupOf(task({ status: "open", waitingCardId: "ready", flags: needsYou }))).toBe(
      "waiting",
    );
    expect(
      nowGroupOf(
        task({ status: "active", activity: "idle", waitingCardId: "ready", flags: needsYou }),
      ),
    ).toBe("waiting");
    // needsYou wins even over an idle row with an open PR.
    expect(
      nowGroupOf(
        task({
          status: "active",
          activity: "idle",
          waitingCardId: "ready",
          flags: needsYou,
          delivery: { mode: "direct-pr", prUrl: "https://x/pr/1" },
        }),
      ),
    ).toBe("waiting");
    expect(
      nowGroupOf(
        task({ kind: "decision", status: "open", waitingCardId: "ready", flags: needsYou }),
      ),
    ).toBe("waiting");
    // A declaration alone is not a reachable decision (FI3-702).
    expect(
      nowGroupOf(task({ status: "active", activity: "idle", captainWait: true, flags: needsYou })),
    ).toBe("working");
  });

  it("maps the live statuses onto working, queued and backlog", () => {
    expect(nowGroupOf(task({ status: "active", activity: "running" }))).toBe("working");
    expect(nowGroupOf(task({ status: "active", activity: "interrupted" }))).toBe("working");
    // An idle crewmate with no unmerged work is working.
    expect(nowGroupOf(task({ status: "active", activity: "idle" }))).toBe("working");
    // An idle crewmate with unmerged work - an open PR that has not merged ...
    expect(
      nowGroupOf(
        task({
          status: "active",
          activity: "idle",
          delivery: { mode: "direct-pr", prUrl: "https://x/pr/1" },
        }),
      ),
    ).toBe("working");
    // ... or a report on a non-direct-pr worktree - stays working too.
    expect(
      nowGroupOf(
        task({
          status: "active",
          activity: "idle",
          delivery: { mode: "local-only" },
          outcomeSummary: "done",
        }),
      ),
    ).toBe("working");
    expect(
      nowGroupOf(
        task({
          status: "active",
          activity: "idle",
          delivery: { mode: "direct-pr" },
          outcomeSummary: "done",
        }),
      ),
    ).toBe("working");
    // Open work by its start policy: queued starts by itself, the backlog
    // waits for the captain's word. A blocker or a hold changes neither.
    expect(nowGroupOf(task({ status: "open" }))).toBe("queued");
    expect(
      nowGroupOf(
        task({
          status: "open",
          flags: { blocked: true, held: false, needsYou: false, ready: false },
        }),
      ),
    ).toBe("queued");
    expect(nowGroupOf(task({ status: "open", startPolicy: "on-request" }))).toBe("backlog");
    expect(
      nowGroupOf(
        task({
          status: "open",
          startPolicy: "on-request",
          flags: { blocked: false, held: true, needsYou: false, ready: false },
        }),
      ),
    ).toBe("backlog");
  });

  it("lists landed work and nothing else that closed", () => {
    expect(nowGroupOf(task({ status: "done", closedReason: "landed" }))).toBe("landed");
    expect(nowGroupOf(task({ status: "done", closedReason: "merged" }))).toBe("landed");
    expect(nowGroupOf(task({ status: "dropped", closedReason: "discarded" }))).toBeNull();
    // An answered question or a settled operation is not landed work.
    expect(nowGroupOf(task({ kind: "question", status: "done", closedReason: "answered" }))).toBe(
      null,
    );
    expect(nowGroupOf(task({ kind: "operation", status: "done", closedReason: "settled" }))).toBe(
      null,
    );
    expect(nowGroupOf(task({ kind: "decision", status: "done", closedReason: "answered" }))).toBe(
      null,
    );
  });
});

describe("nowGroupsOf", () => {
  it("keeps a working child's whole tree under working, each task's own group unchanged", () => {
    const parent = task({ id: "p", status: "open" });
    const child = task({ id: "c", parentId: "p", status: "active", activity: "running" });
    const sibling = task({ id: "s", parentId: "p", status: "open" });
    const waits = task({ id: "w", parentId: "p", status: "open", waitingCardId: "ready" });
    const board = { tasks: [parent, child, sibling, waits] };
    expect([...nowGroupsOf(board).values()]).toEqual(["working", "working", "working", "waiting"]);
    expect(board.tasks.map(nowGroupOf)).toEqual(["queued", "working", "queued", "waiting"]);
  });

  // The captain: "remove already-done tasks from the 'working' section in
  // tasks panel" - his Tasks panel listed finished reviews and a finished
  // plan with check marks under working parents.
  it("leaves finished work out of a working tree, under done", () => {
    const done = { status: "done", closedReason: "finished", closedAt: 5 } as const;
    const fix = task({ id: "fix", title: "Fix: browser command", status: "active" });
    const reviews = [1, 2].map((n) =>
      task({ id: `review-${n}`, parentId: "fix", title: "Review: Fix: browser command", ...done }),
    );
    const app = task({ id: "ios", title: "Infinitary iOS app", startPolicy: "on-request" });
    const plan = task({ id: "plan", parentId: "ios", title: "Plan: split the iOS app", ...done });
    const join = task({
      id: "join",
      parentId: "ios",
      title: "Your Mac lets a phone join",
      ...done,
    });
    const joinReview = task({ id: "join-review", parentId: "join", title: "Review", ...done });
    const store = task({ id: "store", parentId: "ios", title: "The phone app in the App Store" });
    const phone = task({
      id: "phone",
      parentId: "ios",
      title: "The phone app joins your Mac",
      status: "active",
      activity: "running",
    });
    const phoneReview = task({ id: "phone-review", parentId: "phone", title: "Review", ...done });
    const board = {
      tasks: [fix, ...reviews, app, plan, join, joinReview, store, phone, phoneReview],
    };
    expect(Object.fromEntries(nowGroupsOf(board))).toEqual({
      fix: "working",
      "review-1": "landed",
      "review-2": "landed",
      ios: "working",
      plan: "landed",
      join: "landed",
      "join-review": "landed",
      store: "working",
      phone: "working",
      "phone-review": "landed",
    });

    // Parts a merge kept open under a finished parent are not one working
    // tree through it: each keeps its own group.
    const merged = task({ id: "merged", title: "Ship the phone app", ...done });
    const kept = task({ id: "kept", parentId: "merged", title: "Add widgets" });
    const started = task({
      id: "started",
      parentId: "merged",
      title: "Add a share sheet",
      status: "active",
      activity: "running",
    });
    expect(Object.fromEntries(nowGroupsOf({ tasks: [merged, kept, started] }))).toEqual({
      merged: "landed",
      kept: "queued",
      started: "working",
    });
  });
});

describe("taskStatusWord", () => {
  it("delegates to the shared lifecycle reading", () => {
    expect(taskStatusWord(task({ status: "open", startPolicy: "on-request" }))).toBe("Backlog");
    expect(taskStatusWord(task({ status: "open", startPolicy: "when-ready" }))).toBe("Queued");
    expect(taskStatusWord(task({ status: "active", activity: "running" }))).toBe("Working");
    expect(taskStatusWord(task({ status: "done", closedReason: "answered" }))).toBe("Done");
    expect(taskStatusWord(task({ status: "dropped", closedReason: "failed" }))).toBe("Dropped");
  });
});
