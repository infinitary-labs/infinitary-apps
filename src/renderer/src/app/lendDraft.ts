import { holdsWords, type MainDraft } from "@shared/overlayDraft";
import type { ShellGet, ShellSet, ShellState } from "./store";

/**
 * The main message in two places (docs/card-overlay.md, "The message box"):
 * the card overlay's box opens with the window's unsent words, chips and
 * recall, and gives them back as it goes. The window takes them back only
 * while its own box is still as it lent it, so words typed here meanwhile
 * are never replaced; memory only, as the composer is. Words the overlay
 * kept because no window lent for them come into a box that holds nothing.
 */

type Lent = Pick<ShellState, "inputText" | "pastes" | "attachments" | "lastSent" | "replacing">;

/** The message as the window's composer holds it now. */
export function mainDraftOf(s: Lent): MainDraft {
  return {
    text: s.inputText,
    pastes: s.pastes,
    attachments: s.attachments,
    lastSent: s.lastSent,
    replacing: s.replacing,
  };
}

/** The composer's fields that take a handed-back message. */
export function composerOf(draft: MainDraft): Lent {
  return {
    inputText: draft.text,
    pastes: draft.pastes,
    attachments: draft.attachments,
    lastSent: draft.lastSent,
    replacing: draft.replacing,
  };
}

/** Whether the box still holds exactly what it lent: the same words and the same chips. */
function unchanged(now: Lent, lent: Lent): boolean {
  return (
    now.inputText === lent.inputText &&
    now.pastes === lent.pastes &&
    now.attachments === lent.attachments &&
    now.replacing === lent.replacing
  );
}

/** The kept words, into the box only while it holds nothing; asked again whenever main says some are kept. */
function takeKept(get: ShellGet, set: ShellSet): void {
  if (holdsWords(mainDraftOf(get()))) return;
  void window.infinitary.cardOverlay
    .takeKept()
    .then((kept) => {
      if (!kept || holdsWords(mainDraftOf(get()))) return;
      const back = composerOf(kept);
      set({
        inputText: back.inputText,
        pastes: back.pastes,
        attachments: back.attachments,
        replacing: back.replacing,
        inputCaret: null,
        ...(back.lastSent ? { lastSent: back.lastSent } : {}),
      });
    })
    .catch(() => {});
}

/** The window's side: lends on the overlay's ask and takes the message back as it went. */
export function followOverlayLending(get: ShellGet, set: ShellSet): void {
  const overlay = window.infinitary.cardOverlay;
  // The newest lending only: one overlay opens at a time.
  let lending: { ask: number; lent: Lent } | null = null;
  overlay.onLendAsk((ask) => {
    const draft = mainDraftOf(get());
    lending = { ask, lent: composerOf(draft) };
    void overlay.lend({ ask, draft }).catch(() => {});
  });
  overlay.onKept(() => takeKept(get, set));
  // A window opened after the overlay went takes what it kept.
  takeKept(get, set);
  overlay.onHandBack(({ ask, draft }) => {
    if (lending?.ask !== ask) return;
    const { lent } = lending;
    lending = null;
    const now = get();
    const back = composerOf(draft);
    set({
      // Words typed here while the overlay was up stay.
      ...(unchanged(now, lent)
        ? {
            inputText: back.inputText,
            pastes: back.pastes,
            attachments: back.attachments,
            replacing: back.replacing,
            inputCaret: null,
          }
        : {}),
      // A message sent from the overlay is the one Up brings back, unless one was sent here since.
      ...(now.lastSent === lent.lastSent ? { lastSent: back.lastSent } : {}),
    });
  });
}
