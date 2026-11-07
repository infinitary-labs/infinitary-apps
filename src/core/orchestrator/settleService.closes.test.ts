/**
 * Guardrails for the settle service before it splits along its owners
 * (INF-2625's plan, the settle piece): how a task closes. The order a close
 * takes - the crewmate stops, the record and its approval close in one
 * transaction, then the working copy - and
 * the rechecks the first mate's declared closes make after reading the
 * working copy.
 */
import { describe, expect, it } from "vitest";
import {
  HEAD,
  PR,
  type SettleWorld,
  settleWorld,
  standingApproval,
  TASK,
} from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";

function approved(): SettleWorld {
  const world = settleWorld();
  seedDelivery(world.tasks, TASK, { mergeAuthorization: standingApproval() });
  return world;
}

describe("the order a close takes", () => {
  it("spends the approval as the merge answers, then stops the crewmate and closes the record before the working copy goes", async () => {
    const world = approved();
    world.merge = async () => ({
      ok: true,
      text: `Merged #${PR} on GitHub.`,
      receipt: { head: HEAD },
    });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(world.log).toEqual([
      "merge: active/standing",
      "stop runtime: active/consumed",
      "runtime stopped: active/consumed",
      "retire worktree: done/consumed",
    ]);
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      generation: 1,
      receipt: { head: HEAD, at: 1_000 },
    });
  });

  it("revokes a standing approval in the close's own transaction when the task closes any other way", async () => {
    const world = approved();
    await world.settle.reportCardSettle(TASK, "discard");
    expect(world.tasks.get(TASK)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
      status: "revoked",
      reason: "the task closed discarded",
      generation: 2,
    });
    expect(world.log).toEqual([
      "close pull request: active/standing",
      "stop runtime: active/standing",
      "runtime stopped: active/standing",
      "retire worktree: dropped/revoked",
    ]);
  });

  it("records the close before the crewmate stops when the first mate closes finished work", async () => {
    const world = settleWorld();
    seedDelivery(world.tasks, TASK, { prNumber: undefined, headSha: undefined });
    world.live.deliverable = "operation";
    const answer = await world.declared.closeFinishedFolderWork(TASK, "The meter reads on time.");
    expect(answer.text).toContain("as finished: The meter reads on time.");
    expect(world.log.slice(0, 2)).toEqual([
      "stop runtime: active/none",
      "runtime stopped: done/none",
    ]);
  });

  it("closes a cancelled turn's task with the first mate's sentence, its pull request and cards going", async () => {
    const world = settleWorld();
    world.cards.put({
      id: "card-question",
      taskId: TASK,
      author: "crewmate",
      priority: 1,
      title: "Which meter reads first?",
      meta: TASK,
      body: "<p>Which meter reads first?</p>",
      actions: [{ id: "left", label: "The left one", default: true }],
      status: "ready",
      createdAt: 1_000,
    });
    world.closing.expectClosingSentence(TASK, "The captain stopped the meter work.");
    // The cancelled turn already ended: no runtime holds the task.
    world.live.runtime = undefined;
    world.closing.closeRecord(TASK, "cancelled", undefined, "firstmate");
    await world.closing.finishWorkspaceRetirement(TASK);
    expect(world.tasks.get(TASK)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(
      world.tasks.timeline(TASK).find((event) => event.data?.reason === "cancelled")?.data,
    ).toMatchObject({ closingSentence: "The captain stopped the meter work." });
    expect(world.cards.get("card-question")).toBeUndefined();
    expect(world.log).toContain("close pull request: dropped/none");
    expect(world.log).toContain("retire worktree: dropped/none");
  });

  it("keeps a typed failure's facts on a failed turn's close", () => {
    const world = settleWorld();
    const cutOff = { class: "no_headroom" as const, resetsAt: 5_000 };
    world.closing.closeRecord(TASK, "failed", "The plan's allowance ran out.", "host", { cutOff });
    const close = world.tasks.timeline(TASK).find((event) => event.data?.reason === "failed");
    expect(world.tasks.get(TASK)).toMatchObject({ status: "dropped", closedReason: "failed" });
    expect(close?.data).toMatchObject({ failureSignals: "typed", cutOff });
  });

  it("retires a delivery child with its builder, silently", async () => {
    const world = settleWorld();
    seedTask(world.tasks, {
      id: "meter-review",
      title: "Review the meter change",
      parentId: TASK,
      status: "idle",
      shape: { kind: "review", kind_source: "host:review" },
    });
    await world.closing.closeTask(TASK, {
      status: "dropped",
      reason: "discarded",
      actor: "captain",
    });
    expect(world.tasks.get("meter-review")).toMatchObject({
      status: "dropped",
      closedReason: "superseded",
    });
  });
});

