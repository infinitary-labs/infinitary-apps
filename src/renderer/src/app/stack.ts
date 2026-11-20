import { type Card, onStage } from "@shared/cards";
import type { PanelCardHeight, PanelCardWidth, StoreValue } from "@shared/personal/contracts";
import { arrivedInBrowser } from "../cards/browserRequest";

/**
 * The window's card stack as a pure model (docs/renderer.md): the entries it
 * holds, which of them are shown, and how a new snapshot of the cards is
 * reconciled with the reader's place. No store lives here; the store's stack
 * slice (./stackActions.ts) is its one writer.
 */

/**
 * One of a panel's cards on the stack (docs/ui-plugins.md, "A panel's
 * cards"): which panel put it up, its id within that panel, the card view
 * that draws it, and what it was last put up with. Window memory only:
 * never saved, so Hide or a relaunch lets it go.
 */
export type PanelCardEntry = {
  panel: string;
  id: string;
  view: string;
  title: string;
  width: PanelCardWidth;
  /** `fill` takes the stage's height, its view filling it and scrolling itself. */
  height: PanelCardHeight;
  data: StoreValue;
  /** How many times it was put up: 1, and one more at each revision (`card.revision`). */
  revision: number;
  /**
   * The place its card view last kept (`card.keep`), handed back to each
   * page the card is born into; a revision keeps it, and Hide lets it go.
   */
  kept: StoreValue;
  /**
   * The task its view aims the captain's next message at while it is the
   * shown entry (`point.aim`), as a shown record does; null for none.
   */
  aim: string | null;
};

/**
 * The Firstmate's reply, read whole on a note the window holds
 * (docs/composer.md "The reply note"): the captain's message it answered
 * and the reply's words, as they stood when the line was opened.
 */
export type ReplyNote = { you: string; words: string; problem: boolean };

/**
 * Shell-held views at the front of the stack; never persisted or emitted as
 * cards. A task's record, a closed card read again as a past card
 * (FI3-579), the Firstmate's reply read whole (docs/composer.md "The reply
 * note"), a task's own browser (docs/task-browser.md, "The view"), a
 * task's Crewmate tab (docs/task-card-tabs.md), or a panel's card - the
 * task board is the Tasks panel's (docs/task-board.md): one entry per task,
 * whichever of its tabs it shows, one per saved card, one reply note, and
 * any number of each panel's cards, one per card id.
 */
/** The views of a task's record entry: Info, Cards and Activity share its one frame (INF-2261). */
export type RecordView = "info" | "cards" | "activity";
export type OpenRecord =
  | { taskId: string; from?: EntryFrom; view?: RecordView }
  | { pastCardId: string }
  | { replyNote: ReplyNote }
  | { browserTaskId: string; from?: EntryFrom | BrowserViewFrom; arrived?: string }
  | { crewmateTaskId: string; from?: EntryFrom }
  | { panelCard: PanelCardEntry };
/**
 * The card one of a task's tabs was opened from (docs/task-card-tabs.md,
 * "From a card"): the key in the card's head, Show Info, Show Crewmate or
 * Show Browser on it, or its live attachment. Hide or Esc on that tab
 * returns to the card while it is still shown, and the task's next tab
 * keeps it.
 */
export type EntryFrom = { cardId: string };
/**
 * The card whose live attachment opened a browser view, and the browser it
 * names (docs/task-browser.md, "From a card"): the view says so when that
 * browser is no longer the task's, and Hide returns to the card.
 */
export type BrowserViewFrom = EntryFrom & { session: string; generation: number };
/** A local presentation entry reuses card sizing, paging and reconciliation. */
export type StackEntry = Card & {
  recordTaskId?: string;
  /** Which of the record's views it shows: Info, Cards or Activity (INF-2261); absent is Info. */
  recordView?: RecordView;
  pastCardId?: string;
  replyNote?: ReplyNote;
  browserTaskId?: string;
  browserFrom?: EntryFrom | BrowserViewFrom;
  /**
   * The newest card its task raised while the browser view was shown, which
   * docks beside its page (docs/task-browser.md, "A card beside the page").
   */
  browserArrived?: string;
  crewmateTaskId?: string;
  panelCard?: PanelCardEntry;
};

/** The one reply note's stack entry. */
export const REPLY_NOTE_ENTRY_ID = "reply-note";
/** A panel's card's stack entry, by its panel and its id there. */
export const panelCardEntryId = (panel: string, id: string) => `panel-card:${panel}/${id}`;

