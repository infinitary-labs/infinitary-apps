import {
  CARD_FILES_FIRST,
  type Card,
  type CardAction,
  type CardActionSource,
  type CardMessage,
  type CardWidth,
  cardMetaWords,
  cardPresentation,
  cardTakesReplies,
  isPreviewBody,
  splitSettleFacts,
  takesFactStrip,
} from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { type DictationSettings, dictationKeyLabel } from "@shared/dictation";
import {
  FIRST_RUN_PLACEHOLDER,
  FIRST_RUN_PLACEHOLDER_NO_VOICE,
  FIRST_RUN_PLACEHOLDER_SHORT,
  type FirstRunView,
  GATED_CHECK_PLACEHOLDER,
  GATED_PLACEHOLDER,
  isFirstRunHint,
  STANDARD_PLACEHOLDER,
  STANDARD_PLACEHOLDER_NO_VOICE,
  STANDARD_PLACEHOLDER_NO_VOICE_SHORT,
  STANDARD_PLACEHOLDER_SHORT,
  STANDARD_PLACEHOLDER_SHORTEST,
  withDictationKey,
} from "@shared/firstRun";
import { CARD_CHOICE_COMMANDS } from "@shared/keyboard";
import type { FrameAnswers, FramePicture } from "@shared/plugins/bridge";
import type { DefaultCardSize } from "@shared/preferences";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { mainDestination } from "../attachments/destinations";
import { useFileIntake } from "../attachments/useFileIntake";
import { AskedLine } from "../cards/AskedLine";
import { answersLine } from "../cards/answersLine";
import { bridgeActionIds } from "../cards/bridgeActions";
import { CardAttachment } from "../cards/CardAttachment";
import {
  CardThread,
  ChatButton,
  LiveMessageList,
  ReplyRow,
  ThreadCue,
  ThreadSegments,
} from "../cards/CardThread";
import { CrewmateView } from "../cards/CrewmateView";
import {
  CARD_DRAG_MIN,
  CARD_SIZES,
  cardPlacement,
  maximizedPlacement,
  openingCardWidth,
  requestedCardWidth,
  shownCardSize,
} from "../cards/cardGeometry";
import {
  holdReadingAnchor,
  isMaximized,
  type MaximizedAt,
  type ReadingAnchor,
  readingAnchor,
} from "../cards/cardMaximize";
import { useCardPresentation } from "../cards/cardPresentation";
import { useCardReadingPlace } from "../cards/cardReadingPlace";
import { useCardTask } from "../cards/cardTask";
import { choiceOrder, footerGroups, footerVariant } from "../cards/footerGroups";
import { PanelCardView } from "../cards/PanelCardView";
import {
  PastCardColumn,
  PastCardUnreadable,
  type PastRead,
  PastThreadColumn,
  usePastCard,
} from "../cards/PastCard";
import { CardFactsFrame, type CollectAnswers, HtmlCardBody } from "../cards/PrototypeBody";
import { RecordCard } from "../cards/RecordCard";
import { RequiredActions } from "../cards/RequiredActions";
import { RevisionNavigation } from "../cards/RevisionNavigation";
import { revisedLine } from "../cards/revisedLine";
import { StageEntry, type StageRole, useBodyEntrance } from "../cards/SurfaceReveal";
import {
  markStage,
  type PreparedDrawing,
  type PrepareFacts,
  stageOutcome,
  type Unprepared,
} from "../cards/stageMarks";
import {
  type PageStep,
  playIncoming,
  playStageMove,
  type StageMove,
  stageMove,
} from "../cards/stageMoves";
import {
  emptySlots,
  expireSlot,
  retireSlot,
  revealSlot,
  selectSlots,
  slotRoles,
} from "../cards/stageSlots";
import { TaskBrowserView } from "../cards/TaskBrowserView";
import { CardTaskKey, KeyedText } from "../cards/TaskKey";
import {
  cardWidth,
  THREAD_CARD_MAX,
  THREAD_STAGE_MARGIN,
  threadPlacement,
} from "../cards/threadGeometry";
import { useSeenReport } from "../cards/useSeenReport";
import { CrewOrbit } from "../character/crew/CrewOrbit";
import { crewOrbit, crewStatusOf } from "../character/crew/crewSignal";
import type { SummaryRoom } from "../character/crew/hover";
import { useCrewBoard } from "../character/crew/useCrewBoard";
import { Firstmate } from "../character/Firstmate";
import { setCharacterPaintHidden } from "../character/paintHidden";
import { Button, CardStack, ResponseCard, VoiceInput } from "../design";
import { type CardSize, CardSizeContext } from "../design/cards/CardSize";
import { PictureViewer, type ViewerDemo } from "../design/cards/PictureViewer";
import { CARD_MAX_HEIGHT, cardFloor } from "../design/cards/ResponseCard";
import { RiskChart, riskBodyInset, riskChartBox } from "../design/cards/RiskChart";
import { RISK_CHART_GAP } from "../design/cards/riskRadar";
import { thisDesktop } from "../design/core/desktop";
import { focusWithRing } from "../design/focus";
import { motionToken } from "../design/motion";
import { useConnectionNoticeCovers } from "../devices/RemoteControl";
import { changesOff, changesOffWords, doneThereWords, isView } from "../devices/viewWords";
import type { CardKindContribution } from "../plugins/contributions";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
} from "../plugins/frames/frameController";
import { giveFocusBack } from "../plugins/frames/frameFocus";
import { useCardKind } from "../plugins/host";
import { type CloseAsk, CloseQuestion } from "./CloseQuestion";
import { ComposerNotice } from "./ComposerNotice";
import { type CardStage, lendCardStage } from "./cardStage";
import { closeRestWords } from "./closeQuestionWords";
import { DiagnosticsNotice } from "./DiagnosticsNotice";
import { FirstRunGate } from "./FirstRunGate";
import { focusTakenElsewhere } from "./focusRecovery";
import { useCommandKeys } from "./keyHints";
import { LastTurn } from "./LastTurn";
import { oncePressesHeard, pressesSoFar } from "./presses";
import { useProjectFocus } from "./projectFocus";
import { usePromptFoot } from "./promptFoot";
import { LAST_TURN_LANE, LAST_TURN_RISE, promptFoldsRails, promptShellMax } from "./promptGeometry";
import { ReplyNoteCard } from "./ReplyNote";
import { firstTabbable, lastTabbable } from "./regions";
import { foldRails, type ShellLayout, useShellLayout } from "./shellLayout";
import {
  type CardMount,
  dismissalSuccessor,
  isHeldEntry,
  mainInputHeld,
  mainMessageRefusal,
  offStack,
  type StackEntry,
  type Theme,
  unreadAround,
  useShellStore,
  visibleStack,
} from "./store";
import { TOP_BAR_HEIGHT } from "./TopBar";
import { replyUnanswered, unsentAnswers, unsentComment } from "./unsentAnswers";
import { VoiceNotice } from "./VoiceNotice";

/** Same symmetric clearance as the script, applied in the resize's layout. */
const STAGE_CEILING = `calc(100vw - 2 * max(var(--occupied-rail-left, 0px), var(--occupied-rail-right, 0px)) - ${THREAD_STAGE_MARGIN}px)`;
/** Prompt lives on the window overlay, so its cap is the window minus
 *  occupied rails, not the stage's `cqw`. */
const PROMPT_WIDTH = `min(${CARD_SIZES.regular}px, calc(100vw - var(--occupied-rail-left, 0px) - var(--occupied-rail-right, 0px) - 2 * var(--space-4)))`;
/**
 * Where the Firstmate and the card are centred: 60px above the stage's
 * middle, lifted by half the composer's growth (`--prompt-rise`, written by
 * HomePrompt), so the air between a tall card and the input never closes.
 * In a window shorter than the shortest one at 100%, the centre follows the
 * air the stage gives back (`--prompt-floor`, `--stage-yield-*`,
 * design/styles.css): halfway between the stack's new top and its new foot.
 */
const STAGE_TOP =
  "calc(50% - 60px + (var(--space-9) - var(--prompt-floor) - var(--prompt-rise) - var(--stage-yield-top) + var(--stage-yield-lane)) / 2)";
/** The lift eases; under reduced motion it lands at once (design/styles.css). */
const STAGE_LIFT_EASE = "top var(--stage-lift-duration) var(--ease-out)";
/**
 * A maximized card's top: 16 px under the top bar (design skill
 * `components/cards/ResponseCard.prompt.md`, "Maximize").
 */
const MAXIMIZED_TOP = `calc(${TOP_BAR_HEIGHT}px + var(--space-4))`;
/** The pager's own lane under a maximized card: its 10 px of air and its 28 px arrows. */
const PAGER_LANE = 40;
/**
 * The room a maximized card has, top to bottom: the window less the top bar,
 * 16 px of air at each end, and the pager's lane when there is a pager. It
 * is the stage's `--card-max-height` while the card is maximized, so every
 * card's own cap (`CARD_MAX_HEIGHT`) reads it.
 */
const maximizedHeight = (pager: boolean) =>
  `calc(100vh - ${TOP_BAR_HEIGHT}px - 2 * var(--space-4)${pager ? ` - ${PAGER_LANE}px` : ""})`;

/**
 * How long the shown entry may wait to get ready, holding the previous
 * drawing or behind a card that left the stack: the frame watchdog's own
 * budget. Past it the entry appears as it is - an expiry is never counted
 * as readiness.
 */
const HOLD_LIMIT_MS = FRAME_WATCHDOG_INTERVAL_MS * FRAME_WATCHDOG_MISSES;

/** The shown entry's laid-out width, whatever its arrival's scale. */
function shownBox(shell: HTMLElement | null): number | undefined {
  return shell?.querySelector<HTMLElement>(':scope > [data-stage-entry="shown"]')?.offsetWidth;
}

/** The document a draw key names, less the card width it ends with (`drawKey`). */
const drawnDocument = (key: string) => key.slice(0, key.lastIndexOf(":"));

/** Where an entry sits on the stage: its thread, its widths and the layer's offset. */
type EntryView = {
  replyable: boolean;
  threadOpen: boolean;
  /**
   * The captain collapsed the thread into the card (FI3-1130): the card
   * stands alone, and its latest line sits over the reply row.
   */
  collapsed: boolean;
  /** The thread's home while it is open; `none` with no thread. */
  home: "beside" | "in-place" | "none";
  folded: boolean;
  /** The card column's width. */
  card: number;
  /** The thread column's width beside the card; 0 otherwise. */
  thread: number;
  /** The whole layer: the card, and its thread beside it. */
  width: number;
  /** A past card's one read, which also decides its width and thread. */
  past?: PastRead | null;
};

/** What decides an entry's view besides the entry itself. */
type ViewFacts = {
  layout: ShellLayout;
  threads: Record<string, CardMessage[]>;
  closedThreadIds: string[];
  cardDrags: Record<string, number>;
  defaultCardSize: DefaultCardSize;
};

/**
 * An entry's place on the stage, the same arithmetic for the shown entry
 * and the successor the stage prepares: the thread ladder when its thread
 * is open, else the card's own width (the captain's Q5 A: the host's size
 * from the body's facts and the author's hint, the saved minimum, then his drag).
 */
function entryView(
  entry: StackEntry,
  past: PastRead | null | undefined,
  facts: ViewFacts,
  maximized = false,
): EntryView {
  const pastCard = past?.state === "ready" ? past.card : undefined;
  const replyable = !isHeldEntry(entry) && cardTakesReplies(entry);
  const count = (facts.threads[entry.id] ?? []).length;
  // A past card's thread is always beside it when it has one: read-only, so
  // there is nothing to collapse and no reply row (design skill, "Past card").
  const collapsed = !pastCard && replyable && count > 0 && facts.closedThreadIds.includes(entry.id);
  const threadOpen = pastCard ? pastCard.messages.length > 0 : replyable && count > 0 && !collapsed;
  const sized = {
    width: openingCardWidth(pastCard?.width ?? entry.width, facts.defaultCardSize),
    dragged: facts.cardDrags[entry.id],
  };
  const { windowWidth, railsWidth } = facts.layout;
  if (maximized) {
    // The docks give up their width while it is maximized: the window is the stage.
    const at = maximizedPlacement(windowWidth, threadOpen);
    return {
      replyable,
      threadOpen,
      collapsed,
      home: at.home,
      folded: false,
      card: at.card,
      thread: at.thread,
      width: at.card + at.thread,
      ...(past !== undefined ? { past } : {}),
    };
  }
  const placement = threadOpen
    ? threadPlacement(windowWidth, railsWidth, requestedCardWidth(sized))
    : undefined;
  const beside = placement?.home === "beside" ? placement : undefined;
  const lone = placement ? undefined : cardPlacement(windowWidth, railsWidth, sized);
  const folded = placement?.folded ?? lone?.folded ?? false;
  // The card column's width, whichever rung it stands on.
  const card = beside ? beside.card : (placement?.card ?? lone?.card ?? 0);
  // A lone card and a card-and-thread pair share the window's centre.
  // The shell reserves symmetric clearance instead of moving either sideways.
  return {
    replyable,
    threadOpen,
    collapsed,
    home: placement?.home ?? "none",
    folded,
    card,
    thread: beside?.thread ?? 0,
    width: beside ? beside.card + beside.thread : card,
    ...(past !== undefined ? { past } : {}),
  };
}

