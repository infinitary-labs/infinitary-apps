/**
 * The recorded tables the interaction evals read (P3: WI-19 replay harness,
 * WI-20 duplicate deriver), from either source a session arrives in:
 *
 * - an exported `firstmate.db` (read-only, `SELECT *`, so a database from
 *   before or after any migration reads without a column list to keep in
 *   sync), or
 * - a scrubbed JSON dump (`tables.json`: `{ "<table>": [row, ...] }`, column
 *   names exactly as in SQLite), which is how the committed replay fixtures
 *   carry their rows - a binary database cannot be reviewed or scrubbed.
 *
 * A table the source does not hold reads as empty: a database from before
 * the card threads (migration 38) has no `card_messages`, and neither does a
 * fixture exported before the replay read them.
 *
 * `scrubRecording` is the one scrub pass every exported fixture goes
 * through (Observe's redaction on every string, image payloads dropped).
 * Read-only toward the app: nothing here writes a database.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { redactObserveText } from "../src/core/observe/redact.ts";
import { savedDeliveryReader } from "../src/core/storage/taskDeliveryFields.ts";
import { savedShapeReader } from "../src/core/storage/taskReferenceFields.ts";

export const RECORDED_TABLE_NAMES = [
  "tasks",
  "cards",
  "supervision_outcomes",
  "captain_asks",
  "card_messages",
] as const;

export type RecordedTableName = (typeof RECORDED_TABLE_NAMES)[number];

export type TableRow = Record<string, unknown>;

export type RecordedTables = Record<RecordedTableName, TableRow[]>;

export function emptyTables(): RecordedTables {
  return { tasks: [], cards: [], supervision_outcomes: [], captain_asks: [], card_messages: [] };
}

/** A path ending in `.json` is a dump; anything else is a SQLite database. */
export function readRecordedTables(path: string): RecordedTables {
  return path.endsWith(".json") ? readTablesDump(path) : readTablesDatabase(path);
}

function readTablesDump(path: string): RecordedTables {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const tables = emptyTables();
  for (const name of RECORDED_TABLE_NAMES) {
    const rows = parsed[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`${path}: "${name}" must be an array of rows`);
    tables[name] = rows.filter((row): row is TableRow => Boolean(row) && typeof row === "object");
  }
  return tables;
}

function readTablesDatabase(path: string): RecordedTables {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    // Tables and views: since migration 50 `supervision_outcomes` is a
    // view over the one decision ledger, with the same rows.
    const present = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const tables = emptyTables();
    for (const name of RECORDED_TABLE_NAMES) {
      if (!present.has(name)) continue;
      tables[name] = db.prepare(`SELECT * FROM ${name}`).all() as TableRow[];
    }
    // A task's shape as the app reads it, its references in it.
    const shapeOf = savedShapeReader(db);
    for (const row of tables.tasks)
      if (typeof row.id === "string" && "shape_json" in row)
        row.shape_json = shapeOf(row.id, row.shape_json as string | null);
    // Its delivery facts as the app reads them, its evidence and permissions in them.
    const deliveryOf = savedDeliveryReader(db);
    for (const row of tables.tasks)
      if (typeof row.id === "string" && "delivery_json" in row)
        row.delivery_json = deliveryOf(row.id, row.delivery_json as string | null);
    return tables;
  } finally {
    db.close();
  }
}

/**
 * Scrub one recorded value for a committed fixture: every string through
 * Observe's redaction, and inline image payloads (base64 `data` beside an
 * image `mimeType`) replaced by a marker - they are never evidence.
 */
export function scrubRecording(value: unknown): unknown {
  if (typeof value === "string") return redactObserveText(value);
  if (Array.isArray(value)) return value.map((item) => scrubRecording(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isImage =
    record.type === "image" ||
    (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (isImage && key === "data") {
      out[key] = "[image omitted]";
      continue;
    }
    if (key === "images_json" && typeof inner === "string" && inner) {
      out[key] = "[images omitted]";
      continue;
    }
    out[key] = scrubRecording(inner);
  }
  return out;
}

/** Numeric column, or null when absent or not a number. */
export function numberColumn(row: TableRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** String column, or null when absent or empty. */
export function stringColumn(row: TableRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value ? value : null;
}
