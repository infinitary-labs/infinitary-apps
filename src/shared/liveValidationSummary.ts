import { z } from "zod";
import {
  acceptedValidation,
  gapPermission,
  LIVE_VALIDATION_WORDS,
  type LiveValidation,
  latestValidationRun,
  validationEvidenceSchema,
} from "./liveValidation";

export const liveValidationSummarySchema = z.object({
  label: z.string(),
  reason: z.string(),
  head: z.string().optional(),
  revision: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
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
  published: boolean,
): LiveValidationSummary | undefined {
  if (!state) return undefined;
  const run = latestValidationRun(state);
  const acceptance = acceptedValidation(state, head);
  const early =
    published &&
    state.permissions.some(
      (item) =>
        item.request.kind === "effect" &&
        item.request.prerequisitePublication &&
        item.request.head === head &&
        ["started", "succeeded", "unknown"].includes(item.state),
    );
  return {
    label: acceptance.label ?? (early ? LIVE_VALIDATION_WORDS.awaiting : ""),
    reason: acceptance.reason,
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
        result:
          observation && run?.head !== head
            ? "Another version"
            : exception
              ? "Your exception"
              : observation?.result === "pass"
                ? observation.live && !observation.unproven.length
                  ? "Passed live"
                  : "Supporting evidence"
                : observation?.result === "fail"
                  ? "Failed"
                  : "Not exercised",
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
}
