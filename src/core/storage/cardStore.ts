import { randomUUID } from "node:crypto";
import { replyWithSettings } from "@shared/cardAnswerLines";
import { type CardFile, cardFileSchema } from "@shared/cardFiles";
import { type CardNote, cardNotesSchema } from "@shared/cardNotes";
import { cardReadsSchema, cardViewsSchema } from "@shared/cardReads";
import {
  CARD_CAPTURE_VERSION,
  type Card,
  type CardAnswer,
  type CardContributor,
  type CardMessage,
  type CardMessageWho,
  type CardObservation,
  type CardObservationActor,
  type CardObservationKind,
  type CardObservationPayload,
  type CardObservationSource,
  type CardRevisionLinks,
  cardAnswersSchema,
  cardContributorSchema,
  cardObservationPayloadSchemas,
  cardOfferPayloadSchema,
  cardRevisionSchema,
  cardSchema,
  cardWord,
  type LiveAttachment,
  liveAttachmentSchema,
  mergeEffectOf,
  oneMergeEffect,
  type PastCard,
  type PastEnding,
} from "@shared/cards";
import { cardWrittenText } from "@shared/cardWrittenText";
import { type CardEnded, cardEndedSchema } from "@shared/endedCard";
import { isFeedbackRequest } from "@shared/feedback";
import { inLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { heldMerges } from "@shared/mergeHeld";
import { pastCardEndingWords } from "@shared/pastCard";
import { type KeptPutOff, keptPutOffSchema } from "@shared/putOff";
import { type RiskAssessment, riskAssessmentSchema } from "@shared/risk";
import type { TaskCardRow } from "@shared/tasks";
import { THROUGH_THE_COMMAND, type Through } from "@shared/through";
import { z } from "zod";
import { throughNow } from "../askedFromTheCommand";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/**
 * Persisted cards (decision D-9): unresolved cards survive a restart and
 * reappear in the stack; resolving keeps the chosen action on the row.
 * A task's cards die with the task (decision D-13).
 *
 * Two interaction P1 additions ride the same rows: a card revised in place
 * keeps its history in `card_revisions` (WI-12, migration 24), and the
 * captain's confirmed duplicate label lives on `cards` (WI-14, migration 25).
 *
 * One card shape since cards/tasks/agents P1 (migration 29): the `kind`
 * columns stay for the schema's sake and every new row writes `card`; what
 * a card is comes from its actions and its `author`, never from the column.
 */

/** What the `kind` columns say since P1: the column is kept, the value is not a kind. */
const ONE_CARD_KIND = "card";

type Row = {
  id: string;
  task_id: string | null;
  review_task_id: string | null;
  kind: string;
  author: Card["author"];
  priority: number;
  title: string;
  meta: string;
  model: string | null;
  place: string | null;
  body: string;
  actions_json: string;
  status: Card["status"];
  created_at: number;
  resolved_at: number | null;
  duplicate_of: string | null;
  duplicate_note: string | null;
  duplicate_at: number | null;
  pictures_json: string | null;
  awaiting: string | null;
  sent_back_at: number | null;
  width: string | null;
  lifecycle_id: string | null;
  offer_id: string | null;
  attachment_json: string | null;
  files_json: string | null;
  live_reads_json: string | null;
  risk_json: string | null;
  replies: number | null;
  holds_place: number | null;
  continues: number | null;
  answering: number | null;
  answered_by: string | null;
  minimized: number | null;
  required_actions_json: string | null;
  after_merge_json: string | null;
  ended_json: string | null;
  put_off_json?: string | null;
};

/** One superseded version of a card revised in place (WI-12). */
export type CardRevision = {
  cardId: string;
  revision: number;
  title: string;
  body: string;
  actions: Card["actions"];
  createdAt: number;
  replacedAt: number;
  replacedBy: string;
};

/** Every outcome of flagging a duplicate; refusals are values, never throws. */
export type DuplicateResult =
  | { status: "flagged"; card: DuplicateCardRef; original: DuplicateCardRef; at: number }
  | { status: "same-card"; cardId: string }
  | { status: "no-card"; cardId: string }
  | { status: "no-original"; cardId: string }
  | { status: "already-flagged"; card: DuplicateCardRef; duplicateOf: string; note: string };

export type DuplicateCardRef = { id: string; title: string; resolved: boolean };

/** One card's thread, counted, with its newest message (the context section). */
export type ThreadSummary = { cardId: string; count: number; last: CardMessage };

/**
 * A resolved card and the action that resolved it (`close` is a dismissal),
 * with the captain's answers to the body's own questions when the click
 * carried any (`cards.answers_json`, migration 54).
 */
export type CardResolution = {
  card: Card;
  action: string;
  resolvedAt: number;
  answers?: CardAnswer[];
  /** Exact offer dispatched at the closing interaction, when capture exists. */
  offer?: CardObservationPayload<"offer">;
  /** The choice came from the captain's own command, `infinitary-axi`, not the window. */
  through?: Through;
};

const ACTION_OBSERVATIONS =
  "SELECT * FROM card_observations WHERE card_id = ? AND kind = 'action' ORDER BY seq";

const OFFER_OBSERVATION =
  "SELECT * FROM card_observations WHERE id = ? AND card_id = ? AND kind = 'offer'";

/**
 * The action observation that closed a resolution, among a card's action
 * observations. CardService commits the row resolution first, then its
 * action observation; earlier observations belong to a previous
 * resolution, not this offer.
 */
function closingAction(
  rows: readonly ObservationRow[],
  chosenAction: string,
  resolvedAt: number,
): CardObservation | undefined {
  return rows
    .flatMap((row) => observationOf(row) ?? [])
    .findLast(
      (entry) =>
        entry.kind === "action" &&
        entry.payload.closes &&
        entry.payload.actionId === chosenAction &&
        entry.recordedAt >= resolvedAt,
    );
}

/**
 * A resolution without the card's words: its effective actions are the
 * closing offer's when one was captured, else the card's own
 * (`CardStore.resolutionHeadsSince`).
 */
export type ResolutionHead = {
  cardId: string;
  taskId?: string;
  action: string;
  resolvedAt: number;
  actions: Card["actions"];
};

type ResolvedRow = Row & {
  chosen_action: string;
  resolved_at: number;
  answers_json: string | null;
  resolved_through: string | null;
};

/**
 * A row's live attachment, read on its own: one that no longer reads as an
 * attachment is left off its card rather than taking the card with it.
 */
function attachmentOf(row: Row): LiveAttachment | undefined {
  if (!row.attachment_json) return undefined;
  try {
    const parsed = liveAttachmentSchema.safeParse(JSON.parse(row.attachment_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A row's files for the captain, read on their own like its attachment:
 * ones that no longer read are left off the card rather than taking it along.
 */
function filesOf(row: Row): CardFile[] | undefined {
  if (!row.files_json) return undefined;
  try {
    const parsed = z.array(cardFileSchema).min(1).safeParse(JSON.parse(row.files_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A row's risk assessment, read on its own like its attachment: one that no
 * longer reads is left off its card rather than taking the card with it.
 */
function riskOf(row: Row): RiskAssessment | undefined {
  if (!row.risk_json) return undefined;
  try {
    const parsed = riskAssessmentSchema.safeParse(JSON.parse(row.risk_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A row's live reads and views, read on their own like its attachment: a
 * value that no longer reads is left off its card rather than taking the
 * card with it, and the card draws without live data.
 */
function liveReadsOf(row: Row): Pick<Card, "reads" | "sql"> {
  if (!row.live_reads_json) return {};
  try {
    const parsed = z
      .object({ reads: cardReadsSchema.optional(), sql: cardViewsSchema.optional() })
      .safeParse(JSON.parse(row.live_reads_json));
    if (!parsed.success) return {};
    const { reads, sql } = parsed.data;
    return { ...(reads?.length ? { reads } : {}), ...(sql?.length ? { sql } : {}) };
  } catch {
    return {};
  }
}

function fromRow(row: Row): Card | undefined {
  const attachment = attachmentOf(row);
  const files = filesOf(row);
  const risk = riskOf(row);
  const parsed = cardSchema.safeParse({
    id: row.id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.review_task_id ? { reviewTaskId: row.review_task_id } : {}),
    author: row.author,
    priority: row.priority,
    title: row.title,
    meta: row.meta,
    ...(row.model ? { model: row.model } : {}),
    ...(row.place ? { place: row.place } : {}),
    body: row.body,
    actions: oneMergeEffect(JSON.parse(row.actions_json)),
    status: row.status,
    createdAt: row.created_at,
    ...(row.pictures_json ? { pictures: JSON.parse(row.pictures_json) } : {}),
    ...(files ? { files } : {}),
    ...(row.awaiting ? { awaiting: row.awaiting } : {}),
    ...(row.sent_back_at !== null ? { sentBackAt: row.sent_back_at } : {}),
    ...(row.width ? { width: row.width } : {}),
    ...(attachment ? { attachment } : {}),
    ...liveReadsOf(row),
    ...(risk ? { risk } : {}),
    ...(row.required_actions_json
      ? { requiredActions: JSON.parse(row.required_actions_json) }
      : {}),
    ...(row.after_merge_json ? { afterMerge: JSON.parse(row.after_merge_json) } : {}),
    ...(row.replies === 0 ? { replies: false } : {}),
    ...(row.holds_place === 1 ? { holdsPlace: true } : {}),
    ...(row.continues === 1 ? { continues: true } : {}),
    ...(row.answering === 1 ? { answering: true } : {}),
    ...(row.answered_by === "firstmate" ? { answeredBy: "firstmate" as const } : {}),
    ...(row.minimized === 1 ? { minimized: true } : {}),
    ...(row.lifecycle_id ? { lifecycleId: row.lifecycle_id } : {}),
    ...(row.offer_id ? { offerId: row.offer_id } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function isMergeDecision(actions: Card["actions"]): boolean {
  return actions.some((action) => mergeEffectOf(action) !== undefined);
}

type ObservationRow = {
  seq: number;
  id: string;
  card_id: string;
  lifecycle_id: string;
  task_id: string | null;
  kind: CardObservationKind;
  schema_version: number;
  capture_version: number;
  recorded_at: number;
  actor: CardObservationActor;
  source: CardObservationSource;
  offer_id: string | null;
  interaction_id: string | null;
  message_id: number | null;
  build: string | null;
  payload_json: string;
};

function observationOf(row: ObservationRow): CardObservation | undefined {
  const schema = cardObservationPayloadSchemas[row.kind];
  if (!schema) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  const payload = schema.safeParse(raw);
  if (!payload.success) return undefined;
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    cardId: row.card_id,
    lifecycleId: row.lifecycle_id,
    taskId: row.task_id,
    schemaVersion: row.schema_version,
    captureVersion: row.capture_version,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    offerId: row.offer_id,
    interactionId: row.interaction_id,
    messageId: row.message_id,
    build: row.build,
    payload: payload.data,
  } as CardObservation;
}

/**
 * A thread row with the payload of the `message_ref` observation written
 * with it in one transaction, whose `answers` are the settings a captain's
 * reply carried.
 */
type MessageRow = {
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

const MESSAGE_COLUMNS = `m.notes_json, m.id, m.card_id, m.who, m.text, m.at, m.revision_json,
  m.contributor_json, m.answers_message, m.clarification, m.through,
  (SELECT o.payload_json FROM card_observations o
    WHERE o.card_id = m.card_id AND o.kind = 'message_ref' AND o.message_id = m.id
    ORDER BY o.seq LIMIT 1) AS ref_json`;

function messageOf(row: MessageRow): CardMessage {
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

function refOf(row: Row): DuplicateCardRef {
  return { id: row.id, title: row.title, resolved: row.resolved_at !== null };
}

/** One sighting receipt per globally unique release observation, sought by its primary key. */
export function updateSightingId(updateId: string): string {
  return `seen-update:${updateId}`;
}

export type CaptainCardInput = {
  sourceId: string;
  kind: "card-message" | "card-choice";
  cardId: string;
  lifecycleId: string;
  taskId: string | null;
  at: number;
  text: string;
  /** Only a verified displayed offer, never a guessed mutable head. */
  offerId?: string;
  /** Inclusive thread cursor frozen before this input. */
  precedingMessageId: number;
  contextMissing: boolean;
};

export class CardStore {
  private readonly captainListeners = new Set<(observation: string) => void>();
  constructor(private readonly db: AppDatabase) {}

  /** Factual new-input notification inside the enclosing write, not a history scan. */
  onCaptainInteraction(listener: (observation: string) => void): () => void {
    this.captainListeners.add(listener);
    return () => this.captainListeners.delete(listener);
  }

  upsert(card: Card): void {
    this.db
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, model, place, body, actions_json, status, created_at, pictures_json, awaiting, sent_back_at, width, lifecycle_id, offer_id, attachment_json, risk_json, replies, holds_place, required_actions_json, review_task_id, minimized, continues, answering, answered_by, after_merge_json, files_json, live_reads_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           author = excluded.author,
           priority = excluded.priority,
           title = excluded.title,
           meta = excluded.meta,
           model = excluded.model,
           place = excluded.place,
           body = excluded.body,
           actions_json = excluded.actions_json,
           status = excluded.status,
           created_at = excluded.created_at,
           pictures_json = excluded.pictures_json,
           awaiting = excluded.awaiting,
           sent_back_at = excluded.sent_back_at,
           width = excluded.width,
           lifecycle_id = COALESCE(excluded.lifecycle_id, cards.lifecycle_id),
           offer_id = COALESCE(excluded.offer_id, cards.offer_id),
           attachment_json = excluded.attachment_json,
           risk_json = excluded.risk_json,
           replies = excluded.replies,
           holds_place = excluded.holds_place,
           required_actions_json = excluded.required_actions_json,
           review_task_id = excluded.review_task_id,
           minimized = excluded.minimized,
           continues = excluded.continues,
           answering = excluded.answering,
           answered_by = excluded.answered_by,
           after_merge_json = excluded.after_merge_json,
           files_json = excluded.files_json,
           live_reads_json = excluded.live_reads_json`,
      )
      .run(
        card.id,
        card.taskId ?? null,
        ONE_CARD_KIND,
        card.author,
        card.priority,
        card.title,
        card.meta,
        card.model ?? null,
        card.place ?? null,
        card.body,
        JSON.stringify(card.actions),
        card.status,
        card.createdAt,
        card.pictures?.length ? JSON.stringify(card.pictures) : null,
        card.awaiting ?? null,
        card.sentBackAt ?? null,
        card.width ?? null,
        card.lifecycleId ?? null,
        card.offerId ?? null,
        card.attachment ? JSON.stringify(card.attachment) : null,
        card.risk ? JSON.stringify(card.risk) : null,
        card.replies === false ? 0 : null,
        card.holdsPlace ? 1 : null,
        card.requiredActions !== undefined ? JSON.stringify(card.requiredActions) : null,
        card.reviewTaskId ?? null,
        card.minimized ? 1 : null,
        card.continues ? 1 : null,
        card.answering ? 1 : null,
        card.answeredBy ?? null,
        card.afterMerge?.length ? JSON.stringify(card.afterMerge) : null,
        card.files?.length ? JSON.stringify(card.files) : null,
        card.reads?.length || card.sql?.length
          ? JSON.stringify({
              ...(card.reads?.length ? { reads: card.reads } : {}),
              ...(card.sql?.length ? { sql: card.sql } : {}),
            })
          : null,
      );
  }

  /**
   * An emitter revising its open card under the same id (WI-12): the
   * version it replaces is kept as a revision in the same transaction, so a
   * revision is one card with history rather than a second card. A write
   * that changes nothing an emitter authored records no revision.
   */
  revise(card: Card): void {
    this.db.transaction(() => {
      const previous = this.row(card.id);
      const actionsJson = JSON.stringify(card.actions);
      if (
        previous &&
        previous.resolved_at === null &&
        (previous.title !== card.title ||
          previous.body !== card.body ||
          previous.actions_json !== actionsJson)
      ) {
        const next = this.db
          .prepare(
            "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM card_revisions WHERE card_id = ?",
          )
          .get(card.id) as { next: number };
        this.db
          .prepare(
            `INSERT INTO card_revisions
               (card_id, revision, kind, title, body, actions_json, created_at, replaced_at, replaced_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            previous.id,
            next.next,
            ONE_CARD_KIND,
            previous.title,
            previous.body,
            previous.actions_json,
            previous.created_at,
            Date.now(),
            card.id,
          );
      }
      this.upsert(card);
    })();
  }

  history(cardId: string): CardRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM card_revisions WHERE card_id = ? ORDER BY revision")
      .all(cardId) as {
      card_id: string;
      revision: number;
      kind: string;
      title: string;
      body: string;
      actions_json: string;
      created_at: number;
      replaced_at: number;
      replaced_by: string;
    }[];
    return rows.map((row) => ({
      cardId: row.card_id,
      revision: row.revision,
      title: row.title,
      body: row.body,
      actions: oneMergeEffect(JSON.parse(row.actions_json)),
      createdAt: row.created_at,
      replacedAt: row.replaced_at,
      replacedBy: row.replaced_by,
    }));
  }

  /** Includes resolved cards: cleanup never turns existing history into a new profile. */
  hasHistory(): boolean {
    return this.db.prepare("SELECT 1 FROM cards LIMIT 1").get() !== undefined;
  }

  /** Unresolved cards, restored into the stack on boot. */
  listOpen(): Card[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE resolved_at IS NULL ORDER BY created_at")
      .all() as Row[];
    return rows.flatMap((row) => {
      const card = fromRow(row);
      return card ? [card] : [];
    });
  }

  /**
   * A withdrawn card the stack keeps drawing, ended, until the captain
   * closes it (INF-3071), with how it ended; `undefined` clears it.
   */
  markEnded(cardId: string, ended: CardEnded | undefined): void {
    this.db
      .prepare("UPDATE cards SET ended_json = ? WHERE id = ?")
      .run(ended ? JSON.stringify(ended) : null, cardId);
  }

  /**
   * The put-off a captain's click left on a closed card (INF-3846 piece 3),
   * kept until the card is raised again; `undefined` clears it.
   */
  keepPutOff(cardId: string, putOff: KeptPutOff | undefined): void {
    prepared(this.db, "UPDATE cards SET put_off_json = ? WHERE id = ?").run(
      putOff ? JSON.stringify(putOff) : null,
      cardId,
    );
  }

  putOffOf(cardId: string): KeptPutOff | undefined {
    const row = prepared(this.db, "SELECT put_off_json FROM cards WHERE id = ?").get(cardId) as
      | { put_off_json: string | null }
      | undefined;
    if (!row?.put_off_json) return undefined;
    try {
      const parsed = keptPutOffSchema.safeParse(JSON.parse(row.put_off_json));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every closed card with a kept put-off, oldest first, as `PutOffs` reads them by task. */
  listPutOff(): { card: Card; putOff: KeptPutOff }[] {
    const rows = prepared(
      this.db,
      "SELECT * FROM cards WHERE put_off_json IS NOT NULL ORDER BY created_at",
    ).all() as Row[];
    return rows.flatMap((row) => {
      if (row.resolved_at === null) return [];
      const card = fromRow(row);
      let putOff: KeptPutOff | undefined;
      try {
        const parsed = keptPutOffSchema.safeParse(JSON.parse(row.put_off_json ?? "null"));
        putOff = parsed.success ? parsed.data : undefined;
      } catch {
        putOff = undefined;
      }
      return card && putOff ? [{ card, putOff }] : [];
    });
  }

  /** The resolved cards the stack still draws, ended, restored on boot. */
  listEnded(): { card: Card; ended: CardEnded }[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE ended_json IS NOT NULL ORDER BY created_at")
      .all() as Row[];
    return rows.flatMap((row) => {
      if (row.resolved_at === null) return [];
      const card = fromRow(row);
      let ended: CardEnded | undefined;
      try {
        const parsed = cardEndedSchema.safeParse(JSON.parse(row.ended_json ?? "null"));
        ended = parsed.success ? parsed.data : undefined;
      } catch {
        ended = undefined;
      }
      return card && ended ? [{ card, ended }] : [];
    });
  }

  /** The choice that closes a card; one the captain's command made is marked so (`throughNow`). */
  resolve(cardId: string, chosenAction: string, answers?: readonly CardAnswer[]): void {
    this.db
      .prepare(
        "UPDATE cards SET resolved_at = ?, chosen_action = ?, answers_json = ?, resolved_through = ? WHERE id = ?",
      )
      .run(
        Date.now(),
        chosenAction,
        answers?.length ? JSON.stringify(answers) : null,
        throughNow() ?? null,
        cardId,
      );
  }

  /**
   * Cards resolved at or after `since`, newest first, with the action that
   * resolved them: the first `limit` that `keep` accepts.
   */
  resolvedSince(
    since: number,
    limit: number,
    keep: (resolution: CardResolution) => boolean = () => true,
    taskId?: string,
  ): CardResolution[] {
    // Every task's read picks from the narrow heads, the selection the first
    // mate's context build reads (INF-3957); one task's read seeks its own
    // cards through `cards_task_id` instead (INF-3641). Either reads each
    // card whole only until `limit` are kept.
    const reads: (() => CardResolution | undefined)[] =
      taskId === undefined
        ? this.resolutionHeadsSince(since).map(
            ({ cardId }) =>
              () =>
                this.resolutionOf(cardId),
          )
        : (
            this.db
              .prepare(
                `SELECT * FROM cards
                 WHERE task_id = ? AND resolved_at IS NOT NULL AND resolved_at >= ?
                   AND chosen_action IS NOT NULL
                 ORDER BY resolved_at DESC, id`,
              )
              .all(taskId, since) as ResolvedRow[]
          ).map((row) => () => this.resolutionOfRow(row));
    const kept: CardResolution[] = [];
    for (const read of reads) {
      if (kept.length >= limit) break;
      const resolution = read();
      if (resolution && keep(resolution)) kept.push(resolution);
    }
    return kept;
  }

  /**
   * The cards resolved at or after `since`, newest first, each without its
   * words: what choosing among them reads. A reader that shows only some of
   * them reads those whole with `resolutionOf`, so the words of the rest -
   * every card the captain answered in a busy few hours - are never read
   * (the first mate's context build, INF-3957).
   */
  resolutionHeadsSince(since: number): ResolutionHead[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, actions_json, chosen_action, resolved_at FROM cards
         WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND chosen_action IS NOT NULL
         ORDER BY resolved_at DESC, id`,
      )
      .all(since) as {
      id: string;
      task_id: string | null;
      actions_json: string;
      chosen_action: string;
      resolved_at: number;
    }[];
    const actionsOf = prepared(this.db, ACTION_OBSERVATIONS);
    const offerActionsOf = prepared(
      this.db,
      `SELECT json_extract(payload_json, '$.actions') AS actions FROM card_observations
       WHERE id = ? AND card_id = ? AND kind = 'offer' AND json_valid(payload_json)`,
    );
    return rows.flatMap((row) => {
      let actions: Card["actions"];
      try {
        const offerId = closingAction(
          actionsOf.all(row.id) as ObservationRow[],
          row.chosen_action,
          row.resolved_at,
        )?.offerId;
        const offered = offerId
          ? (offerActionsOf.get(offerId, row.id) as { actions: string | null } | undefined)
          : undefined;
        const parsed = offered?.actions
          ? cardOfferPayloadSchema.shape.actions.safeParse(JSON.parse(offered.actions))
          : undefined;
        actions = parsed?.success ? parsed.data : oneMergeEffect(JSON.parse(row.actions_json));
      } catch {
        return [];
      }
      return [
        {
          cardId: row.id,
          ...(row.task_id ? { taskId: row.task_id } : {}),
          action: row.chosen_action,
          resolvedAt: row.resolved_at,
          actions,
        },
      ];
    });
  }

  /** One resolution whole, words and closing offer included, as `resolvedSince` reads it. */
  resolutionOf(cardId: string): CardResolution | undefined {
    const row = prepared(
      this.db,
      "SELECT * FROM cards WHERE id = ? AND resolved_at IS NOT NULL AND chosen_action IS NOT NULL",
    ).get(cardId) as ResolvedRow | undefined;
    return row ? this.resolutionOfRow(row) : undefined;
  }

  private resolutionOfRow(row: ResolvedRow): CardResolution | undefined {
    const card = fromRow(row);
    if (!card) return undefined;
    const answers = row.answers_json
      ? cardAnswersSchema.safeParse(JSON.parse(row.answers_json))
      : undefined;
    const offerId = closingAction(
      prepared(this.db, ACTION_OBSERVATIONS).all(card.id) as ObservationRow[],
      row.chosen_action,
      row.resolved_at,
    )?.offerId;
    const offerRow = offerId
      ? (prepared(this.db, OFFER_OBSERVATION).get(offerId, card.id) as ObservationRow | undefined)
      : undefined;
    const offer = offerRow ? observationOf(offerRow) : undefined;
    return {
      card,
      action: row.chosen_action,
      resolvedAt: row.resolved_at,
      ...(offer?.kind === "offer" ? { offer: offer.payload } : {}),
      ...(answers?.success && answers.data.length > 0 ? { answers: answers.data } : {}),
      ...(row.resolved_through === THROUGH_THE_COMMAND ? { through: THROUGH_THE_COMMAND } : {}),
    };
  }

  /**
   * Whether a completion card was ever emitted on a task - any card of its
   * crewmate's carrying a merge effect, or the story note the app's own
   * merge left of one, open or resolved (contract
   * v3.6, captain lock 3). It answers one question: does the crewmate still
   * owe the captain the one merge decision on its task, or has it already
   * written it? Read off the DECLARED effect, the way the host dispatches,
   * never off an action id or a label.
   */
  hasCompletionCard(taskId: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT actions_json, risk_json, body FROM cards WHERE task_id = ? AND author = 'crewmate'",
      )
      .all(taskId) as { actions_json: string; risk_json: string | null; body: string }[];
    return rows.some((row) => {
      let actions: unknown;
      try {
        actions = JSON.parse(row.actions_json);
      } catch {
        return false;
      }
      // A merge card the app merges from keeps no buttons (INF-2744): its
      // risk with no actions still says the crewmate wrote it.
      if (row.risk_json && Array.isArray(actions) && actions.length === 0) return true;
      // A merge card whose Merge the app holds is one too (INF-4031).
      if (heldMerges(row.body)) return true;
      return (
        Array.isArray(actions) &&
        actions.some(
          (action) =>
            typeof action === "object" &&
            action !== null &&
            mergeEffectOf(action as Card["actions"][number]) !== undefined,
        )
      );
    });
  }

  /**
   * A task's newest card, open or already resolved (Task B): an answer
   * task's card IS its deliverable, so the builder that names it as `basis`
   * is handed that card's body in its brief, and the `tasks` query by key
   * hands it back on demand. Newest by creation, so a revision - which
   * replaces the row under the same id - reads as the version the captain
   * last saw.
   */
  newestForTask(taskId: string, author?: Card["author"]): Card | undefined {
    const row = author
      ? (this.db
          .prepare(
            "SELECT * FROM cards WHERE task_id = ? AND author = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          )
          .get(taskId, author) as Row | undefined)
      : (this.db
          .prepare(
            "SELECT * FROM cards WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          )
          .get(taskId) as Row | undefined);
    return row ? fromRow(row) : undefined;
  }

  /**
   * The card a task answered with: what a builder grounded on it is handed
   * as its basis. Only its own crewmate's cards count, never a Firstmate or
   * host card filed under the task, and never a merge decision. A basis that
   * prototyped and then built shows the prototype, sometimes a note, and a
   * completion card; the builder needs the one the captain chose on. So the
   * newest card the captain chose one of its actions on, else the newest
   * card, and the merge decision only when it is all there is.
   */
  newestAnswerForTask(taskId: string): Card | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM cards WHERE task_id = ? AND author = 'crewmate' ORDER BY created_at DESC, id DESC",
      )
      .all(taskId) as (Row & { chosen_action: string | null })[];
    const cards = rows.flatMap((row) => {
      const card = fromRow(row);
      return card ? [{ card, chosen: row.chosen_action }] : [];
    });
    const answers = cards.filter(({ card }) => !isMergeDecision(card.actions));
    return (
      answers.find(({ card, chosen }) => card.actions.some((action) => action.id === chosen)) ??
      answers[0] ??
      cards[0]
    )?.card;
  }

  /**
   * Every card a task showed, newest first, for the record's Cards row
   * (FI3-579 piece 1): the rows filed under the task plus any `extraIds` its
   * timeline names (a Firstmate decision's card carries no task of its own).
   * A closed card reads as the version last seen, with how it ended; a purged
   * card is simply absent. Pure read.
   */
  forTask(taskId: string, extraIds: readonly string[] = []): TaskCardRow[] {
    const ids = new Set(
      (
        this.db.prepare("SELECT id FROM cards WHERE task_id = ?").all(taskId) as { id: string }[]
      ).map((row) => row.id),
    );
    for (const id of extraIds) ids.add(id);
    const rows: { row: TaskCardRow; created: number }[] = [];
    for (const id of ids) {
      const raw = this.row(id);
      const card = raw ? fromRow(raw) : undefined;
      if (!raw || !card) continue;
      if (raw.resolved_at === null) {
        rows.push({
          created: card.createdAt,
          row: {
            id,
            kind: cardWord(card),
            title: card.title,
            state: "open",
            ...(card.minimized ? { minimized: true as const } : {}),
            at: card.createdAt,
          },
        });
        continue;
      }
      const past = this.past(id);
      if (!past) continue;
      rows.push({
        created: card.createdAt,
        row: {
          id,
          kind: cardWord(past),
          title: past.title,
          state: "closed",
          ending: inLanguage(SOURCE_LANGUAGE, () => pastCardEndingWords(past)),
          at: past.ending.at,
        },
      });
    }
    return rows
      .sort((a, b) => b.created - a.created || b.row.id.localeCompare(a.row.id))
      .map((x) => x.row);
  }

  /**
   * A task's cards the captain closed or chose on, as they stand on their
   * rows (INF-2461): what they already read about the work. A card closed
   * by its author, the first mate or the host is not theirs. Pure read.
   */
  closedByCaptain(taskId: string): Card[] {
    const ids = (
      this.db
        .prepare("SELECT id FROM cards WHERE task_id = ? AND resolved_at IS NOT NULL")
        .all(taskId) as { id: string }[]
    ).map((row) => row.id);
    return ids.flatMap((id) => {
      if (this.past(id)?.ending.by !== "captain") return [];
      const card = this.get(id);
      return card ? [card] : [];
    });
  }

  get(cardId: string): Card | undefined {
    const row = this.row(cardId);
    return row ? fromRow(row) : undefined;
  }

  /**
   * A card returning to the stack under a stable id it once had (a host
   * singleton raised again, an emitter reusing an id): clear the resolution
   * so the card is open again and survives the next restart like any other.
   */
  reopen(cardId: string): void {
    this.db
      .prepare(
        "UPDATE cards SET resolved_at = NULL, chosen_action = NULL, ended_json = NULL, put_off_json = NULL, resolved_through = NULL WHERE id = ?",
      )
      .run(cardId);
  }

  /**
   * A closed card as the captain last saw it (FI3-579 piece 2): the version
   * the stage showed him - the newest `seen` offer on the card's lifecycle,
   * else the offer its closing interaction chose from, else the newest
   * offer, else the row itself - how it ended, the answers he submitted and
   * its thread. Absent for an unknown or still open card. Pure read.
   */
  past(cardId: string): PastCard | undefined {
    const row = this.row(cardId) as
      | (Row & { chosen_action: string | null; answers_json: string | null })
      | undefined;
    if (!row || row.resolved_at === null) return undefined;
    const card = fromRow(row);
    if (!card) return undefined;
    const observations = this.observations(cardId).filter(
      (entry) => !row.lifecycle_id || entry.lifecycleId === row.lifecycle_id,
    );
    const closing = observations.findLast(
      (entry) =>
        (entry.kind === "action" && entry.payload.closes && entry.payload.recognized) ||
        entry.kind === "exit",
    );
    const offers = observations.flatMap((entry) => (entry.kind === "offer" ? [entry] : []));
    const seenOfferId = observations.findLast((entry) => entry.kind === "seen")?.offerId;
    const offerId = seenOfferId ?? closing?.offerId ?? offers.at(-1)?.id;
    const offer = offers.find((entry) => entry.id === offerId)?.payload;

    let how: PastEnding = "unknown";
    let actionId: string | undefined;
    let label: string | undefined;
    let by: PastCard["ending"]["by"];
    let answers: CardAnswer[] = [];
    let carried: PastCard["carried"];
    const parsedAnswers = row.answers_json
      ? cardAnswersSchema.safeParse(JSON.parse(row.answers_json))
      : undefined;
    if (parsedAnswers?.success) answers = parsedAnswers.data;
    const actions = offer?.actions ?? card.actions;
    // The risk of the version shown: an offer taken before risk existed has
    // none, and neither did its card.
    const risk = offer ? offer.risk : card.risk;
    const requiredActions = offer ? offer.requiredActions : card.requiredActions;
    const afterMerge = offer ? offer.afterMerge : card.afterMerge;
    if (closing?.kind === "action") {
      how = "chose";
      actionId = closing.payload.actionId;
      label = closing.payload.label ?? actions.find((action) => action.id === actionId)?.label;
      by = closing.actor;
      if (closing.payload.answers?.length) answers = closing.payload.answers;
      const sent = closing.payload.carried;
      if (sent?.notes?.length || sent?.pictures?.length)
        carried = {
          ...(sent.notes?.length ? { notes: sent.notes } : {}),
          ...(sent.pictures?.length ? { pictures: sent.pictures.map((ref) => ref.name) } : {}),
        };
    } else if (closing?.kind === "exit") {
      how = closing.payload.reason;
      by = closing.actor;
    } else if (row.chosen_action === "close") {
      how = "dismissed";
    } else if (row.chosen_action === "duplicate") {
      how = "duplicate";
    } else if (row.chosen_action && actions.some((action) => action.id === row.chosen_action)) {
      how = "chose";
      actionId = row.chosen_action;
      label = actions.find((action) => action.id === actionId)?.label;
    }
    return {
      id: card.id,
      ...(card.taskId ? { taskId: card.taskId } : {}),
      ...((offer ? offer.reviewTaskId : card.reviewTaskId)
        ? { reviewTaskId: offer ? offer.reviewTaskId : card.reviewTaskId }
        : {}),
      author: offer?.author ?? card.author,
      title: offer?.title ?? card.title,
      meta: offer?.meta ?? card.meta,
      ...((offer?.model ?? card.model) ? { model: offer?.model ?? card.model } : {}),
      body: offer?.body ?? card.body,
      actions: actions.map(({ effect: _effect, ...action }) => action),
      ...((offer?.width ?? card.width) ? { width: offer?.width ?? card.width } : {}),
      ...(risk ? { risk } : {}),
      ...(requiredActions !== undefined ? { requiredActions } : {}),
      ...(afterMerge?.length ? { afterMerge } : {}),
      ending: {
        how,
        at: closing?.recordedAt ?? row.resolved_at,
        ...(actionId ? { actionId } : {}),
        ...(label ? { label } : {}),
        ...(by ? { by } : {}),
      },
      answers,
      ...(carried ? { carried } : {}),
      messages: this.messages(cardId),
    };
  }

  chosenAction(cardId: string): string | undefined {
    const row = this.db.prepare("SELECT chosen_action FROM cards WHERE id = ?").get(cardId) as
      | { chosen_action: string | null }
      | undefined;
    return row?.chosen_action ?? undefined;
  }

  /**
   * The captain's confirmed duplicate label (WI-14): write-once on the
   * duplicate's row, naming the card it repeats. The label is data for the
   * eval, never a user surface; closing the card is the caller's.
   */
  flagDuplicate(input: {
    cardId: string;
    duplicateOf: string;
    note: string;
    at?: number;
  }): DuplicateResult {
    if (input.cardId === input.duplicateOf) return { status: "same-card", cardId: input.cardId };
    const card = this.row(input.cardId);
    if (!card) return { status: "no-card", cardId: input.cardId };
    const original = this.row(input.duplicateOf);
    if (!original) return { status: "no-original", cardId: input.duplicateOf };
    if (card.duplicate_of !== null) {
      return {
        status: "already-flagged",
        card: refOf(card),
        duplicateOf: card.duplicate_of,
        note: card.duplicate_note ?? "",
      };
    }
    const at = input.at ?? Date.now();
    this.db
      .prepare(
        "UPDATE cards SET duplicate_of = ?, duplicate_note = ?, duplicate_at = ? WHERE id = ? AND duplicate_of IS NULL",
      )
      .run(input.duplicateOf, input.note, at, input.cardId);
    return { status: "flagged", card: refOf(card), original: refOf(original), at };
  }

  duplicateLabel(cardId: string): { duplicateOf: string; note: string; at: number } | undefined {
    const row = this.row(cardId);
    if (!row || row.duplicate_of === null) return undefined;
    return {
      duplicateOf: row.duplicate_of,
      note: row.duplicate_note ?? "",
      at: row.duplicate_at ?? 0,
    };
  }

  /**
   * One message onto a card's thread (cards-as-threads phase 1, migration
   * 38): the captain's reply, the author's prose answer, or the host's own
   * line when the author revised the head instead of answering. Appending
   * never touches the card row - a reply resolves nothing.
   */
  appendMessage(input: {
    cardId: string;
    who: CardMessageWho;
    text: string;
    /** Original captain caption before attachment/settings decoration; unknown on older rows. */
    captainText?: string;
    at?: number;
    revision?: CardRevisionLinks;
    notes?: CardNote[];
    /** Who wrote it, when that is not the card's own author (major 15). */
    contributor?: CardContributor;
    /** The captain message this line answers and ends. */
    answersMessage?: number;
    /** A dated note on a closed card. */
    clarification?: true;
    /** The correlated response this line carries (`InboxStore.submitResponse`). */
    responseId?: string;
  }): CardMessage {
    const at = input.at ?? Date.now();
    const original = input.who === "captain" && input.captainText !== undefined;
    // The captain's line his own command sent says so (INF-3898 piece 2).
    const through = input.who === "captain" ? throughNow() : undefined;
    const result = this.db
      .prepare(
        `INSERT INTO card_messages
          (card_id, who, text, at, revision_json, contributor_json, answers_message, clarification, response_id, notes_json, through${original ? ", captain_text" : ""})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${original ? ", ?" : ""})`,
      )
      .run(
        input.cardId,
        input.who,
        input.text,
        at,
        input.revision ? JSON.stringify(cardRevisionSchema.parse(input.revision)) : null,
        input.contributor ? JSON.stringify(cardContributorSchema.parse(input.contributor)) : null,
        input.answersMessage ?? null,
        input.clarification ? 1 : null,
        input.responseId ?? null,
        input.notes?.length ? JSON.stringify(cardNotesSchema.parse(input.notes)) : null,
        through ?? null,
        ...(original ? [input.captainText] : []),
      );
    return {
      id: Number(result.lastInsertRowid),
      cardId: input.cardId,
      who: input.who,
      text: input.text,
      at,
      ...(input.revision ? { revision: input.revision } : {}),
      ...(input.notes?.length ? { notes: input.notes } : {}),
      ...(input.contributor ? { contributor: input.contributor } : {}),
      ...(input.answersMessage !== undefined ? { answersMessage: input.answersMessage } : {}),
      ...(input.clarification ? { clarification: true as const } : {}),
      ...(through ? { through } : {}),
    };
  }

  /** The first line that answered a captain message, sought by its index. */
  answerTo(cardId: string, messageId: number): CardMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM card_messages m
         WHERE m.card_id = ? AND m.answers_message = ? ORDER BY m.id LIMIT 1`,
      )
      .get(cardId, messageId) as MessageRow | undefined;
    return row ? messageOf(row) : undefined;
  }

  /**
   * The card's newest captain line that asks its author something, the
   * question its answer hold is about. A /feedback line is the first mate's
   * feedback request and owes the author nothing (docs/feedback.md), so it
   * is passed over, read from the words the captain typed.
   */
  newestCaptainMessage(cardId: string): CardMessage | undefined {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, COALESCE(m.captain_text, m.text) AS typed FROM card_messages m
         WHERE m.card_id = ? AND m.who = 'captain' ORDER BY m.id DESC`,
      )
      .iterate(cardId) as IterableIterator<MessageRow & { typed: string }>;
    for (const row of rows) {
      if (isFeedbackRequest(row.typed)) continue;
      return messageOf(row);
    }
    return undefined;
  }

  /** A contribution's saved result by its operation identity (major 15). */
  contribution(operationId: string): { cardId: string; result: unknown } | undefined {
    const row = this.db
      .prepare("SELECT card_id, result_json FROM card_contributions WHERE operation_id = ?")
      .get(operationId) as { card_id: string; result_json: string } | undefined;
    if (!row) return undefined;
    try {
      return { cardId: row.card_id, result: JSON.parse(row.result_json) };
    } catch {
      return { cardId: row.card_id, result: undefined };
    }
  }

  recordContribution(input: {
    operationId: string;
    cardId: string;
    actor: "crewmate" | "firstmate";
    taskId?: string;
    reason?: string;
    at: number;
    result: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO card_contributions
          (operation_id, card_id, actor, task_id, reason, at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.cardId,
        input.actor,
        input.taskId ?? null,
        input.reason ?? null,
        input.at,
        JSON.stringify(input.result),
      );
  }

  /** Publish every write from the turn, not merely its newest offer. */
  releaseRevisions(cardId: string, lifecycleId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE card_messages SET revision_json = json_set(revision_json, '$.released', json('true'))
      WHERE card_id = ? AND json_valid(revision_json) AND json_extract(revision_json, '$.lifecycleId') = ?
      AND json_extract(revision_json, '$.released') = 0`)
        .run(cardId, lifecycleId).changes > 0
    );
  }

  /**
   * A card's thread, oldest first. A captain's reply carries the settings
   * it was sent with beside his words (`CardMessage.answers`).
   */
  messages(cardId: string): CardMessage[] {
    const rows = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM card_messages m WHERE m.card_id = ? ORDER BY m.id`)
      .all(cardId) as MessageRow[];
    return rows.map(messageOf);
  }

  /** Current counts and last authors for the requested cards, without hydrating message bodies. */
  threadStats(
    cardIds: readonly string[],
  ): Map<string, { count: number; who: CardMessageWho; at: number }> {
    if (cardIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT latest.card_id AS cardId, latest.who, latest.at,
        (SELECT COUNT(*) FROM card_messages WHERE card_id = asked.value) AS count
       FROM json_each(?) AS asked CROSS JOIN card_messages AS latest
       WHERE latest.id = (
         SELECT id FROM card_messages WHERE card_id = asked.value ORDER BY id DESC LIMIT 1
       )`,
      )
      .all(JSON.stringify(cardIds)) as {
      cardId: string;
      count: number;
      who: CardMessageWho;
      at: number;
    }[];
    return new Map(rows.map(({ cardId, ...stat }) => [cardId, stat]));
  }

  threadStat(cardId: string): ThreadSummary | undefined {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, MAX(id) AS last_id FROM card_messages WHERE card_id = ?")
      .get(cardId) as { count: number; last_id: number | null };
    if (!row || row.count === 0 || row.last_id === null) return undefined;
    const last = this.messageById(row.last_id);
    return last ? { cardId, count: row.count, last } : undefined;
  }

  /**
   * How many messages every card with a thread holds, and its newest - the
   * one query the Firstmate's context section is rendered from, so it never
   * walks the table card by card. Newest thread first, capped by `limit`,
   * because the section that reads it is bounded anyway. Only threads with
   * a message since `since` are counted, sought by time, so the read does
   * not walk every thread in the record.
   */
  threadSummaries(since: number, limit = 8): ThreadSummary[] {
    const rows = this.db
      .prepare(
        `SELECT card_id, COUNT(*) AS count, MAX(id) AS last_id FROM card_messages
         WHERE card_id IN (SELECT card_id FROM card_messages WHERE at >= ?)
         GROUP BY card_id ORDER BY MAX(at) DESC LIMIT ?`,
      )
      .all(since, limit) as { card_id: string; count: number; last_id: number }[];
    return rows.flatMap((row) => {
      const last = this.messageById(row.last_id);
      return last ? [{ cardId: row.card_id, count: row.count, last }] : [];
    });
  }

  /**
   * The thread lines under every card about a task, oldest first, up to
   * `upTo` when a reader pages from a fixed cut (`TaskTimeline`).
   */
  messagesForTask(taskId: string, upTo = Number.MAX_SAFE_INTEGER): CardMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM card_messages m
         WHERE m.card_id IN (SELECT id FROM cards WHERE task_id = ?) AND m.id <= ? ORDER BY m.id`,
      )
      .all(taskId, upTo) as MessageRow[];
    return rows.map(messageOf);
  }

  /** One thread line by its id; undefined once its card is gone. */
  messageById(id: number): CardMessage | undefined {
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM card_messages m WHERE m.id = ?`)
      .get(id) as MessageRow | undefined;
    return row ? messageOf(row) : undefined;
  }

  /**
   * Whether an open card currently waits for its author's answer. The
   * persisted hold belongs to this lifecycle; historical thread messages
   * survive resolution and reopening and cannot establish a new obligation.
   */
  awaitingAuthor(cardId: string): boolean {
    const row = this.db
      .prepare("SELECT awaiting FROM cards WHERE id = ? AND resolved_at IS NULL")
      .get(cardId) as { awaiting: string | null } | undefined;
    return row?.awaiting === "answer";
  }

  deleteForTask(taskId: string): void {
    this.db.transaction(() => {
      for (const table of [
        "card_messages",
        "card_revisions",
        "card_observations",
        "card_contributions",
      ]) {
        this.db
          .prepare(`DELETE FROM ${table} WHERE card_id IN (SELECT id FROM cards WHERE task_id = ?)`)
          .run(taskId);
      }
      this.db.prepare("DELETE FROM card_observations WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM cards WHERE task_id = ?").run(taskId);
    })();
  }

  /**
   * The evidence of cards with no task of their own (a Firstmate decision
   * filed as its own row, a host card's operation row): the purge removes
   * it with the rows that stood for those cards. The card rows stay, as
   * they always have.
   */
  deleteEvidenceFor(cardIds: readonly string[]): void {
    if (cardIds.length === 0) return;
    this.db.transaction(() => {
      const remove = this.db.prepare("DELETE FROM card_observations WHERE card_id = ?");
      for (const cardId of cardIds) remove.run(cardId);
    })();
  }

  // ---- the card evidence (docs/card-evidence.md) --------------------------

  /**
   * Runs `write` as one transaction: a card or thread write and the
   * observation that describes it commit together or not at all. Nested
   * calls join the outer one.
   */
  transaction<T>(write: () => T): T {
    return this.db.transaction(write)();
  }

  /**
   * Append one observation. Its payload is validated against its kind's
   * schema here, so nothing unreadable is ever written. Returns false when
   * the same interaction on the same card is already recorded - a
   * retransmitted click is one observation, never two.
   */
  observe<K extends CardObservationKind>(input: {
    id: string;
    kind: K;
    cardId: string;
    lifecycleId: string;
    taskId?: string | undefined;
    at: number;
    actor: CardObservationActor;
    source: CardObservationSource;
    offerId?: string | undefined;
    interactionId?: string | undefined;
    messageId?: number | undefined;
    build?: string | undefined;
    payload: CardObservationPayload<K>;
  }): boolean {
    const payload = cardObservationPayloadSchemas[input.kind].parse(input.payload);
    const result = this.db
      .prepare(
        `INSERT INTO card_observations
           (id, card_id, lifecycle_id, task_id, kind, schema_version, capture_version,
            recorded_at, actor, source, offer_id, interaction_id, message_id, build, payload_json)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        input.id,
        input.cardId,
        input.lifecycleId,
        input.taskId ?? null,
        input.kind,
        CARD_CAPTURE_VERSION,
        input.at,
        input.actor,
        input.source,
        input.offerId ?? null,
        input.interactionId ?? null,
        input.messageId ?? null,
        input.build ?? null,
        JSON.stringify(payload),
      );
    const inserted = result.changes > 0;
    if (
      inserted &&
      input.actor === "captain" &&
      (input.kind === "message_ref" || input.kind === "action")
    ) {
      for (const listener of this.captainListeners) {
        try {
          listener(input.id);
        } catch {
          // Ancillary classification must never reject the captain's original input.
          console.warn("[cards] captain-input observer failed");
        }
      }
    }
    return inserted;
  }

  /** One indexed cursor, captured before a choice can acquire later replies. */
  latestMessageId(cardId: string): number {
    const row = this.db
      .prepare("SELECT id FROM card_messages WHERE card_id = ? ORDER BY id DESC LIMIT 1")
      .get(cardId) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  /**
   * Seek earlier source-owner messages newest first, stopping when the caller
   * has its bounded context. Captain text is never reconstructed from an
   * attachment-decorated message; undefined means the original is unknown.
   * The frozen inclusive cursor excludes the reply and every later message.
   */
  *originalMessagesBefore(
    cardId: string,
    cursor: number,
  ): Generator<{ id: number; who: CardMessageWho; text: string | undefined }> {
    const rows = this.db
      .prepare(
        `SELECT id, who, text, captain_text FROM card_messages
         WHERE card_id = ? AND id <= ? ORDER BY id DESC`,
      )
      .iterate(cardId, cursor) as Iterable<{
      id: number;
      who: CardMessageWho;
      text: string;
      captain_text: string | null;
    }>;
    for (const row of rows) {
      yield {
        id: row.id,
        who: row.who,
        text: row.who === "captain" ? (row.captain_text ?? undefined) : row.text,
      };
    }
  }

  /** Read only the original captain input named by a newly recorded interaction. */
  captainInput(observationId: string): CaptainCardInput | undefined {
    const observation = this.observationById(observationId);
    if (observation?.actor !== "captain" || observation.source === "frame") return undefined;
    let caption = "";
    let precedingMessageId: number;
    if (observation.kind === "message_ref") {
      const row = this.db
        .prepare(
          "SELECT captain_text FROM card_messages WHERE card_id = ? AND id = ? AND who = 'captain'",
        )
        .get(observation.cardId, observation.payload.messageId) as
        | { captain_text: string | null }
        | undefined;
      // No reconstruction from old decorated text, which may contain attachment contents.
      if (row?.captain_text == null) return undefined;
      caption = row.captain_text;
      precedingMessageId = observation.payload.messageId - 1;
    } else if (observation.kind === "action") {
      if (!observation.payload.recognized) return undefined;
      precedingMessageId = observation.payload.precedingMessageId ?? 0;
    } else return undefined;
    const text = cardWrittenText(
      caption,
      observation.payload.answers,
      observation.payload.questions,
    );
    if (!text.trim()) return undefined;
    const verified = observation.payload.display?.fidelity === "matched";
    return {
      sourceId: observation.id,
      kind: observation.kind === "message_ref" ? "card-message" : "card-choice",
      cardId: observation.cardId,
      lifecycleId: observation.lifecycleId,
      taskId: observation.taskId,
      at: observation.recordedAt,
      text,
      ...(verified && observation.offerId ? { offerId: observation.offerId } : {}),
      precedingMessageId,
      contextMissing:
        !verified ||
        Boolean(observation.payload.questionsGap) ||
        (observation.kind === "action" && observation.payload.precedingMessageId === undefined),
    };
  }

  observations(cardId: string): CardObservation[] {
    const rows = this.db
      .prepare("SELECT * FROM card_observations WHERE card_id = ? ORDER BY seq")
      .all(cardId) as ObservationRow[];
    return rows.flatMap((row) => {
      const observation = observationOf(row);
      return observation ? [observation] : [];
    });
  }

  /**
   * Every observation about a task's cards, every lifecycle, oldest first,
   * up to `upTo` when a reader pages from a fixed cut (`TaskTimeline`).
   */
  observationsForTask(taskId: string, upTo = Number.MAX_SAFE_INTEGER): CardObservation[] {
    const rows = this.db
      .prepare("SELECT * FROM card_observations WHERE task_id = ? AND seq <= ? ORDER BY seq")
      .all(taskId, upTo) as ObservationRow[];
    return rows.flatMap((row) => {
      const observation = observationOf(row);
      return observation ? [observation] : [];
    });
  }

  /** One observation by its id; undefined when it is gone or its payload no longer reads. */
  observationById(id: string): CardObservation | undefined {
    // Each card in a snapshot reads its seen facts here (INF-4464).
    const row = prepared(this.db, "SELECT * FROM card_observations WHERE id = ?").get(id) as
      | ObservationRow
      | undefined;
    return row ? observationOf(row) : undefined;
  }

  lastAvailabilityOf(
    cardId: string,
    lifecycleId: string,
    offerId: string,
  ): Extract<CardObservation, { kind: "availability" }>["payload"] | undefined {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM card_observations
         WHERE card_id = ? AND lifecycle_id = ? AND kind = 'availability' AND offer_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(cardId, lifecycleId, offerId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = cardObservationPayloadSchemas.availability.safeParse(
      JSON.parse(row.payload_json),
    );
    return payload.success ? payload.data : undefined;
  }

  /** The exact released update of this offer; status pushes and redraws create none. */
  currentUpdate(cardId: string, lifecycleId: string, offerId: string): string | undefined {
    const row = prepared(
      this.db,
      `SELECT id FROM card_observations
      WHERE card_id = ? AND lifecycle_id = ? AND offer_id = ? AND kind = 'availability'
        AND json_extract(payload_json, '$.state') = 'available'
      ORDER BY seq DESC LIMIT 1`,
    ).get(cardId, lifecycleId, offerId) as { id: string } | undefined;
    return row?.id;
  }

  /** Only an exact-update observation proves this released answer was read. */
  updateSeen(cardId: string, lifecycleId: string, updateId: string): boolean {
    const seen = this.observationById(updateSightingId(updateId));
    return (
      seen?.kind === "seen" &&
      seen.cardId === cardId &&
      seen.lifecycleId === lifecycleId &&
      seen.payload.updateId === updateId
    );
  }

  /** A final author answer since the last release, including an unchanged-offer answer. */
  unreleasedAnswer(cardId: string, lifecycleId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM card_observations
      WHERE card_id = ? AND lifecycle_id = ? AND kind = 'message_ref'
        AND json_extract(payload_json, '$.who') IN ('firstmate', 'crewmate')
        AND json_extract(payload_json, '$.interim') IS NOT 1
        AND seq > COALESCE((SELECT MAX(seq) FROM card_observations
          WHERE card_id = ? AND lifecycle_id = ? AND kind = 'availability'
            AND json_extract(payload_json, '$.state') = 'available'), 0)
      LIMIT 1`)
        .get(cardId, lifecycleId, cardId, lifecycleId) !== undefined
    );
  }

  lastAvailableOffer(cardId: string, lifecycleId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT offer_id FROM card_observations
         WHERE card_id = ? AND lifecycle_id = ? AND kind = 'availability'
           AND json_extract(payload_json, '$.state') = 'available'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(cardId, lifecycleId) as { offer_id: string | null } | undefined;
    return row?.offer_id ?? undefined;
  }

  /**
   * The offer the captain last saw on a lifecycle (`seen`), passing over
   * `except` - the version on the stage, which is compared with the one
   * seen before it.
   */
  lastSeenOffer(cardId: string, lifecycleId: string, except?: string): string | undefined {
    const row = prepared(
      this.db,
      `SELECT offer_id FROM card_observations
         WHERE card_id = ? AND lifecycle_id = ? AND kind = 'seen' AND offer_id IS NOT ?
         ORDER BY seq DESC LIMIT 1`,
    ).get(cardId, lifecycleId, except ?? null) as { offer_id: string | null } | undefined;
    return row?.offer_id ?? undefined;
  }

  /**
   * The cards of a task whose current version the captain saw, each with
   * when they last saw it (INF-2845): what "an answer you saw" reads once a
   * message's work has ended. Only a sighting of the card's current offer
   * counts, and of its current update once one was released, since an older
   * sighting cannot prove the latest answer was read (docs/card-evidence.md);
   * a lifecycle its own author withdrew never counts.
   */
  seenCards(taskId: string): { cardId: string; at: number }[] {
    const rows = this.db
      .prepare(
        `SELECT card_id, lifecycle_id, offer_id, kind, recorded_at,
                json_extract(payload_json, '$.reason') AS reason,
                json_extract(payload_json, '$.updateId') AS update_id
           FROM card_observations
          WHERE task_id = ? AND kind IN ('seen', 'exit')`,
      )
      .all(taskId) as {
      card_id: string;
      lifecycle_id: string;
      offer_id: string | null;
      kind: "seen" | "exit";
      recorded_at: number;
      reason: string | null;
      update_id: string | null;
    }[];
    const withdrawn = new Set<string>();
    for (const row of rows) {
      if (row.kind === "exit" && row.reason === "author-withdrawal") {
        withdrawn.add(`${row.card_id}\u0000${row.lifecycle_id}`);
      }
    }
    const current = new Map<string, { lifecycleId?: string; offerId?: string; update?: string }>();
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== "seen" || withdrawn.has(`${row.card_id}\u0000${row.lifecycle_id}`)) continue;
      let version = current.get(row.card_id);
      if (!version) {
        const card = this.get(row.card_id);
        version = {
          ...(card?.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
          ...(card?.offerId ? { offerId: card.offerId } : {}),
        };
        if (version.lifecycleId && version.offerId) {
          const update = this.currentUpdate(row.card_id, version.lifecycleId, version.offerId);
          if (update) version.update = update;
        }
        current.set(row.card_id, version);
      }
      if (row.lifecycle_id !== version.lifecycleId || row.offer_id !== version.offerId) continue;
      if (version.update && row.update_id !== version.update) continue;
      seen.set(row.card_id, Math.max(seen.get(row.card_id) ?? 0, row.recorded_at));
    }
    return [...seen].map(([cardId, at]) => ({ cardId, at }));
  }

  offer(
    cardId: string,
    offerId: string,
  ): { at: number; payload: CardObservationPayload<"offer"> } | undefined {
    const row = this.db
      .prepare(
        `SELECT recorded_at, payload_json FROM card_observations
         WHERE card_id = ? AND kind = 'offer' AND id = ?`,
      )
      .get(cardId, offerId) as { recorded_at: number; payload_json: string } | undefined;
    if (!row) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch {
      return undefined;
    }
    const payload = cardObservationPayloadSchemas.offer.safeParse(raw);
    return payload.success ? { at: row.recorded_at, payload: payload.data } : undefined;
  }

  /**
   * Record that this capture version is running, once: the first boot on
   * it stamps when and on which build, so a reader can tell an interval the
   * capture covered from one it did not.
   */
  markCaptureEpoch(at: number, build?: string): void {
    // One namespace per installation: the first epoch's, kept by every later one.
    const first = this.db
      .prepare("SELECT namespace FROM card_capture_epochs ORDER BY capture_version LIMIT 1")
      .get() as { namespace: string } | undefined;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO card_capture_epochs (capture_version, activated_at, build, namespace) VALUES (?, ?, ?, ?)",
      )
      .run(CARD_CAPTURE_VERSION, at, build ?? null, first?.namespace ?? randomUUID());
  }

  private row(cardId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as Row | undefined;
  }
}