/**
 * Why the stage does not prepare `entry` while the captain reads, or null
 * when it may (FI3-596's approved settings, FI3-871's held preparation): an
 * ordinary card, scripted or not - its page is
 * born held, so none of its own behavior starts until it is shown. Task
 * records and past cards are read when shown, since opening a record marks
 * its filing opened, and nothing is prepared behind a hidden window.
 */
function unpreparable(entry: StackEntry, windowShown: boolean): Unprepared | null {
  if (!windowShown) return "window-hidden";
  if (isHeldEntry(entry)) return "held-view";
  return null;
}

/** Whether the window is visible: nothing is prepared behind a hidden one. */
function useWindowShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setShown(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return shown;
}

/** The shown entry as it was last drawn, kept on the stage while it leaves. */
type Frozen = {
  entry: StackEntry;
  view: EntryView;
  /** The rectangle it was displayed in at the moment it stopped being shown. */
  rect: { width: number; height: number };
};

const noop = () => {};
const noAction = () => Promise.resolve();

/**
 * Where a leaving drawing stays: exactly the box it was shown in, centred
 * where the layer was centred for it, whatever the layer does now.
 */
function leavingBox(held: Frozen): CSSProperties {
  return {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: held.rect.width,
    height: held.rect.height,
    transform: "translate(-50%, -50%)",
  };
}

/**
 * The only subscriber to `cards` / `cardIndex`. Body
 * updates reconcile this layer and leave the Firstmate / voice input
 * unmounted from that traffic. A card's chrome is derived, never declared
 * (cards/tasks/agents P1): `cardPresentation` reads it off the actions and
 * the author, and how that presentation is dressed is the `card-kind`
 * registry's answer (docs/ui-plugins.md), not a switch here. The open task
 * record joins as a shell-held entry, with its own chrome and lifecycle
 * footer on the same ResponseCard surface, never a persisted card row.
 *
 * The stage keeps up to two entries mounted (`stageSlots.ts`, FI3-596): the
 * shown one, and either the successor a close would bring up, prepared
 * while the captain reads, or the drawing that is leaving. A prepared
 * successor is promoted in place - the same document, never rebuilt - and a
 * replacement that is not ready yet keeps the previous drawing, inert, until
 * it is; then one move (../cards/stageMoves: a slide for the arrows, a drop
 * for a close, else a crossfade) and one height easing. When the stack
 * empties, the last drawing drops away before the layer goes (`onEmptied`).
 */
