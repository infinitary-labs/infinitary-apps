import { taskStatusOf } from "@shared/taskPresentation";
import type { TaskView } from "@shared/tasks";

/**
 * The status pill's tint (audit A1). Its mark is the shared lifecycle reading;
 * the whole pill tints only when the state needs the captain's eye: waiting
 * on you in the accent, interrupted or failed in danger. Every other state
 * is the neutral pill.
 */
export type RecordPillTone = "neutral" | "accent" | "danger";

export function recordPillToneOf(task: TaskView): RecordPillTone {
  const { mark } = taskStatusOf(task);
  if (mark === "waiting") return "accent";
  if (mark === "interrupted" || (mark === "dropped" && task.closedReason === "failed"))
    return "danger";
  return "neutral";
}
