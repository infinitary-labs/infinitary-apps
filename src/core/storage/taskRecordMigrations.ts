import { existsSync } from "node:fs";
import type { WorkShape } from "@shared/routingPolicy";
import type { AppDatabase } from "./db";
import { ensureRepoProject, ensureScratchProject, SCRATCH_PROJECT_ID } from "./projectStore";
import { TaskDeliveryStore } from "./taskDeliveryStore";
import { splitTurn } from "./taskExecutionStore";
import { splitPolicies } from "./taskPolicyStore";
import { conversationOf } from "./taskSessionStore";

/**
 * The task record's migrations (task-system design P0 and INF-1296), in the
 * order the ledger runs them (migrations.ts): the record itself, its graph
 * and timeline, the backfills that keep its rows truthful, and the moves of
 * a task's references, running work, policies and delivery facts to rows of
 * their own. Each is a step of the ledger and runs once, by its number.
 */

const TASK_RECORD_COLUMNS = `
  ALTER TABLE tasks ADD COLUMN key TEXT;
  ALTER TABLE tasks ADD COLUMN seq INTEGER;
  ALTER TABLE tasks ADD COLUMN project_id TEXT;
  ALTER TABLE tasks ADD COLUMN parent_id TEXT;
  ALTER TABLE tasks ADD COLUMN activity TEXT;
  ALTER TABLE tasks ADD COLUMN closed_reason TEXT;
  ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE tasks ADD COLUMN goal TEXT;
  ALTER TABLE tasks ADD COLUMN intent_json TEXT;
  ALTER TABLE tasks ADD COLUMN outcome TEXT;
  ALTER TABLE tasks ADD COLUMN outcome_summary TEXT;
  ALTER TABLE tasks ADD COLUMN delivery_json TEXT;
  ALTER TABLE tasks ADD COLUMN pending_settle_json TEXT;
  ALTER TABLE tasks ADD COLUMN shape_json TEXT;
  ALTER TABLE tasks ADD COLUMN assignee TEXT;
  ALTER TABLE tasks ADD COLUMN model TEXT;
  ALTER TABLE tasks ADD COLUMN start_policy TEXT NOT NULL DEFAULT 'when-ready';
  ALTER TABLE tasks ADD COLUMN workspace_state TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE tasks ADD COLUMN updated_at INTEGER;
  ALTER TABLE tasks ADD COLUMN started_at INTEGER;
  ALTER TABLE tasks ADD COLUMN closed_at INTEGER;
  ALTER TABLE tasks ADD COLUMN idle_since INTEGER;
  ALTER TABLE tasks ADD COLUMN recovery_rung INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN recovery_at INTEGER;
  ALTER TABLE tasks ADD COLUMN test_path TEXT;
  ALTER TABLE tasks ADD COLUMN captain_opened_at INTEGER;
  ALTER TABLE tasks ADD COLUMN verdict TEXT;
`;

type LegacyTaskRow = {
  id: string;
  kind: string;
  repo_id: string | null;
  worktree_dir: string;
  status: string;
  created_at: number;
};

/**
 * The status mapping (design section 4.1), applied once at migration:
 * queued -> open (the gate stays as the hold); running/idle/interrupted ->
 * active with that activity; completed -> done/finished (WI-11 retired the
 * `delivered` status - an idle crewmate with unlanded work stays `active`,
 * and a completed legacy row is closed history either way); cancelled/failed
 * -> dropped with the reason; a parked decision row -> kind decision, open,
 * still held by its captain gate (the card id stays in gate_ref).
 */
export function mapLegacyStatus(row: { status: string; worktree_dir: string }): {
  status: string;
  activity: string | null;
  closedReason: string | null;
} {
  switch (row.status) {
    case "queued":
      return { status: "open", activity: null, closedReason: null };
    case "running":
    case "idle":
    case "interrupted":
      return { status: "active", activity: row.status, closedReason: null };
    case "completed":
      return { status: "done", activity: null, closedReason: "finished" };
    case "cancelled":
      return { status: "dropped", activity: null, closedReason: "cancelled" };
    case "failed":
      return { status: "dropped", activity: null, closedReason: "failed" };
    default:
      // A value this build does not know (a newer schema's, or a hand edit)
      // keeps its own status rather than being guessed into another one.
      return { status: row.status, activity: null, closedReason: null };
  }
}

