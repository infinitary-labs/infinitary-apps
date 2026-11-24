import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reportTurn,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { proofUnreadText } from "./reportWakes";

fakeCrewTimersEachTest();

// INF-6536 finding 3: recorded proof with no reader started is a fact the
// app holds, so the report that recorded it wakes the first mate, as other
// typed waits do. An open review already reads it, so it wakes nobody then.
describe("recorded proof that waits for a reader", () => {
  const HEAD = "4be7c1d90a2f3e5b6c7d8e9f0a1b2c3d4e5f6a7b";
  const unread = () => ({ ...noSurfaceProof(HEAD), reviews: [] });

  async function builderWithProof() {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Sort the Now panel",
      intent: intentOf("Sort the Now panel by whose turn it is"),
    });
    await tick();
    seedDelivery(h.tasks, taskId, { headSha: HEAD, liveValidation: unread() });
    return { h, crewmate, taskId };
  }

  it("wakes the first mate with the run and version when no review is open", async () => {
    const { h, crewmate, taskId } = await builderWithProof();
    await reportTurn(crewmate, taskId, "Recorded the live validation run.");
    const wake = h.ops.filter((line) => line.includes(`reported on task ${taskId}`)).at(-1);
    expect(wake).toContain(proofUnreadText({ run: 1, head: HEAD }));
    expect(h.sorts.filter((sort) => sort.taskId === taskId).at(-1)).toMatchObject({
      rule: "proof-unread",
      verdict: "captain",
    });
  });

  it("says nothing of it while a review of the task is open", async () => {
    const { h, crewmate, taskId } = await builderWithProof();
    seedTask(h.tasks, {
      id: "review-of-sort",
      parentId: taskId,
      title: "Review: Sort the Now panel",
      status: "running",
      shape: { kind: "review", kind_source: "host:review" },
    });
    await reportTurn(crewmate, taskId, "Recorded the live validation run.");
    expect(h.ops.join("\n")).not.toContain("waits for an independent reader");
    expect(h.sorts.filter((sort) => sort.taskId === taskId).at(-1)?.rule).not.toBe("proof-unread");
  });
});
