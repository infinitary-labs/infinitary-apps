import { describe, expect, it } from "vitest";
import { pushContract } from "./ipc";
import { readKeepingUnknown } from "./openLists";
import type { TaskBoard, TaskView } from "./tasks";
import { EMPTY_USAGE_AMOUNT, usageProjectSchema } from "./usage";

/**
 * INF-1649, the captain's "Yes, for what phones and views read": a view
 * keeps a member of an open list it does not know, as major 12's
 * `operation` reached views that did not know it, instead of losing the
 * whole board push.
 */
function row(id: string, kind: string): TaskView {
  return {
    id,
    key: `INF-${id}`,
    projectId: "infinitary",
    parentId: null,
    kind,
    title: `Task ${id}`,
    goal: "Deliver the named effect and report its evidence.",
    priority: 2,
    status: "active",
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 7",
    model: "claude-opus-5-5",
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 1_793_000_000_000,
    updatedAt: 1_793_000_100_000,
    startedAt: 1_793_000_050_000,
    closedAt: null,
  } as TaskView;
}

function board(tasks: TaskView[]): TaskBoard {
  return {
    seq: 41,
    at: 1_793_000_100_000,
    projects: [
      {
        id: "infinitary",
        key: "INF",
        name: "infinitary",
        repo: null,
        archived: false,
        counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: tasks.length, doneRecent: 0 },
      },
    ],
    tasks,
    links: [],
  };
}

describe("reading a newer home's open lists", () => {
  const schema = pushContract["inf:tasks"].payload;

  it("shows a task of a kind this view does not know as a task, and keeps every other row", () => {
    // A newer home's next kind, as `operation` was to a view on major 11.
    const pushed = board([row("1650", "inquiry"), row("1649", "question")]);
    expect(schema.safeParse(pushed).success).toBe(false);
    const read = readKeepingUnknown(schema, pushed);
    expect(read.success).toBe(true);
    expect(read.data?.tasks.map((task) => [task.key, task.kind])).toEqual([
      ["INF-1650", "work"],
      ["INF-1649", "question"],
    ]);
    // What the home sent is left as it came.
    expect(pushed.tasks[0]?.kind).toBe("inquiry");
  });

  it("counts a usage kind this view does not know as other task work", () => {
    const amount = { ...EMPTY_USAGE_AMOUNT, records: 3, counted: 3 };
    const read = readKeepingUnknown(usageProjectSchema, {
      project: { id: "infinitary", name: "infinitary" },
      amount,
      kinds: [
        { kind: "fix", amount },
        { kind: "audit", amount },
      ],
    });
    expect(read.success ? read.data.kinds.map((entry) => entry.kind) : read.error).toEqual([
      "fix",
      null,
    ]);
  });

  it("still refuses anything else that breaks the schema", () => {
    const broken = { ...board([row("1650", "inquiry")]), seq: "41" };
    expect(readKeepingUnknown(schema, broken).success).toBe(false);
    // A closed set that is not open, such as a task's status, still breaks views.
    const closed = board([{ ...row("1650", "work"), status: "paused" } as unknown as TaskView]);
    expect(readKeepingUnknown(schema, closed).success).toBe(false);
  });
});
