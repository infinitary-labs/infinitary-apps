import { anythingElseOf, type CardWidth, type PastCard } from "@shared/cards";
import { formatDateTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { pastCardEndingWords } from "@shared/pastCard";
import type { FramePicture } from "@shared/plugins/bridge";
import { wordedTitle } from "@shared/welcome";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, MicroLabel } from "../design";
import { CardCorner } from "../design/cards/CardSize";
import { ResponseCard } from "../design/cards/ResponseCard";
import { RiskChart, riskBodyInset, riskChartBox } from "../design/cards/RiskChart";
import { RISK_CHART_GAP } from "../design/cards/riskRadar";
import { useCutWords } from "../design/core/overflowTitle";
import { afterMergeStrip } from "./afterMergeStrip";
import { MessageList } from "./CardThread";
import { pastReadingPlaceId, useCardReadingPlace } from "./cardReadingPlace";
import { footerGroups } from "./footerGroups";
import { HtmlCardBody } from "./PrototypeBody";
import { KeyedText } from "./TaskKey";

/** A past card read once when its entry comes to the front; null while it loads. */
export type PastRead =
  | { state: "loading" }
  | { state: "unreadable" }
  | { state: "ready"; card: PastCard };

/** Reads one closed card as the captain last saw it. Pure read; nothing is written. */
export function usePastCard(cardId: string | undefined): PastRead | null {
  const [read, setRead] = useState<{ cardId: string; value: PastRead } | null>(null);
  useEffect(() => {
    if (!cardId) return;
    let live = true;
    window.infinitary.cards
      .past(cardId)
      .then((card) => {
        if (live)
          setRead({ cardId, value: card ? { state: "ready", card } : { state: "unreadable" } });
      })
      .catch(() => {
        if (live) setRead({ cardId, value: { state: "unreadable" } });
      });
    return () => {
      live = false;
    };
  }, [cardId]);
  if (!cardId) return null;
  return read?.cardId === cardId ? read.value : { state: "loading" };
}

const microText: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

