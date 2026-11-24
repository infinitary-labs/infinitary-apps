import { z } from "zod";
import { STANDING_WORDS_FROM } from "./holds";
import { reviewFindingSchema, reviewRiskSchema } from "./rigor";

/** Careful's closed facts. Judgment belongs to the builder and reviewer, never a prose parser. */
const words = z.string().trim().min(1).max(4000);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const head = z.string().regex(/^[a-f0-9]{40,64}$/);
const revision = z.number().int().nonnegative();
/** What each verdict means is said once, in the Careful prompt every builder and reviewer is served. */
export const validationVerdictSchema = z.enum(["go", "no-go", "inconclusive", "no-surface"]);
export const validationScenarioSchema = z.object({
  id,
  source: words,
  importance: z.enum(["required", "supplementary"]),
  action: words,
  expected: words,
  adverse: words,
  environment: words,
  signal: words,
  /** The actual product, service or device the claim requires. */
  boundary: words,
  /**
   * INF-1824: what a run uses or reaches that needs the captain's consent, in
   * the check's own words. Declared, a run of this check needs its approval.
   */
  resources: words.optional(),
  /** What one run of this check costs; an approval covers runs that fit it. */
  cost: words.optional(),
});
export type ValidationScenario = z.infer<typeof validationScenarioSchema>;
export const validationObservationSchema = z.object({
  scenario: id,
  result: z.enum(["pass", "fail", "untested"]),
  live: z.boolean(),
  actual: words,
  evidence: z.array(id).max(32),
  standIns: z.array(words).max(20),
  unproven: z.array(words).max(20),
  attempted: z.array(words).max(20),
  missingCapability: words.optional(),
  reason: words.optional(),
});
export type ValidationObservation = z.infer<typeof validationObservationSchema>;
export const validationEvidenceSourceSchema = z.object({
  id,
  path: words,
  description: words,
  /** A recording's still frame, checked by the existing card-media owner. */
  poster: words.optional(),
});
export const validationEvidenceSchema = z.object({
  id,
  description: words,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  file: z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpg|webp|mp4|gif|txt|json|log)$/),
  /** An immutable text excerpt or rendered attachment, not the original mutable path. */
  text: z
    .string()
    .max(1024 * 1024)
    .optional(),
  picture: z.string().optional(),
  media: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
  posterFile: z.string().optional(),
  posterDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;
