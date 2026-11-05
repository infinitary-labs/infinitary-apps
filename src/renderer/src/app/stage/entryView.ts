import { type CardMessage, cardTakesReplies } from "@shared/cards";
import type { DefaultCardSize } from "@shared/preferences";
import {
  cardPlacement,
  maximizedPlacement,
  openingCardWidth,
  requestedCardWidth,
} from "../../cards/cardGeometry";
import type { PastRead } from "../../cards/PastCard";
import type { Unprepared } from "../../cards/stageMarks";
import { threadPlacement } from "../../cards/threadGeometry";
import type { ShellLayout } from "../shellLayout";
import { isHeldEntry, type StackEntry } from "../stack";

/**
 * Where the Firstmate and the card are centred: 60px above the stage's
 * middle, lifted by half the composer's growth (`--prompt-rise`, written by
 * HomePrompt), so the air between a tall card and the input never closes.
 * In a window shorter than the shortest one at 100%, the centre follows the
 * air the stage gives back (`--prompt-floor`, `--stage-yield-*`,
 * design/styles.css): halfway between the stack's new top and its new foot.
 */
export const STAGE_TOP =
  "calc(50% - 60px + (var(--space-9) - var(--prompt-floor) - var(--prompt-rise) - var(--stage-yield-top) + var(--stage-yield-lane)) / 2)";
/** The lift eases; under reduced motion it lands at once (design/styles.css). */
export const STAGE_LIFT_EASE = "top var(--stage-lift-duration) var(--ease-out)";

/** Where an entry sits on the stage: its thread, its widths and the layer's offset. */
export type EntryView = {
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
export type ViewFacts = {
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
export function entryView(
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
export function unpreparable(entry: StackEntry, windowShown: boolean): Unprepared | null {
  if (!windowShown) return "window-hidden";
  if (isHeldEntry(entry)) return "held-view";
  return null;
}
