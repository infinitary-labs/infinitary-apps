import type { Card } from "@shared/cards";
import { softHoldWords } from "@shared/holds";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";
import { servedTaskTitle, withReaderDataReminder } from "./readerData";
import { questionsNaming } from "./reviewCard";

/** The open card stack, as the hold reads it (`CardService`). */
type OpenCards = { values(): Iterable<Card>; get(id: string): Card | undefined };

type Tasks = Pick<TaskService, "get" | "graph">;

/**
 * The card a captain's choice answered, as its wake on the first mate's lane
 * keeps it (`card-choice`): `taskId` is the task the card was kept on, or the
 * decision filed as its own record for a card with none.
 */
export type ChoiceCard = { id?: string; title: string; taskId?: string };

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
  tasks: Tasks,
): Card | undefined {
  const asks = (card: Card | undefined): card is Card =>
    card?.author === "firstmate" && card.actions.length > 0;
  for (const card of open.values()) if (card.taskId === taskId && asks(card)) return card;
  for (const decision of questionsNaming(taskId, tasks)) {
    if (decision.status !== "open" || !decision.gate?.ref) continue;
    const card = open.get(decision.gate.ref);
    if (asks(card)) return card;
  }
  return undefined;
}

/**
 * The captain's choice on such a card that still waits unread on the first
 * mate's lane (the captain's pick on the takeover's review, "Also wait until
 * your first mate has read your choice"): the click took the card off the
 * stack at once, but the choice reaches the first mate only on its next turn,
 * so a start in the turn already under way would come before it read the
 * answer. Matched as the open card is: the card was kept on the task, or on
 * a decision filed as its own record that names the task in `related`.
 */
export function unreadChoiceAbout(
  taskId: string,
  choices: readonly ChoiceCard[],
  tasks: Tasks,
): ChoiceCard | undefined {
  const asking = new Set([taskId, ...questionsNaming(taskId, tasks).map((row) => row.id)]);
  return choices.find((card) => card.taskId !== undefined && asking.has(card.taskId));
}

/**
 * Why the first mate's start of a task waits for the captain (the soft hold
 * `card-question`), or undefined. It holds `update_task start_now`, a
 * `start_policy` of when-ready, the removal of when-ready work's last wait,
 * and any other edit that leaves when-ready work waiting on nothing, each of
 * which would let the ready sweep start it.
 * Only a start not yet made - queued work, or started work in the backlog -
 * waits, and only while its own open decision asks about it, or the
 * captain's choice on that decision has not reached the first mate yet, and
 * the turn carries no words the captain typed: a click on another card is
 * not their answer to this one (the captain's pick on INF-6121's review).
 * The first mate's read of the captain's choice on that card, their typed
 * words, their Start on the task, or the first mate's withdrawal of the card
 * each lift it; the first mate then starts it again.
 */
export function cardHeldStartRefusal(
  record: TaskRecord,
  facts: {
    open: OpenCards;
    tasks: Tasks;
    /** The captain's choices on the first mate's own cards it has not read yet. */
    unreadChoices: () => readonly ChoiceCard[];
    /** The turn carries words the captain typed (`FirstmateTurn.typed`). */
    captainWords: boolean;
    captainPressedStart: boolean;
    /** The edit held, when it is not start_now itself. */
    edit?: "when-ready" | "wait-removal" | "waits-ended";
  },
): string | undefined {
  if (facts.captainWords || facts.captainPressedStart) return undefined;
  const unstarted =
    (record.status === "open" && record.kind === "work") ||
    (record.status === "active" && record.backlogSince != null);
  if (!unstarted) return undefined;
  const handle = `${record.key || record.id} "${servedTaskTitle(record, facts.tasks.graph.discoveredOrigins(record.id), "line")}"`;
  // i18n-exempt: the first mate's tool answer, served only to a model
  const what =
    facts.edit === "when-ready"
      ? "Not set to start when ready"
      : facts.edit === "wait-removal"
        ? "Wait not removed"
        : facts.edit === "waits-ended"
          ? "Not updated, since the edit ends every wait of work set to start when ready"
          : "Not started";
  const hold = softHoldWords("card-question", "firstmate");
  const card = openCardAskingAbout(record.id, facts.open, facts.tasks);
  if (card)
    return withReaderDataReminder(
      // i18n-exempt: the first mate's tool answer, served only to a model
      `${what}: your open card "${card.title}" (${card.id}) still asks the captain about ${handle}, and no words they typed arrived with this turn. Only if the card no longer applies, withdraw it with close_card, saying why. ${hold}`,
    );
  const answered = unreadChoiceAbout(record.id, facts.unreadChoices(), facts.tasks);
  if (!answered) return undefined;
  const named = answered.id ? ` (${answered.id})` : "";
  return withReaderDataReminder(
    // i18n-exempt: the first mate's tool answer, served only to a model
    `${what}: the captain chose on your card "${answered.title}"${named} about ${handle}, and that choice has not reached you yet: it comes in a turn after this one. Read it before you start this task. ${hold}`,
  );
}
