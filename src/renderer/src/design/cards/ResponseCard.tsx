import { ENDED_CHIP_LABEL } from "@shared/endedCard";
import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { Badge, type BadgeTone } from "../core/Badge";
import { ModelChip } from "../core/ModelChip";
import { CardCorner } from "./CardSize";

/**
 * The chrome a card wears, derived from what it is and never declared on
 * the wire (cards/tasks/agents P1, ruling D1 a): `decision` has actions,
 * `note` has none, `attention` is the host's own (the agent-down set);
 * `record` is a task's record; `ended` is a card its author ended while the
 * captain had it up, which stays until they close it (INF-3071).
 */
export type ResponseCardKind = "decision" | "note" | "attention" | "record" | "ended";

/**
 * The design skill's adherence lint (`_adherence.oxlintrc.json`) lists these
 * props and the kinds above: a new one joins that list in the same change, or
 * tests/response-card-adherence.test.ts fails.
 */
export type ResponseCardProps = {
  kind?: ResponseCardKind;
  /** Host-owned record header on the same card surface. */
  chrome?: React.ReactNode;
  recordTaskId?: string;
  title?: string;
  /**
   * The title as drawn, when it is more than its words: the app's live card
   * links the task keys in it (FI3-1271). `title` still names the card.
   */
  titleWords?: React.ReactNode;
  /**
   * The task the card is about, as its key drawn as a link (design skill
   * `components/core/TaskKey.prompt.md`, "The card's own key"): it leads
   * the meta line, keeps its whole width, and is the card's door to the
   * task's record. Absent on a card about no task.
   */
  taskKey?: React.ReactNode;
  /** Host-validated review attribution, separate from the decision kind. */
  reviewFinding?: boolean;
  /** Mono metadata line: relative time, crewmate ref. */
  meta?: string;
  /**
   * Where its task runs, for a card from a task on a computer that runs
   * work ("on Mac mini"): read right after the meta line, which gives way to
   * it, so a long task title never hides it (docs/helper.md, "A card from
   * there").
   */
  place?: string;
  /**
   * The model its author ran on: an outline mono chip right after the meta
   * line, which gives way to it (the chip is never truncated or pushed out).
   */
  model?: string;
  /** Action button row (app-owned chrome), right-aligned. */
  actions?: React.ReactNode;
  /**
   * Host chrome between the body and the action row: the card's live
   * attachment (design skill `components/cards/ResponseCard.prompt.md`,
   * "A live attachment"), on a decision and a note alike. Never a card
   * action.
   */
  attachment?: React.ReactNode;
  /**
   * Host chrome pinned between the body (and its attachment) and the action
   * row, under a hairline: the card's one field (INF-924), whose words go as
   * a reply or with the choice clicked, in view however long the body is.
   */
  comment?: React.ReactNode;
  /**
   * Host chrome above the action row, the card's full width: a settle
   * card's fact strip, in view however long the body is. The actions take
   * the row under it.
   */
  facts?: React.ReactNode;
  /**
   * Host chrome at the top right of the card's reading area, level with the
   * title's top and flush with its content edge: a merge card's risk chart
   * (design skill `components/cards/ResponseCard.prompt.md`, "The risk
   * chart"). The title and the revised line give way by its `width` and the
   * gap; the body keeps clear of the rest of it with its own spacer.
   */
  aside?: { node: React.ReactNode; width: number; ref?: React.Ref<HTMLDivElement> };
  /** The stage-owned corner button, for keyboard focus. */
  closeRef?: React.Ref<HTMLButtonElement>;
  children?: React.ReactNode;
  width?: number | string;
  minHeight?: number;
  /**
   * Whether the card draws its own surface. False when it is one COLUMN of
   * a larger container - a card with its thread open beside it, which is one
   * solid surface, one border, one radius and one shadow for the pair
   * (design skill `components/cards/CardThread.prompt.md`). The card's own
   * height cap goes with it: the container caps the pair.
   */
  surface?: boolean;
  /** Extra chrome in the head, between the badge and the meta line. */
  headExtra?: React.ReactNode;
  /**
   * The quiet revised line under the title on a card revised since the
   * captain last saw it ("Revised 14:02 · 2 parts new · 1 removed", or
   * "Rewritten 14:02"; design skill `components/cards/ResponseCard.prompt.md`).
   */
  revised?: React.ReactNode;
  /**
   * The "You asked" line under the title and the revised line: when the
   * captain sent the message the card is about and their words, the start
   * of a long message with a control that opens the rest (design skill
   * `components/cards/ResponseCard.prompt.md`, "The You asked line").
   */
  asked?: React.ReactNode;
  /**
   * Host chrome below the action row - a task record's own bar, or the
   * words a past card's field sent with its choice. It is never a card
   * action and never wraps into that row.
   */
  footer?: React.ReactNode;
  /**
   * Only the body: no head, title, revised line, actions or footer. A card
   * the stage prepares before it is shown draws its body at its final width;
   * the chrome joins around the same body when it is shown.
   */
  bare?: boolean;
  style?: React.CSSProperties;
  /**
   * Over the body's own padding and scrolling: a body that fills the card
   * and scrolls itself - a panel's card of `fill` height - takes none.
   */
  bodyStyle?: React.CSSProperties;
  /** The owner may keep its body reading place across an in-session remount. */
  bodyRef?: React.Ref<HTMLDivElement>;
};

