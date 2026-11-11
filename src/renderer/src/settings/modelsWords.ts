/** The Models section's header summary words (`ModelsSection.tsx`). */
export const STARTING_LEVELS_SUMMARY = "no levels chosen - using the starting levels";
export const NOT_IN_USE = "not in use";

/** The Decisions row's menu item that opens the OpenRouter picker, offered while OpenRouter has models. */
export const USE_OPENROUTER_DECISION_MODEL = "Use an OpenRouter decision model";

/** The consent dialog's rows for a decision model's approval, in the order `DecisionConsentText` holds them. */
export const DECISION_DISCLOSURE_LABELS = ["Shared", "Your choice", "Cost"] as const;

/** The Decisions group's Uses list (`src/shared/decisionUses.ts`), also read by its keyboard journey. */
export const DECISION_USES_WORDS = {
  group: "Uses",
  locked: "Always on: Infinitary needs it to work.",
  /** Under a use the answering model's approval predates. */
  needsApproval: (model: string) => `Turning it on asks your OK for ${model} once.`,
  /** The consent dialog's title for that one-time OK, quoting the use's name as Settings shows it. */
  allowTitle: (use: string, model: string) => `Allow “${use}” with ${model}`,
  allow: "Allow",
  turnOn: "Turn on",
} as const;

/** What a pill's × says on rest and in its description: it leaves the other levels alone. */
export function removeFromLevelOnly(level: string): string {
  return `Remove from ${level} only`;
}
