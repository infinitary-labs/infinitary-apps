import { taskFeedKind } from "@shared/feed";
import { type SQL_VIEWS, SQL_VIEWS_MAJOR, SQL_VIEWS_MINOR } from "@shared/sql";
import { taskFeedLine } from "../tasks/taskFeed";
import type { TaskEvent } from "./taskEventStore";
import type { TaskRecord } from "./taskStore";

/**
 * The published views of the app's record (plugin data surface, Phase B;
 * docs/ui-plugins.md "The record, through SQL"). The ONLY writer of view
 * SQL: a plugin's query reaches these names and nothing else, so the tables
 * can keep migrating underneath while the views stay the contract.
 *
 * Every name carries its version and is queried exactly as written
 * (`v_usage_v1`; captain's B5 b - no plain name, no aliasing). What moves a
 * view, and how:
 *
 * - ADDITIVE (a new column, a new view, a wider type, a new row kind):
 *   change the SELECT here, add the column to its pinned list below, and
 *   bump SQL_VIEWS_MINOR (src/shared/sql.ts). The name stays.
 * - BREAKING (a column removed, renamed or retyped; a row's meaning
 *   changed; a view removed): ship the new shape as `_v<N+1>` beside the
 *   old one, bump SQL_VIEWS_MAJOR, and keep the old view published for two
 *   releases before dropping it, with the release that retires it named in
 *   its entry's comment. Most breaks can be made additive (keep `cost`, add
 *   `cost_usd`); a new major is the exception its migration justifies.
 *
 * Views are derived, so they are re-created rather than altered: the
 * migration that published them creates them, every later migration drops
 * them first and re-creates them as its last step (a column a view reads
 * cannot otherwise be dropped or renamed underneath it), and every open
 * reconciles them against this file (`ensureViews`), so an edit here reaches
 * an existing database without a hand-written migration.
 *
 * `v_feed_v1`'s lines are authored by the same function the feed read uses
 * (`taskFeedLine`), registered as two SQL functions on every connection that
 * reads the views (`registerViewFunctions`), so a panel's feed can never say
 * something the app's own feed does not.
 */

export type PublishedView = {
  name: (typeof SQL_VIEWS)[number];
  /** The pinned column list, in order. Changing it is a contract change. */
  columns: readonly string[];
  select: string;
};

/** A task-less usage row is the Firstmate's own conversation (services.ts). */
const FIRSTMATE_TASK_ID = "firstmate";

const SLOT_VALUES = "('premium', 'high', 'medium', 'low')";

const LATEST_SNAPSHOT = "(SELECT MAX(id) FROM quota_snapshots)";

/**
 * `v_tasks_v1.basis`, written in place of this marker when the views are
 * made: the basis's own row (INF-1296 piece 2), or, on a database migrating
 * through the versions before that table, the shape field it was saved in.
 */
const BASIS_COLUMN = "/* basis */";
const BASIS_FROM_REFERENCES =
  "(SELECT b.ref FROM task_references b WHERE b.task_id = t.id AND b.kind = 'basis')";
const BASIS_FROM_SHAPE = "json_extract(t.shape_json, '$.basis')";

/**
 * `v_placements_v1`'s source, written in place of these markers when the
 * views are made: the task's execution row (INF-1296 piece 3), or, on a
 * database migrating through the versions before that table, the task row
 * that held the placement.
 */
const PLACEMENT_TABLE = "/* placement table */";

/**
 * How a task delivers, written in place of this marker when the views are
 * made: its change evidence row (INF-1296 piece 4), or, on a database
 * migrating through the versions before that table, its delivery column.
 */
const DELIVERY_MODE = "/* delivery mode */";
const MODE_FROM_EVIDENCE =
  "(SELECT COALESCE(x.mode, json_extract(x.evidence_json, '$.mode')) FROM task_delivery_evidence x WHERE x.task_id = t.id)";
const MODE_FROM_COLUMN = "json_extract(t.delivery_json, '$.mode')";
const PLACEMENT_TASK = "/* placement task */";

