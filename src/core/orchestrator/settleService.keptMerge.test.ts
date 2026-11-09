/**
 * Guardrails for the settle service before it splits along its owners
 * (INF-2625's plan, the settle piece): the captain's kept merge approval
 * (FI3-304). What its guard lets out and stops, the wait each stopped merge
 * leaves the approval on, the checks a host-run merge makes first, and how
 * an attempt that outlived its answer is read back.
 */
import type { Card } from "@shared/cards";
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
import type { MergeAuthorization } from "../storage/taskRecords";
import type { MergeGuard, MergeStop } from "./changeMerge";
import { PULL_NOT_THE_TASKS } from "./keptApproval";
import { queueWakeWords } from "./projectQueue";

const OTHER_HEAD = "b".repeat(40);

/** A world whose task carries the captain's standing approval of #71 at `HEAD`. */
function approved(patch: Partial<MergeAuthorization> = {}): SettleWorld {
  const world = settleWorld();
  seedDelivery(world.tasks, TASK, { mergeAuthorization: standingApproval(patch) });
  return world;
}

function approvalOf(world: SettleWorld): MergeAuthorization | undefined {
  return world.tasks.get(TASK)?.delivery?.mergeAuthorization;
}

/** The crewmate's completion card with its merge button. */
function completionCard(): Card {
  return {
    id: "card-done-2",
    taskId: TASK,
    author: "crewmate",
    priority: 1,
    title: "The meter reads on time",
    meta: TASK,
    body: "<p>The meter reads on time.</p>",
    actions: [
      { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
    ],
    status: "ready",
    createdAt: 1_000,
  };
}

/** A merge request that runs `change`, then takes the guard's last look at `head`. */
function lookAfter(world: SettleWorld, change: () => void, head = HEAD) {
  const seen: { guard?: MergeGuard; looked?: string } = {};
  world.merge = async (guard) => {
    seen.guard = guard;
    change();
    seen.looked = guard?.beforeDispatch(head);
    return seen.looked
      ? { ok: false, text: `Cannot merge: ${seen.looked}` }
      : {
          ok: true,
          text: `Merged #${PR} on GitHub.`,
          receipt: { head: HEAD, sha: "c".repeat(40) },
        };
  };
  return seen;
}

describe("the guard a kept merge runs with", () => {
  it("lets the captain's click out at the approved version and records the attempt first", async () => {
    const world = approved();
    let attempt: MergeAuthorization["attempt"];
    world.merge = async (guard) => {
      const looked = guard?.beforeDispatch(HEAD);
      attempt = approvalOf(world)?.attempt;
      return looked
        ? { ok: false, text: looked }
        : { ok: true, text: `Merged #${PR} on GitHub.`, receipt: { head: HEAD } };
    };
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(attempt).toMatchObject({ head: HEAD, at: 1_000 });
    expect(approvalOf(world)).toMatchObject({
      status: "consumed",
      receipt: { head: HEAD, at: 1_000 },
    });
    expect(approvalOf(world)?.attempt).toBeUndefined();
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
  });

  it("names the approved version and pull request, and marks a queue entry without an attempt", async () => {
    const world = approved();
    // Read inside the merge, asserted after it: a throw in the stub would
    // read as a failed merge, not a failed test.
    const calls: Array<{
      guard: MergeGuard | undefined;
      looked: string | undefined;
      attempt: MergeAuthorization["attempt"];
    }> = [];
    world.merge = async (seen) => {
      const looked = seen?.beforeDispatch(HEAD, true);
      calls.push({ guard: seen, looked, attempt: approvalOf(world)?.attempt });
      return { ok: false, text: "Queued.", stop: "queue" };
    };
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.guard).toMatchObject({ head: HEAD, prNumber: PR, unattended: false });
    expect(calls[0]?.looked).toBeUndefined();
    expect(calls[0]?.attempt).toBeUndefined();
  });

  it.each<[string, (world: SettleWorld) => void, string | undefined, string]>([
    [
      "the pull request moved past the approved version",
      () => {},
      OTHER_HEAD,
      "the pull request is not at the version the approval covers",
    ],
    [
      "the approval ended",
      (world) => world.approvals.revokeMergeAuthorization(TASK, "the captain interrupted it"),
      undefined,
      "the captain's merge approval ended",
    ],
    [
      "the task's change is another pull request",
      (world) => seedDelivery(world.tasks, TASK, { prNumber: PR + 1 }),
      undefined,
      PULL_NOT_THE_TASKS,
    ],
    [
      "the task closed",
      (world) =>
        world.tasks.close(TASK, { status: "dropped", reason: "cancelled", actor: "captain" }),
      undefined,
      "the task closed",
    ],
  ])("stops the captain's click when %s", async (_case, change, head, words) => {
    const world = approved();
    const seen = lookAfter(world, () => change(world), head);
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(seen.looked).toBe(words);
    expect(world.tasks.get(TASK)?.closedReason ?? null).not.toBe("merged");
  });

  it("ends the approval when the task's change is no longer the one approved", async () => {
    const world = approved();
    lookAfter(world, () => seedDelivery(world.tasks, TASK, { prNumber: PR + 1 }));
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)).toMatchObject({
      status: "invalidated",
      reason: PULL_NOT_THE_TASKS,
      generation: 2,
    });
  });

  it.each<[string, (world: SettleWorld) => void, string]>([
    [
      "its crewmate started working",
      (world) => {
        world.live.runtime = "streaming";
      },
      "its crewmate started working again",
    ],
    [
      "a new merge card went up",
      (world) => world.cards.put(completionCard()),
      "a new merge card is up",
    ],
  ])(
    "stops a host-run merge, but not the captain's click, when %s",
    async (_case, change, words) => {
      const host = approved();
      const unattended = lookAfter(host, () => change(host));
      await host.kept.runMergeAuthorization(TASK);
      expect(unattended.guard?.unattended).toBe(true);
      expect(unattended.looked).toBe(words);
      expect(host.tasks.get(TASK)?.status).toBe("active");

      const click = approved();
      const attended = lookAfter(click, () => change(click));
      await click.settle.reportCardSettle(TASK, "merge-pr");
      expect(attended.looked).toBeUndefined();
    },
  );

  it("holds the merge on the captain's newer guidance until its crewmate declares its impact", async () => {
    const world = approved();
    expect(world.approvals.holdForGuidance(TASK)).toBe(1);
    let held: string | undefined;
    world.merge = async (guard) => {
      held = guard?.held?.();
      return { ok: false, text: "Held.", stop: "guidance" };
    };
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(held).toBe(
      "the captain's guidance (mark 1) waits for its crewmate to declare its impact",
    );
    expect(approvalOf(world)).toMatchObject({
      status: "standing",
      guidance: { latest: 1, declared: 0 },
      waiting: { on: "guidance", head: HEAD },
    });
  });
});

