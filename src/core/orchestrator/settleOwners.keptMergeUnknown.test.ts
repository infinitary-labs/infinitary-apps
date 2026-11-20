/**
 * A merge whose outcome is unknown on a host whose merge names no version
 * (Bitbucket), as the settle owners hold it: the attempt recorded only as
 * the request leaves, kept read-only through refused reads, ended
 * approvals, the next merge card's click and a quit, and the merged version
 * told against the version the original send was approved at.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */

import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  reboot,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  REPAIRED,
  repair,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeError, ForgeMergeUnconfirmed } from "../forge";
import { TaskService } from "../tasks/taskService";
import { createChangeDelivery } from "./changeDelivery";
import { otherMergedFacts } from "./changeMerge";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("a kept merge whose outcome is unknown on a host naming no version (INF-5193)", () => {
  // INF-5193 (the review of Bitbucket's merge): a merge sent to a host
  // whose merge names no version may still go in after an open read, so
  // the attempt stays read-only across runs until a read shows it merged.
  it("keeps an unknown merge on a host naming no version read-only, then spends the approval once it reads merged", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeError(
      "transient",
      "The host accepted the merge and has not finished it",
    );
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    expect(h.authorization()?.attempt?.head).toBe(APPROVED);
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.forge.sends).toBe(1);
    expect(h.authorization()).toMatchObject({
      status: "standing",
      attempt: { head: APPROVED },
      waiting: { on: "outcome" },
    });
    h.forge.merged = true;
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    await vi.waitFor(() =>
      expect(h.tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
    );
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });

  // INF-5193: a failure before the merge request left sent nothing, so
  // the approval is not held as a merge whose outcome is unknown.
  it.each([
    ["the task's own pull request", false],
    ["a numbered pull request", true],
  ])(
    "treats a failure before the merge of %s was sent on a host naming no version as nothing sent",
    async (_case, referenced) => {
      const h = await approved({ referenced });
      h.forge.mergeNamesNoVersion = true;
      h.forge.refuse = new ForgeError("transient", "The branch could not be read", true);
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("transient"));
      expect(h.authorization()?.attempt).toBeUndefined();
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193: on a host whose merge names no version, the approval's last
  // check and its attempt record run as the request leaves, so a merge
  // interrupted while it still reads holds no attempt, and an approval
  // that ends during those reads sends nothing.
  it.each([
    ["the task's own pull request", false],
    ["a numbered pull request", true],
  ])(
    "records the attempt for %s only as the merge request leaves on a host naming no version",
    async (_case, referenced) => {
      const h = await approved({ referenced });
      h.forge.mergeNamesNoVersion = true;
      let release: () => void = () => {};
      let reading = false;
      h.forge.beforeLeaving = () =>
        new Promise<void>((resolve) => {
          reading = true;
          release = resolve;
        });
      let answered = false;
      const putIn = h.forge.putIn.bind(h.forge);
      h.forge.putIn = async (...args) => {
        try {
          return await putIn(...args);
        } finally {
          answered = true;
        }
      };
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(reading).toBe(true));
      expect(h.authorization()?.attempt).toBeUndefined();
      h.supervisor.settling.approvals.endAuthorization(
        h.taskId,
        "superseded",
        "a new merge card is up",
      );
      release();
      expect(h.authorization()?.status).toBe("superseded");
      await vi.waitFor(() => expect(answered).toBe(true));
      expect(h.forge.sends).toBe(0);
      expect(h.authorization()?.attempt).toBeUndefined();
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193: the captain's newer guidance can arrive while a merge on a
  // host naming no version still reads; it is read again as the request
  // leaves, so it holds the merge and sends nothing.
  it.each([
    ["the task's own pull request", false],
    ["a numbered pull request", true],
  ])(
    "holds the merge of %s for guidance that arrives while it reads on a host naming no version",
    async (_case, referenced) => {
      const h = await approved({ referenced });
      h.forge.mergeNamesNoVersion = true;
      h.forge.beforeLeaving = async () => {
        await h.supervisor.steer.steerCrewmate(h.taskId, "Keep the same approved work", "captain");
      };
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("guidance"));
      expect(h.forge.sends).toBe(0);
      expect(h.authorization()?.attempt).toBeUndefined();
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193: the host's own reference to a merge it took is kept; a
  // refusal of its read does not say the merge failed (the task may not
  // be this pull request's), so the merge stays unsent and read-only, even
  // through the captain's new approval, until the pull request reads merged.
  it("keeps a merge the host took read-only through a refused read and a new approval, until it reads merged", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.attempt?.task).toBe("7/merge-task-1"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.forge.sends).toBe(1);
    expect(h.authorization()?.attempt?.task).toBe("7/merge-task-1");
    h.forge.refusedTasks.add("7/merge-task-1");
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.authorization()).toMatchObject({ status: "standing", waiting: { on: "outcome" } });
    expect(h.authorization()?.attempt).toBeDefined();
    expect(h.authorization()?.attempt?.task).toBeUndefined();
    expect(h.forge.sends).toBe(1);
    // The captain's approval ends and a new one of the same pull request
    // is given: it reads the earlier merge back and sends nothing.
    const review = h.authorization()?.review?.id;
    h.supervisor.settling.approvals.endAuthorization(
      h.taskId,
      "superseded",
      "a new merge card is up",
    );
    expect(
      h.supervisor.settling.approvals.authorizeMerge(
        h.taskId,
        {
          cardId: h.card.id,
          ...(h.card.lifecycleId ? { lifecycleId: h.card.lifecycleId } : {}),
          ...(h.card.offerId ? { offerId: h.card.offerId } : {}),
          actionId: "merge",
        },
        false,
        review,
      ),
    ).toBe("standing");
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.authorization()?.waiting?.on).toBe("outcome");
    expect(h.forge.sends).toBe(1);
    // Bitbucket finishes the merge it took: the approval is spent once.
    h.forge.merged = true;
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    await vi.waitFor(() =>
      expect(h.tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
    );
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });

  // INF-5193: a merge whose outcome is unknown stays with its pull
  // request through another pull request's approval, so approving it again
  // sends nothing; and the version Bitbucket merged is told against the
  // version the original send was approved at, not a later approval's.
  it("keeps an unknown merge through another pull request's approval and tells the merged version against the original send's", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    const first = h.authorization()?.review;
    if (!first) throw new Error("Missing review");
    const approval = {
      cardId: h.card.id,
      ...(h.card.lifecycleId ? { lifecycleId: h.card.lifecycleId } : {}),
      ...(h.card.offerId ? { offerId: h.card.offerId } : {}),
      actionId: "merge",
    };
    const approve = (review: string) =>
      h.supervisor.settling.approvals.authorizeMerge(h.taskId, approval, false, review);
    // The captain approves another pull request in its place.
    h.supervisor.settling.approvals.endAuthorization(
      h.taskId,
      "superseded",
      "a new merge card is up",
    );
    const reviews = h.tasks.get(h.taskId)?.delivery?.mergeReviews ?? [];
    seedDelivery(h.tasks, h.taskId, {
      mergeReviews: [
        ...reviews,
        { ...first, id: "review-other", number: 8, branch: "fm/task-other" },
      ],
    });
    expect(approve("review-other")).toBe("standing");
    expect(h.authorization()?.attempt).toBeUndefined();
    // Then approves the first pull request again, at a newer version.
    h.supervisor.settling.approvals.endAuthorization(
      h.taskId,
      "superseded",
      "a new merge card is up",
    );
    h.forge.headSha = REPAIRED;
    seedDelivery(h.tasks, h.taskId, {
      mergeReviews: (h.tasks.get(h.taskId)?.delivery?.mergeReviews ?? []).map((review) =>
        review.id === first.id ? { ...review, headSha: REPAIRED } : review,
      ),
    });
    expect(approve(first.id)).toBe("standing");
    expect(h.authorization()?.attempt?.head).toBe(APPROVED);
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.authorization()?.waiting?.on).toBe("outcome");
    expect(h.forge.sends).toBe(1);
    // Bitbucket merged the newer version under the original send.
    h.forge.merged = true;
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    await vi.waitFor(() =>
      expect(h.tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
    );
    expect(h.forge.sends).toBe(1);
    // The task says GitHub merged the newer version, not the version the
    // original send was approved at, in the merge path's own words.
    const told = otherMergedFacts("GitHub", "#7", REPAIRED, APPROVED).told.trim();
    expect(told).not.toBe("");
    expect(
      h.tasks
        .timeline(h.taskId)
        .some((event) => event.kind === "note" && event.text.includes(told)),
    ).toBe(true);
    await h.supervisor.disposeAll();
  });

  // INF-5193 (the review of Bitbucket's merge): a merge whose outcome is
  // unknown outlives an approval that guidance or a repair ends, and the
  // captain's click on the next merge card reads it back and sends nothing.
  it.each([
    ["the task's own pull request", "guidance", false],
    ["a numbered pull request", "guidance", true],
    ["the task's own pull request", "repair", false],
    ["a numbered pull request", "repair", true],
  ] as const)(
    "keeps an unknown merge of %s through a %s that ends its approval, and the next card's click sends nothing",
    async (_case, end, referenced) => {
      const h = await approved({ referenced });
      h.forge.mergeNamesNoVersion = true;
      h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      h.forge.refuse = undefined;
      h.crewmate.finishPrompt();
      await tick();
      expect(h.forge.sends).toBe(1);
      if (end === "guidance") {
        await h.supervisor.steer.steerCrewmate(h.taskId, "Add a footer as well", "captain");
        await h.declare({
          captainGuidance: {
            mark: 1,
            impact: "changed-work",
            evidence: "The captain asks for more work.",
          },
        });
      } else {
        h.forge.headSha = REPAIRED;
        await h.declare(repair("changed-work"));
      }
      expect(h.authorization()).toMatchObject({ status: "invalidated" });
      expect(h.authorization()?.attempt?.head).toBe(APPROVED);
      // A numbered pull request's new card names its review at the
      // version it now reads.
      if (referenced && end === "repair")
        seedDelivery(h.tasks, h.taskId, {
          mergeReviews: (h.tasks.get(h.taskId)?.delivery?.mergeReviews ?? []).map((item) => ({
            ...item,
            headSha: REPAIRED,
          })),
        });
      const review = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.at(-1);
      await repairTurn(h, async () => {
        if (!referenced || !review) return void (await h.emit("Ready to merge again"));
        await h.specs[0]?.onCard?.({
          requiredActions: [],
          title: "Ready to merge again",
          body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
          actions: [
            {
              id: "merge",
              default: true,
              effect: { kind: "merge", review: review.id, after: "continue" },
            },
            { id: "not-now", label: "Not now" },
          ],
        });
      });
      const again = h.cards().find((card) => card.title === "Ready to merge again");
      if (!again) throw new Error("Missing the new merge card");
      h.supervisor.cardActions.act(again.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.status).toBe("standing"));
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      expect(h.authorization()?.attempt?.head).toBe(APPROVED);
      expect(h.forge.sends).toBe(1);
      // Bitbucket finishes the merge it took: the approval is spent once.
      h.forge.merged = true;
      h.crewmate.finishPrompt();
      await tick();
      await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
      await vi.waitFor(() => expect(h.authorization()?.status).toBe("consumed"));
      expect(h.forge.sends).toBe(1);
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193: the app quit after the captain's click sent the merge, so
  // the click is still pending at the next launch; the kept run reads that
  // merge back and the click is not sent again.
  it("reads a merge a quit interrupted back at launch on a host naming no version, and sends it once", async () => {
    const h = await approved();
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
    h.tasks.delivery.setPendingSettle(h.taskId, {
      mode: "merge-pr",
      actor: "captain",
      requestedAt: Date.now(),
      proceedWithOpen: false,
    });
    const tasks = new TaskService({ db: h.db, strict: true });
    const delivery = createChangeDelivery({ tasks, repos: h.repos, forgeFor: () => h.forge });
    const resumed = fakeCrewmate();
    const supervisor = reboot(
      { paths: h.paths, db: h.db, workspace: h.workspace },
      vi.fn(async () => resumed),
      {
        repos: h.repos,
        tasks,
        mergePullRequest: (id, guard, beforeDispatch) =>
          delivery.merges.merge(id, guard, beforeDispatch),
        readPull: (id, number, mergeTask) => delivery.merges.pullState(id, number, mergeTask),
      },
    );
    supervisor.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    await vi.waitFor(() => expect(tasks.get(h.taskId)?.pendingSettle).toBeNull());
    await tick();
    expect(tasks.get(h.taskId)?.delivery?.mergeAuthorization).toMatchObject({
      status: "standing",
      attempt: { head: APPROVED },
    });
    expect(h.forge.sends).toBe(1);
    h.forge.merged = true;
    await supervisor.settling.kept.runMergeAuthorization(h.taskId);
    await vi.waitFor(() =>
      expect(tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
    );
    expect(h.forge.sends).toBe(1);
    resumed.finishPrompt();
    await tick();
    await supervisor.disposeAll();
  });
});
