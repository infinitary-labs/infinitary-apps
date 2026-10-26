import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { AUTOMATIC_COMPUTER, PLACEMENT_DEMANDS, placementSnapshotSchema } from "@shared/placement";
import type { RiskAssessment } from "@shared/risk";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  IDLE_NUDGE_TEXT,
  idleNudge,
  renderWake,
  stillDownOnce,
  stillDownWake,
} from "../orchestrator/wakes";
import { PushedQuotaStore } from "../quota/pushedQuota";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { CardStore } from "./cardStore";
import type { AppDatabase } from "./db";
import { DATABASE_VERSION, openDatabase, openInMemoryDatabase } from "./db";
import { INBOX_GRACE_MS, InboxStore, inboxContentHash } from "./inboxStore";
import { SettingsStore } from "./settingsStore";
import { PERMISSION_COLUMNS } from "./taskDeliveryFields";
import { UsageStore } from "./usageStore";
import { dropViews } from "./views";

it("marks every captain message from before the answer-delivery check legacy, and opens new ones pending", () => {
  const dir = tmpUserData();
  const legacy = openDatabase(dir, 61);
  legacy
    .prepare(
      "INSERT INTO captain_asks (id, at, text, turn_state) VALUES ('old1', 1, 'before the check', 'closed')",
    )
    .run();
  legacy.close();
  const upgraded = openDatabase(dir);
  const tasks = new TaskService({ db: upgraded, strict: true });
  const old = tasks.getAsk("old1");
  expect(old).toMatchObject({
    delivery: "legacy",
    deliveryFacts: { entries: [] },
    noticeCardId: null,
  });
  // A legacy message takes no fact and is never judged.
  tasks.noteDelivery(["old1"], { outcome: "action", kind: "card", tool: "emit_card", at: 2 });
  expect(tasks.getAsk("old1")?.deliveryFacts.entries).toEqual([]);
  const fresh = tasks.openAsk({ id: "new1", text: "after the check" });
  expect(fresh.delivery).toBe("pending");
  expect(tasks.getAsk("new1")?.delivery).toBe("pending");
  upgraded.close();
});

it("migrates legacy schedules without inventing captain authority", () => {
  const dir = tmpUserData();
  const legacy = openDatabase(dir, 59);
  legacy
    .prepare(
      "INSERT INTO schedules (id, spec_kind, interval_minutes, prompt, next_fire, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("legacy", "every", 30, "turn notifications off", 30000, 1);
  legacy.close();
  const upgraded = openDatabase(dir);
  expect(
    upgraded.prepare("SELECT captain_requested FROM schedules WHERE id = ?").get("legacy"),
  ).toEqual({ captain_requested: 0 });
  upgraded.close();
});

const PROVENANCE_COLUMNS = [
  "card_id",
  "model",
  "prompt_sha",
  "tools_sha",
  "steered",
  "wake_kind",
] as const;

const LABEL_COLUMNS = ["missed_escalation", "missed_note", "missed_at"] as const;

/** Every migration shipped today; the head moves as migrations are added. */
const ALL_VERSIONS = Array.from({ length: DATABASE_VERSION }, (_, index) => index + 1);
/** Migration 68's reply line, undone: the `captain_asks` column. */
const REVERSE_MIGRATION_68 = "ALTER TABLE captain_asks DROP COLUMN reply;\n";
/** INF-1288's conversation associations, removed before a pre-sessions schema comparison. */
const REVERSE_TASK_SESSIONS = "DROP TABLE task_sessions;\n";
/** INF-1296 piece 2's relationship rows, undone: each name back into its shape field. */
const REVERSE_TASK_REFERENCES = [
  ["basis", "basis"],
  ["branch-source", "branch_from"],
  ["retry-of", "escalate_from"],
]
  .map(
    ([kind, field]) =>
      `UPDATE tasks SET shape_json = json_set(shape_json, '$.${field}', (SELECT ref FROM task_references r WHERE r.task_id = tasks.id AND r.kind = '${kind}')) WHERE EXISTS (SELECT 1 FROM task_references r WHERE r.task_id = tasks.id AND r.kind = '${kind}');\n`,
  )
  .join("")
  .concat("DROP TABLE task_references;\n");
/** INF-1296 piece 3's policy rows, undone: each input back into its shape field. */
const REVERSE_TASK_POLICIES = [
  ["delivery_ask", "p.delivery_ask"],
  ["autonomy_ask", "json(CASE p.autonomy_ask WHEN 1 THEN 'true' ELSE 'false' END)"],
  ["rigor_ask", "p.rigor_ask"],
  ["policies", "json(p.edits_json)"],
]
  .map(([field, value]) => {
    const column = field === "policies" ? "edits_json" : field;
    return `UPDATE tasks SET shape_json = json_set(shape_json, '$.${field}', (SELECT ${value} FROM task_policies p WHERE p.task_id = tasks.id)) WHERE EXISTS (SELECT 1 FROM task_policies p WHERE p.task_id = tasks.id AND p.${column} IS NOT NULL);\n`;
  })
  .join("")
  .concat("DROP TABLE task_policies;\n");
/** INF-1296 piece 3's execution rows, undone: each value back on the task row, the turn on its delivery. */
const REVERSE_TASK_EXECUTION = `UPDATE tasks SET session_file = x.session_file, device_id = x.device_id,
  account_id = x.account_id, placement_json = x.placement_json, idle_since = x.idle_since,
  recovery_rung = x.recovery_rung, recovery_count = x.recovery_count, recovery_at = x.recovery_at,
  start_notice = x.start_notice,
  delivery_json = CASE WHEN x.turn_json IS NULL THEN tasks.delivery_json
    ELSE json_patch(COALESCE(tasks.delivery_json, '{}'), x.turn_json) END
  FROM task_execution x WHERE x.task_id = tasks.id;
DROP TABLE task_execution;
CREATE INDEX tasks_pending_placement ON tasks(id) WHERE json_extract(placement_json, '$.reservation') = 'pending';
`;
/** INF-1296 piece 4's change evidence and permission rows, undone: each field back on its delivery. */
const REVERSE_TASK_DELIVERY = `UPDATE tasks SET delivery_json = json_set(delivery_json, '$.mode', x.mode)
  FROM task_delivery_evidence x WHERE x.task_id = tasks.id AND x.mode IS NOT NULL;
UPDATE tasks SET delivery_json = json_set(delivery_json, '$.headSha', x.head_sha)
  FROM task_delivery_evidence x WHERE x.task_id = tasks.id AND x.head_sha IS NOT NULL;
UPDATE tasks SET delivery_json = json_patch(delivery_json, x.evidence_json)
  FROM task_delivery_evidence x WHERE x.task_id = tasks.id AND x.evidence_json IS NOT NULL;
${Object.entries(PERMISSION_COLUMNS)
  .map(
    ([field, column]) =>
      `UPDATE tasks SET delivery_json = json_set(delivery_json, '$.${field}', json(p.${column})) FROM task_permissions p WHERE p.task_id = tasks.id AND p.${column} IS NOT NULL;\n`,
  )
  .join(
    "",
  )}UPDATE tasks SET delivery_json = json_set(delivery_json, '$.liveValidation.permissions', json(p.validation_permissions_json))
  FROM task_permissions p WHERE p.task_id = tasks.id AND p.validation_permissions_json IS NOT NULL;
UPDATE tasks SET pending_settle_json = p.pending_settle_json
  FROM task_permissions p WHERE p.task_id = tasks.id AND p.pending_settle_json IS NOT NULL;
DROP TABLE task_permissions;
DROP TABLE task_delivery_evidence;
`;
/** INF-1296 pieces 3 and 4's records, undone, newest first. */
const REVERSE_RUNNING_WORK = REVERSE_TASK_DELIVERY + REVERSE_TASK_POLICIES + REVERSE_TASK_EXECUTION;
/** Migration 80's delivery columns, undone. */
const REVERSE_MIGRATION_80 =
  "ALTER TABLE schedule_runs DROP COLUMN inbox_id; ALTER TABLE schedule_runs DROP COLUMN delivery; ALTER TABLE schedule_runs DROP COLUMN settled_at; ALTER TABLE schedule_runs DROP COLUMN cancel_reason; ALTER TABLE schedule_runs DROP COLUMN tasks; ALTER TABLE schedule_runs DROP COLUMN cards;\n";
/** Migration 79's calendar and project columns, undone. */
const REVERSE_MIGRATION_79 =
  "ALTER TABLE schedules DROP COLUMN days; ALTER TABLE schedules DROP COLUMN time_zone; ALTER TABLE schedules DROP COLUMN project_id;\n";
/** Migration 78's rule columns and run history, undone. */
const REVERSE_MIGRATION_78 =
  "DROP TABLE schedule_runs; ALTER TABLE schedules DROP COLUMN name; ALTER TABLE schedules DROP COLUMN state; ALTER TABLE schedules DROP COLUMN revision;\n";
/** Migration 71's concerned tasks, undone: the `task_event_concerns` table. */
const REVERSE_MIGRATION_71 =
  "DROP TABLE IF EXISTS keep_open_backfill; DROP TABLE task_event_concerns;\n";
/** Migration 71's table, for a fixture that seeds an older database through the one writer. */
const MIGRATION_71_TABLE =
  "CREATE TABLE task_event_concerns (event_id INTEGER NOT NULL, task_id TEXT NOT NULL, relation TEXT NOT NULL, via TEXT, PRIMARY KEY (event_id, task_id));";
/** INF-1296 piece 2's relationship rows, lent to an older schema for today's writer. */
const TASK_REFERENCES_TABLE =
  "CREATE TABLE task_references (task_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, target_id TEXT, actor TEXT, recorded_at INTEGER, PRIMARY KEY (task_id, kind));";
/** INF-1226's declaration that a card's choice is not its task's answer, undone. */
const REVERSE_MIGRATION_93 = "ALTER TABLE cards DROP COLUMN continues;\n";
/** INF-476's saved visibility column, with the later card column undone, without deleting card rows. */
const REVERSE_MIGRATION_88 = `${REVERSE_MIGRATION_93}ALTER TABLE cards DROP COLUMN minimized;\n`;
/** Migration 77's optional continuity declaration, with its later columns undone. */
const REVERSE_MIGRATION_77 = `${REVERSE_MIGRATION_88}ALTER TABLE cards DROP COLUMN review_task_id; ALTER TABLE cards DROP COLUMN required_actions_json; ALTER TABLE cards DROP COLUMN holds_place;\n`;
/** Legacy card reversal chain removes later columns before migration 70's replies column. */
const REVERSE_MIGRATION_70 = `${REVERSE_MIGRATION_77}ALTER TABLE cards DROP COLUMN replies;\n`;
/** Migration 69's merge-card risk, undone: the `cards` column. */
const REVERSE_MIGRATION_69 = "ALTER TABLE cards DROP COLUMN risk_json;\n";
/** Migration 67's card place, undone: the `cards` column. */
const REVERSE_MIGRATION_67 = "ALTER TABLE cards DROP COLUMN place;\n";
/** Legacy usage reversal removes 83's reasoning count before 66's six columns. */
const REVERSE_MIGRATION_66 = `
  ALTER TABLE usage_events DROP COLUMN reasoning;
  ALTER TABLE usage_events DROP COLUMN model_source;
  ALTER TABLE usage_events DROP COLUMN cost_source;
  ALTER TABLE usage_events DROP COLUMN cost_input;
  ALTER TABLE usage_events DROP COLUMN cost_output;
  ALTER TABLE usage_events DROP COLUMN cost_cache_read;
  ALTER TABLE usage_events DROP COLUMN cost_cache_write;
`;
/** Migration 65's live attachment, undone: the `cards` column. */
const REVERSE_MIGRATION_65 = "ALTER TABLE cards DROP COLUMN attachment_json;\n";
it("INF-1117: upgrades existing projects with empty scope, saves it across reopen and reverses without losing rows", () => {
  const dir = tmpUserData();
  const legacy = openDatabase(dir, 91);
  const columns = columnNames(legacy, "repos");
  legacy
    .prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, kind, delivery) VALUES ('scope-project', '/fleet/observatory', 'observatory', 1, 'init', 'project', 'local-only')",
    )
    .run();
  legacy.close();
  const upgraded = openDatabase(dir);
  const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
  expect(registry.get("scope-project")?.scope).toBeNull();
  const scope = "Tools and dashboards for our astronomy club.";
  registry.configure("scope-project", { scope });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(new RepoRegistry(reopened, join(dir, "fleet")).get("scope-project")?.scope).toBe(scope);
  dropViews(reopened);
  reopened.exec("ALTER TABLE repos DROP COLUMN scope");
  expect(columnNames(reopened, "repos")).toEqual(columns);
  expect(reopened.prepare("SELECT id, name FROM repos").all()).toEqual([
    { id: "scope-project", name: "observatory" },
  ]);
  reopened.close();
});

/** Reversing Runs on also removes the later project requirements and scope columns. */
const REVERSE_MIGRATION_64 =
  "ALTER TABLE repos DROP COLUMN scope; ALTER TABLE repos DROP COLUMN placement_requirements_json; ALTER TABLE repos DROP COLUMN runs_on;\n";
/** Reversing placed tasks also removes migration 84's commitment column and index. */
const REVERSE_MIGRATION_63 =
  "DROP INDEX tasks_pending_placement; ALTER TABLE tasks DROP COLUMN placement_json; ALTER TABLE tasks DROP COLUMN device_id;\n";
/** Migration 59's sent-back stamp, undone: the `cards` column. */
const REVERSE_MIGRATION_59 = `ALTER TABLE cards DROP COLUMN sent_back_at;\n`;
/** Migration 57's card evidence, undone: its two tables and the two `cards` pointers. */
const REVERSE_MIGRATION_57 = `
  DROP TABLE card_observations;
  DROP TABLE card_capture_epochs;
  ALTER TABLE cards DROP COLUMN lifecycle_id;
  ALTER TABLE cards DROP COLUMN offer_id;
`;
/**
 * Migration 50's one decision ledger, undone: the three tables back from
 * their kinds (a sort row's id and its `rule:<id>` stamp in `model`), and
 * `decisions` dropped. Run with the views dropped, as every older reversal
 * that meets it first is.
 */
const REVERSE_MIGRATION_50 = `
  CREATE TABLE routing_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, provider TEXT, model TEXT,
    bucket TEXT NOT NULL, reasons_json TEXT NOT NULL, at INTEGER NOT NULL, rule TEXT, served TEXT
  );
  INSERT INTO routing_decisions (task_id, provider, model, bucket, reasons_json, at, rule, served)
    SELECT task_id, provider, model, bucket, reasons_json, at, rule, served
    FROM decisions WHERE kind = 'routing' ORDER BY id;
  CREATE INDEX routing_decisions_task ON routing_decisions (task_id, at);
  CREATE TABLE account_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, provider TEXT NOT NULL,
    account_id TEXT, reasons_json TEXT NOT NULL, at INTEGER NOT NULL
  );
  INSERT INTO account_decisions (task_id, provider, account_id, reasons_json, at)
    SELECT task_id, provider, account_id, reasons_json, at
    FROM decisions WHERE kind = 'account' ORDER BY id;
  CREATE TABLE supervision_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, wake TEXT NOT NULL,
    verdict TEXT NOT NULL, summary TEXT NOT NULL, at INTEGER NOT NULL, card_id TEXT, model TEXT,
    prompt_sha TEXT, tools_sha TEXT, steered INTEGER, wake_kind TEXT,
    missed_escalation INTEGER, missed_note TEXT, missed_at INTEGER
  );
  INSERT INTO supervision_outcomes
    (id, task_id, wake, verdict, summary, at, card_id, model, prompt_sha, tools_sha, steered,
     wake_kind, missed_escalation, missed_note, missed_at)
    SELECT id, task_id, wake, verdict, summary, at, card_id,
      CASE WHEN rule IS NULL THEN model ELSE 'rule:' || rule END,
      prompt_sha, tools_sha, steered, wake_kind, missed_escalation, missed_note, missed_at
    FROM decisions WHERE kind = 'sort' ORDER BY id;
  DROP TABLE decisions;
`;
/**
 * Migration 48's envelope, unwrapped: every payload back to its prose. The
 * older inbox tests below queue only prose, so `$.text` is all there is.
 */
