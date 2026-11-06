import { createHash } from "node:crypto";
import {
  acceptedValidation,
  type KeptValidationInput,
  type LiveValidation,
  type ValidationScenario,
} from "@shared/liveValidation";
import { liveValidationSummary } from "@shared/liveValidationSummary";
import { describe, expect, it } from "vitest";
import { decideValidation, recordValidation, validationCodeClearance } from "./liveValidation";

// INF-125's accepted plan: proof is exact-version, while a captain's exception covers the unchanged gap.
const head = "a".repeat(40);
const later = "b".repeat(40);
const scenario: ValidationScenario = {
  id: "keyboard-close",
  source: "Keep card controls reachable from the keyboard.",
  importance: "required",
  action: "Press the focused Close button with Enter.",
  expected: "The card closes and focus returns to the message box.",
  adverse: "A frame must not activate the merge control.",
  environment: "Hermetic Electron app with a throwaway HOME.",
  signal: "The card is absent and the message box owns focus.",
  boundary: "Electron window and sandboxed card frame",
};
const ctx = { head, deviceId: null, at: 1 };
const plan = () =>
  recordValidation(
    undefined,
    {
      kind: "plan",
      previousRevision: 0,
      reason: "The captain asked for keyboard access.",
      scenarios: [scenario],
    },
    ctx,
  );
const run = (state: LiveValidation, version = head, gap = false, id = "run-1") =>
  recordValidation(
    state,
    {
      kind: "run",
      id,
      head: version,
      scenarioRevision: state.scenarioRevision,
      completion: "complete",
      verdict: gap ? "inconclusive" : "go",
      reason: gap
        ? "The actual target cannot be reached."
        : "The actual app completed the keyboard action.",
      observations: [
        {
          scenario: scenario.id,
          result: gap ? "untested" : "pass",
          live: !gap,
          actual: gap
            ? "The device was unavailable."
            : "The card disappeared and the message box took focus.",
          evidence: gap ? [] : ["recording"],
          standIns: [],
          unproven: gap ? ["Device keyboard input"] : [],
          attempted: gap ? ["The isolated simulator cannot exercise the device input."] : [],
          ...(gap
            ? { missingCapability: "Actual target device", reason: "No device is connected." }
            : {}),
        },
      ],
      evidence: gap
        ? []
        : [
            {
              id: "recording",
              description: "The keyboard action and focus recovery",
              file: "builder-proof.mp4",
              digest: "c".repeat(64),
              bytes: 1024,
            },
          ],
    },
    { ...ctx, head: version },
  );
const review = (
  state: LiveValidation,
  version = head,
  overrides: Partial<Extract<KeptValidationInput, { kind: "review" }>> = {},
) =>
  recordValidation(
    state,
    {
      kind: "review",
      head: version,
      revision: state.runs.at(-1)?.revision ?? 0,
      code: "clear",
      coverage: "complete",
      coverageReason: "The scenarios cover the captain's requested result.",
      effects: state.permissions
        .filter((p) => p.request.kind === "effect")
        .map((p) => p.request.id),
      omitted: [],
      verdict: state.runs.at(-1)?.verdict ?? "inconclusive",
      reason: "Read the complete change and the kept proof.",
      ...overrides,
    },
    {
      ...ctx,
      head: version,
      reviewer: "reviewer",
      assignment: {
        head: version,
        revision: state.runs.at(-1)?.revision ?? 0,
        scenarioRevision: state.scenarioRevision,
        effects: state.permissions.map((p) => p.request.id),
      },
    },
  );
function askGap(state: LiveValidation, id = "no-device") {
  return recordValidation(
    state,
    {
      kind: "request",
      request: {
        kind: "gap",
        id,
        head,
        scenario: scenario.id,
        missingCapability: "Actual target device",
        reason: "No device is connected.",
        alternatives: [
          { attempted: "Hermetic simulator", result: "Cannot demonstrate actual target input." },
        ],
        remedies: ["Connect a disposable test device."],
      },
    },
    ctx,
  );
}
function approve(state: LiveValidation, request: string) {
  const bound = recordValidation(
    state,
    { kind: "decision", request, card: "ask", action: "accept" },
    { ...ctx, decision: { offer: "shown-offer" } },
  );
  return decideValidation(bound, {
    card: "ask",
    offer: "shown-offer",
    action: "accept",
    label: "Accept this specific gap",
    head,
    at: 3,
  });
}

