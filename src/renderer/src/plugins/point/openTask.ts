import type { TaskDetail, TaskView } from "@shared/tasks";
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
 * A required action the captain put off with Not now, or one presented and
 * since hidden (docs/task-record.md): its row stays under Waiting on you
 * with no open card, and the one typed show-card operation puts its card
 * up again, as the record's Show the card does. One still blocked by its
 * prerequisites has no card to show, and the operation would refuse it.
 */
function showableRequiredAction(detail: Pick<TaskDetail, "status" | "requiredAction">): boolean {
  const state = detail.requiredAction?.state;
  return detail.status === "open" && (state === "ready" || state === "deferred");
}

/**
 * Opens a task the way a click on its Tasks row does (task-system P4): its
 * ready decision comes forward, or its record opens at the front of the
 * main stack. A panel's `point.openTask` and a card body's task key open a
 * task the same way (FI3-594). A shortcut to a decision may have aged since
 * the page painted it, so the task's associations are refreshed and
 * reconciled with the focusable local stack first; a task with no reachable
 * decision whose required action the captain deferred gets its card shown
 * again (INF-358), and only a task with neither opens its record.
 */
export async function openTask(value: OpenTaskValue): Promise<void> {
  let detail = await window.infinitary.tasks.detail(value.taskId);
  let { waitingCardId } = presentTask(detail, useShellStore.getState().cards);
  if (!waitingCardId && showableRequiredAction(detail)) {
    const shown = await window.infinitary.task.run(value.taskId, "show-card");
    if (shown.ok) {
      detail = await window.infinitary.tasks.detail(value.taskId);
      waitingCardId = presentTask(detail, useShellStore.getState().cards).waitingCardId;
    }
  }
  openTaskOn(
    { taskId: value.taskId, cardId: waitingCardId ?? undefined },
    useShellStore.getState(),
  );
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