/** Each kind's chip, its word read when it is drawn so it follows a language change. */
const cardKinds: Record<ResponseCardKind, { readonly label: string; tone: BadgeTone }> = {
  decision: {
    get label() {
      return m.uiCardKindDecision();
    },
    tone: "accent",
  },
  note: {
    get label() {
      return m.uiCardKindNote();
    },
    tone: "neutral",
  },
  attention: {
    get label() {
      return m.uiCardKindAttention();
    },
    tone: "danger",
  },
  /** A task's record (task-system P4): never any card actions; its footer is the host's. */
  record: {
    get label() {
      return m.uiCardKindTask();
    },
    tone: "neutral",
  },
  /** Its author ended it; nothing on it waits (INF-3071). */
  ended: { label: ENDED_CHIP_LABEL, tone: "neutral" },
};

/**
 * The tallest a card on the stage may be. The stack is centred 60px above
 * the stage's middle and carries a pager under the card; at the shortest
 * window (640px) this keeps the card's top clear of the 52px top bar, so
 * close is never under the drag region. The composer's growth
 * (`--prompt-rise`) and its foot above the floor (`--prompt-floor`) come off
 * it, so the air between a tall card and a multi-line input never closes
 * (docs/composer.md). A window a larger size makes shorter than the shortest
 * one gives back the stage's air above the stack and beside the pager
 * (`--stage-yield-*`, design/styles.css). A taller body scrolls inside the
 * card. A maximized card's stage sets `--card-max-height`, the room the
 * window gives it, for everything inside it (`app/stage/CardLayer.tsx`).
 */
// Reserve separate stable lanes for paging and the activity whisper.
export const CARD_MAX_HEIGHT =
  "var(--card-max-height, calc(100vh - 2 * var(--space-9) - var(--space-7) - var(--space-2) - var(--prompt-floor) - var(--prompt-rise) + var(--stage-yield-top) + var(--stage-yield-lane)))";

/**
 * A card surface's floor, `px` under the cap. A maximized card's stage sets
 * `--card-floor` on the card it shows, so its surface fills the room the
 * window gives it however short its body (`app/stage/CardLayer.tsx`).
 */
export const cardFloor = (px: number) => `var(--card-floor, min(${px}px, ${CARD_MAX_HEIGHT}))`;

/**
 * The room the middle keeps beside the card's field: a line of the title and
 * a few of the body, so the body stays in sight (a frame out of sight never
 * draws) while the field is what a short card cuts.
 */
const COMMENT_BODY_FLOOR = "var(--space-4)";