/** What a held entry carries beyond a card's own fields. */
type HeldEntry = Pick<StackEntry, "id"> &
  Partial<
    Pick<
      StackEntry,
      | "width"
      | "recordTaskId"
      | "recordView"
      | "pastCardId"
      | "replyNote"
      | "browserTaskId"
      | "browserFrom"
      | "browserArrived"
      | "crewmateTaskId"
      | "panelCard"
    >
  >;

/** A shell-held record's stack entry: the one place each kind of record is told apart. */
function heldEntry(held: OpenRecord): HeldEntry {
  if ("taskId" in held)
    return {
      id: `record:${held.taskId}`,
      recordTaskId: held.taskId,
      ...(held.view ? { recordView: held.view } : {}),
    };
  if ("pastCardId" in held) return { id: `past:${held.pastCardId}`, pastCardId: held.pastCardId };
  if ("replyNote" in held) return { id: REPLY_NOTE_ENTRY_ID, replyNote: held.replyNote };
  if ("browserTaskId" in held)
    // The page is 1280 wide: the view takes the stage's full width.
    return {
      id: `browser:${held.browserTaskId}`,
      browserTaskId: held.browserTaskId,
      ...(held.from ? { browserFrom: held.from } : {}),
      ...(held.arrived ? { browserArrived: held.arrived } : {}),
      width: "full",
    };
  if ("crewmateTaskId" in held)
    // A transcript reads best wide, as the browser view does.
    return {
      id: `crewmate:${held.crewmateTaskId}`,
      crewmateTaskId: held.crewmateTaskId,
      width: "full",
    };
  // As wide as its panel asked: the stack's own widths. Wide, the default, is
  // the stack's own default too - up to 800 px, giving way to the docks
  // before it folds them, as the task board and a record do.
  return {
    id: panelCardEntryId(held.panelCard.panel, held.panelCard.id),
    panelCard: held.panelCard,
    ...(held.panelCard.width === "wide" ? {} : { width: held.panelCard.width }),
  };
}

/** A shell-held record's stack entry id. */
export const heldEntryId = (held: OpenRecord): string => heldEntry(held).id;

/**
 * Whether a stack entry is shell-held (a task record, a past card, the reply
 * note, a browser view, a Crewmate tab or a panel's card), not a card.
 */
/**
 * Whether words are found in a stage entry: a card, a past card, or a task's
 * record or Crewmate tab (docs/keyboard.md, "Finding in the shown card"). A panel's card, the reply note and a task's
 * browser are not.
 */
export function cardFindable(entry: {
  panelCard?: unknown;
  browserTaskId?: string | undefined;
  replyNote?: unknown;
}): boolean {
  return !entry.panelCard && !entry.browserTaskId && !entry.replyNote;
}

export const isHeldEntry = (entry: StackEntry | undefined): boolean =>
  entry?.recordTaskId !== undefined ||
  entry?.pastCardId !== undefined ||
  entry?.replyNote !== undefined ||
  entry?.browserTaskId !== undefined ||
  entry?.crewmateTaskId !== undefined ||
  entry?.panelCard !== undefined;

/** Whether an open record is one of `taskId`'s tabs: its record, its browser or its Crewmate tab. */
export const isTaskTab = (held: OpenRecord, taskId: string): boolean =>
  ("taskId" in held && held.taskId === taskId) ||
  ("browserTaskId" in held && held.browserTaskId === taskId) ||
  ("crewmateTaskId" in held && held.crewmateTaskId === taskId);

/**
 * The card the open tab of `taskId` came from, for the tab that replaces it
 * (`goToTab`): one entry per task keeps one origin, so Hide on any of its
 * tabs returns to that card.
 */
export function taskEntryFrom(
  s: Pick<StackState, "records">,
  taskId: string,
): EntryFrom | undefined {
  const held = s.records.find((record) => isTaskTab(record, taskId));
  return held && "from" in held && held.from ? { cardId: held.from.cardId } : undefined;
}

/** One of `panel`'s open cards with `patch` applied, where it is; nothing when it is not open. */
export function patchPanelCard(
  s: Pick<StackState, "records">,
  panel: string,
  id: string,
  patch: Partial<Pick<PanelCardEntry, "kept" | "aim">>,
): Partial<Pick<StackState, "records">> {
  const at = s.records.findIndex((held) => isPanelCard(held, panel, id));
  if (at < 0) return {};
  return {
    records: s.records.map((held, index) =>
      index === at && "panelCard" in held ? { panelCard: { ...held.panelCard, ...patch } } : held,
    ),
  };
}