const runFields = {
  kind: z.literal("run"),
  id,
  head,
  scenarioRevision: revision,
  completion: z.enum(["complete", "interrupted", "unknown"]),
  verdict: validationVerdictSchema,
  reason: words,
  observations: z.array(validationObservationSchema).max(100),
};
export const validationRunInputSchema = z.object({
  ...runFields,
  evidence: z.array(validationEvidenceSourceSchema).max(32),
});
export const validationRunSchema = z.object({
  ...runFields,
  evidence: z.array(validationEvidenceSchema).max(32),
  revision,
  deviceId: z.string().nullable(),
  at: z.number(),
  /** Check request ids that actually authorized this run, kept for the private audit. */
  checkApprovals: z.array(id).optional(),
});
export type ValidationRun = z.infer<typeof validationRunSchema>;
export const validationReviewSchema = z.object({
  kind: z.literal("review"),
  head,
  revision,
  code: z.enum(["clear", "findings", "blocked"]),
  /** The findings the code judgment rests on (INF-1875): the verdict is this record, never a line of the report. */
  findings: z.array(reviewFindingSchema).max(100).optional(),
  /** The reviewer's risk of merging the change as it stands, recorded beside the checks and never a hold. */
  risk: z.object({ level: reviewRiskSchema, why: words }).optional(),
  coverage: z.enum(["complete", "missing"]),
  coverageReason: words,
  effects: z.array(id).max(100),
  omitted: z.array(words).max(100),
  verdict: validationVerdictSchema,
  reason: words,
});
export type ValidationReview = z.infer<typeof validationReviewSchema>;
export const validationForgeWriteSchema = z.object({
  host: z.string().min(1).max(255),
  method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
  path: z.string().min(1).max(4096),
  /** SHA-256 of the exact JSON body bytes, absent only when the call has no body. */
  bodyDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ValidationForgeWrite = z.infer<typeof validationForgeWriteSchema>;
export const validationEffectSchema = z.object({
  kind: z.literal("effect"),
  id,
  head,
  scenario: id,
  action: words,
  destination: words,
  audience: words,
  visibility: z.enum(["captain-only", "others", "uncertain"]),
  persistent: z.boolean(),
  purpose: words,
  lastingEffects: words,
  cleanup: words,
  access: words,
  /** A reproduction before the first edit has no changed code to clear. */
  preChange: z.boolean(),
  /** Only a task's own PR needed to obtain proof; never permits merge or marks proof accepted. */
  prerequisitePublication: z.boolean(),
  publication: z.object({ repoId: id, branch: words }).optional(),
  /** A declared forge write is bound to the exact call sent, not merely a permission id. */
  forgeWrite: validationForgeWriteSchema.optional(),
  /** Current consent to use after exact independent review: direction id, standing, or a kept yes card. */
  allowance: z.string().min(1).max(200).optional(),
});
export const validationGapSchema = z.object({
  kind: z.literal("gap"),
  id,
  head,
  scenario: id,
  missingCapability: words,
  reason: words,
  alternatives: z
    .array(z.object({ attempted: words, result: words }))
    .min(1)
    .max(20),
  remedies: z.array(words).min(1).max(20),
});
/**
 * INF-1824: one approval of a check's declared resources and cost per run,
 * kept by the check's id for every later run and version of the task while
 * the check declares the same resources and cost.
 */
export const validationCheckSchema = z.object({
  kind: z.literal("check"),
  id,
  head,
  scenario: id,
  /**
   * INF-4446: the yes on the task's Already allowed list that the crewmate
   * judged covers the check's declared resources and cost per run: a kept
   * yes's card, `standing` for the captain's standing override, or a `d:` direction id. The
   * approval rests on that yes, with no new card, while it stands.
   */
  allowance: z.string().min(1).max(200).optional(),
});
export const validationRequestSchema = z.discriminatedUnion("kind", [
  validationEffectSchema,
  validationGapSchema,
  validationCheckSchema,
]);
export type ValidationRequest = z.infer<typeof validationRequestSchema>;
export const validationPlanSchema = z.object({
  kind: z.literal("plan"),
  /** Compare-and-set, including zero for a task's first scenario set. */
  previousRevision: revision,
  reason: words,
  scenarios: z.array(validationScenarioSchema).max(100),
});
export const validationDecisionSchema = z.object({
  kind: z.literal("decision"),
  request: id,
  /** An already emitted ordinary decision on this task; only its exact chrome choice grants permission. */
  card: z.string().min(1).max(200),
  action: id,
});
export const validationEffectStateSchema = z.object({
  kind: z.literal("effect-state"),
  request: id,
  state: z.enum(["started", "succeeded", "failed", "unknown"]),
  evidence: words,
});
export const liveValidationInputSchema = z.discriminatedUnion("kind", [
  validationPlanSchema,
  validationRunInputSchema,
  validationReviewSchema,
  z.object({ kind: z.literal("request"), request: validationRequestSchema }),
  validationEffectStateSchema,
]);
export type LiveValidationInput = z.infer<typeof liveValidationInputSchema>;
export const keptValidationInputSchema = z.discriminatedUnion("kind", [
  validationPlanSchema,
  z.object({ ...runFields, evidence: z.array(validationEvidenceSchema).max(32) }),
  validationReviewSchema,
  z.object({ kind: z.literal("request"), request: validationRequestSchema }),
  validationDecisionSchema,
  validationEffectStateSchema,
]);
export type KeptValidationInput = z.infer<typeof keptValidationInputSchema>;

export const validationPermissionSchema = z.object({
  request: validationRequestSchema,
  scenario: validationScenarioSchema,
  state: z.enum([
    "requested",
    "approved",
    "declined",
    "expired",
    "started",
    "succeeded",
    "failed",
    "unknown",
  ]),
  at: z.number(),
  decision: z
    .object({
      card: z.string(),
      offer: z.string(),
      action: z.string(),
      lifecycle: z.string().optional(),
    })
    .optional(),
  answer: z.object({ at: z.number(), action: z.string(), label: z.string() }).optional(),
  outcome: words.optional(),
  /** Source of the approval, once granted: a kept card, standing override, or project direction. */
  yes: z.string().min(1).max(200).optional(),
  /** The named source as of the request, never rebound to later words under the same id. */
  allowanceSnapshot: z
    .object({ at: z.number(), revision: z.number().int().positive().optional() })
    .optional(),
});
export type ValidationPermission = z.infer<typeof validationPermissionSchema>;
/** Private audit words; the allowance id remains in the typed record. */
export function validationConsentWords(permission: ValidationPermission): string | undefined {
  const { yes, answer } = permission;
  if (!yes) return undefined;
  const kind = yes.startsWith("d:")
    ? "Your standing direction"
    : yes === STANDING_WORDS_FROM
      ? "Your standing reply"
      : "Your yes on a card";
  return answer?.label ? `${kind}: “${answer.label}”` : kind;
}

export const liveValidationSchema = z.object({
  /** Changes to facts a reviewer reads, excluding judgments themselves. Older records start at zero. */
  stateRevision: revision.optional(),
  scenarioRevision: revision,
  scenarios: z.array(validationScenarioSchema),
  plans: z.array(
    z.object({
      revision,
      reason: words,
      scenarios: z.array(validationScenarioSchema),
      at: z.number(),
    }),
  ),
  runs: z.array(validationRunSchema),
  reviews: z.array(
    validationReviewSchema.extend({
      reviewer: z.string(),
      stateRevision: revision.optional(),
      at: z.number(),
      scenarioRevision: revision,
    }),
  ),
  permissions: z.array(validationPermissionSchema),
});
export type LiveValidation = z.infer<typeof liveValidationSchema>;
/** INF-1824: the host-drawn checklist's field, whose ticked values are the gaps the captain accepts. */
export const VALIDATION_GAPS_FIELD = "inf-accepted-gaps";
export const LIVE_VALIDATION_WORDS = {
  demonstrated: "Demonstrated for this version",
  noSurface: "No running surface",
  exception: "Proceeding without live proof",
  awaiting: "Awaiting live validation",
} as const;
export const emptyValidation = (): LiveValidation => ({
  scenarioRevision: 0,
  scenarios: [],
  plans: [],
  runs: [],
  reviews: [],
  permissions: [],
});
export const latestValidationRun = (state: LiveValidation | undefined) => state?.runs.at(-1);
export const validationRevision = (state: LiveValidation | undefined) =>
  latestValidationRun(state)?.revision ?? 0;
export const validationStateRevision = (state: LiveValidation | undefined) =>
  state?.stateRevision ?? 0;
export function validationAssignment(state: LiveValidation | undefined, head: string) {
  return {
    head,
    revision: validationRevision(state),
    scenarioRevision: state?.scenarioRevision ?? 0,
    stateRevision: validationStateRevision(state),
    effects:
      state?.permissions
        .filter((item) => item.request.kind === "effect")
        .map((item) => item.request.id) ?? [],
  };
}
export const validationPair = (head: string, revision: number) => `${head}:${revision}`;
export function sameScenario(a: ValidationScenario, b: ValidationScenario): boolean {
  return (Object.keys(validationScenarioSchema.shape) as (keyof ValidationScenario)[]).every(
    (key) => a[key] === b[key],
  );
}
export function demonstrated(observation: ValidationObservation): boolean {
  return observation.result === "pass" && observation.live && observation.unproven.length === 0;
}
/**
 * INF-1824: an accepted gap is kept by the check's id through rewording,
 * plan changes and later versions; it ends only when that check runs and
 * fails or leaves the list of checks (`recordValidation`).
 */
export function acceptedGap(
  state: LiveValidation,
  scenario: string,
): ValidationPermission | undefined {
  return state.permissions.find(
    (permission) =>
      permission.state === "approved" &&
      permission.request.kind === "gap" &&
      permission.request.scenario === scenario,
  );
}
export function gapPermission(
  state: LiveValidation,
  scenario: ValidationScenario,
  observation: ValidationObservation,
): ValidationPermission | undefined {
  return observation.result === "untested" ? acceptedGap(state, scenario.id) : undefined;
}
/** The same resources and cost per run, which is all a check approval covers. */
export function sameCheckReach(a: ValidationScenario, b: ValidationScenario): boolean {
  return a.resources === b.resources && a.cost === b.cost;
}
/**
 * INF-1824: the approval kept on a check, current while it declares the same
 * reach and cost. INF-4446: and while the yes it rests on is still on the
 * task's Already allowed list (`kept`, the captain's yeses by card and when
 * each was given), so taking that yes back, or replacing it, ends it.
 */
export type ValidationAllowance = { card: string; at: number; revision?: number };

export function checkApproval(
  state: LiveValidation,
  scenario: ValidationScenario,
  kept: readonly ValidationAllowance[] = [],
): ValidationPermission | undefined {
  return state.permissions.find(
    (permission) =>
      permission.state === "approved" &&
      permission.request.kind === "check" &&
      permission.request.scenario === scenario.id &&
      sameCheckReach(permission.scenario, scenario) &&
      (permission.yes === undefined ||
        kept.some(
          (entry) =>
            entry.card === permission.yes &&
            entry.at === permission.answer?.at &&
            entry.revision === permission.allowanceSnapshot?.revision,
        )),
  );
}
/**
 * INF-4446: what a yes on a check's own approval card covers, as the one
 * record of the captain's yeses keeps it: the check's declared resources and
 * the cost of one run, the words its card showed.
 */
export function checkYesCovers(scenario: ValidationScenario): string {
  return `Runs of the check "${scenario.action}" that use only "${scenario.resources ?? ""}" and cost no more than "${scenario.cost ?? ""}" each`;
}
/** Closed contradictions, not a judgment of whether the evidence proves the claim. */
export function checkValidationRun(
  state: LiveValidation,
  run: Pick<
    ValidationRun,
    "scenarioRevision" | "observations" | "evidence" | "verdict" | "completion"
  >,
): string | undefined {
  if (run.scenarioRevision !== state.scenarioRevision)
    return "The scenario set changed; run the current scenarios.";
  const ids = new Set(state.scenarios.map((scenario) => scenario.id));
  if (
    run.observations.length !== ids.size ||
    new Set(run.observations.map((item) => item.scenario)).size !== ids.size ||
    run.observations.some((item) => !ids.has(item.scenario))
  )
    return "Record one observation for every scenario, including ones that could not run.";
  const evidence = new Set(run.evidence.map((item) => item.id));
  if (evidence.size !== run.evidence.length) return "Evidence identities must be unique.";
  for (const observation of run.observations) {
    if (observation.evidence.some((ref) => !evidence.has(ref)))
      return "An observation names evidence that was not kept.";
    if (observation.result !== "untested" && observation.evidence.length === 0)
      return "An executed result needs kept evidence.";
    if (
      observation.result === "untested" &&
      (observation.live || !observation.reason || observation.attempted.length === 0)
    )
      return "An untested scenario needs attempted alternatives and a reason, never a live label.";
  }
  return verdictContradiction(run.verdict, run, state.scenarios);
}
/** The required scenarios a run holds no live proof of, an accepted gap's among them. */
export function unprovenRequired(
  run: Pick<ValidationRun, "observations">,
  scenarios: readonly ValidationScenario[],
): ValidationScenario[] {
  return scenarios.filter((scenario) => {
    if (scenario.importance !== "required") return false;
    const observation = run.observations.find((item) => item.scenario === scenario.id);
    return !observation || !demonstrated(observation);
  });
}
/**
 * The verdicts a run's own observations rule out: closed contradictions,
 * not a judgment of whether the evidence proves the claim. The run and
 * every review of it obey them alike (INF-3664), so a review never records
 * a verdict its run could not carry, which acceptance would refuse as a
 * mismatch: a gap the captain accepted is still missing proof, so its run
 * and its review stay inconclusive.
 */
export function verdictContradiction(
  verdict: ValidationRun["verdict"],
  run: Pick<ValidationRun, "observations" | "completion">,
  scenarios: readonly ValidationScenario[],
): string | undefined {
  if (verdict !== "no-go" && run.observations.some((item) => item.result === "fail"))
    return "An observed failure is no-go, never an exception or a pass.";
  if (
    verdict === "no-surface" &&
    run.observations.some(
      (item) =>
        item.result !== "untested" || item.live || item.missingCapability || item.unproven.length,
    )
  )
    return "No running surface contradicts an executed result.";
  if (
    verdict === "go" &&
    (run.completion !== "complete" ||
      scenarios.length === 0 ||
      unprovenRequired(run, scenarios).length > 0)
  )
    return "Go requires completed live proof for every required scenario.";
  return undefined;
}
/** The scenarios a run was recorded against: its own plan revision, which a later plan may have replaced. */
export function scenariosOfRun(
  state: LiveValidation,
  run: Pick<ValidationRun, "scenarioRevision">,
): ValidationScenario[] {
  return (
    state.plans.find((plan) => plan.revision === run.scenarioRevision)?.scenarios ?? state.scenarios
  );
}
/**
 * Whether a review leaves no coverage missing (INF-3883). A required
 * scenario the run left untested under the captain's accepted gap is not
 * omitted coverage: the captain's consent is the typed fact, so a review
 * whose only omissions are exactly such scenarios' ids still covers the
 * change. The gap stays missing proof and acceptance shows it as an
 * exception. Coverage missing with no omission named stays incomplete: the
 * app never reads the reviewer's reason.
 */
function reviewCovers(
  state: LiveValidation,
  review: ValidationReview,
  run: ValidationRun,
): boolean {
  if (review.coverage === "complete" && !review.omitted.length) return true;
  return (
    review.omitted.length > 0 &&
    review.omitted.every((omitted) => {
      const scenario = state.scenarios.find((item) => item.id === omitted);
      const observation = run.observations.find((item) => item.scenario === omitted);
      return (
        scenario?.importance === "required" &&
        observation !== undefined &&
        gapPermission(state, scenario, observation) !== undefined
      );
    })
  );
}
/**
 * Which part of a review holds acceptance, and who supplies it (INF-3717
 * piece 1): a refusal names the one thing missing, never the whole rule.
 */
function reviewGap(
  state: LiveValidation,
  review: ValidationReview | undefined,
  run: ValidationRun,
): { missing: string; by: ValidationSupplier } {
  if (!review)
    return {
      missing: `No independent review of run ${run.revision} at this version is recorded; the reviewer supplies it, through the first mate.`,
      by: "reviewer",
    };
  if (review.code !== "clear")
    return {
      missing: `The review at this version did not clear the code (code: ${review.code}); the crewmate answers its findings and the reviewer reviews again.`,
      by: "crewmate",
    };
  if (!reviewCovers(state, review, run))
    return {
      missing: `The review at this version found coverage incomplete${review.omitted.length ? ` (omitted: ${review.omitted.join("; ")})` : ""}: ${review.coverageReason} The crewmate covers it and the reviewer reviews again.`,
      by: "crewmate",
    };
  return {
    missing: `The review's verdict (${review.verdict}) differs from the run's (${run.verdict}); the reviewer re-reads the run and records the verdict it supports, or the crewmate runs the scenarios again.`,
    by: "reviewer",
  };
}

/**
 * Who supplies the part of acceptance that is missing (INF-3717 piece 2):
 * the crewmate's own run or fix, or the independent reviewer reached
 * through the first mate.
 */
export type ValidationSupplier = "crewmate" | "reviewer";
/**
 * Proof accepted at a version (INF-2672): the latest run of the current
 * scenarios, judged by an independent review at that version. The run may
 * sit at an earlier version: a review at this version that judged it is
 * the reviewer's typed word that the difference since reaches none of its
 * scenarios, so a wording commit keeps the proof already run.
 */
export function acceptedValidation(
  state: LiveValidation | undefined,
  head: string | undefined,
): {
  ready: boolean;
  label?: string;
  reason: string;
  missing?: string;
  by?: ValidationSupplier;
} {
  const run = latestValidationRun(state);
  if (!state || !run || !head || run.scenarioRevision !== state.scenarioRevision)
    return {
      ready: false,
      reason: "This version needs live validation of the current scenarios.",
      missing: !run
        ? "No live validation run is recorded; the crewmate runs the current scenarios and records the run."
        : "The latest run does not cover the current scenarios; the crewmate runs them and records the run.",
      by: "crewmate",
    };
  const review = state.reviews.findLast(
    (item) => item.head === head && item.revision === run.revision,
  );
  if (!review && run.head !== head)
    return {
      ready: false,
      reason:
        "This version needs live validation of the current scenarios, or an independent review that the earlier run still reaches it.",
      missing:
        "The latest run is at another version and no review at this version judged it; the crewmate runs the scenarios again, or the reviewer reviews that the earlier run still reaches this version.",
      by: "crewmate",
    };
  if (
    !review ||
    review.code !== "clear" ||
    !reviewCovers(state, review, run) ||
    review.verdict !== run.verdict
  )
    return {
      ready: false,
      reason: "This version and evidence need an independent review of coverage and proof.",
      ...reviewGap(state, review, run),
    };
  if (
    run.completion !== "complete" ||
    run.verdict === "no-go" ||
    run.observations.some((item) => item.result === "fail")
  )
    return {
      ready: false,
      reason: "Interrupted, unknown or failed validation cannot be accepted.",
      missing: `The latest run is ${run.completion !== "complete" ? run.completion : run.verdict === "no-go" ? "no-go" : "a failure"}; the crewmate fixes the cause and runs the scenarios again.`,
      by: "crewmate",
    };
  if (run.verdict === "no-surface")
    return { ready: true, label: LIVE_VALIDATION_WORDS.noSurface, reason: review.reason };
  let exception = false;
  for (const scenario of state.scenarios) {
    const observation = run.observations.find((item) => item.scenario === scenario.id);
    if (!observation)
      return {
        ready: false,
        reason: "A scenario has no observation.",
        missing: `Scenario ${scenario.id} has no observation in the latest run; the crewmate runs it.`,
        by: "crewmate",
      };
    if (scenario.importance === "supplementary" || demonstrated(observation)) continue;
    if (!gapPermission(state, scenario, observation))
      return {
        ready: false,
        reason: "Required proof is missing without the captain's exception for this specific gap.",
        missing: `Scenario ${scenario.id} has no live proof and no exception for its gap; the crewmate drives it live, or asks the captain for an exception.`,
        by: "crewmate",
      };
    exception = true;
  }
  if (!state.scenarios.length)
    return {
      ready: false,
      reason: "An empty scenario set needs an accepted no-running-surface reason.",
      missing:
        "No scenario is planned and no run says there is no running surface; the crewmate plans scenarios or records a no-surface run for review.",
      by: "crewmate",
    };
  return {
    ready: true,
    label: exception ? LIVE_VALIDATION_WORDS.exception : LIVE_VALIDATION_WORDS.demonstrated,
    reason: review.reason,
  };
}

/** The run a recorded proof waits for a reader at, and the version it proves. */
export type ProofAwaitingReader = { run: number; head: string };

/**
 * The proof that waits for an independent reader (INF-6536 finding 3):
 * acceptance at the version the task last recorded validation for, or at
 * the latest run's own version while it has recorded none, names the reviewer as what is
 * missing. Whether a review is open to read it is the caller's typed fact.
 */
export function proofAwaitingReader(
  state: LiveValidation | undefined,
  head: string | undefined,
): ProofAwaitingReader | undefined {
  const run = latestValidationRun(state);
  if (!run) return undefined;
  const at = head ?? run.head;
  const acceptance = acceptedValidation(state, at);
  return !acceptance.ready && acceptance.by === "reviewer"
    ? { run: run.revision, head: at }
    : undefined;
}
