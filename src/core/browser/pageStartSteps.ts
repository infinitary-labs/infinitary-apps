import { browserCommand } from "./commandWords";
import type { BrowserAnswer, BrowserNavigateInput } from "./crewmateCommands";
import { type AnswerProbe, type AnswerTarget, answerTarget, probeLoopback } from "./pageAnswers";
import type { PageStart, PageStarts, StartOutcome } from "./pageStarts";

/**
 * The steps around a page's saved start that the task's browser takes
 * (docs/task-browser.md, "Starting a page again"): the refusals, the words a
 * crewmate's open answers with, and when a start is kept, run or missing.
 * The start's own process is `PageStarts`'s, which this file reads only as a
 * type, so the browser's own code loads no process or shell code with it.
 */

/** The open command as a crewmate writes it with a start. */
// i18n-exempt: a command's usage, read in the crewmate's shell
const OPEN_WITH_START = "open <url> --start '<command>' --within <seconds>";

/**
 * Why a crewmate's `--start` is refused before anything is kept, or none:
 * only for a page this computer serves, from the shell's folder.
 */
export function startRefusal(input: {
  starts: boolean;
  target: AnswerTarget | undefined;
  asked: NonNullable<BrowserNavigateInput["start"]>;
}): string | undefined {
  // i18n-exempt: a command answer served to the crewmate, not shown to a person
  if (!input.starts) return "This computer cannot keep a start command for a page.";
  if (!input.target) {
    // i18n-exempt: a command answer served to the crewmate, not shown to a person
    return `--start is only for a page a project serves on this computer (localhost, 127.0.0.1, a name ending in .localhost): Infinitary starts nothing for any other address. Open it without --start.`;
  }
  // i18n-exempt: a command answer served to the crewmate, not shown to a person
  if (!input.asked.cwd)
    return "--start needs the folder your shell is in, which this command did not send.";
  return undefined;
}

/** What a crewmate's open with `--start` says happened, in its words. */
// i18n-exempt: command answers served to the crewmate, not shown to a person
export const startWords = {
  saved: (start: PageStart): string =>
    `Saved your --start command for ${start.origin}: when the captain opens this page and nothing answers there, Infinitary runs it in ${start.folder} and asks you only if it fails. A program it starts needs no registered stop: it stops with this browser.`,
  started: (start: PageStart, log: string): string =>
    `Nothing answered at ${start.origin}, so Infinitary ran your --start command in ${start.folder} (its output is in ${log}) and opened the page once it answered. It stops when this browser stops, and Infinitary starts it again when the captain opens the page and nothing answers.`,
  failed: (start: PageStart, outcome: StartOutcome): string =>
    outcome.kind === "failed"
      ? `Nothing answered at ${start.origin}, so Infinitary ran your --start command in ${start.folder}, but ${outcome.ranOut ? `nothing answered within ${start.withinMs / 1000} seconds, so it stopped it` : `it exited (code ${outcome.exit ?? "none"}) before anything answered`}. Its output is in ${outcome.log}. The command is still saved; fix it and run ${browserCommand(OPEN_WITH_START)} again.`
      : "The start was stopped before its page answered, because this task's browser stopped.",
  missing: (): string =>
    ` This card's page is served on this computer and you saved no start for it: if its server stops, the captain's press wakes you to start it again. To have Infinitary start it instead, run ${browserCommand(OPEN_WITH_START)}.`,
};

/**
 * A crewmate's open is answered: a build the host started for it stops when
 * no browser was left to keep it, and the answer says what the start did.
 */
export function startAfterOpen(
  taskId: string,
  answer: BrowserAnswer,
  before: { next: string; started: boolean } | undefined,
  browserOpen: boolean,
  starts: Pick<PageStarts, "stopWithBrowser"> | undefined,
): BrowserAnswer {
  if (before?.started && !browserOpen) starts?.stopWithBrowser(taskId);
  return before && !answer.refused ? withNext(answer, before.next) : answer;
}

/** Whether a page on an address this computer serves has no saved start (emit_card's one line). */
export function startMissing(
  starts: Pick<PageStarts, "kept"> | undefined,
  taskId: string,
  url: string | undefined,
): boolean {
  const target = url ? answerTarget(url) : undefined;
  return starts !== undefined && target !== undefined && !starts.kept(taskId, target.origin);
}

/**
 * A crewmate's open with `--start`, before its page is opened: the start
 * is kept, and run at once when nothing answers there. It runs outside the
 * task's command queue, so the captain's own moves on the browser never
 * wait behind a build; the open follows with the line it returns.
 */
export async function startBeforeOpen(input: {
  taskId: string;
  url: string | undefined;
  asked: NonNullable<BrowserNavigateInput["start"]>;
  starts: Pick<PageStarts, "keep" | "run"> | undefined;
  probe: AnswerProbe | undefined;
}): Promise<{ refused: string } | { next: string; started: boolean }> {
  const { asked, starts } = input;
  const target = input.url ? answerTarget(input.url) : undefined;
  const why = startRefusal({ starts: Boolean(starts), target, asked });
  if (why || !starts || !target || !asked.cwd) return { refused: why ?? "" };
  const start: PageStart = {
    command: asked.command,
    folder: asked.cwd,
    origin: target.origin,
    withinMs: asked.withinSeconds * 1000,
  };
  starts.keep(input.taskId, start);
  const reading = await (input.probe ?? probeLoopback)(target.host, target.port).catch(
    () => "unknown" as const,
  );
  if (reading !== "refused") return { next: startWords.saved(start), started: false };
  const outcome = await starts.run(input.taskId, start, target);
  if (outcome.kind !== "answered") return { refused: startWords.failed(start, outcome) };
  return { next: startWords.started(start, outcome.log), started: true };
}

/** A browser answer with one more line ahead of its help. */
export function withNext(answer: BrowserAnswer, line: string): BrowserAnswer {
  return { ...answer, next: [line, ...(answer.next ?? [])] };
}
