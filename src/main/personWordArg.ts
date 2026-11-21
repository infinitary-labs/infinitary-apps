import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
 * Whether the copy's throwaway profile may be made in the folder for them beside the data folder
 * (`wordProfilesBeside`), which is given this account's access alone (`ownProfilesFolder`):
 * anywhere but Windows; on Windows only once the data folder was kept private
 * (`keepDataFolderPrivate`). A launch that never judged it, or whose data folder was refused, makes
 * none and touches nothing there.
 */
export function wordProfilePrivate(
  platform: NodeJS.Platform,
  privacy: { readonly refused: unknown } | null,
): boolean {
  return platform !== "win32" || (privacy !== null && privacy.refused === null);
}

/** What names a copy's throwaway profile, a folder in the profiles' folder (`wordProfilesBeside`). */
export const WORD_PROFILE_PREFIX = "infinitary-word-";
/**
 * The file this app makes in the profiles' folder before that folder is there under its name, saying
 * `WORD_PROFILES_MARK` and nothing else: a folder found there without it, or with any other file of
 * that name, is someone else's, never changed, read or used.
 */
export const WORD_PROFILES_RESERVED = ".infinitary-word-profiles";
/** What the profiles' folder's mark says, whole. */
export const WORD_PROFILES_MARK = "infinitary-word-profiles:1\n";
/** The file in a profile naming the one copy that uses it: its process number and a line's end. */
export const WORD_OWNER_FILE = "infinitary-word.pid";
/** The copy's own temporary folder, inside its profile (`TEMP` and `TMP` name it). */
export const WORD_TEMP_DIR = "temp";
const PROFILE_SWITCH = "--user-data-dir=";

/**
 * The copy's first act, before anything else it runs: names itself in the profile it was started
 * with, which its launch made for it alone, with its temporary folder; the line's end says the
 * record was written whole. False where it was started with no profile of ours or could not name itself, as a
 * copy that then shows nothing and says so; a profile it never named is one a later launch leaves.
 */
export function claimWordProfile(argv: readonly string[]): boolean {
  const profile = argv.find((arg) => arg.startsWith(PROFILE_SWITCH))?.slice(PROFILE_SWITCH.length);
  if (!profile || !basename(profile).startsWith(WORD_PROFILE_PREFIX)) return false;
  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    // Only a file it made itself: never one already there, nor through a link.
    writeFileSync(join(profile, WORD_OWNER_FILE), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    mkdirSync(join(profile, WORD_TEMP_DIR), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}
