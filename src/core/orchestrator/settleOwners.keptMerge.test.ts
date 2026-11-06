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

import type { Card } from "@shared/cards";
import { softHoldWords } from "@shared/holds";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import {
  CHECK_WORDS,
  MERGE_AFTER_FIXING_WORDS,
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
} from "@shared/vocabulary";
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
  gitRepo,
  kept,
  REPAIRED,
  repair,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { deferred } from "../../../tests/helpers/deferred";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { type Forge, type ForgeChange, type ForgeCheckState, ForgeError } from "../forge";
import { TaskService } from "../tasks/taskService";
import { type ChangeDelivery, createChangeDelivery } from "./changeDelivery";
import { COMPLETION_REVISED_WHILE_RUNNING } from "./crewmateCards";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisor } from "./crewSupervisor";
import { keptFeedLine } from "./mergeAuthorization";
import { POLICY_GUIDANCE_HEADING } from "./noticeWakes";
import {
  closingNoteTitle,
  MERGE_PENDING_TITLE,
  mergePendingBody,
  mergePendingCardId,
} from "./settleWords";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it.each(["rework", "cancel-idle", "cancel-running", "failed"] as const)(
    "closes an abandoned direct-pr attempt's PR on %s and records the outcome",
    async (path) => {
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
      const { supervisor, tasks, workspace, repos } = setup(crewmate, { closePullRequest });
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
      } else if (path === "failed") {
        crewmate.failPrompt("The client exited.");
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
        closedReason: path === "rework" ? "superseded" : path === "failed" ? "failed" : "cancelled",
      });
      expect(tasks.timeline(taskId)).toContainEqual(
        expect.objectContaining({ text: "Closed PR #9 on GitHub." }),
      );
      expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
      );
    },
  );

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

    it("INF-1246 a new referenced merge offer supersedes the kept approval before any new click", async () => {
      const h = await continued();
      await h.emit("Read the merge again");
      expect(h.authorization()?.status).toBe("superseded");
      h.crewmate.finishPrompt();
      await tick();
      expect(h.forge.merges).toEqual([]);
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
          ?.actions.find(
            (action) =>
              action.effect?.kind === "settle" && action.effect.mode === "merge" && !action.passes,
          )?.label;
      expect(label()).toBe(MERGE_WORDS["merge-pr"]);
      const readings: [ForgeCheckState[], string][] = [
        [["failure"], MERGE_AFTER_FIXING_WORDS],
        [["success", "pending"], MERGE_WHEN_CHECKS_PASS_WORDS],
        [["success"], MERGE_WORDS["merge-pr"]],
        [["failure"], MERGE_AFTER_FIXING_WORDS],
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

    // INF-1275, the captain's ask: a merge click shows a visible pending
    // state until the merge happens or says why it could not.
    it("keeps a clicked merge in view as pending, says what it waits for, and takes the note down once it merges", async () => {
      const h = await approved();
      const pending = () => h.cards().find((card) => card.id === mergePendingCardId(h.taskId));
      h.forge.states = ["failure"];
      await h.declare({});
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      const title = h.tasks.get(h.taskId)?.title ?? "";
      expect(pending()).toMatchObject({
        title: MERGE_PENDING_TITLE,
        author: "host",
        actions: [],
        body: mergePendingBody(keptFeedLine("checks", "GitHub", "red"), title),
      });
      // The merged task's working copy is still being removed when its close is recorded.
      const cleanup = deferred<void>();
      vi.mocked(h.workspace.removeTaskWorktree).mockReturnValue(cleanup.promise);
      await repairTurn(h, async () => {
        h.forge.states = ["success"];
      });
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      // The note leaves with the close itself: no reader sees the task
      // merged while it still says pending.
      await vi.waitFor(() => expect(h.tasks.get(h.taskId)?.closedReason).toBe("merged"));
      expect(pending()).toBeUndefined();
      cleanup.resolve();
    });

    // INF-1275 (review INF-2549): a request_merge click stays in view as a
    // completion card's does, and the note leaves once that merge goes through.
    it("keeps a clicked request_merge review in view as pending and takes the note down once it merges", async () => {
      const h = await approved({ referenced: true });
      const pending = () => h.cards().find((card) => card.id === mergePendingCardId(h.taskId));
      h.forge.readiness = "conflict";
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("conflict"));
      expect(pending()).toMatchObject({ title: MERGE_PENDING_TITLE, author: "host", actions: [] });
      expect(h.forge.merges).toEqual([]);
      h.forge.readiness = "clean";
      await repairTurn(h, async () => {});
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      // A referenced merge keeps its task open; the note still goes.
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
      expect(pending()).toBeUndefined();
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
          ?.actions.find(
            (action) =>
              action.effect?.kind === "settle" && action.effect.mode === "merge" && !action.passes,
          );
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
      expect(merge()?.label).toBe(MERGE_WHEN_CHECKS_PASS_WORDS);
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
        h.supervisor.close(story.id);
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
        h.supervisor.close(finding.id);
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

    it("an explicit live self-merging request releases only the routine completion wait and permits ready work", async () => {
      const h = await approved();
      seedDelivery(h.tasks, h.taskId, {
        captainWait: { at: Date.now(), cardId: h.card.id, reason: "Read the result" },
      });
      editPolicies(h, { autonomy: true });
      await tick();
      expect(h.cards().find((card) => card.id === h.card.id)).toBeUndefined();
      expect(h.tasks.get(h.taskId)?.delivery?.captainWait).toBeUndefined();
      expect(h.ops.some((text) => text.includes("Current policies"))).toBe(true);
      expect(
        h.inbox.allFor(h.taskId).some((row) => row.facts?.kind === "task-policies-changed"),
      ).toBe(true);
      expect(h.crewmate.promptCalls).toHaveLength(1);
      const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(result.text).toContain("Merged");
      expect(h.forge.merges).toEqual([APPROVED]);
      expect(h.tasks.get(h.taskId)?.status).toBe("done");
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
        .find((event) => event.kind === "note" && event.text.includes("Care: Careful"));
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
                `the app started review ${review?.key} of the version on the merge card`,
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

    it("says in the feed when the app cannot start the review from the merge card, and the care still rose", async () => {
      const h = await approved();
      const careful = h.card.actions.find((action) => action.care);
      // No commits to read on the branch: nothing to review yet.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(null);
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
      expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.review).toBe("review passed");
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
      expect(card?.body).toContain('>Care</span><span class="inf-fact-v">Default<');
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
      const merge = card?.actions.find(
        (action) => action.effect?.kind === "settle" && action.effect.mode === "merge",
      );
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
});
