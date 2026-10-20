import { feedRelativeAge } from "./relativeAge";
import type { RunChecks, TaskDeliveryView } from "./tasks";

/**
 * How long a version's checks have run, or took (INF-587): from the host's
 * own start of the first check, to now while they run, to the last check's
 * finish once they pass, or to the first failure's once they fail. The
 * checks cell says it beside the state word: `running for 15m`,
 * `passed in 14m`, `failed after 9m`.
 */
export type ChecksSpan = {
  startedAt: number;
  /** Null while the checks run. */
  finishedAt: number | null;
  /** The word that joins the state to the duration. */
  joint: "for" | "in" | "after";
};

/** The span of a reading, or null where no time stands: not started, not read, merged elsewhere. */
export function checksSpanOf(
  delivery: Pick<TaskDeliveryView, "ci" | "ciStartedAt" | "ciFinishedAt">,
): ChecksSpan | null {
  const { ci, ciStartedAt: startedAt, ciFinishedAt: finishedAt } = delivery;
  if (startedAt === undefined) return null;
  if (ci === "pending") return { startedAt, finishedAt: null, joint: "for" };
  if (finishedAt === undefined) return null;
  if (ci === "green") return { startedAt, finishedAt, joint: "in" };
  if (ci === "red") return { startedAt, finishedAt, joint: "after" };
  return null;
}

/** A hand-started run's span (INF-594): from the host's start, to its end once it ended. */
export function runChecksSpanOf(run: RunChecks): ChecksSpan | null {
  const { startedAt, finishedAt } = run;
  if (startedAt === undefined) return null;
  if (run.state === "running") return { startedAt, finishedAt: null, joint: "for" };
  if (finishedAt === undefined) return null;
  return { startedAt, finishedAt, joint: run.state === "passed" ? "in" : "after" };
}

/** Whole minutes, as the checks cell counts: `under 1m`, `15m`, `1h 05m`. */
export function checksDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The state word with its duration: `running for 15m`, `passed in 14m`. */
export function checksSpanWords(words: string, span: ChecksSpan, now: number): string {
  return `${words} ${span.joint} ${checksDuration((span.finishedAt ?? now) - span.startedAt)}`;
}

/**
 * How long ago finished checks finished, after their duration in the
 * checks cell: `5m ago`, or `just now` within the minute.
 */
export function checksFinishedAgo(finishedAt: number, now: number): string {
  const age = feedRelativeAge(finishedAt, Math.max(now, finishedAt));
  return age === "now" ? "just now" : `${age} ago`;
}

/** A time of day in the reader's own clock: `9:01 PM`. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * What the checks' words show on rest: when the first check started and
 * when the app last read them, `Started 9:01 PM · read 9:13 PM`; either part
 * left out where it is unknown.
 */
export function checksRestWords(span: ChecksSpan | null, readAt: number | null): string {
  const words = [
    ...(span ? [`started ${clock(span.startedAt)}`] : []),
    ...(readAt !== null ? [`read ${clock(readAt)}`] : []),
  ].join(" · ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
