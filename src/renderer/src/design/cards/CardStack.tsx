import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../core/Badge";
import { IconButton } from "../core/IconButton";
import { motionEase, motionToken } from "../motion";

const csIcoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The stack's design width; the stage narrows it on a narrow window. */
export const CARD_STACK_WIDTH = 800;

/** How far each peek stands above and inside the one in front of it, px. */
export const CARD_PEEK_STEP = 7;

/** The unread dot on an arrow that leads to an unseen card (design skill CardStack). */
const unreadDot: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 6,
  width: 6,
  height: 6,
  borderRadius: "var(--radius-pill)",
  background: "var(--accent)",
  boxShadow: "0 0 0 2px var(--bg-0)",
  pointerEvents: "none",
};

export type CardStackProps = {
  index?: number;
  count?: number;
  /** Unseen cards before the shown one: a dot on "Previous card". */
  unreadBefore?: number;
  /** Unseen cards after the shown one: a dot on "Next card". */
  unreadAfter?: number;
  /** The shown update is still unseen until the owner confirms its drawn reading. */
  unreadCurrent?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** The arrows' key hints: the keys that page the same way from anywhere in the window. */
  prevKeys?: { keys?: string | undefined; "aria-keyshortcuts"?: string | undefined };
  nextKeys?: { keys?: string | undefined; "aria-keyshortcuts"?: string | undefined };
  width?: number | string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /** Stage-only maximum envelope; the pager never follows measured shell height. */
  envelopeHeight?: string;
};

export function CardStack({
  index = 0,
  count = 1,
  unreadBefore = 0,
  unreadAfter = 0,
  unreadCurrent = false,
  onPrev,
  onNext,
  prevKeys,
  nextKeys,
  width = CARD_STACK_WIDTH,
  children,
  style,
  envelopeHeight,
}: CardStackProps) {
  const unread = unreadBefore + unreadAfter + Number(unreadCurrent);
  return (
    <div
      data-card-envelope={envelopeHeight ? "" : undefined}
      style={{ position: "relative", width, height: envelopeHeight, ...style }}
    >
      <div
        data-card-slot=""
        style={{
          position: envelopeHeight ? "absolute" : "relative",
          width: "100%",
          top: envelopeHeight ? "50%" : undefined,
          transform: envelopeHeight ? "translateY(-50%)" : undefined,
        }}
      >
        <div style={{ position: "relative" }}>{children}</div>
      </div>
      {count > 1 && (
        <div
          data-card-pager=""
          data-pager-position={index + 1}
          data-pager-count={count}
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 10,
            position: envelopeHeight ? "absolute" : undefined,
            top: envelopeHeight ? "100%" : undefined,
            width: "100%",
          }}
        >
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <IconButton
                label={m.uiCardStackPrevious()}
                size={28}
                onClick={onPrev}
                disabled={index <= 0}
                {...prevKeys}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" {...csIcoS} aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </IconButton>
              {unreadBefore > 0 && <span data-unread-dot="before" style={unreadDot} />}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              <PagerNumber value={index + 1} count={count} /> / {count}
            </span>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <IconButton
                label={m.uiCardStackNext()}
                size={28}
                onClick={onNext}
                disabled={index >= count - 1}
                {...nextKeys}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" {...csIcoS} aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </IconButton>
              {unreadAfter > 0 && <span data-unread-dot="after" style={unreadDot} />}
            </span>
            {unread > 0 && (
              // Outside the centred arrow group's flow, so the arrows never
              // move under the pointer as the badge comes and goes.
              <span
                role="status"
                style={{
                  position: "absolute",
                  left: "100%",
                  marginInlineStart: "var(--space-2)",
                  whiteSpace: "nowrap",
                }}
              >
                <Badge tone="accent" mono>
                  {m.uiCardStackNew({ count: unread })}
                </Badge>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Decorative depth belongs inside the entry drawing, so it shares that
 * drawing's readiness, opacity and departure instead of outliving it.
 * Each peek reaches one step into the front card's top edge, and the card
 * is drawn over it: the peeks paint at `zIndex: -1`, so the entry that
 * holds them must isolate its painting (`StageEntry`), or they would fall
 * behind the stage itself.
 */
export function CardPeeks({ count, style }: { count: number; style?: React.CSSProperties }) {
  const peekBase: React.CSSProperties = {
    position: "absolute",
    background: "var(--acrylic-bg)",
    backdropFilter: "var(--acrylic-blur)",
    WebkitBackdropFilter: "var(--acrylic-blur)",
    border: "1px solid var(--acrylic-border)",
    borderBottom: "none",
    borderRadius: "var(--radius-l) var(--radius-l) 0 0",
    height: 14,
    zIndex: -1,
  };
  return (
    <>
      {count > 2 && (
        <div
          data-card-peek=""
          style={{
            ...peekBase,
            left: 2 * CARD_PEEK_STEP,
            right: 2 * CARD_PEEK_STEP,
            top: -2 * CARD_PEEK_STEP,
            ...style,
          }}
        />
      )}
      {count > 1 && (
        <div
          data-card-peek=""
          style={{
            ...peekBase,
            left: CARD_PEEK_STEP,
            right: CARD_PEEK_STEP,
            top: -CARD_PEEK_STEP,
            ...style,
          }}
        />
      )}
    </>
  );
}

/** How far the page number slides as it changes, px. */
const PAGER_NUMBER_TRAVEL = 12;

/**
 * The shown card's place in the pager. Paging slides the old number out and
 * the new one in from the arrow's side, over `--dur-page` like the card; a
 * change of count (a close, an arrival) changes it at once.
 */
function PagerNumber({ value, count }: { value: number; count: number }) {
  const [leaving, setLeaving] = useState<{ value: number; dir: 1 | -1 } | null>(null);
  const [last, setLast] = useState({ value, count });
  if (last.value !== value || last.count !== count) {
    setLast({ value, count });
    if (last.value !== value)
      setLeaving(
        last.count === count ? { value: last.value, dir: value > last.value ? 1 : -1 } : null,
      );
  }
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!leaving || !el) return;
    const duration = motionToken(el, "--dur-page");
    const [out, into] = Array.from(el.children) as HTMLElement[];
    if (duration <= 0 || !out || !into) {
      setLeaving(null);
      return;
    }
    const easing = motionEase(el);
    const travel = PAGER_NUMBER_TRAVEL * leaving.dir;
    const gone = out.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: `translateY(${-travel}px)` },
      ],
      { duration, easing, fill: "forwards" },
    );
    const come = into.animate(
      [
        { opacity: 0, transform: `translateY(${travel}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing },
    );
    gone.onfinish = () => setLeaving(null);
    return () => {
      gone.cancel();
      come.cancel();
    };
  }, [leaving]);
  if (!leaving) return <>{value}</>;
  return (
    <span ref={box} style={{ display: "inline-grid", overflow: "hidden", verticalAlign: "bottom" }}>
      <span aria-hidden="true" style={{ gridArea: "1 / 1" }}>
        {leaving.value}
      </span>
      <span style={{ gridArea: "1 / 1" }}>{value}</span>
    </span>
  );
}
