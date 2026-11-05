import { addColumn } from "./addColumn";
import type { AppDatabase } from "./db";
import { INBOX_GRACE_MS, inboxContentHash } from "./inboxStore";

/**
 * The durable inbox's migrations (docs/inbox.md) that need code: a row's
 * content hash, its origin, its retry clock, and the crew's response records.
 * Each is a step of the ledger (migrations.ts) and runs once, by its number.
 */

export function migrateInboxContentHash(db: AppDatabase): void {
  db.exec(`
    ALTER TABLE inbox ADD COLUMN content_hash TEXT;
    CREATE TABLE inbox_acks (
      recipient TEXT NOT NULL,
      ref TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      acked_at INTEGER NOT NULL,
      PRIMARY KEY (recipient, ref)
    );
  `);
  const rows = db.prepare("SELECT id, payload FROM inbox").all() as {
    id: number;
    payload: string;
  }[];
  const stamp = db.prepare("UPDATE inbox SET content_hash = ? WHERE id = ?");
  for (const row of rows) stamp.run(inboxContentHash(row.payload), row.id);
}

/**
 * The pre-column origin of an inbox row, from the host's own message
 * shapes - the read-time rules `classifyPayload` applied before migration
 * 32. Used only to translate rows queued before the column existed; live
 * rows are stamped by their emitter and never read this way.
 */
function legacyInboxOrigin(row: {
  recipient: string;
  payload: string;
  ref: string | null;
}): string | null {
  if (row.recipient !== "firstmate" && row.recipient !== "supervision") return null;
  const payload = row.payload;
  if (payload.startsWith("[fm-op] scheduled")) return "scheduled";
  if (payload.startsWith("[fm-op] fleet event escalated to you")) return "supervision";
  if (/(?:^|\n)\[fm-op\].* reported on task ([a-z0-9-]+) /.test(payload)) {
    return "crewmate-report";
  }
  if (row.ref === "captain-turn" && payload.startsWith("[user]\n")) return "captain";
  return "agent";
}

export function migrateInboxOrigin(db: AppDatabase): void {
  db.exec("ALTER TABLE inbox ADD COLUMN origin TEXT");
  const rows = db.prepare("SELECT id, recipient, payload, ref FROM inbox").all() as {
    id: number;
    recipient: string;
    payload: string;
    ref: string | null;
  }[];
  const stamp = db.prepare("UPDATE inbox SET origin = ? WHERE id = ?");
  for (const row of rows) {
    const origin = legacyInboxOrigin(row);
    if (origin !== null) stamp.run(origin, row.id);
  }
}

export function migrateIdleRecovery(db: AppDatabase): void {
  addColumn(db, "inbox", "failures", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "inbox", "failing_since", "INTEGER");
  addColumn(db, "inbox", "next_attempt_at", "INTEGER");
  db.prepare(
    "UPDATE inbox SET next_attempt_at = last_attempt_at + ? WHERE last_attempt_at IS NOT NULL",
  ).run(INBOX_GRACE_MS);
  addColumn(db, "tasks", "idle_since", "INTEGER");
  addColumn(db, "tasks", "recovery_rung", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "tasks", "recovery_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "tasks", "recovery_at", "INTEGER");
}

/** The inbox owns these additive records; worker closure never cascades into them. */
export function addCrewResponses(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE response_requests (
      id TEXT PRIMARY KEY,
      inbox_id INTEGER NOT NULL UNIQUE,
      source_session TEXT,
      source_message TEXT,
      target_task TEXT NOT NULL,
      target_session TEXT,
      body TEXT NOT NULL,
      card_json TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX response_requests_target ON response_requests (target_task, state, created_at);
    CREATE TABLE crew_responses (
      response_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES response_requests(id),
      contributor_task TEXT NOT NULL,
      contributor_session TEXT,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      wake_id INTEGER NOT NULL UNIQUE,
      delivered_at INTEGER,
      handled_at INTEGER
    );
    CREATE INDEX crew_responses_request ON crew_responses (request_id, contributor_task, at);
  `);
}
