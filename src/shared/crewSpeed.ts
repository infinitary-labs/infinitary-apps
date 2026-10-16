import { z } from "zod";

/** Speed is separate from intelligence, reasoning, account choice and care. */
export const crewSpeedSchema = z.enum(["standard", "fast", "ultrafast"]);
export type CrewSpeed = z.infer<typeof crewSpeedSchema>;
export const CREW_SPEEDS: readonly CrewSpeed[] = ["standard", "fast", "ultrafast"];
export const SPEED_NAMES: Record<CrewSpeed, string> = {
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};
export const SPEED_ALLOWANCE_WARNING =
  "Ultrafast uses 8× your plan’s allowance or 6× purchased credits. Fast uses 2.5× allowance or 2× credits.";
export const SPEED_SCOPE =
  "Crew work and its conversation summaries only. Your first mate and Decisions stay Standard.";
export const speedSelectionSchema = z.object({
  requested: crewSpeedSchema,
  sent: crewSpeedSchema,
  /** Only a provider reply can confirm service. */
  confirmed: z.string().optional(),
  reason: z.string().optional(),
});
export type SpeedSelection = z.infer<typeof speedSelectionSchema>;

export function speedNote(
  model: { provider: string; id: string; name?: string },
  selection: SpeedSelection,
): string {
  const lead = `${model.name ?? "Crew speed"}: ${SPEED_NAMES[selection.requested]} requested`;
  const confirmation = selection.confirmed
    ? ` Provider confirmed ${selection.confirmed === "default" ? "Standard" : selection.confirmed === "priority" ? "Fast" : selection.confirmed === "ultrafast" ? "Ultrafast" : selection.confirmed}.`
    : "";
  if (selection.reason)
    return `${lead}. Using Standard on the same model and account because ${selection.reason}.${confirmation}`;
  return selection.confirmed
    ? `${lead}.${confirmation}`
    : `${lead}; ${SPEED_NAMES[selection.sent]} sent, not yet confirmed by the provider.`;
}
