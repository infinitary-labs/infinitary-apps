import { type HoldOverride, type OverridableHold, overridePasses } from "@shared/holds";
import type { CommittedPlacement } from "@shared/placement";
import type { WorkShape } from "@shared/routingPolicy";
import type { SpawnIntent } from "../orchestrator/intentBrief";
import type {
  PendingSettleIntent,
  TaskActivity,
  TaskClosedReason,
  TaskCoverageFields,
  TaskDelivery,
  TaskGate,
  TaskKind,
  TaskRecord,
  TaskRetentionFields,
  TaskStartPolicy,
  TaskStatus,
  TaskWorkspaceState,
} from "./taskRecordTypes";

export type * from "./taskRecordTypes";

import { ChangeStore } from "./changeStore";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import {
  composeDelivery,
  deliverySaveMoves,
  type EvidenceRow,
  type PermissionRow,
  splitDelivery,
  TaskDeliveryStore,
} from "./taskDeliveryStore";
import {
  EXECUTION_COLUMNS,
  NO_EXECUTION,
  splitTurn,
  type TaskExecution,
  TaskExecutionStore,
  withTurn,
} from "./taskExecutionStore";
import { SHAPE_RECORD_TABLES, TaskOwnedShapeStore } from "./taskOwnedShapeStore";
import { splitPolicies, TaskPolicyStore, withPolicies } from "./taskPolicyStore";
import {
  REFERENCE_SHAPE_FIELDS,
  TASK_REFERENCE_KINDS,
  type TaskReference,
  TaskReferenceStore,
} from "./taskReferenceStore";
import { TaskSpecificationStore } from "./taskSpecificationStore";

/**
 * The task record's row layer (task-system design section 4.1). A task is
 * a record, not a runtime handle: rows are created when intent exists and
 * are never deleted by success - settling closes them (captain decision
 * D2; the D-13 purge is the one destructive control). This store is raw
 * SQL over the row shape; every write in the app goes through
 * `src/core/tasks/taskService.ts`, which owns project resolution, keys,
 * transitions and the timeline event each change commits with.
 */

type Row = {
  id: string;
  key: string | null;
  seq: number | null;
  project_id: string | null;
  parent_id: string | null;
  kind: TaskKind;
  title: string;
  goal: string | null;
  intent_json: string | null;
  prompt: string;
  repo_id: string | null;
  repo_dir: string;
  worktree_dir: string;
  branch: string;
  session_file: string | null;
  account_id: string | null;
  device_id?: string | null;
  placement_json?: string | null;
  difficulty: TaskRecord["difficulty"];
  shape_json: string | null;
  gate_kind: TaskGate["kind"] | null;
  gate_ref: string | null;
  gate_until: number | null;
  gate_reason: string | null;
  status: TaskStatus;
  activity: TaskActivity | null;
  closed_reason: TaskClosedReason | null;
  priority: number;
  start_policy: TaskStartPolicy;
  workspace_state: TaskWorkspaceState;
  outcome: string | null;
  outcome_summary: string | null;
  delivery_json: string | null;
  pending_settle_json: string | null;
  idle_since: number | null;
  recovery_rung: number | null;
  recovery_count: number | null;
  recovery_at: number | null;
  assignee: string | null;
  model: string | null;
  created_at: number;
  updated_at: number | null;
  started_at: number | null;
  closed_at: number | null;
  test_path?: string | null;
  captain_opened_at?: number | null;
  verdict?: string | null;
  start_notice?: string | null;
  pinned_at?: number | null;
};

/**
 * The shape as the record stores it. The basis verdict is derived at every
 * read (`TaskService.graph.basisHolds`) and never stored: a stamp goes stale the
 * moment the basis answers. The relationships a shape is read with live in
 * `task_references` (INF-1296 piece 2), so they never reach the column.
 */
function shapeJson(shape: WorkShape | null | undefined): string | null {
  if (!shape) return null;
  const {
    basis_verified: _derived,
    basis: _basis,
    branch_from: _branch,
    escalate_from: _retry,
    ...recorded
  } = shape;
  return JSON.stringify(recorded);
}

/** A shape as it is read: the stored fields, and each reference under its older field. */
function withReferences(
  shape: WorkShape | null,
  references: readonly TaskReference[] | undefined,
): WorkShape | null {
  if (!shape || !references?.length) return shape;
  const composed: WorkShape = { ...shape };
  for (const reference of references)
    composed[REFERENCE_SHAPE_FIELDS[reference.kind]] = reference.ref;
  return composed;
}

/** A task's change evidence and permission rows, as `TaskDeliveryStore` holds them. */
type DeliveryRecords = { evidence?: EvidenceRow; permissions?: PermissionRow };

/**
 * A record's delivery facts and its settle that has not run, as its
 * evidence and permission rows hold them beside the history its column
 * keeps (INF-1296 piece 4). An older field nothing reads stays out, as it
 * did when the column held it.
 */
function withDeliveryRecords(record: TaskRecord, rows: DeliveryRecords): TaskRecord {
  const delivery = composeDelivery(
    record.delivery as Record<string, unknown> | null,
    rows.evidence,
    rows.permissions,
  );
  return {
    ...record,
    delivery: withoutRetired(delivery as TaskDelivery | null, "landedAt"),
    pendingSettle: parseJson<PendingSettleIntent>(rows.permissions?.pending_settle_json ?? null),
  };
}

/**
 * A record as it is read (INF-1296 pieces 2 to 4): its row, its shape with
 * its references and policy inputs, its running work as `task_execution`
 * holds it, and its delivery facts with their evidence and permission
 * rows. `execution` and `delivery` are undefined on a database from before
 * those tables, whose row still holds those columns itself.
 */
function composed(
  record: TaskRecord,
  references: readonly TaskReference[] | undefined,
  policies: Parameters<typeof withPolicies>[1],
  execution: TaskExecution | undefined,
  delivery?: DeliveryRecords,
): TaskRecord {
  const shape = withPolicies(withReferences(record.shape, references), policies);
  if (delivery) record = withDeliveryRecords(record, delivery);
  if (!execution) return shape === record.shape ? record : { ...record, shape };
  return {
    ...record,
    shape,
    sessionFile: execution.sessionFile,
    accountId: execution.accountId,
    deviceId: execution.deviceId,
    placement: execution.placement,
    idleSince: execution.idleSince,
    recoveryRung: execution.recoveryRung,
    recoveryCount: execution.recoveryCount,
    recoveryAt: execution.recoveryAt,
    startNotice: execution.startNotice,
    backlogSince: execution.backlogSince,
    delivery: withTurn(record.delivery, execution.turn),
  };
}

