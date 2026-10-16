import { z } from "zod";

/**
 * The reasoning a crewmate's session opened at (FI3-439), as its backend
 * served it: the level after the model's offered levels capped it and Quick
 * care stepped it down, `off` for a model that does not reason, and
 * `default` where the app sets none and the model keeps its own (the Claude
 * client offers no effort on Haiku). `lower` says why it sits below the
 * level the routing table asked for (`docs/routing.md`, "Reasoning effort").
 */
export const reasoningSchema = z.object({
  level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "default"]),
  lower: z.enum(["quick", "capped"]).optional(),
});
export type Reasoning = z.infer<typeof reasoningSchema>;

const LEVEL_WORD: Record<Reasoning["level"], string> = {
  off: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  default: "Model's own",
};

/** The summary's word for a reasoning level ("Extra high"). */
export function reasoningWord(reasoning: Reasoning): string {
  return LEVEL_WORD[reasoning.level];
}

/** Why the reasoning sits below what its level asks, as one sentence; null when it does not. */
export function reasoningNote(reasoning: Reasoning): string | null {
  if (reasoning.lower === "quick") return "Reasoning one step lower for Quick care.";
  if (reasoning.lower === "capped") return "Reasoning at the most this model offers.";
  return null;
}
