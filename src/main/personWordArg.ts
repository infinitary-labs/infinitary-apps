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

/** What the copy says back: the button the person pressed, or that its box was never shown. */
export type PersonReply = number | "unshown";

/** The one line the copy writes for its reply (`readReply`). */
export function replyLine(reply: PersonReply): string {
  return reply === "unshown" ? "unshown\n" : `pressed:${reply}\n`;
}

/**
 * The copy's reply from all it wrote and how it ended: a button only from a copy that ended on its
 * own with success and wrote exactly one button line, and unshown for anything else - a box it
 * could not show, a copy that crashed or was ended, or words that are not a reply - so nothing but
 * a press the person made counts as one.
 */
export function readReply(said: string, code: number | null, signal: string | null): PersonReply {
  if (code !== 0 || signal !== null) return "unshown";
  const pressed = /^pressed:(\d+)\n$/.exec(said);
  return pressed ? Number(pressed[1]) : "unshown";
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
 * How a launch starts the copy that shows a word: as it was itself started, the installed program
 * with no arguments, or its AppImage file where it runs from one, so the AppImage's own start runs
 * again; a development run of Electron names the app's folder.
 */
export function wordLauncher(launch: {
  packaged: boolean;
  execPath: string;
  appPath: string;
  appImage?: string;
}): { execPath: string; args: string[] } {
  if (!launch.packaged) return { execPath: launch.execPath, args: [launch.appPath] };
  return { execPath: launch.appImage || launch.execPath, args: [] };
}
