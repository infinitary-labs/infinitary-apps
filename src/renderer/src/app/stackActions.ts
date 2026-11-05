import type { Card } from "@shared/cards";
import type { PanelCardEmit, StoreValue } from "@shared/personal/contracts";
import {
  DEFAULT_PANEL_CARD_HEIGHT,
  DEFAULT_PANEL_CARD_WIDTH,
  PANEL_OPEN_CARDS_MAX,
} from "@shared/plugins/panelCards";
import {
  forgetReadingPlace,
  pastReadingPlaceId,
  recordReadingPlaceId,
  retainCardReadingPlaces,
} from "../cards/cardReadingPlace";
import { requestCharacterNotice } from "../character/emoteSignal";
import { changesOff } from "../devices/viewWords";
import { pressesSoFar } from "./presses";
import { focusHoldsBack, heldProjectFocus } from "./projectFocus";
import {
  type BrowserViewFrom,
  departureIndex,
  type EntryFrom,
  heldEntryId,
  indexKeeping,
  isHeldEntry,
  isPanelCard,
  isTaskTab,
  type OpenRecord,
  type PanelCardEntry,
  panelCardEntryId,
  patchPanelCard,
  type RecordView,
  type ReplyNote,
  reconcileStack,
  shownEntry,
  stackOf,
  visibleCards,
  withoutKey,
  withoutShown,
} from "./stack";
import type { ShellGet, ShellSet, ShellState } from "./store";

/** The stack's state in the store and the actions that move it (./stack.ts is its pure model). */
export type StackSlice = {
  cards: Card[];
  /** Open shell-held records, newest opened first (one per task). */
  records: OpenRecord[];
  cardIndex: number;
  /** A task or record pointed at a card: focus the new visit once its body is ready. */
  cardFocusRequest: number;
  cardFocusTarget: string | null;
  /** The captain's presses counted when the pointing began: one begun since keeps focus where it is. */
  cardFocusPresses: number;
  /** Current-update news from the owner, with local marks only for legacy or shell-held entries. */
  unreadCardIds: string[];
  /** Cards the project focus holds back off the stack (docs/project-focus.md "The card stack"). */
  heldBackCardIds: string[];
  /** Held-back cards the captain pointed at: on the stack while the focus they were pointed under holds. */
  letThroughCardIds: string[];
  /** The focus `letThroughCardIds` were pointed under. */
  letThroughFocus: string | null;
  /** False until the first cards snapshot restores its unread cards without a notice pulse. */
  cardsSeeded: boolean;
  /**
   * The captain's drag on a card's edge, in px, by card: it holds while the
   * card is up and through its revisions, and goes with the card. Shell
   * state only - never a setting, never on the row.
   */
  cardDrags: Record<string, number>;
  /**
   * Opens or focuses one task's front stack entry, from the card `from`
   * names when it was the card's key or its Show Info (docs/task-card-tabs.md,
   * "From a card"), showing the record's `view`: Info, unless its Cards or
   * Activity tab was chosen (INF-2261).
   */
  openRecord: (taskId: string, from?: EntryFrom, view?: RecordView) => void;
  /** Opens or focuses a closed card's front stack entry, read-only (FI3-579). */
  openPastCard: (cardId: string) => void;
  /**
   * Opens the Firstmate's newest reply whole, or the older round's with
   * `"older"`, as a note the window holds at the front (docs/composer.md
   * "The reply note"); false while no such reply is kept, and nothing opens.
   */
  openReplyNote: (round?: "older") => boolean;
  /** Closes the reply note wherever it sits; the shown entry stays shown. */
  closeReplyNote: () => void;
  /**
   * Opens or focuses one task's browser view at the front (docs/task-browser.md),
   * from a card's live attachment when `from` names it ("From a card").
   */
  openBrowserView: (taskId: string, from?: EntryFrom | BrowserViewFrom) => void;
  /** Closes one task's browser view wherever it sits; its browser keeps running. */
  closeBrowserView: (taskId: string) => void;
  /**
   * Opens or focuses one task's Crewmate tab at the front, in place of its
   * record or browser view (docs/task-card-tabs.md, "The Crewmate tab"),
   * from the card `from` names when it was the card's Show Crewmate.
   */
  openCrewmateView: (taskId: string, from?: EntryFrom) => void;
  /** Closes one task's Crewmate tab wherever it sits; its crewmate is never told. */
  closeCrewmateView: (taskId: string) => void;
  /**
   * Puts one of a panel's cards up, or revises the open one with its id
   * (docs/ui-plugins.md, "A panel's cards"), and answers its id. From the
   * captain's own click or key (`front`) it comes to the front; otherwise
   * it waits behind the entry he is reading, marked new. Throws, with the
   * reason, past the panel's bound of open cards.
   */
  emitPanelCard: (panel: string, card: PanelCardEmit, front: boolean) => string;
  /** Takes one of a panel's cards off the stack wherever it sits. */
  closePanelCard: (panel: string, id: string) => void;
  /** Keeps one of `panel`'s open cards' place on its entry; an id that is not open keeps nothing. */
  keepPanelCard: (panel: string, id: string, kept: StoreValue) => void;
  /** Aims the turn while one of `panel`'s open cards is shown; an id that is not open aims nothing. */
  aimPanelCard: (panel: string, id: string, taskId: string | null) => void;
  /** Takes every card of a panel off the stack: it was removed, or the panels went off. */
  closePanelCards: (panel: string) => void;
  /** Hide or Esc: closes the shown record, past card, reply note, browser view, Crewmate tab or panel card, if one is shown. */
  closeRecord: () => void;
  /** Closes one task's record wherever it sits; the shown entry stays shown. */
  closeTaskRecord: (taskId: string) => void;
  /** Closes one past card wherever it sits; the shown entry stays shown. */
  closePastCard: (cardId: string) => void;
  /**
   * Brings a stacked card to the front; false when it is not on the stack.
   * It takes focus once it appears unless the captain began a press since
   * `since`, his presses counted when the pointing began (app/presses.ts):
   * by default, now.
   */
  focusCard: (cardId: string, since?: number) => boolean;
  applyCards: (cards: Card[]) => void;
  /** The captain dragged a card's edge; null returns it to the width the host decided. */
  dragCard: (cardId: string, width: number | null) => void;
  /** Holds back, or lets back, the cards the project focus names as it moves (docs/project-focus.md). */
  applyHold: () => void;
  prevCard: () => void;
  nextCard: () => void;
};

