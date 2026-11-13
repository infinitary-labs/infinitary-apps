/**
 * Guardrails for the settle service before it splits along its owners
 * (INF-2625's plan, the settle piece): the last look a merge takes right
 * before its request goes out, and the refusals of a merge, a land and a
 * discard. Each case changes one live fact while the merge is out and
 * reads what the settle answered and what the task record kept.
 */
import { MERGE_WORDS } from "@shared/vocabulary";
import { describe, expect, it } from "vitest";
import {
  HEAD,
  PR,
  settleWorld,
  standingApproval,
  TASK,
} from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { heldLine } from "./settleCardFacts";

type World = ReturnType<typeof settleWorld>;

/** A first mate merge whose request reads the last look after `change` ran. */
async function firstmateMergeAfter(world: World, change: () => void) {
  world.live.autonomy = true;
  let looked: string | undefined;
  let sentWhileOut = false;
  world.merge = async (_guard, boundary) => {
    change();
    looked = boundary?.beforeDispatch(HEAD);
    sentWhileOut = world.locks.mergeWasSent(TASK);
    return looked
      ? { ok: false, text: `Cannot merge: ${looked}` }
      : { ok: true, text: `Merged #${PR} on GitHub.`, receipt: { head: HEAD } };
  };
  const answer = await world.settle.settleTaskDetailed(TASK, "merge-pr");
  return { answer, looked, sentWhileOut };
}

describe("the last look before a merge goes out", () => {
  it("lets the merge go out when nothing changed, and marks it sent only while it is out", async () => {
    const world = settleWorld();
    const { answer, looked, sentWhileOut } = await firstmateMergeAfter(world, () => {});
    expect(looked).toBeUndefined();
    expect(sentWhileOut).toBe(true);
    expect(world.locks.mergeWasSent(TASK)).toBe(false);
    expect(answer.text).toBe(`Merged #${PR} on GitHub.`);
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
  });

  it.each<[string, (world: World) => void, string]>([
    [
      "the task closed",
      (world) =>
        world.tasks.close(TASK, { status: "dropped", reason: "cancelled", actor: "captain" }),
      "the task closed",
    ],
    [
      "its policies changed",
      (world) => world.repos.configure("project", { rigor: "reviewed" }),
      "its policies changed; recheck the current requirements before trying again",
    ],
    [
      "its crewmate started working",
      (world) => {
        world.live.runtime = "streaming";
      },
      "its crewmate is still working",
    ],
    [
      "its delivery stopped opening pull requests",
      (world) => {
        world.live.delivery = "local-only";
      },
      "the requested destination does not match its current delivery policy",
    ],
    [
      "autonomy went off",
      (world) => {
        world.live.autonomy = false;
      },
      '"Correct the meter" is not yours to do: autonomy is off for this task (Meter asks before merging).',
    ],
    [
      "its crewmate asked the captain something",
      (world) =>
        world.cards.put({
          id: "card-question",
          taskId: TASK,
          author: "crewmate",
          priority: 1,
          title: "Which meter reads first?",
          meta: TASK,
          body: "<p>Which meter reads first?</p>",
          actions: [
            { id: "left", label: "The left one", default: true },
            { id: "right", label: "The right one" },
          ],
          status: "ready",
          createdAt: 1_000,
        }),
      'the open question "Which meter reads first?" needs an answer.',
    ],
    [
      "a part of it opened",
      (world) =>
        seedTask(world.tasks, {
          id: "meter-part",
          title: "Calibrate the second meter",
          parentId: TASK,
          status: "queued",
        }),
      "Calibrate the second meter",
    ],
  ])("refuses the merge when %s while it was out", async (_case, change, words) => {
    const world = settleWorld();
    const { answer, looked, sentWhileOut } = await firstmateMergeAfter(world, () => change(world));
    expect(looked).toContain(words);
    expect(answer.text).toContain(words);
    expect(sentWhileOut).toBe(false);
    expect(world.locks.mergeWasSent(TASK)).toBe(false);
    expect(world.tasks.get(TASK)?.closedReason ?? null).not.toBe("merged");
  });
});

