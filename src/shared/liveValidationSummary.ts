import { z } from "zod";
import {
  acceptedValidation,
  demonstrated,
  gapPermission,
  LIVE_VALIDATION_WORDS,
  type LiveValidation,
  latestValidationRun,
  validationConsentWords,
  validationEvidenceSchema,
} from "./liveValidation";

/** Result words shared by the record, public table and their keyboard journeys. */
export const LIVE_VALIDATION_RESULT_WORDS = {
  anotherVersion: "Another version",
  exception: "Accepted without live proof",
  passedLive: "Passed live",
  supporting: "Supporting evidence",
  failed: "Failed",
  notRun: "Not run",
} as const;

export const liveValidationSummarySchema = z.object({
  label: z.string(),
  line: z.string().optional(),
  reason: z.string(),
  head: z.string().optional(),
  revision: z.number(),
  /** Optional for readers of records served by an older home. */
  live: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  verdict: z.string().optional(),
  /** Private audit only; never published in forge Markdown. */
  approvals: z
    .array(z.object({ scenario: z.string(), source: z.string(), runs: z.number() }))
    .optional(),
  rows: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      supplementary: z.boolean().optional(),
      result: z.string(),
      reason: z.string(),
      evidence: z.array(validationEvidenceSchema),
    }),
  ),
});
export type LiveValidationSummary = z.infer<typeof liveValidationSummarySchema>;
export function liveValidationSummary(
  state: LiveValidation | undefined,
  head: string | undefined,
  _published: boolean,
): LiveValidationSummary | undefined {
  if (!state) return undefined;
  const run = latestValidationRun(state);
  const acceptance = acceptedValidation(state, head);
  const runsByApproval = new Map<string, number>();
  for (const item of state.runs)
    for (const approval of item.checkApprovals ?? [])
      runsByApproval.set(approval, (runsByApproval.get(approval) ?? 0) + 1);
  const approvals = state.permissions.flatMap((permission) => {
    const { request, scenario } = permission;
    const source = validationConsentWords(permission);
    if (!source || request.kind === "gap" || (request.kind === "effect" && request.head !== head))
      return [];
    return [
      {
        scenario: scenario.action,
        source,
        runs: request.kind === "effect" ? 1 : (runsByApproval.get(request.id) ?? 0),
      },
    ];
  });
  const summary: LiveValidationSummary = {
    ...(approvals.length ? { approvals } : {}),
    label: acceptance.label ?? LIVE_VALIDATION_WORDS.awaiting,
    reason: acceptance.reason,
    live:
      run?.scenarioRevision === state.scenarioRevision
        ? run.observations.filter(demonstrated).length
        : 0,
    total: state.scenarios.length,
    ...(acceptance.ready && run ? { verdict: run.verdict } : {}),
    ...(run ? { head: run.head } : {}),
    revision: run?.revision ?? 0,
    rows: state.scenarios.map((scenario) => {
      const observation =
        run?.scenarioRevision === state.scenarioRevision
          ? run.observations.find((item) => item.scenario === scenario.id)
          : undefined;
      const exception = observation && gapPermission(state, scenario, observation);
      return {
        id: scenario.id,
        action: scenario.action,
        supplementary: scenario.importance === "supplementary",
        result:
          observation && run?.head !== head && !acceptance.ready
            ? LIVE_VALIDATION_RESULT_WORDS.anotherVersion
            : exception
              ? LIVE_VALIDATION_RESULT_WORDS.exception
              : observation?.result === "pass"
                ? observation.live && !observation.unproven.length
                  ? LIVE_VALIDATION_RESULT_WORDS.passedLive
                  : LIVE_VALIDATION_RESULT_WORDS.supporting
                : observation?.result === "fail"
                  ? LIVE_VALIDATION_RESULT_WORDS.failed
                  : LIVE_VALIDATION_RESULT_WORDS.notRun,
        reason: [
          observation?.actual,
          observation?.reason,
          ...(observation?.unproven ?? []).map((gap) => `Unproven: ${gap}`),
          ...(observation?.standIns ?? []).map((standIn) => `Stand-in: ${standIn}`),
        ]
          .filter(Boolean)
          .join("\n"),
        evidence: run?.evidence.filter((item) => observation?.evidence.includes(item.id)) ?? [],
      };
    }),
  };
  if (acceptance.label === LIVE_VALIDATION_WORDS.noSurface) summary.rows = [];
  summary.line = liveValidationLine(summary);
  return summary;
}

/** Shared line for the record, saved story and public description. */
export function liveValidationLine(summary: LiveValidationSummary): string {
  if (
    summary.label === LIVE_VALIDATION_WORDS.noSurface ||
    summary.label === LIVE_VALIDATION_WORDS.awaiting
  )
    return `${summary.label}. ${summary.reason}`;
  return `${summary.label}. ${summary.live ?? 0} of ${summary.total ?? summary.rows.length} scenarios driven live in the product.`;
}
