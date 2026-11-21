/** A word a window launch refused the folder's lock says to the person (./personWord.ts). */
export type PersonWord = "dock" | "once-closed";

/**
 * How many buttons each word's box has (`personWordBox`): the Dock word's one, which Electron draws
 * when a box names none, and the question's Leave it and Open here.
 */
export const WORD_BUTTONS: Readonly<Record<PersonWord, number>> = { dock: 1, "once-closed": 2 };

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

/** What the copy says back: the button the person pressed, or that its box was never shown. */
export type PersonReply = number | "unshown";

/** The one line the copy writes for its reply (`readReply`). */
export function replyLine(reply: PersonReply): string {
  return reply === "unshown" ? "unshown\n" : `pressed:${reply}\n`;
}

/**
 * The copy's reply from all it wrote and how it ended: a button only from a copy that ended on its
 * own with success and wrote exactly the line for one of its word's buttons (`replyLine`), and
 * unshown for anything else - a box it could not show, a copy that crashed or was ended, or words
 * its box could not have said - so nothing but a press the person made counts as one.
 */
export function readReply(
  word: PersonWord,
  said: string,
  code: number | null,
  signal: string | null,
): PersonReply {
  if (code !== 0 || signal !== null) return "unshown";
  for (let button = 0; button < WORD_BUTTONS[word]; button++)
    if (said === replyLine(button)) return button;
  return "unshown";
}

/**
 * Ends the copy with the launch that asked for it: that launch holds the copy's input open for as
 * long as it lives and wants the word, so the input ending - its close, its exit or its death -
 * ends the copy and its box, even where it could not end the copy itself.
 */
export function endWithRequester(input: NodeJS.ReadableStream, end: () => void): void {
  let ended = false;
  const once = () => {
    if (ended) return;
    ended = true;
    end();
  };
  input.once("end", once);
  input.once("close", once);
  input.once("error", once);
  input.resume();
}

/**
 * Whether the copy's throwaway profile may be made in the data folder's folder for them
 * (`WORD_PROFILES_DIR`): anywhere but Windows, whose modes keep it this account's alone; on Windows
 * only once the data folder was kept private (`keepDataFolderPrivate`), whose access list it takes.
 * A launch that never judged it, or whose data folder was refused, makes none.
 */
export function wordProfilePrivate(
  platform: NodeJS.Platform,
  privacy: { readonly refused: unknown } | null,
): boolean {
  return platform !== "win32" || (privacy !== null && privacy.refused === null);
}
