import { type AttachmentRef, attachmentRefSchema } from "@shared/attachments";
import { type LastTurn, type LastTurnReply, lastTurnReplySchema } from "@shared/lastTurn";
import {
  type AskDelivery,
  type DeliveryFacts,
  parseDeliveryFacts,
} from "../orchestrator/answerDelivery";
import type { AppDatabase } from "./db";

/**
 * The capture table (task-system design section 4.5, P1): one row per
 * captain turn, opened BEFORE the Firstmate turn runs and attached to a task
 * by the agent's own tool calls - or, failing that, by the host at turn end.
 * The invariant every ask carries once its turn closes: `taskId` is never
 * null (captain requirement 1, decision D1: attach to the work it is about
 * by default; a task of its own only when genuinely standalone).
 *
 * Raw SQL over the row shape only; every write goes through
 * `src/core/tasks/taskService.ts`, which pairs an attachment with the `ask`
 * event on the task in one transaction.
 */

/**
 * How an ask reached its task. `tool:<name>` is the agent's own attribution
 * (the quality signal); `host:fallback` is the floor the host guarantees.
 * The share of fallbacks is the attribution-quality metric to watch.
 */
export type AskAttachedVia = `tool:${string}` | "host:fallback";

export type AskTurnState = "open" | "closed" | "failed";

export type AskImage = { mimeType: string };

export type AskRecord = {
  /** The turn id. */
  id: string;
  at: number;
  text: string;
  /** Attachment shapes only - never the bytes. */
  images: AskImage[];
  /**
   * The message's own copies of those pictures (`src/core/attachments.ts`),
   * in order: references only, never the bytes. Empty for a message an
   * older build saved, which kept the shapes alone.
   */
  attachments: AttachmentRef[];
  /** The task the open card or the panel pointed at when the turn began. */
  hintTaskId: string | null;
  /** The first task the ask attached to (further attachments are `ask` events). */
  taskId: string | null;
  attachedVia: AskAttachedVia | null;
  attachedAt: number | null;
  turnState: AskTurnState;
  /** Where the answer-delivery check has this message (`AskDelivery`). */
  delivery: AskDelivery;
  /** What took effect, and what was refused, after Firstmate read it. */
  deliveryFacts: DeliveryFacts;
  /** The one notice card raised for it, once it had no answer after its retry. */
  noticeCardId: string | null;
};

type Row = {
  id: string;
  at: number;
  text: string;
  images_json: string | null;
  hint_task_id: string | null;
  task_id: string | null;
  attached_via: string | null;
  attached_at: number | null;
  turn_state: AskTurnState;
  delivery: AskDelivery;
  delivery_facts: string | null;
  notice_card_id: string | null;
  reply: string | null;
};

/** The saved reply line back to its shape; anything unreadable is no reply, never a throw. */
function replyOf(json: string | null): LastTurnReply | null {
  if (!json) return null;
  try {
    const parsed = lastTurnReplySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The column holds one entry per picture: the copy's reference, or - from
 * an older build - its shape alone. Shapes are read from either.
 */
function picturesOf(json: string | null): { images: AskImage[]; attachments: AttachmentRef[] } {
  if (!json) return { images: [], attachments: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { images: [], attachments: [] };
  }
  if (!Array.isArray(parsed)) return { images: [], attachments: [] };
  const images: AskImage[] = parsed
    .filter((entry): entry is AskImage => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as AskImage).mimeType === "string"
      );
    })
    .map((entry) => ({ mimeType: entry.mimeType }));
  const attachments = parsed.flatMap((entry) => {
    const ref = attachmentRefSchema.safeParse(entry);
    return ref.success ? [ref.data] : [];
  });
  return { images, attachments };
}

function fromRow(row: Row): AskRecord {
  const { images, attachments } = picturesOf(row.images_json);
  return {
    id: row.id,
    at: row.at,
    text: row.text,
    images,
    attachments,
    hintTaskId: row.hint_task_id,
    taskId: row.task_id,
    attachedVia: row.attached_via as AskAttachedVia | null,
    attachedAt: row.attached_at,
    turnState: row.turn_state,
    delivery: row.delivery,
    deliveryFacts: parseDeliveryFacts(row.delivery_facts),
    noticeCardId: row.notice_card_id,
  };
}

