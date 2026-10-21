import type { TaskView } from "./tasks";
import { workPostureLabel } from "./workPosture";

export type TaskStatus =
  | "backlog"
  | "queued"
  | "starting"
  | "working"
  | "idle"
  | "interrupted"
  | "waiting"
  | "done"
  | "dropped";
export type TaskStatusReading = {
  mark: TaskStatus;
  word: string;
  reason: string;
  /**
   * Its computer is out of reach, or back and not yet caught up: the mark
   * keeps its shape in `--warn` (docs/helper.md, "Runs on").
   */
  outOfReach?: true;
  /**
   * Working that is the host's checks watch (posture active, reason checks):
   * the same word and reason, drawn as an ember dot in the accent ring the
   * fact strip's running checks use (INF-676, direction A).
   */
  wait?: "checks";
};
/**
 * What a task's reading needs: a board row of the app's own, or the one a
 * panel reads (`PanelTaskRow`, whose closed reason is a plain string).
 */
export type TaskStatusInput = Pick<
  TaskView,
  | "status"
  | "activity"
  | "workPosture"
  | "startPolicy"
  | "flags"
  | "waitingCardId"
  | "captainWait"
  | "requiredAction"
  | "children"
  | "startAttempt"
  | "startNotice"
  | "place"
> & { closedReason: string | null };

const words: Record<TaskStatus, string> = {
  backlog: "Backlog",
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  interrupted: "Interrupted",
  waiting: "Waiting on you",
  done: "Done",
  dropped: "Dropped",
};

/**
 * Presentation only. Lifecycle and ready decisions take precedence over stale
 * activity. Open work reads by its start policy, the Tasks panel's Backlog
 * and Queued groups (src/shared/nowPanel.ts): Backlog waits for the
 * captain's word, Queued starts by itself; a blocker, a hold or a parent's
 * parts is the reason beside the word, never a different word. Open,
 * working or idle work whose computer is out of reach says so: its mark in
 * `--warn`, and its reason ("Mac mini is out of reach", or "Mac mini takes no new work" while it
 * is connected on an older Firstmate; "Mac mini is connecting", with the mark as it was, while its
 * connection is being made) unless a blocker, a
 * hold or its parts already give one. An interruption, a start and a ready
 * decision keep their own reading.
 */
export function taskStatusOf(task: TaskStatusInput): TaskStatusReading {
  const reading = (mark: TaskStatus, reason: string): TaskStatusReading => ({
    mark,
    word: words[mark],
    reason: reason === words[mark] ? "" : reason,
  });
  const connecting = task.place?.reach === "connecting";
  const away =
    task.place?.reach !== undefined && task.place.reach !== "in-reach" ? task.place?.name : null;
  const awayWords = connecting
    ? `${away} is connecting`
    : task.place?.noNewWork
      ? `${away} takes no new work`
      : `${away} is out of reach`;
  // Connecting keeps the mark as it was: only out of reach draws it in warn.
  const awayReading = (mark: TaskStatus, reason: string | null): TaskStatusReading => ({
    ...reading(mark, reason ?? awayWords),
    ...(connecting ? {} : { outOfReach: true as const }),
  });
  if (task.status === "done") {
    return reading(
      "done",
      task.requiredAction?.result ?? (task.closedReason === "answered" ? "Answered" : ""),
    );
  }
  if (task.status === "dropped") {
    return reading(
      "dropped",
      task.requiredAction?.result ?? (task.closedReason === "failed" ? "Failed" : ""),
    );
  }
  if (task.requiredAction)
    return reading(
      "waiting",
      task.requiredAction.state === "blocked" ? "Waiting for prerequisites" : "",
    );
  if (task.waitingCardId) {
    return reading("waiting", "A decision card is ready");
  }
  // Preparation is not Working and not Idle. A ready decision above still wins.
  if (
    task.startAttempt?.phase === "preparing" ||
    task.startAttempt?.phase === "checking" ||
    (task.status === "active" && task.activity === "starting")
  ) {
    return reading("starting", "");
  }
  if (task.startNotice && (task.status === "open" || task.status === "active")) {
    const mark = task.startPolicy === "on-request" ? "backlog" : "queued";
    return reading(mark, "Could not start");
  }
  if (task.status === "open") {
    const mark = task.startPolicy === "on-request" ? "backlog" : "queued";
    const parts = task.children.total;
    const holds = task.flags.blocked
      ? "Blocked by another task"
      : task.flags.held
        ? "Held"
        : parts > 0
          ? `Its ${parts} ${parts === 1 ? "part does" : "parts do"} the work`
          : null;
    if (away) return awayReading(mark, holds);
    return reading(
      mark,
      holds ?? (mark === "backlog" ? "Starts when you press Start" : "Starts by itself when ready"),
    );
  }
  const reason = task.workPosture
    ? workPostureLabel(task.workPosture)
    : task.activity === "running" || task.activity === "starting"
      ? "Working"
      : task.activity === "interrupted"
        ? "Work was interrupted"
        : "No continuing work";
  if (
    task.workPosture?.state === "active" ||
    (!task.workPosture && (task.activity === "running" || task.activity === "starting"))
  ) {
    if (away) return awayReading("working", null);
    return task.workPosture?.state === "active" && task.workPosture.reason === "checks"
      ? { ...reading("working", reason), wait: "checks" }
      : reading("working", reason);
  }
  if (task.activity === "interrupted") return reading("interrupted", reason);
  return away ? awayReading("idle", null) : reading("idle", reason);
}

export function taskStatusLabel(reading: TaskStatusReading): string {
  return reading.reason ? `${reading.word} · ${reading.reason}` : reading.word;
}
