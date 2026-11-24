import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";

fakeCrewTimersEachTest();

// INF-6536 finding 3: a takeover at the very commit an earlier task's review
// passed carries that pass and its accepted proof, so its crewmate's proof
// at that commit is neither needed nor recorded; at a new commit it records
// its own, as now.
describe("a takeover recording proof at the reviewed commit", () => {
  const REVIEWED = "4f1c2b9e8d7a6c5b4a39281706f5e4d3c2b1a098";
  const NEXT = "9e2d1c0b8a7f6e5d4c3b2a1908f7e6d5c4b3a291";
  const PLAN = {
    validation: {
      kind: "plan" as const,
      previousRevision: 0,
      reason: "The Now panel sorts by whose turn it is.",
      scenarios: [],
    },
  };

  async function takeoverAt(head: string) {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    seedProject(h.db, {
      id: "now-panel",
      name: "now-panel",
      path: scratchDir("infinitary-now-panel-"),
      origin: "https://github.com/octo/now-panel.git",
      delivery: "queue-pr",
    });
    const earned = seedTask(h.tasks, {
      id: "earned01",
      title: "Sort the Now panel",
      status: "idle",
    });
    seedDelivery(h.tasks, earned.id, {
      headSha: REVIEWED,
      reviewVerdict: "pass",
      reviewSha: REVIEWED,
      liveValidation: noSurfaceProof(REVIEWED),
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Take over: sort the Now panel",
      intent: intentOf("Sort the Now panel by whose turn it is"),
      repoId: "now-panel",
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    h.tasks.graph.link(earned.id, taskId, "replaced-by", "firstmate");
    vi.mocked(h.workspace.branchHead).mockResolvedValue(head);
    const report = h.specs[0]?.onReport;
    if (!report) throw new Error("the crewmate's report is not bound");
    return { h, taskId, earned, report };
  }

  it("records nothing and says the carried proof stands", async () => {
    const { h, taskId, earned, report } = await takeoverAt(REVIEWED);
    await expect(report("Planned the checks.", undefined, PLAN)).rejects.toThrow(
      `Nothing was recorded: this task now carries the review ${earned.key} passed at this same commit and the proof accepted there`,
    );
    const delivery = h.tasks.get(taskId)?.delivery;
    expect(delivery?.reviewFrom).toMatchObject({ key: earned.key, proof: true });
    expect(delivery?.liveValidation?.plans.map(({ reason }) => reason)).toEqual([
      "The lifecycle fixture's branch contains no running product.",
    ]);
  });

  it("records the takeover's own proof at a new commit", async () => {
    const { h, taskId, report } = await takeoverAt(NEXT);
    await report("Planned the checks.", undefined, PLAN);
    const delivery = h.tasks.get(taskId)?.delivery;
    expect(delivery?.reviewFrom).toBeUndefined();
    expect(delivery?.liveValidation?.plans.map(({ reason }) => reason)).toEqual([
      "The Now panel sorts by whose turn it is.",
    ]);
  });
});