const REVERSE_MIGRATION_48_PROSE = "UPDATE inbox SET payload = json_extract(payload, '$.text');";
/** Migration 74's cut count, undone: the `inbox` column. */
const REVERSE_MIGRATION_74 = "ALTER TABLE inbox DROP COLUMN cuts;";
/** Migration 76's start notice, undone: the `tasks` column. */
const REVERSE_MIGRATION_76 = "ALTER TABLE tasks DROP COLUMN start_notice;";
/** Migration 45's inbox columns, dropped (74's first): what an older inbox reversal undoes first. */
const REVERSE_MIGRATION_45_INBOX = `${REVERSE_MIGRATION_74} ${REVERSE_MIGRATION_48_PROSE} ALTER TABLE inbox DROP COLUMN failures; ALTER TABLE inbox DROP COLUMN failing_since; ALTER TABLE inbox DROP COLUMN next_attempt_at;`;

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpUserData(): string {
  const dir = scratchDir("infinitary-mig-");
  tmpDirs.push(dir);
  return dir;
}

function appliedVersions(db: AppDatabase): number[] {
  return (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map((row) => row.version);
}

function tableNames(db: AppDatabase): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function columnNames(db: AppDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe("migration 15 (supervision provenance)", () => {
  it("applies every migration on a fresh database, including the provenance columns", () => {
    const db = openInMemoryDatabase();
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    const columns = columnNames(db, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
  });

  it("applies 15 on a database already at 14 without rewriting earlier rows", () => {
    const dir = tmpUserData();
    const atFourteen = openDatabase(dir, 14);
    expect(appliedVersions(atFourteen).at(-1)).toBe(14);
    const preColumns = columnNames(atFourteen, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(preColumns).not.toContain(column);
    }
    atFourteen
      .prepare(
        "INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t-pre", "[fm-op] crewmate 1 reported on task t-pre: done", "routine", "Quiet.", 1);
    atFourteen.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded).at(-1)).toBe(ALL_VERSIONS.at(-1));
    const columns = columnNames(upgraded, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
    const row = upgraded
      .prepare(
        "SELECT task_id, card_id, model, prompt_sha, tools_sha, steered, wake_kind FROM supervision_outcomes",
      )
      .get() as {
      task_id: string;
      card_id: string | null;
      model: string | null;
      prompt_sha: string | null;
      tools_sha: string | null;
      steered: number | null;
      wake_kind: string | null;
    };
    expect(row.task_id).toBe("t-pre");
    expect(row.card_id).toBeNull();
    expect(row.model).toBeNull();
    expect(row.prompt_sha).toBeNull();
    expect(row.tools_sha).toBeNull();
    expect(row.steered).toBeNull();
    expect(row.wake_kind).toBeNull();
    upgraded.close();
  });

  it("migrates a database stuck at 13 (the PoC-0 captain-install schema) through the head", () => {
    const dir = tmpUserData();
    const stuck = openDatabase(dir, 13);
    expect(appliedVersions(stuck).at(-1)).toBe(13);
    expect(columnNames(stuck, "supervision_outcomes")).toEqual([
      "id",
      "task_id",
      "wake",
      "verdict",
      "summary",
      "at",
    ]);
    stuck.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const columns = columnNames(upgraded, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
    upgraded.close();
  });
});

describe("migration 16 (confirmed missed-escalation label)", () => {
  it("applies 16 on a database already at 15 and leaves existing rows unlabelled", () => {
    const dir = tmpUserData();
    const atFifteen = openDatabase(dir, 15);
    expect(appliedVersions(atFifteen).at(-1)).toBe(15);
    const preColumns = columnNames(atFifteen, "supervision_outcomes");
    for (const column of LABEL_COLUMNS) {
      expect(preColumns).not.toContain(column);
    }
    atFifteen
      .prepare(
        "INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t-pre", "[fm-op] crewmate 1 reported on task t-pre: done", "routine", "Quiet.", 1);
    atFifteen.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded).at(-1)).toBe(ALL_VERSIONS.at(-1));
    const row = upgraded
      .prepare(
        "SELECT task_id, missed_escalation, missed_note, missed_at FROM supervision_outcomes",
      )
      .get() as {
      task_id: string;
      missed_escalation: number | null;
      missed_note: string | null;
      missed_at: number | null;
    };
    expect(row.task_id).toBe("t-pre");
    expect(row.missed_escalation).toBeNull();
    expect(row.missed_note).toBeNull();
    expect(row.missed_at).toBeNull();
    upgraded.close();
  });
});

describe("migrations 17-19 (the task record, P0)", () => {
  type MappedRow = {
    id: string;
    key: string;
    seq: number;
    project_id: string;
    kind: string;
    status: string;
    activity: string | null;
    closed_reason: string | null;
    workspace_state: string;
    gate_kind: string | null;
    gate_ref: string | null;
    updated_at: number;
    priority: number;
    start_policy: string;
  };

  /**
   * A version-16 database with every pre-P0 status value, a parked
   * decision, an after-task gate, and one managed repo - the shape a
   * captain install carries into the upgrade.
   */
  function seedVersion16(dir: string): void {
    const db = openDatabase(dir, 16);
    expect(appliedVersions(db).at(-1)).toBe(16);
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'adopt', NULL, 'local-only', 0)",
    ).run("r1", "/tmp/infinitary-fixture/firstmate-3000", "firstmate-3000", 100);
    const insert = db.prepare(
      `INSERT INTO tasks (id, kind, title, prompt, repo_id, repo_dir, worktree_dir, branch, session_file, account_id, difficulty, gate_kind, gate_ref, gate_until, gate_reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const worked = (id: string, status: string, repoId: string | null, at: number) =>
      insert.run(
        id,
        "work",
        `task ${id}`,
        "brief",
        repoId,
        "/repo",
        `/worktrees/${id}`,
        `fm/task-${id}`,
        `/sessions/${id}.jsonl`,
        null,
        null,
        null,
        null,
        null,
        null,
        status,
        at,
      );
    worked("running1", "running", "r1", 1_000);
    worked("idle1", "idle", "r1", 2_000);
    worked("intr1", "interrupted", null, 3_000);
    worked("done1", "completed", "r1", 4_000);
    worked("canc1", "cancelled", null, 5_000);
    worked("fail1", "failed", "r1", 6_000);
    // A completed row whose worktree is gone (an old cleanup left the row).
    insert.run(
      "done2",
      "work",
      "task done2",
      "brief",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "completed",
      6_500,
    );
    // Queued behind a time gate, behind another task, and behind a task
    // that no longer exists.
    insert.run(
      "q-time",
      "work",
      "nightly",
      "brief",
      "r1",
      "",
      "",
      "",
      null,
      null,
      null,
      "at-time",
      null,
      9_999_999_999_999,
      null,
      "queued",
      7_000,
    );
    insert.run(
      "q-after",
      "work",
      "dependent",
      "brief",
      "r1",
      "",
      "",
      "",
      null,
      null,
      "high",
      "after-task",
      "idle1",
      null,
      null,
      "queued",
      8_000,
    );
    insert.run(
      "q-gone",
      "work",
      "orphan wait",
      "brief",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      "after-task",
      "missing",
      null,
      null,
      "queued",
      9_000,
    );
    // A parked decision (R1) held by its card id.
    insert.run(
      "park-card-fm-1",
      "decision",
      "Which port?",
      "",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      "captain",
      "card-fm-1",
      9_999_999_999_999,
      null,
      "queued",
      10_000,
    );
    db.close();
  }

  it("migrates a version-16 fixture through 19 with the status mapping and durable keys", () => {
    const dir = tmpUserData();
    seedVersion16(dir);
    const db = openDatabase(dir);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);

    const projects = db
      .prepare(
        "SELECT id, key, name, kind, repo_id, next_seq, archived_at FROM projects ORDER BY created_at, id",
      )
      .all() as {
      id: string;
      key: string;
      name: string;
      kind: string;
      repo_id: string | null;
      next_seq: number;
      archived_at: number | null;
    }[];
    expect(projects.map((p) => [p.id, p.key, p.kind, p.repo_id])).toEqual([
      ["proj-r1", "FI3", "repo", "r1"],
      ["scratch", "SCR", "scratch", null],
    ]);
    expect(projects.every((p) => p.archived_at === null)).toBe(true);

    const rows = new Map(
      (db.prepare("SELECT * FROM tasks").all() as MappedRow[]).map((row) => [row.id, row]),
    );
    const mapped = (id: string) => {
      const row = rows.get(id) as MappedRow;
      return [
        row.project_id,
        row.key,
        row.kind,
        row.status,
        row.activity,
        row.closed_reason,
        row.workspace_state,
      ];
    };
    expect(mapped("running1")).toEqual([
      "proj-r1",
      "FI3-1",
      "work",
      "active",
      "running",
      null,
      "present",
    ]);
    expect(mapped("idle1")).toEqual([
      "proj-r1",
      "FI3-2",
      "work",
      "active",
      "idle",
      null,
      "present",
    ]);
    expect(mapped("intr1")).toEqual([
      "scratch",
      "SCR-1",
      "work",
      "active",
      "interrupted",
      null,
      "present",
    ]);
    // A completed legacy row is closed history (WI-11 retired `delivered`):
    // it maps straight to done/finished, its worktree flag untouched.
    expect(mapped("done1")).toEqual([
      "proj-r1",
      "FI3-3",
      "work",
      "done",
      null,
      "finished",
      "present",
    ]);
    // Mapped `present` at 17; the fixture's worktree path was never on disk,
    // so migration 23 clears the flag on the cancelled row (WI-7).
    expect(mapped("canc1")).toEqual([
      "scratch",
      "SCR-2",
      "work",
      "dropped",
      null,
      "cancelled",
      "removed",
    ]);
    expect(mapped("fail1")).toEqual([
      "proj-r1",
      "FI3-4",
      "work",
      "dropped",
      null,
      "failed",
      "present",
    ]);
    expect(mapped("done2")).toEqual(["scratch", "SCR-3", "work", "done", null, "finished", "none"]);
    expect(mapped("q-time")).toEqual(["proj-r1", "FI3-5", "work", "open", null, null, "none"]);
    expect(mapped("q-after")).toEqual(["proj-r1", "FI3-6", "work", "open", null, null, "none"]);
    expect(mapped("q-gone")).toEqual(["scratch", "SCR-4", "work", "open", null, null, "none"]);
    // The park row P1 made of a deferred decision is closed by migration 28
    // (cards/tasks/agents P0): parked decisions are retired.
    expect(mapped("park-card-fm-1")).toEqual([
      "scratch",
      "SCR-5",
      "decision",
      "dropped",
      null,
      "superseded",
      "none",
    ]);

    // Holds survive as gates; the after-task wait became a blocks edge and
    // its gate cleared (a missing target simply clears).
    expect(rows.get("q-time")).toMatchObject({ gate_kind: "at-time" });
    // The park's hold went with the row (migration 28), logged for reversal.
    expect(rows.get("park-card-fm-1")).toMatchObject({ gate_kind: null, gate_ref: null });
    expect(db.prepare("SELECT task_id, gate_ref FROM park_row_backfill").all()).toEqual([
      { task_id: "park-card-fm-1", gate_ref: "card-fm-1" },
    ]);
    expect(rows.get("q-after")).toMatchObject({ gate_kind: null, gate_ref: null });
    expect(rows.get("q-gone")).toMatchObject({ gate_kind: null, gate_ref: null });
    const links = db
      .prepare("SELECT from_id, to_id, type, actor FROM task_links ORDER BY from_id")
      .all();
    expect(links).toEqual([{ from_id: "idle1", to_id: "q-after", type: "blocks", actor: "host" }]);

    // Every row carries the record invariants and a birth event.
    for (const row of rows.values()) {
      expect(row.updated_at).toBeGreaterThan(0);
      expect(row.priority).toBe(2);
      expect(row.start_policy).toBe("when-ready");
    }
    const events = db
      .prepare("SELECT task_id, kind, actor, feed FROM task_events ORDER BY at, id")
      .all() as { task_id: string; kind: string; actor: string; feed: number }[];
    // Every row has a birth event; the park's close (migration 28) adds one.
    expect(events).toHaveLength(rows.size + 1);
    expect(events.filter((e) => e.kind === "status")).toEqual([
      { task_id: "park-card-fm-1", kind: "status", actor: "host", feed: 0 },
    ]);
    expect(events.filter((e) => e.kind !== "status").every((e) => e.kind === "created")).toBe(true);
    expect(events.every((e) => e.actor === "host" && e.feed === 0)).toBe(true);
    // The per-project sequence continues after the backfilled rows.
    expect(projects.find((p) => p.id === "proj-r1")?.next_seq).toBe(7);
    expect(projects.find((p) => p.id === "scratch")?.next_seq).toBe(6);
    expect(columnNames(db, "captain_asks")).toContain("turn_state");
    db.close();
  });

  it("is idempotent across reopen and leaves a fresh database with Scratch only", () => {
    const dir = tmpUserData();
    seedVersion16(dir);
    openDatabase(dir).close();
    const again = openDatabase(dir);
    expect(appliedVersions(again)).toEqual(ALL_VERSIONS);
    expect((again.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(11);
    again.close();

    const fresh = openInMemoryDatabase();
    expect(fresh.prepare("SELECT id, key FROM projects").all()).toEqual([
      { id: "scratch", key: "SCR" },
    ]);
    expect(columnNames(fresh, "tasks")).toEqual(
      expect.arrayContaining([
        "key",
        "seq",
        "project_id",
        "parent_id",
        "activity",
        "closed_reason",
        "priority",
        "goal",
        "intent_json",
        "outcome",
        "outcome_summary",
        "delivery_json",
        "assignee",
        "model",
        "start_policy",
        "workspace_state",
        "updated_at",
        "started_at",
        "closed_at",
      ]),
    );
  });
});

describe("migration 21 (model-activation to model-slots)", () => {
  it("converts activated models into slots so an upgrade rearranges nothing", () => {
    const dir = tmpUserData();
    const atTwenty = openDatabase(dir, 20);
    expect(appliedVersions(atTwenty).at(-1)).toBe(20);
    atTwenty.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "model-activation",
      JSON.stringify({
        accounts: {
          "acct-copilot": {
            active: [
              "github-copilot/claude-opus-5",
              "github-copilot/claude-fable-5",
              "github-copilot/gpt-5.6-sol",
            ],
            known: [
              "github-copilot/claude-opus-5",
              "github-copilot/claude-fable-5",
              "github-copilot/gpt-5.6-sol",
              "github-copilot/gemini-3.6-flash",
            ],
          },
          "acct-codex": {
            active: ["openai-codex/gpt-5.6-terra"],
            known: ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.5"],
          },
        },
      }),
    );
    atTwenty.close();

    const atTwentyOne = openDatabase(dir, 21);
    const converted = JSON.parse(
      (
        atTwentyOne.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots") as {
          value: string;
        }
      ).value,
    ) as { assignments: Record<string, string> };
    expect(converted.assignments["github-copilot/gpt-5.6-sol"]).toBe("high");
    expect(converted.assignments["openai-codex/gpt-5.6-terra"]).toBe("medium");
    atTwentyOne.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const slotsRow = upgraded
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("model-slots") as { value: string };
    const slots = JSON.parse(slotsRow.value) as {
      version: number;
      assignments: Record<string, string | string[]>;
      seen: string[];
    };
    expect(slots.version).toBe(1);
    // Migration 21 kept every active offering. Migration 39 then moved the
    // GPT-5.6 picks onto GPT-6; the Claude rows stay where 21 put them.
    expect(slots.assignments["github-copilot/claude-opus-5"]).toBe("high");
    expect(slots.assignments["github-copilot/claude-fable-5"]).toBe("premium");
    expect(slots.assignments["github-copilot/gpt-5.6-sol"]).toBeUndefined();
    expect(slots.assignments["github-copilot/gpt-6-sol"]).toEqual(["high"]);
    expect(slots.assignments["openai-codex/gpt-5.6-terra"]).toBeUndefined();
    expect(slots.assignments["openai-codex/gpt-6-luna"]).toEqual(["medium"]);
    // Known-but-inactive stays seen and off.
    expect(slots.assignments["github-copilot/gemini-3.6-flash"]).toBeUndefined();
    expect(slots.assignments["openai-codex/gpt-5.5"]).toBeUndefined();
    expect(slots.seen.sort()).toEqual(
      [
        "github-copilot/claude-fable-5",
        "github-copilot/claude-opus-5",
        "github-copilot/gemini-3.6-flash",
        "github-copilot/gpt-5.6-sol",
        "github-copilot/gpt-6-sol",
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.6-terra",
        "openai-codex/gpt-6-luna",
      ].sort(),
    );
    // The old row stays unread for one release.
    expect(
      upgraded.prepare("SELECT value FROM settings WHERE key = ?").get("model-activation"),
    ).toBeTruthy();
    upgraded.close();
  });

  it("does nothing on a fresh install that never had an activation record", () => {
    const db = openInMemoryDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots");
    expect(row).toBeUndefined();
    db.close();
  });
});

describe("migration 39 (saved GPT-5.6 picks follow GPT-6)", () => {
  function readSlots(db: AppDatabase) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots") as {
      value: string;
    };
    return JSON.parse(row.value) as {
      assignments: Record<string, string | string[]>;
      seen: string[];
    };
  }

  it("moves sol, terra, and luna, unions onto luna, and leaves astra and a custom slot", () => {
    const dir = tmpUserData();
    const at = openDatabase(dir, 38);
    at.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "model-slots",
      JSON.stringify({
        version: 1,
        assignments: {
          "openai-codex/gpt-5.6-sol": "high",
          "openai-codex/gpt-5.6-terra": ["medium"],
          "openai-codex/gpt-5.6-luna": "low",
          "openai-codex/gpt-6-astra": "premium",
          "xai/grok-4.6": "high",
        },
        seen: [
          "openai-codex/gpt-5.6-sol",
          "openai-codex/gpt-5.6-terra",
          "openai-codex/gpt-5.6-luna",
          "openai-codex/gpt-6-astra",
          "xai/grok-4.6",
        ],
      }),
    );
    at.close();

    const upgraded = openDatabase(dir);
    const slots = readSlots(upgraded);
    expect(slots.assignments["openai-codex/gpt-6-sol"]).toEqual(["high"]);
    expect(slots.assignments["openai-codex/gpt-6-luna"]).toEqual(["medium", "low"]);
    expect(slots.assignments["openai-codex/gpt-6-astra"]).toBe("premium");
    expect(slots.assignments["xai/grok-4.6"]).toBe("high");
    expect(slots.assignments["openai-codex/gpt-5.6-sol"]).toBeUndefined();
    expect(slots.assignments["openai-codex/gpt-5.6-terra"]).toBeUndefined();
    expect(slots.assignments["openai-codex/gpt-5.6-luna"]).toBeUndefined();
    expect(slots.seen).toEqual(
      expect.arrayContaining([
        "openai-codex/gpt-5.6-sol",
        "openai-codex/gpt-6-sol",
        "openai-codex/gpt-5.6-terra",
        "openai-codex/gpt-5.6-luna",
        "openai-codex/gpt-6-luna",
        "xai/grok-4.6",
      ]),
    );
    upgraded.close();
  });

  it("leaves a slot record that names none of those picks", () => {
    const dir = tmpUserData();
    const at = openDatabase(dir, 38);
    const stored = JSON.stringify({
      version: 1,
      assignments: { "xai/grok-4.6": "high" },
      seen: ["xai/grok-4.6"],
    });
    at.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("model-slots", stored);
    at.close();

    const upgraded = openDatabase(dir);
    const row = upgraded.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots") as {
      value: string;
    };
    expect(row.value).toBe(stored);
    upgraded.close();
  });
});

describe("migration 23 (fleet hygiene backfill, WI-7)", () => {
  type HygieneRow = {
    id: string;
    status: string;
    closed_reason: string | null;
    closed_at: number | null;
    workspace_state: string;
  };
  const rows = (db: AppDatabase) =>
    db
      .prepare(
        "SELECT id, status, closed_reason, closed_at, workspace_state FROM tasks ORDER BY id",
      )
      .all() as HygieneRow[];

  it("stamps closed_at on closed rows, clears present only where the worktree is gone, and reverses", () => {
    const dir = tmpUserData();
    const survivingWorktree = scratchDir("infinitary-wt-");
    tmpDirs.push(survivingWorktree);
    const atTwentyTwo = openDatabase(dir, 22);
    let now = 5_000;
    const tasks = new TaskService({ db: atTwentyTwo, now: () => now, strict: true });
    seedTask(tasks, { id: "active", title: "Live", status: "idle", worktreeDir: "/gone/active" });
    now = 6_000;
    seedTask(tasks, {
      id: "cancelled-gone",
      title: "A",
      status: "cancelled",
      worktreeDir: "/gone/a",
    });
    now = 7_000;
    seedTask(tasks, {
      id: "discarded-kept",
      title: "B",
      status: "idle",
      worktreeDir: survivingWorktree,
    });
    tasks.close("discarded-kept", { status: "dropped", reason: "discarded", actor: "host" });
    now = 8_000;
    // A legacy completed row, closed to done/finished the way migration 17
    // leaves one (WI-11 retired `delivered`, so a completed row is done).
    seedTask(tasks, { id: "done-legacy", title: "C", status: "idle" });
    tasks.close("done-legacy", { status: "done", reason: "finished", actor: "host" });
    // What migration 17 left behind on real installs: closed, no closed_at.
    atTwentyTwo.exec("UPDATE tasks SET closed_at = NULL WHERE status <> 'active'");
    const before = rows(atTwentyTwo);
    atTwentyTwo.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(rows(upgraded)).toEqual([
      {
        id: "active",
        status: "active",
        closed_reason: null,
        closed_at: null,
        workspace_state: "present",
      },
      // The close event's own time, not the upgrade's.
      {
        id: "cancelled-gone",
        status: "dropped",
        closed_reason: "cancelled",
        closed_at: 6_000,
        workspace_state: "removed",
      },
      // Its worktree is still on disk, so `present` is still the truth.
      {
        id: "discarded-kept",
        status: "dropped",
        closed_reason: "discarded",
        closed_at: 7_000,
        workspace_state: "present",
      },
      {
        id: "done-legacy",
        status: "done",
        closed_reason: "finished",
        closed_at: 8_000,
        workspace_state: "none",
      },
    ]);
    const log = upgraded
      .prepare(
        "SELECT task_id, column_name, old_value, new_value FROM task_hygiene_backfill ORDER BY task_id, column_name",
      )
      .all();
    expect(log).toEqual([
      { task_id: "cancelled-gone", column_name: "closed_at", old_value: null, new_value: "6000" },
      {
        task_id: "cancelled-gone",
        column_name: "workspace_state",
        old_value: "present",
        new_value: "removed",
      },
      { task_id: "discarded-kept", column_name: "closed_at", old_value: null, new_value: "7000" },
      { task_id: "done-legacy", column_name: "closed_at", old_value: null, new_value: "8000" },
    ]);

    // Reversible: restoring every logged old value and dropping the log
    // table gives back the v22 rows exactly.
    upgraded.exec(`
      UPDATE tasks SET closed_at = NULL
        WHERE id IN (SELECT task_id FROM task_hygiene_backfill WHERE column_name = 'closed_at');
      UPDATE tasks SET workspace_state = (
          SELECT old_value FROM task_hygiene_backfill b
          WHERE b.task_id = tasks.id AND b.column_name = 'workspace_state')
        WHERE id IN (SELECT task_id FROM task_hygiene_backfill WHERE column_name = 'workspace_state');
      DROP TABLE task_hygiene_backfill;
    `);
    expect(rows(upgraded)).toEqual(before);
    upgraded.close();
  });
});

describe("migration 22 (inbox content hash, WI-3)", () => {
  it("stamps queued rows with their content hash, and reverses without losing a row", () => {
    const dir = tmpUserData();
    const atTwentyOne = openDatabase(dir, 21);
    const inboxColumnsAt21 = columnNames(atTwentyOne, "inbox");
    atTwentyOne
      .prepare("INSERT INTO inbox (recipient, payload, created_at, ref) VALUES (?, ?, ?, ?)")
      .run("supervision", "[fm-op] crew-1 reported on task t1", 1, "t1");
    atTwentyOne.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const row = { payload: "[fm-op] crew-1 reported on task t1" };
    expect(upgraded.prepare("SELECT content_hash FROM inbox").get()).toEqual({
      content_hash: inboxContentHash(row.payload),
    });
    // A queued wake from before the upgrade dedupes the same wake after it.
    expect(
      new InboxStore(upgraded).enqueueWake("supervision", row.payload, "agent", "t1"),
    ).toBeNull();

    // Reversible: dropping the column and the table restores the v21 shape
    // with every row intact.
    // (Migrations 48, 45 and 32 are reversed first, newest to oldest.)
    upgraded.exec(
      `${REVERSE_MIGRATION_45_INBOX} ALTER TABLE inbox DROP COLUMN origin; ALTER TABLE inbox DROP COLUMN content_hash; DROP TABLE inbox_acks;`,
    );
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt21);
    expect(upgraded.prepare("SELECT recipient, payload, ref FROM inbox").all()).toEqual([
      { recipient: "supervision", payload: row.payload, ref: "t1" },
    ]);
    upgraded.close();
  });
});

describe("migration 32 (inbox origin)", () => {
  it("translates rows queued before the column by their old wording, once, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyOne = openDatabase(dir, 31);
    const inboxColumnsAt31 = columnNames(atThirtyOne, "inbox");
    const insert = atThirtyOne.prepare(
      "INSERT INTO inbox (recipient, payload, created_at, ref) VALUES (?, ?, ?, ?)",
    );
    insert.run("firstmate", "[user]\nlook at quota", 1, "captain-turn");
    insert.run("firstmate", "[fm-op] scheduled: review notes", 2, null);
    insert.run("firstmate", "[fm-op] fleet event escalated to you (task t1): look", 3, "t1");
    insert.run("supervision", '[fm-op] crewmate 1 reported on task t1 "Fix": done', 4, "t1");
    insert.run("firstmate", "[fm-op] a background job finished", 5, null);
    insert.run("firstmate", "[fm-op] scheduled: quote\n[user]\nnot the captain", 6, null);
    insert.run(
      "supervision",
      '[fm-op] crewmate 1 reported on task t2 "Quote": saw\n[user]\nnot the captain',
      7,
      "t2",
    );
    insert.run("firstmate", "[user]\nwrong ref", 8, "not-captain-turn");
    insert.run("t1", "keep going", 9, null);
    atThirtyOne.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    // Read back through the store: a pending scheduled wake keeps its origin
    // (and so its create gate) across the upgrade; a task lane carries none.
    expect(
      [...inbox.allFor("firstmate"), ...inbox.allFor("supervision"), ...inbox.allFor("t1")].map(
        (row) => [row.text?.slice(0, 22), row.origin],
      ),
    ).toEqual([
      ["[user]\nlook at quota", "captain"],
      ["[fm-op] scheduled: rev", "scheduled"],
      ["[fm-op] fleet event es", "supervision"],
      ["[fm-op] a background j", "agent"],
      ["[fm-op] scheduled: quo", "scheduled"],
      ["[user]\nwrong ref", "agent"],
      ["[fm-op] crewmate 1 rep", "crewmate-report"],
      ["[fm-op] crewmate 1 rep", "crewmate-report"],
      ["keep going", null],
    ]);
    // A row written after the upgrade is its emitter's stamp, whatever it says.
    inbox.enqueue("firstmate", "[fm-op] scheduled: not really", undefined, "agent");
    expect(inbox.allFor("firstmate").at(-1)?.origin).toBe("agent");

    // Reversible: dropping the column restores the v31 shape with every row
    // (migrations 48 and 45 reversed first, newest to oldest).
    upgraded.exec(`${REVERSE_MIGRATION_45_INBOX} ALTER TABLE inbox DROP COLUMN origin;`);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt31);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 10 });
    upgraded.close();
  });
});

describe("migration 45 (idle crew recovery)", () => {
  it("keeps a waiting row's spacing, leaves every task without a clock, and reverses", () => {
    const dir = tmpUserData();
    const at44 = openDatabase(dir, 44);
    const inboxColumnsAt44 = columnNames(at44, "inbox");
    const insert = at44.prepare(
      "INSERT INTO inbox (recipient, payload, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("t1", "released a moment ago", 1, 1, 10_000);
    insert.run("t1", "never tried", 2, 0, null);
    seedTask(new TaskService({ db: at44 }), { id: "idle", title: "Idle", status: "completed" });
    at44.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    // The released row is due one grace after its attempt, as before; the
    // fresh one is due now; neither has met the provider failing.
    expect(inbox.pending("t1", 10_000 + INBOX_GRACE_MS - 1).map((row) => row.text)).toEqual([
      "never tried",
    ]);
    expect(inbox.pending("t1", 10_000 + INBOX_GRACE_MS)).toHaveLength(2);
    expect(inbox.allFor("t1").map((row) => row.failures)).toEqual([0, 0]);
    const record = new TaskService({ db: upgraded }).get("idle");
    expect(record).toMatchObject({ idleSince: null, recoveryRung: 0, recoveryCount: 0 });

    // Reversible: dropping the inbox's three columns (48 unwrapped first)
    // restores its v44 shape.
    upgraded.exec(REVERSE_MIGRATION_45_INBOX);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt44);
    upgraded.close();
  });

  it("gives a task record from before the clock its four columns", () => {
    const dir = tmpUserData();
    const at44 = openDatabase(dir, 44);
    dropViews(at44);
    for (const column of ["idle_since", "recovery_rung", "recovery_count", "recovery_at"]) {
      at44.exec(`ALTER TABLE tasks DROP COLUMN ${column};`);
    }
    at44.close();
    const upgraded = openDatabase(dir);
    expect(columnNames(upgraded, "tasks")).toEqual(
      expect.arrayContaining(["idle_since", "recovery_rung", "recovery_count", "recovery_at"]),
    );
    upgraded.close();
  });
});

describe("migration 46 (the two graph gaps)", () => {
  it("drops the stored basis verdict and review pointer, and the record derives both back", () => {
    const dir = tmpUserData();
    const at45 = openDatabase(dir, 45);
    // The one writer writes today's schema: a part's filing names its
    // parent in migration 71's table, lent here and taken back below.
    at45.exec(MIGRATION_71_TABLE + TASK_REFERENCES_TABLE);
    const before = new TaskService({ db: at45, strict: true });
    seedTask(before, { id: "plan", title: "Plan", status: "completed", outcome: "Do B." });
    seedTask(before, { id: "wip", title: "Still going", status: "running" });
    seedTask(before, {
      id: "build",
      title: "Build B",
      status: "idle",
      shape: { kind: "implement", kind_source: "classifier:test", basis: "plan" },
    });
    seedTask(before, {
      id: "guess",
      title: "Build on a guess",
      status: "queued",
      shape: { kind: "implement", kind_source: "classifier:test", basis: "wip" },
    });
    seedTask(before, {
      id: "review",
      title: "Review: Build B",
      status: "idle",
      parentId: "build",
      shape: { kind: "review", kind_source: "host:review", basis: "build" },
    });
    before.recordDelivery("build", { reviewVerdict: "findings", reviewedAt: Date.now() });
    at45.exec(REVERSE_TASK_REFERENCES);
    // The stamps as a database before this migration stored them: a verdict
    // gone stale (the guess still says verified) and the cached join.
    at45.exec(`
      UPDATE tasks SET shape_json = json_set(shape_json, '$.basis_verified', json('true'))
        WHERE id IN ('build', 'guess', 'review');
      UPDATE tasks SET delivery_json = json_set(delivery_json, '$.reviewTaskId', 'review')
        WHERE id = 'build';
    `);
    at45.exec(REVERSE_MIGRATION_71);
    at45.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const stamps = upgraded
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE json_type(shape_json, '$.basis_verified') IS NOT NULL OR json_type(delivery_json, '$.reviewTaskId') IS NOT NULL",
      )
      .get();
    expect(stamps).toEqual({ n: 0 });
    // Everything else on the rows stays; the verdict and the join are read.
    const tasks = new TaskService({ db: upgraded, strict: true });
    const build = tasks.get("build");
    const guess = tasks.get("guess");
    expect(build?.shape).toEqual({
      kind: "implement",
      kind_source: "classifier:test",
      basis: "plan",
    });
    expect(build?.delivery).toMatchObject({ reviewVerdict: "findings" });
    expect(build && tasks.basisOf(build)).toEqual({ ref: "plan", verified: true });
    expect(guess && tasks.basisOf(guess)).toEqual({ ref: "wip", verified: false });
    expect(build && tasks.verdictReviewOf(build)?.id).toBe("review");
    upgraded.close();
  });
});

describe("migration 47 (the gate becomes a witness, the primitives review P2)", () => {
  it("gates an active builder whose cap stands, logs each row, leaves the rest, and reverses", () => {
    const dir = tmpUserData();
    const at46 = openDatabase(dir, 46);
    const tasks = new TaskService({ db: at46 });
    const active = (id: string) =>
      seedTask(tasks, { id, title: id, status: "completed", worktreeDir: `/wt/${id}` });
    active("ci-capped");
    tasks.recordDelivery("ci-capped", { ciRounds: 3, ciRedHead: "abc1234", ciCapAt: 100 });
    active("review-capped");
    tasks.recordDelivery("review-capped", {
      headSha: "def5678",
      reviewRounds: 3,
      reviewRoundSha: "def5678",
      reviewCapAt: 200,
    });
    // Answered since the cap: the steer that reopens the rounds is all it waits on.
    active("answered");
    tasks.recordDelivery("answered", { ciRounds: 3, ciCapAt: 100, capAnsweredAt: 150 });
    // A row that already has a gate keeps it.
    active("gated");
    tasks.recordDelivery("gated", { ciRounds: 3, ciCapAt: 100 });
    tasks.setGate("gated", { kind: "at-time", until: 999 });
    active("uncapped");
    tasks.recordDelivery("uncapped", { ciRounds: 1, ciRedHead: "abc1234" });
    at46.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const read = new TaskService({ db: upgraded });
    expect(read.get("ci-capped")?.gate).toEqual({
      kind: "captain",
      ref: "abc1234",
      reason: "the CI cap",
    });
    expect(read.get("review-capped")?.gate).toEqual({
      kind: "captain",
      ref: "def5678",
      reason: "the review cap",
    });
    expect(read.get("answered")?.gate).toBeNull();
    expect(read.get("gated")?.gate).toEqual({ kind: "at-time", until: 999 });
    expect(read.get("uncapped")?.gate).toBeNull();
    expect(
      upgraded
        .prepare("SELECT task_id, gate_ref, gate_reason FROM cap_gate_backfill ORDER BY task_id")
        .all(),
    ).toEqual([
      { task_id: "ci-capped", gate_ref: "abc1234", gate_reason: "the CI cap" },
      { task_id: "review-capped", gate_ref: "def5678", gate_reason: "the review cap" },
    ]);

    // Reversible: clear the gate of every logged row and drop the log.
    upgraded.exec(
      "UPDATE tasks SET gate_kind = NULL, gate_ref = NULL, gate_until = NULL, gate_reason = NULL WHERE id IN (SELECT task_id FROM cap_gate_backfill); DROP TABLE cap_gate_backfill;",
    );
    const reversed = new TaskService({ db: upgraded });
    for (const id of ["ci-capped", "review-capped", "answered", "uncapped"]) {
      expect(reversed.get(id)?.gate, id).toBeNull();
    }
    expect(reversed.get("gated")?.gate).toEqual({ kind: "at-time", until: 999 });
    upgraded.close();
  });
});

describe("migration 48 (the typed wake envelope, the primitives review P3)", () => {
  it("wraps every queued row as prose, keeps its identity, and reverses to the prose served", () => {
    const dir = tmpUserData();
    const at47 = openDatabase(dir, 47);
    const inboxColumnsAt47 = columnNames(at47, "inbox");
    // The legacy store wrote the payload as text: a queued wake, a steer,
    // and a wake the Firstmate already acked, remembered for the dedupe.
    at47
      .prepare(
        "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "firstmate",
        '[fm-op] task t1 "Fix" is waiting.',
        1,
        "t1",
        inboxContentHash('[fm-op] task t1 "Fix" is waiting.'),
        "agent",
      );
    at47
      .prepare("INSERT INTO inbox (recipient, payload, created_at) VALUES (?, ?, ?)")
      .run("t1", "keep going", 2);
    at47
      .prepare(
        "INSERT INTO inbox_acks (recipient, ref, row_id, content_hash, acked_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("firstmate", "t2", 0, inboxContentHash("[fm-op] t2 reported."), Date.now());
    at47.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // The envelope adds no column; migration 74 adds the cut count.
    expect(columnNames(upgraded, "inbox")).toEqual([...inboxColumnsAt47, "cuts"]);
    const inbox = new InboxStore(upgraded);
    expect(
      [...inbox.allFor("firstmate"), ...inbox.allFor("t1")].map(({ v, text, facts, origin }) => ({
        v,
        text,
        facts,
        origin,
      })),
    ).toEqual([
      { v: 1, text: '[fm-op] task t1 "Fix" is waiting.', facts: undefined, origin: "agent" },
      { v: 1, text: "keep going", facts: undefined, origin: null },
    ]);
    // The identity is the text's, as before: the queued wake and the acked
    // one still dedupe their prose after the upgrade.
    expect(
      inbox.enqueueWake("firstmate", '[fm-op] task t1 "Fix" is waiting.', "agent", "t1"),
    ).toBeNull();
    expect(inbox.enqueueWake("firstmate", "[fm-op] t2 reported.", "agent", "t2")).toBeNull();
    // A typed wake queued after the upgrade.
    inbox.enqueue("t1", idleNudge());

    // Reversible: every payload back to the prose it serves - a typed row
    // rendered - with the text's hash, restores the v47 inbox.
    const restamp = upgraded.prepare("UPDATE inbox SET payload = ?, content_hash = ? WHERE id = ?");
    for (const row of [...inbox.allFor("firstmate"), ...inbox.allFor("t1")]) {
      const prose = renderWake(row);
      restamp.run(prose, inboxContentHash(prose), row.id);
    }
    upgraded.prepare("DELETE FROM schema_migrations WHERE version = 48").run();
    upgraded.close();
    const reversed = openDatabase(dir, 47);
    expect(reversed.prepare("SELECT recipient, payload FROM inbox ORDER BY id").all()).toEqual([
      { recipient: "firstmate", payload: '[fm-op] task t1 "Fix" is waiting.' },
      { recipient: "t1", payload: "keep going" },
      { recipient: "t1", payload: IDLE_NUDGE_TEXT },
    ]);
    reversed.close();
  });
});

describe("migration 49 (a wake's durable once-identity, the primitives review P3)", () => {
  it("adds the once record, which a reopened database still reads, and reverses", () => {
    const dir = tmpUserData();
    const at48 = openDatabase(dir, 48);
    at48
      .prepare("INSERT INTO inbox (recipient, payload, created_at) VALUES (?, ?, ?)")
      .run("t1", JSON.stringify({ v: 1, text: "keep going" }), 1);
    const tablesAt48 = tableNames(at48);
    expect(tablesAt48).not.toContain("inbox_once");
    at48.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "inbox_once")).toEqual(["ref", "once_key", "at"]);
    const wake = stillDownWake(
      { id: "t1", title: "Fix", key: "SCR-1" },
      { since: 5, failures: 4 },
      900_005,
    );
    expect(new InboxStore(upgraded).enqueueWake("firstmate", wake, "agent", "t1")).not.toBeNull();
    upgraded.close();

    // An app restart: the once is on disk, and the queued guidance untouched.
    const reopened = openDatabase(dir);
    const inbox = new InboxStore(reopened);
    expect(inbox.woken("t1", stillDownOnce(5))).toBe(true);
    expect(inbox.enqueueWake("firstmate", wake, "agent", "t1")).toBeNull();
    expect(inbox.allFor("t1").map((row) => row.text)).toEqual(["keep going"]);

    // Reversible: dropping the table restores the v48 schema. Migration 50
    // is the head: undoing it comes first.
    dropViews(reopened);
    reopened.exec(
      REVERSE_RUNNING_WORK +
        REVERSE_TASK_REFERENCES +
        REVERSE_TASK_SESSIONS +
        REVERSE_MIGRATION_80 +
        REVERSE_MIGRATION_79 +
        REVERSE_MIGRATION_78 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    reopened.exec(REVERSE_MIGRATION_50);
    reopened.exec("DROP TABLE inbox_once");
    reopened.prepare("DELETE FROM schema_migrations WHERE version IN (49, 50)").run();
    reopened.close();
    const reversed = openDatabase(dir, 48);
    expect(tableNames(reversed)).toEqual(tablesAt48);
    reversed.close();
  });
});

describe("migration 50 (one decision ledger, the primitives review P6)", () => {
  it("moves every routing, account and sort row into one ledger, reads the same through the old names, and reverses", () => {
    const dir = tmpUserData();
    const at49 = openDatabase(dir, 49);
    seedTask(new TaskService({ db: at49, strict: true }), {
      id: "t1",
      title: "Routed and sorted",
      status: "idle",
    });
    const sort = at49.prepare(
      `INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at, card_id, model, missed_escalation, missed_note, missed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A retired triage's verdict, labelled a miss, and a rule's sort.
    sort.run(
      "t1",
      "[fm-op] reported: tests green",
      "routine",
      "green",
      10,
      null,
      "grok-build-0.1",
      1,
      "mine",
      11,
    );
    sort.run(
      "t1",
      "[fm-op] reported: stopped",
      "captain",
      "stopped",
      20,
      "card-1",
      "rule:stopped",
      null,
      null,
      null,
    );
    const route = at49.prepare(
      "INSERT INTO routing_decisions (task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    route.run("t1", "openai-codex", "gpt-5.5", "high", "R3", "medium", '["shape kind=change"]', 5);
    route.run("t1", null, null, "high", "R3", null, '["nothing served"]', 30);
    at49
      .prepare(
        "INSERT INTO account_decisions (task_id, provider, account_id, reasons_json, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "openai-codex", "acct-1", '["headroom first"]', 6);
    const read = (db: AppDatabase) => ({
      sort: db.prepare("SELECT * FROM supervision_outcomes ORDER BY id").all(),
      routing: db
        .prepare(
          "SELECT task_id, provider, model, bucket, reasons_json, at, rule, served FROM routing_decisions ORDER BY id",
        )
        .all(),
      account: db
        .prepare(
          "SELECT task_id, provider, account_id, reasons_json, at FROM account_decisions ORDER BY id",
        )
        .all(),
      published: db.prepare("SELECT * FROM v_routing_v1 ORDER BY at").all(),
      board: db.prepare("SELECT task_id, model, provider, tier FROM v_tasks_v1").all(),
    });
    const before = read(at49);
    const columnsAt49 = {
      sort: columnNames(at49, "supervision_outcomes"),
      routing: columnNames(at49, "routing_decisions"),
      account: columnNames(at49, "account_decisions"),
    };
    const tablesAt49 = tableNames(at49);
    at49.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const tables = tableNames(upgraded);
    expect(tables).toContain("decisions");
    for (const old of ["routing_decisions", "account_decisions", "supervision_outcomes"]) {
      expect(tables).not.toContain(old);
    }
    // One ledger: a sort row keeps its id (the log and the decided events
    // name it), the rule leaves `model` for `rule`, the rest follow in order.
    expect(
      upgraded.prepare("SELECT id, kind, task_id, rule, model FROM decisions ORDER BY id").all(),
    ).toEqual([
      { id: 1, kind: "sort", task_id: "t1", rule: null, model: "grok-build-0.1" },
      { id: 2, kind: "sort", task_id: "t1", rule: "stopped", model: null },
      { id: 3, kind: "routing", task_id: "t1", rule: "R3", model: "gpt-5.5" },
      { id: 4, kind: "routing", task_id: "t1", rule: "R3", model: null },
      { id: 5, kind: "account", task_id: "t1", rule: null, model: null },
    ]);
    // Every reader of the old names reads the same rows; a sort row adds
    // only its (absent) facts.
    const after = read(upgraded);
    expect(after).toEqual({
      ...before,
      sort: (before.sort as Record<string, unknown>[]).map((row) => ({ ...row, facts_json: null })),
    });
    expect(columnNames(upgraded, "supervision_outcomes")).toEqual([
      ...columnsAt49.sort,
      "facts_json",
    ]);
    expect(columnNames(upgraded, "routing_decisions")).toEqual(columnsAt49.routing);
    expect(columnNames(upgraded, "account_decisions")).toEqual(columnsAt49.account);
    // The old names are views: the ledger has one writer.
    expect(() =>
      upgraded
        .prepare(
          "INSERT INTO routing_decisions (task_id, bucket, reasons_json, at) VALUES ('t1', 'low', '[]', 1)",
        )
        .run(),
    ).toThrow();

    // Reversible: the three tables back from their kinds, every row as it was.
    dropViews(upgraded);
    upgraded.exec(
      REVERSE_RUNNING_WORK +
        REVERSE_TASK_REFERENCES +
        REVERSE_TASK_SESSIONS +
        REVERSE_MIGRATION_80 +
        REVERSE_MIGRATION_79 +
        REVERSE_MIGRATION_78 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    upgraded.exec(REVERSE_MIGRATION_50);
    upgraded.prepare("DELETE FROM schema_migrations WHERE version = 50").run();
    upgraded.close();
    const reversed = openDatabase(dir, 49);
    expect(tableNames(reversed)).toEqual(tablesAt49);
    expect(read(reversed)).toEqual(before);
    reversed.close();
  });
});

describe("migrations 34-35 (the work shape, its rule, and the served tier)", () => {
  it("adds every column to a database that predates the shape, keeps every row, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyThree = openDatabase(dir, 33);
    const tasks = new TaskService({ db: atThirtyThree, strict: true });
    seedTask(tasks, { id: "old1", title: "Routed before the shape", status: "idle" });
    // A database created after this change receives `shape_json` with the
    // task record itself; the one this migration exists for is the captain's,
    // whose tasks table predates the shape entirely.
    atThirtyThree.exec("ALTER TABLE tasks DROP COLUMN shape_json;");
    const taskColumnsAt33 = columnNames(atThirtyThree, "tasks");
    const routingColumnsAt33 = columnNames(atThirtyThree, "routing_decisions");
    atThirtyThree
      .prepare(
        "INSERT INTO routing_decisions (task_id, provider, model, bucket, reasons_json, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("old1", "openai-codex", "gpt-5.5", "medium", '["picked codex/gpt-5.5"]', 1);
    atThirtyThree.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "tasks")).toContain("shape_json");
    expect(columnNames(upgraded, "routing_decisions")).toContain("rule");
    expect(columnNames(upgraded, "routing_decisions")).toContain("served");
    // Nothing is backfilled: a row routed before the shape existed has no
    // shape and no rule, which is the honest answer, never a guessed kind.
    // `served` is not assumed equal to `bucket` either - what the ladder
    // actually answered with was never recorded on that row.
    expect(
      upgraded.prepare("SELECT id, difficulty, shape_json FROM tasks WHERE id = 'old1'").get(),
    ).toEqual({ id: "old1", difficulty: null, shape_json: null });
    expect(
      upgraded.prepare("SELECT task_id, bucket, rule, served FROM routing_decisions").all(),
    ).toEqual([{ task_id: "old1", bucket: "medium", rule: null, served: null }]);

    // Reversible: dropping the columns restores the v33 shape with every row.
    // Migration 42's views read these columns, and migration 50 moved the
    // table into the ledger: undoing the head undoes both first.
    dropViews(upgraded);
    upgraded.exec(
      REVERSE_RUNNING_WORK +
        REVERSE_MIGRATION_76 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_63 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    upgraded.exec(REVERSE_MIGRATION_50);
    upgraded.exec(
      "ALTER TABLE tasks DROP COLUMN shape_json; ALTER TABLE routing_decisions DROP COLUMN rule; ALTER TABLE routing_decisions DROP COLUMN served;",
    );
    expect(columnNames(upgraded, "tasks")).toEqual(taskColumnsAt33);
    expect(columnNames(upgraded, "routing_decisions")).toEqual(routingColumnsAt33);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    upgraded.close();
  });
});

describe("migration 36 (the repository's standing rigor, delivery rigor phase 3)", () => {
  it("adds the rigor column and migration 44 backfills legacy projects to standard", () => {
    const dir = tmpUserData();
    const atThirtyFive = openDatabase(dir, 35);
    const repoColumnsAt35 = columnNames(atThirtyFive, "repos");
    expect(repoColumnsAt35).not.toContain("rigor");
    atThirtyFive
      .prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 1)",
      )
      .run("r-old", "/fleet/meterlab", "meterlab", 1, "https://example.com/meterlab.git");
    atThirtyFive.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "repos")).toContain("rigor");
    // Existing projects receive the explicit standard standing value.
    expect(
      upgraded.prepare("SELECT id, delivery, autonomy, rigor FROM repos WHERE id = 'r-old'").get(),
    ).toEqual({ id: "r-old", delivery: "direct-pr", autonomy: 1, rigor: "standard" });
    // The registry reads the column as the view's `rigor`.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-old")?.rigor).toBe("standard");
    expect(registry.configure("r-old", { rigor: "reviewed" }).rigor).toBe("reviewed");

    // Reversible: dropping every added column restores the v35 shape with
    // the row (migration 37 adds `kind` and migration 40 the host on top of
    // this one).
    // Migration 42's views read these columns: undoing the head undoes it first.
    dropViews(upgraded);
    upgraded.exec(REVERSE_MIGRATION_64);
    upgraded.exec("ALTER TABLE repos DROP COLUMN rigor;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_host;");
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt35);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 1 });
    upgraded.close();
  });
});

