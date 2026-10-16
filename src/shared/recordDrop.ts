import type { DropTaskReview } from "./cards";

/**
 * The captain's Drop task (FI3-243, from the accepted plan FI3-242; in every
 * open state since FI3-565 piece 4). On never-started work it is the footer's
 * own drop: the record is dropped/cancelled, and a parent with open parts is
 * refused, not cascaded. On started work it is the stall card's stop. The
 * top-right cross only hides the popover, so its name is not the action that
 * ends the task.
 */

export const DROP_TASK_LABEL = "Drop task";
export const DROP_CANCEL_LABEL = "Cancel";
export const HIDE_RECORD_LABEL = "Hide";

/** Preset reason. Not a field the captain fills in. */
export const NO_LONGER_WANTED = "No longer wanted";

/** Activity line for a captain drop of work that never started. */
export const DROPPED_BEFORE_START_ACTIVITY = "You closed this task before it started.";

/** Typed fact on the close event. Activity reads this, never the sentence. */
export const DROP_BEFORE_START = "beforeStart";

export const DROP_REVIEW_STALE = "This task changed. Review it again before dropping it.";

/** Drop task's one question, saying whether unfinished work is kept (the captain's `end_verb`). */
export function dropConfirmLead(key: string, started = false): string {
  return started
    ? `Drop ${key}? It ends the task and keeps a copy of its unfinished work.`
    : `Drop ${key}? It won't start, and there is no unfinished work to keep. Its record stays.`;
}

export function dropWaitingLine(waiting: readonly { key: string }[]): string | null {
  if (waiting.length === 0) return null;
  if (waiting.length === 1) {
    return `${waiting[0]?.key} is still waiting on this work. Dropping this task will not start it.`;
  }
  const keys = waiting.map((task) => task.key).join(", ");
  return `${waiting.length} tasks are still waiting on this work (${keys}). Dropping this task will not start them.`;
}

export function dropUnderwayLine(underway: readonly { key: string }[]): string | null {
  if (underway.length === 0) return null;
  const keys = underway.map((task) => task.key).join(", ");
  return underway.length === 1
    ? `${keys} is already working and will not be stopped.`
    : `${underway.length} tasks are already working (${keys}) and will not be stopped.`;
}

export function dropPartsRefusal(
  taskKey: string,
  parts: readonly { key: string; title: string; started?: boolean }[],
): string {
  const started = parts.filter((part) => part.started);
  const named = (list: readonly { key: string; title: string }[]) =>
    list.map((part) => `${part.key} "${part.title}"`).join(", ");
  if (started.length > 0) {
    const be = started.length === 1 ? "has" : "have";
    return `Cannot drop ${taskKey}: ${named(started)} ${be} started. Handle that work separately first.`;
  }
  const be = parts.length === 1 ? "is" : "are";
  const which = parts.length === 1 ? "its part" : `${parts.length} parts`;
  const them = parts.length === 1 ? "that work" : "them";
  return `Cannot drop ${taskKey} while ${which} ${be} still open: ${named(parts)}. Handle ${them} separately first.`;
}

export function dropStartedRefusal(taskKey: string): string {
  return `Cannot drop ${taskKey}: it just started.`;
}

export function dropIneligibleRefusal(taskKey: string): string {
  return `Cannot drop ${taskKey}: it is not unstarted work.`;
}

export function dropMissingRefusal(taskKey: string): string {
  return `Cannot drop ${taskKey}: that task is not here.`;
}

/** Keys the captain confirmed, in a stable order. */
export function dropReviewKeys(effects: {
  parts: readonly { key: string }[];
  waiting: readonly { key: string }[];
  underway: readonly { key: string }[];
}): DropTaskReview {
  const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key).sort();
  return {
    parts: keys(effects.parts),
    waiting: keys(effects.waiting),
    underway: keys(effects.underway),
  };
}

export function sameDropReview(left: DropTaskReview, right: DropTaskReview): boolean {
  const same = (a: readonly string[], b: readonly string[]) => {
    if (a.length !== b.length) return false;
    const rightKeys = [...b].sort();
    return [...a].sort().every((key, index) => key === rightKeys[index]);
  };
  return (
    same(left.parts, right.parts) &&
    same(left.waiting, right.waiting) &&
    same(left.underway, right.underway)
  );
}
