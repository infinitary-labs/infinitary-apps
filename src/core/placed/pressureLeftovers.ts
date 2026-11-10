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