function CardLayer({ onEmptied }: { onEmptied: () => void }) {
  const prevKeys = useCommandKeys("cards.previous");
  const nextKeys = useCommandKeys("cards.next");
  const maximizeKeys = useCommandKeys("cards.maximize");
  const minimizeKeys = useCommandKeys("cards.minimize");
  const cards = useShellStore((s) => s.cards);
  const entrancesReady = useShellStore((s) => s.cardsSnapshotLoaded);
  const bootCardId = useShellStore((s) => s.bootCardId);
  const cardIndex = useShellStore((s) => s.cardIndex);
  const unreadCardIds = useShellStore((s) => s.unreadCardIds);
  const collapsedCardIds = useShellStore((s) => s.collapsedCardIds);
  const heldBackCardIds = useShellStore((s) => s.heldBackCardIds);
  const theme = useShellStore((s) => s.theme);
  const actOnCard = useShellStore((s) => s.actOnCard);
  const closeCard = useShellStore((s) => s.closeCard);
  const prevCard = useShellStore((s) => s.prevCard);
  const nextCard = useShellStore((s) => s.nextCard);
  const threads = useShellStore((s) => s.threads);
  const threadsLoaded = useShellStore((s) => s.threadsLoaded);
  const closedThreadIds = useShellStore((s) => s.closedThreadIds);
  const crewActivity = useShellStore((s) => s.crewActivity);
  const firstmateBusy = useShellStore((s) => s.firstmateBusy);
  const loadThread = useShellStore((s) => s.loadThread);
  const closeThread = useShellStore((s) => s.closeThread);
  const openThread = useShellStore((s) => s.openThread);
  const cardDrags = useShellStore((s) => s.cardDrags);
  const defaultCardSize = useShellStore((s) => s.defaultCardSize);
  const dragCard = useShellStore((s) => s.dragCard);
  // The picture viewer (card pictures, phase 3) belongs to the card that
  // opened it: renderer-only, and gone with that card from the stage.
  const [viewer, setViewer] = useState<OpenPictures | null>(null);

  const records = useShellStore((s) => s.records);
  const closeRecord = useShellStore((s) => s.closeRecord);
  const shown = visibleStack(cards, offStack({ collapsedCardIds, heldBackCardIds }), records);
  const index = Math.min(cardIndex, shown.length - 1);
  const card = shown[index];
  // A card that landed behind the shown one is marked on the pager until
  // it is paged to (WI-18); it never takes the shown card's place.
  const unread = unreadAround(shown, index, unreadCardIds);
  // A past card (FI3-579) is read once when its entry comes to the front.
  const pastRead = usePastCard(card?.pastCardId);
  // The shown card's thread is read once, here, and so is the prepared
  // successor's (below): its history decides the width it is drawn at.
  const replyable = card !== undefined && !isHeldEntry(card) && cardTakesReplies(card);
  const cardId = card?.id;
  // The version on screen is the one the captain has seen, while the window
  // is in front of them; the card's next revision is compared with it.
  useSeenReport(isHeldEntry(card) ? undefined : cardId, card?.offerId);
  useEffect(() => {
    if (replyable && cardId) loadThread(cardId);
  }, [replyable, cardId, loadThread]);

  // Each newly shown entry starts from the saved size. Manual restore and
  // Go to the main message override it for this visit, never the next card.
  const mainFocusRequest = useShellStore((s) => s.focusRequest);
  const cardFocusRequest = useShellStore((s) => s.cardFocusRequest);
  const cardFocusTarget = useShellStore((s) => s.cardFocusTarget);
  const focusRequest = mainFocusRequest + cardFocusRequest;
  const openingSize = {
    cardId,
    defaultCardSize,
    at: cardId && defaultCardSize === "maximized" ? { entryId: cardId, focusRequest } : null,
  };
  const [sizeChoice, setSizeChoice] = useState<{
    cardId: string | undefined;
    defaultCardSize: DefaultCardSize;
    at: MaximizedAt | null;
  }>(openingSize);
  // Reset before the new entry paints, rather than flashing its usual size.
  if (sizeChoice.cardId !== cardId || sizeChoice.defaultCardSize !== defaultCardSize) {
    setSizeChoice(openingSize);
  }
  const maximized = isMaximized(sizeChoice.at, cardId, focusRequest);

  const layout = useShellLayout();
  const facts: ViewFacts = {
    layout,
    threads,
    closedThreadIds,
    cardDrags,
    defaultCardSize,
  };
  const view = card ? entryView(card, pastRead, facts, maximized) : undefined;
  const folded = view?.folded ?? false;
  // The fold is one CSS state on the document (design/styles.css): the
  // rails keep their panels and give up their width, so the measurement
  // that folded them still reads true and the pair cannot oscillate. A
  // wide card folds them the same way, and they unfold when it leaves,
  // unless the main message still needs them folded (`foldRails`). A
  // maximized card folds them too, and hides them and the main message
  // with their state untouched until it is restored.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (cardId) root.setAttribute("data-card-stack-open", "");
    else root.removeAttribute("data-card-stack-open");
    foldRails("card", folded || maximized);
    if (maximized) root.setAttribute("data-card-maximized", "");
    else root.removeAttribute("data-card-maximized");
    return () => {
      foldRails("card", false);
      root.removeAttribute("data-card-stack-open");
      root.removeAttribute("data-card-maximized");
    };
  }, [folded, cardId, maximized]);
  const [dragging, setDragging] = useState(false);

  // The successor a close would bring up - the stack's own rule, never the
  // next arrow - prepared at its own width once its thread history is read.
  // Nothing is prepared behind a hidden window, and preparing marks nothing
  // read and changes no rail.
  const windowShown = useWindowShown();
  const successor = card ? dismissalSuccessor(shown, index, unreadCardIds) : undefined;
  const refused = successor ? unpreparable(successor, windowShown) : null;
  const candidate = successor && refused === null ? successor : undefined;
  const candidateId = candidate?.id;
  const candidateReplies = candidate !== undefined && cardTakesReplies(candidate);
  useEffect(() => {
    if (candidateId && candidateReplies) loadThread(candidateId);
  }, [candidateId, candidateReplies, loadThread]);
  const candidateView =
    candidate && (!candidateReplies || threadsLoaded[candidate.id])
      ? entryView(candidate, undefined, facts, defaultCardSize === "maximized")
      : undefined;
  const warm = candidateView && candidateView.home !== "in-place" ? candidate : undefined;
  // The following card waits until this selection's reveal and height easing
  // have both finished, so preparation does not compete with the move.
  const [settledSelection, setSettledSelection] = useState<string | null>(null);
  const motion = useRef({ selection: "", reveal: false, height: false });
  const selectionId = cardId ?? "";
  if (motion.current.selection !== selectionId) {
    motion.current = { selection: selectionId, reveal: false, height: false };
  }
  const noteMotion = (part: "reveal" | "height", id: string | null) => {
    if (!id || id !== motion.current.selection) return;
    if (motion.current[part]) return;
    motion.current[part] = true;
    if (motion.current.reveal && motion.current.height) setSettledSelection(id);
  };
  const noteMotionRef = useRef(noteMotion);
  noteMotionRef.current = noteMotion;
  const allowWarm = settledSelection === cardId && cardId !== null;

  // The entries on the stage. A new selection keeps the drawing the captain
  // sees, measured now, until the shown entry is ready.
  const shellRef = useRef<HTMLDivElement>(null);
  const lastShown = useRef<{ entry: StackEntry; view: EntryView } | null>(null);
  const [slots, setSlots] = useState(emptySlots<Frozen>);
  const selection = cardId ?? null;
  let frozen: Frozen | undefined;
  const last = lastShown.current;
  if (selection !== (slots.shown?.id ?? null) && last && last.entry.id === slots.shown?.id) {
    const box = shellRef.current?.getBoundingClientRect();
    frozen = { ...last, rect: { width: box?.width ?? last.view.width, height: box?.height ?? 0 } };
  }
  // The drawing of a card that left the stack, once it has (`departed`).
  const departedKey = useRef<string | null>(null);
  // The drawing of a card that left the stack is never shown again. A card
  // that arrives while the last one drops away takes the stage as on an
  // empty one, and the card that left, put up again before the entry that
  // took its place is ready, is born afresh: Hide let its place go.
  const base =
    slots.outgoing &&
    selection !== null &&
    (slots.shown === null ||
      (slots.outgoing.key === departedKey.current && slots.outgoing.id === selection))
      ? retireSlot(slots, slots.outgoing.key)
      : slots;
  const selectedTask = card?.recordTaskId ?? card?.crewmateTaskId ?? card?.browserTaskId;
  let stage = selectSlots(
    base,
    selection,
    allowWarm ? (warm?.id ?? null) : null,
    frozen,
    // A task record's facts and body frame arrive in turn: it appears once ready.
    card?.recordTaskId !== undefined,
    // Keep Info populated only for this task’s tab visit; leaving it disposes the document.
    selectedTask ? `record:${selectedTask}` : null,
  );
  // Which move takes each drawing off the stage: the arrow pressed on it,
  // the stack it left, or neither. Decided once, when it starts to leave.
  const paged = useRef<PageStep | null>(null);
  const moves = useRef(new Map<string, StageMove>());
  for (const key of moves.current.keys())
    if (key !== stage.outgoing?.key) moves.current.delete(key);
  if (stage.outgoing && !moves.current.has(stage.outgoing.key)) {
    const previous = stage.outgoing.view.entry;
    const previousTask = previous.recordTaskId ?? previous.crewmateTaskId ?? previous.browserTaskId;
    moves.current.set(
      stage.outgoing.key,
      stageMove(
        stage.outgoing.id,
        shown,
        paged.current,
        selectedTask !== undefined && selectedTask === previousTask,
      ),
    );
  }
  // An arrow press counts for the selection it made, never a later one.
  if (selection !== (slots.shown?.id ?? null)) paged.current = null;

  // Which document each mounted slot last drew, at which width: the shown
  // entry is ready when that is its current one. A prepared page that drew
  // held - its scripts not started - is not ready until it is shown, its
  // scripts ran and it drew again (FI3-871); it is kept apart, and so is a
  // prepared page that was refused or stopped.
  const drawn = useRef(new Map<string, string>());
  const held = useRef(new Map<string, string>());
  const failedSlots = useRef(new Set<string>());
  // How wide the shown entry was laid out when its slot last drew. The
  // stylesheet narrows a lone card at once (`STAGE_CEILING`) when a panel
  // docks or the window shrinks, before the stage's own layout catches up,
  // so a body can draw at its new width under a key naming the old one.
  const drawnBox = useRef(new Map<string, number>());
  const shownSlot = useRef<string | undefined>(undefined);
  const [, redraw] = useState(0);
  const markDrawn = useCallback((slot: string, key: string) => {
    const box = slot === shownSlot.current ? shownBox(shellRef.current) : undefined;
    if (box === undefined) drawnBox.current.delete(slot);
    else drawnBox.current.set(slot, box);
    if (drawn.current.get(slot) === key) return;
    drawn.current.set(slot, key);
    markStage(held.current.has(slot) ? "activated" : "drawn", { slot });
    redraw((n) => n + 1);
  }, []);
  const markHeld = useCallback((slot: string, key: string, failed: boolean) => {
    if (failed) {
      failedSlots.current.add(slot);
      return;
    }
    if (held.current.get(slot) === key) return;
    held.current.set(slot, key);
    markStage("drawn", { slot, held: true });
  }, []);
  const markBorn = useCallback((slot: string) => markStage("born", { slot }), []);
  // The card width comes last, so `drawnDocument` reads the rest.
  const drawKey = (entry: StackEntry, at: EntryView) =>
    `${theme}:${at.past?.state === "ready" ? at.past.card.body : entry.body}:${at.home}:${at.card}`;
  const drawingOf = (slot: string, key: string): PreparedDrawing => {
    if (failedSlots.current.has(slot)) return "failed";
    const at = [drawn.current.get(slot), held.current.get(slot)];
    if (at.includes(key)) return "current";
    return at.some((seen) => seen !== undefined) ? "stale" : "none";
  };
  // One outcome for each selection that replaces a shown card, against what
  // the stage had prepared just before it (./cards/stageMarks).
  const prepared = useRef<{ facts: PrepareFacts; windowShown: boolean }>({
    facts: { successor: null, warm: null },
    windowShown: true,
  });
  const selected = useRef<{ card: string | null; outcome: string; how: string | null } | null>(
    null,
  );
  if (slots.shown !== null && selection !== slots.shown.id) {
    const promoted = slots.warm?.id === selection ? slots.warm : null;
    selected.current = {
      card: selection,
      outcome: stageOutcome(
        card ? { id: card.id, held: isHeldEntry(card) } : null,
        prepared.current.facts,
        promoted && card && view ? drawingOf(promoted.key, drawKey(card, view)) : "none",
        prepared.current.windowShown,
      ),
      how:
        stage.shown === null
          ? null
          : stage.shown.key === promoted?.key
            ? "promote"
            : stage.shown.key === slots.outgoing?.key
              ? null
              : "mount",
    };
  }
  const shownKey = stage.shown?.key;
  shownSlot.current = shownKey;
  const shownReady =
    card !== undefined &&
    view !== undefined &&
    shownKey !== undefined &&
    drawn.current.get(shownKey) === drawKey(card, view);
  // A prepared page that drew held comes forward like any prepared card
  // (stageMoves), once it is shown and drew again.
  const shownHeld =
    !shownReady &&
    card !== undefined &&
    view !== undefined &&
    shownKey !== undefined &&
    held.current.get(shownKey) === drawKey(card, view)
      ? shownKey
      : null;
  if (shownKey && shownReady) stage = revealSlot(stage, shownKey);
  if (stage !== slots) setSlots(stage);
  const successorFacts: PrepareFacts["successor"] = successor
    ? {
        id: successor.id,
        unprepared:
          refused ??
          (!candidateView
            ? "thread-pending"
            : candidateView.home === "in-place"
              ? "in-place"
              : stage.warm?.id === successor.id
                ? null
                : stage.outgoing
                  ? "slot-busy"
                  : "settling"),
      }
    : null;
  useLayoutEffect(() => {
    prepared.current = {
      facts: { successor: successorFacts, warm: stage.warm?.id ?? null },
      windowShown,
    };
    const select = selected.current;
    if (!select) return;
    selected.current = null;
    markStage("select", { card: select.card, outcome: select.outcome });
    if (select.how === "promote" || select.how === "mount")
      markStage(select.how, { card: select.card, slot: shownKey });
  });

  const presentation = useCardPresentation(
    shellRef,
    cardId ?? null,
    `${cardId}:${theme}:${pastRead?.state === "ready" ? pastRead.card.body : card?.body}`,
    `${layout.windowWidth}:${layout.left}:${layout.right}:${dragging}:${theme}:${maximized}`,
    shownReady,
    (id) => noteMotionRef.current("height", id),
  );
  useLayoutEffect(() => {
    lastShown.current = card && view ? { entry: card, view } : null;
  });
  // A body that drew before the stage's layout caught up with the window
  // drew at the width it has now: once the layout names the same document,
  // its drawing is current if the shown entry is as wide as when it drew.
  // Nothing else would tell it so, since its width did not change again.
  useLayoutEffect(() => {
    if (shownReady || !shownKey || !card || !view) return;
    const seen = drawn.current.get(shownKey);
    const box = drawnBox.current.get(shownKey);
    const key = drawKey(card, view);
    if (seen === undefined || box === undefined || drawnDocument(seen) !== drawnDocument(key))
      return;
    if (shownBox(shellRef.current) === box) markDrawn(shownKey, key);
  });
  // A document that left the stage draws again before it counts as ready.
  useEffect(() => {
    for (const map of [drawn.current, held.current, drawnBox.current])
      for (const slot of map.keys()) if (stage.order[slot] === undefined) map.delete(slot);
    for (const slot of failedSlots.current)
      if (stage.order[slot] === undefined) failedSlots.current.delete(slot);
  });
  // The shown entry appeared, and then the drawing it replaced had gone.
  const visibleKey = stage.revealed ? (shownKey ?? null) : null;
  const settledKey = visibleKey !== null && stage.outgoing === null ? visibleKey : null;
  useLayoutEffect(() => {
    if (visibleKey) markStage("visible", { slot: visibleKey });
  }, [visibleKey]);
  useLayoutEffect(() => {
    if (settledKey) markStage("settled", { slot: settledKey });
  }, [settledKey]);
  // A wait that never becomes ready ends: the entry appears as it is. The
  // limit runs from the selection, whether the drawing it replaces is still
  // held or has already dropped away after its card left the stack.
  const holding = shownKey !== undefined && !stage.revealed ? shownKey : null;
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setSlots((s) => expireSlot(s, holding)), HOLD_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [holding]);
  // One move: the ready entry appears as the drawing it replaces leaves,
  // then that drawing retires. When the stack empties, the last drawing
  // leaves the same way and then the layer goes. Reduced motion makes each
  // a cut.
  // A departure starts its drop immediately, independently of the next
  // document. Only paging/replacement may hold a drawing until ready.
  const departed = stage.outgoing && !shown.some((entry) => entry.id === stage.outgoing?.id);
  if (departed) departedKey.current = stage.outgoing?.key ?? null;
  const leaving = stage.revealed || departed ? (stage.outgoing?.key ?? null) : null;
  // Capture readiness when the departure starts; becoming ready later must
  // not restart a drop already in progress. A prepared page that drew held
  // comes forward when it appears (`forward`), not with the drop.
  const incomingReady = useRef(stage.revealed);
  incomingReady.current = stage.revealed;
  const incomingHeld = useRef(shownHeld);
  incomingHeld.current = shownHeld;
  const forward = useRef<{ key: string; move: StageMove } | null>(null);
  const revealFlight = useRef<string | null>(null);
  // An incoming card still coming in after the drawing it replaced has gone.
  const arriving = useRef<{ opened: string | null; stop: () => void; arrived: boolean } | null>(
    null,
  );
  const selectionRef = useRef(cardId);
  selectionRef.current = cardId;
  useLayoutEffect(() => {
    const pending = forward.current;
    if (!pending || !visibleKey) return;
    forward.current = null;
    const opened = selectionRef.current ?? null;
    const incoming =
      pending.key === visibleKey
        ? shellRef.current?.querySelector<HTMLElement>(':scope > [data-stage-entry="shown"]')
        : null;
    if (!incoming) {
      revealFlight.current = null;
      noteMotionRef.current("reveal", opened);
      return;
    }
    revealFlight.current = opened;
    // Only a move cut short by the next one stops.
    const stop = playIncoming(pending.move, incoming, () => {
      if (revealFlight.current === opened) revealFlight.current = null;
      noteMotionRef.current("reveal", opened);
    });
    return () => {
      stop();
      if (revealFlight.current === opened) revealFlight.current = null;
    };
  }, [visibleKey]);
  const emptied = !card && stage.outgoing ? stage.outgoing.key : null;
  const emptiedRef = useRef(onEmptied);
  emptiedRef.current = onEmptied;
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const key = leaving ?? emptied;
    if (!key || !shell) {
      if (!cardId) emptiedRef.current();
      if (!revealFlight.current) noteMotionRef.current("reveal", cardId ?? null);
      return;
    }
    const incoming =
      leaving && incomingReady.current
        ? shell.querySelector<HTMLElement>(':scope > [data-stage-entry="shown"]')
        : null;
    const drawing = shell.querySelector<HTMLElement>(':scope > [data-stage-entry="outgoing"]');
    let gone = false;
    const finish = () => {
      gone = true;
      if (leaving) setSlots((s) => retireSlot(s, key));
      else emptiedRef.current();
    };
    if (!drawing) {
      finish();
      noteMotionRef.current("reveal", cardId ?? null);
      return;
    }
    const move = moves.current.get(key) ?? { kind: "swap" };
    const comes = leaving && !incomingReady.current ? incomingHeld.current : null;
    const opened = cardId ?? null;
    if (comes) {
      forward.current = { key: comes, move };
      revealFlight.current = opened;
    }
    if (incoming) revealFlight.current = opened;
    const flight = { opened, stop: () => {}, arrived: false };
    flight.stop = playStageMove(
      move,
      drawing,
      incoming,
      finish,
      comes
        ? undefined
        : () => {
            flight.arrived = true;
            if (arriving.current === flight) arriving.current = null;
            if (revealFlight.current === opened) revealFlight.current = null;
            noteMotionRef.current("reveal", opened);
          },
    );
    return () => {
      // The incoming card finishes its own move after the drawing has gone,
      // until the next selection cuts it short (below); only a move cut short
      // by the next one stops.
      if (!gone) {
        flight.stop();
        // A cancelled reveal has no finish event. Release its ownership so
        // returning to the drawing still held can settle without a new move.
        if (revealFlight.current === opened) revealFlight.current = null;
        if (comes && forward.current?.key === comes) forward.current = null;
      } else if (incoming && !flight.arrived) arriving.current = flight;
    };
  }, [leaving, emptied, cardId]);
  // The next selection cuts short the incoming card of the one it leaves,
  // also once that card's drawing has gone, and releases the reveal's
  // ownership as above: a selection that starts no new move, such as a
  // return to a drawing still held, never waits on it.
  useLayoutEffect(() => {
    const left = cardId ?? null;
    return () => {
      const flight = arriving.current;
      if (!flight || flight.opened !== left) return;
      arriving.current = null;
      flight.stop();
      if (revealFlight.current === left) revealFlight.current = null;
    };
  }, [cardId]);

  // The card pointed at takes focus once it appears (`focusCard`), unless
  // the captain began a press since he pointed, which decides where focus
  // goes (app/presses.ts): heard once every frame the pointing came from has
  // answered, while the card stays the one shown for that request. A
  // request for a card that is no longer the one coming forward is let go,
  // so it never fires on a later visit.
  const focusedVisit = useRef(0);
  useLayoutEffect(() => {
    if (cardFocusTarget === null) return;
    if (cardFocusTarget !== cardId) {
      useShellStore.setState({ cardFocusTarget: null });
      return;
    }
    if (!cardFocusRequest || focusedVisit.current === cardFocusRequest || !stage.revealed) return;
    const entry = shellRef.current?.querySelector<HTMLElement>('[data-stage-entry="shown"]');
    if (!entry || entry.inert) return;
    focusedVisit.current = cardFocusRequest;
    const since = useShellStore.getState().cardFocusPresses;
    oncePressesHeard(() => {
      if (useShellStore.getState().cardFocusRequest !== cardFocusRequest) return;
      if (!entry.isConnected || entry.inert || entry.dataset.stageEntry !== "shown") return;
      if (pressesSoFar() === since) focusWithRing(entry, { preventScroll: true });
    });
    useShellStore.setState({ cardFocusTarget: null });
  }, [cardFocusTarget, cardFocusRequest, stage.revealed, cardId]);

  const viewing = viewer !== null && viewer.cardId === cardId ? viewer : null;
  useEffect(() => {
    if (viewer && viewer.cardId !== cardId) setViewer(null);
  }, [viewer, cardId]);

  // The close asks once, under the card's ×, when the captain picked or
  // changed an answer (the captain's Q3 A): closing is the keep and sends
  // nothing, so those picks would otherwise go without a word.
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);
  // A close asked for by a key puts focus on the question it raises.
  const [confirmFocus, setConfirmFocus] = useState(false);
  useEffect(() => {
    setConfirmingClose((open) => (open === cardId ? open : null));
  }, [cardId]);
  // The arrows and the close, lent to the window's card commands (./cardStage).
  const lentStage = useRef<CardStage | null>(null);
  useEffect(() => lendCardStage(() => lentStage.current), []);
  // Where focus goes once the thread has collapsed or opened (FI3-1130): the
  // control that undoes it, ringed when a key did it. Taken in the commit
  // that draws the control, and only once.
  const threadFocus = useRef<{ cardId: string; to: "cue" | "collapse"; byKey: boolean } | null>(
    null,
  );
  useLayoutEffect(() => {
    const pending = threadFocus.current;
    if (!pending) return;
    threadFocus.current = null;
    const control = shellRef.current?.querySelector<HTMLElement>(
      `:scope > [data-stage-entry="shown"][data-stage-entry-id="${CSS.escape(pending.cardId)}"] ${
        pending.to === "cue" ? "[data-thread-cue]" : "[data-thread-collapse]"
      }`,
    );
    if (!control) return;
    if (pending.byKey) focusWithRing(control, { preventScroll: true });
    else control.focus({ preventScroll: true });
  });

  // Maximize and restore (design skill ResponseCard, "Maximize"): the same
  // entry stays mounted, its body, answers and reply with it; only its room
  // changes, at once, and the reading place in its body holds.
  const sizeFocus = useRef(false);
  const sizeAnchor = useRef<{ body: HTMLElement; anchor: ReadingAnchor } | null>(null);
  const toggleSize = (byKey = false) => {
    if (!cardId) return;
    const body = shellRef.current?.querySelector<HTMLElement>(
      ':scope > [data-stage-entry="shown"] [data-card-body]',
    );
    sizeAnchor.current = body
      ? {
          body,
          anchor: readingAnchor({
            top: body.scrollTop,
            height: body.clientHeight,
            scrollHeight: body.scrollHeight,
          }),
        }
      : null;
    sizeFocus.current = byKey;
    setSizeChoice({
      ...sizeChoice,
      at: maximized
        ? null
        : {
            entryId: cardId,
            focusRequest:
              useShellStore.getState().focusRequest + useShellStore.getState().cardFocusRequest,
          },
    });
  };
  const sized = useRef(maximized);
  // The drawing a size changes in moves at once: the stage's lift does not ease it.
  const sizeChanged = sized.current !== maximized;
  useLayoutEffect(() => {
    if (sized.current === maximized) return;
    sized.current = maximized;
    const held = sizeAnchor.current;
    sizeAnchor.current = null;
    const release = held?.body.isConnected ? holdReadingAnchor(held.body, held.anchor) : undefined;
    // From a key, focus goes to the size control, as a click leaves it there.
    if (sizeFocus.current) {
      sizeFocus.current = false;
      const toggle = shellRef.current?.querySelector<HTMLElement>(
        ':scope > [data-stage-entry="shown"] [data-card-size-toggle]',
      );
      if (toggle) focusWithRing(toggle);
    }
    // The lift eases again from the next drawing on.
    const frame = requestAnimationFrame(() => redraw((n) => n + 1));
    return () => {
      cancelAnimationFrame(frame);
      release?.();
    };
  }, [maximized]);
  const cardSize: CardSize | null = cardId
    ? {
        maximized,
        toggle: toggleSize,
        ...maximizeKeys,
        ...(!isHeldEntry(card)
          ? {
              minimize: {
                run: () => {
                  void useShellStore.getState().minimizeCard(card.id);
                },
                ...minimizeKeys,
              },
            }
          : {}),
      }
    : null;

  // The drawing a stack that just emptied is still dropping away, if any.
  const exit = card ? undefined : stage.outgoing?.view;
  const layerCard = card ?? exit?.entry;
  const layerView = view ?? exit?.view;
  lentStage.current = null;
  if (!layerCard || !layerView) return null;

  const askClose = (byKey: boolean) => {
    if (!card || !cardId) return;
    // The × again, while it asks, keeps the card: only the question closes it.
    if (confirmingClose === cardId) {
      if (!byKey) setConfirmingClose(null);
      return;
    }
    const shell = useShellStore.getState();
    const unsent = unsentAnswers(card, shell.cardAnswers[cardId], shell.sentCardAnswers[cardId]);
    const wrote = unsentComment(shell.replyDrafts[cardId], shell.sentCardAnswers[cardId]);
    if (unsent > 0 || wrote || replyUnanswered(card, shell.threads[cardId])) {
      setConfirmingClose(cardId);
      setConfirmFocus(byKey);
      return;
    }
    setConfirmingClose(null);
    closeCard(cardId, mountOf(card));
  };
  const requestClose = () => askClose(false);
  const closeConfirm =
    card && cardId && confirmingClose === cardId
      ? {
          onClose: () => {
            setConfirmingClose(null);
            closeCard(cardId, mountOf(card));
          },
          onKeep: () => setConfirmingClose(null),
          onPutAside: () => {
            setConfirmingClose(null);
            void useShellStore.getState().minimizeCard(cardId);
          },
          focus: confirmFocus,
        }
      : undefined;
  const onCardAction: StackedCardProps["onAction"] = (actionId, source, value, collect, mounted) =>
    cardId ? actOnCard(cardId, actionId, source, value, collect, mounted) : Promise.resolve();

  const openPictures = (
    set: { index: number; pictures: FramePicture[]; demo?: ViewerDemo },
    opener: HTMLIFrameElement | null,
    recordTitle?: string,
  ) => {
    // A held record or past card reads its title rather than carrying it on the stack entry.
    const title = card?.recordTaskId
      ? (recordTitle ?? "Task record")
      : pastRead?.state === "ready"
        ? pastRead.card.title
        : card?.title;
    if (card && cardId) setViewer({ cardId, title: title ?? "", ...set, opener });
  };
  // Paging remembers which way the arrow went, for the slide (../cards/stageMoves).
  const page = (dir: 1 | -1) => {
    if (cardId) paged.current = { from: cardId, dir };
    if (dir === 1) nextCard();
    else prevCard();
  };
  // The thread collapses into the card's foot or opens beside it again. A
  // reply field that has focus keeps it; otherwise focus goes to what
  // undoes the move: the latest line, or the thread's collapse.
  const showThread = (open: boolean, byKey: boolean) => {
    if (!cardId) return;
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLTextAreaElement &&
      focused.closest(`[data-card-reply="${CSS.escape(cardId)}"]`) !== null;
    threadFocus.current = typing ? null : { cardId, to: open ? "collapse" : "cue", byKey };
    if (open) openThread(cardId);
    else closeThread(cardId);
  };
  const foldsThread = view?.replyable === true && (view.collapsed || view.home === "beside");
  lentStage.current =
    card && cardId
      ? {
          shownId: cardId,
          page,
          close: () => (isHeldEntry(card) ? closeRecord() : askClose(true)),
          maximized,
          toggleSize: () => toggleSize(true),
          ...(!isHeldEntry(card)
            ? {
                minimize: () => {
                  void useShellStore.getState().minimizeCard(card.id);
                },
              }
            : {}),
          ...(foldsThread ? { thread: () => showThread(view.collapsed, true) } : {}),
        }
      : null;
  const working = (entry: StackEntry) =>
    entry.author === "firstmate"
      ? firstmateBusy
      : entry.author === "crewmate" &&
        entry.taskId !== undefined &&
        crewStatusOf(crewActivity[entry.taskId] ?? null) === "working";

  const beside = layerView.home === "beside";
  const lone = layerView.home === "none";
  // The drag's upper bound is the room the stage gives now: a drag never
  // folds the docks, and a card they folded for can still be narrowed.
  const dragMax = Math.max(
    CARD_DRAG_MIN,
    cardWidth(
      folded ? layout.windowWidth : layout.windowWidth - layout.railsWidth,
      CARD_SIZES.full,
    ),
  );
  // The lone-card tab returns the card to regular. Offer it only when that
  // exact placement unfolds the docks; a narrow window still needs them folded.
  const canRestoreLonePanels = !cardPlacement(layout.windowWidth, layout.railsWidth, {
    dragged: THREAD_CARD_MAX,
  }).folded;
  // While maximized, Tab and ⇧Tab go round the card and its pager (`FocusEdge`).
  const focusRound = (to: "first" | "last") => {
    const layer = shellRef.current?.closest<HTMLElement>("[data-card-layer]");
    const stack = layer?.querySelector<HTMLElement>(":scope > [data-card-envelope]");
    const stop = stack ? (to === "first" ? firstTabbable(stack) : lastTabbable(stack)) : null;
    if (stop) focusWithRing(stop);
  };
  return (
    <>
      {folded && view && cardId && (view.threadOpen || canRestoreLonePanels) && (
        <FoldedRailTabs
          left={layout.left > 0}
          right={layout.right > 0}
          // The docks come back by giving up what folded them: the thread
          // collapses, or a card folded for its width returns to regular.
          onShow={() =>
            view.threadOpen ? showThread(false, false) : dragCard(cardId, THREAD_CARD_MAX)
          }
        />
      )}
      <div
        // The layer is the stack's while a card is up; once the stack empties
        // it only holds the last drawing as it drops away.
        data-card-layer={card ? "" : undefined}
        data-card-layer-leaving={card ? undefined : ""}
        data-thread-home={layerView.home}
        data-card-width={layerCard.width ?? "wide"}
        data-card-size={shownCardSize(layerView.card)}
        data-card-maximized={maximized ? "" : undefined}
        style={
          {
            position: "fixed",
            left: "50%",
            // Lifted by half the composer's growth (docs/composer.md); a
            // maximized card hangs under the top bar instead.
            top: maximized ? MAXIMIZED_TOP : STAGE_TOP,
            transform: maximized ? "translateX(-50%)" : "translate(-50%,-50%)",
            width: layerView.width,
            // The pair fits by construction; a lone card also gets the
            // synchronous symmetric ceiling while script catches up.
            ...(beside ? {} : { maxWidth: STAGE_CEILING }),
            // Replacement bodies mount at their destination width; geometry
            // belongs only to the measured shell's height.
            transition: maximized || sizeChanged ? "none" : STAGE_LIFT_EASE,
            ...(maximized ? { "--card-max-height": maximizedHeight(shown.length > 1) } : {}),
          } as CSSProperties
        }
      >
        {maximized && <FocusEdge onFocus={() => focusRound("last")} />}
        <CardStack
          index={index}
          count={shown.length}
          unreadBefore={unread.before}
          unreadAfter={unread.after}
          width="100%"
          envelopeHeight={CARD_MAX_HEIGHT}
          // A maximized card stands alone: the cards behind it show only on its pager.
          peekStyle={maximized ? { display: "none" } : undefined}
          onPrev={() => page(-1)}
          onNext={() => page(1)}
          prevKeys={prevKeys}
          nextKeys={nextKeys}
        >
          <div
            ref={shellRef}
            data-card-presentation=""
            onPointerDownCapture={presentation.pressGeometry}
            onFocusCapture={presentation.cancelGeometry}
          >
            {slotRoles(stage).map(({ id, key, role }) => {
              const held =
                role === "outgoing"
                  ? stage.outgoing?.view
                  : role === "parked"
                    ? stage.parked?.view
                    : undefined;
              const entry = role === "shown" ? card : role === "warm" ? warm : held?.entry;
              const at = role === "shown" ? view : role === "warm" ? candidateView : held?.view;
              if (!entry || !at) return null;
              const isShown = role === "shown";
              const style: CSSProperties = isShown
                ? {
                    position: "relative",
                    // Its surface fills the room a maximized card has (`cardFloor`).
                    ...(maximized ? { "--card-floor": "var(--card-max-height)" } : {}),
                    // Selected but not ready: the drawing it replaces stays
                    // in sight while this card draws underneath.
                    ...(stage.revealed ? {} : { opacity: 0, pointerEvents: "none" }),
                    // A prepared card coming forward appears by that move alone.
                    ...(forward.current?.key === key
                      ? {}
                      : { transition: "opacity var(--dur-fast) var(--ease-out)" }),
                  }
                : role === "warm"
                  ? {
                      // Drawn at its own width where it will appear, unseen.
                      position: "absolute",
                      top: 0,
                      left: "50%",
                      width: at.width,
                      transform: "translateX(-50%)",
                      opacity: 0,
                      pointerEvents: "none",
                    }
                  : role === "parked"
                    ? {
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: at.width,
                        visibility: "hidden",
                        pointerEvents: "none",
                      }
                    : { ...(held ? leavingBox(held) : {}), pointerEvents: "none" };
              return (
                <StageEntry
                  key={key}
                  entryId={entry.id}
                  role={role}
                  ready={stage.revealed || (stage.outgoing !== null && !departed)}
                  enabled={entrancesReady && stage.outgoing === null}
                  initial={id === bootCardId}
                  style={style}
                >
                  {/* Always provided, so a prepared entry promoted in place keeps its tree. */}
                  <CardSizeContext.Provider value={isShown ? cardSize : null}>
                    <EntrySurface
                      entry={entry}
                      view={at}
                      role={role}
                      active={isShown}
                      theme={theme}
                      slot={key}
                      drawKey={drawKey(entry, at)}
                      onDrawn={markDrawn}
                      onHeld={markHeld}
                      onBorn={markBorn}
                      onInteraction={isShown ? presentation.cancelGeometry : undefined}
                      onClose={isShown ? (isHeldEntry(entry) ? closeRecord : requestClose) : noop}
                      closeConfirm={isShown ? closeConfirm : undefined}
                      onAction={isShown ? onCardAction : noAction}
                      onPicture={isShown ? openPictures : undefined}
                      onThread={isShown ? showThread : undefined}
                      working={working(entry)}
                    />
                  </CardSizeContext.Provider>
                </StageEntry>
              );
            })}
            {card && !stage.revealed && stage.outgoing && !departed && (
              // While the drawing is held, a click meant for it lands here,
              // never on the selected card's controls drawn underneath.
              <div
                data-stage-shield=""
                aria-hidden="true"
                style={{ ...leavingBox(stage.outgoing.view), zIndex: 1 }}
              />
            )}
          </div>
          {lone && cardId && !maximized && (
            <CardEdges
              width={layerView.card}
              max={dragMax}
              onInteract={presentation.cancelGeometry}
              onDragging={(value) => {
                presentation.cancelGeometry();
                setDragging(value);
              }}
              onDrag={(width) => {
                presentation.cancelGeometry();
                dragCard(cardId, width);
              }}
              onReset={() => {
                presentation.cancelGeometry();
                dragCard(cardId, null);
              }}
            />
          )}
        </CardStack>
        {maximized && <FocusEdge onFocus={() => focusRound("first")} />}
      </div>
      {viewing && (
        <PictureViewer
          title={viewing.title}
          pictures={viewing.pictures}
          index={viewing.index}
          demo={viewing.demo}
          onClose={() => {
            setViewer(null);
            // Back to the picture inside the frame that opened it.
            giveFocusBack(viewing.opener);
          }}
        />
      )}
    </>
  );
}