/**
 * A field an older build saved that nothing reads any more (INF-1288 piece 3):
 * a read leaves it out, so no surface shows it and the row's next write
 * no longer carries it. No migration rewrites the rows, so an older build
 * still opens the profile.
 */
function withoutRetired<T extends object>(value: T | null, field: string): T | null {
  if (!value || !Object.hasOwn(value, field)) return value;
  const { [field]: _retired, ...kept } = value as Record<string, unknown>;
  return kept as T;
}

/**
 * What JavaScript's `String.prototype.trim` takes from either end, as the
 * second argument of SQLite's `trim`: a reference is trimmed this way
 * before it names a task, in code and in a statement alike.
 */
const TRIMMED_SQL = `'${[
  "\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff",
  ...Array.from({ length: 11 }, (_, n) => String.fromCharCode(0x2000 + n)),
].join("")}'`;

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fromRow(row: Row): TaskRecord {
  return {
    id: row.id,
    key: row.key ?? "",
    seq: row.seq ?? 0,
    projectId: row.project_id ?? "",
    parentId: row.parent_id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    intent: parseJson<SpawnIntent>(row.intent_json),
    prompt: row.prompt,
    repoId: row.repo_id,
    repoDir: row.repo_dir,
    worktreeDir: row.worktree_dir,
    branch: row.branch,
    sessionFile: row.session_file,
    accountId: row.account_id,
    deviceId: row.device_id ?? null,
    placement: parseJson<CommittedPlacement>(row.placement_json ?? null),
    difficulty: row.difficulty,
    shape: withoutRetired(parseJson<WorkShape>(row.shape_json), "knowledge_access"),
    gate: row.gate_kind
      ? {
          kind: row.gate_kind,
          ...(row.gate_ref ? { ref: row.gate_ref } : {}),
          ...(row.gate_until !== null ? { until: row.gate_until } : {}),
          ...(row.gate_reason ? { reason: row.gate_reason } : {}),
        }
      : null,
    status: row.status,
    activity: row.activity,
    closedReason: row.closed_reason,
    priority: row.priority,
    startPolicy: row.start_policy,
    workspaceState: row.workspace_state,
    outcome: row.outcome,
    outcomeSummary: row.outcome_summary,
    delivery: withoutRetired(parseJson<TaskDelivery>(row.delivery_json), "landedAt"),
    pendingSettle: parseJson<PendingSettleIntent>(row.pending_settle_json),
    idleSince: row.idle_since,
    recoveryRung: row.recovery_rung ?? 0,
    recoveryCount: row.recovery_count ?? 0,
    recoveryAt: row.recovery_at,
    assignee: row.assignee,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    testPath: row.test_path ?? null,
    captainOpenedAt: row.captain_opened_at ?? null,
    verdict: row.verdict ?? null,
    startNotice: row.start_notice ?? null,
    pinnedAt: row.pinned_at ?? null,
  };
}

/**
 * Oldest first: created, then key number (a missing one first). Sorted here,
 * never by an ORDER BY over these rows: SQLite's sorter copies every column
 * of every row, and once that copy outgrows its cache it writes it to a
 * temporary file, tens of megabytes per read of a long record, on the main
 * thread (INF-940).
 */
export function oldestFirst(records: TaskRecord[]): TaskRecord[] {
  return records.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
}

/** The columns a patch may touch, mapped from record field to column. */
const PATCH_COLUMNS = {
  key: "key",
  seq: "seq",
  projectId: "project_id",
  parentId: "parent_id",
  title: "title",
  goal: "goal",
  prompt: "prompt",
  repoId: "repo_id",
  repoDir: "repo_dir",
  worktreeDir: "worktree_dir",
  branch: "branch",
  sessionFile: "session_file",
  accountId: "account_id",
  deviceId: "device_id",
  status: "status",
  activity: "activity",
  closedReason: "closed_reason",
  priority: "priority",
  startPolicy: "start_policy",
  workspaceState: "workspace_state",
  outcome: "outcome",
  outcomeSummary: "outcome_summary",
  assignee: "assignee",
  model: "model",
  difficulty: "difficulty",
  idleSince: "idle_since",
  recoveryRung: "recovery_rung",
  recoveryCount: "recovery_count",
  recoveryAt: "recovery_at",
  updatedAt: "updated_at",
  startedAt: "started_at",
  closedAt: "closed_at",
  testPath: "test_path",
  captainOpenedAt: "captain_opened_at",
  verdict: "verdict",
  startNotice: "start_notice",
  pinnedAt: "pinned_at",
  backlogSince: "backlog_since",
} as const;

type PatchField = keyof typeof PATCH_COLUMNS;

export type TaskPatch = Partial<Pick<TaskRecord, PatchField>> & {
  placement?: CommittedPlacement | null;
  intent?: SpawnIntent | null;
  /** The work shape (S3): written as JSON, like the other structured columns. */
  shape?: WorkShape | null;
  gate?: TaskGate | null;
  delivery?: TaskDelivery | null;
  pendingSettle?: PendingSettleIntent | null;
};

/** The patch fields that can move the change a task carries (INF-1868 piece 1). */
const CHANGE_PATCH_FIELDS: readonly (keyof TaskPatch)[] = [
  "delivery",
  "status",
  "closedReason",
  "closedAt",
  "branch",
  "repoId",
  "shape",
];

export class TaskStore {
  private taskColumns: Set<string> | undefined;
  private projection:
    | {
        records: Map<string, TaskRecord | undefined>;
        lists: Map<string, TaskRecord[]>;
        coverage: Map<string, TaskCoverageFields | undefined>;
      }
    | undefined;

  /** A synchronous derived view composes each task once, including nested readers. */
  readProjection<T>(read: () => T, known: readonly TaskRecord[] = []): T {
    const outer = this.projection;
    this.projection ??= { records: new Map(), lists: new Map(), coverage: new Map() };
    try {
      // The board's row-cache owner already has these current records.
      // Prefer a row this projection read itself when one is present.
      for (const record of known)
        if (!this.projection.records.has(record.id)) this.projection.records.set(record.id, record);
      return read();
    } finally {
      if (!outer) this.projection = undefined;
    }
  }

