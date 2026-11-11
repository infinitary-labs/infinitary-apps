import type { FmEvent } from "@shared/events";
import { cutText } from "@shared/textCut";
import type { JobManager } from "./jobs/jobManager";
import type { CrewSupervisor } from "./orchestrator/crewSupervisor";
import type { CrewWatch } from "./orchestrator/crewWatch";
import { PANELS_SAFE_MODE_NOTE } from "./personal/panelLines";
import { FIRSTMATE_RECIPIENT, type InboxStore, SUPERVISION_RECIPIENT } from "./storage/inboxStore";
import type { InterruptedJob } from "./storage/jobStore";
import type { TaskService } from "./tasks/taskService";

/**
 * The feed line for a job the last quit or crash stranded (WI-13): status,
 * not a decision, so one line and never a wake. It says only what the app
 * knows: its quit stopped a marked job, and an unmarked one may have run on
 * without it. A crewmate's job is a line on its task's record.
 */
export function interruptedJobNote(
  interrupted: InterruptedJob,
  taskTitle: (taskId: string) => string | undefined,
): Extract<FmEvent, { type: "firstmate_note" }> {
  const owner =
    interrupted.ownerId === "firstmate"
      ? "Your first mate's"
      : `"${taskTitle(interrupted.ownerId) ?? interrupted.ownerId}"'s`;
  const job = `${owner} background job "${cutText(interrupted.command, 80)}"`;
  return {
    type: "firstmate_note",
    text: interrupted.stoppedByQuit
      ? `${job} was stopped when the app quit.`
      : `${job} was running when the app quit unexpectedly. It may have kept running, even to the end.`,
    ...(interrupted.ownerId === "firstmate" ? {} : { taskId: interrupted.ownerId }),
  };
}

/**
 * Boot recovery, once the crew and the first mate exist: what the last
 * launch or quit left is said and carried on, once each, before anything
 * new arrives. Safe mode and the jobs the quit stranded are feed lines; a
 * cut-off that ended while the app was closed is heard first, so the inbox
 * and idle sweeps that follow deliver each lane's kept guidance as one turn;
 * wakes a previous version parked on the retired supervision lane go to the
 * first mate.
 */
export function recoverAtBoot(options: {
  /** This launch entered safe mode and switched the panels off. */
  enteredSafeMode: boolean;
  jobs: Pick<JobManager, "reportInterrupted">;
  tasks: Pick<TaskService, "get">;
  supervisor: Pick<CrewSupervisor, "reconcileCutOffs"> & {
    watch: Pick<CrewWatch, "announceCarryOn" | "sweepInbox" | "reconcileIdle">;
  };
  inbox: Pick<InboxStore, "allFor" | "reassign">;
  now: () => number;
  broadcastEvent: (event: FmEvent) => void;
}): void {
  const { supervisor, inbox, now, broadcastEvent } = options;
  if (options.enteredSafeMode) {
    // Safe mode is a fact the captain has to be told, not a silent loss:
    // one feed line that says what happened and where the switch is.
    broadcastEvent({ type: "firstmate_note", text: PANELS_SAFE_MODE_NOTE });
  }
  for (const interrupted of options.jobs.reportInterrupted()) {
    // A job the last quit or crash stranded is status, not a decision: one
    // feed line, never a wake (WI-13). The captain sees it in the feed;
    // nothing is owed.
    broadcastEvent(interruptedJobNote(interrupted, (id) => options.tasks.get(id)?.title));
  }
  // A cut-off that ended while the app was closed is heard first (its
  // `provider-back` makes the held lanes' rows due at once), so the boot
  // sweep delivers each lane's kept guidance as one turn.
  supervisor.reconcileCutOffs();
  // The inbox boot sweep (design A): task-lane rows the quit stranded are
  // re-delivered (resuming their idle tasks) or reported as orphaned, and
  // the firstmate and supervision lanes each get one explicit drain instead
  // of waiting for an incidental trigger.
  supervisor.watch.announceCarryOn();
  void supervisor.watch.sweepInbox(now());
  // The idle reconciler's boot sweep (docs/report-sort.md): a record the
  // ladder should already have acted on while the app was closed acts now,
  // from its saved clock and rung - once, never a storm, and its wakes
  // coalesce into one Firstmate turn.
  supervisor.watch.reconcileIdle(now());
  // Wakes a previous version parked on the retired supervision lane still
  // name real work: hand them to the Firstmate rather than leaving them to
  // rot on a lane with no reader (S7c).
  const stranded = inbox.allFor(SUPERVISION_RECIPIENT);
  if (stranded.length > 0) {
    inbox.reassign(
      stranded.map((row) => row.id),
      FIRSTMATE_RECIPIENT,
    );
  }
}
