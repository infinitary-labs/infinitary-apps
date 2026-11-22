import type { Card } from "@shared/cards";
import { softHoldWords } from "@shared/holds";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";

/** The open card stack, as the hold reads it (`CardService`). */
type OpenCards = { values(): Iterable<Card>; get(id: string): Card | undefined };

/**
 * The first mate's own open decision that still asks the captain about a
 * task (INF-6091, finding 1): a decision kept on the task itself, whose
 * buttons act on it, or a decision filed as its own record that names the
 * task in `related`, which the record keeps as a `related` link from that
 * decision's row (a decision row is filed only for a card with no task). A
 * decision kept on another task names this one only for context, a note
 * asks nothing, and a card the captain answered or its author withdrew has
 * left the open stack.
 */
export function openCardAskingAbout(
  taskId: string,
  open: OpenCards,
  tasks: Pick<TaskService, "get" | "graph">,
): Card | undefined {
  const asks = (card: Card | undefined): card is Card =>
    card?.author === "firstmate" && card.actions.length > 0;
  for (const card of open.values()) if (card.taskId === taskId && asks(card)) return card;
  for (const link of tasks.graph.linksTo(taskId)) {
    if (link.type !== "related") continue;
    const decision = tasks.get(link.fromId);
    if (decision?.kind !== "decision" || decision.status !== "open" || !decision.gate?.ref)
      continue;
    const card = open.get(decision.gate.ref);
    if (asks(card)) return card;
  }
  return undefined;
}

/**
 * Why the first mate's start of a task waits for the captain (the soft hold
 * `card-question`), or undefined. It holds `update_task start_now`, a
 * `start_policy` of when-ready, and the removal of when-ready work's last
 * wait, either of which would let the ready sweep start it.
 * Only a start not yet made - queued work, or started work in the backlog -
 * waits, and only while its own open decision asks about it and the turn
 * carries no words the captain typed: a click on another card is not their
 * answer to this one (the captain's pick on INF-6121's review). The
 * captain's choice on that card, which takes it off the stack, their typed
 * words, their Start on the task, or the first mate's withdrawal of the card
 * each lift it; the first mate then starts it again.
 */
export function cardHeldStartRefusal(
  record: TaskRecord,
  facts: {
    open: OpenCards;
    tasks: Pick<TaskService, "get" | "graph">;
    /** The turn carries words the captain typed (`FirstmateTurn.typed`). */
    captainWords: boolean;
    captainPressedStart: boolean;
    /** The edit held, when it is not start_now itself. */
    edit?: "when-ready" | "wait-removal";
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
  const what =
    facts.edit === "when-ready"
      ? "Not set to start when ready"
      : facts.edit === "wait-removal"
        ? "Wait not removed"
        : "Not started";
  // i18n-exempt: the first mate's tool answer, served only to a model
  return `${what}: your open card "${card.title}" (${card.id}) still asks the captain about ${handle}, and no words they typed arrived with this turn. Only if the card no longer applies, withdraw it with close_card, saying why. ${softHoldWords("card-question", "firstmate")}`;
}
