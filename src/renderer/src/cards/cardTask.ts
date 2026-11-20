import type { Card } from "@shared/cards";
import type { TaskView } from "@shared/tasks";
import { useEffect, useSyncExternalStore } from "react";
import { taskKeyIndex } from "./taskLinks";

/**
 * The task a card on the stage is about (INF-358; the captain's "the task
 * key is added to all decision cards about a task"): the task its `taskId`
 * names, which every crewmate card and every host card about a task
 * carries; or, for a first mate decision that named no task, the decision
 * row the app filed for it, the board row whose waiting decision is the
 * card (docs/task-record.md). A card about no task - a provider's or a
 * forge's sign-in, a first mate note that named none - has none, so its
 * head draws no key.
 */
export type CardTaskFacts = Pick<Card, "id" | "taskId" | "author" | "actions">;

/** The board's row for the task `card` is about, as last read, or undefined. */
export function cardTaskOf(card: CardTaskFacts): TaskView | undefined {
  if (card.taskId) return taskKeyIndex.byId(card.taskId);
  if (card.author === "firstmate" && card.actions.length > 0)
    return taskKeyIndex.waitingOn(card.id);
  return undefined;
}

/** Whether `card` can be about a task at all, so the board is worth reading for it. */
const mayHaveTask = (card: CardTaskFacts): boolean =>
  card.taskId !== undefined || (card.author === "firstmate" && card.actions.length > 0);

/**
 * The task a stacked card is about, following the board while the card is
 * drawn: null until the board answers, and for a card about no task.
 */
export function useCardTask(card: CardTaskFacts): TaskView | null {
  const wanted = mayHaveTask(card);
  useEffect(() => (wanted ? taskKeyIndex.hold() : undefined), [wanted]);
  const seen = useSyncExternalStore(
    taskKeyIndex.subscribe,
    taskKeyIndex.version,
    taskKeyIndex.version,
  );
  void seen;
  return wanted ? (cardTaskOf(card) ?? null) : null;
}
