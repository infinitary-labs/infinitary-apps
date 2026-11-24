import type { CardWidth } from "@shared/cards";
import type { DefaultCardSize } from "@shared/preferences";
import {
  cardWidth,
  THREAD_CARD_MAX,
  THREAD_STAGE_MARGIN,
  threadColumnWidth,
  threadPlacement,
} from "./threadGeometry";

/**
 * How wide a card is on the stage (the captain's Q5 to Q7 A of 2026-09-28,
 * proposal 2 of `fm3000-card-decisions-width-s1`). The arithmetic lives
 * here, away from the DOM, for the reason `threadGeometry.ts` does: it is
 * the whole of the behaviour worth pinning, and `threadGeometry.test.ts`
 * walks it at the window sizes the captain reviewed.
 *
 * Who decides, in order: the host at emit (`Card.width`, from the body's
 * facts and the author's hint), widened by the saved opening size, then the
 * captain's drag on either edge, which holds while the card is up and through its revisions and is never
 * a setting. Every width is clamped to the stage less its margin, as 560
 * always was.
 */

/** Each size's design width; `full` is the stage itself, up to this. */
export const CARD_SIZES: Record<CardWidth, number> = { regular: 560, wide: 800, full: 1_040 };
/** A saved minimum only widens the host's choice; maximize restores to the usual width. */
export function openingCardWidth(
  width: CardWidth | undefined,
  size: DefaultCardSize,
): CardWidth | undefined {
  if (size !== "wide" && size !== "full") return width;
  return CARD_SIZES[width ?? "wide"] > CARD_SIZES[size] ? width : size;
}

export const CARD_DRAG_MIN = 480;
/**
 * The conversation's width until it is dragged (INF-6337's plan, the
 * captain's chosen 720 px): between the regular and wide sizes, which no
 * card width names.
 */
export const CONVERSATION_WIDTH = 720;
/**
 * A card wider than regular needs this much of the docked stage; under it,
 * with a dock occupied, the docks fold as they do for a thread and unfold
 * when the card leaves.
 */
export const WIDE_CARD_ROOM = 720;

/** What the width rules read off a card: the host's size and the captain's drag. */
export type SizedCard = {
  width?: CardWidth | undefined;
  /** The captain's drag, in px, while the card is up. */
  dragged?: number | undefined;
};

/** What a card asks for, in px, before any stage: the captain's drag, else its size. */
export function requestedCardWidth(card: SizedCard): number {
  if (card.dragged !== undefined) {
    return Math.round(Math.min(CARD_SIZES.full, Math.max(CARD_DRAG_MIN, card.dragged)));
  }
  return CARD_SIZES[card.width ?? "wide"];
}

/** The card's width on a stage with no thread beside it. */
export function cardWidthFor(card: SizedCard, stage: number): number {
  return cardWidth(stage, requestedCardWidth(card));
}

/** Where a lone card goes: its width, and whether the docks folded to give it. */
export type CardPlacement = { folded: boolean; card: number };

/**
 * A card with no thread open, for a window of `windowWidth` with
 * `railsWidth` of symmetric expanded-rail clearance. A regular card folds when it cannot keep
 * its requested width (FI3-489, approved whole-window scaling).
 * Default-wide yields to the docks down to 560px, then folds them.
 * A content-required or dragged wider card folds when the stage cannot give it
 * `WIDE_CARD_ROOM` (or all it asks, when it asks for less), and takes the
 * whole window instead - the same fold the thread's second rung uses.
 */
export function cardPlacement(
  windowWidth: number,
  railsWidth: number,
  card: SizedCard,
): CardPlacement {
  const requested = requestedCardWidth(card);
  const stage = windowWidth - railsWidth;
  const room = stage - THREAD_STAGE_MARGIN;
  if (
    railsWidth > 0 &&
    ((requested <= THREAD_CARD_MAX && room < requested) ||
      (card.width === undefined && card.dragged === undefined && room < CARD_SIZES.regular) ||
      ((card.width === "wide" || card.width === "full" || card.dragged !== undefined) &&
        requested > THREAD_CARD_MAX &&
        room < Math.min(requested, WIDE_CARD_ROOM)))
  ) {
    return { folded: true, card: cardWidth(windowWidth, requested) };
  }
  return { folded: false, card: cardWidth(stage, requested) };
}