export const PUBLISHED_VIEWS: readonly PublishedView[] = [
  {
    name: "v_placements_v1",
    columns: [
      "task_id",
      "committed_at",
      "computer_id",
      "computer_name",
      "reservation",
      "snapshot_json",
    ],
    select: `SELECT ${PLACEMENT_TASK} AS task_id,
      json_extract(placement_json, '$.snapshot.at') AS committed_at,
      json_extract(placement_json, '$.snapshot.computerId') AS computer_id,
      json_extract(placement_json, '$.snapshot.computerName') AS computer_name,
      json_extract(placement_json, '$.reservation') AS reservation,
      json_remove(json_extract(placement_json, '$.snapshot'), '$.origin') AS snapshot_json
      FROM ${PLACEMENT_TABLE} WHERE placement_json IS NOT NULL`,
  },
  {
    name: "v_version_v1",
    columns: ["version", "major", "minor"],
    select: `SELECT '${SQL_VIEWS_MAJOR}.${SQL_VIEWS_MINOR}' AS version, ${SQL_VIEWS_MAJOR} AS major, ${SQL_VIEWS_MINOR} AS minor`,
  },
  {
    // The board's row, from the record. Provider, model and tier come from
    // the task's newest routing decision that chose a model - `tier` is the
    // slot it was SERVED at, the board's rule (router.ts servedSlots).
    // `basis` is the task the work builds on as the record names it (a key
    // or an id), the same string `tasks.detail` and the export carry.
    name: "v_tasks_v1",
    columns: [
      "task_id",
      "key",
      "project_key",
      "parent_id",
      "kind",
      "status",
      "activity",
      "closed_reason",
      "title",
      "goal",
      "priority",
      "repo_name",
      "branch",
      "assignee",
      "model",
      "provider",
      "tier",
      "deliverable",
      "rigor",
      "delivery",
      "created_at",
      "updated_at",
      "started_at",
      "closed_at",
      "basis",
    ],
    select: `SELECT
  t.id AS task_id,
  t.key AS key,
  p.key AS project_key,
  t.parent_id AS parent_id,
  t.kind AS kind,
  t.status AS status,
  t.activity AS activity,
  t.closed_reason AS closed_reason,
  t.title AS title,
  t.goal AS goal,
  t.priority AS priority,
  r.name AS repo_name,
  NULLIF(t.branch, '') AS branch,
  t.assignee AS assignee,
  d.model AS model,
  d.provider AS provider,
  CASE WHEN COALESCE(d.served, d.bucket) IN ${SLOT_VALUES} THEN COALESCE(d.served, d.bucket) END AS tier,
  json_extract(t.shape_json, '$.deliverable') AS deliverable,
  json_extract(t.shape_json, '$.rigor') AS rigor,
  ${DELIVERY_MODE} AS delivery,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.started_at AS started_at,
  t.closed_at AS closed_at,
  ${BASIS_COLUMN} AS basis
FROM tasks t
LEFT JOIN projects p ON p.id = t.project_id
LEFT JOIN repos r ON r.id = t.repo_id
LEFT JOIN routing_decisions d ON d.id = (
  SELECT id FROM routing_decisions
  WHERE task_id = t.id AND provider IS NOT NULL
  ORDER BY at DESC, id DESC LIMIT 1
)`,
  },
  {
    // A task's timeline as the record pane shows it: the capture machinery
    // (`decided`, R2) is not the captain's history, and no row's data
    // payload is published.
    name: "v_task_events_v1",
    columns: ["task_id", "key", "at", "kind", "text", "feed"],
    select: `SELECT
  e.task_id AS task_id,
  t.key AS key,
  e.at AS at,
  e.kind AS kind,
  e.text AS text,
  e.feed AS feed
FROM task_events e
JOIN tasks t ON t.id = e.task_id
WHERE e.kind <> 'decided'`,
  },
  {
    // One row per model request on Pi, per turn and served model on Claude
    // (per turn alone before migration 66), as the ledger recorded it. A
    // cost the session could not price is null, where an older row may
    // hold 0 that proves nothing. The Firstmate's own burn
    // is its own row, keyed FIRSTMATE. The account is named by the label
    // the captain gave it, read from the latest quota reading; never by
    // its internal id.
    name: "v_usage_v1",
    columns: [
      "id",
      "at",
      "task_id",
      "key",
      "title",
      "status",
      "activity",
      "provider",
      "model",
      "account_label",
      "input",
      "output",
      "cache_read",
      "cache_write",
      "cost",
    ],
    select: `WITH labels AS MATERIALIZED (
  SELECT json_extract(p.value, '$.accountId') AS account_id,
         MAX(json_extract(p.value, '$.accountLabel')) AS label
  FROM quota_snapshots q, json_each(q.json, '$.providers') p
  WHERE q.id = ${LATEST_SNAPSHOT} AND json_extract(p.value, '$.accountId') IS NOT NULL
  GROUP BY json_extract(p.value, '$.accountId')
)
SELECT
  u.id AS id,
  u.at AS at,
  u.task_id AS task_id,
  CASE WHEN u.task_id = '${FIRSTMATE_TASK_ID}' THEN 'FIRSTMATE' ELSE t.key END AS key,
  CASE WHEN u.task_id = '${FIRSTMATE_TASK_ID}' THEN 'First mate' ELSE t.title END AS title,
  t.status AS status,
  t.activity AS activity,
  u.provider AS provider,
  u.model AS model,
  l.label AS account_label,
  u.input AS input,
  u.output AS output,
  u.cache_read AS cache_read,
  u.cache_write AS cache_write,
  u.cost AS cost
FROM usage_events u
LEFT JOIN tasks t ON t.id = u.task_id
LEFT JOIN labels l ON l.account_id = u.account_id`,
  },
  {
    // What `feed.recent` renders: the feed-worthy timeline rows, authored
    // by the app's own feed function, and the task-less activity lines.
    name: "v_feed_v1",
    columns: ["at", "kind", "text", "task_key"],
    select: `SELECT
  e.at AS at,
  fm_feed_kind(e.kind, e.data_json) AS kind,
  fm_feed_text(e.kind, e.text, e.data_json, t.assignee,
    CASE WHEN t.delivery_json IS NOT NULL THEN json_object('mode', ${DELIVERY_MODE}) END) AS text,
  t.key AS task_key
FROM task_events e
JOIN tasks t ON t.id = e.task_id
WHERE e.feed = 1
UNION ALL
SELECT a.at AS at, a.kind AS kind, a.text AS text, NULL AS task_key
FROM activity_events a`,
  },
  {
    // The latest quota reading, one row per window, and one row with a null
    // window for an account the sensor read no window for. The sensor's
    // honesty travels in the columns: `status` (only `auth_required` is a
    // sign-out), `stale` with its `measured_at`, and a null
    // `percent_remaining` that is unknown, never zero.
    name: "v_quota_windows_v1",
    columns: [
      "provider",
      "account_label",
      "plan",
      "status",
      "stale",
      "measured_at",
      "window_id",
      "label",
      "percent_remaining",
      "pace",
      "resets_at",
    ],
    select: `SELECT
  json_extract(p.value, '$.provider') AS provider,
  json_extract(p.value, '$.accountLabel') AS account_label,
  json_extract(p.value, '$.plan') AS plan,
  json_extract(p.value, '$.status') AS status,
  json_extract(p.value, '$.stale') AS stale,
  COALESCE(json_extract(p.value, '$.measuredAt'), q.fetched_at) AS measured_at,
  json_extract(w.value, '$.id') AS window_id,
  json_extract(w.value, '$.label') AS label,
  json_extract(w.value, '$.percentRemaining') AS percent_remaining,
  json_extract(w.value, '$.pace') AS pace,
  json_extract(w.value, '$.resetsAtMs') AS resets_at
FROM quota_snapshots q
JOIN json_each(q.json, '$.providers') p
LEFT JOIN json_each(p.value, '$.windows') w
WHERE q.id = ${LATEST_SNAPSHOT}`,
  },
  {
    name: "v_routing_v1",
    columns: ["at", "task_id", "key", "provider", "model", "bucket", "served", "rule"],
    select: `SELECT
  d.at AS at,
  d.task_id AS task_id,
  t.key AS key,
  d.provider AS provider,
  d.model AS model,
  d.bucket AS bucket,
  d.served AS served,
  d.rule AS rule
FROM routing_decisions d
LEFT JOIN tasks t ON t.id = d.task_id`,
  },
  {
    name: "v_projects_v1",
    columns: ["id", "key", "name", "archived"],
    select: `SELECT id AS id, key AS key, name AS name, (archived_at IS NOT NULL) AS archived FROM projects`,
  },
  {
    name: "v_repos_v1",
    columns: ["id", "name", "kind", "delivery", "autonomy", "rigor"],
    select: `SELECT id AS id, name AS name, kind AS kind, delivery AS delivery, autonomy AS autonomy, rigor AS rigor FROM repos`,
  },
];

