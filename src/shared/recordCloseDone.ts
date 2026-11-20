import type { RecordBarInput } from "./recordBar";
import { taskStatusOf } from "./taskPresentation";

/**
 * The task record's Close as done (INF-3169's plan, piece 3; the design
 * skill's TaskRecord; docs/task-record.md, "One close as done"): the
 * captain's own word, from the record, that started work is done. It asks
 * once, inline, and the host closes the task as done through the one close
 * as done, which meets only the real limits.
 */
export const CLOSE_DONE_LABEL = "Close as done";

/**
 * Whether a record offers Close as done: started work whose start was
 * accepted, with no saved answer waiting for its own Done.
 */
export function recordOffersCloseDone(task: RecordBarInput): boolean {
  if (task.kind !== "work" || task.status !== "active" || task.answerNoteId) return false;
  return taskStatusOf(task).mark !== "starting";
}

/** The confirm sentence: what the close does to the task's work. */
export function closeDoneConfirm(key: string): string {
  return `Close ${key} as done? A working crewmate stops, unmerged work is saved, and an open pull request stays open.`;
}

/** The host's refusal for a task the record no longer reads as started. */
export function closeDoneNotStartedRefusal(key: string): string {
  return `Cannot close ${key} as done: it has not started. Drop task drops it.`;
}

/** The host's refusal for a task already closed, done or dropped. */
export function closeDoneClosedRefusal(key: string): string {
  return `Cannot close ${key} as done: it is already closed.`;
}

/** The host's refusal for a task it cannot find. */
export function closeDoneMissingRefusal(key: string): string {
  return `Cannot close ${key} as done: that task is not here.`;
}
