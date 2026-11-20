import { leftoversKept, leftoversOf } from "@shared/leftoverPrograms";
import { timelineEventIdentity } from "../storage/taskEventStore";
import type { TaskService } from "../tasks/taskService";
import type { PressureLeftover } from "./resourcePressure";

/** INF-3497 finding 5: name only recorded close outcomes on their recorded computer. */
export function recordedPressureLeftovers(
  tasks: Pick<TaskService, "leftoverNotes" | "get">,
  computerId: string | null,
): PressureLeftover[] {
  return tasks.leftoverNotes(computerId).flatMap((event) => {
    const task = tasks.get(event.taskId);
    const report = leftoversOf(event.data);
    if (!task || (task.status !== "done" && task.status !== "dropped") || !report) return [];
    const kept = leftoversKept(report);
    if (!kept.stops.length && !kept.programs.length) return [];
    return [
      {
        id: timelineEventIdentity(event),
        taskId: task.id,
        key: task.key || task.id,
        report: { ...report, ...kept },
      },
    ];
  });
}

/**
 * Marks resolved each unresolved close report from that computer whose close
 * kept its leftovers in the task's folder there, once the computer's list
 * shows the task keeps nothing any more: a cleanup look cleared it, or the
 * folder went. A report from a close that kept no file stays as it was.
 */
export function resolveClearedLeftovers(
  tasks: Pick<TaskService, "leftoverNotes" | "resolveLeftoverNote">,
  computerId: string | null,
  kept: readonly string[],
): void {
  const keeping = new Set(kept);
  for (const event of tasks.leftoverNotes(computerId))
    if (event.data?.leftoversKeptInFile === true && !keeping.has(event.taskId))
      tasks.resolveLeftoverNote(event.id);
}