export function migrateTaskRecord(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo_id TEXT UNIQUE,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
  `);
  db.exec(TASK_RECORD_COLUMNS);
  const now = Date.now();
  ensureScratchProject(db, now);
  const repos = db.prepare("SELECT id, name, added_at FROM repos ORDER BY added_at, id").all() as {
    id: string;
    name: string;
    added_at: number;
  }[];
  for (const repo of repos) ensureRepoProject(db, repo, repo.added_at);

  const rows = db
    .prepare(
      "SELECT id, kind, repo_id, worktree_dir, status, created_at FROM tasks ORDER BY created_at, id",
    )
    .all() as LegacyTaskRow[];
  const projectKeys = new Map<string, { key: string; next: number }>();
  for (const project of db.prepare("SELECT id, key FROM projects").all() as {
    id: string;
    key: string;
  }[]) {
    projectKeys.set(project.id, { key: project.key, next: 1 });
  }
  const update = db.prepare(
    `UPDATE tasks SET key = ?, seq = ?, project_id = ?, status = ?, activity = ?, closed_reason = ?,
       workspace_state = ?, updated_at = created_at
     WHERE id = ?`,
  );
  for (const row of rows) {
    const repoProject = row.repo_id ? projectKeys.get(`proj-${row.repo_id}`) : undefined;
    const projectId = repoProject && row.repo_id ? `proj-${row.repo_id}` : SCRATCH_PROJECT_ID;
    const counter = projectKeys.get(projectId) as { key: string; next: number };
    const seq = counter.next;
    counter.next += 1;
    const mapped = mapLegacyStatus(row);
    update.run(
      `${counter.key}-${seq}`,
      seq,
      projectId,
      mapped.status,
      mapped.activity,
      mapped.closedReason,
      row.worktree_dir ? "present" : "none",
      row.id,
    );
  }
  const bump = db.prepare("UPDATE projects SET next_seq = ? WHERE id = ?");
  for (const [projectId, counter] of projectKeys) bump.run(counter.next, projectId);
  db.exec(`
    CREATE UNIQUE INDEX tasks_key ON tasks (key);
    CREATE INDEX tasks_project_status ON tasks (project_id, status);
    CREATE INDEX tasks_parent ON tasks (parent_id);
  `);
}

export function migrateTaskGraph(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_links (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    );
    CREATE INDEX task_links_to ON task_links (to_id, type);
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      data_json TEXT,
      ref TEXT,
      feed INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX task_events_task ON task_events (task_id, at);
    CREATE INDEX task_events_at ON task_events (at);
    CREATE TABLE captain_asks (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      text TEXT NOT NULL,
      images_json TEXT,
      hint_task_id TEXT,
      task_id TEXT,
      attached_via TEXT,
      attached_at INTEGER,
      turn_state TEXT NOT NULL
    );
    CREATE INDEX captain_asks_task ON captain_asks (task_id);
  `);
  // The after-task gate was a one-to-one forward pointer; the same wait as
  // a blocks edge, only when its target still exists (a missing target
  // meant "dispatch" already). Either way the gate columns clear.
  const gated = db
    .prepare("SELECT id, gate_ref FROM tasks WHERE gate_kind = 'after-task'")
    .all() as { id: string; gate_ref: string | null }[];
  const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?");
  const link = db.prepare(
    "INSERT OR IGNORE INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, 'blocks', 'host', ?)",
  );
  const clear = db.prepare(
    "UPDATE tasks SET gate_kind = NULL, gate_ref = NULL, gate_until = NULL, gate_reason = NULL WHERE id = ?",
  );
  const now = Date.now();
  for (const row of gated) {
    if (row.gate_ref && exists.get(row.gate_ref)) link.run(row.gate_ref, row.id, now);
    clear.run(row.id);
  }
}

export function migrateCreatedEvents(db: AppDatabase): void {
  db.exec(`
    INSERT INTO task_events (task_id, at, actor, kind, text, feed)
      SELECT id, created_at, 'host', 'created', 'created "' || title || '"', 0
      FROM tasks ORDER BY created_at, id;
  `);
}

