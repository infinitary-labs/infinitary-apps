import type { InsertTaskEvent } from "../storage/taskEventStore";
import type { TaskClosedReason } from "../storage/taskRecords";
import type { TaskChange } from "./taskWriter";

/** The task event each close reason writes (`TaskService.close`). */
export const CLOSE_EVENT_KIND: Record<TaskClosedReason, InsertTaskEvent["kind"]> = {
  landed: "landed",
  merged: "merged",
  released: "status",
  answered: "status",
  settled: "status",
  finished: "status",
  cancelled: "status",
  discarded: "status",
  failed: "failed",
  superseded: "status",
};

/**
 * The tasks one committed change closed, read from the close events
 * `close` writes (each names its status and reason), so a listener on
 * `onChange` hears a close without reading the rows again.
 */
export function closedIn(change: Pick<TaskChange, "events">): string[] {
  return change.events.flatMap((event) => {
    const data = event.data;
    const reason = data?.reason;
    const closing =
      typeof reason === "string" &&
      Object.hasOwn(CLOSE_EVENT_KIND, reason) &&
      CLOSE_EVENT_KIND[reason as TaskClosedReason] === event.kind &&
      typeof data?.status === "string" &&
      data.status !== "open" &&
      data.status !== "active";
    return closing ? [event.taskId] : [];
  });
}