/**
 * Reserve equal room on both sides of a window-centered card or thread pair.
 * Expanded rails need clearance; collapsed headers report zero from the shell.
 */
export function centeredRailsWidth(left: number, right: number): number {
  return 2 * Math.max(left, right);
}

/**
 * The size the frame's document is told (`data-width`), from the width the
 * card is really shown at, so a body styles for the room it has.
 */
export function shownCardSize(width: number): CardWidth {
  if (width <= CARD_SIZES.regular) return "regular";
  if (width <= CARD_SIZES.wide) return "wide";
  return "full";
}

/** Where a maximized card goes: its thread's home, and the two columns' widths. */
export type MaximizedPlacement = {
  /** `none` with no thread open; else the thread ladder's rung. */
  home: "beside" | "in-place" | "none";
  card: number;
  /** The thread column beside the card; 0 otherwise. */
  thread: number;
};

/**
 * A maximized card (design skill `components/cards/ResponseCard.prompt.md`,
 * "Maximize"): the side panels and the main message step aside, so the card
 * takes the window's whole width less `THREAD_STAGE_MARGIN` (16 px each
 * side), with no ceiling of its own and no drag. A thread already open beside
 * it keeps its own width rules and the card takes the rest; where the two
 * cannot both fit, the thread goes in place, as on the ordinary stage.
 */
export function maximizedPlacement(windowWidth: number, threadOpen: boolean): MaximizedPlacement {
  if (!threadOpen)
    return { home: "none", card: cardWidth(windowWidth, Number.POSITIVE_INFINITY), thread: 0 };
  const { home, card, thread } = threadPlacement(windowWidth, 0, Number.POSITIVE_INFINITY);
  return { home, card, thread };
}

export type RequestPlacement = {
  /** The column is open beside the page; else it is folded to its latest line under it. */
  open: boolean;
  /** The docked rails gave their width back. */
  folded: boolean;
  /** The page's column: what the view would be without the request. */
  page: number;
  /** The request's column beside the page; 0 while it is folded. */
  column: number;
};

/**
 * A request docked beside its browser's page (docs/task-browser.md, "The
 * request beside the page"): the page keeps the width it would have alone,
 * up to `CARD_SIZES.full`, and the request's column, the thread column's
 * own widths, is added beside it, the pair centred as one. It walks the
 * thread's ladder: beside within the docks, then with the docks folded,
 * while the page keeps `WIDE_CARD_ROOM`; below that the column folds to its
 * latest line under the page, which takes the stage alone. The captain's
 * Command-backslash choice (`choice`) wins over the width either way.
 * Maximized, the window is the stage and nothing folds the docks.
 */
export function requestPlacement(
  windowWidth: number,
  railsWidth: number,
  page: SizedCard,
  choice: "open" | "folded" | undefined,
  maximized = false,
): RequestPlacement {
  if (maximized) {
    const column = threadColumnWidth(windowWidth);
    const beside = windowWidth - THREAD_STAGE_MARGIN - column;
    const open = choice === "open" || (choice !== "folded" && beside >= WIDE_CARD_ROOM);
    return open
      ? { open, folded: false, page: beside, column }
      : { open, folded: false, page: cardWidth(windowWidth, Number.POSITIVE_INFINITY), column: 0 };
  }
  const asked = requestedCardWidth(page);
  const pairIn = (stage: number) => {
    const column = threadColumnWidth(stage);
    return { column, page: Math.min(asked, stage - THREAD_STAGE_MARGIN - column) };
  };
  const roomy = (width: number) => width >= Math.min(asked, WIDE_CARD_ROOM);
  if (choice !== "folded") {
    const docked = pairIn(windowWidth - railsWidth);
    if (roomy(docked.page)) return { open: true, folded: false, ...docked };
    const whole = pairIn(windowWidth);
    if (railsWidth > 0 && (roomy(whole.page) || choice === "open"))
      return { open: true, folded: true, ...whole };
    if (choice === "open") return { open: true, folded: false, ...docked };
  }
  const lone = cardPlacement(windowWidth, railsWidth, page);
  return { open: false, folded: lone.folded, page: lone.card, column: 0 };
}
