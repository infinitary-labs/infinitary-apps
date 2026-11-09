/**
 * The idle ladder's witnesses (`IdleLadder`; docs/report-sort.md): a
 * wait on work underway, the gate as a witness, and a request the first
 * mate is reminded of.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * One case drives real git, so the file is an integration test.
 */

import type { Card } from "@shared/cards";
import { formatDurationShort } from "@shared/quotaSignals";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  syncCardId,
} from "../../../tests/helpers/crewHarness";
import {
  failTurn,
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgeCheckState } from "../forge";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { ORDINARY_NOTE_READ_ACK } from "../prompts/cardContract";
import { InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import { BASELINE_OBSERVATIONS_NEXT, declareCheckAction, observeCheckRepair } from "./checkRepair";
import type { CrewSupervisor } from "./crewSupervisor";
import { JOB_BOUND_MS, STALL_WAKE_MS, STILL_DOWN_MS } from "./idleLadder";
import { IDLE_NUDGE_TEXT } from "./idleWakes";
import { FINISHED_REPORT_WORDS } from "./reportWakes";
import { Ticker } from "./ticker";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the idle ladder (idle crew recovery, docs/report-sort.md)", () => {
  const { clock, hostClock, clockedSetup, stopped, sweepWhenDue } = idleLadderHarness();
  const failureWakes = (ops: string[]) =>
    ops.filter((line) => line.includes("failed at the provider"));

  // FI3-250: a wait on work another crewmate is doing is not idleness. The
  // ladder reads it as moving, and the sweep resumes the waiting crewmate
  // when that work closes - the timed wait's pattern, with the work's close
  // in place of the time.
  describe("a wait on work underway (FI3-250)", () => {
    const resumes = (tasks: TaskService, taskId: string) =>
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "steered" && event.actor === "supervisor");

    /** A crewmate that stopped while its task waits on work another crewmate holds. */
    async function waitingOn(wait: "blocks" | "baseline") {
      const harness = await stopped();
      const { tasks, taskId } = harness;
      const owner = seedTask(tasks, {
        id: "dep-owner",
        title: "Fix the shared fixture",
        status: "running",
      });
      if (wait === "blocks") {
        tasks.graph.link(owner.id, taskId, "blocks", "firstmate");
      } else {
        // The real producers: a failed reading, then the crewmate's declaration.
        const failed = [{ name: "linux-checks", state: "failure" as const }];
        seedDelivery(tasks, taskId, {
          headSha: "head-1",
          ci: "red",
          ...observeCheckRepair(undefined, "head-1", failed, clock.now),
        });
        const declared = declareCheckAction(
          tasks,
          taskId,
          {
            diagnosis: {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "The same assertion fails on untouched main",
              dependencyTask: owner.id,
            },
          },
          clock.now,
        );
        expect(declared.text).toContain(`${owner.key} "Fix the shared fixture" is underway`);
        expect(declared.text).toContain(BASELINE_OBSERVATIONS_NEXT);
      }
      return { ...harness, owner };
    }

    it.each(["blocks", "baseline"] as const)(
      "a %s wait is moving: no nudge, wake or card past every rung, and the task reads as waiting",
      async (wait) => {
        const { supervisor, crewmate, ops, sorts, cards, tasks, taskId, at } =
          await waitingOn(wait);
        const prompts = crewmate.promptCalls.length;
        for (const at_ of [10, 20, 50, 80, 600]) await at(minutes(at_));
        expect(crewmate.promptCalls).toHaveLength(prompts);
        expect(idleWakes(ops)).toEqual([]);
        expect(cards().filter((card) => card.taskId === taskId)).toEqual([]);
        expect(sorts.filter((row) => row.taskId === taskId).map((row) => row.rule)).toEqual([
          "stopped",
        ]);
        expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBeUndefined();
        const record = tasks.get(taskId);
        expect(record && supervisor.postures.workPosture(record)).toEqual({
          state: "idle",
          reason: "dependency",
        });
      },
    );

    it("the shared tick wakes a waiting pull request when the default branch's run of its check passes (INF-833 Fix 4)", async () => {
      let main = "a".repeat(40);
      let items: { name: string; state: ForgeCheckState }[] = [
        { name: "linux-checks", state: "failure" },
      ];
      const crewmate = fakeCrewmate();
      const harness = wakesThroughInbox(
        clockedSetup(crewmate, {
          readMainChecks: async () => ({ kind: "read", sha: main, items }),
        }),
      );
      const { repo } = await harness.repos.setup({ kind: "init", name: "watched" });
      const { taskId } = await harness.supervisor.intake.commission({
        title: "Ship it",
        intent: intentOf("Ship the fix"),
        repoId: repo.id,
      });
      await settle();
      await endTurn(crewmate, taskId, "Waiting on the phone failure.");
      const owner = seedTask(harness.tasks, {
        id: "main-owner",
        title: "Fix the phone failure",
        status: "running",
        repoId: repo.id,
      });
      seedDelivery(harness.tasks, taskId, {
        headSha: "head-1",
        ci: "red",
        prNumber: 290,
        ...observeCheckRepair(
          undefined,
          "head-1",
          [{ name: "linux-checks", state: "failure" }],
          clock.now,
        ),
      });
      expect(
        declareCheckAction(
          harness.tasks,
          taskId,
          {
            diagnosis: {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "The same assertion fails on untouched main",
              dependencyTask: owner.id,
            },
          },
          clock.now,
        ).text,
      ).toContain("Diagnosis recorded");
      const prompts = crewmate.promptCalls.length;
      await harness.supervisor.watch.pollCheckWatches(clock.now);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts + 1);
      await endTurn(crewmate, taskId, "Still waiting for the named baseline work.");
      // Captain F5: a final reading wakes once per commit; the baseline fix is a new commit.
      main = "b".repeat(40);
      items = [{ name: "linux-checks", state: "success" }];
      await harness.supervisor.watch.pollCheckWatches(clock.now);
      await settle();
      expect(crewmate.promptCalls.at(-1)).toContain("The default branch reports finished checks");
      expect(crewmate.promptCalls.at(-1)).toContain("Judge whether this clears your declared wait");
      expect(crewmate.promptCalls.at(-1)).toContain(JSON.stringify(items));
      expect(harness.tasks.get(taskId)?.idleSince).toBeNull();
      await harness.supervisor.watch.pollCheckWatches(clock.now);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts + 2);
    });

    it("a report on a Pi crewmate waiting on work underway wakes nobody", async () => {
      const { crewmate, ops, sorts, supervisor, taskId } = await waitingOn("baseline");
      await supervisor.steer.steerCrewmate(taskId, "how is it going?");
      await settle();
      await endTurn(crewmate, taskId, "Still waiting on the shared fixture fix.");
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" });
      expect(ops.filter((line) => line.includes("Still waiting on the shared fixture"))).toEqual(
        [],
      );
    });

    it.each([
      [
        "blocks",
        "done",
        'SCR-2 "Fix the shared fixture", which your task could not merge before, is done. Carry on from where you stopped.',
      ],
      [
        "blocks",
        "dropped",
        'SCR-2 "Fix the shared fixture", which your task could not merge before, was dropped and no longer holds it. Carry on from where you stopped.',
      ],
      [
        "baseline",
        "done",
        'SCR-2 "Fix the shared fixture", the separately owned work your failing checks waited on, is done. Bring your change up to date and read the checks again.',
      ],
      [
        "baseline",
        "dropped",
        'SCR-2 "Fix the shared fixture", the separately owned work your failing checks waited on, was dropped, so nobody is fixing that failure. Lead your report with its key and that it was dropped: that report wakes the first mate, which decides the next move.',
      ],
    ] as const)(
      "a %s wait whose work closed %s is one steer on the task's own lane, once",
      async (wait, closed, words) => {
        const { supervisor, crewmate, sorts, tasks, taskId, owner, at } = await waitingOn(wait);
        await at(minutes(30));
        tasks.close(
          owner.id,
          closed === "done"
            ? { status: "done", reason: "merged", actor: "captain" }
            : { status: "dropped", reason: "cancelled", actor: "captain" },
        );
        await supervisor.watch.sweepGates(clock.now);
        await settle();
        expect(crewmate.promptCalls.at(-1)).toBe(words);
        expect(resumes(tasks, taskId)).toHaveLength(1);
        // The wait's end opened a new episode: the turn it starts is the
        // task's own, and its report is sorted like any other.
        await endTurn(crewmate, taskId, "Carried on from the wait.");
        expect(sorts.at(-1)?.rule).toBe("stopped");
        await supervisor.watch.sweepGates(clock.now);
        await settle();
        expect(resumes(tasks, taskId)).toHaveLength(1);
      },
    );

    // INF-1137 friction 1: a dropped baseline owner must not mask the
    // other work this crewmate is legitimately waiting on.
    it("ignores a dropped baseline wait beside live work through every idle rung", async () => {
      const { supervisor, crewmate, ops, tasks, taskId, owner, at, sorts } =
        await waitingOn("baseline");
      const live = seedTask(tasks, {
        id: "live-owner",
        title: "Fix the remaining failure",
        status: "running",
      });
      const delivery = tasks.get(taskId)?.delivery;
      seedDelivery(tasks, taskId, {
        ...observeCheckRepair(
          delivery,
          "head-1",
          [
            { name: "linux-checks", state: "failure" },
            { name: "integration", state: "failure" },
          ],
          clock.now,
        ),
      });
      expect(
        declareCheckAction(
          tasks,
          taskId,
          {
            diagnosis: {
              headSha: "head-1",
              check: "integration",
              classification: "baseline-blocked",
              evidence: "The integration check also fails on untouched main",
              dependencyTask: live.id,
            },
          },
          clock.now,
        ).text,
      ).toContain("Diagnosis recorded");
      tasks.close(owner.id, { status: "dropped", reason: "cancelled", actor: "captain" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      await endTurn(crewmate, taskId, "Still waiting on the remaining fix.");
      expect(sorts.at(-1)?.rule).toBe("still-moving");
      const prompts = crewmate.promptCalls.length;
      const wakes = ops.length;
      for (const step of [10, 20, 50, 80, 600]) await at(minutes(step));
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(ops).toHaveLength(wakes);
      expect(resumes(tasks, taskId)).toHaveLength(1);
      expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBeUndefined();
      const before = tasks.get(taskId)?.delivery?.ciRepair;
      expect(
        supervisor.intake.unlinkTasks(owner.key, tasks.get(taskId)?.key ?? "", "blocks"),
      ).toMatch(/^Removed:/);
      const after = tasks.get(taskId)?.delivery?.ciRepair;
      expect(after?.diagnoses.find((d) => d.check === "integration")).toEqual(
        before?.diagnoses.find((d) => d.check === "integration"),
      );
      expect(
        after?.diagnoses.find((d) => d.check === "linux-checks")?.dependencyTask,
      ).toBeUndefined();
      expect(after?.failures).toEqual(before?.failures);
    });

    it.each([false, true])(
      "removes a baseline wait by task keys with graph edge %s without erasing check evidence",
      async (graph) => {
        const { supervisor, tasks, taskId, owner } = await waitingOn("baseline");
        if (graph) tasks.graph.link(owner.id, taskId, "blocks", "firstmate", true);
        const before = tasks.get(taskId)?.delivery;
        const key = tasks.get(taskId)?.key;
        if (!key) throw new Error("missing waiting task");
        tasks.close(owner.id, { status: "dropped", reason: "cancelled", actor: "captain" });
        expect(supervisor.intake.unlinkTasks(owner.key, key, "related")).toMatch(/^No such link/);
        expect(supervisor.intake.unlinkTasks(owner.key, key, "blocks")).toMatch(/^Removed:/);
        const after = tasks.get(taskId)?.delivery;
        expect(tasks.graph.linksTo(taskId).filter((link) => link.type === "blocks")).toEqual([]);
        expect(after?.ci).toBe("red");
        expect(after?.ciRepair?.failures).toEqual(before?.ciRepair?.failures);
        const { dependencyTask: _dependency, ...diagnosis } = before?.ciRepair?.diagnoses[0] ?? {};
        expect(after?.ciRepair?.diagnoses).toEqual([diagnosis]);
        expect(tasks.timeline(taskId).filter((event) => event.kind === "unlinked")).toMatchObject([
          { actor: "firstmate", data: { fromId: owner.id, type: "blocks" } },
        ]);
        expect(supervisor.intake.unlinkTasks(owner.key, key, "blocks")).toMatch(/^No such link/);
      },
    );

    // INF-1826, replaying INF-1641's case: INF-1688 waited on INF-1550, whose
    // work moved to INF-1641. The wait follows the replaced-by link, and the
    // waiter hears one steer at the carrier's close (the captain's q3: at the
    // close only) naming it, its pull request and whose work it took over.
    it("follows a wait to the task carrying the moved work and wakes once at its close", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks } = clockedSetup(crewmate);
      const waiting = seedTask(tasks, {
        id: "inf-1688",
        title: "Finish self-resolving stalls",
        status: "completed",
        worktreeDir: "/work/waiting",
        sessionFile: "/tmp/waiting.jsonl",
      });
      const old = seedTask(tasks, { id: "inf-1550", title: "Runbooks piece 0", status: "running" });
      const carrier = seedTask(tasks, {
        id: "inf-1641",
        title: "Publish Runbooks piece 0",
        status: "running",
      });
      const loader = seedTask(tasks, {
        id: "inf-1479",
        title: "Runbook loader",
        status: "running",
      });
      tasks.graph.link(loader.id, carrier.id, "related", "firstmate");
      tasks.graph.link(old.id, waiting.id, "blocks", "crewmate");
      supervisor.watch.reconcileIdle(clock.now);
      clock.now += minutes(30);
      const before = crewmate.promptCalls.length;
      tasks.dropWithChildren(old.id, {
        reason: "its branch moved to a fresh task",
        actor: "firstmate",
        replacedBy: carrier.id,
      });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      // No premature "dropped, carry on": the wait is on the carrier now.
      expect(crewmate.promptCalls).toHaveLength(before);
      expect(tasks.graph.blockers(waiting.id).map((row) => row.id)).toEqual([carrier.id]);

      clock.now += minutes(60);
      seedDelivery(tasks, carrier.id, { prNumber: 412 });
      tasks.close(carrier.id, { status: "done", reason: "merged", actor: "captain" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls.slice(before)).toHaveLength(1);
      expect(crewmate.promptCalls.at(-1)).toContain(
        `${carrier.key} "Publish Runbooks piece 0" (PR #412), which took over the work of ${old.key} that your task could not merge before, is done.`,
      );
      await supervisor.watch.sweepGates(clock.now + minutes(5));
      await settle();
      expect(crewmate.promptCalls.slice(before)).toHaveLength(1);
    });

    // INF-1826 (the captain's q4): a replaced-by link written after the
    // waiter heard the old task was dropped is one steer naming the new task.
    it("tells a waiter already told of the drop once that the work goes on in another task", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks } = clockedSetup(crewmate);
      const waiting = seedTask(tasks, {
        id: "inf-1688",
        title: "Finish self-resolving stalls",
        status: "completed",
        worktreeDir: "/work/waiting",
        sessionFile: "/tmp/waiting.jsonl",
      });
      const old = seedTask(tasks, { id: "inf-1550", title: "Runbooks piece 0", status: "running" });
      const carrier = seedTask(tasks, {
        id: "inf-1641",
        title: "Publish Runbooks piece 0",
        status: "running",
      });
      tasks.graph.link(old.id, waiting.id, "blocks", "crewmate");
      supervisor.watch.reconcileIdle(clock.now);
      clock.now += minutes(30);
      tasks.close(old.id, { status: "dropped", reason: "cancelled", actor: "firstmate" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls.at(-1)).toContain("was dropped and no longer holds it");
      await endTurn(crewmate, waiting.id, "Carrying on.");
      const told = crewmate.promptCalls.length;

      clock.now += minutes(10);
      tasks.graph.link(old.id, carrier.id, "replaced-by", "firstmate");
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls.slice(told)).toEqual([
        expect.stringContaining(
          `${old.key} "Runbooks piece 0", which you heard was dropped, goes on in ${carrier.key} "Publish Runbooks piece 0", so your task waits on ${carrier.key} now`,
        ),
      ]);
      await endTurn(crewmate, waiting.id, "Waiting on the carrier.");
      await supervisor.watch.sweepGates(clock.now + minutes(5));
      await settle();
      expect(crewmate.promptCalls.slice(told)).toHaveLength(1);

      clock.now += minutes(60);
      tasks.close(carrier.id, { status: "done", reason: "merged", actor: "captain" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls.slice(told)).toHaveLength(2);
      expect(crewmate.promptCalls.at(-1)).toContain(
        `which took over the work of ${old.key} that your task could not merge before, is done.`,
      );
    });

    it("goes out once across a restart: the inbox remembers the resume, not the process", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, db, paths, workspace } = clockedSetup(crewmate);
      const waiting = seedTask(tasks, {
        id: "waiting",
        title: "Ship the gauge",
        status: "completed",
        // A working copy: boot reads it as started work, not an unstarted claim.
        worktreeDir: "/work/waiting",
        sessionFile: "/tmp/waiting.jsonl",
      });
      const owner = seedTask(tasks, {
        id: "dep-owner",
        title: "Fix the shared fixture",
        status: "running",
      });
      tasks.graph.link(owner.id, waiting.id, "blocks", "firstmate");
      supervisor.watch.reconcileIdle(clock.now);
      clock.now += minutes(30);
      tasks.close(owner.id, { status: "done", reason: "merged", actor: "captain" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls.at(-1)).toContain('"Fix the shared fixture", which your task');
      // Queued or in flight: every row the lane holds for the task.
      const resumeRows = (inbox: InboxStore) =>
        [...inbox.allFor(waiting.id), ...inbox.inFlight(waiting.id)].filter(
          (row) => row.facts?.kind === "dependency-closed",
        );
      // The app stops mid-turn; a fresh process reads the same database.
      const again = fakeCrewmate();
      const inbox = new InboxStore(db, { now: hostClock });
      const restarted = reboot(
        { paths, db, workspace },
        vi.fn(async () => again),
        { now: hostClock, inbox },
      );
      restarted.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
      expect(resumeRows(inbox)).toHaveLength(1);
      await restarted.watch.sweepGates(clock.now);
      await settle();
      expect(resumeRows(inbox)).toHaveLength(1);
    });

    it("after the resume the ladder reads the task on its own clock again", async () => {
      const { supervisor, crewmate, tasks, taskId, owner, at } = await waitingOn("blocks");
      tasks.close(owner.id, { status: "done", reason: "merged", actor: "captain" });
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      await endTurn(crewmate, taskId, "Nothing left but the merge.");
      const resumedIdle = tasks.get(taskId)?.idleSince ?? 0;
      clock.now = resumedIdle + minutes(10);
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
      // The sweep never resumes it twice, however long it then sits.
      await at(minutes(600));
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(
        resumes(tasks, taskId).filter((event) => event.text.includes("Fix the shared fixture")),
      ).toHaveLength(1);
    });

    it("is no resume for a continuation its origin's close started, or a wait declared on work already done", async () => {
      const crewmate = fakeCrewmate();
      const harness = wakesThroughInbox(clockedSetup(crewmate));
      const { supervisor, tasks } = harness;
      const origin = seedTask(tasks, { id: "origin", title: "Land the API", status: "running" });
      // A Continue filing: blocked by its origin, started by the ready query.
      const { taskId } = await supervisor.intake.commission({
        title: "Continue: show it in Settings",
        intent: intentOf("Show it"),
        blockedBy: [origin.id],
      });
      expect(tasks.get(taskId)?.status).toBe("open");
      clock.now += minutes(5);
      tasks.close(origin.id, { status: "done", reason: "merged", actor: "captain" });
      clock.now += 1;
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(tasks.get(taskId)?.status).toBe("active");
      await endTurn(crewmate, taskId, "Shown in Settings.");
      const prompts = crewmate.promptCalls.length;
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(resumes(tasks, taskId)).toEqual([]);

      // A baseline wait named work that was already done: the declaration's
      // own answer says to bring the change up to date, and nothing repeats it.
      const failed = [{ name: "linux-checks", state: "failure" as const }];
      seedDelivery(tasks, taskId, {
        headSha: "head-1",
        ci: "red",
        ...observeCheckRepair(undefined, "head-1", failed, clock.now),
      });
      clock.now += 1;
      const declared = declareCheckAction(
        tasks,
        taskId,
        {
          diagnosis: {
            headSha: "head-1",
            check: "linux-checks",
            classification: "baseline-blocked",
            evidence: "The same assertion fails on untouched main",
            dependencyTask: origin.id,
          },
        },
        clock.now,
      );
      expect(declared.text).toContain("is already done: bring your change up to date");
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(resumes(tasks, taskId)).toEqual([]);
    });

    it("a wait on unstarted work beside it climbs as before: that work is the Firstmate's to start", async () => {
      const { crewmate, tasks, taskId, at } = await waitingOn("blocks");
      const planned = seedTask(tasks, {
        id: "dep-planned",
        title: "Rotate the signing key",
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.graph.link(planned.id, taskId, "blocks", "firstmate");
      await at(minutes(10));
      expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    });
  });

  // The primitives review's reproduced gap (report section 5): the host's
  // own waits were invisible to the ladder. Each scenario below failed as
  // written against #343; the gate is now the witness that holds them.
  describe("the gate as a witness (the primitives review, P2)", () => {
    const HEAD = "abc1234def5678";
    const heldWakes = (ops: string[]) =>
      ops.filter((line) => line.includes("is held for the captain"));

    it("a captain gate on the active record is read while it stands, and the sweep heals one nothing holds", async () => {
      const { supervisor, crewmate, ops, taskId, tasks, at } = await stopped();
      tasks.placement.setGate(taskId, { kind: "captain", ref: HEAD, reason: "the CI cap" });
      const prompts = crewmate.promptCalls.length;
      await at(minutes(10));
      expect(crewmate.promptCalls).toHaveLength(prompts);
      await at(minutes(20));
      expect(idleWakes(ops)).toEqual([]);
      expect(heldWakes(ops)).toHaveLength(1);
      expect(heldWakes(ops)[0]).toContain('"held": "captain-gate"');
      // No card and no cap holds it, so the tick's sweep clears it, and the
      // clear restarts the clock: the nudge is ten minutes out, not now.
      const healedAt = clock.now;
      await supervisor.watch.sweepGates(healedAt);
      expect(tasks.get(taskId)?.gate).toBeNull();
      expect(tasks.get(taskId)?.idleSince).toBe(healedAt);
      expect(crewmate.promptCalls).toHaveLength(prompts);
    });

    it("a timed wait on the active record holds the ladder, and the sweep ends it with one steer", async () => {
      const { supervisor, crewmate, ops, taskId, tasks, idleSince, at } = await stopped();
      const until = idleSince + minutes(30);
      tasks.placement.setGate(taskId, { kind: "at-time", until, reason: "checks settle" });
      expect(tasks.graph.flagsOf(tasks.get(taskId) as TaskRecord).held).toBe(true);
      const prompts = crewmate.promptCalls.length;
      await at(minutes(29));
      expect(crewmate.promptCalls).toHaveLength(prompts);
      await supervisor.watch.sweepGates(clock.now);
      expect(tasks.get(taskId)?.gate).toMatchObject({ kind: "at-time", until });

      clock.now = until + minutes(1);
      await supervisor.watch.sweepGates(clock.now);
      await settle();
      const steeredAt = clock.now;
      // One steer on the task's own lane, the supervisor's, never a dispatch.
      expect(crewmate.promptCalls).toHaveLength(prompts + 1);
      // The wake's whole words are the crewmate words table's.
      expect(crewmate.promptCalls.at(-1)).toContain("was waiting for has come (checks settle).");
      expect(tasks.get(taskId)).toMatchObject({ status: "active", gate: null });
      const steered = tasks
        .timeline(taskId)
        .filter((event) => event.kind === "steered")
        .at(-1);
      expect(steered).toMatchObject({ actor: "supervisor" });
      expect(tasks.timeline(taskId).filter((event) => event.kind === "dispatched")).toHaveLength(1);
      // Its turn is the task's own: a fresh episode, not a ladder turn.
      await endTurn(crewmate, taskId, "Checks are green.");
      expect(tasks.get(taskId)?.idleSince).toBeGreaterThanOrEqual(steeredAt);
      expect(idleWakes(ops)).toEqual([]);
    });

    // INF-1244: INF-1191's crewmate ended its turn with a test run waiting
    // silently on a lock, and nothing read it until the job's bound.
    describe("a check-back on a running job (INF-1244)", () => {
      const TEST_RUN = "pnpm test:unit && pnpm test:phone";
      const checkBackAsks = (prompts: string[]) =>
        prompts.filter((prompt) => prompt.includes("Report again with check_back"));

      async function withJob() {
        let started = clock.now;
        const harness = await stopped({
          hasRunningJobs: () => true,
          oldestRunningJob: () => ({ jobId: "tests-1", command: TEST_RUN, startedAt: started }),
        });
        started = harness.idleSince;
        return harness;
      }

      it("a turn that ends with a job running and names no time is asked once for one", async () => {
        const { supervisor, crewmate, taskId } = await withJob();
        // `stopped` ended the first turn with the job running: one ask went out.
        expect(checkBackAsks(crewmate.promptCalls)).toHaveLength(1);
        expect(checkBackAsks(crewmate.promptCalls)[0]).toContain(`"${TEST_RUN}"`);
        await supervisor.steer.steerCrewmate(taskId, "rebase onto main");
        await settle();
        await endTurn(crewmate, taskId, "Rebased; the tests still run.");
        expect(checkBackAsks(crewmate.promptCalls)).toHaveLength(1);
      });

      it("holds the task until its time, then wakes the crewmate naming the job and its age", async () => {
        const { supervisor, crewmate, specs, tasks, taskId, idleSince, at } = await withJob();
        await supervisor.steer.steerCrewmate(taskId, "rebase onto main");
        await settle();
        expect(() =>
          specs[0]?.onReport?.("Waiting on the tests.", undefined, {
            wait: { reason: "the merge" },
            checkBack: { minutes: 20, waitingFor: "the tests" },
          }),
        ).toThrow("check_back is for work of your own still running");
        const receipt = specs[0]?.onReport?.(
          "Rebased; the tests run in the background.",
          undefined,
          {
            checkBack: { minutes: 20, waitingFor: "the unit tests, then the native gate" },
          },
        );
        expect(receipt).toContain("wakes you in 20m");
        await endTurn(crewmate, taskId);
        const reportedAt = clock.now;
        expect(tasks.get(taskId)?.gate).toEqual({
          kind: "at-time",
          until: reportedAt + minutes(20),
          reason: "the unit tests, then the native gate",
        });
        // The crew line reads the durations it would otherwise guess.
        clock.now = reportedAt + minutes(5);
        expect(supervisor.facts.crewStatus(taskId)[0]).toMatchObject({
          job: `running ${formatDurationShort(clock.now - idleSince)}: ${TEST_RUN}`,
          reported: "5m ago",
          checkBack: "in 15m: the unit tests, then the native gate",
        });
        const prompts = crewmate.promptCalls.length;
        await at(reportedAt - idleSince + minutes(19));
        await supervisor.watch.sweepGates(clock.now);
        expect(crewmate.promptCalls).toHaveLength(prompts);

        clock.now = reportedAt + minutes(20);
        await supervisor.watch.sweepGates(clock.now);
        await settle();
        expect(crewmate.promptCalls).toHaveLength(prompts + 1);
        const wake = crewmate.promptCalls.at(-1);
        expect(wake).toContain("(the unit tests, then the native gate)");
        expect(wake).toContain(
          `still running after ${formatDurationShort(clock.now - idleSince)}: "${TEST_RUN}"`,
        );
        expect(tasks.get(taskId)?.gate).toBeNull();
      });

      it("a check-back past the job's bound leaves the bound as the backstop", async () => {
        const { supervisor, crewmate, specs, ops, taskId, idleSince, at } = await withJob();
        await supervisor.steer.steerCrewmate(taskId, "rebase onto main");
        await settle();
        specs[0]?.onReport?.("The tests run in the background.", undefined, {
          checkBack: { minutes: 300, waitingFor: "the tests" },
        });
        await endTurn(crewmate, taskId);
        const sinceIdle = clock.now - idleSince;
        await at(JOB_BOUND_MS - minutes(1));
        expect(ops.filter((line) => line.includes("background job running"))).toHaveLength(0);
        await at(Math.max(JOB_BOUND_MS, sinceIdle));
        expect(ops.filter((line) => line.includes("background job running"))).toHaveLength(1);
      });
    });

    it("INF-1879: putting a decision away preserves its gate and idle witness", async () => {
      const { supervisor, crewmate, ops, specs, taskId, tasks, cards, idleSince, at } =
        await stopped();
      specs[0]?.onCard?.({
        title: "Pick a course",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [
          { id: "hold", label: "Hold course" },
          { id: "change", label: "Plot new course", default: true },
        ],
      });
      await settle();
      const card = cards().find((entry) => entry.title === "Pick a course") as Card;
      expect(tasks.get(taskId)?.gate).toEqual({ kind: "captain", ref: card.id });
      const prompts = crewmate.promptCalls.length;
      await at(minutes(30));
      expect(crewmate.promptCalls).toHaveLength(prompts);

      const opsBefore = ops.length;
      clock.now = idleSince + minutes(30);
      supervisor.close(card.id);
      await settle();
      expect(tasks.timeline(taskId).some((event) => event.kind === "card_resolved")).toBe(false);
      expect(tasks.get(taskId)?.gate).toEqual({ kind: "captain", ref: card.id });
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(ops.slice(opsBefore)).toEqual([]);
      expect(cards().find((entry) => entry.id === card.id)?.minimized).toBe(true);
      await at(minutes(40));
      expect(crewmate.promptCalls).toHaveLength(prompts);
    });

    /**
     * A crewmate mid-turn on a fresh task, its outcome note up and not yet
     * reported, under the id it gives emit_card when it gives one.
     */
    async function withOutcomeNote(id?: string) {
      const crewmate = fakeCrewmate();
      const harness = wakesThroughInbox(clockedSetup(crewmate));
      const { taskId } = await harness.supervisor.intake.commission({
        title: "Release",
        intent: intentOf("cut the release"),
      });
      await settle();
      harness.specs[0]?.onCard?.({
        ...(id ? { id } : {}),
        title: "Version 1.2 is out",
        body: "<p>Version 1.2 is published.</p><p>The release page lists it.</p>",
        actions: [],
      });
      await settle();
      const note = harness.cards().find((entry) => entry.taskId === taskId) as Card;
      return { ...harness, crewmate, taskId, note };
    }

    /** Tick the ladder at each idle minute past the task's clock. */
    async function idleFor(
      harness: { supervisor: CrewSupervisor; tasks: TaskService },
      taskId: string,
      at: number[],
    ) {
      const since = harness.tasks.get(taskId)?.idleSince ?? clock.now;
      for (const ms of at) {
        clock.now = since + ms;
        harness.supervisor.watch.reconcileIdle(clock.now);
        await settle();
      }
    }

    it("a wait on the captain the report declares holds the turn until his close; a finished report wakes the Firstmate (FI3-435)", async () => {
      const { supervisor, crewmate, ops, sorts, specs, tasks, taskId, note } =
        await withOutcomeNote();
      expect(
        specs[0]?.onReport?.("Version 1.2 is released and the note says so.", undefined, {
          wait: { reason: "read the release note", cardId: note.id },
        }),
      ).toContain("waits on the captain");
      await endTurn(crewmate, taskId);
      // A note alone never holds the turn; the declared wait does, through
      // the task's captain gate, naming the note.
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });
      expect(tasks.get(taskId)?.gate).toEqual({
        kind: "captain",
        ref: note.id,
        reason: "read the release note",
      });
      const prompts = crewmate.promptCalls.length;
      const opsBefore = ops.length;
      await idleFor({ supervisor, tasks }, taskId, [minutes(10), minutes(20), minutes(90)]);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(ops.slice(opsBefore)).toEqual([]);

      // Reading the note itself reaches its author and releases
      // the declared wait; no injected steer repairs the production path.
      supervisor.pressNote(note.id);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts + 1);
      expect(crewmate.promptCalls.at(-1)).toContain(
        renderWake({
          facts: { kind: "card-closed", card: { id: note.id, title: note.title }, read: true },
        }),
      );
      expect(tasks.get(taskId)?.status).not.toBe("done");
      expect(tasks.get(taskId)?.gate).toBeNull();
      expect(tasks.get(taskId)?.delivery?.captainWait).toBeUndefined();
      specs[0]?.onReport?.("The captain read the release note and nothing is left.", undefined, {
        finished: true,
      });
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "finished" });
      expect(ops.at(-1)).toContain(FINISHED_REPORT_WORDS);
      expect(tasks.get(taskId)?.delivery?.finishedAt).toBe(clock.now);
      expect(tasks.timeline(taskId).at(-1)).toMatchObject({
        kind: "report",
        data: expect.objectContaining({ finished: true }),
      });
    });

    // INF-731, from the captain's words "Send the 'crewmate finished' wake
    // once per task, not once per reply" (INF-721 friction 5): INF-694's
    // crewmate declared its answer finished after each of eleven replies
    // under its note, and each report woke the first mate for a close the
    // note still held.
    it("a finished report with its own card still up wakes nobody, however often the captain replies; his close wakes the first mate once and restarts no turn (INF-731, INF-2718)", async () => {
      const { supervisor, crewmate, ops, sorts, specs, tasks, taskId, note } =
        await withOutcomeNote();
      const finishedWakes = () => ops.filter((line) => line.includes(FINISHED_REPORT_WORDS));
      const receipt = specs[0]?.onReport?.(
        "Version 1.2 is released and the note says so.",
        undefined,
        { finished: true },
      );
      expect(receipt).toContain("finished does not wake the first mate while it is up");
      expect(receipt).toContain(ORDINARY_NOTE_READ_ACK);
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });

      for (const [question, answer] of [
        ["which page lists it?", "The release page lists it under 1.2."],
        ["add the date", "I added October 20 to the note."],
        ["make the version bold", "The version is bold now."],
      ]) {
        supervisor.cardActions.replyToCard(note.id, question as string);
        await settle();
        specs[0]?.onReply?.({
          cardId: note.id,
          text: answer as string,
          answersMessage: askedOn(supervisor, note.id),
        });
        specs[0]?.onReport?.(`${answer} The note is the final answer.`, undefined, {
          finished: true,
        });
        await endTurn(crewmate, taskId);
        expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });
      }
      expect(finishedWakes()).toEqual([]);

      // Reading this ordinary note is the next move: while it stays up,
      // nothing nudges the crewmate or wakes the first mate.
      const prompts = crewmate.promptCalls.length;
      const opsBefore = ops.length;
      await idleFor({ supervisor, tasks }, taskId, [minutes(10), minutes(20), minutes(90)]);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(ops.slice(opsBefore)).toEqual([]);

      // INF-2718, from the captain's pick "skip restarting a finished
      // task": reading the note of a crewmate that declared its work
      // finished starts no turn for it - after an update, that turn ran in
      // a fresh conversation that raised the closed note again (INF-2662).
      // The first mate is woken once, now, for the close only it makes.
      supervisor.pressNote(note.id);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(tasks.get(taskId)?.status).not.toBe("done");
      const closeAsks = ops
        .slice(opsBefore)
        .filter((line) => line.includes("declared its work finished"));
      expect(closeAsks).toHaveLength(1);
      expect(closeAsks[0]).toContain("Close the task if the record bears that out");
    });

    // INF-11, from the captain's words "make this missed escalation
    // structurally impossible" (2026-10-18): a wait on the captain with no
    // card on his screen is a question he cannot see, so the first mate owes
    // it - the report wakes it, and the ladder reminds it, never the crewmate.
    it("a declared wait with no card up is the first mate's to put to the captain, and a steer releases it (INF-11)", async () => {
      const { supervisor, crewmate, ops, sorts, specs, tasks, taskId, note, cards } =
        await withOutcomeNote();
      // A note still owed its author's turn stays open when put away.
      // Once complete, reading it itself gives its author the next turn.
      await endTurn(crewmate, taskId);
      const promptsBeforeRead = crewmate.promptCalls.length;
      supervisor.pressNote(note.id);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(promptsBeforeRead + 1);
      const words = "The release is out; the captain may still want the old build.";
      const receipt = specs[0]?.onReport?.(words, undefined, {
        wait: { reason: "decide whether to keep the old build" },
      });
      const opsBefore = ops.length;
      await endTurn(crewmate, taskId);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "captain-gate" });
      expect(receipt).toContain("No card of yours is up, so the first mate is woken to ask them");
      expect(tasks.get(taskId)?.gate).toEqual({
        kind: "captain",
        reason: "decide whether to keep the old build",
      });
      expect(ops.slice(opsBefore)).toEqual([
        `[fm-op] crewmate 1 reported on task ${taskId} "Release": ${words} It waits on the captain to decide whether to keep the old build, and no card of its is on their screen.`,
      ]);
      const prompts = crewmate.promptCalls.length;
      await idleFor({ supervisor, tasks }, taskId, [minutes(10), minutes(20)]);
      // Nothing nudges the crewmate, which already did its part.
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(ops.at(-1)).toContain(
        `[fm-op] task ${taskId} "Release" is held for the captain (its crewmate waits on them to decide whether to keep the old build) and has had no card up for 20m`,
      );
      // Two wakes let go, the app asks him itself, in the crewmate's words.
      await idleFor({ supervisor, tasks }, taskId, [minutes(50), minutes(80)]);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      const stall = cards().find((entry) => entry.id === `card-stall-${taskId}`);
      expect(stall?.body).toContain(
        "<p>It waits on you to decide whether to keep the old build, and no card has asked you. Your first mate was told twice, and nothing has moved since.</p>",
      );

      await supervisor.steer.steerCrewmate(taskId, "The captain keeps the old build.");
      await settle();
      expect(tasks.get(taskId)?.gate).toBeNull();
      expect(tasks.get(taskId)?.delivery?.captainWait).toBeUndefined();
    });

    it("refuses a report that declares both a wait and finished, or names a card that is not its own (FI3-435)", async () => {
      const { specs, tasks, taskId, note } = await withOutcomeNote();
      expect(() =>
        specs[0]?.onReport?.("The release is out and the note is up.", undefined, {
          wait: { reason: "read the note" },
          finished: true,
        }),
      ).toThrow(/not both/);
      expect(() =>
        specs[0]?.onReport?.("The release is out and the note is up.", undefined, {
          wait: { reason: "read the note", cardId: "card-fm-elsewhere" },
        }),
      ).toThrow(/not an open card of yours/);
      expect(() =>
        specs[0]?.onReport?.("The release is out and the note is up.", undefined, {
          wait: { reason: "  ", cardId: note.id },
        }),
      ).toThrow(/needs a reason/);
      expect(tasks.get(taskId)?.delivery?.captainWait).toBeUndefined();
    });

    // INF-2835: four reports in a day were refused for naming the crewmate's
    // own card by the id it gave emit_card ("inf-2755-completion"), or by a
    // guess at the full one, and the refusal never said which id it wanted.
    it("takes a wait naming its card by the id it gave emit_card, and refuses another name with its open card's full id (INF-2835)", async () => {
      const { crewmate, specs, tasks, taskId, note } = await withOutcomeNote("release-note");
      const report = (cardId: string) =>
        specs[0]?.onReport?.("Version 1.2 is released and the note says so.", undefined, {
          wait: { reason: "read the release note", cardId },
        });
      expect(() => report(`${taskId}-release-note`)).toThrow(
        new RegExp(`not an open card of yours.*"${note.id}"`),
      );
      expect(report("release-note")).toContain("waits on the captain");
      await endTurn(crewmate, taskId);
      expect(tasks.get(taskId)?.gate).toEqual({
        kind: "captain",
        ref: note.id,
        reason: "read the release note",
      });
    });

    // INF-3060: five reports in a day named a card of the crewmate's own that
    // the app had already closed, and each was refused with "omit card_id".
    it("takes a wait naming its own closed card, dropping the card, and says so (INF-3060)", async () => {
      const { supervisor, crewmate, specs, tasks, taskId, note } =
        await withOutcomeNote("release-note");
      supervisor.closeCard(note.id, { kind: "crewmate", taskId }, "superseded by the release page");
      await settle();
      const receipt = specs[0]?.onReport?.(
        "Version 1.2 is released and the release page says so.",
        undefined,
        { wait: { reason: "read the release page", cardId: "release-note" } },
      );
      expect(receipt).toContain("waits on the captain");
      expect(receipt).toContain(
        `Your card "release-note" is already closed, so the wait names no card.`,
      );
      await endTurn(crewmate, taskId);
      expect(tasks.get(taskId)?.gate).toEqual({ kind: "captain", reason: "read the release page" });
    });

    // INF-3060, the captain's "we should not take any guesses here": with a
    // card of its own still open, the wait may have meant that card, so a
    // closed card's name is refused with the open card's full id.
    it("refuses a wait naming its own closed card while another card of its is open, naming the open one (INF-3060)", async () => {
      const { supervisor, specs, tasks, taskId, note } = await withOutcomeNote("release-note");
      const page = syncCardId(
        specs[0]?.onCard?.({
          id: "release-page",
          title: "The release page is live",
          body: "<p>The release page lists version 1.2.</p>",
          actions: [],
        }),
      );
      await settle();
      supervisor.closeCard(note.id, { kind: "crewmate", taskId }, "superseded by the release page");
      await settle();
      expect(() =>
        specs[0]?.onReport?.("Version 1.2 is released and the release page says so.", undefined, {
          wait: { reason: "read the release page", cardId: "release-note" },
        }),
      ).toThrow(`Your open card is "${page}"`);
      expect(tasks.get(taskId)?.delivery?.captainWait).toBeUndefined();
    });
  });

  // INF-976: INF-926 had already built INF-797's answer and merged when
  // INF-797 asked again, and the reminders said only that nothing was
  // started since, so the same build was filed again as INF-971.
  describe("a request the first mate is reminded of reads the work built on its task (INF-976)", () => {
    const ASK = "Build the plan the captain approved.";
    const askedWakes = (ops: string[]) => ops.filter((line) => line.includes("ago to act:"));

    /** The stopped crewmate asks the first mate to act, on the host's clock. */
    async function asks(harness: Awaited<ReturnType<typeof stopped>>) {
      const { supervisor, crewmate, specs, tasks, taskId } = harness;
      await supervisor.steer.steerCrewmate(taskId, "the captain approved it");
      await settle();
      specs.at(-1)?.onReport?.("The captain approved the plan.", undefined, {
        needsFirstmate: ASK,
      });
      await endTurn(crewmate, taskId);
      return tasks.get(taskId)?.idleSince ?? clock.now;
    }

    /** A builder the first mate starts on the task, merged and closed. */
    function mergedBuilder(
      harness: Awaited<ReturnType<typeof stopped>>,
      id: string,
      basis: string,
    ) {
      const { tasks } = harness;
      tasks.create({
        id,
        title: "Build the plan",
        prompt: "p",
        repoId: null,
        shape: { kind: "implement", basis },
      });
      seedDelivery(
        tasks,
        id,
        { prNumber: 364, changeLabel: "#364" },
        { kind: "pr_opened", text: "PR #364" },
      );
      tasks.close(id, { status: "done", reason: "merged", actor: "captain", text: "merged" });
      return tasks.get(id)?.key ?? id;
    }

    it("names merged work built on it in the report and in each reminder, and an older build answers no newer request", async () => {
      const harness = await stopped();
      const { supervisor, ops, tasks, taskId } = harness;
      const key = tasks.get(taskId)?.key ?? taskId;
      const builder = mergedBuilder(harness, "builder", key);
      clock.now += 1000;
      const askedAt = await asks(harness);
      const built = ` Work built on this task, open or closed: ${builder} "Build the plan" (done: merged, #364).`;
      expect(ops.find((line) => line.includes(`It asks the first mate to act: ${ASK}`))).toContain(
        built,
      );

      clock.now = askedAt + minutes(31);
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      const [reminder] = askedWakes(ops);
      expect(reminder).toContain(`no task built on it or under it was created or started.${built}`);
    });

    it("keeps a build started after the request as the first mate's act once it merged and closed, by id or key", async () => {
      for (const by of ["id", "key"] as const) {
        const harness = await stopped();
        const { supervisor, ops, tasks, taskId } = harness;
        const askedAt = await asks(harness);
        clock.now += 1000;
        mergedBuilder(
          harness,
          `builder-${by}`,
          by === "id" ? taskId : (tasks.get(taskId)?.key ?? ""),
        );
        for (const idle of [31, 62]) {
          clock.now = askedAt + minutes(idle);
          supervisor.watch.reconcileIdle(clock.now);
          await settle();
        }
        expect(askedWakes(ops), by).toEqual([]);
      }
    });
  });

  // INF-1428, built as INF-1670's piece 2: work declared finished with no
  // card of its own up leaves its crewmate nothing to do, so the ladder
  // never nudges it; the first mate's close is raised as its request.
  it("never nudges a crewmate that reported finished with no card up, and reminds the first mate to close it (INF-1428)", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, specs, ops, sorts, ledgerFacts, tasks, taskId } = harness;
    await supervisor.steer.steerCrewmate(taskId, "the captain closed your card");
    await settle();
    expect(
      specs.at(-1)?.onReport?.("PR #612 merged and the captain closed the card.", undefined, {
        finished: true,
      }),
    ).toContain("The first mate hears it when this turn ends and closes your task.");
    await endTurn(crewmate, taskId);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "finished" });
    const finishedAt = tasks.get(taskId)?.delivery?.finishedAt ?? clock.now;
    const promptsBefore = crewmate.promptCalls.length;
    const reminders = () => ops.filter((line) => line.includes("ago with no card of its own up"));

    for (const idle of [10, 20, 29]) {
      clock.now = finishedAt + minutes(idle);
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
    }
    expect(crewmate.promptCalls).toHaveLength(promptsBefore);
    expect(reminders()).toEqual([]);

    clock.now = finishedAt + minutes(30);
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    expect(crewmate.promptCalls).toHaveLength(promptsBefore);
    expect(ledgerFacts.at(-1)).toMatchObject({ kind: "idle-asked", finished: true, wakes: 2 });
    expect(reminders()).toEqual([
      expect.stringContaining(
        `on task ${taskId} "Job" declared its work finished 30m ago with no card of its own up, so nothing is left for it and it is not nudged.`,
      ),
    ]);

    // The first mate acts without closing it: nothing more fires, for either.
    const next = seedTask(tasks, {
      id: "next",
      title: "Next",
      status: "queued",
      startPolicy: "on-request",
    });
    supervisor.intake.linkTasks(next.id, taskId, "related");
    for (const idle of [61, 120, 240]) {
      clock.now = finishedAt + minutes(idle);
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
    }
    expect(crewmate.promptCalls).toHaveLength(promptsBefore);
    expect(reminders()).toHaveLength(1);
    expect(supervisor.cards.snapshot().filter((card) => card.id.startsWith("card-stall-"))).toEqual(
      [],
    );
  });

  it("the FI3-83 strand: a provider outage keeps the captain's reply and delivers it on recovery", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, specs, taskId, inbox, ops, cards } = harness;
    specs[0]?.onCard?.({
      title: "Pick a course",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    await settle();
    const card = cards().find((entry) => entry.title === "Pick a course") as Card;
    supervisor.cardActions.replyToCard(card.id, "take the northern route");
    await settle();
    const reply = crewmate.promptCalls.at(-1) ?? "";
    expect(reply).toContain("take the northern route");

    // The provider fails the reply's turn nine times, far past the three
    // attempts that used to set it aside for good.
    const start = clock.now;
    await failTurn(crewmate, taskId);
    for (let failure = 2; failure <= 9; failure += 1) {
      await sweepWhenDue(harness, taskId);
      expect(crewmate.promptCalls.at(-1)).toBe(reply);
      await failTurn(crewmate, taskId);
    }
    const [row] = inbox.allFor(taskId);
    expect(row).toMatchObject({ escalatedAt: null, attempts: 0, failures: 9 });
    expect(ops.some((line) => line.includes("could not be delivered"))).toBe(false);
    // One wake when it began, one when it was still down at 15 minutes.
    expect(failureWakes(ops)).toHaveLength(1);
    const stillDown = ops.filter((line) => line.includes("is still failing at the provider"));
    expect(stillDown).toHaveLength(1);
    expect(clock.now - start).toBeGreaterThan(STILL_DOWN_MS);
    // Meanwhile the reply is deliverable, so nothing climbs the ladder.
    expect(idleWakes(ops)).toEqual([]);

    // The provider answers: the reply goes through on the first attempt.
    await sweepWhenDue(harness, taskId);
    expect(crewmate.promptCalls.at(-1)).toBe(reply);
    await endTurn(crewmate, taskId);
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(ops.at(-1)).toContain("is answering again after 9 failed tries");
  });

  it("a brief the provider keeps failing is never set aside, and the outage is watched", async () => {
    const crewmate = fakeCrewmate();
    const harness = wakesThroughInbox(clockedSetup(crewmate));
    const { supervisor, ops, inbox, tasks } = harness;
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await settle();
    const brief = crewmate.promptCalls[0];
    await failTurn(crewmate, taskId);
    for (let failure = 2; failure <= 6; failure += 1) {
      await sweepWhenDue(harness, taskId);
      await failTurn(crewmate, taskId);
    }
    // Six tries, all of them the brief, and it is still on its lane.
    expect(crewmate.promptCalls).toEqual(Array.from({ length: 6 }, () => brief));
    expect(inbox.allFor(taskId)).toMatchObject([{ escalatedAt: null, failures: 6 }]);
    expect(tasks.get(taskId)?.outcome).toBeNull();
    expect(failureWakes(ops)).toHaveLength(1);
    expect(ops.filter((line) => line.includes("is still failing at the provider"))).toHaveLength(1);
  });

  it("the Claude crewmate's failed turns take the same honest retry", async () => {
    const claude: FakeCrewmate = {
      ...fakeCrewmate(),
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client" },
    };
    const harness = await stopped({}, claude);
    const { supervisor, taskId, inbox } = harness;
    await supervisor.steer.steerCrewmate(taskId, "use the other library");
    await settle();
    for (let failure = 1; failure <= 4; failure += 1) {
      await failTurn(claude, taskId, "API Error: 529 Overloaded");
      await sweepWhenDue(harness, taskId);
    }
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(claude.promptCalls.at(-1)).toBe("use the other library");
    await endTurn(claude, taskId);
    expect(inbox.allFor(taskId)).toEqual([]);
  });

  it("a failed turn with nothing to retry is still watched, skipping the nudge", async () => {
    const { crewmate, ops, sorts, at, cards } = await stopped();
    // A turn the provider began on its own, and failed: no guidance rode it.
    crewmate.emit({ type: "continuation_started" });
    crewmate.emit({ type: "continuation_ended", error: "upstream 500" });
    await settle();
    expect(failureWakes(ops)).toHaveLength(0);
    expect(ops.at(-1)).toContain("failed: upstream 500");
    // That turn started a fresh clock, one that opens past the nudge.
    const prompts = crewmate.promptCalls.length;
    await at(minutes(11));
    expect(crewmate.promptCalls).toHaveLength(prompts);
    await at(minutes(21));
    expect(idleWakes(ops)).toHaveLength(1);
    expect(idleWakes(ops)[0]).not.toContain("nudge");
    expect(idleWakes(ops)[0]).toContain("Its last turn hit a problem: upstream 500");
    expect(sorts.at(-1)?.rule).toBe("idle-wake");
    // Nothing further claims a nudge that never went out.
    await at(minutes(51));
    expect(idleWakes(ops)[1]).not.toContain("nudge");
    await at(minutes(81));
    const card = cards().find((entry) => entry.id.startsWith("card-stall-"));
    expect(card?.body).toContain("Your first mate was told twice");
    expect(card?.body).not.toContain("nudged");
  });

  it("a job past its bound earns one wake naming it, and stops counting as moving", async () => {
    let started = clock.now;
    const { crewmate, ops, sorts, taskId, at, idleSince } = await stopped({
      hasRunningJobs: () => true,
      oldestRunningJob: () => ({ jobId: "poll-1", command: "gh run watch", startedAt: started }),
    });
    // The job began as the turn that started it went idle.
    started = idleSince;
    await at(JOB_BOUND_MS - 1);
    expect(ops.filter((line) => line.includes("background job running"))).toHaveLength(0);
    await at(JOB_BOUND_MS);
    const bound = ops.filter((line) => line.includes("background job running"));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toContain('"gh run watch"');
    // The job no longer witnesses: in the same tick the ladder climbs from
    // its first rung.
    expect(sorts.slice(-2)).toEqual([
      { taskId, verdict: "captain", rule: "job-bound" },
      { taskId, verdict: "routine", rule: "idle-nudge" },
    ]);
    expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    await endTurn(crewmate, taskId);
    await at(JOB_BOUND_MS + minutes(5));
    expect(ops.filter((line) => line.includes("background job running"))).toHaveLength(1);
    await at(JOB_BOUND_MS + minutes(10));
    expect(idleWakes(ops)).toHaveLength(1);
  });

  it("a Claude background command the client reports holds the nudge for the job bound, then stops counting", async () => {
    const crewmate = fakeCrewmate();
    const { crewmate: client, ops, sorts, at, idleSince } = await stopped({}, crewmate);
    // The client began the command as the turn went idle.
    clock.now = idleSince;
    client.emit({ type: "background_work_changed", count: 1 });
    await at(STALL_WAKE_MS + minutes(5));
    expect(client.promptCalls).not.toContain(IDLE_NUDGE_TEXT);
    expect(sorts.filter((sort) => sort.rule.startsWith("idle"))).toEqual([]);
    await at(JOB_BOUND_MS);
    const bound = ops.filter((line) => line.includes("background job running"));
    expect(bound).toHaveLength(1);
    expect(client.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
  });

  it("a Claude background command that ended leaves the idle clock to nudge at ten minutes", async () => {
    const crewmate = fakeCrewmate();
    const { crewmate: client, at } = await stopped({}, crewmate);
    client.emit({ type: "background_work_changed", count: 1 });
    client.emit({ type: "background_work_changed", count: 0 });
    await at(STALL_WAKE_MS);
    expect(client.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
  });

  it("climbs on the host's one ticker: the ladder's reconcile, then the sweeps, each tick, until disposed", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, idleSince } = harness;
    const ticker = new Ticker({ now: hostClock, timers: { repeat: () => 0, cancel: () => {} } });
    const reconcile = vi.spyOn(supervisor.watch, "reconcileIdle");
    const gates = vi.spyOn(supervisor.watch, "sweepGates");
    const lanes = vi.spyOn(supervisor.watch, "sweepInbox");
    const riders: number[] = [];
    supervisor.setFirstmateHooks({
      notifyOp: () => {},
      retryConverse: vi.fn(),
      checkQuiet: (now) => riders.push(now),
    });
    supervisor.watch.startWatchdog(ticker);
    supervisor.watch.startWatchdog(ticker);

    clock.now = idleSince + minutes(10);
    ticker.tick();
    await settle();
    expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    // One reading of the clock, and the order phase 1 relies on: the
    // reconcile runs before the gate sweep, which runs before the lanes.
    expect(reconcile.mock.calls).toEqual([[clock.now]]);
    expect(gates.mock.calls).toEqual([[clock.now]]);
    expect(lanes.mock.calls).toEqual([[clock.now]]);
    expect(riders).toEqual([clock.now]);
    const [reconciled] = reconcile.mock.invocationCallOrder;
    const [swept] = gates.mock.invocationCallOrder;
    const [drained] = lanes.mock.invocationCallOrder;
    expect(reconciled).toBeLessThan(swept ?? 0);
    expect(swept).toBeLessThan(drained ?? 0);

    // Disposed, the supervisor leaves the ticker.
    supervisor.disposeAll();
    ticker.tick();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("a closed task is never read", async () => {
    const closed = await stopped();
    await closed.supervisor.settling.settle.settleTask(closed.taskId, "discard", true);
    await closed.at(minutes(200));
    expect(idleWakes(closed.ops)).toEqual([]);
    expect(closed.sorts.filter((sort) => sort.rule.startsWith("idle"))).toEqual([]);
  });

  it("after a restart it reads an idle record that never reported, and nudges it on its saved clock", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops, sorts } = clockedSetup(crewmate);
    const quiet = seedTask(tasks, {
      id: "never-reported",
      title: "Never reported",
      status: "completed",
      sessionFile: "/tmp/never.jsonl",
    });
    const reported = seedTask(tasks, {
      id: "reported",
      title: "Reported",
      status: "completed",
      sessionFile: "/tmp/reported.jsonl",
      outcome: "Waiting for the deploy to finish.",
    });
    expect(quiet.outcome).toBeNull();
    const boot = clock.now;
    // The first reconcile after boot starts the clock of records older than it.
    supervisor.watch.reconcileIdle(boot);
    expect(tasks.get(quiet.id)?.idleSince).toBe(boot);
    clock.now = boot + STALL_WAKE_MS;
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    // Both are nudged by resuming their conversations - outcome or none.
    expect(crewmate.promptCalls).toEqual([IDLE_NUDGE_TEXT, IDLE_NUDGE_TEXT]);
    expect(sorts.map((sort) => [sort.taskId, sort.rule])).toEqual([
      [quiet.id, "idle-nudge"],
      [reported.id, "idle-nudge"],
    ]);
    expect(ops).toEqual([]);
  });
});
