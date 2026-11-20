import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alreadyAllowedWords } from "@shared/captainAllowances";
import { SETTLE_FACT_VALUE_CLASS } from "@shared/cards";
import { branchComparePage } from "@shared/forge";
import { acceptedValidation } from "@shared/liveValidation";
import type { WorkShape } from "@shared/routingPolicy";
import { REVIEW_EARLIER_WORDS, REVIEW_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
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
import type { TaskRecord } from "../storage/taskRecords";
import { taskFeedLine } from "../tasks/taskFeed";
import { readChangeReading } from "../workspace/workspaceService";
import type { CrewmateSpec } from "./crewSession";
import { REVIEW_FIX_RULES, renderRigorSection } from "./intentBrief";
import { earlierPassText, REVIEW_CARD_RULES, REVIEW_HANDOFF_NEXT } from "./reportWakes";
import type { ReviewerChooser, ReviewerPick } from "./reviewerChoice";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

// Session audit finding E: the host delivers routine review work; only decisions wake the first mate.
const received = (crew: ReturnType<typeof fakeCrewmate>) =>
  [...crew.promptCalls, ...vi.mocked(crew.steer).mock.calls.map(([text]) => text)].join("\n");

describe("the reviewed tier (delivery rigor phase 2)", () => {
  const BUILDER_REPORT =
    "Intent: the meter test passes ten runs in a row. What changed: the test awaits the queue flush. Verified: pnpm test on the final commit; PR is green. Risk: low. Not done: nothing.";
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  /** The approved version of an earlier part a later part started on. */
  const APPROVED = "fedcba9876543210fedcba9876543210fedcba98";

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
      expect(supervisor.facts.crewStatus()).toHaveLength(4);
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
      await supervisor.steer.steerCrewmate(reviewId, "re-review the repaired commit");
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

  // Intent: INF-4196's approved plan keeps a batched change's compare page out of the
  // sentences that call the change's page a pull request: the reviewer of a batched change
  // is never told a pull request is open.
  it("never tells the reviewer of a batched change, whose page is its branch's compare page, that a pull request is open", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      // The project's way of merging is not what the brief reads: the record's change is.
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      const branch = `fm/task-${builderId}`;
      const page = branchComparePage({
        kind: "github",
        host: "github.com",
        owner: "o",
        name: "r",
        base: "main",
        branch,
      });
      seedDelivery(tasks, builderId, {
        changeLabel: branch,
        ...(page ? { prUrl: page } : {}),
        headSha: HEAD,
        ci: "green",
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      const brief = reviewer.promptCalls[0] ?? "";
      expect(brief).toContain(`at head ${HEAD}`);
      expect(brief).not.toContain("A pull request is already open");
      expect(page && brief).not.toContain(page);
      expect(
        tasks.timeline(builderId).find((event) => event.text.includes("review opened"))?.text,
      ).not.toContain("pull request");
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
      await supervisor.steer.steerCrewmate(updateId, `re-review at head ${fixed}`);
      await tick();
      const reread = updateReviewer.promptCalls.at(-1) ?? "";
      expect(reread).toContain(`at head ${fixed}`);
      expect(reread).toContain(`git range-diff <default>..${passed} <default>..${fixed}`);
      expect(tasks.get(updateId)?.delivery).toMatchObject({ headSha: fixed, passedHead: passed });
    } finally {
      repo.dispose();
    }
  });

  // INF-3170 piece 2, the captain's pick: a yes carries to "That task, its
  // reviewer, a stronger-model retry and a takeover of its work".
  it("serves the reviewer each yes the captain gave on the builder's work, as already allowed", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, repos, workspace, tasks } = setup(builder, {
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
      const yes = {
        words: 'Use my account, on the card "Run the meter check on your account"',
        covers: "Signing in with the captain's own account for the meter check",
        card: "card-meter",
        at: 1,
      };
      tasks.delivery.recordAllowance(taskId, yes);
      await reportTurn(builder, taskId, BUILDER_REPORT);
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);

      await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("review it"),
        shape: { review_of: taskId },
      });
      await vi.waitFor(() => expect(reviewer.promptCalls.length).toBeGreaterThan(0));
      expect(reviewer.promptCalls[0]).toContain(
        alreadyAllowedWords({ allowances: [yes] }, "reviewer"),
      );
    } finally {
      repo.dispose();
    }
  });

  it("pins a review to the model the captain named, and starts none on another model (FI3-444)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate({ model: { provider: "openai-codex", id: "gpt-5.5" } });
      const decided: WorkShape[] = [];
      const { supervisor, tasks, repos, workspace, ops } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        onRouteDecide: ({ shape }) => decided.push(shape),
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
      const builderKey = tasks.get(taskId)?.key || taskId;
      const reviews = () => tasks.list().filter((row) => row.shape?.kind === "review");

      // The builder's computer serves only another model: nothing starts,
      // and the first mate is told to ask the captain.
      await expect(
        supervisor.intake.commission({
          title: "Review",
          intent: intentOf("review it on fable"),
          shape: { review_of: taskId, override_model_id: "claude-fable-5-1" },
        }),
      ).rejects.toThrow(
        `No sign-in on ${builderKey}'s computer serves claude-fable-5-1, the model named for this review`,
      );
      expect(decided.at(-1)).toMatchObject({
        kind: "review",
        override_model_id: "claude-fable-5-1",
      });
      expect(reviews()).toEqual([]);

      // Named a model it serves, the review starts on it.
      const review = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("review it on gpt"),
        shape: { review_of: taskId, override_model_id: "gpt-5.5" },
      });
      await review.started;
      expect(decided.at(-1)).toMatchObject({ kind: "review", override_model_id: "gpt-5.5" });
      // It started on the model named, so no wake follows (INF-5123).
      expect(ops.filter((line) => line.includes(`task ${review.taskId} `))).toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  /**
   * Which model reviews (INF-5021; docs/delivery-rigor.md): with no model
   * named, a review start asks the reviewer question with the builder's
   * facts, how the review started, the usual pick and the placed models,
   * and routes with the pick kept as `review_model`. The question's answer
   * is the chooser's here; the router is the harness's stand-in, whose usual
   * pick is the routed model.
   */
  describe("the reviewer question at a review's start (INF-5021)", () => {
    const USUAL = { provider: "openai-codex", id: "gpt-5.5" };
    const FABLE = { provider: "anthropic-claude", id: "claude-fable-5-2" };
    const FABLE_KEY = `${FABLE.provider}/${FABLE.id}`;
    const USUAL_KEY = `${USUAL.provider}/${USUAL.id}`;

    async function reviewable(pick: ReviewerPick | undefined, miss?: string) {
      const repo = gitRepo();
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate({ model: USUAL });
      const decided: WorkShape[] = [];
      const asked: Parameters<ReviewerChooser["pick"]>[] = [];
      const h = setup(builder, {
        routedModel: USUAL,
        onRouteDecide: ({ shape }) => decided.push(shape),
        crewmates: [reviewer],
        reviewerChooser: {
          pick: async (...args) => {
            asked.push(args);
            return pick;
          },
        },
        reviewerModels: [{ ref: FABLE, slots: ["premium"], ...(miss ? { miss } : {}) }],
      });
      const { repo: view } = await h.repos.setup({
        kind: "adopt",
        path: repo.dir,
        name: repo.name,
      });
      h.repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, taskId, BUILDER_REPORT);
      vi.mocked(h.workspace.branchHead).mockResolvedValue(HEAD);
      const reviews = () => h.tasks.list().filter((row) => row.shape?.kind === "review");
      return { ...h, repo, view, taskId, decided, asked, reviews };
    }

    it("asks the question when the first mate starts a review, and routes with the pick it answers", async () => {
      const h = await reviewable(
        { mode: "prefer", key: FABLE_KEY, why: "its allowance is spent", source: "jev/jev-1" },
        "its allowance is spent",
      );
      try {
        const review = await h.supervisor.intake.commission({
          title: "Review",
          intent: intentOf("review it"),
          shape: { review_of: h.taskId },
        });
        await review.started;
        expect(h.asked).toHaveLength(1);
        const [, repoId, input] = h.asked[0] ?? [];
        expect(repoId).toBe(h.view.id);
        expect(input).toMatchObject({
          started: "first-mate",
          usual: `${USUAL.id} (${USUAL_KEY})`,
          builder: { title: "Fix the meter test", rigor: "Careful" },
          models: [{ key: FABLE_KEY, name: FABLE.id, levels: ["premium"] }],
        });
        expect(h.decided.at(-1)).toMatchObject({ kind: "review", review_model: FABLE_KEY });
        // The stand-in router took its usual model, so the record says the
        // directed model did not review, why, who picked it and which did.
        expect(h.tasks.timeline(review.taskId).map((event) => event.text)).toContain(
          `${FABLE.id}, the model a standing direction calls for (the decision model's pick, answered by jev/jev-1), did not review: its allowance is spent; ${USUAL.id} reviews instead`,
        );
      } finally {
        h.repo.dispose();
      }
    });

    it("starts nothing on a wait, names the usual pick by the key a named model takes, and asks nothing when the retry names it", async () => {
      const h = await reviewable(
        { mode: "wait", key: FABLE_KEY, why: "its allowance is spent" },
        "its allowance is spent",
      );
      try {
        await expect(
          h.supervisor.intake.commission({
            title: "Review",
            intent: intentOf("review it"),
            shape: { review_of: h.taskId },
          }),
        ).rejects.toThrow(
          `the same call with override_model_id naming a model by its key, such as ${USUAL_KEY}, starts it on that model.`,
        );
        expect(h.reviews()).toEqual([]);
        expect(h.asked).toHaveLength(1);

        // The retry the refusal names starts the review on that model, and a
        // named model is never put to the question.
        const review = await h.supervisor.intake.commission({
          title: "Review",
          intent: intentOf("review it on the usual model"),
          shape: { review_of: h.taskId, override_model_id: USUAL_KEY },
        });
        await review.started;
        expect(h.asked).toHaveLength(1);
        expect(h.decided.at(-1)).toMatchObject({ kind: "review", override_model_id: USUAL_KEY });
        expect(h.decided.at(-1)?.review_model).toBeUndefined();
      } finally {
        h.repo.dispose();
      }
    });
  });

  // The captain's answer on INF-3075's review of INF-3060: a review whose
  // start failed stays open with its working copy, as a failed spawn does.
  it("keeps a review whose start failed open for start_now, which starts it at the same head", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, sessions, ops } = setup(builder, {
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
      vi.mocked(sessions.open).mockRejectedValueOnce(new Error("Claude is not signed in here."));

      const review = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("review it"),
        shape: { review_of: taskId },
      });
      await review.started;
      expect(tasks.get(review.taskId)).toMatchObject({
        status: "open",
        gate: null,
        startPolicy: "on-request",
        parentId: taskId,
        startNotice: JSON.stringify({ reason: "Claude is not signed in here." }),
      });
      expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
      expect(ops.filter((line) => line.includes(`task ${review.taskId} `))).toEqual([
        renderWake({
          facts: {
            kind: "queued-start-failed",
            task: { id: review.taskId, title: "Review: Fix the meter test" },
            error: "Claude is not signed in here.",
            asked: true,
            open: true,
          },
        }),
      ]);
      // It is still the builder's open review, so no second one is spawned.
      await expect(
        supervisor.intake.commission({
          title: "Review",
          intent: intentOf("review it"),
          shape: { review_of: taskId },
        }),
      ).rejects.toThrow("already has a review open");

      await supervisor.starts.startQueuedNow(review.taskId);
      await vi.waitFor(() => expect(reviewer.promptCalls).toHaveLength(1));
      expect(tasks.get(review.taskId)?.status).toBe("active");
      expect(reviewer.promptCalls[0]).toContain(`at head ${HEAD}`);
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
      expect(supervisor.facts.crewStatus(builderId)[0]?.review).toBe(
        `review open (${review?.key})`,
      );
      expect(supervisor.facts.crewStatus(reviewId)[0]?.review).toBe(
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
      supervisor.watch.reconcileIdle(Date.now() + 200 * 60_000);
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
      expect(tasks.get(builderId)?.delivery).toMatchObject({
        reviewVerdict: "findings",
        reviewSha: HEAD,
        reviewRisk: "medium",
        reviewRiskNote: "one production line moves.",
      });
      const recorded = tasks.get(builderId);
      expect(recorded && tasks.graph.verdictReviewOf(recorded)?.id).toBe(reviewId);
      // INF-4338's direction D: the ask-user finding goes back to the
      // reviewer that read the change, with the card rules, and the first
      // mate hears nothing of it. The auto-fix finding goes to the builder
      // with the fix rules; the brief names the care and nothing it asks.
      expect(ops.filter((line) => line.includes("with verdict findings"))).toEqual([]);
      const cardAsk = reviewer.promptCalls.at(-1) ?? "";
      expect(cardAsk).toContain(
        `Findings for the captain:\n- F2 warning src/meter.ts:40 the copy says Later - ask-user\n${REVIEW_CARD_RULES}`,
      );
      expect(received(builder)).toContain("F1 error src/meter.test.ts:12");
      expect(builder.promptCalls[0]).toContain(renderRigorSection("reviewed"));
      expect(inbox.allFor("supervision")).toHaveLength(0);
      expect(supervisor.facts.crewStatus(builderId)[0]?.review).toBe(
        `review open (${review?.key})`,
      );
      expect(tasks.graph.blockerRefusal(builderId)).toBeUndefined();

      // The reviewer's decision is its Review finding card: on its own
      // task, labeled by the app, with the builder's facts strip. Its
      // report while the card is up, with no review record, wakes no one.
      const beforeCard = ops.length;
      const findingInput = {
        id: "review-meter",
        title: "Review of the meter fix",
        body: "<p>Keep the Later copy?</p>",
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      };
      (specs[1] as CrewmateSpec).onCard?.(findingInput);
      await reportTurn(reviewer, reviewId, "The card is up.");
      const findingCard = supervisor.cards
        .snapshot()
        .find((entry) => entry.title === "Review of the meter fix");
      expect(findingCard).toMatchObject({
        taskId: reviewId,
        author: "crewmate",
        reviewTaskId: reviewId,
      });
      expect(findingCard?.body).toContain(
        `<span class="inf-foot-k">Review</span> <span class="${SETTLE_FACT_VALUE_CLASS}">${REVIEW_WORDS.findings}</span>`,
      );
      expect(ops.slice(beforeCard)).toEqual([]);
      expect(tasks.get(reviewId)).toMatchObject({ status: "active", activity: "idle" });

      // A reply under the card reaches the reviewer, which answers it there.
      supervisor.cardActions.replyToCard(findingCard?.id ?? "", "Where does Later show?");
      await tick();
      expect(reviewer.promptCalls.at(-1)).toContain("Where does Later show?");
      (specs[1] as CrewmateSpec).onCard?.({
        ...findingInput,
        reply: "On the empty meter, before its first reading.",
        answersMessage: askedOn(supervisor, findingCard?.id ?? ""),
      });
      await reportTurn(reviewer, reviewId, "Answered under the card.");
      expect(ops.slice(beforeCard)).toEqual([]);

      // A builder report with no changed facts takes the ordinary sort.
      const beforeFix = ops.length;
      const dispute = "The committed version is unchanged; F1 needs an interpretation.";
      await reportTurn(builder, builderId, dispute);
      expect(ops.slice(beforeFix)).toEqual([expect.stringContaining(dispute)]);
      // An unchanged report cannot commission another review turn.
      expect(reviewer.promptCalls).toHaveLength(3);
      // The click goes to the builder with the review history, and no
      // first mate turn sits between.
      const beforeChoice = ops.length;
      supervisor.cardActions.act(findingCard?.id ?? "", "keep");
      await tick();
      expect(ops.slice(beforeChoice)).toEqual([]);
      const decision = builder.promptCalls.at(-1) ?? "";
      expect(decision).toContain('The captain chose "Keep the copy" on "Review of the meter fix".');
      expect(decision).toContain(
        `- The captain chose "keep" on card "Review of the meter fix" (${findingCard?.id}).`,
      );
      expect(decision).toContain(REVIEW_HANDOFF_NEXT.decision);
      // The answer keeps the code as built: the builder's unchanged report
      // goes to the reviewer, which reads the answer at the same version.
      await reportTurn(builder, builderId, "The captain kept the copy; nothing to change.");
      expect(ops.slice(beforeChoice)).toEqual([]);
      expect(reviewer.promptCalls).toHaveLength(4);
      expect(reviewer.promptCalls.at(-1)).toContain(REVIEW_HANDOFF_NEXT.reread);
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
      expect(ops.filter((line) => line.includes("passed at 0123456"))).toEqual([]);
      expect(received(builder)).toContain("The review passed. Follow your brief's delivery");
      // The crew list names the version the pass read (INF-3141).
      expect(supervisor.facts.crewStatus(builderId)[0]?.review).toBe("review passed at 0123456");
      expect(tasks.graph.blockersHoldingClose(builderId)).toEqual([]);

      // After the pass the builder pushes and opens the PR (the new
      // ordering); the completion card then publishes, with the review
      // beside CI in the host's facts strip - the verdict on the status
      // line, and on rest the version it read, the risk and the risk note
      // (INF-3709's plan) - and the merge goes through.
      seedDelivery(tasks, builderId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: HEAD,
        ci: "green",
        ciAt: Date.now(),
      });
      await reportTurn(builder, builderId, "Opened the pull request; the checks passed.");
      const cardId = (await premature()) as string;
      await tick();
      const card = cards().find((entry) => entry.id === cardId);
      expect(card?.body).toContain(
        `<span class="inf-foot-k">Review</span> <span class="${SETTLE_FACT_VALUE_CLASS}">${REVIEW_WORDS.pass}</span>`,
      );
      // The review risk note remains; retired findings counts do not ride it.
      expect(card?.body).toContain('title="Passed 0123456 · risk low. one test file changed."');
      expect(
        await supervisor.settling.settle.settleTask(builderId, "merge-pr", undefined, "captain"),
      ).toContain("Change #55");
      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      expect(tasks.get(builderId)).toMatchObject({ status: "done", closedReason: "merged" });
    } finally {
      repo.dispose();
    }
  });

  // INF-5004: a builder whose reviewer asked the captain a question waited
  // on that card, yet was reported stuck, nudged, woken about and refused
  // for naming the card, because supervision read only cards kept on the
  // builder's own task.
  it("counts the reviewer's question card as the builder's: its wait names the card, and nothing nudges or wakes while it is up", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, ops, specs, sorts, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
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
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review the meter fix",
        intent: intentOf("make the meter test stop flaking"),
        repoId: view.id,
        shape: { review_of: builderId },
      });
      await tick();
      // One finding the builder fixes, one its reviewer asks the captain about.
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "Two findings.", {
        code: "findings",
        findings: [
          RACY,
          {
            id: "F2",
            severity: "warning",
            file: "src/meter.ts",
            line: 40,
            text: "the copy says Later",
            action: "ask-user",
          },
        ],
        risk: { level: "low", why: "one line of copy." },
      });
      (specs[1] as CrewmateSpec).onCard?.({
        id: "review-meter",
        title: "Review of the meter fix",
        body: "<p>Keep the Later copy?</p>",
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      });
      await reportTurn(reviewer, reviewId, "The card is up.");
      const findingCard = supervisor.cards
        .snapshot()
        .find((entry) => entry.title === "Review of the meter fix");
      expect(findingCard).toMatchObject({ taskId: reviewId, reviewTaskId: reviewId });
      // The card places the builder's captain gate, naming it.
      expect(tasks.get(builderId)?.gate).toMatchObject({ kind: "captain", ref: findingCard?.id });

      // The builder's wait names its reviewer's card, by the id the
      // reviewer gave it: accepted, and the receipt promises no wake.
      const beforeReport = { ops: ops.length, sorts: sorts.length };
      const receipt = await (specs[0] as CrewmateSpec).onReport?.(
        "Waiting on the captain's answer on the reviewer's card.",
        undefined,
        { wait: { reason: "Answer the reviewer's question", cardId: "review-meter" } },
      );
      expect(receipt).toContain("Your task now waits on the captain");
      expect(receipt).not.toContain("first mate is woken");
      // waits_on naming its own review is dropped with a receipt line.
      const named = await (specs[0] as CrewmateSpec).onReport?.(
        "Waiting on the captain's answer on the reviewer's card.",
        undefined,
        {
          wait: { reason: "Answer the reviewer's question", cardId: findingCard?.id },
          waitsOn: [tasks.get(reviewId)?.key ?? reviewId],
        },
      );
      expect(named).toContain("your task's own review, so no wait was recorded on it");
      expect(tasks.graph.liveBlocks(builderId)).toEqual([]);
      await reportTurn(
        builder,
        builderId,
        "Waiting on the captain's answer on the reviewer's card.",
      );
      expect(tasks.get(builderId)?.delivery?.captainWait).toMatchObject({
        cardId: findingCard?.id,
      });
      expect(sorts.slice(beforeReport.sorts).map((sort) => sort.rule)).toEqual(["captain-card"]);
      expect(ops.slice(beforeReport.ops)).toEqual([]);
      // The dot reads Waiting on you.
      expect(supervisor.postures.workPosture(tasks.get(builderId) as TaskRecord)).toEqual({
        state: "idle",
        reason: "captain",
      });

      // However long the card stays up, nothing nudges the builder or wakes
      // the first mate about it.
      const prompts = builder.promptCalls.length;
      const idleSince = tasks.get(builderId)?.idleSince ?? Date.now();
      for (const minutes of [11, 22, 45]) {
        supervisor.watch.reconcileIdle(idleSince + minutes * 60_000);
        await tick();
      }
      expect(builder.promptCalls).toHaveLength(prompts);
      expect(sorts.slice(beforeReport.sorts).map((sort) => sort.rule)).toEqual(["captain-card"]);
      expect(ops.slice(beforeReport.ops)).toEqual([]);

      // A builder that reports finished hears that the card still holds its
      // task, and no promise about who reads the report; with its review
      // last returning findings, the turn's sort still wakes the first mate (row 0c).
      await supervisor.steer.steerCrewmate(builderId, "Say where the fix stands.");
      await tick();
      const beforeFinished = { ops: ops.length, sorts: sorts.length };
      const finished = await (specs[0] as CrewmateSpec).onReport?.(
        "Done once the captain answers the reviewer.",
        undefined,
        { finished: true },
      );
      expect(finished).toContain("A card about your task is still open");
      expect(finished).not.toContain("wake the first mate");
      await reportTurn(builder, builderId, "Done once the captain answers the reviewer.");
      expect(sorts.slice(beforeFinished.sorts).map((sort) => sort.rule)).toEqual(["review-reread"]);
      expect(ops.slice(beforeFinished.ops)).toEqual([
        expect.stringContaining("Done once the captain answers the reviewer."),
      ]);

      // The captain's answer reaches the builder and lifts the gate the card placed.
      supervisor.cardActions.act(findingCard?.id ?? "", "keep");
      await tick();
      expect(received(builder)).toContain(
        'The captain chose "Keep the copy" on "Review of the meter fix".',
      );
      expect(tasks.get(builderId)?.gate?.ref).not.toBe(findingCard?.id);
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
      const { taskId, started } = await supervisor.intake.commission({
        title: "Explain the meter fixture",
        intent: intentOf("Document the meter fixture."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      // Its working copy is made behind the spawn's answer (INF-3060).
      await started;
      await tick();
      await reportTurn(builder, taskId, BUILDER_REPORT);
      const task = tasks.get(taskId)!;
      // An empty folder would run git in the folder the tests run from and
      // commit there, so the fixture refuses one.
      const worktree = task.worktreeDir;
      if (!worktree) throw new Error(`${taskId} has no working copy yet.`);
      const run = (...args: string[]) =>
        execFileSync(
          "git",
          ["-C", worktree, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
          { encoding: "utf8" },
        ).trim();
      writeFileSync(
        join(worktree, "fixture.txt"),
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
      expect(supervisor.facts.crewStatus(reviewId)).toEqual([]);
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
      expect(supervisor.facts.crewStatus(builderId)[0]?.review).toBe(
        `review open (${tasks.get(reviewId)?.key})`,
      );

      // Info findings ride a clear review: info never blocks (the
      // no-mistakes rule), so the review closes and the hold releases.
      await supervisor.steer.steerCrewmate(reviewId, `re-review at head ${HEAD}`);
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
      await supervisor.steer.steerCrewmate(reviewId, `re-review at head ${HEAD}`);
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

  // INF-4517 piece 3 and the independent review's finding on it: a part built on an earlier
  // part's approved version is reviewed on its own difference against that version, still
  // after the earlier part merged as a squash commit.
  it("reviews a part built on an approved version against that version, after the earlier part merged too", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Show the export in the panel",
        intent: intentOf("show it"),
        repoId: view.id,
      });
      await tick();
      await reportTurn(builder, builderId, BUILDER_REPORT);
      const base = tasks.create({ id: "base", title: "Add the export", prompt: "p", repoId: null });
      tasks.placement.setBuiltOn(builderId, {
        task: base.key,
        branch: "inf/export",
        head: APPROVED,
      });
      tasks.close(base.id, { status: "done", reason: "merged", actor: "host" });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const builtOnAt = vi.fn(async () => APPROVED);
      Object.assign(workspace, { builtOnAt });

      await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("show it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(builtOnAt).toHaveBeenCalledWith(expect.any(String), APPROVED, HEAD);
      expect(workspace.reviewChangedFiles).toHaveBeenCalledWith(expect.any(String), HEAD, APPROVED);
      expect(reviewer.promptCalls[0]).toContain(`git diff ${APPROVED}...${HEAD}`);
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
      const revisionArgs: unknown[][] = [];
      const machines = {
        computers: () => [],
        ready: () => reachable.now,
        folders: (device: string, id: string) => ({
          work: `/${device}/${id}/work`,
          sessions: `/${device}/${id}/sessions`,
          evidence: `/${device}/${id}/evidence`,
        }),
        revision: async (...args: unknown[]) => {
          revisionArgs.push(args);
          return {
            headSha: HEAD,
            changedFiles: ["src/meter.test.ts"],
            changeReading: "The meter test awaits the queue flush.",
          };
        },
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
      // Built on an earlier part's approved version, which this computer's read cannot see.
      const base = tasks.create({ id: "base", title: "Add the export", prompt: "p", repoId: null });
      tasks.placement.setBuiltOn(builderId, {
        task: base.key,
        branch: "inf/export",
        head: APPROVED,
      });
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
      // The approved version goes with the read; a computer that answers none read from the
      // default branch, so the brief claims no narrower scope.
      expect(revisionArgs).toContainEqual(["mini", builderId, undefined, APPROVED]);
      expect(opened?.prompt).toContain(`git diff <default>...${HEAD}`);
      expect(opened?.prompt).not.toContain(APPROVED);
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
      expect(ops.filter((line) => line.includes("with verdict findings"))).toEqual([]);
      expect(received(builder)).toContain(REVIEW_FIX_RULES);
      expect(received(builder)).toContain("F1 error src/meter.test.ts:12 racy - auto-fix");
    } finally {
      repo.dispose();
    }
  });
});

// INF-3141 (the captain's direction 1, "Show the version everywhere and fix
// the stuck reviewer"): a review's verdict, its refusal, its ask and every
// screen that shows a pass are bound to the version the review read.
describe("a review bound to the version it read (INF-3141)", () => {
  const OLD = "0123456789abcdef0123456789abcdef01234567";
  const NEW = "fedcba9876543210fedcba9876543210fedcba98";

  async function commissioned() {
    const builder = fakeCrewmate();
    const reviewer = fakeCrewmate();
    const env = setup(builder, { crewmates: [reviewer] });
    const repo = gitRepo();
    const { repo: view } = await env.repos.setup({
      kind: "adopt",
      path: repo.dir,
      name: repo.name,
    });
    env.repos.configure(view.id, { delivery: "direct-pr" });
    const { taskId: builderId } = await env.supervisor.intake.commission({
      title: "Fix the meter test",
      intent: intentOf("fix it"),
      repoId: view.id,
    });
    await tick();
    await reportTurn(builder, builderId, "Intent: fix. Committed.");
    vi.mocked(env.workspace.branchHead).mockResolvedValue(OLD);
    // The builder still holds edits not yet committed when the review is asked for.
    vi.mocked(env.workspace.taskWorkStatus).mockResolvedValueOnce({
      dirty: true,
      unlandedCommits: 0,
    });
    const asked = await env.supervisor.intake.commission({
      title: "Review",
      intent: intentOf("fix it"),
      shape: { review_of: builderId },
    });
    await tick();
    return { ...env, repo, builder, reviewer, builderId, reviewId: asked.taskId, asked };
  }

  it("names the assigned version on the ask, and moves a reviewer whose first turn failed to the builder's newer commit", async () => {
    const h = await commissioned();
    try {
      // The ask's answer names the version it assigned and the edits it cannot see.
      expect(h.asked.review).toEqual({ head: OLD, uncommitted: true });
      expect(h.tasks.get(h.reviewId)?.delivery?.headSha).toBe(OLD);

      // The reviewer's first turn fails at the provider: no report.
      h.reviewer.emit({ type: "turn_failed", taskId: h.reviewId, error: "Internal error" });
      h.reviewer.emit({ type: "turn_end", taskId: h.reviewId });
      h.reviewer.finishPrompt();
      await tick();
      expect(h.tasks.get(h.reviewId)?.outcome ?? null).toBeNull();

      // The builder commits its repair; the steer's turn is assigned it.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(NEW);
      await h.supervisor.steer.steerCrewmate(h.reviewId, "Review the repaired version.");
      await tick();
      expect(h.tasks.get(h.reviewId)?.delivery?.headSha).toBe(NEW);
      expect(h.reviewer.promptCalls.at(-1)).toContain("Current review assignment");

      // A verdict for the earlier version is refused, naming both versions.
      const stale = { ...typedReview(h.tasks, h.reviewId, { code: "clear" }), head: OLD };
      await expect(
        h.specs[1]!.onReport!("Reviewed.", undefined, { validation: stale }),
      ).rejects.toThrow(
        `version ${NEW.slice(0, 7)} at evidence revision ${stale.revision}; this record names ${OLD.slice(0, 7)}`,
      );
      // The verdict at the assigned version records the pass.
      await reviewTurn(h, h.reviewer, 1, h.reviewId, "No findings.", { code: "clear" });
      expect(h.tasks.get(h.builderId)?.delivery).toMatchObject({
        reviewVerdict: "pass",
        reviewSha: NEW,
      });
    } finally {
      h.repo.dispose();
    }
  });

  it("says a pass covers only an earlier version on the crew list, the builder's report and the merge card", async () => {
    const h = await commissioned();
    try {
      await reviewTurn(h, h.reviewer, 1, h.reviewId, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "one test file changed." },
      });
      expect(h.supervisor.facts.crewStatus(h.builderId)[0]?.review).toBe(
        `review passed at ${OLD.slice(0, 7)}`,
      );
      // The builder commits more work after the pass and pushes it.
      vi.mocked(h.workspace.branchHead).mockResolvedValue(NEW);
      seedDelivery(h.tasks, h.builderId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        headSha: NEW,
        ci: "green",
        ciAt: Date.now(),
      });
      expect(h.supervisor.facts.crewStatus(h.builderId)[0]?.review).toBe(
        `review passed at ${OLD.slice(0, 7)} only, an earlier version than ${NEW.slice(0, 7)} on offer`,
      );
      await h.supervisor.steer.steerCrewmate(h.builderId, "Push and drive CI green.");
      await tick();
      await reportTurn(h.builder, h.builderId, "Repaired the flush after the pass.");
      const wake = h.ops.filter((line) => line.includes(`reported on task ${h.builderId}`)).at(-1);
      expect(wake).toContain(earlierPassText({ read: OLD, offered: NEW }));

      const cardId = await (h.specs[0] as CrewmateSpec).onCard?.({
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
      await tick();
      const body = h.cards().find((entry) => entry.id === cardId)?.body ?? "";
      expect(body).toContain(
        `<span class="inf-foot-k">Review</span> <span class="${SETTLE_FACT_VALUE_CLASS}">${REVIEW_EARLIER_WORDS}</span>`,
      );
      expect(body).toContain(
        `Passed ${OLD.slice(0, 7)} · risk low. It does not cover ${NEW.slice(0, 7)}, the version on offer.`,
      );
    } finally {
      h.repo.dispose();
    }
  });
});
