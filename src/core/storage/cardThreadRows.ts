import { replyWithSettings } from "@shared/cardAnswerLines";
import { cardNotesSchema } from "@shared/cardNotes";
import {
  type CardAnswer,
  type CardMessage,
  type CardMessageWho,
  cardAnswersSchema,
  cardContributorSchema,
  cardRevisionSchema,
} from "@shared/cards";
import { THROUGH_THE_COMMAND } from "@shared/through";

/**
 * A thread row with the payload of the `message_ref` observation written
 * with it in one transaction, whose `answers` are the settings a captain's
 * reply carried.
 */
export type MessageRow = {
  id: number;
  card_id: string;
  who: CardMessageWho;
  text: string;
  at: number;
  ref_json: string | null;
  notes_json: string | null;
  revision_json: string | null;
  contributor_json: string | null;
  answers_message: number | null;
  clarification: number | null;
  through: string | null;
};

export const MESSAGE_COLUMNS = `m.notes_json, m.id, m.card_id, m.who, m.text, m.at, m.revision_json,
  m.contributor_json, m.answers_message, m.clarification, m.through,
  (SELECT o.payload_json FROM card_observations o
    WHERE o.card_id = m.card_id AND o.kind = 'message_ref' AND o.message_id = m.id
    ORDER BY o.seq LIMIT 1) AS ref_json`;

export function messageOf(row: MessageRow): CardMessage {
  const message: CardMessage = {
    id: row.id,
    cardId: row.card_id,
    who: row.who,
    text: row.text,
    at: row.at,
  };
  if (row.contributor_json) {
    try {
      const contributor = cardContributorSchema.safeParse(JSON.parse(row.contributor_json));
      if (contributor.success) message.contributor = contributor.data;
    } catch {
      /* An unreadable identity stays unknown, never guessed. */
    }
  }
  if (row.answers_message !== null) message.answersMessage = row.answers_message;
  if (row.clarification === 1) message.clarification = true;
  if (row.who === "captain" && row.through === THROUGH_THE_COMMAND)
    message.through = THROUGH_THE_COMMAND;
  if (row.who === "host" && row.revision_json) {
    try {
      const revision = cardRevisionSchema.safeParse(JSON.parse(row.revision_json));
      if (revision.success) message.revision = revision.data;
    } catch {
      /* An unreadable association never becomes guessed links. */
    }
  }
  if (row.notes_json) {
    try {
      const notes = cardNotesSchema.safeParse(JSON.parse(row.notes_json));
      if (notes.success) message.notes = notes.data;
    } catch {
      /* An unreadable note never removes the rest of the thread. */
    }
  }
  if (row.who !== "captain" || row.ref_json === null) return message;
  let ref: unknown;
  try {
    ref = JSON.parse(row.ref_json);
  } catch {
    return message;
  }
  const parsed = cardAnswersSchema.safeParse((ref as { answers?: unknown } | null)?.answers);
  if (!parsed.success || parsed.data.length === 0) return message;
  const words = wordsWithoutSettings(row.text, parsed.data);
  return words === undefined ? message : { ...message, text: words, answers: parsed.data };
}

/**
 * A captain's reply is saved as its author read it: his words, then the
 * settings the card sent with them (`replyWithSettings`), then the app's
 * picture line when pictures rode along. The thread shows the settings
 * apart (FI3-617), so they come off only where the text holds exactly the
 * app's own rendering of the answers recorded with that reply. Anything
 * else is shown whole, never cut on a guess, and carries no `answers`.
 */
function wordsWithoutSettings(text: string, answers: readonly CardAnswer[]): string | undefined {
  const settings = replyWithSettings("", answers);
  if (text.endsWith(settings)) return text.slice(0, -settings.length);
  const at = text.lastIndexOf(`${settings}\n[attached `);
  const pictures = at < 0 ? "" : text.slice(at + settings.length + 1);
  if (!pictures || pictures.includes("\n") || !pictures.endsWith("]")) return undefined;
  const words = text.slice(0, at);
  return words ? `${words}\n${pictures}` : pictures;
}