export class AskStore {
  constructor(private readonly db: AppDatabase) {}

  insert(ask: AskRecord): void {
    this.db
      .prepare(
        `INSERT INTO captain_asks (id, at, text, images_json, hint_task_id, task_id, attached_via, attached_at, turn_state, delivery, delivery_facts, notice_card_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ask.id,
        ask.at,
        ask.text,
        ask.attachments.length > 0
          ? JSON.stringify(ask.attachments)
          : ask.images.length > 0
            ? JSON.stringify(ask.images)
            : null,
        ask.hintTaskId,
        ask.taskId,
        ask.attachedVia,
        ask.attachedAt,
        ask.turnState,
        ask.delivery,
        ask.deliveryFacts.entries.length > 0 || ask.deliveryFacts.retryOf
          ? JSON.stringify(ask.deliveryFacts)
          : null,
        ask.noticeCardId,
      );
  }

  get(id: string): AskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM captain_asks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Record the FIRST attachment; later attachments leave the columns alone
   * (the task's `ask` events carry every one). Returns whether this call
   * was the first.
   */
  attach(id: string, taskId: string, via: AskAttachedVia, at: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE captain_asks SET task_id = ?, attached_via = ?, attached_at = ? WHERE id = ? AND task_id IS NULL",
      )
      .run(taskId, via, at, id);
    return result.changes > 0;
  }

  setTurnState(id: string, turnState: AskTurnState): void {
    this.db.prepare("UPDATE captain_asks SET turn_state = ? WHERE id = ?").run(turnState, id);
  }

  /** The answer-delivery check's state and facts for one message. */
  setDelivery(id: string, delivery: AskDelivery, facts?: DeliveryFacts): void {
    if (facts === undefined) {
      this.db.prepare("UPDATE captain_asks SET delivery = ? WHERE id = ?").run(delivery, id);
      return;
    }
    this.db
      .prepare("UPDATE captain_asks SET delivery = ?, delivery_facts = ? WHERE id = ?")
      .run(delivery, facts.entries.length > 0 || facts.retryOf ? JSON.stringify(facts) : null, id);
  }

  setNoticeCard(id: string, cardId: string): void {
    this.db.prepare("UPDATE captain_asks SET notice_card_id = ? WHERE id = ?").run(cardId, id);
  }

  /** The Firstmate's reply line beside the message (docs/composer.md "The last turn"). */
  setReply(id: string, reply: LastTurnReply): void {
    this.db
      .prepare("UPDATE captain_asks SET reply = ? WHERE id = ?")
      .run(JSON.stringify(reply), id);
  }

  /** The newest message's id, or undefined before the first. */
  latestId(): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM captain_asks ORDER BY at DESC, rowid DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id;
  }

  /** The newest message and its reply line: the last turn above the input. */
  lastTurn(): LastTurn | null {
    const row = this.db
      .prepare("SELECT text, reply FROM captain_asks ORDER BY at DESC, rowid DESC LIMIT 1")
      .get() as Pick<Row, "text" | "reply"> | undefined;
    return row ? { you: row.text, reply: replyOf(row.reply) } : null;
  }

  /** Asks whose turn has not closed yet, oldest first. */
  listOpen(): AskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM captain_asks WHERE turn_state = 'open' ORDER BY at, rowid")
      .all() as Row[];
    return rows.map(fromRow);
  }

  /** The messages the answer-delivery check holds in one state, oldest first. */
  listByDelivery(delivery: AskDelivery): AskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM captain_asks WHERE delivery = ? ORDER BY at, rowid")
      .all(delivery) as Row[];
    return rows.map(fromRow);
  }

  /** The asks that first attached to a task, oldest first. */
  listFor(taskId: string): AskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM captain_asks WHERE task_id = ? ORDER BY at, rowid")
      .all(taskId) as Row[];
    return rows.map(fromRow);
  }

  /** Every ask, oldest first (tests and the offline scripts). */
  list(): AskRecord[] {
    const rows = this.db.prepare("SELECT * FROM captain_asks ORDER BY at, rowid").all() as Row[];
    return rows.map(fromRow);
  }

  deleteAll(): void {
    this.db.prepare("DELETE FROM captain_asks").run();
  }
}
