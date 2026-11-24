import { createInterface } from "node:readline";
import { isatty } from "node:tty";
import type { FolderMove } from "@core/folderMove/due";
import {
  type MoveDeps,
  type MovePhase,
  type MoveProgress,
  type MoveRefusal,
  runMove,
} from "@core/folderMove/move";
import { stopOlderCopyNow, type TakeOverDeps, takeOverOlderCopy } from "@core/folderMove/takeOver";
import type { Service } from "@core/helper/background";
import { hostPlatform } from "@core/platform";
import { isProfileRetired } from "@core/storage/retiredProfile";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { fillOf, type HandOverNames, sizeOf } from "./handOverPage";
import { handOverNames, handOverReach } from "./handOverReach";
import { RUN_WORDS, type RunEnd } from "./runCommand";
import { windowsStdin } from "./windowsStdin";
import type { WorkContext } from "./workContext";

/**
 * The one-time move's hand-over for a run a command started (docs/run.md,
 * "Before it starts"): the window's hand-over (./handOver.ts) in lines a
 * terminal shows, before Chromium opens either folder. An older copy with
 * no window that holds the older folder is taken over as the window takes
 * it over (src/core/folderMove/takeOver.ts) - asked to save and stop, and
 * ended only on the person's typed yes, which only a terminal can give -
 * then the move runs with a line for each step, and once the work is in the
 * run goes on from this app's own folder. A run with no terminal never ends
 * the older copy, and a question only the window asks, which work to open
 * when both folders hold some, is left to the window.
 */

export type RunHandOverOptions = {
  names: HandOverNames;
  deps: Omit<MoveDeps, "progress" | "signal">;
  /** How the run takes over from an older copy holding the older folder; absent, it only says to stop it. */
  takeOver?: TakeOverDeps;
  say: (lines: readonly string[]) => void;
  /** Asks the person at a terminal and answers what they typed; absent where no terminal is there to answer. */
  ask?: (lines: readonly string[], prompt: string) => Promise<string>;
  /** A stop the run was asked for - Ctrl-C, its starter, its terminal closing - while it hands over. */
  signal: AbortSignal;
  /** Turns start at login on for this app, as the older app had it. */
  startAtLogin: () => void;
  /** Hands the moved work's background to this app's own label (`handBackgroundOver`). */
  handBackground?: () => Promise<unknown>;
  progressEveryMs?: number;
};

export type RunHandOver =
  /** Nothing to move, or the work is in this app's own folder now: the run goes on from it. */
  { kind: "here" } | { kind: "ended"; end: RunEnd };

/** How often a step under way says how far it is, at most. */
const PROGRESS_EVERY_MS = 15_000;

export function runRefusalLines(refusal: MoveRefusal, names: HandOverNames): string[] {
  // The move's own error ends without a full stop of its own in the sentence.
  const detail = (text: string) => text.replace(/[.\s]+$/, "");
  switch (refusal.reason) {
    case "busy":
      return [m.handoverRunBusy(names)];
    case "old-app-open":
      return [m.handoverRunStillOpen(names)];
    case "old-work-running":
      return [m.handoverRunStillWorking(names)];
    case "unsupported":
      return [m.handoverRunUnsupported(names)];
    case "no-space":
      return [m.handoverRunNoSpace({ needed: sizeOf(refusal.needed), free: sizeOf(refusal.free) })];
    case "failed":
      return [
        refusal.committed
          ? m.handoverRunUnfinished({ ...names, detail: detail(refusal.detail) })
          : m.handoverRunFailed({ ...names, detail: detail(refusal.detail) }),
      ];
    // Only Bring, the window's answer to the both-folders question, meets these.
    case "app-runs-inside":
    case "own-work-running":
      return [...RUN_WORDS.handOver];
  }
}

export async function runHandOverInTerminal(
  move: FolderMove,
  options: RunHandOverOptions,
): Promise<RunHandOver> {
  const { names, say, signal } = options;
  // Agents the take-over let go: started again whenever the hand-over ends
  // without the work, a step that throws included, so the older copy's work
  // runs as it did.
  const paused: Service[] = [];
  const end = (end: RunEnd): RunHandOver => ({ kind: "ended", end });
  const refused = (lines: string[]) => end({ reason: "start-failed", exitCode: 1, lines });
  // A stop leaves the work as the move left it and ends the run cleanly, as a stop does.
  const stopped = () => end({ reason: "signal", exitCode: 0, lines: [RUN_WORDS.stopped] });
  const progress = stepLines(names, say, options.progressEveryMs ?? PROGRESS_EVERY_MS);
  try {
    // One take-over: a copy that holds the folder again after it is the person's to see.
    let tookOver = false;
    for (;;) {
      const outcome = await runMove(move, { ...options.deps, progress, signal });
      if (outcome.kind === "moved") {
        say([m.handoverRunMoved(names)]);
        if (outcome.startAtLogin) options.startAtLogin();
        // Once the work is in, the background goes to this app's label with it; a failure leaves it for the work check.
        await options.handBackground?.().catch(() => undefined);
        return signal.aborted ? stopped() : { kind: "here" };
      }
      if (signal.aborted) return stopped();
      if (outcome.kind === "nothing" || outcome.kind === "kept") return { kind: "here" };
      if (outcome.kind === "ask") return refused([m.handoverRunBothFolders(names)]);
      const { refusal } = outcome;
      const held = refusal.reason === "old-app-open" || refusal.reason === "old-work-running";
      if (held && options.takeOver && !tookOver) {
        tookOver = true;
        // The stopping words show only once the holder is one of ours with no window.
        const taken = await takeOverOlderCopy(move.from, {
          ...options.takeOver,
          signal,
          stopping: () => {
            say([m.handoverStoppingTitle({ from: names.from }), m.handoverStoppingText(names)]);
            return undefined;
          },
        });
        if ((taken.kind === "stopped" || taken.kind === "still-running") && taken.unloaded)
          paused.push(taken.unloaded);
        if (signal.aborted) return stopped();
        if (taken.kind === "free" || taken.kind === "stopped") continue;
        if (taken.kind === "still-running") {
          const title = m.handoverWontStopTitle({ from: names.from });
          // Only a person at a terminal can say yes: anything else never ends it.
          if (!options.ask) return refused([title, m.handoverRunNoTerminal({ to: names.to })]);
          const answer = await options.ask(
            [title, m.handoverRunWontStop({ to: names.to })],
            `${m.handoverRunStopPrompt()} `,
          );
          if (signal.aborted) return stopped();
          if (answer.trim().toLowerCase() !== "yes")
            return refused([m.handoverRunLeftRunning({ from: names.from })]);
          const forced = await stopOlderCopyNow(move.from, taken.pid, {
            ...options.takeOver,
            signal,
          });
          if (forced.unloaded) paused.push(forced.unloaded);
          if (signal.aborted) return stopped();
          continue;
        }
      }
      return refused(runRefusalLines(refusal, names));
    }
  } finally {
    // Once the move committed, the older folder is a frozen recovery copy: nothing starts on it again.
    const retired = isProfileRetired(move.from);
    for (const service of paused.splice(0))
      if (!retired) await options.takeOver?.resumeAgent?.(service).catch(() => {});
  }
}