export function migrateTaskHygiene(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_hygiene_backfill (
      task_id TEXT NOT NULL,
      column_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      migrated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, column_name)
    );
  `);
  const now = Date.now();
  const log = db.prepare(
    "INSERT INTO task_hygiene_backfill (task_id, column_name, old_value, new_value, migrated_at) VALUES (?, ?, ?, ?, ?)",
  );
  // The close moment is the newest close-shaped timeline event when there
  // is one, else the row's last update: a legacy row's only event is its
  // `created`, and its updated_at is the best record of when it ended.
  const unstamped = db
    .prepare(
      `SELECT t.id, COALESCE(
         (SELECT MAX(e.at) FROM task_events e
          WHERE e.task_id = t.id AND e.kind IN ('status', 'landed', 'merged', 'failed')),
         t.updated_at, t.created_at) AS stamp
       FROM tasks t
       WHERE t.status IN ('delivered', 'done', 'dropped') AND t.closed_at IS NULL`,
    )
    .all() as { id: string; stamp: number }[];
  const stampClosed = db.prepare("UPDATE tasks SET closed_at = ? WHERE id = ?");
  for (const row of unstamped) {
    stampClosed.run(row.stamp, row.id);
    log.run(row.id, "closed_at", null, String(row.stamp), now);
  }
  const holding = db
    .prepare(
      `SELECT id, worktree_dir FROM tasks
       WHERE status = 'dropped' AND closed_reason IN ('cancelled', 'discarded')
         AND workspace_state = 'present'`,
    )
    .all() as { id: string; worktree_dir: string }[];
  const clearState = db.prepare("UPDATE tasks SET workspace_state = 'removed' WHERE id = ?");
  for (const row of holding) {
    if (row.worktree_dir && existsSync(row.worktree_dir)) continue;
    clearState.run(row.id);
    log.run(row.id, "workspace_state", "present", "removed", now);
  }
}

export function migrateDetachFollowups(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE followup_parent_backfill (
      task_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      migrated_at INTEGER NOT NULL
    );
  `);
  const filed = db
    .prepare(
      `SELECT t.id, t.parent_id FROM tasks t
       JOIN task_links l
         ON l.from_id = t.id AND l.type = 'discovered-from' AND l.to_id = t.parent_id
       WHERE t.parent_id IS NOT NULL AND t.status IN ('open', 'active')`,
    )
    .all() as { id: string; parent_id: string }[];
  const log = db.prepare(
    "INSERT INTO followup_parent_backfill (task_id, parent_id, migrated_at) VALUES (?, ?, ?)",
  );
  const detach = db.prepare("UPDATE tasks SET parent_id = NULL WHERE id = ?");
  const now = Date.now();
  for (const row of filed) {
    detach.run(row.id);
    log.run(row.id, row.parent_id, now);
  }
}

export function migrateClosePark(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE park_row_backfill (
      task_id TEXT PRIMARY KEY,
      gate_ref TEXT,
      gate_until INTEGER,
      migrated_at INTEGER NOT NULL
    );
  `);
  const parked = db
    .prepare(
      `SELECT id, gate_ref, gate_until FROM tasks
       WHERE status = 'open' AND kind = 'decision'
         AND (id LIKE 'park-%' OR gate_until IS NOT NULL)
       ORDER BY created_at, id`,
    )
    .all() as { id: string; gate_ref: string | null; gate_until: number | null }[];
  const now = Date.now();
  const log = db.prepare(
    "INSERT INTO park_row_backfill (task_id, gate_ref, gate_until, migrated_at) VALUES (?, ?, ?, ?)",
  );
  const close = db.prepare(
    `UPDATE tasks SET status = 'dropped', activity = NULL, closed_reason = 'superseded',
       closed_at = ?, updated_at = ?, gate_kind = NULL, gate_ref = NULL, gate_until = NULL,
       gate_reason = NULL
     WHERE id = ?`,
  );
  const event = db.prepare(
    `INSERT INTO task_events (task_id, at, actor, kind, text, data_json, feed)
     VALUES (?, ?, 'host', 'status', 'parked decisions are retired; nothing brings this card back', ?, 0)`,
  );
  for (const row of parked) {
    log.run(row.id, row.gate_ref, row.gate_until, now);
    close.run(now, now, row.id);
    event.run(row.id, now, JSON.stringify({ status: "dropped", reason: "superseded" }));
  }
}

export function migrateRetireDelivered(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE delivered_status_backfill (
      task_id TEXT PRIMARY KEY,
      closed_reason TEXT,
      migrated_at INTEGER NOT NULL
    );
  `);
  const rows = db
    .prepare(
      "SELECT id, closed_reason FROM tasks WHERE status = 'delivered' ORDER BY created_at, id",
    )
    .all() as { id: string; closed_reason: string | null }[];
  const now = Date.now();
  const log = db.prepare(
    "INSERT INTO delivered_status_backfill (task_id, closed_reason, migrated_at) VALUES (?, ?, ?)",
  );
  const rewrite = db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?");
  for (const row of rows) {
    log.run(row.id, row.closed_reason, now);
    rewrite.run(now, row.id);
  }
}

