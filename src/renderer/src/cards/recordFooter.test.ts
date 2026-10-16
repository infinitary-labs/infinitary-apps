import type { TaskView } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { recordPillToneOf } from "./recordFooter";

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    key: "FI3-1",
    projectId: "p1",
    parentId: null,
    kind: "work",
    title: "Write the ADR",
    goal: null,
    priority: 2,
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "on-request",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
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
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    closedAt: null,
    ...overrides,
  } as TaskView;
}

describe("the record's status pill tint", () => {
  it("tints for waiting on you and for interrupted or failed work, and stays neutral otherwise", () => {
    expect(
      recordPillToneOf(
        task({
          status: "active",
          activity: "idle",
          waitingCardId: "ready-choice",
          flags: { ...task().flags, needsYou: true },
        }),
      ),
    ).toBe("accent");
    expect(recordPillToneOf(task({ flags: { ...task().flags, needsYou: true } }))).toBe("neutral");
    expect(recordPillToneOf(task({ status: "active", activity: "interrupted" }))).toBe("danger");
    expect(recordPillToneOf(task({ status: "dropped", closedReason: "failed" }))).toBe("danger");
    expect(recordPillToneOf(task({ status: "active", activity: "running" }))).toBe("neutral");
    expect(recordPillToneOf(task())).toBe("neutral");
  });
});