/**
 * The decision ledger's three old names (the primitives review, P6;
 * migration 50): read-only views over the one `decisions` table, one per
 * kind, with each old table's columns in its order. They are not published
 * - a plugin's query reaches only `PUBLISHED_VIEWS` - and nothing writes
 * through them: `DecisionStore` is the ledger's one writer. They keep every
 * reader of the old tables reading the same rows: the published views
 * above, the exporters and the miss deriver over an exported database old
 * or new, and the replay scorer. A rule-sorted row's `model` is its
 * `rule:<id>` stamp, as it was before the rule moved to its own column;
 * `facts_json` is the one column the ledger added to a sort row.
 */
export const LEDGER_VIEWS: readonly { name: string; select: string }[] = [
  {
    name: "routing_decisions",
    select: `SELECT id, task_id, provider, model, bucket, reasons_json, at, rule, served
FROM decisions WHERE kind = 'routing'`,
  },
  {
    name: "account_decisions",
    select: `SELECT id, task_id, provider, account_id, reasons_json, at
FROM decisions WHERE kind = 'account'`,
  },
  {
    name: "supervision_outcomes",
    select: `SELECT id, task_id, wake, verdict, summary, at, card_id,
  CASE WHEN rule IS NULL THEN model ELSE 'rule:' || rule END AS model,
  prompt_sha, tools_sha, steered, wake_kind, missed_escalation, missed_note, missed_at, facts_json
FROM decisions WHERE kind = 'sort'`,
  },
];

