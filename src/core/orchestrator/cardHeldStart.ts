import type { Card } from "@shared/cards";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";

/**
 * The first mate's own open decision that still asks the captain about a
 * task (INF-6091, finding 1): a decision kept on the task itself, whose
 * buttons act on it, or a decision filed as its own record that names the
 * task in `related`, which the record keeps as a `related` link from that
 * decision's row. A decision kept on another task names this one only for
 * context, a note asks nothing, and a card its author ended or the captain
 * answered has left the open stack.
 */
export function openCardAskingAbout(
  taskId: string,
  open: Iterable<Card>,
  tasks: Pick<TaskService, "get" | "graph">,
): Card | undefined {
  const asking = new Map<string, Card>();
  for (const card of open)
    if (card.author === "firstmate" && card.actions.length > 0 && !card.ended)
      asking.set(card.id, card);
  if (asking.size === 0) return undefined;
  for (const card of asking.values()) if (card.taskId === taskId) return card;
  for (const link of tasks.graph.linksTo(taskId)) {
    if (link.type !== "related") continue;
    const decision = tasks.get(link.fromId);
    if (decision?.kind !== "decision" || decision.status !== "open") continue;
    const card = decision.gate?.ref ? asking.get(decision.gate.ref) : undefined;
    if (card && !card.taskId) return card;
  }
  return undefined;
}

/**
 * Why the first mate's `update_task start_now` waits for the captain, or
 * undefined: only a start not yet made - queued work, or started work in the
 * backlog - waits, and only while its own open decision asks about it and
 * the turn carries none of the captain's words. The captain's choice on that
 * card, their own words, their Start on the task, or the first mate's
 * withdrawal of the card each lift it.
 */
export function cardHeldStartRefusal(
  record: TaskRecord,
  facts: {
    open: Iterable<Card>;
    tasks: Pick<TaskService, "get" | "graph">;
    captainWords: boolean;
    captainPressedStart: boolean;
  },
): string | undefined {
  if (facts.captainWords || facts.captainPressedStart) return undefined;
  const unstarted =
    (record.status === "open" && record.kind === "work") ||
    (record.status === "active" && record.backlogSince != null);
  if (!unstarted) return undefined;
  const card = openCardAskingAbout(record.id, facts.open, facts.tasks);
  if (!card) return undefined;
  const handle = `${record.key || record.id} "${record.title}"`;
  // i18n-exempt: the first mate's tool answer, served only to a model
  return `Not started: your open card "${card.title}" (${card.id}) still asks the captain about ${handle}, and no words of theirs arrived with this turn. It starts on their choice on that card or on their own words. Only if the card no longer applies, withdraw it with close_card, saying why, before starting.`;
}