// Intent: the approved reminder fix keeps all five real waits at the last
// look, and records an unattended refusal once while backing off its retry.
describe("an app-approved merge with a reported check-back", () => {
  function reminderWorld() {
    const world = settleWorld();
    world.live.autonomy = true;
    seedDelivery(world.tasks, TASK, {
      mergeAuthorization: standingApproval({ issuer: "autonomy" }),
    });
    world.tasks.turns.recordReport(TASK, {
      text: "The batch passed. I will check the merge again later.",
      declared: { checkBack: { minutes: 10, waitingFor: "Confirm the merge completed" } },
    });
    return world;
  }

  function lastLook(world: World, change: () => void) {
    const sent: string[] = [];
    world.merge = async (guard, boundary) => {
      change();
      const refusal = guard?.beforeDispatch(HEAD) ?? boundary?.beforeDispatch(HEAD);
      if (refusal) return { ok: false, stop: "withdrawn", text: `Cannot merge: ${refusal}` };
      sent.push(HEAD);
      return { ok: true, text: `Merged #${PR} on GitHub.`, receipt: { head: HEAD } };
    };
    return sent;
  }

  it("sends the merge despite the matching reminder", async () => {
    const world = reminderWorld();
    const sent = lastLook(world, () => {});
    await world.kept.runMergeAuthorization(TASK);
    expect(sent).toEqual([HEAD]);
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization?.status).toBe("consumed");
  });

  it("does not turn an ended approval into a waiting approval", async () => {
    const world = reminderWorld();
    const sent = lastLook(world, () =>
      world.approvals.revokeMergeAuthorization(TASK, "the captain interrupted it"),
    );
    await world.kept.runMergeAuthorization(TASK);
    expect(sent).toEqual([]);
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
      status: "revoked",
    });
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization?.waiting).toBeUndefined();
    expect(
      world.tasks
        .timeline(TASK)
        .some((event) => event.text.startsWith("The kept merge did not run yet:")),
    ).toBe(false);
  });

  it("does not attach an old refusal to a replacement generation", async () => {
    const world = reminderWorld();
    const before = world.tasks.get(TASK)?.delivery?.mergeAuthorization;
    if (!before) throw new Error("The app approval fixture is missing");
    const sent = lastLook(world, () =>
      seedDelivery(world.tasks, TASK, {
        mergeAuthorization: { ...before, generation: before.generation + 1 },
      }),
    );
    await world.kept.runMergeAuthorization(TASK);
    expect(sent).toEqual([]);
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
      status: "standing",
      generation: before.generation + 1,
    });
    expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization?.waiting).toBeUndefined();
    expect(world.wakes).toEqual([]);
  });

  it.each<[string, (world: World) => void, string]>([
    [
      "scheduled continuation",
      (world) =>
        world.tasks.placement.setGate(TASK, {
          kind: "at-time",
          until: 1_200_000,
        }),
      "scheduled continuation",
    ],
    [
      "allowance wait",
      (world) =>
        world.tasks.placement.setGate(TASK, {
          kind: "quota-reset",
          ref: "bucket:high",
        }),
      "waiting for your plan's allowance",
    ],
    [
      "captain gate",
      (world) =>
        world.tasks.placement.setGate(TASK, {
          kind: "captain",
          ref: "card-plan",
        }),
      "parked on the captain",
    ],
    [
      "reminder plus question",
      (world) =>
        world.cards.put({
          id: "card-question",
          taskId: TASK,
          author: "crewmate",
          priority: 1,
          title: "Which meter reads first?",
          meta: TASK,
          body: "<p>Which meter reads first?</p>",
          actions: [
            { id: "left", label: "The left one", default: true },
            { id: "right", label: "The right one" },
          ],
          status: "ready",
          createdAt: 1_000,
        }),
      'open question "Which meter reads first?"',
    ],
    [
      "reminder then captain wait",
      (world) =>
        world.tasks.turns.recordReport(TASK, {
          text: "Choose the meter order before merging.",
          declared: { wait: { reason: "Choose the meter order", cardId: "card-plan" } },
        }),
      "waiting on the captain: Choose the meter order",
    ],
  ])(
    "keeps a %s stopped, recorded and backed off without repeated wakes",
    async (_name, change, words) => {
      const world = reminderWorld();
      const sent = lastLook(world, () => change(world));
      const notes = () =>
        world.tasks
          .timeline(TASK)
          .filter((event) => event.text?.startsWith("The kept merge did not run yet:"));
      await world.kept.runMergeAuthorization(TASK);
      const first = world.tasks.get(TASK)?.delivery?.mergeAuthorization;
      expect(sent).toEqual([]);
      expect(first).toMatchObject({ status: "standing", waiting: { on: "refused", head: HEAD } });
      expect(first?.attempt).toBeUndefined();
      expect(first?.retryAt).toBeGreaterThan(1_000);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]?.text).toContain(words);
      expect(world.wakes).toHaveLength(1);
      expect(world.wakes[0]).toMatchObject({ outcome: expect.stringContaining(words) });
      await world.kept.runMergeAuthorization(TASK);
      expect(sent).toEqual([]);
      expect(notes()).toHaveLength(1);
      expect(world.wakes).toHaveLength(1);
      expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization?.retryAt).toBeGreaterThan(
        first?.retryAt ?? 0,
      );
      // Clearing the real wait keeps the same approval; it needs no new click.
      world.cards.takeDown("card-question", "The meter order is settled.");
      world.tasks.turns.recordReport(TASK, { text: "The wait is resolved." });
      world.tasks.placement.setGate(TASK, null);
      const resumed = lastLook(world, () => {});
      await world.kept.runMergeAuthorization(TASK);
      expect(resumed).toEqual([HEAD]);
      expect(world.tasks.get(TASK)?.delivery?.mergeAuthorization).toMatchObject({
        id: first?.id,
        status: "consumed",
      });
    },
  );
});