describe("migration 37 (the workspace kind, crew-posture rationalization Task A)", () => {
  it("adds the kind column, maps a live repo to the personal kind on local-only, and reverses", () => {
    const dir = tmpUserData();
    const atThirtySix = openDatabase(dir, 36);
    const repoColumnsAt36 = columnNames(atThirtySix, "repos");
    expect(repoColumnsAt36).not.toContain("kind");
    const insert = atThirtySix.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("r-personal", "/data/fleet/personal", "personal", 1, "init", null, "live", 1);
    insert.run("r-project", "/fleet/meterlab", "meterlab", 2, "clone", null, "direct-pr", 0);
    insert.run("r-local", "/fleet/notes", "notes", 3, "init", null, "local-only", 0);
    atThirtySix.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "repos")).toContain("kind");
    // The one live row becomes the personal KIND; its delivery drops to the
    // local-only nobody reads, because delivery now says only where a
    // change lands and this workspace lands none.
    expect(
      upgraded.prepare("SELECT id, kind, delivery FROM repos ORDER BY added_at").all(),
    ).toEqual([
      { id: "r-personal", kind: "personal", delivery: "local-only" },
      { id: "r-project", kind: "project", delivery: "direct-pr" },
      { id: "r-local", kind: "project", delivery: "local-only" },
    ]);
    // The registry reads it as the view's `kind` and refuses the personal
    // row's whole policy patch.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-personal")?.kind).toBe("personal");
    expect(registry.get("r-project")?.kind).toBe("project");
    expect(() => registry.configure("r-personal", { autonomy: false })).toThrow(/builds in place/);
    expect(registry.configure("r-project", { delivery: "local-only" }).delivery).toBe("local-only");

    // Reversible: dropping the column restores the v36 shape with the rows
    // (migration 40 adds the host on top of this one, and migration 42's
    // views read the column, so undoing the head undoes them first).
    dropViews(upgraded);
    upgraded.exec(REVERSE_MIGRATION_64);
    upgraded.exec("ALTER TABLE repos DROP COLUMN kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_host;");
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt36);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 3 });
    upgraded.close();
  });
});

