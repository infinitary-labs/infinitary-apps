/**
 * The captain's kept merge approval (FI3-304) through merges made
 * elsewhere, other pull requests and repairs: a pull request merged by hand,
 * a merge card shown for one pull request among several, repairs declared
 * with their impact and their independent assessment, the host's branch
 * rules, and every way the approval is taken back.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Card, MERGE_CLOSES_WORDS, splitSettleFacts } from "@shared/cards";
import { REPAIR_ASSESSMENT_SOURCE } from "@shared/checkRepair";
import type { MergeReview } from "@shared/mergeReview";
import { CHECK_WORDS, MERGE_WHEN_CHECKS_PASS_WORDS, MERGE_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  reportTurn,
  SETTLE_MERGE,
  settleLines,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  cleanFacts,
  conflict,
  editPolicies,
  kept,
  NEW_BASE,
  REPAIRED,
  repair,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { deferred } from "../../../tests/helpers/deferred";
import { AT, CODEX, row, snapshot } from "../../../tests/helpers/placedWorkRecord";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgePull } from "../forge";
import { buildModelsCatalog } from "../quota/catalog";
import type { QuotaService } from "../quota/quotaService";
import { type PreparedRouteOptions, Router } from "../routing/router";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { seedTask } from "../tasks/seedTask";
import { CardChoiceUnavailableError } from "./cardActions";
import type { PrOutcome } from "./changeMerge";
import { ASSESSMENT_BOUND_MS, keptFeedLine } from "./mergeAuthorization";
import { Ticker } from "./ticker";
import { GUIDANCE_MARK_WORDS, renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  describe("the captain's kept merge approval (FI3-304)", () => {
    it("self-merging preserves explicit withdrawal and unrelated decisions", async () => {
      const h = await kept();
      h.supervisor.withdrawMergeApproval(h.taskId);
      await repairTurn(h, async () => {
        await h.emit("Approval after withdrawal");
      });
      expect(h.cards().some((card) => card.title === "Approval after withdrawal")).toBe(true);
      editPolicies(h, { autonomy: true });
      expect(h.cards().some((card) => card.title === "Approval after withdrawal")).toBe(true);
      expect(
        (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).refusal
          ?.refused,
      ).toBe("autonomy-off");
      expect(h.forge.merges).toEqual([]);
      const other = await approved();
      // INF-2744: with its merge card up the app merges itself; this reads the first mate's merge.
      other.supervisor.cards.takeDown(other.card.id, "The first mate merges this one.");
      editPolicies(other, { autonomy: true });
      other.tasks.placement.setGate(other.taskId, { kind: "captain", ref: "unrelated-decision" });
      expect(
        (await other.supervisor.settling.settle.settleTaskDetailed(other.taskId, "merge-pr")).text,
      ).toContain("the task is parked on the captain");
      expect(other.forge.merges).toEqual([]);
    });

    it("explains a sent merge while accepting the next policy, without pretending the request can be stopped", async () => {
      const h = await approved();
      // INF-2744: with its merge card up the app merges itself; this reads the first mate's merge.
      h.supervisor.cards.takeDown(h.card.id, "The first mate merges this one.");
      editPolicies(h, { autonomy: true });
      const sent = deferred<void>();
      const answer = deferred<void>();
      h.forge.putIn = async (_change, head) => {
        sent.resolve();
        await answer.promise;
        h.forge.merges.push(head);
        return { sha: `squash-${head}` };
      };
      const merging = h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      await sent.promise;
      expect(editPolicies(h, { autonomy: false })).toContain("merge already sent");
      expect(h.supervisor.facts.taskAutonomy(h.taskId)).toBe(false);
      answer.resolve();
      await merging;
      expect(h.forge.merges).toEqual([APPROVED]);
      expect(h.tasks.get(h.taskId)?.status).toBe("done");
    });

    it("closes a task whose pull request was merged on GitHub by hand as merged, on the Firstmate's own settle (FI3-213)", async () => {
      const harness = await approved();
      const { supervisor, tasks, taskId, forge } = harness;
      // The project asks before merging: while #7 is open, the merge is the captain's.
      expect(supervisor.facts.taskAutonomy(taskId)).toBe(false);
      expect(
        (await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr")).refusal?.refused,
      ).toBe("autonomy-off");
      // The captain merges #7 on GitHub himself; the branch has no open pull request now.
      forge.merged = true;
      expect(await harness.declare({})).toContain("overall: merged");
      expect(tasks.get(taskId)?.delivery).toMatchObject({ ci: "merged", prNumber: 7 });
      const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(result.text).toBe("#7 is already merged on GitHub.");
      expect(result.refusal).toBeUndefined();
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      expect(forge.merges).toEqual([]);
    });

    it("closes it as merged on the captain's click too, sending nothing to GitHub (FI3-213)", async () => {
      const harness = await approved();
      harness.forge.merged = true;
      harness.supervisor.cardActions.act(harness.card.id, "merge");
      await vi.waitFor(() =>
        expect(harness.tasks.get(harness.taskId)).toMatchObject({
          status: "done",
          closedReason: "merged",
        }),
      );
      expect(harness.forge.merges).toEqual([]);
    });

    // INF-2490, the captain's q2 "fix now": RUU-35's release pull request,
    // on release-please's branch, merged while autonomy was on, and the first
    // mate's merge refused it as another branch's pull request. It closes as
    // merged with autonomy on or off, once none of the task's other pull
    // requests reads open (q4).
    it.each([
      ["on", true],
      ["off", false],
    ] as const)(
      "closes as merged on the first mate's settle with autonomy %s, once none of the task's other pull requests is open (INF-2490)",
      async (_label, autonomy) => {
        const harness = await approved({ referenced: true });
        const { supervisor, tasks, taskId, forge } = harness;
        if (autonomy) {
          // INF-2744: with its merge card up the app merges itself; this reads the first mate's merge.
          supervisor.cards.takeDown(harness.card.id, "The first mate merges this one.");
          editPolicies(harness, { autonomy: true });
        }
        expect(supervisor.facts.taskAutonomy(taskId)).toBe(autonomy);
        forge.merged = true;
        expect(await harness.declare({})).toContain("overall: merged");
        const next: MergeReview = {
          id: "review-next",
          kind: "github",
          host: "github.com",
          owner: "o",
          name: "r",
          number: 8,
          headSha: REPAIRED,
          base: "main",
          branch: "fm/task-next",
          method: "squash",
          title: "fix: label the meter",
          at: Date.now(),
        };
        seedDelivery(tasks, taskId, { mergeReviews: [next] });
        forge.openNumbers.add(8);
        const held = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
        expect(held.text).toContain("#8 on this task is still open");
        expect(tasks.get(taskId)?.status).not.toBe("done");
        // #8 merges too: nothing of the task is open, so it closes as merged.
        forge.openNumbers.delete(8);
        const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
        expect(result.text).toBe("#7 is already merged on GitHub.");
        expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        expect(forge.merges).toEqual([]);
      },
    );

    // INF-2546 R11, the captain's "with autonomy on, the first mate merges
    // the finishing change": the first mate's settle merges the task's
    // current change - here another branch's pull request - once, and closes
    // the task as merged; with autonomy off the same settle sends nothing.
    it("merges the current change on another branch on the first mate's settle with autonomy on, and closes the task as merged (INF-2546)", async () => {
      const harness = await approved({ referenced: true });
      const { supervisor, tasks, taskId, forge } = harness;
      expect(tasks.get(taskId)?.delivery?.checkTarget).toMatchObject({
        number: 7,
        branch: "fm/task-earlier",
      });
      const held = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(held.text).not.toContain("Merged");
      expect(forge.merges).toEqual([]);
      expect(tasks.get(taskId)?.status).not.toBe("done");
      // INF-1879: putting the question away grants no permission and leaves it open.
      // With autonomy on, its author withdraws the now-unnecessary question before the first mate merges.
      supervisor.close(harness.card.id);
      await tick();
      expect(harness.cards().find((card) => card.id === harness.card.id)?.minimized).toBe(true);
      expect(forge.merges).toEqual([]);
      // INF-2744: its author withdraws the question before autonomy turns on,
      // or the app would merge from the card itself.
      await harness.specs[0]?.onCloseCard?.({
        cardId: harness.card.id,
        reason: "The first mate owns this merge.",
      });
      editPolicies(harness, { autonomy: true });
      harness.crewmate.finishPrompt();
      await tick();
      const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(result.text).toContain("Merged #7");
      expect(forge.merges).toEqual([APPROVED]);
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      expect(
        tasks.changesFor(taskId).find((change) => change.head.branch === "fm/task-earlier")
          ?.receipt,
      ).toMatchObject({ outcome: "merged", reason: "merged" });
    });

    // INF-2546 R8, the captain's keep-open fallback: another pull request on
    // the task that cannot be read may still be open, so the first mate's
    // merge of the already-merged change keeps the task open and says so.
    it("keeps the task open on the first mate's settle while another of its pull requests cannot be read (INF-2546)", async () => {
      const harness = await approved({ referenced: true });
      const { supervisor, tasks, taskId, forge } = harness;
      forge.merged = true;
      expect(await harness.declare({})).toContain("overall: merged");
      const next: MergeReview = {
        id: "review-next",
        kind: "github",
        host: "github.com",
        owner: "o",
        name: "r",
        number: 8,
        headSha: REPAIRED,
        base: "main",
        branch: "fm/task-next",
        method: "squash",
        title: "fix: label the meter",
        at: Date.now(),
      };
      seedDelivery(tasks, taskId, { mergeReviews: [next] });
      // The capped review list forgets #8; the record keeps its change.
      seedDelivery(tasks, taskId, { mergeReviews: [] });
      expect(tasks.changesFor(taskId).map((change) => change.handle?.number)).toContain(8);
      forge.unreadable.add(8);
      const held = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(held.text).toContain("#8 on this task could not be read, so it may still be open");
      expect(tasks.get(taskId)?.status).not.toBe("done");
      // Read again and closed: nothing of the task is open, so it closes as merged.
      forge.unreadable.delete(8);
      const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(result.text).toBe("#7 is already merged on GitHub.");
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      expect(forge.merges).toEqual([]);
    });

    // INF-2525, the captain's words: "if they both got raised, then we
    // should make sure the merge card doesn't close the task directly", and
    // their written-in answer: "it should become the agent's judgment for
    // what's the appropriate next steps". A question up beside the merge
    // card: the click merges, the task and the question stay, the crewmate
    // hears what is still open, and only its own next step closes the task.
    it("merges on the captain's click with a question open, keeps the task and the question, and closes as merged once it is settled (INF-2525)", async () => {
      const h = await approved();
      await h.specs[0]?.onCard?.({
        title: "Which unit should the meter show?",
        body: "<p>Amps or volts?</p>",
        actions: [
          { id: "amps", label: "Amps", default: true },
          { id: "volts", label: "Volts" },
        ],
      });
      await tick();
      const merge = () => h.supervisor.cards.snapshot().find((card) => card.id === h.card.id);
      expect(splitSettleFacts(merge()?.body ?? "")?.facts).toContain(MERGE_CLOSES_WORDS.continues);
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      await vi.waitFor(() =>
        expect(h.crewmate.promptCalls.join("\n")).toContain(
          'because the card "Which unit should the meter show?" on this task is still open',
        ),
      );
      expect(h.tasks.get(h.taskId)).toMatchObject({
        status: "active",
        workspaceState: "present",
        delivery: { ci: "merged" },
      });
      const question = h.cards().find((card) => card.title === "Which unit should the meter show?");
      expect(question).toBeDefined();
      h.crewmate.finishPrompt();
      await tick();
      // The first mate's close waits too while the question is open.
      const held = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(held.text).toContain(
        'the card "Which unit should the meter show?" on this task is still open',
      );
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
      // The crewmate settles its question; the first mate closes as merged.
      h.supervisor.closeCard(question?.id ?? "", { kind: "crewmate", taskId: h.taskId });
      const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(result.text).toBe("#7 is already merged on GitHub.");
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      expect(h.forge.merges).toEqual([APPROVED]);
    });

    // INF-2525: another of the task's pull requests still open keeps it open
    // past the captain's merge of the finishing change too.
    it("merges on the captain's click with another pull request open and keeps the task open (INF-2525)", async () => {
      const h = await approved();
      const next: MergeReview = {
        id: "review-next",
        kind: "github",
        host: "github.com",
        owner: "o",
        name: "r",
        number: 8,
        headSha: REPAIRED,
        base: "main",
        branch: "fm/task-next",
        method: "squash",
        title: "fix: label the meter",
        at: Date.now(),
      };
      seedDelivery(h.tasks, h.taskId, { mergeReviews: [next] });
      h.forge.openNumbers.add(8);
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      await vi.waitFor(() =>
        expect(h.crewmate.promptCalls.join("\n")).toContain(
          "because #8 on this task is still open",
        ),
      );
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", delivery: { ci: "merged" } });
    });

    // INF-2626, fix 1 (the captain's "File the checked fixes"): a task whose own
    // pull request closed unmerged while another task's merged pull request
    // delivered its work held open, because no close it tried fit. settle_task's
    // description now names carried_on for it; this is that route working.
    it("closes a task whose own pull request closed unmerged, delivered by another task's merged one, done through carried_on (INF-2626)", async () => {
      const h = await approved();
      h.supervisor.close(h.card.id);
      await tick();
      h.crewmate.finishPrompt();
      await tick();
      // Its own #7 closed without merging; #65, the carrier's, merged.
      h.forge.changeFor = async () => null;
      h.forge.pull = async (number: number): Promise<ForgePull> =>
        number === 65
          ? {
              number,
              state: "closed",
              merged: true,
              mergedSha: "squash65",
              headSha: "head65",
              base: "main",
              readiness: "clean",
            }
          : {
              number,
              state: "closed",
              merged: false,
              headSha: h.forge.headSha,
              base: "main",
              readiness: "clean",
            };
      h.tasks.turns.recordReport(h.taskId, { text: "Its work merged in #65 with the other fix." });
      await tick();
      const carrier = seedTask(h.tasks, {
        id: "carrier",
        title: "Fix both in one pull request",
        status: "idle",
      });
      seedDelivery(h.tasks, carrier.id, { prNumber: 65, ci: "merged" });

      // The merge close reads its own closed #7, so it cannot close it.
      // INF-2744: with its merge card up the app merges itself; this reads the first mate's merge.
      h.supervisor.cards.takeDown(h.card.id, "The first mate merges this one.");
      editPolicies(h, { autonomy: true });
      const merge = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(merge.text).toContain("closed without merging");
      expect(h.tasks.get(h.taskId)?.status).toBe("active");

      const text = (
        await h.supervisor.settling.done.close(h.taskId, {
          why: "carried_on",
          carriedBy: carrier.key,
        })
      ).text;
      await tick();
      expect(text).toContain(`${carrier.key} carries on its work.`);
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "superseded" });
      expect(h.tasks.graph.replacementOf(h.taskId)).toBe(carrier.key);
      expect(h.forge.merges).toEqual([]);
    });

    // INF-2490: a merge card names one change, finishing or continuing, so
    // its line can say whether the click closes the task.
    it("refuses a card that offers both the finishing merge and a continuing one (INF-2490)", async () => {
      const h = await approved({ referenced: true });
      const review = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.[0];
      if (!review) throw new Error("Missing review");
      await expect(
        Promise.resolve().then(() =>
          h.specs[0]?.onCard?.({
            requiredActions: [],
            title: "Merge both",
            body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
            actions: [
              { id: "finish", label: "Merge PR", default: true, effect: SETTLE_MERGE },
              {
                id: "continue",
                label: "Merge the review",
                effect: { kind: "merge", review: review.id, after: "continue" },
              },
            ],
          }),
        ),
      ).rejects.toThrow("a merge card offers one merge");
      expect(h.cards().some((card) => card.title === "Merge both")).toBe(false);
    });

    // INF-2546 R1, under the captain's "several changes per task, one per
    // PR": a merge card offers the change it was shown for. Once check_change
    // makes another pull request current, a click that approves no head -
    // the first mate's merge card, carrying no story - merges nothing; the
    // crewmate's merge card, whose click approves its pull request's
    // version, merges that pull request and never the current one (INF-2746:
    // "every request to merge a PR ... a request is just like calling a tool").
    it("merges only the pull request a merge card was shown for once another is current, and refuses a click that approves no head (INF-2546, INF-2746)", async () => {
      const h = await approved();
      expect(h.tasks.get(h.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
        cardId: h.card.id,
        prNumber: 7,
        shownFor: 7,
      });
      const firstmateCard = h.supervisor.addFirstmateCard({
        taskId: h.taskId,
        title: "The meter fix is ready to merge",
        body: "<p>The checks passed on the meter fix.</p>",
        requiredActions: [],
        actions: [
          { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
          { id: "wait", label: "Wait" },
        ],
      });
      expect(
        h.tasks
          .get(h.taskId)
          ?.delivery?.completionOffers?.find((offer) => offer.cardId === firstmateCard),
      ).toMatchObject({ shownFor: 7 });
      const next: MergeReview = {
        id: "review-next",
        kind: "github",
        host: "github.com",
        owner: "o",
        name: "r",
        number: 8,
        headSha: REPAIRED,
        base: "main",
        branch: "fm/task-next",
        method: "squash",
        title: "fix: label the meter",
        at: Date.now(),
      };
      seedDelivery(h.tasks, h.taskId, { mergeReviews: [next], checkTarget: next });
      expect(() => h.supervisor.cardActions.act(firstmateCard, "merge")).toThrow(
        CardChoiceUnavailableError,
      );
      await tick();
      expect(h.forge.merges).toEqual([]);
      expect(h.forge.sends).toBe(0);
      expect(h.authorization()).toBeUndefined();
      expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
      // The crewmate's card merges the pull request it was shown for, and closes the task.
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      await vi.waitFor(() =>
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" }),
      );
    });

    // Re-review INF-2546 R1, under the same words: the change a merge card
    // was shown for is kept apart from the head it approves. An offer the
    // same card makes again at a moved head approves no head, so its click
    // refuses once another pull request is current; four later first mate
    // cards do not push an open card's offer out, so that card's click still
    // merges the pull request it was shown for (INF-2746).
    it("keeps the change a merge card was shown for when its offer approves no head and after four later cards, refusing a click that approves no head once another change is current (INF-2546)", async () => {
      const h = await approved();
      const offerOf = (cardId: string) =>
        h.tasks
          .get(h.taskId)
          ?.delivery?.completionOffers?.find(
            (offer) =>
              offer.cardId === cardId &&
              offer.offerId === h.cards().find((card) => card.id === cardId)?.offerId,
          );
      const emitAgain = () =>
        h.specs[0]?.onCard?.({
          id: "meter-offer",
          requiredActions: [],
          title: "The meter fix again",
          body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
          actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
        });
      await repairTurn(h, async () => {
        await emitAgain();
      });
      const again = h.cards().find((card) => card.title === "The meter fix again") as Card;
      expect(offerOf(again.id)).toMatchObject({ headSha: APPROVED, prNumber: 7, shownFor: 7 });
      // The same card, unchanged, shown again once the pull request moved:
      // its offer stands at two heads, so it approves neither.
      await repairTurn(h, async () => {
        h.forge.headSha = REPAIRED;
        await emitAgain();
      });
      expect(h.cards().find((card) => card.id === again.id)?.offerId).toBe(again.offerId);
      expect(offerOf(again.id)).toMatchObject({ headSha: REPAIRED, shownFor: 7 });
      expect(offerOf(again.id)?.prNumber).toBeUndefined();
      for (const title of ["One", "Two", "Three", "Four"])
        h.supervisor.addFirstmateCard({
          taskId: h.taskId,
          title: `First mate card ${title}`,
          body: "<p>The checks passed on the meter fix.</p>",
          requiredActions: [],
          actions: [
            { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
            { id: "wait", label: "Wait" },
          ],
        });
      expect(offerOf(again.id)).toMatchObject({ shownFor: 7 });
      expect(offerOf(h.card.id)).toMatchObject({ shownFor: 7 });
      const next: MergeReview = {
        id: "review-next",
        kind: "github",
        host: "github.com",
        owner: "o",
        name: "r",
        number: 8,
        headSha: REPAIRED,
        base: "main",
        branch: "fm/task-next",
        method: "squash",
        title: "fix: label the meter",
        at: Date.now(),
      };
      seedDelivery(h.tasks, h.taskId, { mergeReviews: [next], checkTarget: next });
      expect(() => h.supervisor.cardActions.act(again.id, "merge")).toThrow(/This action changed/);
      await tick();
      expect(h.forge.merges).toEqual([]);
      expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
      // The first card's offer was kept: its click approves the version it showed of #7.
      h.supervisor.cardActions.act(h.card.id, "merge");
      await vi.waitFor(() => expect(h.authorization()).toMatchObject({ target: { prNumber: 7 } }));
      // Its merge attempt finds #7 moved past the approved version, sends nothing
      // and waits for its crewmate to declare the repair.
      await vi.waitFor(() =>
        expect(h.authorization()).toMatchObject({ status: "standing", waiting: { on: "repair" } }),
      );
      expect(h.forge.merges).toEqual([]);
    });

    // Re-review INF-2546 R3, under the captain's "several changes per task,
    // one per PR": the captain's click on a continuing merge of the task's
    // own pull request makes it current with its own number, so the approval
    // is of the change the slot names and it merges, keeping the task open.
    it("merges the task's own pull request on a continuing merge card clicked while another pull request was current (INF-2546)", async () => {
      const h = await approved();
      // GitHub names the own pull request's branch, the task's own.
      h.forge.referencedBranch = h.tasks.get(h.taskId)?.branch;
      expect(await h.checkService.checkTool.checkForCrew(h.taskId, { pull: 7 })).toContain(
        "Merge review",
      );
      const own = h.tasks
        .get(h.taskId)
        ?.delivery?.mergeReviews?.find((review) => review.number === 7);
      if (!own) throw new Error("Missing the own review");
      const other: MergeReview = {
        ...own,
        id: "review-other",
        number: 8,
        branch: "fm/task-other",
        headSha: REPAIRED,
      };
      seedDelivery(h.tasks, h.taskId, {
        mergeReviews: [own, other],
        checkTarget: other,
        prNumber: 8,
      });
      await repairTurn(h, async () => {
        await h.specs[0]?.onCard?.({
          requiredActions: [],
          title: "Merge the meter fix and keep going",
          body: "<p>The meter fix is ready.</p><p>Merging it keeps this task open.</p>",
          actions: [
            {
              id: "merge",
              default: true,
              effect: { kind: "merge", review: own.id, after: "continue" },
            },
            { id: "not-now", label: "Not now" },
          ],
        });
      });
      const card = h
        .cards()
        .find((entry) => entry.title === "Merge the meter fix and keep going") as Card;
      h.supervisor.cardActions.act(card.id, "merge");
      await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      expect(h.authorization()?.status).toBe("consumed");
      expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ prNumber: 7 });
      expect(h.tasks.get(h.taskId)?.delivery?.checkTarget).toBeUndefined();
      expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    });

    it("mints an approval of the offer the captain saw at the head its checks read, and keeps it through a 405 conflict", async () => {
      const { authorization, card, tasks, taskId, ops, forge } = await kept();
      expect(authorization()).toMatchObject({
        version: 1,
        status: "standing",
        issuer: "captain",
        approvedHead: APPROVED,
        lineage: [],
        card: { id: card.id, offerId: card.offerId, actionId: "merge" },
        target: { prNumber: 7, owner: "o", name: "r", host: "github.com", delivery: "direct-pr" },
        waiting: { on: "conflict", head: APPROVED },
      });
      expect(authorization()?.attempt).toBeUndefined();
      expect(settleLines(tasks, taskId)).toContain(keptFeedLine("conflict", "GitHub"));
      await vi.waitFor(() =>
        expect(ops.join("\n")).toContain("do not ask the captain to merge again"),
      );
      expect(ops.join("\n")).toContain(`check_change conflictRepair from ${APPROVED}`);
      expect(forge.merges).toEqual([]);
    });

    it("merges a repair declared with impact none once, when the crewmate's turn ends, with no second click or card", async () => {
      const harness = await kept();
      let said: string | undefined;
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        said = await harness.declare(repair("none"));
      });
      expect(said).toContain(
        `Repair accepted: the captain's kept merge approval now covers ${REPAIRED}`,
      );
      await vi.waitFor(() =>
        expect(harness.tasks.get(harness.taskId)).toMatchObject({
          status: "done",
          closedReason: "merged",
        }),
      );
      expect(harness.forge.merges).toEqual([REPAIRED]);
      expect(harness.authorization()).toMatchObject({
        status: "consumed",
        receipt: { head: REPAIRED, sha: `squash-${REPAIRED}` },
        lineage: [{ fromHead: APPROVED, toHead: REPAIRED, impact: "none" }],
      });
      expect(harness.cards()).toEqual([]);
    });

    it("never merges a head no accepted repair covers", async () => {
      const harness = await kept();
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
      });
      await vi.waitFor(() =>
        expect(harness.authorization()?.waiting).toMatchObject({ on: "repair", head: APPROVED }),
      );
      expect(harness.forge.merges).toEqual([]);
      expect(harness.tasks.get(harness.taskId)?.status).toBe("active");
    });

    it("refuses a repair off the lineage, one whose head does not hold its base, and one whose paths it cannot account for", async () => {
      const harness = await kept();
      harness.forge.headSha = REPAIRED;
      expect(await harness.declare(repair("none", "elsewhere0009"))).toContain(
        `a repair starts from ${APPROVED}`,
      );
      harness.setFacts({ ...cleanFacts, baseInTo: false });
      expect(await harness.declare(repair("none"))).toContain(`${NEW_BASE} is not in ${REPAIRED}`);
      harness.setFacts({ ...cleanFacts, repairedPaths: ["src/meter.ts", "src/billing.ts"] });
      expect(await harness.declare(repair("none"))).toContain(
        "these paths differ from the approved change and the declaration does not name them: src/billing.ts",
      );
      // Naming the path the repair needed accounts for it.
      expect(await harness.declare(repair("none", APPROVED, ["src/billing.ts"]))).toContain(
        "Repair accepted",
      );
      expect(harness.authorization()?.lineage).toHaveLength(1);
    });

    it("holds an unknown impact until the crewmate decides it, and ends on changed-work with a hold autonomy cannot pass", async () => {
      const harness = await kept();
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        await harness.declare(repair("unknown"));
      });
      await vi.waitFor(() =>
        expect(harness.authorization()?.waiting).toMatchObject({ on: "evidence" }),
      );
      expect(harness.forge.merges).toEqual([]);
      const said = await harness.declare(repair("changed-work"));
      expect(said).toContain("put up a new merge card");
      expect(harness.authorization()).toMatchObject({ status: "invalidated", holds: true });
      vi.spyOn(harness.supervisor.facts, "taskAutonomy").mockReturnValue(true);
      expect(
        await harness.supervisor.settling.settle.settleTask(harness.taskId, "merge-pr"),
      ).toContain(
        "the captain's merge approval ended because its crewmate declared that its repair changed the approved work",
      );
      expect(harness.forge.merges).toEqual([]);
    });

    /**
     * The repair its crewmate declared unknown, handed to one independent
     * assessment (FI3-663): the host files the assessment under the builder,
     * starts it on the second crewmate, and reads its first line as the
     * verdict. INF-2625's plan, the crew supervisor's third step, moves this
     * path out of the supervisor; these pin what it does first.
     */
    async function assessed() {
      const harness = await kept();
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        await harness.declare(repair("unknown"));
      });
      await vi.waitFor(() =>
        expect(harness.authorization()?.undecided?.assessment?.taskId).toBeDefined(),
      );
      const assessorId = harness.authorization()?.undecided?.assessment?.taskId ?? "";
      await vi.waitFor(() => expect(harness.reviewer.promptCalls).toHaveLength(1));
      return { ...harness, assessorId };
    }

    // Regression: repeated preflight must not mistake asynchronous preparation for a failed assessment.
    it("preserves one reserved assessment while placement is preparing", async () => {
      let router: Router | undefined;
      const h = await kept({
        realRouter: (db) => {
          const rows = [row("codex", "home-codex", 84)];
          router = new Router({
            decisions: new DecisionStore(db),
            settings: new SettingsStore(db),
            quota: {
              latestModels: () => buildModelsCatalog([CODEX], rows, new Date(AT).toISOString(), AT),
              latest: () => snapshot(AT, rows),
            } as QuotaService,
            availableModels: () => [CODEX],
          });
          return router;
        },
      });
      if (!router) throw new Error("assessment needs its real routing owner");
      const ready = deferred<PreparedRouteOptions>();
      const preparing = vi.spyOn(router, "prepare").mockReturnValue(ready.promise);
      await repairTurn(h, async () => {
        h.forge.headSha = REPAIRED;
        await h.declare(repair("unknown"));
      });
      await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(1));
      const assessorId = h.authorization()?.undecided?.assessment?.taskId;
      if (!assessorId) throw new Error("repair assessment was not reserved");
      expect(h.tasks.get(assessorId)).toBeUndefined();
      await h.supervisor.settling.kept.runMergeAuthorization(h.taskId);
      expect(preparing).toHaveBeenCalledTimes(1);
      expect(h.authorization()).toMatchObject({
        status: "standing",
        undecided: { assessment: { taskId: assessorId } },
      });
      ready.resolve({ placed: { work: [], samples: [], charges: {} } });
      await vi.waitFor(() =>
        expect(h.tasks.get(assessorId)).toMatchObject({ parentId: h.taskId, status: "active" }),
      );
      expect(h.authorization()?.status).toBe("standing");
      expect(h.forge.merges).toEqual([]);
      await h.supervisor.disposeAll();
    });

    it("files one independent assessment of an unknown repair under the builder, and merges once it finds the work kept", async () => {
      const harness = await assessed();
      expect(harness.tasks.get(harness.assessorId)).toMatchObject({
        kind: "work",
        title: "Assess repair: Ship the meter",
        parentId: harness.taskId,
        status: "active",
        shape: { kind: "review", kind_source: REPAIR_ASSESSMENT_SOURCE, basis: harness.taskId },
      });
      expect(
        harness.tasks
          .timeline(harness.taskId)
          .some(
            (event) =>
              event.text ===
              `An independent assessment of the repair to ${REPAIRED} started: Assess repair: Ship the meter.`,
          ),
      ).toBe(true);
      const brief = harness.reviewer.promptCalls[0] ?? "";
      for (const head of [APPROVED, REPAIRED, NEW_BASE]) expect(brief).toContain(head);
      expect(brief).toContain(
        "git range-diff shows the approved commit unchanged on the newer base",
      );
      expect(harness.forge.merges).toEqual([]);
      await reportTurn(
        harness.reviewer,
        harness.assessorId,
        "impact: none\nEvery path either change touches reads the same on the newer base.",
      );
      await vi.waitFor(() => expect(harness.forge.merges).toEqual([REPAIRED]));
      expect(harness.authorization()).toMatchObject({
        status: "consumed",
        lineage: [
          {
            fromHead: APPROVED,
            toHead: REPAIRED,
            impact: "none",
            assessment: { taskId: harness.assessorId, verdict: "none" },
          },
        ],
      });
      expect(harness.tasks.get(harness.assessorId)).toMatchObject({
        status: "done",
        closedReason: "finished",
      });
      expect(harness.reviewer.promptCalls).toHaveLength(1);
    });

    it("ends the kept approval with a hold when the assessment finds the work changed, and tells the builder once", async () => {
      const harness = await assessed();
      const builderPrompts = harness.crewmate.promptCalls.length;
      await reportTurn(
        harness.reviewer,
        harness.assessorId,
        "impact: changed-work\nThe repair rewrote how the meter rounds.",
      );
      await vi.waitFor(() =>
        expect(harness.authorization()).toMatchObject({
          status: "invalidated",
          holds: true,
          reason: "an independent assessment found that its repair changed the approved work",
          undecided: { assessment: { taskId: harness.assessorId, verdict: "changed-work" } },
        }),
      );
      await vi.waitFor(() =>
        expect(harness.crewmate.promptCalls.length).toBeGreaterThan(builderPrompts),
      );
      const told = harness.crewmate.promptCalls.slice(builderPrompts).join("\n");
      expect(told).toContain(
        renderWake({
          facts: {
            kind: "repair-assessed",
            head: REPAIRED,
            verdict: "changed-work",
            excerpt: "impact: changed-work\nThe repair rewrote how the meter rounds.",
          },
        }),
      );
      expect(harness.tasks.get(harness.assessorId)).toMatchObject({
        status: "done",
        closedReason: "finished",
      });
      expect(harness.forge.merges).toEqual([]);
    });

    it("fails a repair whose assessment is still open past its bound, and retires the assessment silently", async () => {
      const harness = await assessed();
      vi.setSystemTime(Date.now() + ASSESSMENT_BOUND_MS + 1);
      await repairTurn(harness, async () => {});
      await vi.waitFor(() =>
        expect(harness.authorization()).toMatchObject({
          status: "invalidated",
          holds: true,
          reason: "the independent assessment of its repair did not finish",
          undecided: { assessment: { taskId: harness.assessorId, verdict: "failed" } },
        }),
      );
      await vi.waitFor(() =>
        expect(harness.tasks.get(harness.assessorId)).toMatchObject({
          status: "dropped",
          closedReason: "superseded",
        }),
      );
      await vi.waitFor(() =>
        expect(harness.crewmate.promptCalls.join("\n")).toContain(
          renderWake({
            facts: { kind: "repair-assessed", head: REPAIRED, verdict: "failed" },
          }),
        ),
      );
      expect(harness.forge.merges).toEqual([]);
    });

    it("waits on GitHub's rules without bypassing them, and the tick merges once they clear", async () => {
      const harness = await kept();
      const ticker = new Ticker({
        now: () => Date.now(),
        timers: { repeat: () => 0, cancel: () => {} },
      });
      harness.supervisor.watch.startWatchdog(ticker);
      harness.forge.readiness = "blocked";
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        await harness.declare(repair("none"));
      });
      await vi.waitFor(() =>
        expect(harness.authorization()?.waiting).toMatchObject({ on: "protected", head: REPAIRED }),
      );
      const retryAt = harness.authorization()?.retryAt ?? 0;
      expect(retryAt).toBeGreaterThan(Date.now());
      expect(harness.forge.merges).toEqual([]);
      await vi.waitFor(() => expect(harness.ops.join("\n")).toContain("never bypasses them"));
      harness.forge.readiness = "clean";
      vi.setSystemTime(retryAt + 1);
      ticker.tick();
      await vi.waitFor(() => expect(harness.forge.merges).toEqual([REPAIRED]));
      harness.supervisor.disposeAll();
    });

    it("keeps the captain's merge of a GitLab merge request the same way, in GitLab's words", async () => {
      const harness = await kept({ kind: "gitlab" });
      expect(harness.authorization()).toMatchObject({
        status: "standing",
        approvedHead: APPROVED,
        target: { prNumber: 7, owner: "group/sub", name: "r", host: "gitlab.com" },
        waiting: { on: "conflict", head: APPROVED },
      });
      expect(harness.forge.merges).toEqual([]);
      const ticker = new Ticker({
        now: () => Date.now(),
        timers: { repeat: () => 0, cancel: () => {} },
      });
      harness.supervisor.watch.startWatchdog(ticker);
      harness.forge.readiness = "blocked";
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        await harness.declare(repair("none"));
      });
      await vi.waitFor(() =>
        expect(harness.authorization()?.waiting).toMatchObject({ on: "protected", head: REPAIRED }),
      );
      await vi.waitFor(() =>
        expect(harness.ops.join("\n")).toContain(
          "GitLab's rules on the main branch hold the merge",
        ),
      );
      expect(harness.forge.merges).toEqual([]);
      harness.forge.readiness = "clean";
      vi.setSystemTime((harness.authorization()?.retryAt ?? 0) + 1);
      ticker.tick();
      await vi.waitFor(() => expect(harness.forge.merges).toEqual([REPAIRED]));
      await vi.waitFor(() =>
        expect(harness.tasks.get(harness.taskId)).toMatchObject({
          status: "done",
          closedReason: "merged",
        }),
      );
      expect(harness.tasks.timeline(harness.taskId).map((event) => event.text)).toContain(
        "Merged !7 on GitLab. https://gitlab.com/group/sub/r/-/merge_requests/7",
      );
      harness.supervisor.disposeAll();
    });

    it("an approval withdrawn while its gates are read sends nothing", async () => {
      const harness = await kept();
      await repairTurn(harness, async () => {
        harness.forge.headSha = REPAIRED;
        await harness.declare(repair("none"));
        // The captain takes it back while the host-run attempt reads the checks.
        harness.forge.duringChecks = () => {
          harness.forge.duringChecks = () => {};
          harness.supervisor.withdrawMergeApproval(harness.taskId);
        };
      });
      await vi.waitFor(() =>
        expect(harness.authorization()).toMatchObject({ status: "revoked", holds: true }),
      );
      await tick();
      expect(harness.forge.merges).toEqual([]);
      expect(harness.authorization()?.attempt).toBeUndefined();
    });

    // INF-1272, the captain: "A stop still means something is wrong; only
    // quits and updates keep the approval."
    it("stands across a quit that cuts the crewmate's turn, where an interrupt ends it", async () => {
      const harness = await kept();
      const standing = harness.authorization();
      await harness.supervisor.steer.steerCrewmate(harness.taskId, "bring it up to date");
      await harness.supervisor.disposeAll();
      expect(harness.authorization()).toEqual(standing);
      expect(harness.authorization()?.status).not.toBe("revoked");
      expect(harness.forge.merges).toEqual([]);
    });

    // INF-1364: a first-mate merge button is not a new crewmate completion
    // offer, whether present at preflight or added during the checks read.
    it.each(["before-retry", "during-checks"] as const)(
      "keeps the captain's approval when a first-mate merge card appears %s",
      async (arrival) => {
        const h = await kept();
        const approvedId = h.authorization()?.id;
        let firstmateCard: string | undefined;
        const emit = () => {
          firstmateCard = h.supervisor.addFirstmateCard({
            taskId: h.taskId,
            title: "Merge with the phone check red",
            body: "<p>The captain can keep the original merge approval.</p>",
            actions: [
              { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
              { id: "wait", label: "Wait" },
            ],
          });
        };
        if (arrival === "before-retry") emit();
        else {
          h.forge.duringChecks = () => {
            h.forge.duringChecks = () => {};
            emit();
          };
        }
        await repairTurn(h, async () => {});
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        expect(firstmateCard).toBeDefined();
        expect(h.authorization()).toMatchObject({ id: approvedId, status: "consumed" });
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        const evidence = process.env.INFINITARY_MERGE_OFFER_EVIDENCE;
        if (evidence)
          writeFileSync(
            join(evidence, `${arrival}.json`),
            JSON.stringify(
              {
                arrival,
                approvedId,
                firstmateCard,
                authorization: h.authorization(),
                merges: h.forge.merges,
                task: {
                  status: h.tasks.get(h.taskId)?.status,
                  closedReason: h.tasks.get(h.taskId)?.closedReason,
                },
              },
              null,
              2,
            ),
          );
      },
    );

    // INF-4018: only a card at another version asks again; one at the
    // version the approval covers is refused and leaves it to merge.
    it("refuses a completion card at the kept version, which then merges, and an interruption revokes it with a hold", async () => {
      const harness = await kept();
      await repairTurn(harness, async () => {
        await expect(
          Promise.resolve().then(() => harness.emit("Ready to merge again")),
        ).rejects.toThrow("The captain's merge approval is kept and covers");
      });
      // The approval it left standing merges the approved version once the turn ends.
      expect(harness.authorization()).toMatchObject({ status: "consumed" });
      expect(harness.forge.merges).toHaveLength(1);
      const again = await kept();
      await again.supervisor.steer.steerCrewmate(again.taskId, "bring it up to date");
      await again.supervisor.sessions.interruptCrewmate(again.taskId, "interrupt");
      expect(again.authorization()).toMatchObject({ status: "revoked", holds: true });
      expect(again.forge.merges).toEqual([]);
    });

    // INF-2062: moving a started task back to the backlog ends a kept approval, as an interrupt does.
    it("a move back to the backlog revokes it with a hold", async () => {
      const harness = await kept();
      await harness.supervisor.steer.steerCrewmate(harness.taskId, "bring it up to date");
      expect(harness.supervisor.hostOps.runTaskOp(harness.taskId, "unqueue-task")).toBeUndefined();
      await vi.waitFor(() =>
        expect(harness.authorization()).toMatchObject({ status: "revoked", holds: true }),
      );
      expect(harness.tasks.get(harness.taskId)?.backlogSince).not.toBeNull();
      expect(harness.forge.merges).toEqual([]);
    });

    it("the captain's withdrawal takes it back with a hold, and only his new click merges", async () => {
      const harness = await kept();
      expect(harness.supervisor.withdrawMergeApproval(harness.taskId)).toMatchObject({ ok: true });
      expect(harness.authorization()).toMatchObject({ status: "revoked", holds: true });
      expect(harness.supervisor.withdrawMergeApproval(harness.taskId)).toMatchObject({ ok: false });
      vi.spyOn(harness.supervisor.facts, "taskAutonomy").mockReturnValue(true);
      expect(
        await harness.supervisor.settling.settle.settleTask(harness.taskId, "merge-pr"),
      ).toContain(
        "is not yours to do: the captain's merge approval ended because the captain withdrew it",
      );
      // His own idle boundary runs nothing for a withdrawn approval.
      await repairTurn(harness, async () => {});
      expect(harness.forge.merges).toEqual([]);
    });

    it("a steer the Firstmate sends in the captain's turn holds it until the crewmate declares that guidance, then merges once (FI3-662)", async () => {
      const h = await kept();
      // While his approval stands, the captain asks through the Firstmate.
      // The crewmate brings the change up to date in that turn but says
      // nothing about his words.
      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "Should the meter be renamed?",
        "firstmate",
        {
          captainWords: true,
        },
      );
      expect(h.crewmate.promptCalls.at(-1)).toContain(`${GUIDANCE_MARK_WORDS} 1 `);
      h.forge.headSha = REPAIRED;
      await h.declare(repair("none"));
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() =>
        expect(h.authorization()?.waiting).toMatchObject({ on: "guidance", head: REPAIRED }),
      );
      expect(h.authorization()?.guidance).toMatchObject({ latest: 1, declared: 0 });
      expect(h.forge.merges).toEqual([]);
      expect(h.events).toContainEqual({
        type: "firstmate_note",
        taskId: h.taskId,
        text: 'Your merge of "Ship the meter" is kept and waits until its crewmate says whether your newer words change the work you approved.',
      });
      // The Firstmate's own steer outside his turn is not his guidance, and
      // a mark no message of his named cannot be declared.
      let said: string | undefined;
      await repairTurn(h, async () => {
        expect(
          await h.declare({ captainGuidance: { mark: 2, impact: "none", evidence: "Kept." } }),
        ).toContain("mark 2 is not one the captain's messages named; the newest is 1");
        said = await h.declare({
          captainGuidance: { mark: 1, impact: "none", evidence: "He kept the name." },
        });
      });
      expect(said).toContain("so it no longer holds the merge");
      await vi.waitFor(() =>
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" }),
      );
      expect(h.forge.merges).toEqual([REPAIRED]);
      expect(h.authorization()).toMatchObject({
        status: "consumed",
        guidance: { latest: 1, declared: 1 },
      });
    });

    it("his reply under a crewmate's card holds it too, and changed-work ends it with a hold autonomy cannot pass (FI3-662)", async () => {
      const h = await kept();
      // The repaired head's checks are still running, so its turn's end merges nothing yet.
      h.forge.states = ["pending"];
      await repairTurn(h, async () => {
        h.forge.headSha = REPAIRED;
        await h.declare(repair("none"));
        await h.specs[0]?.onCard?.({
          title: "Rename the meter?",
          body: "<p>Should the meter get a new name?</p><p>I kept the name you approved.</p>",
          actions: [
            { id: "keep", label: "Keep the name", default: true },
            { id: "rename", label: "Rename it" },
          ],
        });
      });
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
      const question = h.cards().find((card) => card.title === "Rename the meter?") as Card;
      h.supervisor.cardActions.replyToCard(question.id, "Rename it to gauge.");
      await vi.waitFor(() =>
        expect(h.crewmate.promptCalls.at(-1)).toContain("Rename it to gauge."),
      );
      expect(h.crewmate.promptCalls.at(-1)).toContain(`${GUIDANCE_MARK_WORDS} 1 `);
      expect(h.authorization()?.guidance).toMatchObject({ latest: 1, declared: 0 });
      h.forge.states = ["success"];
      expect(
        await h.declare({
          captainGuidance: {
            mark: 1,
            impact: "changed-work",
            evidence: "He asked for a new name.",
          },
        }),
      ).toContain("put up a new merge card");
      h.crewmate.finishPrompt();
      await tick();
      expect(h.authorization()).toMatchObject({ status: "invalidated", holds: true });
      expect(h.forge.merges).toEqual([]);
      vi.spyOn(h.supervisor.facts, "taskAutonomy").mockReturnValue(true);
      expect(await h.supervisor.settling.settle.settleTask(h.taskId, "merge-pr")).toContain(
        "its crewmate declared that the captain's newer guidance changes the approved work",
      );
      expect(h.forge.merges).toEqual([]);
    });

    it("a line he types in the task's Crewmate tab holds it too, and his words stay his on the record (FI3-662)", async () => {
      const h = await kept();
      expect(
        await h.supervisor.steer.steerFromCrewmateTab(h.taskId, "Rename it to gauge."),
      ).toEqual({
        ok: true,
      });
      expect(h.authorization()?.guidance).toMatchObject({ latest: 1, declared: 0 });
      expect(h.crewmate.promptCalls.at(-1)).toContain(`${GUIDANCE_MARK_WORDS} 1 `);
      const steered = h.tasks.timeline(h.taskId).filter((event) => event.kind === "steered");
      const span = steered.at(-1)?.data?.words as { from: number; to: number } | undefined;
      expect(span && steered.at(-1)?.text.slice(span.from, span.to)).toBe("Rename it to gauge.");
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "guidance" }));
      expect(h.forge.merges).toEqual([]);
    });

    it("guidance that comes while his own click waits for the crewmate's turn keeps the click instead of merging (FI3-662)", async () => {
      const h = await approved();
      await h.supervisor.steer.steerCrewmate(h.taskId, "polish the docs");
      // He clicks while the crewmate works, then gives it new guidance.
      h.supervisor.cardActions.act(h.card.id, "merge");
      await tick();
      expect(h.authorization()?.status).toBe("standing");
      await h.supervisor.steer.steerCrewmate(h.taskId, "Hold on, rename it first.", "firstmate", {
        captainWords: true,
      });
      expect(h.authorization()?.guidance).toMatchObject({ latest: 1, declared: 0 });
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() =>
        expect(settleLines(h.tasks, h.taskId)).toContain(
          "Cannot merge yet: its crewmate has not said whether your newer words change the work you approved. Your merge is kept and runs once it says they do not.",
        ),
      );
      expect(h.authorization()).toMatchObject({
        status: "standing",
        waiting: { on: "guidance", head: APPROVED },
      });
      expect(h.authorization()?.attempt).toBeUndefined();
      expect(h.forge.merges).toEqual([]);
    });

    it("an attempt that outlived its answer reads the pull request back: merged there closes the task once", async () => {
      const harness = await kept();
      // The record as a quit right after the merge request leaves it.
      const standing = harness.authorization();
      if (!standing) throw new Error("no approval");
      seedDelivery(harness.tasks, harness.taskId, {
        mergeAuthorization: {
          ...standing,
          attempt: { token: "t1", head: APPROVED, at: Date.now() },
        },
      });
      harness.forge.merged = true;
      await repairTurn(harness, async () => {});
      await vi.waitFor(() =>
        expect(harness.tasks.get(harness.taskId)).toMatchObject({ closedReason: "merged" }),
      );
      expect(harness.forge.merges).toEqual([]);
      expect(harness.authorization()).toMatchObject({
        status: "consumed",
        receipt: { head: APPROVED, sha: `squash-${APPROVED}` },
      });
    });

    it("leaves the merge's words alone on a card whose click approves nothing, whatever the checks read", async () => {
      // There a click on such checks is refused and nothing waits (INF-23).
      const { supervisor, tasks, cards } = setup(fakeCrewmate());
      seedTask(tasks, { id: "merge", title: "Ship it", status: "idle", worktreeDir: "/pr" });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const id = supervisor.addFirstmateCard({
        requiredActions: [],
        taskId: "merge",
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [{ id: "merge-pr", label: "Put it in", default: true, effect: SETTLE_MERGE }],
      });
      seedDelivery(tasks, "merge", { mode: "direct-pr", ci: "red", ciAt: Date.now() });
      await tick();
      const shown = cards().find((card) => card.id === id);
      expect(shown?.actions.map((action) => action.label)).toEqual(["Put it in"]);
    });

    it("a click on an offer the host never published at a known head approves nothing", async () => {
      const { supervisor, tasks } = setup(fakeCrewmate(), {
        mergePullRequest: vi.fn(
          async (): Promise<PrOutcome> => ({ ok: false, text: conflict, problem: conflict }),
        ),
      });
      seedTask(tasks, { id: "merge", title: "Ship it", status: "idle", worktreeDir: "/pr" });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const id = supervisor.addFirstmateCard({
        requiredActions: [],
        taskId: "merge",
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [{ id: "merge-pr", label: "Put it in", default: true, effect: SETTLE_MERGE }],
      });
      supervisor.cardActions.act(id, "merge-pr");
      await vi.waitFor(() =>
        expect(settleLines(tasks, "merge")).toContain(
          "Cannot merge: it conflicts with newer work in the project - its crewmate needs to bring it up to date",
        ),
      );
      expect(tasks.get("merge")?.delivery?.mergeAuthorization).toBeUndefined();
    });

    it("retires a kept click from before this version at boot, and says so", async () => {
      const { tasks, ops } = setup(fakeCrewmate());
      // Seeded before the boot's resume runs, as an earlier process left it.
      seedTask(tasks, { id: "legacy", title: "Kept before", status: "idle", worktreeDir: "/pr" });
      seedDelivery(tasks, "legacy", { mergeOrder: { at: 1, proceedWithOpen: false } });
      await tick();
      expect(tasks.get("legacy")?.delivery?.mergeOrder).toBeUndefined();
      expect(ops.join("\n")).toContain("could not be carried forward");
    });
  });

  // The captain's report (INF-3092): a crewmate pushed a new version under an
  // open merge card, and the card still showed the earlier version's checks
  // passed with Merge the pull request, because nothing read the push.
  describe("a push under an open merge card", () => {
    const checksCell = (card: Card | undefined) =>
      splitSettleFacts(card?.body ?? "")?.facts.match(
        /data-fact="checks"[\s\S]*?<\/span><\/span>/,
      )?.[0] ?? "";
    const mergeWords = (card: Card | undefined) =>
      card?.actions.find((action) => action.effect?.kind === "merge" && !action.passes)?.label;

    it("reads the pushed version on the next tick after the crewmate's turn, so the card shows its running checks", async () => {
      const h = await approved({ checkWatch: true });
      const shown = () => h.cards().find((card) => card.id === h.card.id);
      expect(checksCell(shown())).toContain(CHECK_WORDS.green);
      expect(mergeWords(shown())).toBe(MERGE_WORDS["merge-pr"]);
      // The crewmate's plain git push from its shell: the pull request is at
      // a new version whose checks run, and nothing tells the app.
      await repairTurn(h, async () => {
        h.forge.headSha = REPAIRED;
        h.forge.states = ["pending"];
      });
      // The next minute's tick, well inside the five-minute quiet refresh.
      await h.supervisor.watch.pollCheckWatches(Date.now() + 60_000);
      await tick();
      expect(h.tasks.get(h.taskId)?.delivery?.headSha).toBe(REPAIRED);
      expect(checksCell(shown())).toContain(CHECK_WORDS.pending);
      expect(mergeWords(shown())).toBe(MERGE_WHEN_CHECKS_PASS_WORDS);
    });
  });
});
