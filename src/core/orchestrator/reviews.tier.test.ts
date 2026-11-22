/**
 * The reviewed tier as `Reviews` runs it (delivery rigor phase 2): a
 * plan kept across a raise to Careful, the shown captain choice approving an
 * exact shared effect, a version's gaps on one checklist card, a stale
 * approval, and the assigned proof pair.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The cases drive real git.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptedValidation, VALIDATION_GAPS_FIELD } from "@shared/liveValidation";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it, vi } from "vitest";
import careCarefulGuide from "../../../resources/runbooks/care/careful.json" with { type: "json" };
import {
  bundledRunbooks,
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reportTurn,
  reviewTurn,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { hostEnv } from "../hostEnv";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardChoiceUnavailableError } from "./cardActions";
import type { CrewmateSpec } from "./crewSession";
import { NO_RECORDED_WORDS_LEAD, parseSpawnIntent } from "./intentBrief";
import { POLICY_GUIDANCE_HEADING } from "./noticeWakes";
import { REVIEW_HANDOFF_NEXT } from "./reportWakes";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the reviewed tier (delivery rigor phase 2)", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";

  // INF-994, the captain's direction A: "Keep validation records at every care
  // level"; since INF-1876 what a care asks of them is the care guidance's,
  // served on the raise, never a hold the host reads from the name.
  it("INF-994: a Default-care plan is kept across a raise to Careful, whose notice carries the Careful guidance", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs, inbox } = setup(builder, {
        runbooks: bundledRunbooks(),
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("Make the meter count every press."),
        repoId: view.id,
      });
      await tick();
      const record = () => tasks.get(taskId)!;
      const policies = () => effectiveTaskPolicies(record(), repos.get(view.id));
      expect(policies()?.rigor.value).toBe("standard");
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      vi.mocked(workspace.branchHead).mockResolvedValue(head);
      const receipt = await specs[0]!.onReport!("Planned before editing.", undefined, {
        validation: {
          kind: "plan",
          previousRevision: 0,
          reason: "The press count is what the captain asked for.",
          scenarios: [
            {
              id: "count-press",
              source: "Make the meter count every press.",
              importance: "required",
              action: "Press the meter three times.",
              expected: "It reads three.",
              adverse: "A double press reads two, not one.",
              environment: "The launched app",
              signal: "The meter's label",
              boundary: "The actual app",
            },
          ],
        },
      });
      // The receipt says what was recorded and no longer says who reads it:
      // what a care asks of the record is the care guidance's.
      expect(receipt).toContain("Validation plan recorded at evidence revision 0.");
      expect(receipt).not.toContain("Nothing reads it");
      expect(record().delivery?.liveValidation?.scenarios.map((s) => s.id)).toEqual([
        "count-press",
      ]);
      const before = policies();
      tasks.updateFields(taskId, { policies: { rigor: "reviewed" } }, "captain");
      supervisor.policiesChanged(taskId, { rigor: "reviewed" }, before);
      expect(policies()?.rigor.value).toBe("reviewed");
      expect(record().delivery?.liveValidation?.scenarios.map((s) => s.id)).toEqual([
        "count-press",
      ]);
      expect(acceptedValidation(record().delivery?.liveValidation, head).ready).toBe(false);
      // The notice carries the Careful section the new care selects and the
      // Default one did not; the Default section the crewmate already has is
      // not repeated. The builder's turn is in flight, so the row is handed
      // to it at once and sits in flight awaiting its ack.
      await tick();
      const notice = [...inbox.allFor(taskId), ...inbox.inFlight(taskId)]
        .filter((row) => row.facts?.kind === "task-policies-changed")
        .map(renderWake)
        .at(-1);
      expect(notice).toContain(POLICY_GUIDANCE_HEADING);
      expect(notice).toContain(careCarefulGuide.trim());
      expect(notice).not.toContain("# Default rigor");
    } finally {
      repo.dispose();
    }
  });

  it.each([false, true])(
    "exact shared effect requires a captain click or current project direction (direction: %s)",
    async (direction) => {
      const repo = gitRepo();
      try {
        const builder = fakeCrewmate();
        const reviewer = fakeCrewmate();
        let knowledge: KnowledgeService | undefined;
        const { supervisor, tasks, repos, workspace, specs, db } = setup(builder, {
          crewmates: [reviewer],
          knowledge: (registry) => {
            knowledge = new KnowledgeService({
              projects: { get: (id) => registry.get(id), list: () => registry.list() },
            });
            return knowledge;
          },
        });
        const { repo: view } = await repos.setup({
          kind: "adopt",
          path: repo.dir,
          name: repo.name,
        });
        knowledge?.directions.change({
          op: "add",
          id: "shared-proof",
          scope: view.id,
          text: "Create one disposable staging record to verify the shared service without asking.",
          reason: "Captain's standing consent",
        });
        repos.configure(view.id, { delivery: "direct-pr" });
        const { taskId } = await supervisor.intake.commission({
          title: "Check the shared service",
          intent: intentOf("Demonstrate creating a shared record without affecting real data."),
          repoId: view.id,
          shape: { rigor_ask: "reviewed" },
        });
        await tick();
        const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        vi.mocked(workspace.branchHead).mockResolvedValue(head);
        const report = specs[0]!.onReport!;
        await report("Record the shared-service scenario before changing anything.", undefined, {
          validation: {
            kind: "plan",
            previousRevision: 0,
            reason: "The requested result crosses the shared-service boundary.",
            scenarios: [
              {
                id: "shared-create",
                source: "Demonstrate creating a shared record without affecting real data.",
                importance: "required",
                action: "Create one disposable record.",
                expected: "The record appears once.",
                adverse: "A lost response must not repeat the write.",
                environment: "Disposable staging project",
                signal: "The service confirms the record identity.",
                boundary: "The actual shared service",
              },
            ],
          },
        });
        const request = {
          kind: "effect" as const,
          ...(direction ? { allowance: "d:shared-proof" } : {}),
          id: "create-record",
          head,
          scenario: "shared-create",
          action: "Create one disposable record",
          destination: "The isolated staging project",
          audience: "Project collaborators",
          visibility: "others" as const,
          persistent: true,
          purpose: "Demonstrate the actual shared-service boundary",
          lastingEffects: "One record and an audit entry",
          cleanup: "Delete the disposable record; its audit entry remains",
          access: "Disposable test account",
          preChange: false,
          prerequisitePublication: false,
          forgeWrite: {
            host: "github.com",
            method: "POST" as const,
            path: "/repos/octo/meter/issues/1/comments",
            bodyDigest: createHash("sha256")
              .update('{"body":"Disposable validation record"}')
              .digest("hex"),
          },
        };
        const edit = join(repo.dir, "unreviewed.ts");
        const editedStatus = () => {
          writeFileSync(edit, "export const changed = true;\n");
          return {
            dirty:
              execFileSync("git", ["-C", repo.dir, "status", "--porcelain"], {
                encoding: "utf8",
                env: hostEnv(),
              }).length > 0,
            unlandedCommits: 0,
          };
        };
        vi.mocked(workspace.taskWorkStatus).mockResolvedValueOnce(editedStatus());
        await expect(
          report("This is not an unchanged pre-change reproduction.", undefined, {
            validation: { kind: "request", request: { ...request, preChange: true } },
          }),
        ).rejects.toThrow("Commit the current work");
        expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions).toHaveLength(0);
        rmSync(edit);
        // INF-203 F2: the first assignment precedes this effect request.
        await reportTurn(
          builder,
          taskId,
          "The scenario is ready for review before the effect is requested.",
        );
        const { taskId: reviewId } = await supervisor.intake.commission({
          title: "Review",
          intent: intentOf("Inspect the shared-write scenario."),
          shape: { review_of: taskId },
        });
        await tick();
        expect(tasks.get(reviewId)?.delivery?.validationAssignment?.effects).toEqual([]);
        await reviewTurn(
          { tasks, specs },
          reviewer,
          1,
          reviewId,
          "The effect has not been requested.",
          {
            code: "blocked",
            coverage: "missing",
            coverageReason: "The effect has not been requested.",
            verdict: "inconclusive",
            reason: "The effect has not been requested.",
            risk: { level: "medium", why: "a shared write is proposed." },
          },
        );
        await supervisor.steer.steerCrewmate(taskId, "Record the exact effect request.");
        await tick();
        await report(
          "The proposed write needs code review and the captain's approval.",
          undefined,
          {
            validation: { kind: "request", request },
          },
        );
        const offer = () =>
          specs[0]!.onCard!({
            id: "shared-validation",
            title: "Approve one shared test record?",
            body: "<p>The test creates one disposable record visible to collaborators.</p><p>The audit remains after cleanup, so this action needs your approval.</p>",
            validationDecision: { request: request.id, action: "approve" },
            actions: [
              { id: "approve", label: "Approve this record", default: true },
              { id: "hold", label: "Keep it held" },
            ],
          });
        await expect(offer()).rejects.toThrow("reviewer must clear");
        await reportTurn(
          builder,
          taskId,
          "The code is ready for review before requesting the shared write.",
        );
        await supervisor.steer.steerCrewmate(
          reviewId,
          "Re-review the newly requested effect at the same version and evidence revision.",
        );
        await tick();
        expect(tasks.get(reviewId)?.delivery?.validationAssignment).toMatchObject({
          head,
          revision: 0,
          effects: [request.id],
        });
        await specs[1]!.onReport!(
          "verdict: blocked\nCode is clear; the required action awaits the captain and live proof.\nrisk: medium",
          undefined,
          {
            validation: {
              kind: "review",
              head,
              revision: 0,
              code: "clear",
              coverage: "complete",
              coverageReason: "The shared effect and lost-response case cover the request.",
              effects: [request.id],
              omitted: [],
              verdict: "inconclusive",
              reason: "Code clearance is not approval or live proof.",
            },
          },
        );
        await reportTurn(
          reviewer,
          reviewId,
          "verdict: blocked\nCode clearance only; required proof awaits approval.\nrisk: medium",
        );
        await supervisor.steer.steerCrewmate(
          taskId,
          "Ask the captain about this exact cleared effect.",
        );
        await tick();
        if (direction) {
          await expect(offer()).rejects.toThrow("without a card");
        } else {
          const cardId = String(await offer());
          await reportTurn(
            builder,
            taskId,
            "The scoped validation question waits for the captain.",
          );
          expect(() => supervisor.cardActions.act(cardId, "approve", "frame")).toThrow();
          expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe(
            "requested",
          );
          supervisor.cardActions.act(cardId, "approve");
          expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe(
            "approved",
          );
        }
        const beforeStart = direction ? "requested" : "approved";
        for (const changed of [
          { host: "other.example" },
          { method: "DELETE" as const },
          { path: "/repos/octo/other/issues/1/comments" },
          {
            bodyDigest: createHash("sha256").update('{"body":"Different contents"}').digest("hex"),
          },
        ]) {
          await expect(
            supervisor.reportIntake.consumeValidationEffect(taskId, request.id, {
              ...request.forgeWrite,
              ...changed,
            }),
          ).rejects.toThrow(/exact write/);
          expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe(
            beforeStart,
          );
        }
        vi.mocked(workspace.taskWorkStatus).mockResolvedValueOnce(editedStatus());
        await expect(
          supervisor.reportIntake.consumeValidationEffect(taskId, request.id, request.forgeWrite),
        ).rejects.toThrow("Commit the current work");
        expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe(
          beforeStart,
        );
        rmSync(edit);
        vi.mocked(workspace.branchHead).mockResolvedValue("b".repeat(40));
        await expect(
          supervisor.reportIntake.consumeValidationEffect(taskId, request.id, request.forgeWrite),
        ).rejects.toThrow("current version");
        vi.mocked(workspace.branchHead).mockResolvedValue(head);
        await supervisor.reportIntake.consumeValidationEffect(
          taskId,
          request.id,
          request.forgeWrite,
        );
        await expect(
          supervisor.reportIntake.consumeValidationEffect(taskId, request.id, request.forgeWrite),
        ).rejects.toThrow("once");
        const restored = new TaskService({ db });
        if (direction) {
          expect(restored.get(taskId)?.delivery?.liveValidation?.permissions[0]?.yes).toBe(
            "d:shared-proof",
          );
          expect(
            restored.get(taskId)?.delivery?.liveValidation?.permissions[0]?.decision,
          ).toBeUndefined();
        }
        expect(restored.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe(
          "unknown",
        );
        // The reviewer's typed code judgment is the verdict as typed (INF-1876):
        // its inconclusive live-proof judgment stands beside it in the record.
        expect(restored.get(taskId)?.delivery?.reviewVerdict).toBe("pass");
        expect(restored.get(taskId)?.delivery?.liveValidation?.reviews.at(-1)?.verdict).toBe(
          "inconclusive",
        );
        console.log(
          "INF-125 shared-effect boundary",
          JSON.stringify({
            head,
            permission: restored.get(taskId)?.delivery?.liveValidation?.permissions[0],
            review: restored.get(taskId)?.delivery?.reviewVerdict,
          }),
        );
      } finally {
        repo.dispose();
      }
    },
  );

  it("INF-125: asks about the current required gap before accepting any exception, without treating the answer as proof", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs, ops, events, cards } = setup(builder, {
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Verify target-device input",
        intent: intentOf("Verify the keyboard action on the target device."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      vi.mocked(workspace.branchHead).mockResolvedValue(head);
      const report = specs[0]!.onReport!;
      await report("The required scenario reaches the actual target device.", undefined, {
        validation: {
          kind: "plan",
          previousRevision: 0,
          reason: "The requested result includes the actual device input.",
          scenarios: [
            {
              id: "device-input",
              source: "Verify the keyboard action on the target device.",
              importance: "required",
              action: "Press the keyboard control on the target device",
              expected: "The control responds once.",
              adverse: "Unavailable input is not a pass.",
              environment: "Disposable device",
              signal: "The actual device shows the action.",
              boundary: "Actual device input",
            },
          ],
        },
      });
      await report("The isolated simulator cannot prove the actual device input.", undefined, {
        validation: {
          kind: "run",
          id: "device-missing",
          head,
          scenarioRevision: 1,
          completion: "complete",
          verdict: "inconclusive",
          reason: "A required device is not connected.",
          observations: [
            {
              scenario: "device-input",
              result: "untested",
              live: false,
              actual: "No target device is connected.",
              evidence: [],
              standIns: ["Isolated simulator"],
              unproven: ["Actual device input"],
              attempted: ["The isolated simulator cannot exercise the device input."],
              missingCapability: "Target device",
              reason: "No target device is connected.",
            },
          ],
          evidence: [],
        },
      });
      await report("The specific required gap needs the captain's decision.", undefined, {
        validation: {
          kind: "request",
          request: {
            kind: "gap",
            id: "missing-device",
            head,
            scenario: "device-input",
            missingCapability: "Target device",
            reason: "No target device is connected.",
            alternatives: [
              {
                attempted: "Isolated simulator",
                result: "It cannot demonstrate the actual device input.",
              },
              {
                attempted: "Local keyboard check",
                result: "It cannot reach the target device.",
              },
            ],
            remedies: [
              "Connect a disposable target device and run the check.",
              "Keep the task held until a target device is available.",
            ],
          },
        },
      });
      const cardId = String(
        await specs[0]!.onCard!({
          title: "The device check needs your decision",
          body: "<p>The isolated simulator cannot demonstrate input on the actual device.</p><p>Connect a disposable target device, or accept this specific gap without claiming a live pass.</p>",
          validationDecision: { request: "missing-device", action: "accept" },
          actions: [
            { id: "accept", label: "Accept this gap", default: true },
            { id: "hold", label: "Keep it held" },
          ],
        }),
      );
      await reportTurn(builder, taskId, "The device check stays held until the captain answers.");
      // INF-878, approved B: consent stays open; the record starts closed with separate items.
      const gapBody = parseDocument(cards().find((card) => card.id === cardId)!.body);
      const panel = DomUtils.findOne(
        (node) => node.attribs["data-inf-call"] === "gap",
        gapBody.children,
      )!;
      const details = DomUtils.getElementsByTagName("details", panel)[0]!;
      expect(details.attribs.open).toBeUndefined();
      expect(DomUtils.textContent(DomUtils.getElementsByTagName("summary", details)[0]!)).toBe(
        "The recorded gap",
      );
      expect(DomUtils.getElementsByTagName("li", details).map(DomUtils.textContent)).toEqual([
        "Isolated simulator: It cannot demonstrate the actual device input.",
        "Local keyboard check: It cannot reach the target device.",
        "Connect a disposable target device and run the check.",
        "Keep the task held until a target device is available.",
      ]);
      expect(DomUtils.textContent(details)).toContain(head.slice(0, 7));
      expect(DomUtils.textContent(details)).toContain("No target device is connected.");
      expect(DomUtils.textContent(details)).toContain("Target device");
      const openText = panel.children
        .filter((node) => node !== details)
        .map(DomUtils.textContent)
        .join("");
      expect(openText).toContain("Accept this gap lets this go ahead without live proof of");
      expect(openText).toContain("Press the keyboard control on the target device");
      expect(openText).toContain("It records no live pass and merges nothing.");
      expect(DomUtils.textContent(details)).not.toContain(
        "Press the keyboard control on the target device",
      );
      expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe("requested");
      expect(() => supervisor.cardActions.act(cardId, "accept", "frame")).toThrow(
        CardChoiceUnavailableError,
      );
      expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe("requested");
      // The gap waits for the captain's answer; the review beside it records
      // the typed code judgment as the verdict (INF-1876): clear is a pass,
      // and the inconclusive live proof is a fact the record keeps and the
      // reviewer reads, never a hold the host turns the pass into.
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("Review device proof."),
        shape: { review_of: taskId },
      });
      await tick();
      const judgment = {
        kind: "review" as const,
        head,
        revision: 1,
        code: "clear" as const,
        coverage: "complete" as const,
        coverageReason: "The actual device boundary is covered by the scenario.",
        effects: [],
        omitted: [],
        verdict: "inconclusive" as const,
        reason: "The device remains unavailable; the captain decides the specific exception.",
      };
      await specs[1]!.onReport!("verdict: pass\nrisk: low", undefined, { validation: judgment });
      await reportTurn(reviewer, reviewId, "verdict: pass\nrisk: low");
      expect(tasks.get(taskId)?.delivery?.reviewVerdict).toBe("pass");
      // Session audit finding E keeps this independent reader for the
      // captain's gap answer and proof read, rather than commissioning a relay.
      expect(tasks.get(reviewId)?.status).toBe("active");
      const passed = tasks.timeline(taskId).findLast((event) => event.kind === "review");
      expect(passed?.text).toContain("review passed at");
      expect(passed?.data).not.toHaveProperty("validationReason");
      expect(ops.some((text) => text.includes("with verdict blocked"))).toBe(false);
      const priorState = tasks.get(reviewId)?.delivery?.validationAssignment?.stateRevision;
      supervisor.cardActions.act(cardId, "accept", "chrome");
      const validation = tasks.get(taskId)?.delivery?.liveValidation;
      expect(validation?.permissions[0]?.state).toBe("approved");
      expect(validation?.runs[0]?.observations[0]?.result).toBe("untested");
      expect(validation?.reviews).toHaveLength(1);
      await tick();
      await reportTurn(
        builder,
        taskId,
        "The captain granted the recorded exception; re-review this validation state.",
      );
      // The host returns the granted exception to the same reader at the
      // same head and proof revision, but the new validation state.
      const reReviewId = reviewId;
      await tick();
      expect(tasks.get(reReviewId)?.delivery?.validationAssignment).toMatchObject({
        head,
        revision: 1,
      });
      expect(tasks.get(reReviewId)?.delivery?.validationAssignment?.stateRevision).not.toBe(
        priorState,
      );
      await specs[1]!.onReport!("verdict: pass\nrisk: low", undefined, { validation: judgment });
      await reportTurn(reviewer, reReviewId, "verdict: pass\nrisk: low");
      expect(tasks.get(reReviewId)?.status).toBe("done");
      expect(tasks.get(taskId)?.delivery?.reviewVerdict).toBe("pass");
      expect(tasks.get(taskId)?.delivery?.liveValidation?.runs).toHaveLength(1);
      seedDelivery(tasks, taskId, {
        ci: "green",
        headSha: head,
        prNumber: 21,
        prUrl: "https://github.com/fleet/meter/pull/21",
      });
      await expect(
        specs[0]!.onCard!({
          title: "The device change has your reviewed exception",
          body: completionBody("<p>Your device exception remains explicit.</p>"),
          requiredActions: [],
          actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }],
        }),
      ).resolves.toBeTruthy();
      expect(
        events.some((event) => event.type === "open_card_shown" && event.cardId === cardId),
      ).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it("INF-1824: a version's gaps share one checklist card and the click accepts exactly the ticked rows", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs, cards } = setup(builder);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Prove the workflow triggers",
        intent: intentOf("Prove which workflows each pull request starts."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      vi.mocked(workspace.branchHead).mockResolvedValue(head);
      const report = specs[0]!.onReport!;
      // FIRS-3's four gaps at one version, from its record.
      const checks = [
        ["outside-prs", "Outside pull requests run quick checks"],
        ["full-ci-label", "The full-ci label starts the full suite"],
        ["other-labels", "Other labels start and cancel nothing"],
        ["main-newest", "Main runs only the newest merge"],
      ] as const;
      await report("The checks need the real repository's workflows.", undefined, {
        validation: {
          kind: "plan",
          previousRevision: 0,
          reason: "The captain asked which workflows each pull request starts.",
          scenarios: checks.map(([id, action]) => ({
            id,
            source: "Prove which workflows each pull request starts.",
            importance: "required",
            action,
            expected: "Only the named workflows start.",
            adverse: "A workflow that starts unasked is a failure.",
            environment: "The project's repository on GitHub",
            signal: "The workflow runs listed for the pull request.",
            boundary: "GitHub Actions on the real repository",
          })),
        },
      });
      await report("None of the checks can run without opening test pull requests.", undefined, {
        validation: {
          kind: "run",
          id: "r1",
          head,
          scenarioRevision: 1,
          completion: "complete",
          verdict: "inconclusive",
          reason: "Proving them needs pull requests others can see.",
          observations: checks.map(([id]) => ({
            scenario: id,
            result: "untested",
            live: false,
            actual: "Not run.",
            evidence: [],
            standIns: ["The workflow files read by hand"],
            unproven: ["The real trigger"],
            attempted: ["Reading the workflow files cannot prove what GitHub starts."],
            missingCapability: "Test pull requests on the real repository",
            reason: "Opening them would be visible to collaborators.",
          })),
          evidence: [],
        },
      });
      for (const [id] of checks)
        await report(`The ${id} gap needs your answer.`, undefined, {
          validation: {
            kind: "request",
            request: {
              kind: "gap",
              id: `gap-${id}`,
              head,
              scenario: id,
              missingCapability: "Test pull requests on the real repository",
              reason: "Opening them would be visible to collaborators.",
              alternatives: [
                { attempted: "Reading the workflow files", result: "It cannot prove the trigger." },
              ],
              remedies: ["Allow one test pull request."],
            },
          },
        });
      const ids = checks.map(([id]) => `gap-${id}`);
      const binding = { request: ids[0]!, action: "accept", gaps: ids.slice(1) };
      const actions = [
        { id: "accept", label: "Accept the checked gaps", default: true },
        { id: "hold", label: "Keep all held" },
      ];
      await expect(
        specs[0]!.onCard!({
          title: "Four checks cannot run without test pull requests",
          body: "<p>Tick the checks that may go ahead without live proof.</p><script>document.querySelectorAll('input').forEach(function(i){i.checked=true;})</script>",
          validationDecision: binding,
          actions,
        }),
      ).rejects.toThrow("no script");
      const cardId = String(
        await specs[0]!.onCard!({
          title: "Four checks cannot run without test pull requests",
          body: "<p>Tick the checks that may go ahead without live proof.</p>",
          validationDecision: binding,
          actions,
        }),
      );
      await reportTurn(builder, taskId, "The four gaps wait on your answer.");
      const body = parseDocument(cards().find((card) => card.id === cardId)!.body);
      const rows = DomUtils.findAll(
        (node) => node.name === "input" && node.attribs.name === VALIDATION_GAPS_FIELD,
        body.children,
      );
      expect(rows.map((row) => row.attribs.value)).toEqual(ids);
      expect(
        rows.every((row) => row.attribs.type === "checkbox" && !("checked" in row.attribs)),
      ).toBe(true);
      // INF-4497 finding 3: the rows are one required question, so the card
      // holds its main button until one is ticked.
      expect(rows.every((row) => "required" in row.attribs)).toBe(true);
      expect(
        DomUtils.findOne((node) => "data-inf-check-all" in node.attribs, body.children),
      ).toBeTruthy();
      expect(DomUtils.textContent(body)).toContain("Main runs only the newest merge");
      // INF-4497 finding 3: accepting with nothing ticked is refused and
      // records no decision; every gap still waits on the same card.
      expect(() =>
        supervisor.cardActions.act(cardId, "accept", "chrome", {
          answers: [{ name: VALIDATION_GAPS_FIELD, values: [], changed: false }],
        }),
      ).toThrow("Tick at least one check");
      expect(
        tasks.get(taskId)?.delivery?.liveValidation?.permissions.map((item) => item.state),
      ).toEqual(["requested", "requested", "requested", "requested"]);
      expect(tasks.timeline(taskId).some((event) => event.kind === "card_resolved")).toBe(false);
      supervisor.cardActions.act(cardId, "accept", "chrome", {
        answers: [{ name: VALIDATION_GAPS_FIELD, values: [ids[0]!, ids[2]!], changed: true }],
      });
      expect(
        tasks.get(taskId)?.delivery?.liveValidation?.permissions.map((item) => item.state),
      ).toEqual(["approved", "declined", "approved", "declined"]);
      expect(tasks.timeline(taskId).some((event) => event.kind === "card_resolved")).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it("INF-203 F6: a stale approval shows its card, expires its button and tells the builder to ask again", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs, events } = setup(builder);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Reproduce the shared fixture",
        intent: intentOf("Reproduce the shared fixture before editing."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      vi.mocked(workspace.branchHead).mockResolvedValue(head);
      vi.mocked(workspace.reviewChangedFiles).mockResolvedValue([]);
      await specs[0]!.onReport!("Recorded the reproduction scenario.", undefined, {
        validation: {
          kind: "plan",
          previousRevision: 0,
          reason: "Reproduction precedes the edit.",
          scenarios: [
            {
              id: "reproduce",
              source: "Reproduce the shared fixture.",
              importance: "required",
              action: "Write one shared fixture record.",
              expected: "One visible record.",
              adverse: "An unknown outcome is never repeated.",
              environment: "Disposable fixture",
              signal: "The service records one write.",
              boundary: "Shared fixture",
            },
          ],
        },
      });
      await specs[0]!.onReport!("The reproduction needs a decision.", undefined, {
        validation: {
          kind: "request",
          request: {
            kind: "effect",
            id: "reproduction",
            head,
            scenario: "reproduce",
            action: "Write one shared fixture record.",
            destination: "Disposable service",
            audience: "Collaborators",
            visibility: "others",
            persistent: true,
            purpose: "Reproduction before editing",
            lastingEffects: "Service history",
            cleanup: "Delete the disposable record",
            access: "Disposable account",
            preChange: true,
            prerequisitePublication: false,
          },
        },
      });
      const cardId = String(
        await specs[0]!.onCard!({
          title: "Approve the reproduction",
          body: "<p>One disposable record will be visible to collaborators.</p><p>Its service history remains after cleanup.</p>",
          validationDecision: { request: "reproduction", action: "approve" },
          actions: [
            { id: "approve", label: "Approve", default: true },
            { id: "hold", label: "Keep it held" },
          ],
        }),
      );
      await specs[0]!.onReport!("The reproduction waits for an answer.", undefined, {
        wait: { reason: "Read the validation question", cardId },
      });
      await reportTurn(builder, taskId, "The reproduction waits for an answer.");
      // INF-765: the builder is at a review cap only the first mate's steer reopens.
      const capAt = Date.now();
      seedDelivery(tasks, taskId, {
        reviewRounds: 3,
        reviewCapAt: capAt,
        reviewCapOwner: "firstmate",
      });
      seedDelivery(tasks, taskId, { validationHead: "b".repeat(40) });
      const before = supervisor.cards.snapshot().find((card) => card.id === cardId);
      expect(() => supervisor.cardActions.act(cardId, "approve", "chrome")).toThrow(
        CardChoiceUnavailableError,
      );
      expect(tasks.get(taskId)?.delivery?.liveValidation?.permissions[0]?.state).toBe("expired");
      expect(supervisor.cards.snapshot().find((card) => card.id === cardId)?.actions).toEqual([]);
      expect(
        events.some((event) => event.type === "open_card_shown" && event.cardId === cardId),
      ).toBe(true);
      await tick();
      expect(builder.promptCalls.at(-1)).toContain("fresh request with a new identity");
      // INF-765: the app sent that notice, not the first mate, so it reopens no rounds.
      const notice = tasks
        .timeline(taskId)
        .findLast((event) => event.kind === "steered" && event.text.includes("new identity"));
      expect(notice).toMatchObject({ actor: "supervisor", data: { cardId } });
      expect(tasks.get(taskId)?.delivery).toMatchObject({
        reviewRounds: 3,
        reviewCapAt: capAt,
        reviewCapOwner: "firstmate",
      });
      expect(tasks.timeline(taskId).some((event) => event.kind === "cap_reset")).toBe(false);
      console.log(
        "INF-203 stale question",
        JSON.stringify({
          before,
          after: supervisor.cards.snapshot().find((card) => card.id === cardId),
        }),
      );
    } finally {
      repo.dispose();
    }
  });

  // INF-1876: the host holds no merge on live validation; what Careful asks
  // of an older builder reaches it through the care guidance, not a hold.
  it("INF-203 F3: an older Careful builder with a passed review and green checks merges; no host hold asks it for live validation", async () => {
    const repo = gitRepo();
    try {
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace } = setup(reviewer, {
        mergePullRequest: async (_task, _guard, boundary) => {
          const reason = boundary?.beforeDispatch(HEAD);
          return { ok: !reason, text: reason ?? "Merged" };
        },
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      seedTask(tasks, {
        id: "legacy-careful",
        title: "Older Careful work",
        repoId: view.id,
        repoDir: repo.dir,
        worktreeDir: repo.dir,
        branch: "fm/task-legacy-careful",
        status: "idle",
        prompt: "Review before the pull request.",
        shape: { kind: "fix", rigor: "reviewed", rigor_ask: "reviewed" },
        intent: intentOf("Fix the meter carefully."),
      });
      tasks.recordBrief("legacy-careful", ["Review before the pull request."]);
      tasks.turns.recordReport("legacy-careful", {
        text: "The change is complete and its earlier review passed.",
        summary: "The change is complete.",
      });
      seedDelivery(tasks, "legacy-careful", {
        reviewVerdict: "pass",
        reviewSha: HEAD,
        headSha: HEAD,
        ci: "green",
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const held = await supervisor.settling.settle.settleTaskDetailed(
        "legacy-careful",
        "merge-pr",
        undefined,
        false,
        "captain",
      );
      expect(held.text).not.toContain("live validation");
      expect(held.text).toContain("Merged");
      expect(tasks.get("legacy-careful")).toMatchObject({ status: "done", closedReason: "merged" });
    } finally {
      repo.dispose();
    }
  });

  it("INF-125: accepts only the assigned proof pair and rejects evidence-only reuse of a review", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, specs } = setup(builder, {
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Explain the empty fixture",
        intent: intentOf("Explain this fixture; it has no running surface."),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      const head = execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      vi.mocked(workspace.branchHead).mockResolvedValue(head);
      const report = specs[0]!.onReport!;
      await report(
        "The scenario set is empty because this fixture has no product.",
        "Recorded the empty fixture",
        {
          validation: {
            kind: "plan",
            previousRevision: 0,
            reason: "An empty lifecycle fixture has no running surface.",
            scenarios: [],
          },
        },
      );
      expect(tasks.get(taskId)?.outcome).toBeNull();
      const proof = noSurfaceProof(head);
      const { revision: _revision, deviceId: _deviceId, at: _at, ...run } = proof.runs[0]!;
      await report("The empty fixture has no running surface to exercise.", "No running surface", {
        validation: run,
      });
      await reportTurn(builder, taskId, "The empty fixture has no running surface to exercise.");
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("Review the empty fixture and its proof."),
        shape: { review_of: taskId },
      });
      await tick();
      await expect(
        specs[1]!.onReport!("verdict: pass", "Read the proof", {
          validation: { ...proof.reviews[0]!, revision: 2 },
        }),
      ).rejects.toThrow("assigned");
      await specs[1]!.onReport!(
        "verdict: pass\nNo running surface exists.\nrisk: low",
        "Accepted the no-surface reason",
        { validation: proof.reviews[0]! },
      );
      await reportTurn(reviewer, reviewId, "verdict: pass\nNo running surface exists.\nrisk: low");
      expect(tasks.get(reviewId)?.status).toBe("done");
      expect(tasks.get(taskId)?.delivery?.reviewVerdict).toBe("pass");
      await report(
        "The evidence reason was corrected without a code change.",
        "Revised the proof",
        {
          validation: {
            ...run,
            id: "revised-reason",
            reason: "This fixture contains no application behavior.",
          },
        },
      );
      expect(tasks.get(taskId)?.delivery?.liveValidation?.runs.at(-1)?.revision).toBe(2);
      // The revised proof is a recorded fact the reviewer reads, never a hold
      // the host puts on the card (INF-1876): the review accepted revision 1,
      // the record says so, and the card goes up.
      const cardId = await specs[0]!.onCard!({
        title: "The fixture is explained",
        body: completionBody("<p>The empty fixture has no product.</p>"),
        requiredActions: [],
        actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }],
      });
      expect(cardId).toBeTruthy();
      expect(acceptedValidation(tasks.get(taskId)?.delivery?.liveValidation, head).ready).toBe(
        false,
      );
      expect(tasks.get(taskId)?.delivery?.reviewSha).toBe(head);
      expect(tasks.get(taskId)?.delivery?.reviewRounds).toBeUndefined();
    } finally {
      repo.dispose();
    }
  });

  const receivedBy = (crew: ReturnType<typeof fakeCrewmate>) =>
    [...crew.promptCalls, ...vi.mocked(crew.steer).mock.calls.map(([text]) => text)].join("\n");

  // INF-4338's review: while a reviewer's own card is up, its report with no
  // review record is silent only when it declares nothing and its assignment
  // is the version its verdict read; and a fix the builder committed while a
  // card or reply turn took that newer version as its assignment still goes
  // back to the reviewer.
  it("routes a reviewer's reports under its own card and returns a fix committed during a card turn", async () => {
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
      await reportTurn(builder, builderId, "The meter copy is committed.");
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "One finding for the captain.", {
        code: "findings",
        findings: [
          {
            id: "F1",
            severity: "warning",
            file: "src/meter.ts",
            line: 40,
            text: "the copy says Later",
            action: "ask-user",
          },
        ],
        risk: { level: "low", why: "one line." },
      });
      (specs[1] as CrewmateSpec).onCard?.({
        id: "review-meter",
        title: "Keep the Later copy?",
        body: "<p>Keep the Later copy?</p>",
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      });
      const cardId =
        supervisor.cards.snapshot().find((card) => card.title === "Keep the Later copy?")?.id ?? "";
      const beforeCard = ops.length;
      await reportTurn(reviewer, reviewId, "The card is up.");
      expect(ops.slice(beforeCard)).toEqual([]);

      supervisor.cardActions.replyToCard(cardId, "Is this the meter's copy?");
      await tick();
      const ask = "Choose whether the copy question belongs to another task.";
      await (specs[1] as CrewmateSpec).onReport?.(ask, undefined, { needsFirstmate: ask });
      await reportTurn(reviewer, reviewId, ask);
      expect(ops.slice(beforeCard)).toEqual([expect.stringContaining(ask)]);

      // The builder records a proof run; a reply turn under the card then takes
      // that evidence revision as its assignment without reading it.
      const kept = tasks.get(builderId)?.delivery?.liveValidation;
      const run = noSurfaceProof(HEAD, reviewId).runs[0];
      if (!kept || !run)
        throw new Error("The review's verdict is kept, and the fixture has its run.");
      seedDelivery(tasks, builderId, {
        liveValidation: {
          ...kept,
          runs: [...kept.runs, { ...run, revision: kept.runs.length + 1 }],
        },
      });
      supervisor.cardActions.replyToCard(cardId, "Does the empty meter show it?");
      await tick();
      const beforeRun = ops.length;
      await reportTurn(reviewer, reviewId, "Answered under the card.");
      expect(ops.slice(beforeRun)).toEqual([
        expect.stringContaining("with no typed review record"),
      ]);
      await supervisor.steer.steerCrewmate(builderId, "Report the proof you recorded.");
      await tick();
      const beforeReturn = reviewer.promptCalls.length;
      await reportTurn(builder, builderId, "Recorded the proof run.");
      expect(reviewer.promptCalls).toHaveLength(beforeReturn + 1);
      expect(reviewer.promptCalls.at(-1)).toContain(REVIEW_HANDOFF_NEXT.reread);
      await reportTurn(reviewer, reviewId, "Read the run; no verdict yet.");

      // The builder commits a fix; a reply turn under the card then takes that
      // version as its assignment without reviewing it.
      const fixed = "fedcba9876543210fedcba9876543210fedcba98";
      vi.mocked(workspace.branchHead).mockResolvedValue(fixed);
      supervisor.cardActions.replyToCard(cardId, "Where does Later show?");
      await tick();
      expect(tasks.get(reviewId)?.delivery?.headSha).toBe(fixed);
      // That turn ends with no verdict at a version its verdict never read: unstated.
      const beforeReply = ops.length;
      await reportTurn(reviewer, reviewId, "Answered under the card.");
      expect(ops.slice(beforeReply)).toEqual([
        expect.stringContaining("with no typed review record"),
      ]);
      await supervisor.steer.steerCrewmate(builderId, "Report the copy fix you committed.");
      await tick();
      const prompts = reviewer.promptCalls.length;
      await reportTurn(builder, builderId, "Committed the copy fix.");
      expect(reviewer.promptCalls).toHaveLength(prompts + 1);
      expect(reviewer.promptCalls.at(-1)).toContain(REVIEW_HANDOFF_NEXT.reread);
      expect(reviewer.promptCalls.at(-1)).toContain(fixed);

      // The review passes with the card still up; the captain's choice after
      // that tells the builder to deliver a chosen change as a new version.
      seedDelivery(tasks, builderId, { liveValidation: noSurfaceProof(fixed, reviewId) });
      seedDelivery(tasks, reviewId, {
        validationAssignment: { head: fixed, revision: 1, scenarioRevision: 1, effects: [] },
      });
      await reviewTurn({ tasks, specs }, reviewer, 1, reviewId, "No findings.", {
        code: "clear",
        risk: { level: "low", why: "one line." },
      });
      expect(tasks.get(reviewId)).toMatchObject({ status: "done", closedReason: "finished" });
      const beforeChoice = ops.length;
      supervisor.cardActions.act(cardId, "change");
      await tick();
      expect(ops.slice(beforeChoice)).toEqual([]);
      // The builder is in its delivery turn, so the choice is steered into it.
      const decided = receivedBy(builder).split("Host handoff from").at(-1) ?? "";
      expect(decided).toContain('The captain chose "Change it" on "Keep the Later copy?".');
      expect(decided).toContain(REVIEW_HANDOFF_NEXT.decided);
      expect(receivedBy(builder)).not.toContain(REVIEW_HANDOFF_NEXT.decision);
    } finally {
      repo.dispose();
    }
  });

  // INF-4338's review (F11): a fresh review's first read is compared with its
  // own assignment, never the version an earlier review's verdict read.
  it("hands a fresh review no second read of the version it is already reading", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, tasks, repos, workspace, inbox } = setup(builder, {
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
      await reportTurn(builder, builderId, "The meter copy is committed.");
      seedDelivery(tasks, builderId, {
        reviewVerdict: "pass",
        reviewSha: "fedcba9876543210fedcba9876543210fedcba98",
        reviewedAt: Date.now() - 60_000,
      });
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);
      const { taskId: reviewId } = await supervisor.intake.commission({
        title: "Review",
        intent: intentOf("fix it"),
        shape: { review_of: builderId },
      });
      await tick();
      const prompts = reviewer.promptCalls.length;
      await supervisor.steer.steerCrewmate(builderId, "Report the checks on the pushed version.");
      await tick();
      await reportTurn(builder, builderId, "The checks passed on the pushed version.");
      expect(reviewer.promptCalls).toHaveLength(prompts);
      // A handoff to a reviewer still in its turn waits in its inbox.
      expect(JSON.stringify(inbox.allFor(reviewId))).not.toContain('"stage":"reread"');
      expect(receivedBy(reviewer)).not.toContain(REVIEW_HANDOFF_NEXT.reread);
    } finally {
      repo.dispose();
    }
  });

  it("reads the review against the builder's words when the review spawn carries none (INF-1939)", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const reviewer = fakeCrewmate();
      const { supervisor, repos, workspace } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [reviewer],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("make the meter test stop flaking"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      await reportTurn(
        builder,
        taskId,
        "Intent: the meter test passes. What changed: the test awaits the flush. Verified: ran it. Risk: low. Not done: nothing.",
      );
      vi.mocked(workspace.branchHead).mockResolvedValue(HEAD);

      await supervisor.intake.commission({
        title: "Review",
        intent: parseSpawnIntent({ goal: "Review the meter fix" }),
        shape: { review_of: taskId },
      });
      await vi.waitFor(() => expect(reviewer.promptCalls.length).toBeGreaterThan(0));
      const brief = reviewer.promptCalls[0] ?? "";
      expect(brief).toMatch(/The user's words, verbatim[^\n]*\nmake the meter test stop flaking\n/);
      expect(brief).not.toContain(NO_RECORDED_WORDS_LEAD);
    } finally {
      repo.dispose();
    }
  });
});
