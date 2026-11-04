import { describe, expect, it } from "vitest";
import { type TaskStatusInput, taskStatusOf } from "./taskPresentation";
import {
  recordAttentionWaits,
  type TaskWait,
  taskWaitStatus,
  taskWaitSummary,
  taskWaitText,
} from "./taskWaits";

// INF-2197 item 3 / approved INF-2215: grouped kanban names, every wait in full detail,
// no list changes, no duplicate facts and no invented end times.
const now = Date.parse("2026-11-01T08:00:00Z");
const watches = [
  {
    id: "run:42:1",
    kind: "run",
    label: "Website checks",
    since: now - 60000,
    next: { kind: "next-read", at: now + 60000 },
  },
  {
    id: "run:43:1",
    kind: "run",
    label: "Phone checks",
    since: now - 120000,
    next: { kind: "next-read", at: now + 120000 },
  },
  { id: "dependency:web", kind: "dependency", label: "WEB-41", taskKeys: ["WEB-41"] },
] satisfies [TaskWait, TaskWait, TaskWait];
const task: TaskStatusInput = {
  status: "active",
  activity: "idle",
  startPolicy: "when-ready",
  closedReason: null,
  workPosture: { state: "active", reason: "checks" },
  flags: { blocked: false, held: false, needsYou: false, ready: false },
  waitingCardId: null,
  children: { total: 0, closed: 0 },
  blockedBy: ["WEB-41"],
};
describe("recorded task wait presentation", () => {
  it("groups names but keeps every source and picks the earliest standing event, even overdue", () => {
    const summary = taskWaitSummary(watches, now + 90000);
    if (!summary) throw new Error("No watch summary");
    expect(summary.names).toBe("2 watched runs + WEB-41");
    expect(summary.event).toBe(taskWaitText(watches[0], now + 90000, false));
    expect(summary.event).toContain("was due");
    expect(taskWaitText(watches[1], now, true)).toContain("Phone checks");
    expect(taskWaitText(watches[2], now)).toBe("WEB-41 · time unknown");
  });
  it("combines equal-time event labels without attaching one event to another cause", () => {
    const equal = [
      watches[0],
      {
        id: "job",
        kind: "job",
        label: "Build",
        next: { kind: "check-back", at: watches[0].next.at },
      },
    ] satisfies [TaskWait, TaskWait];
    expect(taskWaitSummary(equal, now)?.event).toContain("next events");
    expect(taskWaitText(equal[0], now)).toContain("next read");
    expect(taskWaitText(equal[1], now)).toContain("check-back");
  });
  it("identifies both occurrences of a repeated local hour, and dates another day", () => {
    const one: TaskWait = {
      id: "start",
      kind: "start",
      label: "Scheduled start",
      next: { kind: "start", at: Date.parse("2026-11-01T08:30:00Z") },
    };
    const two: TaskWait = {
      ...one,
      next: { kind: "start", at: Date.parse("2026-11-01T09:30:00Z") },
    };
    const first = taskWaitText(one, now, false, "America/Los_Angeles");
    const second = taskWaitText(two, now, false, "America/Los_Angeles");
    expect(first).toContain("1:30 AM PDT");
    expect(second).toContain("1:30 AM PST");
    expect(taskWaitText(two, now - 86400000, false, "America/Los_Angeles")).toContain("Nov 1");
  });
  it("leaves the shared list status unchanged while permitted headers avoid repeating Checks and Blocked by", () => {
    const input = { ...task, waits: watches };
    const original = taskStatusOf(input);
    expect(original.reason).toBe("Waiting for checks");
    expect(taskWaitStatus(input, original, now).reason).toBe("");
    expect(taskStatusOf(input)).toEqual(original);
    expect(taskWaitStatus(task, original, now)).toBe(original);
    expect(recordAttentionWaits(input).map((wait) => wait.id)).toEqual(["dependency:web"]);
  });
  it("keeps a lone job check-back in its header, and never suppresses access, interruption or reach guidance", () => {
    const input = {
      ...task,
      blockedBy: [],
      workPosture: { state: "active" as const, reason: "job" as const },
      waits: [
        {
          id: "job",
          kind: "job" as const,
          label: "Website build",
          next: { kind: "check-back" as const, at: now + 60000 },
        },
      ],
    };
    expect(recordAttentionWaits(input)).toEqual([]);
    expect(taskWaitStatus(input, taskStatusOf(input), now).reason).toContain(
      "Website build · check-back",
    );
    const away = {
      ...taskStatusOf(input),
      outOfReach: true as const,
      reason: "Mac mini is out of reach",
    };
    expect(taskWaitStatus(input, away, now).reason).toContain(away.reason);
    expect(taskWaitStatus(input, away, now).reason).toContain("Website build · check-back");
    const access = {
      ...input,
      workPosture: {
        state: "paused" as const,
        reason: "access" as const,
        hold: { class: "signed_out" as const, provider: "Codex" },
      },
    };
    const accessReading = taskStatusOf(access);
    expect(taskWaitStatus(access, accessReading, now).reason).toContain(accessReading.reason);
    const stopped = {
      ...taskStatusOf(input),
      mark: "interrupted" as const,
      reason: "Work was interrupted",
    };
    expect(taskWaitStatus(input, stopped, now).reason).toContain(stopped.reason);
  });
});

// A ready choice keeps its meaningful merge wording; a paused declaration belongs to the existing box.
it("keeps each decision wait in its current owner without losing its recorded time", () => {
  const decision: TaskWait = {
    id: "decision",
    kind: "decision",
    label: "Waiting for your decision",
    since: now - 60000,
  };
  const ready = {
    ...task,
    waitingCardId: "review",
    waitingCardMerges: true as const,
    waits: [decision],
  };
  expect(recordAttentionWaits(ready)).toEqual([]);
  expect(taskWaitStatus(ready, taskStatusOf(ready), now).reason).toContain(
    "Waiting for your merge · time unknown · wait recorded",
  );
  const paused = {
    ...task,
    waitingCardId: null,
    workPosture: { state: "idle" as const, reason: "captain" as const },
    waits: [decision],
  };
  expect(recordAttentionWaits(paused)).toEqual([decision]);
  expect(taskWaitStatus(paused, taskStatusOf(paused), now).reason).toBe("");
});