/** The one surface a live card and its thread share (`CardSurface`). */
const PAIR_SURFACE: CSSProperties = {
  boxSizing: "border-box",
  background: "var(--acrylic-bg)",
  backdropFilter: "var(--acrylic-blur)",
  WebkitBackdropFilter: "var(--acrylic-blur)",
  border: "1px solid var(--acrylic-border)",
  borderRadius: "var(--radius-l)",
  boxShadow: "var(--acrylic-shadow)",
  overflow: "hidden",
};

/**
 * ONE container for a live card, its thread and its reply row (the
 * captain's tweak 1): one surface, one border, one radius, one shadow, and
 * a single hairline between the columns - the thread column's own left
 * border. The card, its body and its reply field keep their place in this
 * tree whether the thread is beside the card or not, so opening, closing or
 * moving the thread never rebuilds the body or the field (FI3-596): only
 * the grid's columns change. The floor is the card's own (ResponseCard's
 * 340 px), held here so the reply row under a lone card counts within it.
 */
function CardSurface({
  beside,
  thread,
  children,
}: {
  beside: boolean;
  thread: number;
  children: React.ReactNode;
}) {
  return (
    <div
      data-card-surface=""
      data-card-pair={beside ? "" : undefined}
      style={{
        ...PAIR_SURFACE,
        display: "grid",
        gridTemplateColumns: beside ? `minmax(0, 1fr) ${thread}px` : "minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr) auto",
        maxHeight: CARD_MAX_HEIGHT,
        minHeight: cardFloor(340),
      }}
    >
      {children}
    </div>
  );
}