describe("the wait a stopped merge leaves the approval on", () => {
  it.each<[MergeStop | undefined, { notGreen?: boolean }, string]>([
    ["conflict", {}, "conflict"],
    ["behind", {}, "conflict"],
    ["moved", {}, "repair"],
    ["checks", {}, "checks"],
    ["protected", {}, "protected"],
    ["computing", {}, "computing"],
    ["draft", {}, "draft"],
    ["transient", {}, "transient"],
    ["outcome", {}, "outcome"],
    ["queue", {}, "queue"],
    [undefined, { notGreen: true }, "checks"],
    [undefined, {}, "refused"],
  ])("a %s stop waits on %j", async (stop, extra, wait) => {
    const world = approved();
    world.merge = async () => ({
      ok: false,
      text: "The merge did not go out.",
      ...(stop ? { stop } : {}),
      ...extra,
    });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)).toMatchObject({
      status: "standing",
      waiting: { on: wait, head: HEAD, at: 1_000 },
      retries: 0,
    });
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("waits on its evidence when the moved version's repair is undecided", async () => {
    const world = approved({
      undecided: {
        fromHead: HEAD,
        toHead: OTHER_HEAD,
        newBase: "main",
        impact: "unknown",
        changedPaths: ["src/meter.ts"],
        evidence: "the crewmate could not compare the repaired meter",
        validation: "the meter tests passed at the repaired version",
        generation: 1,
        at: 900,
      },
    });
    world.merge = async () => ({ ok: false, text: "The branch moved.", stop: "moved" });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)?.waiting?.on).toBe("evidence");
  });

  // INF-2913: the batch check's warning (INF-2897) moved off the retired
  // note into what the Firstmate is told at the click.
  it("tells the Firstmate, not the captain, when nothing answers the project's queue", async () => {
    const world = approved();
    world.repos.recordQueue("project", { workflows: [] });
    world.merge = async () => ({ ok: false, text: "In the merge queue.", stop: "queue" });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)?.waiting?.on).toBe("queue");
    expect([...world.cards.values()]).toEqual([]);
    const warning = queueWakeWords({ workflows: [], answeredBefore: false });
    expect(warning).toBeDefined();
    expect(world.wakes).toEqual([
      expect.objectContaining({
        kind: "settled",
        unseen: true,
        outcome: expect.stringContaining(warning ?? ""),
      }),
    ]);
  });

  it.each<[MergeStop, string]>([
    ["closed", "its pull request was closed without merging"],
    ["identity", "the branch's pull request is not the one approved"],
  ])("ends the approval on a %s stop", async (stop, reason) => {
    const world = approved();
    world.merge = async () => ({ ok: false, text: "The merge did not go out.", stop });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)).toMatchObject({ status: "invalidated", reason, generation: 2 });
  });
});

