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

/** The words in a card's field beside a note's own button (`note-done-words.md`). */
export const NOTE_DONE_WORDS = contractChange("note-done-words");

/**
 * Whether a note's press carries words a home cannot read: one that does not
 * list the change refuses the whole request. The press is refused here, so the
 * words stay in the field; leaving them out would lose them.
 */
export function noteWordsUnheard(
  channel: string,
  rawArgs: unknown[],
  homeChanges: readonly string[] | null,
): boolean {
  return (
    channel === "inf:cards:note-done" &&
    rawArgs[2] !== undefined &&
    !listsChange(homeChanges, NOTE_DONE_WORDS)
  );
}
