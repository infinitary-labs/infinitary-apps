import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTLE_FACT_VALUE_CLASS } from "@shared/cards";
import { REVIEW_EARLIER_WORDS } from "@shared/vocabulary";
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
import type { CrewmateSpec } from "./crewSession";
import { earlierPassText } from "./reportWakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the reviewed tier: the version a review reads (delivery rigor phase 2)", () => {
  const BUILDER_REPORT =
    "Intent: the meter test passes ten runs in a row. What changed: the test awaits the queue flush. Verified: pnpm test on the final commit; PR is green. Risk: low. Not done: nothing.";
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  /** The approved version of an earlier part a later part started on. */
  const APPROVED = "fedcba9876543210fedcba9876543210fedcba98";

  // INF-6225's builder committed on a second branch it checked out, leaving
  // the task's branch behind, and its reviews were blocked three times at
  // that branch: its review and its proof read the version it built.
  it("reviews and proves the commit a builder's working copy has checked out, not the task's branch left behind on another branch", async () => {
    const repo = gitRepo();
    try {
      const [builder, reviewer] = [fakeCrewmate(), fakeCrewmate()];
      const { supervisor, tasks, repos, specs } = setup(builder, {
        realWorkspace: true,
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId, started } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await started;
      await tick();
      await reportTurn(builder, taskId, BUILDER_REPORT);
      const task = tasks.get(taskId)!;
      const worktree = task.worktreeDir;
      if (!worktree || !task.branch) throw new Error(`${taskId} has no working copy yet.`);
      const run = (...args: string[]) =>
        execFileSync(
          "git",
          ["-C", worktree, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
          { encoding: "utf8" },
        ).trim();
      const left = run("rev-parse", "HEAD");
      run("switch", "--quiet", "-c", `${task.branch}-dev`);
      writeFileSync(join(worktree, "meter.test.ts"), "await queue.flush();\n");
      run("add", "meter.test.ts");
      run("commit", "-m", "fix: await the queue flush");
      const built = run("rev-parse", "HEAD");
      expect(run("rev-parse", task.branch)).toBe(left);

      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: taskId },
      });
      await vi.waitFor(() => expect(reviewer.promptCalls[0]).toContain(`${task.branch}-dev`));
      expect(tasks.get(reviewId)?.delivery?.headSha).toBe(built);
      expect(tasks.get(reviewId)?.prompt).toContain(`at head ${built}`);
      expect(tasks.get(reviewId)?.prompt).toContain('- "meter.test.ts"');

      await specs[0]!.onReport!("Planned the proof.", undefined, {
        validation: {
          kind: "plan",
          previousRevision: 0,
          reason: "The meter test has no running surface.",
          scenarios: [],
        },
      });
      await specs[0]!.onReport!("Ran the proof.", undefined, {
        validation: {
          kind: "run",
          id: "meter",
          head: built,
          scenarioRevision: 1,
          completion: "complete",
          verdict: "no-surface",
          reason: "The meter test has no running surface.",
          observations: [],
          evidence: [],
        },
      });
      expect(tasks.get(taskId)?.delivery?.liveValidation?.runs.map((entry) => entry.head)).toEqual([
        built,
      ]);
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
      expect(h.asked.review).toEqual({ head: OLD, uncommitted: true });
      expect(h.tasks.get(h.reviewId)?.delivery?.headSha).toBe(OLD);

      h.reviewer.emit({ type: "turn_failed", taskId: h.reviewId, error: "Internal error" });
      h.reviewer.emit({ type: "turn_end", taskId: h.reviewId });
      h.reviewer.finishPrompt();
      await tick();
      expect(h.tasks.get(h.reviewId)?.outcome ?? null).toBeNull();

      vi.mocked(h.workspace.branchHead).mockResolvedValue(NEW);
      await h.supervisor.steer.steerCrewmate(h.reviewId, "Review the repaired version.");
      await tick();
      expect(h.tasks.get(h.reviewId)?.delivery?.headSha).toBe(NEW);
      expect(h.reviewer.promptCalls.at(-1)).toContain("Current review assignment");

      const stale = { ...typedReview(h.tasks, h.reviewId, { code: "clear" }), head: OLD };
      await expect(
        h.specs[1]!.onReport!("Reviewed.", undefined, { validation: stale }),
      ).rejects.toThrow(
        `version ${NEW.slice(0, 7)} at evidence revision ${stale.revision}; this record names ${OLD.slice(0, 7)}`,
      );
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
