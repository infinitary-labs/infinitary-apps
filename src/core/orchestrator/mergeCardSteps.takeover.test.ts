import { describe, expect, it } from "vitest";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { deliveringFromAnotherBranch, original } from "../../../tests/helpers/savedStory";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";

// INF-6536 finding 3: show_merge_card on a takeover whose committed version
// is the very commit an earlier task's review passed shows that pass, and
// the proof accepted with it, naming the task that earned them.
describe("show_merge_card on a takeover at the reviewed commit", () => {
  const PAST = "7d3e9a1c5b8f2e4d6a0c9b7e5f3d1a8c6e4b2f09";

  async function takeover(reviewSha: string) {
    const { at, story: saved } = await deliveringFromAnotherBranch();
    const earned = seedTask(at.tasks, {
      id: "earned01",
      title: "Share the story",
      status: "idle",
    });
    at.tasks.graph.link(earned.id, "ab12cd34", "replaced-by", "firstmate");
    seedDelivery(at.tasks, earned.id, {
      headSha: reviewSha,
      reviewVerdict: "pass",
      reviewSha,
      reviewRisk: "low",
      liveValidation: noSurfaceProof(reviewSha),
    });
    // One title for the story, the pull request and the card.
    return { at, earned, story: { ...saved, title: "feat: share the story" } };
  }

  it("carries the pass and its proof, naming the task that earned them", async () => {
    const { at, earned, story } = await takeover(original);
    const walk = await at.service.mergeCard.walk("ab12cd34", story);
    expect(walk.did).toContain(
      `This task carries the review ${earned.key} passed at this same commit, with the proof accepted there.`,
    );
    expect(walk.stop?.step).not.toBe("proof");
    expect(at.tasks.get("ab12cd34")?.delivery).toMatchObject({
      reviewVerdict: "pass",
      reviewSha: original,
      reviewFrom: { taskId: earned.id, key: earned.key, proof: true },
    });
  });

  it("carries nothing when the reviewed commit is not the committed one", async () => {
    const { at, story } = await takeover(PAST);
    const walk = await at.service.mergeCard.walk("ab12cd34", story);
    expect(walk.did.join("\n")).not.toContain("carries the review");
    expect(at.tasks.get("ab12cd34")?.delivery?.reviewFrom).toBeUndefined();
  });
});
