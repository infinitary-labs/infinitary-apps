/**
 * What the first mate is reminded of once an idle crewmate's request or
 * finished report sits unanswered (`IdleLadder`; docs/report-sort.md): the
 * work built on the task, the quiet reminders and the provider's still-down wake.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
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
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { seedTask } from "../tasks/seedTask";
import { JOB_BOUND_MS, STALL_WAKE_MS, STILL_DOWN_MS } from "./idleLadder";
import { IDLE_NUDGE_TEXT } from "./idleWakes";
import { Ticker } from "./ticker";

fakeCrewTimersEachTest();

describe("the idle ladder (idle crew recovery, docs/report-sort.md)", () => {
  const { clock, hostClock, clockedSetup, stopped, sweepWhenDue } = idleLadderHarness();
  const failureWakes = (ops: string[]) =>
    ops.filter((line) => line.includes("failed at the provider"));
  // INF-976: INF-926 had already built INF-797's answer and merged when
  // INF-797 asked again, and the reminders said only that nothing was
  // started since, so the same build was filed again as INF-971.
  describe("a request the first mate is reminded of reads the work built on its task (INF-976)", () => {
    const ASK = "Build the plan the captain approved.";
    const askedWakes = (ops: string[]) => ops.filter((line) => line.includes("ago to act:"));

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

    // The first mate acts without closing it: the reminders end, and the
    // crewmate is never nudged.
    const next = seedTask(tasks, {
      id: "next",
      title: "Next",
      status: "queued",
      startPolicy: "on-request",
    });
    supervisor.intake.linkTasks(next.id, taskId, "related");
    const stillOpen = () => ops.filter((line) => line.includes("is still open, with nothing up"));
    clock.now = finishedAt + minutes(59);
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    expect(stillOpen()).toEqual([]);
    // INF-4072, finding 4 (the captain started "one wake for a task that
    // reported finished and is still open an hour later"): an hour after
    // the finish, the first mate hears once that the task is still open.
    for (const idle of [61, 120, 240]) {
      clock.now = finishedAt + minutes(idle);
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
    }
    expect(stillOpen()).toEqual([
      expect.stringContaining(
        `task ${tasks.get(taskId)?.key || taskId} "Job" declared its work finished 1h 1m ago and is still open`,
      ),
    ]);
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
    expect(failureWakes(ops)).toHaveLength(1);
    const stillDown = ops.filter((line) => line.includes("is still failing at the provider"));
    expect(stillDown).toHaveLength(1);
    expect(clock.now - start).toBeGreaterThan(STILL_DOWN_MS);
    // Meanwhile the reply is deliverable, so nothing climbs the ladder.
    expect(idleWakes(ops)).toEqual([]);

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
    expect(crewmate.promptCalls).toEqual(Array.from({ length: 6 }, () => brief));
    expect(inbox.allFor(taskId)).toMatchObject([{ escalatedAt: null, failures: 6 }]);
    expect(tasks.get(taskId)?.outcome).toBeNull();
    expect(failureWakes(ops)).toHaveLength(1);
    expect(ops.filter((line) => line.includes("is still failing at the provider"))).toHaveLength(1);
  });

  // INF-5142: a lane waiting for its computer's update waits for that, not
  // for its provider, so the first mate is not told the provider is still
  // down; the outage stays on the lane for when it goes on. The hold is
  // stood in here: its computer side is placedReach.test.ts's.
  it("tells nothing of a provider outage while its lane waits for its computer's update, and keeps the outage", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, ops } = harness;
    const stillDown = () => ops.filter((line) => line.includes("is still failing at the provider"));
    await supervisor.steer.steerCrewmate(taskId, "use the other library");
    await settle();
    await failTurn(crewmate, taskId);
    const waiting = vi
      .spyOn(supervisor.updates, "waitsForUpdateThere")
      .mockImplementation((id) => id === taskId);
    clock.now += STILL_DOWN_MS + minutes(1);
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    expect(stillDown()).toEqual([]);
    expect(inbox.outage(taskId).failures).toBe(1);

    waiting.mockRestore();
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    expect(stillDown()).toHaveLength(1);
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
    started = idleSince;
    await at(JOB_BOUND_MS - 1);
    expect(ops.filter((line) => line.includes("background job running"))).toHaveLength(0);
    await at(JOB_BOUND_MS);
    const bound = ops.filter((line) => line.includes("background job running"));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toContain('"gh run watch"');
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
    supervisor.watch.reconcileIdle(boot);
    expect(tasks.get(quiet.id)?.idleSince).toBe(boot);
    clock.now = boot + STALL_WAKE_MS;
    supervisor.watch.reconcileIdle(clock.now);
    await settle();
    expect(crewmate.promptCalls).toEqual([IDLE_NUDGE_TEXT, IDLE_NUDGE_TEXT]);
    expect(sorts.map((sort) => [sort.taskId, sort.rule])).toEqual([
      [quiet.id, "idle-nudge"],
      [reported.id, "idle-nudge"],
    ]);
    expect(ops).toEqual([]);
  });
});