/** The cards the captain let through, while the focus they were pointed under still holds. */
function letThroughUnder(s: Pick<ShellState, "letThroughCardIds" | "letThroughFocus">): string[] {
  return s.letThroughFocus === heldProjectFocus() || s.letThroughCardIds.length === 0
    ? s.letThroughCardIds
    : [];
}

/** What the project focus holds back now: its other projects' cards, short of those let through. */
function holdOf(
  s: Pick<ShellState, "letThroughCardIds" | "letThroughFocus">,
): (card: Card) => boolean {
  const letThrough = letThroughUnder(s);
  return (card) => !letThrough.includes(card.id) && focusHoldsBack(card);
}

/** Puts `held` at the front of the stack, shown, in place of the records `replaces` names. */
function toFront(
  s: Pick<ShellState, "records">,
  held: OpenRecord,
  replaces: (record: OpenRecord) => boolean,
): Pick<ShellState, "records" | "cardIndex"> {
  return { records: [held, ...s.records.filter((record) => !replaces(record))], cardIndex: 0 };
}

/**
 * Takes shell-held entries (a task record, a past card, a browser view, a
 * panel's cards) off the stack: every one `match` names. The shown entry
 * stays shown unless it is one that left; then the first card comes up.
 * Holds nothing but view state.
 */
