import { z } from "zod";

/**
 * How a crewmate's model was chosen (INF-1714; docs/routing.md, "Why this
 * model"): the comparison its routing decision saved when it was made, never
 * recomputed from today's meters or settings. The task record shows it under
 * Why this model; the crew summary does not.
 */

/** The crew allowance bands, in rank order (`SpendBand`, src/shared/quotaSignals.ts). */
export const crewBandSchema = z.enum(["room", "conserve", "near_floor", "unknown"]);
export type CrewBand = z.infer<typeof crewBandSchema>;

/** What decided the choice, as the routing record saved it. */
export const crewDecidedBySchema = z.enum([
  "named",
  "pinned",
  "band",
  "spend-priority",
  "recency",
  "runway-order",
  "only-candidate",
]);
export type CrewDecidedBy = z.infer<typeof crewDecidedBySchema>;

/** One model the router ranked for the choice, with the reading behind it then. */
export const modelChoiceCandidateSchema = z.object({
  /** The model as `provider/id`, named through the one model-name lookup. */
  model: z.string(),
  picked: z.boolean(),
  band: crewBandSchema.optional(),
  percentRemaining: z.number().optional(),
  /** The score it was ranked by, after placed work where placed work applied. */
  spendPriority: z.number().optional(),
  /** The score before placed work, when placed work changed it. */
  rawSpendPriority: z.number().optional(),
  /** The most allowance, in percentage points, unfinished work was estimated to use. */
  placedWorkPoints: z.number().optional(),
  measuredAt: z.number().optional(),
  resetsAtMs: z.number().optional(),
});
export type ModelChoiceCandidate = z.infer<typeof modelChoiceCandidateSchema>;

/** `TaskDetail.modelChoice`: absent when the decision saved no comparison (before INF-1714). */
export const modelChoiceSchema = z.object({
  decidedBy: crewDecidedBySchema,
  floorPercent: z.number(),
  /** Ranked as the router ranked them: the picked one and those eligible beside it. */
  candidates: z.array(modelChoiceCandidateSchema),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

/** Each allowance band, as the comparison names it. */
export function bandWords(band: CrewBand, floorPercent: number): string {
  switch (band) {
    case "room":
      return "Lasts until its reset";
    case "conserve":
      return "Runs out before its reset";
    case "near_floor":
      return `At ${floorPercent}% or less`;
    default:
      return "No current reading";
  }
}

/** Why a model in a lower band lost, after "which". */
function lowerBandClause(band: CrewBand, floorPercent: number): string {
  switch (band) {
    case "conserve":
      return "was projected to run out before its reset";
    case "near_floor":
      return `had ${floorPercent}% or less left`;
    default:
      return "had no current reading";
  }
}

/**
 * The one sentence on how the allowance decided between models; null where
 * the captain's own choice decided (`modelReasonLine` says that) or nothing
 * was compared.
 */
export function modelChoiceLine(
  choice: ModelChoice,
  modelName: (model: string) => string,
): string | null {
  const picked = choice.candidates.find((candidate) => candidate.picked);
  const runnerUp = choice.candidates.find((candidate) => !candidate.picked);
  const name = picked ? modelName(picked.model) : "It";
  switch (choice.decidedBy) {
    case "band":
      return runnerUp?.band
        ? `${name} had more allowance to spare than ${modelName(runnerUp.model)}, which ${lowerBandClause(runnerUp.band, choice.floorPercent)}.`
        : `${name} had more allowance to spare than the other models.`;
    case "spend-priority":
      return "Of the models with the same allowance outlook, its allowance was the most likely to go unused before its reset.";
    case "recency":
      return "It is the newest model in its line, with the same allowance outlook as the others.";
    case "runway-order":
      return "No model had a current allowance reading, so the usual order decided.";
    case "only-candidate":
      return "It was the only model that could take this work.";
    default:
      return null;
  }
}

/** The task record's Why this model words (INF-1714). */
export const MODEL_WHY_WORDS = {
  summary: "Why this model",
  notRecorded: "Comparison not recorded",
  chosen: "chosen",
  placedWork: (points: number) =>
    `Unfinished work there was estimated at ${points.toFixed(1)} points of its allowance; it orders models with the same outlook, never across outlooks.`,
} as const;