describe("a release close rechecks after reading the working copy", () => {
  function released(): SettleWorld {
    const world = settleWorld();
    world.live.pull = {
      ...(world.live.pull as NonNullable<SettleWorld["live"]["pull"]>),
      state: "closed",
    };
    return world;
  }

  it("closes released work once nothing changed during the read", async () => {
    const world = released();
    const answer = await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.");
    expect(answer.text).toContain("as released outside this task: Shipped in 1.4.");
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "released" });
  });

  it("refuses when the crewmate started again while the working copy was read", async () => {
    const world = released();
    world.readWork = async () => {
      world.tasks.turns.setActivity(TASK, "running");
      return { dirty: false, unlandedCommits: 0 };
    };
    const answer = await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.");
    expect(answer.text).toContain(
      "its state changed while the working copy was checked; try again.",
    );
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("refuses with the wait when another task began holding it during the read", async () => {
    const world = released();
    seedTask(world.tasks, { id: "gauge", title: "Mount the gauge", status: "idle" });
    world.readWork = async () => {
      world.tasks.graph.link("gauge", TASK, "blocks", "crewmate", true);
      return { dirty: false, unlandedCommits: 0 };
    };
    const answer = await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.");
    expect(answer.refusal).toMatchObject({ tasks: [expect.objectContaining({ id: "gauge" })] });
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("refuses while its pull request may still be open", async () => {
    const world = settleWorld();
    const answer = await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.");
    expect(answer.text).toContain(`#${PR} is still open; close or merge it first.`);
    world.live.pull = undefined;
    const unread = await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.");
    expect(unread.text).toContain(`#${PR} could not be read, so it may still be open`);
  });

  it("refuses uncommitted edits and a working copy it cannot read", async () => {
    const world = released();
    world.live.work = { dirty: true, unlandedCommits: 0 };
    expect((await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.")).text).toContain(
      "its working copy has uncommitted edits",
    );
    world.live.work = null;
    expect((await world.declared.closeExternallyReleased(TASK, "Shipped in 1.4.")).text).toContain(
      "the working copy could not be checked: the working copy is gone",
    );
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });
});

describe("a handed-on answer's close rechecks after reading the working copy", () => {
  /** A change task whose reported result the captain handed on, with no pull request. */
  function handedOn(): SettleWorld {
    const world = settleWorld();
    seedDelivery(world.tasks, TASK, { prNumber: undefined, headSha: undefined });
    world.tasks.capture.recordResultHandoff(TASK, { cardId: "card-done", action: "keep" });
    return world;
  }

  it("closes it as answered when its working copy holds nothing unmerged", async () => {
    const world = handedOn();
    const answer = await world.declared.closeAnswerUsedAsBasis(TASK);
    expect(answer).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "answered" });
  });

  it("refuses when its work changed while the working copy was read", async () => {
    const world = handedOn();
    world.readWork = async () => {
      world.tasks.turns.setActivity(TASK, "running");
      return { dirty: false, unlandedCommits: 0 };
    };
    const answer = await world.declared.closeAnswerUsedAsBasis(TASK);
    expect(answer.text).toContain(
      "its work changed during the check; read its latest report before closing it.",
    );
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("refuses unmerged work and a working copy it cannot read", async () => {
    const world = handedOn();
    world.live.work = { dirty: false, unlandedCommits: 1 };
    expect((await world.declared.closeAnswerUsedAsBasis(TASK)).text).toContain(
      "its working copy has uncommitted edits or unmerged commits",
    );
    world.live.work = null;
    expect((await world.declared.closeAnswerUsedAsBasis(TASK)).text).toContain(
      "its working copy could not be checked; keep the task open.",
    );
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });
});

describe("a carried-on close's refusals", () => {
  it.each<[string, (world: SettleWorld) => void | Promise<void>, string]>([
    [
      "it is already closed",
      (world) =>
        world.tasks.close(TASK, { status: "dropped", reason: "cancelled", actor: "captain" }),
      "it is already cancelled.",
    ],
    [
      "a part of it is still open",
      (world) => {
        seedTask(world.tasks, {
          id: "meter-part",
          title: "Calibrate the second meter",
          parentId: TASK,
          status: "queued",
        });
      },
      "Calibrate the second meter",
    ],
  ])("refuses when %s", async (_case, change, words) => {
    const world = settleWorld();
    seedTask(world.tasks, { id: "carrier", title: "Carry the meter on", status: "idle" });
    await change(world);
    const answer = await world.declared.closeCarriedOn(TASK, "carrier");
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain(words);
  });

  it("refuses while another settle owns the task", async () => {
    const world = settleWorld();
    seedTask(world.tasks, { id: "carrier", title: "Carry the meter on", status: "idle" });
    world.live.autonomy = true;
    let answer: { ok: boolean; text: string } | undefined;
    world.merge = async () => {
      answer = await world.declared.closeCarriedOn(TASK, "carrier");
      return { ok: false, text: "Checks are running.", stop: "checks" };
    };
    await world.settle.settleTaskDetailed(TASK, "merge-pr");
    expect(answer?.text).toContain("merge-pr is already in progress. Wait for its outcome.");
  });
});
