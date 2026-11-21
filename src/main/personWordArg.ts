import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import { isWordProfileName } from "@shared/wordProfiles";

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
 * What the copy says where another word's copy already holds the profile it was started with
 * (`claimWordProfile`): its launch may then show a question through another profile.
 */
export const HELD_LINE = "held\n";

/** Whether a copy that ended on its own with success said only that its profile was held. */
export function saidHeld(said: string, code: number | null, signal: string | null): boolean {
  return code === 0 && signal === null && said === HELD_LINE;
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
 * The copy's input read on a thread of its own, which ends the copy the moment that input ends: on
 * a Mac a box with no window of its own keeps the copy's main thread until it is pressed, so the
 * input's end never reaches `endWithRequester` there, nor does an ordinary end, and the copy would
 * outlive the launch that asked for it. Ended at once, box and all, as the word it showed is no
 * longer wanted; its profile goes as any ended copy's does.
 */
export function endWithRequesterOffMain(): void {
  new Worker(INPUT_WATCH, { eval: true }).unref();
}

/** The thread `endWithRequesterOffMain` runs: it waits on the input until it ends, then ends the copy. */
const INPUT_WATCH = `
const { readSync } = require("node:fs");
const read = Buffer.alloc(64);
const nap = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  let got = 0;
  try {
    got = readSync(0, read);
  } catch (error) {
    // An input the main thread reads too may have nothing yet; any other failure is its end.
    if (error.code === "EAGAIN") {
      Atomics.wait(nap, 0, 0, 100);
      continue;
    }
  }
  if (got === 0) break;
}
process.kill(process.pid, "SIGKILL");
`;

/**
 * Whether the copy's profile may be kept in the data folder (`wordProfileIn`), where it is this
 * account's alone: anywhere but Windows, where the launch makes it with no access for anyone else;
 * on Windows only once the data folder was kept private (`keepDataFolderPrivate`), whose owner-only
 * list Windows hands down to it. A launch that never judged it, or whose data folder was refused,
 * makes none and touches nothing there.
 */
export function wordProfilePrivate(
  platform: NodeJS.Platform,
  privacy: { readonly refused: unknown } | null,
): boolean {
  return platform !== "win32" || (privacy !== null && privacy.refused === null);
}

/** The copy's own temporary folder, inside its profile (`TEMP`, `TMP` and `TMPDIR` name it). */
export const WORD_TEMP_DIR = "temp";
const PROFILE_SWITCH = "--user-data-dir=";

/**
 * The copy's first act, before anything else it runs: takes the profile it was started with, one
 * its launch keeps in the data folder (`isWordProfileName`), for itself alone (`hold`, Electron's own
 * lock on a profile, the one a window takes on its data folder), so two words shown at once never
 * share one. False where it was started with no profile of a word, or another copy holds it; the
 * copy then shows nothing and says its profile is held (`HELD_LINE`), and its launch shows a question
 * through the next recorded profile, or says the word in its own output.
 */
export function claimWordProfile(argv: readonly string[], hold: () => boolean): boolean {
  const profile = argv.find((arg) => arg.startsWith(PROFILE_SWITCH))?.slice(PROFILE_SWITCH.length);
  if (!profile || !isWordProfileName(basename(profile))) return false;
  return hold();
}
