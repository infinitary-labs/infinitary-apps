/**
 * The captain's override of the checks as `CaptainOverrides` passes it
 * (docs/delivery-rigor.md, "The holds"), on the kept merge approval: the captain's
 * words passing failed checks at the version they cover, Merge anyway on
 * failed checks, and the crew's own-pull absence declaration.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */

import { MERGE_ANYWAY_ACTION, SETTLE_FACT_VALUE_CLASS, splitSettleFacts } from "@shared/cards";
import {
  CHECKS_ABSENT_WORDS,
  CHECKS_NOT_REPORTED_WORDS,
  currentCheckStatus,
} from "@shared/checkSnapshot";
import { factDotSvg } from "@shared/factDot";
import {
  choiceWords,
  mergeClickRefusal,
  overrideTakenBackWords,
  softHoldWords,
  standingOverrideWords,
} from "@shared/holds";
import { QUEUE_STATUS } from "@shared/repos";
import {
  BATCH_CHECK_WORDS,
  CHECK_WORDS,
  MERGE_AFTER_FIXING_WORDS,
  MERGE_ANYWAY_WORDS,
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
} from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import { overrideHoldsFrom } from "../../../scripts/interaction-metrics";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  editPolicies,
  repairTurn,
} from "../../../tests/helpers/crewHarnessGit";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { standingBaselineChecks } from "../tasks/dependencyWaits";
import { seedTask } from "../tasks/seedTask";
import { CHECK_FAILS_ON_MAIN_WORDS, CHECK_VERDICT_WORDS } from "./checkVerdicts";
import { COMPLETION_REVISED_WHILE_RUNNING } from "./crewmateCards";
import { FAILED_BATCH_NOTE } from "./mergeAuthorization";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  describe("the captain's kept merge approval (FI3-304)", () => {
    /**
     * INF-242's saved plan, as the captain answered it (INF-473): his words,
     * declared once by the first mate, pass the soft holds it names, for one
     * version or the task's life, and his own merge click reads the same
     * record. The first two replay INF-140: a review passed at an older
     * version, a fix pushed after it, and his "the review covered it".
     */
    describe("the captain's override (INF-473)", () => {
      const words = "That failed check is the nightly's; merge it.";
      // The checks failed at the approved version (INF-1876: the review and
      // its live proof are no longer holds of the host's, so the checks are
      // the soft hold his words pass here).
      const failedChecks = async () => {
        const h = await approved();
        h.forge.states = ["failure"];
        editPolicies(h, { autonomy: true });
        await tick();
        // INF-2744: autonomy on, the app approves the merge from the card
        // itself. These tests read the first mate's own merge, so that
        // approval is withdrawn first, as a card taken down withdraws it.
        expect(h.authorization()).toMatchObject({ issuer: "autonomy", status: "standing" });
        h.supervisor.settling.approvals.endAuthorization(
          h.taskId,
          "superseded",
          "the test reads the first mate's merge",
        );
        expect(h.forge.merges).toEqual([]);
        return h;
      };

      it("passes the checks at the version his words cover, and a newer version brings them back", async () => {
        const h = await failedChecks();
        expect(
          (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).text,
        ).toContain(softHoldWords("checks", "firstmate"));
        expect(
          h.supervisor.overrides.declareOverride(h.taskId, {
            words,
            holds: ["checks"],
            until: "version",
          }).ok,
        ).toBe(true);
        // The version is a head of the pull request the task named then (INF-1884 R2).
        expect(h.tasks.get(h.taskId)?.delivery?.override).toMatchObject({
          words,
          holds: ["checks"],
          until: "version",
          head: APPROVED,
          prNumber: 7,
        });
        const row = h.tasks.timeline(h.taskId).find((event) => event.text.includes(words));
        expect(row).toMatchObject({ kind: "note", actor: "firstmate" });
        // A fix pushed after his words is a version they did not cover.
        h.forge.headSha = "fixed0004";
        expect(
          (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).text,
        ).toContain(softHoldWords("checks", "firstmate"));
        expect(h.forge.merges).toEqual([]);
        h.forge.headSha = APPROVED;
        await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
        expect(h.forge.merges).toEqual([APPROVED]);
      });

      /**
       * INF-1216's accepted plan: every crewmate turn on the task is served
       * his standing words, and taking them back drops them from the next
       * turn; the task status read shows what they pass and for how long.
       */
      it("serves his standing words to the crewmate's next turn and crew status, and that he took them back", async () => {
        const h = await failedChecks();
        const notices = () =>
          h.inbox
            .allFor(h.taskId)
            .filter((row) => row.facts?.kind === "task-override-changed")
            .map(renderWake);
        h.supervisor.overrides.declareOverride(h.taskId, {
          words,
          holds: ["checks"],
          until: "task",
        });
        expect(notices()).toEqual([
          standingOverrideWords({ words, holds: ["checks"], until: "task" }),
        ]);
        expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.override).toEqual({
          passes: "the checks for the rest of this task",
          words,
        });
        h.supervisor.overrides.withdrawOverride(h.taskId);
        expect(notices().at(-1)).toBe(overrideTakenBackWords({ holds: ["checks"] }));
        expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.override).toBeUndefined();
      });

      it("passes them at every later version when his words cover the task's life, until he takes them back", async () => {
        const h = await failedChecks();
        h.supervisor.overrides.declareOverride(h.taskId, {
          words,
          holds: ["checks"],
          until: "task",
        });
        h.supervisor.overrides.withdrawOverride(h.taskId);
        expect(h.tasks.get(h.taskId)?.delivery?.override).toBeUndefined();
        expect(
          (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).text,
        ).toContain(softHoldWords("checks", "firstmate"));
        h.supervisor.overrides.declareOverride(h.taskId, {
          words,
          holds: ["checks"],
          until: "task",
        });
        h.forge.headSha = "fixed0004";
        await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
        expect(h.forge.merges).toEqual(["fixed0004"]);
        // The metrics read each declaration off the row it wrote, and the
        // take-back is none (INF-484 move 8 counts overrides per hold kind).
        const declared = h.tasks.timeline(h.taskId).flatMap((event) => {
          const holds = overrideHoldsFrom(event.data ? JSON.stringify(event.data) : null);
          return holds ? [holds] : [];
        });
        expect(declared).toEqual([["checks"], ["checks"]]);
      });

      it("merges his kept click held on failed checks once his words pass the checks, and his feed carries no hold sentence", async () => {
        const h = await approved();
        h.forge.states = ["failure"];
        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
        expect(h.forge.merges).toEqual([]);
        h.supervisor.overrides.declareOverride(h.taskId, {
          words: "The failing check is the flaky one; merge it anyway.",
          holds: ["checks"],
          until: "version",
        });
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        const feed = h.events.flatMap((event) =>
          event.type === "firstmate_note" ? [event.text] : [],
        );
        expect(feed.some((line) => line.includes("Soft hold"))).toBe(false);
      });

      /** The completion card's merge button, as the card shows it now. */
      const mergeLabelOf = (h: Awaited<ReturnType<typeof approved>>) =>
        h
          .cards()
          .find((card) => card.id === h.card.id)
          ?.actions.find((action) => action.effect?.kind === "merge" && !action.passes)?.label;

      it("does not add a verdict wait for passing new-version checks or rewrite the shown offer (INF-1555 F12)", async () => {
        const h = await approved();
        h.forge.headSha = "passed0002";
        h.forge.states = ["success"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
          ci: "green",
          checks: { headSha: "passed0002", items: [{ name: "linux-checks", state: "success" }] },
        });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]));
        expect(h.tasks.get(h.taskId)?.delivery).not.toHaveProperty("crewVerdict");
        expect(h.forge.merges).toEqual([]);
      });

      // INF-756: with his words passing the checks at the card's version, the
      // click merges at once, yet the button read Merge after fixing errors.
      it("names the merge for what a click does while his words pass the checks at the card's version, failed or running, and the click merges at once", async () => {
        const h = await approved();
        h.forge.states = ["failure"];
        await h.declare({});
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_AFTER_FIXING_WORDS));
        h.supervisor.overrides.declareOverride(h.taskId, {
          words: "The failing check is the flaky one; merge it anyway.",
          holds: ["checks"],
          until: "version",
        });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]));
        h.forge.states = ["success", "pending"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery?.ci).toBe("pending");
        expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]);
        h.forge.states = ["failure"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery?.ci).toBe("red");
        expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]);

        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        expect(h.authorization()?.waiting).toBeUndefined();
      });

      it("keeps the wait's words on a card whose version the pull request has moved past, though his words pass the checks for the task", async () => {
        const h = await approved();
        h.supervisor.overrides.declareOverride(h.taskId, {
          words: "The failing check is the flaky one; merge it anyway.",
          holds: ["checks"],
          until: "task",
        });
        h.forge.headSha = "fixed0004";
        h.forge.states = ["failure"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ headSha: "fixed0004", ci: "red" });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_AFTER_FIXING_WORDS));
      });

      /** The Merge anyway button on the completion card, as the card shows it now. */
      const anywayOf = (h: Awaited<ReturnType<typeof approved>>) =>
        h
          .cards()
          .find((card) => card.id === h.card.id)
          ?.actions.find((action) => action.passes === "checks");

      // INF-1137 friction 6, the captain's pick: "the red-check card lacks
      // Merge anyway; PR #399 and PR #281 each took three questions".
      it("offers Merge anyway beside the merge on failed checks, and its one click merges that version with his override recorded", async () => {
        const h = await approved();
        expect(anywayOf(h)).toBeUndefined();
        h.forge.states = ["failure"];
        await h.declare({});
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_AFTER_FIXING_WORDS));
        expect(anywayOf(h)).toMatchObject({
          id: MERGE_ANYWAY_ACTION,
          label: MERGE_ANYWAY_WORDS,
          effect: { kind: "merge", after: "close" },
        });
        // Only the merge itself keeps the merge's words.
        expect(
          h
            .cards()
            .find((card) => card.id === h.card.id)
            ?.actions.map((action) => action.label),
        ).toEqual([
          "Discard",
          REVIEW_CAREFULLY_WORDS,
          MERGE_ANYWAY_WORDS,
          MERGE_AFTER_FIXING_WORDS,
        ]);
        // A body's script cannot press it.
        expect(() =>
          h.supervisor.cardActions.act(h.card.id, MERGE_ANYWAY_ACTION, "frame"),
        ).toThrow();

        h.supervisor.cardActions.act(h.card.id, MERGE_ANYWAY_ACTION);
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
        expect(h.tasks.get(h.taskId)?.delivery?.override).toMatchObject({
          holds: ["checks"],
          until: "version",
          head: APPROVED,
          prNumber: 7,
          words: `${MERGE_ANYWAY_WORDS}, on the card "Ready to merge"`,
        });
        expect(
          h.tasks
            .timeline(h.taskId)
            .some((event) => event.actor === "captain" && event.text.includes(MERGE_ANYWAY_WORDS)),
        ).toBe(true);
      });

      it("takes Merge anyway away once the checks pass, or the pull request moves past the card's version", async () => {
        const h = await approved();
        h.forge.states = ["failure"];
        await h.declare({});
        await vi.waitFor(() => expect(anywayOf(h)).toBeDefined());
        h.forge.states = ["success"];
        await h.declare({});
        await vi.waitFor(() => expect(anywayOf(h)).toBeUndefined());
        expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]);
        h.forge.headSha = "fixed0004";
        h.forge.states = ["failure"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ headSha: "fixed0004", ci: "red" });
        expect(anywayOf(h)).toBeUndefined();
      });

      // INF-3208, the captain's INF-3183 plan, piece 2: after the project's
      // queue sends a change back, its merge card says the queue's own words
      // and the paused batch's issue in a Batch check cell, counts only the
      // pull request's own checks, keeps the crewmate's diagnosis words off
      // the queue status, and offers no Merge anyway, since no checks
      // override passes the queue; the crewmate's answer at that version
      // turns the merge back to the words whose click queues it again.
      it("shows a send-back in the queue's own words beside the pull request's own checks, with no Merge anyway (INF-3208)", async () => {
        const h = await approved({ queue: true });
        const issue = "https://github.com/o/r/issues/97";
        const run = "https://github.com/o/r/actions/runs/4254";
        const words = "Sent back: adds the key but not to the pinned list";
        const strip = () =>
          splitSettleFacts(h.cards().find((card) => card.id === h.card.id)?.body ?? "")?.facts ??
          "";
        const cell = (fact: string) =>
          new RegExp(
            `data-fact="${fact}"[^>]*>.*?<span class="${SETTLE_FACT_VALUE_CLASS}">(.*?)</span></span>`,
          ).exec(strip())?.[1];
        // The batch paused on this version, linking its issue.
        h.forge.queue = {
          name: QUEUE_STATUS,
          state: "pending",
          detail: "Paused after batch run 12; meter.test.ts failed; touched by #7",
          link: issue,
        };
        await h.declare({});
        await vi.waitFor(() => expect(cell("batch")).toContain(BATCH_CHECK_WORDS.pause));
        // A send-back by hand fails it, linking the answer's run instead.
        h.forge.queue = {
          name: QUEUE_STATUS,
          state: "failure",
          detail: words,
          link: run,
          startedAt: 1_000,
          finishedAt: 9 * 60_000,
        };
        await h.declare({});
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_AFTER_FIXING_WORDS));
        await expect(h.emit("Sent back")).rejects.toThrow(
          "The failed batch check is the project's queue's: no checks override passes it, so it gets no Merge anyway",
        );
        await h.declare({
          diagnosis: {
            headSha: APPROVED,
            check: QUEUE_STATUS,
            classification: "own-regression",
            evidence: "The batch failed because the earlier version left the key off the list.",
          },
        });
        await vi.waitFor(() => expect(cell("batch")).toContain(words));
        expect(cell("batch")).toBe(
          `${factDotSvg("failed")}<a href="${run}">${words}</a> · <a href="${issue}">${BATCH_CHECK_WORDS.pause}</a>`,
        );
        // The Checks cell counts the pull request's own check alone, and
        // never times it by the queue status's own times.
        expect(cell("checks")).toBe(`${factDotSvg("ok")}${CHECK_WORDS.green}`);
        expect(strip()).not.toContain("data-check-verdict");
        expect(strip()).not.toContain(CHECK_VERDICT_WORDS["own-regression"]);
        expect(anywayOf(h)).toBeUndefined();
        expect(h.supervisor.settling.approvals.queueWarning(h.taskId, "checks")).toBe(
          FAILED_BATCH_NOTE,
        );
        // The crewmate answers the send-back: a click now puts the version
        // back in the queue, and Merge anyway still has nothing to pass.
        await h.declare({
          declaration: {
            headSha: APPROVED,
            verdict: "answered",
            check: QUEUE_STATUS,
            evidence: "The send-back names the earlier version; this one holds the fix.",
          },
        });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]));
        expect(anywayOf(h)).toBeUndefined();
        // A failure of the pull request's own check takes the answer's words
        // away, and Merge anyway stays off while the batch check failed.
        h.forge.states = ["failure"];
        await h.declare({});
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_AFTER_FIXING_WORDS));
        expect(anywayOf(h)).toBeUndefined();
        // With no failed batch check, the pull request's own failed check
        // brings Merge anyway back as before, and the Batch check cell goes.
        h.forge.queue = undefined;
        await h.declare({});
        await vi.waitFor(() => expect(anywayOf(h)).toBeDefined());
        expect(cell("batch")).toBeUndefined();
      });

      // Captain INF-1555 F12 replaces the separate red prerequisite; the offer carries the judgment.
      it("accepts a failed-check merge offer without a separate verdict or merge consent (INF-1555 F12)", async () => {
        const h = await approved();
        h.forge.headSha = "fixed0004";
        h.forge.states = ["failure"];
        await h.declare({
          diagnosis: {
            headSha: "fixed0004",
            check: "linux-checks",
            classification: "own-regression",
            evidence: "The failed step reports the meter assertion introduced by this change.",
          },
        });
        const offer = () =>
          h.specs[0]?.onCard?.({
            id: `card-${h.taskId}-red-declaration-offer`,
            requiredActions: [],
            title: "The meter check still fails",
            body: completionBody("<p>The finished meter check still fails after repair.</p>"),
            actions: [{ id: "merge-pr", default: true, effect: SETTLE_MERGE }],
          });
        await offer();
        await vi.waitFor(() =>
          expect(
            h
              .cards()
              .find((card) => card.title === "The meter check still fails")
              ?.actions.some((action) => action.passes === "checks"),
          ).toBe(true),
        );
        expect(h.tasks.get(h.taskId)?.delivery).not.toHaveProperty("crewVerdict");
        expect(h.authorization()).toBeUndefined();
        expect(h.forge.merges).toEqual([]);
      });

      it("offers Merge anyway on failed checks once each carries a diagnosis, with no count gate (INF-1555 F12, INF-1891)", async () => {
        const h = await approved();
        h.forge.headSha = "fixed0004";
        h.forge.states = ["failure"];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({ headSha: "fixed0004", ci: "red" });
        // Undiagnosed, a new offer waits on the checks (INF-1891).
        await expect(h.emit("Still red")).rejects.toThrow(softHoldWords("checks", "crewmate"));
        expect(h.cards().find((entry) => entry.title === "Still red")).toBeUndefined();
        expect(h.forge.merges).toEqual([]);
        await h.declare({
          diagnosis: {
            headSha: "fixed0004",
            check: "linux-checks",
            classification: "suspected-flake",
            evidence:
              "The job timed out loading a window; it passed alone on main and on this branch.",
            // INF-840: a suspected flake is a test the change does not touch.
            changedTest: false,
          },
        });
        await repairTurn(h, async () => {
          await h.emit("Still red");
        });
        const card = h.cards().find((entry) => entry.title === "Still red");
        expect(card?.actions.find((action) => action.passes === "checks")?.label).toBe(
          MERGE_ANYWAY_WORDS,
        );
        h.supervisor.cardActions.act(card?.id ?? "", MERGE_ANYWAY_ACTION);
        await vi.waitFor(() => expect(h.forge.merges).toEqual(["fixed0004"]));
      });

      // INF-1915 fix 1 (the captain: "Fold fix 1 into INF-1873 and INF-1874"):
      // main's newest run of the same check failed too, so the card goes up
      // at once naming the check and why it is outside the change, with no
      // rerun and no reopening; the captain merges now or waits for main's
      // fix, which the app watches. A red check never merges on its own.
      it("puts the offer up at once with Merge anyway when main's newest run of every failed check failed too, stating the fact (INF-1915 fix 1)", async () => {
        const h = await approved();
        h.forge.headSha = "fixed0004";
        h.forge.states = ["failure"];
        h.forge.mainRuns(["failure"]);
        await h.declare({});
        const delivery = h.tasks.get(h.taskId)?.delivery;
        expect(delivery).toMatchObject({ headSha: "fixed0004", ci: "red" });
        expect(delivery?.mainChecks).toMatchObject({
          head: "fixed0004",
          sha: "ma1n0000feed",
          items: [{ name: "linux-checks", state: "failure" }],
        });
        expect(delivery?.ciRepair?.diagnoses ?? []).toEqual([]);
        // No card yet, so the crewmate driving its checks hears no wake about main.
        expect(standingBaselineChecks(delivery)).toEqual([]);
        await repairTurn(h, async () => {
          await expect(h.emit("Main fails it too")).resolves.toContain("card-");
        });
        const card = () => h.cards().find((entry) => entry.title === "Main fails it too");
        // With the card up, the main watch reads the same fact: "wait for
        // main's fix" needs no diagnosis.
        expect(standingBaselineChecks(h.tasks.get(h.taskId)?.delivery)).toEqual(["linux-checks"]);
        await vi.waitFor(() =>
          expect(card()?.actions.find((action) => action.passes === "checks")?.label).toBe(
            MERGE_ANYWAY_WORDS,
          ),
        );
        const body = card()?.body ?? "";
        expect(body).toContain(CHECK_FAILS_ON_MAIN_WORDS);
        expect(body).toContain('data-check-outside="linux-checks"');
        expect(body).toContain("ma1n000");
        expect(body).toContain("outside this change");
        // Nothing merged on the fact alone: a red check never merges on its
        // own under this rule. Merge now is the captain's one click, Merge anyway.
        expect(h.authorization()).toBeUndefined();
        expect(h.forge.merges).toEqual([]);
        h.supervisor.cardActions.act(card()?.id ?? "", MERGE_ANYWAY_ACTION);
        await vi.waitFor(() => expect(h.forge.merges).toEqual(["fixed0004"]));
      });

      // INF-1955 (the captain: "then this is a bug.. it's confusing for me to
      // see this"): a project that runs no checks read none reported with
      // Merge when checks pass, because the crew's absence declaration sent
      // with no pull named was dropped in silence. It registers against the
      // task's own pull request now, or is refused in words.
      const NO_CI = "b9b68d86e69580da41daee76790e7080ee638841";
      const absence = (headSha: string) => ({
        headSha,
        evidence:
          "The default branch has no CI: no workflows, no branch rule requires a check, and main's own commit has no runs.",
        localGate:
          "nix eval and nix build of every host and the unit suite passed at this version.",
      });
      const noCiVersion = async (h: Awaited<ReturnType<typeof approved>>) => {
        h.forge.referencedBranch = h.tasks.get(h.taskId)?.branch ?? "";
        h.forge.headSha = NO_CI;
        h.forge.states = [];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
          headSha: NO_CI,
          ci: "pending",
          checks: { items: [], absenceDeclared: false },
        });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WHEN_CHECKS_PASS_WORDS));
      };

      it("registers the crew's own-pull absence declaration or refuses it in words, and the no-CI card then goes up (INF-1955)", async () => {
        const h = await approved();
        await noCiVersion(h);
        expect(h.cards().find((card) => card.id === h.card.id)?.body).toContain(
          CHECKS_NOT_REPORTED_WORDS,
        );
        // A new offer waits on the empty reading, and the refusal names the declaration.
        const held = h.emit("The no-CI change is ready");
        await expect(held).rejects.toThrow(`the checks read ${CHECK_WORDS.pending}, not passed`);
        await expect(held).rejects.toThrow("absentChecks");
        // Another version is refused in words; nothing registers.
        expect(await h.declare({ absentChecks: absence("another-version") })).toContain(
          "Absence declaration refused",
        );
        expect(h.tasks.get(h.taskId)?.delivery?.checks?.absenceDeclared).toBe(false);
        // This version's declaration registers on the task's own pull request.
        expect(await h.declare({ absentChecks: absence(NO_CI) })).toContain(
          "Absence evidence stored for this version",
        );
        const delivery = h.tasks.get(h.taskId)?.delivery;
        expect(delivery).toMatchObject({
          checks: { items: [], absenceDeclared: true },
          mergeReviews: [{ number: 7, headSha: NO_CI }],
        });
        expect(delivery && currentCheckStatus(delivery)).toBe("green");
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WORDS["merge-pr"]));
        const body = h.cards().find((card) => card.id === h.card.id)?.body ?? "";
        expect(body).toContain(CHECKS_ABSENT_WORDS);
        expect(body).not.toContain(CHECKS_NOT_REPORTED_WORDS);
        // The offer goes up now, and nothing failed, so no Merge anyway.
        await repairTurn(h, async () => {
          await expect(h.emit("The no-CI change is ready")).resolves.toContain("card-");
        });
        const card = h.cards().find((entry) => entry.title === "The no-CI change is ready");
        expect(card?.actions.some((action) => action.passes === "checks")).toBe(false);
        expect(h.forge.merges).toEqual([]);
      });

      it("completes a kept click on an empty reading exactly once when the crew declares that version's absence, with no checks override (INF-1955, INF-1966)", async () => {
        const h = await approved();
        await noCiVersion(h);
        // The crew revises its card at the no-CI version; the empty reading holds its merge.
        await repairTurn(h, async () => {
          await expect(
            h.specs[0]?.onCard?.({
              requiredActions: [],
              id: h.card.id,
              title: "Ready to merge",
              body: completionBody("<p>The change is one setting now.</p><p>Pushed.</p>"),
              actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
            }),
          ).resolves.toContain(COMPLETION_REVISED_WHILE_RUNNING);
        });
        expect(h.tasks.get(h.taskId)?.delivery?.completionOffers?.at(-1)?.headSha).toBe(NO_CI);
        expect(mergeLabelOf(h)).toBe(MERGE_WHEN_CHECKS_PASS_WORDS);
        // The captain's conditional click waits on the checks and sends nothing.
        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
        expect(h.authorization()?.approvedHead).toBe(NO_CI);
        expect(h.forge.sends).toBe(0);
        // The crew's declaration for that version arrives; the next idle boundary merges once.
        await repairTurn(h, async () => {
          expect(await h.declare({ absentChecks: absence(NO_CI) })).toContain(
            "Absence evidence stored for this version",
          );
        });
        await vi.waitFor(() => expect(h.forge.merges).toEqual([NO_CI]));
        expect(h.forge.sends).toBe(1);
        expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" });
        expect(h.authorization()?.status).toBe("consumed");
        // The conditional click was never turned into a checks waiver.
        expect(h.tasks.get(h.taskId)?.delivery?.override).toBeUndefined();
      });

      // INF-1966: on DOP-140 the first mate cited the captain's click on
      // Merge when checks pass as their words passing the checks, and a pull
      // request with no checks merged with no word of theirs that the checks
      // need not pass. The click is their approval, kept until the checks
      // pass; only their own words pass them.
      it("refuses an override of the checks on his click on Merge when checks pass, and the kept click waits until his own words pass them (INF-1966)", async () => {
        const h = await approved();
        h.forge.states = [];
        await h.declare({});
        expect(h.tasks.get(h.taskId)?.delivery).toMatchObject({
          ci: "pending",
          checks: { items: [] },
        });
        await vi.waitFor(() => expect(mergeLabelOf(h)).toBe(MERGE_WHEN_CHECKS_PASS_WORDS));
        h.supervisor.cardActions.act(h.card.id, "merge");
        await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
        // What the first mate cites from the card is his click on its merge.
        const clicked = choiceWords(MERGE_WHEN_CHECKS_PASS_WORDS, "Ready to merge");
        expect(h.supervisor.overrides.citedCaptainWords(h.taskId, h.card.id)).toEqual({
          ok: true,
          words: clicked,
          mergeClick: true,
        });
        expect(
          h.supervisor.overrides.declareOverride(h.taskId, {
            words: clicked,
            mergeClick: true,
            holds: ["checks"],
            until: "task",
          }),
        ).toEqual({ ok: false, text: mergeClickRefusal(clicked) });
        expect(h.tasks.get(h.taskId)?.delivery?.override).toBeUndefined();
        await tick();
        expect(h.forge.sends).toBe(0);
        expect(h.authorization()?.waiting).toMatchObject({ on: "checks" });
        // His own words that the checks need not pass do, and his kept click merges.
        h.supervisor.overrides.declareOverride(h.taskId, {
          words: "This project has no CI; merge it without the checks.",
          holds: ["checks"],
          until: "version",
        });
        await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
      });

      it("never holds the first mate's merge on its own card, while a crewmate's question holds it until his words pass it", async () => {
        const h = await approved();
        editPolicies(h, { autonomy: true });
        const question = {
          title: "Which unit first?",
          body: "<p>Gallons or liters first?</p><p>Gallons is what the meter shows today.</p>",
          actions: [
            { id: "gallons", label: "Gallons", default: true },
            { id: "liters", label: "Liters" },
          ],
        };
        await h.specs[0]?.onCard?.({ ...question, id: "unit" });
        await tick();
        h.supervisor.addFirstmateCard({ ...question, title: "Merge it now?", taskId: h.taskId });
        expect(
          (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr")).text,
        ).toContain(softHoldWords("decisions", "firstmate"));
        h.supervisor.closeCard(
          `card-${h.taskId}-unit`,
          { kind: "crewmate", taskId: h.taskId },
          "the unit is settled",
        );
        await tick();
        await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
        expect(h.forge.merges).toEqual([APPROVED]);
      });

      it("shows on the merge card what his words pass while they pass it, with his words on rest", async () => {
        const h = await approved();
        const strip = () =>
          h
            .cards()
            .find((card) => card.id === h.card.id)
            ?.body.match(
              /<span class="inf-fact" data-fact="override"[\s\S]*?<\/span><\/span>/,
            )?.[0];
        expect(strip()).toBeUndefined();
        h.supervisor.overrides.declareOverride(h.taskId, {
          words: "Merge it past the waits; I tried it myself.",
          holds: ["waits", "checks"],
          until: "version",
        });
        await vi.waitFor(() => expect(strip()).toContain("the waits · the checks"));
        expect(strip()).toContain(
          'title="Your words pass the waits and the checks for this version: &quot;Merge it past the waits; I tried it myself.&quot;"',
        );
        // A newer version is one his words did not cover.
        seedDelivery(h.tasks, h.taskId, { headSha: "fixed0004" });
        await vi.waitFor(() => expect(strip()).toBeUndefined());
      });

      it("refuses a version-long override before the task has a version", async () => {
        const { supervisor, tasks } = setup(fakeCrewmate());
        seedTask(tasks, { id: "no-head", title: "Ship the fix", status: "idle" });
        const declared = supervisor.overrides.declareOverride("no-head", {
          words,
          holds: ["checks"],
          until: "version",
        });
        expect(declared.ok).toBe(false);
        expect(tasks.get("no-head")?.delivery?.override).toBeUndefined();
      });
    });
  });
});
