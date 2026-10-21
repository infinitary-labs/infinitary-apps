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
function askGap(state: LiveValidation) {
  return recordValidation(
    state,
    {
      kind: "request",
      request: {
        kind: "gap",
        id: "no-device",
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

  it("keeps captain permission separate and carries only the identical required gap across versions and restart", () => {
    const missing = review(askGap(run(plan(), head, true)));
    expect(acceptedValidation(missing, head).ready).toBe(false);
    const permitted = approve(missing, "no-device");
    const reordered = recordValidation(
      permitted,
      {
        kind: "plan",
        previousRevision: permitted.scenarioRevision,
        reason: "The same scenario facts arrive with different JSON key order.",
        scenarios: [Object.fromEntries(Object.entries(scenario).reverse()) as ValidationScenario],
      },
      ctx,
    );
    expect(reordered.permissions[0]?.state).toBe("approved");
    expect(acceptedValidation(permitted, head)).toMatchObject({
      ready: true,
      label: "Proceeding without live proof",
    });
    const restarted = JSON.parse(JSON.stringify(permitted)) as LiveValidation;
    const next = review(run(restarted, later, true, "run-2"), later);
    expect(acceptedValidation(next, later).label).toBe("Proceeding without live proof");
    expect(next.runs.at(-1)?.observations[0]?.result).toBe("untested");
    const reached = run(next, later, false, "device-returned");
    expect(reached.permissions[0]?.state).toBe("expired");
    const missingAgain = review(run(reached, later, true, "device-gone-again"), later);
    expect(acceptedValidation(missingAgain, later).ready).toBe(false);
    const changed = recordValidation(
      next,
      {
        kind: "plan",
        previousRevision: 1,
        reason: "The captain now asks for another input boundary.",
        scenarios: [{ ...scenario, boundary: "An actual iPhone" }],
      },
      { ...ctx, head: later },
    );
    const changedRun = review(run(changed, later, true, "run-3"), later);
    expect(acceptedValidation(changedRun, later).ready).toBe(false);
    const newReason = structuredClone(next);
    newReason.runs.at(-1)!.observations[0]!.reason = "The connected device refused access.";
    expect(acceptedValidation(newReason, later).ready).toBe(false);
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
});
