import { cardCornerOf } from "@shared/cardLeave";
import { placeKey } from "@shared/cardNotes";
import { isDrawingSource, withDrawingFaces } from "@shared/cardPictures";
import { cardTakesReplies } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import type { FramePicture } from "@shared/plugins/bridge";
import type { DefaultCardSize } from "@shared/preferences";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PictureMark } from "../../cards/annotationBridge";
import { CardFindField } from "../../cards/CardFindField";
import { CardPictureViewer } from "../../cards/CardPictureViewer";
import { closeCardFind, openCardFind, useCardFind, useCardFindStage } from "../../cards/cardFind";
import { CARD_DRAG_MIN, CARD_SIZES, cardPlacement, shownCardSize } from "../../cards/cardGeometry";
import {
  holdReadingAnchor,
  isMaximized,
  type MaximizedAt,
  type ReadingAnchor,
  readingAnchor,
} from "../../cards/cardMaximize";
import { useCardPresentation } from "../../cards/cardPresentation";
import { ExpandedPart } from "../../cards/ExpandedPart";
import { ExpandPartContext } from "../../cards/expandPart";
import { usePastCard } from "../../cards/PastCard";
import type { ExpandRequest } from "../../cards/PrototypeBody";
import { setDemoSounding, stopAnyCardSound } from "../../cards/playingSound";
import { StageEntry } from "../../cards/SurfaceReveal";
import {
  markStage,
  type PreparedDrawing,
  type PrepareFacts,
  stageOutcome,
} from "../../cards/stageMarks";
import {
  type PageStep,
  playIncoming,
  playStageMove,
  type StageMove,
  stageMove,
} from "../../cards/stageMoves";
import {
  emptySlots,
  expireSlot,
  retireSlot,
  revealSlot,
  selectSlots,
  slotRoles,
} from "../../cards/stageSlots";
import { cardWidth, THREAD_CARD_MAX, THREAD_STAGE_MARGIN } from "../../cards/threadGeometry";
import { useSeenReport } from "../../cards/useSeenReport";
import { CardStack } from "../../design";
import { type CardFind, CardFindContext } from "../../design/cards/CardFind";
import { type CardSize, CardSizeContext } from "../../design/cards/CardSize";
import { CardPeeks } from "../../design/cards/CardStack";
import { cardFace } from "../../design/cards/drawingFaces";
import { LogReader, type ViewerLog } from "../../design/cards/LogReader";
import type { ViewerDemo } from "../../design/cards/PictureViewer";
import { CARD_MAX_HEIGHT } from "../../design/cards/ResponseCard";
import { focusWithRing } from "../../design/focus";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
} from "../../plugins/frames/frameController";
import { giveFocusBack } from "../../plugins/frames/frameFocus";
import { type CardStage, lendCardStage } from "../cardStage";
import { dictationKeyTakenByPointer } from "../dictationKey";
import { useCommandKeys } from "../keyHints";
import { oncePressesHeard, pressesSoFar } from "../presses";
import { firstTabbable, lastTabbable } from "../regions";
import { foldRails, useShellLayout } from "../shellLayout";
import {
  cardFindable,
  dismissalSuccessor,
  isHeldEntry,
  newCardIndex,
  pagedIndex,
  type StackEntry,
  stackOf,
  unreadAround,
} from "../stack";
import { useShellStore } from "../store";
import { TOP_BAR_HEIGHT } from "../TopBar";
import { CardEdges, FocusEdge, FoldedRailTabs } from "./CardEdges";
import { EntrySurface } from "./EntrySurface";
import {
  drawnBody,
  type EntryView,
  entryView,
  STAGE_LIFT_EASE,
  STAGE_TOP,
  unpreparable,
  type ViewFacts,
} from "./entryView";
import { entryWorking } from "./entryWorking";
import type { StackedCardProps } from "./StackedCard";

/** Same symmetric clearance as the script, applied in the resize's layout. */
const STAGE_CEILING = `calc(100vw - 2 * max(var(--occupied-rail-left, 0px), var(--occupied-rail-right, 0px)) - ${THREAD_STAGE_MARGIN}px)`;

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
 * it is; then one move (../../cards/stageMoves: a slide for the arrows, a drop
 * for a close, else a crossfade) and one height easing. When the stack
 * empties, the last drawing drops away before the layer goes (`onEmptied`).
 */
