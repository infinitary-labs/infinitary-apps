import * as m from "@shared/i18n/messages.generated";
import type { ResetAnswer } from "@shared/reset";
import { commandWords } from "../workCommand";

/**
 * `<app> reset` (docs/reset.md, "The reset command"): Reset Infinitary on
 * this computer from a terminal, for a computer whose window never opens. It
 * asks the system's own confirmation of the person at this computer and
 * refuses where the system has none to ask, so a shell an agent drives can
 * never pass it; it refuses while Infinitary runs on the folder, whose own
 * Settings row resets it.
 */
export function resetCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "reset" ? words.slice(1) : null;
}

// i18n-exempt: the command's own words, typed as they are
export const RESET_USAGE = "Usage: infinitary reset";

/** What the command reaches, each a seam a test stands in. */
export type ResetCommandSeams = {
  /** Whether the system can ask the person at this computer to confirm; asked holding the folder. */
  canConfirm: () => Promise<boolean>;
  /** Takes the folder's own lock; false while Infinitary runs on it. */
  holdFolder: () => boolean;
  /** Lets the lock go, before the wipe renames the folder. */
  releaseFolder: () => void;
  /** Asks the confirmation, clears outside, writes the mark (./withoutFirstMate.ts). */
  reset: () => Promise<ResetAnswer>;
  /** Wipes the folder now, as the next start would (./atStart.ts). */
  finish: () => Promise<"done" | "held" | "busy">;
};

export type CommandAnswer = { code: number; out: string; error: string };

export async function answerResetCommand(
  words: readonly string[],
  seams: ResetCommandSeams,
): Promise<CommandAnswer> {
  const refuse = (line: string, code = 1): CommandAnswer => ({ code, out: "", error: `${line}\n` });
  if (words.length > 0) return refuse(RESET_USAGE, 2);
  // The lock first: while Infinitary runs on the folder, nothing else starts on it.
  if (!seams.holdFolder()) return refuse(m.resetCommandRunning());
  let answer: ResetAnswer;
  try {
    if (!(await seams.canConfirm().catch(() => false)))
      return refuse(m.resetCommandNoConfirmation());
    answer = await seams.reset();
  } finally {
    seams.releaseFolder();
  }
  if (answer.outcome !== "restarting") return refuse(m.resetCommandKept());
  const finished = await seams.finish().catch(() => "held" as const);
  if (finished === "done") return { code: 0, out: `${m.resetCommandDone()}\n`, error: "" };
  // A start already finishing it, or a folder another program holds: the
  // mark stays, so the next start carries on.
  return refuse(`${m.resetHeldMessage()}. ${m.resetHeldDetail()}`);
}
