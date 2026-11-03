/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/storage/
 * @journey-area src/core/storage/savedDataCompatibility.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { CUSTOM_API_PROVIDER_PREFIX } from "@shared/customApi";
import { hostEnv } from "../../src/core/hostEnv";
import { mcpIntegration } from "../../src/core/integrations/providers/mcp/mcpIntegration";
import {
  openDatabase,
  TASK_DELIVERY_RECORDS_VERSION,
  TASK_EXECUTION_VERSION,
  TASK_POLICIES_VERSION,
  TASK_RECORD_RETIREMENT_VERSION,
  TASK_REFERENCES_VERSION,
} from "../../src/core/storage/db";
import { savedDeliveryReader } from "../../src/core/storage/taskDeliveryFields";
import { policyShapeFields, type TaskPolicyRow } from "../../src/core/storage/taskPolicyFields";
import { REFERENCE_SHAPE_FIELDS } from "../../src/core/storage/taskReferenceStore";
import { dropViews } from "../../src/core/storage/views";
import { atUtilityQos } from "../../src/core/utilityQos";
import { INTEGRATION_KIND_NAMES } from "../../src/shared/integrations";
import { deliveryForRecord, type RepoDelivery } from "../../src/shared/repos";
import { taskRecordRetirementReverseSql } from "../helpers/taskRecordRetirement";

/**
 * A profile as an older release saved it (docs/saved-data-compatibility.md,
 * "Profiles saved by an older release"). A journey sets a profile up on this
 * build and quits; `asSavedByOlderRelease` rewrites what it saved into what the
 * release before each format change listed here wrote, and the next launch on
 * the same userData is the upgrade a person makes. A change that makes
 * something an earlier release saved read differently lists the earlier form
 * here, so every journey that opens an older profile meets it.
 */

/**
 * The check profile each release saved with a custom model's check, oldest
 * first (`customApiProfile`, src/core/pi/customApiProtocol.ts): 0.1.25 saved
 * text-tools-v1 for both protocols, 0.1.31 text-tools-usage-v2 for Chat, and
 * 0.2.0 text-tools-usage-v3 and text-tools-v2. A profile this build saves that
 * is not listed yet is newer than every listed one, so the last listed is the
 * previous release's.
 */
export const CUSTOM_CHECK_PROFILES = {
  "openai-completions": [
    "text-tools-v1",
    "text-tools-usage-v2",
    "text-tools-usage-v3",
    "pi-capabilities-v4",
  ],
  "openai-responses": ["text-tools-v1", "text-tools-v2", "pi-capabilities-v3"],
} as const;
type CustomProtocol = keyof typeof CUSTOM_CHECK_PROFILES;

/** The check profile the release before saved, for one this build saved. */
export function olderCheckProfile(protocol: CustomProtocol, profile: string): string {
  const profiles: readonly string[] = CUSTOM_CHECK_PROFILES[protocol];
  const at = profiles.indexOf(profile);
  const older = at < 0 ? profiles.at(-1) : profiles[at - 1];
  if (!older) throw new Error(`No release saved a ${protocol} check older than ${profile}`);
  return older;
}

export type OlderProfile = {
  /** Each custom model check rewritten: its connection, its model, and the profile before and after. */
  customChecks: { accountId: string; model: string; from: string; to: string }[];
  /** Each task given the copy of its latest result an older release kept on its delivery facts. */
  resultCopies: { taskId: string; at: number }[];
  /** Each card choice event whose card evidence alias was taken out. */
  decisions: number[];
  /** Each task reference written back into the work shape field it was saved in. */
  references: { taskId: string; field: string; ref: string }[];
  /** Each task whose policy inputs went back into its work shape. */
  policies: string[];
  /** Each task whose running work went back onto its task row, with the turn keys put back on its delivery. */
  execution: { taskId: string; turn: string[] }[];
  /** Each task whose change evidence and permissions went back into its delivery column, by record. */
  delivery: { taskId: string; evidence: boolean; permissions: boolean }[];
};

/**
 * Rewrites a profile this build saved into the older release's form. Call it
 * while the app is stopped, between two launches on the same userData; what it
 * returns says what it rewrote, so a journey can tell it was not a no-op.
 */
