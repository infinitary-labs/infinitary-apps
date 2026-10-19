import type {
  Card,
  CardActionSource,
  CardAnswer,
  CardMessage,
  CardSubmission,
  DeviceArrival,
} from "@shared/cards";
import {
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_QUESTIONS_MAX_BYTES,
  CARD_REPLY_MAX_CHARS,
  CONVERSE_TEXT_MAX_CHARS,
  cardAnswersBytes,
  cardQuestionsBytes,
  deviceArrival,
  onStage,
  TURN_IMAGES_MAX,
} from "@shared/cards";
import {
  type ComposerNotice,
  composeTurnText,
  type PastedText,
  pasteRefusal,
} from "@shared/composer";
import type { ThisMac } from "@shared/devices";
import type { DictationSettings } from "@shared/dictation";
import type { FmEvent } from "@shared/events";
import type { CrewWord, FirstRunView } from "@shared/firstRun";
import type { LastTurn } from "@shared/lastTurn";
import type {
  PanelCardEmit,
  PanelCardHeight,
  PanelCardWidth,
  StoreValue,
} from "@shared/personal/contracts";
import type { FrameAnswers } from "@shared/plugins/bridge";
import {
  DEFAULT_PANEL_CARD_HEIGHT,
  DEFAULT_PANEL_CARD_WIDTH,
  PANEL_OPEN_CARDS_MAX,
} from "@shared/plugins/panelCards";
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  type DefaultCardSize,
  type Theme,
  type UiSize,
} from "@shared/preferences";
import type { ReleaseNotesView } from "@shared/releaseTracking";
import type { UsageUnit } from "@shared/usage";
import { create } from "zustand";
import { isPreparing, MAIN_FILES_KEY, whenPrepared } from "../attachments/intake";
import { retainCardReadingPlaces } from "../cards/cardReadingPlace";
import {
  applyCrewDependencies,
  applyCrewEvent,
  crewOrbit,
  seedCrew,
} from "../character/crew/crewSignal";
import { requestCharacterEmote, requestCharacterNotice } from "../character/emoteSignal";
import { stageNow } from "../character/stageClock";
import type { ImageAttachment } from "../design";
import { changesOff, changesOffWords, doneThereWords, isView } from "../devices/viewWords";
import { resyncReads } from "../plugins/reads/resync";
import { SettingSave } from "../settings/settingSave";
import { type MicLine, readMicAccess, settledMicLine } from "../voice/micAccess";
import { voiceController } from "../voice/voiceController";
import { detectVoiceSupport, insertVoiceTranscript } from "../voice/voiceInput";
import { recognizerPlace } from "../voice/whisperClient";

/**
 * Shell state on real orchestrator data. The phase model matches the design
 * (idle -> recording -> thinking -> working). Working is the card-up layout;
 * thinking is Firstmate mid-turn; crew work never heats the character (a
 * working crewmate heats only its own glyph in the orbit).
 */
export type ShellPhase = "idle" | "recording" | "thinking" | "working";
export type ShellView = "home" | "settings";
/**
 * The theme is a persisted PREFERENCE, not window state: it is defined and
 * held by the core (src/shared/preferences.ts) and only mirrored here so the
 * tree can read it synchronously.
 */
export type { Theme };

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
 * Shell-held views at the front of the stack; never persisted or emitted as
 * cards. A task's record, a closed card read again as a past card
 * (FI3-579), a task's own browser (docs/task-browser.md, "The view"), a
 * task's Crewmate tab (docs/task-card-tabs.md), or a panel's card - the
 * task board is the Tasks panel's (docs/task-board.md): one entry per task,
 * whichever of its tabs it shows, one per saved card, and any number of
 * each panel's cards, one per card id.
 */
export type OpenRecord =
  | { taskId: string; from?: EntryFrom }
  | { pastCardId: string }
  | { browserTaskId: string; from?: EntryFrom | BrowserViewFrom }
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
  pastCardId?: string;
  browserTaskId?: string;
  browserFrom?: EntryFrom | BrowserViewFrom;
  crewmateTaskId?: string;
  panelCard?: PanelCardEntry;
};
const recordEntryId = (taskId: string) => `record:${taskId}`;
const pastEntryId = (cardId: string) => `past:${cardId}`;
const browserEntryId = (taskId: string) => `browser:${taskId}`;
const crewmateEntryId = (taskId: string) => `crewmate:${taskId}`;
/** A panel's card's stack entry, by its panel and its id there. */
export const panelCardEntryId = (panel: string, id: string) => `panel-card:${panel}/${id}`;
const heldEntryId = (held: OpenRecord) =>
  "taskId" in held
    ? recordEntryId(held.taskId)
    : "pastCardId" in held
      ? pastEntryId(held.pastCardId)
      : "browserTaskId" in held
        ? browserEntryId(held.browserTaskId)
        : "crewmateTaskId" in held
          ? crewmateEntryId(held.crewmateTaskId)
          : panelCardEntryId(held.panelCard.panel, held.panelCard.id);
/**
 * Whether a stack entry is shell-held (a task record, a past card, a browser
 * view, a Crewmate tab or a panel's card), not a card.
 */
export const isHeldEntry = (entry: StackEntry | undefined): boolean =>
  entry?.recordTaskId !== undefined ||
  entry?.pastCardId !== undefined ||
  entry?.browserTaskId !== undefined ||
  entry?.crewmateTaskId !== undefined ||
  entry?.panelCard !== undefined;

/** Whether an open record is one of `taskId`'s tabs: its record, its browser or its Crewmate tab. */
const isTaskTab = (held: OpenRecord, taskId: string): boolean =>
  ("taskId" in held && held.taskId === taskId) ||
  ("browserTaskId" in held && held.browserTaskId === taskId) ||
  ("crewmateTaskId" in held && held.crewmateTaskId === taskId);

/**
 * The card the open tab of `taskId` came from, for the tab that replaces it
 * (`goToTab`): one entry per task keeps one origin, so Hide on any of its
 * tabs returns to that card.
 */
export function taskEntryFrom(
  s: Pick<ShellState, "records">,
  taskId: string,
): EntryFrom | undefined {
  const held = s.records.find((record) => isTaskTab(record, taskId));
  return held && "from" in held && held.from ? { cardId: held.from.cardId } : undefined;
}

/** One of `panel`'s open cards with `patch` applied, where it is; nothing when it is not open. */
function patchPanelCard(
  s: Pick<ShellState, "records">,
  panel: string,
  id: string,
  patch: Partial<Pick<PanelCardEntry, "kept" | "aim">>,
): Partial<Pick<ShellState, "records">> {
  const at = s.records.findIndex((held) => isPanelCard(held, panel, id));
  if (at < 0) return {};
  return {
    records: s.records.map((held, index) =>
      index === at && "panelCard" in held ? { panelCard: { ...held.panelCard, ...patch } } : held,
    ),
  };
}

