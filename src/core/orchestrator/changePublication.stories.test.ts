import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangePresentation } from "@shared/changePresentation";
import { softHoldWords } from "@shared/holds";
import type { MergeReview } from "@shared/mergeReview";
import type { HostedPresentationDestination } from "@shared/presentationDestination";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it, vi } from "vitest";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import {
  type CheckedOut,
  FakeForge,
  insertDirectPrTask,
  insertTask,
  recordPr,
  setup,
} from "../../../tests/helpers/prCiHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  type ForgeChange,
  NO_MISTAKES_ATTESTATION_PREFIX,
  NO_MISTAKES_SIGNATURE,
  presentationCommitMessage,
  presentationContentHash,
  presentationMarkdown,
} from "../forge";
import { stageChangePresentation } from "../pi/changePresentation";
import type { MergeAuthorization } from "../storage/taskRecords";

// Integration cohort (docs/test-cohorts.md): real git at the run's own
// priority, the slowest test (a stale story merged under an override) 0.63 s
// at its fastest of five Mac runs, so five times fits vitest's 5 s default
// and the file sets no budget.

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// INF-169 F4/F5/F6/F12: exercise the public service, not a source-text pin.
describe("shared story delivery boundaries", () => {
  const original = "5ca2d466ee21f9733827383f23df81f3874e0d10";
  const repaired = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
  async function saved(kind: "github" | "gitlab" = "github", checkedOut?: CheckedOut) {
    const bringBranchHome = vi.fn(async (): Promise<string> => {
      throw new Error("Work computer is asleep");
    });
    const at = setup({
      bringBranchHome,
      ...(checkedOut ? { checkedOut } : {}),
      ...(kind === "gitlab" ? { forge: new FakeForge({ kind, place: "GitLab" }) } : {}),
    });
    await insertDirectPrTask(at.tasks, at.repos, { deviceId: "sleeping-work-computer" });
    const story: ChangePresentation = {
      version: 1,
      taskId: "ab12cd34",
      revision: 1,
      title: "One saved story",
      base: original,
      head: original,
      destination: {
        host: "github.com",
        projectId: 1422452335,
        fullName: "kunchenguid/infinitary-evidence-test-public",
        visibility: "public",
      },
      why: ["Keep the approved explanation."],
      whatChanged: ["The publication recovers."],
      before: ["Recovery could wait forever."],
      after: ["Recovery is deliberate."],
      noPicture: "This fixture changes publication recovery, not a screen.",
      views: [],
      assets: [],
      pictures: [],
      verification: ["Read the saved publication."],
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [
          dimension,
          { level: "low", why: "A harmless delivery fixture." },
        ]),
      ) as RiskDeclaration,
      requiredActions: [],
      unfinished: [],
      projectText: "",
    };
    const region = presentationMarkdown(story, new Map(), "passed");
    const published = {
      revision: 1,
      head: original,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      contentHash: presentationContentHash(story),
      number: 23,
    };
    at.tasks.delivery.updateChangePresentation("ab12cd34", () => ({
      revisions: [story],
      receipts: [],
      publication: published,
      published,
    }));
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: original, body: region };
    const update = vi.fn(async (_change: ForgeChange, body: string, title?: string) => {
      at.forge.change = {
        ...(at.forge.change as ForgeChange),
        body,
        ...(title === undefined ? {} : { title }),
      };
    });
    Object.assign(at.forge, {
      attachments: {
        destination: async () => story.destination,
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
      branchHead: async () => at.forge.change?.headSha ?? "",
      updateChangeBody: update,
      pull: async () => ({
        number: 23,
        state: "open",
        merged: false,
        headSha: at.forge.change?.headSha,
        base: "main",
        readiness: "clean",
      }),
    });
    recordPr(at.tasks, 23);
    return { ...at, bringBranchHome, update, story };
  }

  // INF-1365 (INF-1363's merge stopped on its story after the captain's words passed it): the
  // override on the saved story passes its publication at the merge, and only there.
  describe("the captain's override on the saved story at the merge (INF-1365)", () => {
    const words = "Merge without waiting for the saved story";
    function override(
      at: Awaited<ReturnType<typeof saved>>,
      scope: "task" | "version" | "older-version" | "other-hold",
    ): void {
      seedDelivery(at.tasks, "ab12cd34", {
        override: {
          words,
          holds: [scope === "other-hold" ? "checks" : "story"],
          until: scope === "task" || scope === "other-hold" ? "task" : "version",
          ...(scope === "version" ? { head: repaired } : {}),
          ...(scope === "older-version" ? { head: original } : {}),
          at: 1,
        },
      });
    }
    /**
     * INF-1363's shape: the story was published, then a push moved the pull request past it.
     * Since INF-2509 the host republishes a story a push alone left behind, so its author
     * has prepared a newer one too, never published: the story the merge would carry is stale.
     */
    async function stale(kind: "github" | "gitlab" = "github") {
      const at = await saved(kind);
      at.tasks.delivery.updateChangePresentation("ab12cd34", (record) => ({
        ...record!,
        revisions: [
          ...record!.revisions,
          { ...at.story, revision: 2, head: repaired, after: ["A newer account, not published."] },
        ],
      }));
      at.forge.change = {
        ...(at.forge.change as ForgeChange),
        headSha: repaired,
        body: `Keeps the merge moving.\n\nBREAKING CHANGE: The story hold reads the override.\n\n${at.forge.change?.body ?? ""}`,
      };
      at.readHead.mockResolvedValue(repaired);
      return { ...at, putIn: vi.spyOn(at.forge, "putIn") };
    }

    it.each(["github", "gitlab"] as const)(
      "merges a story made stale by a push under a task-wide or this version's override on %s",
      async (kind) => {
        for (const scope of ["task", "version"] as const) {
          const at = await stale(kind);
          const before = at.tasks.delivery.changePresentation("ab12cd34");
          override(at, scope);
          const outcome = await at.service.merges.merge("ab12cd34");
          expect(outcome.ok).toBe(true);
          // The squash carries the description's own words and footer, never the older story.
          expect(at.putIn).toHaveBeenCalledWith(
            {
              ...at.forge.change,
              squashMessage:
                "Keeps the merge moving.\n\nBREAKING CHANGE: The story hold reads the override.",
            },
            repaired,
          );
          // Nothing is published, uploaded, refreshed or rewritten on the override's account.
          expect(at.tasks.delivery.changePresentation("ab12cd34")).toEqual(before);
          expect(at.update).not.toHaveBeenCalled();
        }
      },
    );

    it.each(["none", "older-version", "other-hold"] as const)(
      "still refuses the stale story with %s override, naming the soft hold",
      async (scope) => {
        const at = await stale();
        if (scope !== "none") override(at, scope);
        const outcome = await at.service.merges.merge("ab12cd34");
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain(
          "The current story and all evidence must be published and read back before the merge card or merge.",
        );
        expect(outcome.text).toContain(softHoldWords("story", "firstmate"));
        expect(at.putIn).not.toHaveBeenCalled();
      },
    );

    it("merges with no publication at all under a task-wide override, marking none", async () => {
      const at = await saved();
      at.tasks.delivery.updateChangePresentation("ab12cd34", () => ({
        revisions: [],
        receipts: [],
      }));
      const unpublished = at.tasks.delivery.changePresentation("ab12cd34");
      at.forge.change = { ...(at.forge.change as ForgeChange), body: "The plain description." };
      const putIn = vi.spyOn(at.forge, "putIn");
      expect((await at.service.merges.merge("ab12cd34")).text).toContain(
        "The current story has not been published.",
      );
      override(at, "task");
      expect((await at.service.merges.merge("ab12cd34")).ok).toBe(true);
      expect(putIn).toHaveBeenCalledWith(
        { ...at.forge.change, squashMessage: "The plain description." },
        original,
      );
      // Marking none: the ledger is exactly as it was before the merge.
      expect(unpublished).toMatchObject({ revisions: [], receipts: [] });
      expect(at.tasks.delivery.changePresentation("ab12cd34")).toEqual(unpublished);
    });

    it("merges a description replaced on the override, leaving the old story record as it was", async () => {
      const at = await stale();
      at.bringBranchHome.mockResolvedValue("");
      override(at, "task");
      const published = at.tasks.delivery.changePresentation("ab12cd34")?.published;
      await at.service.publication.open("ab12cd34", {
        title: "fix: keep the saved story",
        body: "The repaired change is ready.",
      });
      expect(at.forge.change?.body).toBe("The repaired change is ready.");
      expect((await at.service.merges.merge("ab12cd34")).ok).toBe(true);
      expect(at.putIn).toHaveBeenCalledWith(
        { ...at.forge.change, squashMessage: "The repaired change is ready." },
        repaired,
      );
      expect(at.tasks.delivery.changePresentation("ab12cd34")?.published).toEqual(published);
    });

    // The owned merge past the branch rules reads the same override (FI3-1571 piece 2).
    it.each(["task", "none", "taken back"] as const)(
      "reads the override on a merge past the branch rules: %s",
      async (scope) => {
        const at = await stale();
        if (scope !== "none") override(at, "task");
        const skipping = vi.fn(async (_change: ForgeChange, _head: string) => ({
          status: "merged" as const,
          sha: "5e1f0c9a",
        }));
        const changeFor = at.forge.changeFor.bind(at.forge);
        Object.assign(at.forge, {
          putInSkippingRules: skipping,
          pull: async () => ({
            number: 23,
            state: "open",
            merged: false,
            headSha: repaired,
            base: "main",
            branch: "fm/task-ab12cd34",
            headRepo: "x/y",
            title: "fix: ship it",
            readiness: "clean",
          }),
          // The last read before the send.
          changeFor: async (branch: string) => {
            if (scope === "taken back") seedDelivery(at.tasks, "ab12cd34", { override: undefined });
            return changeFor(branch);
          },
        });
        const review: MergeReview = {
          id: "mrskipstory1",
          kind: "github",
          host: "github.com",
          owner: "x",
          name: "y",
          number: 23,
          headSha: repaired,
          base: "main",
          branch: "fm/task-ab12cd34",
          method: "squash",
          title: "fix: ship it",
          skips: { rules: [], failedChecks: ["linux-checks"] },
          at: 1,
        };
        at.forge.states = ["failure"];
        seedDelivery(at.tasks, "ab12cd34", { mergeReviews: [review] });
        const outcome = await at.service.reviews.mergeReview("ab12cd34", review.id);
        if (scope === "task") {
          expect(outcome.ok).toBe(true);
          expect(skipping).toHaveBeenCalledWith(
            expect.objectContaining({
              headSha: repaired,
              squashMessage:
                "Keeps the merge moving.\n\nBREAKING CHANGE: The story hold reads the override.",
            }),
            repaired,
          );
          return;
        }
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain("must be published and read back");
        expect(outcome.text).toContain(softHoldWords("story", "firstmate"));
        expect(skipping).not.toHaveBeenCalled();
      },
    );

    it("holds a kept merge when the override is taken back during the last read before the send", async () => {
      const at = await stale();
      override(at, "task");
      Object.assign(at.forge, {
        pull: async () => {
          seedDelivery(at.tasks, "ab12cd34", { override: undefined });
          return {
            number: 23,
            state: "open",
            merged: false,
            headSha: repaired,
            base: "main",
            readiness: "clean",
          };
        },
      });
      const outcome = await at.service.merges.merge("ab12cd34", {
        head: repaired,
        prNumber: 23,
        unattended: true,
        beforeDispatch: () => undefined,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain("must be published and read back");
      expect(at.putIn).not.toHaveBeenCalled();
    });
  });

  // INF-497 (the captain on INF-100's PR #138): correct only the words around the story.
  it("corrects only the words around the published story through open_change (INF-497)", async () => {
    const at = await saved();
    const obsolete = "This first publication advances the published protocol to 9.0.0.";
    const corrected =
      "The published protocol advances to 10.0.0; every check on this version passed.";
    const footer = "BREAKING CHANGE: The published protocol advances to 10.0.0.";
    const region = at.forge.change?.body ?? "";
    at.forge.change = {
      ...(at.forge.change as ForgeChange),
      body: `${obsolete}\n\n${footer}\n\n${region}`,
    };
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(original);
    const same = await at.service.publication.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: obsolete },
    });
    expect(same).toContain("Nothing was sent");
    expect(at.update).not.toHaveBeenCalled();
    const said = await at.service.publication.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: corrected },
    });
    expect(said).toContain(
      "Changed the words around the story: GitHub shows them, and the story is as published.",
    );
    expect(at.forge.change?.body).toBe(`${corrected}\n\n${footer}\n\n${region}`);
    expect(at.update).toHaveBeenCalledTimes(1);
    // The same passage again is no longer there: nothing is sent, and the answer quotes the words.
    const stale = await at.service.publication.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 1,
      around: { from: obsolete, to: corrected },
    });
    expect(stale).toContain(`no longer hold around.from exactly`);
    expect(stale).toContain(corrected);
    expect(at.update).toHaveBeenCalledTimes(1);
  });

  // INF-717 (INF-100's PR #138 kept its old title): open_change says the rename, or the person's title.
  it("says the story's title once open_change renames the pull request, and a person's rename whole", async () => {
    const at = await saved();
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(original);
    const first: ChangePresentation = {
      ...at.story,
      version: 2,
      title: "fix: ship it",
      checked: [{ check: "Publication", result: "The story and the pull request agree." }],
    };
    const region = presentationMarkdown(first, new Map(), "passed");
    const published = {
      revision: 1,
      head: original,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      title: first.title,
      number: 23,
    };
    const breaking = "fix!: ship it";
    at.tasks.delivery.updateChangePresentation("ab12cd34", () => ({
      revisions: [first, { ...first, revision: 2, title: breaking }],
      receipts: [],
      publication: published,
      published,
    }));
    at.forge.change = { ...(at.forge.change as ForgeChange), body: region };
    const said = await at.service.publication.open("ab12cd34", {
      title: breaking,
      presentation: 2,
    });
    expect(said).toContain(`Its title now reads "${breaking}", the story's.`);
    expect(at.forge.change?.title).toBe(breaking);

    at.forge.change = { ...(at.forge.change as ForgeChange), title: "fix: ship it today" };
    at.tasks.delivery.updateChangePresentation("ab12cd34", (current) => ({
      ...current!,
      revisions: [...current!.revisions, { ...first, revision: 3, title: "fix: ship it" }],
    }));
    const refused = await at.service.publication.open("ab12cd34", {
      title: "fix: ship it",
      presentation: 3,
    });
    expect(refused).toBe(
      `Nothing was sent: the pull request's title on GitHub reads "fix: ship it today", not the story's "fix: ship it". The app last left "${breaking}" there, so someone renamed it. To keep that title, prepare the story with it and call open_change again. To use the story's title instead, ask the captain on a card first, then set the title alone with github_write and call open_change again.`,
    );
    expect(at.update).toHaveBeenCalledTimes(1);
  });

  // INF-125 and INF-497 had the final proof gate recheck here; since INF-1876
  // no host gate reads the proof, at any care: the open goes on and the
  // changed proof stays a recorded fact the reviewer reads.
  it.each(["story", "surroundings"] as const)(
    "publishes after %s preflight at any care; a changed proof is a recorded fact, not a hold (INF-1876)",
    async (mode) => {
      const at = await saved();
      at.tasks.placement.setDevice("ab12cd34", null);
      at.repos.configure(at.tasks.get("ab12cd34")!.repoId!, { rigor: "reviewed" });
      seedDelivery(at.tasks, "ab12cd34", {
        reviewVerdict: "pass",
        reviewSha: original,
        liveValidation: noSurfaceProof(original),
      });
      const title = "fix: explain the publication recovery";
      if (mode === "story")
        at.tasks.delivery.updateChangePresentation("ab12cd34", (current) => ({
          ...current!,
          revisions: [...current!.revisions, { ...at.story, revision: 2, title }],
        }));
      at.readHead.mockImplementation(async () => {
        seedDelivery(at.tasks, "ab12cd34", {
          liveValidation: { ...noSurfaceProof(original), reviews: [] },
        });
        return original;
      });
      expect(
        await at.service.publication.open("ab12cd34", {
          title,
          presentation: mode === "story" ? 2 : 1,
          ...(mode === "surroundings"
            ? { around: { from: "", to: "Keep the current reviewed proof." } }
            : {}),
        }),
      ).toContain("pull request #23");
      expect(at.update).toHaveBeenCalledTimes(1);
      expect(at.tasks.delivery.changePresentation("ab12cd34")?.published?.revision).toBe(
        mode === "story" ? 2 : 1,
      );
      expect(at.tasks.get("ab12cd34")?.delivery?.liveValidation?.reviews).toEqual([]);
    },
  );

  // INF-1793, the captain: "it's my intended design to have infinitary's careful rigor be counted
  // as no-mistakes in those PR enforcements". Since INF-1876 the records decide, not the care's
  // name: a passed review and accepted live proof at the version write the lines at any care.
  it.each(["reviewed", "standard"] as const)(
    "INF-1793: a %s story carries no-mistakes' attestation from the review and live proof at its version",
    async (rigor) => {
      const at = await saved();
      at.tasks.placement.setDevice("ab12cd34", null);
      at.repos.configure(at.tasks.get("ab12cd34")!.repoId!, { rigor });
      seedDelivery(at.tasks, "ab12cd34", {
        reviewVerdict: "pass",
        reviewSha: original,
        liveValidation: noSurfaceProof(original),
      });
      const title = "fix: explain the publication recovery";
      at.tasks.delivery.updateChangePresentation("ab12cd34", (current) => ({
        ...current!,
        revisions: [...current!.revisions, { ...at.story, revision: 2, title }],
      }));
      await at.service.publication.open("ab12cd34", { title, presentation: 2 });
      const body = at.forge.change?.body ?? "";
      expect(at.tasks.delivery.changePresentation("ab12cd34")?.published?.revision).toBe(2);
      expect(body).toContain(NO_MISTAKES_SIGNATURE);
      const start =
        body.indexOf(NO_MISTAKES_ATTESTATION_PREFIX) + NO_MISTAKES_ATTESTATION_PREFIX.length;
      expect(JSON.parse(body.slice(start, body.indexOf(" -->", start)))).toEqual({
        head_sha: original,
        steps: [
          { step: "review", status: "completed" },
          { step: "test", status: "completed" },
          { step: "document", status: "completed" },
        ],
        producer: "infinitary",
      });
    },
  );

  it("merges the published PR while its work computer is asleep and reads completion only once", async () => {
    const at = await saved();
    const completion = vi.spyOn(at.presentations, "completion");
    expect((await at.service.publication.completionPresentation("ab12cd34", 1)).title).toBe(
      "One saved story",
    );
    expect(completion).toHaveBeenCalledTimes(1);
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    at.readHead.mockClear();
    expect((await at.service.merges.merge("ab12cd34")).ok).toBe(true);
    expect(at.bringBranchHome).not.toHaveBeenCalled();
    expect(at.readHead).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledTimes(1);
  });

  // INF-961: INF-899 published its story, pushed three repairs, and stopped
  // when no completion card said how to show a story at the pushed version.
  // INF-2509, INF-1868's answer 5, the captain: "The host republishes the
  // declared story at the new head itself and refuses nothing; the merge
  // still carries the story you saw."
  it("republishes the published story when a push follows its publication (INF-961, INF-2509)", async () => {
    const at = await saved();
    at.bringBranchHome.mockResolvedValue("");
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: repaired };
    // The author vouches for the story at the code they committed, which must be the pushed version.
    const unpushed = "63fd25b591c30c1761c6d6c2d43e5b9585a9884e";
    at.readHead.mockResolvedValue(unpushed);
    const push = (committed: string, pushed: string, revision: number) =>
      `The current code changed before the merge card: the branch is at ${committed}, and the pushed branch at ${pushed}. Push it; the app republishes the published story at the pushed version. Then show the merge card again with presentation ${revision}.`;
    await expect(at.service.publication.completionPresentation("ab12cd34", 1)).rejects.toThrow(
      push(unpushed, repaired, 1),
    );
    expect(at.update).not.toHaveBeenCalled();

    at.readHead.mockResolvedValue(repaired);
    const shown = await at.service.publication.completionPresentation("ab12cd34", 1);
    expect(shown).toMatchObject({ title: "One saved story", revision: 2 });
    expect(shown.body).toContain(`demonstrated version ${repaired}`);
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(at.forge.change?.body).toContain(`demonstrated version ${repaired}`);
    expect(at.tasks.delivery.changePresentation("ab12cd34")?.published).toMatchObject({
      revision: 2,
      head: repaired,
      refreshOf: 1,
      contentHash: presentationContentHash(at.story),
    });
    // Either revision shows it again, with nothing sent again.
    expect((await at.service.publication.completionPresentation("ab12cd34", 1)).revision).toBe(2);
    expect((await at.service.publication.completionPresentation("ab12cd34", 2)).revision).toBe(2);
    expect(at.update).toHaveBeenCalledTimes(1);

    // A newer story its author prepared is theirs to publish.
    at.tasks.delivery.updateChangePresentation("ab12cd34", (record) => ({
      ...record!,
      revisions: [...record!.revisions, { ...at.story, revision: 3, head: repaired }],
    }));
    await expect(at.service.publication.completionPresentation("ab12cd34", 3)).rejects.toThrow(
      "Story revision 3 is prepared at the pushed version but not yet published and read back: publish it with open_change, then show the merge card with presentation 3.",
    );
    // The merge path's words reach the captain, so they name no tool.
    await expect(
      at.presentations.assertPublished("ab12cd34", at.forge.change as ForgeChange, at.forge),
    ).rejects.toThrow(
      /^The current story and all evidence must be published and read back before the merge card or merge\.$/,
    );
    await at.service.publication.open("ab12cd34", {
      title: "fix: keep the saved story",
      presentation: 3,
    });
    await expect(at.service.publication.completionPresentation("ab12cd34", 1)).rejects.toThrow(
      "The newest story is revision 3: show the merge card with presentation 3.",
    );
    expect((await at.service.publication.completionPresentation("ab12cd34", 3)).revision).toBe(3);

    // A commit not yet pushed is named with the way out.
    at.readHead.mockResolvedValue(unpushed);
    await expect(at.service.publication.completionPresentation("ab12cd34", 3)).rejects.toThrow(
      push(unpushed, repaired, 3),
    );

    // A story prepared at an earlier version and never published is not the host's to republish.
    at.tasks.delivery.updateChangePresentation("ab12cd34", (record) => ({
      ...record!,
      revisions: [...record!.revisions, { ...at.story, revision: 4, head: repaired }],
    }));
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: unpushed };
    await expect(at.service.publication.completionPresentation("ab12cd34", 4)).rejects.toThrow(
      `Story revision 4 was prepared at ${repaired} and never published, and the pushed branch is now at ${unpushed}. Prepare a new story revision at the pushed version with prepare_change, keeping its base and title, publish it with open_change, then show the merge card with the revision prepare_change returns as presentation.`,
    );
  });

  it("republishes a story a push left behind before a merge with no kept approval (INF-2509)", async () => {
    const at = await saved();
    const putIn = vi.spyOn(at.forge, "putIn");
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: repaired };
    // The pushed branch is what merges, wherever its commits were made.
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    const outcome = await at.service.merges.merge("ab12cd34");
    expect(outcome.ok).toBe(true);
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(putIn).toHaveBeenCalledWith(
      { ...at.forge.change, squashMessage: presentationCommitMessage(at.story) },
      repaired,
    );
    expect(putIn.mock.calls[0]?.[0].body).toContain(`demonstrated version ${repaired}`);
    expect(at.tasks.delivery.changePresentation("ab12cd34")?.published).toMatchObject({
      revision: 2,
      head: repaired,
      refreshOf: 1,
    });
    expect(at.readHead).not.toHaveBeenCalled();
  });

  it("automatically republishes the unchanged story before a kept merge of an accepted repair", async () => {
    const at = await saved();
    const putIn = vi.spyOn(at.forge, "putIn");
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: repaired };
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    const authorization: MergeAuthorization = {
      version: 1,
      id: "approved-story",
      generation: 2,
      issuer: "captain",
      at: 1,
      card: { id: "approved-card", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: at.tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: original,
      proceedWithOpen: false,
      status: "standing",
      lineage: [
        {
          fromHead: original,
          toHead: repaired,
          newBase: original,
          impact: "none",
          changedPaths: [],
          evidence: "The accepted repair preserves behavior.",
          validation: "The affected checks passed.",
          generation: 2,
          at: 2,
        },
      ],
    };
    seedDelivery(at.tasks, "ab12cd34", {
      mergeAuthorization: authorization,
      completionOffers: [
        {
          cardId: "approved-card",
          offerId: "offer-1",
          headSha: original,
          prNumber: 23,
          at: 1,
          presentationRevision: 1,
          presentationContentHash:
            at.tasks.delivery.changePresentation("ab12cd34")?.published?.contentHash,
        },
      ],
    });
    const outcome = await at.service.merges.merge("ab12cd34", {
      head: repaired,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(outcome.ok).toBe(true);
    expect(at.update).toHaveBeenCalledTimes(1);
    // INF-169 R2 / INF-228 F2: the current description and its plain squash summary travel together.
    expect(putIn).toHaveBeenCalledWith(
      { ...at.forge.change, squashMessage: presentationCommitMessage(at.story) },
      repaired,
    );
    expect(putIn.mock.calls[0]?.[0].body).toContain(`demonstrated version ${repaired}`);
    expect(putIn.mock.calls[0]?.[0].body).not.toContain(`demonstrated version ${original}`);
    expect(at.tasks.delivery.changePresentation("ab12cd34")?.published).toMatchObject({
      revision: 2,
      head: repaired,
    });
    expect(at.bringBranchHome).not.toHaveBeenCalled();
    expect(at.readHead).not.toHaveBeenCalled();
    // INF-3623 (captain: "all non-code changes to the PR should keep my approval"), in
    // PR #1450's order: a story the crewmate revised after the click, at the same code,
    // merges under the kept approval as the newest story, noted once on the record.
    const current = at.tasks.delivery
      .changePresentation("ab12cd34")
      ?.revisions.at(-1) as ChangePresentation;
    at.readHead.mockResolvedValue(repaired);
    const revision = await at.presentations.prepare(
      "ab12cd34",
      { ...current, after: ["A different account of the work."] },
      at.forge,
    );
    await at.presentations.publish(
      "ab12cd34",
      revision,
      at.forge,
      "fm/task-ab12cd34",
      "fix: ship it",
    );
    const kept = await at.service.merges.merge("ab12cd34", {
      head: repaired,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(kept.ok).toBe(true);
    const newest = at.tasks.delivery
      .changePresentation("ab12cd34")
      ?.revisions.at(-1) as ChangePresentation;
    expect(newest.after).toEqual(["A different account of the work."]);
    expect(putIn).toHaveBeenCalledTimes(2);
    expect(putIn.mock.calls[1]?.[0].squashMessage).toBe(presentationCommitMessage(newest));
    expect(
      at.tasks
        .timeline("ab12cd34")
        .filter((event) => event.data?.storyChangedAfterClick !== undefined),
    ).toHaveLength(1);
  });

  // INF-2546 R9, under the captain's kept approval (FI3-304) and "others
  // merge as continuing": a request_merge approval of the task's own pull
  // request keeps the completion approval's repair path, so an accepted
  // unchanged repair republishes the unchanged story and the continuing
  // merge goes on at the repaired version.
  it("republishes the unchanged story before a kept continuing merge of an accepted repair (INF-2546)", async () => {
    const at = await saved();
    at.repos.configure(at.tasks.get("ab12cd34")?.repoId as string, {
      origin: "https://github.com/x/y.git",
    });
    const putIn = vi.spyOn(at.forge, "putIn");
    at.forge.change = { ...(at.forge.change as ForgeChange), headSha: repaired };
    at.readHead.mockRejectedValue(new Error("Work computer is asleep"));
    Object.assign(at.forge, {
      pull: async () => ({
        number: 23,
        state: "open",
        merged: false,
        headSha: at.forge.change?.headSha,
        base: "main",
        branch: "fm/task-ab12cd34",
        headRepo: "x/y",
        title: "fix: ship it",
        readiness: "clean",
      }),
    });
    const review: MergeReview = {
      id: "mrown23story",
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 23,
      headSha: original,
      base: "main",
      branch: "fm/task-ab12cd34",
      method: "squash",
      title: "fix: ship it",
      at: 1,
    };
    const authorization: MergeAuthorization = {
      version: 1,
      id: "approved-continuing",
      generation: 2,
      issuer: "captain",
      at: 1,
      card: { id: "continue-card", offerId: "offer-c", actionId: "merge" },
      review,
      target: {
        repoId: at.tasks.get("ab12cd34")?.repoId as string,
        host: "github.com",
        owner: "x",
        name: "y",
        prNumber: 23,
        branch: "fm/task-ab12cd34",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: original,
      proceedWithOpen: false,
      status: "standing",
      lineage: [
        {
          fromHead: original,
          toHead: repaired,
          newBase: original,
          impact: "none",
          changedPaths: [],
          evidence: "The accepted repair preserves behavior.",
          validation: "The affected checks passed.",
          generation: 2,
          at: 2,
        },
      ],
    };
    seedDelivery(at.tasks, "ab12cd34", {
      mergeReviews: [review],
      mergeAuthorization: authorization,
    });
    const outcome = await at.service.reviews.mergeReview("ab12cd34", review.id, {
      head: repaired,
      prNumber: 23,
      unattended: true,
      beforeDispatch: () => undefined,
    });
    expect(outcome).toMatchObject({ ok: true, receipt: { head: repaired } });
    expect(at.update).toHaveBeenCalledTimes(1);
    expect(putIn).toHaveBeenCalledTimes(1);
    expect(putIn.mock.calls[0]?.[0]).toMatchObject({
      squashMessage: presentationCommitMessage(at.story),
    });
    expect(putIn.mock.calls[0]?.[1]).toBe(repaired);
    expect(putIn.mock.calls[0]?.[0].body).toContain(`demonstrated version ${repaired}`);
    expect(at.tasks.delivery.changePresentation("ab12cd34")?.published).toMatchObject({
      revision: 2,
      head: repaired,
    });
  });

  // INF-2546 R2, under the captain's "several changes per task, one per
  // PR" and the list of every pull request on the task: each change keeps
  // its own story, so a story prepared for another pull request starts its
  // own ledger, leaves the task's published story as it was, and the own
  // merge reads its own story.
  it("keeps each change's own story: one prepared for another pull request leaves the published one as it was, and the own merge reads its own (INF-2546)", async () => {
    const at = await saved();
    const own = at.tasks.delivery.changePresentation("ab12cd34");
    expect(own).toMatchObject({ branch: "fm/task-ab12cd34", published: { number: 23 } });
    const release: MergeReview = {
      id: "mrrelease57",
      kind: "github",
      host: "github.com",
      owner: "x",
      name: "y",
      number: 57,
      headSha: repaired,
      base: "main",
      branch: "release-please--branches--main",
      method: "squash",
      title: "chore(main): release 0.2.0",
      at: 2,
    };
    // check_change(pull) makes the release pull request the current change.
    seedDelivery(at.tasks, "ab12cd34", {
      mergeReviews: [release],
      checkTarget: release,
      prNumber: 57,
    });
    expect(at.tasks.delivery.changePresentation("ab12cd34")).toBeUndefined();
    expect(at.tasks.delivery.changePresentation("ab12cd34", "fm/task-ab12cd34")).toEqual(own);
    // Its story starts at its own first revision, in its own ledger.
    at.readHead.mockResolvedValueOnce(repaired);
    const revision = await at.presentations.prepare(
      "ab12cd34",
      { ...at.story, head: repaired, title: "chore(main): release 0.2.0" },
      at.forge,
    );
    expect(revision).toBe(1);
    const releaseStory = at.tasks.delivery.changePresentation("ab12cd34");
    expect(releaseStory).toMatchObject({ branch: release.branch, revisions: [{ revision: 1 }] });
    expect(releaseStory?.published).toBeUndefined();
    expect(at.tasks.delivery.changePresentation("ab12cd34", "fm/task-ab12cd34")).toEqual(own);
    // The own change current again: its story is back where older readers read it.
    seedDelivery(at.tasks, "ab12cd34", { checkTarget: undefined, prNumber: 23 });
    expect(at.tasks.get("ab12cd34")?.delivery).toMatchObject({
      presentation: own,
      presentations: [releaseStory],
    });
    const putIn = vi.spyOn(at.forge, "putIn");
    const merged = await at.service.merges.merge("ab12cd34");
    expect(merged.ok).toBe(true);
    expect(putIn.mock.calls[0]?.[0]).toMatchObject({
      squashMessage: presentationCommitMessage(at.story),
    });
  });

  it("does not attach a saved-story hold to an existing unrecorded legacy PR", async () => {
    const at = await saved();
    const story = at.tasks.delivery.changePresentation("ab12cd34")
      ?.revisions[0] as ChangePresentation;
    seedDelivery(at.tasks, "ab12cd34", { presentation: undefined, prNumber: undefined });
    expect(await at.service.publication.preparePresentation("ab12cd34", story)).toContain(
      "predates saved stories",
    );
    expect(at.tasks.delivery.changePresentation("ab12cd34")).toBeUndefined();
  });

  it("starts a saved story when the recorded pre-story PR has closed (INF-92 F1, captain's choice)", async () => {
    const at = await saved();
    const story = at.tasks.delivery.changePresentation("ab12cd34")
      ?.revisions[0] as ChangePresentation;
    seedDelivery(at.tasks, "ab12cd34", { presentation: undefined, prNumber: 23 });
    const open = at.forge.change;
    let body = "";
    at.forge.change = null;
    Object.assign(at.forge, {
      branchHead: async () => story.head,
      openChange: async (input: { branch: string; title: string; body: string }) => {
        at.forge.calls.push(`openChange ${input.branch} ${input.title}`);
        body = input.body;
        at.forge.change = {
          ...at.forge.opened,
          branch: input.branch,
          body: input.body,
          headSha: story.head,
        };
        return at.forge.change;
      },
      pull: async () => ({ number: 23, state: "closed", merged: false, base: "main" }),
    });
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    const said = await at.service.publication.preparePresentation("ab12cd34", story);
    expect(said).toContain("Prepared presentation");
    expect(said).not.toContain("predates");
    const revision = Number(/Prepared presentation (\d+)/.exec(said)?.[1]);
    const opened = await at.service.publication.open("ab12cd34", {
      title: "feat: share the story",
      presentation: revision,
    });
    expect(opened).toContain("Opened");
    expect(at.forge.calls).toContain("openChange fm/task-ab12cd34 feat: share the story");
    const delivery = at.tasks.get("ab12cd34")?.delivery;
    expect(body).toContain("infinitary-story:ab12cd34:start");
    expect(delivery?.prNumber).toBe(at.forge.opened.number);
    expect(delivery?.prNumber).not.toBe(23);
    expect(delivery?.changeLabel).not.toContain("23");
    // An open pull request for the branch is still a legacy one.
    seedDelivery(at.tasks, "ab12cd34", { presentation: undefined });
    at.forge.change = open;
    expect(await at.service.publication.preparePresentation("ab12cd34", story)).toContain(
      "predates saved stories",
    );
  });

  it.each([
    ["public", "is public: anyone can read this story"],
    [
      "private",
      "is private: everyone with access can read this story, and the project can turn public",
    ],
  ] as const)(
    "tells the crewmate who reads a story prepared for a %s project (INF-2142's approved plan)",
    async (visibility, said) => {
      const at = await saved();
      const story = at.tasks.delivery.changePresentation("ab12cd34")
        ?.revisions[0] as ChangePresentation;
      seedDelivery(at.tasks, "ab12cd34", { presentation: undefined, prNumber: undefined });
      at.forge.change = null;
      const hosted = story.destination as HostedPresentationDestination;
      const destination = { ...hosted, visibility };
      Object.assign(at.forge, {
        attachments: {
          destination: async () => destination,
          upload: async () => {
            throw new Error("No upload expected");
          },
        },
      });
      at.readHead.mockResolvedValue(story.head);
      const answer = await at.service.publication.preparePresentation("ab12cd34", story);
      expect(answer).toContain("Prepared presentation");
      expect(answer).toContain(`${hosted.fullName} ${said}`);
    },
  );

  // Re-review INF-2587 U2, under INF-2142's approved plan (the crewmate is
  // told who reads a story) and the captain's "several changes per task, one
  // per PR": a story prepared while the working copy has another branch
  // checked out goes to that branch's own ledger, and the crewmate is told
  // its audience from that ledger's revision, never from the task's own
  // story's revision of the same number.
  it("tells the crewmate who reads a story prepared for the checked-out branch from that branch's own ledger (INF-2587)", async () => {
    const otherBranch = "reading-fix";
    const at = await saved("github", async () => ({ branch: otherBranch, head: original }));
    const own = at.tasks.delivery.changePresentation("ab12cd34");
    const story = own?.revisions[0] as ChangePresentation;
    const hosted = story.destination as HostedPresentationDestination;
    expect(hosted.visibility).toBe("public");
    // The project is private now; reading-fix has no pull request yet.
    const destination = { ...hosted, visibility: "private" as const };
    Object.assign(at.forge, {
      attachments: {
        destination: async () => destination,
        upload: async () => {
          throw new Error("No upload expected");
        },
      },
    });
    at.forge.change = null;
    at.readHead.mockResolvedValue(story.head);
    const answer = await at.service.publication.preparePresentation("ab12cd34", story);
    expect(answer).toContain("Prepared presentation 1 ");
    expect(answer).toContain(
      `${hosted.fullName} is private: everyone with access can read this story`,
    );
    expect(answer).not.toContain("anyone can read this story");
    // The revision went to reading-fix's own ledger; the task's own story is as it was.
    expect(at.tasks.delivery.changePresentation("ab12cd34", otherBranch)?.revisions).toMatchObject([
      { revision: 1, destination },
    ]);
    expect(at.tasks.delivery.changePresentation("ab12cd34", "fm/task-ab12cd34")).toEqual(own);
  });

  it("stops, opening nothing, when the recorded pre-story PR merged outside the app (INF-92 F3)", async () => {
    const at = await saved();
    const story = at.tasks.delivery.changePresentation("ab12cd34")
      ?.revisions[0] as ChangePresentation;
    seedDelivery(at.tasks, "ab12cd34", { presentation: undefined, prNumber: 23 });
    at.forge.change = null;
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: true, base: "main" }),
    });
    expect(await at.service.publication.preparePresentation("ab12cd34", story)).toContain(
      "merged outside",
    );
    const opened = await at.service.publication.open("ab12cd34", {
      title: "feat: share the story",
      presentation: 1,
    });
    expect(opened).toContain("merged outside");
    expect(at.forge.calls.some((call) => call.startsWith("openChange"))).toBe(false);
  });

  it("fails closed when the recorded pre-story PR cannot be read, and when it merges between prepare and open (INF-292 F5, F6)", async () => {
    const at = await saved();
    const story = at.tasks.delivery.changePresentation("ab12cd34")
      ?.revisions[0] as ChangePresentation;
    seedDelivery(at.tasks, "ab12cd34", { presentation: undefined, prNumber: 23 });
    at.forge.change = null;
    at.bringBranchHome.mockResolvedValue("");
    at.readHead.mockResolvedValue(story.head);
    Object.assign(at.forge, { branchHead: async () => story.head });
    Object.assign(at.forge, {
      pull: async () => {
        throw new Error("GitHub is unreachable");
      },
    });
    const refused = await at.service.publication.preparePresentation("ab12cd34", story);
    expect(refused).toContain("Could not prepare the change story");
    expect(at.tasks.get("ab12cd34")?.delivery?.presentation).toBeUndefined();
    // Read fine at prepare, merged before open: the unpublished story opens nothing.
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: false, base: "main" }),
    });
    const said = await at.service.publication.preparePresentation("ab12cd34", story);
    const revision = Number(/Prepared presentation (\d+)/.exec(said)?.[1]);
    Object.assign(at.forge, {
      pull: async () => ({ number: 23, state: "closed", merged: true, base: "main" }),
    });
    const opened = await at.service.publication.open("ab12cd34", {
      title: "feat: share the story",
      presentation: revision,
    });
    expect(opened).toContain("merged outside");
    expect(at.forge.calls.some((call) => call.startsWith("openChange"))).toBe(false);
  });

  it.each(["missing task", "unsupported host", "recorded legacy", "unrecorded legacy"])(
    "cleans staged copies when preparation refuses %s (INF-169 R4)",
    async (reason) => {
      const at = await saved();
      const story = at.tasks.delivery.changePresentation("ab12cd34")
        ?.revisions[0] as ChangePresentation;
      seedDelivery(at.tasks, "ab12cd34", {
        presentation: undefined,
        prNumber: reason === "unrecorded legacy" ? undefined : 23,
      });
      const taskId = reason === "missing task" ? "missing-task" : "ab12cd34";
      const path = "release-notes/pictures/action-reply-line-dark.webp";
      const staged = await stageChangePresentation(
        {
          title: story.title,
          base: story.base,
          head: story.head,
          publishable: true,
          why: story.why,
          whatChanged: story.whatChanged,
          before: story.before,
          after: story.after,
          checked: [{ check: "Retained evidence", result: "The reply picture is selected." }],
          verification: story.verification,
          risk: story.risk,
          requiredActions: [],
          unfinished: [],
          views: [
            {
              id: "picture",
              kind: "new",
              caption: "The reply view",
              before: [],
              after: [
                { path, alt: "The dark reply view", inspected: true, captureHead: story.head },
              ],
            },
          ],
        },
        { taskId, worktree: process.cwd(), dir: at.paths },
      );
      if (reason === "unsupported host") Object.assign(at.forge, { attachments: undefined });
      expect(await at.service.publication.preparePresentation(taskId, staged)).not.toContain(
        "Prepared presentation",
      );
      expect(staged.assets.every((asset) => !existsSync(join(at.paths, asset.file)))).toBe(true);
      expect(existsSync(path)).toBe(true);
    },
  );

  it("ignores downloaded untracked evidence but still refuses tracked edits before preparation", async () => {
    const at = setup();
    const { repo } = await at.repos.setup({ kind: "init", name: "head-check" });
    insertTask(at.tasks, { repoId: repo.id, repoDir: repo.path, worktreeDir: repo.path });
    const dir = repo.path;
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args])
        .toString()
        .trim();
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("checkout", "-b", "fm/task-ab12cd34");
    writeFileSync(join(dir, "tracked.txt"), "Recorded fixture\n");
    run("add", "tracked.txt");
    run("commit", "-m", "test: record a fixture");
    mkdirSync(join(dir, ".infinitary-artifacts"));
    writeFileSync(
      join(dir, ".infinitary-artifacts", "empty.zip"),
      Buffer.from("504b05060000000000000000000000000000000000000000", "hex"),
    );
    expect(await at.service.publication.presentationHead("ab12cd34")).toBe(
      run("rev-parse", "HEAD"),
    );
    writeFileSync(join(dir, "tracked.txt"), "An uncommitted change\n");
    await expect(at.service.publication.presentationHead("ab12cd34")).rejects.toThrow(
      "Commit the task's changes",
    );
  });
});