/** The strip's time, absolute: "2 Oct, 18:14". */
export function pastTime(at: number): string {
  return formatDateTime(at, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const noop = () => {};
const noAction = () => Promise.resolve();

/**
 * The card column of a past card (design skill, "Past card"): the PAST strip,
 * the title, the version the captain last saw with its submitted answers
 * filled in and every control disabled, and the actions it offered, shown
 * but never clickable. Nothing here calls the card service, the effect
 * dispatcher or the task record: a past card has no way to write.
 */
export function PastCardColumn({
  past,
  theme,
  width,
  size,
  surface = true,
  onDrawn,
  onInteraction,
  onPicture,
}: {
  past: PastCard;
  theme: "dark" | "light";
  width: number | string;
  size: CardWidth;
  surface?: boolean;
  onDrawn?: () => void;
  onInteraction?: () => void;
  onPicture?: React.ComponentProps<typeof HtmlCardBody>["onPicture"];
}) {
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const taskId = past.taskId;
  useEffect(() => {
    setTaskKey(null);
    if (!taskId) return;
    let live = true;
    window.infinitary.tasks
      .detail(taskId)
      .then((detail) => {
        if (live) setTaskKey(detail.key);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId]);
  // Read once per entry: the form's draft is the saved answers, not the live store's.
  const form = useMemo(
    () => ({ fill: () => past.answers, onAnswers: noop, readOnly: true as const }),
    [past.answers],
  );
  const strip = [taskKey, pastCardEndingWords(past), pastTime(past.ending.at)]
    .filter(Boolean)
    .join(" · ");
  const endingCut = useCutWords(strip);
  // The risk chart the card showed, at the title's top right as it stood
  // (docs/card-authoring.md "The risk chart").
  const asideRef = useRef<HTMLDivElement>(null);
  const risk = past.risk;
  const sentWords = anythingElseOf(past.answers);
  const bodyRef = useCardReadingPlace(pastReadingPlaceId(past.id));
  // A card the app wrote itself is titled in the window's language (docs/i18n.md).
  const shownTitle = wordedTitle(past.title, past.body);
  return (
    <ResponseCard
      bodyRef={bodyRef}
      title={shownTitle}
      width={width}
      surface={surface}
      chrome={
        <>
          <div
            data-past-strip=""
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 10px 0 16px",
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <span
              data-past-mark=""
              style={{
                ...microText,
                color: "var(--accent)",
                textTransform: "uppercase",
                flexShrink: 0,
              }}
            >
              {m.cardPastMark()}
            </span>
            <span data-past-ending="" {...endingCut} style={{ ...microText, flex: 1 }}>
              {strip}
            </span>
            <CardCorner style={{ marginInlineStart: "auto" }} />
          </div>
          <div
            data-past-title=""
            style={{
              position: risk ? "relative" : undefined,
              padding: risk
                ? `8px calc(16px + ${riskChartBox().width}px + var(--space-4)) 0 16px`
                : "8px 16px 0",
              fontSize: "var(--text-lg)",
              fontWeight: 500,
              letterSpacing: "var(--tracking-display)",
              color: "var(--fg-1)",
              lineHeight: "var(--leading-tight)",
            }}
          >
            {risk ? (
              <span>
                <KeyedText text={shownTitle} />
              </span>
            ) : (
              <KeyedText text={shownTitle} />
            )}
            {risk && (
              <div
                ref={asideRef}
                data-card-aside=""
                style={{ position: "absolute", top: 8, insetInlineEnd: 16, zIndex: 1 }}
              >
                <RiskChart risk={risk} />
              </div>
            )}
          </div>
        </>
      }
      // What the card's field sent with the choice, as one quiet line under
      // the buttons (INF-924); nothing when it sent nothing.
      footer={
        sentWords !== undefined ? (
          <p
            data-past-card-words=""
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-body)",
              color: "var(--fg-3)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {m.cardPastSentLead()} {sentWords}
          </p>
        ) : undefined
      }
      actions={
        past.actions.length > 0
          ? footerGroups(past.actions).map((group) => (
              <div
                key={group.key}
                style={{ display: "flex", gap: "var(--space-2)", flexWrap: "nowrap", minWidth: 0 }}
              >
                {group.actions.map((action) => {
                  const chosen = past.ending.how === "chose" && past.ending.actionId === action.id;
                  return (
                    <Button
                      key={action.id}
                      variant="secondary"
                      disabled
                      data-past-action={action.id}
                      data-past-chosen={chosen ? "" : undefined}
                      style={{
                        minWidth: 0,
                        maxWidth: "100%",
                        flexShrink: 1,
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                        opacity: 1,
                        color: chosen ? "var(--fg-1)" : "var(--fg-3)",
                        borderColor: chosen ? "var(--accent)" : "var(--line-1)",
                      }}
                    >
                      {chosen ? `✓ ${action.label}` : action.label}
                    </Button>
                  );
                })}
              </div>
            ))
          : undefined
      }
    >
      <div data-past-card={past.id}>
        <HtmlCardBody
          body={past.body}
          lead={afterMergeStrip(past.requiredActions, past.afterMerge)}
          theme={theme}
          title={past.title}
          // Nothing a past body raises is declared, so the bridge refuses it.
          declaredActionIds={[]}
          width={size}
          {...(risk
            ? { inset: { from: asideRef, until: riskBodyInset(), gap: RISK_CHART_GAP } }
            : {})}
          onAction={noAction}
          onPicture={
            onPicture as
              | ((
                  set: { index: number; pictures: FramePicture[] },
                  opener: HTMLIFrameElement | null,
                ) => void)
              | undefined
          }
          form={form}
          onDrawn={onDrawn}
          onInteraction={onInteraction}
        />
      </div>
    </ResponseCard>
  );
}

/**
 * The past card's thread beside it: its own micro-label head and the
 * messages, with no reply row and no close (design skill, "Past card").
 */
export function PastThreadColumn({ past, width }: { past: PastCard; width: number }) {
  return (
    <div
      data-card-thread={past.id}
      data-past-thread=""
      style={{
        boxSizing: "border-box",
        width,
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderInlineStart: "1px solid var(--line-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          minHeight: 28,
          padding: "14px 8px 8px 16px",
        }}
      >
        <MicroLabel>{m.cardThreadLabel()}</MicroLabel>
      </div>
      <MessageList messages={past.messages} />
    </div>
  );
}

/** A past card that could not be read, with Hide: the entry never traps the stage. */
export function PastCardUnreadable({
  width,
  loading,
  onDrawn,
}: {
  width: number | string;
  loading: boolean;
  /** The read settled as unreadable: this line is the entry's whole drawing. */
  onDrawn?: () => void;
}) {
  useLayoutEffect(() => {
    if (!loading) onDrawn?.();
  }, [loading, onDrawn]);
  return (
    <ResponseCard
      title={loading ? "" : m.cardPastUnreadable()}
      meta={m.cardPastMeta()}
      width={width}
      minHeight={120}
    >
      <div aria-busy={loading || undefined} style={{ minHeight: "var(--space-7)" }} />
    </ResponseCard>
  );
}
