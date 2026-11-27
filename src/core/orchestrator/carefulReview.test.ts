/**
 * Careful work committed with no review open (INF-7116 fix 3): INF-6937's
 * builder reported its Careful fix "committed and ready for the Careful code
 * review" while a notice it had already heard sat on its lane, so the sort
 * filed the report routine and nobody started the review for 31 hours. The
 * host starts no Careful review by itself, so the report wakes the first
 * mate and the crew status names the wait.
 * Each case drives a real CrewSupervisor through the crew harness with a
 * stand-in for what git answers of the task branch, and reads what it sorts,
 * wakes and answers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { carefulUnreviewedText } from "./reportWakes";

fakeCrewTimersEachTest();

const REPORT =
  "Intent: the meter test passes. What changed: the test awaits the flush. Verified: pnpm test. Risk: low. Not done: nothing. The fix is committed and ready for the Careful code review.";
const HEAD = "9c2e4b1a7d3f5e6c8b0a1d2e3f4a5b6c7d8e9f01";

describe("Careful work committed with no review open", () => {
  async function builder() {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    seedProject(h.db, {
      id: "meterlab",
      name: "Meterlab",
      path: scratchDir("inf-careful-review-"),
      origin: "https://github.com/octo/meterlab.git",
      delivery: "queue-pr",
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the meter test",
      intent: intentOf("fix the meter test"),
      repoId: "meterlab",
      shape: { rigor_ask: "reviewed" },
    });
    await tick();
    // What git answers of the task's branch: one commit of its own at HEAD.
    const commit = () => {
      vi.mocked(h.workspace.taskWorkStatus).mockResolvedValue({ dirty: false, unlandedCommits: 1 });
      vi.mocked(h.workspace.branchHead).mockResolvedValue(HEAD);
      return HEAD;
    };
    const report = async () => {
      const onReport = h.specs.at(-1)?.onReport;
      if (!onReport) throw new Error("Missing production report callback");
      await onReport(REPORT, "Committed, ready for its Careful review", {});
      await endTurn(crewmate, taskId);
    };
    const lastSort = () => h.sorts.filter((sort) => sort.taskId === taskId).at(-1);
    const wake = () => h.ops.filter((line) => line.includes(`reported on task ${taskId}`)).at(-1);
    const review = () => h.supervisor.facts.crewStatus(taskId)[0]?.review;
    return { h, taskId, commit, report, lastSort, wake, review };
  }

  it("wakes the first mate with the committed version and names the wait in crew status", async () => {
    const b = await builder();
    const head = b.commit();
    await b.report();
    expect(b.lastSort()).toMatchObject({ rule: "careful-unreviewed", verdict: "captain" });
    expect(b.wake()).toContain(carefulUnreviewedText({ head }));
    expect(b.review()).toBe(
      `waiting for its Careful review: committed at ${head.slice(0, 7)}, no review open and no pass covering it`,
    );
  });

  it("says nothing of it before the branch holds a commit of its own", async () => {
    const b = await builder();
    // A branch with no commits of its own still names a version: the base it started on.
    vi.mocked(b.h.workspace.branchHead).mockResolvedValue(HEAD);
    await b.report();
    expect(b.lastSort()?.rule).not.toBe("careful-unreviewed");
    expect(b.review()).toBeUndefined();
  });

  it("says nothing of it while a review of the task is open", async () => {
    const b = await builder();
    b.commit();
    seedTask(b.h.tasks, {
      id: "review-of-meter",
      parentId: b.taskId,
      title: "Review: Fix the meter test",
      status: "running",
      shape: { kind: "review", kind_source: "host:review" },
    });
    await b.report();
    expect(b.lastSort()?.rule).not.toBe("careful-unreviewed");
    expect(b.review()).not.toContain("waiting for its Careful review");
  });

  it("says nothing of it once a passed review covers the committed version", async () => {
    const b = await builder();
    const head = b.commit();
    seedDelivery(b.h.tasks, b.taskId, { reviewVerdict: "pass", reviewSha: head });
    await b.report();
    expect(b.lastSort()?.rule).not.toBe("careful-unreviewed");
    expect(b.review()).toBe(`review passed at ${head.slice(0, 7)}`);
  });

  it("says nothing of the version its last report read once a later version's review passed", async () => {
    const b = await builder();
    b.commit();
    await b.report();
    // Fix rounds that end in closing text read no version; the review passed at their last one.
    seedDelivery(b.h.tasks, b.taskId, {
      reviewVerdict: "pass",
      reviewSha: "5d1f0e2c3b4a69788796a5b4c3d2e1f0a9b8c7d6",
      reviewedAt: Date.now(),
    });
    expect(b.review()).toBe("review passed at 5d1f0e2");
  });

  it("says nothing of the version its last report read once a review of the task started since", async () => {
    const b = await builder();
    b.commit();
    await b.report();
    seedTask(b.h.tasks, {
      id: "review-of-meter",
      parentId: b.taskId,
      title: "Review: Fix the meter test",
      status: "cancelled",
      shape: { kind: "review", kind_source: "host:review" },
    });
    expect(b.review()).toBeUndefined();
  });

  it("says nothing of it once the captain lowers the task to Default care", async () => {
    const b = await builder();
    b.commit();
    await b.report();
    b.h.tasks.updateFields(b.taskId, { policies: { rigor: "standard" } }, "captain");
    expect(b.review()).toBeUndefined();
  });
});