/** Whether an open record is one of `panel`'s cards (and, given `id`, that one). */
export function isPanelCard(
  held: OpenRecord,
  panel: string,
  id?: string,
): held is { panelCard: PanelCardEntry } {
  return (
    "panelCard" in held &&
    held.panelCard.panel === panel &&
    (id === undefined || held.panelCard.id === id)
  );
}
export function visibleStack(
  cards: Card[],
  aside: readonly string[] = [],
  records: OpenRecord[] = [],
): StackEntry[] {
  return [
    ...records.map(
      (held): StackEntry => ({
        ...heldEntry(held),
        title: "",
        meta: "",
        body: "",
        actions: [],
        status: "ready",
        createdAt: 0,
        author: "host",
        priority: 0,
      }),
    ),
    ...visibleCards(cards, aside),
  ];
}

/**
 * Cards worth showing: on the stage (not awaiting their author's first
 * close-out - the core says which, docs/card-threads.md), not minimized, and
 * not held back by this window's project filter (`heldBackCardIds`).
 */
export function visibleCards(cards: Card[], aside: readonly string[] = []): Card[] {
  return cards.filter((card) => onStage(card) && !card.minimized && !aside.includes(card.id));
}

/** The stack this window shows now: its held entries, then the cards the project focus lets through. */
export function stackOf(
  s: Pick<StackState, "cards" | "heldBackCardIds" | "records">,
): StackEntry[] {
  return visibleStack(s.cards, s.heldBackCardIds, s.records);
}

/** The entry this window shows now, if the stack is non-empty. */
export function shownEntry(
  s: Pick<StackState, "cards" | "cardIndex" | "heldBackCardIds" | "records">,
): StackEntry | undefined {
  return shownCard(s.cards, s.cardIndex, s.heldBackCardIds, s.records);
}

/** The card currently on screen, if the stack is non-empty. */
export function shownCard(
  cards: Card[],
  cardIndex: number,
  aside: readonly string[] = [],
  records: OpenRecord[] = [],
): StackEntry | undefined {
  const shown = visibleStack(cards, aside, records);
  if (shown.length === 0) return undefined;
  return shown[Math.min(Math.max(0, cardIndex), shown.length - 1)];
}

/** How many unseen cards sit before and after the shown entry, for the pager. */
export function unreadAround(
  shown: StackEntry[],
  index: number,
  unread: readonly string[],
): { before: number; after: number } {
  let before = 0;
  let after = 0;
  shown.forEach((card, i) => {
    if (!unread.includes(card.id)) return;
    if (i < index) before += 1;
    else if (i > index) after += 1;
  });
  return { before, after };
}

/**
 * Where an arrow goes from `index` on a pager of `count` entries: one step
 * `dir`, going round past either end (INF-4541), so the last entry's next is
 * the first and the first entry's previous is the last.
 */
export function pagedIndex(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (((index + dir) % count) + count) % count;
}

/**
 * The entry a press on "N new" shows (INF-4541, the phone's rule): the first
 * new entry in the pager's order besides the shown one, most important
 * first, or -1 when no other entry is new. A later press shows the next one:
 * it passes over the entries earlier presses showed (`passed`) while a new
 * one they have not shown waits, whether or not those sightings reached the
 * owner, and goes round to them only when none is left.
 */
export function newCardIndex(
  shown: readonly StackEntry[],
  index: number,
  unread: readonly string[],
  passed: readonly string[] = [],
): number {
  const isNew = (entry: StackEntry, i: number) => i !== index && unread.includes(entry.id);
  const unshown = shown.findIndex((entry, i) => isNew(entry, i) && !passed.includes(entry.id));
  return unshown >= 0 ? unshown : shown.findIndex(isNew);
}

/**
 * The entries "N new" has passed after a press from `from` brought up `to`:
 * the earlier ones still new, the one it left and the one it showed, or just
 * those two once the press went round.
 */
export function passedAfterNew(
  from: string | undefined,
  to: string,
  unread: readonly string[],
  passed: readonly string[],
): string[] {
  const kept = passed.includes(to) ? [] : passed.filter((entry) => unread.includes(entry));
  return [...new Set([...kept, ...(from === undefined ? [] : [from]), to])];
}

/** The part of the shell state the stack's reconciliation reads and writes. */
export type StackState = {
  cards: Card[];
  records: OpenRecord[];
  cardIndex: number;
  unreadCardIds: string[];
  /** Cards the project focus holds back off the stack (docs/project-focus.md). */
  heldBackCardIds: string[];
  cardsSeeded: boolean;
};

/** First card, skipping held entries; only those left falls back to the first. */
function firstCardIndex(shown: StackEntry[]): number {
  return Math.max(
    0,
    shown.findIndex((entry) => !isHeldEntry(entry)),
  );
}

