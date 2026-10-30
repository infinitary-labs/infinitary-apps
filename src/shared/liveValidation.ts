import { z } from "zod";

/** Careful's closed facts. Judgment belongs to the builder and reviewer, never a prose parser. */
const words = z.string().trim().min(1).max(4000);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const head = z.string().regex(/^[a-f0-9]{40,64}$/);
const revision = z.number().int().nonnegative();
export const validationVerdictSchema = z
  .enum(["go", "no-go", "inconclusive", "no-surface"])
  .describe(
    "go: live proof; no-go: a failure; inconclusive: missing proof; no-surface: nothing to run.",
  );
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
  unproven: z.array(words).max(20).describe("Gaps inside this boundary; a live pass requires []."),
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
});
export type ValidationRun = z.infer<typeof validationRunSchema>;
export const validationReviewSchema = z.object({
  kind: z.literal("review"),
  head,
  revision,
  code: z.enum(["clear", "findings", "blocked"]),
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
});
export const validationGapSchema = z.object({
  kind: z.literal("gap"),
  id,
  head,
  scenario: id,
  missingCapability: words,
  reason: words.describe(
    "Match the current inconclusive run: scenario untested, not live; safe alternatives exhausted.",
  ),
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
});
export type ValidationPermission = z.infer<typeof validationPermissionSchema>;
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
/** INF-1824: the approval kept on a check, current while it declares the same reach and cost. */
export function checkApproval(
  state: LiveValidation,
  scenario: ValidationScenario,
): ValidationPermission | undefined {
  return state.permissions.find(
    (permission) =>
      permission.state === "approved" &&
      permission.request.kind === "check" &&
      permission.request.scenario === scenario.id &&
      sameCheckReach(permission.scenario, scenario),
  );
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
  const failed = run.observations.some((item) => item.result === "fail");
  if (failed && run.verdict !== "no-go")
    return "An observed failure is no-go, never an exception or a pass.";
  if (
    run.verdict === "no-surface" &&
    run.observations.some(
      (item) =>
        item.result !== "untested" || item.live || item.missingCapability || item.unproven.length,
    )
  )
    return "No running surface contradicts an executed result.";
  if (
    run.verdict === "go" &&
    (run.completion !== "complete" ||
      state.scenarios.length === 0 ||
      state.scenarios.some(
        (scenario) =>
          scenario.importance === "required" &&
          !demonstrated(run.observations.find((item) => item.scenario === scenario.id)!),
      ))
  )
    return "Go requires completed live proof for every required scenario.";
  return undefined;
}
export function acceptedValidation(
  state: LiveValidation | undefined,
  head: string | undefined,
): { ready: boolean; label?: string; reason: string } {
  const run = latestValidationRun(state);
  if (
    !state ||
    !run ||
    !head ||
    run.head !== head ||
    run.scenarioRevision !== state.scenarioRevision
  )
    return { ready: false, reason: "This version needs live validation of the current scenarios." };
  const review = state.reviews.findLast(
    (item) => item.head === head && item.revision === run.revision,
  );
  if (
    !review ||
    review.code !== "clear" ||
    review.coverage !== "complete" ||
    review.omitted.length ||
    review.verdict !== run.verdict
  )
    return {
      ready: false,
      reason: "This version and evidence need an independent review of coverage and proof.",
    };
  if (
    run.completion !== "complete" ||
    run.verdict === "no-go" ||
    run.observations.some((item) => item.result === "fail")
  )
    return {
      ready: false,
      reason: "Interrupted, unknown or failed validation cannot be accepted.",
    };
  if (run.verdict === "no-surface")
    return { ready: true, label: LIVE_VALIDATION_WORDS.noSurface, reason: review.reason };
  let exception = false;
  for (const scenario of state.scenarios) {
    const observation = run.observations.find((item) => item.scenario === scenario.id);
    if (!observation) return { ready: false, reason: "A scenario has no observation." };
    if (scenario.importance === "supplementary" || demonstrated(observation)) continue;
    if (!gapPermission(state, scenario, observation))
      return {
        ready: false,
        reason: "Required proof is missing without the captain's exception for this specific gap.",
      };
    exception = true;
  }
  if (!state.scenarios.length)
    return {
      ready: false,
      reason: "An empty scenario set needs an accepted no-running-surface reason.",
    };
  return {
    ready: true,
    label: exception ? LIVE_VALIDATION_WORDS.exception : LIVE_VALIDATION_WORDS.demonstrated,
    reason: review.reason,
  };
}
