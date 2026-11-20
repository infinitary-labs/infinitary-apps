import { CARD_DRAFTS } from "@shared/cardDrafts";
import { fillShownBodies } from "../cards/draftFill";
import { changesOff } from "../devices/viewWords";
import { type DraftBase, type DraftLocal, DraftSync, withDraftAnswers } from "./draftSync";
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

/** A saved base as `DraftSync` keeps it; anything else in its place reads as none. */
function isBase(value: unknown): value is DraftBase {
  if (!value || typeof value !== "object") return false;
  const base = value as Partial<DraftBase>;
  return (
    Number.isSafeInteger(base.revision) &&
    (base.lifecycle === undefined || typeof base.lifecycle === "string") &&
    !!base.parts &&
    typeof base.parts === "object" &&
    Object.values(base.parts).every((revision) => Number.isSafeInteger(revision))
  );
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
  // Another window's words that arrived while the card's field was being
  // typed in, with the words they arrived over; they show once typing stops,
  // unless the captain typed on since.
  const waitingWords = new Map<string, { words: string; over: string | undefined }>();
  const sync = new DraftSync({
    local: (cardId) => localOf(get(), cardId),
    lifecycle: (cardId) => {
      const card = get().cards.find((shown) => shown.id === cardId);
      return card ? (card.lifecycleId ?? null) : undefined;
    },
    apply: (cardId, parts) => {
      const filled = parts.answers ? fillShownBodies(cardId, parts.answers) : false;
      const typing = parts.words !== undefined && typingReply(cardId);
      if (parts.words !== undefined) {
        if (typing)
          waitingWords.set(cardId, { words: parts.words, over: get().replyDrafts[cardId] });
        else waitingWords.delete(cardId);
      }
      set((s) => ({
        ...(parts.answers && !filled
          ? {
              cardAnswers: {
                ...s.cardAnswers,
                [cardId]: withDraftAnswers(s.cardAnswers[cardId], parts.answers),
              },
            }
          : {}),
        ...(parts.words !== undefined && !typing
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
        const saved: unknown = JSON.parse(storage()?.getItem(BASE_PREFIX + cardId) ?? "null");
        return isBase(saved) ? saved : null;
      } catch {
        return null;
      }
    },
    saveBase: (cardId, base) => {
      try {
        if (base === null) storage()?.removeItem(BASE_PREFIX + cardId);
        else storage()?.setItem(BASE_PREFIX + cardId, JSON.stringify(base));
      } catch {
        // Full or refused storage: a restart then lets the other windows' picks win.
      }
    },
    later: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  // Read only over a loaded stack, so each card's opening is known when its draft is taken.
  const readAll = async () => {
    if (!get().cardsSnapshotLoaded) return;
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
  const settleWords = () => {
    for (const [cardId, waiting] of waitingWords) {
      if (typingReply(cardId)) continue;
      waitingWords.delete(cardId);
      if (get().replyDrafts[cardId] !== waiting.over) continue;
      set((s) => ({ replyDrafts: { ...s.replyDrafts, [cardId]: waiting.words } }));
    }
  };
  if (typeof document !== "undefined" && typeof window.addEventListener === "function") {
    // Focus leaves on the next turn, once the next element holds it.
    document.addEventListener("focusout", () => setTimeout(settleWords, 0));
    window.addEventListener("blur", settleWords);
  }
  cards.onDraft((draft) => sync.heardLive(draft));
  // The opening each card's draft here belongs to; a card seen before this
  // run reads it from what this window kept of its draft.
  const openings = new Map<string, string | null>();
  const knownOpening = (cardId: string): string | null | undefined => {
    if (openings.has(cardId)) return openings.get(cardId);
    try {
      const saved: unknown = JSON.parse(storage()?.getItem(BASE_PREFIX + cardId) ?? "null");
      return isBase(saved) ? (saved.lifecycle ?? null) : undefined;
    } catch {
      return undefined;
    }
  };
  subscribe((state, previous) => {
    let reread = false;
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
      // A card that left lets its draft here go; one opened anew under the
      // same id, now or before this window started, also drops the picks,
      // words and notes this window held for its earlier opening, before
      // its body draws.
      const present = new Set(state.cards.map((card) => card.id));
      for (const card of previous.cards)
        if (!present.has(card.id)) {
          sync.forget(card.id);
          waitingWords.delete(card.id);
        }
      const anew: string[] = [];
      const before = new Map(previous.cards.map((card) => [card.id, card.lifecycleId ?? null]));
      let arrived = false;
      for (const card of state.cards) {
        const opening = card.lifecycleId ?? null;
        const known = knownOpening(card.id);
        openings.set(card.id, opening);
        if (known !== undefined && known !== opening) anew.push(card.id);
        if (before.get(card.id) !== opening) arrived = true;
      }
      for (const cardId of anew) {
        sync.forget(cardId);
        waitingWords.delete(cardId);
      }
      if (anew.length > 0)
        set((s) => ({
          cardAnswers: anew.reduce((left, id) => withoutKey(left, id), s.cardAnswers),
          replyDrafts: anew.reduce((left, id) => withoutKey(left, id), s.replyDrafts),
          replyNotes: anew.reduce((left, id) => withoutKey(left, id), s.replyNotes),
        }));
      // A card or opening the stack now holds may have a draft this window
      // heard before it knew the card, or never read.
      if (arrived) reread = true;
    }
    // Each welcome: the link to the first mate came back, replayed or not,
    // or a Mac this one controls came back in reach; live frames and changes
    // sent meanwhile went nowhere.
    const before = previous.thisMac;
    const now = state.thisMac;
    if (before !== now && now && before?.role === now.role) {
      const back =
        (now.linkBack ?? 0) > (before.linkBack ?? 0) ||
        (now.caughtUp ?? 0) > (before.caughtUp ?? 0) ||
        (now.role === "view" && changesOff(before) && !changesOff(now));
      if (back) reread = true;
    }
    if (state.cardsSnapshotLoaded && !previous.cardsSnapshotLoaded) reread = true;
    if (reread) void readAll();
  });
  void readAll();
  return sync;
}