/**
 * The ids to try, in order, when `left` leaves a stack shown in `ids` order:
 * the cards after it, nearest first, then those before it, nearest first -
 * the next arrow's card, and at the last card the one before it (INF-3155).
 */
export function neighboursOf(ids: readonly string[], left: string | undefined): string[] {
  const at = left === undefined ? -1 : ids.indexOf(left);
  if (at < 0) return [];
  return [...ids.slice(at + 1), ...ids.slice(0, at).reverse()];
}

/**
 * Where the stack goes when the shown card leaves it (the captain's FI3-711
 * answer, first unread anywhere, and INF-3155, stay in place): the first
 * unread card in stack order, else the card nearest after where the shown
 * card was (`neighbours`, from `neighboursOf`), else the nearest before it,
 * else the first card; a task record or past card only when no card is
 * left. A reply never moves a card (INF-770). The one rule for the stack
 * and for the successor the stage prepares (`dismissalSuccessor`). Hide
 * instead uses the first live card regardless of unread state, then the
 * first held entry.
 */
export function departureIndex(
  shown: StackEntry[],
  unread: readonly string[],
  action: "depart" | "hide" = "depart",
  neighbours: readonly string[] = [],
): number {
  if (action === "hide") return firstCardIndex(shown);
  const card = (entry: StackEntry) => !isHeldEntry(entry);
  const firstUnread = shown.findIndex((entry) => card(entry) && unread.includes(entry.id));
  if (firstUnread >= 0) return firstUnread;
  for (const id of neighbours) {
    const at = shown.findIndex((entry) => card(entry) && entry.id === id);
    if (at >= 0) return at;
  }
  const first = shown.findIndex(card);
  return first >= 0 ? first : firstCardIndex(shown);
}

/**
 * The entry a close or Hide of the shown card would bring up, by `departureIndex`
 * over the stack without it: what the stage prepares while the captain
 * reads. Never the shown entry itself; undefined when nothing would remain.
 */
export function dismissalSuccessor(
  shown: StackEntry[],
  index: number,
  unread: readonly string[],
): StackEntry | undefined {
  const leaving = shown[index];
  const rest = shown.filter((entry) => entry !== leaving);
  if (leaving && isHeldEntry(leaving)) return rest[departureIndex(rest, unread, "hide")];
  const order = shown.map((entry) => entry.id);
  return rest[departureIndex(rest, unread, "depart", neighboursOf(order, leaving?.id))];
}

/** Keep the reader on their entry; else the first card (hiding a record keeps this rule). */
export function indexKeeping(shown: StackEntry[], active: Card | undefined): number {
  const activeCardIndex = shown.findIndex((card) => card.id === active?.id);
  return activeCardIndex >= 0 ? activeCardIndex : firstCardIndex(shown);
}

/** Legacy and shell-held entries keep local selection marks; shared marks await the owner. */
export function withoutShown(
  state: Pick<StackState, "cards" | "records" | "heldBackCardIds" | "unreadCardIds">,
  cardIndex: number,
): string[] {
  const card = shownCard(state.cards, cardIndex, state.heldBackCardIds, state.records);
  if (!card || card.currentUpdateId !== undefined || !state.unreadCardIds.includes(card.id))
    return state.unreadCardIds;
  return state.unreadCardIds.filter((id) => id !== card.id);
}

/** What the project focus holds back: nothing, with no focus. */
const HOLDS_NOTHING = (_card: Card): boolean => false;

/** `next`, or `prev` when they hold the same ids in the same order. */
function sameIds(prev: string[], next: string[]): string[] {
  return prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next;
}

/** Keep local selection and project holds while applying the owner's current-update seen marks.
 * Legacy snapshots without that projection retain their window-local unread behavior.
 * `typing` says a person is typing in the shown entry, which then keeps the stage.
 */
