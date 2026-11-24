import { cardActionSchema, cardAuthorSchema, cardPresentation } from "@shared/cards";
import {
  CONVERSATION_PAGE_DEFAULT,
  type ConversationAnswer,
  type ConversationCard,
  type ConversationCursor,
  type ConversationPage,
  type ConversationPageRequest,
  type ConversationRound,
  newerRound,
} from "@shared/conversation";
import { THROUGH_THE_COMMAND } from "@shared/through";
import { z } from "zod";
import { parseDeliveryFacts } from "../orchestrator/answerDelivery";
import { askReceipt, replyOf } from "./askStore";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/**
 * The conversation's paged read (docs/composer.md "The conversation"): the
 * captain's messages (`captain_asks`), their own presses of a card's buttons
 * (`card_observations` rows of kind `action` whose actor is the captain; a
 * body script's choice is the `frame` actor and never counts) and the lines
 * they typed under cards (`card_messages`), merged newest first.
 *
 * A line typed under the first mate's own card is saved twice, as a card
 * line and as a message that names that line (`typed_card_id`,
 * `typed_line`, INF-6115 piece 3): the message draws the round and the
 * line it names is left out. A message saved before that link existed has
 * none, so it and its line both draw.
 *
 * Each record is read by its own time index up to one page past the cursor,
 * and the three are merged here, so no read walks a whole table. A round's
 * id is its record's letter and row number, the number padded to a fixed
 * width, so rounds of the same millisecond order the same way by id here,
 * in SQL, and by row number in each time index, which ends in the row.
 */

/**
 * Before the cursor: `at` earlier, or the same `at` and a smaller id. The
 * bound on `at` alone comes first, so each read seeks its time index.
 */
// i18n-exempt: SQL, never shown to a person
const BEFORE = "at <= ? AND (at < ? OR key < ?)";

// i18n-exempt: SQL, never shown to a person
const ASKS = `SELECT * FROM (
  SELECT 'a:' || printf('%019d', rowid) AS key, rowid AS seq, at, text, reply, delivery_facts, through, typed_card_id, typed_line
  FROM captain_asks) WHERE ${BEFORE} ORDER BY at DESC, seq DESC LIMIT ?`;

// i18n-exempt: SQL, never shown to a person
const ACTIONS = `SELECT * FROM (
  SELECT 'o:' || printf('%019d', seq) AS key, seq, recorded_at AS at, card_id, payload_json FROM card_observations
  WHERE kind = 'action' AND actor = 'captain') WHERE ${BEFORE}
  ORDER BY at DESC, seq DESC LIMIT ?`;

// i18n-exempt: SQL, never shown to a person
const LINES = `SELECT * FROM (
  SELECT 'm:' || printf('%019d', m.id) AS key, m.id AS line, m.at AS at, m.card_id, m.text FROM card_messages AS m
  WHERE m.who = 'captain' AND NOT EXISTS (
    SELECT 1 FROM captain_asks AS a WHERE a.typed_card_id = m.card_id AND a.typed_line = m.id))
  WHERE ${BEFORE} ORDER BY at DESC, line DESC LIMIT ?`;

// i18n-exempt: SQL, never shown to a person
const CARD = `SELECT c.id, c.title, c.author, c.actions_json, c.task_id, t.key AS task_key
  FROM cards AS c LEFT JOIN tasks AS t ON t.id = c.task_id WHERE c.id = ?`;

/**
 * The author's first line after the captain's and before the captain's next
 * one, which has its own answer; the host's own lines are not an answer.
 */
// i18n-exempt: SQL, never shown to a person
const ANSWER = `SELECT who, text, at FROM card_messages AS a
  WHERE a.card_id = ? AND a.id > ? AND a.who IN ('firstmate', 'crewmate')
  AND NOT EXISTS (SELECT 1 FROM card_messages AS c
    WHERE c.card_id = a.card_id AND c.who = 'captain' AND c.id > ? AND c.id < a.id)
  ORDER BY a.id LIMIT 1`;

const ACTIONS_JSON = z.array(cardActionSchema);

type Keyed = { key: string; at: number };
type AskRow = Keyed & {
  text: string;
  reply: string | null;
  delivery_facts: string | null;
  through: string | null;
  typed_card_id: string | null;
  typed_line: number | null;
};
type ActionRow = Keyed & { card_id: string; payload_json: string };
type LineRow = Keyed & { line: number; card_id: string; text: string };
type CardRow = {
  id: string;
  title: string;
  author: string;
  actions_json: string;
  task_id: string | null;
  task_key: string | null;
};

type Pending =
  | { source: "ask"; row: AskRow }
  | { source: "action"; row: ActionRow }
  | { source: "line"; row: LineRow };

