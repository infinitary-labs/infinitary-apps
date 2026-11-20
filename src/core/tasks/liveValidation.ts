import type { CaptainAllowance } from "@shared/captainAllowances";
import { STANDING_WORDS_FROM } from "@shared/holds";
import {
  acceptedGap,
  checkApproval,
  checkValidationRun,
  emptyValidation,
  type KeptValidationInput,
  LIVE_VALIDATION_WORDS,
  type LiveValidation,
  latestValidationRun,
  sameCheckReach,
  sameScenario,
  scenariosOfRun,
  unprovenRequired,
  type ValidationAllowance,
  type ValidationPermission,
  type ValidationReview,
  type ValidationRun,
  validationRevision,
  validationStateRevision,
  verdictContradiction,
} from "@shared/liveValidation";
import { findingsBlock } from "@shared/rigor";

/**
 * INF-3664: a review's verdict obeys the rules its run's own record obeys,
 * so a proof read never records one the run could not carry. On INF-3617 a
 * reviewer read a run whose one gap the captain had accepted and recorded
 * go; acceptance, which needs the two verdicts to match, then sent the
 * builder back to prove again. The refusal names the run and, for an
 * accepted gap, the verdict it keeps.
 */
function reviewVerdictProblem(
  state: LiveValidation,
  run: ValidationRun,
  verdict: ValidationRun["verdict"],
): string | undefined {
  const scenarios = scenariosOfRun(state, run);
  const problem = verdictContradiction(verdict, run, scenarios);
  if (!problem) return undefined;
  const ruled = `${problem} Run ${run.revision}'s own record rules out ${verdict}, so a review of it cannot record it either; record the verdict that run can carry.`;
  if (verdict !== "go" || run.observations.some((item) => item.result === "fail")) return ruled;
  const accepted = unprovenRequired(run, scenarios)
    .filter((scenario) => acceptedGap(state, scenario.id))
    .map((scenario) => scenario.id);
  if (!accepted.length) return ruled;
  return `${ruled} The captain's accepted gap for ${accepted.join(", ")} leaves that proof missing, so the run and its review stay inconclusive; the host shows the gap as ${LIVE_VALIDATION_WORDS.exception}.`;
}

function missingAllowance(source: string): string {
  return `${source === STANDING_WORDS_FROM ? "No standing override of the captain's stands on this task now." : `No current consent from ${source} stands on this task.`} Name a current project direction by its d: id, standing for the task override, or a kept yes's card from Already allowed whose words cover the request; otherwise ask through emit_card.validation_request.`;
}