export function migrateCapGates(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cap_gate_backfill (
      task_id TEXT PRIMARY KEY,
      gate_ref TEXT,
      gate_reason TEXT NOT NULL,
      migrated_at INTEGER NOT NULL
    );
  `);
  // Retired caps never create new captain gates; the table preserves historical rows.
}

export function migrateTaskReferences(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_references (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('basis', 'branch-source', 'retry-of')),
      ref TEXT NOT NULL,
      target_id TEXT,
      actor TEXT,
      recorded_at INTEGER,
      PRIMARY KEY (task_id, kind)
    );
  `);
  for (const [kind, field] of [
    ["basis", "basis"],
    ["branch-source", "branch_from"],
    ["retry-of", "escalate_from"],
  ] as const) {
    const path = `$.${field}`;
    db.prepare(
      `INSERT INTO task_references (task_id, kind, ref, target_id, actor, recorded_at)
       SELECT t.id, ?, json_extract(t.shape_json, ?),
         COALESCE(
           (SELECT n.id FROM tasks n WHERE n.id = trim(json_extract(t.shape_json, ?))),
           (SELECT n.id FROM tasks n WHERE n.key = upper(trim(json_extract(t.shape_json, ?))))
         ),
         NULL, NULL
       FROM tasks t
       WHERE json_valid(t.shape_json) AND json_type(t.shape_json, ?) = 'text'
         AND trim(json_extract(t.shape_json, ?)) != ''`,
    ).run(kind, path, path, path, path, path);
    db.prepare(
      `UPDATE tasks SET shape_json = json_remove(shape_json, ?)
       WHERE json_valid(shape_json) AND json_type(shape_json, ?) IS NOT NULL`,
    ).run(path, path);
  }
}

