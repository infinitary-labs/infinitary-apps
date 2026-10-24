import type { CrewCounts, FmEvent } from "@shared/events";
import type { WorkPosture } from "@shared/workPosture";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskProtocol } from "./taskProtocol";
import type { TaskService } from "./taskService";

/**
 * The presentation pass (INF-683, INF-1073): a task write, a crew change or
 * a host clock asks for it, and one microtask later it reads each live
 * row's posture and place once (`TaskProtocol.refreshPresentation`),
 * republishes the rows that moved, and announces the crew counts from the
 * same readings. Asks during one synchronous run share a pass.
 *
 * The pass's own effects ask for nothing: its republish write changes no
 * posture (`TaskChange.republish`), and its own counts event is not a crew
 * change. Everything else asks again, including a write or a crew change
 * made while the pass runs, so a later change is never dropped; the pass
 * only stops re-reading what it has just read.
 */
export class WorkPresentation {
  private queued = false;
  private announced: FmEvent | undefined;
  private readonly detach: () => void;

  constructor(
    private readonly options: {
      tasks: Pick<TaskService, "onChange" | "count">;
      protocol: Pick<TaskProtocol, "refreshPresentation">;
      /** The event seam; the counts it announces come back through `heard`. */
      broadcastEvent: (event: FmEvent) => void;
    },
  ) {
    this.detach = options.tasks.onChange((change) => {
      if (change.taskIds.length > 0 && !change.republish) this.schedule();
    });
  }

  /** Ask for a pass on the next microtask; asks before it runs share it. */
  schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.run();
    });
  }

  /** Every event the seam carries: another owner's crew counts ask for a pass. */
  heard(event: FmEvent): void {
    if (event.type === "crew_counts" && event !== this.announced) this.schedule();
  }

  dispose(): void {
    this.detach();
  }

  private run(): void {
    const tally = crewTally();
    const moved = this.options.protocol.refreshPresentation((record, posture) =>
      tally.see(record, () => posture),
    );
    if (!moved) return;
    const counts: FmEvent = { type: "crew_counts", ...tally.counts(this.options.tasks) };
    this.announced = counts;
    try {
      this.options.broadcastEvent(counts);
    } finally {
      this.announced = undefined;
    }
  }
}

/**
 * The crew counts from postures already read: active work is working or
 * idle by its posture, and anything else counts for nothing. A presentation
 * pass that read every live row's posture counts from those readings
 * instead of deriving them again (INF-1073).
 */
export function crewTally(): {
  see(record: TaskRecord, posture: () => WorkPosture | undefined): void;
  counts(tasks: Pick<TaskService, "count">): CrewCounts;
} {
  let working = 0;
  let idle = 0;
  return {
    see(record, posture) {
      if (record.kind !== "work" || record.status !== "active") return;
      if (posture()?.state === "active") working += 1;
      else idle += 1;
    },
    // Counted, not read: every crew event asks, and planned work only counts.
    counts: (tasks) => ({ working, idle, queued: tasks.count("open", "work") }),
  };
}
