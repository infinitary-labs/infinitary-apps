/**
 * The captain's kept merge approval (FI3-304) as the settle owners hold
 * it: a continued pull request's live checks, the merge card's words while
 * the checks run, the first mate's closing note on a merge, care raised from
 * the merge card, an abandoned attempt's pull request closed, and task-level
 * autonomy with the host's merge hold.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */

import { createHash } from "node:crypto";
import type { Card } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { softHoldWords } from "@shared/holds";
import type { MergeReview } from "@shared/mergeReview";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { CHECK_WORDS, MERGE_WORDS, REVIEW_CAREFULLY_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import careCarefulGuide from "../../../resources/runbooks/care/careful.json" with { type: "json" };
import {
  askedOn,
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  SETTLE_MERGE,
  settleLines,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  editPolicies,
  FILED_GOAL,
  gitRepo,
  kept,
  REPAIRED,
  repair,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  type Forge,
  type ForgeChange,
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  presentationCommitMessage,
  presentationContentHash,
  presentationMarkdown,
} from "../forge";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { type ChangeDelivery, createChangeDelivery } from "./changeDelivery";
import { COMPLETION_REVISED_WHILE_RUNNING } from "./crewmateCards";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisor } from "./crewSupervisor";
import { NO_RECORDED_WORDS_LEAD } from "./intentBrief";
import { keptApprovalLine, keptFeedLine } from "./mergeAuthorization";
import { POLICY_GUIDANCE_HEADING } from "./noticeWakes";
import { closingNoteTitle } from "./settleWords";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  /** A direct-pr task with its open pull request #9 on GitHub. */
  async function withOpenPullRequest() {
    const crewmate = fakeCrewmate();
    const change: ForgeChange = { number: 9, branch: "", headSha: "abc", url: null };
    const forge = {
      kind: "github",
      host: "github.com",
      place: "GitHub",
      hasChecks: true,
      changeFor: vi.fn(async (branch: string) => ({ ...change, branch })),
      close: vi.fn(async () => {}),
      label: () => "#9",
      url: () => null,
    } as unknown as Forge;
    let delivery: ChangeDelivery;
    const closePullRequest = vi.fn((id: string) => delivery.merges.close(id));
    const at = setup(crewmate, { closePullRequest });
    const { supervisor, tasks, repos } = at;
    delivery = createChangeDelivery({ tasks, repos, forgeFor: () => forge });
    const { repo } = await repos.setup({ kind: "init", name: "abandoned" });
    repos.configure(repo.id, { delivery: "direct-pr" });
    const { taskId } = await supervisor.intake.commission({
      title: "Abandoned attempt",
      intent: intentOf("fix the meter"),
      repoId: repo.id,
    });
    seedDelivery(tasks, taskId, { prNumber: 9 });
    await tick();
    return { ...at, crewmate, forge, closePullRequest, taskId };
  }

  it.each(["rework", "cancel-idle", "cancel-running"] as const)(
    "closes an abandoned direct-pr attempt's PR on %s and records the outcome",
    async (path) => {
      const { supervisor, tasks, workspace, crewmate, forge, closePullRequest, taskId } =
        await withOpenPullRequest();
      if (path === "rework" || path === "cancel-idle") {
        crewmate.finishPrompt();
        await tick();
      }
      if (path === "rework") {
        await supervisor.intake.commission({
          title: "Fresh attempt",
          intent: intentOf("try a stronger model"),
          shape: { escalate_from: tasks.get(taskId)?.key },
        });
      } else {
        await supervisor.sessions.interruptCrewmate(taskId, "cancel");
        if (path === "cancel-running") crewmate.failPrompt("aborted");
      }
      await tick();
      expect(closePullRequest).toHaveBeenCalledExactlyOnceWith(taskId);
      expect(forge.close).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ number: 9, branch: tasks.get(taskId)?.branch }),
      );
      expect(tasks.get(taskId)).toMatchObject({
        status: "dropped",
        closedReason: path === "rework" ? "superseded" : "cancelled",
      });
      expect(tasks.timeline(taskId)).toContainEqual(
        expect.objectContaining({ text: "Closed PR #9 on GitHub." }),
      );
      expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
      );
    },
  );

  // A behind work computer's next turn failed and closed its task, and the
  // close took the task's open pull request with it (INF-5442 behavior 2): a
  // failure closes the task but leaves its pull request open where the
  // project lives, for the captain to merge, close or carry on.
  it("keeps a failed direct-pr task's PR open where the project lives", async () => {
    const { tasks, workspace, crewmate, forge, closePullRequest, taskId } =
      await withOpenPullRequest();
    crewmate.failPrompt("The client exited.");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "failed" });
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(forge.close).not.toHaveBeenCalled();
    expect(tasks.timeline(taskId).map((event) => event.text)).not.toContain(
      "Closed PR #9 on GitHub.",
    );
    expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
  });

  describe("the captain's kept merge approval (FI3-304)", () => {
    // INF-1246: a continued pull request has live check facts, and its one
    // chrome click survives a conflict only for the declared unchanged work.
    async function continued() {
      const h = await approved({ referenced: true });
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
        prNumber: 7,
        ci: "green",
        headSha: APPROVED,
      });
      expect(h.authorization()).toBeUndefined();
      expect(h.forge.merges).toEqual([]);
      h.forge.readiness = "conflict";
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("conflict"));
      expect(h.authorization()?.guidance).toBeUndefined();
      h.forge.readiness = "clean";
      return h;
    }

    it("INF-1246 follows a continued PR's current checks and merges its accepted repair once without closing the task", async () => {
      const h = await continued();
      h.forge.headSha = REPAIRED;
      h.forge.states = ["pending"];
      expect(await h.declare(repair("none"))).toContain("Repair accepted");
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
        prNumber: 7,
        ci: "pending",
        headSha: REPAIRED,
        ciWatch: { head: REPAIRED },
      });
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("checks"));
      expect(h.forge.merges).toEqual([]);
      h.forge.states = ["success"];
      expect(await h.checkService.checks.readWatched(h.taskId)).toMatchObject({
        kind: "finished",
        head: REPAIRED,
      });
      await repairTurn(h, async () => {});
      await vi.waitFor(() => expect(h.authorization()?.status).toBe("consumed"));
      expect(h.forge.merges).toEqual([REPAIRED]);
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
      expect(h.crewmate.promptCalls.join("\n")).toContain("The task stays open");
    });

    it("INF-1246 keeps an undeclared moved head unmerged and ends approval when the repair changes work", async () => {
      const h = await continued();
      h.forge.headSha = REPAIRED;
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("repair"));
      expect(h.forge.merges).toEqual([]);
      await repairTurn(h, async () => {
        await h.declare(repair("changed-work"));
      });
      expect(h.authorization()).toMatchObject({ status: "invalidated", holds: true });
      expect(h.forge.merges).toEqual([]);
    });

    it("INF-1246 newer captain guidance holds a continued merge until its impact is declared", async () => {
      const h = await continued();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Keep the same approved work", "captain");
      expect(h.authorization()?.guidance).toMatchObject({ latest: 1, declared: 0 });
      h.forge.headSha = REPAIRED;
      await h.declare(repair("none"));
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("guidance"));
      expect(h.forge.merges).toEqual([]);
      await repairTurn(h, async () => {
        await h.declare({
          captainGuidance: {
            mark: 1,
            impact: "none",
            evidence: "The captain asks for the same work.",
          },
        });
      });
      await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED]));
    });

    it("INF-1246 resumes a continued approval after restart without depending on the capped review list", async () => {
      const h = await continued();
      h.forge.headSha = REPAIRED;
      h.forge.states = ["pending"];
      await h.declare(repair("none"));
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("checks"));
      await h.supervisor.disposeAll();
      seedDelivery(h.tasks, h.taskId, { mergeReviews: [] });
      h.forge.states = ["success"];
      const tasks = new TaskService({ db: h.db, strict: true });
      const delivery = createChangeDelivery({ tasks, repos: h.repos, forgeFor: () => h.forge });
      const resumed = fakeCrewmate();
      const supervisor = reboot(
        { paths: h.paths, db: h.db, workspace: h.workspace },
        vi.fn(async () => resumed),
        {
          repos: h.repos,
          tasks,
          mergeReview: (id, review, guard) => delivery.reviews.mergeReview(id, review, guard),
          readPull: (id, number) => delivery.merges.pullState(id, number),
        },
      );
      supervisor.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
      await vi.waitFor(() =>
        expect(tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
      );
      expect(h.forge.merges).toEqual([REPAIRED]);
      expect(tasks.get(h.taskId)?.status).toBe("active");
      resumed.finishPrompt();
      await tick();
      expect(h.forge.merges).toHaveLength(1);
      await supervisor.disposeAll();
    });

    // INF-4018: a repeat merge card at the version the captain approved
    // would only have ended that approval, so it is refused and the
    // approval stands, with nothing written or removed.
    it("refuses a referenced merge offer at the version the kept approval covers, and keeps the approval", async () => {
      const h = await continued();
      const before = h.authorization();
      await expect(Promise.resolve().then(() => h.emit("Read the merge again"))).rejects.toThrow(
        `The captain's merge approval is kept and covers ${APPROVED}`,
      );
      expect(h.authorization()).toMatchObject({
        status: "standing",
        id: before?.id,
        generation: before?.generation,
      });
      expect(h.authorization()?.queueRemovals).toBeUndefined();
      expect(h.cards().some((card) => card.title === "Read the merge again")).toBe(false);
    });

    it("INF-1246 a project change during the last check cannot redirect the approved merge", async () => {
      const h = await continued();
      h.forge.duringChecks = () =>
        h.repos.configure(h.tasks.get(h.taskId)!.repoId!, {
          origin: "https://github.com/o/another.git",
        });
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.authorization()?.status).toBe("invalidated"));
      expect(h.forge.merges).toEqual([]);
    });

    it("INF-1246 keeps an unknown requested-merge outcome distinct from a refusal", async () => {
      const h = await approved({ referenced: true });
      h.forge.refuse = new ForgeError("transient", "The merge response was lost");
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      await tick();
      expect(h.authorization()?.attempt?.head).toBe(APPROVED);
      expect(h.forge.sends).toBe(1);
      expect(h.crewmate.promptCalls.at(-1)).toContain("is unknown");
      expect(h.crewmate.promptCalls.at(-1)).not.toContain("Nothing was merged");
      await h.supervisor.disposeAll();
    });

    it("INF-1246 a late watch reading cannot overwrite a newer selected pull request", async () => {
      const h = await approved({ referenced: true });
      const target = h.tasks.get(h.taskId)?.delivery?.checkTarget;
      if (!target) throw new Error("Missing selected review");
      h.forge.states = ["failure"];
      h.forge.duringChecks = () =>
        seedDelivery(h.tasks, h.taskId, {
          checkTarget: { ...target, id: "new-review", number: 8, branch: "fm/task-next" },
          prNumber: 8,
          headSha: REPAIRED,
          ci: "green",
        });
      expect(await h.checkService.checks.readWatched(h.taskId)).toMatchObject({ kind: "failed" });
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
        prNumber: 8,
        headSha: REPAIRED,
        ci: "green",
      });
    });

    /**
     * The kept click (INF-23), with captain F1/F12's separate readiness:
     * pending readiness reads Merge when ready, an explicit red judgment
     * keeps his Merge after fixing errors, and ready reads Merge the pull request.
     * The scripted crew supplies those judgments for the controlled check states;
     * neither the caption nor the kept feed attributes its judgment to the checks.
     */
    it("names the merge for what a click does while the checks run or have failed, and merges once they pass", async () => {
      const h = await approved();
      const label = () =>
        h
          .cards()
          .find((card) => card.id === h.card.id)
          ?.actions.find((action) => action.effect?.kind === "merge" && !action.passes)?.label;
      expect(label()).toBe(MERGE_WORDS["merge-pr"]);
      const readings: [ForgeCheckState[], string][] = [
        [["failure"], MERGE_WORDS.afterFixing],
        [["success", "pending"], MERGE_WORDS.whenChecksPass],
        [["success"], MERGE_WORDS["merge-pr"]],
        [["failure"], MERGE_WORDS.afterFixing],
      ];
      for (const [states, words] of readings) {
        // The crewmate reads its checks: the record, and the card with it.
        h.forge.states = states;
        await h.declare({});
        await vi.waitFor(() => expect(label()).toBe(words));
      }

      // The click on failed checks merges nothing now, keeps the approval and says it waits for a fix.
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      expect(h.forge.merges).toEqual([]);
      expect(settleLines(h.tasks, h.taskId)).toContain(keptFeedLine("checks", "GitHub", "red"));
      // They pass on this version, and the next idle boundary merges it with no second click.
      await repairTurn(h, async () => {
        h.forge.states = ["success"];
      });
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    });

    // The independent review of PR #1673 (INF-4018): the check watch sends
    // no wake once every check passed at the approved version, and that
    // wake's turn was what ran the kept merge, so the watch runs it: a click
    // on running checks merges when they pass, with no turn of the crewmate's.
    it("runs the kept merge when the watch finds the checks passed at the approved version", async () => {
      const h = await approved({ checkWatch: true });
      h.forge.states = ["success", "pending"];
      await h.declare({});
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      await vi.waitFor(() => expect(h.supervisor.settling.locks.holder(h.taskId)).toBeUndefined());
      const prompts = h.crewmate.promptCalls.length;
      h.forge.states = ["success"];
      await h.supervisor.watch.pollCheckWatches(Date.now() + 60_000);
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      expect(h.crewmate.promptCalls.slice(prompts).join("\n")).not.toContain(
        "offer its merge when ready",
      );
    });

    // The saved story of a kept merge's card (INF-3623, INF-3799): the app's
    // own story service holds it, published on #7 at the approved version.
    const destination = {
      host: "github.com",
      projectId: 7,
      fullName: "o/r",
      visibility: "private" as const,
    };
    const story = (
      taskId: string,
      revision: number,
      whatChanged: string[],
    ): ChangePresentation => ({
      version: 1,
      taskId,
      revision,
      destination,
      title: "Ready to merge",
      base: APPROVED,
      head: APPROVED,
      why: ["The meter dropped readings."],
      whatChanged,
      before: ["A reading could be lost."],
      after: ["Every reading is kept."],
      views: [],
      noPicture: "This changes how readings are kept, not a view.",
      verification: ["The meter tests passed."],
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "A meter fix." }]),
      ) as RiskDeclaration,
      requiredActions: [],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    });
    const published = (shown: ChangePresentation) => {
      const region = presentationMarkdown(shown, new Map(), "passed");
      return {
        revision: shown.revision,
        head: shown.head,
        state: "confirmed" as const,
        region,
        regionHash: createHash("sha256").update(region).digest("hex"),
        contentHash: presentationContentHash(shown),
        number: 7,
      };
    };
    const storied: Parameters<typeof approved>[0] = {
      story: ({ tasks, taskId, forge }) => {
        Object.assign(forge, {
          attachments: {
            destination: async () => destination,
            upload: async () => {
              throw new Error("No upload expected");
            },
          },
        });
        const first = story(taskId, 1, ["The meter keeps every reading."]);
        const shown = published(first);
        tasks.delivery.updateChangePresentation(taskId, () => ({
          revisions: [first],
          receipts: [],
          publication: shown,
          published: shown,
        }));
        forge.body = shown.region;
        return 1;
      },
    };
    const withStory = () => approved(storied);

    // INF-3623, the captain's "all non-code changes to the PR should keep my
    // approval": a merge card shows the saved story; a story revised and
    // published at the version the card showed keeps its click, through the
    // real merge, and the merge request carries the newest story. Another
    // commit refuses the click.
    describe("a story revised after the merge card (INF-3623)", () => {
      it("merges the newest story on the earlier card's click when only the words changed", async () => {
        const h = await withStory();
        expect(h.tasks.get(h.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
          cardId: h.card.id,
          headSha: APPROVED,
          presentationRevision: 1,
        });
        // The crewmate revises the story's words and publishes it at the same commit.
        const revised = story(h.taskId, 2, ["The meter keeps every reading across a restart."]);
        const shown = published(revised);
        h.tasks.delivery.updateChangePresentation(h.taskId, (record) => ({
          ...record!,
          revisions: [...record!.revisions, revised],
          publication: shown,
          published: shown,
        }));
        h.forge.body = shown.region;
        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        expect(h.forge.squashes).toEqual(["The meter keeps every reading across a restart."]);
        expect(presentationCommitMessage(revised, BUNDLED_NAMING)).toBe(h.forge.squashes[0]);
        await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.closedReason).toBe("merged"));
        expect(
          h.tasks
            .timeline(h.taskId)
            .filter((event) => event.data?.storyChangedAfterClick !== undefined),
        ).toHaveLength(1);
      });

      it("refuses the earlier card's click after another commit, and merges nothing", async () => {
        const h = await withStory();
        h.forge.headSha = REPAIRED;
        seedDelivery(h.tasks, h.taskId, { headSha: REPAIRED });
        expect(() => h.supervisor.cardActions.act(h.card.id, "merge")).toThrow();
        await tick();
        expect(h.forge.sends).toBe(0);
        expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
      });
    });

    // INF-3799, found on INF-3710: once a published story's pull request
    // merged outside the app, check_change asks its crewmate for the merge
    // card with after close, and that card was refused both with the story
    // and without it. It shows the story the pull request merged with, and
    // the task closes as merged with nothing sent, whether the app's own
    // sweep or the captain's click closes it. With the captain's kept
    // approval already declaring the close, check_change asks for no card.
    describe("a story's pull request merged outside the app (INF-3799)", () => {
      /** The merge card is withdrawn, so no click declared anything, and #7 is merged on GitHub by hand. */
      const mergedByHand = async () => {
        const h = await withStory();
        h.supervisor.cards.takeDown(h.card.id, "The crewmate withdrew it.");
        h.forge.merged = true;
        await tick();
        return h;
      };
      const mergeCard = (h: Awaited<ReturnType<typeof withStory>>) =>
        h.cards().find((card) => card.actions.some((action) => action.effect?.kind === "merge"));

      it.each([
        ["the app's own sweep", "sweep"],
        ["the captain's click", "click"],
      ] as const)(
        "shows the story's merge card for a pull request merged by hand and closes the task as merged on %s",
        async (_label, closer) => {
          const h = await mergedByHand();
          // Nothing declared yet that this merge closes the task: it stays
          // open, and the app wakes the crewmate about the merge.
          expect(await h.supervisor.settling.settle.reconcileExternalMerge(h.taskId)).toBe(true);
          expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
          expect(mergeCard(h)).toBeUndefined();
          // In its turn the crewmate reads the merge and puts up the merge card it is told to.
          await repairTurn(h, async () => {
            expect(await h.declare({})).toContain(
              "put up your merge card for this pull request with after close",
            );
            await h.emit("Merged on GitHub");
          });
          const card = mergeCard(h);
          expect(card?.body).toContain("The meter keeps every reading.");
          expect(h.tasks.get(h.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
            cardId: card?.id,
            headSha: APPROVED,
            shownFor: 7,
            presentationRevision: 1,
          });
          if (closer === "sweep") {
            expect(await h.supervisor.settling.settle.reconcileExternalMerge(h.taskId)).toBe(true);
          } else h.supervisor.cardActions.act(card?.id ?? "", "merge");
          await vi.waitFor(() =>
            expect(h.tasks.get(h.taskId)).toMatchObject({
              status: "done",
              closedReason: "merged",
            }),
          );
          expect(h.forge.sends).toBe(0);
        },
      );

      // The review of INF-3799: the merge's wake asked for a merge card the
      // card calls refuse, where check_change asks for the merge's report.
      it("asks for the merge's report in its wake, not a merge card, when the pull request merged at a version its story never reached", async () => {
        const h = await mergedByHand();
        // A commit pushed after the story was published, then merged by hand.
        h.forge.headSha = REPAIRED;
        expect(await h.supervisor.settling.settle.reconcileExternalMerge(h.taskId)).toBe(true);
        const refused = `#7 was merged outside the app at ${REPAIRED}, a version its published story revision 1 at ${APPROVED} never reached. A merged pull request takes no new story, so it has no merge card: report the merge`;
        const wake = h.inbox.allFor(h.taskId).find((row) => row.facts?.kind === "external-merge");
        if (!wake) throw new Error("The merge woke no one.");
        const words = renderWake(wake);
        expect(words).toContain(refused);
        expect(words).not.toContain("put up your merge card");
        // check_change reads the same verdict.
        await repairTurn(h, async () => {
          expect(await h.declare({})).toContain(`Nothing is left to merge. ${refused}`);
        });
        expect(mergeCard(h)).toBeUndefined();
        expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
        expect(h.forge.sends).toBe(0);
      });

      it("asks for no merge card when the captain's kept approval already says the merge closes the task", async () => {
        const h = await kept(storied);
        h.forge.merged = true;
        const answer = await h.declare({});
        expect(answer).toContain("put up no merge card");
        expect(answer).not.toContain("put up your merge card");
        expect(await h.supervisor.settling.settle.reconcileExternalMerge(h.taskId)).toBe(true);
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        expect(h.forge.sends).toBe(1);
      });

      // INF-4161: GitHub refused the click for a conflict and the pull
      // request was then merged by hand. check_change said "put up no merge
      // card", then the kept approval's line asked for a conflictRepair on
      // a pull request that had already merged.
      it.each([
        ["the version the captain approved", APPROVED],
        ["a later version", REPAIRED],
      ])(
        "asks for no repair once the pull request a kept approval waits on merged at %s",
        async (_label, head) => {
          const h = await kept(storied);
          const approval = h.authorization();
          if (!approval) throw new Error("The click kept no approval.");
          const line = keptApprovalLine(approval);
          // While the pull request is open, the reading asks for the repair.
          expect(line).toContain("conflictRepair");
          expect(await h.declare({})).toContain(line);
          h.forge.headSha = head;
          h.forge.merged = true;
          const answer = await h.declare({});
          expect(answer).toContain("overall: merged");
          expect(answer).toContain("put up no merge card");
          expect(answer).not.toContain(line);
          expect(answer).not.toContain("conflictRepair");
        },
      );
    });

    // INF-2913, the captain's ask: "only show a card if the merge went wrong
    // and needs the user's decision. otherwise it should just do its thing
    // and not bother the user with an FYI". A click that waits shows no card;
    // Activity's one line says what it waits for.
    it("shows no card while a clicked merge waits, and merges with no second click", async () => {
      const h = await approved();
      h.forge.states = ["failure"];
      await h.declare({});
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      expect(h.cards()).toEqual([]);
      expect(settleLines(h.tasks, h.taskId)).toContain(keptFeedLine("checks", "GitHub", "red"));
      await repairTurn(h, async () => {
        h.forge.states = ["success"];
      });
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.closedReason).toBe("merged"));
    });

    // INF-2913 (the request_merge twin): a clicked review that waits on a
    // conflict shows no card either, and merges once the gates pass.
    it("shows no card while a clicked request_merge review waits, and merges it once the gates pass", async () => {
      const h = await approved({ referenced: true });
      h.forge.readiness = "conflict";
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("conflict"));
      expect(h.cards()).toEqual([]);
      expect(h.forge.merges).toEqual([]);
      h.forge.readiness = "clean";
      await repairTurn(h, async () => {});
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      // A referenced merge keeps its task open.
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
    });

    // INF-834 friction 4, the captain's ask: "A crewmate can revise a
    // completion card's words while its checks run". INF-638's revision
    // was refused while its checks ran, so he closed a stale card and waited.
    it("revises the completion card's words while the checks run, and its merge waits for them", async () => {
      const REVISED = "revised00004";
      const h = await approved();
      const merge = () =>
        h
          .cards()
          .find((card) => card.id === h.card.id)
          ?.actions.find((action) => action.effect?.kind === "merge" && !action.passes);
      const revise = (reply?: string, id = h.card.id) =>
        h.specs[0]?.onCard?.({
          requiredActions: [],
          id,
          title: "Ready to merge",
          body: completionBody("<p>The change is one setting now.</p><p>Pushed.</p>"),
          actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
          ...(reply ? { reply, answersMessage: askedOn(h.supervisor, id) } : {}),
        });
      // The captain asks for a smaller change; the rebuilt version's checks run.
      h.supervisor.cardActions.replyToCard(h.card.id, "this is over-engineering a bit");
      await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2));
      h.forge.headSha = REVISED;
      h.forge.states = ["success", "pending"];
      // A revision still answers his reply in the thread (FI3-643).
      await expect(revise()).rejects.toThrow(/waits on your answer/);
      const answer = await revise("I cut it down to one setting; the checks are running.");
      expect(answer).toContain(h.card.id);
      expect(answer).toContain(COMPLETION_REVISED_WHILE_RUNNING);
      // INF-1555 F12: the shown revision itself carries readiness; its pending checks remain a hold.
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ ci: "pending" });
      expect(h.tasks.get(h.taskId)?.delivery).not.toHaveProperty("crewVerdict");
      expect(h.tasks.get(h.taskId)?.delivery?.completionOffers?.at(-1)?.headSha).toBe(REVISED);
      h.crewmate.finishPrompt();
      await tick();
      const shown = h.cards().find((card) => card.id === h.card.id);
      expect(shown?.body).toContain("The change is one setting now.");
      expect(h.cardStore.messages(h.card.id).map((message) => message.text)).toContain(
        "I cut it down to one setting; the checks are running.",
      );
      expect(merge()?.label).toBe(MERGE_WORDS.whenChecksPass);
      // His click merges nothing while they run and keeps his approval for the revised version.
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      expect(h.authorization()?.approvedHead).toBe(REVISED);
      expect(h.forge.merges).toEqual([]);
      // They pass, and the next idle boundary merges the revised version with no second click.
      await repairTurn(h, async () => {
        h.forge.states = ["success"];
      });
      await vi.waitFor(() => expect(h.forge.merges).toEqual([REVISED]));
    });

    // INF-1891, the captain: "the app turns the merge card down until the
    // pull request's own checks pass"; a diagnosis of every failed check
    // lets it up, as stable 0.6.1 did, and never as merge permission.
    it("holds the crew's red offer until each failed check carries a diagnosis, never as merge permission (INF-1891)", async () => {
      const h = await approved();
      h.forge.headSha = "revised00004";
      h.forge.states = ["failure"];
      const revise = () =>
        h.specs[0]?.onCard?.({
          requiredActions: [],
          id: h.card.id,
          title: "Ready to merge",
          body: completionBody("<p>The change is one setting now.</p><p>Pushed.</p>"),
          actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
        });
      const held = revise();
      await expect(held).rejects.toThrow(`the checks read ${CHECK_WORDS.red}, not passed`);
      await expect(held).rejects.toThrow("spend no rerun on it");
      await expect(held).rejects.toThrow(softHoldWords("checks", "crewmate"));
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ headSha: "revised00004", ci: "red" });
      await h.declare({
        diagnosis: {
          headSha: "revised00004",
          check: "linux-checks",
          classification: "unknown",
          evidence: "The log ends before the failed step names a cause.",
        },
      });
      await expect(revise()).resolves.toBeDefined();
      expect(h.authorization()).toBeUndefined();
      expect(h.forge.merges).toEqual([]);
    });

    it("an already-autonomous task can merge through its routine completion offer", async () => {
      const h = await approved();
      const repoId = h.tasks.get(h.taskId)?.repoId;
      if (!repoId) throw new Error("Missing project");
      h.repos.configure(repoId, { autonomy: true });
      expect(h.tasks.get(h.taskId)?.gate?.kind).toBe("captain");
      await h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr");
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      expect(h.forge.merges).toHaveLength(1);
    });

    // INF-547: started work the first mate merges without the captain's
    // click leaves its one sentence, unless the crewmate's own story is
    // still on their stack (the captain's direction C).
    describe("the first mate's closing note on a merge (INF-547)", () => {
      const SENTENCE = "The meter reads on time now.";
      const selfMerging = async () => {
        const h = await approved();
        const repoId = h.tasks.get(h.taskId)?.repoId;
        if (!repoId) throw new Error("Missing project");
        h.repos.configure(repoId, { autonomy: true });
        return h;
      };
      const left = (h: Awaited<ReturnType<typeof approved>>) =>
        h
          .cards()
          .filter((card) => card.taskId === h.taskId)
          .map((card) => ({ author: card.author, title: card.title, actions: card.actions }));

      it("puts up the sentence with the pull request when nothing of the task stays up", async () => {
        const h = await selfMerging();
        await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
          h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr"),
        );
        await tick();
        const record = h.tasks.get(h.taskId);
        expect(record).toMatchObject({ status: "done", closedReason: "merged" });
        expect(left(h)).toEqual([
          {
            author: "firstmate",
            title: closingNoteTitle(record?.key ?? "", "merged"),
            actions: [],
          },
        ]);
        const body = h.cards().find((card) => card.taskId === h.taskId)?.body ?? "";
        expect(body).toContain(SENTENCE);
        expect(body).toContain(`>PR #${record?.delivery?.prNumber}</a>`);
      });

      it("leaves the crewmate's own story and adds nothing beside it", async () => {
        const h = await selfMerging();
        await repairTurn(h, async () => {
          await h.specs[0]?.onCard?.({
            title: "The meter reads on time",
            body: completionBody("<p>The meter reads on the first paint.</p>"),
            actions: [],
          });
        });
        await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
          h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr"),
        );
        await tick();
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        expect(left(h)).toEqual([
          { author: "crewmate", title: "The meter reads on time", actions: [] },
        ]);
      });

      // INF-2461, the captain's pick on INF-2442: "The card you clicked
      // carries the merge or drop outcome, with no second note". The audit
      // found "INF-2359 merged" going up a minute after the captain closed
      // that task's own story note.
      it("adds no second note once the captain closed the story note (INF-2461)", async () => {
        const h = await selfMerging();
        await repairTurn(h, async () => {
          await h.specs[0]?.onCard?.({
            title: "The meter reads on time",
            body: completionBody("<p>The meter reads on the first paint.</p>"),
            actions: [],
          });
        });
        const story = h.cards().find((card) => card.title === "The meter reads on time") as Card;
        // Reading this ordinary story note starts its author's next turn.
        h.supervisor.pressNote(story.id);
        await tick();
        h.crewmate.finishPrompt();
        await tick();
        expect(h.cards().some((card) => card.id === story.id)).toBe(false);
        await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
          h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr"),
        );
        await tick();
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        expect(h.forge.merges).toHaveLength(1);
        expect(left(h)).toEqual([]);
      });

      // A note along the way told the captain nothing about how the work
      // came out, so the merge still leaves its one note (INF-2461).
      it("still puts up the sentence when the captain closed only a note along the way (INF-2461)", async () => {
        const h = await selfMerging();
        await repairTurn(h, async () => {
          await h.specs[0]?.onCard?.({
            title: "The meter's old reading was a day late",
            body: "<p>The meter's first paint read yesterday's value.</p>",
            actions: [],
          });
        });
        const finding = h
          .cards()
          .find((card) => card.title === "The meter's old reading was a day late") as Card;
        h.supervisor.pressNote(finding.id);
        await tick();
        h.crewmate.finishPrompt();
        await tick();
        await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
          h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr"),
        );
        await tick();
        const record = h.tasks.get(h.taskId);
        expect(record).toMatchObject({ status: "done", closedReason: "merged" });
        expect(left(h)).toEqual([
          {
            author: "firstmate",
            title: closingNoteTitle(record?.key ?? "", "merged"),
            actions: [],
          },
        ]);
      });

      // INF-1467, the captain's answer: "Keep the note for merges and
      // releases; drops, cancels and answers go quiet" - work the first
      // mate marked its own still says when it merged.
      it("still puts up the sentence when work the first mate marked its own merges (INF-1467)", async () => {
        const h = await approved({ internalStep: true });
        const repoId = h.tasks.get(h.taskId)?.repoId;
        if (!repoId) throw new Error("Missing project");
        h.repos.configure(repoId, { autonomy: true });
        await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
          h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr"),
        );
        await tick();
        const record = h.tasks.get(h.taskId);
        expect(record).toMatchObject({ status: "done", closedReason: "merged" });
        expect(record?.shape?.internal_step).toBe(true);
        expect(left(h)).toEqual([
          {
            author: "firstmate",
            title: closingNoteTitle(record?.key ?? "", "merged"),
            actions: [],
          },
        ]);
      });

      it("adds nothing when the captain's click merges it", async () => {
        const h = await approved();
        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.status).toBe("done"));
        await tick();
        expect(left(h)).toEqual([]);
      });
    });

    it("an explicit live self-merging request releases the routine completion wait, and the app merges from its card (INF-2744)", async () => {
      const h = await approved();
      seedDelivery(h.tasks, h.taskId, {
        captainWait: { at: Date.now(), cardId: h.card.id, reason: "Read the result" },
      });
      editPolicies(h, { autonomy: true });
      await tick();
      // INF-2744: the app merges from the open merge card itself; the card
      // keeps only its merging line, and the first mate settles nothing.
      expect(h.cards().find((card) => card.id === h.card.id)?.actions).toEqual([]);
      expect(h.tasks.get(h.taskId)?.delivery?.captainWait).toBeUndefined();
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.status).toBe("done"));
    });

    /**
     * INF-562, the captain's ask: "the most natural place to make use of the
     * careful care level is when a merge completion card is raised, and they
     * looked at the card and felt it's risky" - a Quick or Default pull
     * request's merge card offers Review carefully beside Merge.
     */
    it("Review carefully on a merge card makes the task Careful from the captain, starts its crewmate and starts the review of the version the card offered", async () => {
      const h = await approved({ guidance: true });
      // The branch has the committed version the card offered.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(APPROVED);
      const careful = h.card.actions.find((action) => action.care);
      expect(careful).toMatchObject({ label: REVIEW_CAREFULLY_WORDS, care: "reviewed" });
      expect(careful?.effect).toBeUndefined();
      // Drawn between Discard and Merge: the default stays last.
      expect(h.card.actions.map((action) => action.label)).toEqual([
        "Discard",
        REVIEW_CAREFULLY_WORDS,
        MERGE_WORDS["merge-pr"],
      ]);
      // A body's script cannot press it.
      expect(() => h.supervisor.cardActions.act(h.card.id, careful?.id ?? "", "frame")).toThrow(
        "only from the card controls",
      );
      expect(h.tasks.get(h.taskId)?.shape?.policies?.rigor).toBeUndefined();
      const turns = h.crewmate.promptCalls.length;

      h.supervisor.cardActions.act(h.card.id, careful?.id ?? "");
      await tick();
      expect(h.cards().find((card) => card.id === h.card.id)).toBeUndefined();
      expect(h.tasks.get(h.taskId)?.shape?.policies?.rigor).toBe("reviewed");
      expect(h.authorization()).toBeUndefined();
      const edit = h.tasks
        .timeline(h.taskId)
        .find((event) => event.kind === "note" && event.text.includes("Rigor: Careful"));
      expect(edit).toMatchObject({ actor: "captain" });
      expect(edit?.text).toContain("from the merge card");
      // The care notice and the choice start the idle crewmate together.
      await vi.waitFor(() => expect(h.crewmate.promptCalls.length).toBeGreaterThan(turns));
      const turn = h.crewmate.promptCalls.slice(turns).join("\n");
      // The raise's notice carries the Careful guidance the task's new facts
      // select, which its instructions did not carry (INF-1876).
      expect(turn).toContain(POLICY_GUIDANCE_HEADING);
      expect(turn).toContain(careCarefulGuide.trim());
      expect(turn).toContain(REVIEW_CAREFULLY_WORDS);
      expect(h.forge.merges).toEqual([]);
      // The app started the review of that version (INF-1875): a review
      // child of the task that holds nothing on it, briefed with the card
      // the captain read, and a line on the task's timeline saying so.
      await vi.waitFor(() => expect(h.reviewer.promptCalls).toHaveLength(1));
      const review = h.tasks
        .listLive()
        .find((task) => task.shape?.kind === "review" && task.parentId === h.taskId);
      expect(review).toMatchObject({ title: "Review: Ship the meter", status: "active" });
      expect(review?.delivery?.headSha).toBe(APPROVED);
      expect(h.tasks.graph.blockersHoldingClose(h.taskId)).toEqual([]);
      const brief = h.reviewer.promptCalls[0] ?? "";
      expect(brief).toContain(`Review branch fm/task-${h.taskId} at head ${APPROVED}`);
      expect(brief).toContain("Ready to merge");
      expect(
        h.tasks
          .timeline(h.taskId)
          .some(
            (event) =>
              event.kind === "note" &&
              event.text ===
                `the app started review ${review?.key} of version ${APPROVED.slice(0, 7)}`,
          ),
      ).toBe(true);
      // The first mate's own spawn for the same review finds it open.
      await expect(
        h.supervisor.intake.commission({
          title: "Review",
          intent: intentOf("Ship the meter fix"),
          shape: { review_of: h.taskId },
        }),
      ).rejects.toThrow(/already has a review open/);
    });

    it("says in the feed and wakes the first mate at once when the app cannot start the review from the merge card, and the care still rose", async () => {
      const h = await approved();
      const careful = h.card.actions.find((action) => action.care);
      // No commits to read on the branch: nothing to review yet.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(null);
      const woken = h.ops.length;
      h.supervisor.cardActions.act(h.card.id, careful?.id ?? "");
      await tick();
      expect(h.tasks.get(h.taskId)?.shape?.policies?.rigor).toBe("reviewed");
      await vi.waitFor(() =>
        expect(
          h.events.some(
            (event) =>
              event.type === "firstmate_note" &&
              event.text.includes(
                `${REVIEW_CAREFULLY_WORDS}: the app could not start the review`,
              ) &&
              event.text.includes("no commits on its branch to review yet"),
          ),
        ).toBe(true),
      );
      expect(h.tasks.listLive().some((task) => task.shape?.kind === "review")).toBe(false);
      expect(h.reviewer.promptCalls).toHaveLength(0);
      // INF-4072 finding 1: the first mate hears the click it must carry
      // out now, with the reason, rather than only a feed line.
      const key = h.tasks.get(h.taskId)?.key;
      const wakes = h.ops
        .slice(woken)
        .filter((op) => op.includes(`The captain pressed "${REVIEW_CAREFULLY_WORDS}"`));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain(`(${h.card.id}) for task ${key} "Ship the meter"`);
      expect(wakes[0]).toContain("could not start the review the button asks for");
      expect(wakes[0]).toContain("no commits on its branch to review yet");
    });

    it("reviews a task with no recorded words of the captain's against its goal from the merge card", async () => {
      const h = await approved({ filed: true });
      expect(h.tasks.get(h.taskId)?.intent).toBeNull();
      // The branch has the committed version the card offered.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(APPROVED);
      const careful = h.card.actions.find((action) => action.care);
      const woken = h.ops.length;
      h.supervisor.cardActions.act(h.card.id, careful?.id ?? "");
      await vi.waitFor(() => expect(h.reviewer.promptCalls).toHaveLength(1));
      const review = h.tasks
        .listLive()
        .find((task) => task.shape?.kind === "review" && task.parentId === h.taskId);
      expect(review).toMatchObject({ title: "Review: Ship the meter", status: "active" });
      const brief = h.reviewer.promptCalls[0] ?? "";
      expect(brief).toContain(`${NO_RECORDED_WORDS_LEAD}${JSON.stringify(FILED_GOAL)}`);
      expect(brief).toContain(`Review branch fm/task-${h.taskId} at head ${APPROVED}`);
      // Started, so nothing is left for the first mate to carry out.
      expect(
        h.ops
          .slice(woken)
          .some((op) => op.includes(`The captain pressed "${REVIEW_CAREFULLY_WORDS}"`)),
      ).toBe(false);
    });

    it("raising care in words takes the old merge card down, and lowering it does not", async () => {
      const h = await approved();
      const edit = (rigor: "quick" | "standard" | "reviewed") => {
        const record = h.tasks.get(h.taskId);
        const before = record
          ? effectiveTaskPolicies(record, record.repoId ? h.repos.get(record.repoId) : undefined)
          : null;
        h.tasks.updateFields(h.taskId, { policies: { rigor } }, "firstmate");
        h.supervisor.policiesChanged(h.taskId, { rigor }, before);
      };
      const up = (id: string) => h.cards().some((card) => card.id === id);
      edit("standard");
      await vi.waitFor(() => expect(up(h.card.id)).toBe(false));
      await h.emit("Ready at Default");
      await tick();
      const shown = h.cards().find((card) => card.title === "Ready at Default") as Card;
      expect(shown).toBeDefined();
      edit("quick");
      await tick();
      expect(up(shown.id)).toBe(true);
      edit("reviewed");
      await vi.waitFor(() => expect(up(shown.id)).toBe(false));
    });

    it("self-merging still waits for failed checks and merges only after a fresh accepted reading", async () => {
      const h = await approved();
      // INF-2744: with its merge card up the app would merge itself; this
      // reads the first mate's own merge, so the card is down first.
      h.supervisor.cards.takeDown(h.card.id, "The test reads the first mate's merge.");
      h.forge.states = ["failure"];
      editPolicies(h, { autonomy: true });
      expect(
        (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).text,
      ).toContain("the checks failed");
      expect(h.forge.merges).toEqual([]);
      expect(h.tasks.get(h.taskId)?.delivery?.ci).toBe("red");
      h.forge.states = ["success"];
      await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(h.forge.merges).toEqual([APPROVED]);
    });

    it.each(["autonomy", "care", "destination"] as const)(
      "rereads a newer %s policy after asynchronous checks and sends no old merge",
      async (policy) => {
        const h = await approved();
        // INF-2744: with its merge card up the app would merge itself; this
        // reads the first mate's own merge, so the card is down first.
        h.supervisor.cards.takeDown(h.card.id, "The test reads the first mate's merge.");
        editPolicies(h, { autonomy: true });
        h.forge.duringChecks = () => {
          h.forge.duringChecks = () => {};
          editPolicies(
            h,
            policy === "autonomy"
              ? { autonomy: false }
              : policy === "care"
                ? { rigor: "reviewed" }
                : { delivery: "local-only" },
          );
        };
        const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
        expect(result.text).toContain("policies changed");
        expect(h.forge.merges).toEqual([]);
        expect(h.tasks.get(h.taskId)?.delivery?.prNumber).toBe(7);
        expect(h.tasks.get(h.taskId)?.status).toBe("active");
      },
    );

    it("a repeated ask-first request cancels a retained approval being checked, and later explicit self-merging remains possible", async () => {
      const h = await kept();
      expect(h.supervisor.facts.taskAutonomy(h.taskId)).toBe(false);
      h.forge.duringChecks = () => {
        h.forge.duringChecks = () => {};
        editPolicies(h, { autonomy: false });
      };
      await repairTurn(h, async () => {});
      expect(h.forge.merges).toEqual([]);
      expect(h.authorization()?.status).toBe("invalidated");
      editPolicies(h, { autonomy: true });
      await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(h.forge.merges).toEqual([APPROVED]);
    });

    // INF-1876: the host records the care's name and holds nothing on it;
    // what Careful asks reaches the crew through the care guidance.
    it("a care edit on an existing pull request holds no merge by itself, and the review record survives every edit", async () => {
      const h = await approved();
      // INF-2744: with its merge card up the app would merge itself; this
      // reads the first mate's own merge, so the card is down first.
      h.supervisor.cards.takeDown(h.card.id, "The test reads the first mate's merge.");
      editPolicies(h, { autonomy: true, rigor: "reviewed" });
      seedDelivery(h.tasks, h.taskId, {
        reviewVerdict: "pass",
        reviewSha: "older",
        reviewRounds: 2,
      });
      editPolicies(h, { rigor: "quick" });
      editPolicies(h, { rigor: "reviewed" });
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewSha: "older",
        reviewRounds: 2,
        prNumber: 7,
      });
      // A pass at an earlier version says so beside the version on offer (INF-3141).
      expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.review).toBe(
        `review passed at older only, an earlier version than ${APPROVED.slice(0, 7)} on offer`,
      );
      await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(h.forge.merges).toEqual([APPROVED]);
    });
  });
});