function closeHeld(s: ShellState, match: (held: OpenRecord) => boolean): Partial<ShellState> {
  const closing = s.records.filter(match);
  const first = closing[0];
  if (!first) return {};
  const closingIds = new Set(closing.map(heldEntryId));
  const entry = shownEntry(s);
  const records = s.records.filter((record) => !closing.includes(record));
  const shown = stackOf({ ...s, records });
  // A tab a card opened returns to that card while it is up.
  const opener =
    "from" in first && first.from ? shown.findIndex((card) => card.id === first.from?.cardId) : -1;
  const cardIndex =
    entry !== undefined && closingIds.has(entry.id)
      ? opener >= 0
        ? opener
        : departureIndex(shown, s.unreadCardIds, "hide")
      : indexKeeping(shown, entry);
  let cardDrags = s.cardDrags;
  for (const id of closingIds) cardDrags = withoutKey(cardDrags, id);
  return {
    records,
    cardIndex,
    cardDrags,
    unreadCardIds: withoutShown(
      { ...s, records, unreadCardIds: s.unreadCardIds.filter((id) => !closingIds.has(id)) },
      cardIndex,
    ),
    focusRequest:
      records.length === 0 && visibleCards(s.cards, s.heldBackCardIds).length === 0
        ? s.focusRequest + 1
        : s.focusRequest,
  };
}

/** A fresh id for a panel's card that names none: the first `card-<n>` none of its open ones has. */
function freshPanelCardId(open: readonly { panelCard: PanelCardEntry }[]): string {
  const taken = new Set(open.map((held) => held.panelCard.id));
  let n = open.length + 1;
  while (taken.has(`card-${n}`)) n += 1;
  return `card-${n}`;
}

/**
 * Reads the cards again and applies them, unless a push replaced the stack
 * while the read was out: that push is newer. `settled` runs in the same
 * callback, so what it sets lands in the same render as the cards.
 */
export function readCardsAgain(get: ShellGet, settled?: () => void): Promise<void> {
  const stackAtRead = get().cards;
  return window.infinitary.cards.list().then((cards) => {
    if (get().cards === stackAtRead) get().applyCards(cards);
    settled?.();
  });
}