export function ResponseCard({
  kind = "note",
  chrome,
  recordTaskId,
  title,
  titleWords,
  taskKey,
  reviewFinding,
  meta,
  place,
  model,
  actions,
  attachment,
  comment,
  facts,
  aside,
  closeRef,
  children,
  width = 560,
  minHeight = 340,
  surface = true,
  headExtra,
  revised,
  asked,
  footer,
  bare = false,
  style,
  bodyStyle,
  bodyRef,
}: ResponseCardProps) {
  const k = cardKinds[kind] || cardKinds.note;
  // The title and the revised line give way to the chrome beside them.
  const asideRoom = aside ? `calc(20px + ${aside.width}px + var(--space-4))` : "20px";
  return (
    <section
      data-response-card=""
      data-task-record={recordTaskId}
      aria-label={recordTaskId ? m.uiCardTaskRecord() : title}
      style={{
        width,
        // The floor gives way to the cap (CARD_MAX_HEIGHT) when a tall
        // composer shrinks it, here and as one column of the pair.
        minHeight: surface ? cardFloor(minHeight) : `min(${minHeight}px, ${CARD_MAX_HEIGHT})`,
        ...(surface
          ? {
              maxHeight: CARD_MAX_HEIGHT,
              background: "var(--acrylic-bg)",
              backdropFilter: "var(--acrylic-blur)",
              WebkitBackdropFilter: "var(--acrylic-blur)",
              border: "1px solid var(--acrylic-border)",
              borderRadius: "var(--radius-l)",
              boxShadow: "var(--acrylic-shadow)",
            }
          : { minWidth: 0 }),
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        // The middle gives way first (below). A card too short even for its
        // head and its buttons scrolls to them rather than cutting them off.
        overflowX: "hidden",
        overflowY: "auto",
        ...style,
      }}
    >
      {bare
        ? null
        : (chrome ?? (
            <div
              data-card-head=""
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 12px 0 20px",
                flexShrink: 0,
              }}
            >
              <Badge tone={k.tone} dot style={{ flexShrink: 0 }}>
                {k.label}
              </Badge>
              {reviewFinding && (
                <Badge tone="warn" style={{ flexShrink: 0 }}>
                  {m.cardReviewFinding()}
                </Badge>
              )}
              {headExtra}
              {(taskKey || meta || place || model) && (
                // The meta line and the model chip share the room between the
                // chip and close. A long meta line (crewmate ref carrying a repo
                // name) truncates with an ellipsis instead of wrapping the card
                // header, and it is the one that gives way: the chip keeps its
                // whole name, wrapping inside itself only when the name is longer
                // than all the room there is.
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {(taskKey || meta || place) && (
                    // The task's key leads the line and keeps its whole width;
                    // where the task runs reads right after the meta line, in
                    // its voice, "Fix the footer · on Mac mini": the meta line
                    // gives way first, and the place keeps its words unless
                    // they are longer than all the room there is.
                    <span
                      style={{
                        display: "flex",
                        gap: "1ch",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-3)",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                        flex: model ? "0 1 auto" : 1,
                      }}
                    >
                      {taskKey && (
                        <span data-card-key="" style={{ flexShrink: 0, display: "inline-flex" }}>
                          {taskKey}
                        </span>
                      )}
                      {taskKey && meta && <span aria-hidden="true">·</span>}
                      {meta && (
                        <span
                          data-card-meta=""
                          style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
                        >
                          {meta}
                        </span>
                      )}
                      {place && (
                        <span
                          data-card-place=""
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            flexShrink: 0,
                            maxWidth: "100%",
                          }}
                        >
                          {meta ? `· ${place}` : place}
                        </span>
                      )}
                    </span>
                  )}
                  {model && <ModelChip label={model} />}
                </span>
              )}
              <CardCorner style={{ marginInlineStart: "auto" }} buttonRef={closeRef} />
            </div>
          ))}
      <div
        // The title and the body give way together: the body first, then,
        // in a card too short to show both, the title scrolls up out of the
        // body's way, so the head and the buttons are never what is cut and
        // the body stays in sight (a frame out of sight never draws). The
        // reversed column starts this scroller at its end; `order` keeps the
        // title on top and the reading order as written.
        data-card-middle=""
        style={{
          flex: 1,
          // Beside the card's field the middle keeps a floor, so in a short
          // card the field gives way before the body (see the comment row).
          minHeight: comment && !bare ? COMMENT_BODY_FLOOR : 0,
          display: "flex",
          flexDirection: "column-reverse",
          overflowY: "auto",
          // The body's own bar shows there is more; this one takes no width
          // from the body's frame (see the body's gutter below).
          scrollbarWidth: "none",
        }}
      >
        {!bare && !chrome && title && (
          <div
            data-card-title=""
            style={{
              order: 3,
              position: aside ? "relative" : undefined,
              padding: `10px ${asideRoom} 0 20px`,
              flexShrink: 0,
              fontSize: "var(--text-lg)",
              fontWeight: 500,
              letterSpacing: "var(--tracking-display)",
              color: "var(--fg-1)",
              lineHeight: "var(--leading-tight)",
            }}
          >
            {/* The title's own words keep an element of their own beside the chrome. */}
            {aside ? <span>{titleWords ?? title}</span> : (titleWords ?? title)}
            {aside && (
              <div
                ref={aside.ref}
                data-card-aside=""
                style={{ position: "absolute", top: 10, right: 20, zIndex: 1 }}
              >
                {aside.node}
              </div>
            )}
          </div>
        )}
        {!bare && !chrome && revised && (
          <div
            data-card-revised=""
            style={{
              order: 2,
              padding: `var(--space-1) ${asideRoom} 0 20px`,
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {revised}
          </div>
        )}
        {!bare && !chrome && asked && (
          <div
            data-card-asked-row=""
            style={{
              order: 1,
              padding: `var(--space-2) ${asideRoom} 0 20px`,
              flexShrink: 0,
            }}
          >
            {asked}
          </div>
        )}
        <div
          ref={bodyRef}
          data-card-body=""
          style={{
            flex: 1,
            minHeight: 0,
            // Keep the frame's width independent of overflow: a scrollbar that
            // takes width shrinks fluid content, whose height report can remove
            // that same scrollbar and start an endless resize feedback loop.
            overflowY: "auto",
            scrollbarGutter: "stable",
            padding: "12px 20px 18px",
            fontSize: "var(--text-base)",
            color: "var(--fg-2)",
            lineHeight: "var(--leading-body)",
            ...bodyStyle,
          }}
        >
          {children}
        </div>
      </div>
      {!bare && attachment && (
        <div
          data-card-attachment-row=""
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--line-1)",
            padding: "var(--space-2) var(--space-4)",
          }}
        >
          {attachment}
        </div>
      )}
      {!bare && comment && (
        <div
          data-card-comment-row=""
          style={{
            // The one row below the middle that gives way: once the middle is
            // at its floor, a shorter card shrinks this row and it scrolls.
            flexShrink: 1,
            minHeight: 0,
            overflowY: "auto",
            borderTop: "1px solid var(--line-1)",
            // The air between the field and the buttons sits inside this row,
            // which scrolls and so cuts what it does not hold: the field's
            // focus glow needs it on every side.
            padding: "var(--space-3) 16px",
          }}
        >
          {comment}
        </div>
      )}
      {!bare && (actions || facts) && (
        <div
          // The card's buttons: one of the shown card's places a key goes to
          // (docs/keyboard.md, "Cards and frames"). Its fact strip takes the
          // row above them, and stays here alone while the buttons stand
          // under an open thread's field.
          data-card-actions={actions ? "" : undefined}
          style={{
            display: "flex",
            flexShrink: 0,
            flexWrap: "wrap",
            justifyContent: "flex-end",
            // Beside a line of words taller than they are, buttons keep their height.
            alignItems: facts ? "center" : undefined,
            gap: "var(--space-2)",
            rowGap: "var(--space-2)",
            // Keep the body separate from its choices and keep air above the
            // footer's hairline.
            // The field's row above already holds the air between them.
            padding: `${comment && !bare ? "0" : "var(--space-3)"} 16px ${footer ? "var(--space-3)" : "16px"}`,
          }}
        >
          {facts && (
            <div data-card-facts="" style={{ flex: "0 0 100%", minWidth: 0 }}>
              {facts}
            </div>
          )}
          {actions}
        </div>
      )}
      {!bare && footer && <div style={{ padding: "0 16px 16px", flexShrink: 0 }}>{footer}</div>}
    </section>
  );
}
