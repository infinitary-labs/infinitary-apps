import type { FmEvent } from "@shared/events";
import { feedLineFrom, feedRunOf } from "@shared/feed";
import type { CoreEventSink } from "./events";
import { crewMilestoneFor, type SharingService } from "./sharing/sharingService";
import type { ActivityStore } from "./storage/activityStore";
import type { CrewLiveText } from "./tasks/crewTranscript";
import type { TaskService } from "./tasks/taskService";

/**
 * The one event seam (docs/architecture.md, "feed lines only via the
 * `broadcastEvent` seam"): every event the app broadcasts passes here.
 * Feed-worthy lines are persisted (P10) so the feed survives restarts, then
 * the event reaches the renderer. Observe's live buffer rides the same seam,
 * so a session's in-flight turn is readable by any client without a second
 * stream; Observe and the work presentation attach once they exist, since
 * both are built after the agents they hear.
 */
export type EventSeam = {
  broadcastEvent: (event: FmEvent) => void;
  /**
   * The captain's settled run whose line is Activity's newest, by id, or
   * null when the newest line is any other (docs/orchestrator-contract.md,
   * "Settled runs"): only that run's next step rewrites its line in place.
   */
  activityRun: () => string | null;
  /** The work presentation hears crew changes from here on. */
  attachPresentation: (hear: (event: FmEvent) => void) => void;
  /** Observe's live buffer hears every event from here on. */
  attachObserve: (observe: (event: FmEvent) => void) => void;
  /** The first launch hears each crewmate's start from here on (docs/first-launch.md). */
  attachFirstLaunch: (started: () => void) => void;
};

export function createEventSeam(options: {
  tasks: Pick<TaskService, "get" | "note">;
  activity: Pick<ActivityStore, "record" | "rewrite" | "withdraw">;
  sharing: Pick<SharingService, "record">;
  /** What each crewmate is writing now, for its Crewmate tab. */
  crewLive: Pick<CrewLiveText, "apply">;
  emit: CoreEventSink;
}): EventSeam {
  const { tasks, activity, sharing, crewLive, emit } = options;
  let observeEvent: (event: FmEvent) => void = () => {};
  let hearPresentation: (event: FmEvent) => void = () => {};
  let crewmateStarted: () => void = () => {};
  // The run whose line is Activity's newest, with that line's row
  // (`feedRunOf`): the captain's settled run on one setting
  // (docs/orchestrator-contract.md, "Settled runs"), or a copy's count of
  // what it sent so far (docs/devices.md, "How far the copy has gone"). Any
  // other line ends it, so a later step of the run rewrites its line in
  // place only while nothing else has entered Activity since.
  let runLine: { id: string; row: number } | null = null;
  const broadcastEvent = (event: FmEvent) => {
    // A feed line about a task is a row on that task's record (FI3-1189's
    // rule 1): written there as news, and the feed reads it back as the
    // task's own line (docs/task-record.md, "What Activity holds").
    if (event.type === "firstmate_note" && event.taskId && tasks.get(event.taskId)) {
      tasks.note(event.taskId, event.text, {
        news: true,
        feed: true,
        data: { feedLine: true, ...(event.said ? { said: event.said } : {}) },
      });
      return;
    }
    // Crew changes only; streaming deltas must not scan the task table, and
    // a task write asks through its own change (`WorkPresentation`).
    hearPresentation(event);
    const line = feedLineFrom(event);
    const run = feedRunOf(event);
    if (run && runLine?.id === run.id) {
      if (run.withdrawn) {
        activity.withdraw(runLine.row);
        runLine = null;
      } else if (line) activity.rewrite(runLine.row, line);
    } else if (line) {
      // A task's own line already lives in task_events (P3: the feed is a
      // view over both tables); persisting it again would show it twice.
      const row = event.type === "task_event" ? null : activity.record(line);
      runLine = run && row !== null ? { id: run.id, row } : null;
    }
    // The crew half of the first-run funnel (docs/sharing.md): kept once each.
    const milestone = crewMilestoneFor(event);
    if (milestone) sharing.record(milestone);
    observeEvent(event);
    crewLive.apply(event);
    emit("inf:event", event);
    // After the start reached every window, so its note follows the crewmate.
    if (event.type === "task_started") crewmateStarted();
  };
  return {
    broadcastEvent,
    activityRun: () => runLine?.id ?? null,
    attachPresentation: (hear) => {
      hearPresentation = hear;
    },
    attachObserve: (observe) => {
      observeEvent = observe;
    },
    attachFirstLaunch: (started) => {
      crewmateStarted = started;
    },
  };
}
