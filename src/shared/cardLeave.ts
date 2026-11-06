import { z } from "zod";
import type { CardPresentation } from "./cards";
import { formatDurationShort } from "./quotaSignals.ts";

/** INF-1879: the corner is presentation only; ending work always has a named button. */
export type CardLeaveKind = CardPresentation | "record" | "window-panel";
export const cardCornerSchema = z.object({
  icon: z.literal("minus"),
  label: z.string(),
  restWords: z.string(),
  /** The core's operation lets a view predict the same change without classifying the card again. */
  operation: z.enum(["aside", "read", "hide"]).optional(),
});
export type CardCornerWords = z.infer<typeof cardCornerSchema>;
type LeaveRow = CardCornerWords & {
  operation: "aside" | "read" | "hide";
};
const aside = {
  icon: "minus",
  label: "Put aside",
  restWords: "Put aside · waits in Tasks, back when it changes",
  operation: "aside",
} as const;
const hide = {
  icon: "minus",
  label: "Hide",
  restWords: "Hide · the task goes on",
  operation: "hide",
} as const;
export const CARD_LEAVE = {
  decision: aside,
  // INF-2794: the minus only ever puts a card aside; a note ends on its own button.
  note: aside,
  attention: aside,
  record: hide,
  "window-panel": { ...hide, restWords: "Hide · the view stays available" },
} as const satisfies Record<CardLeaveKind, LeaveRow>;

/** The corner's operation for a card of this kind. */
export function cardLeaveOperation(kind: CardLeaveKind): LeaveRow["operation"] {
  return CARD_LEAVE[kind].operation;
}

/** Only the core supplies live words; the window's own panels read their row directly. */
export function cardCornerOf(kind: CardLeaveKind): CardCornerWords {
  const row: LeaveRow = CARD_LEAVE[kind];
  return { icon: row.icon, label: row.label, restWords: row.restWords, operation: row.operation };
}
export const ANSWER_DONE_LABEL = "Done";
export function answerDoneRest(key: string): string {
  return `${ANSWER_DONE_LABEL} · closes ${key} as answered; the answer stays on its record`;
}

/**
 * Every live note's one button (INF-2794): "Done" when the click closes its
 * task (the marked answer note of an active answer task), "Got it" otherwise.
 * The core decides and sends it, so the Mac and the phone draw the same thing.
 */
export const noteDoneSchema = z.object({
  label: z.string(),
  restWords: z.string(),
  /** The click closes the note's task as answered. */
  closesTask: z.boolean(),
});
export type NoteDone = z.infer<typeof noteDoneSchema>;
export const NOTE_GOT_IT_LABEL = "Got it";
/** The id the note's button is recorded under, so its past card reads the label. */
export const NOTE_DONE_ACTION_ID = "note-done";

export function noteDoneOf(key: string | undefined, closesTask: boolean): NoteDone {
  if (closesTask && key)
    return { label: ANSWER_DONE_LABEL, restWords: answerDoneRest(key), closesTask };
  return {
    label: NOTE_GOT_IT_LABEL,
    restWords: key
      ? `${NOTE_GOT_IT_LABEL} · the note stays on ${key}'s record`
      : `${NOTE_GOT_IT_LABEL} · the note stays saved`,
    closesTask: false,
  };
}

/** A recorded wait age is information, never a deadline. */
export function answerWaitWords(since: number, now: number): string {
  return `Answer ready · waiting ${formatDurationShort(Math.max(0, now - since))}`;
}
