/**
 * Guardrails for the settle service before it splits along its owners
 * (INF-2625's plan, the settle piece): the last look a merge takes right
 * before its request goes out, and the refusals of a merge, a land and a
 * discard. Each case changes one live fact while the merge is out and
 * reads what the settle answered and what the task record kept.
 */
import { MERGE_WORDS } from "@shared/vocabulary";
import { describe, expect, it } from "vitest";
import { HEAD, PR, settleWorld, TASK } from "../../../tests/helpers/settleHarness";
import { seedTask } from "../tasks/seedTask";

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
      "another decision or hold still needs attention.",
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

  it("refuses a first mate merge under the autonomy hold, naming the completion card's button", async () => {
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
        { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
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
      'The completion card "The meter reads on time" is on the stack with its "Merge" button',
    );
    expect(world.log.filter((line) => line.startsWith("merge"))).toEqual([]);
    expect(world.tasks.timeline(TASK).at(-1)?.data).toMatchObject({ refused: "merge-pr" });
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