export function asSavedByOlderRelease(userDataDir: string): OlderProfile {
  // Each format change is undone newest first, every one opening the
  // database only as far as its own migration, so none runs again.
  if (existsSync(join(userDataDir, "firstmate.db"))) {
    const db = openDatabase(userDataDir);
    try {
      dropViews(db);
      db.exec(taskRecordRetirementReverseSql());
    } finally {
      db.close();
    }
  }
  const history = olderTaskHistory(userDataDir);
  const delivery = olderTaskDelivery(userDataDir);
  const policies = olderTaskPolicies(userDataDir);
  const execution = olderTaskExecution(userDataDir);
  return {
    customChecks: olderCustomChecks(userDataDir),
    ...history,
    references: olderTaskReferences(userDataDir),
    policies,
    execution,
    delivery,
  };
}

/**
 * Each task's delivery facts as a release before INF-1296 piece 4 saved
 * them: its change evidence and its permissions and effects in the
 * delivery column beside the history, and a settle that has not run in its
 * own column on the task row, with no tables of their own.
 */
function olderTaskDelivery(userDataDir: string): OlderProfile["delivery"] {
  if (!existsSync(join(userDataDir, "firstmate.db"))) return [];
  const db = openDatabase(userDataDir, TASK_DELIVERY_RECORDS_VERSION);
  try {
    const rows = db
      .prepare(
        `SELECT t.id AS taskId, t.delivery_json AS delivery,
           EXISTS (SELECT 1 FROM task_delivery_evidence x WHERE x.task_id = t.id) AS evidence,
           EXISTS (SELECT 1 FROM task_permissions p WHERE p.task_id = t.id) AS permissions,
           (SELECT p.pending_settle_json FROM task_permissions p WHERE p.task_id = t.id) AS pending
         FROM tasks t ORDER BY t.id`,
      )
      .all() as {
      taskId: string;
      delivery: string | null;
      evidence: number;
      permissions: number;
      pending: string | null;
    }[];
    const composed = savedDeliveryReader(db);
    const write = db.prepare(
      "UPDATE tasks SET delivery_json = ?, pending_settle_json = COALESCE(?, pending_settle_json) WHERE id = ?",
    );
    const moved = rows.filter((row) => row.evidence || row.permissions);
    db.transaction(() => {
      for (const row of moved)
        write.run(composed(row.taskId, row.delivery), row.pending, row.taskId);
      dropViews(db);
      db.exec("DROP TABLE task_permissions; DROP TABLE task_delivery_evidence;");
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(
        TASK_DELIVERY_RECORDS_VERSION,
      );
    })();
    return moved.map((row) => ({
      taskId: row.taskId,
      evidence: Boolean(row.evidence),
      permissions: Boolean(row.permissions),
    }));
  } finally {
    db.close();
  }
}

/**
 * Each task's policy inputs as a release before INF-1296 piece 3 saved
 * them: the delivery, merging and care asked at filing and the live edits
 * since in its work shape (`delivery_ask`, `autonomy_ask`, `rigor_ask`,
 * `policies`), with no table of their own.
 */
function olderTaskPolicies(userDataDir: string): OlderProfile["policies"] {
  if (!existsSync(join(userDataDir, "firstmate.db"))) return [];
  const db = openDatabase(userDataDir, TASK_POLICIES_VERSION);
  try {
    const rows = db
      .prepare("SELECT * FROM task_policies ORDER BY task_id")
      .all() as TaskPolicyRow[];
    const write = db.prepare("UPDATE tasks SET shape_json = ? WHERE id = ?");
    const shapeOf = db.prepare("SELECT shape_json FROM tasks WHERE id = ?");
    db.transaction(() => {
      for (const row of rows) {
        const saved = (shapeOf.get(row.task_id) as { shape_json: string | null }).shape_json;
        const shape = { ...(saved ? JSON.parse(saved) : {}), ...policyShapeFields(row) };
        write.run(JSON.stringify(shape), row.task_id);
      }
      dropViews(db);
      db.exec("DROP TABLE task_policies");
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(TASK_POLICIES_VERSION);
    })();
    return rows.map((row) => row.task_id);
  } finally {
    db.close();
  }
}

/**
 * Each task's running work as a release before INF-1296 piece 3 saved it:
 * the resume token, computer, account, placement, idle clock, recovery
 * rung and start notice on the task row, and the current turn's
 * declarations on its delivery facts. That release named no conversation
 * for the token, so the next launch's migration names the one recorded.
 */