describe("the checks a host-run merge makes before it asks anything", () => {
  it("ends the approval without merging when the task's change is another pull request", async () => {
    const world = approved();
    seedDelivery(world.tasks, TASK, { prNumber: PR + 1 });
    await world.kept.runMergeAuthorization(TASK);
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(approvalOf(world)).toMatchObject({
      status: "invalidated",
      reason: PULL_NOT_THE_TASKS,
    });
    expect(world.wakes).toEqual([
      expect.objectContaining({
        kind: "settled",
        chose: "merge-pr (kept)",
        outcome: expect.stringContaining(`ended: ${PULL_NOT_THE_TASKS}`),
      }),
    ]);
  });

  it("gives way to a new merge card without a word to the first mate", async () => {
    const world = approved();
    world.cards.put(completionCard());
    await world.kept.runMergeAuthorization(TASK);
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(approvalOf(world)).toMatchObject({
      status: "superseded",
      reason: "its crewmate put up a new merge card",
    });
    expect(world.wakes).toEqual([]);
  });

  it("waits on the captain's guidance without merging", async () => {
    const world = approved();
    world.approvals.holdForGuidance(TASK);
    await world.kept.runMergeAuthorization(TASK);
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(approvalOf(world)?.waiting).toMatchObject({ on: "guidance", head: HEAD });
  });
});

