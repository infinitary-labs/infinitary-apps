import type { AppDatabase } from "./db";

/**
 * The usage ledger's daily totals (docs/usage.md, "Daily totals"), kept so
 * Settings → Usage and Observe add up a few rows per task and day instead
 * of every `usage_events` row on each read (INF-4393 measured 100-380 ms of
 * main-thread time per read over 226,027 events).
 *
 * One `usage_days` row holds every ledger row of one local day, task,
 * provider, recorded model, model source and price source, summed into the
 * columns the reads add up again. It is derived, never a second ledger: the
 * ledger stays the one record, and these tables can be dropped and rebuilt
 * from it at any time. So they add no migration or saved-data format, and
 * an older build that opens the record ignores them.
 *
 * `usage_days_state` says through which ledger row the totals are folded
 * and in which time zone their days were counted. Each read first folds the
 * rows written since, whoever wrote them, and counts every day again when
 * the time zone changed, since a local day is the zone's.
 */

const TABLES = `
  CREATE TABLE IF NOT EXISTS usage_days (
    day TEXT NOT NULL,
    task_id TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    model_source TEXT,
    cost_source TEXT,
    records INTEGER NOT NULL,
    counted INTEGER NOT NULL,
    reported_input INTEGER NOT NULL,
    reported_output INTEGER NOT NULL,
    reported_cache_read INTEGER NOT NULL,
    reported_cache_write INTEGER NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost REAL,
    priced INTEGER NOT NULL,
    cost_input REAL,
    cost_output REAL,
    cost_cache_read REAL,
    cost_cache_write REAL,
    split INTEGER NOT NULL,
    cost_reported_input INTEGER NOT NULL,
    cost_reported_output INTEGER NOT NULL,
    cost_reported_cache_read INTEGER NOT NULL,
    cost_reported_cache_write INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_days_key
    ON usage_days (task_id, provider, model, model_source, cost_source, day);
  CREATE INDEX IF NOT EXISTS usage_days_day ON usage_days (day);
  CREATE TABLE IF NOT EXISTS usage_days_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    zone TEXT NOT NULL,
    through INTEGER NOT NULL
  );
`;

/** What a day's row adds up: the columns of `usage_days` after its key. */
export const USAGE_DAY_AMOUNTS = [
  "records",
  "counted",
  "reported_input",
  "reported_output",
  "reported_cache_read",
  "reported_cache_write",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "cost",
  "priced",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "split",
  "cost_reported_input",
  "cost_reported_output",
  "cost_reported_cache_read",
  "cost_reported_cache_write",
] as const;

/** An estimate column: null while nothing it sums was priced, never zero. */
function isEstimate(column: string): boolean {
  return column === "cost" || (column.startsWith("cost_") && !column.startsWith("cost_reported"));
}

/**
 * The SQL that adds up day rows into one amount's columns. SUM skips a
 * null, so an estimate nothing priced stays null, as over the ledger.
 */
export const USAGE_DAY_SUMS = USAGE_DAY_AMOUNTS.map((column) =>
  isEstimate(column) ? `SUM(${column}) AS ${column}` : `COALESCE(SUM(${column}), 0) AS ${column}`,
).join(",\n                ");

const KEY = ["day", "task_id", "provider", "model", "model_source", "cost_source"] as const;

/**
 * A record with a price: a positive estimate, or zero from prices a person
 * stated for a free model. Any other zero is a price nobody knew, which Pi
 * reports as zero (`usageFromMessage`), so it stays unpriced.
 */
// i18n-exempt: SQL, never shown.
export const PRICED_RECORD = "(cost > 0 OR (cost = 0 AND cost_source = 'listed-prices'))";

