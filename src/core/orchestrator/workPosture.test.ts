import { BATCH_CHECK, BATCH_STATUS_WORDS, BATCH_WAITING_WORDS } from "@shared/batches";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { deriveWorkPosture, WorkPostures } from "./workPosture";

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
      fixture.tasks.placement.setGate("t", { kind: "quota-reset", ref: "scope" });
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
      fixture.tasks.placement.setGate("t", { kind: "at-time", until: 100 });
      expect(
        deriveWorkPosture(fixture.tasks.get("t") ?? fixture.record, () => ({
          ...base,
          timedWait: true,
        })).state,
      ).toBe("active");
      fixture.tasks.placement.setGate("t", { kind: "at-time" });
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

// Approved batch-gate design: a change waiting in its batch is not an ordinary checks wait.
// Read the real delivery writer and the place its batch keeps (`batchStatus`) at the cheapest posture layer.
describe("pending batch presentation", () => {
  const head = "ddbb0143092fc2824c32444daf72dccdd8259e62";
  const pending = { name: BATCH_CHECK, state: "pending" as const };
  it.each([
    [BATCH_WAITING_WORDS, "waiting"],
    [BATCH_STATUS_WORDS.batch, "in-batch"],
    [BATCH_STATUS_WORDS.held("checks"), "paused"],
  ] as const)("keeps %s distinct", (words, batch) => {
    const fixture = record();
    try {
      fixture.tasks.delivery.recordChangeEvidence("t", {
        headSha: head,
        checks: {
          headSha: head,
          items: [pending],
          absenceDeclared: false,
        },
        queueStatus: { head, kind: batch, words },
      });
      const task = fixture.tasks.get("t");
      if (!task?.delivery) throw new Error("Missing offered change");
      expect(deriveWorkPosture(task, () => ({ ...base, checksWatched: true }))).toEqual({
        state: "active",
        reason: "checks",
        batch,
      });
      expect(deriveWorkPosture(task, () => ({ ...base, turnRunning: true }))).toEqual({
        state: "active",
        reason: "turn",
      });
      expect(deriveWorkPosture(task, () => ({ ...base, accountHeld: true }))).toEqual({
        state: "paused",
        reason: "access",
      });
      // The old status must not light a newly offered version.
      expect(
        deriveWorkPosture(
          { ...task, delivery: { ...task.delivery, headSha: `${head.slice(0, -1)}3` } },
          () => ({ ...base, checksWatched: true }),
        ),
      ).toEqual({ state: "active", reason: "checks" });
    } finally {
      fixture.db.close();
    }
  });

  it("shows a change in line with no place kept yet, but a passed or failed reading ends the gate", () => {
    const fixture = record();
    try {
      const marked = {
        ...fixture.record,
        delivery: {
          mode: "queue-pr" as const,
          headSha: head,
          checks: { headSha: head, items: [pending], absenceDeclared: false },
        },
      };
      expect(deriveWorkPosture(marked, () => base)).toEqual({
        state: "active",
        reason: "checks",
        batch: "waiting",
      });
      for (const state of ["success", "failure"] as const) {
        expect(
          deriveWorkPosture(
            {
              ...marked,
              delivery: {
                ...marked.delivery,
                checks: {
                  headSha: head,
                  items: [{ name: BATCH_CHECK, state }],
                  absenceDeclared: false,
                },
              },
            },
            () => ({ ...base, checksWatched: true }),
          ),
        ).toEqual({ state: "active", reason: "checks" });
      }
      expect(deriveWorkPosture({ ...marked, status: "done" }, () => base)).toEqual({
        state: "idle",
        reason: "inactive",
      });
    } finally {
      fixture.db.close();
    }
  });
});

