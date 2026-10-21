import {
  checkValidationRun,
  emptyValidation,
  type KeptValidationInput,
  type LiveValidation,
  latestValidationRun,
  sameScenario,
  type ValidationPermission,
  type ValidationReview,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";

/** Pure transitions; TaskService is the only writer. No reported fact can mint consent. */
export function recordValidation(
  previous: LiveValidation | undefined,
  input: KeptValidationInput,
  context: {
    head: string;
    deviceId: string | null;
    at: number;
    reviewer?: string;
    assignment?: {
      head: string;
      revision: number;
      scenarioRevision: number;
      stateRevision?: number;
      effects: string[];
    };
    decision?: { offer: string; lifecycle?: string };
  },
): LiveValidation {
  const state = structuredClone(previous ?? emptyValidation());
  function fail(reason: string): never {
    throw new Error(`Live validation refused: ${reason}`);
  }
  if (input.kind !== "review" && context.reviewer)
    fail("A reviewer judges proof, never records a builder's runs or permissions.");
  switch (input.kind) {
    case "plan": {
      if (input.previousRevision !== state.scenarioRevision)
        fail("Read the current scenario revision before changing it.");
      if (new Set(input.scenarios.map((item) => item.id)).size !== input.scenarios.length)
        fail("Scenario identities must be unique.");
      for (const permission of state.permissions) {
        if (permission.state !== "approved" || permission.request.kind !== "gap") continue;
        const replacement = input.scenarios.find((item) => item.id === permission.scenario.id);
        if (!replacement || !sameScenario(permission.scenario, replacement))
          permission.state = "expired";
      }
      state.scenarioRevision++;
      state.scenarios = input.scenarios;
      state.plans.push({
        revision: state.scenarioRevision,
        reason: input.reason,
        scenarios: input.scenarios,
        at: context.at,
      });
      break;
    }
    case "run": {
      if (!state.scenarioRevision) fail("Record scenarios before recording their run.");
      if (input.head !== context.head)
        fail("Run the committed version that is on this task's branch now.");
      const problem = checkValidationRun(state, input);
      if (problem) fail(problem);
      const existing = state.runs.find((run) => run.id === input.id);
      if (existing) {
        const content = (run: typeof input) =>
          JSON.stringify({
            ...run,
            evidence: run.evidence.map(({ id, digest, description, posterDigest }) => ({
              id,
              digest,
              description,
              posterDigest,
            })),
          });
        const { revision: _revision, deviceId: _device, at: _at, ...recorded } = existing;
        if (content(recorded) !== content(input))
          fail("A run identity cannot be reused for changed evidence or observations.");
        return state;
      }
      for (const permission of state.permissions) {
        if (permission.state !== "approved" || permission.request.kind !== "gap") continue;
        const observation = input.observations.find(
          (item) => item.scenario === permission.scenario.id,
        );
        if (
          observation?.result !== "untested" ||
          observation.missingCapability !== permission.request.missingCapability ||
          observation.reason !== permission.request.reason
        )
          permission.state = "expired";
      }
      state.runs.push({
        ...input,
        revision: validationRevision(state) + 1,
        deviceId: context.deviceId,
        at: context.at,
      });
      break;
    }
    case "review": {
      const assigned = context.assignment;
      if (!context.reviewer || !assigned)
        fail("Only the independently assigned reviewer may judge validation.");
      if (input.head !== assigned.head || input.revision !== assigned.revision)
        fail("Judge only the version and evidence assigned to this review turn.");
      if (input.effects.some((id) => !assigned.effects.includes(id)))
        fail("Only effects assigned to this review may be cleared.");
      if (input.coverage === "complete" && input.omitted.length)
        fail("An omitted required scenario is incomplete coverage.");
      state.reviews.push({
        ...input,
        reviewer: context.reviewer,
        at: context.at,
        scenarioRevision: assigned.scenarioRevision,
        stateRevision: assigned.stateRevision ?? 0,
      });
      break;
    }
    case "request": {
      const request = input.request;
      if (request.head !== context.head) fail("Ask about the current committed version.");
      const scenario = state.scenarios.find((item) => item.id === request.scenario);
      if (!scenario) fail("Name a scenario in the current plan.");
      const existing = state.permissions.find((item) => item.request.id === request.id);
      if (existing) {
        if (
          JSON.stringify(existing.request) !== JSON.stringify(request) ||
          !sameScenario(existing.scenario, scenario)
        )
          fail("A changed request needs a new identity and a fresh captain answer.");
        return state;
      }
      if (request.kind === "effect" && unresolvedWrite(state, request))
        fail(
          "An earlier identical write has an unknown outcome; reconcile it before asking again.",
        );
      if (request.kind === "gap") {
        const run = latestValidationRun(state);
        const observation = run?.observations.find((item) => item.scenario === request.scenario);
        if (
          scenario.importance !== "required" ||
          run?.head !== context.head ||
          run.scenarioRevision !== state.scenarioRevision ||
          run.verdict !== "inconclusive" ||
          observation?.result !== "untested" ||
          request.missingCapability !== observation.missingCapability ||
          request.reason !== observation.reason
        )
          fail(
            "An exception covers only the specific required gap recorded by the current run, never a failure.",
          );
      }
      state.permissions.push({ request, scenario, state: "requested", at: context.at });
      break;
    }
    case "decision": {
      const permission = state.permissions.find((item) => item.request.id === input.request);
      if (
        !permission ||
        permission.state !== "requested" ||
        permission.request.head !== context.head ||
        !context.decision
      )
        fail("Bind an open decision to a current unanswered request.");
      if (
        state.permissions.some(
          (other) =>
            other !== permission &&
            other.state === "requested" &&
            other.decision?.card === input.card,
        )
      )
        fail("One decision approves only one validation request.");
      if (permission.request.kind === "gap" && !currentGap(state, permission, context.head))
        fail("The required gap changed; report and ask about the current gap.");
      if (permission.request.kind === "effect" && !permission.request.preChange) {
        const clearance = validationCodeClearance(state, context.head);
        if (clearance?.code !== "clear" || !clearance.effects.includes(permission.request.id))
          fail(
            "The reviewer must clear the code and this exact effect before the captain is asked.",
          );
      }
      permission.decision = { card: input.card, action: input.action, ...context.decision };
      break;
    }
    case "effect-state": {
      const permission = state.permissions.find((item) => item.request.id === input.request);
      if (!permission || permission.request.kind !== "effect")
        fail("Name a recorded validation effect.");
      if (input.state === "started") {
        if (permission.state !== "approved" || permission.request.head !== context.head)
          fail(
            "Only the current version's approved action may start, once. Reconcile unknown outcomes instead of repeating them.",
          );
        if (unresolvedWrite(state, permission.request))
          fail(
            "An earlier identical write has an unknown outcome; reconcile it instead of repeating it.",
          );
        const clearance = validationCodeClearance(state, context.head);
        if (!permission.request.preChange && !clearance?.effects.includes(permission.request.id))
          fail("Code clearance for this exact effect is no longer current.");
        const scenario = state.scenarios.find((item) => item.id === permission.request.scenario);
        if (!scenario || !sameScenario(permission.scenario, scenario))
          fail("The scenario changed; ask again.");
      } else if (permission.state !== "started" && permission.state !== "unknown")
        fail("An outcome belongs to an action already started, never an approval.");
      permission.state = input.state;
      permission.outcome = input.evidence;
      break;
    }
  }
  if (input.kind !== "review") state.stateRevision = validationStateRevision(state) + 1;
  return state;
}

export class StaleValidationDecisionError extends Error {}

/** Only the captain's exact chrome action calls this, inside the card resolution transaction. */
export function decideValidation(
  state: LiveValidation,
  input: { card: string; offer: string; action: string; label: string; at: number; head: string },
): LiveValidation {
  const next = structuredClone(state);
  for (const permission of next.permissions) {
    if (
      permission.state !== "requested" ||
      permission.decision?.card !== input.card ||
      permission.decision.offer !== input.offer
    )
      continue;
    const accepting = permission.decision.action === input.action;
    if (accepting) {
      if (permission.request.head !== input.head)
        throw new StaleValidationDecisionError(
          "The validation request's version changed; ask again.",
        );
      const scenario = next.scenarios.find((item) => item.id === permission.request.scenario);
      if (!scenario || !sameScenario(permission.scenario, scenario))
        throw new StaleValidationDecisionError("The validation scenario changed; ask again.");
      if (permission.request.kind === "gap" && !currentGap(next, permission, input.head))
        throw new StaleValidationDecisionError("The required gap changed; ask again.");
      if (
        permission.request.kind === "effect" &&
        !permission.request.preChange &&
        !validationCodeClearance(next, input.head)?.effects.includes(permission.request.id)
      )
        throw new StaleValidationDecisionError(
          "Code clearance for this exact effect changed; ask again after review.",
        );
    }
    permission.state = accepting ? "approved" : "declined";
    permission.answer = { at: input.at, action: input.action, label: input.label };
    next.stateRevision = validationStateRevision(next) + 1;
  }
  return next;
}

function unresolvedWrite(
  state: LiveValidation,
  request: Extract<ValidationPermission["request"], { kind: "effect" }>,
): boolean {
  const write = request.forgeWrite;
  if (!write) return false;
  return state.permissions.some((other) => {
    if (
      other.request.id === request.id ||
      other.request.kind !== "effect" ||
      (other.state !== "started" && other.state !== "unknown")
    )
      return false;
    const previous = other.request.forgeWrite;
    return (
      previous?.host === write.host &&
      previous.method === write.method &&
      previous.path === write.path &&
      previous.bodyDigest === write.bodyDigest
    );
  });
}

function currentGap(
  state: LiveValidation,
  permission: ValidationPermission,
  head: string,
): boolean {
  if (permission.request.kind !== "gap") return false;
  const run = latestValidationRun(state);
  const observation = run?.observations.find((item) => item.scenario === permission.scenario.id);
  return (
    run?.head === head &&
    run.scenarioRevision === state.scenarioRevision &&
    run.verdict === "inconclusive" &&
    observation?.result === "untested" &&
    observation.missingCapability === permission.request.missingCapability &&
    observation.reason === permission.request.reason
  );
}

export function validationCodeClearance(
  state: LiveValidation | undefined,
  head: string,
): ValidationReview | undefined {
  const review = state?.reviews.findLast(
    (review) =>
      review.head === head &&
      review.revision === validationRevision(state) &&
      review.scenarioRevision === state.scenarioRevision,
  );
  return review?.code === "clear" ? review : undefined;
}
export function earlyPublication(
  state: LiveValidation | undefined,
  head: string,
  existing = false,
): ValidationPermission | undefined {
  return state?.permissions.find(
    (permission) =>
      permission.request.kind === "effect" &&
      permission.request.prerequisitePublication &&
      permission.request.head === head &&
      (permission.state === "approved" ||
        (existing && ["started", "unknown", "succeeded"].includes(permission.state))) &&
      validationCodeClearance(state, head)?.effects.includes(permission.request.id),
  );
}