describe("migrations 24-25 (card lineage and the duplicate label, interaction P1)", () => {
  it("adds card_revisions and three nullable duplicate columns, keeps existing cards, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyThree = openDatabase(dir, 23);
    atTwentyThree
      .prepare(
        `INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', NULL, 'note', 30, 'A card', 'crewmate 1', '<p>a</p>', '[]', 'ready', 1)`,
      )
      .run();
    const before = columnNames(atTwentyThree, "cards");
    atTwentyThree.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Migration 29 (cards/tasks/agents P1) adds `author` after these,
    // migration 41 (card pictures) `pictures_json`, migration 52 (the card
    // return rule) `awaiting`, migration 54 (inline decisions)
    // `answers_json`, migration 55 (card width) `width`, migration 56 (the
    // model chip) `model`, and migration 57 (the card evidence) the
    // lifecycle and offer pointers, migration 59 (reply to the back)
    // `sent_back_at`, migration 65 (a card's live attachment)
    // `attachment_json`, migration 67 (where its task runs) `place`,
    // migration 69 (a merge card's risk) `risk_json`, and migration 70 (a
    // card that takes no reply) `replies`, migration 77 `holds_place`,
    // migration 82 `required_actions_json`, migration 87 `review_task_id`,
    // INF-476 `minimized` and INF-1226 `continues`.
    expect(columnNames(upgraded, "cards")).toEqual([
      ...before,
      "duplicate_of",
      "duplicate_note",
      "duplicate_at",
      "author",
      "pictures_json",
      "awaiting",
      "answers_json",
      "width",
      "model",
      "lifecycle_id",
      "offer_id",
      "sent_back_at",
      "attachment_json",
      "place",
      "risk_json",
      "replies",
      "holds_place",
      "required_actions_json",
      "review_task_id",
      "minimized",
      "continues",
    ]);
    expect(columnNames(upgraded, "card_revisions")).toEqual([
      "id",
      "card_id",
      "revision",
      "kind",
      "title",
      "body",
      "actions_json",
      "created_at",
      "replaced_at",
      "replaced_by",
    ]);
    // An existing card is unlabelled, never "not a duplicate".
    expect(
      upgraded
        .prepare("SELECT id, title, duplicate_of, duplicate_note, duplicate_at FROM cards")
        .all(),
    ).toEqual([
      {
        id: "card-old",
        title: "A card",
        duplicate_of: null,
        duplicate_note: null,
        duplicate_at: null,
      },
    ]);

    // Reversible: dropping what 24, 25 (and 29, 41, 52, 54, 55, 56 and 57 on top) added
    // restores the version-23 shape and rows.
    upgraded.exec(`
      DROP TABLE card_revisions;
      DROP TABLE card_effect_backfill;
      ALTER TABLE cards DROP COLUMN author;
      ALTER TABLE cards DROP COLUMN duplicate_of;
      ALTER TABLE cards DROP COLUMN duplicate_note;
      ALTER TABLE cards DROP COLUMN duplicate_at;
      ALTER TABLE cards DROP COLUMN pictures_json;
      ALTER TABLE cards DROP COLUMN awaiting;
      ALTER TABLE cards DROP COLUMN answers_json;
      ALTER TABLE cards DROP COLUMN width;
      ALTER TABLE cards DROP COLUMN model;
    `);
    upgraded.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(upgraded, "cards")).toEqual(before);
    expect(upgraded.prepare("SELECT id, title FROM cards").all()).toEqual([
      { id: "card-old", title: "A card" },
    ]);
    upgraded.close();
  });
});

