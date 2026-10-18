/** The Models section's header summary words (`ModelsSection.tsx`). */
export const STARTING_LEVELS_SUMMARY = "no levels chosen - using the starting levels";
export const NOT_IN_USE = "not in use";

/** The Decisions row's menu item that opens the OpenRouter picker, offered while OpenRouter has models. */
export const USE_OPENROUTER_DECISION_MODEL = "Use an OpenRouter decision model";

/** What a pill's × says on rest and in its description: it leaves the other levels alone. */
export function removeFromLevelOnly(level: string): string {
  return `Remove from ${level} only`;
}
