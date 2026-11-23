import { type Card, mergeEffectOf, TASK_LIFECYCLE_OPS, type TaskLifecycleOp } from "./cards";
import { type RecordBarInput, recordBarOf } from "./recordBar";
import { isUnstartedWork, type TaskView } from "./tasks";

/**
 * Which lifecycle moves a task allows now, and why not (FI3-1014 piece 4;
 * docs/ui-plugins.md "A panel's cards"): the task record's own rule
 * (`recordBarOf`) for start, stop, continue and drop, and the task
 * service's guard for the board's queue and unqueue, said once here so a
 * panel that moves tasks reads the same answer the record's buttons and
 * the board give, from the task's typed fields alone. The host checks
 * again when a move runs (`inf:task:run`); this says what it would allow.
 *
 * Open, underway and dropped work has moves; a Done row, a decision, a
 * question and an ordinary operation has none. An outstanding required action
 * allows only Show the card once its prerequisites finish.
 */

export type TaskMoveAllowance = { ok: true } | { ok: false; text: string };
export type TaskMoves = Record<TaskLifecycleOp, TaskMoveAllowance>;

export type TaskMovesInput = RecordBarInput & Pick<TaskView, "key">;

const OK: TaskMoveAllowance = Object.freeze({ ok: true });
const no = (text: string): TaskMoveAllowance => ({ ok: false, text });

function keyList(keys: readonly string[]): string {
  if (keys.length === 0) return "What it waits on";
  if (keys.length === 1) return keys[0] as string;
  return `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

export function taskMovesOf(task: TaskMovesInput): TaskMoves | undefined {
  if (task.requiredAction && task.status === "open") {
    const captainOwns = no("This action waits for you, not a crewmate.");
    return {
      "answer-done": no("This is not an answer task."),
      "dismiss-question": no("This is not a question."),
      "start-task": captainOwns,
      "start-again": captainOwns,
      "stop-task": captainOwns,
      "continue-task": captainOwns,
      "drop-task": no("Ask your first mate to cancel this action with a reason."),
      "queue-task": captainOwns,
      "unqueue-task": captainOwns,
      "show-card":
        task.requiredAction.state === "blocked" ? no("Its prerequisites have not finished.") : OK,
    };
  }
  if (task.kind === "decision" && task.status === "open" && task.waitingCardId) {
    const unavailable = no("This question waits for your choice.");
    return Object.fromEntries(
      TASK_LIFECYCLE_OPS.map((op) => [
        op,
        op === "dismiss-question" || op === "show-card" ? OK : unavailable,
      ]),
    ) as TaskMoves;
  }
  if (
    task.kind !== "work" ||
    (task.status !== "open" && task.status !== "active" && task.status !== "dropped")
  ) {
    return undefined;
  }
  const bar = recordBarOf(task);
  const unstarted = isUnstartedWork(task);
  const parts = task.children.total > 0;
  const started = no("It has already started.");

  const starting = bar?.next === "starting";
  const heldStart = no("It is starting.");
  const start: TaskMoveAllowance = starting
    ? heldStart
    : bar?.next === "start" || bar?.next === "try-again"
      ? bar.blocked
        ? no(`${keyList(task.blockedBy)} must finish first.`)
        : OK
      : task.status === "active"
        ? started
        : parts
          ? no("Its parts are the work. Start a part instead.")
          : bar?.next === "show-card" || task.waitingCardId
            ? no("It waits for your answer on its card.")
            : task.startPolicy === "when-ready"
              ? no("It is queued. It starts by itself once nothing holds it.")
              : no("It cannot start from here.");

  const stop: TaskMoveAllowance =
    bar?.end === "stop-task"
      ? OK
      : unstarted
        ? no("It has not started. Drop task drops it.")
        : no("It cannot be stopped from here.");

  const resume: TaskMoveAllowance =
    bar?.next === "continue" ? OK : no("Only interrupted work continues.");

  // The one drop keeps open parts planned (INF-3169's piece 4).
  const drop: TaskMoveAllowance =
    bar?.end === "drop-task"
      ? OK
      : task.status === "active"
        ? no("It has started. Stopping it drops it and keeps a copy of its work.")
        : no("It cannot be dropped from here.");

  // Started work goes back to the backlog with its work kept, and only Start picks it up (INF-2062).
  const underway = task.status === "active";
  const inBacklog = underway && task.backlogSince !== undefined;
  const queueGuard: TaskMoveAllowance | null = starting
    ? heldStart
    : underway
      ? null
      : !unstarted
        ? started
        : parts
          ? no("Its parts do the work. Move a part instead.")
          : null;
  const queue =
    queueGuard ??
    (underway
      ? no("It has already started. Start picks it up from the backlog.")
      : task.startPolicy === "when-ready"
        ? no("It is already queued.")
        : OK);
  const waitsForWord = underway ? inBacklog : task.startPolicy === "on-request";
  const unqueue = queueGuard ?? (waitsForWord ? no("It already waits for your word.") : OK);

  return {
    "answer-done": task.answerNoteId ? OK : no("It has no answer ready."),
    "dismiss-question": no("This is not a question."),
    "start-task": start,
    "start-again":
      bar?.next === "start-again"
        ? OK
        : no("Only dropped work without a replacement or parts starts again."),
    "stop-task": stop,
    "continue-task": resume,
    "drop-task": drop,
    "queue-task": queue,
    "unqueue-task": unqueue,
    "show-card": task.waitingCardId ? OK : no("It has no card to show."),
  };
}

/** Whether a card settles with a merge: only that card's own button merges. */
export function cardMerges(card: Pick<Card, "actions"> | undefined): boolean {
  return card?.actions.some((action) => mergeEffectOf(action) !== undefined) ?? false;
}