/** Pure transitions; TaskService is the only writer. Reports only consume consent the captain still keeps. */
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
    /** Current directions, standing override and kept yeses for this task. */
    allowances?: readonly (ValidationAllowance & Pick<CaptainAllowance, "words">)[];
  },
): LiveValidation {
  const state = structuredClone(previous ?? emptyValidation());
  function fail(reason: string): never {
    throw new Error(`Live validation refused: ${reason}`);
  }
  const currentAllowance = (permission: ValidationPermission) => {
    const { request, allowanceSnapshot } = permission;
    if (request.kind !== "effect" || !allowanceSnapshot) return undefined;
    return context.allowances?.find(
      (entry) =>
        entry.card === request.allowance &&
        entry.at === allowanceSnapshot.at &&
        entry.revision === allowanceSnapshot.revision,
    );
  };
  if (input.kind !== "review" && context.reviewer)
    fail("A reviewer judges proof, never records a builder's runs or permissions.");
  // INF-3751: a record an earlier build left with an expired approval its
  // plan declares again heals on its next write, before that write is judged.
  if (input.kind !== "review" && keepCheckApprovals(state))
    state.stateRevision = validationStateRevision(state) + 1;
  switch (input.kind) {
    case "plan": {
      if (input.previousRevision !== state.scenarioRevision)
        fail("Read the current scenario revision before changing it.");
      if (new Set(input.scenarios.map((item) => item.id)).size !== input.scenarios.length)
        fail("Scenario identities must be unique.");
      // INF-1824: an accepted gap lasts while its check is on the list.
      for (const permission of state.permissions) {
        if (permission.state !== "approved" || permission.request.kind !== "gap") continue;
        if (!input.scenarios.some((item) => item.id === permission.scenario.id))
          permission.state = "expired";
      }
      state.scenarioRevision++;
      state.scenarios = input.scenarios;
      keepCheckApprovals(state);
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
        const {
          revision: _revision,
          deviceId: _device,
          at: _at,
          checkApprovals: _approvals,
          ...recorded
        } = existing;
        if (content(recorded) !== content(input))
          fail("A run identity cannot be reused for changed evidence or observations.");
        return state;
      }
      const checkApprovals: string[] = [];
      for (const scenario of state.scenarios) {
        const observation = input.observations.find((item) => item.scenario === scenario.id);
        if (!scenario.resources || observation?.result === "untested") continue;
        const approval = checkApproval(state, scenario, context.allowances);
        if (!approval)
          fail(
            `The check ${scenario.id} declares what it uses, and its run needs your approval of those resources and their cost per run first, resting on a yes the captain still keeps. Name a covering direction by its d: id, a kept yes's card, or ${STANDING_WORDS_FROM} for the captain's standing override as a new check request's allowance; otherwise ask through emit_card.validation_request. A run of this check that already passed at this version counts once it is approved: record that same run then, never run the check again only because it started first.`,
          );
        checkApprovals.push(approval.request.id);
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
        ...(checkApprovals.length ? { checkApprovals } : {}),
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
      const judged = state.runs.find((run) => run.revision === input.revision);
      if (judged) {
        const problem = reviewVerdictProblem(state, judged, input.verdict);
        if (problem) fail(problem);
      }
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
      if (
        request.kind === "effect" &&
        request.prerequisitePublication &&
        request.allowance !== undefined
      )
        fail(
          "Prerequisite publication needs its own approval. Omit allowance and ask through emit_card.validation_request after exact review.",
        );
      if (request.kind === "effect" && unresolvedWrite(state, request))
        fail(
          "An earlier identical write has an unknown outcome; reconcile it before asking again.",
        );
      const source = request.kind !== "gap" ? request.allowance : undefined;
      const yes =
        source === undefined
          ? undefined
          : context.allowances?.find((entry) => entry.card === source);
      if (source !== undefined && !yes) fail(missingAllowance(source));
      const allowanceSnapshot = yes
        ? { at: yes.at, ...(yes.revision === undefined ? {} : { revision: yes.revision }) }
        : undefined;
      if (request.kind === "check") {
        if (!scenario.resources || !scenario.cost)
          fail("A check approval names the check's declared resources and the cost of one run.");
        if (checkApproval(state, scenario, context.allowances))
          fail(
            "Your approval of this check already covers its runs while it declares the same resources and cost; run it without asking again.",
          );
        // INF-4446: a yes the captain already gave approves the check with no
        // new card; the crewmate judged it covers these resources and cost,
        // and the approval rests on that yes while it is kept.
        if (yes) {
          const approval: ValidationPermission = {
            request,
            scenario,
            state: "approved",
            at: context.at,
            answer: { at: yes.at, action: "kept-yes", label: yes.words },
            yes: yes.card,
            allowanceSnapshot,
          };
          if (newerNo(state, approval, yes.at))
            fail(
              "The captain declined this check after that yes; ask again through emit_card.validation_request.",
            );
          state.permissions.push(approval);
          break;
        }
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
      state.permissions.push({
        request,
        scenario,
        state: "requested",
        at: context.at,
        ...(allowanceSnapshot ? { allowanceSnapshot } : {}),
      });
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
      if (
        permission.request.kind === "effect" &&
        currentAllowance(permission) &&
        validationCodeClearance(state, context.head)?.effects.includes(permission.request.id)
      )
        fail(
          "Current consent already covers this reviewed action. Start the exact action without a card.",
        );
      permission.decision = { card: input.card, action: input.action, ...context.decision };
      break;
    }
    case "effect-state": {
      const permission = state.permissions.find((item) => item.request.id === input.request);
      if (!permission || permission.request.kind !== "effect")
        fail("Name a recorded validation effect.");
      if (input.state === "started") {
        const named =
          permission.state === "requested" && !permission.decision
            ? permission.request.allowance
            : undefined;
        if (
          (permission.state !== "approved" && named === undefined) ||
          permission.request.head !== context.head
        )
          fail(
            "Only the current version's approved action may start, once. Reconcile unknown outcomes instead of repeating them.",
          );
        if (unresolvedWrite(state, permission.request))
          fail(
            "An earlier identical write has an unknown outcome; reconcile it instead of repeating it.",
          );
        const clearance = validationCodeClearance(state, context.head);
        if (
          (named !== undefined || !permission.request.preChange) &&
          !clearance?.effects.includes(permission.request.id)
        )
          fail(
            "The reviewer must clear this exact action at the current version before it starts. Without coverage, record a new request without the allowance for review and a card.",
          );
        const scenario = state.scenarios.find((item) => item.id === permission.request.scenario);
        if (!scenario || !sameScenario(permission.scenario, scenario))
          fail("The scenario changed; ask again.");
        if (named !== undefined) {
          const yes = currentAllowance(permission);
          if (!yes) fail(missingAllowance(named));
          permission.yes = yes.card;
          permission.answer = { at: context.at, action: "kept-yes", label: yes.words };
        }
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

/**
 * INF-4497 finding 3: whether a click is the approval of a checklist of
 * several gaps with none of its rows ticked. Such a click accepts nothing,
 * so the card refuses it rather than recording every gap declined.
 */
export function checklistApprovesNothing(
  state: LiveValidation,
  input: { card: string; offer: string; action: string; ticked: readonly string[] },
): boolean {
  const asked = state.permissions.filter(
    (permission) =>
      permission.state === "requested" &&
      permission.decision?.card === input.card &&
      permission.decision.offer === input.offer,
  );
  return (
    asked.length > 1 &&
    asked.some((permission) => permission.decision?.action === input.action) &&
    !asked.some((permission) => input.ticked.includes(permission.request.id))
  );
}

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
    // INF-4446: the captain's yes to a check is kept with their other yeses
    // (`TaskDeliveries.decideLiveValidation`), and the approval rests on it.
    if (accepting && permission.request.kind === "check") permission.yes = input.card;
    next.stateRevision = validationStateRevision(next) + 1;
  }
  return next;
}

/**
 * INF-1824 and INF-3751: a check approval covers the resources and cost per
 * run the captain approved, in the check's own words. It is approved while
 * the current plan declares those words for the check and expired otherwise:
 * a plan that changes them or drops the check expires it, and a plan that
 * declares them again restores it with no new question. Only the captain's
 * own approval is restored: a check ask expires answered only from approved,
 * since an ask whose card ended unanswered expires with no answer. Never past
 * the captain's newer no to the same words. Says whether it changed anything.
 */
function keepCheckApprovals(state: LiveValidation): boolean {
  let changed = false;
  for (const permission of state.permissions) {
    if (permission.request.kind !== "check") continue;
    const scenario = state.scenarios.find((item) => item.id === permission.request.scenario);
    const declared = scenario !== undefined && sameCheckReach(permission.scenario, scenario);
    if (permission.state === "approved" && !declared) {
      permission.state = "expired";
      changed = true;
    } else if (
      permission.state === "expired" &&
      permission.answer &&
      declared &&
      !newerNo(state, permission, permission.answer.at)
    ) {
      permission.state = "approved";
      changed = true;
    }
  }
  return changed;
}

/** The captain declined the same check and words at or after this approval. */
function newerNo(
  state: LiveValidation,
  approval: ValidationPermission,
  approvedAt: number,
): boolean {
  return state.permissions.some(
    (other) =>
      other !== approval &&
      other.state === "declined" &&
      other.request.kind === "check" &&
      other.request.scenario === approval.request.scenario &&
      sameCheckReach(other.scenario, approval.scenario) &&
      (other.answer?.at ?? other.at) >= approvedAt,
  );
}

function unresolvedWrite(
  state: LiveValidation,
  request: Extract<ValidationPermission["request"], { kind: "effect" }>,
): boolean {
  const write = request.forgeWrite;
  return state.permissions.some((other) => {
    if (
      other.request.id === request.id ||
      other.request.kind !== "effect" ||
      (other.state !== "started" && other.state !== "unknown")
    )
      return false;
    const previous = other.request.forgeWrite;
    if (!write) {
      // For a task-side action, match the exact declared action and destination,
      // not an interpretation of the words. Forge writes below bind the bytes.
      return (
        !previous &&
        (request.allowance !== undefined || other.request.allowance !== undefined) &&
        other.request.head === request.head &&
        other.request.action === request.action &&
        other.request.destination === request.destination
      );
    }
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