export function stackSlice(set: ShellSet, get: ShellGet): StackSlice {
  return {
    cards: [],
    records: [],
    cardIndex: 0,
    cardFocusRequest: 0,
    cardFocusTarget: null,
    cardFocusPresses: 0,
    unreadCardIds: [],
    heldBackCardIds: [],
    letThroughCardIds: [],
    letThroughFocus: null,
    cardsSeeded: false,
    cardDrags: {},
    openRecord: (taskId, from, view) =>
      set((s) =>
        toFront(
          s,
          { taskId, ...(from ? { from } : {}), ...(view && view !== "info" ? { view } : {}) },
          // A task is one entry: its record's tab replaces its other tabs, as
          // the card's tab strip does.
          (record) => isTaskTab(record, taskId),
        ),
      ),
    openPastCard: (cardId) =>
      set((s) =>
        toFront(
          s,
          { pastCardId: cardId },
          (record) => "pastCardId" in record && record.pastCardId === cardId,
        ),
      ),
    openReplyNote: (round) => {
      const newest = get().lastTurn;
      const turn = round === "older" ? newest?.previous : newest;
      if (!turn?.reply) return false;
      const replyNote: ReplyNote = {
        you: turn.you,
        words: turn.reply.words ?? turn.reply.text,
        problem: turn.reply.problem === true,
      };
      // One reply note: opening it again shows the newest reply at the front.
      set((s) => toFront(s, { replyNote }, (record) => "replyNote" in record));
      return true;
    },
    closeReplyNote: () => set((s) => closeHeld(s, (record) => "replyNote" in record)),
    openBrowserView: (taskId, from) =>
      set((s) =>
        toFront(
          s,
          { browserTaskId: taskId, ...(from ? { from } : {}) },
          // One entry per task: the browser's tab replaces its other tabs.
          (record) => isTaskTab(record, taskId),
        ),
      ),
    closeBrowserView: (taskId) =>
      set((s) =>
        closeHeld(s, (record) => "browserTaskId" in record && record.browserTaskId === taskId),
      ),
    openCrewmateView: (taskId, from) =>
      set((s) =>
        toFront(
          s,
          { crewmateTaskId: taskId, ...(from ? { from } : {}) },
          // One entry per task: the Crewmate tab replaces its other tabs.
          (record) => isTaskTab(record, taskId),
        ),
      ),
    closeCrewmateView: (taskId) =>
      set((s) =>
        closeHeld(s, (record) => "crewmateTaskId" in record && record.crewmateTaskId === taskId),
      ),
    emitPanelCard: (panel, card, front) => {
      const before = get();
      const open = before.records.filter((held) => isPanelCard(held, panel));
      const id = card.id ?? freshPanelCardId(open);
      const revised = open.find((held) => held.panelCard.id === id);
      const revising = revised !== undefined;
      if (!revising && open.length >= PANEL_OPEN_CARDS_MAX) {
        throw new Error(
          `this panel already has ${PANEL_OPEN_CARDS_MAX} cards open; close one with cards.close first`,
        );
      }
      const entry: PanelCardEntry = {
        panel,
        id,
        view: card.view,
        title: card.title,
        width: card.width ?? DEFAULT_PANEL_CARD_WIDTH,
        height: card.height ?? DEFAULT_PANEL_CARD_HEIGHT,
        data: card.data ?? null,
        // A revision is heard by its view as one more time it was put up,
        // whether or not its data moved.
        revision: (revised?.panelCard.revision ?? 0) + 1,
        // A revision is the same card: its place and its aim stay until Hide.
        kept: revised?.panelCard.kept ?? null,
        aim: revised?.panelCard.aim ?? null,
      };
      set((s) => {
        const entryId = panelCardEntryId(panel, id);
        const at = s.records.findIndex((held) => isPanelCard(held, panel, id));
        const active = shownEntry(s);
        if (front) {
          // The captain's own click or key: at the front, shown, seen.
          return {
            ...toFront(s, { panelCard: entry }, (held) => isPanelCard(held, panel, id)),
            unreadCardIds: s.unreadCardIds.filter((unread) => unread !== entryId),
          };
        }
        if (at >= 0) {
          // Revised in place: where it is, as it is, with its new data.
          const records = s.records.map((held, index) =>
            index === at ? { panelCard: entry } : held,
          );
          return { records };
        }
        // Raised on its own: behind the entry he is reading, marked new.
        const records: OpenRecord[] = [{ panelCard: entry }, ...s.records];
        const shown = stackOf({ ...s, records });
        const cardIndex = active ? indexKeeping(shown, active) : 0;
        return {
          records,
          cardIndex,
          unreadCardIds:
            shown[cardIndex]?.id === entryId ? s.unreadCardIds : [...s.unreadCardIds, entryId],
        };
      });
      return id;
    },
    closePanelCard: (panel, id) => set((s) => closeHeld(s, (held) => isPanelCard(held, panel, id))),
    closePanelCards: (panel) => set((s) => closeHeld(s, (held) => isPanelCard(held, panel))),
    keepPanelCard: (panel, id, kept) => set((s) => patchPanelCard(s, panel, id, { kept })),
    aimPanelCard: (panel, id, aim) => set((s) => patchPanelCard(s, panel, id, { aim })),
    closeRecord: () => {
      const entry = shownEntry(get());
      // A record and a past card each let go of their reading place as they close.
      if (entry?.recordTaskId) get().closeTaskRecord(entry.recordTaskId);
      else if (entry?.pastCardId) get().closePastCard(entry.pastCardId);
      else if (entry && isHeldEntry(entry))
        set((s) => closeHeld(s, (held) => heldEntryId(held) === entry.id));
    },
    closeTaskRecord: (taskId) => {
      forgetReadingPlace(recordReadingPlaceId(taskId));
      set((s) => closeHeld(s, (record) => "taskId" in record && record.taskId === taskId));
    },
    closePastCard: (cardId) => {
      forgetReadingPlace(pastReadingPlaceId(cardId));
      set((s) => closeHeld(s, (record) => "pastCardId" in record && record.pastCardId === cardId));
    },
    focusCard: (cardId, since = pressesSoFar()) => {
      const minimized = get().cards.find((card) => card.id === cardId)?.minimized;
      if (minimized) {
        if (changesOff(get().thisMac)) return false;
        // The shared owner accepts the restore before this window shows it.
        void window.infinitary.cards
          .minimize(cardId, false)
          .then(() => readCardsAgain(get))
          .then(() => {
            get().focusCard(cardId, since);
          })
          .catch((error: unknown) => {
            set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: String(error) } }));
          });
        return true;
      }
      // Pointing at a card the focus holds back lets it through while that
      // focus holds (docs/project-focus.md "The card stack").
      const now = get();
      const heldBackCardIds = now.heldBackCardIds.filter((id) => id !== cardId);
      const index = stackOf({ ...now, heldBackCardIds }).findIndex((card) => card.id === cardId);
      if (index < 0) return false;
      const letThrough = letThroughUnder(now);
      set((s) => ({
        cardIndex: index,
        cardFocusRequest: s.cardFocusRequest + 1,
        cardFocusTarget: cardId,
        cardFocusPresses: since,
        heldBackCardIds,
        ...(heldBackCardIds.length < s.heldBackCardIds.length
          ? { letThroughCardIds: [...letThrough, cardId], letThroughFocus: heldProjectFocus() }
          : {}),
        unreadCardIds: s.unreadCardIds.filter(
          (id) =>
            id !== cardId || s.cards.find((card) => card.id === id)?.currentUpdateId !== undefined,
        ),
      }));
      return true;
    },
    applyCards: (cards) => {
      retainCardReadingPlaces(new Set(cards.map((card) => card.id)));
      let noticed = 0;
      set((s) => {
        const reconciled = reconcileStack(s, cards, holdOf(s));
        noticed = reconciled.noticed;
        const present = new Set(cards.map((card) => card.id));
        return {
          cards,
          ...reconciled.state,
          pendingCardActions: Object.fromEntries(
            Object.entries(s.pendingCardActions).filter(([id]) => present.has(id)),
          ),
          cardActionErrors: Object.fromEntries(
            Object.entries(s.cardActionErrors).filter(([id]) => present.has(id)),
          ),
          cardAnswers: Object.fromEntries(
            Object.entries(s.cardAnswers).filter(([id]) => present.has(id)),
          ),
          cardDrags: Object.fromEntries(
            Object.entries(s.cardDrags).filter(
              ([id]) => present.has(id) || s.records.some((r) => id === heldEntryId(r)),
            ),
          ),
          closedThreadIds: s.closedThreadIds.filter((id) => present.has(id)),
          focusRequest: reconciled.lostCard ? s.focusRequest + 1 : s.focusRequest,
        };
      });
      // A card landed behind the shown one: the character's notice pulse, a
      // side channel like the emotes - never shell state.
      if (noticed > 0) requestCharacterNotice();
    },
    dragCard: (cardId, width) =>
      set((s) =>
        width === null
          ? { cardDrags: withoutKey(s.cardDrags, cardId) }
          : { cardDrags: { ...s.cardDrags, [cardId]: width } },
      ),
    applyHold: () => {
      set((s) => {
        // Before the first cards snapshot there is no stack to hold.
        if (!s.cardsSeeded) return s;
        const letThrough = letThroughUnder(s);
        const held = { letThroughCardIds: letThrough, letThroughFocus: heldProjectFocus() };
        const { state, lostCard } = reconcileStack(s, s.cards, holdOf(held));
        // The focus store speaks on every rest in the pill row: unchanged, nothing is written.
        if (state.heldBackCardIds === s.heldBackCardIds && letThrough === s.letThroughCardIds) {
          return s;
        }
        return {
          ...state,
          ...held,
          focusRequest: lostCard ? s.focusRequest + 1 : s.focusRequest,
        };
      });
    },
    prevCard: () =>
      set((s) => {
        const cardIndex = Math.max(0, s.cardIndex - 1);
        return { cardIndex, unreadCardIds: withoutShown(s, cardIndex) };
      }),
    nextCard: () =>
      set((s) => {
        const last = stackOf(s).length - 1;
        const cardIndex = Math.min(last, s.cardIndex + 1);
        return { cardIndex, unreadCardIds: withoutShown(s, cardIndex) };
      }),
  };
}
