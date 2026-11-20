/**
 * Audit row 1: guidance and stop during dependency preparation must survive
 * until a real turn owns them. Drive the public supervisor with its real
 * inbox and records; only the dependency completion and model are controlled.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";

fakeCrewTimersEachTest();

describe("a crewmate preparing its first turn (audit row 1)", () => {
  async function preparing() {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const install = deferred<{ outcome: "skipped" }>();
    vi.mocked(h.workspace.installDependencies).mockReturnValue(install.promise);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Repair the dependency install",
      intent: intentOf("Fix the dependency install and check the result"),
    });
    await tick();
    expect(h.workspace.installDependencies).toHaveBeenCalled();
    expect(crewmate.promptCalls).toEqual([]);
    return { ...h, crewmate, install, taskId };
  }

  it("keeps a steer pending until a real turn reads it, then acknowledges every row", async () => {
    const h = await preparing();
    const guidance = "Keep the lockfile unchanged";
    await h.supervisor.steer.steerCrewmate(h.taskId, guidance);
    await h.supervisor.watch.sweepInbox(Date.now());
    expect(h.crewmate.steer).not.toHaveBeenCalled();
    expect(h.inbox.pending(h.taskId).some((row) => row.text === guidance)).toBe(true);
    h.install.resolve({ outcome: "skipped" });
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(1);
    h.crewmate.finishPrompt();
    await tick();
    expect(h.crewmate.promptCalls.at(-1)).toContain(guidance);
    h.crewmate.finishPrompt();
    await tick();
    expect(h.inbox.allFor(h.taskId)).toEqual([]);
    expect(h.inbox.inFlight(h.taskId)).toEqual([]);
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    console.info("Preparation steer readings", {
      modelSteersBeforePrompt: h.crewmate.steer.mock.calls.length,
      prompts: h.crewmate.promptCalls.length,
      guidanceRead: h.crewmate.promptCalls.at(-1),
      remainingRows: h.inbox.allFor(h.taskId),
    });
  });

  it("honors stop during install without starting a prompt or losing its brief", async () => {
    const h = await preparing();
    await h.supervisor.sessions.interruptCrewmate(h.taskId, "interrupt");
    h.install.resolve({ outcome: "skipped" });
    await tick();
    await h.supervisor.watch.sweepInbox(Date.now());
    expect(h.crewmate.promptCalls).toEqual([]);
    expect(h.inbox.inFlight(h.taskId)).toEqual([]);
    expect(h.inbox.allFor(h.taskId)).toHaveLength(1);
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.status).toBe("idle");
    const stopped = h.tasks.get(h.taskId);
    if (!stopped) throw new Error("The stopped task must remain on its record");
    expect(h.supervisor.postures.workPosture(stopped)).toEqual({
      state: "idle",
      reason: "inactive",
    });
    console.info("Preparation stop readings", {
      promptsAfterStopAndSweep: h.crewmate.promptCalls,
      inFlight: h.inbox.inFlight(h.taskId),
      pendingBriefs: h.inbox.allFor(h.taskId).length,
      status: h.supervisor.facts.crewStatus(h.taskId)[0]?.status,
    });
    await h.supervisor.steer.steerCrewmate(h.taskId, "Continue the repair");
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(1);
    expect(h.crewmate.promptCalls[0]).toContain("Continue the repair");
    expect(h.crewmate.promptCalls[0]).toContain("Fix the dependency install and check the result");
    h.crewmate.finishPrompt();
    await tick();
    expect(h.inbox.allFor(h.taskId)).toEqual([]);
    expect(h.inbox.inFlight(h.taskId)).toEqual([]);
  });

  it("releases a settle waiting for preparation when stop ends that preparation", async () => {
    const h = await preparing();
    let released = false;
    const boundary = h.supervisor.settling.locks
      .claim(h.taskId, "land")
      .waitForTurnEnd({
        mode: "land",
        actor: "captain",
        requestedAt: Date.now(),
        proceedWithOpen: false,
      })
      .then(() => {
        released = true;
      });
    await h.supervisor.sessions.interruptCrewmate(h.taskId, "interrupt");
    h.install.resolve({ outcome: "skipped" });
    await tick();
    expect(released).toBe(true);
    await boundary;
    expect(h.crewmate.promptCalls).toEqual([]);
    expect(h.supervisor.settling.locks.working(h.taskId)).toBe(false);
  });

  it("closes a cancelled preparation once and records the guidance that never ran", async () => {
    const h = await preparing();
    const guidance = "Keep the lockfile unchanged";
    await h.supervisor.steer.steerCrewmate(h.taskId, guidance);
    const unservedRows = [...h.inbox.allFor(h.taskId), ...h.inbox.inFlight(h.taskId)];
    await h.supervisor.sessions.interruptCrewmate(h.taskId, "cancel");
    h.install.resolve({ outcome: "skipped" });
    await tick();
    await h.supervisor.watch.sweepInbox(Date.now());
    expect(h.crewmate.promptCalls).toEqual([]);
    expect(h.inbox.allFor(h.taskId)).toEqual([]);
    expect(h.inbox.inFlight(h.taskId)).toEqual([]);
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(h.tasks.timeline(h.taskId)).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining(guidance),
        data: expect.objectContaining({ undelivered: unservedRows.length }),
      }),
    );
    console.info("Preparation cancel readings", {
      prompts: h.crewmate.promptCalls,
      remainingRows: h.inbox.allFor(h.taskId),
      status: h.tasks.get(h.taskId)?.status,
      unserved: h.tasks.timeline(h.taskId).find((event) => event.data?.undelivered)?.data,
    });
  });
});