export function CardLayer({ onEmptied }: { onEmptied: () => void }) {
  const prevKeys = useCommandKeys("cards.previous");
  const nextKeys = useCommandKeys("cards.next");
  const newKeys = useCommandKeys("cards.next-new");
  const maximizeKeys = useCommandKeys("cards.maximize");
  const minimizeKeys = useCommandKeys("cards.minimize");
  const minimizeAllKeys = useCommandKeys("cards.minimize-all");
  const findKeys = useCommandKeys("cards.find");
  const finding = useCardFind((s) => s.open);
  const putEveryCardAside = useShellStore((s) => s.putEveryCardAside);
  const cards = useShellStore((s) => s.cards);
  const replyNotes = useShellStore((s) => s.replyNotes);
  const entrancesReady = useShellStore((s) => s.cardsSnapshotLoaded);
  const bootCardId = useShellStore((s) => s.bootCardId);
  const cardIndex = useShellStore((s) => s.cardIndex);
  const unreadCardIds = useShellStore((s) => s.unreadCardIds);
  const heldBackCardIds = useShellStore((s) => s.heldBackCardIds);
  const theme = useShellStore((s) => s.theme);
  const actOnCard = useShellStore((s) => s.actOnCard);
  const closeCard = useShellStore((s) => s.closeCard);
  const prevCard = useShellStore((s) => s.prevCard);
  const nextCard = useShellStore((s) => s.nextCard);
  const showNewCard = useShellStore((s) => s.showNewCard);
  const threads = useShellStore((s) => s.threads);
  const threadsLoaded = useShellStore((s) => s.threadsLoaded);
  const closedThreadIds = useShellStore((s) => s.closedThreadIds);
  const crewActivity = useShellStore((s) => s.crewActivity);
  const firstmateBusy = useShellStore((s) => s.firstmateBusy);
  const loadThread = useShellStore((s) => s.loadThread);
  const closeThread = useShellStore((s) => s.closeThread);
  const openThread = useShellStore((s) => s.openThread);
  const requestColumns = useShellStore((s) => s.requestColumns);
  const setRequestColumn = useShellStore((s) => s.setRequestColumn);
  const cardDrags = useShellStore((s) => s.cardDrags);
  const defaultCardSize = useShellStore((s) => s.defaultCardSize);
  const keepCardsMaximized = useShellStore((s) => s.keepCardsMaximized);
  const cardsMaximized = useShellStore((s) => s.cardsMaximized);
  const setCardsMaximized = useShellStore((s) => s.setCardsMaximized);
  // Maximized as the default, or the last size change maximized a card
  // while Keep cards maximized is on: every entry comes forward maximized.
  const opensMaximized = defaultCardSize === "maximized" || (keepCardsMaximized && cardsMaximized);
  const dragCard = useShellStore((s) => s.dragCard);
  // The picture viewer (card pictures, phase 3) belongs to the card that
  // opened it: renderer-only, and gone with that card from the stage.
  const [viewer, setViewer] = useState<OpenPictures | null>(null);
  // A part of the shown card's body full screen (docs/card-authoring.md, "A part full screen").
  const [expanded, setExpanded] = useState<OpenPart | null>(null);

  const records = useShellStore((s) => s.records);
  const closeRecord = useShellStore((s) => s.closeRecord);
  const shown = stackOf({ cards, heldBackCardIds, records });
  const index = Math.min(cardIndex, shown.length - 1);
  const card = shown[index];
  // Arrow dots locate other unread cards; the badge also keeps a shown
  // shared update new until its drawn sighting reaches the owner (INF-2022).
  const unread = unreadAround(shown, index, unreadCardIds);
  // How the pager's last move went, for the page number's slide; it counts
  // only for the entry that move brought up.
  const turned = useRef<{ to: string; dir: 1 | -1 | 0 } | null>(null);
  // A past card (FI3-579) is read once when its entry comes to the front.
  const pastRead = usePastCard(card?.pastCardId);
  // The shown card's thread is read once, here, and so is the prepared
  // successor's (below): its history decides the width it is drawn at.
  const replyable = card !== undefined && !isHeldEntry(card) && cardTakesReplies(card);
  const cardId = card?.id;
  // The version on screen is the one the captain has seen, while the window
  // is in front of them; the card's next revision is compared with it.
  useEffect(() => {
    if (replyable && cardId) loadThread(cardId);
  }, [replyable, cardId, loadThread]);

  // Each newly shown entry starts from the saved size. Manual restore and
  // Go to the main message override it for this visit, never the next card,
  // unless Keep cards maximized carries the maximize or restore to every card.
  const mainFocusRequest = useShellStore((s) => s.focusRequest);
  const cardFocusRequest = useShellStore((s) => s.cardFocusRequest);
  const cardFocusTarget = useShellStore((s) => s.cardFocusTarget);
  const focusRequest = mainFocusRequest + cardFocusRequest;
  const openingSize = {
    cardId,
    defaultCardSize,
    opensMaximized,
    at: cardId && opensMaximized ? { entryId: cardId, focusRequest } : null,
  };
  const [sizeChoice, setSizeChoice] = useState<{
    cardId: string | undefined;
    defaultCardSize: DefaultCardSize;
    opensMaximized: boolean;
    at: MaximizedAt | null;
  }>(openingSize);
  // Reset before the new entry paints, rather than flashing its usual size.
  if (
    sizeChoice.cardId !== cardId ||
    sizeChoice.defaultCardSize !== defaultCardSize ||
    sizeChoice.opensMaximized !== opensMaximized
  ) {
    setSizeChoice(openingSize);
  }
  const maximized = isMaximized(sizeChoice.at, cardId, focusRequest);

  const layout = useShellLayout();
  const facts: ViewFacts = {
    layout,
    threads,
    replyNotes,
    closedThreadIds,
    cardDrags,
    defaultCardSize,
    cards,
    requestColumns,
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
      ? entryView(candidate, undefined, facts, opensMaximized)
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
  // A selection the pager did not make lets the pager's last move go.
  if (turned.current && turned.current.to !== selection) turned.current = null;
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
  // A beside thread leaves the same body document drawn at the same column width.
  // Only an in-place thread changes its home; body, theme and width still require their own drawing.
  // The body is the one its frame draws, less the host's fact strip (`drawnBody`).
  // The card width comes last, so `drawnDocument` reads the rest.
  const drawKey = (entry: StackEntry, at: EntryView) =>
    `${theme}:${at.past?.state === "ready" ? at.past.card.body : drawnBody(entry)}:${at.home === "in-place" ? "in-place" : "body"}:${at.card}`;
  const drawingOf = (slot: string, key: string): PreparedDrawing => {
    if (failedSlots.current.has(slot)) return "failed";
    const at = [drawn.current.get(slot), held.current.get(slot)];
    if (at.includes(key)) return "current";
    return at.some((seen) => seen !== undefined) ? "stale" : "none";
  };
  // One outcome for each selection that replaces a shown card, against what
  // the stage had prepared just before it (../../cards/stageMarks).
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
  useSeenReport(isHeldEntry(card) ? undefined : card, shownReady && stage.revealed);
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
  const expanding = expanded !== null && expanded.cardId === cardId ? expanded : null;
  useEffect(() => {
    if (expanded && expanded.cardId !== cardId) setExpanded(null);
  }, [expanded, cardId]);

  // The arrows and the close, lent to the window's card commands (../cardStage).
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
    // Every card follows this one from now on, until the next maximize or restore.
    if (keepCardsMaximized) setCardsMaximized(!maximized);
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
  // The shown entry's one way aside, for its corner and for the commands:
  // a held view closes, and a card is put aside as it is mounted.
  const putAside = () => {
    if (!card) return;
    if (isHeldEntry(card)) closeRecord();
    else closeCard(card.id, card);
  };
  const cardSize: CardSize | null = cardId
    ? {
        maximized,
        corner: isHeldEntry(card)
          ? cardCornerOf(card.recordTaskId ? "record" : "window-panel")
          : (card.corner ?? cardCornerOf("decision")),
        toggle: toggleSize,
        ...maximizeKeys,
        minimize: { run: putAside, ...minimizeKeys },
        minimizeAll: {
          // A click with right ⌥ held is not dictation (INF-4002).
          run: () => {
            dictationKeyTakenByPointer();
            putEveryCardAside();
          },
          ...minimizeAllKeys,
        },
      }
    : null;

  // Finding words in the shown entry (docs/keyboard.md, "Finding in the
  // shown card"): a card, a past card or a task's record or Crewmate tab;
  // never a panel's card, the reply note or a task's browser.
  const findable = card !== undefined && cardFindable(card);
  const cardFind: CardFind | null = findable
    ? { open: finding, start: () => openCardFind(true), field: <CardFindField />, ...findKeys }
    : null;
  useCardFindStage(cardId && findable ? `${cardId}:${card?.recordView ?? ""}` : undefined);
  // The field closes when the stage shows something it cannot find in.
  useEffect(() => {
    if (!findable) closeCardFind();
  }, [findable]);

  // The drawing a stack that just emptied is still dropping away, if any.
  const exit = card ? undefined : stage.outgoing?.view;
  const layerCard = card ?? exit?.entry;
  const layerView = view ?? exit?.view;
  lentStage.current = null;
  if (!layerCard || !layerView) return null;

  const onCardAction: StackedCardProps["onAction"] = (
    actionId,
    source,
    value,
    collect,
    mounted,
    input,
  ) =>
    cardId
      ? actOnCard(cardId, actionId, source, value, collect, mounted, input)
      : Promise.resolve();

  // A held record or past card reads its title rather than carrying it on the stack entry.
  const shownTitle = (recordTitle?: string) =>
    card?.recordTaskId
      ? (recordTitle ?? m.shellCardTaskRecord())
      : pastRead?.state === "ready"
        ? pastRead.card.title
        : card?.title;
  const openPart = (open: ExpandRequest, opener: HTMLIFrameElement | null) => {
    if (!card || !cardId) return;
    setExpanded({ cardId, title: shownTitle() ?? "", ...open, opener });
  };
  const openPictures = (
    {
      cardId: noteCardId,
      ...set
    }: {
      index: number;
      pictures: FramePicture[];
      demo?: ViewerDemo;
      log?: ViewerLog;
      cardId?: string | undefined;
      mark?: PictureMark | undefined;
    },
    opener: HTMLIFrameElement | null,
    recordTitle?: string,
  ) => {
    const title = shownTitle(recordTitle);
    if (!card || !cardId) return;
    if (!set.pictures.some((picture) => isDrawingSource(picture.src))) {
      setViewer({ cardId, title: title ?? "", ...set, noteCardId, opener });
      return;
    }
    // A diagram takes the card's typefaces inside it before it opens (INF-3107).
    void Promise.all(
      set.pictures.map(async (picture) => ({
        ...picture,
        src: await withDrawingFaces(picture.src, cardFace),
      })),
    ).then((pictures) =>
      setViewer({ cardId, title: title ?? "", ...set, pictures, noteCardId, opener }),
    );
  };
  // Paging remembers which way the arrow went, for the slide (../../cards/stageMoves),
  // and the page number slides the same way, going round included (INF-4541).
  const page = (dir: 1 | -1) => {
    if (cardId) paged.current = { from: cardId, dir };
    const to = shown[pagedIndex(index, shown.length, dir)]?.id;
    turned.current = to ? { to, dir } : null;
    if (dir === 1) nextCard();
    else prevCard();
  };
  // "N new" is a jump: the stage crossfades and the number changes at once.
  const showNew = () => {
    const to = newCardIndex(shown, index, unreadCardIds, useShellStore.getState().newShownIds);
    const entry = shown[to];
    if (!entry) return;
    turned.current = { to: entry.id, dir: 0 };
    showNewCard();
  };
  // The thread collapses into the card's foot or opens beside it again. A
  // reply field that has focus keeps it; otherwise focus goes to what
  // undoes the move: the latest line, or the thread's collapse.
  const showThread = (open: boolean, byKey: boolean) => {
    if (!cardId) return;
    // A browser view's docked request opens beside its page or folds to its
    // latest line under it (docs/task-browser.md, "The request beside the
    // page"). Its field folds away with the column, so focus goes to what
    // undoes the move, unless the page holds the keyboard, which it keeps.
    const request = view?.request;
    const focused = document.activeElement;
    const browserColumn = request || view?.crewColumn;
    const typing = browserColumn
      ? focused instanceof HTMLElement && focused.closest("[data-browser-page]") !== null
      : focused instanceof HTMLTextAreaElement &&
        focused.closest(`[data-card-reply="${CSS.escape(cardId)}"]`) !== null;
    threadFocus.current = typing ? null : { cardId, to: open ? "collapse" : "cue", byKey };
    if (browserColumn) setRequestColumn(request?.cardId ?? cardId, open ? "open" : "folded");
    else if (open) openThread(cardId);
    else closeThread(cardId);
  };
  const foldsThread =
    view?.request !== undefined ||
    view?.crewColumn === true ||
    (view?.replyable === true && (view.collapsed || view.home === "beside"));
  lentStage.current =
    card && cardId
      ? {
          shownId: cardId,
          page,
          showNew,
          close: putAside,
          maximized,
          toggleSize: () => toggleSize(true),
          minimize: putAside,
          ...(foldsThread ? { thread: () => showThread(view.collapsed, true) } : {}),
        }
      : null;
  const working = (entry: StackEntry) => entryWorking(entry, firstmateBusy, crewActivity);

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
          unreadCurrent={card !== undefined && unreadCardIds.includes(card.id)}
          width="100%"
          envelopeHeight={CARD_MAX_HEIGHT}
          onPrev={() => page(-1)}
          onNext={() => page(1)}
          onNew={showNew}
          turn={turned.current && turned.current.to === cardId ? turned.current.dir : undefined}
          prevKeys={prevKeys}
          nextKeys={nextKeys}
          newKeys={newKeys}
        >
          <div
            ref={shellRef}
            data-card-presentation=""
            data-card-revealed={stage.revealed ? "" : undefined}
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
                  {/* The decoration is part of this drawing, not the pager's
                      envelope. A pending body and a departing card carry their
                      peeks through exactly the same opacity and lifetime. */}
                  <CardPeeks
                    count={shown.length}
                    style={maximized ? { display: "none" } : undefined}
                  />
                  {/* Always provided, so a prepared entry promoted in place keeps its tree. */}
                  <CardSizeContext.Provider value={isShown ? cardSize : null}>
                    <CardFindContext.Provider value={isShown ? cardFind : null}>
                      {/* Offered to every entry, so a prepared entry promoted in place
                      offers full screen from birth; only a shown card opens it. */}
                      <ExpandPartContext.Provider value={isShown ? openPart : noop}>
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
                          onClose={isShown ? closeRecord : noop}
                          onAction={isShown ? onCardAction : noAction}
                          onPicture={isShown ? openPictures : undefined}
                          onThread={isShown ? showThread : undefined}
                          working={working(entry)}
                        />
                      </ExpandPartContext.Provider>
                    </CardFindContext.Provider>
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
      {viewing?.log && (
        <LogReader
          title={viewing.title}
          log={viewing.log}
          onClose={() => {
            setViewer(null);
            // Back to the log's line inside the frame that opened it.
            giveFocusBack(viewing.opener);
          }}
        />
      )}
      {expanding && (
        <ExpandedPart
          title={expanding.title}
          body={expanding.body}
          index={expanding.index}
          state={expanding.state}
          theme={theme}
          onClose={(state) => {
            setExpanded(null);
            // The part in the card goes where the copy was, and focus back to it.
            expanding.handBack(state);
            giveFocusBack(expanding.opener);
          }}
        />
      )}
      {viewing && !viewing.log && (
        <CardPictureViewer
          // A note's mark opens the viewer again at its own picture.
          key={viewing.mark ? `${viewing.index}-${placeKey(viewing.mark.note.place)}` : "pictures"}
          title={viewing.title}
          pictures={viewing.pictures}
          index={viewing.index}
          demo={viewing.demo}
          noteCardId={viewing.noteCardId}
          lit={viewing.mark}
          onSound={stopAnyCardSound}
          onSounding={setDemoSounding}
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

/** A part open full screen: the card it came from, the part's request, and the frame to return focus to. */
type OpenPart = ExpandRequest & { cardId: string; title: string; opener: HTMLIFrameElement | null };

/** An open picture viewer: the card it came from, its set, and the frame to return focus to. */
type OpenPictures = {
  cardId: string;
  title: string;
  index: number;
  pictures: FramePicture[];
  /** A demo the viewer plays over its poster, the set's one picture. */
  demo?: ViewerDemo;
  /** A proof log, read in the log reader instead of the viewer; the set has no pictures. */
  log?: ViewerLog;
  /** The card whose body the pictures are in, where a place marked in one joins its notes. */
  noteCardId?: string | undefined;
  /** The note whose mark the viewer opened at. */
  mark?: PictureMark | undefined;
  opener: HTMLIFrameElement | null;
};
