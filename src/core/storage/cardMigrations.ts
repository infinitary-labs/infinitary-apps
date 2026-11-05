import { type CardAction, migrateLegacyActions } from "@shared/cards";
import { addColumn } from "./addColumn";
import type { AppDatabase } from "./db";

/**
 * The card record's migrations that need code: one card shape with effects,
 * who answers a reply under a card, and the shared cards' contributions.
 * Each is a step of the ledger (migrations.ts) and runs once, by its number.
 */

/** The ids the host used for its own cards before P1 stamped an author. */
const HOST_CARD_ID_PATTERNS = [
  "card-auth-%",
  "card-fm-auth",
  "card-fm-no-headroom",
  "card-fm-flagship-move",
  "card-fm-quiet",
  "card-fm-turn-failure",
  "card-voice-%",
  "card-gate-%",
  "card-highwait-%",
  "card-quiet-%",
  "%-settle-failed",
];

export function migrateCardEffects(db: AppDatabase): void {
  db.exec(`
    ALTER TABLE cards ADD COLUMN author TEXT NOT NULL DEFAULT 'crewmate';
    CREATE TABLE card_effect_backfill (
      card_id TEXT PRIMARY KEY,
      actions_json TEXT NOT NULL,
      migrated_at INTEGER NOT NULL
    );
  `);
  const hostMatch = HOST_CARD_ID_PATTERNS.map(() => "id LIKE ?").join(" OR ");
  db.prepare(`UPDATE cards SET author = 'host' WHERE ${hostMatch}`).run(...HOST_CARD_ID_PATTERNS);
  db.prepare(
    "UPDATE cards SET author = 'firstmate' WHERE author = 'crewmate' AND id LIKE 'card-fm-%'",
  ).run();
  const open = db
    .prepare("SELECT id, actions_json FROM cards WHERE resolved_at IS NULL ORDER BY created_at, id")
    .all() as { id: string; actions_json: string }[];
  const log = db.prepare(
    "INSERT INTO card_effect_backfill (card_id, actions_json, migrated_at) VALUES (?, ?, ?)",
  );
  const rewrite = db.prepare("UPDATE cards SET actions_json = ? WHERE id = ?");
  const now = Date.now();
  for (const row of open) {
    let actions: CardAction[];
    try {
      const parsed = JSON.parse(row.actions_json) as unknown;
      if (!Array.isArray(parsed)) continue;
      actions = parsed as CardAction[];
    } catch {
      continue;
    }
    const migrated = JSON.stringify(migrateLegacyActions(actions));
    if (migrated === row.actions_json) continue;
    log.run(row.id, row.actions_json, now);
    rewrite.run(migrated, row.id);
  }
}

export function addCardAnswerer(db: AppDatabase): void {
  addColumn(db, "cards", "answered_by", "TEXT");
}

/**
 * Shared cards (INF-2225, docs/card-threads.md "Shared cards"): who actually
 * wrote a thread line on a card that is not theirs, which captain message a
 * final answer ends, a closed card's dated clarification, the response a
 * card answer carries, and each contribution's operation identity with the
 * result it returned, so a repeated operation answers that result again.
 * A column today's thread writer names may already be there, lent to an
 * older profile, so each is added only when missing.
 */
export function addCardContributions(db: AppDatabase): void {
  addColumn(db, "card_messages", "contributor_json", "TEXT");
  addColumn(db, "card_messages", "answers_message", "INTEGER");
  addColumn(db, "card_messages", "clarification", "INTEGER");
  addColumn(db, "card_messages", "response_id", "TEXT");
  db.exec(`
    CREATE INDEX card_messages_answers ON card_messages (card_id, answers_message)
      WHERE answers_message IS NOT NULL;
    CREATE TABLE card_contributions (
      operation_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      task_id TEXT,
      reason TEXT,
      at INTEGER NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE INDEX card_contributions_card ON card_contributions (card_id, at);
    ALTER TABLE crew_responses ADD COLUMN card_message_id INTEGER;
  `);
}
