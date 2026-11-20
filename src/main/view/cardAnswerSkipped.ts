import { CARD_ANSWER_SKIPPED } from "@core/connection/cardCompatibility";
import { listsChange } from "@core/connection/contractChanges";
import { withoutSkipped } from "@shared/cardAnswerLines";

/** Each request whose argument may hold `{ answers }`, by the place of that argument. */
const ANSWERS_AT: Readonly<Record<string, number>> = {
  "inf:cards:act": 3,
  "inf:cards:reply": 1,
};

/**
 * A request as a home can read it: one that does not list the change reads
 * answers strictly and would refuse one marked `skipped`, so the mark is left
 * out there and the Default goes as an answer kept as proposed.
 */
export function skippedAnswersFor(
  channel: string,
  rawArgs: unknown[],
  homeChanges: readonly string[] | null,
): unknown[] {
  const at = ANSWERS_AT[channel];
  if (at === undefined || listsChange(homeChanges, CARD_ANSWER_SKIPPED)) return rawArgs;
  const holder = rawArgs[at];
  if (typeof holder !== "object" || holder === null || !("answers" in holder)) return rawArgs;
  const kept = { ...holder, answers: withoutSkipped(holder.answers) };
  return rawArgs.map((arg, index) => (index === at ? kept : arg));
}
