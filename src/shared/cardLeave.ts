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
  restOnTask?: (key: string) => string;
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
  note: {
    icon: "minus",
    label: "Put aside",
    restWords: "Put aside · the note stays saved",
    restOnTask: (key: string) => `Put aside · the note stays on ${key}'s record`,
    operation: "read",
  },
  attention: aside,
  record: hide,
  "window-panel": { ...hide, restWords: "Hide · the view stays available" },
} as const satisfies Record<CardLeaveKind, LeaveRow>;

/** A reply awaiting its author stays aside, including when its card is a note. */
export function cardLeaveOperation(
  kind: CardLeaveKind,
  pendingReply = false,
): LeaveRow["operation"] {
  return pendingReply ? "aside" : CARD_LEAVE[kind].operation;
}

/** Only the core supplies live words; the window's own panels read their row directly. */
export function cardCornerOf(
  kind: CardLeaveKind,
  key?: string,
  pendingReply = false,
): CardCornerWords {
  const row: LeaveRow = CARD_LEAVE[kind];
  return {
    icon: row.icon,
    label: row.label,
    restWords: key && row.restOnTask ? row.restOnTask(key) : row.restWords,
    operation: cardLeaveOperation(kind, pendingReply),
  };
}
export const ANSWER_DONE_LABEL = "Done";
export function answerDoneRest(key: string): string {
  return `${ANSWER_DONE_LABEL} · closes ${key} as answered; the answer stays on its record`;
}

/** A recorded wait age is information, never a deadline. */
export function answerWaitWords(since: number, now: number): string {
  return `Answer ready · waiting ${formatDurationShort(Math.max(0, now - since))}`;
}