describe("migration 26 (follow-ups stop being children)", () => {
  it("detaches a filed follow-up from its origin, keeps blocks edges, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyFive = openDatabase(dir, 25);
    const task = (id: string, parent: string | null, status: string) =>
      atTwentyFive
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, priority, start_policy, workspace_state, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', ?, 'work', ?, 'p', '', '', '', ?, 2, 'on-request', 'none', 1, 1)`,
        )
        .run(id, id.toUpperCase(), parent, id, status);
    const link = (from: string, to: string, type: string) =>
      atTwentyFive
        .prepare(
          "INSERT INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, ?, 'crewmate', 1)",
        )
        .run(from, to, type);
    task("origin", null, "active");
    task("followup", "origin", "open");
    task("blocking", "origin", "open");
    task("closed-followup", "origin", "done");
    task("real-child", "origin", "open");
    link("followup", "origin", "discovered-from");
    link("blocking", "origin", "discovered-from");
    link("blocking", "origin", "blocks");
    link("closed-followup", "origin", "discovered-from");
    atTwentyFive.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const parents = Object.fromEntries(
      (
        upgraded.prepare("SELECT id, parent_id FROM tasks ORDER BY id").all() as {
          id: string;
          parent_id: string | null;
        }[]
      ).map((row) => [row.id, row.parent_id]),
    );
    // Both live follow-ups detach - including the one that blocks, which
    // keeps holding its origin through the blocks edge instead.
    expect(parents.followup).toBeNull();
    expect(parents.blocking).toBeNull();
    // A child that was never a follow-up is real containment, and a closed
    // follow-up keeps the history it was filed with.
    expect(parents["real-child"]).toBe("origin");
    expect(parents["closed-followup"]).toBe("origin");
    expect(
      upgraded.prepare("SELECT from_id, to_id, type FROM task_links WHERE type = 'blocks'").all(),
    ).toEqual([{ from_id: "blocking", to_id: "origin", type: "blocks" }]);

    // Reversible: every detached parent is recorded, so restoring them and
    // dropping the table returns the version-25 shape.
    const backfill = upgraded
      .prepare("SELECT task_id, parent_id FROM followup_parent_backfill ORDER BY task_id")
      .all() as { task_id: string; parent_id: string }[];
    expect(backfill).toEqual([
      { task_id: "blocking", parent_id: "origin" },
      { task_id: "followup", parent_id: "origin" },
    ]);
    const restore = upgraded.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?");
    for (const row of backfill) restore.run(row.parent_id, row.task_id);
    upgraded.exec("DROP TABLE followup_parent_backfill;");
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = 'origin'").get(),
    ).toEqual({ n: 4 });
    upgraded.close();
  });
});

