import { addColumn } from "./addColumn";
import type { AppDatabase } from "./db";

/** Original captions stay with their messages, never copied into card evidence. */
export function addOriginalCaptainText(db: AppDatabase): void {
  addColumn(db, "card_messages", "captain_text", "TEXT");
  addColumn(db, "captain_asks", "captain_text", "TEXT");
  addColumn(db, "task_events", "captain_text", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS task_events_captain_source
    ON task_events (task_id, id DESC) WHERE kind = 'steered' AND actor = 'captain'`);
  // A source is a message identity, not an invented task or a second ledger.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decisions_correction_source
    ON decisions (wake) WHERE kind = 'correction'`);
}
