import type { TaskView } from "./tasks";

/**
 * The task board's queue and unqueue (FI3-979 piece 3; docs/task-board.md,
 * "Moves"): never-started work changes its start policy on the captain's
 * word, `inf:task:run`'s `queue-task` (when ready: it starts by itself once
 * nothing holds it) and `unqueue-task` (on request: it waits for the captain's word).
 * Started work goes back to the backlog too (INF-2062): its turn stops, its
 * work is kept, nothing the host sends wakes it, and Start picks it up in
 * the same conversation. Queue it is refused for started work.
 * The task service is the one guard: a parent whose parts do the work, or
 * closed work, is refused as text and nothing is written. A move changes
 * the start policy or the backlog wait alone - never priority, order,
 * project, parent or dependencies - and its timeline entry says so in the
 * captain's words.
 */

/** The start policy each move writes. */
export const QUEUE_POLICY: Record<"queue-task" | "unqueue-task", TaskView["startPolicy"]> = {
  "queue-task": "when-ready",
  "unqueue-task": "on-request",
};

/** The record's Activity line for each move, the captain's own. */
export const QUEUED_ACTIVITY = "You queued this task. It starts by itself when nothing holds it.";
export const UNQUEUED_ACTIVITY = "You moved this task back to the backlog. It waits for your word.";

/**
 * The record's Activity line when started work goes back to the backlog
 * (INF-2062): who moved it, that its work stays, and the one sentence why.
 */
export function backlogActivity(actor: "captain" | "firstmate", reason?: string): string {
  const who = actor === "captain" ? "You" : "Your first mate";
  const why = reason?.trim() ? ` ${reason.trim().replace(/[.!?]*$/, ".")}` : "";
  return `${who} moved this started task back to the backlog. Its work is kept, and it waits for your word.${why}`;
}

/** The record's Activity line when Start picks a started task up from the backlog. */
export function leftBacklogActivity(actor: "captain" | "firstmate"): string {
  return `${actor === "captain" ? "You" : "Your first mate"} started this task again from the backlog. Its crewmate carries on in the same conversation.`;
}

/**
 * The record's Activity line when the first mate records that the captain
 * asked for a task to wait (INF-3846 piece 2): until it starts again, the
 * app counts it as stopped by the captain and raises no alarm about it.
 */
export const CAPTAIN_STOP_ACTIVITY =
  "Your first mate recorded that you asked for this task to wait. It stays stopped until it starts again.";

/** The declaration on work that does not wait for a start. */
export function captainStopRefusal(key: string): string {
  return `Cannot record a stop on ${key}: only work that waits for a start takes one - open work on request, or started work back in the backlog. Pass start_policy on-request with it.`;
}

export function queueMissingRefusal(key: string): string {
  return `Cannot move ${key}: that task is not here.`;
}

export function queueClosedRefusal(key: string): string {
  return `Cannot move ${key}: it is not open work.`;
}

export function queueStartedRefusal(key: string): string {
  return `Cannot move ${key}: it has already started.`;
}

/** Queue it on started work: only Start picks a started task up again (INF-2062). */
export function queueStartedBacklogRefusal(key: string): string {
  return `Cannot queue ${key}: it has already started. Start picks it up from the backlog.`;
}

export function queuePartsRefusal(key: string): string {
  return `Cannot move ${key}: its parts do the work. Move a part instead.`;
}