describe("task-level autonomy and the host's merge hold (contract v3.9)", () => {
  /** A direct-pr repository, its autonomy as given, with one task on it. */
  async function onRepo(
    autonomy: boolean,
    shape?: { autonomy_ask?: boolean },
  ): Promise<{
    dispose: () => void;
    taskId: string;
    supervisor: CrewSupervisor;
    tasks: TaskService;
    specs: CrewmateSpec[];
    cards: () => Card[];
    mergePullRequest: ReturnType<typeof vi.fn>;
  }> {
    const repo = gitRepo("meterlab");
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #7 is in on GitHub." }));
    const { supervisor, tasks, repos, specs, cards } = setup(crewmate, { mergePullRequest });
    const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
    repos.configure(view.id, { delivery: "direct-pr", autonomy });
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix the meter"),
      repoId: view.id,
      ...(shape ? { shape } : {}),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    return { dispose: repo.dispose, taskId, supervisor, tasks, specs, cards, mergePullRequest };
  }

  /** The crewmate's completion card, as the host finishes it. */
  function completionCard(specs: CrewmateSpec[]): void {
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter test is steady",
      body: completionBody(
        "<p>The meter test passes ten runs in a row.</p>" +
          "<ul><li>Reran the suite ten times on the final commit.</li></ul>",
      ),
      actions: [{ id: "ship", label: "Ship it", default: true, effect: SETTLE_MERGE }],
    });
  }

  /**
   * The two host holds on the same two settle modes (v3.8's answer task and
   * v3.9's autonomy) compose in one order: the DELIVERABLE speaks first,
   * because a task that commits nothing has no merge for autonomy to be
   * about. So an answer task on an ask-first repository is refused for what
   * it delivers, never for who may merge it, and carries no autonomy at all.
   */
  it("lets the deliverable speak before the autonomy hold, and stamps no autonomy on an answer task", async () => {
    const repo = gitRepo("meterlab");
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #7 is in on GitHub." }));
    const { supervisor, tasks, repos } = setup(crewmate, {
      mergePullRequest,
      classifier: {
        classify: async () =>
          ({ kind: "research", source: "classifier:xai/grok-cheap", version: "kc1" }) as const,
      },
    });
    try {
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      // Ask-first, so the autonomy hold WOULD fire on a change here.
      repos.configure(view.id, { delivery: "direct-pr", autonomy: false });
      const { taskId } = await supervisor.intake.commission({
        title: "Why is the meter idle",
        intent: { ...intentOf("why is nothing running?"), constraints: [{ kind: "read-only" }] },
        repoId: view.id,
      });
      await tick();
      crewmate.finishPrompt();
      await tick();
      expect(tasks.get(taskId)?.shape).toMatchObject({ deliverable: "answer" });
      // No autonomy is stamped, and crew_status carries none: there is no
      // merge, so there is nobody to say who merges it.
      expect(tasks.get(taskId)?.shape?.autonomy).toBeUndefined();
      expect(
        supervisor.facts.crewStatus().find((row) => row.taskId === taskId)?.autonomy,
      ).toBeUndefined();
      // The refusal the Firstmate reads is the deliverable's, not autonomy's.
      const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(result.text).toContain("delivers an answer, not a change");
      expect(result.refusal?.refused).not.toBe("autonomy-off");
      expect(mergePullRequest).not.toHaveBeenCalled();
    } finally {
      repo.dispose();
    }
  });

  it("inherits the repository and stamps what it was commissioned under without showing autonomy on the card", async () => {
    const h = await onRepo(false);
    try {
      expect(h.supervisor.facts.taskAutonomy(h.taskId)).toBe(false);
      expect(h.tasks.get(h.taskId)?.shape).toMatchObject({ autonomy: false });
      expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.autonomy).toBe(false);
      completionCard(h.specs);
      await tick();
      const card = h.cards().find((entry) => entry.taskId === h.taskId);
      expect(card?.body).not.toContain(">On its own<");
      // Default care is not written on the card (INF-3709's plan): only a
      // care level that is not Default shows in the strip's reference.
      expect(card?.body).not.toContain('data-fact="care"');
    } finally {
      h.dispose();
    }
  });

  it("refuses the Firstmate's own merge, merges nothing, and points at the captain's button", async () => {
    const h = await onRepo(false);
    try {
      completionCard(h.specs);
      await tick();
      const card = h.cards().find((entry) => entry.taskId === h.taskId);
      const merge = card?.actions.find((action) => action.effect?.kind === "merge");
      // The host attached the pair from the posture; the crewmate's own
      // invented label never reaches the captain, so the way names the
      // button he is actually reading.
      expect([merge?.id, merge?.label]).toEqual(["merge", "Merge the pull request"]);
      const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(result.refusal).toMatchObject({
        refused: "autonomy-off",
        task: { id: h.taskId },
        ways: [{ label: merge?.label, card: { id: card?.id, action: merge?.id } }],
      });
      expect(result.text).toContain("is not yours to do: autonomy is off for this task");
      expect(result.text).toContain("meterlab asks before merging");
      // Nothing moved: no merge, the task still active, the card still up.
      expect(h.mergePullRequest).not.toHaveBeenCalled();
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
      expect(h.cards().some((entry) => entry.id === card?.id)).toBe(true);
      // A land is held the same way: the hold is on merging, not on GitHub.
      expect(
        (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "land")).refusal?.refused,
      ).toBe("autonomy-off");
    } finally {
      h.dispose();
    }
  });

  it("merges on the captain's own click, on the very task it held", async () => {
    const held = await onRepo(false);
    try {
      // The same autonomy-off task the Firstmate was just refused on. The
      // card's settle effect arrives as actor captain, which this rule does
      // not read: his click IS the way out the refusal named.
      expect(
        (await held.supervisor.settling.settle.settleTaskDetailed(held.taskId, "merge-pr")).refusal
          ?.refused,
      ).toBe("autonomy-off");
      expect(held.mergePullRequest).not.toHaveBeenCalled();
      expect(
        await held.supervisor.settling.settle.settleTask(
          held.taskId,
          "merge-pr",
          undefined,
          "captain",
        ),
      ).toBe("Change #7 is in on GitHub.");
      expect(held.mergePullRequest).toHaveBeenCalledTimes(1);
      expect(held.tasks.get(held.taskId)).toMatchObject({ status: "done" });
    } finally {
      held.dispose();
    }
  });

  it("lets one task merge itself on an ask-first repository, and holds one on an autonomous one", async () => {
    const asked = await onRepo(false, { autonomy_ask: true });
    try {
      expect(asked.supervisor.facts.taskAutonomy(asked.taskId)).toBe(true);
      expect(asked.tasks.get(asked.taskId)?.shape).toMatchObject({
        autonomy_ask: true,
        autonomy: true,
      });
      expect(await asked.supervisor.settling.settle.settleTask(asked.taskId, "merge-pr")).toBe(
        "Change #7 is in on GitHub.",
      );
      expect(asked.mergePullRequest).toHaveBeenCalledTimes(1);
    } finally {
      asked.dispose();
    }

    const held = await onRepo(true, { autonomy_ask: false });
    try {
      expect(held.supervisor.facts.taskAutonomy(held.taskId)).toBe(false);
      expect(
        (await held.supervisor.settling.settle.settleTaskDetailed(held.taskId, "merge-pr")).refusal,
      ).toMatchObject({ refused: "autonomy-off", ways: [] });
      expect(held.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      held.dispose();
    }
  });

  // Review INF-2926's F4: a merge the app sends at once from its card -
  // here a project with no host it keeps approvals on - gives the card the
  // captain's buttons back when it is refused.
  it("gives a card the app merged from its buttons back when that merge is refused", async () => {
    const h = await onRepo(true);
    try {
      h.mergePullRequest.mockResolvedValue({
        ok: false,
        text: "Cannot merge: the branch cannot be merged.",
      });
      completionCard(h.specs);
      await vi.waitFor(() => expect(h.mergePullRequest).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => {
        const card = h.cards().find((entry) => entry.taskId === h.taskId);
        expect(card?.actions.some((action) => action.effect?.kind === "merge")).toBe(true);
      });
      expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    } finally {
      h.dispose();
    }
  });

  // The autonomy journey's click (INF-2744): the captain clicked the merge
  // card while the first mate's own merge call still held the task, so the
  // click met another settle. His approval runs as soon as that settle
  // ends, not at the next minute's look.
  it("runs the captain's merge click once the settle that held the task ends", async () => {
    const h = await approved();
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.retryAt).toBeDefined());
    await tick();
    expect(h.forge.merges).toEqual([]);
    held.release();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    await vi.waitFor(() =>
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" }),
    );
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F1, under the captain's "a single task can request
  // many merges": two merge cards for two pull requests, each approval
  // standing on its own until its pull request merges.
  async function twoPullRequests() {
    const h = await approved({ referenced: true });
    const heads: Record<number, string> = { 7: APPROVED, 8: REPAIRED };
    const merged = new Set<number>();
    h.forge.pull = async (number: number): Promise<ForgePull> => ({
      number,
      state: merged.has(number) ? "closed" : "open",
      merged: merged.has(number),
      ...(merged.has(number) ? { mergedSha: `squash-${heads[number]}` } : {}),
      headSha: heads[number] ?? APPROVED,
      base: "main",
      readiness: "clean",
      branch: number === 8 ? "fm/task-next" : "fm/task-earlier",
      headRepo: "o/r",
      title: number === 8 ? "fix: label the meter" : "fix: ship the meter",
    });
    h.forge.putIn = async (change: ForgeChange, headSha: string) => {
      h.forge.merges.push(headSha);
      if (change.number !== undefined) merged.add(change.number);
      return { sha: `squash-${headSha}` };
    };
    const first = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.[0] as MergeReview;
    const next: MergeReview = {
      ...first,
      id: "review-next",
      number: 8,
      headSha: REPAIRED,
      branch: "fm/task-next",
      title: "fix: label the meter",
    };
    seedDelivery(h.tasks, h.taskId, { mergeReviews: [first, next] });
    const emitNext = async (asksFirst?: string) => {
      await h.specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge the label",
        body: completionBody("<p>The label PR is ready.</p><p>CI is green on the tested head.</p>"),
        actions: [
          {
            id: "merge",
            default: true,
            effect: {
              kind: "merge",
              review: next.id,
              after: "continue",
              ...(asksFirst ? { asksFirst } : {}),
            },
          },
          { id: "not-now", label: "Not now" },
        ],
      });
      await tick();
    };
    /** Both pull requests merged, each once, the crewmate going idle after each continue. */
    const bothMerge = async () => {
      await vi.waitFor(() => expect(h.forge.merges).toContain(APPROVED));
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() => expect([...h.forge.merges].sort()).toEqual([APPROVED, REPAIRED]));
    };
    return { ...h, emitNext, bothMerge };
  }

  it("merges both pull requests when a second merge card goes up under autonomy while the first one's approval stands", async () => {
    const h = await twoPullRequests();
    // The first card's approval stands while another settle holds the task.
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await editPolicies(h, { autonomy: true });
    expect(h.authorization()).toMatchObject({
      status: "standing",
      issuer: "autonomy",
      target: { prNumber: 7 },
    });
    await h.emitNext();
    // The second card's approval waits beside it, never in its place.
    expect(h.authorization()).toMatchObject({ status: "standing", target: { prNumber: 7 } });
    expect(h.authorization()?.queued?.map((item) => item.target.prNumber)).toEqual([8]);
    expect(h.forge.merges).toEqual([]);
    held.release();
    await h.bothMerge();
    expect(h.forge.merges).toEqual([APPROVED, REPAIRED]);
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });

  it("merges both pull requests when autonomy turns on while both merge cards are up", async () => {
    const h = await twoPullRequests();
    await h.emitNext();
    expect(
      h.cards().filter((card) => card.taskId === h.taskId && card.actions.length > 0),
    ).toHaveLength(2);
    expect(h.authorization()).toBeUndefined();
    await editPolicies(h, { autonomy: true });
    await h.bothMerge();
    expect(h.forge.merges).toEqual([APPROVED, REPAIRED]);
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F2: the merge gate reads the card for the pull
  // request being merged, so another pull request's asks-first card does
  // not take back the app's approval of this one.
  it("merges the pull request whose card the app took while another pull request's card asks the captain first", async () => {
    const h = await twoPullRequests();
    await h.emitNext("The captain decides label changes himself.");
    await editPolicies(h, { autonomy: true });
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    h.crewmate.finishPrompt();
    await tick();
    expect(h.forge.merges).toEqual([APPROVED]);
    const asking = h.cards().find((card) => card.title === "Ready to merge the label");
    expect(asking?.actions.some((action) => action.effect?.kind === "merge")).toBe(true);
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's R2, the captain's "Let each go ahead on its own": an
  // approval whose pull request waits for its checks does not hold another
  // approved pull request of the task, which merges first; the waiting one
  // merges once its checks pass.
  it("merges an approved pull request whose checks passed while another approval on the task waits for its checks", async () => {
    const h = await twoPullRequests();
    let firstReady = false;
    h.forge.checks = async (change?: ForgeChange) => ({
      items: [
        {
          name: "linux-checks",
          state: change?.number === 7 && !firstReady ? ("pending" as const) : ("success" as const),
        },
      ],
    });
    await h.supervisor.steer.steerCrewmate(h.taskId, "put up the label fix too");
    await h.emitNext();
    h.crewmate.finishPrompt();
    await tick();
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() =>
      expect(h.authorization()).toMatchObject({
        status: "standing",
        target: { prNumber: 7 },
        waiting: { on: "checks" },
      }),
    );
    const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
    h.supervisor.cardActions.act(next.id, "merge");
    // The captain's first click told the crewmate its merge waits; once its
    // turn ends, the second approval goes ahead without waiting for the first.
    h.crewmate.finishPrompt();
    await tick();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED]));
    // The approval of the first still stands, waiting for its checks.
    expect(h.authorization()).toMatchObject({ status: "standing", target: { prNumber: 7 } });
    firstReady = true;
    h.crewmate.finishPrompt();
    await tick();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED, APPROVED]));
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's R1 and R4, under the captain's "a single task can
  // request many merges": the task's own pull request and another one its
  // crewmate asked for with check_change pull, which made that one the
  // current change. Each approval is kept to its own pull request, so both
  // merge, whether the captain clicks both cards or the app merges from
  // them under autonomy.
  it.each(["captain", "autonomy"] as const)(
    "merges the task's own pull request and one asked for with check_change pull when the %s approves both",
    async (who) => {
      const h = await approved();
      const merged = new Set<number>();
      const own = h.forge.pull.bind(h.forge);
      h.forge.pull = async (number: number): Promise<ForgePull> =>
        number === 8
          ? {
              number,
              state: merged.has(8) ? "closed" : "open",
              merged: merged.has(8),
              ...(merged.has(8) ? { mergedSha: `squash-${REPAIRED}` } : {}),
              headSha: REPAIRED,
              base: "main",
              readiness: "clean",
              branch: "fm/task-next",
              headRepo: "o/r",
              title: "fix: label the meter",
            }
          : own(number);
      h.forge.putIn = async (change: ForgeChange, headSha: string) => {
        h.forge.sends += 1;
        h.forge.merges.push(headSha);
        if (change.number === 8) merged.add(8);
        else h.forge.merged = true;
        return { sha: `squash-${headSha}` };
      };
      // The crewmate asks for the second pull request in a turn of its own.
      await h.supervisor.steer.steerCrewmate(h.taskId, "merge the label fix too");
      await h.declare({ pull: 8 });
      const review = h.tasks
        .get(h.taskId)
        ?.delivery?.mergeReviews?.find((item) => item.number === 8) as MergeReview;
      expect(h.tasks.get(h.taskId)?.delivery?.checkTarget).toMatchObject({ number: 8 });
      await h.specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge the label",
        body: completionBody("<p>The label PR is ready.</p><p>CI is green on the tested head.</p>"),
        actions: [
          {
            id: "merge",
            default: true,
            effect: { kind: "merge", review: review.id, after: "continue" },
          },
          { id: "not-now", label: "Not now" },
        ],
      });
      h.crewmate.finishPrompt();
      await tick();
      const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
      if (who === "captain") {
        h.supervisor.cardActions.act(h.card.id, "merge");
        h.supervisor.cardActions.act(next.id, "merge");
      } else await editPolicies(h, { autonomy: true });
      await vi.waitFor(() => expect(h.forge.merges.length).toBeGreaterThan(0));
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() => expect([...h.forge.merges].sort()).toEqual([APPROVED, REPAIRED]));
      await h.supervisor.disposeAll();
    },
  );

  // Review INF-2926's R3: an end that takes the task's merges back for the
  // captain ends its other approvals at once, and its crewmate hears which
  // merges will not run, so it puts their merge cards up again.
  it("tells the crewmate which merges will not run when the captain withdraws the approval in front", async () => {
    const h = await twoPullRequests();
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await editPolicies(h, { autonomy: true });
    await h.emitNext();
    expect(h.authorization()?.queued?.map((item) => item.target.prNumber)).toEqual([8]);
    expect(h.supervisor.withdrawMergeApproval(h.taskId).ok).toBe(true);
    expect(h.authorization()).toMatchObject({ status: "revoked" });
    expect(h.authorization()?.queued).toBeUndefined();
    await vi.waitFor(() =>
      expect(h.crewmate.promptCalls.join("\n")).toContain(
        "your merge card's merge of #8 did not happen",
      ),
    );
    held.release();
    await tick();
    expect(h.forge.merges).toEqual([]);
    await h.supervisor.disposeAll();
  });

  // The first mate's ruling on INF-2746's autonomy revoke end: once the
  // task no longer merges on its own, only approvals the app took under
  // autonomy end; an approval the captain clicked still goes ahead.
  it("merges the pull request the captain approved when the project's autonomy turns off under the app's approval in front", async () => {
    const h = await twoPullRequests();
    const repoId = h.tasks.get(h.taskId)?.repoId;
    if (!repoId) throw new Error("Missing project");
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await h.supervisor.steer.steerCrewmate(h.taskId, "put both merge cards up again");
    h.repos.configure(repoId, { autonomy: true });
    // The app takes the first card under the project's autonomy; the second
    // asks the captain first, and the captain clicks it.
    await h.emit("Ready to merge again");
    await h.emitNext("The captain decides label changes himself.");
    h.crewmate.finishPrompt();
    await tick();
    expect(h.authorization()).toMatchObject({
      status: "standing",
      issuer: "autonomy",
      target: { prNumber: 7 },
    });
    const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
    h.supervisor.cardActions.act(next.id, "merge");
    await vi.waitFor(() =>
      expect(h.authorization()?.queued).toEqual([
        expect.objectContaining({
          issuer: "captain",
          target: expect.objectContaining({ prNumber: 8 }),
        }),
      ]),
    );
    h.repos.configure(repoId, { autonomy: false });
    held.release();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED]));
    expect(h.crewmate.promptCalls.join("\n")).not.toContain("merge of #8 did not happen");
    await tick();
    expect(h.forge.merges).toEqual([REPAIRED]);
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F3: a reviewed pull request's merge that declared it
  // closes the task passes the same close rules as the task's own merge.
  it("keeps the task open when a reviewed pull request's merge closes it while one of its parts is open", async () => {
    const h = await approved({ referenced: true });
    const review = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.[0] as MergeReview;
    seedTask(h.tasks, {
      id: "part0001",
      title: "Label the meter",
      parentId: h.taskId,
      status: "queued",
    });
    await h.supervisor.steer.steerCrewmate(h.taskId, "merge it and close the task");
    await h.specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready to merge and close",
      body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
      actions: [
        {
          id: "merge",
          default: true,
          effect: { kind: "merge", review: review.id, after: "close" },
        },
        { id: "not-now", label: "Not now" },
      ],
    });
    h.crewmate.finishPrompt();
    await tick();
    const card = h.cards().find((entry) => entry.title === "Ready to merge and close") as Card;
    h.supervisor.cardActions.act(card.id, "merge");
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    await vi.waitFor(() =>
      expect(h.crewmate.promptCalls.join("\n")).toContain("parts of it are still open"),
    );
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });
});
