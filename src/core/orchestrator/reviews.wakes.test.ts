import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reportTurn,
  reviewTurn,
  setup,
  tick,
  typedReview,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { DeviceOutOfReachError } from "../connection/connection";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import type { CrewMachines } from "../placed/crewMachines";
import { bindTool } from "../session/tools";
import type { CrewmateSpec } from "./crewSession";
import { IDLE_NUDGE_TEXT } from "./idleWakes";
import { REVIEWER_IDLE_NEXT, reviewFindingsNext } from "./reportWakes";
import { renderReviewHistory } from "./reviewHistory";

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
      const before = ops.length;
      await reportTurn(reviewer, reviewId, "Standing by for the new head, nothing to say yet.");
      (specs[1] as CrewmateSpec).onCard?.({
        title: "A finding to look at",
        body: "<p>One finding.</p>",
        actions: [],
      });
      await tick();
      await supervisor.steer.steerCrewmate(reviewId, "review again");
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The test is racy.", {
        code: "findings",
        findings: [RACY],
        risk: { level: "medium", why: "one line moves." },
      });
      await supervisor.steer.steerCrewmate(reviewId, "review again");
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "no access to the branch", {
        code: "blocked",
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      await supervisor.steer.steerCrewmate(reviewId, "review again");
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
      expect(received(builder)).toContain("F1 error src/meter.test.ts:12 racy - auto-fix");
      expect(received(builder)).toContain("The review passed. Follow your brief's delivery");
      expect(ops.slice(before)).toEqual([
        `[fm-op] crewmate 2 reported on review task ${reviewId} "Review: Fix the meter test" - the review of task ${builderId} "Fix the meter test" - with no typed review record, so no verdict was recorded: Standing by for the new head, nothing to say yet. ${REVIEWER_IDLE_NEXT}`,
        `[fm-op] crewmate 2 reported on review task ${reviewId} "Review: Fix the meter test" - the review of task ${builderId} "Fix the meter test" - with verdict blocked: no access to the branch\n${renderReviewHistory([{ kind: "round", at: 0, review: reviewKey ?? "", verdict: "findings", head: HEAD, findings: ["F1 error src/meter.test.ts:12 racy - auto-fix"] }])}\n Its card on the captain's screen: card-${reviewId}-1 (note) "A finding to look at". ${reviewFindingsNext()}`,
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
      expect(ops.slice(b2)).toEqual([]);
      expect(received(builder)).toContain("The review passed. Follow your brief's delivery");
    } finally {
      repo.dispose();
    }
  });

  // INF-2672, the captain's direction A: "review the code first, prove once,
  // and the reviewer reads that proof once".
  it.each(["local-only", "direct-pr"] as const)(
    "a code pass preserves proof order and nudges a stopped proof builder (%s, F2/F3/F7)",
    async (delivery) => {
      const repo = gitRepo();
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      let now = Date.now();
      try {
        const builder = fakeCrewmate();
        const reviewer = fakeCrewmate();
        const reviewer2 = fakeCrewmate();
        const env = setup(builder, {
          now: () => now,
          routedModel: { provider: "openai-codex", id: "gpt-5.5" },
          crewmates: [reviewer, reviewer2],
        });
        const { supervisor, tasks, repos, ops, workspace, specs } = env;
        const { repo: view } = await repos.setup({
          kind: "adopt",
          path: repo.dir,
          name: repo.name,
        });
        repos.configure(view.id, { delivery });
        const { taskId: builderId } = await supervisor.intake.commission({
          title: "Fix the meter test",
          intent: intentOf("fix it"),
          repoId: view.id,
          shape: { rigor_ask: "reviewed" },
        });
        await tick();
        await reportTurn(builder, builderId, BUILDER_REPORT);
        vi.mocked(workspace.branchHead).mockResolvedValue(head);
        // The scenarios are planned before the first edit; nothing has run.
        const planned = noSurfaceProof(head);
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
        expect(ops.slice(before)).toEqual([]);
        expect(tasks.get(reviewId)?.status).toBe("active");
        expect(received(builder)).toContain("Run live proof once after this code review");
        // F2/F3: an unchanged prose blocker takes the normal sort, and a retained
        // idle reader cannot hide a stopped builder from the one-clock ladder.
        const blocker = "The proof is blocked: the disposable launcher cannot start yet.";
        await reportTurn(builder, builderId, blocker);
        expect(ops.slice(before)).toEqual([expect.stringContaining(blocker)]);
        expect(env.sorts.at(-1)?.rule).toBe("stopped");
        expect(tasks.get(reviewId)?.activity).toBe("idle");
        const idleSince = tasks.get(builderId)?.idleSince;
        if (idleSince == null) throw new Error("The proof builder stopped at the host's clock.");
        now = idleSince + 10 * 60_000;
        supervisor.watch.reconcileIdle(now);
        await tick();
        expect(received(builder)).toContain(IDLE_NUDGE_TEXT);
        expect(env.sorts).toContainEqual({
          taskId: builderId,
          verdict: "routine",
          rule: "idle-nudge",
        });

        // The builder proves once at the passed version; the proof read follows.
        seedDelivery(tasks, builderId, {
          liveValidation: { ...planned, reviews: [] },
        });
        await reportTurn(
          builder,
          builderId,
          "The planned no-surface proof is recorded at the reviewed commit.",
        );
        await tick();
        const proofRead = reviewId;
        expect(tasks.get(proofRead)?.delivery?.passedHead).toBe(head);
        expect(received(reviewer)).toContain(
          `An earlier review already passed the code at this exact version, ${head}. Do not review the code again: this turn is the proof read.`,
        );
        const b2 = ops.length;
        await reviewTurn({ tasks, specs }, reviewer, 1, proofRead, "The proof holds.", {
          code: "clear",
        });
        expect(ops.slice(b2)).toEqual([]);
        expect(received(builder)).toContain("The review passed. Follow your brief's delivery");
      } finally {
        repo.dispose();
      }
    },
  );

  // Session audit finding E: exercise both directions through the real
  // supervisor and durable inbox, with committed files as the head readings.
  it.each([false, true])(
    "returns a repair once and sorts unchanged disputes (declared result: %s, F2/F4)",
    async (withResult) => {
      const repo = gitRepo();
      try {
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" }).trim();
        const builder = fakeCrewmate();
        const reviewer = fakeCrewmate();
        const { supervisor, tasks, repos, ops, workspace, specs, sorts } = setup(builder, {
          routedModel: { provider: "openai-codex", id: "gpt-5.5" },
          crewmates: [reviewer],
        });
        const { repo: view } = await repos.setup({
          kind: "adopt",
          path: repo.dir,
          name: repo.name,
        });
        repos.configure(view.id, { delivery: "direct-pr" });
        const { taskId } = await supervisor.intake.commission({
          title: "Keep merge approval while the batch runs",
          intent: intentOf("Keep the saved merge until its batch passes"),
          repoId: view.id,
        });
        await tick();
        await reportTurn(builder, taskId, "The merge approval now waits for the batch check.");
        const initial = git("rev-parse", "HEAD");
        vi.mocked(workspace.branchHead).mockResolvedValue(initial);
        const { taskId: reviewId } = await supervisor.intake.commission({
          title: "Review",
          intent: intentOf("Keep the saved merge until its batch passes"),
          shape: { review_of: taskId },
        });
        await tick();
        const before = ops.length;
        await reviewTurn(
          { tasks, specs },
          reviewer,
          1,
          reviewId,
          "The batch wait still wakes the first mate.",
          {
            code: "findings",
            findings: [
              {
                id: "F1",
                severity: "error",
                action: "auto-fix",
                text: "A healthy batch-only wait still sends a first mate wake.",
              },
            ],
          },
        );
        expect(received(builder)).toContain(
          "A healthy batch-only wait still sends a first mate wake.",
        );
        writeFileSync(
          join(repo.dir, "merge-wait.txt"),
          "The approved version waits for the batch check.\n",
        );
        git("add", "merge-wait.txt");
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit",
          "-m",
          "fix: keep the batch wait quiet",
        );
        const repaired = git("rev-parse", "HEAD");
        vi.mocked(workspace.branchHead).mockResolvedValue(repaired);
        if (withResult)
          await specs[0]?.onReport?.("Committed the quiet wait for the saved merge.", undefined, {
            result: { repaired: true },
          });
        await reportTurn(builder, taskId, "Committed the quiet wait for the saved merge.");
        await tick();
        expect(tasks.get(reviewId)?.delivery?.headSha).toBe(repaired);
        expect(received(reviewer)).toContain("Committed the quiet wait for the saved merge.");
        const returns = () =>
          received(reviewer)
            .split("\n")
            .filter((line) => line.startsWith("Host handoff from"));
        expect(returns()).toHaveLength(1);
        // F4: extra declared work may wake the first mate, but never asks it to
        // repeat the re-review the host just delivered.
        if (withResult) {
          expect(sorts.at(-1)?.rule).not.toBe("review-reread");
          expect(ops.slice(before)).toHaveLength(1);
          expect(ops.at(-1)).toContain("not to repeat a handoff");
        } else expect(ops.slice(before)).toEqual([]);
        await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "F1 still needs a repair.", {
          code: "findings",
          findings: [RACY],
        });
        const beforeDispute = ops.length;
        const dispute = "I dispute F1: the committed repair is unchanged and needs a decision.";
        await reportTurn(builder, taskId, dispute);
        await tick();
        expect(returns()).toHaveLength(1);
        expect(ops.slice(beforeDispute)).toEqual([expect.stringContaining(dispute)]);
        expect(sorts.at(-1)?.rule).toBe("review-reread");
        console.info(
          "Direct review handoff:",
          JSON.stringify({
            findings: received(builder)
              .split("\n")
              .filter((line) => line.includes("batch-only")),
            repairAssigned: tasks.get(reviewId)?.delivery?.headSha === repaired,
            returns: returns().length,
            disputedReportWakes: ops.length - beforeDispute,
          }),
        );
        // A typed request for a decision is not swallowed by routine routing.
        // The reader already stopped after its findings: start a real turn
        // to answer the dispute, rather than report from an idle session.
        const previousTurns = reviewer.promptCalls.length;
        await supervisor.steer.steerCrewmate(
          reviewId,
          "Read the builder's dispute and report the decision needed.",
        );
        await vi.waitFor(() => expect(reviewer.promptCalls).toHaveLength(previousTurns + 1));
        const beforeDecision = ops.length;
        await specs[1]?.onReport?.("The review needs a decision before publishing.", undefined, {
          validation: typedReview(tasks, reviewId, { code: "clear" }),
          needsFirstmate: "Choose whether the new requirement belongs in this change",
        });
        await reportTurn(reviewer, reviewId, "The review needs a decision before publishing.");
        expect(ops.slice(beforeDecision)).toEqual([
          expect.stringContaining("Choose whether the new requirement belongs in this change"),
        ]);
        expect(tasks.get(reviewId)?.status).toBe("active");
        expect(received(builder)).not.toContain("The review passed. Follow your brief's delivery");
      } finally {
        repo.dispose();
      }
    },
  );
  // INF-5142: on Nov 19 a builder on the Mac mini reported its fix while the
  // connection to that computer was cut; the read of its version for the
  // reviewer failed and the first mate had to recover the handoff. The
  // captain's words: "it shouldn't have required any user intervention".
  it("returns a fix whose builder's computer went mid-read once it is back, and tells the first mate only when it goes twice", async () => {
    const repo = gitRepo();
    try {
      const MINI = "875ece86-3e09-4c54-a108-15fafad9b31b";
      const WENT = "The connection to that computer went mid-request.";
      const FIXED = "fedcba9876543210fedcba9876543210fedcba98";
      const SECOND = "00112233445566778899aabbccddeeff00112233";
      const away = { now: false };
      const reading = { drops: 0, head: HEAD, reads: 0 };
      const machines = {
        computers: () => [MINI],
        nameOf: () => "the Mac mini",
        placeOf: () => ({ who: "the Mac mini", where: "on the Mac mini" }),
        ready: () => !away.now,
        folders: (device: string, id: string) => ({
          work: `/${device}/${id}/work`,
          sessions: `/${device}/${id}/sessions`,
          evidence: `/${device}/${id}/evidence`,
        }),
        // It names no checkout, as a computer older than that answer does.
        checkedOut: async () => null,
        // The read the connection's cut fails, as connection.ts raises it.
        revision: async () => {
          reading.reads++;
          if (reading.drops > 0) {
            reading.drops--;
            away.now = true;
            throw new DeviceOutOfReachError(WENT);
          }
          return { headSha: reading.head, changedFiles: ["src/meter.test.ts"] };
        },
        prepare: async () => ({ cwd: repo.dir, branch: "fm/review" }),
        bringBranchHome: async () => undefined,
        signInsOf: async () => null,
        served: async () => undefined,
        signInWait: () => undefined,
        accountOf: () => undefined,
        cutOffOf: () => undefined,
        servingAccount: () => undefined,
        takesCheckDeclarations: () => true,
      } as unknown as CrewMachines;
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, ops, workspace, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
        machines,
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("fix it"),
        repoId: view.id,
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
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "F1 needs a repair.", {
        code: "findings",
        findings: [RACY],
      });
      // Both run on the Mac mini from here, where the review reads the builder's version.
      tasks.placement.setDevice(builderId, MINI);
      tasks.placement.setDevice(reviewId, MINI);
      const returns = () =>
        received(reviewer)
          .split("\n")
          .filter((line) => line.startsWith("Host handoff from"));
      const lostLines = () =>
        tasks
          .timeline(builderId)
          .filter((event) => event.text.includes("went out of reach while the fix was read"));

      // The connection goes as the fix is read: nothing for the first mate, and the fix waits.
      const before = ops.length;
      reading.drops = 1;
      reading.head = FIXED;
      await supervisor.steer.steerCrewmate(builderId, "Repair F1.");
      await tick();
      await reportTurn(builder, builderId, "Committed the flush repair for F1.");
      await tick();
      expect(ops.slice(before)).toEqual([]);
      expect(returns()).toHaveLength(0);
      expect(lostLines()).toHaveLength(1);
      expect(lostLines()[0]?.text).toContain("once the Mac mini is back");
      const readsAway = reading.reads;
      await supervisor.watch.sweepGates(Date.now());
      await tick();
      expect(reading.reads).toBe(readsAway);

      away.now = false;
      supervisor.placedCaughtUp([builderId, reviewId]);
      await vi.waitFor(() => expect(returns()).toHaveLength(1));
      expect(received(reviewer)).toContain("Committed the flush repair for F1.");
      expect(tasks.get(reviewId)?.delivery?.headSha).toBe(FIXED);
      expect(ops.slice(before)).toEqual([]);

      // Lost again on its retry: the first mate hears once, with the computer and the point.
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "F1 still needs a repair.", {
        code: "findings",
        findings: [RACY],
      });
      const beforeTwice = ops.length;
      reading.drops = 2;
      reading.head = SECOND;
      await supervisor.steer.steerCrewmate(builderId, "Repair F1 again.");
      await tick();
      await reportTurn(builder, builderId, "Committed a second flush repair.");
      await tick();
      expect(ops.slice(beforeTwice)).toEqual([]);
      away.now = false;
      supervisor.placedCaughtUp([builderId, reviewId]);
      await vi.waitFor(() => expect(ops.length).toBe(beforeTwice + 1));
      expect(ops.at(-1)).toContain(
        "The host could not return the fix to its reviewer: the Mac mini went out of reach twice while the fix was read for its reviewer",
      );
      expect(returns()).toHaveLength(1);
      const readsTold = reading.reads;
      await supervisor.watch.sweepGates(Date.now());
      await tick();
      expect(reading.reads).toBe(readsTold);
      expect(ops.length).toBe(beforeTwice + 1);
    } finally {
      repo.dispose();
    }
  });
});

