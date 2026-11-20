import {
  type CardDraft,
  type CardDraftChange,
  type CardDraftChanged,
  emptyDraft,
} from "@shared/cardDrafts";
import type { CardNote } from "@shared/cardNotes";
import { CARD_ANSWERS_MAX_BYTES, CARD_MAX_ANSWERS, cardAnswersBytes } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import type { AppDatabase } from "../storage/db";

/**
 * Each open card's unsent draft (docs/card-authoring.md, "Unsent picks
 * follow you"): the one writer of `card_drafts`. Every window that shows a
 * card reads its draft at each welcome and sends what it changed; each
 * change goes to every window as a live frame (`inf:cards:draft`), never
 * through the journal. The table's triggers delete a card's draft in the
 * same write that resolves or removes the card, and a change for a card
 * that is no longer open is refused, so a deleted draft never comes back.
 * No agent, published view, card evidence or export reads a draft: a pick
 * sends nothing until the captain presses a button.
 */

type Row = { card_id: string; part: string; value_json: string; revision: number };
type Card = { resolved_at: number | null; lifecycle_id: string | null };

const ANSWER = "answer:";
const WORDS = "words";
const NOTES = "notes";

/** The draft the rows of one card make. */
function draftOf(cardId: string, lifecycle: string | null, rows: readonly Row[]): CardDraft {
  const draft: CardDraft = { ...emptyDraft(cardId), ...(lifecycle ? { lifecycle } : {}) };
  for (const row of rows) {
    draft.revision = Math.max(draft.revision, row.revision);
    const value: unknown = JSON.parse(row.value_json);
    if (row.part.startsWith(ANSWER)) draft.answers.push(value as FrameAnswer);
    else if (row.part === WORDS) draft.words = value as string;
    else if (row.part === NOTES) draft.notes = value as CardNote[];
  }
  return draft;
}

/** What one change asks to set, by part. */
function partsOf(change: CardDraftChange): Map<string, string> {
  const parts = new Map<string, string>();
  for (const answer of change.answers ?? [])
    parts.set(ANSWER + answer.name, JSON.stringify(answer));
  if (change.words !== undefined) parts.set(WORDS, JSON.stringify(change.words));
  if (change.notes !== undefined) parts.set(NOTES, JSON.stringify(change.notes));
  return parts;
}

export class CardDrafts {
  constructor(
    private readonly db: AppDatabase,
    private readonly push: (draft: CardDraft) => void,
  ) {}

  /** Every open card's draft that holds anything. Only open cards have rows. */
  read(): CardDraft[] {
    const rows = this.db
      .prepare<[], Row & { lifecycle_id: string | null }>(
        // i18n-exempt: SQL, never shown
        `SELECT d.card_id, d.part, d.value_json, d.revision, c.lifecycle_id
         FROM card_drafts d JOIN cards c ON c.id = d.card_id ORDER BY d.card_id, d.part`,
      )
      .all();
    const byCard = new Map<string, { lifecycle: string | null; rows: Row[] }>();
    for (const row of rows) {
      const held = byCard.get(row.card_id);
      if (held) held.rows.push(row);
      else byCard.set(row.card_id, { lifecycle: row.lifecycle_id, rows: [row] });
    }
    return [...byCard].map(([cardId, held]) => draftOf(cardId, held.lifecycle, held.rows));
  }

  /**
   * Takes what a window changed since it last heard the card's draft at
   * `change.since`. A part another window changed after that keeps the
   * newer value; every other part takes the window's, all at one new
   * revision. Refused for a card that is not open or opened anew since the
   * window's change (`change.lifecycle`), and for answers past what a press
   * may send in size or count.
   */
  change(cardId: string, change: CardDraftChange): CardDraftChanged {
    const result = this.db.transaction((): CardDraftChanged & { moved?: true } => {
      const card = this.db
        .prepare<[string], Card>(
          // i18n-exempt: SQL, never shown
          "SELECT resolved_at, lifecycle_id FROM cards WHERE id = ?",
        )
        .get(cardId);
      if (!card || card.resolved_at !== null) return { refused: "closed" };
      // A card written before openings were kept has none, and takes only a change naming none.
      if ((change.lifecycle ?? null) !== (card.lifecycle_id || null)) return { refused: "closed" };
      const held = this.rows(cardId);
      const byPart = new Map(held.map((row) => [row.part, row]));
      const revision = held.reduce((most, row) => Math.max(most, row.revision), 0) + 1;
      const write = this.db.prepare<[string, string, string, number]>(
        // i18n-exempt: SQL, never shown
        `INSERT INTO card_drafts (card_id, part, value_json, revision) VALUES (?, ?, ?, ?)
         ON CONFLICT(card_id, part) DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision`,
      );
      let moved = false;
      for (const [part, value] of partsOf(change)) {
        const now = byPart.get(part);
        if (now && (now.revision > change.since || now.value_json === value)) continue;
        write.run(cardId, part, value, revision);
        moved = true;
      }
      const draft = draftOf(cardId, card.lifecycle_id, moved ? this.rows(cardId) : held);
      if (
        draft.answers.length > CARD_MAX_ANSWERS ||
        cardAnswersBytes(draft.answers) > CARD_ANSWERS_MAX_BYTES
      )
        throw new DraftTooLarge();
      return moved ? { draft, moved: true } : { draft };
    });
    let changed: ReturnType<typeof result>;
    try {
      changed = result();
    } catch (error) {
      if (error instanceof DraftTooLarge) return { refused: "too-large" };
      throw error;
    }
    if ("draft" in changed) {
      if (changed.moved) this.push(changed.draft);
      return { draft: changed.draft };
    }
    return changed;
  }

  private rows(cardId: string): Row[] {
    return this.db
      .prepare<[string], Row>(
        // i18n-exempt: SQL, never shown
        "SELECT card_id, part, value_json, revision FROM card_drafts WHERE card_id = ? ORDER BY part",
      )
      .all(cardId);
  }
}

/** Thrown inside the change's transaction so nothing it wrote stays. */
class DraftTooLarge extends Error {}