describe("migration 28 (parked decisions retire, cards/tasks/agents P0)", () => {
  it("closes every open park row with a timeline note, leaves live decision rows alone, and reverses", () => {
    const dir = tmpUserData();
    const atTwentySeven = openDatabase(dir, 27);
    const decision = (
      id: string,
      status: string,
      gateRef: string | null,
      gateUntil: number | null,
    ) =>
      atTwentySeven
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, priority, start_policy, workspace_state,
             gate_kind, gate_ref, gate_until, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', NULL, 'decision', ?, '', '', '', '', ?, 2, 'on-request', 'none',
             ?, ?, ?, 1, 1)`,
        )
        .run(id, id.toUpperCase(), id, status, gateRef ? "captain" : null, gateRef, gateUntil);
    // Two parks from before P1 (rows keyed park-<card id>), a P1 decision
    // row Later parked (a gate deadline), a live P1 decision row whose card
    // is on the stack, and a park that already closed.
    decision("park-card-fm-a", "open", "card-fm-a", 999);
    decision("park-card-t1-2", "open", "card-t1-2", 999);
    decision("d-parked", "open", "card-fm-parked", 777);
    decision("d-live", "open", "card-fm-live", null);
    decision("park-old", "done", null, null);
    atTwentySeven.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const rows = upgraded
      .prepare(
        "SELECT id, status, closed_reason, gate_kind, gate_ref, gate_until FROM tasks ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      {
        id: "d-live",
        status: "open",
        closed_reason: null,
        gate_kind: "captain",
        gate_ref: "card-fm-live",
        gate_until: null,
      },
      {
        id: "d-parked",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-card-fm-a",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-card-t1-2",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-old",
        status: "done",
        closed_reason: null,
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
    ]);
    // Each close explains itself on the timeline, off the feed.
    expect(
      upgraded.prepare("SELECT task_id, kind, text, feed FROM task_events ORDER BY task_id").all(),
    ).toEqual(
      ["d-parked", "park-card-fm-a", "park-card-t1-2"].map((task_id) => ({
        task_id,
        kind: "status",
        text: "parked decisions are retired; nothing brings this card back",
        feed: 0,
      })),
    );
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'dropped' AND closed_at IS NULL")
        .get(),
    ).toEqual({ n: 0 });

    // Reversible: the backfill table names every closed row with its gate.
    const backfill = upgraded
      .prepare("SELECT task_id, gate_ref, gate_until FROM park_row_backfill ORDER BY task_id")
      .all() as { task_id: string; gate_ref: string; gate_until: number }[];
    expect(backfill).toEqual([
      { task_id: "d-parked", gate_ref: "card-fm-parked", gate_until: 777 },
      { task_id: "park-card-fm-a", gate_ref: "card-fm-a", gate_until: 999 },
      { task_id: "park-card-t1-2", gate_ref: "card-t1-2", gate_until: 999 },
    ]);
    const restore = upgraded.prepare(
      `UPDATE tasks SET status = 'open', closed_reason = NULL, closed_at = NULL,
         gate_kind = 'captain', gate_ref = ?, gate_until = ? WHERE id = ?`,
    );
    for (const row of backfill) restore.run(row.gate_ref, row.gate_until, row.task_id);
    upgraded.exec(`
      DELETE FROM task_events WHERE text = 'parked decisions are retired; nothing brings this card back';
      DROP TABLE park_row_backfill;
    `);
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'decision' AND status = 'open'")
        .get(),
    ).toEqual({ n: 4 });
    upgraded.close();
  });
});

describe("migration 29 (one card shape with effects, cards/tasks/agents P1)", () => {
  it("stamps the author, rewrites an open card's reserved ids into effects, leaves closed cards alone, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyEight = openDatabase(dir, 28);
    const insert = atTwentyEight.prepare(
      `INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
       VALUES (?, ?, ?, 30, ?, 'm', '<p>b</p>', ?, 'ready', ?, ?, ?)`,
    );
    const actions = (value: unknown) => JSON.stringify(value);
    // An open crewmate completion card under the old protocol: keep, the
    // reserved merge id, and a discard.
    insert.run(
      "card-t1-1",
      "t1",
      "decision",
      "The PR is ready",
      actions([
        { id: "keep", label: "Keep" },
        { id: "merge-pr", label: "Merge PR", variant: "primary", default: true },
        { id: "discard", label: "Discard" },
      ]),
      1,
      null,
      null,
    );
    // An open host card whose action id carried the account it restores.
    insert.run(
      "card-auth-account-acct_1",
      null,
      "decision",
      "Claude needs you to sign in again.",
      actions([{ id: "restore-account:acct_1", label: "Sign in", variant: "primary" }]),
      2,
      null,
      null,
    );
    // An open Firstmate decision with an ordinary reply and a Later.
    insert.run(
      "card-fm-plan",
      null,
      "decision",
      "Plan first",
      actions([
        { id: "approve", label: "Go ahead", default: true },
        { id: "later", label: "Later" },
      ]),
      3,
      null,
      null,
    );
    // The no-headroom host card.
    insert.run(
      "card-fm-no-headroom",
      null,
      "decision",
      "Firstmate has used up its allowance",
      actions([{ id: "open-settings", label: "Open settings", variant: "primary" }]),
      4,
      null,
      null,
    );
    // A closed settle card: history, untouched.
    insert.run(
      "card-t2-9",
      "t2",
      "decision",
      "Done",
      actions([
        { id: "keep", label: "Keep" },
        { id: "land", label: "Land", default: true },
      ]),
      5,
      6,
      "land",
    );
    // An open note with nothing to rewrite.
    insert.run("card-fm-note", null, "note", "A fact", "[]", 7, null, null);
    atTwentyEight.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // The author is derived from the id: the host's own singletons, the
    // Firstmate's prefix, and every other card a crewmate's.
    expect(
      upgraded.prepare("SELECT id, author, kind FROM cards ORDER BY created_at").all(),
    ).toEqual([
      { id: "card-t1-1", author: "crewmate", kind: "decision" },
      { id: "card-auth-account-acct_1", author: "host", kind: "decision" },
      { id: "card-fm-plan", author: "firstmate", kind: "decision" },
      { id: "card-fm-no-headroom", author: "host", kind: "decision" },
      { id: "card-t2-9", author: "crewmate", kind: "decision" },
      { id: "card-fm-note", author: "firstmate", kind: "note" },
    ]);
    // The real consumer reads every open card back as the one shape, with
    // the effects the old ids meant: keep and Later are gone (closing is
    // keep), a discard is danger, and the account rides the host effect.
    const open = new CardStore(upgraded).listOpen();
    const byId = (id: string) => open.find((card) => card.id === id);
    expect(byId("card-t1-1")).toMatchObject({ author: "crewmate", taskId: "t1" });
    expect(byId("card-t1-1")?.actions).toEqual([
      {
        id: "merge-pr",
        label: "Merge PR",
        variant: "primary",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
      {
        id: "discard",
        label: "Discard",
        effect: { kind: "settle", mode: "discard" },
        danger: true,
        variant: "danger",
      },
    ]);
    expect(byId("card-auth-account-acct_1")?.actions).toEqual([
      {
        id: "restore-account:acct_1",
        label: "Sign in",
        variant: "primary",
        effect: { kind: "host", op: "restore-account", arg: "acct_1" },
      },
    ]);
    expect(byId("card-fm-plan")?.actions).toEqual([
      { id: "approve", label: "Go ahead", default: true },
    ]);
    expect(byId("card-fm-no-headroom")?.actions).toEqual([
      {
        id: "open-settings",
        label: "Open settings",
        variant: "primary",
        effect: { kind: "open", target: "settings" },
      },
    ]);
    expect(byId("card-fm-note")?.actions).toEqual([]);
    for (const card of open) expect(card).not.toHaveProperty("kind");
    // The closed card is history and keeps its old ids verbatim.
    expect(
      (
        upgraded.prepare("SELECT actions_json FROM cards WHERE id = 'card-t2-9'").get() as {
          actions_json: string;
        }
      ).actions_json,
    ).toBe(
      actions([
        { id: "keep", label: "Keep" },
        { id: "land", label: "Land", default: true },
      ]),
    );

    // Reversible: the backfill table holds every rewritten card's original
    // actions; nothing is logged for a card the rewrite left as it was.
    const backfill = upgraded
      .prepare("SELECT card_id, actions_json FROM card_effect_backfill ORDER BY card_id")
      .all() as { card_id: string; actions_json: string }[];
    expect(backfill.map((row) => row.card_id)).toEqual([
      "card-auth-account-acct_1",
      "card-fm-no-headroom",
      "card-fm-plan",
      "card-t1-1",
    ]);
    const restore = upgraded.prepare("UPDATE cards SET actions_json = ? WHERE id = ?");
    for (const row of backfill) restore.run(row.actions_json, row.card_id);
    upgraded.exec(`
      DROP TABLE card_effect_backfill;
      ALTER TABLE cards DROP COLUMN author;
    `);
    expect(columnNames(upgraded, "cards")).not.toContain("author");
    expect(
      (
        upgraded.prepare("SELECT actions_json FROM cards WHERE id = 'card-t1-1'").get() as {
          actions_json: string;
        }
      ).actions_json,
    ).toBe(
      actions([
        { id: "keep", label: "Keep" },
        { id: "merge-pr", label: "Merge PR", variant: "primary", default: true },
        { id: "discard", label: "Discard" },
      ]),
    );
    upgraded.close();
  });
});

describe("migration 30 (retire the delivered status, cards/tasks/agents P2)", () => {
  it("rewrites every delivered row to done, records each for reversal, and leaves other rows alone", () => {
    const dir = tmpUserData();
    const atTwentyNine = openDatabase(dir, 29);
    const task = (id: string, status: string, closedReason: string | null) =>
      atTwentyNine
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, activity, closed_reason, closed_at, priority, start_policy,
             workspace_state, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', NULL, 'work', ?, '', '', '', '', ?, NULL, ?, 100, 2, 'when-ready',
             'present', 1, 1)`,
        )
        .run(id, id.toUpperCase(), id, status, closedReason);
    // Two delivered rows from before WI-11 - one finished, one that closed
    // under a landing - plus a done row and a live active row that must not move.
    task("deliv-finished", "delivered", "finished");
    task("deliv-landed", "delivered", "landed");
    task("already-done", "done", "settled");
    task("still-active", "active", null);
    atTwentyNine.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Every delivered row is done now; its closed_reason already records how
    // it closed, so nothing else moves.
    expect(
      upgraded.prepare("SELECT id, status, closed_reason FROM tasks ORDER BY id").all(),
    ).toEqual([
      { id: "already-done", status: "done", closed_reason: "settled" },
      { id: "deliv-finished", status: "done", closed_reason: "finished" },
      { id: "deliv-landed", status: "done", closed_reason: "landed" },
      { id: "still-active", status: "active", closed_reason: null },
    ]);
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'delivered'").get(),
    ).toEqual({ n: 0 });

    // Reversible: the backfill names every rewritten row with the reason it
    // closed under, so restoring status per row and dropping the table undoes it.
    const backfill = upgraded
      .prepare("SELECT task_id, closed_reason FROM delivered_status_backfill ORDER BY task_id")
      .all() as { task_id: string; closed_reason: string | null }[];
    expect(backfill).toEqual([
      { task_id: "deliv-finished", closed_reason: "finished" },
      { task_id: "deliv-landed", closed_reason: "landed" },
    ]);
    const restore = upgraded.prepare("UPDATE tasks SET status = 'delivered' WHERE id = ?");
    for (const row of backfill) restore.run(row.task_id);
    upgraded.exec("DROP TABLE delivered_status_backfill;");
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'delivered'").get(),
    ).toEqual({ n: 2 });
    upgraded.close();
  });
});

describe("migration 40 (where each project lives, git integration PR 1.1)", () => {
  it("stamps every repo's host from its origin, logs each value, reads it on the view, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyNine = openDatabase(dir, 39);
    const repoColumnsAt39 = columnNames(atThirtyNine, "repos");
    expect(repoColumnsAt39).not.toContain("forge_kind");
    const insert = atThirtyNine.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    );
    insert.run(
      "r-gh",
      "/fleet/meter",
      "meter",
      1,
      "clone",
      "git@github.com:o/meter.git",
      "direct-pr",
    );
    insert.run(
      "r-host",
      "/fleet/wiki",
      "wiki",
      2,
      "clone",
      "https://git.example.com/me/wiki.git",
      "direct-pr",
    );
    insert.run("r-local", "/fleet/notes", "notes", 3, "init", null, "local-only");
    atThirtyNine.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(
      upgraded.prepare("SELECT id, forge_kind, forge_host FROM repos ORDER BY added_at").all(),
    ).toEqual([
      { id: "r-gh", forge_kind: "github", forge_host: "github.com" },
      { id: "r-host", forge_kind: "git", forge_host: "git.example.com" },
      { id: "r-local", forge_kind: "none", forge_host: null },
    ]);
    // Every backfilled value is logged beside the origin it came from.
    expect(
      upgraded
        .prepare("SELECT repo_id, origin, forge_kind FROM forge_backfill ORDER BY repo_id")
        .all(),
    ).toEqual([
      { repo_id: "r-gh", origin: "git@github.com:o/meter.git", forge_kind: "github" },
      { repo_id: "r-host", origin: "https://git.example.com/me/wiki.git", forge_kind: "git" },
      { repo_id: "r-local", origin: null, forge_kind: "none" },
    ]);
    // The registry reads it as the view's `host`: null for a project kept on this Mac.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-gh")?.host).toEqual({ kind: "github", name: "github.com" });
    expect(registry.get("r-host")?.host).toEqual({ kind: "git", name: "git.example.com" });
    expect(registry.get("r-local")?.host).toBeNull();

    // Reversible: dropping the two columns and the log restores the v39 shape.
    upgraded.exec(
      `${REVERSE_MIGRATION_64}ALTER TABLE repos DROP COLUMN forge_kind; ALTER TABLE repos DROP COLUMN forge_host; DROP TABLE forge_backfill;`,
    );
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt39);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 3 });
    upgraded.close();
  });

  it("reads a row written without the columns from its origin, the way the stamp would", () => {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES ('r1', '/r', 'r', 1, 'clone', 'https://github.com/o/r.git', 'direct-pr', 0)",
    ).run();
    expect(new RepoRegistry(db, "/fleet").get("r1")?.host).toEqual({
      kind: "github",
      name: "github.com",
    });
  });
});

describe("migration 41 (the pictures a card shows, card pictures phase 2)", () => {
  it("adds the nullable column, keeps every card with no pictures, records new ones, and reverses", () => {
    const dir = tmpUserData();
    const atForty = openDatabase(dir, 40);
    const cardColumnsAt40 = columnNames(atForty, "cards");
    expect(cardColumnsAt40).not.toContain("pictures_json");
    atForty
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'm', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    atForty.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card from before the column shows no pictures.
    expect(store.get("card-old")).not.toHaveProperty("pictures");
    const pictures = [
      {
        id: "t1-0123456789abcdef0123456789abcdef",
        alt: "Before",
        width: 1200,
        height: 760,
        group: 0,
      },
      {
        id: "t1-fedcba9876543210fedcba9876543210",
        alt: "After",
        width: 900,
        height: 2660,
        group: 0,
      },
    ];
    store.upsert({ ...(store.get("card-old") as Card), id: "card-new", pictures });
    expect(new CardStore(upgraded).get("card-new")?.pictures).toEqual(pictures);

    // Reversible: dropping the column (and 52's, 54's and 55's after it)
    // restores the v40 shape with every row.
    upgraded.exec("ALTER TABLE cards DROP COLUMN pictures_json;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN awaiting;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN answers_json;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN width;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN model;");
    upgraded.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(upgraded, "cards")).toEqual(cardColumnsAt40);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    upgraded.close();
  });
});

