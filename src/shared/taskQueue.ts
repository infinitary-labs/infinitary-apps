import type { TaskView } from "./tasks";

/**
 * The task board's queue and unqueue (FI3-979 piece 3; docs/task-board.md,
 * "Moves"): never-started work changes its start policy on the captain's
 * word, `inf:task:run`'s `queue-task` (when ready: it starts by itself once
 * nothing holds it) and `unqueue-task` (on request: it waits for the captain's word).
 * The task service is the one guard: work that has started, or a parent
 * whose parts do the work, is refused as text and nothing is written. A
 * move changes the start policy alone - never priority, order, project,
 * parent or dependencies - and its timeline entry says so in the captain's words.
 */

/** The start policy each move writes. */
export const QUEUE_POLICY: Record<"queue-task" | "unqueue-task", TaskView["startPolicy"]> = {
  "queue-task": "when-ready",
  "unqueue-task": "on-request",
};

/** The record's Activity line for each move, the captain's own. */
export const QUEUED_ACTIVITY = "You queued this task. It starts by itself when nothing holds it.";
export const UNQUEUED_ACTIVITY = "You moved this task back to the backlog. It waits for your word.";

export function queueMissingRefusal(key: string): string {
  return `Cannot move ${key}: that task is not here.`;
}

export function queueClosedRefusal(key: string): string {
  return `Cannot move ${key}: it is not open work.`;
}

export function queueStartedRefusal(key: string): string {
  return `Cannot move ${key}: it has already started.`;
}

export function queuePartsRefusal(key: string): string {
  return `Cannot move ${key}: its parts do the work. Move a part instead.`;
}
