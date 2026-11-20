import { type Card, cardPresentation } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import type { Theme } from "@shared/preferences";
import { useEffect, useMemo, useRef } from "react";
import { dockedRequestShown } from "../../cards/browserRequest";
import { CardThread, openIcon, ReplyRow, ThreadCue } from "../../cards/CardThread";
import type { CollectAnswers } from "../../cards/PrototypeBody";
import { useSeenReport } from "../../cards/useSeenReport";
import { useCardKind } from "../../plugins/host";
import { useCommandKeys } from "../keyHints";
import { useShellStore } from "../store";
import { StackedCard, type StackedCardProps } from "./StackedCard";

/** Back to the card: a plain link in the accent, as the view's own links are. */
const BACK_LINK: React.CSSProperties = {
  display: "block",
  flex: "none",
  alignSelf: "flex-start",
  margin: "var(--space-2) var(--space-4) var(--space-3)",
  padding: 0,
  border: 0,
  background: "none",
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--accent)",
  cursor: "pointer",
};

/**
 * The card docked beside its browser's page (docs/task-browser.md,
 * "The request beside the page" and "A card beside the page"; the design
 * skill's TaskBrowser): the crewmate's own card on top - its words, steps
 * and values to copy - its thread under it once anyone has written there,
 * and the card's one field at the foot, so the captain reads what to do and
 * asks about it beside the page. The card's choices stay off the column. A
 * request's page is its door and Return control its closing choice, which
 * carries whatever the field still holds; any other card's choices wait on
 * the card itself, behind Back to the card (`back`).
 */
export function BrowserRequestColumn({
  card,
  theme,
  working,
  back = false,
  onAction,
  onPicture,
  onFold,
}: {
  card: Card;
  theme: Theme;
  working: boolean;
  /** Whether the column offers Back to the card, where the card's choices are. */
  back?: boolean;
  onAction: StackedCardProps["onAction"];
  onPicture: StackedCardProps["onPicture"];
  /** Folds the column to its latest line under the page; `byKey` when a key pressed it. */
  onFold: (byKey: boolean) => void;
}) {
  // Drawn beside the page is seen, as the stage's own card is.
  useSeenReport(card, true);
  const kind = useCardKind(cardPresentation(card));
  const shown = useMemo(() => dockedRequestShown(card), [card]);
  const collectRef = useRef<CollectAnswers | null>(null);
  const collect: CollectAnswers = (focusUnpicked) =>
    collectRef.current?.(focusUnpicked) ??
    Promise.resolve(useShellStore.getState().cardAnswers[card.id]);
  const loadThread = useShellStore((s) => s.loadThread);
  // An empty thread draws nothing: the card keeps the room until a word is sent.
  const talked = useShellStore((s) => (s.threads[card.id]?.length ?? 0) > 0);
  useEffect(() => loadThread(card.id), [loadThread, card.id]);
  return (
    <div
      data-browser-request-column={card.id}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          // Once anyone has written, the conversation takes the larger share
          // and the card scrolls in the rest.
          flex: talked ? "0 1 auto" : "1 1 auto",
          maxHeight: talked ? "40%" : undefined,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          ...(talked ? {} : { borderBlockEnd: "1px solid var(--line-2)" }),
        }}
      >
        <div style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto" }}>
          <StackedCard
            card={shown}
            chrome={kind.chrome}
            theme={theme}
            size="regular"
            corner={false}
            // Its natural height: the column's part above scrolls it whole,
            // head and all, rather than squeezing the card's own middle.
            style={{ flex: "none", height: "auto", maxHeight: "none", overflowY: "visible" }}
            collectRef={collectRef}
            collect={collect}
            onAction={onAction}
            onPicture={onPicture}
          />
        </div>
        {/* Under the card's scroll, so the way to its choices stays in sight. */}
        {back && (
          <button
            type="button"
            style={BACK_LINK}
            data-browser-card-back={card.id}
            onClick={() => useShellStore.getState().focusCard(card.id)}
          >
            {m.cardBrowserBackToCard()}
          </button>
        )}
      </div>
      {/* Its head carries the fold, ⌘\, before anyone has written too. */}
      <CardThread
        cardId={card.id}
        card={card}
        working={working}
        onCollapse={onFold}
        style={{
          flex: talked ? "1 1 0" : "none",
          minHeight: talked ? 96 : undefined,
          borderInlineStart: "none",
          borderBlockStart: talked ? "1px solid var(--line-2)" : "none",
        }}
      />
      <ReplyRow cardId={card.id} inThread collect={collect} />
    </div>
  );
}

/**
 * The docked request folded to its latest line under the page, where a
 * narrow window or the captain's ⌘\ put it (docs/task-browser.md, "The
 * request beside the page"): a collapsed thread's latest line - or, before
 * anyone has written, the request's title - and nothing else, so the page
 * keeps its height. The line opens the column again, its field with it.
 */
export function BrowserRequestLine({
  card,
  working,
  onOpen,
}: {
  card: Card;
  working: boolean;
  /** Opens the column beside the page; `byKey` when a key pressed the line. */
  onOpen: (byKey: boolean) => void;
}) {
  const talked = useShellStore(
    (s) => (s.threads[card.id]?.length ?? 0) + (s.replyNotes[card.id]?.length ?? 0) > 0,
  );
  const keys = useCommandKeys("cards.thread");
  const loadThread = useShellStore((s) => s.loadThread);
  useEffect(() => loadThread(card.id), [loadThread, card.id]);
  return (
    <div
      data-browser-request={card.id}
      data-browser-request-folded=""
      style={{ display: "flex", flexDirection: "column", padding: "6px 12px" }}
    >
      {talked ? (
        <ThreadCue cardId={card.id} card={card} working={working} onOpen={onOpen} />
      ) : (
        <button
          type="button"
          data-thread-cue={card.id}
          aria-keyshortcuts={keys["aria-keyshortcuts"]}
          onClick={(event) => onOpen(event.detail === 0)}
        >
          <span data-thread-cue-who="" />
          <span data-thread-cue-said="">{card.title}</span>
          <span data-thread-cue-state="" />
          {openIcon}
        </button>
      )}
    </div>
  );
}