/** Whether an open record is one of `panel`'s cards (and, given `id`, that one). */
function isPanelCard(
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
  collapsed: readonly string[] = [],
  records: OpenRecord[] = [],
): StackEntry[] {
  return [
    ...records.map(
      (held): StackEntry => ({
        id: heldEntryId(held),
        ...("taskId" in held
          ? { recordTaskId: held.taskId }
          : "pastCardId" in held
            ? { pastCardId: held.pastCardId }
            : "browserTaskId" in held
              ? // The page is 1280 wide: the view takes the stage's full width.
                {
                  browserTaskId: held.browserTaskId,
                  ...(held.from ? { browserFrom: held.from } : {}),
                  width: "full" as const,
                }
              : "crewmateTaskId" in held
                ? // A transcript reads best wide, as the browser view does.
                  { crewmateTaskId: held.crewmateTaskId, width: "full" as const }
                : // As wide as its panel asked: the stack's own widths. Wide, the
                  // default, is the stack's own default too - up to 800 px,
                  // giving way to the docks before it folds them, as the task
                  // board and a record do.
                  {
                    panelCard: held.panelCard,
                    ...(held.panelCard.width === "wide" ? {} : { width: held.panelCard.width }),
                  }),
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
    ...visibleCards(cards, collapsed),
  ];
}

/**
 * Stack visibility (WI-18): a note the captain has already seen, raised on
 * a task, collapses out of the stack into its task record once it is this
 * old. The card itself stays open in the core (its answer already lives on
 * the record's timeline); only the stack stops showing it. An unseen note
 * never collapses - a new card is never gone unseen.
 */
export const NOTE_COLLAPSE_MS = 15 * 60_000;
/** How often the shell looks for notes that have aged past the threshold. */
export const NOTE_COLLAPSE_TICK_MS = 60_000;

/**
 * Cards worth showing: on the stage (not awaiting their author's first
 * close-out - the core says which, docs/card-threads.md) and not collapsed.
 */
export function visibleCards(cards: Card[], collapsed: readonly string[] = []): Card[] {
  return cards.filter((card) => onStage(card) && !card.minimized && !collapsed.includes(card.id));
}

/** The card currently on screen, if the stack is non-empty. */
export function shownCard(
  cards: Card[],
  cardIndex: number,
  collapsed: readonly string[] = [],
  records: OpenRecord[] = [],
): StackEntry | undefined {
  const shown = visibleStack(cards, collapsed, records);
  if (shown.length === 0) return undefined;
  return shown[Math.min(Math.max(0, cardIndex), shown.length - 1)];
}

/**
 * Whether the main input takes nothing - no typing, files, focus or
 * hold-to-talk (docs/first-launch.md): while the first-launch gate is up,
 * and before the first read of it settles, when nobody knows yet whether a
 * fresh profile's gate is up.
 */
export function mainInputHeld(s: Pick<ShellState, "firstRun" | "firstRunSettled">): boolean {
  return !s.firstRunSettled || s.firstRun?.gateOpen === true;
}

/**
 * Why focus cannot go to the main message now, in the words a person reads
 * (docs/keyboard.md), or null: a recording, the dictation key's pick and a
 * held main input (`mainInputHeld`) hold the keys.
 */
export function mainMessageRefusal(
  s: Pick<ShellState, "recording" | "pickingDictationKey" | "firstRun" | "firstRunSettled">,
): string | null {
  if (s.pickingDictationKey) return "Settings is waiting for a dictation key";
  if (s.recording) return "A recording is running";
  if (s.firstRun?.gateOpen === true) return "Connect a subscription first";
  if (mainInputHeld(s)) return "Infinitary is still starting";
  return null;
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

/** Any stack entry claims the Working layout; recording keeps its input state. */
export function derivePhase(
  recording: boolean,
  cards: Card[],
  firstmateBusy: boolean,
  collapsed: readonly string[] = [],
  records: OpenRecord[] = [],
): ShellPhase {
  if (recording) return "recording";
  if (visibleStack(cards, collapsed, records).length > 0) return "working";
  if (firstmateBusy) return "thinking";
  return "idle";
}

/** The part of the shell state the stack's reconciliation reads and writes. */
type StackState = {
  cards: Card[];
  records: OpenRecord[];
  cardIndex: number;
  unreadCardIds: string[];
  collapsedCardIds: string[];
  /** Per collapsed id, what the card said when it collapsed (`cardDigest`). */
  collapsedDigests: Record<string, string>;
  cardsSeeded: boolean;
};

/**
 * What a card says, for telling whether a collapsed card changed since it
 * collapsed: its title, body, and action ids. Streaming state and priority
 * are presentation, not content.
 */
export function cardDigest(card: Pick<Card, "title" | "body" | "actions">): string {
  return JSON.stringify([card.title, card.body, card.actions.map((action) => action.id)]);
}

/** First card, skipping held entries; only those left falls back to the first. */
function firstCardIndex(shown: StackEntry[]): number {
  return Math.max(
    0,
    shown.findIndex((entry) => !isHeldEntry(entry)),
  );
}

/**
 * Where the stack goes when the shown card leaves it (the captain's FI3-711
 * answers: first unread anywhere, and the same rule for a reply). The first
 * unread card in stack order, else the first card; a task record or past
 * card only when no card is left. A card a reply is sending back
 * (`leaving`) is passed over while another card remains, and stays shown
 * when it is the only one. The one rule for the stack and for the
 * successor the stage prepares (`dismissalSuccessor`). Hide instead uses
 * the first live card regardless of unread state, then the first held entry.
 */
export function departureIndex(
  shown: StackEntry[],
  unread: readonly string[],
  leaving?: string,
  action: "depart" | "hide" = "depart",
): number {
  if (action === "hide") return firstCardIndex(shown);
  const card = (entry: StackEntry) => !isHeldEntry(entry) && entry.id !== leaving;
  const firstUnread = shown.findIndex((entry) => card(entry) && unread.includes(entry.id));
  if (firstUnread >= 0) return firstUnread;
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
  return rest[
    departureIndex(rest, unread, undefined, leaving && isHeldEntry(leaving) ? "hide" : "depart")
  ];
}

/** Keep the reader on their entry; else the first card (hiding a record keeps this rule). */
function indexKeeping(shown: StackEntry[], active: Card | undefined): number {
  const activeCardIndex = shown.findIndex((card) => card.id === active?.id);
  return activeCardIndex >= 0 ? activeCardIndex : firstCardIndex(shown);
}

/** Whatever is on screen at `cardIndex` has now been seen. */
function withoutShown(
  state: Pick<StackState, "cards" | "records" | "collapsedCardIds" | "unreadCardIds">,
  cardIndex: number,
): string[] {
  const card = shownCard(state.cards, cardIndex, state.collapsedCardIds, state.records);
  if (!card || !state.unreadCardIds.includes(card.id)) return state.unreadCardIds;
  return state.unreadCardIds.filter((id) => id !== card.id);
}

/**
 * One reconciliation of the stack against a cards snapshot at `now`: the
 * shown entry stays shown (a new card never steals it), a card that joins
 * the visible stack behind it is unread until it is paged to, and a seen,
 * aged note on a task collapses into its record. A collapsed card whose
 * content changed since it collapsed (an emitter revised it in place, WI-12)
 * is news again: it returns to the stack unread, like an arrival - and so
 * does a card whose author closed out after the captain's reply (the core's
 * `awaiting` cleared). When the shown card leaves, or a reply sent under it
 * takes it off the stack, `departureIndex`
 * picks what comes up: the first unread card, else the first card; a lone
 * card stays. The first snapshot
 * seeds the stack: what was already there at boot is not news.
 * `noticed` counts the cards that just became unread, for the character's
 * notice pulse.
 */
export function reconcileStack(
  prev: StackState,
  cards: Card[],
  now: number,
): {
  state: Pick<
    StackState,
    "cardIndex" | "unreadCardIds" | "collapsedCardIds" | "collapsedDigests" | "cardsSeeded"
  >;
  noticed: number;
  lostCard: boolean;
} {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const active = shownCard(prev.cards, prev.cardIndex, prev.collapsedCardIds, prev.records);
  const prevShownIds = visibleStack(prev.cards, prev.collapsedCardIds, prev.records).map(
    (card) => card.id,
  );
  // Still collapsed: present, and saying what it said when it collapsed.
  let collapsed = prev.collapsedCardIds.filter((id) => {
    const card = byId.get(id);
    return card !== undefined && prev.collapsedDigests[id] === cardDigest(card);
  });
  let shown = visibleStack(cards, collapsed, prev.records);
  const prevById = new Map(prev.cards.map((card) => [card.id, card]));
  // A card whose author answered its reply is news even if it stayed
  // shown while its author worked.
  const answered = (card: Card) => {
    const before = prevById.get(card.id);
    return before !== undefined && before.awaiting !== undefined && card.awaiting === undefined;
  };
  const arrived = prev.cardsSeeded
    ? shown
        .filter((card) => !prevShownIds.includes(card.id) || answered(card))
        .map((card) => card.id)
    : [];
  const unseen = [
    ...prev.unreadCardIds.filter((id) => shown.some((card) => card.id === id)),
    ...arrived.filter((id) => !prev.unreadCardIds.includes(id)),
  ];
  // The shown card left: the first unread card comes up, else the first
  // card (`departureIndex`). Records remain available through paging.
  const stays = shown.findIndex((card) => card.id === active?.id);
  let cardIndex = stays >= 0 ? stays : departureIndex(shown, unseen);
  // A declared continuity card may take the stage only when it arrives,
  // never on an unrelated push or a revision while the reader paged away.
  const forward = shown.findIndex(
    (card) =>
      !isHeldEntry(card) &&
      card.holdsPlace &&
      arrived.includes(card.id) &&
      !prevShownIds.includes(card.id),
  );
  if (forward >= 0) cardIndex = forward;
  const activeCard = shown[cardIndex];
  const activeId = activeCard?.id;
  const unread = unseen.filter((id) => id !== activeId);

  // A note is a card with no actions (one card shape, cards/tasks/agents P1).
  const aged = shown.filter(
    (card) =>
      !isHeldEntry(card) &&
      card.actions.length === 0 &&
      card.taskId !== undefined &&
      card.id !== activeId &&
      card.awaiting === undefined &&
      !unread.includes(card.id) &&
      now - card.createdAt >= NOTE_COLLAPSE_MS,
  );
  if (aged.length > 0) {
    collapsed = [...collapsed, ...aged.map((card) => card.id)];
    shown = visibleStack(cards, collapsed, prev.records);
    cardIndex = indexKeeping(shown, activeCard);
  }

  const collapsedDigests = Object.fromEntries(
    collapsed.map((id) => [id, prev.collapsedDigests[id] ?? cardDigest(byId.get(id) as Card)]),
  );
  // Nor is a card waiting on its author's first close-out: still open, only off the stage.
  const waiting = cards.filter((card) => !onStage(card) || card.minimized).map((card) => card.id);
  const kept = new Set([...shown.map((card) => card.id), ...collapsed, ...waiting]);
  return {
    state: {
      cardIndex,
      unreadCardIds: unread,
      collapsedCardIds: collapsed,
      collapsedDigests,
      cardsSeeded: true,
    },
    noticed: arrived.filter((id) => unread.includes(id)).length,
    // A collapse is not a loss: only a card that really left takes focus back.
    lostCard: prevShownIds.some((id) => !kept.has(id)),
  };
}

/** One appearance choice, named as the control that writes it. */
export type AppearanceChoice = keyof Appearance;

export type ShellState = {
  theme: Theme;
  defaultCardSize: DefaultCardSize;
  setDefaultCardSize: (size: DefaultCardSize) => void;
  size: UiSize;
  setSize: (size: UiSize) => void;
  washStrength: number;
  showCrewModelNames: boolean;
  /** How Settings → Usage shows every amount, remembered by the core (docs/usage.md). */
  usageUnit: UsageUnit;
  /**
   * Why the last appearance write was refused, beside the control that made
   * it, while the window shows the saved look again. The next write clears it.
   */
  appearanceError: { choice: AppearanceChoice; message: string } | null;
  /** The core's saved look, pushed or read: the one way it reaches the window. */
  applyAppearance: (appearance: Appearance) => void;
  /** Reads the saved look again, as each Settings view that shows it opens. */
  refreshAppearance: () => void;
  view: ShellView;
  phase: ShellPhase;
  recording: boolean;
  cards: Card[];
  /** Set before invoking IPC: footer and embedded actions share one guard. */
  pendingCardActions: Record<string, { actionId: string }>;
  cardActionErrors: Record<string, string>;
  /**
   * The latest reading of each card body's own form (inline decisions,
   * contract 4.22): the count the footer shows and the answers, which are
   * the draft a revised body gets back by name. Renderer memory, like the
   * reply draft: a restart loses it and the card's proposals return (the
   * captain's Q4 A).
   */
  cardAnswers: Record<string, FrameAnswers>;
  /** Last accepted send, kept across revisions but retired with its card. */
  sentCardAnswers: Record<string, CardAnswer[]>;
  /** Open shell-held records, newest opened first (one per task). */
  records: OpenRecord[];
  cardIndex: number;
  /** A task or record pointed at a card: focus the new visit once its body is ready. */
  cardFocusRequest: number;
  cardFocusTarget: string | null;
  /** Cards that joined the stack behind the shown one and were never shown (WI-18). */
  unreadCardIds: string[];
  /** Seen, aged notes collapsed out of the stack into their task records (WI-18). */
  collapsedCardIds: string[];
  /** What each collapsed card said when it collapsed: a change brings it back unread. */
  collapsedDigests: Record<string, string>;
  /** False until the first cards snapshot: the boot stack is not news. */
  cardsSeeded: boolean;
  /**
   * Cards as threads (phase 1): each card's messages, oldest first, read
   * once when the card comes up and kept live by the core's own push.
   * A card with no entry has not been read yet; an empty array is a card
   * with no thread.
   */
  threads: Record<string, CardMessage[]>;
  /** Initial history determines the destination layout before a body is born. */
  threadsLoaded: Record<string, true>;
  /**
   * The shown card a reply in flight is taking off the stack while another
   * card remains, and how many thread messages it had when the reply left.
   * It keeps that layout until the stack moves on, so its thread never opens
   * for a moment on its way out (FI3-711).
   */
  replyLeaving: { cardId: string; messages: number } | null;
  /** What the captain has typed under each card and not yet sent. */
  replyDrafts: Record<string, string>;
  /** Replies in flight, by card: the send control's own guard. */
  sendingReplies: Record<string, true>;
  /** A rejected reply, by card, shown under the row until the next keystroke. */
  replyErrors: Record<string, string>;
  replyNotices: Record<string, ComposerNotice>;
  /** Pasted pictures waiting to ride the next reply, by card. */
  replyPastes: Record<string, PastedText[]>;
  attachReplyPaste: (cardId: string, text: string, name?: string) => void;
  removeReplyPaste: (cardId: string, id: string) => void;
  replyImages: Record<string, ImageAttachment[]>;
  /**
   * Cards whose thread the captain collapsed into the card (FI3-1130). The
   * messages stay on the record; only this window stops showing them beside
   * the card, and the reply row returns to the foot of the card with the
   * thread's latest line above it. Shell state only, and it goes with the
   * card, like a drag.
   */
  closedThreadIds: string[];
  /**
   * The captain's drag on a card's edge, in px, by card: it holds while the
   * card is up and through its revisions, and goes with the card. Shell
   * state only - never a setting, never on the row.
   */
  cardDrags: Record<string, number>;
  inputText: string;
  attachments: ImageAttachment[];
  /** Long pastes held as chips until the turn leaves (docs/composer.md); compose state only. */
  pastes: PastedText[];
  /**
   * Where the caret last was in the composer, so a transcript lands there
   * (docs/composer.md, "Voice"). null until the field reports one: the end.
   */
  inputCaret: number | null;
  /**
   * The words the last `beginDraft` put at the head of the message box: the
   * next one replaces them while the box still starts with them, so a
   * second starter's words never sit in front of the first's.
   */
  draftLead: string | null;
  /**
   * Why the composer kept a draft or refused a paste, shown under the input
   * until closed or the next turn leaves. Nothing typed or pasted is ever
   * dropped without it.
   */
  composerNotice: ComposerNotice | null;
  /**
   * The recall slot: the last turn sent, in memory only. A send that fails
   * while a newer draft is in the composer stays here rather than overwrite
   * that draft.
   */
  lastSent: { text: string; pastes: PastedText[]; attachments: ImageAttachment[] } | null;
  /** Monotonic counter; keystrokes kick the listening spin. */
  kick: number;
  /** Monotonic counter; each sent turn plays the character's intake. */
  submitted: number;
  /** The Firstmate agent is mid-turn (drives the thinking phase). */
  firstmateBusy: boolean;
  /** Active work-task activity, keyed for card-thread indicators. */
  crewActivity: Record<string, import("@shared/tasks").TaskView["activity"]>;
  /** The saved choice; no capture or key interception until it is read. */
  dictation: DictationSettings | null;
  pickingDictationKey: boolean;
  /** Keyboard settings is recording a key: the window's keys run nothing (docs/keyboard.md). */
  recordingKeys: boolean;
  /**
   * The release notes the app showed, newest first, and the version running
   * now (docs/release-notes.md "Reading a note again"); null until read.
   */
  releaseNotes: ReleaseNotesView | null;
  voiceGeneration: number;
  applyDictation: (setting: DictationSettings) => void;
  /** null until the WebGPU/mic capability check settles (D-10 gate). */
  voiceSupported: boolean | null;
  /**
   * Incremented when a card closes, voice text arrives, a turn is sent, or
   * the captain goes to the main message, so HomePrompt can focus the input.
   */
  focusRequest: number;
  /**
   * Where the caret goes with focus request `request` (a transcript, a
   * recalled or restored turn, an inlined paste); every other request, a
   * card closing say, keeps the selection where it was.
   */
  focusCaret: { request: number; at: number } | null;
  /**
   * A focus request that is only a way back (`focusMainMessage`'s
   * `yields`): it gives way to a control that took focus in the same
   * render, such as the close question a command from search asked.
   */
  focusYields: number | null;
  voiceModelReady: boolean | null;
  /**
   * The first-launch state (docs/first-launch.md): null until read. While
   * the gate is open the stage carries the caption and the input is
   * disabled; the two stamps drive the input's hint.
   */
  firstRun: FirstRunView | null;
  /**
   * Whether the first read of `firstRun` has settled, answered or not.
   * Until it has, the main input takes nothing (`mainInputHeld`): a fresh
   * profile's gate may be up, and a turn sent then would skip its welcome.
   */
  firstRunSettled: boolean;
  /**
   * The last turn above the input (./LastTurn, docs/composer.md "The last
   * turn"): the captain's newest message and the Firstmate's reply line.
   * Read from the core as the window opens; `user_turn` and
   * `firstmate_reply` keep it after that.
   */
  lastTurn: LastTurn | null;
  /** The messages this window saw sent, so a new one enters as a new pair. */
  lastTurnSeq: number;
  /** Replies this window saw, so a repeated line still starts a fresh fade. */
  lastTurnReplySeq: number;
  voiceNotice:
    | null
    | { kind: "consent" }
    | { kind: "download"; fraction: number }
    | { kind: "error"; message: string }
    | { kind: "mic"; line: MicLine };
  transcribing: boolean;
  initialized: boolean;
  /** Boot cards are present without an entrance; later shown surfaces may reveal. */
  cardsSnapshotLoaded: boolean;
  bootCardId: string | null;
  /**
   * Settings section to select when opening Settings (the restore card
   * lands on Subscriptions so the sign-in notice has a home).
   */
  settingsSection: string | null;
  /**
   * What a Settings section shows on arrival, named by a panel's
   * `point.openSettings` (docs/ui-plugins.md, "Pointing and the view"): an
   * id the section itself reads, such as an automation rule's, consumed
   * once by that section.
   */
  settingsItem: { section: string; item: string } | null;
  /** One-step restore: Subscriptions starts sign-in for this account. */
  pendingRestoreAccountId: string | null;
  /**
   * A sign-in where projects live to start on arrival (git integration PR
   * 1.2): Projects starts the host's sign-in, so the code is on screen.
   */
  pendingForgeSignIn: string | null;
  /**
   * What Settings -> Devices does on arrival from a card (docs/devices.md,
   * "Asking the first mate"): make a link, remove a device, add a Mac at an
   * address, or update Firstmate on one added that way.
   */
  pendingDeviceArrival: DeviceArrival | null;
  /**
   * A sign-in on a computer that runs work to start on arrival in Settings
   * -> Intelligence (docs/helper.md, "Its own sign-ins").
   */
  pendingDeviceSignIn: { deviceId: string; providerId: string } | null;
  /** A computer's own sign-in where projects live that Settings -> Projects starts on arrival. */
  pendingDeviceForgeSignIn: { deviceId: string; host: string } | null;
  /**
   * What this app is on its Mac (docs/view.md): the one holding Firstmate,
   * or one controlling Firstmate on another Mac, with how well it hears it.
   * null until read. While changes are off there, nothing is sent.
   */
  thisMac: ThisMac | null;
  applyThisMac: (thisMac: ThisMac) => void;
  /**
   * Whether Settings -> Devices is offered here (`inf:devices:shown`,
   * docs/devices.md): its commands are listed only then. False until read,
   * and on a Mac that controls another.
   */
  devicesShown: boolean;
  /**
   * Reads the stage again from the Mac this one controls, after a gap it
   * could not replay (that Mac restarted, or this one was away too long).
   */
  resync: () => void;
  init: () => void;
  startVoiceDownload: () => void;
  /** Re-read the first-launch state from the core (after an account change). */
  loadFirstRun: () => Promise<void>;
  /** The captain's first turn just left: the first-run hint is over. */
  markFirstTurn: () => void;
  /** Read the last turn from the core; a message seen sent meanwhile is newer and wins. */
  loadLastTurn: () => Promise<void>;
  noteCrewWord: (word: CrewWord) => void;
  dismissVoiceNotice: () => void;
  /**
   * Reads microphone access again while a line says it is off: access
   * turned on in System Settings takes the line down (docs/composer.md).
   */
  recheckMicAccess: () => void;
  setTheme: (theme: Theme) => void;
  setWashStrength: (strength: number) => void;
  setShowCrewModelNames: (shown: boolean) => void;
  setUsageUnit: (unit: UsageUnit) => void;
  setView: (view: ShellView) => void;
  /**
   * Go to the main message (docs/keyboard.md): from Settings back home, and
   * the input takes focus with its words, pictures and caret as they were.
   * Nothing moves while `mainMessageRefusal` says why not. A way back that
   * `yields` gives way to a control that takes focus in the same render.
   */
  focusMainMessage: (options?: { yields?: boolean }) => void;
  /** Command search is open over the window (docs/keyboard.md). */
  commandSearchOpen: boolean;
  setCommandSearchOpen: (open: boolean) => void;
  setInputText: (text: string) => void;
  keystroke: () => void;
  startRecording: () => void;
  acceptRecording: (held?: boolean) => void;
  abandonRecording: () => void;
  submit: () => void;
  /** Takes pictures up to `TURN_IMAGES_MAX`; the rest are refused out loud. */
  attachImages: (items: ImageAttachment[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  /** Holds a long paste as a chip (`shouldChip`). */
  attachPastedText: (text: string, name?: string) => void;
  removePaste: (id: string) => void;
  setInputCaret: (caret: number) => void;
  /** Up in an empty composer: the last turn sent comes back, words and chips. */
  recallLastSent: () => void;
  /**
   * Puts words at the head of the Firstmate input and focuses it right after
   * them, for the captain to finish; what was already typed stays after them,
   * and words the last draft put there give way to these (`draftLead`).
   */
  beginDraft: (text: string) => void;
  showComposerNotice: (notice: ComposerNotice) => void;
  dismissComposerNotice: () => void;
  /**
   * A card action. A footer click passes `collect`, the body frame's fresh
   * reading of its form: the answers ride the click (never a body's own
   * `inf.action`), falling back on the last reading when the frame cannot
   * give one.
   */
  actOnCard: (
    cardId: string,
    actionId: string,
    source?: CardActionSource,
    value?: unknown,
    collect?: (focusUnpicked?: boolean) => Promise<FrameAnswers | undefined>,
    mounted?: CardMount,
  ) => Promise<void>;
  /** A card body's frame read its form again (the bridge's `answers`). */
  setCardAnswers: (cardId: string, answers: FrameAnswers) => void;
  /** The close control; `mounted` is the card it was clicked on. */
  closeCard: (cardId: string, mounted?: CardMount) => void;
  /** Read one card's thread from the core; idempotent, and safe to call on every show. */
  loadThread: (cardId: string) => void;
  /** Adopt a pushed thread (`inf:cards:thread`). */
  applyThread: (cardId: string, messages: CardMessage[]) => void;
  setReplyDraft: (cardId: string, text: string) => void;
  attachReplyImages: (cardId: string, items: ImageAttachment[]) => void;
  showReplyNotice: (cardId: string, notice: ComposerNotice) => void;
  dismissReplyNotice: (cardId: string) => void;
  removeReplyImage: (cardId: string, id: string) => void;
  /** Send the captain's reply under a card; the core routes it to the author. */
  sendReply: (cardId: string, collect?: () => Promise<FrameAnswers | undefined>) => Promise<void>;
  /** Collapse the thread beside a card into its foot; the messages stay on the record. */
  closeThread: (cardId: string) => void;
  /** Put a thread the captain collapsed in this window beside its card again. */
  openThread: (cardId: string) => void;
  clearSettingsSection: () => void;
  clearSettingsItem: () => void;
  clearPendingRestore: () => void;
  clearPendingForgeSignIn: () => void;
  clearPendingDeviceArrival: () => void;
  clearPendingDeviceSignIn: () => void;
  clearPendingDeviceForgeSignIn: () => void;
  /**
   * Opens or focuses one task's front stack entry, from the card `from`
   * names when it was the card's key or its Show Info (docs/task-card-tabs.md,
   * "From a card").
   */
  openRecord: (taskId: string, from?: EntryFrom) => void;
  /** Opens or focuses a closed card's front stack entry, read-only (FI3-579). */
  openPastCard: (cardId: string) => void;
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
  /** Hide or Esc: closes the shown record, past card, browser view, Crewmate tab or panel card, if one is shown. */
  closeRecord: () => void;
  /** Closes one task's record wherever it sits; the shown entry stays shown. */
  closeTaskRecord: (taskId: string) => void;
  /** Closes one past card wherever it sits; the shown entry stays shown. */
  closePastCard: (cardId: string) => void;
  /** Brings a stacked card to the front; false when it is not on the stack. */
  focusCard: (cardId: string) => boolean;
  minimizeCard: (cardId: string) => Promise<void>;
  applyCards: (cards: Card[]) => void;
  /** The captain dragged a card's edge; null returns it to the width the host decided. */
  dragCard: (cardId: string, width: number | null) => void;
  /** Collapses seen notes that have aged past NOTE_COLLAPSE_MS (the shell's tick). */
  collapseStaleNotes: (now?: number) => void;
  applyEvent: (event: FmEvent) => void;
  prevCard: () => void;
  nextCard: () => void;
};

/**
 * The lifecycle and offer of the card a gesture started on, read from the
 * mounted card at the click and never looked up again after an await
 * (docs/card-evidence.md).
 */
export type CardMount = Pick<Card, "lifecycleId" | "offerId">;

/** A fresh id for one gesture: its retransmission is recorded once. */
function gestureId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What the shell says about a gesture beside it: its id and the card it had mounted. */
function submissionFor(mounted: CardMount | undefined): CardSubmission {
  return {
    id: gestureId(),
    ...(mounted?.lifecycleId ? { lifecycleId: mounted.lifecycleId } : {}),
    ...(mounted?.offerId ? { offerId: mounted.offerId } : {}),
  };
}

/** Reads the notes the app showed; unanswered, the last known stay. */
function readReleaseNotes(): void {
  void window.infinitary.releaseNotes
    .list()
    .then((releaseNotes) => useShellStore.setState({ releaseNotes }))
    .catch(() => {});
}

/** The window's state for a saved look. Idempotent, so an echo of its own write is a no-op. */
function lookOf(s: ShellState, appearance: Appearance): Partial<ShellState> {
  const look = {
    theme: appearance.theme,
    defaultCardSize: appearance.defaultCardSize ?? "usual",
    size: appearance.size ?? 100,
    washStrength: appearance.washStrength ?? DEFAULT_APPEARANCE.washStrength ?? 0,
    showCrewModelNames: appearance.showCrewModelNames ?? true,
    usageUnit: appearance.usageUnit ?? "tokens",
  } satisfies Partial<ShellState>;
  return Object.fromEntries(
    Object.entries(look).filter(([key, value]) => s[key as keyof typeof look] !== value),
  );
}

/** The choice whose write is running, so a refusal is told beside its own control. */
let appearanceChoice: AppearanceChoice | null = null;

/**
 * The one ordered writer of the look (../settings/settingSave.ts). A control
 * shows its choice at once; a refused write says why beside it, and the
 * window takes the saved look again. Only the last answer of a run of writes
 * is applied - the wash slider sends one per step - and a push from the core
 * gives way to the answers still owed.
 */
const appearanceSave = new SettingSave<Appearance>(
  () => window.infinitary.settings.getAppearance(),
  (state) => {
    const s = useShellStore.getState();
    const appearanceError =
      state.error && appearanceChoice ? { choice: appearanceChoice, message: state.error } : null;
    const change: Partial<ShellState> = {
      ...(!state.saving && state.value ? lookOf(s, state.value) : {}),
      ...(appearanceError?.choice !== s.appearanceError?.choice ||
      appearanceError?.message !== s.appearanceError?.message
        ? { appearanceError }
        : {}),
    };
    if (Object.keys(change).length > 0) useShellStore.setState(change);
    if (!state.saving && state.value) {
      const { washStrength } = useShellStore.getState();
      document.documentElement.style.setProperty("--wash-strength", `${washStrength}%`);
    }
  },
);

/**
 * Writes one choice over the whole saved look (a Mac controlling another
 * keeps the look as sent, src/main/view/viewLook.ts), never over a choice
 * still shown but not saved: the wash after a refused theme keeps the saved theme.
 */
function saveAppearance(choice: AppearanceChoice, change: Partial<Appearance>): void {
  void appearanceSave.save(() => {
    appearanceChoice = choice;
    const s = useShellStore.getState();
    const saved = appearanceSave.state.value ?? {
      theme: s.theme,
      defaultCardSize: s.defaultCardSize,
      size: s.size,
      washStrength: s.washStrength,
      showCrewModelNames: s.showCrewModelNames,
      usageUnit: s.usageUnit,
    };
    return window.infinitary.settings.setAppearance({ ...saved, ...change });
  });
}

function withoutKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  const next = { ...values };
  delete next[key];
  return next;
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
  const entry = shownCard(s.cards, s.cardIndex, s.collapsedCardIds, s.records);
  const records = s.records.filter((record) => !closing.includes(record));
  const shown = visibleStack(s.cards, s.collapsedCardIds, records);
  // A tab a card opened returns to that card while it is up.
  const opener =
    "from" in first && first.from ? shown.findIndex((card) => card.id === first.from?.cardId) : -1;
  const cardIndex =
    entry !== undefined && closingIds.has(entry.id)
      ? opener >= 0
        ? opener
        : departureIndex(shown, s.unreadCardIds, undefined, "hide")
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
    phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
    focusRequest:
      records.length === 0 && visibleCards(s.cards, s.collapsedCardIds).length === 0
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
 * The stack once a reply has dismissed the shown card `cardId`: the card
 * `departureIndex` picks comes up at once, before the core's own push, so
 * the departing card never opens its thread on the way out. A lone card
 * stays, and nothing moves when the captain has already paged away.
 */
function afterReplyDeparture(s: ShellState, cardId: string): Partial<ShellState> {
  const shown = visibleStack(s.cards, s.collapsedCardIds, s.records);
  const at = Math.min(s.cardIndex, shown.length - 1);
  if (shown[at]?.id !== cardId) return { replyLeaving: null };
  const cardIndex = departureIndex(shown, s.unreadCardIds, cardId);
  return { cardIndex, unreadCardIds: withoutShown(s, cardIndex), replyLeaving: null };
}

/** Both input rows take only the remaining picture slots and explain any refusal. */
function takePictures(held: ImageAttachment[], items: ImageAttachment[]) {
  const taken = items.slice(0, Math.max(0, TURN_IMAGES_MAX - held.length));
  return { taken, refused: taken.length < items.length };
}

export const useShellStore = create<ShellState>()((set, get) => ({
  // Replaced before the first render by the core's own value
  // (./preferences); the default is only what an unread core would say.
  theme: DEFAULT_APPEARANCE.theme,
  defaultCardSize: "usual",
  size: 100,
  washStrength: DEFAULT_APPEARANCE.washStrength ?? 0,
  showCrewModelNames: DEFAULT_APPEARANCE.showCrewModelNames ?? true,
  usageUnit: "tokens",
  appearanceError: null,
  view: "home",
  phase: "idle",
  recording: false,
  cards: [],
  cardFocusRequest: 0,
  cardFocusTarget: null,
  pendingCardActions: {},
  cardActionErrors: {},
  cardAnswers: {},
  sentCardAnswers: {},
  records: [],
  cardIndex: 0,
  unreadCardIds: [],
  collapsedCardIds: [],
  collapsedDigests: {},
  cardsSeeded: false,
  threads: {},
  threadsLoaded: {},
  replyLeaving: null,
  replyDrafts: {},
  sendingReplies: {},
  replyErrors: {},
  replyNotices: {},
  replyPastes: {},
  replyImages: {},
  closedThreadIds: [],
  cardDrags: {},
  inputText: "",
  attachments: [],
  pastes: [],
  inputCaret: null,
  draftLead: null,
  composerNotice: null,
  lastSent: null,
  kick: 0,
  submitted: 0,
  firstmateBusy: false,
  crewActivity: {},
  dictation: null,
  pickingDictationKey: false,
  recordingKeys: false,
  releaseNotes: null,
  voiceGeneration: 0,
  applyDictation: (dictation) => {
    if (!dictation.enabled) {
      voiceController.abandon();
      set((s) => ({
        voiceGeneration: s.voiceGeneration + 1,
        recording: false,
        transcribing: false,
        voiceNotice: null,
        phase: derivePhase(false, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
      }));
    }
    set({ dictation, pickingDictationKey: false });
  },
  voiceSupported: null,
  voiceModelReady: null,
  firstRun: null,
  firstRunSettled: false,
  lastTurn: null,
  lastTurnSeq: 0,
  lastTurnReplySeq: 0,
  focusRequest: 0,
  focusCaret: null,
  focusYields: null,
  voiceNotice: null,
  transcribing: false,
  initialized: false,
  cardsSnapshotLoaded: false,
  bootCardId: null,
  settingsSection: null,
  settingsItem: null,
  pendingRestoreAccountId: null,
  pendingForgeSignIn: null,
  pendingDeviceArrival: null,
  pendingDeviceSignIn: null,
  pendingDeviceForgeSignIn: null,
  thisMac: null,
  devicesShown: false,
  applyThisMac: (thisMac) => {
    const before = get().thisMac;
    set({ thisMac });
    if (isView(before) && changesOff(before) && !changesOff(thisMac)) {
      // Changes are on again: what said they were off goes, the words stay.
      const off = changesOffWords(before);
      set((s) => ({
        composerNotice: s.composerNotice === "away" ? null : s.composerNotice,
        replyNotices: Object.fromEntries(
          Object.entries(s.replyNotices).filter(([, notice]) => notice !== "away"),
        ),
        cardActionErrors: Object.fromEntries(
          Object.entries(s.cardActionErrors).filter(([, error]) => error !== off),
        ),
      }));
    }
    if (isView(before) && isView(thisMac) && thisMac.caughtUp > before.caughtUp) get().resync();
  },
  resync: () => {
    void window.infinitary.cards
      .list()
      .then((cards) => get().applyCards(cards))
      .catch(() => {});
    // Every thread this window has read is read again.
    for (const cardId of Object.keys(get().threads))
      void window.infinitary.cards
        .thread(cardId)
        .then((thread) => get().applyThread(thread.cardId, thread.messages))
        .catch(() => {});
    readReleaseNotes();
    // A turn that ended while this Mac was away said so to nobody here.
    set((s) => ({
      firstmateBusy: false,
      phase: derivePhase(s.recording, s.cards, false, s.collapsedCardIds, s.records),
    }));
    void window.infinitary.tasks
      .board()
      .then((board) => {
        seedCrew(crewOrbit(), board.tasks, stageNow());
        set({
          crewActivity: Object.fromEntries(
            board.tasks
              .filter((task) => task.kind === "work" && task.status === "active")
              .map((task) => [task.id, task.activity]),
          ),
        });
      })
      .catch(() => {});
    void get().loadFirstRun();
    void get().loadLastTurn();
    resyncReads();
  },
  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    // What this app is: the one holding Firstmate, or a view of another Mac.
    window.infinitary.devices.onThisMac((thisMac) => get().applyThisMac(thisMac));
    void window.infinitary.devices
      .thisMac()
      .then((thisMac) => {
        if (!get().thisMac) set({ thisMac });
      })
      .catch(() => {});
    // Asked once: a build offers Devices or not for as long as it runs.
    void window.infinitary.devices
      .shown()
      .then(({ shown }) => set({ devicesShown: shown }))
      .catch(() => {});
    window.infinitary.cards.onCards((cards) => get().applyCards(cards));
    window.infinitary.cards.onThread((thread) => get().applyThread(thread.cardId, thread.messages));
    window.infinitary.events.on((event) => get().applyEvent(event));
    const stackAtRead = get().cards;
    // Unanswered (a Mac this one controls is out of reach): the stage stays
    // as it is, and reads again when that Mac is back (resync).
    void window.infinitary.cards
      .list()
      .then((cards) => {
        if (get().cards === stackAtRead) get().applyCards(cards);
        const state = get();
        set({
          cardsSnapshotLoaded: true,
          bootCardId:
            shownCard(state.cards, state.cardIndex, state.collapsedCardIds, state.records)?.id ??
            null,
        });
      })
      .catch(() => {});
    // The crew orbit's roster at boot (a side channel, never shell state).
    void window.infinitary.tasks
      .board()
      .then((board) => {
        seedCrew(crewOrbit(), board.tasks, stageNow());
        set({
          crewActivity: Object.fromEntries(
            board.tasks
              .filter((task) => task.kind === "work" && task.status === "active")
              .map((task) => [task.id, task.activity]),
          ),
        });
      })
      .catch(() => {});
    // A new or cleared wait arrives on the sequenced board, not on task_changed.
    window.infinitary.tasks.onBoard((board) => applyCrewDependencies(crewOrbit(), board.tasks));
    setInterval(() => get().collapseStaleNotes(), NOTE_COLLAPSE_TICK_MS);
    // The activity feed is not shell state: its rail panel reads it from
    // the core over the read catalog (feed.recent - docs/ui-plugins.md),
    // which is also where its persistence across restarts lives.
    window.infinitary.settings.onDictation(get().applyDictation);
    void window.infinitary.settings
      .getDictation()
      .then(get().applyDictation)
      .catch(() => {});
    // What's new reads the notes the app showed (docs/release-notes.md).
    window.infinitary.releaseNotes.onChange((releaseNotes) => set({ releaseNotes }));
    readReleaseNotes();
    // The graphics gate: no card or adapter where the model runs means the
    // voice affordance hides entirely.
    void recognizerPlace()
      .then(detectVoiceSupport)
      .then((supported) => set({ voiceSupported: supported }));
    void window.infinitary.voice
      .status()
      .then((status) => set({ voiceModelReady: status.modelReady }))
      .catch(() => {});
    // The first-launch gate is read once here and again on every quota
    // push, which follows each account change (docs/first-launch.md).
    void get().loadFirstRun();
    void get().loadLastTurn();
    window.infinitary.quota.onSnapshot(() => {
      void get().loadFirstRun();
    });
    window.infinitary.models.onChanged(() => {
      void get().loadFirstRun();
    });
    window.infinitary.voice.onProgress((progress) => {
      const notice = get().voiceNotice;
      if (notice?.kind === "download") {
        set({ voiceNotice: { kind: "download", fraction: progress.fraction } });
      }
    });
  },
  loadFirstRun: async () => {
    try {
      const firstRun = await window.infinitary.app.firstRun();
      // In one update, so a gated profile's input never opens in between.
      set({ firstRun, firstRunSettled: true });
    } catch {
      // An unreadable core answer leaves the last known state in place. A
      // first read that fails still settles: the input opens as it did
      // before any read, rather than holding for a read that may not come.
      set({ firstRunSettled: true });
    }
  },
  markFirstTurn: () =>
    set((s) =>
      s.firstRun && s.firstRun.firstTurnAt === null
        ? { firstRun: { ...s.firstRun, firstTurnAt: Date.now() } }
        : {},
    ),
  loadLastTurn: async () => {
    const seq = get().lastTurnSeq;
    try {
      const lastTurn = await window.infinitary.conversation.lastTurn();
      if (get().lastTurnSeq === seq) set({ lastTurn });
    } catch {
      // An unreadable answer leaves the area as it is.
    }
  },
  noteCrewWord: (word) => {
    const key = word === "working" ? "workingWordAt" : "idleWordAt";
    // Taught on the stage at once, so the word never shows again while the core writes it.
    set((s) => (s.firstRun ? { firstRun: { ...s.firstRun, [key]: Date.now() } } : {}));
    void window.infinitary.app
      .noteCrewWord(word)
      .then((firstRun) => set({ firstRun }))
      .catch(() => {});
  },
  startVoiceDownload: () => {
    if (!get().dictation?.enabled) return;
    set({ voiceNotice: { kind: "download", fraction: 0 } });
    void window.infinitary.voice
      .ensureModel()
      .then(() => {
        set({ voiceModelReady: true, voiceNotice: null });
      })
      .catch(() => {
        if (!get().dictation?.enabled) return;
        set({
          voiceNotice: { kind: "error", message: "The voice model download failed. Try again." },
        });
      });
  },
  dismissVoiceNotice: () => set({ voiceNotice: null }),
  recheckMicAccess: () => {
    const shown = get().voiceNotice;
    if (shown?.kind !== "mic" || shown.line === "asking") return;
    void readMicAccess().then((access) => {
      const now = get().voiceNotice;
      if (now?.kind !== "mic" || now.line === "asking") return;
      const line = settledMicLine(access);
      set({ voiceNotice: line ? { kind: "mic", line } : null });
    });
  },
  applyAppearance: (appearance) => appearanceSave.apply(appearance),
  refreshAppearance: () => {
    void appearanceSave.refresh();
  },
  // The window follows the size the core saved (src/main/windowSize.ts).
  setSize: (size) => saveAppearance("size", { size }),
  setDefaultCardSize: (defaultCardSize) => {
    set({ defaultCardSize });
    saveAppearance("defaultCardSize", { defaultCardSize });
  },
  setTheme: (theme) => {
    set({ theme });
    saveAppearance("theme", { theme });
  },
  setWashStrength: (washStrength) => {
    set({ washStrength });
    document.documentElement.style.setProperty("--wash-strength", `${washStrength}%`);
    saveAppearance("washStrength", { washStrength });
  },
  setShowCrewModelNames: (showCrewModelNames) => {
    set({ showCrewModelNames });
    saveAppearance("showCrewModelNames", { showCrewModelNames });
  },
  setUsageUnit: (usageUnit) => {
    set({ usageUnit });
    saveAppearance("usageUnit", { usageUnit });
  },
  setView: (view) => set({ view }),
  focusMainMessage: (options) =>
    set((s) =>
      mainMessageRefusal(s) !== null
        ? {}
        : {
            view: "home",
            focusRequest: s.focusRequest + 1,
            focusYields: options?.yields ? s.focusRequest + 1 : null,
          },
    ),
  commandSearchOpen: false,
  setCommandSearchOpen: (commandSearchOpen) => set({ commandSearchOpen }),
  setInputText: (inputText) => set({ inputText }),
  attachImages: (items: ImageAttachment[]) =>
    set((s) => {
      // The core refuses a turn over the cap whole, words included, so a
      // picture past it is refused here, where the captain can see it.
      const { taken, refused } = takePictures(s.attachments, items);
      return {
        attachments: [...s.attachments, ...taken],
        ...(refused ? { composerNotice: "pictures-max" as const } : {}),
      };
    }),
  removeAttachment: (id: string) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  attachPastedText: (text, name) =>
    set((s) => {
      const refusal = pasteRefusal(text, s.pastes.length);
      return refusal
        ? { composerNotice: refusal }
        : {
            pastes: [
              ...s.pastes,
              { id: Math.random().toString(36).slice(2), text, ...(name ? { name } : {}) },
            ],
          };
    }),
  removePaste: (id) => set((s) => ({ pastes: s.pastes.filter((p) => p.id !== id) })),
  setInputCaret: (inputCaret) => {
    if (get().inputCaret !== inputCaret) set({ inputCaret });
  },
  recallLastSent: () =>
    set((s) => {
      const empty =
        !s.inputText && s.pastes.length === 0 && s.attachments.length === 0 && !s.recording;
      if (!empty || !s.lastSent) return {};
      const { text, pastes, attachments } = s.lastSent;
      return {
        inputText: text,
        pastes,
        attachments,
        inputCaret: text.length,
        focusRequest: s.focusRequest + 1,
        focusCaret: { request: s.focusRequest + 1, at: text.length },
      };
    }),
  beginDraft: (text) =>
    set((s) => {
      const typed =
        s.draftLead && s.inputText.startsWith(s.draftLead)
          ? s.inputText.slice(s.draftLead.length)
          : s.inputText;
      const inputText = typed.startsWith(text) ? typed : `${text}${typed}`;
      return {
        inputText,
        draftLead: text,
        inputCaret: text.length,
        focusRequest: s.focusRequest + 1,
        focusCaret: { request: s.focusRequest + 1, at: text.length },
      };
    }),
  showComposerNotice: (composerNotice) => set({ composerNotice }),
  dismissComposerNotice: () => set({ composerNotice: null }),
  keystroke: () => set((s) => ({ kick: s.kick + 1 })),
  startRecording: () => {
    const { view, recording, voiceSupported, voiceModelReady } = get();
    if (
      !get().dictation?.enabled ||
      get().pickingDictationKey ||
      view !== "home" ||
      recording ||
      voiceSupported !== true
    )
      return;
    // A held input ignores hold-to-talk too (docs/first-launch.md).
    if (mainInputHeld(get())) return;
    if (voiceModelReady !== true) {
      // First use: the model downloads once, with consent (section 8).
      if (get().voiceNotice?.kind !== "download") {
        set({ voiceNotice: { kind: "consent" } });
      }
      return;
    }
    set((s) => ({
      voiceGeneration: s.voiceGeneration + 1,
      recording: true,
      // A line about microphone access stays until a hold works.
      voiceNotice: s.voiceNotice?.kind === "mic" ? s.voiceNotice : null,
      phase: derivePhase(true, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
    }));
    const generation = get().voiceGeneration;
    const current = () => generation === get().voiceGeneration && get().dictation?.enabled;
    const stopWith = (voiceNotice: ShellState["voiceNotice"]) =>
      set((s) => ({
        recording: false,
        phase: derivePhase(false, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
        voiceNotice,
      }));
    // macOS's answer, read without asking, says which line goes under the
    // input (docs/composer.md, "Voice"): none, macOS is asking, or why the
    // microphone stays shut.
    void readMicAccess().then(async (access) => {
      if (!current()) return;
      const refused = settledMicLine(access);
      if (refused) return stopWith({ kind: "mic", line: refused });
      // Stopped before the answer came: nothing opens.
      if (!get().recording) return;
      if (access === "not-determined") set({ voiceNotice: { kind: "mic", line: "asking" } });
      try {
        // The 120s runaway guard finishes the capture like a release.
        await voiceController.start(() => get().acceptRecording());
      } catch {
        const line = settledMicLine(await readMicAccess());
        if (!current()) return;
        if (line) return stopWith({ kind: "mic", line });
        if (get().recording) {
          return stopWith({
            kind: "error",
            message: "The microphone is unavailable. You can still type.",
          });
        }
      }
      // Answered, or a hold that works: every microphone line comes down.
      if (current() && get().voiceNotice?.kind === "mic") set({ voiceNotice: null });
    });
  },
  acceptRecording: (held = false) => {
    if (!get().recording) return;
    const generation = get().voiceGeneration;
    set((s) => ({
      recording: false,
      transcribing: true,
      phase: derivePhase(false, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
    }));
    void voiceController
      .finish(held)
      .then((text) => {
        if (text && get().dictation?.enabled && generation === get().voiceGeneration) {
          set((s) => {
            const next = insertVoiceTranscript(s.inputText, s.inputCaret, text);
            return {
              inputText: next.text,
              inputCaret: next.caret,
              focusRequest: s.focusRequest + 1,
              focusCaret: { request: s.focusRequest + 1, at: next.caret },
            };
          });
        }
      })
      .catch(() => {
        if (!get().dictation?.enabled || generation !== get().voiceGeneration) return;
        set({
          voiceNotice: { kind: "error", message: "Could not transcribe that. You can still type." },
        });
      })
      .finally(() => {
        if (generation === get().voiceGeneration) set({ transcribing: false });
      });
  },
  abandonRecording: () => {
    if (!get().recording) return;
    voiceController.abandon();
    set((s) => ({
      recording: false,
      phase: derivePhase(false, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
    }));
  },
  submit: () => {
    // Attachments are read at send time, not submit time: a paste that
    // lands while a recording transcribes still rides the turn.
    // `draft` is what goes back in the composer if the turn cannot leave.
    const sendTurn = (draft: string): Promise<void> | undefined => {
      const pastes = get().pastes;
      const text = composeTurnText(draft, []);
      const attachments = get().attachments;
      const imgs = attachments.length
        ? attachments.map((a) => ({
            mimeType: a.mimeType,
            data: a.data,
            ...(a.name ? { name: a.name } : {}),
          }))
        : undefined;
      if (!text && !imgs && !pastes.length) return undefined;
      if (isPreparing(MAIN_FILES_KEY)) {
        // A file is still being prepared: nothing leaves, and the draft stays.
        set({ inputText: draft, composerNotice: "files-preparing" });
        return undefined;
      }
      if (text.length > CONVERSE_TEXT_MAX_CHARS) {
        // The core would refuse it; refuse before clearing, so it stays.
        set({ inputText: draft, composerNotice: "too-long" });
        return undefined;
      }
      if (changesOff(get().thisMac)) {
        // The Mac this one controls is out of reach: nothing leaves, nothing
        // is queued for later, and the words stay (docs/view.md).
        set({ inputText: draft, composerNotice: "away" });
        return undefined;
      }
      // Only the shown entry rides the turn as a hint.
      const { cards, records, cardIndex, collapsedCardIds } = get();
      const entry = shownCard(cards, cardIndex, collapsedCardIds, records);
      const held = isHeldEntry(entry);
      const visibleCardId = held ? undefined : entry?.id;
      // A task's browser view points the turn at its task, as its record
      // does, and a panel's card - the task board among them - at the task
      // its view aims at (docs/task-board.md, its selected tile).
      const taskId =
        entry?.recordTaskId ??
        entry?.browserTaskId ??
        entry?.crewmateTaskId ??
        entry?.panelCard?.aim ??
        undefined;
      const pastCardId = entry?.pastCardId;
      set((s) => ({
        inputText: "",
        attachments: [],
        pastes: [],
        inputCaret: null,
        composerNotice: null,
        lastSent: { text: draft, pastes, attachments },
        submitted: s.submitted + 1,
        focusRequest: s.focusRequest + 1,
      }));
      get().markFirstTurn();
      // Keep send(text) for the empty-stack case; object form carries the
      // optional on-screen card id or task id (and any pasted images).
      const turn =
        imgs || pastes.length || visibleCardId || taskId || pastCardId
          ? {
              text: text || undefined,
              ...(pastes.length
                ? { files: pastes.map(({ text, name }) => ({ text, ...(name ? { name } : {}) })) }
                : {}),
              images: imgs,
              visibleCardId,
              taskId,
              pastCardId,
            }
          : text;
      return window.infinitary.conversation.send(turn).then(
        () => undefined,
        () => {
          // A turn the core never took. An empty composer gets it back; a
          // newer draft is never overwritten, and the turn waits in the
          // recall slot instead.
          const now = get();
          if (
            !now.inputText.trim() &&
            now.attachments.length === 0 &&
            now.pastes.length === 0 &&
            !now.recording
          ) {
            set((s) => ({
              inputText: draft,
              pastes,
              attachments,
              inputCaret: draft.length,
              composerNotice: "not-sent",
              focusRequest: s.focusRequest + 1,
              focusCaret: { request: s.focusRequest + 1, at: draft.length },
            }));
          } else {
            set({ composerNotice: "not-sent" });
          }
        },
      );
    };
    if (get().recording) {
      // Submit straight from the recording: transcribe, then send.
      const generation = get().voiceGeneration;
      set((s) => ({
        recording: false,
        transcribing: true,
        phase: derivePhase(false, s.cards, s.firstmateBusy, s.collapsedCardIds, s.records),
      }));
      void voiceController
        .finish()
        .then(async (text) => {
          if (!get().dictation?.enabled || generation !== get().voiceGeneration) return;
          // A voice send still waits for every file to be ready.
          await whenPrepared(MAIN_FILES_KEY);
          if (generation !== get().voiceGeneration) return;
          const { inputText, inputCaret } = get();
          return sendTurn(insertVoiceTranscript(inputText, inputCaret, text || "").text);
        })
        .catch(() => {
          if (generation !== get().voiceGeneration) return;
          set({
            voiceNotice: {
              kind: "error",
              message: "Could not transcribe that. You can still type.",
            },
          });
        })
        .finally(() => {
          if (generation === get().voiceGeneration) set({ transcribing: false });
        });
      return;
    }
    void sendTurn(get().inputText);
  },
  actOnCard: async (cardId, actionId, source = "chrome", value, collect, mounted) => {
    if (get().pendingCardActions[cardId] || !get().cards.some((card) => card.id === cardId)) return;
    const thisMac = get().thisMac;
    if (isView(thisMac) && changesOff(thisMac)) {
      // A body's own button while changes are off: refused, never sent later.
      if (source === "frame") throw new Error(changesOffWords(thisMac));
      return;
    }
    const chosen = get()
      .cards.find((card) => card.id === cardId)
      ?.actions.find((action) => action.id === actionId);
    const there = isView(thisMac) && chosen ? doneThereWords(thisMac, chosen) : null;
    if (there) {
      // That Settings section, or the task's browser page, stays on the
      // other Mac (docs/view.md): nothing is sent, so the card stays on both
      // Macs and says where to do it.
      set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: there } }));
      return;
    }
    const request = { actionId };
    const submission = submissionFor(mounted);
    set((s) => ({
      pendingCardActions: { ...s.pendingCardActions, [cardId]: request },
      cardActionErrors: withoutKey(s.cardActionErrors, cardId),
    }));
    try {
      let sent = value;
      let sentAnswers: CardAnswer[] | undefined;
      if (collect) {
        // The footer is the one send (contract 4.22): it carries every
        // named field, read fresh, and a closing choice only once every
        // question the body requires has an answer.
        const defaultAction = get()
          .cards.find((card) => card.id === cardId)
          ?.actions.find((action) => action.id === actionId)?.default;
        const fresh = await collect(defaultAction);
        const reading = fresh ?? get().cardAnswers[cardId];
        // What the record keeps beside the answers: whether they are the
        // mounted frame's fresh reading, and what its questions offered.
        submission.reading = fresh ? "fresh" : reading ? "fallback" : "none";
        if (fresh?.questions) {
          if (cardQuestionsBytes(fresh.questions) > CARD_QUESTIONS_MAX_BYTES) {
            submission.questionsGap = "too-large";
          } else submission.questions = fresh.questions;
        } else if (fresh?.questionsGap) submission.questionsGap = fresh.questionsGap;
        else if (reading) submission.questionsGap = "no-fresh-reading";
        const now = get().cards.find((card) => card.id === cardId)?.offerId;
        if (mounted?.offerId && now && now !== mounted.offerId) submission.remounted = true;
        if (reading && reading.of > 0) {
          if (defaultAction && reading.answered < reading.of) {
            throw new Error("Answer every question the card asks first.");
          }
          if (cardAnswersBytes(reading.answers) > CARD_ANSWERS_MAX_BYTES) {
            throw new Error(CARD_ANSWERS_TOO_LONG);
          }
          sentAnswers = reading.answers;
          sent = { answers: sentAnswers };
        }
      }
      const { effect, refusal } = await window.infinitary.cards.act(
        cardId,
        actionId,
        source,
        sent,
        submission,
      );
      if (refusal) throw new Error(refusal);
      // Acceptance is the receipt, not the settle outcome. Do not revive
      // the row while waiting for the core's coalesced cards push.
      if (get().pendingCardActions[cardId] === request) {
        get().applyCards(get().cards.filter((card) => card.id !== cardId));
      }
      // The shell applies the effect the core returns and reads no action
      // id (cards/tasks/agents P1): open Settings, on the named section,
      // with the account whose sign-in the Subscriptions tab re-runs, the
      // host whose sign-in the Projects tab starts (git integration PR 1.2),
      // or what the Devices tab does on arrival. A request card's open-browser
      // action opens its task's browser view instead, with the captain in
      // control (docs/task-browser.md, "Asking for help").
      if (effect?.kind === "open" && effect.target === "browser") {
        const browser = effect.browser;
        // A Mac controlling another shows no task's page: a saved sign-in
        // sent from there opens nothing here (docs/view.md).
        if (browser && !isView(get().thisMac)) {
          get().openBrowserView(browser.taskId, {
            cardId: browser.cardId,
            session: browser.session,
            generation: browser.generation,
          });
        }
      } else if (effect?.kind === "open") {
        set({
          view: "settings",
          ...(effect.target !== "settings" ? { settingsSection: effect.target } : {}),
          ...(effect.restoreAccountId ? { pendingRestoreAccountId: effect.restoreAccountId } : {}),
          ...(effect.signIn ? { pendingForgeSignIn: effect.signIn } : {}),
          ...(effect.target === "devices" ? deviceArrival(effect) : {}),
          ...(effect.target === "subscriptions" && effect.signInOn
            ? { pendingDeviceSignIn: effect.signInOn }
            : {}),
          ...(effect.target === "projects" && effect.forgeSignInOn
            ? { pendingDeviceForgeSignIn: effect.forgeSignInOn }
            : {}),
        });
      }
    } catch (caught) {
      if (source === "frame") throw caught;
      if (get().pendingCardActions[cardId] === request) {
        const message = caught instanceof Error ? caught.message : String(caught);
        set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: message } }));
      }
    } finally {
      // A removal/reopen of the same id may have started a new request.
      if (get().pendingCardActions[cardId] === request) {
        set((s) => ({ pendingCardActions: withoutKey(s.pendingCardActions, cardId) }));
      }
    }
  },
  clearSettingsSection: () => set({ settingsSection: null }),
  clearSettingsItem: () => set({ settingsItem: null }),
  clearPendingRestore: () => set({ pendingRestoreAccountId: null }),
  clearPendingForgeSignIn: () => set({ pendingForgeSignIn: null }),
  clearPendingDeviceArrival: () => set({ pendingDeviceArrival: null }),
  clearPendingDeviceSignIn: () => set({ pendingDeviceSignIn: null }),
  clearPendingDeviceForgeSignIn: () => set({ pendingDeviceForgeSignIn: null }),
  setCardAnswers: (cardId, answers) =>
    set((s) => ({ cardAnswers: { ...s.cardAnswers, [cardId]: answers } })),
  closeCard: (cardId, mounted) => {
    const thisMac = get().thisMac;
    if (isView(thisMac) && changesOff(thisMac)) {
      // The card stays, and says why nothing happened.
      set((s) => ({
        cardActionErrors: { ...s.cardActionErrors, [cardId]: changesOffWords(thisMac) },
      }));
      return;
    }
    void window.infinitary.cards.close(cardId, submissionFor(mounted)).catch(() => {});
  },
  loadThread: (cardId) => {
    if (get().threads[cardId]) return;
    // Claim the slot before the round trip so a re-render mid-flight does
    // not fire a second read for the same card.
    set((s) => ({ threads: { ...s.threads, [cardId]: [] } }));
    void window.infinitary.cards
      .thread(cardId)
      .then((thread) => get().applyThread(thread.cardId, thread.messages))
      .catch(() => {
        // An unreadable thread still releases the current card body.
        set((s) => ({ threadsLoaded: { ...s.threadsLoaded, [cardId]: true } }));
      });
  },
  applyThread: (cardId, messages) =>
    // The thread paints at once; where its card sits is the core's, which
    // the cards push carries.
    set((s) => ({
      sentCardAnswers: (() => {
        const latest = messages.findLast((message) => message.who === "captain" && message.answers);
        const previous = s.threads[cardId]?.findLast(
          (message) => message.who === "captain" && message.answers,
        );
        return latest?.answers && latest.id > (previous?.id ?? -1)
          ? { ...s.sentCardAnswers, [cardId]: latest.answers }
          : s.sentCardAnswers;
      })(),
      threads: { ...s.threads, [cardId]: messages },
      threadsLoaded: { ...s.threadsLoaded, [cardId]: true },
      // A message arriving on a thread the captain collapsed opens it again
      // (his FI3-1130 answers): the author answered, or his own reply went,
      // and either is read beside the card. A read that brings nothing new
      // keeps the collapse.
      closedThreadIds:
        messages.length > (s.threads[cardId]?.length ?? 0)
          ? s.closedThreadIds.filter((id) => id !== cardId)
          : s.closedThreadIds,
    })),
  setReplyDraft: (cardId, text) =>
    set((s) => ({
      replyDrafts: { ...s.replyDrafts, [cardId]: text },
      replyErrors: withoutKey(s.replyErrors, cardId),
    })),
  attachReplyPaste: (cardId, text, name) =>
    set((s) => {
      const held = s.replyPastes[cardId] ?? [];
      const refusal = pasteRefusal(text, held.length);
      return refusal
        ? { replyNotices: { ...s.replyNotices, [cardId]: refusal } }
        : {
            replyPastes: {
              ...s.replyPastes,
              [cardId]: [
                ...held,
                { id: Math.random().toString(36).slice(2), text, ...(name ? { name } : {}) },
              ],
            },
          };
    }),
  removeReplyPaste: (cardId, id) =>
    set((s) => ({
      replyPastes: {
        ...s.replyPastes,
        [cardId]: (s.replyPastes[cardId] ?? []).filter((p) => p.id !== id),
      },
    })),
  attachReplyImages: (cardId, items) =>
    set((s) => {
      const held = s.replyImages[cardId] ?? [];
      const { taken, refused } = takePictures(held, items);
      return {
        replyImages: { ...s.replyImages, [cardId]: [...held, ...taken] },
        replyErrors: withoutKey(s.replyErrors, cardId),
        ...(refused
          ? { replyNotices: { ...s.replyNotices, [cardId]: "pictures-max" as const } }
          : {}),
      };
    }),
  showReplyNotice: (cardId, notice) =>
    set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: notice } })),
  dismissReplyNotice: (cardId) =>
    set((s) => ({ replyNotices: withoutKey(s.replyNotices, cardId) })),
  removeReplyImage: (cardId, id) =>
    set((s) => {
      const held = (s.replyImages[cardId] ?? []).filter((item) => item.id !== id);
      return {
        replyImages:
          held.length > 0
            ? { ...s.replyImages, [cardId]: held }
            : withoutKey(s.replyImages, cardId),
      };
    }),
  sendReply: async (cardId, collect) => {
    const draft = get().replyDrafts[cardId] ?? "";
    const text = composeTurnText(draft, []);
    const images = get().replyImages[cardId] ?? [];
    const pastes = get().replyPastes[cardId] ?? [];
    const files = pastes.map(({ text, name }) => ({
      text,
      ...(name ? { name } : {}),
    }));
    if ((!text && images.length === 0 && files.length === 0) || get().sendingReplies[cardId])
      return;
    if (isPreparing(cardId)) {
      set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: "files-preparing" as const } }));
      return;
    }
    if (changesOff(get().thisMac)) {
      // As for the input: the reply stays, and nothing is sent later.
      set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: "away" as const } }));
      return;
    }
    // The offer the reply was typed under, as the stage shows it now.
    const submission = submissionFor(get().cards.find((card) => card.id === cardId));
    // Past a reply's limit nothing leaves and the draft stays; the row
    // already says so under the field.
    if (text.length > CARD_REPLY_MAX_CHARS) return;
    // A shown card with another card behind it leaves the stage once the
    // reply is taken; until then it keeps the layout it has.
    const before = get();
    const stack = visibleStack(before.cards, before.collapsedCardIds, before.records);
    const leaving =
      stack[Math.min(before.cardIndex, stack.length - 1)]?.id === cardId &&
      !before.cards.find((card) => card.id === cardId)?.holdsPlace &&
      stack.some((entry) => !isHeldEntry(entry) && entry.id !== cardId);
    set((s) => ({
      // Clear before collecting settings or crossing the core boundary.
      replyDrafts: withoutKey(s.replyDrafts, cardId),
      replyPastes: withoutKey(s.replyPastes, cardId),
      replyImages: withoutKey(s.replyImages, cardId),
      replyNotices: withoutKey(s.replyNotices, cardId),
      sendingReplies: { ...s.sendingReplies, [cardId]: true },
      replyErrors: withoutKey(s.replyErrors, cardId),
      ...(leaving ? { replyLeaving: { cardId, messages: s.threads[cardId]?.length ?? 0 } } : {}),
    }));
    try {
      const fresh = collect ? await collect() : undefined;
      const reading = fresh ?? get().cardAnswers[cardId];
      const answers = reading?.answers;
      if (answers && cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
        throw new Error(CARD_ANSWERS_TOO_LONG);
      }
      // Sending hands the turn to the author: the core's push takes the card
      // off the stack unless it stayed at send time.
      const payload =
        images.length > 0 || files.length > 0 || answers?.length
          ? {
              text: text || undefined,
              ...(files.length ? { files } : {}),
              ...(answers?.length ? { answers } : {}),
              images: images.map((image) => ({
                mimeType: image.mimeType,
                data: image.data,
                ...(image.name ? { name: image.name } : {}),
              })),
            }
          : text;
      const thread = await window.infinitary.cards.reply(cardId, payload, submission, leaving);
      if (answers) {
        set((s) => ({ sentCardAnswers: { ...s.sentCardAnswers, [cardId]: answers } }));
      }
      // Paint it before anything else is awaited: the card stays on the
      // stage now, so a later line the core pushes (its author's answer)
      // must not be overwritten by this older reading.
      get().applyThread(thread.cardId, thread.messages);
      // Taken: a card with others behind it leaves now, and the
      // same rule as a close picks the card that comes up.
      if (leaving) set((s) => afterReplyDeparture(s, cardId));
      // A Firstmate-thread reply is also a first accepted captain turn.
      void get().loadFirstRun();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // The field stays held until this settles, so restore the exact draft
      // and chips on refusal. Nothing moves and nothing needs retyping.
      set((s) => ({
        replyDrafts: { ...s.replyDrafts, [cardId]: draft },
        replyPastes: { ...s.replyPastes, [cardId]: pastes },
        replyImages: { ...s.replyImages, [cardId]: images },
        replyErrors: { ...s.replyErrors, [cardId]: message },
        sendingReplies: withoutKey(s.sendingReplies, cardId),
      }));
    } finally {
      set((s) => ({
        sendingReplies: withoutKey(s.sendingReplies, cardId),
        ...(s.replyLeaving?.cardId === cardId ? { replyLeaving: null } : {}),
      }));
      const stackAtRead = get().cards;
      void window.infinitary.cards
        .list?.()
        .then((cards) => {
          if (get().cards === stackAtRead) get().applyCards(cards);
        })
        .catch(() => {});
    }
  },
  closeThread: (cardId) =>
    set((s) =>
      s.closedThreadIds.includes(cardId) ? {} : { closedThreadIds: [...s.closedThreadIds, cardId] },
    ),
  openThread: (cardId) =>
    set((s) => ({ closedThreadIds: s.closedThreadIds.filter((id) => id !== cardId) })),
  openRecord: (taskId, from) =>
    set((s) => {
      const records = [
        { taskId, ...(from ? { from } : {}) },
        // A task is one entry: its record's tab replaces its other tabs, as
        // the card's tab strip does.
        ...s.records.filter((record) => !isTaskTab(record, taskId)),
      ];
      return {
        records,
        cardIndex: 0,
        phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
      };
    }),
  openPastCard: (cardId) =>
    set((s) => {
      const records = [
        { pastCardId: cardId },
        ...s.records.filter((record) => !("pastCardId" in record) || record.pastCardId !== cardId),
      ];
      return {
        records,
        cardIndex: 0,
        phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
      };
    }),
  openBrowserView: (taskId, from) =>
    set((s) => {
      const records = [
        { browserTaskId: taskId, ...(from ? { from } : {}) },
        // One entry per task: the browser's tab replaces its other tabs.
        ...s.records.filter((record) => !isTaskTab(record, taskId)),
      ];
      return {
        records,
        cardIndex: 0,
        phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
      };
    }),
  closeBrowserView: (taskId) =>
    set((s) =>
      closeHeld(s, (record) => "browserTaskId" in record && record.browserTaskId === taskId),
    ),
  openCrewmateView: (taskId, from) =>
    set((s) => {
      // One entry per task: the Crewmate tab replaces its other tabs.
      const records = [
        { crewmateTaskId: taskId, ...(from ? { from } : {}) },
        ...s.records.filter((record) => !isTaskTab(record, taskId)),
      ];
      return {
        records,
        cardIndex: 0,
        phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
      };
    }),
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
      const active = shownCard(s.cards, s.cardIndex, s.collapsedCardIds, s.records);
      if (front) {
        // The captain's own click or key: at the front, shown, seen.
        const records: OpenRecord[] = [
          { panelCard: entry },
          ...s.records.filter((held) => !isPanelCard(held, panel, id)),
        ];
        return {
          records,
          cardIndex: 0,
          unreadCardIds: s.unreadCardIds.filter((unread) => unread !== entryId),
          phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
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
      const shown = visibleStack(s.cards, s.collapsedCardIds, records);
      const cardIndex = active ? indexKeeping(shown, active) : 0;
      return {
        records,
        cardIndex,
        unreadCardIds:
          shown[cardIndex]?.id === entryId ? s.unreadCardIds : [...s.unreadCardIds, entryId],
        phase: derivePhase(s.recording, s.cards, s.firstmateBusy, s.collapsedCardIds, records),
      };
    });
    return id;
  },
  closePanelCard: (panel, id) => set((s) => closeHeld(s, (held) => isPanelCard(held, panel, id))),
  closePanelCards: (panel) => set((s) => closeHeld(s, (held) => isPanelCard(held, panel))),
  keepPanelCard: (panel, id, kept) => set((s) => patchPanelCard(s, panel, id, { kept })),
  aimPanelCard: (panel, id, aim) => set((s) => patchPanelCard(s, panel, id, { aim })),
  closeRecord: () => {
    const s = get();
    const entry = shownCard(s.cards, s.cardIndex, s.collapsedCardIds, s.records);
    if (entry?.recordTaskId) get().closeTaskRecord(entry.recordTaskId);
    else if (entry?.pastCardId) get().closePastCard(entry.pastCardId);
    else if (entry?.browserTaskId) get().closeBrowserView(entry.browserTaskId);
    else if (entry?.crewmateTaskId) get().closeCrewmateView(entry.crewmateTaskId);
    else if (entry?.panelCard) get().closePanelCard(entry.panelCard.panel, entry.panelCard.id);
  },
  closeTaskRecord: (taskId) =>
    set((s) => closeHeld(s, (record) => "taskId" in record && record.taskId === taskId)),
  closePastCard: (cardId) =>
    set((s) => closeHeld(s, (record) => "pastCardId" in record && record.pastCardId === cardId)),
  focusCard: (cardId) => {
    const minimized = get().cards.find((card) => card.id === cardId)?.minimized;
    if (minimized) {
      if (changesOff(get().thisMac)) return false;
      // The shared owner accepts the restore before this window shows it.
      void window.infinitary.cards
        .minimize(cardId, false)
        .then(() => window.infinitary.cards.list())
        .then((cards) => {
          get().applyCards(cards);
          get().focusCard(cardId);
        })
        .catch((error: unknown) => {
          set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: String(error) } }));
        });
      return true;
    }
    // Pointing at a collapsed note brings it back onto the stack.
    const collapsedCardIds = get().collapsedCardIds.filter((id) => id !== cardId);
    const index = visibleStack(get().cards, collapsedCardIds, get().records).findIndex(
      (card) => card.id === cardId,
    );
    if (index < 0) return false;
    set((s) => ({
      cardIndex: index,
      cardFocusRequest: s.cardFocusRequest + 1,
      cardFocusTarget: cardId,
      collapsedCardIds,
      unreadCardIds: s.unreadCardIds.filter((id) => id !== cardId),
      phase: derivePhase(s.recording, s.cards, s.firstmateBusy, collapsedCardIds, s.records),
    }));
    return true;
  },
  minimizeCard: async (cardId) => {
    const mac = get().thisMac;
    try {
      if (changesOff(mac) && isView(mac)) throw new Error(changesOffWords(mac));
      await window.infinitary.cards.minimize(cardId, true);
    } catch (error) {
      set((s) => ({
        cardActionErrors: {
          ...s.cardActionErrors,
          [cardId]: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  },
  applyCards: (cards) => {
    retainCardReadingPlaces(new Set(cards.map((card) => card.id)));
    let noticed = 0;
    set((s) => {
      const reconciled = reconcileStack(s, cards, Date.now());
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
        sentCardAnswers: Object.fromEntries(
          Object.entries(s.sentCardAnswers).filter(([id]) => present.has(id)),
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
        phase: derivePhase(
          s.recording,
          cards,
          s.firstmateBusy,
          reconciled.state.collapsedCardIds,
          s.records,
        ),
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
  collapseStaleNotes: (now = Date.now()) => {
    set((s) => {
      const { state } = reconcileStack(s, s.cards, now);
      if (
        state.collapsedCardIds.length === s.collapsedCardIds.length &&
        state.collapsedCardIds.every((id) => s.collapsedCardIds.includes(id))
      ) {
        return {};
      }
      return {
        ...state,
        phase: derivePhase(
          s.recording,
          s.cards,
          s.firstmateBusy,
          state.collapsedCardIds,
          s.records,
        ),
      };
    });
  },
  applyEvent: (event) => {
    // The shared show-card door (inf:cards:show-past): Firstmate's pointing
    // and the shell's own gestures open the same held past-card entry.
    if (event.type === "past_card_shown") get().openPastCard(event.cardId);
    if (event.type === "open_card_shown") get().focusCard(event.cardId);
    // Fleet moments the character reacts to (captain-approved emote set),
    // keyed on the record since task-system P5: work landing or merging is
    // the rare success worth a celebrate; a task failing for good, or a
    // failed turn, earns a brief confusion. Only a status TRANSITION fires
    // (`from` differs), so a later write on a closed row - its worktree
    // going, a card resolving - never re-fires it. The motion is purely
    // visual - a side channel, not state - and the machine holds it off
    // while the voice has the conn.
    if (event.type === "task_changed" && event.from !== event.status) {
      const reason = event.closedReason;
      if (
        event.status === "done" &&
        (reason === "landed" ||
          reason === "merged" ||
          reason === "released" ||
          // An answer task delivered (Task B): the captain resolved its card
          // and the row closed done/answered. Keyed on the event's kind, so a
          // question row the Firstmate answered does not celebrate.
          (reason === "answered" && event.kind === "work"))
      ) {
        requestCharacterEmote("celebrate");
      } else if (event.status === "dropped" && reason === "failed") {
        requestCharacterEmote("confused");
      }
    }
    // The record states the third of the captain's crewmates that finished
    // (the create-your-own-panel slot, docs/first-launch.md): until it does,
    // a task closing done is the moment to read it again.
    if (
      event.type === "task_changed" &&
      event.status === "done" &&
      event.from !== "done" &&
      get().firstRun?.thirdCrewmateDoneAt === undefined
    )
      void get().loadFirstRun();
    if (event.type === "turn_failed") requestCharacterEmote("confused");
    // An emote's words reach the window only as a turn's reply line, which
    // the core chooses and sends (`firstmate_reply`).
    if (event.type === "firstmate_emote") requestCharacterEmote(event.emote);
    // The last turn above the input (./LastTurn): a message sent starts a
    // new pair, and the turn that read it fills in the reply line.
    if (event.type === "user_turn") {
      set((s) => ({
        lastTurn: { you: event.text, reply: null },
        lastTurnSeq: s.lastTurnSeq + 1,
      }));
    }
    if (event.type === "firstmate_reply") {
      const reply = {
        text: event.text,
        ...(event.problem ? { problem: true } : {}),
        ...(event.eligibility ? { eligibility: event.eligibility } : {}),
      };
      set((s) =>
        s.lastTurn
          ? {
              lastTurn: { ...s.lastTurn, reply },
              lastTurnReplySeq: s.lastTurnReplySeq + 1,
            }
          : {},
      );
    }
    // The crew orbit follows the same stream: spawns, activity, packets,
    // closes (character/crew/crewSignal.ts) - a side channel like the emotes.
    applyCrewEvent(crewOrbit(), event, stageNow());
    if (event.type === "task_changed" && event.kind === "work") {
      set((s) => ({
        crewActivity:
          event.status === "active"
            ? { ...s.crewActivity, [event.taskId]: event.activity }
            : withoutKey(s.crewActivity, event.taskId),
      }));
    }
    if (event.type === "firstmate_state") {
      set((s) => ({
        firstmateBusy: event.busy,
        phase: derivePhase(s.recording, s.cards, event.busy, s.collapsedCardIds, s.records),
      }));
    }
  },
  prevCard: () =>
    set((s) => {
      const cardIndex = Math.max(0, s.cardIndex - 1);
      return { cardIndex, unreadCardIds: withoutShown(s, cardIndex) };
    }),
  nextCard: () =>
    set((s) => {
      const last = visibleStack(s.cards, s.collapsedCardIds, s.records).length - 1;
      const cardIndex = Math.min(last, s.cardIndex + 1);
      return { cardIndex, unreadCardIds: withoutShown(s, cardIndex) };
    }),
}));
