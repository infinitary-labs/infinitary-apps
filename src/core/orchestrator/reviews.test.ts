import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptedValidation } from "@shared/liveValidation";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reportTurn,
  reviewTurn,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  served,
  setup,
  tick,
  typedReview,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { crewmateCardPicturesDir } from "../paths";
import type { CrewMachines } from "../placed/crewMachines";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";
import { taskFeedLine } from "../tasks/taskFeed";
import { readChangeReading } from "../workspace/workspaceService";
import type { CrewmateSpec } from "./crewSession";
import { REVIEW_FIX_RULES, renderRigorSection } from "./intentBrief";
import {
  REVIEW_NEW_HEAD_NEXT,
  REVIEW_PASSED_NEXT,
  REVIEW_PROOF_NEXT,
  REVIEWER_IDLE_NEXT,
  reviewFindingsNext,
} from "./reportWakes";
import { renderReviewHistory } from "./reviewHistory";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the reviewed tier (delivery rigor phase 2)", () => {
  const BUILDER_REPORT =
    "Intent: the meter test passes ten runs in a row. What changed: the test awaits the queue flush. Verified: pnpm test on the final commit; PR is green. Risk: low. Not done: nothing.";
  const HEAD = "0123456789abcdef0123456789abcdef01234567";

  /** Findings the scripted reviewers report, typed (INF-1875). */
  const RACE = {
    id: "F1",
    severity: "error" as const,
    file: "src/meter.ts",
    line: 12,
    text: "the flush races the read",
    action: "auto-fix" as const,
  };
  const RACY = {
    id: "F1",
    severity: "error" as const,
    file: "src/meter.test.ts",
    line: 12,
    text: "racy",
    action: "auto-fix" as const,
  };
  const NOTE = {
    id: "F1",
    severity: "info" as const,
    file: "src/meter.ts",
    line: 1,
    text: "a note",
    action: "no-op" as const,
  };

  // INF-1876: a care name decides nothing in the host, the sort included; a
  // Careful builder asks for its review with needs_firstmate (the care
  // guidance), which the sort reads as it reads any report.
  it("sorts a Careful builder's report like any other; only a review's own report skips the whose-turn sort", async () => {
    const repo = gitRepo();
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, sorts, ops, repos } = setup(crewmate, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(crewmate, taskId, BUILDER_REPORT);
      expect(sorts.map((sort) => sort.taskId)).toEqual([taskId]);
      expect(ops.filter((line) => line.includes(`reported on task ${taskId}`))).toHaveLength(1);
    } finally {
      repo.dispose();
    }
  });

  it("refuses review_of as text only for no commits, an unknown task or a review already open: a report and Careful care are not prerequisites (INF-1875)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const scratch = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const quickReviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [scratch, reviewer, quickReviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      const quick = await supervisor.intake.commission({
        title: "Scratch",
        intent: intentOf("poke"),
        repoId: view.id,
        shape: { rigor_ask: "quick" },
      });
      await tick();
      const review = (of: string) =>
        supervisor.intake.commission({
          title: "Review",
          intent: intentOf("fix it"),
          shape: { review_of: of },
        });

      // A review is an operation on a change at a version: its one
      // prerequisite is commits to read on the builder's branch.
      await expect(review(taskId)).rejects.toThrow(/no commits on its branch to review yet/);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      await expect(review("nope")).rejects.toThrow(/Unknown task "nope" in review_of/);

      // Before the builder reported, the brief says so where its report goes.
      const first = await review(taskId);
      await tick();
      expect(first.crewmate).not.toBe("queued");
      expect(reviewer.promptCalls).toHaveLength(1);
      // The brief reads the branch, not a PR: none exists yet.
      expect(reviewer.promptCalls[0]).toContain(`Review branch fm/task-${taskId} at head ${HEAD}`);
      expect(reviewer.promptCalls[0]).toContain(
        "The builder's report:\nThe builder has not reported yet.",
      );
      await expect(review(taskId)).rejects.toThrow(/already has a review open/);

      // Care is a name on the record, never a gate: a Quick task is reviewed
      // on request the same way.
      const onQuick = await review(quick.taskId);
      await tick();
      expect(onQuick.crewmate).not.toBe("queued");
      expect(tasks.get(onQuick.taskId)).toMatchObject({
        parentId: quick.taskId,
        title: "Review: Scratch",
      });
      expect(quickReviewer.promptCalls[0]).toContain(
        `Review branch fm/task-${quick.taskId} at head ${HEAD}`,
      );
      expect(quickReviewer.promptCalls[0]).not.toContain("Care:");
      // The two builders and their two reviewers: four crewmates in all.
      expect(supervisor.crewStatus()).toHaveLength(4);
    } finally {
      repo.dispose();
    }
  });

  it("binds a pre-push review of repaired work to the committed branch head when an older pull request exists (INF-288)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      const recorded = "6402d3ba04120d65fc232dff5fb3d055ae16cb7b";
      const repaired = "4c771ba299a659abbafb79096c024a0b0737139c";
      const later = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      seedDelivery(tasks, builderId, {
        prUrl: "https://github.com/o/r/pull/39",
        prNumber: 39,
        headSha: recorded,
        ci: "green",
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(repaired);

      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(workspace.branchHead).toHaveBeenCalled();
      expect(workspace.reviewChangedFiles).toHaveBeenCalledWith(expect.any(String), repaired);
      expect(tasks.get(reviewId)?.delivery?.headSha).toBe(repaired);
      expect(tasks.get(reviewId)?.delivery?.headSha).not.toBe(recorded);
      const brief = reviewer.promptCalls[0] ?? "";
      expect(brief).toContain(`at head ${repaired}`);
      expect(brief).toContain(`git diff <default>...${repaired}`);
      expect(brief).toContain("review the assigned commit, not that pull request's recorded head.");
      expect(brief).not.toContain(recorded);
      expect(
        tasks.timeline(builderId).find((event) => event.text.includes("review opened"))?.text,
      ).toContain(`at ${repaired.slice(0, 7)}`);

      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The flush races the read.", {
        code: "findings",
        findings: [RACE],
        risk: { level: "medium", why: "one line moves." },
      });
      expect(tasks.get(builderId)?.delivery?.reviewSha).toBe(repaired);

      vi.mocked(workspace.branchHead).mockResolvedValue(later);
      // INF-125 supplies this lifecycle fixture's proof separately from the
      // existing assertion that review uses the committed repair, not the PR.
      seedDelivery(tasks, builderId, { liveValidation: noSurfaceProof(later, reviewId) });
      await supervisor.steerCrewmate(reviewId, "re-review the repaired commit");
      await tick();
      expect(tasks.get(reviewId)?.delivery?.headSha).toBe(later);
      expect(reviewer.promptCalls.at(-1)).toContain(`at head ${later}`);
      expect(reviewer.promptCalls.at(-1)).not.toContain(recorded);
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "the repair is the committed head." },
      });
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewSha: later,
        headSha: recorded,
      });
    } finally {
      repo.dispose();
    }
  });

  it("scopes a review commissioned after an earlier pass to the difference since it, through its re-review (INF-401)", async () => {
    // The captain's direction: after an unavoidable update, the re-review
    // checks only the update's difference, not the whole change again.
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const firstReviewer = fakeCrewmate();
      const updateReviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [firstReviewer, updateReviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      const passed = "15911c8f2a6d0e3b4c5a69788796a5b4c3d2e1f0";
      const updated = "fbc93601d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7";
      const fixed = "2d0fa6b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3";
      const review = () =>
        supervisor.intake.commission({
          title: "Review",
          intent: intentOf("fix it"),
          shape: { review_of: builderId },
        });

      // The first review has no earlier pass: it reads the whole change.
      vi.mocked(workspace.branchHead).mockResolvedValue(passed);
      // INF-125: this empty-branch lifecycle fixture has no running product,
      // but its first code pass still needs the assigned reviewer's proof judgment.
      const proof = noSurfaceProof(passed);
      proof.reviews = [];
      seedDelivery(tasks, builderId, { liveValidation: proof });
      const { taskId: firstId } = await review();
      await tick();
      expect(firstReviewer.promptCalls[0]).not.toContain("An earlier review already passed");
      expect(tasks.get(firstId)?.delivery?.passedHead).toBeUndefined();
      seedDelivery(tasks, builderId, { liveValidation: noSurfaceProof(passed, firstId) });
      await reviewTurn({ tasks, specs }, firstReviewer, 1, firstId, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "small." },
      });
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewSha: passed,
      });

      // The builder brings its branch up to date; the next review reads
      // only what changed since the pass.
      vi.mocked(workspace.branchHead).mockResolvedValue(updated);
      const { taskId: updateId } = await review();
      await tick();
      const brief = updateReviewer.promptCalls[0] ?? "";
      expect(brief).toContain(`Review branch fm/task-${builderId} at head ${updated}`);
      expect(brief).toContain(`An earlier review already passed this change at ${passed}`);
      expect(brief).toContain(`git range-diff <default>..${passed} <default>..${updated}`);
      expect(tasks.get(updateId)?.delivery).toMatchObject({ headSha: updated, passedHead: passed });
      expect(
        tasks.timeline(builderId).findLast((event) => event.text.includes("review opened"))?.text,
      ).toContain(
        `at ${updated.slice(0, 7)}, only what changed since the pass at ${passed.slice(0, 7)}`,
      );

      // A findings round keeps the scope at the fixed head, though the
      // builder's latest verdict is no longer that pass.
      await reviewTurn(
        { tasks, specs },
        updateReviewer,
        2,
        updateId,
        "The update drops the flush.",
        {
          code: "findings",
          findings: [{ ...RACE, text: "the update drops the flush" }],
          risk: { level: "medium", why: "one line moves." },
        },
      );
      expect(tasks.get(builderId)?.delivery?.reviewVerdict).toBe("findings");
      vi.mocked(workspace.branchHead).mockResolvedValue(fixed);
      await supervisor.steerCrewmate(updateId, `re-review at head ${fixed}`);
      await tick();
      const reread = updateReviewer.promptCalls.at(-1) ?? "";
      expect(reread).toContain(`at head ${fixed}`);
      expect(reread).toContain(`git range-diff <default>..${passed} <default>..${fixed}`);
      expect(tasks.get(updateId)?.delivery).toMatchObject({ headSha: fixed, passedHead: passed });
    } finally {
      repo.dispose();
    }
  });

  it("answers a review given a named model with the model that took it, since a review never routes on one (FI3-444)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate({ model: { provider: "openai-codex", id: "gpt-5.5" } });
      const { supervisor, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, taskId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);

      const review = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("review it on fable"),
        shape: { review_of: taskId, override_model_id: "claude-fable-5-1" },
      });
      expect(review.model).toEqual({ named: "claude-fable-5-1", took: "openai-codex/gpt-5.5" });
    } finally {
      repo.dispose();
    }
  });

  it("runs the review: host brief, no hold, findings idle, pass closes the review", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const mergePullRequest = vi.fn(async () => ({
        ok: true,
        text: "Change #55 is in on GitHub.",
      }));
      const { supervisor, tasks, repos, ops, inbox, specs, cards, workspace, sorts } = setup(
        builder,
        {
          routedModel: { provider: "openai-codex", id: "gpt-5.5" },
          crewmates: [reviewer],
          mergePullRequest,
        },
      );
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("make the meter test stop flaking"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      // Its first report names no review: none is open, and commissioning
      // one is the core's rule.
      expect(ops.find((line) => line.includes(`reported on task ${builderId}`))).not.toContain(
        "Its open review",
      );
      // Review-before-PR: nothing is pushed yet - the reviewer reads the
      // builder's branch at its committed head.
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);

      // No host hold reads the care's name (INF-1876): a completion card
      // before the review is the crew's own judgment, which the care guidance
      // carries. Its body carries the evidence contract (phase 3), so once
      // the review passes the same card publishes.
      const premature = () =>
        (specs[0] as CrewmateSpec).onCard?.({
          requiredActions: [],
          title: "The meter test is steady",
          body: completionBody(
            [
              "<h3>Intent</h3><p>The meter test passes ten runs in a row.</p>",
              "<h3>What changed</h3><p>The test awaits the queue flush.</p>",
              "<h3>Verified</h3><p>Reran the suite ten times.</p>",
              "<h3>Risk</h3><p>Low.</p>",
              "<h3>Not done</h3><p>Nothing.</p>",
            ].join(""),
          ),
          actions: [
            { id: "merge", label: "Merge PR", default: true, effect: SETTLE_MERGE },
            { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
          ],
        });

      // The reviewer: host-briefed, read-only by brief, kind review by the host.
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "whatever the Firstmate called it",
        intent: intentOf("make the meter test stop flaking"),
        repoId: view.id,
        shape: { review_of: builderId },
      });
      await tick();
      const review = tasks.get(reviewId);
      expect(review).toMatchObject({
        title: "Review: Fix the meter test",
        repoId: view.id,
        status: "active",
        difficulty: "high",
      });
      // The parent edge is the one stored review-to-builder join (the
      // review_of fold): the shape carries no builder pointer beyond basis.
      expect(review?.parentId).toBe(builderId);
      expect(review?.shape).toEqual({
        kind: "review",
        kind_source: "host:review",
        basis: builderId,
      });
      expect(review?.intent?.goal).toBe(
        'Review the change for "Fix the meter test" and report findings.',
      );
      const brief = reviewer.promptCalls[0] ?? "";
      expect(brief).toContain(
        "You are reviewing, not building: change nothing, commit nothing, push nothing.",
      );
      expect(brief).toContain(`Review branch fm/task-${builderId} at head ${HEAD}`);
      // INF-29: the brief names the assigned commit, not the live branch.
      expect(brief).toContain(`git diff <default>...${HEAD}`);
      expect(brief).not.toContain(`git diff <default>...fm/task-${builderId}`);
      expect(brief).toContain(
        `Changed-file checklist at ${HEAD} (committed paths against the default branch):\n- "src/meter.ts"\n- "tests/meter.test.ts"`,
      );
      expect(brief).toContain(`The builder's report:\n${BUILDER_REPORT}`);
      expect(brief).toContain("make the meter test stop flaking");
      // No rigor section on a review: it ships nothing.
      expect(brief).not.toContain("Care:");
      expect(review?.shape?.rigor).toBeUndefined();
      // No hold: the review carries no edge onto the builder (INF-1876).
      expect(tasks.graph.blockersHoldingClose(builderId)).toEqual([]);
      // No cache of the join on the builder: the parent edge is the one.
      const opened = tasks.get(builderId);
      expect(opened?.delivery).not.toHaveProperty("reviewTaskId");
      expect(opened && tasks.graph.verdictReviewOf(opened)).toBeUndefined();
      expect(supervisor.crewStatus(builderId)[0]?.review).toBe(`review open (${review?.key})`);
      expect(supervisor.crewStatus(reviewId)[0]?.review).toBe(
        `reviews ${tasks.get(builderId)?.key}`,
      );
      // No refusal of the host's: the review is a delivery child, never
      // counted in the children-open gate, and holds no close of its own.
      expect(tasks.graph.blockerRefusal(builderId)).toBeUndefined();
      expect(mergePullRequest).not.toHaveBeenCalled();
      // The builder is idle while its reviewer reads: the open review is a
      // witness the ladder alone reads (INF-1876), so however long the
      // review takes, no nudge reaches the builder and no idle wake the
      // Firstmate - the verdict is what moves it.
      const promptsBeforeReview = builder.promptCalls.length;
      supervisor.reconcileIdle(Date.now() + 200 * 60_000);
      await tick();
      expect(builder.promptCalls).toHaveLength(promptsBeforeReview);
      expect(sorts.filter((sort) => sort.rule.startsWith("idle"))).toEqual([]);
      expect(ops.filter((line) => line.includes("has been idle for"))).toEqual([]);

      // Findings: recorded on the builder, the reviewer idle and steerable,
      // the wake to the Firstmate direct - supervision never sees it.
      await reviewTurn(
        { tasks, specs },
        reviewer,
        1,
        reviewId,
        "Two findings: the flush is awaited after the read, and the copy says Later.",
        {
          code: "findings",
          findings: [
            { ...RACY, text: "the flush is awaited after the read" },
            {
              id: "F2",
              severity: "warning",
              file: "src/meter.ts",
              line: 40,
              text: "the copy says Later",
              action: "ask-user",
            },
          ],
          risk: { level: "medium", why: "one production line moves." },
        },
      );
      expect(tasks.get(reviewId)).toMatchObject({ status: "active", activity: "idle" });
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "findings",
        reviewSha: HEAD,
        reviewRisk: "medium",
        reviewRiskNote: "one production line moves.",
      });
      const recorded = tasks.get(builderId);
      expect(recorded && tasks.graph.verdictReviewOf(recorded)?.id).toBe(reviewId);
      const findingsWake = ops.find((line) => line.includes("with verdict findings"));
      expect(findingsWake).toContain(`reported on review task ${reviewId}`);
      expect(findingsWake).toContain(`the review of task ${builderId} "Fix the meter test"`);
      expect(findingsWake).toContain("F1 error src/meter.test.ts:12");
      // What comes next rides the wake (FI3-566 cut C; INF-1876): the fix
      // rules and the auto-fix finding, relayed verbatim; the brief names
      // the care and nothing of what it asks.
      expect(findingsWake?.endsWith(` ${reviewFindingsNext()}`)).toBe(true);
      expect(builder.promptCalls[0]).toContain(renderRigorSection("reviewed"));
      expect(inbox.allFor("supervision")).toHaveLength(0);
      expect(supervisor.crewStatus(builderId)[0]?.review).toBe(`review open (${review?.key})`);
      expect(tasks.graph.blockerRefusal(builderId)).toBeUndefined();

      // The builder's fix report names its open review, the verdict and
      // head it last read, and the re-review a new head asks for; the typed
      // review is a live-validation record, so the evidence and state
      // revisions it read ride the report too (INF-1875). It is sorted like
      // any report (INF-1876): the Firstmate's finding card on the builder
      // is a decision on the captain's screen, and the open review's
      // verdict still wakes the Firstmate above it, who alone steers the
      // reviewer to the new head.
      await supervisor.steerCrewmate(
        builderId,
        "F1 error src/meter.test.ts:12 the flush is awaited after the read - auto-fix",
      );
      await tick();
      (specs[0] as CrewmateSpec).onCard?.({
        title: "Keep the Later copy?",
        body: "<p>F2 warning src/meter.ts:40: the copy says Later.</p><p>Keep it or change it.</p>",
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      });
      await tick();
      const findingCard = supervisor.cards
        .snapshot()
        .find((entry) => entry.title === "Keep the Later copy?");
      expect(findingCard).toBeDefined();
      const beforeFix = ops.length;
      await reportTurn(builder, builderId, "Moved the await before the read; committed 89abcde.");
      expect(sorts.at(-1)).toEqual({
        taskId: builderId,
        verdict: "captain",
        rule: "review-reread",
      });
      expect(ops.slice(beforeFix)).toEqual([
        `[fm-op] crewmate 1 reported on task ${builderId} "Fix the meter test": Moved the await before the read; committed 89abcde. Its card on the captain's screen: ${findingCard?.id} (decision) "Keep the Later copy?". Its open review ${review?.key} last returned findings at 0123456. It read evidence revision 0; the builder now has revision 0. Its assigned validation state is 0; the builder now has state 0. ${REVIEW_NEW_HEAD_NEXT}`,
      ]);
      // The click returns to the builder as a message, and that turn ends
      // quietly: the builder is idle again while the reviewer re-reads.
      supervisor.act(findingCard?.id ?? "", "keep");
      await tick();
      expect(builder.promptCalls.at(-1)).toBe(
        'Card "Keep the Later copy?": the user chose "Keep the copy" (keep).',
      );
      builder.emit({ type: "turn_end", taskId: builderId });
      builder.finishPrompt();
      await tick();

      // A re-review at the new head: the reviewer is steered like any idle
      // crewmate, and its pass closes the review.
      await supervisor.steerCrewmate(reviewId, `re-review at head ${HEAD}`);
      await tick();
      expect(reviewer.promptCalls.at(-1)).toContain("re-review at head");
      seedDelivery(tasks, builderId, {
        liveValidation: noSurfaceProof(tasks.get(reviewId)!.delivery!.headSha!, reviewId),
      });
      seedDelivery(tasks, reviewId, {
        validationAssignment: {
          head: tasks.get(reviewId)!.delivery!.headSha!,
          revision: 1,
          scenarioRevision: 1,
          effects: [],
        },
      });
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "one test file changed." },
      });
      expect(tasks.get(reviewId)).toMatchObject({ status: "done", closedReason: "finished" });
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewSha: HEAD,
        reviewChange: "a".repeat(64),
        reviewRisk: "low",
        reviewRiskNote: "one test file changed.",
      });
      // The one feed line is the builder's own review event; the review
      // task's close is silent.
      const builderRecord = tasks.get(builderId) as TaskRecord;
      const passed = tasks
        .timeline(builderId)
        .find((event) => event.kind === "review" && event.feed);
      expect(passed?.text).toBe("review passed at 0123456, risk low: one test file changed.");
      expect(taskFeedLine(builderRecord, passed as TaskEvent)?.text).toBe(
        "Passed its review, low risk",
      );
      const closeEvent = tasks
        .timeline(reviewId)
        .find((event) => event.kind === "status" && event.data?.reason === "finished");
      expect(closeEvent).toMatchObject({ feed: false, text: "review passed - Fix the meter test" });
      // The wake refs the builder - the next move is on it, and the review's
      // own lane was purged with its close.
      const passWake = ops.find((line) => line.includes("passed at 0123456"));
      expect(passWake).toContain(
        `the review of task ${builderId} "Fix the meter test" passed at 0123456 (risk low: one test file changed.)`,
      );
      expect(passWake).toContain(`review task ${tasks.get(reviewId)?.key} is closed`);
      expect(passWake?.endsWith(` ${REVIEW_PASSED_NEXT}`)).toBe(true);
      expect(supervisor.crewStatus(builderId)[0]?.review).toBe("review passed");
      expect(tasks.graph.blockersHoldingClose(builderId)).toEqual([]);

      // After the pass the builder pushes and opens the PR (the new
      // ordering); the completion card then publishes, with the review
      // beside CI in the host's facts strip - the verdict and risk on the
      // line, the risk note on the cell's title - and the merge goes
      // through.
      seedDelivery(tasks, builderId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: HEAD,
        ci: "green",
        ciAt: Date.now(),
      });
      const cardId = (await premature()) as string;
      await tick();
      const card = cards().find((entry) => entry.id === cardId);
      expect(card?.body).toContain('passed <span class="inf-mono">0123456</span> · risk low');
      // The review risk note remains; retired findings counts do not ride it.
      expect(card?.body).toContain('title="one test file changed."');
      expect(
        await supervisor.settling.settle.settleTask(builderId, "merge-pr", undefined, "captain"),
      ).toContain("Change #55");
      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      expect(tasks.get(builderId)).toMatchObject({ status: "done", closedReason: "merged" });
    } finally {
      repo.dispose();
    }
  });

  it("INF-125 and INF-148: a completion keeps unchanged code clearance, and the proof's version is a recorded fact (INF-1876)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const { supervisor, tasks, repos, specs, cards } = setup(builder, { realWorkspace: true });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Explain the meter fixture",
        intent: intentOf("Document the meter fixture."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, taskId, BUILDER_REPORT);
      const task = tasks.get(taskId)!;
      const run = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-C",
            task.worktreeDir!,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@localhost",
            ...args,
          ],
          { encoding: "utf8" },
        ).trim();
      writeFileSync(
        join(task.worktreeDir!, "fixture.txt"),
        "This lifecycle fixture has no running product.\n",
      );
      run("add", "fixture.txt");
      run("commit", "-m", "docs: explain the fixture");
      const reviewed = run("rev-parse", "HEAD");
      const reading = await readChangeReading(task.repoDir, reviewed);
      run("commit", "--allow-empty", "-m", "chore: retain the unchanged fixture");
      const updated = run("rev-parse", "HEAD");
      const currentReading = await readChangeReading(task.repoDir, updated);
      if (!reading || reading !== currentReading)
        throw new Error("The fixture must retain its actual unchanged patch.");
      seedDelivery(tasks, taskId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: updated,
        ci: "green",
        reviewVerdict: "pass",
        reviewSha: reviewed,
        reviewChange: reading,
        versionReadings: { [updated]: currentReading },
        liveValidation: noSurfaceProof(reviewed),
      });
      const offer = () =>
        specs[0]!.onCard!({
          requiredActions: [],
          title: "The fixture documentation is ready",
          body: completionBody(
            "<p>The change explains a plain text fixture; it has no running behavior.</p>",
          ),
          actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }],
        });
      // The proof stands at the reviewed version, not the offered one: the
      // record says so, and the card goes up; nothing of the host's holds it.
      const cardId = await offer();
      await tick();
      expect(cards().map((card) => card.id)).toContain(cardId);
      expect(tasks.get(taskId)?.delivery?.reviewSha).toBe(reviewed);
      expect(tasks.get(taskId)?.delivery?.validationHead).toBe(updated);
      expect(acceptedValidation(tasks.get(taskId)?.delivery?.liveValidation, updated).ready).toBe(
        false,
      );
    } finally {
      repo.dispose();
    }
  });

  it("retires the review with the builder: a discard cascades, the parent is fixed, no orphaned reviewer", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The flush races the read.", {
        code: "findings",
        findings: [RACE],
        risk: { level: "medium", why: "one line moves." },
      });
      expect(tasks.get(reviewId)).toMatchObject({ status: "active", activity: "idle" });

      // The join is the parent edge, and the host keeps it: a re-parent
      // would silently sever the verdict path.
      expect(() => tasks.setParent(reviewId, null, "firstmate")).toThrow(/its parent is fixed/);

      // The discard raises no children-open refusal for the review - a
      // delivery child is not the captain's planned work - and the cascade
      // retires it with the builder: closed superseded, silently, its
      // worktree removed with its own close.
      expect(await supervisor.settling.settle.settleTask(builderId, "discard", true)).toContain(
        "Discarded",
      );
      expect(tasks.get(builderId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
      expect(tasks.get(reviewId)).toMatchObject({
        status: "dropped",
        closedReason: "superseded",
      });
      const closeEvent = tasks
        .timeline(reviewId)
        .find((event) => event.kind === "status" && event.data?.reason === "superseded");
      expect(closeEvent).toMatchObject({ feed: false });
      expect(closeEvent?.text).toContain('superseded - "Fix the meter test" closed');
      expect(
        vi
          .mocked(workspace.removeTaskWorktree)
          .mock.calls.some(([args]) => args.taskId === reviewId),
      ).toBe(true);
      // Nothing lingers: the closed review is no longer a crew row.
      expect(supervisor.crewStatus(reviewId)).toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  it("the served text of every review verdict wake (the typed envelope, P3)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const reviewer2 = fakeCrewmate();
      const env = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer, reviewer2],
      });
      const { supervisor, tasks, repos, ops, workspace, specs } = env;
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      // Re-review preparation needs the builder's committed head to remain readable.
      const before = ops.length;
      await reportTurn(reviewer, reviewId, "Standing by for the new head, nothing to say yet.");
      (specs[1] as CrewmateSpec).onCard?.({
        title: "A finding to look at",
        body: "<p>One finding.</p>",
        actions: [],
      });
      await tick();
      await supervisor.steerCrewmate(reviewId, "review again");
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The test is racy.", {
        code: "findings",
        findings: [RACY],
        risk: { level: "medium", why: "one line moves." },
      });
      await supervisor.steerCrewmate(reviewId, "review again");
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "no access to the branch", {
        code: "blocked",
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      await supervisor.steerCrewmate(reviewId, "review again");
      await tick();
      seedDelivery(tasks, builderId, {
        liveValidation: noSurfaceProof(tasks.get(reviewId)!.delivery!.headSha!, reviewId),
      });
      seedDelivery(tasks, reviewId, {
        validationAssignment: {
          head: tasks.get(reviewId)!.delivery!.headSha!,
          revision: 1,
          scenarioRevision: 1,
          effects: [],
        },
      });
      // Info findings ride a clear review and never block (the no-mistakes rule).
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "A note only.", {
        code: "clear",
        findings: [NOTE],
      });
      const reviewKey = tasks.get(reviewId)?.key;
      expect(ops.slice(before)).toEqual([
        `[fm-op] crewmate 2 reported on review task ${reviewId} "Review: Fix the meter test" - the review of task ${builderId} "Fix the meter test" - with no typed review record, so no verdict was recorded: Standing by for the new head, nothing to say yet. ${REVIEWER_IDLE_NEXT}`,
        `[fm-op] crewmate 2 reported on review task ${reviewId} "Review: Fix the meter test" - the review of task ${builderId} "Fix the meter test" - with verdict findings: The test is racy.\nFindings:\n- F1 error src/meter.test.ts:12 racy - auto-fix Its card on the captain's screen: card-${reviewId}-1 (note) "A finding to look at". ${reviewFindingsNext()}`,
        `[fm-op] crewmate 2 reported on review task ${reviewId} "Review: Fix the meter test" - the review of task ${builderId} "Fix the meter test" - with verdict blocked: no access to the branch\n${renderReviewHistory([{ kind: "round", at: 0, review: reviewKey ?? "", verdict: "findings", head: HEAD, findings: ["F1 error src/meter.test.ts:12 racy - auto-fix"] }])}\n Its card on the captain's screen: card-${reviewId}-1 (note) "A finding to look at". ${reviewFindingsNext()}`,
        `[fm-op] the review of task ${builderId} "Fix the meter test" passed at 0123456 (risk unstated); review task ${reviewKey} is closed. crewmate 2's report: A note only. Live proof at this head: accepted - The reviewer accepts the empty branch's no-surface reason, not a live pass. Latest proof run: revision 1 at 0123456, verdict no-surface, read by this review. ${REVIEW_PASSED_NEXT}`,
      ]);
      const { taskId: r2 } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      const b2 = ops.length;
      vi.mocked(workspace.branchHead).mockResolvedValue(null);
      seedDelivery(tasks, builderId, {
        liveValidation: noSurfaceProof(tasks.get(r2)!.delivery!.headSha!, r2),
      });
      seedDelivery(tasks, r2, {
        validationAssignment: {
          head: tasks.get(r2)!.delivery!.headSha!,
          revision: 1,
          scenarioRevision: 1,
          effects: [],
        },
      });
      await reviewTurn({ tasks, specs }, reviewer2, 2, r2, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "small." },
      });
      expect(ops.slice(b2)).toEqual([
        `[fm-op] the review of task ${builderId} "Fix the meter test" passed at 0123456 (risk low: small.); review task ${tasks.get(r2)?.key} is closed. crewmate 3's report: No findings. Live proof at this head: accepted - The reviewer accepts the empty branch's no-surface reason, not a live pass. Latest proof run: revision 1 at 0123456, verdict no-surface, read by this review. ${REVIEW_PASSED_NEXT}`,
      ]);
    } finally {
      repo.dispose();
    }
  });

  // INF-2672, the captain's direction A: "review the code first, prove once,
  // and the reviewer reads that proof once".
  it("a code pass before any proof asks for one proof run, and the proof read at that version reads only the proof", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const reviewer2 = fakeCrewmate();
      const env = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer, reviewer2],
      });
      const { supervisor, tasks, repos, ops, workspace, specs } = env;
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      // The scenarios are planned before the first edit; nothing has run.
      const planned = noSurfaceProof(HEAD);
      seedDelivery(tasks, builderId, {
        liveValidation: { ...planned, runs: [], reviews: [] },
      });
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(tasks.get(reviewId)?.delivery?.validationAssignment?.revision).toBe(0);
      const before = ops.length;
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The code is clean.", {
        code: "clear",
        coverageReason: "The scenario set covers the captain's words.",
        verdict: "inconclusive",
        reason: "Proof runs after the code passes.",
      });
      expect(ops.slice(before)).toEqual([
        `[fm-op] the review of task ${builderId} "Fix the meter test" passed at 0123456 (risk unstated); review task ${tasks.get(reviewId)?.key} is closed. crewmate 2's report: The code is clean. Live proof at this head: not accepted - This version needs live validation of the current scenarios. No proof run is recorded yet. ${REVIEW_PROOF_NEXT}`,
      ]);
      // The builder proves once at the passed version; the proof read follows.
      seedDelivery(tasks, builderId, {
        liveValidation: { ...planned, reviews: [] },
      });
      const { taskId: proofRead } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(tasks.get(proofRead)?.delivery?.passedHead).toBe(HEAD);
      expect(tasks.get(proofRead)?.prompt).toContain(
        `An earlier review already passed the code at this exact version, ${HEAD}. Do not review the code again: this turn is the proof read.`,
      );
      const b2 = ops.length;
      await reviewTurn({ tasks, specs }, reviewer2, 2, proofRead, "The proof holds.", {
        code: "clear",
      });
      expect(ops.slice(b2)).toEqual([
        `[fm-op] the review of task ${builderId} "Fix the meter test" passed at 0123456 (risk unstated); review task ${tasks.get(proofRead)?.key} is closed. crewmate 3's report: The proof holds. Live proof at this head: accepted - The reviewer accepts the empty branch's no-surface reason, not a live pass. Latest proof run: revision 1 at 0123456, verdict no-surface, read by this review. ${REVIEW_PASSED_NEXT}`,
      ]);
    } finally {
      repo.dispose();
    }
  });

  it("places the reviewer away from the builder's provider (R9): the router is asked to avoid it", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const asked: { taskId: string; avoidProvider?: string }[] = [];
      const { supervisor, tasks, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
        onRouteDecide: (args) =>
          asked.push({
            taskId: args.taskId,
            ...(args.avoidProvider ? { avoidProvider: args.avoidProvider } : {}),
          }),
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      seedDelivery(tasks, builderId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: HEAD,
        ci: "green",
        ciAt: Date.now(),
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(asked).toEqual([
        { taskId: builderId },
        { taskId: reviewId, avoidProvider: "openai-codex" },
      ]);
    } finally {
      repo.dispose();
    }
  });

  it("records nothing on a report with no typed review record: an acknowledgment is not a verdict and spends no round", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, ops, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      seedDelivery(tasks, builderId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: HEAD,
        ci: "green",
        ciAt: Date.now(),
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      // The exact shape of the four phantom rounds the record held before
      // the fix: a "standing by" acknowledgment ending a turn.
      await reportTurn(reviewer, reviewId, "Standing by. Send me the new SHA and I'll re-review.");
      expect(tasks.get(reviewId)?.status).toBe("active");
      expect(tasks.get(builderId)?.delivery?.reviewVerdict).toBeUndefined();
      expect(tasks.get(builderId)?.delivery?.reviewRounds).toBeUndefined();
      const wake = ops.find((line) => line.includes("with no typed review record"));
      expect(wake).toContain("no verdict was recorded");
      expect(ops.find((line) => line.includes("with verdict"))).toBeUndefined();
      // Nothing to hold: failing toward the human costs no round, and the
      // review stays open.
      expect(tasks.graph.blockersHoldingClose(builderId)).toEqual([]);
      expect(supervisor.crewStatus(builderId)[0]?.review).toBe(
        `review open (${tasks.get(reviewId)?.key})`,
      );

      // Info findings ride a clear review: info never blocks (the
      // no-mistakes rule), so the review closes and the hold releases.
      await supervisor.steerCrewmate(reviewId, `re-review at head ${HEAD}`);
      await tick();
      seedDelivery(tasks, builderId, {
        liveValidation: noSurfaceProof(tasks.get(reviewId)!.delivery!.headSha!, reviewId),
      });
      seedDelivery(tasks, reviewId, {
        validationAssignment: {
          head: tasks.get(reviewId)!.delivery!.headSha!,
          revision: 1,
          scenarioRevision: 1,
          effects: [],
        },
      });
      await reviewTurn(
        { tasks, specs },
        reviewer,
        1,
        reviewId,
        "The doc still names the old flow.",
        {
          code: "clear",
          findings: [
            {
              id: "F1",
              severity: "info",
              file: "docs/meter.md",
              line: 3,
              text: "the doc still names the old flow",
              action: "no-op",
            },
          ],
          risk: { level: "low", why: "notes only." },
        },
      );
      expect(tasks.get(reviewId)).toMatchObject({ status: "done", closedReason: "finished" });
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewRisk: "low",
        reviewRiskNote: "notes only.",
      });
      expect(
        tasks
          .timeline(builderId)
          .some(
            (event) =>
              event.kind === "review" &&
              event.text === "review passed at 0123456, risk low: notes only.",
          ),
      ).toBe(true);
      expect(tasks.graph.blockersHoldingClose(builderId)).toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  // INF-2625's plan, the crew supervisor's third step, moves the review's
  // settling out of the supervisor: a typed verdict counts only for the
  // commit the review was assigned before the turn that reported it.
  it("records no verdict typed for a commit the review was not assigned at its turn's end, and none when no commit is assigned", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, ops, workspace, specs } = setup(builder, {
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      seedDelivery(tasks, builderId, { liveValidation: noSurfaceProof(HEAD, reviewId) });
      seedDelivery(tasks, reviewId, {
        validationAssignment: { head: HEAD, revision: 1, scenarioRevision: 1, effects: [] },
      });
      const unstated = (words: string) =>
        served({
          facts: {
            kind: "review-unstated",
            task: { id: reviewId, title: "Review: Fix the meter test" },
            builder: { id: builderId, title: "Fix the meter test" },
            crewmate: "crewmate 2",
            excerpt: words,
          },
        });

      // The builder's newer commit arrives while the reviewer reads: the
      // review is assigned that commit before its turn ends.
      const NEWER = "fedcba9876543210fedcba9876543210fedcba98";
      await specs[1]!.onReport!("Reviewed the meter test.", undefined, {
        validation: typedReview(tasks, reviewId, { code: "clear" }),
      });
      seedDelivery(tasks, reviewId, { headSha: NEWER });
      await reportTurn(reviewer, reviewId, "Reviewed the meter test.");
      await vi.waitFor(() =>
        expect(ops).toContain(
          unstated(
            "The typed review names 0123456, not the assigned commit fedcba9. Steer the reviewer to review the assigned commit.",
          ),
        ),
      );
      expect(tasks.get(builderId)?.delivery?.reviewVerdict).toBeUndefined();
      expect(tasks.get(reviewId)?.status).toBe("active");

      // A review left with no assigned commit records nothing either.
      seedDelivery(tasks, reviewId, { headSha: HEAD });
      await supervisor.steerCrewmate(reviewId, `re-review at head ${HEAD}`);
      await tick();
      await specs[1]!.onReport!("Reviewed it again.", undefined, {
        validation: typedReview(tasks, reviewId, { code: "clear" }),
      });
      seedDelivery(tasks, reviewId, { headSha: undefined });
      await reportTurn(reviewer, reviewId, "Reviewed it again.");
      await vi.waitFor(() =>
        expect(ops).toContain(
          unstated(
            "No assigned review commit is recorded. Steer the reviewer for a new review before accepting a verdict.",
          ),
        ),
      );
      expect(tasks.get(builderId)?.delivery?.reviewVerdict).toBeUndefined();
      expect(tasks.get(reviewId)?.status).toBe("active");
    } finally {
      repo.dispose();
    }
  });

  // INF-288: a builder on another computer is reviewed where it runs. The
  // crew supervisor's third step (INF-2625's plan) moves this read out of
  // the supervisor; this pins it first.
  it("reads a placed builder's review target and kept proof on its computer, and refuses while that computer is out of reach", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reachable = { now: false };
      const copied: string[][] = [];
      const machines = {
        computers: () => [],
        ready: () => reachable.now,
        folders: (device: string, id: string) => ({
          work: `/${device}/${id}/work`,
          sessions: `/${device}/${id}/sessions`,
          evidence: `/${device}/${id}/evidence`,
        }),
        revision: async () => ({
          headSha: HEAD,
          changedFiles: ["src/meter.test.ts"],
          changeReading: "The meter test awaits the queue flush.",
        }),
        sourceFile: async (device: string, id: string, name: string, file: string) => {
          copied.push([device, id, name, file]);
          return `/${device}/${id}/${name}`;
        },
      } as unknown as CrewMachines;
      const { supervisor, tasks, repos, paths } = setup(builder, { machines });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      tasks.placement.setDevice(builderId, "mini");
      // The builder's kept proof: one transcript in its card pictures folder.
      const transcript = "pnpm test src/meter.test.ts: 10 of 10 passed\n";
      const file = `${builderId}-meter-run.txt`;
      const pictures = crewmateCardPicturesDir(paths, builderId);
      mkdirSync(pictures, { recursive: true });
      writeFileSync(join(pictures, file), transcript);
      const proof = noSurfaceProof(HEAD);
      seedDelivery(tasks, builderId, {
        liveValidation: {
          ...proof,
          runs: proof.runs.map((run) => ({
            ...run,
            evidence: [
              {
                id: "meter-run",
                description: "The meter test's ten runs",
                digest: createHash("sha256").update(transcript).digest("hex"),
                bytes: Buffer.byteLength(transcript),
                file,
                text: transcript,
              },
            ],
          })),
        },
      });
      const review = () =>
        supervisor.intake.commission({
          title: "Review",
          intent: intentOf("fix it"),
          shape: { review_of: builderId },
        });
      const reviews = () =>
        tasks.graph.children(builderId).filter((child) => child.shape?.kind === "review");

      await expect(review()).rejects.toThrow(
        "The builder's computer is out of reach; the review must wait for it, not run here instead.",
      );
      expect(reviews()).toEqual([]);
      expect(copied).toEqual([]);

      reachable.now = true;
      // Whether the reviewer then starts on that computer is the placement
      // tests' to pin; this one reads the review the host opened.
      await review().catch(() => {});
      const [opened] = reviews();
      expect(opened?.delivery).toMatchObject({
        headSha: HEAD,
        reviewChange: "The meter test awaits the queue flush.",
      });
      expect(opened?.prompt).toContain(`/mini/${builderId}/evidence`);
      expect(opened?.prompt).toContain("src/meter.test.ts");
      expect(opened?.prompt).toContain(`/mini/${builderId}/proof-${file}`);
      expect(copied).toEqual([["mini", builderId, `proof-${file}`, join(pictures, file)]]);
    } finally {
      repo.dispose();
    }
  });

  it("names the fix rules on every findings wake: no brief carries them (INF-1876)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, ops, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
      });
      await tick();
      // Briefed at Default care: no brief holds the fix rules.
      expect(builder.promptCalls[0]).toContain(renderRigorSection("standard"));
      expect(builder.promptCalls[0]).not.toContain(REVIEW_FIX_RULES);
      await reportTurn(builder, builderId, BUILDER_REPORT);
      tasks.updateFields(builderId, { policies: { rigor: "reviewed" } }, "firstmate");
      supervisor.policiesChanged(builderId, { rigor: "reviewed" });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The test is racy.", {
        code: "findings",
        findings: [RACY],
        risk: { level: "medium", why: "one line moves." },
      });
      const wake = ops.find((line) => line.includes("with verdict findings"));
      expect(wake?.endsWith(` ${reviewFindingsNext()}`)).toBe(true);
      expect(reviewFindingsNext()).toContain(`prefixed with - ${REVIEW_FIX_RULES}.`);
    } finally {
      repo.dispose();
    }
  });
});