/**
 * One stack entry's surface - a live card with its thread, a task record,
 * or a past card - for whichever role it has on the stage. Only the shown
 * entry is `active`: a prepared successor draws its body alone, and a
 * leaving drawing keeps its look, but neither can act.
 */
function EntrySurface({
  entry,
  view,
  role,
  active,
  theme,
  slot,
  drawKey,
  onDrawn,
  onHeld,
  onBorn,
  onInteraction,
  onClose,
  closeConfirm,
  onAction,
  onPicture,
  onThread,
  working,
}: {
  entry: StackEntry;
  view: EntryView;
  role: StageRole;
  active: boolean;
  theme: Theme;
  /** The mount this surface belongs to on the stage (`stageSlots.ts`). */
  slot: string;
  /** The document this entry is drawing now, at its width. */
  drawKey: string;
  onDrawn: (slot: string, key: string) => void;
  /** A prepared page drew held, or was refused or stopped (`HtmlCardBody` `onHeld`). */
  onHeld: (slot: string, key: string, failed: boolean) => void;
  onBorn: (slot: string) => void;
  onInteraction: (() => void) | undefined;
  onClose: () => void;
  closeConfirm: StackedCardProps["closeConfirm"];
  onAction: StackedCardProps["onAction"];
  onPicture: StackedCardProps["onPicture"];
  /** The thread collapses (false) or opens (true); `byKey` when a key pressed it. Shown entry only. */
  onThread?: ((open: boolean, byKey: boolean) => void) | undefined;
  working: boolean;
}) {
  const kind = useCardKind(
    entry.recordTaskId
      ? "task-record"
      : !entry.pastCardId &&
          !entry.replyNote &&
          !entry.browserTaskId &&
          !entry.crewmateTaskId &&
          !entry.panelCard
        ? cardPresentation(entry)
        : "",
  );
  const id = entry.id;
  const key = useRef(drawKey);
  key.current = drawKey;
  const drew = useCallback(() => onDrawn(slot, key.current), [onDrawn, slot]);
  const drewHeld = useCallback(
    (failed: boolean) => onHeld(slot, key.current, failed),
    [onHeld, slot],
  );
  const born = useCallback(() => onBorn(slot), [onBorn, slot]);
  // The card's one collect handle: its footer and its reply row read the
  // body's form through it, wherever the reply row sits.
  const collectRef = useRef<CollectAnswers | null>(null);
  const beside = view.home === "beside";

  if (entry.pastCardId) {
    const past = view.past?.state === "ready" ? view.past.card : undefined;
    if (!past) {
      return (
        <PastCardUnreadable
          width="100%"
          loading={view.past?.state !== "unreadable"}
          onClose={onClose}
          onDrawn={drew}
        />
      );
    }
    return beside ? (
      // The same pair as a live thread: one container, one surface, one
      // hairline between the columns.
      <div
        data-card-pair=""
        style={{
          ...PAIR_SURFACE,
          display: "flex",
          alignItems: "stretch",
          maxHeight: CARD_MAX_HEIGHT,
          minHeight: cardFloor(0),
        }}
      >
        <PastCardColumn
          past={past}
          theme={theme}
          width={view.card}
          size={shownCardSize(view.card)}
          surface={false}
          onClose={onClose}
          onDrawn={drew}
          onInteraction={onInteraction}
          onPicture={onPicture}
        />
        <PastThreadColumn past={past} width={view.thread} />
      </div>
    ) : (
      <PastCardColumn
        past={past}
        theme={theme}
        width="100%"
        size={shownCardSize(view.card)}
        onClose={onClose}
        onDrawn={drew}
        onInteraction={onInteraction}
        onPicture={onPicture}
      />
    );
  }
  if (entry.replyNote) {
    return <ReplyNoteCard note={entry.replyNote} width="100%" onClose={onClose} onDrawn={drew} />;
  }
  if (entry.recordTaskId) {
    return (
      <RecordCard
        taskId={entry.recordTaskId}
        theme={theme}
        onClose={onClose}
        onDrawn={drew}
        onPicture={onPicture}
      />
    );
  }
  if (entry.panelCard) {
    return <PanelCardView card={entry.panelCard} theme={theme} onClose={onClose} onDrawn={drew} />;
  }
  if (entry.crewmateTaskId) {
    return <CrewmateView taskId={entry.crewmateTaskId} onClose={onClose} onDrawn={drew} />;
  }
  if (entry.browserTaskId) {
    return (
      <TaskBrowserView
        taskId={entry.browserTaskId}
        from={entry.browserFrom}
        onClose={onClose}
        onDrawn={drew}
      />
    );
  }
  const prepared = role === "warm";
  // The last rung: the card's body becomes the thread behind a segmented
  // control. It needs a stage under 720px, which the app's own 960px window
  // minimum puts out of reach.
  const inPlace = view.home === "in-place";
  // The card's one field (INF-924): above its choices, under one hairline,
  // while no thread is open beside it, and the foot of the thread column
  // once one is. The same draft either way; the focus follows the field.
  const replyable = view.replyable && !prepared;
  const collectHere: CollectAnswers = (focusUnpicked) =>
    collectRef.current?.(focusUnpicked) ??
    Promise.resolve(useShellStore.getState().cardAnswers[id]);
  return (
    <RevisionNavigation
      cardId={id}
      offerId={entry.offerId}
      active={active}
      onOpen={() => onThread?.(true, true)}
    >
      <CardSurface beside={beside} thread={view.thread}>
        <StackedCard
          card={entry}
          chrome={kind.chrome}
          theme={theme}
          surface={false}
          bare={prepared}
          active={active}
          reply={
            replyable && !beside ? (
              <ReplyRow
                cardId={id}
                lead={
                  view.collapsed && !inPlace ? (
                    <ThreadCue
                      cardId={id}
                      card={entry}
                      working={working}
                      onOpen={(byKey) => onThread?.(true, byKey)}
                    />
                  ) : undefined
                }
                collect={collectHere}
              />
            ) : undefined
          }
          sharedCollectRef={collectRef}
          size={shownCardSize(view.card)}
          onClose={onClose}
          closeConfirm={closeConfirm}
          onAction={onAction}
          onPicture={onPicture}
          onDrawn={drew}
          onHeld={drewHeld}
          onBorn={born}
          onInteraction={onInteraction}
          inPlaceThread={inPlace}
          threadWorking={working}
          style={{ gridColumn: 1, gridRow: beside ? "1 / span 2" : 1 }}
        />
        {beside && !prepared && (
          <CardThread
            cardId={id}
            card={entry}
            working={working}
            onCollapse={(byKey) => onThread?.(false, byKey)}
            style={{ gridColumn: 2, gridRow: 1 }}
          />
        )}
        {replyable && beside && (
          <div
            data-card-reply-slot=""
            style={{
              gridColumn: 2,
              gridRow: 2,
              minWidth: 0,
              borderLeft: "1px solid var(--line-2)",
            }}
          >
            <ReplyRow cardId={id} inThread collect={collectHere} />
          </div>
        )}
      </CardSurface>
    </RevisionNavigation>
  );
}