  /** Writes see their own current rows, and invalidate any surrounding projection even on rollback. */
  writeOutsideProjection<T>(write: () => T): T {
    const projection = this.projection;
    this.projection = undefined;
    try {
      return write();
    } finally {
      projection?.records.clear();
      projection?.lists.clear();
      projection?.coverage.clear();
      this.projection = projection;
    }
  }
  /** Read here so a record's shape carries them; written only by TaskService. */
  readonly references: TaskReferenceStore;
  /** A task's running work (INF-1296 piece 3); a record reads it in its own fields. */
  readonly execution: TaskExecutionStore;
  /** A task's policy inputs (INF-1296 piece 3); a record's shape reads them. */
  readonly policies: TaskPolicyStore;
  /** A task's change evidence and permissions (INF-1296 piece 4); a record's delivery reads them. */
  readonly delivery: TaskDeliveryStore;
  /** The change a task carries (INF-1868 piece 1), projected from its record on every write that can move it. */
  readonly changes: ChangeStore;
  readonly specifications: TaskSpecificationStore;
  readonly shapes: TaskOwnedShapeStore;

  constructor(private readonly db: AppDatabase) {
    this.specifications = new TaskSpecificationStore(db);
    this.shapes = new TaskOwnedShapeStore(db);
    this.references = new TaskReferenceStore(db);
    this.execution = new TaskExecutionStore(db);
    this.policies = new TaskPolicyStore(db);
    this.delivery = new TaskDeliveryStore(db);
    this.changes = new ChangeStore(db);
  }

  /** Writes the change this task's record now describes, once its saved row says so. */
  private projectChange(id: string): void {
    if (!this.changes.exists()) return;
    const saved = this.get(id);
    if (saved) this.changes.project(saved);
  }

  /** Older migration fixtures still read the schema they were written against. */
  private readTable(): string {
    return this.specifications.exists() ? "task_records" : "tasks";
  }

  private record(row: Row): TaskRecord {
    const known = this.projection?.records.get(row.id);
    if (known) return known;
    const record = fromRow(row);
    const result = composed(
      record,
      record.shape ? this.references.list(record.id) : undefined,
      record.shape ? this.policies.get(record.id) : undefined,
      this.execution.exists() ? this.execution.get(record.id) : undefined,
      this.delivery.exists()
        ? {
            evidence: this.delivery.evidence(record.id),
            permissions: this.delivery.permissions(record.id),
          }
        : undefined,
    );
    this.projection?.records.set(row.id, result);
    return result;
  }

  private read(rows: Row[]): TaskRecord[] {
    const records = rows.filter((row) => !this.projection?.records.has(row.id)).map(fromRow);
    const shaped = records.filter((record) => record.shape).map((record) => record.id);
    const references = this.references.listFor(shaped);
    const policies = this.policies.listFor(shaped);
    const executing = this.execution.exists();
    const execution = this.execution.listFor(executing ? records.map((record) => record.id) : []);
    const delivering = this.delivery.exists();
    const delivery = this.delivery.listFor(delivering ? records.map((record) => record.id) : []);
    const composedRecords = records.map((record) =>
      composed(
        record,
        references.get(record.id),
        policies.get(record.id),
        executing ? (execution.get(record.id) ?? NO_EXECUTION) : undefined,
        delivering
          ? {
              evidence: delivery.evidence.get(record.id),
              permissions: delivery.permissions.get(record.id),
            }
          : undefined,
      ),
    );
    if (!this.projection) return composedRecords;
    for (const record of composedRecords) this.projection.records.set(record.id, record);
    return rows.flatMap((row) => {
      const record = this.projection?.records.get(row.id);
      return record ? [record] : [];
    });
  }

  /**
   * A shape write never changes a relationship (INF-1296 piece 2): those go
   * through TaskService's checked relationship operations. A shape that names
   * one other than the record's is a writer's mistake, refused before it
   * writes; one that leaves it out leaves the relationship standing.
   */
  private assertReferencesKept(id: string, shape: WorkShape | null | undefined): void {
    if (!shape) return;
    const stored = new Map(
      this.references.list(id).map((reference) => [reference.kind, reference.ref]),
    );
    for (const kind of TASK_REFERENCE_KINDS) {
      const named = shape[REFERENCE_SHAPE_FIELDS[kind]];
      if (typeof named !== "string" || !named.trim() || named === stored.get(kind)) continue;
      throw new Error(
        `${REFERENCE_SHAPE_FIELDS[kind]} is the task's ${kind} relationship; set it through TaskService, not the shape.`,
      );
    }
  }

  /** Column names as this database has them. Migration tests seed on an older schema. */
  private columns(): Set<string> {
    this.taskColumns ??= new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    return this.taskColumns;
  }

  /**
   * Tasks left mid-turn by a previous process are interrupted, not silently
   * resurrected. Open rows are untouched: waiting survives a restart. A turn
   * on a computer that runs work went on without this process, so its row
   * is left as it was until that computer says where the turn is.
   */
  interruptLeftRunning(now: number): void {
    const here = this.execution.exists()
      ? " AND id NOT IN (SELECT task_id FROM task_execution WHERE device_id IS NOT NULL)"
      : this.columns().has("device_id")
        ? " AND device_id IS NULL"
        : "";
    this.db
      .prepare(
        `UPDATE tasks SET activity = 'interrupted', updated_at = ? WHERE status = 'active' AND activity IN ('running', 'starting')${here}`,
      )
      .run(now);
  }

  insert(record: TaskRecord): void {
    this.db.transaction(() => this.insertRows(record))();
  }