function olderTaskExecution(userDataDir: string): OlderProfile["execution"] {
  if (!existsSync(join(userDataDir, "firstmate.db"))) return [];
  const db = openDatabase(userDataDir, TASK_EXECUTION_VERSION);
  try {
    const rows = db
      .prepare("SELECT task_id AS taskId, turn_json AS turn FROM task_execution ORDER BY task_id")
      .all() as { taskId: string; turn: string | null }[];
    db.transaction(() => {
      dropViews(db);
      db.exec(`
        UPDATE tasks SET session_file = x.session_file, device_id = x.device_id,
          account_id = x.account_id, placement_json = x.placement_json, idle_since = x.idle_since,
          recovery_rung = x.recovery_rung, recovery_count = x.recovery_count,
          recovery_at = x.recovery_at, start_notice = x.start_notice,
          delivery_json = CASE WHEN x.turn_json IS NULL THEN tasks.delivery_json
            ELSE json_patch(COALESCE(tasks.delivery_json, '{}'), x.turn_json) END
          FROM task_execution x WHERE x.task_id = tasks.id;
        DROP TABLE task_execution;
        CREATE INDEX tasks_pending_placement ON tasks(id)
          WHERE json_extract(placement_json, '$.reservation') = 'pending';
      `);
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(TASK_EXECUTION_VERSION);
    })();
    return rows.map((row) => ({
      taskId: row.taskId,
      turn: row.turn ? Object.keys(JSON.parse(row.turn)) : [],
    }));
  } finally {
    db.close();
  }
}

/**
 * Each task's references as a release before INF-1296 piece 2 saved them:
 * the name of its basis, the task it branches from and the attempt it
 * retries in its work shape (`basis`, `branch_from`, `escalate_from`), with
 * no table of their own. Its database had not run the migration that moved
 * them, so the next launch runs it.
 */
function olderTaskReferences(userDataDir: string): OlderProfile["references"] {
  if (!existsSync(join(userDataDir, "firstmate.db"))) return [];
  const db = openDatabase(userDataDir, TASK_REFERENCES_VERSION);
  try {
    const rows = db
      .prepare("SELECT task_id AS taskId, kind, ref FROM task_references ORDER BY task_id, kind")
      .all() as { taskId: string; kind: keyof typeof REFERENCE_SHAPE_FIELDS; ref: string }[];
    const write = db.prepare(
      "UPDATE tasks SET shape_json = json_set(COALESCE(shape_json, '{}'), ?, ?) WHERE id = ?",
    );
    db.transaction(() => {
      for (const row of rows)
        write.run(`$.${REFERENCE_SHAPE_FIELDS[row.kind]}`, row.ref, row.taskId);
      dropViews(db);
      db.exec("DROP TABLE task_references");
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(TASK_REFERENCES_VERSION);
    })();
    return rows.map((row) => ({
      taskId: row.taskId,
      field: REFERENCE_SHAPE_FIELDS[row.kind],
      ref: row.ref,
    }));
  } finally {
    db.close();
  }
}

/**
 * Each task's history as a release before INF-1296 piece 1 saved it. That
 * release also kept the newest report's result on the task's delivery
 * facts (`delivery.result`, `{ at, value }` with the report's own time),
 * and its card choice events named no card evidence (`observation`).
 */
