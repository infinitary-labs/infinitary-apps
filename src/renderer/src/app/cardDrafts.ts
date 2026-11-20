import { CARD_DRAFTS } from "@shared/cardDrafts";
import { fillShownBodies } from "../cards/draftFill";
import { changesOff } from "../devices/viewWords";
import { type DraftLocal, DraftSync, withDraftAnswers } from "./draftSync";
import { withoutKey } from "./stack";
import type { ShellGet, ShellSet, ShellState } from "./store";

// This window's side of each open card's draft, wired to the window API and
// the shell's store; the rules are ./draftSync.ts's (docs/card-authoring.md,
// "Unsent picks follow you").

const BASE_PREFIX = "infinitary.cardDraftBase.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the card's own field holds focus in a focused window: its words are being typed. */
function typingReply(cardId: string): boolean {
  if (typeof document === "undefined" || !document.hasFocus()) return false;
  const active = document.activeElement;
  return active?.closest?.(`[data-card-reply="${CSS.escape(cardId)}"]`) != null;
}

const localOf = (state: ShellState, cardId: string): DraftLocal => ({
  answers: state.cardAnswers[cardId]?.answers ?? null,
  words: state.replyDrafts[cardId] ?? null,
  notes: state.replyNotes[cardId] ?? null,
});

/**
 * Starts this window's side of the drafts: reads them now and at each
 * welcome, follows every change here and every live frame, and lets a card
 * that left the stack go.
 */
export function startCardDrafts(
  get: ShellGet,
  set: ShellSet,
  subscribe: (listener: (state: ShellState, previous: ShellState) => void) => () => void,
): DraftSync | null {
  const cards = window.infinitary.cards;
  const read = cards.drafts;
  const send = cards.draft;
  if (!read || !send || !cards.onDraft) return null;
  const sync = new DraftSync({
    local: (cardId) => localOf(get(), cardId),
    apply: (cardId, parts) => {
      const filled = parts.answers ? fillShownBodies(cardId, parts.answers) : false;
      set((s) => ({
        ...(parts.answers && !filled
          ? {
              cardAnswers: {
                ...s.cardAnswers,
                [cardId]: withDraftAnswers(s.cardAnswers[cardId], parts.answers),
              },
            }
          : {}),
        ...(parts.words !== undefined && !typingReply(cardId)
          ? { replyDrafts: { ...s.replyDrafts, [cardId]: parts.words } }
          : {}),
        ...(parts.notes
          ? {
              replyNotes: parts.notes.length
                ? { ...s.replyNotes, [cardId]: parts.notes }
                : withoutKey(s.replyNotes, cardId),
            }
          : {}),
      }));
    },
    send: (cardId, change) => send(cardId, change),
    canSend: () => !changesOff(get().thisMac),
    loadBase: (cardId) => {
      try {
        const saved = Number(storage()?.getItem(BASE_PREFIX + cardId) ?? 0);
        return Number.isSafeInteger(saved) && saved > 0 ? saved : 0;
      } catch {
        return 0;
      }
    },
    saveBase: (cardId, revision) => {
      try {
        if (revision === null) storage()?.removeItem(BASE_PREFIX + cardId);
        else storage()?.setItem(BASE_PREFIX + cardId, String(revision));
      } catch {
        // Full or refused storage: a restart then lets the other windows' picks win.
      }
    },
    later: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const readAll = async () => {
    try {
      const home = await window.infinitary.app.healthcheck();
      if (!home.changes?.includes(CARD_DRAFTS)) return;
      const drafts = await read();
      const s = get();
      sync.welcome(drafts, [
        ...s.cards.map((card) => card.id),
        ...Object.keys(s.cardAnswers),
        ...Object.keys(s.replyDrafts),
        ...Object.keys(s.replyNotes),
      ]);
    } catch {
      // Out of reach: read again at the next welcome.
    }
  };
  cards.onDraft((draft) => sync.heardLive(draft));
  subscribe((state, previous) => {
    for (const cardId of new Set([
      ...Object.keys(state.cardAnswers),
      ...Object.keys(previous.cardAnswers),
      ...Object.keys(state.replyDrafts),
      ...Object.keys(previous.replyDrafts),
      ...Object.keys(state.replyNotes),
      ...Object.keys(previous.replyNotes),
    ])) {
      if (
        state.cardAnswers[cardId] === previous.cardAnswers[cardId] &&
        state.replyDrafts[cardId] === previous.replyDrafts[cardId] &&
        state.replyNotes[cardId] === previous.replyNotes[cardId]
      )
        continue;
      sync.changed(cardId, localOf(previous, cardId), localOf(state, cardId));
    }
    if (state.cards !== previous.cards) {
      const present = new Set(state.cards.map((card) => card.id));
      for (const card of previous.cards) if (!present.has(card.id)) sync.forget(card.id);
    }
    // Each welcome: a Mac this one controls came back in reach, or the link
    // to the first mate here came back; changes it sent meanwhile went nowhere.
    const before = previous.thisMac;
    const now = state.thisMac;
    if (before !== now && now) {
      const back =
        now.role === "view"
          ? (before?.role === "view" && changesOff(before) && !changesOff(now)) ||
            (before?.role === "view" && now.caughtUp > before.caughtUp)
          : before?.role === "home" &&
            ((now.linkBack ?? 0) > (before.linkBack ?? 0) ||
              (now.caughtUp ?? 0) > (before.caughtUp ?? 0));
      if (back) void readAll();
    }
  });
  void readAll();
  return sync;
}
