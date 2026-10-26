import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { CUSTOM_API_PROVIDER_PREFIX } from "@shared/customApi";
import { hostEnv } from "../../src/core/hostEnv";
import { mcpIntegration } from "../../src/core/integrations/providers/mcp/mcpIntegration";
import { openDatabase, TASK_REFERENCES_VERSION } from "../../src/core/storage/db";
import { REFERENCE_SHAPE_FIELDS } from "../../src/core/storage/taskReferenceStore";
import { dropViews } from "../../src/core/storage/views";
import { atUtilityQos } from "../../src/core/utilityQos";
import { INTEGRATION_KIND_NAMES } from "../../src/shared/integrations";
import { deliveryForRecord, type RepoDelivery } from "../../src/shared/repos";

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
};

/**
 * Rewrites a profile this build saved into the older release's form. Call it
 * while the app is stopped, between two launches on the same userData; what it
 * returns says what it rewrote, so a journey can tell it was not a no-op.
 */
export function asSavedByOlderRelease(userDataDir: string): OlderProfile {
  return {
    customChecks: olderCustomChecks(userDataDir),
    ...olderTaskHistory(userDataDir),
    references: olderTaskReferences(userDataDir),
  };
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
  const db = openDatabase(userDataDir);
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
  const db = openDatabase(userDataDir);
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
