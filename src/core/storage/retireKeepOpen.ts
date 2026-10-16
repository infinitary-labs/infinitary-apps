import type { CardAnswer } from "@shared/cards";
import type { AppDatabase } from "./db";

/** Migration 73: retain exact originals before retiring the saved click path. */
export function retireKeepOpen(db: AppDatabase): void {
  db.exec(`CREATE TABLE keep_open_backfill (
    source TEXT NOT NULL,
    row_id TEXT NOT NULL,
    original_json TEXT NOT NULL,
    migrated_at INTEGER NOT NULL,
    PRIMARY KEY (source, row_id)
  )`);
  const keep = db.prepare("INSERT INTO keep_open_backfill VALUES (?, ?, ?, ?)");
  const now = Date.now();
  const cards = db
    .prepare("SELECT id, actions_json, status FROM cards WHERE resolved_at IS NULL")
    .all() as { id: string; actions_json: string; status: string }[];
  const updateCard = db.prepare("UPDATE cards SET actions_json = ?, status = ? WHERE id = ?");
  for (const row of cards) {
    let actions: unknown;
    try {
      actions = JSON.parse(row.actions_json);
    } catch {
      /* Unreadable actions stay untouched. */
    }
    const remaining = Array.isArray(actions)
      ? actions.filter((action) => action?.keepsOpen !== true)
      : null;
    const removed =
      Array.isArray(actions) && remaining !== null && remaining.length !== actions.length;
    const status = row.status === "streaming" ? "ready" : row.status;
    if (!removed && status === row.status) continue;
    keep.run("cards", row.id, JSON.stringify(row), now);
    updateCard.run(removed ? JSON.stringify(remaining) : row.actions_json, status, row.id);
  }
  const inbox = db.prepare("SELECT id, payload FROM inbox").all() as {
    id: number;
    payload: string;
  }[];
  const updateWake = db.prepare("UPDATE inbox SET payload = ? WHERE id = ?");
  for (const row of inbox) {
    let wake: { v?: number; facts?: LegacyExplain };
    try {
      wake = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (wake?.v !== 1 || wake.facts?.kind !== "card-explain") continue;
    const text = frozenExplain(wake.facts);
    keep.run("inbox", String(row.id), JSON.stringify(row), now);
    updateWake.run(JSON.stringify({ v: 1, text }), row.id);
  }
}

type LegacyExplain = {
  kind: "card-explain";
  to: "firstmate" | "crewmate";
  source?: "chrome" | "frame";
  card: { id: string; title: string };
  choice: { id: string; label: string; value?: string; answers?: CardAnswer[] };
};

/** Frozen migration words, independent of future live wake rendering. */
function frozenExplain(facts: LegacyExplain): string {
  const choice = facts.choice;
  const value = choice.value !== undefined ? `\nCard action value (JSON): ${choice.value}` : "";
  const lines = choice.answers?.map((answer) => {
    const parts = answer.json
      ? [`${answer.values[0] ?? ""} (JSON)`]
      : answer.values.map((value, index) => {
          const label = answer.labels?.[index];
          return label && label !== value
            ? `${JSON.stringify(label)} (${value})`
            : JSON.stringify(value);
        });
    if (answer.written !== undefined) parts.push(`written in: ${JSON.stringify(answer.written)}`);
    return `- ${answer.name}: ${parts.length === 0 ? "no answer" : parts.join(", ")}, ${answer.changed ? "changed" : "as proposed"}`;
  });
  const answers = lines?.length
    ? `\n${facts.source === "frame" ? "The script submitted answers" : "The user's answers"} to the card's questions:\n${lines.join("\n")}`
    : "";
  const ask = `${facts.source === "frame" ? "a script" : "the user"} chose "${choice.label}" (${choice.id}) on card "${facts.card.title}" (${facts.card.id}). The card stays open: revise it with emit_card under the same id, keeping its decision and default.${value}${answers}`;
  return facts.to === "firstmate" ? `[fm-op] ${ask}` : `Card choice: ${ask}`;
}