/** An open picture viewer: the card it came from, its set, and the frame to return focus to. */
type OpenPictures = {
  cardId: string;
  title: string;
  index: number;
  pictures: FramePicture[];
  /** A demo the viewer plays over its poster, the set's one picture. */
  demo?: ViewerDemo;
  opener: HTMLIFrameElement | null;
};

/**
 * The folded docks' edge tabs (the captain's tweak 2): a 4px accent strip
 * at each side whose panels gave up their width, saying they are one click
 * away. The click collapses the thread, which is what returns them - the
 * thread's messages stay on the record and the reply row returns to the
 * foot of the card under its latest line.
 */
function FoldedRailTabs({
  left,
  right,
  onShow,
}: {
  left: boolean;
  right: boolean;
  onShow: () => void;
}) {
  const tab = (side: "left" | "right") => (
    <button
      key={side}
      type="button"
      data-rail-tab={side}
      aria-label="Show panels"
      title="Show panels"
      onClick={onShow}
      style={{
        position: "fixed",
        [side]: 0,
        top: "var(--space-8)",
        bottom: "var(--space-4)",
        width: 4,
        padding: 0,
        border: "none",
        cursor: "pointer",
        background: "var(--accent)",
        opacity: 0.5,
        borderRadius: side === "left" ? "0 2px 2px 0" : "2px 0 0 2px",
        pointerEvents: "auto",
      }}
    />
  );
  return (
    <>
      {left && tab("left")}
      {right && tab("right")}
    </>
  );
}

/**
 * One end of a maximized card's Tab round: focus that reaches it goes on to
 * the card's other end, so Tab and ⇧Tab stay with the card and its pager
 * while the rest of the window is aside (design skill ResponseCard,
 * "Maximize"). Nothing is drawn, and a pointer never lands on it.
 */
function FocusEdge({ onFocus }: { onFocus: () => void }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus guard, which passes focus on at once
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focus guard, which passes focus on at once
      tabIndex={0}
      data-focus-edge=""
      onFocus={onFocus}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
    />
  );
}

/** How far one arrow key moves a card's edge. */
const EDGE_KEY_STEP = 16;

/**
 * The captain's drag on a lone card's edges (his Q5 A: facts, then the
 * author's hint, then his own hand). The card is centred, so one edge moved
 * by a pixel moves the other the same way and the card grows by two. It
 * holds while the card is up and through its revisions; a double click, or
 * Enter on an edge the keyboard reached, gives the card back the width the
 * host decided. Never a setting.
 */