function olderTaskHistory(userDataDir: string): Pick<OlderProfile, "resultCopies" | "decisions"> {
  if (!existsSync(join(userDataDir, "firstmate.db"))) return { resultCopies: [], decisions: [] };
  const db = openDatabase(userDataDir, TASK_RECORD_RETIREMENT_VERSION - 1);
  try {
    const resultCopies = db
      .prepare(
        `SELECT e.task_id AS taskId, e.at, json_extract(e.data_json, '$.result') AS value,
           t.delivery_json AS delivery, t.shape_json AS shape, r.delivery AS repoDelivery
         FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN repos r ON r.id = t.repo_id
         WHERE e.kind = 'report' AND json_valid(e.data_json)
           AND json_type(e.data_json, '$.result') = 'object'
           AND e.id = (SELECT id FROM task_events WHERE task_id = e.task_id AND kind = 'report'
             AND json_valid(data_json) AND json_type(data_json, '$.result') = 'object'
             ORDER BY at DESC, id DESC LIMIT 1)`,
      )
      .all() as {
      taskId: string;
      at: number;
      value: string;
      delivery: string | null;
      shape: string | null;
      repoDelivery: RepoDelivery | null;
    }[];
    const copy = db.prepare("UPDATE tasks SET delivery_json = ? WHERE id = ?");
    for (const row of resultCopies) {
      // That release's writer kept the delivery mode it found, or the task's posture.
      const delivery = row.delivery ? JSON.parse(row.delivery) : {};
      const mode =
        delivery.mode ??
        deliveryForRecord(
          { shape: row.shape ? JSON.parse(row.shape) : null },
          row.repoDelivery ?? undefined,
        );
      const result = { at: row.at, value: JSON.parse(row.value) };
      copy.run(JSON.stringify({ ...delivery, mode, result }), row.taskId);
    }
    const decisions = (
      db
        .prepare(
          `SELECT id FROM task_events WHERE kind = 'card_resolved' AND json_valid(data_json)
           AND json_type(data_json, '$.observation') IS NOT NULL`,
        )
        .all() as { id: number }[]
    ).map((row) => row.id);
    const unalias = db.prepare(
      "UPDATE task_events SET data_json = json_remove(data_json, '$.observation') WHERE id = ?",
    );
    for (const id of decisions) unalias.run(id);
    return { resultCopies: resultCopies.map(({ taskId, at }) => ({ taskId, at })), decisions };
  } finally {
    db.close();
  }
}

/**
 * Each custom connection's saved checks, under the check profile the release
 * before saved. The fingerprint keeps this build's value: the profile alone
 * marks a check as an older release's.
 */
function olderCustomChecks(userDataDir: string): OlderProfile["customChecks"] {
  const rewritten: OlderProfile["customChecks"] = [];
  const accounts = join(userDataDir, "accounts");
  if (!existsSync(accounts)) return rewritten;
  for (const provider of readdirSync(accounts)) {
    if (!provider.startsWith(CUSTOM_API_PROVIDER_PREFIX)) continue;
    for (const accountId of readdirSync(join(accounts, provider))) {
      const file = join(accounts, provider, accountId, "custom-auth.json");
      if (!existsSync(file)) continue;
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        input: { protocol: CustomProtocol };
        proofs: Record<string, { profile: string }>;
      };
      for (const [model, proof] of Object.entries(saved.proofs)) {
        const to = olderCheckProfile(saved.input.protocol, proof.profile);
        rewritten.push({ accountId, model, from: proof.profile, to });
        proof.profile = to;
      }
      writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    }
  }
  return rewritten;
}

/** The fields this pre-migration-73 saved-card fixture owns, not today's writer's schema. */
type LegacyCard = Pick<
  Card,
  "id" | "title" | "author" | "meta" | "createdAt" | "priority" | "status" | "body" | "actions"
>;

/** A card saved before migration 73, while the app is stopped. */
export function saveKeepOpenCard(userDataDir: string, card: LegacyCard): void {
  const db = openDatabase(userDataDir, 72);
  try {
    // Seed the saved legacy format directly: today's CardStore requires later columns.
    db.prepare(
      `INSERT INTO cards (id, kind, author, priority, title, meta, body, actions_json, status, created_at)
       VALUES (?, 'card', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.id,
      card.author,
      card.priority,
      card.title,
      card.meta,
      card.body,
      JSON.stringify(card.actions),
      card.status,
      card.createdAt,
    );
  } finally {
    db.close();
  }
}

/** INF-882's existing installation: keep the real server's discovery, under its old allowed name. */
export async function seedLegacyGithubServer(userData: string, runs: string): Promise<void> {
  const server = mcpIntegration({
    root: join(userData, "integrations"),
    env: () => hostEnv(),
    belowUi: (file, args) => atUtilityQos(file, args),
    cwd: () => userData,
    version: "0.0.0-test",
    changed: () => {},
  });
  try {
    if (!server.add) throw new Error("MCP servers must support adding a connection");
    await server.add({ name: INTEGRATION_KIND_NAMES.github, runs });
  } finally {
    await server.close?.();
  }
}
