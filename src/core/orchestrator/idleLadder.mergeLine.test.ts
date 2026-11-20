/**
 * A kept merge waiting in a line (INF-4497 finding 2, the captain's note:
 * "perhaps only for PRs being batched? normal PRs should not take too
 * long"): while the captain's approved change waits in a line - here the
 * merge queue where the project lives, which a real merge click reaches -
 * the idle ladder raises no stalled flag and tells its crewmate once why;
 * an approval waiting on its checks, as an ordinary pull request's does,
 * climbs the ladder as before. The batch line reads through the same
 * `waitingInLine` (mergeAuthorization.test.ts owns which waits count).
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */
import { describe, expect, it, vi } from "vitest";
import { endTurn, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import { APPROVED, approved } from "../../../tests/helpers/crewHarnessGit";
import { idleWakes, minutes } from "../../../tests/helpers/idleLadderHarness";
import { mergeLineWake } from "./deliveryWakes";
import { IDLE_NUDGE_TEXT } from "./idleWakes";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("a kept merge waiting in a line is not a stall (INF-4497 finding 2)", () => {
  it("tells the crewmate once and raises nothing while the host's merge queue holds the approved version", async () => {
    const harness = await approved();
    const { crewmate, ops, sorts, supervisor, taskId } = harness;
    harness.forge.hostQueue = true;
    supervisor.cardActions.act(harness.card.id, "merge");
    await vi.waitFor(() =>
      expect(harness.authorization()).toMatchObject({
        status: "standing",
        waiting: { on: "host-queue", head: APPROVED },
      }),
    );
    const approval = harness.authorization();
    if (!approval) throw new Error("the click kept no approval");
    const idleSince = harness.tasks.get(taskId)?.idleSince ?? Date.now();
    const prompts = crewmate.promptCalls.length;

    // A quick line costs the crewmate no turn: nothing before the nudge's time.
    supervisor.watch.reconcileIdle(idleSince + minutes(10) - 1);
    await vi.waitFor(() => expect(harness.tasks.get(taskId)?.activity).not.toBe("running"));
    expect(crewmate.promptCalls).toHaveLength(prompts);
    supervisor.watch.reconcileIdle(idleSince + minutes(10));
    // The one steer, in place of the nudge: the words name the queue and the version.
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(prompts + 1));
    expect(crewmate.promptCalls.at(-1)).toContain(
      renderWake(mergeLineWake(approval, "host-queue", APPROVED)),
    );
    // Its turn ends with a report: the sort reads the queue as moving, so no one is woken.
    await endTurn(crewmate, taskId, "Waiting for the merge queue.");
    await vi.waitFor(() =>
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "still-moving" }),
    );
    const since = harness.tasks.get(taskId)?.idleSince ?? idleSince;

    // Hours on, past every rung: no second steer, no nudge, no wake to the
    // first mate, no stall card and no stalled line.
    for (const idle of [10, 20, 50, 80, 300]) {
      supervisor.watch.reconcileIdle(since + minutes(idle));
      await vi.waitFor(() => expect(harness.tasks.get(taskId)?.activity).not.toBe("running"));
    }
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(idleWakes(ops)).toEqual([]);
    expect(harness.cards().some((card) => card.id === `card-stall-${taskId}`)).toBe(false);
    expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBeUndefined();
    expect(harness.authorization()).toMatchObject({ status: "standing" });
    expect(harness.forge.sends).toBe(1);
    supervisor.disposeAll();
  });

  it("climbs as before while the kept approval waits on its checks, as an ordinary pull request's does", async () => {
    const harness = await approved();
    const { crewmate, ops, supervisor, taskId } = harness;
    harness.forge.states = ["pending"];
    supervisor.cardActions.act(harness.card.id, "merge");
    await vi.waitFor(() =>
      expect(harness.authorization()).toMatchObject({
        status: "standing",
        waiting: { on: "checks" },
      }),
    );
    const idleSince = harness.tasks.get(taskId)?.idleSince ?? Date.now();
    supervisor.watch.reconcileIdle(idleSince + minutes(10));
    await vi.waitFor(() => expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT));
    await endTurn(crewmate, taskId);
    supervisor.watch.reconcileIdle(idleSince + minutes(20));
    await vi.waitFor(() => expect(idleWakes(ops)).toHaveLength(1));
    supervisor.disposeAll();
  });
});
