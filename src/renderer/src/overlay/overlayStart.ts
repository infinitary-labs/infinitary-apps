import type { LentDraft } from "@shared/overlayDraft";
import { followPresence } from "../ambient/presence";
import { startCardDrafts } from "../app/cardDrafts";
import type { DraftSync } from "../app/draftSync";
import { composerOf, mainDraftOf } from "../app/lendDraft";
import { projectFocus } from "../app/projectFocus";
import { readCardsAgain } from "../app/stackActions";
import { useShellStore } from "../app/store";

/**
 * The card overlay page's reads (docs/card-overlay.md): the cards, their
 * threads and drafts, whether this is a view of another computer's first
 * mate, and what its message box needs - the first-launch gate, the last
 * turn and the three events that draw the newest round - and nothing else -
 * no board, crew, voice or first mate's pointing, which would change the
 * card being read. It never takes a notification's card
 * (`inf:cards:take-notified`): that is the click's.
 */
let drafts: DraftSync | null = null;

/** The events the message box's round reads: a message sent, the first mate working, its reply line. */
const ROUND_EVENTS = new Set(["user_turn", "firstmate_state", "firstmate_reply"]);

export function startOverlayStore(): Promise<void> {
  const { getState: get, setState: set, subscribe } = useShellStore;
  set({ initialized: true });
  // A card counts as seen only while someone is at this computer, as in the window (../cards/useSeenReport.ts).
  followPresence();
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
  window.infinitary.events.on((event) => {
    if (ROUND_EVENTS.has(event.type)) get().applyEvent(event);
  });
  // The box takes nothing while the first-launch gate is up, as the window's does (`mainInputHeld`).
  void get().loadFirstRun();
  void get().loadLastTurn();
  return readCardsAgain(get, () => set({ cardsSnapshotLoaded: true }));
}

/** This opening's message - the window's, kept words or an empty one - handed back as the overlay goes. */
let lent: number | null = null;

/** The message box opens with the window's unsent message. */
export function takeLentDraft(draft: LentDraft | null | undefined): void {
  if (!draft) return;
  lent = draft.ask;
  useShellStore.setState({ ...composerOf(draft.draft), inputCaret: draft.draft.text.length });
}

/** Sends the words not yet sent before the overlay's page goes, and hands its message back to the window or to be kept. */
export function settleOverlayDrafts(): Promise<void> {
  const back =
    lent === null
      ? Promise.resolve()
      : window.infinitary.cardOverlay
          .handBack({ ask: lent, draft: mainDraftOf(useShellStore.getState()) })
          .then(() => {});
  return Promise.all([drafts?.settle() ?? Promise.resolve(), back]).then(() => {});
}