/** What every connection that reads the views needs: `exec` and scalar functions. */
export type ViewConnection = {
  exec(sql: string): unknown;
  function(
    name: string,
    options: { deterministic: boolean },
    fn: (...args: unknown[]) => string | null,
  ): unknown;
};

/** What reading the schema needs; both better-sqlite3 and node:sqlite answer it. */
export type SchemaReader = ViewConnection & {
  prepare(sql: string): { all(...params: never[]): unknown[] };
};

function parseData(json: unknown): Record<string, unknown> | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `fm_feed_text` and `fm_feed_kind`: the feed line and its tone for one
 * feed-worthy timeline row, authored by `taskFeedLine` exactly as the feed
 * read authors it. Registered on the core's connection and on the query
 * process's, because a view is only as readable as its functions.
 */
export function registerViewFunctions(db: ViewConnection): void {
  db.function(
    "fm_feed_text",
    { deterministic: true },
    (kind: unknown, text: unknown, data: unknown, assignee: unknown, delivery: unknown) => {
      const event = {
        kind: asText(kind),
        text: asText(text),
        data: parseData(data),
        feed: true,
        at: 0,
      } as Pick<TaskEvent, "kind" | "text" | "data" | "feed" | "at"> as TaskEvent;
      const record = {
        key: "",
        assignee: typeof assignee === "string" ? assignee : null,
        delivery: parseData(delivery) as TaskRecord["delivery"],
      };
      return taskFeedLine(record, event)?.text ?? null;
    },
  );
  db.function("fm_feed_kind", { deterministic: true }, (kind: unknown, data: unknown) => {
    const status = parseData(data)?.status;
    return taskFeedKind(
      asText(kind),
      typeof status === "string" && status.trim() ? status : undefined,
    );
  });
}