  private insertRows(record: TaskRecord): void {
    this.assertReferencesKept(record.id, record.shape);
    const filing = this.columns().has("test_path");
    // The running work and the policy inputs have rows of their own once
    // their tables exist (INF-1296 piece 3); before, the row holds them.
    const executing = this.execution.exists();
    const { shape, row: policies } = this.policies.exists()
      ? splitPolicies(record.shape)
      : { shape: record.shape, row: null };
    const { delivery, turn } = executing
      ? splitTurn(record.delivery)
      : { delivery: record.delivery, turn: null };
    const kept = executing ? NO_EXECUTION : record;
    // The change evidence and permissions have rows of their own once their
    // tables exist (INF-1296 piece 4); the column keeps the history.
    const delivering = this.delivery.exists();
    const history = delivering && delivery ? splitDelivery(delivery).history : delivery;
    if (this.specifications.exists()) {
      const values = {
        id: record.id,
        key: record.key,
        seq: record.seq,
        project_id: record.projectId,
        parent_id: record.parentId,
        kind: record.kind,
        title: record.title,
        repo_id: record.repoId,
        repo_dir: record.repoDir,
        worktree_dir: record.worktreeDir,
        branch: record.branch,
        difficulty: record.difficulty,
        gate_kind: record.gate?.kind ?? null,
        gate_ref: record.gate?.ref ?? null,
        gate_until: record.gate?.until ?? null,
        gate_reason: record.gate?.reason ?? null,
        status: record.status,
        activity: record.activity,
        closed_reason: record.closedReason,
        priority: record.priority,
        start_policy: record.startPolicy,
        workspace_state: record.workspaceState,
        outcome: record.outcome,
        outcome_summary: record.outcomeSummary,
        assignee: record.assignee,
        model: record.model,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        started_at: record.startedAt,
        closed_at: record.closedAt,
        test_path: record.testPath ?? null,
        captain_opened_at: record.captainOpenedAt ?? null,
        verdict: record.verdict ?? null,
        // The pin rides an imported task's line (INF-3127); a record from
        // before its column keeps the row unpinned.
        ...(this.columns().has("pinned_at") ? { pinned_at: record.pinnedAt ?? null } : {}),
      };
      const fields = Object.keys(values);
      this.db
        .prepare(
          `INSERT INTO tasks (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
        )
        .run(...Object.values(values));
      this.specifications.revise(record.id, {
        goal: record.goal,
        prompt: record.prompt,
        intent: record.intent,
      });
      this.shapes.replace(record.id, shape ? JSON.parse(shapeJson(shape)!) : null);
      this.db
        .prepare("INSERT INTO task_record_history (task_id, delivery_json) VALUES (?, ?)")
        .run(record.id, history ? JSON.stringify(history) : null);
    } else {
      this.db
        .prepare(
          `INSERT INTO tasks (
           id, key, seq, project_id, parent_id, kind, title, goal, intent_json, prompt,
           repo_id, repo_dir, worktree_dir, branch, session_file, account_id, difficulty, shape_json,
           gate_kind, gate_ref, gate_until, gate_reason, status, activity, closed_reason,
           priority, start_policy, workspace_state, outcome, outcome_summary, delivery_json,
           pending_settle_json, assignee, model, created_at, updated_at, started_at, closed_at,
           idle_since, recovery_rung, recovery_count, recovery_at${filing ? ",\n           test_path, captain_opened_at, verdict" : ""}
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?${filing ? ",\n           ?, ?, ?" : ""}
         )`,
        )
        .run(
          record.id,
          record.key,
          record.seq,
          record.projectId,
          record.parentId,
          record.kind,
          record.title,
          record.goal,
          record.intent ? JSON.stringify(record.intent) : null,
          record.prompt,
          record.repoId,
          record.repoDir,
          record.worktreeDir,
          record.branch,
          kept.sessionFile,
          kept.accountId,
          record.difficulty,
          shapeJson(shape),
          record.gate?.kind ?? null,
          record.gate?.ref ?? null,
          record.gate?.until ?? null,
          record.gate?.reason ?? null,
          record.status,
          record.activity,
          record.closedReason,
          record.priority,
          record.startPolicy,
          record.workspaceState,
          record.outcome,
          record.outcomeSummary,
          history ? JSON.stringify(history) : null,
          !delivering && record.pendingSettle ? JSON.stringify(record.pendingSettle) : null,
          record.assignee,
          record.model,
          record.createdAt,
          record.updatedAt,
          record.startedAt,
          record.closedAt,
          kept.idleSince ?? null,
          kept.recoveryRung ?? 0,
          kept.recoveryCount ?? 0,
          kept.recoveryAt ?? null,
          ...(filing
            ? [record.testPath ?? null, record.captainOpenedAt ?? null, record.verdict ?? null]
            : []),
        );
    }
    if (policies) this.policies.set(record.id, policies);
    if (delivering) {
      this.delivery.setDelivery(record.id, delivery);
      if (record.pendingSettle) this.delivery.setPendingSettle(record.id, record.pendingSettle);
    }
    if (executing) {
      const running: Partial<TaskExecution> = {
        ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
        ...(record.accountId ? { accountId: record.accountId } : {}),
        ...(record.idleSince != null ? { idleSince: record.idleSince } : {}),
        ...(record.recoveryRung ? { recoveryRung: record.recoveryRung } : {}),
        ...(record.recoveryCount ? { recoveryCount: record.recoveryCount } : {}),
        ...(record.recoveryAt != null ? { recoveryAt: record.recoveryAt } : {}),
        ...(record.placement
          ? { placement: record.placement, deviceId: record.placement.snapshot.computerId }
          : {}),
        ...(turn ? { turn } : {}),
      };
      this.execution.update(record.id, running);
    } else if (record.placement && this.columns().has("placement_json"))
      this.update(record.id, {
        placement: record.placement,
        deviceId: record.placement.snapshot.computerId,
      });
    this.projectChange(record.id);
  }

  /** An open or active row that already names this test, oldest first. */
  openByTestPath(testPath: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.readTable()} WHERE test_path = ? AND status IN ('open', 'active') ORDER BY created_at, seq LIMIT 1`,
      )
      .get(testPath) as Row | undefined;
    return row ? this.record(row) : undefined;
  }

  /** Apply a patch; only the named fields change, the task's own records with its row. */
  update(id: string, patch: TaskPatch): void {
    this.db.transaction(() => this.updateRows(id, patch))();
  }

  private updateRows(id: string, patch: TaskPatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    // The running work goes to its own row once the table exists (INF-1296 piece 3).
    const executing = this.execution.exists();
    const running: Partial<TaskExecution> = {};
    for (const [field, column] of Object.entries(PATCH_COLUMNS) as [PatchField, string][]) {
      if (!(field in patch)) continue;
      if (this.specifications.exists() && (field === "goal" || field === "prompt")) continue;
      if (executing && field in EXECUTION_COLUMNS) {
        (running as Record<string, unknown>)[field] = patch[field] ?? null;
        continue;
      }
      sets.push(`${column} = ?`);
      values.push(patch[field] ?? null);
    }
    if (
      this.specifications.exists() &&
      ("goal" in patch || "prompt" in patch || "intent" in patch)
    ) {
      this.specifications.revise(id, {
        ...("goal" in patch ? { goal: patch.goal ?? null } : {}),
        ...("prompt" in patch ? { prompt: patch.prompt ?? "" } : {}),
        ...("intent" in patch ? { intent: patch.intent ?? null } : {}),
      });
    }
    if ("intent" in patch && !this.specifications.exists()) {
      sets.push("intent_json = ?");
      values.push(patch.intent ? JSON.stringify(patch.intent) : null);
    }
    if ("shape" in patch) {
      this.assertReferencesKept(id, patch.shape);
      // A shape names the policy inputs it is read with, so its write replaces them.
      const split = this.policies.exists()
        ? splitPolicies(patch.shape)
        : { shape: patch.shape ?? null, row: undefined };
      if (split.row !== undefined) this.policies.set(id, split.row);
      if (this.shapes.exists())
        this.shapes.replace(id, split.shape ? JSON.parse(shapeJson(split.shape)!) : null);
      else {
        sets.push("shape_json = ?");
        values.push(shapeJson(split.shape));
      }
    }
    if ("gate" in patch) {
      const gate = patch.gate ?? null;
      sets.push("gate_kind = ?", "gate_ref = ?", "gate_until = ?", "gate_reason = ?");
      values.push(gate?.kind ?? null, gate?.ref ?? null, gate?.until ?? null, gate?.reason ?? null);
    }
    if ("delivery" in patch) {
      // A delivery names the current turn's declarations it is read with, so its write replaces them.
      // Each record is written again only when its saved value moves (INF-2220).
      const split = executing
        ? splitTurn(patch.delivery)
        : { delivery: patch.delivery ?? null, turn: undefined };
      if (split.turn !== undefined && this.turnMoves(id, split.turn)) running.turn = split.turn;
      // Its change evidence and permissions go to their own rows (INF-1296 piece 4).
      const history = this.delivery.exists()
        ? this.delivery.setDelivery(id, split.delivery)
        : split.delivery;
      const historyJson = history ? JSON.stringify(history) : null;
      if (this.specifications.exists()) {
        if (this.savedHistory(id) !== historyJson)
          prepared(
            this.db,
            `INSERT INTO task_record_history (task_id, delivery_json) VALUES (?, ?)
             ON CONFLICT(task_id) DO UPDATE SET delivery_json = excluded.delivery_json`,
          ).run(id, historyJson);
      } else {
        sets.push("delivery_json = ?");
        values.push(historyJson);
      }
    }
    if ("placement" in patch) {
      if (executing) running.placement = patch.placement ?? null;
      else {
        sets.push("placement_json = ?");
        values.push(patch.placement ? JSON.stringify(patch.placement) : null);
      }
    }
    if ("pendingSettle" in patch && this.delivery.exists()) {
      this.delivery.setPendingSettle(id, patch.pendingSettle ?? null);
    } else if ("pendingSettle" in patch) {
      sets.push("pending_settle_json = ?");
      values.push(patch.pendingSettle ? JSON.stringify(patch.pendingSettle) : null);
    }
    if (Object.keys(running).length > 0) this.execution.update(id, running);
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    // The change a task carries follows the facts that can move it (INF-1868 piece 1).
    if (CHANGE_PATCH_FIELDS.some((field) => field in patch)) this.projectChange(id);
  }

  /**
   * Whether saving this delivery would change any row it is saved in
   * (INF-2220): the turn's declarations, the history its column keeps, its
   * change evidence or its permissions. A write that moves none of them is
   * an exact no-op. A database from before those records is written whole,
   * as before.
   */
  deliveryMoves(id: string, delivery: TaskDelivery | null): boolean {
    if (!this.execution.exists() || !this.delivery.exists() || !this.specifications.exists())
      return true;
    const split = splitTurn(delivery);
    if (this.turnMoves(id, split.turn)) return true;
    const save = this.delivery.planDelivery(id, split.delivery);
    return (
      deliverySaveMoves(save) ||
      this.savedHistory(id) !== (save.history ? JSON.stringify(save.history) : null)
    );
  }

  /** Whether these declarations differ from the turn's saved ones, or the task has no execution row. */
  private turnMoves(id: string, turn: Record<string, unknown> | null): boolean {
    const saved = this.execution.turnJson(id);
    return saved === undefined || saved !== (turn ? JSON.stringify(turn) : null);
  }

  /** The history the delivery column keeps, exactly as saved; undefined with no history row. */
  private savedHistory(id: string): string | null | undefined {
    const row = prepared(
      this.db,
      "SELECT delivery_json FROM task_record_history WHERE task_id = ?",
    ).get(id) as { delivery_json: string | null } | undefined;
    return row ? row.delivery_json : undefined;
  }

  pendingPlacements(): TaskRecord[] {
    if (this.execution.exists()) return this.getMany(this.execution.pendingPlacementIds());
    return this.read(
      this.db
        .prepare(
          `SELECT * FROM ${this.readTable()} WHERE json_extract(placement_json, '$.reservation') = 'pending'`,
        )
        .all() as Row[],
    );
  }

  /** Existence does not compose specifications, delivery or execution records. */
  has(id: string): boolean {
    return prepared(this.db, "SELECT 1 FROM tasks WHERE id = ?").get(id) !== undefined;
  }

  get(id: string): TaskRecord | undefined {
    if (this.projection?.records.has(id)) return this.projection.records.get(id);
    const row = prepared(this.db, `SELECT * FROM ${this.readTable()} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    const record = row ? this.record(row) : undefined;
    this.projection?.records.set(id, record);
    return record;
  }

  /** Coverage needs only task-row facts, never shape, delivery or execution payloads. */
  coverageFields(id: string): TaskCoverageFields | undefined {
    if (this.projection?.records.has(id)) return this.projection.records.get(id);
    if (this.projection?.coverage.has(id)) return this.projection.coverage.get(id);
    const row = prepared(
      this.db,
      `SELECT id, key, title, status, closed_reason, created_at, started_at FROM tasks WHERE id = ?`,
    ).get(id) as
      | Pick<Row, "id" | "key" | "title" | "status" | "closed_reason" | "created_at" | "started_at">
      | undefined;
    const fields = row
      ? {
          id: row.id,
          key: row.key ?? "",
          title: row.title,
          status: row.status,
          closedReason: row.closed_reason,
          createdAt: row.created_at,
          startedAt: row.started_at,
        }
      : undefined;
    this.projection?.coverage.set(id, fields);
    return fields;
  }

  /** Direct child identities in the same order as listChildren, without their payloads. */
  childIds(parentId: string): string[] {
    const rows = prepared(this.db, "SELECT id, created_at, seq FROM tasks WHERE parent_id = ?").all(
      parentId,
    ) as Pick<Row, "id" | "created_at" | "seq">[];
    return rows
      .sort((a, b) => a.created_at - b.created_at || (a.seq ?? 0) - (b.seq ?? 0))
      .map((row) => row.id);
  }

  byKey(key: string): TaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${this.readTable()} WHERE key = ?`)
      .get(key.toUpperCase()) as Row | undefined;
    return row ? this.record(row) : undefined;
  }

  list(): TaskRecord[] {
    return oldestFirst(
      this.read(prepared(this.db, `SELECT * FROM ${this.readTable()}`).all() as Row[]),
    );
  }

  pendingQueueRemovals(): TaskRecord[] {
    return this.delivery.queueRemovalTaskIds().flatMap((id) => this.get(id) ?? []);
  }

  listByStatus(...statuses: TaskStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const key = JSON.stringify(statuses);
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const marks = statuses.map(() => "?").join(", ");
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE status IN (${marks})`,
    ).all(...statuses) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /**
   * The live set and every row closed at or after `since`, oldest first:
   * what the board shows, read without decoding the closed rows before it
   * (a long record is mostly those).
   */
  listLiveOrClosedSince(since: number): TaskRecord[] {
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE status IN ('open', 'active') OR closed_at >= ?`,
    ).all(since) as Row[];
    return oldestFirst(this.read(rows));
  }