describe("migration 51 (a pushed reading's status, W1 S3)", () => {
  it("adds the nullable status, keeps every earlier reading as unknown, records new ones, and reverses", () => {
    const dir = tmpUserData();
    const at50 = openDatabase(dir, 50);
    const columnsAt50 = columnNames(at50, "pushed_quota");
    expect(columnsAt50).not.toContain("status");
    at50
      .prepare(
        "INSERT INTO pushed_quota (account_id, window_id, utilization, resets_at, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("acct_a", "five_hour", 0.4, 2_000, 1_000);
    at50.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new PushedQuotaStore(upgraded);
    // A reading from before the column has no status: unknown, never `allowed`.
    expect(store.windowsFor("acct_a")).toEqual([
      { windowId: "five_hour", utilization: 0.4, resetsAt: 2_000, at: 1_000 },
    ]);
    store.record("acct_a", {
      windowId: "five_hour",
      status: "rejected",
      utilization: 1,
      resetsAt: 9_000,
      at: 3_000,
    });
    upgraded.close();

    // An app restart reads the status back from disk.
    const reopened = openDatabase(dir);
    expect(new PushedQuotaStore(reopened).windowsFor("acct_a")).toEqual([
      { windowId: "five_hour", status: "rejected", utilization: 1, resetsAt: 9_000, at: 3_000 },
    ]);

    // Reversible: dropping the column restores the v50 shape with every row.
    reopened.exec("ALTER TABLE pushed_quota DROP COLUMN status;");
    expect(columnNames(reopened, "pushed_quota")).toEqual(columnsAt50);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM pushed_quota").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

describe("migration 52 (what a card off the stage awaits, the card return rule)", () => {
  it("adds the nullable column, keeps every card on the stage, reads a hold back after a restart, and reverses", () => {
    const dir = tmpUserData();
    const at51 = openDatabase(dir, 51);
    const columnsAt51 = columnNames(at51, "cards");
    expect(columnsAt51).not.toContain("awaiting");
    at51
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'm', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at51.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card from before the column is on the stage: it awaits nothing.
    expect(store.get("card-old")).not.toHaveProperty("awaiting");
    store.upsert({ ...(store.get("card-old") as Card), id: "card-held", awaiting: "answer" });
    upgraded.close();

    // An app restart reads the hold back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-held")?.awaiting).toBe("answer");

    // Reversible: dropping the column (and 54's and 55's after it) restores
    // the v51 shape with every row.
    reopened.exec("ALTER TABLE cards DROP COLUMN awaiting;");
    reopened.exec("ALTER TABLE cards DROP COLUMN answers_json;");
    reopened.exec("ALTER TABLE cards DROP COLUMN width;");
    reopened.exec("ALTER TABLE cards DROP COLUMN model;");
    reopened.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(reopened, "cards")).toEqual(columnsAt51);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 54 (the answers a card's own questions got, inline decisions)", () => {
  it("adds the nullable column, keeps every resolved card without answers, records new ones, and reverses", () => {
    const dir = tmpUserData();
    const at53 = openDatabase(dir, 53);
    const columnsAt53 = columnNames(at53, "cards");
    expect(columnsAt53).not.toContain("answers_json");
    at53
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'm', '<p>Old.</p>', '[{"id":"go","label":"Go"}]', 'ready', 1, 2, 'go')`,
      )
      .run();
    at53.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card resolved before the column carried no answers.
    expect(store.resolvedSince(0, 5)).toEqual([expect.objectContaining({ action: "go" })]);
    expect(store.resolvedSince(0, 5)[0]).not.toHaveProperty("answers");
    const answers = [{ name: "speed", values: ["fast"], labels: ["Fast"], changed: true }];
    store.upsert({ ...(store.get("card-old") as Card), id: "card-new", createdAt: 3 });
    store.resolve("card-new", "go", answers);
    expect(
      store.resolvedSince(0, 5).find((entry) => entry.card.id === "card-new")?.answers,
    ).toEqual(answers);

    // Reversible: dropping the column (and 55's after it) restores the v53
    // shape with every row.
    upgraded.exec("ALTER TABLE cards DROP COLUMN answers_json;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN width;");
    upgraded.exec("ALTER TABLE cards DROP COLUMN model;");
    upgraded.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(upgraded, "cards")).toEqual(columnsAt53);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    upgraded.close();
  });
});

describe("migration 55 (how wide a card is, the captain's Q5 to Q7 A)", () => {
  it("adds the nullable column, keeps every earlier card regular, reads a width back after a restart, and reverses", () => {
    const dir = tmpUserData();
    const at54 = openDatabase(dir, 54);
    const columnsAt54 = columnNames(at54, "cards");
    expect(columnsAt54).not.toContain("width");
    at54
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'm', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at54.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card from before the column is a regular card.
    expect(store.get("card-old")).not.toHaveProperty("width");
    store.upsert({ ...(store.get("card-old") as Card), id: "card-wide", width: "wide" });
    upgraded.close();

    // An app restart reads the width back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-wide")?.width).toBe("wide");

    // Reversible: dropping the column (and 56's after it) restores the v54
    // shape with every row.
    reopened.exec("ALTER TABLE cards DROP COLUMN width;");
    reopened.exec("ALTER TABLE cards DROP COLUMN model;");
    reopened.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(reopened, "cards")).toEqual(columnsAt54);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 56 (the model a card's author ran on, the model chip)", () => {
  it("adds the nullable column, keeps an older card's meta whole, records the model, and reverses", () => {
    const dir = tmpUserData();
    const at55 = openDatabase(dir, 55);
    const columnsAt55 = columnNames(at55, "cards");
    expect(columnsAt55).not.toContain("model");
    at55
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'Build it · GPT-6 Sol', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at55.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card written before the column keeps its meta as it was, and names no model.
    const old = store.get("card-old") as Card;
    expect(old.meta).toBe("Build it · GPT-6 Sol");
    expect(old).not.toHaveProperty("model");
    store.upsert({ ...old, id: "card-new", meta: "Build it", model: "GPT-6 Sol", createdAt: 3 });
    upgraded.close();

    // An app restart reads the model back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-new")).toMatchObject({
      meta: "Build it",
      model: "GPT-6 Sol",
    });

    // Reversible: dropping the column restores the v55 shape with every row.
    reopened.exec("ALTER TABLE cards DROP COLUMN model;");
    reopened.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    expect(columnNames(reopened, "cards")).toEqual(columnsAt55);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 63 (where a task's crewmate runs, multi-machine piece 8)", () => {
  it("adds the nullable column, keeps every task on this Mac, records a computer, and reverses", () => {
    const dir = tmpUserData();
    const at62 = openDatabase(dir, 62);
    const columnsAt62 = columnNames(at62, "tasks");
    expect(columnsAt62).not.toContain("device_id");
    const before = new TaskService({ db: at62, now: () => 1 });
    seedTask(before, { id: "here", title: "Runs here", status: "running", worktreeDir: "/w/here" });
    at62.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const tasks = new TaskService({ db: upgraded, now: () => 2 });
    // A row written before the column runs on this Mac, and a restart still
    // interrupts its turn; a placed row's turn is that computer's to say.
    expect(tasks.get("here")).toMatchObject({ deviceId: null, activity: "interrupted" });
    seedTask(tasks, {
      id: "there",
      title: "Runs there",
      status: "running",
      deviceId: "mini",
      sessionFile: "/Users/builder/work/tasks/there/sessions/s.jsonl",
    });
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(new TaskService({ db: reopened, now: () => 3 }).get("there")).toMatchObject({
      deviceId: "mini",
      activity: "running",
    });

    // Reversible: dropping the column restores the v62 shape with every row.
    dropViews(reopened);
    reopened.exec(`${REVERSE_RUNNING_WORK} ${REVERSE_MIGRATION_76} ${REVERSE_MIGRATION_63}`);
    expect(columnNames(reopened, "tasks")).toEqual(columnsAt62);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 64 (where a project's tasks run, multi-machine piece 11)", () => {
  it("adds the nullable column, migrates eligible projects to Automatic, records a computer, and reverses", () => {
    const dir = tmpUserData();
    const at63 = openDatabase(dir, 63);
    const columnsAt63 = columnNames(at63, "repos");
    expect(columnsAt63).not.toContain("runs_on");
    at63
      .prepare(
        "INSERT INTO repos (id, path, name, setup_kind, origin, delivery, autonomy, added_at) VALUES ('r1', '/w/website', 'website', 'clone', 'https://github.com/o/website.git', 'direct-pr', 0, 1)",
      )
      .run();
    at63.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Migration 84 moves an eligible project's original home default to Automatic.
    expect(upgraded.prepare("SELECT runs_on FROM repos WHERE id = 'r1'").get()).toEqual({
      runs_on: AUTOMATIC_COMPUTER,
    });
    upgraded.prepare("UPDATE repos SET runs_on = 'mini' WHERE id = 'r1'").run();
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(reopened.prepare("SELECT runs_on FROM repos WHERE id = 'r1'").get()).toEqual({
      runs_on: "mini",
    });
    // Reversible: dropping the column restores the v63 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_64);
    expect(columnNames(reopened, "repos")).toEqual(columnsAt63);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

describe("migration 65 (a card's live attachment, the task browser from a card)", () => {
  it("adds the nullable column, keeps every earlier card without one, reads one back, and reverses", () => {
    const dir = tmpUserData();
    const at64 = openDatabase(dir, 64);
    const columnsAt64 = columnNames(at64, "cards");
    expect(columnsAt64).not.toContain("attachment_json");
    at64
      .prepare(
        "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-old', 'card', 'crewmate', 30, 'A card', 'crewmate 1', 'Body.', '[]', 'ready', 1)",
      )
      .run();
    at64.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // A card written before the column points at nothing.
    expect(new CardStore(upgraded).get("card-old")?.attachment).toBeUndefined();
    const attachment = {
      kind: "browser",
      label: "Try it",
      taskId: "t1",
      session: "run-1",
      generation: 1,
    };
    upgraded
      .prepare("UPDATE cards SET attachment_json = ? WHERE id = 'card-old'")
      .run(JSON.stringify(attachment));
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-old")?.attachment).toEqual(attachment);
    // Reversible: dropping the column restores the v64 shape with every row.
    dropViews(reopened);
    reopened.exec(
      REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_65,
    );
    expect(columnNames(reopened, "cards")).toEqual(columnsAt64);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 1 });
    reopened.close();
  });
});

describe("migration 66 (an honest usage ledger, the Usage tab)", () => {
  it("adds the nullable columns, keeps every earlier row unqualified, records a served row, and reverses", () => {
    const dir = tmpUserData();
    const at65 = openDatabase(dir, 65);
    const columnsAt65 = columnNames(at65, "usage_events");
    expect(columnsAt65).not.toContain("model_source");
    at65
      .prepare(
        "INSERT INTO usage_events (task_id, provider, model, input, output, cost, at) VALUES ('t1', 'anthropic-claude', 'opus', 100, 20, 0.5, 1)",
      )
      .run();
    at65.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // A row written before the columns keeps the model recorded then, with no source.
    expect(
      upgraded.prepare("SELECT model, model_source, cost, cost_source FROM usage_events").get(),
    ).toEqual({ model: "opus", model_source: null, cost: 0.5, cost_source: null });
    new UsageStore(upgraded).record({
      taskId: "t1",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: {
        input: 10,
        cost: 0.1,
        costSource: "claude",
        models: [{ model: "claude-opus-4-1", input: 10, cost: 0.1, costSource: "claude" }],
      },
      at: 2,
    });
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(
      reopened
        .prepare("SELECT model, model_source, cost_source FROM usage_events WHERE at = 2")
        .get(),
    ).toEqual({ model: "claude-opus-4-1", model_source: "served", cost_source: "claude" });
    // Reversible: dropping the columns restores the v65 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_66);
    expect(columnNames(reopened, "usage_events")).toEqual(columnsAt65);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 67 (where a crewmate card's task runs, FI3-1019)", () => {
  it("adds the nullable column, keeps an older card's meta whole, records the place, and reverses", () => {
    const dir = tmpUserData();
    const at66 = openDatabase(dir, 66);
    const columnsAt66 = columnNames(at66, "cards");
    expect(columnsAt66).not.toContain("place");
    at66
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, model, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'footer · on Mac mini', 'GPT-6 Sol', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at66.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card written before the column keeps its meta as it was, and names no place.
    const old = store.get("card-old") as Card;
    expect(old.meta).toBe("footer · on Mac mini");
    expect(old).not.toHaveProperty("place");
    store.upsert({ ...old, id: "card-new", meta: "footer", place: "on Mac mini", createdAt: 3 });
    upgraded.close();

    // An app restart reads the place back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-new")).toMatchObject({
      meta: "footer",
      model: "GPT-6 Sol",
      place: "on Mac mini",
    });
    // Reversible: dropping the column restores the v66 shape with every row.
    dropViews(reopened);
    reopened.exec(
      REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70 + REVERSE_MIGRATION_69 + REVERSE_MIGRATION_67,
    );
    expect(columnNames(reopened, "cards")).toEqual(columnsAt66);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 68 (the reply line beside each captain message, FI3-1089)", () => {
  it("adds the nullable column, keeps an older message with no reply, keeps a reply, and reverses", () => {
    const dir = tmpUserData();
    const at67 = openDatabase(dir, 67);
    const columnsAt67 = columnNames(at67, "captain_asks");
    expect(columnsAt67).not.toContain("reply");
    at67
      .prepare(
        "INSERT INTO captain_asks (id, at, text, turn_state) VALUES ('old1', 1, 'before the line', 'closed')",
      )
      .run();
    at67.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const tasks = new TaskService({ db: upgraded, strict: true, now: () => 2 });
    // A message written before the column has no reply line.
    expect(tasks.lastTurn()).toEqual({ you: "before the line", reply: null });
    tasks.openAsk({ id: "new1", text: "how is the alpha?" });
    tasks.setAskReply("new1", { text: "The alpha is cut" });
    upgraded.close();

    // An app restart reads the last turn back from disk.
    const reopened = openDatabase(dir);
    expect(new TaskService({ db: reopened, strict: true }).lastTurn()).toEqual({
      you: "how is the alpha?",
      reply: { text: "The alpha is cut" },
    });
    // Reversible: dropping the column restores the v67 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_68);
    expect(columnNames(reopened, "captain_asks")).toEqual(columnsAt67);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM captain_asks").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 69 (a merge card's risk, FI3-1128)", () => {
  it("adds the nullable column, keeps an older card with no risk, keeps a risk, and reverses", () => {
    const dir = tmpUserData();
    const at68 = openDatabase(dir, 68);
    const columnsAt68 = columnNames(at68, "cards");
    expect(columnsAt68).not.toContain("risk_json");
    at68
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', 't1', 'card', 'crewmate', 30, 'Before', 'footer', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at68.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card written before the column carries no risk.
    const old = store.get("card-old") as Card;
    expect(old).not.toHaveProperty("risk");
    const rating = { level: "low", why: "One file in the footer" } as const;
    const risk: RiskAssessment = {
      declared: {
        blast: rating,
        behavior: { level: "medium", why: "A switch, off until turned on" },
        undo: rating,
        evidence: rating,
        sensitivity: rating,
        novelty: rating,
        deps: rating,
      },
    };
    store.upsert({ ...old, id: "card-new", risk, createdAt: 3 });
    upgraded.close();

    // An app restart reads the risk back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-new")?.risk).toEqual(risk);
    // Reversible: dropping the column restores the v68 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70 + REVERSE_MIGRATION_69);
    expect(columnNames(reopened, "cards")).toEqual(columnsAt68);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 70 (a card that takes no reply, FI3-1164)", () => {
  it("adds the nullable column, keeps an older card taking replies, keeps the welcome's none, and reverses", () => {
    const dir = tmpUserData();
    const at69 = openDatabase(dir, 69);
    const columnsAt69 = columnNames(at69, "cards");
    expect(columnsAt69).not.toContain("replies");
    at69
      .prepare(
        `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
         VALUES ('card-old', NULL, 'card', 'firstmate', 15, 'Before', 'firstmate', '<p>Old.</p>', '[]', 'ready', 1)`,
      )
      .run();
    at69.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const store = new CardStore(upgraded);
    // A card written before the column takes replies as its author allows.
    const old = store.get("card-old") as Card;
    expect(old).not.toHaveProperty("replies");
    store.upsert({
      ...old,
      id: "card-welcome",
      title: "Welcome aboard",
      replies: false,
      createdAt: 3,
    });
    upgraded.close();

    // An app restart reads it back from disk.
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("card-welcome")?.replies).toBe(false);
    // Reversible: dropping the column restores the v69 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_71 + REVERSE_MIGRATION_70);
    expect(columnNames(reopened, "cards")).toEqual(columnsAt69);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 71 (whom an event concerns, FI3-1189's rule 1)", () => {
  it("adds the table to a database with tasks, keeps every row, and drops back to v70", () => {
    const dir = tmpUserData();
    const at70 = openDatabase(dir, 70);
    at70.exec(MIGRATION_71_TABLE);
    const before = new TaskService({ db: at70, strict: true });
    seedTask(before, { id: "kept", title: "Kept", status: "idle" });
    at70.exec(REVERSE_MIGRATION_71);
    const events = at70.prepare("SELECT COUNT(*) AS n FROM task_events").get();
    at70.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(tableNames(upgraded)).toContain("task_event_concerns");
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM task_events").get()).toEqual(events);
    const tasks = new TaskService({ db: upgraded, strict: true });
    tasks.create({ id: "part", title: "Part", prompt: "p", repoId: null, parentId: "kept" });
    expect(tasks.concerning("kept").map((event) => [event.taskId, event.relation])).toEqual([
      ["part", "part"],
    ]);
    upgraded.close();

    const reopened = openDatabase(dir);
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_71);
    expect(tableNames(reopened)).not.toContain("task_event_concerns");
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("release-tracking profile migration", () => {
  it("records a new profile as fresh, with no known baseline", () => {
    const dir = scratchDir("infinitary-new-tracking-");
    const db = openDatabase(dir);
    expect(new SettingsStore(db).getReleaseTracking()).toEqual({
      schema: 1,
      profile: "fresh",
      baseline: null,
      previous: null,
      deliveries: {},
      unresolved: [],
    });
    db.close();
  });

  it("records a profile that already had saved work as legacy and keeps its first-run record", () => {
    const dir = scratchDir("infinitary-legacy-tracking-");
    const legacy = openDatabase(dir, 60);
    new SettingsStore(legacy).setFirstRun({
      welcomedAt: 123,
      firstTurnAt: 456,
      welcomeState: "consumed",
    });
    legacy.close();
    const upgraded = openDatabase(dir);
    const settings = new SettingsStore(upgraded);
    expect(settings.getReleaseTracking()).toMatchObject({ profile: "legacy", baseline: null });
    expect(settings.getFirstRun()).toMatchObject({ welcomedAt: 123, welcomeState: "consumed" });
    upgraded.close();
  });

  it("never rewrites a recorded classification when reopened", () => {
    const dir = scratchDir("infinitary-reopen-tracking-");
    const db = openDatabase(dir);
    const settings = new SettingsStore(db);
    settings.setReleaseTracking({
      ...settings.getReleaseTracking(),
      baseline: { version: "0.1.28", source: null, recordedAt: 7 },
    });
    db.close();
    const reopened = openDatabase(dir);
    expect(new SettingsStore(reopened).getReleaseTracking()).toMatchObject({
      profile: "fresh",
      baseline: { version: "0.1.28" },
    });
    reopened.close();
  });
});

describe("immediate-welcome profile migration", () => {
  it("persists a new profile's uninitialized eligibility across reopen", () => {
    const dir = scratchDir("infinitary-new-welcome-");
    const db = openDatabase(dir);
    const settings = new SettingsStore(db);
    expect(settings.getFirstRun()).toEqual({
      welcomedAt: null,
      firstTurnAt: null,
      welcomeState: "uninitialized",
    });
    settings.setFirstRun({ welcomedAt: null, firstTurnAt: null, welcomeState: "pending" });
    db.close();
    const reopened = openDatabase(dir);
    expect(new SettingsStore(reopened).getFirstRun().welcomeState).toBe("pending");
    reopened.close();
  });

  it.each(["missing", "timestamps", "unreadable"] as const)(
    "skips a legacy profile with a %s record, preserving timestamps",
    (kind) => {
      const dir = scratchDir("infinitary-legacy-welcome-");
      const legacy = openDatabase(dir, 57);
      if (kind === "timestamps")
        new SettingsStore(legacy).setFirstRun({ welcomedAt: 123, firstTurnAt: 456 });
      if (kind === "unreadable")
        legacy.prepare("INSERT INTO settings (key, value) VALUES ('first-run', ?)").run("not json");
      legacy.close();
      const upgraded = openDatabase(dir);
      expect(new SettingsStore(upgraded).getFirstRun()).toEqual({
        welcomeState: "skipped",
        welcomedAt: kind === "timestamps" ? 123 : null,
        firstTurnAt: kind === "timestamps" ? 456 : null,
      });
      upgraded.close();
    },
  );
});

describe("migration 72 (revision thread associations)", () => {
  it("keeps older messages unavailable and persists new typed lists", () => {
    const dir = tmpUserData();
    const older = openDatabase(dir, 71);
    // Deliberately write the prior message contract before its column exists.
    older
      .prepare("INSERT INTO card_messages (card_id, who, text, at) VALUES (?, ?, ?, ?)")
      .run("kept", "host", "Earlier revision", 1);
    older.close();
    const upgraded = openDatabase(dir);
    const store = new CardStore(upgraded);
    expect(store.messages("kept")[0]?.revision).toBeUndefined();
    const revision = {
      lifecycleId: "life",
      offerId: "new",
      previousOfferId: "previous",
      released: false,
      targets: [{ id: 0, label: "Title", region: "title" as const }],
      removed: 0,
    };
    store.appendMessage({ cardId: "kept", who: "host", text: "New revision", revision });
    expect(store.releaseRevisions("kept", "life")).toBe(true);
    upgraded.close();
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).messages("kept")[1]?.revision).toEqual({
      ...revision,
      released: true,
    });
    reopened.exec("ALTER TABLE card_messages DROP COLUMN revision_json");
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM card_messages").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 74 (a turn a quit or crash cut)", () => {
  it("starts every row a quit left in flight at no cuts, its spent attempt kept, and reverses", () => {
    const dir = tmpUserData();
    const at73 = openDatabase(dir, 73);
    const inboxColumnsAt73 = columnNames(at73, "inbox");
    // A row an older build left in flight, its attempt already spent.
    const id = new InboxStore(at73).enqueue("t1", "Dispatch the release workflow");
    at73.prepare("UPDATE inbox SET delivered_at = 1, attempts = 1, last_attempt_at = 1").run();
    at73.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const inbox = new InboxStore(upgraded);
    expect(inbox.inFlight("t1")).toEqual([expect.objectContaining({ id, attempts: 1, cuts: 0 })]);
    // The boot reset of this build gives that attempt back and counts the cut.
    expect(inbox.resetInFlight()).toBe(1);
    expect(inbox.allFor("t1")).toEqual([expect.objectContaining({ id, attempts: 0, cuts: 1 })]);

    upgraded.exec(REVERSE_MIGRATION_74);
    expect(columnNames(upgraded, "inbox")).toEqual(inboxColumnsAt73);
    upgraded.close();
  });
});

describe("migration 77 (declared card continuity)", () => {
  it("keeps legacy cards unmarked, persists the mark and reverses without losing rows", () => {
    const dir = tmpUserData();
    const old = openDatabase(dir, 76);
    const columns = columnNames(old, "cards");
    old
      .prepare(
        "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('legacy', 'card', 'firstmate', 15, 'Before', 'firstmate', '<p>Old.</p>', '[]', 'ready', 1)",
      )
      .run();
    old.close();
    const upgraded = openDatabase(dir);
    const store = new CardStore(upgraded);
    const legacy = store.get("legacy") as Card;
    expect(legacy).not.toHaveProperty("holdsPlace");
    store.upsert({ ...legacy, id: "marked", holdsPlace: true });
    upgraded.close();
    const reopened = openDatabase(dir);
    expect(new CardStore(reopened).get("marked")?.holdsPlace).toBe(true);
    reopened.exec(REVERSE_MIGRATION_77);
    expect(columnNames(reopened, "cards")).toEqual(columns);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 85 (a recorded wait holds the start)", () => {
  it("marks every existing blocks edge as holding the close, and leaves other edges unmarked", () => {
    const dir = tmpUserData();
    const old = openDatabase(dir, 84);
    expect(columnNames(old, "task_links")).not.toContain("holds_merge");
    const insert = old.prepare(
      "INSERT INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, ?, 'firstmate', 1)",
    );
    insert.run("waiter", "ship", "blocks");
    insert.run("note", "ship", "related");
    old.close();
    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(
      upgraded.prepare("SELECT type, holds_merge FROM task_links ORDER BY type").all(),
    ).toEqual([
      { type: "blocks", holds_merge: 1 },
      { type: "related", holds_merge: 0 },
    ]);
    upgraded.close();
  });
});

// INF-416 L: removing published flags must preserve a saved placement's words.
it("migration 86 retains connecting in saved placement verdicts without the old flag", () => {
  const dir = tmpUserData();
  const old = openDatabase(dir, 85);
  const tasks = new TaskService({ db: old });
  seedTask(tasks, {
    id: "connecting-placement",
    title: "Fix the footer.",
    prompt: "Fix the footer.",
    status: "queued",
  });
  const candidate = {
    physicalComputerId: null,
    missingTools: [],
    reading: { status: "unknown", reason: "out-of-reach" },
    factsAgeMs: null,
    capacity: null,
    reserved: { cpu: 0, memoryBytes: 0 },
    remaining: null,
    model: null,
    preferenceRank: null,
  };
  const snapshot = placementSnapshotSchema.parse({
    version: 1,
    at: 1_000,
    computerId: "chosen",
    computerName: "This computer",
    physicalComputerId: "a".repeat(64),
    orderId: "prepare:footer",
    demand: PLACEMENT_DEMANDS.standard,
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    acceptedFallback: false,
    requirements: { tools: ["git"], systems: ["macos"], profile: "standard" },
    candidateCount: 2,
    candidates: [
      { ...candidate, computerId: "mini", name: "Mac mini", rejections: ["out-of-reach"] },
      { ...candidate, computerId: "chosen", name: "This computer", rejections: [] },
    ],
  });
  // The legacy snapshot has the same whole shape, with its earlier connecting flag.
  const placement = {
    reservation: "pending",
    snapshot: {
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], connecting: true }, snapshot.candidates[1]],
    },
  };

  old
    .prepare("UPDATE tasks SET placement_json = ? WHERE id = ?")
    .run(JSON.stringify(placement), "connecting-placement");
  old.close();
  const upgraded = openDatabase(dir);
  const read = () =>
    JSON.parse(
      (
        upgraded
          // Saved on the task's execution row since INF-1296 piece 3.
          .prepare("SELECT placement_json FROM task_execution WHERE task_id = ?")
          .get("connecting-placement") as { placement_json: string }
      ).placement_json,
    );
  expect(read()).toEqual({
    ...placement,
    snapshot: {
      ...placement.snapshot,
      candidates: [
        { ...snapshot.candidates[0], reach: "connecting" },
        placement.snapshot.candidates[1],
      ],
    },
  });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(
    new TaskService({ db: reopened }).get("connecting-placement")?.placement?.snapshot.candidates[0]
      ?.reach,
  ).toBe("connecting");
  reopened.close();
});

// INF-63: a review-finding label survives an upgrade and restart without relabeling old cards.
it("migration 87 preserves legacy cards and persists reversible review attribution", () => {
  const dir = tmpUserData();
  const old = openDatabase(dir, 86);
  const columns = columnNames(old, "cards");
  old
    .prepare(
      "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('legacy', 'card', 'firstmate', 15, 'Before', 'firstmate', '<p>Old.</p>', '[]', 'ready', 1)",
    )
    .run();
  old.close();
  const upgraded = openDatabase(dir);
  const store = new CardStore(upgraded);
  const legacy = store.get("legacy") as Card;
  expect(legacy.reviewTaskId).toBeUndefined();
  store.upsert({ ...legacy, id: "finding", reviewTaskId: "review-footer" });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(new CardStore(reopened).get("finding")?.reviewTaskId).toBe("review-footer");
  reopened.exec(`${REVERSE_MIGRATION_88}ALTER TABLE cards DROP COLUMN review_task_id`);
  expect(columnNames(reopened, "cards")).toEqual(columns);
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
  reopened.close();
});

it("INF-476 upgrades existing cards with no minimized state, persists a minimized card and reverses without losing it", () => {
  const dir = tmpUserData();
  const old = openDatabase(dir, 87);
  const columns = columnNames(old, "cards");
  old
    .prepare(
      "INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('launch-review', 'card', 'firstmate', 20, 'The launch review is ready', 'firstmate', '<p>Keep the review beside the launch.</p>', '[]', 'ready', 1)",
    )
    .run();
  old.close();
  const upgraded = openDatabase(dir);
  expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
  const store = new CardStore(upgraded);
  const review = store.get("launch-review");
  if (!review) throw new Error("The upgraded launch review is missing");
  expect(review).not.toHaveProperty("minimized");
  store.upsert({ ...review, minimized: true });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(new CardStore(reopened).get(review.id)).toMatchObject({
    minimized: true,
    status: "ready",
    title: review.title,
  });
  reopened.exec(REVERSE_MIGRATION_88);
  expect(columnNames(reopened, "cards")).toEqual(columns);
  expect(reopened.prepare("SELECT id, status FROM cards").all()).toEqual([
    { id: review.id, status: "ready" },
  ]);
  reopened.close();
});

// INF-1226: a consent card its crewmate declared `continues` can wait across
// a restart, and the captain's choice on it must still not close its task.
it("INF-1226 upgrades existing cards with no continues declaration, keeps a declared card's across reopen and reverses without losing it", () => {
  const dir = tmpUserData();
  const old = openDatabase(dir, 92);
  const columns = columnNames(old, "cards");
  old
    .prepare(
      "INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at) VALUES ('card-6f0d2a1c-allow-signing', '6f0d2a1c', 'card', 'crewmate', 30, 'Allow signing the Secrets test app on the Mac mini?', 'Sign the Secrets test app', '<p>Signing it needs your permission to use your Developer ID identity there.</p>', '[{\"id\":\"leave-blocked\",\"label\":\"Leave blocked\"},{\"id\":\"allow-mac-mini-signing\",\"label\":\"Allow signing on the Mac mini\",\"default\":true}]', 'ready', 1)",
    )
    .run();
  old.close();
  const upgraded = openDatabase(dir);
  expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
  const store = new CardStore(upgraded);
  const consent = store.get("card-6f0d2a1c-allow-signing");
  if (!consent) throw new Error("The upgraded consent card is missing");
  expect(consent).not.toHaveProperty("continues");
  store.upsert({ ...consent, continues: true });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(new CardStore(reopened).get(consent.id)).toMatchObject({
    continues: true,
    status: "ready",
    title: consent.title,
  });
  // A revision without the declaration removes it.
  new CardStore(reopened).upsert(consent);
  expect(new CardStore(reopened).get(consent.id)).not.toHaveProperty("continues");
  reopened.exec(REVERSE_MIGRATION_93);
  expect(columnNames(reopened, "cards")).toEqual(columns);
  expect(reopened.prepare("SELECT id, status FROM cards").all()).toEqual([
    { id: consent.id, status: "ready" },
  ]);
  reopened.close();
});