export function readConversation(
  db: AppDatabase,
  request: ConversationPageRequest = {},
): ConversationPage {
  const limit = request.limit ?? CONVERSATION_PAGE_DEFAULT;
  const cards = new Map<string, ConversationCard | null>();
  const cardOf = (id: string): ConversationCard | null => {
    if (!cards.has(id)) cards.set(id, cardRef(db, id));
    return cards.get(id) ?? null;
  };
  const rounds: ConversationRound[] = [];
  let before: ConversationCursor | undefined = request.before;
  // A round whose card is gone, or a press of a button the card never
  // declared, draws nothing: read on until the page is full or nothing is left.
  for (;;) {
    const { pending, more } = nextPage(db, before, limit - rounds.length);
    for (const item of pending) {
      const round = roundOf(db, item, cardOf);
      if (round) rounds.push(round);
    }
    const last = pending.at(-1);
    if (!more) return { rounds, more: false };
    if (rounds.length >= limit) return { rounds, more: true };
    if (!last) return { rounds, more: false };
    before = { at: last.row.at, id: last.row.key };
  }
}

/** The next `limit` records past `before`, merged newest first, and whether any remain. */
function nextPage(
  db: AppDatabase,
  before: ConversationCursor | undefined,
  limit: number,
): { pending: Pending[]; more: boolean } {
  const at = before?.at ?? Number.MAX_SAFE_INTEGER;
  const key = before?.id ?? "";
  const args = [at, at, key, limit + 1];
  const all: Pending[] = [
    ...(prepared(db, ASKS).all(...args) as AskRow[]).map((row) => ({
      source: "ask" as const,
      row,
    })),
    ...(prepared(db, ACTIONS).all(...args) as ActionRow[]).map((row) => ({
      source: "action" as const,
      row,
    })),
    ...(prepared(db, LINES).all(...args) as LineRow[]).map((row) => ({
      source: "line" as const,
      row,
    })),
  ];
  all.sort((a, b) => newerRound({ at: a.row.at, id: a.row.key }, { at: b.row.at, id: b.row.key }));
  return { pending: all.slice(0, limit), more: all.length > limit };
}

function roundOf(
  db: AppDatabase,
  item: Pending,
  cardOf: (id: string) => ConversationCard | null,
): ConversationRound | undefined {
  const { key: id, at } = item.row;
  if (item.source === "ask") {
    const row = item.row;
    const you = askReceipt({
      text: row.text,
      deliveryFacts: parseDeliveryFacts(row.delivery_facts),
    });
    const reply = replyOf(row.reply);
    const card = row.typed_card_id ? cardOf(row.typed_card_id) : null;
    if (card && row.typed_card_id && row.typed_line !== null) {
      return {
        id,
        at,
        kind: "reply",
        card,
        you,
        answer: answerOf(db, row.typed_card_id, row.typed_line),
        reply,
      };
    }
    return {
      id,
      at,
      kind: "message",
      you,
      reply,
      ...(row.through === THROUGH_THE_COMMAND ? { through: THROUGH_THE_COMMAND } : {}),
    };
  }
  const card = cardOf(item.row.card_id);
  if (!card) return undefined;
  if (item.source === "line") {
    const row = item.row;
    return {
      id,
      at,
      kind: "reply",
      card,
      you: row.text,
      answer: answerOf(db, row.card_id, row.line),
    };
  }
  const label = labelOf(item.row.payload_json);
  return label === undefined ? undefined : { id, at, kind: "choice", card, label };
}

/** The button's words, from an action the card declared. */
function labelOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { recognized?: unknown; label?: unknown };
    if (parsed.recognized !== true) return undefined;
    return typeof parsed.label === "string" ? parsed.label : undefined;
  } catch {
    return undefined;
  }
}

function answerOf(db: AppDatabase, cardId: string, line: number): ConversationAnswer | null {
  const row = prepared(db, ANSWER).get(cardId, line, line) as ConversationAnswer | undefined;
  return row ? { who: row.who, text: row.text, at: row.at } : null;
}

function cardRef(db: AppDatabase, id: string): ConversationCard | null {
  const row = prepared(db, CARD).get(id) as CardRow | undefined;
  if (!row) return null;
  let actions: z.infer<typeof ACTIONS_JSON> = [];
  try {
    actions = ACTIONS_JSON.parse(JSON.parse(row.actions_json));
  } catch {
    // An unreadable list reads as a card with no buttons: a note.
  }
  const author = cardAuthorSchema.safeParse(row.author);
  return {
    id: row.id,
    title: row.title,
    presentation: cardPresentation({ author: author.success ? author.data : "crewmate", actions }),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.task_key ? { taskKey: row.task_key } : {}),
  };
}