describe("an attempt that outlived its answer", () => {
  const attempt = { token: "attempt-1", head: HEAD, at: 900 };

  it("waits on the outcome while its pull request cannot be read", async () => {
    const world = approved({ attempt });
    world.live.pull = undefined;
    await world.kept.runMergeAuthorization(TASK);
    expect(approvalOf(world)).toMatchObject({
      status: "standing",
      attempt,
      waiting: { on: "outcome", head: HEAD },
      retries: 1,
    });
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
  });

  it("spends the approval and closes the task once when its pull request merged", async () => {
    const world = approved({ attempt });
    world.live.pull = {
      ...(world.live.pull as NonNullable<SettleWorld["live"]["pull"]>),
      state: "closed",
      merged: true,
      mergedSha: "c".repeat(40),
    };
    await world.kept.runMergeAuthorization(TASK);
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(approvalOf(world)).toMatchObject({
      status: "consumed",
      receipt: { head: HEAD, sha: "c".repeat(40) },
    });
  });

  it("ends the approval and tells the first mate when its pull request closed unmerged", async () => {
    const world = approved({ attempt });
    world.live.pull = {
      ...(world.live.pull as NonNullable<SettleWorld["live"]["pull"]>),
      state: "closed",
    };
    await world.kept.runMergeAuthorization(TASK);
    expect(approvalOf(world)).toMatchObject({
      status: "invalidated",
      reason: "its pull request was closed without merging",
    });
    expect(world.wakes).toEqual([
      expect.objectContaining({ kind: "settled", chose: "merge-pr (kept)" }),
    ]);
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("clears the token and runs every gate again while its pull request is still open", async () => {
    const world = approved({ attempt });
    await world.kept.runMergeAuthorization(TASK);
    expect(world.log.filter((line) => line.startsWith("merge"))).toHaveLength(1);
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
  });
});

describe("a merge request's refusals", () => {
  it("answers a host-run request whose approval no longer stands as withdrawn", async () => {
    const world = settleWorld({ reviews: true });
    const answer = await world.kept.requestMerge(TASK, "review-1", true);
    expect(answer).toMatchObject({ ok: false, stop: "withdrawn" });
    expect(world.log).toEqual([]);
  });

  it("refuses a request where the project lives cannot be reached", async () => {
    const world = settleWorld();
    const answer = await world.kept.requestMerge(TASK, "review-1");
    expect(answer).toMatchObject({
      ok: false,
      text: "Cannot merge: where the project lives is not reachable from here.",
    });
  });

  it("refuses a request on a closed task", async () => {
    const world = settleWorld();
    world.tasks.close(TASK, { status: "dropped", reason: "cancelled", actor: "captain" });
    const answer = await world.kept.requestMerge(TASK, "review-1");
    expect(answer).toMatchObject({
      ok: false,
      text: `Cannot merge: task ${TASK} is already cancelled.`,
    });
  });
});

// INF-2913, the captain: "only show a card if the merge went wrong and needs
// the user's decision". A kept merge's wait raises no card; the Firstmate
// hears the click's outcome with the words that the captain saw none.
describe("what a kept merge's wait shows", () => {
  // INF-2744: under autonomy the app approves from the card, so no one
  // clicked and the card is back up; the Firstmate is not told the captain
  // saw none.
  it.each<[MergeAuthorization["issuer"], boolean]>([
    ["autonomy", false],
    ["captain", true],
  ])(
    "marks a kept merge's conflict wake unseen only for the captain's click (%s)",
    async (issuer, unseen) => {
      const world = approved({ issuer });
      world.live.autonomy = issuer === "autonomy";
      world.merge = async () => ({ ok: false, text: "The branch conflicts.", stop: "conflict" });
      await world.kept.runMergeAuthorization(TASK);
      expect(approvalOf(world)?.waiting?.on).toBe("conflict");
      expect(world.wakes).toEqual([
        expect.objectContaining({ kind: "settled", outcome: expect.stringContaining("conflicts") }),
      ]);
      expect(world.wakes[0]).toMatchObject(unseen ? { unseen: true } : {});
      if (!unseen) expect(world.wakes[0]).not.toHaveProperty("unseen");
    },
  );

  it("raises no card while the approval waits, and merges when the gates pass", async () => {
    const world = approved();
    world.merge = async () => ({ ok: false, text: "Checks are running.", stop: "checks" });
    await world.settle.reportCardSettle(TASK, "merge-pr");
    expect(approvalOf(world)?.waiting?.on).toBe("checks");
    expect([...world.cards.values()]).toEqual([]);
    expect(world.wakes).toEqual([
      expect.objectContaining({
        kind: "settled",
        unseen: true,
        outcome: expect.stringContaining("Checks are running."),
      }),
    ]);
    world.merge = async () => ({
      ok: true,
      text: `Merged #${PR} on GitHub.`,
      receipt: { head: HEAD },
    });
    await world.kept.runMergeAuthorization(TASK);
    expect(world.tasks.get(TASK)?.closedReason).toBe("merged");
  });
});