function CardEdges({
  width,
  max,
  onDragging,
  onInteract,
  onDrag,
  onReset,
}: {
  /** The card's shown width, in px. */
  width: number;
  max: number;
  onDragging: (dragging: boolean) => void;
  onInteract: () => void;
  onDrag: (width: number) => void;
  onReset: () => void;
}) {
  const held = useRef<{ pointer: number; x: number; width: number; grow: 1 | -1 } | null>(null);
  const [lit, setLit] = useState<"left" | "right" | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(CARD_DRAG_MIN, next)));
  const edge = (side: "left" | "right") => {
    // Moving the right edge right widens the card; the left edge, left.
    const grow = side === "right" ? 1 : -1;
    const active = lit === side;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA separator with a value), which an <hr> cannot be
      <div
        key={side}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize card"
        aria-valuemin={CARD_DRAG_MIN}
        aria-valuemax={max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        data-card-edge={side}
        onPointerEnter={() => setLit(side)}
        onPointerLeave={() => {
          if (!held.current) setLit(null);
        }}
        onFocus={() => {
          onInteract();
          setLit(side);
        }}
        onBlur={() => setLit(null)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          held.current = { pointer: event.pointerId, x: event.clientX, width, grow };
          onDragging(true);
        }}
        onPointerMove={(event) => {
          const start = held.current;
          if (!start || start.pointer !== event.pointerId) return;
          onDrag(clamp(start.width + 2 * start.grow * (event.clientX - start.x)));
        }}
        onPointerUp={(event) => {
          if (held.current?.pointer !== event.pointerId) return;
          held.current = null;
          onDragging(false);
          setLit(null);
        }}
        onPointerCancel={() => {
          held.current = null;
          onDragging(false);
          setLit(null);
        }}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowRight"
              ? grow * EDGE_KEY_STEP
              : event.key === "ArrowLeft"
                ? -grow * EDGE_KEY_STEP
                : 0;
          if (step !== 0) onDrag(clamp(width + 2 * step));
          else if (event.key === "Home") onDrag(CARD_DRAG_MIN);
          else if (event.key === "End") onDrag(clamp(max));
          else if (event.key === "Enter" && !event.repeat) onReset();
          else return;
          event.preventDefault();
        }}
        style={{
          position: "absolute",
          top: "var(--space-4)",
          bottom: "var(--space-4)",
          [side]: -6,
          width: 12,
          cursor: "ew-resize",
          outline: "none",
          touchAction: "none",
          zIndex: 1,
        }}
      >
        {/* The grip shows only while the edge is under the pointer, held or focused. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 4,
            top: "50%",
            width: 4,
            height: 32,
            marginTop: -16,
            borderRadius: "var(--radius-pill)",
            background: "var(--accent)",
            opacity: active ? 1 : 0,
            transition: "opacity var(--dur-fast) var(--ease-out)",
          }}
        />
      </div>
    );
  };
  return (
    <>
      {edge("left")}
      {edge("right")}
    </>
  );
}

/** The lifecycle and offer of a mounted card, as a gesture on it reports them. */
function mountOf(card: Card): CardMount {
  return {
    ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
    ...(card.offerId ? { offerId: card.offerId } : {}),
  };
}

/**
 * The footer's queue group (inline decisions, contract 4.22): how many of
 * the questions the body asks have an answer, and how many of those answers
 * differ from what the card proposed. Picks wait here until a footer button
 * sends them; nothing in the body sends on its own. Words written under a
 * question's Something else row are its answer, so they count as a pick.
 */
function pickedCount(answers: FrameAnswers | undefined): number {
  return (
    answers?.answers.filter((answer) => answer.values.length > 0 || answer.written !== undefined)
      .length ?? 0
  );
}

function footerAnswers(answers: FrameAnswers, preview: boolean): string {
  const answered = preview ? answers.answered : pickedCount(answers);
  return answersLine({ answered, of: answers.of, changed: answers.changed }, preview);
}

type StackedCardProps = {
  sharedCollectRef?: React.MutableRefObject<CollectAnswers | null>;
  card: Card;
  chrome: CardKindContribution["chrome"];
  theme: Theme;
  width?: number | string;
  /** The size the card is shown at, told to its body's document. */
  size: CardWidth;
  /** False when the card is one column of the pair's single container. */
  surface?: boolean;
  /** Prepared before it is shown: only its body, drawn at its final width. */
  bare?: boolean;
  /**
   * The captain can act on it: shown and on screen. A prepared or leaving
   * card raises nothing, and the readings its body posts wait until it is
   * shown before they become its saved draft.
   */
  active?: boolean;
  /**
   * The card's one field, drawn above its choices with Chat at the right
   * edge of their row (INF-924); none while its thread is open beside it.
   */
  reply?: React.ReactNode;
  /** The in-place rung: the body becomes the thread behind a segmented control. */
  inPlaceThread?: boolean;
  threadWorking?: boolean;
  onClose: () => void;
  /** The close is asking first: changed picks would go unsent (Q3 A). */
  closeConfirm?: CloseAsk | undefined;
  /** Settles with the request's outcome: a body's own `inf.action` rejects with its refusal. */
  onAction: (
    actionId: string,
    source?: CardActionSource,
    value?: unknown,
    collect?: CollectAnswers,
    mounted?: CardMount,
  ) => Promise<void>;
  onPicture?: React.ComponentProps<typeof HtmlCardBody>["onPicture"];
  onDrawn?: () => void;
  /** Its prepared body drew held, or its page was refused or stopped (`HtmlCardBody`). */
  onHeld?: (failed: boolean) => void;
  onBorn?: () => void;
  onInteraction?: () => void;
  style?: CSSProperties;
};

/** A persisted card in its derived chrome, body in the sandboxed frame. */
function StackedCard({
  card,
  chrome,
  theme,
  width = "100%",
  size,
  surface = true,
  bare = false,
  active = true,
  reply,
  inPlaceThread = false,
  threadWorking = false,
  onClose,
  closeConfirm,
  onAction,
  onPicture,
  sharedCollectRef,
  onDrawn,
  onHeld,
  onBorn,
  onInteraction,
  style,
}: StackedCardProps) {
  const bodyRef = useCardReadingPlace(card.id);
  const pending = useShellStore((s) => s.pendingCardActions[card.id]);
  const error = useShellStore((s) => s.cardActionErrors[card.id]);
  // On a Mac controlling another, its buttons are off while that Mac is
  // out of reach (docs/view.md): still Tab stops, whose note says until when.
  const offWords = useShellStore((s) =>
    changesOff(s.thisMac) && isView(s.thisMac) ? changesOffWords(s.thisMac) : null,
  );
  // A button done only on that Mac - one that opens one of its Settings
  // sections, or hands the captain a task's browser - says so on rest,
  // before the click; the click sends nothing (`actOnCard`).
  const thisMac = useShellStore((s) => s.thisMac);
  const thereWords = (action: CardAction) =>
    isView(thisMac) ? doneThereWords(thisMac, action) : null;
  const noticeCovers = useConnectionNoticeCovers(offWords);
  const choiceKeys = [
    useCommandKeys(CARD_CHOICE_COMMANDS[0]),
    useCommandKeys(CARD_CHOICE_COMMANDS[1]),
    useCommandKeys(CARD_CHOICE_COMMANDS[2]),
    useCommandKeys(CARD_CHOICE_COMMANDS[3]),
  ];
  // ⌘1 is the default wherever it sits; the rest count leftward from the
  // right edge (docs/keyboard.md).
  const choiceIndex = useMemo(
    () => new Map(choiceOrder(card.actions).map((action, at) => [action.id, at])),
    [card.actions],
  );
  const messages = useShellStore((s) => s.threads[card.id]) ?? [];
  const answers = useShellStore((s) => s.cardAnswers[card.id]);
  const sentAnswers = useShellStore((s) => s.sentCardAnswers[card.id]);
  const words = useShellStore((s) => s.replyDrafts[card.id]);
  // A file or picture goes only as a reply: the choices wait until it has.
  const filesFirst = useShellStore(
    (s) =>
      reply !== undefined &&
      ((s.replyImages[card.id]?.length ?? 0) > 0 || (s.replyPastes[card.id]?.length ?? 0) > 0),
  );
  const setCardAnswers = useShellStore((s) => s.setCardAnswers);
  const localCollectRef = useRef<CollectAnswers | null>(null);
  const collectRef = sharedCollectRef ?? localCollectRef;
  const [showing, setShowing] = useState<"card" | "thread">("card");
  const bodyEntrance = useBodyEntrance();
  const admitted = useRef(active);
  admitted.current = active;
  // The latest reading a not-yet-shown body posted: its saved draft once shown.
  const heldAnswers = useRef<FrameAnswers | null>(null);
  useEffect(() => {
    const reading = heldAnswers.current;
    if (!active || !reading) return;
    heldAnswers.current = null;
    setCardAnswers(card.id, reading);
  }, [active, card.id, setCardAnswers]);
  // Initial thread history decides the width the body is born at.
  const threadLoaded = useShellStore((s) => s.threadsLoaded[card.id] === true);
  const bodyPending = cardTakesReplies(card) && !threadLoaded;
  const showThread = inPlaceThread && showing === "thread";
  useLayoutEffect(() => {
    if (!bodyPending && showThread) {
      bodyEntrance.onDrawn();
      onDrawn?.();
    }
  }, [bodyPending, showThread, bodyEntrance.onDrawn, onDrawn]);
  // A settle card's fact strip stands beside its buttons, in view however
  // long the body is, and the body shows the rest (`splitSettleFacts`); so
  // does the strip on the note of a task that merges on its own.
  const split = useMemo(
    () => (takesFactStrip(card) ? splitSettleFacts(card.body) : undefined),
    [card],
  );
  const body = split?.body ?? card.body;
  // A merge card's risk chart is chrome at its top right (docs/card-authoring.md
  // "The risk chart"); the body keeps clear of the box it holds.
  const asideRef = useRef<HTMLDivElement>(null);
  const risk = card.risk;
  const marks = split
    ? card.changes?.marks?.map((mark) => (mark > split.at ? mark - split.facts.length : mark))
    : card.changes?.marks;
  const asking = answers !== undefined && answers.of > 0;
  // A closing choice waits until every question the body requires has an
  // answer (the captain's Q2 A); a non-closing one sends what there is.
  const unanswered = asking && answers.answered < answers.of;
  const collect: CollectAnswers = (focusUnpicked) =>
    collectRef.current?.(focusUnpicked) ??
    Promise.resolve(useShellStore.getState().cardAnswers[card.id]);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The task the card is about leads its head as the card's door to the
  // task's record (INF-358); a card about no task draws no key.
  const task = useCardTask(card);
  const groups = footerGroups(card.actions);
  const footer =
    card.actions.length > 0 || reply !== undefined ? (
      <>
        {asking && (
          <span
            data-card-answers=""
            aria-live="polite"
            style={{
              alignSelf: "center",
              // The note that a file goes first follows it, at the left.
              marginRight: filesFirst ? undefined : "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
            }}
          >
            {footerAnswers(answers, isPreviewBody(card.body))}
          </span>
        )}
        {filesFirst && card.actions.length > 0 && (
          <span
            data-card-files-first=""
            role="status"
            style={{
              alignSelf: "center",
              marginRight: "auto",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
            }}
          >
            {CARD_FILES_FIRST}
          </span>
        )}
        {(groups.length > 0 ? groups : [{ key: "choices", actions: [] }]).map(
          (group, index, all) => (
            // Each group stays on one row: a narrow card moves the choices
            // down together, never the default alone (design skill
            // ResponseCard footer rule).
            <div
              key={group.key}
              style={{
                display: "flex",
                gap: "var(--space-2)",
                flexWrap: "nowrap",
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {group.actions.map((action) => {
                const at = choiceIndex.get(action.id);
                const choiceKey = at === undefined ? undefined : choiceKeys[at];
                const answering =
                  action.effect?.kind === "host" &&
                  action.effect.op === "confirm-required-action" &&
                  card.awaiting === "answer";
                const actionOff = answering
                  ? "Your first mate is answering on this card"
                  : offWords;
                return (
                  <Button
                    key={action.id}
                    // Where Go to the card's buttons lands (docs/keyboard.md).
                    data-card-action-default={action.default ? "" : undefined}
                    data-card-choice={at !== undefined && at < choiceKeys.length ? at : undefined}
                    aria-keyshortcuts={choiceKey?.keys ? choiceKey["aria-keyshortcuts"] : undefined}
                    // The key sits inside the button at the size its label gives it.
                    keys={choiceKey?.keys}
                    variant={footerVariant(action)}
                    style={{
                      minWidth: 0,
                      maxWidth: "100%",
                      flexShrink: 1,
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                      ...(unanswered && action.default
                        ? {
                            background: "var(--bg-2)",
                            color: "var(--fg-3)",
                            borderColor: "var(--line-1)",
                          }
                        : {}),
                    }}
                    pending={pending?.actionId === action.id}
                    disabled={Boolean(pending)}
                    off={actionOff !== null || filesFirst}
                    note={
                      noticeCovers
                        ? undefined
                        : (actionOff ??
                          (filesFirst ? CARD_FILES_FIRST : thereWords(action)) ??
                          undefined)
                    }
                    // The notice shows the reason in place of the label; a
                    // screen reader on the button still hears it.
                    aria-description={actionOff ?? undefined}
                    aria-disabled={unanswered && action.default ? true : undefined}
                    // The offer this footer belongs to rides the click, read now.
                    onClick={() => {
                      if (unanswered && action.default) {
                        void collect(true);
                        return;
                      }
                      void onAction(action.id, "chrome", undefined, collect, mountOf(card));
                    }}
                  >
                    {action.label}
                  </Button>
                );
              })}
              {/* Chat after the choices, at the right edge (INF-924). */}
              {index === all.length - 1 && reply !== undefined && (
                <ChatButton cardId={card.id} collect={collect} />
              )}
            </div>
          ),
        )}
      </>
    ) : undefined;
  return (
    <ResponseCard
      kind={chrome}
      bodyRef={bodyRef}
      title={card.title}
      titleWords={<KeyedText text={card.title} own={card.taskId} />}
      taskKey={task && !bare ? <CardTaskKey task={task} cardId={card.id} /> : undefined}
      meta={card.author === "firstmate" && task ? task.title : cardMetaWords(card.meta)}
      reviewFinding={Boolean(card.reviewTaskId)}
      place={card.place}
      model={card.model}
      revised={card.changes ? revisedLine(card.changes) : undefined}
      asked={card.asked ? <AskedLine asked={card.asked} /> : undefined}
      width={width}
      surface={surface}
      bare={bare}
      // The surface around the card holds the floor (`CardSurface`).
      minHeight={surface ? undefined : 0}
      headExtra={
        inPlaceThread ? (
          <ThreadSegments showing={showing} count={messages.length} onShow={setShowing} />
        ) : undefined
      }
      onClose={onClose}
      closeRef={closeRef}
      closeRest={closeRestWords(task?.key)}
      closeAsking={closeConfirm !== undefined}
      closeAsk={
        <CloseQuestion
          ask={closeConfirm}
          count={unsentAnswers(card, answers, sentAnswers)}
          wrote={unsentComment(words, sentAnswers)}
          unanswered={
            replyUnanswered(card, messages)
              ? {
                  author:
                    card.author === "firstmate"
                      ? "your first mate"
                      : (task?.assignee ?? "the crewmate"),
                  taskKey: task?.key,
                }
              : undefined
          }
          preview={isPreviewBody(card.body)}
          trigger={closeRef}
        />
      }
      actions={footer}
      comment={reply}
      aside={
        risk && !showThread
          ? { node: <RiskChart risk={risk} />, width: riskChartBox().width, ref: asideRef }
          : undefined
      }
      attachment={
        !bare && (card.attachment || card.requiredActions?.length) ? (
          <>
            {card.attachment && <CardAttachment cardId={card.id} attachment={card.attachment} />}
            {card.requiredActions && <RequiredActions actions={card.requiredActions} />}
          </>
        ) : undefined
      }
      facts={
        split && !bare ? (
          <CardFactsFrame facts={split.facts} theme={theme} title={card.title} width={size} />
        ) : undefined
      }
      style={style}
    >
      {error && (
        <p role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>
          <KeyedText text={error} own={card.taskId} />
        </p>
      )}
      {bodyPending ? (
        <div aria-busy="true" style={{ minHeight: "var(--space-7)" }} />
      ) : showThread ? (
        <LiveMessageList card={card} messages={messages} working={threadWorking} />
      ) : (
        <HtmlCardBody
          body={body}
          ownTaskId={card.taskId}
          reveal={bodyEntrance.reveal}
          onDrawn={() => {
            bodyEntrance.onDrawn();
            onDrawn?.();
          }}
          onInteraction={onInteraction}
          admit={() => admitted.current}
          // A prepared body's page is held until the card is shown.
          active={active}
          {...(onHeld ? { onHeld } : {})}
          {...(onBorn ? { onBorn } : {})}
          theme={theme}
          title={card.title}
          // An effect-bearing action is the host chrome's own button and is
          // never declared to the body's frame (`bridgeActionIds`): a card
          // script must not be able to merge its own PR at mount.
          declaredActionIds={bridgeActionIds(card.actions)}
          width={size}
          marks={marks}
          revisionStart={(start) =>
            split && start > split.at ? start - split.facts.length : start
          }
          {...(risk
            ? { inset: { from: asideRef, until: riskBodyInset(), gap: RISK_CHART_GAP } }
            : {})}
          onAction={(actionId, value) =>
            onAction(actionId, "frame", value, undefined, mountOf(card))
          }
          onPicture={onPicture}
          // A starter's words go to the main message box without sending.
          onDraft={(text) => {
            const shell = useShellStore.getState();
            if (mainMessageRefusal(shell) === null) shell.beginDraft(text);
          }}
          form={{
            fill: () => useShellStore.getState().cardAnswers[card.id]?.answers,
            onAnswers: (reading) => {
              if (admitted.current) setCardAnswers(card.id, reading);
              else heldAnswers.current = reading;
            },
          }}
          collectRef={collectRef}
        />
      )}
    </ResponseCard>
  );
}

/**
 * Stage layer: cards, the first-launch gate, and the screen label. Lives in
 * the inset stage. The gate mounts while it is open or still dissolving;
 * it never takes the stage from a card (a card is the host's or the
 * Firstmate's word, and outranks the caption).
 */
export const HomeScreen = memo(function HomeScreen() {
  const phase = useShellStore((s) => s.phase);
  // Only whether there is a draft: typing never re-renders the stage.
  const drafting = useShellStore((s) => s.inputText.length > 0);
  const gateOpen = useShellStore((s) => s.firstRun?.gateOpen === true);
  const showCards = useShellStore((s) => visibleStack(s.cards, offStack(s), s.records).length > 0);
  // The card layer outlives the stack by the last card's drop (CardLayer's `onEmptied`).
  const [layerUp, setLayerUp] = useState(showCards);
  if (showCards && !layerUp) setLayerUp(true);
  const emptied = useCallback(() => setLayerUp(false), []);
  const listening = phase === "recording" || drafting;
  const screenLabel = showCards ? "Working" : listening ? "Listening" : "Null state";
  return (
    <div
      data-screen-label={screenLabel}
      style={{ position: "absolute", inset: 0, pointerEvents: showCards ? "auto" : "none" }}
    >
      {!showCards && <GateLayer open={gateOpen} />}
      {(showCards || layerUp) && <CardLayer onEmptied={emptied} />}
    </div>
  );
});

/** Keeps the gate mounted through its dissolve after it closes. */
function GateLayer({ open }: { open: boolean }) {
  const everOpen = useRef(open);
  if (open) everOpen.current = true;
  return everOpen.current ? <FirstRunGate /> : null;
}

/**
 * The input's hint - the gated line, the first-run hint, or the standard
 * one - fullest form first, then the shorter form a narrow input shows.
 */
export function inputPlaceholder(input: {
  firstRun: FirstRunView | null;
  voiceSupported: boolean | null;
  dictation?: DictationSettings | null;
  transcribing: boolean;
}): readonly string[] {
  if (input.transcribing) return ["transcribing what you said", "transcribing"];
  if (input.firstRun?.gateOpen)
    return [input.firstRun.freshCheck ? GATED_CHECK_PLACEHOLDER : GATED_PLACEHOLDER];
  const noVoice =
    input.voiceSupported === false ||
    input.dictation === null ||
    input.dictation?.enabled === false;
  const typeOnly = [STANDARD_PLACEHOLDER_NO_VOICE, STANDARD_PLACEHOLDER_NO_VOICE_SHORT];
  if (input.dictation?.enabled === false) return typeOnly;
  const desktop = thisDesktop();
  const key = dictationKeyLabel(input.dictation?.key ?? desktop.dictationKey, desktop.keys);
  const withKey = (hint: string) => withDictationKey(hint, key);
  if (input.firstRun && isFirstRunHint(input.firstRun)) {
    return noVoice
      ? [FIRST_RUN_PLACEHOLDER_NO_VOICE]
      : [
          withKey(FIRST_RUN_PLACEHOLDER),
          withKey(FIRST_RUN_PLACEHOLDER_SHORT),
          FIRST_RUN_PLACEHOLDER_NO_VOICE,
        ];
  }
  return noVoice
    ? typeOnly
    : [
        withKey(STANDARD_PLACEHOLDER),
        withKey(STANDARD_PLACEHOLDER_SHORT),
        withKey(STANDARD_PLACEHOLDER_SHORTEST),
      ];
}

/**
 * Where a crewmate's summary may sit: the mate is painted behind the rails'
 * panels, the top bar and the input, so the summary keeps to the open window
 * between the bar and the input and never goes under a panel.
 */
function crewSummaryRoom(): SummaryRoom {
  const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  return {
    within: {
      left: 0,
      right: window.innerWidth,
      top: box("[data-topbar]")?.bottom ?? 0,
      bottom: box("[data-prompt-dock]")?.top ?? window.innerHeight,
    },
    avoid: [...document.querySelectorAll("[data-side-panel]")].map((panel) => {
      const { left, top, right, bottom } = panel.getBoundingClientRect();
      return { left, top, right, bottom };
    }),
  };
}

/** The keystroke count, read by the character's own frame: typing never renders the stage. */
const readKick = () => useShellStore.getState().kick;

/**
 * Character, window-centred, painted behind the rails and cards, with its
 * crew in orbit around it; the mounted frame fades to hidden under cards.
 */
export const HomeMate = memo(function HomeMate() {
  const orbit = crewOrbit();
  const thisMac = useShellStore((s) => s.thisMac);
  const homeName = thisMac?.role === "view" ? thisMac.name : HERE.This;
  useSyncExternalStore(orbit.subscribe, () => orbit.version);
  useEffect(() => {
    let heard = false;
    const off = window.infinitary.devices.onDevices((devices) => {
      heard = true;
      orbit.configure(devices, homeName);
    });
    void window.infinitary.devices.list().then(
      (devices) => {
        if (!heard) orbit.configure(devices, homeName);
      },
      () => undefined,
    );
    return off;
  }, [orbit, homeName]);
  const phase = useShellStore((s) => s.phase);
  // Only whether there is a draft: typing never re-renders the stage.
  const drafting = useShellStore((s) => s.inputText.length > 0);
  const submitted = useShellStore((s) => s.submitted);
  const firstmateBusy = useShellStore((s) => s.firstmateBusy);
  const showCards = useShellStore((s) => visibleStack(s.cards, offStack(s), s.records).length > 0);
  const listening = phase === "recording" || drafting;
  const { names, facts } = useCrewBoard();
  // The project in light (docs/project-focus.md): the pill a pointer or the
  // keyboard rests on in the open row, else the focus; All projects lights all.
  const { focus, rest } = useProjectFocus();
  const litProject = rest !== null ? (rest === "all" ? null : rest) : focus;
  const crewFocus = useMemo(
    () => ({
      project: litProject,
      projectOf: (taskId: string) => facts[taskId]?.task.projectId,
    }),
    [litProject, facts],
  );
  const openRecord = useShellStore((s) => s.openRecord);
  const showNames = useShellStore((s) => s.showCrewModelNames);
  const theme = useShellStore((s) => s.theme);
  // Naming the colors for someone new (docs/first-launch.md): only once the
  // core has read the record, and only for the words not yet taught.
  const workingTaught = useShellStore((s) => s.firstRun?.workingWordAt !== null);
  const idleTaught = useShellStore((s) => s.firstRun?.idleWordAt !== null);
  const recordRead = useShellStore((s) => s.firstRun !== null);
  const noteCrewWord = useShellStore((s) => s.noteCrewWord);
  const teach = useMemo(
    () =>
      recordRead && !(workingTaught && idleTaught)
        ? {
            taught: { working: workingTaught, idle: idleTaught },
            onTaught: noteCrewWord,
          }
        : null,
    [recordRead, workingTaught, idleTaught, noteCrewWord],
  );
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showCards) {
      setCharacterPaintHidden(false);
      return;
    }
    const frame = frameRef.current;
    const duration = frame ? motionToken(frame, "--dur-slow") : 0;
    if (duration <= 0) {
      setCharacterPaintHidden(true);
      return;
    }
    const timer = window.setTimeout(() => setCharacterPaintHidden(true), duration);
    return () => window.clearTimeout(timer);
  }, [showCards]);
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        ref={frameRef}
        data-character-frame=""
        inert={showCards}
        style={{
          position: "absolute",
          left: "50%",
          top: STAGE_TOP,
          transform: "translate(-50%,-50%)",
          opacity: showCards ? 0 : 1,
          visibility: showCards ? "hidden" : "visible",
          transition: `opacity var(--dur-slow) var(--ease-out), visibility 0s ${showCards ? "var(--dur-slow)" : "0s"},${STAGE_LIFT_EASE}`,
        }}
      >
        <CrewOrbit
          model={orbit}
          names={showNames ? names : undefined}
          facts={facts}
          onOpen={openRecord}
          summaryRoom={crewSummaryRoom}
          interactive={!showCards}
          theme={theme}
          teach={teach}
          focus={crewFocus}
        >
          <Firstmate
            listening={listening}
            busy={firstmateBusy}
            size={300}
            kick={readKick}
            submitSignal={submitted}
            theme={theme}
          />
        </CrewOrbit>
      </div>
    </div>
  );
});