export function migrateTaskExecution(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_execution (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      session_file TEXT,
      conversation TEXT,
      device_id TEXT,
      account_id TEXT,
      placement_json TEXT,
      idle_since INTEGER,
      recovery_rung INTEGER NOT NULL DEFAULT 0,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      recovery_at INTEGER,
      start_notice TEXT,
      turn_json TEXT
    );
    CREATE INDEX task_execution_pending_placement ON task_execution(task_id)
      WHERE json_extract(placement_json, '$.reservation') = 'pending';
    DROP INDEX IF EXISTS tasks_pending_placement;
  `);
  const rows = db
    .prepare(
      `SELECT id, session_file, device_id, account_id, placement_json, idle_since, recovery_rung,
         recovery_count, recovery_at, start_notice, delivery_json FROM tasks`,
    )
    .all() as {
    id: string;
    session_file: string | null;
    device_id: string | null;
    account_id: string | null;
    placement_json: string | null;
    idle_since: number | null;
    recovery_rung: number | null;
    recovery_count: number | null;
    recovery_at: number | null;
    start_notice: string | null;
    delivery_json: string | null;
  }[];
  const recorded = db.prepare("SELECT 1 FROM task_sessions WHERE task_id = ? AND conversation = ?");
  const insert = db.prepare(
    `INSERT INTO task_execution (task_id, session_file, conversation, device_id, account_id,
       placement_json, idle_since, recovery_rung, recovery_count, recovery_at, start_notice, turn_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const empty = db.prepare(
    `UPDATE tasks SET session_file = NULL, device_id = NULL, account_id = NULL, placement_json = NULL,
       idle_since = NULL, recovery_rung = 0, recovery_count = 0, recovery_at = NULL,
       start_notice = NULL, delivery_json = ? WHERE id = ?`,
  );
  for (const row of rows) {
    let delivery: Record<string, unknown> | null = null;
    try {
      delivery = row.delivery_json ? JSON.parse(row.delivery_json) : null;
    } catch {
      // An unreadable delivery reads as none, and is left as saved.
    }
    const split =
      delivery && typeof delivery === "object" && !Array.isArray(delivery)
        ? splitTurn(delivery)
        : { delivery: null, turn: null };
    const conversation =
      row.session_file && recorded.get(row.id, conversationOf(row.session_file))
        ? conversationOf(row.session_file)
        : null;
    const running =
      row.session_file !== null ||
      row.device_id !== null ||
      row.account_id !== null ||
      row.placement_json !== null ||
      row.idle_since !== null ||
      Boolean(row.recovery_rung) ||
      Boolean(row.recovery_count) ||
      row.recovery_at !== null ||
      row.start_notice !== null ||
      split.turn !== null;
    if (running)
      insert.run(
        row.id,
        row.session_file,
        conversation,
        row.device_id,
        row.account_id,
        row.placement_json,
        row.idle_since,
        row.recovery_rung ?? 0,
        row.recovery_count ?? 0,
        row.recovery_at,
        row.start_notice,
        split.turn ? JSON.stringify(split.turn) : null,
      );
    empty.run(
      split.turn && split.delivery ? JSON.stringify(split.delivery) : row.delivery_json,
      row.id,
    );
  }
}

export function migrateTaskPolicies(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_policies (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      delivery_ask TEXT,
      autonomy_ask INTEGER,
      rigor_ask TEXT,
      edits_json TEXT
    );
  `);
  const rows = db
    .prepare("SELECT id, shape_json FROM tasks WHERE shape_json IS NOT NULL")
    .all() as { id: string; shape_json: string }[];
  const insert = db.prepare(
    `INSERT INTO task_policies (task_id, delivery_ask, autonomy_ask, rigor_ask, edits_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const keep = db.prepare("UPDATE tasks SET shape_json = ? WHERE id = ?");
  for (const row of rows) {
    let shape: unknown;
    try {
      shape = JSON.parse(row.shape_json);
    } catch {
      continue;
    }
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) continue;
    const split = splitPolicies(shape as WorkShape);
    if (!split.row) continue;
    insert.run(
      row.id,
      split.row.delivery_ask,
      split.row.autonomy_ask,
      split.row.rigor_ask,
      split.row.edits_json,
    );
    keep.run(JSON.stringify(split.shape), row.id);
  }
}

export function migrateTaskDeliveryRecords(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE task_delivery_evidence (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      format INTEGER NOT NULL,
      mode TEXT,
      head_sha TEXT,
      evidence_json TEXT
    );
    CREATE TABLE task_permissions (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      merge_authorization_json TEXT,
      merge_order_json TEXT,
      completion_offers_json TEXT,
      merge_reviews_json TEXT,
      check_target_json TEXT,
      write_asks_json TEXT,
      required_action_offer_json TEXT,
      captain_action_json TEXT,
      card_refusal_json TEXT,
      override_json TEXT,
      validation_permissions_json TEXT,
      pending_settle_json TEXT
    );
  `);
  const rows = db
    .prepare(
      "SELECT id, delivery_json, pending_settle_json FROM tasks WHERE delivery_json IS NOT NULL OR pending_settle_json IS NOT NULL",
    )
    .all() as { id: string; delivery_json: string | null; pending_settle_json: string | null }[];
  const store = new TaskDeliveryStore(db);
  const keep = db.prepare(
    "UPDATE tasks SET delivery_json = ?, pending_settle_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    let delivery: unknown = null;
    try {
      delivery = row.delivery_json ? JSON.parse(row.delivery_json) : null;
    } catch {
      // An unreadable delivery reads as none, and is left as saved.
    }
    const history =
      delivery && typeof delivery === "object" && !Array.isArray(delivery)
        ? JSON.stringify(store.setDelivery(row.id, delivery))
        : row.delivery_json;
    let pending: unknown = null;
    try {
      pending = row.pending_settle_json ? JSON.parse(row.pending_settle_json) : null;
    } catch {
      // An unreadable settle reads as none, and is left as saved.
    }
    if (pending !== null) store.setPendingSettle(row.id, pending);
    keep.run(history, pending !== null ? null : row.pending_settle_json, row.id);
  }
}

/**
 * Migration 107 (INF-1876): the `blocks` edge the host recorded from each
 * review it raised onto that review's builder goes, live or closed, and
 * nothing else - a `blocks_me` filing, a required action's prerequisite
 * and a wait the first mate recorded keep their rows and marks
 * (`docs/saved-data-compatibility.md`, "The review's edge").
 */
export function retireReviewEdges(db: AppDatabase): void {
  // The shape's routing fields live in `task_routing_requests` (the
  // `task_records` view is dropped while a migration runs).
  db.exec(`
    DELETE FROM task_links
    WHERE type = 'blocks' AND actor = 'host'
      AND EXISTS (
        SELECT 1 FROM tasks
        JOIN task_routing_requests AS routing ON routing.task_id = tasks.id
        WHERE tasks.id = task_links.from_id
          AND tasks.parent_id = task_links.to_id
          AND json_extract(routing.value_json, '$.kind_source') = 'host:review'
      )
  `);
}
