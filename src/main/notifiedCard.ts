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

/**
 * The card the newest notification on this computer was about, kept apart
 * from the click's: the card overlay reads it to know which card to show
 * first (docs/card-overlay.md, "Which card it shows"). Reading it takes
 * nothing, so a notification's own click still opens its card in the window.
 */
let noticed: string | null = null;
const noticeListeners = new Set<() => void>();

export function noteNoticedCard(cardId: string): void {
  noticed = cardId;
  for (const listener of noticeListeners) listener();
}

/** Hears each notification about a card: the overlay loads its page then (`CardOverlayController.noticed`). */
export function onNoticedCard(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

export function noticedCard(): string | null {
  return noticed;
}