describe("a review of plan-built work", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";

  it("names the approved plan and the captain's choice on it", async () => {
    const repo = gitRepo();
    try {
      const planner = fakeCrewmate();
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const h = setup(planner, {
        crewmates: [builder, reviewer],
        classifier: {
          classify: async (input) =>
            input.title.startsWith("Plan")
              ? ({ kind: "research", source: "classifier:test", version: "kc1" } as const)
              : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
        },
      });
      const { view } = await h.repos
        .setup({ kind: "adopt", path: repo.dir, name: repo.name })
        .then(({ repo: view }) => ({ view }));
      h.repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: planId } = await h.supervisor.intake.commission({
        title: "Plan custom model prices",
        intent: { ...intentOf("plan custom prices"), constraints: [{ kind: "read-only" }] },
        repoId: view.id,
      });
      await tick();
      await bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec).run({
        title: "Plan: type a price for each custom model",
        body: '<p>Editing a name or price never re-runs the check.</p><fieldset data-inf-options-only><legend>Review</legend><label><input type="radio" name="careful" value="part-1" data-inf-recommended> Part 1</label></fieldset>',
        actions: [
          { id: "build", label: "Approve and build", default: true },
          { id: "defer", label: "Save and defer" },
        ],
      });
      h.specs.at(-1)?.onReport?.("The plan is on its card.");
      planner.emit({ type: "turn_end", taskId: planId });
      planner.finishPrompt();
      await tick();
      const card = h.cardStore.listOpen().find((entry) => entry.taskId === planId) as Card;
      h.supervisor.cardActions.act(card.id, "build", "chrome", {
        answers: [{ name: "careful", values: ["part-1"], labels: ["Part 1"], changed: true }],
      });
      await tick();
      const plan = h.tasks.get(planId);
      expect(plan?.status).toBe("done");

      const { taskId: builderId } = await h.supervisor.intake.commission({
        title: "Type a price for each custom model",
        intent: intentOf("build it"),
        repoId: view.id,
        shape: { basis: plan?.key ?? planId, rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, "Built the price fields.");
      vi.mocked(h.workspace.branchHead).mockResolvedValue(HEAD);
      await h.supervisor.intake.commission({
        title: "Review",
        intent: intentOf("build it"),
        shape: { review_of: builderId },
      });
      await tick();

      const brief = reviewer.promptCalls[0] ?? "";
      const builderKey = h.tasks.get(builderId)?.key;
      expect(brief).toContain(
        `${builderKey} is built on ${plan?.key} "Plan custom model prices". When it is a plan the captain approved`,
      );
      expect(brief).toMatch(/Its card, as the captain read it, is saved whole .*\n- .+\.html/);
      expect(brief).toContain('The captain closed it by choosing "Approve and build".');
      expect(brief).toContain(
        `- The captain chose "build" on ${plan?.key}'s card, the task this change is built on, "Plan: type a price for each custom model" (${card.id}), answering:`,
      );
    } finally {
      repo.dispose();
    }
  });

  // Part 3: a finding whose recommended way is the plan as written goes to
  // the builder as a fix; the reviewer records it again at the same head.
  it("sends the builder a fix the reviewer settled after its first record at that head", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs } = setup(builder, {
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId: builderId } = await supervisor.intake.commission({
        title: "Type a price for each custom model",
        intent: intentOf("build it"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(builder, builderId, "Built the price fields.");
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("build it"),
        shape: { review_of: builderId },
      });
      await tick();
      expect(reviewer.promptCalls[0]).not.toContain("is built on");
      const zero = {
        id: "F1",
        severity: "error" as const,
        file: "src/prices.ts",
        line: 12,
        text: "a catalog price of zero counts as free",
        action: "auto-fix" as const,
      };
      const save = {
        id: "F2",
        severity: "warning" as const,
        file: "src/accounts.ts",
        line: 316,
        text: "every Save keeps earlier checks",
        action: "ask-user" as const,
      };
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "Two findings.", {
        code: "findings",
        findings: [zero, save],
        risk: { level: "medium", why: "Save changes." },
      });
      const received = () =>
        [...builder.promptCalls, ...vi.mocked(builder.steer).mock.calls.map(([text]) => text)].join(
          "\n",
        );
      expect(received()).toContain(
        "F1 error src/prices.ts:12 a catalog price of zero counts as free - auto-fix",
      );
      expect(received()).not.toContain("F2 warning");
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "The plan settles F2.", {
        code: "findings",
        findings: [
          zero,
          { ...save, action: "auto-fix" },
          { ...save, id: "F3", line: 40, text: "a renamed model loses its price" },
        ],
        risk: { level: "medium", why: "Save changes." },
      });
      expect(received()).toContain(
        "F2 warning src/accounts.ts:316 every Save keeps earlier checks - auto-fix",
      );
      expect(received()).not.toContain("F3 warning");
    } finally {
      repo.dispose();
    }
  });
});