export function reconcileStack(
  prev: StackState,
  cards: Card[],
  holdsBack: (card: Card) => boolean = HOLDS_NOTHING,
  typing = false,
): {
  state: Pick<StackState, "cardIndex" | "unreadCardIds" | "heldBackCardIds" | "cardsSeeded"> &
    Partial<Pick<StackState, "records">>;
  noticed: number;
  lostCard: boolean;
} {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const active = shownEntry(prev);
  const prevShownIds = stackOf(prev).map((card) => card.id);
  const heldBack = sameIds(
    prev.heldBackCardIds,
    visibleCards(cards)
      .filter(holdsBack)
      .map((card) => card.id),
  );
  const shown = visibleStack(cards, heldBack, prev.records);
  const prevById = new Map(prev.cards.map((card) => [card.id, card]));
  // A card whose author answered its reply is news even if it stayed
  // shown while its author worked.
  const answered = (card: Card) => {
    const before = prevById.get(card.id);
    return before !== undefined && before.awaiting !== undefined && card.awaiting === undefined;
  };
  // Neither on the stack nor held back before: new to this window.
  const isNew = (card: Card) =>
    (!prevShownIds.includes(card.id) && !prev.heldBackCardIds.includes(card.id)) || answered(card);
  const arrived = prev.cardsSeeded ? shown.filter(isNew).map((card) => card.id) : [];
  // An arrival the focus holds back is news for when it comes back, with no notice now.
  const arrivedBack = prev.cardsSeeded
    ? heldBack.filter((id) => {
        const card = byId.get(id);
        return card !== undefined && isNew(card);
      })
    : [];
  const initialUnread = prev.cardsSeeded
    ? []
    : cards.filter((card) => card.seen === false).map((card) => card.id);
  const legacyUnseen = [
    ...[...prev.unreadCardIds, ...initialUnread].filter(
      (id) => shown.some((card) => card.id === id) || heldBack.includes(id),
    ),
    ...[...arrived, ...arrivedBack].filter((id) => !prev.unreadCardIds.includes(id)),
  ];
  const shared = new Map(
    cards.filter((card) => card.currentUpdateId !== undefined).map((card) => [card.id, card]),
  );
  const unseen = [
    ...new Set([
      ...legacyUnseen.filter((id) => !shared.has(id)),
      ...cards
        .filter((card) => card.currentUpdateId !== undefined && card.currentUpdateSeen !== true)
        .map((card) => card.id),
    ]),
  ];
  // The shown card left: the first unread card comes up, else the card
  // after it, else the one before it (`departureIndex`). Records remain
  // available through paging.
  const stays = shown.findIndex((card) => card.id === active?.id);
  let cardIndex =
    stays >= 0
      ? stays
      : prev.cardsSeeded
        ? departureIndex(shown, unseen, "depart", neighboursOf(prevShownIds, active?.id))
        : firstCardIndex(shown);
  // A card the task raises while its browser view is shown arrives in the
  // view's column, beside the page, and the view keeps the stage
  // (docs/task-browser.md, "A card beside the page").
  const browserTask = active && stays >= 0 ? active.browserTaskId : undefined;
  const docking = browserTask ? arrivedInBrowser(cards, browserTask, arrived) : undefined;
  const records = docking
    ? prev.records.map((held) =>
        "browserTaskId" in held && held.browserTaskId === browserTask
          ? { ...held, arrived: docking.id }
          : held,
      )
    : undefined;
  // A declared continuity card may take the stage only when it arrives,
  // never on an unrelated push or a revision while the reader paged away,
  // and never from a shown entry a person is typing in: it waits as new.
  const forward = shown.findIndex(
    (card) =>
      !isHeldEntry(card) &&
      card.holdsPlace &&
      card.id !== docking?.id &&
      arrived.includes(card.id) &&
      !prevShownIds.includes(card.id),
  );
  if (forward >= 0 && !(typing && stays >= 0)) cardIndex = forward;
  const activeCard = shown[cardIndex];
  const activeId = activeCard?.id;
  // A docked arrival is in view: news only once the owner says it was not seen.
  const unread = unseen.filter(
    (id) => shared.has(id) || (id !== activeId && (cardIndex !== stays || id !== docking?.id)),
  );

  // Nor is a card waiting on its author's first close-out: still open, only off the stage.
  const waiting = cards.filter((card) => !onStage(card) || card.minimized).map((card) => card.id);
  const kept = new Set([...shown.map((card) => card.id), ...heldBack, ...waiting]);
  return {
    state: {
      cardIndex,
      unreadCardIds: unread,
      heldBackCardIds: heldBack,
      cardsSeeded: true,
      ...(records ? { records } : {}),
    },
    noticed: prev.cardsSeeded
      ? shown.filter(
          (card) =>
            card.id !== activeId &&
            !(cardIndex === stays && card.id === docking?.id) &&
            unread.includes(card.id) &&
            (card.currentUpdateId !== undefined
              ? prevById.get(card.id)?.currentUpdateId !== card.currentUpdateId
              : arrived.includes(card.id)),
        ).length
      : 0,
    // Whether the shown entry really departed: a project hold is not a loss, and
    // a question can close behind its retained record.
    lostCard: active !== undefined && !kept.has(active.id),
  };
}

/** `values` without `key`, as a new record. */
export function withoutKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  const next = { ...values };
  delete next[key];
  return next;
}