/** The ledger rows after one id, summed by day and key: what a fold adds. */
const LEDGER_DAYS = `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day,
       task_id, provider, model, model_source, cost_source,
       COUNT(*) AS records,
       SUM(input IS NOT NULL OR output IS NOT NULL
           OR cache_read IS NOT NULL OR cache_write IS NOT NULL) AS counted,
       COUNT(input) AS reported_input,
       COUNT(output) AS reported_output,
       COUNT(cache_read) AS reported_cache_read,
       COUNT(cache_write) AS reported_cache_write,
       COALESCE(SUM(input), 0) AS input,
       COALESCE(SUM(output), 0) AS output,
       COALESCE(SUM(cache_read), 0) AS cache_read,
       COALESCE(SUM(cache_write), 0) AS cache_write,
       SUM(CASE WHEN ${PRICED_RECORD} THEN cost END) AS cost,
       SUM(CASE WHEN ${PRICED_RECORD} THEN 1 ELSE 0 END) AS priced,
       SUM(CASE WHEN ${PRICED_RECORD} THEN cost_input END) AS cost_input,
       SUM(CASE WHEN ${PRICED_RECORD} THEN cost_output END) AS cost_output,
       SUM(CASE WHEN ${PRICED_RECORD} THEN cost_cache_read END) AS cost_cache_read,
       SUM(CASE WHEN ${PRICED_RECORD} THEN cost_cache_write END) AS cost_cache_write,
       SUM(CASE WHEN ${PRICED_RECORD} AND (cost_input IS NOT NULL OR cost_output IS NOT NULL
           OR cost_cache_read IS NOT NULL OR cost_cache_write IS NOT NULL)
           THEN 1 ELSE 0 END) AS split,
       SUM(CASE WHEN ${PRICED_RECORD} AND cost_input IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_input,
       SUM(CASE WHEN ${PRICED_RECORD} AND cost_output IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_output,
       SUM(CASE WHEN ${PRICED_RECORD} AND cost_cache_read IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_cache_read,
       SUM(CASE WHEN ${PRICED_RECORD} AND cost_cache_write IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_cache_write,
       MIN(at) AS first_at, MAX(at) AS last_at
FROM usage_events
WHERE id > @after AND id <= @through
GROUP BY day, task_id, provider, model, model_source, cost_source`;

const COLUMNS = [...KEY, ...USAGE_DAY_AMOUNTS, "first_at", "last_at"];

const INSERT = `INSERT INTO usage_days (${COLUMNS.join(", ")})
  VALUES (${COLUMNS.map((column) => `@${column}`).join(", ")})`;

/** Adds a fold's sums to its day's row; a null estimate leaves the row's as it was. */
const ADD = `UPDATE usage_days SET
  ${USAGE_DAY_AMOUNTS.map((column) =>
    isEstimate(column)
      ? `${column} = CASE WHEN @${column} IS NULL THEN ${column} ELSE COALESCE(${column}, 0) + @${column} END`
      : `${column} = ${column} + @${column}`,
  ).join(",\n  ")},
  first_at = MIN(first_at, @first_at),
  last_at = MAX(last_at, @last_at)
  WHERE task_id = @task_id AND day = @day AND provider IS @provider AND model IS @model
    AND model_source IS @model_source AND cost_source IS @cost_source`;

type DayRow = Record<(typeof COLUMNS)[number], string | number | null>;

/** The time zone local days are counted in, as this process reads it. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}

const made = new WeakSet<AppDatabase>();

/**
 * Makes the daily totals' tables on a record that lacks them, at the first
 * read on each connection. No migration makes them, so a record reversed
 * to an older migration holds only what that migration made until Usage is
 * read; the statement check's planner makes them to plan their reads.
 */
export function createUsageDays(db: AppDatabase): void {
  if (made.has(db)) return;
  db.exec(TABLES);
  made.add(db);
}

/**
 * Brings the daily totals up to the ledger's newest row: folds the rows
 * written since the last fold, or counts every day again when there is no
 * fold yet or the time zone changed. Call it before reading `usage_days`.
 */
export function foldUsageDays(db: AppDatabase): void {
  createUsageDays(db);
  const zone = localZone();
  const state = db.prepare("SELECT zone, through FROM usage_days_state WHERE id = 1").get() as
    | { zone: string; through: number }
    | undefined;
  const { newest } = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS newest FROM usage_events")
    .get() as {
    newest: number;
  };
  if (state && state.zone === zone && state.through >= newest) return;
  db.transaction(() => {
    if (!state || state.zone !== zone) {
      db.prepare("DELETE FROM usage_days").run();
      db.prepare(
        `INSERT INTO usage_days (${COLUMNS.join(", ")}) SELECT ${COLUMNS.join(", ")} FROM (${LEDGER_DAYS})`,
      ).run({ after: 0, through: newest });
    } else {
      const add = db.prepare(ADD);
      const insert = db.prepare(INSERT);
      const rows = db
        .prepare(LEDGER_DAYS)
        .all({ after: state.through, through: newest }) as DayRow[];
      for (const row of rows) if (add.run(row).changes === 0) insert.run(row);
    }
    db.prepare(
      `INSERT INTO usage_days_state (id, zone, through) VALUES (1, @zone, @through)
       ON CONFLICT (id) DO UPDATE SET zone = excluded.zone, through = excluded.through`,
    ).run({ zone, through: newest });
  })();
}
