import { type Card, onStage } from "@shared/cards";
import type { TaskView } from "@shared/tasks";
import { minimizedRowId, presentTask } from "@shared/taskWaiting";
import { z } from "zod";
import { pressesSoFar } from "../../app/presses";
import { isHeldEntry, shownEntry } from "../../app/stack";
import { useShellStore } from "../../app/store";
import { boardOnScreen, searchedTask } from "../reads/appExecutor";

/** A pointing gesture at a task: it opens its waiting decision, or its record. */
export const openTaskValueSchema = z.strictObject({
  taskId: z.string().min(1).max(64),
  cardId: z.string().min(1).max(128).optional(),
});
export type OpenTaskValue = z.infer<typeof openTaskValueSchema>;
export type OpenTaskTarget = {
  focusCard: (cardId: string, since?: number) => boolean;
  openRecord: (taskId: string) => void;
};
export type OpenTaskOutcome = "card" | "record";

/**
 * The named card forward while the stack still holds it; otherwise the
 * task's record at the front of the stack. `since` is the captain's
 * presses counted when he pointed (app/presses.ts): the card takes focus
 * only if he began none since.
 */
export function openTaskOn(
  value: unknown,
  target: OpenTaskTarget,
  since?: number,
): OpenTaskOutcome {
  const parsed = openTaskValueSchema.safeParse(value);
  if (!parsed.success) throw new Error(`open: ${parsed.error.message}`);
  const { taskId, cardId } = parsed.data;
  if (cardId && target.focusCard(cardId, since)) return "card";
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
function showableRequiredAction(detail: Pick<TaskView, "status" | "requiredAction">): boolean {
  const state = detail.requiredAction?.state;
  return detail.status === "open" && (state === "ready" || state === "deferred");
}

/**
 * Tasks rows and board tiles restore put-aside cards, then show the waiting
 * decision, a deferred required action, the newest showable card, or the record.
 * Use the task already presented to the row; bringing a held card forward
 * does not wait for a task lookup. Task links have their own record-only rule.
 */
export async function openTask(value: OpenTaskValue, since = pressesSoFar()): Promise<void> {
  const shell = useShellStore.getState();
  const standalone = shell.cards.find(
    (card) => card.minimized && minimizedRowId(card.id) === value.taskId,
  );
  if (standalone) {
    shell.focusCard(standalone.id, since);
    return;
  }
  let detail =
    boardOnScreen()?.tasks.find((task) => task.id === value.taskId) ??
    searchedTask(value.taskId) ??
    (await window.infinitary.tasks.detail(value.taskId));
  const cards = useShellStore.getState().cards;
  const minimized = cards.filter(
    (card) => card.minimized && (card.taskId === detail.id || card.id === detail.waitingCardId),
  );
  if (minimized.length) {
    await Promise.all(minimized.map((card) => window.infinitary.cards.minimize(card.id, false)));
    shell.applyCards(await window.infinitary.cards.list());
  }
  let { waitingCardId } = presentTask(detail, useShellStore.getState().cards);
  if (!waitingCardId && showableRequiredAction(detail)) {
    const shown = await window.infinitary.task.run(value.taskId, "show-card");
    if (shown.ok) {
      detail = await window.infinitary.tasks.detail(value.taskId);
      waitingCardId = presentTask(detail, useShellStore.getState().cards).waitingCardId;
    }
  }
  openTaskOn(
    {
      taskId: value.taskId,
      cardId: waitingCardId ?? newestTaskCard(detail, useShellStore.getState().cards)?.id,
    },
    useShellStore.getState(),
    since,
  );
}

function newestTaskCard(
  task: Pick<TaskView, "id" | "waitingCardId">,
  cards: readonly Card[],
): Card | undefined {
  return cards.reduce<Card | undefined>(
    (newest, card) =>
      (card.taskId === task.id || card.id === task.waitingCardId) &&
      card.status === "ready" &&
      !card.ended &&
      onStage(card) &&
      (!newest || card.createdAt > newest.createdAt)
        ? card
        : newest,
    undefined,
  );
}

/** Every task link opens its record; Hide returns to the originating live card. */
export async function openTaskFromKey(task: Pick<TaskView, "id">): Promise<void> {
  const shell = useShellStore.getState();
  const from = shownEntry(shell);
  if (shell.view !== "home") shell.setView("home");
  shell.openRecord(task.id, from && !isHeldEntry(from) ? { cardId: from.id } : undefined);
}