/**
 * The move's progress as lines: where it starts, what it copies once
 * counted, the check, and how far a step is at most every `everyMs`, so a
 * long copy is never silent and a log is never flooded.
 */
function stepLines(
  names: HandOverNames,
  say: (lines: readonly string[]) => void,
  everyMs: number,
): (progress: MoveProgress) => void {
  let phase: MovePhase | undefined;
  let lastSaid = 0;
  return (progress) => {
    if (phase === undefined)
      say([m.handoverRunMoving(names), m.handoverRunContinueLater({ to: names.to })]);
    if (progress.phase !== phase) {
      phase = progress.phase;
      lastSaid = Date.now();
      if (phase === "copying" && progress.counted)
        say([m.handoverRunCopying({ size: sizeOf(progress.counted.bytes) })]);
      else if (phase === "verifying") say([m.handoverRunChecking()]);
      return;
    }
    if (progress.total <= 0 || Date.now() - lastSaid < everyMs) return;
    lastSaid = Date.now();
    const percent = formatNumber(fillOf(progress), { style: "percent", maximumFractionDigits: 0 });
    say([m.handoverRunProgress({ percent })]);
  };
}

/**
 * Asks the person at a terminal: writes the lines and the prompt, and
 * answers the line they type. Ctrl-C, which a terminal hands the question
 * rather than the process while it waits, or the input closing, answers
 * nothing; Ctrl-C is the run's stop too (`interrupted`).
 */
export function terminalQuestion(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interrupted: () => void;
  signal: AbortSignal;
}): (lines: readonly string[], prompt: string) => Promise<string> {
  return (lines, prompt) =>
    new Promise((resolve) => {
      for (const line of lines) options.output.write(`${line}\n`);
      const reader = createInterface({ input: options.input, output: options.output });
      let answered = false;
      const done = (answer: string) => {
        if (answered) return;
        answered = true;
        options.signal.removeEventListener("abort", close);
        reader.close();
        resolve(answer);
      };
      const close = () => done("");
      options.signal.addEventListener("abort", close);
      reader.on("SIGINT", () => {
        options.output.write("\n");
        options.interrupted();
        done("");
      });
      reader.once("close", close);
      reader.question(prompt, done);
    });
}

/** The signals that stop a run: Ctrl-C, its starter stopping it, its terminal closing. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The one-time move for a run a command started (docs/run.md, "Before it
 * starts"): in the terminal, before Electron is ready, so the run goes on
 * from this app's own folder once the work is in. A stop the run is asked
 * for meanwhile ends the hand-over as it ends the move, with nothing changed
 * once the copy is not yet checked; the older copy is ended only on a yes
 * typed at a terminal.
 */
export async function handOverInRun(
  move: FolderMove,
  work: WorkContext,
  carryStartAtLogin: () => void,
): Promise<RunHandOver> {
  const stop = new AbortController();
  const onStop = () => stop.abort();
  for (const signal of STOP_SIGNALS) process.on(signal, onStop);
  // Only a person at a terminal can answer; a run a service manager started has none.
  const ask = (lines: readonly string[], prompt: string) => {
    const input = hostPlatform() === "win32" ? windowsStdin() : process.stdin;
    const question = terminalQuestion({
      input,
      output: process.stdout,
      interrupted: onStop,
      signal: stop.signal,
    });
    return question(lines, prompt).finally(() => input.pause());
  };
  try {
    return await runHandOverInTerminal(move, {
      names: handOverNames(move),
      ...handOverReach(move, work),
      say: (lines) => process.stdout.write(`${lines.join("\n")}\n`),
      ...(isatty(0) ? { ask } : {}),
      signal: stop.signal,
      // At once, as the work comes in: a run that ends before Electron is
      // ready never reaches the move again, so a later carry would be lost.
      startAtLogin: carryStartAtLogin,
    });
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onStop);
  }
}
