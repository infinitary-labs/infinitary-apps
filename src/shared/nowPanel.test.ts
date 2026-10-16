import { describe, expect, it } from "vitest";
import { nowGroupOf, nowGroupsOf, taskStatusWord } from "./nowPanel";
import type { TaskView } from "./tasks";

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
