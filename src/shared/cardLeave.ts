import { z } from "zod";
import type { CardPresentation } from "./cards";
import * as m from "./i18n/messages.generated.ts";
import { formatDurationShort } from "./quotaSignals.ts";

/**
 * The ids that were the close control while every card had a ×. The 0.6.4
 * upgrade dropped them; `restoreCloseControls` puts them back as replies
 * (INF-3108), and the recorded corpora read an old click on one as a close.
 */
export const LEGACY_CLOSE_CONTROL_IDS: ReadonlySet<string> = new Set(["later", "keep", "dismiss"]);

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
  get label() {
    return m.cardLeaveAside();
  },
  get restWords() {
    return m.cardLeaveAsideRest();
  },
  operation: "aside",
} as const;
const hide = {
  icon: "minus",
  get label() {
    return m.cardLeaveHide();
  },
  get restWords() {
    return m.cardLeaveHideRest();
  },
  operation: "hide",
} as const;
export const CARD_LEAVE = {
  decision: aside,
  // INF-2794: the minus only ever puts a card aside; a note ends on its own button.
  note: aside,
  attention: aside,
  record: hide,
  "window-panel": {
    icon: "minus",
    get label() {
      return m.cardLeaveHide();
    },
    get restWords() {
      return m.cardLeaveHidePanelRest();
    },
    operation: "hide",
  },
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
export const ANSWER_DONE_LABEL = m.cardAnswerDone();
export function answerDoneRest(key: string): string {
  return m.cardAnswerDoneRest({ key });
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

/**
 * The app's own way to say no on a decision (INF-3108): the captain's
 * answer "no to every choice", pressed like any choice and recorded under
 * this id, so its author goes on without those choices. The core adds it
 * (`withAppDecline`); no author declares it.
 */
export const DECLINE_ACTION_ID = "app-decline";
export const DECLINE_LABEL = m.cardDecline();

/** A recorded wait age is information, never a deadline. */
export function answerWaitWords(since: number, now: number): string {
  return `Answer ready · waiting ${formatDurationShort(Math.max(0, now - since))}`;
}