describe("Careful's accepted live-validation contract", () => {
  it("INF-125: code clearance cannot survive new evidence or an unreviewed scenario revision", () => {
    const cleared = review(plan());
    expect(validationCodeClearance(cleared, head)?.code).toBe("clear");
    const observed = run(cleared);
    expect(validationCodeClearance(observed, head)).toBeUndefined();
    const reread = review(observed);
    expect(validationCodeClearance(reread, head)?.code).toBe("clear");
    const changed = recordValidation(
      reread,
      {
        kind: "plan",
        previousRevision: reread.scenarioRevision,
        reason: "The captain also asks to check recovery.",
        scenarios: [{ ...scenario, adverse: "Recover focus after cancelling the action." }],
      },
      ctx,
    );
    expect(validationCodeClearance(changed, head)).toBeUndefined();
  });

  it("holds missing proof, omitted coverage, a new version and new evidence until the exact pair is reviewed", () => {
    const planned = plan();
    expect(acceptedValidation(planned, head).ready).toBe(false);
    const observed = run(planned);
    expect(acceptedValidation(observed, head).ready).toBe(false);
    const omitted = review(observed, head, {
      coverage: "missing",
      omitted: ["The captain also requested frame isolation."],
    });
    expect(acceptedValidation(omitted, head).ready).toBe(false);
    const accepted = review(omitted);
    expect(acceptedValidation(accepted, head)).toMatchObject({
      ready: true,
      label: "Demonstrated for this version",
    });
    expect(acceptedValidation(accepted, later).ready).toBe(false);
    const newEvidence = run(accepted, head, false, "run-2");
    expect(acceptedValidation(newEvidence, head).ready).toBe(false);
    expect(acceptedValidation(review(newEvidence), head).ready).toBe(true);
    expect(run(newEvidence, head, false, "run-2").runs).toHaveLength(2);
  });

  // INF-1824 (the captain's answer to its question 5): an accepted gap ends
  // only when that check runs and fails, or leaves the list of checks.
  it("keeps captain permission separate and carries an accepted gap through rewording, later versions and restart", () => {
    const missing = review(askGap(run(plan(), head, true)));
    expect(acceptedValidation(missing, head).ready).toBe(false);
    const permitted = approve(missing, "no-device");
    expect(acceptedValidation(permitted, head)).toMatchObject({
      ready: true,
      label: "Proceeding without live proof",
    });
    expect(() => askGap(permitted, "no-device-again")).toThrow("stays accepted");
    const restarted = JSON.parse(JSON.stringify(permitted)) as LiveValidation;
    const next = review(run(restarted, later, true, "run-2"), later);
    expect(acceptedValidation(next, later).label).toBe("Proceeding without live proof");
    expect(next.runs.at(-1)?.observations[0]?.result).toBe("untested");
    const reworded = recordValidation(
      next,
      {
        kind: "plan",
        previousRevision: next.scenarioRevision,
        reason: "The same check, described more briefly.",
        scenarios: [{ ...scenario, boundary: "The actual device keyboard" }],
      },
      { ...ctx, head: later },
    );
    expect(reworded.permissions[0]?.state).toBe("approved");
    const rewordedRun = review(run(reworded, later, true, "run-3"), later);
    expect(acceptedValidation(rewordedRun, later).ready).toBe(true);
    const newReason = structuredClone(next);
    newReason.runs.at(-1)!.observations[0]!.reason = "The connected device refused access.";
    expect(acceptedValidation(newReason, later).ready).toBe(true);
    const reached = review(run(next, later, false, "device-returned"), later);
    expect(reached.permissions[0]?.state).toBe("approved");
    expect(acceptedValidation(reached, later).label).toBe("Demonstrated for this version");
    const failed = structuredClone(next);
    const {
      revision: _r,
      at: _a,
      deviceId: _d,
      ...input
    } = run(next, later, false, "x").runs.at(-1)!;
    const failedRun = recordValidation(
      failed,
      {
        ...input,
        id: "device-failed",
        verdict: "no-go",
        observations: [{ ...input.observations[0]!, result: "fail", live: true }],
      },
      { ...ctx, head: later },
    );
    expect(failedRun.permissions[0]?.state).toBe("expired");
    const removed = recordValidation(
      next,
      {
        kind: "plan",
        previousRevision: next.scenarioRevision,
        reason: "The captain dropped this check.",
        scenarios: [{ ...scenario, id: "another-check" }],
      },
      { ...ctx, head: later },
    );
    expect(removed.permissions[0]?.state).toBe("expired");
  });

  it("refuses fabricated go, missing observations and contradictory no-surface results", () => {
    const state = run(plan());
    const { revision: _revision, at: _at, deviceId: _device, ...input } = state.runs[0]!;
    expect(() => recordValidation(plan(), { ...input, observations: [] }, ctx)).toThrow(
      "every scenario",
    );
    expect(() => recordValidation(plan(), { ...input, verdict: "no-surface" }, ctx)).toThrow(
      "contradicts",
    );
    expect(() =>
      recordValidation(
        plan(),
        { ...input, observations: [{ ...input.observations[0]!, result: "fail" }] },
        ctx,
      ),
    ).toThrow("no-go");
    expect(() => recordValidation(plan(), { ...input, completion: "unknown" }, ctx)).toThrow(
      "completed live proof",
    );
    expect(() => recordValidation(plan(), { ...input, evidence: [] }, ctx)).toThrow("not kept");
    const unsupported = {
      ...input,
      observations: [{ ...input.observations[0]!, unproven: ["Actual device input"] }],
    };
    expect(() => recordValidation(plan(), unsupported, ctx)).toThrow("every required scenario");
  });

  it("accepts a reviewed no-surface reason without ever labelling it a live pass", () => {
    const planned = recordValidation(
      undefined,
      {
        kind: "plan",
        previousRevision: 0,
        reason: "The requested change is explanatory prose only.",
        scenarios: [],
      },
      ctx,
    );
    const observed = recordValidation(
      planned,
      {
        kind: "run",
        id: "prose",
        head,
        scenarioRevision: 1,
        completion: "complete",
        verdict: "no-surface",
        reason: "Only explanatory prose changed; there is nothing to run.",
        observations: [],
        evidence: [],
      },
      ctx,
    );
    expect(acceptedValidation(observed, head).ready).toBe(false);
    expect(acceptedValidation(review(observed), head)).toMatchObject({
      ready: true,
      label: "No running surface",
    });
  });

  it("asks about each persistent effect after exact code clearance and never repeats an unknown outcome", () => {
    const request = {
      kind: "effect" as const,
      id: "shared-record",
      head,
      forgeWrite: {
        host: "github.com",
        method: "POST" as const,
        path: "/repos/octo/meter/issues/1/comments",
        bodyDigest: createHash("sha256")
          .update(JSON.stringify({ body: "Keyboard validation record" }))
          .digest("hex"),
      },
      scenario: scenario.id,
      action: "Create one keyboard test record",
      destination: "Disposable shared staging project",
      audience: "Project collaborators",
      visibility: "others" as const,
      persistent: true,
      purpose: "Check the real service boundary",
      lastingEffects: "One shared record and its audit entry",
      cleanup: "Delete the record after reading the result; the audit remains",
      access: "Disposable test account",
      preChange: false,
      prerequisitePublication: false,
    };
    const proposed = recordValidation(plan(), { kind: "request", request }, ctx);
    expect(() => approve(proposed, request.id)).toThrow("reviewer must clear");
    const cleared = review(proposed);
    const granted = approve(cleared, request.id);
    const started = recordValidation(
      granted,
      {
        kind: "effect-state",
        request: request.id,
        state: "started",
        evidence: "Begin the one approved action.",
      },
      ctx,
    );
    const unknown = recordValidation(
      started,
      {
        kind: "effect-state",
        request: request.id,
        state: "unknown",
        evidence: "The service disconnected without a receipt.",
      },
      ctx,
    );
    expect(() =>
      recordValidation(
        unknown,
        { kind: "effect-state", request: request.id, state: "started", evidence: "Try it again." },
        ctx,
      ),
    ).toThrow("once");
    const repeated = { ...request, id: "another-request-id" };
    expect(() => recordValidation(unknown, { kind: "request", request: repeated }, ctx)).toThrow(
      "reconcile",
    );
    // Two independently approved requests still cannot replay an unresolved identical write.
    const second = approve(
      review(recordValidation(granted, { kind: "request", request: repeated }, ctx)),
      repeated.id,
    );
    const firstStarted = recordValidation(
      second,
      {
        kind: "effect-state",
        request: request.id,
        state: "started",
        evidence: "The first request started.",
      },
      ctx,
    );
    expect(() =>
      recordValidation(
        firstStarted,
        {
          kind: "effect-state",
          request: repeated.id,
          state: "started",
          evidence: "Try the same bytes under another identity.",
        },
        ctx,
      ),
    ).toThrow("reconcile");
    expect(() =>
      recordValidation(
        granted,
        { kind: "effect-state", request: request.id, state: "started", evidence: "Changed code." },
        { ...ctx, head: later },
      ),
    ).toThrow("current version");
    expect(() =>
      recordValidation(
        granted,
        { kind: "request", request: { ...request, destination: "Another staging project" } },
        ctx,
      ),
    ).toThrow("fresh captain answer");
    expect(acceptedValidation(granted, head).ready).toBe(false);
  });

  it("keeps old proof readable without presenting it as the current version's result", () => {
    // INF-125: an exact-version result must not describe a changed version as demonstrated.
    const state = review(run(plan()));
    const current = liveValidationSummary(state, head, false)!;
    const changed = liveValidationSummary(state, later, false)!;
    expect(changed.label).not.toBe(current.label);
    expect(changed.rows[0]!.result).not.toBe(current.rows[0]!.result);
    expect(changed.rows[0]!.evidence).toEqual(current.rows[0]!.evidence);
  });

  it("does not let a reviewer run, grant consent, or review a different assigned pair", () => {
    const state = plan();
    expect(() =>
      recordValidation(
        state,
        {
          kind: "plan",
          previousRevision: 1,
          reason: "Remove the difficult scenario.",
          scenarios: [],
        },
        { ...ctx, reviewer: "reviewer" },
      ),
    ).toThrow("never records");
    expect(() => review(run(state), head, { revision: 7 })).toThrow("assigned");
    const gap = askGap(run(state, head, true));
    const unanswered = recordValidation(
      gap,
      { kind: "decision", request: "no-device", card: "ask", action: "accept" },
      { ...ctx, decision: { offer: "shown-offer" } },
    );
    expect(
      decideValidation(unanswered, {
        card: "ask",
        offer: "another-offer",
        action: "accept",
        label: "Accept",
        head,
        at: 2,
      }).permissions[0]?.state,
    ).toBe("requested");
  });

  it("INF-1875: the typed review is the verdict, so it cannot contradict its findings, and keeps findings and risk", () => {
    const state = run(plan());
    const blocking = {
      id: "F1",
      severity: "error" as const,
      file: "src/x.ts",
      line: 12,
      text: "the flush races the read",
      action: "auto-fix" as const,
    };
    const note = {
      id: "F2",
      severity: "info" as const,
      text: "a tradeoff worth noting",
      action: "no-op" as const,
    };
    expect(() => review(state, head, { code: "clear", findings: [blocking] })).toThrow(
      "contradicts a finding that blocks",
    );
    expect(() => review(state, head, { code: "findings", findings: [note] })).toThrow(
      "needs a finding that blocks",
    );
    expect(() => review(state, head, { code: "findings" })).toThrow("needs a finding that blocks");
    const kept = review(state, head, {
      code: "findings",
      findings: [blocking, note],
      risk: { level: "medium", why: "one production line moves." },
    });
    expect(kept.reviews.at(-1)).toMatchObject({
      code: "findings",
      findings: [blocking, note],
      risk: { level: "medium", why: "one production line moves." },
    });
    // Info findings ride a clear review; a blocked review needs none.
    expect(review(state, head, { code: "clear", findings: [note] }).reviews.at(-1)?.code).toBe(
      "clear",
    );
    expect(review(state, head, { code: "blocked" }).reviews.at(-1)?.code).toBe("blocked");
  });

  // INF-2672, the captain's direction A: "review the code first, prove once, and the reviewer
  // reads that proof once"; a wording-only commit "keeps the proof already run; the reviewer
  // confirms it reaches no scenario".
  it("INF-2672: a wording commit keeps the proof a review at its version judged, and a version no review judged does not", () => {
    const proved = review(run(plan()));
    expect(acceptedValidation(proved, later).ready).toBe(false);
    const kept = review(proved, later);
    expect(acceptedValidation(kept, later)).toMatchObject({
      ready: true,
      label: "Demonstrated for this version",
    });
    expect(kept.runs).toHaveLength(1);
    expect(liveValidationSummary(kept, later, false)!.rows[0]!.result).toBe("Passed live");
    // A difference that reaches the scenario leaves it for the builder to rerun.
    const reached = review(proved, later, {
      coverage: "missing",
      omitted: ["The repair changes the Close button the scenario presses."],
      verdict: "inconclusive",
    });
    expect(acceptedValidation(reached, later).ready).toBe(false);
  });

  it("INF-2672: INF-1892's seven review rounds record one proof run and one proof read, not seven of each", () => {
    // INF-1892 took six findings rounds - two code fixes, then docs, comments, docs and
    // design wording - before its pass; each made a new version.
    const versions = ["1", "2", "3", "4", "5", "6", "7"].map((digit) => digit.repeat(40));
    const blocking = {
      id: "F1",
      severity: "warning" as const,
      text: "a stale sentence",
      action: "auto-fix" as const,
    };
    let state = plan();
    for (const version of versions.slice(0, 6))
      state = review(state, version, {
        code: "findings",
        findings: [blocking],
        coverage: "complete",
        verdict: "inconclusive",
        reason: "Proof runs after the code passes.",
      });
    const passed = versions[6]!;
    state = review(state, passed, {
      verdict: "inconclusive",
      reason: "Proof runs after the code passes.",
    });
    expect(acceptedValidation(state, passed).ready).toBe(false);
    state = review(run(state, passed), passed);
    expect(acceptedValidation(state, passed).ready).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(state.reviews.filter((item) => item.revision > 0)).toHaveLength(1);
  });
});

