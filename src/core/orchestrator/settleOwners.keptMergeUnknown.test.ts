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

import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  gitRepo,
  KeptForge,
  REPAIRED,
  repair,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeError, ForgeMergeUnconfirmed } from "../forge";
import { seedTask } from "../tasks/seedTask";
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

  // INF-5193 (the review of Bitbucket's proof): a numbered pull request that
  // merged at a push made during its merge ends the approval with its outcome
  // known, so its send reserves the pull request no more and is told once.
  it("releases a numbered pull request's send once it merged at a later push, and tells it once", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    const putIn = h.forge.putIn.bind(h.forge);
    h.forge.putIn = async (...args) => {
      const answer = await putIn(...args);
      // A push landed between the read and the host's merge, which took it.
      h.forge.headSha = REPAIRED;
      return { ...answer, mergedHead: REPAIRED };
    };
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() =>
      expect(h.authorization()).toMatchObject({
        status: "invalidated",
        reason: "the pull request merged at a different version",
      }),
    );
    expect(h.authorization()?.attempt).toBeUndefined();
    expect(h.tasks.unresolvedMergeSends().map((record) => record.id)).not.toContain(h.taskId);
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now());
    const told = otherMergedFacts("GitHub", "#7", REPAIRED, APPROVED).told.trim();
    expect(
      h.tasks
        .timeline(h.taskId)
        .filter((event) => event.kind === "note" && event.text.includes(told)),
    ).toHaveLength(1);
    expect(h.forge.sends).toBe(1);
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
  // the click is still pending at the next launch; it is not sent again,
  // whether its approval still stands (the kept run reads that merge back,
  // by the host's own reference to it) or was withdrawn after it left.
  it.each(["stands", "was withdrawn", "was ended by guidance"] as const)(
    "reads a merge a quit interrupted back at launch on a host naming no version while its approval %s, and sends it once",
    async (approval) => {
      const h = await approved();
      h.forge.mergeNamesNoVersion = true;
      h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      expect(h.authorization()?.attempt?.task).toBe("7/merge-task-1");
      h.forge.refuse = undefined;
      h.crewmate.finishPrompt();
      await tick();
      expect(h.forge.sends).toBe(1);
      if (approval === "was withdrawn")
        h.supervisor.settling.approvals.endAuthorization(
          h.taskId,
          "revoked",
          "the captain withdrew it",
        );
      if (approval === "was ended by guidance") {
        await h.supervisor.steer.steerCrewmate(h.taskId, "Add a footer as well", "captain");
        await h.declare({
          captainGuidance: {
            mark: 1,
            impact: "changed-work",
            evidence: "The captain asks for more work.",
          },
        });
      }
      await h.supervisor.disposeAll();
      const seen = h.tasks.timeline(h.taskId).length;
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
          readPull: (id, number, mergeTask, place) =>
            delivery.merges.pullState(id, number, mergeTask, place),
        },
      );
      supervisor.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
      await vi.waitFor(() => expect(tasks.get(h.taskId)?.pendingSettle).toBeNull());
      await tick();
      expect(tasks.get(h.taskId)?.delivery?.mergeAuthorization).toMatchObject({
        status: {
          stands: "standing",
          "was withdrawn": "revoked",
          "was ended by guidance": "invalidated",
        }[approval],
        attempt: { head: APPROVED, task: "7/merge-task-1" },
      });
      expect(h.forge.sends).toBe(1);
      // The interrupted click is retired, never replayed into a refusal.
      expect(
        tasks
          .timeline(h.taskId)
          .slice(seen)
          .some(
            (event) => event.data?.refused === "merge-pr" || event.text.includes("Cannot merge"),
          ),
      ).toBe(false);
      if (approval === "stands") {
        h.forge.merged = true;
        await supervisor.settling.kept.runMergeAuthorization(h.taskId);
        await vi.waitFor(() =>
          expect(tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("consumed"),
        );
        expect(h.forge.sends).toBe(1);
      }
      resumed.finishPrompt();
      await tick();
      await supervisor.disposeAll();
    },
  );

  // INF-5193: the first mate's own merge call, permitted with autonomy on,
  // runs under no kept approval, so on a host whose merge names no version it
  // is refused at the send: it could neither see a merge sent earlier whose
  // outcome is unknown nor record its own.
  it("refuses the first mate's own merge on a host naming no version, while an earlier merge is unknown, and sends nothing", async () => {
    const h = await approved();
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    vi.spyOn(h.supervisor.facts, "taskAutonomy").mockReturnValue(true);
    const text = await h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr");
    expect(text).toContain("only under the captain's merge approval");
    expect(h.forge.sends).toBe(1);
    expect(h.authorization()).toMatchObject({
      status: "standing",
      attempt: { head: APPROVED, task: "7/merge-task-1" },
    });
    await h.supervisor.disposeAll();
  });

  // INF-5193: a kept approval's own send refuses at the send while it holds
  // a merge sent earlier that was never read back, and that refusal is a
  // wait on the outcome that keeps the earlier attempt; a stop before the
  // send, such as a moved branch, keeps it too, since only the attempt a
  // send recorded itself is spent by its answer.
  it.each(["at the send", "at a moved branch"] as const)(
    "keeps a merge sent earlier whose outcome is unknown when a later run under the same approval stops %s",
    async (where) => {
      const h = await approved();
      h.forge.mergeNamesNoVersion = true;
      h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      h.forge.refuse = undefined;
      h.crewmate.finishPrompt();
      await tick();
      const earlier = h.authorization()?.attempt;
      expect(earlier?.task).toBe("7/merge-task-1");
      if (where === "at a moved branch") h.forge.headSha = REPAIRED;
      const result = await h.supervisor.settling.settle.reportCardSettle(h.taskId, "merge-pr");
      expect(result).toMatchObject({
        ok: false,
        stop: where === "at the send" ? "outcome" : "moved",
      });
      if (where === "at the send") expect(result.text).toContain("still being read back");
      expect(h.forge.sends).toBe(1);
      expect(h.authorization()).toMatchObject({ status: "standing", attempt: earlier });
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193: a second task that approves the same pull request sends no
  // merge while another task holds a merge of it whose outcome is unknown.
  it("sends no merge of a pull request another task sent a merge of whose outcome is unknown", async () => {
    const h = await approved();
    h.forge.mergeNamesNoVersion = true;
    // The other task's approval of this pull request, its merge sent
    // while the click's own merge still reads.
    h.forge.beforeLeaving = async () => {
      const standing = h.authorization();
      if (!standing) throw new Error("Missing approval");
      seedTask(h.tasks, { id: "task-earlier", title: "Earlier work", status: "idle" });
      seedDelivery(h.tasks, "task-earlier", {
        mergeAuthorization: {
          ...standing,
          id: "approval-earlier",
          attempt: { token: "sent-earlier", head: APPROVED, at: Date.now() },
        },
      });
    };
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    expect(h.forge.sends).toBe(0);
    expect(h.authorization()?.attempt).toBeUndefined();
    expect(h.tasks.get("task-earlier")?.delivery?.mergeAuthorization?.attempt?.token).toBe(
      "sent-earlier",
    );
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.disposeAll();
  });

  // INF-5193: a merge whose outcome is unknown outlives its task's close,
  // and the pull request stays reserved from another task's approval of
  // it, saved under another spelling of the same repository, until a read
  // in the repository the first approval pinned settles it.
  it("keeps a closed task's unknown merge reserved from a second task approving the same pull request under another spelling, until a read settles it", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.settling.closing.closeTask(h.taskId, {
      status: "dropped",
      reason: "discarded",
      actor: "host",
    });
    expect(h.authorization()).toMatchObject({
      status: "revoked",
      attempt: { head: APPROVED, task: "7/merge-task-1" },
    });
    // A second task on the same repository, saved with its owner and name
    // in capitals, reviews and approves the same pull request.
    const { dir } = gitRepo("meter-again");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/O/R.git"]);
    const { repo } = await h.repos.setup({ kind: "adopt", path: dir, name: "meter-again" });
    h.repos.configure(repo.id, { delivery: "direct-pr", rigor: "quick" });
    const { taskId: second } = await h.supervisor.intake.commission({
      title: "Ship the meter again",
      intent: intentOf("Ship the meter fix again"),
      repoId: repo.id,
    });
    await tick();
    await h.checkService.checkTool.checkForCrew(second, { pull: 7 });
    const review = h.tasks.get(second)?.delivery?.mergeReviews?.[0];
    if (!review) throw new Error("Missing the second task's review");
    expect(review).toMatchObject({ owner: "O", name: "R" });
    await h.specs[1]?.onCard?.({
      requiredActions: [],
      title: "Ready to merge the same pull request",
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
    h.reviewer.finishPrompt();
    await tick();
    const card = h.cards().find((item) => item.title === "Ready to merge the same pull request");
    if (!card) throw new Error("Missing the second task's merge card");
    const secondApproval = () => h.tasks.get(second)?.delivery?.mergeAuthorization;
    h.supervisor.cardActions.act(card.id, "merge");
    await vi.waitFor(() => expect(secondApproval()?.waiting?.on).toBe("outcome"));
    expect(h.forge.sends).toBe(1);
    expect(secondApproval()?.attempt).toBeUndefined();
    // Bitbucket finishes the first merge: the read settles the closed
    // task's send, says so on it, and the pull request is reserved no more.
    h.forge.merged = true;
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now());
    expect(h.authorization()?.attempt).toBeUndefined();
    expect(h.tasks.unresolvedMergeSends().map((record) => record.id)).not.toContain(h.taskId);
    expect(
      h.tasks.timeline(h.taskId).some((event) => event.text.includes("The merge sent earlier")),
    ).toBe(true);
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });

  // INF-5193 (the review of Bitbucket's merge): a send whose task closed is
  // read where its approval pinned it, even once the task's own project
  // delivers no pull requests or is no longer managed, and a later push
  // that went in with it is told against the version that send approved.
  it.each([
    ["switches to local merges", "local-only"],
    ["is removed", "removed"],
  ] as const)(
    "reads a closed task's unknown merge back after its project %s, and tells a later version merging",
    async (_, change) => {
      const h = await approved({ referenced: true });
      h.forge.mergeNamesNoVersion = true;
      h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
      h.forge.refuse = undefined;
      h.crewmate.finishPrompt();
      await tick();
      await h.supervisor.settling.closing.closeTask(h.taskId, {
        status: "dropped",
        reason: "discarded",
        actor: "host",
      });
      // Another managed project still points at the same repository, saved
      // with its owner and name in capitals.
      const { dir } = gitRepo("meter-again");
      execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/O/R.git"]);
      await h.repos.setup({ kind: "adopt", path: dir, name: "meter-again" });
      const own = h.tasks.get(h.taskId)?.repoId;
      if (!own) throw new Error("Missing the task's project");
      if (change === "removed") h.repos.unregister(own);
      else h.repos.configure(own, { delivery: change });
      // Bitbucket merged the pull request at a version pushed after the click.
      h.forge.merged = true;
      h.forge.headSha = REPAIRED;
      await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now());
      expect(h.authorization()?.attempt).toBeUndefined();
      expect(h.tasks.unresolvedMergeSends().map((record) => record.id)).not.toContain(h.taskId);
      const note = h.tasks
        .timeline(h.taskId)
        .find((event) => event.text.includes("The merge sent earlier"));
      expect(note?.text).toContain(
        otherMergedFacts("GitHub", "#7", REPAIRED, APPROVED).told.trim(),
      );
      expect(note?.text).toContain("went in on GitHub");
      expect(h.forge.sends).toBe(1);
      await h.supervisor.disposeAll();
    },
  );

  // INF-5193 (the review of Bitbucket's merge): a project repointed to
  // another host while its task still publishes under the old origin never
  // answers for the pinned repository; a managed project still pointing
  // there, under another spelling, does.
  it("reads a closed task's unknown merge back through the project still pointing at its repository, not the one repointed to another host", async () => {
    const repointed = new KeptForge("gitlab");
    repointed.merged = true;
    const h = await approved({
      referenced: true,
      forgeFor: (repo, own) => (repo?.host?.kind === "gitlab" ? repointed : own),
    });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.settling.closing.closeTask(h.taskId, {
      status: "dropped",
      reason: "discarded",
      actor: "host",
    });
    const own = h.tasks.get(h.taskId)?.repoId;
    if (!own) throw new Error("Missing the task's project");
    seedDelivery(h.tasks, h.taskId, { publicationOrigin: "https://github.com/o/r.git" });
    h.repos.configure(own, { origin: "https://gitlab.com/o/r.git" });
    const { dir } = gitRepo("meter-again");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/O/R.git"]);
    await h.repos.setup({ kind: "adopt", path: dir, name: "meter-again" });
    // The repointed host reads merged; the pinned repository still reads open.
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now());
    expect(h.authorization()?.attempt).toMatchObject({ head: APPROVED });
    expect(h.tasks.unresolvedMergeSends().map((record) => record.id)).toContain(h.taskId);
    // The pinned repository reads merged: that read settles it, said on GitHub.
    h.forge.merged = true;
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now() + 3_600_000);
    expect(h.authorization()?.attempt).toBeUndefined();
    const note = h.tasks
      .timeline(h.taskId)
      .find((event) => event.text.includes("The merge sent earlier"));
    expect(note?.text).toContain("went in on GitHub");
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });

  // INF-5193: a read with no state Bitbucket names is unreadable, so it
  // releases no reservation and lets no second merge be sent.
  it("keeps a closed task's unknown merge reserved through a read with no state Bitbucket names", async () => {
    const h = await approved({ referenced: true });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.settling.closing.closeTask(h.taskId, {
      status: "dropped",
      reason: "discarded",
      actor: "host",
    });
    const pull = h.forge.pull.bind(h.forge);
    h.forge.pull = async () => {
      throw new ForgeError(
        "transient",
        "Bitbucket answered pull request 7 without a state it names; read it again.",
      );
    };
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now());
    expect(h.authorization()?.attempt).toMatchObject({ head: APPROVED });
    expect(h.tasks.unresolvedMergeSends().map((record) => record.id)).toContain(h.taskId);
    h.forge.pull = pull;
    h.forge.merged = true;
    await h.supervisor.settling.kept.reconcileUnsettledSends(Date.now() + 3_600_000);
    expect(h.authorization()?.attempt).toBeUndefined();
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });

  // INF-5193: the read right after a merge whose answer never came asks the
  // repository the approval pinned, never another managed project whose
  // pull request of the same number was selected while the merge was out.
  it("reads a merge whose answer never came back at once in the repository its approval pinned", async () => {
    const other = new KeptForge();
    other.merged = true;
    const h = await approved({
      forgeFor: (repo, own) => (repo?.origin?.includes("/o/other") ? other : own),
    });
    h.forge.mergeNamesNoVersion = true;
    const { dir } = gitRepo("other");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/other.git"]);
    const { repo } = await h.repos.setup({ kind: "adopt", path: dir, name: "other" });
    h.forge.refuse = new ForgeError("transient", "The answer never came");
    const putIn = h.forge.putIn.bind(h.forge);
    h.forge.putIn = async (...args) => {
      try {
        return await putIn(...args);
      } finally {
        seedDelivery(h.tasks, h.taskId, {
          checkTarget: {
            id: "review-other",
            repoId: repo.id,
            kind: "github",
            host: "github.com",
            owner: "o",
            name: "other",
            number: h.tasks.get(h.taskId)?.delivery?.prNumber ?? 0,
            headSha: APPROVED,
            base: "main",
            branch: "other-work",
            method: "squash",
            title: "Other work",
            at: Date.now(),
          },
        });
      }
    };
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    expect(h.authorization()).toMatchObject({ status: "standing", attempt: { head: APPROVED } });
    expect(h.forge.sends).toBe(1);
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.disposeAll();
  });

  // INF-5193: the read-back of a merge whose outcome is unknown asks the
  // repository the approval pinned, never another managed project whose
  // pull request of the same number is the one selected now.
  it("reads an unknown merge back in the repository its approval pinned, not another project's pull request of the same number", async () => {
    const other = new KeptForge();
    other.merged = true;
    const h = await approved({
      referenced: true,
      forgeFor: (repo, own) => (repo?.origin?.includes("/o/other") ? other : own),
    });
    h.forge.mergeNamesNoVersion = true;
    h.forge.refuse = new ForgeMergeUnconfirmed("The host took the merge", "7/merge-task-1");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("outcome"));
    h.forge.refuse = undefined;
    h.crewmate.finishPrompt();
    await tick();
    // Another managed project, whose pull request #7 merged, is selected now.
    const { dir } = gitRepo("other");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/other.git"]);
    const { repo } = await h.repos.setup({ kind: "adopt", path: dir, name: "other" });
    const first = h.authorization()?.review;
    if (!first) throw new Error("Missing review");
    seedDelivery(h.tasks, h.taskId, {
      checkTarget: { ...first, id: "review-other", repoId: repo.id, name: "other" },
    });
    await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
    expect(h.authorization()).toMatchObject({
      status: "standing",
      waiting: { on: "outcome" },
      attempt: { head: APPROVED },
    });
    expect(h.forge.sends).toBe(1);
    await h.supervisor.disposeAll();
  });
});
