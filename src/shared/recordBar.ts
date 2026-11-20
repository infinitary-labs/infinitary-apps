import * as m from "./i18n/messages.generated.ts";
import { type TaskStatusInput, taskStatusOf } from "./taskPresentation";
import { type ComputerMoveView, isUnstartedWork, type TaskView } from "./tasks";

/**
 * The task record's action bar (FI3-565 direction A, piece 4; the design
 * skill's TaskRecord): every open record ends in one row of buttons - the end
 * slot at its left edge, the next slot at its right (FI3-948) - read only
 * from the task's typed fields, never from its prose. It says nothing of its
 * own at rest - the status reason and the body's attention box say what
 * happens next - except why a start could not begin, beside Try again. Dropped work may start again; Done records have none.
 *
 * - `end`: the one way to end the task from its record, labelled Drop task
 *   in every state (the captain's `end_verb`). Before the work starts it is
 *   the footer's own `drop-task` (the record stays, nothing to keep); once
 *   started it is the stall card's `stop-task`, which ends the task and
 *   keeps a copy of its unfinished work. Null where no host op ends the
 *   row: the Firstmate's own decision and operation rows, and open work an
 *   earlier version returned to the queue still marked started (a start
 *   that began no crewmate now leaves it never started, `returnStart`).
 * - `next`: `start` on open work that waits for the captain's word - on
 *   request, held or not - and on started work back in the backlog
 *   (INF-2062), with no parts (`blocked`, and disabled, while
 *   something it waits on is still open; blocked work offers it whatever its
 *   policy), `continue` on Interrupted work, `show-card` while a decision
 *   card waits (`end_while_waiting`: the end slot stays), else null -
 *   nothing needs the captain. Work that starts by itself, queued or held
 *   for a later start, gets no Start now (no new task operation). The next
 *   slot follows the shared status's precedence, so a waiting decision
 *   outranks an interruption or a blocker.
 */
export type RecordBarEnd = "drop-task" | "stop-task" | "dismiss-question";
export type RecordBarNext =
  | "start"
  | "try-again"
  | "starting"
  | "start-again"
  | "continue"
  | "show-card"
  | "answer-done";
export type RecordBar = {
  end: RecordBarEnd | null;
  next: RecordBarNext | null;
  /** The next slot's Start is shown disabled: something it waits on is still open. */
  blocked: boolean;
};

export type RecordBarInput = TaskStatusInput &
  Pick<
    TaskView,
    "kind" | "startedAt" | "children" | "blockedBy" | "replacedBy" | "startAttempt" | "startNotice"
  >;

/** The next slot's words, in the process's language. */
export const RECORD_NEXT_LABELS: Readonly<Record<RecordBarNext, string>> = {
  get start() {
    return m.recordStart();
  },
  get "try-again"() {
    return m.recordTryAgain();
  },
  get starting() {
    return m.recordStarting();
  },
  get "start-again"() {
    return m.recordStartAgain();
  },
  get continue() {
    return m.recordContinue();
  },
  get "show-card"() {
    return m.recordShowCard();
  },
  get "answer-done"() {
    return m.cardAnswerDone();
  },
};

/** The open record bar, or Start again on eligible dropped work. */
export function recordBarOf(task: RecordBarInput): RecordBar | null {
  if (task.status === "done") return null;
  if (task.status === "dropped") {
    return task.kind === "work" && !task.replacedBy && task.children.total === 0
      ? { end: null, next: "start-again", blocked: false }
      : null;
  }
  if (task.answerNoteId) return { end: "stop-task", next: "answer-done", blocked: false };
  const work = task.kind === "work";
  const end: RecordBarEnd | null = !work
    ? task.kind === "decision" && task.waitingCardId
      ? "dismiss-question"
      : null
    : isUnstartedWork(task)
      ? "drop-task"
      : task.status === "active"
        ? "stop-task"
        : null;
  const { mark } = taskStatusOf(task);
  const parent = task.status === "open" && task.children.total > 0;
  // Start picks started work up from the backlog whatever it waits on: its crewmate goes on waiting.
  const backlog = task.status === "active" && task.backlogSince !== undefined;
  const blocked = !backlog && (task.blockedBy.length > 0 || task.flags.blocked);
  const startable =
    backlog ||
    (task.status === "open" && !parent && (task.startPolicy === "on-request" || blocked));
  const next: RecordBarNext | null =
    mark === "waiting"
      ? task.waitingCardId || (task.requiredAction && task.requiredAction.state !== "blocked")
        ? "show-card"
        : null
      : mark === "starting"
        ? "starting"
        : !work
          ? null
          : startable
            ? task.startNotice
              ? "try-again"
              : "start"
            : mark === "interrupted"
              ? "continue"
              : null;
  return {
    end: mark === "starting" ? null : end,
    next,
    blocked: next === "starting" || ((next === "start" || next === "try-again") && blocked),
  };
}

/**
 * The record's Move to a computer (docs/helper.md, "Moving a started task"):
 * the button that opens its picker, the picker's own buttons, and the line
 * that says where a move stands while one does.
 */
export const MOVE_LABELS = {
  open: "Move to a computer",
  to: "Move to",
  move: "Move",
  cancel: "Cancel",
  cancelMove: "Cancel move",
  /** Moves a task off a computer out of reach, leaving what only that computer holds behind. */
  moveWithout: "Move without it",
} as const;

/** Why a computer out of reach cannot take or give up a task now. */
export function moveOutOfReach(computer: string): string {
  return `${computer} is out of reach.`;
}

/** How long ago `at` was, in words that need no time zone: "3 hours ago". */
export function agoWords(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  const [count, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 48 * 60
        ? [Math.floor(minutes / 60), "hour"]
        : [Math.floor(minutes / (24 * 60)), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * What stays behind on a computer out of reach when a task moves off it now
 * (docs/helper.md, "Moving a task off a computer that is out of reach"):
 * everything after the commit the home holds, said before the move.
 */
export function leftBehindLine(
  computer: string,
  head: string,
  brought: { at: number; now: number } | undefined,
  home: string,
): string {
  const since = brought ? `, which ${home} brought here ${agoWords(brought.at, brought.now)}` : "";
  return `It continues from commit ${head.slice(0, 7)}${since}. What only ${computer} holds stays there: commits after that one, edits not committed, files git does not track, and the files in its task folders there.`;
}

/** Where a move stands, in one line: what it waits for, or what it is doing now. */
export function computerMoveLine(move: ComputerMoveView): string {
  const line =
    move.state === "retiring"
      ? `Moved to ${move.to}. Removing the working copy it left on ${move.from}.`
      : move.state === "moving"
        ? `Moving to ${move.to} now.`
        : move.waitingFor.length
          ? `Moves to ${move.to} once ${andList(move.waitingFor)}.`
          : `Moving to ${move.to}.`;
  return move.problem ? `${line} Last try: ${move.problem}.` : line;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
