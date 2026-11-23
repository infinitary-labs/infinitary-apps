import type { TaskDetail } from "./tasks";
import { recordAttentionWaits, taskWaitText, waitStopsOf } from "./taskWaits";
import { AT_PROVIDER_WORDS } from "./workPosture";

/**
 * The sentence the task record leads its Info tab with when something is
 * wrong or the task waits on something (INF-2261: "A failure, an
 * interruption, a hold or a wait keeps its sentence at the top of the body,
 * above the goal"). A waiting decision is the bar's Show the card and an
 * open task's next step the status reason beside its pill, so neither has
 * a sentence here (FI3-948).
 */
export type RecordAttention = {
  title: string;
  guidance: string;
  /** Drawn first, above the charted filing's Why. */
  urgent: boolean;
  /** A failure or an interruption: the danger fill. */
  danger: boolean;
};

type AttentionDetail = Pick<
  TaskDetail,
  | "status"
  | "closedReason"
  | "activity"
  | "problem"
  | "queueWait"
  | "hold"
  | "flags"
  | "blockedBy"
  | "waitingCardId"
  | "workPosture"
  | "captainWait"
  | "outcomeSummary"
  | "children"
  | "waits"
  | "waitChain"
>;

/** What the record says under "Stuck at its provider". */
export const STUCK_GUIDANCE =
  "The provider kept refusing its request the same way, so the app stopped retrying and keeps its message. Your first mate is choosing whether to restart it in a new conversation or move it to another model.";

export function recordAttentionOf(task: AttentionDetail, now: number): RecordAttention | null {
  const closed = task.status === "done" || task.status === "dropped";
  const live = !closed;
  let title = "";
  let guidance = "";
  let urgent = false;
  let danger = false;
  if (task.closedReason === "failed" || (live && task.activity === "interrupted")) {
    title = task.closedReason === "failed" ? "Task failed" : "Work was interrupted";
    guidance = task.problem ?? "Ask your first mate how to continue.";
    urgent = true;
    danger = true;
  } else if (task.queueWait) {
    title = task.queueWait.line;
    guidance = task.hold?.text ?? "";
    urgent = task.flags.blocked;
  } else if (live && task.blockedBy.length > 0) {
    title = `Waiting on ${task.blockedBy.join(", ")}`;
    guidance = "This task is blocked by other work.";
    urgent = true;
  } else if (live && task.waitingCardId) {
    // The status says a decision is waiting, and the bar has Show the card.
  } else if (task.status === "open" && task.flags.blocked) {
    // Blocked with no live blocker: what it waited on was dropped, and its
    // edge still needs the first mate's decision before it starts
    // (docs/task-graph.md).
    title = "A task it waits on was dropped";
    guidance = "Ask your first mate about its dependencies before starting.";
  } else if (live && task.workPosture?.atProvider === "stuck") {
    // Stuck at its provider (docs/inbox.md): the app stopped retrying and
    // the first mate chooses the way on, so the captain has nothing to do.
    title = AT_PROVIDER_WORDS.stuck;
    guidance = STUCK_GUIDANCE;
    urgent = true;
  } else if (live && task.workPosture?.state === "active") {
    // Checks, jobs and replies still move without the captain. A declared
    // wait or an older report must not turn them into a request for them.
  } else if (live && task.hold) {
    // Queued work a gate holds never reported anything: the host words
    // what the gate waits for and what ends the wait (docs/task-record.md).
    title = task.hold.title;
    guidance = task.hold.text;
  } else if (live && (task.flags.needsYou || task.flags.held || task.captainWait)) {
    title = "Work is paused";
    // Reports are authored facts, not a prose classifier. Keep the last
    // report in view even when a later dismissed note occupies Now.
    guidance = task.outcomeSummary || "No reason has been reported yet.";
  } else if (task.status === "open" && task.children.total > 0) {
    // A parent's parts do the work, so it has no Start (A6).
    const { total, closed: done } = task.children;
    title = `Its ${total} ${total === 1 ? "part does" : "parts do"} the work`;
    guidance = `${done} closed, ${total - done} still open.`;
  }
  const waits = recordAttentionWaits(task);
  if (waits.length) {
    // A lone task wait names where its line stops, as its tile does (INF-5578).
    const stops = waitStopsOf(task);
    const words = waits
      .map((wait) =>
        taskWaitText(wait, now, true, undefined, stops?.wait === wait ? stops.line : undefined),
      )
      .join("; ");
    if (danger) guidance = `${guidance} ${words}`;
    else {
      title = words;
      if (waits.some((wait) => wait.kind === "start"))
        guidance = "The recorded start time does not promise that work has resumed.";
    }
  }
  return title ? { title, guidance, urgent, danger } : null;
}

const CLOSE_WORDS: Record<string, string> = {
  landed: "Merged",
  merged: "Merged",
  released: "Released",
  answered: "Answered",
  settled: "Closed",
  finished: "Finished",
  cancelled: "Dropped",
  discarded: "Discarded",
  failed: "Failed",
  superseded: "Superseded",
};

/**
 * How a closed task closed, as the parts of one line: a merge names its
 * change and its checks once (A10); a drop carries the words recorded with
 * it (A4). `at` is drawn as an age between `lead` and `tail`; `change`, when
 * given, is drawn after `lead`'s age as `as <noun> <label>`.
 */
export type RecordClosedLine = {
  lead: string;
  at: number | null;
  change: { noun: string; label: string; url: string | null } | null;
  tail: string;
};

type ClosedDetail = Pick<
  TaskDetail,
  "status" | "closedReason" | "closing" | "closedAt" | "delivery"
>;

export function recordClosedLineOf(task: ClosedDetail): RecordClosedLine | null {
  if (task.status !== "done" && task.status !== "dropped") return null;
  const at = task.closing?.at ?? task.closedAt;
  if (task.closedReason === "landed" || task.closedReason === "merged") {
    const facts = task.delivery;
    const label = facts?.changeLabel ?? (facts?.prNumber ? `#${facts.prNumber}` : undefined);
    const noun = facts?.prNumber || label?.startsWith("#") ? "pull request" : "branch";
    return {
      lead: "Merged ",
      at,
      change: label ? { noun, label, url: facts?.prUrl ?? null } : null,
      tail: `.${facts?.ci === "green" ? " The checks passed." : ""}`,
    };
  }
  // Work another task carries on closed done (INF-1825): its words say
  // where that work stands, and the close's time follows them.
  if (task.status === "done" && task.closedReason === "superseded" && task.closing?.note)
    return { lead: `${task.closing.note}, closed `, at, change: null, tail: "." };
  const reason = task.closedReason;
  const word = reason
    ? (CLOSE_WORDS[reason] ?? reason)
    : task.status === "done"
      ? "Done"
      : "Dropped";
  // A close the captain's own word asked says so in its lead (INF-3169's
  // plan, piece 3), so its note drops the words that only repeat it.
  const onWord = task.closing?.onWord === true;
  const said = onWord ? `${word} on your word` : word;
  const words = onWord
    ? task.closing?.note?.replace(/ on the captain's word$/, "")
    : task.closing?.note;
  const note = words && words !== reason ? words : null;
  return { lead: `${said} `, at, change: null, tail: note ? `: ${note}` : "." };
}
