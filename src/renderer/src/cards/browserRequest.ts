import type { Card } from "@shared/cards";

/** What a browser view entry carries that decides the card docked beside its page. */
type BrowserEntry = {
  browserTaskId?: string | undefined;
  browserFrom?: { cardId: string; session?: string; generation?: number } | undefined;
  /** The newest card its task raised while the view was shown (`arrivedInBrowser`). */
  browserArrived?: string | undefined;
};

function asksForBrowser(card: Card, taskId: string): boolean {
  return (
    !card.ended &&
    card.attachment?.kind === "browser" &&
    card.attachment.handoff === true &&
    card.attachment.taskId === taskId
  );
}

/**
 * The request card docked beside a task's browser view
 * (docs/task-browser.md, "The request beside the page"): the card the view
 * was opened from, or, for a view opened another way, the task's open card
 * asking the captain to take over its browser - while it is still up,
 * answered by its author or not. The view draws it as a column beside the
 * page, with its thread and its one field, until Return control takes it down.
 */
export function dockedRequestOf(cards: readonly Card[], entry: BrowserEntry): Card | undefined {
  const taskId = entry.browserTaskId;
  if (!taskId) return undefined;
  const from = entry.browserFrom;
  if (!from) return cards.find((candidate) => asksForBrowser(candidate, taskId));
  const card = cards.find((candidate) => candidate.id === from.cardId);
  const attachment = card?.attachment;
  if (!card || !asksForBrowser(card, taskId) || attachment?.kind !== "browser") return undefined;
  if (
    from.session !== undefined &&
    (from.session !== attachment.session || from.generation !== attachment.generation)
  )
    return undefined;
  return card;
}

/**
 * The card docked beside a task's browser view (docs/task-browser.md, "A
 * card beside the page"), and whether it is the task's request: the request
 * the view came from comes first, with its own rule (`dockedRequestOf`);
 * then the newest card the task raised while the view was shown; then the
 * card whose own browser button opened the view (`Try it`, `View booking`);
 * then the task's open request. Only cards still up dock.
 */
export function dockedCardOf(
  cards: readonly Card[],
  entry: BrowserEntry,
): { card: Card; request: boolean } | undefined {
  const taskId = entry.browserTaskId;
  if (!taskId) return undefined;
  const byId = (id: string | undefined) =>
    id === undefined
      ? undefined
      : cards.find((candidate) => candidate.id === id && !candidate.ended);
  const fromCard = cards.find((candidate) => candidate.id === entry.browserFrom?.cardId);
  if (fromCard?.attachment?.kind === "browser" && fromCard.attachment.handoff === true) {
    const request = dockedRequestOf(cards, entry);
    return request ? { card: request, request: true } : undefined;
  }
  const from = byId(entry.browserFrom?.cardId);
  const arrived = byId(entry.browserArrived);
  if (arrived && arrived.taskId === taskId) return { card: arrived, request: false };
  const door = from?.attachment;
  if (from && door && door.taskId === taskId) return { card: from, request: false };
  const request = cards.find((candidate) => asksForBrowser(candidate, taskId));
  return request ? { card: request, request: true } : undefined;
}

/**
 * The card a task raised that arrives in its shown browser view's column
 * rather than behind it (docs/task-browser.md, "A card beside the page"):
 * the newest of the arrivals its crewmate put up, unless the task has a
 * request standing - the request docks with its own rule, and its page's
 * Return control carries its field - or the arrival is that request.
 */
export function arrivedInBrowser(
  cards: readonly Card[],
  taskId: string,
  arrivedIds: readonly string[],
): Card | undefined {
  if (cards.some((card) => asksForBrowser(card, taskId))) return undefined;
  const arrivals = cards.filter(
    (card) =>
      arrivedIds.includes(card.id) &&
      card.taskId === taskId &&
      card.author === "crewmate" &&
      !card.ended,
  );
  return arrivals.reduce<Card | undefined>(
    (newest, card) => (newest && newest.createdAt >= card.createdAt ? newest : card),
    undefined,
  );
}

/**
 * The docked card as the column draws it: the crewmate's own words, with
 * no choices or browser door of its own - the page beside it is the door;
 * a request's closing choice is Return control, and any other card's
 * choices wait behind Back to the card - and no "You asked" line, so its
 * steps lead in the column's small room (INF-4587, the captain's pick).
 */
export function dockedRequestShown(card: Card): Card {
  const { attachment: _door, asked: _asked, ...words } = card;
  return { ...words, actions: [] };
}