// A running task's wait carries when its background work started, as the first
// mate's "running since" line reads it, so the record header can say so.
describe("the wait facts of background work", () => {
  const hostStart = Date.parse("2026-11-28T01:05:00Z");
  const clientStart = Date.parse("2026-11-28T00:51:15Z");
  function postures(runtime: Partial<TaskRuntime>, host: { running?: boolean }) {
    const options = {
      tasks: {
        projectedFact: (_record: unknown, _key: symbol, read: () => unknown) => read(),
        graph: { flagsOf: () => ({ blocked: false }) },
      },
      inbox: { stuck: () => false, outage: () => ({ failures: 0 }) },
      hasRunningJobs: () => host.running === true,
      oldestRunningJob: () =>
        host.running ? { jobId: "j1", command: "pnpm test", startedAt: hostStart } : undefined,
    } as unknown as CrewSupervisorOptions;
    return new WorkPostures(options, {
      now: () => Date.parse("2026-11-28T01:13:00Z"),
      witnesses: () => ({}),
      heldBy: () => undefined,
      runtime: () =>
        ({
          turn: { busy: false },
          session: { controlProfile: { backgroundWork: "host" } },
          ...runtime,
        }) as TaskRuntime,
    } as never);
  }
  const active = (r: TaskRecord) => ({ ...r, status: "active" as const });

  it("carries the client's start time while only the client reports background work", () => {
    const fixture = record();
    try {
      const facts = postures({ clientJobs: 1, clientJobsSince: clientStart }, {}).workWaitFacts(
        active(fixture.record),
      );
      expect(facts).toMatchObject({ job: true, jobSince: clientStart });
    } finally {
      fixture.db.close();
    }
  });
  it("carries the earlier of the host's job and the client's work", () => {
    const fixture = record();
    try {
      const facts = postures(
        { clientJobs: 1, clientJobsSince: clientStart },
        {
          running: true,
        },
      ).workWaitFacts(active(fixture.record));
      expect(facts).toMatchObject({ job: true, jobSince: clientStart });
      const hostOnly = postures({}, { running: true }).workWaitFacts(active(fixture.record));
      expect(hostOnly).toMatchObject({ job: true, jobSince: hostStart });
    } finally {
      fixture.db.close();
    }
  });
  it("takes the host's job start when it began before the client's work", () => {
    const fixture = record();
    try {
      const later = hostStart + 600_000;
      const facts = postures(
        { clientJobs: 1, clientJobsSince: later },
        {
          running: true,
        },
      ).workWaitFacts(active(fixture.record));
      expect(facts).toMatchObject({ job: true, jobSince: hostStart });
    } finally {
      fixture.db.close();
    }
  });
  it("ignores an earlier client start left over after its work ended while a host job runs", () => {
    const fixture = record();
    try {
      const facts = postures(
        { clientJobs: 0, clientJobsSince: clientStart },
        {
          running: true,
        },
      ).workWaitFacts(active(fixture.record));
      expect(clientStart).toBeLessThan(hostStart);
      expect(facts).toMatchObject({ job: true, jobSince: hostStart });
    } finally {
      fixture.db.close();
    }
  });
  it("names no start when a client job runs but none of its time is known, or nothing runs", () => {
    const fixture = record();
    try {
      const unknown = postures({ clientJobs: 1 }, {}).workWaitFacts(active(fixture.record));
      expect(unknown.job).toBe(true);
      expect("jobSince" in unknown).toBe(false);
      const stale = postures({ clientJobs: 0, clientJobsSince: clientStart }, {}).workWaitFacts(
        active(fixture.record),
      );
      expect(stale.job).toBe(false);
      expect("jobSince" in stale).toBe(false);
    } finally {
      fixture.db.close();
    }
  });
  it("names no start when no job runs", () => {
    const fixture = record();
    try {
      const facts = postures({ clientJobs: 0 }, {}).workWaitFacts(active(fixture.record));
      expect(facts.job).toBe(false);
      expect("jobSince" in facts).toBe(false);
    } finally {
      fixture.db.close();
    }
  });
});
