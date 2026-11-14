import { describe, expect, it, vi } from "vitest";
import type { FakeForge } from "../../../tests/helpers/prCiHarness";
import {
  deliveringFromAnotherBranch,
  opens,
  original,
  phone,
  repaired,
} from "../../../tests/helpers/savedStory";
import type { ForgePull } from "../forge";

// Integration cohort (docs/test-cohorts.md): real git at the run's own
// priority, the slowest test (the first, which loads the file's modules)
// 0.32 s at its fastest of five Mac runs, so five times fits vitest's 5 s
// default and the file sets no budget.

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// The merge card of a story pull request merged outside the app (INF-3799),
// reached through show_merge_card's walk, the card call and check_change.
describe("the merge card of a story pull request merged outside the app", () => {
  // INF-3799, found on INF-3710: the pull request that carried the story
  // merged outside the app, and check_change asked for its merge card. The
  // walk and the card call show the story it merged with, at the version
  // that merged, saving and sending nothing again; a version the story
  // never reached stops both with what to do instead.
  const mergedOutside = (at: { forge: FakeForge }, headSha: string) => {
    at.forge.change = null;
    Object.assign(at.forge, {
      pull: async (number: number): Promise<ForgePull> => ({
        number,
        state: "closed",
        merged: true,
        mergedSha: "5a5a5a5a",
        headSha,
        base: "main",
        readiness: "clean",
      }),
    });
  };

  it("shows the story a pull request merged outside the app carried, saving and sending nothing again", async () => {
    const { at, story: saved } = await deliveringFromAnotherBranch();
    // One title for the story, the pull request and the card.
    const story = { ...saved, title: "feat: share the story" };
    expect((await at.service.mergeCard.walk("ab12cd34", story)).ready).toBeDefined();
    mergedOutside(at, original);
    // check_change asks for the card the walk shows.
    expect(await at.service.checkTool.checkForCrew("ab12cd34", {})).toContain(
      "put up your merge card for this pull request with after close",
    );
    const walk = await at.service.mergeCard.walk("ab12cd34", {
      ...story,
      whatChanged: ["Words written after the merge."],
    });
    expect(walk).toEqual({
      did: [
        `#1413 was merged outside the app at ${original}, so its merge card shows story revision 1, the story it merged with; the story words you passed were not saved, since a merged pull request takes no new story.`,
      ],
      ready: { revision: 1, title: story.title, head: original },
    });
    expect(at.tasks.delivery.changePresentation("ab12cd34", phone)?.revisions).toHaveLength(1);
    expect(opens(at)).toBe(1);
    // The card call shows that story at the version that merged.
    expect(await at.service.publication.completionPresentation("ab12cd34", 1)).toMatchObject({
      revision: 1,
      title: story.title,
    });
  });

  // The review of INF-3799: check_change read the merge apart from the
  // card's own verdict, and asked for a card the walk and the card call
  // refused.
  it.each([
    ["at a version its story never reached", "unreached"],
    ["after a newer story revision was prepared and never published", "newer"],
  ] as const)(
    "stops the walk and the card call, and check_change asks for the merge's report instead of a card, when the pull request merged %s",
    async (_label, kind) => {
      const { at, story: saved } = await deliveringFromAnotherBranch();
      // One title for the story, the pull request and the card.
      const story = { ...saved, title: "feat: share the story" };
      expect((await at.service.mergeCard.walk("ab12cd34", story)).ready).toBeDefined();
      mergedOutside(at, kind === "unreached" ? repaired : original);
      if (kind === "newer")
        expect(
          await at.service.publication.preparePresentation("ab12cd34", {
            ...story,
            whatChanged: ["Words written after the merge."],
          }),
        ).toContain("Prepared presentation 2 ");
      const refused =
        kind === "unreached"
          ? `#1413 was merged outside the app at ${repaired}, a version its published story revision 1 at ${original} never reached.`
          : "#1413 was merged outside the app carrying story revision 1, and story revision 2 was prepared after it and never published.";
      const walk = await at.service.mergeCard.walk("ab12cd34");
      expect(walk.stop).toMatchObject({ step: "pull", by: "crewmate" });
      expect(walk.stop?.missing).toContain(refused);
      await expect(at.service.publication.completionPresentation("ab12cd34", 1)).rejects.toThrow(
        refused,
      );
      const reading = await at.service.checkTool.checkForCrew("ab12cd34", {});
      expect(reading).toContain(
        `Nothing is left to merge. ${refused} A merged pull request takes no new story, so it has no merge card: report the merge`,
      );
      expect(reading).not.toContain("put up your merge card");
      expect(opens(at)).toBe(1);
    },
  );

  // The review of INF-3799: the card call answered a working copy past the
  // merged version with "Push it", which no push answers.
  it("tells a working copy past the merged version to check that version out, in the walk and the card call", async () => {
    const { at, story: saved, checkedOut } = await deliveringFromAnotherBranch();
    // One title for the story, the pull request and the card.
    const story = { ...saved, title: "feat: share the story" };
    expect((await at.service.mergeCard.walk("ab12cd34", story)).ready).toBeDefined();
    mergedOutside(at, original);
    // A commit after the merge.
    checkedOut.head = repaired;
    at.readHead.mockResolvedValue(repaired);
    const ahead = `#1413 was merged outside the app at ${original}, and the committed version here is ${repaired}, which did not merge. Its merge card shows the version that merged: check that version out to show it.`;
    const walk = await at.service.mergeCard.walk("ab12cd34");
    expect(walk.stop).toMatchObject({ step: "commit", by: "crewmate" });
    expect(walk.stop?.missing).toContain(ahead);
    await expect(at.service.publication.completionPresentation("ab12cd34", 1)).rejects.toThrow(
      ahead,
    );
  });

  // The review of INF-3799: the walk's first read of the pull request comes
  // before the story step. Words saved while a merged pull request could
  // not be read would be a newer revision that refuses its merge card for
  // good, so a failed read stops the walk and says the words were not saved.
  it.each([
    ["the open pull requests", "open"],
    ["the merged pull request by its number", "merged"],
  ] as const)(
    "stops at a failed read of %s and says the story words it was given were not saved",
    async (_label, read) => {
      const { at, story: saved } = await deliveringFromAnotherBranch();
      // One title for the story, the pull request and the card.
      const story = { ...saved, title: "feat: share the story" };
      expect((await at.service.mergeCard.walk("ab12cd34", story)).ready).toBeDefined();
      const failed = async () => {
        throw new Error("GitHub did not answer.");
      };
      if (read === "open") Object.assign(at.forge, { changeFor: failed });
      else {
        mergedOutside(at, original);
        Object.assign(at.forge, { pull: failed });
      }
      const walk = await at.service.mergeCard.walk("ab12cd34", {
        ...story,
        whatChanged: ["Words written while GitHub did not answer."],
      });
      expect(walk.stop).toEqual({
        step: "pull",
        missing:
          "GitHub did not answer. The story words you passed were not saved: pass them again.",
        by: "app",
      });
      expect(at.tasks.delivery.changePresentation("ab12cd34", phone)?.revisions).toHaveLength(1);
      if (read === "merged") {
        // Read again, the merge card shows the story it merged with.
        mergedOutside(at, original);
        expect((await at.service.mergeCard.walk("ab12cd34", story)).ready).toMatchObject({
          revision: 1,
          head: original,
        });
      }
    },
  );
});
