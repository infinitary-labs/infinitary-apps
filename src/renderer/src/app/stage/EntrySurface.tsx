import { cardPresentation } from "@shared/cards";
import type { Theme } from "@shared/preferences";
import { type CSSProperties, useCallback, useRef, useState } from "react";
import { dockedCardOf } from "../../cards/browserRequest";
import { CardThread, ReplyRow, ThreadCue } from "../../cards/CardThread";
import { CrewmateView } from "../../cards/CrewmateView";
import { shownCardSize } from "../../cards/cardGeometry";
import { PanelCardView } from "../../cards/PanelCardView";
import { PastCardColumn, PastCardUnreadable, PastThreadColumn } from "../../cards/PastCard";
import type { CollectAnswers } from "../../cards/PrototypeBody";
import { RecordCard } from "../../cards/RecordCard";
import { RevisionNavigation } from "../../cards/RevisionNavigation";
import type { StageRole } from "../../cards/SurfaceReveal";
import { TaskBrowserView } from "../../cards/TaskBrowserView";
import { CARD_MAX_HEIGHT, cardFloor } from "../../design/cards/ResponseCard";
import { useCardKind } from "../../plugins/host";
import { ReplyNoteCard } from "../ReplyNote";
import type { StackEntry } from "../stack";
import { useShellStore } from "../store";
import { BrowserRequestColumn, BrowserRequestLine } from "./BrowserRequestColumn";
import type { EntryView } from "./entryView";
import { StackedCard, type StackedCardProps } from "./StackedCard";

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
export function EntrySurface({
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
  // Where the card's choices go while its thread is open: under the field at
  // the thread's foot, so a choice plainly carries the field's words.
  const [choicesSlot, setChoicesSlot] = useState<HTMLDivElement | null>(null);
  // The card docked beside a browser view's page: the request it was opened
  // from, a card the task raised while it showed, or the card whose own
  // browser button opened it.
  const docked = {
    card: useShellStore((s) => dockedCardOf(s.cards, entry)?.card),
    request: useShellStore((s) => dockedCardOf(s.cards, entry)?.request ?? false),
  };

  if (entry.pastCardId) {
    const past = view.past?.state === "ready" ? view.past.card : undefined;
    if (!past) {
      return (
        <PastCardUnreadable
          width="100%"
          loading={view.past?.state !== "unreadable"}
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
        onDrawn={drew}
        onInteraction={onInteraction}
        onPicture={onPicture}
      />
    );
  }
  if (entry.replyNote) {
    return <ReplyNoteCard note={entry.replyNote} width="100%" onDrawn={drew} />;
  }
  if (entry.recordTaskId) {
    return (
      <RecordCard
        taskId={entry.recordTaskId}
        view={entry.recordView ?? "info"}
        theme={theme}
        onDrawn={drew}
        onPicture={onPicture}
      />
    );
  }
  if (entry.panelCard) {
    return <PanelCardView card={entry.panelCard} theme={theme} onClose={onClose} onDrawn={drew} />;
  }
  if (entry.crewmateTaskId) {
    return <CrewmateView taskId={entry.crewmateTaskId} onDrawn={drew} />;
  }
  if (entry.browserTaskId) {
    return (
      <TaskBrowserView
        taskId={entry.browserTaskId}
        from={entry.browserFrom}
        onDrawn={drew}
        crew={
          view.crewColumn
            ? {
                open: !view.collapsed,
                width: view.thread,
                onToggle: (open, byKey) => onThread?.(open, byKey),
              }
            : undefined
        }
        request={
          docked.card
            ? {
                cardId: docked.card.id,
                ...(docked.request && docked.card.attachment?.kind === "browser"
                  ? {
                      handoff: {
                        session: docked.card.attachment.session,
                        generation: docked.card.attachment.generation,
                      },
                    }
                  : {}),
                // The stage's placement: open beside the page at the thread
                // column's width, or folded to its latest line under it.
                open: view.request?.open ?? true,
                width: view.thread,
                onOpen: () => onThread?.(true, false),
                column: (
                  <BrowserRequestColumn
                    card={docked.card}
                    theme={theme}
                    working={working}
                    back={!docked.request}
                    onAction={onAction}
                    onPicture={onPicture}
                    onFold={(byKey) => onThread?.(false, byKey)}
                  />
                ),
                line: (
                  <BrowserRequestLine
                    card={docked.card}
                    working={working}
                    onOpen={(byKey) => onThread?.(true, byKey)}
                  />
                ),
              }
            : undefined
        }
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
  const collect: CollectAnswers = (focusUnpicked) =>
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
                collect={collect}
              />
            ) : undefined
          }
          collectRef={collectRef}
          collect={collect}
          size={shownCardSize(view.card)}
          onAction={onAction}
          onPicture={onPicture}
          onDrawn={drew}
          onHeld={drewHeld}
          onBorn={born}
          onInteraction={onInteraction}
          inPlaceThread={inPlace}
          threadWorking={working}
          choicesIn={replyable && beside ? choicesSlot : null}
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
              borderInlineStart: "1px solid var(--line-2)",
            }}
          >
            <ReplyRow cardId={id} inThread collect={collect} />
            <div data-card-choices-slot="" ref={setChoicesSlot} />
          </div>
        )}
      </CardSurface>
    </RevisionNavigation>
  );
}
