/**
 * The card a notification's click asked the window to open (docs/view.md,
 * "Notifications"; INF-4243's plan, piece 5: "Notifications appear and open
 * their card"). The click notes it here and tells the window, which takes it
 * (`inf:cards:take-notified`) and brings that card to the front; a window
 * the click had to open first takes it once it starts, so it never depends
 * on a push reaching a page that is still loading. Taking it clears it, so
 * no later window opens it again.
 */
let notified: string | null = null;

export function noteNotifiedCard(cardId: string): void {
  notified = cardId;
}

export function takeNotifiedCard(): string | null {
  const cardId = notified;
  notified = null;
  return cardId;
}
