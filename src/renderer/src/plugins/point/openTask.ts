import type { TaskView } from "@shared/tasks";
import { presentTask } from "@shared/taskWaiting";
import { z } from "zod";
import { useShellStore } from "../../app/store";

/** A pointing gesture at a task: it opens its waiting decision, or its record. */
export const openTaskValueSchema = z.strictObject({
  taskId: z.string().min(1).max(64),
  cardId: z.string().min(1).max(128).optional(),
});
export type OpenTaskValue = z.infer<typeof openTaskValueSchema>;
export type OpenTaskTarget = {
  focusCard: (cardId: string) => boolean;
  openRecord: (taskId: string) => void;
};
export type OpenTaskOutcome = "card" | "record";

/**
 * The named card forward while the stack still holds it; otherwise the
 * task's record at the front of the stack.
 */
export function openTaskOn(value: unknown, target: OpenTaskTarget): OpenTaskOutcome {
  const parsed = openTaskValueSchema.safeParse(value);
  if (!parsed.success) throw new Error(`open: ${parsed.error.message}`);
  const { taskId, cardId } = parsed.data;
  if (cardId && target.focusCard(cardId)) return "card";
  target.openRecord(taskId);
  return "record";
}

/**
 * Opens a task the way a click on its Tasks row does (task-system P4): its
 * ready decision comes forward, or its record opens at the front of the
 * main stack. A panel's `point.openTask` and a card body's task key open a
 * task the same way (FI3-594). An explicit record gesture has no shortcut
 * and keeps that route; a shortcut to a decision may have aged since the
 * page painted it, so the task's associations are refreshed and reconciled
 * with the focusable local stack first.
 */
export async function openTask(value: OpenTaskValue): Promise<void> {
  if (!value.cardId) {
    openTaskOn(value, useShellStore.getState());
    return;
  }
  const detail = await window.infinitary.tasks.detail(value.taskId);
  const shell = useShellStore.getState();
  const { waitingCardId } = presentTask(detail, shell.cards);
  openTaskOn({ ...value, cardId: waitingCardId ?? undefined }, shell);
}

/**
 * Opens the task a key the window draws names (FI3-1271): on the main view
 * - a key in Settings leaves Settings for it - as a click on its Tasks row
 * does.
 */
export function openTaskFromKey(task: Pick<TaskView, "id" | "waitingCardId">): Promise<void> {
  const shell = useShellStore.getState();
  if (shell.view !== "home") shell.setView("home");
  return openTask({
    taskId: task.id,
    ...(task.waitingCardId ? { cardId: task.waitingCardId } : {}),
  });
}
