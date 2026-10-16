/**
 * The stage's timing marks (FI3-871; docs/renderer.md, "Timing marks"):
 * User Timing entries in the window's own performance timeline, read only
 * on this Mac - nothing sends them anywhere. Each selection that replaces a
 * shown card leaves one `stage:select` mark naming its outcome - `hit`, or
 * the one reason from a closed list that it missed - and the milestones
 * after it leave marks of their own, so a later look at the app's own
 * timeline counts real misses instead of guessing.
 */

/** Why the selected card was not a prepared page that had drawn. */
export const STAGE_MISSES = [
  /** A different card was prepared than the one selected. */
  "other-card",
  /** The right card was prepared, but its page had not drawn yet. */
  "not-drawn",
  /** The right card was prepared, but at an older version, width or theme. */
  "stale",
  /** The leaving drawing still held the stage's second place. */
  "slot-busy",
  /** The incoming reveal or the height easing has not finished. */
  "settling",
  /** The selected entry is a task record or a past card, read when shown. */
  "held-view",
  /** The window was hidden, so nothing was prepared. */
  "window-hidden",
  /** The prepared card's thread history had not arrived, so its width was unknown. */
  "thread-pending",
  /** The narrow layout that shows the thread in place of the body. */
  "in-place",
  /** The prepared page was refused or stopped responding. */
  "mount-failed",
  /** No card came next. */
  "none",
] as const;
export type StageMiss = (typeof STAGE_MISSES)[number];
export type StageOutcome = "hit" | StageMiss;

/** The marks each replacement leaves, in the order they usually come. */
export const STAGE_MILESTONES = [
  "select",
  "mount",
  "promote",
  "born",
  "drawn",
  "activated",
  "visible",
  "settled",
] as const;
export type StageMilestone = (typeof STAGE_MILESTONES)[number];

/** Why the successor the stage would prepare is not prepared, when it is not. */
export type Unprepared = Extract<
  StageMiss,
  "held-view" | "window-hidden" | "thread-pending" | "in-place" | "slot-busy" | "settling"
>;

/** How far the prepared page got with the selected card's current document. */
export type PreparedDrawing = "current" | "stale" | "none" | "failed";

/** What the stage knew, just before the selection, about the card it would bring up next. */
export type PrepareFacts = {
  /** The successor a close would bring up, and why it was not prepared. */
  successor: { id: string; unprepared: Unprepared | null } | null;
  /** The prepared slot's entry, if any. */
  warm: string | null;
};

/**
 * The outcome of one selection: what came up, against what the stage had
 * prepared. `drawing` is how far the prepared page got with the selected
 * card's current document; it is read only when the prepared card is the
 * selected one. Pure.
 */
export function stageOutcome(
  selected: { id: string; held: boolean } | null,
  facts: PrepareFacts,
  drawing: PreparedDrawing,
  windowShown: boolean,
): StageOutcome {
  if (!selected) return "none";
  if (selected.held) return "held-view";
  if (facts.warm === selected.id) {
    if (drawing === "current") return "hit";
    if (drawing === "failed") return "mount-failed";
    return drawing === "stale" ? "stale" : "not-drawn";
  }
  if (!windowShown) return "window-hidden";
  if (facts.successor?.id === selected.id && facts.successor.unprepared)
    return facts.successor.unprepared;
  return "other-card";
}

/** Replacements kept in the timeline before its stage marks start over, so it stays bounded. */
export const STAGE_MARKS_KEPT = 200;
let selections = 0;

/** Leaves one stage mark in the window's performance timeline. */
export function markStage(milestone: StageMilestone, detail: Record<string, unknown>): void {
  if (milestone === "select" && ++selections > STAGE_MARKS_KEPT) {
    selections = 1;
    for (const name of STAGE_MILESTONES) performance.clearMarks(`stage:${name}`);
  }
  performance.mark(`stage:${milestone}`, { detail });
}
