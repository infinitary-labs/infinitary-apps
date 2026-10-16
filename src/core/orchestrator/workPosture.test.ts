import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { deriveWorkPosture } from "./workPosture";

const base = {
  threadAwaitingAuthor: false,
  decisionCardOpen: false,
  captainGateOwed: false,
  deliverable: false,
  jobsRunning: false,
  pendingSettle: false,
  timedWait: false,
  checksWatched: false,
  accountHeld: false,
  waitsOnUnstarted: false,
  turnRunning: false,
  liveJobs: false,
  clientJobs: undefined,
  observable: true,
  blocked: false,
};
function record() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  seedTask(tasks, { id: "t", title: "Work", status: "idle", worktreeDir: "/scratch" });
  const record = tasks.get("t");
  if (!record) throw new Error("missing fixture task");
  return { db, tasks, record };
}

describe("host-derived work posture", () => {
  it.each([
    [{ turnRunning: true, accountHeld: true }, "active", "turn"],
    [{ liveJobs: true, decisionCardOpen: true, jobsRunning: false }, "active", "job"],
    [{ clientJobs: 1, decisionCardOpen: true }, "active", "job"],
    [{ checksWatched: true, decisionCardOpen: true }, "active", "checks"],
    [{ deliverable: true, decisionCardOpen: true }, "active", "guidance"],
    [{ threadAwaitingAuthor: true, decisionCardOpen: true }, "active", "guidance"],
    [{ pendingSettle: true }, "active", "settlement"],
    [{ accountHeld: true, deliverable: true }, "paused", "access"],
    [{ decisionCardOpen: true, observable: false }, "idle", "captain"],
    [{ blocked: true, observable: false }, "idle", "dependency"],
    [{ waitsOnUnderway: true, observable: false }, "idle", "dependency"],
    [{ waitsOnUnstarted: true, observable: false }, "idle", "dependency"],
    [{ waitsOnUnderway: true, decisionCardOpen: true }, "idle", "captain"],
    [{ observable: false }, "unknown", "unobserved"],
    [{ observable: false, clientJobs: 0 }, "idle", "inactive"],
    [{}, "idle", "inactive"],
  ] as const)("derives %j as %s (%s)", (patch, state, reason) => {
    const fixture = record();
    try {
      expect(deriveWorkPosture(fixture.record, () => ({ ...base, ...patch }))).toEqual({
        state,
        reason,
      });
    } finally {
      fixture.db.close();
    }
  });
  it("carries the typed cut-off on a held account, and only there", () => {
    const fixture = record();
    try {
      const hold = { class: "refused", provider: "Claude" } as const;
      expect(
        deriveWorkPosture(fixture.record, () => ({ ...base, accountHeld: true, hold })),
      ).toEqual({
        state: "paused",
        reason: "access",
        hold,
      });
      // A running turn outranks the hold, and says nothing of it.
      expect(
        deriveWorkPosture(fixture.record, () => ({
          ...base,
          accountHeld: true,
          turnRunning: true,
          hold,
        })),
      ).toEqual({ state: "active", reason: "turn" });
      // A quota-reset gate holds without a cut-off standing: no hold to name.
      fixture.tasks.setGate("t", { kind: "quota-reset", ref: "scope" });
      expect(
        deriveWorkPosture(fixture.tasks.get("t") ?? fixture.record, () => ({ ...base, hold })),
      ).toEqual({ state: "paused", reason: "access" });
    } finally {
      fixture.db.close();
    }
  });

  it("counts only finite automatic waits; a closed record never stays active", () => {
    const fixture = record();
    try {
      fixture.tasks.setGate("t", { kind: "at-time", until: 100 });
      expect(
        deriveWorkPosture(fixture.tasks.get("t") ?? fixture.record, () => ({
          ...base,
          timedWait: true,
        })).state,
      ).toBe("active");
      fixture.tasks.setGate("t", { kind: "at-time" });
      expect(
        deriveWorkPosture(fixture.tasks.get("t") ?? fixture.record, () => ({
          ...base,
          timedWait: true,
        })).state,
      ).toBe("idle");
      expect(
        deriveWorkPosture({ ...fixture.record, status: "done" }, () => ({
          ...base,
          liveJobs: true,
        })).state,
      ).toBe("idle");
    } finally {
      fixture.db.close();
    }
  });
});
