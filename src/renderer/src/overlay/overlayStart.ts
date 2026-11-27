import { startCardDrafts } from "../app/cardDrafts";
import type { DraftSync } from "../app/draftSync";
import { projectFocus } from "../app/projectFocus";
import { readCardsAgain } from "../app/stackActions";
import { useShellStore } from "../app/store";

/**
 * The card overlay page's reads (docs/card-overlay.md): the cards, their
 * threads and drafts, and whether this is a view of another computer's first
 * mate, and nothing the stack does not draw - no board, crew, voice or first
 * mate's pointing, which would change the card being read. It never takes a
 * notification's card (`inf:cards:take-notified`): that is the click's.
 */
let drafts: DraftSync | null = null;

export function startOverlayStore(): Promise<void> {
  const { getState: get, setState: set, subscribe } = useShellStore;
  set({ initialized: true });
  window.infinitary.devices.onThisMac((thisMac) => get().applyThisMac(thisMac));
  void window.infinitary.devices
    .thisMac()
    .then((thisMac) => {
      if (!get().thisMac) get().applyThisMac(thisMac);
    })
    .catch(() => {});
  window.infinitary.cards.onCards((cards) => get().applyCards(cards));
  // The project focus holds other projects' cards back here as in the window (docs/project-focus.md).
  projectFocus.subscribe(() => get().applyHold());
  window.infinitary.cards.onThread((thread) => get().applyThread(thread.cardId, thread.messages));
  drafts = startCardDrafts(get, set, subscribe);
  return readCardsAgain(get, () => set({ cardsSnapshotLoaded: true }));
}

/** Sends the words not yet sent before the overlay's page goes. */
export function settleOverlayDrafts(): Promise<void> {
  return drafts?.settle() ?? Promise.resolve();
}
