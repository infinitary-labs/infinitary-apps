/**
 * The one drop (INF-3169's plan, piece 4; the captain's pick "Also fold the
 * three into one drop, as a fourth piece after the close"): Discard and the
 * captain's Drop task, on started and never-started work, end a task by
 * one set of rules. Each case drives a real CrewSupervisor through the crew
 * harness (tests/helpers/crewHarness.ts) and reads the record it leaves.
 */

import { dropReviewKeys } from "@shared/recordDrop";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { discardedText } from "./settleWords";

fakeCrewTimersEachTest();

/** A started task whose crewmate finished its turn and went idle. */
async function idleTask(
  harness: ReturnType<typeof setup>,
  crewmate: ReturnType<typeof fakeCrewmate>,
) {
  const { taskId } = await harness.supervisor.intake.commission({
    title: "Sketch the reef",
    intent: intentOf("sketch it"),
  });
  await tick();
  crewmate.finishPrompt();
  await tick();
  return taskId;
}

describe("the one drop", () => {
  it("keeps a copy whose work cannot be saved on Discard, says so, and removes it on the next drop", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { supervisor, tasks, workspace } = harness;
    const taskId = await idleTask(harness, crewmate);
    vi.mocked(workspace.retireTaskWorktree).mockResolvedValueOnce({
      outcome: "kept",
      reason: "the working copy could not be read",
    });

    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe(discardedText());
    await tick();
    // Before the fold, a discard removed a copy it could not save; Drop task
    // kept it. The one drop keeps it, so no work is lost.
    expect(tasks.get(taskId)).toMatchObject({
      status: "dropped",
      closedReason: "discarded",
      workspaceState: "present",
    });
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    expect(tasks.timeline(taskId).at(-1)).toMatchObject({
      kind: "note",
      text: "working copy kept - its work could not be saved first; discard to remove it",
    });

    // Dropping the closed task again is the choice to remove that copy.
    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe(discardedText());
    await tick();
    expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", workspaceState: "removed" });
  });

  it("closes the task's own open pull request before the captain's Drop task on started work closes it", async () => {
    const crewmate = fakeCrewmate();
    // What the record said when the pull request was asked to close.
    const statusAtPullClose: (string | undefined)[] = [];
    let harness: ReturnType<typeof setup> | undefined;
    const closePullRequest = vi.fn(async (id: string) => {
      statusAtPullClose.push(harness?.tasks.get(id)?.status);
      return { ok: true, text: "Closed PR #9 on GitHub." };
    });
    harness = setup(crewmate, { closePullRequest });
    const { supervisor, tasks } = harness;
    const taskId = await idleTask(harness, crewmate);
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");

    expect(supervisor.hostOps.runTaskOp(taskId, "stop-task")).toBeUndefined();
    await vi.waitFor(() => expect(tasks.get(taskId)?.status).toBe("dropped"));
    // Before the fold, Drop task closed the record first and asked for the
    // pull request's close without waiting on it.
    expect(closePullRequest).toHaveBeenCalledWith(taskId);
    expect(statusAtPullClose).toEqual(["active"]);
    expect(
      tasks
        .timeline(taskId)
        .find((event) => event.kind === "status" && event.data?.status === "dropped"),
    ).toMatchObject({
      actor: "captain",
      data: { via: "task-card", reason: "cancelled" },
    });
  });

  it("holds the first mate's own drop on open parts, and keeps them planned on the captain's", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { supervisor, tasks } = harness;
    const parentId = await idleTask(harness, crewmate);
    const part = supervisor.intake.plan({
      title: "Mark the bar",
      intent: intentOf("mark it"),
      parent: parentId,
    });

    const held = await supervisor.settling.settle.settleTask(parentId, "discard");
    expect(held).toContain(part.key);
    expect(tasks.get(parentId)?.status).toBe("active");

    // The captain's own Discard click is the one drop: the part stays planned.
    const outcome = await supervisor.settling.settle.reportCardSettle(parentId, "discard");
    expect(outcome).toMatchObject({ ok: true, text: discardedText() });
    expect(tasks.get(parentId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    expect(tasks.get(part.id)?.status).toBe("open");
  });

  it("drops never-started work with an open part from the record, which stays planned, and refuses a changed review", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const parent = supervisor.intake.plan({ title: "Chart the coast", intent: intentOf("all") });
    const part = supervisor.intake.plan({
      title: "Sound the channel",
      intent: intentOf("part"),
      parent: parent.id,
    });
    const review = dropReviewKeys(tasks.dropEffects(parent.id));
    expect(review.parts).toEqual([part.key]);

    expect(supervisor.hostOps.runTaskOp(parent.id, "drop-task", { ...review, parts: [] })).toBe(
      "This task changed. Review it again before dropping it.",
    );
    expect(tasks.get(parent.id)?.status).toBe("open");

    // Before the fold, the record refused this drop while the part was open.
    expect(supervisor.hostOps.runTaskOp(parent.id, "drop-task", review)).toBeUndefined();
    // Its record closes in the click itself.
    expect(tasks.get(parent.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(tasks.get(part.id)?.status).toBe("open");
  });
});