const VIEW_NAME_GLOB = "v_*_v[0-9]*";

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function viewSql(view: { name: string; select: string }): string {
  return `CREATE VIEW ${quoted(view.name)} AS\n${view.select}`;
}

/** Every versioned view in the database, published by this version or not. */
function existingViews(db: SchemaReader): { name: string; sql: string }[] {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name GLOB '${VIEW_NAME_GLOB}'`,
    )
    .all() as { name: string; sql: string }[];
}

/** The ledger's old names that are views in this database (none before migration 50). */
function existingLedgerViews(db: SchemaReader): { name: string; sql: string }[] {
  const names = LEDGER_VIEWS.map((view) => `'${view.name}'`).join(", ");
  return db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name IN (${names})`)
    .all() as { name: string; sql: string }[];
}

/** Whether the one decision ledger exists yet (migration 50). */
function hasLedger(db: SchemaReader): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'decisions'").all()
      .length > 0
  );
}

export function dropViews(db: SchemaReader): void {
  for (const view of existingViews(db)) db.exec(`DROP VIEW ${quoted(view.name)}`);
  for (const view of existingLedgerViews(db)) db.exec(`DROP VIEW ${quoted(view.name)}`);
}

/**
 * The ledger's views first, where the ledger exists, because the published
 * views read `routing_decisions` by that name: the table before migration
 * 50, the view over `decisions` after it.
 */
export function createViews(db: SchemaReader): void {
  dropViews(db);
  if (hasLedger(db)) for (const view of LEDGER_VIEWS) db.exec(viewSql(view));
  for (const view of publishedViews(db)) db.exec(viewSql(view));
}

/** Whether a table a view reads exists yet (INF-1296 pieces 2 to 4). */
function hasTable(db: SchemaReader, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '${name}'`).all()
      .length > 0
  );
}

/** The published views as this database can read them. */
function publishedViews(db: SchemaReader): PublishedView[] {
  const basis = hasTable(db, "task_references") ? BASIS_FROM_REFERENCES : BASIS_FROM_SHAPE;
  const executing = hasTable(db, "task_execution");
  const mode = hasTable(db, "task_delivery_evidence") ? MODE_FROM_EVIDENCE : MODE_FROM_COLUMN;
  return PUBLISHED_VIEWS.map((view) => ({
    ...view,
    select: view.select
      .replace(BASIS_COLUMN, basis)
      .replace(PLACEMENT_TABLE, executing ? "task_execution" : "tasks")
      .replace(PLACEMENT_TASK, executing ? "task_id" : "id")
      .replaceAll(DELIVERY_MODE, mode),
  }));
}

/**
 * Whether the database's views are exactly this file's. The caller wraps a
 * re-create in its own transaction.
 */
export function viewsCurrent(db: SchemaReader): boolean {
  const ledger = hasLedger(db) ? LEDGER_VIEWS : [];
  const existing = new Map(
    [...existingViews(db), ...existingLedgerViews(db)].map((view) => [view.name, view.sql]),
  );
  if (existing.size !== PUBLISHED_VIEWS.length + ledger.length) return false;
  return [...ledger, ...publishedViews(db)].every(
    (view) => existing.get(view.name) === viewSql(view),
  );
}

/**
 * Migration 42's body: the indexes the views' joins lean on, then the views.
 * `usage_events (at)` serves a dashboard's time window; `routing_decisions
 * (task_id, at)` serves `v_tasks_v1`'s newest-decision lookup.
 */
export function migratePublishedViews(db: SchemaReader): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at);
    CREATE INDEX IF NOT EXISTS usage_events_task ON usage_events (task_id, at);
    CREATE INDEX IF NOT EXISTS routing_decisions_task ON routing_decisions (task_id, at);
  `);
  createViews(db);
}
