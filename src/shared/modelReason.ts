import { z } from "zod";
import { levelModels } from "./levelWords";
import { slotSchema } from "./modelSlots";
import { type Reasoning, reasoningNote } from "./reasoning";
import { ruleIdSchema } from "./routingPolicy";

/**
 * Why a crewmate runs on its model, as its routing decision recorded it
 * (`docs/routing.md`): the rule that answered, the slot it asked for and the
 * slot that served, with the few typed facts a rule's line names. The
 * decision's reason prose stays in the ledger and is never read for this;
 * `modelReasonLine` is the one wording.
 */
export const modelReasonSchema = z.object({
  rule: ruleIdSchema,
  asked: slotSchema,
  served: slotSchema,
  /** R2: the kind the rule read. */
  kind: z.enum(["plan", "research", "reproduce", "review"]).optional(),
  /** R4, R6: the key of the verified basis. */
  basis: z.string().optional(),
  /** R1b: the key of the attempt the captain rejected. */
  escalatedFrom: z.string().optional(),
  /** A review: the key of the builder whose change it reads. */
  reviewOf: z.string().optional(),
  /** R9: another provider than the builder's serves the review. */
  elsewhere: z.boolean().optional(),
  /** R0: the served model is the one the captain named. */
  named: z.boolean().optional(),
  /** The served model is pinned in Settings, which outranks every slot. */
  pinned: z.boolean().optional(),
});
export type ModelReason = z.infer<typeof modelReasonSchema>;

/** What the rule read about the work, in the captain's words; null when the record cannot say. */
function workOf(reason: ModelReason): string | null {
  switch (reason.rule) {
    case "R1b":
      return reason.escalatedFrom
        ? `a stronger model after ${reason.escalatedFrom} fell short`
        : "a stronger model after an earlier attempt fell short";
    case "R2":
      if (reason.kind === "plan") return "planning";
      if (reason.kind === "research") return "research";
      if (reason.kind === "reproduce") return "reproducing a bug";
      if (reason.kind === "review")
        return reason.reviewOf ? `reviewing ${reason.reviewOf}` : "reviewing";
      return null;
    case "R3":
      return "building with no plan to follow yet";
    case "R4":
      return reason.basis ? `building from the plan in ${reason.basis}` : "building from a plan";
    case "R5":
      return "fixing a bug not yet reproduced";
    case "R6":
      return reason.basis
        ? `fixing a bug already reproduced in ${reason.basis}`
        : "fixing a bug already reproduced";
    case "R12":
      return "operation";
    case "R10":
      return "looking up or explaining from what is here";
    case "R7":
      return "simple upkeep";
    case "R8":
      return "the kind of work was unclear";
    case "R9": {
      const review = reason.reviewOf ? `reviewing ${reason.reviewOf}` : "reviewing";
      return reason.elsewhere ? `${review}, away from the builder's provider` : review;
    }
    default:
      return null;
  }
}

/**
 * Why a crewmate runs on its model, in the captain's words (FI3-427). What
 * chose the model outranks what chose its level: a model the captain named
 * or pinned, then a level that could not serve, then the rule's own reason.
 * The level itself is never in the line: the summary shows it on its own,
 * beside the reasoning (FI3-439), so a bare "High" never stands for either.
 */
export function modelReasonLine(reason: ModelReason): string | null {
  if (reason.rule === "R0" && reason.named) return "You asked for this model";
  if (reason.pinned) return "You pinned this model in Settings";
  if (reason.rule === "R0") return "The model you named was not available";
  if (reason.served !== reason.asked)
    return `None of your ${levelModels(reason.asked)} could take it`;
  if (reason.rule === "R1a") return "You asked for premium";
  const work = workOf(reason);
  return work ? `${work.charAt(0).toUpperCase()}${work.slice(1)}` : null;
}

/**
 * The summary's footnote under a crewmate's model, level and reasoning
 * (FI3-439): why the model, then why the reasoning sits below what its level
 * asks, as two sentences when there are both; null when neither is known.
 */
export function modelFootnote(
  reason: ModelReason | undefined,
  reasoning: Reasoning | undefined,
): string | null {
  const why = reason ? modelReasonLine(reason) : null;
  const lower = reasoning ? reasoningNote(reasoning) : null;
  if (why && lower) return `${why}. ${lower}`;
  return why ?? lower;
}
