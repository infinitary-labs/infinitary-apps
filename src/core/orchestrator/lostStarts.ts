import { DeviceOutOfReachError } from "../connection/connection";

/**
 * A start that loses a computer it needs (INF-5142 part 4): the connection
 * to the computer the task runs on, or to one its brief reads from, went
 * before the start finished. This Mac ended the start with no crewmate turn
 * begun, so the task goes back in line and starts by itself once that
 * computer is back; the first mate hears only when the same start is lost
 * again at the same step, which is news a retry does not change.
 */

/** Where a start was when it lost its computer, in the order a start takes them. */
export type StartStep = "checks" | "working-copy" | "conversation" | "brief";

const STEP_WORDS: Record<StartStep, string> = {
  checks: "before anything was sent",
  "working-copy": "while its working copy was being made",
  conversation: "while its conversation was opening",
  brief: "while its brief and starting work were being sent",
};

/** The step, in words that follow "lost its computer". */
export function lostStepWords(step: StartStep): string {
  return STEP_WORDS[step];
}

/**
 * The source computer a brief reads a source task's live work from went out
 * of reach: the start waits for that computer only while the source's work
 * is still there (`sourceId`).
 */
export class SourceOutOfReach extends DeviceOutOfReachError {
  readonly sourceId: string;
  constructor(message: string, options: { deviceId: string; sourceId: string; cause?: unknown }) {
    super(message, options);
    this.name = "SourceOutOfReach";
    this.sourceId = options.sourceId;
  }
}

/**
 * Whether a start failed because a computer went out of reach: the typed
 * refusal the connection raises, carried as is or as the cause of the error
 * a step wrapped it in, with the computer it names, if any refusal on the
 * way names one, and the source task whose work it held when that is why the
 * start needed it. A refusal the computer answered is not a loss.
 */
export function lostComputer(
  caught: unknown,
): { deviceId: string | undefined; sourceId?: string } | undefined {
  const seen = new Set<unknown>();
  let at: unknown = caught;
  let lost: { deviceId: string | undefined } | undefined;
  while (at instanceof Error && !seen.has(at)) {
    if (at instanceof SourceOutOfReach) return { deviceId: at.deviceId, sourceId: at.sourceId };
    if (at instanceof DeviceOutOfReachError) {
      if (at.deviceId) return { deviceId: at.deviceId };
      lost ??= { deviceId: undefined };
    }
    seen.add(at);
    at = at.cause;
  }
  return lost;
}

/** The status line of a start that went back in line, waiting for `who`. */
export function lostStartLine(who: string, step: StartStep): string {
  return `returned to the queue - ${who} went out of reach ${lostStepWords(step)}; it starts again once ${who} is back`;
}

/** The reason a start lost twice at the same step could not start, for the first mate. */
export function lostTwiceReason(who: string, step: StartStep, message: string): string {
  return `${who} went out of reach twice ${lostStepWords(step)} (${message})`;
}
