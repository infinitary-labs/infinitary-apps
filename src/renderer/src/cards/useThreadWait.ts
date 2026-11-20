import type { Card } from "@shared/cards";
import type { TaskView } from "@shared/tasks";
import { type ThreadWait, threadWait, threadWaitWords } from "@shared/threadWait";
import { useBoardTasks } from "../character/crew/useCrewBoard";

/** The waiting line as the thread paints it: the wait, the held class, and its one sentence. */
export type ThreadWaitLine = { on: ThreadWait["on"]; hold?: string; text: string };

/**
 * The waiting line for a card (docs/card-threads.md, "The waiting line"),
 * from the card's own hold and its task's board row - the work posture and
 * the crewmate's name - so it follows the same sequenced board as the
 * Tasks panel: a hold that ends, checks that finish or a turn that starts
 * change the line with no thread message.
 */
export function threadWaitLine(
  card: Pick<Card, "author" | "awaiting" | "taskId">,
  task: Pick<TaskView, "workPosture" | "assignee"> | undefined,
  now: number,
): ThreadWaitLine | undefined {
  const wait = threadWait(card, task?.workPosture);
  if (!wait) return undefined;
  return {
    on: wait.on,
    ...(wait.on === "account" && wait.hold ? { hold: wait.hold.class } : {}),
    text: threadWaitWords(wait, task?.assignee ?? undefined, now),
  };
}

/** The shown card's waiting line, read live off the board. */
export function useThreadWait(
  card: Pick<Card, "author" | "awaiting" | "taskId">,
): ThreadWaitLine | undefined {
  const tasks = useBoardTasks();
  const task = card.taskId ? tasks.find((row) => row.id === card.taskId) : undefined;
  return threadWaitLine(card, task, Date.now());
}
