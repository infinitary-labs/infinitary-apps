import { contractChange, listsChange } from "@core/connection/contractChanges";

/** What pressed a card's button, beside the press (`card-press-input.md`). */
export const CARD_PRESS_INPUT = contractChange("card-press-input");

/** Each request whose submission may carry `input`, by the place of that argument. */
const SUBMISSION_AT: Readonly<Record<string, number>> = {
  "inf:cards:act": 4,
  "inf:cards:note-done": 1,
};

/**
 * A request as a home can read it: one that does not list the change reads
 * the submission strictly and would take one with `input` as unreadable, so
 * the input is left out there and the press goes as it did before.
 */
export function pressInputFor(
  channel: string,
  rawArgs: unknown[],
  homeChanges: readonly string[] | null,
): unknown[] {
  const at = SUBMISSION_AT[channel];
  if (at === undefined || listsChange(homeChanges, CARD_PRESS_INPUT)) return rawArgs;
  const submission = rawArgs[at];
  if (typeof submission !== "object" || submission === null || !("input" in submission))
    return rawArgs;
  const { input: _input, ...kept } = submission;
  return rawArgs.map((arg, index) => (index === at ? kept : arg));
}