/**
 * The input's room between the docked rails (docs/renderer.md, "Docked rails
 * and the input's room"): where they would leave it narrower than
 * `PROMPT_MIN_WIDTH`, they fold for it as they do for a card, with no card
 * up too, and come back once the window or a smaller Size gives the room
 * back. It reads what the rails ask for, never what they take, so the fold
 * cannot undo itself; it is its own component, so typing never re-reads it.
 */
const PromptRoom = memo(function PromptRoom() {
  const layout = useShellLayout();
  const folds = promptFoldsRails(layout.windowWidth, layout.left, layout.right);
  useLayoutEffect(() => {
    foldRails("prompt", folds);
    return () => foldRails("prompt", false);
  }, [folds]);
  return null;
});

/** Prompt, window-centred, painted above the stage so it stays clickable. */
export const HomePrompt = memo(function HomePrompt() {
  const phase = useShellStore((s) => s.phase);
  const inputText = useShellStore((s) => s.inputText);
  const setInputText = useShellStore((s) => s.setInputText);
  const setInputCaret = useShellStore((s) => s.setInputCaret);
  const keystroke = useShellStore((s) => s.keystroke);
  const abandonRecording = useShellStore((s) => s.abandonRecording);
  const acceptRecording = useShellStore((s) => s.acceptRecording);
  const submit = useShellStore((s) => s.submit);
  const attachments = useShellStore((s) => s.attachments);
  const attachImages = useShellStore((s) => s.attachImages);
  const removeAttachment = useShellStore((s) => s.removeAttachment);
  const pastes = useShellStore((s) => s.pastes);
  const attachPastedText = useShellStore((s) => s.attachPastedText);
  const removePaste = useShellStore((s) => s.removePaste);
  const recallLastSent = useShellStore((s) => s.recallLastSent);
  const showComposerNotice = useShellStore((s) => s.showComposerNotice);
  const dictation = useShellStore((s) => s.dictation);
  const voiceSupported = useShellStore((s) => s.voiceSupported);
  const transcribing = useShellStore((s) => s.transcribing);
  const firstRun = useShellStore((s) => s.firstRun);
  const held = useShellStore(mainInputHeld);
  const view = useShellStore((s) => s.view);
  const recording = phase === "recording";
  const gateOpen = firstRun?.gateOpen === true;
  // The last turn above the input takes room the stage gives it the way it
  // gives the composer's growth (./promptGeometry `LAST_TURN_RISE`).
  const laneRise = useShellStore((s) => (s.lastTurn ? LAST_TURN_RISE : 0));
  // The whole lane, for what sits above the input and must clear it (the gate).
  const hasLastTurn = useShellStore((s) => Boolean(s.lastTurn));
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--last-turn-lane", `${hasLastTurn ? LAST_TURN_LANE : 0}px`);
    return () => {
      root.style.removeProperty("--last-turn-lane");
    };
  }, [hasLastTurn]);

  const focusRequest = useShellStore((s) => s.focusRequest);
  const focusCaret = useShellStore((s) => s.focusCaret);
  const focusYields = useShellStore((s) => s.focusYields);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Files given to the main input: bound to it by key, so a result that
  // lands late is still this draft's and never another input's.
  const fileDestination = useMemo(
    () =>
      mainDestination(
        () => inputRef.current,
        () => mainInputHeld(useShellStore.getState()),
      ),
    [],
  );
  const fileIntake = useFileIntake(fileDestination);
  const focusHandled = useRef(0);
  useEffect(() => {
    // Each request is consumed exactly once, at the moment it fires: a
    // later view or recording change must not replay a stale focus steal
    // (returning from Settings uses the shared lost-focus fallback).
    if (focusRequest === focusHandled.current) return;
    focusHandled.current = focusRequest;
    if (view === "home" && !recording) {
      // A way back gives way to a control that took focus in this render,
      // such as the close question a command from search asked, and to
      // command search opened again before the way back ran.
      if (
        focusYields === focusRequest &&
        (focusTakenElsewhere() || useShellStore.getState().commandSearchOpen)
      )
        return;
      const input = inputRef.current;
      input?.focus();
      // A transcript, a recalled turn or an inlined paste places the caret
      // after React renders the text; a card closing keeps the selection.
      if (input && focusCaret?.request === focusRequest) {
        input.setSelectionRange(focusCaret.at, focusCaret.at);
      }
    }
  }, [focusRequest, focusCaret, focusYields, view, recording]);

  // The input grows upward, never over the Firstmate's frame.
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const measure = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Its growth, and the last turn's room above it, are published as
  // `--prompt-rise` on the document, never through the store, so a new line
  // never re-renders the stage: the Firstmate, the card and the card's
  // height cap read the variable. The growth alone is `--prompt-growth`,
  // which a rail ending above the input follows (design/styles.css).
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = document.documentElement;
    const publish = () => {
      const oneLine = Number.parseFloat(getComputedStyle(shell).minHeight) || 0;
      const growth = Math.max(0, shell.getBoundingClientRect().height - oneLine);
      root.style.setProperty("--prompt-growth", `${growth}px`);
      root.style.setProperty("--prompt-rise", `${growth + laneRise}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--prompt-growth");
      root.style.removeProperty("--prompt-rise");
    };
  }, [laneRise]);

  // What the input's foot stands on (./promptFoot): it comes down only as
  // far as the notices under it let it, including a long refusal, so none is
  // cut off, and never over a collapsed panel header it shares columns with
  // (`--prompt-floor`, design/styles.css): with no card up it stands on the
  // header, and while a card is up the header steps aside. A foot the
  // headers lift takes the composer's growth down with it, so its top stays
  // clear of the Firstmate's frame.
  const dockRef = useRef<HTMLDivElement>(null);
  const noticesRef = useRef<HTMLDivElement>(null);
  const footLift = usePromptFoot(dockRef, noticesRef);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <PromptRoom />
      <div
        ref={dockRef}
        data-prompt-dock=""
        data-voice-transcribing={transcribing ? "true" : "false"}
        // One of the window's parts F6 moves between (./regions.ts).
        data-window-region="main-message"
        style={{
          position: "absolute",
          left: "50%",
          // Pinned by its bottom: the input grows upward, and the notices
          // below hang in their own container, so neither moves its foot.
          // It is `--space-9` above the floor, less in a short window, and
          // clear of the collapsed panel headers under it.
          bottom: "var(--prompt-floor)",
          transform: "translateX(-50%)",
          width: PROMPT_WIDTH,
          pointerEvents: "auto",
        }}
      >
        <div
          data-last-turn-slot=""
          // The last turn rides just above the input's top edge, in its own
          // slot: a bubble appearing or changing never moves the input.
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "100%",
            pointerEvents: "none",
          }}
        >
          <LastTurn />
        </div>
        <VoiceInput
          mode={recording ? "recording" : "idle"}
          width="100%"
          value={inputText}
          disabled={held}
          // Only the gate dims the pill. Before the first read the input
          // takes nothing at full strength, so a ready launch never fades in.
          style={held && !gateOpen ? { opacity: 1 } : undefined}
          keybindHint={inputPlaceholder({ firstRun, voiceSupported, dictation, transcribing })}
          attachments={attachments}
          onAttach={attachImages}
          onPictureTooBig={() => showComposerNotice("picture-too-big")}
          onRemoveAttachment={removeAttachment}
          pastes={pastes}
          onPasteText={attachPastedText}
          onRemovePaste={removePaste}
          onCaretChange={setInputCaret}
          files={fileIntake}
          onRecall={recallLastSent}
          onChange={(e) => setInputText(e.target.value)}
          onKeystroke={keystroke}
          onAbandon={abandonRecording}
          onAccept={() => acceptRecording()}
          onSubmit={submit}
          inputRef={inputRef}
          shellRef={shellRef}
          maxHeight={promptShellMax(windowHeight) - laneRise - footLift}
        />
      </div>
      <div
        ref={noticesRef}
        data-prompt-notices=""
        style={{
          position: "absolute",
          left: "50%",
          // Hung 10px under the input's pinned bottom.
          top: "calc(100% - var(--prompt-floor))",
          paddingTop: 10,
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          pointerEvents: "auto",
        }}
      >
        <ComposerNotice width={PROMPT_WIDTH} />
        <VoiceNotice width={PROMPT_WIDTH} />
        <DiagnosticsNotice width={PROMPT_WIDTH} />
      </div>
    </div>
  );
});
