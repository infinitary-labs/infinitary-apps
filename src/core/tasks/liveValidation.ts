import {
  acceptedGap,
  checkApproval,
  checkValidationRun,
  emptyValidation,
  type KeptValidationInput,
  type LiveValidation,
  latestValidationRun,
  sameCheckReach,
  sameScenario,
  type ValidationPermission,
  type ValidationReview,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";
import { findingsBlock } from "@shared/rigor";

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
      // INF-1824: an accepted gap lasts while its check is on the list; a
      // check approval while the check declares the same reach and cost.
      for (const permission of state.permissions) {
        if (permission.state !== "approved" || permission.request.kind === "effect") continue;
        const replacement = input.scenarios.find((item) => item.id === permission.scenario.id);
        if (
          !replacement ||
          (permission.request.kind === "check" && !sameCheckReach(permission.scenario, replacement))
        )
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
      for (const scenario of state.scenarios) {
        const observation = input.observations.find((item) => item.scenario === scenario.id);
        if (
          scenario.resources &&
          observation?.result !== "untested" &&
          !checkApproval(state, scenario)
        )
          fail(
            `The check ${scenario.id} declares what it uses, and its run needs your approval of those resources and their cost per run first.`,
          );
      }
      // INF-1824: an accepted gap ends only when its check runs and fails.
      for (const permission of state.permissions) {
        if (permission.state !== "approved" || permission.request.kind !== "gap") continue;
        const observation = input.observations.find(
          (item) => item.scenario === permission.scenario.id,
        );
        if (observation?.result === "fail") permission.state = "expired";
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
      // The typed record is the verdict (INF-1875), so it cannot contradict
      // itself: a finding that blocks is not clear code, and code findings
      // rest on at least one finding.
      if (input.code === "clear" && findingsBlock(input.findings ?? []))
        fail("Code clear contradicts a finding that blocks; report code findings.");
      if (input.code === "findings" && !findingsBlock(input.findings ?? []))
        fail(
          "Code findings needs a finding that blocks (error, warning or ask-user); report code clear and keep the notes as findings.",
        );
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
      if (request.kind === "check") {
        if (!scenario.resources || !scenario.cost)
          fail("A check approval names the check's declared resources and the cost of one run.");
        if (checkApproval(state, scenario))
          fail(
            "Your approval of this check already covers its runs while it declares the same resources and cost; run it without asking again.",
          );
      }
      if (request.kind === "gap") {
        if (acceptedGap(state, scenario.id))
          fail("You already accepted this check's gap, and it stays accepted; do not ask again.");
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
      // INF-1824: gaps of one version share one checklist card; any other
      // request keeps its own decision.
      const shared = state.permissions.filter(
        (other) =>
          other !== permission &&
          other.state === "requested" &&
          other.decision?.card === input.card,
      );
      if (
        shared.length &&
        (permission.request.kind !== "gap" ||
          shared.some(
            (other) =>
              other.request.kind !== "gap" || other.request.head !== permission.request.head,
          ))
      )
        fail("One decision approves only one validation request, or the gaps of one version.");
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
  input: {
    card: string;
    offer: string;
    action: string;
    label: string;
    at: number;
    head: string;
    /** INF-1824: the rows ticked on a checklist of several gaps; the rest stay held. */
    ticked?: readonly string[];
  },
): LiveValidation {
  const next = structuredClone(state);
  const asked = next.permissions.filter(
    (permission) =>
      permission.state === "requested" &&
      permission.decision?.card === input.card &&
      permission.decision.offer === input.offer,
  );
  const checklist = asked.length > 1;
  for (const permission of asked) {
    const accepting =
      permission.decision?.action === input.action &&
      (!checklist || (input.ticked ?? []).includes(permission.request.id));
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
