import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../core/Badge";
import { IconButton } from "../core/IconButton";
import { useRestLabel } from "../core/restLabel";
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

type CommandKeyHint = { keys?: string | undefined; "aria-keyshortcuts"?: string | undefined };

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
  /** A press on "N new": shows the next new card besides the shown one (INF-4541). */
  onNew?: () => void;
  /**
   * How the shown card came up, for the page number's slide: 1 or -1 an
   * arrow's way, so going round from the last card to the first still slides
   * forward; 0 a jump, which changes the number at once. Unset reads the way
   * from the numbers.
   */
  turn?: 1 | -1 | 0 | undefined;
  /** The arrows' key hints: the keys that page the same way from anywhere in the window. */
  prevKeys?: CommandKeyHint;
  nextKeys?: CommandKeyHint;
  /** "N new"'s key hint. */
  newKeys?: CommandKeyHint;
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
  onNew,
  turn,
  prevKeys,
  nextKeys,
  newKeys,
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
              <IconButton label={m.uiCardStackPrevious()} size={28} onClick={onPrev} {...prevKeys}>
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
              <PagerNumber value={index + 1} count={count} turn={turn} /> / {count}
            </span>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <IconButton label={m.uiCardStackNext()} size={28} onClick={onNext} {...nextKeys}>
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
                {/* A new card besides the shown one: a press shows it. The shown
                    card alone, its sighting not yet confirmed, is only counted. */}
                {unreadBefore + unreadAfter > 0 ? (
                  <NewBadgeButton count={unread} onPress={onNew} keys={newKeys} />
                ) : (
                  <Badge tone="accent" mono>
                    {m.uiCardStackNew({ count: unread })}
                  </Badge>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "N new" as a button: the badge's own look, with the pager arrows' hover and focus. */
function NewBadgeButton({
  count,
  onPress,
  keys,
}: {
  count: number;
  onPress: (() => void) | undefined;
  keys: CommandKeyHint | undefined;
}) {
  const [hover, setHover] = useState(false);
  const restLabel = useRestLabel(m.uiCardStackShowNew(), { keys: keys?.keys });
  return (
    <button
      {...restLabel}
      type="button"
      data-card-new=""
      aria-keyshortcuts={keys?.["aria-keyshortcuts"]}
      aria-description={m.uiCardStackShowNew()}
      onClick={onPress}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        padding: 0,
        border: "none",
        background: "transparent",
        borderRadius: "var(--radius-s)",
        cursor: "pointer",
      }}
    >
      <Badge
        tone="accent"
        mono
        style={{
          boxShadow: hover ? "inset 0 0 0 1px var(--accent)" : undefined,
          transition: "box-shadow var(--dur-fast) var(--ease-out)",
        }}
      >
        {m.uiCardStackNew({ count })}
      </Badge>
    </button>
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
 * the new one in from the arrow's side, over `--dur-page` like the card, so
 * 20 → 1 by the next arrow slides as a step forward; a jump ("N new") and a
 * change of count (a close, an arrival) change it at once.
 */
function PagerNumber({
  value,
  count,
  turn,
}: {
  value: number;
  count: number;
  turn: 1 | -1 | 0 | undefined;
}) {
  const [leaving, setLeaving] = useState<{ value: number; dir: 1 | -1 } | null>(null);
  const [last, setLast] = useState({ value, count });
  if (last.value !== value || last.count !== count) {
    setLast({ value, count });
    if (last.value !== value) {
      const dir = turn ?? (value > last.value ? 1 : -1);
      setLeaving(last.count === count && dir !== 0 ? { value: last.value, dir } : null);
    }
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