describe("a settle's refusals before anything goes out", () => {
  it("refuses a merge while another settle owns the task, as contention", async () => {
    const world = settleWorld();
    world.live.autonomy = true;
    let second: string | undefined;
    world.merge = async () => {
      second = (await world.settle.settleTaskDetailed(TASK, "merge-pr")).text;
      return { ok: true, text: `Merged #${PR} on GitHub.`, receipt: { head: HEAD } };
    };
    await world.settle.settleTaskDetailed(TASK, "merge-pr");
    expect(second).toBe(
      `Cannot merge-pr task ${TASK}: merge-pr is already in progress. Wait for its outcome.`,
    );
    // Contention is not an outcome: the record keeps no refusal row for it.
    expect(
      world.tasks.timeline(TASK).filter((event) => event.data?.refused === "merge-pr"),
    ).toHaveLength(0);
  });

  it("refuses a first mate merge under the autonomy hold, naming the merge card's button", async () => {
    const world = settleWorld();
    world.cards.put({
      id: "card-done",
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
    });
    const answer = await world.settle.settleTaskDetailed(TASK, "merge-pr");
    expect(answer.refusal).toMatchObject({
      refused: "autonomy-off",
      ways: [{ label: "Merge", card: { id: "card-done", action: "merge" } }],
    });
    expect(answer.text).toContain(
      'The merge card "The meter reads on time" is on the stack with its "Merge" button',
    );
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(world.tasks.timeline(TASK).at(-1)?.data).toMatchObject({ refused: "merge-pr" });
  });

  // INF-4042's review of INF-4031: a card whose Merge the app holds after a
  // push shows no such button, so the refusal points at no click.
  it("names a held merge card as waiting for its crewmate, offering no click on it", async () => {
    const world = settleWorld();
    const merge = {
      id: "merge",
      label: "Merge",
      default: true,
      effect: { kind: "merge" as const, after: "close" as const },
    };
    world.cards.put({
      id: "card-done",
      taskId: TASK,
      author: "crewmate",
      priority: 1,
      title: "The meter reads on time",
      meta: TASK,
      body: `${heldLine("pushed", [merge])}<p>The meter reads on time.</p>`,
      actions: [],
      status: "ready",
      createdAt: 1_000,
    });
    const answer = await world.settle.settleTaskDetailed(TASK, "merge-pr");
    expect(answer.refusal).toMatchObject({ refused: "autonomy-off", ways: [] });
    expect(answer.text).toContain(
      'The merge card "The meter reads on time" is on the stack without its "Merge" button',
    );
    expect(answer.text).not.toContain("that click is the merge");
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
  });

  it("refuses to discard a task whose crewmate is working unless the captain confirmed", async () => {
    const world = settleWorld();
    world.live.runtime = "streaming";
    const answer = await world.settle.settleTaskDetailed(TASK, "discard");
    expect(answer.text).toBe(
      `Cannot discard task ${TASK} "Correct the meter" while it is still working. Interrupt it first, or pass confirm true after the captain chooses.`,
    );
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("refuses to discard unmerged work, offering to discard anyway or merge instead", async () => {
    const world = settleWorld();
    world.live.work = { dirty: false, unlandedCommits: 2 };
    const answer = await world.settle.settleTaskDetailed(TASK, "discard");
    expect(answer.refusal).toMatchObject({
      refused: "unlanded-work",
      ways: [
        {
          label: "Discard anyway",
          args: { task_id: TASK, mode: "discard", confirm: true },
        },
        { label: `${MERGE_WORDS["merge-pr"]} instead`, args: { task_id: TASK, mode: "merge-pr" } },
      ],
    });
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("refuses to discard work on a computer out of reach until the captain confirms", async () => {
    // No computer that runs work answers in this world: its working copy cannot be read.
    const placed = settleWorld();
    seedTask(placed.tasks, {
      id: "away",
      title: "Read the far meter",
      status: "idle",
      repoId: "project",
      worktreeDir: "/not-mounted/away",
      branch: "fm/task-away",
      deviceId: "mac-mini",
    });
    const answer = await placed.settle.settleTaskDetailed("away", "discard");
    expect(answer.refusal).toMatchObject({
      refused: "unlanded-work",
      ways: [
        { label: "Discard anyway", args: { task_id: "away", mode: "discard", confirm: true } },
      ],
    });
    expect(answer.text).toContain(
      "its working copy is on a computer that is out of reach, so nobody can tell whether it holds unmerged work",
    );
    expect(placed.tasks.get("away")?.status).toBe("active");
  });
});