// INF-1824's accepted plan, built from the three records that drew it: one
// approval per check, a version's gaps on one checklist, accepted gaps that last.
describe("INF-1824: one approval per check and one card for a version's gaps", () => {
  const third = "d".repeat(40);
  const claudeCheck: ValidationScenario = {
    id: "claude-real-turn",
    source: "Prove a real Claude crewmate follows the new instruction.",
    importance: "required",
    action: "Run one crewmate turn on a real Claude model through the app.",
    expected: "The crewmate records one typed request instead of a prose ask.",
    adverse: "A scripted model would prove only the host's behavior.",
    environment: "Hermetic app home with the captain's own Claude sign-in.",
    signal: "The task record holds the typed request.",
    boundary: "A real Claude model",
    resources: "Your Claude sign-in, through the app, for real model turns",
    cost: "One crewmate turn of your Claude plan's allowance, about five minutes",
  };
  const codexCheck: ValidationScenario = {
    ...claudeCheck,
    id: "codex-real-turn",
    action: "Run one crewmate turn on a real Codex model through the app.",
    boundary: "A real Codex model",
    resources: "Your Codex sign-in, through the app, for real model turns",
    cost: "One crewmate turn of your Codex plan's allowance, about five minutes",
  };
  const planned = (scenarios: ValidationScenario[], state?: LiveValidation, at = head) =>
    recordValidation(
      state,
      {
        kind: "plan",
        previousRevision: state?.scenarioRevision ?? 0,
        reason: "The captain asked for proof on real models.",
        scenarios,
      },
      { ...ctx, head: at },
    );
  const observed = (state: LiveValidation, at: string, id: string, untested: string[] = []) =>
    recordValidation(
      state,
      {
        kind: "run",
        id,
        head: at,
        scenarioRevision: state.scenarioRevision,
        completion: "complete",
        verdict: untested.length ? "inconclusive" : "go",
        reason: "Ran each check that could run.",
        observations: state.scenarios.map((check) =>
          untested.includes(check.id)
            ? {
                scenario: check.id,
                result: "untested" as const,
                live: false,
                actual: "It could not run here.",
                evidence: [],
                standIns: [],
                unproven: [check.expected],
                attempted: ["A hermetic stand-in, which cannot reach the boundary."],
                missingCapability: check.boundary,
                reason: `${check.boundary} is not reachable from this computer.`,
              }
            : {
                scenario: check.id,
                result: "pass" as const,
                live: true,
                actual: check.expected,
                evidence: ["transcript"],
                standIns: [],
                unproven: [],
                attempted: [],
              },
        ),
        evidence: [
          {
            id: "transcript",
            description: "The run's transcript",
            file: "transcript.txt",
            digest: "e".repeat(64),
            bytes: 2048,
          },
        ],
      },
      { ...ctx, head: at },
    );
  const ask = (state: LiveValidation, request: KeptValidationInput, at = head) =>
    recordValidation(state, request, { ...ctx, head: at });
  function decide(
    state: LiveValidation,
    card: string,
    requests: string[],
    at = head,
    ticked?: string[],
  ) {
    let bound = state;
    for (const request of requests)
      bound = recordValidation(
        bound,
        { kind: "decision", request, card, action: "accept" },
        { ...ctx, head: at, decision: { offer: `${card}-offer` } },
      );
    return decideValidation(bound, {
      card,
      offer: `${card}-offer`,
      action: "accept",
      label: "Accept",
      head: at,
      at: 5,
      ...(ticked ? { ticked } : {}),
    });
  }
  const answeredCards = (state: LiveValidation) =>
    new Set(state.permissions.flatMap((item) => (item.answer ? [item.decision?.card] : []))).size;
  const gapRequest = (state: LiveValidation, scenarioId: string, id: string, at = head) => {
    const observation = state.runs
      .at(-1)!
      .observations.find((item) => item.scenario === scenarioId)!;
    return {
      kind: "request" as const,
      request: {
        kind: "gap" as const,
        id,
        head: at,
        scenario: scenarioId,
        missingCapability: observation.missingCapability!,
        reason: observation.reason!,
        alternatives: [
          { attempted: "A hermetic stand-in", result: "It cannot reach the boundary." },
        ],
        remedies: ["Run it where the boundary is reachable."],
      },
    };
  };

  it("INF-1723: script fixes and reruns ride the first approval, so its checks take two approvals, not eight", () => {
    let state = planned([claudeCheck]);
    expect(() => observed(state, head, "before-approval")).toThrow("needs your approval");
    state = decide(
      ask(state, {
        kind: "request",
        request: { kind: "check", id: "claude-run", head, scenario: claudeCheck.id },
      }),
      "approve-claude-run",
      ["claude-run"],
    );
    // Script fixes, a rerun and a model the captain picked: no new ask.
    state = observed(state, head, "first-run");
    state = observed(state, later, "after-script-fix");
    state = observed(state, later, "run-once-more");
    state = observed(
      planned([{ ...claudeCheck, action: "Run one turn on Sonnet, as you picked." }], state, third),
      third,
      "sonnet-run",
    );
    expect(() =>
      ask(
        state,
        {
          kind: "request",
          request: { kind: "check", id: "claude-again", head: third, scenario: claudeCheck.id },
        },
        third,
      ),
    ).toThrow("without asking again");
    // A check that declares another sign-in asks once.
    state = planned([claudeCheck, codexCheck], state, third);
    expect(() => observed(state, third, "codex-unapproved")).toThrow(codexCheck.id);
    state = decide(
      ask(
        state,
        {
          kind: "request",
          request: { kind: "check", id: "codex-run", head: third, scenario: codexCheck.id },
        },
        third,
      ),
      "codex-run-consent",
      ["codex-run"],
      third,
    );
    state = observed(state, third, "both-models");
    expect(answeredCards(state)).toBe(2);
    // Declaring a run that costs more ends the approval until a new answer.
    const costlier = planned(
      [{ ...claudeCheck, cost: "Ten crewmate turns of your Claude plan's allowance" }, codexCheck],
      state,
      third,
    );
    expect(costlier.permissions.find((item) => item.request.id === "claude-run")?.state).toBe(
      "expired",
    );
    expect(() => observed(costlier, third, "costlier")).toThrow(claudeCheck.id);
  });

  it("FIRS-3: four gaps of one version share one checklist and the next round's gap takes a second card", () => {
    const checks = [
      "outside-prs-quick",
      "full-ci-label",
      "other-labels-inert",
      "main-newest-only",
    ].map((id) => ({ ...scenario, id, action: `Prove ${id} on the real repository's workflows.` }));
    let state = observed(
      planned(checks),
      head,
      "r1",
      checks.map((check) => check.id),
    );
    for (const check of checks) state = ask(state, gapRequest(state, check.id, `gap-${check.id}`));
    const ids = checks.map((check) => `gap-${check.id}`);
    // The captain unticks one row: it stays held.
    const partial = decide(state, "gaps-r1", ids, head, ids.slice(0, 3));
    expect(partial.permissions.map((item) => item.state)).toEqual([
      "approved",
      "approved",
      "approved",
      "declined",
    ]);
    state = decide(state, "gaps-r1", ids, head, ids);
    expect(state.permissions.every((item) => item.state === "approved")).toBe(true);
    const fork = { ...scenario, id: "trusted-write-fork", action: "Prove a fork cannot write." };
    state = observed(planned([...checks, fork], state, later), later, "r2", [
      ...checks.map((check) => check.id),
      fork.id,
    ]);
    state = decide(
      ask(state, gapRequest(state, fork.id, "gap-fork", later), later),
      "gaps-r2",
      ["gap-fork"],
      later,
    );
    expect(answeredCards(state)).toBe(2);
    expect(acceptedValidation(review(state, later), later).label).toBe(
      "Proceeding without live proof",
    );
    // An effect never rides a gap checklist.
    const single = observed(planned([checks[0]!]), head, "single", [checks[0]!.id]);
    const withGap = ask(single, gapRequest(single, checks[0]!.id, "gap-one"));
    const effect = recordValidation(
      withGap,
      {
        kind: "request",
        request: {
          kind: "effect",
          id: "shared-comment",
          head,
          scenario: checks[0]!.id,
          action: "Comment once on a test pull request",
          destination: "The project's repository",
          audience: "Project collaborators",
          visibility: "others",
          persistent: true,
          purpose: "Check the real workflow trigger",
          lastingEffects: "One comment",
          cleanup: "Delete the comment",
          access: "The app's GitHub sign-in",
          preChange: true,
          prerequisitePublication: false,
        },
      },
      ctx,
    );
    expect(() => decide(effect, "both", ["gap-one", "shared-comment"])).toThrow("only one");
  });

  it("INF-1731: a reworded check keeps its accepted gap, so the gap is asked about once", () => {
    const twoComputers = {
      ...scenario,
      id: "gap-two-computers",
      action: "Place a task on a second computer and read its result at home.",
      boundary: "Two real computers paired with each other",
    };
    let state = observed(planned([twoComputers]), head, "r1", [twoComputers.id]);
    state = decide(
      ask(state, gapRequest(state, twoComputers.id, "gap-two-computers")),
      "accept-4pm",
      ["gap-two-computers"],
    );
    state = planned(
      [
        {
          ...twoComputers,
          expected: "The result arrives.",
          signal: "It arrives.",
          boundary: "Two computers",
        },
      ],
      state,
      later,
    );
    state = review(observed(state, later, "r2", [twoComputers.id]), later);
    expect(acceptedValidation(state, later).label).toBe("Proceeding without live proof");
    expect(() =>
      ask(state, gapRequest(state, twoComputers.id, "gap-two-computers-r4", later), later),
    ).toThrow("stays accepted");
    expect(state.permissions.filter((item) => item.request.kind === "gap")).toHaveLength(1);
  });
});