  /** The pinned rows (INF-3127), whatever their state or age: the board lists every one. */
  listPinned(): TaskRecord[] {
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE pinned_at IS NOT NULL`,
    ).all() as Row[];
    return oldestFirst(this.read(rows));
  }

  /**
   * Each closed row's retention fields whose close falls in `[from, upTo]`
   * (either bound left out reaches the end), sought through
   * `tasks_closed_at` without composing a record: a close's pass reads
   * only the closes since the last pass, never the whole record (INF-3032).
   */
  listClosedRetentionFields(from: number | null, upTo: number | null): TaskRetentionFields[] {
    const bounds = [
      ...(from === null ? [] : [["t.closed_at >= ?", from] as const]),
      ...(upTo === null ? [] : [["t.closed_at <= ?", upTo] as const]),
    ];
    const where = bounds.map(([clause]) => clause).join(" AND ") || "t.closed_at IS NOT NULL";
    return this.retentionRows(where, ...bounds.map(([, value]) => value));
  }

  /** These tasks' retention fields, those that still exist, without composing a record. */
  retentionFields(ids: readonly string[]): TaskRetentionFields[] {
    if (ids.length === 0) return [];
    return this.retentionRows("t.id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
  }

  /**
   * The closed tasks on this computer whose working copy the record still
   * counts as present, sought through `tasks_workspace_present` without
   * composing a record or reading the rest of its history: a work
   * computer's contact asks at each roster read (INF-3040).
   */
  closedPresentOn(deviceId: string): string[] {
    const device = this.execution.exists()
      ? "(SELECT e.device_id FROM task_execution e WHERE e.task_id = t.id)"
      : "t.device_id";
    return prepared(
      this.db,
      `SELECT t.id FROM tasks t WHERE t.workspace_state = 'present'
         AND t.closed_at IS NOT NULL AND ${device} = ?`,
    )
      .pluck()
      .all(deviceId) as string[];
  }

  /**
   * The ids of every task live work builds on, the live tasks included,
   * through closed intermediates, in one statement that composes no record
   * (INF-3641): the live tasks, then from each held task the task it was
   * filed from (`discovered-from`), the tasks waiting on it or carrying it
   * on (`blocks`, `replaced-by`), its basis and the attempt it retries
   * (`retry-of`, read only on a task with a shape, as its record reads
   * them) and the attempts its `escalated` rows name. A reference names a
   * task by id or, failing that, by key, as `get` then `byKey` resolve it:
   * trimmed of what JavaScript's `trim` takes and upper-cased for the key.
   */
  heldByLiveWork(): Set<string> {
    const named = (ref: string) =>
      `(SELECT COALESCE(
         (SELECT n.id FROM tasks n WHERE n.id = name.ref),
         (SELECT n.id FROM tasks n WHERE n.key = upper(name.ref)))
       FROM (SELECT NULLIF(trim(${ref}, ${TRIMMED_SQL}), '') AS ref) name)`;
    // A record reads its references only when it has a shape: once the
    // shape lives in its own tables, when one of them holds a row.
    const shaped = this.specifications.exists()
      ? `(${SHAPE_RECORD_TABLES.map((table) => `EXISTS(SELECT 1 FROM ${table} s WHERE s.task_id = held.id)`).join(" OR ")})`
      : `(SELECT json_valid(s.shape_json) AND json_type(s.shape_json) = 'object'
           FROM tasks s WHERE s.id = held.id)`;
    const ids = prepared(
      this.db,
      `WITH RECURSIVE held(id) AS (
         SELECT id FROM tasks WHERE status IN ('open', 'active')
         UNION SELECT ${named("l.to_id")} FROM held JOIN task_links l
           ON l.from_id = held.id AND l.type = 'discovered-from'
         UNION SELECT ${named("l.from_id")} FROM held JOIN task_links l
           ON l.to_id = held.id AND l.type IN ('blocks', 'replaced-by')
         UNION SELECT ${named("r.ref")} FROM held JOIN task_references r
           ON r.task_id = held.id AND r.kind IN ('basis', 'retry-of') AND ${shaped}
         UNION SELECT ${named("e.ref")} FROM held JOIN task_events e
           ON e.task_id = held.id AND e.kind = 'escalated' AND e.ref <> ''
           AND CASE WHEN json_valid(e.data_json)
             THEN json_type(e.data_json, '$.escalated_from') END = 'text'
       )
       SELECT id FROM held WHERE id IS NOT NULL`,
    )
      .pluck()
      .all() as string[];
    return new Set(ids);
  }

  private retentionRows(where: string, ...params: unknown[]): TaskRetentionFields[] {
    // The computer lives on the execution row once that table exists.
    const device = this.execution.exists()
      ? "(SELECT e.device_id FROM task_execution e WHERE e.task_id = t.id)"
      : "t.device_id";
    const rows = prepared(
      this.db,
      `SELECT t.id, t.status, t.closed_at, ${device} AS device_id FROM tasks t WHERE ${where}`,
    ).all(...params) as Pick<Row, "id" | "status" | "closed_at" | "device_id">[];
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      closedAt: row.closed_at,
      deviceId: row.device_id ?? null,
    }));
  }

  /**
   * Every row holding a computer move, open or closed, oldest first, sought
   * through `task_placement_requests_computer_move` without reading the rows
   * that hold none: the ready sweep asks each minute, and a long record is
   * mostly closed rows (docs/testing.md, "The scale check").
   */
  listWithComputerMove(): TaskRecord[] {
    if (!this.shapes.exists()) return this.list().filter((record) => record.shape?.computer_move);
    const ids = prepared(
      this.db,
      "SELECT task_id FROM task_placement_requests WHERE json_type(value_json, '$.computer_move') = 'object'",
    )
      .pluck()
      .all() as string[];
    return this.getMany(ids);
  }

  /** Recorded overrides on this computer, without composing task records or their history.
   * Closed tasks remain eligible: their declared process groups can still be alive.
   * CROSS JOIN keeps the sparse override index first, not a walk of execution history.
   */
  passingOverridesForComputer(computerId: string, kind: OverridableHold): string[] {
    const rows = prepared(
      this.db,
      `SELECT p.task_id, p.override_json, d.head_sha
       FROM task_permissions p
       CROSS JOIN task_execution e ON e.task_id = p.task_id
       LEFT JOIN task_delivery_evidence d ON d.task_id = p.task_id
       WHERE p.override_json IS NOT NULL AND e.device_id = ?`,
    ).all(computerId) as { task_id: string; override_json: string; head_sha: string | null }[];
    return rows
      .filter((row) =>
        overridePasses(
          { override: parseJson<HoldOverride>(row.override_json) ?? undefined },
          kind,
          row.head_sha ?? undefined,
        ),
      )
      .map((row) => row.task_id);
  }

  /**
   * How many active rows each computer that runs work holds, by its device
   * id, read from `task_execution` without composing a record: Settings ->
   * Devices counts them again after every task write (`Computers.list`).
   * CROSS JOIN keeps the status index first, never a walk of execution rows.
   */
  countActiveByDevice(): Map<string, number> {
    const devices = this.execution.exists()
      ? (prepared(
          this.db,
          `SELECT x.device_id FROM tasks t CROSS JOIN task_execution x ON x.task_id = t.id
           WHERE t.status = 'active' AND x.device_id IS NOT NULL`,
        )
          .pluck()
          .all() as string[])
      : this.listByStatus("active").flatMap((record) => record.deviceId ?? []);
    const counts = new Map<string, number>();
    for (const device of devices) counts.set(device, (counts.get(device) ?? 0) + 1);
    return counts;
  }

  /** Whether any row holds this status, answered without reading or composing one. */
  hasStatus(status: TaskStatus): boolean {
    return (
      prepared(this.db, "SELECT 1 FROM tasks WHERE status = ? LIMIT 1").get(status) !== undefined
    );
  }

  /** Whether any row is of this kind, answered without reading or composing one. */
  hasKind(kind: TaskKind): boolean {
    return prepared(this.db, "SELECT 1 FROM tasks WHERE kind = ? LIMIT 1").get(kind) !== undefined;
  }

  /**
   * Whether a row closed done that is not an `operation`, a `question`
   * counting only when a message of the captain's is attached to it,
   * answered without reading or composing one (`TaskService.hasFinishedTask`).
   */
  hasFinishedTask(): boolean {
    return (
      prepared(
        this.db,
        `SELECT 1 FROM tasks t
         WHERE t.status = 'done' AND t.kind <> 'operation'
           AND (t.kind <> 'question'
             OR EXISTS (SELECT 1 FROM captain_asks a WHERE a.task_id = t.id))
         LIMIT 1`,
      ).get() !== undefined
    );
  }

  /**
   * How many `work` rows a crewmate started closed done, counted up to
   * `upTo` without reading them (`TaskService.finishedCrewmates`).
   */
  countFinishedCrewmates(upTo: number): number {
    const row = prepared(
      this.db,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM tasks
         WHERE kind = 'work' AND status = 'done' AND started_at IS NOT NULL
         LIMIT ?
       )`,
    ).get(upTo) as { n: number };
    return row.n;
  }

  /** How many rows of this kind hold this status, counted without reading them. */
  count(status: TaskStatus, kind: TaskKind): number {
    const row = prepared(
      this.db,
      "SELECT COUNT(*) AS n FROM tasks WHERE status = ? AND kind = ?",
    ).get(status, kind) as { n: number };
    return row.n;
  }

  /** These rows, oldest first; an unknown id reads as nothing. */
  getMany(ids: readonly string[]): TaskRecord[] {
    if (ids.length === 0) return [];
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as Row[];
    return oldestFirst(this.read(rows));
  }

  /** Only active rows among these ids; graph readers keep their own edge order. */
  getActiveMany(ids: readonly string[]): TaskRecord[] {
    if (ids.length === 0) return [];
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active'`,
    ).all(JSON.stringify(ids)) as Row[];
    return this.read(rows);
  }

  /**
   * The rows among these ids whose status is one of these, unordered; a row in
   * any other status is never composed (INF-2342). Inside a projection a row it
   * already holds answers by that row's status, as `get` would.
   */
  getAmong(ids: readonly string[], statuses: readonly TaskStatus[]): TaskRecord[] {
    const known = this.projection?.records;
    const held = known ? ids.filter((id) => known.has(id)) : [];
    const unread = known ? ids.filter((id) => !known.has(id)) : ids;
    const found = held.flatMap((id) => {
      const record = known?.get(id);
      return record && statuses.includes(record.status) ? [record] : [];
    });
    if (unread.length === 0 || statuses.length === 0) return found;
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE id IN (SELECT value FROM json_each(?)) AND status IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(unread), JSON.stringify(statuses)) as Row[];
    return [...found, ...this.read(rows)];
  }

  /** How many children each of these parents has, and how many of them closed. */
  childCounts(parentIds: readonly string[]): Map<string, { total: number; closed: number }> {
    const counts = new Map<string, { total: number; closed: number }>();
    if (parentIds.length === 0) return counts;
    const rows = prepared(
      this.db,
      `SELECT parent_id, COUNT(*) AS total,
              SUM(status NOT IN ('open', 'active')) AS closed
       FROM tasks WHERE parent_id IN (SELECT value FROM json_each(?))
       GROUP BY parent_id`,
    ).all(JSON.stringify(parentIds)) as { parent_id: string; total: number; closed: number }[];
    for (const row of rows) counts.set(row.parent_id, { total: row.total, closed: row.closed });
    return counts;
  }

  /** Earliest child creation or start after a request, without composing child records. */
  firstChildActivityAfter(parentId: string, since: number): number | undefined {
    const row = prepared(
      this.db,
      `SELECT MIN(at) AS at FROM (
        SELECT created_at AS at FROM ${this.readTable()} WHERE parent_id = ? AND created_at > ?
        UNION ALL
        SELECT started_at AS at FROM ${this.readTable()} WHERE parent_id = ? AND started_at > ?
      )`,
    ).get(parentId, since, parentId, since) as { at: number | null };
    return row.at ?? undefined;
  }

  /**
   * Tasks closed with a container close's reason (finished or cancelled) that
   * have a live child, for the container repair (INF-3846): it seeks the
   * live rows by status, so it grows with open work, never with the closed
   * history, and leaves out merged and answered parents.
   */
  closedParentsWithLiveChildren(): string[] {
    const rows = prepared(
      this.db,
      `SELECT DISTINCT parent.id AS id FROM tasks AS child
       JOIN tasks AS parent ON parent.id = child.parent_id
       WHERE child.status IN ('open', 'active') AND parent.status IN ('done', 'dropped')
         AND parent.closed_reason IN ('finished', 'cancelled')
       ORDER BY parent.id`,
    ).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  /**
   * The earliest start among a parent's merged or finished building parts -
   * work parts that started, not delivering an answer and not raised by the host
   * - for the next-move check (INF-3846 piece 2). One seek on the parent's
   * done rows, never composing them, so a pass grows with live work only.
   */
  earliestDonePartStart(parentId: string): number | undefined {
    const row = prepared(
      this.db,
      `SELECT MIN(started_at) AS at FROM ${this.readTable()}
       WHERE parent_id = ? AND status = 'done' AND kind = 'work' AND started_at IS NOT NULL
         AND COALESCE(json_extract(shape_json, '$.deliverable'), '') != 'answer'
         AND COALESCE(json_extract(shape_json, '$.kind_source'), '') NOT LIKE 'host:%'`,
    ).get(parentId) as { at: number | null };
    return row.at ?? undefined;
  }

  /** When the last work this task waits on through a `blocks` link closed, without composing it. */
  latestBlockerClose(id: string): number | undefined {
    const row = prepared(
      this.db,
      `SELECT MAX(blocker.closed_at) AS at FROM task_links AS link
       JOIN tasks AS blocker ON blocker.id = link.from_id
       WHERE link.to_id = ? AND link.type = 'blocks'`,
    ).get(id) as { at: number | null };
    return row.at ?? undefined;
  }

  /** Live children for review witnesses; closed children's payloads are not read. */
  listLiveChildren(parentId: string): TaskRecord[] {
    const key = `live-children:${parentId}`;
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const rows = prepared(
      this.db,
      `SELECT * FROM ${this.readTable()} WHERE parent_id = ? AND status IN ('open', 'active')`,
    ).all(parentId) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /** A parent's direct children, oldest first. */
  listChildren(parentId: string): TaskRecord[] {
    const key = `children:${parentId}`;
    const known = this.projection?.lists.get(key);
    if (known) return known;
    const rows = prepared(this.db, `SELECT * FROM ${this.readTable()} WHERE parent_id = ?`).all(
      parentId,
    ) as Row[];
    const records = oldestFirst(this.read(rows));
    this.projection?.lists.set(key, records);
    return records;
  }

  /**
   * Every descendant, deepest last (a recursive walk down parent_id). The
   * CROSS JOIN keeps SQLite reading the tree first and seeking each record,
   * where it would otherwise walk every task to match the tree.
   */
  listDescendants(id: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 1 FROM tasks WHERE parent_id = ?
           UNION ALL
           SELECT t.id, tree.depth + 1 FROM tasks t JOIN tree ON t.parent_id = tree.id
           WHERE tree.depth < 64
         )
         SELECT records.* FROM tree CROSS JOIN ${this.readTable()} records ON records.id = tree.id
         ORDER BY tree.depth, records.created_at, records.seq`,
      )
      .all(id) as Row[];
    return this.read(rows);
  }

  /**
   * The ready query (task-system design section 7): open work, unheld,
   * dispatch-on-ready, with no `blocks` edge from a task that has not
   * closed successfully (done clears; open, active and dropped do not).
   * Priority first, then age.
   */
  listReady(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM ${this.readTable()} t
         WHERE t.status = 'open' AND t.kind = 'work'
           AND t.gate_kind IS NULL AND t.start_policy = 'when-ready'
           AND NOT EXISTS (
             SELECT 1 FROM task_links l JOIN tasks b ON b.id = l.from_id
             WHERE l.to_id = t.id AND l.type = 'blocks'
               AND b.status <> 'done')
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return this.read(rows);
  }

  /**
   * Open, unheld work whose wait can never end: a `blocks` edge from a
   * dropped task. The ready sweep turns each into one decision card.
   */
  listDeadBlocked(): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM ${this.readTable()} t
         JOIN task_links l ON l.to_id = t.id AND l.type = 'blocks'
         JOIN tasks b ON b.id = l.from_id
         WHERE t.status = 'open' AND t.kind = 'work' AND t.gate_kind IS NULL
           AND b.status = 'dropped'
         ORDER BY t.priority, t.created_at, t.seq`,
      )
      .all() as Row[];
    return this.read(rows);
  }

  /** Rows missing the record invariants TaskService enforces (boot check). */
  countMissingInvariants(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE key IS NULL OR project_id IS NULL OR updated_at IS NULL",
      )
      .get() as { n: number };
    return row.n;
  }

  /** The board sequence of the last committed mutation (0 on a fresh database). */
  boardSeq(): number {
    const row = this.db.prepare("SELECT seq FROM task_board WHERE id = 1").get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  /** Move the board sequence on by one inside the committing write, and read it. */
  bumpBoardSeq(): number {
    const row = this.db
      .prepare("UPDATE task_board SET seq = seq + 1 WHERE id = 1 RETURNING seq")
      .get() as { seq: number } | undefined;
    if (!row) throw new Error("task_board row missing; migration 20 did not run.");
    return row.seq;
  }

  /** Hard delete: a spawn that never ran, or the D-13 purge. */
  delete(id: string): void {
    this.changes.deleteFor(id);
    this.delivery.deleteFor(id);
    this.execution.deleteFor(id);
    this.policies.deleteFor(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  deleteAll(): number {
    this.changes.deleteAll();
    this.delivery.deleteAll();
    this.execution.deleteAll();
    this.policies.deleteAll();
    return this.db.prepare("DELETE FROM tasks").run().changes;
  }
}
