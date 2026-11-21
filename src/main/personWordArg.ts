/** A word a window launch refused the folder's lock says to the person (./personWord.ts). */
export type PersonWord = "dock" | "once-closed";

/** What starts a program as the copy that shows one word. */
export const PERSON_WORD_ARG = "--infinitary-person-word";

/** The word a program was started to show, or null for any other start. */
export function personWordArg(argv: readonly string[]): PersonWord | null {
  for (const arg of argv) {
    if (arg === `${PERSON_WORD_ARG}=dock`) return "dock";
    if (arg === `${PERSON_WORD_ARG}=once-closed`) return "once-closed";
  }
  return null;
}
